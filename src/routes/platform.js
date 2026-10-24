'use strict';

// The operator's console: add mountains, pause them, choose which apps each one has, set a storage limit and reset an owner's password.
// Every call needs the platform key (the BOOTSTRAP_KEY setting) or a console session (see below). A mountain's own logins never work here.
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool, tx, rows, one } = require('../db');
const config = require('../config');
const { z, validate, paramId, partialOf } = require('../lib/util');
const { AppError, bad, forbidden, notFound } = require('../lib/errors');
const M = require('../lib/modules');
const sandbox = require('../lib/sandbox');
const demoUsage = require('../lib/demousage');
const totp = require('../lib/totp');
const safety = require('../lib/safety');
const { toCsv } = require('../lib/csv');
const BL = require('../lib/billing');

const router = express.Router();

const slug = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, 'Lowercase letters, numbers and dashes');
const PWR = require('../lib/passwords');
const password = PWR.schema;
const passkeys = require('../lib/passkeys');
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

// How the console is protected (RUNBOOK.md, "Platform console"):
//   - PLATFORM_ALLOW_IPS (optional): comma-separated addresses that may use the console at all.
//   - PLATFORM_TOTP_SECRET (optional, base32): when set, the key alone is not enough. The operator signs in with the key,
//     a six-digit code from an authenticator app and their name, and gets a session that lasts 2 hours. Every change is
//     recorded with that name.
//   Without PLATFORM_TOTP_SECRET the key works alone, as before.
const SESSION_HOURS = 2;
let lastStep = -1; // a code works once
const keyOk = (supplied) => Boolean(config.bootstrapKey) && crypto.timingSafeEqual(digest(supplied || ''), digest(config.bootstrapKey));
// Sessions are signed with a key of their own (derived from JWT_SECRET), never with the platform key, so holding the
// platform key does not let anyone make an operator's session. A platform-key session also carries a fingerprint of the
// key, so changing the key ends those (and only those).
const sessionKey = () => crypto.createHash('sha256').update(`summitops-platform-session:${config.jwtSecret}`).digest();
const sessionSig = (body) => crypto.createHmac('sha256', sessionKey()).update(body).digest('base64url');
const keyPrint = () => crypto.createHash('sha256').update(`key:${config.bootstrapKey || ''}`).digest('hex').slice(0, 16);
// A session names who opened it: an operator (o = their id) or someone using the platform key (no o). typ 'setup' is the
// short-lived ticket an operator holds between their password and setting up their authenticator app; it opens nothing else.
function makeSession(name, operatorId = null, { typ = null, minutes = SESSION_HOURS * 60, epoch = 0, secretPrint = null } = {}) {
  const body = Buffer.from(JSON.stringify({ n: name, o: operatorId, e: epoch, typ, h: secretPrint, k: operatorId ? null : keyPrint(), exp: Date.now() + minutes * 60_000 })).toString('base64url');
  return `${body}.${sessionSig(body)}`;
}
function readSession(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = sessionSig(body);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return p.exp > Date.now() ? p : null; } catch (_) { return null; }
}
const allowedIps = () => String(process.env.PLATFORM_ALLOW_IPS || '').split(',').map((x) => x.trim()).filter(Boolean);

/**
 * May the platform key be used at all? Only until the first named operator has two-step sign-in set up (so a new
 * install can be reached), or when PLATFORM_KEY_SIGNIN=on is set deliberately as a break-glass. After that, everyone
 * signs in by name with an authenticator code, and the key alone opens nothing. PLATFORM_KEY_SIGNIN=off turns it off always.
 */
let keyGate = { at: 0, open: true };
async function keyAllowed() {
  const mode = process.env.PLATFORM_KEY_SIGNIN;
  if (mode === 'on') return true;
  if (mode === 'off' || !config.bootstrapKey) return false;
  if (Date.now() - keyGate.at > 30_000) {
    const [[r]] = await pool.query('SELECT COUNT(*) AS n FROM platform_operators WHERE active = 1 AND totp_enabled = 1');
    keyGate = { at: Date.now(), open: Number(r.n) === 0 };
  }
  return keyGate.open;
}
const forgetKeyGate = () => { keyGate = { at: 0, open: true }; };
const KEY_OFF = 'The platform key is turned off now that operators sign in by name. Sign in with your email and authenticator code.';

const OPEN = new Set(['/session', '/login', '/login/setup', '/login/passkey/options', '/login/passkey']);
router.use(async (req, _res, next) => {
  try {
    const ips = allowedIps();
    if (ips.length && !ips.includes(req.ip)) return next(forbidden('The platform console is not open from this address'));
    if (req.method === 'POST' && OPEN.has(req.path)) return next();
    const session = readSession(req.get('x-platform-session'));
    if (session && session.typ) return next(forbidden('Finish signing in first'));
    if (session) {
      if (session.o) {
        // An operator's session ends when they are switched off, or their password or two-step is changed or reset.
        const op = await one(pool, 'SELECT id, name, active, session_epoch FROM platform_operators WHERE id = ?', [session.o]);
        if (!op || !op.active || Number(op.session_epoch) !== Number(session.e || 0)) return next(forbidden('Sign in to the console again'));
        req.operatorId = op.id; req.operator = op.name;
      } else {
        if (!(await keyAllowed()) || session.k !== keyPrint()) return next(forbidden('Sign in to the console again'));
        req.operator = `key: ${session.n}`; // someone using the platform key, never mistaken for a named operator
      }
      return next();
    }
  } catch (err) { return next(err); }
  if (process.env.PLATFORM_TOTP_SECRET) return next(forbidden('Sign in to the console again'));
  try { if (!(await keyAllowed())) return next(forbidden(KEY_OFF)); } catch (err) { return next(err); }
  if (!keyOk(req.get('x-platform-key') || req.get('x-bootstrap-key'))) return next(forbidden('That platform key is not right'));
  req.operator = `key: ${String(req.get('x-operator') || '').slice(0, 90) || 'unnamed'}`;
  return next();
});

/** Opens a console session: the platform key, plus a code from the authenticator app when PLATFORM_TOTP_SECRET is set. */
router.post('/session', validate(z.object({ key: z.string().min(1).max(500), name: z.string().trim().min(1).max(100), code: z.string().max(10).optional() })), async (req, res) => {
  if (!(await keyAllowed())) throw forbidden(KEY_OFF);
  if (!keyOk(req.body.key)) throw forbidden('That platform key is not right');
  const secret = process.env.PLATFORM_TOTP_SECRET;
  const step = secret ? totp.verify(secret, req.body.code) : null;
  if (secret && step === null) throw forbidden('That code is not right');
  if (secret && step <= lastStep) throw forbidden('That code was just used. Wait for the next one.');
  if (secret) lastStep = step;
  await pool.query('INSERT INTO platform_audit (tenant_id, action, actor, detail) VALUES (NULL, ?, ?, NULL)', ['sign_in', `key: ${req.body.name}`]);
  require('../lib/audit').trail({ console: true, action: 'sign_in', actor: `key: ${req.body.name}`, ip: req.ip || null });
  res.json({ session: makeSession(req.body.name), hours: SESSION_HOURS, two_step: Boolean(secret) });
});

