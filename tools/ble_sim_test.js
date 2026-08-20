#!/usr/bin/env node
/* ============================================================
   ble_sim_test.js — exercise web/src/ble.js against a fake radio.

       node tools/ble_sim_test.js            # the shipped ble.js
       node tools/ble_sim_test.js path.js    # some other copy of it

   No printer, no browser, no dependencies. The connect/disconnect/
   reconnect state machine is where the web tool's hinky behaviour lived
   ("connects but won't print, then works after a couple of Disconnect /
   Connect presses"), and none of it needs real hardware to reproduce —
   only a stub that behaves the way Chrome does:

     * requestDevice() hands back the SAME BluetoothDevice object for a
       device this origin has already seen, so listeners STACK
     * gatt.disconnect() fires 'gattserverdisconnected' asynchronously,
       and fires NOTHING AT ALL when the link is already down
     * a link can also drop by itself, with no warning (printer sleeps)

   Exit status is 0 when every scenario passes.
   ============================================================ */

'use strict';

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const BLE_JS = process.argv[2] || path.join(HERE, '..', 'web', 'src', 'ble.js');
const PROTO_JS = path.join(HERE, '..', 'web', 'src', 'protocol.js');

// ---- the fake radio ---------------------------------------------------

// A real status notification, byte for byte (see "The ACK, decoded properly").
const ACK = Uint8Array.from([
  0x64, 0xff, 0x12, 0x08, 0x00, 0xac, 0x07, 0x0b, 0x10,
  0x0a, 0x01, 0x46, 0x54, 0x03, 0x5a, 0x34, 0x12, 0x9b,
]);

const deviceListeners = new Map();

