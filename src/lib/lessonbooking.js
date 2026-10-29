'use strict';
// Putting one student in one lesson: the rules every way of booking shares (the counter today; online requests,
// waitlist claims, moved students and privates can call it too). Run inside a transaction, after the student is on file:
//   - the lesson is locked and still scheduled
//   - the season waiver is on file (or recorded now, when staff say it was signed)
//   - the student is not in another lesson or a program meeting at that time (lib/lessonrules.studentClash)
//   - there is a seat (counted under the lock, so two counters cannot oversell a class)
//   - a lesson package, when used, has a lesson left and is valid on the day
//   - the safety details, the contact and the consents are saved on the booking (and a text "yes" goes in the consent ledger)
// After the transaction commits, call lib/lessonconfirm.sendConfirmation.
const { ON_FILE } = require('./waivers');
const { one } = require('../db');
const { z, seasonFor } = require('./util');
const { conflict, notFound } = require('./errors');
const { audit } = require('./audit');
const { studentClash, clashWords } = require('./lessonrules');
const { recordConsent } = require('./consent');
const levels = require('./levels');

/** The words a family agrees to for texts and photos. */
const TEXT_WORDS = 'Text me about this lesson: check-in, changes and the recap. Message and data rates may apply. Reply STOP to stop.';
const PHOTO_WORDS = 'You may take photos of my child during the lesson for the lesson recap. You can change this any time.';

const SAFETY = ['allergies', 'medical', 'pickup', 'contact_name', 'contact_phone', 'contact_email'];
/** The safety details and consents a booking can carry (zod shape, all optional). */
const safetyShape = {
  allergies: z.string().trim().max(300).nullable().optional(),
  medical: z.string().trim().max(500).nullable().optional(),
  pickup: z.string().trim().max(300).nullable().optional(),
  contact_name: z.string().trim().max(150).nullable().optional(),
  contact_phone: z.string().trim().max(40).nullable().optional(),
  contact_email: z.union([z.string().trim().toLowerCase().email().max(255), z.literal('')]).nullable().optional(),
  text_ok: z.boolean().optional(),
  photo_ok: z.boolean().optional(),
  level: z.number().int().min(1).max(9).nullable().optional(),
};

/**
 * Books a student. opts: { sessionId, personId, details: { ...safetyShape }, signWaiver, useCreditId, requestedInstructorId }.
 * Returns { bookingId, session }. Throws 409 with words a person can act on.
 */
