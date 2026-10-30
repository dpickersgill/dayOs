'use strict';

// 2026.11.7: the fixes from the hands-on test of the shop, the window, the gate and the desk. Each test here failed
// before the fix. Stripe and Postmark are mock servers; the webhook is signed like the real one.
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
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');
const stripe = require('../src/lib/stripe');
const mailer = require('../src/lib/mailer');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base; let stripeMock; let pmMock; const mails = []; let n = 0;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const q = async (sql, params) => (await pool.query(sql, params))[0];
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const plus = (d, k) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const year = Number(today.slice(0, 4));
const words = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${d}T12:00:00Z`));
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

const DEVICE = 'test-device-0123456789abcdef';
async function call(prefix, method, p, { token, body } = {}) {
  const res = await fetch(`${base}${prefix}${p}`, { method, headers: { 'x-device': DEVICE, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
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
async function user(m, role) {
  const email = `${role}-${Math.floor(Math.random() * 1e6)}@${m.slug}.test`;
  assert.equal((await api('POST', '/users', { token: m.owner, body: { email, password: PW, role } })).status, 201);
  return (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token;
}
const webhook = async (event) => {
  const raw = JSON.stringify(event);
  const res = await fetch(`${base}/api/v1/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripe.signWebhook(raw, 'whsec_mock') }, body: raw });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const paidEvent = (row, tenant) => ({ id: `evt_${++n}`, type: 'checkout.session.completed', data: { object: { id: row.stripe_session_id, payment_status: 'paid', amount_total: row.amount_cents, payment_intent: `pi_${row.stripe_session_id}`, metadata: { tenant_id: String(tenant), request_id: String(row.id), shop_order_id: String(row.id), kind: 'shop' } } } });

let A; let pub; let dayP; let passP; let rentalP; let lessonP; let packP;
const order = (extra = {}) => ({ contact_first_name: 'Jordan', contact_last_name: 'Kowalski', contact_email: 'jordan@x.test', contact_phone: '215-555-0100', terms_accepted: true, waiver_accepted: true, ...extra });
async function buyPaid(extra) {
  const r = await pub('POST', '/shop/orders', { body: order(extra) });
  assert.equal(r.status, 201, r.text);
  const row = (await q('SELECT * FROM shop_orders WHERE tenant_id = ? AND reference = ?', [A.id, r.body.reference]))[0];
  const ev = paidEvent(row, A.id);
  assert.equal((await webhook(ev)).status, 200);
  const o = (await q('SELECT * FROM orders WHERE tenant_id = ? AND payment_ref = ?', [A.id, ev.data.object.payment_intent]))[0];
  return { row: (await q('SELECT * FROM shop_orders WHERE id = ?', [row.id]))[0], order: o };
}

