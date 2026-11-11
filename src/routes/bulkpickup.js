'use strict';

// Bulk trash pickup (muni release 1, the Trash and recycling app). See lib/bulkpickup.js for the rules.
// Staff side, mounted at /solid-waste (signed in, the solidwaste app on):
//   GET  /today                      the Today cards
//   GET  /options                    what the booking form needs: sizes, streets, the next collection days
//   GET  /settings, PUT /settings    collection days, cutoff, stops a day, sizes, payment options, rules (managers)
//   POST /skip-dates, DELETE /skip-dates/:id   days with no pickup
//   GET  /day?date=                  the stop list for a collection day, counts by size and by outcome
//   GET  /bookings, GET /bookings/:id, POST /bookings (a phone or walk-in booking)
//   POST /bookings/:id/cancel | paid | refund-given | send-link | photos | outcome | decision
//   GET  /bookings/:id/photos/:photoId   the photo as taken, with its SHA-256
//   GET  /report, GET /export        numbers by month; the bookings as a spreadsheet (no contact details unless a manager asks)
// Public side: the page is /bulk-pickup/<slug>; its API is /public/<slug>/bulk-pickup (no sign-in; the page and its booking link):
//   GET  /:slug/bulk-pickup          the page: sizes, streets, collection days, how to pay, the rules
//   POST /:slug/bulk-pickup/bookings
//   GET  /:slug/bulk-pickup/bookings/:token, POST .../cancel, POST .../pay
const crypto = require('crypto');
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, dateStr, timeStr, validate, paramId, todayIn, nowIn, addDays } = require('../lib/util');
const { notFound, conflict, bad, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { baseUrl } = require('../lib/baseurl');
const { card, todayRoute } = require('../lib/today');
const { photoFacts, sniff } = require('../lib/exif');
const { money } = require('../lib/format');
const { toCsv, dollars } = require('../lib/csv');
const RES = require('../lib/residents');
const { upsertResident } = RES;
const B = require('../lib/bulkpickup');

const router = express.Router();
const publicRouter = express.Router();
const office = requireRole('manager', 'counter');
const crew = requireRole('manager', 'staff');
const anyone = requireRole('manager', 'counter', 'staff');
const managers = requireRole('manager');
const isOffice = (req) => ['owner', 'manager', 'counter'].includes(req.auth.role);
const isManagerRole = (req) => ['owner', 'manager'].includes(req.auth.role);
const MAX_PHOTO = 15 * 1024 * 1024; // a phone photo at full size is 2 to 8 MB
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const townOf = (tenantId) => one(pool, 'SELECT id, name, slug, phone, timezone FROM tenants WHERE id = ?', [tenantId]);
const streetsOf = (db, tenantId) => rows(db, 'SELECT id, name FROM streets WHERE tenant_id = ? AND active = 1 ORDER BY name', [tenantId]);
const n = (v) => Number(v || 0);

/** A booking as staff see it (contact details only for the office: managers and the front desk). */
function staffShape(b, items, req) {
  const out = {
    id: b.id, reference: b.reference, collection_date: String(b.collection_date).slice(0, 10), street_id: b.street_id, street: b.street, house_number: b.house_number, unit: b.unit,
    address: B.addressOf(b), items: items.filter((i) => i.booking_id === b.id).map((i) => ({ size_id: i.size_id, name: i.name, quantity: i.quantity, unit_cents: i.unit_cents })),
    items_note: b.items_note, source: b.source, status: b.status, pay_method: b.pay_method, pay_status: b.pay_status, total_cents: b.total_cents, paid_cents: b.paid_cents,
    refunded_cents: b.refunded_cents, outcome: b.outcome, outcome_reason: b.outcome_reason, outcome_at: b.outcome_at, outcome_photo_id: b.outcome_photo_id,
    notified_via: b.notified_via, decision: b.decision, decision_cents: b.decision_cents, decision_note: b.decision_note, credit_used: Boolean(b.credit_used_by_id),
    reminded: Boolean(b.reminded_at), created_at: b.created_at, cancel_reason: b.cancel_reason,
  };
  if (isOffice(req)) Object.assign(out, { name: b.name, phone: b.phone, email: b.email, texts_ok: Boolean(b.texts_ok), emails_ok: Boolean(b.emails_ok) });
  return out;
}
async function listShaped(req, list) {
  const items = await B.itemsOf(pool, req.auth.tenantId, list.map((b) => b.id));
  return list.map((b) => staffShape(b, items, req));
}
async function bookingOf(db, tenantId, id, { lock = false } = {}) {
  const b = await one(db, `SELECT * FROM bulk_bookings WHERE tenant_id = ? AND id = ?${lock ? ' FOR UPDATE' : ''}`, [tenantId, id]);
  if (!b) throw notFound('Booking');
  return b;
}

// ---------------------------------------------------------------- Today
router.get('/today', todayRoute(async (req) => {
  const t = await townOf(req.auth.tenantId);
  const s = await B.settingsOf(t.id);
  const today = todayIn(t.timezone);
  const cards = [];
  const days = await B.calendar(pool, t.id, s, t.timezone, { days: 21 });
  const isToday = days.find((d) => d.date === today && !d.skipped);
  if (isToday) {
    const c = await one(pool, `SELECT COUNT(*) AS stops, SUM(outcome = 'picked_up') AS done, SUM(outcome = 'not_out') AS not_out, SUM(outcome = 'not_accepted') AS not_accepted
      FROM bulk_bookings WHERE tenant_id = ? AND collection_date = ? AND status = 'booked'`, [t.id, today]);
    const left = n(c.stops) - n(c.done) - n(c.not_out) - n(c.not_accepted);
    cards.push(card({ title: 'Bulk pickup today', count: n(c.stops), text: n(c.stops) ? `${n(c.done)} picked up, ${n(c.not_out)} not out${n(c.not_accepted) ? `, ${n(c.not_accepted)} not accepted` : ''}, ${left} to go` : 'No stops booked today', href: `#/bulk?tab=day&date=${today}` }));
  }
  const next = days.find((d) => d.date > today && !d.skipped);
  if (next) {
    cards.push(card({ title: `Next bulk pickup: ${B.longDay(next.date)}`, count: next.booked, text: `${next.booked} of ${next.capacity} stops booked, ${next.left} open${next.closed ? '. Booking has closed' : `. Booking closes ${B.cutoffWords(next.cutoff_at)}`}`, href: `#/bulk?tab=day&date=${next.date}` }));
  }
  return cards;
}));

// ---------------------------------------------------------------- settings
const sizeSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(1, 'Give each size a name').max(40),
  description: z.string().trim().max(255).optional().nullable(),
  price_cents: z.number().int().min(0).max(100000),
  max_qty: z.number().int().min(1).max(20),
  active: z.boolean().default(true),
});
const settingsSchema = z.object({
  online: z.boolean(),
  collection_days: z.array(z.number().int().min(0).max(6)).min(1, 'Pick at least one collection day').max(7),
  cutoff_days_before: z.number().int().min(1).max(7),
  cutoff_time: timeStr,
  capacity: z.number().int().min(1).max(2000),
  curb_by: timeStr,
  pay_card: z.boolean(),
  pay_stickers: z.boolean(),
  office_name: z.string().trim().min(2).max(80),
  rules_text: z.string().trim().max(4000).optional().nullable(),
  not_out_policy: z.enum(['no_refund', 'credit', 'refund']),
  sizes: z.array(sizeSchema).min(1, 'Keep at least one item size').max(12),
}).refine((b) => b.pay_card || b.pay_stickers, { message: 'Turn on card payment, stickers, or both', path: ['pay_card'] });

