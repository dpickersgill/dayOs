'use strict';

// Card readers at the counter: a manager pairs a Stripe smart reader (the first one needs the mountain's address, for
// Stripe's location), the ticket window sends the amount to the reader, the payment is checked with Stripe until it
// settles, and a completed sale records it like an online card payment (on the mountain's account, refundable). A
// declined card, an offline reader and a canceled charge never record money; a charge that never became part of a
// sale is refunded; and one mountain can never use or see another's readers or payments. Stripe is a mock server.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_platform';
process.env.STRIPE_GUEST_FALLBACK = 'on';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base; let mock; let n = 0;
const calls = []; const intents = new Map(); const readers = new Map(); const refunds = [];
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const q = async (sql, params) => (await pool.query(sql, params))[0];

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${r.text}`);
async function mountain(tag) {
  const slug = `tm${tag}-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: `Reader ${tag}`, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  const owner = await login(`owner@${slug}.test`);
  is(await api('POST', '/users', { token: owner, body: { email: `counter@${slug}.test`, password: PW, role: 'counter' } }), 201);
  const day = (await api('POST', '/products', { token: owner, body: { kind: 'day_ticket', name: 'Adult Day', base_price_cents: 6000 } })).body.id;
  return { slug, owner, counter: await login(`counter@${slug}.test`), id: (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id, day };
}
const ADDRESS = { line1: '1 Summit Road', city: 'Limerick', state: 'pa', postal_code: '19468' };
const sale = (m, terminalId, amount = 6000) => api('POST', '/checkout', { token: m.counter, body: { quick: true, lines: [{ type: 'ticket', product_id: m.day }], payments: [{ tender: 'card', amount_cents: amount, terminal_payment_id: terminalId }] } });
async function waitFor(m, id, want) {
  for (let i = 0; i < 10; i += 1) { const r = await api('GET', `/terminal/payments/${id}`, { token: m.counter }); if (r.body.status === want) return r.body; }
  assert.fail(`payment ${id} never became ${want}`);
}

let A; let B;
test.before(async () => {
  mock = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const params = Object.fromEntries(new URLSearchParams(data));
      const url = req.url.split('?')[0];
      calls.push({ method: req.method, path: url, params, account: req.headers['stripe-account'] || null });
      const send = (status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
      let m;
      if (url === '/v1/terminal/locations') return send(200, { id: `tml_${++n}` });
      if (url === '/v1/terminal/readers' && req.method === 'POST') {
        if (params.registration_code === 'wrong-code') return send(400, { error: { message: 'The registration code is invalid.' } });
        const id = `tmr_${suffix}${++n}`;
        readers.set(id, { id, action: null, offline: params.registration_code === 'offline-reader' });
        return send(200, { id, device_type: /^simulated/.test(params.registration_code) ? 'simulated_wisepos_e' : 'stripe_s700', serial_number: `SN${n}` });
      }
      if ((m = url.match(/^\/v1\/terminal\/readers\/(tmr_\w+)$/))) {
        if (req.method === 'DELETE') { readers.delete(m[1]); return send(200, { deleted: true }); }
        return send(200, readers.get(m[1]) || {});
      }
      if ((m = url.match(/^\/v1\/terminal\/readers\/(tmr_\w+)\/process_payment_intent$/))) {
        const r = readers.get(m[1]);
        if (r.offline) return send(400, { error: { message: 'Reader is currently offline, please ensure the reader is powered on and connected to the internet.' } });
        r.action = { status: 'in_progress', payment_intent: params.payment_intent };
        return send(200, r);
      }
      if ((m = url.match(/^\/v1\/terminal\/readers\/(tmr_\w+)\/cancel_action$/))) { readers.get(m[1]).action = null; return send(200, readers.get(m[1])); }
      if ((m = url.match(/^\/v1\/test_helpers\/terminal\/readers\/(tmr_\w+)\/present_payment_method$/))) {
        const r = readers.get(m[1]); const pi = intents.get(r.action.payment_intent);
        if (params['card_present[number]'] === '4000000000000002') {
          r.action = { ...r.action, status: 'failed', failure_message: 'Your card was declined.' };
          pi.last_payment_error = { message: 'Your card was declined.' };
        } else {
          r.action = { ...r.action, status: 'succeeded' };
          pi.status = 'succeeded';
          pi.latest_charge = { id: `ch_${++n}`, payment_method_details: { type: 'card_present', card_present: { brand: 'visa', last4: '4242' } } };
        }
        return send(200, r);
      }
      if (url === '/v1/payment_intents' && req.method === 'POST') {
        const id = `pi_${suffix}${++n}`;
        intents.set(id, { id, status: 'requires_payment_method', amount: Number(params.amount), account: req.headers['stripe-account'] || null, fee: params.application_fee_amount || null, last_payment_error: null });
        return send(200, intents.get(id));
      }
      if ((m = url.match(/^\/v1\/payment_intents\/(pi_\w+)\/cancel$/))) {
        const pi = intents.get(m[1]);
        if (pi.status === 'succeeded') return send(400, { error: { message: 'This PaymentIntent has already succeeded.' } });
        pi.status = 'canceled'; return send(200, pi);
      }
      if ((m = url.match(/^\/v1\/payment_intents\/(pi_\w+)$/))) return send(200, intents.get(m[1]));
      if (url === '/v1/refunds' && req.method === 'POST') { refunds.push({ ...params, account: req.headers['stripe-account'] || null }); return send(200, { id: `re_${++n}` }); }
      if (url === '/v1/refunds') return send(200, { data: [] });
      return send(404, { error: { message: `no mock for ${req.method} ${url}` } });
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  process.env.STRIPE_API_BASE = `http://127.0.0.1:${mock.address().port}`;
  require('../src/config').stripe.apiBase = process.env.STRIPE_API_BASE;
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain('a'); B = await mountain('b');
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => mock.close(r)); await pool.end(); });

