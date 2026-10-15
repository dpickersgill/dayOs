'use strict';

const { rows, one } = require('../db');
const { weekdayOf } = require('./util');

const datePart = (dt) => dt.slice(0, 10);
const timePart = (dt) => dt.slice(11, 19);

/**
 * Hard checks before a person is put on a shift or lesson.
 * Returns an array of human-readable problems (empty = fine).
 *   - person is an active staff member
 *   - holds every certification the position or lesson requires, unexpired on the day
 *   - has no overlapping shift or lesson
 *   - falls inside declared availability (only if they declared any; skipped with skipAvailability)
 */
async function staffProblems(db, tenantId, { staffId, positionId, certificationIds = [], startsAt, endsAt, ignoreShiftId = null, ignoreLessonId = null, skipAvailability = false }) {
  const problems = [];
  const staff = await one(db, 'SELECT id, status FROM staff WHERE tenant_id = ? AND id = ?', [tenantId, staffId]);
  if (!staff) return ['Staff member not found'];
  if (staff.status !== 'active') problems.push(`Staff member is ${staff.status}, not active`);

  const day = datePart(startsAt);

  const required = new Set(certificationIds);
  if (positionId) {
    const pc = await rows(db, 'SELECT certification_id FROM position_certifications WHERE tenant_id = ? AND position_id = ?', [tenantId, positionId]);
    pc.forEach((r) => required.add(r.certification_id));
  }
  if (required.size) {
    const held = await rows(
      db,
      'SELECT certification_id FROM staff_certifications WHERE tenant_id = ? AND staff_id = ? AND (expires_on IS NULL OR expires_on >= ?)',
      [tenantId, staffId, day],
    );
    const heldIds = new Set(held.map((r) => r.certification_id));
    const missing = [...required].filter((c) => !heldIds.has(c));
    if (missing.length) {
      const names = await rows(db, 'SELECT name FROM certifications WHERE tenant_id = ? AND id IN (?)', [tenantId, missing]);
      problems.push(`Missing or expired certification: ${names.map((n) => n.name).join(', ')}`);
    }
  }

  const shiftClash = await one(
    db,
    `SELECT s.id, s.starts_at, s.ends_at, pos.name AS position FROM shifts s JOIN positions pos ON pos.tenant_id = s.tenant_id AND pos.id = s.position_id
     WHERE s.tenant_id = ? AND s.staff_id = ? AND s.status <> 'cancelled' AND s.id <> ? AND s.starts_at < ? AND s.ends_at > ? LIMIT 1`,
    [tenantId, staffId, ignoreShiftId || 0, endsAt, startsAt],
  );
  if (shiftClash) problems.push(`Already on ${shiftClash.position} ${span(shiftClash.starts_at, shiftClash.ends_at)}`);

  const lessonClash = await one(
    db,
    `SELECT id, starts_at, ends_at FROM lesson_sessions WHERE tenant_id = ? AND instructor_id = ? AND status <> 'cancelled' AND id <> ? AND starts_at < ? AND ends_at > ? LIMIT 1`,
    [tenantId, staffId, ignoreLessonId || 0, endsAt, startsAt],
  );
  if (lessonClash) problems.push(`Teaching a lesson ${span(lessonClash.starts_at, lessonClash.ends_at)}`);

  if (!skipAvailability && !(await isAvailable(db, tenantId, staffId, startsAt, endsAt))) problems.push(AVAILABILITY);
  return problems;
}

const AVAILABILITY = 'Outside their availability';

/**
 * Is the person available for this time? One roster, two ways to say so: the weekly pattern (Staff and schedule, My
 * shifts) and the dates an instructor has marked open (Instructor availability). Someone who has said neither can
 * work any time. A date marked open counts even when the weekly pattern does not cover it.
 */
async function isAvailable(db, tenantId, staffId, startsAt, endsAt) {
  const day = datePart(startsAt);
  const s = timePart(startsAt);
  const e = datePart(endsAt) === day ? timePart(endsAt) : '23:59:59';
  const windows = await rows(db, 'SELECT weekday, start_time, end_time FROM availability WHERE tenant_id = ? AND staff_id = ?', [tenantId, staffId]);
  if (!windows.length) return true;
  const wd = weekdayOf(day);
  if (windows.some((w) => w.weekday === wd && w.start_time <= s && w.end_time >= e)) return true;
  return Boolean(await one(db, 'SELECT id FROM instructor_open WHERE tenant_id = ? AND staff_id = ? AND open_date = ? AND start_time <= ? AND end_time >= ? LIMIT 1', [tenantId, staffId, day, s, e]));
}

/** '8:00 AM to 4:30 PM on Sat, Oct 17': how a clash is described, so a manager knows what it is without looking it up. */
function span(a, b) {
  const t = (v) => { const [hh, mm] = String(v).slice(11, 16).split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };
  const d = String(a).slice(0, 10);
  const day = new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${t(a)} to ${t(b)} on ${day}`;
}

module.exports = { staffProblems, isAvailable, span, AVAILABILITY };