async function settingsView(req) {
  const t = await townOf(req.auth.tenantId);
  const s = await B.settingsOf(t.id);
  const sizes = await B.sizesOf(pool, t.id, { all: true });
  const skips = await rows(pool, 'SELECT id, on_date, note FROM bulk_skip_dates WHERE tenant_id = ? AND on_date >= ? ORDER BY on_date LIMIT 200', [t.id, todayIn(t.timezone)]);
  const stripe = await require('../lib/connect').state(t.id);
  return { ...s, sizes, skip_dates: skips.map((x) => ({ ...x, on_date: String(x.on_date).slice(0, 10) })), card_ready: await B.cardReady(t.id), stripe_status: stripe.status,
    page: B.pageLink(baseUrl(req), t.slug) };
}
router.get('/settings', managers, async (req, res) => res.json(await settingsView(req)));
router.put('/settings', managers, validate(settingsSchema), async (req, res) => {
  const b = req.body; const t = req.auth.tenantId;
  await B.settingsOf(t);
  await tx(async (conn) => {
    await conn.query(`UPDATE bulk_settings SET online = ?, collection_days = ?, cutoff_days_before = ?, cutoff_time = ?, capacity = ?, curb_by = ?, pay_card = ?, pay_stickers = ?,
        office_name = ?, rules_text = ?, not_out_policy = ?, updated_by = ? WHERE tenant_id = ?`,
    [b.online ? 1 : 0, [...new Set(b.collection_days)].sort().join(','), b.cutoff_days_before, b.cutoff_time, b.capacity, b.curb_by, b.pay_card ? 1 : 0, b.pay_stickers ? 1 : 0,
      b.office_name, b.rules_text || null, b.not_out_policy, req.auth.userId, t]);
    const have = new Map((await rows(conn, 'SELECT id FROM bulk_sizes WHERE tenant_id = ?', [t])).map((x) => [Number(x.id), true]));
    const kept = new Set();
    for (const [i, z1] of b.sizes.entries()) {
      if (z1.id) {
        if (!have.has(z1.id)) throw notFound('Item size');
        await conn.query('UPDATE bulk_sizes SET name = ?, description = ?, price_cents = ?, max_qty = ?, active = ?, sort = ? WHERE tenant_id = ? AND id = ?', [z1.name, z1.description || null, z1.price_cents, z1.max_qty, z1.active ? 1 : 0, i + 1, t, z1.id]);
        kept.add(z1.id);
      } else {
        await conn.query('INSERT INTO bulk_sizes (tenant_id, name, description, price_cents, max_qty, sort, active) VALUES (?, ?, ?, ?, ?, ?, ?)', [t, z1.name, z1.description || null, z1.price_cents, z1.max_qty, i + 1, z1.active ? 1 : 0]);
      }
    }
    // A size left out is switched off, never deleted: bookings already made name it.
    for (const id of have.keys()) if (!kept.has(id)) await conn.query('UPDATE bulk_sizes SET active = 0 WHERE tenant_id = ? AND id = ?', [t, id]);
    if (!(await one(conn, 'SELECT id FROM bulk_sizes WHERE tenant_id = ? AND active = 1 LIMIT 1', [t]))) throw bad('Keep at least one item size switched on');
    await audit(conn, req, 'bulk_settings', 'bulk_settings', null, { collection_days: b.collection_days, cutoff_days_before: b.cutoff_days_before, cutoff_time: b.cutoff_time, capacity: b.capacity, pay_card: b.pay_card, pay_stickers: b.pay_stickers, not_out_policy: b.not_out_policy, sizes: b.sizes.map((x) => ({ name: x.name, price_cents: x.price_cents, active: x.active })) });
  });
  res.json(await settingsView(req));
});
router.post('/skip-dates', managers, validate(z.object({ on_date: dateStr, note: z.string().trim().max(120).optional() })), async (req, res) => {
  const [r] = await pool.query('INSERT INTO bulk_skip_dates (tenant_id, on_date, note) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE note = VALUES(note), id = LAST_INSERT_ID(id)', [req.auth.tenantId, req.body.on_date, req.body.note || null]);
  const booked = await one(pool, "SELECT COUNT(*) AS n FROM bulk_bookings WHERE tenant_id = ? AND collection_date = ? AND status IN ('booked','awaiting_payment')", [req.auth.tenantId, req.body.on_date]);
  await audit(pool, req, 'bulk_skip_date', 'bulk_skip_dates', r.insertId, { on_date: req.body.on_date });
  res.status(201).json({ id: r.insertId, booked_that_day: n(booked.n) });
});
router.delete('/skip-dates/:id', managers, async (req, res) => {
  const [r] = await pool.query('DELETE FROM bulk_skip_dates WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Skip date');
  await audit(pool, req, 'bulk_skip_date_removed', 'bulk_skip_dates', paramId(req));
  res.json({ ok: true });
});

// ---------------------------------------------------------------- what the booking form needs
router.get('/options', anyone, async (req, res) => {
  const t = await townOf(req.auth.tenantId);
  const s = await B.settingsOf(t.id);
  res.json({ sizes: await B.sizesOf(pool, t.id), streets: await streetsOf(pool, t.id), days: await B.calendar(pool, t.id, s, t.timezone, { days: 42 }), card_ready: await B.cardReady(t.id),
    office_name: s.office_name, pay_card: s.pay_card, pay_stickers: s.pay_stickers, today: todayIn(t.timezone) });
});

// ---------------------------------------------------------------- the collection day
const STOP_ORDER = 'ORDER BY s.name, CAST(b.house_number AS UNSIGNED), b.house_number, b.unit, b.id';
// The name, phone and email are the ones given for this booking (never rewritten from a resident record).
const FULL = `SELECT b.*, s.name AS street, b.contact_name AS name, b.contact_phone AS phone, b.contact_email AS email FROM bulk_bookings b JOIN streets s ON s.tenant_id = b.tenant_id AND s.id = b.street_id`;

