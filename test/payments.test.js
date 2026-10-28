'use strict';

// Paying for a lesson when reserving it online: the Stripe checkout is created against a mock Stripe server, the webhook is
// signed like the real one, and the tiered cancellation policy decides how much comes back.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.BOOKING_RATE_LIMIT = '1000';
process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const config = require('../src/config');
const stripe = require('../src/lib/stripe');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base; let mock; const calls = []; let n = 0;
const pages = new Map(); const stripeSays = { refuseRefunds: false }; // the mock's checkout pages, and a switch for a refund Stripe refuses
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const q = async (sql, params) => (await pool.query(sql, params))[0];

async function call(prefix, method, path, { token, body } = {}) {
  const res = await fetch(`${base}${prefix}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const api = (m, p, o) => call('/api/v1', m, p, o);
const mountainWall = (hoursAhead) => {
  const d = new Date(Date.now() + hoursAhead * 3_600_000);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'medium' }).format(d);
};
async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, phone: '215-555-0000', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  return { slug, owner: (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token };
}
const webhook = async (event, { secret = 'whsec_mock', t, tamper } = {}) => {
  const raw = JSON.stringify(event);
  const header = stripe.signWebhook(raw, secret, t);
  const res = await fetch(`${base}/api/v1/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: tamper ? raw.replace('"paid"', '"unpaid"') : raw });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const completed = (co, request, tenant, extra = {}) => ({ id: `evt_${++n}`, type: 'checkout.session.completed', data: { object: { id: co.session_id, payment_status: 'paid', amount_total: co.amount_cents, payment_intent: `pi_${co.session_id}`, metadata: { tenant_id: String(tenant), request_id: String(request) }, ...extra } } });

let A; let tenantId; let sessionId; let pub;
const kid = { first_name: 'Kit', last_name: 'Kid', date_of_birth: `${new Date().getFullYear() - 9}-02-01`, sex: 'male', discipline: 'ski' };
const reqBody = (extra = {}) => ({ session_id: sessionId, contact_first_name: 'Pam', contact_last_name: 'Parent', contact_email: 'pam@x.test', contact_phone: '215-555-0100', students: [kid], waiver_accepted: true, policy_accepted: true, ...extra });
const newLesson = async (hoursAhead, capacity = 4) => {
  const [r] = await pool.query("INSERT INTO lesson_sessions (tenant_id, product_id, starts_at, ends_at, capacity, status) VALUES (?, ?, ?, ?, ?, 'scheduled')", [tenantId, A.product, mountainWall(hoursAhead), mountainWall(hoursAhead + 2), capacity]);
  return r.insertId;
};
/** Reserve and pay (the webhook arrives) and return what the guest sees. */
async function reserveAndPay(hoursAhead, { students = [kid], capacity = 4 } = {}) {
  sessionId = await newLesson(hoursAhead, capacity);
  const r = await pub('POST', '/requests', { body: reqBody({ students }) });
  assert.equal(r.status, 201, r.text);
  const row = (await q('SELECT * FROM lesson_requests WHERE tenant_id = ? AND reference = ?', [tenantId, r.body.reference]))[0];
  const info = { reference: r.body.reference, request_id: row.id, session_id: row.stripe_session_id, amount_cents: row.amount_cents, checkout_url: r.body.checkout_url };
  const w = await webhook(completed(info, row.id, tenantId));
  assert.equal(w.status, 200, JSON.stringify(w.body));
  return info;
}

