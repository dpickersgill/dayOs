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
async function staffProblems(db, tenantId, { staffId, positionId, certificationIds = [], startsAt, endsAt, ignoreShiftId = null, ignoreLessonId = null, ignorePatrolShiftId = null, skipAvailability = false }) {
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

  // The patrol schedule is kept in Patrol, but a paid patroller is one person: no work shift on top of a patrol shift.
  const patrolClash = await one(db, "SELECT id, starts_at, ends_at FROM patrol_shifts WHERE tenant_id = ? AND staff_id = ? AND status <> 'cancelled' AND id <> ? AND starts_at < ? AND ends_at > ? LIMIT 1",
    [tenantId, staffId, ignorePatrolShiftId || 0, endsAt, startsAt]);
  if (patrolClash) problems.push(`On patrol ${span(patrolClash.starts_at, patrolClash.ends_at)}`);

  const busy = await instructorBusy(db, tenantId, staffId, startsAt, endsAt, { ignoreLessonId });
  if (busy) problems.push(busy);

  if (!skipAvailability && !(await isAvailable(db, tenantId, staffId, startsAt, endsAt))) problems.push(AVAILABILITY);
  return problems;
}

const AVAILABILITY = 'Outside their availability';

/**
 * Is this instructor busy teaching then? One answer for lessons and program meetings, used both ways: assigning a lesson
 * (staffProblems) and naming a program coach (routes/programterms.js, programs.js). A program meeting counts when they
 * coach it: named on the meeting, on its day (when the meeting names nobody), or on a level class of that day.
 * ignoreLessonId skips the lesson being changed; ignoreGroupId skips the meetings of the program day being changed.
 * Returns words for the clash, or null.
 */
async function instructorBusy(db, tenantId, staffId, startsAt, endsAt, { ignoreLessonId = 0, ignoreGroupId = 0, ignoreProgramSessionId = 0 } = {}) {
  const lesson = await one(db,
    `SELECT id, starts_at, ends_at FROM lesson_sessions WHERE tenant_id = ? AND instructor_id = ? AND status <> 'cancelled' AND id <> ? AND starts_at < ? AND ends_at > ? ORDER BY starts_at LIMIT 1`,
    [tenantId, staffId, ignoreLessonId || 0, endsAt, startsAt]);
  if (lesson) return `Teaching a lesson ${span(lesson.starts_at, lesson.ends_at)}`;
  const meeting = await one(db,
    `SELECT ps.id, ps.starts_at, ps.ends_at, p.name FROM program_sessions ps JOIN programs p ON p.tenant_id = ps.tenant_id AND p.id = ps.program_id
       LEFT JOIN program_groups g ON g.tenant_id = ps.tenant_id AND g.id = ps.group_id
     WHERE ps.tenant_id = ? AND ps.status = 'scheduled' AND ps.id <> ? AND (ps.group_id IS NULL OR ps.group_id <> ?) AND ps.starts_at < ? AND ps.ends_at > ?
       AND (ps.coach_staff_id = ? OR (ps.coach_staff_id IS NULL AND g.coach_staff_id = ?)
            OR (ps.group_id IS NOT NULL AND EXISTS (SELECT 1 FROM program_levels l WHERE l.tenant_id = ps.tenant_id AND l.group_id = ps.group_id AND l.coach_staff_id = ?)))
     ORDER BY ps.starts_at LIMIT 1`,
    [tenantId, ignoreProgramSessionId || 0, ignoreGroupId || 0, endsAt, startsAt, staffId, staffId, staffId]);
  if (meeting) return `Coaching ${meeting.name} ${span(meeting.starts_at, meeting.ends_at)}`;
  return null;
}

/** Naming a coach for a program day (or a level class of it): the first of its coming meetings they are busy for, or null. */
async function coachBusy(db, tenantId, staffId, groupId) {
  if (!staffId) return null;
  const meetings = await rows(db, "SELECT id, starts_at, ends_at FROM program_sessions WHERE tenant_id = ? AND group_id = ? AND status = 'scheduled' AND starts_at >= NOW() ORDER BY starts_at LIMIT 200", [tenantId, groupId]);
  for (const m of meetings) {
    const busy = await instructorBusy(db, tenantId, staffId, m.starts_at, m.ends_at, { ignoreGroupId: groupId });
    if (busy) return busy;
  }
  return null;
}

/**
 * Is the person available for this time? One roster, two ways to say so: the weekly pattern (My shifts) and the dates
 * an instructor has marked open (Availability). Someone who has said neither can work any time (most non-instructors).
 * Someone who has said either is available only inside what they said: their weekly pattern, or a date marked open.
 */
async function isAvailable(db, tenantId, staffId, startsAt, endsAt) {
  const day = datePart(startsAt);
  const s = timePart(startsAt);
  const e = datePart(endsAt) === day ? timePart(endsAt) : '23:59:59';
  const windows = await rows(db, 'SELECT weekday, start_time, end_time FROM availability WHERE tenant_id = ? AND staff_id = ?', [tenantId, staffId]);
  const wd = weekdayOf(day);
  if (windows.some((w) => w.weekday === wd && w.start_time <= s && w.end_time >= e)) return true;
  if (await one(db, 'SELECT id FROM instructor_open WHERE tenant_id = ? AND staff_id = ? AND open_date = ? AND start_time <= ? AND end_time >= ? LIMIT 1', [tenantId, staffId, day, s, e])) return true;
  if (windows.length) return false;
  // No weekly pattern: free any time, unless they have marked open dates, which then are the only times they can work.
  return !(await one(db, 'SELECT id FROM instructor_open WHERE tenant_id = ? AND staff_id = ? LIMIT 1', [tenantId, staffId]));
}

/** '8:00 AM to 4:30 PM on Sat, Oct 17': how a clash is described, so a manager knows what it is without looking it up. */
function span(a, b) {
  const t = (v) => { const [hh, mm] = String(v).slice(11, 16).split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };
  const d = String(a).slice(0, 10);
  const day = new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${t(a)} to ${t(b)} on ${day}`;
}

module.exports = { staffProblems, isAvailable, instructorBusy, coachBusy, span, AVAILABILITY };
