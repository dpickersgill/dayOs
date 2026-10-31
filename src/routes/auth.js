'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { pool, tx, one, rows } = require('../db');
const demoUsage = require('../lib/demousage');
const { authenticate, requireRole, signToken, mfaRequired, mfaRule, TIER_SQL, CREW_ROLES } = require('../middleware/auth');
const passkeys = require('../lib/passkeys');
const challenges = require('../lib/challenges');
const devices = require('../lib/devices');
const mailer = require('../lib/mailer');
const { stepUp, require: stepUpCheck } = require('../lib/stepup');
const PWR = require('../lib/passwords');
const sessions = require('../lib/sessions');
const { rateLimit } = require('../middleware/rateLimit');
const { z, validate, paramId, setClause } = require('../lib/util');
const { AppError, unauthorized, forbidden, notFound, bad, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const totp = require('../lib/totp');
const moduleGate = require('../lib/modules');
const menus = require('../lib/menus');

const router = express.Router();

const slug = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, 'Lowercase letters, numbers and dashes');
const password = PWR.schema;

const UN = require('../lib/usernames');
const username = z.string().trim().toLowerCase().regex(UN.PATTERN, UN.RULE);
const MANAGERS = ['owner', 'manager'];
const NEEDS_EMAIL = [...MANAGERS, 'area']; // security notices and getting back in

// A real bcrypt hash of a throwaway string, compared against when the user is unknown so that
// response time does not reveal whether a username or email exists. Same cost (12) as real password hashes.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(8).toString('hex'), 12);

