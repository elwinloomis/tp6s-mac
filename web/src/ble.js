/* ============================================================
   ble.js — TP6-S BLE transport.

   Depends on protocol.js (TP6.proto) and navigator.bluetooth. Deliberately
   has no idea the DOM exists: no document.getElementById, no direct UI
   writes. Everything the UI needs to know — connection state, incoming
   notifications, log lines, adaptive chunk-size changes — comes out
   through the on(event, handler) subscription API instead. The old app.js
   reached into the DOM from inside the transport code; keeping that split
   is the entire point of this file.

   Classic script (not a module): the tool is opened from file:// where ES
   module imports are blocked by the browser.
   ============================================================ */

(function () {
  'use strict';

  window.TP6 = window.TP6 || {};

  // Web Bluetooth never exposes the negotiated MTU, so this is a guess, not
  // a measurement. 20 B is the always-safe ATT-23 floor but needs ~87
  // writes for a 24-line frame — slow, and every extra write is another
  // chance for the OS to drop one (Chrome's writeValueWithoutResponse has
  // no backpressure), which desyncs CUS frame reassembly on the printer
  // side. bleak reports MTU 247 for this printer on the Python side, so
  // 244 is the CLI-proven starting value; write() adaptively halves it on
  // GATT error, and the UI can also set it directly via setChunkSize().
  const DEFAULT_CHUNK_SZ = 244;
  const CHUNK_FLOOR = 20;
  // Applied between chunks only when streaming is disabled. writeValueWith-
  // outResponse gives no backpressure, so the legacy sender paced by hand.
  const INTER_CHUNK_MS = 4;
  // Every Nth chunk goes out as writeValueWithResponse instead. That single
  // acknowledged write drains the queue and provides real backpressure, at a
  // fraction of the cost of acknowledging every packet. Measured on a TP6-S
  // (CLI side): 6.6 -> 11 KB/s delivered against ~6 KB/s consumed, which is
  // what keeps the printer's buffer from running dry — and a buffer that never
  // empties is a motor that never stops. See INVESTIGATION.md.
  const BARRIER_EVERY = 8;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function charPropsList(props) {
    const out = [];
    if (props.broadcast) out.push('broadcast');
    if (props.read) out.push('read');
    if (props.writeWithoutResponse) out.push('write-without-response');
    if (props.write) out.push('write');
    if (props.notify) out.push('notify');
    if (props.indicate) out.push('indicate');
    return out;
  }

  // Replaces asyncio.Queue + wait_for from the Python original. Two read
  // modes: get(ms) is the awaitable, timeout-on-empty form used by
  // stop-and-wait; getNow() is the synchronous, never-blocks form window
  // mode uses to drain whatever has already arrived without awaiting.
  class AckQueue {
    constructor() {
      this._buf = [];
      this._waiters = [];
    }

    push(data) {
      if (this._waiters.length) this._waiters.shift()(data);
      else this._buf.push(data);
    }

    get(ms) {
      return new Promise((resolve, reject) => {
        if (this._buf.length) {
          resolve(this._buf.shift());
          return;
        }
        const id = setTimeout(() => {
          const i = this._waiters.indexOf(fn);
          if (i >= 0) this._waiters.splice(i, 1);
          reject(new Error('timeout'));
        }, ms);
        const fn = (v) => {
          clearTimeout(id);
          resolve(v);
        };
        this._waiters.push(fn);
      });
    }

    // Non-blocking retrieval (window mode) — null if nothing pending.
    getNow() {
      return this._buf.length ? this._buf.shift() : null;
    }

    clear() {
      this._buf = [];
      this._waiters = [];
    }
  }

  class TP6Ble {
    constructor() {
      this._device = null;
      this._gattServer = null;
      this._gattWrite = null;
      this._gattNotify = null;
      this._connected = false;
      this._printing = false;
      // Set while we are the ones tearing the link down, so the reconnect
      // handler can tell a deliberate disconnect from a dropped one. Only
      // ever armed when a disconnection event is genuinely on its way —
      // see disconnect() for why a stale one is so destructive.
      this._leaving = false;
      // Exactly one 'gattserverdisconnected' listener, kept here so a second
      // Connect can remove the first instead of stacking another.
      this._onDisc = null;
      // Bumped whenever the link is deliberately re-established or torn down;
      // a reconnect attempt carrying an older number knows it is obsolete.
      this._link = 0;
      this._reconnectTimer = null;
      this._chunkSize = DEFAULT_CHUNK_SZ;
      // Live-tunable pacing. Chrome's writeValueWithoutResponse resolves
      // immediately and gives NO backpressure, so one of these must do the
      // pacing: barrierEvery uses a periodic acknowledged write (accurate but
      // slow in Chrome), pacingMs paces by wall clock (cheap but open-loop).
      this.barrierEvery = 0;
      this.pacingMs = 0;
      this.acks = new AckQueue();
      this._listeners = new Map();
    }

    // ---- state -------------------------------------------------------

    available() {
      return typeof navigator !== 'undefined' && !!navigator.bluetooth;
    }

    isConnected() {
      return this._connected;
    }

    // The truth from the radio rather than from our own bookkeeping: Chrome
    // flips gatt.connected the instant the link is gone, whether or not our
    // disconnection handler drew the right conclusion from it.
    linkLive() {
      return !!(this._device && this._device.gatt && this._device.gatt.connected && this._gattWrite);
    }

    // Reconcile the flag with the radio, emitting 'state' if they disagreed.
    // Call this before doing anything that needs a live link: it turns "the
    // button does nothing" into "the link is down", which is a fact the user
    // can act on.
    syncState() {
      const live = this.linkLive();
      if (live !== this._connected) {
        this._connected = live;
        this._emit('state', { connected: live, name: live ? this.deviceName() : null });
      }
      return live;
    }

    isPrinting() {
      return this._printing;
    }

    deviceName() {
      return this._device ? this._device.name || this._device.id || null : null;
    }

    get chunkSize() {
      return this._chunkSize;
    }

    setChunkSize(n) {
      const v = Math.max(CHUNK_FLOOR, n | 0);
      this._chunkSize = v;
      this._emit('chunk', v);
    }

    // ---- events --------------------------------------------------------
    // 'state'  ({connected, name})
    // 'notify' (Uint8Array raw)
    // 'log'    ({message, level})   level: 'info' | 'warn' | 'error'
    // 'chunk'  (newChunkSize)

    on(event, handler) {
      if (!this._listeners.has(event)) this._listeners.set(event, new Set());
      this._listeners.get(event).add(handler);
      return () => {
        const set = this._listeners.get(event);
        if (set) set.delete(handler);
      };
    }

    _emit(event, payload) {
      const set = this._listeners.get(event);
      if (!set) return;
      for (const fn of set) {
        try {
          fn(payload);
        } catch (err) {
          // A broken UI handler must never take down the transport loop.
          console.error(`TP6.ble: listener for "${event}" threw`, err);
        }
      }
    }

    _log(message, level) {
      this._emit('log', { message, level: level || 'info' });
    }

    // ---- connection ----------------------------------------------------

    // Filters by name prefix, not service UUID: the real printer advertises
    // as plain "TP6", not "TP6-S".
    async connect() {
      if (!this.available()) {
        this._log('Web Bluetooth is not available in this browser.', 'error');
        return;
      }
      try {
        const device = await navigator.bluetooth.requestDevice({
          filters: [{ namePrefix: 'TP6' }],
          optionalServices: [0xfff0, 0xff00],
        });
        // Chrome hands back the SAME BluetoothDevice object for a printer this
        // origin has already seen, so connecting a second time used to stack a
        // second 'gattserverdisconnected' listener on it. Two handlers means
        // two reconnects racing on every drop, and — worse — a deliberate
        // Disconnect that comes straight back: the first handler consumes the
        // _leaving flag, the second sees what looks like a surprise drop and
        // dutifully reconnects 600 ms later. Bind exactly one, always.
        if (this._device && this._onDisc) {
          this._device.removeEventListener('gattserverdisconnected', this._onDisc);
        }
        this._device = device;
        this._onDisc = () => this._onDisconnected();
        device.addEventListener('gattserverdisconnected', this._onDisc);
        // A fresh link: abandon any reconnect still in flight, and clear a
        // _leaving left over from an earlier Disconnect — carrying it into
        // this connection would make the next real drop invisible.
        this._cancelReconnect();
        this._leaving = false;
        await this._connectGatt();
        this._emit('state', { connected: true, name: this.deviceName() });
        this._log(`Connected: ${this.deviceName()}`);
      } catch (err) {
        // Matches the old app.js UX: a cancelled chooser or a failed
        // connection is reported through 'log', not a rejected promise —
        // the caller doesn't need its own try/catch around every connect().
        if (err.name === 'NotFoundError') {
          this._log('Selection cancelled.');
        } else {
          this._log(`Connection error: ${err.message}`, 'error');
        }
      }
    }

    async _connectGatt() {
      this._gattServer = await this._device.gatt.connect();

      let svc;
      try {
        svc = await this._gattServer.getPrimaryService(0xfff0);
      } catch (_) {
        svc = await this._gattServer.getPrimaryService(0xff00);
      }

      try {
        this._gattWrite = await svc.getCharacteristic(0xfff2);
      } catch (_) {
        this._gattWrite = await svc.getCharacteristic(0xff02);
      }

      try {
        this._gattNotify = await svc.getCharacteristic(0xfff1);
      } catch (_) {
        try {
          this._gattNotify = await svc.getCharacteristic(0xff01);
        } catch (_2) {
          this._gattNotify = null;
        }
      }

      if (this._gattNotify) {
        await this._gattNotify.startNotifications();
        this._gattNotify.addEventListener('characteristicvaluechanged', (e) => this._onNotification(e));
      }
      this._connected = true;
    }

    // Invalidate any reconnect already scheduled or in flight. The generation
    // number is what an in-flight attempt checks after its awaits, since a
    // promise chain cannot be cancelled once started.
    _cancelReconnect() {
      this._link++;
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
    }

    _onDisconnected() {
      this._connected = false;
      // Handles from the dead link are useless; holding them made a print
      // fail deep inside a GATT write instead of at the door.
      this._gattWrite = null;
      this._gattNotify = null;
      // Always tell the UI, in every branch below. A branch that returned
      // without emitting left the header reading "connected" over a dead
      // link, and then Print silently did nothing at all.
      this._emit('state', { connected: false, name: null });

      // A deliberate disconnect fires this event too. Without this check the
      // reconnect below fires 600 ms later and the link comes straight back,
      // so the Disconnect button appears to do nothing and the printer stays
      // bound to the browser -- which also blocks the CLI and the phone app
      // from ever seeing it advertise.
      if (this._leaving) {
        this._leaving = false;
        return;
      }

      if (this._printing) {
        // Do not attempt to reconnect mid-print. The print loop is awaiting
        // ACKs against the characteristic handles we're about to replace; a
        // reconnect racing against that loop would swap the handles out
        // from under it mid-await. Leave it be and let print()'s own error
        // path (its next GATT write throwing) surface the failure instead.
        this._log('BLE disconnection during printing!', 'error');
        return;
      }

      this._log('BLE disconnected, reconnecting…', 'warn');
      this._cancelReconnect(); // a second drop supersedes the first attempt
      const gen = this._link;
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        if (gen !== this._link) return; // superseded by Connect or Disconnect
        this._connectGatt()
          .then(() => {
            if (gen !== this._link) {
              // The user pressed Disconnect while this was in flight. Honour
              // that rather than handing back a link they just dismissed.
              this.disconnect();
              return;
            }
            this._emit('state', { connected: true, name: this.deviceName() });
            this._log('Reconnected.');
          })
          .catch((err) => {
            if (gen === this._link) this._log(`Reconnection failed: ${err.message}`, 'error');
          });
      }, 600);
    }

    disconnect() {
      this._cancelReconnect();
      const live = !!(this._device && this._device.gatt && this._device.gatt.connected);
      // Arm _leaving ONLY when a disconnection event is actually coming. If
      // the link is already down — the printer slept, the radio dropped it —
      // gatt.disconnect() fires nothing, and the flag would sit there waiting
      // to swallow the NEXT genuine drop: the handler returns early, no
      // reconnect happens, the header still says "connected", and Print does
      // nothing. That was the ghost in this machine.
      this._leaving = live;
      if (live) this._device.gatt.disconnect();
      this._gattWrite = null;
      this._gattNotify = null;
      this._connected = false;
      this._emit('state', { connected: false, name: null });
      this._log('Disconnected.');
    }

    _onNotification(event) {
      const data = new Uint8Array(event.target.value.buffer);
      this.acks.push(data);
      this._emit('notify', data);
    }

    // ---- raw send --------------------------------------------------------

    // Chunked send with an adaptive fallback: on a GATT write error, halve
    // chunkSize (floor 20 B) and replay the same chunk. Safe to replay
    // because a thrown write delivered zero bytes of that chunk — there's
    // no partial-frame corruption to unwind.
    async write(bytes, opts) {
      if (!this._gattWrite) throw new Error('the BLE link is down — press Connect again');
      const noThrottle = !!(opts && opts.noThrottle);
      // 0 = never use writeValueWithResponse. Chrome already applies its own
      // backpressure to writeValueWithoutResponse (unlike bleak on the CLI
      // side, which needs a periodic acknowledged write as a flush barrier).
      // Measured: barrier every 8 costs ~6x throughput here for no benefit.
      const barrierEvery = ((opts && opts.barrierEvery) | 0) || this.barrierEvery | 0;
      const pacingMs = ((opts && opts.pacingMs) | 0) || this.pacingMs | 0;
      let off = 0;
      let n = 0;
      while (off < bytes.length) {
        const end = Math.min(off + this._chunkSize, bytes.length);
        // Re-read the handle every chunk: a drop mid-job nulls it. Checked
        // outside the try on purpose — this is not a write that failed for
        // being too big, so the adaptive halving below must not swallow it.
        const ch = this._gattWrite;
        if (!ch) throw new Error('the BLE link went down mid-job');
        try {
          n++;
          if (barrierEvery && n % barrierEvery === 0) {
            await ch.writeValueWithResponse(bytes.slice(off, end));
          } else {
            await ch.writeValueWithoutResponse(bytes.slice(off, end));
          }
          off = end;
          const gap = pacingMs || (noThrottle ? 0 : INTER_CHUNK_MS);
          if (gap > 0 && off < bytes.length) await sleep(gap);
        } catch (err) {
          if (this._chunkSize > CHUNK_FLOOR) {
            this._chunkSize = Math.max(CHUNK_FLOOR, this._chunkSize >> 1);
            this._log(`MTU too large — chunk reduced to ${this._chunkSize} B, retrying…`, 'warn');
            this._emit('chunk', this._chunkSize);
            continue; // replay same chunk at the new size
          }
          throw err; // already at the 20 B floor: propagate
        }
      }
    }

    sendFrame(cmd, payload) {
      return this.write(window.TP6.proto.frame(cmd, payload));
    }

    // ---- GATT introspection ----------------------------------------------

    // Structured data for the UI to render itself — no strings formatted
    // for display, no DOM.
    async listGatt() {
      if (!this._gattServer) throw new Error('Not connected');
      const services = await this._gattServer.getPrimaryServices();
      const result = [];
      for (const svc of services) {
        const u = svc.uuid;
        const tagged = u.includes('fff0')
          ? 'TP6-S SERVICE (FFF0)'
          : u.includes('ff00')
            ? 'TP6-S SERVICE (FF00)'
            : null;
        const chars = await svc.getCharacteristics();
        const characteristics = chars.map((c) => {
          const cu = c.uuid;
          const role =
            cu.includes('fff1') || cu.includes('ff01')
              ? 'notify'
              : cu.includes('fff2') || cu.includes('ff02')
                ? 'write'
                : null;
          return { uuid: cu, props: charPropsList(c.properties), role };
        });
        result.push({ service: u, tagged, characteristics });
      }
      return result;
    }

    // ---- print pipeline ----------------------------------------------------

    // job  = {data: Uint8Array, bpl: number, height: number}
    // opts = {density, speed, feed, window, minHeight, invert}
    // hooks = {onProgress(pct, {block, blocks, line, lines}), onStats(stats)}
    async print(job, opts, hooks) {
      const options = Object.assign(
        { density: 10, speed: 3, feed: 85, window: 6, minHeight: 64, invert: false },
        opts
      );
      const h = hooks || {};
      const onProgress = h.onProgress || (() => {});
      const onStats = h.onStats || (() => {});
      const proto = window.TP6.proto;

      // Ask the radio, not our own flag. If the printer went to sleep since
      // the last job, everything here would otherwise proceed and finish
      // "successfully" against a link that is not there.
      if (!this.syncState()) {
        throw new Error('the BLE link is down — press Connect again');
      }

      const { data, bpl, height } = job;

      const nonzero = data.reduce((s, b) => s + (b ? 1 : 0), 0);
      this._log(
        `Bitmap: ${data.length} B  ${bpl} B/line  ${height} lines  active=${nonzero}/${data.length}` +
          ` (${Math.round((nonzero * 100) / Math.max(data.length, 1))}%)`
      );

      if (nonzero === 0 && !options.invert) {
        this._log('WARNING: bitmap entirely white — nothing to print!', 'warn');
        return;
      }

      let printData = data;
      if (options.invert) {
        printData = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) printData[i] = data[i] ^ 0xff;
      }

      // Pad short jobs up to a print-safe minimum height.
      let printHeight = height;
      if (height < options.minHeight) {
        const padded = new Uint8Array(bpl * options.minHeight);
        padded.set(printData);
        printData = padded;
        printHeight = options.minHeight;
        this._log(`Padding: ${height} → ${printHeight} lines (print minimum)`);
      }

      this._printing = true;
      try {
        this.acks.clear();

        // Pre-flight. One small command frame, then wait briefly for its ACK.
        // A wedged link takes 20 KB in perfect silence and prints nothing,
        // which from up here is indistinguishable from success — this is the
        // cheapest way to tell the two apart, and it costs ~150 ms. The
        // printer ACKs every command frame, so silence here is meaningful.
        {
          const den = Math.max(1, Math.min(15, options.density));
          await this.sendFrame(proto.CMD.DENSITY, new Uint8Array([den]));
          let replied = true;
          try {
            await this.acks.get(2000);
          } catch (_) {
            replied = false;
          }
          this.acks.clear();
          if (!replied) {
            // Not fatal — proceed, because a false negative that refused to
            // print would be worse than a warning. But say it plainly, so a
            // blank page has an explanation attached instead of a mystery.
            this._log(
              'No reply to the density command — the link is up but the printer is not '
                + 'answering. If nothing comes out, press Disconnect, then Connect, and print '
                + 'again; a fresh link resets the printer\'s frame parser.',
              'warn'
            );
          }
        }

        // ----------------------------------------------------------------
        // Streaming path (default). Build the WHOLE job as one buffer and
        // send it with barrier writes — no ACK gating at all. This is what
        // makes the motor run continuously instead of burping once per
        // frame. Set opts.stream = false for the old per-frame sender.
        // ----------------------------------------------------------------
        if (options.stream !== false) {
          const lpbS = proto.MAX_CHUNK_LINES;
          const nbS = Math.ceil(printHeight / lpbS);
          const parts = [];
          parts.push(proto.frame(proto.CMD.SPEED, new Uint8Array([Math.max(1, Math.min(5, options.speed))])));
          parts.push(proto.frame(proto.CMD.DENSITY, new Uint8Array([Math.max(1, Math.min(15, options.density))])));
          for (let y0 = 0; y0 < printHeight; y0 += lpbS) {
            const y1 = Math.min(y0 + lpbS, printHeight);
            parts.push(proto.frame(proto.CMD.PRINT_IMAGE, printData.slice(y0 * bpl, y1 * bpl)));
          }
          parts.push(proto.frame(proto.CMD.FEED,
            new Uint8Array([options.feed & 0xff, (options.feed >> 8) & 0xff])));

          let total = 0;
          for (const p of parts) total += p.length;
          const jobBuf = new Uint8Array(total);
          let o = 0;
          for (const p of parts) { jobBuf.set(p, o); o += p.length; }

          this._log(
            `Speed=${options.speed}  Density=${options.density}  ${printHeight} lines  ` +
              `[${nbS} frames of ${lpbS}, streamed]  chunk=${this._chunkSize}B`
          );
          const bEvery = (options.barrierEvery | 0) || this.barrierEvery | 0;
          const pMs = (options.pacingMs | 0) || this.pacingMs | 0;
          this._log(`Streaming ${jobBuf.length} B (barrier ${bEvery || 'off'}, pacing ${pMs || 0}ms)…`);

          const t0 = Date.now();
          await this.write(jobBuf, { barrierEvery: bEvery, pacingMs: pMs, noThrottle: true });
          const dt = (Date.now() - t0) / 1000;
          this._log(`  delivered in ${dt.toFixed(1)}s (${(jobBuf.length / 1024 / Math.max(dt, 0.001)).toFixed(1)} KB/s)`);
          onProgress(100, { block: nbS, blocks: nbS, line: printHeight, lines: printHeight });

          // A streamed job yields only a couple of status frames, so waiting
          // on ACKs is not a completion signal. Give the printer time to
          // drain, bounded by the measured ~90 lines/s.
          await sleep(Math.min(20000, Math.max(1200, (printHeight / 60) * 1000 - dt * 1000)));
          this._log('Print complete.');
          return;
        }

        await this.sendFrame(proto.CMD.SPEED, new Uint8Array([Math.max(1, Math.min(5, options.speed))]));
        await sleep(150);
        await this.sendFrame(proto.CMD.DENSITY, new Uint8Array([Math.max(1, Math.min(15, options.density))]));
        await sleep(150);
        // Drain the speed/density ACKs before the image loop starts. They
        // land in the same notification stream as image-frame ACKs; if we
        // don't clear them here, window mode's outstanding-frame counter
        // starts two ACKs short for the rest of the print.
        this.acks.clear();

        const lpb = proto.MAX_CHUNK_LINES;
        const win = options.window && options.window > 0 ? options.window : 1;
        const nb = Math.ceil(printHeight / lpb);
        this._log(
          `Speed=${options.speed}  Density=${options.density}  ${printHeight} lines  ` +
            `[${nb} frames of ${lpb}${win > 1 ? `, window ${win}` : ''}]  chunk=${this._chunkSize}B`
        );

        let outstanding = 0; // frames sent but not yet ACKed (window mode)
        let ackTimeouts = 0; // consecutive silent windows
        let aborted = false;
        let block = 0;

        for (let y0 = 0; y0 < printHeight; y0 += lpb, block++) {
          const y1 = Math.min(y0 + lpb, printHeight);
          const payload = printData.slice(y0 * bpl, y1 * bpl);
          const frame = proto.frame(proto.CMD.PRINT_IMAGE, payload);

          // Always throttle between chunks, even in window mode: unlike
          // bleak (which honours CoreBluetooth's canSendWriteWithoutResponse),
          // Chrome's writeValueWithoutResponse resolves immediately and gives
          // no backpressure, so an unpaced multi-chunk blast can lose a
          // chunk silently — and the printer just discards the resulting
          // malformed frame without ever ACKing it.
          await this.write(frame);

          const pct = Math.round((y1 * 100) / printHeight);

          if (win <= 1) {
            // Legacy stop-and-wait: one ACK per frame, 5 s timeout.
            let lastAck = null;
            try {
              lastAck = await this.acks.get(5000);
            } catch (_) {
              /* timeout: proceed without stats for this block */
            }
            const st = lastAck ? proto.ackStats(lastAck) : null;
            if (st) onStats(st);
            onProgress(pct, { block: block + 1, blocks: nb, line: y1, lines: printHeight });
            this._log(
              `  block ${block + 1}/${nb}  ${pct}%  ACK=${lastAck ? proto.decodeAck(lastAck) : 'TIMEOUT'}`
            );
          } else {
            // Window mode: keep sending as long as fewer than `win` frames
            // are outstanding, so the printer never stalls waiting on us —
            // this is what the official app does. Upstream's stop-and-wait
            // plus its 20 ms inter-chunk sleep is what caused the visible
            // stutter and banding this replaces.
            outstanding++;
            let lastAck = null;
            let a;
            while ((a = this.acks.getNow()) !== null) {
              lastAck = a;
              outstanding--;
              ackTimeouts = 0;
            }
            while (outstanding >= win) {
              try {
                lastAck = await this.acks.get(5000);
                outstanding--;
                ackTimeouts = 0;
              } catch (_) {
                // Never reset `outstanding` to 0 here. Abandoning flow
                // control mid-print would blast every remaining frame into
                // a firmware buffer that's already full; the firmware drops
                // them silently and the page comes out blank. A
                // thermal/power throttle pause on dense art can stall the
                // head for a while and it does resume, so instead fall back
                // toward stop-and-wait (window - 1) and keep waiting. Only
                // give up after 12 consecutive 5 s timeouts — 60 s of total
                // silence.
                if (++ackTimeouts >= 12) {
                  aborted = true;
                  break;
                }
                this._log(`  ACK TIMEOUT (window) — throttling back (${ackTimeouts * 5}s silent)`, 'warn');
                outstanding = win - 1;
                break;
              }
            }
            const st = lastAck ? proto.ackStats(lastAck) : null;
            if (st) onStats(st);
            onProgress(pct, { block: block + 1, blocks: nb, line: y1, lines: printHeight });
            this._log(
              `  block ${block + 1}/${nb}  ${pct}%` +
                (st
                  ? `  ${(st.mv / 1000).toFixed(2)}V  den=${st.density}  T=${st.tempF}°F?  bat=${st.battery}%`
                  : '')
            );
            if (aborted) {
              // Matches the original: this is reported as an error but does
              // not throw — we still send the final feed below so whatever
              // did print gets ejected from under the head, rather than
              // leaving the page stuck mid-roll.
              this._log(
                `No ACK for 60 s — printer wedged, aborted at block ${block + 1}/${nb}. ` +
                  'Lower density/speed, or set ACK Window to 1.',
                'error'
              );
              break;
            }
          }
        }

        // Final feed — sent immediately, before draining any remaining
        // ACKs. The firmware sits on tail-of-buffer frames for several
        // seconds of idle before printing them; CMD_FEED right after the
        // last image frame is what forces that flush. Draining ACKs first
        // would just mean waiting out the idle timeout for nothing.
        this._log(`Feeding paper (${options.feed} lines)…`);
        await this.sendFrame(proto.CMD.FEED, new Uint8Array([options.feed & 0xff, 0x00]));
        while (outstanding > 0) {
          try {
            await this.acks.get(3000);
            outstanding--;
          } catch (_) {
            break;
          }
        }
        await sleep(1000);
        onProgress(100, { block: nb, blocks: nb, line: printHeight, lines: printHeight });
        this._log('Print complete!');
      } catch (err) {
        // A job that stopped halfway leaves the firmware's frame parser
        // mid-frame — it is still counting down a payload length it was
        // promised — and from then on it eats whole jobs in silence. A fresh
        // link is the only reset we have, so take it now rather than let the
        // next print mysteriously produce nothing.
        if (this.linkLive()) {
          this._log('Job interrupted — dropping the link so the next print starts clean.', 'warn');
          this.disconnect();
        }
        throw err;
      } finally {
        this._printing = false;
      }
    }
  }

  window.TP6.ble = new TP6Ble();
})();
