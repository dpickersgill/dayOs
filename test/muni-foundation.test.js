'use strict';

// The municipal edition's foundation (muni release 1): a tenant is a ski area (mountain) or a municipality, chosen by the
// platform operator when it is made and never changed. Each app is for one kind or both: a municipality never reaches a
// ski app's API or public pages, a mountain never reaches a municipal one. Work orders and service plans open with Assets
// and fleet alone (no Lifts and trails). A municipality has four roles. Plans are sold to one kind of tenant only.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.PUBLIC_RATE_LIMIT = '100000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const M = require('../src/lib/modules');
const { createMuniTenant } = require('./helpers/muni');

const KEY = 'test-bootstrap-key';
const PW = 'correct-horse-battery';
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
let server; let base;
let muni; let ski; let skiToken;

async function api(method, p, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);
const platform = (method, p, body) => api(method, `/platform${p}`, { headers: { 'x-platform-key': KEY }, body });

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  muni = await createMuniTenant(base, { slug: `mf-boro-${suffix}`, name: `Millbrook Borough ${suffix}` });
  // A ski area made the same way, without saying which kind: it is a mountain, as every tenant was before.
  const made = await platform('POST', '/tenants', { slug: `mf-ski-${suffix}`, name: `Pine Ridge ${suffix}`, billing: 'comped', owner: { email: `gm@mf-ski-${suffix}.test`, password: PW, first_name: 'Gale', last_name: 'Ridge' } });
  is(made, 201);
  ski = { id: made.body.id, slug: `mf-ski-${suffix}` };
  skiToken = (await api('POST', '/auth/login', { body: { tenant: ski.slug, login: `gm@${ski.slug}.test`, password: PW } })).body.token;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

// ---------------------------------------------------------------- 1. organization type
test('the platform operator picks the kind when creating a tenant; it shows in the console and cannot change', async () => {
  const [[m]] = await pool.query('SELECT org_type FROM tenants WHERE id = ?', [muni.id]);
  assert.equal(m.org_type, 'municipality');
  const [[s]] = await pool.query('SELECT org_type FROM tenants WHERE id = ?', [ski.id]);
  assert.equal(s.org_type, 'mountain', 'a tenant made without a kind is a ski area');

  const list = await platform('GET', '/tenants');
  is(list, 200);
  assert.equal(list.body.data.find((t) => t.id === muni.id).org_type, 'municipality');
  assert.equal(list.body.data.find((t) => t.id === ski.id).org_type, 'mountain');

  const change = await platform('PATCH', `/tenants/${muni.id}`, { org_type: 'mountain' });
  is(change, 400, 'the kind is never changed');
  assert.match(change.body.error, /cannot be changed/);
  const again = await platform('PATCH', `/tenants/${ski.id}`, { org_type: 'municipality', name: 'Renamed' });
  is(again, 400, 'not even alongside another change');
  const [[still]] = await pool.query('SELECT org_type, name FROM tenants WHERE id = ?', [ski.id]);
  assert.equal(still.org_type, 'mountain');
  assert.notEqual(still.name, 'Renamed');

  is(await platform('POST', '/tenants', { slug: `mf-bad-${suffix}`, name: 'Bad kind', org_type: 'county', owner: { email: `x@mf-bad-${suffix}.test`, password: PW, first_name: 'A', last_name: 'B' } }), 400, 'only the two kinds');
});

test('/auth/me says the kind, and a municipality starts with its core apps on and its add-ons off', async () => {
  const me = (await api('GET', '/auth/me', { token: muni.token })).body;
  assert.equal(me.org_type, 'municipality');
  assert.deepEqual([...me.modules].sort(), ['assets', 'documents', 'messages', 'requests', 'workforce']);
  assert.deepEqual(me.menu, { apps: ['requests', 'works', 'assets', 'workforce'], start: 'dashboard' });
  const skiMe = (await api('GET', '/auth/me', { token: skiToken })).body;
  assert.equal(skiMe.org_type, 'mountain');
  for (const k of ['requests', 'water', 'sewer', 'stormwater', 'solidwaste', 'buildings']) assert.ok(!skiMe.modules.includes(k), `${k} never on for a mountain`);
});

