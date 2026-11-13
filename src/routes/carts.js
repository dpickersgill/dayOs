'use strict';

// Carts (release 2026.11.22, Trash and recycling). See lib/carts.js for the rules.
// Staff side, mounted at /solid-waste (signed in, the solidwaste app on):
//   GET  /carts/today                      the cart Today cards alone (they are also on GET /solid-waste/today, by addTodayCards)
//   GET  /carts/setup, PUT /carts/setup     online requests, extras allowed, sizes and fees per stream (managers)
//   GET  /carts/options                    what the request form needs: streams, sizes, streets
//   GET  /carts/address?street_id=&house_number=&unit=   the carts and requests at one address
//   GET  /carts, POST /carts, PATCH /carts/:id           the carts at addresses (search; add one on record; condition, removed)
//   GET  /carts/counts                     carts in use by stream and size, and by stream and zone
//   GET  /carts/requests, GET /carts/requests/:id, POST /carts/requests (a phone or walk-in request)
//   POST /carts/requests/:id/schedule | deliver | cancel | paid | refund-given | send-link
//   GET  /carts/stops?date=                the cart deliveries of a day (addresses only)
//   GET  /carts/stock, POST /carts/stock    carts in the yard; receive, return, scrap, count
//   GET  /carts/export                     the requests as a spreadsheet (no contact details unless a manager asks)
// Public side: the page is /cart-request/<slug>; its API is /public/<slug>/cart-request:
//   GET  /:slug/cart-request, POST /:slug/cart-request
//   GET  /:slug/cart-request/:token, POST .../cancel, POST .../pay
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, dateStr, validate, paramId, todayIn, addDays } = require('../lib/util');
const { notFound, conflict, bad, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { baseUrl } = require('../lib/baseurl');
const { card, todayRoute } = require('../lib/today');
const { money } = require('../lib/format');
const { toCsv, dollars } = require('../lib/csv');
const RES = require('../lib/residents');
const C = require('../lib/carts');

const router = express.Router();
const publicRouter = express.Router();
const office = requireRole('manager', 'counter');
const crew = requireRole('manager', 'staff');
const anyone = requireRole('manager', 'counter', 'staff');
const managers = requireRole('manager');
const isOffice = (req) => ['owner', 'manager', 'counter'].includes(req.auth.role);
const isManagerRole = (req) => ['owner', 'manager'].includes(req.auth.role);
const townOf = (tenantId) => one(pool, 'SELECT id, name, slug, phone, timezone FROM tenants WHERE id = ?', [tenantId]);
const streetsOf = (db, tenantId) => rows(db, 'SELECT id, name FROM streets WHERE tenant_id = ? AND active = 1 ORDER BY name', [tenantId]);
const officeName = async (tenantId) => (await require('../lib/bulkpickup').settingsOf(tenantId)).office_name;
const day = (d) => (d ? String(d).slice(0, 10) : null);

const STATUS_WORDS = { awaiting_payment: 'Waiting for the card payment', open: 'Waiting for a delivery day', scheduled: 'Delivery day set', delivered: 'Delivered', cancelled: 'Canceled', expired: 'Not paid in time' };

/** A request as staff see it (contact details only for the office: managers and the front desk; money only for managers, lib/nomoney.js). */
function staffShape(r, req, checks = null) {
  const out = {
    id: Number(r.id), reference: r.reference, kind: r.kind, kind_label: C.KINDS[r.kind], stream_id: Number(r.stream_id), stream: r.stream, size_gal: Number(r.size_gal),
    street_id: Number(r.street_id), street: r.street, house_number: r.house_number, unit: r.unit, address: C.addressOf(r), service_address_id: r.service_address_id ? Number(r.service_address_id) : null,
    note: r.note, police_report: r.police_report, source: r.source, status: r.status, status_words: STATUS_WORDS[r.status], deliver_on: day(r.deliver_on), delivered_at: r.delivered_at,
    cart_id: r.cart_id ? Number(r.cart_id) : null, pay_method: r.pay_method, pay_status: r.pay_status, fee_cents: Number(r.fee_cents), paid_cents: Number(r.paid_cents), refunded_cents: Number(r.refunded_cents),
    created_at: r.created_at, cancel_reason: r.cancel_reason,
  };
  if (checks) out.checks = checks;
  if (isOffice(req)) Object.assign(out, { name: r.contact_name, phone: r.contact_phone, email: r.contact_email, texts_ok: Boolean(r.texts_ok), emails_ok: Boolean(r.emails_ok) });
  return out;
}
const LIST = `SELECT r.*, st.name AS street, cs.name AS stream FROM cart_requests r JOIN streets st ON st.tenant_id = r.tenant_id AND st.id = r.street_id
  JOIN collection_streams cs ON cs.tenant_id = r.tenant_id AND cs.id = r.stream_id`;

// ---------------------------------------------------------------- Today
/** The cart cards, for the front desk and managers: added to Trash and recycling's Today (lib/collection.js addTodayCards). */
async function cartCards(req) {
  if (!isOffice(req)) return [];
  const n = await C.waitingCount(pool, req.auth.tenantId);
  const t = await townOf(req.auth.tenantId);
  const today = todayIn(t.timezone);
  const stops = await C.cartStopsFor(pool, t.id, today);
  return [
    n ? card({ title: 'Cart requests waiting', count: n, text: `${n === 1 ? 'Needs' : 'Need'} a delivery day`, href: '#/bulk?tab=carts&show=waiting' }) : null,
    stops.length ? card({ title: 'Cart deliveries today', count: stops.length, text: `${stops.filter((s) => s.delivered).length} delivered, ${stops.filter((s) => !s.delivered).length} to go`, href: `#/bulk?tab=carts&part=stops&date=${today}` }) : null,
  ].filter(Boolean);
}
require('../lib/collection').addTodayCards(cartCards);
router.get('/carts/today', office, todayRoute(cartCards));

// ---------------------------------------------------------------- setup
const optionSchema = z.object({
  stream_id: z.number().int().positive(),
  size_gal: z.number().int().refine((v) => C.SIZES.includes(v), 'Cart sizes are 35, 65 or 95 gallons'),
  extra_fee_cents: z.number().int().min(0).max(100000),
  replacement_fee_cents: z.number().int().min(0).max(100000),
  active: z.boolean().default(true),
});
const setupSchema = z.object({
  online: z.boolean(),
  max_extra: z.number().int().min(0).max(10),
  rules_text: z.string().trim().max(4000).optional().nullable(),
  options: z.array(optionSchema).max(60),
});
async function setupView(req) {
  const t = await townOf(req.auth.tenantId);
  return { ...(await C.settingsOf(t.id)), options: await C.optionsOf(pool, t.id, { all: true }), streams: await C.streamsOf(pool, t.id), sizes: C.SIZES, card_ready: await C.cardReady(t.id), page: C.pageLink(baseUrl(req), t.slug) };
}
router.get('/carts/setup', managers, async (req, res) => res.json(await setupView(req)));
router.put('/carts/setup', managers, validate(setupSchema), async (req, res) => {
  const b = req.body; const t = req.auth.tenantId;
  await C.settingsOf(t);
  await tx(async (conn) => {
    await conn.query('UPDATE cart_settings SET online = ?, max_extra = ?, rules_text = ?, updated_by = ? WHERE tenant_id = ?', [b.online ? 1 : 0, b.max_extra, b.rules_text || null, req.auth.userId, t]);
    const streams = new Set((await rows(conn, 'SELECT id FROM collection_streams WHERE tenant_id = ?', [t])).map((s) => Number(s.id)));
    const seen = new Set();
    for (const o of b.options) {
      if (!streams.has(o.stream_id)) throw bad('Pick the stream from the list');
      const k = `${o.stream_id}|${o.size_gal}`;
      if (seen.has(k)) throw bad('Each size is listed once for a stream');
      seen.add(k);
      await conn.query(`INSERT INTO cart_options (tenant_id, stream_id, size_gal, extra_fee_cents, replacement_fee_cents, active) VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE extra_fee_cents = VALUES(extra_fee_cents), replacement_fee_cents = VALUES(replacement_fee_cents), active = VALUES(active)`,
      [t, o.stream_id, o.size_gal, o.extra_fee_cents, o.replacement_fee_cents, o.active ? 1 : 0]);
    }
    // A size left out is switched off, never deleted: carts and requests name it.
    for (const o of await rows(conn, 'SELECT stream_id, size_gal FROM cart_options WHERE tenant_id = ?', [t])) {
      if (!seen.has(`${o.stream_id}|${o.size_gal}`)) await conn.query('UPDATE cart_options SET active = 0 WHERE tenant_id = ? AND stream_id = ? AND size_gal = ?', [t, o.stream_id, o.size_gal]);
    }
    await audit(conn, req, 'cart_setup', 'cart_settings', null, { online: b.online, max_extra: b.max_extra, options: b.options.map((o) => ({ stream_id: o.stream_id, size_gal: o.size_gal, extra_fee_cents: o.extra_fee_cents, replacement_fee_cents: o.replacement_fee_cents, active: o.active })) });
  });
  res.json(await setupView(req));
});

router.get('/carts/options', anyone, async (req, res) => {
  const t = await townOf(req.auth.tenantId);
  res.json({ options: await C.optionsOf(pool, t.id), streams: await C.streamsOf(pool, t.id), streets: await streetsOf(pool, t.id), kinds: C.KINDS, sizes: C.SIZES,
    card_ready: await C.cardReady(t.id), today: todayIn(t.timezone), max_extra: (await C.settingsOf(t.id)).max_extra });
});

// ---------------------------------------------------------------- carts at addresses
const addressQuery = z.object({ street_id: z.coerce.number().int().positive(), house_number: z.string().trim().min(1).max(20), unit: z.string().trim().max(20).optional() });
const cartShape = (c) => ({ id: Number(c.id), stream_id: Number(c.stream_id), stream: c.stream, size_gal: Number(c.size_gal), serial: c.serial, delivered_on: day(c.delivered_on), cond: c.cond, status: c.status,
  street_id: Number(c.street_id), street: c.street, house_number: c.house_number, unit: c.unit, address: c.street ? C.addressOf(c) : null, note: c.note, removed_on: day(c.removed_on) });

router.get('/carts/address', anyone, async (req, res) => {
  const q = addressQuery.safeParse(req.query);
  if (!q.success) throw bad('Pick the street and give the house number');
  const t = req.auth.tenantId; const a = q.data;
  const st = await C.streetOk(pool, t, a.street_id);
  const carts = (await C.cartsAt(pool, t, a)).map((c) => cartShape({ ...c, street: st.name }));
  const reqs = await rows(pool, `${LIST} WHERE r.tenant_id = ? AND r.street_id = ? AND r.house_number = ? AND COALESCE(r.unit, '') = ? ORDER BY r.id DESC LIMIT 50`, [t, a.street_id, a.house_number, a.unit || '']);
  const zone = await C.collection().zoneFor(pool, t, { streetId: a.street_id, houseNo: C.houseNo(a.house_number) });
  res.json({ address: `${a.house_number} ${st.name}${a.unit ? `, ${a.unit}` : ''}`, zone: zone && zone.zoneId ? zone.zoneName : zone && zone.notCollected ? 'Not collected' : null,
    service_address: Boolean(await C.serviceAddressAt(pool, t, a.street_id, a.house_number, a.unit)), carts, requests: reqs.map((r) => staffShape(r, req)) });
});

router.get('/carts', anyone, async (req, res) => {
  const t = req.auth.tenantId;
  const where = ['c.tenant_id = ?']; const params = [t];
  const status = String(req.query.status || 'in_use');
  if (status !== 'all') { if (!['in_use', 'removed', 'stolen'].includes(status)) throw bad('status must be in_use, removed, stolen or all'); where.push('c.status = ?'); params.push(status); }
  if (req.query.stream_id) { where.push('c.stream_id = ?'); params.push(Number(req.query.stream_id) || 0); }
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q) { const like = `%${q.replace(/[\\%_]/g, '')}%`; where.push("(c.serial LIKE ? OR CONCAT(c.house_number, ' ', s.name) LIKE ? OR s.name LIKE ?)"); params.push(like, like, like); }
  const list = await rows(pool, `SELECT c.*, s.name AS street, cs.name AS stream FROM carts c JOIN streets s ON s.tenant_id = c.tenant_id AND s.id = c.street_id
    JOIN collection_streams cs ON cs.tenant_id = c.tenant_id AND cs.id = c.stream_id WHERE ${where.join(' AND ')} ORDER BY s.name, c.house_no, c.house_number, cs.sort, c.id LIMIT 500`, params);
  res.json({ data: list.map(cartShape) });
});

