#!/usr/bin/env python3
"""Staircase diagnostic: one solid block per CUS frame, stepping across the
page. A dropped frame leaves an obvious GAP in the staircase, so you can see
data loss at a glance instead of counting hairlines.

    ~/.venvs/tp6s/bin/python research/stair.py <addr> --lines 24 --window 6
"""
import argparse, asyncio, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import tp6s_tool as T

ap = argparse.ArgumentParser()
ap.add_argument("addr")
ap.add_argument("--lines", type=int, default=24)
ap.add_argument("--n", type=int, default=288)
ap.add_argument("--window", type=int, default=6)
a = ap.parse_args()

nframes = -(-a.n // a.lines)
data = bytearray(T.BPL * a.n)
for y in range(a.n):
    i = y // a.lines                      # which frame this line belongs to
    lo = (i * T.BPL) // nframes           # step position, in bytes
    hi = max(lo + 1, ((i + 1) * T.BPL) // nframes)
    row = y * T.BPL
    for b in range(lo, min(hi, T.BPL)):
        data[row + b] = 0xFF

print(f"--- staircase: {nframes} frames x {a.lines} lines, window={a.window} ---")
print(f"--- expect {nframes} blocks stepping L->R, evenly spaced, no gaps ---")
t0 = time.time()
asyncio.run(T._do_print(a.addr, bytes(data), T.BPL, a.n,
                        density=10, speed=3, feed=80,
                        lines_per_frame=a.lines, window=a.window))
print(f"--- {time.time()-t0:.1f} s ---")
