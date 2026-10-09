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
const totp = require('../lib/totp');

const router = express.Router();

const slug = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, 'Lowercase letters, numbers and dashes');
const password = z.string().min(10, 'Use at least 10 characters').max(200);
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
const sessionSig = (body) => crypto.createHmac('sha256', `platform-session:${config.bootstrapKey}`).update(body).digest('base64url');
function makeSession(name) {
  const body = Buffer.from(JSON.stringify({ n: name, exp: Date.now() + SESSION_HOURS * 3600_000 })).toString('base64url');
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

router.use((req, _res, next) => {
  const ips = allowedIps();
  if (ips.length && !ips.includes(req.ip)) return next(forbidden('The platform console is not open from this address'));
  if (req.method === 'POST' && req.path === '/session') return next();
  const session = readSession(req.get('x-platform-session'));
  if (session && config.bootstrapKey) { req.operator = session.n; return next(); } // sessions are signed with the key, so a new key ends them
  if (process.env.PLATFORM_TOTP_SECRET) return next(forbidden('Sign in to the console again'));
  if (!keyOk(req.get('x-platform-key') || req.get('x-bootstrap-key'))) return next(forbidden('That platform key is not right'));
  req.operator = String(req.get('x-operator') || '').slice(0, 100) || null;
  return next();
});

/** Opens a console session: the platform key, plus a code from the authenticator app when PLATFORM_TOTP_SECRET is set. */
router.post('/session', validate(z.object({ key: z.string().min(1).max(500), name: z.string().trim().min(1).max(100), code: z.string().max(10).optional() })), async (req, res) => {
  if (!keyOk(req.body.key)) throw forbidden('That platform key is not right');
  const secret = process.env.PLATFORM_TOTP_SECRET;
  const step = secret ? totp.verify(secret, req.body.code) : null;
  if (secret && step === null) throw forbidden('That code is not right');
  if (secret && step <= lastStep) throw forbidden('That code was just used. Wait for the next one.');
  if (secret) lastStep = step;
  await pool.query('INSERT INTO platform_audit (tenant_id, action, actor, detail) VALUES (NULL, ?, ?, NULL)', ['sign_in', req.body.name]);
  res.json({ session: makeSession(req.body.name), hours: SESSION_HOURS, two_step: Boolean(secret) });
});

const log = (conn, req, tenantId, action, detail) => conn.query('INSERT INTO platform_audit (tenant_id, action, actor, detail) VALUES (?, ?, ?, ?)', [tenantId ?? null, action, req.operator || null, detail ? JSON.stringify(detail) : null]);

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
  const t = await rows(pool, `SELECT t.id, t.slug, t.name, t.status, t.timezone, t.created_at, t.storage_cap_mb, t.platform_notes,
      (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id AND u.active = 1) AS users FROM tenants t WHERE t.sandbox_expires_at IS NULL ORDER BY t.name`);
  const used = await usage(t.map((x) => x.id));
  const data = [];
  for (const x of t) data.push({ ...x, users: Number(x.users), storage_used_mb: Math.round(((used.get(x.id) || 0) / 1048576) * 10) / 10, modules: await M.enabledKeys(x.id) });
  res.json({ data });
});

