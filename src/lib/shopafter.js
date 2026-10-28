'use strict';

// After the sale: moving a ticket to another day, the emails around a visit (basket reminder, day-before, thank you),
// and telling the waitlist when a sold-out day opens up. The daily job calls runAll once a day.
const { pool, tx, rows, one } = require('../db');
const { conflict, bad, notFound, Unhonourable } = require('./errors');
const { todayIn, addDays, dayRange } = require('./util');
const { unitPrice } = require('./pricing');
const { loadRules, applyTax } = require('./tax');
const { allowedOn, dayName, daysText } = require('./saledays');
const shopsale = require('./shopsale');
const mailer = require('./mailer');
const stripe = require('./stripe');
const cardrefund = require('./cardrefund');
const { audit } = require('./audit');
const { eachTenant, logFailure } = require('./jobs');
const { isSandbox } = require('./sandbox');

const day10 = (d) => String(d).slice(0, 10);

// ---------------------------------------------------------------- moving a ticket to another day
/**
 * Works out whether one ticket in a paid shop order can move to `newDate`, and what the guest owes.
 * Owed = the fee + any rise over the most the guest has paid for this ticket so far, plus tax on both. A lower price is
 * not refunded. Returns { ticket, product, newPrice, lines, tax, taxes, due, basis }.
 */
async function changeCheck(conn, tenant, shopRow, code, newDate) {
  if (tenant.shop_change_hours === null || tenant.shop_change_hours === undefined) throw conflict('This mountain does not allow date changes online. Please call.');
  if (shopRow.status !== 'paid' || !shopRow.order_id) throw conflict('Only a paid order can be changed');
  const t = await one(conn,
    `SELECT t.id, t.code, t.product_id, t.valid_from, t.valid_to, t.status, t.uses_remaining, i.id AS item_id, i.unit_price_cents, i.tier, i.valid_on, p.name, p.kind, p.valid_days
     FROM tickets t JOIN order_items i ON i.id = t.order_item_id AND i.tenant_id = t.tenant_id JOIN products p ON p.id = t.product_id AND p.tenant_id = t.tenant_id
     WHERE t.tenant_id = ? AND i.order_id = ? AND t.code = ?`, [tenant.id, shopRow.order_id, String(code || '')]);
  if (!t) throw notFound('Ticket');
  if (t.status !== 'active') throw conflict('That ticket cannot be moved');
  if (t.kind !== 'day_ticket' || Number(t.valid_days) !== 1) throw conflict('Only single-day tickets can be moved online. Please call.');
  const scanned = await one(conn, "SELECT id FROM scans WHERE tenant_id = ? AND ticket_id = ? AND result = 'ok' LIMIT 1", [tenant.id, t.id]);
  if (scanned) throw conflict('That ticket has already been used');
  const today = todayIn(tenant.timezone);
  const from = day10(t.valid_from);
  const [startUtc] = dayRange(tenant.timezone, from);
  const hoursLeft = (Date.parse(`${startUtc.replace(' ', 'T')}Z`) - Date.now()) / 3600000;
  if (hoursLeft < tenant.shop_change_hours) throw conflict(`Dates can be changed up to ${tenant.shop_change_hours} hours before the day.`);
  if (newDate === from) throw bad('Pick a different day');
  if (newDate < today) throw bad('Pick today or a later day');
  if (newDate > addDays(today, 365)) throw bad('That day is too far ahead');
  const product = await one(conn, 'SELECT id, kind, name, valid_days, sale_days, online_daily_limit, advance_days, advance_percent FROM products WHERE tenant_id = ? AND id = ?', [tenant.id, t.product_id]);
  if (!allowedOn(product.sale_days, newDate)) throw conflict(`${product.name} is not sold on ${dayName(newDate)}s (${daysText(product.sale_days)})`);
  const use = await shopsale.usage(conn, tenant.id, newDate, newDate);
  if (shopsale.leftOn(use, tenant, product, newDate) < 1) throw conflict(`${product.name} is sold out for ${newDate}`);
  const base = await unitPrice(conn, tenant.id, product.id, t.tier, newDate); // a blackout day throws a 409 here
  const newPrice = shopsale.advance(product, today, newDate, base.cents).cents;
  // What the guest has paid for this ticket so far: the original price, raised by any earlier paid change.
  const prior = await one(conn, "SELECT basis_cents FROM shop_changes WHERE tenant_id = ? AND ticket_id = ? AND status = 'done' AND basis_cents IS NOT NULL ORDER BY id DESC LIMIT 1", [tenant.id, t.id]);
  const paidSoFar = prior ? Math.max(prior.basis_cents, t.unit_price_cents) : t.unit_price_cents;
  const fee = Number(tenant.shop_change_fee_cents || 0);
  const rise = Math.max(0, newPrice - paidSoFar);
  // The price difference is ticket money (taxed like a ticket); the fee is a fee. Both are recorded as fee lines.
  const lines = [{ type: 'ticket', label: 'Price difference', unit: rise, cents: rise }, { type: 'fee', label: 'Date change fee', unit: fee, cents: fee }].filter((l) => l.cents > 0);
  const { tax, taxes } = applyTax(lines, 0, await loadRules(conn, tenant.id));
  const due = lines.reduce((n, l) => n + l.cents, 0) + tax;
  return { ticket: t, product, newPrice, lines, tax, taxes, due, basis: Math.max(paidSoFar, newPrice) };
}

