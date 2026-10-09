'use strict';

// The unified basket: tickets, lessons, rentals, programs and gift cards sold together, customer details added at the
// end, paid by cash, card or gift card (or a split), and refunded as one order.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server;
let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  return { slug, owner: (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token };
}
async function addUser(m, email, role, extra = {}) {
  assert.equal((await api('POST', '/users', { token: m.owner, body: { email, password: PW, role, ...extra } })).status, 201);
  return (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token;
}

let A; let B; const T = {}; const D = {};
const addDays = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const q = async (sql, params) => (await pool.query(sql, params))[0];
// Every person sold something needs a name, date of birth and sex (adults also a phone or email). Tests give grown-up defaults.
const withDefaults = (d) => (d && d.details ? { ...d, details: { date_of_birth: '1985-03-02', sex: 'female', ...d.details } } : d);
const WALKIN = { details: { first_name: 'Walk', last_name: 'In', email: 'walkin@x.test' } };
const fill = (body) => ({ ...body, customer: withDefaults(body.customer || WALKIN), participants: body.participants ? Object.fromEntries(Object.entries(body.participants).map(([k, v]) => [k, withDefaults(v)])) : undefined });
const sell = (token, body) => api('POST', '/checkout', { token, body: fill(body) });
const sellRaw = (token, body) => api('POST', '/checkout', { token, body });
const count = async (table, tenantSlug) => (await q(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = (SELECT id FROM tenants WHERE slug = ?)`, [tenantSlug]))[0].n;

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`ca-${suffix}`);
  B = await mountain(`cb-${suffix}`);
  const instructor = (await api('POST', '/workforce/staff', { token: A.owner, body: { person: { first_name: 'Ivy', last_name: 'Instructor' }, status: 'active' } })).body.id;
  T.counter = await addUser(A, `counter@${A.slug}.test`, 'counter');
  T.patrol = await addUser(A, `patrol@${A.slug}.test`, 'patrol');
  T.instructor = await addUser(A, `inst@${A.slug}.test`, 'instructor');
  const o = A.owner;
  const prod = async (body) => (await api('POST', '/products', { token: o, body })).body.id;
  D.day = await prod({ kind: 'day_ticket', name: 'Adult Day', base_price_cents: 6000 });
  D.lessonProd = await prod({ kind: 'lesson', name: 'Group Lesson', base_price_cents: 5000 });
  D.rentalProd = await prod({ kind: 'rental', name: 'Ski Package', base_price_cents: 4500 });
  D.vouch = await prod({ kind: 'voucher', name: 'Old voucher', base_price_cents: 2000 });
  const when = (n, h) => `${addDays(today, n)}T${h}`;
  const sess = async (cap, n = 1, hour = '10:00', end = '12:00', coach = instructor) => (await api('POST', '/skischool/sessions', { token: o, body: { product_id: D.lessonProd, starts_at: when(n, hour), ends_at: when(n, end), capacity: cap, ...(coach ? { instructor_id: coach } : {}) } })).body.id;
  D.lesson = await sess(4);
  D.tiny = await sess(1, 1, '13:00', '15:00', null);
  D.prog = (await api('POST', '/programs', { token: o, body: { name: 'Junior Race Team', kind: 'race_team', season: '2026-27', capacity: 2, price_cents: 45000 } })).body.id;
  const gear = async (sku, category) => (await api('POST', '/rentals/items', { token: o, body: { sku, category, size: '150' } })).body.id;
  D.ski = await gear('CK-SKI', 'ski'); D.boot = await gear('CK-BOOT', 'boot'); D.ski2 = await gear('CK-SKI2', 'ski'); D.boot2 = await gear('CK-BOOT2', 'boot');
  await api('POST', '/pricing/promos', { token: o, body: { code: 'TEN', percent_off: 10 } });
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

const parent = { first_name: 'Pat', last_name: 'Parent', email: 'pat@parent.test', phone: '(610) 555-0170' };
const kid = { first_name: 'Kay', last_name: 'Parent', date_of_birth: '2016-03-04' };

test('the menu lists what can be sold today with spots left and stock', async () => {
  const m = await api('GET', '/checkout/menu', { token: T.counter });
  assert.equal(m.status, 200);
  assert.deepEqual(m.body.tickets.map((t) => t.name), ['Adult Day'], 'vouchers are not shown as tickets');
  assert.equal(m.body.rentals[0].name, 'Ski Package');
  assert.equal(m.body.lessons.find((l) => l.id === D.lesson).spots_left, 4);
  assert.equal(m.body.programs[0].spots_left, 2);
  assert.equal(m.body.stock.ski, 2);
  assert.equal(m.body.gift_card.min_cents, 500);
  assert.equal((await api('GET', '/checkout/menu', { token: T.patrol })).status, 403);
});

test('a quote prices every kind of line, and gift cards are not discounted', async () => {
  const r = await api('POST', '/checkout/quote', { token: T.counter, body: { promo_code: 'TEN', lines: [
    { type: 'ticket', product_id: D.day, quantity: 2 }, { type: 'lesson', session_id: D.lesson }, { type: 'rental', product_id: D.rentalProd },
    { type: 'program', program_id: D.prog }, { type: 'gift_card', amount_cents: 5000 }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.subtotal_cents, 12000 + 5000 + 4500 + 45000 + 5000);
  assert.equal(r.body.discount_cents, Math.floor(66500 * 0.1), 'ten percent of everything except the gift card');
  assert.equal(r.body.total_cents, 71500 - 6650);
  assert.equal((await api('POST', '/checkout/quote', { token: T.counter, body: { lines: [{ type: 'rental', product_id: D.day }] } })).status, 400, 'a day ticket is not a rental package');
  assert.equal((await api('POST', '/checkout/quote', { token: T.counter, body: { lines: [{ type: 'gift_card', amount_cents: 100 }] } })).status, 400, 'below the minimum');
});

test('one basket: tickets, a child\'s lesson, a rental, a program place and a gift card, paid in cash', async () => {
  const res = await sell(T.counter, {
    customer: { details: parent },
    participants: { kid: { details: kid, sign_waiver: true } },
    lines: [
      { type: 'ticket', product_id: D.day, quantity: 2 },
      { type: 'lesson', session_id: D.lesson, participant: 'kid' },
      { type: 'rental', product_id: D.rentalProd, participant: 'kid', items: [{ rental_item_id: D.ski, din_setting: 5 }, { rental_item_id: D.boot }] },
      { type: 'program', program_id: D.prog, participant: 'kid' },
      { type: 'gift_card', amount_cents: 5000, recipient_name: 'Grandma' },
    ],
    payments: [{ tender: 'cash', amount_cents: 71500, tendered_cents: 80000 }],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const b = res.body;
  assert.equal(b.total_cents, 71500);
  assert.equal(b.change_due_cents, 8500);
  assert.equal(b.tickets.length, 2);
  assert.ok(b.tickets.every((t) => t.holder), 'every ticket is named');
  assert.equal(b.lessons.length, 1); assert.equal(b.rentals.length, 1); assert.equal(b.programs.length, 1);
  assert.equal(b.gift_cards[0].amount_cents, 5000);
  assert.equal(b.customer.created, true);
  D.order = b.id; D.giftCode = b.gift_cards[0].code;

  // the customers were saved to the shared record, and the parent is the guardian on the program place
  const people = await q('SELECT id, first_name FROM people WHERE tenant_id = (SELECT id FROM tenants WHERE slug = ?) AND last_name = ?', [A.slug, 'Parent']);
  assert.equal(people.length, 2);
  const parentId = b.person_id;
  const kidId = b.lessons[0].person_id;
  assert.notEqual(parentId, kidId);
  const enrol = (await q('SELECT * FROM program_enrollments WHERE person_id = ?', [kidId]))[0];
  assert.equal(enrol.guardian_id, parentId); assert.equal(enrol.paid_cents, 45000); assert.equal(enrol.status, 'enrolled');
  assert.equal((await q('SELECT COUNT(*) AS n FROM waivers WHERE person_id = ?', [kidId]))[0].n, 1, 'the waiver was signed once for the child');
  assert.equal((await q('SELECT status FROM rental_items WHERE id = ?', [D.ski]))[0].status, 'rented');
  assert.equal((await q('SELECT person_id FROM rental_contracts WHERE order_id = ?', [b.id]))[0].person_id, kidId);
  assert.equal((await q('SELECT COUNT(*) AS n FROM tickets WHERE person_id = ?', [parentId]))[0].n, 2);
  const card = (await q('SELECT * FROM gift_cards WHERE code = ?', [D.giftCode]))[0];
  assert.equal(card.balance_cents, 5000); assert.equal(card.purchaser_id, parentId);
  const pays = await q('SELECT tender, amount_cents, tendered_cents FROM order_payments WHERE order_id = ?', [b.id]);
  assert.deepEqual(pays.map((p) => [p.tender, p.amount_cents, p.tendered_cents]), [['cash', 71500, 80000]]);

  // the order can be read back as one list of lines
  const o = (await api('GET', `/orders/${b.id}`, { token: T.counter })).body;
  assert.deepEqual(o.lines.map((l) => l.line_kind), ['ticket', 'ticket', 'lesson', 'rental', 'program', 'gift_card']);
  assert.equal(o.payments[0].tender, 'cash');
  assert.equal(o.gift_cards[0].code, D.giftCode);
});

test('the same customer is found again at the counter by phone, and not duplicated', async () => {
  const hit = await api('GET', '/people/lookup?q=610-555-0170', { token: T.counter });
  assert.equal(hit.body.data.length, 1);
  assert.equal(hit.body.data[0].summary.rental_out, false, 'the gear belongs to the child, not the parent');
  const again = await sell(T.counter, { customer: { person_id: hit.body.data[0].id }, lines: [{ type: 'ticket', product_id: D.day }], payments: [{ tender: 'card', amount_cents: 6000, reference: 'AUTH-1' }] });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(again.body.customer.created, false);
});

test('a basket that cannot be completed saves nothing, not even the new customer', async () => {
  const before = { orders: await count('orders', A.slug), tickets: await count('tickets', A.slug), people: await count('people', A.slug), items: await q('SELECT status FROM rental_items WHERE id = ?', [D.ski2]) };
  const used = (await q("SELECT used_count FROM promo_codes WHERE code = 'TEN' AND tenant_id = (SELECT id FROM tenants WHERE slug = ?)", [A.slug]))[0].used_count;
  // the renter has no waiver and nobody signs one at the counter: this fails after the ticket was already written
  const res = await sell(T.counter, {
    customer: { details: { first_name: 'Una', last_name: 'Unwaived', email: 'una@x.test' } }, promo_code: 'TEN',
    lines: [{ type: 'ticket', product_id: D.day }, { type: 'rental', product_id: D.rentalProd, items: [{ rental_item_id: D.ski2 }] }],
    payments: [{ tender: 'cash', amount_cents: 10500 - 1050 }],
  });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.error, /waiver/i);
  assert.equal(await count('orders', A.slug), before.orders);
  assert.equal(await count('tickets', A.slug), before.tickets);
  assert.equal(await count('people', A.slug), before.people, 'the customer was rolled back with everything else');
  assert.equal((await q('SELECT status FROM rental_items WHERE id = ?', [D.ski2]))[0].status, before.items[0].status);
  assert.equal((await q("SELECT used_count FROM promo_codes WHERE code = 'TEN' AND tenant_id = (SELECT id FROM tenants WHERE slug = ?)", [A.slug]))[0].used_count, used, 'the promo was not used up');
  // the same basket goes through once the waiver is signed at the counter
  const ok = await sell(T.counter, {
    customer: { details: { first_name: 'Una', last_name: 'Unwaived', email: 'una@x.test' }, sign_waiver: true }, promo_code: 'TEN',
    lines: [{ type: 'ticket', product_id: D.day }, { type: 'rental', product_id: D.rentalProd, items: [{ rental_item_id: D.ski2 }] }],
    payments: [{ tender: 'cash', amount_cents: 10500 - 1050 }],
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  D.unaOrder = ok.body.id;
});

test('capacity, duplicates and gear already out are refused', async () => {
  const one = (extra = {}) => sell(T.counter, { customer: { details: { first_name: 'Cap', last_name: 'Test', email: `cap${Math.random()}@x.test`, ...extra }, sign_waiver: true }, lines: [{ type: 'lesson', session_id: D.tiny }], payments: [{ tender: 'cash', amount_cents: 5000 }] });
  const first = await one();
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const full = await one();
  assert.equal(full.status, 409); assert.match(full.body.error, /full/);
  assert.equal((await sell(T.counter, { customer: { details: { first_name: 'Gear', last_name: 'Thief', email: 'g@x.test' }, sign_waiver: true }, lines: [{ type: 'rental', product_id: D.rentalProd, items: [{ rental_item_id: D.ski }] }], payments: [{ tender: 'cash', amount_cents: 4500 }] })).status, 409, 'gear that is already rented');
  const prog = (n) => sell(T.counter, { customer: { details: { first_name: `P${n}`, last_name: 'Kid', email: `p${n}@x.test` } }, lines: [{ type: 'program', program_id: D.prog }], payments: [{ tender: 'cash', amount_cents: 45000 }] });
  assert.equal((await prog(1)).status, 201);
  assert.equal((await prog(2)).status, 409, 'the program is full (the child from the big basket has the first place)');
});

test('every item sold needs a named person: the customer is always required, and tickets are named one by one', async () => {
  const cash = (n) => [{ tender: 'cash', amount_cents: n }];
  assert.equal((await sellRaw(T.counter, { lines: [{ type: 'ticket', product_id: D.day }], payments: cash(6000) })).status, 400, 'a ticket with no customer');
  assert.equal((await sellRaw(T.counter, { lines: [{ type: 'lesson', session_id: D.lesson }], payments: cash(5000) })).status, 400, 'a lesson with no customer');
  assert.equal((await sellRaw(T.counter, { lines: [{ type: 'gift_card', amount_cents: 2500 }], payments: cash(2500) })).status, 400, 'a gift card needs its buyer');
  assert.equal((await sell(T.counter, { lines: [{ type: 'rental', product_id: D.rentalProd }], customer: { details: { first_name: 'No', last_name: 'Gear', email: 'ng@x.test' }, sign_waiver: true }, payments: cash(4500) })).status, 400, 'a rental needs its gear chosen');

  // two tickets, two people: each ticket carries the holder's name and gets its own line
  const parent = { first_name: 'Hal', last_name: 'Holder', email: 'hal@holder.test', date_of_birth: '1980-01-01', sex: 'male' };
  const child = { first_name: 'Hazel', last_name: 'Holder', date_of_birth: `${Number(today.slice(0, 4)) - 9}-02-02`, sex: 'female' };
  const r = await sellRaw(T.counter, {
    customer: { details: parent }, participants: { c1: { details: child } },
    lines: [{ type: 'ticket', product_id: D.day, quantity: 2, holders: ['customer', 'c1'] }], payments: cash(12000),
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.tickets.map((t) => t.holder), ['Hal Holder', 'Hazel Holder']);
  const items = await q('SELECT person_id, quantity FROM order_items WHERE order_id = ?', [r.body.id]);
  assert.equal(items.length, 2); assert.ok(items.every((i) => i.person_id && i.quantity === 1));
  assert.equal((await sellRaw(T.counter, { customer: { details: parent }, lines: [{ type: 'ticket', product_id: D.day, quantity: 2, holders: ['customer'] }], payments: cash(12000) })).status, 400, 'holders must match the quantity');
  assert.equal((await sellRaw(T.counter, { customer: { details: parent }, lines: [{ type: 'ticket', product_id: D.day, holders: ['nobody'] }], payments: cash(6000) })).status, 400, 'an unknown person key');
});

test('name, date of birth and sex for everyone; adults also a phone or email; under 18s need neither', async () => {
  const cash = [{ tender: 'cash', amount_cents: 12000 }];
  const lines = [{ type: 'ticket', product_id: D.day, quantity: 2, holders: ['customer', 'k'] }];
  const adult = { first_name: 'Ada', last_name: 'Adult', email: 'ada@a.test', date_of_birth: '1982-04-04', sex: 'female' };
  const minorDob = `${Number(today.slice(0, 4)) - 12}-06-01`;
  const go = (customer, kid) => sellRaw(T.counter, { customer: { details: customer }, participants: { k: { details: kid } }, lines, payments: cash });
  const kid = { first_name: 'Kai', last_name: 'Adult', date_of_birth: minorDob, sex: 'male' };
  const missing = async (res) => { assert.equal(res.status, 400); return res.body.error; };

  assert.match(await missing(await go({ ...adult, sex: undefined }, kid)), /Sex/);
  assert.match(await missing(await go({ ...adult, date_of_birth: undefined }, kid)), /Date of birth/);
  assert.match(await missing(await go({ ...adult, email: undefined }, kid)), /Phone or email/);
  assert.match(await missing(await go(adult, { ...kid, sex: undefined })), /Sex/);
  assert.match(await missing(await go(adult, { ...kid, date_of_birth: undefined })), /Date of birth/);
  assert.match(await missing(await go(adult, { ...kid, date_of_birth: undefined, email: 'kai@a.test' })), /Date of birth/);
  assert.equal((await go({ ...adult, email: undefined, phone: '610-555-0111' }, kid)).status, 201, 'a phone number alone is enough for an adult');
  const ok1 = await go({ ...adult, first_name: 'Ada2' }, kid);
  assert.equal(ok1.status, 201, JSON.stringify(ok1.body));

  // the mountain makes a phone number mandatory: adults need it, a child still does not
  assert.equal((await api('PUT', '/crm/form-config', { token: A.owner, body: { required: { ticket: ['phone'], lesson: [] } } })).status, 200);
  try {
    assert.match(await missing(await go({ ...adult, first_name: 'Ada3', phone: undefined }, kid)), /Phone/);
    assert.equal((await go({ ...adult, first_name: 'Ada4', phone: '610-555-0199' }, { ...kid, first_name: 'Kai4' })).status, 201, 'the child has no phone and the sale still goes through');
  } finally {
    await api('PUT', '/crm/form-config', { token: A.owner, body: { required: { ticket: [], lesson: [] } } });
  }
});

test('payments must add up, and say how it was paid', async () => {
  const lines = [{ type: 'ticket', product_id: D.day }];
  assert.equal((await sell(T.counter, { lines })).status, 400, 'no payment recorded');
  const short = await sell(T.counter, { lines, payments: [{ tender: 'cash', amount_cents: 5000 }] });
  assert.equal(short.status, 400); assert.match(short.body.error, /\$50\.00.*\$60\.00/);
  assert.equal((await sell(T.counter, { lines, payments: [{ tender: 'cash', amount_cents: 6000, tendered_cents: 5000 }] })).status, 400, 'cash handed over is less than the cash amount');
  assert.equal((await sell(T.counter, { lines, payments: [{ tender: 'gift_card', amount_cents: 6000 }] })).status, 400, 'a gift card needs its code');
});

test('gift cards: pay part with the card and the rest in cash, and the balance is tracked', async () => {
  const lines = [{ type: 'ticket', product_id: D.day, quantity: 1 }];
  const check = await api('GET', `/gift-cards/${D.giftCode.toLowerCase().replace(/(.{4})/g, '$1-')}`, { token: T.counter });
  assert.equal(check.status, 200, 'the code can be typed in lowercase with dashes');
  assert.equal(check.body.balance_cents, 5000);
  assert.equal((await sell(T.counter, { lines, payments: [{ tender: 'gift_card', code: D.giftCode, amount_cents: 6000 }] })).status, 409, 'more than the card holds');
  const split = await sell(T.counter, { lines, payments: [{ tender: 'gift_card', code: D.giftCode, amount_cents: 3000 }, { tender: 'cash', amount_cents: 3000 }] });
  assert.equal(split.status, 201, JSON.stringify(split.body));
  D.splitOrder = split.body.id;
  assert.equal((await api('GET', `/gift-cards/${D.giftCode}`, { token: T.counter })).body.balance_cents, 2000);
  const ledger = await q('SELECT kind, delta_cents, balance_after_cents FROM gift_card_txns WHERE gift_card_id = (SELECT id FROM gift_cards WHERE code = ?) ORDER BY id', [D.giftCode]);
  assert.deepEqual(ledger.map((l) => [l.kind, l.delta_cents, l.balance_after_cents]), [['issue', 5000, 5000], ['redeem', -3000, 2000]]);
  assert.equal((await sell(T.counter, { lines: [{ type: 'gift_card', amount_cents: 2000 }], payments: [{ tender: 'gift_card', code: D.giftCode, amount_cents: 2000 }] })).status, 400, 'a gift card cannot buy a gift card');
  assert.equal((await sell(T.counter, { lines, payments: [{ tender: 'gift_card', code: 'NOSUCHCARD', amount_cents: 6000 }] })).status, 400);
});

test('refunding an order puts everything back: bookings, places, gear and gift card money', async () => {
  const m = A.owner;
  // blocked while gear is out, or while a gift card sold on the order has been spent
  const blocked = await api('POST', `/orders/${D.order}/refund`, { token: m, body: { reason: 'customer_request' } });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /gear|gift card/i);
  const contract = (await q('SELECT id FROM rental_contracts WHERE order_id = ?', [D.order]))[0].id;
  assert.equal((await api('POST', `/rentals/contracts/${contract}/checkin`, { token: m, body: {} })).status, 200);
  const spent = await api('POST', `/orders/${D.order}/refund`, { token: m, body: { reason: 'customer_request' } });
  assert.equal(spent.status, 409); assert.match(spent.body.error, /gift card/i, 'the gift card sold on it has been spent');
  assert.equal((await api('POST', `/orders/${D.order}/refund`, { token: T.counter, body: { reason: 'customer_request' } })).status, 403, 'only managers refund');

  // the split-paid order: the gift card money goes back on the card
  assert.equal((await api('POST', `/orders/${D.splitOrder}/refund`, { token: m, body: { reason: 'customer_request' } })).status, 200);
  assert.equal((await api('GET', `/gift-cards/${D.giftCode}`, { token: m })).body.balance_cents, 5000);
  assert.equal((await q('SELECT kind FROM gift_card_txns WHERE gift_card_id = (SELECT id FROM gift_cards WHERE code = ?) ORDER BY id DESC LIMIT 1', [D.giftCode]))[0].kind, 'refund');

  // now the big order can be refunded
  assert.equal((await api('POST', `/orders/${D.order}/refund`, { token: m, body: { reason: 'customer_request' } })).status, 200);
  assert.equal((await q('SELECT status FROM lesson_bookings WHERE session_id = ?', [D.lesson]))[0].status, 'cancelled');
  assert.equal((await q("SELECT status FROM program_enrollments WHERE program_id = ? ORDER BY id LIMIT 1", [D.prog]))[0].status, 'withdrawn');
  assert.equal((await q('SELECT status FROM gift_cards WHERE code = ?', [D.giftCode]))[0].status, 'void');
  assert.equal((await q("SELECT COUNT(*) AS n FROM tickets t JOIN order_items i ON i.id = t.order_item_id WHERE i.order_id = ? AND t.status = 'active'", [D.order]))[0].n, 0);
  assert.equal((await api('POST', `/orders/${D.order}/refund`, { token: m, body: { reason: 'customer_request' } })).status, 409, 'already refunded');
});

test('gift cards can be cancelled by a manager, and a cancelled card pays nothing', async () => {
  const lines = [{ type: 'ticket', product_id: D.day }];
  const r = await sell(T.counter, { lines: [{ type: 'gift_card', amount_cents: 1000 }], payments: [{ tender: 'cash', amount_cents: 1000 }] });
  const code = r.body.gift_cards[0].code;
  assert.equal((await api('POST', `/gift-cards/${code}/void`, { token: T.counter })).status, 403);
  assert.equal((await api('POST', `/gift-cards/${code}/void`, { token: A.owner })).status, 200);
  assert.equal((await sell(T.counter, { lines, payments: [{ tender: 'gift_card', code, amount_cents: 6000 }] })).status, 409);
  assert.equal((await api('GET', '/gift-cards', { token: T.counter })).status, 403);
  assert.ok((await api('GET', '/gift-cards', { token: A.owner })).body.data.length >= 2);
});

test('only counter staff and managers can sell, and another mountain sees none of it', async () => {
  const body = { lines: [{ type: 'ticket', product_id: D.day }], payments: [{ tender: 'cash', amount_cents: 6000 }] };
  for (const t of [T.patrol, T.instructor]) assert.equal((await sell(t, body)).status, 403);
  assert.equal((await sell(B.owner, body)).status, 404, 'another mountain\'s product');
  assert.equal((await sell(B.owner, { lines: [{ type: 'lesson', session_id: D.lesson }], customer: { details: { first_name: 'X', last_name: 'Y' } }, payments: [] })).status, 404);
  assert.equal((await api('GET', `/gift-cards/${D.giftCode}`, { token: B.owner })).status, 404);
  assert.equal((await api('GET', `/orders/${D.order}`, { token: B.owner })).status, 404);
  assert.equal((await api('GET', '/checkout/menu', { token: B.owner })).body.lessons.length, 0);
});

test('the daily report splits takings by tender and keeps gift card sales out of revenue', async () => {
  const r = (await api('GET', '/reports/daily', { token: A.owner })).body.sales;
  assert.ok(r.tenders.cash > 0 && r.tenders.card > 0 && r.tenders.gift_card >= 0, JSON.stringify(r.tenders));
  assert.ok(r.gift_card_sales_cents >= 1000);
  const orders = await q("SELECT SUM(total_cents) AS t FROM orders WHERE status = 'paid' AND tenant_id = (SELECT id FROM tenants WHERE slug = ?)", [A.slug]);
  assert.equal(r.revenue_cents, Number(orders[0].t) - r.gift_card_sales_cents);
});

test('rental pickup: scan the receipt code and see the order, the people, their waivers and the gear, then record the fitting', async () => {
  const mkGear = async (sku, category) => (await api('POST', '/rentals/items', { token: A.owner, body: { sku: `${sku}-${suffix}`, category, size: '150' } })).body.id;
  const sold = await sell(T.counter, { customer: { details: parent }, participants: { kid: { details: kid, sign_waiver: true } }, lines: [{ type: 'rental', product_id: D.rentalProd, participant: 'kid', items: [{ rental_item_id: await mkGear('PK-SKI', 'ski') }, { rental_item_id: await mkGear('PK-BOOT', 'boot') }] }], payments: [{ tender: 'cash', amount_cents: 4500, tendered_cents: 4500 }] });
  assert.equal(sold.status, 201, JSON.stringify(sold.body));
  D.order = sold.body.id;
  const r = await api('GET', `/rentals/pickup?code=ORD-${D.order}`, { token: T.counter });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.order.id, D.order);
  assert.ok(r.body.people.length >= 2, 'the parent and the child');
  const kidRow = r.body.people.find((p) => p.first_name === kid.first_name);
  assert.equal(kidRow.waiver_signed, true);
  assert.equal(r.body.contracts.length, 1);
  assert.equal(r.body.contracts[0].items.length, 2);
  assert.ok(r.body.lines.some((l) => l.line_kind === 'rental' && l.name === 'Ski Package'));
  assert.ok(r.body.people.every((p) => 'waiver_signed' in p));
  assert.equal((await api('GET', `/rentals/pickup?code=${D.order}`, { token: T.counter })).body.order.id, D.order, 'a typed order number works too');
  assert.equal((await api('GET', '/rentals/pickup?code=ORD-999999999', { token: T.counter })).status, 404);

  const line = r.body.contracts[0].items.find((i) => i.category === 'ski');
  const fit = await api('PATCH', `/rentals/contracts/${r.body.contracts[0].id}/items/${line.rental_item_id}`, { token: T.counter, body: { din_setting: 4.5, tech_name: 'Tess', test_result: 'pass' } });
  assert.equal(fit.status, 200, JSON.stringify(fit.body));
  const again = (await api('GET', `/rentals/pickup?code=ORD-${D.order}`, { token: T.counter })).body;
  const skiLine = again.contracts[0].items.find((i) => i.category === 'ski');
  assert.equal(skiLine.tech_name, 'Tess'); assert.equal(skiLine.test_result, 'pass');

  // another mountain cannot look up this order
  assert.equal((await api('GET', `/rentals/pickup?code=ORD-${D.order}`, { token: B.owner })).status, 404);
});
