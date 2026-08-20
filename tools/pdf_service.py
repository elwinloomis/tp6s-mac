#!/usr/bin/env python3
"""
pdf_service.py — the "Send to TP6-S" item in every Mac app's print dialog.

macOS PDF Services: an executable dropped in ~/Library/PDF Services/ appears
in the PDF popup of the standard print dialog, and its FILENAME is the menu
label. The print system renders the document to a spool PDF and hands us the
path. This script turns that PDF into 576-dot lines and prints them through
the transport the rest of this project already uses.

    Print… -> PDF v -> Send to TP6-S          (two clicks, any app)

Install with tools/install_pdf_service.sh. Design rules are in
ARCHITECTURE.md; transport measurements are in INVESTIGATION.md.

It is a fourth door into the same room. The dots come from tp6s_tool's
prepare_raster and the bytes go out over tp6s_tool's streamed BLE path, so a
page printed from the print dialog is the same page `./tp6 image` would print.

Two routes out, tried in this order:

  helper — POST to the ./tp6 gui helper on 127.0.0.1:8776. Preferred, because
           a localhost POST needs no Bluetooth permission: the helper already
           holds a blessed one from the terminal that started it. It also
           shares the one job lock, so a print landing mid-job gets a clean
           409 instead of interleaving CUS frames.
  direct — connect over BLE from this process. Fine from a terminal; not
           available to the print dialog, which cannot start python at all.

NOTE ON WHO RUNS THIS. When the print dialog is the caller, this file does
NOT run in the process macOS launches — that one is sandboxed out of
~/.venvs and cannot start python. It posts the PDF to the helper on
127.0.0.1 instead, and the helper imports prepare() from here. This file is
still the whole pipeline; only the doorway moved. See ARCHITECTURE.md for the
supported print-dialog path.

Nobody is watching a terminal when this runs, so every outcome ends in a
macOS notification AND a line in the first writable log of several
candidates, AND a line in the unified log under the tag TP6S. A silent
failure here is indistinguishable from the print system eating the job.

Run it by hand for testing:

    ./setup.sh --pdf
    ~/.venvs/tp6s/bin/python tools/pdf_service.py --out /tmp/page.png doc.pdf
    ~/.venvs/tp6s/bin/python tools/pdf_service.py --route helper doc.pdf
    ~/.venvs/tp6s/bin/python tools/pdf_service.py --probe anything

Options are for testing only. From the print dialog there is no UI, and the
house settings (density 10, speed 3, 24-line frames, feed 140) are what runs.
"""

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

# --- measured rendering and output limits ----------------------------------

PRINT_W      = 576        # the head, in dots. tp6s_tool agrees; asserted below.
SUPER        = 4          # render at 4x the head and let LANCZOS do the rest.
                          # The plan's 1600-2600 px window, rounded to a whole
                          # multiple so the downscale is a clean supersample.
BORDER       = 6          # white dots kept around each page's content
SUPER_W      = PRINT_W * SUPER                    # 2304, the content width
CANVAS_W     = (PRINT_W + 2 * BORDER) * SUPER     # 2352, content plus border
SCAN_SCALE   = 1.5        # pass 1 is only looking for where the ink is
PAGE_GAP     = 60         # white dot-lines between stacked pages (final scale)
MAX_LINES    = 12000      # ~1 m of paper. Refuse rather than print a novel.
MIN_INK_U    = 4.0        # page units; below this a "page" is a speck, not ink
MAX_ENLARGE  = 1.6        # how much bigger than the whole page may trimmed
                          # content print? Trimming a normal letter page is
                          # about 1.2x, so this changes nothing there — it is
                          # here for the page holding one short line, which
                          # would otherwise be enlarged 20x and eat a foot of
                          # paper saying "One short line."

NEAR_WHITE   = 246        # anything lighter counts as paper, not ink
MIDTONE_LO   = 32         # the flat-art test: how much of the page is neither
MIDTONE_HI   = 223        # black nor white. See looks_flat().
FLAT_MIDTONE = 0.10
FLAT_TONES   = 48         # the web tool's rule, logged alongside for comparison

HELPER_URL   = "http://127.0.0.1:8776"
HELPER_PROBE_TIMEOUT = 1.0
HELPER_PRINT_TIMEOUT = 600.0

DENSITY, SPEED, FEED, LINES_PER_FRAME = 10, 3, 140, 24   # house settings

