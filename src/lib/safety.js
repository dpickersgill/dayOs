'use strict';

// The injury network: de-identified injury counts across the mountains that choose to share, for the National Ski
// Patrol, NSAA and researchers, and a "how do we compare" view for each mountain.
//
// What leaves a mountain is only ever a count of patients or injuries in a category: activity, ability, age band,
// sex, helmet, cause, where on the mountain, run rating, conditions, month, time of day, outcome, and injury type by
// body area. Never a name, date of birth, exact age, contact detail, free text, exact time, run name or GPS point,
// and never one patient's row. Any count from 1 to 4 is not shown, and neither is a second count where the hidden
// one could be worked out from a total. Hidden counts are all marked the same way ("not shown"), so which of them is
// the small one cannot be told.
//
// Counted: patients on reports that were submitted or approved, not entered in error. Left out by default, as in
// NSAA's injury studies: staff injured while working, racers and race training, medical calls (illness, cardiac,
// a prior condition), and patients found to have no injury.
//
// The rate is patients per 1,000 skier visits. A skier visit is a ticket's first accepted gate scan on a local day,
// so only mountains that scan tickets with Verdynt/OS have a rate. Their patients alone are used for rates.
//
// Reports are by whole season, and per-mountain counts are never published, because two reports that differ a
// little (a day, a region, one mountain joining) could otherwise be subtracted to reveal what the hiding protects.

const { rows, one } = require('../db');
const { addDays, seasonFor, dayRange } = require('./util');

const AGREEMENT_VERSION = '2026-10';
const MIN_CELL = 5;          // counts below this (and above 0) are hidden
const MIN_MOUNTAINS = 3;     // a slice of the network (a region, or "peers") needs at least this many mountains

// NSAA's reporting regions, plus Canada and elsewhere.
const REGIONS = [
  ['northeast', 'Northeast'], ['southeast', 'Southeast'], ['midwest', 'Midwest'], ['rocky_mountain', 'Rocky Mountain'],
  ['pacific_southwest', 'Pacific Southwest'], ['pacific_northwest', 'Pacific Northwest'], ['canada', 'Canada'], ['other', 'Elsewhere'],
];
const REGION_KEYS = REGIONS.map((r) => r[0]);

// ---------------------------------------------------------------- categories
// Each dimension: its title, its categories in display order, and how a patient is placed in one.
const NR = 'not_recorded';
const D = {
  activity: { title: 'Activity', cats: [['ski', 'Skiing'], ['snowboard', 'Snowboarding'], ['nordic_touring', 'Nordic or touring'], ['tubing', 'Tubing'], ['other_snow', 'Other snow sport'], ['non_skiing', 'Not on snow equipment'], ['other', 'Other'], [NR, 'Not recorded']] },
  ability: { title: 'Ability', cats: [['beginner', 'Beginner or novice'], ['intermediate', 'Intermediate'], ['advanced', 'Advanced'], ['expert', 'Expert'], [NR, 'Not recorded']] },
  age: { title: 'Age', cats: [['0_12', '12 and under'], ['13_17', '13 to 17'], ['18_24', '18 to 24'], ['25_34', '25 to 34'], ['35_44', '35 to 44'], ['45_54', '45 to 54'], ['55_64', '55 to 64'], ['65_up', '65 and over'], [NR, 'Not recorded']] },
  sex: { title: 'Sex', cats: [['female', 'Female'], ['male', 'Male'], ['other', 'Other'], [NR, 'Not recorded']] },
  helmet: { title: 'Helmet (on snow)', cats: [['yes', 'Wearing a helmet'], ['no', 'No helmet'], [NR, 'Not recorded']] },
  cause: { title: 'Cause', cats: [['fall', 'Fall'], ['collision', 'Collision with a person or object'], ['near_collision', 'Avoiding a collision'], ['struck', 'Struck by equipment'], ['equipment', 'Equipment or binding failure'], ['lift_loading', 'Lift: loading'], ['lift_unloading', 'Lift: unloading'], ['lift_other', 'Lift: other'], ['off_trail', 'Went off the trail'], ['non_skiing', 'Slip or other, not skiing'], [NR, 'Not recorded']] },
  location: { title: 'Where', cats: [['marked_run', 'Marked run'], ['terrain_park', 'Terrain park or pipe'], ['off_trail', 'Off trail, in bounds'], ['closed_oob', 'Closed or out of bounds'], ['lift', 'Lift'], ['premises', 'Buildings, decks and parking'], [NR, 'Not recorded']] },
  run: { title: 'Run rating', cats: [['easiest', 'Easiest'], ['more_difficult', 'More difficult'], ['most_difficult', 'Most difficult'], ['extreme', 'Extreme'], [NR, 'Not recorded or not a run']] },
  surface: { title: 'Snow surface', cats: [['groomed', 'Groomed'], ['moguls', 'Moguls'], ['powder', 'Powder'], ['variable', 'Variable'], ['granular', 'Granular'], ['hard', 'Hard'], [NR, 'Not recorded']] },
  light: { title: 'Light', cats: [['sharp', 'Sharp'], ['flat', 'Flat'], ['whiteout', 'Whiteout'], ['lights', 'Night lights'], ['dark', 'Dark'], [NR, 'Not recorded']] },
  weather: { title: 'Weather', cats: [['clear', 'Clear'], ['overcast', 'Overcast'], ['snowing', 'Snowing'], ['raining', 'Raining'], ['fog', 'Fog'], [NR, 'Not recorded']] },
  time: { title: 'Time of day', cats: [['before_10', 'Before 10:00'], ['10_12', '10:00 to 11:59'], ['12_14', '12:00 to 13:59'], ['14_16', '14:00 to 15:59'], ['after_16', '16:00 and later']] },
  month: { title: 'Month', cats: [] }, // filled from the period
  outcome: { title: 'Outcome', cats: [['treated_released', 'Treated and released'], ['transported_ambulance', 'Ambulance'], ['transported_private', 'Private vehicle to care'], ['referred', 'Referred to a doctor'], ['refused_care', 'Refused care'], ['other', 'Other'], [NR, 'Not recorded']] },
  to_aid: { title: 'Brought to first aid by', cats: [['walk_ski', 'Walked or skied'], ['toboggan', 'Toboggan'], ['snowmobile', 'Snowmobile'], ['helicopter', 'Helicopter'], ['download', 'Lift download'], ['on_hill', 'Treated on the hill'], ['other', 'Other'], [NR, 'Not recorded']] },
};
const DIMENSIONS = Object.keys(D);

