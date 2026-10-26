// The bedside tools: short sheets for what a patroller does with gloves on, each one a few taps.
//   assessSheet    primary survey, head injury questions, spine criteria, medical (OPQRST and a stroke check)
//   treatmentSheet splint or spinal motion restriction with CMS before and after, oxygen, medication
//   arrestSheet    a running log for a cardiac arrest: time down, CPR, pads, each shock, pulse back
//   voidDialog     marks a wrong entry "entered in error" with a reason (nothing clinical is deleted)
// Everything is sent through the outbox, so it is kept on the phone when there is no signal.

import { post, get } from '../api.js';
import { h, clear, dialog, toast, nowInput, nowStamp, fmtTime, errorBox, label, formDialog, field, input } from '../ui.js';
import { send, pending } from '../outbox.js';
import { O2_DEVICES, ARREST_ACTIONS, atTime } from '../care-text.js';

/** A row of tap-chips. Single choice (tap again to clear) or several. */
export function chipGroup({ id, options, value, multi = false, onChange, labelledBy }) {
  let cur = multi ? new Set(value || []) : (value ?? '');
  const row = h('div', { class: 'chip-row', role: 'group', id, 'aria-labelledby': labelledBy });
  const draw = () => { for (const b of row.querySelectorAll('button')) b.setAttribute('aria-pressed', String(multi ? cur.has(b.dataset.value) : b.dataset.value === String(cur))); };
  for (const [v, text] of options) {
    const b = h('button', { type: 'button', class: 'chip', 'data-value': String(v), 'aria-pressed': 'false' }, text);
    b.addEventListener('click', () => {
      if (multi) { if (cur.has(String(v))) cur.delete(String(v)); else cur.add(String(v)); } else cur = String(cur) === String(v) ? '' : String(v);
      draw(); if (onChange) onChange(api.get());
    });
    row.append(b);
  }
  const api = {
    el: row,
    get: () => (multi ? [...cur] : (cur === '' ? null : cur)),
    set: (v) => { cur = multi ? new Set((v || []).map(String)) : (v === null || v === undefined ? '' : String(v)); draw(); },
  };
  draw();
  return api;
}

