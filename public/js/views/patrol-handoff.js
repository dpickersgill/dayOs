// The hand-off sheet: one printable page that goes with a patient to the next level of care. Anything time-critical comes
// first (a tourniquet time, a stroke's last known well, a cardiac arrest), then the MIST order a paramedic or emergency
// nurse reports in: mechanism, injuries, signs (the vitals over time and the assessment), treatment, then SAMPLE history.

import { get, patch, post } from '../api.js';
import { h, clear, button, toast, formDialog, field, input, val, nowInput, fmtTime, label, errorBox } from '../ui.js';
import { has } from './patrol-feat.js';
import { flag, flagAvpu, vitalsLine } from '../vitals-guide.js';
import { signaturePad } from '../sigpad.js';
import { live, treatmentLine, measureText, vitalsWords, LIMB } from '../care-text.js';

const UNKNOWN_WORDS = /^(none|no|nkda|nka|n\/a|na|nil|denies)\b/i;
const clean = (v) => (v === null || v === undefined ? '' : String(v).trim());
const KEY_TIMES = ['call_received', 'on_scene', 'patient_contact', 'transport_started', 'at_aid_room', 'handoff'];
const FROM_BASE = { private_car_taxi: 'Private car or taxi', company: 'Company vehicle', ambulance: 'Ambulance', bus: 'Bus', helicopter: 'Helicopter', walk_ski: 'Walk or ski', other: 'Other', unknown: 'Unknown', na: '' };

/** Everything the sheet shows, gathered once so the page and the plain-text copy always say the same thing. */
export function buildHandoff(c, p, nowText = '') {
  const f = p.form || {};
  const lead = c.responders.find((r) => r.role === 'lead' && !r.voided_at);
  const firstEvent = (k) => live(c.events).find((e) => e.kind === k);
  const treatments = live(p.treatments);
  const meds = treatments.filter((t) => t.kind === 'medication');
  const transportBits = [f.to_first_aid && f.to_first_aid !== 'na' && `to first aid: ${label(f.to_first_aid)}`, f.from_base && FROM_BASE[f.from_base] && `from base: ${FROM_BASE[f.from_base]}${f.ambulance_code ? ` (${f.ambulance_code})` : ''}`].filter(Boolean);
  return {
    resort: c.resort.legal_name || c.resort.name, caseNumber: c.case_number || `Case ${c.id}`, prepared: nowText,
    incident: { when: c.occurred_at, location: c.location, trail: c.trail, severity: c.severity, summary: c.summary },
    patient: { name: `${clean(p.first_name)} ${clean(p.last_name)}`.trim() || 'Name not known', age: p.age_years, sex: p.sex && p.sex !== 'unknown' ? p.sex : null, weight: measureText(f.weight), height: measureText(f.height) },
    sample: { allergies: clean(p.allergies), medications: clean(p.medications), history: clean(p.medical_history), lastIntake: clean(p.last_oral_intake) },
    complaint: clean(p.chief_complaint), mechanism: clean(p.mechanism) || clean(f.description), assessment: clean(p.assessment),
    injuries: live(p.injuries).map((i) => `${label(i.injury_type)}, ${label(i.body_region)}${i.side && i.side !== 'na' ? ` (${i.side})` : ''}${i.notes ? `: ${i.notes}` : ''}`),
    treatments, meds, vitals: live(p.vitals),
    head: headLine(f), stroke: strokeLine(f), spine: spineLine(f), survey: surveyLine(f),
    drugs: clean(f.drugs_alcohol) && !UNKNOWN_WORDS.test(clean(f.drugs_alcohol)) ? clean(f.drugs_alcohol) : '',
    tourniquets: treatments.filter((t) => t.kind === 'tourniquet').map((t) => `${LIMB[(t.detail || {}).limb] || 'limb'} at ${fmtTime(t.performed_at)}`),
    arrest: f.arrest_time_down ? `Collapsed about ${f.arrest_time_down}${f.arrest_witnessed ? ` (${f.arrest_witnessed})` : ''}${f.arrest_bystander_cpr === 'yes' ? ', bystander CPR' : ''}` : '',
    receiver: [...c.signatures].reverse().find((x) => x.kind === 'receiving_provider' && x.patient_id === p.id) || null,
    times: KEY_TIMES.map((k) => [k, firstEvent(k)]).filter(([, e]) => e).map(([k, e]) => [label(k), fmtTime(e.at)]),
    transport: { how: transportBits.join('; '), destination: f.destination_type && f.destination_type !== 'na' ? label(f.destination_type) : '', facility: clean(f.hospital_name), outcome: p.disposition ? label(p.disposition) : '' },
    handoff: { to: clean(f.handoff_to), time: clean(f.handoff_time) },
    lead: lead ? `${lead.first_name} ${lead.last_name}` : '',
  };
}

