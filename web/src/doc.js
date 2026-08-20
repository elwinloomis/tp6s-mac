/* ============================================================
   doc.js — the document format: what a saved page IS, how it
   becomes a file, and how it is kept across a reload.

   Save PNG flattens a page to dots and keeps nothing of what
   made them. A document is the other half: the objects, the
   words, the settings — reopenable and still editable.

   This file owns the format and the plumbing (base64 <-> Blob,
   the download, the autosave store). It deliberately knows
   nothing about any particular mode: app.js captures and applies
   each mode's payload, because that is where the controls and
   the state live.

   Depends on TP6.ui (for the IndexedDB store).
   Classic script, like everything else here — the tool has to
   run from a file:// URL with no server.
   ============================================================ */

(function () {
  'use strict';

  window.TP6 = window.TP6 || {};

  const FORMAT = 'tp6-page';
  const VERSION = 1;
  const EXT = '.tp6page.json';
  const HEAD_W = 576;

  // ── base64 <-> Blob ─────────────────────────────────────────
  //
  // A document carries Blobs, because that is what the autosave store takes
  // natively and what costs nothing to keep. Only the file has to be text,
  // and it pays for base64 once, on the way out.

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('a stored picture could not be read'));
      fr.readAsDataURL(blob);
    });
  }

  // Decoded by hand rather than with fetch('data:…'), because this page has
  // to keep working from a file:// URL, where fetch is the first thing to be
  // denied. It is a few lines and it works everywhere.
  function dataURLToBlob(url) {
    const comma = String(url).indexOf(',');
    if (comma < 0) throw new Error('a stored picture is not a data URL');
    const mime = (url.slice(0, comma).match(/:([^;,]+)/) || [, 'image/png'])[1];
    const bin = atob(url.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  // Blobs can be anywhere in a payload — a picture's `src`, the freehand
  // layer, whatever a future mode needs — so both directions walk the whole
  // structure rather than naming fields. A mode that adds a binary field
  // gets saving and loading for free instead of a bug.
  async function deflate(value) {
    if (value instanceof Blob) return { $blob: await blobToDataURL(value) };
    if (Array.isArray(value)) {
      const out = [];
      for (const v of value) out.push(await deflate(v));
      return out;
    }
    if (value && typeof value === 'object') {
      const out = {};
      for (const k of Object.keys(value)) out[k] = await deflate(value[k]);
      return out;
    }
    return value;
  }

  function inflate(value) {
    if (value && typeof value === 'object' && typeof value.$blob === 'string') {
      return dataURLToBlob(value.$blob);
    }
    if (Array.isArray(value)) return value.map(inflate);
    if (value && typeof value === 'object') {
      const out = {};
      Object.keys(value).forEach((k) => { out[k] = inflate(value[k]); });
      return out;
    }
    return value;
  }

  // ── the envelope ────────────────────────────────────────────

  // `width` records the head this was composed for. It is always 576 today,
  // and it is written down anyway so a document from some future 384-dot
  // machine is refused with a reason instead of silently misplacing
  // everything on the page.
  function envelope(mode, payload, render) {
    const d = {
      format: FORMAT,
      version: VERSION,
      mode,
      saved: new Date().toISOString(),
      width: HEAD_W,
      render: render || null,
    };
    d[mode] = payload;
    return d;
  }

  // Files written before documents grew a mode field are Compose pages with
  // their payload at the top level. Rather than carry two readers around,
  // they are reshaped once, here, into what the rest of the code expects.
  function migrate(d) {
    if (d.mode) return d;
    return {
      format: d.format, version: d.version, mode: 'draw',
      saved: d.saved,
      width: (d.page && d.page.width) || HEAD_W,
      render: d.render || null,
      draw: {
        height: (d.page && d.page.height) || 576,
        strokes: d.strokes || null,
        items: d.items || [],
      },
    };
  }

  function check(d) {
    if (!d || d.format !== FORMAT) throw new Error('not a TP6-S page file');
    if ((d.version | 0) > VERSION) throw new Error('saved by a newer version of the tool');
    if (d.width && d.width !== HEAD_W) {
      throw new Error(`made for a ${d.width}-dot head, this one is ${HEAD_W}`);
    }
    if (!d.mode || !d[d.mode]) throw new Error('there is no page inside that file');
    return d;
  }

  async function toText(d) {
    return JSON.stringify(await deflate(d), null, 1);
  }

  function fromText(text) {
    return check(inflate(migrate(JSON.parse(text))));
  }

  function stamp() {
    const t = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}`;
  }

  // Named for what is inside it, so a folder of these can be read at a
  // glance rather than opened one at a time.
  function download(text, mode) {
    const name = `tp6-${mode}-${stamp()}${EXT}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return name;
  }

  // ── keeping a page across a reload ──────────────────────────
  //
  // A different job from saving a file: not portability, but not losing the
  // page to a reload. One record per mode, so coming back to a mode finds
  // what was there rather than only whatever was open last.

  const kv = window.TP6.ui.kv;
  const RECORD = (mode) => 'autosave:' + mode;

  // Blobs go in as they are — IndexedDB structured-clones them natively, so
  // the autosave path never pays the base64 tax the file path does.
  function keep(mode, d) { return kv.set(RECORD(mode), d); }

  async function recall(mode) {
    const d = await kv.get(RECORD(mode));
    if (!d) return null;
    try { return check(migrate(d)); } catch (err) { return null; }
  }

  function forget(mode) { return kv.del(RECORD(mode)); }

  function storageAvailable() { return kv.available(); }

  // ── type ────────────────────────────────────────────────────

  // A family this machine does not have is substituted by the canvas without
  // a word, so a page saved on one Mac can silently set differently on the
  // other. Probing by metrics is a guess — a face that measures exactly like
  // monospace would slip through — but a page that looks wrong with no
  // explanation is worse than an occasional false negative.
  function missingFonts(families) {
    if (!families || !families.length) return [];
    const cx = document.createElement('canvas').getContext('2d');
    const probe = 'HAMBURGEFONTSIV hamburgefonstiv 0123456789';
    cx.font = '72px monospace';
    const base = cx.measureText(probe).width;
    return families.filter((f) => {
      if (!f) return false;
      cx.font = `72px "${f}", monospace`;
      return cx.measureText(probe).width === base;
    });
  }

  window.TP6.doc = {
    EXT, VERSION, HEAD_W,
    envelope, check, toText, fromText, download,
    keep, recall, forget, storageAvailable,
    missingFonts,
  };
})();
