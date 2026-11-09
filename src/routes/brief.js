'use strict';

// The morning brief in the app: today's brief and the 7 before it (for anyone who missed the email), each person's own
// setting (on or off, email, phone alert or both), who gets it (owners and managers), and phone alerts for the people
// who get a brief but have no Patrol (a ski school Director). Every plan has it; no add-on.
const crypto = require('crypto');
const express = require('express');
const { pool, one } = require('../db');
const { z, validate, paramId, todayIn } = require('../lib/util');
const { notFound, forbidden } = require('../lib/errors');
const { requireRole } = require('../middleware/auth');
const { audit } = require('../lib/audit');
const B = require('../lib/brief');
const modulesLib = require('../lib/modules');

const router = express.Router();
const managers = requireRole('manager');
const tzOf = async (tenantId) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;

/** The person's own brief setting, or a 403 when their role gets no brief. */
async function mine(req) {
  const today = todayIn(await tzOf(req.auth.tenantId));
  const p = await B.forUser(pool, req.auth.tenantId, req.auth.userId, today);
  return { p, today };
}

router.get('/', async (req, res) => {
  const { p, today } = await mine(req);
  res.set('Cache-Control', 'no-store');
  if (!p) return res.json({ eligible: false });
  const list = await B.recent(pool, req.auth.tenantId, p.kind, today);
  const day = await B.dayFor(pool, req.auth.tenantId, today);
  res.json({
    eligible: true, kind: p.kind, on: p.on, channel: p.channel, today,
    brief: list.find((b) => b.sent_on === today) || null,
    earlier: list.filter((b) => b.sent_on !== today).slice(0, 7),
    next: day ? { sent_on: day.sentOn, for_date: day.forDate, at: B.SEND_AT } : null,
  });
});

router.get('/prefs', async (req, res) => {
  const { p } = await mine(req);
  res.json(p ? { eligible: true, kind: p.kind, on: p.on, channel: p.channel, default_on: p.default_on } : { eligible: false });
});

router.put('/prefs', validate(z.object({ on: z.boolean(), channel: z.enum(B.CHANNELS) })), async (req, res) => {
  const { p } = await mine(req);
  if (!p) throw forbidden('Your role does not get a morning brief');
  const next = await B.setPref(pool, req.auth.tenantId, req.auth.userId, req.body, req.auth.userId);
  await audit(pool, req, 'brief_pref', 'brief_prefs', req.auth.userId, next);
  res.json({ eligible: true, kind: p.kind, ...next });
});

/** Everyone who can get a brief, and whether they do (owners and managers choose). */
router.get('/people', managers, async (req, res) => {
  const today = todayIn(await tzOf(req.auth.tenantId));
  const modules = new Set(await modulesLib.enabledKeys(req.auth.tenantId));
  const list = await B.people(pool, req.auth.tenantId, today, modules);
  res.json({ data: list.map((x) => ({ id: x.id, name: x.name, role: x.role, kind: x.kind, on: x.on, channel: x.channel, has_email: Boolean(x.email), default_on: x.default_on })) });
});

router.put('/people/:id', managers, validate(z.object({ on: z.boolean() })), async (req, res) => {
  const id = paramId(req);
  const today = todayIn(await tzOf(req.auth.tenantId));
  const p = await B.forUser(pool, req.auth.tenantId, id, today);
  if (!p) throw notFound('Person who can get a brief');
  const next = await B.setPref(pool, req.auth.tenantId, id, { on: req.body.on }, req.auth.userId);
  await audit(pool, req, 'brief_choose', 'brief_prefs', id, { on: next.on });
  res.json({ id, on: next.on, channel: next.channel });
});

// ---- phone alerts for anyone who gets a brief (the patrol's own routes are only for patrol logins)
async function eligibleOnly(req) { const { p } = await mine(req); if (!p) throw forbidden('Your role does not get a morning brief'); }
router.get('/alerts/key', async (req, res) => { await eligibleOnly(req); res.json({ key: (await require('../lib/push').vapid()).publicKey }); });
router.post('/alerts/subscribe', validate(z.object({ endpoint: z.string().url().max(600).refine((u) => require('../lib/push').pushHostOk(u), 'That is not a phone alert service'), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(60) }) })), async (req, res) => {
  await eligibleOnly(req);
  const b = req.body;
  const hash = crypto.createHash('sha256').update(b.endpoint).digest('hex');
  await pool.query(`INSERT INTO push_subscriptions (tenant_id, user_id, endpoint, endpoint_hash, p256dh, auth) VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE tenant_id = VALUES(tenant_id), user_id = VALUES(user_id), p256dh = VALUES(p256dh), auth = VALUES(auth), failures = 0`, [req.auth.tenantId, req.auth.userId, b.endpoint, hash, b.keys.p256dh, b.keys.auth]);
  await audit(pool, req, 'alerts_on', 'push_subscriptions', null);
  res.status(201).json({ ok: true });
});
router.post('/alerts/unsubscribe', validate(z.object({ endpoint: z.string().max(600) })), async (req, res) => {
  const hash = crypto.createHash('sha256').update(req.body.endpoint).digest('hex');
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint_hash = ? AND user_id = ?', [hash, req.auth.userId]);
  res.json({ ok: true });
});

/** One brief, of the person's own kind (the page's list links here). */
router.get('/:id', async (req, res) => {
  const { p } = await mine(req);
  if (!p) throw forbidden('Your role does not get a morning brief');
  const r = await one(pool, 'SELECT * FROM morning_briefs WHERE tenant_id = ? AND id = ? AND kind = ?', [req.auth.tenantId, paramId(req), p.kind]);
  if (!r) throw notFound('Brief');
  res.json(B.shape(r));
});

module.exports = { router };
