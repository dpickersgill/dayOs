'use strict';

// Ski school safety screens (feat/school-safety), in jsdom against the real API: a long check-in list folds by class
// with counts; My day folds a long roster, keeps each student to a few buttons and has the class tools; the lineup does
// not offer "Use this split" when nobody is there to split; the Pickup view lists the children to release.
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
const slug = `ssw-${suffix}`;
const PW = 'correct-horse-battery';
const TZ = 'America/New_York';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const skip = () => !JSDOM && { skip: 'jsdom is not installed' };

let server; let base; let dom; let mods; let tmp; let tid;
let inflight = 0;
const T = {}; const D = {};

async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
async function settle() {
  let calm = 0;
  for (let i = 0; i < 250 && calm < 3; i++) { await sleep(20); calm = inflight === 0 && !document.querySelector('.loading') ? calm + 1 : 0; }
}
const me = (role, extra = {}) => ({ id: 1, email: `${role}@x.test`, role, tenant: slug, tenant_name: 'Safety Mountain', timezone: TZ, staff_id: null, ...extra });
async function renderWith(fn, role, token, extra = {}) {
  mods.ui.ctx.me = me(role, extra);
  mods.ui.ctx.tz = TZ;
  mods.api.session.token = token;
  document.body.replaceChildren(document.createElement('div'));
  const root = document.body.firstChild;
  await fn(root);
  await settle();
  return root;
}
const clean = (root, what) => {
  assert.equal(root.querySelector('.error-box'), null, `${what}: ${root.querySelector('.error-box') && root.querySelector('.error-box').textContent}`);
  for (const bad of ['undefined', '[object', 'NaN']) assert.ok(!root.textContent.includes(bad), `${what}: page text contains "${bad}"`);
};
const buttons = (scope, text) => [...scope.querySelectorAll('button')].filter((x) => x.textContent.trim() === text);