// ---------------------------------------------------------------- operators: their own sign-in
// Email and password, then always a code from an authenticator app. The first time, the app is set up as part of signing
// in. Five wrong passwords or codes lock that operator for 15 minutes; a code works once.
const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(8).toString('hex'), 12);
const opLocked = (op) => op.locked_until && new Date(`${String(op.locked_until).replace(' ', 'T')}Z`) > new Date();
// MySQL applies SET clauses left to right, so locked_until below already sees the new failures count. A lock that has run
// out starts the count again at 1 and is cleared, so the next five wrong tries lock it again.
const opFailed = (id) => pool.query(`UPDATE platform_operators SET failures = IF(locked_until IS NOT NULL AND locked_until < UTC_TIMESTAMP(), 1, failures + 1),
  locked_until = IF(failures >= ?, UTC_TIMESTAMP() + INTERVAL ? MINUTE, IF(locked_until < UTC_TIMESTAMP(), NULL, locked_until)) WHERE id = ?`, [LOCK_AFTER, LOCK_MINUTES, id]);
const NO_MATCH = 'That email and password do not match, or this login is locked for a few minutes after too many wrong tries.';
const printOf = (secret) => crypto.createHash('sha256').update(`totp:${secret}`).digest('hex').slice(0, 16);
async function opSignedIn(op, step) {
  // One statement claims the code: a second request with the same code (or one racing it), or a login locked meanwhile, changes nothing.
  const [r] = await pool.query(`UPDATE platform_operators SET failures = 0, locked_until = NULL, totp_last_step = ?, last_login_at = UTC_TIMESTAMP()
    WHERE id = ? AND active = 1 AND session_epoch = ? AND (totp_last_step IS NULL OR totp_last_step < ?) AND (locked_until IS NULL OR locked_until < UTC_TIMESTAMP())`, [step, op.id, op.session_epoch, step]);
  if (r.affectedRows !== 1) throw forbidden('That code was just used. Wait for the next one in your app.');
  await pool.query('INSERT INTO platform_audit (tenant_id, action, actor, detail) VALUES (NULL, ?, ?, ?)', ['sign_in', op.name, JSON.stringify({ operator: op.email })]);
  require('../lib/audit').trail({ console: true, action: 'sign_in', actor: op.name });
  return { session: makeSession(op.name, op.id, { epoch: Number(op.session_epoch) }), hours: SESSION_HOURS, two_step: true, name: op.name, operator: true };
}

router.post('/login', validate(z.object({ email: z.string().trim().toLowerCase().max(255), password: z.string().max(200), code: z.string().max(10).optional() })), async (req, res) => {
  const op = await one(pool, 'SELECT * FROM platform_operators WHERE email = ? AND active = 1', [req.body.email]);
  const okPw = await bcrypt.compare(req.body.password, op ? op.password_hash : DUMMY_HASH);
  if (op && opLocked(op)) throw forbidden(NO_MATCH); // the same answer as a wrong password, so it does not show which emails exist
  if (!op || !okPw) { if (op) await opFailed(op.id); throw forbidden(NO_MATCH); }
  // An operator with a passkey signs in with it only: a password and code can be phished, a passkey cannot.
  if (await passkeys.count('operator', op.id)) throw forbidden('Sign in with your passkey (the "Sign in with a passkey" button).');
  if (!op.totp_enabled) {
    // First sign-in (or after a reset): set up the authenticator app before anything else. The ticket is tied to this secret
    // and to the operator's current session epoch, so a newer sign-in, a password reset or switching them off voids it.
    const secret = totp.newSecret();
    await pool.query('UPDATE platform_operators SET totp_secret = ?, totp_last_step = NULL WHERE id = ?', [totp.seal(secret), op.id]);
    return res.json({ setup_required: true, setup_token: makeSession(op.name, op.id, { typ: 'setup', minutes: 10, epoch: Number(op.session_epoch), secretPrint: printOf(secret) }), secret, otpauth_uri: totp.otpauthUri(secret, op.email, 'Verdynt/OS platform') });
  }
  if (!req.body.code) return res.json({ code_required: true });
  const step = totp.verify(totp.open(op.totp_secret), req.body.code);
  if (step === null || (op.totp_last_step !== null && step <= Number(op.totp_last_step))) { await opFailed(op.id); throw forbidden('That code is not right. Use the newest one in your app.'); }
  res.json(await opSignedIn(op, step));
});

router.post('/login/setup', validate(z.object({ setup_token: z.string().max(1000), code: z.string().max(10) })), async (req, res) => {
  const t = readSession(req.body.setup_token);
  if (!t || t.typ !== 'setup' || !t.o) throw forbidden('That took too long. Sign in again.');
  const op = await one(pool, 'SELECT * FROM platform_operators WHERE id = ? AND active = 1', [t.o]);
  if (!op || op.totp_enabled || !op.totp_secret || Number(op.session_epoch) !== Number(t.e) || printOf(totp.open(op.totp_secret)) !== t.h) throw forbidden('Sign in again');
  if (opLocked(op)) throw forbidden(`Too many wrong tries. Wait ${LOCK_MINUTES} minutes.`);
  const step = totp.verify(totp.open(op.totp_secret), req.body.code);
  if (step === null) { await opFailed(op.id); throw bad('That code is not right. Check the app and type the newest code.'); }
  const [on] = await pool.query('UPDATE platform_operators SET totp_enabled = 1 WHERE id = ? AND totp_enabled = 0 AND session_epoch = ?', [op.id, op.session_epoch]);
  forgetKeyGate(); // the first operator with two-step turns the platform key off
  if (on.affectedRows !== 1) throw forbidden('Sign in again');
  await pool.query('INSERT INTO platform_audit (tenant_id, action, actor, detail) VALUES (NULL, ?, ?, NULL)', ['two_step_on', op.name]);
  res.json(await opSignedIn(op, step));
});

// Signing in with a passkey alone (no email, password or code to type). Only operators who added one in the console.
router.post('/login/passkey/options', async (req, res) => {
  res.json(await passkeys.authenticationOptions(req, { kind: 'operator', purpose: 'signin' }));
});
router.post('/login/passkey', validate(z.object({ handle: z.string().max(100), response: z.any() })), async (req, res) => {
  const cred = await passkeys.authenticate(req, { kind: 'operator', purpose: 'signin', handle: req.body.handle, response: req.body.response });
  const op = await one(pool, 'SELECT * FROM platform_operators WHERE id = ? AND active = 1', [cred.operator_id]);
  if (!op) throw forbidden('That operator is switched off');
  await pool.query('UPDATE platform_operators SET failures = 0, locked_until = NULL, last_login_at = UTC_TIMESTAMP() WHERE id = ?', [op.id]);
  await pool.query('INSERT INTO platform_audit (tenant_id, action, actor, detail) VALUES (NULL, ?, ?, ?)', ['sign_in', op.name, JSON.stringify({ operator: op.email, with: 'passkey' })]);
  require('../lib/audit').trail({ console: true, action: 'sign_in', actor: op.name, detail: 'passkey' });
  res.json({ session: makeSession(op.name, op.id, { epoch: Number(op.session_epoch) }), hours: SESSION_HOURS, two_step: true, name: op.name, operator: true, passkey: true });
});

