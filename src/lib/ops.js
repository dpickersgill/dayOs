'use strict';

// Shared pieces of mountain operations: the lists the screens draw from, the standard lift inspection, when a recurring
// job is due, and how a lift's status changes are written to the downtime log.
const { one } = require('../db');
const { nowIn } = require('./util');

// [value, label, category]. The category groups the register: fleet, lifts, snowmaking, facilities, equipment.
const ASSET_KINDS = [
  ['groomer', 'Snow groomer', 'fleet'], ['snowmobile', 'Snowmobile', 'fleet'], ['utv', 'UTV or side-by-side', 'fleet'], ['truck', 'Truck or vehicle', 'fleet'],
  ['bus', 'Shuttle or bus', 'fleet'], ['golf_cart', 'Golf cart', 'fleet'], ['boat', 'Boat or watercraft', 'fleet'], ['loader', 'Loader, excavator or heavy equipment', 'fleet'], ['mower', 'Mower or turf equipment', 'fleet'],
  ['lift_component', 'Lift or lift part (drive, gearbox, motor)', 'lift'],
  ['snow_gun', 'Snow gun or lance', 'snowmaking'], ['pump', 'Pump or compressor', 'snowmaking'], ['generator', 'Generator', 'equipment'],
  ['hvac', 'Heating, cooling or ventilation', 'facility'], ['boiler', 'Boiler or water heater', 'facility'], ['kitchen', 'Kitchen equipment', 'facility'],
  ['pool', 'Pool, spa or water feature', 'facility'], ['electrical', 'Electrical or fire system', 'facility'], ['building', 'Building or system', 'facility'],
  ['tool', 'Tool or shop equipment', 'equipment'], ['other', 'Other', 'other'],
].map(([value, label, category]) => ({ value, label, category }));
const CATEGORY_OF = Object.fromEntries(ASSET_KINDS.map((k) => [k.value, k.category]));
const ASSET_KIND_KEYS = ASSET_KINDS.map((k) => k.value);

const SURFACES = [
  ['packed_powder', 'Packed powder'], ['powder', 'Powder'], ['machine_groomed', 'Machine groomed'], ['loose_granular', 'Loose granular'],
  ['granular', 'Granular'], ['frozen_granular', 'Frozen granular'], ['wet', 'Wet or spring snow'], ['variable', 'Variable'], ['ice', 'Ice'], ['man_made', 'Man-made snow'],
].map(([value, label]) => ({ value, label }));
const SURFACE_KEYS = SURFACES.map((s) => s.value);

const DOWNTIME_REASONS = [
  ['wind', 'Wind'], ['mechanical', 'Mechanical'], ['electrical', 'Electrical or power'], ['weather', 'Other weather'], ['rescue', 'Evacuation or rescue'],
  ['staffing', 'Staffing'], ['inspection', 'Inspection'], ['scheduled', 'Scheduled maintenance'], ['other', 'Other'],
].map(([value, label]) => ({ value, label }));

const DEPARTMENTS = [['general', 'General'], ['grooming', 'Grooming'], ['lifts', 'Lifts'], ['snowmaking', 'Snowmaking'], ['maintenance', 'Maintenance'], ['park', 'Terrain park']]
  .map(([value, label]) => ({ value, label }));

/** The standard pre-opening lift inspection. Each mountain's own lift rules come first; this is a starting list. */
const LIFT_CHECKLIST = [
  ['terminals', 'Terminals clear of snow and ice'],
  ['loading', 'Loading and unloading areas, gates and signs'],
  ['estop', 'Emergency stops tested at the terminals'],
  ['restraints', 'Chairs, restraint bars and seats'],
  ['rope', 'Haul rope and grips, visual check'],
  ['sheaves', 'Bullwheels, sheaves and towers'],
  ['drive', 'Drive, gearbox and brakes, no leaks or noise'],
  ['aux', 'Auxiliary drive ready'],
  ['comms', 'Radios and phones working at every station'],
  ['runtest', 'Empty run-through, listening and watching'],
].map(([key, label]) => ({ key, label }));

/**
 * When a recurring job is next due, and how close it is.
 * `asset` is the machine (or null) so hour and mile based jobs can compare against its meters.
 * Returns { due_on, hours_left, miles_left, state: 'ok' | 'soon' | 'overdue' | 'never' }.
 */