/** Token issued at an explicit second, so it is never older than the password change that created it. */
function tokenIssuedAt(user, iat, req) {
  const a = req.auth || {};
  return sessions.open(user, req, { iat, method: a.method || 'password', deviceHash: a.deviceHash || null, terminalId: a.terminalId || null, steppedUp: true });
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
    if (!(await require('./platform').keyAllowed())) throw forbidden('The platform key is turned off. Add mountains from the console, signed in by name.');

    const { slug: s, name, timezone, owner } = req.body;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch (_) {
      throw new AppError(400, 'Unknown time zone');
    }
    await PWR.refuseWeak(owner.password, { email: owner.email, tenantSlug: s, tenantName: name });
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

/** The password rules for one login: length, breaches, and not their own name or the mountain's. */
async function refuseWeakFor(u, pw) {
  const t = await one(pool, 'SELECT slug, name FROM tenants WHERE id = ?', [u.tenant_id]);
  await PWR.refuseWeak(pw, { username: u.username, email: u.email, tenantSlug: t && t.slug, tenantName: t && t.name });
}

// ---------------------------------------------------------------- signing in
// Every way in ends here: the device is noted (and a new one emailed), and the session records how the person proved who
// they are. A passkey or two-step sign-in, or a password from someone with neither, counts as the second check for
// sensitive actions for the next few minutes, so nobody is asked twice straight after signing in.
async function finishSignIn(user, req, res, { method, extra = {} }) {
  if (user.codes_blocked_at) await cleared(user.id); // a full sign-in turns signing in with an emailed code back on (see claimCode)
  const deviceHash = devices.hashOf(req);
  await devices.remember(user, req, deviceHash, { method });
  const strong = Number(user.totp_enabled) || (await passkeys.count('user', user.id)) > 0;
  const steppedUp = ['passkey', 'mfa'].includes(method) || (!strong && ['password', 'email'].includes(method));
  if (Number(user.sandbox)) await demoUsage.signedIn(user.tenant_id);
  res.json({ token: await signToken(user, req, { method, deviceHash, steppedUp }), role: user.role, tenant_id: user.tenant_id, must_change_password: Boolean(user.must_change_password), ...extra });
}
const ACCESS_OVER = 'Your access has ended for the season. Ask a manager if you are coming back.';
const accessOver = (u) => Boolean(u.access_ends_on) && String(u.access_ends_on).slice(0, 10) < new Date().toISOString().slice(0, 10);
const USER_SQL = `SELECT u.*, t.status AS tenant_status, t.slug AS tenant_slug, (t.sandbox_expires_at IS NOT NULL) AS sandbox, (t.sandbox_expires_at IS NOT NULL AND t.sandbox_expires_at < NOW()) AS sandbox_over
  FROM users u JOIN tenants t ON t.id = u.tenant_id`;
function refuseClosed(user) {
  if (user.tenant_status !== 'active') throw forbidden('This mountain is paused. Contact Verdynt/OS.');
  if (user.sandbox_over) throw forbidden('This demo has ended. Start a new one, or ask Verdynt/OS for a walkthrough.');
  if (accessOver(user)) throw forbidden(ACCESS_OVER);
}
const mask = (email) => String(email).replace(/^(.)(.*)(@.*)$/, (_m, a, b, c) => `${a}${'*'.repeat(Math.min(6, b.length))}${c}`);
const halfToken = (user, extra = {}) => jwt.sign({ tid: user.tenant_id, typ: 'mfa', ...extra }, config.jwtSecret, { algorithm: 'HS256', subject: String(user.id), expiresIn: '5m' });

router.post(
  '/auth/login',
  // `login` is a username or an email (one box on the sign-in page); `email` is still accepted for older clients.
  validate(z.object({ tenant: slug, login: z.string().trim().min(1).max(255).optional(), email: z.string().trim().max(255).optional(), password: z.string().min(1).max(200) })
    .refine((b) => b.login || b.email, { message: 'Enter your username or email', path: ['login'] })),
  async (req, res) => {
    const { tenant, password: pw } = req.body;
    const who = String(req.body.login || req.body.email).trim();
    const byEmail = who.includes('@');
    const user = await one(pool, `${USER_SQL} WHERE t.slug = ? AND ${byEmail ? 'u.email' : 'u.username'} = ? AND u.active = 1`, [tenant, byEmail ? who : UN.normalize(who)]);
    if (!user) { await bcrypt.compare(pw, DUMMY_HASH); throw unauthorized('Invalid credentials'); }
    // A login is locked for 15 minutes after 10 wrong passwords in a row, whatever address they come from (so guessing
    // from many machines is slowed too). Each try is counted before the password is checked (see claimTry), so guesses
    // sent all at once still get only 10 checks. A wrong password answers "Invalid credentials", like an unknown login.
    const tries = await claimTry('login', user.id);
    if (!tries) {
      await bcrypt.compare(pw, DUMMY_HASH);
      throw new AppError(429, 'Too many wrong passwords for this login. Wait 15 minutes, or ask your manager to reset it.');
    }
    if (!(await bcrypt.compare(pw, user.password_hash))) {
      if (tries === LOGIN_LOCK_AFTER) {
        await pool.query("INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, detail) VALUES (?, NULL, 'login_locked', 'users', ?, ?)", [user.tenant_id, user.id, JSON.stringify({ after: LOGIN_LOCK_AFTER })]).catch(() => {});
      }
      throw unauthorized('Invalid credentials');
    }
    await pool.query('UPDATE users SET login_failures = 0, login_locked_until = NULL WHERE id = ?', [user.id]);
    refuseClosed(user);
    const keys = await passkeys.count('user', user.id);
    if (user.totp_enabled || keys) {
      // Password right; the second step is still to do. This token cannot be used for anything else.
      return res.json({ mfa_required: true, mfa_token: halfToken(user), methods: { app: Boolean(user.totp_enabled), passkey: keys > 0 } });
    }
    // No second step of their own: on a device they have not used before, a code goes to their email first. A sign-in that
    // does not say which device it is (no x-device header; the app always sends one) counts as a new device.
    const deviceHash = devices.hashOf(req);
    if (user.email && !Number(user.sandbox) && mailer.enabled() && await devices.isNew(user, deviceHash)) {
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      const handle = await challenges.put('email_code', challenges.hash(`${user.id}:${code}`), { tenantId: user.tenant_id, userId: user.id, minutes: 10 });
      const t = await one(pool, 'SELECT name FROM tenants WHERE id = ?', [user.tenant_id]);
      const sent = await mailer.send({ tenantId: user.tenant_id, to: user.email, fromName: `${t.name} (Verdynt/OS)`, tag: 'sign-in-code', subject: `${code} is your Verdynt/OS sign-in code`,
        text: `Your code to finish signing in to Verdynt/OS at ${t.name} on a new device: ${code}\n\nIt works for 10 minutes. If you did not just sign in, change your password and tell your manager.` });
      if (sent.ok) return res.json({ mfa_required: true, mfa_token: halfToken(user, { via: 'email', h: handle }), methods: { email: true }, sent_to: mask(user.email) });
    }
    await finishSignIn(user, req, res, { method: 'password' });
  },
);

// Wrong passwords, PINs and codes are counted per login in the database, so guessing is slow even from many addresses or
// across several servers. Each try is counted BEFORE it is checked, by one UPDATE that only succeeds while the login is
// not locked: reading the count, checking, then adding one let a burst of guesses sent at the same moment all read "not
// locked" (61 guesses got 61 checks against a limit of 10). The try that reaches the limit sets the lock; a right answer
// clears the count. Returns the try's number, or 0 when the login is locked (the caller answers 429).
// The per-address limits in app.js are per server; these per-login counts are what holds across servers.
const LOCK_AFTER = 5; // wrong codes in a row, then 5 minutes
const LOGIN_LOCK_AFTER = Number(process.env.LOGIN_LOCK_AFTER || 10); // wrong passwords in a row, then 15 minutes
const PIN_LOCK_AFTER = 5; // wrong PINs in a row, then 15 minutes
const CODE_DAY_CAP = 50; // wrong codes in a day, then signing in with an emailed code stops for that login (see claimCode)
const COUNTERS = {
  login: ['login_failures', 'login_locked_until', () => LOGIN_LOCK_AFTER, 15],
  pin: ['pin_failures', 'pin_locked_until', () => PIN_LOCK_AFTER, 15],
};
async function claimTry(kind, id) {
  const [count, until, limit, minutes] = COUNTERS[kind];
  // A lock that has run out starts the count again at 1. MySQL applies SET left to right, so the second line sees the new count.
  const [r] = await pool.query(`UPDATE users SET ${count} = LAST_INSERT_ID(IF(${until} IS NOT NULL, 1, ${count} + 1)),
      ${until} = IF(${count} >= ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), NULL)
    WHERE id = ? AND (${until} IS NULL OR ${until} < UTC_TIMESTAMP())`, [limit(), minutes, id]);
  return r.affectedRows === 1 ? Number(r.insertId) : 0;
}
// Codes (app codes, recovery codes and emailed codes) the same way: 5 wrong in a row lock them for 5 minutes. They also
// count toward a day's total. Signing in with an emailed code needs only the mountain and a username, so at 5 tries every
// few minutes a six-digit code could be worn down all day (about 1,440 tries a day). The 50th wrong code within 24 hours
// therefore stops signing in (or resetting the password) with an emailed code for that login, until a full sign-in by
// another way: the password and its second step (app code, or the code emailed for a new device), a passkey, or a
// password alone on a device used before; or until a manager (or the operator, for an owner) sets a new password or
// resets two-step. Second-step codes are not stopped, so someone who guesses at the emailed code cannot lock a person
// out; they already need the right password, and keep the 5-in-a-row lock. signIn: this code stands in for the password.
// Returns the day's count for this try.
const CODES_STOPPED = 'Too many wrong codes for this login today, so signing in with an emailed code is stopped. Sign in with your password or a passkey, or ask your manager to set a new password for you.';
async function claimCode(id, wait, { signIn = false } = {}) {
  const [r] = await pool.query(`UPDATE users SET mfa_failures = IF(mfa_locked_until IS NOT NULL, 1, mfa_failures + 1),
      mfa_locked_until = IF(mfa_failures >= ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 MINUTE), NULL),
      code_day_failures = LAST_INSERT_ID(IF(code_day_from IS NULL OR code_day_from < UTC_TIMESTAMP() - INTERVAL 1 DAY, 1, code_day_failures + 1)),
      code_day_from = IF(code_day_from IS NULL OR code_day_from < UTC_TIMESTAMP() - INTERVAL 1 DAY, UTC_TIMESTAMP(), code_day_from),
      codes_blocked_at = IF(code_day_failures >= ?, COALESCE(codes_blocked_at, UTC_TIMESTAMP()), codes_blocked_at)
    WHERE id = ? ${signIn ? 'AND codes_blocked_at IS NULL' : ''} AND (mfa_locked_until IS NULL OR mfa_locked_until < UTC_TIMESTAMP())`, [LOCK_AFTER, CODE_DAY_CAP, id]);
  if (r.affectedRows === 1) return Number(r.insertId);
  const u = await one(pool, 'SELECT codes_blocked_at FROM users WHERE id = ?', [id]);
  throw new AppError(429, signIn && u && u.codes_blocked_at ? CODES_STOPPED : `Too many wrong codes. ${wait}`);
}
/** After a wrong code: the one that stopped codes for the day is written to the audit log. */
async function wrongCode(user, dayCount) {
  if (dayCount !== CODE_DAY_CAP) return;
  await pool.query("INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, detail) VALUES (?, NULL, 'codes_stopped', 'users', ?, ?)", [user.tenant_id, user.id, JSON.stringify({ after: CODE_DAY_CAP })]).catch(() => {});
}
// A right code, a passkey or a reset clears every code count and turns emailed-code sign-in back on.
const CLEAR_CODES = 'mfa_failures = 0, mfa_locked_until = NULL, code_day_failures = 0, code_day_from = NULL, codes_blocked_at = NULL';
const cleared = (id) => pool.query(`UPDATE users SET ${CLEAR_CODES} WHERE id = ?`, [id]);

/** Checks a six-digit app code or a recovery code for this user. Returns true when accepted (and marks it used). */
async function checkSecondStep(conn, user, code) {
  if (totp.looksLikeRecovery(code) && !/^\d{6}$/.test(String(code).trim())) {
    const [r] = await conn.query('UPDATE user_recovery_codes SET used_at = NOW() WHERE user_id = ? AND code_hash = ? AND used_at IS NULL', [user.id, totp.hashRecovery(code)]);
    return r.affectedRows === 1 ? 'recovery' : null;
  }
  if (!user.totp_secret || !user.totp_enabled) return null;
  const step = totp.verify(totp.open(user.totp_secret), code);
  if (step === null || (user.totp_last_step !== null && step <= Number(user.totp_last_step))) return null; // a code can be used once
  const [r] = await conn.query('UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)', [step, user.id, step]);
  return r.affectedRows === 1 ? 'app' : null;
}

/** The half-finished sign-in behind an mfa_token, re-checked (a password change since then cancels it). */
async function halfSignedIn(token) {
  let payload;
  try { payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }); } catch (_) { throw unauthorized('That sign-in has timed out. Start again.'); }
  if (payload.typ !== 'mfa') throw unauthorized('Invalid sign-in');
  const user = await one(pool, `${USER_SQL} WHERE u.id = ? AND u.tenant_id = ? AND u.active = 1 AND (u.password_changed_at IS NULL OR UNIX_TIMESTAMP(u.password_changed_at) <= ?)`, [Number(payload.sub), payload.tid, Number(payload.iat) || 0]);
  if (!user) throw unauthorized('Invalid sign-in');
  refuseClosed(user);
  return { user, payload };
}

