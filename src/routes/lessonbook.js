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
const { logFailure } = require('../lib/jobs');
const L = require('../lib/levels');
const F = require('../lib/lessonfamily');
const B = require('../lib/lessonbasket');
const S = require('../lib/schoolsettings');
const P = require('../lib/placement');
const { textsOn } = require('../lib/familynotify');

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

/**
 * The open lessons for the booking page, shaped for guests (no private data): each with its spots left after bookings,
 * requests waiting and waitlist offers. A pool (kind 'pool') is a time guests book; the lineup splits it into classes by
 * level, so it fits every level unless the plan set a range. extraWhere and params narrow the list.
 */
async function guestLessons(t, extraWhere = '', params = []) {
  const today = todayIn(t.timezone);
  const earliest = inHours(t.timezone, t.booking_notice_hours);
  const sessions = await rows(pool,
    `SELECT s.id, s.starts_at, s.ends_at, s.discipline, s.ability_level, s.format, s.age_group, s.meeting_place, s.capacity, s.level_min, s.level_max, s.age_min, s.age_max, s.kind, pr.id AS product_id, pr.name AS product, pr.base_price_cents,
       (SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status IN ('booked','attended')) AS booked
     FROM lesson_sessions s JOIN products pr ON pr.id = s.product_id AND pr.tenant_id = s.tenant_id
     WHERE s.tenant_id = ? AND s.status = 'scheduled' AND pr.active = 1 AND s.starts_at >= ? AND DATE(s.starts_at) <= ?${extraWhere} ORDER BY s.starts_at LIMIT 300`,
    [t.id, earliest, addDays(today, 45), ...params]);
  // Spots held: requests waiting to be confirmed or paid, and waitlist offers not yet claimed.
  const held = await F.heldSpots(pool, t.id);
  const tiers = await rows(pool, 'SELECT product_id, tier, price_cents FROM price_tiers WHERE tenant_id = ?', [t.id]);
  const extras = await F.productExtras(pool, t.id);
  return sessions.map((s) => ({
    id: s.id, starts_at: s.starts_at, ends_at: s.ends_at, product: s.product, product_id: s.product_id, discipline: s.discipline, ability_level: s.ability_level, format: s.format, age_group: s.age_group, meeting_place: s.meeting_place,
    pool: s.kind === 'pool', // 2026.11.9 (Track GUEST): a pool is booked as a time; the lineup places each student in a class
    level_min: s.level_min, level_max: s.level_max, level_words: L.range(s.level_min, s.level_max), age_min: s.age_min, age_max: s.age_max, ages: F.agesWords(s.age_min, s.age_max),
    offers_ticket: Boolean((extras.get(Number(s.product_id)) || {}).ticket_product_id), offers_rental: Boolean((extras.get(Number(s.product_id)) || {}).rental_product_id),
    price_cents: s.base_price_cents, prices: tiers.filter((x) => x.product_id === s.product_id).map((x) => ({ tier: x.tier, price_cents: x.price_cents })),
    spots_left: Math.max(s.capacity - Number(s.booked) - (held.get(Number(s.id)) || 0), 0),
  }));
}

router.get('/:slug/booking', async (req, res) => {
  const t = await tenantFor(req.params.slug);
  const set = await S.get(pool, t.id);
  const all = await guestLessons(t);
  res.set('Cache-Control', 'no-store');
  res.json({
    // Family booking (2026.11.5): the waitlist for full lessons, the consents asked, the guest assistant only when it is on.
    full: all.filter((s) => s.spots_left <= 0 && s.format === 'group').map((s) => ({ ...s, waitlist: true })),
    texts_available: await textsOn(t.id), photos_asked: Boolean(set.recap_photos), assistant: await assistantOn(t.id),
    guest_types: (await require('../lib/guesttypes').list(pool, t.id, { visibleOnly: true })).map((g) => ({ code: g.code, name: g.name })),
    mountain: t.name, phone: t.phone, message: t.booking_message, notice_hours: t.booking_notice_hours, cancel_hours: t.cancel_hours, waiver_text: t.waiver_text, pay_online: t.pay_online, policy: policyText(t), policy_tiers: policyTiers(t), policy_notes: policyNotes(t),
    placement: P.publicShape(P.questionsFrom(set)), // 2026.11.9: three questions per discipline that place a student on the level scale
    lessons: all.filter((s) => s.spots_left > 0),
  });
});