test('a manager pairs readers; the first needs the mountain’s address; staff cannot pair; a bad code says why', async () => {
  is(await api('POST', '/terminal/readers', { token: A.counter, body: { registration_code: 'simulated-wpe', label: 'Window 1' } }), 403, 'the counter cannot pair');
  const noAddr = await api('POST', '/terminal/readers', { token: A.owner, body: { registration_code: 'simulated-wpe', label: 'Window 1' } });
  is(noAddr, 400); assert.match(noAddr.body.error, /street address/);
  const wrong = await api('POST', '/terminal/readers', { token: A.owner, body: { registration_code: 'wrong-code', label: 'Window 1', address: ADDRESS } });
  is(wrong, 400); assert.match(wrong.body.error, /registration code is invalid/);
  const r1 = await api('POST', '/terminal/readers', { token: A.owner, body: { registration_code: 'simulated-wpe', label: 'Window 1', address: ADDRESS } });
  is(r1, 201); assert.equal(r1.body.simulated, true);
  const loc = calls.filter((c) => c.path === '/v1/terminal/locations');
  assert.equal(loc.length, 1); assert.equal(loc[0].params['address[state]'], 'PA'); assert.equal(loc[0].params['address[country]'], 'US');
  is(await api('POST', '/terminal/readers', { token: A.owner, body: { registration_code: 'apple-grape-pear', label: 'Window 2' } }), 201, 'the second reader reuses the location');
  assert.equal(calls.filter((c) => c.path === '/v1/terminal/locations').length, 1);
  const list = await api('GET', '/terminal/readers', { token: A.counter });
  assert.deepEqual(list.body.readers.map((x) => x.label), ['Window 1', 'Window 2']);
  assert.equal(list.body.test_mode, true);
  A.reader = r1.body.id; A.real = list.body.readers[1].id;
  assert.deepEqual((await api('GET', '/terminal/readers', { token: B.counter })).body.readers, [], 'another mountain sees none of them');
});