const BODY = [['head_face', 'Head and face', ['head', 'face']], ['neck_back', 'Neck and back', ['neck', 'back']], ['shoulder_arm', 'Shoulder and arm', ['shoulder', 'arm', 'elbow']], ['wrist_hand', 'Wrist and hand', ['wrist_hand']], ['trunk', 'Chest, abdomen and pelvis', ['chest', 'abdomen', 'pelvis']], ['hip_thigh', 'Hip and thigh', ['hip', 'thigh']], ['knee', 'Knee', ['knee']], ['lower_leg', 'Lower leg, ankle and foot', ['lower_leg', 'ankle_foot']], ['multiple_other', 'Multiple or other', ['multiple', 'other']]];
const BODY_OF = Object.fromEntries(BODY.flatMap(([k, , parts]) => parts.map((p) => [p, k])));
const INJURY = [['fracture', 'Fracture'], ['dislocation', 'Dislocation'], ['sprain_strain', 'Sprain or strain'], ['laceration', 'Cut'], ['contusion', 'Bruise'], ['concussion', 'Concussion'], ['spinal', 'Spinal'], ['internal', 'Internal'], ['cold_injury', 'Cold injury'], ['other', 'Other']];
const MEDICAL_TYPES = new Set(['illness', 'cardiac']);

const EXCLUSIONS = [['staff', 'Staff and volunteers injured while working'], ['competition', 'Racing and race training'], ['medical', 'Medical calls (illness, cardiac, prior condition)'], ['no_injury', 'No injury found']];
const EXCLUSION_KEYS = EXCLUSIONS.map((e) => e[0]);

const parse = (v) => { if (!v) return {}; if (typeof v === 'object') return v; try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : {}; } catch (_) { return {}; } };
const pick = (form, key, col) => { const v = form[key]; return v === undefined || v === null || v === '' ? (col ?? null) : v; };

