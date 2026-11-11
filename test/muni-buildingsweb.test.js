'use strict';

// Buildings screens (muni release 1), in jsdom against the real API: the six tabs, one building's page and its tabs, a
// staff round passed with one tap, and the binder. Skipped when jsdom is not installed, like the other screen tests.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.AUDIT_LOG_STDOUT = 'off';
process.env.MODULE_CACHE_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (_) { /* skipped below */ }

const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { createMuniTenant } = require('./helpers/muni');
const { addDays, todayIn } = require('../src/lib/util');

const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const TZ = 'America/New_York';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = () => !JSDOM && { skip: 'jsdom is not installed' };
let server; let base; let dom; let mods; let tmp; let M; let crew;
let inflight = 0;
const D = {};

async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  assert.ok(res.status < 300, `${method} ${p}: ${res.status} ${text}`);
  return json;
}
async function settle() {
  let calm = 0;
  for (let i = 0; i < 250 && calm < 3; i++) { await sleep(20); calm = inflight === 0 && !document.querySelector('.loading') ? calm + 1 : 0; }
}
async function show(role, token, hash, params) {
  mods.ui.ctx.me = { id: 1, role, tenant: M.slug, tenant_name: M.name, timezone: TZ, staff_id: null, org_type: 'municipality', modules: ['assets', 'buildings', 'documents'] };
  mods.ui.ctx.tz = TZ;
  mods.api.session.token = token;
  document.body.replaceChildren(document.createElement('div'));
  window.history.replaceState(null, '', hash);
  mods.ui.newPage();
  const root = document.body.firstChild;
  const mod = await mods.view('buildings');
  await mod.render(root, params);
  await settle();
  return root;
}
const clean = (root, what) => {
  assert.equal(root.querySelector('.error-box'), null, `${what}: ${root.querySelector('.error-box') && root.querySelector('.error-box').textContent}`);
  for (const bad of ['undefined', 'null', '[object', 'NaN', 'Invalid Date']) assert.ok(!root.textContent.includes(bad), `${what}: page text contains "${bad}": ${root.textContent.slice(Math.max(0, root.textContent.indexOf(bad) - 60), root.textContent.indexOf(bad) + 40)}`);
};
const button = (scope, text) => [...scope.querySelectorAll('button')].find((x) => x.textContent.trim() === text);
const tab = async (root, text) => { const b = [...root.querySelectorAll('[role="tab"]')].find((x) => x.textContent.trim() === text); assert.ok(b, `tab ${text}`); b.click(); await settle(); };