test.before(async () => {
  stripeMock = http.createServer((req, res) => {
    let data = ''; req.on('data', (c) => { data += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/checkout/sessions') res.end(JSON.stringify({ id: `cs_s117_${++n}`, url: `https://checkout.stripe.test/c/${n}` }));
      else if (req.url === '/v1/refunds') { const p = Object.fromEntries(new URLSearchParams(data)); res.end(JSON.stringify({ id: `re_${++n}`, payment_intent: p.payment_intent, status: 'succeeded' })); }
      else if (req.url.startsWith('/v1/refunds?')) res.end(JSON.stringify({ data: [] }));
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
  A = await mountain(`s117-${suffix}`);
  pub = (m, p, o) => call('/api/v1/public', m, `/${A.slug}${p}`, o);
  const mk = async (b) => { const r = await api('POST', '/products', { token: A.owner, body: b }); assert.equal(r.status, 201, r.text); return r.body.id; };
  dayP = await mk({ kind: 'day_ticket', name: 'All-day lift ticket', base_price_cents: 8000, online: 1 });
  assert.equal((await api('PUT', `/products/${dayP}/tiers`, { token: A.owner, body: { tiers: [{ tier: 'child', price_cents: 5000 }, { tier: 'military', price_cents: 4000 }] } })).status, 200);
  passP = await mk({ kind: 'season_pass', name: 'Season pass', base_price_cents: 50000, valid_days: 150, online: 1 });
  rentalP = await mk({ kind: 'rental', name: 'Ski package', base_price_cents: 4500, online: 1 });
  assert.equal((await api('PUT', `/products/${rentalP}/tiers`, { token: A.owner, body: { tiers: [{ tier: 'child', price_cents: 3000 }] } })).status, 200);
  lessonP = await mk({ kind: 'lesson', name: 'Group lesson', base_price_cents: 6000, online: 1 });
  packP = await mk({ kind: 'lesson', name: 'Three lesson pack', base_price_cents: 15000, uses: 3, valid_days: 120, online: 1 });
  assert.equal((await api('PUT', `/products/${packP}/tiers`, { token: A.owner, body: { tiers: [{ tier: 'child', price_cents: 12000 }] } })).status, 200);
  assert.equal((await api('PUT', '/tenant/profile', { token: A.owner, body: { online_shop: true, waiver_text: 'I accept the risks of skiing.', online_booking: true } })).status, 200);
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => stripeMock.close(r)); await new Promise((r) => pmMock.close(r)); await pool.end(); });

// ---------------------------------------------------------------- 1. season pass photo
test('fix 1: the shop page has the pass photo field, and the server refuses a season pass with no photo', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'shop.js'), 'utf8');
  assert.match(src, /photoField = pass \?/, 'the photo input is built into a field');
  assert.match(src, /dob, T\('Needed for a season pass'\)\) : lab\(`a\$\{id\}`[^\n]*\n\s*photoField, extrasEl, badEl\)/, 'and added to the row');
  const holder = { first_name: 'Pat', last_name: 'Pass', date_of_birth: `${year - 40}-01-01` };
  assert.equal((await pub('POST', '/shop/quote', { body: { items: [{ product_id: passP, holder }] } })).status, 200, 'the price check needs no photo');
  const no = await pub('POST', '/shop/orders', { body: order({ items: [{ product_id: passP, holder }] }) });
  assert.equal(no.status, 400); assert.match(no.body.error, /Pat Pass needs a photo for the season pass/);
  const { order: o } = await buyPaid({ items: [{ product_id: passP, holder: { ...holder, photo: PHOTO } }] });
  const p = (await q('SELECT p.photo FROM tickets t JOIN people p ON p.id = t.person_id WHERE t.tenant_id = ? AND t.order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)', [A.id, o.id]))[0];
  assert.equal(p.photo, PHOTO, 'the photo is on the holder');
});

// ---------------------------------------------------------------- 2. add-ons for the named person and day
test('fix 2: a rental goes with the person on the ticket, on the visit day, at their guest type, and waits to be fitted', async () => {
  const visit = plus(today, 1);
  const items = [{ product_id: dayP, valid_on: visit, holder: { first_name: 'Mia', last_name: 'Kowalski', age_group: 'child' } }];
  const qt = await pub('POST', '/shop/quote', { body: { items, addons: [{ product_id: rentalP, for_item: 0 }] } });
  assert.equal(qt.status, 200, qt.text);
  assert.equal(qt.body.addons[0].unit_cents, 3000, 'the child rental price');
  assert.equal(qt.body.addons[0].valid_on, visit); assert.equal(qt.body.addons[0].for_name, 'Mia Kowalski');
  assert.equal((await pub('POST', '/shop/quote', { body: { items, addons: [{ product_id: rentalP }] } })).status, 400, 'a rental says who it is for');
  assert.equal((await pub('POST', '/shop/quote', { body: { items, addons: [{ product_id: rentalP, for_item: 3 }] } })).status, 400, 'a ticket that is not there');
  const { order: o } = await buyPaid({ items, addons: [{ product_id: rentalP, for_item: 0 }] });
  const lines = await q("SELECT i.tier, i.valid_on, p.first_name, t.valid_from, c.status AS fit, c.valid_on AS fit_on, c.person_id AS fit_person, i.person_id FROM order_items i JOIN people p ON p.id = i.person_id JOIN tickets t ON t.order_item_id = i.id LEFT JOIN rental_contracts c ON c.id = i.contract_id WHERE i.order_id = ? AND i.line_kind = 'rental'", [o.id]);
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].first_name, lines[0].tier, lines[0].valid_on, lines[0].valid_from, lines[0].fit, lines[0].fit_on], ['Mia', 'child', visit, visit, 'to_fit', visit]);
  assert.equal(lines[0].fit_person, lines[0].person_id, 'the contract is for Mia, not the buyer');
  const mail = mails.filter((m) => m.To === 'jordan@x.test').at(-1);
  assert.match(mail.TextBody, new RegExp(`Ski package, Mia Kowalski: ${words(visit)}`));
});

