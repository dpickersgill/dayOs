'use strict';

// Rentals round 2, the return side: one scan checks a piece in at once and shows what is still out; a paid rental still
// waiting to be fitted is never out; Out now searches by name, phone, tag and contract and filters; damage after the
// scan; season rentals (the product setting, the settings, the March and overdue reminders, buying the gear out); card
// deposits on the counter's reader (a hold for a short rental, a saved card for a long or season one, released when
// all is back, fees taken after staff confirm, a note deposit when the card cannot be used, holds near their end); and
// the shop manager's reports. Stripe and Postmark are mock servers.
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
const D = require('../src/lib/rentaldeposit');

let server; let base; let mock; let n = 0;
const calls = []; const intents = new Map(); const setups = new Map(); const readers = new Map(); const mails = [];
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const addDays = (d, k) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 864e5).toISOString().slice(0, 10);
const q = async (sql, params) => (await pool.query(sql, params))[0];

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${r.text}`);
async function mountain(tag) {
  const slug = `rr${tag}-${suffix}`;
  const t = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: `Returns ${tag}`, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'O', last_name: 'Owner' } }) });
  assert.equal(t.status, 201);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  const owner = await login(`owner@${slug}.test`);
  is(await api('POST', '/users', { token: owner, body: { email: `counter@${slug}.test`, password: PW, role: 'counter' } }), 201);
  return { slug, owner, counter: await login(`counter@${slug}.test`), id: (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id };
}
const item = async (m, sku, category, extra = {}) => { const r = await api('POST', '/rentals/items', { token: m.owner, body: { sku, category, ...extra } }); is(r, 201); return r.body.id; };
async function person(m, first, last, extra = {}) {
  const r = await api('POST', '/people', { token: m.owner, body: { first_name: first, last_name: last, ...extra } });
  is(r, 201);
  is(await api('POST', `/people/${r.body.id}/waivers`, { token: m.owner, body: {} }), 201);
  // signed that their details are true, so skis can go out (a date of birth first: nobody signs for themselves without one)
  is(await api('POST', '/rentals/fit/signoffs', { token: m.owner, body: { person_id: r.body.id, signer_name: `${first} ${last}`, signer_relation: 'self', signature: SIG, details: { date_of_birth: extra.date_of_birth || '1985-01-01' } } }), 201);
  return r.body.id;
}
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
/** Gear out the old way (a manager, with a reason, for tests: Track FIT gates the direct hand-out). */
async function rent(m, personId, itemIds, due, extra = {}) {
  const r = await api('POST', '/rentals/contracts', { token: m.owner, body: { person_id: personId, due_at: due, deposit_cents: 0, unpaid_reason: 'test', items: itemIds.map((id) => ({ rental_item_id: id })), ...extra } });
  is(r, 201);
  return r.body.id;
}

let A; let B;
test.before(async () => {
  mock = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const send = (status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
      const url = req.url.split('?')[0];
      if (url === '/email') { mails.push(JSON.parse(data)); return send(200, { MessageID: `m${++n}`, ErrorCode: 0 }); }
      const params = Object.fromEntries(new URLSearchParams(data));
      calls.push({ method: req.method, path: url, params, account: req.headers['stripe-account'] || null });
      let m;
      if (url === '/v1/terminal/locations') return send(200, { id: `tml_${++n}` });
      if (url === '/v1/terminal/readers' && req.method === 'POST') {
        const id = `tmr_${suffix}${++n}`;
        readers.set(id, { id, action: null, offline: params.registration_code === 'offline-reader' });
        return send(200, { id, device_type: 'simulated_wisepos_e', serial_number: `SN${n}` });
      }
      if ((m = url.match(/^\/v1\/terminal\/readers\/(tmr_\w+)$/))) return send(200, readers.get(m[1]) || {});
      if ((m = url.match(/^\/v1\/terminal\/readers\/(tmr_\w+)\/(process_payment_intent|process_setup_intent)$/))) {
        const r = readers.get(m[1]);
        if (r.offline) return send(400, { error: { message: 'Reader is currently offline, please ensure the reader is powered on and connected to the internet.' } });
        r.action = m[2] === 'process_payment_intent' ? { status: 'in_progress', payment_intent: params.payment_intent } : { status: 'in_progress', setup_intent: params.setup_intent, allow_redisplay: params.allow_redisplay };
        return send(200, r);
      }
      if ((m = url.match(/^\/v1\/terminal\/readers\/(tmr_\w+)\/cancel_action$/))) { readers.get(m[1]).action = null; return send(200, readers.get(m[1])); }
      if ((m = url.match(/^\/v1\/test_helpers\/terminal\/readers\/(tmr_\w+)\/present_payment_method$/))) {
        const r = readers.get(m[1]);
        const declined = params['card_present[number]'] === '4000000000000002';
        const card = { brand: 'visa', last4: '4242' };
        if (r.action.payment_intent) {
          const pi = intents.get(r.action.payment_intent);
          if (declined) { r.action = { ...r.action, status: 'failed', failure_message: 'Your card was declined.' }; pi.last_payment_error = { message: 'Your card was declined.' }; return send(200, r); }
          pi.status = pi.capture_method === 'manual' ? 'requires_capture' : 'succeeded';
          pi.latest_charge = { id: `ch_${++n}`, payment_method_details: { type: 'card_present', card_present: { ...card, capture_before: Math.floor(Date.now() / 1000) + 2 * 86400 } } };
        } else {
          const si = setups.get(r.action.setup_intent);
          if (declined) { r.action = { ...r.action, status: 'failed', failure_message: 'Your card was declined.' }; si.last_setup_error = { message: 'Your card was declined.' }; return send(200, r); }
          si.status = 'succeeded';
          si.latest_attempt = { id: `setatt_${++n}`, payment_method_details: { type: 'card_present', card_present: { brand: 'mastercard', last4: '5454', generated_card: `pm_gen_${++n}` } } };
        }
        r.action = { ...r.action, status: 'succeeded' };
        return send(200, r);
      }
      if (url === '/v1/customers' && req.method === 'POST') return send(200, { id: `cus_${suffix}${++n}` });
      if (url === '/v1/setup_intents' && req.method === 'POST') {
        const id = `seti_${suffix}${++n}`;
        setups.set(id, { id, status: 'requires_payment_method', customer: params.customer, usage: params.usage, last_setup_error: null, latest_attempt: null });
        return send(200, setups.get(id));
      }
      if ((m = url.match(/^\/v1\/setup_intents\/(seti_\w+)\/cancel$/))) { setups.get(m[1]).status = 'canceled'; return send(200, setups.get(m[1])); }
      if ((m = url.match(/^\/v1\/setup_intents\/(seti_\w+)$/))) return send(200, setups.get(m[1]));
      if ((m = url.match(/^\/v1\/payment_methods\/(pm_\w+)\/detach$/))) return send(200, { id: m[1], customer: null });
      if (url === '/v1/payment_intents' && req.method === 'POST') {
        const id = `pi_${suffix}${++n}`;
        const pi = { id, status: 'requires_payment_method', amount: Number(params.amount), capture_method: params.capture_method || 'automatic', customer: params.customer || null, last_payment_error: null };
        if (params.confirm === 'true') {
          if (params.payment_method === 'pm_declines') return send(402, { error: { message: 'Your card was declined.', code: 'card_declined' } });
          pi.status = 'succeeded';
        }
        intents.set(id, pi);
        return send(200, pi);
      }
      if ((m = url.match(/^\/v1\/payment_intents\/(pi_\w+)\/capture$/))) {
        const pi = intents.get(m[1]);
        if (pi.status !== 'requires_capture') return send(400, { error: { message: `This PaymentIntent could not be captured because it has a status of ${pi.status}.` } });
        pi.status = 'succeeded'; pi.amount_received = Number(params.amount_to_capture || pi.amount); return send(200, pi);
      }
      if ((m = url.match(/^\/v1\/payment_intents\/(pi_\w+)\/cancel$/))) { const pi = intents.get(m[1]); pi.status = 'canceled'; return send(200, pi); }
      if ((m = url.match(/^\/v1\/payment_intents\/(pi_\w+)$/))) return send(200, intents.get(m[1]));
      return send(404, { error: { message: `no mock for ${req.method} ${url}` } });
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockBase = `http://127.0.0.1:${mock.address().port}`;
  require('../src/config').stripe.apiBase = mockBase;
  require('../src/lib/mailer').settings.apiBase = mockBase;
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain('a'); B = await mountain('b');
  // email on only after sign-in (with email on, a new device's sign-in asks for a code)
  process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token'; process.env.MAIL_FROM = 'shop@mountain.test';
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => mock.close(r)); await pool.end(); });

