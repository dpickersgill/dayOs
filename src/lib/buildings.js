'use strict';

// Buildings (muni release 1, the `buildings` add-on): the rules behind the life-safety calendar. A municipality keeps its
// own properties (borough hall, the garage, the library, pump houses, park restrooms and playgrounds) and must show that
// every required check happened: the custodian's monthly extinguisher and exit-light checks, and the vendors' yearly tests.
//
// How it is stored, on top of what Assets and fleet already has:
//   - A building is a `buildings` row tied to an asset_locations row (kind 'building'). Its rooms are locations inside that
//     one, named "Building: Room" (location names are unique across the municipality). Equipment in a building is an
//     ops_assets row whose location is the building or one of its rooms, so the asset register, QR labels and asset
//     pages all work as they do for everything else.
//   - The library (life_safety_tasks) is the list of recurring checks: each has who does it (staff or a vendor), how
//     often, the standard it follows (a reference line such as "NFPA 10", never the standard's text) and a checklist
//     (inspection_templates). It is seeded the first time Buildings is used, then the municipality's to change.
//   - Each check on each piece of equipment is an ordinary service plan (pm_tasks), linked in building_plans, so Work
//     orders lists it with the rest and its due date is worked out the same way: the last time it was done plus its
//     interval. Every check recorded here (a round, a vendor visit) is an asset inspection and a line in the plan's log.
//
// People decide; the app records. Nothing here certifies a building or says a system is safe: a failed check opens a
// work order for a person to act on, and the dates come from what people recorded.
const { pool, tx, rows, one } = require('../db');
const { todayIn, nowIn, addDays } = require('./util');
const CR = require('./checkrules');
const A = require('./assets');
const { KINDS } = require('./buildingkinds');

const TYPES = [['office', 'Office or borough hall'], ['police', 'Police'], ['garage', 'Garage or public works yard'], ['library', 'Library'], ['community', 'Community center'],
  ['pump_house', 'Pump house'], ['park', 'Park'], ['pool', 'Pool'], ['other', 'Other']].map(([value, label]) => ({ value, label }));
const TYPE_KEYS = TYPES.map((t) => t.value);

// The asset kinds a building's equipment can be: the new life-safety kinds plus generators, boilers and HVAC.
const EQUIPMENT_KINDS = [...KINDS.map((k) => k.value), 'generator', 'boiler', 'hvac'];

/** How often, in words. */
function everyText(days) {
  const d = Number(days);
  if (d === 31 || d === 30) return 'Monthly';
  if (d === 92 || d === 91 || d === 90) return 'Every 3 months';
  if (d === 183 || d === 182 || d === 184) return 'Every 6 months';
  if (d === 365 || d === 366) return 'Yearly';
  if (d % 7 === 0 && d <= 28) return d === 7 ? 'Weekly' : `Every ${d / 7} weeks`;
  return `Every ${d} days`;
}
const FREQUENCIES = [[31, 'Monthly'], [92, 'Every 3 months'], [183, 'Every 6 months'], [365, 'Yearly']].map(([days, label]) => ({ days, label }));

