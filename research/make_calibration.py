#!/usr/bin/env python3
"""Generate a 576 px DPI/aspect calibration target for the TP6-S.

The advertised resolution and the printer's physical output size need not
agree. This target lets a ruler establish horizontal and vertical dot pitch.

Print it, then measure:

    ./tp6 image <addr> research/tp6_calibration.png --nodither

  * width of the square  -> horizontal dpi = 576 / (mm / 25.4)
  * height of the square -> vertical dpi (motor step pitch)

If the two differ, the printer does not have square pixels and every image is
being printed stretched or squashed along the feed direction. The 45 degree
diagonal makes that visible by eye before you measure anything: it leaves the
square exactly at the far corner only if the aspect is true.
"""

from PIL import Image, ImageDraw, ImageFont

W        = 576          # full head width — never change this
SQUARE   = 576          # a true square in pixels; should print square in mm
TOP      = 46           # headroom for the caption
TICK_STEP = 72          # 8 ticks across the square
STROKE   = 3            # thin lines break up on thermal paper

FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/Library/Fonts/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def _font(size):
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def build():
    h = TOP + SQUARE + 58
    img = Image.new("L", (W, h), 255)
    d = ImageDraw.Draw(img)

    f_big = _font(30)
    f_sm = _font(19)

    d.text((0, 4), "576 px CALIBRATION", font=f_big, fill=0)

    x0, y0 = 0, TOP
    x1, y1 = SQUARE - 1, TOP + SQUARE - 1

    # The square itself: equal side lengths in pixels by construction.
    d.rectangle([x0, y0, x1, y1], outline=0, width=STROKE)

    # 45 degree diagonal — lands on the corner only if pixels are square.
    d.line([x0, y0, x1, y1], fill=0, width=STROKE)

    # Rulers on the top and left edges, same pitch, for direct comparison.
    for i in range(0, SQUARE + 1, TICK_STEP):
        major = (i % (TICK_STEP * 2) == 0)
        length = 26 if major else 15
        d.line([x0 + i, y0, x0 + i, y0 + length], fill=0, width=STROKE)
        d.line([x0, y0 + i, x0 + length, y0 + i], fill=0, width=STROKE)
        if major and 0 < i < SQUARE:
            d.text((x0 + i + 6, y0 + 4), str(i), font=f_sm, fill=0)
            d.text((x0 + 6, y0 + i + 4), str(i), font=f_sm, fill=0)

    d.text((0, y1 + 8), "square 576x576 px", font=f_sm, fill=0)
    d.text((0, y1 + 30), "measure W and H in mm", font=f_sm, fill=0)

    return img


if __name__ == "__main__":
    out = "research/tp6_calibration.png"
    img = build()
    img.save(out)
    print(f"{out}  {img.size[0]}x{img.size[1]}")
    for dpi in (203, 300):
        print(f"  if {dpi} dpi: square prints "
              f"{SQUARE / dpi * 25.4:.1f} mm ({SQUARE / dpi:.2f}\")")
