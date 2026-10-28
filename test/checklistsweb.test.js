'use strict';

// Screens for patrol checklists, in jsdom against the real API: the Checklists card in Settings, Patrol (switches,
// preview, the patrol's own lists) and the case panel (suggested lists, Add a checklist, ticks, no signal, frozen copies).
// jsdom cannot load <script type="module">, so the ES modules are imported from a copy of public/js Node treats as ESM.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.AUDIT_LOG_STDOUT = 'off';

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

const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const slug = `clw-${suffix}`;
const PW = 'correct-horse-battery';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const skip = () => !JSDOM && { skip: 'jsdom is not installed' };

let server; let base; let dom; let mods; let tmp; let tenantId;
let inflight = 0;
const T = {};

async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };

async function settle() {
  let calm = 0;
  for (let i = 0; i < 200 && calm < 3; i++) {
    await sleep(20);
    calm = inflight === 0 && !document.querySelector('.loading') ? calm + 1 : 0;
  }
}

const me = (role, extra = {}) => ({ id: 1, email: `${role}@x.test`, role, tenant: slug, tenant_name: 'Checklist Mountain', timezone: 'America/New_York', staff_id: null, ...extra });
async function renderView(name, role, token, extra, params) {
  mods.ui.ctx.me = me(role, extra);
  mods.ui.ctx.tz = 'America/New_York';
  mods.api.session.token = token;
  document.body.replaceChildren(document.createElement('div'));
  window.history.replaceState(null, '', window.location.pathname);
  mods.ui.newPage();
  const root = document.body.firstChild;
  const mod = await mods.view(name);
  const holder = document.createElement('div');
  await mod.render(holder, params);
  root.append(holder);
  await settle();
  return root;
}
const clean = (root, what) => {
  assert.equal(root.querySelector('.error-box'), null, `${what}: error box shown: ${root.querySelector('.error-box') && root.querySelector('.error-box').textContent}`);
  for (const bad of ['undefined', 'null', '[object', 'NaN']) assert.ok(!root.textContent.includes(bad), `${what}: page text contains "${bad}"`);
};
const clickBtn = (scope, text) => { const b = [...scope.querySelectorAll('button')].find((x) => x.textContent.trim() === text); assert.ok(b, `no "${text}" button`); b.click(); return b; };
const overlay = () => document.querySelector('.overlay');
const closeOverlays = () => { for (let i = 0; i < 6 && overlay(); i++) overlay().querySelector('button[aria-label="Close"]').click(); };
const change = (el) => el.dispatchEvent(new window.Event('change', { bubbles: true }));
const errors = () => [...document.querySelectorAll('.toast[data-kind=error]')].map((x) => x.textContent);

