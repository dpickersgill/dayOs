'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { pool, tx, one, rows } = require('../db');
const demoUsage = require('../lib/demousage');
const { authenticate, requireRole, signToken } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { z, validate, paramId, setClause } = require('../lib/util');
const { AppError, unauthorized, forbidden, notFound, bad, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const totp = require('../lib/totp');
const moduleGate = require('../lib/modules');

const router = express.Router();

const slug = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, 'Lowercase letters, numbers and dashes');
const password = z.string().min(10, 'Use at least 10 characters').max(200);

const UN = require('../lib/usernames');
const username = z.string().trim().toLowerCase().regex(UN.PATTERN, UN.RULE);
const MANAGERS = ['owner', 'manager'];

// A real bcrypt hash of a throwaway string, compared against when the user is unknown so that
// response time does not reveal whether a username or email exists.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(8).toString('hex'), 10);

/** Token issued at an explicit second, so it is never older than the password change that created it. */
function tokenIssuedAt(user, iat) {
  return jwt.sign({ tid: user.tenant_id, role: user.role, iat }, config.jwtSecret, {
    algorithm: 'HS256',
    subject: String(user.id),
    expiresIn: config.jwtTtl,
  });
}

/**
 * Create a new mountain (tenant) and its owner login.
 * Protected by BOOTSTRAP_KEY so only you (the platform operator) can onboard customers.
 */
router.post(
  '/tenants',
  validate(
    z.object({
      slug,
      name: z.string().min(2).max(255),
      timezone: z.string().default('America/New_York'),
      owner: z.object({ email: z.string().email(), password, first_name: z.string().min(1), last_name: z.string().min(1) }),
    }),
  ),
  async (req, res) => {
    const supplied = String(req.headers['x-bootstrap-key'] || '');
    const expected = config.bootstrapKey;
    const ok = expected && supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
    if (!ok) throw forbidden('Tenant creation is not enabled for this key');

    const { slug: s, name, timezone, owner } = req.body;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch (_) {
      throw new AppError(400, 'Unknown time zone');
    }
    const hash = await bcrypt.hash(owner.password, 12);
    const created = await tx(async (conn) => {
      const [t] = await conn.query('INSERT INTO tenants (slug, name, timezone) VALUES (?, ?, ?)', [s, name, timezone]);
      const [p] = await conn.query('INSERT INTO people (tenant_id, first_name, last_name, email) VALUES (?, ?, ?, ?)', [t.insertId, owner.first_name, owner.last_name, owner.email]);
      const [u] = await conn.query('INSERT INTO users (tenant_id, person_id, email, username, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)', [t.insertId, p.insertId, owner.email, UN.suggestUsername(owner), hash, 'owner']);
      return { tenant_id: t.insertId, user_id: u.insertId };
    });
    res.status(201).json({ ...created, slug: s });
  },
);

router.post(
  '/auth/login',
  // `login` is a username or an email (one box on the sign-in page); `email` is still accepted for older clients.
  validate(z.object({ tenant: slug, login: z.string().trim().min(1).max(255).optional(), email: z.string().trim().max(255).optional(), password: z.string().min(1).max(200) })
    .refine((b) => b.login || b.email, { message: 'Enter your username or email', path: ['login'] })),
  async (req, res) => {
    const { tenant, password: pw } = req.body;
    const who = String(req.body.login || req.body.email).trim();
    const byEmail = who.includes('@');
    const user = await one(
      pool,
      `SELECT u.*, t.status AS tenant_status, (t.sandbox_expires_at IS NOT NULL) AS sandbox, (t.sandbox_expires_at IS NOT NULL AND t.sandbox_expires_at < NOW()) AS sandbox_over FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE t.slug = ? AND ${byEmail ? 'u.email' : 'u.username'} = ? AND u.active = 1`,
      [tenant, byEmail ? who : UN.normalize(who)],
    );
    const valid = await bcrypt.compare(pw, user ? user.password_hash : DUMMY_HASH);
    if (!user || !valid) throw unauthorized('Invalid credentials');
    if (user.tenant_status !== 'active') throw forbidden('This mountain is paused. Contact SummitOps.');
    if (user.sandbox_over) throw forbidden('This demo has ended. Start a new one, or ask SummitOps for a walkthrough.');
    if (user.totp_enabled) {
      // Password right; the second step is still to do. This token cannot be used for anything else.
      const mfa_token = jwt.sign({ tid: user.tenant_id, typ: 'mfa' }, config.jwtSecret, { algorithm: 'HS256', subject: String(user.id), expiresIn: '5m' });
      return res.json({ mfa_required: true, mfa_token });
    }
    if (Number(user.sandbox)) await demoUsage.signedIn(user.tenant_id);
    res.json({ token: signToken(user), role: user.role, tenant_id: user.tenant_id, must_change_password: Boolean(user.must_change_password) });
  },
);

