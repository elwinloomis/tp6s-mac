#!/usr/bin/env python3
"""
tp6s_tool.py — PC tool for TP6-S thermal printer via BLE (bleak)

Usage:
  ./tp6 image file.png              # <addr> is optional everywhere now
  ./tp6 print "Text to print"
  ./tp6 feed [lines]
  ./tp6 scan                        # list everything, for diagnosis
  ./tp6 forget                      # stop remembering the printer
  ./tp6 info | uart | test [black|bars|white]
  ./tp6 serve [port]                # local HTTP helper for web/tp6s.html (default 8776)
  ./tp6 gui [port]                  # same, and opens it in the browser

The printer is found in this order: an <addr> you pass, then $TP6S_ADDR, then
the device remembered from last time, then a scan (which is then remembered).
The cache lives in ~/.config/tp6s/device.json, deliberately outside this
folder: macOS gives each host a CoreBluetooth UUID rather than a device MAC,
so a repository-synced identifier would not be portable.

  ./tp6 image <addr> file.jpg [--nodither] [--threshold 128] [--rotate 90]
  ./tp6 test  <addr> [black|bars|white] [--px] [--before HH,HH] [--after HH,HH]

Image options:
  --nodither          Fixed threshold instead of Floyd-Steinberg dithering
  --threshold N       Black/white threshold 1-255 (default 128, with --nodither)
  --rotate N          Rotation in degrees (e.g. 90 for landscape)
  --density N         Thermal density 1-15 (default 10; higher = darker)
  --speed N           Speed 1-5 (default 3; lower = more heat)
  --legacy            Old per-frame ACK-gated sender (stuttering, slower).
                      Only useful for diagnosing which frame a printer rejects.
  --window N          Frames in flight, --legacy only (default 6; 1 = stop-and-
                      wait). Ignored when streaming. Do NOT raise above 6: the
                      old sender silently drops frames beyond that.
  --lines N           Lines per CUS frame (default 24 = max firmware verified).
                      WARNING: 32+ firmware ACKs but prints nothing

Dependencies are managed by ./setup.sh; use ./setup.sh --pdf for PDF support.

UART mode (interactive BLE terminal on FFF2/FFF1):
  Available commands in terminal:
    XX XX XX ...        Send raw bytes (hex, space-separated)
    cus CMD [HH HH ...] Send encapsulated CUS frame (CMD in hex)
    speed N             CMD_SET_SPEED (1-5)
    density N           CMD_SET_DENSITY (1-15)
    feed [N]            Feed N lines (default 85)
    hex                 Toggle hex/ascii display of notifications
    quit / q            Quit

  Examples:
    > cus 02 55 00   -> CMD_FEED 85 lines
    > cus 09 08      -> CMD_SET_DENSITY to 8
    > cus 0A 03      -> CMD_SET_SPEED to 3

CUS protocol:
  [0x64][CMD][SEQ_6bit][LEN_LO][LEN_HI][PAYLOAD...][0x00 x4][0x9B]

Real TP6-S UUIDs (detected by bleak):
  Service: 0000fff0-0000-1000-8000-00805f9b34fb  (0xFFF0)
  Write  : 0000fff2-0000-1000-8000-00805f9b34fb  (0xFFF2)
  Notify : 0000fff1-0000-1000-8000-00805f9b34fb  (0xFFF1)
"""

import asyncio
import base64
import http.server
import json
import os
import platform
import re
import threading
import time
import sys
import struct
import webbrowser
from bleak import BleakScanner, BleakClient

CMD_PRINT_IMAGE = 0x00
CMD_FEED        = 0x02
CMD_SET_DENSITY = 0x09   # 0x04 (upstream value) has no effect on real TP6-S;
                         # upstream UART example ("cus 09 08") uses 0x09 correctly
CMD_SET_SPEED   = 0x0A
CMD_BLE_TOKENS  = 0x80

PRINT_W         = 576
BPL             = 72
MAX_CHUNK_LINES = 8
BLE_CHUNK_SZ    = 244
INTER_CHUNK_MS  = 0.020
# Every Nth BLE write uses write-WITH-response (see _stream_job). 8 was
# measured on the test Mac and is lossless there FOR A SHORT JOB; the
# size rule below is what decides whether a given job may use it.
#
# This knob was added while chasing the dropped bands, on a first guess that
# the number was a property of the host's Bluetooth controller and so would
# differ per Mac. It is not — the same Mac drops a long job and prints a
# short one — so leave it alone in normal use and let SAFE_FAST_BYTES choose.
# It stays because measuring the next such question needs a way to hold the
# barrier still:
#
#     TP6S_BARRIER=1 ./tp6 gui          every write acknowledged, always
#     TP6S_BARRIER=8 ./tp6 image big.png   full speed even on a long job,
#                                          i.e. reproduce the bug on purpose
#
# Setting it AT ALL disables the size rule, in both directions. 1 is the safe
# floor: ~6.5 KB/s against ~6.5 KB/s consumed, so the motor may burp, but
# nothing can be lost.
try:
    BARRIER_EVERY = max(1, int(os.environ.get("TP6S_BARRIER", "8")))
except ValueError:
    BARRIER_EVERY = 8
BARRIER_FORCED = "TP6S_BARRIER" in os.environ   # set by hand: never overridden

# Long jobs must not be delivered at full speed. Measured on paper
# 2026-08-19, printing the same artwork at two sizes:
#
#    288 lines   21 KB   barrier 8   prints             (staircase, 2026-08-14)
#   1008 lines   73 KB   barrier 8   prints             (fox.png, 2026-08-14)
#   ~1000 lines  72 KB   barrier 8   prints
#   1845 lines  133 KB   barrier 8   DROPS a band, every time, motor smooth
#   1845 lines  133 KB   barrier 1   prints
#
# The telemetry rules out the printer struggling: across the failing job the
# voltage held at 1.94-1.96 and the temperature never moved off 70, so this
# is not the thermal/power throttle. The bytes never arrived.
#
# The barrier delivers ~11 KB/s against ~6.5 KB/s consumed, and that surplus
# accumulates somewhere — the printer's buffer, which has a bottom. Under
# ~73 KB the whole job fits inside whatever margin exists; well past it, the
# overflow is discarded in silence.
#
# A modelled version of this was tried first — estimate the lead from elapsed
# time and throttle above 24 KB of it — and it STILL dropped a band, early,
# before the throttle engaged. The estimate is wrong in a direction that
# flatters it (the printer does not start consuming when the first byte lands),
# and rather than tune a model nobody can see inside, this switches on the one
# quantity known exactly and in advance: how big the job is.
#
# So: full speed up to the largest job proven lossless, every write
# acknowledged above it. TP6S_BARRIER overrides both, for measuring.
SAFE_FAST_BYTES = 73 * 1024      # 1038 lines of 72 B; fox.png is 1008

_seq = 0


# ---------------------------------------------------------------------------
# Protocole CUS
# ---------------------------------------------------------------------------

def _make_frame(cmd, payload=b""):
    global _seq
    n = len(payload)
    frame = bytearray(n + 10)
    frame[0] = 0x64
    frame[1] = cmd
    frame[2] = _seq & 0x3F
    _seq = (_seq + 1) & 0x3F
    frame[3] = n & 0xFF
    frame[4] = (n >> 8) & 0xFF
    if n:
        frame[5:5 + n] = payload
    # bytes [5+n .. 8+n] = checksum TX = 0x00000000 (already zero)
    frame[n + 9] = 0x9B
    return bytes(frame)


async def _send(client, write_uuid, cmd, payload=b"", chunk_sz=BLE_CHUNK_SZ):
    frame = _make_frame(cmd, payload)
    for off in range(0, len(frame), chunk_sz):
        await client.write_gatt_char(write_uuid, frame[off:off + chunk_sz],
                                     response=False)
        if off + chunk_sz < len(frame):
            await asyncio.sleep(INTER_CHUNK_MS)


async def _stream_job(client, write_uuid, job, chunk_sz, barrier=BARRIER_EVERY):
    """Stream one pre-built job buffer, with periodic with-response barriers.

    write-without-response is unacknowledged, and bleak does not honour
    CoreBluetooth's canSendWriteWithoutResponse, so blasting it silently drops
    packets once the controller queue fills — that is what used to eat whole
    image frames and print a short page. Making every `barrier`-th write a
    write-WITH-response drains that queue and gives real backpressure, at a
    fraction of the cost of acknowledging every packet.

    Measured on a TP6-S: ~11 KB/s delivered vs ~6 KB/s consumed. That margin is
    what keeps the printer's buffer from running dry, and a buffer that never
    empties is a motor that never stops.

    But a margin compounds, and on a long job it puts more into the printer
    than the printer can hold — see SAFE_FAST_BYTES, where the caller decides
    which barrier a job of this size may safely use.
    """
    n = 0
    for off in range(0, len(job), chunk_sz):
        n += 1
        await client.write_gatt_char(write_uuid, job[off:off + chunk_sz],
                                     response=(n % barrier == 0))
    return n