test('fix 2: a single lesson is not sold as a voucher: the shop sends guests to the lesson page, and a lesson pack is for its person', async () => {
  const visit = plus(today, 2);
  const items = [{ product_id: dayP, valid_on: visit, holder: { first_name: 'Mia', last_name: 'Kowalski', age_group: 'child' } }];
  const r = await pub('POST', '/shop/quote', { body: { items, addons: [{ product_id: lessonP, for_item: 0 }] } });
  assert.equal(r.status, 409); assert.match(r.body.error, /booked on the lesson page/);
  const page = (await pub('GET', '/shop')).body;
  assert.ok(!page.addons.some((a) => a.id === lessonP), 'no single lesson add-on');
  assert.ok(page.addons.find((a) => a.id === packP).per_person);
  assert.equal(page.lesson_booking.link, `/book/${A.slug}`);
  const { order: o } = await buyPaid({ items, addons: [{ product_id: packP, for_item: 0 }] });
  const pk = (await q("SELECT i.tier, i.valid_on, i.unit_price_cents, p.first_name, t.valid_from FROM order_items i JOIN people p ON p.id = i.person_id JOIN tickets t ON t.order_item_id = i.id WHERE i.order_id = ? AND i.product_id = ?", [o.id, packP]))[0];
  assert.deepEqual([pk.first_name, pk.tier, pk.valid_on, pk.valid_from, pk.unit_price_cents], ['Mia', 'child', visit, visit, 12000]);
});

// ---------------------------------------------------------------- 4. the window and the day limit
test('fix 4: the window warns at a day limit, only a manager sells over it with a reason, and it is audited; online says how many are left', async () => {
  const d = plus(today, 8);
  await api('POST', '/online-shop/calendar', { token: A.owner, body: { from: d, to: d, action: 'limit', limit: 3 } });
  const counter = await user(A, 'counter');
  const manager = await user(A, 'manager');
  const sale = (tok, extra = {}) => api('POST', '/checkout', { token: tok, body: { channel: 'window', quick: true, lines: [{ type: 'ticket', product_id: dayP, valid_on: d, quantity: 2 }], payments: [{ tender: 'cash', amount_cents: 16000 }], ...extra } });
  assert.equal((await sale(counter)).status, 201, 'two of three');
  // online: 1 left, asking for 2 says so
  const two = [1, 2].map((k) => ({ product_id: dayP, valid_on: d, holder: { first_name: `G${k}`, last_name: 'Guest', age_group: 'adult' } }));
  const r = await pub('POST', '/shop/quote', { body: { items: two } });
  assert.equal(r.status, 409); assert.match(r.body.error, /^Only 1 left for All-day lift ticket on /); assert.doesNotMatch(r.body.error, /sold out/);
  // the window: the quote says it, a counter is refused, a manager needs a reason
  const qt = await api('POST', '/checkout/quote', { token: counter, body: { lines: [{ type: 'ticket', product_id: dayP, valid_on: d, quantity: 2 }] } });
  assert.equal(qt.status, 200); assert.equal(qt.body.over_limit.length, 1);
  assert.match(qt.body.over_limit[0].words, /has 1 left under its limit \(2 of 3 sold online and at the window\)/);
  const c1 = await sale(counter); assert.equal(c1.status, 409); assert.match(c1.body.error, /Only a manager can sell over the limit/);
  assert.equal((await sale(counter, { over_limit_reason: 'Bus group' })).status, 403, 'a reason does not make a counter a manager');
  assert.equal((await sale(manager)).status, 409, 'a manager says why');
  const ok = await sale(manager, { over_limit_reason: 'School group booked by phone' });
  assert.equal(ok.status, 201, ok.text); assert.equal(ok.body.over_limit.length, 1);
  const a = (await q("SELECT detail FROM audit_log WHERE tenant_id = ? AND action = 'sell_over_limit' AND entity_id = ?", [A.id, ok.body.id]))[0];
  assert.ok(a, 'audited'); assert.match(typeof a.detail === 'string' ? a.detail : JSON.stringify(a.detail), /School group booked by phone/);
  const full = await api('POST', '/checkout/quote', { token: counter, body: { lines: [{ type: 'ticket', product_id: dayP, valid_on: d }] } });
  assert.match(full.body.over_limit[0].words, /is at its limit: 4 of 3 sold online and at the window\./);
});