const log = async (conn, req, tenantId, action, detail) => {
  await conn.query('INSERT INTO platform_audit (tenant_id, action, actor, detail) VALUES (?, ?, ?, ?)', [tenantId ?? null, action, req.operator || null, detail ? JSON.stringify(detail) : null]);
  require('../lib/audit').trail({ console: true, tenant: tenantId ?? null, actor: req.operator || null, action, detail: detail ? JSON.stringify(detail) : null, ip: req.ip || null });
};

// ---------------------------------------------------------------- opening one mountain, for a while and for a reason
// A named operator changes a mountain only after opening it: a reason (a support ticket, "owner asked to add Rentals")
// and a time, up to 8 hours. Every opening is in the console's history and the mountain's. The platform key (break-glass)
// is not asked, but everything it does is recorded the same way.
const ACCESS_HOURS = 8;
async function accessOpen(operatorId, tenantId) {
  return one(pool, 'SELECT id, reason, opened_at, expires_at FROM platform_access WHERE operator_id = ? AND tenant_id = ? AND closed_at IS NULL AND expires_at > UTC_TIMESTAMP() ORDER BY id DESC LIMIT 1', [operatorId, tenantId]);
}
async function needsAccess(req, _res, next) {
  try {
    if (!req.operatorId) return next(); // the platform key: break-glass, recorded
    if (await accessOpen(req.operatorId, paramId(req))) return next();
    const err = forbidden('Open this mountain first: say why, and for how long');
    err.details = { code: 'access_required' };
    return next(err);
  } catch (e) { return next(e); }
}

async function usage(ids) {
  if (!ids.length) return new Map();
  const [a] = await pool.query('SELECT tenant_id, COALESCE(SUM(size_bytes), 0) AS b FROM documents WHERE tenant_id IN (?) GROUP BY tenant_id', [ids]);
  const [b] = await pool.query('SELECT tenant_id, COALESCE(SUM(size_bytes), 0) AS b FROM document_versions WHERE tenant_id IN (?) GROUP BY tenant_id', [ids]);
  const out = new Map();
  for (const r of [...a, ...b]) out.set(r.tenant_id, (out.get(r.tenant_id) || 0) + Number(r.b));
  return out;
}

router.get('/modules', (_req, res) => res.json({ data: M.MODULES.map(({ key, label, blurb, needs, addon }) => ({ key, label, blurb, needs: needs || [], addon: Boolean(addon) })) }));

router.get('/tenants', async (_req, res) => {
  const t = await rows(pool, `SELECT t.id, t.slug, t.name, t.status, t.timezone, t.created_at, t.storage_cap_mb, t.platform_notes, t.delete_after,
      (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id AND u.active = 1) AS users FROM tenants t WHERE t.sandbox_expires_at IS NULL ORDER BY t.name`);
  const used = await usage(t.map((x) => x.id));
  const data = [];
  const bills = new Map((await rows(pool, 'SELECT b.*, p.name AS plan FROM tenant_billing b LEFT JOIN billing_plans p ON p.id = b.plan_id')).map((b) => [Number(b.tenant_id), b]));
  for (const x of t) {
    const b = bills.get(Number(x.id));
    data.push({ ...x, users: Number(x.users), storage_used_mb: Math.round(((used.get(x.id) || 0) / 1048576) * 10) / 10, modules: await M.enabledKeys(x.id), billing: { ...(await BL.standingOf(x.id)), plan: b ? b.plan : null, interval: b ? b.billing_interval : null, pay_method: b ? b.pay_method : null } });
  }
  res.json({ data });
});

// The Demos dashboard: every demo anyone started, newest first, with how it was used. Running demos count changes live;
// removed ones keep the numbers noted when they were removed.
router.get('/sandboxes', async (_req, res) => {
  await demoUsage.flush();
  const data = await rows(pool, `SELECT s.id, s.at, s.email, s.name, s.mountain, s.expires_at, s.first_used_at, s.last_used_at, s.sign_ins, s.requests, s.ended_at, s.welcome_sent_at, s.nudge_sent_at, s.ending_sent_at, s.emails_stopped_at,
      COALESCE(s.changes, 0) AS changes, t.id AS tenant_id, t.slug, (t.id IS NOT NULL) AS exists_now, (t.id IS NOT NULL AND t.sandbox_expires_at > NOW()) AS active
    FROM sandbox_signups s LEFT JOIN tenants t ON t.id = s.tenant_id AND t.sandbox_expires_at IS NOT NULL ORDER BY s.id DESC LIMIT 300`);
  const ids = data.map((r) => r.id);
  const areas = ids.length ? await rows(pool, 'SELECT signup_id, area, requests FROM sandbox_usage WHERE signup_id IN (?) ORDER BY requests DESC', [ids]) : [];
  const bySignup = new Map();
  for (const a of areas) {
    const label = demoUsage.labelOf(a.area);
    if (label === 'Sign-in') continue;
    const m = bySignup.get(a.signup_id) || new Map();
    m.set(label, (m.get(label) || 0) + Number(a.requests));
    bySignup.set(a.signup_id, m);
  }
  const tourRows = ids.length ? await rows(pool, 'SELECT signup_id, tour, steps_seen, steps_total, finished_at FROM sandbox_tours WHERE signup_id IN (?)', [ids]) : [];
  const toursOf = new Map();
  for (const t of tourRows) { const l = toursOf.get(t.signup_id) || []; l.push({ tour: t.tour, steps_seen: Number(t.steps_seen), steps_total: Number(t.steps_total), finished: Boolean(t.finished_at) }); toursOf.set(t.signup_id, l); }
  const [[c]] = await pool.query('SELECT COUNT(*) AS n FROM tenants WHERE sandbox_expires_at IS NOT NULL');
  const out = data.map((r) => {
    const used = [...(bySignup.get(r.id) || new Map()).entries()].sort((x, y) => y[1] - x[1]).map(([label, n]) => ({ label, requests: n }));
    // "Came back": used again more than an hour after starting.
    const back = r.last_used_at && (new Date(`${String(r.last_used_at).replace(' ', 'T')}Z`) - new Date(`${String(r.at).replace(' ', 'T')}Z`)) > 3_600_000;
    return {
      id: r.id, at: r.at, email: r.email, name: r.name, mountain: r.mountain, slug: r.slug || null,
      status: r.active ? 'running' : r.exists_now ? 'expired' : 'removed', expires_at: r.expires_at, ended_at: r.ended_at,
      first_used_at: r.first_used_at, last_used_at: r.last_used_at, sign_ins: Number(r.sign_ins || 0), requests: Number(r.requests || 0),
      changes: r.changes === null || r.changes === undefined ? null : Number(r.changes), apps: used, came_back: Boolean(back), tours: toursOf.get(r.id) || [],
      emails: { welcome: r.welcome_sent_at, nudge: r.nudge_sent_at, ending: r.ending_sent_at, stopped: r.emails_stopped_at },
    };
  });
  const since = (days) => out.filter((r) => new Date(`${String(r.at).replace(' ', 'T')}Z`) > Date.now() - days * 86_400_000).length;
  res.json({
    active: Number(c.n),
    summary: { running: out.filter((r) => r.status === 'running').length, last_7_days: since(7), last_30_days: since(30),
      came_back: out.filter((r) => r.came_back).length, made_changes: out.filter((r) => r.changes > 0).length, took_tour: out.filter((r) => r.tours.length).length, total: out.length },
    data: out,
  });
});

