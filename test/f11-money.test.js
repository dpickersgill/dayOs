'use strict';

// 2026.11.11 money fixes: payment plans (no gift cards on credit, no double charge, no lock held on Stripe, refunds wait
// for a charge), refunds go back to the tenders that paid for the line, comp and "other" limits, the simple order sale,
// program bundle refunds, one-use promo codes online, takings by the payment's day, lesson cancel hours across a clock
// change, card numbers in payment fields, and refunds and disputes made in the Stripe dashboard.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.SHOP_RATE_LIMIT = '1000';
process.env.PUBLIC_RATE_LIMIT_ALL = '100000';
process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock';
process.env.STRIPE_GUEST_FALLBACK = 'on';
process.env.STRIPE_TIMEOUT_MS = '1500';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
process.env.MAIL_FROM = 'hello@summitops.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const config = require('../src/config');
const stripe = require('../src/lib/stripe');
const mailer = require('../src/lib/mailer');
const { createApp } = require('../src/app');
const { pool, tx } = require('../src/db');
const PPL = require('../src/lib/paymentplans');

let server; let base; let stripeMock; let pmMock;
const S = { n: 0, intents: new Map(), refunds: [], drop: 0, hang: false, hung: [], delay: 0 };
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const plus = (d, k) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const q = async (sql, params) => (await pool.query(sql, params))[0];
const WALKIN = { details: { first_name: 'Walk', last_name: 'In', email: 'walkin@x.test', date_of_birth: '1985-03-02', sex: 'female' } };