const cartBody = z.object({
  street_id: z.number().int().positive(),
  house_number: z.string().trim().min(1, 'Give the house number').max(20).regex(/^[0-9A-Za-z][0-9A-Za-z \-/½]*$/, 'Use the house number only, like 120 or 120A'),
  unit: z.string().trim().max(20).optional().nullable(),
  stream_id: z.number().int().positive(),
  size_gal: z.number().int().refine((v) => C.SIZES.includes(v), 'Cart sizes are 35, 65 or 95 gallons'),
  serial: z.string().trim().max(40).optional().nullable(),
  delivered_on: dateStr.optional().nullable(),
  cond: z.enum(['good', 'damaged']).default('good'),
  note: z.string().trim().max(200).optional().nullable(),
});
/** A cart already at an address, put on record (the first count of carts, or one found in the field). Stock is not touched. */
router.post('/carts', crew, validate(cartBody), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const id = await tx(async (conn) => {
    await C.streetOk(conn, t, b.street_id);
    if (!(await one(conn, 'SELECT id FROM collection_streams WHERE tenant_id = ? AND id = ?', [t, b.stream_id]))) throw bad('Pick the stream from the list');
    const sa = await C.serviceAddressAt(conn, t, b.street_id, b.house_number, b.unit);
    const [r] = await conn.query('INSERT INTO carts (tenant_id, service_address_id, street_id, house_number, house_no, unit, stream_id, size_gal, serial, delivered_on, cond, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [t, sa, b.street_id, b.house_number, C.houseNo(b.house_number), b.unit || null, b.stream_id, b.size_gal, b.serial || null, b.delivered_on || null, b.cond, b.note || null, req.auth.userId]);
    await audit(conn, req, 'cart_add', 'carts', r.insertId, { stream_id: b.stream_id, size_gal: b.size_gal, serial: b.serial || null });
    return Number(r.insertId);
  });
  res.status(201).json({ id });
});

