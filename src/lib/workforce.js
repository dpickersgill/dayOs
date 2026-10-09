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
    `SELECT id FROM shifts WHERE tenant_id = ? AND staff_id = ? AND status <> 'cancelled' AND id <> ? AND starts_at < ? AND ends_at > ? LIMIT 1`,
    [tenantId, staffId, ignoreShiftId || 0, endsAt, startsAt],
  );
  if (shiftClash) problems.push(`Overlaps shift #${shiftClash.id}`);

  const lessonClash = await one(
    db,
    `SELECT id FROM lesson_sessions WHERE tenant_id = ? AND instructor_id = ? AND status <> 'cancelled' AND id <> ? AND starts_at < ? AND ends_at > ? LIMIT 1`,
    [tenantId, staffId, ignoreLessonId || 0, endsAt, startsAt],
  );
  if (lessonClash) problems.push(`Overlaps lesson session #${lessonClash.id}`);

  if (!skipAvailability) {
    const windows = await rows(db, 'SELECT weekday, start_time, end_time FROM availability WHERE tenant_id = ? AND staff_id = ?', [tenantId, staffId]);
    if (windows.length) {
      const wd = weekdayOf(day);
      const s = timePart(startsAt);
      const e = datePart(endsAt) === day ? timePart(endsAt) : '23:59:59';
      const ok = windows.some((w) => w.weekday === wd && w.start_time <= s && w.end_time >= e);
      if (!ok) problems.push('Outside declared availability');
    }
  }
  return problems;
}

module.exports = { staffProblems };
