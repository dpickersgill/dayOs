'use strict';

// The report check: before a patroller submits, Verdynt/OS points out gaps a reviewer, a lawyer or the receiving
// hospital would notice in a patient care report. These are suggestions, never blocks: the submit check
// (reportProblems in routes/patrol.js) decides what is required; this one only says "you may want to look at this".
// The patroller decides, and the director sees the same list when reviewing.
//
// Each item is { message, why, ...where } where `where` is what the case screen's jump links understand:
//   { scope: 'patient', patient_id, section, field } for a form field, or { area, patient_id? } for a part of the page.

const CLINICAL = ['injury', 'medical', 'collision'];
const live = (list) => (list || []).filter((x) => !x.voided_at);
const blank = (v) => v === undefined || v === null || (typeof v === 'string' && !v.trim());
const time = (t) => Date.parse(`${String(t).replace(' ', 'T')}Z`);
const hhmm = (t) => String(t).slice(11, 16);

const HEAD_REGIONS = new Set(['head', 'face']);
const SPINE_REGIONS = new Set(['neck', 'back']);
const MEDICAL_TYPES = new Set(['illness', 'cardiac']);
const HEAD_QUESTIONS = [['head_loc', 'lost consciousness'], ['head_amnesia_before', 'memory before'], ['head_amnesia_after', 'memory after'], ['head_vomiting', 'vomiting'], ['head_headache', 'headache']];

/** The order care usually happens in. Two entries the other way round are almost always a typing slip. */
const EVENT_ORDER = ['call_received', 'dispatched', 'on_scene', 'patient_contact', 'transport_started', 'handoff', 'cleared'];
const EVENT_WORD = { call_received: 'Call received', dispatched: 'Dispatched', on_scene: 'On scene', patient_contact: 'Patient contact', transport_started: 'Transport started', handoff: 'Hand-off', cleared: 'Cleared' };

/** Vitals outside these bands for an adult call for a repeat set before the patient leaves your care. */
function abnormal(v) {
  const out = [];
  if (v.pulse != null && (v.pulse < 50 || v.pulse > 120)) out.push(`pulse ${v.pulse}`);
  if (v.resp != null && (v.resp < 10 || v.resp > 28)) out.push(`breathing ${v.resp}`);
  if (v.bp_sys != null && v.bp_sys < 90) out.push(`BP ${v.bp_sys}${v.bp_dia != null ? `/${v.bp_dia}` : ''}`);
  if (v.spo2 != null && v.spo2 < 92) out.push(`SpO2 ${v.spo2}%`);
  if (v.gcs != null && v.gcs < 15) out.push(`GCS ${v.gcs}`);
  if (v.avpu && v.avpu !== 'alert') out.push(`AVPU ${v.avpu}`);
  return out;
}

/**
 * Words that read as opinion, blame or a guess about the patient's state. A report states what was seen and said;
 * "smelled of alcohol, said he had two beers" stands up, "drunk" does not. Each entry: [pattern, plain alternative].
 */