// Wrong second-step codes are counted per login in the database, so guessing a six-digit code is not practical even from
// many addresses or across several servers: 5 wrong codes lock that login's second step for 5 minutes.
const LOCK_AFTER = 5;
const lockedOut = (u) => u.mfa_failures >= LOCK_AFTER && u.mfa_locked_until && new Date(`${String(u.mfa_locked_until).replace(' ', 'T')}Z`) > new Date();
const failed = (id) => pool.query(
  `UPDATE users SET mfa_failures = IF(mfa_locked_until IS NOT NULL AND mfa_locked_until < UTC_TIMESTAMP(), 1, mfa_failures + 1),
     mfa_locked_until = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 MINUTE) WHERE id = ?`, [id]);
const cleared = (id) => pool.query('UPDATE users SET mfa_failures = 0, mfa_locked_until = NULL WHERE id = ?', [id]);

/** Checks a six-digit app code or a recovery code for this user. Returns true when accepted (and marks it used). */
async function checkSecondStep(conn, user, code) {
  if (totp.looksLikeRecovery(code) && !/^\d{6}$/.test(String(code).trim())) {
    const [r] = await conn.query('UPDATE user_recovery_codes SET used_at = NOW() WHERE user_id = ? AND code_hash = ? AND used_at IS NULL', [user.id, totp.hashRecovery(code)]);
    return r.affectedRows === 1 ? 'recovery' : null;
  }
  if (!user.totp_secret) return null;
  const step = totp.verify(totp.open(user.totp_secret), code);
  if (step === null || (user.totp_last_step !== null && step <= Number(user.totp_last_step))) return null; // a code can be used once
  const [r] = await conn.query('UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)', [step, user.id, step]);
  return r.affectedRows === 1 ? 'app' : null;
}

router.post('/auth/mfa', validate(z.object({ mfa_token: z.string().min(10).max(2000), code: z.string().min(6).max(20) })), async (req, res) => {
  let payload;
  try { payload = jwt.verify(req.body.mfa_token, config.jwtSecret, { algorithms: ['HS256'] }); } catch (_) { throw unauthorized('That sign-in has timed out. Start again.'); }
  if (payload.typ !== 'mfa') throw unauthorized('Invalid sign-in');
  // A password change after the first step cancels the half-finished sign-in.
  const user = await one(pool, 'SELECT * FROM users WHERE id = ? AND tenant_id = ? AND active = 1 AND (password_changed_at IS NULL OR UNIX_TIMESTAMP(password_changed_at) <= ?)', [Number(payload.sub), payload.tid, Number(payload.iat) || 0]);
  if (!user || !user.totp_enabled) throw unauthorized('Invalid sign-in');
  if (lockedOut(user)) throw new AppError(429, 'Too many wrong codes. Wait a few minutes and sign in again.');
  const how = await checkSecondStep(pool, user, req.body.code);
  if (!how) { await failed(user.id); throw unauthorized('That code is not right'); }
  await cleared(user.id);
  if (how === 'recovery') {
    const left = (await one(pool, 'SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL', [user.id])).n;
    await pool.query("INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, detail) VALUES (?, ?, 'mfa_recovery_used', 'users', ?, ?)", [user.tenant_id, user.id, user.id, JSON.stringify({ left })]).catch(() => {});
  }
  res.json({ token: signToken(user), role: user.role, tenant_id: user.tenant_id, must_change_password: Boolean(user.must_change_password), recovery_codes_left: how === 'recovery' ? Number((await one(pool, 'SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL', [user.id])).n) : undefined });
});

router.get('/auth/me', authenticate, async (req, res) => {
  const user = await one(
    pool,
    `SELECT u.id, u.email, u.username, u.must_change_password, u.role, u.staff_id, u.totp_enabled, t.slug AS tenant, t.name AS tenant_name, t.timezone, t.require_mfa, t.sandbox_expires_at
     FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = ? AND u.tenant_id = ?`,
    [req.auth.userId, req.auth.tenantId],
  );
  if (!user) throw unauthorized();
  const { totp_enabled: on, require_mfa: req_ } = user;
  const modules = await moduleGate.enabledKeys(req.auth.tenantId);
  const sandbox = user.sandbox_expires_at ? { expires_at: user.sandbox_expires_at, contact_url: config.marketingUrl || (config.site.hosts[0] ? `https://${config.site.hosts[0]}/contact` : null) } : null;
  const billing = await require('../lib/billing').standingOf(req.auth.tenantId);
  res.json({ ...user, billing, must_change_password: Boolean(user.must_change_password), login_name: user.email || user.username, on_patrol: Boolean(req.auth.onPatrol), sandbox_expires_at: undefined, sandbox, modules, totp_enabled: undefined, require_mfa: undefined, mfa_enabled: Boolean(on), mfa_required_by_mountain: Boolean(req_), mfa_enrollment_required: Boolean(req_ && !on) });
});

