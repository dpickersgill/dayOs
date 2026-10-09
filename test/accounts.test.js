'use strict';

// Logins, sessions and the web app: change-password, immediate effect of deactivation and role changes,
// staff self-service limits, and the static admin page with its security headers.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000'; // these tests sign in many times from one address

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server;
let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function raw(method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
const api = (m, p, o) => raw(m, `/api/v1${p}`, o);

const slug = `acct-${suffix}`;
const PW = 'correct-horse-battery';
let owner;
const ids = {};

async function login(email, password = PW) {
  const r = await api('POST', '/auth/login', { body: { tenant: slug, email, password } });
  return r;
}
async function addLogin(email, role, extra = {}) {
  const r = await api('POST', '/users', { token: owner, body: { email, password: PW, role, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const l = await login(email);
  assert.equal(l.status, 200);
  return { token: l.body.token, id: r.body.id };
}

test.before(async () => {
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const t = await api('POST', '/tenants', {
    body: { slug, name: 'Account Test Mountain', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } },
    token: undefined,
  });
  // tenant creation needs the bootstrap header, which api() cannot pass, so call fetch directly
  assert.equal(t.status, 403);
  const res = await fetch(`${base}/api/v1/tenants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' },
    body: JSON.stringify({ slug, name: 'Account Test Mountain', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }),
  });
  assert.equal(res.status, 201);
  owner = (await login(`owner@${slug}.test`)).body.token;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('change password: checks the current one, signs out other sessions, keeps this one', async () => {
  const me = await addLogin(`pw@${slug}.test`, 'counter');
  const second = (await login(`pw@${slug}.test`)).body.token; // a second device
  await sleep(1100); // tokens are dated to the second

  const wrong = await api('POST', '/auth/change-password', { token: me.token, body: { current_password: 'nope-nope-nope', new_password: 'another-long-password' } });
  assert.equal(wrong.status, 403);
  const same = await api('POST', '/auth/change-password', { token: me.token, body: { current_password: PW, new_password: PW } });
  assert.equal(same.status, 400);
  const short = await api('POST', '/auth/change-password', { token: me.token, body: { current_password: PW, new_password: 'short' } });
  assert.equal(short.status, 400);

  const ok = await api('POST', '/auth/change-password', { token: me.token, body: { current_password: PW, new_password: 'another-long-password' } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);

  assert.equal((await api('GET', '/auth/me', { token: ok.body.token })).status, 200, 'the fresh token works');
  assert.equal((await api('GET', '/auth/me', { token: me.token })).status, 401, 'the old token on this device is ended');
  assert.equal((await api('GET', '/auth/me', { token: second })).status, 401, 'other devices are signed out');
  assert.equal((await login(`pw@${slug}.test`)).status, 401, 'old password no longer works');
  assert.equal((await login(`pw@${slug}.test`, 'another-long-password')).status, 200);
});

test('deactivating a login ends its session immediately', async () => {
  const u = await addLogin(`gone@${slug}.test`, 'staff');
  assert.equal((await api('GET', '/auth/me', { token: u.token })).status, 200);
  assert.equal((await api('PATCH', `/users/${u.id}`, { token: owner, body: { active: false } })).status, 200);
  assert.equal((await api('GET', '/auth/me', { token: u.token })).status, 401);
  assert.equal((await login(`gone@${slug}.test`)).status, 401);
  assert.equal((await api('PATCH', `/users/${u.id}`, { token: owner, body: { active: true } })).status, 200);
  assert.equal((await login(`gone@${slug}.test`)).status, 200, 'reactivated login can sign in again');
});

test('a role change applies to a token that was already issued', async () => {
  const u = await addLogin(`role@${slug}.test`, 'counter');
  const products = await api('GET', '/products', { token: u.token });
  assert.equal(products.status, 200);
  assert.equal((await api('PATCH', `/users/${u.id}`, { token: owner, body: { role: 'patrol' } })).status, 200);
  assert.equal((await api('GET', '/products', { token: u.token })).status, 403, 'same token, new role');
});

test('managers reset passwords for staff but not for the owner or other managers', async () => {
  const mgr = await addLogin(`mgr@${slug}.test`, 'manager');
  const mgr2 = await addLogin(`mgr2@${slug}.test`, 'manager');
  const worker = await addLogin(`worker@${slug}.test`, 'staff');
  const ownerRow = (await api('GET', '/users', { token: owner })).body.data.find((u) => u.role === 'owner');

  assert.equal((await api('POST', `/users/${ownerRow.id}/reset-password`, { token: mgr.token, body: { new_password: 'brand-new-password' } })).status, 403);
  assert.equal((await api('POST', `/users/${mgr2.id}/reset-password`, { token: mgr.token, body: { new_password: 'brand-new-password' } })).status, 403);
  assert.equal((await api('PATCH', `/users/${mgr.id}`, { token: mgr.token, body: { active: false } })).status, 403, 'cannot deactivate yourself');

  await sleep(1100);
  assert.equal((await api('POST', `/users/${worker.id}/reset-password`, { token: mgr.token, body: { new_password: 'brand-new-password' } })).status, 200);
  assert.equal((await api('GET', '/auth/me', { token: worker.token })).status, 401, 'their old session ends');
  assert.equal((await login(`worker@${slug}.test`, 'brand-new-password')).status, 200);
  assert.equal((await api('GET', '/auth/me', { token: mgr.token })).status, 200, 'the manager is not signed out');
});

test('staff logins: linked to one staff record, limited to themselves', async () => {
  const mk = async (first) => (await api('POST', '/workforce/staff', { token: owner, body: { person: { first_name: first, last_name: 'Tester' }, status: 'active' } })).body.id;
  const s1 = await mk('Ann');
  const s2 = await mk('Bo');
  ids.s1 = s1; ids.s2 = s2;

  const unlinked = await addLogin(`unlinked@${slug}.test`, 'staff');
  const clockNoLink = await api('POST', '/workforce/time/clock-in', { token: unlinked.token, body: {} });
  assert.equal(clockNoLink.status, 403);
  assert.match(clockNoLink.body.error, /not linked/i);
  assert.deepEqual((await api('GET', '/workforce/me', { token: unlinked.token })).body, { linked: false, open_entry: null, shifts: [] });

  const linked = await addLogin(`ann@${slug}.test`, 'staff', { staff_id: s1 });
  const dup = await api('POST', '/users', { token: owner, body: { email: `ann2@${slug}.test`, password: PW, role: 'staff', staff_id: s1 } });
  assert.equal(dup.status, 409, 'one login per staff record');

  assert.equal((await api('GET', '/workforce/me', { token: linked.token })).body.linked, true);
  assert.equal((await api('POST', '/workforce/time/clock-in', { token: linked.token, body: { staff_id: s2 } })).status, 403, 'cannot clock in someone else');
  assert.equal((await api('POST', '/workforce/time/clock-in', { token: linked.token, body: {} })).status, 201);
  assert.equal((await api('POST', '/workforce/time/clock-in', { token: linked.token, body: {} })).status, 409, 'already clocked in');
  assert.ok((await api('GET', '/workforce/me', { token: linked.token })).body.open_entry);
  assert.equal((await api('POST', '/workforce/time/clock-out', { token: linked.token, body: {} })).status, 200);

  assert.equal((await api('GET', '/workforce/staff', { token: linked.token })).status, 403, 'staff list is managers only');
  assert.equal((await api('GET', `/workforce/staff/${s2}/certifications`, { token: linked.token })).status, 403);
  assert.equal((await api('GET', `/workforce/staff/${s1}/certifications`, { token: linked.token })).status, 200);
  const win = { windows: [{ weekday: 1, start_time: '08:00', end_time: '16:00' }] };
  assert.equal((await api('PUT', `/workforce/staff/${s2}/availability`, { token: linked.token, body: win })).status, 403);
  assert.equal((await api('PUT', `/workforce/staff/${s1}/availability`, { token: linked.token, body: win })).status, 200);

  assert.equal((await api('GET', '/people', { token: linked.token })).status, 403, 'general staff cannot browse guest records');
});

test('a manager login can use the clock and see only their own record without staff_id guesswork', async () => {
  const mgr = await addLogin(`mgrlink@${slug}.test`, 'manager', { staff_id: ids.s2 });
  assert.equal((await api('POST', '/workforce/time/clock-in', { token: mgr.token, body: {} })).status, 201);
  assert.equal((await api('POST', '/workforce/time/clock-out', { token: mgr.token, body: {} })).status, 200);
  const noLinkMgr = await addLogin(`mgrnolink@${slug}.test`, 'manager');
  assert.equal((await api('POST', '/workforce/time/clock-in', { token: noLinkMgr.token, body: {} })).status, 400, 'a manager without a link must say whose clock');
});

test('the admin web app is served with strict security headers', async () => {
  const home = await raw('GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.match(home.body, /<script type="module" src="\/js\/main\.js">/);
  assert.doesNotMatch(home.body.replace(/<script type="module" src="[^"]*"><\/script>/g, ''), /<script/i, 'no inline scripts');
  const csp = home.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp.match(/script-src[^;]*/)[0], /unsafe-inline/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(home.headers.get('cache-control'), 'no-cache');

  for (const p of ['/js/main.js', '/js/api.js', '/js/ui.js', '/css/app.css']) {
    const r = await raw('GET', p);
    assert.equal(r.status, 200, p);
  }
  assert.match((await raw('GET', '/js/main.js')).headers.get('content-type'), /javascript/);
  const font = await raw('GET', '/fonts/atkinson-hyperlegible-latin-700-normal.woff2');
  assert.equal(font.status, 200);
  assert.match(font.headers.get('cache-control'), /immutable/);
});

test('unknown API paths return JSON, and the app does not expose source outside public/', async () => {
  assert.equal((await api('GET', '/does-not-exist')).status, 401, 'signed-out callers learn nothing about routes');
  const miss = await api('GET', '/does-not-exist', { token: owner });
  assert.equal(miss.status, 404);
  assert.equal(typeof miss.body.error, 'string');
  for (const p of ['/package.json', '/src/app.js', '/db/schema.sql', '/.env', '/../package.json', '/%2e%2e/package.json']) {
    const r = await raw('GET', p);
    assert.notEqual(r.status, 200, p);
    assert.doesNotMatch(String(r.body), /"dependencies"|CREATE TABLE|jwtSecret/, p);
  }
});
