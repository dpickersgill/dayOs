'use strict';

// Scheduling helpers shared by the shift, template and staff routes: who can fill a shift (and why not), copying shifts
// into another week, and telling people in the Inbox when their published shifts are set or change.
//
// Shift times are the mountain's local wall-clock time (as typed), unlike time-clock punches, which are database (UTC)
// time and are converted where the two meet.
const { rows, one } = require('../db');
const { staffProblems, span, AVAILABILITY } = require('./workforce');
const { addDays } = require('./util');
const { direct } = require('./review');

const minutesBetween = (a, b) => Math.round((Date.parse(`${String(b).replace(' ', 'T')}Z`) - Date.parse(`${String(a).replace(' ', 'T')}Z`)) / 60000);
const shiftDt = (date, time) => `${date} ${String(time).slice(0, 8).padEnd(8, ':00')}`;
const plusMinutes = (dt, m) => new Date(Date.parse(`${dt.replace(' ', 'T')}Z`) + m * 60000).toISOString().slice(0, 19).replace('T', ' ');

/** Monday of the week a date falls in. */
function weekOf(date) {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((wd + 6) % 7));
}

/**
 * Scheduled minutes per person for the week starting on `start` (Monday): filled work shifts and patrol shifts that are
 * not cancelled (a paid patroller's patrol time counts toward their week and overtime).
 */
async function weekMinutes(db, tenantId, start, ignoreShiftId = 0) {
  const range = [`${start} 00:00:00`, `${addDays(start, 7)} 00:00:00`];
  const list = [
    ...await rows(db, "SELECT staff_id, starts_at, ends_at FROM shifts WHERE tenant_id = ? AND staff_id IS NOT NULL AND status <> 'cancelled' AND id <> ? AND starts_at >= ? AND starts_at < ?", [tenantId, ignoreShiftId, ...range]),
    ...await rows(db, "SELECT staff_id, starts_at, ends_at FROM patrol_shifts WHERE tenant_id = ? AND staff_id IS NOT NULL AND status <> 'cancelled' AND starts_at >= ? AND starts_at < ?", [tenantId, ...range]),
  ];
  const out = new Map();
  for (const s of list) out.set(Number(s.staff_id), (out.get(Number(s.staff_id)) || 0) + minutesBetween(s.starts_at, s.ends_at));
  return out;
}

/**
 * Everyone who could be put on a shift, best first: people who can work it and are trained for its position, then
 * people who can work it, then people blocked only by their availability (a manager may override that), then the rest,
 * each with the reasons. Within a group, fewest hours booked that week first.
 */
async function candidates(db, tenantId, shift) {
  const staff = await rows(db, "SELECT s.id, s.in_workforce, p.first_name, p.last_name FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE s.tenant_id = ? AND s.status = 'active' ORDER BY p.last_name, p.first_name LIMIT 500", [tenantId]);
  const trained = new Set((await rows(db, 'SELECT staff_id FROM staff_positions WHERE tenant_id = ? AND position_id = ?', [tenantId, shift.position_id])).map((r) => Number(r.staff_id)));
  const anyTrained = (await one(db, 'SELECT COUNT(*) AS n FROM staff_positions WHERE tenant_id = ? AND position_id = ?', [tenantId, shift.position_id])).n > 0;
  const hours = await weekMinutes(db, tenantId, weekOf(String(shift.starts_at).slice(0, 10)), shift.id || 0);
  const out = [];
  for (const s of staff) {
    const id = Number(s.id);
    const problems = await staffProblems(db, tenantId, { staffId: id, positionId: shift.position_id, startsAt: shift.starts_at, endsAt: shift.ends_at, ignoreShiftId: shift.id || 0 });
    const onlyAvailability = problems.length === 1 && problems[0] === AVAILABILITY;
    const works = trained.has(id);
    out.push({
      staff_id: id, name: `${s.first_name} ${s.last_name}`, ok: problems.length === 0, overridable: onlyAvailability, problems,
      trained: works, trained_known: anyTrained, week_minutes: hours.get(id) || 0, current: Number(shift.staff_id) === id, volunteer: !Number(s.in_workforce),
    });
  }
  const rank = (c) => (c.ok ? (c.trained ? 0 : 1) : c.overridable ? 2 : 3);
  out.sort((a, b) => rank(a) - rank(b) || a.week_minutes - b.week_minutes || a.name.localeCompare(b.name));
  return out;
}

/**
 * Make draft shifts from a list of { starts_at, ends_at, position_id, staff_id, notes }. A person is kept on a shift
 * only when they can still work it (active, certified, free, available); otherwise the shift is left unfilled. A shift
 * that already exists at the same time for the same position and person is skipped, so copying twice adds nothing.
 */
