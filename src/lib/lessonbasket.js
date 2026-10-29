'use strict';
// A family booking online (Track PARENTS): several students, each with their own lesson, and for each a lift ticket and a
// rental when the lesson offers them. One lesson request per lesson (so staff, the counter and the cancellation rules
// see each as they always have), tied together by a basket that holds the one card payment. With card payment off, the
// requests wait for staff as before and tickets and rentals are noted for the desk.
const crypto = require('crypto');
const { tx, one } = require('../db');
const { z, dateStr, nowIn } = require('./util');
const { conflict, bad, notFound } = require('./errors');
const { isMinor } = require('./family');
const { quoteFor } = require('./onlinesale');
const { ageOn } = require('./guesttypes');
const L = require('./levels');
const F = require('./lessonfamily');
const { spotsLeft } = require('./lessonrules');
const stripe = require('./stripe');
const connect = require('./connect');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const reference = () => Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');
const MAX_ITEMS = 8;
const MAX_PENDING_TOTAL = 80;

const opt = (n) => z.string().trim().max(n).optional().transform((v) => (v ? v : undefined));
const studentSchema = z.object({
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  date_of_birth: dateStr,
  sex: z.enum(['female', 'male', 'other']),
  discipline: z.enum(['ski', 'snowboard', 'telemark', 'adaptive']).optional(),
  level: z.number().int().min(1).max(9).optional(),
  height_in: z.number().int().min(20).max(96).optional(),
  weight_lb: z.number().int().min(20).max(500).optional(),
  boot_size: opt(10),
  allergies: opt(300), medical: opt(500), pickup: opt(300),
  text_ok: z.boolean().optional(), photo_ok: z.boolean().optional(),
});
const basketSchema = z.object({
  contact_first_name: z.string().trim().min(1).max(100),
  contact_last_name: z.string().trim().min(1).max(100),
  contact_email: z.string().trim().email().max(255),
  contact_phone: z.string().trim().min(7).max(40),
  items: z.array(z.object({ session_id: z.number().int().positive(), student: studentSchema, ticket: z.boolean().optional(), rental: z.boolean().optional() })).min(1).max(MAX_ITEMS),
  waiver_accepted: z.boolean(),
  policy_accepted: z.boolean().optional(),
  note: z.string().trim().max(500).optional(),
  website: z.string().max(200).optional(),
});

const keyOf = (st) => `${st.first_name.trim().toLowerCase()}|${st.last_name.trim().toLowerCase()}|${st.date_of_birth}`;

/**
 * Prices and saves a family basket. t: the tenant row from the booking page (pay_online, notice hours, waiver text).
 * waitlistId: the waitlist offer this claims (its held spot counts for this family). Returns { basket, reference,
 * checkout_url?, amount_cents, requests: [{ id, reference }] }.
 */
