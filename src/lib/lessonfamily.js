'use strict';
// The family's side of a lesson (Track PARENTS): the family booking basket (several students, each with their own lesson,
// a lift ticket and rental when the lesson offers them, one payment), the safety details and consents saved on each
// booking, the family lesson page (/lesson/<mountain>/<token>), changing the date and canceling within the policy, tips,
// the next-step offers, the progress card, the follow-up after a first lesson, and the families' own settings.
//
// Children's data (allergies, medical notes, pickup) is read here only for the family that holds the booking's link, and
// is never logged.
const crypto = require('crypto');
const { pool, tx, rows, one } = require('../db');
const { z, nowIn, todayIn, addDays, seasonFor } = require('./util');
const { conflict, bad, notFound, Unhonourable } = require('./errors');
const { audit } = require('./audit');
const L = require('./levels');
const S = require('./schoolsettings');
const links = require('./lessonlinks');
const { studentClash, clashWords } = require('./lessonrules');
const { notify, textsOn } = require('./familynotify');
const { unitPrice } = require('./pricing');
const { loadRules, applyTax } = require('./tax');
const { hoursUntil, refundPercent, tierFor, contactPerson, confirmRequest } = require('./onlinesale');
const { ageOn } = require('./guesttypes');
const cardrefund = require('./cardrefund');
const stripe = require('./stripe');
const connect = require('./connect');
const { logFailure } = require('./jobs');

const system = (tenantId) => ({ auth: { tenantId, userId: null } });
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const firstOf = (name) => String(name || '').trim().split(/\s+/)[0] || '';

// ---------------------------------------------------------------- the families' settings
const FAMILY_DEFAULTS = { next_lesson_on: 1, pack_on: 1, pack_credit: 0, pass_on: 0, pass_words: null, followup_on: 1, what_to_bring: null };
const bool = z.union([z.boolean(), z.literal(0), z.literal(1)]).transform((v) => (v ? 1 : 0));
const familySchema = z.object({
  next_lesson_on: bool, pack_on: bool, pack_credit: bool, pass_on: bool,
  pass_words: z.string().trim().max(300).nullable(), followup_on: bool, what_to_bring: z.string().trim().max(500).nullable(),
}).partial();
async function familySettings(db, tenantId) {
  const row = await one(db, 'SELECT * FROM school_family_settings WHERE tenant_id = ?', [tenantId]);
  const out = { ...FAMILY_DEFAULTS };
  if (row) for (const k of Object.keys(FAMILY_DEFAULTS)) if (row[k] !== undefined) out[k] = row[k];
  // One "What to bring" for the school: Settings, Ski school, Confirmations (school_settings), used by the confirmation too.
  const shared = (await one(db, 'SELECT what_to_bring FROM school_settings WHERE tenant_id = ?', [tenantId]) || {}).what_to_bring;
  if (shared) out.what_to_bring = shared;
  return out;
}
async function saveFamilySettings(conn, tenantId, fields) {
  const keys = Object.keys(fields).filter((k) => k in FAMILY_DEFAULTS);
  if (!keys.length) return;
  await conn.query(`INSERT INTO school_family_settings (tenant_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')}) ON DUPLICATE KEY UPDATE ${keys.map((k) => `${k} = VALUES(${k})`).join(', ')}`,
    [tenantId, ...keys.map((k) => fields[k])]);
}
const DEFAULT_PASS_WORDS = 'You have had three lessons with us. Put what you spent toward a season pass: ask at the ski school desk.';
const DEFAULT_TIP_POLICY = 'Tips go in full to your instructor.';

// ---------------------------------------------------------------- what a lesson offers with it
/** product_id -> { ticket_product_id, rental_product_id } for the mountain's lesson products. */
async function productExtras(db, tenantId) {
  const map = new Map();
  for (const r of await rows(db, 'SELECT product_id, ticket_product_id, rental_product_id FROM lesson_product_extras WHERE tenant_id = ?', [tenantId])) map.set(Number(r.product_id), r);
  return map;
}

/** Does this lesson fit a student of this age and level? A lesson with no ages or levels takes anyone. */
function fits(session, { age = null, level = null, discipline = null } = {}) {
  if (discipline && session.discipline && discipline !== session.discipline && !(session.discipline === 'adaptive' || discipline === 'adaptive')) return false;
  if (age !== null && age !== undefined) {
    if (session.age_min != null && age < Number(session.age_min)) return false;
    if (session.age_max != null && age > Number(session.age_max)) return false;
  }
  return L.fits(level, session.level_min, session.level_max);
}
const agesWords = (min, max) => (min != null && max != null ? `Ages ${min} to ${max}` : min != null ? `Ages ${min} and up` : max != null ? `Ages up to ${max}` : 'All ages');

// ---------------------------------------------------------------- after a request becomes bookings
/**
 * Saves what the family told us on each new booking: safety details, contact, consents and the level they booked at.
 * A level from "Find my level" goes on the person only when an instructor has not set one. Called by
 * onlinesale.confirmRequest for every online request (staff confirming it, or the payment landing).
 */
async function afterConfirm(conn, tenantId, students, session, booked, contact) {
  for (const [i, b] of booked.entries()) {
    const st = students[i] || {};
    const level = L.valid(Number(st.level)) ? Number(st.level) : null;
    await conn.query(`UPDATE lesson_bookings SET allergies = COALESCE(?, allergies), medical = COALESCE(?, medical), pickup = COALESCE(?, pickup),
        contact_name = COALESCE(contact_name, ?), contact_phone = COALESCE(contact_phone, ?), contact_email = COALESCE(contact_email, ?),
        text_ok = GREATEST(text_ok, ?), photo_ok = GREATEST(photo_ok, ?), level = COALESCE(?, level)
      WHERE tenant_id = ? AND id = ?`,
    [st.allergies || null, st.medical || null, st.pickup || null, contact.name || null, contact.phone || null, contact.email || null,
      st.text_ok ? 1 : 0, st.photo_ok ? 1 : 0, level, tenantId, b.booking_id]);
    if (level) {
      const col = L.personColumn(st.discipline || session.discipline);
      await conn.query(`UPDATE people SET ${col} = ?, level_source = 'quiz', level_set_at = NOW() WHERE tenant_id = ? AND id = ? AND (${col} IS NULL OR level_source IS NULL OR level_source IN ('quiz','import'))`, [level, tenantId, b.person_id]);
    }
    if (st.text_ok) await require('./consent').recordConsent(conn, tenantId, b.person_id, 'sms', 'opted_in', 'online', null).catch(() => {});
  }
}