router.get('/day', anyone, async (req, res) => {
  const t = await townOf(req.auth.tenantId);
  const s = await B.settingsOf(t.id);
  const today = todayIn(t.timezone);
  let date = String(req.query.date || '');
  if (date && !dateStr.safeParse(date).success) throw bad('date must be YYYY-MM-DD');
  const cal = await B.calendar(pool, t.id, s, t.timezone, { days: 42 });
  if (!date) date = (cal.find((d) => !d.skipped) || { date: today }).date;
  const list = await rows(pool, `${FULL} WHERE b.tenant_id = ? AND b.collection_date = ? AND b.status = 'booked' ${STOP_ORDER}`, [t.id, date]);
  const stops = await listShaped(req, list);
  const bySize = new Map();
  for (const st of stops) for (const i of st.items) bySize.set(i.name, (bySize.get(i.name) || 0) + i.quantity);
  const skip = await one(pool, 'SELECT note FROM bulk_skip_dates WHERE tenant_id = ? AND on_date = ?', [t.id, date]);
  const count = (o) => stops.filter((x) => x.outcome === o).length;
  res.json({
    date, today, collection_day: s.collection_days.includes(require('../lib/util').weekdayOf(date)), skipped: Boolean(skip), skip_note: skip ? skip.note : null, capacity: s.capacity,
    cutoff_at: B.cutoffOf(s, date), curb_by: s.curb_by, stops, sizes: [...bySize].map(([name, quantity]) => ({ name, quantity })),
    outcomes: { picked_up: count('picked_up'), not_out: count('not_out'), not_accepted: count('not_accepted'), left: stops.filter((x) => !x.outcome).length },
    days: cal.map((d) => ({ date: d.date, booked: d.booked, skipped: d.skipped })),
  });
});

