'use strict';

// Stripe Connect: each mountain's guest card payments (the online shop, lesson payments, date changes and patrol
// giving) go to the mountain's own Stripe account, connected from Settings, Card payments. DAY/OS never holds a
// mountain's money. The mountain pays Stripe's own fees on its account; DAY/OS adds a platform fee only when the
// console sets one for that mountain (platform_fee_bps and platform_fee_cents, both 0 unless changed), and never on
// gifts to the patrol.
//
// Without a connected account, guest card payments stay off, except where STRIPE_GUEST_FALLBACK is on (tests and local
// runs), when they fall back to the platform's own account as before.
const { pool, one } = require('../db');
const config = require('../config');
const stripe = require('./stripe');
const { AppError } = require('./errors');
const { logFailure } = require('./jobs');

const NOT_READY = 'Card payment is not set up for this mountain yet. Please pay at the mountain, or call.';
const COLS = 'stripe_account, stripe_charges_enabled, stripe_payouts_enabled, stripe_details_submitted, stripe_connected_at, stripe_checked_at, platform_fee_bps, platform_fee_cents';

/** Whether a tenant row (with the Connect columns) can take a guest card payment now. */
function readyRow(t) {
  if (!stripe.enabled() || !t) return false;
  if (t.stripe_account) return Boolean(Number(t.stripe_charges_enabled));
  return config.stripe.guestFallback;
}

/**
 * Where a guest payment for this mountain goes: { ok, account, bps, cents }. account null means the platform's own
 * account (only with the fallback). ok false: card payments are not open (why: off, unfinished or not_connected).
 */
async function payee(tenantId, conn = pool) {
  if (!stripe.enabled()) return { ok: false, why: 'off' };
  const t = await one(conn, `SELECT ${COLS} FROM tenants WHERE id = ?`, [tenantId]);
  if (!t) return { ok: false, why: 'off' };
  if (t.stripe_account) {
    if (!Number(t.stripe_charges_enabled)) return { ok: false, why: 'unfinished' };
    return { ok: true, account: t.stripe_account, bps: Number(t.platform_fee_bps) || 0, cents: Number(t.platform_fee_cents) || 0 };
  }
  if (config.stripe.guestFallback) return { ok: true, account: null, bps: 0, cents: 0 };
  return { ok: false, why: 'not_connected' };
}

/** The same, or a clear error for the guest. */
async function payeeOrThrow(tenantId, conn) {
  const p = await payee(tenantId, conn);
  if (!p.ok) throw new AppError(503, NOT_READY);
  return p;
}

/** The platform's fee on a payment: a share in basis points plus a fixed amount, never more than the payment. 0 off Connect. */
function feeFor(p, amountCents) {
  if (!p || !p.account || !(amountCents > 0)) return 0;
  return Math.min(amountCents, Math.round((amountCents * (p.bps || 0)) / 10000) + (p.cents || 0));
}

/** The checkout options for one guest payment: the account and fee for Stripe, and the fee in the metadata so the webhook can record it. */
function checkoutFor(p, amountCents, metadata) {
  const feeCents = feeFor(p, amountCents);
  return { account: p.account || null, feeCents, metadata: { ...metadata, ...(feeCents ? { platform_fee_cents: String(feeCents) } : {}) } };
}

/** Reads the account from Stripe and keeps its state on the mountain. Returns the mountain's Connect state. */
async function refresh(tenantId) {
  const t = await one(pool, 'SELECT stripe_account FROM tenants WHERE id = ?', [tenantId]);
  if (!t || !t.stripe_account) return state(tenantId);
  const a = await stripe.getAccount(t.stripe_account);
  await pool.query('UPDATE tenants SET stripe_charges_enabled = ?, stripe_payouts_enabled = ?, stripe_details_submitted = ?, stripe_checked_at = NOW(), stripe_connected_at = COALESCE(stripe_connected_at, IF(?, NOW(), NULL)) WHERE id = ? AND stripe_account = ?',
    [a.charges_enabled ? 1 : 0, a.payouts_enabled ? 1 : 0, a.details_submitted ? 1 : 0, a.charges_enabled ? 1 : 0, tenantId, a.id]);
  return state(tenantId, a);
}

