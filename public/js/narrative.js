// A first draft of the narrative, written from what was logged at the bedside. Two common layouts:
//   CHART: Chief complaint, History, Assessment, Rx (treatment), Transport
//   SOAP:  Subjective, Objective, Assessment, Plan
// The draft only says what the record says. It is put in the narrative box for the patroller to read, correct and save;
// nothing is saved until they do.

import { fmtTime, label } from './ui.js';
import { live, treatmentLine, gcsText, pupilsText, tempText, measureText } from './care-text.js';
import { vitalsLine } from './vitals-guide.js';

const sentence = (s) => { const t = String(s || '').trim(); if (!t) return ''; return /[.!?]$/.test(t) ? t : `${t}.`; };
const has = (v) => v !== null && v !== undefined && String(v).trim() !== '';
const none = (v) => /^(none|no|nkda|nka|n\/a|na|nil|denies)\b/i.test(String(v || '').trim());

const PS = {
  ps_bleeding: { none: 'no major bleeding', controlled: 'major bleeding, controlled', uncontrolled: 'major bleeding, not controlled' },
  ps_airway: { clear: 'airway clear', managed: 'airway opened or managed', obstructed: 'airway obstructed' },
  ps_breathing: { adequate: 'breathing adequate', laboured: 'breathing laboured', inadequate: 'breathing inadequate or absent' },
  ps_circulation: { normal: 'pulse present, skin normal', poor: 'weak pulse or poor perfusion', absent: 'no pulse' },
  ps_disability: { alert: 'alert', verbal: 'responds to voice', pain: 'responds to pain', unresponsive: 'unresponsive' },
};

function who(p) {
  const f = p.form || {};
  return [p.age_years != null && `${p.age_years}-year-old`, p.sex && p.sex !== 'unknown' ? p.sex : null, f.activity ? label(f.activity).toLowerCase() : null].filter(Boolean).join(' ') || 'patient';
}
const timeOf = (c, kind) => { const e = live(c.events).find((x) => x.kind === kind); return e ? fmtTime(e.at) : null; };

function history(p) {
  const f = p.form || {};
  const out = [];
  if (has(f.description)) out.push(`Patient states: "${String(f.description).trim()}"`);
  else if (has(p.mechanism)) out.push(sentence(p.mechanism));
  const o = [['Onset', f.opqrst_onset], ['Provokes', f.opqrst_provokes], ['Quality', f.opqrst_quality], ['Region and radiation', f.opqrst_region], ['Severity', f.opqrst_severity != null && f.opqrst_severity !== '' ? `${f.opqrst_severity}/10` : null], ['Time', f.opqrst_time]].filter(([, v]) => has(v));
  if (o.length) out.push(`${o.map(([k, v]) => `${k}: ${v}`).join('. ')}.`);
  const sample = [['Allergies', p.allergies], ['medications', p.medications], ['history', p.medical_history], ['last oral intake', p.last_oral_intake]].filter(([, v]) => has(v)).map(([k, v]) => `${k} ${none(v) ? 'none' : v}`);
  if (sample.length) out.push(sentence(sample.join(', ').replace(/^./, (x) => x.toUpperCase())));
  if (has(f.drugs_alcohol) && !none(f.drugs_alcohol)) out.push(sentence(`Drugs or alcohol: ${f.drugs_alcohol}`));
  return out;
}

function findings(c, p) {
  const f = p.form || {};
  const out = [];
  const ps = Object.keys(PS).filter((k) => f[k]).map((k) => PS[k][f[k]]);
  if (ps.length) out.push(sentence(`Primary survey${f.ps_time ? ` at ${f.ps_time}` : ''}: ${ps.join(', ')}`));
  const vit = live(p.vitals);
  if (vit.length) {
    const first = vit[0]; const last = vit[vit.length - 1];
    out.push(sentence(`Vitals at ${fmtTime(first.taken_at)}: ${vitalsLine(first)}`));
    if (vit.length > 1) out.push(sentence(`Last set at ${fmtTime(last.taken_at)} (${vit.length} sets): ${vitalsLine(last)}`));
    const extra = [first.gcs_e ? gcsText(first) : null, pupilsText(last), last.temp_c != null ? `temperature ${tempText(last.temp_c)}` : null].filter(Boolean);
    if (extra.length && extra.join('') !== '') out.push(sentence(extra.join(', ')));
  }
  const head = [];
  if (f.head_loc) head.push(f.head_loc === 'yes' ? `lost consciousness${f.head_loc_minutes ? ` for about ${f.head_loc_minutes} min` : ''}` : f.head_loc === 'no' ? 'no loss of consciousness' : 'loss of consciousness unknown');
  if (f.head_amnesia_before === 'yes' || f.head_amnesia_after === 'yes') head.push(`memory loss ${[f.head_amnesia_before === 'yes' && 'before', f.head_amnesia_after === 'yes' && 'after'].filter(Boolean).join(' and ')} the injury`);
  if (f.head_repeating === 'yes') head.push('repeating questions');
  if (f.head_vomiting === 'yes') head.push(`vomited${f.head_vomit_count ? ` ${f.head_vomit_count} times` : ''}`);
  if (f.head_headache === 'yes') head.push('headache');
  if (f.head_seizure === 'yes') head.push('seizure');
  if (f.head_helmet_damage === 'yes') head.push('helmet damaged');
  if (head.length) out.push(sentence(`Head injury: ${head.join(', ')}`));
  const stroke = [f.stroke_face === 'droop' && 'facial droop', f.stroke_arm === 'drift' && 'arm drift', f.stroke_speech === 'abnormal' && 'abnormal speech'].filter(Boolean);
  if (f.stroke_face || f.stroke_arm || f.stroke_speech) out.push(sentence(stroke.length ? `Stroke check positive: ${stroke.join(', ')}${f.stroke_last_well ? `; last known well ${f.stroke_last_well}` : ''}` : 'Stroke check negative (face, arms, speech normal)'));
  const spine = [['dangerous mechanism', f.spine_mechanism], ['midline tenderness', f.spine_midline], ['numbness, tingling or weakness', f.spine_neuro], ['alcohol or drugs', f.spine_intox], ['distracting injury', f.spine_distracting]].filter(([, v]) => v);
  if (spine.length || f.spine_alert) out.push(sentence(`Spine: ${[...spine.map(([k, v]) => `${v === 'yes' ? '' : 'no '}${k}`), f.spine_alert ? (f.spine_alert === 'yes' ? 'alert and reliable' : 'not alert or reliable') : null].filter(Boolean).join(', ')}`));
  const inj = live(p.injuries).map((i) => `${label(i.injury_type).toLowerCase()}, ${label(i.body_region).toLowerCase()}${i.side && i.side !== 'na' ? ` (${i.side})` : ''}${i.notes ? `: ${i.notes}` : ''}`);
  if (inj.length) out.push(sentence(`Findings: ${inj.join('; ')}`));
  if (has(p.assessment)) out.push(sentence(p.assessment));
  if (f.weight) out.push(sentence(`Weight ${measureText(f.weight)}`));
  return out;
}

