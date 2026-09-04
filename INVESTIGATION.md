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

The host can enqueue near 11 KB/s while the printer consumes near 6 KB/s, so
a job can silently fill the printer's internal buffer. In August the failure
had appeared only above roughly 73 KB, and the transport switched strategy on
job size: fast barrier under that, every write acknowledged above it.

## The margin is not a size

On 2026-09-04 a 709-line, 51 KB page printed short three times out of four
at the fast interval — stopping a third of the way in, then two thirds, then
whole, then two thirds again — while a 1,008-line, 73 KB page (`fox.png`,
bigger and darker) printed whole between those runs. Same bytes every time;
voltage flat, temperature 70, battery 77–98%.

The status-frame timeline, stamped from the first write, showed what a short
print is. Delivery finished at 4.3 s. The printer's last frame, with its
flags byte changed from `0F` to `07`, came at 5.3 s — the moment two thirds
of the page ends at 90 lines/s. The printer had not stalled; it had run out
of lines. A frame cut midway ends the job rather than skipping a band, which
is why the page stops dead instead of missing a strip.

The same page kept 17 KB one run and 34 KB the next, so the buffer's margin
varies from job to job — most plausibly the printer beginning to consume at
different moments after the link comes up. That is the same flaw that sank
the earlier modelled-lead attempt, and it means no byte threshold is safe.

The production transport therefore no longer decides by job size. It bursts
a fixed head start at the fast interval to give the printer a cushion, then
holds delivery to a steady rate. The same page printed whole this way. Visible
pauses are preferable to silently missing output.

## The printer does say when it is empty

Acknowledging every write after the head start delivered 6.5 KB/s, and the
page still came out with six stutters. The timeline explained them. A 16 KB
head start is 2.5 s of paper; the first mid-print status frame arrived at
2.61 s, and one more with every stutter after. In a later run three stutters
were heard and three frames logged, to the tenth of a second. The August
note that streaming gets no per-frame signal stands, but it missed the one
that matters: **a status frame arriving mid-stream is the printer reporting
its buffer empty.** That is flow control, in the one direction that cannot
overflow.

Two more measurements fell out of the same afternoon:

- A fed printer at speed 3 eats **9 to 10 KB/s**, not 6.5: from the empty
  reports, 23 KB in its first 2.4 s and 28 KB in the next 3, the same on two
  pages of very different tone. (A first figure of 8 counted the paper feed
  as print time.)
- Ack patterns do not interpolate. Every write acknowledged is 6.5 KB/s and
  every other write 9.8 KB/s, but "two of every three" measured 6.7: the
  radio quantises acknowledged writes to its connection interval.

So the loop now paces by the clock. After the head start (12 KB, about 1.3 s
of paper), writes go out one-acknowledged-in-four with short sleeps holding
the average to an opening rate at the appetite (10 KB/s; 9.0 still left one
stutter per page, at 39–49 KB in). Each empty
report refills the cushion with another head-start-sized burst at the fast
interval and raises the rate half a KB/s. The lead only grows from a buffer
the printer has just said is empty, and the rate only rises after the printer
has proved it can eat faster, so the surplus is never more than one step.
A page whose appetite the opening rate cannot meet stutters once, not once a
second.

Verified on a long job the same day: a 2,400-line, 172 KB test strip of
numbered bands, alternating grey wash and line art, with two crossing
diagonals down its full length. It printed whole with both diagonals
unbroken, two stops heard (lines ~1070 and ~1680, both in the log as empty
reports). Delivery averaged 9.5 KB/s against a requested 11: the loop was
saturated against the radio, and the printer, eating a little over 10, caught
up every five seconds or so. On this link the remaining stutter on long jobs
is the radio's ceiling, not a pacing number. Whether a barrier above 8 raises
that ceiling is unmeasured.

The refill burst is worth less than it looks: the fast barrier is only about
12 KB/s, so against a printer eating 10 it nets a couple of KB of cushion.
The head start, delivered before the printer gets going, is the cushion that
counts; after it the rate step does the work.

A frame also arrives at about 5.2 s after the first write in nearly every
run, whatever the delivery is doing at the time, often carrying a lower
voltage. It is probably a heartbeat, not an empty report. On a job still
streaming at that moment the loop answers it with one unneeded burst and a
half-KB/s step, which is bounded; a page of this size has finished delivery
by then.

One observation, one sample: on the fox print during which the paper ran
out, the final status frame carried `81` in the fourth payload byte where
every other frame that day carried `90`. Possibly the paper-out flag.

The speed value is not a throughput dial. Fox at speed 2 ate the same
10 KB/s and finished in the same time as at speed 3, and printed audibly
smoother; speed 2 is the house default from 2026-09-04. Speeds 1, 4 and 5
are unmeasured.

The one case with no signal is a printer much slower than the opening rate
on a long job: the surplus accumulates unreported. `TP6S_PACE_KBS` sets the opening rate,
`TP6S_HEAD_KB` the cushion, and `TP6S_BARRIER` forces one interval for the
whole job, for measuring.

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
3. Print a job of about 700 lines from a printer that has sat idle, and
   confirm it reaches the bottom; then again immediately, warm.
4. Print a job above 1,845 lines carrying numbered bands and a full-length
   diagonal, and inspect the diagonal for a break.
5. Record elapsed time, byte count, line count, barrier count, voltage and
   temperature.

When changing raster behaviour, compare the packed raster as well as the
screen preview, then verify the result on paper. A successful API call is not
evidence that every physical line printed.
