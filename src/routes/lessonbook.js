'use strict';

// The public lesson booking page. No sign-in: anyone with the mountain's link can see the open lessons and ask for a
// place. A request holds no spot and takes no money (no card processor is connected); staff confirm it, and the guest pays
// at the ski school desk. Everything here is small, rate limited, ignores unknown fields and never returns private data.
const crypto = require('crypto');
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { z, dateStr, validate, nowIn, todayIn, addDays } = require('../lib/util');
const { notFound, conflict, bad, Unhonourable } = require('../lib/errors');
const { isMinor } = require('../lib/family');
const config = require('../config');
const stripe = require('../lib/stripe');
const connect = require('../lib/connect');
const { quoteFor, hoursUntil, refundPercent, policyText, policyTiers, policyNotes, confirmRequest, parse: parseRequest } = require('../lib/onlinesale');
const { audit } = require('../lib/audit');
const { isSandbox } = require('../lib/sandbox');
const shopsale = require('../lib/shopsale');
const shopafter = require('../lib/shopafter');
const cardrefund = require('../lib/cardrefund');

const router = express.Router();
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const reference = () => Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');
const MAX_PENDING_PER_LESSON = 12;
const MAX_PENDING_TOTAL = 80;

async function tenantFor(slug) {
  const t = await one(pool, 'SELECT id, name, phone, timezone, waiver_text, online_booking, booking_notice_hours, booking_message, cancel_hours, online_payment, refund_full_hours, refund_half_hours, refund_half_percent, cancel_note, stripe_account, stripe_charges_enabled FROM tenants WHERE slug = ?', [slug]);
  if (!t || !t.online_booking) throw notFound('Booking page');
  t.pay_online = Boolean(t.online_payment) && connect.readyRow(t) && !(await isSandbox(t.id)); // to the mountain's own Stripe account
  delete t.stripe_account; delete t.stripe_charges_enabled;
  return t;
}
const HOLD = "('pending','awaiting_payment')";
const baseUrl = (req) => config.stripe.publicUrl || `${req.protocol}://${req.get('host')}`;

