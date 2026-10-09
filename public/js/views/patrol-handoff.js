// The hand-off sheet: one printable page that goes with a patient to the next level of care. It follows the order a paramedic
// or emergency nurse wants it in: who, what hurts, what we found and did, the numbers over time, then who took over.

import { get, patch, post } from '../api.js';
import { h, clear, button, toast, formDialog, field, input, val, nowInput, fmtTime, label, errorBox } from '../ui.js';
import { has } from './patrol-feat.js';
import { flag, flagAvpu, vitalsLine } from '../vitals-guide.js';

const UNKNOWN_WORDS = /^(none|no|nkda|nka|n\/a|na|nil|denies)\b/i;
const clean = (v) => (v === null || v === undefined ? '' : String(v).trim());
const KEY_TIMES = ['call_received', 'on_scene', 'patient_contact', 'transport_started', 'at_aid_room', 'handoff'];
const FROM_BASE = { private_car_taxi: 'Private car or taxi', company: 'Company vehicle', ambulance: 'Ambulance', bus: 'Bus', helicopter: 'Helicopter', walk_ski: 'Walk or ski', other: 'Other', unknown: 'Unknown', na: '' };

/** Everything the sheet shows, gathered once so the page and the plain-text copy always say the same thing. */
export function buildHandoff(c, p, nowText = '') {
  const f = p.form || {};
  const lead = c.responders.find((r) => r.role === 'lead');
  const firstEvent = (k) => c.events.find((e) => e.kind === k);
  const treatments = p.treatments;
  const meds = treatments.filter((t) => t.kind === 'medication');
  const transportBits = [f.to_first_aid && f.to_first_aid !== 'na' && `to first aid: ${label(f.to_first_aid)}`, f.from_base && FROM_BASE[f.from_base] && `from base: ${FROM_BASE[f.from_base]}${f.ambulance_code ? ` (${f.ambulance_code})` : ''}`].filter(Boolean);
  return {
    resort: c.resort.legal_name || c.resort.name, caseNumber: c.case_number || `Case ${c.id}`, prepared: nowText,
    incident: { when: c.occurred_at, location: c.location, trail: c.trail, severity: c.severity, summary: c.summary },
    patient: { name: `${clean(p.first_name)} ${clean(p.last_name)}`.trim() || 'Name not known', age: p.age_years, sex: p.sex && p.sex !== 'unknown' ? p.sex : null, weight: clean(f.weight), height: clean(f.height) },
    sample: { allergies: clean(p.allergies), medications: clean(p.medications), history: clean(p.medical_history), lastIntake: clean(p.last_oral_intake) },
    complaint: clean(p.chief_complaint), mechanism: clean(p.mechanism) || clean(f.description), assessment: clean(p.assessment),
    injuries: p.injuries.map((i) => `${label(i.injury_type)}, ${label(i.body_region)}${i.side && i.side !== 'na' ? ` (${i.side})` : ''}${i.notes ? `: ${i.notes}` : ''}`),
    treatments, meds, vitals: p.vitals,
    times: KEY_TIMES.map((k) => [k, firstEvent(k)]).filter(([, e]) => e).map(([k, e]) => [label(k), fmtTime(e.at)]),
    transport: { how: transportBits.join('; '), destination: f.destination_type && f.destination_type !== 'na' ? label(f.destination_type) : '', facility: clean(f.hospital_name), outcome: p.disposition ? label(p.disposition) : '' },
    handoff: { to: clean(f.handoff_to), time: clean(f.handoff_time) },
    lead: lead ? `${lead.first_name} ${lead.last_name}` : '',
  };
}

/** The same sheet as plain text, for a radio report, a message to the hospital or a note. */
export function handoffText(d) {
  const L = [];
  const add = (k, v) => { if (v) L.push(`${k}: ${v}`); };
  L.push(`PATIENT HAND-OFF, ${d.resort}, ${d.caseNumber}${d.prepared ? `, prepared ${d.prepared}` : ''}`);
  add('PATIENT', [d.patient.name, d.patient.age != null && `${d.patient.age} y`, d.patient.sex && label(d.patient.sex), d.patient.weight && `${d.patient.weight}`].filter(Boolean).join(', '));
  add('ALLERGIES', d.sample.allergies || 'not recorded'); add('MEDICATIONS', d.sample.medications); add('HISTORY', d.sample.history); add('LAST ATE OR DRANK', d.sample.lastIntake);
  add('COMPLAINT', d.complaint); add('HOW IT HAPPENED', d.mechanism); add('INJURIES', d.injuries.join('; ')); add('ASSESSMENT', d.assessment);
  add('TREATMENT', d.treatments.map((t) => `${fmtTime(t.performed_at)} ${label(t.kind)}${t.medication ? ` ${t.medication} ${t.dose}${t.route ? ` ${t.route}` : ''}` : ''}${t.description ? ` (${t.description})` : ''}`).join('; '));
  add('VITALS', d.vitals.map((v) => `${fmtTime(v.taken_at)} ${vitalsLine(v)}`).join(' | '));
  add('KEY TIMES', d.times.map(([k, t]) => `${k} ${t}`).join(', '));
  add('TRANSPORT', [d.transport.how, d.transport.destination && `destination ${d.transport.destination}`, d.transport.facility].filter(Boolean).join('; '));
  add('HANDED TO', [d.handoff.to, d.handoff.time && `at ${d.handoff.time}`].filter(Boolean).join(' '));
  add('PATROL LEAD', d.lead);
  return L.join('\n');
}