/** Stroke check in one line, with last known well first: it decides what the stroke team can do. */
function strokeLine(f) {
  const abn = [f.stroke_face === 'droop' && 'face droop', f.stroke_arm === 'drift' && 'arm drift', f.stroke_speech === 'abnormal' && 'speech abnormal'].filter(Boolean);
  const normal = [f.stroke_face, f.stroke_arm, f.stroke_speech].some((x) => x === 'normal');
  if (!f.stroke_last_well && !abn.length && !normal) return '';
  return [f.stroke_last_well && `LAST KNOWN WELL ${f.stroke_last_well}`, abn.length ? abn.join(', ') : 'face, arms and speech normal'].filter(Boolean).join('; ');
}
const SPINE_DECISION = { smr: 'spinal motion restriction applied', not_indicated: 'SMR not indicated by the criteria', declined: 'patient declined SMR' };
/** Spine: the decision and the answers that led to it. */
function spineLine(f) {
  const yes = [f.spine_mechanism === 'yes' && 'dangerous mechanism', f.spine_midline === 'yes' && 'midline tenderness', f.spine_neuro === 'yes' && 'numbness, tingling or weakness', f.spine_alert === 'no' && 'not alert or reliable', f.spine_intox === 'yes' && 'alcohol or drugs', f.spine_distracting === 'yes' && 'distracting injury'].filter(Boolean);
  if (!f.spine_decision && !yes.length) return '';
  return [SPINE_DECISION[f.spine_decision], yes.length && `findings: ${yes.join(', ')}`].filter(Boolean).join('; ');
}
const PS = { ps_bleeding: 'bleeding', ps_airway: 'airway', ps_breathing: 'breathing', ps_circulation: 'circulation', ps_disability: 'responsiveness' };
/** The primary survey in one line. */
function surveyLine(f) {
  const bits = Object.entries(PS).filter(([k]) => f[k]).map(([k, w]) => `${w} ${label(f[k]).toLowerCase()}`);
  return bits.length ? `${f.ps_time ? `${f.ps_time}: ` : ''}${bits.join(', ')}` : '';
}

/** Head injury answers in one line, for the people who will watch for a change. */
function headLine(f) {
  const bits = [];
  if (f.head_loc) bits.push(f.head_loc === 'yes' ? `LOC yes${f.head_loc_minutes ? ` ~${f.head_loc_minutes} min` : ''}` : `LOC ${f.head_loc}`);
  if (f.head_amnesia_before === 'yes' || f.head_amnesia_after === 'yes') bits.push(`amnesia ${[f.head_amnesia_before === 'yes' && 'before', f.head_amnesia_after === 'yes' && 'after'].filter(Boolean).join(' and ')}`);
  if (f.head_repeating === 'yes') bits.push('repeating questions');
  if (f.head_vomiting === 'yes') bits.push(`vomiting${f.head_vomit_count ? ` x${f.head_vomit_count}` : ''}`);
  if (f.head_seizure === 'yes') bits.push('seizure');
  if (f.head_helmet_damage === 'yes') bits.push('helmet damaged');
  return bits.join(', ');
}

