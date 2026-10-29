'use strict';

// Customer lookup (name, phone, email), the one-way pull of ticket and rental details into patient records,
// and the safeguards around patrol data: access log, no caching, minimum necessary.
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

let A; let B; const T = {}; const ctx = {};
const addDays = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const newCase = (token, over = {}) => api('POST', '/patrol/incidents', { token, body: { occurred_at: `${today}T10:15`, location: 'Upper Ridge', category: 'injury', severity: 'moderate', summary: 'Wrist injury', ...over } });
const rowsOf = async (sql, params) => (await pool.query(sql, params))[0];

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`pa-${suffix}`);
  B = await mountain(`pb-${suffix}`);
  const staff = (await api('POST', '/workforce/staff', { token: A.owner, body: { person: { first_name: 'Pat', last_name: 'Patroller' }, status: 'active' } })).body.id;
  T.patrol = await addUser(A, `pat@${A.slug}.test`, 'patrol', { staff_id: staff });
  T.counter = await addUser(A, `counter@${A.slug}.test`, 'counter');
  T.staff = await addUser(A, `staff@${A.slug}.test`, 'staff');

  // One guest with a season pass and rented ski, boot and helmet; another with an expired day ticket and gear returned yesterday.
  const guest = await api('POST', '/people', { token: A.owner, body: { first_name: 'Sam', last_name: 'Rivera', email: `sam@${A.slug}.test`, phone: '(610) 555-0100', date_of_birth: '1990-05-01', address_line1: '12 Mill Rd', city: 'Phoenixville', region: 'PA', postal_code: '19460', height_in: 69, weight_lb: 165, emergency_name: 'Jo Rivera', emergency_phone: '610-555-0199', discipline: 'snowboard', ability_level: 'intermediate', marketing_opt_in: true } });
  assert.equal(guest.status, 201, JSON.stringify(guest.body));
  ctx.sam = guest.body.id;
  const pass = (await api('POST', '/products', { token: A.owner, body: { kind: 'season_pass', name: 'Season Pass', base_price_cents: 40000, valid_days: 200 } })).body.id;
  assert.equal((await api('POST', '/orders', { token: A.owner, body: { person_id: ctx.sam, items: [{ product_id: pass }] } })).status, 201);
  assert.equal((await api('POST', `/people/${ctx.sam}/waivers`, { token: A.owner, body: {} })).status, 201);
  const mk = async (sku, category, extra = {}) => (await api('POST', '/rentals/items', { token: A.owner, body: { sku, category, size: '160', ...extra } })).body.id;
  const items = [await mk('SB-77', 'snowboard', { brand: 'Burton' }), await mk('BT-12', 'boot'), await mk('HL-5', 'helmet')];
  const out = await api('POST', '/rentals/contracts', { token: A.owner, body: { unpaid_reason: 'Test hand-out', person_id: ctx.sam, due_at: `${today}T16:30`, items: items.map((rental_item_id) => ({ rental_item_id })) } });
  assert.equal(out.status, 201, JSON.stringify(out.body));

  const lee = await api('POST', '/people', { token: A.owner, body: { first_name: 'Lee', last_name: 'Park', phone: '610.555.0111' } });
  ctx.lee = lee.body.id;
  const day = (await api('POST', '/products', { token: A.owner, body: { kind: 'day_ticket', name: 'Day', base_price_cents: 6000 } })).body.id;
  await api('POST', '/orders', { token: A.owner, body: { person_id: ctx.lee, items: [{ product_id: day, valid_on: addDays(today, -3) }] } });
  assert.equal((await api('POST', `/people/${ctx.lee}/waivers`, { token: A.owner, body: {} })).status, 201);
  const old = await mk('SK-OLD', 'ski');
  const c = await api('POST', '/rentals/contracts', { token: A.owner, body: { unpaid_reason: 'Test hand-out', person_id: ctx.lee, due_at: `${today}T16:30`, items: [{ rental_item_id: old }] } });
  await api('POST', `/rentals/contracts/${c.body.id}/checkin`, { token: A.owner, body: { items: [{ rental_item_id: old }] } });
  await pool.query("UPDATE rental_contracts SET checked_out_at = ?, checked_in_at = ? WHERE id = ?", [`${addDays(today, -2)} 09:00:00`, `${addDays(today, -2)} 15:00:00`, c.body.id]);
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('lookup finds a customer by name, email or phone however the number is written', async () => {
  const o = A.owner;
  for (const q of ['Sam Rivera', 'riv', 'sam@', '610-555-0100', '(610)555 0100', '+1 610 555 0100', '5550100']) {
    const r = await api('GET', `/people/lookup?q=${encodeURIComponent(q)}`, { token: o });
    assert.equal(r.status, 200);
    assert.ok(r.body.data.some((p) => p.id === ctx.sam), `"${q}" should find Sam`);
  }
  assert.equal((await api('GET', '/people/lookup?q=Rivera', { token: B.owner })).body.data.length, 0, 'another mountain sees nothing');
  assert.equal((await api('GET', '/people/lookup?q=a', { token: o })).body.data.length, 0, 'one letter is not a search');
  const front = (await api('GET', '/people/lookup?q=sam@', { token: T.counter })).body.data[0];
  assert.equal(front.summary.waiver_this_season, true);
  assert.deepEqual(front.summary.tickets_today, ['Season Pass']);
  assert.equal(front.summary.rental_out, true);
});

