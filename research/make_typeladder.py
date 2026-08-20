#!/usr/bin/env python3
"""Generate a 576 px type specimen ladder for the TP6-S.

Context: the calibration square prints cleanly (3-dot lines, all eight ticks at
full 576-dot width), and a card rasterised by PIL entirely outside the browser
printed just as coarse as the browser's — so neither the printer nor the canvas
rasteriser is the cause. What's left is the typeface.

1 bit has no tonal range, so the things that survive are thick, even strokes.
The things that fall apart are thin serif brackets, stroke modulation (thick/thin
within one letter), and small counters. A slab serif at Regular weight — the
Roboto Slab default — has all three.

This prints the same phrase across weights, sizes and stroke models so the
hardware can settle it:

    ./tp6 image <addr> research/tp6_typeladder.png --nodither

Uses the same 4x supersample -> box average -> cut at 128 pipeline as the Quote
tab, so what you see here is what that tab would give you.
"""

import os
from PIL import Image, ImageDraw, ImageFont

W       = 576
SS      = 4      # supersample, matching web/quote.js
MARGIN  = 24
PHRASE  = "is still dead"
LABEL_F = "/System/Library/Fonts/Supplemental/Courier New Bold.ttf"
LABEL_S = 26

# (label, path, size). Ordered so the comparison reads as an argument:
# same face by weight, then same weight by size, then other stroke models.
SPECIMENS = [
    ("Roboto Slab Light 64",  "/Library/Fonts/RobotoSlab_Light.ttf",   64),
    ("Roboto Slab Reg 64",    "/Library/Fonts/RobotoSlab_Regular.ttf", 64),
    ("Roboto Slab Bold 64",   "/Library/Fonts/RobotoSlab_Bold.ttf",    64),
    ("Roboto Slab Reg 96",    "/Library/Fonts/RobotoSlab_Regular.ttf", 96),
    ("Special Elite 64",      os.path.expanduser("~/Library/Fonts/SpecialElite.ttf"), 64),
    ("Courier New Bold 64",   LABEL_F,                                  64),
    ("Arial Black 64",        "/System/Library/Fonts/Supplemental/Arial Black.ttf", 64),
    ("Impact 64",             "/System/Library/Fonts/Supplemental/Impact.ttf", 64),
]


def load(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return None


def build():
    # Measure first so the strip is exactly as tall as it needs to be.
    items, total = [], MARGIN
    for label, path, size in SPECIMENS:
        if load(path, size) is None:
            print(f"  skip (not found): {label}")
            continue
        items.append((label, path, size))
        total += LABEL_S + 6 + int(size * 1.35) + 18
    total += MARGIN

    img = Image.new("L", (W * SS, total * SS), 255)
    d   = ImageDraw.Draw(img)
    lf  = load(LABEL_F, LABEL_S * SS)

    y = MARGIN
    for label, path, size in items:
        if lf:
            d.text((MARGIN * SS, y * SS), label, font=lf, fill=0)
        y += LABEL_S + 6
        f = load(path, size * SS)
        w = d.textlength(PHRASE, font=f)
        d.text(((W * SS - w) / 2, y * SS), PHRASE, font=f, fill=0)
        y += int(size * 1.35) + 18

    # Same resolve-down as the Quote tab: linear box average, cut at 128.
    img = img.resize((W, total), Image.BOX)
    return img.point(lambda p: 0 if p < 128 else 255).convert("1")


if __name__ == "__main__":
    out = "research/tp6_typeladder.png"
    im = build()
    im.save(out)
    print(f"{out}  {im.size[0]}x{im.size[1]}  "
          f"({im.size[1]/300:.1f}\" / {round(im.size[1]/300*25.4)} mm of paper)")
