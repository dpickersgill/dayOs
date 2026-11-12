'use strict';

// Every municipal screen, opened in jsdom against the real API with the demo borough's data (municipal release 1, put
// together): Today, Work orders, Programs, Requests, Street notices, Bulk pickup and Buildings, each for the owner, a Crew
// login and the Front desk where that role has the screen. A screen passes when it draws with no error box and no
// "undefined", "NaN" or "[object" in its text. Skipped when jsdom is not installed, like the other screen tests.
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
const { execFileSync } = require('child_process');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (_) { /* skipped below */ }

const { createApp } = require('../src/app');
const { pool } = require('../src/db');

const PW = 'a-demo-password-1';
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const demo = `scr-demo-${suffix}`.slice(0, 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = () => !JSDOM && { skip: 'jsdom is not installed' };
let server; let base; let mods; let tmp;
let inflight = 0;
const asked = []; // every API address a screen asked for
const who = {}; // username -> { token, me }

async function settle() {
  let calm = 0;
  for (let i = 0; i < 400 && calm < 3; i += 1) { await sleep(20); calm = inflight === 0 && !document.querySelector('.loading') ? calm + 1 : 0; }
}
/** Opens one screen as one login and returns its root element. */
async function show(user, view, hash, params = []) {
  const { token, me } = who[user];
  mods.ui.ctx.me = me;
  mods.ui.ctx.tz = me.timezone;
  mods.api.session.token = token;
  document.body.replaceChildren(document.createElement('div'));
  window.history.replaceState(null, '', hash);
  mods.ui.newPage();
  const root = document.body.firstChild;
  const mod = await mods.view(view);
  await mod.render(root, params);
  await settle();
  return root;
}
const clean = (root, what) => {
  const box = root.querySelector('.error-box');
  assert.equal(box, null, `${what}: ${box && box.textContent}`);
  const text = root.textContent;
  assert.ok(text.trim().length > 40, `${what}: the screen has something on it`);
  for (const bad of ['undefined', '[object', 'NaN', 'Invalid Date']) assert.ok(!text.includes(bad), `${what}: page text contains "${bad}": ${text.slice(Math.max(0, text.indexOf(bad) - 80), text.indexOf(bad) + 40)}`);
  // A part that does not apply, appended as null, shows as the word "null" (review fix: "nullnull" over the stop counts).
  const walker = document.createTreeWalker(root, 4);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) assert.notEqual(n.nodeValue, 'null', `${what}: a "null" on the page, before: ${(n.previousSibling && n.previousSibling.textContent || '').slice(0, 60)}`);
};
const tabs = (root) => [...root.querySelectorAll('[role="tab"]')];

test.before(async (t) => {
  if (!JSDOM) { t.skip('jsdom is not installed'); return; }
  await new Promise((resolve) => { server = createApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: `${base}/`, pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  for (const k of ['document', 'Node', 'HTMLElement', 'sessionStorage', 'localStorage', 'location', 'history', 'Event', 'FormData', 'CSS']) if (w[k]) Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: w, configurable: true, writable: true });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...a) => { asked.push(String(a[0] && a[0].url ? a[0].url : a[0])); inflight += 1; try { return await realFetch(...a); } finally { inflight -= 1; } };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-muni-'));
  fs.cpSync(path.join(__dirname, '..', 'public', 'js'), path.join(tmp, 'js'), { recursive: true });
  fs.cpSync(path.join(__dirname, '..', 'public', 'vendor', 'qrcode'), path.join(tmp, 'vendor', 'qrcode'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  const imp = (f) => import(pathToFileURL(path.join(tmp, 'js', f)).href);
  mods = { api: await imp('api.js'), ui: await imp('ui.js'), view: (n) => imp(`views/${n}.js`) };
  mods.api.config.base = base;

  execFileSync(process.execPath, [path.join(__dirname, '..', 'db', 'demo-municipal.js'), demo], { cwd: path.join(__dirname, '..'), env: { ...process.env, SEED_PASSWORD: PW }, timeout: 240000 });
  require('../src/lib/modules').invalidate((await pool.query('SELECT id FROM tenants WHERE slug = ?', [demo]))[0][0].id);
  for (const user of ['owner', 'crew1', 'frontdesk']) {
    const login = await (await realFetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenant: demo, login: user, password: PW }) })).json();
    assert.ok(login.token, `${user} signs in`);
    const me = await (await realFetch(`${base}/api/v1/auth/me`, { headers: { authorization: `Bearer ${login.token}` } })).json();
    assert.equal(me.org_type, 'municipality');
    who[user] = { token: login.token, me };
  }
});
test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  await pool.end();
});

