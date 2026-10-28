'use strict';

// Activities: places on an attraction (a zipline tour in time slots, a skating day pass) set up in Products and prices,
// sold at the counter and online, refunded, and scanned at the attraction's gate. Capacity is claimed under a lock, the
// clerk confirms each rider's limits, an attraction that needs a waiver gets one, and a refund frees the place.
// Stripe is a mock server; the webhook is signed like the real one.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.SHOP_RATE_LIMIT = '1000';
process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const config = require('../src/config');
const stripe = require('../src/lib/stripe');
const { createApp } = require('../src/app');
const { pool, tx } = require('../src/db');
const ACT = require('../src/lib/activities');
const ACCESS = require('../src/lib/access');

let server; let base; let stripeMock; const calls = []; let n = 0;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const q = async (sql, params) => (await pool.query(sql, params))[0];
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const plus = (d, k) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const year = Number(today.slice(0, 4));
const DAY = plus(today, 2);

async function api(method, path, { token, body, headers } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', 'x-device': 'test-device-0123456789abcdef', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${r.text}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${r.text}`);
async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: `Mount ${slug}`, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const owner = (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token;
  return { slug, owner, id: (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id };
}
const webhook = async (event) => {
  const raw = JSON.stringify(event);
  const res = await fetch(`${base}/api/v1/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripe.signWebhook(raw, 'whsec_mock') }, body: raw });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const attraction = async (tenantId, name, type, extra = {}) => {
  const cols = { min_height_in: null, min_weight_lb: null, max_weight_lb: null, min_age: null, waiver_required: 1, status: 'open', ...extra };
  const [r] = await pool.query('INSERT INTO attractions (tenant_id, name, type, status, min_height_in, min_weight_lb, max_weight_lb, min_age, waiver_required) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [tenantId, name, type, cols.status, cols.min_height_in, cols.min_weight_lb, cols.max_weight_lb, cols.min_age, cols.waiver_required]);
  return r.insertId;
};
const adult = (first, extra = {}) => ({ details: { first_name: first, last_name: 'Rider', date_of_birth: '1988-05-01', sex: 'female', email: `${first.toLowerCase()}@rider.test`, ...extra } });
const placesLeft = async (token, productId, day, start) => {
  const d = ok(await api('GET', `/checkout/activity-day?date=${day}`, { token }));
  const p = d.products.find((x) => x.id === productId);
  return p.slots.find((s) => s.start === start).left;
};

let A; let B; let counter; let zip; let rink; let coaster; let zipP; let rinkP; let liftP;
test.before(async () => {
  stripeMock = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      calls.push({ path: req.url, params: Object.fromEntries(new URLSearchParams(data)), key: req.headers['idempotency-key'] });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/checkout/sessions') res.end(JSON.stringify({ id: `cs_act_${++n}`, url: `https://checkout.stripe.test/c/${n}` }));
      else if (req.url === '/v1/refunds') { const p = Object.fromEntries(new URLSearchParams(data)); res.end(JSON.stringify({ id: `re_${++n}`, payment_intent: p.payment_intent, status: 'succeeded' })); } else if (req.url.startsWith('/v1/refunds?')) res.end(JSON.stringify({ data: [] }));
      else { res.statusCode = 404; res.end('{}'); }
    });
  });
  await new Promise((r) => stripeMock.listen(0, '127.0.0.1', r));
  config.stripe.apiBase = `http://127.0.0.1:${stripeMock.address().port}`;
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`act-${suffix}`); B = await mountain(`actb-${suffix}`);
  ok(await api('POST', '/users', { token: A.owner, body: { email: `desk@${A.slug}.test`, password: PW, role: 'counter' } }));
  counter = (await api('POST', '/auth/login', { body: { tenant: A.slug, email: `desk@${A.slug}.test`, password: PW } })).body.token;
  zip = await attraction(A.id, 'Eagle Zipline', 'zipline', { min_height_in: 48, min_weight_lb: 70, max_weight_lb: 275, min_age: 7 });
  rink = await attraction(A.id, 'Village Rink', 'ice_rink', { waiver_required: 0 });
  coaster = await attraction(A.id, 'Alpine Coaster', 'coaster', { waiver_required: 0 });
  ok(await api('POST', '/tax-rules', { token: A.owner, body: { name: 'Amusement tax', applies_to: 'activity', rate_percent: 5 } }));
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => stripeMock.close(r)); await pool.end(); });

