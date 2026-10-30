'use strict';

// The ski school, round 2: families: placement, the family lesson page, recaps, tips, waitlists, changing a date (Track PARENTS).
// router is mounted at /skischool (staff); publicRouter under /public (no sign-in).
// tick() runs every few minutes (POST /jobs/lessons) and daily() once a day (POST /jobs/daily): return a small summary.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId } = require('../lib/util');
const { notFound, conflict, bad, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { baseUrl } = require('../lib/baseurl');
const config = require('../config');
const modules = require('../lib/modules');
const stripe = require('../lib/stripe');
const connect = require('../lib/connect');
const { isSandbox } = require('../lib/sandbox');
const { policyTiers, policyNotes } = require('../lib/onlinesale');
const S = require('../lib/schoolsettings');
const L = require('../lib/levels');
const Q = require('../lib/levelquiz');
const F = require('../lib/lessonfamily');
const R = require('../lib/lessonrecap');
const W = require('../lib/lessonwaitlist');
const B = require('../lib/lessonbasket');
const { textsOn } = require('../lib/familynotify');

const router = express.Router();
const publicRouter = express.Router();
const jobBase = () => config.stripe.publicUrl || config.site.appUrl || '';
const teach = requireRole('instructor', 'manager');
const SA = require('../lib/schoolaccess'); // 2026.11.9: the school director and supervisor
const desk = SA.school('supervisor', 'counter');
const managers = SA.school('director');

// ---------------------------------------------------------------- staff: recaps
router.get('/recaps', teach, async (req, res) => res.json(await R.listFor(req)));
router.get('/recaps/count', teach, async (req, res) => res.json({ count: await R.recapCount(req) }));
const recapBody = z.object({
  skills: z.array(z.object({ id: z.number().int().positive().nullable().optional(), name: z.string().trim().min(1).max(200) })).max(12).optional(),
  level: z.number().int().min(1).max(9).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  body: z.string().trim().max(4000).nullable().optional(),
});
const bookingParam = (req) => { const n = Number(req.params.bookingId); if (!Number.isInteger(n) || n <= 0) throw bad('Bad booking'); return n; };
router.put('/recaps/:bookingId', teach, validate(recapBody), async (req, res) => res.json(await R.saveDraft(req, bookingParam(req), req.body)));
router.post('/recaps/:bookingId/write', teach, validate(recapBody), async (req, res) => res.json(await R.aiDraft(req, bookingParam(req), req.body)));
router.post('/recaps/:bookingId/send', teach, validate(recapBody), async (req, res) => res.json(await R.approveAndSend(req, bookingParam(req), req.body, baseUrl(req))));
router.post('/recaps/:bookingId/skip', teach, async (req, res) => res.json(await R.skip(req, bookingParam(req))));
router.get('/recaps/:bookingId/photos', teach, async (req, res) => res.json({ data: await R.photosOf(req, bookingParam(req)) }));
router.post('/recaps/:bookingId/photos', teach, express.raw({ type: () => true, limit: '4mb' }), async (req, res) => res.status(201).json(await R.addPhoto(req, bookingParam(req), req.body)));
router.get('/recaps/:bookingId/photos/:pid', teach, async (req, res) => {
  const p = await R.staffPhoto(req, bookingParam(req), Number(req.params.pid));
  res.set('Cache-Control', 'private, no-store').type(p.mime).send(p.data);
});
router.delete('/recaps/:bookingId/photos/:pid', teach, async (req, res) => res.json(await R.removePhoto(req, bookingParam(req), Number(req.params.pid))));

// ---------------------------------------------------------------- staff: waitlists
/** Every upcoming lesson with families waiting, for the desk. */
router.get('/waitlists', desk, async (req, res) => {
  const list = await rows(pool, `SELECT s.id, s.starts_at, s.capacity, s.discipline, s.level_min, s.level_max, pr.name AS product,
      (SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status IN ('booked','attended')) AS booked
    FROM lesson_sessions s JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
    WHERE s.tenant_id = ? AND s.status = 'scheduled' AND s.starts_at >= CURDATE() - INTERVAL 1 DAY
      AND EXISTS (SELECT 1 FROM lesson_waitlist w WHERE w.tenant_id = s.tenant_id AND w.session_id = s.id AND w.status IN ('waiting','offered'))
    ORDER BY s.starts_at LIMIT 200`, [req.auth.tenantId]);
  const out = [];
  for (const s of list) out.push({ ...s, level_words: L.range(s.level_min, s.level_max), waiting: await W.forSession(pool, req.auth.tenantId, s.id) });
  res.json({ data: out });
});
router.get('/sessions/:id/waitlist', desk, async (req, res) => res.json({ data: await W.forSession(pool, req.auth.tenantId, paramId(req)) }));
router.delete('/waitlist/:id', desk, async (req, res) => {
  await tx(async (conn) => {
    const [u] = await conn.query("UPDATE lesson_waitlist SET status = 'removed' WHERE tenant_id = ? AND id = ? AND status IN ('waiting','offered')", [req.auth.tenantId, paramId(req)]);
    if (!u.affectedRows) throw notFound('Waitlist place');
    await audit(conn, req, 'waitlist_remove', 'lesson_waitlist', paramId(req), {});
  });
  res.json({ ok: true });
});
/** Looks for open spots now and offers them to the families waiting (after adding places, say). */
router.post('/sessions/:id/waitlist/offer', desk, async (req, res) => {
  const s = await one(pool, 'SELECT id FROM lesson_sessions WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!s) throw notFound('Lesson');
  res.json({ offered: await W.offerNext(req.auth.tenantId, s.id, baseUrl(req)) });
});

// ---------------------------------------------------------------- staff: the families' settings
router.get('/families/settings', managers, async (req, res) => {
  const tid = req.auth.tenantId;
  const extras = await F.productExtras(pool, tid);
  const lessons = await rows(pool, "SELECT id, name, uses FROM products WHERE tenant_id = ? AND kind = 'lesson' AND active = 1 AND (uses IS NULL OR uses <= 1) ORDER BY name", [tid]);
  res.json({
    ...(await F.familySettings(pool, tid)),
    tip_policy_default: F.DEFAULT_TIP_POLICY,
    lesson_products: lessons.map((p) => ({ id: p.id, name: p.name, ticket_product_id: (extras.get(Number(p.id)) || {}).ticket_product_id || null, rental_product_id: (extras.get(Number(p.id)) || {}).rental_product_id || null })),
    tickets: await rows(pool, "SELECT id, name FROM products WHERE tenant_id = ? AND kind IN ('day_ticket','multi_day') AND active = 1 ORDER BY name", [tid]),
    rentals: await rows(pool, "SELECT id, name FROM products WHERE tenant_id = ? AND kind = 'rental' AND active = 1 ORDER BY name", [tid]),
    sells_packs: Boolean(await one(pool, "SELECT id FROM products WHERE tenant_id = ? AND kind = 'lesson' AND active = 1 AND online = 1 AND uses > 1 LIMIT 1", [tid])),
    sells_passes: Boolean(await one(pool, "SELECT id FROM products WHERE tenant_id = ? AND kind = 'season_pass' AND active = 1 AND online = 1 LIMIT 1", [tid])),
  });
});
router.patch('/families/settings', managers, validate(F.familySchema), async (req, res) => {
  await tx(async (conn) => {
    await F.saveFamilySettings(conn, req.auth.tenantId, req.body);
    await audit(conn, req, 'update', 'school_family_settings', req.auth.tenantId, req.body);
  });
  res.json(await F.familySettings(pool, req.auth.tenantId));
});
router.put('/families/extras/:id', managers, validate(z.object({ ticket_product_id: z.number().int().positive().nullable(), rental_product_id: z.number().int().positive().nullable() })), async (req, res) => {
  const tid = req.auth.tenantId; const id = paramId(req);
  const p = await one(pool, "SELECT id FROM products WHERE tenant_id = ? AND id = ? AND kind = 'lesson'", [tid, id]);
  if (!p) throw notFound('Lesson product');
  if (req.body.ticket_product_id && !(await one(pool, "SELECT id FROM products WHERE tenant_id = ? AND id = ? AND kind IN ('day_ticket','multi_day')", [tid, req.body.ticket_product_id]))) throw bad('Pick a lift ticket');
  if (req.body.rental_product_id && !(await one(pool, "SELECT id FROM products WHERE tenant_id = ? AND id = ? AND kind = 'rental'", [tid, req.body.rental_product_id]))) throw bad('Pick a rental');
  await tx(async (conn) => {
    await conn.query('INSERT INTO lesson_product_extras (tenant_id, product_id, ticket_product_id, rental_product_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE ticket_product_id = VALUES(ticket_product_id), rental_product_id = VALUES(rental_product_id)',
      [tid, id, req.body.ticket_product_id, req.body.rental_product_id]);
    await audit(conn, req, 'update', 'lesson_product_extras', id, req.body);
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- public: the mountain, for the family pages
async function mountainFor(slug) {
  const t = await one(pool, 'SELECT id, name, slug, phone, timezone, waiver_text, online_booking, booking_notice_hours, cancel_hours, online_payment, refund_full_hours, refund_half_hours, refund_half_percent, cancel_note, stripe_account, stripe_charges_enabled FROM tenants WHERE slug = ?', [slug]);
  if (!t) throw notFound('Page');
  if (!(await modules.enabledKeys(t.id)).includes('school')) throw notFound('Page');
  t.pay_online = Boolean(t.online_payment) && connect.readyRow(t) && !(await isSandbox(t.id));
  delete t.stripe_account; delete t.stripe_charges_enabled;
  return t;
}
async function familyBooking(req) {
  const t = await mountainFor(req.params.slug);
  const b = await F.bookingByToken(pool, t.id, req.params.token);
  if (!b) throw notFound('Lesson');
  return { t, b };
}
const noStore = (res) => res.set('Cache-Control', 'no-store');

// ---- find my level
publicRouter.get('/:slug/level-quiz', async (req, res) => {
  const t = await mountainFor(req.params.slug);
  noStore(res);
  res.json({ mountain: t.name, online_booking: Boolean(t.online_booking), questions: Q.QUESTIONS, levels: { ski: L.list('ski'), snowboard: L.list('snowboard') } });
});

// ---- the family lesson page
publicRouter.get('/:slug/lesson/:token', async (req, res) => {
  const { t, b } = await familyBooking(req);
  noStore(res);
  res.json(await F.familyView(t, b, { slug: t.slug }));
});
const detailsSchema = z.object({
  allergies: z.string().trim().max(300).nullable().optional(), medical: z.string().trim().max(500).nullable().optional(), pickup: z.string().trim().max(300).nullable().optional(),
  text_ok: z.boolean().optional(), photo_ok: z.boolean().optional(),
});
publicRouter.patch('/:slug/lesson/:token', validate(detailsSchema), async (req, res) => {
  const { t, b } = await familyBooking(req);
  noStore(res);
  if (req.body.text_ok && !(await textsOn(t.id))) delete req.body.text_ok;
  await F.updateDetails(t, b, req.body);
  res.json({ ok: true });
});
publicRouter.get('/:slug/lesson/:token/dates', async (req, res) => {
  const { t, b } = await familyBooking(req);
  noStore(res);
  const pol = await F.policyNow(pool, t, b);
  res.json({ can_change: pol.can_change, why: pol.why, lessons: pol.can_change ? await F.moveChoices(pool, t, b) : [] });
});
publicRouter.post('/:slug/lesson/:token/move', validate(z.object({ session_id: z.number().int().positive() })), async (req, res) => {
  const { t, b } = await familyBooking(req);
  noStore(res);
  const out = await F.moveBooking(t, b, req.body.session_id);
  await require('../lib/lessonconfirm').sendConfirmation(pool, t.id, b.id, baseUrl(req), { moved: true }).catch(() => {});
  await W.offerNext(t.id, out.from, baseUrl(req)).catch(() => 0);
  res.json({ ok: true });
});
publicRouter.post('/:slug/lesson/:token/cancel', async (req, res) => {
  const { t, b } = await familyBooking(req);
  noStore(res);
  const out = await F.cancelBooking(t, b);
  if (out.refundId) await require('../lib/cardrefund').send(t.id, out.refundId);
  await W.offerNext(t.id, b.session_id, baseUrl(req)).catch(() => 0);
  res.json({ ok: true, refund_cents: out.refund_cents, refund_percent: out.refund_percent, credit_returned: out.credit_returned });
});
publicRouter.get('/:slug/lesson/:token/photos/:pid', async (req, res) => {
  const { t, b } = await familyBooking(req);
  const p = await R.familyPhoto(t.id, b, Number(req.params.pid));
  if (!p) throw notFound('Photo');
  res.set('Cache-Control', 'private, no-store').type(p.mime).send(p.data);
});

// ---- tips: paid in full to the instructor, on the mountain's own card account
publicRouter.post('/:slug/lesson/:token/tip', validate(z.object({ amount_cents: z.number().int().min(100).max(50000) })), async (req, res) => {
  const { t, b } = await familyBooking(req);
  noStore(res);
  const view = await F.familyView(t, b, { slug: t.slug });
  if (!view.tips) throw conflict('Tips are not open for this lesson');
  const [r] = await pool.query("INSERT INTO lesson_tips (tenant_id, booking_id, session_id, staff_id, amount_cents, status) VALUES (?, ?, ?, ?, ?, 'pending')", [t.id, b.id, b.session_id, b.instructor_id, req.body.amount_cents]);
  const tipId = r.insertId;
  let co;
  try {
    const pay = connect.checkoutFor(await connect.payeeOrThrow(t.id), req.body.amount_cents, { tenant_id: String(t.id), tip_id: String(tipId), kind: 'lesson_tip' });
    co = await stripe.createCheckout({
      amountCents: req.body.amount_cents, name: `A tip for ${view.lesson.instructor || 'your instructor'}`, description: `${t.name}: ${view.lesson.product}`, reference: `TIP${tipId}`, ...pay,
      idempotencyKey: `lesson_tip-${tipId}`,
      successUrl: `${baseUrl(req)}/lesson/${encodeURIComponent(t.slug)}/${req.params.token}?tip=${tipId}`, cancelUrl: `${baseUrl(req)}/lesson/${encodeURIComponent(t.slug)}/${req.params.token}`,
    });
  } catch (err) {
    await pool.query("UPDATE lesson_tips SET status = 'failed' WHERE tenant_id = ? AND id = ?", [t.id, tipId]);
    throw err;
  }
  await pool.query('UPDATE lesson_tips SET stripe_session_id = ? WHERE tenant_id = ? AND id = ?', [co.id, t.id, tipId]);
  res.status(201).json({ checkout_url: co.url, tip_id: tipId });
});
publicRouter.post('/:slug/lesson/:token/tips/:id/check', async (req, res) => {
  const { t, b } = await familyBooking(req);
  noStore(res);
  const tip = await one(pool, 'SELECT id FROM lesson_tips WHERE tenant_id = ? AND id = ? AND booking_id = ?', [t.id, paramId(req), b.id]);
  if (!tip) throw notFound('Tip');
  res.json({ status: await F.checkTip(t.id, tip.id) });
});

// ---- the waitlist
publicRouter.post('/:slug/waitlist', validate(W.joinSchema), async (req, res) => {
  const t = await mountainFor(req.params.slug);
  noStore(res);
  if (!t.online_booking) throw notFound('Page');
  if (req.body.website) return res.status(202).json({ ok: true });
  if (req.body.text_ok && !(await textsOn(t.id))) req.body.text_ok = false;
  const out = await W.join(t, req.body);
  res.status(201).json({ ok: true, position: out.position });
});
publicRouter.get('/:slug/waitlist/:token', async (req, res) => {
  const t = await mountainFor(req.params.slug);
  noStore(res);
  const w = await W.offerByToken(t.id, req.params.token);
  if (!w) throw notFound('Offer');
  const set = await S.get(pool, t.id);
  res.json({ mountain: t.name, phone: t.phone, pay_online: t.pay_online, waiver_text: t.waiver_text, policy_tiers: policyTiers(t), policy_notes: policyNotes(t),
    texts_available: await textsOn(t.id), photos_asked: Boolean(set.recap_photos), ...W.claimView(w) });
});
const claimSchema = z.object({
  contact_first_name: z.string().trim().min(1).max(100), contact_last_name: z.string().trim().min(1).max(100),
  contact_email: z.string().trim().email().max(255), contact_phone: z.string().trim().min(7).max(40),
  student: B.studentSchema, waiver_accepted: z.boolean(), policy_accepted: z.boolean().optional(),
});
publicRouter.post('/:slug/waitlist/:token/claim', validate(claimSchema), async (req, res) => {
  const t = await mountainFor(req.params.slug);
  noStore(res);
  const w = await W.offerByToken(t.id, req.params.token);
  if (!w) throw notFound('Offer');
  if (!Number(w.open_now)) throw conflict(w.status === 'claimed' ? 'This spot is already claimed.' : 'This offer has run out. The spot went to the next family on the waitlist.');
  if (req.body.student.text_ok && !(await textsOn(t.id))) req.body.student.text_ok = false;
  const out = await B.create(t, { ...req.body, items: [{ session_id: Number(w.session_id), student: req.body.student }] }, { base: baseUrl(req), slug: t.slug, waitlistId: w.id });
  res.status(201).json(out);
});

// ---------------------------------------------------------------- jobs
async function tick() {
  const out = {};
  out.waitlist = await W.tick(jobBase());
  out.recaps_due = await R.tick();
  return out;
}
async function daily() {
  return { followups: await F.followups(jobBase()), photos_deleted: await R.cleanup() };
}

module.exports = { router, publicRouter, tick, daily, mountainFor };