// ---------------------------------------------------------------- bookings
router.get('/bookings', anyone, async (req, res) => {
  const t = await townOf(req.auth.tenantId);
  const where = ['b.tenant_id = ?']; const params = [t.id];
  const show = String(req.query.show || 'upcoming');
  if (show === 'upcoming') { where.push("b.collection_date >= ? AND b.status IN ('booked','awaiting_payment')"); params.push(todayIn(t.timezone)); }
  else if (show === 'cancelled') where.push("b.status IN ('cancelled','expired')");
  else if (show === 'not_out') where.push("b.outcome IN ('not_out','not_accepted')");
  else if (show === 'unpaid') where.push("b.status = 'booked' AND b.pay_status IN ('due','refund_due')");
  else if (show !== 'all') throw bad('show must be upcoming, cancelled, not_out, unpaid or all');
  if (req.query.date) { if (!dateStr.safeParse(String(req.query.date)).success) throw bad('date must be YYYY-MM-DD'); where.push('b.collection_date = ?'); params.push(String(req.query.date)); }
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, '')}%`;
    const digits = q.replace(/\D/g, '');
    const parts = ['b.reference = ?', "CONCAT(b.house_number, ' ', s.name) LIKE ?", 's.name LIKE ?'];
    params.push(q.toUpperCase(), like, like);
    if (isOffice(req)) {
      parts.push('b.contact_name LIKE ?', 'b.contact_email LIKE ?'); params.push(like, like);
      if (digits.length >= 4) { parts.push("REGEXP_REPLACE(b.contact_phone, '[^0-9]', '') LIKE ?"); params.push(`%${digits}%`); }
    }
    where.push(`(${parts.join(' OR ')})`);
  }
  const list = await rows(pool, `${FULL} WHERE ${where.join(' AND ')} ORDER BY b.collection_date ${show === 'upcoming' ? 'ASC' : 'DESC'}, s.name, CAST(b.house_number AS UNSIGNED) LIMIT 300`, params);
  res.json({ data: await listShaped(req, list) });
});

router.get('/bookings/:id', anyone, async (req, res) => {
  const t = req.auth.tenantId;
  const b = await one(pool, `${FULL} WHERE b.tenant_id = ? AND b.id = ?`, [t, paramId(req)]);
  if (!b) throw notFound('Booking');
  const [shaped] = await listShaped(req, [b]);
  const photos = await rows(pool, 'SELECT id, mime, bytes, sha256, taken_at, taken_from, taken_lat, taken_lng, uploaded_at FROM bulk_photos WHERE tenant_id = ? AND booking_id = ? ORDER BY id', [t, b.id]);
  const out = { ...shaped, photos, outcome_lat: b.outcome_lat === null ? null : Number(b.outcome_lat), outcome_lng: b.outcome_lng === null ? null : Number(b.outcome_lng) };
  if (isOffice(req)) {
    const slug = (await townOf(t)).slug;
    out.link = B.viewLink(baseUrl(req), slug, b.view_token);
    if (b.credit_from_id) out.credit_from = (await one(pool, 'SELECT reference FROM bulk_bookings WHERE tenant_id = ? AND id = ?', [t, b.credit_from_id]) || {}).reference || null;
  }
  res.json(out);
});

const contactShape = {
  name: z.string().trim().min(2, 'Give the resident’s name').max(120),
  phone: z.string().trim().max(40).optional().nullable(),
  email: z.string().trim().toLowerCase().email('Check the email address').max(255).optional().nullable().or(z.literal('')),
  texts_ok: z.boolean().default(false),
  emails_ok: z.boolean().default(false),
};
const bookingShape = {
  collection_date: dateStr,
  street_id: z.number().int().positive(),
  house_number: z.string().trim().min(1, 'Give the house number').max(20).regex(/^[0-9A-Za-z][0-9A-Za-z \-/½]*$/, 'Use the house number only, like 120 or 120A'),
  unit: z.string().trim().max(20).optional().nullable(),
  items: z.array(z.object({ size_id: z.number().int().positive(), quantity: z.number().int().min(0).max(20) })).min(1).max(12),
  items_note: z.string().trim().max(300).optional().nullable(),
  ...contactShape,
};
/** Checks the contact rules shared by both booking forms; returns the phone and email to keep. */
function contactOf(b) {
  const sms = require('../lib/sms');
  const phone = b.phone ? b.phone.trim() : null; const email = b.email ? b.email.trim() : null;
  if (!phone && !email) throw bad('Give a phone number or an email address, so you can be reached about the pickup');
  if (phone && !sms.phoneKey(phone)) throw bad('Check the phone number: use a 10-digit US number');
  if (b.texts_ok && !phone) throw bad('Give a phone number to get texts');
  if (b.emails_ok && !email) throw bad('Give an email address to get emails');
  return { phone, email };
}
const streetOk = async (conn, tenantId, id) => { if (!(await one(conn, 'SELECT id FROM streets WHERE tenant_id = ? AND id = ? AND active = 1', [tenantId, id]))) throw bad('Pick a street from the list'); };

router.post('/bookings', office, validate(z.object({
  ...bookingShape,
  pay: z.enum(['office_paid', 'office_due', 'stickers', 'link', 'credit']),
  link_by: z.enum(['text', 'email']).optional(),
  credit_ref: z.string().trim().toUpperCase().max(8).optional(),
  override: z.boolean().default(false), // book a day that is closed or full (staff decide)
})), async (req, res) => {
  const b = req.body; const t = await townOf(req.auth.tenantId);
  const { phone, email } = contactOf(b);
  if (b.pay === 'link') {
    if (!(await B.cardReady(t.id))) throw conflict('Card payment is not set up. Connect Stripe under Settings, Payments, or take payment at the office.');
    if (!b.link_by) throw bad('Choose how to send the payment link: text or email');
    if (b.link_by === 'text' && !(phone && b.texts_ok)) throw bad('To text the link, give a phone number and tick that they agree to texts');
    if (b.link_by === 'email' && !email) throw bad('To email the link, give an email address');
  }
  const made = await tx(async (conn) => {
    await B.lockDay(conn, t.id);
    const s = await B.settingsOf(t.id, conn);
    await streetOk(conn, t.id, b.street_id);
    const day = (await B.calendar(conn, t.id, s, t.timezone, { days: 120 })).find((d) => d.date === b.collection_date);
    const why = B.whyNot(day);
    if (why && !(b.override && day && !day.skipped)) throw conflict(why, { code: 'day_not_open', can_override: Boolean(day && !day.skipped) });
    const q = await B.price(conn, t.id, b.items);
    let pay = { pay_method: 'office', pay_status: 'due', paid_cents: 0 };
    let creditFrom = null;
    if (q.total === 0) pay = { pay_method: 'free', pay_status: 'not_needed', paid_cents: 0 };
    else if (b.pay === 'office_paid') pay = { pay_method: 'office', pay_status: 'paid', paid_cents: q.total };
    else if (b.pay === 'stickers') pay = { pay_method: 'stickers', pay_status: 'not_needed', paid_cents: 0 };
    else if (b.pay === 'link') pay = { pay_method: 'card', pay_status: 'due', paid_cents: 0 };
    else if (b.pay === 'credit') {
      const c = await one(conn, "SELECT id, decision_cents FROM bulk_bookings WHERE tenant_id = ? AND reference = ? AND decision = 'credit' AND credit_used_by_id IS NULL FOR UPDATE", [t.id, b.credit_ref || '']);
      if (!c) throw bad('No unused credit has that reference. Check it on the earlier booking.');
      if (n(c.decision_cents) < q.total) throw conflict(`That credit is ${money(n(c.decision_cents))} and this pickup is ${money(q.total)}. Take the difference at the office as a separate booking, or pick fewer items.`);
      pay = { pay_method: 'credit', pay_status: 'paid', paid_cents: 0 };
      creditFrom = c.id;
    }
    const residentId = await upsertResident(conn, t.id, { name: b.name, phone, email, streetId: b.street_id, houseNumber: b.house_number, unit: b.unit || null, textsOk: b.texts_ok ? true : undefined, emailsOk: b.emails_ok ? true : undefined }, { source: 'bulk_pickup', userId: req.auth.userId });
    const out = await B.insertBooking(conn, t.id, { collection_date: b.collection_date, street_id: b.street_id, house_number: b.house_number, unit: b.unit, resident_id: residentId, items_note: b.items_note,
      contact_name: b.name, contact_phone: phone, contact_email: email, source: 'staff', status: 'booked', ...pay, total_cents: q.total, texts_ok: b.texts_ok, emails_ok: b.emails_ok, credit_from_id: creditFrom, created_by: req.auth.userId }, q.lines);
    if (creditFrom) await conn.query('UPDATE bulk_bookings SET credit_used_by_id = ? WHERE tenant_id = ? AND id = ?', [out.id, t.id, creditFrom]);
    await audit(conn, req, 'bulk_book', 'bulk_bookings', out.id, { reference: out.reference, collection_date: b.collection_date, total_cents: q.total, pay: b.pay, ...(why ? { override: why.slice(0, 120) } : {}) });
    return { ...out, total: q.total };
  });
  const base = baseUrl(req);
  let sent = [];
  if (b.pay === 'link') sent = await B.tell(t.id, made.id, 'pay_link', base, { receipt: true, only: b.link_by });
  else sent = await B.tell(t.id, made.id, 'confirm', base, { receipt: true });
  // The one STOP rule (lib/residents.js): ticking that they agree to texts does not undo a STOP the phone texted.
  const textsOff = b.texts_ok && phone ? await RES.textsOffNotice(pool, t.id, phone) : null;
  res.status(201).json({ id: made.id, reference: made.reference, total_cents: made.total, link: B.viewLink(base, t.slug, made.view_token), sent, ...(textsOff ? { texts_off: textsOff } : {}) });
});

router.post('/bookings/:id/send-link', office, validate(z.object({ by: z.enum(['text', 'email']) })), async (req, res) => {
  const b = await bookingOf(pool, req.auth.tenantId, paramId(req));
  if (!(b.pay_method === 'card' && b.pay_status === 'due' && b.status === 'booked')) throw conflict('Only a booking waiting for a card payment has a payment link');
  const sent = await B.tell(req.auth.tenantId, b.id, 'pay_link', baseUrl(req), { receipt: true, only: req.body.by });
  if (!sent.length) {
    const off = req.body.by === 'text' && b.contact_phone ? await RES.textsOffNotice(pool, req.auth.tenantId, b.contact_phone) : null;
    throw conflict(req.body.by === 'text' ? (off ? `${off} Read them the link instead.` : 'The text could not be sent. They may not have agreed to texts. Read them the link instead.') : 'The email could not be sent. Check the address, or read them the link instead.');
  }
  await audit(pool, req, 'bulk_send_link', 'bulk_bookings', b.id, { by: req.body.by });
  res.json({ sent });
});

router.post('/bookings/:id/paid', office, async (req, res) => {
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    const b = await bookingOf(conn, t, paramId(req), { lock: true });
    if (b.status !== 'booked' || b.pay_status !== 'due') throw conflict('This booking has nothing to pay');
    if (b.stripe_session_id) await require('../lib/stripe').expireCheckout(b.stripe_session_id, { account: b.processor_account || null });
    await conn.query("UPDATE bulk_bookings SET pay_method = 'office', pay_status = 'paid', paid_cents = total_cents, paid_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ?", [t, b.id]);
    await audit(conn, req, 'bulk_paid_office', 'bulk_bookings', b.id, { amount_cents: b.total_cents });
  });
  res.json({ ok: true });
});

router.post('/bookings/:id/refund-given', office, async (req, res) => {
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    const b = await bookingOf(conn, t, paramId(req), { lock: true });
    if (b.pay_status !== 'refund_due') throw conflict('No refund is waiting at the office for this booking');
    await conn.query("UPDATE bulk_bookings SET pay_status = 'refunded', refunded_cents = paid_cents WHERE tenant_id = ? AND id = ?", [t, b.id]);
    await audit(conn, req, 'bulk_refund_given', 'bulk_bookings', b.id, { amount_cents: b.paid_cents });
  });
  res.json({ ok: true });
});

/**
 * Cancels a booking. Before the cutoff a card payment goes back in full automatically, and money paid at the office is
 * waiting there. After the cutoff, money goes back only when a manager says so (refund: true).
 */
async function cancel(tenantId, id, { by, reason, refund = null, req = null }) {
  const t = await townOf(tenantId);
  let owed = null; let row;
  await tx(async (conn) => {
    const b = await bookingOf(conn, tenantId, id, { lock: true });
    if (!['booked', 'awaiting_payment'].includes(b.status)) throw conflict('This booking is already canceled');
    if (b.outcome) throw conflict('The crew has already been to this stop. Use a refund or credit decision instead.');
    const s = await B.settingsOf(tenantId, conn);
    const before = nowIn(t.timezone) < B.cutoffOf(s, String(b.collection_date).slice(0, 10));
    if (!before && by === 'resident') throw conflict(`Changes for ${B.longDay(b.collection_date)} closed ${B.cutoffWords(B.cutoffOf(s, String(b.collection_date).slice(0, 10)))}. Please call ${s.office_name}${t.phone ? ` at ${t.phone}` : ''}.`);
    const giveBack = before || refund === true;
    await conn.query("UPDATE bulk_bookings SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP(), cancelled_by = ?, cancel_reason = ? WHERE tenant_id = ? AND id = ?",
      [req ? req.auth.userId : null, reason || (by === 'resident' ? 'Canceled by the resident' : null), tenantId, b.id]);
    if (b.status === 'awaiting_payment' || (b.pay_method === 'card' && b.pay_status === 'due')) {
      if (b.stripe_session_id) await require('../lib/stripe').expireCheckout(b.stripe_session_id, { account: b.processor_account || null }); // a payment that still lands is refunded by the webhook
    }
    if (giveBack) {
      owed = await B.oweCardRefund(conn, { ...b, tenant_id: tenantId }, by === 'resident' ? 'canceled by the resident before the cutoff' : 'canceled by staff');
      if (b.pay_method === 'office' && b.pay_status === 'paid' && b.paid_cents > 0) await conn.query("UPDATE bulk_bookings SET pay_status = 'refund_due' WHERE tenant_id = ? AND id = ?", [tenantId, b.id]);
    }
    if (b.credit_from_id) await conn.query('UPDATE bulk_bookings SET credit_used_by_id = NULL WHERE tenant_id = ? AND id = ? AND credit_used_by_id = ?', [tenantId, b.credit_from_id, b.id]); // the credit can be used again
    await audit(conn, req || { auth: { tenantId, userId: null } }, 'bulk_cancel', 'bulk_bookings', b.id, { by, before_cutoff: before, refund: giveBack, reference: b.reference });
    row = await one(conn, 'SELECT pay_status, refunded_cents FROM bulk_bookings WHERE tenant_id = ? AND id = ?', [tenantId, b.id]);
  });
  await B.sendRefund(owed);
  return row;
}

router.post('/bookings/:id/cancel', office, validate(z.object({ reason: z.string().trim().max(200).optional(), refund: z.boolean().optional() })), async (req, res) => {
  if (req.body.refund === true && !isManagerRole(req)) {
    // After the cutoff only a manager gives money back; before it the refund is automatic for anyone.
    const b = await bookingOf(pool, req.auth.tenantId, paramId(req));
    const t = await townOf(req.auth.tenantId); const s = await B.settingsOf(t.id);
    if (nowIn(t.timezone) >= B.cutoffOf(s, String(b.collection_date).slice(0, 10))) throw forbidden('After the cutoff, only a manager can give a refund');
  }
  const row = await cancel(req.auth.tenantId, paramId(req), { by: 'staff', reason: req.body.reason, refund: req.body.refund ?? null, req });
  await B.tell(req.auth.tenantId, paramId(req), 'cancelled', baseUrl(req), { receipt: true });
  res.json({ ok: true, pay_status: row.pay_status, refunded_cents: row.refunded_cents });
});

// ---------------------------------------------------------------- the crew
/** A photo of the stop, exactly as taken (the body is the file). Query: lat, lng, taken_at from the phone, client_ref. */
router.post('/bookings/:id/photos', crew, express.raw({ type: () => true, limit: MAX_PHOTO }), async (req, res) => {
  const t = req.auth.tenantId;
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad('Take a photo first');
  const mime = sniff(buf);
  if (!mime) throw bad('That file is not a photo (JPEG, PNG, WebP or HEIC)');
  const q = z.object({ lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional(), client_ref: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/).optional() }).safeParse(req.query);
  if (!q.success) throw bad('Something about that photo upload was not right');
  const out = await tx(async (conn) => {
    const b = await bookingOf(conn, t, paramId(req), { lock: true });
    if (b.status !== 'booked') throw conflict('This booking is canceled');
    if (q.data.client_ref) {
      const seen = await one(conn, 'SELECT id, sha256 FROM bulk_photos WHERE tenant_id = ? AND client_ref = ?', [t, q.data.client_ref]);
      if (seen) return { id: seen.id, sha256: seen.sha256, repeat: true };
    }
    const facts = photoFacts(buf);
    const tz = (await townOf(t)).timezone;
    const now = nowIn(tz);
    const hash = sha(buf);
    const [r] = await conn.query(`INSERT INTO bulk_photos (tenant_id, booking_id, mime, bytes, sha256, original, taken_at, taken_from, taken_lat, taken_lng, client_ref, uploaded_by, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [t, b.id, mime, buf.length, hash, buf, facts.taken_at || now, facts.taken_at ? 'photo' : 'phone', facts.lat ?? q.data.lat ?? null, facts.lng ?? q.data.lng ?? null, q.data.client_ref || null, req.auth.userId, now]);
    await audit(conn, req, 'bulk_photo', 'bulk_bookings', b.id, { photo_id: r.insertId, sha256: hash, bytes: buf.length });
    return { id: r.insertId, sha256: hash };
  });
  res.status(out.repeat ? 200 : 201).json(out);
});

