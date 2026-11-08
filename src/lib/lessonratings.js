'use strict';
// Instructor satisfaction (feat/school-pay): after a lesson, the family page asks one question, "How likely are you to
// recommend your instructor?" (0 to 10) with an optional comment. One answer per booking (it can be changed).
// The score is NPS style: the share of 9s and 10s (promoters) less the share of 0 to 6 (detractors), from -100 to 100,
// always shown with how many answered. Directors see each instructor's score; an instructor sees only their own number;
// comments are for owners, managers and the school Director (never about themselves).
const { rows, one } = require('../db');
const { nowIn, addDays } = require('./util');
const { conflict } = require('./errors');

const npsOf = (scores) => {
  if (!scores.length) return null;
  const pro = scores.filter((s) => s >= 9).length; const det = scores.filter((s) => s <= 6).length;
  return Math.round(((pro - det) / scores.length) * 100);
};

/** Saves the family's answer for this booking. b: the booking from lib/lessonfamily.bookingByToken. */
async function save(db, t, b, { score, comment }) {
  if (!b.instructor_id) throw conflict('This lesson had no instructor to rate');
  if (['cancelled', 'no_show'].includes(b.status)) throw conflict('This lesson did not take place');
  if (String(b.ends_at) > nowIn(t.timezone)) throw conflict('You can answer once the lesson is over');
  await db.query(`INSERT INTO lesson_ratings (tenant_id, booking_id, session_id, staff_id, score, comment) VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE score = VALUES(score), comment = VALUES(comment)`, [t.id, b.id, b.session_id, b.instructor_id, score, comment ? String(comment).slice(0, 1000) : null]);
  return { ok: true, score, comment: comment || null };
}

/** What this booking answered, or null. */
const forBooking = (db, tenantId, bookingId) => one(db, 'SELECT score, comment FROM lesson_ratings WHERE tenant_id = ? AND booking_id = ?', [tenantId, bookingId]);

/** Each instructor's score for lessons from `from` to `to` (mountain days): [{ staff_id, name, nps, count, promoters, passives, detractors }]. */
async function summary(db, tenantId, from, to, staffId = null) {
  const list = await rows(db, `SELECT r.staff_id, r.score, TRIM(CONCAT(p.first_name, ' ', p.last_name)) AS name FROM lesson_ratings r
      JOIN lesson_sessions s ON s.tenant_id = r.tenant_id AND s.id = r.session_id
      JOIN staff st ON st.tenant_id = r.tenant_id AND st.id = r.staff_id JOIN people p ON p.tenant_id = st.tenant_id AND p.id = st.person_id
    WHERE r.tenant_id = ? AND s.starts_at >= ? AND s.starts_at < ?${staffId ? ' AND r.staff_id = ?' : ''}`,
  staffId ? [tenantId, `${from} 00:00:00`, `${addDays(to, 1)} 00:00:00`, staffId] : [tenantId, `${from} 00:00:00`, `${addDays(to, 1)} 00:00:00`]);
  const by = new Map();
  for (const r of list) {
    if (!by.has(r.staff_id)) by.set(r.staff_id, { staff_id: r.staff_id, name: r.name, scores: [] });
    by.get(r.staff_id).scores.push(Number(r.score));
  }
  return [...by.values()].map((x) => ({ staff_id: x.staff_id, name: x.name, nps: npsOf(x.scores), count: x.scores.length,
    promoters: x.scores.filter((s) => s >= 9).length, passives: x.scores.filter((s) => s === 7 || s === 8).length, detractors: x.scores.filter((s) => s <= 6).length }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The comments, newest first. exceptStaffId leaves one instructor out (a school Director's own). */
async function comments(db, tenantId, { staffId = null, exceptStaffId = null } = {}) {
  const where = ['r.tenant_id = ?', "r.comment IS NOT NULL AND r.comment <> ''"]; const args = [tenantId];
  if (staffId) { where.push('r.staff_id = ?'); args.push(staffId); }
  if (exceptStaffId) { where.push('r.staff_id <> ?'); args.push(exceptStaffId); }
  return rows(db, `SELECT r.id, r.staff_id, TRIM(CONCAT(p.first_name, ' ', p.last_name)) AS instructor, r.score, r.comment, r.created_at, s.starts_at, pr.name AS product
    FROM lesson_ratings r JOIN lesson_sessions s ON s.tenant_id = r.tenant_id AND s.id = r.session_id JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
    JOIN staff st ON st.tenant_id = r.tenant_id AND st.id = r.staff_id JOIN people p ON p.tenant_id = st.tenant_id AND p.id = st.person_id
    WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC, r.id DESC LIMIT 300`, args);
}

module.exports = { npsOf, save, forBooking, summary, comments };