/** 'YYYY-MM-DDTHH:MM' some minutes ago on the mountain's clock. */
export function minutesAgo(n) {
  if (!n) return nowStamp();
  const d = new Date(`${nowInput()}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() - n);
  return d.toISOString().slice(0, 16);
}

/** When it was done: Now, 5 or 10 minutes ago, or a time picked. Always gives a time, so an entry saved offline keeps it. */
export function whenPicker(id = 'when') {
  const pick = chipGroup({ id, options: [['0', 'Now'], ['5', '5 min ago'], ['10', '10 min ago'], ['other', 'Pick a time']], value: '0', labelledBy: `${id}-l` });
  const custom = h('input', { type: 'datetime-local', value: nowInput(), 'aria-label': 'Time', hidden: true });
  pick.el.addEventListener('click', () => { custom.hidden = pick.get() !== 'other'; });
  return {
    el: h('div', { class: 'vblock' }, h('h4', { id: `${id}-l` }, 'When'), pick.el, custom),
    get: () => { const w = pick.get() || '0'; if (w === 'other') { if (!custom.value) throw new Error('Pick the time'); return custom.value; } return minutesAgo(Number(w)); },
  };
}

const savedWord = (r) => (r && r.queued ? 'Kept on this phone. It will send when the signal returns.' : null);
export function sentToast(r, text) { toast(savedWord(r) || text, r && r.queued ? 'warn' : 'ok'); }

// ---------------------------------------------------------------- assessment sheets, drawn from the form registry
const SHEETS = {
  survey: { title: 'Primary survey', keys: ['ps_bleeding', 'ps_airway', 'ps_breathing', 'ps_circulation', 'ps_disability', 'ps_time'], stamp: 'ps_time', intro: 'Bleeding, airway, breathing, circulation, disability. Tap what you find.' },
  head: { title: 'Head injury check', section: 'head', intro: 'Ask again at each set of vitals. A change matters more than one answer.' },
  spine: { title: 'Spine', section: 'spine', intro: 'The answers your protocol uses to decide on spinal motion restriction.' },
  medical: { title: 'Medical: OPQRST and stroke check', keys: ['opqrst_onset', 'opqrst_provokes', 'opqrst_quality', 'opqrst_region', 'opqrst_severity', 'opqrst_time', 'stroke_face', 'stroke_arm', 'stroke_speech', 'stroke_last_well'], intro: 'For an illness: what the pain or problem is like, and a quick stroke check (face, arms, speech).' },
  arrest: { title: 'Cardiac arrest', section: 'arrest' },
};
export const SHEET_KEYS = (def, which) => { const s = SHEETS[which]; return s.keys || def.fields.filter((f) => f.scope === 'patient' && f.section === s.section).map((f) => f.key); };
/** Has anything on this sheet been answered for the patient? */
export const sheetDone = (def, which, p) => SHEET_KEYS(def, which).some((k) => { const v = (p.form || {})[k]; return v !== undefined && v !== null && v !== ''; });

function questions(def, keys, form) {
  const fields = keys.map((k) => def.fields.find((f) => f.scope === 'patient' && f.key === k)).filter(Boolean);
  const ctl = [];
  const reflect = () => {
    const vals = { ...form }; for (const c of ctl) vals[c.f.key] = c.get();
    for (const c of ctl) if (c.f.when) c.wrap.hidden = c.f.when.equals !== undefined ? vals[c.f.when.field] !== c.f.when.equals : !(c.f.when.in || []).includes(vals[c.f.when.field]);
  };
  for (const f of fields) {
    const v = form[f.key];
    const id = `q-${f.key}`;
    let get; let el;
    if (f.type === 'select') { const g = chipGroup({ id, options: f.options.map((o) => [o.value, o.label]), value: v, onChange: reflect, labelledBy: `${id}-l` }); el = g.el; get = g.get; }
    else if (f.type === 'time') {
      const t = h('input', { type: 'time', id, value: v || '' });
      const now = h('button', { type: 'button', class: 'chip' }, 'Now');
      now.addEventListener('click', () => { t.value = nowInput().slice(11); });
      el = h('div', { class: 'row tight' }, t, now); get = () => t.value || null;
    } else if (f.type === 'number') { const n = h('input', { type: 'number', inputmode: 'numeric', id, min: f.min, max: f.max, value: v ?? '', class: 'short-num' }); el = n; get = () => (n.value === '' ? null : Number(n.value)); }
    else { const t = h('input', { id, value: v || '', maxlength: 300 }); el = t; get = () => t.value.trim() || null; }
    const wrap = h('div', { class: 'vblock q', 'data-q': f.key }, h('h4', { id: `${id}-l` }, h('label', { for: id }, f.label)), el, f.hint ? h('span', { class: 'hint' }, f.hint) : null);
    ctl.push({ f, wrap, get });
  }
  reflect();
  return { els: ctl.map((c) => c.wrap), values: () => { const out = {}; for (const c of ctl) out[c.f.key] = c.wrap.hidden ? null : c.get(); return out; } };
}

/** A sheet of questions for one patient. Only answers that changed are sent. */
export function assessSheet({ def, which, patient, base, caseId, onSaved }) {
  const s = SHEETS[which];
  const form = patient.form || {};
  const q = questions(def, SHEET_KEYS(def, which), form);
  const err = h('div');
  const save = h('button', { type: 'button', class: 'btn primary big', 'data-act': 'save-sheet' }, 'Save');
  const name = `${patient.first_name || ''} ${patient.last_name || ''}`.trim();
  const dlg = dialog(`${s.title}: ${name}`, h('div', { class: 'vsheet stack', 'data-sheet': which }, s.intro ? h('p', { class: 'muted small' }, s.intro) : null, ...q.els, err, h('div', { class: 'footer row' }, save)), { wide: true });
  dlg.box.classList.add('sheet');
  save.addEventListener('click', async () => {
    clear(err);
    const vals = q.values();
    if (s.stamp && !vals[s.stamp] && Object.entries(vals).some(([k, v]) => k !== s.stamp && v !== null)) vals[s.stamp] = nowInput().slice(11);
    const changed = {};
    for (const [k, v] of Object.entries(vals)) if ((form[k] ?? null) !== v) changed[k] = v;
    if (!Object.keys(changed).length) { dlg.close(); return; }
    save.disabled = true;
    try {
      const r = await send('PATCH', base, { form: changed }, { caseId, label: s.title });
      dlg.close();
      sentToast(r, `${s.title} saved`);
      if (onSaved) await onSaved(r);
    } catch (e) { err.append(errorBox(e)); save.disabled = false; }
  });
  return dlg;
}

// ---------------------------------------------------------------- treatments with their details
const CMS_CHOICES = [['present', 'Present'], ['absent', 'Absent'], ['not_checked', 'Not checked']];
function cmsBlock(id, title) {
  const parts = [['c', 'Circulation (pulse, colour, warmth)'], ['m', 'Motor (can move fingers or toes)'], ['s', 'Sensation (can feel touch)']].map(([k, text]) => {
    const g = chipGroup({ id: `${id}-${k}`, options: CMS_CHOICES, labelledBy: `${id}-${k}-l` });
    return { k, g, el: h('div', { class: 'cms-row' }, h('span', { id: `${id}-${k}-l` }, text), g.el) };
  });
  const all = h('button', { type: 'button', class: 'chip' }, 'All present');
  all.addEventListener('click', () => { for (const p of parts) p.g.set('present'); });
  return {
    el: h('fieldset', { class: 'vblock cms', id }, h('legend', null, title), h('div', { class: 'row tight' }, all), ...parts.map((p) => p.el)),
    get: () => { const v = Object.fromEntries(parts.map((p) => [p.k, p.g.get()])); return Object.values(v).every((x) => x) ? v : (Object.values(v).some((x) => x) ? 'partial' : null); },
  };
}

const LIMBS = [['left_arm', 'Left arm'], ['right_arm', 'Right arm'], ['left_leg', 'Left leg'], ['right_leg', 'Right leg'], ['junctional', 'Junctional (groin, armpit)']];
const NO_ALLERGY = /^(none|no|nkda|nka|n\/a|na|nil|denies)\b/i;
let formularyCache = null; // the last formulary seen, for a sheet opened with no signal
const UNITS = ['mg', 'mcg', 'g', 'mL', 'units', 'puffs', 'tablets', 'drops'];
const ROUTES = [['oral', 'Oral'], ['chewed', 'Chewed'], ['sublingual', 'Under the tongue'], ['inhaled', 'Inhaled'], ['intramuscular', 'Injection (IM)'], ['intranasal', 'Nasal'], ['other', 'Other']];
const AUTH = ['Standing order', 'Medical control (by radio or phone)', 'Patient\'s own medication'];
const AUTH_FOR = { standing_order: 'Standing order', assist_own: 'Patient\'s own medication', medical_control: 'Medical control (by radio or phone)' };

/**
 * kind: splint | spinal_motion_restriction | oxygen | medication. roster gives "done by" for a medication.
 * A splint or spinal motion restriction asks for circulation, motor and sensation before and after.
 */
export function treatmentSheet({ kind, base, caseId, roster = [], patient = null, onSaved }) {
  const when = whenPicker(`t-when-${kind}`);
  const err = h('div');
  const parts = [];
  let collect;
  const titles = { splint: 'Splint', spinal_motion_restriction: 'Spinal motion restriction', oxygen: 'Oxygen', medication: 'Medication', tourniquet: 'Tourniquet' };
  if (kind === 'splint' || kind === 'spinal_motion_restriction') {
    const part = h('input', { id: 't-part', maxlength: 60, placeholder: kind === 'splint' ? 'Left lower leg' : 'Whole spine' });
    const before = cmsBlock('cms-before', 'CMS before');
    const after = cmsBlock('cms-after', 'CMS after');
    parts.push(h('div', { class: 'vblock' }, h('h4', null, h('label', { for: 't-part' }, kind === 'splint' ? 'What was splinted' : 'Device or method (optional)')), part), before.el, after.el,
      h('p', { class: 'muted small' }, 'Check below the injury before you splint and again after. Anything absent after splinting: loosen and check again.'));
    collect = () => {
      const b = before.get(); const a = after.get();
      if (b === 'partial' || a === 'partial') throw new Error('Answer all three of circulation, motor and sensation, or none');
      return { kind, detail: { ...(part.value.trim() ? { body_part: part.value.trim() } : {}), ...(b ? { cms_before: b } : {}), ...(a ? { cms_after: a } : {}) } };
    };
  } else if (kind === 'tourniquet') {
    const limb = chipGroup({ id: 't-limb', options: LIMBS, labelledBy: 't-limb-l' });
    parts.push(h('div', { class: 'vblock' }, h('h4', { id: 't-limb-l' }, 'Where'), limb.el),
      h('p', { class: 'muted small' }, 'The time it went on is shown at the top of the patient and the hand-off sheet. Write it on the tourniquet too.'));
    collect = () => { if (!limb.get()) throw new Error('Say which limb'); return { kind, detail: { limb: limb.get() } }; };
  } else if (kind === 'oxygen') {
    const device = chipGroup({ id: 't-o2-device', options: O2_DEVICES, value: 'non_rebreather', labelledBy: 't-o2-device-l' });
    const lpm = chipGroup({ id: 't-o2-lpm', options: [2, 4, 6, 10, 12, 15].map((n) => [String(n), `${n}`]), value: '15', labelledBy: 't-o2-lpm-l' });
    parts.push(h('div', { class: 'vblock' }, h('h4', { id: 't-o2-device-l' }, 'Device'), device.el), h('div', { class: 'vblock' }, h('h4', { id: 't-o2-lpm-l' }, 'Liters per minute'), lpm.el));
    collect = () => ({ kind, detail: { ...(device.get() ? { o2_device: device.get() } : {}), ...(lpm.get() ? { o2_lpm: Number(lpm.get()) } : {}) } });
  } else {
    // The patrol's formulary decides what can be given, how, and who may give it; the server checks it again.
    const allergies = patient && patient.allergies && !NO_ALLERGY.test(String(patient.allergies).trim()) ? String(patient.allergies).trim() : '';
    const vitals = patient ? (patient.vitals || []).filter((v) => !v.voided_at && v.bp_sys != null) : [];
    const lastBp = vitals[vitals.length - 1] || null;
    let drugs = formularyCache ? formularyCache.formulary : [];
    let stock = formularyCache ? formularyCache.stock : [];
    let chosen = null;
    const name = h('input', { id: 't-med', maxlength: 100, list: 't-med-list', autocomplete: 'off' });
    const dl = h('datalist', { id: 't-med-list' });
    const quick = h('div', { class: 'chip-row' });
    const about = h('p', { class: 'muted small' });
    const dose = h('input', { id: 't-dose', type: 'number', inputmode: 'decimal', min: 0, step: 'any', class: 'short-num' });
    const unit = chipGroup({ id: 't-unit', options: UNITS.map((u) => [u, u]), value: 'mg', labelledBy: 't-unit-l' });
    const route = chipGroup({ id: 't-route', options: ROUTES, value: 'oral', labelledBy: 't-route-l' });
    const why = h('input', { id: 't-why', maxlength: 255, placeholder: 'Knee pain 7/10' });
    const auth = h('input', { id: 't-auth', maxlength: 150, list: 't-auth-list' });
    const al = h('datalist', { id: 't-auth-list' }, AUTH.map((m) => h('option', { value: m })));
    const by = h('select', { id: 't-by' }, h('option', { value: '' }, 'Me'), roster.filter((m) => m.staff_status === 'active').map((m) => h('option', { value: m.staff_id }, `${m.first_name} ${m.last_name}`)));
    const lot = h('select', { id: 't-lot' }, h('option', { value: '' }, 'Not from patrol stock'));
    // allergies: shown in red and confirmed before anything is given
    const allergyOk = h('input', { type: 'checkbox', id: 't-allergy-ok' });
    const allergyWhy = h('input', { maxlength: 255, placeholder: 'Why it is safe to give anyway', hidden: true, 'aria-label': 'Reason to give despite the allergy' });
    const allergyBox = allergies ? h('div', { class: 'vblock allergy-box', role: 'alert' }, h('h4', null, `Allergies: ${allergies}`), h('label', { class: 'check' }, allergyOk, ' I checked this medication against the allergies'), allergyWhy) : null;
    // nitroglycerin: blood pressure and erectile dysfunction medication
    const pde5 = chipGroup({ id: 't-pde5', options: [['no', 'No'], ['yes', 'Yes']], labelledBy: 't-pde5-l' });
    const bpWhy = h('input', { maxlength: 255, placeholder: 'Only on medical control: who said to go ahead' });
    const nitroBox = h('div', { class: 'vblock', hidden: true },
      h('h4', null, lastBp ? `Last BP ${lastBp.bp_sys}/${lastBp.bp_dia ?? '?'} at ${fmtTime(String(lastBp.taken_at).replace(' ', 'T'))}` : 'No blood pressure recorded'),
      h('p', { class: 'muted small' }, 'Not under 100, and take a fresh one within 5 minutes before giving.'),
      h('h4', { id: 't-pde5-l' }, 'Viagra, Cialis or Levitra in the last 48 hours?'), pde5.el, h('label', null, 'Override (medical control only)', bpWhy));
    const pick = (n) => {
      name.value = n;
      chosen = drugs.find((f) => f.name.toLowerCase() === n.trim().toLowerCase()) || null;
      clear(about);
      clear(lot).append(h('option', { value: '' }, 'Not from patrol stock'));
      nitroBox.hidden = !/nitro/i.test(n);
      if (allergies) {
        const hit = n && allergies.toLowerCase().includes(n.trim().toLowerCase().split(/[\s-]/)[0]);
        allergyWhy.hidden = !hit;
        allergyBox.dataset.hit = hit ? 'yes' : 'no';
      }
      if (!chosen) { if (n && drugs.length) about.append(h('b', null, `${n} is not on the formulary.`), ' It cannot be recorded as given.'); return; }
      about.append(`${({ standing_order: 'Standing order', assist_own: 'Assist with the patient\'s own only', medical_control: 'Medical control only' })[chosen.authority]}`,
        chosen.max_dose !== null ? `. Largest dose ${chosen.max_dose} ${chosen.dose_unit || ''}` : '', chosen.notes ? `. ${chosen.notes}` : '');
      auth.value = AUTH_FOR[chosen.authority];
      if (chosen.dose_unit && UNITS.includes(chosen.dose_unit)) unit.set(chosen.dose_unit);
      if (chosen.routes.length) route.set(chosen.routes[0]);
      for (const k of stock.filter((x) => x.formulary_id === chosen.id)) lot.append(h('option', { value: k.id }, `Lot ${k.lot || k.id}${k.station ? `, ${k.station}` : ''}${k.expires_on ? `, exp ${String(k.expires_on).slice(0, 10)}` : ''} (${k.quantity} ${k.unit})`));
    };
    name.addEventListener('change', () => pick(name.value));
    const drawList = () => {
      clear(dl).append(...drugs.map((f) => h('option', { value: f.name })));
      clear(quick).append(...drugs.slice(0, 6).map((f) => { const b = h('button', { type: 'button', class: 'chip' }, f.name); b.addEventListener('click', () => pick(f.name)); return b; }));
    };
    drawList();
    get('/patrol/meds/for-case').then((r) => { formularyCache = r; drugs = r.formulary; stock = r.stock; drawList(); if (name.value) pick(name.value); }).catch(() => {});
    parts.push(
      allergyBox,
      h('div', { class: 'vblock' }, h('h4', null, h('label', { for: 't-med' }, 'Medication')), name, dl, quick, about),
      nitroBox,
      h('div', { class: 'vblock' }, h('h4', null, h('label', { for: 't-dose' }, 'Dose')), h('div', { class: 'row tight' }, dose), h('span', { id: 't-unit-l', class: 'muted small' }, 'Unit'), unit.el),
      h('div', { class: 'vblock' }, h('h4', { id: 't-route-l' }, 'Route'), route.el),
      h('div', { class: 'vblock' }, h('h4', null, h('label', { for: 't-why' }, 'Given for')), why),
      h('div', { class: 'vblock' }, h('h4', null, h('label', { for: 't-auth' }, 'Authorized by')), auth, al, h('span', { class: 'hint' }, 'Your standing order, the doctor on medical control, or the patient\'s own medication')),
      h('div', { class: 'vblock' }, h('h4', null, h('label', { for: 't-by' }, 'Given by')), by),
      h('div', { class: 'vblock' }, h('h4', null, h('label', { for: 't-lot' }, 'From stock')), lot),
      h('p', { class: 'muted small' }, 'Record the effect from the treatment log once you have seen it.'));
    collect = () => {
      if (!name.value.trim()) throw new Error('Say which medication');
      if (drugs.length && !chosen) throw new Error(`${name.value.trim()} is not on this patrol's formulary`);
      if (dose.value === '' || !unit.get()) throw new Error('Give the dose and its unit');
      if (allergies && !allergyOk.checked) throw new Error('Check the medication against the allergies first');
      if (allergies && !allergyWhy.hidden && !allergyWhy.value.trim()) throw new Error(`The patient is allergic to "${allergies}". Say why it is safe, or do not give it.`);
      if (!nitroBox.hidden && !pde5.get()) throw new Error('Ask about erectile dysfunction medication first');
      const r = route.get();
      return {
        kind, medication: chosen ? chosen.name : name.value.trim(), dose: `${Number(dose.value)} ${unit.get()}`, ...(r ? { route: (ROUTES.find((x) => x[0] === r) || [r, r])[0] } : {}),
        ...(by.value ? { performed_by_staff: Number(by.value) } : {}),
        detail: {
          dose_value: Number(dose.value), dose_unit: unit.get(), ...(why.value.trim() ? { indication: why.value.trim() } : {}), ...(auth.value.trim() ? { authorised_by: auth.value.trim() } : {}),
          ...(allergies ? { allergy_checked: true } : {}), ...(allergyWhy.value.trim() ? { allergy_override: allergyWhy.value.trim() } : {}),
          ...(!nitroBox.hidden ? { pde5: pde5.get(), ...(bpWhy.value.trim() ? { bp_override: bpWhy.value.trim() } : {}) } : {}),
          ...(lot.value ? { stock_id: Number(lot.value) } : {}),
        },
      };
    };
  }
  const save = h('button', { type: 'button', class: 'btn primary big', 'data-act': 'save-treatment' }, `Log ${titles[kind].toLowerCase()}`);
  const dlg = dialog(titles[kind], h('div', { class: 'vsheet stack', 'data-treatment-sheet': kind }, ...parts, when.el, err, h('div', { class: 'footer row' }, save)), { wide: true });
  dlg.box.classList.add('sheet');
  save.addEventListener('click', async () => {
    clear(err);
    let body;
    try { body = { ...collect(), performed_at: when.get() }; } catch (e) { err.append(errorBox(e)); return; }
    if (body.detail && !Object.keys(body.detail).length) delete body.detail;
    save.disabled = true;
    try {
      const r = await send('POST', `${base}/treatments`, body, { caseId, label: titles[kind] });
      dlg.close();
      sentToast(r, `${titles[kind]} logged`);
      if (onSaved) await onSaved(r);
    } catch (e) { err.append(errorBox(e)); save.disabled = false; }
  });
  return dlg;
}