async function create(t, b, { base, slug, waitlistId = null } = {}) {
  if (!b.waiver_accepted) throw bad('Please read and accept the waiver to book');
  if (t.pay_online && !b.policy_accepted) throw bad('Please read and accept the cancellation policy');
  const earliest = F.plusMinutes(nowIn(t.timezone), Number(t.booking_notice_hours || 0) * 60);
  const out = await tx(async (conn) => {
    const ids = [...new Set(b.items.map((i) => i.session_id))].sort((x, y) => x - y);
    const sessions = new Map();
    for (const id of ids) {
      const s = await one(conn, "SELECT * FROM lesson_sessions WHERE tenant_id = ? AND id = ? AND status = 'scheduled' FOR UPDATE", [t.id, id]);
      if (!s) throw notFound('Lesson');
      if (s.starts_at < earliest) throw conflict(`Online booking closes ${t.booking_notice_hours} hours before the lesson. Please call the ski school.`);
      sessions.set(id, s);
    }
    // A waitlist claim: the offer is locked and must still be open; it is marked claimed in this same transaction, so a
    // second tap (or a second tab) finds it claimed. Only then does its held spot count for this family.
    if (waitlistId) {
      const w = await one(conn, 'SELECT id, session_id, status, (offer_expires_at > UTC_TIMESTAMP()) AS live FROM lesson_waitlist WHERE tenant_id = ? AND id = ? FOR UPDATE', [t.id, waitlistId]);
      if (!w || w.status !== 'offered' || !Number(w.live)) throw conflict(w && w.status === 'claimed' ? 'This spot is already claimed.' : 'This offer has run out. The spot went to the next family on the waitlist.');
      if (!sessions.has(Number(w.session_id)) || b.items.some((it) => Number(it.session_id) !== Number(w.session_id))) throw conflict('This offer is for one lesson only.');
      await conn.query("UPDATE lesson_waitlist SET status = 'claimed' WHERE tenant_id = ? AND id = ?", [t.id, waitlistId]);
    }
    const { total } = await one(conn, "SELECT COUNT(*) AS total FROM lesson_requests WHERE tenant_id = ? AND status IN ('pending','awaiting_payment')", [t.id]);
    if (Number(total) >= MAX_PENDING_TOTAL) throw conflict('The ski school has a lot of bookings waiting right now. Please call to book.');
    // Every student fits their lesson, nobody is in two lessons at once, and each lesson has room.
    const want = new Map();
    for (const it of b.items) {
      const s = sessions.get(it.session_id); const st = it.student;
      const age = ageOn(st.date_of_birth, String(s.starts_at).slice(0, 10));
      if (!F.fits(s, { age })) throw conflict(`${st.first_name} is ${age}, and that lesson is for ${F.agesWords(s.age_min, s.age_max).toLowerCase()}. Pick another lesson.`);
      want.set(s.id, (want.get(s.id) || 0) + 1);
    }
    for (const [i, a] of b.items.entries()) {
      for (const c of b.items.slice(i + 1)) {
        if (keyOf(a.student) !== keyOf(c.student)) continue;
        const x = sessions.get(a.session_id); const y = sessions.get(c.session_id);
        if (x.id === y.id || (x.starts_at < y.ends_at && x.ends_at > y.starts_at)) throw conflict(`${a.student.first_name} is in two lessons at the same time. Pick one.`);
      }
    }
    for (const [id, n] of want) {
      const s = sessions.get(id);
      const { left } = await spotsLeft(conn, t.id, s, { exceptWaitlistId: waitlistId || 0 });
      if (left < n) throw conflict(left > 0 ? `Only ${left} spot${left === 1 ? '' : 's'} left in the ${String(s.starts_at).slice(11, 16)} lesson` : 'That lesson just filled up. You can join its waitlist.');
    }
    // An adult books for anyone under 18.
    const firstDay = String(sessions.get(b.items[0].session_id).starts_at).slice(0, 10);
    if (b.items.every((it) => isMinor(it.student.date_of_birth, firstDay)) && b.items.some((it) => it.student.first_name.toLowerCase() === b.contact_first_name.toLowerCase() && it.student.last_name.toLowerCase() === b.contact_last_name.toLowerCase())) {
      throw bad('The person booking must be an adult parent or guardian, not one of the students under 18');
    }
    // Lift tickets and rentals the lessons offer.
    const extrasOf = await F.productExtras(conn, t.id);
    const extraLines = []; const wishes = [];
    for (const it of b.items) {
      const s = sessions.get(it.session_id); const x = extrasOf.get(Number(s.product_id)) || {};
      const day = String(s.starts_at).slice(0, 10);
      if (it.ticket) { if (!x.ticket_product_id) throw conflict('That lesson does not offer a lift ticket online'); if (t.pay_online) extraLines.push(await F.extraLine(conn, t.id, 'ticket', x.ticket_product_id, it.student, day, keyOf(it.student))); else wishes.push(`${it.student.first_name}: lift ticket`); }
      if (it.rental) { if (!x.rental_product_id) throw conflict('That lesson does not offer a rental online'); if (t.pay_online) extraLines.push(await F.extraLine(conn, t.id, 'rental', x.rental_product_id, it.student, day, keyOf(it.student))); else wishes.push(`${it.student.first_name}: rental`); }
    }
    const extras = await F.priceExtras(conn, t.id, extraLines);
    // One request per lesson.
    const groups = [];
    for (const id of ids) {
      const students = b.items.filter((it) => it.session_id === id).map((it) => ({ ...it.student, discipline: it.student.discipline || sessions.get(id).discipline, key: keyOf(it.student), ...(it.student.level ? { ability_level: L.toLegacy(it.student.level) } : {}) }));
      const quote = t.pay_online ? await quoteFor(conn, t.id, sessions.get(id), students) : null;
      if (quote && quote.total <= 0) throw bad('That lesson has no price set. Please call the ski school.');
      groups.push({ session: sessions.get(id), students, quote });
    }
    const amount = groups.reduce((n, g) => n + (g.quote ? g.quote.total : 0), 0) + extras.total;
    const sha = t.waiver_text ? crypto.createHash('sha256').update(t.waiver_text).digest('hex') : null;
    const insertRef = async (sql, params) => {
      for (let attempt = 0; ; attempt++) {
        const ref = reference();
        try { const [r] = await conn.query(sql, [...params(ref)]); return { id: r.insertId, ref }; } catch (err) { if (err.code === 'ER_DUP_ENTRY' && attempt < 4) continue; throw err; }
      }
    };
    const basket = await insertRef('INSERT INTO lesson_baskets (tenant_id, reference, contact_email, status, amount_cents, extras) VALUES (?, ?, ?, ?, ?, ?)',
      (ref) => [t.id, ref, b.contact_email, t.pay_online ? 'awaiting_payment' : 'pending', amount, JSON.stringify({ ...extras, contact: { first_name: b.contact_first_name, last_name: b.contact_last_name, phone: b.contact_phone } })]);
    const made = [];
    for (const g of groups) {
      const mine = wishes.filter((w) => g.students.some((s) => w.startsWith(`${s.first_name}:`)));
      const note = [b.note, mine.length ? `Wants at the desk: ${mine.join(', ')}.` : ''].filter(Boolean).join(' ').slice(0, 500) || null;
      const r = await insertRef('INSERT INTO lesson_requests (tenant_id, session_id, reference, contact_name, contact_email, contact_phone, students, waiver_accepted, waiver_text_sha, note, status, amount_cents, policy_accepted, basket_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)',
        (ref) => [t.id, g.session.id, ref, `${b.contact_first_name} ${b.contact_last_name}`, b.contact_email, b.contact_phone,
          JSON.stringify({ contact: { first_name: b.contact_first_name, last_name: b.contact_last_name }, students: g.students, quote: g.quote }), sha, note,
          g.quote ? 'awaiting_payment' : 'pending', g.quote ? g.quote.total : 0, g.quote ? 1 : 0, basket.id]);
      made.push({ id: r.id, reference: r.ref, session_id: g.session.id });
    }
    if (waitlistId) await conn.query("UPDATE lesson_waitlist SET status = 'claimed', request_id = ? WHERE tenant_id = ? AND id = ?", [made[0].id, t.id, waitlistId]);
    return { basket, made, amount, count: b.items.length };
  });
  if (t.pay_online) {
    let co;
    try {
      const pay = connect.checkoutFor(await connect.payeeOrThrow(t.id), out.amount, { tenant_id: String(t.id), basket_id: String(out.basket.id), reference: out.basket.ref, kind: 'lesson_basket' });
      co = await stripe.createCheckout({
        amountCents: out.amount, name: `Ski lessons (${out.count} ${out.count === 1 ? 'student' : 'students'})`, description: t.name, email: b.contact_email, reference: out.basket.ref, ...pay,
        idempotencyKey: `lesson_basket-${out.basket.id}`,
        successUrl: `${base}/book/${encodeURIComponent(slug)}?basket=${out.basket.ref}`, cancelUrl: `${base}/book/${encodeURIComponent(slug)}?cancelled=${out.basket.ref}`,
      });
    } catch (err) {
      await tx(async (conn) => {
        await conn.query("UPDATE lesson_baskets SET status = 'expired' WHERE tenant_id = ? AND id = ?", [t.id, out.basket.id]);
        await conn.query("UPDATE lesson_requests SET status = 'expired' WHERE tenant_id = ? AND basket_id = ?", [t.id, out.basket.id]);
        if (waitlistId) await conn.query("UPDATE lesson_waitlist SET status = 'offered' WHERE tenant_id = ? AND id = ?", [t.id, waitlistId]);
      });
      throw err;
    }
    await tx(async (conn) => {
      await conn.query('UPDATE lesson_baskets SET stripe_session_id = ? WHERE tenant_id = ? AND id = ?', [co.id, t.id, out.basket.id]);
      await conn.query('UPDATE lesson_requests SET stripe_session_id = ? WHERE tenant_id = ? AND basket_id = ?', [co.id, t.id, out.basket.id]);
    });
    return { reference: out.basket.ref, checkout_url: co.url, amount_cents: out.amount, requests: out.made };
  }
  return { reference: out.basket.ref, amount_cents: 0, requests: out.made, message: 'Request received. The ski school will confirm it, and you pay at the desk.' };
}

/** Where a basket stands, for the family coming back from the payment page. The email must match. */
async function status(db, tenantId, ref, email) {
  const r = await one(db, 'SELECT id, reference, status, contact_email, amount_cents FROM lesson_baskets WHERE tenant_id = ? AND reference = ?', [tenantId, String(ref || '').toUpperCase()]);
  if (!r || String(email || '').trim().toLowerCase() !== r.contact_email.toLowerCase()) throw notFound('Booking');
  const reqs = await require('../db').rows(db, `SELECT r.reference, r.status, s.starts_at, pr.name AS product FROM lesson_requests r JOIN lesson_sessions s ON s.tenant_id = r.tenant_id AND s.id = r.session_id
    JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id WHERE r.tenant_id = ? AND r.basket_id = ? ORDER BY s.starts_at`, [tenantId, r.id]);
  return { reference: r.reference, status: r.status, amount_cents: r.amount_cents, lessons: reqs };
}

module.exports = { basketSchema, studentSchema, create, status, keyOf, MAX_ITEMS };
