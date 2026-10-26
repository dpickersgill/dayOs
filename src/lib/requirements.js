'use strict';

// Report requirements: what a patrol report must hold, set by the patrol director for each kind of case.
//
// Every field on the report has a level:
//   off          not asked for
//   recommended  shown in the report check; never stops anything
//   approve      needed before the report is approved (the reviewer sees it); submitting still works
//   submit       needed before the report can be submitted (and so before it is approved)
// and can be limited to cases where something is true ("only when"): serious or critical, transported, under 18,
// a collision, refused care, staff or a volunteer on duty, rental gear, or a lift involved. All of these are worked out
// from answers the report already holds, so a patroller never enters anything extra for them.
//
// Each change to the rules is kept as a new version. A report is stamped with the version in force when it is submitted,
// and the approval is judged against that version, so tightening the rules never moves the goalposts for a report
// already in review. A required item can be answered N/A with a reason, which the report shows instead of a blank.
//
// The safety rules in routes/patrol.js (head injury and skiing, vitals for serious cases, refusals) are always checked
// and cannot be switched off here; ALWAYS lists them so the settings screen can say so.
const { rows, one } = require('../db');
const { FIELDS, SECTIONS, parseForm, isEmpty, applies } = require('./nsaar');

const LEVELS = ['off', 'recommended', 'approve', 'submit'];
const LEVEL_LABEL = { off: 'Off', recommended: 'Recommended', approve: 'Required to approve', submit: 'Required to submit' };

/** Kinds of case, each with its own list. Patient care cases use the whole patient care report. */
const TYPES = [['injury', 'Injury'], ['medical', 'Medical'], ['collision', 'Collision'], ['lost_person', 'Lost person'], ['equipment', 'Equipment'], ['conduct', 'Conduct'], ['other', 'Other']];
const TYPE_KEYS = TYPES.map((t) => t[0]);
const CARE = new Set(['injury', 'medical', 'collision']);
const isCare = (type) => CARE.has(type);

/**
 * Parts of the report that are not form fields, so the director can require them too. scope 'case', section 'report'.
 * test(c) is true when the case has it.
 */
const EXTRA = [
  { key: 'narrative', label: 'Narrative (what happened, in your own words)', test: (c) => !isEmpty(String(c.narrative || '').trim()) },
  { key: 'photos', label: 'At least one photo', test: (c) => (c.photos || []).some((m) => !m.voided_at) },
  { key: 'collision_report', label: 'Collision report', types: ['collision'], test: (c) => Boolean(c.collision) },
];

