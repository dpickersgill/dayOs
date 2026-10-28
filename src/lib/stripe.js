'use strict';

// A small Stripe client: hosted Checkout sessions, refunds, Connect accounts and webhook signature checks. It talks to
// the REST API directly (no SDK), so there is nothing extra to install. Money only moves when STRIPE_SECRET_KEY is set.
//
// Guest payments are "direct charges" on the mountain's own connected Stripe account: every call that takes `account`
// sends it as the Stripe-Account header, so the payment, its refunds and Stripe's fees all belong to that mountain.
// Without `account` the call acts on the platform's own account (Verdynt/OS subscriptions, and the old guest payments).
const crypto = require('crypto');
const config = require('../config');
const { AppError } = require('./errors');

const enabled = () => Boolean(config.stripe.secretKey && config.stripe.webhookSecret);

/** Stripe wants nested form fields: { a: { b: 1 }, c: [x] } becomes a[b]=1&c[0]=x. */
function encode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? encode(x, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(x))));
    else if (typeof v === 'object') encode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

const ACCOUNT = /^acct_[A-Za-z0-9]{6,60}$/;
const onAccount = (account) => {
  if (!account) return {};
  if (!ACCOUNT.test(account)) throw new AppError(500, 'That Stripe account is not valid');
  return { 'stripe-account': account };
};

async function call(path, body, { idempotencyKey, account } = {}) {
  let res;
  try {
    res = await fetch(`${config.stripe.apiBase}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.stripe.secretKey}`, 'content-type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}), ...onAccount(account) },
      body: encode(body).toString(),
    });
  } catch (_) {
    throw new AppError(502, 'The card service could not be reached. Please try again in a minute.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Stripe error', res.status, json && json.error && json.error.message);
    throw new AppError(502, 'The card service refused that request. Please try again or call the ski school.');
  }
  return json;
}

/** A GET to Stripe (a subscription, a customer's invoices). */
async function get(path, { account } = {}) {
  let res;
  try { res = await fetch(`${config.stripe.apiBase}${path}`, { headers: { authorization: `Bearer ${config.stripe.secretKey}`, ...onAccount(account) } }); } catch (_) { throw new AppError(502, 'The card service could not be reached.'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { console.error('Stripe error', res.status, json && json.error && json.error.message); throw new AppError(502, 'The card service refused that request.'); }
  return json;
}

/** A DELETE to Stripe (a card reader taken off an account). */
async function del(path, { account } = {}) {
  let res;
  try { res = await fetch(`${config.stripe.apiBase}${path}`, { method: 'DELETE', headers: { authorization: `Bearer ${config.stripe.secretKey}`, ...onAccount(account) } }); } catch (_) { throw new AppError(502, 'The card service could not be reached.'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 404) { console.error('Stripe error', res.status, json && json.error && json.error.message); throw new AppError(502, 'The card service refused that request.'); }
  return json;
}

/** Stripe's own words on why a call failed, for the person at the counter (null when there are none). */
async function tryCall(path, body, opts) {
  let res;
  try {
    res = await fetch(`${config.stripe.apiBase}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.stripe.secretKey}`, 'content-type': 'application/x-www-form-urlencoded', ...(opts && opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}), ...onAccount(opts && opts.account) },
      body: encode(body || {}).toString(),
    });
  } catch (_) { return { ok: false, status: 0, error: 'The card service could not be reached.' }; }
  const json = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, json } : { ok: false, status: res.status, error: (json && json.error && json.error.message) || `Stripe said ${res.status}`, code: json && json.error && json.error.code };
}

/**
 * A hosted payment page for one amount (tax included). Returns { id, url }. account: the mountain's connected account
 * (the payment is theirs); feeCents: the platform's fee on it, kept by Stripe from the payment (0 means none).
 * idempotencyKey: the table and row the payment is for (lesson-12, program-7, shop-40, shopchange-3). It is required:
 * Stripe refuses a reused key for a different request for a day, so a key shared by two rows would turn the second guest
 * away. The amount is added, so a retry at a new price is a new request rather than a refused one.
 */
async function createCheckout({ amountCents, name, description, email, reference, metadata, successUrl, cancelUrl, account = null, feeCents = 0, idempotencyKey }) {
  if (!idempotencyKey || !/^[a-z_]+-\d+$/.test(String(idempotencyKey))) throw new Error('createCheckout needs an idempotencyKey naming its table and row, like lesson-12');
  const s = await call('/v1/checkout/sessions', {
    mode: 'payment',
    'payment_method_types': ['card'],
    customer_email: email,
    client_reference_id: reference,
    success_url: successUrl,
    cancel_url: cancelUrl,
    expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: amountCents, product_data: { name, description } } }],
    metadata,
    payment_intent_data: { metadata, ...(account && feeCents > 0 ? { application_fee_amount: Math.min(feeCents, amountCents) } : {}) },
  }, { idempotencyKey: `checkout-${idempotencyKey}-${amountCents}`, account });
  return { id: s.id, url: s.url };
}