router.patch('/carts/:id', crew, validate(z.object({
  serial: z.string().trim().max(40).optional().nullable(),
  cond: z.enum(['good', 'damaged']).optional(),
  status: z.enum(['in_use', 'removed', 'stolen']).optional(),
  note: z.string().trim().max(200).optional().nullable(),
})), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  await tx(async (conn) => {
    const c = await one(conn, 'SELECT * FROM carts WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, paramId(req)]);
    if (!c) throw notFound('Cart');
    const tz = (await townOf(t)).timezone;
    await conn.query(`UPDATE carts SET serial = ?, cond = ?, status = ?, note = ?, removed_on = ? WHERE tenant_id = ? AND id = ?`,
      [b.serial === undefined ? c.serial : b.serial, b.cond || c.cond, b.status || c.status, b.note === undefined ? c.note : b.note,
        (b.status || c.status) === 'in_use' ? null : (c.removed_on || todayIn(tz)), t, c.id]);
    await audit(conn, req, 'cart_change', 'carts', c.id, { ...b });
  });
  res.json({ ok: true });
});

router.get('/carts/counts', anyone, async (req, res) => {
  const t = req.auth.tenantId;
  res.json({ ...(await C.counts(pool, t)), stock: await C.stockOf(pool, t), waiting: await C.waitingCount(pool, t) });
});