// ---------------------------------------------------------------- the family basket
/** The price of a lift ticket or rental with a lesson, for one student on the lesson day. */
async function extraLine(conn, tenantId, kind, productId, student, day, key) {
  const p = await one(conn, 'SELECT id, name, kind, active, valid_days, uses FROM products WHERE tenant_id = ? AND id = ?', [tenantId, productId]);
  if (!p || !p.active) throw conflict(`The ${kind === 'ticket' ? 'lift ticket' : 'rental'} for that lesson is not on sale. Please call the ski school.`);
  const tier = await tierFor(conn, tenantId, student.date_of_birth, day);
  const { cents } = await unitPrice(conn, tenantId, productId, tier, day);
  return { kind, product_id: p.id, name: p.name, product_kind: p.kind, valid_days: Math.max(Number(p.valid_days) || 1, 1), uses: p.uses, tier, unit: cents, valid_on: day, key };
}

/** Prices the extras (tickets and rentals) for a basket, tax included. */
async function priceExtras(conn, tenantId, lines) {
  if (!lines.length) return { lines: [], subtotal: 0, tax: 0, taxes: [], total: 0 };
  const priced = lines.map((l) => ({ type: l.kind === 'rental' ? 'rental' : 'ticket', unit: l.unit, cents: l.unit }));
  const { tax, taxes } = applyTax(priced, 0, await loadRules(conn, tenantId));
  const subtotal = priced.reduce((n, p) => n + p.cents, 0);
  return { lines: lines.map((l, i) => ({ ...l, tax: priced[i].tax || 0 })), subtotal, tax, taxes, total: subtotal + tax };
}

/**
 * The payment for a family basket landed: every lesson request in it becomes bookings and a sale (onlinesale.confirmRequest),
 * then the lift tickets and rentals are sold on one more order, with the rentals waiting in the rental shop's Ready to fit.
 * If anything cannot be honored (a lesson filled up, a clash), nothing is kept and the whole payment goes back.
 */