test.before(async () => {
  mock = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const params = Object.fromEntries(new URLSearchParams(data));
      calls.push({ path: req.url, method: req.method, params, auth: req.headers.authorization, key: req.headers['idempotency-key'], account: req.headers['stripe-account'] || null });
      res.setHeader('content-type', 'application/json');
      let m;
      if (req.url === '/v1/checkout/sessions') { const id = `cs_test_${++n}`; pages.set(id, { id, status: 'open' }); res.end(JSON.stringify({ id, url: `https://checkout.stripe.test/c/${n}` })); }
      else if ((m = req.url.match(/^\/v1\/checkout\/sessions\/(cs_test_\d+)\/expire$/))) {
        const pg = pages.get(m[1]);
        if (!pg || pg.status !== 'open') { res.statusCode = 400; res.end(JSON.stringify({ error: { message: 'Only Checkout Sessions with a status in ["open"] can be expired.' } })); } else { pg.status = 'expired'; res.end(JSON.stringify(pg)); }
      } else if ((m = req.url.match(/^\/v1\/checkout\/sessions\/(cs_test_\d+)$/))) res.end(JSON.stringify(pages.get(m[1]) || {}));
      else if (req.url === '/v1/refunds' && stripeSays.refuseRefunds) { res.statusCode = 500; res.end(JSON.stringify({ error: { message: 'Stripe is having a bad day' } })); }
      else if (req.url === '/v1/refunds') res.end(JSON.stringify({ id: `re_${++n}` }));
      else if (req.url.startsWith('/v1/refunds?')) res.end(JSON.stringify({ data: [] }));
      else { res.statusCode = 404; res.end('{}'); }
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  config.stripe.apiBase = `http://127.0.0.1:${mock.address().port}`;
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`pa-${suffix}`);
  tenantId = (await q('SELECT id FROM tenants WHERE slug = ?', [A.slug]))[0].id;
  pub = (m, p, o) => call('/api/v1/public', m, `/${A.slug}${p}`, o);
  A.product = (await api('POST', '/products', { token: A.owner, body: { kind: 'lesson', name: 'Group Lesson', base_price_cents: 8000 } })).body.id;
  assert.equal((await api('POST', '/tax-rules', { token: A.owner, body: { name: 'Sales tax', applies_to: 'all', rate_percent: 6 } })).status, 201);
  assert.equal((await api('PUT', '/tenant/profile', { token: A.owner, body: { online_booking: true, booking_notice_hours: 1, online_payment: true, refund_full_hours: 48, refund_half_hours: 24, refund_half_percent: 50 } })).status, 200);
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => mock.close(r)); await pool.end(); });

test('the booking page publishes the policy and takes card payment; the refund tiers must be sensible', async () => {
  sessionId = await newLesson(100);
  const page = (await pub('GET', '/booking')).body;
  assert.equal(page.pay_online, true);
  assert.ok(page.policy.join(' ').includes('48 hours'));
  assert.ok(page.policy.join(' ').includes('50%'));
  assert.equal((await api('PUT', '/tenant/profile', { token: A.owner, body: { refund_full_hours: 10, refund_half_hours: 20 } })).status, 400, 'partial cutoff must be later than the full cutoff');
});

