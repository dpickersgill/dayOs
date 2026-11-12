'use strict';

// The menu (2026.11.21): Home first for everyone, the role's menu as each person's starting pins, every app in its one
// section whether or not it is pinned, Settings and Help in the account menu, and a phone bar whose labels are never
// cut. The menu plan (public/js/nav.js) is checked for each role of a ski area and a municipality with the apps that
// role may open; the frame itself (the side menu, the top bar, the phone bar and sheet, and what pins.js, navcounts.js
// and newmenu.js call) is built in jsdom; the server menus (src/lib/menus.js) through the API; the look through the
// stylesheet. Instructor availability inside Lessons and Patrol's parts as page tabs are checked here too.
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

let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (_) { /* the frame tests are skipped below */ }
const skip = () => ({ skip: JSDOM ? false : 'jsdom is not installed' });

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const css = read('public/css/app.css');

let server; let base; let nav; let ui; let tmp;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const slug = `nav2-${suffix}`;
const PW = 'correct-horse-battery';
const T = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const windows = []; // every jsdom window a test opened, closed at the end

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
  documents: 'Documents', rentals: 'Rentals', school: 'Lessons', programs: 'Programs', availability: 'My availability', patrol: 'Patrol',
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
// A municipality: what each of its four roles may open, every app and add-on on.
const MUNI_LABELS = {
  dashboard: 'Today', inbox: 'Inbox', myshifts: 'My shifts', requests: 'Requests', notices: 'Street notices', bulk: 'Bulk pickup', works: 'Work orders', assets: 'Assets and fleet',
  assetprograms: 'Programs', buildings: 'Buildings', monthreport: 'Monthly report', water: 'Water', sewer: 'Sewer', stormwater: 'Stormwater', workforce: 'Staff and schedule',
  messages: 'Messages', documents: 'Documents', settings: 'Settings', help: 'Help',
};
const MUNI_OPENS = {
  owner: Object.keys(MUNI_LABELS), manager: Object.keys(MUNI_LABELS),
  staff: Object.keys(MUNI_LABELS).filter((k) => !['monthreport', 'workforce', 'messages'].includes(k)),
  counter: ['dashboard', 'inbox', 'myshifts', 'requests', 'notices', 'bulk', 'buildings', 'documents', 'settings', 'help'],
};
const muniViewsFor = (role) => Object.keys(MUNI_LABELS).filter((k) => MUNI_OPENS[role].includes(k)).map((k) => [k, MUNI_LABELS[k]]);

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-nav2-'));
  fs.cpSync(path.join(ROOT, 'public', 'js'), path.join(tmp, 'js'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  ui = await import(pathToFileURL(path.join(tmp, 'js', 'ui.js')).href);
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
  for (const w of windows) w.close(); // an open jsdom window keeps the process alive
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the plan

test('sections: Home is first and never in a section; a ski area has four sections in this order, a municipality four with Utilities', () => {
  assert.deepEqual(nav.HOME, ['dashboard', 'inbox', 'calendar', 'myshifts']);
  assert.deepEqual(nav.SECTIONS.map(([name, id]) => [name, id]), [['Guests and sales', 'sales'], ['Mountain', 'hill'], ['Ski school', 'school'], ['Back office', 'office']]);
  assert.deepEqual(nav.SECTIONS[0][2], ['sell', 'gate', 'shop', 'rentals', 'people', 'waivers', 'lostfound']);
  assert.deepEqual(nav.SECTIONS[1][2], ['conditions', 'park', 'patrol', 'area', 'assets']);
  assert.deepEqual(nav.SECTIONS[2][2], ['school', 'programs', 'availability']);
  assert.deepEqual(nav.SECTIONS[3][2], ['catalog', 'money', 'workforce', 'messages', 'documents']);
  assert.deepEqual(nav.MUNI_SECTIONS.map(([name, id, keys]) => [name, id, keys]), [
    ['Residents', 'residents', ['requests', 'notices', 'bulk']],
    ['Public works', 'works', ['works', 'assets', 'assetprograms', 'buildings', 'monthreport']],
    ['Utilities', 'utilities', ['water', 'sewer', 'stormwater']],
    ['Back office', 'office', ['workforce', 'messages', 'documents']],
  ]);
  for (const list of [nav.SECTIONS, nav.MUNI_SECTIONS]) {
    const all = list.flatMap(([, , keys]) => keys);
    assert.equal(new Set(all).size, all.length, 'an app has one home');
    for (const k of [...nav.HOME, 'settings', 'help']) assert.ok(!all.includes(k), `${k} is in no section`);
  }
  assert.equal(nav.SECTION_OF.patrol.name, 'Mountain');
  assert.equal(nav.SECTION_OF.water.id, 'utilities');
  assert.equal(nav.SECTION_OF.dashboard.id, 'home');
  assert.deepEqual(menus.HOME, nav.HOME, 'the server and the page agree on Home');
  assert.ok(!/All apps|openAllApps|On the hill/.test(read('public/js/nav.js')), 'no All apps sheet or command, and the old section name is gone');
});

test('menu plans, ski area: Home, the role\'s menu as starting pins, every app in its one section whether or not it is pinned; nothing gained or lost', () => {
  ui.ctx.me = { role: 'owner', org_type: 'mountain' };
  const want = {
    owner: ['money', 'conditions', 'patrol', 'school', 'people', 'workforce'],
    manager: ['conditions', 'sell', 'patrol', 'school', 'people', 'workforce'],
    counter: ['sell', 'gate', 'rentals', 'people', 'waivers', 'shop'],
    instructor: ['school', 'availability', 'people', 'waivers'],
    staff: ['conditions', 'gate', 'lostfound'],
    patrol: ['patrol', 'conditions'],
  };
  // The phone bar starts with the screen the menu opens on (2026.11.13), then the pins, then Home to make four.
  const phone = {
    owner: ['dashboard', 'money', 'conditions', 'patrol'], manager: ['dashboard', 'conditions', 'sell', 'patrol'], counter: ['sell', 'gate', 'rentals', 'people'],
    instructor: ['school', 'availability', 'people', 'waivers'], staff: ['dashboard', 'conditions', 'gate', 'lostfound'], patrol: ['patrol', 'conditions', 'myshifts', 'dashboard'],
  };
  for (const role of Object.keys(want)) {
    const views = viewsFor(role);
    const plan = nav.menuPlan(views, menus.menuFor(role, null));
    assert.deepEqual(plan.home, ['dashboard', 'inbox', 'calendar', 'myshifts'], `${role}: Home`);
    assert.deepEqual(plan.apps, want[role], `${role}: the role's menu`);
    assert.deepEqual(plan.pins, want[role].map((k) => ({ id: k, label: LABELS[k], href: k, app: k })), `${role}: the starting pins are the role's menu, in its order`);
    assert.deepEqual(plan.account, ['settings', 'help'], `${role}: Settings and Help are for the account menu`);
    assert.deepEqual(plan.bar.map((p) => p.href), phone[role], `${role}: the phone bar`);
    const inSections = plan.sections.flatMap((s) => s.keys);
    assert.equal(new Set(inSections).size, inSections.length, `${role}: an app shows once among the sections`);
    for (const k of plan.apps) assert.ok(inSections.includes(k), `${role}: ${k} is pinned and still in its section`);
    assert.deepEqual([...plan.home, ...inSections, ...plan.account].sort(), views.map(([k]) => k).sort(), `${role}: everything they may open is in the menu, and nothing else`);
    assert.ok(!plan.sections.some((s) => s.id === 'more'), `${role}: every app has a section`);
    assert.ok(plan.sections.every((s) => s.keys.length && nav.SECTIONS.some(([name, id]) => id === s.id && name === s.name)), `${role}: only sections with something in them`);
  }
  const owner = nav.menuPlan(viewsFor('owner'), menus.STANDARD.owner);
  assert.deepEqual(owner.sections.map((s) => [s.name, s.keys]), [
    ['Guests and sales', ['sell', 'gate', 'shop', 'rentals', 'people', 'waivers', 'lostfound']],
    ['Mountain', ['conditions', 'park', 'patrol', 'assets']],
    ['Ski school', ['school', 'programs']],
    ['Back office', ['catalog', 'money', 'workforce', 'messages', 'documents']],
  ]);
  assert.ok(!owner.sections.flatMap((s) => s.keys).includes('availability'), 'no Instructor availability item for an owner');
  assert.deepEqual(nav.menuPlan(viewsFor('patrol'), menus.STANDARD.patrol).sections.map((s) => s.name), ['Mountain', 'Back office'], 'a section with nothing for this person does not show');
  // A shortcut in the role's menu (a page inside an app) is a pin to that page, when the person may open its app.
  const links = { 'patrol-records': { label: 'Records requests', href: 'patrol/cases?tab=records', app: 'patrol', icon: 'documents' } };
  const director = nav.menuPlan(viewsFor('patrol'), { apps: ['patrol', 'patrol-records', 'conditions'], start: 'patrol' }, links);
  assert.deepEqual(director.pins[1], { id: 'patrol-records', label: 'Records requests', href: 'patrol/cases?tab=records', app: 'patrol', icon: 'documents' });
  assert.deepEqual(director.sections.flatMap((s) => s.keys), ['conditions', 'park', 'patrol', 'documents'], 'a shortcut is never a row of a section');
  assert.deepEqual(nav.menuPlan(viewsFor('staff'), { apps: ['patrol', 'patrol-records', 'conditions'], start: 'patrol' }, links).apps, ['conditions'], 'no Patrol: no pin into it');
  // An app nobody gave a section still shows, under More; with no role menu there are no pins.
  const none = nav.menuPlan([...viewsFor('staff'), ['newthing', 'New thing']], null);
  assert.deepEqual(none.pins, []);
  assert.deepEqual(none.sections[none.sections.length - 1], { name: 'More', id: 'more', keys: ['newthing'] });
  // The ski area's read-only login: the summary alone.
  const area = nav.menuPlan([['area', 'Summary'], ['settings', 'Settings'], ['help', 'Help']], nav.AREA_MENU);
  assert.deepEqual([area.home, area.sections.map((s) => s.keys), area.bar.map((p) => p.href), area.account], [[], [['area']], ['area'], ['settings', 'help']]);
});

test('menu plans, municipality: its own sections, Utilities apart from Public works, the same rules', () => {
  ui.ctx.me = { role: 'owner', org_type: 'municipality' };
  try {
    for (const role of ['owner', 'manager', 'staff', 'counter']) {
      const views = muniViewsFor(role);
      const menu = menus.muniMenuFor(role);
      const plan = nav.menuPlan(views, menu);
      assert.deepEqual(plan.home, ['dashboard', 'inbox', 'myshifts'], `${role}: Home (a municipality has no Calendar)`);
      assert.deepEqual(plan.pins.map((p) => p.href), menu.apps, `${role}: the starting pins`);
      const inSections = plan.sections.flatMap((s) => s.keys);
      assert.deepEqual([...plan.home, ...inSections, ...plan.account].sort(), views.map(([k]) => k).sort(), `${role}: everything they may open, nothing else`);
      assert.ok(!plan.sections.some((s) => s.id === 'more'), `${role}: every app has a section`);
      assert.equal(plan.bar.length, 4);
      assert.equal(plan.bar[0].href, 'dashboard', `${role}: the bar starts on Today`);
    }
    const manager = nav.menuPlan(muniViewsFor('manager'), menus.muniMenuFor('manager'));
    assert.deepEqual(manager.sections.map((s) => [s.name, s.keys]), [
      ['Residents', ['requests', 'notices', 'bulk']],
      ['Public works', ['works', 'assets', 'assetprograms', 'buildings', 'monthreport']],
      ['Utilities', ['water', 'sewer', 'stormwater']],
      ['Back office', ['workforce', 'messages', 'documents']],
    ]);
    assert.deepEqual(nav.menuPlan(muniViewsFor('counter'), menus.muniMenuFor('counter')).sections.map((s) => s.name), ['Residents', 'Public works', 'Back office'], 'the front desk has no Utilities');
  } finally { ui.ctx.me = null; }
});

test('the phone bar: every app has a label of 12 letters or fewer, and a pin\'s own name is never cut inside a word', () => {
  const main = read('public/js/main.js');
  const keys = [...main.matchAll(/^ {2}\['([a-z]+)', '([^']+)', \(\) =>/gm)].map((m) => [m[1], m[2]]);
  assert.ok(keys.length >= 35, 'every view in main.js was found');
  for (const [k, text] of keys) {
    const shown = nav.barLabel({ label: text, href: k, app: k });
    assert.ok(shown && shown.length <= nav.BAR_LABEL_MAX, `${k}: "${shown}" fits the bar`);
    assert.ok(nav.SHORT[k] || text.length <= nav.BAR_LABEL_MAX || k === 'brief', `${k} has a short name`); // the Morning brief is never a menu item
  }
  for (const v of Object.values(nav.SHORT)) assert.ok(v.length <= 12, v);
  assert.equal(nav.barLabel({ label: 'Assets and fleet', href: 'assets', app: 'assets' }), 'Assets', 'never "Assets and ..."');
  assert.equal(nav.barLabel({ label: 'Records requests', href: 'patrol/cases?tab=records', app: 'patrol' }), 'Records');
  assert.equal(nav.barLabel({ label: 'Access log', href: 'patrol/cases?tab=access', app: 'patrol' }), 'Access log');
  assert.equal(nav.barLabel({ label: 'Overdue water work orders', href: 'works?dept=water&status=overdue', app: 'works' }), 'Overdue', 'whole words only');
  assert.equal(nav.barLabel({ label: 'Supercalifragilistic list', href: 'works?x=1', app: 'works' }), 'Work orders', 'a first word that is too long: the app\'s short name');
  assert.equal(nav.barLabel({ label: 'My jobs', href: 'works?mine=1', app: 'works' }), 'My jobs', 'a pin keeps its own name when it fits');
  assert.match(css, /\n\.tab span \{ white-space: nowrap; \}/, 'bar labels are on one line');
  assert.ok(!/\n\.tab span \{[^}]*text-overflow/.test(css), 'and are never cut with an ellipsis');
});

test('samePage: a pin is lit on its own page, with its tab and filters', () => {
  assert.ok(nav.samePage('patrol/cases?tab=records', 'patrol/cases?tab=records'));
  assert.ok(nav.samePage('patrol/cases?tab=records', 'patrol/cases?tab=records&q=smith'));
  assert.ok(!nav.samePage('patrol/cases?tab=records', 'patrol/cases?tab=access'));
  assert.ok(!nav.samePage('patrol/cases?tab=records', 'patrol/cases'));
  assert.ok(!nav.samePage('works?dept=water&status=overdue', 'works?dept=water'));
  assert.ok(nav.samePage('works', 'works?tab=done'));
  assert.ok(!nav.samePage('works', 'works/12'));
});

// ---------------------------------------------------------------- the server's role menus (the starting pins)

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
  assert.deepEqual(saved.menu, { apps: ['money', 'patrol'], start: 'dashboard' }, 'Home apps are left out: they are the first rows for everyone');
  const me = ok(await api('GET', '/auth/me', { token: T.manager }));
  assert.deepEqual(me.menu, saved.menu);
  // A role-menu change reaches everyone who starts from it: the plan's pins are that menu.
  ui.ctx.me = { role: 'manager', org_type: 'mountain' };
  assert.deepEqual(nav.menuPlan(viewsFor('manager'), me.menu, me.menu_links).pins.map((p) => p.href), ['money', 'patrol']);
  ui.ctx.me = null;
  // A menu kept before Home was set apart, with Home apps in it, drops them when read.
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

// ---------------------------------------------------------------- the frame, in jsdom

/** A page to build the frame in. width: the window's width (the menu starts collapsed under 1280). */
function page({ width = 1440, hash = '' } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: `http://frame.test/${hash}`, pretendToBeVisual: true });
  const w = dom.window;
  windows.push(w);
  w.scrollTo = () => {};
  Object.defineProperty(w, 'innerWidth', { value: width, configurable: true, writable: true });
  for (const k of ['document', 'Node', 'HTMLElement', 'sessionStorage', 'localStorage', 'location', 'history', 'Event', 'CustomEvent']) Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: w, configurable: true, writable: true });
  return w;
}
/** Builds the frame for a person. Returns { frame, main, w, heard } (heard: the nav: events, in order). */
function frameFor({ me, views, menu, links = {}, navSaved = null, width, hash, store = {} }) {
  const w = page({ width, hash });
  for (const [k, v] of Object.entries({ 'so.nav.moved': JSON.stringify({ first: Date.now(), done: true }), ...store })) if (v !== null) w.localStorage.setItem(k, v);
  ui.ctx.me = { id: 7, email: 'pat@x.test', login_name: 'pat@x.test', tenant: 't', tenant_name: 'Test Mountain', org_type: 'mountain', modules: null, ...me };
  const main = w.document.createElement('main');
  main.tabIndex = -1;
  const heard = [];
  for (const name of ['nav:page', 'nav:edit-pins', 'nav:row-menu']) w.addEventListener(name, (e) => heard.push([name, e.detail]));
  const frame = nav.buildFrame({ views, main, signOut: () => { heard.push(['signout']); }, menu, links, nav: navSaved });
  w.document.getElementById('app').append(frame.shell);
  return { frame, main, w, heard, doc: w.document };
}
const texts = (root, sel) => [...root.querySelectorAll(sel)].map((el) => el.textContent.trim());
const press = (w, el, key, extra = {}) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));