// The second step: a code from the app (or a recovery code), a passkey, or the code emailed for a new device.
router.post('/auth/mfa', validate(z.object({ mfa_token: z.string().min(10).max(2000), code: z.string().min(6).max(20).optional(), handle: z.string().max(100).optional(), response: z.any().optional() })), async (req, res) => {
  const { user, payload } = await halfSignedIn(req.body.mfa_token);
  // A passkey cannot be guessed, so it works even while codes are locked (and turns them back on).
  if (req.body.response) {
    await passkeys.authenticate(req, { kind: 'user', purpose: 'second', handle: req.body.handle, response: req.body.response, ownerId: user.id });
    await cleared(user.id);
    return finishSignIn(user, req, res, { method: 'passkey' });
  }
  if (!req.body.code) throw bad('Enter the code');
  if (payload.via === 'email') {
    const ch = await challenges.peek('email_code', payload.h);
    if (!ch || Number(ch.user_id) !== user.id) throw unauthorized('That code has run out. Sign in again for a new one.');
    const day = await claimCode(user.id, 'Wait a few minutes and sign in again.');
    if (!(await challenges.claimTry(payload.h))) throw unauthorized('That code has run out. Sign in again for a new one.');
    if (ch.challenge !== challenges.hash(`${user.id}:${String(req.body.code).trim()}`)) { await wrongCode(user, day); throw unauthorized('That code is not right'); }
    await challenges.spend(payload.h);
    await cleared(user.id);
    return finishSignIn(user, req, res, { method: 'email' });
  }
  if (!user.totp_enabled) throw unauthorized('Use your passkey to finish signing in');
  const day = await claimCode(user.id, 'Wait a few minutes and sign in again.');
  const how = await checkSecondStep(pool, user, req.body.code);
  if (!how) { await wrongCode(user, day); throw unauthorized('That code is not right'); }
  await cleared(user.id);
  let left;
  if (how === 'recovery') {
    left = Number((await one(pool, 'SELECT COUNT(*) AS n FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL', [user.id])).n);
    await pool.query("INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, detail) VALUES (?, ?, 'mfa_recovery_used', 'users', ?, ?)", [user.tenant_id, user.id, user.id, JSON.stringify({ left })]).catch(() => {});
  }
  await finishSignIn(user, req, res, { method: 'mfa', extra: { recovery_codes_left: left } });
});

/** The passkey challenge for the second step (password already right). */
router.post('/auth/mfa/passkey-options', validate(z.object({ mfa_token: z.string().min(10).max(2000) })), async (req, res) => {
  const { user } = await halfSignedIn(req.body.mfa_token);
  res.json(await passkeys.authenticationOptions(req, { kind: 'user', purpose: 'second', ownerId: user.id, tenantId: user.tenant_id }));
});

