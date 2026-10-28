'use strict';

// Menus for each role: the standard menus, an owner's changes (checked, audited, owner only), and the menu each
// person gets on /auth/me.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const menus = require('../src/lib/menus');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const slug = `menus-${suffix}`;
const PW = 'correct-horse-battery';
const T = {};
let tenantId;

async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const parsed = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const login = async (email) => ok(await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).token;

test.before(async () => {
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Menus Test Mountain', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  T.owner = await login(`owner@${slug}.test`);
  for (const role of ['manager', 'counter', 'instructor', 'staff', 'patrol']) {
    ok(await api('POST', '/users', { token: T.owner, body: { email: `${role}@${slug}.test`, password: PW, role } }));
    T[role] = await login(`${role}@${slug}.test`);
  }
  tenantId = (await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]))[0][0].id;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('the standard menus: each role its own apps, Inbox and My shifts always in, and it opens on one of them', () => {
  assert.deepEqual(menus.STANDARD.counter, { apps: ['sell', 'gate', 'rentals', 'people', 'waivers', 'shop', 'inbox', 'myshifts'], start: 'sell' });
  assert.deepEqual(menus.STANDARD.instructor, { apps: ['school', 'availability', 'people', 'waivers', 'inbox', 'myshifts'], start: 'school' });
  assert.deepEqual(menus.STANDARD.staff, { apps: ['dashboard', 'conditions', 'gate', 'lostfound', 'inbox', 'myshifts'], start: 'dashboard' });
  assert.deepEqual(menus.STANDARD.patrol, { apps: ['patrol', 'conditions', 'inbox', 'myshifts'], start: 'patrol' });
  for (const [role, m] of Object.entries(menus.STANDARD)) {
    assert.ok(m.apps.includes(m.start), `${role} opens on an app in its menu`);
    for (const k of menus.ALWAYS) assert.ok(m.apps.includes(k), `${role} has ${k}`);
    for (const k of m.apps) assert.ok(menus.ROLE_APPS[role].includes(k), `${role} may open ${k}`);
  }
  assert.equal(menus.menuFor('owner', null), null);
  assert.equal(menus.menuFor('manager', '{"counter":{"apps":["gate"],"start":"gate"}}'), null);
  assert.deepEqual(menus.menuFor('counter', null), menus.STANDARD.counter, 'nothing stored: the standard menu');
  assert.deepEqual(menus.menuFor('counter', 'not json'), menus.STANDARD.counter);
  assert.deepEqual(menus.menuFor('counter', { counter: { apps: ['gate', 'sell'], start: 'gate' } }), { apps: ['gate', 'sell', 'inbox', 'myshifts'], start: 'gate' });
  assert.deepEqual(menus.menuFor('counter', { counter: { apps: ['money'], start: 'money' } }), menus.STANDARD.counter, 'a stored menu that no longer checks out falls back to the standard');
});

test('/auth/me carries the menu for the person\'s role, and none for owners and managers', async () => {
  assert.equal(ok(await api('GET', '/auth/me', { token: T.owner })).menu, null);
  assert.equal(ok(await api('GET', '/auth/me', { token: T.manager })).menu, null);
  for (const role of ['counter', 'instructor', 'staff', 'patrol']) assert.deepEqual(ok(await api('GET', '/auth/me', { token: T[role] })).menu, menus.STANDARD[role], role);
});

test('managers can read the menus; only the owner can change them', async () => {
  const seen = ok(await api('GET', '/settings/menus', { token: T.manager }));
  assert.equal(seen.can_change, false);
  assert.equal(seen.roles.counter.standard, true);
  assert.deepEqual(seen.roles.counter.apps, menus.STANDARD.counter.apps);
  assert.ok(seen.roles.counter.can_open.includes('lostfound'));
  assert.equal(ok(await api('GET', '/settings/menus', { token: T.owner })).can_change, true);
  assert.equal((await api('GET', '/settings/menus', { token: T.counter })).status, 403);
  const body = { role: 'counter', menu: { apps: ['gate', 'sell'], start: 'gate' } };
  assert.equal((await api('PUT', '/settings/menus', { token: T.manager, body })).status, 403);
  assert.equal((await api('PUT', '/settings/menus', { token: T.counter, body })).status, 403);
});

