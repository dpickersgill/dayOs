'use strict';
// Payment plans (Track FAIR): a season pass (or a product a manager marks) paid in N monthly installments on the
// mountain's own Stripe account. The first is paid at checkout with the card saved for later (setup_future_usage); the
// guests job charges the rest off-session on their days. A failed payment is tried again twice over a week, with an
// email and an "update your card" page each time; after the third failure the pass is held at the gate (lib/fairprice.js
// holdFor) until it is paid. A manager sees every plan, its schedule and status, and can charge now, cancel or settle.
//
// The provider seam: payment_plans.provider and fair_cards.provider are 'stripe' today. Affirm (or another lender) is a
// second PROVIDERS entry with its own quote, start and charge; nothing else in the app needs to change.
const { pool, tx, rows, one } = require('../db');
const stripe = require('./stripe');
const connect = require('./connect');
const G = require('./guestsettings');
const F = require('./fairprice');
const { audit } = require('./audit');
const { money, dayText } = require('./format');
const { addDays, todayIn } = require('./util');
const { conflict, notFound, bad } = require('./errors');

const PROVIDERS = ['stripe'];
const RETRY_DAYS = [3, 4]; // after the first failure, again 3 days later, then 4 days after that: a week in all
const dstr = (d) => String(d || '').slice(0, 10);
/** The same day of the month, N months on (the 31st becomes the month's last day). */
function addMonths(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}
/** Splits a total into N installments: the first takes the odd cents, so every later one is the same. */
function split(total, count) {
  const per = Math.floor(total / count);
  return [total - per * (count - 1), ...Array(count - 1).fill(per)];
}
/** The schedule: [{ n, on, cents }] from day, monthly. */
const schedule = (total, count, day) => split(total, count).map((cents, i) => ({ n: i + 1, on: addMonths(day, i), cents }));

/** Products that can be paid in a plan: season passes, and products a manager marked. */
async function planProducts(db, tenantId, ids) {
  if (!ids.length) return [];
  return rows(db, `SELECT p.id FROM products p LEFT JOIN fair_products f ON f.tenant_id = p.tenant_id AND f.product_id = p.id
    WHERE p.tenant_id = ? AND p.id IN (?) AND (p.kind = 'season_pass' OR f.plan_ok = 1)`, [tenantId, ids]);
}

/**
 * Is a plan offered for this basket? basket: { lines: [{ product_id }], total_cents }. Returns { available: false } or
 * { available: true, count, first_cents, then: [{ on, cents }], provider }. Needs the setting on, the mountain's card
 * payments ready, a pass (or a marked product) in the basket and at least 1.00 per installment.
 */
async function quote(db, tenantId, basket) {
  const s = await G.get(db, tenantId);
  if (!Number(s.plans_on)) return { available: false };
  const total = Number(basket && basket.total_cents);
  const count = Number(s.plans_count) || 3;
  if (!(total >= count * 100)) return { available: false };
  const ids = [...new Set(((basket && basket.lines) || []).map((l) => Number(l.product_id)).filter(Boolean))];
  if (!(await planProducts(db, tenantId, ids)).length) return { available: false };
  if (!(await connect.payee(tenantId, db)).ok) return { available: false };
  const t = await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const sch = schedule(total, count, basket.today || todayIn(t.timezone));
  return { available: true, provider: 'stripe', count, first_cents: sch[0].cents, then: sch.slice(1).map((x) => ({ on: x.on, cents: x.cents })), words: `Pay in ${count}: ${money(sch[0].cents)} today, then ${money(sch[1].cents)} a month` };
}

/**
 * What the shop adds to its Stripe Checkout page when the guest picks a plan: charge the first installment and keep
 * the card on the mountain's account for the rest (lib/stripe.js createCheckout `extra`).
 */
const checkoutExtra = () => ({ customer_creation: 'always', payment_intent_data: { setup_future_usage: 'off_session' } });