// ---------------------------------------------------------------- the library seeded the first time Buildings is used
// [code, name, kind, who, interval days, standard, certificate (the paper the visit renews, or null), checklist]
// A checklist step is [key, label] (pass or fail) or [key, label, { type: 'number' | 'date', unit, min, max, within_days }].
// Readings with no range are recorded as given: the tester or the crew decides whether they pass.
// When the assets workstream's choice steps arrive, the backflow device type (RPZ, double check, PVB) and the sprinkler
// control valve position (open, closed) become choices here instead of notes.
const LIBRARY = [
  ['ext_monthly', 'Fire extinguisher monthly check', 'fire_extinguisher', 'staff', 31, 'NFPA 10', null, [
    ['in_place', 'In its place, easy to see and reach'], ['pressure', 'Gauge in the green (or full by weight)'], ['pin', 'Pin and tamper seal in place'],
    ['damage', 'No damage, rust, leaks or blocked nozzle'], ['tag', 'Service tag is current'], ['sign', 'Sign or marker can be seen']]],
  ['ext_annual', 'Fire extinguisher annual maintenance', 'fire_extinguisher', 'vendor', 365, 'NFPA 10', null, [
    ['maintenance', 'Annual maintenance done and tag updated'], ['hydro_due', 'Next hydrostatic test due', { type: 'date' }]]],
  ['sprinkler_quarterly', 'Sprinkler system quarterly inspection', 'sprinkler', 'vendor', 92, 'NFPA 25', null, [
    ['gauges', 'Gauges read normal'], ['static_psi', 'Static pressure', { type: 'number', unit: 'psi' }], ['valves', 'Control valves open and secured'],
    ['alarm', 'Waterflow alarm device works'], ['fdc', 'Fire department connection clear and capped'], ['heads', 'Heads clean, not painted or blocked'], ['spares', 'Spare heads and wrench in the cabinet']]],
  ['sprinkler_annual', 'Sprinkler system annual test', 'sprinkler', 'vendor', 365, 'NFPA 25', null, [
    ['main_drain', 'Main drain test done'], ['residual_psi', 'Main drain residual pressure', { type: 'number', unit: 'psi' }], ['alarm_test', 'Waterflow alarm tested'], ['valves_operated', 'Control valves operated']]],
  ['alarm_annual', 'Fire alarm annual test', 'fire_alarm', 'vendor', 365, 'NFPA 72', null, [
    ['devices', 'Smoke and heat detectors and pull stations tested'], ['notification', 'Horns and strobes work'], ['panel', 'Panel shows no trouble'],
    ['batteries', 'Standby batteries tested'], ['monitoring', 'Signal reached the monitoring company']]],
  ['exit_monthly', 'Exit and emergency lights monthly test', 'exit_lights', 'staff', 31, 'NFPA 101', null, [
    ['lit', 'Exit signs lit'], ['test30', 'Emergency lights stay on for the 30-second test'], ['heads', 'Lamp heads aimed and not broken'], ['path', 'Exit path clear']]],
  ['exit_annual', 'Exit and emergency lights annual 90-minute test', 'exit_lights', 'staff', 365, 'NFPA 101', null, [
    ['test90', 'Emergency lights stay on for the full 90 minutes'], ['batteries', 'Failed batteries replaced']]],
  ['hood_semiannual', 'Kitchen hood suppression service', 'kitchen_hood', 'vendor', 183, 'NFPA 96 and NFPA 17A', null, [
    ['nozzles', 'Nozzles clean and capped'], ['links', 'Fusible links replaced'], ['pull', 'Manual pull station works'], ['gas', 'Gas shut-off works'],
    ['hood', 'Hood and filters clean'], ['tag', 'Service tag updated']]],
  ['elevator_semiannual', 'Elevator inspection', 'elevator', 'vendor', 183, '34 Pa. Code 405.7', 'Certificate of operation', [
    ['inspected', 'Inspected by a certified elevator inspector'], ['phone', 'Emergency phone works'], ['recall', 'Fire service recall works'],
    ['pit', 'Pit clean and dry'], ['posted', 'Certificate posted in the car']]],
  ['boiler_inspection', 'Boiler inspection', 'boiler', 'vendor', 365, 'PA Labor and Industry, boiler inspection', 'Certificate of operation', [
    ['inspected', 'Inspected by a commissioned boiler inspector'], ['safety_valve', 'Safety valve tested'], ['lwco', 'Low-water cutoff tested'],
    ['controls', 'Gauges and controls work'], ['posted', 'Certificate posted near the boiler']]],
  ['backflow_annual', 'Backflow preventer annual test', 'backflow', 'vendor', 365, 'Annual test by a certified tester', null, [
    ['check1', 'Check valve 1', { type: 'number', unit: 'psid' }], ['check2', 'Check valve 2', { type: 'number', unit: 'psid' }],
    ['relief', 'Relief valve opened at (reduced pressure devices)', { type: 'number', unit: 'psid' }], ['passed', 'The tester passed the device'], ['tag', 'Test tag on the device']]],
  ['generator_monthly', 'Emergency generator monthly exercise', 'generator', 'staff', 31, 'NFPA 110', null, [
    ['run_minutes', 'Run time under load', { type: 'number', unit: 'minutes', min: 30 }], ['load_pct', 'Load', { type: 'number', unit: '%' }],
    ['fuel_pct', 'Fuel level', { type: 'number', unit: '%' }], ['transfer', 'Transfer switch moved the load'], ['alarms', 'No alarms or warnings'], ['leaks', 'No leaks'], ['battery', 'Battery and charger normal']]],
  ['generator_annual', 'Emergency generator annual service', 'generator', 'vendor', 365, 'NFPA 110', null, [
    ['service', 'Oil, filters and coolant serviced'], ['batteries', 'Batteries tested'], ['load_test', 'Load test done where needed']]],
  ['playground_monthly', 'Playground monthly routine inspection', 'playground', 'staff', 31, 'CPSC Public Playground Safety Handbook', null, [
    ['surfacing', 'Surfacing in place under and around equipment'], ['surfacing_in', 'Surfacing depth at the shallowest spot', { type: 'number', unit: 'in' }],
    ['hardware', 'No loose, missing or worn hardware'], ['entrapment', 'No openings that could trap a head or neck'], ['edges', 'No sharp edges, points or sticking-out bolts'],
    ['pinch', 'No pinch, crush or shearing points'], ['trip', 'No tripping hazards (footings, roots, rocks)'], ['swings', 'Swing seats, chains and hangers not worn'],
    ['debris', 'No broken glass, trash or standing water'], ['signs', 'Signs can be read']]],
  ['playground_annual', 'Playground annual inspection', 'playground', 'vendor', 365, 'ASTM F1487, by a certified playground safety inspector', null, [
    ['inspected', 'Inspected by a certified playground safety inspector'], ['report', 'Written report received']]],
  ['hvac_seasonal', 'HVAC seasonal service', 'hvac', 'vendor', 183, null, null, [
    ['filters', 'Filters changed'], ['coils', 'Coils and drains clean'], ['belts', 'Belts and motors checked'], ['controls', 'Thermostats and controls work'], ['co', 'No carbon monoxide or gas smell at fired units']]],
  ['roof_annual', 'Roof walk', 'roof', 'staff', 365, null, null, [
    ['membrane', 'Roof surface: no splits, blisters or ponding'], ['drains', 'Drains, gutters and scuppers clear'], ['flashing', 'Flashing and edges secure'],
    ['equipment', 'Rooftop equipment secured'], ['inside', 'No stains or leaks inside']]],
];