/** Change your own password. Signs out every other session and returns a fresh token for this one. */
router.post(
  '/auth/change-password',
  authenticate,
  validate(z.object({ current_password: z.string().min(1).max(200), new_password: password })),
  async (req, res) => {
    const { current_password, new_password } = req.body;
    const user = await one(pool, 'SELECT * FROM users WHERE id = ? AND tenant_id = ?', [req.auth.userId, req.auth.tenantId]);
    if (!user || !(await bcrypt.compare(current_password, user.password_hash))) throw forbidden('Current password is not correct');
    if (current_password === new_password) throw bad('Choose a password different from the current one');
    const now = Math.floor(Date.now() / 1000);
    await pool.query('UPDATE users SET password_hash = ?, password_changed_at = FROM_UNIXTIME(?), must_change_password = 0 WHERE id = ? AND tenant_id = ?', [
      await bcrypt.hash(new_password, 12), now, user.id, user.tenant_id,
    ]);
    await audit(pool, req, 'change_password', 'users', user.id);
    res.json({ token: tokenIssuedAt(user, now) });
  },
);

/** Change your own username (what you type to sign in). */
router.post('/auth/username', authenticate, validate(z.object({ username })), async (req, res) => {
  try {
    await pool.query('UPDATE users SET username = ? WHERE id = ? AND tenant_id = ?', [req.body.username, req.auth.userId, req.auth.tenantId]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict('That username is taken at this mountain');
    throw err;
  }
  await audit(pool, req, 'change_username', 'users', req.auth.userId, { username: req.body.username });
  res.json({ username: req.body.username });
});

// ---------------------------------------------------------------- two-step sign-in setup (your own login)
const mfaLimit = rateLimit({ windowMs: 60_000, max: 20, message: 'Too many attempts' });
async function me(req) { return one(pool, 'SELECT * FROM users WHERE id = ? AND tenant_id = ?', [req.auth.userId, req.auth.tenantId]); }

/** Step 1: make a secret to put into an authenticator app. Nothing changes about sign-in until step 2 is confirmed. */
router.post('/auth/mfa/setup', authenticate, mfaLimit, async (req, res) => {
  const user = await me(req);
  if (user.totp_enabled) throw bad('Two-step sign-in is already on. Turn it off first to set it up again.');
  const secret = totp.newSecret();
  await pool.query('UPDATE users SET totp_secret = ?, totp_last_step = NULL WHERE id = ? AND tenant_id = ?', [totp.seal(secret), user.id, user.tenant_id]);
  const t = await one(pool, 'SELECT name FROM tenants WHERE id = ?', [user.tenant_id]);
  res.json({ secret, otpauth_uri: totp.otpauthUri(secret, user.email || user.username, `SummitOps ${t.name}`) });
});

/** Step 2: prove the app shows the right code. Turns it on and returns ten recovery codes, shown only this once. */
router.post('/auth/mfa/enable', authenticate, mfaLimit, validate(z.object({ code: z.string().min(6).max(10) })), async (req, res) => {
  const user = await me(req);
  if (user.totp_enabled) throw bad('Two-step sign-in is already on');
  if (!user.totp_secret) throw bad('Start the setup first');
  const step = totp.verify(totp.open(user.totp_secret), req.body.code);
  if (step === null) throw bad('That code is not right. Check the app and try the new code.');
  const codes = totp.newRecoveryCodes();
  await tx(async (conn) => {
    await conn.query('UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ?', [step, user.id]);
    await conn.query('DELETE FROM user_recovery_codes WHERE user_id = ?', [user.id]);
    for (const c of codes) await conn.query('INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (?, ?)', [user.id, totp.hashRecovery(c)]);
  });
  await audit(pool, req, 'mfa_enable', 'users', user.id);
  res.json({ enabled: true, recovery_codes: codes });
});

/** Make a fresh set of recovery codes (the old ones stop working). Needs your password. */
router.post('/auth/mfa/recovery-codes', authenticate, mfaLimit, validate(z.object({ password: z.string().min(1).max(200) })), async (req, res) => {
  const user = await me(req);
  if (!user.totp_enabled) throw bad('Two-step sign-in is not on');
  if (!(await bcrypt.compare(req.body.password, user.password_hash))) throw forbidden('Password is not correct');
  const codes = totp.newRecoveryCodes();
  await tx(async (conn) => {
    await conn.query('DELETE FROM user_recovery_codes WHERE user_id = ?', [user.id]);
    for (const c of codes) await conn.query('INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (?, ?)', [user.id, totp.hashRecovery(c)]);
  });
  await audit(pool, req, 'mfa_new_recovery_codes', 'users', user.id);
  res.json({ recovery_codes: codes });
});

/** Turn it off. Needs your password and a current code, and is not allowed while the mountain requires it. */
router.post('/auth/mfa/disable', authenticate, mfaLimit, validate(z.object({ password: z.string().min(1).max(200), code: z.string().min(6).max(20) })), async (req, res) => {
  const user = await me(req);
  if (!user.totp_enabled) throw bad('Two-step sign-in is not on');
  const t = await one(pool, 'SELECT require_mfa FROM tenants WHERE id = ?', [user.tenant_id]);
  if (t.require_mfa) throw forbidden('Your mountain requires two-step sign-in, so it cannot be turned off');
  if (!(await bcrypt.compare(req.body.password, user.password_hash))) throw forbidden('Password is not correct');
  if (!(await checkSecondStep(pool, user, req.body.code))) throw forbidden('That code is not right');
  await tx(async (conn) => {
    await conn.query('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL WHERE id = ?', [user.id]);
    await conn.query('DELETE FROM user_recovery_codes WHERE user_id = ?', [user.id]);
  });
  await audit(pool, req, 'mfa_disable', 'users', user.id);
  res.json({ enabled: false });
});

// ---------------------------------------------------------------- managing logins
const adminOnly = requireRole('manager');

router.get('/users', authenticate, adminOnly, async (req, res) => {
  const data = await rows(
    pool,
    `SELECT u.id, u.email, u.username, u.role, u.active, u.staff_id, u.created_at, (u.totp_enabled = 1) AS mfa_enabled, (u.must_change_password = 1) AS must_change_password, p.first_name, p.last_name
     FROM users u LEFT JOIN people p ON p.id = u.person_id AND p.tenant_id = u.tenant_id
     WHERE u.tenant_id = ? ORDER BY u.role, u.username`,
    [req.auth.tenantId],
  );
  res.json({ data });
});

/** Owner / manager creates logins for their own mountain's staff. Only the owner can create managers. */
router.post(
  '/users',
  authenticate,
  adminOnly,
  validate(
    z.object({
      username: username.optional(),
      email: z.string().trim().email().max(255).optional().or(z.literal('').transform(() => undefined)),
      password,
      role: z.enum(['manager', 'staff', 'patrol', 'instructor', 'counter']),
      person_id: z.coerce.number().int().positive().optional(),
      staff_id: z.coerce.number().int().positive().optional(),
      temporary: z.boolean().default(false), // they must choose their own password when they first sign in
    }),
  ),
  async (req, res) => {
    const t = req.auth.tenantId;
    const { email, password: pw, role, person_id, staff_id, temporary } = req.body;
    if (role === 'manager' && req.auth.role !== 'owner') throw forbidden('Only the owner can create managers');
    if (MANAGERS.includes(role) && !email) throw bad('Managers need an email, for security notices and getting back into their account');
    let personId = person_id ?? null;
    let named = null;
    if (staff_id) {
      const s = await one(pool, 'SELECT s.person_id, p.first_name, p.last_name FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE s.tenant_id = ? AND s.id = ?', [t, staff_id]);
      if (!s) throw notFound('Staff member');
      personId = personId || s.person_id;
      named = s;
    } else if (personId) named = await one(pool, 'SELECT first_name, last_name FROM people WHERE tenant_id = ? AND id = ?', [t, personId]);
    if (!req.body.username && !email && !named) throw bad('Give a username or an email');
    const taken = new Set((await rows(pool, 'SELECT username FROM users WHERE tenant_id = ? AND username IS NOT NULL', [t])).map((r) => r.username));
    const uname = req.body.username || UN.suggestUsername({ ...(named || {}), email }, taken);
    if (req.body.username && taken.has(uname)) throw conflict('That username is taken at this mountain');
    const hash = await bcrypt.hash(pw, 12);
    let r;
    try {
      [r] = await pool.query('INSERT INTO users (tenant_id, person_id, staff_id, email, username, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        t, personId, staff_id ?? null, email || null, uname, hash, role, temporary ? 1 : 0,
      ]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw conflict(/username/.test(err.message) ? 'That username is taken at this mountain' : 'There is already a login with that email');
      throw err;
    }
    await audit(pool, req, 'create', 'users', r.insertId, { role, username: uname, temporary });
    res.status(201).json({ id: r.insertId, email: email || null, username: uname, role, staff_id: staff_id ?? null });
  },
);

/** A username for a new login, from a staff member's name or an email (the Add login form fills it in). */
router.get('/users/suggest-username', authenticate, adminOnly, async (req, res) => {
  const t = req.auth.tenantId;
  let named = null;
  if (req.query.staff_id) named = await one(pool, 'SELECT p.first_name, p.last_name FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE s.tenant_id = ? AND s.id = ?', [t, Number(req.query.staff_id)]);
  const taken = new Set((await rows(pool, 'SELECT username FROM users WHERE tenant_id = ? AND username IS NOT NULL', [t])).map((r) => r.username));
  res.json({ username: UN.suggestUsername({ ...(named || {}), email: String(req.query.email || '') }, taken) });
});

/** A manager may manage non-manager logins; only the owner may manage managers; nobody edits the owner here. */
async function loadTarget(req) {
  const target = await one(pool, 'SELECT id, role FROM users WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!target) throw notFound('Login');
  if (target.role === 'owner') throw forbidden('The owner login cannot be changed here');
  if (target.role === 'manager' && req.auth.role !== 'owner') throw forbidden('Only the owner can change managers');
  return target;
}

router.patch(
  '/users/:id',
  authenticate,
  adminOnly,
  validate(
    z.object({
      active: z.boolean().optional(),
      role: z.enum(['manager', 'staff', 'patrol', 'instructor', 'counter']).optional(),
      staff_id: z.number().int().positive().nullable().optional(),
      username: username.optional(),
      email: z.string().trim().email().max(255).nullable().optional().or(z.literal('').transform(() => null)),
    }),
  ),
  async (req, res) => {
    const target = await loadTarget(req);
    const cur = await one(pool, 'SELECT email FROM users WHERE id = ?', [target.id]);
    const nextRole = req.body.role || target.role;
    const nextEmail = req.body.email === undefined ? cur.email : req.body.email;
    if (MANAGERS.includes(nextRole) && !nextEmail) throw bad('Managers need an email, for security notices and getting back into their account');
    if (target.id === req.auth.userId && (req.body.active === false || req.body.role)) throw forbidden('You cannot deactivate or re-role your own login');
    if (req.body.role === 'manager' && req.auth.role !== 'owner') throw forbidden('Only the owner can create managers');
    const set = setClause({ ...req.body, active: req.body.active === undefined ? undefined : req.body.active ? 1 : 0 }, ['active', 'role', 'staff_id', 'username', 'email']);
    if (!set) throw bad('No updatable fields supplied');
    try {
      await pool.query(`UPDATE users SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, req.auth.tenantId, target.id]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw conflict(/username/.test(err.message) ? 'That username is taken at this mountain' : 'There is already a login with that email');
      throw err;
    }
    await audit(pool, req, 'update', 'users', target.id, req.body);
    res.json({ ok: true });
  },
);

// temporary: the person must choose their own password the next time they sign in (the usual way to get someone with
// no email back in: the manager tells them the temporary one in person or by phone).
router.post('/users/:id/reset-password', authenticate, adminOnly, validate(z.object({ new_password: password, temporary: z.boolean().default(false) })), async (req, res) => {
  const target = await loadTarget(req);
  const now = Math.floor(Date.now() / 1000);
  await pool.query('UPDATE users SET password_hash = ?, password_changed_at = FROM_UNIXTIME(?), must_change_password = ? WHERE tenant_id = ? AND id = ?', [
    await bcrypt.hash(req.body.new_password, 12), now, req.body.temporary ? 1 : 0, req.auth.tenantId, target.id,
  ]);
  await audit(pool, req, 'reset_password', 'users', target.id, { temporary: req.body.temporary });
  res.json({ ok: true });
});

/** Someone lost their phone and their recovery codes: a manager (or the owner, for managers) clears their two-step sign-in so they can set it up again. */
router.post('/users/:id/reset-mfa', authenticate, adminOnly, async (req, res) => {
  const target = await loadTarget(req);
  await tx(async (conn) => {
    await conn.query('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, target.id]);
    await conn.query('DELETE FROM user_recovery_codes WHERE user_id = ?', [target.id]);
  });
  await audit(pool, req, 'mfa_reset', 'users', target.id);
  res.json({ ok: true });
});

module.exports = router;