test.before(async (t) => {
  if (!JSDOM) { t.skip('jsdom is not installed'); return; }
  await new Promise((resolve) => { server = createApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: `${base}/`, pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  for (const k of ['document', 'Node', 'HTMLElement', 'sessionStorage', 'localStorage', 'location', 'history', 'Event', 'FormData', 'CSS']) if (w[k]) Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: w, configurable: true, writable: true });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...a) => { inflight += 1; try { return await realFetch(...a); } finally { inflight -= 1; } };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-bld-'));
  fs.cpSync(path.join(__dirname, '..', 'public', 'js'), path.join(tmp, 'js'), { recursive: true });
  fs.cpSync(path.join(__dirname, '..', 'public', 'vendor', 'qrcode'), path.join(tmp, 'vendor', 'qrcode'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  const imp = (f) => import(pathToFileURL(path.join(tmp, 'js', f)).href);
  mods = { api: await imp('api.js'), ui: await imp('ui.js'), view: (n) => imp(`views/${n}.js`) };
  mods.api.config.base = base;

  M = await createMuniTenant(base, { slug: `bldw-${suffix}`, name: 'Elmhurst Borough', modules: { buildings: true } });
  crew = await M.addLogin('staff');
  const today = todayIn(TZ);
  D.building = (await api('POST', '/buildings', { token: M.token, body: { name: 'Town Hall', type: 'office', address: '1 Center Square', year_built: 1958, square_feet: 15000, rooms: ['Lobby'] } })).id;
  const page = await api('GET', `/buildings/${D.building}`, { token: M.token });
  const lobby = page.rooms[0].id;
  D.ext = (await api('POST', `/buildings/${D.building}/equipment`, { token: M.token, body: { name: 'Town Hall extinguisher', kind: 'fire_extinguisher', room_id: lobby, count: 2 } })).ids;
  D.elevator = (await api('POST', `/buildings/${D.building}/equipment`, { token: M.token, body: { name: 'Town Hall elevator', kind: 'elevator' } })).ids[0];
  D.generator = (await api('POST', `/buildings/${D.building}/equipment`, { token: M.token, body: { name: 'Town Hall generator', kind: 'generator' } })).ids[0];
  const vendor = (await api('POST', '/assets/vendors', { token: M.token, body: { name: 'Allied Fire' } })).id;
  const plans = (await api('GET', `/buildings/${D.building}`, { token: M.token })).plans;
  const plan = (asset, task) => plans.find((p) => p.asset_id === asset && p.task === task).plan_id;
  await api('POST', '/buildings/visits', { token: M.token, body: { vendor_id: vendor, visit_on: addDays(today, -45), technician: 'R. Diaz', items: [
    { plan_id: plan(D.ext[0], 'Fire extinguisher annual maintenance'), result: 'pass' }, { plan_id: plan(D.ext[1], 'Fire extinguisher annual maintenance'), result: 'fail', note: 'Shell dented' },
    { plan_id: plan(D.elevator, 'Elevator inspection'), result: 'pass', certificate: { expires_on: addDays(today, 20), number: 'EL-1' } },
    { plan_id: plan(D.ext[0], 'Fire extinguisher monthly check'), result: 'pass' },
  ], deficiencies: [{ building_id: D.building, description: 'Exit sign by the stairs is unlit' }] } });
});
test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
  if (dom) dom.window.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('Buildings: every tab draws for a manager and for the front desk', skip(), async () => {
  const desk = await M.addLogin('counter');
  for (const [role, token] of [['owner', M.token], ['counter', desk.token]]) {
    const root = await show(role, token, '#/buildings');
    clean(root, `${role} list`);
    assert.ok(root.textContent.includes('Town Hall'));
    assert.equal(Boolean(button(root, 'Add a building')), role === 'owner');
    assert.equal(Boolean(button(root, 'Record a vendor visit')), role === 'owner', 'the front desk reads only');
    for (const t of ['Calendar', 'Vendor visits', 'Certificates', 'Deficiencies', 'Checks']) { await tab(root, t); clean(root, `${role} ${t}`); }
  }
  const root = await show('owner', M.token, '#/buildings?tab=calendar');
  assert.ok(root.textContent.includes('Overdue (1)'), 'the monthly check done 45 days ago');
  assert.ok(root.textContent.includes('NFPA 10'));
  await tab(root, 'Certificates');
  assert.ok(root.textContent.includes('Runs out within 30 days') && root.textContent.includes('EL-1'));
  await tab(root, 'Deficiencies');
  assert.ok(root.textContent.includes('Shell dented') && root.textContent.includes('Exit sign by the stairs is unlit'));
  await tab(root, 'Checks');
  assert.ok(root.textContent.includes('34 Pa. Code 405.7'));
  [...root.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Edit').click(); await settle();
  const dlg = [...document.querySelectorAll('.dialog')].pop();
  assert.ok(dlg && dlg.textContent.includes('Checklist') && dlg.textContent.includes('How often'));
  clean(dlg, 'edit a check');
  await mods.ui.closeAllDialogs();
});

test('one building: items by room, the year, files, history; the record-a-visit and add-items dialogs open', skip(), async () => {
  const root = await show('owner', M.token, `#/buildings/b/${D.building}`, ['b', String(D.building)]);
  clean(root, 'building');
  assert.ok(root.textContent.includes('1 Center Square') && root.textContent.includes('built 1958'));
  assert.ok(root.textContent.includes('Lobby') && root.textContent.includes('Town Hall extinguisher 1'));
  for (const t of ['Year', 'Certificates', 'Files', 'Deficiencies', 'History']) { await tab(root, t); clean(root, `building ${t}`); }
  await tab(root, 'Year');
  assert.ok(root.querySelector('table.bld-year') && root.querySelectorAll('table.bld-year tbody tr').length >= 4);
  await tab(root, 'Items');
  button(root, 'Add items').click(); await settle();
  assert.ok(document.querySelector('.dialog') && document.querySelector('.dialog').textContent.includes('How many'));
  await mods.ui.closeAllDialogs();
  button(root, 'Record a vendor visit').click(); await settle();
  const dlg = [...document.querySelectorAll('.dialog')].pop();
  assert.ok(dlg && dlg.textContent.includes('What the visit covered') && dlg.textContent.includes('Elevator inspection'), `the visit dialog: ${dlg ? dlg.textContent.slice(0, 300) : 'none'} / ${[...document.querySelectorAll('.toast')].map((x) => x.textContent).join('|')}`);
  clean(dlg, 'visit dialog');
  await mods.ui.closeAllDialogs();
});

test('a round on a phone: one tap passes an item, a check with readings asks for them, and it finishes', skip(), async () => {
  const r = await api('POST', `/buildings/${D.building}/rounds`, { token: crew.token, body: {} });
  let root = await show('staff', crew.token, `#/buildings/round/${r.id}`, ['round', String(r.id)]);
  clean(root, 'round');
  const stops = [...root.querySelectorAll('.bld-stop')];
  assert.equal(stops.length, 3, 'two extinguishers and the generator exercise');
  const ext = stops.find((s) => s.textContent.includes('Town Hall extinguisher 1'));
  assert.ok(button(ext, 'Pass') && button(ext, 'Fail') && button(ext, 'Missing'));
  const gen = stops.find((s) => s.textContent.includes('Town Hall generator'));
  assert.ok(button(gen, 'Check') && !button(gen, 'Pass'), 'readings are asked for, not passed with one tap');
  button(ext, 'Fail').click(); await settle();
  let dlg = [...document.querySelectorAll('.dialog')].pop();
  assert.ok(dlg.textContent.includes('Tick what failed') && dlg.textContent.includes('Gauge in the green') && dlg.querySelector('input[type="file"]'), 'what is wrong, with a photo');
  await mods.ui.closeAllDialogs();
  button(gen, 'Check').click(); await settle();
  dlg = [...document.querySelectorAll('.dialog')].pop();
  assert.ok(dlg.textContent.includes('Run time under load') && dlg.textContent.includes('at least 30 minutes'), 'the shared answer sheet, with the reading\'s rule');
  clean(dlg, 'readings dialog');
  await mods.ui.closeAllDialogs();
  button(ext, 'Pass').click(); await settle(); await sleep(150); await settle();
  root = document.body.firstChild;
  clean(root, 'round after a pass');
  assert.ok(root.textContent.includes('1 of 3 checked'));
  assert.ok(root.querySelector('.bld-stop-pass'));
  const view = await api('GET', `/buildings/rounds/${r.id}`, { token: crew.token });
  assert.equal(view.stops.filter((s) => s.result === 'pass').length, 1);
  await api('POST', `/buildings/rounds/${r.id}/finish`, { token: crew.token, body: {} });
  root = await show('staff', crew.token, `#/buildings/round/${r.id}`, ['round', String(r.id)]);
  clean(root, 'finished round');
  assert.ok(root.textContent.includes('This round is finished') && root.textContent.includes('Not checked'));
});

test('the binder page: every section, with the building and the dates in the heading', skip(), async () => {
  const root = await show('owner', M.token, `#/buildings/binder?building=${D.building}`, ['binder']);
  clean(root, 'binder');
  const text = root.querySelector('.binder').textContent;
  assert.ok(text.includes('Life-safety binder: Town Hall') && text.includes('Elmhurst Borough'));
  for (const s of ['Buildings', 'Overdue now', 'Certificates on file (1)', 'Deficiencies (2)', 'Vendor visits (1)', 'Inspections']) assert.ok(text.includes(s), s);
  assert.ok(text.includes('Allied Fire, R. Diaz') && text.includes('Shell dented'));
  assert.ok(text.includes('does not certify'));
  assert.ok(button(root, 'Print or save as PDF') && button(root, 'Download spreadsheet'));
});
