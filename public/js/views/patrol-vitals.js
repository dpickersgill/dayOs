// Quick vitals: a sheet built for gloved thumbs. Big plus and minus buttons that start from the last reading, tap-chips for
// responsiveness, skin, pupils and pain, one tap for "now", a flag on anything outside the usual range, and an optional
// reminder to check again. Nothing here blocks saving: the numbers are the patroller's, the colours are only a prompt.

import { h, clear, dialog, nowInput, errorBox } from '../ui.js';
import { flag, flagAvpu, ageGroup, GROUP_LABEL } from '../vitals-guide.js';
import { send } from '../outbox.js';
import { chipGroup, minutesAgo, sentToast } from './patrol-tools.js';
import { PUPIL_CHOICES, tempUnit, setTempUnit, cToF, fToC } from '../care-text.js';

/** When the next set of vitals is due (ms since 1970), from the patient record so every phone on the case agrees, or null. */
export function dueAt(p) {
  if (!p || !p.vitals_due_at) return null;
  // vitals_due_at is on the mountain clock; compare it with the mountain clock now.
  const due = Date.parse(`${String(p.vitals_due_at).replace(' ', 'T').slice(0, 16)}:00Z`);
  const now = Date.parse(`${nowInput()}:00Z`) + new Date().getSeconds() * 1000;
  return Date.now() + (due - now);
}

const wordFor = (f) => (f.level === 'alert' ? `${f.word}: check again` : f.level === 'watch' ? f.word : '');

