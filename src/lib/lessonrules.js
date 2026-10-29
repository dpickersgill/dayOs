'use strict';
// Rules every way of booking a lesson shares (the counter, the online page, a waitlist claim, moving a student at the
// lineup, changing a date, a private asked for by name). Use these instead of writing the checks again.
const { one } = require('../db');

/**
 * Is this student already somewhere else at that time? Checks lesson bookings (booked or attended, lesson not canceled)
 * and program meetings they are enrolled in (not canceled). Returns null, or { kind: 'lesson'|'program', id, starts_at,
 * ends_at, name } for the first clash. ignoreSessionId skips one lesson (the one being moved from).
 */
async function studentClash(db, tenantId, personId, startsAt, endsAt, { ignoreSessionId = 0 } = {}) {
  const lesson = await one(db, `SELECT s.id, s.starts_at, s.ends_at, pr.name FROM lesson_bookings b
      JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id
      JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
    WHERE b.tenant_id = ? AND b.person_id = ? AND b.status IN ('booked','attended') AND s.status <> 'cancelled'
      AND s.id <> ? AND s.starts_at < ? AND s.ends_at > ? ORDER BY s.starts_at LIMIT 1`, [tenantId, personId, ignoreSessionId || 0, endsAt, startsAt]);
  if (lesson) return { kind: 'lesson', ...lesson };
  const meeting = await one(db, `SELECT ps.id, ps.starts_at, ps.ends_at, p.name FROM program_enrollments e
      JOIN program_sessions ps ON ps.tenant_id = e.tenant_id AND ps.program_id = e.program_id
        AND (e.group_id IS NULL OR e.any_day = 1 OR ps.group_id IS NULL OR ps.group_id = e.group_id)
      JOIN programs p ON p.tenant_id = e.tenant_id AND p.id = e.program_id
    WHERE e.tenant_id = ? AND e.person_id = ? AND e.status = 'enrolled' AND e.withdrawn_at IS NULL
      AND (e.term_id IS NULL OR ps.term_id IS NULL OR ps.term_id = e.term_id)
      AND ps.status <> 'cancelled' AND ps.starts_at < ? AND ps.ends_at > ? ORDER BY ps.starts_at LIMIT 1`, [tenantId, personId, endsAt, startsAt]);
  if (meeting) return { kind: 'program', ...meeting };
  return null;
}

/** "Already booked in Kids Group 10:00 AM" style words for a clash. */
function clashWords(c) {
  if (!c) return '';
  const t = String(c.starts_at).slice(11, 16);
  const [hh, mm] = t.split(':').map(Number);
  const time = `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
  return c.kind === 'lesson' ? `Already booked in ${c.name} at ${time} that day` : `Already in ${c.name} at ${time} that day`;
}

module.exports = { studentClash, clashWords };