function pmStatus(task, asset, today) {
  const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
  const last = ymd(task.last_done_on);
  let dueOn = null; let hoursLeft = null; let state = 'ok';
  if (task.interval_days) {
    if (last) {
      const d = new Date(`${last}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + Number(task.interval_days));
      dueOn = d.toISOString().slice(0, 10);
      const soon = new Date(`${today}T00:00:00Z`); soon.setUTCDate(soon.getUTCDate() + Math.min(7, Math.ceil(Number(task.interval_days) / 5)));
      if (dueOn < today) state = 'overdue'; else if (dueOn <= soon.toISOString().slice(0, 10)) state = 'soon';
    } else state = 'never';
  }
  const hoursKnown = task.last_done_hours !== null && task.last_done_hours !== undefined;
  if (task.interval_hours && !task.interval_days && !hoursKnown && !last) state = 'never';
  if (task.interval_hours && asset && hoursKnown) {
    const base = Number(task.last_done_hours);
    hoursLeft = Math.round((base + Number(task.interval_hours) - Number(asset.hours)) * 10) / 10;
    if (hoursLeft <= 0) state = 'overdue';
    else if (hoursLeft <= Number(task.interval_hours) * 0.1 && state !== 'overdue') state = 'soon';
  }
  let milesLeft = null;
  const milesKnown = task.last_done_miles !== null && task.last_done_miles !== undefined;
  if (task.interval_miles && !task.interval_days && !task.interval_hours && !milesKnown && !last) state = 'never';
  if (task.interval_miles && asset && asset.miles !== null && asset.miles !== undefined && milesKnown) {
    milesLeft = Math.round((Number(task.last_done_miles) + Number(task.interval_miles) - Number(asset.miles)) * 10) / 10;
    if (milesLeft <= 0) state = 'overdue';
    else if (milesLeft <= Number(task.interval_miles) * 0.1 && state !== 'overdue') state = 'soon';
  }
  return { due_on: dueOn, hours_left: hoursLeft, miles_left: milesLeft, state };
}

const localStamp = (timezone) => nowIn(timezone);

/**
 * Keep the downtime log in step with a lift's status. A lift that leaves "open" starts a downtime entry (the reason comes from
 * the status, and can be edited afterwards); one that goes back to "open" ends the entry.
 */
async function syncDowntime(conn, tenantId, liftId, from, to, { userId = null } = {}) {
  if (from === to) return;
  const tz = (await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
  const now = localStamp(tz);
  const openRow = await one(conn, 'SELECT id FROM lift_downtime WHERE tenant_id = ? AND lift_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE', [tenantId, liftId]);
  if (to === 'open') {
    if (openRow) await conn.query('UPDATE lift_downtime SET ended_at = ? WHERE tenant_id = ? AND id = ?', [now, tenantId, openRow.id]);
    return;
  }
  if (from === 'open' && !openRow) {
    await conn.query('INSERT INTO lift_downtime (tenant_id, lift_id, started_at, reason, user_id) VALUES (?, ?, ?, ?, ?)', [tenantId, liftId, now, to === 'wind_hold' ? 'wind' : 'other', userId]);
  } else if (openRow && to === 'wind_hold') {
    await conn.query("UPDATE lift_downtime SET reason = 'wind' WHERE tenant_id = ? AND id = ? AND reason = 'other'", [tenantId, openRow.id]);
  }
}

/** Today's latest inspection for a lift, or null. */
const latestCheck = (conn, tenantId, liftId, date) =>
  one(conn, 'SELECT id, result, kind, checked_at FROM lift_checks WHERE tenant_id = ? AND lift_id = ? AND check_date = ? AND kind = ? ORDER BY id DESC LIMIT 1', [tenantId, liftId, date, 'pre_open']);

const ymdOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/**
 * Why each lift cannot be set to open (a Map of lift id to the reason; lifts that can open are left out). Today's latest
 * daily (pre-opening) inspection failed, or its latest weekly inspection failed (on any day) and no weekly one has passed
 * since. Both are cleared only by a new inspection that passes. liftId: only that lift.
 * The open check (openBlock), the Today page and the wall screen (routes/board.js) all read it, so every screen agrees.
 */
async function openBlocks(conn, tenantId, date, liftId = null) {
  const only = liftId === null ? '' : ' AND lift_id = ?';
  const args = liftId === null ? [] : [liftId];
  const [daily] = await conn.query(`SELECT lift_id, result FROM lift_checks WHERE tenant_id = ? AND check_date = ? AND kind = 'pre_open'${only} ORDER BY id`, [tenantId, date, ...args]);
  const [weekly] = await conn.query(`SELECT lift_id, result, check_date FROM lift_checks WHERE tenant_id = ? AND kind = 'periodic'${only} ORDER BY check_date, id`, [tenantId, ...args]);
  const lastDaily = new Map(daily.map((r) => [Number(r.lift_id), r]));
  const lastWeekly = new Map(weekly.map((r) => [Number(r.lift_id), r]));
  const out = new Map();
  for (const id of new Set([...lastDaily.keys(), ...lastWeekly.keys()])) {
    const d = lastDaily.get(id); const w = lastWeekly.get(id);
    if (d && d.result === 'fail') out.set(id, 'This lift failed its inspection today. Pass a new inspection before opening it.');
    else if (w && w.result === 'fail') out.set(id, `This lift failed its weekly inspection on ${ymdOf(w.check_date)}. Pass a new weekly inspection before opening it.`);
  }
  return out;
}

/** Why a lift cannot be set to open, or null (openBlocks, for one lift). */
async function openBlock(conn, tenantId, liftId, date) {
  return (await openBlocks(conn, tenantId, date, Number(liftId))).get(Number(liftId)) || null;
}

module.exports = { ASSET_KINDS, ASSET_KIND_KEYS, CATEGORY_OF, SURFACES, SURFACE_KEYS, DOWNTIME_REASONS, DEPARTMENTS, LIFT_CHECKLIST, pmStatus, localStamp, syncDowntime, latestCheck, openBlock, openBlocks };