/** A number with big minus and plus buttons. Blank means "not measured". The first tap starts from the last reading. */
function stepper({ key, label, min, max, step = 1, start, last, age, width, flagKey, toFlag }) {
  const input = h('input', { type: 'number', inputmode: step < 1 ? 'decimal' : 'numeric', min, max, step, id: `v-${key}`, 'aria-label': label, placeholder: last != null ? String(last) : String(start), class: 'step-input' });
  const note = h('span', { class: 'flag', 'aria-live': 'polite' });
  const dec = (n) => (step < 1 ? Math.round(n * 10) / 10 : Math.round(n));
  const show = () => {
    const f = flag(flagKey || key, input.value === '' ? null : (toFlag ? toFlag(Number(input.value)) : Number(input.value)), age);
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

const AVPU = [['alert', 'Alert'], ['verbal', 'Voice'], ['pain', 'Pain'], ['unresponsive', 'Unresponsive']];
const SKIN = { colour: [['Normal', 'Normal colour'], ['Pale', 'Pale'], ['Flushed', 'Flushed'], ['Cyanotic', 'Blue']], temp: [['Warm', 'Warm'], ['Cool', 'Cool'], ['Hot', 'Hot']], moisture: [['Dry', 'Dry'], ['Clammy', 'Clammy'], ['Sweaty', 'Sweaty']] };
const WHEN = [['0', 'Now'], ['5', '5 min ago'], ['10', '10 min ago'], ['other', 'Pick a time']];
const AGAIN = [['', 'No reminder'], ['5', '5 min'], ['10', '10 min'], ['15', '15 min']];
const GCS_E = [[4, '4 Open by themselves'], [3, '3 To voice'], [2, '2 To pain'], [1, '1 None']];
const GCS_V = [[5, '5 Oriented'], [4, '4 Confused'], [3, '3 Words'], [2, '2 Sounds'], [1, '1 None']];
// Children: a baby (under 2) and a talking young child (2 to 4) use their own verbal scale, and a baby's best motor response is moving normally.
const GCS_V_INFANT = [[5, '5 Coos, babbles'], [4, '4 Irritable, cries'], [3, '3 Cries to pain'], [2, '2 Moans to pain'], [1, '1 None']];
const GCS_V_YOUNG = [[5, '5 Right words, smiles'], [4, '4 Wrong words'], [3, '3 Cries or screams'], [2, '2 Grunts'], [1, '1 None']];
const GCS_M = [[6, '6 Obeys'], [5, '5 Locates pain'], [4, '4 Withdraws'], [3, '3 Bends abnormally'], [2, '2 Straightens'], [1, '1 None']];
const GCS_M_INFANT = [[6, '6 Moves normally'], ...GCS_M.slice(1)];

/**
 * Opens the vitals sheet for one patient. `last` is the most recent set (or undefined); `age` shapes the flags.
 * onSaved runs after the set is stored so the page can redraw.
 */
export function openVitalsSheet({ base, caseId, patientName, age, last, onSaved }) {
  const unit = { now: tempUnit() };
  const S = {
    pulse: stepper({ key: 'pulse', label: 'Pulse', min: 0, max: 300, start: 80, last: last && last.pulse, age }),
    resp: stepper({ key: 'resp', label: 'Breaths / min', min: 0, max: 80, start: 16, last: last && last.resp, age }),
    bp_sys: stepper({ key: 'bp_sys', label: 'BP top', min: 0, max: 300, step: 2, start: 120, last: last && last.bp_sys, age }),
    bp_dia: stepper({ key: 'bp_dia', label: 'BP bottom', min: 0, max: 200, step: 2, start: 80, last: last && last.bp_dia, age }),
    spo2: stepper({ key: 'spo2', label: 'SpO₂ %', min: 0, max: 100, start: 98, last: last && last.spo2, age }),
    glucose: stepper({ key: 'glucose', label: 'Blood sugar', min: 0, max: 1500, step: 5, start: 100, last: last && last.glucose, age }),
  };
  // Temperature is typed in the unit this phone prefers and stored in °C.
  const tempBox = h('div');
  let temp;
  const drawTemp = () => {
    const f = unit.now === 'F';
    const lastT = last && last.temp_c != null ? (f ? cToF(last.temp_c) : Number(last.temp_c)) : null;
    temp = stepper({ key: 'temp', label: f ? 'Temp °F' : 'Temp °C', min: f ? 68 : 20, max: f ? 113 : 45, step: 0.1, start: f ? 98.2 : 36.8, last: lastT, age, flagKey: 'temp_c', toFlag: f ? fToC : (x) => x });
    clear(tempBox).append(temp.el);
  };
  drawTemp();
  const unitPick = chipGroup({ id: 'v-tunit', labelledBy: 'v-tunit-l', options: [['C', '°C'], ['F', '°F']], value: unit.now, onChange: (v) => { if (!v) { unitPick.set(unit.now); return; } const was = temp.get(); unit.now = v; setTempUnit(v); drawTemp(); if (was !== null) temp.set(v === 'F' ? cToF(was) : fToC(was)); } });

  const known = age !== null && age !== undefined && age !== '';
  const infant = known && Number(age) < 2;
  const young = known && Number(age) >= 2 && Number(age) < 5;
  const child = infant || young;
  const gE = chipGroup({ id: 'v-gcs-e', options: GCS_E, labelledBy: 'v-gcs-e-l' });
  const gV = chipGroup({ id: 'v-gcs-v', options: infant ? GCS_V_INFANT : young ? GCS_V_YOUNG : GCS_V, labelledBy: 'v-gcs-v-l' });
  const gM = chipGroup({ id: 'v-gcs-m', options: infant ? GCS_M_INFANT : GCS_M, labelledBy: 'v-gcs-m-l' });
  const gcsTotal = h('span', { class: 'flag', 'aria-live': 'polite', id: 'v-gcs-total' });
  const showGcs = () => {
    const parts = [gE.get(), gV.get(), gM.get()];
    if (parts.every((x) => x)) { const t = parts.reduce((a, b) => a + Number(b), 0); const f = flag('gcs', t); gcsTotal.textContent = `GCS ${t}${f.word ? `: ${wordFor(f) || f.word}` : ''}`; gcsTotal.dataset.level = f.level; }
    else { gcsTotal.textContent = parts.some((x) => x) ? 'Choose all three for a total' : ''; gcsTotal.dataset.level = 'none'; }
  };
  for (const g of [gE, gV, gM]) g.el.addEventListener('click', showGcs);

  const avpu = chipGroup({ id: 'v-avpu', options: AVPU, labelledBy: 'v-avpu-l' });
  const skin = h('div', { id: 'v-skin', class: 'stack tight' });
  const SKIN_NAME = { colour: 'Skin colour', temp: 'Skin temperature', moisture: 'Skin moisture' };
  const skinParts = Object.entries(SKIN).map(([k, opts]) => { const g = chipGroup({ id: `v-skin-${k}`, options: opts }); g.el.setAttribute('aria-label', SKIN_NAME[k]); skin.append(g.el); return g; });
  const pL = chipGroup({ id: 'v-pupil-l', options: PUPIL_CHOICES, labelledBy: 'v-pupil-l-l' });
  const pR = chipGroup({ id: 'v-pupil-r', options: PUPIL_CHOICES, labelledBy: 'v-pupil-r-l' });
  const equal = h('button', { type: 'button', class: 'chip', id: 'v-pupils-equal' }, 'Both equal and reactive');
  equal.addEventListener('click', () => { pL.set('normal'); pR.set('normal'); });
  const pain = chipGroup({ id: 'v-pain', options: Array.from({ length: 11 }, (_, i) => [String(i), String(i)]), labelledBy: 'v-pain-l' });
  const avpuNote = h('span', { class: 'flag', 'aria-live': 'polite' });
  avpu.el.addEventListener('click', () => { const f = flagAvpu(avpu.get()); avpuNote.textContent = f.level === 'ok' || f.level === 'none' ? '' : 'Not fully alert: check again'; avpuNote.dataset.level = f.level; });
  const painNote = h('span', { class: 'flag' });
  pain.el.addEventListener('click', () => { const f = flag('pain', pain.get() === null ? null : Number(pain.get())); painNote.textContent = f.level === 'ok' || f.level === 'none' ? '' : f.word; painNote.dataset.level = f.level; });

  const whenPick = chipGroup({ id: 'v-when', options: WHEN, value: '0', labelledBy: 'v-when-l' });
  const custom = h('input', { type: 'datetime-local', id: 'v-time', value: nowInput(), 'aria-label': 'Time taken', hidden: true });
  whenPick.el.addEventListener('click', () => { custom.hidden = whenPick.get() !== 'other'; });
  const again = chipGroup({ id: 'v-again', options: AGAIN, value: '', labelledBy: 'v-again-l' });
  const notes = h('input', { id: 'v-notes', maxlength: 255, placeholder: 'Anything else (optional)', 'aria-label': 'Notes' });
  const err = h('div');

  const copy = h('button', { type: 'button', class: 'btn', id: 'v-copy' }, 'Same as last set');
  copy.hidden = !last;
  copy.addEventListener('click', () => {
    for (const k of Object.keys(S)) S[k].set(last[k] ?? null);
    temp.set(last.temp_c == null ? null : unit.now === 'F' ? cToF(last.temp_c) : Number(last.temp_c));
    avpu.set(last.avpu || null); pain.set(last.pain ?? null);
    gE.set(last.gcs_e); gV.set(last.gcs_v); gM.set(last.gcs_m); showGcs();
    pL.set(last.pupil_left); pR.set(last.pupil_right);
    const have = new Set(String(last.skin || '').split(',').map((x) => x.trim()));
    Object.values(SKIN).forEach((opts, i) => skinParts[i].set((opts.find(([v]) => have.has(v)) || [null])[0]));
  });
  const save = h('button', { type: 'button', class: 'btn primary big', id: 'v-save' }, 'Save vitals');
  const group = ageGroup(age);

  const body = h('div', { class: 'vsheet stack' },
    h('p', { class: 'muted small' }, `${patientName}. Tap + or − to start from the last reading, or type a number. Leave anything you did not measure blank.`),
    group !== 'adult' ? h('p', { class: 'band-note', 'data-band': group }, `Flags use the normal ranges for ${GROUP_LABEL[group]}.`) : null,
    h('div', { class: 'row' }, copy),
    h('div', { class: 'vgrid' }, S.pulse.el, S.resp.el, S.spo2.el),
    h('div', { class: 'vgrid two' }, S.bp_sys.el, S.bp_dia.el),
    h('div', { class: 'vblock' }, h('h4', { id: 'v-avpu-l' }, 'Responsiveness'), avpu.el, avpuNote),
    h('div', { class: 'vblock' }, h('h4', { id: 'v-pain-l' }, 'Pain (0 to 10)'), pain.el, painNote),
    h('details', { class: 'more gcs', open: Boolean(last && last.gcs_e) }, h('summary', null, 'GCS: eyes, verbal, motor', gcsTotal),
      child ? h('p', { class: 'muted small' }, infant ? 'Uses the scale for babies under 2.' : 'Verbal uses the scale for children aged 2 to 4.') : null,
      h('div', { class: 'vblock' }, h('h4', { id: 'v-gcs-e-l' }, 'Eyes'), gE.el), h('div', { class: 'vblock' }, h('h4', { id: 'v-gcs-v-l' }, 'Verbal'), gV.el), h('div', { class: 'vblock' }, h('h4', { id: 'v-gcs-m-l' }, 'Motor'), gM.el)),
    h('div', { class: 'vblock' }, h('h4', null, 'Skin'), skin),
    h('div', { class: 'vblock' }, h('h4', null, 'Pupils'), h('div', { class: 'row tight' }, equal), h('div', { class: 'pupil-row' }, h('span', { id: 'v-pupil-l-l' }, 'Left pupil'), pL.el), h('div', { class: 'pupil-row' }, h('span', { id: 'v-pupil-r-l' }, 'Right pupil'), pR.el)),
    h('details', { class: 'more' }, h('summary', null, 'Temperature and blood sugar'), h('div', { class: 'row tight' }, h('span', { class: 'muted small', id: 'v-tunit-l' }, 'Temperature unit'), unitPick.el), h('div', { class: 'vgrid two' }, tempBox, S.glucose.el)),
    h('div', { class: 'vblock' }, h('h4', { id: 'v-when-l' }, 'Time taken'), whenPick.el, custom),
    h('div', { class: 'vblock' }, h('h4', { id: 'v-again-l' }, 'Check again in'), again.el),
    notes, err,
    h('div', { class: 'footer row' }, save));
  const dlg = dialog(`Vitals: ${patientName}`, body, { wide: true });
  dlg.box.classList.add('sheet');

  save.addEventListener('click', async () => {
    clear(err);
    const out = {};
    for (const [k, st] of Object.entries(S)) { const v = st.get(); if (v !== null) out[k] = v; }
    const t = temp.get();
    if (t !== null) out.temp_c = unit.now === 'F' ? fToC(t) : t;
    if (avpu.get()) out.avpu = avpu.get();
    const sk = skinParts.map((g) => g.get()).filter(Boolean);
    if (sk.length) out.skin = sk.join(', ');
    if (pL.get() || pR.get()) {
      if (pL.get()) out.pupil_left = pL.get();
      if (pR.get()) out.pupil_right = pR.get();
      out.pupils = pL.get() === 'normal' && pR.get() === 'normal' ? 'Equal and reactive' : `L ${pL.get() || '?'}, R ${pR.get() || '?'}`;
    }
    const g = [gE.get(), gV.get(), gM.get()];
    if (g.some((x) => x) && !g.every((x) => x)) { err.append(errorBox(new Error('Choose eyes, verbal and motor for the GCS, or leave all three blank'))); return; }
    if (g.every((x) => x)) { out.gcs_e = Number(g[0]); out.gcs_v = Number(g[1]); out.gcs_m = Number(g[2]); }
    if (pain.get() !== null) out.pain = Number(pain.get());
    if (notes.value.trim()) out.notes = notes.value.trim();
    if (!Object.keys(out).some((k) => k !== 'notes')) { err.append(errorBox(new Error('Enter at least one measurement'))); return; }
    const w = whenPick.get();
    if (w === 'other') { if (!custom.value) { err.append(errorBox(new Error('Pick the time'))); return; } out.taken_at = custom.value; } else out.taken_at = minutesAgo(Number(w || 0));
    out.recheck_minutes = again.get() ? Number(again.get()) : 0;
    save.disabled = true;
    try {
      const r = await send('POST', `${base}/vitals`, out, { caseId, label: 'Vitals' });
      dlg.close();
      sentToast(r, 'Vitals saved');
      if (onSaved) await onSaved(r);
    } catch (e) { err.append(errorBox(e)); save.disabled = false; }
  });
  return dlg;
}