// A new sign-in link for a running demo, emailed to the person who started it; every earlier link stops working.
router.post('/sandboxes/:id/send-link', async (req, res) => {
  const r = await require('../lib/demomail').sendLink(require('../lib/baseurl').baseUrl(req), paramId(req));
  if (!r.ok) throw new AppError(409, r.error || 'The email could not be sent');
  await log(pool, req, null, 'demo_send_link', { signup_id: paramId(req) });
  res.json({ ok: true });
});

// Remove one running demo now (by its sign-up), or every demo mountain at once. Only demo mountains can be removed this way.
router.post('/sandboxes/:id/remove', async (req, res) => {
  const s = await one(pool, 'SELECT tenant_id, email FROM sandbox_signups WHERE id = ?', [paramId(req)]);
  if (!s || !s.tenant_id) throw notFound('Demo');
  const removed = await sandbox.purgeTenant(s.tenant_id);
  if (!removed) throw notFound('Demo');
  await log(pool, req, null, 'remove_demo', { tenant_id: s.tenant_id, email: s.email });
  res.json({ removed: 1 });
});
router.post('/sandboxes/remove-all', async (req, res) => {
  const [all] = await pool.query('SELECT id FROM tenants WHERE sandbox_expires_at IS NOT NULL');
  let removed = 0;
  for (const { id } of all) {
    try { if (await sandbox.purgeTenant(id)) removed += 1; } catch (e) { console.error('Could not remove demo mountain', id, e.message); }
  }
  await log(pool, req, null, 'remove_all_demos', { removed });
  res.json({ removed });
});
router.post('/sandboxes/purge', async (req, res) => {
  const removed = await sandbox.purgeExpired();
  await log(pool, req, null, 'purge_demos', { removed });
  res.json({ removed });
});

router.get('/tenants/:id/access', async (req, res) => {
  res.json({ open: req.operatorId ? await accessOpen(req.operatorId, paramId(req)) : null, by_key: !req.operatorId });
});
router.post('/tenants/:id/access', validate(z.object({ reason: z.string().trim().min(5, 'Say why, in a few words').max(300), hours: z.number().int().min(1).max(ACCESS_HOURS).default(2) })), async (req, res) => {
  if (!req.operatorId) throw bad('The platform key does not need this');
  const id = paramId(req);
  if (!(await one(pool, 'SELECT id FROM tenants WHERE id = ?', [id]))) throw notFound('Mountain');
  await pool.query('UPDATE platform_access SET closed_at = UTC_TIMESTAMP() WHERE operator_id = ? AND tenant_id = ? AND closed_at IS NULL', [req.operatorId, id]);
  await pool.query('INSERT INTO platform_access (operator_id, tenant_id, reason, opened_at, expires_at) VALUES (?, ?, ?, UTC_TIMESTAMP(), DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR))', [req.operatorId, id, req.body.reason, req.body.hours]);
  await log(pool, req, id, 'open_access', { reason: req.body.reason, hours: req.body.hours });
  res.status(201).json({ open: await accessOpen(req.operatorId, id) });
});
router.post('/tenants/:id/access/close', async (req, res) => {
  if (!req.operatorId) throw bad('The platform key does not need this');
  const [r] = await pool.query('UPDATE platform_access SET closed_at = UTC_TIMESTAMP() WHERE operator_id = ? AND tenant_id = ? AND closed_at IS NULL', [req.operatorId, paramId(req)]);
  if (r.affectedRows) await log(pool, req, paramId(req), 'close_access', null);
  res.json({ ok: true });
});

router.get('/tenants/:id', async (req, res) => {
  const id = paramId(req);
  const t = await one(pool, 'SELECT id, slug, name, status, timezone, created_at, storage_cap_mb, platform_notes, closed_at, delete_after FROM tenants WHERE id = ?', [id]);
  if (!t) throw notFound('Mountain');
  M.invalidate(id);
  const used = await usage([id]);
  const users = await rows(pool, "SELECT id, email, username, role, active, totp_enabled FROM users WHERE tenant_id = ? AND role IN ('owner','manager') ORDER BY role, email", [id]);
  const history = await rows(pool, 'SELECT at, action, actor, detail FROM platform_audit WHERE tenant_id = ? ORDER BY id DESC LIMIT 30', [id]);
  const bill = await one(pool, 'SELECT * FROM tenant_billing WHERE tenant_id = ?', [id]);
  const billEvents = await rows(pool, 'SELECT at, kind, detail, by_operator FROM billing_events WHERE tenant_id = ? ORDER BY id DESC LIMIT 30', [id]);
  BL.invalidate(id);
  res.json({ ...t, storage_used_mb: Math.round(((used.get(id) || 0) / 1048576) * 10) / 10, modules: await M.enabledKeys(id), users, history,
    billing: bill ? { ...bill, addons: BL.ids(bill.addons), trial_ends_on: BL.dateOf(bill.trial_ends_on), paid_until: BL.dateOf(bill.paid_until), comped: Boolean(Number(bill.comped)) } : null,
    billing_standing: await BL.standingOf(id), billing_events: billEvents, card_payments: await require('../lib/connect').state(id),
    assistant: await assistantUse(id),
    platform_fees: await one(pool, "SELECT COUNT(*) AS payments, COALESCE(SUM(platform_fee_cents), 0) AS fee_cents, COALESCE(SUM(amount_cents), 0) AS amount_cents FROM order_payments WHERE tenant_id = ? AND processor = 'stripe' AND processor_account IS NOT NULL", [id]) });
});

// ---------------------------------------------------------------- what mountains pay Verdynt/OS
router.get('/billing/plans', async (_req, res) => res.json({ data: await BL.plans(), modules: M.MODULES.map(({ key, label, addon }) => ({ key, label, addon: Boolean(addon) })), stripe: require('../lib/stripe').enabled() }));