router.get('/bookings/:id/photos/:photoId', anyone, async (req, res) => {
  const t = req.auth.tenantId;
  const p = await one(pool, 'SELECT id, mime, sha256, original FROM bulk_photos WHERE tenant_id = ? AND booking_id = ? AND id = ?', [t, paramId(req), paramId(req, 'photoId')]);
  if (!p) throw notFound('Photo');
  await audit(pool, req, 'bulk_photo_view', 'bulk_bookings', paramId(req), { photo_id: p.id });
  res.set('Content-Type', p.mime).set('X-Content-SHA256', p.sha256).set('Cache-Control', 'no-store').send(p.original);
});

router.post('/bookings/:id/outcome', crew, validate(z.object({
  outcome: z.enum(['picked_up', 'not_out', 'not_accepted']),
  photo_id: z.number().int().positive().optional(),
  reason: z.string().trim().max(200).optional(),
  lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(),
})), async (req, res) => {
  const t = await townOf(req.auth.tenantId); const body = req.body;
  const tellKind = await tx(async (conn) => {
    const b = await bookingOf(conn, t.id, paramId(req), { lock: true });
    if (b.status !== 'booked') throw conflict('This booking is canceled');
    if (String(b.collection_date).slice(0, 10) > todayIn(t.timezone)) throw conflict(`This pickup is for ${B.longDay(b.collection_date)}. Mark it on that day.`);
    if (b.decision) throw conflict('A manager has already decided on this stop');
    if (body.outcome !== 'picked_up') {
      if (!body.photo_id) throw bad(body.outcome === 'not_out' ? 'Take a photo of the curb first' : 'Take a photo of what was left first');
      if (!(await one(conn, 'SELECT id FROM bulk_photos WHERE tenant_id = ? AND booking_id = ? AND id = ?', [t.id, b.id, body.photo_id]))) throw bad('That photo is not from this stop. Take it again.');
    }
    if (body.outcome === 'not_accepted' && !body.reason) throw bad('Say why the items could not be taken (for example: paint cans, tires)');
    await conn.query(`UPDATE bulk_bookings SET outcome = ?, outcome_reason = ?, outcome_at = ?, outcome_by = ?, outcome_lat = ?, outcome_lng = ?, outcome_photo_id = ? WHERE tenant_id = ? AND id = ?`,
      [body.outcome, body.outcome === 'picked_up' ? null : (body.reason || null), nowIn(t.timezone), req.auth.userId, body.lat ?? null, body.lng ?? null, body.outcome === 'picked_up' ? null : body.photo_id, t.id, b.id]);
    await audit(conn, req, 'bulk_outcome', 'bulk_bookings', b.id, { outcome: body.outcome, photo_id: body.photo_id || null, gps: body.lat !== undefined });
    // The resident is told once, the first time a stop is marked not out or not accepted.
    if (body.outcome === 'picked_up' || b.notified_at) return null;
    const [claim] = await conn.query('UPDATE bulk_bookings SET notified_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ? AND notified_at IS NULL', [t.id, b.id]);
    return claim.affectedRows ? body.outcome : null;
  });
  let told = [];
  if (tellKind) {
    told = await B.tell(t.id, paramId(req), tellKind, baseUrl(req));
    await pool.query('UPDATE bulk_bookings SET notified_via = ? WHERE tenant_id = ? AND id = ?', [told.length ? told.join(',') : 'none', t.id, paramId(req)]);
  }
  res.json({ ok: true, told });
});