// Demo sign-ups: who tried the demo and whether their demo is still running. Also the call to run from a daily schedule to clear finished demos.
router.get('/sandboxes', async (_req, res) => {
  const data = await rows(pool, `SELECT s.id, s.at, s.email, s.name, s.mountain, s.expires_at, (t.id IS NOT NULL AND t.sandbox_expires_at > NOW()) AS active
      FROM sandbox_signups s LEFT JOIN tenants t ON t.id = s.tenant_id ORDER BY s.id DESC LIMIT 300`);
  const [[c]] = await pool.query('SELECT COUNT(*) AS n FROM tenants WHERE sandbox_expires_at IS NOT NULL');
  res.json({ active: Number(c.n), data: data.map((r) => ({ ...r, active: Boolean(Number(r.active)) })) });
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

router.get('/tenants/:id', async (req, res) => {
  const id = paramId(req);
  const t = await one(pool, 'SELECT id, slug, name, status, timezone, created_at, storage_cap_mb, platform_notes FROM tenants WHERE id = ?', [id]);
  if (!t) throw notFound('Mountain');
  M.invalidate(id);
  const used = await usage([id]);
  const users = await rows(pool, "SELECT id, email, role, active, totp_enabled FROM users WHERE tenant_id = ? AND role IN ('owner','manager') ORDER BY role, email", [id]);
  const history = await rows(pool, 'SELECT at, action, actor, detail FROM platform_audit WHERE tenant_id = ? ORDER BY id DESC LIMIT 30', [id]);
  res.json({ ...t, storage_used_mb: Math.round(((used.get(id) || 0) / 1048576) * 10) / 10, modules: await M.enabledKeys(id), users, history });
});

router.post('/tenants', validate(z.object({
  slug, name: z.string().min(2).max(255), timezone: z.string().default('America/New_York'),
  storage_cap_mb: z.number().int().min(10).max(100000).optional(),
  modules: z.record(z.string(), z.boolean()).optional(),
  owner: z.object({ email: z.string().email(), password, first_name: z.string().min(1), last_name: z.string().min(1) }),
})), async (req, res) => {
  const b = req.body;
  try { new Intl.DateTimeFormat('en-US', { timeZone: b.timezone }); } catch (_) { throw new AppError(400, 'Unknown time zone'); }
  for (const k of Object.keys(b.modules || {})) if (!M.KEYS.includes(k)) throw bad(`Unknown app: ${k}`);
  const hash = await bcrypt.hash(b.owner.password, 12);
  const created = await tx(async (conn) => {
    const [t] = await conn.query('INSERT INTO tenants (slug, name, timezone, storage_cap_mb) VALUES (?, ?, ?, ?)', [b.slug, b.name, b.timezone, b.storage_cap_mb ?? 500]);
    const [p] = await conn.query('INSERT INTO people (tenant_id, first_name, last_name, email) VALUES (?, ?, ?, ?)', [t.insertId, b.owner.first_name, b.owner.last_name, b.owner.email]);
    await conn.query('INSERT INTO users (tenant_id, person_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)', [t.insertId, p.insertId, b.owner.email, hash, 'owner']);
    const on = M.apply({}, b.modules || {});
    for (const k of M.KEYS) await conn.query('INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, ?, ?)', [t.insertId, k, on.includes(k) ? 1 : 0]);
    await log(conn, req, t.insertId, 'create', { slug: b.slug, apps: on });
    return { id: t.insertId, slug: b.slug };
  });
  res.status(201).json(created);
});

router.patch('/tenants/:id', validate(partialOf({
  name: z.string().min(2).max(255), status: z.enum(['active', 'suspended']), storage_cap_mb: z.number().int().min(10).max(100000),
  platform_notes: z.string().max(500).nullable(),
})), async (req, res) => {
  const id = paramId(req);
  const keys = Object.keys(req.body);
  if (!keys.length) throw bad('Nothing to change');
  const [r] = await pool.query(`UPDATE tenants SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => req.body[k]), id]);
  if (!r.affectedRows) throw notFound('Mountain');
  await log(pool, req, id, keys.includes('status') ? req.body.status === 'suspended' ? 'pause' : 'resume' : 'edit', req.body);
  M.invalidate(id);
  res.json({ ok: true });
});

/** Choose which apps a mountain has. Send { modules: { rentals: false, patrol: true } }; anything left out keeps its setting. */
router.put('/tenants/:id/modules', validate(z.object({ modules: z.record(z.string(), z.boolean()) })), async (req, res) => {
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
router.post('/tenants/:id/reset-password', validate(z.object({ user_id: z.number().int().positive(), password, clear_two_step: z.boolean().default(false) })), async (req, res) => {
  const id = paramId(req);
  const u = await one(pool, "SELECT id FROM users WHERE id = ? AND tenant_id = ? AND role IN ('owner','manager')", [req.body.user_id, id]);
  if (!u) throw notFound('Login');
  const hash = await bcrypt.hash(req.body.password, 12);
  await tx(async (conn) => {
    await conn.query('UPDATE users SET password_hash = ?, password_changed_at = NOW() WHERE id = ? AND tenant_id = ?', [hash, u.id, id]);
    if (req.body.clear_two_step) {
      await conn.query('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL WHERE id = ? AND tenant_id = ?', [u.id, id]);
      await conn.query('DELETE FROM user_recovery_codes WHERE user_id = ?', [u.id]);
    }
    await log(conn, req, id, 'password_reset', { user_id: u.id, cleared_two_step: req.body.clear_two_step });
  });
  res.json({ ok: true });
});

router.get('/audit', async (_req, res) => {
  res.json({ data: await rows(pool, 'SELECT a.at, a.action, a.actor, a.detail, t.slug FROM platform_audit a LEFT JOIN tenants t ON t.id = a.tenant_id ORDER BY a.id DESC LIMIT 100') });
});

module.exports = router;
