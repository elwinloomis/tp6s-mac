#!/usr/bin/env python3
"""Print over Bluetooth Classic SPP the way the vendor app does: build the
WHOLE job as one buffer of concatenated CUS frames, chunk it to the RFCOMM
MTU, and stream it with no per-frame ACK gating.

    ~/.venvs/tp6s/bin/python research/spp_print.py --addr aa-bb-cc-dd-ee-ff --stair
    ~/.venvs/tp6s/bin/python research/spp_print.py --image fox.png --nodither
    ~/.venvs/tp6s/bin/python research/spp_print.py --image fox.png --repeat 2

The printer's BD_ADDR comes from --addr or $TP6S_BDADDR (find yours with
`blueutil --inquiry 15`). Requires: blueutil --pair <that address>
(unpair afterwards to get BLE back).
"""
import argparse, os, time, sys
from Foundation import NSObject
from IOBluetooth import IOBluetoothDevice
from CoreFoundation import CFRunLoopRunInMode, kCFRunLoopDefaultMode

BPL, PRINT_W = 72, 576
CMD_IMAGE, CMD_FEED, CMD_DENSITY, CMD_SPEED = 0x00, 0x02, 0x09, 0x0A

acks = []
writes_done = []
class Delegate(NSObject):
    def rfcommChannelData_data_length_(self, ch, data, length):
        acks.append((time.time(), bytes(data[:length])))
    def rfcommChannelClosed_(self, ch):
        print("   !! channel closed by remote")
    def rfcommChannelWriteComplete_refcon_status_(self, ch, refcon, status):
        writes_done.append(status)

def pump(sec):
    end = time.time() + sec
    while time.time() < end:
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, False)

def pump_until_quiet(quiet=3.0, cap=120.0):
    """Wait until the printer has said nothing for `quiet` seconds."""
    t0 = time.time()
    while time.time() - t0 < cap:
        last = acks[-1][0] if acks else t0
        if time.time() - last > quiet:
            return last
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, False)
    return acks[-1][0] if acks else t0

_seq = 0
def frame(cmd, payload=b""):
    global _seq
    _seq = (_seq + 1) & 0x3F
    n = len(payload); f = bytearray(n + 10)
    f[0], f[1], f[2] = 0x64, cmd, _seq
    f[3], f[4] = n & 0xFF, (n >> 8) & 0xFF
    f[5:5+n] = payload; f[n+9] = 0x9B
    return bytes(f)

