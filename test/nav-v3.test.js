'use strict';

// Navigation v3 (2026.11.13), after signing in as every role: menus and Today's buttons follow the person's position
// (Park crew gets the terrain park, not the lifts), the patrol director has a menu apart from the patrollers', the phone
// bar starts with the screen the menu opens on, the ski area login's menu is the patrol summary, Jump to finds the tabs
// inside apps, Settings and Help go back to the page that opened them, and the phone page header is compact.
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

let server; let base; let nav; let jump; let tmp; let tenantId;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const slug = `nav3-${suffix}`;
const PW = 'correct-horse-battery';
const T = {};
const S = {};
const P = {};

async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const login = async (email) => ok(await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).token;

/** A login linked to a new staff member, with these positions. */
async function person(key, role, positions = []) {
  const s = ok(await api('POST', '/workforce/staff', { token: T.owner, body: { person: { first_name: key, last_name: 'Tester' }, status: 'active' } }));
  S[key] = s.id;
  if (positions.length) ok(await api('PUT', `/workforce/staff/${s.id}/positions`, { token: T.owner, body: { position_ids: positions.map((p) => P[p]) } }));
  ok(await api('POST', '/users', { token: T.owner, body: { email: `${key}@${slug}.test`, password: PW, role, staff_id: s.id } }));
  T[key] = await login(`${key}@${slug}.test`);
}

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-nav3-'));
  fs.cpSync(path.join(ROOT, 'public', 'js'), path.join(tmp, 'js'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  nav = await import(pathToFileURL(path.join(tmp, 'js', 'nav.js')).href);
  jump = await import(pathToFileURL(path.join(tmp, 'js', 'jumpindex.js')).href);
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Nav Three Mountain', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  T.owner = await login(`owner@${slug}.test`);
  tenantId = (await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]))[0][0].id;
  for (const [key, name, department] of [['lift', 'Lift operator', 'lifts'], ['park', 'Park crew', 'lifts'], ['groom', 'Groomer', 'grooming'], ['rent', 'Rental technician', 'rentals'], ['window', 'Ticket window', 'guest_services']]) {
    P[key] = ok(await api('POST', '/workforce/positions', { token: T.owner, body: { name, department } })).id;
  }
  await person('liftop', 'staff', ['lift']);
  await person('parkcrew', 'staff', ['park']);
  await person('both', 'staff', ['park', 'groom']);
  await person('plain', 'staff', []);
  await person('renter', 'counter', ['rent']);
  await person('windowp', 'counter', ['window']);
  await person('patdir', 'patrol');
  await person('patroller', 'patrol');
  await pool.query("INSERT INTO patrol_members (tenant_id, staff_id, level, access_level) VALUES (?, ?, 'director', 'admin'), (?, ?, 'patroller', 'patrol')", [tenantId, S.patdir, tenantId, S.patroller]);
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a position stands for a kind of work, from its name and department', () => {
  const kind = (name, department) => menus.positionKind({ name, department });
  assert.equal(kind('Park crew', 'lifts'), 'park', 'the name wins over the department');
  assert.equal(kind('Terrain park supervisor', 'maintenance'), 'park');
  assert.equal(kind('Lift operator', 'lifts'), 'lifts');
  assert.equal(kind('Groomer', 'grooming'), 'grooming');
  assert.equal(kind('Snowcat operator', 'maintenance'), 'grooming');
  assert.equal(kind('Rental technician', 'rentals'), 'rentals');
  assert.equal(kind('Cafe cook', 'food'), 'food');
  assert.equal(kind('Mechanic', 'maintenance'), 'maintenance');
  assert.equal(kind('Ticket window', 'guest_services'), null, 'no standard menu: the role\'s');
  assert.deepEqual(menus.KIND_MENUS.park, { apps: ['park', 'conditions', 'lostfound'], start: 'dashboard' });
  assert.deepEqual(menus.KIND_MENUS.lifts, menus.STANDARD.staff, 'a lift operator keeps the lift and mountain staff menu');
});