async function api(method, path, { token, body, headers } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'x-device': 'test-device-0123456789abcdef', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const login = async (slug, email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
let made = 0;
async function mountain(tag) {
  const slug = `f11m-${tag}-${suffix}`;
  // each mountain from its own address: making mountains is limited to 5 a minute per address
  const r = await api('POST', '/tenants', { headers: { 'x-bootstrap-key': 'test-bootstrap-key', 'x-forwarded-for': `10.11.${++made}.1` }, body: { slug, name: `Mount ${tag}`, phone: '215-555-0000', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } } });
  assert.equal(r.status, 201, r.text);
  const m = { slug, owner: await login(slug, `owner@${slug}.test`) };
  m.id = (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id;
  m.user = async (who, role) => { assert.equal((await api('POST', '/users', { token: m.owner, body: { email: `${who}@${slug}.test`, password: PW, role } })).status, 201); return login(slug, `${who}@${slug}.test`); };
  m.product = async (body) => { const x = await api('POST', '/products', { token: m.owner, body }); assert.equal(x.status, 201, x.text); return x.body.id; };
  m.pub = (meth, p, o) => api(meth, `/public/${slug}${p}`, o);
  return m;
}
async function webhook(event) {
  const raw = JSON.stringify(event);
  const res = await fetch(`${base}/api/v1/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripe.signWebhook(raw, 'whsec_mock') }, body: raw });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const paidEvent = (A, row) => ({ id: `evt_${++S.n}`, type: 'checkout.session.completed', data: { object: { id: row.stripe_session_id, payment_status: 'paid', amount_total: row.amount_cents, payment_intent: `pi_${row.stripe_session_id}`, customer: 'cus_x',
  metadata: { tenant_id: String(A.id), request_id: String(row.id), shop_order_id: String(row.id), kind: 'shop' } } } });
const year = Number(today.slice(0, 4));
const holder = { first_name: 'Ann', last_name: 'Buyer', date_of_birth: `${year - 35}-04-01`, photo: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' };
const contact = { contact_first_name: 'Ann', contact_last_name: 'Buyer', contact_email: 'ann@x.test', contact_phone: '215-555-0100', waiver_accepted: true, terms_accepted: true };

/** A mountain selling a season pass in 3 payments; buys one online and returns { order, plan }. */
async function planMountain(tag, extra = {}) {
  const A = await mountain(tag);
  await api('PUT', '/tenant/profile', { token: A.owner, body: { online_shop: true } });
  A.pass = await A.product({ kind: 'season_pass', name: 'Season pass', base_price_cents: 45000, valid_days: 200, online: 1 });
  assert.equal((await api('PATCH', '/guests/settings', { token: A.owner, body: { plans_on: true, plans_count: 3 } })).status, 200);
  const r = await A.pub('POST', '/shop/orders', { body: { ...contact, items: [{ product_id: A.pass, holder }], plan: true, ...extra } });
  assert.equal(r.status, 201, r.text);
  const row = (await q('SELECT * FROM shop_orders WHERE tenant_id = ? AND reference = ?', [A.id, r.body.reference]))[0];
  A.row = row;
  assert.equal((await webhook(paidEvent(A, row))).status, 200);
  A.order = (await q("SELECT id FROM orders WHERE tenant_id = ? AND channel = 'online' ORDER BY id DESC LIMIT 1", [A.id]))[0].id;
  A.plan = (await q('SELECT id FROM payment_plans WHERE tenant_id = ? AND order_id = ?', [A.id, A.order]))[0].id;
  A.charge = (await q('SELECT id FROM payment_plan_charges WHERE plan_id = ? AND n = 2', [A.plan]))[0].id;
  await q('UPDATE payment_plan_charges SET due_on = ? WHERE id = ?', [today, A.charge]);
  return A;
}

test.before(async () => {
  stripeMock = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const params = Object.fromEntries(new URLSearchParams(data));
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/checkout/sessions') return res.end(JSON.stringify({ id: `cs_m_${++S.n}`, url: `https://checkout.stripe.test/c/${S.n}` }));
      if (req.url === '/v1/refunds') { const r = { id: `re_${++S.n}`, payment_intent: params.payment_intent, amount: Number(params.amount), status: 'succeeded' }; S.refunds.push(r); return res.end(JSON.stringify(r)); }
      if (req.url.startsWith('/v1/refunds?')) return res.end(JSON.stringify({ data: [] }));
      if (req.method === 'POST' && req.url === '/v1/payment_intents' && params.off_session === 'true') {
        const key = req.headers['idempotency-key'];
        if (S.hang) { S.hung.push(res); return undefined; }
        if (!S.intents.has(key)) S.intents.set(key, { id: `pi_off_${++S.n}`, status: 'succeeded', amount: Number(params.amount), metadata: params });
        if (S.drop > 0) { S.drop -= 1; req.socket.destroy(); return undefined; }
        const go = () => res.end(JSON.stringify(S.intents.get(key)));
        return S.delay ? setTimeout(go, S.delay) : go();
      }
      if (req.method === 'GET' && req.url.startsWith('/v1/payment_intents/search')) return res.end(JSON.stringify({ data: [] }));
      if (req.method === 'GET' && req.url.startsWith('/v1/payment_intents/')) return res.end(JSON.stringify({ id: req.url.split('/')[3].split('?')[0], customer: 'cus_mock', payment_method: { id: 'pm_mock', card: { brand: 'visa', last4: '4242' } } }));
      if (/\/expire$/.test(req.url)) return res.end(JSON.stringify({ status: 'expired' }));
      return res.end(JSON.stringify({ id: `x_${++S.n}`, data: [] }));
    });
  });
  pmMock = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m-${++S.n}` })); }); });
  await new Promise((r) => stripeMock.listen(0, '127.0.0.1', r));
  await new Promise((r) => pmMock.listen(0, '127.0.0.1', r));
  config.stripe.apiBase = `http://127.0.0.1:${stripeMock.address().port}`;
  mailer.settings.apiBase = `http://127.0.0.1:${pmMock.address().port}`;
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  for (const r of S.hung) r.socket.destroy();
  await new Promise((r) => server.close(r)); stripeMock.close(); pmMock.close(); await pool.end();
});