// ---------------------------------------------------------------- requests
router.get('/carts/requests', anyone, async (req, res) => {
  const t = await townOf(req.auth.tenantId);
  const where = ['r.tenant_id = ?']; const params = [t.id];
  const show = String(req.query.show || 'waiting');
  if (show === 'waiting') where.push("r.status IN ('open','awaiting_payment')");
  else if (show === 'scheduled') where.push("r.status = 'scheduled'");
  else if (show === 'delivered') where.push("r.status = 'delivered'");
  else if (show === 'cancelled') where.push("r.status IN ('cancelled','expired')");
  else if (show === 'unpaid') where.push("r.pay_status IN ('due','refund_due') AND r.status <> 'expired'");
  else if (show !== 'all') throw bad('show must be waiting, scheduled, delivered, cancelled, unpaid or all');
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, '')}%`;
    const parts = ['r.reference = ?', "CONCAT(r.house_number, ' ', st.name) LIKE ?", 'st.name LIKE ?'];
    params.push(q.toUpperCase(), like, like);
    if (isOffice(req)) { parts.push('r.contact_name LIKE ?', 'r.contact_email LIKE ?'); params.push(like, like); }
    where.push(`(${parts.join(' OR ')})`);
  }
  const list = await rows(pool, `${LIST} WHERE ${where.join(' AND ')} ORDER BY ${show === 'scheduled' ? 'r.deliver_on, st.name, r.house_no' : 'r.id DESC'} LIMIT 300`, params);
  const s = await C.settingsOf(t.id);
  const out = [];
  for (const r of list) out.push(staffShape(r, req, ['open', 'awaiting_payment'].includes(r.status) ? await C.checksFor(pool, t.id, r, s, { exceptId: r.id }) : null));
  res.json({ data: out });
});

router.get('/carts/requests/:id', anyone, async (req, res) => {
  const t = req.auth.tenantId;
  const r = await one(pool, `${LIST} WHERE r.tenant_id = ? AND r.id = ?`, [t, paramId(req)]);
  if (!r) throw notFound('Cart request');
  const s = await C.settingsOf(t);
  const out = staffShape(r, req, await C.checksFor(pool, t, r, s, { exceptId: r.id }));
  if (isOffice(req)) out.link = C.viewLink(baseUrl(req), (await townOf(t)).slug, r.view_token);
  res.json(out);
});

const contactShape = {
  name: z.string().trim().min(2, 'Give the resident’s name').max(120),
  phone: z.string().trim().max(40).optional().nullable(),
  email: z.string().trim().toLowerCase().email('Check the email address').max(255).optional().nullable().or(z.literal('')),
  texts_ok: z.boolean().default(false),
  emails_ok: z.boolean().default(false),
};
const requestShape = {
  kind: z.enum(C.KIND_KEYS),
  stream_id: z.number().int().positive(),
  size_gal: z.number().int(),
  street_id: z.number().int().positive(),
  house_number: z.string().trim().min(1, 'Give the house number').max(20).regex(/^[0-9A-Za-z][0-9A-Za-z \-/½]*$/, 'Use the house number only, like 120 or 120A'),
  unit: z.string().trim().max(20).optional().nullable(),
  note: z.string().trim().max(300).optional().nullable(),
  police_report: z.string().trim().max(40).optional().nullable(),
  ...contactShape,
};

router.post('/carts/requests', office, validate(z.object({
  ...requestShape,
  pay: z.enum(['office_paid', 'office_due', 'link', 'waive']).optional(),
  link_by: z.enum(['text', 'email']).optional(),
  override: z.boolean().default(false), // take it although the checks say otherwise (staff decide)
})), async (req, res) => {
  const b = req.body; const t = await townOf(req.auth.tenantId);
  const { phone, email } = C.contactOf(b);
  if (b.pay === 'waive' && !isManagerRole(req)) throw forbidden('Only a manager can waive a cart fee');
  const made = await tx(async (conn) => {
    await C.streetOk(conn, t.id, b.street_id);
    const opt = await C.optionFor(conn, t.id, b.stream_id, b.size_gal);
    const s = await C.settingsOf(t.id, conn);
    const checks = await C.checksFor(conn, t.id, b, s);
    if (checks.length && !b.override) throw conflict(checks.join(' '), { code: 'cart_checks', checks });
    const fee = b.pay === 'waive' ? 0 : C.feeOf(opt, b.kind);
    let pay = { pay_method: 'free', pay_status: 'not_needed', paid_cents: 0 };
    if (fee > 0) {
      const how = b.pay || 'office_due';
      if (how === 'link') {
        if (!(await C.cardReady(t.id))) throw conflict('Card payment is not set up. Connect Stripe under Settings, Payments, or take payment at the office.');
        if (!b.link_by) throw bad('Choose how to send the payment link: text or email');
        if (b.link_by === 'text' && !(phone && b.texts_ok)) throw bad('To text the link, give a phone number and tick that they agree to texts');
        if (b.link_by === 'email' && !email) throw bad('To email the link, give an email address');
        pay = { pay_method: 'card', pay_status: 'due', paid_cents: 0 };
      } else if (how === 'office_paid') pay = { pay_method: 'office', pay_status: 'paid', paid_cents: fee };
      else pay = { pay_method: 'office', pay_status: 'due', paid_cents: 0 };
    }
    const residentId = await RES.upsertResident(conn, t.id, { name: b.name, phone, email, streetId: b.street_id, houseNumber: b.house_number, unit: b.unit || null, textsOk: b.texts_ok ? true : undefined, emailsOk: b.emails_ok ? true : undefined }, { source: 'staff', userId: req.auth.userId });
    const out = await C.insertRequest(conn, t.id, { ...b, size_gal: opt.size_gal, service_address_id: await C.serviceAddressAt(conn, t.id, b.street_id, b.house_number, b.unit), resident_id: residentId,
      contact_name: b.name, contact_phone: phone, contact_email: email, source: 'staff', status: 'open', ...pay, fee_cents: fee, created_by: req.auth.userId });
    await audit(conn, req, 'cart_request', 'cart_requests', out.id, { reference: out.reference, kind: b.kind, stream_id: b.stream_id, size_gal: opt.size_gal, fee_cents: fee, pay: b.pay || null, ...(checks.length ? { override: checks.join(' ').slice(0, 200) } : {}) });
    return { ...out, fee };
  });
  const base = baseUrl(req);
  const sent = b.pay === 'link' && made.fee > 0 ? await C.tell(t.id, made.id, 'pay_link', base, { receipt: true, only: b.link_by }) : await C.tell(t.id, made.id, 'confirm', base, { receipt: true });
  const textsOff = b.texts_ok && phone ? await RES.textsOffNotice(pool, t.id, phone) : null;
  res.status(201).json({ id: made.id, reference: made.reference, fee_cents: made.fee, fee_due: made.fee > 0 && b.pay !== 'office_paid', link: C.viewLink(base, t.slug, made.view_token), sent, ...(textsOff ? { texts_off: textsOff } : {}) });
});

router.post('/carts/requests/:id/schedule', office, validate(z.object({ deliver_on: dateStr })), async (req, res) => {
  const t = await townOf(req.auth.tenantId);
  if (req.body.deliver_on < todayIn(t.timezone)) throw bad('Pick today or a later day');
  if (req.body.deliver_on > addDays(todayIn(t.timezone), 120)) throw bad('Pick a day within the next 4 months');
  await tx(async (conn) => {
    const r = await C.requestOf(conn, t.id, paramId(req), { lock: true });
    if (!['open', 'scheduled'].includes(r.status)) throw conflict(r.status === 'awaiting_payment' ? 'This request is waiting for its card payment' : 'This request is already delivered or canceled');
    await conn.query("UPDATE cart_requests SET status = 'scheduled', deliver_on = ? WHERE tenant_id = ? AND id = ?", [req.body.deliver_on, t.id, r.id]);
    await audit(conn, req, 'cart_schedule', 'cart_requests', r.id, { deliver_on: req.body.deliver_on });
  });
  const told = await C.tell(t.id, paramId(req), 'scheduled', baseUrl(req));
  res.json({ ok: true, told });
});

/**
 * The crew (or the office) delivered the cart: one cart of that stream and size leaves the yard (refused when none is
 * there), the cart goes on record at the address, and a replaced or stolen cart comes off it. old_cart_back: the old
 * cart came back to the yard in good shape and goes back into stock.
 */
router.post('/carts/requests/:id/deliver', anyone, validate(z.object({
  serial: z.string().trim().max(40).optional().nullable(),
  old_cart_id: z.number().int().positive().optional(),
  old_cart_back: z.boolean().default(false),
})), async (req, res) => {
  const t = await townOf(req.auth.tenantId); const b = req.body;
  const today = todayIn(t.timezone);
  const cartId = await tx(async (conn) => {
    const r = await C.requestOf(conn, t.id, paramId(req), { lock: true });
    if (r.status === 'delivered') throw conflict('This cart is already delivered');
    if (!['open', 'scheduled'].includes(r.status)) throw conflict(r.status === 'awaiting_payment' ? 'This request is waiting for its card payment' : 'This request is canceled');
    if (req.auth.role === 'staff' && (r.status !== 'scheduled' || day(r.deliver_on) > today)) throw conflict('Mark it delivered on its delivery day');
    await C.moveStock(conn, t.id, { streamId: r.stream_id, size: r.size_gal, delta: -1, reason: 'delivered', requestId: r.id, by: req.auth.userId });
    let old = null;
    if (['replacement', 'stolen'].includes(r.kind)) {
      old = b.old_cart_id ? await one(conn, "SELECT * FROM carts WHERE tenant_id = ? AND id = ? AND status = 'in_use'", [t.id, b.old_cart_id])
        : await one(conn, "SELECT * FROM carts WHERE tenant_id = ? AND street_id = ? AND house_number = ? AND COALESCE(unit, '') = ? AND stream_id = ? AND status = 'in_use' ORDER BY id LIMIT 1", [t.id, r.street_id, r.house_number, r.unit || '', r.stream_id]);
      if (b.old_cart_id && !old) throw bad('That old cart is not on record at this address');
      if (old) {
        await conn.query('UPDATE carts SET status = ?, removed_on = ? WHERE tenant_id = ? AND id = ?', [r.kind === 'stolen' ? 'stolen' : 'removed', today, t.id, old.id]);
        if (r.kind === 'replacement' && b.old_cart_back) await C.moveStock(conn, t.id, { streamId: old.stream_id, size: old.size_gal, delta: 1, reason: 'returned', requestId: r.id, by: req.auth.userId, note: 'Old cart back to the yard' });
      }
    }
    const [ins] = await conn.query('INSERT INTO carts (tenant_id, service_address_id, street_id, house_number, house_no, unit, stream_id, size_gal, serial, delivered_on, request_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [t.id, r.service_address_id, r.street_id, r.house_number, r.house_no, r.unit, r.stream_id, r.size_gal, b.serial || null, today, r.id, req.auth.userId]);
    await conn.query("UPDATE cart_requests SET status = 'delivered', deliver_on = COALESCE(deliver_on, ?), delivered_at = UTC_TIMESTAMP(), delivered_by = ?, cart_id = ?, old_cart_id = ? WHERE tenant_id = ? AND id = ?",
      [today, req.auth.userId, ins.insertId, old ? old.id : null, t.id, r.id]);
    await audit(conn, req, 'cart_delivered', 'cart_requests', r.id, { cart_id: Number(ins.insertId), serial: b.serial || null, old_cart_id: old ? Number(old.id) : null });
    return Number(ins.insertId);
  });
  const told = await C.tell(t.id, paramId(req), 'delivered', baseUrl(req));
  res.json({ ok: true, cart_id: cartId, told });
});

/** Cancels a request: a card payment goes back in full on the municipality's account; money paid at the office waits there. */
async function cancel(tenantId, id, { reason, req = null, by = 'staff' }) {
  let owed = null; let row;
  await tx(async (conn) => {
    const r = await C.requestOf(conn, tenantId, id, { lock: true });
    if (['cancelled', 'expired'].includes(r.status)) throw conflict('This request is already canceled');
    if (r.status === 'delivered') throw conflict('This cart is already delivered');
    if (by === 'resident' && r.status === 'scheduled') throw conflict('The delivery day is set. Please call the office to cancel.');
    await conn.query("UPDATE cart_requests SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP(), cancelled_by = ?, cancel_reason = ? WHERE tenant_id = ? AND id = ?",
      [req ? req.auth.userId : null, reason || (by === 'resident' ? 'Canceled by the resident' : null), tenantId, r.id]);
    if (r.pay_method === 'card' && r.pay_status === 'due' && r.stripe_session_id) await require('../lib/stripe').expireCheckout(r.stripe_session_id, { account: r.processor_account || null }); // a payment that still lands is refunded by the webhook
    owed = await C.oweCardRefund(conn, { ...r, tenant_id: tenantId }, by === 'resident' ? 'cart request canceled by the resident' : 'cart request canceled by staff');
    if (r.pay_method === 'office' && r.pay_status === 'paid' && r.paid_cents > 0) await conn.query("UPDATE cart_requests SET pay_status = 'refund_due' WHERE tenant_id = ? AND id = ?", [tenantId, r.id]);
    if (r.pay_status === 'due') await conn.query("UPDATE cart_requests SET pay_status = 'not_needed' WHERE tenant_id = ? AND id = ?", [tenantId, r.id]);
    await audit(conn, req || { auth: { tenantId, userId: null } }, 'cart_cancel', 'cart_requests', r.id, { by, reference: r.reference, refund: Boolean(owed) });
    row = await one(conn, 'SELECT pay_status, refunded_cents FROM cart_requests WHERE tenant_id = ? AND id = ?', [tenantId, r.id]);
  });
  await C.sendRefund(owed);
  return row;
}

router.post('/carts/requests/:id/cancel', office, validate(z.object({ reason: z.string().trim().max(200).optional() })), async (req, res) => {
  const row = await cancel(req.auth.tenantId, paramId(req), { reason: req.body.reason, req });
  await C.tell(req.auth.tenantId, paramId(req), 'cancelled', baseUrl(req), { receipt: true });
  res.json({ ok: true, pay_status: row.pay_status, refunded_cents: row.refunded_cents });
});

router.post('/carts/requests/:id/paid', office, async (req, res) => {
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    const r = await C.requestOf(conn, t, paramId(req), { lock: true });
    if (r.pay_status !== 'due' || ['cancelled', 'expired'].includes(r.status)) throw conflict('This request has nothing to pay');
    if (r.stripe_session_id) await require('../lib/stripe').expireCheckout(r.stripe_session_id, { account: r.processor_account || null });
    await conn.query("UPDATE cart_requests SET pay_method = 'office', pay_status = 'paid', paid_cents = fee_cents, paid_at = UTC_TIMESTAMP(), status = IF(status = 'awaiting_payment', 'open', status) WHERE tenant_id = ? AND id = ?", [t, r.id]);
    await audit(conn, req, 'cart_paid_office', 'cart_requests', r.id, { amount_cents: r.fee_cents });
  });
  res.json({ ok: true });
});

router.post('/carts/requests/:id/refund-given', office, async (req, res) => {
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    const r = await C.requestOf(conn, t, paramId(req), { lock: true });
    if (r.pay_status !== 'refund_due') throw conflict('No refund is waiting at the office for this request');
    await conn.query("UPDATE cart_requests SET pay_status = 'refunded', refunded_cents = paid_cents WHERE tenant_id = ? AND id = ?", [t, r.id]);
    await audit(conn, req, 'cart_refund_given', 'cart_requests', r.id, { amount_cents: r.paid_cents });
  });
  res.json({ ok: true });
});

router.post('/carts/requests/:id/send-link', office, validate(z.object({ by: z.enum(['text', 'email']) })), async (req, res) => {
  const r = await C.requestOf(pool, req.auth.tenantId, paramId(req));
  if (!(r.pay_method === 'card' && r.pay_status === 'due' && ['open', 'scheduled', 'awaiting_payment'].includes(r.status))) throw conflict('Only a request waiting for a card payment has a payment link');
  const sent = await C.tell(req.auth.tenantId, r.id, 'pay_link', baseUrl(req), { receipt: true, only: req.body.by });
  if (!sent.length) throw conflict(req.body.by === 'text' ? 'The text could not be sent. They may not have agreed to texts. Read them the link instead.' : 'The email could not be sent. Check the address, or read them the link instead.');
  await audit(pool, req, 'cart_send_link', 'cart_requests', r.id, { by: req.body.by });
  res.json({ sent });
});

router.get('/carts/stops', anyone, async (req, res) => {
  const t = await townOf(req.auth.tenantId);
  const date = String(req.query.date || todayIn(t.timezone));
  if (!dateStr.safeParse(date).success) throw bad('date must be YYYY-MM-DD');
  const stops = await C.cartStopsFor(pool, t.id, date);
  const stock = await C.stockOf(pool, t.id);
  res.json({ date, today: todayIn(t.timezone), stops, stock });
});

// ---------------------------------------------------------------- stock
router.get('/carts/stock', anyone, async (req, res) => {
  const t = req.auth.tenantId;
  const moves = await rows(pool, `SELECT m.id, m.stream_id, s.name AS stream, m.size_gal, m.delta, m.reason, m.note, m.on_hand, m.created_at FROM cart_stock_moves m
    JOIN collection_streams s ON s.tenant_id = m.tenant_id AND s.id = m.stream_id WHERE m.tenant_id = ? ORDER BY m.id DESC LIMIT 100`, [t]);
  res.json({ stock: await C.stockOf(pool, t), moves });
});
router.post('/carts/stock', crew, validate(z.object({
  stream_id: z.number().int().positive(),
  size_gal: z.number().int().refine((v) => C.SIZES.includes(v), 'Cart sizes are 35, 65 or 95 gallons'),
  reason: z.enum(['received', 'returned', 'scrapped', 'count']),
  quantity: z.number().int().min(0).max(5000),
  note: z.string().trim().max(200).optional().nullable(),
})), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const left = await tx(async (conn) => {
    if (!(await one(conn, 'SELECT id FROM collection_streams WHERE tenant_id = ? AND id = ?', [t, b.stream_id]))) throw bad('Pick the stream from the list');
    let delta;
    if (b.reason === 'count') {
      // A count sets the number in the yard; the move records the difference.
      await conn.query('INSERT IGNORE INTO cart_stock (tenant_id, stream_id, size_gal, on_hand) VALUES (?, ?, ?, 0)', [t, b.stream_id, b.size_gal]);
      const cur = await one(conn, 'SELECT on_hand FROM cart_stock WHERE tenant_id = ? AND stream_id = ? AND size_gal = ? FOR UPDATE', [t, b.stream_id, b.size_gal]);
      delta = b.quantity - Number(cur.on_hand);
    } else {
      if (!b.quantity) throw bad('Give how many carts');
      delta = b.reason === 'scrapped' ? -b.quantity : b.quantity;
    }
    const n = await C.moveStock(conn, t, { streamId: b.stream_id, size: b.size_gal, delta, reason: b.reason, note: b.note || null, by: req.auth.userId });
    await audit(conn, req, 'cart_stock', 'cart_stock', null, { stream_id: b.stream_id, size_gal: b.size_gal, reason: b.reason, delta, on_hand: n });
    return n;
  });
  res.json({ on_hand: left });
});

// ---------------------------------------------------------------- export
/**
 * The requests as a spreadsheet. A public record version by default: no resident name, phone, email or house number
 * (Pennsylvania's Right-to-Know Law). contacts=1 adds them, for managers only, and is written to the audit trail.
 */
router.get('/carts/export', office, async (req, res) => {
  const t = await townOf(req.auth.tenantId);
  const from = String(req.query.from || addDays(todayIn(t.timezone), -365)); const to = String(req.query.to || addDays(todayIn(t.timezone), 120));
  if (!dateStr.safeParse(from).success || !dateStr.safeParse(to).success) throw bad('from and to must be YYYY-MM-DD');
  const contacts = String(req.query.contacts || '') === '1';
  if (contacts && !isManagerRole(req)) throw forbidden('Only a manager can include contact details');
  const list = await rows(pool, `${LIST} WHERE r.tenant_id = ? AND DATE(r.created_at) BETWEEN ? AND ? ORDER BY r.id`, [t.id, from, to]);
  const data = list.map((r) => ({
    reference: r.reference, requested: String(r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at).slice(0, 10), kind: C.KINDS[r.kind], stream: r.stream, size_gal: r.size_gal, street: r.street,
    ...(contacts ? { house_number: r.house_number, unit: r.unit || '', name: r.contact_name || '', phone: r.contact_phone || '', email: r.contact_email || '' } : {}),
    source: r.source, status: r.status, deliver_on: day(r.deliver_on) || '', pay_status: r.pay_status,
    ...(isManagerRole(req) ? { fee_dollars: dollars(r.fee_cents), paid_dollars: dollars(r.paid_cents), refunded_dollars: dollars(r.refunded_cents) } : {}),
  }));
  const cols = ['reference', 'requested', 'kind', 'stream', 'size_gal', 'street', ...(contacts ? ['house_number', 'unit', 'name', 'phone', 'email'] : []), 'source', 'status', 'deliver_on', 'pay_status', ...(isManagerRole(req) ? ['fee_dollars', 'paid_dollars', 'refunded_dollars'] : [])]; // money for owners and managers only (and lib/nomoney.js takes out any *_dollars column)
  await audit(pool, req, contacts ? 'cart_export_contacts' : 'cart_export', 'cart_requests', null, { from, to, rows: data.length, contacts });
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="cart-requests-${from}-to-${to}${contacts ? '-with-contacts' : ''}.csv"`).send(toCsv(cols, data));
});