test('a tap at the reader pays for the sale, recorded like an online card payment and refundable', async () => {
  const c = await api('POST', '/terminal/charges', { token: A.counter, body: { reader_id: A.reader, amount_cents: 6000 } });
  is(c, 201); assert.equal(c.body.status, 'waiting');
  const pi = calls.find((x) => x.path === '/v1/payment_intents' && x.params.amount === '6000');
  assert.equal(pi.params['payment_method_types[0]'], 'card_present');
  assert.equal(pi.params['metadata[tenant_id]'], String(A.id));
  is(await sale(A, c.body.id), 409, 'a sale cannot use a payment that has not gone through');
  is(await api('POST', `/terminal/payments/${c.body.id}/simulate`, { token: A.counter, body: { outcome: 'approve' } }), 200);
  const done = await waitFor(A, c.body.id, 'succeeded');
  assert.equal(done.card_last4, '4242'); assert.equal(done.card_brand, 'visa');

  assert.ok([400, 409].includes((await sale(A, c.body.id, 5000)).status), 'a different amount is refused (the sale is $60)');
  const sold = await sale(A, c.body.id);
  is(sold, 201);
  const [pay] = await q('SELECT * FROM order_payments WHERE order_id = ?', [sold.body.id]);
  assert.equal(pay.processor, 'stripe'); assert.ok(intents.has(pay.reference), 'the reference is the Stripe payment, so refunds find it');
  assert.equal(pay.card_last4, '4242'); assert.equal(pay.tender, 'card');
  is(await sale(A, c.body.id), 409, 'one payment pays for one sale');
  const cancel = await api('POST', `/terminal/payments/${c.body.id}/cancel`, { token: A.counter });
  is(cancel, 409, 'a payment that is part of a sale is refunded from the order, not here');
  is(await sale(B, c.body.id), 400, 'another mountain cannot use it');
});

test('a declined card, an offline reader and a canceled charge take no money', async () => {
  const c = await api('POST', '/terminal/charges', { token: A.counter, body: { reader_id: A.reader, amount_cents: 6000 } });
  await api('POST', `/terminal/payments/${c.body.id}/simulate`, { token: A.counter, body: { outcome: 'decline' } });
  const failed = await waitFor(A, c.body.id, 'failed');
  assert.match(failed.failure, /declined/);
  is(await sale(A, c.body.id), 409);

  const off = await api('POST', '/terminal/readers', { token: A.owner, body: { registration_code: 'offline-reader', label: 'Back office' } });
  const o = await api('POST', '/terminal/charges', { token: A.counter, body: { reader_id: off.body.id, amount_cents: 6000 } });
  is(o, 409); assert.match(o.body.error, /not online/);

  const w = await api('POST', '/terminal/charges', { token: A.counter, body: { reader_id: A.reader, amount_cents: 6000 } });
  const stopped = await api('POST', `/terminal/payments/${w.body.id}/cancel`, { token: A.counter });
  is(stopped, 200); assert.equal(stopped.body.status, 'canceled');
  assert.equal(intents.get((await q('SELECT intent FROM terminal_payments WHERE id = ?', [w.body.id]))[0].intent).status, 'canceled');
  is(await api('POST', `/terminal/payments/${w.body.id}/simulate`, { token: A.counter, body: {} }), 409, 'a finished payment cannot be tapped');
  is(await api('POST', '/terminal/charges', { token: B.counter, body: { reader_id: A.reader, amount_cents: 6000 } }), 404, 'another mountain cannot use the reader');
  is(await api('POST', `/terminal/payments/${w.body.id}/simulate`, { token: B.counter, body: {} }), 404, 'or see its payments');
});