test('the side menu: one list (Home, Pinned, every section open), Settings and Help in the account menu, the page marked', skip(), async () => {
  const { frame, doc, w, heard } = frameFor({ me: { role: 'owner' }, views: viewsFor('owner'), menu: menus.STANDARD.owner });
  const rail = doc.querySelector('.rail');
  assert.deepEqual([...rail.children].map((el) => el.className), ['rail-org', 'nav', 'rail-foot'], 'the organization, one list, the person: nothing else is pinned');
  assert.equal(rail.querySelector('.rail-org strong').textContent, 'Test Mountain');
  assert.equal(rail.querySelector('.rail-org .org-text span').textContent, 'Verdynt/OS');
  assert.equal(rail.querySelector('.rail-org').querySelectorAll('button').length, 1, 'the name is not a button: only the collapse button');
  assert.deepEqual(texts(rail, '.nav-home .nav-row'), ['Today', 'Inbox', 'Calendar', 'My shifts']);
  assert.deepEqual(texts(rail, '.nav-pins .nav-row'), ['Money', 'Mountain status', 'Patrol', 'Lessons', 'Customers', 'Staff and schedule'], 'Pinned starts as the role\'s menu');
  assert.equal(rail.querySelector('.nav-pins .nav-title').textContent, 'Pinned');
  assert.deepEqual(texts(rail, '.nav-fold'), ['Guests and sales', 'Mountain', 'Ski school', 'Back office']);
  assert.ok([...rail.querySelectorAll('.nav-fold')].every((b) => b.getAttribute('aria-expanded') === 'true' && !doc.getElementById(b.getAttribute('aria-controls')).hidden), 'every section starts open');
  const rows = [...rail.querySelectorAll('.nav .nav-row')];
  assert.equal(rows.length, 4 + 6 + 18, 'Home, six pins, and all eighteen apps in their sections');
  assert.ok(!rows.some((a) => ['settings', 'help'].includes(a.dataset.key)), 'Settings and Help are not rows of the list');
  assert.equal(rail.querySelectorAll('.nav-row[data-key=patrol]').length, 2, 'a pinned app is still in its section');
  assert.ok(rows.every((a) => a.closest('li') && a.querySelector('svg') && a.querySelector('.nav-label').textContent), 'every row is a list item with an icon and a name');
  assert.equal(doc.querySelector('.nav-all-head, .rail-search, .nav-help-here, .rail-out, .theme-btn'), null, 'nothing of the old pinned top and bottom is left');
  // the open page: its row in its section and its pin, and the top bar says it
  w.location.hash = '#/patrol/cases';
  frame.setCurrent('patrol', ['cases']);
  frame.setWhere({ part: 'Cases', help: { href: '#/help/for-patrol?part=cases', label: 'Help with Patrol' } });
  assert.deepEqual([...rail.querySelectorAll('.nav-row[aria-current=page]')].map((a) => [a.dataset.key, Boolean(a.dataset.pin)]), [['patrol', true], ['patrol', false]]);
  assert.equal(doc.querySelector('.top-where').textContent, 'Patrol›Cases');
  assert.equal(doc.querySelector('.top-where .where-app a').getAttribute('href'), '#/patrol', 'with a part showing, the app is the way back to its first page');
  assert.equal(doc.querySelector('.top-where').closest('h1, h2, h3'), null, 'the top bar\'s words are not a heading: the page keeps its own h1');
  assert.equal(doc.querySelector('.top-help').getAttribute('href'), '#/help/for-patrol?part=cases');
  assert.deepEqual(heard.at(-1), ['nav:page', { key: 'patrol', href: 'patrol/cases', label: 'Patrol: Cases' }]);
  assert.deepEqual(frame.page, { key: 'patrol', href: 'patrol/cases', label: 'Patrol: Cases' }, 'a module that starts late reads the page from the frame');
  const before = heard.length;
  frame.setWhere({ part: 'Cases', help: null });
  assert.equal(heard.length, before, 'the same page said twice is told once');
  assert.equal(doc.querySelector('.top-help').hidden, true);
  // the account menu
  const acct = rail.querySelector('.acct');
  assert.equal(acct.getAttribute('aria-haspopup'), 'menu');
  acct.click();
  const menu = rail.querySelector('.acct-menu');
  assert.equal(menu.getAttribute('role'), 'menu');
  assert.equal(acct.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(texts(menu, '[role=menuitem], [role=menuitemradio]').map((t) => t.replace(/ \d.*$/, '')), ['Your profile and sign-in', 'Settings', "Help and What's new", 'Light', 'Dark', 'Device', 'Sign out', 'Verdynt/OS']);
  assert.deepEqual([...menu.querySelectorAll('a.menu-row')].map((a) => a.getAttribute('href')), ['#/settings/profile', '#/settings/organization', '#/help']);
  assert.deepEqual([...menu.querySelectorAll('[role=menuitemradio]')].map((b) => b.getAttribute('aria-label')), ['Light', 'Dark', 'Same as this device']);
  assert.equal(menu.querySelector('.who-version').getAttribute('href'), '#/help/whats-new');
  assert.equal(doc.activeElement, menu.querySelector('[role=menuitem]'), 'focus moves into the menu');
  press(w, doc.activeElement, 'ArrowDown');
  assert.equal(doc.activeElement.textContent, 'Settings');
  press(w, doc.activeElement, 'End');
  assert.match(doc.activeElement.className, /who-version/);
  menu.querySelector('[data-theme=dark]').click();
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark');
  assert.equal(menu.querySelector('[data-theme=dark]').getAttribute('aria-checked'), 'true');
  assert.ok(menu.isConnected, 'choosing a theme leaves the menu open');
  menu.querySelector('[data-theme=device]').click();
  press(w, doc.activeElement, 'Escape');
  assert.equal(rail.querySelector('.acct-menu'), null);
  assert.equal(acct.getAttribute('aria-expanded'), 'false');
  assert.equal(doc.activeElement, acct, 'Escape closes it and focus returns to the account row');
  acct.click();
  [...rail.querySelectorAll('.acct-menu .menu-row')].find((b) => b.textContent === 'Sign out').click();
  assert.deepEqual(heard.at(-1), ['signout']);
  assert.equal(rail.querySelector('.acct-menu'), null);
  await sleep(250); // the strip's timers
});

test('the account menu: Settings only for people with more than their own profile there; Switch person on a shared computer; the area login', skip(), async () => {
  const items = (f) => { f.doc.querySelector('.acct').click(); return texts(f.doc, '.acct-menu .menu-row'); };
  assert.deepEqual(items(frameFor({ me: { role: 'counter' }, views: viewsFor('counter'), menu: menus.STANDARD.counter })), ['Your profile and sign-in', "Help and What's new", 'Sign out']);
  assert.deepEqual(items(frameFor({ me: { role: 'manager' }, views: viewsFor('manager'), menu: menus.STANDARD.manager })), ['Your profile and sign-in', 'Settings', "Help and What's new", 'Sign out']);
  const director = frameFor({ me: { role: 'patrol', patrol_lead: true }, views: viewsFor('patrol'), menu: menus.STANDARD.patrol });
  assert.deepEqual(items(director), ['Your profile and sign-in', 'Settings', "Help and What's new", 'Sign out']);
  assert.equal(director.doc.querySelector('.acct-menu a[href="#/settings/patrol"]').textContent, 'Settings');
  const shared = frameFor({ me: { role: 'counter', terminal: { id: 3, name: 'Ticket window 1' } }, views: viewsFor('counter'), menu: menus.STANDARD.counter });
  assert.deepEqual(items(shared), ['Your profile and sign-in', "Help and What's new", 'Switch person', 'Sign out']);
  assert.equal(shared.frame.canEdit, false, 'a session opened by PIN on a shared computer keeps its role\'s menu');
  const area = frameFor({ me: { role: 'area' }, views: [['area', 'Summary'], ['settings', 'Settings'], ['help', 'Help']], menu: nav.AREA_MENU, navSaved: { pins: [{ id: 'x', label: 'Summary', href: 'area', app: 'area' }], bar: null } });
  assert.equal(area.frame.canEdit, false);
  assert.deepEqual(texts(area.doc, '.rail .nav-row'), ['Summary'], 'the read-only login keeps its one-item menu');
  assert.equal(area.doc.querySelector('.nav-pins').hidden, true, 'and has no pins');
  area.frame.setPins([{ id: 'x', label: 'Summary', href: 'area', app: 'area' }], null);
  assert.equal(area.doc.querySelector('.nav-pins').hidden, true);
  assert.equal(area.doc.querySelector('.nav-edit').hidden, true);
  assert.deepEqual(items(area), ['Your profile and sign-in', "Help and What's new", 'Sign out']);
  assert.equal(area.doc.querySelector('.top-inbox, .top-sos'), null, 'no Inbox and no Guest needs help for it');
  await sleep(250);
});

test('what the other modules call: setPins, setBadge (with alert), setNew, addCommands, canEdit, slots.star and the nav: events', skip(), async () => {
  const f = frameFor({ me: { role: 'manager', org_type: 'municipality' }, views: muniViewsFor('manager'), menu: menus.muniMenuFor('manager') });
  const { frame, doc, w, heard } = f;
  assert.equal(frame.canEdit, true);
  for (const k of ['shell', 'plan', 'setCurrent', 'setWhere', 'setPins', 'setBadge', 'setNew', 'addCommands', 'openPalette', 'openSheet']) assert.ok(frame[k], k);
  assert.equal(frame.openAllApps, undefined, 'All apps is gone');
  // the star's place: empty, in the top bar, left of Jump to
  const kids = [...doc.querySelector('.topbar').children];
  assert.equal(frame.slots.star.parentElement, doc.querySelector('.topbar'));
  assert.equal(frame.slots.star.childNodes.length, 0);
  assert.equal(kids.indexOf(frame.slots.star) + 1, kids.indexOf(doc.querySelector('.top-jump')));
  assert.deepEqual(kids.map((el) => el.className.split(' ').pop()), ['top-brand', 'top-where', 'top-star', 'top-jump', 'top-new', 'top-ask', 'top-inbox', 'top-help'], 'where you are, the star, Jump to, + New, Ask, Inbox, Help');
  // until setPins: the role's menu, and no Edit link (nobody is there to answer it yet)
  assert.deepEqual(texts(doc, '.nav-pins .nav-row'), ['Requests', 'Work orders', 'Assets and fleet', 'Staff and schedule']);
  assert.equal(doc.querySelector('.nav-pins .nav-edit').hidden, true);
  assert.deepEqual(texts(doc, '.tabbar .tab'), ['Today', 'Requests', 'Work orders', 'Assets', 'Menu']);
  // setPins: the person's own; a pin whose app they may not open is left out
  frame.setPins([
    { id: 'a', label: 'Requests', href: 'requests', app: 'requests' },
    { id: 'b', label: 'Overdue water work orders', href: 'works?dept=water&status=overdue', app: 'works' },
    { id: 'c', label: 'Ski patrol', href: 'patrol', app: 'patrol' },
    { id: 'd', label: 'On call', href: 'workforce?tab=oncall', app: 'workforce', icon: 'clock' },
  ], null);
  assert.deepEqual(texts(doc, '.nav-pins .nav-row'), ['Requests', 'Overdue water work orders', 'On call']);
  assert.deepEqual([...doc.querySelectorAll('.nav-pins .nav-row')].map((a) => a.getAttribute('href')), ['#/requests', '#/works?dept=water&status=overdue', '#/workforce?tab=oncall']);
  assert.equal(doc.querySelector('.nav-pins .nav-edit').hidden, false, 'Edit shows once pins.js is there');
  assert.deepEqual(texts(doc, '.tabbar .tab'), ['Today', 'Requests', 'Overdue', 'On call', 'Menu'], 'the default bar: the start screen, then the pins');
  assert.equal(doc.querySelector('.tabbar .tab:nth-child(3)').getAttribute('aria-label'), 'Overdue water work orders', 'the whole name is the link\'s name');
  doc.querySelector('.nav-pins .nav-edit').click();
  assert.deepEqual(heard.at(-1), ['nav:edit-pins', { bar: false }]);
  // a bar of the person's own
  frame.setPins([{ id: 'a', label: 'Requests', href: 'requests', app: 'requests' }], [{ label: 'My shifts', href: 'myshifts', app: 'myshifts' }, { label: 'Requests', href: 'requests', app: 'requests' }]);
  assert.deepEqual(texts(doc, '.tabbar .tab'), ['My shifts', 'Requests', 'Menu']);
  frame.setPins([], null);
  assert.equal(doc.querySelector('.nav-pins').hidden, true, 'no pins: no Pinned label');
  frame.setPins([{ id: 'a', label: 'Requests', href: 'requests', app: 'requests' }, { id: 'b', label: 'Overdue water work orders', href: 'works?dept=water&status=overdue', app: 'works' }, { id: 'w', label: 'Work orders', href: 'works', app: 'works' }], null);
  // setBadge: every place the app shows at its own address; not a pin to a page inside it
  frame.setBadge('works', 6, { says: 'overdue', alert: true });
  frame.setBadge('requests', 4, { says: 'new' });
  frame.setBadge('inbox', 3);
  const badge = (el) => { const b = el.querySelector('.nav-badge'); return b ? `${b.textContent}${b.classList.contains('alert') ? '!' : ''}` : null; };
  assert.deepEqual([...doc.querySelectorAll('.rail .nav-row[data-key=works]')].map((a) => [a.getAttribute('href'), badge(a)]), [['#/works?dept=water&status=overdue', null], ['#/works', '6!'], ['#/works', '6!']]);
  assert.deepEqual([...doc.querySelectorAll('.rail .nav-row[data-key=requests]')].map(badge), ['4', '4']);
  assert.equal(doc.querySelector('.rail .nav-row[data-key=works]:not([data-pin])').getAttribute('aria-description'), '6 overdue', 'said once: the number is hidden from screen readers and in the description');
  assert.equal(doc.querySelector('.rail .nav-row[data-key=works] .nav-badge').getAttribute('aria-hidden'), 'true');
  assert.equal(badge(doc.querySelector('.tabbar .tab[data-key=requests]')), '4', 'the phone bar');
  assert.equal(badge(doc.querySelector('.top-inbox')), '3', 'Inbox in the top bar');
  assert.equal(badge(doc.querySelector('.rail .nav-row[data-key=inbox]')), '3');
  frame.setPins([{ id: 'w', label: 'Work orders', href: 'works', app: 'works' }], null);
  assert.equal(badge(doc.querySelector('.nav-pins .nav-row')), '6!', 'a count is kept when the pins are drawn again');
  frame.openSheet();
  assert.equal(badge(doc.querySelector('.menu-sheet .sheet-item[data-key=works]')), '6!', 'the sheet tile');
  doc.querySelector('.sheet-close').click();
  frame.setBadge('works', 0);
  assert.equal(doc.querySelector('.rail .nav-row[data-key=works] .nav-badge'), null, '0 removes it');
  assert.equal(doc.querySelector('.rail .nav-row[data-key=works]').getAttribute('aria-description'), null);
  // What's new: a dot on the account row, the menu's Help row, and the phone's Menu button
  frame.setBadge('help', 2, { dot: true, says: 'new' });
  assert.ok(doc.querySelector('.acct').classList.contains('has-new') && doc.querySelector('.tab-menu').classList.contains('has-new'));
  doc.querySelector('.acct').click();
  assert.ok(doc.querySelector('.acct-menu a[href="#/help"] .nav-badge.dot'));
  press(w, doc.activeElement, 'Escape');
  frame.setBadge('help', 0, { dot: true });
  assert.ok(!doc.querySelector('.acct').classList.contains('has-new') && !doc.querySelector('.tab-menu').classList.contains('has-new'));
  // setNew: the button and its menu; an empty list hides both
  assert.equal(doc.querySelector('.top-new').hidden, true, 'nothing to create: no button');
  assert.equal(doc.querySelector('.new-fab').hidden, true);
  frame.setCurrent('works');
  frame.setNew([{ id: 'wo', label: 'Work order', href: 'works?new=1', app: 'works' }, { id: 'req', label: 'Request', href: '#/requests?new=1', app: 'requests' }]);
  assert.equal(doc.querySelector('.top-new').hidden, false);
  assert.equal(doc.querySelector('.new-fab').hidden, false, 'on a phone, on a page whose app has something to create');
  const newBtn = doc.querySelector('.top-new-btn');
  newBtn.click();
  assert.equal(newBtn.getAttribute('aria-expanded'), 'true');
  assert.deepEqual([...doc.querySelectorAll('.new-menu [role=menuitem]')].map((a) => [a.textContent, a.getAttribute('href')]), [['Work order', '#/works?new=1'], ['Request', '#/requests?new=1']]);
  press(w, doc.activeElement, 'Escape');
  assert.equal(doc.querySelector('.new-menu'), null);
  assert.equal(doc.activeElement, newBtn);
  frame.setCurrent('assets');
  assert.equal(doc.querySelector('.new-fab').hidden, true, 'not on a page whose app has nothing to create');
  frame.setCurrent('requests');
  doc.querySelector('.new-fab').click();
  assert.deepEqual(texts(doc, '.new-sheet .menu-row'), ['Request', 'Work order'], 'the open app\'s own first');
  doc.querySelector('.new-sheet .sheet-close').click();
  frame.setNew([]);
  assert.ok(doc.querySelector('.top-new').hidden && doc.querySelector('.new-fab').hidden);
  // addCommands: asked each time Jump to opens
  let asked = 0; let ran = 0;
  frame.addCommands(() => { asked += 1; return [{ id: 'pin', title: 'Pin this page', hint: '', icon: 'star', words: 'favorite star', run: () => { ran += 1; } }]; });
  frame.openPalette();
  const box = doc.querySelector('.palette-input');
  assert.ok(texts(doc, '.palette-item .p-title').includes('Pin this page'));
  assert.ok(!texts(doc, '.palette-item .p-title').includes('All apps'));
  box.value = 'favorite'; box.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.deepEqual(texts(doc, '.palette-item .p-title'), ['Pin this page']);
  press(w, doc, 'Enter');
  assert.equal(ran, 1);
  assert.ok(asked >= 2);
  assert.equal(doc.querySelector('.palette-overlay'), null);
  // right-click on a row: the frame stops the browser's menu, says which row, and shows nothing itself
  const row = doc.querySelector('.rail .nav-sec[data-section=residents] .nav-row[data-key=notices]');
  const ev = new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 300 });
  row.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(heard.at(-1), ['nav:row-menu', { key: 'notices', href: 'notices', label: 'Street notices', x: 40, y: 300, pinned: false }]);
  await sleep(450);
  doc.querySelector('.nav-pins .nav-row').dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1, clientY: 2 }));
  assert.deepEqual(heard.at(-1), ['nav:row-menu', { key: 'works', href: 'works', label: 'Work orders', x: 1, y: 2, pinned: true }]);
  // the server's saved pins come with the first paint
  const saved = frameFor({ me: { role: 'manager', org_type: 'municipality' }, views: muniViewsFor('manager'), menu: menus.muniMenuFor('manager'), navSaved: { pins: [{ id: 'z', label: 'Sewer', href: 'sewer', app: 'sewer' }], bar: null, custom: true } });
  assert.deepEqual(texts(saved.doc, '.nav-pins .nav-row'), ['Sewer']);
  // where the menu cannot be changed, a right-click is the browser's own
  const shared = frameFor({ me: { role: 'staff', org_type: 'municipality', terminal: { id: 1, name: 'Garage' } }, views: muniViewsFor('staff'), menu: menus.muniMenuFor('staff') });
  shared.frame.setPins(shared.frame.plan.pins, null);
  const ev2 = new shared.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  shared.doc.querySelector('.rail .nav-row[data-key=works]').dispatchEvent(ev2);
  assert.equal(ev2.defaultPrevented, false);
  assert.equal(shared.heard.length, 0);
  assert.equal(shared.doc.querySelector('.nav-pins .nav-edit').hidden, true, 'and there is no Edit link');
  ui.ctx.me = null;
  await sleep(250);
});