// ---------------------------------------------------------------- 5. bulk price per guest type
test('fix 5: a bulk price never flattens the child price: per type, or a percent or amount on each type\'s own price', async () => {
  const d = plus(today, 20);
  const apply = (body) => api('POST', '/online-shop/calendar', { token: A.owner, body: { from: d, to: d, product_id: dayP, action: 'price', ...body } });
  const price = async (tier) => (await pub('GET', `/shop/day?date=${d}`)).body.products.find((p) => p.id === dayP).prices.find((x) => x.tier === tier).price_cents;
  const flat = await apply({ price_cents: 9900 });
  assert.equal(flat.status, 400); assert.match(flat.body.error, /own price for each guest type/);
  assert.equal(await price('child'), 5000);
  assert.equal((await apply({ prices: [{ tier: 'adult', price_cents: 9900 }, { tier: 'child', price_cents: 6900 }] })).status, 200);
  assert.equal(await price('adult'), 9900); assert.equal(await price('child'), 6900);
  assert.equal((await apply({ change: { percent: 10 } })).status, 200);
  assert.equal(await price('adult'), 8800, 'from the adult price, not from the special price'); assert.equal(await price('child'), 5500);
  assert.equal((await apply({ change: { amount_cents: -1000 } })).status, 200);
  assert.equal(await price('adult'), 7000); assert.equal(await price('child'), 4000);
  assert.equal((await apply({ change: { amount_cents: -9000 } })).status, 400, 'never zero or below');
});

// ---------------------------------------------------------------- 6. children are not created again
test('fix 6: a child bought for again online is the same record; the duplicate finder matches name and guardian', async () => {
  const kid = { first_name: 'Ava', last_name: 'Rivera', age_group: 'child' };
  const buyer = { contact_first_name: 'Pat', contact_last_name: 'Rivera', contact_email: 'pat.rivera@x.test' };
  await buyPaid({ ...buyer, items: [{ product_id: dayP, valid_on: plus(today, 3), holder: kid }] });
  await buyPaid({ ...buyer, items: [{ product_id: dayP, valid_on: plus(today, 4), holder: kid }] });
  const avas = await q("SELECT id FROM people WHERE tenant_id = ? AND first_name = 'Ava' AND last_name = 'Rivera'", [A.id]);
  assert.equal(avas.length, 1, 'one Ava');
  // two older records under one guardian (made before this fix) are found
  const pat = (await q("SELECT id FROM people WHERE tenant_id = ? AND email = 'pat.rivera@x.test'", [A.id]))[0].id;
  const [x] = await pool.query("INSERT INTO people (tenant_id, first_name, last_name) VALUES (?, 'Ava', 'Rivera')", [A.id]);
  await pool.query("INSERT INTO person_links (tenant_id, adult_id, member_id, relation) VALUES (?, ?, ?, 'guardian')", [A.id, pat, x.insertId]);
  const dups = (await api('GET', '/people/duplicates', { token: A.owner })).body.data;
  assert.ok(dups.some((g) => g.some((p) => p.id === x.insertId) && g.some((p) => p.id === avas[0].id)));
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'people.js'), 'utf8');
  assert.match(src, /Merge with another record/, 'a Merge button on the customer record');
});