/** A manager decides what a not-out or not-accepted stop gets: nothing, its money back, or a credit for another pickup. */
router.post('/bookings/:id/decision', managers, validate(z.object({ decision: z.enum(['no_refund', 'refund', 'credit']), note: z.string().trim().max(200).optional() })), async (req, res) => {
  const t = req.auth.tenantId; const d = req.body.decision;
  let owed = null;
  const out = await tx(async (conn) => {
    const b = await bookingOf(conn, t, paramId(req), { lock: true });
    if (!['not_out', 'not_accepted'].includes(b.outcome)) throw conflict('A decision is only for a stop the crew marked Not out or Not accepted');
    if (b.decision) throw conflict('This stop already has a decision');
    let cents = 0;
    if (d === 'refund') {
      if (!(b.pay_status === 'paid' && b.paid_cents > 0) || b.pay_method === 'credit') throw conflict('Nothing was paid for this pickup, so there is nothing to refund. Choose a credit instead.');
      cents = b.paid_cents;
      if (b.pay_method === 'card') owed = await B.oweCardRefund(conn, { ...b, tenant_id: t }, 'not-out refund decided by a manager');
      else await conn.query("UPDATE bulk_bookings SET pay_status = 'refund_due' WHERE tenant_id = ? AND id = ?", [t, b.id]);
    } else if (d === 'credit') cents = b.total_cents;
    await conn.query('UPDATE bulk_bookings SET decision = ?, decision_cents = ?, decision_note = ?, decided_by = ?, decided_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ?', [d, cents, req.body.note || null, req.auth.userId, t, b.id]);
    await audit(conn, req, 'bulk_decision', 'bulk_bookings', b.id, { decision: d, amount_cents: cents, outcome: b.outcome });
    return { decision: d, decision_cents: cents, reference: b.reference };
  });
  await B.sendRefund(owed);
  res.json(out);
});

// ---------------------------------------------------------------- report and export
router.get('/report', managers, async (req, res) => {
  const t = await townOf(req.auth.tenantId);
  const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 36);
  const today = todayIn(t.timezone);
  const from = `${addDays(`${today.slice(0, 7)}-01`, -31 * (months - 1)).slice(0, 7)}-01`;
  const data = await rows(pool, `SELECT DATE_FORMAT(b.collection_date, '%Y-%m') AS month,
      COUNT(*) AS bookings,
      SUM(b.source = 'online') AS online,
      COALESCE(SUM((SELECT SUM(i.quantity) FROM bulk_booking_items i WHERE i.tenant_id = b.tenant_id AND i.booking_id = b.id)), 0) AS items,
      SUM(b.outcome = 'picked_up') AS picked_up, SUM(b.outcome = 'not_out') AS not_out, SUM(b.outcome = 'not_accepted') AS not_accepted,
      SUM(CASE WHEN b.pay_method = 'card' THEN b.paid_cents ELSE 0 END) AS card_cents,
      SUM(CASE WHEN b.pay_method = 'office' THEN b.paid_cents ELSE 0 END) AS office_cents,
      SUM(b.refunded_cents) AS refunded_cents,
      SUM(b.pay_method = 'stickers') AS stickers
    FROM bulk_bookings b WHERE b.tenant_id = ? AND b.status = 'booked' AND b.collection_date >= ? GROUP BY month ORDER BY month DESC`, [t.id, from]);
  const sizes = await rows(pool, `SELECT DATE_FORMAT(b.collection_date, '%Y-%m') AS month, i.name, SUM(i.quantity) AS quantity FROM bulk_booking_items i
      JOIN bulk_bookings b ON b.tenant_id = i.tenant_id AND b.id = i.booking_id WHERE b.tenant_id = ? AND b.status = 'booked' AND b.collection_date >= ? GROUP BY month, i.name ORDER BY month, i.name`, [t.id, from]);
  const cancelled = await rows(pool, "SELECT DATE_FORMAT(collection_date, '%Y-%m') AS month, COUNT(*) AS n FROM bulk_bookings WHERE tenant_id = ? AND status = 'cancelled' AND collection_date >= ? GROUP BY month", [t.id, from]);
  const out = data.map((m) => {
    const visited = n(m.picked_up) + n(m.not_out) + n(m.not_accepted);
    return {
      month: m.month, bookings: n(m.bookings), online: n(m.online), items: n(m.items), picked_up: n(m.picked_up), not_out: n(m.not_out), not_accepted: n(m.not_accepted), stickers: n(m.stickers),
      cancelled: n((cancelled.find((c) => c.month === m.month) || {}).n),
      card_cents: n(m.card_cents), office_cents: n(m.office_cents), refunded_cents: n(m.refunded_cents), revenue_cents: n(m.card_cents) + n(m.office_cents) - n(m.refunded_cents),
      not_out_rate: visited ? Math.round((n(m.not_out) / visited) * 1000) / 10 : null,
      sizes: sizes.filter((x) => x.month === m.month).map((x) => ({ name: x.name, quantity: n(x.quantity) })),
    };
  });
  res.json({ months: out });
});