test('sections fold: remembered on this device, and the section holding the open page opens and stays open', skip(), async () => {
  const f = frameFor({ me: { role: 'owner' }, views: viewsFor('owner'), menu: menus.STANDARD.owner, store: { 'so.nav.folded': JSON.stringify(['hill']) } });
  const { frame, doc, w } = f;
  const fold = (id) => doc.querySelector(`.nav-fold[data-section=${id}]`);
  const body = (id) => doc.getElementById(fold(id).getAttribute('aria-controls'));
  assert.equal(fold('hill').getAttribute('aria-expanded'), 'false', 'folded here before: still folded');
  assert.equal(body('hill').hidden, true);
  assert.equal(fold('sales').closest('h2').className, 'nav-head', 'a section label is a heading that holds a button');
  fold('sales').click();
  assert.equal(fold('sales').getAttribute('aria-expanded'), 'false');
  assert.equal(body('sales').hidden, true);
  assert.deepEqual(JSON.parse(w.localStorage.getItem('so.nav.folded')).sort(), ['hill', 'sales']);
  fold('sales').click();
  assert.equal(body('sales').hidden, false);
  // landing on a page in a folded section opens it, and it cannot be folded away from the page
  frame.setCurrent('patrol');
  assert.equal(fold('hill').getAttribute('aria-expanded'), 'true');
  assert.equal(body('hill').hidden, false);
  assert.equal(fold('hill').getAttribute('aria-disabled'), 'true');
  fold('hill').click();
  assert.equal(body('hill').hidden, false, 'a press does nothing while the open page is in it');
  frame.setCurrent('money');
  assert.equal(fold('hill').getAttribute('aria-disabled'), null);
  assert.equal(body('hill').hidden, true, 'back to how this device kept it once the page is elsewhere');
  await sleep(250);
});

