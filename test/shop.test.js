'use strict';

// The online shop: a guest buys tickets and passes by card. Stripe and Postmark are mock servers, the webhook is signed like
// the real one. Nothing is sold until the payment lands; the sale then looks exactly like one made at the window.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.SHOP_RATE_LIMIT = '1000';
process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
process.env.MAIL_FROM = 'hello@summitops.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const config = require('../src/config');
const stripe = require('../src/lib/stripe');
const mailer = require('../src/lib/mailer');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base; let stripeMock; let pmMock; const calls = []; const mails = []; let n = 0; let failRefunds = false; const refundsMade = [];
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const q = async (sql, params) => (await pool.query(sql, params))[0];
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const plus = (d, k) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const year = Number(today.slice(0, 4));

async function call(prefix, method, path, { token, body } = {}) {
  const res = await fetch(`${base}${prefix}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const api = (m, p, o) => call('/api/v1', m, p, o);
async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: `Mount ${slug}`, phone: '215-555-0000', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const owner = (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token;
  return { slug, owner, id: (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id };
}
const webhook = async (event) => {
  const raw = JSON.stringify(event);
  const res = await fetch(`${base}/api/v1/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripe.signWebhook(raw, 'whsec_mock') }, body: raw });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const paidEvent = (row, tenant, extra = {}) => ({ id: `evt_${++n}`, type: 'checkout.session.completed', data: { object: { id: row.stripe_session_id, payment_status: 'paid', amount_total: row.amount_cents, payment_intent: `pi_${row.stripe_session_id}`, metadata: { tenant_id: String(tenant), request_id: String(row.id), shop_order_id: String(row.id), kind: 'shop' }, ...extra } } });

let A; let B; let pub; let day; let adultP; let passP; let hiddenP;
const adult = { first_name: 'Ann', last_name: 'Buyer', date_of_birth: `${year - 35}-04-01` };
const kid = { first_name: 'Kit', last_name: 'Buyer', date_of_birth: `${year - 9}-02-01` };
const body = (extra = {}) => ({ contact_first_name: 'Ann', contact_last_name: 'Buyer', contact_email: 'ann@x.test', contact_phone: '215-555-0100', items: [{ product_id: adultP, valid_on: day, holder: adult }], waiver_accepted: true, terms_accepted: true, ...extra });
async function buy(extra) {
  const r = await pub('POST', '/shop/orders', { body: body(extra) });
  assert.equal(r.status, 201, r.text);
  const row = (await q('SELECT * FROM shop_orders WHERE tenant_id = ? AND reference = ?', [A.id, r.body.reference]))[0];
  return { r, row };
}

test.before(async () => {
  stripeMock = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      calls.push({ path: req.url, params: Object.fromEntries(new URLSearchParams(data)), key: req.headers['idempotency-key'] });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/checkout/sessions') res.end(JSON.stringify({ id: `cs_shop_${++n}`, url: `https://checkout.stripe.test/c/${n}` }));
      else if (req.url === '/v1/refunds') {
        if (failRefunds) { res.statusCode = 500; res.end(JSON.stringify({ error: { message: 'Stripe is down' } })); return; }
        const p = Object.fromEntries(new URLSearchParams(data));
        const made = { id: `re_${++n}`, payment_intent: p.payment_intent, status: 'succeeded', metadata: { summitops_refund: p['metadata[summitops_refund]'] } };
        refundsMade.push(made); res.end(JSON.stringify(made));
      } else if (req.url.startsWith('/v1/refunds?')) {
        const pi = new URL(`http://x${req.url}`).searchParams.get('payment_intent');
        res.end(JSON.stringify({ data: refundsMade.filter((r) => r.payment_intent === pi) }));
      }
      else { res.statusCode = 404; res.end('{}'); }
    });
  });
  pmMock = http.createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { mails.push(JSON.parse(d)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m-${++n}` })); }); });
  await new Promise((r) => stripeMock.listen(0, '127.0.0.1', r));
  await new Promise((r) => pmMock.listen(0, '127.0.0.1', r));
  config.stripe.apiBase = `http://127.0.0.1:${stripeMock.address().port}`;
  mailer.settings.apiBase = `http://127.0.0.1:${pmMock.address().port}`;
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`sa-${suffix}`); B = await mountain(`sb-${suffix}`);
  pub = (m, p, o) => call('/api/v1/public', m, `/${A.slug}${p}`, o);
  day = plus(today, 3);
  const mk = async (b) => (await api('POST', '/products', { token: A.owner, body: b })).body.id;
  adultP = await mk({ kind: 'day_ticket', name: 'Day ticket', base_price_cents: 6000, online: 1 });
  assert.equal((await api('PUT', `/products/${adultP}/tiers`, { token: A.owner, body: { tiers: [{ tier: 'child', price_cents: 3000 }] } })).status, 200);
  passP = await mk({ kind: 'season_pass', name: 'Season pass', base_price_cents: 40000, valid_days: 200, online: 1 });
  hiddenP = await mk({ kind: 'day_ticket', name: 'Staff only ticket', base_price_cents: 100, online: 0 });
  assert.equal((await api('PUT', `/products/${adultP}/calendar`, { token: A.owner, body: { entries: [{ on_date: plus(today, 9), blackout: true }] } })).status, 200);
  assert.equal((await api('POST', '/tax-rules', { token: A.owner, body: { name: 'Sales tax', applies_to: 'all', rate_percent: 10 } })).status, 201);
  await api('PUT', '/tenant/profile', { token: A.owner, body: { waiver_text: 'I accept the risks of skiing.' } });
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => stripeMock.close(r)); await new Promise((r) => pmMock.close(r)); await pool.end(); });

test('the shop does not exist until a manager turns it on, then shows only products marked for online sale', async () => {
  assert.equal((await pub('GET', '/shop')).status, 404);
  assert.equal((await api('PUT', '/tenant/profile', { token: A.owner, body: { online_shop: true, shop_message: 'Pick up nothing, just scan.' } })).status, 200);
  const page = (await pub('GET', '/shop')).body;
  assert.equal(page.open, true);
  assert.deepEqual(page.products.map((p) => p.name).sort(), ['Day ticket', 'Season pass']);
  assert.ok(page.products.find((p) => p.id === adultP).blackout_dates.includes(plus(today, 9)));
  assert.equal(page.message, 'Pick up nothing, just scan.');
  assert.equal((await api('GET', '/online-shop/orders', { token: B.owner })).body.data.length, 0);
});

test('a basket is priced on the server by age and day, tax included, and refuses what is not for sale', async () => {
  const two = { items: [{ product_id: adultP, valid_on: day, holder: adult }, { product_id: adultP, valid_on: day, holder: kid }] };
  const qt = (await pub('POST', '/shop/quote', { body: two })).body;
  assert.equal(qt.subtotal_cents, 9000, '$60 adult + $30 child');
  assert.equal(qt.total_cents, 9900, 'plus 10% tax');
  assert.equal((await pub('POST', '/shop/quote', { body: { items: [{ product_id: hiddenP, valid_on: day, holder: adult }] } })).status, 409, 'not sold online');
  assert.equal((await pub('POST', '/shop/quote', { body: { items: [{ product_id: adultP, valid_on: plus(today, 9), holder: adult }] } })).status, 409, 'blackout');
  assert.equal((await pub('POST', '/shop/quote', { body: { items: [{ product_id: adultP, valid_on: plus(today, -1), holder: adult }] } })).status, 400, 'a past day');
  assert.equal((await pub('POST', '/shop/quote', { body: { items: [{ product_id: adultP, valid_on: plus(today, 800), holder: adult }] } })).status, 400, 'too far ahead');
});

test('the day menu gives prices for one day by age group, and marks what is blacked out', async () => {
  const d = (await pub('GET', `/shop/day?date=${day}`)).body;
  const dayTicket = d.products.find((p) => p.id === adultP);
  assert.equal(dayTicket.available, true);
  assert.deepEqual(dayTicket.prices.map((x) => [x.tier, x.price_cents]), [['child', 3000], ['youth', 6000], ['adult', 6000], ['senior', 6000]]);
  const bo = (await pub('GET', `/shop/day?date=${plus(today, 9)}`)).body;
  assert.equal(bo.products.find((p) => p.id === adultP).available, false);
  assert.equal(bo.products.find((p) => p.id === passP).available, true);
  assert.equal((await pub('GET', `/shop/day?date=${plus(today, -1)}`)).status, 400);
  assert.equal((await pub('GET', '/shop/day?date=nope')).status, 400);
});