async def _await_print_end(ack_q, lines, quiet=2.5, floor=1.0):
    """Wait for the printer to finish after the job is delivered.

    A streamed job produces only a couple of status frames, so 'wait for ACKs'
    is not a completion signal. Wait for notifications to go quiet, bounded by
    a generous estimate from the measured ~90 lines/s.

    Keeps what it hears rather than throwing it away: the status frames carry
    voltage, temperature and battery, and a job that came out with a band
    missing is worth being able to ask about afterwards. Returns
    (elapsed, [raw frames]).
    """
    cap = max(5.0, lines / 60.0 + 8.0)
    t0 = time.monotonic()
    last = t0
    seen = []
    while time.monotonic() - t0 < cap:
        try:
            seen.append(await asyncio.wait_for(ack_q.get(), timeout=0.25))
            last = time.monotonic()
        except asyncio.TimeoutError:
            pass
        if time.monotonic() - last > quiet and time.monotonic() - t0 > floor:
            break
    return time.monotonic() - t0, seen


async def _check_tokens(client, write_uuid, ack_q, chunk_sz):
    """BLE flow control: query CMD 0x80, wait if printer buffer full."""
    token_frame = _make_frame(CMD_BLE_TOKENS)
    await client.write_gatt_char(write_uuid, token_frame, response=False)
    try:
        resp = await asyncio.wait_for(ack_q.get(), timeout=0.5)
        # RX frame: [0x64][type][seq][len_lo][len_hi][payload...][checksum x4][0x9B]
        if len(resp) >= 6 and resp[0] == 0x64:
            pl_len = resp[3] | (resp[4] << 8)
            if pl_len > 0 and len(resp) >= 5 + pl_len:
                tokens = resp[5]
                if tokens < chunk_sz:
                    await asyncio.sleep(0.2)
    except asyncio.TimeoutError:
        pass


# ---------------------------------------------------------------------------
# Discovery of real UUIDs (search FFF0/FFF1/FFF2 or FF00/FF01/FF02)
# ---------------------------------------------------------------------------

def _find_uuids(client):
    """Search for write/notify UUIDs in all GATT services."""
    write_uuid = None
    notif_uuid = None
    svc_uuid   = None

    for svc in client.services:
        u = str(svc.uuid).lower()
        # Service FFF0 (real TP6-S) or FF00 (documented)
        if "fff0" in u or "ff00" in u:
            svc_uuid = svc.uuid
            for c in svc.characteristics:
                cu = str(c.uuid).lower()
                props = set(c.properties)
                # Write: FFF2 or FF02
                if ("fff2" in cu or "ff02" in cu) and props & {"write", "write-without-response"}:
                    write_uuid = c.uuid
                # Notify: FFF1 or FF01
                elif ("fff1" in cu or "ff01" in cu) and props & {"notify", "indicate"}:
                    notif_uuid = c.uuid

    return svc_uuid, write_uuid, notif_uuid


# ---------------------------------------------------------------------------
# Commandes
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Finding the printer: cache, then scan
# ---------------------------------------------------------------------------

NAME_PREFIX = "TP6"          # matches both "TP6" and "TP6-S"


def _cache_path():
    """Where the remembered device lives.

    NOT in the project folder. On macOS, bleak/CoreBluetooth hands back a
    per-HOST UUID rather than a MAC, so the identifier for this printer is
    different on every Mac. A cached address stored in a synced repository
    would therefore be wrong on another machine.
    """
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(
        os.path.expanduser("~"), ".config")
    return os.path.join(base, "tp6s", "device.json")


def _cache_load():
    try:
        with open(_cache_path(), encoding="utf-8") as fh:
            d = json.load(fh)
        return d.get("address"), d.get("name")
    except (OSError, ValueError):
        return None, None


def _cache_save(address, name):
    try:
        path = _cache_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"address": address, "name": name,
                       "host": platform.node()}, fh, indent=2)
    except OSError:
        pass            # a cache we cannot write is not worth failing a print over


def _cache_clear():
    try:
        os.remove(_cache_path())
        return True
    except OSError:
        return False


def _looks_like_addr(s):
    """CoreBluetooth UUID (macOS) or a colon/dash MAC (Linux/Windows)."""
    if not s or s.startswith("-"):
        return False
    if re.fullmatch(r"[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}", s):
        return True
    return bool(re.fullmatch(r"([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}", s))


async def _scan_for_printer(timeout=8.0):
    """Scan, stopping as soon as a TP6 answers.

    BleakScanner.discover() always burns its whole timeout; this returns in
    about a second in the normal case, which matters because it now sits in
    front of every print.
    """
    found = {}
    done = asyncio.Event()

    def _on_detect(dev, adv):
        name = dev.name or (adv.local_name if adv else None) or ""
        if name.upper().startswith(NAME_PREFIX):
            if dev.address not in found:
                found[dev.address] = (name, adv.rssi if adv else -999)
                done.set()

    scanner = BleakScanner(detection_callback=_on_detect)
    await scanner.start()
    try:
        await asyncio.wait_for(done.wait(), timeout=timeout)
        await asyncio.sleep(0.6)      # let a second printer answer before deciding
    except asyncio.TimeoutError:
        pass
    finally:
        await scanner.stop()
    return sorted(found.items(), key=lambda kv: kv[1][1], reverse=True)


async def resolve_address(explicit=None, quiet=False):
    """Work out which printer to talk to.

    Order: explicit argument, then $TP6S_ADDR, then the remembered device,
    then a scan (which is remembered for next time). Returns None and explains
    itself if nothing usable turns up.
    """
    if explicit:
        return explicit

    env = os.environ.get("TP6S_ADDR")
    if env:
        if not quiet:
            print(f"Printer: {env}  (from $TP6S_ADDR)")
        return env

    addr, name = _cache_load()
    if addr:
        if not quiet:
            print(f"Printer: {name or 'TP6'}  {addr}  (remembered)")
        return addr

    if not quiet:
        print(f"Looking for a {NAME_PREFIX} printer...")
    hits = await _scan_for_printer()

    if not hits:
        print(f"No {NAME_PREFIX} printer found. Is it powered on?")
        print("  If something else holds the link (a browser tab, the phone app,")
        print("  or a Bluetooth Classic pairing), it will not advertise at all.")
        return None

    if len(hits) > 1:
        print(f"More than one {NAME_PREFIX} printer answered:")
        for a, (n, rssi) in hits:
            print(f"  {a}  {n}  {rssi} dBm")
        print("Pass the one you want as the first argument.")
        return None

    addr, (name, rssi) = hits[0]
    _cache_save(addr, name)
    if not quiet:
        print(f"Printer: {name}  {addr}  ({rssi} dBm, remembered for next time)")
    return addr


async def cmd_scan():
    print("BLE scan 10s...")
    devices = await BleakScanner.discover(timeout=10.0, return_adv=True)
    if not devices:
        print("No devices found.")
        return
    print(f"\n{'Address':<20} {'Name':<28} {'RSSI':>5}  Services")
    print("-" * 80)
    for addr, (dev, adv) in sorted(devices.items(),
                                    key=lambda kv: kv[1][1].rssi, reverse=True):
        name = (dev.name or "?")[:27]
        rssi = adv.rssi
        svcs = [str(u).lower() for u in adv.service_uuids]
        tp6  = " <<< TP6-S" if any(("fff0" in s or "ff00" in s) for s in svcs) else ""
        svc_s = " ".join(s[-8:] for s in svcs[:3])
        print(f"{addr:<20} {name:<28} {rssi:>5}  {svc_s}{tp6}")


