'use strict';

// Online lesson requests: pricing them, the cancellation policy, and turning a request into people, waivers, bookings
// and (when it was paid by card) a real sale in the books. Used by staff confirming a request and by the payment webhook.
const { ON_FILE } = require('./waivers');
const crypto = require('crypto');
const { one } = require('../db');
const { unitPrice } = require('./pricing');
const { loadRules, applyTax } = require('./tax');
const { resolvePerson } = require('./customers');
const { addLink, isMinor, mayActAsGuardian } = require('./family');
const { seasonFor, todayIn } = require('./util');
const { conflict, bad } = require('./errors');
const { audit } = require('./audit');
const { studentClash, clashWords } = require('./lessonrules');

/** Which guest type a student is priced as, by age on the day of the lesson (the mountain's own types and ages). */
const tierFor = (db, tenantId, dob, day) => require('./guesttypes').forBirthday(db, tenantId, dob, day);

/** What the request costs: each student priced by age, tax added by the mountain's rules. */
async function quoteFor(conn, tenantId, session, students) {
  const day = session.starts_at.slice(0, 10);
  const priced = [];
  for (const st of students) {
    const tier = await tierFor(conn, tenantId, st.date_of_birth, day);
    const { product, cents } = await unitPrice(conn, tenantId, session.product_id, tier, day);
    priced.push({ type: 'lesson', unit: cents, cents, tier, name: product.name });
  }
  const { tax, taxes } = applyTax(priced, 0, await loadRules(conn, tenantId));
  const subtotal = priced.reduce((n, p) => n + p.cents, 0);
  return { lines: priced.map((p) => ({ tier: p.tier, unit: p.unit, tax: p.tax })), subtotal, tax, taxes, total: subtotal + tax, name: priced[0] ? priced[0].name : '' };
}

/** Hours from `nowLocal` ('YYYY-MM-DD HH:MM:SS') to the lesson start, both in the mountain's wall-clock time. */
const hoursUntil = (startsAt, nowLocal) => (new Date(`${startsAt.slice(0, 19).replace(' ', 'T')}Z`) - new Date(`${nowLocal.replace(' ', 'T')}Z`)) / 3_600_000;

/** The refund a guest gets for canceling now: { percent, ... } under the mountain's tiers. */
function refundPercent(tenant, hoursLeft) {
  if (hoursLeft >= tenant.refund_full_hours) return 100;
  if (hoursLeft >= tenant.refund_half_hours) return tenant.refund_half_percent;
  return 0;
}

/** The cancellation policy in words, for the booking page. */
function policyText(t) {
  const lines = [`Cancel at least ${t.refund_full_hours} hours before the lesson starts for a full refund.`];
  if (t.refund_half_percent > 0 && t.refund_half_hours < t.refund_full_hours) lines.push(`Cancel between ${t.refund_half_hours} and ${t.refund_full_hours} hours before for a ${t.refund_half_percent}% refund.`);
  lines.push(`Cancel less than ${t.refund_half_percent > 0 && t.refund_half_hours < t.refund_full_hours ? t.refund_half_hours : t.refund_full_hours} hours before, or miss the lesson, and there is no refund.`);
  lines.push('If the mountain cancels a lesson (for weather or safety) you get a full refund.');
  if (t.cancel_note) lines.push(t.cancel_note);
  return lines;
}

/** The same policy as numbers, for drawing it: each tier starts at `from_hours` before the lesson. */
function policyTiers(t) {
  const tiers = [{ from_hours: t.refund_full_hours, percent: 100 }];
  if (t.refund_half_percent > 0 && t.refund_half_hours < t.refund_full_hours) tiers.push({ from_hours: t.refund_half_hours, percent: t.refund_half_percent });
  tiers.push({ from_hours: 0, percent: 0 });
  return tiers;
}
const policyNotes = (t) => ['If the mountain cancels a lesson (for weather or safety), you get a full refund.', ...(t.cancel_note ? [t.cancel_note] : [])];

const parse = (r) => { let j = {}; try { j = JSON.parse(r.students); } catch (_) { /* keep empty */ } return { ...r, students: j.students || [], contact: j.contact || {}, quote: j.quote || null, waiver_accepted: Boolean(r.waiver_accepted) }; };