const cell = (k, v, age) => { const fl = flag(k, v, age); return h('td', { 'data-level': fl.level }, v == null ? '' : String(v), fl.word && (fl.level === 'alert' || fl.level === 'watch') ? h('span', { class: 'fw' }, ` ${fl.word}`) : null); };

export async function renderHandoff(root, id, pid) {
  const page = h('div', { class: 'stack' });
  root.append(page);
  async function load() {
    let c;
    try { c = await get(`/patrol/incidents/${id}`); } catch (err) { clear(page).append(h('p', null, h('a', { href: `#/patrol/case/${id}` }, 'Back to the case')), errorBox(err)); return; }
    const p = c.patients.find((x) => x.id === Number(pid));
    if (!p) { clear(page).append(h('p', null, h('a', { href: `#/patrol/case/${id}` }, 'Back to the case')), errorBox(new Error('Patient not found on this case'))); return; }
    clear(page).append(sheet(c, p));
  }

  const logPrint = () => post(`/patrol/incidents/${id}/patients/${pid}/handoff-printed`, {}).catch(() => {});

  function sheet(c, p) {
    const editable = c.report_state === 'draft' || (c.report_state === 'submitted' && has('approve_case'));
    const now = nowInput();
    const d = buildHandoff(c, p, `${fmtTime(`${now.slice(0, 10)} ${now.slice(11)}:00`)}`);
    const age = p.age_years;
    const section = (title, ...kids) => h('section', { class: 'hs' }, h('h3', null, title), ...kids);
    const none = (t) => h('p', { class: 'muted' }, t);
    const sampleVal = (v, danger) => (v ? h('b', { class: danger && !UNKNOWN_WORDS.test(v) ? 'danger-text' : null }, v) : h('span', { class: 'muted' }, 'Not recorded'));

    const tools = h('div', { class: 'handoff-tools row' },
      h('a', { class: 'btn', href: `#/patrol/case/${id}` }, 'Back to the case'),
      button('Print', async () => { await logPrint(); window.print(); }, { kind: 'primary' }),
      button('Copy as text', async () => {
        const text = handoffText(d);
        try { await navigator.clipboard.writeText(text); } catch (_) { const ta = h('textarea', null, text); document.body.append(ta); ta.select(); try { document.execCommand('copy'); } catch (__) { /* shown below instead */ } ta.remove(); }
        await logPrint();
        toast('Copied. Paste it into a message or radio note.');
      }),
      editable ? button('Record hand-off', () => handoffDialog(c, p)) : null);

    const vitals = p.vitals.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'vtable' }, h('thead', null, h('tr', null, ['Time', 'Pulse', 'Resp', 'BP', 'SpO₂', 'GCS', 'Pain', 'Alert?', 'Other'].map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', null, p.vitals.map((v) => {
        const af = flagAvpu(v.avpu);
        return h('tr', null, h('td', null, fmtTime(v.taken_at)), cell('pulse', v.pulse, age), cell('resp', v.resp, age),
          h('td', { 'data-level': flag('bp_sys', v.bp_sys, age).level }, v.bp_sys ? `${v.bp_sys}/${v.bp_dia ?? '?'}` : ''), cell('spo2', v.spo2, age), cell('gcs', v.gcs, age), cell('pain', v.pain, age),
          h('td', { 'data-level': af.level }, v.avpu ? label(v.avpu) : ''), h('td', null, [v.pupils && `Pupils ${v.pupils}`, v.skin, v.temp_c != null && `${v.temp_c}°C`, v.glucose != null && `Glucose ${v.glucose}`, v.notes].filter(Boolean).join(', ')));
      })))) : none('No vitals recorded.');

    const lines = (arr, f) => (arr.length ? h('ul', { class: 'plain' }, arr.map((x) => h('li', null, f ? f(x) : x))) : null);
    const meds = d.meds.length ? h('div', { class: 'medbox' }, h('b', null, 'Medication given: '), d.meds.map((t) => `${fmtTime(t.performed_at)} ${t.medication} ${t.dose}${t.route ? ` ${t.route}` : ''}`).join('; ')) : h('div', { class: 'medbox none' }, h('b', null, 'Medication given: '), 'none recorded');

    return h('article', { class: 'handoff', 'data-handoff': p.id },
      tools,
      h('header', { class: 'hs-head' },
        h('div', null, h('p', { class: 'eyebrow' }, 'Patient hand-off'), h('h1', null, d.patient.name),
          h('p', null, [d.patient.age != null && `${d.patient.age} years`, d.patient.sex && label(d.patient.sex), d.patient.weight && `${d.patient.weight}`, d.patient.height && `${d.patient.height}`].filter(Boolean).join(', ') || 'Age not recorded')),
        h('div', { class: 'hs-meta' }, h('b', null, d.resort), h('span', null, d.caseNumber), h('span', null, `Incident ${fmtTime(c.occurred_at)}`, ` · ${label(c.severity)}`), h('span', { class: 'muted' }, `Prepared ${d.prepared}`))),
      h('div', { class: 'hs-alert' },
        h('div', null, h('span', { class: 'k' }, 'Allergies'), sampleVal(d.sample.allergies, true)),
        h('div', null, h('span', { class: 'k' }, 'Medications'), sampleVal(d.sample.medications)),
        h('div', null, h('span', { class: 'k' }, 'History'), sampleVal(d.sample.history)),
        h('div', null, h('span', { class: 'k' }, 'Last ate or drank'), sampleVal(d.sample.lastIntake))),
      section('Vitals over time', vitals),
      h('div', { class: 'hs-grid' },
        h('div', { class: 'stack' },
          section('What happened', h('p', null, h('b', null, 'Complaint: '), d.complaint || 'Not recorded'), d.mechanism ? h('p', null, h('b', null, 'How: '), d.mechanism) : null, h('p', { class: 'muted' }, d.incident.trail && !String(d.incident.location).toLowerCase().includes(String(d.incident.trail).toLowerCase()) ? `${d.incident.location} (${d.incident.trail})` : d.incident.location)),
          section('Injuries and findings', lines(d.injuries) || none('None recorded.'), d.assessment ? h('p', { class: 'prewrap' }, h('b', null, 'Assessment: '), d.assessment) : null),
          section('Treatment given', meds, d.treatments.length ? h('ul', { class: 'plain' }, d.treatments.map((t) => h('li', null, h('b', null, fmtTime(t.performed_at)), ` ${label(t.kind)}${t.medication ? `: ${t.medication} ${t.dose}${t.route ? `, ${t.route}` : ''}` : ''}`, t.description ? h('span', { class: 'muted' }, ` ${t.description}`) : null))) : none('No treatment recorded.'))),
        h('div', { class: 'stack' },
          section('Key times', d.times.length ? h('ul', { class: 'plain times' }, d.times.map(([k, t]) => h('li', null, h('span', null, k), h('b', null, t)))) : none('No times stamped.')),
          section('Transport', h('p', null, d.transport.how || 'Not recorded'), d.transport.destination || d.transport.facility ? h('p', null, h('b', null, 'Going to: '), [d.transport.destination, d.transport.facility].filter(Boolean).join(', ')) : null, d.transport.outcome ? h('p', { class: 'muted' }, `Outcome: ${d.transport.outcome}`) : null))),
      h('div', { class: 'hs-sign' },
        h('div', null, h('span', { class: 'k' }, 'Care handed to'), h('div', { class: 'line' }, d.handoff.to)),
        h('div', null, h('span', { class: 'k' }, 'Time'), h('div', { class: 'line' }, d.handoff.time)),
        h('div', null, h('span', { class: 'k' }, `Given by (patrol${d.lead ? `, lead ${d.lead}` : ''})`), h('div', { class: 'line' })),
        h('div', null, h('span', { class: 'k' }, 'Received by (signature)'), h('div', { class: 'line' }))),
      h('p', { class: 'hs-foot muted small' }, 'Confidential patient information. Printed and copied sheets are logged. Give it to the receiving provider and do not leave it unattended.'));
  }

  function handoffDialog(c, p) {
    const t = nowInput().slice(11);
    formDialog('Record the hand-off', h('div', { class: 'form' },
      h('div', { class: 'wide' }, field('Care handed to (name and unit)', input({ name: 'handoff_to', required: true, maxlength: 255, placeholder: 'Medic 12, J. Alvarez, paramedic' }))),
      field('Time', input({ type: 'time', name: 'handoff_time', value: t, required: true })),
      h('p', { class: 'wide muted small' }, 'This saves who took over, adds a Handoff time to the timeline and updates the hand-off sheet.')),
    async (fd) => {
      const to = val(fd, 'handoff_to'); const time = val(fd, 'handoff_time');
      await patch(`/patrol/incidents/${id}/patients/${p.id}`, { form: { handoff_to: to, handoff_time: time } });
      await post(`/patrol/incidents/${id}/events`, { kind: 'handoff', note: `Care handed to ${to}` });
      toast('Hand-off recorded');
      await load();
    }, { submitText: 'Record hand-off' });
  }

  await load();
}