test('collapsed: by the button or Ctrl+\\, kept on this device; with nothing kept it follows the window (a strip under 1280)', skip(), async () => {
  const wide = frameFor({ me: { role: 'owner' }, views: viewsFor('owner'), menu: menus.STANDARD.owner, width: 1280 });
  const shell = (f) => f.doc.querySelector('.shell');
  const toggle = wide.doc.querySelector('.rail-toggle');
  assert.ok(!shell(wide).classList.contains('collapsed'), '1280 and over: open');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), 'Collapse the menu');
  assert.equal(toggle.getAttribute('aria-controls'), wide.doc.querySelector('.rail .nav').id);
  toggle.click();
  assert.ok(shell(wide).classList.contains('collapsed'));
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-label'), 'Keep the menu open');
  assert.equal(wide.w.localStorage.getItem('so.nav.collapsed'), '1');
  assert.ok([...wide.doc.querySelectorAll('.rail .nav-row')].every((a) => a.querySelector('.nav-label').textContent), 'collapsed, every icon still has its name');
  press(wide.w, wide.doc.body, '\\', { ctrlKey: true });
  assert.ok(!shell(wide).classList.contains('collapsed'), 'Ctrl+\\ opens it again');
  assert.equal(wide.w.localStorage.getItem('so.nav.collapsed'), '0');
  press(wide.w, wide.doc.body, '\\', { metaKey: true });
  assert.ok(shell(wide).classList.contains('collapsed'), 'Cmd+\\ on a Mac');
  // keyboard focus in the strip shows the whole menu over the page; Escape puts it away
  const first = wide.doc.querySelector('.rail .nav-row');
  first.focus();
  assert.ok(wide.doc.querySelector('.rail').classList.contains('peek'));
  press(wide.w, first, 'Escape');
  assert.ok(!wide.doc.querySelector('.rail').classList.contains('peek'));
  assert.equal(wide.doc.activeElement.tagName, 'MAIN');
  // the account menu opens beside the strip: the strip stays a strip
  first.focus();
  wide.doc.querySelector('.acct').click();
  assert.ok(!wide.doc.querySelector('.rail').classList.contains('peek'));
  assert.ok(wide.doc.querySelector('.acct-menu'));
  press(wide.w, wide.doc.activeElement, 'Escape');
  // nothing kept: under 1280 it starts as a strip, and follows the window
  const narrow = frameFor({ me: { role: 'owner' }, views: viewsFor('owner'), menu: menus.STANDARD.owner, width: 1279 });
  assert.ok(shell(narrow).classList.contains('collapsed'));
  narrow.w.innerWidth = 1400;
  narrow.w.dispatchEvent(new narrow.w.Event('resize'));
  assert.ok(!shell(narrow).classList.contains('collapsed'));
  // a kept choice wins over the width
  const keptOpen = frameFor({ me: { role: 'owner' }, views: viewsFor('owner'), menu: menus.STANDARD.owner, width: 1000, store: { 'so.nav.collapsed': '0' } });
  assert.ok(!shell(keptOpen).classList.contains('collapsed'));
  const keptShut = frameFor({ me: { role: 'owner' }, views: viewsFor('owner'), menu: menus.STANDARD.owner, width: 1600, store: { 'so.nav.collapsed': '1' } });
  assert.ok(shell(keptShut).classList.contains('collapsed'));
  await sleep(250);
});

