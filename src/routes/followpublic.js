'use strict';

// Public pages behind the follow-up email: tell us how we did, give a gift, stop the emails. Nothing here shows
// any case information; a link only proves "someone with this email was helped", and it shows only the mountain's name.
// Also the daily job that Cloud Scheduler calls.
const crypto = require('crypto');
const express = require('express');
const { pool, one } = require('../db');
const { z, validate } = require('../lib/util');
const { notFound, AppError } = require('../lib/errors');
const stripe = require('../lib/stripe');
const followups = require('../lib/followups');
const { baseUrl } = require('../lib/baseurl');
const { isSandbox } = require('../lib/sandbox');
const kiosk = require('../lib/kiosk');
const messaging = require('../lib/messaging');
const weekly = require('../lib/weekly');
const shopafter = require('../lib/shopafter');
const { stage } = require('../lib/jobs');
const { requireModule } = require('../lib/modules');

const publicRouter = express.Router();
const jobs = express.Router();

const MIN_GIFT = 5; const MAX_GIFT = 10000;
const publicInfo = (t) => ({
  org: followups.orgName(t), mountain: t.name, amounts: followups.amountsOf(t), blurb: t.donate_blurb || null, tax_note: t.tax_note || null,
  giving: Boolean(stripe.enabled()), slug: t.slug,
});
const tokenOk = (s) => /^[a-f0-9]{32}$/.test(s);
async function byToken(token) {
  if (!tokenOk(token)) throw notFound('Link');
  const f = await one(pool, 'SELECT * FROM followups WHERE token = ?', [token]);
  if (!f) throw notFound('Link');
  const t = await one(pool, 'SELECT * FROM tenants WHERE id = ?', [f.tenant_id]);
  try { await requireModule(f.tenant_id, 'patrol'); } catch (_) { throw notFound('Link'); }
  return { f, t };
}

publicRouter.get('/followup/:token', async (req, res) => {
  const { f, t } = await byToken(req.params.token);
  res.json({ ...publicInfo(t), responded: f.responded_at !== null, rating: f.rating, stopped: f.status === 'unsubscribed' });
});

publicRouter.post('/followup/:token/feedback', validate(z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(2000).optional() })), async (req, res) => {
  const { f } = await byToken(req.params.token);
  await pool.query('UPDATE followups SET rating = ?, comment = ?, responded_at = NOW() WHERE id = ?', [req.body.rating, (req.body.comment || '').trim() || null, f.id]);
  res.json({ ok: true });
});

publicRouter.post('/followup/:token/stop', async (req, res) => {
  const { f } = await byToken(req.params.token);
  await pool.query('INSERT IGNORE INTO email_suppressions (tenant_id, email) VALUES (?, ?)', [f.tenant_id, f.to_email]);
  await pool.query("UPDATE followups SET status = 'unsubscribed' WHERE tenant_id = ? AND to_email = ? AND status IN ('held','queued')", [f.tenant_id, f.to_email]);
  res.json({ ok: true });
});

// A gift can start from a follow-up email (token) or from the mountain's public giving page (slug).
const giftSchema = z.object({ amount: z.number().int().min(MIN_GIFT).max(MAX_GIFT), monthly: z.boolean().optional(), email: z.string().email().max(255).optional() });
async function startGift(req, res, tenant, followupId, email) {
  if (!stripe.enabled() || await isSandbox(tenant.id)) throw new AppError(503, 'Online giving is not switched on yet. Please contact the patrol.');
  const base = baseUrl(req);
  const back = followupId ? `${base}/f/${req.params.token}` : `${base}/give/${tenant.slug}`;
  const org = followups.orgName(tenant);
  const s = await stripe.createDonationCheckout({
    amountCents: req.body.amount * 100, monthly: Boolean(req.body.monthly), name: `${req.body.monthly ? 'Monthly gift' : 'Gift'} to the ${org}`, email: req.body.email || email || undefined,
    metadata: { kind: 'donation', tenant_id: String(tenant.id), ...(followupId ? { followup_id: String(followupId) } : {}) },
    successUrl: `${back}?thanks=1`, cancelUrl: back, nonce: crypto.randomBytes(8).toString('hex'),
  });
  res.json({ url: s.url });
}
publicRouter.post('/followup/:token/give', validate(giftSchema), async (req, res) => {
  const { f, t } = await byToken(req.params.token);
  await startGift(req, res, t, f.id, f.for_guardian ? undefined : f.to_email);
});
publicRouter.get('/:slug/give', async (req, res) => {
  const t = await one(pool, 'SELECT * FROM tenants WHERE slug = ?', [req.params.slug]);
  if (!t) throw notFound('Mountain');
  res.json(publicInfo(t));
});
publicRouter.post('/:slug/give', validate(giftSchema), async (req, res) => {
  const t = await one(pool, 'SELECT * FROM tenants WHERE slug = ?', [req.params.slug]);
  if (!t) throw notFound('Mountain');
  await startGift(req, res, t, null, undefined);
});

// ---------------------------------------------------------------- the daily job (Cloud Scheduler)
jobs.post('/daily', async (req, res) => {
  const key = process.env.JOBS_KEY || '';
  const given = String(req.get('x-jobs-key') || '');
  const a = Buffer.from(given); const b = Buffer.from(key);
  if (!key || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new AppError(401, 'Not allowed');
  // Each stage runs even if an earlier one failed; a failure shows in the reply and in the logs.
  const base = baseUrl(req);
  const out = { ...(await stage('patrol_followups', () => followups.runDaily(base))) };
  out.photos_purged = await stage('kiosk_photo_purge', () => kiosk.purgePhotos());
  out.reminders = await stage('messages_reminders', () => messaging.runAll(base));
  out.weekly_reports = await stage('weekly_report', () => weekly.runAll());
  out.shop_emails = await stage('shop_emails', () => shopafter.runAll(base));
  res.json(out);
});

module.exports = { publicRouter, jobs };
