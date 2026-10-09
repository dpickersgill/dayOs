'use strict';

// A small Stripe client: hosted Checkout sessions, refunds and webhook signature checks. It talks to the REST API
// directly (no SDK), so there is nothing extra to install. Money only moves when STRIPE_SECRET_KEY is set.
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

async function call(path, body, { idempotencyKey } = {}) {
  let res;
  try {
    res = await fetch(`${config.stripe.apiBase}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.stripe.secretKey}`, 'content-type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
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

/** A hosted payment page for one amount (tax included). Returns { id, url }. */
async function createCheckout({ amountCents, name, description, email, reference, metadata, successUrl, cancelUrl }) {
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
    payment_intent_data: { metadata },
  }, { idempotencyKey: `checkout-${metadata.request_id}-${amountCents}` });
  return { id: s.id, url: s.url };
}

/** A hosted page for a gift: one time, or every month. Returns { id, url }. */
async function createDonationCheckout({ amountCents, monthly, name, email, metadata, successUrl, cancelUrl, nonce }) {
  const s = await call('/v1/checkout/sessions', {
    mode: monthly ? 'subscription' : 'payment',
    payment_method_types: ['card'],
    customer_email: email,
    success_url: successUrl,
    cancel_url: cancelUrl,
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: amountCents, product_data: { name }, ...(monthly ? { recurring: { interval: 'month' } } : {}) } }],
    metadata,
    ...(monthly ? { subscription_data: { metadata } } : { payment_intent_data: { metadata } }),
  }, { idempotencyKey: `donate-${nonce}` });
  return { id: s.id, url: s.url };
}

/** Sends money back to the card. A repeated call with the same key never refunds twice. */
async function refund({ paymentIntent, amountCents, key }) {
  const r = await call('/v1/refunds', { payment_intent: paymentIntent, amount: amountCents }, { idempotencyKey: key });
  return { id: r.id };
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

module.exports = { enabled, createCheckout, createDonationCheckout, refund, verifyWebhook, signWebhook };
