#!/usr/bin/env python3
"""A/B the CUS image-frame format against the real printer.

The `test` subcommand of tp6s_tool.py exposes --hdr/--cmd/--lines, but it is
hardwired to 64 lines and stop-and-wait, which is too short to hear a rhythm
and adds a stutter of its own. This drives _do_print directly so the ONLY
thing that changes between two runs is the frame format under test.

    ~/.venvs/tp6s/bin/python research/frame_ab.py <addr>
    ~/.venvs/tp6s/bin/python research/frame_ab.py <addr> --hdr NNWW0000
    ~/.venvs/tp6s/bin/python research/frame_ab.py <addr> --lines 12
    ~/.venvs/tp6s/bin/python research/frame_ab.py <addr> --cmd 01 --hdr NNWW0000

Prints 4-dot bars, because every line is then either fully on or fully off:
the motor's behaviour is audible, and it does not depend on image content.
Count the bars to check nothing was dropped -- each frame of 24 lines carries
exactly 3 black bars, so a missing frame shows up as a multiple of 3.

What the header template means is documented in tp6s_tool._build_hdr_fn:
NN = line count uint16 LE, WW = width uint16 LE, everything else literal hex.
--px sends the width in pixels (576) rather than bytes (72); the original
author left that ambiguity open, which is why the flag exists at all.
"""

import argparse, asyncio, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import tp6s_tool as T


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("addr")
    ap.add_argument("--hdr", default=None,
                    help="image header template, e.g. NNWW0000. Omit for none (current default).")
    ap.add_argument("--cmd", default=None, help="image opcode in hex (default 00)")
    ap.add_argument("--lines", type=int, default=24, help="lines per CUS frame (24 is the firmware cap)")
    ap.add_argument("--n", type=int, default=288, help="total lines to print")
    ap.add_argument("--window", type=int, default=6, help="frames in flight")
    ap.add_argument("--px", action="store_true", help="width field in pixels, not bytes")
    ap.add_argument("--before", default="", help="comma-separated hex opcodes to send before the slices")
    ap.add_argument("--after", default="", help="comma-separated hex opcodes to send after the slices")
    a = ap.parse_args()

    data = bytearray(T.BPL * a.n)
    for y in range(a.n):
        if (y // 4) % 2 == 0:
            data[y * T.BPL:(y + 1) * T.BPL] = b"\xFF" * T.BPL

    hdr = T._build_hdr_fn(a.hdr) if a.hdr is not None else None
    parse = lambda s: [int(x, 16) for x in s.split(",") if x.strip()]

    print(f"--- header={a.hdr or 'none'}  cmd=0x{a.cmd or '00'}  "
          f"lines/frame={a.lines}  total={a.n}  window={a.window} ---")
    if hdr:
        print("    sample:", hdr(a.lines, T.BPL * 8 if a.px else T.BPL).hex(" ").upper())

    t0 = time.time()
    asyncio.run(T._do_print(a.addr, bytes(data), T.BPL, a.n,
                            density=10, speed=3, feed=80,
                            lines_per_frame=a.lines, window=a.window,
                            header_px=a.px, img_hdr_fn=hdr,
                            img_cmd=int(a.cmd, 16) if a.cmd else None,
                            before_cmds=parse(a.before), after_cmds=parse(a.after)))
    elapsed = time.time() - t0
    frames = -(-a.n // a.lines)
    print(f"--- {elapsed:.1f} s total, {frames} frames, "
          f"{(elapsed - 6) / frames * 1000:.0f} ms/frame excluding connect and feed ---")
    print(f"--- expect {a.n // 8} black bars over {a.n / 300 * 25.4:.1f} mm ---")


if __name__ == "__main__":
    main()