// ---------------------------------------------------------------- 2. apps by kind
test('settle and apply follow the kind: ski apps are never on for a municipality, municipal apps never for a mountain', () => {
  assert.deepEqual(M.settle({}, 'municipality'), ['documents', 'messages', 'workforce', 'requests', 'assets'].sort((a, b) => M.KEYS.indexOf(a) - M.KEYS.indexOf(b)));
  assert.ok(!M.settle({ patrol: true, sell: true, conditions: true }, 'municipality').some((k) => ['patrol', 'sell', 'conditions'].includes(k)));
  assert.ok(!M.settle({ water: true, requests: true }).includes('water'), 'a mountain (the default) never has Water');
  assert.ok(!M.settle({}).includes('assets'), 'Assets and fleet is still an add-on for a mountain');
  assert.ok(M.settle({}, 'municipality').includes('assets'), 'and part of the core for a municipality');
  assert.ok(M.apply({}, { water: true }, 'municipality').includes('water'));
  assert.ok(!M.apply({}, { conditions: false }, 'mountain').includes('assets'), 'a mountain without the add-on');
  assert.ok(M.apply({}, { assets: true, conditions: false }, 'mountain').includes('assets'), 'Assets and fleet no longer needs Lifts and trails');
  for (const m of M.MODULES) assert.ok(Array.isArray(m.orgs) && m.orgs.length, `${m.key} says which kinds it is for`);
  for (const k of ['requests', 'water', 'sewer', 'stormwater', 'solidwaste', 'buildings']) assert.deepEqual(M.MODULES.find((m) => m.key === k).orgs, ['municipality']);
  assert.equal(M.moduleFor('/requests/streets'), 'requests');
  assert.equal(M.moduleFor('/street-notices'), 'requests');
  assert.equal(M.moduleFor('/solid-waste/today'), 'solidwaste');
  assert.equal(M.PUBLIC.streets, 'requests');
  assert.equal(M.PUBLIC['bulk-pickup'], 'solidwaste');
});

test('a municipality gets 403 module_disabled on every ski path, and a mountain on every municipal one', async () => {
  for (const p of ['/schedule/lifts', '/schedule/trails', '/ops/groom/plan', '/ops/snow', '/ops/weather', '/ops/assets', '/ops/meta', '/ops/lift-checks', '/ops/downtime', '/ops/handoffs', '/ops/report', '/skischool/sessions', '/patrol/incidents', '/rentals', '/park/features', '/products', '/orders', '/online-shop/orders']) {
    const r = await api('GET', p, { token: muni.token });
    is(r, 403, p);
    assert.equal(r.body.details && r.body.details.code, 'module_disabled', p);
  }
  const lift = await api('POST', '/schedule/lifts', { token: muni.token, body: { name: 'Nope' } });
  is(lift, 403, 'no lift can be added');
  const groom = await api('POST', '/ops/groom/plan', { token: muni.token, body: {} });
  is(groom, 403, 'no grooming');
  const word = await api('GET', '/schedule/lifts', { token: muni.token });
  assert.match(word.body.error, /for your municipality/, 'the refusal names a municipality');

  for (const p of ['/requests/streets', '/street-notices', '/water/today', '/sewer/today', '/stormwater/today', '/solid-waste/today', '/buildings/today']) {
    const r = await api('GET', p, { token: skiToken });
    is(r, 403, p);
    assert.equal(r.body.details && r.body.details.code, 'module_disabled', p);
  }
  // A municipality with the add-on off is refused the same way.
  const water = await api('GET', '/water/today', { token: muni.token });
  is(water, 403);
});