test('the phone: the bar from the person\'s places, and the Menu sheet as open grids with one account row', skip(), async () => {
  const f = frameFor({ me: { role: 'patrol', patrol_lead: true, modules: ['patrol', 'conditions'] }, views: viewsFor('patrol'), menu: { apps: ['patrol', 'patrol-records', 'conditions'], start: 'patrol' }, links: { 'patrol-records': { label: 'Records requests', href: 'patrol/cases?tab=records', app: 'patrol', icon: 'documents' } }, hash: '#/patrol/cases?tab=records' });
  const { frame, doc, w, heard } = f;
  frame.setPins(frame.plan.pins, null);
  assert.deepEqual(texts(doc, '.tabbar .tab'), ['Patrol', 'Records', 'Mountain', 'My shifts', 'Menu']);
  assert.ok(texts(doc, '.tabbar .tab .tab-text').every((t) => t.length <= 12));
  frame.setCurrent('patrol', ['cases']);
  assert.deepEqual([...doc.querySelectorAll('.tabbar .tab[aria-current=page]')].map((a) => a.textContent), ['Records'], 'the pin that names this page, not the app\'s own');
  assert.deepEqual([...doc.querySelectorAll('.rail .nav-row[aria-current=page]')].map((a) => a.textContent), ['Records requests', 'Patrol'], 'and in the side menu: that pin, and the app in its section');
  assert.ok(doc.querySelector('.top-sos'), 'Guest needs help, for the people who had it');
  doc.querySelector('.tab-menu').click();
  const sheet = doc.querySelector('.menu-sheet.phone-menu');
  assert.equal(sheet.getAttribute('role'), 'dialog');
  assert.equal(sheet.querySelector('h2').textContent, 'Menu');
  assert.deepEqual([...sheet.querySelector('.sheet-body').children].map((el) => el.className.split(' ')[0] === 'btn' ? 'sheet-help-here' : el.className.split(' ').slice(0, 2).join(' ')),
    ['sheet-search', 'sheet-help-here', 'sheet-sec sheet-home', 'sheet-sec sheet-pins', 'sheet-sec', 'sheet-sec', 'sheet-acct'], 'search, Guest needs help, Home, Pinned, the sections, the account');
  assert.deepEqual(texts(sheet, '.sheet-home .sheet-item'), ['Today', 'Inbox', 'Calendar', 'My shifts']);
  assert.deepEqual(texts(sheet, '.sheet-pins .sheet-item'), ['Patrol', 'Records requests', 'Mountain status']);
  assert.deepEqual(texts(sheet, '.sheet-label h3'), ['Pinned', 'Mountain', 'Back office']);
  assert.equal(sheet.querySelector('.nav-fold'), null, 'no folding on the phone');
  assert.deepEqual([...sheet.querySelectorAll('.sheet-item[aria-current=page]')].map((a) => a.textContent), ['Records requests', 'Patrol']);
  sheet.querySelector('.sheet-pins .nav-edit').click();
  assert.equal(doc.querySelector('.menu-sheet'), null, 'Edit closes the sheet first');
  assert.deepEqual(heard.at(-1), ['nav:edit-pins', { bar: false }]);
  // the account sheet, over the Menu; Escape closes only the top one
  doc.querySelector('.tab-menu').click();
  doc.querySelector('.sheet-acct').click();
  const acct = doc.querySelector('.menu-sheet.acct-sheet');
  assert.deepEqual(texts(acct, '.menu-row'), ['Your profile and sign-in', 'Settings', "Help and What's new", 'Sign out']);
  assert.deepEqual([...acct.querySelectorAll('.theme-seg [role=radio]')].map((b) => b.getAttribute('aria-label')), ['Light', 'Dark', 'Same as this device']);
  assert.ok(acct.querySelector('.who-version'));
  press(w, doc, 'Escape');
  assert.equal(doc.querySelector('.acct-sheet'), null);
  assert.ok(doc.querySelector('.phone-menu'), 'the Menu is still there');
  press(w, doc, 'Escape');
  assert.equal(doc.querySelector('.menu-sheet'), null);
  // a long press (or right-click) on the bar asks to choose what is on it
  doc.querySelector('.tabbar .tab').dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.deepEqual(heard.at(-1), ['nav:edit-pins', { bar: true }]);
  // the search box opens Jump to
  doc.querySelector('.tab-menu').click();
  doc.querySelector('.sheet-search').click();
  assert.equal(doc.querySelector('.menu-sheet'), null);
  assert.ok(doc.querySelector('.palette-input'));
  press(w, doc, 'Escape');
  await sleep(250);
});