/**
 * A full lesson the guest wanted (2026.11.9, Track GUEST): the next times with room for the same lesson product and age
 * band, the same day first and then the next 7 days, and whether the full one has a waitlist. Each look at a full lesson is
 * noted for the director's demand view (lib/lessondemand.js, Track STAFF).
 */
router.get('/:slug/booking/next/:id', async (req, res) => {
  const t = await tenantFor(req.params.slug);
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw notFound('Lesson');
  const s = await one(pool, "SELECT id, product_id, format, age_min, age_max, starts_at, capacity FROM lesson_sessions WHERE tenant_id = ? AND id = ? AND status = 'scheduled'", [t.id, id]);
  if (!s) throw notFound('Lesson');
  const day = String(s.starts_at).slice(0, 10);
  const list = await guestLessons(t, ' AND s.product_id = ? AND s.age_min <=> ? AND s.age_max <=> ? AND DATE(s.starts_at) BETWEEN ? AND ?', [s.product_id, s.age_min, s.age_max, day, addDays(day, 7)]);
  const me = list.find((x) => x.id === id);
  const full = me ? me.spots_left <= 0 : true;
  if (full) await noteFull(t.id, id);
  const next = list.filter((x) => x.id !== id && x.spots_left > 0)
    .sort((a, b) => (String(a.starts_at).slice(0, 10) === day ? 0 : 1) - (String(b.starts_at).slice(0, 10) === day ? 0 : 1) || String(a.starts_at).localeCompare(String(b.starts_at)))
    .slice(0, 6);
  res.set('Cache-Control', 'no-store');
  res.json({ session_id: id, full, waitlist: full && s.format === 'group', next });
});

/** Tells the demand view a guest found this lesson full. Track STAFF provides lessondemand.noteFull; until then nothing. Never throws. */
async function noteFull(tenantId, sessionId) {
  try {
    const D = require('../lib/lessondemand');
    if (D && typeof D.noteFull === 'function') await D.noteFull(pool, tenantId, sessionId);
  } catch (_) { /* the demand note is a nice-to-have; the guest still sees the next times */ }
}

/** Is the guest assistant on for the booking page? (Assistant Plus and the page chosen.) The page only loads it then. */
async function assistantOn(tenantId) {
  try {
    if (!config.assistant.on || !(await require('../lib/modules').enabledKeys(tenantId)).includes('assistant_plus')) return false;
    return (await require('../lib/assistant').settingsOf(pool, tenantId)).guest_pages.includes('booking');
  } catch (_) { return false; }
}

// ---------------------------------------------------------------- the family basket (2026.11.5)
/** Prices a family basket without saving it: each lesson by the student's age, and the tickets and rentals asked for. */
router.post('/:slug/lesson-basket/quote', validate(z.object({ items: z.array(z.object({ session_id: z.number().int().positive(), student: z.object({ date_of_birth: dateStr }), ticket: z.boolean().optional(), rental: z.boolean().optional() })).min(1).max(B.MAX_ITEMS) })), async (req, res) => {
  const t = await tenantFor(req.params.slug);
  const extrasOf = await F.productExtras(pool, t.id);
  const lines = []; let lessons = 0; let tax = 0; const extraLines = [];
  for (const it of req.body.items) {
    const s = await one(pool, "SELECT id, starts_at, product_id FROM lesson_sessions WHERE tenant_id = ? AND id = ? AND status = 'scheduled'", [t.id, it.session_id]);
    if (!s) throw notFound('Lesson');
    const q = await quoteFor(pool, t.id, s, [it.student]);
    lessons += q.subtotal; tax += q.tax;
    lines.push({ kind: 'lesson', session_id: s.id, price_cents: q.subtotal });
    const x = extrasOf.get(Number(s.product_id)) || {}; const day = String(s.starts_at).slice(0, 10);
    if (it.ticket && x.ticket_product_id) extraLines.push(await F.extraLine(pool, t.id, 'ticket', x.ticket_product_id, it.student, day, String(s.id)));
    if (it.rental && x.rental_product_id) extraLines.push(await F.extraLine(pool, t.id, 'rental', x.rental_product_id, it.student, day, String(s.id)));
  }
  const ex = await F.priceExtras(pool, t.id, extraLines);
  for (const l of ex.lines) lines.push({ kind: l.kind, session_id: Number(l.key), name: l.name, price_cents: l.unit });
  res.set('Cache-Control', 'no-store');
  const subtotal = lessons + ex.subtotal; const allTax = tax + ex.tax;
  res.json({ subtotal_cents: subtotal, tax_cents: allTax, total_cents: subtotal + allTax, lines, extras_paid_at_desk: !t.pay_online });
});