test('Products and prices: an activity names one attraction, has time slots by weekday and date range, and a day pass has none', async () => {
  const o = A.owner;
  is(await api('POST', '/products', { token: o, body: { kind: 'activity', name: 'No attraction', base_price_cents: 1000 } }), 400, 'an activity needs its attraction');
  const other = await attraction(B.id, 'Their Zip', 'zipline');
  is(await api('POST', '/products', { token: o, body: { kind: 'activity', name: 'Theirs', base_price_cents: 1000, attraction_id: other } }), 400, 'another mountain\'s attraction');
  is(await api('POST', '/products', { token: o, body: { kind: 'day_ticket', name: 'Odd', base_price_cents: 1000, attraction_id: zip } }), 400, 'only an activity links to an attraction');
  zipP = ok(await api('POST', '/products', { token: o, body: { kind: 'activity', name: 'Zip tour', base_price_cents: 8900, attraction_id: zip, timed: 1, online: 1 } })).id;
  ok(await api('PUT', `/products/${zipP}/tiers`, { token: o, body: { tiers: [{ tier: 'child', price_cents: 6900 }] } }));
  // every day from today, 10:00 and 11:00, one hour, 2 places; a weekend-only 14:00 that a later correction moves to 15:00
  const s1 = ok(await api('POST', `/products/${zipP}/schedules`, { token: o, body: { starts_on: today, start_times: ['11:00', '10:00', '10:00'], slot_minutes: 60, capacity: 2 } }));
  assert.deepEqual(s1.start_times, ['10:00', '11:00'], 'sorted, no repeats');
  is(await api('POST', `/products/${zipP}/schedules`, { token: o, body: { starts_on: today, ends_on: plus(today, -1), start_times: ['09:00'], slot_minutes: 60, capacity: 2 } }), 400, 'the last day is before the first');
  is(await api('POST', `/products/${zipP}/schedules`, { token: o, body: { starts_on: today, start_times: ['25:00'], slot_minutes: 60, capacity: 2 } }), 400, 'not a time');
  is(await api('POST', `/products/${zipP}/schedules`, { token: counter, body: { starts_on: today, start_times: ['09:00'], slot_minutes: 60, capacity: 2 } }), 403, 'managers set slots');
  const s2 = ok(await api('POST', `/products/${zipP}/schedules`, { token: o, body: { days: 65, starts_on: today, start_times: ['14:00'], slot_minutes: 90, capacity: 8 } }));
  ok(await api('PATCH', `/products/${zipP}/schedules/${s2.id}`, { token: o, body: { start_times: ['15:00'] } }));
  const setup = ok(await api('GET', `/products/${zipP}/activity`, { token: o }));
  assert.equal(setup.timed, true); assert.equal(setup.attraction_id, zip); assert.equal(setup.schedules.length, 2);
  assert.deepEqual(setup.schedules[1].start_times, ['15:00']);
  // Saturday: three slots (the weekend one ends at 16:30); a weekday: two
  let sat = today; while (new Date(`${sat}T12:00:00Z`).getUTCDay() !== 6) sat = plus(sat, 1);
  assert.deepEqual((await ACT.slotsOn(pool, A.id, zipP, sat)).map((x) => `${x.start}-${x.end}`), ['10:00-11:00', '11:00-12:00', '15:00-16:30']);
  let wed = today; while (new Date(`${wed}T12:00:00Z`).getUTCDay() !== 3) wed = plus(wed, 1);
  assert.equal((await ACT.slotsOn(pool, A.id, zipP, wed)).length, 2);
  ok(await api('DELETE', `/products/${zipP}/schedules/${s2.id}`, { token: o }));
  assert.equal((await ACT.slotsOn(pool, A.id, zipP, sat)).length, 2, 'slots taken off sale');
  // a day pass: no slots, at most 3 skaters a day
  rinkP = ok(await api('POST', '/products', { token: o, body: { kind: 'activity', name: 'Skate all day', base_price_cents: 1200, attraction_id: rink, timed: 0, day_capacity: 3, online: 1 } })).id;
  is(await api('POST', `/products/${rinkP}/schedules`, { token: o, body: { starts_on: today, start_times: ['10:00'], slot_minutes: 60, capacity: 2 } }), 201, 'a schedule can be kept, but a day pass ignores it');
  ok(await api('PATCH', `/products/${rinkP}`, { token: o, body: { timed: 0 } }));
  // a lift ticket that includes the coaster
  liftP = ok(await api('POST', '/products', { token: o, body: { kind: 'day_ticket', name: 'Summer pass day', base_price_cents: 5000 } })).id;
  ok(await api('PUT', `/products/${liftP}/includes`, { token: o, body: { attraction_ids: [coaster] } }));
  is(await api('PUT', `/products/${zipP}/includes`, { token: o, body: { attraction_ids: [coaster] } }), 400, 'an activity is for its own attraction');
  assert.deepEqual(ok(await api('GET', `/products/${liftP}/activity`, { token: o })).includes, [coaster]);
  const opts = ok(await api('GET', '/products/activity-options', { token: o })).attractions;
  assert.equal(opts.find((x) => x.id === zip).limits_text, 'Riders must be at least 48 inches tall, weigh 70 to 275 pounds, and be 7 or older.');
  // a blackout day is not sold, like any product
  ok(await api('PUT', `/products/${zipP}/calendar`, { token: o, body: { entries: [{ on_date: plus(today, 9), blackout: true }] } }));
});