test.before(async (t) => {
  if (!JSDOM) { t.skip('jsdom is not installed'); return; }
  await new Promise((resolve) => { server = createApp().listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: `${base}/`, pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  for (const k of ['document', 'Node', 'HTMLElement', 'sessionStorage', 'localStorage', 'location', 'history', 'Event', 'FormData', 'CSS']) if (w[k]) Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: w, configurable: true, writable: true });
  // the screens refresh themselves on a timer; the timers must not keep the test process alive
  const realInterval = globalThis.setInterval;
  globalThis.setInterval = (...a) => { const t = realInterval(...a); if (t && t.unref) t.unref(); return t; };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...a) => { inflight += 1; try { return await realFetch(...a); } finally { inflight -= 1; } };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-ss-'));
  fs.cpSync(path.join(__dirname, '..', 'public', 'js'), path.join(tmp, 'js'), { recursive: true });
  fs.cpSync(path.join(__dirname, '..', 'public', 'vendor', 'qrcode'), path.join(tmp, 'vendor', 'qrcode'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  const imp = (f) => import(pathToFileURL(path.join(tmp, 'js', f)).href);
  mods = { api: await imp('api.js'), ui: await imp('ui.js'), view: (n) => imp(`views/${n}.js`) };
  mods.api.config.base = base;

  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Safety Mountain', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const login = async (email) => ok(await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).token;
  T.owner = await login(`owner@${slug}.test`);
  [[{ id: tid }]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
  await pool.query('UPDATE tenants SET timezone = ? WHERE id = ?', [TZ, tid]);
  ok(await api('POST', '/users', { token: T.owner, body: { email: `desk@${slug}.test`, password: PW, role: 'counter' } }));
  T.desk = await login(`desk@${slug}.test`);
  const st = ok(await api('POST', '/workforce/staff', { token: T.owner, body: { person: { first_name: 'Sam', last_name: 'Teach' }, status: 'active' } }));
  D.sam = st.id;
  await pool.query('INSERT INTO instructor_profiles (tenant_id, staff_id, disciplines, ski_level_max, teaches_kids) VALUES (?, ?, ?, 9, 1)', [tid, st.id, 'ski']);
  ok(await api('POST', '/users', { token: T.owner, body: { email: `sam@${slug}.test`, password: PW, role: 'instructor', staff_id: st.id } }));
  T.sam = await login(`sam@${slug}.test`);
  const prod = ok(await api('POST', '/products', { token: T.owner, body: { kind: 'lesson', name: 'Kids group', base_price_cents: 8000 } })).id;
  // a late lesson today (not started), 14 children of 7 to 12, with nobody checked in yet
  D.sid = ok(await api('POST', '/skischool/sessions', { token: T.owner, body: { product_id: prod, starts_at: `${today}T23:00`, ends_at: `${today}T23:50`, capacity: 20, age_min: 7, age_max: 12, instructor_id: D.sam, override_reason: 'Test' } })).id;
  const yr = Number(today.slice(0, 4));
  for (let i = 0; i < 14; i++) {
    ok(await api('POST', `/skischool/sessions/${D.sid}/bookings`, { token: T.owner, body: { student: { first_name: `Kid${String.fromCharCode(65 + i)}`, last_name: 'Test', date_of_birth: `${yr - 9}-02-02`, sex: 'male' }, sign_waiver: true, waiver_signer: { name: 'Pat Parent' }, send_confirmation: false, override_reason: 'A big class for the test', pickup_adults: [{ name: 'Pat Parent', relationship: 'Mom' }] } }));
  }
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
  if (dom) dom.window.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('check-in: a long day folds by class, with the counts in the heading', skip(), async () => {
  const lineup = await mods.view('school-lineup');
  const root = await renderWith((r) => lineup.tabs({}).find((x) => x[0] === 'checkin')[2](r), 'counter', T.desk);
  clean(root, 'check-in');
  const folds = root.querySelectorAll('details.group-fold');
  assert.equal(folds.length, 1, 'one section per class');
  assert.equal(folds[0].open, false, 'more than 12 students: folded');
  assert.match(folds[0].querySelector('summary').textContent, /0 of 14 here/);
  assert.match(folds[0].querySelector('summary').textContent, /Sam's class/);
  assert.equal(folds[0].querySelectorAll('li.lu-row').length, 14);
});

test('lineup: nobody checked in, so "Use this split" is not offered', skip(), async () => {
  const lineup = await mods.view('school-lineup');
  const root = await renderWith((r) => lineup.tabs({}).find((x) => x[0] === 'lineup')[2](r), 'owner', T.owner);
  clean(root, 'lineup');
  buttons(root, 'Suggest a split')[0].click(); await settle();
  assert.equal(buttons(root, 'Use this split').length, 0);
  assert.match(root.textContent, /Nobody is checked in yet, so there is nothing to split/);
});

test('My day: a long roster folds, each student has a few buttons, the class has We\'re at, Post update and Lost child', skip(), async () => {
  const myday = await mods.view('school-myday');
  const root = await renderWith((r) => myday.render(r), 'instructor', T.sam, { staff_id: D.sam, school_access: 'instructor' });
  clean(root, 'My day');
  const fold = root.querySelector('details.myday-fold');
  assert.ok(fold, 'the roster folds');
  assert.match(fold.querySelector('summary').textContent, /14 students/);
  const row = root.querySelector('li.myday-student');
  const names = [...row.querySelectorAll('button')].map((b) => b.textContent.trim());
  assert.deepEqual(names, ['Present', 'No-show', 'More'], 'release opens 30 minutes before the end; the rest is under More');
  for (const t of ["We're at", 'Post update', 'Lost child']) assert.equal(buttons(root.querySelector('.myday-tools'), t).length, 1, t);
});

test('Pickup: the desk sees the day\'s children to release, by class', skip(), async () => {
  const safety = await mods.view('school-safety');
  const root = await renderWith((r) => safety.tabs().find((x) => x[0] === 'pickup')[2](r), 'counter', T.desk);
  clean(root, 'pickup');
  const sel = root.querySelector('select[aria-label="Show"]');
  sel.value = 'all'; sel.dispatchEvent(new window.Event('change', { bubbles: true })); await settle();
  const fold = root.querySelector('details.group-fold');
  assert.ok(fold);
  assert.match(fold.querySelector('summary').textContent, /14 children/);
  assert.equal(root.querySelectorAll('button[aria-label^="Release Kid"]').length, 14);
  assert.match(root.textContent, /In the lesson/);
});
