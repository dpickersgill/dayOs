'use strict';

// Settings, Billing: the mountain's DAY/OS subscription. Owners and managers see it; only the owner changes the plan
// or pays. Paying is through Stripe: Checkout for a card or US bank account, an emailed invoice, and Stripe's customer
// portal for the card, invoices and cancelling. Stripe tells us what happened through the webhook (handleWebhook).
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { stepUp } = require('../lib/stepup');
const { z, validate } = require('../lib/util');
const { bad, forbidden, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const B = require('../lib/billing');
const stripe = require('../lib/stripe');
const config = require('../config');

const router = express.Router();
const managers = requireRole('manager');
const ownerOnly = (req, _res, next) => next(req.auth.role === 'owner' ? undefined : forbidden('Only the mountain\'s owner can change the subscription or pay'));
const baseUrl = (req) => config.stripe.publicUrl || `${req.protocol}://${req.get('host')}`;

async function rowOf(db, t) {
  let b = await one(db, 'SELECT * FROM tenant_billing WHERE tenant_id = ?', [t]);
  if (!b) { await db.query('INSERT IGNORE INTO tenant_billing (tenant_id, comped) VALUES (?, 1)', [t]); b = await one(db, 'SELECT * FROM tenant_billing WHERE tenant_id = ?', [t]); }
  return b;
}

/** Everything the Billing page shows. */
router.get('/billing', managers, async (req, res) => {
  const t = req.auth.tenantId;
  const b = await one(pool, 'SELECT * FROM tenant_billing WHERE tenant_id = ?', [t]);
  const all = await B.plans();
  const standing = await B.standingOf(t);
  let invoices = [];
  if (b && b.stripe_customer_id && stripe.enabled()) {
    try {
      const list = await stripe.get(`/v1/invoices?customer=${encodeURIComponent(b.stripe_customer_id)}&limit=12`);
      invoices = (list.data || []).map((i) => ({ id: i.id, number: i.number, status: i.status, amount_cents: i.amount_due, paid_cents: i.amount_paid, created: new Date(i.created * 1000).toISOString(), due: i.due_date ? new Date(i.due_date * 1000).toISOString() : null, url: i.hosted_invoice_url, pdf: i.invoice_pdf }));
    } catch (_) { invoices = null; } // Stripe unreachable: the page says so
  }
  // The operator's own notes stay in the console: the mountain sees only that DAY/OS changed something.
  const events = (await rows(pool, "SELECT at, kind, detail FROM billing_events WHERE tenant_id = ? AND kind NOT LIKE 'stripe:%' ORDER BY id DESC LIMIT 20", [t])).map((e) => (e.kind === 'operator_change' ? { ...e, detail: null } : e));
  res.json({
    standing,
    billing: b ? {
      plan_id: b.plan_id ? Number(b.plan_id) : null, addons: B.ids(b.addons), interval: b.billing_interval, comped: Boolean(Number(b.comped)), trial_ends_on: B.dateOf(b.trial_ends_on),
      paid_until: B.dateOf(b.paid_until), billing_email: b.billing_email, pay_method: b.pay_method, subscribed: Boolean(b.stripe_subscription_id), sub_status: b.sub_status,
      period_end: b.period_end, cancel_at_period_end: Boolean(Number(b.cancel_at_period_end)), has_customer: Boolean(b.stripe_customer_id),
    } : null,
    plans: all.filter((p) => p.active && p.kind === 'plan'), addons: all.filter((p) => p.active && p.kind === 'addon'),
    invoices, events, can_pay: req.auth.role === 'owner', stripe: stripe.enabled(), grace_days: B.GRACE_DAYS,
  });
});

const choiceBody = z.object({ plan_id: z.number().int().positive(), addons: z.array(z.number().int().positive()).max(20).default([]), interval: z.enum(['month', 'year']).default('month'), billing_email: z.string().trim().email().max(255).nullable().optional() });

async function checkChoice(db, b) {
  const all = await B.plans(db);
  const plan = all.find((p) => p.id === b.plan_id && p.kind === 'plan' && p.active);
  if (!plan) throw bad('Choose one of the plans');
  for (const a of b.addons) if (!all.some((p) => p.id === a && p.kind === 'addon' && p.active)) throw bad('Unknown add-on');
  const cents = b.interval === 'year' ? 'yearly_cents' : 'monthly_cents';
  if (!plan[cents]) throw bad(`${plan.name} is not offered ${b.interval === 'year' ? 'yearly' : 'monthly'}`);
  return plan;
}

/**
 * Choose the plan, add-ons and billing period. Before paying this only saves the choice. With a subscription, Stripe
 * changes it straight away (charging or crediting the difference) and the apps change to match.
 */
router.put('/billing/choice', managers, ownerOnly, validate(choiceBody), async (req, res) => {
  const t = req.auth.tenantId; const c = req.body;
  await checkChoice(pool, c);
  const b = await rowOf(pool, t);
  if (b.stripe_subscription_id && ['active', 'trialing', 'past_due'].includes(b.sub_status)) {
    if (!stripe.enabled()) throw conflict('Payments are not set up yet');
    const items = await B.lineItems({ ...b, plan_id: c.plan_id, addons: c.addons.join(','), billing_interval: c.interval });
    const sub = await stripe.get(`/v1/subscriptions/${encodeURIComponent(b.stripe_subscription_id)}`);
    const old = (sub.items && sub.items.data) || [];
    await stripe.call(`/v1/subscriptions/${encodeURIComponent(b.stripe_subscription_id)}`, {
      items: [...old.map((i) => ({ id: i.id, deleted: true })), ...items], proration_behavior: 'create_prorations',
    });
  }
  await tx(async (conn) => {
    await conn.query('UPDATE tenant_billing SET plan_id = ?, addons = ?, billing_interval = ?, billing_email = COALESCE(?, billing_email) WHERE tenant_id = ?', [c.plan_id, c.addons.join(','), c.interval, c.billing_email || null, t]);
    const now = await one(conn, 'SELECT * FROM tenant_billing WHERE tenant_id = ?', [t]);
    // The apps follow the plan once it is paid for; during the trial everything stays on.
    if (now.stripe_subscription_id || B.dateOf(now.paid_until)) await B.applyModules(conn, t, now);
    await B.event(conn, t, 'plan_chosen', `Plan ${c.plan_id}, add-ons ${c.addons.join(',') || 'none'}, ${c.interval}ly`, { userId: req.auth.userId });
  });
  await audit(pool, req, 'billing_choice', 'tenant_billing', t, c);
  B.invalidate(t);
  res.json({ ok: true });
});

/** Pay by card or US bank account: Stripe's hosted page. Any trial days left are kept. */
router.post('/billing/checkout', managers, ownerOnly, stepUp('change how DAY/OS is paid'), validate(z.object({ method: z.enum(['card', 'bank']).default('card') })), async (req, res) => {
  if (!stripe.enabled()) throw conflict('Payments are not set up yet. Contact DAY/OS.');
  const t = req.auth.tenantId;
  const b = await rowOf(pool, t);
  if (b.stripe_subscription_id && ['active', 'trialing', 'past_due'].includes(b.sub_status)) throw conflict('You already have a subscription. Use Manage payment to change the card or bank account.');
  if (!b.plan_id) throw bad('Choose a plan first');
  const items = await B.lineItems(b);
  const customer = await B.customerFor(pool, t, b);
  const tz = (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone;
  const meta = { kind: 'billing', tenant_id: String(t) };
  const s = await stripe.call('/v1/checkout/sessions', {
    mode: 'subscription', customer, line_items: items,
    payment_method_types: req.body.method === 'bank' ? ['us_bank_account'] : ['card'],
    success_url: `${baseUrl(req)}/#/billing?paid=1`, cancel_url: `${baseUrl(req)}/#/billing`,
    metadata: meta, subscription_data: { metadata: meta, trial_end: B.trialEnd(b, require('../lib/util').todayIn(tz)) },
  });
  await pool.query('UPDATE tenant_billing SET pay_method = ? WHERE tenant_id = ?', [req.body.method, t]);
  await audit(pool, req, 'billing_checkout', 'tenant_billing', t, { method: req.body.method });
  res.json({ url: s.url });
});

/** Pay by invoice: Stripe emails an invoice each period, due in 30 days, payable by card, bank transfer or check. */
router.post('/billing/invoice', managers, ownerOnly, validate(z.object({ billing_email: z.string().trim().email().max(255) })), async (req, res) => {
  if (!stripe.enabled()) throw conflict('Payments are not set up yet. Contact DAY/OS.');
  const t = req.auth.tenantId;
  let b = await rowOf(pool, t);
  if (b.stripe_subscription_id && ['active', 'trialing', 'past_due'].includes(b.sub_status)) throw conflict('You already have a subscription');
  if (!b.plan_id) throw bad('Choose a plan first');
  await pool.query('UPDATE tenant_billing SET billing_email = ? WHERE tenant_id = ?', [req.body.billing_email, t]);
  b = { ...b, billing_email: req.body.billing_email };
  const items = await B.lineItems(b);
  const customer = await B.customerFor(pool, t, b);
  if (b.stripe_customer_id) await stripe.call(`/v1/customers/${encodeURIComponent(customer)}`, { email: req.body.billing_email });
  const tz = (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone;
  const meta = { kind: 'billing', tenant_id: String(t) };
  const sub = await stripe.call('/v1/subscriptions', { customer, items, collection_method: 'send_invoice', days_until_due: 30, metadata: meta, trial_end: B.trialEnd(b, require('../lib/util').todayIn(tz)) }, { idempotencyKey: `billing-invoice-sub-${t}-${b.plan_id}-${b.addons}-${b.billing_interval}` });
  await tx(async (conn) => {
    await conn.query('UPDATE tenant_billing SET comped = 0, stripe_subscription_id = ?, sub_status = ?, pay_method = ?, period_end = ? WHERE tenant_id = ?', [sub.id, sub.status, 'invoice', periodEnd(sub), t]);
    await B.applyModules(conn, t, await one(conn, 'SELECT * FROM tenant_billing WHERE tenant_id = ?', [t]));
    await B.event(conn, t, 'subscribed', `By invoice to ${req.body.billing_email}`, { userId: req.auth.userId });
  });
  await audit(pool, req, 'billing_invoice', 'tenant_billing', t);
  B.invalidate(t);
  res.json({ ok: true, status: sub.status });
});

/** Stripe's customer portal: change the card or bank account, see and pay invoices, cancel. */
router.post('/billing/portal', managers, ownerOnly, stepUp('change how DAY/OS is paid'), async (req, res) => {
  if (!stripe.enabled()) throw conflict('Payments are not set up yet. Contact DAY/OS.');
  const b = await one(pool, 'SELECT stripe_customer_id FROM tenant_billing WHERE tenant_id = ?', [req.auth.tenantId]);
  if (!b || !b.stripe_customer_id) throw bad('There is nothing to manage yet: choose a plan and pay first');
  const s = await stripe.call('/v1/billing_portal/sessions', { customer: b.stripe_customer_id, return_url: `${baseUrl(req)}/#/billing` });
  res.json({ url: s.url });
});

// ---------------------------------------------------------------- Stripe webhooks
const periodEnd = (sub) => {
  const ts = sub.current_period_end || (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end);
  return ts ? new Date(ts * 1000).toISOString().slice(0, 19).replace('T', ' ') : null;
};
const subIdOf = (obj) => obj.subscription || (obj.parent && obj.parent.subscription_details && obj.parent.subscription_details.subscription) || null;

/** Is this event about a DAY/OS subscription? Returns the result, or null for events that belong elsewhere. */
async function handleWebhook(event) {
  const obj = event && event.data && event.data.object;
  if (!obj) return null;
  const type = event.type;
  let tenantId = null;
  if (obj.metadata && obj.metadata.kind === 'billing') tenantId = Number(obj.metadata.tenant_id);
  else if (type.startsWith('invoice.') && subIdOf(obj)) {
    const r = await one(pool, 'SELECT tenant_id FROM tenant_billing WHERE stripe_subscription_id = ?', [subIdOf(obj)]);
    if (r) tenantId = Number(r.tenant_id);
  } else if (type.startsWith('customer.subscription.')) {
    const r = await one(pool, 'SELECT tenant_id FROM tenant_billing WHERE stripe_subscription_id = ?', [obj.id]);
    if (r) tenantId = Number(r.tenant_id);
  }
  if (!tenantId) return null;
  const out = await tx(async (conn) => {
    // Each Stripe event once: its id is kept with the history line.
    try { await B.event(conn, tenantId, `stripe:${type}`, null, { stripeEventId: event.id }); } catch (e) { if (e.code === 'ER_DUP_ENTRY') return { duplicate: true }; throw e; }
    const b = await one(conn, 'SELECT * FROM tenant_billing WHERE tenant_id = ? FOR UPDATE', [tenantId]);
    if (!b) return { ignored: true };
    if (type === 'checkout.session.completed' && obj.mode === 'subscription') {
      await conn.query('UPDATE tenant_billing SET comped = 0, stripe_subscription_id = ?, stripe_customer_id = COALESCE(?, stripe_customer_id), sub_status = COALESCE(sub_status, ?) WHERE tenant_id = ?', [obj.subscription, obj.customer, 'active', tenantId]);
      await B.applyModules(conn, tenantId, await one(conn, 'SELECT * FROM tenant_billing WHERE tenant_id = ?', [tenantId]));
      return { subscribed: true };
    }
    if (type.startsWith('customer.subscription.')) {
      const status = type === 'customer.subscription.deleted' ? 'canceled' : obj.status;
      const failing = ['past_due', 'unpaid', 'incomplete'].includes(status);
      await conn.query(`UPDATE tenant_billing SET stripe_subscription_id = ?, sub_status = ?, period_end = COALESCE(?, period_end), cancel_at_period_end = ?,
        past_due_since = ${failing ? 'COALESCE(past_due_since, UTC_TIMESTAMP())' : 'NULL'} WHERE tenant_id = ?`, [obj.id, status, periodEnd(obj), obj.cancel_at_period_end ? 1 : 0, tenantId]);
      if (['active', 'trialing'].includes(status) && !['active', 'trialing'].includes(b.sub_status)) await B.applyModules(conn, tenantId, await one(conn, 'SELECT * FROM tenant_billing WHERE tenant_id = ?', [tenantId]));
      return { status };
    }
    if (type === 'invoice.payment_failed') {
      await conn.query("UPDATE tenant_billing SET past_due_since = COALESCE(past_due_since, UTC_TIMESTAMP()), sub_status = IF(sub_status IN ('active','trialing'), 'past_due', sub_status) WHERE tenant_id = ?", [tenantId]);
      await B.event(conn, tenantId, 'payment_failed', `Invoice ${obj.number || obj.id} for $${((obj.amount_due || 0) / 100).toFixed(2)} was not paid`);
      return { failed: true };
    }
    if (type === 'invoice.paid') {
      await conn.query("UPDATE tenant_billing SET past_due_since = NULL, sub_status = IF(sub_status IN ('past_due','unpaid','incomplete'), 'active', sub_status) WHERE tenant_id = ?", [tenantId]);
      await B.event(conn, tenantId, 'paid', `Invoice ${obj.number || obj.id}: $${((obj.amount_paid || 0) / 100).toFixed(2)} paid`);
      return { paid: true };
    }
    return { noted: true };
  });
  B.invalidate(tenantId);
  return { billing: out };
}

// ---------------------------------------------------------------- guest card payments: the mountain's own Stripe account
// Guests' card payments (the online shop, lessons, date changes, patrol giving) go to the mountain's own Stripe account,
// connected here. Owners and managers can look; only the owner connects or disconnects it, after confirming it is them,
// because it decides where the mountain's money goes.
const connect = require('../lib/connect');
const appUrl = (req) => (config.site && config.site.appUrl) || baseUrl(req);

router.get('/payments/stripe', managers, async (req, res) => {
  const t = req.auth.tenantId;
  let s = await connect.state(t);
  // Coming back from Stripe (or asked to): read the account now rather than wait for its webhook.
  if (s.connected && stripe.enabled() && req.query.refresh === '1') {
    try { s = await connect.refresh(t); } catch (_) { s = { ...s, check_failed: true }; }
  }
  res.json({ ...s, can_connect: req.auth.role === 'owner', sandbox: await require('../lib/sandbox').isSandbox(t) });
});

router.post('/payments/stripe/link', managers, ownerOnly, stepUp('connect where guest card payments go'), async (req, res) => {
  const t = req.auth.tenantId;
  if (!stripe.enabled()) throw conflict('Card payments are not switched on for DAY/OS yet. Ask DAY/OS to set up Stripe.');
  if (await require('../lib/sandbox').isSandbox(t)) throw conflict('A demo mountain cannot take real card payments.');
  const m = await one(pool, 'SELECT name, stripe_account FROM tenants WHERE id = ?', [t]);
  let account = m.stripe_account;
  if (!account) {
    const owner = await one(pool, 'SELECT email FROM users WHERE id = ?', [req.auth.userId]);
    account = await stripe.createAccount({ email: owner && owner.email, name: m.name, tenantId: t });
    // Only set when still empty, so two clicks at once cannot leave the mountain pointing at two accounts.
    const [u] = await pool.query('UPDATE tenants SET stripe_account = ?, stripe_charges_enabled = 0, stripe_payouts_enabled = 0, stripe_details_submitted = 0 WHERE id = ? AND stripe_account IS NULL', [account, t]);
    if (!u.affectedRows) account = (await one(pool, 'SELECT stripe_account FROM tenants WHERE id = ?', [t])).stripe_account;
    await audit(pool, req, 'stripe_connect_start', 'tenants', t, { account });
  }
  const back = `${appUrl(req)}/#/billing?stripe=`;
  const url = await stripe.accountLink({ account, refreshUrl: `${back}again`, returnUrl: `${back}return` });
  res.json({ url });
});

router.post('/payments/stripe/disconnect', managers, ownerOnly, stepUp('stop guest card payments going to this Stripe account'), async (req, res) => {
  const t = req.auth.tenantId;
  const m = await one(pool, 'SELECT stripe_account FROM tenants WHERE id = ?', [t]);
  if (!m.stripe_account) return res.json(await connect.state(t));
  // The Stripe account itself is the mountain's and stays as it is; DAY/OS just stops sending payments to it. Refunds of
  // earlier payments still go back through the account each payment was taken on.
  await pool.query('UPDATE tenants SET stripe_account = NULL, stripe_charges_enabled = 0, stripe_payouts_enabled = 0, stripe_details_submitted = 0, stripe_connected_at = NULL, stripe_checked_at = NULL WHERE id = ?', [t]);
  await audit(pool, req, 'stripe_disconnect', 'tenants', t, { account: m.stripe_account });
  res.json(await connect.state(t));
});

module.exports = { router, handleWebhook, periodEnd };