test('MONEY-3: a gift card in a plan basket is paid in full with the first payment', async () => {
  const A = await planMountain('m3', { gifts: [{ amount_cents: 100000, recipient_name: 'Ann' }] });
  assert.equal(A.row.amount_cents, 100000 + 15000, 'the card page charges the gift card in full and the first third of the pass');
  const charges = await q('SELECT n, cents FROM payment_plan_charges WHERE plan_id = ? ORDER BY n', [A.plan]);
  assert.deepEqual(charges.map((c) => c.cents), [115000, 15000, 15000]);
  const quote = await A.pub('POST', '/shop/quote', { body: { items: [{ product_id: A.pass, holder }], gifts: [{ amount_cents: 5000 }] } });
  if (quote.status === 200 && quote.body.plan_offer) assert.equal(quote.body.plan_offer.first_cents, 5000 + 15000);
});

test('MONEY-7: a refund waits while an installment is being charged, and then gives back both payments', async () => {
  const A = await planMountain('m7');
  S.delay = 1200;
  const job = PPL.chargeOne(A.charge, { notify: false });
  await new Promise((r) => setTimeout(r, 300));
  const busy = await api('POST', `/orders/${A.order}/refund`, { token: A.owner, body: { reason: 'customer_request' } });
  assert.equal(busy.status, 409, busy.text);
  assert.equal(await job, 'paid');
  S.delay = 0;
  const rf = await api('POST', `/orders/${A.order}/refund`, { token: A.owner, body: { reason: 'customer_request' } });
  assert.equal(rf.status, 200, rf.text);
  assert.equal(rf.body.amount_cents, 30000, 'both payments made go back');
  const [o] = await q('SELECT status FROM orders WHERE id = ?', [A.order]);
  assert.equal(o.status, 'refunded');
});

test('OPS-2: a dropped reply from Stripe never charges an installment twice', async () => {
  const A = await planMountain('o2');
  const before = S.intents.size;
  S.drop = 1;
  assert.equal(await PPL.chargeOne(A.charge, { notify: false }), 'paid', 'asked again with the same key: Stripe answers with the first result');
  assert.equal(S.intents.size - before, 1, 'one PaymentIntent');
  assert.equal(await PPL.chargeOne(A.charge, { notify: false }), 'skipped');
  // no answer at all: not a failure, and the next try looks first and uses the same key
  const c3 = (await q('SELECT id FROM payment_plan_charges WHERE plan_id = ? AND n = 3', [A.plan]))[0].id;
  S.drop = 2;
  assert.equal(await PPL.chargeOne(c3, { notify: false }), 'unknown');
  const [row] = await q('SELECT status, attempts, charge_key, charging_at FROM payment_plan_charges WHERE id = ?', [c3]);
  assert.equal(row.attempts, 0); assert.ok(row.charge_key); assert.equal(row.charging_at, null);
  assert.equal(await PPL.chargeOne(c3, { notify: false }), 'paid');
  assert.equal(S.intents.size - before, 2, 'still one PaymentIntent per installment');
  assert.equal(Number((await q('SELECT COUNT(*) AS n FROM order_payments WHERE order_id = ?', [A.order]))[0].n), 3);
});

test('OPS-9: a hung Stripe holds no lock: cancel answers at once, and the charge gives up', async () => {
  const A = await planMountain('o9');
  S.hang = true;
  const t0 = Date.now();
  const job = PPL.chargeOne(A.charge, { notify: false });
  await new Promise((r) => setTimeout(r, 300));
  const c = await api('POST', `/guests/fair/plans/${A.plan}/cancel`, { token: A.owner, body: { note: 'Guest asked' } });
  assert.equal(c.status, 409, c.text);
  assert.ok(Date.now() - t0 < 3000, 'the cancel did not wait on Stripe');
  assert.equal(await job, 'unknown', 'gave up after STRIPE_TIMEOUT_MS');
  S.hang = false;
  for (const r of S.hung.splice(0)) r.socket.destroy();
  assert.equal((await api('POST', `/guests/fair/plans/${A.plan}/cancel`, { token: A.owner, body: {} })).status, 200);
});