def stair_raster(n, lines):
    nframes = -(-n // lines)
    img = bytearray(BPL * n)
    for y in range(n):
        i = y // lines
        lo = (i * BPL) // nframes
        hi = max(lo + 1, ((i + 1) * BPL) // nframes)
        for b in range(lo, min(hi, BPL)):
            img[y * BPL + b] = 0xFF
    return bytes(img), n

def image_raster(path, dither, threshold, rotate):
    from PIL import Image
    img = Image.open(path)
    print(f"Image: {path}  {img.size[0]}x{img.size[1]}  mode={img.mode}")
    if img.mode in ('RGBA','LA','PA') or (img.mode=='P' and 'transparency' in img.info):
        img = img.convert('RGBA')
        bg = Image.new('RGBA', img.size, (255,255,255,255))
        img = Image.alpha_composite(bg, img)
    if rotate:
        img = img.rotate(rotate, expand=True)
    img = img.convert('L')
    w, h = img.size
    new_h = max(1, round(h * PRINT_W / w))
    if w != PRINT_W:
        img = img.resize((PRINT_W, new_h), Image.LANCZOS)
    else:
        new_h = h
    img1 = img.convert('1') if dither else \
           img.point(lambda p: 0 if p < threshold else 255).convert('1', dither=0)
    data = bytes(b ^ 0xFF for b in img1.tobytes())   # PIL 0=black -> printer 1=ink
    return data, new_h

ap = argparse.ArgumentParser()
ap.add_argument("--image"); ap.add_argument("--stair", action="store_true")
ap.add_argument("--lines", type=int, default=24)
ap.add_argument("--n", type=int, default=288)
ap.add_argument("--density", type=int, default=10)
ap.add_argument("--speed", type=int, default=3)
ap.add_argument("--feed", type=int, default=80)
ap.add_argument("--repeat", type=int, default=1)
ap.add_argument("--nodither", action="store_true")
ap.add_argument("--threshold", type=int, default=128)
ap.add_argument("--rotate", type=int, default=0)
ap.add_argument("--sync", action="store_true", help="old blocking writeSync path")
ap.add_argument("--addr", default=os.environ.get("TP6S_BDADDR"),
                help="printer BD_ADDR, e.g. aa-bb-cc-dd-ee-ff (default $TP6S_BDADDR)")
a = ap.parse_args()
if not a.addr:
    sys.exit("no printer address: pass --addr or set $TP6S_BDADDR "
             "(find it with `blueutil --inquiry 15`)")
PIPELINE = not a.sync

if a.image:
    img, height = image_raster(a.image, not a.nodither, a.threshold, a.rotate)
else:
    img, height = stair_raster(a.n, a.lines)

job = bytearray()
job += frame(CMD_SPEED,   bytes([a.speed]))
job += frame(CMD_DENSITY, bytes([a.density]))
for off in range(0, len(img), a.lines * BPL):
    job += frame(CMD_IMAGE, bytes(img[off:off + a.lines * BPL]))
job += frame(CMD_FEED, bytes([a.feed & 0xFF, (a.feed >> 8) & 0xFF]))
job = bytes(job)
nframes = -(-len(img) // (a.lines * BPL))
print(f"{height} lines, {nframes} image frames of {a.lines}, job {len(job)} B "
      f"(asked density={a.density} speed={a.speed})")

d = IOBluetoothDevice.deviceWithAddressString_(a.addr)
if d.openConnection() != 0: sys.exit("baseband connect failed")
dele = Delegate.alloc().init()
err, ch = d.openRFCOMMChannelSync_withChannelID_delegate_(None, 1, dele)
if err != 0 or ch is None: sys.exit(f"RFCOMM open failed: {err}")
mtu = ch.getMTU()
print(f"RFCOMM open, MTU={mtu}")

for run in range(1, a.repeat + 1):
    acks.clear()
    t0 = time.time()
    writes_done.clear()
    nchunks = 0
    for off in range(0, len(job), mtu):
        piece = job[off:off + mtu]
        nchunks += 1
        if PIPELINE:
            # queue without blocking; if the stack is full, let it drain a bit
            for _ in range(400):
                e = ch.writeAsync_length_refcon_(piece, len(piece), off)
                if e == 0:
                    break
                CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, False)
            else:
                print(f"  !! writeAsync stuck at offset {off}"); break
        else:
            e = ch.writeSync_length_(piece, len(piece))
            if e != 0:
                print(f"  !! write error {e} at offset {off}"); break
    if PIPELINE:                       # wait for the queue to actually flush
        while len(writes_done) < nchunks and time.time() - t0 < 120:
            CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.02, False)
    t_sent = time.time() - t0
    last = pump_until_quiet()
    print(f"\n--- run {run}/{a.repeat} ---")
    print(f"  streamed  : {t_sent*1000:7.0f} ms  ({len(job)/max(t_sent,1e-6)/1024:.0f} KB/s)")
    print(f"  print done: {last-t0:7.1f} s   (last status frame)")
    print(f"  throughput: {height/max(last-t0,1e-6):.0f} lines/s "
          f"= {height/300*25.4/max(last-t0,1e-6):.1f} mm/s")
    print(f"  status frames: {len(acks)}")
    for t, p in acks[:2] + (acks[-1:] if len(acks) > 2 else []):
        if len(p) >= 13 and p[0] == 0x64:
            mv = p[5] | (p[6] << 8)
            print(f"    t+{t-t0:5.1f}s  {p[1]:02X}  {mv} mV  flags={p[8]:02X}{p[7]:02X}"
                  f"  den={p[9]}  T={p[11]}  bat={p[12]}%")

ch.closeChannel(); d.closeConnection()
print("\nchannel closed cleanly")