/**
 * Starts a plan for a paid order, inside its transaction (contract). order: { id (orders.id), person_id, email, name,
 * total_cents, payment_intent, customer, account }. opts: { count, today }. The first installment is the payment just
 * made; the card is read from that payment the first time it is needed. Returns the plan id (the same id again for the
 * same order).
 */
async function start(conn, tenantId, order, opts = {}) {
  const had = await one(conn, 'SELECT id FROM payment_plans WHERE tenant_id = ? AND order_id = ?', [tenantId, order.id]);
  if (had) return had.id;
  const s = await G.get(conn, tenantId);
  const count = Number(opts.count || s.plans_count || 3);
  const t = await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const today = opts.today || todayIn(t.timezone);
  const total = Number(order.total_cents);
  const sch = schedule(total, count, today);
  const [c] = await conn.query('INSERT INTO fair_cards (tenant_id, person_id, email, provider, account, customer, payment_intent, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [tenantId, order.person_id || null, order.email || null, 'stripe', order.account || null, order.customer || null, order.payment_intent || null, order.payment_method || null]);
  const [p] = await conn.query('INSERT INTO payment_plans (tenant_id, order_id, person_id, email, name, provider, card_id, count, total_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [tenantId, order.id, order.person_id || null, order.email || null, order.name || null, 'stripe', c.insertId, count, total]);
  for (const x of sch) {
    await conn.query('INSERT INTO payment_plan_charges (tenant_id, plan_id, n, due_on, cents, status, reference, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [tenantId, p.insertId, x.n, x.on, x.cents, x.n === 1 ? 'paid' : 'due', x.n === 1 ? (order.payment_intent || null) : null, x.n === 1 ? new Date() : null]);
  }
  await audit(conn, F.system(tenantId), 'plan_started', 'payment_plans', p.insertId, { order_id: order.id, count, total_cents: total, first_cents: sch[0].cents });
  return p.insertId;
}

// ---------------------------------------------------------------- the card
/** Fills in the saved card's payment method from the first payment, once. Returns the card row. */
async function cardReady(card) {
  if (card.payment_method || !card.payment_intent) return card;
  const r = await stripe.get(`/v1/payment_intents/${encodeURIComponent(card.payment_intent)}?expand[]=payment_method`, { account: card.account || null });
  const pm = r.payment_method && typeof r.payment_method === 'object' ? r.payment_method : { id: r.payment_method };
  const customer = card.customer || (typeof r.customer === 'object' && r.customer ? r.customer.id : r.customer) || null;
  await pool.query('UPDATE fair_cards SET payment_method = ?, customer = ?, brand = ?, last4 = ? WHERE id = ?', [pm.id || null, customer, (pm.card && pm.card.brand) || null, (pm.card && pm.card.last4) || null, card.id]);
  return { ...card, payment_method: pm.id || null, customer, brand: (pm.card && pm.card.brand) || null, last4: (pm.card && pm.card.last4) || null };
}

/** Charges one installment now, under a row lock (the job, a manager, or a new card). Returns 'paid' or 'failed'. */
async function chargeOne(chargeId, { base = null, notify = true } = {}) {
  const out = await tx(async (conn) => {
    const ch = await one(conn, "SELECT * FROM payment_plan_charges WHERE id = ? AND status IN ('due','failed') FOR UPDATE", [chargeId]);
    if (!ch) return { result: 'skipped' };
    const plan = await one(conn, 'SELECT * FROM payment_plans WHERE id = ? FOR UPDATE', [ch.plan_id]);
    if (!['active', 'late', 'suspended'].includes(plan.status)) return { result: 'skipped' };
    let card = await one(conn, 'SELECT * FROM fair_cards WHERE id = ?', [plan.card_id]);
    let error = null; let ref = null; let fee = 0;
    try {
      card = await cardReady(card);
      if (!card || !card.payment_method || !card.customer) throw new Error('No saved card');
      const p = await connect.payee(plan.tenant_id, conn);
      fee = p.ok && (p.account || null) === (card.account || null) ? connect.feeFor(p, Number(ch.cents)) : 0;
      const r = await stripe.tryCall('/v1/payment_intents', {
        amount: Number(ch.cents), currency: 'usd', customer: card.customer, payment_method: card.payment_method, payment_method_types: ['card'], off_session: true, confirm: true,
        description: `Payment ${ch.n} of ${plan.count}, order ${plan.order_id}`, metadata: { tenant_id: String(plan.tenant_id), kind: 'payment_plan', plan_id: String(plan.id), charge_id: String(ch.id) },
        ...(fee ? { application_fee_amount: fee } : {}),
      }, { account: card.account || null, idempotencyKey: `plan-charge-${ch.id}-${ch.attempts + 1}` });
      if (!r.ok) error = r.error;
      else if (r.json.status !== 'succeeded') error = 'The bank asked the guest to confirm this payment';
      else ref = r.json.id;
    } catch (err) { error = err.message || 'The card could not be charged'; }
    const today = todayIn((await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [plan.tenant_id])).timezone);
    if (ref) {
      await conn.query("UPDATE payment_plan_charges SET status = 'paid', attempts = attempts + 1, reference = ?, paid_at = UTC_TIMESTAMP(), last_error = NULL, next_try_on = NULL WHERE id = ?", [ref, ch.id]);
      await conn.query("INSERT INTO order_payments (tenant_id, order_id, tender, amount_cents, reference, card_brand, card_last4, processor, processor_account, platform_fee_cents) VALUES (?, ?, 'card', ?, ?, ?, ?, 'stripe', ?, ?)",
        [plan.tenant_id, plan.order_id, ch.cents, ref, card.brand || null, card.last4 || null, card.account || null, fee]);
      const left = await one(conn, "SELECT COUNT(*) AS n, SUM(status = 'failed' OR (status = 'due' AND due_on <= ?)) AS late FROM payment_plan_charges WHERE plan_id = ? AND status IN ('due','failed')", [today, plan.id]);
      const status = Number(left.n) === 0 ? 'paid' : Number(left.late) > 0 ? plan.status : 'active';
      await conn.query('UPDATE payment_plans SET status = ? WHERE id = ?', [status, plan.id]);
      await audit(conn, F.system(plan.tenant_id), 'plan_charge_paid', 'payment_plans', plan.id, { charge: ch.n, cents: Number(ch.cents), reference: ref });
      return { result: 'paid', plan, ch, status };
    }
    const attempts = Number(ch.attempts) + 1;
    const final = attempts > RETRY_DAYS.length;
    await conn.query("UPDATE payment_plan_charges SET status = 'failed', attempts = ?, last_error = ?, next_try_on = ? WHERE id = ?",
      [attempts, String(error).slice(0, 250), final ? null : addDays(today, RETRY_DAYS[attempts - 1]), ch.id]);
    await conn.query('UPDATE payment_plans SET status = ? WHERE id = ?', [final ? 'suspended' : 'late', plan.id]);
    await audit(conn, F.system(plan.tenant_id), final ? 'plan_suspended' : 'plan_charge_failed', 'payment_plans', plan.id, { charge: ch.n, attempt: attempts, error: String(error).slice(0, 200) });
    return { result: 'failed', plan, ch, attempts, final, next: final ? null : addDays(today, RETRY_DAYS[attempts - 1]) };
  });
  if (notify && out.plan && out.plan.email) await tellGuest(out, base).catch(() => {});
  return out.result;
}
async function tellGuest(out, base) {
  const { plan, ch } = out;
  const t = await one(pool, 'SELECT name, slug FROM tenants WHERE id = ?', [plan.tenant_id]);
  const name = String(plan.name || '').split(/\s+/)[0] || 'there';
  if (out.result === 'paid') {
    if (ch.attempts > 0 || out.status === 'paid') {
      await F.mail(plan.tenant_id, plan.email, out.status === 'paid' ? `Your pass is paid in full at ${t.name}` : `Payment received at ${t.name}`, [`Hi ${name},`, '',
        out.status === 'paid' ? `Thank you. Your last payment of ${money(Number(ch.cents))} went through and your pass is paid in full.` : `Thank you. Payment ${ch.n} of ${plan.count}, ${money(Number(ch.cents))}, went through.`], 'plan-paid');
    }
    return;
  }
  const link = `${F.baseOf(base)}/plan/${t.slug}/${await F.newLink(pool, plan.tenant_id, 'plan', plan.id, { days: 45 })}`;
  const lines = out.final
    ? [`Hi ${name},`, '', `We tried your card three times for payment ${ch.n} of ${plan.count} (${money(Number(ch.cents))}) and it did not go through.`, 'Your pass is on hold at the lifts until it is paid. Update your card here and we will charge it right away:', link, '', 'Or pay at the ticket window. We are glad to help.']
    : [`Hi ${name},`, '', `Payment ${ch.n} of ${plan.count} for your pass (${money(Number(ch.cents))}) did not go through.`, `We will try again on ${dayText(out.next)}. Your pass still works.`, '', 'To use another card, update it here and we will charge it right away:', link];
  await F.mail(plan.tenant_id, plan.email, out.final ? `Your pass is on hold: a payment is overdue at ${t.name}` : `A payment for your pass did not go through at ${t.name}`, lines, 'plan-failed');
}

/** The job: every installment due today or due again after a failure, for every mountain. */
async function chargeDue(base = null) {
  const due = await rows(pool, `SELECT c.id, c.tenant_id, t.timezone FROM payment_plan_charges c JOIN payment_plans p ON p.id = c.plan_id JOIN tenants t ON t.id = c.tenant_id
    WHERE c.status IN ('due','failed') AND p.status IN ('active','late') AND COALESCE(c.next_try_on, c.due_on) <= CURRENT_DATE() + INTERVAL 1 DAY ORDER BY c.id LIMIT 300`);
  const out = { paid: 0, failed: 0 };
  for (const d of due) {
    const today = todayIn(d.timezone);
    const c = await one(pool, 'SELECT due_on, next_try_on, status FROM payment_plan_charges WHERE id = ?', [d.id]);
    if (dstr(c.next_try_on || c.due_on) > today) continue;
    if (c.status === 'failed' && !c.next_try_on) continue; // tried three times: waits for a new card or a manager
    const r = await chargeOne(d.id, { base });
    if (r === 'paid') out.paid += 1; else if (r === 'failed') out.failed += 1;
  }
  return out;
}

// ---------------------------------------------------------------- views and manager actions
const planOut = async (db, p) => {
  const charges = await rows(db, 'SELECT n, due_on, cents, status, attempts, next_try_on, last_error, paid_at FROM payment_plan_charges WHERE plan_id = ? ORDER BY n', [p.id]);
  const card = p.card_id ? await one(db, 'SELECT brand, last4 FROM fair_cards WHERE id = ?', [p.card_id]) : null;
  return { id: p.id, order_id: p.order_id, name: p.name, email: p.email, status: p.status, count: p.count, total_cents: p.total_cents, provider: p.provider, note: p.note,
    paid_cents: charges.filter((c) => ['paid', 'settled'].includes(c.status)).reduce((n, c) => n + Number(c.cents), 0),
    card: card && card.last4 ? { brand: card.brand, last4: card.last4 } : null,
    charges: charges.map((c) => ({ ...c, due_on: dstr(c.due_on), next_try_on: c.next_try_on ? dstr(c.next_try_on) : null })) };
};
async function list(db, tenantId) {
  const data = await rows(db, "SELECT * FROM payment_plans WHERE tenant_id = ? ORDER BY FIELD(status, 'suspended','late','active','paid','settled','canceled'), id DESC LIMIT 200", [tenantId]);
  return Promise.all(data.map((p) => planOut(db, p)));
}
async function get(db, tenantId, id) {
  const p = await one(db, 'SELECT * FROM payment_plans WHERE tenant_id = ? AND id = ?', [tenantId, id]);
  if (!p) throw notFound('Payment plan');
  return planOut(db, p);
}
/** Manager: charge the next unpaid installment now (after a guest asks, say). */
async function chargeNow(req, id) {
  const p = await get(pool, req.auth.tenantId, id);
  const c = await one(pool, "SELECT id FROM payment_plan_charges WHERE plan_id = ? AND status IN ('due','failed') ORDER BY n LIMIT 1", [p.id]);
  if (!c) throw conflict('Nothing is left to pay on this plan');
  await audit(pool, req, 'plan_charge_now', 'payment_plans', p.id, {});
  return { result: await chargeOne(c.id) };
}
/** Manager: the rest was paid another way (cash at the window, say), or forgiven. The pass works again. */
async function settle(req, id, note) {
  await tx(async (conn) => {
    const p = await one(conn, 'SELECT * FROM payment_plans WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, id]);
    if (!p) throw notFound('Payment plan');
    if (['paid', 'settled', 'canceled'].includes(p.status)) throw conflict(`This plan is already ${p.status}`);
    const [r] = await conn.query("UPDATE payment_plan_charges SET status = 'settled' WHERE plan_id = ? AND status IN ('due','failed')", [id]);
    await conn.query("UPDATE payment_plans SET status = 'settled', note = ? WHERE id = ?", [note || null, id]);
    await audit(conn, req, 'plan_settled', 'payment_plans', id, { installments: r.affectedRows, note: note || null });
  });
}
/** Manager: stop charging. Nothing more is taken; the pass is held at the gate until a manager settles or refunds it. */
async function cancel(req, id, note) {
  await tx(async (conn) => {
    const p = await one(conn, 'SELECT * FROM payment_plans WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, id]);
    if (!p) throw notFound('Payment plan');
    if (['paid', 'settled', 'canceled'].includes(p.status)) throw conflict(`This plan is already ${p.status}`);
    const [r] = await conn.query("UPDATE payment_plan_charges SET status = 'canceled' WHERE plan_id = ? AND status IN ('due','failed')", [id]);
    await conn.query("UPDATE payment_plans SET status = 'canceled', note = ? WHERE id = ?", [note || null, id]);
    await audit(conn, req, 'plan_canceled', 'payment_plans', id, { installments: r.affectedRows, note: note || null });
  });
}

// ---------------------------------------------------------------- the guest's card page (/plan/<slug>/<token>)
async function guestView(db, l) {
  const p = await get(db, l.tenant_id, l.ref_id);
  const pass = await one(db, `SELECT pr.name, pe.first_name FROM order_items i JOIN products pr ON pr.tenant_id = i.tenant_id AND pr.id = i.product_id
    LEFT JOIN people pe ON pe.tenant_id = i.tenant_id AND pe.id = i.person_id WHERE i.tenant_id = ? AND i.order_id = ? ORDER BY i.id LIMIT 1`, [l.tenant_id, p.order_id]);
  return { mountain: l.mountain, phone: l.phone, what: pass ? pass.name : 'Your pass', holder: pass ? pass.first_name : null, status: p.status, count: p.count, total_cents: p.total_cents, paid_cents: p.paid_cents, card: p.card,
    charges: p.charges.map((c) => ({ n: c.n, due_on: c.due_on, cents: c.cents, status: c.status, next_try_on: c.next_try_on })) };
}
/**
 * A Stripe page (setup mode) where the guest adds a new card for the plan's card row. kind: 'plan' or 'renew'. The
 * page comes back to returnUrl with ?done={CHECKOUT_SESSION_ID}; cardDone() then reads the new card from Stripe.
 */
async function cardSession(tenantId, cardId, { email, returnUrl, kind, refId }) {
  const card = cardId ? await one(pool, 'SELECT * FROM fair_cards WHERE tenant_id = ? AND id = ?', [tenantId, cardId]) : null;
  const p = await connect.payeeOrThrow(tenantId);
  const s = await stripe.call('/v1/checkout/sessions', {
    mode: 'setup', payment_method_types: ['card'], ...(card && card.customer ? { customer: card.customer } : { customer_creation: 'always' }),
    ...(card && card.customer ? {} : email ? { customer_email: email } : {}),
    success_url: `${returnUrl}?done={CHECKOUT_SESSION_ID}`, cancel_url: returnUrl,
    metadata: { tenant_id: String(tenantId), kind: `fair_${kind}`, ref_id: String(refId) },
  }, { account: p.account || null, idempotencyKey: `fair-card-${kind}-${refId}-${Date.now()}` });
  return { url: s.url };
}
/** After the guest added a card on Stripe's page: keep it on the card row (checked against the session's own metadata). */
async function cardDone(tenantId, cardId, sessionId, { kind, refId, email = null, personId = null }) {
  if (!/^cs_[A-Za-z0-9_]{6,200}$/.test(String(sessionId || ''))) throw bad('That card page is not valid');
  const p = await connect.payeeOrThrow(tenantId);
  const s = await stripe.get(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=setup_intent.payment_method`, { account: p.account || null });
  const m = s.metadata || {};
  if (m.tenant_id !== String(tenantId) || m.kind !== `fair_${kind}` || m.ref_id !== String(refId) || s.status !== 'complete') throw conflict('That card was not saved. Please try again.');
  const si = s.setup_intent || {};
  const pm = typeof si.payment_method === 'object' && si.payment_method ? si.payment_method : { id: si.payment_method };
  const customer = (typeof s.customer === 'object' && s.customer ? s.customer.id : s.customer) || (typeof si.customer === 'string' ? si.customer : null);
  if (!pm.id || !customer) throw conflict('That card was not saved. Please try again.');
  const vals = [p.account || null, customer, pm.id, (pm.card && pm.card.brand) || null, (pm.card && pm.card.last4) || null];
  if (cardId) {
    await pool.query('UPDATE fair_cards SET account = ?, customer = ?, payment_method = ?, brand = ?, last4 = ? WHERE tenant_id = ? AND id = ?', [...vals, tenantId, cardId]);
    return cardId;
  }
  const [c] = await pool.query('INSERT INTO fair_cards (account, customer, payment_method, brand, last4, tenant_id, person_id, email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [...vals, tenantId, personId, email]);
  return c.insertId;
}
/** A new card on a plan: charges what is overdue right away (and lifts the hold at the gate once all of it is paid). */
async function planCardDone(l, sessionId) {
  const p = await one(pool, 'SELECT * FROM payment_plans WHERE tenant_id = ? AND id = ?', [l.tenant_id, l.ref_id]);
  await cardDone(l.tenant_id, p.card_id, sessionId, { kind: 'plan', refId: p.id });
  await audit(pool, F.system(l.tenant_id), 'plan_card_updated', 'payment_plans', p.id, {});
  const t = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [l.tenant_id]);
  const owed = await rows(pool, "SELECT id FROM payment_plan_charges WHERE plan_id = ? AND (status = 'failed' OR (status = 'due' AND due_on <= ?)) ORDER BY n", [p.id, todayIn(t.timezone)]);
  for (const c of owed) if ((await chargeOne(c.id, { notify: false })) !== 'paid') break;
  return guestView(pool, l);
}

module.exports = { PROVIDERS, quote, start, checkoutExtra, schedule, addMonths, split, chargeOne, chargeDue, list, get, chargeNow, settle, cancel, guestView, cardSession, cardDone, planCardDone };