// ---------------------------------------------------------------- cardiac arrest log
const ARREST_KINDS = new Set(['cpr', 'aed', 'rosc']);
/** Every tap is logged at once with its time. A clock runs from CPR start and a two-minute cycle prompts the rhythm check. */
export function arrestSheet({ def, patient, base, caseId, onClose }) {
  const name = `${patient.first_name || ''} ${patient.last_name || ''}`.trim();
  const log = [...patient.treatments.filter((t) => ARREST_KINDS.has(t.kind) && !t.voided_at).map((t) => ({ at: String(t.performed_at).replace(' ', 'T'), kind: t.kind, action: (t.detail || {}).action, joules: (t.detail || {}).joules })),
    ...pending(caseId).filter((x) => x.path === `${base}/treatments` && ARREST_KINDS.has(x.body.kind)).map((x) => ({ at: x.body.performed_at, kind: x.body.kind, action: (x.body.detail || {}).action, queued: true }))]
    .sort((a, b) => (a.at < b.at ? -1 : 1));
  const list = h('ol', { class: 'arrest-log', 'aria-live': 'polite' });
  const clock = h('div', { class: 'arrest-clock' });
  const cycle = h('div', { class: 'arrest-cycle', 'aria-hidden': 'true' });
  const say = h('div', { class: 'visually-hidden', role: 'status', 'aria-live': 'assertive' }); // spoken once, when a rhythm check is due
  const word = (e) => (e.kind === 'rosc' ? 'Pulse returned' : e.kind === 'cpr' ? ARREST_ACTIONS[e.action] || 'CPR' : `${ARREST_ACTIONS[e.action] || 'AED'}${e.joules ? ` (${e.joules} J)` : ''}`);
  const shocks = () => log.filter((e) => e.kind === 'aed' && e.action === 'shock').length;
  const draw = () => {
    clear(list).append(...(log.length ? log.map((e) => h('li', { class: e.queued ? 'queued' : null }, h('b', null, atTime(e.at)), ` ${word(e)}`, e.queued ? h('span', { class: 'muted' }, ' (waiting to send)') : null)) : [h('li', { class: 'muted' }, 'Nothing logged yet. Tap as things happen.')]));
    tick();
  };
  let warned = null;
  const tick = () => {
    // Count from the latest CPR start, so a second arrest after a pulse came back starts a fresh clock and cycle.
    const starts = log.filter((e) => e.kind === 'cpr' && e.action === 'start');
    const start = starts[starts.length - 1];
    const since = start ? log.slice(log.indexOf(start)) : [];
    const last = [...since].reverse().find((e) => (e.kind === 'aed' && ['shock', 'no_shock', 'rhythm_check'].includes(e.action)) || (e.kind === 'cpr' && e.action === 'start'));
    const sec = (at) => Math.max(0, Math.round((Date.parse(`${nowStamp()}Z`) - Date.parse(`${String(at).length === 16 ? `${at}:00` : at}Z`)) / 1000));
    const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    const running = start && !since.some((e) => e.kind === 'rosc' || (e.kind === 'cpr' && e.action === 'stop'));
    clock.textContent = running ? `CPR running ${mmss(sec(start.at))} · ${shocks()} shock${shocks() === 1 ? '' : 's'} in all` : start ? `CPR stopped · ${shocks()} shock${shocks() === 1 ? '' : 's'} in all` : 'CPR not started';
    if (running && last) {
      const left = 120 - (sec(last.at) % 120);
      cycle.textContent = left <= 15 ? `Rhythm check due: ${left} s` : `Next rhythm check in ${mmss(left)}`;
      cycle.dataset.level = left <= 15 ? 'alert' : 'ok';
      const cycleNo = Math.floor(sec(last.at) / 120);
      if (left <= 15 && warned !== cycleNo) { warned = cycleNo; say.textContent = 'Rhythm check due'; }
    } else { cycle.textContent = ''; cycle.dataset.level = 'none'; }
  };
  const tap = (kind, action, text) => {
    const b = h('button', { type: 'button', class: `btn arrest-btn${kind === 'rosc' ? ' good' : action === 'shock' ? ' danger' : ''}`, 'data-arrest': action || kind }, text);
    b.addEventListener('click', async () => {
      b.disabled = true;
      const at = nowStamp();
      const body = { kind, performed_at: at, ...(action ? { detail: { action } } : {}) };
      try {
        const r = await send('POST', `${base}/treatments`, body, { caseId, label: text });
        log.push({ at, kind, action, queued: Boolean(r && r.queued) });
        draw();
        toast(r && r.queued ? `${text}: kept on this phone` : `${text} ${atTime(at)}`, r && r.queued ? 'warn' : 'ok');
      } catch (e) { toast(e.message, 'error'); }
      b.disabled = false;
    });
    return b;
  };
  const f = patient.form || {};
  const down = h('input', { type: 'time', id: 'a-down', value: f.arrest_time_down || '' });
  const witnessed = chipGroup({ id: 'a-witnessed', options: [['witnessed', 'Witnessed'], ['unwitnessed', 'Not witnessed']], value: f.arrest_witnessed });
  const bystander = chipGroup({ id: 'a-bystander', options: [['yes', 'Bystander CPR'], ['no', 'No bystander CPR']], value: f.arrest_bystander_cpr });
  const saveDown = h('button', { type: 'button', class: 'btn' }, 'Save');
  saveDown.addEventListener('click', async () => {
    const form = { arrest_time_down: down.value || null, arrest_witnessed: witnessed.get(), arrest_bystander_cpr: bystander.get() };
    try { sentToast(await send('PATCH', base, { form }, { caseId, label: 'Time down' }), 'Saved'); } catch (e) { toast(e.message, 'error'); }
  });
  const body = h('div', { class: 'arrest stack', 'data-arrest-sheet': patient.id },
    h('div', { class: 'arrest-top' }, clock, cycle, say),
    h('div', { class: 'arrest-grid' },
      tap('cpr', 'start', 'CPR started'), tap('aed', 'pads_on', 'Pads on'), tap('aed', 'shock', 'Shock delivered'), tap('aed', 'no_shock', 'No shock advised'),
      tap('aed', 'rhythm_check', 'Rhythm check'), tap('cpr', 'stop', 'CPR stopped'), tap('rosc', null, 'Pulse returned')),
    h('details', { class: 'more' }, h('summary', null, 'Time down and bystander CPR'),
      h('div', { class: 'stack' }, h('div', { class: 'row tight' }, h('label', { for: 'a-down' }, 'Time down '), down), witnessed.el, bystander.el, h('div', { class: 'row' }, saveDown))),
    h('h4', null, 'Log'), list);
  const dlg = dialog(`Cardiac arrest: ${name}`, body, { wide: true });
  dlg.box.classList.add('sheet', 'arrest-sheet');
  draw();
  const t = setInterval(() => { if (!body.isConnected) { clearInterval(t); if (onClose) onClose(); return; } tick(); }, 1000);
  if (t.unref) t.unref();
  return dlg;
}

