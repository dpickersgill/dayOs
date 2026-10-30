'use strict';
// Guests round 2, Track LOYALTY: birthdays, the loyalty rules, recaps (lib/loyalty.js). router is mounted at /guests
// (staff, module sell); publicRouter under /public (no sign-in: the recap page by its private link). tick() runs every 5
// minutes (POST /internal/jobs/guests) and daily() in the daily job.
const express = require('express');
const { pool, tx, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, todayIn, seasonFor } = require('../lib/util');
const { notFound, bad } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { baseUrl } = require('../lib/baseurl');
const { addDays } = require('../lib/util');
const Y = require('../lib/loyalty');

const router = express.Router();
const publicRouter = express.Router();
const manager = requireRole('manager');
const desk = requireRole('counter', 'manager', 'staff', 'instructor');
const seasonLabel = z.string().regex(/^\d{4}-\d{2}$/, 'Use a season like 2026-27');
const tzOf = async (tenantId) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
const pickSeason = async (req) => (seasonLabel.safeParse(req.query.season).success ? req.query.season : seasonFor(todayIn(await tzOf(req.auth.tenantId))));

// ---------------------------------------------------------------- settings (guest_settings has the rest: /guests/settings)
router.get('/loyalty/settings', manager, async (req, res) => res.json(await Y.settingsView(req.auth.tenantId)));
router.patch('/loyalty/settings', manager, validate(Y.extraSchema), async (req, res) => {
  await tx(async (conn) => { await Y.saveExtra(conn, req.auth.tenantId, req.body); await audit(conn, req, 'update', 'guest_loyalty_settings', req.auth.tenantId, req.body); });
  res.json(await Y.settingsView(req.auth.tenantId));
});

// ---------------------------------------------------------------- badges for the welcome-back card (WINDOW calls the lib directly)
router.get('/people/:id/badges', desk, async (req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day || '')) ? req.query.day : todayIn(await tzOf(req.auth.tenantId));
  res.json({ data: await Y.badgesFor(pool, req.auth.tenantId, Number(req.params.id), day) });
});

// ---------------------------------------------------------------- reports for managers
router.get('/loyalty/report', manager, async (req, res) => res.json(await Y.report(pool, req.auth.tenantId, await pickSeason(req))));
router.get('/loyalty/top', manager, async (req, res) => {
  const label = await pickSeason(req);
  const set = await require('../lib/guestsettings').get(pool, req.auth.tenantId);
  const limit = Number(req.query.limit) || set.loyalty_top_n || 20;
  res.json({ season: label, on: Boolean(set.loyalty_top_n), data: await Y.topLoyalists(pool, req.auth.tenantId, label, limit, await tzOf(req.auth.tenantId)) });
});

/**
 * A thank you to top loyalists: an email, with a credit when the manager adds one (once a season per person, kind
 * loyalty). People without an email are skipped and counted.
 */
router.post('/loyalty/top/thanks', manager, validate(z.object({
  person_ids: z.array(z.number().int().positive()).min(1).max(1000),
  note: z.string().trim().max(400).optional(),
  credit_cents: z.number().int().min(0).max(100_000).optional(),
})), async (req, res) => {
  const tenantId = req.auth.tenantId;
  const t = await Y.tenantOf(tenantId);
  const day = todayIn(t.timezone);
  const label = seasonFor(day);
  const win = Y.seasonWindow(null, t.season_ends_on, day);
  const out = { thanked: 0, emailed: 0, skipped: 0 };
  for (const id of [...new Set(req.body.person_ids)]) {
    const p = await one(pool, 'SELECT id, first_name, email, phone, date_of_birth FROM people WHERE tenant_id = ? AND id = ? AND anonymised_at IS NULL', [tenantId, id]);
    if (!p) { out.skipped += 1; continue; }
    const credit = req.body.credit_cents || 0;
    // Without a credit the email still needs a reward to describe; a thank-you with nothing in it is a plain email.
    if (credit) {
      const { reward, fresh } = await Y.give(tenantId, req, { personId: p.id, kind: 'loyalty', reason: 'Thank you for being one of our most loyal guests', options: { credit: { cents: credit } }, validFrom: day, validTo: win.ends >= day ? win.ends : addDays(day, 90), sourceKey: `top:${label}` });
      if (!fresh) { out.skipped += 1; continue; }
      out.thanked += 1;
      if (await Y.mailReward(t, reward, p, day, baseUrl(req), { top: true, note: req.body.note })) out.emailed += 1;
    } else {
      const to = await Y.recipientFor(pool, tenantId, p, day);
      if (!to) { out.skipped += 1; continue; }
      const text = [`Hi ${to.first_name || 'there'},`, '', `${to.self ? 'You are' : `${p.first_name} is`} one of our most loyal guests this season, and we wanted to say thank you.${req.body.note ? ` ${req.body.note}` : ''}`, '', 'See you soon,', t.name].join('\n');
      const r = await require('../lib/mailer').send({ tenantId, to: to.email, fromName: t.name, subject: `Thank you from ${t.name}`, text, tag: 'loyalty-thanks' });
      out.thanked += 1; if (r && r.ok) out.emailed += 1;
    }
  }
  await audit(pool, req, 'loyalty_thanks', 'people', null, { count: out.thanked, credit_cents: req.body.credit_cents || 0 });
  res.json(out);
});

