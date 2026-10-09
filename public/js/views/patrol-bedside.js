// The bedside card: what a patroller needs while the patient is still on the hill. Who they are, what might hurt them
// (allergies), their latest vitals with a flag and a trend, when the next set is due, the assessment tools, one-tap
// treatments, and the logs of injuries and treatment. Wrong entries are marked "entered in error", never deleted, and
// entries kept on the phone while there is no signal show as waiting to send.

import { h, state, button, nowInput, nowStamp, fmtTime, label } from '../ui.js';
import { flag, flagAvpu, trend, ARROW, ARROW_WORD, STRIP } from '../vitals-guide.js';
import { openVitalsSheet, dueAt } from './patrol-vitals.js';
import { assessSheet, treatmentSheet, arrestSheet, voidDialog, effectDialog, sheetDone, sentToast } from './patrol-tools.js';
import { send, pending } from '../outbox.js';
import { live, atTime, treatmentName, treatmentDetail, cmsLost, lateNote, vitalsWords, gcsText, pupilsText, tempText } from '../care-text.js';

/** Quick treatments. A sheet opens for those with details worth recording; the rest log with one tap. */
const QUICK = [['splint', 'Splint', 'sheet'], ['spinal_motion_restriction', 'Spine', 'sheet'], ['oxygen', 'Oxygen', 'sheet'], ['ice', 'Ice'], ['bandage', 'Bandage'], ['warming', 'Warming']];

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
    h('span', { class: 'vf' }, f.word || ' ', arrow ? h('span', { class: 'arrow', title: ARROW_WORD[arrow], 'aria-label': ARROW_WORD[arrow] }, ` ${ARROW[arrow]}`) : null));
}

/** "Entered in error" mark: struck-through text with the reason under it. */
export function voidedNote(row) {
  return row.voided_at ? h('span', { class: 'void-note' }, `Entered in error: ${row.void_reason}${row.voided_by_email ? ` (${row.voided_by_email}, ${fmtTime(row.voided_at)})` : ''}`) : null;
}
const lateTag = (row, key) => { const n = lateNote(row, key); return n ? h('span', { class: 'late-tag', title: 'Typed in more than 15 minutes from the time it records' }, n) : null; };
const queuedTag = () => h('span', { class: 'queued-tag' }, 'Waiting to send');

/**
 * opts: { id, base, editable, def, roster, reload, change, injuryDialog, treatmentDialog, pullDialog, followupDialog }
 * Writes go through the outbox (kept on the phone with no signal) or through the callbacks.
 */
