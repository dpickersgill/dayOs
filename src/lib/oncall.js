'use strict';

// On call (release 2026.11.20): who answers the phone after hours, per department or crew. A rotation is an ordered list
// of people who take turns, each turn period_days long (a week by default), changing hands at the handover time (7:00 AM
// by default) counted from starts_on. A swap, a holiday or cover (oncall_overrides) gives the rotation to someone else for
// whole days. The working day (workday_start to workday_end, Monday to Friday, not on a holiday) is "office hours";
// anything else is after hours. A new request in one of the rotation's categories reported after hours sends the person
// on call a phone alert: what and where (the category and the street), never the resident's name, phone or house number.
// Everything here reads and writes the tenant's local wall-clock time ('YYYY-MM-DD HH:MM:SS'), like the rest of the app.
const { pool, rows, one } = require('../db');
const { addDays, nowIn } = require('./util');

const ids = (csv) => String(csv || '').split(',').map((x) => Number(x)).filter((x) => Number.isSafeInteger(x) && x > 0);
const ymd = (v) => (v ? String(v).slice(0, 10) : null);
const hm = (v) => String(v || '00:00').slice(0, 5);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const weekday = (date) => new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 Sunday ... 6 Saturday

/** A rotation row as the API shows it. */
function shape(r) {
  return {
    // department: the department's name (a municipality's departments, 2026.11.20), else the name typed before that, or a
    // ski area's crew name.
    id: Number(r.id), name: r.name, department: r.department_name || r.department || null, department_id: r.department_id ? Number(r.department_id) : null, members: ids(r.members), starts_on: ymd(r.starts_on), period_days: Number(r.period_days),
    handover: hm(r.handover), workday_start: hm(r.workday_start), workday_end: hm(r.workday_end), category_ids: ids(r.category_ids), active: Boolean(r.active),
  };
}

/** The on-call day a moment falls in: before the handover time it is still the previous day's turn. */
function turnDay(rot, local) {
  const date = local.slice(0, 10);
  return local.slice(11, 16) < rot.handover ? addDays(date, -1) : date;
}

/** Who the rotation itself puts on call for a turn day (before swaps and holidays), or null when it has nobody. */
function rotationPick(rot, day) {
  if (!rot.members.length) return null;
  const n = Math.floor(daysBetween(rot.starts_on, day) / Math.max(1, rot.period_days));
  const i = ((n % rot.members.length) + rot.members.length) % rot.members.length;
  return rot.members[i];
}

/** Who is on call for a turn day: the newest override covering it, or the rotation's pick. { staff_id, why, override_id } */
function onCallFor(rot, day, overrides) {
  const o = overrides.filter((x) => Number(x.rotation_id) === rot.id && ymd(x.starts_on) <= day && ymd(x.ends_on) >= day).sort((a, b) => Number(b.id) - Number(a.id))[0];
  if (o) return { staff_id: Number(o.staff_id), why: o.reason, override_id: Number(o.id), note: o.note || null };
  const s = rotationPick(rot, day);
  return s ? { staff_id: s, why: 'rotation', override_id: null, note: null } : null;
}

/** Is this local moment outside the rotation's working day? Weekends and holidays are after hours all day. */
function isAfterHours(rot, local, holidays) {
  const date = local.slice(0, 10); const time = local.slice(11, 16);
  const wd = weekday(date);
  if (wd === 0 || wd === 6 || holidays.has(date)) return true;
  return time < rot.workday_start || time >= rot.workday_end;
}

