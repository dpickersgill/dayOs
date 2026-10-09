'use strict';

// The operator's console: add mountains, pause them, choose which apps each one has, set a storage limit and reset an owner's password.
// Every call needs the platform key (the BOOTSTRAP_KEY setting) in the X-Platform-Key header. A mountain's own logins never work here.
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool, tx, rows, one } = require('../db');
const config = require('../config');
const { z, validate, paramId, partialOf } = require('../lib/util');
const { AppError, bad, forbidden, notFound } = require('../lib/errors');
const M = require('../lib/modules');
const sandbox = require('../lib/sandbox');

const router = express.Router();

const slug = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, 'Lowercase letters, numbers and dashes');
const password = z.string().min(10, 'Use at least 10 characters').max(200);
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

router.use((req, _res, next) => {
  const expected = config.bootstrapKey;
  const supplied = req.get('x-platform-key') || req.get('x-bootstrap-key') || '';
  if (!expected || !crypto.timingSafeEqual(digest(supplied), digest(expected))) return next(forbidden('That platform key is not right'));
  return next();
});

const log = (conn, tenantId, action, detail) => conn.query('INSERT INTO platform_audit (tenant_id, action, detail) VALUES (?, ?, ?)', [tenantId ?? null, action, detail ? JSON.stringify(detail) : null]);

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
router.post('/sandboxes/purge', async (_req, res) => {
  const removed = await sandbox.purgeExpired();
  await log(pool, null, 'purge_demos', { removed });
  res.json({ removed });
});

router.get('/tenants/:id', async (req, res) => {
  const id = paramId(req);
  const t = await one(pool, 'SELECT id, slug, name, status, timezone, created_at, storage_cap_mb, platform_notes FROM tenants WHERE id = ?', [id]);
  if (!t) throw notFound('Mountain');
  M.invalidate(id);
  const used = await usage([id]);
  const users = await rows(pool, "SELECT id, email, role, active, totp_enabled FROM users WHERE tenant_id = ? AND role IN ('owner','manager') ORDER BY role, email", [id]);
  const history = await rows(pool, 'SELECT at, action, detail FROM platform_audit WHERE tenant_id = ? ORDER BY id DESC LIMIT 30', [id]);
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
    await log(conn, t.insertId, 'create', { slug: b.slug, apps: on });
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
  await log(pool, id, keys.includes('status') ? req.body.status === 'suspended' ? 'pause' : 'resume' : 'edit', req.body);
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
    await log(conn, id, 'apps', { turned_on: on.filter((k) => !before.includes(k)), turned_off: before.filter((k) => !on.includes(k)) });
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
    await log(conn, id, 'password_reset', { user_id: u.id, cleared_two_step: req.body.clear_two_step });
  });
  res.json({ ok: true });
});

router.get('/audit', async (_req, res) => {
  res.json({ data: await rows(pool, 'SELECT a.at, a.action, a.detail, t.slug FROM platform_audit a LEFT JOIN tenants t ON t.id = a.tenant_id ORDER BY a.id DESC LIMIT 100') });
});

module.exports = router;
