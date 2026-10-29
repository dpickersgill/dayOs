'use strict';

// Rentals round 2, the review fixes: no gear out without a real paid sale (or a manager's reason), every wearer of skis
// or a snowboard signed and unchanged, groups paid before their bags go out, saved cards charged only by a manager, one
// capture per deposit, holds that cannot outlive the rental, refunds that wait for a hand-out, and the daily job
// cleaning up holds and saved cards left behind. Stripe and Postmark are mock servers.
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
  return r.body.id;
}
/** Gear out the old way (a manager, with a reason, for tests: Track FIT gates the direct hand-out). */
async function rent(m, personId, itemIds, due, extra = {}) {
  const r = await api('POST', '/rentals/contracts', { token: m.owner, body: { person_id: personId, due_at: due, deposit_cents: 0, unpaid_reason: 'test', items: itemIds.map((id) => ({ rental_item_id: id })), ...extra } });
  is(r, 201);
  return r.body.id;
}

let A; let B; const idem = new Map();
test.before(async () => {
  mock = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const ik = req.headers['idempotency-key'];
      if (ik && idem.has(ik)) { const [st, bd] = idem.get(ik); res.statusCode = st; res.setHeader('content-type', 'application/json'); return res.end(bd); }
      const send = (status, body) => { const bd = JSON.stringify(body); if (ik) idem.set(ik, [status, bd]); res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(bd); };
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
const ADDRESS = { line1: '1 Summit Road', city: 'Limerick', state: 'PA', postal_code: '19468' };
const depositRow = async (id) => (await q('SELECT * FROM rental_deposits WHERE id = ?', [id]))[0];
const contractRow = async (id) => (await q('SELECT deposit_mode, deposit_status, deposit_ref, deposit_customer, deposit_card, deposit_cents FROM rental_contracts WHERE id = ?', [id]))[0];
async function tap(m, depId, outcome = 'approve') {
  const r = await api('POST', `/rentals/deposits/${depId}/simulate`, { token: m.counter, body: { outcome } });
  is(r, 200);
  return r.body;
}


const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const nSignoffs = async (pid) => Number((await q('SELECT COUNT(*) AS n FROM rental_signoffs WHERE person_id = ?', [pid]))[0].n);
const FIT = { weight_lb: 150, height_in: 66, skier_type: '2' };
/** The person signs at the counter that their details are true (as on the fitting card). */
const signoff = (m, pid, extra = {}, who = 'counter') => api('POST', '/rentals/fit/signoffs', { token: m[who], body: { person_id: pid, signer_name: 'Pat Signer', signer_relation: 'self', signature: SIG, details: { ...FIT }, ...extra } });
/** A rental package at the mountain (made once). */
async function rentalPkg(m = A) {
  if (!m.pkg) m.pkg = (await api('POST', '/products', { token: m.owner, body: { kind: 'rental', name: `Pkg ${suffix}`, base_price_cents: 4500 } })).body.id;
  return m.pkg;
}
/** A rental sold in Sell with no gear yet: a paid order and a to_fit contract for the person. */
async function sold(m, pid) {
  await q("UPDATE people SET sex = COALESCE(sex, 'female'), email = COALESCE(email, ?) WHERE id = ?", [`p${pid}-${suffix}@x.test`, pid]);
  const r = await api('POST', '/checkout', { token: m.counter, body: { channel: 'window', customer: { person_id: pid }, payments: [{ tender: 'cash', amount_cents: 4500 }], lines: [{ type: 'rental', product_id: await rentalPkg(m) }] } });
  is(r, 201, 'sell a rental');
  return (await q("SELECT id, order_id FROM rental_contracts WHERE person_id = ? AND status = 'to_fit' ORDER BY id DESC LIMIT 1", [pid]))[0];
}
async function reader() {
  if (!A.reader) { const r = await api('POST', '/terminal/readers', { token: A.owner, body: { registration_code: 'simulated-wpe', label: 'Rental counter', address: ADDRESS } }); is(r, 201); A.reader = r.body.id; }
  return A.reader;
}

test('1 POST /rentals/contracts: a made-up, other-mountain or refunded sale is refused, and skis need a signoff', async () => {
  const p = await person(A, 'Nora', 'Nosign', { date_of_birth: '1990-01-01' });
  const ski = await item(A, `G1S-${suffix}`, 'ski');
  const body = (extra) => ({ person_id: p, due_at: `${today}T23:59`, items: [{ rental_item_id: ski }], ...extra });
  const fake = await api('POST', '/rentals/contracts', { token: A.counter, body: body({ order_id: 987654321 }) });
  is(fake, 409, 'a sale that does not exist');
  assert.match(fake.body.error || fake.text, /not found at this mountain/);
  // a real sale at the other mountain
  const pb = await person(B, 'Bo', 'Other', { date_of_birth: '1990-01-01' });
  const theirs = await sold(B, pb);
  is(await api('POST', '/rentals/contracts', { token: A.counter, body: body({ order_id: theirs.order_id }) }), 409, 'another mountain\'s sale');
  // a real paid sale here, but the skier has not signed
  const mine = await sold(A, p);
  const noSign = await api('POST', '/rentals/contracts', { token: A.counter, body: body({ order_id: mine.order_id }) });
  is(noSign, 409, 'skis with no signoff');
  assert.match(noSign.text, /has not signed/);
  assert.equal((await q('SELECT status FROM rental_items WHERE id = ?', [ski]))[0].status, 'available');
  // even a manager handing out without a sale needs the signoff for skis
  is(await api('POST', '/rentals/contracts', { token: A.owner, body: body({ unpaid_reason: 'card machine down' }) }), 409, 'manager, unpaid, no signoff');
  is(await signoff(A, p), 201);
  const ok = await api('POST', '/rentals/contracts', { token: A.counter, body: body({ order_id: mine.order_id }) });
  is(ok, 201, 'paid and signed');
  assert.equal((await q('SELECT status FROM rental_items WHERE id = ?', [ski]))[0].status, 'rented');
  // a refunded sale pays for nothing
  const p2 = await person(A, 'Rita', 'Refund', { date_of_birth: '1990-01-01' });
  const s2 = await sold(A, p2);
  is(await api('POST', `/orders/${s2.order_id}/refund`, { token: A.owner, body: { reason: 'customer_request' } }), 200);
  const h = await item(A, `G1H-${suffix}`, 'helmet');
  is(await api('POST', '/rentals/contracts', { token: A.counter, body: { person_id: p2, order_id: s2.order_id, due_at: `${today}T23:59`, items: [{ rental_item_id: h }] } }), 409, 'refunded sale');
});

test('2 groups: no bag goes out unpaid; a manager records the billing; plain hand-out needs a manager and a reason', async () => {
  const kid = await person(A, 'Gina', 'Group', { date_of_birth: '1990-01-01' });
  const g = await api('POST', '/rentals/groups', { token: A.counter, body: { name: `Grp ${suffix}`, rental_on: today } }); is(g, 201);
  is(await api('POST', `/rentals/groups/${g.body.id}/members`, { token: A.counter, body: { rows: [{ first_name: 'Gina', last_name: 'Group', person_id: kid }] } }), 201);
  const c = (await q('SELECT id FROM rental_contracts WHERE group_id = ? AND person_id = ?', [g.body.id, kid]))[0].id;
  const helmet = await item(A, `G2H-${suffix}`, 'helmet');
  is(await api('PUT', `/rentals/groups/${g.body.id}/members/${c}/gear`, { token: A.counter, body: { items: [{ rental_item_id: helmet }] } }), 200);
  const page = await api('GET', `/rentals/groups/${g.body.id}`, { token: A.counter });
  assert.equal(page.body.billing.settled, false);
  const r = await api('POST', `/rentals/groups/${g.body.id}/handout`, { token: A.counter, body: {} });
  is(r, 200);
  assert.equal(r.body.out.length, 0);
  assert.equal(r.body.skipped[0].skipped, 'A manager must record how this group pays');
  const scan = await api('POST', '/rentals/groups/scan', { token: A.counter, body: { code: `RC-${c}` } });
  assert.equal(scan.body.skipped, 'A manager must record how this group pays');
  assert.equal((await q('SELECT status FROM rental_contracts WHERE id = ?', [c]))[0].status, 'to_fit');
  // only managers record billing; a sale must be real and paid
  is(await api('PUT', `/rentals/groups/${g.body.id}/billing`, { token: A.counter, body: { note: 'Invoice to the school' } }), 403);
  is(await api('PUT', `/rentals/groups/${g.body.id}/billing`, { token: A.owner, body: { order_id: 987654321 } }), 404);
  is(await api('PUT', `/rentals/groups/${g.body.id}/billing`, { token: A.owner, body: { note: 'x' } }), 400);
  is(await api('PUT', `/rentals/groups/${g.body.id}/billing`, { token: A.owner, body: { note: 'Invoice to the school, PO 77' } }), 200);
  const after = await api('GET', `/rentals/groups/${g.body.id}`, { token: A.counter });
  assert.equal(after.body.billing.settled, true);
  assert.equal(after.body.billing.note, 'Invoice to the school, PO 77');
  assert.equal(after.body.billing.by, `owner@${A.slug}.test`);
  const r2 = await api('POST', `/rentals/groups/${g.body.id}/handout`, { token: A.counter, body: {} });
  assert.equal(r2.body.out.length, 1, r2.text);
  assert.equal((await q('SELECT status FROM rental_contracts WHERE id = ?', [c]))[0].status, 'out');

  // the plain hand-out route on a group member with no billing: counter refused, a manager says why
  const g2 = await api('POST', '/rentals/groups', { token: A.counter, body: { name: `Grp2 ${suffix}`, rental_on: today } });
  is(await api('POST', `/rentals/groups/${g2.body.id}/members`, { token: A.counter, body: { rows: [{ first_name: 'Gina', last_name: 'Group', person_id: kid }] } }), 201);
  const c2 = (await q('SELECT id FROM rental_contracts WHERE group_id = ? AND person_id = ?', [g2.body.id, kid]))[0].id;
  const h2 = await item(A, `G2H2-${suffix}`, 'helmet');
  const counterTry = await api('POST', `/rentals/contracts/${c2}/handout`, { token: A.counter, body: { items: [{ rental_item_id: h2 }] } });
  is(counterTry, 403, 'counter, unpaid group');
  assert.match(counterTry.text, /A manager must record how this group pays/);
  is(await api('POST', `/rentals/contracts/${c2}/handout`, { token: A.owner, body: { items: [{ rental_item_id: h2 }] } }), 400, 'manager with no reason');
  is(await api('POST', `/rentals/contracts/${c2}/handout`, { token: A.owner, body: { items: [{ rental_item_id: h2 }], unpaid_reason: 'School pays Monday' } }), 200);
  const row = (await q('SELECT status, unpaid_reason, unpaid_by FROM rental_contracts WHERE id = ?', [c2]))[0];
  assert.equal(row.status, 'out');
  assert.equal(row.unpaid_reason, 'School pays Monday');
  assert.ok(row.unpaid_by);
  // a paid sale from Sell works as the group's billing too
  const p3 = await person(A, 'Sal', 'Sale', { date_of_birth: '1990-01-01' });
  const s3 = await sold(A, p3);
  const g3 = await api('POST', '/rentals/groups', { token: A.counter, body: { name: `Grp3 ${suffix}`, rental_on: today } });
  is(await api('PUT', `/rentals/groups/${g3.body.id}/billing`, { token: A.owner, body: { order_id: s3.order_id } }), 200);
  assert.equal((await api('GET', `/rentals/groups/${g3.body.id}`, { token: A.counter })).body.billing.settled, true);
});

test('3 Sell: the renter\'s signoff never covers skis worn by someone else', async () => {
  const pk = await rentalPkg();
  const child = await person(A, 'Cody', 'Child', { date_of_birth: '2016-02-02', weight_lb: 60 });
  const ski = await item(A, `G3S-${suffix}`, 'ski');
  const sale = () => api('POST', '/checkout', { token: A.counter, body: { channel: 'window',
    customer: { details: { first_name: 'Pam', last_name: 'Parent', date_of_birth: '1980-01-01', sex: 'female', email: `pam-${suffix}@x.test` }, sign_waiver: true },
    payments: [{ tender: 'cash', amount_cents: 4500 }],
    lines: [{ type: 'rental', product_id: pk, items: [{ rental_item_id: ski, person_id: child, din_setting: 4 }], fit: FIT, signoff: { signer_name: 'Pam Parent', signer_relation: 'self', signature: SIG, details: FIT } }] } });
  const r = await sale();
  is(r, 409, 'child has not signed');
  assert.match(r.text, /Cody Child has not signed/);
  assert.equal(await nSignoffs(child), 0);
  assert.equal((await q('SELECT status FROM rental_items WHERE id = ?', [ski]))[0].status, 'available');
  // a parent signs for the child; then the sale goes through
  is(await signoff(A, child, { signer_name: 'Pam Parent', signer_relation: 'parent', details: { weight_lb: 60, height_in: 50, skier_type: '1' } }), 201);
  is(await sale(), 201);
  assert.equal((await q('SELECT status FROM rental_items WHERE id = ?', [ski]))[0].status, 'rented');
});

test('4 swap: only on gear that is out, and skis going out need the wearer\'s signoff', async () => {
  const p = await person(A, 'Sam', 'Swap');
  const helmet = await item(A, `G4H-${suffix}`, 'helmet'); const ski = await item(A, `G4S-${suffix}`, 'ski');
  const id = await rent(A, p, [helmet], `${today}T23:59`);
  const r = await api('POST', `/rentals/contracts/${id}/swap`, { token: A.counter, body: { out_item_id: helmet, replacement: { rental_item_id: ski } } });
  is(r, 409, 'no signoff');
  assert.equal((await q('SELECT status FROM rental_items WHERE id = ?', [ski]))[0].status, 'available');
  is(await signoff(A, p, { details: { ...FIT, date_of_birth: '1985-05-05' } }), 201);
  is(await api('POST', `/rentals/contracts/${id}/swap`, { token: A.counter, body: { out_item_id: helmet, replacement: { rental_item_id: ski } } }), 200);
  // a rental still waiting to be fitted has nothing to swap
  const p2 = await person(A, 'Tia', 'Tofit', { date_of_birth: '1990-01-01' });
  const s = await sold(A, p2);
  const h2 = await item(A, `G4H2-${suffix}`, 'helmet');
  is(await api('POST', `/rentals/contracts/${s.id}/swap`, { token: A.counter, body: { out_item_id: h2, replacement: { rental_item_id: h2 } } }), 409, 'to_fit');
});

test('5 a saved card is charged only by a manager', async () => {
  await reader();
  const p = await person(A, 'Vic', 'Victim');
  const h = await item(A, `G5H-${suffix}`, 'helmet');
  const id = await rent(A, p, [h], `${addDays(today, 10)}T16:30`);
  const dep = await api('POST', `/rentals/contracts/${id}/deposit`, { token: A.counter, body: { reader_id: A.reader, amount_cents: 0 } }); is(dep, 201);
  assert.equal(dep.body.kind, 'saved');
  await tap(A, dep.body.id);
  is(await api('POST', `/rentals/contracts/${id}/checkin`, { token: A.counter, body: { items: [{ rental_item_id: h, damage_notes: 'scratch', fee_cents: 900000 }] } }), 200);
  const before = calls.filter((c) => c.path === '/v1/payment_intents' && c.params.off_session === 'true').length;
  const t = await api('POST', `/rentals/contracts/${id}/deposit/take`, { token: A.counter });
  is(t, 403, 'counter');
  assert.equal(calls.filter((c) => c.path === '/v1/payment_intents' && c.params.off_session === 'true').length, before, 'no charge was tried');
  assert.equal((await depositRow(dep.body.id)).status, 'saved');
  const m = await api('POST', `/rentals/contracts/${id}/deposit/take`, { token: A.owner });
  is(m, 200, 'manager');
  assert.equal(m.body.status, 'charged');
});

test('6 two takes at once on one hold: one capture, one sale', async () => {
  await reader();
  const p = await person(A, 'Rae', 'Race');
  const h = await item(A, `G6H-${suffix}`, 'helmet');
  const id = await rent(A, p, [h], `${today}T23:59`);
  const dep = (await api('POST', `/rentals/contracts/${id}/deposit`, { token: A.counter, body: { reader_id: A.reader, amount_cents: 5000 } })).body;
  await tap(A, dep.id);
  is(await api('POST', `/rentals/contracts/${id}/checkin`, { token: A.counter, body: { items: [{ rental_item_id: h, damage_notes: 'x', fee_cents: 8000 }] } }), 200);
  const intent = (await depositRow(dep.id)).intent;
  const [a, b] = await Promise.all([api('POST', `/rentals/contracts/${id}/deposit/take`, { token: A.counter }), api('POST', `/rentals/contracts/${id}/deposit/take`, { token: A.counter })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], `${a.text} ${b.text}`);
  assert.equal(calls.filter((c) => c.path === `/v1/payment_intents/${intent}/capture`).length, 1);
  const orders = await q("SELECT o.id FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE oi.contract_id = ? AND oi.label = 'Rental fees from deposit'", [id]);
  assert.equal(orders.length, 1);
  const ch = await q("SELECT cents, status FROM rental_charges WHERE contract_id = ? AND kind = 'damage' ORDER BY id", [id]);
  assert.deepEqual(ch.map((x) => [Number(x.cents), x.status]).sort(), [[3000, 'due'], [5000, 'paid']]);
  assert.equal((await depositRow(dep.id)).status, 'captured');
});

test('6b a Stripe failure while taking puts the deposit back', async () => {
  await reader();
  const p = await person(A, 'Fay', 'Fail');
  const h = await item(A, `G6bH-${suffix}`, 'helmet');
  const id = await rent(A, p, [h], `${addDays(today, 10)}T16:30`);
  const dep = (await api('POST', `/rentals/contracts/${id}/deposit`, { token: A.counter, body: { reader_id: A.reader, amount_cents: 0 } })).body;
  await tap(A, dep.id);
  await q("UPDATE rental_deposits SET payment_method = 'pm_declines' WHERE id = ?", [dep.id]);
  is(await api('POST', `/rentals/contracts/${id}/checkin`, { token: A.counter, body: { items: [{ rental_item_id: h, damage_notes: 'x', fee_cents: 1000 }] } }), 200);
  is(await api('POST', `/rentals/contracts/${id}/deposit/take`, { token: A.owner }), 409);
  assert.equal((await depositRow(dep.id)).status, 'saved');
});

test('7 extending past the end of a card hold is refused until the deposit is switched to a saved card', async () => {
  await reader();
  const p = await person(A, 'Ed', 'Extend');
  const h = await item(A, `G7H-${suffix}`, 'helmet');
  const id = await rent(A, p, [h], `${today}T23:59`);
  const dep = (await api('POST', `/rentals/contracts/${id}/deposit`, { token: A.counter, body: { reader_id: A.reader, amount_cents: 5000 } })).body;
  assert.equal(dep.kind, 'hold');
  await tap(A, dep.id);
  const e = await api('POST', `/rentals/contracts/${id}/extend`, { token: A.counter, body: { due_at: `${addDays(today, 6)}T16:30` } });
  is(e, 409);
  assert.match(e.text, /Switch the deposit to a saved card first/);
  assert.equal(e.body.details.deposit, 'switch');
  // a short extension inside the hold is fine
  is(await api('POST', `/rentals/contracts/${id}/extend`, { token: A.counter, body: { due_at: `${addDays(today, 1)}T09:00` } }), 200);
  const sw = await api('POST', `/rentals/contracts/${id}/deposit/switch`, { token: A.counter, body: { reader_id: A.reader } });
  is(sw, 201);
  assert.equal(sw.body.kind, 'saved');
  assert.equal((await depositRow(dep.id)).status, 'released');
  await tap(A, sw.body.id);
  is(await api('POST', `/rentals/contracts/${id}/extend`, { token: A.counter, body: { due_at: `${addDays(today, 6)}T16:30` } }), 200);
  assert.equal((await contractRow(id)).deposit_mode, 'card_saved');
});

test('8 group hand-out: a signoff whose details changed does not count; a form signoff counts for its rental day', async () => {
  const p = await person(A, 'Hal', 'Height', { date_of_birth: '1990-01-01' });
  const g = await api('POST', '/rentals/groups', { token: A.counter, body: { name: `Grp8 ${suffix}`, rental_on: today } });
  is(await api('PUT', `/rentals/groups/${g.body.id}/billing`, { token: A.owner, body: { note: 'Invoice to the club' } }), 200);
  is(await api('POST', `/rentals/groups/${g.body.id}/members`, { token: A.counter, body: { rows: [{ first_name: 'Hal', last_name: 'Height', person_id: p }] } }), 201);
  const c = (await q('SELECT id FROM rental_contracts WHERE group_id = ? AND person_id = ?', [g.body.id, p]))[0].id;
  const ski = await item(A, `G8S-${suffix}`, 'ski');
  is(await api('PUT', `/rentals/groups/${g.body.id}/members/${c}/gear`, { token: A.counter, body: { items: [{ rental_item_id: ski, din_setting: 5, tech_name: 'Tech', test_result: 'pass' }] } }), 200);
  is(await signoff(A, p), 201);
  is(await api('PUT', `/rentals/fit/people/${p}`, { token: A.counter, body: { weight_lb: 210 } }), 200);
  const page = await api('GET', `/rentals/groups/${g.body.id}`, { token: A.counter });
  const m = page.body.members.find((x) => x.contract_id === c);
  assert.equal(m.signed, false);
  assert.equal(m.signed_changed, true);
  const r = await api('POST', '/rentals/groups/scan', { token: A.counter, body: { code: `RC-${c}` } });
  assert.match(r.body.skipped || '', /Details changed/, r.text);
  assert.equal((await q('SELECT status FROM rental_contracts WHERE id = ?', [c]))[0].status, 'to_fit');
  is(await signoff(A, p, { details: { ...FIT, weight_lb: 210 } }), 201);
  const ok = await api('POST', '/rentals/groups/scan', { token: A.counter, body: { code: `RC-${c}` } });
  assert.equal(ok.body.out, true, ok.text);

  // a guest form filled the night before for tomorrow counts on the group page for tomorrow's group
  const p2 = await person(A, 'Fia', 'Form', { date_of_birth: '1990-01-01', weight_lb: 120, height_in: 64 });
  const tomorrow = addDays(today, 1);
  const g2 = await api('POST', '/rentals/groups', { token: A.counter, body: { name: `Grp8b ${suffix}`, rental_on: tomorrow } });
  is(await api('POST', `/rentals/groups/${g2.body.id}/members`, { token: A.counter, body: { rows: [{ first_name: 'Fia', last_name: 'Form', person_id: p2 }] } }), 201);
  const [f] = (await pool.query("INSERT INTO rental_forms (tenant_id, contact_name, rental_on, people, status) VALUES (?, 'Fia Form', ?, '[]', 'used')", [A.id, tomorrow]));
  await q("INSERT INTO rental_signoffs (tenant_id, person_id, form_id, signer_name, signer_relation, details, signature, via) VALUES (?, ?, ?, 'Fia Form', 'self', ?, ?, 'form')", [A.id, p2, f.insertId, JSON.stringify({ weight_lb: 120, height_in: 64 }), SIG]);
  const page2 = await api('GET', `/rentals/groups/${g2.body.id}`, { token: A.counter });
  assert.equal(page2.body.members[0].signed, true, page2.text);
});

test('9 nobody signs for themselves without a date of birth', async () => {
  const p = await person(A, 'Nell', 'Nodob');
  const r = await signoff(A, p);
  is(r, 400);
  assert.match(r.text, /Add the date of birth first/);
  assert.equal(await nSignoffs(p), 0);
  // a parent can sign without it
  is(await signoff(A, p, { signer_relation: 'parent', signer_name: 'Pa Nodob' }), 201);
  // with the date of birth on the card, or already on file, the renter signs
  is(await signoff(A, p, { details: { ...FIT, date_of_birth: '1980-04-04' } }), 201);
  const p2 = await person(A, 'Owen', 'Onfile', { date_of_birth: '1981-01-01' });
  is(await signoff(A, p2), 201);
  // a child with a date of birth still cannot sign for themselves
  const kid = await person(A, 'Kit', 'Kid', { date_of_birth: '2015-01-01' });
  const k = await signoff(A, kid);
  is(k, 400);
  assert.match(k.text, /under 18/);
});

test('refund and hand-out at the same time never both happen', async () => {
  const p = await person(A, 'Ray', 'Racer', { date_of_birth: '1990-01-01' });
  const s = await sold(A, p);
  const h = await item(A, `GRH-${suffix}`, 'helmet');
  const [ho, rf] = await Promise.all([
    api('POST', `/rentals/contracts/${s.id}/handout`, { token: A.counter, body: { items: [{ rental_item_id: h }] } }),
    api('POST', `/orders/${s.order_id}/refund`, { token: A.owner, body: { reason: 'customer_request' } }),
  ]);
  assert.ok(!(ho.status === 200 && rf.status === 200), `both happened: ${ho.text} ${rf.text}`);
  const c = (await q('SELECT status FROM rental_contracts WHERE id = ?', [s.id]))[0].status;
  if (ho.status === 200) { assert.equal(c, 'out'); is(rf, 409); } else { assert.equal(c, 'cancelled'); is(rf, 200); }
  // and one after the other: gear out stops the refund
  const p2 = await person(A, 'Rox', 'Refund', { date_of_birth: '1990-01-01' });
  const s2 = await sold(A, p2);
  const h2 = await item(A, `GRH2-${suffix}`, 'helmet');
  is(await api('POST', `/rentals/contracts/${s2.id}/handout`, { token: A.counter, body: { items: [{ rental_item_id: h2 }] } }), 200);
  is(await api('POST', `/orders/${s2.order_id}/refund`, { token: A.owner, body: { reason: 'customer_request' } }), 409);
});

test('releasing a card deposit with fees still owed needs a manager', async () => {
  await reader();
  const p = await person(A, 'Lou', 'Release');
  const h = await item(A, `GLH-${suffix}`, 'helmet');
  const id = await rent(A, p, [h], `${today}T23:59`);
  const dep = (await api('POST', `/rentals/contracts/${id}/deposit`, { token: A.counter, body: { reader_id: A.reader, amount_cents: 5000 } })).body;
  await tap(A, dep.id);
  is(await api('POST', `/rentals/contracts/${id}/checkin`, { token: A.counter, body: { items: [{ rental_item_id: h, damage_notes: 'dent', fee_cents: 2000 }] } }), 200);
  const r = await api('POST', `/rentals/contracts/${id}/deposit/release`, { token: A.counter });
  is(r, 403);
  assert.match(r.text, /Fees are still owed/);
  is(await api('POST', `/rentals/contracts/${id}/deposit/release`, { token: A.owner }), 200);
  assert.equal((await depositRow(dep.id)).status, 'released');
});

test('the daily job lets go of holds and saved cards left behind', async () => {
  await reader();
  // a hold still waiting at the return, tapped later
  const p = await person(A, 'Tad', 'Late');
  const h = await item(A, `GDH-${suffix}`, 'helmet');
  const id = await rent(A, p, [h], `${today}T23:59`);
  const dep = (await api('POST', `/rentals/contracts/${id}/deposit`, { token: A.counter, body: { reader_id: A.reader, amount_cents: 5000 } })).body;
  const back = await api('POST', `/rentals/contracts/${id}/checkin`, { token: A.counter, body: {} });
  is(back, 200);
  assert.equal(back.body.deposit.action, 'waiting');
  await tap(A, dep.id);
  assert.equal((await depositRow(dep.id)).status, 'held');
  // a saved card charged while the gear was out, never detached
  const p2 = await person(A, 'Cal', 'Charged');
  const h2 = await item(A, `GDH2-${suffix}`, 'helmet');
  const id2 = await rent(A, p2, [h2], `${addDays(today, 10)}T16:30`);
  const dep2 = (await api('POST', `/rentals/contracts/${id2}/deposit`, { token: A.counter, body: { reader_id: A.reader, amount_cents: 0 } })).body;
  await tap(A, dep2.id);
  is(await api('POST', `/rentals/contracts/${id2}/charges`, { token: A.counter, body: { kind: 'other', cents: 1500, note: 'Wax' } }), 201);
  const t = await api('POST', `/rentals/contracts/${id2}/deposit/take`, { token: A.owner });
  is(t, 200);
  assert.equal(t.body.status, 'charged');
  is(await api('POST', `/rentals/contracts/${id2}/checkin`, { token: A.counter, body: {} }), 200);
  const pm = (await depositRow(dep2.id)).payment_method;
  assert.ok(pm);
  assert.equal((await depositRow(dep2.id)).detached_at, null);

  let out = await D.sweep();
  assert.ok(out.released >= 1, JSON.stringify(out));
  assert.equal((await depositRow(dep.id)).status, 'released');
  assert.equal((await depositRow(dep2.id)).detached_at, null, 'a card back for less than 7 days stays');
  await q('UPDATE rental_contracts SET checked_in_at = NOW() - INTERVAL 8 DAY WHERE id = ?', [id2]);
  out = await D.sweep();
  assert.ok(out.detached >= 1, JSON.stringify(out));
  assert.ok((await depositRow(dep2.id)).detached_at);
  assert.ok(calls.some((c) => c.path === `/v1/payment_methods/${pm}/detach`));
  const logged = await q("SELECT action FROM audit_log WHERE tenant_id = ? AND entity_id IN (?) AND action IN ('deposit_release','deposit_card_detached')", [A.id, [id, id2]]);
  assert.deepEqual([...new Set(logged.map((l) => l.action))].sort(), ['deposit_card_detached', 'deposit_release']);
});