const scan = (m, code, extra = {}, who = 'counter') => api('POST', '/rentals/returns/scan', { token: m[who], body: { code, ...extra } });

test('one scan checks a piece in, shows what is still out, and the last piece closes the contract with the late fee', async () => {
  is(await api('PUT', '/rentals/settings', { token: A.owner, body: { late_fee_cents_per_day: 1000, late_grace_minutes: 0 } }), 200);
  const mia = await person(A, 'Mia', 'Scan', { phone: '(610) 555-0101' });
  const ski = await item(A, `SK1-${suffix}`, 'ski', { size: '160' }); const boot = await item(A, `BT1-${suffix}`, 'boot', { size: '27.5' }); const pole = await item(A, `PL1-${suffix}`, 'pole');
  const id = await rent(A, mia, [ski, boot, pole], `${addDays(today, -2)}T16:30`);
  const r1 = await scan(A, `BT1-${suffix}`);
  is(r1, 200);
  assert.equal(r1.body.kind, 'returned'); assert.equal(r1.body.closed, false); assert.equal(r1.body.contract.id, id);
  assert.deepEqual(r1.body.contract.items.filter((i) => !i.returned_at).map((i) => i.sku).sort(), [`PL1-${suffix}`, `SK1-${suffix}`]);
  assert.equal(r1.body.contract.first_name, 'Mia');
  const again = await scan(A, `BT1-${suffix}`);
  is(again, 409, 'a piece already back says so'); assert.match(again.body.error, /not out on a rental/);
  is(await scan(A, 'NOPE-123'), 404);
  is(await scan(B, `SK1-${suffix}`), 404, 'another mountain finds nothing');
  // damaged on the way in: to service, with a fee
  const r2 = await scan(A, `SK1-${suffix}`, { damage_notes: 'Edge cracked', fee_cents: 2500 });
  is(r2, 200); assert.equal(r2.body.closed, false);
  assert.equal((await q('SELECT status FROM rental_items WHERE id = ?', [ski]))[0].status, 'maintenance');
  const r3 = await scan(A, `PL1-${suffix}`);
  is(r3, 200); assert.equal(r3.body.closed, true);
  assert.deepEqual(r3.body.fees.map((f) => f.kind), ['late']);
  assert.ok(r3.body.fees[0].cents >= 2000);
  assert.equal((await q('SELECT status FROM rental_contracts WHERE id = ?', [id]))[0].status, 'returned');
  assert.equal(r3.body.contract.fees_due_cents, 2500 + r3.body.fees[0].cents);
  // the contract number opens it without checking anything in
  const c = await scan(A, `C-${id}`);
  is(c, 200); assert.equal(c.body.kind, 'contract'); assert.equal(c.body.contract.status, 'returned');
});

