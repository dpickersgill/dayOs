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

test('the standard menus: each role its own work apps, Home never in them, and it opens on one of them or on Home', () => {
  assert.deepEqual(menus.STANDARD.owner, { apps: ['money', 'conditions', 'patrol', 'school', 'people', 'workforce'], start: 'dashboard' });
  assert.deepEqual(menus.STANDARD.manager, { apps: ['conditions', 'sell', 'patrol', 'school', 'people', 'workforce'], start: 'dashboard' });
  assert.deepEqual(menus.STANDARD.counter, { apps: ['sell', 'gate', 'rentals', 'people', 'waivers', 'shop'], start: 'sell' });
  assert.deepEqual(menus.STANDARD.instructor, { apps: ['school', 'availability', 'people', 'waivers'], start: 'school' });
  assert.deepEqual(menus.STANDARD.staff, { apps: ['conditions', 'gate', 'lostfound'], start: 'dashboard' });
  assert.deepEqual(menus.STANDARD.patrol, { apps: ['patrol', 'conditions'], start: 'patrol' });
  assert.deepEqual(menus.HOME, ['dashboard', 'inbox', 'calendar', 'myshifts']);
  for (const [role, m] of Object.entries(menus.STANDARD).filter(([r]) => menus.ROLES.includes(r))) {
    assert.ok(m.apps.includes(m.start) || menus.HOME.includes(m.start), `${role} opens on an app in its menu or on Home`);
    for (const k of menus.HOME) assert.ok(!m.apps.includes(k), `${role}: ${k} is pinned, not in the menu`);
    for (const k of m.apps) assert.ok(menus.ROLE_APPS[role].includes(k), `${role} may open ${k}`);
  }
  assert.ok(!menus.ROLE_APPS.owner.includes('availability') && !menus.ROLE_APPS.manager.includes('availability'), 'availability is a Lessons tab for owners and managers');
  assert.deepEqual(menus.menuFor('owner', null), menus.STANDARD.owner);
  assert.deepEqual(menus.menuFor('manager', '{"counter":{"apps":["gate"],"start":"gate"}}'), menus.STANDARD.manager);
  assert.equal(menus.menuFor('area', null), null, 'the ski area login has no menu');
  assert.deepEqual(menus.menuFor('counter', null), menus.STANDARD.counter, 'nothing stored: the standard menu');
  assert.deepEqual(menus.menuFor('counter', 'not json'), menus.STANDARD.counter);
  assert.deepEqual(menus.menuFor('counter', { counter: { apps: ['gate', 'sell'], start: 'gate' } }), { apps: ['gate', 'sell'], start: 'gate' });
  assert.deepEqual(menus.menuFor('counter', { counter: { apps: ['money'], start: 'money' } }), menus.STANDARD.counter, 'a stored menu that no longer checks out falls back to the standard');
});

test('menus saved before Home was pinned drop Today, Inbox, Calendar and My shifts when read', () => {
  const old = { counter: { apps: ['gate', 'sell', 'inbox', 'myshifts', 'calendar'], start: 'gate' }, staff: { apps: ['dashboard', 'gate', 'inbox', 'myshifts'], start: 'dashboard' }, patrol: { apps: ['inbox', 'myshifts'], start: 'inbox' } };
  const read = menus.parse(JSON.stringify(old));
  assert.deepEqual(read.counter, { apps: ['gate', 'sell'], start: 'gate' });
  assert.deepEqual(read.staff, { apps: ['gate'], start: 'dashboard' }, 'it can still open on Today');
  assert.equal(read.patrol, undefined, 'a menu of only Home apps is empty, so the standard one is used');
  assert.deepEqual(menus.menuFor('patrol', old), menus.STANDARD.patrol);
  // A counter menu that held Instructor availability: it is a Lessons tab for the counter now.
  assert.deepEqual(menus.parse({ counter: { apps: ['sell', 'availability'], start: 'availability' } }).counter, { apps: ['sell'], start: 'sell' });
  // check() leaves Home out of a menu being saved, and refuses one with nothing else.
  assert.deepEqual(menus.check('owner', { apps: ['dashboard', 'money', 'inbox'], start: 'dashboard' }).menu, { apps: ['money'], start: 'dashboard' });
  assert.match(menus.check('owner', { apps: ['dashboard', 'inbox'], start: 'dashboard' }).problem, /at least one app/);
});