async function makeDrafts(conn, tenantId, list) {
  let created = 0; let unfilled = 0; let skipped = 0;
  const leftOpen = [];
  const patrolPositions = new Set((await rows(conn, "SELECT id FROM positions WHERE tenant_id = ? AND department = 'patrol'", [tenantId])).map((r) => Number(r.id)));
  for (const s of list) {
    if (patrolPositions.has(Number(s.position_id))) { skipped += 1; continue; } // patrol is scheduled in Patrol
    let staffId = s.staff_id ? Number(s.staff_id) : null;
    const same = await one(conn, "SELECT id FROM shifts WHERE tenant_id = ? AND position_id = ? AND starts_at = ? AND ends_at = ? AND status <> 'cancelled' AND (staff_id <=> ?) LIMIT 1", [tenantId, s.position_id, s.starts_at, s.ends_at, staffId]);
    if (same) { skipped += 1; continue; }
    if (staffId) {
      const problems = await staffProblems(conn, tenantId, { staffId, positionId: s.position_id, startsAt: s.starts_at, endsAt: s.ends_at });
      if (problems.length) { leftOpen.push({ staff_id: staffId, starts_at: s.starts_at, reason: problems[0] }); staffId = null; }
    }
    await conn.query('INSERT INTO shifts (tenant_id, position_id, staff_id, starts_at, ends_at, notes) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, s.position_id, staffId, s.starts_at, s.ends_at, s.notes || null]);
    created += 1;
    if (!staffId) unfilled += 1;
  }
  return { created, unfilled, skipped, left_open: leftOpen.slice(0, 50) };
}

/** The login linked to a staff record, if any (the Inbox talks to logins). */
async function loginOf(db, tenantId, staffId) {
  if (!staffId) return null;
  const u = await one(db, 'SELECT id FROM users WHERE tenant_id = ? AND staff_id = ? AND active = 1 ORDER BY id LIMIT 1', [tenantId, staffId]);
  return u ? Number(u.id) : null;
}

const describe = (s) => `${s.position} ${span(s.starts_at, s.ends_at)}`;

/** A message from the manager to one person, if they have a login. Never fails the change it reports. */
async function tell(conn, tenantId, fromUser, staffId, text) {
  try {
    const to = await loginOf(conn, tenantId, staffId);
    if (to) { await direct(conn, tenantId, fromUser, to, text); return true; }
  } catch (err) { console.warn('Could not send a schedule message:', err.message); }
  return false;
}

/** After publishing: each person gets their published shifts in the range, in one message. */
async function notifyPublished(conn, tenantId, fromUser, from, to) {
  const list = await rows(conn, `SELECT s.staff_id, s.starts_at, s.ends_at, pos.name AS position FROM shifts s JOIN positions pos ON pos.tenant_id = s.tenant_id AND pos.id = s.position_id
    WHERE s.tenant_id = ? AND s.status = 'published' AND s.staff_id IS NOT NULL AND DATE(s.starts_at) BETWEEN ? AND ? ORDER BY s.starts_at`, [tenantId, from, to]);
  const by = new Map();
  for (const s of list) { const k = Number(s.staff_id); if (!by.has(k)) by.set(k, []); by.get(k).push(s); }
  let told = 0;
  for (const [staffId, mine] of by) {
    const text = `Your schedule is published. You are on ${mine.length} shift${mine.length === 1 ? '' : 's'}:\n${mine.map((s) => `- ${describe(s)}`).join('\n')}\nSee them any time in My shifts.`;
    if (await tell(conn, tenantId, fromUser, staffId, text)) told += 1;
  }
  return told;
}

/** A published shift changed: tell whoever it affects (the person taken off, the person put on, or the person on it). */
async function notifyChange(conn, tenantId, fromUser, before, after) {
  if (before.status !== 'published') return;
  const was = before.staff_id ? Number(before.staff_id) : null;
  const now = after && after.status !== 'cancelled' && after.staff_id ? Number(after.staff_id) : null;
  if (!after || after.status === 'cancelled') { if (was) await tell(conn, tenantId, fromUser, was, `Your shift ${describe(before)} is cancelled.`); return; }
  if (was && was !== now) await tell(conn, tenantId, fromUser, was, `You are no longer on ${describe(before)}.`);
  if (now && was !== now) await tell(conn, tenantId, fromUser, now, `You have a new shift: ${describe(after)}.${after.notes ? ` Note: ${after.notes}` : ''}`);
  if (now && was === now && (before.starts_at !== after.starts_at || before.ends_at !== after.ends_at || before.position !== after.position)) {
    await tell(conn, tenantId, fromUser, now, `Your shift changed. It was ${describe(before)}. It is now ${describe(after)}.`);
  }
}

/**
 * The shift a clock-in is for: the published work shift closest to now that starts up to 3 hours ahead or is under way;
 * failing that, a published patrol shift the same way (a paid patroller clocking in for patrol).
 */
async function shiftForPunch(db, tenantId, staffId, local) {
  const near = "staff_id = ? AND status = 'published' AND ? BETWEEN DATE_SUB(starts_at, INTERVAL 3 HOUR) AND ends_at ORDER BY ABS(TIMESTAMPDIFF(MINUTE, starts_at, ?)) LIMIT 1";
  const w = await one(db, `SELECT id FROM shifts WHERE tenant_id = ? AND ${near}`, [tenantId, staffId, local, local]);
  if (w) return { shift_id: w.id, patrol_shift_id: null };
  const p = await one(db, `SELECT id FROM patrol_shifts WHERE tenant_id = ? AND ${near}`, [tenantId, staffId, local, local]);
  return { shift_id: null, patrol_shift_id: p ? p.id : null };
}

/** A shift with its position name, for messages and responses. */
const shiftRow = (db, tenantId, id) => one(db, 'SELECT s.*, pos.name AS position FROM shifts s JOIN positions pos ON pos.tenant_id = s.tenant_id AND pos.id = s.position_id WHERE s.tenant_id = ? AND s.id = ?', [tenantId, id]);

module.exports = { shiftForPunch, candidates, makeDrafts, notifyPublished, notifyChange, tell, describe, shiftRow, weekOf, weekMinutes, minutesBetween, shiftDt, plusMinutes, loginOf };
