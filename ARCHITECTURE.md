# Architecture

This document describes the supported runtime paths and the rules that keep
printing reliable. Historical experiments live in `INVESTIGATION.md` and
unsupported measurement programs live in `research/`.

## Supported paths

All four entry points eventually produce a 576-dot-wide, one-bit raster.

1. `./tp6 gui` serves the browser workspace from `127.0.0.1:8776`. The page
   composes the raster and the Python helper sends it over BLE.
2. `./tp6 print`, `./tp6 image` and `./tp6 feed` use the Python BLE transport
   directly.
3. `Send to TP6-S` receives a PDF from the macOS print dialog and posts it to
   the running helper for rasterisation and printing.
4. `web/tp6s.html` can use Web Bluetooth without Python. This fallback is
   functional but slower than the Python transport.

The printer accepts one Bluetooth connection at a time. Every path therefore
follows the same lifecycle: resolve the printer, connect, perform one job and
disconnect. Jobs are never interleaved and the helper never holds an idle
connection.

## Raster pipeline

The print head is 576 dots, or 72 bytes, wide. Images are composited onto
white before conversion, resized to 576 pixels, thresholded or dithered, and
packed most-significant bit first. Each image frame contains exactly
`lines × 72` payload bytes.

PDF pages are rendered at high resolution, trimmed, scaled consistently and
stacked. Page rotation follows the source page orientation, not the bounding
box of visible ink. PDF Service jobs over 12,000 dot-lines are rejected; the
CLI and browser use roll-style pages without that PDF-specific guard.

## Transport

Chrome Web Bluetooth delivers about 1.74 KB/s on the tested hardware. Python
with bleak can enqueue about 11 KB/s, while the printer consumes roughly
6 KB/s. The Python path streams writes without response and periodically uses
a write-with-response barrier. For jobs above roughly 1,000 lines it also
paces delivery so the printer's internal buffer cannot silently overflow.

Density 10, speed 3 and 24 lines per image frame are the tested defaults.
These are empirical settings rather than protocol requirements.

## Printer discovery and local state

Resolution order is: an explicit address, `TP6S_ADDR`, the remembered device,
then a scan for a unique device whose name begins with `TP6`. On macOS the BLE
identifier is host-specific, so it is stored outside the repository in
`~/.config/tp6s/device.json`. `./tp6 forget` removes it.

The Python environment is likewise machine-specific and lives at
`~/.venvs/tp6s`. `setup.sh` creates the base environment; `setup.sh --pdf`
adds the optional Quartz dependency. Exact tested versions are pinned in
`requirements.txt`, `requirements-pdf.txt` and `requirements-research.txt`.

## Source map

- `tp6s_tool.py` — CLI, raster preparation, BLE transport and local helper.
- `tools/pdf_service.py` — PDF preparation and print-dialog worker.
- `tools/install_pdf_service.sh` — installs or removes the macOS PDF Service.
- `web/tp6s.html`, `web/style.css` — application shell and presentation.
- `web/src/` — composition, documents, rasterisation, BLE and UI modules.
- `tools/ble_sim_test.js` — off-hardware BLE lifecycle regression test.
- `tools/check.sh` — syntax, framing and BLE lifecycle checks.
- `research/` — unsupported hardware experiments and generated specimens.
- `CONTRIBUTING.md` — extension recipes and hardware-test expectations.

## Reliability invariants

- One printer conversation at a time.
- Connect, work, disconnect; never retain an idle BLE link.
- Never retry after bytes may have reached the printer, which could duplicate
  physical output.
- Composite transparency onto white before one-bit conversion.
- Use a periodic response barrier and pace long jobs.
- Treat hardware measurements as model-specific until reproduced elsewhere.