/**
 * What the sign-in page may offer for a mountain: whether it exists (a mistyped or ended mountain is the usual reason a
 * right password fails), whether it is a demo (demos never send email, and that is not a secret), and whether this server
 * can send email at all. It says nothing about any login.
 */
const optionsLimit = rateLimit({ windowMs: 60_000, max: Number(process.env.LOGIN_RATE_LIMIT) || 60, message: 'Too many looks. Wait a minute.', keyOf: (req) => `signin-options:${req.ip}` });
router.get('/auth/signin-options', optionsLimit, async (req, res) => {
  const email = mailer.enabled();
  const tenant = String(req.query.tenant || '').trim().toLowerCase();
  const parsed = slug.safeParse(tenant);
  const t = parsed.success ? await one(pool, "SELECT (sandbox_expires_at IS NOT NULL) AS demo, (sandbox_expires_at IS NOT NULL AND sandbox_expires_at < NOW()) AS demo_over, status FROM tenants WHERE slug = ?", [tenant]) : null;
  res.set('cache-control', 'no-store');
  res.json({
    tenant: parsed.success ? tenant : null,
    known: Boolean(t),
    demo: Boolean(t && Number(t.demo)),
    demo_over: Boolean(t && Number(t.demo_over)),
    email_set_up: email,
    // Emailed codes can reach someone here: email is set up and the mountain is not a demo.
    email_codes: Boolean(email && !(t && Number(t.demo))),
  });
});

/** Sign in with a passkey alone: the phone offers whichever passkey it holds for this mountain; no name or password typed. */
router.post('/auth/passkey/options', validate(z.object({ tenant: slug })), async (req, res) => {
  const t = await one(pool, 'SELECT id FROM tenants WHERE slug = ?', [req.body.tenant]);
  if (!t) throw notFound('Mountain');
  res.json(await passkeys.authenticationOptions(req, { kind: 'user', purpose: 'signin', tenantId: t.id }));
});
router.post('/auth/passkey', validate(z.object({ tenant: slug, handle: z.string().max(100), response: z.any() })), async (req, res) => {
  const t = await one(pool, 'SELECT id FROM tenants WHERE slug = ?', [req.body.tenant]);
  if (!t) throw notFound('Mountain');
  const cred = await passkeys.authenticate(req, { kind: 'user', purpose: 'signin', handle: req.body.handle, response: req.body.response, tenantId: t.id });
  const user = await one(pool, `${USER_SQL} WHERE u.id = ? AND u.tenant_id = ? AND u.active = 1`, [cred.user_id, t.id]);
  if (!user) throw unauthorized('That login is switched off');
  refuseClosed(user);
  await finishSignIn(user, req, res, { method: 'passkey' });
});

// ---------------------------------------------------------------- signing in by email, and "Forgot password?"
// Anyone whose login has an email can ask for a six-digit code. The same email carries a link that signs in (or opens the
// new-password form) on whichever device it is opened. The answer never says whether a login exists: an unknown name gets
// a request handle like any other, and its code is simply never right. Codes last 10 minutes, are used once, and 5 wrong
// tries spend them. At most 3 codes go to one login in 15 minutes. Someone with a passkey or an authenticator app still
// does that second step: the email code only stands in for the password.
const EMAIL_PURPOSES = { signin: 'email_signin', reset: 'email_reset' };
const EMAIL_MINUTES = 10;
const appBase = (req) => require('../lib/baseurl').baseUrl(req);

async function sendLoginEmail(user, req, purpose, code, handle) {
  const t = await one(pool, 'SELECT name FROM tenants WHERE id = ?', [user.tenant_id]);
  const link = `${appBase(req)}/#${purpose === 'reset' ? 'reset-link' : 'email-link'}=${handle}.${code}`;
  const text = purpose === 'reset'
    ? `Your code to choose a new password for Verdynt/OS at ${t.name}: ${code}\n\nOr open this link to choose it on this device:\n${link}\n\nBoth work for ${EMAIL_MINUTES} minutes, once. If you did not ask for this, ignore this email: your password has not changed.`
    : `Your code to sign in to Verdynt/OS at ${t.name}: ${code}\n\nOr open this link to sign in on this device:\n${link}\n\nBoth work for ${EMAIL_MINUTES} minutes, once. If you did not ask for this, ignore this email; nobody can sign in without the code.`;
  return mailer.send({ tenantId: user.tenant_id, to: user.email, fromName: `${t.name} (Verdynt/OS)`, tag: purpose === 'reset' ? 'password-reset' : 'email-sign-in',
    subject: purpose === 'reset' ? `${code} is your code to reset your Verdynt/OS password` : `${code} is your Verdynt/OS sign-in code`, text });
}

router.post('/auth/email-code', validate(z.object({ tenant: slug, login: z.string().trim().min(1).max(255), purpose: z.enum(['signin', 'reset']).default('signin') })), async (req, res) => {
  const { tenant, login: who, purpose } = req.body;
  const byEmail = who.includes('@');
  const user = await one(pool, `${USER_SQL} WHERE t.slug = ? AND ${byEmail ? 'u.email' : 'u.username'} = ? AND u.active = 1`, [tenant, byEmail ? who : UN.normalize(who)]);
  const usable = user && user.email && user.tenant_status === 'active' && !Number(user.sandbox_over) && !accessOver(user);
  if (!usable) return res.json({ request: crypto.randomBytes(24).toString('base64url'), minutes: EMAIL_MINUTES });
  const recent = await one(pool, 'SELECT COUNT(*) AS n FROM auth_challenges WHERE user_id = ? AND purpose = ? AND expires_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE)', [user.id, EMAIL_PURPOSES[purpose], 15 - EMAIL_MINUTES]); // codes made in the last 15 minutes
  if (Number(recent.n) >= 3) return res.json({ request: crypto.randomBytes(24).toString('base64url'), minutes: EMAIL_MINUTES });
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const handle = await challenges.put(EMAIL_PURPOSES[purpose], challenges.hash(`${user.id}:${code}`), { tenantId: user.tenant_id, userId: user.id, minutes: EMAIL_MINUTES });
  // Sent without waiting, so a real login and an unknown one answer in the same time.
  sendLoginEmail(user, req, purpose, code, handle).catch(() => {});
  res.json({ request: handle, minutes: EMAIL_MINUTES });
});