test('menus follow the position: park crew get the terrain park, lift operators the lifts, both positions both', async () => {
  const me = async (k) => ok(await api('GET', '/auth/me', { token: T[k] }));
  const park = await me('parkcrew');
  assert.deepEqual(park.menu, { apps: ['park', 'conditions', 'lostfound'], start: 'dashboard' });
  assert.deepEqual(park.work, ['park']);
  assert.deepEqual(park.positions, ['Park crew']);
  assert.equal(park.menu_row, `pos:${P.park}`);
  const lift = await me('liftop');
  assert.deepEqual(lift.menu, menus.STANDARD.staff);
  assert.deepEqual(lift.work, ['lifts']);
  const both = await me('both');
  assert.deepEqual(both.work, ['grooming', 'park'], 'Groomer before Park crew, in name order');
  assert.deepEqual(both.menu.apps, ['conditions', 'assets', 'park', 'lostfound'], 'both menus, nothing twice');
  const plain = await me('plain');
  assert.deepEqual(plain.menu, menus.STANDARD.staff, 'no position: the role menu');
  assert.deepEqual(plain.work, []);
  assert.equal(plain.menu_row, 'staff');
  const renter = await me('renter');
  assert.deepEqual(renter.menu, { apps: ['rentals', 'sell', 'waivers', 'people', 'lostfound'], start: 'rentals' }, 'a rental technician at the counter opens on Rentals');
  const win = await me('windowp');
  assert.deepEqual(win.menu, menus.STANDARD.counter, 'a position with no standard menu: the role menu');
  // Only what the role may open: a staff login in a rental position gets no Rentals (staff cannot open it).
  assert.deepEqual(menus.menuFor('staff', null, null, { positions: [{ id: 9, name: 'Rental technician', department: 'rentals' }] }), { apps: ['lostfound'], start: 'dashboard' });
  assert.deepEqual(menus.menuFor('manager', null, null, { positions: [{ id: 9, name: 'Park crew', department: 'lifts' }] }), menus.STANDARD.manager, 'positions never change an owner or manager menu');
});

test('the owner gives a position its own menu, checked and audited; managers may only look', async () => {
  const state = ok(await api('GET', '/settings/menus', { token: T.owner }));
  const row = state.positions.find((p) => p.key === `pos:${P.park}`);
  assert.deepEqual([row.name, row.kind, row.own, row.standard], ['Park crew', 'park', true, true]);
  assert.deepEqual(row.apps, ['park', 'conditions', 'lostfound']);
  const win = state.positions.find((p) => p.key === `pos:${P.window}`);
  assert.equal(win.own, false, 'Ticket window has no menu of its own');
  assert.equal(state.standard[`pos:${P.window}`], null);
  assert.ok(row.can_open.includes('park') && row.can_open.includes('sell'), 'a position menu may hold what staff or the counter may open');
  const body = { role: `pos:${P.park}`, menu: { apps: ['park', 'gate'], start: 'park' } };
  assert.equal((await api('PUT', '/settings/menus', { token: T.parkcrew, body })).status, 403);
  assert.equal((await api('PUT', '/settings/menus', { token: T.owner, body: { role: 'pos:999999', menu: body.menu } })).status, 400, 'not a position here');
  assert.equal((await api('PUT', '/settings/menus', { token: T.owner, body: { role: 'pos:abc', menu: body.menu } })).status, 400);
  assert.equal((await api('PUT', '/settings/menus', { token: T.owner, body: { role: body.role, menu: { apps: ['park', 'money'], start: 'park' } } })).status, 400, 'Money is not for these roles');
  const out = ok(await api('PUT', '/settings/menus', { token: T.owner, body }));
  assert.deepEqual(out.menu, body.menu);
  assert.deepEqual(ok(await api('GET', '/auth/me', { token: T.parkcrew })).menu, body.menu);
  const [[a]] = await pool.query("SELECT detail FROM audit_log WHERE tenant_id = ? AND action = 'update_role_menu' ORDER BY id DESC LIMIT 1", [tenantId]);
  const d = typeof a.detail === 'string' ? JSON.parse(a.detail) : a.detail;
  assert.equal(d.role, `pos:${P.park}`); assert.equal(d.position, 'Park crew');
  // A position with no standard menu gets one; null puts it back to the role's.
  ok(await api('PUT', '/settings/menus', { token: T.owner, body: { role: `pos:${P.window}`, menu: { apps: ['sell', 'gate'], start: 'sell' } } }));
  assert.deepEqual(ok(await api('GET', '/auth/me', { token: T.windowp })).menu, { apps: ['sell', 'gate'], start: 'sell' });
  const back = ok(await api('PUT', '/settings/menus', { token: T.owner, body: { role: `pos:${P.window}`, menu: null } }));
  assert.equal(back.menu, null, 'no standard menu: the role\'s is used');
  assert.deepEqual(ok(await api('GET', '/auth/me', { token: T.windowp })).menu, menus.STANDARD.counter);
  ok(await api('PUT', '/settings/menus', { token: T.owner, body: { role: `pos:${P.park}`, menu: null } }));
  assert.deepEqual(ok(await api('GET', '/auth/me', { token: T.parkcrew })).menu.apps, ['park', 'conditions', 'lostfound']);
  assert.equal(ok(await api('GET', '/settings/menus', { token: T.owner })).positions.length, 5);
});

