'use strict';

// Your own sign-in security (Account): passkeys, the second check before sensitive actions, where you are signed in,
// the devices you have used, your terminal PIN; and for managers, the mountain's shared terminals and the patrol rule.
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool, one, rows } = require('../db');
const { authenticate, requireRole, CREW_ROLES } = require('../middleware/auth');
const passkeys = require('../lib/passkeys');
const challenges = require('../lib/challenges');
const sessions = require('../lib/sessions');
const totp = require('../lib/totp');
const { stepUp } = require('../lib/stepup');
const { z, validate, paramId } = require('../lib/util');
const { bad, forbidden, notFound } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();
const limit = rateLimit({ windowMs: 60_000, max: Number(process.env.LOGIN_RATE_LIMIT) || 20, message: 'Too many attempts', keyOf: (req) => `sec:${req.ip}` });
const me = (req) => one(pool, 'SELECT * FROM users WHERE id = ? AND tenant_id = ?', [req.auth.userId, req.auth.tenantId]);
const notOnTerminal = (req, _res, next) => (req.auth.method === 'pin' ? next(forbidden('Sign in with your password (not your PIN) to change your sign-in settings')) : next());
const manager = requireRole('manager');
const shortId = (h) => String(h).slice(0, 16);

/** Everything the Account screen shows about signing in. */
router.get('/auth/security', authenticate, async (req, res) => {
  const user = await me(req);
  const [keys, open, seen] = await Promise.all([
    passkeys.listFor('user', user.id),
    rows(pool, `SELECT s.id_hash, s.created_at, s.last_seen, s.agent, s.method, s.device_hash, x.name AS terminal FROM user_sessions s LEFT JOIN terminals x ON x.id = s.terminal_id
      WHERE s.user_id = ? AND s.ended_at IS NULL AND s.expires_at > UTC_TIMESTAMP() AND s.last_seen > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE) ORDER BY s.last_seen DESC LIMIT 30`, [user.id, Number(process.env.SESSION_IDLE_MINUTES || 60)]),
    rows(pool, 'SELECT id, device_hash, label, first_seen, last_seen FROM user_devices WHERE user_id = ? ORDER BY last_seen DESC LIMIT 30', [user.id]),
  ]);
  const label = require('../lib/devices').label;
  const mine = sessions.hash(req.auth.sid);
  res.json({
    passkeys: keys.map((k) => ({ id: k.id, name: k.name, created_at: k.created_at, last_used_at: k.last_used_at })),
    app_enabled: Boolean(user.totp_enabled), pin_set: Boolean(user.pin_hash), can_have_pin: CREW_ROLES.includes(user.role),
    sessions: open.map((s) => ({ id: shortId(s.id_hash), current: s.id_hash === mine, created_at: s.created_at, last_seen: s.last_seen, device: s.terminal ? `Shared terminal: ${s.terminal}` : label(s.agent), method: s.method })),
    devices: seen.map((d) => ({ id: d.id, label: d.label, first_seen: d.first_seen, last_seen: d.last_seen, current: d.device_hash === req.auth.deviceHash })),
    signed_in_with: req.auth.method,
  });
});

// ---------------------------------------------------------------- passkeys
router.post('/auth/passkeys/options', authenticate, notOnTerminal, limit, async (req, res) => {
  const user = await me(req);
  const t = await one(pool, 'SELECT name FROM tenants WHERE id = ?', [user.tenant_id]);
  res.json(await passkeys.registrationOptions(req, { kind: 'user', ownerId: user.id, tenantId: user.tenant_id, userName: `${user.username || user.email} (${t.name})`, displayName: user.username || user.email }));
});