test('public pages: a municipality has none of a ski area\'s, and a mountain none of a municipality\'s', async () => {
  for (const w of ['conditions', 'booking', 'shop', 'help', 'programs', 'waiver', 'lost', 'instructor-availability']) {
    is(await api('GET', `/public/${muni.slug}/${w}`), 404, w);
  }
  for (const w of ['report', 'open-requests', 'alerts', 'streets', 'bulk-pickup']) {
    is(await api('GET', `/public/${ski.slug}/${w}`), 404, w);
  }
  // The mountain's own pages still answer as before.
  const waiver = await api('GET', `/public/${ski.slug}/waiver`);
  assert.notEqual(waiver.status, 404, 'a ski area keeps its waiver page');
});

test('work orders and service plans: a municipality creates, lists and completes them with Assets and fleet, without Lifts and trails', async () => {
  const crew = await muni.addLogin('staff');
  const wo = await api('POST', '/ops/work-orders', { token: crew.token, body: { title: 'Patch pothole on Mill Street', priority: 'high', location: 'Mill Street at 3rd Avenue', due_date: '2020-01-02' } });
  is(wo, 201);
  const list = await api('GET', '/ops/work-orders', { token: muni.token });
  is(list, 200);
  assert.ok(list.body.data.some((w) => w.id === wo.body.id));
  is(await api('GET', `/ops/work-orders/${wo.body.id}`, { token: crew.token }), 200);
  is(await api('POST', `/ops/work-orders/${wo.body.id}/notes`, { token: crew.token, body: { body: 'Cold patch for now' } }), 201);

  let today = await api('GET', '/ops/work-orders/today', { token: muni.token });
  is(today, 200);
  const card = (t) => today.body.cards.find((c) => c.title === t);
  assert.equal(card('Open work orders').count, 1);
  assert.equal(card('Overdue work orders').count, 1, 'past its due date');
  for (const c of today.body.cards) assert.ok(c.href.startsWith('#/works'), 'each card opens Work orders');

  is(await api('POST', `/ops/work-orders/${wo.body.id}/status`, { token: crew.token, body: { status: 'done', resolution: 'Filled and rolled', labor_hours: 1.5 } }), 200);
  today = await api('GET', '/ops/work-orders/today', { token: muni.token });
  assert.equal(today.body.cards.find((c) => c.title === 'Done today').count, 1);
  assert.equal(today.body.cards.find((c) => c.title === 'Open work orders').count, 0);

  const pm = await api('POST', '/ops/pm', { token: muni.token, body: { name: 'Inspect plow blades', interval_days: 30 } });
  is(pm, 201);
  is(await api('GET', '/ops/pm', { token: crew.token }), 200);
  is(await api('POST', `/ops/pm/${pm.body.id}/work-order`, { token: crew.token }), 201);
  is(await api('POST', `/ops/pm/${pm.body.id}/done`, { token: crew.token, body: {} }), 200);
  const log = await api('GET', `/ops/pm/${pm.body.id}/log`, { token: muni.token });
  is(log, 200);
  assert.equal(log.body.data.length, 1);

  // Without Assets and fleet, a municipality has no work orders either.
  is(await platform('PUT', `/tenants/${muni.id}/modules`, { modules: { assets: false } }), 200);
  M.invalidate(muni.id);
  is(await api('GET', '/ops/work-orders', { token: muni.token }), 403);
  is(await api('POST', '/ops/work-orders', { token: muni.token, body: { title: 'x' } }), 403);
  is(await platform('PUT', `/tenants/${muni.id}/modules`, { modules: { assets: true } }), 200);
  M.invalidate(muni.id);
  is(await api('GET', '/ops/work-orders', { token: muni.token }), 200);
});