test('MONEY-1: change day pays back only what was paid, on the tenders that paid it', async () => {
  const A = await mountain('m1');
  const day = await A.product({ kind: 'day_ticket', name: 'Adult Day', base_price_cents: 8000 });
  const peak = plus(today, 2); const cheap = plus(today, 3);
  await api('PUT', `/products/${day}/calendar`, { token: A.owner, body: { entries: [{ on_date: cheap, price_cents: 5000 }] } });
  const comp = await api('POST', '/checkout', { token: A.owner, body: { customer: WALKIN, lines: [{ type: 'ticket', product_id: day, valid_on: peak }], payments: [{ tender: 'comp', comp_reason: 'staff', amount_cents: 8000 }] } });
  assert.equal(comp.status, 201, comp.text);
  const chk = await api('POST', `/guests/tickets/${comp.body.tickets[0].code}/change-day`, { token: A.owner, body: { date: cheap, check: true } });
  assert.equal(chk.body.back_cents, 0, 'the preview says nothing goes back');
  const mv = await api('POST', `/guests/tickets/${comp.body.tickets[0].code}/change-day`, { token: A.owner, body: { date: cheap } });
  assert.equal(mv.status, 200, mv.text);
  assert.equal((await q('SELECT COUNT(*) AS n FROM order_refunds WHERE order_id = ?', [comp.body.id]))[0].n, 0, 'a comp gives no cash back');
  const gc = await api('POST', '/checkout', { token: A.owner, body: { customer: WALKIN, lines: [{ type: 'gift_card', amount_cents: 10000 }], payments: [{ tender: 'cash', amount_cents: 10000 }] } });
  const code = gc.body.gift_cards[0].code;
  const s2 = await api('POST', '/checkout', { token: A.owner, body: { customer: WALKIN, lines: [{ type: 'ticket', product_id: day, valid_on: peak }], payments: [{ tender: 'gift_card', code, amount_cents: 8000 }] } });
  const mv2 = await api('POST', `/guests/tickets/${s2.body.tickets[0].code}/change-day`, { token: A.owner, body: { date: cheap } });
  assert.equal(mv2.status, 200, mv2.text);
  assert.equal(mv2.body.back_method, 'gift_card');
  assert.deepEqual((await q('SELECT method, amount_cents FROM order_refunds WHERE order_id = ?', [s2.body.id])).map((r) => [r.method, r.amount_cents]), [['gift_card', 3000]]);
  assert.equal((await q('SELECT balance_cents FROM gift_cards WHERE tenant_id = ? AND code = ?', [A.id, code]))[0].balance_cents, 5000);
});

test('MONEY-4: gift card money in a mixed basket goes back on the gift card, never as cash', async () => {
  const A = await mountain('m4');
  const day = await A.product({ kind: 'day_ticket', name: 'Adult Day', base_price_cents: 8000 });
  await api('PATCH', '/guests/settings', { token: A.owner, body: { counter_refund_limit_cents: 10000 } });
  const counter = await A.user('counter', 'counter');
  await api('POST', '/till/open', { token: counter, body: { opening_float_cents: 20000 } });
  const gc = await api('POST', '/checkout', { token: A.owner, body: { customer: WALKIN, lines: [{ type: 'gift_card', amount_cents: 8000 }], payments: [{ tender: 'card', card_last4: '4242', amount_cents: 8000 }] } });
  const card = gc.body.gift_cards[0].code;
  const sale = await api('POST', '/checkout', { token: counter, body: { customer: WALKIN, lines: [{ type: 'ticket', product_id: day, valid_on: plus(today, 5) }, { type: 'gift_card', amount_cents: 8000 }],
    payments: [{ tender: 'gift_card', code: card, amount_cents: 8000 }, { tender: 'cash', amount_cents: 8000 }] } });
  assert.equal(sale.status, 201, sale.text);
  const order = (await api('GET', `/orders/${sale.body.id}`, { token: A.owner })).body;
  const ticketLine = order.lines.find((l) => l.line_kind === 'ticket').id;
  const asCash = await api('POST', `/orders/${sale.body.id}/refund`, { token: counter, body: { reason: 'customer_request', item_ids: [ticketLine], method: 'cash' } });
  assert.equal(asCash.status, 409, 'gift card money cannot be asked for as cash');
  const rf = await api('POST', `/orders/${sale.body.id}/refund`, { token: counter, body: { reason: 'customer_request', item_ids: [ticketLine] } });
  assert.equal(rf.status, 200, rf.text);
  assert.deepEqual(rf.body.returns, [{ method: 'gift_card', amount_cents: 8000 }]);
  assert.equal((await q('SELECT balance_cents FROM gift_cards WHERE tenant_id = ? AND code = ?', [A.id, card]))[0].balance_cents, 8000);
  // the new gift card line itself is cash money: it goes back as cash
  const giftLine = order.lines.find((l) => l.line_kind === 'gift_card').id;
  const rf2 = await api('POST', `/orders/${sale.body.id}/refund`, { token: A.owner, body: { reason: 'customer_request', item_ids: [giftLine], till_id: (await q("SELECT id FROM till_sessions WHERE tenant_id = ? AND status = 'open'", [A.id]))[0].id } });
  assert.equal(rf2.status, 200, rf2.text);
  assert.deepEqual(rf2.body.returns, [{ method: 'cash', amount_cents: 8000 }]);
});

