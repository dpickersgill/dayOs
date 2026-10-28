'use strict';

// Sessions the server can end. A sign-in token carries a random session id (sid); the server keeps only its hash, and
// every request checks the session is still open: not signed out, not idle for longer than SESSION_IDLE_MINUTES (60),
// and not past its end (JWT_TTL, 8 hours). Signing out, changing a password and the console all end sessions at once.
// A shared terminal's session ends after TERMINAL_IDLE_MINUTES (15) unused, and at once if the terminal is revoked.
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

/**
 * Opens a session for a user and returns its signed token. iat (seconds) is set when it must not predate a change.
 * method: how the person proved who they are (password, mfa, passkey, email, pin). steppedUp: counts as the second check
 * for sensitive actions for the next few minutes (a fresh passkey or two-step sign-in does).
 */
async function open(user, req, { iat, method = 'password', deviceHash = null, terminalId = null, steppedUp = false } = {}) {
  const sid = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const ip = req && req.ip ? crypto.createHash('sha256').update(`${config.linkSecret}:${req.ip}`).digest('hex') : null;
  const agent = req && req.get ? String(req.get('user-agent') || '').slice(0, 120) : null;
  await pool.query(`INSERT INTO user_sessions (id_hash, tenant_id, user_id, created_at, last_seen, expires_at, ip_hash, agent, method, device_hash, terminal_id, stepped_up_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [hash(sid), user.tenant_id, user.id, utc(now), utc(now), utc(new Date(now.getTime() + ttlSeconds() * 1000)), ip, agent, method, deviceHash, terminalId, steppedUp ? utc(now) : null]);
  const claims = { tid: user.tenant_id, role: user.role, sid };
  if (iat) claims.iat = iat;
  return jwt.sign(claims, config.jwtSecret, { algorithm: 'HS256', subject: String(user.id), expiresIn: config.jwtTtl });
}

/** A shared terminal's sessions end sooner when left alone (TERMINAL_IDLE_MINUTES, 15). */
const TERMINAL_IDLE_MIN = () => Number(process.env.TERMINAL_IDLE_MINUTES || 15);
/** How long a second check lasts for sensitive actions (STEP_UP_MINUTES, 10). */
const STEP_UP_MIN = () => Number(process.env.STEP_UP_MINUTES || 10);

/**
 * Columns for the sign-in check (users u LEFT JOIN user_sessions s): whether the session is open (not signed out, not
 * idle too long, not past its end, its terminal not revoked) and whether a second check was made recently.
 */
const STATE_SQL = `(s.id_hash IS NOT NULL AND s.ended_at IS NULL AND s.expires_at > UTC_TIMESTAMP()
    AND s.last_seen > DATE_SUB(UTC_TIMESTAMP(), INTERVAL IF(s.terminal_id IS NULL, ?, ?) MINUTE)
    AND (s.terminal_id IS NULL OR EXISTS (SELECT 1 FROM terminals x WHERE x.id = s.terminal_id AND x.tenant_id = s.tenant_id AND x.revoked_at IS NULL))) AS session_open,
  (s.stepped_up_at IS NOT NULL AND s.stepped_up_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)) AS stepped_up,
  s.method AS session_method, s.terminal_id AS session_terminal, s.device_hash AS session_device, s.display AS session_display`;
const stateParams = () => [IDLE_MIN(), TERMINAL_IDLE_MIN(), STEP_UP_MIN()];
const JOIN_SQL = 'LEFT JOIN user_sessions s ON s.id_hash = ? AND s.user_id = u.id';

/** The person proved it was them again: sensitive actions are allowed for the next STEP_UP_MINUTES. */
async function steppedUp(sid) {
  await pool.query('UPDATE user_sessions SET stepped_up_at = UTC_TIMESTAMP() WHERE id_hash = ? AND ended_at IS NULL', [hash(sid)]);
}

/**
 * Marks the session used (at most once a minute, so busy pages do not write on every request). The middleware skips it for
 * background polls (x-poll: 1), so a tab nobody touches still ends after SESSION_IDLE_MINUTES.
 */
function touch(sid) {
  pool.query('UPDATE user_sessions SET last_seen = UTC_TIMESTAMP() WHERE id_hash = ? AND last_seen < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE)', [hash(sid)]).catch(() => {});
}

/**
 * The patrol-room screen: this session becomes the room's display (display = 'patrol_room'). It can then only show who is
 * on duty and sign people in and out (ROOM_PATHS in middleware/auth.js), and the last second check is cleared, so leaving
 * the screen needs the leader's passkey, code or password again.
 */
async function setDisplay(sid, display) {
  await pool.query(`UPDATE user_sessions SET display = ?${display ? ', stepped_up_at = NULL' : ''} WHERE id_hash = ? AND ended_at IS NULL`, [display, hash(sid)]);
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

module.exports = { open, STATE_SQL, stateParams, JOIN_SQL, steppedUp, STEP_UP_MIN, TERMINAL_IDLE_MIN, touch, setDisplay, end, endAll, prune, hash };