test('counter: the menu lists activities by attraction, and a day shows each slot with places left', async () => {
  const menu = ok(await api('GET', '/checkout/menu', { token: counter }));
  assert.deepEqual(menu.activities.map((g) => g.attraction.name).sort(), ['Eagle Zipline', 'Village Rink']);
  const z = menu.activities.find((g) => g.attraction.id === zip);
  assert.equal(z.attraction.has_limits, true); assert.equal(z.attraction.waiver_required, true);
  assert.equal(z.products[0].tiers.child, 6900);
  const d = ok(await api('GET', `/checkout/activity-day?date=${DAY}`, { token: counter }));
  const zp = d.products.find((p) => p.id === zipP);
  assert.deepEqual(zp.slots.map((s) => [s.start, s.left, s.label]), [['10:00', 2, '10:00 AM to 11:00 AM'], ['11:00', 2, '11:00 AM to 12:00 PM']]);
  assert.equal(d.products.find((p) => p.id === rinkP).slots[0].left, 3);
  assert.equal(ok(await api('GET', `/checkout/activity-day?date=${plus(today, 9)}`, { token: counter })).products.find((p) => p.id === zipP).closed, true, 'blacked out');
  is(await api('GET', `/checkout/activity-day?date=${plus(today, -1)}`, { token: counter }), 400);
  assert.equal(ok(await api('GET', '/checkout/menu', { token: B.owner })).activities.length, 0, 'another mountain sees none');
});