function activityOf(v) {
  return { alpine: 'ski', ski: 'ski', telemark: 'ski', snowboard: 'snowboard', nordic: 'nordic_touring', touring: 'nordic_touring', tubing: 'tubing', other_snow: 'other_snow', non_skiing: 'non_skiing', pedestrian: 'non_skiing', other: 'other' }[v] || NR;
}
const abilityOf = (v) => ({ beginner: 'beginner', novice: 'beginner', intermediate: 'intermediate', advanced: 'advanced', expert: 'expert' }[v] || NR);
const helmetOf = (v) => ({ owned: 'yes', rental: 'yes', yes: 'yes', none: 'no', no: 'no' }[v] || NR);
const sexOf = (v) => (['female', 'male', 'other'].includes(v) ? v : NR);
function ageOf(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return NR;
  const a = Number(n);
  if (a < 0 || a > 120) return NR;
  if (a <= 12) return '0_12'; if (a <= 17) return '13_17'; if (a <= 24) return '18_24'; if (a <= 34) return '25_34';
  if (a <= 44) return '35_44'; if (a <= 54) return '45_54'; if (a <= 64) return '55_64'; return '65_up';
}
function causeOf(collided, cause) {
  if (collided === 'yes') return 'collision';
  if (!cause) return NR;
  if (cause.startsWith('fall_')) return 'fall';
  if (cause === 'lift_fall_loading') return 'lift_loading';
  if (cause === 'lift_fall_unloading') return 'lift_unloading';
  if (cause.startsWith('lift_')) return 'lift_other';
  if (cause === 'near_collision') return 'near_collision';
  if (cause === 'hit_by_equipment') return 'struck';
  if (cause === 'equipment_failure' || cause === 'binding_pre_released') return 'equipment';
  if (cause === 'skied_off_trail') return 'off_trail';
  if (cause.startsWith('non_ski_')) return 'non_skiing';
  return NR;
}
function locationOf(where, involvement) {
  const m = { marked_run: 'marked_run', freestyle_terrain: 'terrain_park', terrain_rail_park: 'terrain_park', half_pipe: 'terrain_park', competition_terrain: 'terrain_park', off_trail: 'off_trail', out_of_bounds: 'closed_oob', closed_inbounds: 'closed_oob', lift_incident: 'lift', premises: 'premises' }[where];
  if (m) return m;
  return involvement === 'terrain_park_feature' ? 'terrain_park' : NR;
}
const oneOf = (v, dim) => (D[dim].cats.some((c) => c[0] === v) ? v : NR);
function timeOf(hour) {
  const h = Number(hour);
  if (h < 10) return 'before_10'; if (h < 12) return '10_12'; if (h < 14) return '12_14'; if (h < 16) return '14_16'; return 'after_16';
}

/**
 * Reduce one patient to categories. Nothing else from the record survives this function.
 * Returns { tenant, cats: {dimension: key}, excluded: [reasons], injuries: [[body, type]] }.
 */
function classify(r, injuries) {
  const pf = parse(r.pform);
  const cf = parse(r.cform);
  const activityRaw = pick(pf, 'activity', r.activity);
  const patientType = pick(pf, 'patient_type', null);
  const involvement = pick(pf, 'involvement', null);
  const cause = pick(pf, 'cause', null);
  const parts = pf.body_parts && typeof pf.body_parts === 'object' ? Object.keys(pf.body_parts) : [];
  const types = injuries.map((j) => j.injury_type);
  const disposition = r.disposition || null;

  const excluded = [];
  if (patientType === 'staff_work' || patientType === 'volunteer_work' || r.activity === 'staff') excluded.push('staff');
  if (involvement === 'competition' || involvement === 'training') excluded.push('competition');
  const onlyMedicalInjuries = types.length > 0 && types.every((t) => MEDICAL_TYPES.has(t));
  const medicalChart = parts.length > 0 && parts.every((p) => p === 'medical');
  if (cause === 'prior_medical' || onlyMedicalInjuries || medicalChart || (r.category === 'medical' && !types.some((t) => !MEDICAL_TYPES.has(t)))) excluded.push('medical');
  if (disposition === 'no_injury' || (parts.length > 0 && parts.every((p) => p === 'no_injury') && !types.length)) excluded.push('no_injury');

  const helmetApplies = ['ski', 'snowboard', 'nordic_touring', 'other_snow'].includes(activityOf(activityRaw));
  const cats = {
    activity: activityOf(activityRaw),
    ability: abilityOf(pick(pf, 'ability', r.ability)),
    age: ageOf(r.age),
    sex: sexOf(pick(pf, 'gender', r.sex)),
    helmet: helmetApplies ? helmetOf(pick(pf, 'helmet', r.helmet)) : null,
    cause: causeOf(pick(pf, 'collided', null), cause),
    location: locationOf(pick(cf, 'incident_location', null), involvement),
    run: oneOf(pick(cf, 'run_classification', null), 'run'),
    surface: oneOf(pick(cf, 'surface', null), 'surface'),
    light: oneOf(pick(cf, 'light', null), 'light'),
    weather: oneOf(pick(cf, 'weather', null), 'weather'),
    time: timeOf(r.hr),
    month: r.month,
    outcome: oneOf(disposition, 'outcome'),
    to_aid: oneOf(pick(pf, 'to_first_aid', null), 'to_aid'),
  };
  const inj = injuries.filter((j) => !MEDICAL_TYPES.has(j.injury_type)).map((j) => [BODY_OF[j.body_region] || 'multiple_other', INJURY.some((t) => t[0] === j.injury_type) ? j.injury_type : 'other']);
  return { tenant: Number(r.tenant_id), cats, excluded, injuries: inj };
}