test('MONEY-8: "other" money needs a reference and a reason, and counts against the comp limit; POST /orders is for managers', async () => {
  const A = await mountain('m8');
  const day = await A.product({ kind: 'day_ticket', name: 'Adult Day', base_price_cents: 8000 });
  await q('UPDATE tenants SET comp_counter_limit_cents = 10000 WHERE id = ?', [A.id]);
  const counter = await A.user('counter', 'counter');
  const sell = (body, token = counter) => api('POST', '/checkout', { token, body: { customer: WALKIN, ...body } });
  assert.equal((await sell({ lines: [{ type: 'ticket', product_id: day }], payments: [{ tender: 'other', amount_cents: 8000 }] })).status, 400, 'no reference');
  assert.equal((await sell({ lines: [{ type: 'ticket', product_id: day }], payments: [{ tender: 'other', amount_cents: 8000, reference: 'CHK 101' }] })).status, 400, 'no reason');
  assert.equal((await sell({ lines: [{ type: 'ticket', product_id: day }], payments: [{ tender: 'other', amount_cents: 8000, reference: 'CHK 101', reason: 'Club check' }] })).status, 201, 'within the limit');
  const over = await sell({ lines: [{ type: 'ticket', product_id: day, quantity: 2 }], payments: [{ tender: 'other', amount_cents: 8000, reference: 'V1', reason: 'Voucher' }, { tender: 'comp', comp_reason: 'staff', amount_cents: 8000 }] });
  assert.equal(over.status, 403, 'other and comp together are over the limit');
  assert.equal((await sell({ lines: [{ type: 'ticket', product_id: day, quantity: 2 }], payments: [{ tender: 'other', amount_cents: 16000, reference: 'V2', reason: 'Voucher' }] }, A.owner)).status, 201, 'a manager can');
  const [p] = await q("SELECT reference, comp_reason FROM order_payments WHERE tenant_id = ? AND tender = 'other' ORDER BY id LIMIT 1", [A.id]);
  assert.deepEqual([p.reference, p.comp_reason], ['CHK 101', 'Club check']);
  assert.equal((await api('POST', '/orders', { token: counter, body: { items: [{ product_id: day }] } })).status, 403);
});

test('MONEY-9: POST /orders keeps the day ticket limit; a manager goes over only with a reason', async () => {
  const A = await mountain('m9');
  const day = await A.product({ kind: 'day_ticket', name: 'Adult Day', base_price_cents: 8000 });
  await q('UPDATE tenants SET online_daily_limit = 2 WHERE id = ?', [A.id]);
  const on = plus(today, 2);
  const r = await api('POST', '/orders', { token: A.owner, body: { items: [{ product_id: day, valid_on: on, quantity: 5 }] } });
  assert.equal(r.status, 409, r.text);
  assert.equal((await api('POST', '/orders', { token: A.owner, body: { items: [{ product_id: day, valid_on: on, quantity: 2 }] } })).status, 201);
  const why = await api('POST', '/orders', { token: A.owner, body: { items: [{ product_id: day, valid_on: on, quantity: 1 }], over_limit_reason: 'School group' } });
  assert.equal(why.status, 201, why.text);
  assert.equal((await q("SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ? AND action = 'sell_over_limit'", [A.id]))[0].n, 1);
});