async def cmd_info(addr):
    print(f"Connecting to {addr}...")
    async with BleakClient(addr, timeout=10.0) as client:
        print(f"Connected: {client.is_connected}\n")
        print("GATT Services:")
        for svc in client.services:
            u = str(svc.uuid).lower()
            tag = ""
            if "fff0" in u: tag = " <<< TP6-S SERVICE (FFF0)"
            elif "ff00" in u: tag = " <<< TP6-S SERVICE (FF00)"
            print(f"  {svc.uuid}{tag}")
            for c in svc.characteristics:
                cu = str(c.uuid).lower()
                props = ",".join(c.properties)
                tag2 = ""
                if "fff1" in cu or "ff01" in cu: tag2 = " <<< NOTIFY"
                if "fff2" in cu or "ff02" in cu: tag2 = " <<< WRITE"
                print(f"    {c.uuid}  [{props}]{tag2}")
        print()
        svc_u, w_u, n_u = _find_uuids(client)
        print("Auto-detection result:")
        print(f"  Service: {svc_u}")
        print(f"  Write  : {w_u}")
        print(f"  Notify : {n_u}")


async def cmd_uart(addr):
    """Interactive BLE terminal — sends on FFF2, displays FFF1 notifications."""
    print(f"Connecting to {addr}...")
    loop = asyncio.get_event_loop()
    rx_queue = asyncio.Queue()
    show_hex = [True]

    async with BleakClient(addr, timeout=10.0) as client:
        svc_u, w_u, n_u = _find_uuids(client)
        if w_u is None:
            print("ERROR: write UUID not found (run 'info' to diagnose)")
            return

        print(f"Connected  Service:{svc_u}")
        print(f"  Write  : {w_u}")
        print(f"  Notify : {n_u}")
        print()
        print("Commands: XX XX ...  |  cus CMD [HH ...]  |  speed N  |  density N  |  feed [N]  |  hex  |  quit")
        print("-" * 70)

        def _notif_handler(handle, data: bytearray):
            rx_queue.put_nowait(bytes(data))

        if n_u:
            await client.start_notify(n_u, _notif_handler)
            print(f"[notifications active on {n_u}]")
        else:
            print("[WARNING: notify UUID not found, no RX]")

        async def _rx_printer():
            while True:
                try:
                    data = await asyncio.wait_for(rx_queue.get(), timeout=0.1)
                    if show_hex[0]:
                        print(f"\r<< {data.hex(' ').upper()}")
                    else:
                        safe = "".join(chr(b) if 0x20 <= b < 0x7F else "." for b in data)
                        print(f"\r<< [{len(data)}B] {safe}")
                    print("> ", end="", flush=True)
                except asyncio.TimeoutError:
                    pass

        rx_task = asyncio.create_task(_rx_printer())

        try:
            while True:
                print("> ", end="", flush=True)
                line = await loop.run_in_executor(None, sys.stdin.readline)
                line = line.strip()
                if not line:
                    continue

                parts = line.split()
                cmd_str = parts[0].lower()

                if cmd_str in ("quit", "q", "exit"):
                    break

                elif cmd_str == "hex":
                    show_hex[0] = not show_hex[0]
                    print(f"[display {'hex' if show_hex[0] else 'ascii'}]")

                elif cmd_str == "speed" and len(parts) >= 2:
                    n = max(1, min(5, int(parts[1])))
                    frame = _make_frame(CMD_SET_SPEED, bytes([n]))
                    await client.write_gatt_char(w_u, frame, response=False)
                    print(f">> CMD_SET_SPEED={n}  {frame.hex(' ').upper()}")

                elif cmd_str == "density" and len(parts) >= 2:
                    n = max(1, min(15, int(parts[1])))
                    frame = _make_frame(CMD_SET_DENSITY, bytes([n]))
                    await client.write_gatt_char(w_u, frame, response=False)
                    print(f">> CMD_SET_DENSITY={n}  {frame.hex(' ').upper()}")

                elif cmd_str == "feed":
                    n = int(parts[1]) if len(parts) >= 2 else 85
                    frame = _make_frame(CMD_FEED, bytes([n & 0xFF, 0x00]))
                    await client.write_gatt_char(w_u, frame, response=False)
                    print(f">> CMD_FEED={n}  {frame.hex(' ').upper()}")

                elif cmd_str == "cus" and len(parts) >= 2:
                    # cus CMD [HH HH ...]  — encapsule dans une trame CUS
                    try:
                        c_id   = int(parts[1], 16)
                        p_data = bytes(int(x, 16) for x in parts[2:])
                        frame  = _make_frame(c_id, p_data)
                        # envoyer par chunks de BLE_CHUNK_SZ
                        for off in range(0, len(frame), BLE_CHUNK_SZ):
                            await client.write_gatt_char(
                                w_u, frame[off:off + BLE_CHUNK_SZ], response=False)
                            if off + BLE_CHUNK_SZ < len(frame):
                                await asyncio.sleep(INTER_CHUNK_MS)
                        print(f">> CUS cmd=0x{c_id:02X} payload={len(p_data)}B  {frame.hex(' ').upper()}")
                    except ValueError as e:
                        print(f"[hex error: {e}]")

                else:
                    # Raw bytes in hex: "64 03 01 ..."
                    try:
                        raw = bytes(int(x, 16) for x in parts)
                        for off in range(0, len(raw), BLE_CHUNK_SZ):
                            await client.write_gatt_char(
                                w_u, raw[off:off + BLE_CHUNK_SZ], response=False)
                            if off + BLE_CHUNK_SZ < len(raw):
                                await asyncio.sleep(INTER_CHUNK_MS)
                        print(f">> RAW {len(raw)}B  {raw.hex(' ').upper()}")
                    except ValueError:
                        print(f"[unknown command: {line!r}]")

        finally:
            rx_task.cancel()
            if n_u:
                try:
                    await client.stop_notify(n_u)
                except Exception:
                    pass

    print("Disconnected.")


async def cmd_feed(addr, lines=140):
    async with BleakClient(addr, timeout=10.0) as client:
        _, w_u, _ = _find_uuids(client)
        if w_u is None:
            print("ERROR: write UUID not found (run 'info' to diagnose)")
            return
        print(f"Feeding paper ({lines} lines)...")
        await _send(client, w_u, CMD_FEED, bytes([lines & 0xFF, 0x00]))
        await asyncio.sleep(0.5)
        print("OK")


def _ack_decode(raw):
    """Decode a CUS ACK received from the printer."""
    if len(raw) < 10:
        return f"too short ({len(raw)}B)"
    if raw[0] != 0x64:
        return f"invalid magic 0x{raw[0]:02X}"
    cmd = raw[1]
    n   = raw[3] | (raw[4] << 8)
    pay = raw[5:5 + n] if len(raw) >= 5 + n else raw[5:]
    parts = [f"CMD=0x{cmd:02X}"]
    if pay:
        parts.append("pay=[" + " ".join(f"{b:02X}" for b in pay) + "]")
        if cmd == 0xFF and len(pay) >= 3:
            parts.append(f"echo_cmd=0x{pay[2]:02X}")
        if len(pay) >= 1:
            parts.append(f"status=0x{pay[0]:02X}")
    return "  ".join(parts)


def _ack_temp(raw):
    """Extract temperature (byte[6] of payload) from CUS ACK, or None."""
    if len(raw) < 12:
        return None
    n = raw[3] | (raw[4] << 8)
    if len(raw) < 5 + n:
        return None
    pay = raw[5:5 + n]
    return pay[6] if len(pay) >= 7 else None


def _ack_stats(raw):
    """Decode image ACK stats (8 byte payload):
    [V_lo][V_hi][flags][0x10][density echo][?][temp (°F ?)][battery %]
    Returns dict or None."""
    if len(raw) < 13 or raw[0] != 0x64:
        return None
    n = raw[3] | (raw[4] << 8)
    pay = raw[5:5 + n]
    if len(pay) < 8:
        return None
    return {"mv": pay[0] | (pay[1] << 8), "den": pay[4],
            "temp": pay[6], "batt": pay[7]}


def _build_hdr_fn(tmpl):
    """Compile CUS image header template into callable (nlines, width) -> bytes.

    Special tokens in hex string:
      NN  = nlines as uint16 little-endian (2 bytes)
      WW  = width  as uint16 little-endian (2 bytes)
    Rest is literal hex pair by pair.

    Examples:
      ""          -> empty header (raw pixels only)
      "NN"        -> [nlines_lo nlines_hi]   (2 bytes)
      "NNWW"      -> [nlines_lo nlines_hi width_lo width_hi]  (4 bytes)
      "NNWW0000"  -> default format at 6 bytes
      "WWNN"      -> width first, then nlines
      "01004800"  -> literal [01 00 48 00]
    """
    segments = []
    s = tmpl.upper().replace(' ', '')
    i = 0
    while i < len(s):
        if s[i:i+2] == 'NN':
            segments.append('n')
            i += 2
        elif s[i:i+2] == 'WW':
            segments.append('w')
            i += 2
        elif i + 1 < len(s) and all(c in '0123456789ABCDEF' for c in s[i:i+2]):
            segments.append(int(s[i:i+2], 16))
            i += 2
        else:
            i += 1
    def build(nlines, width):
        out = bytearray()
        for seg in segments:
            if seg == 'n':
                out += bytes([nlines & 0xFF, (nlines >> 8) & 0xFF])
            elif seg == 'w':
                out += bytes([width & 0xFF, (width >> 8) & 0xFF])
            else:
                out.append(seg)
        return bytes(out)
    return build