/** The login behind an emailed code (typed with its request, or both from the link). Spends the code when right. */
async function emailCodeUser(purpose, { request, code, link }, beforeSpend) {
  let handle = request; let given = code;
  if (link) { const at = String(link).lastIndexOf('.'); handle = String(link).slice(0, at); given = String(link).slice(at + 1); }
  given = String(given || '').replace(/\s/g, '');
  const ch = handle ? await challenges.peek(EMAIL_PURPOSES[purpose], handle) : null;
  const RUN_OUT = link ? 'That link has run out or was already used. Ask for a new one.' : 'That code is not right, or it has run out. Ask for a new one.';
  if (!ch) throw unauthorized(RUN_OUT);
  const user = await one(pool, `${USER_SQL} WHERE u.id = ? AND u.tenant_id = ? AND u.active = 1`, [ch.user_id, ch.tenant_id]);
  if (!user) throw unauthorized(RUN_OUT);
  const day = await claimCode(user.id, 'Wait a few minutes and ask for a new one.', { signIn: true });
  if (!(await challenges.claimTry(handle))) throw unauthorized(RUN_OUT); // 5 tries per code, counted before checking too
  if (ch.challenge !== challenges.hash(`${user.id}:${given}`)) { await wrongCode(user, day); throw unauthorized(RUN_OUT); }
  refuseClosed(user);
  await cleared(user.id);
  if (beforeSpend) { // a new password that is refused leaves the code usable, with its try given back
    try { await beforeSpend(user); } catch (e) { await challenges.giveBackTry(handle); throw e; }
  }
  await challenges.spend(handle);
  return user;
}

router.post('/auth/email-code/verify', validate(z.object({ request: z.string().max(100).optional(), code: z.string().max(20).optional(), link: z.string().max(140).optional() })
  .refine((b) => b.link || (b.request && b.code), { message: 'Enter the code', path: ['code'] })), async (req, res) => {
  const user = await emailCodeUser('signin', req.body);
  const keys = await passkeys.count('user', user.id);
  if (user.totp_enabled || keys) return res.json({ mfa_required: true, mfa_token: halfToken(user), methods: { app: Boolean(user.totp_enabled), passkey: keys > 0 } });
  await finishSignIn(user, req, res, { method: 'email' });
});

/** Forgot password: the emailed code (or link) and a new password. Every other session ends, and this device is signed in. */
router.post('/auth/password-reset', validate(z.object({ request: z.string().max(100).optional(), code: z.string().max(20).optional(), link: z.string().max(140).optional(), new_password: password })
  .refine((b) => b.link || (b.request && b.code), { message: 'Enter the code', path: ['code'] })), async (req, res) => {
  const user = await emailCodeUser('reset', req.body, (u) => refuseWeakFor(u, req.body.new_password));
  const now = Math.floor(Date.now() / 1000);
  await pool.query('UPDATE users SET password_hash = ?, password_changed_at = FROM_UNIXTIME(?), must_change_password = 0, login_failures = 0, login_locked_until = NULL WHERE id = ?',
    [await bcrypt.hash(req.body.new_password, 12), now, user.id]);
  await sessions.endAll(pool, user.id, 'password_reset');
  await pool.query("INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, detail) VALUES (?, ?, 'password_reset_by_email', 'users', ?, NULL)", [user.tenant_id, user.id, user.id]).catch(() => {});
  const t = await one(pool, 'SELECT name FROM tenants WHERE id = ?', [user.tenant_id]);
  mailer.send({ tenantId: user.tenant_id, to: user.email, fromName: `${t.name} (Verdynt/OS)`, tag: 'password-changed', subject: 'Your Verdynt/OS password was changed',
    text: `The password for your Verdynt/OS login at ${t.name} was just changed, using a code sent to this email. Every device was signed out.\n\nIf this was not you, tell your manager straight away.` }).catch(() => {});
  // They proved the email just now: signed straight in, or on to their passkey or app code if they have one.
  const fresh = { ...user, password_changed_at: null };
  const keys = await passkeys.count('user', user.id);
  if (user.totp_enabled || keys) return res.json({ password_saved: true, mfa_required: true, mfa_token: halfToken(fresh), methods: { app: Boolean(user.totp_enabled), passkey: keys > 0 } });
  await finishSignIn({ ...fresh, must_change_password: 0 }, req, res, { method: 'email', extra: { password_saved: true } });
});

// ---------------------------------------------------------------- shared terminals: switching in with a PIN
// A computer a manager enrolled (ticket window, rental counter) holds a terminal key. Counter, instructor and lift staff
// switch in there with their username and a personal PIN. Five wrong PINs lock that person's PIN for 15 minutes (each
// try counted before it is checked; see claimTry). Anyone who must use two-step sign-in (managers, patrol) signs in properly instead.
async function terminalOf(tenantId, secret) {
  if (!secret || String(secret).length < 20) return null;
  return one(pool, 'SELECT id, name FROM terminals WHERE tenant_id = ? AND secret_hash = ? AND revoked_at IS NULL', [tenantId, challenges.hash(`terminal:${secret}`)]);
}
const NOT_TERMINAL = 'This computer is no longer a shared terminal. A manager can enroll it again in Account.';

/** Which terminal this is (shown on its PIN screen). */
router.post('/auth/terminal', validate(z.object({ tenant: slug, terminal: z.string().max(200) })), async (req, res) => {
  const t = await one(pool, 'SELECT id, name FROM tenants WHERE slug = ?', [req.body.tenant]);
  const term = t ? await terminalOf(t.id, req.body.terminal) : null;
  if (!term) throw forbidden(NOT_TERMINAL);
  res.json({ name: term.name, mountain: t.name });
});

