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
const connect = require('../lib/connect');
const followups = require('../lib/followups');
const { baseUrl } = require('../lib/baseurl');
const { isSandbox } = require('../lib/sandbox');
const kiosk = require('../lib/kiosk');
const messaging = require('../lib/messaging');
const { jobAuth } = require('../lib/jobauth'); // Cloud Scheduler's Google-signed token, or the old key until that is set up
const weekly = require('../lib/weekly');
const shopafter = require('../lib/shopafter');
const cardrefund = require('../lib/cardrefund');
const { stage } = require('../lib/jobs');
const { requireModule } = require('../lib/modules');

const publicRouter = express.Router();
const jobs = express.Router();

const MIN_GIFT = 5; const MAX_GIFT = 10000;
const publicInfo = (t) => ({
  org: followups.orgName(t), mountain: t.name, amounts: followups.amountsOf(t), blurb: t.donate_blurb || null, tax_note: t.tax_note || null,
  giving: connect.readyRow(t), slug: t.slug,
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
  const payTo = await connect.payee(tenant.id);
  if (!payTo.ok || await isSandbox(tenant.id)) throw new AppError(503, 'Online giving is not switched on yet. Please contact the patrol.');
  const base = baseUrl(req);
  const back = followupId ? `${base}/f/${req.params.token}` : `${base}/give/${tenant.slug}`;
  const org = followups.orgName(tenant);
  const s = await stripe.createDonationCheckout({
    amountCents: req.body.amount * 100, monthly: Boolean(req.body.monthly), name: `${req.body.monthly ? 'Monthly gift' : 'Gift'} to the ${org}`, email: req.body.email || email || undefined,
    metadata: { kind: 'donation', tenant_id: String(tenant.id), ...(followupId ? { followup_id: String(followupId) } : {}) },
    successUrl: `${back}?thanks=1`, cancelUrl: back, nonce: crypto.randomBytes(8).toString('hex'), account: payTo.account, // to the mountain's own account, no platform fee
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
const DAILY_BRIEF_BUDGET_MS = 60000; // the brief stage inside the daily job (the 15-minute brief job covers the rest)
jobs.post('/daily', jobAuth, async (req, res) => {
  // Only one run at a time, across every server: a second call waits up to a minute for the first to finish, then is
  // turned away (each email is also claimed before sending, so even an overlap could not send twice).
  const conn = await pool.getConnection();
  try {
    const [[got]] = await conn.query("SELECT GET_LOCK('summitops_daily_job', 60) AS ok");
    if (!Number(got.ok)) throw new AppError(409, 'The daily job is already running');
    const started = Date.now();
    // Each stage runs even if an earlier one failed; a failure shows in the reply and in the logs.
    const base = baseUrl(req);
    const out = { ...(await stage('patrol_followups', () => followups.runDaily(base))) };
    out.photos_purged = await stage('kiosk_photo_purge', () => kiosk.purgePhotos());
    out.reminders = await stage('messages_reminders', () => messaging.runAll(base));
    out.weekly_reports = await stage('weekly_report', () => weekly.runAll());
    out.shop_emails = await stage('shop_emails', () => shopafter.runAll(base));
    out.card_refunds = await stage('card_refunds', () => cardrefund.retryAll());
    out.reader_payments = await stage('reader_payments', () => require('./terminal').sweep());
    out.rental_deposits = await stage('rental_deposits', () => require('../lib/rentaldeposit').sweep());
    out.rental_season_reminders = await stage('rental_season_reminders', () => require('../lib/rentalseason').remindAll());
    out.review_nudges = await stage('review_nudges', () => require('../lib/review').nudgeAll());
    out.access_summary = await stage('access_summary', () => require('../lib/accesssummary').runAll(base)); // Mondays: patient record access, last week
    out.billing_reminders = await stage('billing_reminders', () => require('../lib/billing').remindAll(base));
    out.season_billing = await stage('season_billing', () => require('../lib/billing').seasonAll());
    out.patrol_day_reminders = await stage('patrol_day_reminders', () => require('./patrolduty').remindAll());
    out.patrol_short_weekend = await stage('patrol_short_weekend', () => require('./patrolcrews').shortAlertAll());
    out.patrol_stock_flags = await stage('patrol_stock_flags', () => require('./patrolmeds').flagAll());
    out.recycling_report = await stage('recycling_report', () => require('../lib/recyclingreport').daily(base)); // 2026.11.22: the year's report opens in December; reminders Jan 15, follow-up Feb 1
    out.cart_pages = await stage('cart_pages', () => require('../lib/carts').expireUnpaid()); // 2026.11.22: unpaid cart request card pages let go after a day
    out.building_cert_reminders = await stage('building_cert_reminders', () => require('../lib/buildings').remindAll()); // muni release 1: certificates 60, 30 and 7 days ahead
    out.staff_injury_notices = await stage('staff_injury_notices', () => require('../lib/staffinjury').retryDue(base)); // notices that could not be sent (2026.11.11)
    // One weather breaker for the day records, the snapshots and the brief (lib/wxrun.js): a weather service that hangs
    // costs at most 3 lookups of 10 seconds for the whole job, not 10 seconds per mountain. Stage limits: DEPLOY.md.
    const wx = require('../lib/wxrun').newRun();
    out.day_records = await stage('day_records', () => require('../lib/dayrecord').runAll({ run: wx }));
    out.snapshots = await stage('snapshots', () => require('../lib/snapshots').runAll({ run: wx })); // forecast data: presales, weather, staffing, prices (time-capped)
    out.program_reminders = await stage('program_reminders', () => require('../lib/programplus').remindAll());
    out.lessons = await stage('lessons_daily', () => require('../lib/schooltick').daily());
    out.guests = await stage('guests_daily', () => require('../lib/guesttick').daily());
    out.retention = await stage('retention', () => require('../lib/retention').runAll());
    out.demo_emails = await stage('demo_emails', () => require('../lib/demomail').runAll(base));
    out.outreach = await stage('outreach', () => require('../lib/outreach').runDue());
    // What the 15-minute brief job left (2026.11.15). That job does the sending; here 60 seconds, plus one call at most.
    out.morning_brief = await stage('morning_brief', () => require('../lib/brief').runDue({ base, budgetMs: DAILY_BRIEF_BUDGET_MS, run: wx }));
    out.rate_limits_removed = await stage('rate_limits_cleanup', () => require('../lib/ratestore').cleanup()); // old shared rate limit counts (2026.11.10)
    // One line per finished run: an alert on "no such line for 26 hours" tells you the job stopped.
    console.log(JSON.stringify({ severity: 'INFO', job: 'daily', message: 'daily job finished', seconds: Math.round((Date.now() - started) / 1000) }));
    res.json(out);
  } finally {
    await conn.query("SELECT RELEASE_LOCK('summitops_daily_job')").catch(() => {});
    conn.release();
  }
});

// ---------------------------------------------------------------- the morning brief (Cloud Scheduler, every 15 minutes)
// Sends each mountain's brief from 6:00 AM its own time on open days (lib/brief.js). Safe to run as often as wanted: a
// send is claimed before it goes, and a run stops starting sends after 100 seconds; the next run carries on.
jobs.post('/brief', jobAuth, async (req, res) => {
  const out = await stage('morning_brief', () => require('../lib/brief').runDue({ base: baseUrl(req), budgetMs: 100000 }));
  res.json(out);
});

// ---------------------------------------------------------------- guests (Cloud Scheduler, every 5 minutes)
// Birthday gifts due, evening recaps, price promises, payment plan charges, waitlist and renewal offers.
jobs.post('/guests', jobAuth, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const [[got]] = await conn.query("SELECT GET_LOCK('summitops_guests_job', 5) AS ok");
    if (!Number(got.ok)) throw new AppError(409, 'The guests job is already running');
    const out = await require('../lib/guesttick').tick();
    // Staff injury notices whose email could not go out are tried again every 5 minutes (OSHA's 8 and 24 hours).
    out.staff_injury_notices = await require('../lib/staffinjury').retryDue(baseUrl(req)).catch((e) => ({ error: e.message }));
    // A municipality's bulk pickup reminders, the afternoon before collection day (muni release 1).
    out.bulk_reminders = await require('../lib/bulkpickup').remindDue(baseUrl(req)).catch((e) => ({ error: e.message }));
    // Missed pickups where a contracted hauler collects go to the hauler by email (2026.11.22, Hauler oversight add-on).
    out.hauler_forwards = await require('../lib/collectionroutes').forwardDue(baseUrl(req)).catch((e) => ({ error: e.message }));
    // The collection calendar's night-before reminders, from 6 PM local (2026.11.22, lib/collectionremind.js).
    out.collection_reminders = await require('../lib/collectionremind').remindDue(baseUrl(req)).catch((e) => ({ error: e.message }));
    res.json(out);
  } finally {
    await conn.query("SELECT RELEASE_LOCK('summitops_guests_job')").catch(() => {});
    conn.release();
  }
});

// ---------------------------------------------------------------- the ski school (Cloud Scheduler, every 5 minutes)
// Waitlist offers that ran out, privates the instructor did not answer in time, recaps due, weather choices.
jobs.post('/lessons', jobAuth, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const [[got]] = await conn.query("SELECT GET_LOCK('summitops_lessons_job', 5) AS ok");
    if (!Number(got.ok)) throw new AppError(409, 'The lessons job is already running');
    res.json(await require('../lib/schooltick').tick());
  } finally {
    await conn.query("SELECT RELEASE_LOCK('summitops_lessons_job')").catch(() => {});
    conn.release();
  }
});