router.post('/auth/passkeys', authenticate, notOnTerminal, limit, validate(z.object({ handle: z.string().max(100), response: z.any(), name: z.string().trim().max(60).optional() })), async (req, res) => {
  const user = await me(req);
  const id = await passkeys.register(req, { kind: 'user', ownerId: user.id, tenantId: user.tenant_id, handle: req.body.handle, response: req.body.response, name: req.body.name || require('../lib/devices').label(req.get('user-agent')) });
  await sessions.steppedUp(req.auth.sid); // they just proved it with the passkey
  await audit(pool, req, 'passkey_add', 'users', user.id, { passkey: id });
  res.status(201).json({ id });
});

router.patch('/auth/passkeys/:id', authenticate, notOnTerminal, validate(z.object({ name: z.string().trim().min(1).max(60) })), async (req, res) => {
  const [r] = await pool.query('UPDATE user_passkeys SET name = ? WHERE id = ? AND user_id = ?', [req.body.name, paramId(req), req.auth.userId]);
  if (!r.affectedRows) throw notFound('Passkey');
  res.json({ ok: true });
});

router.delete('/auth/passkeys/:id', authenticate, notOnTerminal, stepUp('remove a passkey'), async (req, res) => {
  const user = await me(req);
  const left = await passkeys.count('user', user.id);
  if (req.auth.mfaRule && left <= 1 && !user.totp_enabled) throw forbidden('This is your only second step, and you must have one. Add another passkey or an authenticator app first.');
  const [r] = await pool.query('DELETE FROM user_passkeys WHERE id = ? AND user_id = ?', [paramId(req), user.id]);
  if (!r.affectedRows) throw notFound('Passkey');
  await audit(pool, req, 'passkey_remove', 'users', user.id, { passkey: paramId(req) });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- the second check
/** How this person can confirm it is them: a passkey (with its challenge ready), their app's code, or their password. */
router.post('/auth/step-up/options', authenticate, limit, async (req, res) => {
  const user = await me(req);
  const keys = await passkeys.count('user', user.id);
  const methods = [];
  if (keys) methods.push('passkey');
  if (user.totp_enabled) methods.push('app');
  if (!methods.length) methods.push('password');
  res.json({ methods, passkey: keys ? await passkeys.authenticationOptions(req, { kind: 'user', purpose: 'stepup', ownerId: user.id, tenantId: user.tenant_id }) : null, minutes: sessions.STEP_UP_MIN() });
});

router.post('/auth/step-up', authenticate, limit, validate(z.object({ password: z.string().max(200).optional(), code: z.string().max(20).optional(), handle: z.string().max(100).optional(), response: z.any().optional() })), async (req, res) => {
  const user = await me(req);
  const strong = user.totp_enabled || (await passkeys.count('user', user.id)) > 0;
  let how = null;
  if (req.body.response) {
    await passkeys.authenticate(req, { kind: 'user', purpose: 'stepup', handle: req.body.handle, response: req.body.response, ownerId: user.id });
    how = 'passkey';
  } else if (req.body.code && user.totp_enabled) {
    const step = totp.verify(totp.open(user.totp_secret), req.body.code);
    if (step === null || (user.totp_last_step !== null && step <= Number(user.totp_last_step))) throw forbidden('That code is not right. Use the newest one in your app.');
    const [r] = await pool.query('UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)', [step, user.id, step]);
    if (r.affectedRows !== 1) throw forbidden('That code was just used. Wait for the next one.');
    how = 'app';
  } else if (req.body.password !== undefined) {
    // Someone with a passkey or an app must use it: a password alone is what an attacker would have.
    if (strong) throw forbidden('Use your passkey or the code from your app');
    if (!(await bcrypt.compare(req.body.password, user.password_hash))) throw forbidden('That password is not right');
    how = 'password';
  } else throw bad('Confirm with your passkey, a code or your password');
  await sessions.steppedUp(req.auth.sid);
  res.json({ ok: true, how, minutes: sessions.STEP_UP_MIN() });
});

// ---------------------------------------------------------------- where you are signed in, and your devices
router.delete('/auth/sessions/:sid', authenticate, async (req, res) => {
  const id = String(req.params.sid || '');
  if (!/^[0-9a-f]{16}$/.test(id)) throw notFound('Session');
  const [r] = await pool.query("UPDATE user_sessions SET ended_at = UTC_TIMESTAMP(), ended_why = 'ended_by_owner' WHERE user_id = ? AND LEFT(id_hash, 16) = ? AND ended_at IS NULL", [req.auth.userId, id]);
  if (!r.affectedRows) throw notFound('Session');
  await audit(pool, req, 'session_end', 'users', req.auth.userId);
  res.json({ ok: true });
});

router.post('/auth/sessions/end-others', authenticate, async (req, res) => {
  await sessions.endAll(pool, req.auth.userId, 'ended_by_owner', req.auth.sid);
  await audit(pool, req, 'sessions_end_others', 'users', req.auth.userId);
  res.json({ ok: true });
});

/** Forget a device: the next sign-in from it is treated as new (alert, and an emailed code for those without two-step). */
router.delete('/auth/devices/:id', authenticate, async (req, res) => {
  const d = await one(pool, 'SELECT device_hash FROM user_devices WHERE id = ? AND user_id = ?', [paramId(req), req.auth.userId]);
  if (!d) throw notFound('Device');
  await pool.query('DELETE FROM user_devices WHERE id = ? AND user_id = ?', [paramId(req), req.auth.userId]);
  await pool.query("UPDATE user_sessions SET ended_at = UTC_TIMESTAMP(), ended_why = 'device_forgotten' WHERE user_id = ? AND device_hash = ? AND ended_at IS NULL AND id_hash <> ?", [req.auth.userId, d.device_hash, sessions.hash(req.auth.sid)]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- your PIN for shared terminals
// 6 to 8 digits, not a run or a repeat or one of the most used PINs. Set with your password, never from a PIN session.
const COMMON = new Set(['123456', '654321', '111111', '000000', '121212', '123123', '112233', '696969', '159753', '252525', '102030', '147258', '12345678', '87654321', '11111111', '00000000', '12341234', '11223344', '1234567', '7777777']);
function weakPin(pin) {
  if (COMMON.has(pin) || /^(\d)\1+$/.test(pin)) return true;
  const d = [...pin].map(Number);
  const up = d.every((x, i) => i === 0 || x === (d[i - 1] + 1) % 10);
  const down = d.every((x, i) => i === 0 || x === (d[i - 1] + 9) % 10);
  return up || down || /^(\d\d)\1+$/.test(pin) || /^(\d\d\d)\1$/.test(pin) || /^(19|20)\d\d(0[1-9]|1[0-2])?$/.test(pin);
}

router.put('/auth/pin', authenticate, notOnTerminal, limit, validate(z.object({ password: z.string().min(1).max(200), pin: z.string().regex(/^\d{6,8}$/, 'Use 6 to 8 digits') })), async (req, res) => {
  const user = await me(req);
  if (!CREW_ROLES.includes(user.role)) throw forbidden('PINs are for counter, lift and instructor staff. You sign in with a passkey or two-step.');
  if (!(await bcrypt.compare(req.body.password, user.password_hash))) throw forbidden('That password is not right');
  if (weakPin(req.body.pin)) throw bad('That PIN is too easy to guess (a run, a repeat, a year or a common PIN). Choose another.');
  await pool.query('UPDATE users SET pin_hash = ?, pin_failures = 0, pin_locked_until = NULL WHERE id = ?', [await bcrypt.hash(req.body.pin, 10), user.id]);
  await audit(pool, req, 'pin_set', 'users', user.id);
  res.json({ ok: true });
});
router.delete('/auth/pin', authenticate, async (req, res) => {
  await pool.query('UPDATE users SET pin_hash = NULL, pin_failures = 0, pin_locked_until = NULL WHERE id = ?', [req.auth.userId]);
  await pool.query("UPDATE user_sessions SET ended_at = UTC_TIMESTAMP(), ended_why = 'pin_cleared' WHERE user_id = ? AND method = 'pin' AND ended_at IS NULL AND id_hash <> ?", [req.auth.userId, sessions.hash(req.auth.sid)]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- shared terminals (managers)
router.get('/terminals', authenticate, manager, async (req, res) => {
  res.json({ data: await rows(pool, `SELECT t.id, t.name, t.created_at, t.last_seen, t.revoked_at, u.username AS enrolled_by FROM terminals t LEFT JOIN users u ON u.id = t.enrolled_by AND u.tenant_id = t.tenant_id
    WHERE t.tenant_id = ? ORDER BY t.revoked_at IS NOT NULL, t.name`, [req.auth.tenantId]) });
});

/** Enroll the computer this request comes from. The key is shown once and kept only in that browser. */
router.post('/terminals', authenticate, manager, notOnTerminal, stepUp('make this computer a shared terminal'), validate(z.object({ name: z.string().trim().min(2).max(60) })), async (req, res) => {
  const secret = crypto.randomBytes(32).toString('base64url');
  const [r] = await pool.query('INSERT INTO terminals (tenant_id, name, secret_hash, enrolled_by, created_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())', [req.auth.tenantId, req.body.name, challenges.hash(`terminal:${secret}`), req.auth.userId]);
  await audit(pool, req, 'terminal_enroll', 'terminals', r.insertId, { name: req.body.name });
  const t = await one(pool, 'SELECT slug FROM tenants WHERE id = ?', [req.auth.tenantId]);
  res.status(201).json({ id: r.insertId, name: req.body.name, secret, tenant: t.slug });
});

router.delete('/terminals/:id', authenticate, manager, stepUp('remove a shared terminal'), async (req, res) => {
  const [r] = await pool.query('UPDATE terminals SET revoked_at = UTC_TIMESTAMP() WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL', [paramId(req), req.auth.tenantId]);
  if (!r.affectedRows) throw notFound('Terminal');
  await pool.query("UPDATE user_sessions SET ended_at = UTC_TIMESTAMP(), ended_why = 'terminal_removed' WHERE tenant_id = ? AND terminal_id = ? AND ended_at IS NULL", [req.auth.tenantId, paramId(req)]);
  await audit(pool, req, 'terminal_remove', 'terminals', paramId(req));
  res.json({ ok: true });
});

// ---------------------------------------------------------------- the mountain's sign-in rules (owner)
router.get('/tenant/sign-in-rules', authenticate, manager, async (req, res) => {
  const t = await one(pool, 'SELECT require_mfa, mfa_for_patrol, patrol_mfa_from, season_ends_on FROM tenants WHERE id = ?', [req.auth.tenantId]);
  res.json({ require_mfa: Boolean(t.require_mfa), mfa_for_patrol: Boolean(t.mfa_for_patrol), patrol_mfa_from: t.patrol_mfa_from ? String(t.patrol_mfa_from).slice(0, 10) : null, season_ends_on: t.season_ends_on ? String(t.season_ends_on).slice(0, 10) : null });
});

/** Patrollers and two-step: on by default. Turning it off is the owner's call and needs the second check. */
router.put('/tenant/sign-in-rules', authenticate, requireRole('owner'), validate(z.object({ mfa_for_patrol: z.boolean() })), async (req, res) => {
  const cur = await one(pool, 'SELECT mfa_for_patrol FROM tenants WHERE id = ?', [req.auth.tenantId]);
  if (cur.mfa_for_patrol && !req.body.mfa_for_patrol) require('../lib/stepup').require(req, 'let patrollers sign in without two-step');
  await pool.query('UPDATE tenants SET mfa_for_patrol = ? WHERE id = ?', [req.body.mfa_for_patrol ? 1 : 0, req.auth.tenantId]);
  await audit(pool, req, 'sign_in_rules', 'tenants', req.auth.tenantId, req.body);
  res.json({ ok: true });
});

module.exports = router;