// ---------------------------------------------------------------- 7, 8, 9: refund email, plain dates, net spend
test('fix 7, 8, 9: a refund emails the guest with the amount and the card, dates are plain, and spend is net of refunds', async () => {
  const visit = plus(today, 5);
  const { order: o } = await buyPaid({ contact_email: 'refund@x.test', contact_first_name: 'Rae', contact_last_name: 'Fund', contact_phone: '215-555-0177', items: [{ product_id: dayP, valid_on: visit, holder: { first_name: 'Rae', last_name: 'Fund', age_group: 'adult' } }, { product_id: dayP, valid_on: visit, holder: { first_name: 'Ray', last_name: 'Fund', age_group: 'child' } }] });
  const tickets = mails.filter((m) => m.To === 'refund@x.test').at(-1);
  assert.match(tickets.TextBody, new RegExp(words(visit))); assert.doesNotMatch(tickets.TextBody, /\d{4}-\d{2}-\d{2}/, 'no ISO dates in the ticket email');
  const item = (await q("SELECT id, person_id FROM order_items WHERE order_id = ? AND tier = 'child'", [o.id]))[0];
  const before = mails.length;
  const rf = await api('POST', `/orders/${o.id}/refund`, { token: A.owner, body: { reason: 'customer_request', item_ids: [item.id] } });
  assert.equal(rf.status, 200, rf.text); assert.equal(rf.body.emailed, true);
  const m = mails.slice(before).find((x) => x.To === 'refund@x.test');
  assert.ok(m, 'emailed'); assert.match(m.Subject, /Your refund from/);
  assert.match(m.TextBody, new RegExp(`\\$${(rf.body.amount_cents / 100).toFixed(2)} back to the card you paid with`));
  assert.match(m.TextBody, new RegExp(`All-day lift ticket, Ray Fund, ${words(visit)}`));
  // the buyer's spend is what they paid less what went back
  const act = (await api('GET', `/people/${o.person_id}/activity`, { token: A.owner })).body;
  assert.equal(act.totals.spend_cents, o.total_cents - rf.body.amount_cents);
  const print = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'print.js'), 'utf8');
  assert.match(print, /const range = \(a, b\) => \(a === b \? fmtDay\(a\)/, 'receipts show the day with its year');
});

test('fix 7: a date change online emails the old and the new day', async () => {
  await q('UPDATE tenants SET shop_change_hours = 24, shop_change_fee_cents = 0 WHERE id = ?', [A.id]);
  const from = plus(today, 6); const to = plus(today, 7);
  const { row } = await buyPaid({ contact_email: 'mover@x.test', items: [{ product_id: dayP, valid_on: from, holder: { first_name: 'Mo', last_name: 'Ver', age_group: 'adult' } }] });
  const view = (await pub('GET', `/shop/orders/${row.view_token}`)).body;
  const before = mails.length;
  const ch = await pub('POST', `/shop/orders/${row.view_token}/change`, { body: { ticket_code: view.tickets[0].code, date: to } });
  assert.equal(ch.status, 200, ch.text); assert.equal(ch.body.done, true);
  const m = mails.slice(before).find((x) => x.To === 'mover@x.test');
  assert.ok(m, 'emailed'); assert.match(m.TextBody, new RegExp(`Was: ${words(from)}`)); assert.match(m.TextBody, new RegExp(`Now: ${words(to)}`));
  await q('UPDATE tenants SET shop_change_hours = NULL WHERE id = ?', [A.id]);
});

