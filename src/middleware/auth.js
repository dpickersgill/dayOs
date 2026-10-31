'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const { pool } = require('../db');
const demoUsage = require('../lib/demousage');
const sessions = require('../lib/sessions');
const { unauthorized, forbidden } = require('../lib/errors');

const MANAGER_ROLES = ['owner', 'manager'];
const CREW_ROLES = ['counter', 'instructor', 'staff'];

/**
 * Who must use two-step sign-in (an authenticator app or a passkey), tier by tier. Returns why, or null.
 *   mountain     the owner turned it on for everyone
 *   manager      owners and managers (REQUIRE_ADMIN_MFA, on in production)
 *   patrol_lead  patrol Admins and Managers (they run the team and its records)
 *   patrol       patrollers, who see patient details (unless the owner turned it off, and after a two-week start)
 *   school_director  an instructor login set to Director in Ski school (it sells, refunds and approves pay)
 * Counter, instructor and lift staff are not forced: they use a password, or a PIN on an enrolled terminal.
 * Demo mountains are exempt from the tiers. row: the sign-in check's columns.
 */
function mfaRule(row) {
  if (Number(row.require_mfa)) return 'mountain';
  if (!config.requireAdminMfa || Number(row.sandbox)) return null;
  if (MANAGER_ROLES.includes(row.role)) return 'manager';
  if (row.role === 'area') return 'area'; // reads approved patient reports
  if (Number(row.patrol_lead)) return 'patrol_lead';
  if (row.role === 'instructor' && row.school_access === 'director') return 'school_director';
  if ((row.role === 'patrol' || Number(row.on_patrol)) && !Number(row.patrol_host) && Number(row.mfa_for_patrol ?? 1) && Number(row.patrol_mfa_due ?? 1)) return 'patrol';
  return null;
}
const mfaRequired = (row) => Boolean(mfaRule(row));

/** The columns mfaRule needs, for a query over users u JOIN tenants t. */
const TIER_SQL = `(u.totp_enabled = 1 OR EXISTS (SELECT 1 FROM user_passkeys k WHERE k.user_id = u.id)) AS strong,
  (u.staff_id IS NOT NULL AND EXISTS (SELECT 1 FROM patrol_members m JOIN staff s2 ON s2.tenant_id = m.tenant_id AND s2.id = m.staff_id AND s2.status = 'active' WHERE m.tenant_id = u.tenant_id AND m.staff_id = u.staff_id)) AS on_patrol,
  (u.staff_id IS NOT NULL AND EXISTS (SELECT 1 FROM patrol_members m WHERE m.tenant_id = u.tenant_id AND m.staff_id = u.staff_id AND m.access_level IN ('admin','manager'))) AS patrol_lead,
  (u.staff_id IS NOT NULL AND EXISTS (SELECT 1 FROM patrol_members m WHERE m.tenant_id = u.tenant_id AND m.staff_id = u.staff_id AND m.access_level = 'host')) AS patrol_host,
  (SELECT ip.school_access FROM instructor_profiles ip JOIN staff s3 ON s3.tenant_id = ip.tenant_id AND s3.id = ip.staff_id AND s3.status = 'active' WHERE ip.tenant_id = u.tenant_id AND ip.staff_id = u.staff_id) AS school_access,
  t.require_mfa, t.mfa_for_patrol, (t.patrol_mfa_from IS NULL OR t.patrol_mfa_from <= CURDATE()) AS patrol_mfa_due, t.patrol_mfa_from,
  (t.sandbox_expires_at IS NOT NULL) AS sandbox`;

// The ski area's read-only login reaches its own sign-in settings and the patrol summary, and nothing else.
const AREA_PATHS = /^\/api\/v1\/(auth\/|area(\/|$)|whats-new)/;

// The patrol-room screen (a leader's session turned into the room's display) reaches only these: who is on duty, signing
// people in and out, and leaving the screen with a second check or signing out (which turns this device's alerts off).
// Never a patient record.
const ROOM_PATHS = /^\/api\/v1\/(patrol\/(duty|duty\/sign-in|duty\/sign-out|room|room\/end|alerts\/unsubscribe)|auth\/(me|logout|closing|back|step-up|step-up\/options))$/;

// While two-step is still to be set up, or a temporary password replaced, only these are open.
const SETUP_PATHS = /\/auth\/(me|logout|closing|back|change-password|mfa\/(setup|enable|status)|passkeys(\/options)?)$/;

