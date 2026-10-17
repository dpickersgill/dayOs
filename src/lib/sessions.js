'use strict';

// Sessions the server can end. A sign-in token carries a random session id (sid); the server keeps only its hash, and
// every request checks the session is still open: not signed out, not idle for longer than SESSION_IDLE_MINUTES (60),
// and not past its end (JWT_TTL, 8 hours). Signing out, changing a password and the console all end sessions at once.
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { pool } = require('../db');

const IDLE_MIN = () => Number(process.env.SESSION_IDLE_MINUTES || 60);
const hash = (sid) => crypto.createHash('sha256').update(String(sid)).digest('hex');
const ttlSeconds = () => {
  const v = String(config.jwtTtl || '8h'); const n = parseFloat(v);
  return /h$/.test(v) ? n * 3600 : /m$/.test(v) ? n * 60 : /d$/.test(v) ? n * 86400 : Number(v) || 8 * 3600;
};
const utc = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

/** Opens a session for a user and returns its signed token. iat (seconds) is set when it must not predate a change. */
async function open(user, req, { iat } = {}) {
  const sid = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const ip = req && req.ip ? crypto.createHash('sha256').update(`${config.linkSecret}:${req.ip}`).digest('hex') : null;
  const agent = req && req.get ? String(req.get('user-agent') || '').slice(0, 120) : null;
  await pool.query('INSERT INTO user_sessions (id_hash, tenant_id, user_id, created_at, last_seen, expires_at, ip_hash, agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [hash(sid), user.tenant_id, user.id, utc(now), utc(now), utc(new Date(now.getTime() + ttlSeconds() * 1000)), ip, agent]);
  const claims = { tid: user.tenant_id, role: user.role, sid };
  if (iat) claims.iat = iat;
  return jwt.sign(claims, config.jwtSecret, { algorithm: 'HS256', subject: String(user.id), expiresIn: config.jwtTtl });
}

/** The SQL that decides whether a session is open; used inside the sign-in check so it costs no extra round trip. */
const OPEN_SQL = `EXISTS (SELECT 1 FROM user_sessions s WHERE s.id_hash = ? AND s.user_id = u.id AND s.ended_at IS NULL
  AND s.expires_at > UTC_TIMESTAMP() AND s.last_seen > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE))`;
const openParams = (sid) => [hash(sid || ''), IDLE_MIN()];

/** Marks the session used (at most once a minute, so busy pages do not write on every request). */
function touch(sid) {
  pool.query('UPDATE user_sessions SET last_seen = UTC_TIMESTAMP() WHERE id_hash = ? AND last_seen < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE)', [hash(sid)]).catch(() => {});
}

async function end(sid, why = 'signed_out') {
  await pool.query('UPDATE user_sessions SET ended_at = UTC_TIMESTAMP(), ended_why = ? WHERE id_hash = ? AND ended_at IS NULL', [why, hash(sid)]);
}
/** Ends every open session of a user, except (optionally) the one making the change. */
async function endAll(db, userId, why, exceptSid) {
  await db.query(`UPDATE user_sessions SET ended_at = UTC_TIMESTAMP(), ended_why = ? WHERE user_id = ? AND ended_at IS NULL${exceptSid ? ' AND id_hash <> ?' : ''}`, exceptSid ? [why, userId, hash(exceptSid)] : [why, userId]);
}
/** The daily job: sessions over a month old are removed. */
async function prune() {
  const [r] = await pool.query('DELETE FROM user_sessions WHERE expires_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 DAY)');
  return r.affectedRows;
}

module.exports = { open, OPEN_SQL, openParams, touch, end, endAll, prune, hash };