async function bookStudent(conn, req, { sessionId, personId, details = {}, signWaiver = false, useCreditId = null, requestedInstructorId = null }) {
  const tenantId = req.auth.tenantId;
  const s = await one(conn, 'SELECT * FROM lesson_sessions WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, sessionId]);
  if (!s) throw notFound('Lesson session');
  if (s.status !== 'scheduled') throw conflict(`Session is ${s.status}`, { person_id: personId });
  const season = seasonFor(s.starts_at.slice(0, 10));
  let waiver = await one(conn, ON_FILE, [tenantId, personId, season]);
  if (!waiver && signWaiver) {
    const [w] = await conn.query("INSERT INTO waivers (tenant_id, person_id, season, kind, method, recorded_by) VALUES (?, ?, ?, 'general', 'recorded_by_staff', ?)", [tenantId, personId, season, req.auth.userId || null]);
    await audit(conn, req, 'sign_waiver', 'waivers', w.insertId, { person_id: personId, season });
    waiver = { id: w.insertId };
  }
  if (!waiver) throw conflict('Student needs a signed waiver for this season before booking', { person_id: personId });
  const prior = await one(conn, 'SELECT id, status FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND person_id = ?', [tenantId, s.id, personId]);
  const already = prior && ['booked', 'attended'].includes(prior.status);
  if (!already) {
    const clash = await studentClash(conn, tenantId, personId, s.starts_at, s.ends_at, { ignoreSessionId: s.id });
    if (clash) throw conflict(clashWords(clash), { person_id: personId, clash });
    const { n } = await one(conn, "SELECT COUNT(*) AS n FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND status IN ('booked','attended')", [tenantId, s.id]);
    if (Number(n) >= s.capacity) throw conflict('Session is full', { person_id: personId });
    // a spot offered to the next family on the waitlist is theirs until the offer runs out (lib/lessonwaitlist.js)
    const { w } = await one(conn, "SELECT COUNT(*) AS w FROM lesson_waitlist WHERE tenant_id = ? AND session_id = ? AND status = 'offered' AND offer_expires_at > UTC_TIMESTAMP()", [tenantId, s.id]);
    if (Number(n) + Number(w) >= s.capacity) throw conflict(`The last ${Number(w) === 1 ? 'spot is' : `${w} spots are`} held for a family on the waitlist until their offer runs out`, { person_id: personId });
  }
  let creditId = null;
  if (useCreditId) {
    const credit = await one(conn, 'SELECT * FROM lesson_credits WHERE tenant_id = ? AND id = ? AND person_id = ? FOR UPDATE', [tenantId, useCreditId, personId]);
    if (!credit || credit.status !== 'active') throw conflict('That lesson package is not available for this student');
    if (credit.used >= credit.total) throw conflict('That lesson package has no lessons left');
    if (credit.expires_on && credit.expires_on < s.starts_at.slice(0, 10)) throw conflict(`That lesson package expires on ${credit.expires_on}, before this lesson`);
    creditId = credit.id;
  }
  if (already && creditId) throw conflict('That student is already booked into this lesson');
  // The level they were booked at: what staff said, else what is on file for the lesson's discipline.
  let level = details.level ?? null;
  if (!level) level = levels.personLevel(await one(conn, 'SELECT ski_level, snowboard_level FROM people WHERE tenant_id = ? AND id = ?', [tenantId, personId]), s.discipline);
  // A canceled booking can be revived; otherwise insert.
  const [r] = await conn.query(
    `INSERT INTO lesson_bookings (tenant_id, session_id, person_id, credit_id, requested_instructor_id) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE status = IF(status = 'cancelled', 'booked', status), credit_id = IF(status = 'booked' AND credit_id IS NULL, VALUES(credit_id), credit_id),
       requested_instructor_id = COALESCE(VALUES(requested_instructor_id), requested_instructor_id), id = LAST_INSERT_ID(id)`,
    [tenantId, s.id, personId, creditId, requestedInstructorId ?? null],
  );
  const bookingId = r.insertId;
  if (creditId) await conn.query('UPDATE lesson_credits SET used = used + 1 WHERE tenant_id = ? AND id = ?', [tenantId, creditId]);
  await saveDetails(conn, req, bookingId, personId, { ...details, level });
  await audit(conn, req, 'book', 'lesson_sessions', s.id, { person_id: personId, credit_id: creditId });
  return { bookingId, session: s };
}

/** Saves the safety details and consents given (only the fields present). A text "yes" is written to the consent ledger. */
async function saveDetails(conn, req, bookingId, personId, d) {
  const tenantId = req.auth.tenantId;
  const set = []; const vals = [];
  for (const k of SAFETY) if (d[k] !== undefined) { set.push(`${k} = ?`); vals.push(d[k] === '' ? null : d[k]); }
  for (const k of ['text_ok', 'photo_ok']) if (d[k] !== undefined) { set.push(`${k} = ?`); vals.push(d[k] ? 1 : 0); }
  if (d.level) { set.push('level = ?'); vals.push(d.level); }
  if (!set.length) return;
  const before = d.text_ok !== undefined ? await one(conn, 'SELECT text_ok FROM lesson_bookings WHERE tenant_id = ? AND id = ?', [tenantId, bookingId]) : null;
  await conn.query(`UPDATE lesson_bookings SET ${set.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, tenantId, bookingId]);
  if (before && Boolean(before.text_ok) !== Boolean(d.text_ok)) {
    await recordConsent(conn, tenantId, personId, 'sms', d.text_ok ? 'opted_in' : 'opted_out', 'lesson_booking', req.auth.userId ? { userId: req.auth.userId } : null);
  }
}

/** A student's guardian on file (person_links), or null. */
const guardianOf = (db, tenantId, personId) => one(db, `SELECT g.id, g.first_name, g.last_name, g.email, g.phone FROM person_links l JOIN people g ON g.tenant_id = l.tenant_id AND g.id = l.adult_id
    WHERE l.tenant_id = ? AND l.member_id = ? AND l.relation = 'guardian' ORDER BY g.id LIMIT 1`, [tenantId, personId]);

/**
 * What to fill the booking form with for a student: their last lesson booking's details, else the people row's
 * emergency contact. Staff only (it holds children's details).
 */
async function lastDetails(db, tenantId, personId) {
  const last = await one(db, `SELECT allergies, medical, pickup, contact_name, contact_phone, contact_email, text_ok, photo_ok FROM lesson_bookings
    WHERE tenant_id = ? AND person_id = ? AND (allergies IS NOT NULL OR medical IS NOT NULL OR pickup IS NOT NULL OR contact_name IS NOT NULL OR contact_phone IS NOT NULL OR contact_email IS NOT NULL)
    ORDER BY id DESC LIMIT 1`, [tenantId, personId]);
  const p = await one(db, 'SELECT emergency_name, emergency_phone, email, phone, ski_level, snowboard_level FROM people WHERE tenant_id = ? AND id = ?', [tenantId, personId]);
  if (!p) return null;
  // A child's own record rarely has an email: the guardian's is the one to send the confirmation to.
  const guardian = await guardianOf(db, tenantId, personId);
  return {
    allergies: last ? last.allergies : null, medical: last ? last.medical : null, pickup: last ? last.pickup : null,
    contact_name: (last && last.contact_name) || p.emergency_name || (guardian ? `${guardian.first_name} ${guardian.last_name}` : null),
    contact_phone: (last && last.contact_phone) || p.emergency_phone || (guardian && guardian.phone) || p.phone || null,
    contact_email: (last && last.contact_email) || (guardian && guardian.email) || p.email || null,
    text_ok: Boolean(last && last.text_ok), photo_ok: Boolean(last && last.photo_ok),
    ski_level: p.ski_level, snowboard_level: p.snowboard_level, from_last_booking: Boolean(last),
  };
}

module.exports = { bookStudent, saveDetails, lastDetails, guardianOf, safetyShape, SAFETY, TEXT_WORDS, PHOTO_WORDS };