async def _do_print(addr, data, width_bytes, height, density=10, speed=3, feed=140,
                    min_height=64, invert=False, force=False, header_px=False,
                    before_cmds=(), after_cmds=(), n_lines=None,
                    lines_per_frame=None, img_cmd=None, img_hdr_fn=None,
                    window=1, stream=True):
    # Bitmap diagnostic
    nonzero = sum(1 for b in data if b)
    print(f"Bitmap: {len(data)} bytes  {width_bytes} bytes/line  {height} lines  "
          f"active_pixels={nonzero}/{len(data)} ({nonzero*100//max(len(data),1)}%)")
    if nonzero == 0 and not invert and not force:
        print("WARNING: bitmap entirely white — nothing to print!")
        return

    # Optional pixel inversion (polarity test)
    if invert:
        data = bytes(b ^ 0xFF for b in data)
        nonzero2 = sum(1 for b in data if b)
        print(f"Inverted bitmap: active_pixels={nonzero2}/{len(data)}")

    # Minimum padding to activate thermal head
    if height < min_height:
        pad = bytearray(width_bytes * (min_height - height))
        data = bytes(data) + bytes(pad)
        print(f"Padding: {height} → {min_height} lines (print minimum)")
        height = min_height

    print(f"Connecting to {addr}...")
    async with BleakClient(addr, timeout=15.0) as client:
        _, w_u, n_u = _find_uuids(client)
        if w_u is None:
            print("ERROR: write UUID not found — run first:")
            print(f"  ./tp6 info {addr}")
            return

        chunk_sz = max(20, client.mtu_size - 3)
        print(f"Write UUID: {w_u}  MTU={client.mtu_size}  chunk={chunk_sz}")

        _cmd = img_cmd if img_cmd is not None else CMD_PRINT_IMAGE
        if _cmd != CMD_PRINT_IMAGE:
            print(f"CMD_PRINT override: 0x{_cmd:02X}  (default=0x{CMD_PRINT_IMAGE:02X})")
        if img_hdr_fn is not None:
            sample_hdr = img_hdr_fn(1, width_bytes * 8 if header_px else width_bytes)
            print(f"HDR override ({len(sample_hdr)}B): {sample_hdr.hex(' ').upper() or '(empty)'}")
        else:
            print("Image payload: raw 1bpp, no header (default)")

        # Lines per CUS frame: 8 by default (cusPkgImgSlice sends in chunks)
        lpb = lines_per_frame if lines_per_frame and lines_per_frame > 0 else MAX_CHUNK_LINES
        nb  = (height + lpb - 1) // lpb
        mode_str = f"{nb} frame(s) of {lpb} lines" if nb > 1 else "1 single frame"
        mode_str += ", streamed" if stream else f", legacy window {window}"
        print(f"Speed={speed}  Density={density}  {height} lines  [{mode_str}]")

        # Notifications: printer ACK
        ack_q = asyncio.Queue()
        def _notif(handle, raw):
            ack_q.put_nowait(bytes(raw))
        if n_u:
            await client.start_notify(n_u, _notif)
            print(f"[notify FFF1 active]")
        else:
            print("[WARNING: notify UUID not found — no ACK]")

        # ------------------------------------------------------------------
        # Streaming path (default). Build the WHOLE job as one buffer and send
        # it with barrier writes — no ACK gating at all. This is what makes the
        # motor run continuously instead of burping once per frame; see
        # _stream_job and ARCHITECTURE.md's transport section.
        # ------------------------------------------------------------------
        if stream:
            w_hdr_s = width_bytes * 8 if header_px else width_bytes
            job = bytearray()
            job += _make_frame(CMD_SET_SPEED,   bytes([max(1, min(5,  speed))]))
            job += _make_frame(CMD_SET_DENSITY, bytes([max(1, min(15, density))]))
            for c in before_cmds:
                job += _make_frame(c, b"")
            for y0 in range(0, height, lpb):
                y1 = min(y0 + lpb, height)
                chunk = bytes(data[y0 * width_bytes : y1 * width_bytes])
                if img_hdr_fn is not None:
                    chunk = bytes(img_hdr_fn(y1 - y0, w_hdr_s)) + chunk
                job += _make_frame(_cmd, chunk)
            for c in after_cmds:
                job += _make_frame(c, b"")
            job += _make_frame(CMD_FEED, bytes([feed & 0xFF, (feed >> 8) & 0xFF]))
            job = bytes(job)

            if BARRIER_FORCED or len(job) <= SAFE_FAST_BYTES:
                barrier, why = BARRIER_EVERY, ""
            else:
                barrier = 1
                why = (f" — {len(job)//1024} KB is past the {SAFE_FAST_BYTES//1024} KB "
                       f"a full-speed job may safely be, so every write is "
                       f"acknowledged")
            print(f"Streaming {len(job)} B in {chunk_sz}-byte writes "
                  f"(barrier every {barrier}){why}...")
            t0 = time.monotonic()
            nw = await _stream_job(client, w_u, job, chunk_sz, barrier)
            dt = time.monotonic() - t0
            print(f"  delivered {nw} writes in {dt:.1f}s "
                  f"({len(job)/max(dt,1e-6)/1024:.1f} KB/s)")

            if n_u:
                tail, acks = await _await_print_end(ack_q, height)
                print(f"  printer finished ~{dt + tail:.1f}s after start")
                # Every print is also a measurement. Bands of lines going
                # missing have two plausible causes — writes discarded by a
                # congested Bluetooth controller (see BARRIER_EVERY) or the
                # printer's own power sagging — and the telemetry tells them
                # apart: a sag shows up here as millivolts falling and
                # temperature climbing across the job.
                stats = [st for st in (_ack_stats(a) for a in acks) if st]
                if stats:
                    mv = [st["mv"] for st in stats]
                    print(f"  {len(acks)} status frame(s); "
                          f"V {min(mv)/1000:.2f}-{max(mv)/1000:.2f}  "
                          f"T {stats[0]['temp']}->{stats[-1]['temp']}  "
                          f"batt {stats[-1]['batt']}%")
                try:
                    await client.stop_notify(n_u)
                except Exception:
                    pass
            else:
                await asyncio.sleep(max(1.0, height / 60.0))
            print("Print complete.")
            return

        await _send(client, w_u, CMD_SET_SPEED,   bytes([max(1, min(5,  speed))]), chunk_sz)
        await asyncio.sleep(0.15)
        await _send(client, w_u, CMD_SET_DENSITY, bytes([max(1, min(15, density))]), chunk_sz)
        await asyncio.sleep(0.15)

        bpl  = width_bytes
        h    = height
        bloc = 0
        # header_px=True: width in pixels (bpl*8), otherwise in bytes (bpl).
        w_hdr = bpl * 8 if header_px else bpl

        # Drain ACK queue from speed/density commands — otherwise counted as image frame
        # ACKs (window mode: final drain waits for 2 phantom ACKs → 5s pause before feed)
        if n_u:
            while True:
                try:
                    stale = await asyncio.wait_for(ack_q.get(), timeout=0.3)
                    print(f"  [drain speed/density ACK] {stale.hex(' ').upper()}")
                except asyncio.TimeoutError:
                    break

        # --- before_cmds: send before image blocks ---
        for c in before_cmds:
            await _send(client, w_u, c, b"", chunk_sz)
            await asyncio.sleep(0.4)
            if n_u:
                try:
                    ack = await asyncio.wait_for(ack_q.get(), timeout=3.0)
                    t = _ack_temp(ack)
                    print(f"  [BEFORE CMD=0x{c:02X}] ACK={ack.hex(' ').upper()}  T={t}°C")
                except asyncio.TimeoutError:
                    print(f"  [BEFORE CMD=0x{c:02X}] TIMEOUT (no ACK)")

        outstanding  = 0   # trames envoyees non encore ACKees (mode fenetre)
        ack_timeouts = 0   # fenetres consecutives sans ACK
        aborted      = False
        for y0 in range(0, h, lpb):
            y1     = min(y0 + lpb, h)
            nlines = y1 - y0
            bloc  += 1

            if img_hdr_fn is not None:
                hdr = img_hdr_fn(nlines, w_hdr)
                payload = bytes(hdr) + bytes(data[y0 * bpl : y1 * bpl])
            else:
                payload = bytes(data[y0 * bpl : y1 * bpl])
            frame   = _make_frame(_cmd, payload)

            if bloc == 1:
                preview = frame[:min(28, len(frame))]
                print(f"  [frame start] {preview.hex(' ').upper()}"
                      f"{'...' if len(frame) > 28 else ''}  ({len(frame)}B total)")

            for off in range(0, len(frame), chunk_sz):
                await client.write_gatt_char(w_u, frame[off:off + chunk_sz],
                                             response=False)
                # Window mode: no inter-chunk pause — bleak handles native flow
                # control (canSendWriteWithoutResponse on macOS)
                if window <= 1 and off + chunk_sz < len(frame):
                    await asyncio.sleep(INTER_CHUNK_MS)

            pct = y1 * 100 // h

            if window <= 1:
                # Legacy stop-and-wait: ACK after each frame (max 5s)
                ack_hex = "--"
                if n_u:
                    try:
                        ack = await asyncio.wait_for(ack_q.get(), timeout=5.0)
                        ack_hex = ack.hex(' ').upper()
                    except asyncio.TimeoutError:
                        ack_hex = "TIMEOUT"
                else:
                    await asyncio.sleep(0.15)
                print(f"  block {bloc:4d}/{nb}  {pct:3d}%  ACK={ack_hex}")
            else:
                # Window mode: continue sending as long as printer
                # is not more than `window` frames behind → smooth printing
                outstanding += 1
                last_stats = None
                if n_u:
                    while not ack_q.empty():
                        s = _ack_stats(ack_q.get_nowait())
                        if s is not None:
                            last_stats = s
                        outstanding -= 1
                        ack_timeouts = 0
                    while outstanding >= window:
                        try:
                            ack = await asyncio.wait_for(ack_q.get(), timeout=5.0)
                            s = _ack_stats(ack)
                            if s is not None:
                                last_stats = s
                            outstanding -= 1
                        except asyncio.TimeoutError:
                            # Never reset outstanding to 0: abandoning flow
                            # control mid-print blasts the remaining frames into
                            # an already-full printer buffer, the firmware drops
                            # them silently, and the page comes out blank. Fall
                            # back to ~stop-and-wait and keep waiting — a
                            # thermal/power pause on dense art can stall the head
                            # for a while and it does resume. Bail out only after
                            # 60 s of total silence, i.e. the printer is wedged.
                            ack_timeouts += 1
                            if ack_timeouts >= 12:
                                aborted = True
                                break
                            print(f"  block {bloc:4d}/{nb}  ACK TIMEOUT (window)"
                                  f" — throttling back ({ack_timeouts*5}s silent)")
                            outstanding = window - 1
                            break
                        else:
                            ack_timeouts = 0
                s_str = ""
                if last_stats:
                    s_str = (f"  {last_stats['mv']/1000:.2f}V"
                             f"  den={last_stats['den']}"
                             f"  T={last_stats['temp']}°F?"
                             f"  bat={last_stats['batt']}%")
                print(f"  block {bloc:4d}/{nb}  {pct:3d}%  in_flight={outstanding}{s_str}")
                if aborted:
                    print(f"  No ACK for 60 s — printer wedged, aborted at block "
                          f"{bloc}/{nb}. Lower --density/--speed, or use --window 1.")
                    break

        # Window mode: firmware holds last frames in buffer and
        # waits ~few secs of inactivity before printing — send feed
        # IMMEDIATELY to force flush, then collect remaining ACKs
        if window > 1:
            print(f"\nFeeding paper ({feed} lines)...")
            await _send(client, w_u, CMD_FEED, bytes([feed & 0xFF, 0x00]), chunk_sz)
            if n_u:
                while outstanding > 0:
                    try:
                        await asyncio.wait_for(ack_q.get(), timeout=3.0)
                        outstanding -= 1
                    except asyncio.TimeoutError:
                        break
            await asyncio.sleep(1.0)

        # --- after_cmds : envoyer apres les blocs image ---
        if after_cmds:
            await asyncio.sleep(0.5)   # laisser l'imprimante finir le traitement
        for c in after_cmds:
            await _send(client, w_u, c, b"", chunk_sz)
            await asyncio.sleep(0.4)
            if n_u:
                try:
                    ack = await asyncio.wait_for(ack_q.get(), timeout=5.0)
                    t = _ack_temp(ack)
                    print(f"  [AFTER  CMD=0x{c:02X}] ACK={ack.hex(' ').upper()}  T={t}°C")
                except asyncio.TimeoutError:
                    print(f"  [AFTER  CMD=0x{c:02X}] TIMEOUT (pas d'ACK)")

        if n_u:
            try:
                await client.stop_notify(n_u)
            except Exception:
                pass

        if window <= 1:   # mode fenetre : feed deja envoye (flush du buffer)
            print(f"\nAvance papier ({feed} lignes)...")
            await _send(client, w_u, CMD_FEED, bytes([feed & 0xFF, 0x00]), chunk_sz)
            await asyncio.sleep(1.0)
        print("Impression terminee !")