test('the patrol director has a menu apart from the patrollers\', with records requests and the access log', async () => {
  const dir = ok(await api('GET', '/auth/me', { token: T.patdir }));
  assert.equal(dir.patrol_lead, true);
  assert.deepEqual(dir.menu, { apps: ['patrol', 'patrol-records', 'patrol-access', 'conditions'], start: 'patrol' });
  assert.equal(dir.menu_row, 'patrol_director');
  assert.deepEqual(dir.menu_links['patrol-records'], { label: 'Records requests', href: 'patrol/cases?tab=records', app: 'patrol', icon: 'documents' });
  assert.equal(dir.menu_links['patrol-access'].href, 'patrol/cases?tab=access');
  const pat = ok(await api('GET', '/auth/me', { token: T.patroller }));
  assert.equal(pat.patrol_lead, false);
  assert.deepEqual(pat.menu, menus.STANDARD.patrol);
  assert.deepEqual(pat.menu_links, {});
  const state = ok(await api('GET', '/settings/menus', { token: T.owner }));
  assert.deepEqual(state.roles.patrol_director.apps, ['patrol', 'patrol-records', 'patrol-access', 'conditions']);
  assert.ok(state.roles.patrol_director.can_open.includes('patrol-review'));
  assert.ok(!state.roles.patrol.can_open.includes('patrol-records'), 'patrollers cannot hold the records shortcut');
  assert.equal(state.apps['patrol-access'], 'Access log');
  assert.equal((await api('PUT', '/settings/menus', { token: T.owner, body: { role: 'patrol', menu: { apps: ['patrol', 'patrol-records'], start: 'patrol' } } })).status, 400);
  assert.equal((await api('PUT', '/settings/menus', { token: T.owner, body: { role: 'patrol_director', menu: { apps: ['patrol', 'patrol-records'], start: 'patrol-records' } } })).status, 400, 'a shortcut is not a screen to open on');
  ok(await api('PUT', '/settings/menus', { token: T.owner, body: { role: 'patrol_director', menu: { apps: ['patrol', 'patrol-review', 'patrol-records'], start: 'patrol' } } }));
  assert.deepEqual(ok(await api('GET', '/auth/me', { token: T.patdir })).menu.apps, ['patrol', 'patrol-review', 'patrol-records']);
  assert.deepEqual(ok(await api('GET', '/auth/me', { token: T.patroller })).menu, menus.STANDARD.patrol, 'patrollers keep theirs');
  ok(await api('PUT', '/settings/menus', { token: T.owner, body: { role: 'patrol_director', menu: null } }));
});