test('an owner changes a role\'s menu: checked, kept, audited, and on /auth/me straight away', async () => {
  const bad = async (body, what, re) => { const r = await api('PUT', '/settings/menus', { token: T.owner, body }); assert.equal(r.status, 400, what); if (re) assert.match(JSON.stringify(r.body), re, what); };
  await bad({ role: 'counter', menu: { apps: ['sell', 'nonsense'], start: 'sell' } }, 'unknown app', /Not an app: nonsense/);
  await bad({ role: 'counter', menu: { apps: ['sell', 'money'], start: 'sell' } }, 'an app the role cannot open', /Money|money/);
  await bad({ role: 'counter', menu: { apps: ['sell', 'gate'], start: 'rentals' } }, 'opens on an app not in the menu', /must be one of the apps/);
  await bad({ role: 'manager', menu: { apps: ['sell'], start: 'sell' } }, 'managers see everything');
  await bad({ role: 'counter', menu: { apps: [], start: 'sell' } }, 'empty');
  await bad({ role: 'counter' }, 'no menu given');

  const out = ok(await api('PUT', '/settings/menus', { token: T.owner, body: { role: 'counter', menu: { apps: ['gate', 'sell', 'lostfound', 'myshifts'], start: 'gate' } } }));
  assert.deepEqual(out.menu, { apps: ['gate', 'sell', 'lostfound', 'myshifts', 'inbox'], start: 'gate' }, 'Inbox is always in');
  assert.equal(out.standard, false);
  assert.deepEqual(ok(await api('GET', '/auth/me', { token: T.counter })).menu, out.menu);
  assert.deepEqual(ok(await api('GET', '/auth/me', { token: T.instructor })).menu, menus.STANDARD.instructor, 'other roles keep the standard menu');
  const state = ok(await api('GET', '/settings/menus', { token: T.manager }));
  assert.equal(state.roles.counter.standard, false);
  assert.equal(state.roles.instructor.standard, true);

  const [[a]] = await pool.query("SELECT detail FROM audit_log WHERE tenant_id = ? AND action = 'update_role_menu' ORDER BY id DESC LIMIT 1", [tenantId]);
  const d = parsed(a.detail);
  assert.equal(d.role, 'counter');
  assert.equal(d.before, null);
  assert.deepEqual(d.after, out.menu);

  // put back the standard menu
  const back = ok(await api('PUT', '/settings/menus', { token: T.owner, body: { role: 'counter', menu: null } }));
  assert.equal(back.standard, true);
  assert.deepEqual(back.menu, menus.STANDARD.counter);
  assert.deepEqual(ok(await api('GET', '/auth/me', { token: T.counter })).menu, menus.STANDARD.counter);
  const [[b]] = await pool.query("SELECT detail FROM audit_log WHERE tenant_id = ? AND action = 'update_role_menu' ORDER BY id DESC LIMIT 1", [tenantId]);
  assert.deepEqual(parsed(b.detail).before, out.menu);
  assert.equal(parsed(b.detail).after, null);
  const [[t]] = await pool.query('SELECT role_menus FROM tenants WHERE id = ?', [tenantId]);
  assert.equal(t.role_menus, null, 'nothing kept once every role is back to the standard');
});

test('a menu can hold an app the mountain has turned off (the app hides it until it is on)', async () => {
  ok(await api('PUT', '/settings/menus', { token: T.owner, body: { role: 'staff', menu: { apps: ['assets', 'gate'], start: 'gate' } } }));
  const me = ok(await api('GET', '/auth/me', { token: T.staff }));
  assert.ok(!me.modules.includes('assets'), 'Assets and fleet is an add-on, off here');
  assert.deepEqual(me.menu.apps, ['assets', 'gate', 'inbox', 'myshifts']);
  ok(await api('PUT', '/settings/menus', { token: T.owner, body: { role: 'staff', menu: null } }));
});