const stepOf = ([key, label, rule]) => ({ key, label, type: (rule && rule.type) || 'pass', ...(rule && rule.unit ? { unit: rule.unit } : {}), ...(rule && rule.min != null ? { min: rule.min } : {}), ...(rule && rule.max != null ? { max: rule.max } : {}), ...(rule && rule.within_days != null ? { within_days: rule.within_days } : {}) });

const seeded = new Set(); // tenants whose library is known to be seeded (this server)

/**
 * The library, seeded once per municipality: the first time Buildings is used after it is turned on. Seeding is recorded
 * (building_settings.library_seeded_at), so a check a manager removed or renamed is never put back. Safe to call on
 * every request, and from two requests at once.
 */
async function ensureLibrary(tenantId) {
  const t = Number(tenantId);
  if (seeded.has(t)) return false;
  await pool.query('INSERT IGNORE INTO building_settings (tenant_id) VALUES (?)', [t]);
  const did = await tx(async (conn) => {
    const s = await one(conn, 'SELECT library_seeded_at FROM building_settings WHERE tenant_id = ? FOR UPDATE', [t]);
    if (s.library_seeded_at) return false;
    // The asset register's settings and starting checklists first, so its own checklists are not skipped because ours exist.
    await A.ensureSettings(conn, t);
    let sort = 10;
    for (const [code, name, kind, who, days, standard, certificate, steps] of LIBRARY) {
      let tpl = await one(conn, 'SELECT id FROM inspection_templates WHERE tenant_id = ? AND name = ?', [t, name]);
      if (!tpl) {
        const [r] = await conn.query('INSERT INTO inspection_templates (tenant_id, name, kinds, items) VALUES (?, ?, ?, ?)', [t, name, kind, JSON.stringify(steps.map(stepOf))]);
        tpl = { id: r.insertId };
      }
      await conn.query(`INSERT IGNORE INTO life_safety_tasks (tenant_id, code, name, kind, who, interval_days, standard, template_id, certificate, sort)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [t, code, name, kind, who, days, standard, tpl.id, certificate, sort]);
      sort += 10;
    }
    await conn.query('UPDATE building_settings SET library_seeded_at = ? WHERE tenant_id = ?', [nowIn((await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone), t]);
    return true;
  });
  seeded.add(t);
  if (did) await syncPlans(pool, t);
  return did;
}

// ---------------------------------------------------------------- where things are
/** Equipment in buildings: each asset with its building and room. Narrow with extra SQL (` AND b.id = ?`). */
const EQUIPMENT_SQL = `SELECT a.id, a.name, a.kind, a.asset_tag, a.status, a.critical, a.make_model, a.serial, a.notes, a.inspection_expires,
    b.id AS building_id, b.name AS building, IF(l.id = b.location_id, NULL, l.id) AS room_id, IF(l.id = b.location_id, NULL, l.name) AS room_full
  FROM ops_assets a
  JOIN asset_locations l ON l.tenant_id = a.tenant_id AND l.id = a.location_id
  JOIN buildings b ON b.tenant_id = a.tenant_id AND (b.location_id = l.id OR b.location_id = l.parent_id)
  WHERE a.tenant_id = ?`;
/** A room's location name ("Borough Hall: Boiler room") shown as the room alone. */
const roomName = (building, full) => {
  if (!full) return null;
  const pre = `${building}: `;
  return String(full).startsWith(pre) ? String(full).slice(pre.length) : String(full);
};
const roomLocationName = (building, room) => `${building}: ${room}`.slice(0, 100);
const shapeEquipment = (e) => ({ ...e, critical: Boolean(e.critical), room: roomName(e.building, e.room_full), room_full: undefined, inspection_expires: A.ymd(e.inspection_expires) });

/** Plans (one library check on one piece of equipment) with everything a calendar row needs. */
const PLAN_SQL = `SELECT p.pm_task_id AS plan_id, p.task_id, p.asset_id, t.name AS task, t.kind AS task_kind, t.who, t.standard, t.certificate, t.template_id, t.vendor_id, v.name AS vendor,
    m.interval_days, m.last_done_on, m.active, a.name AS asset, a.asset_tag, a.kind, a.status AS asset_status,
    b.id AS building_id, b.name AS building, IF(l.id = b.location_id, NULL, l.name) AS room_full
  FROM building_plans p
  JOIN pm_tasks m ON m.tenant_id = p.tenant_id AND m.id = p.pm_task_id
  JOIN life_safety_tasks t ON t.tenant_id = p.tenant_id AND t.id = p.task_id
  LEFT JOIN vendors v ON v.tenant_id = t.tenant_id AND v.id = t.vendor_id
  JOIN ops_assets a ON a.tenant_id = p.tenant_id AND a.id = p.asset_id
  JOIN asset_locations l ON l.tenant_id = a.tenant_id AND l.id = a.location_id
  JOIN buildings b ON b.tenant_id = a.tenant_id AND (b.location_id = l.id OR b.location_id = l.parent_id)
  WHERE p.tenant_id = ?`;

/**
 * Where a check stands on `today`: never (no record yet), overdue (its due date has passed), week (due in the next 7
 * days), month (in the next 30) or ok. The due date is the last time it was done plus its interval, the same rule as
 * every service plan (lib/ops.js pmStatus counts by days the same way).
 */
function planState(lastDoneOn, intervalDays, today) {
  const last = A.ymd(lastDoneOn);
  if (!last) return { due_on: null, state: 'never', days_left: null };
  const due = addDays(last, Number(intervalDays));
  const daysLeft = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  const state = daysLeft < 0 ? 'overdue' : daysLeft <= 7 ? 'week' : daysLeft <= 30 ? 'month' : 'ok';
  return { due_on: due, state, days_left: daysLeft };
}
const shapePlan = (p, today) => ({ ...p, last_done_on: A.ymd(p.last_done_on), active: Boolean(p.active), room: roomName(p.building, p.room_full), room_full: undefined, every: everyText(p.interval_days), ...planState(p.last_done_on, p.interval_days, today) });

async function plansOf(db, tenantId, today, { buildingId, vendorId, who, assetId, activeOnly = true } = {}) {
  const where = []; const params = [tenantId];
  if (activeOnly) where.push("m.active = 1 AND t.active = 1 AND a.status <> 'retired' AND b.active = 1");
  if (buildingId) { where.push('b.id = ?'); params.push(buildingId); }
  if (vendorId) { where.push('t.vendor_id = ?'); params.push(vendorId); }
  if (who) { where.push('t.who = ?'); params.push(who); }
  if (assetId) { where.push('a.id = ?'); params.push(assetId); }
  const list = await rows(db, `${PLAN_SQL}${where.length ? ` AND ${where.join(' AND ')}` : ''} ORDER BY b.name, t.sort, t.name, a.name`, params);
  return list.map((p) => shapePlan(p, today));
}

/**
 * Makes the service plans that are missing: one for every active library check on every piece of equipment of its kind
 * in a building. Plans for checks that were turned off, or for equipment retired or moved out of every building, are
 * paused (kept, with their history). Returns how many were made.
 */
async function syncPlans(db, tenantId) {
  const t = Number(tenantId);
  const tasks = await rows(db, 'SELECT t.*, i.items FROM life_safety_tasks t LEFT JOIN inspection_templates i ON i.tenant_id = t.tenant_id AND i.id = t.template_id WHERE t.tenant_id = ? AND t.active = 1', [t]);
  const equipment = await rows(db, `${EQUIPMENT_SQL} AND a.status <> 'retired' AND b.active = 1`, [t]);
  let made = 0;
  for (const task of tasks) {
    const checklist = task.items ? JSON.parse(task.items).map((s) => s.label).join('\n').slice(0, 2000) : null;
    for (const e of equipment.filter((x) => x.kind === task.kind)) {
      const have = await one(db, 'SELECT pm_task_id FROM building_plans WHERE tenant_id = ? AND task_id = ? AND asset_id = ?', [t, task.id, e.id]);
      if (have) { await db.query('UPDATE pm_tasks SET active = 1 WHERE tenant_id = ? AND id = ? AND active = 0', [t, have.pm_task_id]); continue; }
      await tx(async (conn) => {
        const [r] = await conn.query('INSERT INTO pm_tasks (tenant_id, name, asset_id, interval_days, checklist, notes) VALUES (?, ?, ?, ?, ?, ?)',
          [t, task.name.slice(0, 150), e.id, task.interval_days, checklist, task.standard ? `Standard: ${task.standard}` : null]);
        await conn.query('INSERT INTO building_plans (tenant_id, pm_task_id, task_id, asset_id) VALUES (?, ?, ?, ?)', [t, r.insertId, task.id, e.id]);
      });
      made += 1;
    }
  }
  // Pause what no longer applies.
  await db.query(`UPDATE pm_tasks m JOIN building_plans p ON p.tenant_id = m.tenant_id AND p.pm_task_id = m.id
      JOIN life_safety_tasks t ON t.tenant_id = p.tenant_id AND t.id = p.task_id
      JOIN ops_assets a ON a.tenant_id = p.tenant_id AND a.id = p.asset_id
    SET m.active = 0
    WHERE m.tenant_id = ? AND m.active = 1 AND (t.active = 0 OR a.status = 'retired' OR a.kind <> t.kind OR NOT EXISTS (
      SELECT 1 FROM asset_locations l JOIN buildings b ON b.tenant_id = l.tenant_id AND b.active = 1 AND (b.location_id = l.id OR b.location_id = l.parent_id)
      WHERE l.tenant_id = a.tenant_id AND l.id = a.location_id))`, [t]);
  return made;
}

// ---------------------------------------------------------------- the year grid
const monthOf = (d) => Number(String(d).slice(5, 7));
const yearOf = (d) => Number(String(d).slice(0, 4));
const RANK = { missed: 5, overdue: 4, late: 3, due: 2, done: 1, none: 0 };

/**
 * One plan's twelve months in a year: done (on time), late (done after its due date), missed (a due date passed with
 * nothing done that month), overdue (due earlier this month, still not done), due (coming up) or none. `log` is every
 * date the plan was done, any year. A plan with no record has every month none (the calendar lists it as no record yet).
 */
function yearCells(log, intervalDays, year, today) {
  const cells = Array.from({ length: 12 }, () => 'none');
  const set = (d, s) => { if (yearOf(d) !== year) return; const i = monthOf(d) - 1; if (RANK[s] > RANK[cells[i]]) cells[i] = s; };
  const done = [...new Set(log.map(A.ymd).filter(Boolean))].sort();
  const I = Number(intervalDays);
  let prev = null;
  for (const d of done) {
    if (prev) {
      let due = addDays(prev, I);
      const late = d > due;
      while (due < d && due.slice(0, 7) !== d.slice(0, 7)) { set(due, 'missed'); due = addDays(due, I); }
      set(d, late ? 'late' : 'done');
    } else set(d, 'done');
    prev = d;
  }
  if (prev) {
    const end = `${year}-12-31`;
    let due = addDays(prev, I);
    for (let n = 0; due <= end && n < 400; n += 1, due = addDays(due, I)) {
      if (due < today) set(due, due.slice(0, 7) === today.slice(0, 7) ? 'overdue' : 'missed');
      else set(due, 'due');
    }
  }
  return cells;
}

// ---------------------------------------------------------------- recording a check
const who = async (conn, req) => (await one(conn, "SELECT COALESCE(NULLIF(CONCAT(p.first_name, ' ', p.last_name), ' '), u.email, u.username) AS n FROM users u LEFT JOIN people p ON p.tenant_id = u.tenant_id AND p.id = u.person_id WHERE u.tenant_id = ? AND u.id = ?", [req.auth.tenantId, req.auth.userId]) || {}).n || null;
const tzOf = async (conn, tenantId) => (await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;

/** A plan with its library check, checklist, equipment and building, locked for the change. */
async function planFor(conn, tenantId, planId) {
  const p = await one(conn, `${PLAN_SQL} AND p.pm_task_id = ?`, [tenantId, planId]);
  if (!p) return null;
  const tpl = p.template_id ? await one(conn, 'SELECT id, name, items FROM inspection_templates WHERE tenant_id = ? AND id = ?', [tenantId, p.template_id]) : null;
  return { ...p, room: roomName(p.building, p.room_full), steps: tpl ? JSON.parse(tpl.items) : [], template_name: tpl ? tpl.name : p.task };
}

/**
 * The checklist answers for one check. Full answers are checked against the checklist (a reading outside its range fails
 * by itself). Without them: pass passes every pass-or-fail step and leaves readings unrecorded; fail fails the steps named
 * in failedKeys, or the check as a whole when none are named. Throws Error with a plain message.
 */
function itemsFor(steps, { answers, result, failedKeys = [], note }, today) {
  if (answers && answers.length) return CR.evaluateAll(steps, answers, today);
  if (result === 'fail' && !note) throw new Error('Say what is wrong');
  const failed = new Set(failedKeys);
  if ([...failed].some((k) => !steps.some((s) => s.key === k))) throw new Error('An answer is for an item that is not on this checklist');
  const items = steps.map((s) => {
    const type = s.type || 'pass';
    if (failed.has(s.key)) return { key: s.key, label: s.label, type, result: 'fail', value: null, note };
    if (type !== 'pass' || result === 'na') return { key: s.key, label: s.label, type, result: 'na', value: null, note: null };
    return { key: s.key, label: s.label, type, result: 'pass', note: null };
  });
  if (result === 'fail' && !failed.size) items.push({ key: 'overall', label: 'Overall', type: 'pass', result: 'fail', note });
  return items;
}

/** Marks a plan done on a date (never moving its last-done date backward) and keeps the date in its log. */
async function markDone(conn, req, planId, on, note) {
  await conn.query('INSERT INTO pm_log (tenant_id, pm_task_id, done_on, user_id, note) VALUES (?, ?, ?, ?, ?)', [req.auth.tenantId, planId, on, req.auth.userId, note ? String(note).slice(0, 255) : null]);
  await conn.query('UPDATE pm_tasks SET last_done_on = IF(last_done_on IS NULL OR last_done_on < ?, ?, last_done_on) WHERE tenant_id = ? AND id = ?', [on, on, req.auth.tenantId, planId]);
}

/**
 * A deficiency: something found wrong, with the work order that fixes it. Opens the work order (an inspection work order
 * on the equipment, at the building and room), flags the equipment as needing service, and records the deficiency.
 */
async function openDeficiency(conn, req, { buildingId, building, room, asset, description, foundOn, source, visitId = null, roundId = null, inspectionId = null, priority, title }) {
  const maintenance = require('../routes/maintenance');
  const woId = await maintenance.createOrder(conn, req, {
    title: String(title || `${building}: ${description}`).slice(0, 150), description: String(description).slice(0, 5000),
    priority: priority || (asset && asset.critical ? 'urgent' : 'high'), asset_id: asset ? asset.id : null, location: [building, room].filter(Boolean).join(', ').slice(0, 120),
  }, 'inspection');
  if (asset) await conn.query("UPDATE ops_assets SET status = 'needs_service' WHERE tenant_id = ? AND id = ? AND status = 'in_service'", [req.auth.tenantId, asset.id]);
  const [r] = await conn.query(`INSERT INTO building_deficiencies (tenant_id, building_id, asset_id, description, found_on, source, visit_id, round_id, inspection_id, work_order_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [req.auth.tenantId, buildingId, asset ? asset.id : null, String(description).slice(0, 500), foundOn, source, visitId, roundId, inspectionId, woId]);
  return { id: r.insertId, work_order_id: woId };
}

/**
 * Records one check of one plan: an asset inspection with the checklist answers, the plan marked done (unless the item
 * was not applicable or could not be checked), and a work order and deficiency for a failure. Inside the caller's
 * transaction. Returns { inspection_id, result, work_order_id, deficiency_id }.
 */
async function recordCheck(conn, req, plan, { answers, result, failedKeys, note, on, at, inspector, source, visitId = null, roundId = null, missing = false }) {
  const t = req.auth.tenantId;
  const today = todayIn(await tzOf(conn, t));
  let items;
  if (missing) items = [{ key: 'present', label: 'In its place', type: 'pass', result: 'fail', note: note || 'Not found in its place' }];
  else {
    try { items = itemsFor(plan.steps, { answers, result, failedKeys, note }, on || today); } catch (e) { throw require('./errors').bad(e.message); }
  }
  const failed = items.filter((i) => i.result === 'fail');
  // Not applicable this time (a vendor visit that did not cover it after all): nothing is recorded and the plan stays due.
  if (!failed.length && items.every((i) => i.result === 'na')) return { inspection_id: null, result: 'na', work_order_id: null, deficiency_id: null };
  const outcome = failed.length ? 'fail' : 'pass';
  const asset = await one(conn, 'SELECT id, name, critical FROM ops_assets WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, plan.asset_id]);
  const [r] = await conn.query('INSERT INTO asset_inspections (tenant_id, asset_id, template_id, template_name, result, items, inspector, note, user_id, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [t, plan.asset_id, plan.template_id || null, plan.template_name || plan.task, outcome, JSON.stringify(items), inspector ? String(inspector).slice(0, 100) : null, note ? String(note).slice(0, 500) : null, req.auth.userId, at]);
  const inspectionId = r.insertId;
  let woId = null; let defId = null;
  if (failed.length) {
    const what = missing ? `Missing: ${asset.name}` : `${plan.task} failed: ${asset.name}`;
    const description = missing ? `${asset.name} (${plan.asset_tag || 'no tag'}) was not found in its place on the ${plan.task.toLowerCase()}.${note ? ` ${note}` : ''}`
      : failed.map((i) => `${i.label}${i.value != null ? ` (${i.value}${i.unit ? ` ${i.unit}` : ''})` : ''}: ${i.note || 'failed'}`).join('\n');
    const d = await openDeficiency(conn, req, { buildingId: plan.building_id, building: plan.building, room: plan.room, asset, description, foundOn: on || today, source, visitId, roundId, inspectionId, title: what });
    woId = d.work_order_id; defId = d.id;
    await conn.query('UPDATE asset_inspections SET work_order_id = ? WHERE tenant_id = ? AND id = ?', [woId, t, inspectionId]);
  }
  // The check happened (passed or failed) unless the item was missing or not applicable this time.
  if (!missing) await markDone(conn, req, plan.plan_id, on || today, source === 'visit' ? `Vendor visit ${visitId}` : source === 'round' ? `Round ${roundId}` : null);
  return { inspection_id: inspectionId, result: missing ? 'missing' : outcome, work_order_id: woId, deficiency_id: defId };
}

// ---------------------------------------------------------------- certificates
/** A certificate's state: expired, soon (within 30 days), watch (within 60) or ok. */
function certState(expiresOn, today) {
  const e = A.ymd(expiresOn);
  const daysLeft = Math.round((Date.parse(`${e}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  return { expires_on: e, days_left: daysLeft, state: daysLeft < 0 ? 'expired' : daysLeft <= 30 ? 'soon' : daysLeft <= 60 ? 'watch' : 'ok' };
}
/** The certificates on file now: the latest one of each name on each piece of equipment. */
const CURRENT_CERTS_SQL = `SELECT c.id, c.asset_id, c.name, c.number, c.issued_on, c.expires_on, c.document_id, c.visit_id, a.name AS asset, a.asset_tag, a.kind,
    b.id AS building_id, b.name AS building, d.title AS document, d.file_name
  FROM building_certificates c
  JOIN ops_assets a ON a.tenant_id = c.tenant_id AND a.id = c.asset_id
  JOIN asset_locations l ON l.tenant_id = a.tenant_id AND l.id = a.location_id
  JOIN buildings b ON b.tenant_id = a.tenant_id AND (b.location_id = l.id OR b.location_id = l.parent_id)
  LEFT JOIN documents d ON d.tenant_id = c.tenant_id AND d.id = c.document_id
  WHERE c.tenant_id = ? AND a.status <> 'retired' AND NOT EXISTS (
    SELECT 1 FROM building_certificates n WHERE n.tenant_id = c.tenant_id AND n.asset_id = c.asset_id AND n.name = c.name AND (n.expires_on > c.expires_on OR (n.expires_on = c.expires_on AND n.id > c.id)))`;
async function currentCerts(db, tenantId, today, { buildingId } = {}) {
  const list = await rows(db, `${CURRENT_CERTS_SQL}${buildingId ? ' AND b.id = ?' : ''} ORDER BY c.expires_on, a.name`, buildingId ? [tenantId, buildingId] : [tenantId]);
  return list.map((c) => ({ ...c, issued_on: A.ymd(c.issued_on), ...certState(c.expires_on, today) }));
}

/** Records a certificate and keeps the asset register's inspection date in step with the newest one. */
async function addCertificate(conn, req, { assetId, name, number, issuedOn, expiresOn, documentId = null, visitId = null }) {
  const [r] = await conn.query('INSERT INTO building_certificates (tenant_id, asset_id, name, number, issued_on, expires_on, document_id, visit_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [req.auth.tenantId, assetId, String(name).slice(0, 80), number || null, issuedOn || null, expiresOn, documentId, visitId, req.auth.userId]);
  await conn.query('UPDATE ops_assets SET inspection_expires = (SELECT MAX(expires_on) FROM building_certificates WHERE tenant_id = ? AND asset_id = ?) WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, assetId, req.auth.tenantId, assetId]);
  return r.insertId;
}

// ---------------------------------------------------------------- certificate reminders (the daily job)
const THRESHOLDS = [60, 30, 7, 0]; // 0: the day it expires or after
const THREAD_NAME = 'Building certificates';
const longDay = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${String(d).slice(0, 10)}T12:00:00Z`));

/** The owners and managers. */
const managers = async (db, tenantId) => (await rows(db, "SELECT id FROM users WHERE tenant_id = ? AND active = 1 AND role IN ('owner','manager')", [tenantId])).map((u) => Number(u.id));

/** The managers' "Building certificates" Inbox conversation, made the first time and kept in step with who manages. */
async function certThread(conn, tenantId) {
  await conn.query('INSERT IGNORE INTO building_settings (tenant_id) VALUES (?)', [tenantId]);
  const ids = await managers(conn, tenantId);
  if (!ids.length) return null;
  let threadId = (await one(conn, 'SELECT thread_id FROM building_settings WHERE tenant_id = ? FOR UPDATE', [tenantId])).thread_id;
  if (threadId && !(await one(conn, 'SELECT id FROM chat_threads WHERE tenant_id = ? AND id = ?', [tenantId, threadId]))) threadId = null;
  if (!threadId) {
    const [r] = await conn.query("INSERT INTO chat_threads (tenant_id, kind, name, created_by) VALUES (?, 'group', ?, ?)", [tenantId, THREAD_NAME, ids[0]]);
    threadId = r.insertId;
    await conn.query('UPDATE building_settings SET thread_id = ? WHERE tenant_id = ?', [threadId, tenantId]);
  }
  const { top } = await one(conn, 'SELECT COALESCE(MAX(id), 0) AS top FROM chat_messages WHERE tenant_id = ? AND thread_id = ?', [tenantId, threadId]);
  const current = new Set((await rows(conn, 'SELECT user_id FROM chat_members WHERE tenant_id = ? AND thread_id = ? AND left_at IS NULL', [tenantId, threadId])).map((r) => Number(r.user_id)));
  for (const u of ids) {
    if (current.has(u)) continue;
    await conn.query(`INSERT INTO chat_members (thread_id, tenant_id, user_id, visible_from_id, last_read_id) VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE left_at = NULL, visible_from_id = VALUES(visible_from_id), last_read_id = VALUES(last_read_id)`, [threadId, tenantId, u, top, top]);
  }
  for (const u of current) if (!ids.includes(u)) await conn.query('UPDATE chat_members SET left_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND thread_id = ? AND user_id = ?', [tenantId, threadId, u]);
  return { threadId, ids };
}

/**
 * The daily job: a certificate of operation (elevator, boiler) coming up for renewal is announced to the owners and
 * managers 60, 30 and 7 days ahead, and once more when it has run out: a message in their "Building certificates" Inbox
 * conversation (with a link to the equipment) and a phone alert. Each one goes once: claimed in building_cert_reminders
 * before it is sent. A certificate first seen inside a window (added 20 days before it runs out) gets that window's
 * reminder only; the earlier ones are marked skipped. A certificate replaced by a newer one is no longer reminded about.
 * opts.today: a YYYY-MM-DD to act as today (tests); opts.tenantId: one municipality only (tests).
 */
async function remindAll(opts = {}) {
  const M = require('./modules');
  const tenants = await rows(pool, `SELECT DISTINCT t.id, t.timezone FROM tenants t JOIN building_certificates c ON c.tenant_id = t.id
    WHERE t.status = 'active' AND t.org_type = 'municipality'${opts.tenantId ? ' AND t.id = ?' : ''}`, opts.tenantId ? [opts.tenantId] : []);
  const out = { sent: 0, skipped: 0, tenants: 0 };
  for (const tn of tenants) {
    try {
      if (!(await M.enabledKeys(tn.id)).includes('buildings')) continue;
      out.tenants += 1;
      const today = opts.today || todayIn(tn.timezone);
      const certs = (await currentCerts(pool, tn.id, today)).filter((c) => c.days_left <= 60);
      for (const c of certs) {
        const window = c.days_left < 0 ? 0 : THRESHOLDS.filter((d) => d > 0 && c.days_left <= d).pop();
        // Claim this window; the wider windows not yet sent are marked skipped, so a late start never sends three at once.
        const [claim] = await pool.query("INSERT IGNORE INTO building_cert_reminders (tenant_id, certificate_id, days, state) VALUES (?, ?, ?, 'sent')", [tn.id, c.id, window]);
        for (const d of THRESHOLDS.filter((x) => x > window || (window === 0 && x > 0))) {
          const [s] = await pool.query("INSERT IGNORE INTO building_cert_reminders (tenant_id, certificate_id, days, state) VALUES (?, ?, ?, 'skipped')", [tn.id, c.id, d]);
          out.skipped += s.affectedRows;
        }
        if (!claim.affectedRows) continue;
        const text = c.days_left < 0
          ? `The ${c.name.toLowerCase()} for ${c.asset} at ${c.building} expired on ${longDay(c.expires_on)}. Book the inspection, then add the new certificate in Buildings.`
          : `The ${c.name.toLowerCase()} for ${c.asset} at ${c.building} runs out on ${longDay(c.expires_on)}, in ${c.days_left} day${c.days_left === 1 ? '' : 's'}. Book the inspection if it is not booked yet.`;
        const sent = await tx(async (conn) => {
          const th = await certThread(conn, tn.id);
          if (!th) return null;
          await conn.query('INSERT INTO chat_messages (tenant_id, thread_id, user_id, body, refs) VALUES (?, ?, NULL, ?, ?)', [tn.id, th.threadId, text, JSON.stringify([{ type: 'asset', id: c.asset_id }])]);
          await conn.query('UPDATE chat_threads SET last_message_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ?', [tn.id, th.threadId]);
          return th;
        });
        if (sent) await require('./push').notifyUsers(tn.id, sent.ids, { title: c.days_left < 0 ? 'Certificate expired' : 'Certificate runs out soon', body: text.slice(0, 180), url: '#/buildings?tab=certificates', tag: `bcert-${c.id}-${window}` }).catch(() => 0);
        out.sent += 1;
      }
    } catch (err) {
      require('./jobs').logFailure({ job: 'building_cert_reminders', tenant: tn.id, message: err.message });
    }
  }
  return out;
}

// ---------------------------------------------------------------- files in Documents
const CATEGORY = 'Building certificates and reports';
/** The Documents category for vendor reports and certificates, made the first time (crew and front desk can read it). */
async function docCategory(conn, tenantId) {
  await conn.query('INSERT IGNORE INTO building_settings (tenant_id) VALUES (?)', [tenantId]);
  const s = await one(conn, 'SELECT doc_category_id FROM building_settings WHERE tenant_id = ? FOR UPDATE', [tenantId]);
  if (s.doc_category_id && await one(conn, 'SELECT id FROM doc_categories WHERE tenant_id = ? AND id = ?', [tenantId, s.doc_category_id])) return s.doc_category_id;
  let c = await one(conn, 'SELECT id FROM doc_categories WHERE tenant_id = ? AND name = ?', [tenantId, CATEGORY]);
  if (!c) {
    const [r] = await conn.query('INSERT INTO doc_categories (tenant_id, name, description, sort_order) VALUES (?, ?, ?, ?)', [tenantId, CATEGORY, 'Vendor inspection reports, test results and certificates of operation, filed from Buildings.', 50]);
    c = { id: r.insertId };
    for (const role of ['staff', 'counter']) await conn.query('INSERT IGNORE INTO doc_category_roles (tenant_id, category_id, role, can_add) VALUES (?, ?, ?, 0)', [tenantId, c.id, role]);
  }
  await conn.query('UPDATE building_settings SET doc_category_id = ? WHERE tenant_id = ?', [c.id, tenantId]);
  return c.id;
}

module.exports = {
  TYPES, TYPE_KEYS, EQUIPMENT_KINDS, FREQUENCIES, LIBRARY, everyText, ensureLibrary, syncPlans, EQUIPMENT_SQL, PLAN_SQL, roomName, roomLocationName, shapeEquipment,
  planState, plansOf, yearCells, planFor, recordCheck, markDone, openDeficiency, who, tzOf, certState, currentCerts, addCertificate, remindAll, docCategory, managers,
  THREAD_NAME, CATEGORY, RANK, _seeded: seeded,
};
