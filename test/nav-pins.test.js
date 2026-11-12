'use strict';

// Pins (2026.11.21): the top of a person's menu. With nothing saved they are the role's menu as the owner set it (its
// apps and shortcuts, in order); a person can pin any page they may open, reorder, rename and reset, and their list
// follows them to every device. Checked here through the API: the starting pins of every role (ski area and
// municipality), saving and its limits, what a page address may be, that nobody reaches another person's or another
// tenant's pins, a shared counter computer (a PIN session), an owner's change to a role's menu, an app turned off, the
// row going with the login, and the migration step run twice.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.MODULE_CACHE_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const menus = require('../src/lib/menus');
const modules = require('../src/lib/modules');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';

async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);
const q = async (sql, params) => (await pool.query(sql, params))[0];

/** A tenant with its owner signed in: { slug, id, T: { owner: token }, U: { key: user id } }. */
async function tenant(tag, extra = {}) {
  const slug = `pins${tag}-${suffix}`;
  is(await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: `Pins ${tag}`, ...extra, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) }), 201);
  const M = { slug, id: (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id, T: {}, U: {}, S: {} };
  M.login = async (who) => ok(await api('POST', '/auth/login', { body: { tenant: slug, login: who, password: PW } })).token;
  M.T.owner = await M.login(`owner@${slug}.test`);
  /** A login with this role (and, with staff: true, a staff member behind it). */
  M.add = async (key, role, { staff = false, positions = [] } = {}) => {
    let staffId;
    if (staff) {
      staffId = ok(await api('POST', '/workforce/staff', { token: M.T.owner, body: { person: { first_name: key, last_name: 'Tester' }, status: 'active' } })).id;
      M.S[key] = staffId;
      if (positions.length) ok(await api('PUT', `/workforce/staff/${staffId}/positions`, { token: M.T.owner, body: { position_ids: positions } }));
    }
    M.U[key] = ok(await api('POST', '/users', { token: M.T.owner, body: { username: `${key}${suffix}`, email: `${key}@${slug}.test`, password: PW, role, ...(staffId ? { staff_id: staffId } : {}) } })).id;
    M.T[key] = await M.login(`${key}@${slug}.test`);
  };
  return M;
}
const turn = async (M, module, on) => { await q('INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)', [M.id, module, on ? 1 : 0]); modules.invalidate(M.id); };
const me = async (token) => ok(await api('GET', '/auth/me', { token }));
const nav = async (token) => ok(await api('GET', '/me/nav', { token }));
const save = (token, pins, bar) => api('PUT', '/me/nav', { token, body: { pins, ...(bar === undefined ? {} : { bar }) } });
const appPin = (k, label = menus.VIEW_NAMES[k]) => ({ id: k, label, href: k, app: k });
const hrefs = (pins) => pins.map((p) => p.href);