test('a reservation must accept the policy, then goes to Stripe for the tax-inclusive total', async () => {
  sessionId = await newLesson(100);
  assert.equal((await pub('POST', '/requests', { body: reqBody({ policy_accepted: false }) })).status, 400);
  const before = calls.length;
  const r = await pub('POST', '/requests', { body: reqBody() });
  assert.equal(r.status, 201, r.text);
  assert.match(r.body.checkout_url, /^https:\/\/checkout\.stripe\.test\//);
  assert.equal(r.body.amount_cents, 8480, '$80 plus 6% tax');
  const c = calls.slice(before).find((x) => x.path === '/v1/checkout/sessions');
  assert.equal(c.auth, 'Bearer sk_test_mock');
  assert.equal(c.params['line_items[0][price_data][unit_amount]'], '8480');
  const row = (await q('SELECT status, amount_cents FROM lesson_requests WHERE reference = ?', [r.body.reference]))[0];
  assert.equal(row.status, 'awaiting_payment');
  assert.equal((await q('SELECT COUNT(*) AS n FROM lesson_bookings WHERE session_id = ?', [sessionId]))[0].n, 0, 'nothing is booked until the money arrives');
  // the spot is held while the guest pays
  const held = (await pub('GET', '/booking')).body.lessons.find((l) => l.id === sessionId);
  assert.equal(held.spots_left, 3);
});

test('every card page has its own Stripe key: the table, the row and the amount, never shared by two guests', async () => {
  const page = (key, amountCents = 25000) => stripe.createCheckout({ amountCents, name: 'Program', email: 'p@x.test', reference: 'R1', metadata: { tenant_id: String(tenantId), registration_id: '1', kind: 'program' },
    successUrl: 'https://x.test/s', cancelUrl: 'https://x.test/c', ...(key ? { idempotencyKey: key } : {}) });
  const before = calls.length;
  await page('program-101'); await page('program-102'); await page('lesson-101'); await page('program-101', 26000);
  assert.deepEqual(calls.slice(before).filter((x) => x.path === '/v1/checkout/sessions').map((x) => x.key),
    ['checkout-program-101-25000', 'checkout-program-102-25000', 'checkout-lesson-101-25000', 'checkout-program-101-26000']);
  await assert.rejects(page(null), /idempotencyKey/, 'a card page without its own key is never sent');
  sessionId = await newLesson(100);
  const r = await pub('POST', '/requests', { body: reqBody() });
  assert.equal(r.status, 201, r.text);
  const row = (await q('SELECT id, amount_cents FROM lesson_requests WHERE reference = ?', [r.body.reference]))[0];
  assert.equal(calls.filter((x) => x.path === '/v1/checkout/sessions').at(-1).key, `checkout-lesson-${row.id}-${row.amount_cents}`);
});

test('webhooks need a valid, fresh signature, and a paid webhook books the lesson and records the sale once', async () => {
  sessionId = await newLesson(100);
  const r = await pub('POST', '/requests', { body: reqBody() });
  const row = (await q('SELECT * FROM lesson_requests WHERE reference = ?', [r.body.reference]))[0];
  const info = { session_id: row.stripe_session_id, amount_cents: row.amount_cents };
  const ev = completed(info, row.id, tenantId);
  assert.equal((await webhook(ev, { secret: 'whsec_wrong' })).status, 400);
  assert.equal((await webhook(ev, { t: Math.floor(Date.now() / 1000) - 3600 })).status, 400, 'a replayed old signature is refused');
  assert.equal((await webhook(ev, { tamper: true })).status, 400);
  assert.equal((await q('SELECT status FROM lesson_requests WHERE id = ?', [row.id]))[0].status, 'awaiting_payment', 'bad webhooks change nothing');
  assert.equal((await webhook(ev)).status, 200);
  assert.equal((await webhook(ev)).body.duplicate, true, 'a repeat delivery is harmless');
  const done = (await q('SELECT status, order_id FROM lesson_requests WHERE id = ?', [row.id]))[0];
  assert.equal(done.status, 'confirmed');
  const order = (await q('SELECT status, total_cents, tax_cents, channel FROM orders WHERE id = ?', [done.order_id]))[0];
  assert.deepEqual({ ...order }, { status: 'paid', total_cents: 8480, tax_cents: 480, channel: 'online' });
  assert.equal((await q('SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ?', [tenantId]))[0].n >= 1, true);
  const pay = (await q('SELECT tender, amount_cents, processor FROM order_payments WHERE order_id = ?', [done.order_id]))[0];
  assert.deepEqual({ ...pay }, { tender: 'card', amount_cents: 8480, processor: 'stripe' });
  const bk = await q('SELECT status, unpaid FROM lesson_bookings WHERE session_id = ?', [sessionId]);
  assert.equal(bk.length, 1);
  assert.equal(bk[0].unpaid, 0);
});

test('a payment for the wrong amount is refunded and nothing is booked', async () => {
  sessionId = await newLesson(100);
  const r = await pub('POST', '/requests', { body: reqBody() });
  const row = (await q('SELECT * FROM lesson_requests WHERE reference = ?', [r.body.reference]))[0];
  const before = calls.length;
  const w = await webhook(completed({ session_id: row.stripe_session_id, amount_cents: 100 }, row.id, tenantId));
  assert.equal(w.status, 200);
  assert.equal((await q('SELECT status FROM lesson_requests WHERE id = ?', [row.id]))[0].status, 'expired');
  assert.equal((await q('SELECT COUNT(*) AS n FROM lesson_bookings WHERE session_id = ?', [sessionId]))[0].n, 0);
  const rf = calls.slice(before).find((x) => x.path === '/v1/refunds');
  assert.equal(rf.params.amount, '100');
});

test('if the lesson filled up while the guest was paying, they are refunded in full', async () => {
  sessionId = await newLesson(100, 1);
  const r = await pub('POST', '/requests', { body: reqBody() });
  const row = (await q('SELECT * FROM lesson_requests WHERE reference = ?', [r.body.reference]))[0];
  // the desk sells the last place before the webhook lands
  const [p] = await pool.query("INSERT INTO people (tenant_id, first_name, last_name) VALUES (?, 'Walk', 'In')", [tenantId]);
  await pool.query("INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status, unpaid) VALUES (?, ?, ?, 'booked', 0)", [tenantId, sessionId, p.insertId]);
  const before = calls.length;
  await webhook(completed({ session_id: row.stripe_session_id, amount_cents: row.amount_cents }, row.id, tenantId));
  const after = (await q('SELECT status, refund_cents, staff_note FROM lesson_requests WHERE id = ?', [row.id]))[0];
  assert.equal(after.status, 'expired');
  assert.equal(after.refund_cents, 8480);
  assert.match(after.staff_note, /Refunded automatically/);
  assert.equal(calls.slice(before).find((x) => x.path === '/v1/refunds').params.amount, '8480');
  assert.equal((await q('SELECT COUNT(*) AS n FROM orders WHERE tenant_id = ? AND payment_ref = ?', [tenantId, `pi_${row.stripe_session_id}`]))[0].n, 0);
});

test('an abandoned checkout expires and frees the spot', async () => {
  sessionId = await newLesson(100, 1);
  const r = await pub('POST', '/requests', { body: reqBody() });
  const row = (await q('SELECT * FROM lesson_requests WHERE reference = ?', [r.body.reference]))[0];
  assert.equal((await pub('POST', '/requests', { body: reqBody() })).status, 409, 'held while paying');
  const ev = { id: 'evt_x', type: 'checkout.session.expired', data: { object: { id: row.stripe_session_id, metadata: { tenant_id: String(tenantId), request_id: String(row.id) } } } };
  assert.equal((await webhook(ev)).status, 200);
  assert.equal((await q('SELECT status FROM lesson_requests WHERE id = ?', [row.id]))[0].status, 'expired');
  assert.equal((await pub('POST', '/requests', { body: reqBody() })).status, 201, 'the spot is free again');
});

test('a guest who cancels while still on Stripe\'s page: the page is closed, and a payment that lands anyway is refunded in full', async () => {
  sessionId = await newLesson(100);
  const r = await pub('POST', '/requests', { body: reqBody() });
  const row = (await q('SELECT * FROM lesson_requests WHERE reference = ?', [r.body.reference]))[0];
  const c = await pub('POST', `/requests/${r.body.reference}/cancel`, { body: { email: 'pam@x.test' } });
  assert.equal(c.status, 200, c.text);
  assert.equal(c.body.refund_cents, 0, 'nothing was paid yet');
  assert.ok(calls.some((x) => x.path === `/v1/checkout/sessions/${row.stripe_session_id}/expire`), 'the Stripe page is closed');
  assert.equal(pages.get(row.stripe_session_id).status, 'expired');
  // The other tab paid a moment before the page closed: the money goes back, nothing is booked.
  const before = calls.length;
  const w = await webhook(completed({ session_id: row.stripe_session_id, amount_cents: row.amount_cents }, row.id, tenantId));
  assert.equal(w.status, 200); assert.equal(w.body.refunded, true);
  const sent = calls.slice(before).filter((x) => x.path === '/v1/refunds');
  assert.equal(sent.length, 1); assert.equal(sent[0].params.amount, String(row.amount_cents)); assert.equal(sent[0].params.payment_intent, `pi_${row.stripe_session_id}`);
  const after = (await q('SELECT status, refund_cents, staff_note, payment_intent, order_id FROM lesson_requests WHERE id = ?', [row.id]))[0];
  assert.equal(after.status, 'cancelled'); assert.equal(after.refund_cents, row.amount_cents); assert.equal(after.order_id, null);
  assert.match(after.staff_note, /Refunded automatically: the request was canceled/);
  const owed = (await q('SELECT kind, row_id, amount_cents, card_status FROM card_returns WHERE tenant_id = ? AND payment_intent = ?', [tenantId, `pi_${row.stripe_session_id}`]))[0];
  assert.deepEqual({ ...owed }, { kind: 'lesson', row_id: row.id, amount_cents: row.amount_cents, card_status: 'sent' }, 'written down as owed, then sent');
  assert.equal((await q('SELECT COUNT(*) AS n FROM lesson_bookings WHERE session_id = ?', [sessionId]))[0].n, 0);
  const again = await webhook(completed({ session_id: row.stripe_session_id, amount_cents: row.amount_cents }, row.id, tenantId));
  assert.equal(again.body.duplicate, true, 'a repeat refunds nothing more');
  assert.equal(calls.slice(before).filter((x) => x.path === '/v1/refunds').length, 1);
  // A request that expired is the same: it cannot be booked, so its payment goes back.
  const r2 = await pub('POST', '/requests', { body: reqBody() });
  const row2 = (await q('SELECT * FROM lesson_requests WHERE reference = ?', [r2.body.reference]))[0];
  await q("UPDATE lesson_requests SET status = 'expired' WHERE id = ?", [row2.id]);
  assert.equal((await webhook(completed({ session_id: row2.stripe_session_id, amount_cents: row2.amount_cents }, row2.id, tenantId))).body.refunded, true);
  assert.equal((await q('SELECT refund_cents FROM lesson_requests WHERE id = ?', [row2.id]))[0].refund_cents, row2.amount_cents);
});

test('paid just before the cancel: the cancel gives it all back at once, and the webhook that follows changes nothing', async () => {
  sessionId = await newLesson(100);
  const r = await pub('POST', '/requests', { body: reqBody() });
  const row = (await q('SELECT * FROM lesson_requests WHERE reference = ?', [r.body.reference]))[0];
  Object.assign(pages.get(row.stripe_session_id), { status: 'complete', payment_status: 'paid', payment_intent: `pi_${row.stripe_session_id}`, amount_total: row.amount_cents });
  const before = calls.length;
  const c = await pub('POST', `/requests/${r.body.reference}/cancel`, { body: { email: 'pam@x.test' } });
  assert.equal(c.status, 200, c.text);
  assert.equal(c.body.refund_cents, row.amount_cents); assert.equal(c.body.refund_percent, 100); assert.match(c.body.message, /going back to your card/);
  assert.equal(calls.slice(before).filter((x) => x.path === '/v1/refunds').length, 1);
  const w = await webhook(completed({ session_id: row.stripe_session_id, amount_cents: row.amount_cents }, row.id, tenantId));
  assert.equal(w.body.duplicate, true);
  assert.equal(calls.slice(before).filter((x) => x.path === '/v1/refunds').length, 1, 'refunded once');
});

test('a refund Stripe cannot take now is kept as owed and sent by the daily job', async () => {
  sessionId = await newLesson(100);
  const r = await pub('POST', '/requests', { body: reqBody() });
  const row = (await q('SELECT * FROM lesson_requests WHERE reference = ?', [r.body.reference]))[0];
  assert.equal((await pub('POST', `/requests/${r.body.reference}/cancel`, { body: { email: 'pam@x.test' } })).status, 200);
  stripeSays.refuseRefunds = true;
  try {
    const w = await webhook(completed({ session_id: row.stripe_session_id, amount_cents: row.amount_cents }, row.id, tenantId));
    assert.equal(w.status, 200, 'the event is taken: the money is written down as owed');
  } finally { stripeSays.refuseRefunds = false; }
  const pi = `pi_${row.stripe_session_id}`;
  assert.equal((await q('SELECT card_status FROM card_returns WHERE tenant_id = ? AND payment_intent = ?', [tenantId, pi]))[0].card_status, 'failed');
  assert.match((await q('SELECT staff_note FROM lesson_requests WHERE id = ?', [row.id]))[0].staff_note, /Refunded automatically/);
  await require('../src/lib/cardrefund').retryAll();
  assert.equal((await q('SELECT card_status FROM card_returns WHERE tenant_id = ? AND payment_intent = ?', [tenantId, pi]))[0].card_status, 'sent');
});

test('a paid card page that cannot be matched is refunded; one whose saved page was lost is accepted when the amount is right', async () => {
  // The save of the page went missing (Stripe made it, our database never kept it): the right amount books the lesson.
  sessionId = await newLesson(100);
  const r = await pub('POST', '/requests', { body: reqBody() });
  const row = (await q('SELECT * FROM lesson_requests WHERE reference = ?', [r.body.reference]))[0];
  await q('UPDATE lesson_requests SET stripe_session_id = NULL WHERE id = ?', [row.id]);
  const w = await webhook(completed({ session_id: row.stripe_session_id, amount_cents: row.amount_cents }, row.id, tenantId));
  assert.equal(w.status, 200);
  const booked = (await q('SELECT status, order_id, stripe_session_id FROM lesson_requests WHERE id = ?', [row.id]))[0];
  assert.equal(booked.status, 'confirmed'); assert.ok(booked.order_id); assert.equal(booked.stripe_session_id, row.stripe_session_id, 'the page is saved now');
  // Waiting on its own page, but a different paid page names it: that money goes back, the request keeps waiting.
  sessionId = await newLesson(100);
  const r2 = await pub('POST', '/requests', { body: reqBody() });
  const row2 = (await q('SELECT * FROM lesson_requests WHERE reference = ?', [r2.body.reference]))[0];
  const before = calls.length;
  const stray = await webhook(completed({ session_id: 'cs_test_elsewhere', amount_cents: row2.amount_cents }, row2.id, tenantId, { payment_intent: `pi_stray_${suffix}` }));
  assert.equal(stray.status, 200); assert.equal(stray.body.refunded, true);
  assert.equal(calls.slice(before).find((x) => x.path === '/v1/refunds').params.payment_intent, `pi_stray_${suffix}`);
  assert.equal((await q('SELECT status FROM lesson_requests WHERE id = ?', [row2.id]))[0].status, 'awaiting_payment');
  assert.match((await q('SELECT reason FROM card_returns WHERE tenant_id = ? AND payment_intent = ?', [tenantId, `pi_stray_${suffix}`]))[0].reason, /not the card page saved/);
  assert.equal((await webhook(completed({ session_id: row2.stripe_session_id, amount_cents: row2.amount_cents }, row2.id, tenantId))).status, 200);
  assert.equal((await q('SELECT status FROM lesson_requests WHERE id = ?', [row2.id]))[0].status, 'confirmed', 'its own page still books it');
  // Already paid, and a second payment arrives: it goes back, and the booking is left as it was.
  const third = await webhook(completed({ session_id: 'cs_test_again', amount_cents: row2.amount_cents }, row2.id, tenantId, { payment_intent: `pi_twice_${suffix}` }));
  assert.equal(third.body.refunded, true);
  const kept = (await q('SELECT status, payment_intent, staff_note FROM lesson_requests WHERE id = ?', [row2.id]))[0];
  assert.equal(kept.status, 'confirmed'); assert.equal(kept.payment_intent, `pi_${row2.stripe_session_id}`); assert.equal(kept.staff_note, null);
});

test('canceling a paid lesson refunds 100% well ahead, 50% in the middle window and nothing at the last minute', async () => {
  const cancel = (info, email = 'pam@x.test') => pub('POST', `/requests/${info.reference}/cancel`, { body: { email } });
  // 100 hours ahead: full refund
  let info = await reserveAndPay(100);
  assert.equal((await cancel(info, 'wrong@x.test')).status, 404, 'needs the right email');
  let before = calls.length;
  let c = await cancel(info);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.refund_percent, 100);
  assert.equal(c.body.refund_cents, 8480);
  assert.equal(calls.slice(before).find((x) => x.path === '/v1/refunds').params.amount, '8480');
  assert.equal((await q('SELECT status, refunded_cents FROM orders WHERE tenant_id = ? AND payment_ref = ?', [tenantId, `pi_${info.session_id}`]))[0].status, 'refunded');
  assert.equal((await q('SELECT COUNT(*) AS n FROM lesson_bookings WHERE session_id = (SELECT session_id FROM lesson_requests WHERE reference = ?) AND status = \'booked\'', [info.reference]))[0].n, 0);
  assert.equal((await q('SELECT COUNT(*) AS n FROM order_refunds WHERE tenant_id = ? AND method = \'card\'', [tenantId]))[0].n >= 1, true);
  assert.equal((await cancel(info)).status, 409, 'cannot cancel twice');
  // 30 hours ahead: half
  info = await reserveAndPay(30);
  before = calls.length;
  c = await cancel(info);
  assert.equal(c.body.refund_percent, 50);
  assert.equal(c.body.refund_cents, 4240);
  assert.equal(calls.slice(before).find((x) => x.path === '/v1/refunds').params.amount, '4240');
  const o = (await q('SELECT status, refunded_cents FROM orders WHERE tenant_id = ? AND payment_ref = ?', [tenantId, `pi_${info.session_id}`]))[0];
  assert.deepEqual({ ...o }, { status: 'paid', refunded_cents: 4240 });
  // 10 hours ahead: none
  info = await reserveAndPay(10);
  before = calls.length;
  c = await cancel(info);
  assert.equal(c.body.refund_percent, 0);
  assert.equal(c.body.refund_cents, 0);
  assert.equal(calls.slice(before).some((x) => x.path === '/v1/refunds'), false);
  assert.equal((await pub('POST', `/requests/${info.reference}/status`, { body: { email: 'pam@x.test' } })).body.status, 'cancelled');
});

