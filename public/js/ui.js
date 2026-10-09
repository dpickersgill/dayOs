// Small DOM toolkit. Everything is built with createElement and textContent, never innerHTML,
// so text that comes from the database cannot inject markup.

import { describeError } from './api.js';

export const ctx = { me: null, tz: 'America/New_York' };

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled' || k === 'hidden') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

export function svg(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Like el.append, but skips null, undefined and false (so optional parts can be written inline), and flattens arrays. */
export function appendAll(el, ...children) { append(el, children); return el; }

export const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };

// ---------------------------------------------------------------- formatting
export const money = (cents) => {
  const n = Number(cents || 0) / 100;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
};

/** "12.5" or "$12.50" -> 1250. Returns null when it is not a valid amount. */
export function toCents(text) {
  const s = String(text ?? '').trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}
export const centsToInput = (cents) => (cents === null || cents === undefined ? '' : (cents / 100).toFixed(2));

const parts = (date, opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(date);
/** API datetimes are wall-clock strings in the mountain's zone, so format them without any zone shifting. */
function asUtc(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(s || ''));
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)));
}
export const fmtDate = (s) => { const d = asUtc(s); return d ? parts(d, { weekday: 'short', month: 'short', day: 'numeric' }) : ''; };
export const fmtDateLong = (s) => { const d = asUtc(s); return d ? parts(d, { weekday: 'long', month: 'long', day: 'numeric' }) : ''; };
export const fmtTime = (s) => { const d = asUtc(s); return d ? parts(d, { hour: 'numeric', minute: '2-digit' }) : ''; };
export const fmtDateTime = (s) => (s ? `${fmtDate(s)}, ${fmtTime(s)}` : '');
export const fmtRange = (a, b) => `${fmtDate(a)}, ${fmtTime(a)} to ${fmtTime(b)}`;
export const dayOf = (s) => String(s || '').slice(0, 10);