// ---------------------------------------------------------------- reading
/**
 * The period: always a whole season ('2026-27', August to July), the current one by default. Free date ranges are not
 * offered: two reports a day apart could be subtracted to give one day's counts.
 */
function periodOf({ season } = {}, today, { fullMonths = false } = {}) {
  const s = season || seasonFor(today);
  if (!/^\d{4}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  if (Number(s.slice(5)) !== (y + 1) % 100) return null;
  const period = { from: `${y}-08-01`, to: `${y + 1}-07-31`, season: s };
  // The network report stops at the end of the last full month, so this week's download minus last week's does not
  // give one week's counts.
  if (fullMonths && today <= period.to) {
    const lastOfPrev = addDays(`${today.slice(0, 7)}-01`, -1);
    if (lastOfPrev < period.to) { period.to = lastOfPrev; period.partial = true; }
    if (period.to < period.from) period.empty = true;
  }
  return period;
}

/** Every patient in the period at these mountains, already reduced to categories. */
async function patientsOf(db, tenantIds, period) {
  if (!tenantIds.length) return [];
  // Only categorical fields are read. The two form columns are parsed for a handful of option keys and dropped.
  const list = await rows(db,
    `SELECT p.id, i.tenant_id, i.category, DATE_FORMAT(i.occurred_at, '%Y-%m') AS month, HOUR(i.occurred_at) AS hr,
            p.activity, p.ability, p.helmet, p.sex, p.disposition, p.form AS pform, i.form AS cform,
            COALESCE(p.age_years, TIMESTAMPDIFF(YEAR, p.date_of_birth, DATE(i.occurred_at))) AS age
       FROM incident_patients p
       JOIN incidents i ON i.id = p.incident_id AND i.tenant_id = p.tenant_id
      WHERE i.tenant_id IN (?) AND i.occurred_at >= ? AND i.occurred_at < ?
        AND i.report_state IN ('submitted', 'approved') AND p.voided_at IS NULL`,
    [tenantIds, `${period.from} 00:00:00`, `${addDays(period.to, 1)} 00:00:00`]);
  if (!list.length) return [];
  const byPatient = new Map();
  const ids = list.map((r) => r.id);
  for (let k = 0; k < ids.length; k += 5000) {
    const inj = await rows(db, 'SELECT patient_id, body_region, injury_type FROM incident_injuries WHERE tenant_id IN (?) AND patient_id IN (?) AND voided_at IS NULL', [tenantIds, ids.slice(k, k + 5000)]);
    for (const j of inj) { if (!byPatient.has(j.patient_id)) byPatient.set(j.patient_id, []); byPatient.get(j.patient_id).push(j); }
  }
  return list.map((r) => classify(r, byPatient.get(r.id) || []));
}

/**
 * Skier visits per mountain: each ticket's first accepted scan on a local day. Days are cut at local midnight using the
 * offset in force in mid-January, the heart of the season (in the weeks on the other side of a daylight-saving change,
 * a scan in the hour around midnight may land on the neighbouring day; lifts are not running then). Mountains with no
 * scans are left out.
 */
async function visitsOf(db, tenantIds, period) {
  const out = new Map();
  if (!tenantIds.length) return out;
  const tz = await rows(db, 'SELECT id, timezone FROM tenants WHERE id IN (?)', [tenantIds]);
  const mid = `${Number(period.from.slice(0, 4)) + 1}-01-15`;
  for (const t of tz) {
    const [start] = dayRange(t.timezone, period.from);
    const [, end] = dayRange(t.timezone, period.to);
    const [midStart] = dayRange(t.timezone, mid);
    const offsetMin = Math.round((Date.parse(`${mid}T00:00:00Z`) - Date.parse(`${midStart.replace(' ', 'T')}Z`)) / 60000);
    const r = await one(db,
      `SELECT COUNT(DISTINCT ticket_id, DATE(DATE_ADD(scanned_at, INTERVAL ? MINUTE))) AS n
         FROM scans WHERE tenant_id = ? AND result = 'ok' AND ticket_id IS NOT NULL AND scanned_at >= ? AND scanned_at < ?`,
      [offsetMin, t.id, start, end]);
    const n = Number(r.n);
    if (n > 0) out.set(Number(t.id), n);
  }
  return out;
}

// ---------------------------------------------------------------- counting and hiding small numbers
const hidden = (n) => n > 0 && n < MIN_CELL;

/**
 * Within one line of counts that sit under a known total: once anything is hidden, keep hiding the next smallest
 * count until at least two are hidden and together they come to 10 or more. Then neither "total minus the rest"
 * nor a small hidden sum pins a hidden count down. Returns true when it hid something.
 */
function hideMore(line) {
  let changed = false;
  for (;;) {
    const off = line.filter((c) => c.hidden);
    if (!off.length) break;
    if (off.length >= 2 && off.reduce((s, c) => s + c.n, 0) >= 2 * MIN_CELL) break;
    const next = line.filter((c) => !c.hidden && c.n > 0).sort((a, b) => a.n - b.n)[0];
    if (!next) break;
    next.hidden = true; changed = true;
  }
  return changed;
}

/** Hide counts from 1 to 4 in a list, and enough others that none can be worked out. */
function protectList(cells) {
  for (const c of cells) c.hidden = hidden(c.n);
  hideMore(cells);
  return cells;
}

const round1 = (v) => Math.round(v * 10) / 10;
const per1000 = (n, visits) => (visits > 0 ? Math.round((n / visits) * 100000) / 100 : null);
const roundVisits = (v) => (v ? Math.max(1000, Math.round(v / 1000) * 1000) : null);

/** Months of a period, as 'YYYY-MM', for the month dimension. */
function monthsOf(period) {
  const out = [];
  let [y, m] = period.from.split('-').map(Number);
  const [ty, tm] = period.to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m += 1; if (m > 12) { m = 1; y += 1; } }
  return out;
}
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Turn classified patients into the report. `mountains` = the mountains in it; `rated` = those with visits.
 * protect = false only for a mountain looking at its own numbers.
 *
 * Rates, when protected: the overall rate only when at least 3 mountains have visits and the mountains without
 * visits are none or at least 3 (otherwise "all patients minus rated patients" is one or two mountains' count). Rates
 * per category only when every mountain has visits, for the same reason. Visits are rounded to the nearest 1,000:
 * one mountain's skier visits are its own business.
 */
function summarize(patients, { period, mountains = 0, rated = new Set(), visits = 0, protect = true }) {
  const counted = patients.filter((p) => !p.excluded.length);
  const excluded = EXCLUSIONS.map(([key, label]) => ({ key, label, n: patients.filter((p) => p.excluded.includes(key)).length }));
  const ratedCount = counted.filter((p) => rated.has(p.tenant)).length;
  const unrated = Math.max(0, mountains - rated.size);
  const overallRate = !protect || (rated.size >= MIN_MOUNTAINS && (unrated === 0 || unrated >= MIN_MOUNTAINS));
  const cellRates = !protect || (rated.size >= MIN_MOUNTAINS && unrated === 0);

  const months = monthsOf(period).map((k) => [k, `${MONTH_NAMES[Number(k.slice(5)) - 1]} ${k.slice(0, 4)}`]);
  const breakdowns = {};
  for (const dim of DIMENSIONS) {
    const cats = dim === 'month' ? months : D[dim].cats;
    const pool = dim === 'helmet' ? counted.filter((p) => p.cats.helmet !== null) : counted;
    let cells = cats.map(([key, label]) => {
      const inCat = pool.filter((p) => p.cats[dim] === key);
      return { key, label, n: inCat.length, nr: inCat.filter((p) => rated.has(p.tenant)).length };
    });
    if (dim === 'month') cells = cells.filter((c) => c.n > 0);
    const total = pool.length;
    if (protect) { protectList(cells); if (hidden(total)) for (const c of cells) c.hidden = c.n > 0; } else for (const c of cells) c.hidden = false;
    const anyHidden = cells.some((c) => c.hidden);
    const recorded = cells.filter((c) => c.key !== NR).reduce((s, c) => s + c.n, 0);
    breakdowns[dim] = {
      title: D[dim].title,
      total: protect && hidden(total) ? null : total,
      // worked out from shown counts only: with a hidden count it would be a second total to subtract from
      recorded_pct: total && !anyHidden ? round1((recorded / total) * 100) : null,
      cells: cells.map((c) => ({
        key: c.key, label: c.label,
        n: c.hidden ? null : c.n,
        hidden: Boolean(c.hidden),
        pct: c.hidden || !total ? null : round1((c.n / total) * 100),
        per_1000: c.hidden || !cellRates || !c.nr ? null : per1000(c.nr, visits),
      })),
    };
  }

  // Injuries: one patient can have several. Type by body area. Only the grand total is published, not row or column
  // totals, so the whole table is one list under one total and is protected as such.
  const all = counted.flatMap((p) => p.injuries);
  const grid = BODY.map(([b]) => INJURY.map(([t]) => ({ n: all.filter(([bb, tt]) => bb === b && tt === t).length })));
  if (protect) protectList(grid.flat()); else for (const c of grid.flat()) c.hidden = false;
  const injuries = protect && all.length < MIN_CELL ? null : {
    total: all.length,
    body: BODY.map(([k, label]) => ({ key: k, label })),
    types: INJURY.map(([k, label]) => ({ key: k, label })),
    cells: grid.map((row) => row.map((c) => (c.hidden ? null : c.n))),
  };

  const tooFew = protect && counted.length > 0 && counted.length < MIN_CELL;
  if (protect) protectList(excluded);
  return {
    period,
    patients: tooFew ? null : counted.length,
    hidden: tooFew,
    visits: protect ? roundVisits(visits) : (visits || null),
    per_1000: !tooFew && overallRate && ratedCount ? per1000(ratedCount, visits) : null,
    excluded: excluded.map((e) => ({ key: e.key, label: e.label, n: e.hidden ? null : e.n, hidden: Boolean(e.hidden) })),
    breakdowns: tooFew ? {} : breakdowns,
    injuries: tooFew ? null : injuries,
  };
}

// ---------------------------------------------------------------- who shares
async function sharingOf(db, tenantId) {
  const s = await one(db, 'SELECT share, named, region, state, agreement_version, agreed_name, agreed_title, agreed_at, updated_at FROM safety_sharing WHERE tenant_id = ?', [tenantId]);
  return s ? { share: Boolean(s.share), named: Boolean(s.named), region: s.region, state: s.state, agreement_version: s.agreement_version, agreed_name: s.agreed_name, agreed_title: s.agreed_title, agreed_at: s.agreed_at, updated_at: s.updated_at }
    : { share: false, named: false, region: null, state: null, agreement_version: null, agreed_name: null, agreed_title: null, agreed_at: null, updated_at: null };
}

/** The mountains in the network now: sharing on, agreed to the current terms, active, not a demo. */
async function members(db, { region } = {}) {
  return rows(db,
    `SELECT t.id, t.name, s.named, s.region, s.state FROM safety_sharing s JOIN tenants t ON t.id = s.tenant_id
      WHERE s.share = 1 AND s.agreement_version = ? AND t.status = 'active' AND t.sandbox_expires_at IS NULL
        ${region ? 'AND s.region = ?' : ''} ORDER BY t.name`, region ? [AGREEMENT_VERSION, region] : [AGREEMENT_VERSION]);
}
const enough = (n) => n === 0 || n >= MIN_MOUNTAINS;

/** The regions shown on their own: 3 or more sharing mountains each, and the mountains outside them none or 3 or more. */
function regionPlan(list) {
  const big = REGIONS.map(([key]) => [key, list.filter((m) => m.region === key).length]).filter(([, n]) => n >= MIN_MOUNTAINS);
  const rest = list.length - big.reduce((s, [, n]) => s + n, 0);
  return new Set(enough(rest) ? big.map(([key]) => key) : []);
}

// ---------------------------------------------------------------- the two reports
/**
 * The network report for the platform: every sharing mountain, or one region. A region is reported on its own only
 * when it has at least 3 sharing mountains and the rest of the network is none or at least 3 (otherwise the network
 * report minus the region report is one or two mountains). Region rows follow the same rule.
 */
async function networkReport(db, { period, region = null }) {
  const everyone = await members(db);
  const shownRegions = regionPlan(everyone);
  const list = region ? everyone.filter((m) => m.region === region) : everyone;
  const ids = list.map((m) => Number(m.id));
  const base = { period, region, rules: { min_cell: MIN_CELL, min_mountains: MIN_MOUNTAINS, exclusions: EXCLUSION_KEYS }, mountains: { sharing: ids.length } };
  if (ids.length < MIN_MOUNTAINS) return { ...base, too_few_mountains: true };
  // One region on its own only when it is one of the regions the full report shows (checked across all regions at
  // once, so two region reports cannot be subtracted from the full one to leave one or two mountains).
  if (region && !shownRegions.has(region)) return { ...base, too_few_mountains: true, reason: 'rest_of_network' };
  if (period.empty) return { ...base, mountains: { sharing: ids.length }, empty_period: true };
  const [patients, visits] = await Promise.all([patientsOf(db, ids, period), visitsOf(db, ids, period)]);
  const rated = new Set(visits.keys());
  const totalVisits = [...visits.values()].reduce((s, n) => s + n, 0);
  const report = summarize(patients, { period, mountains: ids.length, rated, visits: totalVisits });

  let regions = [];
  if (!region) {
    const groups = REGIONS.map(([key, label]) => ({ key, label, ids: list.filter((m) => m.region === key).map((m) => Number(m.id)) })).filter((g) => g.ids.length);
    const counted = (g) => patients.filter((p) => g.ids.includes(p.tenant) && !p.excluded.length).length;
    const shown = groups.filter((g) => shownRegions.has(g.key)).map((g) => ({ ...g, n: counted(g) }));
    // The shown regions and the rest of the network (when there is a rest) are one list under the network total.
    const restIds = ids.filter((id) => !shown.some((g) => g.ids.includes(id)));
    const cells = [...shown, ...(restIds.length ? [{ key: '_rest', ids: restIds, n: counted({ ids: restIds }) }] : [])];
    protectList(cells);
    regions = groups.map((g) => {
      const c = cells.find((x) => x.key === g.key);
      if (!c) return { key: g.key, label: g.label, mountains: g.ids.length, too_few_mountains: true };
      const allRated = g.ids.every((id) => rated.has(id));
      const v = g.ids.reduce((s, id) => s + (visits.get(id) || 0), 0);
      return { key: g.key, label: g.label, mountains: g.ids.length, patients: c.hidden ? null : c.n, hidden: c.hidden, per_1000: allRated && !c.hidden && c.n ? per1000(c.n, v) : null };
    });
  }

  // Mountains that agreed to be named are listed by name only: a count per mountain could be subtracted from the
  // totals to give the anonymous mountains' counts.
  const named = list.filter((m) => m.named).map((m) => ({ name: m.name, state: m.state, region: (REGIONS.find((r) => r[0] === m.region) || [null, null])[1] }));

  return {
    ...base,
    mountains: { sharing: ids.length, with_visits: rated.size, named: named.length, anonymous: ids.length - named.length },
    ...report,
    regions,
    named,
  };
}

/**
 * The network as a sharing mountain sees it: shares of patients (whole percents) and a rounded total, no counts, so
 * that comparing what it saw before and after a mountain joined or left does not give that mountain's counts.
 */
function peerView(r) {
  const breakdowns = {};
  for (const [dim, b] of Object.entries(r.breakdowns || {})) {
    breakdowns[dim] = { title: b.title, cells: b.cells.map((c) => ({ key: c.key, label: c.label, hidden: c.hidden, pct: c.pct === null ? null : Math.round(c.pct) })) };
  }
  return { patients_about: r.patients === null ? null : Math.round(r.patients / 10) * 10, hidden: r.hidden, per_1000: r.per_1000 === null ? null : round1(r.per_1000), breakdowns };
}

/** A mountain's own numbers (unhidden: they are its own), and the network without it when it is in the network. */
async function benchmark(db, tenantId, { period }) {
  const sharing = await sharingOf(db, tenantId);
  const [mine, myVisits] = await Promise.all([patientsOf(db, [tenantId], period), visitsOf(db, [tenantId], period)]);
  const v = myVisits.get(tenantId) || 0;
  const own = summarize(mine, { period, mountains: 1, rated: v ? new Set([tenantId]) : new Set(), visits: v, protect: false });

  let peers = null; let alerts = [];
  const everyone = (await members(db)).map((m) => Number(m.id));
  if (everyone.includes(tenantId)) { // sharing, on the current terms, and a real mountain (not a demo)
    const others = everyone.filter((id) => id !== tenantId);
    if (others.length >= MIN_MOUNTAINS) {
      const [pts, vis] = await Promise.all([patientsOf(db, others, period), visitsOf(db, others, period)]);
      const pv = [...vis.values()].reduce((s, n) => s + n, 0);
      peers = { mountains: others.length, ...peerView(summarize(pts, { period, mountains: others.length, rated: new Set(vis.keys()), visits: pv })) };
      alerts = alertsOf(own, peers);
    } else peers = { mountains: others.length, too_few_mountains: true };
  }
  return { sharing, own, peers, alerts };
}

/**
 * Early warnings, for the mountain only: categories that make up a much bigger share of its patients than of the
 * network's (1.5 times or more). Shares, not rates, so a busy season does not flag everything at once; the overall
 * rate is compared on its own. Needs at least 5 of the mountain's own patients in the category, and a network share
 * that is shown (never one that is hidden).
 */
const WATCH = ['cause', 'location', 'run', 'activity', 'ability', 'age', 'time', 'light', 'surface'];
function alertsOf(own, peers) {
  if (!peers || !peers.breakdowns || !own.breakdowns) return [];
  const out = [];
  for (const dim of WATCH) {
    const mine = own.breakdowns[dim]; const theirs = peers.breakdowns[dim];
    if (!mine || !theirs) continue;
    for (const c of mine.cells) {
      if (c.key === NR || !c.n || c.n < MIN_CELL || c.pct === null) continue;
      const p = theirs.cells.find((x) => x.key === c.key);
      if (!p || p.hidden || !p.pct) continue;
      const ratio = c.pct / p.pct;
      if (ratio >= 1.5) out.push({ dimension: dim, title: D[dim].title, key: c.key, label: c.label, own_pct: c.pct, network_pct: p.pct, ratio: Math.round(ratio * 10) / 10, own_patients: c.n });
    }
  }
  return out.sort((x, y) => y.ratio - x.ratio).slice(0, 6);
}

// ---------------------------------------------------------------- download
/** The network report as rows for a spreadsheet: one row per category, with the hidden ones marked. */
function csvRows(r) {
  const out = [];
  const add = (section, category, n, hiddenFlag, pct, rate) => out.push({ section, category, patients: hiddenFlag ? 'not shown' : (n ?? ''), percent: pct ?? '', per_1000_visits: rate ?? '' });
  add('Period', `${r.period.from} to ${r.period.to}`, '', false, '', '');
  add('Mountains sharing', '', r.mountains.sharing, false, '', '');
  add('Mountains with skier visits', '', r.mountains.with_visits ?? '', false, '', '');
  add('Skier visits (to the nearest 1,000)', '', r.visits ?? '', false, '', '');
  add('Rule', `Counts from 1 to ${MIN_CELL - 1} are not shown, nor other counts in the same list where needed so that no hidden count can be worked out`, '', false, '', '');
  add('Patients counted', '', r.patients, r.hidden, '', r.per_1000);
  for (const e of r.excluded || []) add('Left out', e.label, e.n, e.hidden, '', '');
  for (const dim of Object.keys(r.breakdowns || {})) {
    const b = r.breakdowns[dim];
    for (const c of b.cells) add(b.title, c.label, c.n, c.hidden, c.pct, c.per_1000);
  }
  if (r.injuries) {
    r.injuries.body.forEach((b, i) => r.injuries.types.forEach((t, j) => {
      const n = r.injuries.cells[i][j];
      if (n !== 0) add('Injuries by body area and type', `${b.label}: ${t.label}`, n, n === null, '', '');
    }));
  }
  for (const g of r.regions || []) add('Region', g.too_few_mountains ? `${g.label} (not shown: too few mountains)` : g.label, g.too_few_mountains ? '' : g.patients, !g.too_few_mountains && g.patients === null, '', g.per_1000);
  for (const m of r.named || []) add('Named mountain', `${m.name}${m.state ? ` (${m.state})` : ''}`, '', false, '', '');
  return out;
}

module.exports = {
  AGREEMENT_VERSION, MIN_CELL, MIN_MOUNTAINS, REGIONS, REGION_KEYS, EXCLUSIONS, EXCLUSION_KEYS, DIMENSIONS,
  classify, periodOf, patientsOf, visitsOf, protectList, summarize, peerView, sharingOf, members, networkReport, benchmark, alertsOf, csvRows,
};