test('MONEY-2: a program refund withdraws every place sold on that line, and only those', async () => {
  const A = await mountain('m2');
  await q("INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, 'programs', 1) ON DUPLICATE KEY UPDATE enabled = 1", [A.id]);
  require('../src/lib/modules').invalidate(A.id);
  let monday = plus(today, 14); while (new Date(`${monday}T12:00:00Z`).getUTCDay() !== 1) monday = plus(monday, 1);
  const prog = (await api('POST', '/programs', { token: A.owner, body: { name: 'After-School', kind: 'school_program', season: '2026-27', price_cents: 0, age_min: 6, age_max: 12 } })).body.id;
  const term = async (name, start) => (await api('POST', `/programs/${prog}/terms`, { token: A.owner, body: { name, starts_on: start, weeks: 4, start_time: '15:45', end_time: '17:45', price_cents: 20000, status: 'open', days: [{ weekday: 2, capacity: 10 }] } })).body;
  const t1 = await term('Session 1', monday); const t2 = await term('Session 2', plus(monday, 42));
  const bundle = (await api('POST', `/programs/${prog}/bundles`, { token: A.owner, body: { name: 'Both', price_cents: 36000, term_ids: [t1.id, t2.id] } })).body.id;
  const sale = await api('POST', '/checkout', { token: A.owner, body: { customer: { details: { first_name: 'Mia', last_name: 'Moss', email: 'mia@x.test', date_of_birth: '1985-01-01', sex: 'female' } },
    participants: { n: { details: { first_name: 'Nia', last_name: 'Moss', date_of_birth: '2017-07-07', sex: 'female' }, sign_waiver: true } },
    lines: [{ type: 'program', program_id: prog, participant: 'n', bundle_id: bundle, groups: [{ term_id: t1.id, group_id: t1.groups[0].id }, { term_id: t2.id, group_id: t2.groups[0].id }] }],
    payments: [{ tender: 'cash', amount_cents: 36000 }] } });
  assert.equal(sale.status, 201, sale.text);
  const kid = sale.body.programs[0].person_id;
  assert.equal((await api('POST', `/orders/${sale.body.id}/refund`, { token: A.owner, body: { reason: 'customer_request', method: 'cash' } })).status, 200);
  assert.deepEqual((await q('SELECT status FROM program_enrollments WHERE tenant_id = ? AND person_id = ?', [A.id, kid])).map((x) => x.status), ['withdrawn', 'withdrawn']);
  const kid2 = { n: { details: { first_name: 'Ola', last_name: 'Moss', date_of_birth: '2016-02-02', sex: 'female' }, sign_waiver: true } };
  const x = await api('POST', '/checkout', { token: A.owner, body: { customer: { person_id: sale.body.person_id }, participants: kid2, lines: [{ type: 'program', program_id: prog, participant: 'n', term_id: t1.id, group_id: t1.groups[0].id }], payments: [{ tender: 'cash', amount_cents: 20000 }] } });
  const k2 = x.body.programs[0].person_id;
  const y = await api('POST', '/checkout', { token: A.owner, body: { customer: { person_id: sale.body.person_id }, participants: { n: { person_id: k2 } }, lines: [{ type: 'program', program_id: prog, participant: 'n', term_id: t2.id, group_id: t2.groups[0].id }], payments: [{ tender: 'cash', amount_cents: 20000 }] } });
  assert.equal(y.status, 201, y.text);
  assert.equal((await api('POST', `/orders/${y.body.id}/refund`, { token: A.owner, body: { reason: 'customer_request', method: 'cash' } })).status, 200);
  const after = await q('SELECT term_id, status FROM program_enrollments WHERE tenant_id = ? AND person_id = ? ORDER BY term_id', [A.id, k2]);
  assert.deepEqual(after.map((e) => [e.term_id, e.status]), [[t1.id, 'enrolled'], [t2.id, 'withdrawn']]);
});