const planFields = {
  code: z.string().regex(/^[a-z0-9_-]{2,40}$/, 'Lowercase letters, numbers, dashes'), name: z.string().trim().min(1).max(100), blurb: z.string().max(500).nullable().optional(),
  kind: z.enum(['plan', 'addon']).default('plan'), modules: z.array(z.string()).max(40).default([]),
  monthly_cents: z.number().int().min(0).max(100000000).default(0), yearly_cents: z.number().int().min(0).max(1000000000).default(0),
  active: z.boolean().optional(), sort: z.number().int().min(0).max(999).optional(),
};
const planCols = (b) => Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined).map(([k, v]) => [k, k === 'modules' ? v.join(',') : typeof v === 'boolean' ? Number(v) : v]));
router.post('/billing/plans', validate(z.object(planFields)), async (req, res) => {
  for (const k of req.body.modules) if (!M.KEYS.includes(k)) throw bad(`Unknown app: ${k}`);
  const c = planCols(req.body);
  try {
    const [r] = await pool.query(`INSERT INTO billing_plans (${Object.keys(c).join(', ')}) VALUES (${Object.keys(c).map(() => '?').join(', ')})`, Object.values(c));
    await log(pool, req, null, 'billing_plan_create', req.body);
    require('./site').forgetPlans();
    res.status(201).json({ id: r.insertId });
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw bad('That code is already used'); throw e; }
});
// Editing: only the fields sent change (no defaults, so changing the description never resets a price).
const planEdit = z.object({ ...planFields, kind: z.enum(['plan', 'addon']), modules: z.array(z.string()).max(40), monthly_cents: z.number().int().min(0).max(100000000), yearly_cents: z.number().int().min(0).max(1000000000) }).partial();
router.patch('/billing/plans/:id', validate(planEdit), async (req, res) => {
  for (const k of req.body.modules || []) if (!M.KEYS.includes(k)) throw bad(`Unknown app: ${k}`);
  const c = planCols(req.body); delete c.kind;
  if (!Object.keys(c).length) throw bad('Nothing to change');
  const [r] = await pool.query(`UPDATE billing_plans SET ${Object.keys(c).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(c), paramId(req)]);
  if (!r.affectedRows) throw notFound('Plan');
  await log(pool, req, null, 'billing_plan_edit', { id: paramId(req), ...req.body });
  require('./site').forgetPlans();
  res.json({ ok: true });
});
/** Make the plan's product and prices in Stripe (a changed price makes a new Stripe price; existing subscribers keep theirs). */
router.post('/billing/plans/:id/sync', async (req, res) => {
  const p = await one(pool, 'SELECT * FROM billing_plans WHERE id = ?', [paramId(req)]);
  if (!p) throw notFound('Plan');
  const out = await BL.syncPlan(BL.parsePlan(p));
  await log(pool, req, null, 'billing_plan_sync', { id: p.id });
  res.json({ stripe_product: out.stripe_product, stripe_month: out.stripe_month, stripe_year: out.stripe_year });
});

// ---------------------------------------------------------------- website leads (Contact page)
router.get('/leads', async (req, res) => {
  const status = ['new', 'contacted', 'trial', 'won', 'lost'].includes(req.query.status) ? req.query.status : null;
  const data = await rows(pool, `SELECT l.id, l.created_at, l.kind, l.name, l.mountain, l.role, l.email, l.phone, l.lifts, l.plan_interest, l.message, l.founding, l.status, l.operator_note, l.tenant_id, l.emailed, t.slug
    FROM site_leads l LEFT JOIN tenants t ON t.id = l.tenant_id ${status ? 'WHERE l.status = ?' : ''} ORDER BY l.id DESC LIMIT 200`, status ? [status] : []);
  const [[c]] = await pool.query("SELECT COUNT(*) AS n FROM site_leads WHERE status = 'new'");
  res.json({ data: data.map((l) => ({ ...l, founding: Boolean(l.founding), emailed: Boolean(l.emailed) })), new_count: Number(c.n) });
});
router.patch('/leads/:id', validate(z.object({ status: z.enum(['new', 'contacted', 'trial', 'won', 'lost']).optional(), operator_note: z.string().max(1000).nullable().optional(), tenant_id: z.number().int().positive().nullable().optional() })), async (req, res) => {
  const set = Object.entries(req.body).filter(([, v]) => v !== undefined);
  if (!set.length) throw bad('Nothing to change');
  const [r] = await pool.query(`UPDATE site_leads SET ${set.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, [...set.map(([, v]) => v), paramId(req)]);
  if (!r.affectedRows) throw notFound('Request');
  await log(pool, req, req.body.tenant_id || null, 'lead', { id: paramId(req), ...req.body });
  res.json({ ok: true });
});

/** One mountain's billing, as the operator sets it: plan, trial end, free (comped), paid outside Stripe until a date. */
router.put('/tenants/:id/billing', needsAccess, validate(z.object({
  plan_id: z.number().int().positive().nullable().optional(), addons: z.array(z.number().int().positive()).max(20).optional(), interval: z.enum(['month', 'year']).optional(),
  comped: z.boolean().optional(), trial_ends_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), paid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  billing_email: z.string().trim().email().max(255).nullable().optional(), notes: z.string().max(500).nullable().optional(), apply_apps: z.boolean().default(false),
})), async (req, res) => {
  const id = paramId(req); const b = req.body;
  if (!(await one(pool, 'SELECT id FROM tenants WHERE id = ?', [id]))) throw notFound('Mountain');
  const all = await BL.plans();
  if (b.plan_id && !all.some((p) => p.id === b.plan_id && p.kind === 'plan')) throw bad('Unknown plan');
  for (const a of b.addons || []) if (!all.some((p) => p.id === a && p.kind === 'addon')) throw bad('Unknown add-on');
  await tx(async (conn) => {
    await conn.query('INSERT IGNORE INTO tenant_billing (tenant_id) VALUES (?)', [id]);
    const set = { plan_id: b.plan_id, addons: b.addons ? b.addons.join(',') : undefined, billing_interval: b.interval, comped: b.comped === undefined ? undefined : Number(b.comped), trial_ends_on: b.trial_ends_on, paid_until: b.paid_until, billing_email: b.billing_email, notes: b.notes };
    const keys = Object.keys(set).filter((k) => set[k] !== undefined);
    if (keys.length) await conn.query(`UPDATE tenant_billing SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ?`, [...keys.map((k) => set[k]), id]);
    const now = await one(conn, 'SELECT * FROM tenant_billing WHERE tenant_id = ?', [id]);
    if (b.apply_apps) await BL.applyModules(conn, id, now);
    await BL.event(conn, id, 'operator_change', JSON.stringify(b), { operator: req.operator });
    await log(conn, req, id, 'billing', b);
  });
  BL.invalidate(id);
  res.json({ standing: await BL.standingOf(id) });
});

