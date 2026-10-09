'use strict';

// The shared customer record: purchaser capture on ticket sales and lesson bookings, matching and
// de-duplication, mandatory details, privacy by role, history and export.
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
const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);

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
async function addUser(m, email, role) {
  assert.equal((await api('POST', '/users', { token: m.owner, body: { email, password: PW, role } })).status, 201);
  return (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token;
}

let A; let B; const T = {}; const D = {};
const buyer = (over = {}) => ({ first_name: 'Bea', last_name: 'Buyer', email: 'bea@example.test', phone: '610-555-0101', address_line1: '12 Summit Rd', city: 'Stowe', region: 'VT', postal_code: '05672', country: 'USA', ...over });
const sell = (token, body) => api('POST', '/orders', { token, body: { items: [{ product_id: D.day }], ...body } });

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`ca-${suffix}`);
  B = await mountain(`cb-${suffix}`);
  T.counter = await addUser(A, `counter@${A.slug}.test`, 'counter');
  T.patrol = await addUser(A, `patrol@${A.slug}.test`, 'patrol');
  T.staff = await addUser(A, `staff@${A.slug}.test`, 'staff');
  D.day = (await api('POST', '/products', { token: A.owner, body: { kind: 'day_ticket', name: 'Adult Day', base_price_cents: 6000 } })).body.id;
  D.lesson = (await api('POST', '/products', { token: A.owner, body: { kind: 'lesson', name: 'Group lesson', base_price_cents: 8000 } })).body.id;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('a ticket sale captures the purchaser into the shared customer record', async () => {
  const r = await sell(T.counter, { purchaser: buyer({ marketing_opt_in: true }) });
  assert.equal(r.status, 201, r.text);
  assert.ok(r.body.person_id);
  assert.equal(r.body.customer.created, true);
  D.bea = r.body.person_id;
  const p = (await api('GET', `/people/${D.bea}`, { token: T.counter })).body;
  assert.equal(p.first_name, 'Bea');
  assert.equal(p.address_line1, '12 Summit Rd');
  assert.equal(p.city, 'Stowe');
  assert.equal(p.postal_code, '05672');
  assert.equal(p.source, 'window');
  assert.equal(p.marketing_opt_in, 1);
  assert.ok(p.marketing_opt_in_at, 'consent time is recorded');
  const o = (await api('GET', `/orders/${r.body.id}`, { token: T.counter })).body;
  assert.equal(o.person_id, D.bea);
  assert.equal(o.tickets[0].person_id, D.bea);
});

test('the same purchaser coming back is matched, not duplicated; only blanks are filled', async () => {
  const r = await sell(T.counter, { purchaser: buyer({ email: 'BEA@example.test', phone: '999-000-0000', emergency_name: 'Sam Buyer', marketing_opt_in: false }) });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.person_id, D.bea);
  assert.equal(r.body.customer.matched, true);
  const p = (await api('GET', `/people/${D.bea}`, { token: T.counter })).body;
  assert.equal(p.phone, '610-555-0101', 'existing phone is not overwritten by a match');
  assert.equal(p.emergency_name, 'Sam Buyer', 'a blank is filled in');
  assert.equal(p.marketing_opt_in, 1, 'a match never withdraws consent');
  const list = (await api('GET', '/people?q=Buyer', { token: T.counter })).body.data;
  assert.equal(list.length, 1);
});

test('choosing an existing customer lets the clerk correct their details', async () => {
  const r = await sell(T.counter, { person_id: D.bea, purchaser: { phone: '610-555-0199', marketing_opt_in: false } });
  assert.equal(r.status, 201, r.text);
  const p = (await api('GET', `/people/${D.bea}`, { token: T.counter })).body;
  assert.equal(p.phone, '610-555-0199');
  assert.equal(p.marketing_opt_in, 0);
  assert.equal((await sell(T.counter, { person_id: 999999 })).status, 404);
  assert.equal((await sell(T.counter, { purchaser: { email: 'x@y.test' } })).status, 400, 'a name is needed once any detail is given');
});

test('a sale without a purchaser still works until the mountain requires one', async () => {
  assert.equal((await sell(T.counter, {})).status, 201);
});

