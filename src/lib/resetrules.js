'use strict';

// Who may reset whose password or two-step, who may give the patrol levels that open patient records, and the record of
// every change to what a login can reach (feat/auth-hardening).
//
// Resets (POST /users/:id/reset-password and /reset-mfa):
//   - the owner login: never here (the console, Verdynt/OS support, with a logged reason);
//   - a manager: only the owner;
//   - a patrol director or patrol admin (a login whose staff record is on the roster at Admin or Manager): only the owner
//     or a roster Admin (a real roster row at Admin, not a manager's implied Admin);
//   - someone whose only authority is patrol (a roster Admin who is not a manager): only logins whose role is patrol;
//   - a login whose patrol level, role or staff link was lowered in the last 24 hours, or ever by the person asking:
//     refused (the owner excepted). This stops "demote, reset, restore".
// Granting (lib/patrolaccess.js levels): giving or taking away Admin or Manager, per-person permissions, level rules and
// the review group need the owner or a roster Admin; nobody raises their own level. Linking a login to a staff record
// above Patrol (Admin, Manager, Approver) needs the owner or a roster Admin, and self-service never does it.
const { one, rows } = require('../db');
const { forbidden } = require('./errors');

const RANK = { host: 1, patrol: 2, approver: 3, manager: 4, admin: 5 };
const rank = (level) => RANK[level] || 0;
const LEADER_LEVELS = ['admin', 'manager'];
const ABOVE_PATROL = ['admin', 'manager', 'approver'];

/** The owner, or someone whose own staff record is on the roster at Admin. A manager's implied Admin does not count. */
async function rosterAdmin(db, req) {
  if (req.auth.role === 'owner') return true;
  if (!req.auth.staffId) return false;
  const m = await one(db, 'SELECT access_level FROM patrol_members WHERE tenant_id = ? AND staff_id = ?', [req.auth.tenantId, req.auth.staffId]);
  return Boolean(m && m.access_level === 'admin');
}

/** A staff record's patrol level, or null when it is not on the roster. */
async function levelOfStaff(db, tenantId, staffId) {
  if (!staffId) return null;
  const m = await one(db, 'SELECT access_level FROM patrol_members WHERE tenant_id = ? AND staff_id = ?', [tenantId, staffId]);
  return m ? m.access_level : null;
}

/** The logins linked to a staff record (to file a level change against each). */
async function loginsOf(db, tenantId, staffId) {
  return (await rows(db, 'SELECT id FROM users WHERE tenant_id = ? AND staff_id = ?', [tenantId, staffId])).map((r) => Number(r.id));
}

/** Records a change to what a login can reach. kind: lowered, raised, granted, linked, unlinked, role. */
async function record(db, req, { userId = null, staffId = null, kind, from = null, to = null }) {
  await db.query('INSERT INTO login_access_changes (tenant_id, user_id, staff_id, kind, from_value, to_value, by_user, at) VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
    [req.auth.tenantId, userId, staffId, kind, from === null ? null : String(from).slice(0, 40), to === null ? null : String(to).slice(0, 40), req.auth.userId]);
}

/**
 * A staff record's patrol level changed from `from` to `to` (null: off the roster). Filed against the staff record and
 * every login linked to it; a grant of Admin or Manager emails the owner.
 */
async function levelChanged(db, req, staffId, from, to) {
  if ((from || null) === (to || null)) return;
  const kind = rank(to) < rank(from) ? 'lowered' : LEADER_LEVELS.includes(to) ? 'granted' : 'raised';
  const logins = await loginsOf(db, req.auth.tenantId, staffId);
  if (!logins.length) await record(db, req, { staffId, kind, from, to });
  for (const userId of logins) await record(db, req, { userId, staffId, kind, from, to });
  if (kind === 'granted') {
    const p = await one(db, 'SELECT p.first_name, p.last_name FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE s.tenant_id = ? AND s.id = ?', [req.auth.tenantId, staffId]);
    const name = p ? `${p.first_name} ${p.last_name}` : `staff record ${staffId}`;
    require('./securitymail').tellOwner(req.auth.tenantId, `${name} was given the patrol ${to === 'admin' ? 'Admin' : 'Manager'} level`,
      [`${name} now has the patrol ${to === 'admin' ? 'Admin' : 'Manager'} level in Verdynt/OS. It opens every patient care record and lets them reset patrol logins.`]);
  }
}