test('Today: cards from every municipal app, for the owner, the crew and the front desk', skip(), async () => {
  const titles = async (user) => {
    const root = await show(user, 'dashboard', '#/dashboard');
    clean(root, `Today for ${user}`);
    assert.ok(root.querySelector('[data-today="municipal"]'), 'the municipal Today');
    return [...root.querySelectorAll('.bd-muni h2')].map((x) => x.textContent);
  };
  const owner = await titles('owner');
  for (const t of ['Open work orders', 'New requests', 'Active street notices', 'Water work orders', 'Sewer work orders', 'Stormwater work orders', 'Building checks due this week']) assert.ok(owner.includes(t), `owner: ${t} in ${owner.join(' | ')}`);
  assert.ok(owner.some((t) => /bulk pickup/i.test(t)), 'owner: a bulk pickup card');
  assert.ok(owner.some((t) => /valves|hydrant/i.test(t)), 'owner: a program in progress');
  assert.deepEqual(await titles('crew1'), owner, 'the crew sees the same cards');
  const desk = await titles('frontdesk');
  assert.ok(desk.includes('New requests') && desk.includes('Active street notices') && desk.includes('Building checks due this week') && desk.some((t) => /bulk pickup/i.test(t)));
  assert.ok(!desk.some((t) => /work orders|Water|Sewer|Stormwater/.test(t)), `the front desk is not shown the crew's cards: ${desk.join(' | ')}`);
});

// [view key in the menu, its file, the address, who has it, words that must be on it]
const SCREENS = [
  ['works', 'works', '#/works', ['owner', 'crew1'], ['Work orders']],
  ['assetprograms', 'asset-programs', '#/assetprograms', ['owner', 'crew1'], ['Exercise zone 3 valves']],
  ['requests', 'requests', '#/requests', ['owner', 'crew1', 'frontdesk'], ['Requests']],
  ['notices', 'street-notices', '#/notices', ['owner', 'crew1', 'frontdesk'], ['Street notices']],
  ['bulk', 'bulk-pickup', '#/bulk', ['owner', 'crew1', 'frontdesk'], ['Bulk pickup']],
  ['buildings', 'buildings', '#/buildings', ['owner', 'crew1', 'frontdesk'], ['Riverbend Borough Hall']],
];
for (const [key, file, hash, users, words] of SCREENS) {
  test(`${key}: the screen and each of its tabs draw with the demo data`, skip(), async () => {
    for (const user of users) {
      const root = await show(user, file, hash);
      clean(root, `${key} for ${user}`);
      for (const w of words) assert.ok(root.textContent.includes(w), `${key} for ${user}: "${w}" in ${root.textContent.slice(0, 300)}`);
      // Every tab on the screen opens (a map tab needs a real browser, so it is left alone).
      for (const name of tabs(root).map((b) => b.textContent.trim())) {
        if (/map/i.test(name)) continue;
        const b = tabs(root).find((x) => x.textContent.trim() === name);
        if (!b) continue;
        b.click(); await settle();
        clean(root, `${key} for ${user}, tab ${name}`);
      }
    }
  });
}

