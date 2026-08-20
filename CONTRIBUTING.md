# Contributing

Changes are welcome, especially reports from TP6-labelled printers with
different firmware. Keep measured behaviour separate from inference and state
which hardware and macOS version produced a result.

## Development setup

```bash
git clone https://github.com/elwinloomis/tp6s-mac.git
cd tp6s-mac
./setup.sh
bash tools/check.sh
```

Use `./setup.sh --pdf` when changing PDF preparation or the macOS PDF Service.
Use `./setup.sh --research` for the Bluetooth Classic experiment.
The browser application has no build step. Node is used only for syntax and
the off-hardware BLE lifecycle test.

## Before changing transport code

Read `ARCHITECTURE.md` and the relevant measurement in `INVESTIGATION.md`.
The invariants are part of correctness:

- only one printer conversation at a time;
- connect, perform one operation, disconnect;
- never retry after output may have begun;
- preserve exactly 72 raster bytes per line;
- retain the barrier and long-job pacing rules; and
- do not make the unauthenticated helper reachable beyond loopback.

## Extension points

### Add a CLI command

Implement an `async def cmd_*` function in `tp6s_tool.py`, then add its branch
to `main()`. Resolve the printer through `_need_addr()` or `_with_printer()`
instead of duplicating discovery. Commands that write CUS data should use
`_make_frame()` and the existing connection lifecycle.

### Add or change a CUS command

Keep the Python constants and `web/src/protocol.js` in agreement. A CUS frame
is `64 cmd seq len-lo len-hi payload 00 00 00 00 9B`; image command `0x00`
contains raw packed raster bytes. Add a pure parser/framing assertion to
`tools/ble_sim_test.js` or a new off-hardware test before using paper.

### Add a helper route

Create a validating `_serve_*` coroutine in `tp6s_tool.py` and register it in
`_Tp6Handler`. Printer operations must pass through the server's one-job lock.
Document the JSON request and response in `web/README.md`. The helper binds to
`127.0.0.1` and is unauthenticated; do not expose it to a network interface
without authentication, `Origin`/`Host` validation and appropriate tests.

### Add a browser mode

The HTML controls live in `web/tp6s.html`; coordination and state live in
`web/src/app.js`. Put reusable rendering or state logic in the focused module
under `web/src/` and expose it through `window.TP6`. A printable job has:

```text
{ data: Uint8Array, bpl: 72, height: positive integer }
```

Add document capture/apply handling if the mode creates user work. Test save,
open, autosave, missing fonts, narrow and wide layouts, and the packed preview.

### Change PDF preparation

Keep raster conversion in `tp6s_tool.prepare_raster()` rather than creating a
second image pipeline. Exercise `tools/pdf_service.py --out` before printing,
then test portrait, landscape, multiple pages, transparency and the 12,000-line
limit.

## Verification

Run the complete off-hardware check:

```bash
bash tools/check.sh
```

Transport and raster changes also require physical verification. Record the
printer label/firmware if known, macOS version, line and byte counts, elapsed
time, barrier setting, and whether the whole middle of a long print survived.
A successful Bluetooth write is not proof that every line reached paper.

## Pull-request checklist

- User-facing behaviour is documented in `README.md` or `web/README.md`.
- Architecture or measured findings are updated when their claims change.
- `bash tools/check.sh` passes.
- No device address, hostname, absolute home path, spool document or secret is
  committed.
- Hardware-dependent claims identify what was actually tested.
