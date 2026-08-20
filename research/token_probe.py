#!/usr/bin/env python3
"""Does the TP6 answer the 0x80 BLE-token query, and do credits move?

Costs no paper. Sends CMD 0x80 idle, then sends a burst of image frames and
re-queries, so we can see whether the reported number tracks buffer usage.
"""
import asyncio, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import tp6s_tool as T
from bleak import BleakClient

ADDR = sys.argv[1]
BURST = int(sys.argv[2]) if len(sys.argv) > 2 else 0   # image frames to inject

rx = []
def on_notify(_, data: bytearray):
    rx.append((time.time(), bytes(data)))
    print(f"   <<  {bytes(data).hex(' ').upper()}")

async def main():
    async with BleakClient(ADDR, timeout=15.0) as c:
        _s, w_u, n_u = T._find_uuids(c)
        print(f"write={w_u}\nnotify={n_u}\nMTU={c.mtu_size}")
        await c.start_notify(n_u, on_notify)
        await asyncio.sleep(0.5)

        async def q(tag):
            rx.clear()
            f = T._make_frame(T.CMD_BLE_TOKENS, b"\x01")   # vendor: DataDP(1, true)
            print(f"\n>> {tag}: {f.hex(' ').upper()}")
            await c.write_gatt_char(w_u, f, response=False)
            await asyncio.sleep(1.2)
            if not rx:
                print("   (no reply)")

        await q("token query, idle")

        if BURST:
            print(f"\n-- injecting {BURST} image frames ({BURST*24} lines) --")
            rx.clear()
            blank = b"\x00" * (T.BPL * 24)          # white: no ink, no heat
            for i in range(BURST):
                fr = T._make_frame(T.CMD_PRINT_IMAGE, blank)
                for off in range(0, len(fr), 240):
                    await c.write_gatt_char(w_u, fr[off:off+240], response=False)
            await q("token query, right after burst")

        await c.stop_notify(n_u)

asyncio.run(main())