function care(p) {
  const f = p.form || {};
  const out = live(p.treatments).map((t) => sentence(treatmentLine(t)));
  if (f.arrest_time_down) {
    const kind = { witnessed: 'witnessed collapse', unwitnessed: 'unwitnessed collapse' }[f.arrest_witnessed] || 'collapse';
    out.unshift(sentence(`Cardiac arrest: ${kind} at about ${f.arrest_time_down}${f.arrest_bystander_cpr === 'yes' ? ', bystander CPR before patrol arrived' : ''}`));
  }
  return out;
}

function transport(c, p) {
  const f = p.form || {};
  const out = [];
  const how = [f.to_first_aid && f.to_first_aid !== 'na' && `to first aid by ${label(f.to_first_aid).toLowerCase()}`, f.from_base && f.from_base !== 'na' && `from base by ${label(f.from_base).toLowerCase()}${f.ambulance_code ? ` (${f.ambulance_code})` : ''}`].filter(Boolean);
  if (how.length) out.push(sentence(`Transported ${how.join(', ')}`));
  const dest = [f.destination_type && f.destination_type !== 'na' ? label(f.destination_type).toLowerCase() : null, f.hospital_name].filter(Boolean);
  if (dest.length) out.push(sentence(`Destination: ${dest.join(', ')}`));
  const handTime = f.handoff_time || timeOf(c, 'handoff');
  if (f.handoff_to) out.push(sentence(`Care handed to ${f.handoff_to}${handTime ? ` at ${handTime}` : ''}`));
  if (p.disposition) out.push(sentence(`Outcome: ${label(p.disposition).toLowerCase()}`));
  if (p.disposition === 'refused_care') {
    const risks = { yes: ' after the risks were explained', no: '. Risks not recorded as explained' }[f.refusal_risks_explained] || '';
    const cap = { yes: '; alert and able to decide', no: '; recorded as NOT able to decide' }[f.refusal_capacity] || '';
    out.push(sentence(`Refused ${f.refusal_scope ? label(f.refusal_scope).toLowerCase() : 'care'}${risks}${cap}${f.refusal_advice ? `. Advised: ${f.refusal_advice}` : ''}`));
  }
  return out;
}

function opening(c, p) {
  const t = [timeOf(c, 'call_received') && `Call received ${timeOf(c, 'call_received')}`, timeOf(c, 'on_scene') && `on scene ${timeOf(c, 'on_scene')}`].filter(Boolean).join(', ');
  return sentence(`${t ? `${t}. ` : ''}Found a ${who(p)} at ${c.location}${c.trail && !String(c.location).includes(c.trail) ? ` (${c.trail})` : ''}${p.chief_complaint ? ` complaining of ${String(p.chief_complaint).replace(/\.$/, '').toLowerCase()}` : ''}`);
}

const block = (title, lines) => `${title}: ${lines.filter(Boolean).join(' ') || 'Not recorded.'}`;

export function chart(c, p) {
  return [
    block('C', [sentence(p.chief_complaint || '')]),
    block('H', [opening(c, p), ...history(p)]),
    block('A', findings(c, p)),
    block('R', care(p)),
    block('T', transport(c, p)),
  ].join('\n\n');
}

export function soap(c, p) {
  return [
    block('S', [p.chief_complaint ? sentence(`Chief complaint: ${p.chief_complaint}`) : '', ...history(p)]),
    block('O', [opening(c, p), ...findings(c, p)]),
    block('A', [live(p.injuries).length ? sentence(`Suspected ${live(p.injuries).map((i) => `${label(i.injury_type).toLowerCase()} of the ${label(i.body_region).toLowerCase()}`).join(', ')}`) : '', (p.form && p.form.treatment_protocol || []).length ? sentence(`Treated under the ${p.form.treatment_protocol.map((x) => label(x).toLowerCase()).join(', ')} protocol`) : '']),
    block('P', [...care(p), ...transport(c, p)]),
  ].join('\n\n');
}

/** The whole case: one draft per patient (only patients not entered in error), separated by their names. */
export function draftNarrative(c, style = 'chart') {
  const pts = live(c.patients);
  if (!pts.length) return '';
  const one = style === 'soap' ? soap : chart;
  if (pts.length === 1) return one(c, pts[0]);
  return pts.map((p) => `${`${p.first_name} ${p.last_name}`.trim().toUpperCase()}\n${one(c, p)}`).join('\n\n');
}