test('counter: each rider\'s limits must be confirmed, an under-age rider is refused, and the waiver is signed at the counter', async () => {
  const line = (extra = {}) => ({ type: 'activity', product_id: zipP, valid_on: DAY, start_time: '10:00', ...extra });
  const noLimits = await api('POST', '/checkout', { token: counter, body: { customer: adult('Lia'), lines: [line()], payments: [{ tender: 'cash', amount_cents: 9345 }] } });
  is(noLimits, 400); assert.match(noLimits.body.error, /meets the limits for Eagle Zipline\. Riders must be at least 48 inches tall/);
  is(await api('POST', '/checkout', { token: counter, body: { customer: adult('Lia'), lines: [line({ limits_ok: true })], payments: [{ tender: 'cash', amount_cents: 9345 }] } }), 409, 'no waiver on file');
  const kid = await api('POST', '/checkout', { token: counter, body: { customer: adult('Pat'), participants: { k: { details: { first_name: 'Tot', last_name: 'Rider', date_of_birth: `${year - 5}-01-01`, sex: 'male' }, sign_waiver: true } }, lines: [line({ limits_ok: true, participant: 'k', tier: 'child' })], payments: [{ tender: 'cash', amount_cents: 7245 }] } });
  is(kid, 409); assert.match(kid.body.error, /Tot Rider is \d\. Eagle Zipline riders must be 7 or older/);
  is(await api('POST', '/checkout', { token: counter, body: { customer: adult('Lia'), lines: [line({ start_time: '12:30', limits_ok: true })], payments: [] } }), 409, 'not one of its slots');
  is(await api('POST', '/checkout', { token: counter, body: { customer: adult('Lia'), lines: [line({ start_time: undefined, limits_ok: true })], payments: [] } }), 400, 'a timed activity needs its slot');
  const qt = ok(await api('POST', '/checkout/quote', { token: counter, body: { lines: [line()] } }));
  assert.equal(qt.total_cents, 9345, '$89 plus 5% amusement tax');
  const sold = await api('POST', '/checkout', { token: counter, body: { customer: { ...adult('Lia'), sign_waiver: true }, lines: [line({ limits_ok: true })], payments: [{ tender: 'cash', amount_cents: 9345 }] } });
  is(sold, 201);
  assert.equal(sold.body.tickets.length, 1, 'one ticket per guest');
  assert.match(sold.body.tickets[0].product, /Zip tour, 10:00 AM to 11:00 AM/);
  assert.equal(sold.body.activities[0].attraction, 'Eagle Zipline');
  const [tk] = await q('SELECT t.uses_remaining, t.valid_from, t.valid_to, b.start_time, b.limits_ok_by, b.channel, i.line_kind, i.tax_cents FROM tickets t JOIN activity_bookings b ON b.ticket_id = t.id AND b.tenant_id = t.tenant_id JOIN order_items i ON i.id = t.order_item_id AND i.tenant_id = t.tenant_id WHERE t.tenant_id = ? AND t.code = ?', [A.id, sold.body.tickets[0].code]);
  assert.equal(tk.uses_remaining, 1); assert.equal(tk.valid_from, DAY); assert.equal(tk.valid_to, DAY); assert.equal(tk.start_time, '10:00:00');
  assert.ok(tk.limits_ok_by, 'who confirmed the limits is kept'); assert.equal(tk.line_kind, 'activity'); assert.equal(tk.tax_cents, 445);
  assert.equal((await q("SELECT COUNT(*) AS n FROM waivers w JOIN people p ON p.id = w.person_id WHERE w.tenant_id = ? AND p.first_name = 'Lia'", [A.id]))[0].n, 1, 'the waiver was recorded');
  assert.equal(await placesLeft(counter, zipP, DAY, '10:00'), 1);
  // no limits, no waiver: a skating day pass needs neither
  is(await api('POST', '/checkout', { token: counter, body: { customer: adult('Sky'), lines: [{ type: 'activity', product_id: rinkP, valid_on: DAY }], payments: [{ tender: 'cash', amount_cents: 1260 }] } }), 201);
  is(await api('POST', '/checkout', { token: counter, body: { customer: adult('Sky'), lines: [{ type: 'activity', product_id: rinkP, valid_on: DAY, start_time: '10:00' }], payments: [] } }), 400, 'a day pass has no slot');
  is(await api('POST', '/checkout', { token: counter, body: { quick: true, lines: [{ type: 'activity', product_id: rinkP, valid_on: DAY }], payments: [{ tender: 'cash', amount_cents: 1260 }] } }), 400, 'an activity is never a quick sale');
});

test('counter: two sales at once for the last place: one sells, the other is told it is full', async () => {
  assert.equal(await placesLeft(counter, zipP, DAY, '10:00'), 1);
  const body = (who) => ({ customer: { ...adult(who), sign_waiver: true }, lines: [{ type: 'activity', product_id: zipP, valid_on: DAY, start_time: '10:00', limits_ok: true }], payments: [{ tender: 'cash', amount_cents: 9345 }] });
  const [r1, r2] = await Promise.all([api('POST', '/checkout', { token: counter, body: body('Ana') }), api('POST', '/checkout', { token: A.owner, body: body('Bea') })]);
  assert.deepEqual([r1.status, r2.status].sort(), [201, 409], `${r1.text} ${r2.text}`);
  assert.match((r1.status === 409 ? r1 : r2).body.error, /Zip tour is full for the 10:00 AM slot/);
  assert.equal(await placesLeft(counter, zipP, DAY, '10:00'), 0);
  assert.equal((await q("SELECT COUNT(*) AS n FROM activity_bookings WHERE tenant_id = ? AND product_id = ? AND on_date = ? AND start_time = '10:00:00' AND status = 'booked'", [A.id, zipP, DAY]))[0].n, 2, 'never oversold');
  // two guests in one basket for one place left: refused as a whole
  const two = await api('POST', '/checkout', { token: counter, body: { customer: adult('Cal'), lines: [{ type: 'activity', product_id: rinkP, valid_on: DAY }, { type: 'activity', product_id: rinkP, valid_on: DAY }, { type: 'activity', product_id: rinkP, valid_on: DAY }], payments: [{ tender: 'cash', amount_cents: 3780 }] } });
  is(two, 409); assert.match(two.body.error, /Skate all day has only 2 places left|Skate all day is full/);
});

