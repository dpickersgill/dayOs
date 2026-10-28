'use strict';

// Stripe Connect: guests' card payments go to the mountain's own Stripe account, never the platform's. The owner connects
// it (after confirming it is them), the online shop opens only once Stripe says the account can take payments, every
// checkout and refund is made on that account, the platform's fee is 0 unless the console sets one, gifts never carry a
// fee, and an event from one mountain's account can never touch another mountain. Stripe is a mock server.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.SHOP_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_platform';
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect';
process.env.STRIPE_GUEST_FALLBACK = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const config = require('../src/config');
const stripe = require('../src/lib/stripe');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const sessions = require('../src/lib/sessions');

let server; let base; let mock; let n = 0;
const calls = []; const accounts = new Map(); const refundsMade = [];
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const KEY = 'test-bootstrap-key';
const q = async (sql, params) => (await pool.query(sql, params))[0];
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const plus = (d, k) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };

async function call(prefix, method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}${prefix}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const api = (m, p, o) => call('/api/v1', m, p, o);
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${r.text}`);
const login = async (slug, email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
// The owner has just confirmed it is them (what the app's step-up dialog does).
const sid = (token) => sessions.hash(JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sid);
const stepUp = (token) => pool.query('UPDATE user_sessions SET stepped_up_at = UTC_TIMESTAMP() WHERE id_hash = ?', [sid(token)]);
const stepDown = (token) => pool.query('UPDATE user_sessions SET stepped_up_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE) WHERE id_hash = ?', [sid(token)]);
async function mountain(tag) {
  const slug = `cn${tag}-${suffix}`;
  is(await api('POST', '/tenants', { headers: { 'x-bootstrap-key': KEY }, body: { slug, name: `Mount ${tag}`, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } } }), 201);
  const owner = await login(slug, `owner@${slug}.test`);
  return { slug, owner, id: (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id };
}
async function webhook(event, secret = 'whsec_connect') {
  const raw = JSON.stringify(event);
  const res = await fetch(`${base}/api/v1/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripe.signWebhook(raw, secret) }, body: raw });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const accountUpdated = (acct, ready) => ({ id: `evt_${++n}`, type: 'account.updated', account: acct, data: { object: { id: acct, charges_enabled: ready, payouts_enabled: ready, details_submitted: ready } } });
const paid = (row, tenantId, acct, extra = {}) => ({ id: `evt_${++n}`, type: 'checkout.session.completed', ...(acct ? { account: acct } : {}),
  data: { object: { id: row.stripe_session_id, payment_status: 'paid', amount_total: row.amount_cents, payment_intent: `pi_${row.stripe_session_id}`,
    metadata: { tenant_id: String(tenantId), request_id: String(row.id), shop_order_id: String(row.id), kind: 'shop', ...extra } } } });

let A; let B; let C; let productA; let acctA;
const holder = { first_name: 'Ann', last_name: 'Buyer', date_of_birth: '1990-04-01' };
const basket = (product) => ({ contact_first_name: 'Ann', contact_last_name: 'Buyer', contact_email: 'ann@x.test', contact_phone: '215-555-0100', items: [{ product_id: product, valid_on: plus(today, 3), holder }], waiver_accepted: true, terms_accepted: true });
async function buy(m, product) {
  const r = await call('/api/v1/public', 'POST', `/${m.slug}/shop/orders`, { body: basket(product) });
  return { r, row: r.status === 201 ? (await q('SELECT * FROM shop_orders WHERE tenant_id = ? AND reference = ?', [m.id, r.body.reference]))[0] : null };
}

