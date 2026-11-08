'use strict';

// Navigation v2: Home pinned for everyone, a short menu for every role (owners and managers included), All apps in four
// folding groups, Instructor availability inside Lessons, Patrol's parts as page tabs, and one tab component.
// The menu plan (public/js/nav.js) is checked for each role with the apps that role may open, the server menus
// (src/lib/menus.js) through the API, and the look through the stylesheet.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const menus = require('../src/lib/menus');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const css = read('public/css/app.css');

let server; let base; let nav; let tmp;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const slug = `nav2-${suffix}`;
const PW = 'correct-horse-battery';
const T = {};

async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const login = async (email) => ok(await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).token;

// What each role may open (the rules in public/js/main.js VIEWS), all apps on. Instructor availability is a menu item
// only for an instructor; everyone else reaches it inside Lessons.
const LABELS = {
  dashboard: 'Today', inbox: 'Inbox', sell: 'Sell', gate: 'Gate', conditions: 'Mountain status', park: 'Terrain park', assets: 'Assets and fleet',
  documents: 'Documents', rentals: 'Rentals', school: 'Lessons', programs: 'Programs', availability: 'Instructor availability', patrol: 'Patrol',
  people: 'Customers', waivers: 'Waivers', lostfound: 'Lost and found', shop: 'Online shop', catalog: 'Products and prices', messages: 'Messages',
  money: 'Money', workforce: 'Staff and schedule', myshifts: 'My shifts', calendar: 'Calendar', settings: 'Settings', help: 'Help',
};
const EVERYONE = ['dashboard', 'inbox', 'conditions', 'park', 'documents', 'myshifts', 'calendar', 'settings', 'help'];
const OPENS = {
  owner: Object.keys(LABELS).filter((k) => k !== 'availability'),
  manager: Object.keys(LABELS).filter((k) => k !== 'availability'),
  counter: [...EVERYONE, 'sell', 'gate', 'rentals', 'school', 'programs', 'people', 'waivers', 'lostfound', 'shop'],
  instructor: [...EVERYONE, 'school', 'programs', 'availability', 'people', 'waivers'],
  staff: [...EVERYONE, 'gate', 'assets', 'lostfound'],
  patrol: [...EVERYONE, 'patrol'],
};
const viewsFor = (role) => Object.keys(LABELS).filter((k) => OPENS[role].includes(k)).map((k) => [k, LABELS[k]]);

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-nav2-'));
  fs.cpSync(path.join(ROOT, 'public', 'js'), path.join(tmp, 'js'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  nav = await import(pathToFileURL(path.join(tmp, 'js', 'nav.js')).href);
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Nav Two Mountain', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  T.owner = await login(`owner@${slug}.test`);
  for (const role of ['manager', 'counter', 'instructor', 'staff', 'patrol']) {
    ok(await api('POST', '/users', { token: T.owner, body: { email: `${role}@${slug}.test`, password: PW, role } }));
    T[role] = await login(`${role}@${slug}.test`);
  }
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('groups: Home is pinned and never a group; All apps has four groups in this order', () => {
  assert.deepEqual(nav.HOME, ['dashboard', 'inbox', 'calendar', 'myshifts']);
  assert.deepEqual(nav.GROUPS.map(([name, id]) => [name, id]), [['Guests and sales', 'sales'], ['On the hill', 'hill'], ['Ski school', 'school'], ['Back office', 'office']]);
  assert.deepEqual(nav.GROUPS[0][2], ['sell', 'gate', 'shop', 'rentals', 'people', 'waivers', 'lostfound']);
  assert.deepEqual(nav.GROUPS[1][2], ['conditions', 'park', 'patrol', 'area', 'assets']);
  assert.deepEqual(nav.GROUPS[2][2].filter((k) => k !== 'availability'), ['school', 'programs'], 'availability shows there only for an instructor who took it out of their menu');
  assert.deepEqual(nav.GROUPS[3][2], ['catalog', 'money', 'workforce', 'messages', 'documents']);
  for (const k of nav.HOME) assert.ok(!nav.GROUPS.some(([, , keys]) => keys.includes(k)), `${k} is in no group`);
  assert.deepEqual(menus.HOME, nav.HOME, 'the server and the page agree on Home');
});

test('menu plans: Home, then the role\'s own apps, then everything else it may open in the groups, nothing twice', () => {
  const want = {
    owner: ['money', 'conditions', 'patrol', 'school', 'people', 'workforce'],
    manager: ['conditions', 'sell', 'patrol', 'school', 'people', 'workforce'],
    counter: ['sell', 'gate', 'rentals', 'people', 'waivers', 'shop'],
    instructor: ['school', 'availability', 'people', 'waivers'],
    staff: ['conditions', 'gate', 'lostfound'],
    patrol: ['patrol', 'conditions'],
  };
  // The phone bar starts with the screen the menu opens on (2026.11.13): Today for owners, managers and staff.
  const phone = {
    owner: ['dashboard', 'money', 'conditions', 'patrol'], manager: ['dashboard', 'conditions', 'sell', 'patrol'], counter: ['sell', 'gate', 'rentals', 'people'],
    instructor: ['school', 'availability', 'people', 'waivers'], staff: ['dashboard', 'conditions', 'gate', 'lostfound'], patrol: ['patrol', 'conditions', 'myshifts', 'dashboard'],
  };
  for (const role of Object.keys(want)) {
    const views = viewsFor(role);
    const plan = nav.menuPlan(views, menus.menuFor(role, null));
    assert.deepEqual(plan.home, ['dashboard', 'inbox', 'calendar', 'myshifts'], `${role}: Home`);
    assert.deepEqual(plan.apps, want[role], `${role}: the short menu`);
    assert.deepEqual(plan.bottom, ['settings', 'help'], `${role}: Settings and Help at the bottom`);
    assert.deepEqual(plan.first, phone[role], `${role}: the phone bar`);
    const inGroups = plan.groups.flatMap((g) => g.keys);
    const all = [...plan.home, ...plan.apps, ...inGroups, ...plan.bottom];
    assert.equal(new Set(all).size, all.length, `${role}: nothing twice`);
    assert.deepEqual([...all].sort(), views.map(([k]) => k).sort(), `${role}: everything they may open, somewhere`);
    assert.ok(!plan.groups.some((g) => g.id === 'more'), `${role}: every app has a group`);
    assert.ok(plan.groups.every((g) => nav.GROUPS.some(([, id]) => id === g.id)), `${role}: only the four groups`);
  }
  // An owner's All apps: what is not in their menu.
  const owner = nav.menuPlan(viewsFor('owner'), menus.STANDARD.owner);
  assert.deepEqual(owner.groups.map((g) => [g.id, g.keys]), [
    ['sales', ['sell', 'gate', 'shop', 'rentals', 'waivers', 'lostfound']],
    ['hill', ['park', 'assets']],
    ['school', ['programs']],
    ['office', ['catalog', 'messages', 'documents']],
  ]);
  assert.ok(!owner.groups.flatMap((g) => g.keys).includes('availability'), 'no Instructor availability item for an owner');
});

test('owner and manager menus: saved by the owner, checked like the others, read back without Home', async () => {
  const state = ok(await api('GET', '/settings/menus', { token: T.owner }));
  assert.deepEqual(state.home, menus.HOME);
  assert.deepEqual(state.roles.owner.apps, menus.STANDARD.owner.apps);
  assert.deepEqual(state.roles.manager.apps, menus.STANDARD.manager.apps);
  assert.ok(!state.roles.owner.can_open.includes('availability'));
  assert.equal((await api('PUT', '/settings/menus', { token: T.owner, body: { role: 'owner', menu: { apps: ['money', 'nonsense'], start: 'money' } } })).status, 400);
  assert.equal((await api('PUT', '/settings/menus', { token: T.owner, body: { role: 'manager', menu: { apps: ['money'], start: 'patrol' } } })).status, 400, 'opens on an app not in the menu');
  assert.equal((await api('PUT', '/settings/menus', { token: T.manager, body: { role: 'manager', menu: { apps: ['money'], start: 'money' } } })).status, 403, 'only the owner');
  const saved = ok(await api('PUT', '/settings/menus', { token: T.owner, body: { role: 'manager', menu: { apps: ['dashboard', 'money', 'patrol', 'inbox'], start: 'dashboard' } } }));
  assert.deepEqual(saved.menu, { apps: ['money', 'patrol'], start: 'dashboard' }, 'Home apps are left out: they are pinned');
  assert.deepEqual(ok(await api('GET', '/auth/me', { token: T.manager })).menu, saved.menu);
  // A menu kept before this change, with Home apps in it, drops them when read.
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
  await pool.query('UPDATE tenants SET role_menus = ? WHERE id = ?', [JSON.stringify({ counter: { apps: ['sell', 'inbox', 'gate', 'myshifts', 'calendar'], start: 'sell' } }), t.id]);
  assert.deepEqual(ok(await api('GET', '/auth/me', { token: T.counter })).menu, { apps: ['sell', 'gate'], start: 'sell' });
  const [[row]] = await pool.query('SELECT role_menus FROM tenants WHERE id = ?', [t.id]);
  assert.match(typeof row.role_menus === 'string' ? row.role_menus : JSON.stringify(row.role_menus), /myshifts/, 'the stored row is not rewritten');
  await pool.query('UPDATE tenants SET role_menus = NULL WHERE id = ?', [t.id]);
});

test('Instructor availability: reachable for everyone who could open it, inside Lessons; an instructor keeps the page in their menu', async () => {
  for (const role of ['owner', 'manager', 'counter', 'instructor']) assert.equal((await api('GET', '/availability/settings', { token: T[role] })).status, 200, `${role} still opens it`);
  assert.ok(ok(await api('GET', '/auth/me', { token: T.instructor })).menu.apps.includes('availability'), 'the instructor menu keeps it');
  for (const role of ['owner', 'manager', 'counter']) assert.ok(!ok(await api('GET', '/auth/me', { token: T[role] })).menu.apps.includes('availability'), `${role}: not a menu item`);
  const main = read('public/js/main.js');
  assert.match(main, /availability: \(\) => \(ownAvailability\(\) \? null : AVAILABILITY_TAB\)/, 'others are sent to the Lessons tab');
  assert.match(main, /AVAILABILITY_TAB = '#\/school\?tab=team&view=availability'/);
  assert.match(main, /\['availability', 'My availability', \(\) => can\('instructor', 'counter'\)/, 'the route and who may open it are unchanged; an instructor knows it as My availability');
  const school = read('public/js/views/school.js');
  assert.match(school, /\['team', [^\n]*'instructors', 'availability', 'payroll'/, 'Lessons, Instructors, Availability');
  assert.match(school, /if \(!instructor\) items\.push\(\['availability', 'Availability'/, 'not for an instructor, who has My availability in their menu');
});

test('Patrol: old addresses resolve to the right part, and the parts are page tabs, not menu items', () => {
  const patrol = read('public/js/views/patrol.js');
  const list = /const SECTION_LIST = \[([\s\S]*?)\n\];/.exec(patrol)[1];
  let n = 0;
  for (const m of list.matchAll(/\['(\w+)', '\w+', '.*?', \[([^\]]*)\]\]/g)) {
    for (const k of m[2].match(/'[^']+'/g).map((x) => x.slice(1, -1))) { assert.equal(nav.patrolSection([k]), m[1], `#/patrol/${k}`); n += 1; }
  }
  assert.ok(n >= 25, 'every Patrol tab checked');
  for (const [params, want] of [[['case', '12'], 'cases'], [['claim', '3'], 'cases'], [['kit', '4'], 'gear'], [['kit-labels'], 'gear'], [['home'], 'now'], [['room'], 'now'], [[], 'now']]) assert.equal(nav.patrolSection(params), want, params.join('/'));
  assert.deepEqual(nav.PATROL_SECTIONS.map(([id]) => id), ['now', 'cases', 'people', 'gear']);
  assert.match(patrol, /linkTabs\(SECTIONS\.map/, 'row 1: Now, Cases, People, Gear as links');
  assert.match(patrol, /tabs\(section\.items, tabKey, \{ row: 2 \}\)/, 'row 2: the part\'s pages');
  assert.match(patrol, /h\('h1', null, 'Patrol'\)/);
  assert.ok(!read('public/js/nav.js').includes('nav-sections'), 'no Patrol sections in the side menu');
});

test('the look: quiet group headings, sentence case All apps, one row height, a thin shadow edge, filters as filters, one tab component', () => {
  const rule = (sel) => { const m = new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css); return m ? m[2] : null; };
  const fold = rule('.nav-fold');
  assert.ok(fold && /font-weight: 600/.test(fold) && /font-size: \.9375rem/.test(fold) && !/Barlow/.test(fold), 'group headings: Atkinson semibold at item size');
  assert.ok(/color: var\(--ink\)/.test(fold), 'the darker text color');
  const head = rule('.nav-all-head');
  assert.ok(head && !/uppercase/.test(head) && /color: var\(--side-muted\)/.test(head), 'All apps: small and muted, no capitals');
  assert.ok(!/role-menu[^{]*nav-row/.test(css), 'no taller rows for staff roles');
  assert.ok(!/nav-scroll[^{]*\{[^}]*mask-image/.test(css), 'no fade at the scroll edge');
  assert.match(css, /\.rail\.more-down \.nav-scroll \{[^}]*border-bottom: 1px solid/, 'a thin line and shadow instead');
  assert.match(css, /\.fchips button\[aria-pressed='true'\]::before \{ content: '✓'/, 'a check mark on the filter that is on');
  assert.match(css, /\.fchips button\[aria-pressed='true'\] \{ background: transparent;/, 'outlined, not filled like a tab');
  assert.ok(!/\.pbody > div > div > \.tabs/.test(css) && !/\.subtabs > \.tabs/.test(css), 'no app-specific tab rows left');
  assert.equal((css.match(/\n\.tabs\.row1 \{/g) || []).length, 1, 'row 1 is defined once');
  assert.equal((css.match(/\n\.tabs\.row2 \{/g) || []).length, 1, 'row 2 is defined once');
  assert.match(rule('.tabs.row2'), /flex-wrap: wrap/, 'row 2 wraps on a computer');
  assert.match(css, /\n {2}\.tabs\.row2 \{ gap: 6px; flex-wrap: nowrap; overflow-x: auto;/, 'and slides sideways in one line on a phone');
  assert.match(css, /\n {2}\.tabs\.row2 button \{ min-height: 44px;/, 'with 44px targets on phones');
  const ui = read('public/js/ui.js');
  assert.match(ui, /const row = opts\.row \|\| \(nesting > 0 \? 2 : 1\);/, 'tabs inside a tab are row 2 on their own');
  assert.match(ui, /export function linkTabs\(/);
  assert.match(read('public/js/views/sell.js'), /look: 'pills'/, 'Sell keeps its pills');
  const navSrc = read('public/js/nav.js');
  assert.match(navSrc, /aria-disabled', 'true'/, 'the current group is locked open');
  assert.ok(!/nav-more|more\.length\} more/.test(navSrc), 'no counts beside All apps or the groups');
});
