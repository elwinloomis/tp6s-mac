/* ============================================================
   ui.js — the small shared pieces: DOM lookup, the log drawer,
   the confirm dialog, control wiring and persistence.

   Classic script (not a module): the tool runs from a file:// URL
   with no server, where ES module imports are blocked.
   ============================================================ */

(function () {
  'use strict';

  window.TP6 = window.TP6 || {};

  const $  = (id) => document.getElementById(id);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ── settings ────────────────────────────────────────────────
  // One flat object in localStorage. The composed bitmap is never stored:
  // it is cheap to rebuild and expensive to keep, and a stale one would be
  // a lie about what is loaded.

  const STORE_KEY = 'tp6s.settings.v1';

  function loadSettings(defaults) {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    } catch (_) {
      /* corrupt or unavailable storage is not worth a message */
    }
    return Object.assign({}, defaults, saved);
  }

  let saveTimer = null;
  function saveSettings(settings) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(settings));
      } catch (_) { /* private mode, quota — the tool still works */ }
    }, 250);
  }

  // Bypasses the debounce for callers that are about to navigate away.
  function saveNow(settings) {
    clearTimeout(saveTimer);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (_) { /* ignore */ }
  }

  // ── IndexedDB key/value store ──────────────────────────────
  // A second persistence mechanism, alongside settings above: this one is
  // for data too large or too binary for localStorage — notably Blobs,
  // which IndexedDB structured-clones as-is, so a caller can round-trip an
  // object containing Blobs without any encoding step.
  //
  // Everything here degrades to null/false instead of throwing. Chrome is
  // documented as denying IndexedDB on file:// origins (indexedDB.open
  // throwing SecurityError synchronously), and file:// is this tool's whole
  // point, so "can't autosave" has to be a quiet no-op rather than a broken
  // page. Untested from file:// directly — the code assumes nothing either
  // way, which is the reason it catches so broadly.

  const KV_DB_NAME = 'tp6s';
  const KV_DB_VERSION = 1;
  const KV_STORE = 'kv';
  const KV_OPEN_TIMEOUT_MS = 2000;

  let kvDbPromise = null;  // the open connection, cached once it resolves
  let kvBroken = false;    // set once IndexedDB has proven unusable here

  // Opens (or returns the cached open of) the database. Resolves the live
  // connection on success, null on any failure — never rejects. Once it has
  // failed, later calls short-circuit without touching indexedDB.open again,
  // so a debounced autosave doesn't retry a doomed call on every keystroke.
  function kvOpen() {
    if (kvBroken) return Promise.resolve(null);
    if (kvDbPromise) return kvDbPromise;

    kvDbPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (db) => {
        if (settled) return;
        settled = true;
        if (!db) kvBroken = true;
        resolve(db);
      };

      // A hung open (seen in some private-mode / restricted contexts) must
      // not leave callers waiting forever.
      setTimeout(() => finish(null), KV_OPEN_TIMEOUT_MS);

      let req;
      try {
        req = indexedDB.open(KV_DB_NAME, KV_DB_VERSION);
      } catch (_) {
        finish(null);  // e.g. SecurityError on file://
        return;
      }

      req.onupgradeneeded = () => {
        try { req.result.createObjectStore(KV_STORE); } catch (_) { /* onerror will follow */ }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { try { db.close(); } catch (_) { /* ignore */ } kvBroken = true; };
        finish(db);
      };
      req.onerror = () => finish(null);
      req.onblocked = () => finish(null);  // another tab holds it open; treat as unavailable rather than wait
    });

    return kvDbPromise;
  }

  // Runs one request in its own transaction and resolves `fallback` instead
  // of rejecting for any failure along the way — bad transaction, quota, a
  // request that throws synchronously. For reads the resolved value comes
  // from the request; for writes success just means the transaction
  // committed, so the request's own result is not consulted.
  function kvTxn(mode, fallback, action) {
    return kvOpen().then((db) => {
      if (!db) return fallback;
      return new Promise((resolve) => {
        let tx;
        try {
          tx = db.transaction(KV_STORE, mode);
        } catch (_) {
          resolve(fallback);
          return;
        }
        let result = fallback;
        tx.onabort = () => resolve(fallback);
        tx.onerror = () => resolve(fallback);
        tx.oncomplete = () => resolve(result);
        try {
          const req = action(tx.objectStore(KV_STORE));
          if (mode === 'readonly') req.onsuccess = () => { result = req.result; };
          else result = true;
        } catch (_) {
          try { tx.abort(); } catch (_) { resolve(fallback); }
        }
      });
    }).catch(() => fallback);
  }

  const kv = {
    get(key) {
      return kvTxn('readonly', null, (store) => store.get(key))
        .then((v) => (v === undefined ? null : v));
    },
    set(key, value) {
      return kvTxn('readwrite', false, (store) => store.put(value, key));
    },
    del(key) {
      return kvTxn('readwrite', false, (store) => store.delete(key));
    },
    available() { return !kvBroken; },
  };

  // ── log drawer ──────────────────────────────────────────────
  // Collapsed it shows the last line, which is almost always the only one
  // you want. Expanded it is the full transcript. Progress lives in the
  // same strip so a running job is legible either way.

  const MAX_LOG_LINES = 600;

  function initLog() {
    const drawer = $('drawer');
    const tab = $('drawerTab');
    tab.addEventListener('click', () => {
      const open = drawer.dataset.open === 'true';
      drawer.dataset.open = String(!open);
      tab.setAttribute('aria-expanded', String(!open));
      if (!open) $('logOut').scrollTop = $('logOut').scrollHeight;
    });
    $('logClear').addEventListener('click', () => {
      $('logOut').textContent = '';
      $('drawerLast').textContent = '';
      $('drawerLast').className = 'drawer__last';
    });
  }

  const LEVEL_CLASS = { error: 'er', warn: 'wa', dim: 'dim' };

  function log(message, level) {
    const out = $('logOut');
    if (!out) return;
    const line = document.createElement('div');
    if (LEVEL_CLASS[level]) line.className = LEVEL_CLASS[level];
    line.textContent = message;
    out.appendChild(line);
    while (out.childElementCount > MAX_LOG_LINES) out.removeChild(out.firstChild);
    out.scrollTop = out.scrollHeight;

    const last = $('drawerLast');
    last.textContent = message.trim();
    last.className = 'drawer__last' + (level === 'error' ? ' er' : '');
  }

  function progress(pct) {
    const wrap = $('progWrap');
    if (pct === null) { wrap.hidden = true; return; }
    wrap.hidden = false;
    $('progFill').style.width = Math.max(0, Math.min(100, pct)) + '%';
    $('progPct').textContent = Math.round(pct) + '%';
  }

  // ── confirm dialog ──────────────────────────────────────────
  // rows: array of [label, value] pairs, plus optional warning strings.

  function confirm(title, rows, warnings, okLabel) {
    const dlg = $('confirmDlg');
    $('confirmTitle').textContent = title;
    $('confirmOk').textContent = okLabel || 'Print';

    const body = $('confirmBody');
    body.textContent = '';
    rows.forEach(([label, value]) => {
      const div = document.createElement('div');
      div.textContent = label + '  ';
      const b = document.createElement('b');
      b.textContent = value;
      div.appendChild(b);
      body.appendChild(div);
    });
    (warnings || []).forEach((text) => {
      const p = document.createElement('p');
      p.className = 'warn';
      p.textContent = text;
      body.appendChild(p);
    });

    return new Promise((resolve) => {
      const done = () => {
        dlg.removeEventListener('close', done);
        resolve(dlg.returnValue === 'ok');
      };
      dlg.addEventListener('close', done);
      dlg.returnValue = 'cancel';
      dlg.showModal();
    });
  }

  // ── control wiring ──────────────────────────────────────────

  // A slider plus its live readout. `format` turns the raw value into what
  // the readout shows; `onInput` receives the parsed number.
  function slider(id, onInput, format) {
    const el = $(id);
    const out = $(id + 'V');
    const fmt = format || ((v) => String(v));
    const paint = () => { if (out) out.textContent = fmt(parseFloat(el.value)); };
    el.addEventListener('input', () => { paint(); onInput(parseFloat(el.value)); });
    paint();
    return {
      el,
      set(v) { el.value = v; paint(); },
      get() { return parseFloat(el.value); },
    };
  }

  // A row of buttons behaving as one exclusive choice. Values live in
  // data-v, which keeps the markup readable and the state out of classes.
  function segset(id, onPick) {
    const root = $(id);
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || !root.contains(btn)) return;
      pick(btn.dataset.v);
      onPick(btn.dataset.v);
    });
    function pick(value) {
      $$('button', root).forEach((b) => b.classList.toggle('is-on', b.dataset.v === String(value)));
    }
    return {
      set: pick,
      get() {
        const on = root.querySelector('button.is-on');
        return on ? on.dataset.v : null;
      },
    };
  }

  function check(id, onChange) {
    const el = $(id);
    el.addEventListener('change', () => onChange(el.checked));
    return { el, set(v) { el.checked = !!v; }, get() { return el.checked; } };
  }

  function select(id, onChange) {
    const el = $(id);
    el.addEventListener('change', () => onChange(el.value));
    return { el, set(v) { el.value = v; }, get() { return el.value; } };
  }

  // Coalesce bursts of slider input into one rebuild per frame. Rasterising
  // a tall strip is milliseconds, but doing it on every input event of a
  // drag still makes the handle feel sticky.
  function raf(fn) {
    let queued = false;
    return function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; fn(); });
    };
  }

  function debounce(fn, ms) {
    let t = null;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  // ── formatting ──────────────────────────────────────────────

  const DPI = 300;

  // Paper length for a given number of printed lines. The roll is finite and
  // a tall source eats a surprising amount of it, so this is shown before
  // every print rather than after.
  function paperLength(lines) {
    const mm = (lines / DPI) * 25.4;
    return {
      mm,
      text: mm >= 1000 ? (mm / 1000).toFixed(2) + ' m' : Math.round(mm) + ' mm',
    };
  }

  function pct(x) { return Math.round(x * 100) + '%'; }

  window.TP6.ui = {
    $, $$,
    loadSettings, saveSettings, saveNow,
    kv,
    initLog, log, progress, confirm,
    slider, segset, check, select,
    raf, debounce,
    paperLength, pct,
  };
})();
