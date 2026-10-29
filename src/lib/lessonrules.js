'use strict';
// Rules every way of booking a lesson shares (the counter, the online page, a waitlist claim, moving a student at the
// lineup, changing a date, a private asked for by name). Use these instead of writing the checks again.
//
// Locks, and the order to take them in. Two sales of the same student at the same moment must not both pass the clash
// check, and two sales of the last spot must not both pass the count. So every booking path, inside its transaction:
//   1. locks the student's people row (lockStudents, ascending id when there are several), then
//   2. locks the lesson row (SELECT ... FROM lesson_sessions ... FOR UPDATE), then
//   3. checks with studentClash(conn, ..., { lock: true }) and spotsLeft(conn, ...), which read with locking reads.
// Locking reads matter: the database keeps each transaction's first view of the data (repeatable read), so a plain
// SELECT after waiting for a lock can still miss a booking the other sale just committed.
// A path that only learns the student from a row it must lock first (a weather call over a whole day) may lock the
// student after the lesson; tx() runs a transaction again when the database reports a lock collision.
const { one, rows } = require('../db');

/** Locks the students' people rows, in ascending id order, so two bookings of one student wait for each other. */
async function lockStudents(conn, tenantId, personIds) {
  const ids = [...new Set((personIds || []).map(Number).filter((x) => x > 0))].sort((a, b) => a - b);
  if (!ids.length) return;
  await rows(conn, 'SELECT id FROM people WHERE tenant_id = ? AND id IN (?) ORDER BY id FOR UPDATE', [tenantId, ids]);
}

/**
 * Is this student already somewhere else at that time? Checks lesson bookings (booked or attended, lesson not canceled)
 * and program meetings they are enrolled in (not canceled). Returns null, or { kind: 'lesson'|'program', id, starts_at,
 * ends_at, name } for the first clash. ignoreSessionId skips one lesson (the one being moved from).
 * lock: true (every booking path, inside its transaction) first locks the student's people row, then reads their
 * lessons with a locking read, so a booking another sale committed a moment ago is seen.
 */
async function studentClash(db, tenantId, personId, startsAt, endsAt, { ignoreSessionId = 0, lock = false } = {}) {
  if (lock) await lockStudents(db, tenantId, [personId]);
  const lesson = await one(db, `SELECT s.id, s.starts_at, s.ends_at, s.product_id FROM lesson_bookings b
      JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id
    WHERE b.tenant_id = ? AND b.person_id = ? AND b.status IN ('booked','attended') AND s.status <> 'cancelled'
      AND s.id <> ? AND s.starts_at < ? AND s.ends_at > ? ORDER BY s.starts_at LIMIT 1${lock ? ' LOCK IN SHARE MODE' : ''}`, [tenantId, personId, ignoreSessionId || 0, endsAt, startsAt]);
  if (lesson) {
    const pr = await one(db, 'SELECT name FROM products WHERE tenant_id = ? AND id = ?', [tenantId, lesson.product_id]);
    return { kind: 'lesson', id: lesson.id, starts_at: lesson.starts_at, ends_at: lesson.ends_at, name: pr ? pr.name : 'a lesson' };
  }
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

/**
 * Places left in a lesson. Call it inside the transaction after locking the lesson row FOR UPDATE: it counts with
 * locking reads, so a sale that committed while this one waited is counted.
 * Counts bookings (booked or attended) and, unless holds is false, the places held for others: waitlist offers still
 * standing and online requests still waiting (to be confirmed or paid), the same holds the booking page shows.
 * exceptRequestId / exceptWaitlistId: the request being confirmed, or the offer being claimed, does not hold against itself.
 * Returns { left, booked, offers, requests }.
 */
async function spotsLeft(conn, tenantId, session, { holds = true, exceptRequestId = 0, exceptWaitlistId = 0 } = {}) {
  const lk = conn && conn.beginTransaction ? ' LOCK IN SHARE MODE' : '';
  const { n } = await one(conn, `SELECT COUNT(*) AS n FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND status IN ('booked','attended')${lk}`, [tenantId, session.id]);
  let offers = 0; let requests = 0;
  if (holds) {
    offers = Number((await one(conn, `SELECT COUNT(*) AS n FROM lesson_waitlist WHERE tenant_id = ? AND session_id = ? AND status = 'offered' AND offer_expires_at > UTC_TIMESTAMP() AND id <> ?${lk}`, [tenantId, session.id, exceptWaitlistId || 0])).n);
    for (const r of await rows(conn, `SELECT id, students FROM lesson_requests WHERE tenant_id = ? AND session_id = ? AND status IN ('pending','awaiting_payment') AND id <> ?${lk}`, [tenantId, session.id, exceptRequestId || 0])) {
      let k = 1; try { k = JSON.parse(r.students).students.length || 1; } catch (_) { /* one */ }
      requests += k;
    }
  }
  return { left: Math.max(Number(session.capacity) - Number(n) - offers - requests, 0), booked: Number(n), offers, requests };
}

/** "Already booked in Kids Group 10:00 AM" style words for a clash. */
function clashWords(c) {
  if (!c) return '';
  const t = String(c.starts_at).slice(11, 16);
  const [hh, mm] = t.split(':').map(Number);
  const time = `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
  return c.kind === 'lesson' ? `Already booked in ${c.name} at ${time} that day` : `Already in ${c.name} at ${time} that day`;
}

/**
 * Moves a booking to another lesson, keeping the same booking row (its link, safety details and consents), and moves
 * its sale line with it so receipts, reports, refunds and a later weather call find the value on the new lesson.
 * opts: { status: set the booking's status too (a weather makeup books a canceled row again), resetCheckin: false keeps a
 * check-in (a move between classes at the lineup on the same day) }. Does no checks: the caller has locked and checked.
 */
async function moveBookingRow(conn, tenantId, booking, fromSessionId, to, { status = null, utc = false, resetCheckin = true } = {}) {
  await conn.query(`UPDATE lesson_bookings SET session_id = ?,${status ? ' status = ?,' : ''} moved_from_session_id = ?, moved_at = ${utc ? 'UTC_TIMESTAMP()' : 'NOW()'}${resetCheckin ? ', checked_in_at = NULL, checked_in_by = NULL, checked_in_via = NULL' : ''} WHERE tenant_id = ? AND id = ?`,
    [to.id, ...(status ? [status] : []), fromSessionId, tenantId, booking.id]);
  await conn.query("UPDATE order_items SET session_id = ?, valid_on = ? WHERE tenant_id = ? AND session_id = ? AND person_id = ? AND line_kind = 'lesson' AND refunded_at IS NULL",
    [to.id, String(to.starts_at).slice(0, 10), tenantId, fromSessionId, booking.person_id]);
}

module.exports = { studentClash, clashWords, lockStudents, spotsLeft, moveBookingRow };