test('a refund frees the place, and a used activity ticket cannot be refunded', async () => {
  const [o] = await q("SELECT i.order_id FROM activity_bookings b JOIN order_items i ON i.id = b.order_item_id AND i.tenant_id = b.tenant_id WHERE b.tenant_id = ? AND b.product_id = ? AND b.start_time = '10:00:00' AND b.status = 'booked' ORDER BY b.id DESC LIMIT 1", [A.id, zipP]);
  const r = ok(await api('POST', `/orders/${o.order_id}/refund`, { token: A.owner, body: { reason: 'weather' } }));
  assert.equal(r.amount_cents, 9345);
  assert.equal(await placesLeft(counter, zipP, DAY, '10:00'), 1, 'the place is back on sale');
  assert.equal((await q("SELECT t.status FROM tickets t JOIN order_items i ON i.id = t.order_item_id AND i.tenant_id = t.tenant_id WHERE t.tenant_id = ? AND i.order_id = ?", [A.id, o.order_id]))[0].status, 'void');
});

test('online: activities by attraction, date then slot with places left, limits shown and confirmed, a hold, the webhook, and the waiver link', async () => {
  ok(await api('PUT', '/tenant/profile', { token: A.owner, body: { online_shop: true } }));
  const pub = (m, p, o) => api(m, `/public/${A.slug}${p}`, o);
  const page = ok(await pub('GET', '/shop'));
  const zg = page.activities.find((g) => g.attraction.id === zip);
  assert.equal(zg.attraction.limits_text, 'Riders must be at least 48 inches tall, weigh 70 to 275 pounds, and be 7 or older.');
  const day = ok(await pub('GET', `/shop/activities?attraction_id=${zip}&date=${DAY}`));
  assert.deepEqual(day.products[0].slots.map((s) => [s.start, s.left]), [['10:00', 1], ['11:00', 2]]);
  assert.ok(day.products[0].prices.some((x) => x.tier === 'child' && x.price_cents === 6900));
  const blackout = ok(await pub('GET', `/shop/activities?attraction_id=${zip}&date=${plus(today, 9)}`)).products[0];
  assert.equal(blackout.available, false);
  const holder = { first_name: 'Ona', last_name: 'Line', date_of_birth: `${year - 30}-02-02` };
  const basket = { activities: [{ product_id: zipP, valid_on: DAY, start_time: '10:00', holder }] };
  const qt = ok(await pub('POST', '/shop/quote', { body: basket }));
  assert.equal(qt.total_cents, 9345); assert.equal(qt.activities[0].start_time, '10:00');
  const order = { contact_first_name: 'Ona', contact_last_name: 'Line', contact_email: 'ona@x.test', contact_phone: '215-555-0101', terms_accepted: true, ...basket };
  is(await pub('POST', '/shop/orders', { body: order }), 400, 'the limits must be confirmed');
  const placed = await pub('POST', '/shop/orders', { body: { ...order, limits_accepted: true } });
  is(placed, 201);
  const sess = calls.filter((c) => c.path === '/v1/checkout/sessions').pop();
  assert.match(sess.params['line_items[0][price_data][product_data][description]'] || JSON.stringify(sess.params), /Zip tour/);
  // the basket on the card page holds the last 10:00 place: the counter cannot sell it, and a second basket cannot either
  assert.equal(await placesLeft(counter, zipP, DAY, '10:00'), 0);
  is(await api('POST', '/checkout', { token: counter, body: { customer: { ...adult('Dee'), sign_waiver: true }, lines: [{ type: 'activity', product_id: zipP, valid_on: DAY, start_time: '10:00', limits_ok: true }], payments: [{ tender: 'cash', amount_cents: 9345 }] } }), 409);
  is(await pub('POST', '/shop/orders', { body: { ...order, contact_email: 'two@x.test', limits_accepted: true } }), 409);
  // paid
  const [row] = await q('SELECT * FROM shop_orders WHERE tenant_id = ? AND reference = ?', [A.id, placed.body.reference]);
  const ev = { id: `evt_${++n}`, type: 'checkout.session.completed', data: { object: { id: row.stripe_session_id, payment_status: 'paid', amount_total: row.amount_cents, payment_intent: `pi_${row.stripe_session_id}`, metadata: { tenant_id: String(A.id), request_id: String(row.id), shop_order_id: String(row.id), kind: 'shop' } } } };
  is(await webhook(ev), 200);
  is(await webhook(ev), 200, 'a repeat changes nothing');
  assert.equal((await q("SELECT COUNT(*) AS n FROM activity_bookings WHERE tenant_id = ? AND channel = 'online' AND status = 'booked'", [A.id]))[0].n, 1);
  assert.equal(await placesLeft(counter, zipP, DAY, '10:00'), 0, 'the hold became a booking, counted once');
  const view = ok(await pub('GET', `/shop/orders/${row.view_token}`));
  assert.equal(view.tickets[0].start_time, '10:00'); assert.equal(view.tickets[0].attraction, 'Eagle Zipline');
  assert.deepEqual(view.waiver_needed, ['Ona Line'], 'no waiver accepted online, and the zipline needs one');
  assert.match(view.waiver_link, new RegExp(`/waiver/${A.slug}$`));
  // a refund of the online order frees the place (the card refund goes through Stripe after the books are written)
  const [paid] = await q('SELECT order_id FROM shop_orders WHERE id = ?', [row.id]);
  const r = ok(await api('POST', `/orders/${paid.order_id}/refund`, { token: A.owner, body: { reason: 'customer_request' } }));
  assert.equal(r.card_refunded, true);
  const refundCall = calls.filter((c) => c.path === '/v1/refunds').pop();
  assert.match(refundCall.key, /^card-refund-/, 'an idempotency key per refund row');
  assert.equal(await placesLeft(counter, zipP, DAY, '10:00'), 1);
  // a guest who comes back from the card page without paying lets their places go at once
  const again = ok(await pub('POST', '/shop/orders', { body: { ...order, contact_email: 'back@x.test', limits_accepted: true } }));
  assert.equal(await placesLeft(counter, zipP, DAY, '10:00'), 0);
  const [held] = await q('SELECT view_token FROM shop_orders WHERE tenant_id = ? AND reference = ?', [A.id, again.reference]);
  ok(await pub('POST', `/shop/orders/${held.view_token}/abandon`));
  assert.equal(await placesLeft(counter, zipP, DAY, '10:00'), 1);
  assert.equal(calls.filter((c) => c.path === '/v1/checkout/sessions').every((c) => /^checkout-shop-\d+-\d+$/.test(c.key)), true, 'each card page has its own idempotency key');
});

