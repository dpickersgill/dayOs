'use strict';

// What a mountain pays Verdynt/OS, and what happens when it does not.
//
// Each mountain is on a plan (a set of apps) with any add-ons, paid monthly, yearly, or over the season: the yearly price
// in six monthly payments, November to April, with nothing to pay May to October (Stripe's collection is paused for the
// summer by the daily job, and a mountain that starts in the summer pays nothing until November). New mountains start with a 14-day
// trial. They pay through Stripe: card or US bank account (Stripe Checkout), or an emailed invoice due in 30 days.
// Stripe's customer portal handles changing the card, seeing invoices and canceling.
//
// Standing (see standingOf):
//   ok         comped, a live subscription, a manual payment that covers today, or in the trial
//   grace      the trial ended, a payment failed, or the paid time ran out: everything works for 14 more days, with a banner
//   read_only  after the grace days: people can sign in, see and export everything, and fix billing, but nothing is
//              sold or added, except patrol (care and safety records always stay writable), the time clock and the Inbox
// A mountain with no billing row (made before billing existed, or a demo) is comped.
const { pool, rows, one } = require('../db');
const { todayIn, addDays } = require('./util');
const stripe = require('./stripe');
const M = require('./modules');
const { AppError } = require('./errors');

const TRIAL_DAYS = 14;
const GRACE_DAYS = 14;

const cache = new Map(); // tenant id -> { at, standing }
const TTL = Number(process.env.BILLING_CACHE_MS ?? 15000);
const invalidate = (t) => { if (t === undefined) cache.clear(); else cache.delete(Number(t)); };

const dateOf = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);
const maxDate = (...ds) => ds.filter(Boolean).sort().pop() || null;

/**
 * The mountain's standing today. { state, until, read_only, reason, days_left, trial }.
 * Pure: takes the billing row and today's date, so the tests can walk it through time.
 */
function standing(b, today) {
  if (!b || Number(b.comped)) return { state: 'ok', kind: 'comped', read_only: false };
  const live = ['active', 'trialing'].includes(b.sub_status);
  if (live) return { state: 'ok', kind: b.cancel_at_period_end ? 'cancelling' : 'subscribed', read_only: false, until: dateOf(b.period_end) };
  if (['past_due', 'unpaid', 'incomplete'].includes(b.sub_status)) {
    const since = dateOf(b.past_due_since) || today;
    const until = addDays(since, GRACE_DAYS);
    if (dateOf(b.paid_until) && dateOf(b.paid_until) >= today) return { state: 'ok', kind: 'paid_manually', read_only: false, until: dateOf(b.paid_until) };
    return today <= until ? { state: 'grace', kind: 'payment_failed', read_only: false, until, days_left: daysBetween(today, until) } : { state: 'read_only', kind: 'payment_failed', read_only: true, until };
  }
  if (dateOf(b.paid_until) && dateOf(b.paid_until) >= today) return { state: 'ok', kind: 'paid_manually', read_only: false, until: dateOf(b.paid_until) };
  if (dateOf(b.trial_ends_on) && dateOf(b.trial_ends_on) >= today && !b.stripe_subscription_id) {
    return { state: 'ok', kind: 'trial', read_only: false, trial: true, until: dateOf(b.trial_ends_on), days_left: daysBetween(today, dateOf(b.trial_ends_on)) };
  }
  // Nothing covers today: the trial, a manual payment or a canceled subscription ran out.
  const ended = maxDate(dateOf(b.trial_ends_on), dateOf(b.paid_until), dateOf(b.period_end)) || today;
  const until = addDays(ended, GRACE_DAYS);
  const kind = b.sub_status === 'canceled' ? 'canceled' : dateOf(b.paid_until) === ended ? 'paid_time_ended' : 'trial_ended';
  return today <= until ? { state: 'grace', kind, read_only: false, until, days_left: daysBetween(today, until) } : { state: 'read_only', kind, read_only: true, until };
}
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

async function standingOf(tenantId) {
  const id = Number(tenantId);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL) return hit.standing;
  const t = await one(pool, 'SELECT timezone, sandbox_expires_at FROM tenants WHERE id = ?', [id]);
  const b = t && !t.sandbox_expires_at ? await one(pool, 'SELECT * FROM tenant_billing WHERE tenant_id = ?', [id]) : null;
  const s = standing(b, todayIn(t ? t.timezone : 'UTC'));
  cache.set(id, { at: Date.now(), standing: s });
  return s;
}