/** The same sheet as plain text, for a radio report, a message to the hospital or a note. */
export function handoffText(d) {
  const L = [];
  const add = (k, v) => { if (v) L.push(`${k}: ${v}`); };
  L.push(`PATIENT HAND-OFF, ${d.resort}, ${d.caseNumber}${d.prepared ? `, prepared ${d.prepared}` : ''}`);
  add('PATIENT', [d.patient.name, d.patient.age != null && `${d.patient.age} y`, d.patient.sex && label(d.patient.sex), d.patient.weight && `${d.patient.weight}`].filter(Boolean).join(', '));
  add('ALLERGIES', d.sample.allergies || 'not recorded');
  add('TOURNIQUET', d.tourniquets.join('; ')); add('STROKE', d.stroke); add('CARDIAC ARREST', d.arrest);
  add('COMPLAINT', d.complaint); add('MECHANISM', d.mechanism); add('INJURIES', d.injuries.join('; '));
  add('VITALS', d.vitals.map((v) => `${fmtTime(v.taken_at)} ${vitalsLine(v)}`).join(' | '));
  add('PRIMARY SURVEY', d.survey); add('HEAD INJURY', d.head); add('SPINE', d.spine); add('ASSESSMENT', d.assessment); add('DRUGS OR ALCOHOL', d.drugs);
  add('TREATMENT', d.treatments.map(treatmentLine).join('; '));
  add('MEDICATIONS', d.sample.medications); add('HISTORY', d.sample.history); add('LAST ATE OR DRANK', d.sample.lastIntake);
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
    if (p.voided_at) { clear(page).append(h('p', null, h('a', { href: `#/patrol/case/${id}` }, 'Back to the case')), h('p', { class: 'refusal-block' }, `This patient was marked entered in error: ${p.void_reason}. There is no hand-off sheet for them.`)); return; }
    const recv = [...c.signatures].reverse().find((x) => x.kind === 'receiving_provider' && x.patient_id === p.id);
    let recvImg = null;
    if (recv) { try { recvImg = (await get(`/patrol/incidents/${id}/signatures/${recv.id}`)).image; } catch (_) { recvImg = null; } }
    clear(page).append(sheet(c, p, recvImg));
  }

  const logPrint = () => post(`/patrol/incidents/${id}/patients/${pid}/handoff-printed`, {}).catch(() => {});

  function sheet(c, p, recvImg) {
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

    const vitals = d.vitals.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'vtable' }, h('thead', null, h('tr', null, ['Time', 'Pulse', 'Resp', 'BP', 'SpO₂', 'GCS', 'Pain', 'Alert?', 'Other'].map((x) => h('th', { scope: 'col' }, x)))),
      h('tbody', null, d.vitals.map((v) => {
        const af = flagAvpu(v.avpu);
        return h('tr', null, h('td', null, fmtTime(v.taken_at)), cell('pulse', v.pulse, age), cell('resp', v.resp, age),
          h('td', { 'data-level': flag('bp_sys', v.bp_sys, age).level }, v.bp_sys ? `${v.bp_sys}/${v.bp_dia ?? '?'}` : ''), cell('spo2', v.spo2, age), h('td', { 'data-level': flag('gcs', v.gcs).level }, v.gcs == null ? '' : v.gcs_e ? `${v.gcs} (E${v.gcs_e}V${v.gcs_v}M${v.gcs_m})` : String(v.gcs)), cell('pain', v.pain, age),
          h('td', { 'data-level': af.level }, v.avpu ? label(v.avpu) : ''), h('td', null, vitalsWords(v).filter((x) => !/^GCS|^(Alert|Verbal|Pain|Unresponsive)$/.test(x)).join(', ')));
      })))) : none('No vitals recorded.');

    const lines = (arr, f) => (arr.length ? h('ul', { class: 'plain' }, arr.map((x) => h('li', null, f ? f(x) : x))) : null);
    const meds = d.meds.length ? h('div', { class: 'medbox' }, h('b', null, 'Medication given: '), d.meds.map((t) => `${fmtTime(t.performed_at)} ${t.medication} ${t.dose}${t.route ? ` ${t.route}` : ''}${t.detail && t.detail.effect ? ` (effect: ${t.detail.effect})` : ''}`).join('; ')) : h('div', { class: 'medbox none' }, h('b', null, 'Medication given: '), 'none recorded');

    return h('article', { class: 'handoff', 'data-handoff': p.id },
      tools,
      h('header', { class: 'hs-head' },
        h('div', null, h('p', { class: 'eyebrow' }, 'Patient hand-off'), h('h1', null, d.patient.name),
          h('p', null, [d.patient.age != null && `${d.patient.age} years`, d.patient.sex && label(d.patient.sex), d.patient.weight && `${d.patient.weight}`, d.patient.height && `${d.patient.height}`].filter(Boolean).join(', ') || 'Age not recorded')),
        h('div', { class: 'hs-meta' }, h('b', null, d.resort), h('span', null, d.caseNumber), h('span', null, `Incident ${fmtTime(c.occurred_at)}`, ` · ${label(c.severity)}`), h('span', { class: 'muted' }, `Prepared ${d.prepared}`))),
      d.tourniquets.length || d.stroke || d.arrest ? h('div', { class: 'hs-critical', role: 'alert' },
        d.tourniquets.length ? h('p', null, h('b', null, 'Tourniquet: '), d.tourniquets.join('; ')) : null,
        d.stroke ? h('p', null, h('b', null, 'Stroke: '), d.stroke) : null,
        d.arrest ? h('p', null, h('b', null, 'Cardiac arrest: '), d.arrest) : null) : null,
      h('p', { class: 'hs-allergy' }, h('span', { class: 'k' }, 'Allergies '), sampleVal(d.sample.allergies, true)),
      h('div', { class: 'hs-grid' },
        h('div', { class: 'stack' },
          section('What happened', h('p', null, h('b', null, 'Complaint: '), d.complaint || 'Not recorded'), d.mechanism ? h('p', null, h('b', null, 'How: '), d.mechanism) : null, h('p', { class: 'muted' }, d.incident.trail && !String(d.incident.location).toLowerCase().includes(String(d.incident.trail).toLowerCase()) ? `${d.incident.location} (${d.incident.trail})` : d.incident.location)),
          section('Injuries and findings', lines(d.injuries) || none('None recorded.'),  d.assessment ? h('p', { class: 'prewrap' }, h('b', null, 'Assessment: '), d.assessment) : null)),
        h('div', { class: 'stack' },
          section('Signs and assessment', d.survey ? h('p', null, h('b', null, 'Primary survey: '), d.survey) : null, d.head ? h('p', null, h('b', null, 'Head injury: '), d.head) : null,
            d.spine ? h('p', null, h('b', null, 'Spine: '), d.spine) : null, d.drugs ? h('p', null, h('b', null, 'Drugs or alcohol: '), d.drugs) : null,
            !d.survey && !d.head && !d.spine && !d.drugs ? none('No assessment answers recorded.') : null))),
      section('Vitals over time', vitals),
      h('div', { class: 'hs-grid' },
        h('div', { class: 'stack' },
          section('Treatment given', meds,  d.treatments.length ? h('ul', { class: 'plain' }, d.treatments.map((t) => h('li', null, treatmentLine(t)))) : none('No treatment recorded.')),
          section('SAMPLE history', h('div', { class: 'hs-alert' },
            h('div', null, h('span', { class: 'k' }, 'Allergies'), sampleVal(d.sample.allergies, true)),
            h('div', null, h('span', { class: 'k' }, 'Medications'), sampleVal(d.sample.medications)),
            h('div', null, h('span', { class: 'k' }, 'History'), sampleVal(d.sample.history)),
            h('div', null, h('span', { class: 'k' }, 'Last ate or drank'), sampleVal(d.sample.lastIntake))))),
        h('div', { class: 'stack' },
          section('Key times', d.times.length ? h('ul', { class: 'plain times' }, d.times.map(([k, t]) => h('li', null, h('span', null, k), h('b', null, t)))) : none('No times stamped.')),
          section('Transport', h('p', null, d.transport.how || 'Not recorded'), d.transport.destination || d.transport.facility ? h('p', null, h('b', null, 'Going to: '), [d.transport.destination, d.transport.facility].filter(Boolean).join(', ')) : null, d.transport.outcome ? h('p', { class: 'muted' }, `Outcome: ${d.transport.outcome}`) : null))),
      h('div', { class: 'hs-sign' },
        h('div', null, h('span', { class: 'k' }, 'Care handed to'), h('div', { class: 'line' }, d.handoff.to)),
        h('div', null, h('span', { class: 'k' }, 'Time'), h('div', { class: 'line' }, d.handoff.time)),
        h('div', null, h('span', { class: 'k' }, `Given by (patrol${d.lead ? `, lead ${d.lead}` : ''})`), h('div', { class: 'line' })),
        h('div', null, h('span', { class: 'k' }, 'Received by (signature)'), h('div', { class: 'line sigbox' }, recvImg ? h('img', { class: 'sig-img', src: recvImg, alt: `Signature of ${d.receiver.signer_name}` }) : null), d.receiver ? h('span', { class: 'muted small' }, `${d.receiver.signer_name}${d.receiver.signer_role ? `, ${d.receiver.signer_role}` : ''}, ${fmtTime(d.receiver.signed_at)}`) : null)),
      h('p', { class: 'hs-foot muted small' }, 'Confidential patient information. Printed and copied sheets are logged. Give it to the receiving provider and do not leave it unattended.'));
  }

  /** Who took over, when, and their signature on this phone. */
  function handoffDialog(c, p) {
    const t = nowInput().slice(11);
    const pad = signaturePad();
    const clearBtn = h('button', { type: 'button', class: 'btn small' }, 'Clear');
    clearBtn.addEventListener('click', () => pad.clear());
    formDialog('Record the hand-off', h('div', { class: 'stack' },
      h('div', { class: 'form' },
        field('Receiving provider name', input({ name: 'signer_name', maxlength: 150, placeholder: 'J. Alvarez' })),
        field('Role and unit', input({ name: 'signer_role', maxlength: 150, placeholder: 'Paramedic, Medic 12' })),
        h('div', { class: 'wide' }, field('Care handed to (name and unit)', input({ name: 'handoff_to', maxlength: 255, placeholder: 'Medic 12, J. Alvarez, paramedic' }), 'Filled in from the two boxes above if you leave it blank')),
        field('Time', input({ type: 'time', name: 'handoff_time', value: t, required: true }))),
      h('div', { class: 'field' }, h('span', null, 'Receiving provider signs here'), pad.el), h('div', { class: 'row' }, clearBtn),
      h('p', { class: 'muted small' }, 'Hand the phone to the paramedic, nurse or doctor taking over. Their signature shows they received the patient and this sheet. It saves who took over, adds a Handoff time to the timeline and updates the sheet.')),
    async (fd) => {
      const name = val(fd, 'signer_name'); const role = val(fd, 'signer_role');
      const to = val(fd, 'handoff_to') || [role, name].filter(Boolean).join(', ');
      const time = val(fd, 'handoff_time');
      if (!to) throw new Error('Say who took over care');
      if (!pad.isEmpty() && !name) throw new Error('Print the name of the person signing');
      await patch(`/patrol/incidents/${id}/patients/${p.id}`, { form: { handoff_to: to, handoff_time: time } });
      // A time later than now (say 23:55 recorded at 00:05) was yesterday.
      const today = nowInput().slice(0, 10);
      const day = time > nowInput().slice(11) ? (() => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })() : today;
      await post(`/patrol/incidents/${id}/events`, { kind: 'handoff', at: `${day}T${time}`, patient_id: p.id, note: `Care of ${p.first_name} ${p.last_name} handed to ${to}`.replace(/\s+/g, ' ') });
      if (!pad.isEmpty()) await post(`/patrol/incidents/${id}/signatures`, { kind: 'receiving_provider', signer_name: name, signer_role: role || undefined, patient_id: p.id, image: pad.toDataUrl() });
      toast('Hand-off recorded');
      await load();
    }, { submitText: 'Record hand-off', wide: true });
  }

  await load();
}
