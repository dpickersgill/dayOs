'use strict';

// Guest types each mountain can edit: every mountain starts with the five it always had (so old prices and sales carry
// straight over), managers add, rename, set ages, hide and reorder, a hidden type cannot be sold, a type with prices or
// sales can only be hidden, online pricing by age uses the narrowest range, and one mountain's types are its own.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const GT = require('../src/lib/guesttypes');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${r.text}`);
async function mountain(tag) {
  const slug = `gt${tag}-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: `Types ${tag}`, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  const owner = await login(`owner@${slug}.test`);
  is(await api('POST', '/users', { token: owner, body: { email: `counter@${slug}.test`, password: PW, role: 'counter' } }), 201);
  return { slug, owner, counter: await login(`counter@${slug}.test`), id: (await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]))[0][0].id };
}
const sell = (m, tier, total) => api('POST', '/checkout', { token: m.counter, body: { quick: true, lines: [{ type: 'ticket', product_id: m.day, tier }], payments: [{ tender: 'cash', amount_cents: total }] } });

let A; let B;
test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain('a'); B = await mountain('b');
  A.day = (await api('POST', '/products', { token: A.owner, body: { kind: 'day_ticket', name: 'Adult Day', base_price_cents: 6000 } })).body.id;
  B.day = (await api('POST', '/products', { token: B.owner, body: { kind: 'day_ticket', name: 'Day', base_price_cents: 5000 } })).body.id;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('every mountain starts with the five types, and old prices by type carry straight over', async () => {
  const t = (await api('GET', '/guest-types', { token: A.counter })).body.types;
  assert.deepEqual(t.map((x) => x.code), ['adult', 'youth', 'child', 'senior', 'military']);
  assert.deepEqual(t.find((x) => x.code === 'child'), { code: 'child', name: 'Child', min_age: 0, max_age: 12, online: true, hidden: false, sort: 3 });
  is(await api('PUT', `/products/${A.day}/tiers`, { token: A.owner, body: { tiers: [{ tier: 'child', price_cents: 3000 }, { tier: 'military', price_cents: 4500 }] } }), 200);
  const s = await sell(A, 'child', 3000);
  is(s, 201, 'a child ticket sells at the child price');
});

test('managers add, rename, set ages and reorder; staff can only look', async () => {
  is(await api('POST', '/guest-types', { token: A.counter, body: { name: 'College' } }), 403);
  const c = await api('POST', '/guest-types', { token: A.owner, body: { name: 'College student', min_age: 18, max_age: 24 } });
  is(c, 201); assert.equal(c.body.code, 'college_student'); assert.equal(c.body.online, true);
  is(await api('POST', '/guest-types', { token: A.owner, body: { name: 'college STUDENT' } }), 409, 'no two with the same name');
  is(await api('POST', '/guest-types', { token: A.owner, body: { name: 'Odd', min_age: 30, max_age: 20 } }), 400, 'ages the wrong way round');
  is(await api('PUT', `/products/${A.day}/tiers`, { token: A.owner, body: { tiers: [{ tier: 'college_student', price_cents: 4000 }] } }), 200);
  is(await sell(A, 'college_student', 4000), 201, 'the new type sells at its own price');
  const r = await api('PATCH', '/guest-types/child', { token: A.owner, body: { name: 'Kids' } });
  is(r, 200); assert.equal(r.body.name, 'Kids');
  is(await sell(A, 'child', 3000), 201, 'renamed, it keeps its code and its prices');
  const order = ['college_student', 'adult', 'child', 'youth', 'senior', 'military'];
  is(await api('POST', '/guest-types/order', { token: A.owner, body: { codes: order.slice(1) } }), 400, 'every type must be in the new order');
  const o = await api('POST', '/guest-types/order', { token: A.owner, body: { codes: order } });
  is(o, 200); assert.deepEqual(o.body.types.map((x) => x.code), order);
});

test('a hidden type is not sold; a type with prices or sales can be hidden but not deleted; one must stay visible', async () => {
  is(await api('PATCH', '/guest-types/military', { token: A.owner, body: { hidden: true } }), 200);
  const s = await sell(A, 'military', 4500);
  is(s, 400); assert.match(s.body.error, /hidden/);
  is(await api('DELETE', '/guest-types/military', { token: A.owner }), 409, 'it has a price, so it stays');
  const tmp = await api('POST', '/guest-types', { token: A.owner, body: { name: 'Twilight' } });
  is(await api('DELETE', `/guest-types/${tmp.body.code}`, { token: A.owner }), 200, 'never priced or sold: deleted');
  is(await api('PATCH', '/guest-types/military', { token: A.owner, body: { hidden: false } }), 200);
  is(await sell(A, 'military', 4500), 201, 'shown again, it sells');
  for (const c of ['adult', 'youth', 'child', 'senior', 'military']) await api('PATCH', `/guest-types/${c}`, { token: B.owner, body: { hidden: true } });
  const last = await api('PATCH', '/guest-types/military', { token: B.owner, body: { hidden: true } });
  const visible = (await api('GET', '/guest-types', { token: B.owner })).body.types.filter((x) => !x.hidden);
  assert.equal(visible.length, 1, 'the last visible type cannot be hidden'); assert.ok([200, 409].includes(last.status));
  for (const c of ['adult', 'youth', 'child', 'senior']) await api('PATCH', `/guest-types/${c}`, { token: B.owner, body: { hidden: false } });
});

test('online, a guest’s age picks the narrowest type that fits; another mountain’s types are not known here', async () => {
  const types = await GT.list(pool, A.id);
  assert.equal(GT.forAge(types, 20), 'college_student', '18 to 24 is narrower than 18 to 64');
  assert.equal(GT.forAge(types, 30), 'adult');
  assert.equal(GT.forAge(types, 8), 'child');
  assert.equal(GT.forAge(types, 70), 'senior');
  assert.equal(await GT.forBirthday(pool, A.id, '2005-06-01', '2026-12-01'), 'college_student');
  is(await sell(B, 'college_student', 5000), 400, 'B has no College type');
  is(await api('PUT', `/products/${B.day}/tiers`, { token: B.owner, body: { tiers: [{ tier: 'college_student', price_cents: 1 }] } }), 400);
  await pool.query('UPDATE tenants SET online_shop = 1 WHERE id IN (?, ?)', [A.id, B.id]);
  const shop = await fetch(`${base}/api/v1/public/${A.slug}/shop`).then((r) => r.json());
  assert.ok(shop.guest_types.some((t) => t.code === 'college_student' && t.name === 'College student'), 'the online shop gets the names');
  assert.ok(!(await fetch(`${base}/api/v1/public/${B.slug}/shop`).then((r) => r.json())).guest_types.some((t) => t.code === 'college_student'));
});
