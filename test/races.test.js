'use strict';

// Two people (or one person tapping twice) acting at the same instant must not get past a limit.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base; let owner; let slug;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const tomorrow = fmt.format(new Date(Date.now() + 86400000));

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const burst = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
const count = (rs, status) => rs.filter((r) => r.status === status).length;
async function addLogin(role, extra = {}) {
  const email = `${role}-${Math.random().toString(36).slice(2, 7)}@${slug}.test`;
  const made = await api('POST', '/users', { token: owner, body: { email, password: PW, role, ...extra } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
}

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  slug = `rc-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  owner = (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('ten taps on "open drawer" open exactly one drawer', async () => {
  const counter = await addLogin('counter');
  const rs = await burst(10, () => api('POST', '/till/open', { token: counter, body: { opening_float_cents: 10000 } }));
  assert.equal(count(rs, 201), 1, JSON.stringify(rs.map((r) => r.status)));
  assert.equal(count(rs, 409), 9);
  const [[n]] = await pool.query("SELECT COUNT(*) AS n FROM till_sessions s JOIN users u ON u.id = s.opened_by WHERE s.status = 'open' AND u.tenant_id = (SELECT id FROM tenants WHERE slug = ?)", [slug]);
  assert.equal(n.n, 1);
});

test('a drawer move and the close cannot cross: nothing is added after the total is counted', async () => {
  const counter = await addLogin('counter');
  assert.equal((await api('POST', '/till/open', { token: counter, body: { opening_float_cents: 0 } })).status, 201);
  const rs = await burst(8, (i) => (i === 4 ? api('POST', '/till/close', { token: counter, body: { counted_cents: 0, notes: 'race' } }) : api('POST', '/till/moves', { token: counter, body: { kind: 'paid_in', amount_cents: 100 } })));
  const closed = rs[4];
  for (const [i, r] of rs.entries()) if (i !== 4) assert.ok([201, 409].includes(r.status), `a move answered ${r.status}: ${JSON.stringify(r.body)}`);
  assert.ok([200, 400].includes(closed.status), JSON.stringify(closed.body));
  // Every move that was accepted is part of the saved total; none was accepted after the close.
  const accepted = rs.filter((r, i) => i !== 4 && r.status === 201).length;
  if (closed.status === 200) {
    const expected = closed.body.till.expected_cents;
    assert.equal(expected, accepted * 100, 'the total counts every accepted move');
    const [[row]] = await pool.query("SELECT (SELECT COALESCE(SUM(amount_cents),0) FROM till_moves m WHERE m.till_id = s.id) AS moved FROM till_sessions s WHERE s.id = ?", [closed.body.till.id]);
    assert.equal(Number(row.moved), accepted * 100);
  }
});

test('two quick taps on "clock in" give one open punch', async () => {
  const staff = (await api('POST', '/workforce/staff', { token: owner, body: { person: { first_name: 'Ann', last_name: 'Racer' }, status: 'active' } })).body.id;
  const token = await addLogin('staff', { staff_id: staff });
  const rs = await burst(10, () => api('POST', '/workforce/time/clock-in', { token, body: {} }));
  assert.equal(count(rs, 201), 1, JSON.stringify(rs.map((r) => r.status)));
  assert.equal(count(rs, 409), 9);
  const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM time_entries WHERE staff_id = ? AND clock_out IS NULL', [staff]);
  assert.equal(n.n, 1);
});

test('the last seats in a lesson go to exactly as many people as there are seats', async () => {
  const prod = (await api('POST', '/products', { token: owner, body: { kind: 'lesson', name: 'Race Lesson', base_price_cents: 5000 } })).body.id;
  const sess = (await api('POST', '/skischool/sessions', { token: owner, body: { product_id: prod, starts_at: `${tomorrow}T10:00`, ends_at: `${tomorrow}T12:00`, capacity: 2 } })).body.id;
  const people = [];
  for (let i = 0; i < 6; i += 1) people.push((await api('POST', '/people', { token: owner, body: { first_name: `Kid${i}`, last_name: 'Racer' } })).body.id);
  const rs = await burst(6, (i) => api('POST', `/skischool/sessions/${sess}/bookings`, { token: owner, body: { person_id: people[i], sign_waiver: true } }));
  assert.equal(count(rs, 201), 2, JSON.stringify(rs.map((r) => [r.status, r.body.error])));
  assert.equal(count(rs, 409), 4);

  // Cancel one, let someone else take the seat, then try to bring the first one back: the lesson is full again.
  const roster = (await api('GET', `/skischool/sessions/${sess}/roster`, { token: owner })).body.data;
  const first = roster[0];
  assert.equal((await api('PATCH', `/skischool/bookings/${first.booking_id}`, { token: owner, body: { status: 'cancelled' } })).status, 200);
  const free = people.find((p) => !roster.some((r) => r.person_id === p));
  assert.equal((await api('POST', `/skischool/sessions/${sess}/bookings`, { token: owner, body: { person_id: free, sign_waiver: true } })).status, 201);
  const back = await api('PATCH', `/skischool/bookings/${first.booking_id}`, { token: owner, body: { status: 'booked' } });
  assert.equal(back.status, 409, JSON.stringify(back.body));
});