router.post('/auth/pin-login', validate(z.object({ tenant: slug, terminal: z.string().max(200), login: z.string().trim().min(1).max(255), pin: z.string().regex(/^\d{6,8}$/, 'Your PIN is 6 to 8 digits') })), async (req, res) => {
  const t = await one(pool, 'SELECT id FROM tenants WHERE slug = ?', [req.body.tenant]);
  const term = t ? await terminalOf(t.id, req.body.terminal) : null;
  if (!term) throw forbidden(NOT_TERMINAL);
  const who = req.body.login;
  const byEmail = who.includes('@');
  const user = await one(pool, `SELECT u.*, t.status AS tenant_status, t.slug AS tenant_slug, (t.sandbox_expires_at IS NOT NULL AND t.sandbox_expires_at < NOW()) AS sandbox_over, ${TIER_SQL}
    FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.tenant_id = ? AND ${byEmail ? 'u.email' : 'u.username'} = ? AND u.active = 1`, [t.id, byEmail ? who : UN.normalize(who)]);
  const NO = 'That username and PIN do not match';
  if (!user || !user.pin_hash) { await bcrypt.compare(req.body.pin, DUMMY_HASH); throw unauthorized(user ? 'Set a PIN first: sign in with your password, then open Account.' : NO); }
  if (!CREW_ROLES.includes(user.role) || mfaRequired(user)) throw forbidden('PINs are for counter, lift and instructor staff. Sign in with your password instead.');
  if (!(await claimTry('pin', user.id))) { await bcrypt.compare(req.body.pin, DUMMY_HASH); throw new AppError(429, 'Too many wrong PINs. Wait 15 minutes or sign in with your password.'); }
  if (!(await bcrypt.compare(req.body.pin, user.pin_hash))) throw unauthorized(NO);
  await pool.query('UPDATE users SET pin_failures = 0, pin_locked_until = NULL WHERE id = ?', [user.id]);
  refuseClosed(user);
  await pool.query('UPDATE terminals SET last_seen = UTC_TIMESTAMP() WHERE id = ?', [term.id]);
  res.json({ token: await signToken(user, req, { method: 'pin', terminalId: term.id }), role: user.role, tenant_id: user.tenant_id, must_change_password: Boolean(user.must_change_password), terminal: term.name });
});

router.get('/auth/me', authenticate, async (req, res) => {
  const user = await one(
    pool,
    `SELECT u.id, u.email, u.username, u.must_change_password, u.role, u.staff_id, u.totp_enabled, u.access_ends_on, (u.pin_hash IS NOT NULL) AS pin_set,
       t.slug AS tenant, t.name AS tenant_name, t.timezone, t.sandbox_expires_at, t.role_menus, ${TIER_SQL}
     FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = ? AND u.tenant_id = ?`,
    [req.auth.userId, req.auth.tenantId],
  );
  if (!user) throw unauthorized();
  const rule = mfaRule(user);
  const strong = Boolean(Number(user.strong));
  // Patrollers who will need two-step soon (the two-week start for mountains that already existed): the date it begins.
  const soon = !rule && config.requireAdminMfa && !Number(user.sandbox) && (user.role === 'patrol' || Number(user.on_patrol)) && !Number(user.patrol_host) && Number(user.mfa_for_patrol) && user.patrol_mfa_from ? String(user.patrol_mfa_from).slice(0, 10) : null;
  // The key that seals this person's patrol entries kept on a phone (see public/js/outbox.js); the same for every sign-in.
  const deviceKey = crypto.createHmac('sha256', config.linkSecret).update(`device:${req.auth.tenantId}:${req.auth.userId}`).digest('base64');
  const modules = await moduleGate.enabledKeys(req.auth.tenantId);
  const sandbox = user.sandbox_expires_at ? { expires_at: user.sandbox_expires_at, contact_url: config.marketingUrl || (config.site.hosts[0] ? `https://${config.site.hosts[0]}/contact` : null) } : null;
  const billing = await require('../lib/billing').standingOf(req.auth.tenantId);
  const terminal = req.auth.terminalId ? await one(pool, 'SELECT id, name FROM terminals WHERE id = ?', [req.auth.terminalId]) : null;
  const pick = ({ id, email, username, role, staff_id: staffId, tenant, tenant_name: tenantName, timezone }) => ({ id, email, username, role, staff_id: staffId, tenant, tenant_name: tenantName, timezone });
  res.json({
    ...pick(user), billing, must_change_password: Boolean(user.must_change_password), login_name: user.email || user.username, on_patrol: Boolean(req.auth.onPatrol), sandbox, modules,
    mfa_enabled: strong, app_enabled: Boolean(user.totp_enabled), passkeys: await passkeys.count('user', user.id), pin_set: Boolean(Number(user.pin_set)),
    mfa_required_by_mountain: Boolean(Number(user.require_mfa)), mfa_required: Boolean(rule), mfa_rule: rule, mfa_enrollment_required: Boolean(rule && !strong), mfa_starts_on: soon,
    access_ends_on: user.access_ends_on ? String(user.access_ends_on).slice(0, 10) : null,
    staff_injuries: await require('../lib/injuryregister').canSee(pool, req.auth.tenantId, { id: req.auth.userId, role: user.role }),
    signed_in_with: req.auth.method, terminal, stepped_up: req.auth.steppedUp, device_key: deviceKey, display: req.auth.display || null,
    // This role's own menu (its apps in order, and the screen it opens on); null for owners and managers, who see everything.
    menu: menus.menuFor(user.role, user.role_menus, user.school_access),
    // The ski school access level (lib/schoolaccess.js): director for owners and managers, the teaching profile's for an instructor.
    school_access: ['owner', 'manager'].includes(user.role) ? 'director' : user.role === 'instructor' ? (user.school_access || 'instructor') : null,
  });
});