async function tzOf(db, tenantId) { return (await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone; }

/** Everything needed to answer "who is on call" over a range of days. */
async function loadAll(db, tenantId, from, to, { activeOnly = true } = {}) {
  const [rots, overrides, holidays] = await Promise.all([
    rows(db, `SELECT r.*, d.name AS department_name FROM oncall_rotations r LEFT JOIN departments d ON d.tenant_id = r.tenant_id AND d.id = r.department_id
      WHERE r.tenant_id = ?${activeOnly ? ' AND r.active = 1' : ''} ORDER BY r.name`, [tenantId]),
    rows(db, 'SELECT * FROM oncall_overrides WHERE tenant_id = ? AND ends_on >= ? AND starts_on <= ? ORDER BY id', [tenantId, addDays(from, -1), to]),
    rows(db, 'SELECT day, name FROM oncall_holidays WHERE tenant_id = ? AND day >= ? AND day <= ? ORDER BY day', [tenantId, addDays(from, -1), addDays(to, 1)]),
  ]);
  return { rotations: rots.map(shape), overrides, holidays: new Map(holidays.map((h) => [ymd(h.day), h.name])) };
}

/** Staff names for a set of staff ids: Map id -> "First Last". */
async function namesOf(db, tenantId, staffIds) {
  const list = [...new Set(staffIds.filter(Boolean).map(Number))];
  if (!list.length) return new Map();
  const r = await rows(db, "SELECT s.id, CONCAT(p.first_name, ' ', p.last_name) AS name FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE s.tenant_id = ? AND s.id IN (?)", [tenantId, list]);
  return new Map(r.map((x) => [Number(x.id), String(x.name || '').trim()]));
}

/**
 * Who is on call now, and tonight, for each active rotation: [{ rotation, now: {staff_id, name, why}, tonight: {...},
 * after_hours }]. "Tonight" is the turn that holds at the end of today's working day (the evening's call-outs).
 */
async function onCallNow(db, tenantId, at = null) {
  const tz = await tzOf(db, tenantId);
  const local = at || nowIn(tz);
  const today = local.slice(0, 10);
  const all = await loadAll(db, tenantId, addDays(today, -1), addDays(today, 1));
  const out = all.rotations.map((rot) => {
    const now = onCallFor(rot, turnDay(rot, local), all.overrides);
    const evening = `${today} ${rot.workday_end > rot.handover ? rot.workday_end : '23:59'}:00`;
    const tonight = onCallFor(rot, turnDay(rot, evening), all.overrides);
    return { rotation: { id: rot.id, name: rot.name, department: rot.department }, now, tonight, after_hours: isAfterHours(rot, local, all.holidays) };
  });
  const names = await namesOf(db, tenantId, out.flatMap((o) => [o.now && o.now.staff_id, o.tonight && o.tonight.staff_id]));
  for (const o of out) for (const k of ['now', 'tonight']) if (o[k]) o[k].name = names.get(o[k].staff_id) || 'Someone not on the staff list';
  return { at: local, holiday: all.holidays.get(today) || null, data: out };
}

/** The on-call calendar: for each day from `from`, who has each rotation (from the handover that day). */
async function calendar(db, tenantId, from, days = 28) {
  const to = addDays(from, days - 1);
  const all = await loadAll(db, tenantId, from, to, { activeOnly: false });
  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
  const list = all.rotations.map((rot) => ({ ...rot, days: dates.map((d) => ({ date: d, ...(onCallFor(rot, d, all.overrides) || { staff_id: null, why: null }) })) }));
  const names = await namesOf(db, tenantId, [...list.flatMap((r) => r.days.map((d) => d.staff_id)), ...list.flatMap((r) => r.members)]);
  for (const r of list) {
    r.member_names = r.members.map((m) => ({ staff_id: m, name: names.get(m) || 'Someone not on the staff list' }));
    for (const d of r.days) d.name = d.staff_id ? names.get(d.staff_id) || 'Someone not on the staff list' : null;
  }
  const overrides = all.overrides.filter((o) => ymd(o.ends_on) >= from).map((o) => ({ id: Number(o.id), rotation_id: Number(o.rotation_id), starts_on: ymd(o.starts_on), ends_on: ymd(o.ends_on), staff_id: Number(o.staff_id), reason: o.reason, note: o.note }));
  const oNames = await namesOf(db, tenantId, overrides.map((o) => o.staff_id));
  for (const o of overrides) o.name = oNames.get(o.staff_id) || '';
  return { from, to, dates, holidays: [...all.holidays].filter(([d]) => d >= from && d <= to).map(([day, name]) => ({ day, name })), rotations: list, overrides };
}

/** The rotations a staff member is on call for at this moment (for their own Today). */
async function myOnCall(db, tenantId, staffId) {
  if (!staffId) return [];
  const { data } = await onCallNow(db, tenantId);
  return data.filter((o) => (o.now && o.now.staff_id === Number(staffId)) || (o.tonight && o.tonight.staff_id === Number(staffId)))
    .map((o) => ({ rotation: o.rotation.name, now: Boolean(o.now && o.now.staff_id === Number(staffId)), tonight: Boolean(o.tonight && o.tonight.staff_id === Number(staffId)), after_hours: o.after_hours }));
}

/**
 * A new request has come in: if it was reported after hours in a category one of the rotations covers, send the person on
 * call a phone alert (once per rotation and request) and keep a record of it. Never throws; returns how many were alerted.
 * r: the request with category and street (lib/requests.js requestOf); where: the place in words, without the house number.
 */
async function alertAfterHours(tenantId, r, where, { exceptUserId = null } = {}) {
  try {
    if (!r || !r.category_id) return 0;
    const rots = (await rows(pool, 'SELECT * FROM oncall_rotations WHERE tenant_id = ? AND active = 1', [tenantId])).map(shape).filter((x) => x.category_ids.includes(Number(r.category_id)));
    if (!rots.length) return 0;
    const tz = await tzOf(pool, tenantId);
    const at = String(r.reported_at || nowIn(tz)).replace('T', ' ').slice(0, 19);
    const all = await loadAll(pool, tenantId, addDays(at.slice(0, 10), -1), at.slice(0, 10));
    let sent = 0;
    for (const rot of rots) {
      if (!isAfterHours(rot, at, all.holidays)) continue;
      const who = onCallFor(rot, turnDay(rot, at), all.overrides);
      if (!who) continue;
      const users = (await rows(pool, 'SELECT id FROM users WHERE tenant_id = ? AND active = 1 AND staff_id = ?', [tenantId, who.staff_id])).map((u) => Number(u.id)).filter((u) => u !== Number(exceptUserId));
      const [ins] = await pool.query('INSERT IGNORE INTO oncall_alerts (tenant_id, rotation_id, request_id, staff_id) VALUES (?, ?, ?, ?)', [tenantId, rot.id, r.id, who.staff_id]);
      if (!ins.affectedRows) continue; // already alerted for this request
      const phones = users.length ? await require('./push').notifyUsers(tenantId, users, { title: `After-hours call: ${r.category}`, body: `${where}. You are on call (${rot.name}).`, url: `/#/requests/r/${r.id}`, tag: `oncall-${r.id}` }, { urgency: 'high', ttl: 3600 }) : 0;
      await pool.query('UPDATE oncall_alerts SET phones = ? WHERE tenant_id = ? AND id = ?', [phones, tenantId, ins.insertId]);
      sent += 1;
    }
    return sent;
  } catch (err) {
    console.error(`[oncall] could not alert the person on call: ${err && err.message}`);
    return 0;
  }
}

/**
 * A municipality's rotations named a department by typing it before departments existed (2026.11.20): a typed name that
 * is one of its departments' names (any case) becomes that department. The migration does this for departments already
 * made; this does it once the departments are made (the first time anyone opens On call). Returns how many changed.
 */
async function linkDepartments(db, tenantId) {
  const W = require('./workcosts');
  if (!(await W.ensureBooks(db, tenantId))) return 0;
  const [r] = await db.query(`UPDATE oncall_rotations r JOIN departments d ON d.tenant_id = r.tenant_id AND LOWER(d.name) = LOWER(TRIM(r.department))
    SET r.department_id = d.id, r.department = NULL WHERE r.tenant_id = ? AND r.department_id IS NULL AND r.department IS NOT NULL`, [tenantId]);
  return r.affectedRows;
}

module.exports = { linkDepartments, shape, ids, turnDay, rotationPick, onCallFor, isAfterHours, onCallNow, calendar, myOnCall, alertAfterHours, namesOf, weekday };