test('setPins while the phone Menu sheet is open draws it again in place; an empty bar holds Menu alone, only null is the default', skip(), async () => {
  const { frame, doc } = frameFor({ me: { role: 'manager', org_type: 'municipality' }, views: muniViewsFor('manager'), menu: menus.muniMenuFor('manager') });
  frame.setPins([{ id: 'a', label: 'Requests', href: 'requests', app: 'requests' }], null);
  frame.openSheet();
  const box = doc.querySelector('.menu-sheet.phone-menu');
  assert.deepEqual(texts(box, '.sheet-pins .sheet-item'), ['Requests']);
  // a tile pinned by a long press, with the sheet still open
  frame.setPins([{ id: 'a', label: 'Requests', href: 'requests', app: 'requests' }, { id: 'b', label: 'Sewer', href: 'sewer', app: 'sewer' }], null);
  assert.equal(doc.querySelector('.menu-sheet.phone-menu'), box, 'the same sheet stays open');
  assert.deepEqual(texts(box, '.sheet-pins .sheet-item'), ['Requests', 'Sewer'], 'the new pin shows at once');
  assert.equal(box.querySelectorAll(':scope > .sheet-body').length, 1);
  frame.setBadge('requests', 4, { says: 'new' });
  assert.equal(box.querySelector('.sheet-pins .sheet-item[data-key=requests] .nav-badge').textContent, '4', 'the redrawn tiles still take counts');
  frame.setPins([], null);
  assert.equal(box.querySelector('.sheet-pins'), null, 'unpinning the last one takes Pinned away');
  box.querySelector('.sheet-close').click();
  frame.setPins([{ id: 'a', label: 'Requests', href: 'requests', app: 'requests' }], null);
  assert.equal(doc.querySelector('.menu-sheet'), null, 'a closed sheet is not opened again');
  // the bar: [] is a choice, null is the default
  frame.setPins([{ id: 'a', label: 'Requests', href: 'requests', app: 'requests' }], []);
  assert.deepEqual(texts(doc, '.tabbar .tab'), ['Menu'], 'an empty bar: Menu alone');
  frame.setPins([{ id: 'a', label: 'Requests', href: 'requests', app: 'requests' }], null);
  assert.deepEqual(texts(doc, '.tabbar .tab .tab-text'), ['Today', 'Requests', 'My shifts'], 'null: the default bar');
  const saved = frameFor({ me: { role: 'manager', org_type: 'municipality' }, views: muniViewsFor('manager'), menu: menus.muniMenuFor('manager'), navSaved: { pins: [], bar: [] } });
  assert.deepEqual(texts(saved.doc, '.tabbar .tab'), ['Menu'], 'an empty bar saved on the server is kept on the first paint too');
  await sleep(250);
});