test('card payment is off until switched on, and another mountain cannot confirm this one\'s request', async () => {
  const B = await mountain(`pb-${suffix}`);
  const bid = (await q('SELECT id FROM tenants WHERE slug = ?', [B.slug]))[0].id;
  sessionId = await newLesson(100);
  const r = await pub('POST', '/requests', { body: reqBody() });
  const row = (await q('SELECT * FROM lesson_requests WHERE reference = ?', [r.body.reference]))[0];
  // an event naming the other mountain finds nothing to confirm
  const w = await webhook(completed({ session_id: row.stripe_session_id, amount_cents: row.amount_cents }, row.id, bid));
  assert.equal(w.status, 200);
  assert.equal((await q('SELECT status FROM lesson_requests WHERE id = ?', [row.id]))[0].status, 'awaiting_payment');
  await api('PUT', '/tenant/profile', { token: A.owner, body: { online_payment: false } });
  assert.equal((await pub('GET', '/booking')).body.pay_online, false);
  sessionId = await newLesson(100);
  const free = await pub('POST', '/requests', { body: reqBody({ policy_accepted: undefined }) });
  assert.equal(free.status, 201);
  assert.equal(free.body.checkout_url, undefined, 'without card payment it is a desk request');
});

test('the quote endpoint gives the exact total, tax included, and the page lists the policy as tiers', async () => {
  await api('PUT', '/tenant/profile', { token: A.owner, body: { online_payment: true } });
  sessionId = await newLesson(100);
  const adult = '1985-03-02'; const kidDob = kid.date_of_birth;
  const one = await pub('POST', '/quote', { body: { session_id: sessionId, students: [{ date_of_birth: adult }] } });
  assert.equal(one.status, 200, one.text);
  assert.deepEqual({ s: one.body.subtotal_cents, t: one.body.tax_cents, total: one.body.total_cents }, { s: 8000, t: 480, total: 8480 });
  const two = await pub('POST', '/quote', { body: { session_id: sessionId, students: [{ date_of_birth: adult }, { date_of_birth: kidDob }] } });
  assert.equal(two.body.total_cents, 16960);
  assert.equal((await pub('POST', '/quote', { body: { session_id: 999999999, students: [{ date_of_birth: adult }] } })).status, 404);
  const page = (await pub('GET', '/booking')).body;
  assert.deepEqual(page.policy_tiers.map((t) => t.percent), [100, 50, 0]);
  assert.equal(page.policy_tiers[0].from_hours, 48);
  assert.ok(page.policy_notes.length >= 1);
});

