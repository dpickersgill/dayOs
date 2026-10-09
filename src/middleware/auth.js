'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const { pool } = require('../db');
const demoUsage = require('../lib/demousage');
const { unauthorized, forbidden } = require('../lib/errors');

const MANAGER_ROLES = ['owner', 'manager'];

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
    `SELECT u.id, u.role, u.staff_id, u.totp_enabled, t.require_mfa, t.status, (t.sandbox_expires_at IS NOT NULL) AS sandbox, (t.sandbox_expires_at IS NOT NULL AND t.sandbox_expires_at < NOW()) AS sandbox_over FROM users u JOIN tenants t ON t.id = u.tenant_id
     WHERE u.id = ? AND u.tenant_id = ? AND u.active = 1
       AND (u.password_changed_at IS NULL OR UNIX_TIMESTAMP(u.password_changed_at) <= ?)`,
    [userId, payload.tid, payload.iat],
  );
  if (!rows.length) return next(unauthorized('Session ended. Sign in again.'));
  if (rows[0].status !== 'active') return next(forbidden('This mountain is paused. Contact SummitOps.'));
  if (rows[0].sandbox_over) return next(forbidden('This demo has ended. Start a new one, or ask SummitOps for a walkthrough.'));
  // When the mountain requires two-step sign-in, someone who has not set it up can only reach the setup screens.
  if (rows[0].require_mfa && !rows[0].totp_enabled && !/\/auth\/(me|mfa\/(setup|enable|status)|change-password)$/.test(req.originalUrl.split('?')[0])) {
    const err = forbidden('Set up two-step sign-in to continue');
    err.details = { code: 'mfa_enrollment_required' };
    return next(err);
  }

  req.auth = { tenantId: payload.tid, userId, role: rows[0].role, staffId: rows[0].staff_id };
  if (Number(rows[0].sandbox)) demoUsage.touch(payload.tid, req.originalUrl, req.method); // for the platform's Demos dashboard
  return next();
}

const isManager = (req) => MANAGER_ROLES.includes(req.auth.role);

/** Owner is allowed everywhere; other roles must be listed. */
function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.auth) return next(unauthorized());
    if (req.auth.role === 'owner' || roles.includes(req.auth.role)) return next();
    return next(forbidden('Your role cannot do that'));
  };
}

function signToken(user) {
  return jwt.sign({ tid: user.tenant_id, role: user.role }, config.jwtSecret, {
    algorithm: 'HS256',
    subject: String(user.id),
    expiresIn: config.jwtTtl,
  });
}

module.exports = { authenticate, requireRole, signToken, isManager };