/** Only the owner or a roster Admin may give, change or take away the Admin or Manager level (H2, 2026.11.12). */
async function mayChangeLevel(db, req, staffId, from, to) {
  const leader = LEADER_LEVELS.includes(from) || LEADER_LEVELS.includes(to);
  if (leader && !(await rosterAdmin(db, req))) throw forbidden('Only the owner or a patrol Admin on the roster can give or change the Admin or Manager level');
  if (req.auth.staffId && Number(staffId) === Number(req.auth.staffId) && rank(to) > rank(from) && req.auth.role !== 'owner') throw forbidden('You cannot raise your own patrol level. Ask the owner or another patrol Admin.');
}

/**
 * Linking a login to a staff record (creating a login for a person, changing its staff link, "add me as a responder"):
 * a staff record above Patrol needs the owner or a roster Admin (614). Returns the level for the caller to record.
 */
async function mayLink(db, req, staffId) {
  const level = await levelOfStaff(db, req.auth.tenantId, staffId);
  if (ABOVE_PATROL.includes(level) && !(await rosterAdmin(db, req))) {
    const err = forbidden('That person is on the patrol roster above Patrol. Only the owner or a patrol Admin can link a login to them.');
    err.details = { code: 'link_refused' };
    throw err;
  }
  return level;
}

/** A login was linked to a staff record above Patrol: recorded as a grant and the owner is told. */
async function linked(db, req, userId, staffId, level, from = 'login') {
  await record(db, req, { userId, staffId, kind: 'linked', from, to: level || 'none' });
  if (ABOVE_PATROL.includes(level)) {
    require('./securitymail').tellOwner(req.auth.tenantId, 'A login was linked to a patrol leader’s record',
      [`A login (id ${userId}) was linked to a staff record on the patrol roster at the ${level} level. That login can now open patient care records at that level.`]);
  }
}

const REFUSED = (msg) => { const e = forbidden(msg); e.details = { code: 'reset_refused' }; return e; };

/**
 * The login to reset, if this person may reset it (the rules at the top). Throws 403 with code reset_refused otherwise.
 * Returns { id, role, email, level }.
 */
async function resetTarget(db, req, targetId) {
  const t = await one(db, 'SELECT id, role, email, staff_id FROM users WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, targetId]);
  if (!t) { const e = new (require('./errors').AppError)(404, 'Login not found'); throw e; }
  const isOwner = req.auth.role === 'owner';
  const isManager = req.auth.role === 'manager';
  const admin = await rosterAdmin(db, req);
  if (Number(t.id) === Number(req.auth.userId)) throw REFUSED('Change your own password or two-step in Settings, Account');
  if (t.role === 'owner') throw REFUSED('The owner login is reset by Verdynt/OS support, after confirming it is them');
  if (t.role === 'manager' && !isOwner) throw REFUSED('Only the owner can reset a manager');
  const level = await levelOfStaff(db, req.auth.tenantId, t.staff_id);
  if (LEADER_LEVELS.includes(level) && !admin) throw REFUSED('A patrol director or patrol admin can be reset only by the owner or a patrol Admin. If none is available, Verdynt/OS support can do it after a phone call.');
  if (!isOwner && !isManager) {
    // Authority from the patrol roster only: patrol logins and nothing else.
    if (!admin) throw REFUSED('Your role cannot reset other logins');
    if (t.role !== 'patrol') throw REFUSED('A patrol Admin can reset patrol logins only. Ask a manager or the owner for this one.');
  }
  if (!isOwner) {
    const lowered = await one(db, `SELECT kind, (by_user = ?) AS mine FROM login_access_changes WHERE tenant_id = ? AND user_id = ? AND kind IN ('lowered','unlinked','role')
      AND (at > UTC_TIMESTAMP() - INTERVAL 24 HOUR OR by_user = ?) ORDER BY id DESC LIMIT 1`, [req.auth.userId, req.auth.tenantId, t.id, req.auth.userId]);
    if (lowered) throw REFUSED(Number(lowered.mine) ? 'You changed what this login can do, so someone else must reset it' : 'What this login can do was lowered in the last 24 hours, so it cannot be reset yet. Ask the owner.');
  }
  return { id: Number(t.id), role: t.role, email: t.email, level };
}

module.exports = { RANK, rank, LEADER_LEVELS, ABOVE_PATROL, rosterAdmin, levelOfStaff, loginsOf, record, levelChanged, mayChangeLevel, mayLink, linked, resetTarget };