test('Work orders: the crew sees the house number of a job from a request; the spreadsheet is for the office, not the crew', skip(), async () => {
  const [[w]] = await pool.query("SELECT w.id, w.location FROM work_orders w JOIN tenants t ON t.id = w.tenant_id JOIN requests r ON r.tenant_id = w.tenant_id AND r.id = w.request_id WHERE t.slug = ? AND r.house_number IS NOT NULL AND w.status NOT IN ('done','cancelled') LIMIT 1", [demo]);
  assert.ok(w, 'the demo has an open work order made from a request with a house number');
  const root = await show('crew1', 'works', '#/works');
  assert.ok(root.textContent.includes(w.location), 'the full location on the crew\'s list');
  assert.equal([...root.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Download spreadsheet'), false, 'the crew has no spreadsheet button (2026.11.20)');
  assert.equal([...root.querySelectorAll('label')].some((l) => /Include contact details/.test(l.textContent)), false, 'only a manager is offered contact details');
  const mgr = await show('owner', 'works', '#/works');
  assert.ok([...mgr.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Download spreadsheet'));
  assert.ok([...mgr.querySelectorAll('label')].some((l) => /Include contact details \(logged\)/.test(l.textContent)));
});

// ---------------------------------------------------------------- review fixes (2026.11.19)
test('Bulk pickup, Collection day: no "null" above the counts on a day with no pickups', skip(), async () => {
  const root = await show('owner', 'bulk-pickup', '#/bulk');
  clean(root, 'bulk pickup, collection day');
  assert.ok(!root.textContent.includes('nullnull'));
});

test('municipal screens never call the ski APIs (/skischool, /guest-types) that would refuse them', skip(), async () => {
  asked.length = 0;
  const [[st]] = await pool.query('SELECT s.id FROM staff s JOIN tenants t ON t.id = s.tenant_id WHERE t.slug = ? ORDER BY s.id LIMIT 1', [demo]);
  const [[as]] = await pool.query('SELECT a.id FROM ops_assets a JOIN tenants t ON t.id = a.tenant_id WHERE t.slug = ? ORDER BY a.id LIMIT 1', [demo]);
  for (const [file, hash, params] of [['myshifts', '#/myshifts', []], ['workforce', '#/workforce', []], ['workforce', `#/workforce/staff/${st.id}`, ['staff', String(st.id)]], ['assets', `#/assets/a/${as.id}`, ['a', String(as.id)]], ['settings', '#/settings/streets', ['streets']], ['settings', '#/settings', []]]) {
    const root = await show('owner', file, hash, params);
    const box = root.querySelector('.error-box');
    assert.equal(box, null, `${hash}: ${box && box.textContent}`);
  }
  const ski = asked.filter((u) => /\/api\/v1\/(skischool|guest-types|schedule\/lifts)(\/|\?|$)/.test(u));
  assert.deepEqual(ski, [], 'no ski API asked for');
});

test('shared screens and help use municipal words for a municipality', skip(), async () => {
  const assets = await show('owner', 'assets', '#/assets');
  assert.ok(!/lift part|snow gun/i.test(assets.textContent), 'Assets: no lift parts or snow guns');
  const help = await show('owner', 'help', '#/help/time-zone', ['time-zone']);
  assert.match(help.textContent, /Your municipality.s time zone/);
  assert.ok(!/mountain/i.test(help.querySelector('h1').textContent + help.querySelector('.help-intro').textContent), help.textContent.slice(0, 200));
  const sec = await show('owner', 'help', '#/help/for-assets', ['for-assets']);
  assert.ok(!/snow gun|lift part/.test(sec.textContent), 'the Assets help section');
  const shopHelp = await show('frontdesk', 'help', '#/help/shop-after', ['shop-after']);
  assert.ok(!/Date changes and guest emails/.test(shopHelp.textContent), 'the online shop article is for ski areas');
  for (const user of ['crew1', 'frontdesk']) assert.ok(!/Date changes and guest emails/.test((await show(user, 'help', '#/help', [])).textContent), `${user}: not listed`);
  const settingsHelp = await show('owner', 'help', '#/help/for-settings', ['for-settings']);
  assert.ok(!/the mountain.s details/.test(settingsHelp.textContent));
  const mfa = await show('owner', 'settings', '#/settings/profile', ['profile']);
  assert.ok(!/guest and patient/.test(mfa.textContent), 'two-step sign-in: residents, not guests and patients');
});

test('"Mark the rest as pass" shows only when a checklist has pass-or-fail items', skip(), async () => {
  const { answerSheet } = await import(pathToFileURL(path.join(tmp, 'js', 'checksteps.js')).href);
  const chips = () => { const el = document.createElement('div'); let v = null; return { el, get: () => v, set: (x) => { v = x; } }; };
  assert.equal(answerSheet([{ key: 'a', label: 'Run time', type: 'number', min: 1 }, { key: 'b', label: 'Next test', type: 'date' }], chips).hasPassItems, false);
  assert.equal(answerSheet([{ key: 'a', label: 'Run time', type: 'number' }, { key: 'c', label: 'Panel clean' }], chips).hasPassItems, true);
});