// What still works in read-only: billing itself, signing in and accounts, patrol (care and safety), the time clock,
// the Inbox, and What's new. Everything can still be read and exported.
const WRITABLE = [/^\/billing(\/|$)/, /^\/patrol(\/|$)/, /^\/inbox(\/|$)/, /^\/whats-new(\/|$)/, /^\/demo-tours(\/|$)/, /^\/workforce\/time\/clock-(in|out)$/, /^\/kiosk(\/|$)/];
const readOnlyError = () => { const e = new AppError(402, 'Your Verdynt/OS subscription has lapsed, so this mountain is read only. The owner can renew on Settings, Billing.'); e.details = { code: 'billing_read_only' }; return e; };

/** Signed-in requests: in read-only, only reads and the writable areas above go through. */
function gate(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || WRITABLE.some((r) => r.test(req.path))) return next();
  standingOf(req.auth.tenantId).then((s) => next(s.read_only ? readOnlyError() : undefined), next);
}

/** Public pages: a read-only mountain takes no online orders or bookings (the pages still show). */
async function publicBlocked(tenantId, method) {
  if (method === 'GET') return false;
  return (await standingOf(tenantId)).read_only;
}

// ---------------------------------------------------------------- plans
const parsePlan = (p) => ({ ...p, id: Number(p.id), active: Boolean(p.active), modules: p.modules ? p.modules.split(',').filter(Boolean) : [] });
const plans = async (db = pool) => (await rows(db, 'SELECT * FROM billing_plans ORDER BY kind, sort, monthly_cents, id')).map(parsePlan);
const ids = (csv) => String(csv || '').split(',').filter(Boolean).map(Number);

/** The apps a plan and its add-ons give, with what they need. */
function modulesFor(plan, addons) {
  const keys = new Set([...(plan ? plan.modules : []), ...addons.flatMap((a) => a.modules)]);
  // An app brings what it needs (Sell needs Products and prices), so a plan never switches on half an app.
  for (let grew = true; grew;) { grew = false; for (const m of M.MODULES) if (keys.has(m.key)) for (const need of m.needs || []) if (!keys.has(need)) { keys.add(need); grew = true; } }
  return M.settle(Object.fromEntries(M.KEYS.map((k) => [k, keys.has(k)])));
}

/** Turn the mountain's apps to match its plan and add-ons. */
async function applyModules(conn, tenantId, b) {
  const all = await plans(conn);
  const plan = all.find((p) => p.id === Number(b.plan_id));
  if (!plan) return null;
  const on = modulesFor(plan, all.filter((p) => ids(b.addons).includes(p.id)));
  for (const k of M.KEYS) await conn.query('INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)', [tenantId, k, on.includes(k) ? 1 : 0]);
  M.invalidate(tenantId);
  return on;
}

