/* ============================================================
   compose.js — the layout surface: freehand strokes, placed
   pictures and text, on one page the width of the head.

   Everything is measured in printer dots, never in screen pixels.
   The page is 576 dots across because the head is, and an item at
   x = 288 is at the middle of the paper at any zoom. The screen
   only ever scales that.

   One halftone runs over the finished page rather than one per
   item, which sounds lossy and is not: error diffusion leaves
   solid black solid and solid white white, so type and line art
   pass through untouched while a photograph beside them still
   dithers properly.

   Depends on TP6.raster.
   ============================================================ */

(function () {
  'use strict';

  window.TP6 = window.TP6 || {};
  const R = window.TP6.raster;
  const W = R.PRINT_W;

  let nextId = 1;

  const doc = {
    height: 576,
    items: [],
    strokes: null,   // transparent canvas: the freehand layer, drawn on top
  };

  let selectedId = null;
  const history = [];
  const HISTORY_MAX = 12;

  function strokeLayer() {
    if (!doc.strokes) {
      doc.strokes = document.createElement('canvas');
      doc.strokes.width = W;
      doc.strokes.height = doc.height;
    }
    if (doc.strokes.height !== doc.height) {
      // Keep the marks that are already down when the page grows or shrinks.
      const keep = document.createElement('canvas');
      keep.width = doc.strokes.width;
      keep.height = doc.strokes.height;
      keep.getContext('2d').drawImage(doc.strokes, 0, 0);
      doc.strokes.height = doc.height;
      doc.strokes.getContext('2d').drawImage(keep, 0, 0);
    }
    return doc.strokes;
  }

  // ── history ─────────────────────────────────────────────────
  // Two kinds of change, recorded in one ordered stack so Undo always steps
  // back through what actually happened rather than through one channel at a
  // time. Stroke snapshots are the expensive kind, so they are only taken at
  // the start of a stroke, never per pointer move.

  function pushUndo(kind) {
    if (kind === 'strokes') {
      const c = strokeLayer();
      history.push({ kind, data: c.getContext('2d').getImageData(0, 0, c.width, c.height) });
    } else {
      history.push({ kind: 'items', data: doc.items.map((i) => Object.assign({}, i)), selected: selectedId });
    }
    while (history.length > HISTORY_MAX) history.shift();
  }

  function undo() {
    const step = history.pop();
    if (!step) return false;
    if (step.kind === 'strokes') {
      const c = strokeLayer();
      c.getContext('2d').putImageData(step.data, 0, 0);
    } else {
      doc.items = step.data;
      selectedId = step.selected;
      if (!doc.items.some((i) => i.id === selectedId)) selectedId = null;
    }
    return true;
  }

  function canUndo() { return history.length > 0; }

  // ── items ───────────────────────────────────────────────────

  function addImage(bitmap, name) {
    pushUndo('items');
    // Land it at two thirds of the head width, which reads as "placed" rather
    // than "pasted to the edges" and leaves somewhere obvious to drag from.
    const w = Math.round(W * 0.66);
    const h = Math.round(w * bitmap.height / bitmap.width);
    const item = {
      id: nextId++, kind: 'image', name: name || 'picture',
      bitmap, x: Math.round((W - w) / 2), y: 40, w, h, invert: false, rot: 0,
    };
    doc.items.push(item);
    selectedId = item.id;
    growToFit(item);
    return item;
  }

  function addText(text) {
    pushUndo('items');
    const w = Math.round(W * 0.84);
    const item = {
      id: nextId++, kind: 'text',
      text: text || 'Type here',
      font: 'Special Elite', size: 44, lineHeight: 1.2,
      align: 'center', bolden: 0, rot: 0,
      x: Math.round((W - w) / 2), y: 40, w, h: 60,
    };
    doc.items.push(item);
    selectedId = item.id;
    measureText(item);
    growToFit(item);
    return item;
  }

  // The page is a roll, not a fixed sheet, so an item dropped past the end
  // extends the paper instead of being clipped by it.
  function growToFit(item) {
    const need = item.y + item.h + 40;
    if (need > doc.height) doc.height = Math.min(4000, Math.ceil(need / 8) * 8);
  }

  // Quarter turns only, and deliberately: x/y/w/h stay the item's FOOTPRINT
  // on the page, axis-aligned, so dragging, hit-testing and the page-growing
  // rule need to know nothing about angle. Only the content turns inside that
  // box. A free angle would also hand the halftone a soft diagonal edge to
  // chew on, which a 1-bit head has no way to render honestly.
  function rotate(item, deg) {
    if (!item) return item;
    pushUndo('items');
    const next = (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
    const swaps = (next % 180) !== ((item.rot | 0) % 180);
    item.rot = next;
    if (swaps) {
      // Turn about the box's own centre, so the item stays where it was put
      // instead of springing back towards the corner it is anchored at.
      const midX = item.x + item.w / 2;
      const midY = item.y + item.h / 2;
      let w = item.h, h = item.w;
      // A tall picture turned sideways can come out wider than the head, and
      // the paper is the one dimension that cannot give — scale to fit rather
      // than let it run off the edge, where it would be cropped in silence.
      if (item.kind === 'image' && w > W) { h = Math.max(8, Math.round(h * W / w)); w = W; }
      item.w = w;
      item.h = h;
      item.x = Math.round(midX - w / 2);
      item.y = Math.max(0, Math.round(midY - h / 2));
      // The swap has just moved which side of the box the lines run along,
      // so the derived side has to be measured again from the words.
      if (item.kind === 'text') measureText(item);
    }
    growToFit(item);
    return item;
  }

  function remove(id) {
    pushUndo('items');
    doc.items = doc.items.filter((i) => i.id !== id);
    if (selectedId === id) selectedId = null;
  }

  function raise(id, toFront) {
    pushUndo('items');
    const i = doc.items.findIndex((it) => it.id === id);
    if (i < 0) return;
    const [item] = doc.items.splice(i, 1);
    if (toFront) doc.items.push(item); else doc.items.unshift(item);
  }

  function get(id) { return doc.items.find((i) => i.id === id) || null; }
  function selected() { return get(selectedId); }
  function select(id) { selectedId = id; }

  // Topmost item under the point, so clicking overlapping items picks the one
  // you can actually see.
  function hitTest(x, y) {
    for (let i = doc.items.length - 1; i >= 0; i--) {
      const it = doc.items[i];
      if (x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h) return it;
    }
    return null;
  }

  // ── text ────────────────────────────────────────────────────

  function wrap(cx, text, boxW) {
    const out = [];
    String(text).split('\n').forEach((hard) => {
      if (!hard.trim() || cx.measureText(hard).width <= boxW) { out.push(hard); return; }
      let line = '';
      hard.split(' ').forEach((word) => {
        const trial = line ? line + ' ' + word : word;
        if (!line || cx.measureText(trial).width <= boxW) line = trial;
        else { out.push(line); line = word; }
      });
      if (line) out.push(line);
    });
    return out;
  }

  // The side of the box the lines run along. Upright that is the box width;
  // turned a quarter, the lines run down the page instead, so the box height
  // is what the words have to fit into.
  function textLength(item) {
    return ((item.rot | 0) % 180) ? item.h : item.w;
  }

  // A text box owns its line length; the depth across the lines always
  // follows the wrapped content, so there is no way to end up with a box
  // that lies about what is in it. Which of w/h is which depends on the turn.
  function measureText(item) {
    const cx = document.createElement('canvas').getContext('2d');
    cx.font = item.size + 'px "' + item.font + '"';
    const lines = wrap(cx, item.text, textLength(item));
    item.lines = lines;
    const depth = Math.max(item.size, Math.ceil(lines.length * item.size * item.lineHeight));
    if ((item.rot | 0) % 180) item.w = depth; else item.h = depth;
    return item;
  }

  function setTextLength(item, len) {
    if ((item.rot | 0) % 180) item.h = len; else item.w = len;
    return measureText(item);
  }

  function drawText(cx, item) {
    const rot = item.rot | 0;
    if (!rot) { paintText(cx, item, item.x, item.y, item.w); return; }
    // Turn the context rather than rendering the type into an intermediate
    // canvas and rotating that: the page is composited at 2x and box-averaged
    // down, and an intermediate at dot resolution would throw that away —
    // rotated type would come out measurably worse than upright type.
    cx.save();
    cx.translate(item.x + item.w / 2, item.y + item.h / 2);
    cx.rotate(rot * Math.PI / 180);
    const len = textLength(item);
    const depth = (rot % 180) ? item.w : item.h;
    paintText(cx, item, -len / 2, -depth / 2, len);
    cx.restore();
  }

  // Lays the wrapped lines out from (x0, y0) across a box `len` wide, in
  // whatever frame the caller has already set up.
  function paintText(cx, item, x0, y0, len) {
    cx.font = item.size + 'px "' + item.font + '"';
    cx.textBaseline = 'alphabetic';
    cx.fillStyle = '#000';
    if (item.bolden > 0) {
      cx.strokeStyle = '#000';
      cx.lineJoin = 'round';
      cx.lineWidth = item.bolden;
    }
    const lines = item.lines || wrap(cx, item.text, len);
    lines.forEach((line, i) => {
      const lw = cx.measureText(line).width;
      let x = x0;
      if (item.align === 'center') x = x0 + (len - lw) / 2;
      if (item.align === 'right')  x = x0 + (len - lw);
      const y = y0 + i * item.size * item.lineHeight + item.size * 0.8;
      cx.fillText(line, x, y);
      if (item.bolden > 0) cx.strokeText(line, x, y);
    });
  }

  // ── rendering ───────────────────────────────────────────────

  // Composited at 2x and box-averaged back down where the page is small
  // enough to afford it. Same reasoning as the quote card: rasterising a
  // glyph at final size leaves every edge dot to the browser's gamma-adjusted
  // antialiasing, which biases stems thin and uneven. Averaging real coverage
  // makes the cut land where the outline is.
  function superSample() {
    return W * 2 * doc.height * 2 <= 16e6 ? 2 : 1;
  }

  function drawPicture(cx, item) {
    const rot = item.rot | 0;
    // Inside the turned frame the drawn rectangle's sides swap over, which is
    // what keeps the footprint on the page exactly item.w x item.h.
    const dw = (rot % 180) ? item.h : item.w;
    const dh = (rot % 180) ? item.w : item.h;
    let src = item.bitmap;
    if (item.invert) {
      // Inverting has to happen on the item alone, not on the page, so
      // one picture can be white-on-black beside black-on-white type.
      const tmp = document.createElement('canvas');
      tmp.width = Math.max(1, Math.round(dw));
      tmp.height = Math.max(1, Math.round(dh));
      const tx = tmp.getContext('2d');
      tx.fillStyle = '#fff';
      tx.fillRect(0, 0, tmp.width, tmp.height);
      tx.drawImage(item.bitmap, 0, 0, tmp.width, tmp.height);
      tx.globalCompositeOperation = 'difference';
      tx.fillStyle = '#fff';
      tx.fillRect(0, 0, tmp.width, tmp.height);
      src = tmp;
    }
    if (!rot) { cx.drawImage(src, item.x, item.y, dw, dh); return; }
    cx.save();
    cx.translate(item.x + item.w / 2, item.y + item.h / 2);
    cx.rotate(rot * Math.PI / 180);
    cx.drawImage(src, -dw / 2, -dh / 2, dw, dh);
    cx.restore();
  }

  function render() {
    const ss = superSample();
    const big = document.createElement('canvas');
    big.width = W * ss;
    big.height = doc.height * ss;
    const cx = big.getContext('2d');
    cx.scale(ss, ss);
    cx.fillStyle = '#fff';
    cx.fillRect(0, 0, W, doc.height);
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';

    doc.items.forEach((item) => {
      if (item.kind === 'image') drawPicture(cx, item);
      else drawText(cx, item);
    });

    // Freehand sits on top: you draw over what is already placed.
    cx.drawImage(strokeLayer(), 0, 0, W, doc.height);

    if (ss === 1) return big;

    const out = document.createElement('canvas');
    out.width = W;
    out.height = doc.height;
    const ox = out.getContext('2d');
    ox.imageSmoothingEnabled = true;
    ox.imageSmoothingQuality = 'high';
    ox.drawImage(big, 0, 0, W, doc.height);
    return out;
  }

  // ── freehand ────────────────────────────────────────────────

  let penLast = null;

  function penDown(x, y, opts) {
    pushUndo('strokes');
    const cx = strokeLayer().getContext('2d');
    applyPen(cx, opts);
    cx.beginPath();
    cx.arc(x, y, opts.size / 2, 0, Math.PI * 2);
    cx.fill();
    penLast = [x, y];
  }

  function penMove(x, y, opts) {
    if (!penLast) return;
    const cx = strokeLayer().getContext('2d');
    applyPen(cx, opts);
    cx.lineWidth = opts.size;
    cx.lineCap = 'round';
    cx.lineJoin = 'round';
    cx.beginPath();
    cx.moveTo(penLast[0], penLast[1]);
    cx.lineTo(x, y);
    cx.stroke();
    penLast = [x, y];
  }

  function penUp() { penLast = null; }

  // The eraser clears the freehand layer rather than painting white, so it
  // takes back your own marks without punching a hole in the picture
  // underneath. Erasing a placed item is what Delete is for.
  function applyPen(cx, opts) {
    if (opts.erase) {
      cx.globalCompositeOperation = 'destination-out';
      cx.strokeStyle = cx.fillStyle = 'rgba(0,0,0,1)';
    } else {
      cx.globalCompositeOperation = 'source-over';
      cx.strokeStyle = cx.fillStyle = '#000';
    }
  }

  function clear() {
    pushUndo('items');
    doc.items = [];
    selectedId = null;
    const c = strokeLayer();
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
  }

  function setHeight(h) {
    doc.height = h;
    strokeLayer();
  }

  // ── the page as a document ──────────────────────────────────
  //
  // Save PNG flattens the page to dots and throws away everything that made
  // them — where things sit, what the words are, which face they are set in.
  // This is the other half: the page as objects, so it can be reopened and
  // still be editable.
  //
  // toDoc() produces Blobs rather than base64. IndexedDB structured-clones a
  // Blob natively, so the autosave path stores what comes out of here as-is;
  // only the file path pays for base64, and it pays once, at the end.

  // A placed picture is drawn at 576 dots or less however big its source is,
  // so this is already far past what the head can resolve. The cap is there
  // to stop a phone photo turning a small page into an 8 MB document.
  const MAX_STORED = 1600;

  // Cached on the item, because geometry changes constantly while the
  // picture behind it never does: without this, a debounced autosave would
  // re-encode every picture on the page on every drag.
  function encodePicture(item) {
    if (item.stored) return Promise.resolve(item.stored);
    return R.toStoredImage(item.bitmap, MAX_STORED).then((blob) => {
      item.stored = blob;
      return blob;
    });
  }

  function encodeStrokes() {
    const c = doc.strokes;
    if (!c) return Promise.resolve(null);
    const cx = c.getContext('2d');
    const px = cx.getImageData(0, 0, c.width, c.height).data;
    // A blank layer is the common case, and an empty PNG in every document
    // is noise. Alpha is what carries the marks here — the eraser works by
    // clearing it — so alpha is what decides whether anything was drawn.
    let inked = false;
    for (let i = 3; i < px.length; i += 4) { if (px[i]) { inked = true; break; } }
    if (!inked) return Promise.resolve(null);
    return new Promise((resolve) => { c.toBlob(resolve, 'image/png'); });
  }

  // The compose half of a document. The envelope around it — format, version,
  // which mode it came from, the render settings — belongs to whoever is doing
  // the saving; this file knows about pages, not about files.
  async function toPayload() {
    const items = [];
    for (const it of doc.items) {
      if (it.kind === 'image') {
        items.push({
          kind: 'image', name: it.name,
          x: it.x, y: it.y, w: it.w, h: it.h, rot: it.rot | 0,
          invert: !!it.invert, src: await encodePicture(it),
        });
      } else {
        // h is written for a reader's benefit and ignored on the way back in:
        // the depth across the lines is always re-measured from the words,
        // because a machine without this face installed will wrap it
        // differently and the box has to follow what is actually there.
        items.push({
          kind: 'text', text: it.text, font: it.font, size: it.size,
          lineHeight: it.lineHeight, align: it.align, bolden: it.bolden,
          x: it.x, y: it.y, w: it.w, h: it.h, rot: it.rot | 0,
        });
      }
    }
    return {
      height: doc.height,
      strokes: await encodeStrokes(),
      items,
    };
  }

  // Item ids are deliberately not stored: they only ever mean something
  // within one session, and array order already carries the stacking. Making
  // them fresh on the way in means a loaded page can never collide with the
  // counter, rather than having to be reconciled with it.
  async function fromPayload(d) {
    if (!d) throw new Error('no page in that document');
    const items = [];
    for (const raw of (d.items || [])) {
      if (raw.kind === 'image') {
        const blob = raw.src;
        if (!blob) continue;
        const bitmap = await createImageBitmap(blob);
        items.push({
          id: nextId++, kind: 'image', name: raw.name || 'picture', bitmap,
          x: raw.x, y: raw.y, w: raw.w, h: raw.h,
          rot: raw.rot | 0, invert: !!raw.invert,
          // Hand back the very blob it was loaded from, so a page that is
          // opened and saved again re-encodes nothing.
          stored: blob,
        });
      } else {
        const it = {
          id: nextId++, kind: 'text', text: raw.text || '',
          font: raw.font, size: raw.size, lineHeight: raw.lineHeight,
          align: raw.align, bolden: raw.bolden || 0,
          x: raw.x, y: raw.y, w: raw.w, h: raw.h, rot: raw.rot | 0,
        };
        measureText(it);
        items.push(it);
      }
    }

    doc.items = items;
    doc.height = d.height || 576;
    selectedId = null;
    history.length = 0;   // nothing before an open is anything you can go back to
    doc.strokes = null;
    const layer = strokeLayer();
    if (d.strokes) {
      const marks = await createImageBitmap(d.strokes);
      layer.getContext('2d').drawImage(marks, 0, 0);
    }
    return doc;
  }

  // Distinct type families the page depends on. A family that is not
  // installed is substituted in silence by the canvas, so a caller needs to
  // be able to say so out loud.
  function fontsUsed() {
    const seen = [];
    doc.items.forEach((it) => {
      if (it.kind === 'text' && it.font && seen.indexOf(it.font) < 0) seen.push(it.font);
    });
    return seen;
  }

  window.TP6.compose = {
    doc, render, setHeight,
    addImage, addText, remove, raise, rotate, get, selected, select, hitTest,
    measureText, textLength, setTextLength, wrap,
    penDown, penMove, penUp, clear,
    pushUndo, undo, canUndo,
    toPayload, fromPayload, fontsUsed,
  };
})();