test('the mountain cancels a lesson: paid online refunded in full, package lesson given back, desk payment listed', async () => {
  // Five hours out: a guest canceling now would get nothing back, but the mountain canceling refunds everything.
  const info = await reserveAndPay(5);
  const sid = sessionId;
  const person = async (first) => (await pool.query('INSERT INTO people (tenant_id, first_name, last_name, email) VALUES (?, ?, ?, ?)', [tenantId, first, 'Guest', `${first.toLowerCase()}@x.test`]))[0].insertId;
  const pack = await person('Pack');
  const [cr] = await pool.query('INSERT INTO lesson_credits (tenant_id, person_id, product_id, total, used) VALUES (?, ?, ?, 3, 1)', [tenantId, pack, A.product]);
  await pool.query("INSERT INTO lesson_bookings (tenant_id, session_id, person_id, credit_id, status) VALUES (?, ?, ?, ?, 'booked')", [tenantId, sid, pack, cr.insertId]);
  const desk = await person('Desk');
  const [o] = await pool.query("INSERT INTO orders (tenant_id, person_id, status, subtotal_cents, total_cents, tax_cents, channel) VALUES (?, ?, 'paid', 8000, 8480, 480, 'window')", [tenantId, desk]);
  await pool.query("INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, person_id, session_id, unit_price_cents, tax_cents) VALUES (?, ?, ?, 'lesson', ?, ?, 8000, 480)", [tenantId, o.insertId, A.product, desk, sid]);
  await pool.query("INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status) VALUES (?, ?, ?, 'booked')", [tenantId, sid, desk]);

  const preview = await api('GET', `/skischool/sessions/${sid}/cancel-preview`, { token: A.owner });
  assert.equal(preview.status, 200, preview.text);
  assert.deepEqual([Number(preview.body.booked), Number(preview.body.on_package), Number(preview.body.paid_online)], [3, 1, 1]);
  assert.equal((await api('POST', `/skischool/sessions/${sid}/cancel`, { token: A.owner, body: { reason: '' } })).status, 400, 'a reason is required');
  assert.equal((await api('DELETE', `/skischool/sessions/${sid}`, { token: A.owner })).status, 409, 'a booked lesson cannot be deleted');

  const before = calls.length;
  const c = await api('POST', `/skischool/sessions/${sid}/cancel`, { token: A.owner, body: { reason: 'High winds, lifts closed' } });
  assert.equal(c.status, 200, c.text);
  assert.equal(c.body.bookings, 3); assert.equal(c.body.credits_returned, 1);
  assert.deepEqual(c.body.card_refunds.map((r) => r.amount_cents), [8480], 'the full amount, whatever the tiers say');
  assert.equal(calls.slice(before).find((x) => x.path === '/v1/refunds').params.amount, '8480');
  assert.deepEqual(c.body.desk_refunds.map((r) => [r.order_id, r.amount_cents]), [[o.insertId, 8480]]);
  assert.equal(c.body.emailed, 3, 'one email per address');
  const [s] = await q('SELECT status, cancel_reason, cancelled_by FROM lesson_sessions WHERE id = ?', [sid]);
  assert.equal(s.status, 'cancelled'); assert.equal(s.cancel_reason, 'High winds, lifts closed'); assert.ok(s.cancelled_by);
  assert.equal((await q("SELECT COUNT(*) AS n FROM lesson_bookings WHERE session_id = ? AND status = 'booked'", [sid]))[0].n, 0);
  assert.equal((await q('SELECT used FROM lesson_credits WHERE id = ?', [cr.insertId]))[0].used, 0, 'the package lesson is back');
  assert.equal((await pub('POST', `/requests/${info.reference}/status`, { body: { email: 'pam@x.test' } })).body.status, 'cancelled');
  const page = await pub('GET', '/booking');
  assert.equal(page.status, 200); assert.ok(Array.isArray(page.body.lessons));
  assert.ok(!page.body.lessons.some((x) => Number(x.id) === Number(sid)), 'off the booking page');
  assert.equal((await api('POST', `/skischool/sessions/${sid}/cancel`, { token: A.owner, body: { reason: 'Again' } })).status, 409, 'not twice');
});