/**
 * Verifies the bearer token, then re-checks the user in the database on every request, so that
 * deactivating a login, changing a role, or changing a password takes effect immediately instead of
 * after the token expires. Sets req.auth = { tenantId, userId, role, staffId, onPatrol, sid, method, terminalId, steppedUp, strong, display, schoolLevel }.
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
  let rows;
  try {
    [rows] = await pool.query(
      `SELECT u.id, u.role, u.staff_id, u.totp_enabled, u.must_change_password, (u.access_ends_on IS NOT NULL AND u.access_ends_on < CURDATE()) AS access_over,
         ${TIER_SQL}, t.status, (t.sandbox_expires_at IS NOT NULL AND t.sandbox_expires_at < NOW()) AS sandbox_over,
         ${sessions.STATE_SQL}
       FROM users u JOIN tenants t ON t.id = u.tenant_id ${sessions.JOIN_SQL}
       WHERE u.id = ? AND u.tenant_id = ? AND u.active = 1
         AND (u.password_changed_at IS NULL OR UNIX_TIMESTAMP(u.password_changed_at) <= ?)`,
      [...sessions.stateParams(), sessions.hash(payload.sid || ''), userId, payload.tid, payload.iat],
    );
  } catch (err) { return next(err); }
  if (!rows.length) return next(unauthorized('Session ended. Sign in again.'));
  const row = rows[0];
  // The server's own record of the session: signed out, idle too long, or ended from elsewhere.
  if (!payload.sid || !Number(row.session_open)) return next(unauthorized('Session ended. Sign in again.'));
  if (Number(row.access_over)) return next(unauthorized('Your access has ended for the season. Ask a manager if you are coming back.'));
  const display = row.session_display || null;
  // A background poll (x-poll: 1) is not someone using the app, so it does not keep the session open. The patrol-room
  // screen is the exception: it stays up all day, and can do nothing but the room's own work (below).
  if (req.headers['x-poll'] !== '1' || display) sessions.touch(payload.sid);
  // A poll from a tab that is on screen: someone still has the app open, so a closing mark (a reload whose first request
  // beat the closing notice) is cleared. It is still not use, so the idle limit applies (lib/sessions.js).
  else if (req.headers['x-visible'] === '1' && Number(row.session_closing)) sessions.shown(payload.sid);
  if (row.status !== 'active') return next(forbidden('This mountain is paused. Contact Verdynt/OS.'));
  if (row.sandbox_over) return next(forbidden('This demo has ended. Start a new one, or ask Verdynt/OS for a walkthrough.'));
  const path = req.originalUrl.split('?')[0];
  if (display === 'patrol_room' && !ROOM_PATHS.test(path)) {
    const err = forbidden('This is the patrol-room screen. Leave it with your password, passkey or code first.');
    err.details = { code: 'room_screen' };
    return next(err);
  }
  // Two-step sign-in, tier by tier (mfaRule): someone who must have it and has not set it up can only reach the setup screens.
  if (mfaRequired(row) && !Number(row.strong) && !SETUP_PATHS.test(path)) {
    const err = forbidden('Set up two-step sign-in to continue');
    err.details = { code: 'mfa_enrollment_required', why: mfaRule(row) };
    return next(err);
  }

  // A temporary password (set by a manager) has to be replaced before anything else.
  if (row.must_change_password && !SETUP_PATHS.test(path)) {
    const err = forbidden('Choose a new password to continue');
    err.details = { code: 'password_change_required' };
    return next(err);
  }

  if (row.role === 'area' && !AREA_PATHS.test(path)) return next(forbidden('This login shows the patrol summary and approved reports only'));

  // onPatrol: this login's person is on the patrol roster, so they can use Patrol whatever their login role is.
  req.auth = {
    tenantId: payload.tid, userId, role: row.role, staffId: row.staff_id, onPatrol: Boolean(Number(row.on_patrol)), sid: payload.sid,
    method: row.session_method, terminalId: row.session_terminal ? Number(row.session_terminal) : null, deviceHash: row.session_device || null,
    steppedUp: Boolean(Number(row.stepped_up)), strong: Boolean(Number(row.strong)), mfaRule: mfaRule(row), display,
    schoolLevel: row.role === 'instructor' ? (row.school_access || 'instructor') : null, // lib/schoolaccess.js
  };
  if (Number(row.sandbox)) demoUsage.touch(payload.tid, req.originalUrl, req.method); // for the platform's Demos dashboard
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
function signToken(user, req, opts) {
  return sessions.open(user, req, opts);
}

module.exports = { authenticate, requireRole, signToken, isManager, mfaRequired, mfaRule, TIER_SQL, MANAGER_ROLES, CREW_ROLES };
