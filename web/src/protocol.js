/* ============================================================
   protocol.js — TP6-S CUS protocol: pure byte work.

   No BLE, no DOM. This file only builds and parses byte arrays;
   it has no idea a Bluetooth radio exists. Classic script (not a
   module) because the tool is opened from file:// where ES module
   imports are blocked by the browser.
   ============================================================ */

(function () {
  'use strict';

  window.TP6 = window.TP6 || {};

  // CUS command opcodes.
  //
  // DENSITY is 0x09, not the 0x04 the upstream README documents. On real
  // hardware 0x04 is ACKed but ignored — the printer stays pinned at its
  // factory-default density (9) no matter what you send it. 0x09 is the
  // opcode that actually moves the density value echoed back in the
  // image-frame ACK; that echo is what proves the difference. Found by
  // live testing against a physical TP6-S, not documented anywhere upstream
  // (see INVESTIGATION.md).
  const CMD = Object.freeze({
    PRINT_IMAGE: 0x00,
    FEED: 0x02,
    DENSITY: 0x09,
    SPEED: 0x0a,
    TOKENS: 0x80,
  });

  // Firmware accepts image frames of up to 24 lines. A 32-line frame is
  // still ACKed, but the printer silently discards it — paper feeds, but
  // nothing prints. Verified against real hardware.
  const MAX_CHUNK_LINES = 24;

  let _seq = 0;

  function resetSeq() {
    _seq = 0;
  }

  // Frame layout: [0x64][cmd][seq 6-bit][len lo][len hi][payload...][0x00 x4][0x9B]
  // The sequence number increments per frame and wraps at 0x3F (6 bits).
  // The four zero bytes before the trailer sit where a checksum would go;
  // every capture from the real app sends them as zero and the firmware has
  // never been observed to reject a frame over it, so this port leaves them
  // untouched rather than guessing at an algorithm nobody has needed yet.
  function frame(cmd, payload) {
    const body = payload || new Uint8Array(0);
    const n = body.length;
    const buf = new Uint8Array(n + 10);
    buf[0] = 0x64;
    buf[1] = cmd;
    buf[2] = _seq & 0x3f;
    _seq = (_seq + 1) & 0x3f;
    buf[3] = n & 0xff;
    buf[4] = (n >> 8) & 0xff;
    if (n) buf.set(body, 5);
    // bytes [5+n .. 8+n] intentionally left zero (see comment above)
    buf[n + 9] = 0x9b;
    return buf;
  }

  function hex(bytes) {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
      .join(' ');
  }

  function ascii(bytes) {
    return Array.from(bytes)
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'))
      .join('');
  }

  // Human-readable one-liner for any ACK frame, used by the diagnostic
  // terminal. Not specific to image ACKs — see ackStats() for the
  // structured decode of those.
  function decodeAck(raw) {
    if (raw.length < 10) return `too short (${raw.length}B)`;
    if (raw[0] !== 0x64) {
      return `invalid magic 0x${raw[0].toString(16).padStart(2, '0').toUpperCase()}`;
    }
    const cmd = raw[1];
    const n = raw[3] | (raw[4] << 8);
    const pay = raw.slice(5, 5 + n);
    const parts = [`CMD=0x${cmd.toString(16).padStart(2, '0').toUpperCase()}`];
    if (pay.length) {
      parts.push(`pay=[${hex(pay)}]`);
      if (cmd === 0xff && pay.length >= 3) {
        parts.push(`echo=0x${pay[2].toString(16).padStart(2, '0').toUpperCase()}`);
      }
      if (pay.length >= 1) {
        parts.push(`status=0x${pay[0].toString(16).padStart(2, '0').toUpperCase()}`);
      }
    }
    return parts.join('  ');
  }

  // Image-frame ACKs carry an 8-byte payload:
  //   [V_mV lo][V_mV hi][flags][0x10][density echo][?][temp][battery %]
  // Temperature reads roughly 70 cold / 90 hot in testing — plausibly °F,
  // never confirmed against a thermometer. The voltage field is what proved
  // that the mid-print pauses on dense art are a firmware thermal/power
  // throttle rather than a driver bug: it visibly sags during solid blacks.
  // Because these ACKs arrive at consumption pace (one per frame actually
  // printed), they double as flow control for window-mode printing, not
  // just telemetry.
  //
  // Returns null when the frame isn't a well-formed image ACK (too short,
  // bad magic, or a short payload) so callers can treat "not stats" and
  // "malformed" the same way.
  function ackStats(raw) {
    if (!raw || raw.length < 13 || raw[0] !== 0x64) return null;
    const n = raw[3] | (raw[4] << 8);
    const pay = raw.slice(5, 5 + n);
    if (pay.length < 8) return null;
    return {
      mv: pay[0] | (pay[1] << 8),
      density: pay[4],
      tempF: pay[6],
      battery: pay[7],
    };
  }

  // A single hex byte token: 1-2 hex digits, value 0-255. Returns null
  // (not NaN) on anything else, so callers can tell "invalid" from "zero"
  // without an extra NaN check.
  function parseHexByte(tok) {
    if (!/^[0-9a-fA-F]{1,2}$/.test(tok)) return null;
    return parseInt(tok, 16);
  }

  function parseHexBytes(tokens) {
    const out = new Uint8Array(tokens.length);
    for (let i = 0; i < tokens.length; i++) {
      const v = parseHexByte(tokens[i]);
      if (v === null) return null;
      out[i] = v;
    }
    return out;
  }

  // Parses one line of the diagnostic terminal's mini-language and returns
  // the bytes to send — it never sends anything itself, which is the whole
  // point of keeping this file free of a BLE dependency.
  //
  // Grammar:
  //   hex                    toggle the terminal's hex/ascii display mode
  //   speed N                CMD_SET_SPEED, N clamped to 1..5
  //   density N              CMD_SET_DENSITY, N clamped to 1..15
  //   feed [N]                CMD_FEED, N defaults to 85
  //   cus CMD [HH HH ...]     raw CUS frame, CMD and payload bytes in hex
  //   <hex bytes...>          anything else: sent as raw bytes, unframed
  //
  // Malformed hex is rejected with {kind:'error'} rather than silently
  // sending zero bytes for the parts that failed to parse — the old
  // app.js used plain parseInt(x, 16) here, which turns garbage into NaN
  // and NaN into 0x00 when it lands in a Uint8Array, so a typo went out
  // over BLE as a run of zero bytes instead of failing loudly.
  function parseCommand(line) {
    const trimmed = (line || '').trim();
    if (!trimmed) return { kind: 'error', message: 'empty command' };

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === 'hex') {
      return { kind: 'hex' };
    }

    if (cmd === 'speed') {
      const n = parts.length >= 2 ? parseInt(parts[1], 10) : NaN;
      if (Number.isNaN(n)) return { kind: 'error', message: 'usage: speed <1-5>' };
      const clamped = Math.max(1, Math.min(5, n));
      return {
        kind: 'speed',
        bytes: frame(CMD.SPEED, new Uint8Array([clamped])),
        label: `CMD_SET_SPEED=${clamped}`,
      };
    }

    if (cmd === 'density') {
      const n = parts.length >= 2 ? parseInt(parts[1], 10) : NaN;
      if (Number.isNaN(n)) return { kind: 'error', message: 'usage: density <1-15>' };
      const clamped = Math.max(1, Math.min(15, n));
      return {
        kind: 'density',
        bytes: frame(CMD.DENSITY, new Uint8Array([clamped])),
        label: `CMD_SET_DENSITY=${clamped}`,
      };
    }

    if (cmd === 'feed') {
      let n = 85;
      if (parts.length >= 2) {
        n = parseInt(parts[1], 10);
        if (Number.isNaN(n)) return { kind: 'error', message: 'usage: feed [lines]' };
      }
      return {
        kind: 'feed',
        bytes: frame(CMD.FEED, new Uint8Array([n & 0xff, 0x00])),
        label: `CMD_FEED=${n}`,
      };
    }

    if (cmd === 'cus') {
      if (parts.length < 2) {
        return { kind: 'error', message: 'usage: cus <CMD hex> [payload bytes hex...]' };
      }
      const cId = parseHexByte(parts[1]);
      if (cId === null) return { kind: 'error', message: `invalid CUS command byte: ${parts[1]}` };
      const payload = parseHexBytes(parts.slice(2));
      if (payload === null) {
        return { kind: 'error', message: `invalid payload hex in: ${parts.slice(2).join(' ')}` };
      }
      const label = `CUS cmd=0x${cId.toString(16).padStart(2, '0').toUpperCase()} payload=${payload.length}B`;
      return { kind: 'cus', bytes: frame(cId, payload), label };
    }

    // Otherwise: the whole line is raw hex bytes, sent unframed.
    const raw = parseHexBytes(parts);
    if (raw === null) {
      return { kind: 'error', message: `not a recognised command or valid hex: ${trimmed}` };
    }
    return { kind: 'raw', bytes: raw, label: `RAW ${raw.length}B` };
  }

  window.TP6.proto = {
    CMD,
    MAX_CHUNK_LINES,
    frame,
    resetSeq,
    hex,
    ascii,
    decodeAck,
    ackStats,
    parseCommand,
  };
})();