test('a mountain without Assets and fleet keeps its work orders under Lifts and trails, and loses them with Lifts and trails off', async () => {
  is(await api('GET', '/ops/work-orders', { token: skiToken }), 200);
  is(await api('GET', '/ops/assets', { token: skiToken }), 200, 'the fleet under Lifts and trails, as before');
  is(await platform('PUT', `/tenants/${ski.id}/modules`, { modules: { conditions: false } }), 200);
  M.invalidate(ski.id);
  is(await api('GET', '/ops/work-orders', { token: skiToken }), 403);
  is(await api('GET', '/ops/pm', { token: skiToken }), 403);
  // With the add-on on (and Lifts and trails still off), work orders and service plans open, and nothing else under /ops.
  is(await platform('PUT', `/tenants/${ski.id}/modules`, { modules: { assets: true } }), 200);
  M.invalidate(ski.id);
  is(await api('GET', '/ops/work-orders', { token: skiToken }), 200);
  is(await api('GET', '/ops/pm', { token: skiToken }), 200);
  is(await api('GET', '/ops/snow', { token: skiToken }), 403);
  is(await api('GET', '/schedule/lifts', { token: skiToken }), 200, 'the lift list is still read by apps that use it (Patrol)');
  is(await platform('PUT', `/tenants/${ski.id}/modules`, { modules: { conditions: true, assets: false } }), 200);
  M.invalidate(ski.id);
});

test('the console offers each kind only its own apps, and refuses the others', async () => {
  const all = await platform('GET', '/modules?org_type=municipality');
  is(all, 200);
  const keys = all.body.data.map((m) => m.key);
  for (const k of ['assets', 'workforce', 'documents', 'messages', 'requests', 'water', 'sewer', 'stormwater', 'solidwaste', 'buildings', 'doc_ocr', 'assistant_plus']) assert.ok(keys.includes(k), k);
  for (const k of ['sell', 'conditions', 'patrol', 'school', 'park', 'rentals', 'gate', 'shop', 'money']) assert.ok(!keys.includes(k), k);
  assert.equal(all.body.data.find((m) => m.key === 'assets').addon, false, 'Assets and fleet is part of a municipality\'s core');
  const skiKeys = (await platform('GET', '/modules?org_type=mountain')).body.data.map((m) => m.key);
  for (const k of ['requests', 'water', 'buildings']) assert.ok(!skiKeys.includes(k), k);
  assert.equal((await platform('GET', '/modules?org_type=mountain')).body.data.find((m) => m.key === 'assets').addon, true);

  const patrol = await platform('PUT', `/tenants/${muni.id}/modules`, { modules: { patrol: true } });
  is(patrol, 400);
  assert.match(patrol.body.error, /not offered to a municipality/);
  const water = await platform('PUT', `/tenants/${ski.id}/modules`, { modules: { water: true } });
  is(water, 400);
  assert.match(water.body.error, /not offered to a ski area/);

  const on = await platform('PUT', `/tenants/${muni.id}/modules`, { modules: { water: true, solidwaste: true } });
  is(on, 200);
  assert.ok(on.body.modules.includes('water') && on.body.modules.includes('solidwaste'));
  M.invalidate(muni.id);
  const me = (await api('GET', '/auth/me', { token: muni.token })).body;
  assert.ok(me.modules.includes('water'));
  is(await platform('PUT', `/tenants/${muni.id}/modules`, { modules: { water: false, solidwaste: false } }), 200);
  M.invalidate(muni.id);

  // Creating a municipality with a ski app ticked is refused, not quietly dropped.
  const bad = await platform('POST', '/tenants', { slug: `mf-x-${suffix}`, name: 'Wrong apps', org_type: 'municipality', modules: { sell: true }, owner: { email: `x@mf-x-${suffix}.test`, password: PW, first_name: 'A', last_name: 'B' } });
  is(bad, 400);
});