let A; let B; let Muni;
test.before(async () => {
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await tenant('a');
  for (const role of ['manager', 'counter', 'instructor', 'staff', 'patrol']) await A.add(role, role);
  await A.add('area', 'area');
  await A.add('counter2', 'counter');
  // A patrol director (roster access Admin) and someone working the Park crew position.
  await A.add('patdir', 'patrol', { staff: true });
  await q("INSERT INTO patrol_members (tenant_id, staff_id, level, access_level) VALUES (?, ?, 'director', 'admin')", [A.id, A.S.patdir]);
  A.T.patdir = await A.login(`patdir@${A.slug}.test`);
  const park = ok(await api('POST', '/workforce/positions', { token: A.T.owner, body: { name: 'Park crew', department: 'lifts' } })).id;
  await A.add('parkcrew', 'staff', { staff: true, positions: [park] });
  B = await tenant('b');
  await B.add('counter', 'counter');
  Muni = await tenant('m', { org_type: 'municipality' });
  for (const [key, role] of [['manager', 'manager'], ['crew', 'staff'], ['frontdesk', 'counter']]) await Muni.add(key, role);
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('starting pins, ski area: each role starts with its menu, in order, with nothing saved', async () => {
  const want = {
    owner: ['money', 'conditions', 'patrol', 'school', 'people', 'workforce'],
    manager: ['conditions', 'sell', 'patrol', 'school', 'people', 'workforce'],
    counter: ['sell', 'gate', 'rentals', 'people', 'waivers', 'shop'],
    instructor: ['school', 'availability', 'people', 'waivers'],
    staff: ['conditions', 'gate', 'lostfound'],
    patrol: ['patrol', 'conditions'],
    parkcrew: ['park', 'conditions', 'lostfound'], // the position's menu, not the role's
  };
  for (const [who, apps] of Object.entries(want)) {
    const m = await me(A.T[who]);
    assert.deepEqual(m.nav, { pins: apps.map((k) => appPin(k)), bar: null, custom: false }, `${who}: /auth/me`);
    assert.deepEqual(hrefs(m.nav.pins), m.menu.apps, `${who}: the pins are the role's menu`);
    const n = await nav(A.T[who]);
    assert.deepEqual(n, { ...m.nav, standard: m.nav.pins }, `${who}: GET /me/nav says the same, with the role's starting pins`);
  }
  assert.equal((await me(A.T.instructor)).nav.pins[1].label, 'My availability', 'named as the menu names it');
  assert.equal((await q('SELECT COUNT(*) AS n FROM user_nav WHERE tenant_id = ?', [A.id]))[0].n, 0, 'reading saves nothing');
});

test('starting pins: a shortcut in the role\'s menu becomes a pin with its page address, label and icon', async () => {
  const m = await me(A.T.patdir);
  assert.equal(m.menu_row, 'patrol_director');
  assert.deepEqual(m.nav.pins, [
    { id: 'patrol', label: 'Patrol', href: 'patrol', app: 'patrol' },
    { id: 'patrol-records', label: 'Records requests', href: 'patrol/cases?tab=records', app: 'patrol', icon: 'documents' },
    { id: 'patrol-access', label: 'Access log', href: 'patrol/cases?tab=access', app: 'patrol', icon: 'search' },
    { id: 'conditions', label: 'Mountain status', href: 'conditions', app: 'conditions' },
  ]);
  assert.equal(m.nav.custom, false);
  // Every starting pin is a pin the person could save back as it is.
  is(await save(A.T.patdir, m.nav.pins), 200);
  is(await api('DELETE', '/me/nav', { token: A.T.patdir }), 200);
});

test('the ski area\'s read-only login has no pins, and no pins to save', async () => {
  const m = await me(A.T.area);
  assert.equal(m.menu, null);
  assert.deepEqual(m.nav, { pins: [], bar: null, custom: false });
  // That login reaches only its summary (middleware/auth.js), so the answer is its own; the route refuses it as well.
  for (const r of [await api('GET', '/me/nav', { token: A.T.area }), await save(A.T.area, [appPin('settings')]), await api('DELETE', '/me/nav', { token: A.T.area })]) is(r, 403);
  assert.match(read('src/routes/menav.js'), /const notArea = \(req, _res, next\) => \(req\.auth\.role === 'area' \? next\(forbidden\(AREA\)\) : next\(\)\);/);
  for (const verb of ['get', 'put', 'delete']) assert.match(read('src/routes/menav.js'), new RegExp(`router\\.${verb}\\('/', notArea, `), `${verb}: refused for the ski area login`);
  assert.equal((await q('SELECT COUNT(*) AS n FROM user_nav WHERE user_id = ?', [A.U.area]))[0].n, 0);
  is(await api('GET', '/me/nav'), 401, 'signed in only');
});

test('starting pins, municipality: each role starts with its menu; an add-on that is off is left out', async () => {
  const want = {
    owner: ['requests', 'works', 'assets', 'workforce'],
    manager: ['requests', 'works', 'assets', 'workforce'],
    crew: ['works', 'requests', 'assets'],
    frontdesk: ['requests', 'notices'], // Bulk pickup is in the Front desk menu, and Trash and recycling is off
  };
  for (const [who, apps] of Object.entries(want)) {
    const m = await me(Muni.T[who]);
    assert.equal(m.org_type, 'municipality');
    assert.deepEqual(m.nav, { pins: apps.map((k) => appPin(k)), bar: null, custom: false }, who);
    assert.deepEqual((await nav(Muni.T[who])).standard, m.nav.pins, `${who}: /me/nav is reachable for a municipality`);
  }
  assert.equal((await me(Muni.T.crew)).nav.pins[0].label, 'Work orders');
  await turn(Muni, 'solidwaste', true);
  assert.deepEqual(hrefs((await me(Muni.T.frontdesk)).nav.pins), ['requests', 'bulk', 'notices'], 'turned on: it is there, in the menu\'s order');
  await turn(Muni, 'solidwaste', false);
  // A crew member pins a page inside Work orders and an app from a section; a ski page is not theirs to pin.
  const mine = [{ id: 'p1', label: 'Overdue water work orders', href: 'works?dept=water&status=overdue', app: 'works' }, appPin('requests'), appPin('documents')];
  assert.deepEqual(ok(await save(Muni.T.crew, mine)).pins, mine);
  is(await save(Muni.T.crew, [appPin('patrol', 'Patrol')]), 400, 'a ski area app');
  is(await save(Muni.T.crew, [appPin('monthreport')]), 400, 'the monthly report is the manager\'s');
  is(await save(Muni.T.crew, [appPin('water')]), 400, 'Water is off');
  is(await save(Muni.T.manager, [appPin('monthreport')]), 200);
  is(await api('DELETE', '/me/nav', { token: Muni.T.manager }), 200);
  is(await api('DELETE', '/me/nav', { token: Muni.T.crew }), 200);
});

test('a person makes their own: save, reorder, rename, and reset to the role\'s menu', async () => {
  const t = A.T.counter;
  const start = (await nav(t)).pins;
  // Pin a page inside an app (as the star does), keep three of the role's.
  const mine = [appPin('sell'), { id: 'p-tw', label: 'Ticket window', href: 'sell?tab=window', app: 'sell' }, appPin('rentals'), appPin('people')];
  const saved = ok(await save(t, mine));
  assert.deepEqual(saved, { pins: mine, bar: null, custom: true, standard: start });
  assert.deepEqual((await me(t)).nav, { pins: mine, bar: null, custom: true }, 'the first paint has them');
  // Another device: a new sign-in for the same person.
  assert.deepEqual((await me(await A.login(`counter@${A.slug}.test`))).nav.pins, mine, 'pins follow the person');
  // Reorder and rename.
  const next = [mine[2], { ...mine[1], label: 'Window 2' }, mine[0], mine[3]];
  assert.deepEqual(ok(await save(t, next)).pins, next);
  assert.deepEqual((await nav(t)).pins.map((p) => p.label), ['Rentals', 'Window 2', 'Sell', 'Customers']);
  // A name is kept without the spaces around it; an icon is kept when it is one.
  const tidy = ok(await save(t, [{ id: 'a', label: '  Gate scans  ', href: 'gate', icon: 'search' }]));
  assert.deepEqual(tidy.pins, [{ id: 'a', label: 'Gate scans', href: 'gate', app: 'gate', icon: 'search' }]);
  // No pins at all is a choice too.
  assert.deepEqual(ok(await save(t, [])), { pins: [], bar: null, custom: true, standard: start });
  // Reset: back to the role's menu, and the row is gone.
  assert.deepEqual(ok(await api('DELETE', '/me/nav', { token: t })), { pins: start, bar: null, custom: false, standard: start });
  assert.equal((await q('SELECT COUNT(*) AS n FROM user_nav WHERE user_id = ?', [A.U.counter]))[0].n, 0);
  assert.deepEqual((await me(t)).nav, { pins: start, bar: null, custom: false });
  is(await api('DELETE', '/me/nav', { token: t }), 200, 'resetting twice is fine');
});

test('the phone bar: up to four of the pins or Home pages; a renamed pin keeps its place; NULL is the standard bar', async () => {
  const t = A.T.manager;
  const pins = [appPin('sell'), { id: 'cases', label: 'Case review', href: 'patrol/cases?tab=review', app: 'patrol', icon: 'patrol' }, appPin('money')];
  const out = ok(await save(t, pins, [{ href: 'dashboard' }, { href: 'patrol/cases?tab=review', label: 'ignored', app: 'nope' }, 'money', { href: 'myshifts' }]));
  assert.deepEqual(out.bar, [
    { label: 'Today', href: 'dashboard', app: 'dashboard' },
    { label: 'Case review', href: 'patrol/cases?tab=review', app: 'patrol', icon: 'patrol' },
    { label: 'Money', href: 'money', app: 'money' },
    { label: 'My shifts', href: 'myshifts', app: 'myshifts' },
  ]);
  assert.deepEqual((await me(t)).nav.bar, out.bar);
  // A rename shows on the bar; a pin taken out leaves the bar.
  const renamed = ok(await save(t, [pins[0], { ...pins[1], label: 'Reviews' }], hrefs(out.bar).filter((h) => h !== 'money')));
  assert.deepEqual(renamed.bar.map((b) => b.label), ['Today', 'Reviews', 'My shifts']);
  is(await save(t, pins, ['dashboard', 'sell', 'money', 'myshifts', 'calendar']), 400, 'five');
  is(await save(t, pins, ['gate']), 400, 'not one of the pins');
  is(await save(t, pins, ['sell', 'sell']), 400, 'twice');
  is(await save(t, pins, ['settings']), 400, 'Settings is not a Home page');
  assert.equal((await save(t, pins, ['gate'])).body.error, 'The phone bar can hold your pins and Today, Inbox, Calendar and My shifts. Pin a page first to put it on the bar.');
  assert.equal(ok(await save(t, pins, null)).bar, null, 'null: the standard bar');
  assert.deepEqual(ok(await save(t, pins, [])).bar, [], 'an empty bar is a choice');
  is(await api('DELETE', '/me/nav', { token: t }), 200);
});

test('the limits: 12 pins, a name of 1 to 40 characters, no page twice', async () => {
  const t = A.T.owner;
  const twelve = ['sell', 'gate', 'shop', 'rentals', 'people', 'waivers', 'lostfound', 'conditions', 'park', 'patrol', 'school', 'programs'].map((k) => appPin(k));
  assert.equal(ok(await save(t, twelve)).pins.length, 12);
  const r13 = await save(t, [...twelve, appPin('money')]);
  is(r13, 400);
  assert.equal(r13.body.error, 'You can have up to 12 pins. Unpin one to add another.');
  assert.equal(ok(await save(t, [appPin('money', 'x'.repeat(40))])).pins[0].label.length, 40);
  const r41 = await save(t, [appPin('money', 'x'.repeat(41))]);
  is(r41, 400);
  assert.equal(r41.body.error, 'A pin\'s name can be up to 40 characters');
  is(await save(t, [appPin('money', '   ')]), 400, 'a name of spaces');
  is(await save(t, [appPin('money', '')]), 400);
  is(await save(t, [{ id: 'a', label: 'Money', href: 'money' }, { id: 'a', label: 'Sell', href: 'sell' }]), 400, 'one id twice');
  is(await save(t, [{ id: 'a', label: 'Money', href: 'money' }, { id: 'b', label: 'Money too', href: 'money' }]), 400, 'one page twice');
  is(await save(t, [{ id: 'bad id!', label: 'Money', href: 'money' }]), 400);
  is(await save(t, [{ id: 'a', label: 'Money', href: 'money', app: 'sell' }]), 400, 'the app is the first part of the address');
  is(await api('PUT', '/me/nav', { token: t, body: {} }), 400, 'no list');
  is(await api('PUT', '/me/nav', { token: t, body: { pins: 'money' } }), 400);
  is(await api('PUT', '/me/nav', { token: t, body: { pins: [null] } }), 400);
  assert.deepEqual(hrefs((await nav(t)).pins), ['money'], 'a refused save changes nothing');
  is(await api('DELETE', '/me/nav', { token: t }), 200);
});

test('the address rule: a page in the app and nothing else', async () => {
  const t = A.T.owner;
  const bad = [
    'javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', '//evil.example/x', '/patrol', 'https://evil.example', 'patrol#x', '#/patrol', '#',
    'patrol/..', 'patrol/../money', '..', 'patrol/./cases', 'patrol/cases/...', 'patrol cases', ' patrol', 'patrol ', 'patrol/cases?tab=a b', 'patrol\\cases',
    'patrol/', 'patrol//cases', 'Patrol', 'patrol?tab=<script>', 'patrol?a=1#b', 'patrol?a=1?b=2', 'patrol\n', 'patrol%2F..', '', `patrol?${'a'.repeat(200)}`,
    'nosuchapp', 'area', 'availability', 'requests', 'works',
  ];
  for (const href of bad) {
    const r = await save(t, [{ id: 'x', label: 'Try', href }]);
    is(r, 400, JSON.stringify(href));
    assert.equal(menus.checkNav({ pins: [{ id: 'x', label: 'Try', href }] }, menus.viewsFor({ role: 'owner', org: 'mountain', modules: modules.keysFor('mountain') })).pins, undefined, JSON.stringify(href));
  }
  assert.equal((await save(t, [{ id: 'x', label: 'Try', href: 'javascript:alert(1)' }])).body.error, '"Try" does not point to a page in Verdynt/OS, so it cannot be pinned');
  const good = ['patrol', 'patrol/cases?tab=records', 'patrol/case/12', 'money?from=2026-11-01&to=2026-11-30', 'sell?tab=window', 'settings/team?tab=menus', 'school?tab=team&view=availability', 'help/for-patrol?part=gear', 'conditions/wo/12', 'people?q=o%27brien', `sell?${'a'.repeat(195)}`];
  for (const href of good) assert.deepEqual(ok(await save(t, [{ id: 'x', label: 'Try', href }])).pins, [{ id: 'x', label: 'Try', href, app: href.split(/[/?]/)[0] }], href);
  is(await api('DELETE', '/me/nav', { token: t }), 200);
});

test('a pin points only into an app this person may open', async () => {
  const cases = [
    ['counter', 'money', 'You cannot open Money, so it cannot be pinned'], ['counter', 'patrol/cases?tab=records'], ['counter', 'workforce'], ['counter', 'assets'],
    ['staff', 'sell'], ['staff', 'people'], ['patrol', 'gate'], ['instructor', 'catalog'], ['instructor', 'rentals'], ['manager', 'availability'], ['manager', 'area'],
  ];
  for (const [who, href, message] of cases) {
    const r = await save(A.T[who], [{ id: 'x', label: 'Try', href }]);
    is(r, 400, `${who} ${href}`);
    if (message) assert.equal(r.body.error, message);
  }
  for (const who of ['counter', 'staff', 'patrol', 'instructor']) assert.equal((await nav(A.T[who])).custom, false, `${who}: nothing was saved`);
  // What they may open, they may pin: an instructor's own availability, and the pages everyone has.
  const pins = [appPin('availability'), appPin('documents'), { id: 'pw', label: 'My sign-in', href: 'settings/profile', app: 'settings' }, appPin('help')];
  assert.deepEqual(ok(await save(A.T.instructor, pins)).pins, pins);
  is(await api('DELETE', '/me/nav', { token: A.T.instructor }), 200);
});

test('another person and another tenant can neither read nor write someone\'s pins', async () => {
  const mine = [appPin('gate'), appPin('sell')];
  ok(await save(A.T.counter, mine));
  // The same role, the same tenant: their own.
  assert.equal((await nav(A.T.counter2)).custom, false);
  assert.deepEqual(hrefs((await me(A.T.counter2)).nav.pins), menus.STANDARD.counter.apps);
  assert.equal((await nav(A.T.owner)).custom, false, 'not even the owner sees them as theirs');
  // Another tenant: its own, whatever it sends.
  assert.equal((await nav(B.T.counter)).custom, false);
  const theirs = [appPin('rentals')];
  for (const extra of [{ tenant_id: A.id, user_id: A.U.counter }, { tenantId: A.id, userId: A.U.counter }, { user: A.U.counter }]) {
    ok(await api('PUT', '/me/nav', { token: B.T.counter, body: { pins: theirs, ...extra } }));
    ok(await api('PUT', `/me/nav?user_id=${A.U.counter}&tenant_id=${A.id}`, { token: A.T.counter2, body: { pins: theirs, ...extra } }));
  }
  for (const p of [`/me/nav/${A.U.counter}`, `/users/${A.U.counter}/nav`]) for (const m of ['GET', 'PUT', 'DELETE']) assert.equal((await api(m, p, { token: B.T.owner, body: m === 'PUT' ? { pins: [] } : undefined })).status, 404, `${m} ${p}`);
  ok(await api('DELETE', `/me/nav?user_id=${A.U.counter}`, { token: B.T.owner }));
  ok(await api('DELETE', `/me/nav?user_id=${A.U.counter}`, { token: A.T.owner }));
  assert.deepEqual((await nav(A.T.counter)).pins, mine, 'untouched');
  const rowsNow = await q('SELECT tenant_id, user_id, pins FROM user_nav WHERE user_id IN (?, ?, ?) ORDER BY user_id', [A.U.counter, A.U.counter2, B.U.counter]);
  assert.deepEqual(rowsNow.map((r) => [Number(r.tenant_id), Number(r.user_id), hrefs(typeof r.pins === 'string' ? JSON.parse(r.pins) : r.pins)]), [[A.id, A.U.counter, ['gate', 'sell']], [A.id, A.U.counter2, ['rentals']], [B.id, B.U.counter, ['rentals']]].sort((x, y) => x[1] - y[1]));
  // A row filed under the wrong tenant (it cannot happen through the API) is never read: tenant AND person, every time.
  await q('DELETE FROM user_nav WHERE user_id = ?', [B.U.counter]);
  await q('INSERT INTO user_nav (tenant_id, user_id, pins) VALUES (?, ?, ?)', [A.id, B.U.counter, JSON.stringify([appPin('gate')])]);
  assert.equal((await nav(B.T.counter)).custom, false);
  await q('DELETE FROM user_nav WHERE user_id IN (?, ?)', [B.U.counter, A.U.counter2]);
  is(await api('DELETE', '/me/nav', { token: A.T.counter }), 200);
});

test('a shared counter computer (a PIN session) shows the role\'s pins and cannot save its own', async () => {
  const term = ok(await api('POST', '/terminals', { token: A.T.owner, body: { name: 'Ticket window 1' } }));
  ok(await api('PUT', '/auth/pin', { token: A.T.counter, body: { password: PW, pin: '482915' } }));
  const mine = [appPin('gate'), { id: 'tw', label: 'Ticket window', href: 'sell?tab=window', app: 'sell' }];
  ok(await save(A.T.counter, mine, ['gate']));
  const pin = ok(await api('POST', '/auth/pin-login', { body: { tenant: A.slug, terminal: term.secret, login: `counter${suffix}`, pin: '482915' } })).token;
  const m = await me(pin);
  assert.equal(m.signed_in_with, 'pin');
  assert.equal(m.terminal.name, 'Ticket window 1');
  assert.deepEqual(m.nav, { pins: menus.STANDARD.counter.apps.map((k) => appPin(k)), bar: null, custom: false }, 'the role\'s, not the person\'s own');
  assert.deepEqual(await nav(pin), { ...m.nav, standard: m.nav.pins });
  for (const r of [await save(pin, [appPin('gate')]), await api('DELETE', '/me/nav', { token: pin })]) {
    is(r, 403);
    assert.equal(r.body.error, 'This is a shared computer, so its menu stays the same for everyone with your role. Sign in on your own phone or computer to change your pins.');
  }
  // Their own pins are as they left them, on their own device.
  assert.deepEqual((await me(A.T.counter)).nav, { pins: mine, bar: [{ label: 'Gate', href: 'gate', app: 'gate' }], custom: true });
  is(await api('DELETE', `/terminals/${term.id}`, { token: A.T.owner }), 200);
  is(await api('DELETE', '/me/nav', { token: A.T.counter }), 200);
});

test('the owner changes a role\'s menu: it reaches people with no pins of their own, and not those with their own', async () => {
  const own = [appPin('gate'), appPin('rentals')];
  ok(await save(A.T.counter, own));
  ok(await api('PUT', '/settings/menus', { token: A.T.owner, body: { role: 'counter', menu: { apps: ['shop', 'sell', 'lostfound'], start: 'sell' } } }));
  assert.deepEqual(hrefs((await me(A.T.counter2)).nav.pins), ['shop', 'sell', 'lostfound'], 'nothing of their own: the new menu');
  const mine = await nav(A.T.counter);
  assert.deepEqual(mine.pins, own, 'their own: unchanged');
  assert.deepEqual(hrefs(mine.standard), ['shop', 'sell', 'lostfound'], 'and Reset would give the new menu');
  assert.deepEqual(hrefs(ok(await api('DELETE', '/me/nav', { token: A.T.counter })).pins), ['shop', 'sell', 'lostfound']);
  // The patrol director's menu, with a shortcut taken out.
  ok(await api('PUT', '/settings/menus', { token: A.T.owner, body: { role: 'patrol_director', menu: { apps: ['patrol-review', 'patrol'], start: 'patrol' } } }));
  assert.deepEqual((await me(A.T.patdir)).nav.pins, [{ id: 'patrol-review', label: 'Case review', href: 'patrol/cases?tab=review', app: 'patrol', icon: 'patrol' }, appPin('patrol')]);
  for (const role of ['counter', 'patrol_director']) ok(await api('PUT', '/settings/menus', { token: A.T.owner, body: { role, menu: null } }));
  assert.deepEqual(hrefs((await me(A.T.counter)).nav.pins), menus.STANDARD.counter.apps);
});

test('a role menu longer than twelve gives its first twelve as starting pins', async () => {
  const apps = ['money', 'conditions', 'patrol', 'school', 'people', 'workforce', 'sell', 'gate', 'shop', 'rentals', 'waivers', 'lostfound', 'park', 'programs'];
  ok(await api('PUT', '/settings/menus', { token: A.T.owner, body: { role: 'owner', menu: { apps, start: 'dashboard' } } }));
  const n = await nav(A.T.owner);
  assert.deepEqual(hrefs(n.pins), apps.slice(0, 12));
  is(await save(A.T.owner, n.pins), 200, 'and they can be saved as they are');
  is(await api('DELETE', '/me/nav', { token: A.T.owner }), 200);
  ok(await api('PUT', '/settings/menus', { token: A.T.owner, body: { role: 'owner', menu: null } }));
});

test('a pin whose app was turned off disappears, and is dropped for good on the next save', async () => {
  const t = A.T.counter;
  const mine = [appPin('sell'), { id: 'r1', label: 'Rental returns', href: 'rentals?tab=returns', app: 'rentals' }, appPin('gate'), appPin('rentals')];
  ok(await save(t, mine, ['rentals?tab=returns', 'sell']));
  await turn(A, 'rentals', false);
  const off = await me(t);
  assert.deepEqual(hrefs(off.nav.pins), ['sell', 'gate'], 'both Rentals pins are gone');
  assert.deepEqual(hrefs(off.nav.bar), ['sell'], 'and from the phone bar');
  assert.ok(!hrefs((await me(A.T.counter2)).nav.pins).includes('rentals'), 'from the role\'s starting pins too');
  is(await save(t, [appPin('rentals')]), 400, 'and cannot be pinned while it is off');
  // Not saved yet: turning the app back on brings the pins back.
  await turn(A, 'rentals', true);
  assert.deepEqual((await nav(t)).pins, mine);
  // Saved while it was off (the page sends back what it was shown): gone for good.
  await turn(A, 'rentals', false);
  ok(await save(t, (await nav(t)).pins));
  await turn(A, 'rentals', true);
  assert.deepEqual(hrefs((await nav(t)).pins), ['sell', 'gate']);
  is(await api('DELETE', '/me/nav', { token: t }), 200);
});

test('a pin the person can no longer open after a role change is not shown', async () => {
  ok(await save(A.T.counter2, [appPin('sell'), appPin('gate'), appPin('documents')]));
  is(await api('PATCH', `/users/${A.U.counter2}`, { token: A.T.owner, body: { role: 'staff' } }), 200);
  const t = await A.login(`counter2@${A.slug}.test`);
  assert.deepEqual(hrefs((await me(t)).nav.pins), ['gate', 'documents'], 'lift and mountain staff do not open Sell');
  assert.equal((await me(t)).nav.custom, true);
  is(await api('PATCH', `/users/${A.U.counter2}`, { token: A.T.owner, body: { role: 'counter' } }), 200);
  is(await api('DELETE', '/me/nav', { token: await A.login(`counter2@${A.slug}.test`) }), 200);
});

test('a stored row that is not a list of pins never breaks the menu', async () => {
  for (const [pins, bar] of [['"nope"', null], ['{}', '"x"'], ['[{"id":"a","label":"Money","href":"javascript:alert(1)"},{"id":"b","label":"Gate","href":"gate"},null,7]', '["gate","javascript:alert(1)",5]']]) {
    await q('INSERT INTO user_nav (tenant_id, user_id, pins, bar) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE pins = VALUES(pins), bar = VALUES(bar)', [A.id, A.U.staff, pins, bar]);
    const n = (await me(A.T.staff)).nav;
    assert.equal(n.custom, true);
    assert.ok(n.pins.every((p) => menus.goodHref(p.href)), JSON.stringify(n));
    assert.ok(n.bar === null || n.bar.every((b) => menus.goodHref(b.href)), JSON.stringify(n));
  }
  assert.deepEqual((await me(A.T.staff)).nav, { pins: [{ id: 'b', label: 'Gate', href: 'gate', app: 'gate' }], bar: [{ label: 'Gate', href: 'gate', app: 'gate' }], custom: true });
  is(await api('DELETE', '/me/nav', { token: A.T.staff }), 200);
});

test('arranging your own menu is not in the audit log, and the row goes when the login is deleted', async () => {
  const before = (await q('SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ?', [B.id]))[0].n;
  ok(await save(B.T.counter, [appPin('gate')]));
  ok(await api('DELETE', '/me/nav', { token: B.T.counter }));
  assert.equal((await q('SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ?', [B.id]))[0].n, before);
  // A login with nothing else hanging off it, deleted outright.
  const [p] = [await q('INSERT INTO people (tenant_id, first_name, last_name) VALUES (?, ?, ?)', [B.id, 'Gone', 'Soon'])];
  const [u] = [await q("INSERT INTO users (tenant_id, person_id, email, username, password_hash, role) VALUES (?, ?, ?, ?, 'x', 'staff')", [B.id, p.insertId, `gone@${B.slug}.test`, `gone${suffix}`])];
  await q('INSERT INTO user_nav (tenant_id, user_id, pins) VALUES (?, ?, ?)', [B.id, u.insertId, '[]']);
  await q('DELETE FROM users WHERE id = ?', [u.insertId]);
  assert.equal((await q('SELECT COUNT(*) AS n FROM user_nav WHERE user_id = ?', [u.insertId]))[0].n, 0);
  await assert.rejects(q('INSERT INTO user_nav (tenant_id, user_id, pins) VALUES (?, ?, ?)', [B.id, 999999999, '[]']), /foreign key/i, 'no row for a login that does not exist');
});

test('the server and the page agree on who may open what', () => {
  const main = read('public/js/main.js');
  const views = [...main.matchAll(/^ {2}\['([a-z]+)', '[^']+', \(\) => /gm)].map((m) => m[1]);
  assert.ok(views.length >= 36, `the list of views was read (${views.length})`);
  assert.deepEqual(Object.keys(menus.VIEW_RULES).sort(), [...views].sort(), 'every view has a rule on the server, and no rule is for a view that is gone');
  for (const k of views) assert.ok(menus.VIEW_NAMES[k], `${k} has a name`);
  const list = (name) => [...new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(main)[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  const muni = [...list('MUNI_VIEWS'), ...[.../MUNI_VIEWS\.push\(([^)]*)\)/.exec(main)[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1])];
  const all = { role: 'owner', org: 'municipality', modules: modules.KEYS };
  assert.deepEqual(menus.viewsFor(all).sort(), muni.sort(), 'a municipality\'s views');
  assert.deepEqual(menus.viewsFor({ ...all, modules: [] }).sort(), ['dashboard', 'help', 'inbox', 'settings'], 'with every app off');
  // The same answers as test/nav-v2.test.js's table of what each ski role opens (plus the Morning brief, a page and not a menu item).
  const everyone = ['dashboard', 'inbox', 'brief', 'conditions', 'park', 'documents', 'myshifts', 'calendar', 'settings', 'help'];
  const opens = {
    counter: [...everyone, 'sell', 'gate', 'rentals', 'school', 'programs', 'people', 'waivers', 'lostfound', 'shop'],
    instructor: [...everyone, 'school', 'programs', 'availability', 'people', 'waivers'],
    staff: [...everyone, 'gate', 'assets', 'lostfound'],
    patrol: [...everyone, 'patrol'],
  };
  const on = modules.KEYS;
  for (const [role, keys] of Object.entries(opens)) assert.deepEqual(menus.viewsFor({ role, org: 'mountain', modules: on }).sort(), [...keys].sort(), role);
  const owner = menus.viewsFor({ role: 'owner', org: 'mountain', modules: on });
  assert.ok(!owner.includes('availability') && !owner.includes('area') && !owner.includes('works') && owner.includes('money'));
  assert.deepEqual(menus.viewsFor({ role: 'area', org: 'mountain', modules: on }), ['area', 'settings', 'help']);
  assert.ok(menus.viewsFor({ role: 'staff', org: 'mountain', modules: on, onPatrol: true }).includes('patrol'), 'on the patrol roster: Patrol');
  const director = menus.viewsFor({ role: 'instructor', org: 'mountain', modules: on, schoolAccess: 'director' });
  assert.ok(director.includes('sell') && director.includes('catalog'), 'a ski school director: Sell and Products and prices');
  const patrolOnly = menus.viewsFor({ role: 'patrol', org: 'mountain', modules: ['patrol', 'documents'] });
  assert.ok(!patrolOnly.includes('dashboard') && !patrolOnly.includes('myshifts') && patrolOnly.includes('patrol'), 'a patrol on its own has no Today');
});

test('the migration step: user_nav is made once; running the migration again applies nothing', async () => {
  const cols = await q("SELECT column_name AS c, is_nullable AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'user_nav' ORDER BY ordinal_position");
  assert.deepEqual(cols.map((c) => [c.c, c.n]), [['tenant_id', 'NO'], ['user_id', 'NO'], ['pins', 'NO'], ['bar', 'YES'], ['updated_at', 'NO']]);
  const pk = await q("SELECT column_name AS c FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = 'user_nav' AND constraint_name = 'PRIMARY' ORDER BY ordinal_position");
  assert.deepEqual(pk.map((r) => r.c), ['tenant_id', 'user_id']);
  const fks = await q("SELECT referenced_table_name AS t, delete_rule AS d FROM information_schema.referential_constraints WHERE constraint_schema = DATABASE() AND table_name = 'user_nav' ORDER BY referenced_table_name");
  assert.deepEqual(fks.map((r) => [r.t, r.d]), [['tenants', 'RESTRICT'], ['users', 'CASCADE']]);
  assert.equal((read('db/migrate.js').match(/require\('\.\/steps\/nav-pins'\)/g) || []).length, 1, 'registered once');
  const run = () => execFileSync(process.execPath, [path.join(ROOT, 'db', 'migrate.js')], { cwd: ROOT, env: process.env, encoding: 'utf8' });
  run();
  assert.match(run(), /Schema up to date on \S+ \(0 changes applied\)/);
});