test('an exact email sorts above a looser match', async () => {
  await api('POST', '/people', { token: A.owner, body: { first_name: 'Samantha', last_name: 'Rivers', email: `sam@x-${suffix}.test` } });
  const r = await api('GET', `/people/lookup?q=${encodeURIComponent(`sam@${A.slug}.test`)}`, { token: A.owner });
  assert.equal(r.body.data[0].id, ctx.sam);
});

test('a sale finds the same customer by name and phone even when the phone is written differently', async () => {
  const day = (await api('GET', '/products', { token: A.owner })).body.data.find((p) => p.kind === 'day_ticket').id;
  const sale = await api('POST', '/orders', { token: A.owner, body: { purchaser: { first_name: 'Sam', last_name: 'Rivera', phone: '610 555 0100' }, items: [{ product_id: day }] } });
  assert.equal(sale.status, 201, JSON.stringify(sale.body));
  const found = (await api('GET', `/people/lookup?q=Rivera`, { token: A.owner })).body.data.filter((p) => p.first_name === 'Sam');
  assert.equal(found.length, 1, 'no duplicate Sam was created');
});

test('patrol lookups show the guest but not address, emergency contact or commerce details, and are logged', async () => {
  const r = await api('GET', '/people/lookup?q=Rivera', { token: T.patrol });
  const p = r.body.data.find((x) => x.id === ctx.sam);
  assert.ok(p);
  assert.equal(p.address_line1, undefined);
  assert.equal(p.emergency_name, undefined);
  assert.equal(p.marketing_opt_in, undefined);
  assert.equal(p.summary, undefined);
  assert.equal((await api('GET', '/people', { token: T.patrol })).status, 400, 'patrol cannot browse every customer');
  assert.equal((await api('GET', '/people?q=Riv', { token: T.patrol })).status, 200);
  const logged = await rowsOf("SELECT detail FROM audit_log WHERE tenant_id = (SELECT id FROM tenants WHERE slug = ?) AND action = 'lookup'", [A.slug]);
  assert.ok(logged.length >= 2);
  assert.ok(!JSON.stringify(logged).includes('Rivera'), 'the log records that a search happened, not what was typed');
});

test('patrol pulls ticket and rental details into a patient, one way only', async () => {
  const before = JSON.stringify([
    await rowsOf('SELECT * FROM people WHERE id = ? ORDER BY id', [ctx.sam]),
    await rowsOf('SELECT * FROM tickets WHERE person_id = ? ORDER BY id', [ctx.sam]),
    await rowsOf('SELECT * FROM orders WHERE person_id = ? ORDER BY id', [ctx.sam]),
    await rowsOf('SELECT * FROM rental_contracts WHERE person_id = ? ORDER BY id', [ctx.sam]),
    await rowsOf('SELECT * FROM rental_items WHERE tenant_id = (SELECT tenant_id FROM people WHERE id = ?) ORDER BY id', [ctx.sam]),
  ]);

  const c = (await newCase(T.patrol)).body;
  const preview = await api('GET', `/patrol/pull/${ctx.sam}?incident_id=${c.id}`, { token: T.patrol });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.tickets[0].name, 'Season Pass');
  assert.deepEqual(preview.body.rentals.map((r) => r.category).sort(), ['boot', 'helmet', 'snowboard']);
  const shown = JSON.stringify(preview.body);
  assert.equal(preview.body.person.address, '12 Mill Rd');
  assert.equal(preview.body.person.height, '5 ft 9 in');
  for (const secret of ['Jo Rivera', '610-555-0199', `sam@${A.slug}.test`, '40000']) assert.ok(!shown.includes(secret), `patrol must not see ${secret}`);

  const add = await api('POST', `/patrol/incidents/${c.id}/patients`, { token: T.patrol, body: { person_id: ctx.sam, chief_complaint: 'Wrist pain', helmet: 'no' } });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const got = (await api('GET', `/patrol/incidents/${c.id}`, { token: T.patrol })).body.patients[0];
  assert.equal(got.first_name, 'Sam');
  assert.equal(got.date_of_birth, '1990-05-01');
  assert.equal(got.phone, '(610) 555-0100');
  assert.equal(got.home_town, 'Phoenixville');
  assert.equal(got.form.address, '12 Mill Rd');
  assert.equal(got.form.region, 'PA');
  assert.equal(got.form.postal, '19460');
  assert.equal(got.form.height, '5 ft 9 in');
  assert.equal(got.form.weight, '165 lbs');
  assert.equal(got.activity, 'snowboard');
  assert.equal(got.ability, 'intermediate');
  assert.equal(got.rental_equipment, 'yes');
  assert.equal(got.helmet, 'no', 'what patrol entered is never overwritten by the pull');
  assert.equal(got.form.ticket_type, 'season_pass');
  assert.equal(got.form.equipment, 'area_rental');
  assert.equal(got.form.rental_boot, 'BT-12');
  assert.equal(got.form.rental_ski, 'SB-77');

  // refreshing fills blanks only
  await api('PATCH', `/patrol/incidents/${c.id}/patients/${got.id}`, { token: T.patrol, body: { phone: null, form: { ticket_type: 'day' } } });
  const refresh = await api('POST', `/patrol/incidents/${c.id}/patients/${got.id}/pull`, { token: T.patrol, body: {} });
  assert.equal(refresh.status, 200, JSON.stringify(refresh.body));
  const after = (await api('GET', `/patrol/incidents/${c.id}`, { token: T.patrol })).body.patients[0];
  assert.equal(after.phone, '(610) 555-0100');
  assert.equal(after.form.ticket_type, 'day', 'a value patrol set is kept');

  const end = JSON.stringify([
    await rowsOf('SELECT * FROM people WHERE id = ? ORDER BY id', [ctx.sam]),
    await rowsOf('SELECT * FROM tickets WHERE person_id = ? ORDER BY id', [ctx.sam]),
    await rowsOf('SELECT * FROM orders WHERE person_id = ? ORDER BY id', [ctx.sam]),
    await rowsOf('SELECT * FROM rental_contracts WHERE person_id = ? ORDER BY id', [ctx.sam]),
    await rowsOf('SELECT * FROM rental_items WHERE tenant_id = (SELECT tenant_id FROM people WHERE id = ?) ORDER BY id', [ctx.sam]),
  ]);
  assert.equal(end, before, 'nothing in the customer, ticket or rental records changed');
});