router.post('/tenants', validate(z.object({
  slug, name: z.string().min(2).max(255), timezone: z.string().default('America/New_York'),
  storage_cap_mb: z.number().int().min(10).max(100000).optional(),
  modules: z.record(z.string(), z.boolean()).optional(),
  owner: z.object({ email: z.string().email(), password, first_name: z.string().min(1), last_name: z.string().min(1) }),
  billing: z.enum(['trial', 'comped']).default('trial'), plan_id: z.number().int().positive().nullable().optional(),
})), async (req, res) => {
  const b = req.body;
  try { new Intl.DateTimeFormat('en-US', { timeZone: b.timezone }); } catch (_) { throw new AppError(400, 'Unknown time zone'); }
  for (const k of Object.keys(b.modules || {})) if (!M.KEYS.includes(k)) throw bad(`Unknown app: ${k}`);
  await PWR.refuseWeak(b.owner.password, { email: b.owner.email, tenantSlug: b.slug, tenantName: b.name });
  const hash = await bcrypt.hash(b.owner.password, 12);
  const created = await tx(async (conn) => {
    const [t] = await conn.query('INSERT INTO tenants (slug, name, timezone, storage_cap_mb) VALUES (?, ?, ?, ?)', [b.slug, b.name, b.timezone, b.storage_cap_mb ?? 500]);
    const [p] = await conn.query('INSERT INTO people (tenant_id, first_name, last_name, email) VALUES (?, ?, ?, ?)', [t.insertId, b.owner.first_name, b.owner.last_name, b.owner.email]);
    await conn.query('INSERT INTO users (tenant_id, person_id, email, username, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)', [t.insertId, p.insertId, b.owner.email, require('../lib/usernames').suggestUsername(b.owner), hash, 'owner']);
    const on = M.apply({}, b.modules || {});
    for (const k of M.KEYS) await conn.query('INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, ?, ?)', [t.insertId, k, on.includes(k) ? 1 : 0]);
    if (b.billing === 'trial') await BL.startTrial(conn, t.insertId, { planId: b.plan_id || null, email: b.owner.email });
    else await conn.query('INSERT INTO tenant_billing (tenant_id, comped, plan_id) VALUES (?, 1, ?)', [t.insertId, b.plan_id || null]);
    await log(conn, req, t.insertId, 'create', { slug: b.slug, apps: on, billing: b.billing });
    return { id: t.insertId, slug: b.slug };
  });
  res.status(201).json(created);
});

/** The assistant this month: questions, what it cost, the cap, and the ones that went to support or were not answered. */
async function assistantUse(id) {
  const A = require('../lib/assistant');
  const s = await A.settingsOf(pool, id);
  const m = await one(pool, `SELECT COUNT(*) AS n, COALESCE(SUM(cost_micros), 0) AS c, SUM(audience = 'guest') AS guests, SUM(unanswered) AS unanswered, SUM(rating = -1) AS unhelpful, SUM(escalated_at IS NOT NULL) AS escalated
    FROM assistant_log WHERE tenant_id = ? AND created_at >= DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01')`, [id]);
  const recent = await rows(pool, "SELECT id, audience, page, question, unanswered, rating, escalated_at, created_at FROM assistant_log WHERE tenant_id = ? AND (unanswered = 1 OR rating = -1 OR escalated_at IS NOT NULL) ORDER BY id DESC LIMIT 10", [id]);
  return { staff_on: s.staff_on, guest_pages: s.guest_pages, cap_cents: s.monthly_cap_cents, questions: Number(m.n), guest_questions: Number(m.guests || 0), last_error: A.lastFailure(), cost_micros: Number(m.c), unanswered: Number(m.unanswered || 0), unhelpful: Number(m.unhelpful || 0), escalated: Number(m.escalated || 0), recent };
}

/** The assistant's monthly spending cap for one mountain, in cents (default $50). */
router.put('/tenants/:id/assistant-cap', needsAccess, validate(z.object({ cap_cents: z.number().int().min(0).max(1000000) })), async (req, res) => {
  const id = paramId(req);
  const t = await one(pool, 'SELECT id FROM tenants WHERE id = ?', [id]);
  if (!t) throw notFound('Mountain');
  await pool.query('INSERT INTO assistant_settings (tenant_id, monthly_cap_cents) VALUES (?, ?) ON DUPLICATE KEY UPDATE monthly_cap_cents = VALUES(monthly_cap_cents)', [id, req.body.cap_cents]);
  await log(pool, req, id, 'assistant_cap', req.body);
  res.json({ ok: true });
});

router.patch('/tenants/:id', needsAccess, validate(partialOf({
  name: z.string().min(2).max(255), status: z.enum(['active', 'suspended']), storage_cap_mb: z.number().int().min(10).max(100000),
  platform_notes: z.string().max(500).nullable(),
  // Verdynt/OS's fee on this mountain's guest card payments (not gifts): a share in basis points (100 = 1%, at most 10%) and
  // a fixed amount in cents per payment (at most $5). Both 0 unless set here; Stripe keeps it from each payment.
  platform_fee_bps: z.number().int().min(0).max(1000), platform_fee_cents: z.number().int().min(0).max(500),
})), async (req, res) => {
  const id = paramId(req);
  const keys = Object.keys(req.body);
  if (!keys.length) throw bad('Nothing to change');
  const extra = req.body.status === 'active' ? ', closed_at = NULL, delete_after = NULL' : ''; // resuming cancels a pending deletion
  const [r] = await pool.query(`UPDATE tenants SET ${keys.map((k) => `${k} = ?`).join(', ')}${extra} WHERE id = ?`, [...keys.map((k) => req.body[k]), id]);
  if (!r.affectedRows) throw notFound('Mountain');
  await log(pool, req, id, keys.includes('status') ? req.body.status === 'suspended' ? 'pause' : 'resume' : keys.some((k) => k.startsWith('platform_fee')) ? 'platform_fee' : 'edit', req.body);
  M.invalidate(id);
  res.json({ ok: true });
});

/**
 * Close a mountain that has left: it is paused straight away, its people can no longer sign in, and everything in it is
 * deleted by the daily job once the export window (days, 60 by default) has passed. Reopening before then cancels it.
 */
router.post('/tenants/:id/close', needsAccess, validate(z.object({ days: z.number().int().min(7).max(365).default(60), confirm_slug: z.string() })), async (req, res) => {
  const id = paramId(req);
  const t = await one(pool, 'SELECT id, slug, sandbox_expires_at FROM tenants WHERE id = ?', [id]);
  if (!t) throw notFound('Mountain');
  if (t.sandbox_expires_at) throw bad('Demo mountains are removed on their own');
  if (req.body.confirm_slug !== t.slug) throw bad('Type the mountain\'s address to confirm');
  await pool.query("UPDATE tenants SET status = 'suspended', closed_at = UTC_TIMESTAMP(), delete_after = DATE_ADD(CURDATE(), INTERVAL ? DAY) WHERE id = ?", [req.body.days, id]);
  const [u] = await pool.query('SELECT id FROM users WHERE tenant_id = ?', [id]);
  for (const x of u) await require('../lib/sessions').endAll(pool, x.id, 'mountain_closed');
  await log(pool, req, id, 'close', { days: req.body.days });
  M.invalidate(id);
  const [[row]] = await pool.query('SELECT delete_after FROM tenants WHERE id = ?', [id]);
  res.json({ ok: true, delete_after: row.delete_after });
});
router.post('/tenants/:id/reopen', needsAccess, async (req, res) => {
  const id = paramId(req);
  const [r] = await pool.query("UPDATE tenants SET status = 'active', closed_at = NULL, delete_after = NULL WHERE id = ? AND closed_at IS NOT NULL", [id]);
  if (!r.affectedRows) throw notFound('Closed mountain');
  await log(pool, req, id, 'reopen', {});
  M.invalidate(id);
  res.json({ ok: true });
});