/** Wall-clock time (as 'YYYY-MM-DD HH:MM:SS') this many hours from now in the mountain's zone. */
function inHours(tz, hours) {
  const now = nowIn(tz);
  const d = new Date(`${now.replace(' ', 'T')}Z`);
  d.setUTCHours(d.getUTCHours() + hours);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

router.get('/:slug/booking', async (req, res) => {
  const t = await tenantFor(req.params.slug);
  const today = todayIn(t.timezone);
  const earliest = inHours(t.timezone, t.booking_notice_hours);
  const sessions = await rows(pool,
    `SELECT s.id, s.starts_at, s.ends_at, s.discipline, s.ability_level, s.format, s.age_group, s.meeting_place, s.capacity, pr.id AS product_id, pr.name AS product, pr.base_price_cents,
       (SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status IN ('booked','attended')) AS booked
     FROM lesson_sessions s JOIN products pr ON pr.id = s.product_id AND pr.tenant_id = s.tenant_id
     WHERE s.tenant_id = ? AND s.status = 'scheduled' AND pr.active = 1 AND s.starts_at >= ? AND DATE(s.starts_at) <= ? ORDER BY s.starts_at LIMIT 300`,
    [t.id, earliest, addDays(today, 45)]);
  const pend = await rows(pool, `SELECT session_id, students FROM lesson_requests WHERE tenant_id = ? AND status IN ${HOLD}`, [t.id]);
  const held = new Map();
  for (const r of pend) { let n = 1; try { n = JSON.parse(r.students).students.length; } catch (_) { /* count one */ } held.set(r.session_id, (held.get(r.session_id) || 0) + n); }
  const tiers = await rows(pool, 'SELECT product_id, tier, price_cents FROM price_tiers WHERE tenant_id = ?', [t.id]);
  res.set('Cache-Control', 'no-store');
  res.json({
    guest_types: (await require('../lib/guesttypes').list(pool, t.id, { visibleOnly: true })).map((g) => ({ code: g.code, name: g.name })),
    mountain: t.name, phone: t.phone, message: t.booking_message, notice_hours: t.booking_notice_hours, cancel_hours: t.cancel_hours, waiver_text: t.waiver_text, pay_online: t.pay_online, policy: policyText(t), policy_tiers: policyTiers(t), policy_notes: policyNotes(t),
    lessons: sessions.map((s) => ({
      id: s.id, starts_at: s.starts_at, ends_at: s.ends_at, product: s.product, discipline: s.discipline, ability_level: s.ability_level, format: s.format, age_group: s.age_group, meeting_place: s.meeting_place,
      price_cents: s.base_price_cents, prices: tiers.filter((x) => x.product_id === s.product_id).map((x) => ({ tier: x.tier, price_cents: x.price_cents })),
      spots_left: Math.max(s.capacity - Number(s.booked) - (held.get(s.id) || 0), 0),
    })).filter((s) => s.spots_left > 0),
  });
});

/** The exact price for these students, tax included, so the guest sees the total before they pay. */
router.post('/:slug/quote', validate(z.object({ session_id: z.number().int().positive(), students: z.array(z.object({ date_of_birth: dateStr })).min(1).max(6) })), async (req, res) => {
  const t = await tenantFor(req.params.slug);
  const s = await one(pool, "SELECT id, starts_at, product_id FROM lesson_sessions WHERE tenant_id = ? AND id = ? AND status = 'scheduled'", [t.id, req.body.session_id]);
  if (!s) throw notFound('Lesson');
  const qt = await quoteFor(pool, t.id, s, req.body.students);
  res.set('Cache-Control', 'no-store');
  res.json({ subtotal_cents: qt.subtotal, tax_cents: qt.tax, total_cents: qt.total, lines: qt.lines.map((l) => ({ tier: l.tier, price_cents: l.unit })) });
});

const studentSchema = z.object({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  date_of_birth: dateStr,
  sex: z.enum(['female', 'male', 'other']),
  discipline: z.enum(['ski', 'snowboard', 'telemark', 'adaptive']).optional(),
  ability_level: z.enum(['first_timer', 'beginner', 'intermediate', 'advanced']).optional(),
  height_in: z.number().int().min(20).max(96).optional(),
  weight_lb: z.number().int().min(20).max(500).optional(),
  boot_size: z.string().trim().max(10).optional(),
});
const requestSchema = z.object({
  session_id: z.number().int().positive(),
  contact_first_name: z.string().trim().min(1).max(100),
  contact_last_name: z.string().trim().min(1).max(100),
  contact_email: z.string().trim().email().max(255),
  contact_phone: z.string().trim().min(7).max(40),
  students: z.array(studentSchema).min(1).max(6),
  waiver_accepted: z.boolean(),
  policy_accepted: z.boolean().optional(),
  note: z.string().trim().max(500).optional(),
  website: z.string().max(200).optional(), // hidden field: people leave it empty, form-filling bots do not
});

router.post('/:slug/requests', validate(requestSchema), async (req, res) => {
  const t = await tenantFor(req.params.slug);
  const b = req.body;
  res.set('Cache-Control', 'no-store');
  if (b.website) return res.status(202).json({ ok: true }); // pretend success, create nothing
  if (!b.waiver_accepted) throw bad('Please read and accept the waiver to ask for a lesson');
  if (t.pay_online && !b.policy_accepted) throw bad('Please read and accept the cancellation policy');
  const out = await tx(async (conn) => {
    const s = await one(conn, "SELECT * FROM lesson_sessions WHERE tenant_id = ? AND id = ? AND status = 'scheduled' FOR UPDATE", [t.id, b.session_id]);
    if (!s) throw notFound('Lesson');
    if (s.starts_at < inHours(t.timezone, t.booking_notice_hours)) throw conflict(`Online requests close ${t.booking_notice_hours} hours before the lesson. Please call the ski school.`);
    const day = s.starts_at.slice(0, 10);
    const { n } = await one(conn, "SELECT COUNT(*) AS n FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND status IN ('booked','attended')", [t.id, s.id]);
    const pend = await rows(conn, `SELECT students FROM lesson_requests WHERE tenant_id = ? AND session_id = ? AND status IN ${HOLD}`, [t.id, s.id]);
    let held = 0;
    for (const r of pend) { try { held += JSON.parse(r.students).students.length; } catch (_) { held += 1; } }
    if (pend.length >= MAX_PENDING_PER_LESSON) throw conflict('This lesson has a lot of requests waiting. Please call the ski school.');
    if (s.capacity - Number(n) - held < b.students.length) throw conflict(`Only ${Math.max(s.capacity - Number(n) - held, 0)} spot(s) are left in that lesson`);
    const { total } = await one(conn, `SELECT COUNT(*) AS total FROM lesson_requests WHERE tenant_id = ? AND status IN ${HOLD}`, [t.id]);
    if (Number(total) >= MAX_PENDING_TOTAL) throw conflict('The ski school has a lot of requests waiting right now. Please call to book.');
    // Anyone under 18 is booked by an adult: the contact is the parent or guardian and must be an adult themselves.
    const minors = b.students.filter((x) => isMinor(x.date_of_birth, day));
    if (minors.length && minors.length === b.students.length && b.students.some((x) => x.first_name.toLowerCase() === b.contact_first_name.toLowerCase() && x.last_name.toLowerCase() === b.contact_last_name.toLowerCase())) {
      throw bad('The person booking must be an adult parent or guardian, not one of the students under 18');
    }
    const quote = t.pay_online ? await quoteFor(conn, t.id, s, b.students) : null;
    if (quote && quote.total <= 0) throw bad('That lesson has no price set. Please call the ski school.');
    const sha = t.waiver_text ? crypto.createHash('sha256').update(t.waiver_text).digest('hex') : null;
    for (let attempt = 0; ; attempt++) {
      const ref = reference();
      try {
        await conn.query(
          'INSERT INTO lesson_requests (tenant_id, session_id, reference, contact_name, contact_email, contact_phone, students, waiver_accepted, waiver_text_sha, note, status, amount_cents, policy_accepted) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)',
          [t.id, s.id, ref, `${b.contact_first_name} ${b.contact_last_name}`, b.contact_email, b.contact_phone,
            JSON.stringify({ contact: { first_name: b.contact_first_name, last_name: b.contact_last_name }, students: b.students, quote }), sha, b.note ?? null,
            quote ? 'awaiting_payment' : 'pending', quote ? quote.total : 0, quote ? 1 : 0],
        );
        return { ref, id: (await one(conn, 'SELECT id FROM lesson_requests WHERE tenant_id = ? AND reference = ?', [t.id, ref])).id, quote, session: s };
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY' && attempt < 4) continue;
        throw err;
      }
    }
  });
  if (out.quote) {
    // Card payment: the guest finishes on Stripe's page. The spot is held for about half an hour while they pay.
    let co;
    try {
      const pay = connect.checkoutFor(await connect.payeeOrThrow(t.id), out.quote.total, { tenant_id: String(t.id), request_id: String(out.id), reference: out.ref });
      co = await stripe.createCheckout({
        amountCents: out.quote.total, name: `${out.quote.name} (${b.students.length} student${b.students.length > 1 ? 's' : ''})`,
        description: `${t.name}: ${out.session.starts_at.slice(0, 16).replace('T', ' ')}`, email: b.contact_email, reference: out.ref, ...pay,
        successUrl: `${baseUrl(req)}/book/${req.params.slug}?paid=${out.ref}`, cancelUrl: `${baseUrl(req)}/book/${req.params.slug}?cancelled=${out.ref}`,
      });
    } catch (err) {
      await pool.query("UPDATE lesson_requests SET status = 'expired' WHERE tenant_id = ? AND id = ?", [t.id, out.id]);
      throw err;
    }
    await pool.query('UPDATE lesson_requests SET stripe_session_id = ? WHERE tenant_id = ? AND id = ?', [co.id, t.id, out.id]);
    return res.status(201).json({ ok: true, reference: out.ref, checkout_url: co.url, amount_cents: out.quote.total });
  }
  res.status(201).json({ ok: true, reference: out.ref, message: 'Request received. The ski school will confirm it, and you pay at the desk.' });
});

/** Where a request stands. The email must match, so a guessed reference shows nothing. */
async function findRequest(t, ref, email) {
  const r = await one(pool,
    `SELECT r.id, r.reference, r.status, r.contact_email, r.staff_note, r.students, r.amount_cents, r.refund_cents, r.order_id, r.payment_intent, s.starts_at, s.id AS session_id, pr.name AS product
     FROM lesson_requests r JOIN lesson_sessions s ON s.id = r.session_id AND s.tenant_id = r.tenant_id JOIN products pr ON pr.id = s.product_id AND pr.tenant_id = s.tenant_id
     WHERE r.tenant_id = ? AND r.reference = ?`, [t.id, String(ref || '').toUpperCase()]);
  if (!r || String(email || '').trim().toLowerCase() !== r.contact_email.toLowerCase()) throw notFound('Request');
  return r;
}
const shape = (r) => { let n = 1; try { n = JSON.parse(r.students).students.length; } catch (_) { /* one */ } return { reference: r.reference, status: r.status, product: r.product, starts_at: r.starts_at, students: n, staff_note: r.staff_note, amount_cents: r.amount_cents, refund_cents: r.refund_cents }; };

// The guest's email is sent in the body, not the address, so it never lands in request logs.
router.post('/:slug/requests/:ref/status', validate(z.object({ email: z.string().max(255) })), async (req, res) => {
  const t = await tenantFor(req.params.slug);
  res.set('Cache-Control', 'no-store');
  res.json(shape(await findRequest(t, req.params.ref, req.body.email)));
});

router.post('/:slug/requests/:ref/cancel', validate(z.object({ email: z.string().trim().max(255) })), async (req, res) => {
  const t = await tenantFor(req.params.slug);
  res.set('Cache-Control', 'no-store');
  const r = await findRequest(t, req.params.ref, req.body.email);
  let refundInfo = null;
  await tx(async (conn) => {
    const cur = await one(conn, 'SELECT status FROM lesson_requests WHERE tenant_id = ? AND id = ? FOR UPDATE', [t.id, r.id]);
    if (cur.status === 'awaiting_payment') {
      await conn.query("UPDATE lesson_requests SET status = 'cancelled', decided_at = NOW() WHERE tenant_id = ? AND id = ?", [t.id, r.id]);
    } else if (cur.status === 'confirmed' && r.order_id) {
      refundInfo = await cancelPaid(conn, t, r);
    } else if (cur.status === 'pending') {
      await conn.query("UPDATE lesson_requests SET status = 'cancelled', decided_at = NOW() WHERE tenant_id = ? AND id = ?", [t.id, r.id]);
    } else if (cur.status === 'confirmed') {
      // Free to cancel if nobody has paid yet and the lesson is far enough away; otherwise the school sorts it out.
      const paid = await one(conn, "SELECT COUNT(*) AS n FROM lesson_bookings WHERE tenant_id = ? AND request_id = ? AND status <> 'cancelled' AND unpaid = 0", [t.id, r.id]);
      if (Number(paid.n) > 0) throw conflict(`This lesson is already paid for. Please call the ski school${t.phone ? ` on ${t.phone}` : ''} to change it.`);
      if (r.starts_at < inHours(t.timezone, t.cancel_hours)) throw conflict(`Lessons can be canceled online up to ${t.cancel_hours} hours before they start. Please call the ski school${t.phone ? ` on ${t.phone}` : ''}.`);
      await conn.query("UPDATE lesson_bookings SET status = 'cancelled' WHERE tenant_id = ? AND request_id = ? AND status = 'booked' AND unpaid = 1", [t.id, r.id]);
      await conn.query("UPDATE lesson_requests SET status = 'cancelled', decided_at = NOW() WHERE tenant_id = ? AND id = ?", [t.id, r.id]);
    } else {
      throw conflict(`That request is already ${cur.status}`);
    }
  });
  // The refund is already written down as owed; if Stripe cannot be reached now it is retried, so the guest is not left
  // with an error after their lesson was canceled.
  if (refundInfo && refundInfo.refundId) await cardrefund.send(t.id, refundInfo.refundId);
  res.json({ ok: true, refund_cents: refundInfo ? refundInfo.cents : 0, refund_percent: refundInfo ? refundInfo.percent : 0 });
});

/** Cancels a paid online request under the mountain's tiers and records the refund in the books. The Stripe refund is sent after the commit. */
async function cancelPaid(conn, t, r) {
  const order = await one(conn, 'SELECT id, total_cents, tax_cents, refunded_cents FROM orders WHERE tenant_id = ? AND id = ? FOR UPDATE', [t.id, r.order_id]);
  const nowLocal = nowIn(t.timezone);
  const hours = hoursUntil(r.starts_at, nowLocal);
  if (hours <= 0) throw conflict(`This lesson has already started. Please call the ski school${t.phone ? ` on ${t.phone}` : ''}.`);
  const percent = refundPercent(t, hours);
  const cents = Math.floor(((order.total_cents - order.refunded_cents) * percent) / 100);
  await conn.query("UPDATE lesson_bookings SET status = 'cancelled' WHERE tenant_id = ? AND request_id = ? AND status = 'booked'", [t.id, r.id]);
  let refundId = null;
  if (cents > 0) {
    const tax = Math.round((order.tax_cents * cents) / order.total_cents);
    const [rf] = await conn.query("INSERT INTO order_refunds (tenant_id, order_id, user_id, reason, note, amount_cents, tax_cents, method) VALUES (?, ?, NULL, 'customer_request', ?, ?, ?, 'card')",
      [t.id, order.id, `Online cancellation: ${percent}% refund`, cents, tax]);
    refundId = rf.insertId;
    if (r.payment_intent) await cardrefund.markPending(conn, t.id, refundId, r.payment_intent);
    const whole = order.refunded_cents + cents >= order.total_cents;
    await conn.query('UPDATE orders SET refunded_cents = refunded_cents + ?, status = IF(?, \'refunded\', status) WHERE tenant_id = ? AND id = ?', [cents, whole ? 1 : 0, t.id, order.id]);
    if (whole) await conn.query('UPDATE order_items SET refunded_at = NOW(), refund_id = ? WHERE tenant_id = ? AND order_id = ? AND refunded_at IS NULL', [refundId, t.id, order.id]);
  }
  await conn.query("UPDATE lesson_requests SET status = 'cancelled', decided_at = NOW(), refund_cents = ? WHERE tenant_id = ? AND id = ?", [cents, t.id, r.id]);
  await audit(conn, { auth: { tenantId: t.id, userId: null } }, 'online_cancel', 'lesson_requests', r.id, { percent, refund_cents: cents });
  return { cents, percent, refundId };
}


/**
 * Stripe tells us a payment finished or a checkout lapsed. Paid: confirm the request and record the sale. If the lesson
 * filled up while the guest was paying, the whole payment is refunded.
 */
/** A completed gift. The session id is unique, so a repeated webhook cannot count a gift twice. */
async function recordDonation(event, obj) {
  if (event.type !== 'checkout.session.completed' || obj.payment_status !== 'paid') return { ignored: true };
  const m = obj.metadata;
  const details = obj.customer_details || {};
  const [r] = await pool.query(
    'INSERT IGNORE INTO donations (tenant_id, amount_cents, monthly, email, name, followup_id, stripe_session_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [Number(m.tenant_id), Number(obj.amount_total), obj.mode === 'subscription' ? 1 : 0, (details.email || obj.customer_email || '').slice(0, 255) || null, (details.name || '').slice(0, 150) || null, m.followup_id ? Number(m.followup_id) : null, obj.id],
  );
  return { donation: r.affectedRows === 1 };
}

async function handleWebhook(event, base) {
  const obj = event && event.data && event.data.object;
  if (obj && obj.metadata && obj.metadata.kind === 'shop_change') return shopafter.handleChangeWebhook(event, obj);
  if (obj && obj.metadata && obj.metadata.kind === 'shop') return shopsale.handleWebhook(event, obj, base || config.stripe.publicUrl || '');
  if (obj && obj.metadata && obj.metadata.kind === 'program') return require('./programreg').handleWebhook(event, obj, base || config.stripe.publicUrl || '');
  if (obj && obj.metadata && obj.metadata.kind === 'donation') return recordDonation(event, obj);
  if (!obj || !obj.metadata || !obj.metadata.request_id) return { ignored: true };
  const tenantId = Number(obj.metadata.tenant_id);
  const requestId = Number(obj.metadata.request_id);
  if (event.type === 'checkout.session.expired') {
    await pool.query("UPDATE lesson_requests SET status = 'expired' WHERE tenant_id = ? AND id = ? AND status = 'awaiting_payment' AND stripe_session_id = ?", [tenantId, requestId, obj.id]);
    return { expired: true };
  }
  if (event.type !== 'checkout.session.completed' || obj.payment_status !== 'paid') return { ignored: true };
  let failed = null;
  let result;
  try {
    result = await tx(async (conn) => {
      const raw = await one(conn, 'SELECT * FROM lesson_requests WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, requestId]);
      if (!raw || raw.stripe_session_id !== obj.id) return { ignored: true };
      // Only a request still waiting for this payment is acted on. A repeat of an event we already handled, including one we
      // refunded, changes nothing.
      if (raw.status !== 'awaiting_payment') return { duplicate: true };
      const q = parseRequest(raw).quote;
      if (!q || Number(obj.amount_total) !== raw.amount_cents) { failed = 'amount'; return { problem: true }; }
      try {
        return await confirmRequest(conn, tenantId, raw, { paid: true, paymentIntent: obj.payment_intent });
      } catch (err) {
        if (err.status && err.status < 500) throw new Unhonourable(err.message);
        throw err;
      }
    });
  } catch (err) {
    if (!(err instanceof Unhonourable)) throw err;
    failed = err.message; result = { problem: true }; // rolled back: nothing half-made is kept
  }
  if (failed) {
    // We could not honor it (lesson full or canceled, or the amount was wrong): give the money back in full. The refund
    // goes first; if Stripe cannot be reached this throws, Stripe sends the event again, and we try again.
    if (obj.payment_intent && stripe.enabled()) await stripe.refund({ paymentIntent: obj.payment_intent, amountCents: Number(obj.amount_total), key: `autorefund-${tenantId}-${requestId}`, account: event.account || null });
    await pool.query("UPDATE lesson_requests SET status = 'expired', payment_intent = ?, refund_cents = amount_cents, staff_note = ? WHERE tenant_id = ? AND id = ? AND status = 'awaiting_payment'", [obj.payment_intent, `Refunded automatically: ${failed}`.slice(0, 300), tenantId, requestId]);
  }
  return result;
}

module.exports = router;
module.exports.handleWebhook = handleWebhook;
