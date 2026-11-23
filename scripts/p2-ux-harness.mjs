// P2-16 — shared DOM-stub harness for the full-rollout checks + tests.
// Boots the REAL app script (last <script> block of app/index.html) under a
// minimal DOM stub, mirroring the P2-15 tracer / hardening stub conventions.
// Zero deps. Exposes click / keyboard / search / detail navigation so the
// comprehension, performance, guardrail and DOM checks run the actual client.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const APP_HTML_PATH = resolve(ROOT, 'app', 'index.html');
export const APP_DATA_PATH = resolve(ROOT, 'app', 'data.json');

export function loadApp() {
  const html = readFileSync(APP_HTML_PATH, 'utf8');
  const appScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).pop();
  const data = JSON.parse(readFileSync(APP_DATA_PATH, 'utf8'));
  return { html, appScript, data };
}

export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// runApp(data, appScript) -> functional stub. `data` defaults to the built
// app/data.json (full mode). The stub emulates the DOM APIs the client uses:
// getElementById, querySelectorAll (regex-backed), createElement (photo
// hydration), addEventListener (click + keydown), localStorage, location.hash.
export function runApp(data, appScript, { storageThrows = false, search = '' } = {}) {
  const handlers = {};
  const keyHandlers = {};
  const push = (kind, id, fn) => { (handlers[kind] = handlers[kind] || []).push({ id, fn }); };
  const pushKey = (kind, id, fn) => { (keyHandlers[kind] = keyHandlers[kind] || []).push({ id, fn }); };
  const store = {};
  const main = {
    innerHTML: '',
    addEventListener() {},
    querySelectorAll(sel) {
      const out = [];
      const pats = {
        '.range-chip': [/<button class="range-chip" data-chip="([^"]+)"/g, 'chip'],
        '[data-dept]': [/<button class="dept-item" data-dept="([^"]+)"/g, 'dept'],
        '.preset': [/<button class="preset" data-preset="([^"]+)"/g, 'preset'],
        '[data-toggle-floor]': [/<button class="text-btn" data-toggle-floor="([^"]+)"/g, 'floor'],
        '.row': [/<button class="row[^"]*" data-ean="([^"]+)"/g, 'row'],
        '[data-flagged-only]': [/data-flagged-only/g, 'flagged'],
        '[data-open-sheet]': [/<button class="filter-btn" data-open-sheet/g, 'openSheet'],
        '[data-close-sheet]': [/data-close-sheet/g, 'closeSheet'],
        '[data-halal-only]': [/<button class="filter-btn" data-halal-only/g, 'halal'],
        '[data-watch-more]': [/<button class="watch-more" data-watch-more/g, 'watchMore'],
        '[data-watch-ean]': [/<button class="watch-card" data-watch-ean="([^"]+)"/g, 'watch'],
        '[data-swap-ean]': [/data-swap-ean="([^"]+)"/g, 'swap'],
        '[data-request-ean]': [/data-request-ean="([^"]+)"/g, 'request'],
        '[data-expand-tags]': [/<span class="tag-more"[^>]*data-expand-tags="([^"]+)"/g, 'expandTags'],
        '[data-expand-ing]': [/<button class="text-btn" data-expand-ing="([^"]+)"/g, 'expandIng'],
        '[data-toggle-dose]': [/<button class="text-btn" data-toggle-dose="([^"]+)"/g, 'dose'],
        '[data-expand-sfa]': [/<button class="text-btn" data-expand-sfa="([^"]+)"/g, 'sfa'],
        '[data-toggle-box]': [/data-toggle-box="([^"]+)"/g, 'box'],
        '[data-toggle-proof]': [/data-toggle-proof="([^"]+)"/g, 'proof'],
        '[data-toggle-footer]': [/data-toggle-footer/g, 'footer'],
        '[data-remove-filter]': [/data-remove-filter="([^"]+)"/g, 'removeFilter'],
        '[data-clear-filters]': [/<button class="text-btn" data-clear-filters>/g, 'clearFilters'],
        '[data-clear-search]': [/<button class="text-btn" data-clear-search>/g, 'clearSearch'],
        '[data-download-requests]': [/<button class="text-btn" data-download-requests>/g, 'download'],
        '[data-pack-src]': [/data-pack-src="([^"]*)" data-pack-alt="([^"]*)" data-pack-icon="([^"]*)"/g, 'pack'],
      };
      const p = pats[sel];
      if (!p) return out;
      for (const m of main.innerHTML.matchAll(p[0])) {
        const id = m[1] ?? '';
        if (p[1] === 'pack') {
          out.push({
            innerHTML: '', _img: null,
            getAttribute: (name) => (name === 'data-pack-src' ? m[1] : name === 'data-pack-alt' ? m[2] : name === 'data-pack-icon' ? m[3] : null),
            appendChild(node) { this._img = node; },
            addEventListener: (ev, fn) => { if (ev === 'click') push(p[1], id, fn); },
          });
        } else {
          out.push({
            getAttribute: () => id,
            addEventListener: (ev, fn) => { if (ev === 'click') push(p[1], id, fn); else if (ev === 'keydown') pushKey(p[1], id, fn); },
          });
        }
      }
      return out;
    },
  };
  const searchInput = { value: '', addEventListener: (ev, fn) => { if (ev === 'input') push('input', '', fn); } };
  // P3-05: every created element is captured so tests can inspect the imgs
  // hydratePhotos() built at boot (slot stubs are re-created per query).
  const createdEls = [];
  const documentStub = {
    getElementById: (id) => (id === 'main' ? main : id === 'hh-search' ? searchInput : { textContent: '' }),
    createElement: () => {
      const el = { attrs: {} };
      for (const k of ['src', 'alt', 'width', 'height', 'loading', 'decoding', 'onerror']) {
        Object.defineProperty(el, k, { configurable: true, set(v) { this.attrs[k] = v; }, get() { return this.attrs[k]; } });
      }
      createdEls.push(el);
      return el;
    },
    body: { appendChild() {}, removeChild() {} },
  };
  const locationStub = { hash: '', href: '', search };
  const windowStub = {
    __HEALTHHAWK_DATA__: data,
    addEventListener: (ev, fn) => { if (ev === 'hashchange') windowStub._hashchange = fn; },
    localStorage: {
      getItem: (k) => { if (storageThrows) throw new Error('storage unavailable'); return store[k] ?? null; },
      setItem: (k, v) => { if (storageThrows) throw new Error('storage unavailable'); store[k] = String(v); },
    },
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'location', appScript)(windowStub, documentStub, locationStub);

  const click = (kind, id = '') => { const h = (handlers[kind] || []).filter((c) => c.id === id).pop(); if (!h) throw new Error(`no ${kind} handler for "${id}"`); h.fn(); };
  const press = (kind, id, key) => { const h = (keyHandlers[kind] || []).filter((c) => c.id === id).pop(); if (!h) throw new Error(`no ${kind} keydown handler for "${id}"`); h.fn({ key, preventDefault() {}, stopPropagation() {} }); };
  // P3-04: the input handler is registered ONCE in boot() — peek (don't pop)
  // so repeated type() calls keep working. Click handlers re-register on every
  // render, so their pop semantics are unchanged. No assertion affected.
  const type = (q) => { searchInput.value = q; const h = (handlers.input || []).slice(-1)[0]; if (h) h.fn(); };
  const sections = () => main.innerHTML.split('<section class="range-section"').slice(1).map((part) => ({
    label: (part.match(/aria-label="([^"]+)"/) || [])[1]?.replace(/&amp;/g, '&'),
    eans: [...part.matchAll(/data-ean="([^"]+)"/g)].map((m) => m[1]),
    html: part,
  }));
  const rowOf = (ean) => { const m = main.innerHTML.match(new RegExp('<button class="row[^"]*" data-ean="' + ean + '"[\\s\\S]*?</button>')); return m ? m[0] : null; };
  const allEans = () => sections().flatMap((s) => s.eans);
  const openDetail = (ean) => { locationStub.hash = '#/product/' + ean; windowStub._hashchange(); };
  const backToList = () => { locationStub.hash = '#/'; windowStub._hashchange(); };
  return { main, click, press, type, sections, rowOf, allEans, openDetail, backToList, locationStub, windowStub, store, searchInput, createdEls };
}