'use strict';

// Money housekeeping: tax rules, the mountain's receipt details, cash drawers and the end-of-day close,
// card reconciliation against the processor's statement, receipts, and CSV exports for the accountant.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, dateStr, validate, paramId, todayIn, addDays, dayRange, localDay, localTime } = require('../lib/util');
const { notFound, conflict, bad } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { toCsv, dollars } = require('../lib/csv');
const stripe = require('../lib/stripe');

const router = express.Router();
const sellers = requireRole('counter', 'manager');
const managers = requireRole('manager');
const tz = async (tenantId) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;

// ---------------------------------------------------------------- tax rules
const taxBody = z.object({
  name: z.string().trim().min(1).max(80),
  applies_to: z.enum(['all', 'ticket', 'lesson', 'rental', 'program', 'gift_card']).default('all'),
  rate_percent: z.number().min(0).max(30),
  active: z.boolean().optional(),
});
const bps = (pct) => Math.round(pct * 100);
const publicRule = (r) => ({ id: r.id, name: r.name, applies_to: r.applies_to, rate_percent: r.rate_bps / 100, active: Boolean(r.active) });

router.get('/tax-rules', sellers, async (req, res) => {
  res.json({ data: (await rows(pool, 'SELECT * FROM tax_rules WHERE tenant_id = ? ORDER BY id', [req.auth.tenantId])).map(publicRule) });
});
router.post('/tax-rules', managers, validate(taxBody), async (req, res) => {
  const b = req.body;
  const [r] = await pool.query('INSERT INTO tax_rules (tenant_id, name, applies_to, rate_bps, active) VALUES (?, ?, ?, ?, ?)', [req.auth.tenantId, b.name, b.applies_to, bps(b.rate_percent), b.active === false ? 0 : 1]);
  await audit(pool, req, 'create', 'tax_rules', r.insertId, { name: b.name, rate_percent: b.rate_percent });
  res.status(201).json({ id: r.insertId });
});
router.patch('/tax-rules/:id', managers, validate(taxBody.partial()), async (req, res) => {
  const id = paramId(req);
  const cur = await one(pool, 'SELECT * FROM tax_rules WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
  if (!cur) throw notFound('Tax rule');
  const b = req.body;
  await pool.query('UPDATE tax_rules SET name = ?, applies_to = ?, rate_bps = ?, active = ? WHERE tenant_id = ? AND id = ?', [
    b.name ?? cur.name, b.applies_to ?? cur.applies_to, b.rate_percent === undefined ? cur.rate_bps : bps(b.rate_percent), b.active === undefined ? cur.active : (b.active ? 1 : 0), req.auth.tenantId, id,
  ]);
  await audit(pool, req, 'update', 'tax_rules', id, b);
  res.json({ ok: true });
});
router.delete('/tax-rules/:id', managers, async (req, res) => {
  const [r] = await pool.query('DELETE FROM tax_rules WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Tax rule');
  await audit(pool, req, 'delete', 'tax_rules', paramId(req));
  res.json({ ok: true }); // past orders keep the tax they were charged
});

// ---------------------------------------------------------------- the mountain's details (receipts, waiver text, limits)
const PROFILE_COLS = ['name', 'address', 'phone', 'receipt_footer', 'waiver_text', 'require_mfa', 'comp_counter_limit_cents', 'scan_passback_seconds', 'online_booking', 'booking_notice_hours', 'booking_message', 'cancel_hours', 'online_payment', 'online_shop', 'shop_message', 'shop_recovery', 'quick_sale', 'shop_change_hours', 'shop_change_fee_cents', 'weekly_report', 'online_daily_limit', 'refund_full_hours', 'refund_half_hours', 'refund_half_percent', 'cancel_note', 'slug'];
router.get('/tenant/profile', async (req, res) => {
  const t = await one(pool, `SELECT ${PROFILE_COLS.join(', ')}, timezone FROM tenants WHERE id = ?`, [req.auth.tenantId]);
  res.json({ ...t, require_mfa: Boolean(t.require_mfa), online_booking: Boolean(t.online_booking), online_payment: Boolean(t.online_payment), online_shop: Boolean(t.online_shop), shop_recovery: Boolean(t.shop_recovery), quick_sale: Boolean(t.quick_sale), weekly_report: Boolean(t.weekly_report), stripe_ready: stripe.enabled() });
});
router.put('/tenant/profile', managers, validate(z.object({
  name: z.string().trim().min(2).max(255).optional(),
  address: z.string().max(255).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  receipt_footer: z.string().max(500).nullable().optional(),
  waiver_text: z.string().max(20000).nullable().optional(),
  require_mfa: z.boolean().optional(),
  comp_counter_limit_cents: z.number().int().min(0).max(1_000_000).optional(),
  scan_passback_seconds: z.number().int().min(0).max(3600).optional(),
  online_booking: z.boolean().optional(),
  booking_notice_hours: z.number().int().min(0).max(240).optional(),
  booking_message: z.string().max(500).nullable().optional(),
  cancel_hours: z.number().int().min(0).max(240).optional(),
  online_payment: z.boolean().optional(),
  online_shop: z.boolean().optional(),
  shop_recovery: z.boolean().optional(),
  quick_sale: z.boolean().optional(),
  shop_change_hours: z.number().int().min(0).max(720).nullable().optional(),
  shop_change_fee_cents: z.number().int().min(0).max(100000).optional(),
  weekly_report: z.boolean().optional(),
  online_daily_limit: z.number().int().min(1).max(1000000).nullable().optional(),
  shop_message: z.string().max(500).nullable().optional(),
  refund_full_hours: z.number().int().min(0).max(720).optional(),
  refund_half_hours: z.number().int().min(0).max(720).optional(),
  refund_half_percent: z.number().int().min(0).max(100).optional(),
  cancel_note: z.string().max(500).nullable().optional(),
}).refine((x) => x.refund_half_hours === undefined || x.refund_full_hours === undefined || x.refund_half_hours <= x.refund_full_hours, { message: 'The partial-refund cutoff must be later than (fewer hours than) the full-refund cutoff' })), async (req, res) => {
  const b = req.body;
  if (b.require_mfa !== undefined && req.auth.role !== 'owner') throw bad('Only the owner can require two-step sign-in');
  const set = []; const vals = [];
  for (const k of PROFILE_COLS) if (b[k] !== undefined) { set.push(`${k} = ?`); vals.push(['require_mfa', 'online_booking', 'online_payment', 'online_shop', 'weekly_report', 'shop_recovery', 'quick_sale'].includes(k) ? (b[k] ? 1 : 0) : (b[k] === '' ? null : b[k])); }
  if (!set.length) throw bad('Nothing to change');
  await pool.query(`UPDATE tenants SET ${set.join(', ')} WHERE id = ?`, [...vals, req.auth.tenantId]);
  await audit(pool, req, 'update', 'tenants', req.auth.tenantId, Object.keys(b));
  res.json({ ok: true });
});

// ---------------------------------------------------------------- cash drawer
/** Worked-out figures for a drawer: sales by tender, cash in and out, and the cash that should be in it. */
async function tillSummary(conn, till) {
  const end = till.closed_at || '9999-12-31 00:00:00';
  const t = { tenantId: till.tenant_id, user: till.opened_by, from: till.opened_at, to: end };
  const pay = await rows(conn, `SELECT p.tender, COUNT(DISTINCT p.order_id) AS orders, SUM(p.amount_cents) AS cents FROM order_payments p JOIN orders o ON o.id = p.order_id AND o.tenant_id = p.tenant_id
    WHERE p.tenant_id = ? AND o.user_id = ? AND p.created_at >= ? AND p.created_at <= ? GROUP BY p.tender`, [t.tenantId, t.user, t.from, t.to]);
  const by = (k) => Number((pay.find((x) => x.tender === k) || {}).cents || 0);
  const ord = await one(conn, 'SELECT COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS total, COALESCE(SUM(tax_cents), 0) AS tax FROM orders WHERE tenant_id = ? AND user_id = ? AND created_at >= ? AND created_at <= ? AND status <> \'cancelled\'', [t.tenantId, t.user, t.from, t.to]);
  // Refunds paid from this drawer: those recorded against it, plus others by its cashier during the shift that name no drawer.
  const refunds = await rows(conn, 'SELECT method, SUM(amount_cents) AS cents FROM order_refunds WHERE tenant_id = ? AND (till_id = ? OR (till_id IS NULL AND user_id = ? AND created_at >= ? AND created_at <= ?)) GROUP BY method', [t.tenantId, till.id, t.user, t.from, t.to]);
  const cashRefunds = Number((refunds.find((x) => x.method === 'cash') || {}).cents || 0);
  const moves = await rows(conn, 'SELECT kind, SUM(amount_cents) AS cents FROM till_moves WHERE tenant_id = ? AND till_id = ? GROUP BY kind', [till.tenant_id, till.id]);
  const mv = (k) => Number((moves.find((x) => x.kind === k) || {}).cents || 0);
  const expected = till.opening_float_cents + by('cash') + mv('paid_in') - mv('payout') - mv('drop') - cashRefunds;
  return {
    id: till.id, status: till.status, opened_at: till.opened_at, closed_at: till.closed_at, opened_by: till.opened_by,
    opening_float_cents: till.opening_float_cents,
    orders: Number(ord.n), sales_cents: Number(ord.total), tax_cents: Number(ord.tax),
    tenders: Object.fromEntries(['cash', 'card', 'gift_card', 'other', 'comp'].map((k) => [k, by(k)])),
    cash_sales_cents: by('cash'), cash_refunds_cents: cashRefunds, refunds_cents: refunds.reduce((n, r) => n + Number(r.cents), 0),
    paid_in_cents: mv('paid_in'), payouts_cents: mv('payout'), drops_cents: mv('drop'),
    expected_cents: expected, counted_cents: till.counted_cents, variance_cents: till.variance_cents, notes: till.notes,
  };
}
const myTill = (conn, req) => one(conn, "SELECT * FROM till_sessions WHERE tenant_id = ? AND opened_by = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [req.auth.tenantId, req.auth.userId]);

router.get('/till/current', sellers, async (req, res) => {
  const till = await myTill(pool, req);
  res.json({ till: till ? await tillSummary(pool, till) : null });
});
router.post('/till/open', sellers, validate(z.object({ opening_float_cents: z.number().int().min(0).max(10_000_000).default(0) })), async (req, res) => {
  const id = await tx(async (conn) => {
    if (await myTill(conn, req)) throw conflict('You already have a drawer open. Close it first.');
    let r;
    try { [r] = await conn.query('INSERT INTO till_sessions (tenant_id, opened_by, opening_float_cents) VALUES (?, ?, ?)', [req.auth.tenantId, req.auth.userId, req.body.opening_float_cents]); } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') throw conflict('You already have a drawer open. Close it first.'); // a second tap landed at the same moment
      throw e;
    }
    await audit(conn, req, 'open', 'till_sessions', r.insertId, { opening_float_cents: req.body.opening_float_cents });
    return r.insertId;
  });
  res.status(201).json({ id });
});
router.post('/till/moves', sellers, validate(z.object({ kind: z.enum(['paid_in', 'payout', 'drop']), amount_cents: z.number().int().min(1).max(10_000_000), reason: z.string().trim().max(200).optional() })), async (req, res) => {
  if (req.body.kind !== 'paid_in' && !req.body.reason) throw bad('Say what the money was for');
  // Locked like closing is, so a move cannot slip in after the drawer's total was counted.
  const till = await tx(async (conn) => {
    const t = await one(conn, "SELECT * FROM till_sessions WHERE tenant_id = ? AND opened_by = ? AND status = 'open' ORDER BY id DESC LIMIT 1 FOR UPDATE", [req.auth.tenantId, req.auth.userId]);
    if (!t) throw conflict('Open your drawer first');
    await conn.query('INSERT INTO till_moves (tenant_id, till_id, kind, amount_cents, reason) VALUES (?, ?, ?, ?, ?)', [req.auth.tenantId, t.id, req.body.kind, req.body.amount_cents, req.body.reason ?? null]);
    await audit(conn, req, req.body.kind, 'till_sessions', t.id, { amount_cents: req.body.amount_cents });
    return t;
  });
  res.status(201).json({ till: await tillSummary(pool, till) });
});
router.post('/till/close', sellers, validate(z.object({ counted_cents: z.number().int().min(0).max(100_000_000), notes: z.string().trim().max(500).optional() })), async (req, res) => {
  const out = await tx(async (conn) => {
    const till = await one(conn, "SELECT * FROM till_sessions WHERE tenant_id = ? AND opened_by = ? AND status = 'open' ORDER BY id DESC LIMIT 1 FOR UPDATE", [req.auth.tenantId, req.auth.userId]);
    if (!till) throw conflict('You have no drawer open');
    const now = (await one(conn, 'SELECT NOW() AS n')).n;
    const closing = { ...till, closed_at: now };
    const sum = await tillSummary(conn, closing);
    const variance = req.body.counted_cents - sum.expected_cents;
    if (variance !== 0 && !req.body.notes) throw bad(`The drawer is ${variance > 0 ? 'over' : 'short'} by $${(Math.abs(variance) / 100).toFixed(2)}. Add a note saying why, then close.`);
    await conn.query("UPDATE till_sessions SET status = 'closed', closed_at = ?, counted_cents = ?, expected_cents = ?, variance_cents = ?, notes = ? WHERE id = ? AND tenant_id = ?", [now, req.body.counted_cents, sum.expected_cents, variance, req.body.notes ?? null, till.id, req.auth.tenantId]);
    await audit(conn, req, 'close', 'till_sessions', till.id, { counted_cents: req.body.counted_cents, expected_cents: sum.expected_cents, variance_cents: variance });
    return { ...sum, status: 'closed', counted_cents: req.body.counted_cents, variance_cents: variance, notes: req.body.notes ?? null };
  });
  res.json({ till: out });
});
router.get('/till', managers, async (req, res) => {
  const zone = await tz(req.auth.tenantId);
  const date = req.query.date ? String(req.query.date) : todayIn(zone);
  if (!dateStr.safeParse(date).success) throw bad('date must be YYYY-MM-DD');
  const [from, to] = dayRange(zone, date);
  const sessions = await rows(pool, `SELECT s.*, u.email FROM till_sessions s JOIN users u ON u.id = s.opened_by WHERE s.tenant_id = ? AND ((s.opened_at >= ? AND s.opened_at < ?) OR s.status = 'open') ORDER BY s.id DESC LIMIT 100`, [req.auth.tenantId, from, to]);
  const data = [];
  for (const s of sessions) data.push({ ...(await tillSummary(pool, s)), email: s.email });
  res.json({ date, data });
});

// ---------------------------------------------------------------- card reconciliation
const keyOf = (v) => String(v || '').trim().toLowerCase();
router.post('/reconcile/cards', managers, validate(z.object({
  from: dateStr.optional(), to: dateStr.optional(),
  rows: z.array(z.object({ reference: z.string().max(100), amount_cents: z.number().int() })).max(5000),
})), async (req, res) => {
  const zone = await tz(req.auth.tenantId);
  const from = req.body.from || todayIn(zone);
  const to = req.body.to || from;
  const [start] = dayRange(zone, from);
  const [, end] = dayRange(zone, to);
  const ours = await rows(pool, `SELECT p.id, p.order_id, p.amount_cents, p.reference, p.auth_code FROM order_payments p JOIN orders o ON o.id = p.order_id AND o.tenant_id = p.tenant_id
    WHERE p.tenant_id = ? AND p.tender = 'card' AND p.created_at >= ? AND p.created_at < ? ORDER BY p.id`, [req.auth.tenantId, start, end]);
  const theirs = new Map();
  for (const r of req.body.rows) { const k = keyOf(r.reference); if (k) theirs.set(k, (theirs.get(k) || 0) + r.amount_cents); }
  const matched = []; const mismatched = []; const onlyOurs = [];
  const seen = new Set();
  for (const p of ours) {
    const k = [keyOf(p.reference), keyOf(p.auth_code)].find((x) => x && theirs.has(x));
    if (!k) { onlyOurs.push({ order_id: p.order_id, amount_cents: p.amount_cents, reference: p.reference || p.auth_code || null }); continue; }
    seen.add(k);
    if (theirs.get(k) === p.amount_cents) matched.push({ order_id: p.order_id, reference: k, amount_cents: p.amount_cents });
    else mismatched.push({ order_id: p.order_id, reference: k, our_cents: p.amount_cents, processor_cents: theirs.get(k) });
  }
  const onlyFile = [...theirs.entries()].filter(([k]) => !seen.has(k)).map(([reference, amount_cents]) => ({ reference, amount_cents }));
  res.json({
    from, to, system_total_cents: ours.reduce((n, p) => n + p.amount_cents, 0), processor_total_cents: [...theirs.values()].reduce((n, v) => n + v, 0),
    matched: matched.length, matched_cents: matched.reduce((n, m) => n + m.amount_cents, 0), mismatched, only_in_system: onlyOurs, only_in_file: onlyFile,
  });
});

// ---------------------------------------------------------------- receipts
router.get('/orders/:id/receipt', sellers, async (req, res) => {
  const { tenantId } = req.auth;
  const order = await one(pool, 'SELECT * FROM orders WHERE tenant_id = ? AND id = ?', [tenantId, paramId(req)]);
  if (!order) throw notFound('Order');
  const t = await one(pool, 'SELECT name, address, phone, receipt_footer, timezone FROM tenants WHERE id = ?', [tenantId]);
  const lines = await rows(pool, `SELECT i.id, i.line_kind, i.tier, i.quantity, i.unit_price_cents, i.discount_cents, i.tax_cents, i.refunded_at, i.valid_on, COALESCE(i.label, pr.name, pg.name, CASE i.line_kind WHEN 'gift_card' THEN 'Gift card' WHEN 'rental' THEN 'Rental charge' WHEN 'fee' THEN 'Fee' ELSE 'Item' END) AS name, p.first_name, p.last_name
    FROM order_items i LEFT JOIN products pr ON pr.id = i.product_id AND pr.tenant_id = i.tenant_id LEFT JOIN programs pg ON pg.id = i.program_id AND pg.tenant_id = i.tenant_id
    LEFT JOIN people p ON p.id = i.person_id AND p.tenant_id = i.tenant_id WHERE i.tenant_id = ? AND i.order_id = ? ORDER BY i.id`, [tenantId, order.id]);
  const payments = await rows(pool, 'SELECT tender, amount_cents, tendered_cents, card_brand, card_last4, comp_reason FROM order_payments WHERE tenant_id = ? AND order_id = ? ORDER BY id', [tenantId, order.id]);
  const taxes = await rows(pool, 'SELECT name, rate_bps, amount_cents FROM order_taxes WHERE tenant_id = ? AND order_id = ? ORDER BY id', [tenantId, order.id]);
  const tickets = await rows(pool, `SELECT tk.code, tk.valid_from, tk.valid_to, tk.uses_remaining, tk.status, pr.name AS product, pr.kind, p.first_name, p.last_name, i.tier
    FROM tickets tk JOIN order_items i ON i.id = tk.order_item_id AND i.tenant_id = tk.tenant_id JOIN products pr ON pr.id = tk.product_id AND pr.tenant_id = tk.tenant_id
    LEFT JOIN people p ON p.id = tk.person_id AND p.tenant_id = tk.tenant_id WHERE tk.tenant_id = ? AND i.order_id = ? ORDER BY tk.id`, [tenantId, order.id]);
  const giftCards = await rows(pool, 'SELECT code, initial_cents, recipient_name FROM gift_cards WHERE tenant_id = ? AND order_id = ?', [tenantId, order.id]);
  const buyer = order.person_id ? await one(pool, 'SELECT first_name, last_name, email FROM people WHERE tenant_id = ? AND id = ?', [tenantId, order.person_id]) : null;
  const cashier = order.user_id ? await one(pool, 'SELECT email FROM users WHERE tenant_id = ? AND id = ?', [tenantId, order.user_id]) : null;
  const change = payments.filter((p) => p.tender === 'cash' && p.tendered_cents > p.amount_cents).reduce((n, p) => n + p.tendered_cents - p.amount_cents, 0);
  res.json({
    mountain: { name: t.name, address: t.address, phone: t.phone, footer: t.receipt_footer },
    order: { id: order.id, status: order.status, at: localTime(order.created_at, t.timezone), channel: order.channel, cashier: cashier ? cashier.email.split('@')[0] : null,
      subtotal_cents: order.subtotal_cents, discount_cents: order.discount_cents, tax_cents: order.tax_cents, total_cents: order.total_cents, refunded_cents: order.refunded_cents, promo_code: order.promo_code, change_due_cents: change },
    customer: buyer, lines, taxes, payments, tickets, gift_cards: giftCards,
  });
});

// ---------------------------------------------------------------- exports for the accountant
async function range(req) {
  const zone = await tz(req.auth.tenantId);
  const to = req.query.to ? String(req.query.to) : todayIn(zone);
  const from = req.query.from ? String(req.query.from) : addDays(to, -30);
  if (!dateStr.safeParse(from).success || !dateStr.safeParse(to).success) throw bad('from and to must be YYYY-MM-DD');
  if (from > to) throw bad('from must not be after to');
  if (Date.parse(to) - Date.parse(from) > 366 * 864e5) throw bad('Choose a range of a year or less');
  return { zone, from, to, start: dayRange(zone, from)[0], end: dayRange(zone, to)[1] };
}
const send = (res, name, body) => res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${name}"`).send(body);

router.get('/exports/sales.csv', managers, async (req, res) => {
  const r = await range(req);
  const data = await rows(pool, `SELECT o.id AS order_id, o.created_at, o.channel, o.status AS order_status, o.promo_code, i.line_kind, COALESCE(i.label, pr.name, pg.name, CASE i.line_kind WHEN 'gift_card' THEN 'Gift card' WHEN 'rental' THEN 'Rental charge' WHEN 'fee' THEN 'Fee' ELSE 'Item' END) AS item, i.tier, i.quantity, i.unit_price_cents, i.discount_cents, i.tax_cents,
      i.refunded_at, p.first_name, p.last_name, u.email AS sold_by,
      (SELECT GROUP_CONCAT(CONCAT(py.tender, ' ', FORMAT(py.amount_cents / 100, 2)) SEPARATOR '; ') FROM order_payments py WHERE py.order_id = o.id AND py.tenant_id = o.tenant_id) AS paid_by
    FROM order_items i JOIN orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id LEFT JOIN products pr ON pr.id = i.product_id AND pr.tenant_id = i.tenant_id
    LEFT JOIN programs pg ON pg.id = i.program_id AND pg.tenant_id = i.tenant_id LEFT JOIN people p ON p.id = i.person_id AND p.tenant_id = i.tenant_id LEFT JOIN users u ON u.id = o.user_id
    WHERE o.tenant_id = ? AND o.created_at >= ? AND o.created_at < ? ORDER BY o.id, i.id`, [req.auth.tenantId, r.start, r.end]);
  const out = data.map((d) => ({
    date: localDay(d.created_at, r.zone), time: localTime(d.created_at, r.zone).slice(11), order: d.order_id, status: d.order_status, channel: d.channel, type: d.line_kind, item: d.item, guest_type: d.tier, for: [d.first_name, d.last_name].filter(Boolean).join(' '),
    quantity: d.quantity, unit_price: dollars(d.unit_price_cents), discount: dollars(d.discount_cents), tax: dollars(d.tax_cents), line_total: dollars(d.unit_price_cents * d.quantity - d.discount_cents + d.tax_cents),
    refunded: d.refunded_at ? 'yes' : '', promo: d.promo_code, sold_by: d.sold_by, paid_by: d.paid_by,
  }));
  await audit(pool, req, 'export', 'sales', null, { from: r.from, to: r.to, rows: out.length });
  send(res, `sales-${r.from}-to-${r.to}.csv`, toCsv(['date', 'time', 'order', 'status', 'channel', 'type', 'item', 'guest_type', 'for', 'quantity', 'unit_price', 'discount', 'tax', 'line_total', 'refunded', 'promo', 'sold_by', 'paid_by'], out));
});

router.get('/exports/payments.csv', managers, async (req, res) => {
  const r = await range(req);
  const data = await rows(pool, `SELECT p.created_at, p.order_id, p.tender, p.amount_cents, p.tendered_cents, p.reference, p.card_brand, p.card_last4, p.auth_code, p.processor, p.comp_reason
    FROM order_payments p WHERE p.tenant_id = ? AND p.created_at >= ? AND p.created_at < ? ORDER BY p.id`, [req.auth.tenantId, r.start, r.end]);
  const out = data.map((d) => ({ date: localDay(d.created_at, r.zone), time: localTime(d.created_at, r.zone).slice(11), order: d.order_id, tender: d.tender, amount: dollars(d.amount_cents), cash_handed_over: dollars(d.tendered_cents), reference: d.reference, card_brand: d.card_brand, card_last4: d.card_last4, auth_code: d.auth_code, processor: d.processor, comp_reason: d.comp_reason }));
  await audit(pool, req, 'export', 'payments', null, { from: r.from, to: r.to, rows: out.length });
  send(res, `payments-${r.from}-to-${r.to}.csv`, toCsv(['date', 'time', 'order', 'tender', 'amount', 'cash_handed_over', 'reference', 'card_brand', 'card_last4', 'auth_code', 'processor', 'comp_reason'], out));
});

router.get('/exports/refunds.csv', managers, async (req, res) => {
  const r = await range(req);
  const data = await rows(pool, `SELECT f.created_at, f.order_id, f.reason, f.note, f.amount_cents, f.tax_cents, f.method, u.email AS by_user FROM order_refunds f LEFT JOIN users u ON u.id = f.user_id
    WHERE f.tenant_id = ? AND f.created_at >= ? AND f.created_at < ? ORDER BY f.id`, [req.auth.tenantId, r.start, r.end]);
  const out = data.map((d) => ({ date: localDay(d.created_at, r.zone), order: d.order_id, reason: d.reason, note: d.note, amount: dollars(d.amount_cents), tax: dollars(d.tax_cents), method: d.method, refunded_by: d.by_user }));
  await audit(pool, req, 'export', 'refunds', null, { from: r.from, to: r.to, rows: out.length });
  send(res, `refunds-${r.from}-to-${r.to}.csv`, toCsv(['date', 'order', 'reason', 'note', 'amount', 'tax', 'method', 'refunded_by'], out));
});

/** One row per day, shaped for a journal entry: sales, discounts, tax by rule, gift cards sold and spent, comps, refunds, and takings by tender. */
router.get('/exports/daily-summary.csv', managers, async (req, res) => {
  const r = await range(req);
  const t = r.zone;
  const days = new Map();
  const day = (d) => { if (!days.has(d)) days.set(d, { date: d, orders: 0, gross_sales: 0, discounts: 0, tax: 0, gift_cards_sold: 0, comps: 0, refunds: 0, cash: 0, card: 0, gift_card_redeemed: 0, other: 0, taxes: {} }); return days.get(d); };
  const orders = await rows(pool, "SELECT id, created_at, subtotal_cents, discount_cents, tax_cents, status FROM orders WHERE tenant_id = ? AND created_at >= ? AND created_at < ? AND status IN ('paid','refunded')", [req.auth.tenantId, r.start, r.end]);
  const dayOfOrder = new Map(orders.map((o) => [o.id, localDay(o.created_at, t)]));
  for (const o of orders) { const d = day(dayOfOrder.get(o.id)); d.orders += 1; d.gross_sales += o.subtotal_cents; d.discounts += o.discount_cents; d.tax += o.tax_cents; }
  for (const g of await rows(pool, "SELECT i.order_id, SUM(i.unit_price_cents * i.quantity) AS cents FROM order_items i JOIN orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id WHERE i.tenant_id = ? AND i.line_kind = 'gift_card' AND o.created_at >= ? AND o.created_at < ? GROUP BY i.order_id", [req.auth.tenantId, r.start, r.end])) day(dayOfOrder.get(g.order_id)).gift_cards_sold += Number(g.cents);
  for (const p of await rows(pool, 'SELECT p.order_id, p.tender, p.amount_cents FROM order_payments p WHERE p.tenant_id = ? AND p.created_at >= ? AND p.created_at < ?', [req.auth.tenantId, r.start, r.end])) {
    const d = dayOfOrder.has(p.order_id) ? day(dayOfOrder.get(p.order_id)) : null;
    if (!d) continue;
    if (p.tender === 'comp') d.comps += p.amount_cents; else if (p.tender === 'gift_card') d.gift_card_redeemed += p.amount_cents; else d[p.tender] += p.amount_cents;
  }
  for (const f of await rows(pool, 'SELECT created_at, amount_cents FROM order_refunds WHERE tenant_id = ? AND created_at >= ? AND created_at < ?', [req.auth.tenantId, r.start, r.end])) day(localDay(f.created_at, t)).refunds += f.amount_cents;
  const rules = await rows(pool, 'SELECT ot.order_id, ot.name, ot.amount_cents FROM order_taxes ot WHERE ot.tenant_id = ? AND ot.order_id IN (SELECT id FROM orders WHERE tenant_id = ? AND created_at >= ? AND created_at < ?)', [req.auth.tenantId, req.auth.tenantId, r.start, r.end]);
  const names = [...new Set(rules.map((x) => x.name))].sort();
  for (const x of rules) { const d = day(dayOfOrder.get(x.order_id)); d.taxes[x.name] = (d.taxes[x.name] || 0) + x.amount_cents; }
  const out = [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({
    date: d.date, orders: d.orders, gross_sales: dollars(d.gross_sales), discounts: dollars(d.discounts), net_sales: dollars(d.gross_sales - d.discounts - d.gift_cards_sold), tax_total: dollars(d.tax),
    ...Object.fromEntries(names.map((n) => [`tax: ${n}`, dollars(d.taxes[n] || 0)])),
    gift_cards_sold: dollars(d.gift_cards_sold), gift_cards_redeemed: dollars(d.gift_card_redeemed), comps: dollars(d.comps), refunds: dollars(d.refunds), cash: dollars(d.cash), card: dollars(d.card), other: dollars(d.other),
  }));
  await audit(pool, req, 'export', 'daily_summary', null, { from: r.from, to: r.to, rows: out.length });
  send(res, `daily-summary-${r.from}-to-${r.to}.csv`, toCsv(['date', 'orders', 'gross_sales', 'discounts', 'net_sales', 'tax_total', ...names.map((n) => `tax: ${n}`), 'gift_cards_sold', 'gift_cards_redeemed', 'comps', 'refunds', 'cash', 'card', 'other'], out));
});

module.exports = router;