test('a card charged but never part of a sale is listed and refunded in full', async () => {
  const c = await api('POST', '/terminal/charges', { token: A.counter, body: { reader_id: A.reader, amount_cents: 6000 } });
  await api('POST', `/terminal/payments/${c.body.id}/simulate`, { token: A.counter, body: {} });
  await waitFor(A, c.body.id, 'succeeded');
  const stray = await api('GET', '/terminal/unattached', { token: A.counter });
  assert.ok(stray.body.payments.some((p) => p.id === c.body.id));
  const before = refunds.length;
  const r = await api('POST', `/terminal/payments/${c.body.id}/cancel`, { token: A.counter });
  is(r, 200); assert.equal(r.body.status, 'refunded');
  assert.equal(refunds.length, before + 1); assert.equal(refunds.at(-1).amount, '6000');
  assert.ok(!(await api('GET', '/terminal/unattached', { token: A.counter })).body.payments.some((p) => p.id === c.body.id));
  is(await sale(A, c.body.id), 409, 'a refunded payment pays for nothing');
});

test('on a connected Stripe account, readers and charges belong to that account, with the platform fee', async () => {
  const acct = `acct_mock${suffix.replace(/\W/g, '')}`;
  await q('UPDATE tenants SET stripe_account = ?, stripe_charges_enabled = 1, platform_fee_bps = 100 WHERE id = ?', [acct, A.id]);
  const c1 = await api('POST', '/terminal/charges', { token: A.counter, body: { reader_id: A.reader, amount_cents: 6000 } });
  is(c1, 409, 'a reader paired before connecting must be paired again'); assert.match(c1.body.error, /pair it again/);
  const noAddr = await api('POST', '/terminal/readers', { token: A.owner, body: { registration_code: 'simulated-wpe', label: 'Window 3' } });
  is(noAddr, 400, 'the connected account needs its own location');
  const r = await api('POST', '/terminal/readers', { token: A.owner, body: { registration_code: 'simulated-wpe', label: 'Window 3', address: ADDRESS } });
  is(r, 201);
  assert.equal(calls.filter((x) => x.path === '/v1/terminal/readers' && x.method === 'POST').at(-1).account, acct);
  const c = await api('POST', '/terminal/charges', { token: A.counter, body: { reader_id: r.body.id, amount_cents: 6000 } });
  is(c, 201);
  const pi = calls.filter((x) => x.path === '/v1/payment_intents').at(-1);
  assert.equal(pi.account, acct); assert.equal(pi.params.application_fee_amount, '60');
  await api('POST', `/terminal/payments/${c.body.id}/simulate`, { token: A.counter, body: {} });
  await waitFor(A, c.body.id, 'succeeded');
  const sold = await sale(A, c.body.id);
  is(sold, 201);
  const [pay] = await q('SELECT processor_account, platform_fee_cents FROM order_payments WHERE order_id = ?', [sold.body.id]);
  assert.equal(pay.processor_account, acct); assert.equal(Number(pay.platform_fee_cents), 60);
  is(await api('DELETE', `/terminal/readers/${r.body.id}`, { token: A.counter }), 403);
  is(await api('DELETE', `/terminal/readers/${r.body.id}`, { token: A.owner }), 200);
  assert.ok(!(await api('GET', '/terminal/readers', { token: A.counter })).body.readers.some((x) => x.id === r.body.id));
});

