'use strict';

const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, dateStr, tierEnum, validate, paramId, newCode, addDays, todayIn, dayRange } = require('../lib/util');
const access = require('../lib/access');
const { unitPrice, applyPromo } = require('../lib/pricing');
const { notFound, conflict, bad } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { personFields, resolvePerson, requiredFor, PURCHASER_KEY } = require('../lib/customers');
const { money } = require('../lib/format');

const cardrefund = require('../lib/cardrefund');
const ACT = require('../lib/activities');
const { loadRules, applyTax } = require('../lib/tax');
const router = express.Router();
const sellers = ['counter', 'manager'];

// The purchaser's details (name, address, phone, ...). Same fields as the customer record; names are required once any detail is sent.
const purchaserSchema = z.object({ ...personFields, first_name: personFields.first_name.optional(), last_name: personFields.last_name.optional() });

const orderSchema = z.object({
  person_id: z.number().int().positive().optional(),
  purchaser: purchaserSchema.optional(),
  channel: z.enum(['window', 'online', 'phone', 'group']).default('window'),
  promo_code: z.string().optional(),
  payment_ref: z.string().max(100).optional(),
  items: z
    .array(
      z.object({
        product_id: z.number().int().positive(),
        tier: tierEnum.default('adult'),
        quantity: z.number().int().min(1).max(200).default(1),
        valid_on: dateStr.optional(),
      }),
    )
    .min(1)
    .max(50),
});

/**
 * Create a paid order and issue one ticket per unit (the simple API sale, for integrations; staff use /checkout).
 * Pricing and tax are always computed on the server; the client never supplies a price. Payment is taken outside this
 * service: pass the processor's reference as payment_ref. It is recorded as one 'other' payment, so refunds, drawers and
 * reports treat it like any other sale.
 */