test('for 14 days from the first load on a device: "Settings, Help and Sign out moved here.", until Got it', skip(), async () => {
  const day = 86400000;
  const first = frameFor({ me: { role: 'counter' }, views: viewsFor('counter'), menu: menus.STANDARD.counter, store: { 'so.nav.moved': null } });
  const note = first.doc.querySelector('.rail-foot .moved-here');
  assert.equal(note.querySelector('span').textContent, 'Settings, Help and Sign out moved here.');
  assert.equal(note.getAttribute('role'), 'note');
  const kept = JSON.parse(first.w.localStorage.getItem('so.nav.moved'));
  assert.ok(Math.abs(kept.first - Date.now()) < 5000 && kept.done === false, 'the first load is remembered on this device');
  note.querySelector('button').click();
  assert.equal(first.doc.querySelector('.moved-here'), null);
  assert.equal(JSON.parse(first.w.localStorage.getItem('so.nav.moved')).done, true);
  const again = frameFor({ me: { role: 'counter' }, views: viewsFor('counter'), menu: menus.STANDARD.counter, store: { 'so.nav.moved': JSON.stringify({ first: Date.now(), done: true }) } });
  assert.equal(again.doc.querySelector('.moved-here'), null, 'dismissed: gone for good');
  const day13 = frameFor({ me: { role: 'counter' }, views: viewsFor('counter'), menu: menus.STANDARD.counter, store: { 'so.nav.moved': JSON.stringify({ first: Date.now() - 13 * day, done: false }) } });
  assert.ok(day13.doc.querySelector('.moved-here'));
  const day14 = frameFor({ me: { role: 'counter' }, views: viewsFor('counter'), menu: menus.STANDARD.counter, store: { 'so.nav.moved': JSON.stringify({ first: Date.now() - 14 * day - 1000, done: false }) } });
  assert.equal(day14.doc.querySelector('.moved-here'), null, '14 days on: it ends by itself');
  assert.equal(nav.MOVED_NOTE_DAYS, 14);
  // opening the account menu puts the note away for now, without dismissing it
  day13.doc.querySelector('.acct').click();
  assert.equal(day13.doc.querySelector('.moved-here'), null);
  assert.equal(JSON.parse(day13.w.localStorage.getItem('so.nav.moved')).done, false);
  await sleep(250);
});