/** Moves the ticket now. Used for free changes and after the card payment lands. */
async function applyChange(conn, tenantId, ticket, newDate) {
  await conn.query('UPDATE tickets SET valid_from = ?, valid_to = ? WHERE tenant_id = ? AND id = ?', [newDate, newDate, tenantId, ticket.id]);
  await conn.query('UPDATE order_items SET valid_on = ? WHERE tenant_id = ? AND id = ?', [newDate, tenantId, ticket.item_id]);
}

/** Starts a change. Free: done. Otherwise a card page is made and the change waits for the payment. */
async function requestChange({ tenant, shopRow, code, newDate, successUrl, cancelUrl }) {
  return tx(async (conn) => {
    await conn.query('SELECT id FROM tenants WHERE id = ? FOR UPDATE', [tenant.id]);
    const c = await changeCheck(conn, tenant, shopRow, code, newDate);
    if (c.due === 0) {
      await applyChange(conn, tenant.id, c.ticket, newDate);
      await conn.query("INSERT INTO shop_changes (tenant_id, shop_order_id, ticket_id, from_date, to_date, due_cents, basis_cents, status) VALUES (?, ?, ?, ?, ?, 0, ?, 'done')", [tenant.id, shopRow.id, c.ticket.id, day10(c.ticket.valid_from), newDate, c.basis]);
      await audit(conn, { auth: { tenantId: tenant.id, userId: null } }, 'shop_change', 'tickets', c.ticket.id, { from: day10(c.ticket.valid_from), to: newDate, due_cents: 0 });
      return { done: true, due_cents: 0 };
    }
    const payTo = await require('./connect').payee(tenant.id, conn);
    if (!payTo.ok) throw conflict('Card payment is not available right now. Please call.');
    const [r] = await conn.query("INSERT INTO shop_changes (tenant_id, shop_order_id, ticket_id, from_date, to_date, due_cents, basis_cents) VALUES (?, ?, ?, ?, ?, ?, ?)", [tenant.id, shopRow.id, c.ticket.id, day10(c.ticket.valid_from), newDate, c.due, c.basis]);
    const co = await stripe.createCheckout({
      amountCents: c.due, name: `${tenant.name}: change of day`, description: `${c.product.name}: ${day10(c.ticket.valid_from)} to ${newDate}`,
      email: shopRow.contact_email, reference: shopRow.reference,
      ...require('./connect').checkoutFor(payTo, c.due, { tenant_id: String(tenant.id), request_id: `chg${r.insertId}`, change_id: String(r.insertId), kind: 'shop_change', reference: shopRow.reference }),
      successUrl, cancelUrl, idempotencyKey: `shopchange-${r.insertId}`,
    });
    await conn.query('UPDATE shop_changes SET stripe_session_id = ? WHERE tenant_id = ? AND id = ?', [co.id, tenant.id, r.insertId]);
    return { done: false, due_cents: c.due, checkout_url: co.url };
  });
}