test('managers choose which details are mandatory; sales and bookings enforce it', async () => {
  const form = (await api('GET', '/crm/form', { token: T.counter })).body;
  assert.equal(form.can_admin, false);
  assert.ok(form.fields.find((f) => f.key === 'address_line1'));
  assert.equal((await api('PUT', '/crm/form-config', { token: T.counter, body: { required: { ticket: ['phone'], lesson: [] } } })).status, 403);
  assert.equal((await api('PUT', '/crm/form-config', { token: A.owner, body: { required: { ticket: ['first_name'], lesson: [] } } })).status, 400, 'names are always required already');
  assert.equal((await api('PUT', '/crm/form-config', { token: A.owner, body: { required: { ticket: ['nope'], lesson: [] } } })).status, 400);
  assert.equal((await api('PUT', '/crm/form-config', { token: A.owner, body: { required: { ticket: [], lesson: ['_purchaser'] } } })).status, 400);
  assert.equal((await api('PUT', '/crm/form-config', { token: A.owner, body: { required: { ticket: ['_purchaser', 'phone', 'address_line1', 'postal_code'], lesson: ['date_of_birth', 'emergency_name', 'emergency_phone'] } } })).status, 200);

  const after = (await api('GET', '/crm/form', { token: A.owner })).body;
  assert.equal(after.can_admin, true);
  assert.deepEqual(after.required.ticket.sort(), ['_purchaser', 'address_line1', 'phone', 'postal_code']);

  const none = await sell(T.counter, {});
  assert.equal(none.status, 400);
  assert.match(none.body.error, /purchaser/i);
  const thin = await sell(T.counter, { purchaser: { first_name: 'Cal', last_name: 'Cash', email: 'cal@example.test' } });
  assert.equal(thin.status, 400);
  assert.match(thin.body.error, /Phone/);
  assert.match(thin.body.error, /Street address/);
  assert.match(thin.body.error, /ZIP/);
  assert.equal((await api('GET', '/people?q=Cash', { token: T.counter })).body.data.length, 0, 'a refused sale leaves no half-saved customer');
  const good = await sell(T.counter, { purchaser: { first_name: 'Cal', last_name: 'Cash', email: 'cal@example.test', phone: '1', address_line1: '1 Main', postal_code: '1' } });
  assert.equal(good.status, 201, good.text);
  // Bea was already on file with everything needed.
  assert.equal((await sell(T.counter, { person_id: D.bea })).status, 201);
  // An existing customer who lacks a mandatory detail is refused until it is supplied.
  const bare = (await api('POST', '/people', { token: T.counter, body: { first_name: 'Bare', last_name: 'Bones' } })).body.id;
  const refused = await sell(T.counter, { person_id: bare });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /Bare Bones/);
  assert.equal((await sell(T.counter, { person_id: bare, purchaser: { phone: '2', address_line1: '2 Main', postal_code: '2' } })).status, 201);
});

test('lesson bookings capture the student; the customer is kept even when the booking needs a waiver', async () => {
  const session = (await api('POST', '/skischool/sessions', { token: A.owner, body: { product_id: D.lesson, starts_at: `${tomorrow}T13:00`, ends_at: `${tomorrow}T14:30`, capacity: 5 } })).body;
  assert.ok(session.id, 'session created');
  const book = (body) => api('POST', `/skischool/sessions/${session.id}/bookings`, { token: T.counter, body });
  assert.equal((await book({})).status, 400);
  const student = { first_name: 'Kid', last_name: 'Learner', date_of_birth: '2015-02-03', emergency_name: 'Mum Learner', emergency_phone: '610-555-0000', discipline: 'ski', ability_level: 'first_timer' };
  const missing = await book({ student: { first_name: 'Kid', last_name: 'Nodob' } });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /Date of birth/);
  assert.match(missing.body.error, /Emergency contact name/);
  const noWaiver = await book({ student });
  assert.equal(noWaiver.status, 409);
  assert.match(noWaiver.body.error, /waiver/i);
  const pid = noWaiver.body.details.person_id;
  assert.ok(pid, 'the saved customer is returned so the screen can retry');
  const p = (await api('GET', `/people/${pid}`, { token: T.counter })).body;
  assert.equal(p.ability_level, 'first_timer');
  assert.equal(p.source, 'lesson');
  const ok = await book({ person_id: pid, sign_waiver: true });
  assert.equal(ok.status, 201, ok.text);
  assert.equal((await api('GET', `/people/${pid}/waivers`, { token: T.counter })).body.data.length, 1);
  // A second booking with the same details matches the same customer.
  const again = await api('POST', `/skischool/sessions/${session.id}/bookings`, { token: T.counter, body: { student } });
  assert.equal(again.body.person_id, pid);
});