test('/auth/me carries the menu for the person\'s role, owners and managers included', async () => {
  assert.deepEqual(ok(await api('GET', '/auth/me', { token: T.owner })).menu, menus.STANDARD.owner);
  assert.deepEqual(ok(await api('GET', '/auth/me', { token: T.manager })).menu, menus.STANDARD.manager);
  for (const role of ['counter', 'instructor', 'staff', 'patrol']) assert.deepEqual(ok(await api('GET', '/auth/me', { token: T[role] })).menu, menus.STANDARD[role], role);
});

test('managers can read the menus; only the owner can change them', async () => {
  const seen = ok(await api('GET', '/settings/menus', { token: T.manager }));
  assert.equal(seen.can_change, false);
  assert.equal(seen.roles.counter.standard, true);
  assert.deepEqual(seen.roles.counter.apps, menus.STANDARD.counter.apps);
  assert.ok(seen.roles.counter.can_open.includes('lostfound'));
  assert.deepEqual(seen.home, ['dashboard', 'inbox', 'calendar', 'myshifts'], 'Home, shown as fixed');
  assert.deepEqual(seen.roles.owner.apps, menus.STANDARD.owner.apps, 'the owner menu can be seen and changed too');
  assert.deepEqual(seen.roles.manager.apps, menus.STANDARD.manager.apps);
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
  await bad({ role: 'manager', menu: { apps: ['availability'], start: 'availability' } }, 'availability is a Lessons tab for managers', /cannot be opened/);
  await bad({ role: 'area', menu: { apps: ['patrol'], start: 'patrol' } }, 'no menu for the ski area login');
  await bad({ role: 'counter', menu: { apps: ['inbox', 'myshifts'], start: 'inbox' } }, 'only Home apps', /at least one app/);
  await bad({ role: 'counter', menu: { apps: [], start: 'sell' } }, 'empty');
  await bad({ role: 'counter' }, 'no menu given');

  const out = ok(await api('PUT', '/settings/menus', { token: T.owner, body: { role: 'counter', menu: { apps: ['gate', 'sell', 'lostfound', 'myshifts'], start: 'gate' } } }));
  assert.deepEqual(out.menu, { apps: ['gate', 'sell', 'lostfound'], start: 'gate' }, 'My shifts is pinned in Home, so it is left out of the menu');
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
  assert.deepEqual(me.menu.apps, ['assets', 'gate']);
  ok(await api('PUT', '/settings/menus', { token: T.owner, body: { role: 'staff', menu: null } }));
});

test('the owner changes the owner and manager menus with the same checks; a manager may not', async () => {
  const body = { role: 'manager', menu: { apps: ['sell', 'gate', 'conditions'], start: 'sell' } };
  assert.equal((await api('PUT', '/settings/menus', { token: T.manager, body })).status, 403);
  const out = ok(await api('PUT', '/settings/menus', { token: T.owner, body }));
  assert.deepEqual(out.menu, { apps: ['sell', 'gate', 'conditions'], start: 'sell' });
  assert.deepEqual(ok(await api('GET', '/auth/me', { token: T.manager })).menu, out.menu);
  assert.deepEqual(ok(await api('GET', '/auth/me', { token: T.owner })).menu, menus.STANDARD.owner, 'the owner menu is its own');
  const mine = ok(await api('PUT', '/settings/menus', { token: T.owner, body: { role: 'owner', menu: { apps: ['money', 'messages'], start: 'calendar' } } }));
  assert.deepEqual(mine.menu, { apps: ['money', 'messages'], start: 'calendar' }, 'it may open on a Home app');
  for (const role of ['manager', 'owner']) ok(await api('PUT', '/settings/menus', { token: T.owner, body: { role, menu: null } }));
  assert.deepEqual(ok(await api('GET', '/auth/me', { token: T.manager })).menu, menus.STANDARD.manager);
});