/**
 * The bookings as a spreadsheet. A public record version by default: no resident name, phone, email or house number
 * (Pennsylvania's Right-to-Know Law). contacts=1 adds them, for managers only, and is written to the audit trail.
 */
router.get('/export', office, async (req, res) => {
  const t = await townOf(req.auth.tenantId);
  const from = String(req.query.from || addDays(todayIn(t.timezone), -365)); const to = String(req.query.to || addDays(todayIn(t.timezone), 60));
  if (!dateStr.safeParse(from).success || !dateStr.safeParse(to).success) throw bad('from and to must be YYYY-MM-DD');
  const contacts = String(req.query.contacts || '') === '1';
  if (contacts && !isManagerRole(req)) throw forbidden('Only a manager can include contact details');
  const list = await rows(pool, `${FULL} WHERE b.tenant_id = ? AND b.collection_date BETWEEN ? AND ? ORDER BY b.collection_date, s.name, CAST(b.house_number AS UNSIGNED)`, [t.id, from, to]);
  const items = await B.itemsOf(pool, t.id, list.map((b) => b.id));
  const data = list.map((b) => ({
    reference: b.reference, collection_date: String(b.collection_date).slice(0, 10), street: b.street, ...(contacts ? { house_number: b.house_number, unit: b.unit || '', name: b.name || '', phone: b.phone || '', email: b.email || '' } : {}),
    items: B.itemsText(items.filter((i) => i.booking_id === b.id)), source: b.source, status: b.status, pay_method: b.pay_method, pay_status: b.pay_status,
    total: dollars(b.total_cents), paid: dollars(b.paid_cents), refunded: dollars(b.refunded_cents), outcome: b.outcome || '', outcome_reason: b.outcome_reason || '', decision: b.decision || '',
  }));
  const cols = ['reference', 'collection_date', 'street', ...(contacts ? ['house_number', 'unit', 'name', 'phone', 'email'] : []), 'items', 'source', 'status', 'pay_method', 'pay_status', 'total', 'paid', 'refunded', 'outcome', 'outcome_reason', 'decision'];
  await audit(pool, req, contacts ? 'bulk_export_contacts' : 'bulk_export', 'bulk_bookings', null, { from, to, rows: data.length, contacts });
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="bulk-pickups-${from}-to-${to}${contacts ? '-with-contacts' : ''}.csv"`).send(toCsv(cols, data));
});

// ---------------------------------------------------------------- public
async function townFor(slug) {
  const t = await one(pool, "SELECT id, name, slug, phone, timezone FROM tenants WHERE slug = ? AND org_type = 'municipality'", [String(slug)]);
  if (!t) throw notFound('Page');
  return t;
}
const noStore = (res) => res.set('Cache-Control', 'no-store');

publicRouter.get('/:slug/bulk-pickup', async (req, res) => {
  const t = await townFor(req.params.slug); noStore(res);
  const s = await B.settingsOf(t.id);
  const base = { town: t.name, phone: t.phone, office_name: s.office_name, rules: s.rules_text, curb_by: s.curb_by };
  if (!s.online) return res.json({ ...base, open: false, message: `Book bulk pickup by calling ${s.office_name}${t.phone ? ` at ${t.phone}` : ''}.` });
  const ready = s.pay_card && await B.cardReady(t.id);
  const days = (await B.calendar(pool, t.id, s, t.timezone, { days: 42 })).filter((d) => !d.closed).slice(0, 6)
    .map((d) => ({ date: d.date, label: B.longDay(d.date), cutoff_at: d.cutoff_at, cutoff_words: B.cutoffWords(d.cutoff_at), available: d.available, reason: d.available ? null : d.skipped ? `No pickup${d.note ? `: ${d.note}` : ''}` : 'Full' }));
  return res.json({
    ...base, open: true, sizes: (await B.sizesOf(pool, t.id)).map((z1) => ({ id: z1.id, name: z1.name, description: z1.description, price_cents: z1.price_cents, max_qty: z1.max_qty })),
    streets: await streetsOf(pool, t.id), days,
    pay: { card: ready, stickers: s.pay_stickers, office: s.pay_card && !ready },
    card_message: s.pay_card && !ready ? `Card payment online is not available right now. Book now and pay at ${s.office_name} before collection day.` : null,
  });
});

publicRouter.post('/:slug/bulk-pickup/bookings', validate(z.object({
  ...bookingShape,
  pay: z.enum(['card', 'stickers', 'office']),
  website: z.string().max(200).optional(), // a hidden field people never fill; a robot does
})), async (req, res) => {
  const t = await townFor(req.params.slug); noStore(res);
  const b = req.body;
  if (b.website) return res.status(202).json({ ok: true });
  if (await require('../lib/billing').publicBlocked(t.id, req.method)) throw conflict(`Online booking is not available right now. Please call${t.phone ? ` ${t.phone}` : ''}.`);
  const { phone, email } = contactOf(b);
  // At most 3 new bookings an hour giving the same phone or email (lib/publicsends.js).
  await require('../lib/publicsends').submitAllowed(t.id, { phone, email }, 'bookings');
  const ready = await B.cardReady(t.id);
  const made = await tx(async (conn) => {
    await B.lockDay(conn, t.id);
    const s = await B.settingsOf(t.id, conn);
    if (!s.online) throw conflict(`Book bulk pickup by calling ${s.office_name}${t.phone ? ` at ${t.phone}` : ''}.`);
    await streetOk(conn, t.id, b.street_id);
    const day = (await B.calendar(conn, t.id, s, t.timezone, { days: 42 })).find((d) => d.date === b.collection_date);
    const why = B.whyNot(day);
    if (why) throw conflict(why);
    const q = await B.price(conn, t.id, b.items);
    let pay;
    if (q.total === 0) pay = { pay_method: 'free', pay_status: 'not_needed', status: 'booked' };
    else if (b.pay === 'stickers') {
      if (!s.pay_stickers) throw bad('Stickers are not taken for online bookings here. Pay by card instead.');
      pay = { pay_method: 'stickers', pay_status: 'not_needed', status: 'booked' };
    } else {
      if (!s.pay_card) throw bad('Card payment is not offered here. Choose stickers.');
      // With the municipality's Stripe account not ready, the booking is still taken: they pay at the office.
      pay = ready ? { pay_method: 'card', pay_status: 'due', status: 'awaiting_payment' } : { pay_method: 'office', pay_status: 'due', status: 'booked' };
    }
    // A public form never changes the resident on file; what was typed stays on the booking (lib/residents.js).
    const residentId = await upsertResident(conn, t.id, { name: b.name, phone, email, streetId: b.street_id, houseNumber: b.house_number, unit: b.unit || null, textsOk: b.texts_ok ? true : undefined, emailsOk: b.emails_ok ? true : undefined }, { source: 'bulk_pickup', publicForm: true });
    const out = await B.insertBooking(conn, t.id, { collection_date: b.collection_date, street_id: b.street_id, house_number: b.house_number, unit: b.unit, resident_id: residentId, items_note: b.items_note,
      contact_name: b.name, contact_phone: phone, contact_email: email, source: 'online', ...pay, total_cents: q.total, texts_ok: b.texts_ok, emails_ok: b.emails_ok }, q.lines);
    await audit(conn, { auth: { tenantId: t.id, userId: null }, ip: req.ip }, 'bulk_book_online', 'bulk_bookings', out.id, { reference: out.reference, collection_date: b.collection_date, total_cents: q.total, pay_method: pay.pay_method });
    return { ...out, ...pay, total: q.total, office_name: s.office_name };
  });
  const base = baseUrl(req);
  if (made.status === 'awaiting_payment') {
    let url;
    try { url = await B.checkout(t.id, made.id, base); } catch (err) {
      await pool.query("UPDATE bulk_bookings SET status = 'expired' WHERE tenant_id = ? AND id = ? AND status = 'awaiting_payment'", [t.id, made.id]);
      throw err;
    }
    return res.status(201).json({ reference: made.reference, token: made.view_token, total_cents: made.total, checkout_url: url });
  }
  await B.tell(t.id, made.id, 'confirm', base, { receipt: true });
  return res.status(201).json({ reference: made.reference, token: made.view_token, total_cents: made.total, pay_method: made.pay_method, pay_status: made.pay_status,
    message: made.pay_method === 'office' ? `Please pay ${money(made.total)} at ${made.office_name} before collection day.` : null });
});

/** The resident's own booking, by its secret link: nothing about anyone else. */
async function residentView(t, tok) {
  if (!/^[a-f0-9]{32}$/.test(String(tok))) return null;
  const b = await one(pool, `SELECT b.*, s.name AS street, b.contact_name AS name, b.contact_phone AS r_phone FROM bulk_bookings b JOIN streets s ON s.tenant_id = b.tenant_id AND s.id = b.street_id
    WHERE b.tenant_id = ? AND b.view_token = ?`, [t.id, String(tok)]);
  if (!b) return null;
  const s = await B.settingsOf(t.id);
  const cutoff = B.cutoffOf(s, String(b.collection_date).slice(0, 10));
  const before = nowIn(t.timezone) < cutoff;
  const items = await B.itemsOf(pool, t.id, [b.id]);
  return {
    b, view: {
      reference: b.reference, name: b.name, collection_date: String(b.collection_date).slice(0, 10), day_label: B.longDay(b.collection_date), address: B.addressOf(b),
      items: items.map((i) => ({ name: i.name, quantity: i.quantity, unit_cents: i.unit_cents })), items_note: b.items_note, total_cents: b.total_cents,
      status: b.status, pay_method: b.pay_method, pay_status: b.pay_status, paid_cents: b.paid_cents, refunded_cents: b.refunded_cents,
      cutoff_at: cutoff, cutoff_words: B.cutoffWords(cutoff), can_cancel: before && ['booked', 'awaiting_payment'].includes(b.status) && !b.outcome,
      can_pay: b.pay_method === 'card' && b.pay_status === 'due' && ['booked', 'awaiting_payment'].includes(b.status) && await B.cardReady(t.id),
      outcome: b.outcome, outcome_reason: b.outcome_reason, town: t.name, phone: t.phone, office_name: s.office_name, curb_by: s.curb_by, rules: s.rules_text,
      // The one STOP rule (lib/residents.js): they ticked "text me" but the phone texted STOP, so the page says how to turn texts back on.
      texts_off: Number(b.texts_ok) && b.r_phone ? await RES.textsOffNotice(pool, t.id, b.r_phone) : null,
    },
  };
}

publicRouter.get('/:slug/bulk-pickup/bookings/:token', async (req, res) => {
  const t = await townFor(req.params.slug); noStore(res);
  const v = await residentView(t, req.params.token);
  if (!v) throw notFound('Booking');
  res.json(v.view);
});

publicRouter.post('/:slug/bulk-pickup/bookings/:token/cancel', async (req, res) => {
  const t = await townFor(req.params.slug); noStore(res);
  const v = await residentView(t, req.params.token);
  if (!v) throw notFound('Booking');
  await cancel(t.id, v.b.id, { by: 'resident' });
  await B.tell(t.id, v.b.id, 'cancelled', baseUrl(req), { receipt: true });
  res.json((await residentView(t, req.params.token)).view);
});

publicRouter.post('/:slug/bulk-pickup/bookings/:token/pay', async (req, res) => {
  const t = await townFor(req.params.slug); noStore(res);
  const v = await residentView(t, req.params.token);
  if (!v) throw notFound('Booking');
  if (!v.view.can_pay) throw conflict(v.b.pay_status === 'paid' ? 'This pickup is already paid' : 'This pickup cannot be paid online. Please pay at the office.');
  if (v.b.status === 'awaiting_payment') {
    // A resident back on a card page that lapsed: the stop is held again only if the day still has room.
    await tx(async (conn) => {
      await B.lockDay(conn, t.id);
      const s = await B.settingsOf(t.id, conn);
      const day = (await B.calendar(conn, t.id, s, t.timezone, { days: 42 })).find((d) => d.date === v.view.collection_date);
      const mine = await one(conn, 'SELECT held_until > UTC_TIMESTAMP() AS held FROM bulk_bookings WHERE tenant_id = ? AND id = ?', [t.id, v.b.id]);
      const why = B.whyNot(day && Number(mine.held) ? { ...day, left: day.left + 1 } : day);
      if (why) throw conflict(why);
      await conn.query(`UPDATE bulk_bookings SET held_until = UTC_TIMESTAMP() + INTERVAL ${B.HOLD_MINUTES} MINUTE WHERE tenant_id = ? AND id = ?`, [t.id, v.b.id]);
    });
  }
  res.json({ checkout_url: await B.checkout(t.id, v.b.id, baseUrl(req)) });
});

module.exports = { router, publicRouter, cancel };
