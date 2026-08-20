/* ============================================================
   app.js — the workspace: modes, the paper path, and printing.

   Everything below the UI lives elsewhere: TP6.proto builds frames,
   TP6.ble moves them, TP6.raster turns pictures into dots and
   TP6.card sets type. This file owns state, the stage, and wiring.

   Classic script (not a module): the tool runs from a file:// URL
   with no server, where ES module imports are blocked.
   ============================================================ */

(function () {
  'use strict';

  const { $, $$, log, progress, confirm, slider, segset, check, select,
          raf, debounce, loadSettings, saveSettings, saveNow, paperLength } = window.TP6.ui;
  const R = window.TP6.raster;
  const ble = window.TP6.ble;
  const proto = window.TP6.proto;
  const card = window.TP6.card;
  const CO = window.TP6.compose;

  // House settings, proven on the physical printer: density 10, speed 3,
  // 24-line frames, six frames in flight. A bare print with these untouched
  // comes out tuned.
  const DEFAULTS = {
    mode: 'image', zoom: 'fit',
    density: 10, speed: 3, feed: 150, window: 6, legacy: false, chunk: 244,

    halftone: 'atkinson', threshold: 128,
    bright: 0, contrast: 0, gamma: 1, invert: false,
    rotate: 0, flipH: false, flipV: false,

    qText: '', qShape: 'portrait', qFont: 'Special Elite', qSize: 40,
    qLh: 1.2, qMx: 8, qMy: 8, qAlign: 'center', qVAlign: 'middle',
    qThresh: 128, qBold: 0, qBorder: false,

    txtText: '', txtSize: 32,
    cTool: 'select', cBrush: 6, cHeight: 576, cFont: 'Special Elite',
    testPattern: 'bars', testWidth: 72, testH: 64, feedLines: 85,
  };

  const S = loadSettings(DEFAULTS);
  const save = () => saveSettings(S);

  // Not persisted: rebuilt from the source on every change, and a stale copy
  // would be a lie about what is loaded.
  let job = null;         // {data, bpl, width, height}
  let source = null;      // ImageBitmap for the image mode
  let pbm = null;         // a PBM arrives already 1-bit and skips the pipeline
  let sourceName = '';
  let crop = null;        // {x, y, w, h} in source pixels
  let cropping = false;
  let composeWantsImage = false;   // the file picker is shared with the Image mode
  let cHeightCtl = null;

  // Inspector controls that something outside their own wiring has to be able
  // to set — opening a page restores the settings it was composed under.
  const ctl = {};

  // A local Python helper can serve this same page over HTTP and print
  // through a transport Web Bluetooth can't match (see web/README.md). Only
  // ever probed when the page is already on that origin — a file:// page
  // must behave exactly as it always has.
  const HELPER_ORIGIN = location.protocol === 'http:'
    && (location.hostname === '127.0.0.1' || location.hostname === 'localhost');
  let helperAvailable = false;
  let helperBusy = false;
  // Which jobs this helper is willing to take. Version 1 only printed, so an
  // older helper reports nothing here and Feed/Terminal/GATT keep to Web
  // Bluetooth — no version sniffing, just what it says it does.
  let helperRoutes = [];

  const HALFTONE_NOTES = {
    atkinson:
      'Spreads only three quarters of the error, so highlights stay white and '
      + 'shadows stay black instead of turning to grey mush under bloom. Start here.',
    floyd:
      'Full error diffusion. More tonal steps than Atkinson and more midtone '
      + 'speckle, which a bloom-prone head tends to fill in.',
    bayer:
      'An ordered 8×8 grid. Regular, mechanical texture that survives '
      + 'downscaling — good for flat tints, wrong for faces.',
    threshold:
      'No halftone at all: every dot is on or off at the cutoff. The right '
      + 'choice for line art, type and woodcut, where dither would only add noise.',
  };

  // ─────────────────────────────────────────────────────────────
  // MODES
  // ─────────────────────────────────────────────────────────────

  function setMode(mode) {
    S.mode = mode;
    save();
    $$('.mode').forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', String(on));
    });
    $$('.src').forEach((s) => { s.hidden = s.dataset.for !== mode; });
    $$('[data-when]').forEach((g) => { g.hidden = !g.dataset.when.split(' ').includes(mode); });

    const isTerm = mode === 'term';
    $('term').hidden = !isTerm;
    $('path').hidden = isTerm;
    $('gauge').hidden = isTerm;
    document.querySelector('.stagebar').hidden = isTerm;

    $('itemLayer').hidden = mode !== 'draw';

    const isImage = mode === 'image';
    $('cropBtn').hidden = !isImage || !source;
    $('cropClear').hidden = !isImage || !crop;
    $('trimBtn').hidden = !isImage || !source;

    if (isTerm) { $('termInput').focus(); return; }
    rebuild();
    // First arrival in a mode this session brings back whatever was left
    // there before a reload. It is a no-op once that mode has been visited.
    restoreMode(mode);
  }

  // ─────────────────────────────────────────────────────────────
  // THE STAGE
  //
  // One canvas holds whatever is going to be printed, reconstructed from the
  // packed bits so what you see is dot for dot what gets sent. The strip is
  // sized in CSS only; the backing store is always the real dot grid.
  // ─────────────────────────────────────────────────────────────

  function paintPreview(bitmap) {
    const cv = $('preview');
    cv.width = bitmap.width;
    cv.height = bitmap.height;
    cv.getContext('2d').putImageData(R.unpack(bitmap.data, bitmap.bpl, bitmap.height), 0, 0);
  }

  function layoutPaper() {
    const paper = $('paper');
    const cv = $('preview');
    if (!cv.width || !cv.height) return;

    const pathEl = $('path');
    const availW = Math.max(160, pathEl.clientWidth - 40 - 44);
    const availH = Math.max(120, pathEl.clientHeight - 80);
    let widthPx;

    // While marking a crop the stage is showing the whole source, which has
    // nothing to do with paper width, so the paper scales are meaningless.
    if (cropping) {
      widthPx = Math.round(cv.width * Math.min(availW / cv.width, availH / cv.height, 1));
      paper.style.width = widthPx + 'px';
      $('roll').style.width = widthPx + 'px';
      paper.classList.remove('is-actual');
      paper.classList.add('is-crop');
      $('ruler').hidden = true;
      return;
    }
    paper.classList.remove('is-crop');

    if (S.zoom === 'dots') {
      widthPx = cv.width;                       // one dot, one CSS pixel
    } else if (S.zoom === 'actual') {
      widthPx = (cv.width / 576) * 48 * (96 / 25.4); // 48 mm of head, at CSS mm
    } else {
      // Fit, snapped so one printer dot is always a whole number of DEVICE
      // pixels. This is the difference between a preview you can trust and
      // one that lies: at 1.37x, nearest-neighbour draws some dots one pixel
      // wide and their neighbours two, and a clean 1-bit stem comes out
      // visibly ragged on screen while the bitmap itself is perfect. Snapping
      // down to a whole multiple costs a little size and removes the artefact
      // entirely. Below 1x we stop snapping and filter instead (see below),
      // because there is no whole multiple left to snap to.
      const dpr = window.devicePixelRatio || 1;
      let scale = Math.min(availW / cv.width, availH / cv.height, 4);
      if (scale * dpr >= 1) scale = Math.max(1, Math.floor(scale * dpr)) / dpr;
      widthPx = cv.width * scale;
    }
    widthPx = Math.max(60, Math.round(widthPx));

    paper.style.width = widthPx + 'px';
    paper.classList.toggle('is-actual', S.zoom === 'actual');
    $('roll').style.width = widthPx + 'px';

    // Nearest-neighbour is honest only while a printer dot is drawn at least
    // one device pixel wide. Below that the browser is throwing away rows of
    // a 1-bit bitmap, which invents jagged edges that are not in the file and
    // makes clean type look chewed. Measured in DEVICE pixels, so a Retina
    // screen still gets the hard dot grid at 1:1.
    const devScale = widthPx * (window.devicePixelRatio || 1) / cv.width;
    paper.classList.toggle('is-smooth', devScale < 1);

    // The ruler measures paper, not pixels, so its pitch follows the strip:
    // 576 dots is 48 mm of head.
    const mmPx = widthPx / 48;
    document.documentElement.style.setProperty('--mm', mmPx + 'px');
    drawRuler(mmPx, cv.height / cv.width * widthPx);
  }

  // Numbers every 10 mm down the gutter. Without them the ticks are just
  // texture; with them the strip is a measurement you can trust before
  // spending roll on it.
  function drawRuler(mmPx, heightPx) {
    const ruler = $('ruler');
    const HEAD = 16; // the slot the paper comes out of, so 0 mm is the first line
    ruler.textContent = '';
    ruler.style.setProperty('--ruler-top', HEAD + 'px');
    ruler.hidden = mmPx < 1.4;
    if (ruler.hidden) return;
    const step = mmPx * 10 < 26 ? 50 : 10;
    for (let mm = step; mm * mmPx <= heightPx; mm += step) {
      const n = document.createElement('span');
      n.className = 'ruler__n';
      n.style.top = (HEAD + mm * mmPx) + 'px';
      n.textContent = mm;
      ruler.appendChild(n);
    }
  }

  function renderStage() {
    const empty = !job;
    $('pathEmpty').hidden = !empty;
    $('roll').style.visibility = empty ? 'hidden' : '';
    $('gauge').hidden = empty || S.mode === 'term';
    $('printBtn').disabled = !canPrint();
    $('savePng').disabled = empty;

    if (empty) {
      $('ruler').hidden = true;
      $('stageReadout').textContent = '';
      $('docSummary').textContent = 'nothing loaded';
      return;
    }

    paintPreview(job);
    layoutPaper();

    const ink = R.inkCoverage(job.data);
    const len = paperLength(job.height);
    const fill = $('gaugeFill');
    fill.style.width = Math.min(100, ink * 100) + '%';
    fill.classList.toggle('warn', ink > 0.65);
    $('gaugeTxt').textContent =
      `${Math.round(ink * 100)}% ink · ${len.text} of paper · ${job.height} lines`;

    renderItems();

    const warn = ink > 0.65
      ? '<span class="warn">dense — the head may pause</span>'
      : '';
    $('stageReadout').innerHTML =
      `<b>576</b> × <b>${job.height}</b> dots${warn ? ' · ' + warn : ''}`;
  }

  const restage = raf(renderStage);

  // ─────────────────────────────────────────────────────────────
  // BUILD — each mode turns its own source into the same 1-bit job
  // ─────────────────────────────────────────────────────────────

  function rebuild() {
    try {
      switch (S.mode) {
        case 'image': buildImage(); break;
        case 'quote': buildQuote(); break;
        case 'text':  buildText();  break;
        case 'draw':  buildDraw();  break;
        case 'test':  buildTest();  break;
        default:      job = null;
      }
    } catch (err) {
      job = null;
      log('Could not build the page: ' + err.message, 'error');
    }
    renderStage();
    // Every compose edit ends here, which makes this the one place autosave
    // has to be hooked to catch all of them.
    autosaveSoon();
  }

  const rebuildSoon = raf(rebuild);

  function toneOpts() {
    return {
      brightness: S.bright, contrast: S.contrast, gamma: S.gamma, invert: S.invert,
      mode: S.halftone, threshold: S.threshold,
    };
  }

  function buildImage() {
    // A PBM is already dots. There is nothing to tone-map or halftone, so it
    // passes straight through every control in the inspector.
    if (pbm) {
      job = pbm;
      $('docSummary').textContent = `${sourceName} · 576×${pbm.height} · already 1-bit`;
      return;
    }
    if (!source) { job = null; $('docSummary').textContent = 'no image'; return; }
    const out = R.compose(source, Object.assign({
      crop, rotate: S.rotate, flipH: S.flipH, flipV: S.flipV,
    }, toneOpts()));
    job = out;
    const scale = (576 / out.srcW * 100).toFixed(0);
    $('docSummary').textContent =
      `${sourceName} · ${out.srcW}×${out.srcH} → 576×${out.height} (${scale}%)`;
  }

  function quoteOpts() {
    return {
      text: S.qText || '', shape: S.qShape, font: S.qFont, size: S.qSize,
      lineHeight: S.qLh, marginX: S.qMx, marginY: S.qMy,
      hAlign: S.qAlign, vAlign: S.qVAlign,
      threshold: S.qThresh, bolden: S.qBold, border: S.qBorder,
    };
  }

  function buildQuote() {
    if (!(S.qText || '').trim()) { job = null; $('docSummary').textContent = 'no quote'; return; }
    const out = card.render(quoteOpts());
    job = out;
    $('docSummary').textContent = `quote · ${out.lines} lines · ${S.qFont} ${S.qSize}px · ${out.ss}× supersampled`;
  }

  function buildText() {
    const out = card.plain(S.txtText || '', S.txtSize);
    job = out;
    $('docSummary').textContent = out
      ? `text · ${S.txtSize}px · ${out.cpl} characters per line`
      : 'no text';
  }

  function buildDraw() {
    // One halftone over the finished page rather than one per object: error
    // diffusion leaves solid black solid and solid white white, so type and
    // line art come through untouched while a photograph beside them dithers.
    job = R.fromCanvas(CO.render(), toneOpts());
    const n = CO.doc.items.length;
    $('docSummary').textContent =
      `page · 576×${CO.doc.height} dots · ${n} object${n === 1 ? '' : 's'}`;
  }

  function buildTest() {
    if (S.testPattern === 'calib') {
      job = R.calibrationTarget();
      $('docSummary').textContent = 'calibration square · 576×576';
      return;
    }
    const bpl = parseInt(S.testWidth, 10);
    const data = R.testPattern(S.testPattern, bpl, S.testH);
    job = { data, bpl, width: bpl * 8, height: S.testH };
    $('docSummary').textContent = `${S.testPattern} · ${bpl * 8} dots × ${S.testH} lines`;
  }

  // ─────────────────────────────────────────────────────────────
  // IMAGE: loading, crop, trim
  // ─────────────────────────────────────────────────────────────

  async function loadImageFile(file) {
    if (!file) return;
    try {
      if (/\.pbm$/i.test(file.name)) {
        source = null;
        crop = null;
        pbm = await R.parsePBM(file);
        sourceStored = null;
        sourceName = file.name;
        afterImageLoad(false);
        rebuild();
        log(`Loaded ${file.name}: ${pbm.height} lines, already 1-bit.`);
        return;
      }
      pbm = null;
      source = await createImageBitmap(file);
      sourceStored = null;
      sourceName = file.name;
      crop = null;
      afterImageLoad(true);
      rebuild();
      log(`Loaded ${file.name}: ${source.width}×${source.height}.`);
    } catch (err) {
      log('Could not read that image: ' + err.message, 'error');
    }
  }

  function afterImageLoad(hasSource) {
    $('imageDrop').hidden = true;
    $('imageActions').hidden = false;
    $('imageMeta').hidden = false;
    $('imageMeta').textContent = source
      ? `${sourceName} — ${source.width} × ${source.height}`
      : `${sourceName} — 1-bit source`;
    $('cropBtn').hidden = !hasSource;
    $('trimBtn').hidden = !hasSource;
    $('cropClear').hidden = true;
  }

  function clearImage() {
    source = null; pbm = null; crop = null; job = null; sourceName = '';
    sourceStored = null;
    $('imageDrop').hidden = false;
    $('imageActions').hidden = true;
    $('imageMeta').hidden = true;
    $('cropBtn').hidden = true;
    $('trimBtn').hidden = true;
    $('cropClear').hidden = true;
    $('imageFileInput').value = '';
    renderStage();
  }

  // Crop happens on the SOURCE, not on the preview: dragging a rectangle
  // over an already-cropped, already-halftoned strip would mean cropping the
  // crop, which nobody can reason about. So the stage temporarily shows the
  // full source in greyscale and you mark the rectangle there.
  function enterCrop() {
    if (!source) return;
    cropping = true;
    const cv = $('preview');
    cv.width = source.width;
    cv.height = source.height;
    const cx = cv.getContext('2d');
    cx.drawImage(source, 0, 0);
    layoutPaper();
    $('cropBox').hidden = false;
    $('cropBtn').textContent = 'Cancel';
    $('stageReadout').textContent = 'Drag a rectangle on the source.';
  }

  function exitCrop(apply) {
    cropping = false;
    $('cropBox').hidden = true;
    $('cropBox').textContent = '';
    $('cropBtn').textContent = 'Crop';
    $('cropClear').hidden = !crop;
    if (apply) rebuild(); else renderStage();
  }

  function initCrop() {
    const box = $('cropBox');
    let rect = null, startX = 0, startY = 0;

    box.addEventListener('pointerdown', (e) => {
      const b = box.getBoundingClientRect();
      startX = e.clientX - b.left;
      startY = e.clientY - b.top;
      box.setPointerCapture(e.pointerId);
      rect = document.createElement('div');
      rect.className = 'crop__box';
      box.textContent = '';
      box.appendChild(rect);
      place(startX, startY, 0, 0);
    });

    box.addEventListener('pointermove', (e) => {
      if (!rect) return;
      const b = box.getBoundingClientRect();
      const x = Math.max(0, Math.min(b.width, e.clientX - b.left));
      const y = Math.max(0, Math.min(b.height, e.clientY - b.top));
      place(Math.min(startX, x), Math.min(startY, y), Math.abs(x - startX), Math.abs(y - startY));
    });

    box.addEventListener('pointerup', (e) => {
      if (!rect) return;
      const b = box.getBoundingClientRect();
      const r = rect.getBoundingClientRect();
      rect = null;
      if (r.width < 6 || r.height < 6) { exitCrop(false); return; }
      const sx = source.width / b.width;
      const sy = source.height / b.height;
      crop = {
        x: Math.round((r.left - b.left) * sx),
        y: Math.round((r.top - b.top) * sy),
        w: Math.round(r.width * sx),
        h: Math.round(r.height * sy),
      };
      log(`Cropped to ${crop.w}×${crop.h} at ${crop.x},${crop.y}.`);
      exitCrop(true);
    });

    function place(x, y, w, h) {
      rect.style.left = x + 'px';
      rect.style.top = y + 'px';
      rect.style.width = w + 'px';
      rect.style.height = h + 'px';
    }
  }

  // Trim measures the SOURCE, so the result is independent of the halftone
  // settings — a dithered edge would otherwise move the box around every
  // time you touched a slider.
  function trimWhite() {
    if (!source) return;
    const c = document.createElement('canvas');
    c.width = source.width;
    c.height = source.height;
    const cx = c.getContext('2d');
    cx.fillStyle = '#fff';
    cx.fillRect(0, 0, c.width, c.height);
    cx.drawImage(source, 0, 0);
    const box = R.trimBox(cx.getImageData(0, 0, c.width, c.height).data, c.width, c.height, 245);
    if (box.w === source.width && box.h === source.height) {
      log('Nothing to trim — the image already reaches its edges.');
      return;
    }
    crop = box;
    $('cropClear').hidden = false;
    log(`Trimmed to ${box.w}×${box.h}.`);
    rebuild();
  }

  async function placeImage(file) {
    if (!file) return;
    try {
      const bitmap = await createImageBitmap(file);
      CO.addImage(bitmap, file.name);
      if (cHeightCtl) cHeightCtl.set(CO.doc.height);
      S.cHeight = CO.doc.height;
      setTool('select');
      refreshSelection();
      rebuild();
      renderItems();
      log(`Placed ${file.name}.`);
    } catch (err) {
      log('Could not read that picture: ' + err.message, 'error');
    }
  }

  // ─────────────────────────────────────────────────────────────
  // COMPOSE — freehand, placed pictures and text on one page
  //
  // Every coordinate here is a printer dot. The screen only scales that, so
  // an object at x = 288 sits at the middle of the paper at any zoom.
  // ─────────────────────────────────────────────────────────────

  const sel = {};   // the inspector controls for the selected object

  function dotAt(e) {
    const cv = $('preview');
    const r = cv.getBoundingClientRect();
    return [
      (e.clientX - r.left) * cv.width / r.width,
      (e.clientY - r.top) * cv.height / r.height,
    ];
  }

  // Handles are DOM over the paper, not marks in the canvas, so they stay
  // crisp at any zoom and can never end up in the print.
  function renderItems() {
    const layer = $('itemLayer');
    layer.hidden = S.mode !== 'draw' || cropping;
    if (layer.hidden) return;
    layer.textContent = '';
    const H = CO.doc.height;
    const current = CO.selected();
    CO.doc.items.forEach((it) => {
      const el = document.createElement('div');
      el.className = 'item' + (current && current.id === it.id ? ' is-on' : '');
      el.style.left   = (it.x / 576 * 100) + '%';
      el.style.top    = (it.y / H * 100) + '%';
      el.style.width  = (it.w / 576 * 100) + '%';
      el.style.height = (it.h / H * 100) + '%';
      // Only the Select tool grabs objects; with a pen in hand the whole
      // paper has to stay drawable, including over a picture.
      el.style.pointerEvents = S.cTool === 'select' ? 'auto' : 'none';
      const grip = document.createElement('div');
      grip.className = 'item__grip';
      el.appendChild(grip);
      el.addEventListener('pointerdown', (e) => startDrag(e, it, false));
      grip.addEventListener('pointerdown', (e) => { e.stopPropagation(); startDrag(e, it, true); });
      layer.appendChild(el);
    });
  }

  function startDrag(e, item, resizing) {
    e.preventDefault();
    CO.select(item.id);
    CO.pushUndo('items');
    const cv = $('preview');
    const r = cv.getBoundingClientRect();
    const kx = cv.width / r.width;
    const ky = cv.height / r.height;
    const sx = e.clientX, sy = e.clientY;
    const ox = item.x, oy = item.y, ow = item.w, oh = item.h;
    const olen = itemLength(item);
    const turned = (item.rot | 0) % 180 !== 0;

    const move = (ev) => {
      const dx = (ev.clientX - sx) * kx;
      const dy = (ev.clientY - sy) * ky;
      if (resizing) {
        // A picture keeps its proportions; a text box rewraps and the depth
        // across its lines follows the words, so the box can never lie about
        // what is in it. Turned type runs down the page, so the grip has to
        // follow the drag along the axis the lines actually run.
        if (item.kind === 'image') {
          item.w = Math.max(24, Math.min(576, Math.round(ow + dx)));
          item.h = Math.max(8, Math.round(item.w * oh / ow));
        } else {
          const along = turned ? dy : dx;
          const cap = turned ? 2400 : 576;
          CO.setTextLength(item, Math.max(24, Math.min(cap, Math.round(olen + along))));
        }
      } else {
        item.x = Math.round(ox + dx);
        item.y = Math.max(0, Math.round(oy + dy));
      }
      renderItems();
      syncSelection();
      rebuildSoon();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      rebuild();
      renderItems();
      renderItemList();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    refreshSelection();
  }

  function initCompose() {
    const cv = $('preview');
    cv.style.touchAction = 'none';
    let penning = false;

    cv.addEventListener('pointerdown', (e) => {
      if (S.mode !== 'draw' || cropping) return;
      const [x, y] = dotAt(e);

      if (S.cTool === 'text') {
        const it = CO.addText('Type here');
        it.x = Math.round(Math.max(0, Math.min(576 - it.w, x - it.w / 2)));
        it.y = Math.round(Math.max(0, y));
        setTool('select');
        refreshSelection();
        rebuild();
        renderItems();
        $('cTextVal').focus();
        $('cTextVal').select();
        return;
      }

      if (S.cTool === 'select') {
        const hit = CO.hitTest(x, y);
        CO.select(hit ? hit.id : null);
        refreshSelection();
        renderItems();
        return;
      }

      penning = true;
      cv.setPointerCapture(e.pointerId);
      CO.penDown(x, y, { size: S.cBrush, erase: S.cTool === 'erase' });
      rebuildSoon();
    });

    cv.addEventListener('pointermove', (e) => {
      if (!penning) return;
      const [x, y] = dotAt(e);
      CO.penMove(x, y, { size: S.cBrush, erase: S.cTool === 'erase' });
      rebuildSoon();
    });

    const stop = () => {
      if (!penning) return;
      penning = false;
      CO.penUp();
      rebuild();
    };
    cv.addEventListener('pointerup', stop);
    cv.addEventListener('pointercancel', stop);
  }

  function setTool(tool) {
    S.cTool = tool;
    save();
    $$('#cTool button').forEach((b) => b.classList.toggle('is-on', b.dataset.v === tool));
    $('preview').style.cursor =
      tool === 'select' ? 'default' : tool === 'text' ? 'text' : 'crosshair';
    renderItems();
  }

  function renderItemList() {
    const list = $('cList');
    list.textContent = '';
    const current = CO.selected();
    // Newest on top, matching what is visually in front.
    CO.doc.items.slice().reverse().forEach((it) => {
      const li = document.createElement('li');
      if (current && current.id === it.id) li.className = 'is-on';
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = it.kind === 'text' ? 'Aa' : 'IMG';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = it.kind === 'text' ? it.text.replace(/\n/g, ' ') : it.name;
      const x = document.createElement('button');
      x.className = 'x';
      x.textContent = '\u00d7';
      x.title = 'Remove';
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        CO.remove(it.id);
        refreshSelection();
        rebuild();
        renderItems();
      });
      li.append(kind, name, x);
      li.addEventListener('click', () => {
        CO.select(it.id);
        refreshSelection();
        renderItems();
      });
      list.appendChild(li);
    });
    $('cEmpty').hidden = CO.doc.items.length > 0;
    $('cUndo').disabled = !CO.canUndo();
  }

  // Push the selected object's own values into the inspector.
  function refreshSelection() {
    const it = CO.selected();
    $('cNone').hidden = !!it;
    $('cDelete').hidden = !it;
    $('cTextCtls').hidden = !it || it.kind !== 'text';
    $('cImageCtls').hidden = !it || it.kind !== 'image';
    $('cRotCtl').hidden = !it;
    $('cWidthCtl').hidden = !it;
    $('cOrder').hidden = !it;
    if (it) {
      if (it.kind === 'text') {
        $('cTextVal').value = it.text;
        sel.font.set(it.font);
        sel.size.set(it.size);
        sel.bold.set(it.bolden);
        sel.align.set(it.align);
      } else {
        $('cInvert').checked = !!it.invert;
      }
      sel.rot.set(it.rot | 0);
      // The slider drives the line length for type and the footprint for a
      // picture, which are different things — say which, rather than calling
      // both "Width" and hoping. Turned type runs down the page, where it can
      // be longer than the head is wide, so the ceiling moves with it.
      const turned = (it.rot | 0) % 180 !== 0;
      $('cWLbl').textContent = it.kind === 'text' ? 'Line length' : 'Width';
      sel.width.el.max = (it.kind === 'text' && turned) ? 2400 : 576;
      sel.width.set(itemLength(it));
    }
    renderItemList();
  }

  // What the width slider and the grip actually change: a text box owns the
  // side its lines run along, a picture owns its footprint width.
  function itemLength(it) {
    return it.kind === 'text' ? CO.textLength(it) : it.w;
  }

  // Same, for values that change while dragging.
  function syncSelection() {
    const it = CO.selected();
    if (it) sel.width.set(itemLength(it));
  }

  function editSelected(change) {
    const it = CO.selected();
    if (!it) return;
    change(it);
    if (it.kind === 'text') CO.measureText(it);
    rebuildSoon();
    renderItems();
  }

  // ─────────────────────────────────────────────────────────────
  // DOCUMENTS — save, open, autosave, for every mode that makes a page
  //
  // Export PNG flattens to dots and keeps none of what made them. A document
  // is the other half. doc.js owns the format and the plumbing; what lives
  // here is the part that has to know about modes, because this is where the
  // state and the controls are: capture turns the live mode into a payload,
  // apply pours one back in.
  // ─────────────────────────────────────────────────────────────

  const DOC = window.TP6.doc;

  // Test patterns are generated from their own two controls and the terminal
  // has no page at all, so neither has anything to keep. The menu item
  // disables itself in those two rather than saving an empty file.
  const DOC_MODES = ['image', 'quote', 'text', 'draw'];

  // An Image-mode source is stored bigger than a placed Compose picture: a
  // deep crop into a large photograph is the one case where the extra pixels
  // are still visible at 576 dots.
  const MAX_STORED_SOURCE = 2400;

  let sourceStored = null;   // the encoded source, cached like compose's
  let autosaveOff = false;
  const restored = {};       // modes already restored this session

  // ── capture ─────────────────────────────────────────────────

  function captureRender() {
    return {
      halftone: S.halftone,
      threshold: S.threshold,
      tone: { brightness: S.bright, contrast: S.contrast, gamma: S.gamma, invert: S.invert },
    };
  }

  async function capture(mode) {
    if (mode === 'draw') {
      const p = await CO.toPayload();
      return (p.items.length || p.strokes) ? p : null;
    }
    if (mode === 'quote') {
      return {
        text: S.qText, shape: S.qShape, font: S.qFont, size: S.qSize,
        lineHeight: S.qLh, marginX: S.qMx, marginY: S.qMy,
        align: S.qAlign, vAlign: S.qVAlign,
        threshold: S.qThresh, bolden: S.qBold, border: S.qBorder,
      };
    }
    if (mode === 'text') {
      return S.txtText ? { text: S.txtText, size: S.txtSize } : null;
    }
    if (mode === 'image') {
      if (!source && !pbm) return null;
      if (!sourceStored) {
        sourceStored = source
          ? await R.toStoredImage(source, MAX_STORED_SOURCE)
          // A PBM never had a bitmap behind it — it arrived as dots. Keeping
          // those dots as a picture reopens it as ordinary 1-bit art and
          // prints identically, because every halftone leaves pure black and
          // pure white exactly where they are.
          : await R.toPNGBlob(pbm.data, pbm.bpl, pbm.height);
      }
      return {
        name: sourceName,
        src: sourceStored,
        // Normalised to the source's own size, so the crop survives the
        // stored picture being scaled down on the way in. A rectangle in
        // source pixels would quietly point somewhere else the moment the
        // picture it refers to is not the size it was cut from.
        crop: (crop && source) ? {
          x: crop.x / source.width, y: crop.y / source.height,
          w: crop.w / source.width, h: crop.h / source.height,
        } : null,
        rotate: S.rotate, flipH: S.flipH, flipV: S.flipV,
      };
    }
    return null;
  }

  // ── apply ───────────────────────────────────────────────────

  // The same objects under a different halftone or tone curve print as a
  // different picture, so those travel with a document. Density, speed and
  // feed deliberately do not: they are printer settings, global across every
  // mode, and opening a page should not quietly retune the printer.
  function applyRender(r) {
    if (!r) return;
    if (r.halftone && HALFTONE_NOTES[r.halftone]) {
      S.halftone = r.halftone;
      ctl.halftone.set(r.halftone);
      $('htNote').textContent = HALFTONE_NOTES[r.halftone];
      $('threshCtl').hidden = r.halftone !== 'threshold';
    }
    if (typeof r.threshold === 'number') { S.threshold = r.threshold; ctl.thresh.set(r.threshold); }
    const t = r.tone || {};
    if (typeof t.brightness === 'number') { S.bright = t.brightness; ctl.bright.set(t.brightness); }
    if (typeof t.contrast === 'number') { S.contrast = t.contrast; ctl.contrast.set(t.contrast); }
    if (typeof t.gamma === 'number') { S.gamma = t.gamma; ctl.gamma.set(t.gamma); }
    if (typeof t.invert === 'boolean') { S.invert = t.invert; ctl.invert.set(t.invert); }
  }

  async function apply(mode, payload) {
    if (mode === 'draw') {
      await CO.fromPayload(payload);
      cHeightCtl.set(CO.doc.height);
      S.cHeight = CO.doc.height;
      refreshSelection();
      renderItems();
      return;
    }
    if (mode === 'quote') {
      S.qText = payload.text || '';
      $('qText').value = S.qText;
      const set = (key, value, control) => {
        if (value === undefined || value === null) return;
        S[key] = value;
        if (control) control.set(value);
      };
      set('qShape', payload.shape, ctl.qShape);
      set('qFont', payload.font, ctl.qFont);
      set('qSize', payload.size, ctl.qSize);
      set('qLh', payload.lineHeight, ctl.qLh);
      set('qMx', payload.marginX, ctl.qMx);
      set('qMy', payload.marginY, ctl.qMy);
      set('qAlign', payload.align, ctl.qAlign);
      set('qVAlign', payload.vAlign, ctl.qVAlign);
      set('qThresh', payload.threshold, ctl.qThresh);
      set('qBold', payload.bolden, ctl.qBold);
      set('qBorder', payload.border, ctl.qBorder);
      return;
    }
    if (mode === 'text') {
      S.txtText = payload.text || '';
      $('txtText').value = S.txtText;
      if (payload.size) { S.txtSize = payload.size; ctl.txtSize.set(String(payload.size)); }
      return;
    }
    if (mode === 'image') {
      pbm = null;
      source = await createImageBitmap(payload.src);
      sourceStored = payload.src;   // the very blob it came from: no re-encode
      sourceName = payload.name || 'picture';
      // Back into source pixels, against the picture as it actually arrived
      // rather than as it was when the crop was drawn.
      crop = payload.crop ? {
        x: Math.round(payload.crop.x * source.width),
        y: Math.round(payload.crop.y * source.height),
        w: Math.round(payload.crop.w * source.width),
        h: Math.round(payload.crop.h * source.height),
      } : null;
      if (typeof payload.rotate === 'number') { S.rotate = payload.rotate; ctl.rotate.set(String(payload.rotate)); }
      if (typeof payload.flipH === 'boolean') { S.flipH = payload.flipH; ctl.flipH.set(payload.flipH); }
      if (typeof payload.flipV === 'boolean') { S.flipV = payload.flipV; ctl.flipV.set(payload.flipV); }
      afterImageLoad(true);
      $('cropClear').hidden = !crop;
      return;
    }
    throw new Error(`nothing here can open a ${mode} document`);
  }

  // What a document of each kind is worth saying about itself, once opened.
  function describe(mode, payload) {
    if (mode === 'draw') {
      const n = (payload.items || []).length;
      return `${n} object${n === 1 ? '' : 's'}${payload.strokes ? ' and pen marks' : ''}`;
    }
    if (mode === 'quote') return `${payload.font} at ${payload.size} px`;
    if (mode === 'text') return `${(payload.text || '').split('\n').length} lines`;
    if (mode === 'image') return payload.name || 'a picture';
    return '';
  }

  function fontsOf(mode, payload) {
    if (mode === 'draw') return CO.fontsUsed();
    if (mode === 'quote') return [payload.font];
    return [];
  }

  function warnSubstituted(mode, payload) {
    const missing = DOC.missingFonts(fontsOf(mode, payload));
    if (!missing.length) return;
    log(`Not installed here: ${missing.join(', ')}. That type is being substituted, so this `
      + 'sets differently than it did on the machine that saved it.', 'warn');
  }

  // ── the file ────────────────────────────────────────────────

  function canSaveDoc() { return DOC_MODES.includes(S.mode); }

  async function savePage() {
    if (!canSaveDoc()) {
      log(`There is no document to save in ${S.mode === 'term' ? 'Terminal' : 'Test'} mode.`, 'warn');
      return;
    }
    let payload;
    try {
      payload = await capture(S.mode);
    } catch (err) { log('Could not save: ' + err.message, 'error'); return; }
    if (!payload) { log('Nothing to save yet — build something first.', 'warn'); return; }

    try {
      const text = await DOC.toText(DOC.envelope(S.mode, payload, captureRender()));
      const name = DOC.download(text, S.mode);
      log(`Saved ${name} — ${describe(S.mode, payload)}, ${Math.round(text.length / 1024)} KB. `
        + 'Open it here later and everything is still editable.');
    } catch (err) { log('Could not save: ' + err.message, 'error'); }
  }

  async function openPageFile(file) {
    if (!file) return;
    let d;
    try {
      d = DOC.fromText(await file.text());
    } catch (err) { log(`${file.name} is not a page file I can read: ${err.message}`, 'error'); return; }

    if (!DOC_MODES.includes(d.mode)) {
      log(`${file.name} says it is a ${d.mode} document, which this tool has no mode for.`, 'error');
      return;
    }

    // Only the mode being opened INTO can lose anything, so that is the only
    // one worth interrupting for.
    const live = await capture(d.mode).catch(() => null);
    if (live && d.mode === 'draw') {
      const ok = await confirm('Open page',
        [['File', file.name], ['Holds', describe(d.mode, d[d.mode])]],
        ['This replaces the page you have open, and that cannot be undone.'],
        'Open');
      if (!ok) return;
    }

    try {
      await apply(d.mode, d[d.mode]);
    } catch (err) { log(`Could not open ${file.name}: ${err.message}`, 'error'); return; }

    applyRender(d.render);
    save();
    setMode(d.mode);
    rebuild();
    log(`Opened ${file.name} — ${describe(d.mode, d[d.mode])}.`);
    warnSubstituted(d.mode, d[d.mode]);
  }

  // ── keeping a page across a reload ──────────────────────────
  //
  // Rides on rebuild — every edit in every mode ends in one — and the
  // debounce absorbs the storm of them during a drag. One record per mode,
  // so coming back to a mode finds what was there.

  const autosaveSoon = debounce(() => { autosavePage(); }, 1500);

  async function autosavePage() {
    if (autosaveOff || !canSaveDoc()) return;
    const mode = S.mode;
    try {
      const payload = await capture(mode);
      // An emptied mode clears its record rather than leaving one behind:
      // otherwise the next reload cheerfully restores the thing just thrown
      // away, which reads as the tool ignoring you.
      const ok = payload
        ? await DOC.keep(mode, DOC.envelope(mode, payload, captureRender()))
        : await DOC.forget(mode);
      if (!ok && !DOC.storageAvailable()) noteAutosaveOff();
    } catch (err) { noteAutosaveOff(); }
  }

  function noteAutosaveOff() {
    if (autosaveOff) return;
    autosaveOff = true;
    log('This browser will not let work autosave here, so a reload will lose it. That is '
      + 'usual for a page opened straight from a file; serving it with ./tp6 gui restores '
      + 'autosave. Save page still works either way, and nothing else is affected.', 'dim');
  }

  // Restoring is per mode and happens on first arrival, so everything comes
  // back as it is visited rather than decoding every picture at boot.
  async function restoreMode(mode) {
    if (restored[mode] || autosaveOff || !DOC_MODES.includes(mode)) return;
    restored[mode] = true;

    // Never over the top of work already done in this session.
    const live = await capture(mode).catch(() => null);
    if (live) return;

    let d = null;
    try { d = await DOC.recall(mode); } catch (err) { d = null; }
    if (!d) { if (!DOC.storageAvailable()) noteAutosaveOff(); return; }

    try {
      await apply(mode, d[mode]);
    } catch (err) { log('The autosaved page could not be restored: ' + err.message, 'warn'); return; }

    applyRender(d.render);
    if (S.mode === mode) rebuild();
    log(`Restored what you had in ${mode === 'draw' ? 'Compose' : mode} — ${describe(mode, d[mode])}. `
      + 'Carry on, or clear it out.', 'dim');
    warnSubstituted(mode, d[mode]);
  }

  // ─────────────────────────────────────────────────────────────
  // TERMINAL
  // ─────────────────────────────────────────────────────────────

  let hexMode = true;
  const termHistory = [];
  let historyAt = -1;

  function termLine(text, kind) {
    const out = $('termLog');
    const span = document.createElement('div');
    if (kind) span.className = kind;
    span.textContent = text;
    out.appendChild(span);
    while (out.childElementCount > 500) out.removeChild(out.firstChild);
    out.scrollTop = out.scrollHeight;
  }

  async function runTermCommand(line) {
    if (!line.trim()) return;
    termHistory.push(line);
    historyAt = termHistory.length;
    termLine('› ' + line);

    const parsed = proto.parseCommand(line);
    if (parsed.kind === 'hex') {
      hexMode = !hexMode;
      termLine(`[showing ${hexMode ? 'hex' : 'ascii'}]`);
      return;
    }
    if (parsed.kind === 'error') { termLine('[' + parsed.message + ']', 'er'); return; }
    if (!canTalk('raw')) { termLine('[not connected]', 'er'); return; }
    try {
      if (helperDoes('raw')) {
        // The helper connects, writes, listens for a beat and drops the link
        // again, so the replies arrive together at the end rather than
        // trickling into the 'notify' handler. Same two lines on screen.
        termLine('» ' + parsed.label + '  ' + proto.hex(parsed.bytes), 'tx');
        const res = await helperCall('/api/raw', { hex: proto.hex(parsed.bytes).replace(/\s+/g, '') });
        if (!res.notify) termLine('[no notify characteristic — nothing to hear]', 'er');
        res.rx.forEach((h) => {
          const bytes = Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)));
          termLine(hexMode
            ? '« ' + proto.hex(bytes)
            : `« [${bytes.length}B] ` + proto.ascii(bytes), 'rx');
        });
        if (!res.rx.length) termLine('[no reply]', 'er');
        return;
      }
      await ble.write(parsed.bytes);
      termLine('» ' + parsed.label + '  ' + proto.hex(parsed.bytes), 'tx');
    } catch (err) {
      termLine('[' + err.message + ']', 'er');
    }
  }

  function renderGatt(services) {
    const out = $('gattOut');
    out.textContent = '';
    services.forEach((svc) => {
      const s = document.createElement('div');
      s.className = 'svc';
      s.textContent = svc.service;
      if (svc.tagged) {
        const b = document.createElement('b');
        b.textContent = '  ' + svc.tagged;
        s.appendChild(b);
      }
      out.appendChild(s);
      svc.characteristics.forEach((c) => {
        const d = document.createElement('div');
        d.className = 'chr';
        d.textContent = c.uuid + '  [' + c.props.join(',') + ']';
        if (c.role) {
          const b = document.createElement('b');
          b.textContent = '  ' + c.role.toUpperCase();
          d.appendChild(b);
        }
        out.appendChild(d);
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // LOCAL HELPER — an optional Python process serving this same page over
  // HTTP with a fast, non-Web-Bluetooth print path (see web/README.md and
  // "The web tool cannot be made smooth" in the project notes for why Web
  // Bluetooth alone tops out at ~1.75 KB/s against a printer that needs ~6).
  // Everything here is a no-op on file:// or any other origin.
  // ─────────────────────────────────────────────────────────────

  async function probeHelper() {
    if (!HELPER_ORIGIN) return;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 700);
      const res = await fetch('/api/status', { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return;
      const st = await res.json();
      if (!st || !st.ok) return;
      helperAvailable = true;
      helperRoutes = Array.isArray(st.routes) ? st.routes : [];
      log(helperRoutes.length > 1
        ? 'Local helper found — printing, feed and the terminal all go through the '
          + 'CLI transport. No Bluetooth pairing needed at all.'
        : 'Local helper found — printing goes through the CLI transport (smooth). '
          + 'Do not press Connect: the printer talks to one thing at a time, and '
          + 'holding it here stops the helper finding it at all.');
      syncLinkChip();
      syncConnectBtn();
      syncTalkControls();
      renderStage();
    } catch (_) {
      // No helper listening, or it answered too slowly. Say nothing — Web
      // Bluetooth remains the fallback exactly as before.
    }
  }

  // A single String.fromCharCode(...arr) overflows the call stack on a big
  // page (a 288-line job is already 20 KB+), so this feeds the spread in
  // slices instead.
  function bytesToBase64(bytes) {
    let bin = '';
    const SLICE = 0x8000;
    for (let i = 0; i < bytes.length; i += SLICE) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + SLICE));
    }
    return btoa(bin);
  }

  function canPrint() {
    return !!job && (helperAvailable || ble.isConnected());
  }

  // Feed, Terminal and Read GATT all need *a* printer link, not specifically
  // a Web Bluetooth one. A helper that advertises those routes is the better
  // one to use — it is the only path that does not take the printer away
  // from the helper for everything else.
  function helperDoes(route) {
    return helperAvailable && helperRoutes.indexOf(route) >= 0;
  }

  function canTalk(route) {
    return helperDoes(route) || ble.isConnected();
  }

  // One shape for every helper call: parse the JSON, turn every failure into
  // one sentence. Throws, so callers can report in their own idiom (the log
  // drawer for Feed, the terminal's own line style for raw frames).
  async function helperCall(path, body) {
    const res = await fetch(path, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : undefined);
    const json = await res.json().catch(() => ({}));
    if (res.status === 409) throw new Error('the helper is busy with another job');
    if (!res.ok || !json.ok) throw new Error(json.error || res.statusText || 'helper error');
    return json;
  }

  // A prominent "Connect" next to a chip reading "Helper ready" is a lie by
  // juxtaposition: it implies the tool is waiting for you to do something,
  // when in fact printing already works and connecting would take the
  // printer away from the helper. With a helper up, the button is demoted to
  // what it actually is — an occasional utility for Terminal and Feed.
  function syncConnectBtn() {
    const b = $('connectBtn');
    // A helper that takes every route leaves nothing for a browser link to
    // do, so the button goes away entirely rather than sitting there as a
    // way to break things. It comes back the moment there is no helper —
    // from file://, Web Bluetooth is the only transport there is, and that
    // is the whole reason this page still runs without Python.
    if (helperDoes('feed') && helperDoes('raw') && helperDoes('gatt')) {
      b.hidden = true;
      return;
    }
    const spare = helperAvailable && !ble.isConnected();
    b.hidden = ble.isConnected();
    b.textContent = spare ? 'Bluetooth' : 'Connect';
    b.classList.toggle('chip--quiet', spare);
    b.title = spare
      ? 'Not needed for printing — the helper does that, and faster. A link here is '
        + 'only for Terminal and Feed; Print releases it again.'
      : 'Connect to the printer over Web Bluetooth';
  }

  // Feed, Read GATT and the terminal input are live whenever *something* can
  // carry them — a helper route or a Bluetooth link.
  function syncTalkControls() {
    $('feedBtn').disabled = !canTalk('feed');
    $('gattBtn').disabled = !canTalk('gatt');
    $('termInput').disabled = !canTalk('raw');
  }

  // The chip reflects the BLE link whenever one is up (ble's own 'state'
  // handler drives that case); this covers what it says the rest of the
  // time, where the helper can still make printing possible.
  function syncLinkChip() {
    if (ble.isConnected()) return;
    const chip = $('linkChip');
    chip.dataset.state = helperAvailable ? 'on' : 'off';
    $('linkName').textContent = helperAvailable ? 'Helper ready' : 'Not connected';
    $('linkTelem').hidden = true;
  }

  async function printViaHelper() {
    helperBusy = true;
    $('printBtn').disabled = true;
    $('linkChip').dataset.state = 'busy';
    try {
      const res = await fetch('/api/print', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: bytesToBase64(job.data), bpl: job.bpl, height: job.height,
          density: S.density, speed: S.speed, feed: S.feed,
          minHeight: S.mode === 'draw' || S.mode === 'test' ? 0 : 64,
          invert: S.mode === 'test' && S.testPattern === 'white',
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) {
        log('The helper is already printing something else — try again in a moment.', 'warn');
      } else if (!res.ok || !body.ok) {
        log('Helper print failed: ' + (body.error || res.statusText), 'error');
      } else {
        log(`Printed via helper in ${body.seconds.toFixed(1)} s`);
      }
    } catch (err) {
      log('Could not reach the local helper: ' + err.message, 'error');
    } finally {
      helperBusy = false;
      if (ble.isConnected()) $('linkChip').dataset.state = 'on';
      else syncLinkChip();
      $('printBtn').disabled = !canPrint();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // PRINTING
  //
  // Progress fills the strip on screen from the head downward, because that
  // is what the paper is doing at the same moment.
  // ─────────────────────────────────────────────────────────────

  function setPrinted(pct) {
    const un = $('unprinted');
    const line = $('headline');
    if (pct === null) { un.hidden = true; line.hidden = true; return; }
    un.hidden = false;
    line.hidden = false;
    un.style.top = pct + '%';
    line.style.top = pct + '%';
  }

  async function doPrint() {
    if (!job || ble.isPrinting() || helperBusy) return;
    const useHelper = helperAvailable;   // wins even if BLE is also connected
    // syncState(), not isConnected(): it asks the radio and repaints the
    // header if the link died quietly. A Print that does nothing and says
    // nothing is the worst possible answer.
    if (!useHelper && !ble.syncState()) {
      log('The printer link is down — press Connect and try again.', 'warn');
      return;
    }

    const ink = R.inkCoverage(job.data);
    const len = paperLength(job.height);
    const warnings = [];
    if (ink > 0.65) {
      warnings.push('This page is ' + Math.round(ink * 100) + '% ink. Above about 65% the '
        + 'firmware throttles: the head pauses mid-print while the voltage recovers. '
        + 'It resumes on its own, but speed 2 or one density step down avoids it.');
    }
    if (len.mm > 400) {
      warnings.push('That is ' + len.text + ' of roll for one job.');
    }

    const ok = await confirm('Print', [
      ['Lines', String(job.height)],
      ['Paper', len.text],
      ['Ink', Math.round(ink * 100) + '%'],
      ['Density', String(S.density)],
      ['Speed', String(S.speed)],
      ['Feed after', S.feed + ' lines'],
      ['Sender', useHelper ? 'local helper — smooth' : (S.legacy ? 'legacy per-frame' : 'streamed')],
    ], warnings);
    if (!ok) return;

    if (useHelper) {
      // This printer accepts ONE central at a time, and while the page holds
      // it over Web Bluetooth it stops advertising altogether — so the helper
      // cannot even find it, and every print dies at "Connecting…" with a
      // 500. Nothing about that is visible from here, which is why it reads
      // as "connected, prints nothing". Let the link go: the helper is the
      // faster path and the one about to do the work.
      if (ble.isConnected()) {
        log('Releasing the browser\'s Bluetooth link — the helper needs the printer, '
          + 'and it only talks to one thing at a time.', 'warn');
        ble.disconnect();
        await new Promise((r) => setTimeout(r, 800));
      }
      await printViaHelper();
      return;
    }

    $('printBtn').disabled = true;
    $('linkChip').dataset.state = 'busy';
    progress(0);
    setPrinted(0);
    try {
      await ble.print(job, {
        density: S.density, speed: S.speed, feed: S.feed, window: S.window,
        stream: !S.legacy,
        minHeight: S.mode === 'draw' || S.mode === 'test' ? 0 : 64,
        invert: S.mode === 'test' && S.testPattern === 'white',
      }, {
        onProgress: (pct) => { progress(pct); setPrinted(pct); },
        onStats: showTelemetry,
      });
    } catch (err) {
      const hint = /gatt operation failed/i.test(err.message)
        ? ' The radio refused the write — reconnect and try again.' : '';
      log('Print failed: ' + err.message + hint, 'error');
    } finally {
      if (ble.isConnected()) $('linkChip').dataset.state = 'on';
      else syncLinkChip();
      $('printBtn').disabled = !canPrint();
      setTimeout(() => { progress(null); setPrinted(null); }, 2500);
    }
  }

  // The image ACK carries the printer's own state back on every frame, which
  // is the only window there is into what the hardware is doing. Voltage is
  // the interesting one: it visibly sags through solid blacks, which is what
  // proved the mid-print pauses are a power throttle and not a driver bug.
  function showTelemetry(st) {
    const el = $('linkTelem');
    el.hidden = false;
    el.textContent = `${(st.mv / 1000).toFixed(2)} V · ${st.tempF}° · ${st.battery}%`;
    el.title = `density echo ${st.density}`;
  }

  // ─────────────────────────────────────────────────────────────
  // SAVE
  // ─────────────────────────────────────────────────────────────

  async function savePng() {
    if (!job) return;
    const blob = await R.toPNGBlob(job.data, job.bpl, job.height);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (sourceName ? sourceName.replace(/\.[^.]+$/, '') : S.mode) + '-576.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    log(`Saved ${a.download}. Print it from the CLI with: ./tp6 image <addr> ${a.download} --nodither`);
  }

  // ─────────────────────────────────────────────────────────────
  // FONTS (quote mode)
  // ─────────────────────────────────────────────────────────────

  // One catalogue, two pickers: the quote card and any text object on a
  // composed page draw from the same list.
  function fillFontSelect(families) {
    [['qFont', S.qFont], ['cFont', S.cFont]].forEach(([id, current]) => {
      const el = $(id);
      if (!el) return;
      el.textContent = '';
      families.forEach((f) => {
        const op = document.createElement('option');
        op.value = f;
        op.textContent = f;
        el.appendChild(op);
      });
      if (families.includes(current)) el.value = current;
    });
  }

  async function pickSystemFont() {
    if (!window.queryLocalFonts) {
      log('This browser will not list installed fonts. Type a family name instead — '
        + 'canvas can render any installed face by name.', 'warn');
      return;
    }
    let families;
    try {
      const fonts = await window.queryLocalFonts();
      families = Array.from(new Set(fonts.map((f) => f.family))).sort();
    } catch (err) {
      log('Font access was denied: ' + err.message + ' — type a family name instead.', 'warn');
      return;
    }

    const dlg = $('fontDlg');
    const list = $('fontList');
    $('fontDlgNote').textContent = `${families.length} families installed. Each name is drawn in its own face.`;
    const paint = (filter) => {
      list.textContent = '';
      families
        .filter((f) => !filter || f.toLowerCase().includes(filter.toLowerCase()))
        .slice(0, 400)
        .forEach((f) => {
          const li = document.createElement('li');
          li.textContent = f;
          li.style.fontFamily = '"' + f + '"';
          li.addEventListener('click', () => {
            S.qFont = f;
            fillFontSelect(Array.from(new Set([f].concat(card.FALLBACK_FONTS))));
            $('qFont').value = f;
            save();
            dlg.close();
            rebuild();
          });
          list.appendChild(li);
        });
    };
    paint('');
    $('fontSearch').oninput = () => paint($('fontSearch').value);
    dlg.showModal();
  }

  async function loadFontFile(file) {
    if (!file) return;
    try {
      const family = file.name.replace(/\.(ttf|otf|woff2?)$/i, '');
      const face = new FontFace(family, await file.arrayBuffer());
      await face.load();
      document.fonts.add(face);
      S.qFont = family;
      fillFontSelect(Array.from(new Set([family].concat(card.FALLBACK_FONTS))));
      $('qFont').value = family;
      save();
      log('Loaded the typeface ' + family + '.');
      rebuild();
    } catch (err) {
      log('That font would not load: ' + err.message, 'error');
    }
  }

  // ─────────────────────────────────────────────────────────────
  // WIRING
  // ─────────────────────────────────────────────────────────────

  function wire() {
    // modes
    $('modes').addEventListener('click', (e) => {
      const btn = e.target.closest('.mode');
      if (btn) setMode(btn.dataset.mode);
    });

    // connection
    $('connectBtn').addEventListener('click', () => {
      // Connecting is only worth doing for Terminal and Feed when the helper
      // is up — and it costs the helper the printer until Print takes it back.
      if (helperAvailable && !ble.isConnected()) {
        log('The helper is already able to print. A Bluetooth link here is only for '
          + 'Terminal and Feed, and Print will release it again.', 'dim');
      }
      ble.connect();
    });
    $('disconnectBtn').addEventListener('click', () => ble.disconnect());
    $('printBtn').addEventListener('click', doPrint);
    // The File menu. It is a native popover, so open/close, light dismiss and
    // Esc are the browser's job; the only thing left to do by hand is put it
    // under its button — a top-layer element is positioned against the
    // viewport, not by the layout around it.
    const fileMenu = $('fileMenu');
    const placeMenu = (estimate) => {
      const r = $('fileBtn').getBoundingClientRect();
      const w = estimate || fileMenu.offsetWidth || 230;
      // Right edges aligned: the trigger sits in a right-hand group, so a
      // left-aligned menu would hang off the window.
      fileMenu.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
      fileMenu.style.top = (r.bottom + 6) + 'px';
    };
    fileMenu.addEventListener('beforetoggle', (e) => {
      if (e.newState !== 'open') return;
      // What is worth offering depends on where you are: nothing is built,
      // or the mode has no document at all.
      // In the terminal there is no page on screen at all, so offering to
      // export the last one built somewhere else is a trap, not a courtesy.
      $('savePng').disabled = !job || S.mode === 'term';
      $('savePage').disabled = !canSaveDoc();
      placeMenu(230);      // before it paints, from the known min-width
    });
    fileMenu.addEventListener('toggle', (e) => {
      if (e.newState === 'open') placeMenu();   // again, now it can be measured
    });

    const fromMenu = (fn) => () => { fileMenu.hidePopover(); fn(); };
    $('savePng').addEventListener('click', fromMenu(savePng));
    $('savePage').addEventListener('click', fromMenu(savePage));
    $('openPage').addEventListener('click', fromMenu(() => $('pageFileInput').click()));

    // stage
    const zoom = segset('zoomSet', (v) => { S.zoom = v; save(); layoutPaper(); });
    zoom.set(S.zoom);
    $('cropBtn').addEventListener('click', () => (cropping ? exitCrop(false) : enterCrop()));
    $('cropClear').addEventListener('click', () => {
      crop = null;
      $('cropClear').hidden = true;
      log('Back to the full frame.');
      rebuild();
    });
    $('trimBtn').addEventListener('click', trimWhite);
    initCrop();
    window.addEventListener('resize', raf(layoutPaper));

    // image source
    $('imagePick').addEventListener('click', () => $('imageFileInput').click());
    $('imageReplace').addEventListener('click', () => $('imageFileInput').click());
    $('imageClear').addEventListener('click', clearImage);
    $('imageFileInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (composeWantsImage) { composeWantsImage = false; placeImage(file); }
      else loadImageFile(file);
      e.target.value = '';
    });

    // halftone + tone + geometry
    const ht = segset('htSet', (v) => {
      S.halftone = v; save();
      $('htNote').textContent = HALFTONE_NOTES[v];
      $('threshCtl').hidden = v !== 'threshold';
      rebuild();
    });
    ht.set(S.halftone);
    $('htNote').textContent = HALFTONE_NOTES[S.halftone];
    $('threshCtl').hidden = S.halftone !== 'threshold';

    const thresh = slider('thresh', (v) => { S.threshold = v; save(); rebuildSoon(); });
    thresh.set(S.threshold);

    const bright   = slider('bright',   (v) => { S.bright = v; save(); rebuildSoon(); });
    const contrast = slider('contrast', (v) => { S.contrast = v; save(); rebuildSoon(); });
    const gamma    = slider('gamma',    (v) => { S.gamma = v; save(); rebuildSoon(); }, (v) => v.toFixed(2));
    bright.set(S.bright); contrast.set(S.contrast); gamma.set(S.gamma);

    const invert = check('invert', (v) => { S.invert = v; save(); rebuild(); });
    invert.set(S.invert);

    // Opening a page restores the settings it was composed under, so these
    // have to be reachable from outside this function.
    Object.assign(ctl, { halftone: ht, thresh, bright, contrast, gamma, invert });

    $('toneReset').addEventListener('click', () => {
      S.bright = 0; S.contrast = 0; S.gamma = 1; S.invert = false;
      bright.set(0); contrast.set(0); gamma.set(1); invert.set(false);
      save(); rebuild();
    });

    const rot = segset('rotSet', (v) => { S.rotate = parseInt(v, 10); save(); rebuild(); });
    rot.set(S.rotate);
    const flipH = check('flipH', (v) => { S.flipH = v; save(); rebuild(); });
    const flipV = check('flipV', (v) => { S.flipV = v; save(); rebuild(); });
    flipH.set(S.flipH); flipV.set(S.flipV);
    Object.assign(ctl, { rotate: rot, flipH, flipV });
    $('geoNote').textContent =
      'Landscape sources want 90°, so the short edge maps to the paper width.';

    // quote
    $('qText').value = S.qText;
    $('qText').addEventListener('input', debounce(() => {
      S.qText = $('qText').value; save(); rebuild();
    }, 180));
    $('qRandom').addEventListener('click', () => {
      const pick = card.QUOTES[Math.floor(Math.random() * card.QUOTES.length)];
      $('qText').value = pick;
      S.qText = pick; save(); rebuild();
    });
    $('qFit').addEventListener('click', () => {
      if (!(S.qText || '').trim()) return;
      const best = card.autoFit(quoteOpts());
      S.qSize = best; qSize.set(best); save(); rebuild();
    });
    const qShape = select('qShape', (v) => { S.qShape = v; save(); rebuild(); });
    qShape.set(S.qShape);

    fillFontSelect(Array.from(new Set([S.qFont].concat(card.FALLBACK_FONTS))));
    const qFont = select('qFont', (v) => { S.qFont = v; save(); rebuild(); });
    qFont.set(S.qFont);
    $('qSystem').addEventListener('click', pickSystemFont);
    $('qFontFile').addEventListener('click', () => $('fontFileInput').click());
    $('fontFileInput').addEventListener('change', (e) => loadFontFile(e.target.files[0]));
    $('qFontManual').addEventListener('change', (e) => {
      const name = e.target.value.trim();
      if (!name) return;
      S.qFont = name;
      fillFontSelect(Array.from(new Set([name].concat(card.FALLBACK_FONTS))));
      $('qFont').value = name;
      e.target.value = '';
      save(); rebuild();
    });

    const qSize = slider('qSize', (v) => { S.qSize = v; save(); rebuildSoon(); });
    const qLh   = slider('qLh',   (v) => { S.qLh = v; save(); rebuildSoon(); }, (v) => v.toFixed(2));
    const qMx   = slider('qMx',   (v) => { S.qMx = v; save(); rebuildSoon(); });
    const qMy   = slider('qMy',   (v) => { S.qMy = v; save(); rebuildSoon(); });
    const qTh   = slider('qThresh', (v) => { S.qThresh = v; save(); rebuildSoon(); });
    const qBold = slider('qBold', (v) => { S.qBold = v; save(); rebuildSoon(); }, (v) => v.toFixed(2));
    qSize.set(S.qSize); qLh.set(S.qLh); qMx.set(S.qMx); qMy.set(S.qMy);
    qTh.set(S.qThresh); qBold.set(S.qBold);

    const qAlign = segset('qAlignSet', (v) => { S.qAlign = v; save(); rebuild(); });
    const qVAlign = segset('qVAlignSet', (v) => { S.qVAlign = v; save(); rebuild(); });
    qAlign.set(S.qAlign); qVAlign.set(S.qVAlign);
    Object.assign(ctl, {
      qShape, qFont, qSize, qLh, qMx, qMy, qAlign, qVAlign,
      qThresh: qTh, qBold,
    });
    const qBorder = check('qBorder', (v) => { S.qBorder = v; save(); rebuild(); });
    ctl.qBorder = qBorder;
    qBorder.set(S.qBorder);

    // text
    $('txtText').value = S.txtText;
    $('txtText').addEventListener('input', debounce(() => {
      S.txtText = $('txtText').value; save(); rebuild();
    }, 180));
    const txtSize = select('txtSize', (v) => { S.txtSize = parseInt(v, 10); save(); rebuild(); });
    ctl.txtSize = txtSize;
    txtSize.set(String(S.txtSize));

    // compose
    initCompose();
    segset('cTool', setTool);
    setTool(S.cTool);
    const cBrush = slider('cBrush', (v) => { S.cBrush = v; save(); });
    cBrush.set(S.cBrush);
    cHeightCtl = slider('cHeight', (v) => {
      S.cHeight = v; save(); CO.setHeight(v); rebuildSoon(); renderItems();
    });
    cHeightCtl.set(S.cHeight);
    CO.setHeight(S.cHeight);

    $('cAddText').addEventListener('click', () => {
      CO.addText('Type here');
      cHeightCtl.set(CO.doc.height);
      S.cHeight = CO.doc.height;
      refreshSelection(); rebuild(); renderItems();
      $('cTextVal').focus(); $('cTextVal').select();
    });
    $('cAddImage').addEventListener('click', () => {
      composeWantsImage = true;
      $('imageFileInput').click();
    });
    $('cUndo').addEventListener('click', () => {
      if (!CO.undo()) return;
      refreshSelection(); rebuild(); renderItems();
    });
    $('cClear').addEventListener('click', () => {
      CO.clear(); refreshSelection(); rebuild(); renderItems();
    });
    $('pageFileInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';   // so the same file can be opened again
      if (file) openPageFile(file);
    });
    $('cDelete').addEventListener('click', () => {
      const it = CO.selected();
      if (!it) return;
      CO.remove(it.id);
      refreshSelection(); rebuild(); renderItems();
    });

    $('cTextVal').addEventListener('input', debounce(() => {
      editSelected((it) => { it.text = $('cTextVal').value; });
      renderItemList();
    }, 150));
    sel.font  = select('cFont', (v) => editSelected((it) => { it.font = v; }));
    sel.size  = slider('cSize', (v) => editSelected((it) => { it.size = v; }));
    sel.bold  = slider('cBold', (v) => editSelected((it) => { it.bolden = v; }), (v) => v.toFixed(2));
    sel.align = segset('cAlign', (v) => editSelected((it) => { it.align = v; }));
    sel.width = slider('cW', (v) => editSelected((it) => {
      if (it.kind === 'text') { CO.setTextLength(it, v); return; }
      const ratio = it.h / it.w;
      it.w = v;
      it.h = Math.max(8, Math.round(v * ratio));
    }));
    sel.rot = segset('cRot', (v) => {
      const it = CO.selected();
      if (!it) return;
      CO.rotate(it, parseInt(v, 10));
      cHeightCtl.set(CO.doc.height);
      S.cHeight = CO.doc.height;
      refreshSelection(); rebuild(); renderItems();
    });
    check('cInvert', (v) => editSelected((it) => { it.invert = v; }));
    $('cCentre').addEventListener('click', () => editSelected((it) => {
      it.x = Math.round((576 - it.w) / 2);
    }));
    $('cFront').addEventListener('click', () => {
      const it = CO.selected(); if (!it) return;
      CO.raise(it.id, true); rebuild(); renderItems(); renderItemList();
    });
    $('cBack').addEventListener('click', () => {
      const it = CO.selected(); if (!it) return;
      CO.raise(it.id, false); rebuild(); renderItems(); renderItemList();
    });
    refreshSelection();

    // test
    const testPattern = select('testPattern', (v) => {
      S.testPattern = v; save();
      const calib = v === 'calib';
      $('testWidthCtl').hidden = calib;
      $('testHeightCtl').hidden = calib;
      rebuild();
    });
    testPattern.set(S.testPattern);
    $('testWidthCtl').hidden = S.testPattern === 'calib';
    $('testHeightCtl').hidden = S.testPattern === 'calib';
    const testWidth = select('testWidth', (v) => { S.testWidth = parseInt(v, 10); save(); rebuild(); });
    testWidth.set(String(S.testWidth));
    const testH = slider('testH', (v) => { S.testH = v; save(); rebuildSoon(); });
    testH.set(S.testH);
    const feedLines = slider('feedLines', (v) => { S.feedLines = v; save(); });
    feedLines.set(S.feedLines);
    $('feedBtn').addEventListener('click', async () => {
      log(`Feeding ${S.feedLines} lines…`);
      const btn = $('feedBtn');
      btn.disabled = true;
      try {
        if (helperDoes('feed')) await helperCall('/api/feed', { lines: S.feedLines });
        else await ble.sendFrame(proto.CMD.FEED, new Uint8Array([S.feedLines & 0xff, 0x00]));
        log('Fed.');
      } catch (err) {
        log('Feed failed: ' + err.message, 'error');
      } finally {
        syncTalkControls();
      }
    });

    // printer
    const density = slider('density', (v) => { S.density = v; save(); });
    const speed   = slider('speed',   (v) => { S.speed = v; save(); });
    const feed    = slider('feed',    (v) => { S.feed = v; save(); });
    const legacyEl = document.getElementById('legacySender');
    if (legacyEl) {
      legacyEl.checked = !!S.legacy;
      legacyEl.addEventListener('change', () => { S.legacy = legacyEl.checked; save(); });
    }
    density.set(S.density); speed.set(S.speed); feed.set(S.feed);

    $('resetBtn').addEventListener('click', () => {
      Object.assign(S, DEFAULTS, { mode: S.mode, qText: S.qText, txtText: S.txtText });
      saveNow(S);
      location.reload();
    });

    // terminal
    const chunk = select('chunkSel', (v) => {
      S.chunk = parseInt(v, 10); save();
      ble.setChunkSize(S.chunk);
    });
    chunk.set(String(S.chunk));
    ble.setChunkSize(S.chunk);
    $('termClear').addEventListener('click', () => { $('termLog').textContent = ''; });
    $('gattBtn').addEventListener('click', async () => {
      const btn = $('gattBtn');
      btn.disabled = true;
      try {
        renderGatt(helperDoes('gatt')
          ? (await helperCall('/api/gatt')).services
          : await ble.listGatt());
      } catch (err) {
        log('Could not read the services: ' + err.message, 'error');
      } finally {
        syncTalkControls();
      }
    });
    const input = $('termInput');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { runTermCommand(input.value); input.value = ''; return; }
      if (e.key === 'ArrowUp' && historyAt > 0) {
        input.value = termHistory[--historyAt]; e.preventDefault();
      } else if (e.key === 'ArrowDown' && historyAt < termHistory.length - 1) {
        input.value = termHistory[++historyAt]; e.preventDefault();
      }
    });

    // drop and paste, anywhere on the window
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      if (!Array.from(e.dataTransfer.types).includes('Files')) return;
      dragDepth++;
      $('dropVeil').hidden = false;
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('dragleave', () => {
      if (--dragDepth <= 0) { dragDepth = 0; $('dropVeil').hidden = true; }
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      $('dropVeil').hidden = true;
      const file = e.dataTransfer.files[0];
      if (!file) return;
      if (/\.tp6page\.json$/i.test(file.name)) { openPageFile(file); return; }
      if (/^font\/|\.(ttf|otf|woff2?)$/i.test(file.type + file.name)) { loadFontFile(file); return; }
      // Dropping onto a page you are composing places the picture there
      // rather than throwing the page away for a new one.
      if (S.mode === 'draw') { placeImage(file); return; }
      setMode('image');
      loadImageFile(file);
    });
    window.addEventListener('paste', (e) => {
      const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'));
      if (!item) return;
      setMode('image');
      loadImageFile(item.getAsFile());
    });

    // keyboard
    const MODE_KEYS = ['image', 'quote', 'text', 'draw', 'test', 'term'];
    window.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); doPrint(); return; }
      // Shift+S saves the page as objects, plain S saves the flattened PNG.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault(); savePage(); return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); savePng(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault(); $('pageFileInput').click(); return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); $('drawerTab').click(); return; }
      if (e.key === 'Escape' && cropping) { exitCrop(false); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && S.mode === 'draw') {
        const it = CO.selected();
        if (it) {
          e.preventDefault();
          CO.remove(it.id);
          refreshSelection(); rebuild(); renderItems();
        }
        return;
      }
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= 6) setMode(MODE_KEYS[n - 1]);
    });

    // leaving mid-print loses the job and strands the paper under the head
    window.addEventListener('beforeunload', (e) => {
      if (ble.isPrinting()) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // TRANSPORT EVENTS
  // ─────────────────────────────────────────────────────────────

  function wireTransport() {
    ble.on('log', ({ message, level }) => log(message, level));

    ble.on('state', ({ connected, name }) => {
      const chip = $('linkChip');
      if (connected) {
        chip.dataset.state = 'on';
        $('linkName').textContent = name || 'Connected';
      } else {
        $('linkTelem').hidden = true;
        syncLinkChip();   // falls back to "Helper ready" if the helper is up
      }
      $('disconnectBtn').hidden = !connected;
      syncConnectBtn();          // owns connectBtn.hidden: a full helper hides it
      $('printBtn').disabled = !canPrint();
      syncTalkControls();
    });

    ble.on('chunk', (size) => { S.chunk = size; $('chunkSel').value = String(size); save(); });

    // Every notification goes to the terminal, whichever mode is showing —
    // the interesting ones arrive during a print, when you are looking at
    // the paper rather than at the terminal.
    ble.on('notify', (data) => {
      termLine(hexMode
        ? '« ' + proto.hex(data)
        : `« [${data.length}B] ` + proto.ascii(data), 'rx');
    });
  }

  // ─────────────────────────────────────────────────────────────
  // BOOT
  // ─────────────────────────────────────────────────────────────

  window.TP6.ui.initLog();
  wire();
  wireTransport();
  probeHelper();

  if (!ble.available()) {
    log('This browser has no Web Bluetooth. Use Chrome or Edge on desktop or Android — '
      + 'Firefox and Safari do not support it. Everything except printing still works.', 'warn');
  }

  if (!S.qText) S.qText = card.QUOTES[0];
  $('qText').value = S.qText;

  setMode(S.mode === 'image' ? 'image' : S.mode);
  log('Ready. Connect the printer, or compose first and connect later.', 'dim');

})();
