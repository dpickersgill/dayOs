'use strict';
// Guests, round 2, Track FAIR: fair by design. router is mounted at /guests (staff, the sell module); publicRouter under
// /public (no sign-in: the guest's private links, the waitlist, the household's auto-renew switch, the shop's badges).
// tick() runs every 5 minutes (POST /internal/jobs/guests) and daily() in the daily job: each returns a small summary.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { z, validate, paramId, todayIn, addDays } = require('../lib/util');
const { notFound, bad, unauthorized } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { baseUrl } = require('../lib/baseurl');
const F = require('../lib/fairprice');
const PP = require('../lib/paymentplans');
const AR = require('../lib/autorenew');

const router = express.Router();
const publicRouter = express.Router();
const manager = requireRole('manager');
const staff = requireRole('counter', 'manager', 'staff');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const tzOf = async (tenantId) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;

// ================================================================ staff
/** Everything the fair settings page needs: the switches, this track's own settings, the shop badges, card payments. */
router.get('/fair/settings', staff, async (req, res) => {
  const t = req.auth.tenantId;
  const s = await F.settings(pool, t);
  const pay = await require('../lib/connect').payee(t);
  res.json({ ...s, badges: await F.badges(pool, t), cards_ready: Boolean(pay.ok), today: todayIn(await tzOf(t)) });
});
router.patch('/fair/settings', manager, validate(z.object({ renew_on: day.nullable().optional(), renew_rule: z.enum(['lower', 'current']).optional(), travel_minutes: z.number().int().min(1).max(60).optional() })), async (req, res) => {
  await tx(async (conn) => { await F.saveFair(conn, req.auth.tenantId, req.body); await audit(conn, req, 'update', 'fair_settings', req.auth.tenantId, req.body); });
  res.json(await F.settings(pool, req.auth.tenantId));
});
/** Per product: paid in a plan (season passes always can), and a cap with a waitlist. */
router.put('/fair/products/:id', manager, validate(z.object({ plan_ok: z.boolean().optional(), cap: z.number().int().min(1).max(1000000).nullable().optional() })), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = req.body;
  if (!(await one(pool, 'SELECT id FROM products WHERE tenant_id = ? AND id = ?', [t, id]))) throw notFound('Product');
  await pool.query(`INSERT INTO fair_products (tenant_id, product_id, plan_ok, cap) VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE plan_ok = COALESCE(?, plan_ok), cap = IF(?, VALUES(cap), cap)`, [t, id, b.plan_ok ? 1 : 0, b.cap ?? null, b.plan_ok === undefined ? null : (b.plan_ok ? 1 : 0), b.cap !== undefined ? 1 : 0]);
  await audit(pool, req, 'update', 'fair_products', id, b);
  res.json({ ok: true });
});
/** When a product's price for a day goes up next (the shop calendar shows the same). */
router.get('/fair/next-rise', staff, async (req, res) => {
  const pid = Number(req.query.product_id); const d = String(req.query.day || '');
  if (!pid || !day.safeParse(d).success) throw bad('Give product_id and day');
  res.json({ next_rise: await F.nextRise(pool, req.auth.tenantId, pid, d, { tier: String(req.query.tier || 'adult') }) });
});

// ---- closure credits
router.get('/fair/closures', manager, async (req, res) => res.json(await F.closureSuggestions(pool, req.auth.tenantId)));
const closureBody = z.object({ day, scope: z.enum(['mountain', 'main_lifts']).optional(), closed_from: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(), reason: z.string().trim().max(200).nullable().optional() });
router.post('/fair/closures/preview', manager, validate(closureBody), async (req, res) => {
  const p = await F.closurePreview(pool, req.auth.tenantId, req.body.day, { closedFrom: req.body.closed_from ? `${req.body.closed_from}:00` : null });
  res.json({ ...p, items: p.items.map(({ person_id: _p, ...x }) => x) });
});
router.post('/fair/closures', manager, validate(closureBody), async (req, res) => {
  const b = req.body;
  res.status(201).json(await F.closureIssue(req, b.day, { scope: b.scope || 'mountain', closedFrom: b.closed_from ? `${b.closed_from}:00` : null, reason: b.reason || null }));
});