/** Choose which apps a mountain has. Send { modules: { rentals: false, patrol: true } }; anything left out keeps its setting. */
router.put('/tenants/:id/modules', needsAccess, validate(z.object({ modules: z.record(z.string(), z.boolean()) })), async (req, res) => {
  const id = paramId(req);
  for (const k of Object.keys(req.body.modules)) if (!M.KEYS.includes(k)) throw bad(`Unknown app: ${k}`);
  const result = await tx(async (conn) => {
    if (!(await one(conn, 'SELECT id FROM tenants WHERE id = ? FOR UPDATE', [id]))) throw notFound('Mountain');
    const [cur] = await conn.query('SELECT module, enabled FROM tenant_modules WHERE tenant_id = ?', [id]);
    const want = Object.fromEntries(M.KEYS.map((k) => [k, true]));
    for (const r of cur) want[r.module] = Boolean(r.enabled);
    const before = M.settle(want);
    const on = M.apply(want, req.body.modules);
    for (const k of M.KEYS) await conn.query('INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)', [id, k, on.includes(k) ? 1 : 0]);
    const asked = Object.keys(req.body.modules).filter((k) => on.includes(k) !== req.body.modules[k]);
    await log(conn, req, id, 'apps', { turned_on: on.filter((k) => !before.includes(k)), turned_off: before.filter((k) => !on.includes(k)) });
    return { modules: on, not_applied: asked };
  });
  M.invalidate(id);
  res.json(result);
});