// ---------------------------------------------------------------- 3. roles
test('a municipality has owner, manager, Crew (staff) and Front desk (counter); the API refuses the ski roles there', async () => {
  for (const role of ['patrol', 'instructor', 'area']) {
    const r = await api('POST', '/users', { token: muni.token, body: { username: `x-${role}-${suffix}`.slice(0, 40), password: PW, role, email: `${role}@${muni.slug}.test` } });
    is(r, 400, role);
    assert.equal(r.body.details.code, 'role_not_offered');
    assert.match(r.body.error, /Manager, Crew or Front desk/);
  }
  const desk = await muni.addLogin('counter');
  const crew = await muni.addLogin('staff');
  const toPatrol = await api('PATCH', `/users/${crew.id}`, { token: muni.token, body: { role: 'patrol' } });
  is(toPatrol, 400, 'and changing a login to one');
  const deskMe = (await api('GET', '/auth/me', { token: desk.token })).body;
  assert.deepEqual(deskMe.menu.apps, ['requests', 'bulk', 'notices']);
  const crewMe = (await api('GET', '/auth/me', { token: crew.token })).body;
  assert.deepEqual(crewMe.menu.apps, ['works', 'requests', 'assets']);
  // A ski area still has every role.
  is(await api('POST', '/users', { token: skiToken, body: { username: `pat-${suffix}`.slice(0, 40), password: PW, role: 'patrol' } }), 201);
});

// ---------------------------------------------------------------- billing plans by kind
test('plans are sold to one kind: the ski pricing page and billing screen never list municipal plans, and the reverse', async () => {
  const site = await api('GET', '/site/plans');
  is(site, 200);
  for (const p of [...site.body.plans, ...site.body.addons]) assert.ok(!p.code.startsWith('muni-'), `${p.code} on the ski pricing page`);

  const [rows] = await pool.query("SELECT code, name, kind, modules, monthly_cents, yearly_cents FROM billing_plans WHERE org_type = 'municipality' ORDER BY kind = 'plan' DESC, sort");
  assert.deepEqual(rows.map((r) => [r.code, r.name, r.kind, r.modules, Number(r.monthly_cents), Number(r.yearly_cents)]), [
    ['muni-core', 'Public Works', 'plan', 'assets,workforce,documents,messages,requests', 40000, 480000],
    ['muni-water', 'Water', 'addon', 'water', 20000, 240000],
    ['muni-sewer', 'Sewer', 'addon', 'sewer', 20000, 240000],
    ['muni-stormwater', 'Stormwater', 'addon', 'stormwater', 10000, 120000],
    ['muni-solidwaste', 'Trash and recycling', 'addon', 'solidwaste', 15000, 180000],
    ['muni-buildings', 'Buildings', 'addon', 'buildings', 10000, 120000],
  ]);

  const mb = await api('GET', '/billing', { token: muni.token });
  is(mb, 200);
  assert.equal(mb.body.org_type, 'municipality');
  assert.deepEqual(mb.body.plans.map((p) => p.code), ['muni-core']);
  assert.deepEqual(mb.body.addons.map((p) => p.code), ['muni-water', 'muni-sewer', 'muni-stormwater', 'muni-solidwaste', 'muni-buildings']);
  const sb = await api('GET', '/billing', { token: skiToken });
  is(sb, 200);
  assert.ok(sb.body.plans.length && !sb.body.plans.some((p) => p.code.startsWith('muni-')));
  assert.ok(!sb.body.addons.some((p) => p.code.startsWith('muni-')));

  // Choosing the other kind's plan is refused.
  const skiPlan = sb.body.plans[0];
  is(await api('PUT', '/billing/choice', { token: muni.token, body: { plan_id: skiPlan.id, interval: 'year' } }), 400);
  is(await api('PUT', '/billing/choice', { token: skiToken, body: { plan_id: mb.body.plans[0].id, interval: 'month' } }), 400);
  is(await api('PUT', '/billing/choice', { token: muni.token, body: { plan_id: mb.body.plans[0].id, addons: [mb.body.addons[0].id], interval: 'year' } }), 200);
  // The console's billing for a tenant takes only its kind's plans, and a plan's apps must be for its kind.
  is(await platform('PUT', `/tenants/${muni.id}/billing`, { plan_id: skiPlan.id }), 400);
  const wrong = await platform('POST', '/billing/plans', { code: `mf-wrong-${suffix}`.slice(0, 40), name: 'Wrong', org_type: 'municipality', modules: ['sell'], monthly_cents: 100 });
  is(wrong, 400);
});

