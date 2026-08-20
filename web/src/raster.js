/* ============================================================
   raster.js — TP6-S image pipeline (crop/rotate/tone/halftone)

   Classic script, not a module — this page is opened from file://, where
   <script type="module"> silently refuses to run. Everything hangs off a
   single global, TP6.raster, so app.js / quote.js can keep using globals
   without an import graph.

   This is the imaging half of app.js pulled out on its own: the packBitmap /
   processImageBitmap / parsePbm / buildTestPattern functions that used to
   live inline, generalised to take an explicit dither mode, a tone curve,
   and a crop, and extended with the calibration target and a PNG export so a
   composed bitmap can be handed to the Python CLI later. app.js keeps
   owning BLE/printing/DOM; this file only ever touches pixels.
   ============================================================ */

(function () {
  'use strict';

  window.TP6 = window.TP6 || {};

  // Print head geometry — see ARCHITECTURE.md. 576 dots
  // across the 48 mm head is 305 dpi; 300 is the nominal figure on the box
  // and is within 2%, so it's what gets shown to a human, never consulted by
  // the pixel path itself.
  var PRINT_W   = 576;
  var BPL       = 72;
  var PRINT_DPI = 300;

  // ── luminance + dither matrix helpers ──────────────────────────────────

  // Perceptual (not average) grey, matching the weights every function below
  // was tuned against — changing these would shift every threshold default.
  function toLuminance(rgba, w, h) {
    var n = w * h;
    var lum = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var p = i * 4;
      lum[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    }
    return lum;
  }

  // Recursive Bayer construction (Ulichney) rather than a pasted 64-entry
  // table: B(2n) is B(n) tiled into quadrants offset by {0,2,3,1}*|B(n)|.
  // Base case B(1) = [[0]]. Building it this way also means bumping the
  // matrix size later (an 8x8 ramp band, say) is a one-line change.
  function buildBayer(n) {
    if (n === 1) return [[0]];
    var half = n / 2;
    var prev = buildBayer(half);
    var out = [];
    var y, x;
    for (y = 0; y < n; y++) out.push(new Array(n));
    for (y = 0; y < half; y++) {
      for (x = 0; x < half; x++) {
        var v = prev[y][x] * 4;
        out[y][x]               = v;
        out[y][x + half]        = v + 2;
        out[y + half][x]        = v + 3;
        out[y + half][x + half] = v + 1;
      }
    }
    return out;
  }

  // Flattened 8x8 Bayer matrix, values 0..63, built once and reused by both
  // 'bayer' halftoning and the 'ramp' test pattern.
  var BAYER8 = (function () {
    var m = buildBayer(8);
    var flat = new Uint8Array(64);
    for (var y = 0; y < 8; y++) {
      for (var x = 0; x < 8; x++) flat[y * 8 + x] = m[y][x];
    }
    return flat;
  })();

  // ── halftone ────────────────────────────────────────────────────────────

  // rgba: Uint8ClampedArray RGBA, dark = ink. Returns a packed 1bpp buffer,
  // bit=1 = ink, MSB-first (bit 0x80 is the leftmost dot in the byte).
  function halftone(rgba, w, h, opts) {
    opts = opts || {};
    var mode = opts.mode || 'threshold';
    var threshold = (typeof opts.threshold === 'number') ? opts.threshold : 128;
    var bpl = Math.ceil(w / 8);
    var out = new Uint8Array(bpl * Math.max(0, h));
    if (w <= 0 || h <= 0) return out;

    var lum = toLuminance(rgba, w, h);

    function setBit(x, y) { out[y * bpl + (x >> 3)] |= 0x80 >> (x & 7); }

    var x, y, idx, isBlack, newVal, err;

    if (mode === 'floyd') {
      // Classic 7/3/5/1 (over 16) error diffusion — cheap and even, but on a
      // bloom-prone thermal head it turns any mid-grey into a uniform speckle
      // that bloom then smears into a flat mush. Good for photographic tone,
      // not for anything that needs to stay crisp.
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          idx = y * w + x;
          isBlack = lum[idx] < 128;
          newVal = isBlack ? 0 : 255;
          err = lum[idx] - newVal;
          if (x + 1 < w) lum[idx + 1] += err * 7 / 16;
          if (y + 1 < h) {
            if (x > 0) lum[idx + w - 1] += err * 3 / 16;
            lum[idx + w] += err * 5 / 16;
            if (x + 1 < w) lum[idx + w + 1] += err * 1 / 16;
          }
          if (isBlack) setBit(x, y);
        }
      }
    } else if (mode === 'atkinson') {
      // Atkinson only ever redistributes 6/8 of each pixel's error (1/8 to
      // each of six neighbours) and throws the rest away. That deliberate
      // loss is the point on this head: keeping highlights genuinely white
      // and shadows genuinely black avoids the grey mush Floyd-Steinberg
      // produces once thermal bloom smears the diffused error further than
      // the algorithm accounted for.
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          idx = y * w + x;
          isBlack = lum[idx] < 128;
          newVal = isBlack ? 0 : 255;
          err = (lum[idx] - newVal) / 8;
          if (x + 1 < w) lum[idx + 1] += err;
          if (x + 2 < w) lum[idx + 2] += err;
          if (y + 1 < h) {
            if (x > 0) lum[idx + w - 1] += err;
            lum[idx + w] += err;
            if (x + 1 < w) lum[idx + w + 1] += err;
          }
          if (y + 2 < h) lum[idx + 2 * w] += err;
          if (isBlack) setBit(x, y);
        }
      }
    } else if (mode === 'bayer') {
      // Ordered dither: no error propagation, so it can't drift or streak —
      // every pixel's decision depends only on its own value and position.
      // Coarser-looking than error diffusion on screen, but the pattern is
      // stable and repeatable, which matters for judging density settings
      // (see the 'ramp' test pattern, same matrix).
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          var t = (BAYER8[(y & 7) * 8 + (x & 7)] + 0.5) * (255 / 64);
          if (lum[y * w + x] < t) setBit(x, y);
        }
      }
    } else {
      // 'threshold' (default): plain cut, no diffusion at all.
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          if (lum[y * w + x] < threshold) setBit(x, y);
        }
      }
    }

    return out;
  }

  // ── tone curve ──────────────────────────────────────────────────────────

  // Mutates rgba in place. Order is gamma -> contrast -> brightness -> invert,
  // baked into a single 256-entry LUT so a full-frame pass is one table read
  // per channel per pixel instead of pow()/branches per pixel.
  function tone(rgba, w, h, opts) {
    opts = opts || {};
    var brightness = opts.brightness || 0;
    var contrast   = opts.contrast   || 0;
    var gamma      = (typeof opts.gamma === 'number' && opts.gamma > 0) ? opts.gamma : 1;
    var invert     = !!opts.invert;

    // Everything at its default is a no-op — skip the frame entirely rather
    // than run an identity LUT over every pixel.
    if (brightness === 0 && contrast === 0 && gamma === 1 && !invert) return;

    var lut = new Uint8ClampedArray(256);
    var gammaInv = 1 / gamma;
    var c = Math.max(-100, Math.min(100, contrast));
    // Standard "S-curve around 128" contrast formula (the same one CSS/PIL
    // ImageEnhance use): factor > 1 steepens around the midpoint.
    var factor = (259 * (c + 255)) / (255 * (259 - c));

    for (var i = 0; i < 256; i++) {
      var v = Math.pow(i / 255, gammaInv) * 255;
      v = factor * (v - 128) + 128;
      v += brightness;
      if (invert) v = 255 - v;
      lut[i] = v; // Uint8ClampedArray clamps to 0..255 on assignment
    }

    var n = w * h;
    for (var p = 0; p < n; p++) {
      var off = p * 4;
      rgba[off]     = lut[rgba[off]];
      rgba[off + 1] = lut[rgba[off + 1]];
      rgba[off + 2] = lut[rgba[off + 2]];
    }
  }

  // ── packed <-> visible ──────────────────────────────────────────────────

  // Reconstruct a 1bpp buffer into a visible black/white ImageData, width
  // bpl*8. Used for every preview canvas — what you see is dot-for-dot what
  // gets sent, because it's rebuilt from the same packed bits.
  function unpack(data, bpl, h) {
    bpl = Math.max(0, bpl | 0);
    var w = Math.max(1, bpl * 8);
    var hh = Math.max(1, h | 0);
    var id = new ImageData(w, hh);
    for (var y = 0; y < hh; y++) {
      for (var x = 0; x < w; x++) {
        var byteIdx = y * bpl + (x >> 3);
        var bit = (bpl > 0 && byteIdx < data.length) ? (data[byteIdx] >> (7 - (x & 7))) & 1 : 0;
        var v = bit ? 0 : 255;
        var pi = (y * w + x) * 4;
        id.data[pi] = id.data[pi + 1] = id.data[pi + 2] = v;
        id.data[pi + 3] = 255;
      }
    }
    return id;
  }

  // Fraction of SET BITS over total bits — the old app.js counted non-zero
  // BYTES, which reports up to 8x too high (a byte with a single dot set
  // counted the same as a byte of solid black). The throttle warning needs
  // the real number: a measured 61%-ink fox print was fine, but that's
  // coverage of dots, not of bytes-that-happen-to-contain-a-dot.
  function inkCoverage(data) {
    if (!data || !data.length) return 0;
    var bits = 0;
    for (var i = 0; i < data.length; i++) {
      var b = data[i];
      b = b - ((b >> 1) & 0x55);
      b = (b & 0x33) + ((b >> 2) & 0x33);
      b = (b + (b >> 4)) & 0x0F;
      bits += b;
    }
    return bits / (data.length * 8);
  }

  // Bounding box of everything darker than `threshold`, in source rgba
  // pixels. Used for a "trim white margins" action — returns the full frame
  // (not a zero-size box) when nothing is dark enough to count as content,
  // so a caller can always safely use the result as a crop rect.
  function trimBox(rgba, w, h, threshold) {
    threshold = (typeof threshold === 'number') ? threshold : 128;
    if (w <= 0 || h <= 0) return { x: 0, y: 0, w: Math.max(0, w), h: Math.max(0, h) };

    var minX = w, minY = h, maxX = -1, maxY = -1;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var p = (y * w + x) * 4;
        var lum = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
        if (lum < threshold) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return { x: 0, y: 0, w: w, h: h }; // blank frame — nothing to trim to
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  // ── whole-image pipeline ────────────────────────────────────────────────

  // crop -> rotate/flip -> scale to maxWidth -> composite onto opaque white
  // -> tone -> halftone. `source` is anything drawImage accepts (ImageBitmap,
  // canvas, <img>). Returns srcW/srcH as the post-crop, post-rotate pixel
  // size, so a caller can report the scale factor actually applied.
  function compose(source, opts) {
    opts = opts || {};
    var maxWidth = opts.maxWidth || PRINT_W;

    var natW = source.naturalWidth || source.width;
    var natH = source.naturalHeight || source.height;
    if (!natW || !natH) throw new Error('compose: source has zero size');

    // 1. Crop, in source pixel space.
    var crop = opts.crop || { x: 0, y: 0, w: natW, h: natH };
    var cw = Math.max(1, Math.round(crop.w));
    var ch = Math.max(1, Math.round(crop.h));
    var cropCanvas = document.createElement('canvas');
    cropCanvas.width = cw; cropCanvas.height = ch;
    cropCanvas.getContext('2d').drawImage(source, crop.x, crop.y, cw, ch, 0, 0, cw, ch);

    // 2. Rotate + flip on a second canvas. Flip is applied as the innermost
    // transform (called last, right before drawImage) so a mirrored image
    // gets rotated as a whole afterwards, rather than rotating first and
    // mirroring the rotated result.
    var rotate = ((opts.rotate || 0) % 360 + 360) % 360;
    var rw = cw, rh = ch;
    if (rotate === 90 || rotate === 270) { rw = ch; rh = cw; }
    var rotCanvas = document.createElement('canvas');
    rotCanvas.width = rw; rotCanvas.height = rh;
    var rx = rotCanvas.getContext('2d');
    rx.translate(rw / 2, rh / 2);
    rx.rotate(rotate * Math.PI / 180);
    rx.scale(opts.flipH ? -1 : 1, opts.flipV ? -1 : 1);
    rx.drawImage(cropCanvas, -cw / 2, -ch / 2);

    // 3. Scale to head width, compositing onto opaque white in the same
    // draw. Filling white BEFORE drawing (rather than after) is what keeps
    // transparent PNGs from printing as a solid black page — the alpha
    // channel of rotCanvas composites over white right here instead of
    // surviving into the threshold/dither step as "premultiplied black".
    // 'high' smoothing quality is the closest canvas gets to the CLI's PIL
    // LANCZOS resample; it matters most just before a 1bpp threshold/dither
    // because any aliasing here becomes permanent once bits are cut.
    var outH = Math.max(1, Math.round(rh * maxWidth / rw));
    var finalCanvas = document.createElement('canvas');
    finalCanvas.width = maxWidth; finalCanvas.height = outH;
    var fx = finalCanvas.getContext('2d');
    fx.imageSmoothingEnabled = true;
    fx.imageSmoothingQuality = 'high';
    fx.fillStyle = '#ffffff';
    fx.fillRect(0, 0, maxWidth, outH);
    fx.drawImage(rotCanvas, 0, 0, maxWidth, outH);

    var idata = fx.getImageData(0, 0, maxWidth, outH);
    tone(idata.data, maxWidth, outH, opts);
    var packed = halftone(idata.data, maxWidth, outH, opts);

    return {
      data: packed,
      bpl: Math.ceil(maxWidth / 8),
      width: maxWidth,
      height: outH,
      srcW: rw,
      srcH: rh
    };
  }

  // Halftone an already-576-wide canvas with no rescaling — the Draw tab
  // path, where the canvas IS the print buffer already at head width.
  function fromCanvas(canvas, opts) {
    opts = opts || {};
    if (canvas.width !== PRINT_W) {
      throw new Error('fromCanvas: canvas width must be ' + PRINT_W + ' (got ' + canvas.width + ')');
    }
    var h = canvas.height;
    var idata = canvas.getContext('2d').getImageData(0, 0, PRINT_W, h);
    tone(idata.data, PRINT_W, h, opts);
    var packed = halftone(idata.data, PRINT_W, h, opts);
    return { data: packed, bpl: BPL, width: PRINT_W, height: h };
  }

  // ── PBM import ──────────────────────────────────────────────────────────

  // Binary P4 only (matches the CLI, which never writes ASCII P1). Ported
  // from app.js's parsePbm, including its nearest-neighbour rescale to
  // PRINT_W when the source PBM is a different width — bilinear would need
  // to unpack to greyscale first, and a hand-drawn/CLI-generated PBM is
  // usually already 1-bit art where nearest-neighbour is the honest choice.
  function parsePBM(file) {
    return file.arrayBuffer().then(function (buf) {
      var view = new Uint8Array(buf);
      var pos = 0;
      function readLine() {
        var s = '';
        while (pos < view.length && view[pos] !== 0x0A) s += String.fromCharCode(view[pos++]);
        pos++;
        return s;
      }

      var magic = readLine();
      if (magic.trim() !== 'P4') throw new Error('PBM P4 (binary) format required — got: ' + magic);

      var sizeLine = readLine();
      while (sizeLine.indexOf('#') === 0) sizeLine = readLine();
      var parts = sizeLine.trim().split(/\s+/);
      var w = parseInt(parts[0], 10), h = parseInt(parts[1], 10);
      var bpl = Math.ceil(w / 8);
      var raw = view.slice(pos, pos + bpl * h);

      if (w !== PRINT_W) {
        var dst = new Uint8Array(BPL * h);
        for (var y = 0; y < h; y++) {
          for (var x = 0; x < PRINT_W; x++) {
            var sx = Math.floor(x * w / PRINT_W);
            var sb = raw[y * bpl + (sx >> 3)];
            var bit = (sb >> (7 - (sx & 7))) & 1;
            if (bit) dst[y * BPL + (x >> 3)] |= 0x80 >> (x & 7);
          }
        }
        return { data: dst, bpl: BPL, width: PRINT_W, height: h };
      }
      return { data: new Uint8Array(raw), bpl: bpl, width: PRINT_W, height: h };
    });
  }

  // ── test patterns ───────────────────────────────────────────────────────

  function testPattern(kind, bpl, lines) {
    bpl = Math.max(1, bpl | 0);
    lines = Math.max(0, lines | 0);
    var data = new Uint8Array(bpl * lines);
    var y, x;

    if (kind === 'black') {
      data.fill(0xFF);
    } else if (kind === 'white') {
      // already zero
    } else if (kind === 'ramp') {
      // 16 vertical bands of increasing density, dithered with the same
      // Bayer matrix 'bayer' halftoning uses — the useful pattern for
      // judging density settings, since each band is a known, even target
      // fill percentage rather than a hand-picked photo.
      var w = bpl * 8;
      var bands = 16;
      for (y = 0; y < lines; y++) {
        for (x = 0; x < w; x++) {
          var band = Math.min(bands - 1, Math.floor(x * bands / w));
          var level = (band + 1) / bands; // 1/16 .. 16/16 fill
          var t = (BAYER8[(y & 7) * 8 + (x & 7)] + 0.5) / 64;
          if (t < level) data[y * bpl + (x >> 3)] |= 0x80 >> (x & 7);
        }
      }
    } else { // 'bars'
      for (y = 0; y < lines; y++) {
        if (Math.floor(y / 4) % 2 === 0) data.fill(0xFF, y * bpl, y * bpl + bpl);
      }
    }
    return data;
  }

  // Port of research/make_calibration.py: a 576x576 square with border, corner
  // diagonal, a centre crosshair, and edge ticks/labels, to settle whether
  // the feed-axis step pitch matches the 576-dot cross-axis pitch. Print it
  // and measure both sides with a ruler — see that script's docstring.
  //
  // Text is bold and >= 28px here, unlike the original PIL script's small
  // (19px) tick labels: paper tests found that nothing thinner
  // than ~6 dots survives thermal bloom, and this target is useless if its
  // own numbers blur into unreadable smudges.
  function calibrationTarget() {
    var W = PRINT_W;
    var SQUARE = 576;
    var TOP = 46;
    var TICK_STEP = 72;
    var STROKE = 3;
    var H = TOP + SQUARE + 64;

    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var cx = c.getContext('2d');
    cx.fillStyle = '#ffffff';
    cx.fillRect(0, 0, W, H);
    cx.fillStyle = '#000000';
    cx.strokeStyle = '#000000';
    cx.lineWidth = STROKE;
    cx.textBaseline = 'top';

    cx.font = 'bold 34px monospace';
    cx.fillText('576 px CALIBRATION', 0, 2);

    var x0 = 0, y0 = TOP, x1 = SQUARE - 1, y1 = TOP + SQUARE - 1;
    var cxr = (x0 + x1) / 2, cyr = (y0 + y1) / 2;

    // Border.
    cx.beginPath();
    cx.rect(x0, y0, x1 - x0, y1 - y0);
    cx.stroke();

    // Corner-to-corner diagonal — lands exactly on the far corner only if
    // the cross-axis and feed-axis pitch are equal (square pixels).
    cx.beginPath();
    cx.moveTo(x0, y0);
    cx.lineTo(x1, y1);
    cx.stroke();

    // Centre crosshair — an independent, shorter check of the same thing,
    // easier to eyeball at a glance than the corner diagonal on a long strip.
    cx.beginPath();
    cx.moveTo(cxr - 24, cyr); cx.lineTo(cxr + 24, cyr);
    cx.moveTo(cxr, cyr - 24); cx.lineTo(cxr, cyr + 24);
    cx.stroke();

    // Ticks along the top and left edges, same pitch, for direct comparison;
    // only the major (every-other) ticks get a printed number so the labels
    // have room to be large enough to survive.
    cx.font = 'bold 28px monospace';
    for (var i = 0; i <= SQUARE; i += TICK_STEP) {
      var major = (i % (TICK_STEP * 2)) === 0;
      var len = major ? 26 : 15;
      cx.beginPath();
      cx.moveTo(x0 + i, y0); cx.lineTo(x0 + i, y0 + len);
      cx.moveTo(x0, y0 + i); cx.lineTo(x0 + len, y0 + i);
      cx.stroke();
      if (major && i > 0 && i < SQUARE) {
        cx.fillText(String(i), x0 + i + 6, y0 + 4);
        cx.fillText(String(i), x0 + 6, y0 + i + 4);
      }
    }

    cx.fillText('square 576x576 px', 0, y1 + 10);
    cx.fillText('measure W and H in mm', 0, y1 + 38);

    var idata = cx.getImageData(0, 0, W, H);
    var packed = halftone(idata.data, W, H, { mode: 'threshold', threshold: 128 });
    return { data: packed, bpl: Math.ceil(W / 8), width: W, height: H };
  }

  // ── export ──────────────────────────────────────────────────────────────

  // 1bpp buffer -> PNG blob, so a composed bitmap can be saved and printed
  // later with the Python CLI (which takes plain image files, not packed
  // bits).
  function toPNGBlob(data, bpl, h) {
    var id = unpack(data, bpl, h);
    var c = document.createElement('canvas');
    c.width = id.width; c.height = id.height;
    c.getContext('2d').putImageData(id, 0, 0);
    return new Promise(function (resolve, reject) {
      c.toBlob(function (blob) {
        if (blob) resolve(blob); else reject(new Error('toBlob failed'));
      }, 'image/png');
    });
  }

  // Re-encode a decoded picture for storage inside a document. Two rules,
  // both of which are corruptions rather than inefficiencies when broken:
  //
  //  1. Draw onto a TRANSPARENT canvas, never a white-filled one. Black-on-
  //     transparent art is normal here — the quote-card zine PNGs are exactly
  //     that — and flattening it onto white turns a picture sitting over
  //     another one into an opaque rectangle that hides it. The damage only
  //     appears after a reload, which is the worst time to find it.
  //  2. Choose the encoding from what the picture actually IS. A photograph
  //     stored as PNG is megabytes, and a document is meant to be openable
  //     rather than archival — so photographs go out as JPEG. But flat art
  //     must not: JPEG rings at hard edges, and a threshold turns that
  //     ringing into stray dots, which on a 1-bit head is the exact damage
  //     this whole tool exists to avoid. Woodcut, line art, type and
  //     screenshots all have few distinct tones, so counting tones separates
  //     the two cases cheaply and puts the lossless path where it is needed.
  //     Measured: with JPEG for everything, a reopened line-art page printed
  //     different dots than the one that was saved.
  var FLAT_TONES = 48;      // at or below this, treat it as flat art
  var TONE_SAMPLES = 20000;

  function looksFlat(px) {
    var seen = new Uint8Array(256);
    var distinct = 0;
    var stride = Math.max(4, Math.floor(px.length / 4 / TONE_SAMPLES) * 4);
    for (var i = 0; i < px.length; i += stride) {
      var lum = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 | 0;
      if (!seen[lum]) {
        seen[lum] = 1;
        if (++distinct > FLAT_TONES) return false;
      }
    }
    return true;
  }

  function toStoredImage(bitmap, maxSide) {
    var scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bitmap.width * scale));
    c.height = Math.max(1, Math.round(bitmap.height * scale));
    var cx = c.getContext('2d');
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(bitmap, 0, 0, c.width, c.height);

    var px = cx.getImageData(0, 0, c.width, c.height).data;
    var transparent = false;
    for (var i = 3; i < px.length; i += 4) {
      if (px[i] !== 255) { transparent = true; break; }
    }
    var lossless = transparent || looksFlat(px);

    return new Promise(function (resolve, reject) {
      c.toBlob(function (blob) {
        if (blob) resolve(blob); else reject(new Error('could not encode a picture'));
      }, lossless ? 'image/png' : 'image/jpeg', 0.92);
    });
  }

  // ── exports ─────────────────────────────────────────────────────────────

  window.TP6.raster = {
    PRINT_W: PRINT_W,
    BPL: BPL,
    PRINT_DPI: PRINT_DPI,

    halftone: halftone,
    tone: tone,
    unpack: unpack,
    inkCoverage: inkCoverage,
    trimBox: trimBox,
    compose: compose,
    fromCanvas: fromCanvas,
    parsePBM: parsePBM,
    testPattern: testPattern,
    calibrationTarget: calibrationTarget,
    toPNGBlob: toPNGBlob,
    toStoredImage: toStoredImage
  };
})();
