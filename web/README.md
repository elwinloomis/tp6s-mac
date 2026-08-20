# Browser application

`web/tp6s.html` is a dependency-free browser workspace for creating
576-dot-wide thermal-printer pages. It works in two modes:

- `./tp6 gui` serves it from the local Python helper and routes printer
  operations through the fast bleak transport.
- Opening `tp6s.html` directly uses Web Bluetooth in Chrome or Edge. This
  fallback needs no Python but prints more slowly.

## Run it

From the repository root:

```bash
./tp6 gui
```

For static development without the helper:

```bash
./web/serve.sh
```

The page is plain HTML, CSS and JavaScript. There is no build step and no
package installation.

## Modes

- **Quote** lays out a quotation and attribution with print-aware type.
- **Image** crops, scales and halftones an imported image.
- **Compose** places pictures and text freely on a growing 576-dot page.
- **Test** generates calibration patterns.
- **Terminal** sends diagnostic CUS frames when a printer route is available.

Modes that create pages support document save/open and per-mode autosave when
browser storage is available.

## Source map

| File | Responsibility |
|---|---|
| `tp6s.html` | Application shell and controls |
| `style.css` | Layout, responsive behaviour and print-pixel preview |
| `src/app.js` | State, mode coordination and commands |
| `src/ble.js` | Web Bluetooth transport and link lifecycle |
| `src/protocol.js` | CUS framing and command encoding |
| `src/raster.js` | Thresholds, dithers and one-bit packing |
| `src/compose.js` | Free-form page objects and interaction |
| `src/card.js` | Quote-card layout |
| `src/doc.js` | Document envelope, autosave and missing-font checks |
| `src/ui.js` | Shared UI helpers |

Scripts are loaded in dependency order by `tp6s.html` and share the `TP6`
namespace. Keeping the application build-free is deliberate: the file can be
opened directly and remains easy to inspect.

## Raster pipeline

The canvas is 576 pixels wide. Imported transparency is preserved while
editing and composited onto white only for final one-bit conversion. Four
halftone choices are available:

- Threshold for line art and already-binary images.
- Floyd–Steinberg for photographic tone.
- Atkinson for a lighter, more open diffusion pattern.
- Ordered 8×8 dithering for stable flat tints.

The preview is drawn from the same packed bits sent to the printer and scaled
with image smoothing disabled. This keeps screen defects distinct from raster
defects.

## Documents

Saved documents use a JSON envelope containing a version, mode and mode data.
Embedded images are represented as data URLs and recreated as fresh object
URLs when opened. Compose stores original image sources plus reversible crop,
position, scale and rotation data.

Autosave is per mode and never overwrites non-empty live work on initial
load. Direct `file://` pages may not receive browser storage; explicit
document save still works.

## Printer routes

When served by `./tp6 gui`, the page probes `/api/status`. A compatible
helper owns all printer operations. POST bodies are JSON; binary raster and
PDF data are base64 strings.

| Route | Purpose |
|---|---|
| `GET /api/status` | Helper version, busy state, remembered printer and supported routes |
| `POST /api/print` | Print a packed one-bit raster |
| `POST /api/feed` | Advance paper |
| `POST /api/raw` | Send one diagnostic frame |
| `GET /api/gatt` | Inspect services and characteristics |
| `POST /api/pdf` | Prepare and print a complete PDF for the macOS PDF Service |

Request contracts:

```text
POST /api/print  {data, bpl:72, height, density?, speed?, feed?, minHeight?, invert?}
POST /api/feed   {lines:1..255}
POST /api/raw    {hex, listen?:0.2..5.0}
POST /api/pdf    {pdf, title?}
```

Successful responses contain `ok:true` plus route-specific fields. Failures
contain `error`; a `409` means another job owns the printer. `/api/print`
returns elapsed seconds, `/api/raw` returns received notification hex,
`/api/gatt` returns service/characteristic records, and `/api/pdf` returns
page, line and timing totals.

The helper is deliberately bound to `127.0.0.1`. It has printer-control and
raw-command routes but no user authentication, so do not change it to listen
on a LAN interface without first adding authentication and origin checks.

Without the helper, `src/ble.js` discovers devices whose advertised name
begins with `TP6`, locates the FFF0/FFF2 write characteristic, and sends CUS
frames through Web Bluetooth.

Every route follows the same ownership rule: connect for one operation and
disconnect afterward. The printer accepts only one Bluetooth link, so a tab
that retains the connection would block the CLI and local helper.

## Development checks

Run all off-hardware syntax, framing and lifecycle checks with:

```bash
bash tools/check.sh
```

For visual changes, exercise every mode at narrow and wide window sizes,
save and reopen a document, and compare the packed preview before printing.
Transport changes also require paper tests; successful Bluetooth writes do
not detect the printer's long-job buffer overflow.
