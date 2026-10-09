// Quick vitals: a sheet built for gloved thumbs. Big plus and minus buttons that start from the last reading, tap-chips for
// responsiveness, skin, pupils and pain, one tap for "now", a flag on anything outside the usual range, and an optional
// reminder to check again. Nothing here blocks saving: the numbers are the patroller's, the colours are only a prompt.

import { post } from '../api.js';
import { h, clear, dialog, toast, nowInput, errorBox } from '../ui.js';
import { flag, flagAvpu } from '../vitals-guide.js';

const REMIND_KEY = (pid) => `vitals-due-${pid}`;

/** When the next set of vitals is due for this patient (ms since 1970), or null. Kept in the browser tab only. */
export function dueAt(pid) { try { const v = Number(sessionStorage.getItem(REMIND_KEY(pid))); return v || null; } catch (_) { return null; } }
export function setDue(pid, minutes) { try { if (minutes) sessionStorage.setItem(REMIND_KEY(pid), String(Date.now() + minutes * 60000)); else sessionStorage.removeItem(REMIND_KEY(pid)); } catch (_) { /* a reminder is a convenience */ } }

const wordFor = (f) => (f.level === 'alert' ? `${f.word}: check again` : f.level === 'watch' ? f.word : '');

/** A number with big minus and plus buttons. Blank means "not measured". The first tap starts from the last reading. */
function stepper({ key, label, min, max, step = 1, start, last, age, width }) {
  const input = h('input', { type: 'number', inputmode: step < 1 ? 'decimal' : 'numeric', min, max, step, id: `v-${key}`, 'aria-label': label, placeholder: last != null ? String(last) : String(start), class: 'step-input' });
  const note = h('span', { class: 'flag', 'aria-live': 'polite' });
  const dec = (n) => (step < 1 ? Math.round(n * 10) / 10 : Math.round(n));
  const show = () => {
    const f = flag(key, input.value === '' ? null : Number(input.value), age);
    note.textContent = wordFor(f);
    note.dataset.level = f.level;
    input.dataset.level = f.level;
  };
  const bump = (dir) => {
    let next;
    if (input.value === '') next = last != null ? last + dir * step : start; // the first tap starts from the last reading (or a usual value)
    else next = Number(input.value) + dir * step;
    input.value = String(Math.min(max, Math.max(min, dec(next))));
    show();
  };
  const minus = h('button', { type: 'button', class: 'step-btn', 'aria-label': `${label} down` }, '−');
  const plus = h('button', { type: 'button', class: 'step-btn', 'aria-label': `${label} up` }, '+');
  minus.addEventListener('click', () => bump(-1));
  plus.addEventListener('click', () => bump(1));
  input.addEventListener('input', show);
  const el = h('div', { class: `vstep ${width || ''}`.trim() }, h('label', { for: `v-${key}` }, label), h('div', { class: 'step-row' }, minus, input, plus), note,
    last != null ? h('span', { class: 'last' }, `Last: ${last}`) : null);
  return { el, input, get: () => (input.value === '' ? null : Number(input.value)), set: (v) => { input.value = v === null || v === undefined ? '' : String(v); show(); } };
}

/** A row of tap-chips. One can be chosen (tap it again to clear it). */
function chips({ id, options, value = '', onChange }) {
  let cur = value;
  const row = h('div', { class: 'chip-row', role: 'group', id });
  const draw = () => { for (const b of row.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.value === String(cur))); };
  for (const [v, text] of options) {
    const b = h('button', { type: 'button', class: 'chip', 'data-value': String(v), 'aria-pressed': 'false' }, text);
    b.addEventListener('click', () => { cur = String(cur) === String(v) ? '' : v; draw(); if (onChange) onChange(cur); });
    row.append(b);
  }
  draw();
  return { el: row, get: () => (cur === '' ? null : cur), set: (v) => { cur = v === null || v === undefined ? '' : v; draw(); if (onChange) onChange(cur); } };
}

const AVPU = [['alert', 'Alert'], ['verbal', 'Voice'], ['pain', 'Pain'], ['unresponsive', 'Unresponsive']];
const SKIN = [['Normal', 'Normal'], ['Pale', 'Pale'], ['Cool', 'Cool'], ['Clammy', 'Clammy'], ['Flushed', 'Flushed'], ['Cyanotic', 'Blue'], ['Hot', 'Hot']];
const PUPILS = [['Equal and reactive', 'Equal, react'], ['Unequal', 'Unequal'], ['Dilated', 'Dilated'], ['Constricted', 'Small'], ['Not reactive', 'Not reactive']];
const WHEN = [['0', 'Now'], ['5', '5 min ago'], ['10', '10 min ago'], ['other', 'Pick a time']];
const AGAIN = [['', 'No reminder'], ['5', '5 min'], ['10', '10 min'], ['15', '15 min']];