// ---------------------------------------------------------------- season recaps: preview and send now
router.get('/loyalty/season-recaps', manager, async (req, res) => res.json(await Y.seasonRecaps(req.auth.tenantId, await pickSeason(req), baseUrl(req), { preview: true })));
router.post('/loyalty/season-recaps/send', manager, validate(z.object({ season: seasonLabel.optional() })), async (req, res) => {
  const set = await require('../lib/guestsettings').get(pool, req.auth.tenantId);
  if (!set.recap_season_on) throw bad('Season recaps are off. Turn them on first.');
  const label = req.body.season || seasonFor(todayIn(await tzOf(req.auth.tenantId)));
  res.json(await Y.seasonRecaps(req.auth.tenantId, label, baseUrl(req), { req }));
});

// ---------------------------------------------------------------- the recap page (/season/<slug>/<token>), no sign-in
async function mountain(slug) {
  const t = await one(pool, "SELECT id, name, slug, phone FROM tenants WHERE slug = ? AND status = 'active'", [String(slug || '')]);
  if (!t) throw notFound('Page');
  return t;
}
const gone = () => notFound('This link');
async function brand(tenantId) { return one(pool, 'SELECT color, logo FROM shop_brand WHERE tenant_id = ?', [tenantId]).catch(() => null); }
publicRouter.get('/:slug/recap/:token', async (req, res) => {
  const t = await mountain(req.params.slug);
  const v = await Y.recapView(t.id, req.params.token);
  if (!v) throw gone();
  res.set('cache-control', 'no-store').json({ mountain: t.name, phone: t.phone, brand: await brand(t.id), shop: `/shop/${encodeURIComponent(t.slug)}`, kind: v.head.kind, period: v.head.period, people: v.people, stopped: v.stopped });
});
publicRouter.post('/:slug/recap/:token/share', validate(z.object({ index: z.number().int().min(0).max(50).default(0) })), async (req, res) => {
  const t = await mountain(req.params.slug);
  const share = await Y.shareLink(t.id, req.params.token, req.body.index);
  if (!share) throw gone();
  res.json({ url: `${baseUrl(req)}/season/${encodeURIComponent(t.slug)}/share/${share}` });
});
publicRouter.post('/:slug/recap/:token/stop', async (req, res) => {
  const t = await mountain(req.params.slug);
  if (!(await Y.stopRecaps(t.id, req.params.token))) throw gone();
  res.json({ ok: true });
});
publicRouter.get('/:slug/recap-share/:token', async (req, res) => {
  const t = await mountain(req.params.slug);
  const v = await Y.sharedView(t.id, req.params.token);
  if (!v) throw gone();
  res.set('cache-control', 'no-store').json({ mountain: t.name, brand: await brand(t.id), shop: `/shop/${encodeURIComponent(t.slug)}`, ...v });
});

async function tick() { return Y.tick(); }
async function daily() { return Y.daily(); }

module.exports = { router, publicRouter, tick, daily };