// ---------------------------------------------------------------- public
async function townFor(slug) {
  const t = await one(pool, "SELECT id, name, slug, phone, timezone FROM tenants WHERE slug = ? AND org_type = 'municipality'", [String(slug)]);
  if (!t) throw notFound('Page');
  return t;
}
const noStore = (res) => res.set('Cache-Control', 'no-store');

publicRouter.get('/:slug/cart-request', async (req, res) => {
  const t = await townFor(req.params.slug); noStore(res);
  const s = await C.settingsOf(t.id);
  const office_name = await officeName(t.id);
  const base = { town: t.name, phone: t.phone, office_name, rules: s.rules_text };
  const options = await C.optionsOf(pool, t.id);
  if (!s.online || !options.length) return res.json({ ...base, open: false, message: `Ask for a cart by calling ${office_name}${t.phone ? ` at ${t.phone}` : ''}.` });
  const ready = await C.cardReady(t.id);
  const streams = [];
  for (const o of options) {
    let st = streams.find((x) => x.id === o.stream_id);
    if (!st) { st = { id: o.stream_id, name: o.stream, sizes: [] }; streams.push(st); }
    st.sizes.push({ size_gal: o.size_gal, extra_fee_cents: o.extra_fee_cents, replacement_fee_cents: o.replacement_fee_cents });
  }
  res.json({ ...base, open: true, kinds: C.KINDS, streams, streets: await streetsOf(pool, t.id), card: ready,
    card_message: ready ? null : `Card payment online is not available right now. If there is a fee, pay it at ${office_name}.` });
});

