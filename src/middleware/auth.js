'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const { pool } = require('../db');
const demoUsage = require('../lib/demousage');
const sessions = require('../lib/sessions');
const { unauthorized, forbidden } = require('../lib/errors');

const MANAGER_ROLES = ['owner', 'manager'];

/** Must this login use two-step sign-in? (row: { role, require_mfa, sandbox }) */
const mfaRequired = (row) => Boolean(Number(row.require_mfa)) || (config.requireAdminMfa && MANAGER_ROLES.includes(row.role) && !Number(row.sandbox));

/**
 * Verifies the bearer token, then re-checks the user in the database on every request, so that
 * deactivating a login, changing a role, or changing a password takes effect immediately instead of
 * after the token expires. Sets req.auth = { tenantId, userId, role, staffId }.
 *
 * tenantId comes ONLY from the signed token, never from the request body, query or URL,
 * so one mountain can never read or write another mountain's rows.
 */
async function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return next(unauthorized());

  let payload;
  try {
    payload = jwt.verify(match[1], config.jwtSecret, { algorithms: ['HS256'] });
  } catch (_) {
    return next(unauthorized('Invalid or expired token'));
  }

  // A half-finished sign-in (password right, second step still to do) is not a session.
  if (payload.typ) return next(unauthorized('Invalid or expired token'));

  const userId = Number(payload.sub);
  const [rows] = await pool.query(
    `SELECT u.id, u.role, u.staff_id, u.totp_enabled, u.must_change_password,
       (u.staff_id IS NOT NULL AND EXISTS (SELECT 1 FROM patrol_members m JOIN staff s ON s.tenant_id = m.tenant_id AND s.id = m.staff_id AND s.status = 'active' WHERE m.tenant_id = u.tenant_id AND m.staff_id = u.staff_id)) AS on_patrol,
       t.require_mfa, t.status, (t.sandbox_expires_at IS NOT NULL) AS sandbox, (t.sandbox_expires_at IS NOT NULL AND t.sandbox_expires_at < NOW()) AS sandbox_over,
       ${sessions.OPEN_SQL} AS session_open FROM users u JOIN tenants t ON t.id = u.tenant_id
     WHERE u.id = ? AND u.tenant_id = ? AND u.active = 1
       AND (u.password_changed_at IS NULL OR UNIX_TIMESTAMP(u.password_changed_at) <= ?)`,
    [...sessions.openParams(payload.sid), userId, payload.tid, payload.iat],
  );
  if (!rows.length) return next(unauthorized('Session ended. Sign in again.'));
  // The server's own record of the session: signed out, idle too long, or ended from elsewhere.
  if (!payload.sid || !Number(rows[0].session_open)) return next(unauthorized('Session ended. Sign in again.'));
  sessions.touch(payload.sid);
  if (rows[0].status !== 'active') return next(forbidden('This mountain is paused. Contact SummitOps.'));
  if (rows[0].sandbox_over) return next(forbidden('This demo has ended. Start a new one, or ask SummitOps for a walkthrough.'));
  // When the mountain requires two-step sign-in, someone who has not set it up can only reach the setup screens.
  // Two-step sign-in is required when the mountain asks for it, and always for owners and managers (REQUIRE_ADMIN_MFA,
  // on in production), except in demo mountains.
  if (mfaRequired(rows[0]) && !rows[0].totp_enabled && !/\/auth\/(me|logout|mfa\/(setup|enable|status)|change-password)$/.test(req.originalUrl.split('?')[0])) {
    const err = forbidden('Set up two-step sign-in to continue');
    err.details = { code: 'mfa_enrollment_required' };
    return next(err);
  }

  // A temporary password (set by a manager) has to be replaced before anything else.
  if (rows[0].must_change_password && !/\/auth\/(me|logout|change-password|mfa\/(setup|enable|status))$/.test(req.originalUrl.split('?')[0])) {
    const err = forbidden('Choose a new password to continue');
    err.details = { code: 'password_change_required' };
    return next(err);
  }

  // onPatrol: this login's person is on the patrol roster, so they can use Patrol whatever their login role is.
  req.auth = { tenantId: payload.tid, userId, role: rows[0].role, staffId: rows[0].staff_id, onPatrol: Boolean(Number(rows[0].on_patrol)), sid: payload.sid };
  if (Number(rows[0].sandbox)) demoUsage.touch(payload.tid, req.originalUrl, req.method); // for the platform's Demos dashboard
  return next();
}

const isManager = (req) => MANAGER_ROLES.includes(req.auth.role);

/** Owner is allowed everywhere; other roles must be listed. */
function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.auth) return next(unauthorized());
    if (req.auth.role === 'owner' || roles.includes(req.auth.role)) return next();
    // Someone on the patrol roster can do what a patrol login can, whatever their login role (a lift operator who also patrols).
    if (req.auth.onPatrol && roles.includes('patrol')) return next();
    return next(forbidden('Your role cannot do that'));
  };
}

/** A new session's token. Async: the session is recorded first, so the server can end it later. */
function signToken(user, req) {
  return sessions.open(user, req);
}

module.exports = { authenticate, requireRole, signToken, isManager, mfaRequired };