test('the phone bar starts with the screen the menu opens on; shortcuts show for whoever may open their app; the ski area menu', () => {
  const v = (keys) => keys.map((k) => [k, k]);
  const staff = nav.menuPlan(v(['dashboard', 'inbox', 'calendar', 'myshifts', 'conditions', 'park', 'gate', 'lostfound', 'documents', 'settings', 'help']), { apps: ['park', 'conditions', 'lostfound'], start: 'dashboard' });
  assert.deepEqual(staff.bar.map((p) => p.href), ['dashboard', 'park', 'conditions', 'lostfound'], 'park crew: Today, then the park');
  const counter = nav.menuPlan(v(['dashboard', 'sell', 'gate', 'rentals', 'people', 'settings', 'help']), menus.STANDARD.counter);
  assert.equal(counter.bar[0].href, 'sell');
  const instr = nav.menuPlan(v(['dashboard', 'school', 'availability', 'people', 'waivers', 'settings', 'help']), menus.STANDARD.instructor);
  assert.equal(instr.bar[0].href, 'school');
  const links = { 'patrol-records': { label: 'Records requests', href: 'patrol/cases?tab=records', app: 'patrol' } };
  const dir = nav.menuPlan(v(['dashboard', 'patrol', 'conditions', 'settings', 'help']), { apps: ['patrol', 'patrol-records', 'conditions'], start: 'patrol' }, links);
  assert.deepEqual(dir.apps, ['patrol', 'patrol-records', 'conditions']);
  assert.equal(dir.bar[0].href, 'patrol');
  assert.deepEqual(dir.bar[1], { label: 'Records requests', href: 'patrol/cases?tab=records', app: 'patrol' }, 'a shortcut is on the bar as a pin to its page');
  const noPatrol = nav.menuPlan(v(['dashboard', 'conditions', 'settings', 'help']), { apps: ['patrol', 'patrol-records', 'conditions'], start: 'patrol' }, links);
  assert.deepEqual(noPatrol.apps, ['conditions'], 'no Patrol (turned off): no shortcut into it');
  const area = nav.menuPlan(v(['area', 'settings', 'help']), nav.AREA_MENU);
  assert.deepEqual([area.apps, area.sections.map((s) => s.keys), area.bar.map((p) => p.href), area.account], [['area'], [['area']], ['area'], ['settings', 'help']], 'the patrol summary alone');
  const main = read('public/js/main.js');
  assert.match(main, /const menu = ctx\.me\.role === 'area' \? AREA_MENU : ctx\.me\.menu \|\| null;/);
  assert.match(main, /links: ctx\.me\.menu_links \|\| \{\}/);
  // the bar's first item is lit when you are there: the same aria-current as the side menu
  assert.match(read('public/js/nav.js'), /for \(const s of shown\) \{ if \(on\(s\)\) s\.el\.setAttribute\('aria-current', 'page'\); else s\.el\.removeAttribute\('aria-current'\); \}/);
});

test('one name for each role: the person card and the menu editor agree', () => {
  assert.equal(nav.roleName({ role: 'staff' }), 'Lift and mountain staff');
  assert.equal(nav.roleName({ role: 'counter' }), 'Ticket window and rentals');
  assert.equal(nav.roleName({ role: 'patrol', patrol_lead: true }), 'Patrol director');
  assert.equal(nav.roleName({ role: 'patrol' }), 'Patroller');
  assert.equal(nav.roleName({ role: 'area' }), 'Ski area (read-only)');
  const editor = read('public/js/views/settings-menus.js');
  assert.match(editor, /import \{ ROLE_NAMES \} from '\.\.\/nav\.js';/);
  assert.match(editor, /const ROLE_ROWS = \['counter', 'instructor', 'staff', 'patrol_director', 'patrol', 'manager', 'owner'\];/);
  assert.match(read('public/js/nav.js'), /const roleText = roleName\(me\);/);
});