publicRouter.post('/:slug/cart-request', validate(z.object({ ...requestShape, website: z.string().max(200).optional() })), async (req, res) => {
  const t = await townFor(req.params.slug); noStore(res);
  const b = req.body;
  if (b.website) return res.status(202).json({ ok: true });
  if (await require('../lib/billing').publicBlocked(t.id, req.method)) throw conflict(`Online requests are not available right now. Please call${t.phone ? ` ${t.phone}` : ''}.`);
  const { phone, email } = C.contactOf(b);
  await require('../lib/publicsends').submitAllowed(t.id, { phone, email }, 'cart requests');
  const ready = await C.cardReady(t.id);
  const made = await tx(async (conn) => {
    const s = await C.settingsOf(t.id, conn);
    if (!s.online) throw conflict(`Ask for a cart by calling ${await officeName(t.id)}${t.phone ? ` at ${t.phone}` : ''}.`);
    await C.streetOk(conn, t.id, b.street_id);
    const opt = await C.optionFor(conn, t.id, b.stream_id, b.size_gal);
    const fee = C.feeOf(opt, b.kind);
    // With the municipality's Stripe account not ready, the request is still taken: they pay at the office.
    const pay = fee === 0 ? { pay_method: 'free', pay_status: 'not_needed', status: 'open' } : ready ? { pay_method: 'card', pay_status: 'due', status: 'awaiting_payment' } : { pay_method: 'office', pay_status: 'due', status: 'open' };
    // A public form never changes the resident on file; what was typed stays on the request (lib/residents.js).
    const residentId = await RES.upsertResident(conn, t.id, { name: b.name, phone, email, streetId: b.street_id, houseNumber: b.house_number, unit: b.unit || null, textsOk: b.texts_ok ? true : undefined, emailsOk: b.emails_ok ? true : undefined }, { source: 'report_page', publicForm: true });
    const out = await C.insertRequest(conn, t.id, { ...b, size_gal: opt.size_gal, service_address_id: await C.serviceAddressAt(conn, t.id, b.street_id, b.house_number, b.unit), resident_id: residentId,
      contact_name: b.name, contact_phone: phone, contact_email: email, source: 'online', ...pay, fee_cents: fee });
    await audit(conn, { auth: { tenantId: t.id, userId: null }, ip: req.ip }, 'cart_request_online', 'cart_requests', out.id, { reference: out.reference, kind: b.kind, fee_cents: fee, pay_method: pay.pay_method });
    return { ...out, ...pay, fee };
  });
  const base = baseUrl(req);
  if (made.status === 'awaiting_payment') {
    let url;
    try { url = await C.checkout(t.id, made.id, base); } catch (err) {
      await pool.query("UPDATE cart_requests SET status = 'expired' WHERE tenant_id = ? AND id = ? AND status = 'awaiting_payment'", [t.id, made.id]);
      throw err;
    }
    return res.status(201).json({ reference: made.reference, token: made.view_token, fee_cents: made.fee, checkout_url: url });
  }
  await C.tell(t.id, made.id, 'confirm', base, { receipt: true });
  return res.status(201).json({ reference: made.reference, token: made.view_token, fee_cents: made.fee, pay_method: made.pay_method, pay_status: made.pay_status,
    message: made.pay_method === 'office' ? `Please pay ${money(made.fee)} at ${await officeName(t.id)}.` : null });
});