async function fulfilBasket(event, obj) {
  const tenantId = Number(obj.metadata.tenant_id); const basketId = Number(obj.metadata.basket_id);
  if (event.type === 'checkout.session.expired') {
    await tx(async (conn) => {
      const [u] = await conn.query("UPDATE lesson_baskets SET status = 'expired' WHERE tenant_id = ? AND id = ? AND status = 'awaiting_payment' AND (stripe_session_id = ? OR stripe_session_id IS NULL)", [tenantId, basketId, obj.id]);
      if (u.affectedRows) await conn.query("UPDATE lesson_requests SET status = 'expired' WHERE tenant_id = ? AND basket_id = ? AND status = 'awaiting_payment'", [tenantId, basketId]);
    });
    return { expired: true };
  }
  if (event.type !== 'checkout.session.completed' || obj.payment_status !== 'paid') return { ignored: true };
  let failed = null; let result;
  try {
    result = await tx(async (conn) => {
      const b = await one(conn, 'SELECT * FROM lesson_baskets WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, basketId]);
      if (!b) { logFailure({ job: 'stripe_webhook', tenant: tenantId, message: `a paid card page names lesson basket ${basketId}, which is not on file` }); return { ignored: true }; }
      if (b.payment_intent === String(obj.payment_intent) || await cardrefund.returned(conn, tenantId, obj.payment_intent)) return { duplicate: true };
      if (b.status !== 'awaiting_payment') throw new Unhonourable(`the booking was ${b.status === 'cancelled' ? 'canceled' : b.status} before the payment arrived`);
      if (b.stripe_session_id && b.stripe_session_id !== obj.id) throw new Unhonourable('it was not the card page saved for this booking');
      if (Number(obj.amount_total) !== Number(b.amount_cents)) throw new Unhonourable('the amount paid was not the amount asked');
      const payee = connect.paidTo(event);
      const reqs = await rows(conn, "SELECT * FROM lesson_requests WHERE tenant_id = ? AND basket_id = ? AND status = 'awaiting_payment' ORDER BY id FOR UPDATE", [tenantId, basketId]);
      const people = new Map(); // student key -> person id
      let feeLeft = payee.feeCents || 0;
      for (const r of reqs) {
        let out;
        try {
          out = await confirmRequest(conn, tenantId, r, { paid: true, paymentIntent: obj.payment_intent, payee: { account: payee.account, feeCents: feeLeft } });
        } catch (err) { if (err.status && err.status < 500) throw new Unhonourable(err.message); throw err; }
        feeLeft = 0;
        const s = await one(conn, 'SELECT id, starts_at, ends_at FROM lesson_sessions WHERE tenant_id = ? AND id = ?', [tenantId, r.session_id]);
        let students = []; try { students = JSON.parse(r.students).students || []; } catch (_) { /* none */ }
        for (const [i, bk] of out.booked.entries()) {
          const c = await studentClash(conn, tenantId, bk.person_id, s.starts_at, s.ends_at, { ignoreSessionId: s.id });
          if (c) throw new Unhonourable(`${bk.name}: ${clashWords(c)}`);
          if (students[i] && students[i].key) people.set(students[i].key, bk.person_id);
        }
      }
      let extras = null; try { extras = JSON.parse(b.extras || 'null'); } catch (_) { extras = null; }
      let extrasOrder = null;
      if (extras && extras.lines && extras.lines.length) {
        const contact = await contactPerson(conn, tenantId, { first_name: extras.contact.first_name, last_name: extras.contact.last_name, email: b.contact_email, phone: extras.contact.phone });
        const [o] = await conn.query("INSERT INTO orders (tenant_id, person_id, user_id, status, subtotal_cents, discount_cents, tax_cents, total_cents, channel, payment_ref) VALUES (?, ?, NULL, 'paid', ?, 0, ?, ?, 'online', ?)",
          [tenantId, contact.id, extras.subtotal, extras.tax, extras.total, obj.payment_intent]);
        extrasOrder = o.insertId;
        for (const t of extras.taxes || []) await conn.query('INSERT INTO order_taxes (tenant_id, order_id, name, rate_bps, amount_cents) VALUES (?, ?, ?, ?, ?)', [tenantId, extrasOrder, t.name, t.rate_bps, t.amount_cents]);
        const { newCode } = require('./util');
        for (const ln of extras.lines) {
          const personId = people.get(ln.key) || contact.id;
          const lineKind = ln.kind === 'rental' ? 'rental' : 'ticket';
          const [it] = await conn.query('INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, person_id, tier, quantity, unit_price_cents, valid_on, discount_cents, tax_cents) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 0, ?)',
            [tenantId, extrasOrder, ln.product_id, lineKind, personId, ln.tier, ln.unit, ln.valid_on, ln.tax || 0]);
          if (ln.kind === 'rental') {
            const F = require('./rentalfit');
            const product = await one(conn, 'SELECT id, valid_days, rental_kind FROM products WHERE tenant_id = ? AND id = ?', [tenantId, ln.product_id]);
            const c = await F.createToFit(conn, tenantId, { personId, orderId: extrasOrder, orderItemId: it.insertId, validOn: ln.valid_on, product, notes: 'Booked with a lesson online' });
            await conn.query('UPDATE order_items SET contract_id = ? WHERE tenant_id = ? AND id = ?', [c.id, tenantId, it.insertId]);
          } else {
            await conn.query('INSERT INTO tickets (tenant_id, order_item_id, person_id, product_id, code, valid_from, valid_to, uses_remaining) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              [tenantId, it.insertId, personId, ln.product_id, newCode(), ln.valid_on, addDays(ln.valid_on, ln.valid_days - 1), ln.uses ?? null]);
          }
        }
        await conn.query("INSERT INTO order_payments (tenant_id, order_id, tender, amount_cents, reference, processor, processor_account, platform_fee_cents) VALUES (?, ?, 'card', ?, ?, 'stripe', ?, 0)",
          [tenantId, extrasOrder, extras.total, obj.payment_intent, payee.account || null]);
      }
      await conn.query("UPDATE lesson_baskets SET status = 'paid', paid_at = NOW(), payment_intent = ?, stripe_session_id = COALESCE(stripe_session_id, ?), extras_order_id = ? WHERE tenant_id = ? AND id = ?",
        [String(obj.payment_intent), obj.id, extrasOrder, tenantId, basketId]);
      await audit(conn, system(tenantId), 'basket_paid', 'lesson_baskets', basketId, { requests: reqs.length, extras_order_id: extrasOrder });
      return { ok: true, requests: reqs.map((r) => r.id) };
    });
  } catch (err) {
    if (!(err instanceof Unhonourable)) throw err;
    failed = err.message;
  }
  if (failed) {
    const owed = await tx(async (conn) => {
      const [u] = await conn.query("UPDATE lesson_baskets SET status = IF(status = 'awaiting_payment', 'expired', status) WHERE tenant_id = ? AND id = ?", [tenantId, basketId]);
      if (!u.affectedRows) return null;
      await conn.query("UPDATE lesson_requests SET status = 'expired', staff_note = ? WHERE tenant_id = ? AND basket_id = ? AND status = 'awaiting_payment'", [`Refunded automatically: ${failed}`.slice(0, 300), tenantId, basketId]);
      return cardrefund.oweReturn(conn, { tenantId, kind: 'lesson_basket', rowId: basketId, session: obj.id, paymentIntent: obj.payment_intent, amountCents: Number(obj.amount_total), account: event.account || null, reason: failed });
    });
    if (owed) await cardrefund.sendReturn(owed);
    return { problem: true, refunded: Boolean(owed) };
  }
  // The confirmation for each new booking (Track CORE's lessonconfirm), after the commit.
  if (result && result.requests) {
    const base = require('../config').stripe.publicUrl || '';
    for (const rid of result.requests) {
      for (const bk of await rows(pool, 'SELECT id FROM lesson_bookings WHERE tenant_id = ? AND request_id = ?', [tenantId, rid])) {
        await require('./lessonconfirm').sendConfirmation(pool, tenantId, bk.id, base).catch(() => {});
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------- tips
async function tipWebhook(event, obj) {
  const tenantId = Number(obj.metadata.tenant_id); const tipId = Number(obj.metadata.tip_id);
  if (event.type === 'checkout.session.expired') {
    await pool.query("UPDATE lesson_tips SET status = 'failed' WHERE tenant_id = ? AND id = ? AND status = 'pending'", [tenantId, tipId]);
    return { expired: true };
  }
  if (event.type !== 'checkout.session.completed' || obj.payment_status !== 'paid') return { ignored: true };
  return markTipPaid(tenantId, tipId, obj);
}
/** A tip's payment arrived (from the webhook or the return check). Changes nothing the second time. */
async function markTipPaid(tenantId, tipId, obj) {
  return tx(async (conn) => {
    const tip = await one(conn, 'SELECT * FROM lesson_tips WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, tipId]);
    if (!tip) return { ignored: true };
    if (tip.status === 'paid') return { duplicate: true };
    if (Number(obj.amount_total) !== Number(tip.amount_cents) || (tip.stripe_session_id && tip.stripe_session_id !== obj.id)) {
      logFailure({ job: 'stripe_webhook', tenant: tenantId, message: `tip ${tipId}: the payment did not match the tip` });
      return { problem: true };
    }
    await conn.query("UPDATE lesson_tips SET status = 'paid', paid_at = NOW(), payment_intent = ? WHERE tenant_id = ? AND id = ?", [String(obj.payment_intent || ''), tenantId, tipId]);
    await audit(conn, system(tenantId), 'tip_paid', 'lesson_tips', tipId, { amount_cents: tip.amount_cents });
    return { ok: true, tip: tipId };
  });
}
/** The family came back from Stripe: ask Stripe whether the tip page was paid, in case the webhook is slow. */
async function checkTip(tenantId, tipId) {
  const tip = await one(pool, 'SELECT id, status, stripe_session_id FROM lesson_tips WHERE tenant_id = ? AND id = ?', [tenantId, tipId]);
  if (!tip || tip.status !== 'pending' || !tip.stripe_session_id) return tip ? tip.status : null;
  const acct = (await one(pool, 'SELECT stripe_account FROM tenants WHERE id = ?', [tenantId])).stripe_account || null;
  let s = null;
  try { s = await stripe.get(`/v1/checkout/sessions/${encodeURIComponent(tip.stripe_session_id)}`, { account: acct }); } catch (_) { return 'pending'; }
  if (s && s.status === 'complete' && s.payment_status === 'paid') { await markTipPaid(tenantId, tipId, { ...s, id: tip.stripe_session_id }); return 'paid'; }
  return 'pending';
}

/** Card payment webhooks for the families' parts: a basket or a tip. Returns null when the event is not ours. */
async function handleWebhook(event, obj) {
  if (!obj || !obj.metadata) return null;
  if (obj.metadata.kind === 'lesson_basket') return fulfilBasket(event, obj);
  if (obj.metadata.kind === 'lesson_tip') return tipWebhook(event, obj);
  return null;
}

// ---------------------------------------------------------------- the family lesson page
/** The booking a family link points to: the booking's own link, or the link in a recap email. */
async function bookingByToken(db, tenantId, token) {
  const b = await links.find(db, tenantId, token);
  if (b) return b;
  if (!links.looksRight(token)) return null;
  const r = await one(db, 'SELECT booking_id FROM lesson_recaps WHERE tenant_id = ? AND token_sha = ?', [tenantId, sha(token)]);
  if (!r) return null;
  return one(db, `SELECT b.*, s.starts_at, s.ends_at, s.status AS session_status, s.discipline, s.level_min, s.level_max, s.meeting_place,
      s.instructor_id, s.product_id, s.format, s.delay_minutes, pr.name AS product, p.first_name, p.last_name
    FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id
    JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id JOIN people p ON p.tenant_id = b.tenant_id AND p.id = b.person_id
    WHERE b.tenant_id = ? AND b.id = ?`, [tenantId, r.booking_id]);
}

/** Wall-clock time plus minutes, as 'YYYY-MM-DD HH:MM:SS'. */
function plusMinutes(s, mins) {
  const d = new Date(`${String(s).slice(0, 19).replace(' ', 'T')}Z`);
  d.setUTCMinutes(d.getUTCMinutes() + Number(mins || 0));
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** A UTC stamp from the database as the mountain's wall-clock time ('YYYY-MM-DD HH:MM:SS'). */
function localOf(utc, tz) {
  const d = new Date(`${String(utc).slice(0, 19).replace(' ', 'T')}Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** Is "We're here" open: the lesson day, from 90 minutes before the start until the end, lesson and booking not canceled. */
function checkinOpen(b, nowLocal) {
  if (b.session_status === 'cancelled' || b.status !== 'booked') return false;
  const start = plusMinutes(b.starts_at, b.delay_minutes); const end = plusMinutes(b.ends_at, b.delay_minutes);
  if (nowLocal.slice(0, 10) !== String(b.starts_at).slice(0, 10)) return false;
  return nowLocal >= plusMinutes(start, -90) && nowLocal <= end;
}

/** The hours before the lesson within which the family can still change or cancel for free (the policy's full-refund cutoff). */
const freeHours = (t) => Number(t.refund_full_hours || t.cancel_hours || 24);

/** The price this student paid (or would pay) for their lesson, per student. */
async function paidUnit(db, tenantId, b) {
  if (b.request_id) {
    const it = await one(db, `SELECT oi.unit_price_cents, oi.discount_cents, oi.tax_cents FROM order_items oi JOIN lesson_requests r ON r.tenant_id = oi.tenant_id AND r.order_id = oi.order_id
      WHERE oi.tenant_id = ? AND r.id = ? AND oi.person_id = ? AND oi.line_kind = 'lesson' ORDER BY oi.id LIMIT 1`, [tenantId, b.request_id, b.person_id]);
    if (it) return Number(it.unit_price_cents);
  }
  const it = await one(db, "SELECT unit_price_cents FROM order_items WHERE tenant_id = ? AND session_id = ? AND person_id = ? AND line_kind = 'lesson' ORDER BY id DESC LIMIT 1", [tenantId, b.session_id, b.person_id]);
  return it ? Number(it.unit_price_cents) : null;
}

/** Lessons this booking can move to: same discipline, fits the student, spots left, same price, in the next 45 days. */
async function moveChoices(db, t, b) {
  const nowLocal = nowIn(t.timezone);
  const person = await one(db, 'SELECT date_of_birth, ski_level, snowboard_level FROM people WHERE tenant_id = ? AND id = ?', [t.id, b.person_id]);
  const level = b.level || L.personLevel(person, b.discipline);
  const earliest = plusMinutes(nowLocal, Number(t.booking_notice_hours || 0) * 60);
  const list = await rows(db, `SELECT s.id, s.starts_at, s.ends_at, s.discipline, s.level_min, s.level_max, s.age_min, s.age_max, s.capacity, s.meeting_place, s.product_id, pr.name AS product,
      (SELECT COUNT(*) FROM lesson_bookings x WHERE x.tenant_id = s.tenant_id AND x.session_id = s.id AND x.status IN ('booked','attended')) AS booked
    FROM lesson_sessions s JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
    WHERE s.tenant_id = ? AND s.status = 'scheduled' AND s.id <> ? AND s.discipline = ? AND s.starts_at >= ? AND DATE(s.starts_at) <= ? ORDER BY s.starts_at LIMIT 200`,
  [t.id, b.session_id, b.discipline, earliest, addDays(nowLocal.slice(0, 10), 45)]);
  const held = await heldSpots(db, t.id);
  const unit = await paidUnit(db, t.id, b);
  const tier = person && person.date_of_birth ? await tierFor(db, t.id, person.date_of_birth, String(b.starts_at).slice(0, 10)) : 'adult';
  const out = [];
  for (const s of list) {
    if (s.capacity - Number(s.booked) - (held.get(Number(s.id)) || 0) <= 0) continue;
    const age = person && person.date_of_birth ? ageOn(person.date_of_birth, String(s.starts_at).slice(0, 10)) : null;
    if (!fits(s, { age, level })) continue;
    let price = null;
    try { price = (await unitPrice(db, t.id, s.product_id, tier, String(s.starts_at).slice(0, 10))).cents; } catch (_) { continue; }
    if (s.product_id !== b.product_id && unit !== null && price !== unit) continue;
    if (unit === null && s.product_id !== b.product_id) continue;
    out.push({ id: s.id, starts_at: s.starts_at, ends_at: s.ends_at, product: s.product, level_words: L.range(s.level_min, s.level_max), meeting_place: s.meeting_place });
    if (out.length >= 40) break;
  }
  return out;
}

/** Spots held per lesson: online requests waiting (to confirm or to pay) and waitlist offers not yet claimed. */
async function heldSpots(db, tenantId) {
  const held = new Map();
  for (const r of await rows(db, "SELECT session_id, students FROM lesson_requests WHERE tenant_id = ? AND status IN ('pending','awaiting_payment')", [tenantId])) {
    let n = 1; try { n = JSON.parse(r.students).students.length; } catch (_) { /* one */ }
    held.set(Number(r.session_id), (held.get(Number(r.session_id)) || 0) + n);
  }
  for (const r of await rows(db, "SELECT session_id, COUNT(*) AS n FROM lesson_waitlist WHERE tenant_id = ? AND status = 'offered' AND offer_expires_at > UTC_TIMESTAMP() GROUP BY session_id", [tenantId])) {
    held.set(Number(r.session_id), (held.get(Number(r.session_id)) || 0) + Number(r.n));
  }
  return held;
}

/** What the family may do now: change the date and cancel, with the reason when they cannot. */
async function policyNow(db, t, b) {
  const nowLocal = nowIn(t.timezone);
  const hours = hoursUntil(String(b.starts_at), nowLocal);
  const out = { can_change: false, can_cancel: false, refund_percent: 0, change_until_hours: freeHours(t), why: null };
  if (b.status !== 'booked' || b.session_status !== 'scheduled') { out.why = b.status === 'cancelled' ? 'This booking is canceled.' : null; return out; }
  if (hours <= 0) { out.why = 'The lesson has started.'; return out; }
  const call = `Please call the ski school${t.phone ? ` on ${t.phone}` : ''}.`;
  out.can_change = hours >= freeHours(t);
  if (!out.can_change) out.why = `Changes online close ${freeHours(t)} hours before the lesson. ${call}`;
  const r = b.request_id ? await one(db, 'SELECT id, status, order_id FROM lesson_requests WHERE tenant_id = ? AND id = ?', [t.id, b.request_id]) : null;
  if (r && r.order_id) { out.can_cancel = true; out.refund_percent = refundPercent(t, hours); } else if (b.unpaid && r) { out.can_cancel = hours >= Number(t.cancel_hours || 24); out.refund_percent = 0; } else if (b.credit_id) { out.can_cancel = hours >= freeHours(t); out.refund_percent = 100; } else { out.can_cancel = false; }
  if (!out.can_cancel && !out.why) out.why = `To cancel, ${call.charAt(0).toLowerCase()}${call.slice(1)}`;
  return out;
}

/** The progress card for one student: levels, levels passed, skills, recaps, lessons and programs, across seasons. */
async function progressCard(db, tenantId, personId, { recapBodies = true } = {}) {
  const p = await one(db, 'SELECT id, first_name, ski_level, snowboard_level, level_source, level_set_at FROM people WHERE tenant_id = ? AND id = ?', [tenantId, personId]);
  if (!p) return null;
  const levels = [];
  if (p.ski_level) levels.push({ discipline: 'ski', level: p.ski_level, words: L.name(p.ski_level, 'ski'), can: L.SKI[p.ski_level].can });
  if (p.snowboard_level) levels.push({ discipline: 'snowboard', level: p.snowboard_level, words: L.name(p.snowboard_level, 'snowboard'), can: L.SNOWBOARD[p.snowboard_level].can });
  const passed = (await rows(db, 'SELECT discipline, level, recorded_at FROM student_progress WHERE tenant_id = ? AND person_id = ? ORDER BY recorded_at, id', [tenantId, personId]))
    .filter((r) => L.valid(Number(r.level))).map((r) => ({ discipline: r.discipline, level: Number(r.level), words: L.name(r.level, r.discipline), on: String(r.recorded_at).slice(0, 10) }));
  const skills = (await rows(db, `SELECT k.name, ss.passed_on, l.discipline FROM student_skills ss JOIN school_skills k ON k.tenant_id = ss.tenant_id AND k.id = ss.skill_id
      JOIN school_levels l ON l.tenant_id = k.tenant_id AND l.id = k.level_id WHERE ss.tenant_id = ? AND ss.person_id = ? ORDER BY ss.passed_on, k.sort_no`, [tenantId, personId]))
    .map((s) => ({ name: s.name, discipline: s.discipline, on: String(s.passed_on).slice(0, 10) }));
  const recaps = (await rows(db, `SELECT r.id, r.body, r.level, r.sent_at, s.starts_at, s.discipline, pr.name AS product FROM lesson_recaps r
      JOIN lesson_sessions s ON s.tenant_id = r.tenant_id AND s.id = r.session_id JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
      WHERE r.tenant_id = ? AND r.person_id = ? AND r.status = 'sent' ORDER BY s.starts_at DESC LIMIT 30`, [tenantId, personId]))
    .map((r) => ({ date: String(r.starts_at).slice(0, 10), product: r.product, level_words: r.level ? L.name(r.level, r.discipline) : null, ...(recapBodies ? { body: r.body } : {}) }));
  const lessons = await one(db, `SELECT COUNT(*) AS n FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id
      WHERE b.tenant_id = ? AND b.person_id = ? AND b.status IN ('booked','attended') AND s.status <> 'cancelled' AND s.ends_at < ?`, [tenantId, personId, nowIn((await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone)]);
  const programs = (await rows(db, `SELECT pr.name, MAX(pt.name) AS term, MAX(pt.starts_on) AS starts_on FROM program_enrollments e JOIN programs pr ON pr.tenant_id = e.tenant_id AND pr.id = e.program_id
      LEFT JOIN program_terms pt ON pt.tenant_id = e.tenant_id AND pt.id = e.term_id
      WHERE e.tenant_id = ? AND e.person_id = ? AND e.status = 'enrolled' GROUP BY pr.id, pr.name, e.term_id ORDER BY starts_on DESC LIMIT 12`, [tenantId, personId]))
    .map((r) => ({ name: r.name, term: r.term || null, season: r.starts_on ? seasonFor(String(r.starts_on).slice(0, 10)) : null }));
  return { first_name: p.first_name, levels, passed, skills, recaps, lessons: Number(lessons.n), programs };
}

/** One-tap next steps after a lesson: the next lessons that fit, a lesson pack, and after three lessons a season pass. */
async function nextSteps(db, t, b, { slug }) {
  const fs = await familySettings(db, t.id);
  const out = { lessons: [], pack: null, pass: null };
  const person = await one(db, 'SELECT date_of_birth, ski_level, snowboard_level FROM people WHERE tenant_id = ? AND id = ?', [t.id, b.person_id]);
  const level = L.personLevel(person, b.discipline) || b.level;
  const nowLocal = nowIn(t.timezone);
  if (fs.next_lesson_on && t.online_booking) {
    const held = await heldSpots(db, t.id);
    const list = await rows(db, `SELECT s.id, s.starts_at, s.ends_at, s.discipline, s.level_min, s.level_max, s.age_min, s.age_max, s.capacity, pr.name AS product,
        (SELECT COUNT(*) FROM lesson_bookings x WHERE x.tenant_id = s.tenant_id AND x.session_id = s.id AND x.status IN ('booked','attended')) AS booked
      FROM lesson_sessions s JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
      WHERE s.tenant_id = ? AND s.status = 'scheduled' AND pr.active = 1 AND s.discipline = ? AND s.starts_at >= ? AND DATE(s.starts_at) <= ? AND s.format = 'group' ORDER BY s.starts_at LIMIT 100`,
    [t.id, b.discipline, plusMinutes(nowLocal, Number(t.booking_notice_hours || 0) * 60), addDays(nowLocal.slice(0, 10), 14)]);
    for (const s of list) {
      if (s.capacity - Number(s.booked) - (held.get(Number(s.id)) || 0) <= 0) continue;
      const age = person && person.date_of_birth ? ageOn(person.date_of_birth, String(s.starts_at).slice(0, 10)) : null;
      if (!fits(s, { age, level })) continue;
      out.lessons.push({ id: s.id, starts_at: s.starts_at, product: s.product, level_words: L.range(s.level_min, s.level_max), link: `/book/${encodeURIComponent(slug)}?lesson=${s.id}` });
      if (out.lessons.length >= 3) break;
    }
  }
  if (fs.pack_on) {
    const pack = await one(db, "SELECT id, name, base_price_cents, uses FROM products WHERE tenant_id = ? AND kind = 'lesson' AND active = 1 AND online = 1 AND uses > 1 ORDER BY uses LIMIT 1", [t.id]);
    if (pack) out.pack = { name: pack.name, price_cents: pack.base_price_cents, lessons: pack.uses, link: `/shop/${encodeURIComponent(slug)}`, credit_words: fs.pack_credit ? 'Today\'s lesson price counts toward it. Show this page at the ski school desk.' : null };
  }
  if (fs.pass_on) {
    const n = await one(db, `SELECT COUNT(*) AS n FROM lesson_bookings x JOIN lesson_sessions s ON s.tenant_id = x.tenant_id AND s.id = x.session_id
      WHERE x.tenant_id = ? AND x.person_id = ? AND x.status IN ('booked','attended') AND s.status <> 'cancelled' AND s.ends_at <= ?`, [t.id, b.person_id, nowLocal]);
    const pass = await one(db, "SELECT id FROM products WHERE tenant_id = ? AND kind = 'season_pass' AND active = 1 AND online = 1 LIMIT 1", [t.id]);
    if (Number(n.n) >= 3 && pass) out.pass = { words: fs.pass_words || DEFAULT_PASS_WORDS, link: `/shop/${encodeURIComponent(slug)}` };
  }
  return out;
}

/** Everything the family lesson page shows, for the family holding the link. */
async function familyView(t, b, { slug }) {
  const set = await S.get(pool, t.id);
  const fs = await familySettings(pool, t.id);
  const nowLocal = nowIn(t.timezone);
  const ins = b.instructor_id ? await one(pool, 'SELECT p.first_name FROM staff st JOIN people p ON p.tenant_id = st.tenant_id AND p.id = st.person_id WHERE st.tenant_id = ? AND st.id = ?', [t.id, b.instructor_id]) : null;
  const sess = await one(pool, 'SELECT cancel_reason FROM lesson_sessions WHERE tenant_id = ? AND id = ?', [t.id, b.session_id]);
  const ended = String(plusMinutes(b.ends_at, b.delay_minutes)) <= nowLocal;
  const recap = await one(pool, "SELECT id, body, skills, level, sent_at FROM lesson_recaps WHERE tenant_id = ? AND booking_id = ? AND status = 'sent'", [t.id, b.id]);
  let recapOut = null;
  if (recap) {
    let skills = []; try { skills = JSON.parse(recap.skills || '[]'); } catch (_) { skills = []; }
    const photos = b.photo_ok ? await rows(pool, 'SELECT id FROM lesson_recap_photos WHERE tenant_id = ? AND recap_id = ? ORDER BY id', [t.id, recap.id]) : [];
    recapOut = { body: recap.body, skills: skills.map((s) => s.name || s), level: recap.level, level_words: recap.level ? L.name(recap.level, b.discipline) : null, sent_at: recap.sent_at, photos: photos.map((p) => p.id) };
  }
  const tipsShown = Boolean(set.tips_on && b.instructor_id && ended && b.status !== 'cancelled' && b.status !== 'no_show' && t.pay_online);
  const tips = tipsShown ? {
    policy: set.tip_policy || DEFAULT_TIP_POLICY, suggested: [500, 1000, 2000],
    given: (await rows(pool, "SELECT amount_cents, status, paid_at FROM lesson_tips WHERE tenant_id = ? AND booking_id = ? AND status IN ('pending','paid') ORDER BY id", [t.id, b.id])).map((x) => ({ amount_cents: x.amount_cents, status: x.status })),
  } : null;
  const policy = await policyNow(pool, t, b);
  return {
    mountain: t.name, phone: t.phone,
    student: { first_name: b.first_name, last_name: b.last_name },
    lesson: {
      product: b.product, starts_at: b.starts_at, ends_at: b.ends_at, discipline: b.discipline, level_words: L.range(b.level_min, b.level_max), format: b.format,
      meeting_place: b.meeting_place, instructor: ins ? ins.first_name : null, what_to_bring: fs.what_to_bring || null,
      status: b.session_status, cancel_reason: b.session_status === 'cancelled' ? (sess && sess.cancel_reason) || null : null,
      delay_minutes: Number(b.delay_minutes || 0), new_start: Number(b.delay_minutes || 0) > 0 ? plusMinutes(b.starts_at, b.delay_minutes) : null, ended,
    },
    booking: {
      status: b.status, checked_in_at: b.checked_in_at, checked_in_local: b.checked_in_at ? localOf(b.checked_in_at, t.timezone) : null, checked_in_via: b.checked_in_via, text_ok: Boolean(b.text_ok), photo_ok: Boolean(b.photo_ok),
      allergies: b.allergies, medical: b.medical, pickup: b.pickup, contact_name: b.contact_name, contact_phone: b.contact_phone, moved_at: b.moved_at,
    },
    checkin_open: checkinOpen(b, nowLocal) && Boolean(set.checkin_link),
    checkin_code: `L${b.id}`, // the desk scans it (lessonlineup.bookingCode)
    credits: await require('./lessonweather').creditsFor(pool, t.id, b.person_id), // weather credits (Track DIRECTOR)
    texts_available: await textsOn(t.id), photos_asked: Boolean(set.recap_photos),
    policy, recap: recapOut, tips,
    next: ended ? await nextSteps(pool, t, b, { slug }) : null,
    progress: await progressCard(pool, t.id, b.person_id),
  };
}

/** Changes the family's details and consents on their booking. */
async function updateDetails(t, b, fields) {
  await tx(async (conn) => {
    const sets = []; const vals = [];
    for (const k of ['allergies', 'medical', 'pickup']) if (fields[k] !== undefined) { sets.push(`${k} = ?`); vals.push(fields[k] || null); }
    if (fields.photo_ok !== undefined) { sets.push('photo_ok = ?'); vals.push(fields.photo_ok ? 1 : 0); }
    if (fields.text_ok !== undefined) { sets.push('text_ok = ?'); vals.push(fields.text_ok ? 1 : 0); }
    if (!sets.length) return;
    await conn.query(`UPDATE lesson_bookings SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, t.id, b.id]);
    if (fields.text_ok !== undefined && Boolean(fields.text_ok) !== Boolean(b.text_ok)) await require('./consent').recordConsent(conn, t.id, b.person_id, 'sms', fields.text_ok ? 'opted_in' : 'opted_out', 'online', null).catch(() => {});
    // Saying no to photos takes away any photo already taken for a recap not yet sent.
    if (fields.photo_ok === false) await conn.query("DELETE ph FROM lesson_recap_photos ph JOIN lesson_recaps r ON r.tenant_id = ph.tenant_id AND r.id = ph.recap_id WHERE ph.tenant_id = ? AND ph.booking_id = ? AND r.status <> 'sent'", [t.id, b.id]);
    await audit(conn, system(t.id), 'family_update_lesson', 'lesson_bookings', b.id, { fields: Object.keys(fields) });
  });
}

/**
 * Moves the booking to another lesson (the same booking row, so the link, safety details and consents stay). Only inside
 * the free window, to a lesson that fits, has room, costs the same and does not clash. Returns the old session id.
 */
async function moveBooking(t, b, toSessionId) {
  const choices = await moveChoices(pool, t, b);
  if (!choices.some((c) => Number(c.id) === Number(toSessionId))) throw conflict('That lesson cannot be chosen. Pick another, or call the ski school.');
  return tx(async (conn) => {
    const cur = await one(conn, 'SELECT * FROM lesson_bookings WHERE tenant_id = ? AND id = ? FOR UPDATE', [t.id, b.id]);
    if (!cur || cur.status !== 'booked') throw conflict('This booking cannot be changed now');
    const [from, to] = await Promise.all([b.session_id, toSessionId].map((id) => one(conn, 'SELECT * FROM lesson_sessions WHERE tenant_id = ? AND id = ? FOR UPDATE', [t.id, id])));
    const pol = await policyNow(conn, t, { ...b, status: cur.status });
    if (!pol.can_change) throw conflict(pol.why || 'This booking cannot be changed now');
    if (!to || to.status !== 'scheduled') throw conflict('That lesson is no longer open');
    const { n } = await one(conn, "SELECT COUNT(*) AS n FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND status IN ('booked','attended')", [t.id, to.id]);
    const held = (await heldSpots(conn, t.id)).get(Number(to.id)) || 0;
    if (to.capacity - Number(n) - held <= 0) throw conflict('That lesson just filled up. Pick another.');
    const clash = await studentClash(conn, t.id, cur.person_id, to.starts_at, to.ends_at, { ignoreSessionId: from.id });
    if (clash) throw conflict(clashWords(clash));
    const old = await one(conn, 'SELECT id, status FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND person_id = ?', [t.id, to.id, cur.person_id]);
    if (old) throw conflict('This student was booked in that lesson before. Please call the ski school to change it.');
    await conn.query('UPDATE lesson_bookings SET session_id = ?, moved_from_session_id = ?, moved_at = NOW(), checked_in_at = NULL, checked_in_by = NULL, checked_in_via = NULL WHERE tenant_id = ? AND id = ?', [to.id, from.id, t.id, cur.id]);
    // The sale follows the lesson, so receipts and reports name the new date.
    await conn.query("UPDATE order_items SET session_id = ?, valid_on = ? WHERE tenant_id = ? AND session_id = ? AND person_id = ? AND line_kind = 'lesson' AND refunded_at IS NULL", [to.id, String(to.starts_at).slice(0, 10), t.id, from.id, cur.person_id]);
    if (cur.request_id) await conn.query('UPDATE lesson_requests SET session_id = ? WHERE tenant_id = ? AND id = ? AND NOT EXISTS (SELECT 1 FROM (SELECT id FROM lesson_bookings WHERE tenant_id = ? AND request_id = ? AND session_id = ? AND id <> ? AND status IN (\'booked\',\'attended\')) x)',
      [to.id, t.id, cur.request_id, t.id, cur.request_id, from.id, cur.id]);
    await audit(conn, system(t.id), 'family_move_lesson', 'lesson_bookings', cur.id, { from: from.id, to: to.id });
    return { from: Number(from.id), to: Number(to.id) };
  });
}

/** Cancels this one booking under the policy. Returns { refund_cents, refund_percent, credit_returned, refundId }. */
async function cancelBooking(t, b) {
  return tx(async (conn) => {
    const cur = await one(conn, 'SELECT * FROM lesson_bookings WHERE tenant_id = ? AND id = ? FOR UPDATE', [t.id, b.id]);
    if (!cur || cur.status !== 'booked') throw conflict('This booking is not active');
    const pol = await policyNow(conn, t, { ...b, ...cur, session_status: b.session_status });
    if (!pol.can_cancel) throw conflict(pol.why || 'Please call the ski school to cancel.');
    const out = { refund_cents: 0, refund_percent: pol.refund_percent, credit_returned: false, refundId: null };
    const r = cur.request_id ? await one(conn, 'SELECT * FROM lesson_requests WHERE tenant_id = ? AND id = ? FOR UPDATE', [t.id, cur.request_id]) : null;
    if (r && r.order_id) {
      const order = await one(conn, 'SELECT id, total_cents, tax_cents, refunded_cents FROM orders WHERE tenant_id = ? AND id = ? FOR UPDATE', [t.id, r.order_id]);
      const line = await one(conn, "SELECT id, unit_price_cents, quantity, discount_cents, tax_cents FROM order_items WHERE tenant_id = ? AND order_id = ? AND person_id = ? AND line_kind = 'lesson' AND refunded_at IS NULL ORDER BY id LIMIT 1", [t.id, order.id, cur.person_id]);
      const lineTotal = line ? Number(line.unit_price_cents) * Number(line.quantity) - Number(line.discount_cents) + Number(line.tax_cents) : 0;
      const cents = Math.min(Math.floor((lineTotal * pol.refund_percent) / 100), Number(order.total_cents) - Number(order.refunded_cents));
      if (cents > 0) {
        const tax = line ? Math.round((Number(line.tax_cents) * cents) / Math.max(lineTotal, 1)) : 0;
        const [rf] = await conn.query("INSERT INTO order_refunds (tenant_id, order_id, user_id, reason, note, amount_cents, tax_cents, method) VALUES (?, ?, NULL, 'customer_request', ?, ?, ?, 'card')",
          [t.id, order.id, `Canceled online by the family: ${pol.refund_percent}% refund`, cents, tax]);
        out.refundId = rf.insertId; out.refund_cents = cents;
        if (r.payment_intent) await cardrefund.markPending(conn, t.id, rf.insertId, r.payment_intent);
        const whole = Number(order.refunded_cents) + cents >= Number(order.total_cents);
        await conn.query("UPDATE orders SET refunded_cents = refunded_cents + ?, status = IF(?, 'refunded', status) WHERE tenant_id = ? AND id = ?", [cents, whole ? 1 : 0, t.id, order.id]);
        if (line && cents >= lineTotal) await conn.query('UPDATE order_items SET refunded_at = NOW(), refund_id = ? WHERE tenant_id = ? AND id = ?', [rf.insertId, t.id, line.id]);
      }
      await conn.query('UPDATE lesson_requests SET refund_cents = refund_cents + ? WHERE tenant_id = ? AND id = ?', [cents, t.id, r.id]);
    } else if (cur.credit_id) {
      await conn.query('UPDATE lesson_credits SET used = GREATEST(used - 1, 0) WHERE tenant_id = ? AND id = ?', [t.id, cur.credit_id]);
      await conn.query('UPDATE lesson_bookings SET credit_id = NULL WHERE tenant_id = ? AND id = ?', [t.id, cur.id]);
      out.credit_returned = true;
    }
    await conn.query("UPDATE lesson_bookings SET status = 'cancelled' WHERE tenant_id = ? AND id = ?", [t.id, cur.id]);
    if (r) {
      const left = await one(conn, "SELECT COUNT(*) AS n FROM lesson_bookings WHERE tenant_id = ? AND request_id = ? AND status IN ('booked','attended')", [t.id, r.id]);
      if (!Number(left.n)) await conn.query("UPDATE lesson_requests SET status = 'cancelled', decided_at = NOW() WHERE tenant_id = ? AND id = ?", [t.id, r.id]);
    }
    await audit(conn, system(t.id), 'family_cancel_lesson', 'lesson_bookings', cur.id, { refund_cents: out.refund_cents, percent: out.refund_percent, credit: out.credit_returned });
    return out;
  });
}

// ---------------------------------------------------------------- the follow-up after a first or second lesson
/** Three days after a first or second lesson with nothing else booked, one email (and a text with the add-on). */
async function followups(base) {
  let sent = 0;
  const tenants = await rows(pool, `SELECT DISTINCT t.id, t.name, t.slug, t.timezone, t.online_booking FROM tenants t JOIN lesson_sessions s ON s.tenant_id = t.id
    WHERE s.starts_at >= DATE_SUB(CURDATE(), INTERVAL 5 DAY) AND s.starts_at < DATE_SUB(CURDATE(), INTERVAL 1 DAY)`);
  for (const t of tenants) {
    if (!(await familySettings(pool, t.id)).followup_on || !t.online_booking) continue;
    const day = addDays(todayIn(t.timezone), -3);
    const list = await rows(pool, `SELECT b.id, b.person_id, b.text_ok, b.contact_email, b.contact_phone, b.request_id, s.starts_at, s.discipline, p.first_name, p.email AS person_email
      FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id JOIN people p ON p.tenant_id = b.tenant_id AND p.id = b.person_id
      WHERE b.tenant_id = ? AND DATE(s.starts_at) = ? AND s.status <> 'cancelled' AND b.status IN ('booked','attended') AND b.followup_sent_at IS NULL`, [t.id, day]);
    for (const b of list) {
      const [{ n }] = [await one(pool, `SELECT COUNT(*) AS n FROM lesson_bookings x JOIN lesson_sessions s ON s.tenant_id = x.tenant_id AND s.id = x.session_id
        WHERE x.tenant_id = ? AND x.person_id = ? AND x.status IN ('booked','attended') AND s.status <> 'cancelled' AND s.starts_at <= ?`, [t.id, b.person_id, b.starts_at])];
      const later = await one(pool, `SELECT COUNT(*) AS n FROM lesson_bookings x JOIN lesson_sessions s ON s.tenant_id = x.tenant_id AND s.id = x.session_id
        WHERE x.tenant_id = ? AND x.person_id = ? AND x.status = 'booked' AND s.status = 'scheduled' AND s.starts_at > ?`, [t.id, b.person_id, b.starts_at]);
      await pool.query('UPDATE lesson_bookings SET followup_sent_at = NOW() WHERE tenant_id = ? AND id = ?', [t.id, b.id]);
      if (Number(n) > 2 || Number(later.n) > 0) continue;
      let email = b.contact_email;
      if (!email && b.request_id) email = (await one(pool, 'SELECT contact_email FROM lesson_requests WHERE tenant_id = ? AND id = ?', [t.id, b.request_id]) || {}).contact_email;
      email = email || b.person_email;
      if (!email && !b.contact_phone) continue;
      const link = `${base}/book/${encodeURIComponent(t.slug)}`;
      const what = b.discipline === 'snowboard' ? 'ride' : 'ski';
      await notify({ tenant: t, to: { email, phone: b.contact_phone, textOk: Boolean(b.text_ok) }, tag: 'lesson-followup',
        subject: `${b.first_name}'s next lesson at ${t.name}`,
        text: [`Hi,`, '', `${b.first_name} did great at ${t.name}. The next lesson is where it all clicks.`, `Book ${b.first_name}'s next lesson here: ${link}`, '', `See you on the snow,`, t.name].join('\n'),
        smsText: `${t.name}: ready for ${b.first_name}'s next lesson? Keep the ${what === 'ride' ? 'riding' : 'skiing'} going: ${link}` });
      sent += 1;
    }
  }
  return sent;
}

module.exports = {
  FAMILY_DEFAULTS, familySchema, familySettings, saveFamilySettings, DEFAULT_TIP_POLICY, productExtras, fits, agesWords, afterConfirm, extraLine, priceExtras,
  fulfilBasket, handleWebhook, markTipPaid, checkTip, bookingByToken, plusMinutes, checkinOpen, moveChoices, heldSpots, policyNow, progressCard, nextSteps,
  familyView, updateDetails, moveBooking, cancelBooking, followups, firstOf, seasonFor,
};