function zoned(extra) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: ctx.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...extra });
  return Object.fromEntries(f.formatToParts(new Date()).map((p) => [p.type, p.value]));
}
export const todayStr = () => { const p = zoned({}); return `${p.year}-${p.month}-${p.day}`; };
export const nowInput = () => { const p = zoned({}); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function weekStart(date) {
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(date, -((wd + 6) % 7)); // Monday
}
/** Same rule the server uses: August to July, labelled 2026-27. */
export function seasonFor(date) {
  const [y, m] = date.split('-').map(Number);
  const start = m >= 8 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export const isManager = () => ['owner', 'manager'].includes(ctx.me && ctx.me.role);
export const can = (...roles) => isManager() || roles.includes(ctx.me && ctx.me.role);

export const label = (s) => String(s || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// ---------------------------------------------------------------- small pieces
export function state(text, kind = 'neutral') {
  return h('span', { class: 'state', dataset: { state: kind } }, text);
}

const TRAIL_LOOK = {
  green: { name: 'Easy', draw: (c) => svg('circle', { cx: 9, cy: 9, r: 7, fill: '#17703f' }, c) },
  blue: { name: 'Intermediate', draw: () => svg('rect', { x: 3, y: 3, width: 12, height: 12, rx: 1, fill: '#1b5fc1' }) },
  black: { name: 'Advanced', draw: () => svg('path', { d: 'M9 1 L17 9 L9 17 L1 9 Z', fill: '#111' }) },
  double_black: { name: 'Expert', draw: () => svg('g', {}, svg('path', { d: 'M5 2 L10 9 L5 16 L0 9 Z', fill: '#111' }), svg('path', { d: 'M13 2 L18 9 L13 16 L8 9 Z', fill: '#111', stroke: '#fff', 'stroke-width': 1 })) },
  park: { name: 'Terrain park', draw: () => svg('path', { d: 'M9 2 L17 16 L1 16 Z', fill: '#e07a00' }) },
};
/** Trail-sign shape plus a word, so difficulty never depends on colour alone. */
export function trailMark(difficulty) {
  const look = TRAIL_LOOK[difficulty] || TRAIL_LOOK.green;
  const icon = svg('svg', { width: 20, height: 18, viewBox: '0 0 20 18', 'aria-hidden': 'true', focusable: 'false' }, look.draw());
  return h('span', { class: 'mark' }, icon, look.name);
}

export function field(text, input, hint) {
  return h('label', { class: 'field' }, text, input, hint ? h('span', { class: 'hint' }, hint) : null);
}

export function input(attrs = {}) { return h('input', attrs); }
export function select(options, value, attrs = {}) {
  const el = h('select', attrs);
  for (const o of options) {
    const [v, text] = Array.isArray(o) ? o : [o, label(o)];
    el.append(h('option', { value: v, selected: String(v) === String(value) }, text));
  }
  return el;
}

export function loading(text = 'Loading') { return h('p', { class: 'loading', role: 'status' }, `${text}…`); }
export function errorBox(err) { return h('div', { class: 'error-box', role: 'alert' }, describeError(err)); }
export function empty(text, action) { return h('div', { class: 'empty' }, h('p', null, text), action || null); }

// ---------------------------------------------------------------- table
/** columns: [{ head, cell(row) => Node|string, num?, actions? }] */
export function table(columns, data, { rowClass } = {}) {
  const head = h('tr', null, columns.map((c) => h('th', { class: c.num ? 'num' : null, scope: 'col' }, c.head || (c.actions ? h('span', { class: 'sr' }, 'Actions') : ''))));
  const body = data.map((row) =>
    h('tr', { class: rowClass ? rowClass(row) : null }, columns.map((c) => h('td', { class: c.num ? 'num' : c.actions ? 'actions' : null, 'data-label': c.head || null }, c.cell(row)))),
  );
  return h('div', { class: 'table-wrap' }, h('table', { class: 'rt' }, h('thead', null, head), h('tbody', null, body)));
}

// ---------------------------------------------------------------- toasts and busy buttons
let toastBox;
export function toast(message, kind = 'ok') {
  if (!toastBox || !toastBox.isConnected) {
    toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastBox);
  }
  const t = h('div', { class: 'toast', dataset: { kind } }, message);
  toastBox.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 8000 : 3500);
}
export const fail = (err) => toast(describeError(err), 'error');

/** Run an async action from a button: disables it while working and reports errors as a toast. */
export function act(button, fn) {
  return async (event) => {
    if (event && event.preventDefault) event.preventDefault();
    if (button && button.disabled) return;
    if (button) button.disabled = true;
    try { await fn(); } catch (err) { fail(err); } finally { if (button) button.disabled = false; }
  };
}
export function button(text, onClick, { kind, small, type = 'button' } = {}) {
  const b = h('button', { type, class: ['btn', kind, small ? 'small' : ''].filter(Boolean).join(' ') }, text);
  if (onClick) b.addEventListener('click', act(b, () => onClick(b)));
  return b;
}

// ---------------------------------------------------------------- dialogs
/** Opens a dialog. Returns { close, body }. */
export function dialog(title, content, { wide = false, footer } = {}) {
  const previous = document.activeElement;
  const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  const closeBtn = h('button', { type: 'button', class: 'btn small', 'aria-label': 'Close' }, 'Close');
  const body = h('div', { class: 'stack' }, content);
  const box = h('div', { class: wide ? 'dialog wide' : 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('header', null, h('h2', { id: titleId }, title), closeBtn), body, footer ? h('div', { class: 'footer' }, footer) : null);
  const overlay = h('div', { class: 'overlay' }, box);
  // Escape closes only the dialog on top, and focus goes back to what was focused when this one opened.
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    const all = document.querySelectorAll('.overlay');
    if (all.length && all[all.length - 1] !== overlay) return;
    close();
  };
  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    if (previous && previous.isConnected) previous.focus();
  }
  closeBtn.addEventListener('click', close);
  // A tap outside closes the dialog only while nothing has been typed in it, so a stray tap never throws work away.
  let dirty = false;
  box.addEventListener('input', () => { dirty = true; });
  overlay.addEventListener('mousedown', (e) => {
    if (e.target !== overlay) return;
    if (!dirty) { close(); return; }
    box.classList.remove('nudge'); void box.offsetWidth; box.classList.add('nudge'); // a small shake: use Close or Cancel
  });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  const first = box.querySelector('input:not([type=hidden]), select, textarea');
  (first || closeBtn).focus();
  return { close, body, box };
}