test('damage noticed after the scan goes to service with a fee; not once the piece is out again', async () => {
  const p = await person(A, 'Dee', 'Damage');
  const helmet = await item(A, `HE1-${suffix}`, 'helmet');
  const id = await rent(A, p, [helmet], `${today}T23:59`);
  const r = await scan(A, `HE1-${suffix}`);
  is(r, 200); assert.equal(r.body.closed, true);
  const line = r.body.contract.items[0].line_id;
  is(await api('POST', `/rentals/returns/lines/${line}/damage`, { token: B.counter, body: { notes: 'x' } }), 404);
  const d = await api('POST', `/rentals/returns/lines/${line}/damage`, { token: A.counter, body: { notes: 'Strap torn', fee_cents: 1500 } });
  is(d, 200);
  assert.equal(d.body.contract.fees_due_cents, 1500);
  assert.equal((await q('SELECT status FROM rental_items WHERE id = ?', [helmet]))[0].status, 'maintenance');
  await q("UPDATE rental_items SET status = 'rented' WHERE id = ?", [helmet]);
  is(await api('POST', `/rentals/returns/lines/${line}/damage`, { token: A.counter, body: { notes: 'More' } }), 409);
  await q("UPDATE rental_items SET status = 'available' WHERE id = ?", [helmet]);
  assert.ok(id);
});

test('a paid rental waiting to be fitted is never out: not in Out now, not checked in, not found by number', async () => {
  const p = await person(A, 'Tia', 'Tofit');
  const [ins] = await pool.query("INSERT INTO rental_contracts (tenant_id, person_id, status, due_at, valid_on) VALUES (?, ?, 'to_fit', ?, ?)", [A.id, p, `${today} 16:30:00`, today]);
  const out = await api('GET', '/rentals/out', { token: A.counter });
  is(out, 200);
  assert.ok(!out.body.data.some((c) => c.id === ins.insertId));
  is(await api('POST', `/rentals/contracts/${ins.insertId}/checkin`, { token: A.counter, body: {} }), 409);
  is(await scan(A, String(ins.insertId)), 404);
});