// ---------------------------------------------------------------- menus for each role (Settings, Team and logins)
/** Each role's menu now, the standard one, and what each role could have. Managers may look; only the owner changes. */
async function menusState(tenantId, role) {
  const t = await one(pool, 'SELECT role_menus FROM tenants WHERE id = ?', [tenantId]);
  const changed = menus.parse(t && t.role_menus);
  return {
    can_change: role === 'owner',
    always: menus.ALWAYS,
    apps: menus.APPS,
    roles: Object.fromEntries(menus.ROLES.map((r) => [r, { ...(changed[r] || menus.standardFor(r)), standard: !changed[r], can_open: menus.ROLE_APPS[r] }])),
    standard: Object.fromEntries(menus.ROLES.map((r) => [r, menus.standardFor(r)])),
  };
}
router.get('/settings/menus', authenticate, requireRole(...MANAGERS), async (req, res) => {
  res.json(await menusState(req.auth.tenantId, req.auth.role));
});
router.put('/settings/menus', authenticate, requireRole('owner'), validate(z.object({
  role: z.enum(menus.ROLES),
  // null puts back the standard menu for that role
  menu: z.object({ apps: z.array(z.string().max(30)).min(1).max(menus.KEYS.length), start: z.string().max(30) }).nullable(),
})), async (req, res) => {
  const { role, menu } = req.body;
  const out = await tx(async (conn) => {
    const [[t]] = await conn.query('SELECT role_menus FROM tenants WHERE id = ? FOR UPDATE', [req.auth.tenantId]);
    const all = menus.parse(t && t.role_menus);
    const before = all[role] || null;
    if (menu) {
      const r = menus.check(role, menu);
      if (r.problem) throw bad(r.problem);
      all[role] = r.menu;
    } else delete all[role];
    await conn.query('UPDATE tenants SET role_menus = ? WHERE id = ?', [Object.keys(all).length ? JSON.stringify(all) : null, req.auth.tenantId]);
    await audit(conn, req, 'update_role_menu', 'tenants', req.auth.tenantId, { role, before, after: all[role] || null });
    return all[role] || null;
  });
  res.json({ role, menu: out || menus.standardFor(role), standard: !out });
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
    await refuseWeakFor(user, new_password);
    const now = Math.floor(Date.now() / 1000);
    await pool.query('UPDATE users SET password_hash = ?, password_changed_at = FROM_UNIXTIME(?), must_change_password = 0 WHERE id = ? AND tenant_id = ?', [
      await bcrypt.hash(new_password, 12), now, user.id, user.tenant_id,
    ]);
    await audit(pool, req, 'change_password', 'users', user.id);
    await sessions.endAll(pool, user.id, 'password_changed');
    res.json({ token: await tokenIssuedAt(user, now, req) });
  },
);

/**
 * The last browser tab using this session closed (or is reloading). The session ends in 30 minutes unless it is used again
 * first (sessions.closing). Sent with x-poll: 1, so the sign-in check does not count this call itself as use.
 */
const pageOf = (b) => { const n = Number(b && b.page); return Number.isSafeInteger(n) && n > 0 ? n : null; }; // when the page opened (its clock, ms)
router.post('/auth/closing', authenticate, async (req, res) => {
  if (req.auth.sid) await sessions.closing(req.auth.sid, pageOf(req.body));
  res.status(204).end();
});

/**
 * A page of the app opened, or came back (a reload, the Back button from Stripe): the session is in use again, and a
 * closing notice that arrives in the next few seconds (the reload race) is ignored (sessions.back).
 */
router.post('/auth/back', authenticate, async (req, res) => {
  if (req.auth.sid) await sessions.back(req.auth.sid, pageOf(req.body));
  res.status(204).end();
});

/** Sign out: the server ends this session, so the token stops working even if a copy was kept somewhere. */
router.post('/auth/logout', authenticate, async (req, res) => {
  if (req.auth.sid) await sessions.end(req.auth.sid, 'signed_out');
  res.status(204).end();
});

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
  res.json({ secret, otpauth_uri: totp.otpauthUri(secret, user.email || user.username, `Verdynt/OS ${t.name}`) });
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
  if (req.auth.mfaRule && !(await passkeys.count('user', user.id))) throw forbidden('You must have two-step sign-in, so the app can only be turned off once you have a passkey');
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
    `SELECT u.id, u.email, u.username, u.role, u.active, u.staff_id, u.created_at, (u.totp_enabled = 1 OR EXISTS (SELECT 1 FROM user_passkeys k WHERE k.user_id = u.id)) AS mfa_enabled,
       (u.totp_enabled = 1) AS app_enabled, (SELECT COUNT(*) FROM user_passkeys k WHERE k.user_id = u.id) AS passkeys, (u.pin_hash IS NOT NULL) AS pin_set, u.access_ends_on,
       (u.must_change_password = 1) AS must_change_password, p.first_name, p.last_name
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
      role: z.enum(['manager', 'staff', 'patrol', 'instructor', 'counter', 'area']),
      person_id: z.coerce.number().int().positive().optional(),
      staff_id: z.coerce.number().int().positive().optional(),
      temporary: z.boolean().default(false), // they must choose their own password when they first sign in
      access_ends_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    }),
  ),
  async (req, res) => {
    const t = req.auth.tenantId;
    const { email, password: pw, role, person_id, staff_id, temporary } = req.body;
    if (role === 'manager' && req.auth.role !== 'owner') throw forbidden('Only the owner can create managers');
    if (role === 'manager') stepUpCheck(req, 'add a manager');
    if (NEEDS_EMAIL.includes(role) && !email) throw bad('Managers and ski area logins need an email, for security notices and getting back into their account');
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
    await refuseWeakFor({ tenant_id: t, username: uname, email }, pw);
    const hash = await bcrypt.hash(pw, 12);
    let r;
    try {
      // Seasonal logins end on the mountain's season end date unless a manager says otherwise.
      const season = MANAGERS.includes(role) ? null : (await one(pool, 'SELECT season_ends_on FROM tenants WHERE id = ?', [t])).season_ends_on;
      [r] = await pool.query('INSERT INTO users (tenant_id, person_id, staff_id, email, username, password_hash, role, must_change_password, access_ends_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        t, personId, staff_id ?? null, email || null, uname, hash, role, temporary ? 1 : 0, req.body.access_ends_on === undefined ? season || null : req.body.access_ends_on,
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
      role: z.enum(['manager', 'staff', 'patrol', 'instructor', 'counter', 'area']).optional(),
      staff_id: z.number().int().positive().nullable().optional(),
      username: username.optional(),
      email: z.string().trim().email().max(255).nullable().optional().or(z.literal('').transform(() => null)),
      access_ends_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), // the day after which they cannot sign in
    }),
  ),
  async (req, res) => {
    const target = await loadTarget(req);
    if ((req.body.role && req.body.role !== target.role) || req.body.active === false) stepUpCheck(req, req.body.role ? 'change what this login can do' : 'switch this login off');
    const cur = await one(pool, 'SELECT email FROM users WHERE id = ?', [target.id]);
    const nextRole = req.body.role || target.role;
    const nextEmail = req.body.email === undefined ? cur.email : req.body.email;
    if (NEEDS_EMAIL.includes(nextRole) && !nextEmail) throw bad('Managers and ski area logins need an email, for security notices and getting back into their account');
    if (target.id === req.auth.userId && (req.body.active === false || req.body.role)) throw forbidden('You cannot deactivate or re-role your own login');
    if (req.body.role === 'manager' && req.auth.role !== 'owner') throw forbidden('Only the owner can create managers');
    const set = setClause({ ...req.body, active: req.body.active === undefined ? undefined : req.body.active ? 1 : 0 }, ['active', 'role', 'staff_id', 'username', 'email', 'access_ends_on']);
    if (!set) throw bad('No updatable fields supplied');
    try {
      await pool.query(`UPDATE users SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, req.auth.tenantId, target.id]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw conflict(/username/.test(err.message) ? 'That username is taken at this mountain' : 'There is already a login with that email');
      throw err;
    }
    if (req.body.active === false || req.body.role) await sessions.endAll(pool, target.id, req.body.role ? 'role_changed' : 'switched_off');
    await audit(pool, req, 'update', 'users', target.id, req.body);
    res.json({ ok: true, ...(req.body.username ? { username: req.body.username } : {}) }); // the username as saved (lowercase)
  },
);