/**
 * A form in a dialog. build(form) returns the field elements; submit(values) does the work and the dialog
 * closes when it resolves. Errors stay in the dialog so nothing typed is lost.
 */
export function formDialog(title, fieldsEl, submit, { submitText = 'Save', wide = false } = {}) {
  const errorSlot = h('div');
  const save = h('button', { type: 'submit', class: 'btn primary' }, submitText);
  const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');
  const form = h('form', { class: 'stack', novalidate: true }, fieldsEl, errorSlot, h('div', { class: 'footer row' }, cancel, save));
  const dlg = dialog(title, form, { wide });
  cancel.addEventListener('click', dlg.close);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(errorSlot);
    save.disabled = true;
    try {
      await submit(new FormData(form), form);
      dlg.close();
    } catch (err) {
      errorSlot.append(errorBox(err));
    } finally {
      save.disabled = false;
    }
  });
  return dlg;
}

export function confirmDialog(title, message, confirmText, onConfirm, { danger = false } = {}) {
  const slot = h('div');
  const yes = h('button', { type: 'button', class: danger ? 'btn danger' : 'btn primary' }, confirmText);
  const no = h('button', { type: 'button', class: 'btn' }, 'Cancel');
  const dlg = dialog(title, [h('p', null, message), slot, h('div', { class: 'footer row' }, no, yes)]);
  no.addEventListener('click', dlg.close);
  yes.addEventListener('click', async () => {
    clear(slot);
    yes.disabled = true;
    try { await onConfirm(); dlg.close(); } catch (err) { slot.append(errorBox(err)); yes.disabled = false; }
  });
  return dlg;
}

/** Read a form value as trimmed text, or null when blank. */
export const val = (fd, name) => { const v = String(fd.get(name) ?? '').trim(); return v === '' ? null : v; };
export const num = (fd, name) => { const v = val(fd, name); return v === null ? null : Number(v); };

/** Tabs: tabs = [[key, label, render(panel)]]. */
export function tabs(items, initial) {
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  const panel = h('div', { role: 'tabpanel' });
  const buttons = new Map();
  const uid = Math.random().toString(36).slice(2, 7);
  let token = 0;
  async function show(key) {
    const my = ++token;
    for (const [k, b] of buttons) { b.setAttribute('aria-selected', String(k === key)); b.tabIndex = k === key ? 0 : -1; }
    panel.setAttribute('aria-labelledby', `tab-${uid}-${key}`);
    clear(panel).append(loading());
    const item = items.find((i) => i[0] === key);
    const out = h('div');
    try {
      await item[2](out);
    } catch (err) {
      clear(out).append(errorBox(err));
    }
    if (my === token) clear(panel).append(out);
  }
  const keys = items.map((i) => i[0]);
  for (const [key, text] of items) {
    const b = h('button', { type: 'button', role: 'tab', id: `tab-${uid}-${key}`, 'aria-selected': 'false', 'aria-controls': `panel-${uid}`, tabIndex: -1 }, text);
    b.addEventListener('click', () => show(key));
    // Arrow keys move between tabs, Home and End jump to the first and last (the roving tab stop pattern).
    b.addEventListener('keydown', (e) => {
      const at = keys.indexOf(key);
      const to = { ArrowRight: keys[(at + 1) % keys.length], ArrowLeft: keys[(at - 1 + keys.length) % keys.length], Home: keys[0], End: keys[keys.length - 1] }[e.key];
      if (!to) return;
      e.preventDefault();
      buttons.get(to).focus();
      show(to);
    });
    buttons.set(key, b);
    bar.append(b);
  }
  panel.id = `panel-${uid}`;
  show(initial || items[0][0]);
  return h('div', null, bar, panel);
}