router.post('/:slug/lesson-basket', validate(B.basketSchema), async (req, res) => {
  const t = await tenantFor(req.params.slug);
  res.set('Cache-Control', 'no-store');
  if (req.body.website) return res.status(202).json({ ok: true });
  const out = await B.create(t, req.body, { base: baseUrl(req), slug: req.params.slug });
  res.status(201).json({ ok: true, ...out });
});

router.post('/:slug/lesson-basket/:ref/status', validate(z.object({ email: z.string().max(255) })), async (req, res) => {
  const t = await tenantFor(req.params.slug);
  res.set('Cache-Control', 'no-store');
  res.json(await B.status(pool, t.id, req.params.ref, req.body.email));
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
    held += Number((await one(conn, "SELECT COUNT(*) AS n FROM lesson_waitlist WHERE tenant_id = ? AND session_id = ? AND status = 'offered' AND offer_expires_at > UTC_TIMESTAMP()", [t.id, s.id])).n); // a waitlist offer holds its spot
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
        description: `${t.name}: ${out.session.starts_at.slice(0, 16).replace('T', ' ')}`, email: b.contact_email, reference: out.ref, ...pay, idempotencyKey: `lesson-${out.id}`,
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
  let refundInfo = null; let openPage = null;
  await tx(async (conn) => {
    const cur = await one(conn, 'SELECT status, stripe_session_id FROM lesson_requests WHERE tenant_id = ? AND id = ? FOR UPDATE', [t.id, r.id]);
    if (cur.status === 'awaiting_payment') {
      await conn.query("UPDATE lesson_requests SET status = 'cancelled', decided_at = NOW() WHERE tenant_id = ? AND id = ?", [t.id, r.id]);
      openPage = cur.stripe_session_id;
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
  // Still on Stripe's page (another tab, or the two happened together): close the page so it cannot take the money now.
  // If the payment got there first, it is given back in full here, or by the webhook when it arrives, whichever is first.
  const late = openPage ? await closePage(t.id, r.id, openPage) : null;
  res.json({ ok: true, refund_cents: late ? late.cents : refundInfo ? refundInfo.cents : 0, refund_percent: late ? 100 : refundInfo ? refundInfo.percent : 0,
    ...(late ? { message: 'Your payment went through just as you canceled, so all of it is going back to your card.' } : {}) });
});

/**
 * Expires the Stripe page of a request the guest just canceled. When Stripe says the page was already paid, the payment is
 * refunded in full now. Returns { cents } when it was, else null.
 */
async function closePage(tenantId, requestId, sessionId) {
  const acct = (await one(pool, 'SELECT stripe_account FROM tenants WHERE id = ?', [tenantId])).stripe_account || null;
  const how = await stripe.expireCheckout(sessionId, { account: acct });
  if (how !== 'closed') return null;
  let s = null;
  try { s = await stripe.get(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, { account: acct }); } catch (_) { return null; } // the webhook still refunds it
  if (!s || s.status !== 'complete' || s.payment_status !== 'paid' || !s.payment_intent) return null;
  const out = await giveBack(tenantId, requestId, { ...s, id: sessionId }, acct, 'the request was canceled before the payment arrived');
  return out.refunded ? { cents: Number(s.amount_total) } : null;
}

/**
 * A paid page for a request we cannot book (canceled or expired while the guest was paying, or already paid another way):
 * the whole payment is written down as owed back, then sent to Stripe. A request with no payment of its own is noted
 * (Refunded automatically) in the same step. A repeat changes nothing.
 */
async function giveBack(tenantId, requestId, obj, account, why) {
  const owed = await tx(async (conn) => {
    const raw = await one(conn, 'SELECT id, status, payment_intent FROM lesson_requests WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, requestId]);
    if (!raw || raw.status === 'awaiting_payment' || raw.payment_intent === String(obj.payment_intent)) return null;
    const id = await cardrefund.oweReturn(conn, { tenantId, kind: 'lesson', rowId: requestId, session: obj.id, paymentIntent: obj.payment_intent, amountCents: Number(obj.amount_total), account, reason: why });
    if (!id) return null;
    if (!raw.payment_intent) {
      await conn.query('UPDATE lesson_requests SET payment_intent = ?, refund_cents = ?, staff_note = ? WHERE tenant_id = ? AND id = ?',
        [String(obj.payment_intent), Number(obj.amount_total), `Refunded automatically: ${why}`.slice(0, 300), tenantId, requestId]);
    }
    return id;
  });
  if (!owed) return { duplicate: true };
  await cardrefund.sendReturn(owed);
  return { refunded: true };
}

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
    'INSERT IGNORE INTO donations (tenant_id, amount_cents, monthly, email, name, followup_id, stripe_session_id, stripe_account) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [Number(m.tenant_id), Number(obj.amount_total), obj.mode === 'subscription' ? 1 : 0, (details.email || obj.customer_email || '').slice(0, 255) || null, (details.name || '').slice(0, 150) || null, m.followup_id ? Number(m.followup_id) : null, obj.id, event.account || null],
  );
  return { donation: r.affectedRows === 1 };
}

async function handleWebhook(event, base) {
  const obj = event && event.data && event.data.object;
  // A card reader payment at the counter (routes/terminal.js).
  if (obj && obj.metadata && obj.metadata.kind === 'counter' && String(event.type || '').startsWith('payment_intent.')) return require('./terminal').handleWebhook(event, obj);
  if (obj && obj.metadata && obj.metadata.kind === 'shop_change') return shopafter.handleChangeWebhook(event, obj, base || config.stripe.publicUrl || '');
  if (obj && obj.metadata && obj.metadata.kind === 'shop') return shopsale.handleWebhook(event, obj, base || config.stripe.publicUrl || '');
  if (obj && obj.metadata && obj.metadata.kind === 'program') return require('./programreg').handleWebhook(event, obj, base || config.stripe.publicUrl || '');
  if (obj && obj.metadata && obj.metadata.kind === 'donation') return recordDonation(event, obj);
  if (obj && obj.metadata && ['lesson_basket', 'lesson_tip'].includes(obj.metadata.kind)) return F.handleWebhook(event, obj); // a family basket or a tip

  if (obj && obj.metadata && obj.metadata.kind === 'private') return require('./schoolpay').handleWebhook(event, obj); // Track PAY: privates asked for by name
  if (!obj || !obj.metadata || !obj.metadata.request_id) return { ignored: true };
  const tenantId = Number(obj.metadata.tenant_id);
  const requestId = Number(obj.metadata.request_id);
  if (event.type === 'checkout.session.expired') {
    // (A request whose page was never saved, because that save failed, is matched too.)
    await pool.query("UPDATE lesson_requests SET status = 'expired' WHERE tenant_id = ? AND id = ? AND status = 'awaiting_payment' AND (stripe_session_id = ? OR stripe_session_id IS NULL)", [tenantId, requestId, obj.id]);
    return { expired: true };
  }
  if (event.type !== 'checkout.session.completed' || obj.payment_status !== 'paid') return { ignored: true };
  let failed = null; let gone = null; let stray = null;
  let result;
  try {
    result = await tx(async (conn) => {
      failed = null; gone = null; stray = null;
      const raw = await one(conn, 'SELECT * FROM lesson_requests WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, requestId]);
      if (!raw) { logFailure({ job: 'stripe_webhook', tenant: tenantId, message: `a paid card page names lesson request ${requestId}, which is not on file` }); return { ignored: true }; }
      // A repeat of an event we already handled, booked or refunded, changes nothing.
      if (raw.payment_intent === String(obj.payment_intent) || await cardrefund.returned(conn, tenantId, obj.payment_intent)) return { duplicate: true };
      // Only a request still waiting for this payment is booked. One canceled, expired or paid another way while the guest
      // was still paying is refunded in full.
      if (raw.status !== 'awaiting_payment') {
        gone = ['cancelled', 'expired', 'declined'].includes(raw.status) ? `the request was ${raw.status === 'cancelled' ? 'canceled' : raw.status} before the payment arrived` : 'the request was already paid';
        return { problem: true };
      }
      // Waiting on another card page: this one is not what it is waiting for, so it goes back. With no page saved (that
      // save failed after Stripe made the page), the payment is accepted when the amount is right.
      const lost = !raw.stripe_session_id;
      if (!lost && raw.stripe_session_id !== obj.id) { stray = 'it was not the card page saved for this request'; return { problem: true }; }
      const q = parseRequest(raw).quote;
      if (!q || Number(obj.amount_total) !== raw.amount_cents) { failed = 'amount'; return { problem: true }; }
      if (lost) await conn.query('UPDATE lesson_requests SET stripe_session_id = ? WHERE tenant_id = ? AND id = ?', [obj.id, tenantId, raw.id]);
      try {
        return await confirmRequest(conn, tenantId, raw, { paid: true, paymentIntent: obj.payment_intent, payee: connect.paidTo(event) });
      } catch (err) {
        if (err.status && err.status < 500) throw new Unhonourable(err.message);
        throw err;
      }
    });
  } catch (err) {
    if (!(err instanceof Unhonourable)) throw err;
    failed = err.message; result = { problem: true }; // rolled back: nothing half-made is kept
  }
  if (gone) return giveBack(tenantId, requestId, obj, event.account || null, gone);
  if (stray) return cardrefund.returnStray({ tenantId, kind: 'lesson', rowId: requestId, obj, account: event.account || null, why: stray });
  if (failed) {
    // We could not honor it (lesson full or canceled, or the amount was wrong): give the money back in full. It is written
    // down as owed with the request's new state in one step, then sent; the daily job retries it if Stripe is slow.
    const owed = await tx(async (conn) => {
      const [u] = await conn.query("UPDATE lesson_requests SET status = 'expired', payment_intent = ?, refund_cents = ?, staff_note = ? WHERE tenant_id = ? AND id = ? AND status = 'awaiting_payment'",
        [obj.payment_intent || null, Number(obj.amount_total) || 0, `Refunded automatically: ${failed}`.slice(0, 300), tenantId, requestId]);
      if (u.affectedRows !== 1) return null;
      return cardrefund.oweReturn(conn, { tenantId, kind: 'lesson', rowId: requestId, session: obj.id, paymentIntent: obj.payment_intent, amountCents: Number(obj.amount_total), account: event.account || null, reason: failed });
    });
    if (owed) await cardrefund.sendReturn(owed);
  }
  // The family's confirmation for each booking, after the commit (lessonconfirm, Track CORE).
  if (result && result.booked) for (const bk of result.booked) await require('../lib/lessonconfirm').sendConfirmation(pool, tenantId, bk.booking_id, base || config.stripe.publicUrl || '').catch(() => {});
  return result;
}

module.exports = router;
module.exports.handleWebhook = handleWebhook;