test('Out now searches by name, phone, tag and contract number, and filters overdue, due today, groups and season', async () => {
  const sam = await person(A, 'Samuel', 'Searchable', { phone: '484-555-0199' });
  const kid = await person(A, 'Kim', 'Kidd');
  const t1 = await item(A, `OUT1-${suffix}`, 'ski'); const t2 = await item(A, `OUT2-${suffix}`, 'boot'); const t3 = await item(A, `OUT3-${suffix}`, 'helmet');
  const late = await rent(A, sam, [t1], `${addDays(today, -1)}T16:30`);
  const group = await rent(A, sam, [{ id: t2 }].map((x) => x.id), `${today}T23:58`, { group_name: 'Valley Ski Club', items: [{ rental_item_id: t2, person_id: kid }] });
  const season = await rent(A, sam, [t3], `${addDays(today, 150)}T16:30`);
  await q("UPDATE rental_contracts SET kind = 'season' WHERE id = ?", [season]);
  const find = async (qs) => (await api('GET', `/rentals/out?${qs}`, { token: A.counter })).body.data.map((c) => c.id);
  assert.deepEqual((await find('q=Samuel%20Searchable')).sort(), [late, group, season].sort());
  assert.deepEqual((await find('q=5550199')).sort(), [late, group, season].sort(), 'phone digits match whatever the punctuation');
  assert.deepEqual(await find(`q=OUT3-${suffix}`), [season], 'a tag finds its contract');
  assert.deepEqual(await find(`q=%23${late}`), [late], 'a contract number');
  assert.deepEqual(await find('q=Kim%20Kidd'), [group], 'the person wearing the gear');
  const overdue = await find('filter=overdue');
  assert.ok(overdue.includes(late) && !overdue.includes(season) && !overdue.includes(group));
  assert.ok((await find('filter=today')).includes(group));
  assert.deepEqual((await find('filter=groups&q=Valley')), [group]);
  assert.deepEqual((await find('filter=season&q=Searchable')), [season]);
  const row = (await api('GET', `/rentals/out?q=%23${late}`, { token: A.counter })).body.data[0];
  assert.equal(row.overdue, true); assert.equal(row.pieces_out, 1); assert.equal(row.tags, `OUT1-${suffix}`);
  assert.deepEqual((await api('GET', '/rentals/out?q=Samuel', { token: B.counter })).body.data, [], 'another mountain sees none');
  for (const id of [late, group, season]) is(await api('POST', `/rentals/contracts/${id}/checkin`, { token: A.counter, body: {} }), 200);
});

test('season rentals: the product says season, the settings keep the return date, and the renter is reminded in March and when overdue, once each', async () => {
  const prod = await api('POST', '/products', { token: A.owner, body: { kind: 'rental', name: 'Season ski package', base_price_cents: 19900, rental_kind: 'season' } });
  is(prod, 201);
  assert.equal((await q('SELECT rental_kind FROM products WHERE id = ?', [prod.body.id]))[0].rental_kind, 'season');
  is(await api('PUT', '/rentals/settings/returns', { token: A.counter, body: { season_return_md: '04-20' } }), 403);
  is(await api('PUT', '/rentals/settings/returns', { token: A.owner, body: { season_return_md: '02-30' } }), 400);
  const s = await api('PUT', '/rentals/settings/returns', { token: A.owner, body: { season_return_md: '04-20', deposit_mode: 'card' } });
  is(s, 200); assert.equal(s.body.season_return_md, '04-20'); assert.equal(s.body.deposit_mode, 'card');
  assert.equal(s.body.late_fee_cents_per_day, 1000, 'the counter settings are left alone');

  const rae = await person(A, 'Rae', 'Season', { email: `rae-${suffix}@guest.test` });
  const sk = await item(A, `SS1-${suffix}`, 'ski');
  const soon = await rent(A, rae, [sk], `${addDays(today, 30)}T16:30`);
  const sb = await item(A, `SS2-${suffix}`, 'snowboard');
  const late = await rent(A, rae, [sb], `${addDays(today, -3)}T16:30`);
  await q("UPDATE rental_contracts SET kind = 'season' WHERE id IN (?)", [[soon, late]]);
  const season = require('../src/lib/rentalseason');
  const before = mails.length;
  const r1 = await season.remindAll({ today: `${today.slice(0, 4)}-10-05` });
  assert.ok(r1.overdue >= 1); assert.equal(r1.march, 0, 'not March: only the overdue one');
  const mine = () => mails.slice(before).filter((x) => x.To === `rae-${suffix}@guest.test`);
  assert.equal(mine().length, 1); assert.match(mine()[0].Subject, /overdue/); assert.match(mine()[0].TextBody, new RegExp(`SS2-${suffix}`));
  await season.remindAll({ today: `${today.slice(0, 4)}-03-10` });
  assert.equal(mine().length, 2); assert.match(mine()[1].Subject, /due back soon/);
  await season.remindAll({ today: `${today.slice(0, 4)}-03-11` });
  assert.equal(mine().length, 2, 'once each');
  for (const id of [soon, late]) is(await api('POST', `/rentals/contracts/${id}/checkin`, { token: A.counter, body: {} }), 200);
});