test.before(async () => {
  mock = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const params = Object.fromEntries(new URLSearchParams(data));
      calls.push({ method: req.method, path: req.url, params, account: req.headers['stripe-account'] || null });
      res.setHeader('content-type', 'application/json');
      const acctPath = req.url.match(/^\/v1\/accounts\/(acct_\w+)$/);
      if (req.url === '/v1/accounts' && req.method === 'POST') {
        const id = `acct_mock${++n}${suffix.replace(/\W/g, '')}`;
        accounts.set(id, { id, charges_enabled: false, payouts_enabled: false, details_submitted: false, email: params.email, business_profile: { name: params['business_profile[name]'] } });
        res.end(JSON.stringify(accounts.get(id)));
      } else if (acctPath) res.end(JSON.stringify(accounts.get(acctPath[1]) || {}));
      else if (req.url === '/v1/account_links') res.end(JSON.stringify({ url: `https://connect.stripe.test/setup/${params.account}` }));
      else if (req.url === '/v1/checkout/sessions') res.end(JSON.stringify({ id: `cs_cn_${++n}`, url: `https://checkout.stripe.test/c/${n}` }));
      else if (req.url === '/v1/refunds') { const made = { id: `re_${++n}`, payment_intent: params.payment_intent, status: 'succeeded', metadata: {} }; refundsMade.push(made); res.end(JSON.stringify(made)); }
      else if (req.url.startsWith('/v1/refunds?')) res.end(JSON.stringify({ data: [] }));
      else { res.statusCode = 404; res.end('{}'); }
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  config.stripe.apiBase = `http://127.0.0.1:${mock.address().port}`;
  config.stripe.guestFallback = false; // as in production: no connected account, no card payments
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain('a'); B = await mountain('b'); C = await mountain('c');
  for (const m of [A, B]) {
    is(await api('PUT', '/tenant/profile', { token: m.owner, body: { online_shop: true } }), 200);
  }
  productA = (await api('POST', '/products', { token: A.owner, body: { kind: 'day_ticket', name: 'Day ticket', base_price_cents: 6000, online: 1 } })).body.id;
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => mock.close(r)); await pool.end(); });

test('with no connected account, card payments stay off and nothing goes to the platform\'s account', async () => {
  const s = await api('GET', '/payments/stripe', { token: A.owner });
  is(s, 200);
  assert.equal(s.body.status, 'not_connected'); assert.equal(s.body.can_connect, true); assert.equal(s.body.platform_fee_bps, 0);
  assert.equal((await call('/api/v1/public', 'GET', `/${A.slug}/shop`)).body.open, false, 'the shop shows as closed');
  const before = calls.length;
  const { r } = await buy(A, productA);
  is(r, 409, 'no basket goes to a card page');
  assert.match(r.body.error, /not open/);
  assert.ok(!calls.slice(before).some((c) => c.path === '/v1/checkout/sessions'));
  assert.equal((await api('GET', '/tenant/profile', { token: A.owner })).body.stripe_ready, false);
});