/** What the owner sees: connected or not, whether payments and payouts work, and the platform fee. */
async function state(tenantId, live = null) {
  const t = await one(pool, `SELECT ${COLS} FROM tenants WHERE id = ?`, [tenantId]);
  const connected = Boolean(t && t.stripe_account);
  const status = !stripe.enabled() ? 'off' : !connected ? 'not_connected' : Number(t.stripe_charges_enabled) ? 'ready' : 'unfinished';
  return {
    status, enabled: stripe.enabled(), connected, account: connected ? t.stripe_account : null,
    charges_enabled: Boolean(t && Number(t.stripe_charges_enabled)), payouts_enabled: Boolean(t && Number(t.stripe_payouts_enabled)),
    details_submitted: Boolean(t && Number(t.stripe_details_submitted)), connected_at: t ? t.stripe_connected_at : null, checked_at: t ? t.stripe_checked_at : null,
    business_name: live ? live.name : null, platform_fee_bps: t ? Number(t.platform_fee_bps) : 0, platform_fee_cents: t ? Number(t.platform_fee_cents) : 0,
    fallback: !connected && config.stripe.guestFallback && stripe.enabled(),
  };
}

/** The mountain that owns a connected account, or null. */
async function tenantForAccount(account) {
  if (!account) return null;
  const t = await one(pool, 'SELECT id FROM tenants WHERE stripe_account = ?', [String(account)]);
  return t ? Number(t.id) : null;
}

/**
 * Screens a webhook event before anything acts on it. Events from the platform's own account (no event.account) pass.
 * An event from a connected account is only trusted for the mountain that owns that account: a mountain controls its
 * own Stripe account, so it could otherwise send events naming another mountain. Account events update the stored state.
 * Returns { pass: true } to carry on, or { done: result } when the event was handled or must be ignored.
 */
async function screen(event) {
  if (!event || !event.account) return { pass: true };
  const tenantId = await tenantForAccount(event.account);
  const obj = event.data && event.data.object;
  if (event.type === 'account.updated' && obj && obj.id === event.account) {
    if (tenantId) {
      await pool.query('UPDATE tenants SET stripe_charges_enabled = ?, stripe_payouts_enabled = ?, stripe_details_submitted = ?, stripe_checked_at = NOW(), stripe_connected_at = COALESCE(stripe_connected_at, IF(?, NOW(), NULL)) WHERE id = ?',
        [obj.charges_enabled ? 1 : 0, obj.payouts_enabled ? 1 : 0, obj.details_submitted ? 1 : 0, obj.charges_enabled ? 1 : 0, tenantId]);
    }
    return { done: { account: tenantId ? 'updated' : 'unknown' } };
  }
  if (event.type === 'account.application.deauthorized') {
    // The mountain disconnected DAY/OS from its Stripe dashboard: card payments stop until it connects again.
    if (tenantId) await pool.query('UPDATE tenants SET stripe_charges_enabled = 0, stripe_payouts_enabled = 0 WHERE id = ?', [tenantId]);
    return { done: { account: tenantId ? 'disconnected' : 'unknown' } };
  }
  if (!tenantId) return { done: { ignored: true } };
  const claimed = obj && obj.metadata && obj.metadata.tenant_id;
  if (claimed && Number(claimed) !== tenantId) {
    logFailure({ job: 'stripe_webhook', event: event.type, message: `connected account ${event.account} sent an event for another mountain` });
    return { done: { ignored: true } };
  }
  return { pass: true, tenantId };
}

/** After a paid checkout on a connected account: note on the payment which account holds it (for refunds) and the fee kept. */
async function stamp(event) {
  const obj = event && event.data && event.data.object;
  if (!event || !event.account || event.type !== 'checkout.session.completed' || !obj || !obj.metadata) return;
  const tenantId = Number(obj.metadata.tenant_id);
  const fee = Number(obj.metadata.platform_fee_cents) || 0;
  try {
    if (obj.payment_intent) {
      await pool.query("UPDATE order_payments SET processor_account = ?, platform_fee_cents = ? WHERE tenant_id = ? AND reference = ? AND processor = 'stripe' AND processor_account IS NULL",
        [event.account, fee, tenantId, String(obj.payment_intent)]);
    }
    if (obj.metadata.kind === 'donation') await pool.query('UPDATE donations SET stripe_account = ? WHERE tenant_id = ? AND stripe_session_id = ?', [event.account, tenantId, obj.id]);
  } catch (err) { logFailure({ job: 'stripe_webhook', event: event.type, message: `could not note the account: ${err.message}` }); }
}

/** The account a card payment was taken on (for its refund): the one noted on the payment, else the platform's (null). */
async function accountOfPayment(conn, tenantId, paymentIntent) {
  const p = await one(conn, "SELECT processor_account FROM order_payments WHERE tenant_id = ? AND reference = ? AND processor = 'stripe' AND processor_account IS NOT NULL LIMIT 1", [tenantId, String(paymentIntent)]);
  return p ? p.processor_account : null;
}

module.exports = { NOT_READY, readyRow, payee, payeeOrThrow, feeFor, checkoutFor, refresh, state, tenantForAccount, screen, stamp, accountOfPayment };
