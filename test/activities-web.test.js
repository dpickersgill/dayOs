'use strict';

// Activities on screen, against the real API with jsdom (as test/web.test.js does): the Activities tab in Sell (only when
// there are activities, before Gift cards), picking a time with places left, guests by type, the rider limits and the
// waiver at checkout; setting up an activity and its time slots in Products and prices; the Gate screen scanning at an
// attraction; and a gate device set to an attraction in Settings.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

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
const slug = `actw-${suffix}`;
const PW = 'correct-horse-battery';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const plus = (d, k) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const DAY = plus(today, 1);

let server; let base; let dom; let mods; let tmp; let inflight = 0;
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
  for (let i = 0; i < 200 && calm < 3; i++) { await sleep(20); calm = inflight === 0 && !document.querySelector('.loading') ? calm + 1 : 0; }
}
const me = (role) => ({ id: 1, email: `${role}@x.test`, role, tenant: slug, tenant_name: 'Activity Mountain', timezone: 'America/New_York', staff_id: null, modules: null });
async function renderView(name, role, token, params) {
  mods.ui.ctx.me = me(role); mods.ui.ctx.tz = 'America/New_York'; mods.api.session.token = token;
  document.body.replaceChildren(document.createElement('div'));
  window.history.replaceState(null, '', window.location.pathname);
  mods.ui.newPage();
  const root = document.body.firstChild;
  const holder = document.createElement('div');
  await (await mods.view(name)).render(holder, params);
  root.append(holder);
  await settle();
  return root;
}
const clean = (root, what) => {
  assert.equal(root.querySelector('.error-box'), null, `${what}: error box shown: ${root.querySelector('.error-box') && root.querySelector('.error-box').textContent}`);
  for (const bad of ["undefined", "null", "[object", "NaN"]) assert.ok(!root.textContent.includes(bad), `${what}: page text contains "${bad}": ${root.textContent.slice(Math.max(0, root.textContent.indexOf(bad) - 80), root.textContent.indexOf(bad) + 40)}`);
};
const clickBtn = (scope, text) => { const b = [...scope.querySelectorAll('button')].find((x) => x.textContent.trim() === text); assert.ok(b, `no "${text}" button`); b.click(); return b; };
const typeInto = (root, name, value) => { const el = root.querySelector(`[name=${name}]`); assert.ok(el, `no field named ${name}`); el.value = value; };
const tabNames = (root) => [...root.querySelectorAll('[role=tab]')].map((t) => t.textContent);
const openTab = async (root, text) => { [...root.querySelectorAll('[role=tab]')].find((t) => t.textContent === text).click(); await settle(); };
const topDialog = () => [...document.querySelectorAll('.overlay')].at(-1);
const closeOverlays = async () => { for (let i = 0; i < 6; i++) { const o = document.querySelector('.overlay'); if (!o) return; o.querySelector('button[aria-label="Close"]').click(); await settle(); } };
const change = (el, value) => { el.value = value; el.dispatchEvent(new window.Event('change', { bubbles: true })); };
const skip = () => !JSDOM && { skip: 'jsdom is not installed' };