/** Stripe webhook for a paid change (metadata.kind === 'shop_change'). Anything we cannot honor is refunded in full. */
async function handleChangeWebhook(event, obj) {
  const tenantId = Number(obj.metadata.tenant_id); const id = Number(obj.metadata.change_id);
  if (event.type === 'checkout.session.expired') {
    await pool.query("UPDATE shop_changes SET status = 'expired' WHERE tenant_id = ? AND id = ? AND status = 'awaiting_payment' AND (stripe_session_id = ? OR stripe_session_id IS NULL)", [tenantId, id, obj.id]);
    return { expired: true };
  }
  if (event.type !== 'checkout.session.completed' || obj.payment_status !== 'paid') return { ignored: true };
  let failed = null; let stray = null;
  let out;
  try {
    out = await tx(async (conn) => {
      failed = null; stray = null;
      const ch = await one(conn, 'SELECT * FROM shop_changes WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, id]);
      if (!ch) { logFailure({ job: 'stripe_webhook', tenant: tenantId, message: `a paid card page names date change ${id}, which is not on file` }); return { ignored: true }; }
      // A repeat, including one we refunded, changes nothing (a change refunded before refunds were written down has no
      // payment of its own on file, so its status says it).
      if (ch.status === 'refunded' || await cardrefund.returned(conn, tenantId, obj.payment_intent)) return { duplicate: true };
      if (ch.status === 'done') {
        const paidBy = ch.order_id ? await one(conn, 'SELECT payment_ref FROM orders WHERE tenant_id = ? AND id = ?', [tenantId, ch.order_id]) : null;
        if (paidBy && paidBy.payment_ref === String(obj.payment_intent)) return { duplicate: true };
      }
      // Only a change still waiting for this card page is made; anything else is a payment we cannot honor.
      if (ch.status !== 'awaiting_payment') { stray = `the date change was already ${ch.status}`; return { problem: true }; }
      if (ch.stripe_session_id !== obj.id) { stray = 'it was not the card page saved for this date change'; return { problem: true }; }
      if (Number(obj.amount_total) !== ch.due_cents) { failed = 'the amount did not match'; return { problem: true }; }
      const tenant = await one(conn, 'SELECT id, name, timezone, shop_change_hours, shop_change_fee_cents FROM tenants WHERE id = ?', [tenantId]);
      const shopRow = await one(conn, 'SELECT * FROM shop_orders WHERE tenant_id = ? AND id = ?', [tenantId, ch.shop_order_id]);
      try {
        const to = day10(ch.to_date);
        const c = await changeCheck(conn, tenant, shopRow, (await one(conn, 'SELECT code FROM tickets WHERE tenant_id = ? AND id = ?', [tenantId, ch.ticket_id])).code, to);
        if (c.due !== ch.due_cents) { failed = 'the price changed while you were paying'; return { problem: true }; }
        await applyChange(conn, tenantId, c.ticket, to);
        // The money is its own small order with "fee" lines (not tickets), so the card statement and the books stay in
        // balance and ticket counts are not inflated.
        const orig = await one(conn, 'SELECT person_id FROM orders WHERE tenant_id = ? AND id = ?', [tenantId, shopRow.order_id]);
        const subtotal = c.lines.reduce((n, l) => n + l.cents, 0);
        const [o] = await conn.query("INSERT INTO orders (tenant_id, person_id, user_id, status, subtotal_cents, discount_cents, tax_cents, total_cents, channel, payment_ref) VALUES (?, ?, NULL, 'paid', ?, 0, ?, ?, 'online', ?)", [tenantId, orig ? orig.person_id : null, subtotal, c.tax, c.due, obj.payment_intent]);
        for (const l of c.lines) await conn.query("INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, label, person_id, tier, quantity, unit_price_cents, valid_on, discount_cents, tax_cents) VALUES (?, ?, NULL, 'fee', ?, ?, 'adult', 1, ?, ?, 0, ?)", [tenantId, o.insertId, l.label, orig ? orig.person_id : null, l.cents, to, l.tax || 0]);
        for (const x of c.taxes) await conn.query('INSERT INTO order_taxes (tenant_id, order_id, name, rate_bps, amount_cents) VALUES (?, ?, ?, ?, ?)', [tenantId, o.insertId, x.name, x.rate_bps, x.amount_cents]);
        const payee = require('./connect').paidTo(event);
        await conn.query("INSERT INTO order_payments (tenant_id, order_id, tender, amount_cents, reference, processor, processor_account, platform_fee_cents) VALUES (?, ?, 'card', ?, ?, 'stripe', ?, ?)",
          [tenantId, o.insertId, ch.due_cents, obj.payment_intent, payee.account, payee.feeCents]);
        await conn.query("UPDATE shop_changes SET status = 'done', order_id = ? WHERE tenant_id = ? AND id = ?", [o.insertId, tenantId, id]);
        await audit(conn, { auth: { tenantId, userId: null } }, 'shop_change', 'tickets', ch.ticket_id, { from: day10(ch.from_date), to, due_cents: ch.due_cents });
        return { ok: true };
      } catch (err) { if (err.status && err.status < 500) throw new Unhonourable(err.message); throw err; }
    });
  } catch (err) {
    if (!(err instanceof Unhonourable)) throw err;
    failed = err.message; out = { problem: true }; // rolled back: nothing half-made is kept
  }
  if (stray) return cardrefund.returnStray({ tenantId, kind: 'shop_change', rowId: id, obj, account: event.account || null, why: stray });
  if (failed) {
    // Written down as owed with the change's new state in one step, then sent; retried daily if Stripe is slow.
    const owed = await tx(async (conn) => {
      const [u] = await conn.query("UPDATE shop_changes SET status = 'refunded' WHERE tenant_id = ? AND id = ? AND status = 'awaiting_payment'", [tenantId, id]);
      if (u.affectedRows !== 1) return null;
      return cardrefund.oweReturn(conn, { tenantId, kind: 'shop_change', rowId: id, session: obj.id, paymentIntent: obj.payment_intent, amountCents: Number(obj.amount_total), account: event.account || null, reason: failed });
    });
    if (owed) await cardrefund.sendReturn(owed);
    return { refunded: true };
  }
  return { ok: Boolean(out.ok), duplicate: out.duplicate, ignored: out.ignored };
}

// ---------------------------------------------------------------- the emails around a visit
const link = (base, slug, token) => `${base}/shop/${slug}${token ? `?order=${token}` : ''}`;
const first = (name) => String(name || '').split(' ')[0] || 'there';

/**
 * Claims one email before sending it: only the run whose update changed the row sends, so two runs at once (a retry, a
 * manual run) never send twice. If the send fails the claim is released, so the next run tries again.
 */
const COLS = new Set(['shop_orders.recovery_sent_at', 'shop_orders.reminder_sent_at', 'shop_orders.thanks_sent_at', 'shop_waitlist.notified_at']);
async function claim(table, col, tenantId, id) {
  if (!COLS.has(`${table}.${col}`)) throw new Error('unknown claim');
  const [r] = await pool.query(`UPDATE ${table} SET ${col} = NOW() WHERE tenant_id = ? AND id = ? AND ${col} IS NULL`, [tenantId, id]);
  return r.affectedRows === 1;
}
const release = (table, col, tenantId, id) => pool.query(`UPDATE ${table} SET ${col} = NULL WHERE tenant_id = ? AND id = ?`, [tenantId, id]);

async function mail(tenant, to, subject, text, tag) {
  const r = await mailer.send({ tenantId: tenant.id, to, fromName: tenant.name, subject, text, tag });
  return r.ok;
}

/** One reminder to guests who left a basket without paying (only for mountains that switched it on). */
async function runRecovery(tenant, base) {
  const list = await rows(pool,
    `SELECT s.id, s.contact_name, s.contact_email FROM shop_orders s WHERE s.tenant_id = ? AND s.status IN ('awaiting_payment','expired') AND s.recovery_sent_at IS NULL
       AND s.created_at < DATE_SUB(NOW(), INTERVAL 1 HOUR) AND s.created_at > DATE_SUB(NOW(), INTERVAL 48 HOUR)
       AND NOT EXISTS (SELECT 1 FROM shop_orders p WHERE p.tenant_id = s.tenant_id AND p.contact_email = s.contact_email AND p.status = 'paid' AND p.created_at > s.created_at)
     ORDER BY s.id LIMIT 200`, [tenant.id]);
  let sent = 0; const seen = new Set();
  for (const s of list) {
    if (!(await claim('shop_orders', 'recovery_sent_at', tenant.id, s.id))) continue;
    if (seen.has(s.contact_email)) continue; seen.add(s.contact_email);
    const text = [`Hi ${first(s.contact_name)},`, '', `You started an order at ${tenant.name} but did not finish paying, so nothing was charged and no tickets were held.`, '',
      'If you still want to go, pick your day again here:', link(base, tenant.slug), '', 'We will not send this again.'].join('\n');
    if (await mail(tenant, s.contact_email, `Still planning a day at ${tenant.name}?`, text, 'shop-recovery')) sent += 1; else await release('shop_orders', 'recovery_sent_at', tenant.id, s.id);
  }
  return sent;
}

/** The day before: where to go and how to get in. Sent for every paid order with a ticket for tomorrow. */
async function runReminders(tenant, base) {
  const tomorrow = addDays(todayIn(tenant.timezone), 1);
  const list = await rows(pool,
    `SELECT DISTINCT s.id, s.contact_name, s.contact_email, s.view_token, s.reference FROM shop_orders s JOIN order_items i ON i.order_id = s.order_id AND i.tenant_id = s.tenant_id JOIN tickets t ON t.order_item_id = i.id AND t.tenant_id = i.tenant_id
     WHERE s.tenant_id = ? AND s.status = 'paid' AND s.reminder_sent_at IS NULL AND t.status = 'active' AND t.valid_from <= ? AND t.valid_to >= ? LIMIT 500`, [tenant.id, tomorrow, tomorrow]);
  let sent = 0;
  for (const s of list) {
    if (!(await claim('shop_orders', 'reminder_sent_at', tenant.id, s.id))) continue;
    const text = [`Hi ${first(s.contact_name)},`, '', `See you tomorrow at ${tenant.name}.`, tenant.address ? `Find us: ${tenant.address}` : '', '',
      'Your tickets (open on your phone and turn the brightness up at the gate):', link(base, tenant.slug, s.view_token), '',
      tenant.phone ? `Questions? Call ${tenant.phone}.` : ''].filter((x) => x !== null).join('\n');
    if (await mail(tenant, s.contact_email, `Tomorrow at ${tenant.name}`, text, 'shop-reminder')) sent += 1; else await release('shop_orders', 'reminder_sent_at', tenant.id, s.id);
  }
  return sent;
}

/** The day after the last ticket day: a thank-you with a link to book again. Only for guests who ticked the news box. */
async function runThanks(tenant, base) {
  const yesterday = addDays(todayIn(tenant.timezone), -1);
  const list = await rows(pool,
    `SELECT s.id, s.contact_name, s.contact_email FROM shop_orders s WHERE s.tenant_id = ? AND s.status = 'paid' AND s.news_opt_in = 1 AND s.thanks_sent_at IS NULL
       AND (SELECT MAX(t.valid_to) FROM order_items i JOIN tickets t ON t.order_item_id = i.id AND t.tenant_id = i.tenant_id WHERE i.order_id = s.order_id AND i.tenant_id = s.tenant_id) = ? LIMIT 500`, [tenant.id, yesterday]);
  let sent = 0;
  for (const s of list) {
    if (!(await claim('shop_orders', 'thanks_sent_at', tenant.id, s.id))) continue;
    const text = [`Hi ${first(s.contact_name)},`, '', `Thank you for skiing and riding with us at ${tenant.name}. We hope it was a great day.`, '',
      'Planning the next one? Buy tickets online and skip the line:', link(base, tenant.slug), '', 'You get this because you asked for our news when you bought. Reply to this email and ask us to stop any time.'].join('\n');
    if (await mail(tenant, s.contact_email, `Thanks for visiting ${tenant.name}`, text, 'shop-thanks')) sent += 1; else await release('shop_orders', 'thanks_sent_at', tenant.id, s.id);
  }
  return sent;
}

/** Tells people on the waitlist when their day has room again. Each person is told once. */
async function runWaitlist(tenant, base) {
  const today = todayIn(tenant.timezone);
  const list = await rows(pool, 'SELECT id, email, name, on_date, party_size FROM shop_waitlist WHERE tenant_id = ? AND notified_at IS NULL AND on_date >= ? ORDER BY on_date, id LIMIT 500', [tenant.id, today]);
  let sent = 0; const menus = new Map();
  for (const w of list) {
    const d = day10(w.on_date);
    if (!menus.has(d)) menus.set(d, (await shopsale.dayMenu(pool, tenant, d)).filter((m) => m.available && m.kind !== 'season_pass'));
    const open = menus.get(d);
    if (!open.some((m) => m.left === null || m.left >= w.party_size)) continue;
    if (!(await claim('shop_waitlist', 'notified_at', tenant.id, w.id))) continue;
    const text = [`Hi ${first(w.name)},`, '', `Good news: tickets for ${d} are on sale again at ${tenant.name}. They can go quickly.`, '', link(base, tenant.slug), ''].join('\n');
    if (await mail(tenant, w.email, `Tickets are back for ${d}`, text, 'shop-waitlist')) sent += 1; else await release('shop_waitlist', 'notified_at', tenant.id, w.id);
  }
  return sent;
}

/** Daily: every mountain with the shop on. A failure in one mountain never stops the others. */
async function runAll(base) {
  const out = { recovery: 0, reminders: 0, thanks: 0, waitlist: 0 };
  if (!mailer.enabled()) return out;
  await eachTenant('shop_emails', async (t) => {
    if (await isSandbox(t.id)) return {};
    if (t.shop_recovery) out.recovery += await runRecovery(t, base);
    out.reminders += await runReminders(t, base);
    out.thanks += await runThanks(t, base);
    out.waitlist += await runWaitlist(t, base);
    return {};
  }, { columns: 'id, slug, name, address, phone, timezone, shop_recovery, online_daily_limit', where: 'online_shop = 1' });
  return out;
}

module.exports = { changeCheck, requestChange, handleChangeWebhook, runRecovery, runReminders, runThanks, runWaitlist, runAll };