// The counter screen stopped watching (a refresh, a dropped connection) while the guest tapped: Stripe's webhook, the
// daily job and the manager's list still find the payment, and giving up at the counter never loses a card that went through.
const stripeLib = require('../src/lib/stripe');
const piEvent = (type, intent, tenantId, extra = {}) => ({ id: `evt_${++n}`, type, data: { object: { id: intent, object: 'payment_intent', metadata: { tenant_id: String(tenantId), kind: 'counter' }, ...extra } } });
async function webhook(event) {
  const raw = JSON.stringify(event);
  const res = await fetch(`${base}/api/v1/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripeLib.signWebhook(raw, 'whsec_platform') }, body: raw });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const tapped = (intent) => Object.assign(intents.get(intent), { status: 'succeeded', latest_charge: { id: `ch_${++n}`, payment_method_details: { type: 'card_present', card_present: { brand: 'mastercard', last4: '5454' } } } });
async function charge(m) {
  await q('UPDATE tenants SET stripe_account = NULL, stripe_charges_enabled = 0 WHERE id = ?', [m.id]);
  const c = await api('POST', '/terminal/charges', { token: m.counter, body: { reader_id: m.reader, amount_cents: 6000 } });
  is(c, 201);
  return { id: c.body.id, intent: (await q('SELECT intent FROM terminal_payments WHERE id = ?', [c.body.id]))[0].intent };
}
const statusOf = async (id) => (await q('SELECT status, card_last4, failure FROM terminal_payments WHERE id = ?', [id]))[0];

test('Stripe\'s webhook records a reader payment the counter stopped watching: succeeded, declined or canceled', async () => {
  const a = await charge(A);
  tapped(a.intent);
  const w = await webhook(piEvent('payment_intent.succeeded', a.intent, A.id));
  is(w, 200); assert.equal(w.body.terminal, 'succeeded');
  assert.deepEqual({ ...(await statusOf(a.id)) }, { status: 'succeeded', card_last4: '5454', failure: null });
  assert.ok((await api('GET', '/terminal/unattached', { token: A.counter })).body.payments.some((p) => p.id === a.id && p.status === 'succeeded'), 'listed to finish or refund');
  const b = await charge(A);
  const d = await webhook(piEvent('payment_intent.payment_failed', b.intent, A.id, { last_payment_error: { message: 'Your card was declined.' } }));
  assert.equal(d.body.terminal, 'failed'); assert.match((await statusOf(b.id)).failure, /declined/);
  const c = await charge(A);
  intents.get(c.intent).status = 'canceled';
  assert.equal((await webhook(piEvent('payment_intent.canceled', c.intent, A.id))).body.terminal, 'canceled');
  // Another mountain's name on the event matches nothing.
  const e = await charge(A);
  assert.equal((await webhook(piEvent('payment_intent.canceled', e.intent, B.id))).body.ignored, true);
  assert.equal((await statusOf(e.id)).status, 'waiting');
  await api('POST', `/terminal/payments/${e.id}/cancel`, { token: A.counter });
});

test('the daily job asks Stripe about reader payments still waiting after 10 minutes, and the list shows the ones still waiting', async () => {
  const a = await charge(A); const b = await charge(A);
  tapped(a.intent);
  await q('UPDATE terminal_payments SET created_at = DATE_SUB(NOW(), INTERVAL 11 MINUTE) WHERE id IN (?)', [[a.id, b.id]]);
  const out = await require('../src/routes/terminal').sweep();
  assert.ok(out.checked >= 2);
  assert.equal((await statusOf(a.id)).status, 'succeeded', 'the tap the screen missed is recorded');
  assert.equal((await statusOf(b.id)).status, 'waiting', 'nobody tapped: still waiting');
  const list = (await api('GET', '/terminal/unattached', { token: A.counter })).body.payments;
  const stuck = list.find((p) => p.id === b.id);
  assert.ok(stuck, 'a payment still waiting is listed for a manager'); assert.equal(stuck.status, 'waiting'); assert.match(stuck.note, /Still waiting for the card/);
  const fresh = await charge(A);
  assert.ok(!(await api('GET', '/terminal/unattached', { token: A.counter })).body.payments.some((p) => p.id === fresh.id), 'not one the counter is still watching');
  for (const id of [b.id, fresh.id]) assert.equal((await api('POST', `/terminal/payments/${id}/cancel`, { token: A.counter })).body.status, 'canceled');
});

test('giving up on a quiet reader keeps a card that went through after all, instead of refunding or losing it', async () => {
  const a = await charge(A);
  tapped(a.intent); // the guest tapped as the counter gave up
  const before = refunds.length;
  const gaveUp = await api('POST', `/terminal/payments/${a.id}/cancel`, { token: A.counter, body: { keep_if_paid: true } });
  is(gaveUp, 200); assert.equal(gaveUp.body.status, 'succeeded'); assert.equal(gaveUp.body.card_last4, '5454');
  assert.equal(refunds.length, before, 'nothing refunded: it pays for the sale');
  is(await sale(A, a.id), 201);
});