// temporary: the person must choose their own password the next time they sign in (the usual way to get someone with
// no email back in: the manager tells them the temporary one in person or by phone).
router.post('/users/:id/reset-password', authenticate, adminOnly, stepUp('set a new password for someone'), validate(z.object({ new_password: password, temporary: z.boolean().default(false) })), async (req, res) => {
  const target = await loadTarget(req);
  await refuseWeakFor(await one(pool, 'SELECT tenant_id, username, email FROM users WHERE id = ?', [target.id]), req.body.new_password);
  const now = Math.floor(Date.now() / 1000);
  await pool.query(`UPDATE users SET password_hash = ?, password_changed_at = FROM_UNIXTIME(?), must_change_password = ?, login_failures = 0, login_locked_until = NULL, ${CLEAR_CODES} WHERE tenant_id = ? AND id = ?`, [
    await bcrypt.hash(req.body.new_password, 12), now, req.body.temporary ? 1 : 0, req.auth.tenantId, target.id,
  ]);
  await sessions.endAll(pool, target.id, 'password_reset');
  await audit(pool, req, 'reset_password', 'users', target.id, { temporary: req.body.temporary });
  res.json({ ok: true });
});

/** Someone lost their phone and their recovery codes: a manager (or the owner, for managers) clears their two-step sign-in so they can set it up again. */
router.post('/users/:id/reset-mfa', authenticate, adminOnly, stepUp('reset someone\'s two-step sign-in'), async (req, res) => {
  const target = await loadTarget(req);
  await tx(async (conn) => {
    await conn.query(`UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL, ${CLEAR_CODES} WHERE tenant_id = ? AND id = ?`, [req.auth.tenantId, target.id]);
    await conn.query('DELETE FROM user_recovery_codes WHERE user_id = ?', [target.id]);
  });
  await pool.query('DELETE FROM user_passkeys WHERE tenant_id = ? AND user_id = ?', [req.auth.tenantId, target.id]); // their lost phone's passkeys too
  await sessions.endAll(pool, target.id, 'mfa_reset');
  await audit(pool, req, 'mfa_reset', 'users', target.id);
  res.json({ ok: true });
});

/** Clears someone's terminal PIN (they forgot it, or it may be known to others). They set a new one in Account. */
router.delete('/users/:id/pin', authenticate, adminOnly, async (req, res) => {
  const target = await loadTarget(req);
  await pool.query('UPDATE users SET pin_hash = NULL, pin_failures = 0, pin_locked_until = NULL WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, target.id]);
  await pool.query("UPDATE user_sessions SET ended_at = UTC_TIMESTAMP(), ended_why = 'pin_cleared' WHERE user_id = ? AND method = 'pin' AND ended_at IS NULL", [target.id]);
  await audit(pool, req, 'pin_clear', 'users', target.id);
  res.json({ ok: true });
});

/**
 * The season's end: every counter, instructor, staff and patrol login (not managers) stops working after this day,
 * and new ones get it too. Bring someone back by clearing or moving their date. null clears it for new logins only.
 */
router.post('/users/season-end', authenticate, adminOnly, validate(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), roles: z.array(z.enum(['staff', 'counter', 'instructor', 'patrol'])).max(4).default(['staff', 'counter', 'instructor', 'patrol']), apply_to_current: z.boolean().default(true) })), async (req, res) => {
  const { date, roles, apply_to_current: now } = req.body;
  if (date && date < new Date().toISOString().slice(0, 10)) throw bad('Choose a date from today on');
  await pool.query('UPDATE tenants SET season_ends_on = ? WHERE id = ?', [date, req.auth.tenantId]);
  let changed = 0;
  if (now && date && roles.length) {
    const [r] = await pool.query('UPDATE users SET access_ends_on = ? WHERE tenant_id = ? AND role IN (?) AND active = 1', [date, req.auth.tenantId, roles]);
    changed = r.affectedRows;
  }
  await audit(pool, req, 'season_end', 'tenants', req.auth.tenantId, { date, roles, changed });
  res.json({ ok: true, season_ends_on: date, changed });
});

module.exports = router;