test('gate: an activity ticket scans only at its attraction, on its day, in its slot window, once', async () => {
  // the attraction's gate device
  const d = ok(await api('POST', '/access/devices', { token: A.owner, body: { name: 'Rink gate', attraction_id: rink } }));
  is(await api('POST', '/access/devices', { token: A.owner, body: { name: 'Bad', attraction_id: 999999 } }), 400);
  const H = { authorization: `Device ${ok(await api('POST', '/device/pair', { body: { code: d.code } })).token}` };
  const lift = ok(await api('POST', '/access/devices', { token: A.owner, body: { name: 'Chair gate' } }));
  const L = { authorization: `Device ${ok(await api('POST', '/device/pair', { body: { code: lift.code } })).token}` };
  const devices = ok(await api('GET', '/access/devices', { token: A.owner }));
  assert.equal(devices.data.find((x) => x.id === d.id).attraction, 'Village Rink');
  assert.ok(devices.attractions.some((a) => a.id === zip));
  // a skating day pass for today
  const sold = ok(await api('POST', '/checkout', { token: counter, body: { customer: adult('Ice'), lines: [{ type: 'activity', product_id: rinkP }], payments: [{ tender: 'cash', amount_cents: 1260 }] } }));
  const code = sold.tickets[0].code;
  const list = ok(await api('GET', '/device/list', { headers: H }));
  const key = list.code_hash.key;
  assert.ok(list.items.some((i) => i.code_hash === ACCESS.codeHash(key, code)), 'on the rink gate\'s offline list');
  const liftList = ok(await api('GET', '/device/list', { headers: L }));
  assert.ok(!liftList.items.some((i) => i.code_hash === ACCESS.codeHash(liftList.code_hash.key, code)), 'not on a lift gate\'s list');
  const atLift = ok(await api('POST', '/device/check', { headers: L, body: { code } }));
  assert.equal(atLift.allow, false); assert.equal(atLift.result, 'wrong_place'); assert.match(atLift.reason, /This ticket is for Village Rink\. Scan it at Village Rink/);
  const desk = ok(await api('POST', '/tickets/scan', { token: counter, body: { code, attraction_id: coaster } }));
  assert.equal(desk.result, 'wrong_place'); assert.match(desk.reason, /for Village Rink, not Alpine Coaster/);
  const inn = ok(await api('POST', '/device/check', { headers: H, body: { code } }));
  assert.equal(inn.allow, true, JSON.stringify(inn));
  const again = ok(await api('POST', '/device/check', { headers: H, body: { code } }));
  assert.equal(again.allow, false); assert.equal(again.result, 'no_uses'); assert.match(again.reason, /Already used/);
  is(await api('POST', `/orders/${sold.id}/refund`, { token: A.owner, body: { reason: 'customer_request' } }), 409, 'a used activity ticket is not refunded here');
  // a timed ticket on another day is not good today
  const zipCode = (await q("SELECT t.code FROM tickets t JOIN activity_bookings b ON b.ticket_id = t.id AND b.tenant_id = t.tenant_id WHERE t.tenant_id = ? AND b.product_id = ? AND b.status = 'booked' LIMIT 1", [A.id, zipP]))[0].code;
  assert.equal(ok(await api('POST', '/tickets/scan', { token: counter, body: { code: zipCode, attraction_id: zip } })).result, 'not_yet_valid');
  // a lift ticket at an attraction: only when its product includes it
  const liftTicket = ok(await api('POST', '/orders', { token: A.owner, body: { items: [{ product_id: liftP }] } })).tickets[0].code;
  const plain = ok(await api('POST', '/products', { token: A.owner, body: { kind: 'day_ticket', name: 'Plain day', base_price_cents: 4000 } })).id;
  const plainTicket = ok(await api('POST', '/orders', { token: A.owner, body: { items: [{ product_id: plain }] } })).tickets[0].code;
  const notInc = ok(await api('POST', '/tickets/scan', { token: counter, body: { code: plainTicket, attraction_id: coaster } }));
  assert.equal(notInc.result, 'not_included'); assert.match(notInc.reason, /Plain day does not include Alpine Coaster/);
  assert.equal(ok(await api('POST', '/tickets/scan', { token: counter, body: { code: liftTicket, attraction_id: coaster } })).result, 'ok');
  assert.equal(ok(await api('POST', '/tickets/scan', { token: counter, body: { code: plainTicket } })).result, 'ok', 'a lift ticket at a lift as before');
  assert.equal(ok(await api('GET', '/tickets/scan-places', { token: counter })).attractions.length, 3);
});