/** 'YYYY-MM-DDTHH:MM' minus some minutes, in the mountain's clock. */
function minutesAgo(n) {
  const now = nowInput();
  const d = new Date(`${now}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() - n);
  return d.toISOString().slice(0, 16);
}

/**
 * Opens the vitals sheet for one patient. `last` is the most recent set (or undefined); `age` shapes the flags.
 * onSaved runs after the set is stored so the page can redraw.
 */
export function openVitalsSheet({ base, patientId, patientName, age, last, onSaved }) {
  const S = {
    pulse: stepper({ key: 'pulse', label: 'Pulse', min: 0, max: 300, start: 80, last: last && last.pulse, age }),
    resp: stepper({ key: 'resp', label: 'Breaths / min', min: 0, max: 80, start: 16, last: last && last.resp, age }),
    bp_sys: stepper({ key: 'bp_sys', label: 'BP top', min: 0, max: 300, step: 2, start: 120, last: last && last.bp_sys, age }),
    bp_dia: stepper({ key: 'bp_dia', label: 'BP bottom', min: 0, max: 200, step: 2, start: 80, last: last && last.bp_dia, age }),
    spo2: stepper({ key: 'spo2', label: 'SpO₂ %', min: 0, max: 100, start: 98, last: last && last.spo2, age }),
    gcs: stepper({ key: 'gcs', label: 'GCS (3 to 15)', min: 3, max: 15, start: 15, last: last && last.gcs, age }),
    temp_c: stepper({ key: 'temp_c', label: 'Temp °C', min: 20, max: 45, step: 0.1, start: 36.8, last: last && last.temp_c, age }),
    glucose: stepper({ key: 'glucose', label: 'Blood sugar', min: 0, max: 1500, step: 5, start: 100, last: last && last.glucose, age }),
  };
  const avpu = chips({ id: 'v-avpu', options: AVPU });
  const skin = chips({ id: 'v-skin', options: SKIN });
  const pupils = chips({ id: 'v-pupils', options: PUPILS });
  const painDigits = Array.from({ length: 11 }, (_, i) => [i, String(i)]);
  const pain = chips({ id: 'v-pain', options: painDigits });
  const avpuNote = h('span', { class: 'flag', 'aria-live': 'polite' });
  avpu.el.addEventListener('click', () => { const f = flagAvpu(avpu.get()); avpuNote.textContent = f.level === 'ok' || f.level === 'none' ? '' : 'Not fully alert: check again'; avpuNote.dataset.level = f.level; });
  const painNote = h('span', { class: 'flag' });
  pain.el.addEventListener('click', () => { const f = flag('pain', pain.get() === null ? null : Number(pain.get())); painNote.textContent = f.level === 'ok' || f.level === 'none' ? '' : f.word; painNote.dataset.level = f.level; });

  const whenPick = chips({ id: 'v-when', options: WHEN, value: '0' });
  const custom = h('input', { type: 'datetime-local', id: 'v-time', value: nowInput(), 'aria-label': 'Time taken', hidden: true });
  whenPick.el.addEventListener('click', () => { custom.hidden = whenPick.get() !== 'other'; });
  const again = chips({ id: 'v-again', options: AGAIN, value: '' });
  const notes = h('input', { id: 'v-notes', maxlength: 255, placeholder: 'Anything else (optional)', 'aria-label': 'Notes' });
  const err = h('div');

  const copy = h('button', { type: 'button', class: 'btn', id: 'v-copy' }, 'Same as last set');
  copy.hidden = !last;
  copy.addEventListener('click', () => {
    for (const k of Object.keys(S)) S[k].set(last[k] ?? null);
    avpu.set(last.avpu || null); skin.set(last.skin || null); pupils.set(last.pupils || null); pain.set(last.pain ?? null);
  });
  const save = h('button', { type: 'button', class: 'btn primary big', id: 'v-save' }, 'Save vitals');

  const body = h('div', { class: 'vsheet stack' },
    h('p', { class: 'muted small' }, `${patientName}. Tap + or − to start from the last reading, or type a number. Leave anything you did not measure blank.`),
    h('div', { class: 'row' }, copy),
    h('div', { class: 'vgrid' }, S.pulse.el, S.resp.el, S.spo2.el, S.gcs.el),
    h('div', { class: 'vgrid two' }, S.bp_sys.el, S.bp_dia.el),
    h('div', { class: 'vblock' }, h('h4', null, 'Responsiveness'), avpu.el, avpuNote),
    h('div', { class: 'vblock' }, h('h4', null, 'Pain (0 to 10)'), pain.el, painNote),
    h('div', { class: 'vblock' }, h('h4', null, 'Skin'), skin.el),
    h('div', { class: 'vblock' }, h('h4', null, 'Pupils'), pupils.el),
    h('details', { class: 'more' }, h('summary', null, 'Temperature and blood sugar'), h('div', { class: 'vgrid two' }, S.temp_c.el, S.glucose.el)),
    h('div', { class: 'vblock' }, h('h4', null, 'Time taken'), whenPick.el, custom),
    h('div', { class: 'vblock' }, h('h4', null, 'Check again in'), again.el),
    notes, err,
    h('div', { class: 'footer row' }, save));
  const dlg = dialog(`Vitals: ${patientName}`, body, { wide: true });
  dlg.box.classList.add('sheet');

  save.addEventListener('click', async () => {
    clear(err);
    const out = {};
    for (const [k, s] of Object.entries(S)) { const v = s.get(); if (v !== null) out[k] = v; }
    if (avpu.get()) out.avpu = avpu.get();
    if (skin.get()) out.skin = skin.get();
    if (pupils.get()) out.pupils = pupils.get();
    if (pain.get() !== null) out.pain = Number(pain.get());
    if (notes.value.trim()) out.notes = notes.value.trim();
    if (!Object.keys(out).some((k) => k !== 'notes')) { err.append(errorBox(new Error('Enter at least one measurement'))); return; }
    const w = whenPick.get();
    if (w === 'other') { if (!custom.value) { err.append(errorBox(new Error('Pick the time'))); return; } out.taken_at = custom.value; } else if (w && w !== '0') out.taken_at = minutesAgo(Number(w));
    save.disabled = true;
    try {
      await post(`${base}/vitals`, out);
      setDue(patientId, again.get() ? Number(again.get()) : 0);
      dlg.close();
      toast('Vitals saved');
      if (onSaved) await onSaved();
    } catch (e) { err.append(errorBox(e)); save.disabled = false; }
  });
  return dlg;
}