/** Set a new password for one of a mountain's owner or manager logins. Signs that person out everywhere. */
router.post('/tenants/:id/reset-password', needsAccess, validate(z.object({ user_id: z.number().int().positive(), password, clear_two_step: z.boolean().default(false), temporary: z.boolean().default(false) })), async (req, res) => {
  const id = paramId(req);
  const u = await one(pool, "SELECT u.id, u.username, u.email, t.slug, t.name FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = ? AND u.tenant_id = ? AND u.role IN ('owner','manager')", [req.body.user_id, id]);
  if (!u) throw notFound('Login');
  await PWR.refuseWeak(req.body.password, { username: u.username, email: u.email, tenantSlug: u.slug, tenantName: u.name });
  const hash = await bcrypt.hash(req.body.password, 12);
  await tx(async (conn) => {
    await conn.query('UPDATE users SET password_hash = ?, password_changed_at = NOW(), must_change_password = ?, login_failures = 0, login_locked_until = NULL WHERE id = ? AND tenant_id = ?', [hash, req.body.temporary ? 1 : 0, u.id, id]);
    await require('../lib/sessions').endAll(conn, u.id, 'console_reset');
    if (req.body.clear_two_step) {
      await conn.query('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL WHERE id = ? AND tenant_id = ?', [u.id, id]);
      await conn.query('DELETE FROM user_recovery_codes WHERE user_id = ?', [u.id]);
      await conn.query('DELETE FROM user_passkeys WHERE user_id = ?', [u.id]);
    }
    await log(conn, req, id, 'password_reset', { user_id: u.id, cleared_two_step: req.body.clear_two_step, temporary: req.body.temporary });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- releases: what is live, what was deployed, what changed
router.get('/releases', async (_req, res) => {
  const V = require('../lib/version');
  let deploys = [];
  try { deploys = await rows(pool, 'SELECT version, build, first_started_at, last_started_at, deployed_by FROM app_deploys ORDER BY first_started_at DESC LIMIT 100'); } catch (_) { /* not migrated yet */ }
  res.json({ version: V.VERSION, build: V.BUILD, built_at: V.BUILT_AT, deploys, releases: V.RELEASES });
});

router.get('/audit', async (_req, res) => {
  res.json({ data: await rows(pool, 'SELECT a.at, a.action, a.actor, a.detail, t.slug FROM platform_audit a LEFT JOIN tenants t ON t.id = a.tenant_id ORDER BY a.id DESC LIMIT 100') });
});

// ---------------------------------------------------------------- operators: who can use the console
const opView = (o) => ({ id: o.id, email: o.email, name: o.name, active: Boolean(o.active), two_step: Boolean(o.totp_enabled), passkeys: Number(o.passkeys || 0), locked: Boolean(opLocked(o)),
  last_login_at: o.last_login_at, created_at: o.created_at, created_by: o.created_by, you: false });

router.get('/me', async (req, res) => {
  res.json({ name: req.operator || null, operator_id: req.operatorId || null, by_key: !req.operatorId, key_signin: process.env.PLATFORM_KEY_SIGNIN !== 'off' });
});

router.get('/operators', async (req, res) => {
  const data = await rows(pool, 'SELECT o.*, (SELECT COUNT(*) FROM platform_operator_passkeys k WHERE k.operator_id = o.id) AS passkeys FROM platform_operators o ORDER BY o.active DESC, o.name');
  res.json({ data: data.map((o) => ({ ...opView(o), you: o.id === req.operatorId })) });
});

router.post('/operators', validate(z.object({ email: z.string().trim().toLowerCase().email().max(255), name: z.string().trim().min(1).max(100), password })), async (req, res) => {
  await PWR.refuseWeak(req.body.password, { email: req.body.email, username: req.body.name });
  const hash = await bcrypt.hash(req.body.password, 12);
  try {
    const [r] = await pool.query('INSERT INTO platform_operators (email, name, password_hash, password_changed_at, created_by) VALUES (?, ?, ?, UTC_TIMESTAMP(), ?)', [req.body.email, req.body.name, hash, req.operator || null]);
    await log(pool, req, null, 'add_operator', { email: req.body.email });
    res.status(201).json({ id: r.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw bad('There is already an operator with that email');
    throw err;
  }
});

async function operatorOr404(id) {
  const o = await one(pool, 'SELECT * FROM platform_operators WHERE id = ?', [id]);
  if (!o) throw notFound('Operator');
  return o;
}

router.post('/operators/:id/active', validate(z.object({ active: z.boolean() })), async (req, res) => {
  const o = await operatorOr404(paramId(req));
  if (o.id === req.operatorId && !req.body.active) throw bad('You cannot switch yourself off. Ask another operator.');
  if (!req.body.active && process.env.PLATFORM_KEY_SIGNIN === 'off') {
    const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM platform_operators WHERE active = 1 AND totp_enabled = 1 AND id <> ?', [o.id]);
    if (!Number(n.n)) throw bad('That would leave nobody able to sign in. Add another operator first.');
  }
  await pool.query('UPDATE platform_operators SET active = ?, session_epoch = session_epoch + 1 WHERE id = ?', [req.body.active ? 1 : 0, o.id]);
  await log(pool, req, null, req.body.active ? 'enable_operator' : 'disable_operator', { email: o.email });
  res.json({ ok: true });
});

// A new password set for someone else, or a reset of their authenticator app (they set it up again at their next sign-in).
// Either one ends their open sessions.
router.post('/operators/:id/password', validate(z.object({ password })), async (req, res) => {
  const o = await operatorOr404(paramId(req));
  if (o.id === req.operatorId) throw bad('Use "Change my password" for your own');
  await PWR.refuseWeak(req.body.password, { email: o.email, username: o.name });
  await pool.query('UPDATE platform_operators SET password_hash = ?, password_changed_at = UTC_TIMESTAMP(), session_epoch = session_epoch + 1, totp_secret = IF(totp_enabled = 1, totp_secret, NULL), failures = 0, locked_until = NULL WHERE id = ?', [await bcrypt.hash(req.body.password, 12), o.id]);
  await log(pool, req, null, 'reset_operator_password', { email: o.email });
  res.json({ ok: true });
});
router.post('/operators/:id/reset-two-step', async (req, res) => {
  const o = await operatorOr404(paramId(req));
  if (o.id === req.operatorId) throw bad('Ask another operator to reset yours, or use the platform key');
  await pool.query('UPDATE platform_operators SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL, session_epoch = session_epoch + 1, failures = 0, locked_until = NULL WHERE id = ?', [o.id]);
  await pool.query('DELETE FROM platform_operator_passkeys WHERE operator_id = ?', [o.id]); // a lost phone's passkeys go too
  await log(pool, req, null, 'reset_operator_two_step', { email: o.email });
  res.json({ ok: true });
});

// Your own passkeys. Once you have one, the console signs you in with it only.
const opOnly = (req) => { if (!req.operatorId) throw bad('You signed in with the platform key. Sign in with your email to add a passkey.'); };
router.get('/me/passkeys', async (req, res) => {
  opOnly(req);
  res.json({ data: (await passkeys.listFor('operator', req.operatorId)).map((k) => ({ id: k.id, name: k.name, created_at: k.created_at, last_used_at: k.last_used_at })) });
});
router.post('/me/passkeys/options', async (req, res) => {
  opOnly(req);
  const o = await operatorOr404(req.operatorId);
  res.json(await passkeys.registrationOptions(req, { kind: 'operator', ownerId: o.id, userName: `${o.email} (Verdynt/OS console)`, displayName: o.name }));
});
router.post('/me/passkeys', validate(z.object({ handle: z.string().max(100), response: z.any(), name: z.string().trim().max(60).optional() })), async (req, res) => {
  opOnly(req);
  const id = await passkeys.register(req, { kind: 'operator', ownerId: req.operatorId, handle: req.body.handle, response: req.body.response, name: req.body.name || 'Passkey' });
  await log(pool, req, null, 'add_passkey', { passkey: id });
  res.status(201).json({ id });
});
router.delete('/me/passkeys/:id', async (req, res) => {
  opOnly(req);
  const [r] = await pool.query('DELETE FROM platform_operator_passkeys WHERE id = ? AND operator_id = ?', [paramId(req), req.operatorId]);
  if (!r.affectedRows) throw notFound('Passkey');
  await log(pool, req, null, 'remove_passkey', { passkey: paramId(req) });
  res.json({ ok: true });
});

router.post('/me/password', validate(z.object({ current: z.string().max(200), password })), async (req, res) => {
  if (!req.operatorId) throw bad('You signed in with the platform key. Sign in with your email to change your password.');
  const o = await operatorOr404(req.operatorId);
  if (!(await bcrypt.compare(req.body.current, o.password_hash))) throw bad('Your current password is not right');
  await PWR.refuseWeak(req.body.password, { email: o.email, username: o.name });
  await pool.query('UPDATE platform_operators SET password_hash = ?, password_changed_at = UTC_TIMESTAMP(), session_epoch = session_epoch + 1 WHERE id = ?', [await bcrypt.hash(req.body.password, 12), o.id]);
  await log(pool, req, null, 'change_own_password', null);
  const [[fresh]] = await pool.query('SELECT session_epoch FROM platform_operators WHERE id = ?', [o.id]);
  res.json({ ok: true, session: makeSession(o.name, o.id, { epoch: Number(fresh.session_epoch) }) }); // a fresh session, since the change ends the old ones
});

// ---------------------------------------------------------------- injury network
// De-identified injury counts across the mountains that share (see src/lib/safety.js for what is and is not in it).
const safetyQuery = (q) => {
  const period = safety.periodOf({ season: q.season ? String(q.season) : null }, new Date().toISOString().slice(0, 10), { fullMonths: true });
  if (!period) throw bad('Use a season like 2026-27');
  const region = q.region ? String(q.region) : null;
  if (region && !safety.REGION_KEYS.includes(region)) throw bad('Unknown region');
  return { period, region };
};

router.get('/safety', async (req, res) => {
  const r = await safety.networkReport(pool, safetyQuery(req.query));
  res.json({ ...r, regions_list: safety.REGIONS.map(([value, label]) => ({ value, label })) });
});

router.get('/safety.csv', async (req, res) => {
  const q = safetyQuery(req.query);
  const r = await safety.networkReport(pool, q);
  if (r.empty_period) throw bad('The season has no full month yet');
  if (r.too_few_mountains) throw bad(`The report needs at least ${safety.MIN_MOUNTAINS} mountains sharing${q.region ? ' in this region, and none or at least 3 elsewhere' : ''}`);
  await log(pool, req, null, 'injury_report_download', { season: q.period.season, region: q.region });
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="injury-network-${q.period.season}${q.region ? `-${q.region}` : ''}.csv"`);
  res.send(toCsv(['section', 'category', 'patients', 'percent', 'per_1000_visits'], safety.csvRows(r)));
});

router.get('/safety/members', async (_req, res) => {
  const data = await rows(pool,
    `SELECT t.id, t.name, t.slug, s.share, s.named, s.region, s.state, s.agreement_version, s.agreed_name, s.agreed_title, s.agreed_at, s.updated_at
       FROM safety_sharing s JOIN tenants t ON t.id = s.tenant_id WHERE t.sandbox_expires_at IS NULL ORDER BY s.share DESC, t.name`);
  res.json({ data: data.map((m) => ({ ...m, share: Boolean(m.share), named: Boolean(m.named), current_terms: m.agreement_version === safety.AGREEMENT_VERSION })) });
});

module.exports = router;
module.exports.keyAllowed = keyAllowed;
module.exports.forgetKeyGate = forgetKeyGate;