test('a storm day cancels every lesson on it; a lesson nobody booked can be deleted', async () => {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(Date.now() + 30 * 86_400_000));
  const add = async (hour) => (await pool.query("INSERT INTO lesson_sessions (tenant_id, product_id, starts_at, ends_at, capacity, status) VALUES (?, ?, ?, ?, 4, 'scheduled')", [tenantId, A.product, `${day} ${hour}:00:00`, `${day} ${hour + 2}:00:00`]))[0].insertId;
  const a = await add(9); const b = await add(13); const lonely = await add(16);
  const look = await api('POST', '/skischool/sessions/cancel-days', { token: A.owner, body: { from: day, to: day, reason: 'Storm', preview: true } });
  assert.deepEqual(look.body.sessions.map((s) => Number(s.id)), [a, b, lonely]);
  assert.equal((await q('SELECT status FROM lesson_sessions WHERE id = ?', [a]))[0].status, 'scheduled', 'a preview changes nothing');
  assert.equal((await api('DELETE', `/skischool/sessions/${lonely}`, { token: A.owner })).status, 200, 'never booked: deleted');
  assert.equal((await q('SELECT COUNT(*) AS n FROM lesson_sessions WHERE id = ?', [lonely]))[0].n, 0);
  const done = await api('POST', '/skischool/sessions/cancel-days', { token: A.owner, body: { from: day, to: day, reason: 'Storm' } });
  assert.equal(done.status, 200, done.text); assert.equal(done.body.cancelled, 2);
  assert.deepEqual((await q('SELECT DISTINCT status FROM lesson_sessions WHERE id IN (?, ?)', [a, b])).map((r) => r.status), ['cancelled']);
  assert.equal((await api('POST', '/skischool/sessions/cancel-days', { token: A.owner, body: { from: day, to: day, reason: 'Storm' } })).status, 400, 'nothing left to cancel');
});