// ---------------------------------------------------------------- the page header and the lazy modules

test('main.js: the other modules are loaded on their own, the page tells the top bar its part, and a title that repeats the app is not drawn twice', () => {
  const main = read('public/js/main.js');
  assert.match(main, /for \(const load of \[\(\) => import\('\.\/pins\.js'\), \(\) => import\('\.\/navcounts\.js'\), \(\) => import\('\.\/newmenu\.js'\)\]\) load\(\)\.then\(\(m\) => m\.start\(built\)\)\.catch\(\(\) => \{\}\);/, 'three plain addresses, each started with the frame, a missing one ignored');
  assert.match(main, /nav: ctx\.me\.nav \|\| null/);
  assert.match(main, /function partOf\(holder, key, params\)/);
  assert.match(main, /if \(same\) h1\.classList\.add\('h1-same'\);/);
  assert.match(main, /holder\.addEventListener\('tabs:change', \(\) => \{ if \(my === navToken\) sayWhere\(holder, key, params\); \}\);/);
  const desk = /\n@media \(min-width: 861px\) \{\n {2}\.page-head h1\.h1-same \{([^}]*)\}([\s\S]*?)\n\}/.exec(css);
  assert.ok(desk, 'the rule is for a computer only: a phone keeps its page title');
  assert.match(desk[1], /position: absolute; width: 1px; height: 1px;/, 'hidden from sight, kept for screen readers (not display: none)');
  assert.ok(!/display: none/.test(desk[1]));
  assert.match(desk[2], /\.page-head \.head-lead \.crumbs, \.page-head \.head-tools \.help-btn \{ display: none; \}/, 'the top bar has the breadcrumb and Help there');
});

// ---------------------------------------------------------------- the look

test('the look: 56 px rows top and bottom, 32 px rows in one scrolling list, a 52 px top bar, 240 and 64 px wide, the phone at 860; tabs and filters as before', () => {
  const rule = (sel) => { const m = new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css); return m ? m[2] : null; };
  assert.match(css, /--rail-open: 240px; --rail-strip: 64px;/);
  assert.match(rule('.rail-org'), /height: 56px;/);
  assert.match(rule('.acct'), /height: 55px;/, 'with its 1 px rule above: 56');
  assert.match(rule('.rail-foot'), /border-top: 1px solid/);
  assert.match(rule('.nav-row'), /height: 32px;/);
  assert.match(rule('.rail .nav'), /overflow-y: auto;/, 'the one list scrolls as a whole');
  assert.equal((css.match(/overflow-y: auto/g) || []).filter(() => true).length > 0, true);
  assert.ok(!/\.nav-scroll|\.rail\.more-down|\.nav-all-head|\.rail-search|\.who-actions/.test(css), 'the old pinned top, the cut-to-whole-rows window and its shadows are gone');
  assert.match(rule('.topbar'), /position: sticky; top: 0;[^}]*height: 52px;/);
  assert.match(rule('.top-jump'), /flex: 0 1 280px;/);
  assert.match(rule('.nav-fold'), /font: inherit;/);
  assert.ok(/font-size: \.75rem; font-weight: 400;/.test(rule('.nav-head')) && /color: var\(--side-muted\)/.test(rule('.nav-fold')), 'section labels are quiet words, not headings that shout');
  assert.match(rule('.nav-badge'), /background: var\(--accent\); color: var\(--on-accent\)/, 'a count: a quiet gold pill');
  assert.match(rule('.nav-badge.alert'), /background: var\(--closed\); color: var\(--on-fill\)/, 'red when overdue or urgent');
  assert.match(css, /\.shell\.collapsed \.rail\.peek \{ width: var\(--rail-open\);/, 'the strip opens over the page');
  assert.match(css, /\.shell\.collapsed \{ --rail-w: var\(--rail-strip\); \}/, 'and the page keeps the strip\'s column');
  const phone = /\n@media \(max-width: 860px\) \{\n {2}:root \{ --stick-top: 0px; \}([\s\S]*?)\n\}/.exec(css);
  assert.ok(phone, 'the phone layout starts at 860 px, as before');
  assert.match(phone[1], /\.rail \{ display: none; \}/);
  assert.match(phone[1], /\.tabbar \{ position: fixed;/);
  assert.match(phone[1], /\.top-btn \{ width: 44px; height: 44px;/, '44 px targets on a phone');
  assert.match(phone[1], /\.top-where, \.top-star, \.top-new, \.top-sos, \.top-help \{ display: none; \}/);
  // the theme tokens: the menu's surface in both themes
  assert.match(css, /:root \{\n {2}--side: #ffffff;/);
  assert.match(css, /:root\[data-theme='dark'\] \{\n {2}--side: #0c171d;/);
  // tabs and filters, unchanged
  assert.match(css, /\.fchips button\[aria-pressed='true'\]::before \{ content: '✓'/, 'a check mark on the filter that is on');
  assert.match(css, /\.fchips button\[aria-pressed='true'\] \{ background: transparent;/, 'outlined, not filled like a tab');
  assert.ok(!/\.pbody > div > div > \.tabs/.test(css) && !/\.subtabs > \.tabs/.test(css), 'no app-specific tab rows left');
  assert.equal((css.match(/\n\.tabs\.row1 \{/g) || []).length, 1, 'row 1 is defined once');
  assert.equal((css.match(/\n\.tabs\.row2 \{/g) || []).length, 1, 'row 2 is defined once');
  assert.match(rule('.tabs.row2'), /flex-wrap: wrap/, 'row 2 wraps on a computer');
  assert.match(css, /\n {2}\.tabs\.row2 \{ gap: 6px; flex-wrap: nowrap; overflow-x: auto;/, 'and slides sideways in one line on a phone');
  assert.match(css, /\n {2}\.tabs\.row2 button \{ min-height: 44px;/, 'with 44px targets on phones');
  const uiSrc = read('public/js/ui.js');
  assert.match(uiSrc, /const row = opts\.row \|\| \(nesting > 0 \? 2 : 1\);/, 'tabs inside a tab are row 2 on their own');
  assert.match(uiSrc, /export function linkTabs\(/);
  assert.match(read('public/js/views/sell.js'), /look: 'pills'/, 'Sell keeps its pills');
});