router.post('/orders', requireRole(...sellers), validate(orderSchema), async (req, res) => {
  const { tenantId } = req.auth;
  const body = req.body;

  const result = await tx(async (conn) => {
    const tenant = await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
    const today = todayIn(tenant.timezone);

    // The purchaser goes into the shared customer record: an existing customer is reused, a new one is created.
    const buyer = await resolvePerson(conn, tenantId, { personId: body.person_id, details: body.purchaser, scope: 'ticket', source: body.channel });
    if (buyer.notFound) throw notFound('Person');
    if (!buyer.id && (await requiredFor(conn, tenantId, 'ticket')).has(PURCHASER_KEY)) throw bad('Purchaser details are required for ticket sales');
    const personId = buyer.id;

    const priced = [];
    let subtotal = 0;
    for (const it of body.items) {
      const validOn = it.valid_on || today;
      if (validOn < today) throw bad('Tickets cannot be sold for a past date');
      const { product, cents } = await unitPrice(conn, tenantId, it.product_id, it.tier, validOn);
      if (!['day_ticket', 'multi_day', 'season_pass', 'punch_card', 'voucher'].includes(product.kind)) {
        throw bad(`${product.name} is a ${product.kind} product and is sold through its own module`);
      }
      priced.push({ it, product, cents, validOn });
      subtotal += cents * it.quantity;
    }

    let discount = 0;
    let promoCode = null;
    if (body.promo_code) {
      promoCode = body.promo_code.toUpperCase();
      const applied = await applyPromo(conn, tenantId, promoCode, subtotal, today, { lock: true });
      discount = applied.discountCents;
      await conn.query('UPDATE promo_codes SET used_count = used_count + 1 WHERE tenant_id = ? AND id = ?', [tenantId, applied.promo.id]);
    }

    const lines = priced.map((p) => ({ type: 'ticket', cents: p.cents * p.it.quantity }));
    const { tax, taxes } = applyTax(lines, discount, await loadRules(conn, tenantId));
    const total = subtotal - discount + tax;
    const [o] = await conn.query(
      `INSERT INTO orders (tenant_id, person_id, user_id, status, promo_code, subtotal_cents, discount_cents, tax_cents, total_cents, channel, payment_ref)
       VALUES (?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, personId, req.auth.userId, promoCode, subtotal, discount, tax, total, body.channel, body.payment_ref ?? null],
    );
    for (const t of taxes) await conn.query('INSERT INTO order_taxes (tenant_id, order_id, name, rate_bps, amount_cents) VALUES (?, ?, ?, ?, ?)', [tenantId, o.insertId, t.name, t.rate_bps, t.amount_cents]);
    if (total > 0) await conn.query("INSERT INTO order_payments (tenant_id, order_id, tender, amount_cents, reference) VALUES (?, ?, 'other', ?, ?)", [tenantId, o.insertId, total, body.payment_ref ?? null]);

    const tickets = [];
    for (const [i, { it, product, cents, validOn }] of priced.entries()) {
      const [item] = await conn.query(
        'INSERT INTO order_items (tenant_id, order_id, product_id, tier, quantity, unit_price_cents, valid_on, discount_cents, tax_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [tenantId, o.insertId, product.id, it.tier, it.quantity, cents, validOn, lines[i].discount, lines[i].tax],
      );
      for (let n = 0; n < it.quantity; n++) {
        const code = newCode();
        const validTo = addDays(validOn, Math.max(product.valid_days, 1) - 1);
        await conn.query(
          'INSERT INTO tickets (tenant_id, order_item_id, person_id, product_id, code, valid_from, valid_to, uses_remaining) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [tenantId, item.insertId, personId, product.id, code, validOn, validTo, product.uses ?? null],
        );
        tickets.push({ code, product: product.name, tier: it.tier, valid_from: validOn, valid_to: validTo });
      }
    }
    await audit(conn, req, 'create', 'orders', o.insertId, { total_cents: total });
    return { id: o.insertId, person_id: personId, customer: buyer.id ? { id: buyer.id, created: buyer.created, matched: buyer.matched } : null, subtotal_cents: subtotal, discount_cents: discount, tax_cents: tax, total_cents: total, tickets };
  });

  res.status(201).json(result);
});

router.get('/orders', requireRole(...sellers), async (req, res) => {
  const where = ['o.tenant_id = ?'];
  const params = [req.auth.tenantId];
  if (req.query.date) {
    const tz = (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId])).timezone;
    const [from, to] = dayRange(tz, String(req.query.date));
    where.push('o.created_at >= ? AND o.created_at < ?');
    params.push(from, to);
  }
  if (req.query.person_id) {
    where.push('o.person_id = ?');
    params.push(Number(req.query.person_id));
  }
  const data = await rows(pool, `SELECT o.* FROM orders o WHERE ${where.join(' AND ')} ORDER BY o.id DESC LIMIT 200`, params);
  res.json({ data });
});

router.get('/orders/:id', requireRole(...sellers), async (req, res) => {
  const order = await one(pool, 'SELECT * FROM orders WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!order) throw notFound('Order');
  const items = await rows(pool, 'SELECT * FROM order_items WHERE tenant_id = ? AND order_id = ?', [req.auth.tenantId, order.id]);
  const tickets = await rows(
    pool,
    'SELECT t.* FROM tickets t JOIN order_items i ON i.id = t.order_item_id AND i.tenant_id = t.tenant_id WHERE t.tenant_id = ? AND i.order_id = ?',
    [req.auth.tenantId, order.id],
  );
  // One readable line per item, whatever it was (ticket, lesson, rental, program place or gift card).
  const lines = await rows(
    pool,
    `SELECT i.id, i.line_kind, i.tier, i.quantity, i.unit_price_cents, i.discount_cents, i.tax_cents, i.refunded_at, i.valid_on, i.person_id, i.session_id, i.contract_id, i.gift_card_id,
            COALESCE(i.label, pr.name, pg.name, CASE i.line_kind WHEN 'gift_card' THEN 'Gift card' WHEN 'rental' THEN 'Rental charge' WHEN 'fee' THEN 'Fee' ELSE 'Item' END) AS name, p.first_name, p.last_name
     FROM order_items i LEFT JOIN products pr ON pr.id = i.product_id AND pr.tenant_id = i.tenant_id
     LEFT JOIN programs pg ON pg.id = i.program_id AND pg.tenant_id = i.tenant_id
     LEFT JOIN people p ON p.id = i.person_id AND p.tenant_id = i.tenant_id
     WHERE i.tenant_id = ? AND i.order_id = ? ORDER BY i.id`,
    [req.auth.tenantId, order.id],
  );
  const payments = await rows(pool, 'SELECT tender, amount_cents, tendered_cents, reference, card_brand, card_last4, comp_reason FROM order_payments WHERE tenant_id = ? AND order_id = ? ORDER BY id', [req.auth.tenantId, order.id]);
  const giftCards = await rows(pool, 'SELECT code, initial_cents, recipient_name, status FROM gift_cards WHERE tenant_id = ? AND order_id = ?', [req.auth.tenantId, order.id]);
  const refunds = await rows(pool, 'SELECT id, reason, note, amount_cents, tax_cents, method, created_at, card_status, card_error FROM order_refunds WHERE tenant_id = ? AND order_id = ? ORDER BY id', [req.auth.tenantId, order.id]);
  const taxes = await rows(pool, 'SELECT name, rate_bps, amount_cents FROM order_taxes WHERE tenant_id = ? AND order_id = ? ORDER BY id', [req.auth.tenantId, order.id]);
  res.json({ ...order, items, lines, tickets, payments, taxes, refunds, gift_cards: giftCards });
});

const REFUND_REASONS = ['customer_request', 'weather', 'injury', 'wrong_item', 'duplicate', 'staff_error', 'other'];
const refundBody = z.object({
  reason: z.enum(REFUND_REASONS),
  note: z.string().trim().max(300).optional(),
  item_ids: z.array(z.number().int().positive()).min(1).max(100).optional(), // omit to refund everything not yet refunded
  method: z.enum(['cash', 'card', 'gift_card', 'other']).optional(), // omit to send the money back the way it came
  till_id: z.number().int().positive().optional(), // the cash drawer that pays out any cash part (default: your own open drawer)
});

/**
 * Refund the whole order or just some of its lines. Every refund records why. Unused tickets are voided, lesson bookings
 * canceled, program places withdrawn, unspent gift cards canceled. Gear that is still out, a gift card that has been spent,
 * a ticket already scanned or a lesson already attended stops the refund, so staff sort that out first. The money goes back the
 * way it came (cash, card, gift card); gift card money is put back on the card, the rest happens at the till or processor.
 */
router.post('/orders/:id/refund', requireRole('manager'), validate(refundBody), async (req, res) => {
  const orderId = paramId(req);
  const { tenantId } = req.auth;
  const body = req.body;
  if (body.reason === 'other' && !body.note) throw bad('Add a note saying why');
  const result = await tx(async (conn) => {
    const order = await one(conn, 'SELECT * FROM orders WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, orderId]);
    if (!order) throw notFound('Order');
    if (order.status !== 'paid') throw conflict(`Order is ${order.status}`);
    const open = await rows(conn, 'SELECT * FROM order_items WHERE tenant_id = ? AND order_id = ? AND refunded_at IS NULL ORDER BY id', [tenantId, orderId]);
    if (!open.length) throw conflict('Everything on this order has been refunded');
    let lines = open;
    if (body.item_ids) {
      lines = open.filter((l) => body.item_ids.includes(l.id));
      if (lines.length !== new Set(body.item_ids).size) throw bad('Some of those lines are not on this order or are already refunded');
    }
    // Check everything first so a refused refund changes nothing.
    // Lock this order's rentals first, so a hand-out at the counter cannot slip in between this check and the refund.
    await rows(conn, 'SELECT id FROM rental_contracts WHERE tenant_id = ? AND order_id = ? FOR UPDATE', [tenantId, orderId]);
    for (const l of lines) {
      if (l.line_kind === 'ticket' || l.line_kind === 'activity') {
        const scanned = await one(conn, `SELECT s.id FROM scans s JOIN tickets t ON t.id = s.ticket_id AND t.tenant_id = s.tenant_id WHERE s.tenant_id = ? AND t.order_item_id = ? AND s.result = 'ok' LIMIT 1`, [tenantId, l.id]);
        if (scanned) throw conflict('A ticket on this order was already used; refund it manually');
      }
      if (l.line_kind === 'rental' && l.contract_id) {
        // locked, so a hand-out at the counter waits for this refund (or this refund sees the gear went out)
        const c = await one(conn, 'SELECT status FROM rental_contracts WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, l.contract_id]);
        // A paid rental not fitted yet (no gear out) can be refunded; it leaves the Ready to fit list below.
        if (c && !['returned', 'to_fit', 'cancelled'].includes(c.status)) throw conflict('The rental gear from this order is not back yet. Check it in first, then refund.');
      }
      if (l.line_kind === 'lesson' && !l.session_id) {
        const c = await one(conn, 'SELECT used FROM lesson_credits WHERE tenant_id = ? AND order_item_id = ?', [tenantId, l.id]);
        if (c && c.used > 0) throw conflict('Some lessons from the package on this order are already used; refund it manually');
      }
      if (l.line_kind === 'lesson' && l.session_id) {
        const b = await one(conn, "SELECT status FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND person_id = ?", [tenantId, l.session_id, l.person_id]);
        if (b && b.status === 'attended') throw conflict('A lesson on this order was already attended; refund it manually');
      }
      if (l.line_kind === 'gift_card' && l.gift_card_id) {
        const g = await one(conn, 'SELECT initial_cents, balance_cents FROM gift_cards WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, l.gift_card_id]);
        if (g && g.balance_cents < g.initial_cents) throw conflict('A gift card sold on this order has already been spent, so it cannot be refunded');
      }
    }
    for (const l of lines) {
      if (l.line_kind === 'rental' && l.contract_id) await conn.query("UPDATE rental_contracts SET status = 'cancelled', stage = NULL WHERE tenant_id = ? AND id = ? AND status = 'to_fit'", [tenantId, l.contract_id]);
    }

    // What the refund is worth: each line's price less its share of any discount, plus its tax. Free-of-charge (comp)
    // payments are not money to give back, so only the part actually paid is refunded.
    const pays = await rows(conn, 'SELECT * FROM order_payments WHERE tenant_id = ? AND order_id = ? ORDER BY id', [tenantId, orderId]);
    const real = pays.filter((p) => p.tender !== 'comp');
    const realPaid = real.reduce((n, p) => n + p.amount_cents, 0);
    const lineValue = (l) => l.unit_price_cents * l.quantity - l.discount_cents + l.tax_cents;
    const worth = lines.reduce((n, l) => n + lineValue(l), 0);
    const worthTax = lines.reduce((n, l) => n + l.tax_cents, 0);
    const ratio = order.total_cents ? realPaid / order.total_cents : 0;
    let amount = Math.round(worth * ratio);
    let taxPart = Math.round(worthTax * ratio);
    if (lines.length === open.length) {
      // The last of the order: return exactly what is left, so rounding on earlier part refunds can never block it.
      const back = await one(conn, 'SELECT COALESCE(SUM(amount_cents), 0) AS cents, COALESCE(SUM(tax_cents), 0) AS tax FROM order_refunds WHERE tenant_id = ? AND order_id = ?', [tenantId, orderId]);
      amount = Math.max(realPaid - Number(back.cents), 0);
      taxPart = Math.max(Math.round(order.tax_cents * ratio) - Number(back.tax), 0);
    }
    // A large refund needs the second check (STEP_UP_REFUND_CENTS, $200 by default).
    const big = Number(process.env.STEP_UP_REFUND_CENTS || 20000);
    if (amount > big) require('../lib/stepup').require(req, `refund more than $${(big / 100).toFixed(0)}`);

    // Send the money back the way it came, last payment first, never more than was paid and not yet returned that way.
    const returned = await rows(conn, 'SELECT method, SUM(amount_cents) AS cents FROM order_refunds WHERE tenant_id = ? AND order_id = ? GROUP BY method', [tenantId, orderId]);
    const left = (tender) => real.filter((p) => p.tender === tender).reduce((n, p) => n + p.amount_cents, 0) - Number((returned.find((r) => r.method === tender) || {}).cents || 0);
    const plan = [];
    let todo = amount;
    const tenders = body.method ? [body.method] : [...new Set(real.map((p) => p.tender).reverse())];
    for (const tender of tenders) {
      if (todo <= 0) break;
      const give = Math.min(todo, Math.max(left(tender), 0));
      if (give > 0) { plan.push({ method: tender, cents: give }); todo -= give; }
    }
    if (todo > 0) throw conflict(body.method ? `Only ${money(Math.max(left(body.method), 0))} is left to return by ${body.method.replace('_', ' ')}` : 'There is not enough left to refund from what was paid');

    // Undo what was sold.
    const ids = lines.map((l) => l.id);
    if (ids.length) await conn.query("UPDATE tickets SET status = 'void' WHERE tenant_id = ? AND order_item_id IN (?)", [tenantId, ids]);
    // An activity's place goes back on sale.
    await ACT.release(conn, tenantId, lines.filter((l) => l.line_kind === 'activity').map((l) => l.id));
    for (const l of lines) {
      if (l.line_kind === 'lesson' && !l.session_id) {
        await conn.query("UPDATE lesson_credits SET status = 'void' WHERE tenant_id = ? AND order_item_id = ?", [tenantId, l.id]);
      } else if (l.line_kind === 'lesson') {
        await conn.query("UPDATE lesson_bookings SET status = 'cancelled' WHERE tenant_id = ? AND session_id = ? AND person_id = ? AND status = 'booked'", [tenantId, l.session_id, l.person_id]);
      } else if (l.line_kind === 'program') {
        const e = await one(conn, 'SELECT id, status FROM program_enrollments WHERE tenant_id = ? AND program_id = ? AND person_id = ?', [tenantId, l.program_id, l.person_id]);
        if (e && e.status !== 'withdrawn') {
          await conn.query("UPDATE program_enrollments SET status = 'withdrawn' WHERE tenant_id = ? AND id = ?", [tenantId, e.id]);
          if (e.status === 'enrolled') {
            const next = await one(conn, "SELECT id FROM program_enrollments WHERE tenant_id = ? AND program_id = ? AND status = 'waitlist' ORDER BY id LIMIT 1", [tenantId, l.program_id]);
            if (next) await conn.query("UPDATE program_enrollments SET status = 'enrolled' WHERE tenant_id = ? AND id = ?", [tenantId, next.id]);
          }
        }
      } else if (l.line_kind === 'gift_card' && l.gift_card_id) {
        const g = await one(conn, 'SELECT balance_cents FROM gift_cards WHERE tenant_id = ? AND id = ?', [tenantId, l.gift_card_id]);
        await conn.query("UPDATE gift_cards SET status = 'void', balance_cents = 0 WHERE tenant_id = ? AND id = ?", [tenantId, l.gift_card_id]);
        await conn.query("INSERT INTO gift_card_txns (tenant_id, gift_card_id, order_id, kind, delta_cents, balance_after_cents) VALUES (?, ?, ?, 'void', ?, 0)", [tenantId, l.gift_card_id, orderId, -g.balance_cents]);
      }
    }
    // Gift card money goes back on the card (unless the card itself has since been canceled).
    const giftBack = plan.find((x) => x.method === 'gift_card');
    if (giftBack) {
      let remaining = giftBack.cents;
      for (const p of pays.filter((x) => x.tender === 'gift_card').reverse()) {
        if (remaining <= 0) break;
        // Each card gets back at most what it paid less what earlier refunds already put back on it.
        const already = await one(conn, "SELECT COALESCE(SUM(delta_cents), 0) AS cents FROM gift_card_txns WHERE tenant_id = ? AND gift_card_id = ? AND order_id = ? AND kind = 'refund'", [tenantId, p.gift_card_id, orderId]);
        const put = Math.min(remaining, Math.max(p.amount_cents - Number(already.cents), 0));
        if (put <= 0) continue;
        const g = await one(conn, 'SELECT status, balance_cents FROM gift_cards WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, p.gift_card_id]);
        if (g && g.status === 'active') {
          const next = g.balance_cents + put;
          await conn.query('UPDATE gift_cards SET balance_cents = ? WHERE tenant_id = ? AND id = ?', [next, tenantId, p.gift_card_id]);
          await conn.query("INSERT INTO gift_card_txns (tenant_id, gift_card_id, order_id, kind, delta_cents, balance_after_cents) VALUES (?, ?, ?, 'refund', ?, ?)", [tenantId, p.gift_card_id, orderId, put, next]);
        }
        remaining -= put;
      }
    }

    // Cash comes out of a drawer: the one chosen, or the refunder's own open drawer, so that drawer's count stays right.
    let tillId = null;
    if (plan.some((x) => x.method === 'cash')) {
      const till = body.till_id
        ? await one(conn, "SELECT id FROM till_sessions WHERE tenant_id = ? AND id = ? AND status = 'open'", [tenantId, body.till_id])
        : await one(conn, "SELECT id FROM till_sessions WHERE tenant_id = ? AND opened_by = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [tenantId, req.auth.userId]);
      if (body.till_id && !till) throw bad('That cash drawer is not open');
      tillId = till ? till.id : null;
    }
    // Card money goes back to each card it came from (an order paid with two cards refunds to both), oldest first.
    const parts = [];
    for (const x of plan) parts.push(...(x.method === 'card' ? await cardrefund.splitCard(conn, tenantId, orderId, pays, x.cents) : [x]));
    // Record it: one row per way the money went back (one per card), the tax split in proportion.
    const refundIds = [];
    const cardRows = [];
    const plans = parts.length ? parts : [{ method: 'other', cents: 0 }]; // a comp-only order has no money to return
    let taxLeft = taxPart;
    for (const [i, x] of plans.entries()) {
      const t = i === plans.length - 1 ? taxLeft : (amount ? Math.round((taxPart * x.cents) / amount) : 0);
      taxLeft -= t;
      const [r] = await conn.query('INSERT INTO order_refunds (tenant_id, order_id, user_id, reason, note, amount_cents, tax_cents, method, till_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [tenantId, orderId, req.auth.userId, body.reason, body.note ?? null, x.cents, t, x.method, x.method === 'cash' ? tillId : null]);
      refundIds.push(r.insertId);
      // Card payments taken through Stripe go back through Stripe: written down as owed now, sent after this commits,
      // retried if Stripe fails. A card taken on a separate machine is refunded on that machine by the desk.
      if (x.method === 'card' && x.cents > 0 && x.ref) { await cardrefund.markPending(conn, tenantId, r.insertId, x.ref); cardRows.push(r.insertId); }
    }
    await conn.query('UPDATE order_items SET refunded_at = NOW(), refund_id = ? WHERE tenant_id = ? AND id IN (?)', [refundIds[0], tenantId, ids]);
    const stillOpen = open.length - lines.length;
    await conn.query('UPDATE orders SET refunded_cents = refunded_cents + ?, status = ? WHERE tenant_id = ? AND id = ?', [amount, stillOpen ? 'paid' : 'refunded', tenantId, orderId]);
    await audit(conn, req, 'refund', 'orders', orderId, { amount_cents: amount, reason: body.reason, lines: ids.length, whole: !stillOpen });
    return { amount_cents: amount, returns: plan.map((x) => ({ method: x.method, amount_cents: x.cents })), whole_order: !stillOpen, refund_ids: refundIds, card_rows: cardRows, item_ids: ids };
  });
  // Online card sales: the money goes back to the guest's card through Stripe. A failure is kept as owed and retried.
  for (const id of result.card_rows) {
    const s = await cardrefund.send(tenantId, id);
    if (s === 'sent') result.card_refunded = true; else if (s === 'failed') result.card_refund_failed = true;
  }
  delete result.card_rows;
  // The guest hears about it: what was refunded, the amount, and where the money goes (lib/salemail.js).
  result.emailed = await require('../lib/salemail').refundEmail(tenantId, orderId, result, require('../lib/baseurl').baseUrl(req)).catch(() => false);
  delete result.item_ids;
  res.json({ ok: true, ...result });
});

/** A manager retries a card refund that Stripe refused or could not be reached for (same idempotency key: never twice). */
router.post('/orders/:id/refunds/:rid/retry', requireRole('manager'), async (req, res) => {
  const r = await one(pool, 'SELECT id, card_status FROM order_refunds WHERE tenant_id = ? AND order_id = ? AND id = ?', [req.auth.tenantId, paramId(req), Number(req.params.rid)]);
  if (!r) throw notFound('Refund');
  if (!['failed', 'pending'].includes(r.card_status)) throw conflict('That refund is not waiting to go back to a card');
  const s = await cardrefund.send(req.auth.tenantId, r.id);
  if (s !== 'sent') throw conflict('Stripe still could not send the refund. Check the Stripe dashboard, then try again.');
  res.json({ ok: true });
});

/**
 * Gate / lift scan. Always returns 200 with a result so scanners can show a clear message;
 * only 'ok' means the guest may ride. Every scan is logged.
 * The ticket can be shown as its barcode (code) or as an RFID card (uid, the chip serial); a code that is not a ticket
 * is tried as a card, so a desk RFID reader that types into the scan box works too.
 * The same ticket scanned again within the pass-back window (a setting, default 120 s) comes back as 'duplicate' so a
 * ticket handed back across the fence is caught; staff can wave it through with override: true. The reply carries the
 * holder's name and photo so the gate can check the face against the ticket.
 */
router.post(
  '/tickets/scan',
  requireRole('counter', 'staff', 'manager'),
  validate(z.object({ code: z.string().trim().min(4).max(64).optional(), uid: z.string().trim().min(4).max(64).optional(), location: z.string().max(100).optional(), override: z.boolean().optional(),
    attraction_id: z.number().int().positive().nullable().optional() }) // scanning at an attraction (activity tickets), not at a lift
    .refine((b) => b.code || b.uid, 'Give the ticket code or the card')),
  async (req, res) => {
    const aid = req.body.attraction_id || null;
    if (aid && !(await one(pool, 'SELECT id FROM attractions WHERE tenant_id = ? AND id = ? AND active = 1', [req.auth.tenantId, aid]))) throw bad('That attraction is not on file');
    const out = await tx((conn) => access.decide(conn, req.auth.tenantId, { code: req.body.code, uid: req.body.uid, location: req.body.location, override: req.body.override, via: req.body.uid ? 'rfid' : 'code', attractionId: aid }));
    delete out.open_ms;
    res.json(out);
  },
);

/** Where the Gate screen can scan: the lifts, or one of the mountain's attractions (for activity tickets). */
router.get('/tickets/scan-places', requireRole('counter', 'staff', 'manager'), async (req, res) => {
  res.json({ attractions: await rows(pool, 'SELECT id, name, type FROM attractions WHERE tenant_id = ? AND active = 1 ORDER BY sort, name', [req.auth.tenantId]) });
});

// ---------------------------------------------------------------- season passes
/** Find a pass by holder name, phone or ticket code: for the gate when a card is left at home. */
router.get('/passes/lookup', requireRole('counter', 'staff', 'manager'), async (req, res) => {
  const { tenantId } = req.auth;
  const q = String(Array.isArray(req.query.q) ? req.query.q[0] : req.query.q || '').trim().slice(0, 60);
  if (q.length < 2) return res.json({ data: [] });
  const tenant = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const today = todayIn(tenant.timezone);
  const digits = q.replace(/\D/g, '');
  const tokens = q.split(/\s+/).filter(Boolean).slice(0, 3).map((t) => t.replace(/[%_]/g, ''));
  const conds = ['t.code = ?'];
  const params = [q.toUpperCase().replace(/[^A-Z0-9]/g, '')];
  if (digits.length >= 4) { conds.push('p.phone_key LIKE ?'); params.push(`%${digits.slice(-10)}`); }
  if (tokens.length) { conds.push(`(${tokens.map(() => '(p.first_name LIKE ? OR p.last_name LIKE ?)').join(' AND ')})`); params.push(...tokens.flatMap((x) => [`${x}%`, `${x}%`])); }
  const data = await rows(pool,
    `SELECT t.code, t.status, t.valid_from, t.valid_to, p.id AS person_id, p.first_name, p.last_name, (p.photo IS NOT NULL) AS has_photo, pr.name AS product,
            (SELECT MAX(s.scanned_at) FROM scans s WHERE s.tenant_id = t.tenant_id AND s.ticket_id = t.id AND s.result = 'ok') AS last_scan
       FROM tickets t JOIN products pr ON pr.id = t.product_id AND pr.tenant_id = t.tenant_id JOIN people p ON p.id = t.person_id AND p.tenant_id = t.tenant_id
      WHERE t.tenant_id = ? AND pr.kind = 'season_pass' AND (${conds.join(' OR ')}) ORDER BY t.valid_to DESC, p.last_name LIMIT 20`, [tenantId, ...params]);
  res.json({ data: data.map((r) => ({ ...r, has_photo: Boolean(r.has_photo), valid_today: r.status === 'active' && r.valid_from <= today && r.valid_to >= today })) });
});

/** Passes that have ended or are about to, with who has not bought another since: the renewal call list. */
router.get('/passes/renewals', requireRole('manager', 'counter'), async (req, res) => {
  const { tenantId } = req.auth;
  const tenant = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const today = todayIn(tenant.timezone);
  const from = addDays(today, -Math.min(Number(req.query.back) || 120, 400));
  const to = addDays(today, Math.min(Number(req.query.ahead) || 45, 200));
  const data = await rows(pool,
    `SELECT t.code, t.valid_to, p.id AS person_id, p.first_name, p.last_name, p.phone, p.email, pr.name AS product,
            EXISTS (SELECT 1 FROM tickets t2 JOIN products pr2 ON pr2.id = t2.product_id AND pr2.tenant_id = t2.tenant_id
                     WHERE t2.tenant_id = t.tenant_id AND t2.person_id = t.person_id AND pr2.kind = 'season_pass' AND t2.valid_to > t.valid_to AND t2.status <> 'void') AS renewed
       FROM tickets t JOIN products pr ON pr.id = t.product_id AND pr.tenant_id = t.tenant_id JOIN people p ON p.id = t.person_id AND p.tenant_id = t.tenant_id
      WHERE t.tenant_id = ? AND pr.kind = 'season_pass' AND t.status <> 'void' AND t.valid_to BETWEEN ? AND ? ORDER BY t.valid_to, p.last_name LIMIT 500`, [tenantId, from, to]);
  const open = data.filter((r) => !r.renewed).map(({ renewed, ...r }) => ({ ...r, expired: r.valid_to < today }));
  res.json({ today, data: open, renewed: data.length - open.length });
});

module.exports = router;