// ---------------------------------------------------------------- entered in error, and a medication's effect
const REASONS = ['Typed wrongly', 'Wrong patient', 'Recorded twice', 'Belongs on another case'];
/** Marks one entry as entered in error. It stays on the record, struck through, with the reason. */
export function voidDialog({ what, path, onDone }) {
  const reason = input({ name: 'reason', required: true, maxlength: 255, minlength: 3 });
  const chips = h('div', { class: 'chip-row' }, REASONS.map((r) => { const b = h('button', { type: 'button', class: 'chip' }, r); b.addEventListener('click', () => { reason.value = r; }); return b; }));
  return formDialog('Mark as entered in error', h('div', { class: 'stack' },
    h('p', null, h('b', null, what)),
    h('p', { class: 'muted small' }, 'It stays on the record, struck through, with your reason and your name. Nothing is deleted from a patient record.'),
    chips, field('Reason', reason)),
  async (fd) => {
    await post(`${path}/void`, { reason: String(fd.get('reason') || '').trim() });
    toast('Marked as entered in error');
    if (onDone) await onDone();
  }, { submitText: 'Mark as entered in error' });
}

export function effectDialog({ base, t, onDone }) {
  const effect = input({ name: 'effect', required: true, maxlength: 255, placeholder: 'Pain down from 7 to 4' });
  return formDialog(`Effect of ${t.medication}`, h('div', { class: 'stack' }, h('p', { class: 'muted small' }, `Given at ${fmtTime(t.performed_at)}. What changed?`), field('Effect seen', effect)), async (fd) => {
    await post(`${base}/treatments/${t.id}/effect`, { effect: String(fd.get('effect') || '').trim() });
    toast('Effect recorded');
    if (onDone) await onDone();
  }, { submitText: 'Save effect' });
}

export { label };