const LOADED = [
  [/\b(drunk|intoxicated|wasted|hammered|smashed|high)\b/i, 'say what you saw or were told: "smelled of alcohol", "said they had two beers"'],
  [/\b(idiot|stupid|moron|crazy|insane|careless|reckless|out of control)\b/i, 'describe what they did, not what you think of them'],
  [/\b(his fault|her fault|their fault|at fault|to blame|caused the accident|should have|shouldn'?t have)\b/i, 'leave fault out: record what happened and what witnesses said'],
  [/\b(obviously|clearly|definitely|no doubt)\b/i, 'say what you observed instead of how sure you are'],
  [/\b(lied|lying|faking|exaggerat\w*)\b/i, 'record what the patient said, and what you found, side by side'],
  [/\b(diagnosed|broke (his|her|their) \w+|broken (arm|leg|wrist|ankle|collarbone|femur|tibia|hip|rib|ribs))\b/i, 'patrollers record signs and suspicions: "suspected fracture", "deformity of the left wrist"'],
];

function storyChecks(c, add) {
  const story = String(c.narrative || '').trim();
  if (!story) {
    add('Say what happened in the narrative', 'The story in your own words is what a reviewer and a court read first. Speak it with your phone\'s keyboard microphone if typing with gloves is slow.', { area: 'narrative' });
    return;
  }
  if (story.split(/\s+/).length < 25) add('The narrative is very short', 'A few lines on how it happened, what you found, what you did and how the patient changed makes the report stand on its own.', { area: 'narrative' });
  const seen = new Set();
  for (const [re, tip] of LOADED) {
    const m = story.match(re);
    if (m && !seen.has(tip)) { seen.add(tip); add(`The narrative says "${m[0]}"`, `Consider rewording: ${tip}.`, { area: 'narrative' }); }
  }
}

function timelineChecks(c, add) {
  const ev = live(c.events).filter((e) => EVENT_ORDER.includes(e.kind) && !e.patient_id);
  const firstOf = new Map();
  for (const e of ev) if (!firstOf.has(e.kind)) firstOf.set(e.kind, e);
  const kinds = EVENT_ORDER.filter((k) => firstOf.has(k));
  for (let i = 1; i < kinds.length; i += 1) {
    const a = firstOf.get(kinds[i - 1]); const b = firstOf.get(kinds[i]);
    if (time(b.at) < time(a.at)) {
      add(`Timeline: ${EVENT_WORD[b.kind]} (${hhmm(b.at)}) is before ${EVENT_WORD[a.kind]} (${hhmm(a.at)})`, 'Check the times. Out-of-order times are the first thing a reviewer questions.', { area: 'events' });
      break;
    }
  }
}

function patientChecks(c, p, add) {
  const who = `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'Patient';
  const f = { ...(p.derived || {}), ...(p.form || {}) };
  const vitals = live(p.vitals);
  const injuries = live(p.injuries);
  const treatments = live(p.treatments);
  const at = (where) => ({ patient_id: p.id, ...where });
  const field = (section, key) => at({ scope: 'patient', section, field: key });
  const leaving = ['transported_ambulance', 'transported_private'].includes(p.disposition) || ['hospital', 'clinic', 'doctor'].includes(f.destination_type);

  // ---- head injury
  const headInjury = injuries.some((i) => HEAD_REGIONS.has(i.body_region) || i.injury_type === 'concussion')
    || f.head_loc === 'yes' || f.head_amnesia_before === 'yes' || f.head_amnesia_after === 'yes';
  if (headInjury) {
    if (!vitals.some((v) => v.avpu || v.gcs != null)) add(`${who}: head injury with no AVPU or GCS recorded`, 'Level of consciousness is the baseline the next provider compares against.', at({ area: 'vitals' }));
    const unanswered = HEAD_QUESTIONS.filter(([k]) => blank(f[k]));
    if (unanswered.length) add(`${who}: head injury questions not answered (${unanswered.map((q) => q[1]).join(', ')})`, '"No" is an answer worth recording: it shows you asked.', field('head', unanswered[0][0]));
    if ((blank(f.helmet) || f.helmet === 'unknown') && !['yes', 'no'].includes(p.helmet)) add(`${who}: head injury and helmet use not recorded`, 'Helmet use is one of the first questions after a head injury.', field('equipment', 'helmet'));
    if (vitals.length === 1 && p.disposition !== 'refused_care') add(`${who}: only one set of vitals for a head injury`, 'A second set shows whether the patient is getting better or worse.', at({ area: 'vitals' }));
  }

  // ---- spine
  const spineFlags = f.spine_mechanism === 'yes' || f.spine_midline === 'yes' || f.spine_neuro === 'yes';
  const spineConcern = spineFlags || injuries.some((i) => SPINE_REGIONS.has(i.body_region) || i.injury_type === 'spinal') || treatments.some((t) => t.kind === 'spinal_motion_restriction');
  if (spineConcern && blank(f.spine_decision)) add(`${who}: spine concern with no decision recorded`, 'Record whether motion restriction was applied, not indicated by the criteria, or declined.', field('spine', 'spine_decision'));
  if (f.spine_decision === 'not_indicated' && (f.spine_midline === 'yes' || f.spine_neuro === 'yes')) {
    add(`${who}: midline tenderness or numbness recorded, but motion restriction marked not indicated`, 'Check the answers, or say in the narrative why you decided against it.', field('spine', 'spine_decision'));
  }

  // ---- treatments
  for (const t of treatments) {
    const d = t.detail || {};
    const when = hhmm(t.performed_at);
    if (['splint', 'spinal_motion_restriction'].includes(t.kind) && (!d.cms_before || !d.cms_after)) {
      add(`${who}: ${t.kind === 'splint' ? 'splint' : 'motion restriction'} at ${when} without CMS ${!d.cms_before && !d.cms_after ? 'before and after' : !d.cms_before ? 'before' : 'after'}`, 'Circulation, motor and sensation before and after shows the treatment did no harm.', at({ area: 'treatments' }));
    }
    if (t.kind === 'oxygen' && (!d.o2_device || d.o2_lpm == null)) add(`${who}: oxygen at ${when} without the ${!d.o2_device ? 'device' : 'flow rate'}`, 'Device and litres per minute are what the next provider needs.', at({ area: 'treatments' }));
    if (t.kind === 'medication') {
      if (blank(d.indication)) add(`${who}: ${t.medication || 'medication'} at ${when} without the reason it was given`, 'Every medication needs its indication.', at({ area: 'treatments' }));
      if (blank(d.effect)) add(`${who}: ${t.medication || 'medication'} at ${when} without the effect`, 'Record how the patient responded, even "no change".', at({ area: 'treatments' }));
    }
    if (t.kind === 'tourniquet' && leaving && blank(f.handoff_to)) add(`${who}: tourniquet on and sent to higher care, but who took over is not recorded`, 'The receiving crew must know the time it went on; name who you told.', field('transport', 'handoff_to'));
  }
  if (treatments.some((t) => t.kind === 'medication') && blank(p.allergies)) add(`${who}: medication given but allergies left blank`, 'Write "none known" if the patient has none.', field('patient', 'allergies'));

  // ---- vitals
  const last = vitals[vitals.length - 1];
  const bad = last ? abnormal(last) : [];
  if (bad.length && p.disposition !== 'refused_care') add(`${who}: last vitals at ${hhmm(last.taken_at)} were abnormal (${bad.join(', ')}) with no repeat set`, 'A repeat set shows the trend at hand-off. If the patient left your care first, say so in the narrative.', at({ area: 'vitals' }));
  const hurt = injuries.some((i) => !MEDICAL_TYPES.has(i.injury_type));
  if (hurt && !vitals.some((v) => v.pain != null) && blank(f.opqrst_severity)) add(`${who}: injury with no pain score`, 'A 0 to 10 pain score is quick and shows change over time.', at({ area: 'vitals' }));

  // ---- hand-off
  if (leaving && blank(f.handoff_to) && !treatments.some((t) => t.kind === 'tourniquet')) add(`${who}: sent to higher care, but who took over is not recorded`, 'Name the paramedic, nurse or doctor and their unit.', field('transport', 'handoff_to'));
}

/** The suggestions for one case as loadCase returns it. Empty for a case that is not about a patient. */
function checkCase(c) {
  const out = [];
  const add = (message, why, where = {}) => out.push({ message, why, ...where });
  if (!CLINICAL.includes(c.category)) return out;
  storyChecks(c, add);
  timelineChecks(c, add);
  for (const p of live(c.patients)) patientChecks(c, p, add);
  return out;
}

module.exports = { checkCase, abnormal, LOADED };
