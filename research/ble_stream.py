#!/usr/bin/env python3
"""Stream a whole job over BLE with WRITE-WITH-RESPONSE and no ACK gating.

Hypothesis: our burp comes from using write-WITHOUT-response (unacknowledged,
so we must ACK-gate with a small window to avoid overrunning the printer).
Write-with-response is confirmed at the ATT layer, giving reliable delivery
and natural backpressure -- the same property RFCOMM gave us over SPP, but
reachable from Chrome's Web Bluetooth too.

    ~/.venvs/tp6s/bin/python research/ble_stream.py <addr> --stair
    ~/.venvs/tp6s/bin/python research/ble_stream.py <addr> --stair --noresponse
    ~/.venvs/tp6s/bin/python research/ble_stream.py <addr> --image fox.png --nodither
"""
import argparse, asyncio, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import tp6s_tool as T
from bleak import BleakClient

BPL, PRINT_W = T.BPL, T.PRINT_W

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
    if rotate: img = img.rotate(rotate, expand=True)
    img = img.convert('L')
    w, h = img.size
    new_h = max(1, round(h * PRINT_W / w))
    if w != PRINT_W: img = img.resize((PRINT_W, new_h), Image.LANCZOS)
    else: new_h = h
    img1 = img.convert('1') if dither else \
           img.point(lambda p: 0 if p < threshold else 255).convert('1', dither=0)
    return bytes(b ^ 0xFF for b in img1.tobytes()), new_h

async def main(a):
    if a.image:
        img, height = image_raster(a.image, not a.nodither, a.threshold, a.rotate)
    else:
        img, height = stair_raster(a.n, a.lines)

    job = bytearray()
    job += T._make_frame(T.CMD_SET_SPEED,   bytes([a.speed]))
    job += T._make_frame(T.CMD_SET_DENSITY, bytes([a.density]))
    for off in range(0, len(img), a.lines * BPL):
        job += T._make_frame(T.CMD_PRINT_IMAGE, bytes(img[off:off + a.lines * BPL]))
    job += T._make_frame(T.CMD_FEED, bytes([a.feed & 0xFF, (a.feed >> 8) & 0xFF]))
    job = bytes(job)
    nframes = -(-len(img) // (a.lines * BPL))

    acks = []
    def on_notify(_, data):
        acks.append((time.time(), bytes(data)))

    async with BleakClient(a.addr, timeout=20.0) as c:
        _s, w_u, n_u = T._find_uuids(c)
        if not w_u: sys.exit("write UUID not found")
        if n_u: await c.start_notify(n_u, on_notify)
        chunk = a.chunk if a.chunk else c.mtu_size - 3
        resp = not a.noresponse
        print(f"{height} lines, {nframes} frames of {a.lines}, job {len(job)} B")
        print(f"MTU={c.mtu_size} chunk={chunk}  write-with-response={resp}  NO ack gating")

        t0 = time.time()
        n = 0
        for off in range(0, len(job), chunk):
            n += 1
            if a.barrier:
                # cheap unacknowledged writes, with a periodic acknowledged one
                # acting as a barrier so the controller queue can drain
                use_resp = (n % a.barrier == 0)
            else:
                use_resp = resp
            await c.write_gatt_char(w_u, job[off:off + chunk], response=use_resp)
        t_sent = time.time() - t0
        print(f"  streamed  : {t_sent*1000:7.0f} ms  ({len(job)/max(t_sent,1e-6)/1024:.0f} KB/s)")

        while time.time() - t0 < 120:
            await asyncio.sleep(0.05)
            last_ack = acks[-1][0] if acks else t0
            if time.time() - last_ack > 3.0:
                break
        last = acks[-1][0] if acks else t0
        print(f"  print done: {last-t0:7.1f} s   ({len(acks)} status frames)")
        print(f"  throughput: {height/max(last-t0,1e-6):.0f} lines/s")
        if n_u: await c.stop_notify(n_u)

ap = argparse.ArgumentParser()
ap.add_argument("addr"); ap.add_argument("--image"); ap.add_argument("--stair", action="store_true")
ap.add_argument("--lines", type=int, default=24); ap.add_argument("--n", type=int, default=288)
ap.add_argument("--density", type=int, default=10); ap.add_argument("--speed", type=int, default=3)
ap.add_argument("--feed", type=int, default=80); ap.add_argument("--noresponse", action="store_true")
ap.add_argument("--nodither", action="store_true"); ap.add_argument("--threshold", type=int, default=128)
ap.add_argument("--rotate", type=int, default=0)
ap.add_argument("--chunk", type=int, default=0, help="bytes per BLE write (default MTU-3)")
ap.add_argument("--barrier", type=int, default=0, help="every Nth write uses with-response as a flush barrier")
asyncio.run(main(ap.parse_args()))