test.before(async (t) => {
  if (!JSDOM) { t.skip('jsdom is not installed'); return; }
  await new Promise((resolve) => { server = createApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: `${base}/`, pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  for (const k of ['document', 'Node', 'HTMLElement', 'sessionStorage', 'localStorage', 'location', 'history', 'Event', 'FormData']) Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: w, configurable: true, writable: true });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...a) => { inflight += 1; try { return await realFetch(...a); } finally { inflight -= 1; } };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-cl-'));
  fs.cpSync(path.join(__dirname, '..', 'public', 'js'), path.join(tmp, 'js'), { recursive: true });
  fs.cpSync(path.join(__dirname, '..', 'public', 'vendor', 'qrcode'), path.join(tmp, 'vendor', 'qrcode'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  const imp = (f) => import(pathToFileURL(path.join(tmp, 'js', f)).href);
  mods = { api: await imp('api.js'), ui: await imp('ui.js'), view: (n) => imp(`views/${n}.js`), imp };
  mods.api.config.base = base;

  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Checklist Mountain', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const login = async (email) => ok(await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).token;
  T.owner = await login(`owner@${slug}.test`);
  ok(await api('POST', '/users', { token: T.owner, body: { email: `patrol@${slug}.test`, password: PW, role: 'patrol' } }));
  T.patrol = await login(`patrol@${slug}.test`);
  [[{ id: tenantId }]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
  if (dom) dom.window.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('settings: the Checklists card switches lists, previews them, and writes, edits and archives the patrol\'s own', skip(), async () => {
  // a patroller without the patrol admin's settings permission never sees the card
  const plain = await renderView('settings', 'patrol', T.patrol, {}, ['patrol']);
  assert.equal(plain.querySelector('[data-card="patrol-checklists"]'), null);

  let root = await renderView('settings', 'owner', T.owner, {}, ['patrol']);
  let card = root.querySelector('[data-card="patrol-checklists"]');
  assert.ok(card, 'the owner sees Settings, Patrol, Checklists');
  clean(card, 'checklists card');
  const row = (id) => card.querySelector(`.cl-row[data-list="${id}"]`);
  assert.match(row('head_spine').textContent, /Head or spine injury/);
  assert.match(row('head_spine').textContent, /Any fall with a head strike/);
  assert.match(row('head_spine').textContent, /8 items/);
  for (const g of ['care', 'people', 'scene', 'lifts', 'attractions', 'own']) assert.ok(card.querySelector(`[data-group="${g}"]`), `group ${g}`);
  assert.equal(row('zipline_rescue').querySelector('input[role=switch]').checked, false, 'no zipline yet: the zipline list starts off');
  assert.match(row('zipline_rescue').textContent, /Off until the mountain adds this kind of attraction/);
  for (const b of card.querySelectorAll('button, input[role=switch]')) assert.ok(b.getAttribute('aria-label') || b.textContent.trim(), 'every control is named');

  // preview
  row('cardiac_arrest').querySelector('button[aria-label="Preview Cardiac arrest or unresponsive"]').click(); await settle();
  assert.equal(overlay().querySelectorAll('.cl-preview li').length, 10);
  assert.match(overlay().textContent, /AED applied and analyzing/);
  closeOverlays();

  // a switch saves straight away
  const sw = row('collision').querySelector('input[role=switch]');
  assert.equal(sw.checked, true);
  sw.checked = false; change(sw); await settle();
  assert.deepEqual(errors(), []);
  assert.ok(!ok(await api('GET', '/patrol/checklists', { token: T.patrol })).data.some((l) => l.id === 'collision'), 'collision is off');

  // write one
  clickBtn(card, 'Write a checklist'); await settle();
  let dlg = overlay();
  dlg.querySelector('[name=title]').value = 'Night skiing call';
  dlg.querySelector('[name=when]').value = 'Any call after the lights come on.';
  dlg.querySelector('[name=attraction_type]').value = 'ice_rink';
  const items = [...dlg.querySelectorAll('input[name=item]')];
  assert.equal(items.length, 3, 'three blank items to start');
  items[0].value = 'Run lights checked'; items[1].value = 'Groomer radioed'; items[2].value = '';
  clickBtn(dlg, 'Add an item');
  dlg.querySelectorAll('input[name=item]')[3].value = 'Snowmaking guns checked';
  dlg.querySelectorAll('.cl-edit-item')[3].querySelector('[aria-label="Move up"]').click(); // ahead of the blank one
  dlg.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(overlay(), null, 'the dialog closed');
  let own = ok(await api('GET', '/patrol/checklists/setup', { token: T.owner })).custom;
  assert.equal(own.length, 1);
  assert.deepEqual(own[0].items.map((i) => i.label), ['Run lights checked', 'Groomer radioed', 'Snowmaking guns checked']);
  assert.deepEqual([own[0].scope, own[0].attraction_type, own[0].enabled], ['case', 'ice_rink', true]);

  // edit: reword, reorder, take one off
  card = root.querySelector('[data-card="patrol-checklists"]');
  card.querySelector('button[aria-label="Edit Night skiing call"]').click(); await settle();
  dlg = overlay();
  dlg.querySelector('[name=title]').value = 'Night call';
  const lis = dlg.querySelectorAll('.cl-edit-item');
  lis[1].querySelector('input').value = 'Groomers radioed';
  lis[2].querySelector('[aria-label="Take this item off"]').click();
  dlg.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle();
  own = ok(await api('GET', '/patrol/checklists/setup', { token: T.owner })).custom;
  assert.equal(own[0].title, 'Night call');
  assert.deepEqual(own[0].items.map((i) => i.label), ['Run lights checked', 'Groomers radioed']);

  // archive, then bring back
  card = root.querySelector('[data-card="patrol-checklists"]');
  card.querySelector('button[aria-label="Archive Night call"]').click(); await settle();
  clickBtn(overlay(), 'Archive'); await settle();
  card = root.querySelector('[data-card="patrol-checklists"]');
  assert.match(card.querySelector('.cl-archived').textContent, /Archived \(1\)/);
  card.querySelector('button[aria-label="Bring back Night call"]').click(); await settle();
  card = root.querySelector('[data-card="patrol-checklists"]');
  assert.equal(card.querySelector('.cl-archived'), null);
  clean(card, 'checklists card after changes');
  // put collision back for the case test
  ok(await api('PUT', '/patrol/checklists/builtin/collision', { token: T.owner, body: { enabled: true } }));
});

test('case: suggested lists first, Add a checklist for any list that is on, ticks with no signal, and a frozen copy', skip(), async () => {
  await pool.query("INSERT INTO attractions (tenant_id, name, type, status) VALUES (?, 'Eagle Zip', 'zipline', 'open')", [tenantId]);
  const [[att]] = await pool.query("SELECT id FROM attractions WHERE tenant_id = ? AND name = 'Eagle Zip'", [tenantId]);
  const o = T.owner;
  const c = ok(await api('POST', '/patrol/incidents', { token: o, body: { occurred_at: `${today}T13:10`, location: 'Zip line 3', category: 'injury', severity: 'moderate', summary: 'Rider stuck short of the platform' } }));
  await pool.query('UPDATE incidents SET attraction_id = ? WHERE id = ?', [att.id, c.id]);
  const b = `/patrol/incidents/${c.id}`;
  const pid = ok(await api('POST', `${b}/patients`, { token: o, body: { form: { head_strike: 'no' }, first_name: 'Zed', last_name: 'Rider', age_years: 15 } })).id;
  ok(await api('POST', `${b}/patients/${pid}/treatments`, { token: o, body: { kind: 'splint', performed_at: `${today}T13:20` } }));
  ok(await api('PUT', '/patrol/checklists/builtin/seizure', { token: o, body: { enabled: false } }));

  let root = await renderView('patrol', 'owner', o, {}, ['case', String(c.id)]);
  let panel = root.querySelector('[data-area=checklists]');
  clean(panel, 'checklist panel');
  const shown = [...panel.querySelectorAll('details.checklist')].map((d) => d.dataset.checklist);
  assert.deepEqual(shown, ['zipline_rescue', `minor:${pid}`, `fracture:${pid}`], 'the attraction list, the minor and the splint: suggested first, in order');
  assert.ok(!shown.includes('collision'), 'nothing that does not fit');

  // tick one: the whole row is a label around a big checkbox, and the tick saves with its words
  const first = panel.querySelector('[data-checklist="zipline_rescue"] input[type=checkbox]');
  assert.ok(first.closest('label.cl-check'));
  first.checked = true; change(first); await settle();
  let got = ok(await api('GET', b, { token: o }));
  assert.deepEqual([got.checklist[0].item_key, got.checklist[0].list_title, got.checklist[0].item_label], ['zl_line_closed', 'Zipline rescue or stuck rider', 'Line closed: no more riders sent, and the other lines checked']);
  panel = root.querySelector('[data-area=checklists]');
  assert.match(panel.querySelector('[data-checklist="zipline_rescue"] summary').textContent, /1 of 9/);
  assert.ok(panel.querySelector('[data-checklist="zipline_rescue"]').open, 'the card stays open after the save');

  // add another: every list that is on, one tap each; a list that is off is not offered
  clickBtn(panel, 'Add a checklist'); await settle();
  const dlg = overlay();
  const offered = [...dlg.querySelectorAll('.cl-pick-btn')].map((x) => x.dataset.list);
  assert.ok(offered.includes('cold_injury') && offered.includes('lost_person') && offered.includes('cardiac_arrest'));
  assert.ok(!offered.includes('seizure'), 'switched off: not offered');
  assert.ok(!offered.includes('zipline_rescue'), 'already shown');
  const filter = dlg.querySelector('input[type=search]');
  filter.value = 'hypothermia'; filter.dispatchEvent(new window.Event('input', { bubbles: true }));
  const pick = [...dlg.querySelectorAll('.cl-pick-btn')];
  assert.equal(pick.length, 1);
  assert.match(pick[0].textContent, /Cold injury.*for Zed Rider/);
  pick[0].click(); await settle();
  assert.equal(overlay(), null);
  panel = root.querySelector('[data-area=checklists]');
  const cold = panel.querySelector(`[data-checklist="cold_injury:${pid}"]`);
  assert.ok(cold && cold.open, 'added and open');

  // with no signal, a tick waits on the phone and shows as waiting; it is sent with the time it was ticked
  const online = (v) => { for (const nav of [window.navigator, globalThis.navigator]) Object.defineProperty(nav, 'onLine', { value: v, configurable: true }); };
  online(false);
  try {
    const box = cold.querySelector('input[data-key="cold_sheltered"]');
    box.checked = true; change(box); await sleep(300); await settle();
    panel = root.querySelector('[data-area=checklists]');
    const after = panel.querySelector(`[data-checklist="cold_injury:${pid}"]`);
    assert.ok(after, 'the added list stays on the page');
    assert.match(after.textContent, /Waiting to send/);
    assert.equal(after.querySelector('input[data-key="cold_sheltered"]').checked, true);
    assert.equal(ok(await api('GET', b, { token: o })).checklist.length, 1, 'nothing reached the server yet');
  } finally { online(true); }
  const outbox = await mods.imp('outbox.js');
  assert.equal(await outbox.flush(), 1);
  await sleep(400); await settle();
  got = ok(await api('GET', b, { token: o }));
  const sent = got.checklist.find((r) => r.item_key === 'cold_sheltered');
  assert.ok(sent && sent.patient_id === pid && sent.item_label === 'Patient moved out of the wind and cold, and handled gently');

  // a frozen copy shows what was ticked, in the words of the time, even after the list is switched off
  ok(await api('PATCH', `${b}/patients/${pid}`, { token: o, body: { chief_complaint: 'Sore shoulder from the harness', disposition: 'treated_released' } }));
  const staff = ok(await api('POST', '/workforce/staff', { token: o, body: { person: { first_name: 'Lee', last_name: 'Lead' }, status: 'active' } })).id;
  ok(await api('POST', `${b}/responders`, { token: o, body: { staff_id: staff, role: 'lead' } }));
  ok(await api('POST', `${b}/submit`, { token: o }));
  ok(await api('POST', `${b}/approve`, { token: o }));
  ok(await api('PUT', '/patrol/checklists/builtin/zipline_rescue', { token: o, body: { enabled: false } }));
  const v = ok(await api('GET', b, { token: o })).versions.filter((x) => x.kind === 'approved').pop();
  root = await renderView('patrol', 'owner', o, {}, ['version', String(c.id), String(v.id)]);
  if (!root.querySelector('[data-area=checklists]')) { root.querySelector('[role=tab][data-mode=care]').click(); await settle(); }
  panel = root.querySelector('[data-area=checklists]');
  assert.ok(panel, 'the frozen copy shows its checklists');
  clean(panel, 'frozen checklists');
  assert.ok(panel.querySelector('[data-checklist="zipline_rescue"]'), 'a list switched off since still shows its ticks');
  assert.match(panel.textContent, /Line closed: no more riders sent/);
  assert.doesNotMatch(panel.textContent, /Rider talked to/, 'only what was ticked');
  assert.equal(panel.querySelector('button.cl-add'), null, 'nothing can be added to a frozen copy');
  assert.ok([...panel.querySelectorAll('input[type=checkbox]')].every((x) => x.disabled && x.checked), 'read only');

  // the claim file lists the ticks
  root = await renderView('patrol', 'owner', o, {}, ['claim', String(c.id)]);
  const doc = root.textContent;
  assert.match(doc, /Checklists/);
  assert.match(doc, /Zipline rescue or stuck rider/);
  assert.match(doc, /Patient moved out of the wind and cold/);
});