test('buy out: a manager sells the gear to the season renter; the pieces are sold, the price is a fee to collect, no late fee', async () => {
  const pat = await person(A, 'Pat', 'Buyer');
  const sk = await item(A, `BO1-${suffix}`, 'ski', { cost_cents: 30000 });
  const bt = await item(A, `BO2-${suffix}`, 'boot');
  const id = await rent(A, pat, [sk, bt], `${addDays(today, -1)}T16:30`);
  await q("UPDATE rental_contracts SET kind = 'season' WHERE id = ?", [id]);
  is(await api('GET', `/rentals/contracts/${id}/buyout`, { token: A.counter }), 403);
  const quote = await api('GET', `/rentals/contracts/${id}/buyout`, { token: A.owner });
  is(quote, 200);
  assert.equal(quote.body.items.find((i) => i.rental_item_id === sk).suggested_cents, 15000, 'half the cost');
  assert.equal(quote.body.items.find((i) => i.rental_item_id === bt).suggested_cents, null);
  is(await api('POST', `/rentals/contracts/${id}/buyout`, { token: A.counter, body: { items: [{ rental_item_id: sk, cents: 15000 }] } }), 403);
  const b1 = await api('POST', `/rentals/contracts/${id}/buyout`, { token: A.owner, body: { items: [{ rental_item_id: sk, cents: 15000 }, { rental_item_id: bt, cents: 4000 }] } });
  is(b1, 200); assert.equal(b1.body.status, 'returned'); assert.equal(b1.body.total_cents, 19000);
  assert.deepEqual((await q('SELECT status FROM rental_items WHERE id IN (?) ORDER BY id', [[sk, bt]])).map((r) => r.status), ['sold', 'sold']);
  const ch = await q('SELECT kind, cents, status FROM rental_charges WHERE contract_id = ? ORDER BY id', [id]);
  assert.deepEqual(ch.map((c) => [c.kind, c.cents, c.status]), [['buyout', 15000, 'due'], ['buyout', 4000, 'due']], 'no late fee for gear the renter bought');
  is(await api('POST', `/rentals/contracts/${id}/buyout`, { token: A.owner, body: { items: [{ rental_item_id: sk, cents: 1 }] } }), 409);
});

// ---------------------------------------------------------------- card deposits
const ADDRESS = { line1: '1 Summit Road', city: 'Limerick', state: 'PA', postal_code: '19468' };
const depositRow = async (id) => (await q('SELECT * FROM rental_deposits WHERE id = ?', [id]))[0];
const contractRow = async (id) => (await q('SELECT deposit_mode, deposit_status, deposit_ref, deposit_customer, deposit_card, deposit_cents FROM rental_contracts WHERE id = ?', [id]))[0];
async function tap(m, depId, outcome = 'approve') {
  const r = await api('POST', `/rentals/deposits/${depId}/simulate`, { token: m.counter, body: { outcome } });
  is(r, 200);
  return r.body;
}

test('the hold window: a short day rental is held, a long one or a season one saves the card', () => {
  const tz = 'America/New_York';
  const local = (h) => new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(Date.now() + h * 3600000));
  assert.equal(D.planFor({ kind: 'day', due_at: local(8) }, tz), 'hold');
  assert.equal(D.planFor({ kind: 'day', due_at: local(30) }, tz), 'hold');
  assert.equal(D.planFor({ kind: 'day', due_at: local(50) }, tz), 'saved', 'past the shortest in-person hold (2 days) with room to spare');
  assert.equal(D.planFor({ kind: 'season', due_at: local(4) }, tz), 'saved');
  assert.ok(D.HOLD_SAFE_HOURS < D.HOLD_HOURS.other);
});

test('no reader: the counter is told why; an offline reader falls back to a note deposit', async () => {
  const ready = await api('GET', '/rentals/deposits/ready', { token: A.counter });
  is(ready, 200); assert.equal(ready.body.ready, false); assert.match(ready.body.why, /No card reader/);
  const off = await api('POST', '/terminal/readers', { token: A.owner, body: { registration_code: 'offline-reader', label: 'Back counter', address: ADDRESS } });
  is(off, 201); A.offline = off.body.id;
  const r = await api('POST', '/terminal/readers', { token: A.owner, body: { registration_code: 'simulated-wpe', label: 'Rental counter' } });
  is(r, 201); A.reader = r.body.id;
  assert.equal((await api('GET', '/rentals/deposits/ready', { token: A.counter })).body.ready, true);
  const p = await person(A, 'Otto', 'Offline');
  const id = await rent(A, p, [await item(A, `DO1-${suffix}`, 'ski')], `${today}T23:59`);
  const o = await api('POST', `/rentals/contracts/${id}/deposit`, { token: A.counter, body: { reader_id: A.offline, amount_cents: 5000 } });
  is(o, 409); assert.match(o.body.error, /not online/); assert.equal(o.body.details.fallback, 'note');
  const note = await api('POST', `/rentals/contracts/${id}/deposit/note`, { token: A.counter, body: { amount_cents: 5000, note: 'Driver license held' } });
  is(note, 201);
  assert.deepEqual({ ...(await contractRow(id)) }, { deposit_mode: 'note', deposit_status: 'held', deposit_ref: null, deposit_customer: null, deposit_card: null, deposit_cents: 5000 });
  assert.equal((await q("SELECT COUNT(*) AS n FROM rental_charges WHERE contract_id = ? AND kind = 'deposit'", [id]))[0].n, 1);
  is(await api('POST', `/rentals/contracts/${id}/deposit/note`, { token: A.counter, body: { amount_cents: 5000 } }), 409, 'one deposit per rental');
  is(await api('POST', `/rentals/contracts/${id}/deposit`, { token: B.counter, body: { reader_id: A.reader, amount_cents: 5000 } }), 404, 'another mountain');
  is(await api('POST', `/rentals/contracts/${id}/checkin`, { token: A.counter, body: {} }), 200);
});

