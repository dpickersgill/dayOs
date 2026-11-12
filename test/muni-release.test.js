'use strict';

// Municipal edition, release 1, put together (the assembly of the six workstreams): the demo borough builds twice with
// nothing added the second time and every add-on on; its sample response targets give the repair record met and missed
// requests; Today has cards from every municipal app, for the roles that may read them; and every public page follows
// one address pattern, /<page>/<municipality>, each reachable with its API behind it.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.PUBLIC_RATE_LIMIT = '100000';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const M = require('../src/lib/modules');

const PW = 'a-demo-password-1';
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const demo = `rel-demo-${suffix}`.slice(0, 40);
let server; let base; let T;
const tokens = {};

async function call(method, p, { token, body } = {}) {
  const res = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, type: res.headers.get('content-type') || '' };
}
const api = (method, p, o) => call(method, `/api/v1${p}`, o);
const run = () => execFileSync(process.execPath, [path.join(__dirname, '..', 'db', 'demo-municipal.js'), demo], { cwd: path.join(__dirname, '..'), env: { ...process.env, SEED_PASSWORD: PW }, timeout: 240000 }).toString();

/** How many rows this tenant has in every table that has a tenant_id. */
async function rowCounts(tenantId) {
  const [tables] = await pool.query("SELECT table_name AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND column_name = 'tenant_id' ORDER BY table_name");
  const out = {};
  for (const { t } of tables) out[t] = Number((await pool.query(`SELECT COUNT(*) AS n FROM \`${t}\` WHERE tenant_id = ?`, [tenantId]))[0][0].n);
  return out;
}

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('the demo borough: every demo file in order, twice, with nothing added the second time', async () => {
  const out = run();
  const files = [...out.matchAll(/^(\d\d-[a-z]+\.js):$/gm)].map((m) => m[1]);
  assert.deepEqual(files, ['00-base.js', '20-assets.js', '30-requests.js', '40-trash.js', '50-notices.js', '60-buildings.js', '90-money.js'], 'every workstream\'s demo file, in name order');
  const [[t]] = await pool.query('SELECT id, org_type FROM tenants WHERE slug = ?', [demo]);
  T = Number(t.id);
  const first = await rowCounts(T);
  for (const table of ['streets', 'map_features', 'asset_programs', 'requests', 'request_standards', 'residents', 'bulk_bookings', 'alert_signups', 'street_notices', 'buildings', 'building_plans', 'work_orders']) assert.ok(first[table] > 0, `${table} has demo rows`);
  run();
  const second = await rowCounts(T);
  const changed = Object.keys(first).filter((k) => first[k] !== second[k]).map((k) => `${k}: ${first[k]} -> ${second[k]}`);
  assert.deepEqual(changed, [], 'the second run adds nothing to any table');
  M.invalidate(T);
  for (const who of ['owner', 'manager', 'crew1', 'frontdesk']) {
    const r = await api('POST', '/auth/login', { body: { tenant: demo, login: who, password: PW } });
    assert.equal(r.status, 200, `${who} signs in`);
    tokens[who] = r.body.token;
  }
});

test('the demo borough has every municipal add-on on, and a demo found with one off gets it back', async () => {
  const me = (await api('GET', '/auth/me', { token: tokens.owner })).body;
  for (const k of ['assets', 'workforce', 'documents', 'messages', 'requests', 'water', 'sewer', 'stormwater', 'solidwaste', 'buildings']) assert.ok(me.modules.includes(k), k);
  await pool.query("UPDATE tenant_modules SET enabled = 0 WHERE tenant_id = ? AND module = 'buildings'", [T]);
  run();
  M.invalidate(T);
  assert.ok((await api('GET', '/auth/me', { token: tokens.owner })).body.modules.includes('buildings'));
});

test('sample response targets: the repair record shows requests that met them and requests that did not', async () => {
  const [stds] = await pool.query("SELECT c.name, s.make_safe_hours AS safe, s.fix_hours AS fix FROM request_standards s JOIN request_categories c ON c.tenant_id = s.tenant_id AND c.id = s.category_id WHERE s.tenant_id = ? AND s.street_class = 'any'", [T]);
  const of = (name) => { const s = stds.find((x) => x.name === name); return s ? [s.safe, s.fix] : null; };
  assert.deepEqual(of('Pothole'), [24, 120], 'pothole: make safe in 24 hours, fix in 5 days');
  assert.deepEqual(of('Sign down or damaged'), [4, 72], 'sign down: make safe in 4 hours, fix in 3 days');
  assert.deepEqual(of('Street light out'), [null, 240], 'street light: fix in 10 days');
  assert.equal(of('Water leak or low pressure')[0], 2, 'water leak: make safe in 2 hours');
  assert.equal(of('Sewer backup')[0], 2, 'sewer backup: make safe in 2 hours');
  const from = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10);
  const ledger = await api('GET', `/requests/ledger?from=${from}`, { token: tokens.manager });
  assert.equal(ledger.status, 200, JSON.stringify(ledger.body).slice(0, 200));
  const fixed = ledger.body.data.filter((d) => d.fix.done && d.fix.target_hours);
  assert.ok(fixed.some((d) => d.fix.met === true) && fixed.some((d) => d.fix.met === false), 'fixed in time, and fixed late');
  const safe = ledger.body.data.filter((d) => d.make_safe.done && d.make_safe.target_hours);
  assert.ok(safe.some((d) => d.make_safe.met === true) && safe.some((d) => d.make_safe.met === false), 'made safe in time, and late');
  // The record itself never carries who reported it.
  assert.ok(ledger.body.data.every((d) => d.contact === undefined && d.house_number === undefined));
});

