/* ============================================================
   card.js — composing type into a 1-bit card.

   Adapted from an earlier web-based quote-card maker, with three
   departures, all of them for the sake of 1-bit output:

     * No html2canvas. The maker captures a DOM node at screen size and
       rescales the result. Antialiased text, resampled, then thresholded is
       exactly the pipeline that turns type to mush on a thermal head. Here
       the glyphs are rasterised once, directly into the 576-dot-wide output
       buffer, at final size.
     * Threshold, never error diffusion. Dithered type is speckle.
       Antialiasing stays on and gets thresholded, which positions stems
       better than drawing with AA off, and the cutoff then behaves as a
       stroke-weight control.
     * One ink, one paper. No colours, no background image.

   Depends on TP6.raster.
   ============================================================ */

(function () {
  'use strict';

  window.TP6 = window.TP6 || {};
  const R = window.TP6.raster;

  // Card geometries. Width is always the full head — the dot count is not
  // negotiable — so a shape only chooses the height, and whether the buffer
  // gets turned a quarter turn on the way out.
  //
  // 'landscape' composes at 960x576 (5:3, the same proportion as the maker's
  // 1500x900) and then rotates, so it prints down the strip and you turn the
  // paper to read it. 'label' is 5:3 at full head width, which lands inside
  // the 30 mm of a 57x30 mm adhesive label with about a millimetre to spare.
  const SHAPES = {
    portrait:  { w: R.PRINT_W, h: null, rotate: false, note: '48 mm wide, height follows the text' },
    landscape: { w: 960,       h: 576,  rotate: true,  note: '5:3 card, prints sideways' },
    label:     { w: R.PRINT_W, h: 346,  rotate: false, note: 'fits a 57×30 mm label' },
  };

  const MIN_H = 64; // the head's minimum job height

  // A floor so the mode works before the font picker has been touched.
  // Typewriter faces installed in ~/Library/Fonts are found by the
  // Local Font Access API; canvas can render any installed family by name
  // with no API at all, which is why the free-text box always works.
  const FALLBACK_FONTS = [
    'Special Elite', 'Aachen Typewriter Regular', 'Erika Ormig',
    'zai_CourierPolski1941', 'zai_OlivettiHispanoPluma22Typewriter',
    'Courier New', 'Courier', 'Menlo', 'Monaco', 'Andale Mono',
    'American Typewriter', 'Georgia', 'Helvetica',
  ];

  const QUOTES = [
    "If it costs an\narm and a leg\ndon't buy two.",
    "Wouldn't it be great\nif you could pay\nfor things\nwith a kiss.",
    'He who dies\nwith the most toys\nis still dead',
    'The best table\nin the city\nis the one\nwith your family around it',
    'Nobody\ncomes running\ndown the stairs\nto hug you\nwhen you get to work.',
    "If you can't always\nget what you want\nyou are doing it right.",
    'The best\n"blue chips"\nto buy\nare the ones\nyou dip in salsa.',
    'Dreams\nare the mind\'s whispers\nof what could be.',
    'Create a reality\nwhere your dreams\nfeel at home.',
    "It is not about finding yourself,\nit's about\ncreating yourself.",
    'The world breaks everyone,\nand afterward,\nsome are stronger\nat the broken places.',
    'It is never\ntoo late to be\nwhat you might have been.',
  ];

  // ── layout ──────────────────────────────────────────────────

  // Break on the author's own line breaks first — hand-broken phrasing is
  // the whole point of a quote card — then soft-wrap anything still too wide
  // so a long line cannot silently run off the edge.
  function layout(cx, text, boxW, fontSize, lineHeight) {
    const out = [];
    text.split('\n').forEach((hard) => {
      if (!hard.trim() || cx.measureText(hard).width <= boxW) { out.push(hard); return; }
      let line = '';
      hard.split(' ').forEach((word) => {
        const trial = line ? line + ' ' + word : word;
        if (!line || cx.measureText(trial).width <= boxW) line = trial;
        else { out.push(line); line = word; }
      });
      if (line) out.push(line);
    });
    return { lines: out, blockH: out.length * fontSize * lineHeight };
  }

  // Largest whole pixel size at which every line fits the box in both axes.
  // Binary search, because measureText is the expensive part.
  function autoFit(opts) {
    const shape = SHAPES[opts.shape] || SHAPES.portrait;
    // Nothing to fit against vertically when the height is elastic, so give
    // the search a generous budget and let width decide.
    const cardH = shape.h === null ? 4000 : shape.h;
    const marginX = Math.round(shape.w * opts.marginX / 100);
    const marginY = Math.round(cardH * opts.marginY / 100);
    const boxW = shape.w - marginX * 2;
    const boxH = cardH - marginY * 2;

    const cx = document.createElement('canvas').getContext('2d');
    let lo = 8, hi = 200, best = lo;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      cx.font = mid + 'px "' + opts.font + '"';
      const l = layout(cx, opts.text, boxW, mid, opts.lineHeight);
      let widest = 0;
      l.lines.forEach((s) => { widest = Math.max(widest, cx.measureText(s).width); });
      if (widest <= boxW && l.blockH <= boxH) { best = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return best;
  }

  // Chosen per card so a tall strip cannot blow up memory: 576x4 is cheap,
  // a 2000-line card at 4x is not.
  function superSample(w, h) {
    const budget = 16e6;
    for (let ss = 4; ss > 1; ss--) if (w * ss * h * ss <= budget) return ss;
    return 1;
  }

  // Box-average the supersampled canvas back down, returning greyscale RGBA
  // for the halftone step.
  //
  // This is the part that answers "shouldn't it render at higher dpi". We
  // cannot print more than 576 dots, but we can rasterise the glyphs at 4x
  // and resolve down, and that is not the same picture. Drawing straight at
  // 576 leaves every edge pixel to the browser's gamma-adjusted glyph
  // antialiasing, which biases stems thin and unevenly; averaging 16
  // subsamples gives true linear coverage, so a cut at 128 lands where the
  // outline actually is. Stems then quantise consistently along their length
  // instead of wobbling between two and three dots — that wobble is the
  // raggedness people read as "bitmappy".
  //
  // Coverage is read from the ALPHA channel of a transparent canvas, never
  // from RGB luminance, for two reasons and the first is a real bug:
  //
  //   1. Chrome may rasterise canvas text with LCD subpixel antialiasing,
  //      which puts different coverage in R, G and B along every glyph edge.
  //      Collapsing that to luminance turns colour fringing into per-pixel
  //      noise and the cut erodes edges unevenly — speckled, chewed type.
  //      Drawing onto transparent pixels forces greyscale AA, because
  //      subpixel AA is impossible without a known background colour.
  //   2. Alpha is coverage, directly. No gamma, no colour model. Averaging
  //      it and cutting at 128 is exactly the rule "does the outline cover
  //      more than half of this dot".
  function downsample(sup, ss, w, h) {
    const sd = sup.getContext('2d').getImageData(0, 0, w * ss, h * ss).data;
    const sw = w * ss;
    const out = new Uint8ClampedArray(w * h * 4);
    const n = ss * ss;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let cov = 0;
        for (let dy = 0; dy < ss; dy++) {
          const row = ((y * ss + dy) * sw + x * ss) * 4;
          for (let dx = 0; dx < ss; dx++) cov += sd[row + dx * 4 + 3];
        }
        // The halftone step wants greyscale where dark is ink, so invert.
        const v = 255 - cov / n;
        const pi = (y * w + x) * 4;
        out[pi] = out[pi + 1] = out[pi + 2] = v;
        out[pi + 3] = 255;
      }
    }
    return out;
  }

  function drawCard(o, shape) {
    const cardW = shape.w;
    const marginX = Math.round(cardW * o.marginX / 100);
    // A portrait strip has no height yet to take a percentage of, so its
    // vertical margin is reckoned against the width and behaves as padding.
    const marginY = Math.round((shape.h || cardW) * o.marginY / 100);
    const boxW = cardW - marginX * 2;

    const measure = document.createElement('canvas').getContext('2d');
    measure.font = o.size + 'px "' + o.font + '"';
    const lay = layout(measure, o.text, boxW, o.size, o.lineHeight);

    // Portrait height follows the content; the fixed shapes clip instead.
    const cardH = shape.h === null
      ? Math.max(MIN_H, Math.ceil(lay.blockH + marginY * 2))
      : shape.h;

    const ss = superSample(cardW, cardH);
    const c = document.createElement('canvas');
    c.width = cardW * ss;
    c.height = cardH * ss;
    const cx = c.getContext('2d');
    cx.scale(ss, ss);
    // No white fill: the canvas stays transparent so the alpha channel is
    // pure glyph coverage and Chrome cannot reach for subpixel AA.
    cx.fillStyle = '#000';
    cx.font = o.size + 'px "' + o.font + '"';
    cx.textBaseline = 'alphabetic';

    const boxH = cardH - marginY * 2;
    const lineAdv = o.size * o.lineHeight;

    let topY = marginY;
    if (o.vAlign === 'middle') topY = marginY + (boxH - lay.blockH) / 2;
    if (o.vAlign === 'bottom') topY = marginY + (boxH - lay.blockH);

    // Bolden strokes the outline as well as filling it, widening every stem
    // symmetrically. It is the single most effective control for crisp
    // thermal type: a 1.5-dot hairline quantises to one or two dots almost
    // at random along its length, while a 3-dot stem quantises consistently.
    if (o.bolden > 0) {
      cx.strokeStyle = '#000';
      cx.lineJoin = 'round';
      cx.lineWidth = o.bolden;
    }

    lay.lines.forEach((line, i) => {
      const w = cx.measureText(line).width;
      let x = marginX;
      if (o.hAlign === 'center') x = marginX + (boxW - w) / 2;
      if (o.hAlign === 'right')  x = marginX + (boxW - w);
      // The baseline sits about 0.8em down the line box: close enough to CSS
      // line-height centring at this size, and it keeps ascenders off the
      // top margin.
      const by = topY + i * lineAdv + o.size * 0.8;
      cx.fillText(line, x, by);
      if (o.bolden > 0) cx.strokeText(line, x, by);
    });

    if (o.border) {
      cx.strokeStyle = '#000';
      cx.lineJoin = 'miter';
      cx.lineWidth = 3;
      cx.strokeRect(1.5, 1.5, cardW - 3, cardH - 3);
    }

    return { canvas: c, ss, w: cardW, h: cardH, lines: lay.lines.length };
  }

  function rotate90(src) {
    const d = document.createElement('canvas');
    d.width = src.height;
    d.height = src.width;
    const dx = d.getContext('2d');
    dx.translate(d.width / 2, d.height / 2);
    dx.rotate(Math.PI / 2);
    dx.drawImage(src, -src.width / 2, -src.height / 2);
    return d;
  }

  function render(o) {
    const shape = SHAPES[o.shape] || SHAPES.portrait;
    const r = drawCard(o, shape);

    let sup = r.canvas, outW = r.w, outH = r.h;
    // Turn it while still supersampled: a quarter turn is lossless either
    // way, and it keeps the downsample as the single resampling step.
    if (shape.rotate) { sup = rotate90(sup); outW = r.h; outH = r.w; }

    if (outW !== R.PRINT_W) {
      throw new Error('card is ' + outW + ' dots wide, expected ' + R.PRINT_W);
    }

    const gray = downsample(sup, r.ss, outW, outH);
    const data = R.halftone(gray, outW, outH, { mode: 'threshold', threshold: o.threshold });
    return { data, bpl: R.BPL, width: outW, height: outH, ss: r.ss, lines: r.lines, note: shape.note };
  }

  // ── plain text ──────────────────────────────────────────────
  // The printer's own look: one monospace face, no layout, wrapped at the
  // head width. Deliberately not routed through the card renderer — there
  // is nothing to compose, and the point of this mode is that it is instant.

  function plain(text, fontSize) {
    const scale = Math.max(1, Math.floor(fontSize / 8));
    const charH = 8 * scale;
    const cpl = Math.floor(R.PRINT_W / (charH * 0.6)); // monospace advance is ~0.6em

    const lines = [];
    text.replace(/\r/g, '').split('\n').forEach((raw) => {
      if (!raw) { lines.push(''); return; }
      let rest = raw;
      while (rest.length > cpl) { lines.push(rest.slice(0, cpl)); rest = rest.slice(cpl); }
      lines.push(rest);
    });

    const totalH = lines.length * charH;
    if (totalH === 0) return null;

    const c = document.createElement('canvas');
    c.width = R.PRINT_W;
    c.height = totalH;
    const cx = c.getContext('2d');
    cx.fillStyle = '#fff';
    cx.fillRect(0, 0, R.PRINT_W, totalH);
    cx.fillStyle = '#000';
    cx.font = charH + 'px ui-monospace, Menlo, monospace';
    cx.textBaseline = 'top';
    lines.forEach((line, i) => cx.fillText(line, 0, i * charH));

    const idata = cx.getImageData(0, 0, R.PRINT_W, totalH);
    return {
      data: R.halftone(idata.data, R.PRINT_W, totalH, { mode: 'threshold', threshold: 128 }),
      bpl: R.BPL, width: R.PRINT_W, height: totalH, cpl,
    };
  }

  window.TP6.card = { SHAPES, QUOTES, FALLBACK_FONTS, render, autoFit, plain };
})();