// ---------------------------------------------------------------- the SPA shell
test('the SPA knows the kind: isMuni and orgWord, municipal views with stubs, groups and role names', async () => {
  const fs = require('fs'); const path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8');
  const ui = read('ui.js');
  assert.match(ui, /export const isMuni = \(\) => /);
  assert.match(ui, /export const orgWord = \(\) => \(isMuni\(\) \? 'municipality' : 'mountain'\)/);
  const main = read('main.js');
  for (const [key, file] of [['requests', 'requests.js'], ['notices', 'street-notices.js'], ['works', 'works.js'], ['assetprograms', 'asset-programs.js'], ['bulk', 'bulk-pickup.js'], ['buildings', 'buildings.js']]) {
    assert.match(main, new RegExp(`\\['${key}', '[^']+', \\(\\) => [^\\]]+import\\('./views/${file.replace('.', '\\.')}'\\)\\]`), key);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'js', 'views', file)), file);
  }
  assert.match(main, /const VIEW_MODULE = \{ requests: 'requests', notices: 'requests', works: 'assets', assetprograms: 'assets', bulk: 'solidwaste', buildings: 'buildings' \};/);
  // The menu plan uses the municipal groups for a municipality, and the ski groups otherwise.
  const os = require('os'); const { pathToFileURL } = require('url');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-muni-'));
  fs.cpSync(path.join(__dirname, '..', 'public', 'js'), path.join(tmp, 'js'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  const ui2 = await import(pathToFileURL(path.join(tmp, 'js', 'ui.js')).href);
  const nav = await import(pathToFileURL(path.join(tmp, 'js', 'nav.js')).href);
  ui2.ctx.me = { role: 'owner', org_type: 'municipality' };
  assert.equal(ui2.isMuni(), true);
  assert.equal(ui2.orgWord(), 'municipality');
  const views = ['dashboard', 'inbox', 'myshifts', 'requests', 'notices', 'bulk', 'works', 'assets', 'assetprograms', 'buildings', 'workforce', 'messages', 'documents', 'settings', 'help'].map((k) => [k, k]);
  const plan = nav.menuPlan(views, { apps: ['requests', 'works', 'assets', 'workforce'], start: 'dashboard' });
  assert.deepEqual(plan.home, ['dashboard', 'inbox', 'myshifts']);
  assert.deepEqual(plan.groups.map((g) => g.name), ['Residents', 'Public works', 'Back office']);
  assert.deepEqual(plan.groups.flatMap((g) => g.keys).sort(), ['assetprograms', 'buildings', 'bulk', 'documents', 'messages', 'notices'].sort());
  assert.equal(nav.roleName({ role: 'staff', org_type: 'municipality' }), 'Crew');
  assert.equal(nav.roleName({ role: 'counter', org_type: 'municipality' }), 'Front desk');
  assert.equal(nav.roleName({ role: 'staff' }), 'Lift and mountain staff', 'a ski area keeps its names');
  ui2.ctx.me = { role: 'owner' };
  assert.equal(ui2.orgWord(), 'mountain');
  assert.deepEqual(nav.menuPlan([['conditions', 'Mountain status'], ['patrol', 'Patrol']], { apps: [], start: 'dashboard' }).groups.map((g) => g.name), ['On the hill']);
  fs.rmSync(tmp, { recursive: true, force: true });
});