// The Today screen's own list (public/js/views/dashboard.js MUNI_TODAY): app, address, and who asks for it.
const TODAY = [
  ['/ops/work-orders/today', ['owner', 'manager', 'crew1']],
  ['/assets/programs/today', ['owner', 'manager', 'crew1']],
  ['/requests/today', ['owner', 'manager', 'crew1', 'frontdesk']],
  ['/street-notices/today', ['owner', 'manager', 'crew1', 'frontdesk']],
  ['/solid-waste/today', ['owner', 'manager', 'crew1', 'frontdesk']],
  ['/water/today', ['owner', 'manager', 'crew1']],
  ['/sewer/today', ['owner', 'manager', 'crew1']],
  ['/stormwater/today', ['owner', 'manager', 'crew1']],
  ['/buildings/today', ['owner', 'manager', 'crew1', 'frontdesk']],
];
test('Today for the demo borough: every municipal app gives cards, each with a title, something to read and a screen to open', async () => {
  for (const [p, roles] of TODAY) {
    for (const who of roles) {
      const r = await api('GET', p, { token: tokens[who] });
      assert.equal(r.status, 200, `${p} for ${who}: ${JSON.stringify(r.body).slice(0, 200)}`);
      assert.ok(Array.isArray(r.body.cards) && r.body.cards.length >= 1, `${p} for ${who} has cards with the demo data`);
      for (const c of r.body.cards) {
        assert.ok(c.title && typeof c.title === 'string', `${p}: a title`);
        assert.ok((c.count !== undefined && c.count !== null && Number.isFinite(Number(c.count))) || c.text, `${p} ${c.title}: a count or a line of text`);
        assert.match(String(c.href), /^#\/(works|assetprograms|requests|notices|bulk|assets|buildings)(\/|\?|$)/, `${p} ${c.title}: opens a municipal screen`);
        assert.ok(!/undefined|null|NaN/.test(`${c.title} ${c.text || ''}`), `${p} ${c.title}: ${c.text}`);
      }
    }
  }
  // The Today screen asks each role only for what it may read: its list matches the routes above.
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'js', 'views', 'dashboard.js'), 'utf8');
  const listed = [...src.slice(src.indexOf('export const MUNI_TODAY')).split('];')[0].matchAll(/\['[a-z]+', '([^']+)', \(\) => (true|can\('staff'\))\]/g)].map((m) => [m[1], m[2] === 'true']);
  assert.deepEqual(listed.map((x) => x[0]), TODAY.map((x) => x[0]));
  for (const [p, everyone] of listed) {
    const r = await api('GET', p, { token: tokens.frontdesk });
    assert.equal(r.status, everyone ? 200 : 403, `${p}: the front desk ${everyone ? 'reads it' : 'is not asked for it'}`);
  }
});

test('public pages: one pattern, /<page>/<municipality>, each served and each with its API', async () => {
  const pages = [
    ['/report/', 'report.js', '/report'],
    ['/open-requests/', 'open-requests.js', '/open-requests'],
    ['/alerts/', 'resident-alerts.js', '/alerts'],
    ['/bulk-pickup/', 'bulkpage.js', '/bulk-pickup'],
  ];
  for (const [page, script, word] of pages) {
    const html = await call('GET', `${page}${demo}`);
    assert.equal(html.status, 200, page);
    assert.match(html.type, /text\/html/);
    assert.ok(String(html.body).includes(script), `${page} loads ${script}`);
    const data = await api('GET', `/public/${demo}${word}`);
    assert.equal(data.status, 200, `${word}: ${JSON.stringify(data.body).slice(0, 200)}`);
  }
  assert.equal((await api('GET', `/public/${demo}/streets`)).body.streets.length, 40);
  // The old spelling of the bulk pickup page is gone: one pattern only.
  assert.equal((await call('GET', `/public/${demo}/bulk-pickup`)).status, 404);
  // The links the app hands out use the same pattern.
  const bulk = await api('GET', '/solid-waste/settings', { token: tokens.manager });
  assert.equal(new URL(bulk.body.page).pathname, `/bulk-pickup/${demo}`);
  const notices = await api('GET', '/street-notices/setup', { token: tokens.manager });
  assert.equal(new URL(notices.body.signup_link).pathname, `/alerts/${demo}`);
});