async def cmd_test_print(addr, pattern="black", density=12, speed=3, feed=40,
                         bpl_override=None, n=64, header_px=False,
                         before_cmds=(), after_cmds=(), lines_per_frame=None,
                         img_cmd=None, img_hdr_fn=None):
    """Motif de test : 'black' (plein), 'bars' (rayures 4px), 'white' (0x00 force).
    bpl_override   : 72 (576px, 80mm) ou 48 (384px, 58mm) — defaut BPL=72.
    header_px      : True = header width en pixels, False = en octets (defaut).
    before_cmds    : liste de CMD IDs (int) a envoyer avant les blocs image.
    after_cmds     : liste de CMD IDs (int) a envoyer apres les blocs image.
    lines_per_frame: lignes max par trame CUS (1-2 = 1 write BLE, 48 = multi-write).
    img_cmd        : octet de commande CUS pour les blocs image (defaut=CMD_PRINT_IMAGE=0x00).
    img_hdr_fn     : callable (nlines, width) -> bytes pour le header image (defaut=6 octets).
    """
    bpl = bpl_override if bpl_override else BPL
    w   = bpl * 8
    if pattern == "black":
        data = bytes([0xFF] * (bpl * n))
    elif pattern in ("inv", "white"):
        data = bytes([0x00] * (bpl * n))
    elif pattern == "bars":
        row_on  = bytes([0xFF] * bpl)
        row_off = bytes(bpl)
        buf = bytearray()
        for y in range(n):
            buf += row_on if (y // 4) % 2 == 0 else row_off
        data = bytes(buf)
    else:
        print(f"Pattern inconnu : {pattern!r}  (black | bars | white)")
        return
    nonzero = sum(1 for b in data if b)
    hdr_mode = f"header_px={w}" if header_px else f"header_bpl={bpl}"
    print(f"Test pattern={pattern!r}  bpl={bpl} ({w}px)  {hdr_mode} : {n} lignes  "
          f"{nonzero}/{len(data)} bytes actifs")
    if before_cmds:
        print(f"  before_cmds : {[f'0x{c:02X}' for c in before_cmds]}")
    if after_cmds:
        print(f"  after_cmds  : {[f'0x{c:02X}' for c in after_cmds]}")
    if lines_per_frame:
        hdr_bytes = len(img_hdr_fn(1, bpl)) if img_hdr_fn is not None else 0
        print(f"  lines_per_frame={lines_per_frame}  (frame={10 + hdr_bytes + bpl * lines_per_frame}B)")
    if img_cmd is not None:
        print(f"  img_cmd=0x{img_cmd:02X}  (defaut=0x{CMD_PRINT_IMAGE:02X})")
    if img_hdr_fn is not None:
        sample = img_hdr_fn(lines_per_frame or 1, bpl)
        print(f"  img_hdr ({len(sample)}B) : {sample.hex(' ').upper() or '(vide)'}")
    force = pattern in ("white", "inv")
    await _do_print(addr, data, bpl, n, density=density, speed=speed, feed=feed,
                    min_height=0, force=force, header_px=header_px,
                    before_cmds=before_cmds, after_cmds=after_cmds,
                    lines_per_frame=lines_per_frame,
                    img_cmd=img_cmd, img_hdr_fn=img_hdr_fn)


async def cmd_print_text(addr, text, font_size=32, density=12, speed=3, feed=85):
    try:
        from PIL import Image, ImageDraw, ImageFont
        _pil = True
    except ImportError:
        _pil = False

    scale = max(1, font_size // 8)
    cw    = 8 * scale
    cpl   = PRINT_W // cw

    lines = []
    for raw in text.replace('\r', '').split('\n'):
        if not raw:
            lines.append('')
        else:
            while len(raw) > cpl:
                lines.append(raw[:cpl])
                raw = raw[cpl:]
            lines.append(raw)

    total_h = len(lines) * (8 * scale)
    if total_h == 0:
        print("Empty text.")
        return

    data = bytearray(BPL * total_h)

    if _pil:
        img  = Image.new('1', (PRINT_W, total_h), 0)
        draw = ImageDraw.Draw(img)
        try:
            fnt = ImageFont.truetype("arial.ttf", 8 * scale)
        except Exception:
            fnt = ImageFont.load_default()
        for li, line in enumerate(lines):
            draw.text((0, li * 8 * scale), line, fill=1, font=fnt)
        px = img.load()
        for y in range(total_h):
            for xb in range(BPL):
                byte = 0
                for bit in range(8):
                    x = xb * 8 + bit
                    if x < PRINT_W and px[x, y]:
                        byte |= (0x80 >> bit)
                data[y * BPL + xb] = byte
    else:
        print("Pillow is unavailable — repair the environment with ./setup.sh")
        print("Printing with basic render (horizontal lines)...")
        for y in range(total_h):
            for xb in range(BPL):
                data[y * BPL + xb] = 0xFF if y % (8 * scale) == 0 else 0x00

    await _do_print(addr, bytes(data), BPL, total_h, density, speed, feed)


async def cmd_print_pbm(addr, path, density=8, speed=3, feed=85):
    with open(path, 'rb') as f:
        magic = f.readline().strip()
        if magic != b'P4':
            raise ValueError("PBM P4 (binary) format required")
        while True:
            line = f.readline()
            if not line.startswith(b'#'):
                break
        parts = line.split()
        w   = int(parts[0])
        h   = int(parts[1])
        bpl = (w + 7) // 8
        raw = f.read(bpl * h)

    print(f"PBM: {w}x{h} pixels")

    if w != PRINT_W:
        print(f"Resizing {w} -> {PRINT_W}px...")
        dst = bytearray(BPL * h)
        for y in range(h):
            for x in range(PRINT_W):
                sx  = x * w // PRINT_W
                sb  = raw[y * bpl + (sx >> 3)]
                bit = (sb >> (7 - (sx & 7))) & 1
                if bit:
                    di = y * BPL + (x >> 3)
                    dst[di] |= 0x80 >> (x & 7)
        raw = bytes(dst)
        bpl = BPL

    await _do_print(addr, raw, bpl, h, density, speed, feed)


def prepare_raster(img, threshold=128, dither=True, rotate=0):
    """A PIL image → (packed 1-bit dots, height) ready for _do_print.

    Extracted verbatim out of cmd_print_raster so that everything which makes
    dots goes through ONE pipeline — the CLI's `image`, and tools/pdf_service.py
    (the print-dialog door), which needs the packed bytes in hand to POST them
    at the helper. A second resize/dither/pack would drift from this one and
    the paper would stop matching the preview; see ARCHITECTURE.md. Behaviour
    is unchanged: the dots are byte-identical to what
    this code produced inline before the extraction.
    """
    from PIL import Image

    # Alpha = white background (else convert('L') ignores alpha and may blacken everything)
    if img.mode in ('RGBA', 'LA', 'PA') or (img.mode == 'P' and 'transparency' in img.info):
        img = img.convert('RGBA')
        bg = Image.new('RGBA', img.size, (255, 255, 255, 255))
        img = Image.alpha_composite(bg, img)
        print("Alpha composite on white background")

    if rotate:
        img = img.rotate(rotate, expand=True)
        print(f"Rotation {rotate}°  → {img.size[0]}x{img.size[1]}")

    img = img.convert('L')  # grayscale

    w, h = img.size
    new_h = max(1, round(h * PRINT_W / w))
    if w != PRINT_W:
        img = img.resize((PRINT_W, new_h), Image.LANCZOS)
        print(f"Resize: {w}x{h} → {PRINT_W}x{new_h}")
    else:
        new_h = h

    if dither:
        img1 = img.convert('1')  # Floyd-Steinberg by default
        mode_str = "Floyd-Steinberg"
    else:
        img1 = img.point(lambda p: 0 if p < threshold else 255).convert('1', dither=0)
        mode_str = f"threshold {threshold}"
    print(f"1bpp ({mode_str}) → {BPL}×{new_h}={BPL * new_h} bytes")

    # PIL mode '1': bit=0 → black (prints), printer: bit=1 → prints → XOR 0xFF
    raw1 = img1.tobytes()
    return bytes(b ^ 0xFF for b in raw1), new_h


async def cmd_print_raster(addr, path, density=10, speed=3, feed=150,
                           threshold=128, dither=True, rotate=0,
                           lines_per_frame=24, window=6, stream=True):
    """Print JPG/PNG file (any PIL format) converted to 1bpp."""
    try:
        from PIL import Image
    except ImportError:
        print("Pillow is unavailable — repair the environment with ./setup.sh")
        return

    img = Image.open(path)
    print(f"Image: {path}  {img.size[0]}x{img.size[1]}  mode={img.mode}")

    data, new_h = prepare_raster(img, threshold=threshold, dither=dither, rotate=rotate)

    await _do_print(addr, data, BPL, new_h, density, speed, feed,
                    lines_per_frame=lines_per_frame, window=window, stream=stream)


# ---------------------------------------------------------------------------
# HTTP helper: serves web/ on localhost and prints jobs it sends over BLE.
#
# Exists because Chrome's Web Bluetooth is too slow to print smoothly (see
# INVESTIGATION.md) — the browser composes
# the page, then hands the finished bitmap to this helper, which prints it
# through the same fast streamed path the CLI uses.
# ---------------------------------------------------------------------------

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")


class _BleWorker:
    """One asyncio event loop, owned by one daemon thread, for the whole
    server's lifetime. bleak/BleakClient are not meant to be spun up fresh
    per call, so every print job runs on this same loop instead of an
    asyncio.run() per request — HTTP handler threads hand it a coroutine and
    block on the result."""

    def __init__(self):
        self.loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def submit(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result()

    def stop(self):
        self.loop.call_soon_threadsafe(self.loop.stop)


# The one failure that looks like a mystery from the browser: the printer is
# there, powered, remembered — and simply not reachable, because something
# else already holds its single BLE link. A connected peripheral stops
# advertising, so it vanishes from a scan too.
_HELD_LINK_HINT = (
    "The printer is not advertising. Is it powered on? If it is, something else "
    "already holds its Bluetooth link — a browser tab connected with Web Bluetooth "
    "(press Disconnect in the page, or close the tab), the phone app, or a "
    "Bluetooth Classic pairing (blueutil --unpair <the printer's BD_ADDR>). It talks to "
    "one thing at a time."
)


async def _serve_feed_job(payload):
    """POST /api/feed — {lines} → one CMD_FEED, then let the link go."""
    lines = payload.get("lines", 85)
    if not isinstance(lines, int) or not 1 <= lines <= 255:
        return 400, {"error": "lines must be an integer 1-255"}

    async def go(addr):
        print(f"Feeding {lines} lines...")
        async with BleakClient(addr, timeout=15.0) as client:
            _, w_u, _ = _find_uuids(client)
            if w_u is None:
                return 500, {"error": "write characteristic not found"}
            await _send(client, w_u, CMD_FEED, bytes([lines & 0xFF, 0x00]))
            await asyncio.sleep(0.5)
        return 200, {"ok": True, "lines": lines}

    return await _with_printer(go)


async def _serve_raw_job(payload):
    """POST /api/raw — write arbitrary bytes, return whatever comes back.

    This is the Terminal tab's transport. It is deliberately one connection
    per command rather than a link the helper keeps open: a helper holding
    the printer is the exact failure that makes everything else mysterious
    (it stops advertising, so `./tp6 image` from another shell cannot find
    it), and the terminal is request/response anyway — you type a frame, you
    read the ACK. The cost is the connect, about 1.2 s warm.
    """
    try:
        raw = bytes.fromhex(payload.get("hex", ""))
    except ValueError:
        return 400, {"error": "hex is not valid hexadecimal"}
    if not raw:
        return 400, {"error": "nothing to send"}
    if len(raw) > 4096:
        return 400, {"error": "too many bytes for one terminal command"}
    # How long to keep listening after the write. The printer answers command
    # frames in well under a second; this is a ceiling, not a wait.
    try:
        listen = min(5.0, max(0.2, float(payload.get("listen", 1.2))))
    except (TypeError, ValueError):
        return 400, {"error": "listen must be a number of seconds"}

    async def go(addr):
        rx = []
        async with BleakClient(addr, timeout=15.0) as client:
            _, w_u, n_u = _find_uuids(client)
            if w_u is None:
                return 500, {"error": "write characteristic not found"}
            if n_u:
                await client.start_notify(n_u, lambda h, d: rx.append(bytes(d).hex()))

            chunk_sz = max(20, client.mtu_size - 3)
            for off in range(0, len(raw), chunk_sz):
                await client.write_gatt_char(w_u, raw[off:off + chunk_sz], response=False)
            await asyncio.sleep(listen)

        print(f"[serve] raw {len(raw)} B sent, {len(rx)} notification(s) back")
        return 200, {"ok": True, "sent": len(raw), "rx": rx, "notify": bool(n_u)}

    return await _with_printer(go)


async def _serve_gatt():
    """GET /api/gatt — the service/characteristic dump, in the exact shape
    the page's renderer already expects from Web Bluetooth's listGatt()."""
    async def go(addr):
        out = []
        async with BleakClient(addr, timeout=15.0) as client:
            for svc in client.services:
                u = str(svc.uuid).lower()
                tagged = ("TP6-S SERVICE (FFF0)" if "fff0" in u
                          else "TP6-S SERVICE (FF00)" if "ff00" in u else None)
                chars = []
                for c in svc.characteristics:
                    cu = str(c.uuid).lower()
                    role = ("notify" if ("fff1" in cu or "ff01" in cu)
                            else "write" if ("fff2" in cu or "ff02" in cu) else None)
                    chars.append({"uuid": str(c.uuid), "props": list(c.properties),
                                  "role": role})
                out.append({"service": str(svc.uuid), "tagged": tagged,
                            "characteristics": chars})
        return 200, {"ok": True, "services": out}

    return await _with_printer(go)


class _NoPrinter(Exception):
    """Nothing to talk to: not remembered, and a scan turned up nothing."""


async def _with_printer(run):
    """Resolve the printer, hand the address to `run(addr)`, and retry once
    with a fresh scan if a REMEMBERED address turns out not to exist.

    macOS hands out a per-HOST UUID for a BLE peripheral rather than a MAC,
    and it can change (a CoreBluetooth cache reset, a re-pair). Without this
    retry a single stale cache entry fails every request until somebody
    thinks to run `./tp6 forget` — and "it just finds the printer" stops
    being true in exactly the case where it matters.

    Only device-not-found is retried, and that is the safe line to draw:
    not-found is always raised *before* the link exists, so the job never
    started and cannot be done twice. Anything failing after that may already
    have put ink on paper, and reprinting it is worse than reporting it.
    """
    addr = await resolve_address(None)
    if addr is None:
        raise _NoPrinter("no printer found")

    cached, _name = _cache_load()
    try:
        return await run(addr)
    except Exception as e:
        if addr != cached or "not found" not in str(e).lower():
            raise
        # Scan BEFORE touching the cache. "Not found" means the address did
        # not answer, which is equally what an off or held printer looks
        # like — and throwing away a perfectly good address for that would
        # cost a full scan on every later job. Only a scan that turns up a
        # DIFFERENT address proves the remembered one is stale.
        print(f"[serve] {addr} did not answer — scanning in case it moved")
        hits = await _scan_for_printer()
        if len(hits) != 1:
            raise _NoPrinter("no printer found")
        fresh, (name, _rssi) = hits[0]
        if fresh == addr:
            raise                      # same address, still not reachable
        print(f"[serve] printer is now {fresh} — remembering that instead")
        _cache_save(fresh, name)
        return await run(fresh)


async def _serve_print_job(payload):
    """Validate one /api/print body and run it. Returns (http_status, body)."""
    try:
        raw = base64.b64decode(payload.get("data", ""), validate=True)
    except Exception:
        return 400, {"error": "data is not valid base64"}

    bpl    = payload.get("bpl")
    height = payload.get("height")
    if bpl != BPL:
        return 400, {"error": f"bpl must be {BPL}"}
    if not isinstance(height, int) or height < 1:
        return 400, {"error": "height must be a positive integer"}
    if len(raw) != bpl * height:
        return 400, {"error": f"data is {len(raw)} bytes, expected {bpl * height} "
                               f"({bpl} x {height})"}

    t0 = time.monotonic()

    async def go(addr):
        await _do_print(
            addr, raw, bpl, height,
            density=payload.get("density", 10),
            speed=payload.get("speed", 3),
            feed=payload.get("feed", 140),
            min_height=payload.get("minHeight", 64),
            invert=bool(payload.get("invert", False)),
            lines_per_frame=24,   # house default; bare _do_print falls back to 8
        )
        return 200, {"ok": True, "seconds": round(time.monotonic() - t0, 1)}

    return await _with_printer(go)


def _notify(message, title="TP6-S"):
    """A macOS notification, fired from HERE rather than from the caller.

    The print dialog's "Send to TP6-S" wrapper cannot show one: a job the
    print system launches is sandboxed, and osascript is denied the
    notification daemon (`deny mach-lookup com.apple.usernoted.daemon_client`,
    measured 2026-08-19). This helper runs from the user's terminal and has no
    such problem, so the process that knows the outcome is also the one that
    can say it out loud.
    """
    if platform.system() != "Darwin":
        return
    def esc(t):
        return t[:200].replace("\\", "\\\\").replace('"', '\\"')
    try:
        import subprocess
        subprocess.run(["/usr/bin/osascript", "-e",
                        f'display notification "{esc(message)}" with title "{esc(title)}"'],
                       timeout=10, capture_output=True)
    except Exception:
        pass


async def _serve_pdf_job(payload):
    """POST /api/pdf — a whole PDF, rendered and printed here.

    The print dialog's door. The wrapper macOS launches can read the spool
    PDF and open a socket to localhost, and that is the entire list — it
    cannot reach ~/.venvs to run python, cannot write ~/.config, and cannot
    post a notification. So it hands the bytes over and this helper, which is
    an ordinary process started from a terminal, does all of the work.

    See ARCHITECTURE.md for the supported print-dialog path.
    """
    import tempfile
    try:
        raw = base64.b64decode(payload.get("pdf", ""), validate=True)
    except Exception:
        return 400, {"error": "pdf is not valid base64"}
    if not raw.startswith(b"%PDF-"):
        return 400, {"error": "that is not a PDF"}
    title = str(payload.get("title") or "")[:80]

    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools"))
    import pdf_service

    if pdf_service.LOG is None:
        pdf_service.LOG = pdf_service._Log(echo=True)

    tmp = tempfile.mkdtemp(prefix="tp6s-pdf-")
    path = os.path.join(tmp, "job.pdf")
    t0 = time.monotonic()
    try:
        with open(path, "wb") as fh:
            fh.write(raw)
        print(f"[serve] /api/pdf {len(raw)} B" + (f"  '{title}'" if title else ""))
        try:
            data, height, pages = pdf_service.prepare(path)
        except pdf_service.Fail as e:
            _notify(str(e), "TP6-S — not printed")
            return 400, {"error": str(e)}

        async def go(addr):
            await _do_print(addr, data, BPL, height, density=10, speed=3, feed=140,
                            lines_per_frame=24)
            return 200, {}

        try:
            await _with_printer(go)
        except Exception as e:
            msg = str(e) or e.__class__.__name__
            if isinstance(e, _NoPrinter) or "not found" in msg.lower():
                msg = f"{msg}. {_HELD_LINK_HINT}"
            _notify(msg, "TP6-S — not printed")
            return 500, {"error": msg}

        secs = round(time.monotonic() - t0, 1)
        message = (f"{title + ': ' if title else ''}printed "
                   f"{pages} page{'s' if pages != 1 else ''}, {height} lines, {secs} s")
        _notify(message)
        return 200, {"ok": True, "pages": pages, "lines": height,
                     "seconds": secs, "message": message}
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


class _Tp6Handler(http.server.SimpleHTTPRequestHandler):
    """Serves web/ as static files, plus /api/status and /api/print."""

    server_version = "tp6s-helper/1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def end_headers(self):
        # Disable Chrome's in-memory script cache during local development.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        print(f"[serve] {self.address_string()} {fmt % args}")

    def _json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/status":
            addr, name = _cache_load()
            printer = {"name": name, "address": addr} if addr else None
            # `routes` is how the page knows this helper is new enough to take
            # Feed, Terminal and GATT as well as printing — an older one
            # answers without it, and the page keeps Web Bluetooth for those.
            self._json(200, {"ok": True, "busy": self.server.busy.locked(),
                              "printer": printer, "version": 3,
                              "routes": ["print", "feed", "raw", "gatt", "pdf"]})
            return
        if self.path == "/api/gatt":
            self._run(_serve_gatt())
            return
        if self.path == "/":
            self.path = "/tp6s.html"     # directory listing is not the point
        super().do_GET()

    # Every BLE route shares one lock and one event loop: the printer takes
    # one conversation at a time, so a Feed arriving mid-print gets a 409
    # rather than interleaving CUS frames into a job (which resets the
    # firmware's parser — see docs/PROTOCOL.md upstream).
    def _run(self, coro):
        if not self.server.busy.acquire(blocking=False):
            self._json(409, {"error": "busy"})
            coro.close()
            return
        try:
            status, body = self.server.worker.submit(coro)
        except Exception as e:
            # The terminal running the helper was showing a bare "500" for
            # what is usually a held link — the least useful place for the
            # answer to be missing. Say it in both directions.
            msg = str(e) or e.__class__.__name__
            if isinstance(e, _NoPrinter) or "not found" in msg.lower():
                msg = f"{msg}. {_HELD_LINK_HINT}"
            print(f"[serve] request failed: {msg}")
            status, body = 500, {"error": msg}
        finally:
            self.server.busy.release()
        self._json(status, body)

    def do_POST(self):
        routes = {"/api/print": _serve_print_job,
                  "/api/feed": _serve_feed_job,
                  "/api/raw": _serve_raw_job,
                  "/api/pdf": _serve_pdf_job}
        if self.path not in routes:
            self._json(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length > 64 * 1024 * 1024:
            self._json(413, {"error": "that body is too large"})
            return
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._json(400, {"error": "invalid JSON body"})
            return

        self._run(routes[self.path](payload))


def cmd_serve(port, open_browser=False):
    worker = _BleWorker()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), _Tp6Handler)
    server.busy   = threading.Lock()      # one print job at a time
    server.worker = worker
    print(f"Serving {WEB_DIR}")
    print(f"http://127.0.0.1:{port}/  (Ctrl-C to stop)")
    if open_browser:
        url = f"http://127.0.0.1:{port}/"
        threading.Timer(0.3, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping...")
    finally:
        server.server_close()
        worker.stop()


# ---------------------------------------------------------------------------
# Point d'entree
# ---------------------------------------------------------------------------

def _usage(exit_code=1):
    print(__doc__)
    sys.exit(exit_code)


def _split_addr(rest):
    """(address_or_None, remaining_args) — the address is optional now."""
    if rest and _looks_like_addr(rest[0]):
        return rest[0], rest[1:]
    return None, rest


def _need_addr(explicit):
    addr = asyncio.run(resolve_address(explicit))
    if addr is None:
        sys.exit(1)
    return addr


def main():
    args = sys.argv[1:]
    if not args:
        _usage()

    cmd = args[0]

    if cmd in ("help", "--help", "-h"):
        _usage(0)

    elif cmd == "scan":
        asyncio.run(cmd_scan())

    elif cmd == "forget":
        print("Forgot the remembered printer." if _cache_clear()
              else "No printer was remembered.")

    elif cmd == "serve":
        port = int(args[1]) if len(args) > 1 else 8776
        cmd_serve(port)

    elif cmd == "gui":
        port = int(args[1]) if len(args) > 1 else 8776
        cmd_serve(port, open_browser=True)

    elif cmd == "info":
        a, rest = _split_addr(args[1:])
        asyncio.run(cmd_info(_need_addr(a)))

    elif cmd == "uart":
        a, rest = _split_addr(args[1:])
        asyncio.run(cmd_uart(_need_addr(a)))

    elif cmd == "feed":
        a, rest = _split_addr(args[1:])
        lines = int(rest[0]) if rest else 85
        asyncio.run(cmd_feed(_need_addr(a), lines))

    elif cmd == "test":
        def _parse_cmds(flag):
            try:
                i = args.index(flag)
                return [int(x, 16) for x in args[i + 1].split(",")]
            except (ValueError, IndexError):
                return []
        def _parse_int_flag(flag):
            try:
                i = args.index(flag)
                return int(args[i + 1])
            except (ValueError, IndexError):
                return None
        def _parse_str_flag(flag, default=None):
            try:
                i = args.index(flag)
                return args[i + 1]
            except (ValueError, IndexError):
                return default
        before_cmds     = _parse_cmds("--before")
        after_cmds      = _parse_cmds("--after")
        lines_per_frame = _parse_int_flag("--lines")
        hdr_str         = _parse_str_flag("--hdr")     # None = default 6-byte
        cmd_str         = _parse_str_flag("--cmd")     # None = CMD_PRINT_IMAGE
        img_hdr_fn = _build_hdr_fn(hdr_str) if hdr_str is not None else None
        img_cmd    = int(cmd_str, 16) if cmd_str is not None else None
        # Exclure les flags ET leurs valeurs de la liste positionnelle
        flag_vals = set()
        for flag in ("--before", "--after", "--lines", "--hdr", "--cmd"):
            try:
                i = args.index(flag)
                if i + 1 < len(args):
                    flag_vals.add(args[i + 1])
            except ValueError:
                pass
        pos          = [a for a in args[1:] if not a.startswith("--") and a not in flag_vals]
        t_addr, pos  = _split_addr(pos)
        pattern      = pos[0] if len(pos) >= 1 else "black"
        bpl_override = int(pos[1]) if len(pos) >= 2 else None
        header_px    = "--px" in args
        asyncio.run(cmd_test_print(_need_addr(t_addr), pattern, bpl_override=bpl_override,
                                   header_px=header_px,
                                   before_cmds=before_cmds, after_cmds=after_cmds,
                                   lines_per_frame=lines_per_frame,
                                   img_cmd=img_cmd, img_hdr_fn=img_hdr_fn))

    elif cmd == "print" and len(args) >= 2:
        a, rest = _split_addr(args[1:])
        if not rest:
            _usage()
        asyncio.run(cmd_print_text(_need_addr(a), " ".join(rest)))

    elif cmd == "image" and len(args) >= 2:
        i_addr, i_rest = _split_addr(args[1:])
        _iflags = ("--threshold", "--rotate", "--density", "--speed",
                   "--lines", "--window")
        _iskip = set()
        for _f in _iflags:
            try:
                _j = i_rest.index(_f)
                if _j + 1 < len(i_rest):
                    _iskip.add(_j + 1)
            except ValueError:
                pass
        i_pos = [a for k, a in enumerate(i_rest)
                 if not a.startswith("--") and k not in _iskip]
        if not i_pos:
            _usage()
        path = i_pos[0]
        ext  = path.lower().rsplit('.', 1)[-1] if '.' in path else ''
        if ext == "pbm":
            asyncio.run(cmd_print_pbm(_need_addr(i_addr), path))
        else:
            def _parse_int_flag(flag, default=None):
                try:
                    i = args.index(flag)
                    return int(args[i + 1])
                except (ValueError, IndexError):
                    return default
            dither    = "--nodither" not in args
            threshold = _parse_int_flag("--threshold", 128)
            rotate    = _parse_int_flag("--rotate", 0)
            density   = _parse_int_flag("--density", 10)
            speed     = _parse_int_flag("--speed", 3)
            lines     = _parse_int_flag("--lines", 24)
            window    = _parse_int_flag("--window", 6)
            stream    = "--legacy" not in args
            asyncio.run(cmd_print_raster(_need_addr(i_addr), path,
                                         dither=dither, threshold=threshold,
                                         rotate=rotate,
                                         density=density, speed=speed,
                                         lines_per_frame=lines,
                                         window=window, stream=stream))

    else:
        _usage()


if __name__ == "__main__":
    main()
