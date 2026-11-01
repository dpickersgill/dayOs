'use strict';
// The family's private link for one lesson booking: check in ("We're here"), see the details, change the date, read the
// recap and add a tip. Only a hash of the token is kept (lesson_bookings.token_sha); the token itself goes in the email.
// A new link replaces the old one. The page is at <base>/lesson/<mountain>/<token>.
const crypto = require('crypto');
const { one } = require('../db');

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const looksRight = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{32,64}$/.test(t);

/** Makes a new link token for a booking and returns it. */
async function issue(conn, tenantId, bookingId) {
  const token = crypto.randomBytes(24).toString('base64url');
  await conn.query('UPDATE lesson_bookings SET token_sha = ? WHERE tenant_id = ? AND id = ?', [sha(token), tenantId, bookingId]);
  return token;
}

// A link stops working LESSON_LINK_DAYS (60) days after its lesson ended (2026.11.11): before, a family link (a child's
// name, lesson times, where to meet) worked for ever, from any old email.
const DAYS = () => Number(process.env.LESSON_LINK_DAYS) || 60;
const expired = (b) => Boolean(b && b.ends_at) && new Date(`${String(b.ends_at).slice(0, 19).replace(' ', 'T')}Z`).getTime() + DAYS() * 86_400_000 < Date.now();

/** The booking a token belongs to, with its lesson, or null (also once the link has run out). */
async function find(db, tenantId, token) {
  if (!looksRight(token)) return null;
  const b = await findAny(db, tenantId, token);
  return b && !expired(b) ? b : null;
}
async function findAny(db, tenantId, token) {
  return one(db, `SELECT b.*, s.starts_at, s.ends_at, s.status AS session_status, s.discipline, s.level_min, s.level_max, s.meeting_place,
      s.instructor_id, s.product_id, s.format, s.delay_minutes, pr.name AS product, p.first_name, p.last_name
    FROM lesson_bookings b
    JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id
    JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
    JOIN people p ON p.tenant_id = b.tenant_id AND p.id = b.person_id
    WHERE b.tenant_id = ? AND b.token_sha = ?`, [tenantId, sha(token)]);
}

/** The family's page for a booking. */
const url = (base, slug, token) => `${base}/lesson/${encodeURIComponent(slug)}/${token}`;

module.exports = { issue, find, url, sha, looksRight, expired };
