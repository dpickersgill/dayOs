'use strict';
// Lessons sold at the window (Sell, routes/checkout.js), Track LINEUP: the safety details and consents asked for each
// lesson line, the lesson list by day with levels and ages, the different-day warning, what the receipt says about a
// lesson, and the confirmation after the sale.
const { pool, one } = require('../db');
const { z, addDays } = require('./util');
const L = require('./levels');
const { recordConsent } = require('./consent');
const { baseUrl } = require('./baseurl');

const text = (n) => z.string().trim().max(n).optional();
/** The same fields as the counter's booking dialog (CORE) and the public booking page (PARENTS). */
const safetySchema = z.object({
  allergies: text(300), medical: text(500), pickup: text(300),
  contact_name: text(150), contact_phone: text(40), contact_email: z.string().trim().email().max(255).optional().or(z.literal('')),
  text_ok: z.boolean().optional(), photo_ok: z.boolean().optional(),
});

/** Saves a lesson line's safety details on its booking, the level it was booked at, and a text consent when given. */
async function saveSafety(conn, req, tenantId, bookingId, personId, session, safety) {
  const p = await one(conn, 'SELECT ski_level, snowboard_level, emergency_name, emergency_phone FROM people WHERE tenant_id = ? AND id = ?', [tenantId, personId]);
  const level = L.personLevel(p, session.discipline);
  await conn.query('UPDATE lesson_bookings SET level = COALESCE(level, ?) WHERE tenant_id = ? AND id = ?', [level || null, tenantId, bookingId]);
  if (!safety) return;
  const v = (k) => (safety[k] === undefined || safety[k] === '' ? null : safety[k]);
  await conn.query(`UPDATE lesson_bookings SET allergies = ?, medical = ?, pickup = ?, contact_name = ?, contact_phone = ?, contact_email = ?, text_ok = ?, photo_ok = ?
    WHERE tenant_id = ? AND id = ?`, [v('allergies'), v('medical'), v('pickup'), v('contact_name') || (p && p.emergency_name) || null, v('contact_phone') || (p && p.emergency_phone) || null,
    v('contact_email'), safety.text_ok ? 1 : 0, safety.photo_ok ? 1 : 0, tenantId, bookingId]);
  if (safety.text_ok) await recordConsent(conn, tenantId, personId, 'sms', 'opted_in', 'lesson_window', { userId: req.auth.userId });
}

const dayWords = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * A warning (never a refusal) when a basket has a lesson and a lift ticket for different days: the usual mistake at a
 * busy window is a ticket for today with tomorrow's lesson. A season pass covers every day.
 */
function dayWarnings(priced) {
  const lessons = priced.filter((p) => p.type === 'lesson' && !p.pkg && p.day);
  const tickets = priced.filter((p) => p.type === 'ticket' && p.product && ['day_ticket', 'multi_day', 'punch_card'].includes(p.product.kind));
  if (!lessons.length || !tickets.length || priced.some((p) => p.type === 'ticket' && p.product && p.product.kind === 'season_pass')) return [];
  const covered = new Set();
  for (const t of tickets) for (let i = 0; i < Math.max(Number(t.product.valid_days) || 1, 1); i++) covered.add(addDays(t.validOn, i));
  const out = [];
  for (const d of [...new Set(lessons.map((l) => l.day))]) {
    if (covered.has(d)) continue;
    const tDays = [...new Set(tickets.map((t) => t.validOn))].map(dayWords).join(' and ');
    out.push(`The lesson is on ${dayWords(d)}, but the lift ticket is for ${tDays}. Check the days match.`);
  }
  return out;
}

/** The lesson list for Sell's day strip. */
function menuLessons(sessions, now) {
  return sessions.map((s) => ({
    ...s, spots_left: Math.max(s.capacity - Number(s.booked), 0), started: String(s.starts_at) <= now,
    level_words: L.range(s.level_min, s.level_max), age_words: ageWords(s.age_min, s.age_max), instructor_first: s.instructor_first || null,
  }));
}
/** 'Ages 4 to 12', 'Ages 18 and up', 'All ages' */
function ageWords(min, max) {
  const a = Number(min) || null; const b = Number(max) || null;
  if (!a && !b) return 'All ages';
  if (a && !b) return `Ages ${a} and up`;
  if (!a && b) return `Up to age ${b}`;
  return a === b ? `Age ${a}` : `Ages ${a} to ${b}`;
}

/** What the receipt and the sale screen say about a lesson: the student, the time, where to meet, the instructor. */
async function receiptBits(db, tenantId, s, personId) {
  const p = await one(db, 'SELECT first_name, last_name FROM people WHERE tenant_id = ? AND id = ?', [tenantId, personId]);
  const t = s.instructor_id ? await one(db, 'SELECT p.first_name FROM staff st JOIN people p ON p.tenant_id = st.tenant_id AND p.id = st.person_id WHERE st.tenant_id = ? AND st.id = ?', [tenantId, s.instructor_id]) : null;
  return { student: p ? `${p.first_name} ${p.last_name}` : null, ends_at: s.ends_at, meeting_place: s.meeting_place || null, instructor_first: t ? t.first_name : null, level_words: L.range(s.level_min, s.level_max) };
}

/** After the sale commits: each lesson's confirmation (CORE's lessonconfirm). Never throws. */
async function confirmAll(req, lessons) {
  if (!lessons || !lessons.length) return;
  const { sendConfirmation } = require('./lessonconfirm');
  for (const l of lessons) {
    try { l.confirmation = await sendConfirmation(pool, req.auth.tenantId, l.booking_id, baseUrl(req), { via: 'window' }); } catch (err) { l.confirmation = { ok: false, error: err.message }; }
  }
}

module.exports = { safetySchema, saveSafety, dayWarnings, menuLessons, ageWords, receiptBits, confirmAll, dayWords };