test('a short day rental: the deposit is held on the card (manual capture) and released when all is back with nothing owed', async () => {
  const p = await person(A, 'Hal', 'Hold');
  const ski = await item(A, `DH1-${suffix}`, 'ski');
  const id = await rent(A, p, [ski], `${today}T23:59`);
  const start = await api('POST', `/rentals/contracts/${id}/deposit`, { token: A.counter, body: { reader_id: A.reader, amount_cents: 7500 } });
  is(start, 201); assert.equal(start.body.kind, 'hold'); assert.equal(start.body.status, 'waiting');
  const pi = calls.filter((c) => c.path === '/v1/payment_intents').at(-1);
  assert.equal(pi.params.capture_method, 'manual'); assert.equal(pi.params['payment_method_types[0]'], 'card_present'); assert.equal(pi.params.amount, '7500');
  assert.equal(pi.params['metadata[kind]'], 'rental_deposit');
  assert.equal((await contractRow(id)).deposit_status, 'pending');
  is(await api('POST', `/rentals/contracts/${id}/deposit`, { token: A.counter, body: { reader_id: A.reader, amount_cents: 7500 } }), 409, 'one at a time');
  const held = await tap(A, start.body.id);
  assert.equal(held.status, 'held'); assert.equal(held.card, 'Visa ending 4242'); assert.ok(held.expires_at);
  assert.deepEqual({ ...(await contractRow(id)), deposit_ref: null }, { deposit_mode: 'card_hold', deposit_status: 'held', deposit_ref: null, deposit_customer: null, deposit_card: 'Visa ending 4242', deposit_cents: 7500 });
  const back = await api('POST', `/rentals/contracts/${id}/checkin`, { token: A.counter, body: {} });
  is(back, 200); assert.equal(back.body.deposit.action, 'released');
  const row = await depositRow(start.body.id);
  assert.equal(row.status, 'released'); assert.equal(intents.get(row.intent).status, 'canceled', 'the hold is let go at Stripe');
  assert.equal((await contractRow(id)).deposit_status, 'released');
});

test('fees owed: staff confirm and the fees are captured from the hold, the rest let go; more than the hold leaves the rest due', async () => {
  const p = await person(A, 'Fay', 'Fees');
  const ski = await item(A, `DF1-${suffix}`, 'ski');
  const id = await rent(A, p, [ski], `${today}T23:59`);
  const dep = (await api('POST', `/rentals/contracts/${id}/deposit`, { token: A.counter, body: { reader_id: A.reader, amount_cents: 5000 } })).body;
  await tap(A, dep.id);
  const r = await scan(A, `DF1-${suffix}`, { damage_notes: 'Base gouge', fee_cents: 3000 });
  is(r, 200);
  assert.equal(r.body.deposit.action, 'confirm'); assert.equal(r.body.deposit.owed_cents, 3000); assert.equal(r.body.deposit.can_take_cents, 3000);
  assert.equal((await depositRow(dep.id)).status, 'held', 'nothing is taken until staff confirm');
  const t = await api('POST', `/rentals/contracts/${id}/deposit/take`, { token: A.counter });
  is(t, 200); assert.equal(t.body.status, 'captured'); assert.equal(t.body.taken_cents, 3000); assert.equal(t.body.still_due_cents, 0);
  const cap = calls.filter((c) => /\/capture$/.test(c.path)).at(-1);
  assert.equal(cap.params.amount_to_capture, '3000');
  const [pay] = await q('SELECT * FROM order_payments WHERE order_id = ?', [t.body.order_id]);
  assert.equal(pay.processor, 'stripe'); assert.equal(pay.reference, (await depositRow(dep.id)).intent); assert.equal(pay.amount_cents, 3000); assert.equal(pay.card_last4, '4242');
  assert.deepEqual((await q("SELECT status FROM rental_charges WHERE contract_id = ? AND kind = 'damage'", [id])).map((c) => c.status), ['paid']);
  is(await api('POST', `/rentals/contracts/${id}/deposit/take`, { token: A.counter }), 409, 'nothing left to take from');

  // fees bigger than the hold
  const p2 = await person(A, 'Max', 'More');
  const sk2 = await item(A, `DF2-${suffix}`, 'ski');
  const id2 = await rent(A, p2, [sk2], `${today}T23:59`);
  const dep2 = (await api('POST', `/rentals/contracts/${id2}/deposit`, { token: A.counter, body: { reader_id: A.reader, amount_cents: 2000 } })).body;
  await tap(A, dep2.id);
  await scan(A, `DF2-${suffix}`, { damage_notes: 'Binding torn out', fee_cents: 3500 });
  const t2 = await api('POST', `/rentals/contracts/${id2}/deposit/take`, { token: A.counter });
  is(t2, 200); assert.equal(t2.body.taken_cents, 2000); assert.equal(t2.body.still_due_cents, 1500);
  const ch = await q("SELECT cents, status FROM rental_charges WHERE contract_id = ? AND kind = 'damage' ORDER BY id", [id2]);
  assert.deepEqual(ch.map((c) => [c.cents, c.status]), [[1500, 'due'], [2000, 'paid']]);
});