/**
 * Turns a pending (or paid-and-awaiting) request into people on file, waivers where the contact can legitimately sign,
 * and a booking per student. `paid` true means card payment was taken: the booking is not marked unpaid and a sale is
 * recorded. Throws a 409 if the lesson has no room.
 */
async function confirmRequest(conn, tenantId, raw, { paid = false, auditReq, paymentIntent = null, payee = { account: null, feeCents: 0 } } = {}) {
  const r = parse(raw);
  const s = await one(conn, 'SELECT * FROM lesson_sessions WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, raw.session_id]);
  if (s.status !== 'scheduled') throw conflict(`That lesson is ${s.status}`);
  const tenant = await one(conn, 'SELECT timezone, waiver_text, waiver_resign_id FROM tenants WHERE id = ?', [tenantId]);
  const day = s.starts_at.slice(0, 10);
  if (day < todayIn(tenant.timezone)) throw conflict('That lesson date has passed');
  const { n } = await one(conn, "SELECT COUNT(*) AS n FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND status IN ('booked','attended')", [tenantId, s.id]);
  if (s.capacity - Number(n) < r.students.length) throw conflict(`Only ${Math.max(s.capacity - Number(n), 0)} spot(s) left in that lesson`);
  const season = seasonFor(day);
  const sha = tenant.waiver_text ? crypto.createHash('sha256').update(tenant.waiver_text).digest('hex') : null;

  // After "ask everyone to sign again", a box ticked against the old wording no longer counts as a waiver.
  const acceptedOk = raw.waiver_accepted && !(tenant.waiver_resign_id && raw.waiver_text_sha !== sha);
  const c = r.contact;
  const contact = await contactPerson(conn, tenantId, { first_name: c.first_name, last_name: c.last_name, email: raw.contact_email, phone: raw.contact_phone });
  const waiverNeeded = [];
  const booked = [];
  for (const st of r.students) {
    const sameAsContact = st.first_name.toLowerCase() === String(c.first_name).toLowerCase() && st.last_name.toLowerCase() === String(c.last_name).toLowerCase();
    const minor = isMinor(st.date_of_birth, day);
    const details = { first_name: st.first_name, last_name: st.last_name, date_of_birth: st.date_of_birth, sex: st.sex };
    // The buyer's email is how we find the buyer's own record, so only the buyer gets it. Other adults get the contact
    // phone for the lesson roster (a phone only matches a record with the same first and last name).
    if (sameAsContact && !minor) { details.email = raw.contact_email; details.phone = raw.contact_phone; } else if (!minor) details.phone = raw.contact_phone;
    for (const k of ['height_in', 'weight_lb', 'boot_size', 'ability_level', 'discipline']) if (st[k] !== undefined && st[k] !== null && st[k] !== '') details[k] = st[k];
    // The mountain's mandatory lesson details are checked for the guest who booked; other students only give what the
    // booking form asks for, so a paid family booking is never refused for a missing email.
    const who = await resolvePerson(conn, tenantId, { personId: sameAsContact && !minor ? contact.id : undefined, details, scope: sameAsContact ? 'lesson' : 'none', source: 'online', fillOnly: true });
    if (!who.id) throw bad(`Could not save ${st.first_name} ${st.last_name}`);
    const guardianOk = minor && await mayActAsGuardian(conn, tenantId, contact.id, who.id, who.created);
    if (guardianOk) await addLink(conn, tenantId, contact.id, who.id, 'guardian');
    let waiver = await one(conn, ON_FILE, [tenantId, who.id, season]);
    if (!waiver && acceptedOk && (guardianOk || (sameAsContact && !minor)) && contact.id) {
      await conn.query("INSERT INTO waivers (tenant_id, person_id, season, kind, signed_by_person_id, signed_by_name, signer_relation, text_sha, method) VALUES (?, ?, ?, 'general', ?, ?, ?, ?, 'accepted_online')", [tenantId, who.id, season, contact.id, raw.contact_name, minor ? 'guardian' : 'self', raw.waiver_text_sha || sha]);
      waiver = { id: 1 };
    }
    if (!waiver) waiverNeeded.push(`${st.first_name} ${st.last_name}`);
    // Not in another lesson or a program meeting at the same time (Track CORE: lib/lessonrules, one rule for every way of booking).
    const clash = await studentClash(conn, tenantId, who.id, s.starts_at, s.ends_at, { ignoreSessionId: s.id });
    if (clash) throw conflict(`${st.first_name} ${st.last_name}: ${clashWords(clash)}`);
    const [b] = await conn.query(
      `INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status, unpaid, request_id) VALUES (?, ?, ?, 'booked', ?, ?)
       ON DUPLICATE KEY UPDATE status = IF(status = 'cancelled', 'booked', status), unpaid = IF(status = 'cancelled', VALUES(unpaid), unpaid), request_id = VALUES(request_id), id = LAST_INSERT_ID(id)`, [tenantId, s.id, who.id, paid ? 0 : 1, raw.id]);
    booked.push({ booking_id: b.insertId, person_id: who.id, name: `${st.first_name} ${st.last_name}`, tier: await tierFor(conn, tenantId, st.date_of_birth, day) });
  }

  let orderId = null;
  if (paid) {
    const q = r.quote;
    const [o] = await conn.query("INSERT INTO orders (tenant_id, person_id, user_id, status, subtotal_cents, discount_cents, tax_cents, total_cents, channel, payment_ref) VALUES (?, ?, NULL, 'paid', ?, 0, ?, ?, 'online', ?)", [tenantId, contact.id, q.subtotal, q.tax, q.total, paymentIntent]);
    orderId = o.insertId;
    for (const t of q.taxes) await conn.query('INSERT INTO order_taxes (tenant_id, order_id, name, rate_bps, amount_cents) VALUES (?, ?, ?, ?, ?)', [tenantId, orderId, t.name, t.rate_bps, t.amount_cents]);
    for (const [i, b] of booked.entries()) {
      await conn.query("INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, person_id, session_id, tier, quantity, unit_price_cents, valid_on, discount_cents, tax_cents) VALUES (?, ?, ?, 'lesson', ?, ?, ?, 1, ?, ?, 0, ?)",
        [tenantId, orderId, s.product_id, b.person_id, s.id, q.lines[i].tier, q.lines[i].unit, day, q.lines[i].tax || 0]);
    }
    await conn.query("INSERT INTO order_payments (tenant_id, order_id, tender, amount_cents, reference, processor, processor_account, platform_fee_cents) VALUES (?, ?, 'card', ?, ?, 'stripe', ?, ?)",
      [tenantId, orderId, q.total, paymentIntent, payee.account || null, payee.feeCents || 0]);
  }
  await conn.query("UPDATE lesson_requests SET status = 'confirmed', decided_at = NOW(), order_id = ?, payment_intent = COALESCE(?, payment_intent) WHERE tenant_id = ? AND id = ?", [orderId, paymentIntent, tenantId, raw.id]);
  await audit(conn, auditReq || { auth: { tenantId, userId: null } }, paid ? 'confirm_paid' : 'confirm', 'lesson_requests', raw.id, { students: booked.length, order_id: orderId });
  return { ok: true, booked, waiver_needed: waiverNeeded, contact: { name: raw.contact_name, email: raw.contact_email, phone: raw.contact_phone }, reference: raw.reference, order_id: orderId };
}

/** The person who made the request, found by email or by name and phone, otherwise added. Only their name and contact details are needed. */
async function contactPerson(conn, tenantId, d) {
  const key = String(d.phone || '').replace(/\D/g, '').slice(-10);
  let p = await one(conn, 'SELECT id FROM people WHERE tenant_id = ? AND email = ? AND first_name = ? AND last_name = ? ORDER BY id LIMIT 1', [tenantId, d.email, d.first_name, d.last_name]);
  if (!p && key.length >= 7) p = await one(conn, 'SELECT id FROM people WHERE tenant_id = ? AND first_name = ? AND last_name = ? AND phone_key = ? ORDER BY id LIMIT 1', [tenantId, d.first_name, d.last_name, key]);
  if (p) return p;
  const [r] = await conn.query("INSERT INTO people (tenant_id, first_name, last_name, email, phone, source) VALUES (?, ?, ?, ?, ?, 'online')", [tenantId, d.first_name, d.last_name, d.email, d.phone]);
  return { id: r.insertId };
}

module.exports = { tierFor, quoteFor, hoursUntil, refundPercent, policyText, policyTiers, policyNotes, parse, confirmRequest, contactPerson };
