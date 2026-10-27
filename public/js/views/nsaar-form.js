// The incident form, drawn from the server's field registry (the National Ski Area Accident Report layout).
// Each section is its own small form, so a patroller on a phone saves a section at a time.

import { get, put, patch } from '../api.js';
import { h, clear, state, field, button, toast, formDialog, label, errorBox, fail, ctx } from '../ui.js';
import { pinDialog } from './incident-map.js';
import { measureText } from '../care-text.js';

let cache = null;
// The form's layout is kept on the phone too (it holds no patient details), so a case started where there is no signal
// can still be drawn, even when no case has been opened since the app was loaded.
const STORE = () => `so.patrol.form.${(ctx.me && ctx.me.tenant) || ''}`;
export async function loadForm(force = false) {
  if (!cache || force) {
    try {
      cache = await get('/patrol/form');
      try { localStorage.setItem(STORE(), JSON.stringify(cache)); } catch (_) { /* private mode */ }
    } catch (err) {
      const kept = keptForm();
      if (!kept) throw err;
      cache = kept;
    }
  }
  return cache;
}
/** The form layout last loaded on this phone, without asking the server; null if it never was. */
export function keptForm() {
  if (cache) return cache;
  try { const s = localStorage.getItem(STORE()); return s ? JSON.parse(s) : null; } catch (_) { return null; }
}
export const forgetForm = () => { cache = null; };

const blank = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && v !== null && !Array.isArray(v) && !Object.keys(v).length) || v === false;

/** What the row holds for a field, wherever it is stored. */
export function valueOf(f, row) {
  const form = row.form || {};
  if (f.type === 'name') return `${row.first_name || ''} ${row.last_name || ''}`.trim();
  if (f.type === 'gps') return row.gps_lat !== null && row.gps_lat !== undefined && row.gps_lng !== null && row.gps_lng !== undefined ? `${row.gps_lat}, ${row.gps_lng}` : null;
  if (f.col) return row[f.col];
  return form[f.key];
}
const colOf = (f) => f.col;

/** Values of the form for `when` checks: what is saved, as the field keys know it. */
function valuesOf(fields, row) {
  const v = {};
  for (const f of fields) v[f.key] = f.type === 'signature' || f.type === 'witnesses' ? null : valueOf(f, row);
  return v;
}
const holds = (f, vals) => {
  if (!f.when) return true;
  const v = vals[f.when.field];
  if (f.when.equals !== undefined) return v === f.when.equals;
  if (f.when.in) return f.when.in.includes(v);
  return true;
};

/** A section whose every field only applies in some situation (the refusal section) is left out until one of them applies. */
export function sectionVisible(def, section, scope, row) {
  const fields = def.fields.filter((f) => f.section === section.id && f.scope === scope);
  if (!fields.length || !fields.every((f) => f.when)) return true;
  const vals = valuesOf(def.fields.filter((f) => f.scope === scope), row);
  return fields.some((f) => holds(f, vals));
}

export function display(f, row, ctx) {
  const v = valueOf(f, row);
  if (f.type === 'signature') return ctx.signed(f) ? 'Signed' : null;
  if (f.type === 'witnesses') return ctx.witnessCount ? `${ctx.witnessCount} on file` : null;
  if (f.type === 'trail') return row.trail || null;
  if (blank(v)) return null;
  if (f.type === 'check') return 'Yes';
  if (f.type === 'select') { const o = (f.options || []).find((x) => x.value === v); return o ? o.label : label(v); }
  if (f.type === 'multi') return v.map((x) => ((f.options || []).find((o) => o.value === x) || { label: label(x) }).label).join(', ');
  if (f.type === 'bodymap') return Object.entries(v).map(([k, s]) => `${label(k)}${s === 'X' ? '' : ` (${s})`}`).join(', ');
  if (f.type === 'time') return v;
  if (f.type === 'measure') return measureText(v);
  return String(v);
}

