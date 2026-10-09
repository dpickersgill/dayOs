// The bedside card: what a patroller needs while the patient is still on the hill, above the paperwork. Who they are, what
// might hurt them (allergies), their latest vitals with a flag and a trend, when the next set is due, and one-tap actions.

import { del } from '../api.js';
import { h, state, button, confirmDialog, nowInput, fmtTime, label } from '../ui.js';
import { flag, flagAvpu, trend, ARROW, ARROW_WORD, STRIP } from '../vitals-guide.js';
import { openVitalsSheet, dueAt, setDue } from './patrol-vitals.js';

const QUICK = [['splint', 'Splint'], ['ice', 'Ice'], ['bandage', 'Bandage'], ['warming', 'Warming'], ['oxygen', 'Oxygen'], ['spinal_motion_restriction', 'Spine precautions']];

/** Minutes between a mountain-clock timestamp ('YYYY-MM-DD HH:MM:SS') and now. */
export function minutesSince(ts) {
  const a = Date.UTC(+ts.slice(0, 4), +ts.slice(5, 7) - 1, +ts.slice(8, 10), +ts.slice(11, 13), +ts.slice(14, 16));
  const n = nowInput();
  const b = Date.UTC(+n.slice(0, 4), +n.slice(5, 7) - 1, +n.slice(8, 10), +n.slice(11, 13), +n.slice(14, 16));
  return Math.max(0, Math.round((b - a) / 60000));
}
const agoText = (m) => (m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`);

/** What the follow-up button says, so a patroller can see at a glance whether anyone will be emailed. */
function followupWord(p) {
  if (p.no_followup) return 'Follow-up: do not contact';
  const minor = p.age_years !== null && p.age_years !== undefined && p.age_years < 18;
  if (minor) return p.guardian_email ? 'Follow-up: guardian email set' : 'Follow-up contact (guardian needed)';
  return p.email ? 'Follow-up: email set' : 'Follow-up contact';
}

const NONE_WORDS = /^(none|no|nkda|nka|n\/a|na|nil|denies)\b/i;
function sampleChip(name, value, { danger = false } = {}) {
  const text = value ? String(value) : '';
  if (!text) return state(`${name}: not recorded`, 'warn');
  if (NONE_WORDS.test(text.trim())) return state(`${name}: none`, 'neutral');
  return state(`${name}: ${text}`, danger ? 'bad' : 'neutral');
}

function tile(item, cur, prev, age) {
  const cell = (k) => (cur ? cur[k] : null);
  let text = '–'; let f = { level: 'none', word: '' }; let arrow = null;
  if (item.key === 'bp') {
    if (cur && cur.bp_sys != null) {
      text = `${cur.bp_sys}/${cur.bp_dia ?? '?'}`;
      const rank = { none: 0, ok: 1, watch: 2, alert: 3 };
      const a = flag('bp_sys', cur.bp_sys, age); const b = cur.bp_dia != null ? flag('bp_dia', cur.bp_dia, age) : { level: 'none', word: '' };
      f = rank[b.level] > rank[a.level] ? b : a;
      arrow = prev && prev.bp_sys != null ? trend(prev.bp_sys, cur.bp_sys) : null;
    }
  } else if (cell(item.key) != null) {
    text = String(cell(item.key));
    f = flag(item.key, cell(item.key), age);
    arrow = prev && prev[item.key] != null ? trend(prev[item.key], cell(item.key)) : null;
  }
  return h('div', { class: 'vtile', 'data-level': f.level, 'data-key': item.key },
    h('span', { class: 'vl' }, item.label), h('b', { class: 'vv' }, text),
    h('span', { class: 'vf' }, f.word || ' ', arrow ? h('span', { class: 'arrow', title: ARROW_WORD[arrow], 'aria-label': ARROW_WORD[arrow] }, ` ${ARROW[arrow]}`) : null));
}

/**
 * opts: { id, base, editable, reload, change(fn, message), injuryDialog, treatmentDialog, quickTreatment(kind), pullDialog, removePatient }
 * The card never writes to the server itself, except to remove a row; everything else goes through the callbacks.
 */
export function bedsideCard(p, c, opts) {
  const { id, base, editable } = opts;
  const age = p.age_years;
  const vit = p.vitals;
  const cur = vit[vit.length - 1]; const prev = vit[vit.length - 2];
  const name = `${p.first_name || 'Unknown'} ${p.last_name || ''}`.trim();
  const sub = [age != null && `${age} years`, p.sex && p.sex !== 'unknown' && label(p.sex), p.activity && label(p.activity), p.helmet === 'yes' ? 'Helmet' : p.helmet === 'no' ? 'No helmet' : null].filter(Boolean).join(', ');

  // ---- timer: when the next set is due, or how long since the last
  const due = h('div', { class: 'due', role: 'status', 'aria-live': 'off' });
  const drawDue = () => {
    const d = dueAt(p.id);
    const since = cur ? minutesSince(String(cur.taken_at)) : null;
    due.dataset.level = 'none';
    if (d) {
      const left = Math.round((d - Date.now()) / 1000);
      if (left > 0) { due.textContent = `Next vitals due in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`; due.dataset.level = 'ok'; }
      else { due.textContent = `Vitals overdue by ${Math.max(1, Math.round(-left / 60))} min`; due.dataset.level = 'alert'; }
    } else if (since !== null && since >= 15 && !p.disposition) {
      due.textContent = `Last vitals ${agoText(since)}`; due.dataset.level = 'watch';
    } else due.textContent = '';
  };
  drawDue();
  const t = setInterval(() => { if (!due.isConnected) { clearInterval(t); return; } drawDue(); }, 15000);
  if (t && t.unref) t.unref();

  const openVitals = () => openVitalsSheet({ base, patientId: p.id, patientName: name, age, last: cur, onSaved: opts.reload });

  const strip = h('div', { class: 'vstrip' }, STRIP.map((s) => tile(s, cur, prev, age)));
  const avpuF = cur ? flagAvpu(cur.avpu) : { level: 'none' };
  const extras = cur ? [cur.avpu && `${label(cur.avpu)}${avpuF.level === 'watch' || avpuF.level === 'alert' ? ' (check)' : ''}`, cur.skin, cur.pupils && `Pupils ${cur.pupils}`, cur.temp_c != null && `${cur.temp_c}°C`, cur.glucose != null && `Glucose ${cur.glucose}`, cur.notes].filter(Boolean).join(' · ') : '';

  const allVitals = vit.length ? h('details', { class: 'more' }, h('summary', null, `All vitals (${vit.length})`),
    h('div', { class: 'table-wrap' }, h('table', { class: 'vtable' }, h('thead', null, h('tr', null, ['Time', 'Pulse', 'Resp', 'BP', 'SpO₂', 'GCS', 'Pain', 'AVPU', 'Other', ''].map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', null, vit.map((v) => h('tr', null,
        h('td', null, fmtTime(v.taken_at)), h('td', null, v.pulse ?? ''), h('td', null, v.resp ?? ''), h('td', null, v.bp_sys ? `${v.bp_sys}/${v.bp_dia ?? '?'}` : ''), h('td', null, v.spo2 ?? ''), h('td', null, v.gcs ?? ''), h('td', null, v.pain ?? ''),
        h('td', null, v.avpu ? label(v.avpu) : ''), h('td', null, [v.pupils && `Pupils ${v.pupils}`, v.skin, v.temp_c != null && `${v.temp_c}°C`, v.glucose != null && `Glucose ${v.glucose}`, v.notes].filter(Boolean).join(', ')),
        h('td', { class: 'actions' }, editable ? button('Remove', opts.change(() => del(`${base}/vitals/${v.id}`)), { small: true }) : null))))))) : null;

  const injuries = h('div', { class: 'stack tight' }, h('div', { class: 'spread' }, h('h4', null, 'Injuries and findings'), editable ? button('Add injury', () => opts.injuryDialog(base), { small: true }) : null),
    p.injuries.length ? h('ul', { class: 'plain' }, p.injuries.map((i) => h('li', { class: 'spread' }, h('span', null, `${label(i.injury_type)}, ${label(i.body_region)}${i.side && i.side !== 'na' ? ` (${i.side})` : ''}`, i.notes ? h('span', { class: 'muted' }, ` ${i.notes}`) : null),
      editable ? button('Remove', opts.change(() => del(`${base}/injuries/${i.id}`)), { small: true }) : null))) : h('p', { class: 'muted' }, 'None recorded.'));

  const quick = editable ? h('div', { class: 'chip-row quick', role: 'group', 'aria-label': 'Log a treatment now' }, QUICK.map(([k, text]) => button(text, () => opts.quickTreatment(base, k, text), { small: true })),
    button('Medication or other…', () => opts.treatmentDialog(base), { small: true })) : null;
  const treatments = h('div', { class: 'stack tight' }, h('div', { class: 'spread' }, h('h4', null, 'Treatment log')), quick,
    p.treatments.length ? h('ul', { class: 'plain' }, p.treatments.map((tr) => h('li', { class: 'spread' }, h('span', null, h('b', null, fmtTime(tr.performed_at)), ' ', label(tr.kind), tr.medication ? `: ${tr.medication} ${tr.dose}${tr.route ? `, ${tr.route}` : ''}` : '', tr.description ? h('span', { class: 'muted' }, ` ${tr.description}`) : null),
      editable ? button('Remove', opts.change(() => del(`${base}/treatments/${tr.id}`)), { small: true }) : null))) : h('p', { class: 'muted' }, 'None recorded.'));

  const actions = h('div', { class: 'bed-actions' },
    h('div', { class: 'bed-primary' },
      editable ? h('button', { type: 'button', class: 'btn primary big', 'data-act': 'vitals', onclick: openVitals }, 'Add vitals') : null,
      h('a', { class: 'btn big', href: `#/patrol/handoff/${id}/${p.id}`, 'data-act': 'handoff' }, 'Hand-off sheet')),
    h('div', { class: 'bed-secondary' },
      h('a', { class: 'btn', href: `#/patrol/refusal/${id}/${p.id}`, 'data-act': 'refusal' }, 'Refusal of care'),
      h('a', { class: 'btn', href: `#/patrol/takehome/${id}/${p.id}`, 'data-act': 'takehome' }, 'Take-home sheet'),
      editable && opts.followupDialog ? button(followupWord(p), () => opts.followupDialog(p)) : null,
      editable ? button('Pull from customer record', () => opts.pullDialog(p)) : null));
  const foot = editable ? h('div', { class: 'bed-foot' }, button('Remove patient', () => confirmDialog('Remove this patient?', 'Their vitals, injuries and treatments are removed too.', 'Remove patient', opts.change(() => del(base), 'Patient removed'), { danger: true }), { kind: 'quiet-danger', small: true })) : null;

  return h('article', { class: 'panel stack bedside', 'data-bedside': p.id },
    h('div', { class: 'spread top' },
      h('div', null, h('h3', null, name), h('p', { class: 'muted' }, sub || 'Details not recorded yet')),
      h('div', { class: 'row' }, p.disposition ? state(label(p.disposition), 'neutral') : state('No outcome yet', 'warn'))),
    p.chief_complaint ? h('p', { class: 'complaint' }, h('b', null, 'Complaint: '), p.chief_complaint) : h('p', { class: 'muted' }, 'No chief complaint yet.'),
    h('div', { class: 'row sample' }, sampleChip('Allergies', p.allergies, { danger: true }), sampleChip('Medications', p.medications), sampleChip('History', p.medical_history)),
    h('div', { class: 'vhead spread' }, h('h4', null, cur ? `Vitals at ${fmtTime(cur.taken_at)} (${agoText(minutesSince(String(cur.taken_at)))})` : 'Vitals'), due),
    cur ? strip : h('p', { class: 'muted' }, 'No vitals recorded yet.'),
    extras ? h('p', { class: 'small muted' }, extras) : null,
    actions, allVitals, injuries, treatments, foot);
}
export { setDue };