test('gate: the slot window opens 15 minutes before the start and closes at its end', async () => {
  const sold = ok(await api('POST', '/checkout', { token: counter, body: { customer: { ...adult('Win'), sign_waiver: true }, lines: [{ type: 'activity', product_id: zipP, valid_on: DAY, start_time: '11:00', limits_ok: true }], payments: [{ tender: 'cash', amount_cents: 9345 }] } }));
  const [b] = await q('SELECT t.id AS ticket_id FROM tickets t WHERE t.tenant_id = ? AND t.code = ?', [A.id, sold.tickets[0].code]);
  const [ticket] = await q('SELECT * FROM tickets WHERE tenant_id = ? AND id = ?', [A.id, b.ticket_id]);
  const at = (hm) => tx((conn) => ACT.gateRule(conn, A.id, ticket, zip, `${DAY} ${hm}:00`));
  const early = await at('10:44');
  assert.equal(early.result, 'too_early'); assert.equal(early.reason, 'Too early. This ticket is for the 11:00 AM slot. Come back at 10:45 AM.');
  assert.equal(await at('10:45'), null, '15 minutes before');
  assert.equal(await at('12:00'), null, 'up to the end');
  const late = await at('12:01');
  assert.equal(late.result, 'too_late'); assert.match(late.reason, /The 11:00 AM slot ended at 12:00 PM/);
  assert.equal((await tx((conn) => ACT.gateRule(conn, A.id, ticket, rink, `${DAY} 11:00:00`))).result, 'wrong_place');
});

test('reports: activity sales show by attraction in the weekly report, and by kind', async () => {
  const w = ok(await api('GET', `/reports/weekly?week=${today}`, { token: A.owner }));
  const z = (w.attractions || []).find((x) => x.name === 'Eagle Zipline');
  assert.ok(z && z.units >= 1 && z.cents > 0, JSON.stringify(w.attractions));
  assert.ok(w.types.some((t) => t.kind === 'activity'));
});