/** How a suggested value reads next to the field. */
function suggestText(f, v) {
  if (f.type === 'bodymap') return Object.entries(v).map(([k, s]) => `${label(k)}${s === 'X' ? '' : ` (${s})`}`).join(', ');
  if (f.type === 'check') return 'Yes';
  return String(v);
}

/** One section as a form (editable) or a list of what was recorded (read only). */
/**
 * suggest: { key: { value, from } } answers worked out elsewhere (the bedside entries, the signed-in patroller). A blank field
 * starts with the suggestion and says where it came from; a field that already holds something different shows what the
 * bedside entries say, so the patroller can decide which is right.
 */
/**
 * reqs: Map of field key -> { level, met, na, na_allowed } from the case's report requirements, for this row (the case, or
 * one patient). onNa(key, reason, note): answer a required field N/A with a reason (reason null takes it away).
 */
export function sectionPanel({ def, section, scope, row, editable, required, reqs = null, onNa = null, ctx, trails, onSave, extra, open = false, suggest = {} }) {
  const fields = def.fields.filter((f) => f.section === section.id && f.scope === scope);
  const mandatory = reqs ? new Set([...reqs].filter(([, r]) => r.level === 'submit').map(([k]) => k)) : new Set(required[scope]);
  const left = reqs ? fields.filter((f) => { const r = reqs.get(f.key); return r && !r.met && ['submit', 'approve'].includes(r.level); }).length : 0;
  const base = valuesOf(def.fields.filter((f) => f.scope === scope), row);
  const head = [h('summary', null, section.title, left && editable ? h('span', { class: 'req-left', 'data-left': left }, ` ${left} required left`) : null), section.note ? h('p', { class: 'muted small nsaar-note' }, section.note) : null];

  if (!editable) {
    const naText = (f) => { const r = reqs && reqs.get(f.key); return r && r.na ? `N/A: ${naWords(def, r.na)}` : ''; };
    const lines = fields.map((f) => [f.label, display(f, row, ctx) || naText(f)]).filter(([, v]) => v);
    const viewPin = fields.some((f) => f.type === 'gps') && row.gps_lat !== null && row.gps_lat !== undefined && row.gps_lng !== null && row.gps_lng !== undefined
      ? button('View the pin on the map', () => pinDialog({ at: { lat: Number(row.gps_lat), lng: Number(row.gps_lng) }, editable: false, title: 'Incident location' }), { small: true }) : null;
    return h('details', { class: 'panel nsaar-sec', open, 'data-section': section.id }, ...head, extra || null, viewPin, lines.length ? h('dl', { class: 'kv' }, lines.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])) : h('p', { class: 'muted' }, 'Nothing recorded.'));
  }

  const controls = []; // { f, wrap, get }
  const reflect = () => {
    const vals = { ...base };
    for (const c of controls) if (c.get) vals[c.f.key] = c.get();
    for (const c of controls) c.wrap.hidden = !holds(c.f, vals);
    // A required tag shows only while the field still needs an answer: once it is filled in (or N/A), it goes.
    for (const c of controls) if (c.tag && c.touched && c.get) c.tag.dataset.met = String(!blank(c.get()) || Boolean(c.r && c.r.na));
  };
  const TAG = { submit: ['Required', 'Needed before the report can be submitted'], approve: ['For approval', 'Needed before the report is approved. You can submit without it; the reviewer will ask.'], recommended: ['Recommended', 'Your patrol director recommends this. It never stops anything.'] };
  const mark = (f) => {
    if (!reqs) return mandatory.has(f.key) ? h('span', { class: 'req', title: 'Mandatory before the report can be submitted' }, ' *') : null;
    const r = reqs.get(f.key);
    // Only what is needed gets a tag (Required, For approval); Recommended items carry none.
    if (!r || !TAG[r.level] || r.level === 'recommended') return null;
    return h('span', { class: 'req-tag', 'data-level': r.level, 'data-met': String(Boolean(r.met)), title: TAG[r.level][1] }, TAG[r.level][0]);
  };
  // N/A with a reason, for a required field that cannot be answered: shown in the report instead of a blank.
  const naLine = (f) => {
    const r = reqs && reqs.get(f.key);
    if (!r || !onNa || !r.na_allowed || !['submit', 'approve'].includes(r.level)) return null;
    if (r.na) {
      return h('span', { class: 'na-line', 'data-na': f.key }, h('b', null, 'N/A: '), naWords(def, r.na), ' ',
        h('button', { type: 'button', class: 'linkish', onclick: () => onNa(f.key, null) }, 'Answer it instead'));
    }
    if (r.met) return null;
    return h('button', { type: 'button', class: 'linkish na-ask', 'data-na-ask': f.key, onclick: () => naDialog(def, f, (reason, note) => onNa(f.key, reason, note)) }, 'Cannot answer? N/A with a reason');
  };
  const naButton = (f, el) => button(f.none ? 'None' : 'N/A', () => { el.value = f.none ? 'None' : 'N/A'; reflect(); }, { small: true });

  function build(f) {
    const stored = valueOf(f, row);
    const sg = suggest[f.key];
    const useSg = sg && blank(stored) && !blank(sg.value);
    const v = useSg ? sg.value : stored;
    // Shown under the field: where a pre-filled answer came from, or a different answer the bedside entries give.
    const sgNote = !sg || blank(sg.value) ? null
      : useSg ? h('span', { class: 'from-note' }, `Filled in from ${sg.from}. Change it if it is not right.`)
        : JSON.stringify(sg.value) !== JSON.stringify(stored) ? h('span', { class: 'from-note differs' }, `${sg.from[0].toUpperCase()}${sg.from.slice(1)} says: ${suggestText(f, sg.value)}`) : null;
    const tag = mark(f);
    const label_ = h('span', null, f.label, tag);
    const hint = f.hint ? h('span', { class: 'hint' }, f.hint) : null;
    const wrapField = (el, extraEls = []) => h('label', { class: 'field' }, label_, el, ...extraEls, hint);
    let wrap; let get;
    switch (f.type) {
      case 'name': {
        const a = h('input', { name: 'first_name', value: row.first_name || '', maxlength: 100, 'aria-label': 'First name', autocomplete: 'off' });
        const b = h('input', { name: 'last_name', value: row.last_name || '', maxlength: 100, 'aria-label': 'Last name', autocomplete: 'off' });
        wrap = h('div', { class: 'field wide' }, label_, h('div', { class: 'two' }, a, b), hint);
        get = () => `${a.value} ${b.value}`;
        wrap.collect = (out) => { out.cols.first_name = a.value.trim() || undefined; out.cols.last_name = b.value.trim() || undefined; };
        break;
      }
      case 'text': case 'tel': case 'email': {
        const el = h('input', { type: f.type === 'text' ? 'text' : f.type, value: v ?? '', maxlength: 300, autocomplete: 'off' });
        wrap = h('div', { class: 'field' }, h('label', null, label_), h('div', { class: 'input-row' }, el, naButton(f, el)), hint);
        get = () => el.value.trim() || null;
        wrap.collect = (out) => put_(out, f, el.value.trim() || null);
        el.addEventListener('input', reflect);
        break;
      }
      case 'longtext': {
        const el = h('textarea', { rows: 4, maxlength: 20000 }, v ?? '');
        wrap = h('div', { class: 'field wide' }, h('label', null, label_, el), h('div', { class: 'row tight' }, naButton(f, el)), hint);
        get = () => el.value.trim() || null;
        wrap.collect = (out) => put_(out, f, el.value.trim() || null);
        break;
      }
      case 'date': case 'time': case 'number': {
        const el = h('input', { type: f.type, value: v ?? '', min: f.min, max: f.max, step: f.type === 'number' ? 'any' : undefined, inputmode: f.type === 'number' ? 'numeric' : undefined });
        wrap = wrapField(el);
        get = () => el.value || null;
        wrap.collect = (out) => put_(out, f, el.value === '' ? null : f.type === 'number' ? Number(el.value) : el.value);
        el.addEventListener('input', reflect);
        break;
      }
      case 'measure': {
        const cur = v && typeof v === 'object' ? v : null;
        const legacy = v && typeof v !== 'object' ? String(v) : '';
        const num = h('input', { type: 'number', inputmode: 'decimal', step: 'any', min: 0, value: cur ? cur.v : '', 'aria-label': f.label, class: 'short-num' });
        const unit = h('select', { 'aria-label': `${f.label} unit` }, f.units.map((u) => h('option', { value: u, selected: cur ? cur.u === u : u === f.units[0] }, u)));
        wrap = h('div', { class: 'field' }, h('label', null, label_), h('div', { class: 'input-row' }, num, unit), legacy ? h('span', { class: 'hint' }, `Recorded earlier as "${legacy}"`) : null, hint);
        get = () => (num.value === '' ? null : true);
        wrap.collect = (out) => put_(out, f, num.value === '' ? (legacy || null) : { v: Number(num.value), u: unit.value });
        break;
      }
      case 'select': {
        const el = h('select', null, f.key === 'gender' ? null : h('option', { value: '' }, 'Not recorded'));
        const opt = (o) => h('option', { value: o.value, selected: o.value === v }, o.label);
        if (f.groups) for (const g of f.groups) el.append(h('optgroup', { label: g.group }, g.items.map(([val, lab]) => h('option', { value: val, selected: val === v }, lab))));
        else for (const o of f.options) el.append(opt(o));
        wrap = wrapField(el);
        get = () => el.value || null;
        wrap.collect = (out) => put_(out, f, el.value || (f.key === 'gender' ? 'unknown' : null));
        el.addEventListener('change', reflect);
        break;
      }
      case 'multi': {
        const have = new Set(v || []);
        const boxes = f.options.map((o) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: o.value, checked: have.has(o.value) }), ` ${o.label}`));
        wrap = h('fieldset', { class: 'field wide chips-box' }, h('legend', null, label_), h('div', { class: 'checks' }, boxes), hint);
        get = () => boxes.map((b) => b.firstChild).filter((i) => i.checked).map((i) => i.value);
        wrap.collect = (out) => put_(out, f, get());
        break;
      }
      case 'check': {
        const el = h('input', { type: 'checkbox', checked: v === true });
        wrap = h('label', { class: 'check wide' }, el, ' ', f.label, mark(f), hint ? h('span', { class: 'hint' }, ` ${f.hint}`) : null);
        get = () => (el.checked ? true : null);
        wrap.collect = (out) => put_(out, f, el.checked ? true : null);
        break;
      }
      case 'bodymap': {
        const cur = v || {};
        const rows = [];
        const sel = new Map();
        for (const p of def.body.sided) {
          const s = h('select', { 'aria-label': `${p.label}: left, right or both` }, h('option', { value: '' }, '—'), h('option', { value: 'L', selected: cur[p.value] === 'L' }, 'L'), h('option', { value: 'R', selected: cur[p.value] === 'R' }, 'R'), h('option', { value: 'B', selected: cur[p.value] === 'B' }, 'B'));
          sel.set(p.value, () => s.value || null);
          rows.push(h('div', { class: 'part' }, h('span', null, p.label), s));
        }
        for (const p of def.body.plain) {
          const c = h('input', { type: 'checkbox', checked: cur[p.value] === 'X', 'aria-label': p.label });
          sel.set(p.value, () => (c.checked ? 'X' : null));
          rows.push(h('label', { class: 'part' }, h('span', null, p.label), c));
        }
        wrap = h('fieldset', { class: 'field wide' }, h('legend', null, label_, ' (L left, R right, B both)'), h('div', { class: 'bodymap' }, rows), hint);
        get = () => { const m = {}; for (const [k, fn] of sel) { const x = fn(); if (x) m[k] = x; } return m; };
        wrap.collect = (out) => put_(out, f, get());
        break;
      }
      case 'trail': {
        const el = h('select', null, h('option', { value: '' }, 'Not on a trail'));
        for (const t of trails) el.append(h('option', { value: t.id, selected: t.id === row.trail_id }, t.name));
        wrap = wrapField(el);
        get = () => el.value || null;
        wrap.collect = (out) => { out.cols.trail_id = el.value ? Number(el.value) : null; };
        break;
      }
      case 'gps': {
        const lat = h('input', { type: 'number', step: 'any', value: row.gps_lat ?? '', 'aria-label': 'Latitude', placeholder: 'Latitude' });
        const lng = h('input', { type: 'number', step: 'any', value: row.gps_lng ?? '', 'aria-label': 'Longitude', placeholder: 'Longitude' });
        const here = button('Use my location', () => new Promise((resolve, reject) => {
          if (!navigator.geolocation) { reject(new Error('This browser cannot share a location')); return; }
          navigator.geolocation.getCurrentPosition((p) => { lat.value = p.coords.latitude.toFixed(6); lng.value = p.coords.longitude.toFixed(6); resolve(); }, () => reject(new Error('Location was not shared. Allow location for this site, or type the coordinates.')), { enableHighAccuracy: true, timeout: 15000 });
        }), { small: true });
        const pinBtn = button('Drop a pin on the map', () => pinDialog({
          at: lat.value !== '' && lng.value !== '' ? { lat: Number(lat.value), lng: Number(lng.value) } : null,
          title: 'Drop a pin on the incident location',
          // Fill the coordinates and save the section, so the pin is recorded on the incident straight away.
          onSave: ({ lat: a, lng: b }) => { lat.value = a; lng.value = b; reflect(); formEl.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); },
        }), { small: true, kind: 'primary' });
        wrap = h('div', { class: 'field wide' }, label_, h('div', { class: 'two' }, lat, lng), h('div', { class: 'row tight' }, pinBtn, here), hint);
        get = () => (lat.value && lng.value ? true : null);
        wrap.collect = (out) => { out.cols.gps_lat = lat.value === '' ? null : Number(lat.value); out.cols.gps_lng = lng.value === '' ? null : Number(lng.value); };
        break;
      }
      case 'signature': {
        const done = ctx.signed(f, row);
        wrap = h('div', { class: 'field wide' }, label_, done ? state('Signed', 'good') : state('Not signed yet', mandatory.has(f.key) ? 'warn' : 'neutral'), f.hint ? h('span', { class: 'hint' }, ` ${f.hint}`) : null);
        break;
      }
      case 'witnesses': {
        wrap = h('div', { class: 'field wide' }, label_, ctx.witnessCount ? state(`${ctx.witnessCount} on file`, 'good') : state('None yet', mandatory.has(f.key) ? 'warn' : 'neutral'), hint ? h('span', { class: 'hint' }, ` ${f.hint}`) : null);
        break;
      }
      default: wrap = h('div'); break;
    }
    wrap.dataset.field = f.key;
    if (sgNote) { wrap.append(sgNote); if (useSg) wrap.classList.add('prefilled'); }
    const na = naLine(f);
    if (na) wrap.append(na);
    const c = { f, wrap, get, tag: tag && tag.classList.contains('req-tag') ? tag : null, r: reqs && reqs.get(f.key), touched: false };
    if (c.tag) { const touch = () => { c.touched = true; reflect(); }; wrap.addEventListener('input', touch); wrap.addEventListener('change', touch); wrap.addEventListener('click', (e) => { if (e.target.closest('button')) setTimeout(touch); }); }
    controls.push(c);
    return wrap;
  }

  const formEl = h('form', { class: 'stack', novalidate: true },
    h('div', { class: 'form nsaar-grid' }, fields.map(build)),
    h('div', { class: 'nsaar-actions' }, h('button', { type: 'submit', class: 'btn primary', 'data-next': '' }, 'Save and continue'), h('button', { type: 'submit', class: 'btn', 'data-save': '' }, 'Save and stay here')));
  reflect();
  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = { cols: {}, form: {} };
    for (const c of controls) if (c.wrap.collect && !c.wrap.hidden) c.wrap.collect(out);
    for (const c of controls) if (c.wrap.collect && c.wrap.hidden && c.f.stored === 'form') out.form[c.f.key] = null; // a field that no longer applies is cleared
    const btns = [...formEl.querySelectorAll('[type=submit]')];
    const go = Boolean(e.submitter && e.submitter.hasAttribute('data-next'));
    for (const b of btns) b.disabled = true;
    try {
      const body = { ...Object.fromEntries(Object.entries(out.cols).filter(([, x]) => x !== undefined)), form: out.form };
      await onSave(body, { next: go });
      toast(`${section.title} saved`);
    } catch (err) { fail(err); for (const b of btns) b.disabled = false; }
  });
  return h('details', { class: 'panel nsaar-sec', open, 'data-section': section.id }, ...head, extra || null, formEl);

  function put_(o, f, value) {
    if (f.stored === 'column') o.cols[colOf(f)] = value;
    else o.form[f.key] = value;
  }
}