/** The resident's own request, by its secret link: nothing about anyone else. */
async function residentView(t, tok) {
  if (!/^[a-f0-9]{32}$/.test(String(tok))) return null;
  const r = await one(pool, `${LIST} WHERE r.tenant_id = ? AND r.view_token = ?`, [t.id, String(tok)]);
  if (!r) return null;
  return {
    r, view: {
      reference: r.reference, kind: r.kind, kind_label: C.KINDS[r.kind], stream: r.stream, size_gal: Number(r.size_gal), address: C.addressOf(r), name: r.contact_name, status: r.status, status_words: STATUS_WORDS[r.status],
      deliver_on: day(r.deliver_on), deliver_words: r.deliver_on ? require('../lib/bulkpickup').longDay(r.deliver_on) : null,
      fee_cents: Number(r.fee_cents), pay_method: r.pay_method, pay_status: r.pay_status, paid_cents: Number(r.paid_cents), refunded_cents: Number(r.refunded_cents),
      can_cancel: ['awaiting_payment', 'open'].includes(r.status),
      can_pay: r.pay_method === 'card' && r.pay_status === 'due' && ['awaiting_payment', 'open', 'scheduled', 'expired'].includes(r.status) && await C.cardReady(t.id),
      town: t.name, phone: t.phone, office_name: await officeName(t.id),
      texts_off: Number(r.texts_ok) && r.contact_phone ? await RES.textsOffNotice(pool, t.id, r.contact_phone) : null,
    },
  };
}
publicRouter.get('/:slug/cart-request/:token', async (req, res) => {
  const t = await townFor(req.params.slug); noStore(res);
  const v = await residentView(t, req.params.token);
  if (!v) throw notFound('Cart request');
  res.json(v.view);
});
publicRouter.post('/:slug/cart-request/:token/cancel', async (req, res) => {
  const t = await townFor(req.params.slug); noStore(res);
  const v = await residentView(t, req.params.token);
  if (!v) throw notFound('Cart request');
  await cancel(t.id, v.r.id, { by: 'resident' });
  await C.tell(t.id, v.r.id, 'cancelled', baseUrl(req), { receipt: true });
  res.json((await residentView(t, req.params.token)).view);
});
publicRouter.post('/:slug/cart-request/:token/pay', async (req, res) => {
  const t = await townFor(req.params.slug); noStore(res);
  const v = await residentView(t, req.params.token);
  if (!v) throw notFound('Cart request');
  if (!v.view.can_pay) throw conflict(v.r.pay_status === 'paid' ? 'This request is already paid' : 'This request cannot be paid online. Please pay at the office.');
  if (v.r.status === 'expired') await pool.query("UPDATE cart_requests SET status = 'awaiting_payment' WHERE tenant_id = ? AND id = ? AND status = 'expired'", [t.id, v.r.id]);
  res.json({ checkout_url: await C.checkout(t.id, v.r.id, baseUrl(req)) });
});

module.exports = { router, publicRouter, cancel };