test('MONEY-5: a one-use promo code is used once online; a later payment with it is refunded in full', async () => {
  const A = await mountain('m5');
  await api('PUT', '/tenant/profile', { token: A.owner, body: { online_shop: true } });
  const day = await A.product({ kind: 'day_ticket', name: 'Adult Day', base_price_cents: 10000, online: 1 });
  assert.equal((await api('POST', '/pricing/promos', { token: A.owner, body: { code: 'ONCE50', percent_off: 50, max_uses: 1 } })).status, 201);
  const rowsMade = [];
  for (let k = 0; k < 3; k++) {
    const r = await A.pub('POST', '/shop/orders', { body: { ...contact, items: [{ product_id: day, valid_on: plus(today, 3 + k), holder: { first_name: 'Ann', last_name: 'Buyer', date_of_birth: `${year - 35}-04-01` } }], promo_code: 'ONCE50' } });
    assert.equal(r.status, 201, r.text);
    rowsMade.push((await q('SELECT * FROM shop_orders WHERE tenant_id = ? AND reference = ?', [A.id, r.body.reference]))[0]);
  }
  const outs = [];
  for (const row of rowsMade) outs.push((await webhook(paidEvent(A, row))).body);
  assert.equal(outs.filter((o) => o.ok).length, 1);
  assert.equal(outs.filter((o) => o.refunded).length, 2);
  assert.equal((await q("SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ? AND promo_code = 'ONCE50'", [A.id]))[0].n, 1);
  assert.equal((await q("SELECT used_count FROM promo_codes WHERE tenant_id = ? AND code = 'ONCE50'", [A.id]))[0].used_count, 1);
});

test('MONEY-6: an installment charged today is in today\'s daily summary and Daily report', async () => {
  const A = await planMountain('m6');
  await q('UPDATE orders SET created_at = created_at - INTERVAL 35 DAY WHERE id = ?', [A.order]);
  await q('UPDATE order_payments SET created_at = created_at - INTERVAL 35 DAY WHERE order_id = ?', [A.order]);
  assert.equal(await PPL.chargeOne(A.charge, { notify: false }), 'paid');
  const sum = (await api('GET', `/exports/daily-summary.csv?from=${today}&to=${today}`, { token: A.owner })).text;
  assert.match(sum, /"150\.00","0\.00"\s*$/m, 'card 150.00 today');
  const daily = (await api('GET', `/reports/daily?date=${today}`, { token: A.owner })).body;
  assert.equal(daily.sales.tenders.card, 15000);
});

test('MONEY-10: lesson cancel hours count the real hours across a clock change', () => {
  const { hoursUntil } = require('../src/lib/onlinesale');
  assert.equal(hoursUntil('2026-11-01 10:00:00', '2026-10-31 10:30:00', 'America/New_York'), 24.5);
  assert.equal(hoursUntil('2027-03-14 10:00:00', '2027-03-13 09:30:00', 'America/New_York'), 23.5);
  assert.equal(hoursUntil('2027-01-14 10:00:00', '2027-01-13 09:30:00', 'America/Denver'), 24.5);
});

test('DP-3: payment free-text fields refuse card numbers', async () => {
  const pan = require('../src/lib/pan');
  assert.ok(pan.hasCardNumber('4111 1111 1111 1111')); assert.ok(pan.hasCardNumber('x4111-1111-1111-1111')); assert.ok(pan.luhn('4111111111111111'));
  assert.ok(!pan.hasCardNumber('AUTH 123456')); assert.ok(!pan.hasCardNumber('pi_3Nabc12345'));
  const A = await mountain('dp3');
  const day = await A.product({ kind: 'day_ticket', name: 'Adult Day', base_price_cents: 8000 });
  const r = await api('POST', '/checkout', { token: A.owner, body: { customer: WALKIN, lines: [{ type: 'ticket', product_id: day }], payments: [{ tender: 'card', card_last4: '1111', amount_cents: 8000, auth_code: '4111111111111111', reference: '4111 1111 1111 1111 12/29' }] } });
  assert.equal(r.status, 400);
  assert.equal((await q("SELECT COUNT(*) AS n FROM order_payments WHERE tenant_id = ? AND (auth_code LIKE '%4111111111111111%' OR reference LIKE '%1111 1111%')", [A.id]))[0].n, 0);
  assert.equal((await api('POST', '/orders', { token: A.owner, body: { items: [{ product_id: day }], payment_ref: '5555-5555-5555-4444' } })).status, 400);
});