// ---------------------------------------------------------------- N/A with a reason
const NA_FALLBACK = [['declined', 'Patient declined to answer'], ['unable', 'Patient could not answer'], ['left', 'Patient left before it was asked'], ['not_applicable', 'Does not apply'], ['other', 'Other']];
const naReasons = (def) => (def && def.na_reasons ? def.na_reasons.map((r) => [r.value, r.label]) : NA_FALLBACK);
/** "Patient declined to answer", or the note for Other. */
export function naWords(def, na) {
  if (!na) return '';
  const label = (naReasons(def).find(([v]) => v === na.reason) || [null, na.reason])[1];
  return na.reason === 'other' && na.note ? na.note : `${label}${na.note ? ` (${na.note})` : ''}`;
}
/** Asks why a required field cannot be answered. Works with no signal: the answer waits on the phone like a vital sign. */
export function naDialog(def, f, done) {
  const choices = naReasons(def);
  const radios = choices.map(([v, t], i) => h('label', { class: 'check' }, h('input', { type: 'radio', name: 'na_reason', value: v, required: true, checked: i === 0 }), ` ${t}`));
  const note = h('input', { name: 'na_note', maxlength: 300, placeholder: 'Say why (needed for Other)' });
  formDialog(`${f.label}: N/A`, h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, 'The report shows the reason instead of a blank, and your reviewer sees it.'),
    h('fieldset', { class: 'stack tight' }, h('legend', null, 'Why can it not be answered?'), ...radios),
    field('Note', note)),
  async (fd) => {
    const reason = String(fd.get('na_reason') || '');
    const text = String(fd.get('na_note') || '').trim();
    if (reason === 'other' && !text) throw new Error('Say why, when the reason is Other');
    await done(reason, text || null);
  }, { submitText: 'Save N/A' });
}

// ---------------------------------------------------------------- administrator settings
/** The resort's full legal name, printed on every copy of the report. What a report must hold is under Admin, Report requirements. */
export async function formSettingsDialog(onDone) {
  const def = await loadForm(true);
  const legal = h('input', { name: 'legal_name', value: def.resort.legal_name || '', maxlength: 255, placeholder: def.resort.name });
  formDialog('Legal name on reports', h('div', { class: 'stack' },
    field('Full legal name of the resort', legal, 'Printed on every copy of the report. Leave blank to use the mountain name.'),
    h('p', { class: 'muted small' }, 'Which fields a report must hold is set under Admin, Report requirements.')),
  async () => {
    await put('/patrol/form-config', { legal_name: legal.value.trim() || null });
    forgetForm();
    toast('Saved');
    if (onDone) await onDone();
  }, { submitText: 'Save' });
}
export { errorBox, clear, patch };
