# Reproducible findings

This document preserves the measurements that explain the toolkit's unusual
transport and raster choices. It intentionally omits session history and
superseded implementation plans. Utilities used to obtain these results are
in `research/`; they are diagnostic programs, not supported user commands.

Results below describe one Vretti TP6-S firmware and the tested Macs. Treat
them as model-specific until reproduced on other hardware.

## Frame format

Every CUS command uses the frame produced by the working Python and browser
implementations:

```text
64  <cmd>  <seq6>  <len16-le>  <payload>  00 00 00 00  9B
```

The sequence increments per command and wraps after 63. The four bytes before
the trailer occupy a checksum field but are zero in observed vendor traffic
and accepted as zero by the tested firmware.

The production image command is `0x00`. Its payload contains raw packed raster
bytes with no additional image header:

```text
<72 bytes for line 1> <72 bytes for line 2> ...
```

For this printer each frame payload must contain exactly `lines × 72` bytes,
with up to 24 lines per frame. Pixels are packed most-significant bit first.
The research utilities can inject experimental headers, but the supported
transport does not use one.

## Why ACK gating stutters

The first BLE implementation sent a small number of image frames and then
waited for an acknowledgement. Measurements across several frame sizes fit:

```text
cost per frame ≈ 140 ms + 15.7 ms × lines
```

The fixed component is the acknowledgement round trip. Smaller frames
therefore amplify overhead, while a larger outstanding window eventually
risks data loss instead of providing useful flow control.

The browser route was measured at about 1.74 KB/s. The printer consumes near
6 KB/s, so its buffer repeatedly empties and the motor stops. Changing image
content, inserting small inter-chunk pauses and increasing the window did not
remove the transport ceiling.

## Stream plus barrier

The reliable Python path writes the job without response, awaiting each local
enqueue operation, and periodically issues a write with response as a
barrier. This reached roughly 10.5–11 KB/s on the tested Macs and printed a
12-block, 288-line staircase continuously.

The barrier is not a per-frame acknowledgement. It establishes that the
preceding controller queue has drained far enough to bound outstanding data.
Image frame size therefore stops dominating throughput; 24 lines per frame is
the current default.

Useful reproduction programs:

- `research/ble_stream.py` compares streamed and response-gated BLE writes.
- `research/frame_ab.py` varies frame headers and line counts.
- `research/stair.py` prints repeated blocks while changing window settings.

## The long-job buffer limit

A smooth motor is not proof that every line arrived. A 1,845-line job of
about 133 KB lost a visible band from its middle even though:

- the BLE writes completed normally;
- the barrier completed normally;
- voltage stayed near 1.94–1.96;
- reported temperature stayed at 70; and
- the motor did not pause.

The failure appeared only above roughly 73 KB on the tested printer. The host
can enqueue near 11 KB/s while the printer consumes near 6 KB/s, so a long job
can silently fill the printer's internal buffer.

The production transport therefore changes strategy by job size. Short jobs
use the fast barrier interval. Above roughly 1,000 dot-lines, the interval is
reduced and delivery is paced toward the printer's drain rate. Visible pauses
are preferable to silently missing output.

## Bluetooth Classic SPP

The Android vendor application uses Bluetooth Classic RFCOMM for printing.
Decompilation showed the same CUS image frames written to an output stream;
RFCOMM provides pacing, so the application does not implement the BLE-style
ACK window.

`research/spp_print.py` reproduced smooth printing from macOS after Classic
pairing. SPP is useful evidence about the protocol but is not the supported
path: pairing is manual, macOS APIs are platform-specific, and BLE already
provides the required quality through the streamed transport.

## Command observations

- `0x00` is the image command.
- `0x02` feeds paper forward.
- `0x04` corresponds to reverse feed in the vendor application and carries a
  two-byte little-endian amount. It was identified from disassembly rather
  than exercised on paper.
- `0x80`, described elsewhere as a token query, produced no response on the
  tested firmware. See `research/token_probe.py`.

These notes document interoperability facts, not a complete protocol
specification. The upstream
[`docs/PROTOCOL.md`](https://github.com/Thaolia/tp6-thermal_printer/blob/main/docs/PROTOCOL.md)
is the broader reference.

## Raster and preview findings

The packed print raster was sharper than the original on-screen preview. The
preview had been enlarged with browser smoothing enabled, producing soft or
jagged-looking type that was not present in the one-bit data. The application
now renders print pixels with nearest-neighbour scaling.

Transparency must be composited onto white before conversion. Directly
converting black artwork on a transparent background treats transparent
pixels as black and can produce a solid page.

Physical type specimens favoured bold, monoline and deliberately irregular
faces. Fine regular-weight faces are more visibly damaged by thermal bloom.
The specimen generator and output are in `research/`.

## PDF preparation

Print-dialog PDFs are rendered at 2,304 dots wide before trimming and final
downscaling. Rendering directly at 576 dots loses fine text before the
halftone stage.

Measured rules:

- Trim near-white outer margins before scaling.
- Use one scale for every page in a document.
- Decide rotation from the source page orientation, not the trimmed ink.
- Composite transparency onto white.
- Choose thresholding or dithering per page based on tone content.
- Reject output above 12,000 dot-lines.

## Embedded image documents

Images stored in browser documents are re-encoded on a transparent canvas.
This preserves alpha through save and reopen. A missing-font check accompanies
the document so a page does not silently substitute typography on another
machine.

The browser saves source images rather than repeatedly transformed previews;
crop and rotation remain reversible until final rasterisation.

## Reproduction checklist

When changing transport behaviour, test in this order:

1. Run `node tools/ble_sim_test.js` without hardware.
2. Print the generated staircase with short and long barrier intervals.
3. Print a job below 1,000 lines and confirm continuous motion.
4. Print a job above 1,845 lines and inspect the entire middle for omissions.
5. Record elapsed time, byte count, line count, barrier count, voltage and
   temperature.

When changing raster behaviour, compare the packed raster as well as the
screen preview, then verify the result on paper. A successful API call is not
evidence that every physical line printed.