test('suspicions: Stripe dashboard refunds and disputes are recorded; cash refunds and payouts are held to the drawer', async () => {
  const A = await planMountain('sx');
  const pi = `pi_${A.row.stripe_session_id}`;
  const ev = (type, object) => webhook({ id: `evt_${++S.n}`, type, data: { object } });
  assert.equal((await ev('charge.refunded', { id: 'ch_1', payment_intent: pi, amount_refunded: 5000, refunds: { data: [{ id: 're_dash' }] } })).status, 200);
  await ev('charge.refunded', { id: 'ch_1', payment_intent: pi, amount_refunded: 5000 });
  const rs = await q('SELECT amount_cents, note, method FROM order_refunds WHERE order_id = ?', [A.order]);
  assert.deepEqual(rs.map((r) => [r.amount_cents, r.method]), [[5000, 'card']], 'recorded once');
  await ev('charge.dispute.created', { id: 'dp_1', payment_intent: pi, amount: 15000, reason: 'fraudulent', status: 'needs_response' });
  const o = (await api('GET', `/orders/${A.order}`, { token: A.owner })).body;
  assert.equal(o.disputes.length, 1); assert.equal(o.disputes[0].status, 'needs_response');

  const B = await mountain('sy');
  const day = await B.product({ kind: 'day_ticket', name: 'Adult Day', base_price_cents: 8000 });
  const counter = await B.user('counter', 'counter');
  await api('POST', '/till/open', { token: counter, body: { opening_float_cents: 20000 } });
  assert.equal((await api('POST', '/till/moves', { token: counter, body: { kind: 'payout', amount_cents: 4000, reason: 'Tape' } })).status, 201);
  assert.equal((await api('POST', '/till/moves', { token: counter, body: { kind: 'payout', amount_cents: 2000, reason: 'More tape' } })).status, 403, 'over the payout limit');
  const sale = await api('POST', '/checkout', { token: counter, body: { customer: WALKIN, lines: [{ type: 'ticket', product_id: day }], payments: [{ tender: 'cash', amount_cents: 8000 }] } });
  const noDrawer = await api('POST', `/orders/${sale.body.id}/refund`, { token: B.owner, body: { reason: 'customer_request' } });
  assert.equal(noDrawer.status, 409, 'a drawer is open: the cash comes out of one');
  const till = (await q("SELECT id FROM till_sessions WHERE tenant_id = ? AND status = 'open'", [B.id]))[0].id;
  assert.equal((await api('POST', `/orders/${sale.body.id}/refund`, { token: B.owner, body: { reason: 'customer_request', till_id: till } })).status, 200);
});

test('a plan basket with a gift card started through PPL.start keeps the gift card up front', async () => {
  const A = await mountain('st');
  const [p] = await pool.query("INSERT INTO people (tenant_id, first_name, last_name) VALUES (?, 'Pat', 'Plan')", [A.id]);
  const [o] = await pool.query("INSERT INTO orders (tenant_id, person_id, status, subtotal_cents, tax_cents, total_cents, channel) VALUES (?, ?, 'paid', 50000, 0, 50000, 'online')", [A.id, p.insertId]);
  const id = await tx((conn) => PPL.start(conn, A.id, { id: o.insertId, person_id: p.insertId, total_cents: 50000, payment_intent: 'pi_x' }, { count: 3, plan: { upfront_cents: 5000 } }));
  assert.deepEqual((await q('SELECT cents FROM payment_plan_charges WHERE plan_id = ? ORDER BY n', [id])).map((c) => c.cents), [20000, 15000, 15000]);
});