// ---------------------------------------------------------------- prospect outreach (Cloud Scheduler, every 30 minutes on weekdays)
// Sends what is due inside the sending hours and checks threads for replies and bounces (lib/outreach.js).
jobs.post('/outreach', jobAuth, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const [[got]] = await conn.query("SELECT GET_LOCK('summitops_outreach_job', 5) AS ok");
    if (!Number(got.ok)) throw new AppError(409, 'The outreach job is already running');
    res.json(await stage('outreach', () => require('../lib/outreach').runDue()));
  } finally {
    await conn.query("SELECT RELEASE_LOCK('summitops_outreach_job')").catch(() => {});
    conn.release();
  }
});

// ---------------------------------------------------------------- "not interested" from an outreach email (/o/<token>)
publicRouter.get('/outreach-stop/:token', async (req, res) => {
  if (!tokenOk(req.params.token)) throw notFound('Link');
  const seq = await one(pool, 'SELECT status FROM outreach_sequences WHERE token = ?', [req.params.token]);
  if (!seq) throw notFound('Link');
  res.json({ stopped: seq.status === 'not_interested' });
});
// The page's button, and a mail app's one-click unsubscribe (RFC 8058) both land here.
publicRouter.post('/outreach-stop/:token', async (req, res) => {
  if (!tokenOk(req.params.token)) throw notFound('Link');
  const seq = await require('../lib/outreach').notInterested(pool, req.params.token);
  if (!seq) throw notFound('Link');
  res.json({ ok: true });
});

module.exports = { publicRouter, jobs };