// ---------------------------------------------------------------- conditions ("only when")
const LEAVING = ['transported_ambulance', 'transported_private'];
const RENTAL = ['area_rental', 'other_rental', 'area_demos', 'other_demos'];
/** The patient's age on the day of the case: the recorded age, or worked out from the date of birth. */
function ageOf(p, onDay) {
  if (p.age_years !== null && p.age_years !== undefined && p.age_years !== '') return Number(p.age_years);
  if (!p.date_of_birth) return null;
  const dob = String(p.date_of_birth).slice(0, 10); const day = String(onDay || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  let a = Number(day.slice(0, 4)) - Number(dob.slice(0, 4));
  if (day.slice(5) < dob.slice(5)) a -= 1;
  return a;
}
const formOf = (p) => ({ ...(p.derived || {}), ...parseForm(p.form) });
// [key, label, patient test or null, case test or null]. A patient condition on a case-level field holds when any patient matches.
const CONDITIONS = [
  ['serious', 'Serious or critical', null, (c) => ['serious', 'critical'].includes(c.severity)],
  ['transported', 'Transported to higher care', (p) => LEAVING.includes(p.disposition), null],
  ['minor', 'Patient under 18', (p, c) => { const a = ageOf(p, c.occurred_at); return a !== null && a < 18; }, null],
  ['collision', 'A collision', (p) => formOf(p).collided === 'yes', (c) => c.category === 'collision'],
  ['refused', 'Care refused', (p) => p.disposition === 'refused_care', null],
  ['staff', 'Staff or volunteer on duty', (p) => ['staff_work', 'volunteer_work'].includes(formOf(p).patient_type) || p.activity === 'staff', null],
  ['rental', 'Rental or demo gear', (p) => RENTAL.includes(formOf(p).equipment) || p.rental_equipment === 'yes', null],
  ['lift', 'A lift involved', (p) => String(formOf(p).cause || '').startsWith('lift_'), (c) => parseForm(c.form).incident_location === 'lift_incident'],
];
const CONDITION_KEYS = CONDITIONS.map((x) => x[0]);
/** Conditions that make sense for a kind of case: those about patients only where the case has patients. */
const conditionsFor = (type) => CONDITIONS.filter(([, , pt]) => isCare(type) || !pt).map(([key, label]) => ({ key, label }));

function conditionHolds(key, c, p) {
  const cond = CONDITIONS.find((x) => x[0] === key);
  if (!cond) return false;
  const [, , pt, ct] = cond;
  if (ct && ct(c)) return true;
  if (!pt) return false;
  const live = (c.patients || []).filter((x) => !x.voided_at);
  return p ? Boolean(pt(p, c)) : live.some((x) => pt(x, c));
}

// ---------------------------------------------------------------- what can be required
const N_A = [['declined', 'Patient declined to answer'], ['unable', 'Patient could not answer'], ['left', 'Patient left before it was asked'], ['not_applicable', 'Does not apply'], ['other', 'Other']];
const NA_KEYS = N_A.map((x) => x[0]);
const NA_LABEL = Object.fromEntries(N_A);

/** The items a kind of case can require: { id: 'scope.key', scope, key, section, label, type, locked }. */
function itemsFor(type) {
  const out = [];
  for (const f of FIELDS) {
    if (f.locked === 'never') continue;
    if (!isCare(type) && f.scope === 'patient') continue;
    out.push({ id: `${f.scope}.${f.key}`, scope: f.scope, key: f.key, section: f.section, label: f.label, type: f.type, locked: f.locked || null, field: f });
  }
  for (const x of EXTRA) {
    if (x.types && !x.types.includes(type)) continue;
    out.push({ id: `case.${x.key}`, scope: 'case', key: x.key, section: 'report', label: x.label, type: 'extra', locked: null, extra: x });
  }
  return out;
}
const ITEM_IDS = Object.fromEntries(TYPE_KEYS.map((t) => [t, new Set(itemsFor(t).map((i) => i.id))]));

// ---------------------------------------------------------------- the rules
/**
 * Rules: { [type]: { [itemId]: { level, when: [] } }, options: { leave } }. Anything left out is off.
 * options.leave: ask "before the patient leaves" on patient care cases (on in every starting setup; off until the
 * director turns it on, for a mountain that has not changed its rules since report requirements arrived).
 */
function emptyRules() { return { ...Object.fromEntries(TYPE_KEYS.map((t) => [t, {}])), options: { leave: false } }; }
const optionsOf = (rules) => ({ leave: Boolean(rules && rules.options && rules.options.leave) });

/** Keeps only known types, items, levels and conditions; drops "off" entries. Throws a plain message on nonsense. */
function clean(rules) {
  const out = emptyRules();
  out.options = optionsOf(rules);
  for (const [type, items] of Object.entries(rules || {})) {
    if (type === 'options') continue;
    if (!TYPE_KEYS.includes(type)) throw new Error(`Unknown kind of case: ${type}`);
    const allowedWhen = new Set(conditionsFor(type).map((c) => c.key));
    for (const [id, r] of Object.entries(items || {})) {
      if (!ITEM_IDS[type].has(id)) throw new Error(`Unknown item for ${type} cases: ${id}`);
      const level = r && r.level;
      if (!LEVELS.includes(level)) throw new Error(`Unknown level for ${id}: ${level}`);
      const item = itemsFor(type).find((i) => i.id === id);
      if (item.locked === 'always') continue; // decided by the form itself
      if (level === 'off') continue;
      const when = [...new Set((r.when || []).filter((w) => allowedWhen.has(w)))];
      if ((r.when || []).some((w) => !CONDITION_KEYS.includes(w))) throw new Error(`Unknown condition for ${id}`);
      out[type][id] = when.length ? { level, when } : { level };
    }
  }
  return out;
}

/** The rules a mountain had before levels existed: its mandatory ticks (or the form's defaults) for injury and medical cases. */
async function legacyRules(conn, tenantId) {
  const saved = await rows(conn, 'SELECT scope, field_key, required FROM patrol_form_config WHERE tenant_id = ?', [tenantId]);
  const choice = new Map(saved.map((r) => [`${r.scope}.${r.field_key}`, Boolean(r.required)]));
  const out = emptyRules();
  for (const f of FIELDS) {
    if (f.locked) continue;
    const id = `${f.scope}.${f.key}`;
    const on = choice.has(id) ? choice.get(id) : Boolean(f.defaultRequired);
    if (!on) continue;
    for (const t of ['injury', 'medical']) out[t][id] = { level: 'submit' };
  }
  return out;
}

/** The rules in force now: { id (null before the first change), rules, preset, changed_at, changed_by }. */
async function current(conn, tenantId) {
  const v = await one(conn, `SELECT r.id, r.rules, r.preset, r.note, r.created_at, COALESCE(u.email, u.username) AS changed_by
    FROM patrol_rule_versions r LEFT JOIN users u ON u.id = r.created_by AND u.tenant_id = r.tenant_id
    WHERE r.tenant_id = ? ORDER BY r.id DESC LIMIT 1`, [tenantId]);
  if (v) return { id: Number(v.id), rules: { ...emptyRules(), ...JSON.parse(v.rules) }, preset: v.preset, note: v.note, changed_at: v.created_at, changed_by: v.changed_by };
  return { id: null, rules: await legacyRules(conn, tenantId), preset: null, note: null, changed_at: null, changed_by: null };
}

/** One saved version (a report keeps the id it was submitted under). Falls back to the current rules. */
async function version(conn, tenantId, id) {
  if (!id) return current(conn, tenantId);
  const v = await one(conn, 'SELECT id, rules, preset, created_at FROM patrol_rule_versions WHERE tenant_id = ? AND id = ?', [tenantId, id]);
  if (!v) return current(conn, tenantId);
  return { id: Number(v.id), rules: { ...emptyRules(), ...JSON.parse(v.rules) }, preset: v.preset, changed_at: v.created_at };
}

/** Saves new rules as a version and returns its id. The first save also keeps the old rules, so the history starts complete. */
async function save(conn, tenantId, userId, rules, { preset = null, note = null } = {}) {
  await ensure(conn, tenantId);
  const [r] = await conn.query('INSERT INTO patrol_rule_versions (tenant_id, rules, preset, note, created_by) VALUES (?, ?, ?, ?, ?)', [tenantId, JSON.stringify(clean(rules)), preset, note, userId]);
  return r.insertId;
}

/** The current rules as a saved version, saving them first if the mountain has never changed them (a report is stamped with it). */
async function ensure(conn, tenantId) {
  const now = await current(conn, tenantId);
  if (now.id !== null) return now;
  const [r] = await conn.query('INSERT INTO patrol_rule_versions (tenant_id, rules, preset, note, created_by) VALUES (?, ?, NULL, ?, NULL)', [tenantId, JSON.stringify(now.rules), 'The mandatory fields before report requirements']);
  return { ...now, id: r.insertId };
}

async function history(conn, tenantId, limit = 30) {
  return (await rows(conn, `SELECT r.id, r.preset, r.note, r.created_at, COALESCE(u.email, u.username) AS changed_by
    FROM patrol_rule_versions r LEFT JOIN users u ON u.id = r.created_by AND u.tenant_id = r.tenant_id WHERE r.tenant_id = ? ORDER BY r.id DESC LIMIT ?`, [tenantId, limit]))
    .map((v) => ({ ...v, id: Number(v.id) }));
}

// ---------------------------------------------------------------- starting setups
const all = (ids, level) => Object.fromEntries(ids.map((id) => [id, { level }]));
const only = (ids, level, when) => Object.fromEntries(ids.map((id) => [id, { level, when }]));
const p = (...keys) => keys.map((k) => `patient.${k}`);
const cs = (...keys) => keys.map((k) => `case.${k}`);

/** Patient care: who, what, where and how they left, as the NSAA form and its review guide ask. */
function nsaaCare(type) {
  return {
    ...all(p('date_of_birth', 'phone', 'gender', 'chief_complaint', 'body_parts', 'treatment_protocol', 'signs_symptoms', 'description', 'activity', 'ability', 'equipment', 'helmet', 'collided', 'cause', 'to_first_aid', 'from_base', 'destination_type', 'disposition'), 'submit'),
    ...all(p('address', 'city', 'region', 'postal', 'ticket_type', 'involvement', 'binding_release', 'lesson', 'scene_on', 'patient_type'), 'approve'),
    ...all(p('allergies', 'medications', 'medical_history', 'last_meal', 'drugs_alcohol', 'days_area', 'days_all', 'height', 'weight', 'occupation', 'patient_signature'), 'recommended'),
    ...only(p('handoff_to', 'handoff_time', 'hospital_name'), 'submit', ['transported']),
    ...only(p('rental_boot', 'rental_ski'), 'submit', ['rental']),
    ...all(cs('witnesses', 'incident_location', 'run_classification', 'weather', 'light', 'temperature', 'snow', 'surface', 'completed_by_name', 'completed_by_number', 'narrative'), 'submit'),
    ...all(cs('patroller_signature', 'trail_id'), 'approve'),
    ...all(cs('gps', 'photos'), 'recommended'),
    ...(type === 'collision' ? all(cs('collision_report'), 'submit') : {}),
  };
}
/** The fewest fields a small volunteer patrol needs for a report that holds up: who, what, where, how they left. */
function leanCare(type) {
  return {
    ...all(p('date_of_birth', 'phone', 'chief_complaint', 'signs_symptoms', 'disposition'), 'submit'),
    ...all(p('description', 'body_parts', 'activity', 'helmet', 'destination_type'), 'approve'),
    ...all(p('ability', 'equipment', 'cause', 'collided', 'allergies', 'medications'), 'recommended'),
    ...only(p('handoff_to'), 'submit', ['transported']),
    ...only(p('rental_boot', 'rental_ski'), 'approve', ['rental']),
    ...all(cs('witnesses', 'narrative'), 'submit'),
    ...all(cs('incident_location', 'surface', 'completed_by_name'), 'approve'),
    ...all(cs('weather', 'light', 'photos'), 'recommended'),
    ...(type === 'collision' ? all(cs('collision_report'), 'approve') : {}),
  };
}
/**
 * What insurers' incident documentation guides commonly ask for. A DRAFT from industry practice: it is replaced by a real
 * insurer's checklist when one is received. Stricter than NSAA on contact details, conditions, gear and sign-off.
 */
function insurerCare(type) {
  return {
    ...nsaaCare(type),
    ...all(p('address', 'city', 'region', 'postal', 'ticket_type', 'involvement', 'binding_release', 'lesson', 'scene_on', 'patient_signature', 'patient_type', 'description_signed_by'), 'submit'),
    ...all(p('allergies', 'medications', 'medical_history', 'drugs_alcohol', 'days_area', 'times_run'), 'approve'),
    ...only(p('handoff_to', 'handoff_time', 'hospital_name', 'ambulance_code'), 'submit', ['transported']),
    ...only(p('rental_boot', 'rental_ski', 'binding_release'), 'submit', ['rental']),
    ...all(cs('patroller_signature', 'trail_id', 'map_grid', 'photos'), 'submit'),
    ...all(cs('gps'), 'approve'),
  };
}
/** Cases with no patient: where, what was seen, who saw it, who wrote it. */
function nonCare(strength) {
  const lvl = strength === 'lean' ? 'approve' : 'submit';
  return {
    ...all(cs('narrative'), 'submit'),
    ...all(cs('witnesses', 'completed_by_name'), lvl),
    ...all(cs('incident_location', 'photos'), strength === 'insurer' ? 'submit' : 'recommended'),
    ...(strength === 'insurer' ? all(cs('patroller_signature', 'weather', 'light', 'surface'), 'approve') : {}),
  };
}

const PRESETS = [
  { key: 'nsaa', label: 'NSAA standard', about: 'Follows the National Ski Area Accident Report and its review guide. A sound default for most patrols.', build: (t) => (isCare(t) ? nsaaCare(t) : nonCare('nsaa')) },
  { key: 'lean', label: 'Lean volunteer patrol', about: 'The fewest fields for a report that still holds up: who, what, where and how they left. For small volunteer patrols.', build: (t) => (isCare(t) ? leanCare(t) : nonCare('lean')) },
  { key: 'insurer', label: 'Insurer-ready (draft)', draft: true, about: 'Built from what insurers\' documentation guides commonly ask for. A draft until it is checked against a real insurer\'s checklist: ask yours for theirs.', build: (t) => (isCare(t) ? insurerCare(t) : nonCare('insurer')) },
];
function presetRules(key) {
  const pr = PRESETS.find((x) => x.key === key);
  if (!pr) return null;
  return clean({ ...Object.fromEntries(TYPE_KEYS.map((t) => [t, pr.build(t)])), options: { leave: true } });
}

/** What changes between two sets of rules, for the preview before a starting setup replaces the current one. */
function diff(before, after) {
  const out = [];
  if (optionsOf(before).leave !== optionsOf(after).leave) out.push({ type: 'options', id: 'options.leave', label: 'Ask before the patient leaves', from: { level: optionsOf(before).leave ? 'on' : 'off' }, to: { level: optionsOf(after).leave ? 'on' : 'off' } });
  for (const t of TYPE_KEYS) {
    const ids = new Set([...Object.keys(before[t] || {}), ...Object.keys(after[t] || {})]);
    for (const id of ids) {
      const a = (before[t] || {})[id] || { level: 'off' }; const b = (after[t] || {})[id] || { level: 'off' };
      if (a.level === b.level && String(a.when || []) === String(b.when || [])) continue;
      const item = itemsFor(t).find((i) => i.id === id);
      out.push({ type: t, id, label: item ? item.label : id, from: a, to: b });
    }
  }
  return out;
}

/** Safety rules checked on every patient care report, whatever the settings. */
const ALWAYS = [
  'A patient name, the exact location and a one-line summary',
  'The patroller who led the response',
  'At least one patient on an injury or medical case',
  'Lost consciousness, amnesia or a GCS under 15: not back to skiing unless cleared by a named person or care was refused in writing',
  'Serious, critical or transported: a set of vitals, and two when on scene more than 15 minutes',
  'Refused care: a signed refusal, a note on capacity when anything clouds it, and a parent or guardian for anyone under 18',
];

// ---------------------------------------------------------------- what a case still needs
function fieldValue(f, row, form) {
  if (f.type === 'gps') return row.gps_lat !== null && row.gps_lat !== undefined && row.gps_lng !== null && row.gps_lng !== undefined ? true : null;
  if (f.col) return row[f.col];
  return form[f.key];
}
const naOf = (row) => (row && row.na ? (typeof row.na === 'string' ? (() => { try { return JSON.parse(row.na); } catch (_) { return {}; } })() : row.na) : {});
const titleOf = new Map([...SECTIONS.map((s) => [s.id, s.title]), ['report', 'Report']]);

/**
 * Every requirement that applies to a loaded case (see loadCase in routes/patrol.js), answered or not.
 * Returns items { id, scope, key, section, section_title, label, level, when, patient_id, who, met, na, exception }.
 * exceptions: [{ scope, key, patient_id }] already approved with an exception (met for approval).
 */
function evaluate(rules, c, { exceptions = [] } = {}) {
  const type = TYPE_KEYS.includes(c.category) ? c.category : 'other';
  const set = rules[type] || {};
  const out = [];
  const patients = (c.patients || []).filter((x) => !x.voided_at);
  const caseForm = parseForm(c.form);
  const caseNa = naOf(c);
  const caseVals = Object.fromEntries(FIELDS.filter((f) => f.scope === 'case').map((f) => [f.key, fieldValue(f, c, caseForm)]));
  const signed = (kind, pid) => (c.signatures || []).some((s) => s.kind === kind && (pid === undefined || s.patient_id === pid || s.patient_id === null));
  const excepted = (scope, key, pid) => exceptions.some((e) => e.scope === scope && e.key === key && (e.patient_id || null) === (pid || null));
  for (const item of itemsFor(type)) {
    const r = set[item.id];
    if (!r || r.level === 'off') continue;
    const push = (patient, met, na) => out.push({
      id: item.id, scope: item.scope, key: item.key, section: item.section, section_title: titleOf.get(item.section) || item.section, label: item.label,
      level: r.level, when: r.when || [], patient_id: patient ? patient.id : null, who: patient ? `${patient.first_name || ''} ${patient.last_name || ''}`.trim() || 'Patient' : null,
      met: Boolean(met || na), na: na || null, exception: excepted(item.scope, item.key, patient ? patient.id : null),
    });
    if (item.scope === 'case') {
      if (r.when && r.when.length && !r.when.some((w) => conditionHolds(w, c, null))) continue;
      if (item.extra) { push(null, item.extra.test(c), caseNa[item.key]); continue; }
      const f = item.field;
      if (!applies(f, caseVals)) continue;
      let met;
      if (f.type === 'witnesses') met = (c.witnesses || []).length > 0 || Boolean(caseForm.witnesses_none);
      else if (f.type === 'signature') met = signed(f.kind);
      else met = !isEmpty(caseVals[f.key]);
      push(null, met, caseNa[item.key]);
    } else {
      for (const pt of patients) {
        if (r.when && r.when.length && !r.when.some((w) => conditionHolds(w, c, pt))) continue;
        const f = item.field;
        const form = { ...(pt.derived || {}), ...parseForm(pt.form) };
        const vals = Object.fromEntries(FIELDS.filter((x) => x.scope === 'patient').map((x) => [x.key, fieldValue(x, pt, form)]));
        if (!applies(f, vals)) continue;
        const met = f.type === 'signature' ? signed(f.kind, pt.id) : !isEmpty(vals[f.key]);
        push(pt, met, naOf(pt)[item.key]);
      }
    }
  }
  return out;
}

/** The plain message for one unmet item, as the problem list and the reviewer show it. */
const message = (i) => `${i.who ? `${i.who}: ` : `${i.section_title}: `}${i.label}`;
/** Where the case screen should jump for an item. */
const where = (i) => (i.key === 'narrative' ? { area: 'narrative' } : i.key === 'photos' ? { area: 'photos' } : i.key === 'collision_report' ? { area: 'collision' }
  : { scope: i.scope, section: i.section, field: i.key, ...(i.patient_id ? { patient_id: i.patient_id } : {}) });

/** Counts of what is left, by section, for the Report tab. */
function summary(items) {
  const left = items.filter((i) => !i.met && ['submit', 'approve'].includes(i.level));
  const bySection = {};
  for (const i of left) {
    const k = i.section;
    bySection[k] = bySection[k] || { section: k, title: i.section_title, submit: 0, approve: 0 };
    bySection[k][i.level] += 1;
  }
  return {
    submit_left: left.filter((i) => i.level === 'submit').length,
    approve_left: left.filter((i) => i.level === 'approve' && !i.exception).length,
    recommended_left: items.filter((i) => !i.met && i.level === 'recommended').length,
    sections: Object.values(bySection),
  };
}

/** Whether N/A may be given for an item: never for what the form itself always needs. */
function naAllowed(type, id) {
  const item = itemsFor(type).find((i) => i.id === id);
  return Boolean(item) && item.locked !== 'always';
}

module.exports = {
  LEVELS, LEVEL_LABEL, TYPES, TYPE_KEYS, CARE, isCare, CONDITIONS: CONDITIONS.map(([key, label]) => ({ key, label })), CONDITION_KEYS, conditionsFor, conditionHolds,
  N_A, NA_KEYS, NA_LABEL, EXTRA, itemsFor, emptyRules, optionsOf, clean, legacyRules, current, version, ensure, save, history,
  PRESETS: PRESETS.map(({ key, label, about, draft }) => ({ key, label, about, draft: Boolean(draft) })), presetRules, diff, ALWAYS,
  evaluate, message, where, summary, naAllowed, naOf, ageOf,
};