test.before(async (t) => {
  if (!JSDOM) { t.skip('jsdom is not installed'); return; }
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: `${base}/`, pretendToBeVisual: true });
  const w = dom.window; w.scrollTo = () => {};
  for (const k of ['document', 'Node', 'HTMLElement', 'sessionStorage', 'localStorage', 'location', 'history', 'Event', 'FormData']) Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: w, configurable: true, writable: true });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...a) => { inflight += 1; try { return await realFetch(...a); } finally { inflight -= 1; } };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-actweb-'));
  fs.cpSync(path.join(__dirname, '..', 'public', 'js'), path.join(tmp, 'js'), { recursive: true });
  fs.cpSync(path.join(__dirname, '..', 'public', 'vendor', 'qrcode'), path.join(tmp, 'vendor', 'qrcode'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  const imp = (f) => import(pathToFileURL(path.join(tmp, 'js', f)).href);
  mods = { api: await imp('api.js'), ui: await imp('ui.js'), view: (n) => imp(`views/${n}.js`) };
  mods.api.config.base = base;

  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Activity Mountain', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const login = async (email) => ok(await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).token;
  T.owner = await login(`owner@${slug}.test`);
  ok(await api('POST', '/users', { token: T.owner, body: { email: `counter@${slug}.test`, password: PW, role: 'counter' } }));
  T.counter = await login(`counter@${slug}.test`);
  const [[ten]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
  D.tenant = ten.id;
  const att = async (name, type, limits) => (await pool.query('INSERT INTO attractions (tenant_id, name, type, status, min_height_in, min_age, waiver_required) VALUES (?, ?, ?, ?, ?, ?, ?)', [ten.id, name, type, 'open', limits ? 48 : null, limits ? 7 : null, limits ? 1 : 0]))[0].insertId;
  D.zip = await att('Eagle Zipline', 'zipline', true);
  D.rink = await att('Village Rink', 'ice_rink', false);
  ok(await api('POST', '/products', { token: T.owner, body: { kind: 'day_ticket', name: 'Adult Day', base_price_cents: 6500 } }));
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.end();
  if (dom) dom.window.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('sell: no Activities tab until the mountain has an activity on sale', skip(), async () => {
  const root = await renderView('sell', 'counter', T.counter);
  assert.ok(!tabNames(root).includes('Activities'));
});

test('products and prices: an activity is set up with its attraction, then its time slots', skip(), async () => {
  const root = await renderView('catalog', 'owner', T.owner);
  clean(root, 'catalog');
  clickBtn(root, 'Add product'); await settle();
  let dlg = topDialog();
  const setup = dlg.querySelector('.act-setup');
  assert.equal(setup.hidden, true, 'the activity fields show only for an activity');
  assert.equal(dlg.querySelector('.act-includes').hidden, false, 'a day ticket can include attractions');
  change(dlg.querySelector('[name=kind]'), 'activity');
  assert.equal(setup.hidden, false); assert.equal(dlg.querySelector('.act-includes').hidden, true);
  typeInto(dlg, 'name', 'Zip tour'); typeInto(dlg, 'price', '89.00');
  clickBtn(dlg, 'Save'); await settle();
  assert.match(dlg.textContent, /Choose the attraction this activity is for/);
  change(dlg.querySelector('[name=attraction_id]'), String(D.zip));
  clickBtn(dlg, 'Save'); await settle();
  // saved: the time slots dialog opens straight away
  dlg = topDialog();
  assert.match(dlg.querySelector('h2, h1, .dialog-title, header').textContent + dlg.textContent, /Time slots for Zip tour/);
  assert.match(dlg.textContent, /No times yet/);
  clickBtn(dlg, 'Add times'); await settle();
  const form = topDialog();
  typeInto(form, 'starts_on', today);
  form.querySelector('[name=gen_every]').value = '60'; form.querySelector('[name=gen_from]').value = '10:00'; form.querySelector('[name=gen_to]').value = '12:00';
  clickBtn(form, 'Fill in'); await settle();
  assert.equal(form.querySelector('[name=times]').value, '10:00, 11:00, 12:00');
  typeInto(form, 'slot_minutes', '60'); typeInto(form, 'capacity', '2');
  clickBtn(form, 'Add times'); await settle();
  assert.match(topDialog().textContent, /10:00 AM, 11:00 AM, 12:00 PM/);
  clean(topDialog(), 'time slots');
  await closeOverlays();
  const prods = ok(await api('GET', '/products?kind=activity', { token: T.owner })).data;
  D.zipP = prods.find((p) => p.name === 'Zip tour').id;
  assert.equal(prods.find((p) => p.name === 'Zip tour').attraction_id, D.zip);
  // a skating day pass, and the list shows each activity's attraction
  D.rinkP = ok(await api('POST', '/products', { token: T.owner, body: { kind: 'activity', name: 'Skate all day', base_price_cents: 1200, attraction_id: D.rink, timed: 0, day_capacity: 50 } })).id;
  const again = await renderView('catalog', 'owner', T.owner);
  const row = [...again.querySelectorAll('tr')].find((r) => r.textContent.includes('Zip tour'));
  assert.match(row.textContent, /Eagle Zipline\. Time slots/);
  assert.ok([...row.querySelectorAll('button')].some((b) => b.textContent === 'Time slots'));
  assert.match([...again.querySelectorAll('tr')].find((r) => r.textContent.includes('Skate all day')).textContent, /Village Rink\. All day, 50 places a day/);
});

test('sell: the Activities tab sits before Gift cards, shows times with places left, and checkout needs the limits and the waiver', skip(), async () => {
  await closeOverlays();
  const root = await renderView('sell', 'counter', T.counter);
  const names = tabNames(root);
  assert.equal(names.indexOf('Activities'), names.indexOf('Gift cards') - 1, `tabs: ${names.join(', ')}`);
  await openTab(root, 'Activities');
  clean(root, 'activities tab');
  assert.match(root.textContent, /Riders must be at least 48 inches tall and be 7 or older/);
  change(root.querySelector('[name=act-date]'), DAY); await settle();
  const slot = root.querySelector('.slot-btn[data-slot="11:00"]');
  assert.ok(slot, 'the 11:00 time is shown');
  assert.match(slot.textContent, /11:00 AM\s*2 left/);
  const add = [...root.querySelectorAll('button')].find((b) => /Add .* to basket|Add to basket/.test(b.textContent));
  assert.equal(add.disabled, true, 'nothing to add until a time is picked');
  slot.click(); await settle();
  assert.equal(root.querySelector('.slot-btn[data-slot="11:00"]').getAttribute('aria-pressed'), 'true');
  clickBtn(root, 'Add 1 guest to basket'); await settle();
  assert.equal(root.querySelectorAll('.basket-line[data-type=activity]').length, 1);
  assert.match(root.textContent, /Total\s*\$89\.00/);

  clickBtn(root, 'Checkout'); await settle();
  const dlg = topDialog();
  for (const [k, v] of Object.entries({ first_name: 'Rae', last_name: 'Rider', email: 'rae@rider.test', date_of_birth: '1990-04-04', sex: 'female' })) typeInto(dlg, k, v);
  dlg.querySelector('[name=first_name]').dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle();
  const limits = dlg.querySelector('.limits-ok');
  assert.ok(limits, 'a box to confirm the rider meets the limits');
  assert.match(limits.textContent, /Rae Rider meets the limits/);
  clickBtn(dlg, 'Next: payment'); await settle();
  assert.match(dlg.textContent, /Confirm that Rae Rider meets the limits for Eagle Zipline/);
  limits.querySelector('input').checked = true; limits.querySelector('input').dispatchEvent(new window.Event('change', { bubbles: true }));
  // the zipline needs a waiver: the counter's own waiver box shows for the rider
  const waiver = [...dlg.querySelectorAll('label.check')].find((l) => /Waiver signed at the counter/.test(l.textContent));
  assert.ok(waiver && !waiver.parentNode.hidden, 'the waiver is asked for');
  clickBtn(dlg, 'Next: payment'); await settle();
  clickBtn(dlg, 'Cash'); await settle();
  clickBtn(dlg, 'Take cash'); await settle();
  clickBtn(dlg, 'Complete sale'); await settle();
  assert.match(dlg.textContent, /409|needs a signed waiver/, 'refused without the waiver');
  clickBtn(dlg, 'Back'); await settle();
  waiver.querySelector('input').checked = true;
  clickBtn(dlg, 'Next: payment'); await settle();
  clickBtn(dlg, 'Complete sale'); await settle();
  assert.match(dlg.textContent, /Sold \$89\.00/);
  assert.match(dlg.textContent, /Activities booked/);
  assert.match(dlg.textContent, /Rae Rider: Zip tour at Eagle Zipline, .*11:00 AM to 12:00 PM/);
  assert.ok(dlg.querySelectorAll('.code').length >= 1, 'the ticket code is shown');
  clean(dlg, 'receipt');
  clickBtn(dlg, 'New sale'); await settle();
  // the places left go down for the next sale
  await openTab(root, 'Tickets'); await openTab(root, 'Activities');
  change(root.querySelector('[name=act-date]'), DAY); await settle();
  assert.match(root.querySelector('.slot-btn[data-slot="11:00"]').textContent, /1 left/);
});

test('gate: the Gate screen scans at an attraction and says why a ticket is refused', skip(), async () => {
  const sold = ok(await api('POST', '/checkout', { token: T.counter, body: { customer: { details: { first_name: 'Sk', last_name: 'Ater', email: 'sk@x.test', date_of_birth: '1990-01-01', sex: 'male' } }, lines: [{ type: 'activity', product_id: D.rinkP }], payments: [{ tender: 'cash', amount_cents: 1200 }] } }));
  const code = sold.tickets[0].code;
  const root = await renderView('gate', 'counter', T.counter);
  const place = root.querySelector('[name=scan-place]');
  assert.ok(place, 'scanning at: lifts or an attraction');
  assert.deepEqual([...place.options].map((o) => o.textContent), ['Lifts', 'Eagle Zipline', 'Village Rink']);
  const scan = async (value) => { const box = root.querySelector('[name=code]'); box.value = value; box.form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle(); };
  await scan(code);
  assert.match(root.querySelector('.gate').textContent, /Wrong attraction/);
  assert.match(root.querySelector('.gate').textContent, /This ticket is for Village Rink\. Scan it at Village Rink/);
  change(place, String(D.rink)); await settle();
  await scan(code);
  assert.match(root.querySelector('.gate').textContent, /Let them ride/);
  await scan(code);
  assert.match(root.querySelector('.gate').textContent, /Already used/);
  window.localStorage.removeItem('verdynt.gate.place');
});

test('settings: a gate device is set to stand at an attraction', skip(), async () => {
  ok(await api('POST', '/access/devices', { token: T.owner, body: { name: 'Rink turnstile' } }));
  const root = await renderView('settings', 'owner', T.owner, ['sell']);
  const card = root.querySelector('#gate-devices') || root;
  clickBtn(card, 'Change'); await settle();
  const dlg = topDialog();
  const sel = dlg.querySelector('[name=attraction_id]');
  assert.ok(sel, 'where the device stands');
  change(sel, String(D.rink));
  clickBtn(dlg, 'Save'); await settle();
  assert.match(root.textContent, /at Village Rink/);
  const list = ok(await api('GET', '/access/devices', { token: T.owner })).data;
  assert.equal(list[0].attraction_id, D.rink);
  await closeOverlays();
});