export function bedsideCard(p, c, opts) {
  const { id, base, editable, def } = opts;
  const age = p.age_years;
  const queued = pending(id).filter((x) => x.path === base || x.path.startsWith(`${base}/`));
  const vit = live(p.vitals);
  const cur = vit[vit.length - 1]; const prev = vit[vit.length - 2];
  const name = `${p.first_name || 'Unknown'} ${p.last_name || ''}`.trim();
  const sub = [age != null && `${age} years`, p.sex && p.sex !== 'unknown' && label(p.sex), p.activity && label(p.activity), p.helmet === 'yes' ? 'Helmet' : p.helmet === 'no' ? 'No helmet' : null].filter(Boolean).join(', ');
  const after = async (r) => { if (!(r && r.queued)) await opts.reload(); else opts.redraw(); };

  // ---- timer: when the next set is due (kept on the patient record), or how long since the last
  const due = h('div', { class: 'due', role: 'status', 'aria-live': 'off' });
  const drawDue = () => {
    const d = dueAt(p);
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

  const openVitals = () => openVitalsSheet({ base, caseId: id, patientName: name, age, last: cur, onSaved: after });

  const strip = h('div', { class: 'vstrip' }, STRIP.map((s) => tile(s, cur, prev, age)));
  const avpuF = cur ? flagAvpu(cur.avpu) : { level: 'none' };
  const extras = cur ? [cur.avpu && `${label(cur.avpu)}${avpuF.level === 'watch' || avpuF.level === 'alert' ? ' (check)' : ''}`, cur.gcs_e ? gcsText(cur) : null, cur.skin, pupilsText(cur), cur.temp_c != null && tempText(cur.temp_c), cur.glucose != null && `Glucose ${cur.glucose}`, cur.notes].filter(Boolean).join(' · ') : '';
  const queuedVitals = queued.filter((x) => x.path.endsWith('/vitals'));

  const allVitals = p.vitals.length || queuedVitals.length ? h('details', { class: 'more' }, h('summary', null, `All vitals (${vit.length}${p.vitals.length > vit.length ? `, ${p.vitals.length - vit.length} entered in error` : ''}${queuedVitals.length ? `, ${queuedVitals.length} waiting to send` : ''})`),
    h('div', { class: 'table-wrap' }, h('table', { class: 'vtable' }, h('thead', null, h('tr', null, ['Time', 'Pulse', 'Resp', 'BP', 'SpO₂', 'Pain', 'Other', ''].map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', null,
        p.vitals.map((v) => h('tr', { class: v.voided_at ? 'voided' : null },
          h('td', null, fmtTime(v.taken_at), lateTag(v, 'taken_at')), h('td', null, v.pulse ?? ''), h('td', null, v.resp ?? ''), h('td', null, v.bp_sys ? `${v.bp_sys}/${v.bp_dia ?? '?'}` : ''), h('td', null, v.spo2 ?? ''), h('td', null, v.pain ?? ''),
          h('td', null, vitalsWords(v).join(', '), voidedNote(v)),
          h('td', { class: 'actions' }, editable && !v.voided_at ? button('Entered in error', () => voidDialog({ what: `Vitals at ${fmtTime(v.taken_at)}`, path: `${base}/vitals/${v.id}`, onDone: opts.reload }), { small: true, kind: 'quiet' }) : null))),
        queuedVitals.map((x) => h('tr', { class: 'queued' }, h('td', null, atTime(x.body.taken_at)), h('td', null, x.body.pulse ?? ''), h('td', null, x.body.resp ?? ''), h('td', null, x.body.bp_sys ? `${x.body.bp_sys}/${x.body.bp_dia ?? '?'}` : ''), h('td', null, x.body.spo2 ?? ''), h('td', null, x.body.pain ?? ''), h('td', null, queuedTag()), h('td'))))))) : null;

  // ---- assessment tools: each shows whether it has been done
  const tool = (which, text) => {
    const done = sheetDone(def, which, p);
    const b = h('button', { type: 'button', class: `tool${done ? ' done' : ''}`, 'data-tool': which, 'aria-label': `${text}${done ? ', done' : ''}` }, h('span', { class: 'tool-dot', 'aria-hidden': 'true' }), text);
    b.addEventListener('click', () => (which === 'arrest' ? arrestSheet({ def, patient: p, base, caseId: id, onClose: () => opts.reload() }) : assessSheet({ def, which, patient: p, base, caseId: id, onSaved: after })));
    return b;
  };
  const headish = live(p.injuries).some((i) => ['head', 'face', 'neck'].includes(i.body_region) || i.injury_type === 'concussion');
  const medical = c.category === 'medical' || live(p.injuries).some((i) => ['illness', 'cardiac'].includes(i.injury_type));
  const tools = editable ? h('div', { class: 'tools', role: 'group', 'aria-label': 'Assessment' },
    tool('survey', 'Primary survey'), tool('head', headish ? 'Head check (due)' : 'Head check'), tool('spine', 'Spine'), tool('medical', medical ? 'Medical (OPQRST)' : 'Medical'), tool('arrest', 'Cardiac arrest')) : null;

  // ---- injuries
  const injuryRow = (i) => h('li', { class: i.voided_at ? 'voided' : null }, h('span', null, h('span', { class: 'what' }, `${label(i.injury_type)}, ${label(i.body_region)}${i.side && i.side !== 'na' ? ` (${i.side})` : ''}`), i.notes ? h('span', { class: 'muted' }, ` ${i.notes}`) : null, voidedNote(i)),
    editable && !i.voided_at ? button('Entered in error', () => voidDialog({ what: `${label(i.injury_type)}, ${label(i.body_region)}`, path: `${base}/injuries/${i.id}`, onDone: opts.reload }), { small: true, kind: 'quiet' }) : null);
  const queuedInj = queued.filter((x) => x.path.endsWith('/injuries'));
  const injuries = h('div', { class: 'stack tight' }, h('div', { class: 'spread' }, h('h4', null, 'Injuries and findings'), editable ? button('Add injury', () => opts.injuryDialog(base), { small: true }) : null),
    p.injuries.length || queuedInj.length ? h('ul', { class: 'plain log' }, p.injuries.map(injuryRow), queuedInj.map((x) => h('li', { class: 'queued' }, h('span', null, `${label(x.body.injury_type)}, ${label(x.body.body_region)} `, queuedTag())))) : h('p', { class: 'muted' }, 'None recorded.'));

  // ---- treatments
  const quickTap = ([k, text, sheet]) => button(text, async () => {
    if (sheet) { treatmentSheet({ kind: k, base, caseId: id, roster: opts.roster, onSaved: after }); return; }
    const r = await send('POST', `${base}/treatments`, { kind: k, performed_at: nowStamp() }, { caseId: id, label: text });
    sentToast(r, `${text} logged`);
    await after(r);
  }, { small: true });
  const quick = editable ? h('div', { class: 'chip-row quick', role: 'group', 'aria-label': 'Log a treatment now' }, QUICK.map(quickTap),
    button('Medication', () => treatmentSheet({ kind: 'medication', base, caseId: id, roster: opts.roster, onSaved: after }), { small: true }),
    button('Other…', () => opts.treatmentDialog(base), { small: true })) : null;
  const trRow = (tr) => {
    const d = tr.detail || {};
    const needsCms = ['splint', 'spinal_motion_restriction'].includes(tr.kind) && !d.cms_after;
    const det = treatmentDetail(tr);
    return h('li', { class: tr.voided_at ? 'voided' : null, 'data-treatment': tr.id },
      h('span', null, h('b', null, fmtTime(tr.performed_at)), ' ', h('span', { class: 'what' }, `${treatmentName(tr)}${det ? `: ${det}` : ''}`),
        d.effect ? h('span', { class: 'effect' }, ` Effect: ${d.effect}`) : null,
        lateTag(tr, 'performed_at'),
        !tr.voided_at && needsCms ? state('CMS after not recorded', 'warn') : null,
        !tr.voided_at && cmsLost(d.cms_after, d.cms_before) ? state('CMS lost after splinting: loosen and recheck', 'bad') : null,
        voidedNote(tr)),
      h('span', { class: 'row tight' },
        editable && !tr.voided_at && tr.kind === 'medication' && !d.effect ? button('Record effect', () => effectDialog({ base, t: tr, onDone: opts.reload }), { small: true }) : null,
        editable && !tr.voided_at ? button('Entered in error', () => voidDialog({ what: `${treatmentName(tr)} at ${fmtTime(tr.performed_at)}`, path: `${base}/treatments/${tr.id}`, onDone: opts.reload }), { small: true, kind: 'quiet' }) : null));
  };
  const queuedTr = queued.filter((x) => x.path.endsWith('/treatments'));
  const treatments = h('div', { class: 'stack tight' }, h('div', { class: 'spread' }, h('h4', null, 'Treatment log')), quick,
    p.treatments.length || queuedTr.length ? h('ul', { class: 'plain log' }, p.treatments.map(trRow),
      queuedTr.map((x) => h('li', { class: 'queued' }, h('span', null, h('b', null, atTime(x.body.performed_at)), ` ${treatmentName(x.body)} `, queuedTag())))) : h('p', { class: 'muted' }, 'None recorded.'));

  const refused = queued.filter((x) => x.error);
  // The two things done most: take vitals, and hand the patient over. The forms that are needed now and then sit lower down.
  const actions = h('div', { class: 'bed-actions' },
    h('div', { class: 'bed-primary' },
      editable ? h('button', { type: 'button', class: 'btn primary big', 'data-act': 'vitals', onclick: openVitals }, 'Add vitals') : null,
      h('a', { class: 'btn big', href: `#/patrol/handoff/${id}/${p.id}`, 'data-act': 'handoff' }, 'Hand-off')));
  const more = h('div', { class: 'bed-secondary' },
    h('a', { class: 'btn', href: `#/patrol/refusal/${id}/${p.id}`, 'data-act': 'refusal' }, 'Refusal of care'),
    h('a', { class: 'btn', href: `#/patrol/takehome/${id}/${p.id}`, 'data-act': 'takehome' }, 'Take-home sheet'),
    editable && opts.followupDialog ? button(followupWord(p), () => opts.followupDialog(p)) : null,
    editable ? button('Pull from customer record', () => opts.pullDialog(p)) : null);
  const foot = editable ? h('div', { class: 'bed-foot' }, button('Patient entered in error', () => voidDialog({ what: `${name}: the whole patient record, with their vitals, injuries and treatments`, path: base, onDone: opts.reload }), { kind: 'quiet-danger', small: true })) : null;

  return h('article', { class: 'panel stack bedside', 'data-bedside': p.id },
    h('div', { class: 'spread top' },
      h('div', null, h('h3', null, name), h('p', { class: 'muted' }, sub || 'Details not recorded yet')),
      h('div', { class: 'row' }, p.disposition ? state(label(p.disposition), 'neutral') : state('No outcome yet', 'warn'))),
    p.chief_complaint ? h('p', { class: 'complaint' }, h('b', null, 'Complaint: '), p.chief_complaint) : h('p', { class: 'muted' }, 'No chief complaint yet.'),
    h('div', { class: 'row sample' }, sampleChip('Allergies', p.allergies, { danger: true }), sampleChip('Medications', p.medications), sampleChip('History', p.medical_history)),
    refused.length ? h('div', { class: 'outbox-refused', role: 'alert' }, h('b', null, `${refused.length} entr${refused.length === 1 ? 'y' : 'ies'} could not be saved. `), refused.map((x) => `${x.label}: ${x.error}`).join('; ')) : null,
    h('div', { class: 'bed-grid' },
      h('div', { class: 'bed-now stack' },
        h('div', { class: 'vhead spread' }, h('h4', null, cur ? `Vitals at ${fmtTime(cur.taken_at)} (${agoText(minutesSince(String(cur.taken_at)))})` : 'Vitals'), due),
        cur ? strip : h('p', { class: 'muted' }, queuedVitals.length ? 'Vitals are waiting to send.' : 'No vitals recorded yet.'),
        extras ? h('p', { class: 'small muted' }, extras) : null,
        actions, tools, allVitals),
      h('div', { class: 'bed-logs stack' }, injuries, treatments)),
    h('div', { class: 'bed-more stack tight' }, h('h4', null, 'Forms for this patient'), more),
    foot);
}