test('the customer history gathers purchases, tickets and lessons in one place', async () => {
  const a = (await api('GET', `/people/${D.bea}/activity`, { token: T.counter })).body;
  assert.ok(a.orders.length >= 3);
  assert.ok(a.tickets.length >= 3);
  assert.equal(a.tickets[0].product, 'Adult Day');
  assert.ok(a.totals.spend_cents >= 18000);
  assert.equal((await api('GET', `/people/${D.bea}/activity`, { token: T.patrol })).status, 403);
  assert.equal((await api('GET', `/people/${D.bea}/activity`, { token: B.owner })).status, 404, 'other mountains cannot see it');
});

test('patrol can look a guest up but does not see address, emergency contact or consent', async () => {
  const p = (await api('GET', `/people/${D.bea}`, { token: T.patrol })).body;
  assert.equal(p.first_name, 'Bea');
  assert.equal(p.address_line1, undefined);
  assert.equal(p.emergency_name, undefined);
  assert.equal(p.marketing_opt_in, undefined);
  const list = (await api('GET', '/people?q=Bea', { token: T.patrol })).body.data;
  assert.equal(list[0].city, undefined);
  assert.equal((await api('GET', '/people', { token: T.staff })).status, 403);
  assert.equal((await api('GET', '/crm/form', { token: T.patrol })).status, 403);
});

test('adding or editing a customer by hand', async () => {
  const dup = await api('POST', '/people', { token: T.counter, body: { first_name: 'Dupe', last_name: 'Bea', email: 'bea@example.test' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.details.person_id, D.bea);
  const mk = (await api('POST', '/people', { token: T.counter, body: { first_name: 'Eve', last_name: 'Edit', email: 'eve@example.test', city: 'Burlington', marketing_opt_in: true } }));
  assert.equal(mk.status, 201);
  assert.ok(mk.body.marketing_opt_in_at);
  const ed = await api('PATCH', `/people/${mk.body.id}`, { token: T.counter, body: { city: '', postal_code: '05401', email: 'bea@example.test' } });
  assert.equal(ed.status, 409, 'cannot take someone else\'s email');
  const ed2 = await api('PATCH', `/people/${mk.body.id}`, { token: T.counter, body: { city: '', postal_code: '05401' } });
  assert.equal(ed2.body.city, null, 'a blank clears the value');
  assert.equal(ed2.body.postal_code, '05401');
  assert.equal((await api('PATCH', `/people/${mk.body.id}`, { token: T.counter, body: { discipline: 'surf' } })).status, 400);
  assert.equal((await api('PATCH', `/people/${mk.body.id}`, { token: B.owner, body: { city: 'Hacked' } })).status, 404);
  assert.equal((await api('POST', '/people', { token: T.counter, body: { first_name: '', last_name: 'x' } })).status, 400);
});

test('managers can export customers, and the email list holds only people who agreed', async () => {
  assert.equal((await api('GET', '/people/export.csv', { token: T.counter })).status, 403);
  await api('POST', '/people', { token: A.owner, body: { first_name: '=cmd', last_name: 'Formula', email: 'f@example.test', marketing_opt_in: true } });
  const all = await api('GET', '/people/export.csv', { token: A.owner });
  assert.equal(all.status, 200);
  assert.match(all.text, /^first_name,last_name,email/);
  assert.match(all.text, /Stowe|Burlington/);
  assert.match(all.text, /"'=cmd"/, 'spreadsheet formulas are neutralised');
  const mk = await api('GET', '/people/export.csv?marketing=1', { token: A.owner });
  assert.match(mk.text, /f@example\.test/);
  assert.doesNotMatch(mk.text, /bea@example\.test/, 'Bea withdrew consent earlier');
});

test('nothing crosses mountains', async () => {
  const sb = await api('POST', '/products', { token: B.owner, body: { kind: 'day_ticket', name: 'B Day', base_price_cents: 5000 } });
  const r = await api('POST', '/orders', { token: B.owner, body: { person_id: D.bea, items: [{ product_id: sb.body.id }] } });
  assert.equal(r.status, 404);
  const mine = await api('POST', '/orders', { token: B.owner, body: { purchaser: buyer(), items: [{ product_id: sb.body.id }] } });
  assert.equal(mine.status, 201);
  assert.notEqual(mine.body.person_id, D.bea, 'same email at another mountain is a different customer');
  assert.equal((await api('GET', '/crm/form', { token: B.owner })).body.required.ticket.length, 0, 'settings are per mountain');
});
