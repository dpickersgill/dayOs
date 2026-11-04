'use strict';

// Security notices to a login's own email (feat/auth-hardening): one plain message for each change to how someone signs
// in, so a change they did not make does not go unnoticed. Each says what changed, when (UTC), from which device (the
// same "where" as the new-device email: a label such as "Chrome on Windows"), and what to do if it was not them. Never
// a password, a code or a link that signs in. Sent without waiting; a login with no email gets nothing.
const { one } = require('../db');
const mailer = require('./mailer');
const { label } = require('./devices');

const WHAT = {
  password_changed: ['Your Verdynt/OS password was changed', 'The password for your login was changed.'],
  password_reset: ['A manager set a new password for your Verdynt/OS login', 'Someone at your mountain set a new password for your login. Every device was signed out.'],
  mfa_reset: ['Two-step sign-in was reset on your Verdynt/OS login', 'Someone at your mountain reset your two-step sign-in: your authenticator app, recovery codes and passkeys were removed. Every device was signed out.'],
  console_reset: ['Verdynt/OS support set a new password for your login', 'Verdynt/OS support set a new password for your login, after confirming it was you. Every device was signed out.'],
  mfa_on: ['Two-step sign-in is on for your Verdynt/OS login', 'An authenticator app was set up for your login. Signing in now needs a code from it.'],
  mfa_off: ['Two-step sign-in was turned off on your Verdynt/OS login', 'The authenticator app was turned off for your login.'],
  recovery_codes: ['New recovery codes for your Verdynt/OS login', 'A new set of recovery codes was made for your login. The old ones no longer work.'],
  passkey_added: ['A passkey was added to your Verdynt/OS login', 'A new passkey was added to your login. It can sign in on its own.'],
  passkey_removed: ['A passkey was removed from your Verdynt/OS login', 'A passkey was removed from your login.'],
};
const NOT_YOU = 'If this was not you, sign in, change your password, and in Settings, under "Where you are signed in", sign out everywhere else. Then tell your manager or the owner straight away.';
const NOT_YOU_RESET = 'If you did not expect this, tell the owner or your patrol director straight away.';

const when = () => new Date().toUTCString().replace(' GMT', ' UTC');

/** Tells a login about a change to its sign-in. kind: a key of WHAT. byOther: someone else did it (a reset). */
async function notify(req, userId, kind, { byOther = false } = {}) {
  try {
    const [subject, said] = WHAT[kind];
    const u = await one(require('../db').pool, 'SELECT u.email, u.username, u.tenant_id, t.name AS tenant_name FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = ?', [userId]);
    if (!u || !u.email) return;
    const device = req && req.get ? label(req.get('user-agent')) : 'an unknown device';
    const text = `${said}\n\nLogin: ${u.username || u.email} at ${u.tenant_name}\nWhen: ${when()}\nFrom: ${device}\n\n${byOther ? NOT_YOU_RESET : NOT_YOU}`;
    mailer.send({ tenantId: u.tenant_id, to: u.email, fromName: `${u.tenant_name} (Verdynt/OS)`, tag: `security-${kind.replace(/_/g, '-')}`, subject, text }).catch(() => {});
  } catch (e) { console.error('Could not send a security notice', e.message); }
}

/** Tells the mountain's owner something about patrol record access (a patrol Admin granted, a login linked, a setting changed). */
async function tellOwner(tenantId, subject, lines) {
  try {
    const db = require('../db').pool;
    const o = await one(db, "SELECT u.email, t.name FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.tenant_id = ? AND u.role = 'owner' AND u.active = 1 AND u.email IS NOT NULL ORDER BY u.id LIMIT 1", [tenantId]);
    if (!o) return;
    const text = `${lines.join('\n')}\n\nWhen: ${when()}\n\nIf you did not expect this, open Patrol, Team, Access to check who has which level, and tell Verdynt/OS support if anything looks wrong.`;
    mailer.send({ tenantId, to: o.email, fromName: `${o.name} (Verdynt/OS)`, tag: 'security-owner-notice', subject, text }).catch(() => {});
  } catch (e) { console.error('Could not tell the owner', e.message); }
}

module.exports = { notify, tellOwner, WHAT };