test('placing a basket needs the terms and waiver, goes to Stripe for the total, and sells nothing yet', async () => {
  assert.equal((await pub('POST', '/shop/orders', { body: body({ terms_accepted: false }) })).status, 400);
  assert.equal((await pub('POST', '/shop/orders', { body: body({ waiver_accepted: false }) })).status, 400);
  assert.equal((await pub('POST', '/shop/orders', { body: body({ website: 'http://spam' }) })).status, 202, 'a robot is told yes and nothing is made');
  const before = calls.length; const orders = (await q('SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ?', [A.id]))[0].n;
  const { r, row } = await buy();
  assert.match(r.body.checkout_url, /^https:\/\/checkout\.stripe\.test\//);
  assert.equal(r.body.amount_cents, 6600);
  const c = calls.slice(before).find((x) => x.path === '/v1/checkout/sessions');
  assert.equal(c.params['line_items[0][price_data][unit_amount]'], '6600');
  assert.equal(c.params['metadata[kind]'], 'shop');
  assert.equal(c.key, `checkout-shop-${row.id}-6600`, 'the basket has its own Stripe key');
  assert.equal(row.status, 'awaiting_payment');
  assert.equal((await q('SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ?', [A.id]))[0].n, orders, 'no sale until paid');
  assert.equal((await q('SELECT COUNT(*) AS n FROM tickets WHERE tenant_id = ?', [A.id]))[0].n, 0);
});

test('payment makes the real sale once: order, named tickets, waiver, email, and the gate accepts the ticket', async () => {
  const { row } = await buy({ items: [{ product_id: adultP, valid_on: day, holder: adult }, { product_id: adultP, valid_on: day, holder: kid }, { product_id: passP, holder: { ...adult, photo: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' } }], news_opt_in: true });
  const ev = paidEvent(row, A.id);
  const w = await webhook(ev);
  assert.equal(w.status, 200, JSON.stringify(w.body));
  const o = (await q("SELECT * FROM orders WHERE tenant_id = ? AND payment_ref = ?", [A.id, ev.data.object.payment_intent]))[0];
  assert.equal(o.channel, 'online'); assert.equal(o.status, 'paid'); assert.equal(o.total_cents, row.amount_cents);
  const tickets = await q('SELECT t.*, p.first_name FROM tickets t JOIN order_items i ON i.id = t.order_item_id JOIN people p ON p.id = t.person_id WHERE t.tenant_id = ? AND i.order_id = ?', [A.id, o.id]);
  assert.equal(tickets.length, 3);
  assert.deepEqual(tickets.map((t) => t.first_name).sort(), ['Ann', 'Ann', 'Kit'], 'every ticket carries a name');
  const pass = tickets.find((t) => t.product_id === passP);
  assert.equal(String(pass.valid_from).slice(0, 10), today); assert.equal(String(pass.valid_to).slice(0, 10), plus(today, 199));
  assert.equal((await q('SELECT COUNT(*) AS n FROM order_payments WHERE tenant_id = ? AND order_id = ? AND tender = ? AND processor = ?', [A.id, o.id, 'card', 'stripe']))[0].n, 1);
  const ppl = await q('SELECT id, first_name, marketing_opt_in FROM people WHERE tenant_id = ? AND last_name = ?', [A.id, 'Buyer']);
  assert.equal((await q('SELECT COUNT(*) AS n FROM waivers WHERE tenant_id = ?', [A.id]))[0].n, 2, 'the buyer signs for self and for the child');
  assert.equal(ppl.find((p) => p.first_name === 'Ann').marketing_opt_in, 1);
  assert.equal((await q("SELECT COUNT(*) AS n FROM people WHERE tenant_id = ? AND first_name = 'Ann' AND photo LIKE 'data:image/jpeg;base64,/9j/%'", [A.id]))[0].n, 1, 'the pass photo is on file');
  assert.equal((await pub('POST', '/shop/orders', { body: body({ items: [{ product_id: passP, holder: { ...adult, photo: 'data:text/html;base64,AAAA' } }] }) })).status, 400, 'only a JPEG photo');
  assert.equal((await q("SELECT status FROM consent_events WHERE tenant_id = ? AND channel = 'email' ORDER BY id DESC LIMIT 1", [A.id]))[0].status, 'opted_in');
  // the same webhook again changes nothing
  assert.equal((await webhook(ev)).body.duplicate, true);
  assert.equal((await q('SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ? AND payment_ref = ?', [A.id, ev.data.object.payment_intent]))[0].n, 1);
  // the email went once, with the secret link
  const mail = mails.filter((m) => m.To === 'ann@x.test');
  assert.equal(mail.length, 1);
  assert.match(mail[0].TextBody, /\/shop\/sa-.*\?order=[0-9a-f]{32}/);
  // the guest's page
  const tok = (await q('SELECT view_token FROM shop_orders WHERE id = ?', [row.id]))[0].view_token;
  const view = (await pub('GET', `/shop/orders/${tok}`)).body;
  assert.equal(view.status, 'paid'); assert.equal(view.tickets.length, 3);
  assert.equal((await pub('GET', `/shop/orders/${'0'.repeat(32)}`)).status, 404);
  assert.equal((await call('/api/v1/public', 'GET', `/${B.slug}/shop/orders/${tok}`)).status, 404, 'another mountain cannot read it');
  // the gate takes it on the day it is valid
  const today1 = tickets.find((t) => t.product_id === passP);
  const staff = (await api('POST', '/users', { token: A.owner, body: { email: `c@${A.slug}.test`, password: PW, role: 'counter' } })).status;
  assert.equal(staff, 201);
  const ct = (await api('POST', '/auth/login', { body: { tenant: A.slug, email: `c@${A.slug}.test`, password: PW } })).body.token;
  assert.equal((await api('POST', '/tickets/scan', { token: ct, body: { code: today1.code } })).body.result, 'ok');
  // staff see it
  const list = (await api('GET', '/online-shop/orders', { token: ct })).body.data;
  assert.equal(list.find((x) => x.reference === row.reference).tickets, 3);
});

test('a payment that does not match the basket is refunded in full and sells nothing', async () => {
  const { row } = await buy();
  const before = calls.length;
  const w = await webhook(paidEvent(row, A.id, { amount_total: row.amount_cents - 100 }));
  assert.equal(w.body.refunded, true);
  assert.equal((await q('SELECT status FROM shop_orders WHERE id = ?', [row.id]))[0].status, 'refunded');
  assert.equal((await q('SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ? AND payment_ref = ?', [A.id, `pi_${row.stripe_session_id}`]))[0].n, 0);
  assert.ok(calls.slice(before).some((c) => c.path === '/v1/refunds'));
});

test('an abandoned card page expires the basket', async () => {
  const { row } = await buy();
  const ev = { id: `evt_${++n}`, type: 'checkout.session.expired', data: { object: { id: row.stripe_session_id, metadata: { tenant_id: String(A.id), shop_order_id: String(row.id), kind: 'shop' } } } };
  assert.equal((await webhook(ev)).status, 200);
  assert.equal((await q('SELECT status FROM shop_orders WHERE id = ?', [row.id]))[0].status, 'expired');
});

test('a staff refund voids the tickets and sends the money back through Stripe', async () => {
  const { row } = await buy();
  assert.equal((await webhook(paidEvent(row, A.id))).status, 200);
  const o = (await q('SELECT id FROM orders WHERE tenant_id = ? AND payment_ref = ?', [A.id, `pi_${row.stripe_session_id}`]))[0];
  const before = calls.length;
  const rf = await api('POST', `/orders/${o.id}/refund`, { token: A.owner, body: { reason: 'customer_request' } });
  assert.equal(rf.status, 200, rf.text);
  assert.equal(rf.body.card_refunded, true);
  const sent = calls.slice(before).find((c) => c.path === '/v1/refunds');
  assert.equal(sent.params.payment_intent, `pi_${row.stripe_session_id}`);
  assert.equal(sent.params.amount, String(row.amount_cents));
  assert.equal((await q("SELECT COUNT(*) AS n FROM tickets WHERE tenant_id = ? AND status = 'void' AND order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)", [A.id, o.id]))[0].n, 1);
});

const nextDow = (dow, from = plus(today, 1)) => { let d = from; while (new Date(`${d}T12:00:00Z`).getUTCDay() !== dow) d = plus(d, 1); return d; };
const holder = (n) => ({ first_name: `Pat${n}`, last_name: 'Limit', date_of_birth: `${year - 30}-05-05` });

test('a product can be sold only on some weekdays: the shop and the ticket window both refuse the other days', async () => {
  const wkP = (await api('POST', '/products', { token: A.owner, body: { kind: 'day_ticket', name: 'Weekday ticket', base_price_cents: 5000, online: 1, sale_days: 62 } })).body.id;
  assert.ok(wkP);
  assert.equal((await api('PATCH', `/products/${wkP}`, { token: A.owner, body: { sale_days: 0 } })).status, 400);
  const sat = nextDow(6); const tue = nextDow(2);
  const onSat = (await pub('GET', `/shop/day?date=${sat}`)).body.products.find((p) => p.id === wkP);
  assert.equal(onSat.available, false);
  assert.match(onSat.reason, /Monday to Friday/);
  const onTue = (await pub('GET', `/shop/day?date=${tue}`)).body.products.find((p) => p.id === wkP);
  assert.equal(onTue.available, true); assert.equal(onTue.days_text, 'Monday to Friday only');
  const item = (d) => ({ items: [{ product_id: wkP, valid_on: d, holder: adult }] });
  assert.equal((await pub('POST', '/shop/quote', { body: item(sat) })).status, 409);
  assert.equal((await pub('POST', '/shop/quote', { body: item(tue) })).status, 200);
  assert.equal((await pub('POST', '/shop/orders', { body: body(item(sat)) })).status, 409);
  const closed = (await pub('GET', '/shop')).body.products.find((p) => p.id === wkP).closed_dates;
  assert.ok(closed.includes(sat)); assert.ok(!closed.includes(tue));
  // the window uses the same price check
  assert.equal((await api('POST', '/pricing/quote', { token: A.owner, body: { date: sat, items: [{ product_id: wkP, tier: 'adult', quantity: 1 }] } })).status, 409);
  assert.equal((await api('POST', '/pricing/quote', { token: A.owner, body: { date: tue, items: [{ product_id: wkP, tier: 'adult', quantity: 1 }] } })).status, 200);
  assert.equal((await api('PATCH', `/products/${wkP}`, { token: A.owner, body: { sale_days: null } })).status, 200, 'blank means every day again');
  assert.equal((await pub('POST', '/shop/quote', { body: item(sat) })).status, 200);
});

test('a daily limit on a product counts tickets sold and baskets waiting, and sells out the day', async () => {
  const limP = (await api('POST', '/products', { token: A.owner, body: { kind: 'day_ticket', name: 'Limited ticket', base_price_cents: 1000, online: 1, online_daily_limit: 3 } })).body.id;
  const d = plus(today, 20);
  const menu = async () => (await pub('GET', `/shop/day?date=${d}`)).body.products.find((p) => p.id === limP);
  assert.equal((await menu()).left, 3);
  const two = { items: [{ product_id: limP, valid_on: d, holder: holder(1) }, { product_id: limP, valid_on: d, holder: holder(2) }] };
  const first = await pub('POST', '/shop/orders', { body: body(two) });
  assert.equal(first.status, 201, first.text);
  assert.equal((await menu()).left, 1, 'the waiting basket holds two');
  assert.equal((await pub('POST', '/shop/orders', { body: body(two) })).status, 409, 'two more do not fit');
  // payment turns the hold into sold tickets: still one left
  const row = (await q('SELECT * FROM shop_orders WHERE tenant_id = ? AND reference = ?', [A.id, first.body.reference]))[0];
  assert.equal((await webhook(paidEvent(row, A.id))).status, 200);
  assert.equal((await menu()).left, 1);
  const one = { items: [{ product_id: limP, valid_on: d, holder: holder(3) }] };
  assert.equal((await pub('POST', '/shop/orders', { body: body(one) })).status, 201);
  const gone = await menu();
  assert.equal(gone.available, false); assert.match(gone.reason, /Sold out/);
  assert.ok((await pub('GET', '/shop')).body.products.find((p) => p.id === limP).closed_dates.includes(d));
  assert.equal((await pub('POST', '/shop/quote', { body: one })).status, 409);
  // another day is still open
  assert.equal((await pub('POST', '/shop/quote', { body: { items: [{ product_id: limP, valid_on: plus(d, 1), holder: holder(4) }] } })).status, 200);
  // an abandoned basket gives its tickets back
  const e = (await q("SELECT * FROM shop_orders WHERE tenant_id = ? AND status = 'awaiting_payment' ORDER BY id DESC LIMIT 1", [A.id]))[0];
  await webhook({ id: `evt_${++n}`, type: 'checkout.session.expired', data: { object: { id: e.stripe_session_id, metadata: { tenant_id: String(A.id), shop_order_id: String(e.id), kind: 'shop' } } } });
  assert.equal((await menu()).left, 1);
});

test('a mountain-wide daily limit counts every ticket, including ones sold at the window', async () => {
  const d = plus(today, 40);
  assert.equal((await api('PUT', '/tenant/profile', { token: A.owner, body: { online_daily_limit: 2 } })).status, 200);
  const three = { items: [0, 1, 2].map((i) => ({ product_id: adultP, valid_on: d, holder: holder(10 + i) })) };
  assert.equal((await pub('POST', '/shop/orders', { body: body(three) })).status, 409);
  // one ticket sold at the window leaves one for the shop
  const [o] = await pool.query("INSERT INTO orders (tenant_id, status, subtotal_cents, total_cents, channel) VALUES (?, 'paid', 6000, 6000, 'window')", [A.id]);
  const [it] = await pool.query("INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, unit_price_cents, quantity, valid_on) VALUES (?, ?, ?, 'ticket', 6000, 1, ?)", [A.id, o.insertId, adultP, d]);
  await pool.query("INSERT INTO tickets (tenant_id, order_item_id, product_id, code, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?)", [A.id, it.insertId, adultP, `WIN${suffix}`.toUpperCase().padEnd(20, 'X').slice(0, 20), d, d]);
  const two = { items: [0, 1].map((i) => ({ product_id: adultP, valid_on: d, holder: holder(20 + i) })) };
  assert.equal((await pub('POST', '/shop/quote', { body: two })).status, 409);
  assert.equal((await pub('POST', '/shop/quote', { body: { items: [two.items[0]] } })).status, 200);
  assert.equal((await pub('GET', `/shop/day?date=${d}`)).body.products.find((p) => p.id === adultP).left, 1);
  assert.equal((await api('PUT', '/tenant/profile', { token: A.owner, body: { online_daily_limit: null } })).status, 200, 'blank removes the limit');
  assert.equal((await pub('POST', '/shop/quote', { body: two })).status, 200);
});

test('a day ticket needs only an age group; a season pass still needs a date of birth', async () => {
  const d = plus(today, 20);
  const g = (age_group) => ({ items: [{ product_id: adultP, valid_on: d, holder: { first_name: 'Gia', last_name: 'Group', age_group } }] });
  assert.equal((await pub('POST', '/shop/quote', { body: g('adult') })).body.lines[0].tier, 'adult');
  const kidQuote = await pub('POST', '/shop/quote', { body: g('child') });
  assert.equal(kidQuote.status, 200);
  assert.equal(kidQuote.body.lines[0].tier, 'child');
  assert.equal((await pub('POST', '/shop/quote', { body: { items: [{ product_id: adultP, valid_on: d, holder: { first_name: 'No', last_name: 'Age' } }] } })).status, 400, 'no age group');
  assert.equal((await pub('POST', '/shop/quote', { body: { items: [{ product_id: passP, valid_on: d, holder: { first_name: 'No', last_name: 'Dob', age_group: 'adult' } }] } })).status, 400, 'a pass needs a birth date');
});

test('buy online and save: the discount applies only when the visit is far enough ahead, and the calendar shows prices', async () => {
  const [r] = await pool.query("INSERT INTO products (tenant_id, kind, name, base_price_cents, valid_days, active, online, advance_days, advance_percent) VALUES (?, 'day_ticket', 'Early bird', 10000, 1, 1, 1, 7, 20)", [A.id]);
  const pid = r.insertId;
  const at = (k) => ({ items: [{ product_id: pid, valid_on: plus(today, k), holder: { first_name: 'Ed', last_name: 'Early', age_group: 'adult' } }] });
  const far = (await pub('POST', '/shop/quote', { body: at(10) })).body;
  assert.equal(far.lines[0].unit_cents, 8000);
  assert.equal(far.lines[0].saved_cents, 2000);
  const near = (await pub('POST', '/shop/quote', { body: at(3) })).body;
  assert.equal(near.lines[0].unit_cents, 10000);
  const menu = (await pub('GET', `/shop/day?date=${plus(today, 10)}`)).body.products.find((p) => p.id === pid);
  assert.equal(menu.prices[0].was_cents, 10000);
  const ym = plus(today, 10).slice(0, 7);
  const month = (await pub('GET', `/shop/month?month=${ym}`)).body;
  assert.ok(month.days[plus(today, 10)] && month.days[plus(today, 10)].from_cents > 0);
  assert.equal((await pub('GET', '/shop/month?month=nonsense')).status, 400);
  await pool.query('UPDATE products SET active = 0 WHERE id = ?', [pid]);
});

test('a mountain can brand its shop page, and the page shows conditions and the opening-day banner', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  assert.equal((await api('PUT', '/online-shop/brand', { token: A.owner, body: { color: '#ffee00' } })).status, 400, 'too light for white text');
  assert.equal((await api('PUT', '/online-shop/brand', { token: A.owner, body: { logo: 'javascript:alert(1)' } })).status, 400, 'not an image');
  const open = plus(today, 40);
  assert.equal((await api('PUT', '/online-shop/brand', { token: A.owner, body: { color: '#1a5fb4', logo: png, opening_day: open, opening_note: 'Presale pricing ends soon.' } })).status, 200);
  await pool.query("INSERT INTO snow_readings (tenant_id, read_at, base_in, new_snow_in) VALUES (?, NOW(), 24, 3)", [A.id]);
  const page = (await pub('GET', '/shop')).body;
  assert.equal(page.brand.color, '#1a5fb4');
  assert.equal(page.brand.opening_day, open);
  assert.equal(Number(page.conditions.base_in), 24);
  assert.equal((await api('GET', '/online-shop/brand', { token: A.owner })).body.logo, png);
  const other = await call('/api/v1', 'GET', '/online-shop/brand', { token: B.owner });
  assert.equal(other.body.logo, null, 'another mountain sees its own brand');
});

test('a basket can hold add-ons, a gift card and a promo code; payment makes vouchers and a gift card', async () => {
  const [lr] = await pool.query("INSERT INTO products (tenant_id, kind, name, base_price_cents, valid_days, active, online) VALUES (?, 'lesson', 'Group lesson', 6000, 30, 1, 1)", [A.id]);
  const lessonP = lr.insertId;
  await pool.query("INSERT INTO promo_codes (tenant_id, code, percent_off) VALUES (?, 'SAVE10', 10)", [A.id]);
  const items = [{ product_id: adultP, valid_on: day, holder: adult }];
  const full = { items, addons: [{ product_id: lessonP, quantity: 2 }], gifts: [{ amount_cents: 5000, recipient_name: 'Gran', message: 'Enjoy!' }], promo_code: 'save10' };
  const qt = await pub('POST', '/shop/quote', { body: full });
  assert.equal(qt.status, 200, JSON.stringify(qt.body));
  const noPromo = (await pub('POST', '/shop/quote', { body: { ...full, promo_code: undefined } })).body;
  assert.ok(qt.body.discount_cents > 0 && qt.body.discount_cents < Math.round((noPromo.subtotal_cents - 5000) / 10) + 2, 'ten percent, never on the gift card');
  assert.equal(qt.body.total_cents, noPromo.total_cents - qt.body.discount_cents + (qt.body.tax_cents - noPromo.tax_cents));
  assert.equal((await pub('POST', '/shop/quote', { body: { ...full, promo_code: 'NOPE' } })).status, 400);
  assert.equal((await pub('POST', '/shop/quote', { body: { items: [], addons: [], gifts: [] } })).status, 400, 'an empty basket');
  assert.equal((await pub('POST', '/shop/quote', { body: { items, addons: [{ product_id: adultP, quantity: 1 }] } })).status, 409, 'a ticket is not an add-on');
  assert.equal((await pub('POST', '/shop/quote', { body: { gifts: [{ amount_cents: 100 }] } })).status, 400, 'gift card minimum');
  const menu = (await pub('GET', '/shop')).body;
  assert.ok(menu.addons.some((a) => a.id === lessonP));
  const { row } = await buy({ ...full, items });
  const ev = paidEvent(row, A.id);
  assert.equal((await webhook(ev)).status, 200);
  const o = (await q('SELECT * FROM orders WHERE tenant_id = ? AND payment_ref = ?', [A.id, ev.data.object.payment_intent]))[0];
  assert.equal(o.promo_code, 'SAVE10'); assert.equal(o.discount_cents, qt.body.discount_cents);
  assert.equal((await q('SELECT COUNT(*) AS n FROM tickets t JOIN order_items i ON i.id = t.order_item_id WHERE i.order_id = ? AND t.product_id = ?', [o.id, lessonP]))[0].n, 2, 'two lesson vouchers');
  const gc = (await q('SELECT * FROM gift_cards WHERE tenant_id = ? AND order_id = ?', [A.id, o.id]))[0];
  assert.equal(gc.balance_cents, 5000); assert.equal(gc.recipient_name, 'Gran');
  assert.equal((await q("SELECT used_count FROM promo_codes WHERE tenant_id = ? AND code = 'SAVE10'", [A.id]))[0].used_count, 1);
  const tok = (await q('SELECT view_token FROM shop_orders WHERE id = ?', [row.id]))[0].view_token;
  const view = (await pub('GET', `/shop/orders/${tok}`)).body;
  assert.equal(view.gift_cards[0].code, gc.code); assert.equal(view.tickets.length, 3);
  await pool.query('UPDATE products SET active = 0 WHERE id = ?', [lessonP]);
});

const after = require('../src/lib/shopafter');
const tenantRow = async () => (await q('SELECT id, slug, name, address, phone, timezone, shop_recovery, online_daily_limit, shop_change_hours, shop_change_fee_cents FROM tenants WHERE id = ?', [A.id]))[0];
const payOrder = async (extra) => {
  const { row } = await buy(extra);
  assert.equal((await webhook(paidEvent(row, A.id))).status, 200);
  const tok = (await q('SELECT view_token FROM shop_orders WHERE id = ?', [row.id]))[0].view_token;
  return { row, tok, view: (await pub('GET', `/shop/orders/${tok}`)).body };
};

test('a guest can move a ticket to another day: free when the price is the same, paid when there is a fee, and never past the cutoff', async () => {
  const { tok, view } = await payOrder({ contact_email: 'mover@x.test', items: [{ product_id: adultP, valid_on: plus(today, 4), holder: adult }] });
  const code = view.tickets[0].code;
  assert.equal(view.changes, null, 'off until the mountain turns it on');
  assert.equal((await pub('POST', `/shop/orders/${tok}/change`, { body: { ticket_code: code, date: plus(today, 6) } })).status, 409);
  await q('UPDATE tenants SET shop_change_hours = 24, shop_change_fee_cents = 0 WHERE id = ?', [A.id]);
  assert.equal((await pub('GET', `/shop/orders/${tok}`)).body.changes.hours, 24);
  assert.equal((await pub('POST', `/shop/orders/${tok}/change`, { body: { ticket_code: code, date: plus(today, 9) } })).status, 409, 'a blackout day');
  const ok = await pub('POST', `/shop/orders/${tok}/change`, { body: { ticket_code: code, date: plus(today, 6) } });
  assert.equal(ok.status, 200, ok.text); assert.equal(ok.body.done, true);
  assert.equal(String((await q('SELECT valid_from FROM tickets WHERE code = ?', [code]))[0].valid_from).slice(0, 10), plus(today, 6));
  assert.equal((await pub('POST', `/shop/orders/${tok}/change`, { body: { ticket_code: 'NOSUCHCODE1', date: plus(today, 6) } })).status, 404);
  assert.equal((await call('/api/v1/public', 'POST', `/${B.slug}/shop/orders/${tok}/change`, { body: { ticket_code: code, date: plus(today, 7) } })).status, 404, 'another mountain cannot touch it');
  // with a fee the guest pays on Stripe first and the ticket only moves when the payment lands
  await q('UPDATE tenants SET shop_change_fee_cents = 500 WHERE id = ?', [A.id]);
  const paid = await pub('POST', `/shop/orders/${tok}/change`, { body: { ticket_code: code, date: plus(today, 7) } });
  assert.equal(paid.status, 200, paid.text); assert.equal(paid.body.due_cents, 550, 'the $5 fee plus 10% tax'); assert.match(paid.body.checkout_url, /^https:\/\/checkout\.stripe\.test\//);
  assert.equal(String((await q('SELECT valid_from FROM tickets WHERE code = ?', [code]))[0].valid_from).slice(0, 10), plus(today, 6), 'not moved yet');
  const ch = (await q('SELECT * FROM shop_changes WHERE tenant_id = ? AND status = ? ORDER BY id DESC LIMIT 1', [A.id, 'awaiting_payment']))[0];
  assert.equal(calls.filter((x) => x.path === '/v1/checkout/sessions').at(-1).key, `checkout-shopchange-${ch.id}-550`);
  const ev = { id: `evt_${++n}`, type: 'checkout.session.completed', data: { object: { id: ch.stripe_session_id, payment_status: 'paid', amount_total: 550, payment_intent: `pi_chg_${n}`, metadata: { tenant_id: String(A.id), change_id: String(ch.id), kind: 'shop_change', request_id: `chg${ch.id}` } } } };
  assert.equal((await webhook(ev)).status, 200);
  assert.equal(String((await q('SELECT valid_from FROM tickets WHERE code = ?', [code]))[0].valid_from).slice(0, 10), plus(today, 7));
  const fo = (await q('SELECT * FROM orders WHERE tenant_id = ? AND payment_ref = ?', [A.id, `pi_chg_${n}`]))[0];
  assert.equal(fo.total_cents, 550);
  assert.deepEqual((await q('SELECT line_kind, label FROM order_items WHERE order_id = ?', [fo.id])).map((x) => `${x.line_kind}:${x.label}`), ['fee:Date change fee'], 'a fee line, not a ticket');
  assert.equal((await webhook(ev)).body.duplicate, true);
  // the cutoff
  await q('UPDATE tenants SET shop_change_hours = 600 WHERE id = ?', [A.id]);
  assert.equal((await pub('POST', `/shop/orders/${tok}/change`, { body: { ticket_code: code, date: plus(today, 8) } })).status, 409, 'too close to the day');
  await q('UPDATE tenants SET shop_change_hours = NULL, shop_change_fee_cents = 0 WHERE id = ?', [A.id]);
});

test('a sold-out day takes a waitlist, and each person is told once when room opens', async () => {
  const d = plus(today, 15);
  assert.equal((await pub('POST', '/shop/waitlist', { body: { email: 'wait@x.test', date: d } })).status, 409, 'still on sale');
  await q('UPDATE tenants SET online_daily_limit = 1 WHERE id = ?', [A.id]);
  const { view } = await payOrder({ contact_email: 'taker@x.test', items: [{ product_id: adultP, valid_on: d, holder: adult }] });
  assert.equal((await pub('GET', `/shop/day?date=${d}`)).body.products.filter((p) => p.kind !== 'season_pass').every((p) => !p.available), true);
  assert.equal((await pub('POST', '/shop/waitlist', { body: { email: 'wait@x.test', name: 'Wendy', date: d, party_size: 2 } })).status, 201);
  assert.equal((await pub('POST', '/shop/waitlist', { body: { email: 'bad', date: d } })).status, 400);
  const before = mails.length;
  assert.equal(await after.runWaitlist(await tenantRow(), base), 0, 'still full, nobody told');
  await q('UPDATE tenants SET online_daily_limit = NULL WHERE id = ?', [A.id]);
  const t = await tenantRow();
  assert.equal(await after.runWaitlist(t, base), 1);
  assert.equal(await after.runWaitlist(t, base), 0, 'told once');
  assert.equal(mails.slice(before).filter((m) => m.To === 'wait@x.test').length, 1);
  assert.ok(view.tickets.length === 1);
  const staff = (await api('GET', '/online-shop/waitlist', { token: A.owner })).body.data;
  assert.ok(staff.find((r) => String(r.on_date).slice(0, 10) === d));
});

test('group enquiries are saved for staff to follow up', async () => {
  assert.equal((await pub('POST', '/shop/group', { body: { contact_name: 'Ms Teacher', organisation: 'Lincoln School', email: 'teach@x.test', group_size: 3 } })).status, 400, 'a group is 6 or more');
  assert.equal((await pub('POST', '/shop/group', { body: { contact_name: 'Ms Teacher', organisation: 'Lincoln School', email: 'teach@x.test', group_size: 40, preferred_on: plus(today, 30), note: 'Bus arrives 9am' } })).status, 201);
  assert.equal((await pub('POST', '/shop/group', { body: { contact_name: 'Bot', email: 'b@x.test', group_size: 10, website: 'x' } })).status, 202);
  const list = (await api('GET', '/online-shop/groups', { token: A.owner })).body.data;
  assert.equal(list.length, 1); assert.equal(list[0].group_size, 40);
  assert.equal((await api('PATCH', `/online-shop/groups/${list[0].id}`, { token: A.owner, body: { status: 'contacted' } })).status, 200);
  assert.equal((await api('GET', '/online-shop/groups', { token: B.owner })).body.data.length, 0, 'another mountain sees none');
  assert.equal((await api('PATCH', `/online-shop/groups/${list[0].id}`, { token: B.owner, body: { status: 'closed' } })).status, 404);
});

test('will-call finds an order by reference, email, name, phone or ticket code', async () => {
  const { row, view } = await payOrder({ contact_email: 'willcall@x.test', contact_first_name: 'Wilma', contact_last_name: 'Call', contact_phone: '610-555-0177' });
  const find = async (term) => (await api('GET', `/online-shop/lookup?q=${encodeURIComponent(term)}`, { token: A.owner })).body.data;
  for (const term of [row.reference, 'willcall@x.test', 'Wilma', '6105550177', view.tickets[0].code]) {
    const r = await find(term);
    assert.ok(r.some((o) => o.reference === row.reference), `found by ${term}`);
  }
  const hit = (await find(row.reference))[0];
  assert.match(hit.link, /\?order=[0-9a-f]{32}$/); assert.equal(hit.tickets.length, 1); assert.equal(hit.view_token, undefined);
  assert.equal((await api('GET', '/online-shop/lookup?q=ab', { token: A.owner })).status, 400);
  assert.equal((await api('GET', `/online-shop/lookup?q=${row.reference}`, { token: B.owner })).body.data.length, 0, 'another mountain finds nothing');
});

test('the emails around a visit: basket reminder (opt-in), day before, thank you, each sent once', async () => {
  const t = await tenantRow();
  // abandoned basket
  const ab = await buy({ contact_email: 'left@x.test' });
  await q('UPDATE shop_orders SET created_at = DATE_SUB(NOW(), INTERVAL 3 HOUR) WHERE id = ?', [ab.row.id]);
  const m0 = mails.length;
  assert.equal(await after.runRecovery(t, base), 0 + 1, 'sends one');
  assert.equal(await after.runRecovery(t, base), 0, 'only once');
  assert.equal(mails.slice(m0).filter((m) => m.To === 'left@x.test').length, 1);
  // day before
  const tm = await payOrder({ contact_email: 'tomorrow@x.test', news_opt_in: true, items: [{ product_id: adultP, valid_on: plus(today, 1), holder: adult }] });
  const m1 = mails.length;
  assert.ok(await after.runReminders(t, base) >= 1);
  assert.equal(mails.slice(m1).filter((m) => m.To === 'tomorrow@x.test' && /Tomorrow/.test(m.Subject)).length, 1);
  assert.equal(await after.runReminders(t, base), 0);
  // thank you: the visit was yesterday and they asked for news
  await q("UPDATE tickets t JOIN order_items i ON i.id = t.order_item_id SET t.valid_from = ?, t.valid_to = ? WHERE i.order_id = (SELECT order_id FROM shop_orders WHERE id = ?)", [plus(today, -1), plus(today, -1), tm.row.id]);
  const m2 = mails.length;
  assert.equal(await after.runThanks(t, base), 1);
  assert.equal(await after.runThanks(t, base), 0);
  assert.equal(mails.slice(m2).filter((m) => m.To === 'tomorrow@x.test').length, 1);
});

test('a manager can change prices, closures and limits for many days at once', async () => {
  const from = plus(today, 40); const to = plus(today, 53);
  const apply = (body) => api('POST', '/online-shop/calendar', { token: A.owner, body: { from, to, ...body } });
  assert.equal((await api('POST', '/online-shop/calendar', { token: B.owner, body: { from, to, action: 'close' } })).status, 200, 'B changes only its own');
  const wk = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
  const r1 = await apply({ action: 'price', price_cents: 9000, product_id: adultP, weekdays: [0, 6] });
  assert.equal(r1.status, 200, r1.text);
  const view = (await api('GET', `/online-shop/calendar?from=${from}&to=${to}`, { token: A.owner })).body;
  const sat = view.days.find((d) => wk(d.date) === 6); const tue = view.days.find((d) => wk(d.date) === 2);
  assert.equal(sat.products.find((p) => p.id === adultP).price_cents, 9000);
  assert.equal(tue.products.find((p) => p.id === adultP).price_cents, 6000);
  assert.equal((await pub('GET', `/shop/day?date=${sat.date}`)).body.products.find((p) => p.id === adultP).prices.find((x) => x.tier === 'adult').price_cents, 9000);
  // close a day, then reopen it
  assert.equal((await api('POST', '/online-shop/calendar', { token: A.owner, body: { from: tue.date, to: tue.date, action: 'close', product_id: adultP } })).status, 200);
  assert.equal((await pub('POST', '/shop/quote', { body: { items: [{ product_id: adultP, valid_on: tue.date, holder: adult }] } })).status, 409);
  assert.equal((await api('POST', '/online-shop/calendar', { token: A.owner, body: { from: tue.date, to: tue.date, action: 'open', product_id: adultP } })).status, 200);
  assert.equal((await pub('POST', '/shop/quote', { body: { items: [{ product_id: adultP, valid_on: tue.date, holder: adult }] } })).status, 200);
  // a limit for one day: zero sells it out for the shop, clearing it opens it again
  assert.equal((await api('POST', '/online-shop/calendar', { token: A.owner, body: { from: tue.date, to: tue.date, action: 'limit', limit: 0 } })).status, 200);
  assert.equal((await pub('POST', '/shop/quote', { body: { items: [{ product_id: adultP, valid_on: tue.date, holder: adult }] } })).status, 409, 'sold out');
  assert.ok((await pub('GET', '/shop')).body.products.find((p) => p.id === adultP).closed_dates.includes(tue.date), 'the calendar greys it');
  assert.equal((await api('POST', '/online-shop/calendar', { token: A.owner, body: { from: tue.date, to: tue.date, action: 'clear_limit' } })).status, 200);
  assert.equal((await pub('POST', '/shop/quote', { body: { items: [{ product_id: adultP, valid_on: tue.date, holder: adult }] } })).status, 200);
  // clearing returns the normal price; bad input is refused
  assert.equal((await apply({ action: 'clear', product_id: adultP })).status, 200);
  assert.equal((await api('GET', `/online-shop/calendar?from=${from}&to=${to}`, { token: A.owner })).body.days.find((d) => d.date === sat.date).products.find((p) => p.id === adultP).price_cents, 6000);
  assert.equal((await apply({ action: 'price' })).status, 400);
  assert.equal((await api('POST', '/online-shop/calendar', { token: A.owner, body: { from: to, to: from, action: 'close' } })).status, 400);
  assert.equal((await api('POST', '/online-shop/calendar', { token: A.owner, body: { from, to: plus(today, 700), action: 'close' } })).status, 400, 'too many days');
  await q('DELETE FROM price_calendar WHERE tenant_id = ? AND on_date >= ?', [B.id, from]);
});

test('the pace report compares this month with last year and shows the visit-to-sale funnel', async () => {
  const r = await api('GET', '/online-shop/pace', { token: A.owner });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.body.window.now.orders >= 1 && r.body.window.now.tickets >= 1 && r.body.window.now.revenue_cents > 0);
  assert.equal(r.body.window.last_year.orders, 0);
  assert.equal(r.body.window.change.orders, null, 'nothing to compare with yet');
  assert.equal(r.body.ahead.length, 22);
  assert.ok(r.body.ahead.some((d) => d.sold > 0));
  assert.ok(r.body.funnel.visits >= 1 && r.body.funnel.baskets >= r.body.funnel.paid && r.body.funnel.paid >= 1);
  assert.equal((await api('GET', '/online-shop/pace', { token: B.owner })).body.window.now.orders, 0, 'another mountain sees its own numbers');
  const staff = (await api('POST', '/users', { token: A.owner, body: { email: `c2@${A.slug}.test`, password: PW, role: 'counter' } })).status;
  assert.equal(staff, 201);
  const ct = (await api('POST', '/auth/login', { body: { tenant: A.slug, email: `c2@${A.slug}.test`, password: PW } })).body.token;
  assert.equal((await api('GET', '/online-shop/pace', { token: ct })).status, 403, 'managers only');
  assert.equal((await api('GET', '/online-shop/calendar', { token: ct })).status, 403);
  assert.equal((await api('GET', '/online-shop/lookup?q=abc', { token: ct })).status, 200, 'the window can use will-call');
});

// ---------------------------------------------------------------- hardening release
test('demo mountains never send email or texts, whoever asks, and every send needs a mountain', async () => {
  const before = mails.length;
  await q('UPDATE tenants SET sandbox_expires_at = NOW() + INTERVAL 1 DAY WHERE id = ?', [B.id]);
  const r = await mailer.send({ tenantId: B.id, to: 'victim@x.test', subject: 'Hi', text: 'phish' });
  assert.equal(r.ok, false); assert.match(r.error, /Demo/);
  assert.equal((await mailer.send({ to: 'x@x.test', subject: 'Hi', text: 'no mountain' })).ok, false);
  const sms = require('../src/lib/sms');
  process.env.TWILIO_ACCOUNT_SID = 'AC1'; process.env.TWILIO_AUTH_TOKEN = 't'; process.env.TWILIO_FROM = '+15550000000'; process.env.TWILIO_API_BASE = 'http://127.0.0.1:9';
  const t = await sms.send({ tenantId: B.id, to: '2155550100', body: 'phish' });
  assert.equal(t.ok, false); assert.match(t.error, /Demo/);
  delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_FROM; delete process.env.TWILIO_API_BASE;
  const report = await api('POST', '/reports/weekly/email-me', { token: B.owner, body: {} });
  assert.notEqual(report.status, 200, 'the weekly report test send is refused for a demo');
  assert.equal(mails.length, before, 'nothing reached Postmark');
  await q('UPDATE tenants SET sandbox_expires_at = NULL WHERE id = ?', [B.id]);
});

test('an online order never overwrites a customer on file, and a stranger cannot become a child\'s guardian', async () => {
  const [p] = await pool.query("INSERT INTO people (tenant_id, first_name, last_name, email, phone, date_of_birth, photo) VALUES (?, 'Vic', 'Tim', 'vic@x.test', '610-555-0001', ?, 'data:image/jpeg;base64,/9j/ORIGINAL')", [A.id, `${year - 40}-01-01`]);
  const [c] = await pool.query("INSERT INTO people (tenant_id, first_name, last_name, date_of_birth) VALUES (?, 'Kid', 'Tim', ?)", [A.id, `${year - 8}-03-03`]);
  await pool.query("INSERT INTO person_links (tenant_id, adult_id, member_id, relation) VALUES (?, ?, ?, 'guardian')", [A.id, p.insertId, c.insertId]);
  const { row } = await buy({ contact_first_name: 'Vic', contact_last_name: 'Tim', contact_email: 'vic@x.test', contact_phone: '999-999-9999',
    items: [{ product_id: passP, holder: { first_name: 'Vic', last_name: 'Tim', date_of_birth: `${year - 40}-01-01`, photo: 'data:image/jpeg;base64,/9j/ATTACKER' } },
      { product_id: passP, holder: { first_name: 'Kid', last_name: 'Tim', date_of_birth: `${year - 8}-03-03` } }] });
  assert.equal((await webhook(paidEvent(row, A.id))).status, 200);
  const vic = (await q('SELECT phone, photo FROM people WHERE id = ?', [p.insertId]))[0];
  assert.equal(vic.phone, '610-555-0001', 'phone kept'); assert.match(vic.photo, /ORIGINAL/, 'gate photo kept');
  const links = await q("SELECT adult_id FROM person_links WHERE tenant_id = ? AND member_id = ? AND relation = 'guardian'", [A.id, c.insertId]);
  assert.deepEqual(links.map((x) => x.adult_id), [p.insertId]);
});

test('the platform console can require a code from an authenticator app, and records who acted', async () => {
  const totp = require('../src/lib/totp');
  const secret = totp.newSecret();
  process.env.PLATFORM_TOTP_SECRET = secret;
  try {
    const plat = (m, path, o) => call('/api/v1/platform', m, path, o);
    const headers = (h) => ({ method: 'GET', headers: h });
    const bare = await fetch(`${base}/api/v1/platform/tenants`, headers({ 'x-platform-key': 'test-bootstrap-key' }));
    assert.equal(bare.status, 403, 'the key alone is not enough');
    assert.equal((await plat('POST', '/session', { body: { key: 'test-bootstrap-key', name: 'Dan', code: '000000' } })).status, 403);
    const code = totp.hotp(secret, totp.stepAt(Date.now()));
    const s = await plat('POST', '/session', { body: { key: 'test-bootstrap-key', name: 'Dan', code } });
    assert.equal(s.status, 200, s.text);
    const list = await fetch(`${base}/api/v1/platform/tenants`, headers({ 'x-platform-session': s.body.session }));
    assert.equal(list.status, 200);
    const audit = await (await fetch(`${base}/api/v1/platform/audit`, headers({ 'x-platform-session': s.body.session }))).json();
    assert.equal(audit.data[0].actor, 'key: Dan');
  } finally { delete process.env.PLATFORM_TOTP_SECRET; }
});

test('a repeated Stripe event after an automatic refund changes nothing', async () => {
  const { row } = await buy({ contact_email: 'replay@x.test', items: [{ product_id: adultP, valid_on: plus(today, 33), holder: adult }] });
  const wrong = paidEvent(row, A.id, { amount_total: row.amount_cents - 1 });
  assert.equal((await webhook(wrong)).body.refunded, true, 'a mismatched amount is refunded');
  const right = paidEvent(row, A.id); // the same session arriving again, now looking fine
  assert.equal((await webhook(right)).body.duplicate, true);
  assert.equal((await q('SELECT status FROM shop_orders WHERE id = ?', [row.id]))[0].status, 'refunded');
  assert.equal((await q('SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ? AND payment_ref = ?', [A.id, right.data.object.payment_intent]))[0].n, 0, 'nothing sold');
});

test('a payment that lands after its hold ran out is honored, and staff are told it went over the limit', async () => {
  const d = plus(today, 34);
  await q('UPDATE tenants SET online_daily_limit = 1 WHERE id = ?', [A.id]);
  try {
    const late = await buy({ contact_email: 'late@x.test', items: [{ product_id: adultP, valid_on: d, holder: adult }] });
    await q('UPDATE shop_orders SET created_at = DATE_SUB(NOW(), INTERVAL 2 HOUR) WHERE id = ?', [late.row.id]); // its hold has lapsed
    const other = await buy({ contact_email: 'ontime@x.test', items: [{ product_id: adultP, valid_on: d, holder: adult }] });
    assert.equal((await webhook(paidEvent(other.row, A.id))).status, 200);
    assert.equal((await webhook(paidEvent(late.row, A.id))).status, 200);
    const r = (await q('SELECT status, note FROM shop_orders WHERE id = ?', [late.row.id]))[0];
    assert.equal(r.status, 'paid'); assert.match(r.note || '', /over the daily limit/);
  } finally { await q('UPDATE tenants SET online_daily_limit = NULL WHERE id = ?', [A.id]); }
});

test('gift cards are never taxed, at the window or online', async () => {
  const qt = (await pub('POST', '/shop/quote', { body: { gifts: [{ amount_cents: 10000 }] } })).body;
  assert.equal(qt.tax_cents, 0); assert.equal(qt.total_cents, 10000);
  const counter = await api('POST', '/checkout/quote', { token: A.owner, body: { lines: [{ type: 'gift_card', amount_cents: 10000 }] } });
  assert.equal(counter.status, 200, counter.text); assert.equal(counter.body.tax_cents, 0); assert.equal(counter.body.total_cents, 10000);
});

test('a one-use promo code cannot be used by two online guests at once', async () => {
  await pool.query("INSERT INTO promo_codes (tenant_id, code, percent_off, max_uses) VALUES (?, 'ONCE', 50, 1)", [A.id]);
  const items = [{ product_id: adultP, valid_on: plus(today, 21), holder: { first_name: 'Ona', last_name: 'Once', age_group: 'adult' } }];
  await buy({ contact_email: 'o1@x.test', items, promo_code: 'ONCE' });
  const second = await pub('POST', '/shop/orders', { body: body({ contact_email: 'o2@x.test', items, promo_code: 'ONCE' }) });
  assert.equal(second.status, 400); assert.match(second.body.error, /fully used/);
});

test('moving a ticket twice only charges the price rise once', async () => {
  await q('UPDATE tenants SET shop_change_hours = 1, shop_change_fee_cents = 0 WHERE id = ?', [A.id]);
  const d1 = plus(today, 60); const d2 = plus(today, 61); const d3 = plus(today, 62);
  assert.equal((await api('PUT', `/products/${adultP}/calendar`, { token: A.owner, body: { entries: [{ on_date: d2, price_cents: 9000 }, { on_date: d3, price_cents: 9000 }] } })).status, 200);
  const { tok, view } = await payOrder({ contact_email: 'twice@x.test', items: [{ product_id: adultP, valid_on: d1, holder: adult }] });
  const code = view.tickets[0].code;
  const up = (await pub('POST', `/shop/orders/${tok}/change`, { body: { ticket_code: code, date: d2 } })).body;
  assert.equal(up.due_cents, 3300, 'the $30 rise plus 10% tax');
  const ch = (await q("SELECT * FROM shop_changes WHERE tenant_id = ? AND status = 'awaiting_payment' ORDER BY id DESC LIMIT 1", [A.id]))[0];
  const ev = { id: `evt_${++n}`, type: 'checkout.session.completed', data: { object: { id: ch.stripe_session_id, payment_status: 'paid', amount_total: 3300, payment_intent: `pi_tw_${n}`, metadata: { tenant_id: String(A.id), change_id: String(ch.id), kind: 'shop_change', request_id: `chg${ch.id}` } } } };
  assert.equal((await webhook(ev)).status, 200);
  const again = (await pub('POST', `/shop/orders/${tok}/change`, { body: { ticket_code: code, date: d3 } })).body;
  assert.equal(again.done, true, 'same price as already paid: free'); assert.equal(again.due_cents, 0);
  await q('UPDATE tenants SET shop_change_hours = NULL WHERE id = ?', [A.id]);
});

test('a card refund Stripe cannot send is kept as owed and can be retried; cash refunds come out of the chosen drawer', async () => {
  const { row } = await payOrder({ contact_email: 'refund@x.test' });
  const orderId = (await q('SELECT order_id FROM shop_orders WHERE id = ?', [row.id]))[0].order_id;
  failRefunds = true;
  const r = await api('POST', `/orders/${orderId}/refund`, { token: A.owner, body: { reason: 'weather' } });
  failRefunds = false;
  assert.equal(r.status, 200, r.text); assert.equal(r.body.card_refund_failed, true);
  const rf = (await q('SELECT id, card_status FROM order_refunds WHERE order_id = ?', [orderId]))[0];
  assert.equal(rf.card_status, 'failed');
  assert.equal((await api('POST', `/orders/${orderId}/refunds/${rf.id}/retry`, { token: A.owner })).status, 200);
  assert.equal((await q('SELECT card_status FROM order_refunds WHERE id = ?', [rf.id]))[0].card_status, 'sent');
  assert.equal((await api('POST', `/orders/${orderId}/refunds/${rf.id}/retry`, { token: A.owner })).status, 409, 'never twice');
  // cash: a counter sells from their drawer; the manager refunds and names that drawer
  const ctr = (await api('POST', '/users', { token: A.owner, body: { email: `c3@${A.slug}.test`, password: PW, role: 'counter' } })).status;
  assert.equal(ctr, 201);
  const ct = (await api('POST', '/auth/login', { body: { tenant: A.slug, email: `c3@${A.slug}.test`, password: PW } })).body.token;
  const till = (await api('POST', '/till/open', { token: ct, body: { opening_float_cents: 10000 } })).body;
  const sale = await api('POST', '/checkout', { token: ct, body: { lines: [{ type: 'ticket', product_id: adultP, holder: 'buyer' }], customer: { details: { first_name: 'Cash', last_name: 'Guest', date_of_birth: `${year - 30}-01-01`, sex: 'female', phone: '215-555-0199' } }, payments: [{ tender: 'cash', amount_cents: 6600, tendered_cents: 6600 }] } });
  assert.equal(sale.status, 201, sale.text);
  const tillId = till.id || (await q("SELECT id FROM till_sessions WHERE tenant_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [A.id]))[0].id;
  assert.equal((await api('POST', `/orders/${sale.body.id}/refund`, { token: A.owner, body: { reason: 'customer_request', till_id: tillId } })).status, 200);
  const cur = (await api('GET', '/till/current', { token: ct })).body.till;
  assert.equal(cur.cash_refunds_cents, 6600, 'the counter drawer that paid out the cash');
  assert.equal(cur.expected_cents, 10000, 'float + sale - refund');
});

test('quick sale at the window: day tickets with no name, never a season pass, and a mountain can switch it off', async () => {
  const pay = [{ tender: 'cash', amount_cents: 6600 }];
  const ok1 = await api('POST', '/checkout', { token: A.owner, body: { quick: true, lines: [{ type: 'ticket', product_id: adultP }], payments: pay } });
  assert.equal(ok1.status, 201, ok1.text); assert.equal(ok1.body.person_id, null); assert.equal(ok1.body.tickets.length, 1);
  const pass = await api('POST', '/checkout', { token: A.owner, body: { quick: true, lines: [{ type: 'ticket', product_id: passP }], payments: [{ tender: 'cash', amount_cents: 44000 }] } });
  assert.equal(pass.status, 400, 'a season pass needs the holder');
  assert.equal((await api('PUT', '/tenant/profile', { token: A.owner, body: { quick_sale: false } })).status, 200);
  assert.equal((await api('POST', '/checkout', { token: A.owner, body: { quick: true, lines: [{ type: 'ticket', product_id: adultP }], payments: pay } })).status, 400);
  assert.equal((await api('PUT', '/tenant/profile', { token: A.owner, body: { quick_sale: true } })).status, 200);
});

test('a card refund retried days later is not sent twice, and a guest who went back from the card page can use their promo code again', async () => {
  const { row } = await payOrder({ contact_email: 'lost@x.test' });
  const orderId = (await q('SELECT order_id FROM shop_orders WHERE id = ?', [row.id]))[0].order_id;
  assert.equal((await api('POST', `/orders/${orderId}/refund`, { token: A.owner, body: { reason: 'weather' } })).status, 200);
  const rf = (await q('SELECT id, card_ref FROM order_refunds WHERE order_id = ?', [orderId]))[0];
  // pretend Stripe timed out after making the refund: the row says failed, but the refund exists at Stripe
  await q("UPDATE order_refunds SET card_status = 'failed' WHERE id = ?", [rf.id]);
  const before = refundsMade.length;
  assert.equal((await api('POST', `/orders/${orderId}/refunds/${rf.id}/retry`, { token: A.owner })).status, 200);
  assert.equal(refundsMade.length, before, 'found the earlier refund, sent nothing new');
  // promo: the guest's own abandoned basket does not use up a one-use code, and going back lets the basket go
  await pool.query("INSERT INTO promo_codes (tenant_id, code, percent_off, max_uses) VALUES (?, 'BACKAGAIN', 10, 1)", [A.id]);
  const items = [{ product_id: adultP, valid_on: plus(today, 22), holder: { first_name: 'Bea', last_name: 'Back', age_group: 'adult' } }];
  const first = await buy({ contact_email: 'back@x.test', items, promo_code: 'BACKAGAIN' });
  assert.equal((await pub('POST', '/shop/orders', { body: body({ contact_email: 'back@x.test', items, promo_code: 'BACKAGAIN' }) })).status, 201, 'the same guest again');
  assert.equal((await pub('POST', '/shop/orders', { body: body({ contact_email: 'other@x.test', items, promo_code: 'BACKAGAIN' }) })).status, 400, 'someone else is held off');
  const tok = (await q('SELECT view_token FROM shop_orders WHERE id = ?', [first.row.id]))[0].view_token;
  assert.equal((await pub('POST', `/shop/orders/${tok}/abandon`)).status, 200);
  assert.equal((await q('SELECT status FROM shop_orders WHERE id = ?', [first.row.id]))[0].status, 'expired');
  // a payment that lands after the guest pressed back is still honored
  assert.equal((await webhook(paidEvent(first.row, A.id))).status, 200);
  assert.equal((await q('SELECT status FROM shop_orders WHERE id = ?', [first.row.id]))[0].status, 'paid');
});

test('/readyz says the database is reachable and migrated', async () => {
  const r = await fetch(`${base}/readyz`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.version, require('../package.json').version, 'it also says which version is running');
});

test('the simple /orders sale records tax and a payment, so it refunds in full', async () => {
  const o = await api('POST', '/orders', { token: A.owner, body: { items: [{ product_id: adultP }] } });
  assert.equal(o.status, 201, o.text);
  assert.equal(o.body.tax_cents, 600); assert.equal(o.body.total_cents, 6600);
  const r = await api('POST', `/orders/${o.body.id}/refund`, { token: A.owner, body: { reason: 'customer_request' } });
  assert.equal(r.status, 200, r.text); assert.equal(r.body.amount_cents, 6600);
});

test('a mountain with the shop module off, or the shop switched off, has no page', async () => {
  assert.equal((await api('PUT', '/tenant/profile', { token: A.owner, body: { online_shop: false } })).status, 200);
  assert.equal((await pub('GET', '/shop')).status, 404);
  assert.equal((await pub('POST', '/shop/orders', { body: body() })).status, 404);
  await api('PUT', '/tenant/profile', { token: A.owner, body: { online_shop: true } });
  await q("INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, 'shop', 0) ON DUPLICATE KEY UPDATE enabled = 0", [A.id]);
  require('../src/lib/modules').invalidate();
  assert.equal((await pub('GET', '/shop')).status, 404);
  assert.equal((await api('GET', '/online-shop/orders', { token: A.owner })).status, 403);
});