# Where the log may live, in order of preference. More than one candidate
# because **the print system runs us in a sandbox**: measured on Darwin 25,
# a job launched from the print dialog is denied `file-write-create` in
# ~/.config/tp6s (and in printtool's own group container), while its TMPDIR,
# /tmp and ~/Desktop all succeed. Hard-coding the first one is what made the
# first print look like nothing had happened at all.
def _log_candidates():
    home = os.path.expanduser("~")
    cfg  = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
    out  = [os.environ.get("TP6S_LOG"),
            os.path.join(cfg, "tp6s", "pdf-service.log"),
            os.path.join(home, "Library", "Logs", "tp6s-pdf-service.log"),
            os.path.join(os.environ.get("TMPDIR") or "/tmp", "tp6s-pdf-service.log"),
            "/tmp/tp6s-pdf-service.log"]
    return [c for c in out if c]

LOG_MAX   = 1_000_000


# ---------------------------------------------------------------------------
# Saying things, when there is nobody to say them to
# ---------------------------------------------------------------------------

class _Log:
    """Everything goes to the log file. Also to stdout when a human ran us.

    tp6s_tool talks by print()ing, and that commentary (which frame, what MTU,
    how many lines) is the only diagnosis available for a job the print system
    launched — so stdout is redirected here rather than thrown away.
    """

    def __init__(self, echo):
        self.echo = echo
        self.fh = None
        self.path = None
        for cand in _log_candidates():
            try:
                os.makedirs(os.path.dirname(cand), exist_ok=True)
                if os.path.exists(cand) and os.path.getsize(cand) > LOG_MAX:
                    with open(cand, "rb") as fh:
                        fh.seek(-LOG_MAX // 2, os.SEEK_END)
                        tail = fh.read()
                    with open(cand, "wb") as fh:
                        fh.write(b"[log truncated]\n" + tail)
                self.fh = open(cand, "a", encoding="utf-8", errors="replace")
                self.path = cand
                break
            except OSError:
                continue            # denied or missing: try the next one
        self._pending = ""
        # The unified log needs no writable directory at all, so it is the one
        # channel a sandbox cannot take away. Announce where the real log went
        # (or that there is none) so the trail can always be picked up with:
        #   log show --last 30m --predicate 'eventMessage CONTAINS "TP6S:"' 
        self.syslog(f"log -> {self.path or 'NOWHERE WRITABLE'}")

    def syslog(self, msg):
        try:
            subprocess.run(["/usr/bin/logger", "-t", "TP6S", "--",
                            f"TP6S: {msg}"[:900]],
                           timeout=5, capture_output=True)
        except Exception:
            pass

    def write(self, s):             # stdout/stderr replacement
        if self.echo:
            sys.__stdout__.write(s)
        self._pending += s
        while "\n" in self._pending:
            line, self._pending = self._pending.split("\n", 1)
            self._raw(line)

    def flush(self):
        if self._pending:
            self._raw(self._pending)
            self._pending = ""
        if self.echo:
            sys.__stdout__.flush()

    def _raw(self, line):
        if self.fh:
            try:
                self.fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {line}\n")
                self.fh.flush()
            except OSError:
                pass

    def line(self, msg):
        self.flush()
        if self.echo:
            sys.__stdout__.write(msg + "\n")
        self._raw(msg)


LOG = None


def notify(message, title="TP6-S"):
    """The only UI this feature has."""
    def esc(s):
        # Trim first, escape second: cutting after escaping can leave a lone
        # trailing backslash and AppleScript then refuses the whole line.
        return s[:200].replace("\\", "\\\\").replace('"', '\\"')
    try:
        subprocess.run(
            ["/usr/bin/osascript", "-e",
             f'display notification "{esc(message)}" with title "{esc(title)}"'],
            timeout=10, capture_output=True)
    except Exception as e:                      # notification failure is not fatal
        LOG.line(f"(notification failed: {e})")


class Fail(Exception):
    """Something the user should be told about, in words they can act on."""


# ---------------------------------------------------------------------------
# PDF -> pixels, via Quartz
# ---------------------------------------------------------------------------

def _quartz():
    try:
        import Quartz
        from CoreFoundation import CFURLCreateFromFileSystemRepresentation, kCFAllocatorDefault
    except ImportError:
        raise Fail("pyobjc-framework-Quartz is missing — run ./setup.sh")
    return Quartz, CFURLCreateFromFileSystemRepresentation, kCFAllocatorDefault


def open_pdf(path):
    Quartz, cfurl, alloc = _quartz()
    url = cfurl(alloc, path.encode("utf-8"), len(path.encode("utf-8")), False)
    doc = Quartz.CGPDFDocumentCreateWithURL(url)
    if doc is None:
        raise Fail("that PDF could not be opened")
    n = Quartz.CGPDFDocumentGetNumberOfPages(doc)
    if not n:
        raise Fail("that PDF has no pages")
    if Quartz.CGPDFDocumentIsEncrypted(doc) and not Quartz.CGPDFDocumentIsUnlocked(doc):
        raise Fail("that PDF is password-protected")
    return doc, n


def page_box(page):
    """(width, height) in page units, with /Rotate already applied."""
    Quartz, _, _ = _quartz()
    box = Quartz.CGPDFPageGetBoxRect(page, Quartz.kCGPDFCropBox)
    w, h = box.size.width, box.size.height
    if not w or not h:
        box = Quartz.CGPDFPageGetBoxRect(page, Quartz.kCGPDFMediaBox)
        w, h = box.size.width, box.size.height
    if Quartz.CGPDFPageGetRotationAngle(page) % 180:
        w, h = h, w
    return w, h


def render(page, scale, crop=None):
    """Rasterize one page to a PIL 'L' image.

    `crop` is (x, y, w, h) in *page units*, measured from the TOP-left — the
    same corner PIL measures from, so the two passes speak one language.
    Anything outside the page renders as white, which is how the safety
    border around trimmed content comes for free.
    """
    from PIL import Image
    Quartz, _, _ = _quartz()

    pw, ph = page_box(page)
    cx, cy, cw, ch = crop if crop else (0.0, 0.0, pw, ph)
    out_w = max(1, int(round(cw * scale)))
    out_h = max(1, int(round(ch * scale)))

    cs  = Quartz.CGColorSpaceCreateDeviceGray()
    bpr = out_w                                     # 8-bit gray, no padding
    ctx = Quartz.CGBitmapContextCreate(None, out_w, out_h, 8, bpr, cs,
                                       Quartz.kCGImageAlphaNone)
    if ctx is None:
        raise Fail(f"could not make a {out_w}x{out_h} canvas for a page")

    Quartz.CGContextSetGrayFillColor(ctx, 1.0, 1.0)
    Quartz.CGContextFillRect(ctx, Quartz.CGRectMake(0, 0, out_w, out_h))
    Quartz.CGContextSetInterpolationQuality(ctx, Quartz.kCGInterpolationHigh)
    Quartz.CGContextSetShouldAntialias(ctx, True)

    # Quartz measures y upward from the bottom; crop is given from the top.
    Quartz.CGContextTranslateCTM(ctx, -cx * scale,
                                 -((ph - (cy + ch)) * scale))
    Quartz.CGContextScaleCTM(ctx, scale, scale)
    # Maps the page (including its /Rotate) into a pw x ph box at the origin.
    Quartz.CGContextConcatCTM(ctx, Quartz.CGPDFPageGetDrawingTransform(
        page, Quartz.kCGPDFCropBox, Quartz.CGRectMake(0, 0, pw, ph), 0, True))
    Quartz.CGContextDrawPDFPage(ctx, page)
    Quartz.CGContextFlush(ctx)

    img = Quartz.CGBitmapContextCreateImage(ctx)
    data = Quartz.CGDataProviderCopyData(Quartz.CGImageGetDataProvider(img))
    stride = Quartz.CGImageGetBytesPerRow(img)
    return Image.frombytes("L", (out_w, out_h), bytes(data), "raw", "L", stride, 1)


def ink_box(img):
    """Where the ink is, in pixels — or None for a blank page."""
    return img.point(lambda p: 255 if p < NEAR_WHITE else 0).getbbox()


# ---------------------------------------------------------------------------
# The pipeline
# ---------------------------------------------------------------------------

def looks_flat(img):
    """Threshold or dither? Decided by how much of the page is grey.

    The web tool separates flat art from photographs by counting distinct
    tones (<= 48 means flat), but that rule was written for *source* pictures.
    A rasterized PDF of plain text has hundreds of distinct tones — every one
    of them an antialiasing fringe one pixel wide — so counting them calls a
    TextEdit note a photograph and dithers it into fuzz.

    What actually separates the two cases is how MUCH of the page is neither
    black nor white. Text and line art are bimodal with a thin grey seam;
    a photograph is mostly seam. Both numbers are logged so the call can be
    second-guessed from the log.

    Ask it of the SUPERSAMPLED page, never of the 576-wide one. Measured on
    Apple's own License.pdf: 4.6% mid-grey at 2352 dots, 20.0% at 576 — the
    downscale turns every stroke into a grey smear and makes a page of plain
    text look exactly like a photograph. Asked at the right resolution the
    two cases are nowhere near each other.
    """
    hist = img.histogram()
    total = sum(hist) or 1
    mid = sum(hist[MIDTONE_LO:MIDTONE_HI + 1]) / total
    tones = sum(1 for c in hist if c)
    LOG.line(f"Tone: {mid * 100:.1f}% mid-grey, {tones} distinct "
             f"(flat if mid < {FLAT_MIDTONE * 100:.0f}%)")
    return mid < FLAT_MIDTONE


def plan_pages(doc, n_pages):
    """Pass 1: find each page's ink, and decide the one scale they share.

    Every page is scaled by the SAME factor, chosen so the widest page fills
    the head. Scaling each page independently would make a page holding one
    short line print in letters an inch tall next to a full page in letters
    a dot tall, and a document would stop looking like a document.

    The quarter turn is decided by the PAGE's shape, never by the ink's. A
    page of ordinary text with only four lines on it has an ink box wider
    than it is tall, and turning that is nonsense — the lines would run down
    the roll sideways. Landscape is something the author chose about the
    page, so the page is what to ask.
    """
    Quartz, _, _ = _quartz()
    pages = []
    for i in range(1, n_pages + 1):
        page = Quartz.CGPDFDocumentGetPage(doc, i)
        if page is None:
            continue
        pw, ph = page_box(page)
        turn = pw > ph          # a landscape page: long edge down the roll
        scan = render(page, SCAN_SCALE)
        bb = ink_box(scan)
        if bb is None:
            LOG.line(f"Page {i}: blank — dropped")
            continue
        x0, y0, x1, y1 = (v / SCAN_SCALE for v in bb)
        w_u, h_u = x1 - x0, y1 - y0
        if w_u < MIN_INK_U and h_u < MIN_INK_U:
            LOG.line(f"Page {i}: {w_u:.1f}x{h_u:.1f} units of ink — dropped as noise")
            continue
        LOG.line(f"Page {i}: {pw:.0f}x{ph:.0f} units, ink "
                 f"{w_u:.0f}x{h_u:.0f} at ({x0:.0f},{y0:.0f})"
                 f"{'  [landscape, turning 90°]' if turn else ''}")
        pages.append({"page": page, "n": i, "crop": (x0, y0, w_u, h_u), "turn": turn,
                      "w_u": h_u if turn else w_u, "h_u": w_u if turn else h_u,
                      "ref_w": ph if turn else pw})
    if not pages:
        raise Fail("every page came out blank — nothing to print")

    widest = max(p["w_u"] for p in pages)
    ref    = max(p["ref_w"] for p in pages)
    scale  = min(SUPER_W / widest, MAX_ENLARGE * SUPER_W / ref)
    lines  = sum(int(round((p["h_u"] * scale + 2 * BORDER * SUPER) / SUPER))
                 for p in pages) + PAGE_GAP * (len(pages) - 1)
    return pages, scale, lines


def build_page_image(spec, scale):
    """Pass 2: render just the ink, turned, with its white border."""
    border = BORDER * SUPER / scale                      # dots -> page units
    x, y, w, h = spec["crop"]
    img = render(spec["page"], scale,
                 (x - border, y - border, w + 2 * border, h + 2 * border))
    if spec["turn"]:
        img = img.rotate(90, expand=True)
    return img


def on_canvas(img):
    """One page, centred on the full width of the head — like a page."""
    from PIL import Image
    if img.width > CANVAS_W:            # only the border can push it over
        img = img.resize((CANVAS_W, max(1, round(img.height * CANVAS_W / img.width))),
                         Image.LANCZOS)
    out = Image.new("L", (CANVAS_W, img.height), 255)
    out.paste(img, ((CANVAS_W - img.width) // 2, 0))
    return out


def prepare(pdf_path, dither=None, threshold=128):
    """PDF file -> (packed dots, height in lines, the 576-wide preview)."""
    import tp6s_tool as T
    assert T.PRINT_W == PRINT_W and T.BPL * 8 == PRINT_W

    doc, n_pages = open_pdf(pdf_path)
    LOG.line(f"PDF: {n_pages} page(s)")
    pages, scale, est_lines = plan_pages(doc, n_pages)
    LOG.line(f"{len(pages)} page(s) to print, one scale of {scale:.2f}, "
             f"about {est_lines} lines")
    if est_lines > MAX_LINES:
        raise Fail(f"that job is about {est_lines} dot-lines "
                   f"({est_lines / 305 * 2.54 / 100:.1f} m of paper) — refusing "
                   f"above {MAX_LINES}")

    # Halftone page by page rather than once for the whole job: a note with a
    # photograph pasted into it wants a threshold on the words and a dither on
    # the picture, and asked of the whole stack at once one of them loses.
    # It is still ONE job of dots — the pages are concatenated, the motor runs
    # once — because the pages all land on the same 576-dot canvas first.
    dots, height = bytearray(), 0
    for i, spec in enumerate(pages):
        page_img = build_page_image(spec, scale)
        want = dither if dither is not None else not looks_flat(page_img)
        LOG.line(f"Page {spec['n']}: {page_img.width}x{page_img.height} supersampled, "
                 f"{'Floyd-Steinberg' if want else f'threshold {threshold}'}"
                 f"{'' if dither is not None else ' (chosen)'}")
        page_dots, page_h = T.prepare_raster(on_canvas(page_img),
                                             threshold=threshold, dither=want)
        if i:
            dots += bytes(T.BPL * PAGE_GAP)     # white: bit 0 is no ink
            height += PAGE_GAP
        dots += page_dots
        height += page_h
        if height > MAX_LINES:
            raise Fail(f"that job passed {MAX_LINES} dot-lines — refusing to print it")
    return bytes(dots), height, len(pages)


# ---------------------------------------------------------------------------
# Getting it to the printer
# ---------------------------------------------------------------------------

def helper_alive():
    try:
        with urllib.request.urlopen(HELPER_URL + "/api/status",
                                    timeout=HELPER_PROBE_TIMEOUT) as r:
            st = json.loads(r.read())
        return bool(st.get("ok"))
    except Exception:
        return False


def print_via_helper(data, height):
    body = json.dumps({"data": base64.b64encode(data).decode(), "bpl": len(data) // height,
                       "height": height, "density": DENSITY, "speed": SPEED,
                       "feed": FEED}).encode()
    req = urllib.request.Request(HELPER_URL + "/api/print", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=HELPER_PRINT_TIMEOUT) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            reason = json.loads(e.read()).get("error", "")
        except Exception:
            reason = ""
        if e.code == 409:
            raise Fail("the printer is busy with another job — try again in a moment")
        raise Fail(reason or f"the helper answered {e.code}")
    except urllib.error.URLError as e:
        raise Fail(f"could not reach the helper: {e.reason}")


def print_direct(data, height):
    """Connect from this process. The TCC question lives here: macOS grants
    Bluetooth per responsible process, and a script the print system launched
    is not the terminal that was granted it."""
    import asyncio
    import tp6s_tool as T

    async def go(addr):
        await T._do_print(addr, data, len(data) // height, height,
                          density=DENSITY, speed=SPEED, feed=FEED,
                          lines_per_frame=LINES_PER_FRAME)
        return 200, {}

    try:
        asyncio.run(T._with_printer(go))
    except T._NoPrinter:
        raise Fail("no printer found — is it on? " + T._HELD_LINK_HINT)
    except Exception as e:
        raise Fail(f"{e.__class__.__name__}: {e}" if str(e) else e.__class__.__name__)
    return {"ok": True}


def send(data, height, route):
    if route in ("auto", "helper") and helper_alive():
        LOG.line("Route: the ./tp6 gui helper on 127.0.0.1:8776")
        t0 = time.monotonic()
        r = print_via_helper(data, height)
        return f"{r.get('seconds', round(time.monotonic() - t0, 1))} s via the helper"
    if route == "helper":
        raise Fail("the helper is not running — start it with ./tp6 gui")
    LOG.line("Route: direct BLE from this process (no helper answered)")
    t0 = time.monotonic()
    print_direct(data, height)
    return f"{round(time.monotonic() - t0, 1)} s over BLE"


# ---------------------------------------------------------------------------
# Being invoked by something that tells us nothing
# ---------------------------------------------------------------------------

def find_pdf(argv):
    """The documented contract is (job title, options, path) — but this is a
    thinly documented corner of macOS, so take the last argument that is a
    readable .pdf and fall back to the last readable file at all."""
    files = [a for a in argv if os.path.isfile(a)]
    pdfs  = [a for a in files if a.lower().endswith(".pdf")]
    if pdfs:
        return pdfs[-1]
    for a in reversed(files):
        try:
            with open(a, "rb") as fh:
                if fh.read(5) == b"%PDF-":
                    return a
        except OSError:
            pass
    return None


def probe(argv):
    LOG.line("--- probe ---")
    LOG.line(f"argv: {argv}")
    LOG.line(f"cwd: {os.getcwd()}  uid={os.getuid()}  ppid={os.getppid()}")
    for k in sorted(os.environ):
        LOG.line(f"env {k}={os.environ[k]}")
    notify(f"probe captured {len(argv)} argument(s)")


def main(argv):
    global LOG
    args = list(argv[1:])

    def flag(name):
        if name in args:
            args.remove(name)
            return True
        return False

    def value(name, default=None):
        if name in args:
            i = args.index(name)
            v = args[i + 1] if i + 1 < len(args) else None
            del args[i:i + 2]
            return v
        return default

    quiet     = flag("--no-notify")
    echo      = flag("--verbose") or sys.stdout.isatty()
    do_probe  = flag("--probe")
    dither    = False if flag("--nodither") else (True if flag("--dither") else None)
    threshold = int(value("--threshold", 128))
    route     = value("--route", "auto")
    out_png   = value("--out")

    LOG = _Log(echo)
    LOG.line("=" * 60)
    LOG.line(f"pdf_service {' '.join(repr(a) for a in argv[1:])}")
    sys.stdout = sys.stderr = LOG           # tp6s_tool talks by print()ing

    if do_probe:
        probe(argv[1:])
        return 0

    tmp = None
    try:
        src = find_pdf(args)
        if src is None:
            raise Fail("no PDF was handed over — nothing to print")
        # Copy first, ask questions later: the spool file belongs to the print
        # system and may be gone the moment it thinks we are done with it.
        # We deliberately do NOT delete the original, though Apple's own
        # example does — deleting a file the print system may still be
        # holding is a worse failure than leaving a temp file in a temp dir.
        # The probe log records where it lives; revisit if they pile up.
        tmp = tempfile.mkdtemp(prefix="tp6s-pdf-")
        pdf = os.path.join(tmp, "job.pdf")
        shutil.copyfile(src, pdf)
        LOG.line(f"Job: {os.path.basename(src)}  {os.path.getsize(pdf)} bytes  "
                 f"(copied from {src})")

        data, height, n_pages = prepare(pdf, dither=dither, threshold=threshold)

        if out_png:
            from PIL import Image
            Image.frombytes("1", (PRINT_W, height),
                            bytes(b ^ 0xFF for b in data)).save(out_png)
            LOG.line(f"Wrote {out_png} — not printing (--out)")
            return 0

        how = send(data, height, route)
        # argv[1] is the job's title when the print system called us, which
        # makes the notification say which document actually came out.
        title = args[0] if args and args[0] != src else ""
        msg = (f"{title + ': ' if title else ''}printed {n_pages} "
               f"page{'s' if n_pages != 1 else ''}, {height} lines, {how}")
        LOG.line(msg)
        LOG.syslog(msg)
        if not quiet:
            notify(msg)
        return 0

    except Fail as e:
        LOG.line(f"FAILED: {e}")
        LOG.syslog(f"FAILED: {e}")
        if not quiet:
            notify(str(e), "TP6-S — not printed")
        return 1
    except Exception as e:
        LOG.line("FAILED, unexpectedly:")
        LOG.line(traceback.format_exc())
        LOG.syslog(f"FAILED unexpectedly: {e.__class__.__name__}: {e}")
        if not quiet:
            notify("Something went wrong — see ~/.config/tp6s/pdf-service.log",
                   "TP6-S — not printed")
        return 1
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)
        LOG.flush()


if __name__ == "__main__":
    sys.exit(main(sys.argv))