test('a season rental saves the card instead; lost gear is charged to it off-session only by a manager', async () => {
  const p = await person(A, 'Sol', 'Saved', { email: `sol-${suffix}@guest.test` });
  const sb = await item(A, `DS1-${suffix}`, 'snowboard', { cost_cents: 40000 }); const bt = await item(A, `DS2-${suffix}`, 'boot');
  const id = await rent(A, p, [sb, bt], `${addDays(today, 160)}T16:30`);
  await q("UPDATE rental_contracts SET kind = 'season' WHERE id = ?", [id]);
  const start = await api('POST', `/rentals/contracts/${id}/deposit`, { token: A.counter, body: { reader_id: A.reader, amount_cents: 20000 } });
  is(start, 201); assert.equal(start.body.kind, 'saved');
  const si = calls.filter((c) => c.path === '/v1/setup_intents').at(-1);
  assert.equal(si.params['payment_method_types[0]'], 'card_present'); assert.equal(si.params.usage, 'off_session'); assert.match(si.params.customer, /^cus_/);
  const proc = calls.filter((c) => /process_setup_intent$/.test(c.path)).at(-1);
  assert.equal(proc.params.allow_redisplay, 'limited');
  const saved = await tap(A, start.body.id);
  assert.equal(saved.status, 'saved'); assert.equal(saved.card, 'Mastercard ending 5454');
  const row = await depositRow(start.body.id);
  assert.match(row.payment_method, /^pm_gen_/, 'the reusable card Stripe made from the tap');
  assert.equal((await contractRow(id)).deposit_mode, 'card_saved'); assert.equal((await contractRow(id)).deposit_customer, row.customer);
  // the boots come back, the board is lost
  is(await scan(A, `DS2-${suffix}`), 200);
  const lost = await api('POST', `/rentals/contracts/${id}/checkin`, { token: A.counter, body: { items: [{ rental_item_id: sb, lost: true, fee_cents: 40000 }] } });
  is(lost, 200); assert.equal(lost.body.deposit.action, 'confirm'); assert.equal(lost.body.deposit.can_take_cents, 40000);
  assert.equal((await q('SELECT status FROM rental_items WHERE id = ?', [sb]))[0].status, 'lost');
  const counterTry = await api('POST', `/rentals/contracts/${id}/deposit/take`, { token: A.counter });
  is(counterTry, 403); assert.match(counterTry.body.error, /manager/);
  const t = await api('POST', `/rentals/contracts/${id}/deposit/take`, { token: A.owner });
  is(t, 200); assert.equal(t.body.status, 'charged'); assert.equal(t.body.taken_cents, 40000);
  const pi = calls.filter((c) => c.path === '/v1/payment_intents').at(-1);
  assert.equal(pi.params.off_session, 'true'); assert.equal(pi.params.confirm, 'true'); assert.equal(pi.params.customer, row.customer); assert.equal(pi.params.payment_method, row.payment_method);
  assert.ok(calls.some((c) => c.path === `/v1/payment_methods/${row.payment_method}/detach`), 'the saved card is not kept once settled');
});

test('a declined tap records the failure and a new try can start; a deposit still waiting can be canceled', async () => {
  const p = await person(A, 'Dex', 'Decline');
  const id = await rent(A, p, [await item(A, `DD1-${suffix}`, 'ski')], `${today}T23:59`);
  const d1 = (await api('POST', `/rentals/contracts/${id}/deposit`, { token: A.counter, body: { reader_id: A.reader, amount_cents: 5000 } })).body;
  const failed = await tap(A, d1.id, 'decline');
  assert.equal(failed.status, 'failed'); assert.match(failed.failure, /declined/);
  const d2 = await api('POST', `/rentals/contracts/${id}/deposit`, { token: A.counter, body: { reader_id: A.reader, amount_cents: 5000 } });
  is(d2, 201, 'a failed try does not block another');
  const c = await api('POST', `/rentals/deposits/${d2.body.id}/cancel`, { token: A.counter });
  is(c, 200); assert.equal(c.body.status, 'canceled');
  assert.equal((await contractRow(id)).deposit_mode, 'none');
  is(await api('GET', `/rentals/deposits/${d2.body.id}`, { token: B.counter }), 404);
  is(await api('POST', `/rentals/contracts/${id}/checkin`, { token: A.counter, body: {} }), 200);
});