// ---- the conditions guarantee
router.get('/fair/guarantee', manager, async (req, res) => {
  const today = todayIn(await tzOf(req.auth.tenantId));
  const from = day.safeParse(req.query.from).success ? req.query.from : addDays(today, -14);
  res.json({ today, ...(await F.guaranteeClaims(pool, req.auth.tenantId, from, today)) });
});
router.put('/fair/guarantee/off/:date', manager, validate(z.object({ off: z.boolean() })), async (req, res) => {
  if (!day.safeParse(req.params.date).success) throw bad('Use YYYY-MM-DD');
  if (req.body.off) await pool.query('INSERT IGNORE INTO fair_guarantee_off (tenant_id, on_date, user_id) VALUES (?, ?, ?)', [req.auth.tenantId, req.params.date, req.auth.userId]);
  else await pool.query('DELETE FROM fair_guarantee_off WHERE tenant_id = ? AND on_date = ?', [req.auth.tenantId, req.params.date]);
  await audit(pool, req, req.body.off ? 'guarantee_off' : 'guarantee_on', 'fair_guarantee_off', null, { day: req.params.date });
  res.json({ ok: true });
});

// ---- fair scan review
router.get('/fair/review', manager, async (req, res) => res.json(await F.reviewList(pool, req.auth.tenantId)));
router.post('/fair/review/check', manager, async (req, res) => res.json(await F.detect(req.auth.tenantId, { minutes: 24 * 60 })));
router.post('/fair/flags/:id/dismiss', manager, async (req, res) => { await F.dismissFlag(req, paramId(req)); res.json({ ok: true }); });
router.post('/fair/blocks', manager, validate(z.object({ ticket_id: z.number().int().positive().optional(), code: z.string().trim().min(6).max(40).optional(), flag_id: z.number().int().positive().nullable().optional(), reason: z.string().trim().min(5).max(300) })
  .refine((b) => b.ticket_id || b.code, 'Give the ticket or its code')), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const k = b.ticket_id ? await one(pool, 'SELECT id FROM tickets WHERE tenant_id = ? AND id = ?', [t, b.ticket_id]) : await one(pool, 'SELECT id FROM tickets WHERE tenant_id = ? AND code = ?', [t, b.code.toUpperCase().replace(/[\s-]/g, '')]);
  if (!k) throw notFound('Ticket');
  if (b.flag_id && !(await one(pool, 'SELECT id FROM fair_flags WHERE tenant_id = ? AND id = ?', [t, b.flag_id]))) throw notFound('Flag');
  res.status(201).json(await F.block(req, { ticketId: k.id, flagId: b.flag_id || null, reason: b.reason }, baseUrl(req)));
});
router.post('/fair/blocks/:id/lift', manager, validate(z.object({ note: z.string().trim().max(300).nullable().optional() })), async (req, res) => { await F.unblock(req, paramId(req), req.body.note || null); res.json({ ok: true }); });

// ---- payment plans
router.get('/fair/plans', manager, async (req, res) => res.json({ data: await PP.list(pool, req.auth.tenantId) }));
router.get('/fair/plans/:id', manager, async (req, res) => res.json(await PP.get(pool, req.auth.tenantId, paramId(req))));
router.post('/fair/plans/:id/charge', manager, async (req, res) => res.json(await PP.chargeNow(req, paramId(req))));
const noteBody = validate(z.object({ note: z.string().trim().max(300).nullable().optional() }));
router.post('/fair/plans/:id/settle', manager, noteBody, async (req, res) => { await PP.settle(req, paramId(req), req.body.note); res.json(await PP.get(pool, req.auth.tenantId, paramId(req))); });
router.post('/fair/plans/:id/cancel', manager, noteBody, async (req, res) => { await PP.cancel(req, paramId(req), req.body.note); res.json(await PP.get(pool, req.auth.tenantId, paramId(req))); });