test('expired tickets and gear returned on an earlier day are not pulled', async () => {
  const c = (await newCase(T.patrol)).body;
  const r = (await api('GET', `/patrol/pull/${ctx.lee}?incident_id=${c.id}`, { token: T.patrol })).body;
  assert.equal(r.tickets.length, 0);
  assert.equal(r.rentals.length, 0);
  assert.equal(r.suggested.patient.rental_equipment, null);
});

test('only patrol and managers can pull, and only for their own mountain', async () => {
  assert.equal((await api('GET', `/patrol/pull/${ctx.sam}`, { token: T.counter })).status, 403);
  assert.equal((await api('GET', `/patrol/pull/${ctx.sam}`, { token: T.staff })).status, 403);
  assert.equal((await api('GET', `/patrol/pull/${ctx.sam}`, { token: B.owner })).status, 404);
  assert.equal((await api('GET', `/patrol/pull/${ctx.sam}`, { token: T.patrol })).status, 200);
});

test('a locked report cannot be changed by a pull', async () => {
  const c = (await newCase(T.patrol)).body;
  const p = (await api('POST', `/patrol/incidents/${c.id}/patients`, { token: T.patrol, body: { first_name: 'Ann', last_name: 'Lee', person_id: ctx.lee } })).body;
  await pool.query("UPDATE incidents SET report_state = 'approved' WHERE id = ?", [c.id]);
  assert.equal((await api('POST', `/patrol/incidents/${c.id}/patients/${p.id}/pull`, { token: T.patrol, body: {} })).status, 409);
});

test('the access log shows who looked at patient information, to patrol administrators only', async () => {
  assert.equal((await api('GET', '/patrol/access-log', { token: T.patrol })).status, 403, 'a regular patroller cannot read it');
  assert.equal((await api('GET', '/patrol/access-log', { token: T.counter })).status, 403);
  const log = await api('GET', '/patrol/access-log', { token: A.owner });
  assert.equal(log.status, 200);
  const actions = new Set(log.body.data.map((r) => r.action));
  for (const a of ['create', 'add_patient', 'lookup', 'pull_preview', 'pull_from_customer']) assert.ok(actions.has(a), `log has ${a}`);
  assert.ok(log.body.data.every((r) => r.user_email), 'every entry names a user');
  assert.ok(log.body.data.some((r) => r.case_number), 'case entries carry the case number');
  assert.equal((await api('GET', '/patrol/access-log', { token: B.owner })).body.data.length, 0, 'another mountain sees none of it');
  assert.ok((await api('GET', '/patrol/access-log', { token: A.owner })).body.data.some((r) => r.action === 'view_access_log'), 'reading the log is logged too');
});

test('responses are never cached and the case export carries no free text', async () => {
  const res = await fetch(`${base}/api/v1/patrol/incidents`, { headers: { authorization: `Bearer ${T.patrol}` } });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const csv = await fetch(`${base}/api/v1/patrol/incidents.csv`, { headers: { authorization: `Bearer ${A.owner}` } });
  assert.equal(csv.status, 200);
  assert.ok(!(await csv.text()).includes('Wrist injury'), 'the summary can hold a name, so it stays out');
});