test('the daily job flags holds near their end while gear is out, and records holds that ended', async () => {
  const p = await person(A, 'Eve', 'Expiry');
  const id = await rent(A, p, [await item(A, `DE1-${suffix}`, 'ski')], `${today}T23:59`);
  const dep = (await api('POST', `/rentals/contracts/${id}/deposit`, { token: A.counter, body: { reader_id: A.reader, amount_cents: 5000 } })).body;
  await tap(A, dep.id);
  await q('UPDATE rental_deposits SET expires_at = UTC_TIMESTAMP() + INTERVAL 5 HOUR WHERE id = ?', [dep.id]);
  const o = (await api('GET', `/rentals/out?q=%23${id}`, { token: A.counter })).body.data[0];
  assert.equal(o.hold_ends_soon, true); assert.equal(o.deposit_card, 'Visa ending 4242');
  const s1 = await D.sweep();
  assert.ok(s1.warned >= 1);
  assert.ok((await depositRow(dep.id)).warned_at);
  await q('UPDATE rental_deposits SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE id = ?', [dep.id]);
  intents.get((await depositRow(dep.id)).intent).status = 'canceled'; // Stripe let the hold go
  const s2 = await D.sweep();
  assert.ok(s2.expired >= 1);
  assert.equal((await depositRow(dep.id)).status, 'expired');
  assert.equal((await contractRow(id)).deposit_status, 'failed');
  is(await api('POST', `/rentals/contracts/${id}/checkin`, { token: A.counter, body: {} }), 200);
});

test('a manager releases a hold by hand; with gear still out the counter cannot', async () => {
  const p = await person(A, 'Rex', 'Release');
  const id = await rent(A, p, [await item(A, `DR1-${suffix}`, 'ski')], `${today}T23:59`);
  const dep = (await api('POST', `/rentals/contracts/${id}/deposit`, { token: A.counter, body: { reader_id: A.reader, amount_cents: 5000 } })).body;
  await tap(A, dep.id);
  is(await api('POST', `/rentals/contracts/${id}/deposit/release`, { token: A.counter }), 403);
  const r = await api('POST', `/rentals/contracts/${id}/deposit/release`, { token: A.owner });
  is(r, 200); assert.equal(r.body.status, 'released');
  is(await api('POST', `/rentals/contracts/${id}/checkin`, { token: A.counter, body: {} }), 200);
});

test('the shop manager’s reports: use by piece and by type and size, rarely rented, damage and repair spend, fees, revenue per piece, late returns', async () => {
  const p = await person(A, 'Rita', 'Report');
  const s1 = await item(A, `RP1-${suffix}`, 'ski', { size: '150' }); const s2 = await item(A, `RP2-${suffix}`, 'ski', { size: '150' });
  const id = await rent(A, p, [s1, s2], `${addDays(today, -1)}T10:00`);
  // a rental sale line for this contract, shared over its two pieces
  const [o] = await pool.query("INSERT INTO orders (tenant_id, person_id, status, subtotal_cents, total_cents, channel) VALUES (?, ?, 'paid', 6000, 6000, 'window')", [A.id, p]);
  await pool.query("INSERT INTO order_items (tenant_id, order_id, line_kind, person_id, contract_id, unit_price_cents) VALUES (?, ?, 'rental', ?, ?, 6000)", [A.id, o.insertId, p, id]);
  is(await api('POST', `/rentals/contracts/${id}/checkin`, { token: A.counter, body: {} }), 200);
  is(await api('POST', `/rentals/items/${s1}/service`, { token: A.counter, body: { kind: 'repair', cost_cents: 1800, notes: 'Edge' } }), 201);
  is(await api('GET', '/rentals/reports/shop', { token: A.counter }), 403);
  const r = await api('GET', `/rentals/reports/shop?from=${addDays(today, -6)}&to=${today}`, { token: A.owner });
  is(r, 200);
  const piece = r.body.pieces.find((x) => x.id === s1);
  assert.equal(piece.times, 1); assert.ok(piece.days_out >= 0); assert.equal(piece.revenue_cents, 3000, 'half the line each');
  assert.equal(r.body.pieces.find((x) => x.id === s2).revenue_cents, 3000);
  const g = r.body.by_type_size.find((x) => x.category === 'ski' && x.size === '150');
  assert.equal(g.pieces, 2); assert.equal(g.revenue_cents, 6000);
  assert.ok(r.body.rarely.some((x) => x.id === s1));
  assert.equal(r.body.service.find((x) => x.kind === 'repair').cents >= 1800, true);
  assert.ok(r.body.late.list.some((x) => x.id === id), 'came back late');
  assert.ok(r.body.fees.charged.some((f) => f.kind === 'late'));
  assert.ok(r.body.fees.settled.some((f) => f.status === 'paid'), 'fees taken from deposits count as collected');
  assert.ok(r.body.revenue.rental_cents >= 6000); assert.match(r.body.revenue.method, /shared equally/);
  const other = await api('GET', '/rentals/reports/shop', { token: B.owner });
  is(other, 200); assert.equal(other.body.pieces.length, 0);
  is(await api('GET', '/rentals/reports', { token: A.owner }), 200, 'the existing report still works');
});