test('only the owner connects, after confirming it is them; Stripe\'s pages finish the account', async () => {
  is(await api('POST', '/users', { token: A.owner, body: { email: `mgr@${A.slug}.test`, password: PW, role: 'manager' } }), 201);
  const mgr = await login(A.slug, `mgr@${A.slug}.test`);
  is(await api('POST', '/payments/stripe/link', { token: mgr, body: {} }), 403, 'a manager cannot');
  assert.equal((await api('GET', '/payments/stripe', { token: mgr })).body.can_connect, false, 'but can look');
  await stepDown(A.owner); // signing in a while ago is not enough
  const noCheck = await api('POST', '/payments/stripe/link', { token: A.owner, body: {} });
  is(noCheck, 403); assert.equal(noCheck.body.details.code, 'step_up_required');
  await stepUp(A.owner);
  const link = await api('POST', '/payments/stripe/link', { token: A.owner, body: {} });
  is(link, 200);
  acctA = (await q('SELECT stripe_account FROM tenants WHERE id = ?', [A.id]))[0].stripe_account;
  assert.match(acctA, /^acct_mock/);
  assert.equal(link.body.url, `https://connect.stripe.test/setup/${acctA}`);
  const made = calls.find((c) => c.path === '/v1/accounts' && c.method === 'POST');
  assert.equal(made.params.type, 'standard'); assert.equal(made.params.email, `owner@${A.slug}.test`); assert.equal(made.account, null, 'made by the platform');
  const linkCall = calls.filter((c) => c.path === '/v1/account_links').pop();
  assert.match(linkCall.params.return_url, /#\/settings\/payments\?stripe=return$/);
  // A second press reuses the same account
  is(await api('POST', '/payments/stripe/link', { token: A.owner, body: {} }), 200);
  assert.equal(calls.filter((c) => c.path === '/v1/accounts' && c.method === 'POST').length, 1);
  // Until Stripe says it can take payments, the shop stays closed
  assert.equal((await api('GET', '/payments/stripe', { token: A.owner })).body.status, 'unfinished');
  is((await buy(A, productA)).r, 409);
  // Stripe's webhook says the account is ready
  is(await webhook(accountUpdated(acctA, true)), 200);
  const s = await api('GET', '/payments/stripe', { token: A.owner });
  assert.equal(s.body.status, 'ready'); assert.equal(s.body.payouts_enabled, true);
  assert.equal((await call('/api/v1/public', 'GET', `/${A.slug}/shop`)).body.open, true);
  const audit = await q("SELECT action FROM audit_log WHERE tenant_id = ? AND action = 'stripe_connect_start'", [A.id]);
  assert.equal(audit.length, 1);
});

test('coming back from Stripe reads the account straight away', async () => {
  await stepUp(C.owner);
  is(await api('POST', '/payments/stripe/link', { token: C.owner, body: {} }), 200);
  const acct = (await q('SELECT stripe_account FROM tenants WHERE id = ?', [C.id]))[0].stripe_account;
  accounts.get(acct).charges_enabled = true; accounts.get(acct).business_profile.name = 'Mount C LLC';
  const back = await api('GET', '/payments/stripe?refresh=1', { token: C.owner });
  assert.equal(back.body.status, 'ready'); assert.equal(back.body.business_name, 'Mount C LLC');
});

test('a guest pays on the mountain\'s own account, with no platform fee by default', async () => {
  const before = calls.length;
  const { r, row } = await buy(A, productA);
  is(r, 201);
  const co = calls.slice(before).find((c) => c.path === '/v1/checkout/sessions');
  assert.equal(co.account, acctA, 'the checkout is on the mountain\'s account');
  assert.equal(co.params['payment_intent_data[application_fee_amount]'], undefined, 'no fee');
  const w = await webhook(paid(row, A.id, acctA));
  is(w, 200);
  const pay = (await q("SELECT processor_account, platform_fee_cents FROM order_payments WHERE tenant_id = ? AND reference = ?", [A.id, `pi_${row.stripe_session_id}`]))[0];
  assert.equal(pay.processor_account, acctA); assert.equal(pay.platform_fee_cents, 0);
});

test('a fee set in the console is kept by Stripe from each payment, and given back in proportion on a refund', async () => {
  is(await api('PATCH', `/platform/tenants/${A.id}`, { headers: { 'x-platform-key': KEY }, body: { platform_fee_bps: 150, platform_fee_cents: 30 } }), 200);
  is(await api('PATCH', `/platform/tenants/${A.id}`, { headers: { 'x-platform-key': KEY }, body: { platform_fee_bps: 5000 } }), 400, 'at most 10%');
  const before = calls.length;
  const { row } = await buy(A, productA);
  const co = calls.slice(before).find((c) => c.path === '/v1/checkout/sessions');
  const fee = Math.round(row.amount_cents * 0.015) + 30;
  assert.equal(co.params['payment_intent_data[application_fee_amount]'], String(fee));
  assert.equal(co.params['metadata[platform_fee_cents]'], String(fee));
  is(await webhook(paid(row, A.id, acctA, { platform_fee_cents: String(fee) })), 200);
  const o = (await q('SELECT id FROM orders WHERE tenant_id = ? AND payment_ref = ?', [A.id, `pi_${row.stripe_session_id}`]))[0];
  assert.equal((await q('SELECT platform_fee_cents FROM order_payments WHERE tenant_id = ? AND order_id = ?', [A.id, o.id]))[0].platform_fee_cents, fee);
  const consoleView = (await api('GET', `/platform/tenants/${A.id}`, { headers: { 'x-platform-key': KEY } })).body;
  assert.equal(consoleView.card_payments.status, 'ready'); assert.ok(Number(consoleView.platform_fees.fee_cents) >= fee);
  // Staff refund: back through the mountain's account, with the fee returned
  const mark = calls.length;
  const rf = await api('POST', `/orders/${o.id}/refund`, { token: A.owner, body: { reason: 'customer_request' } });
  is(rf, 200); assert.equal(rf.body.card_refunded, true);
  const sent = calls.slice(mark).find((c) => c.path === '/v1/refunds');
  assert.equal(sent.account, acctA); assert.equal(sent.params.refund_application_fee, 'true');
  is(await api('PATCH', `/platform/tenants/${A.id}`, { headers: { 'x-platform-key': KEY }, body: { platform_fee_bps: 0, platform_fee_cents: 0 } }), 200);
});

test('the account a payment was taken on is recorded with the sale itself, so nothing after the sale can lose it', async () => {
  const { row } = await buy(A, productA);
  // Anything written after the sale's own transaction fails (a dropped connection, say).
  const real = pool.query;
  pool.query = function (sql, ...rest) { return /UPDATE order_payments SET processor_account/.test(String(sql)) ? Promise.reject(new Error('connection lost')) : real.call(this, sql, ...rest); };
  try { is(await webhook(paid(row, A.id, acctA, { platform_fee_cents: '45' })), 200); } finally { pool.query = real; }
  const pay = (await q('SELECT processor_account, platform_fee_cents FROM order_payments WHERE tenant_id = ? AND reference = ?', [A.id, `pi_${row.stripe_session_id}`]))[0];
  assert.equal(pay.processor_account, acctA); assert.equal(pay.platform_fee_cents, 45);
  // A paid page we cannot match is refunded on that same account.
  const mark = calls.length;
  const other = await buy(A, productA);
  const w = await webhook(paid({ ...other.row, stripe_session_id: `cs_lost_${suffix}` }, A.id, acctA));
  assert.equal(w.body.refunded, true);
  assert.equal(calls.slice(mark).filter((c) => c.path === '/v1/refunds').pop().account, acctA);
});

test('a payment we cannot honor is refunded on the account it was paid on', async () => {
  const { row } = await buy(A, productA);
  const mark = calls.length;
  const w = await webhook(paid(row, A.id, acctA, {}), 'whsec_connect');
  is(w, 200);
  // a mismatched amount on a second order
  const two = await buy(A, productA);
  const ev = paid(two.row, A.id, acctA); ev.data.object.amount_total -= 100;
  assert.equal((await webhook(ev)).body.refunded, true);
  const sent = calls.slice(mark).filter((c) => c.path === '/v1/refunds').pop();
  assert.equal(sent.account, acctA);
});

test('an event from one mountain\'s Stripe account can never touch another mountain', async () => {
  // Mountain B connects its own account
  await stepUp(B.owner);
  is(await api('POST', '/payments/stripe/link', { token: B.owner, body: {} }), 200);
  const acctB = (await q('SELECT stripe_account FROM tenants WHERE id = ?', [B.id]))[0].stripe_account;
  is(await webhook(accountUpdated(acctB, true)), 200);
  // B's account sends a "paid" event naming one of A's orders
  const { row } = await buy(A, productA);
  const forged = await webhook(paid(row, A.id, acctB));
  is(forged, 200); assert.equal(forged.body.ignored, true);
  assert.equal((await q('SELECT status FROM shop_orders WHERE id = ?', [row.id]))[0].status, 'awaiting_payment', 'nothing sold');
  // An unknown account, and an account.updated for an account no mountain has, change nothing
  assert.equal((await webhook(paid(row, A.id, 'acct_nobody123'))).body.ignored, true);
  assert.equal((await webhook(accountUpdated('acct_nobody123', true))).body.account, 'unknown');
  // A connected account's event signed with the platform secret is still screened the same way
  assert.equal((await webhook(paid(row, A.id, acctB), 'whsec_platform')).body.ignored, true);
  assert.equal((await webhook(paid(row, A.id, acctA), 'whsec_wrong')).status, 400, 'a bad signature is refused');
  // The real event from A's own account sells it
  is(await webhook(paid(row, A.id, acctA)), 200);
  assert.equal((await q('SELECT status FROM shop_orders WHERE id = ?', [row.id]))[0].status, 'paid');
});

test('gifts to the patrol go to the mountain\'s account and never carry a fee', async () => {
  is(await api('PATCH', `/platform/tenants/${A.id}`, { headers: { 'x-platform-key': KEY }, body: { platform_fee_bps: 200 } }), 200);
  const mark = calls.length;
  const g = await call('/api/v1/public', 'POST', `/${A.slug}/give`, { body: { amount: 50 } });
  is(g, 200);
  const co = calls.slice(mark).find((c) => c.path === '/v1/checkout/sessions');
  assert.equal(co.account, acctA);
  assert.ok(!Object.keys(co.params).some((k) => k.includes('application_fee')), 'no fee on a gift');
  is(await api('PATCH', `/platform/tenants/${A.id}`, { headers: { 'x-platform-key': KEY }, body: { platform_fee_bps: 0 } }), 200);
});

test('disconnecting stops card payments; earlier payments still refund through the account they were paid on', async () => {
  const { row } = await buy(A, productA);
  is(await webhook(paid(row, A.id, acctA)), 200);
  const o = (await q('SELECT id FROM orders WHERE tenant_id = ? AND payment_ref = ?', [A.id, `pi_${row.stripe_session_id}`]))[0];
  is(await api('POST', '/payments/stripe/disconnect', { token: A.owner, body: {} }), 200);
  assert.equal((await api('GET', '/payments/stripe', { token: A.owner })).body.status, 'not_connected');
  is((await buy(A, productA)).r, 409, 'the shop takes no more cards');
  const mark = calls.length;
  is(await api('POST', `/orders/${o.id}/refund`, { token: A.owner, body: { reason: 'customer_request' } }), 200);
  assert.equal(calls.slice(mark).find((c) => c.path === '/v1/refunds').account, acctA);
  const audit = await q("SELECT action FROM audit_log WHERE tenant_id = ? AND action = 'stripe_disconnect'", [A.id]);
  assert.equal(audit.length, 1);
});

test('a demo mountain cannot connect, and the platform\'s own subscription events still work without an account', async () => {
  await pool.query('UPDATE tenants SET sandbox_expires_at = DATE_ADD(NOW(), INTERVAL 3 DAY) WHERE id = ?', [C.id]);
  await pool.query('UPDATE tenants SET stripe_account = NULL WHERE id = ?', [C.id]);
  await stepUp(C.owner);
  is(await api('POST', '/payments/stripe/link', { token: C.owner, body: {} }), 409);
  await pool.query('UPDATE tenants SET sandbox_expires_at = NULL WHERE id = ?', [C.id]);
  // An event on the platform account with no metadata we know is simply received
  const r = await webhook({ id: `evt_${++n}`, type: 'invoice.paid', data: { object: { id: 'in_x', subscription: 'sub_unknown' } } }, 'whsec_platform');
  is(r, 200);
});