/**
 * Closes a hosted payment page that is still open, so a guest who canceled can no longer pay on it. Returns 'expired';
 * 'closed' when Stripe says it is not open any more (already paid, or already expired); or 'unknown' when Stripe could
 * not be asked. Never throws: a payment that did land is refunded when its webhook arrives.
 */
async function expireCheckout(sessionId, { account = null } = {}) {
  if (!sessionId) return 'closed';
  let r;
  try { r = await tryCall(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {}, { account }); } catch (_) { return 'unknown'; }
  if (r.ok) return 'expired';
  return r.status >= 400 && r.status < 500 ? 'closed' : 'unknown';
}

/** A hosted page for a gift: one time, or every month. Returns { id, url }. */
async function createDonationCheckout({ amountCents, monthly, name, email, metadata, successUrl, cancelUrl, nonce, account = null }) {
  const s = await call('/v1/checkout/sessions', {
    mode: monthly ? 'subscription' : 'payment',
    payment_method_types: ['card'],
    customer_email: email,
    success_url: successUrl,
    cancel_url: cancelUrl,
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: amountCents, product_data: { name }, ...(monthly ? { recurring: { interval: 'month' } } : {}) } }],
    metadata,
    ...(monthly ? { subscription_data: { metadata } } : { payment_intent_data: { metadata } }),
  }, { idempotencyKey: `donate-${nonce}`, account }); // gifts to the patrol carry no platform fee
  return { id: s.id, url: s.url };
}

/** Sends money back to the card. A repeated call with the same key never refunds twice. */
async function refund({ paymentIntent, amountCents, key, metadata, account = null }) {
  // On a connected account the platform's fee goes back too, in proportion, so a refunded guest costs the mountain nothing extra.
  const r = await call('/v1/refunds', { payment_intent: paymentIntent, amount: amountCents, metadata, ...(account ? { refund_application_fee: true } : {}) }, { idempotencyKey: key, account });
  return { id: r.id };
}

/** The refunds already made on a payment (up to 100), so a retry days later can check before refunding again. */
async function listRefunds(paymentIntent, { account = null } = {}) {
  let res;
  try {
    res = await fetch(`${config.stripe.apiBase}/v1/refunds?payment_intent=${encodeURIComponent(paymentIntent)}&limit=100`, { headers: { authorization: `Bearer ${config.stripe.secretKey}`, ...onAccount(account) } });
  } catch (_) { throw new AppError(502, 'The card service could not be reached.'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppError(502, 'The card service refused that request.');
  return Array.isArray(json.data) ? json.data : [];
}

// ---------------------------------------------------------------- Connect: each mountain's own Stripe account
/** A new Standard account for a mountain: theirs to run in their own Stripe dashboard. Returns the account id. */
async function createAccount({ email, name, tenantId }) {
  const a = await call('/v1/accounts', { type: 'standard', country: 'US', email: email || undefined, business_profile: { name: name || undefined }, metadata: { tenant_id: String(tenantId) } },
    { idempotencyKey: `connect-account-${tenantId}` });
  return a.id;
}
/** A one-time Stripe page where the owner finishes (or updates) the account. Expires in minutes; ask for a new one each time. */
async function accountLink({ account, refreshUrl, returnUrl }) {
  const l = await call('/v1/account_links', { account, refresh_url: refreshUrl, return_url: returnUrl, type: 'account_onboarding' });
  return l.url;
}
/** The account as Stripe sees it now: whether it can take payments and receive payouts. */
async function getAccount(account) {
  if (!ACCOUNT.test(String(account || ''))) throw new AppError(400, 'That Stripe account is not valid');
  const a = await get(`/v1/accounts/${account}`);
  return { id: a.id, charges_enabled: Boolean(a.charges_enabled), payouts_enabled: Boolean(a.payouts_enabled), details_submitted: Boolean(a.details_submitted), email: a.email || null,
    name: (a.business_profile && a.business_profile.name) || (a.settings && a.settings.dashboard && a.settings.dashboard.display_name) || null };
}

/** Checks a webhook: the signed timestamp must be recent and the HMAC of "timestamp.body" must match one of the v1 signatures. */
function verifyWebhook(rawBody, header, { secret = config.stripe.webhookSecret, toleranceSeconds = 300, now = Date.now() } = {}) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map((x) => { const i = x.indexOf('='); return [x.slice(0, i).trim(), x.slice(i + 1)]; }));
  const t = Number(parts.t);
  if (!t || Math.abs(now / 1000 - t) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody.toString('utf8')}`).digest('hex');
  const sigs = String(header).split(',').filter((x) => x.trim().startsWith('v1=')).map((x) => x.trim().slice(3));
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

/** Builds a valid header for a body: used by the automated tests. */
function signWebhook(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`;
}

module.exports = { call, get, del, tryCall, enabled, createCheckout, expireCheckout, createDonationCheckout, refund, listRefunds, createAccount, accountLink, getAccount, verifyWebhook, signWebhook, ACCOUNT };