// ---------------------------------------------------------------- 10. blind till count
test('fix 10: a cashier counts blind; the difference shows after the count; managers see the expected amount', async () => {
  const counter = await user(A, 'counter');
  assert.equal((await api('POST', '/till/open', { token: counter, body: { opening_float_cents: 10000 } })).status, 201);
  const cur = (await api('GET', '/till/current', { token: counter })).body.till;
  assert.equal(cur.blind, true); assert.equal(cur.expected_cents, null); assert.equal(cur.cash_sales_cents, null);
  const mgr = (await api('GET', `/till?date=${today}`, { token: A.owner })).body.data.find((t) => t.id === cur.id);
  assert.equal(mgr.expected_cents, 10000);
  const off = await api('POST', '/till/close', { token: counter, body: { counted_cents: 9000 } });
  assert.equal(off.status, 400); assert.match(off.body.error, /short by \$10\.00/);
  assert.ok((await q("SELECT id FROM audit_log WHERE tenant_id = ? AND action = 'count' AND entity_id = ?", [A.id, cur.id])).length, 'the count is kept');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'till.js'), 'utf8');
  assert.match(src, /t\.blind\s*\n?\s*\?/, 'the drawer screen hides it');
});

// ---------------------------------------------------------------- 11. no waiver with no wording
test('fix 11: a waiver box ticked when the mountain has no waiver wording records no waiver', async () => {
  await api('PUT', '/tenant/profile', { token: A.owner, body: { waiver_text: null } });
  const { row, order: o } = await buyPaid({ contact_email: 'nowaiver@x.test', contact_first_name: 'Nell', contact_last_name: 'Nowaiver', waiver_accepted: true, items: [{ product_id: dayP, valid_on: plus(today, 3), holder: { first_name: 'Nell', last_name: 'Nowaiver', age_group: 'adult' } }] });
  assert.equal(row.waiver_accepted, 0, 'nothing was accepted');
  assert.equal((await q('SELECT COUNT(*) AS n FROM waivers WHERE tenant_id = ? AND person_id = ?', [A.id, o.person_id]))[0].n, 0);
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'settings-apps.js'), 'utf8');
  assert.match(src, /Guests are not asked to accept a waiver online, because you have no waiver wording yet/);
  await api('PUT', '/tenant/profile', { token: A.owner, body: { waiver_text: 'I accept the risks of skiing.' } });
});

// ---------------------------------------------------------------- 12. guest type at the gate
test('fix 12: the gate scan says the guest type', async () => {
  const { order: o } = await buyPaid({ contact_email: 'gate@x.test', items: [{ product_id: dayP, valid_on: today, holder: { first_name: 'Cal', last_name: 'Child', age_group: 'child' } }] });
  const code = (await q('SELECT t.code FROM tickets t JOIN order_items i ON i.id = t.order_item_id WHERE i.order_id = ?', [o.id]))[0].code;
  const s = await api('POST', '/tickets/scan', { token: A.owner, body: { code } });
  assert.equal(s.body.result, 'ok', s.text);
  assert.equal(s.body.holder.guest_type, 'child'); assert.equal(s.body.holder.guest_type_name, 'Child');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'gate.js'), 'utf8');
  assert.match(src, /who\.guest_type_name\.toUpperCase\(\)/);
});

// ---------------------------------------------------------------- 3 and 13: the phone Sell screen, wording, public prices
test('fix 3 and 13: Sell on a phone puts the basket first and the bar above the nav; the product dialog names Settings; Military prices stay off the shop', async () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  assert.match(css, /\.sell-grid > \.sell-side \{ order: 2; \}/); assert.match(css, /\.sell-grid \.sell-orders \{ order: 3; \}/);
  assert.match(css, /\.mobile-basket-bar:not\(\[hidden\]\) \{ bottom: calc\(68px \+ env\(safe-area-inset-bottom, 0px\)\)/);
  const cat = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'catalog.js'), 'utf8');
  assert.doesNotMatch(cat, /turned on in Account/); assert.match(cat, /Settings, Online shop/);
  const page = (await pub('GET', '/shop')).body;
  const tiers = page.products.find((p) => p.id === dayP).prices.map((x) => x.tier);
  assert.ok(tiers.includes('child')); assert.ok(!tiers.includes('military'), 'Military is not sold online');
});