async function event(conn, tenantId, kind, detail, { userId = null, operator = null, stripeEventId = null } = {}) {
  await conn.query('INSERT INTO billing_events (tenant_id, kind, detail, by_user, by_operator, stripe_event_id) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, kind, detail ? String(detail).slice(0, 1000) : null, userId, operator, stripeEventId]);
}

/** Start a new mountain on a trial. */
async function startTrial(conn, tenantId, { planId = null, email = null } = {}) {
  const t = await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const ends = addDays(todayIn(t.timezone), TRIAL_DAYS);
  await conn.query('INSERT IGNORE INTO tenant_billing (tenant_id, plan_id, trial_ends_on, billing_email) VALUES (?, ?, ?, ?)', [tenantId, planId, ends, email]);
  await event(conn, tenantId, 'trial_started', `Trial until ${ends}`);
  invalidate(tenantId);
  return ends;
}

// ---------------------------------------------------------------- Stripe
// ---- season billing: November to April
const SEASON_MONTHS = 6;
/** A sixth of the yearly price: what a season payment is, in cents (none when the plan has no yearly price). */
const seasonCents = (p) => (p && p.yearly_cents ? Math.round(Number(p.yearly_cents) / SEASON_MONTHS) : 0);
/** May to October: nothing is collected from a season-billed mountain. today is YYYY-MM-DD. */
const inSummer = (today) => { const m = Number(String(today).slice(5, 7)); return m >= 5 && m <= 10; };
/** The next November 1 on or after today, as YYYY-MM-DD. */
const nextNovember = (today) => { const y = Number(String(today).slice(0, 4)); const m = Number(String(today).slice(5, 7)); return `${m >= 11 ? y + 1 : y}-11-01`; };
const unix = (day) => Math.floor(Date.parse(`${day}T12:00:00Z`) / 1000);

/** [price id column, its amount column, the amount for this period, Stripe's interval] for the mountain's billing period. */
const priceKey = (b) => (b.billing_interval === 'year' ? ['stripe_year', 'stripe_year_cents', 'yearly_cents', 'year']
  : b.billing_interval === 'season' ? ['stripe_season', 'stripe_season_cents', 'season_cents', 'month']
    : ['stripe_month', 'stripe_month_cents', 'monthly_cents', 'month']);
/** A plan with its season amount worked out, so all three periods read the same way. */
const withSeason = (p) => (p ? { ...p, season_cents: seasonCents(p) } : p);

/** Make (or refresh) the Stripe product and prices for a plan. Prices cannot change in Stripe, so a new amount makes a new price. */
async function syncPlan(p) {
  if (!stripe.enabled()) throw new AppError(409, 'Stripe is not set up (STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET)');
  let product = p.stripe_product;
  if (!product) {
    product = (await stripe.call('/v1/products', { name: `Verdynt/OS ${p.name}`, metadata: { kind: 'billing_plan', plan_id: String(p.id), code: p.code } }, { idempotencyKey: `plan-product-${p.id}` })).id;
    await pool.query('UPDATE billing_plans SET stripe_product = ? WHERE id = ?', [product, p.id]);
  }
  p = withSeason(p);
  for (const [col, centsCol, amountCol, interval] of [['stripe_month', 'stripe_month_cents', 'monthly_cents', 'month'], ['stripe_year', 'stripe_year_cents', 'yearly_cents', 'year'], ['stripe_season', 'stripe_season_cents', 'season_cents', 'month']]) {
    if (!p[amountCol] || (p[col] && Number(p[centsCol]) === Number(p[amountCol]))) continue;
    const season = col === 'stripe_season';
    const price = await stripe.call('/v1/prices', { product, currency: 'usd', unit_amount: p[amountCol], recurring: { interval }, nickname: season ? 'Season (Nov to Apr)' : undefined, metadata: { plan_id: String(p.id), ...(season ? { period: 'season' } : {}) } }, { idempotencyKey: `plan-price-${p.id}-${season ? 'season' : interval}-${p[amountCol]}` });
    await pool.query(`UPDATE billing_plans SET ${col} = ?, ${centsCol} = ? WHERE id = ?`, [price.id, p[amountCol], p.id]);
  }
  return parsePlan(await one(pool, 'SELECT * FROM billing_plans WHERE id = ?', [p.id]));
}

/** The Stripe prices for a mountain's plan, add-ons and interval, synced first if needed. */
async function lineItems(b) {
  const all = await plans();
  const chosen = [all.find((p) => p.id === Number(b.plan_id)), ...all.filter((p) => ids(b.addons).includes(p.id))].filter(Boolean).map(withSeason);
  if (!chosen.length || !chosen[0] || chosen[0].kind !== 'plan') throw new AppError(400, 'Choose a plan first');
  const [col, centsCol, amountCol] = priceKey(b);
  const out = [];
  for (let p of chosen) {
    if (!p[amountCol]) continue; // a free add-on has no line
    if (!p[col] || Number(p[centsCol]) !== Number(p[amountCol])) p = withSeason(await syncPlan(p));
    out.push({ price: p[col], quantity: 1 });
  }
  if (!out.length) throw new AppError(400, 'This plan has no price for that billing period');
  return out;
}

async function customerFor(conn, tenantId, b) {
  if (b.stripe_customer_id) return b.stripe_customer_id;
  const t = await one(conn, 'SELECT name, slug FROM tenants WHERE id = ?', [tenantId]);
  const c = await stripe.call('/v1/customers', { name: t.name, email: b.billing_email || undefined, metadata: { kind: 'billing', tenant_id: String(tenantId), slug: t.slug } }, { idempotencyKey: `billing-customer-${tenantId}` });
  await conn.query('UPDATE tenant_billing SET stripe_customer_id = ? WHERE tenant_id = ?', [c.id, tenantId]);
  return c.id;
}

/**
 * When Stripe should first charge, as a Stripe trial end: the trial's last day when there are trial days left (so paying
 * early does not cut the trial), and for season billing started between May and October, November 1.
 */
function trialEnd(b, today) {
  const d = dateOf(b.trial_ends_on);
  const trial = d && d > today && !b.stripe_subscription_id ? Math.floor(Date.parse(`${d}T23:59:00Z`) / 1000) : undefined;
  if (b.billing_interval === 'season' && inSummer(today)) return Math.max(trial || 0, unix(nextNovember(today)));
  return trial;
}

/** Stripe's summer pause for a season-billed subscription: collection stops until November 1 (Stripe resumes it itself). */
const pauseUntilNovember = (today) => ({ pause_collection: { behavior: 'void', resumes_at: unix(nextNovember(today)) } });

/**
 * The daily job: pause season-billed subscriptions for the summer (May to October), and take the pause off any that
 * moved to monthly or yearly. Returns how many changed. Stripe resumes a paused one on November 1 by itself.
 */
async function seasonAll() {
  if (!stripe.enabled()) return 0;
  const list = await rows(pool, "SELECT b.*, t.timezone FROM tenant_billing b JOIN tenants t ON t.id = b.tenant_id WHERE b.stripe_subscription_id IS NOT NULL AND b.sub_status IN ('active','trialing','past_due') AND (b.billing_interval = 'season' OR b.season_paused_until IS NOT NULL)");
  let changed = 0;
  for (const b of list) {
    const today = todayIn(b.timezone);
    const paused = dateOf(b.season_paused_until);
    if (b.billing_interval === 'season' && inSummer(today) && (!paused || paused <= today)) {
      await stripe.call(`/v1/subscriptions/${encodeURIComponent(b.stripe_subscription_id)}`, pauseUntilNovember(today));
      await pool.query('UPDATE tenant_billing SET season_paused_until = ? WHERE tenant_id = ?', [nextNovember(today), b.tenant_id]);
      await event(pool, b.tenant_id, 'season_paused', `Nothing to pay until ${nextNovember(today)}`);
      changed += 1;
    } else if (paused && (b.billing_interval !== 'season' || paused <= today)) {
      if (b.billing_interval !== 'season') await stripe.call(`/v1/subscriptions/${encodeURIComponent(b.stripe_subscription_id)}`, { pause_collection: '' });
      await pool.query('UPDATE tenant_billing SET season_paused_until = NULL WHERE tenant_id = ?', [b.tenant_id]);
      changed += 1;
    }
  }
  return changed;
}

/**
 * The daily job: one email to the owner (and the billing email) at each step: 3 days before the trial ends, when the
 * grace days start, and 3 days before read-only. Each is sent once (the step is kept in `reminded`).
 */
async function remindAll(base = '') {
  const mailer = require('./mailer');
  if (!mailer.enabled()) return 0;
  const list = await rows(pool, "SELECT b.*, t.name, t.timezone FROM tenant_billing b JOIN tenants t ON t.id = b.tenant_id WHERE t.status = 'active' AND t.sandbox_expires_at IS NULL AND b.comped = 0");
  let sent = 0;
  for (const b of list) {
    const today = todayIn(b.timezone);
    const s = standing(b, today);
    let step = null; let subject = ''; let text = '';
    if (s.kind === 'trial' && s.days_left <= 3) { step = `trial3:${s.until}`; subject = `Your Verdynt/OS trial ends ${s.until}`; text = `Your Verdynt/OS trial for ${b.name} ends on ${s.until}. Choose a plan and add a card, bank account or invoice on Settings, Billing to keep everything running.`; }
    else if (s.state === 'grace' && s.days_left > 3) { step = `grace:${s.until}`; subject = s.kind === 'payment_failed' ? 'A Verdynt/OS payment did not go through' : 'Your Verdynt/OS subscription needs attention'; text = `${b.name}: ${s.kind === 'payment_failed' ? 'the last payment did not go through' : 'your trial or paid time has ended'}. Everything keeps working until ${s.until}; after that Verdynt/OS becomes read only (patrol keeps working). Fix it on Settings, Billing.`; }
    else if (s.state === 'grace') { step = `grace3:${s.until}`; subject = `Verdynt/OS becomes read only on ${s.until}`; text = `${b.name}: Verdynt/OS becomes read only after ${s.until} unless the subscription is paid. Sales, bookings and new records stop; patrol keeps working. Pay on Settings, Billing.`; }
    else if (s.read_only) { step = `readonly:${s.until}`; subject = 'Verdynt/OS is now read only'; text = `${b.name}: your Verdynt/OS subscription has lapsed, so it is read only. Everything can still be seen and exported, and patrol keeps working. Pay on Settings, Billing to turn everything back on.`; }
    if (!step || b.reminded === step) continue;
    const owners = (await rows(pool, "SELECT email FROM users WHERE tenant_id = ? AND role = 'owner' AND active = 1 AND email IS NOT NULL", [b.tenant_id])).map((u) => u.email);
    const to = [...new Set([...owners, b.billing_email].filter(Boolean))];
    if (!to.length) continue;
    for (const addr of to) await mailer.send({ tenantId: b.tenant_id, to: addr, fromName: 'Verdynt/OS', subject, text: `${text}\n\n${base ? `${base}/#/settings/billing` : ''}`, tag: 'billing' });
    await pool.query('UPDATE tenant_billing SET reminded = ? WHERE tenant_id = ?', [step, b.tenant_id]);
    sent += 1;
  }
  return sent;
}

module.exports = { remindAll,
  TRIAL_DAYS, GRACE_DAYS, standing, standingOf, invalidate, gate, publicBlocked, plans, parsePlan, ids, modulesFor, applyModules, event,
  startTrial, syncPlan, lineItems, customerFor, trialEnd, dateOf,
  SEASON_MONTHS, seasonCents, inSummer, nextNovember, pauseUntilNovember, seasonAll,
};