function mkChar(uuid) {
  return {
    uuid,
    properties: { write: true, writeWithoutResponse: true, notify: true },
    writes: 0,
    bytes: 0,
    autoAck: false,
    dropAfterWrite: 0,
    _subs: [],
    _write(v) {
      if (!device.gatt.connected) throw new Error('GATT server not connected');
      this.writes++;
      this.bytes += v.length;
      if (this.autoAck) setTimeout(() => chars.notify.fire(ACK), 1);
      if (this.dropAfterWrite && this.writes >= this.dropAfterWrite) {
        this.dropAfterWrite = 0;
        dropLink();
      }
    },
    async writeValueWithoutResponse(v) { this._write(v); },
    async writeValueWithResponse(v) { this._write(v); },
    async startNotifications() { return this; },
    addEventListener(_ev, fn) { this._subs.push(fn); },
    fire(bytes) {
      const value = { buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
      for (const fn of this._subs.slice()) fn({ target: { value } });
    },
  };
}

const chars = { write: mkChar('0000fff2'), notify: mkChar('0000fff1') };
const service = {
  uuid: '0000fff0-0000-1000-8000-00805f9b34fb',
  async getCharacteristic(u) {
    if (u === 0xfff2) return chars.write;
    if (u === 0xfff1) return chars.notify;
    throw new Error('no such characteristic');
  },
};
const server = {
  async getPrimaryService(u) {
    if (u !== 0xfff0) throw new Error('no such service');
    return service;
  },
};

// `powered` stands in for the printer being awake: when it is off, a fresh
// GATT connect fails the way Chrome reports it.
let powered = true;

const device = {
  name: 'TP6',
  id: 'fake-tp6',
  gatt: {
    connected: false,
    async connect() {
      if (!powered) throw new Error('Connection failed for unknown reason');
      this.connected = true;
      return server;
    },
    disconnect() {
      if (!this.connected) return; // already down: Chrome fires no event
      this.connected = false;
      setTimeout(() => fire('gattserverdisconnected'), 0);
    },
  },
  addEventListener(ev, fn) {
    if (!deviceListeners.has(ev)) deviceListeners.set(ev, []);
    deviceListeners.get(ev).push(fn);
  },
  removeEventListener(ev, fn) {
    const a = deviceListeners.get(ev) || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  },
};

function fire(ev) {
  for (const fn of (deviceListeners.get(ev) || []).slice()) fn();
}
function listenerCount() {
  return (deviceListeners.get('gattserverdisconnected') || []).length;
}
// The printer nodding off, or the radio dropping the link unprompted.
function dropLink() {
  if (!device.gatt.connected) return;
  device.gatt.connected = false;
  fire('gattserverdisconnected');
}

// ---- load the code under test ----------------------------------------

global.window = { TP6: {} };
// Node ships a read-only `navigator`, so plain assignment is silently ignored.
Object.defineProperty(global, 'navigator', {
  value: { bluetooth: { async requestDevice() { return device; } } },
  configurable: true,
  writable: true,
});

new Function(fs.readFileSync(PROTO_JS, 'utf8'))();
new Function(fs.readFileSync(BLE_JS, 'utf8'))();
const ble = global.window.TP6.ble;
const proto = global.window.TP6.proto;

// ---- scenarios --------------------------------------------------------

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let header = false; // what the UI's link chip would be showing
ble.on('state', ({ connected }) => { header = connected; });
const logs = [];
ble.on('log', ({ message }) => logs.push(message));

let failures = 0;
function check(cond, label, detail) {
  if (cond) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? '\n        ' + detail : ''}`);
  }
}
function radio() { return device.gatt.connected ? 'live' : 'down'; }
function headerHonest(label) {
  check(header === device.gatt.connected, label,
    `header says ${header ? 'connected' : 'not connected'}, radio is ${radio()}`);
}

async function main() {
  console.log(`ble.js under test: ${BLE_JS}\n`);

  console.log('0. protocol framing must match the documented wire format');
  proto.resetSeq();
  const feedFrame = proto.frame(0x02, Uint8Array.from([0x55, 0x00]));
  check(proto.hex(feedFrame) === '64 02 00 02 00 55 00 00 00 00 00 9B',
    'CUS frame has magic, sequence, little-endian length, zero checksum and trailer',
    proto.hex(feedFrame));
  const imageFrame = proto.frame(0x00, new Uint8Array(72).fill(0xaa));
  check(imageFrame.length === 82 && imageFrame[5] === 0xaa,
    'one image line is 72 raw payload bytes with no image header');

  console.log('1. two Connect presses must not stack disconnect listeners');
  await ble.connect();
  await ble.connect();
  check(listenerCount() === 1,
    'exactly one gattserverdisconnected listener',
    `${listenerCount()} listeners — every drop would start that many reconnects, `
      + 'and one of them would undo a deliberate Disconnect');

  console.log('2. Disconnect must stay disconnected');
  ble.disconnect();
  await wait(1200); // longer than the 600 ms reconnect delay
  check(!device.gatt.connected, 'still disconnected after 1.2 s',
    'it reconnected itself — the printer stays bound to the tab, invisible to ./tp6');
  headerHonest('header agrees');

  console.log('3. printer sleeps, Disconnect pressed on an already-dead link');
  await ble.connect();
  powered = false;
  dropLink();
  await wait(1200);      // auto-reconnect runs and fails: the printer is asleep
  ble.disconnect();      // user presses Disconnect on a link already gone
  powered = true;
  await ble.connect();   // and Connect again
  await wait(50);
  headerHonest('reconnected cleanly');
  console.log('   ...and now the printer sleeps a second time');
  dropLink();
  await wait(50);
  headerHonest('header follows the radio immediately');
  check(!ble.isConnected(), 'isConnected() is false, so Print cannot be a silent no-op',
    'this is the "connects but will not print" case: the header lies, Print returns '
      + 'without a word, and only a Disconnect/Connect dance clears it');
  await wait(1500);      // let the auto-reconnect finish
  headerHonest('auto-reconnect leaves an honest header');

  console.log('4. printing');
  chars.write.autoAck = true;
  const job = { data: new Uint8Array(72 * 48).fill(0xaa), bpl: 72, height: 48 };
  const before = chars.write.bytes;
  await ble.print(job, { feed: 20 });
  // 10 B of envelope per frame. Preflight density(1) + speed(1) + density(1)
  // + 24/24/16-line image frames (padded to the 64-line minimum) + feed(2).
  const want = 11 + 11 + 11 + (10 + 24 * 72) * 2 + (10 + 16 * 72) + 12;
  check(chars.write.bytes - before === want, 'the whole job reaches the wire',
    `sent ${chars.write.bytes - before} B, expected ${want} B`);

  console.log('5. a printer that answers nothing is called out');
  chars.write.autoAck = false;
  logs.length = 0;
  await ble.print(job, { feed: 20 });
  check(logs.some((m) => /No reply to the density command/.test(m)),
    'pre-flight warns instead of printing into the void');

  console.log('6. a link that drops mid-job fails loudly');
  chars.write.autoAck = true;
  await ble.connect();
  const big = { data: new Uint8Array(72 * 600).fill(0xff), bpl: 72, height: 600 };
  chars.write.dropAfterWrite = chars.write.writes + 3;
  let threw = null;
  try {
    await ble.print(big, { feed: 20 });
  } catch (err) {
    threw = err;
  }
  check(!!threw, 'print() reports the failure rather than claiming success',
    threw ? '' : 'it returned normally with half a job delivered');
  check(!ble.isPrinting(), 'the printing flag is cleared');
  await wait(1500);

  console.log('7. print against a dead link');
  ble.disconnect();
  await wait(100);
  let msg = '';
  try {
    await ble.print(job, { feed: 20 });
  } catch (err) {
    msg = err.message;
  }
  check(/link is down/.test(msg), 'a clear sentence, not silence', msg && `got: ${msg}`);

  console.log(failures ? `\n${failures} FAILED` : '\nall scenarios passed');
  process.exit(failures ? 1 : 0);
}

main();