// ---- auto-renew and the waitlist
router.get('/fair/renewals', manager, async (req, res) => res.json({ data: await AR.renewalList(pool, req.auth.tenantId) }));
router.get('/fair/waitlist', manager, async (req, res) => res.json({ data: await AR.waitlistList(pool, req.auth.tenantId) }));
/** Staff turn auto-renew on or off for a guest who asks at the desk. */
router.post('/fair/renewals', staff, validate(z.object({ person_id: z.number().int().positive(), on: z.boolean() })), async (req, res) => {
  if (!(await one(pool, 'SELECT id FROM people WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, req.body.person_id]))) throw notFound('Customer');
  res.json(await AR.setRenew(req, req.auth.tenantId, { personId: req.body.person_id, on: req.body.on }, baseUrl(req)));
});

// ================================================================ public
const slow = rateLimit({ windowMs: 10 * 60_000, max: Number(process.env.FAIR_RATE_LIMIT) || 30, message: 'Too many tries from here. Please wait a few minutes.' });
const tokenRe = /^[A-Za-z0-9_-]{30,80}$/;
/** The link's row, or 404 for anything that does not match (unknown, expired, another mountain or kind). */
async function link(req, kind) {
  if (!tokenRe.test(String(req.params.token || ''))) throw notFound('Page');
  const l = await F.linkFor(pool, req.params.slug, kind, req.params.token);
  if (!l) throw notFound('Page');
  return l;
}
const noStore = (res) => res.set('Cache-Control', 'no-store');

/** The shop's badges for the promises this mountain has on. */
publicRouter.get('/:slug/fair', async (req, res) => {
  const t = await one(pool, 'SELECT id FROM tenants WHERE slug = ?', [req.params.slug]);
  if (!t) throw notFound('Mountain');
  res.json({ badges: await F.badges(pool, t.id) });
});

publicRouter.get('/:slug/guarantee/:token', async (req, res) => { noStore(res); res.json(await F.guaranteeView(pool, await link(req, 'guarantee'))); });
publicRouter.post('/:slug/guarantee/:token', slow, validate(z.object({ note: z.string().trim().max(300).nullable().optional() })), async (req, res) => {
  noStore(res); res.json(await F.claimGuarantee(await link(req, 'guarantee'), { note: req.body.note || null }));
});
publicRouter.get('/:slug/blocked/:token', async (req, res) => { noStore(res); res.json(await F.blockedView(pool, await link(req, 'blocked'))); });
publicRouter.post('/:slug/blocked/:token', slow, validate(z.object({ reply: z.string().trim().min(3).max(2000) })), async (req, res) => {
  noStore(res); res.json(await F.blockedReply(await link(req, 'blocked'), req.body.reply));
});

const sessionBody = validate(z.object({ session_id: z.string().trim().min(6).max(255) }));
const back = (req, kind) => `${baseUrl(req)}/${kind}/${encodeURIComponent(req.params.slug)}/${req.params.token}`;
publicRouter.get('/:slug/plan/:token', async (req, res) => { noStore(res); res.json(await PP.guestView(pool, await link(req, 'plan'))); });
publicRouter.post('/:slug/plan/:token/card', slow, async (req, res) => {
  const l = await link(req, 'plan');
  const p = await one(pool, 'SELECT id, card_id, email FROM payment_plans WHERE tenant_id = ? AND id = ?', [l.tenant_id, l.ref_id]);
  res.json(await PP.cardSession(l.tenant_id, p.card_id, { email: p.email, returnUrl: back(req, 'plan'), kind: 'plan', refId: p.id }));
});
publicRouter.post('/:slug/plan/:token/card-done', slow, sessionBody, async (req, res) => { noStore(res); res.json(await PP.planCardDone(await link(req, 'plan'), req.body.session_id)); });

publicRouter.get('/:slug/renew/:token', async (req, res) => { noStore(res); res.json(await AR.renewView(pool, await link(req, 'renew'))); });
publicRouter.post('/:slug/renew/:token', slow, validate(z.object({ on: z.boolean() })), async (req, res) => { noStore(res); res.json(await AR.renewSwitch(await link(req, 'renew'), req.body.on)); });
publicRouter.post('/:slug/renew/:token/card', slow, async (req, res) => {
  const l = await link(req, 'renew');
  const r = await one(pool, 'SELECT id, card_id, email FROM fair_renewals WHERE tenant_id = ? AND id = ?', [l.tenant_id, l.ref_id]);
  res.json(await PP.cardSession(l.tenant_id, r.card_id, { email: r.email, returnUrl: back(req, 'renew'), kind: 'renew', refId: r.id }));
});
publicRouter.post('/:slug/renew/:token/card-done', slow, sessionBody, async (req, res) => { noStore(res); res.json(await AR.renewCardDone(await link(req, 'renew'), req.body.session_id)); });

publicRouter.get('/:slug/pass-offer/:token', async (req, res) => { noStore(res); res.json(await AR.offerView(pool, await link(req, 'offer'))); });
publicRouter.post('/:slug/pass-offer/:token/decline', slow, async (req, res) => { noStore(res); res.json(await AR.offerDecline(await link(req, 'offer'))); });
/** Joins a capped pass's waitlist. Always the same answer, so it never says whether an email was already on it. */
publicRouter.post('/:slug/pass-waitlist', slow, validate(z.object({ product_id: z.number().int().positive(), first_name: z.string().trim().min(1).max(100), last_name: z.string().trim().min(1).max(100), email: z.string().trim().toLowerCase().email().max(255), website: z.string().max(200).optional() })), async (req, res) => {
  const t = await one(pool, 'SELECT id FROM tenants WHERE slug = ?', [req.params.slug]);
  if (!t) throw notFound('Mountain');
  if (!req.body.website) await AR.join(t.id, req.body.product_id, req.body);
  res.status(202).json({ ok: true, message: 'You are on the list. We will email you when a place opens.' });
});

/** The household account's "Renew automatically" switch (ACCOUNT shows it), signed in by the family session. */
async function household(req) {
  const t = await one(pool, 'SELECT id, slug FROM tenants WHERE slug = ?', [req.params.slug]);
  if (!t) throw notFound('Mountain');
  const PG = require('../lib/programplus');
  const email = await PG.sessionEmail(t.id, req.get('x-family-session'));
  if (!email) throw unauthorized('Sign in again: ask for a new link');
  let ids = [];
  try { const H = require('../lib/household'); if (H && H.membersOf) { const me = await one(pool, 'SELECT id FROM people WHERE tenant_id = ? AND email = ? ORDER BY id LIMIT 1', [t.id, email]); if (me) ids = (await H.membersOf(pool, t.id, me.id)).map((m) => Number(m.id || m)); } } catch (_) { ids = []; }
  if (!ids.length) ids = (await PG.familyOf(pool, t.id, email)).ids.map(Number);
  return { t, email, ids };
}
publicRouter.get('/:slug/autorenew', async (req, res) => {
  const h = await household(req); noStore(res);
  res.json(await AR.household(pool, h.t.id, h.ids));
});
publicRouter.post('/:slug/autorenew', slow, validate(z.object({ person_id: z.number().int().positive(), on: z.boolean() })), async (req, res) => {
  const h = await household(req); noStore(res);
  if (!h.ids.includes(req.body.person_id)) throw notFound('Season pass'); // never another household's person
  res.json(await AR.setRenew({ auth: { tenantId: h.t.id, userId: null }, ip: req.ip }, h.t.id, { personId: req.body.person_id, on: req.body.on, email: h.email }, baseUrl(req)));
});

// ================================================================ jobs
const mountains = async (col) => rows(pool, `SELECT t.id FROM tenants t JOIN guest_settings g ON g.tenant_id = t.id WHERE g.${col} = 1`);
const config = require('../config');
async function tick() {
  const out = { plans: await PP.chargeDue(config.stripe.publicUrl || null), flagged: 0, offers: 0 };
  // Scan review for every mountain with scans in the last half hour; the waitlist for every mountain with a capped pass.
  for (const m of await rows(pool, 'SELECT DISTINCT tenant_id AS id FROM scans WHERE scanned_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 40 MINUTE)')) out.flagged += (await F.detect(m.id)).flagged;
  for (const m of await rows(pool, 'SELECT DISTINCT tenant_id AS id FROM fair_products WHERE cap IS NOT NULL')) out.offers += (await AR.waitlistTick(m.id, config.stripe.publicUrl || null)).offered;
  return out;
}
async function daily() {
  const out = { price_drops: 0, renewed: 0, reminded: 0 };
  for (const m of await mountains('price_promise_on')) out.price_drops += (await F.priceDrops(m.id)).refunded;
  for (const m of await mountains('autorenew_on')) { const r = await AR.daily(m.id, config.stripe.publicUrl || null); out.renewed += r.renewed; out.reminded += r.reminded; }
  return out;
}

module.exports = { router, publicRouter, tick, daily };