test('Jump to finds the tabs inside apps, with the app, and only what the person may open', () => {
  const titles = (views, who) => jump.subPagesFor(views, who).map((p) => `${p.title} @${p.app}`);
  const lead = { manager: false, role: 'patrol', patrol: { features: ['records', 'view_access_log', 'view_cases', 'reports'] } };
  const dir = titles(['dashboard', 'patrol', 'conditions', 'park'], lead);
  for (const t of ['Opening checks @patrol', 'Lift evacuation @patrol', 'Today\'s posts @patrol', 'Records requests @patrol', 'Access log @patrol', 'Lift inspections @conditions', 'Daily map @park']) assert.ok(dir.includes(t), t);
  const line = titles(['dashboard', 'patrol', 'conditions', 'park'], { manager: false, role: 'patrol', patrol: { features: ['view_cases'] } });
  assert.ok(!line.includes('Records requests @patrol') && !line.includes('Access log @patrol'), 'a line patroller does not get them');
  assert.ok(line.includes('Opening checks @patrol'));
  const staff = titles(['dashboard', 'conditions', 'park', 'gate'], { manager: false, role: 'staff', patrol: null });
  assert.ok(!staff.some((t) => t.endsWith('@patrol')), 'no Patrol for lift staff');
  assert.ok(staff.includes('Lift inspections @conditions'));
  const instr = titles(['school', 'availability'], { manager: false, role: 'instructor', school: 'instructor' });
  assert.ok(instr.includes('My day @school') && !instr.includes('Instructor availability @school') && !instr.includes('Payroll @school'));
  const owner = titles(['patrol', 'money', 'school'], { manager: true, role: 'owner' });
  assert.ok(owner.includes('Access log @patrol') && owner.includes('Sales tax @money') && owner.includes('Instructor availability @school'));
  const navSrc = read('public/js/nav.js');
  assert.match(navSrc, /h\('span', \{ class: 'p-app' \}, ` in \$\{r\.app\}`\)/, 'the app name is shown');
  assert.match(navSrc, /loadPatrol\(\)/, 'Patrol access is loaded to know which Patrol pages to offer');
  for (const [, , href] of jump.SUB_PAGES) assert.match(href, /^#\/[a-z]+(\/[a-z]+)?\?(tab|go)=/, href);
});

test('Today\'s buttons follow the position: park crew get the park, not the lifts', async () => {
  const dash = read('public/js/views/dashboard.js');
  assert.match(dash, /park: \[\n\s+\{ app: 'park', act: 'park-map', label: 'Daily map'[^\n]*\n\s+\{ app: 'park', act: 'park-area', label: 'Open an area'[^\n]*\n\s+\{ app: 'park', act: 'park-inspect', label: 'Inspections'/);
  assert.match(dash, /const work = \['staff', 'counter'\]\.includes\(me\.role\) && Array\.isArray\(me\.work\)/);
  assert.match(dash, /park: \(\) => true/, 'everyone may open the terrain park');
  assert.match(dash, /wallBtn\.classList\.add\('wall-btn'\)/);
  assert.match(read('public/js/views/park.js'), /get\('go'\) === 'inspect'/);
});

test('Settings and Help go back to the page that opened them; Help from Patrol, Gear is Gear help', () => {
  const main = read('public/js/main.js');
  assert.match(main, /function noteWork\(/);
  assert.match(main, /if \(!key \|\| key === 'settings' \|\| key === 'help'\) return;/);
  assert.match(main, /\{ \/\/ a tab change: remember the tab, and say it in the top bar\n {4}noteWork\(\);/, 'a tab change is remembered too');
  assert.match(main, /if \(key === 'patrol'\) return `#\/help\/for-patrol\?part=\$\{patrolSection\(params\)\}`;/);
  const settings = read('public/js/views/settings.js');
  assert.match(settings, /const was = backTo\(\);/);
  assert.match(settings, /href: was \? was\.hash :/);
  const help = read('public/js/views/help.js');
  assert.match(help, /gear: \['Gear', [^\n]*'patrol-kits', 'patrol-meds', 'patrol-1111-meds', 'patrol-lifts', 'patrol-map-places', 'patrol-map-turn', 'patrol-help-signs'\]\]/);
  assert.match(help, /return was && was\.key === key \? back\(was\.hash, `Back to \$\{was\.name\}`\) : null;/);
  const ui = read('public/js/ui.js');
  assert.match(ui, /export function noteBack\(back\)/);
  assert.match(ui, /export function backTo\(\)/);
});

test('the phone page header: icon buttons with names in the title row, header New case and Wall screen hidden, row 2 slides', () => {
  const css = read('public/css/app.css');
  const phone = /\/\* Phone page header \(2026\.11\.13\)[\s\S]*?\n@media \(max-width: 860px\) \{([\s\S]*?)\n\}/.exec(css)[1];
  assert.match(phone, /\.page-head > \.head-tools \{ grid-column: 2; grid-row: 1;/);
  assert.match(phone, /\.head-tools \.head-btn-text \{ position: absolute; width: 1px;/, 'words hidden, kept for screen readers');
  assert.match(phone, /\.patrol-head \.patrol-new, \.page-head \.wall-btn \{ display: none; \}/);
  const main = read('public/js/main.js');
  assert.match(main, /'aria-label': setName, title: setName/, 'the settings button keeps its name');
  assert.match(main, /'aria-label': `Help with \$\{appName\(key\)\}`/);
  assert.match(read('public/js/views/patrol.js'), /class: 'btn small head-settings', href: '#\/settings\/patrol', 'data-act': 'patrol-settings' \}, icon\('settings', 16\), h\('span', \{ class: 'head-btn-text' \}, 'Patrol settings'\)\)/);
  assert.match(read('public/js/ui.js'), /function showTab\(bar, b\)/, 'the open tab of a sliding row is brought into view');
  assert.match(read('public/js/ui.js'), /previous\.focus\(previous\.id === 'main' \? \{ preventScroll: true \} : undefined\)/, 'closing a dialog does not scroll the title under the top bar');
});

test('names: Lessons everywhere, My availability once, no Messages / Messages, the kiosk setup path, the always-on tip', () => {
  assert.match(read('public/js/views/settings.js'), /\['school', 'apps', 'Lessons', /);
  assert.match(read('public/js/main.js'), /const SETTINGS_NAME = \{ availability: 'Lessons' \};/);
  assert.equal(menus.APPS.availability, 'My availability');
  assert.match(read('public/js/views/messages.js'), /tabs\(\[\['sent', 'Sent', list\]/);
  const kiosk = read('public/js/kiosk.js');
  assert.ok(!/then Kiosk/.test(kiosk));
  assert.match(kiosk, /Settings, Staff and schedule, then Add a tablet under Time clock kiosk/);
  const help = read('public/js/help-content.js');
  assert.ok(!/Kiosk, Settings/.test(help));
  assert.ok(!/Today, Customers, My shifts, Settings and Help are always on/.test(help));
  assert.match(help, /A mountain cannot turn off Today, Inbox, Calendar, My shifts, Customers, Waivers, Lost and found, Settings or Help\./);
  assert.match(help, /see it under Shift offers in Lessons\./);
  assert.ok(!/Settings, Ski school/.test(help));
  assert.ok(!/Kiosk, Settings/.test(read('src/lib/kiosk.js')));
});
