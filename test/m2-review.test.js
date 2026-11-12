'use strict';

// Release 2026.11.20, review fixes. Each test goes through real HTTP and failed before its fix:
//   1. money: only owners and managers receive money amounts for work orders and assets, from any endpoint (the demo
//      borough's crew and front desk are swept across every endpoint that carries a cost)
//   2. water customer account numbers: only a keyed hash and the last 4 are kept; the full number is never returned
//   3. request numbers: 40 public reports at once across two municipalities all succeed, numbered in order
//   4. the customer list import takes 30,000 rows; above its limit a clear 413
//   5. Apps and add-ons: adding or removing one add-on keeps the others (trial, comped, subscription)
//   6. the municipal crew endpoints are refused to a ski area
//   7. What's new: a ski area sees its own title for 2026.11.20, and no entry with nothing for it
//   8. STOP from a phone no list holds yet is remembered: a later import or notice never texts it
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
const { createMuniTenant } = require('./helpers/muni');

const PW = 'a-demo-password-1';
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const demo = `rev-demo-${suffix}`.slice(0, 40);
let server; let base; let T;
const tokens = {};

async function call(method, p, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(`${base}${p}`, { method, headers: { ...(raw ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, type: res.headers.get('content-type') || '' };
}
const api = (method, p, o) => call(method, `/api/v1${p}`, o);
const is = (r, want, why = '') => assert.ok((Array.isArray(want) ? want : [want]).includes(r.status), `${why} ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  execFileSync(process.execPath, [path.join(__dirname, '..', 'db', 'demo-municipal.js'), demo], { cwd: path.join(__dirname, '..'), env: { ...process.env, SEED_PASSWORD: PW }, timeout: 300000 });
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [demo]);
  T = Number(t.id);
  M.invalidate(T);
  for (const who of ['owner', 'manager', 'crew1', 'frontdesk']) {
    const r = await api('POST', '/auth/login', { body: { tenant: demo, login: who, password: PW } });
    assert.equal(r.status, 200, who);
    tokens[who] = r.body.token;
  }
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

// A key that names money, with a number in it. Hours, quantities, counts and rated flows are not money.
const MONEY_KEY = /(cents|cost|amount|price|wage|salary|pay_rate|book_value|spend|revenue|^rate$|_rate$|money)/i;
function moneyIn(value, at = '') {
  const out = [];
  if (Array.isArray(value)) value.forEach((v, i) => out.push(...moneyIn(v, `${at}[${i}]`)));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if ((MONEY_KEY.test(k) || (k === 'total' && /cost/i.test(at))) && (typeof v === 'number' || (typeof v === 'string' && /^-?\$?\d/.test(v)))) out.push(`${at}.${k}=${v}`);
      else out.push(...moneyIn(v, `${at}.${k}`));
    }
  } else if (typeof value === 'string' && /\$\d/.test(value)) out.push(`${at}="${value.slice(0, 60)}"`);
  return out;
}

test('1. money: the crew and the front desk never receive a cost, rate or total from any endpoint; a manager does', async () => {
  const mgr = tokens.manager;
  // What to ask about: the asset with the most work orders, a done work order with labor on it, a main break, a program.
  const [[asset]] = await pool.query('SELECT asset_id AS id FROM work_orders WHERE tenant_id = ? AND asset_id IS NOT NULL GROUP BY asset_id ORDER BY COUNT(*) DESC LIMIT 1', [T]);
  const [[wo]] = await pool.query('SELECT work_order_id AS id FROM work_order_labor WHERE tenant_id = ? ORDER BY id LIMIT 1', [T]);
  const [[brk]] = await pool.query('SELECT id FROM main_breaks WHERE tenant_id = ? LIMIT 1', [T]);
  const [[prog]] = await pool.query('SELECT id FROM asset_programs WHERE tenant_id = ? LIMIT 1', [T]);
  const [[part]] = await pool.query('SELECT id FROM parts WHERE tenant_id = ? LIMIT 1', [T]);
  const month = new Date().toISOString().slice(0, 7);
  const paths = [
    '/assets/register', `/assets/register/${asset.id}`, '/assets/overview', '/assets/lifecycle', '/assets/risk', '/assets/parts', `/assets/parts/${part.id}`,
    '/assets/purchase-orders', `/assets/work-orders/${wo.id}/costs`, '/assets/cost-pickers', '/assets/books', '/assets/labor-rates', `/assets/month-report?month=${month}`,
    '/ops/work-orders?status=open', '/ops/work-orders?status=closed&totals=1', `/ops/work-orders/${wo.id}`, '/ops/work-orders/map', '/ops/work-orders/today', '/ops/pm',
    '/assets/programs', `/assets/programs/${prog.id}`, '/water/main-breaks', `/water/main-breaks/${brk.id}`, '/water/mains',
    '/workforce/crew-board', '/workforce/my-day', '/workforce/overtime', '/jump?q=truck', '/jump?q=plow', '/jump?q=main',
    '/water/today', '/sewer/today', '/stormwater/today', '/assets/programs/today', '/ops/work-orders/export', `/assets/month-report.csv?month=${month}`,
    `/assets/programs/${prog.id}/export.csv`, '/water/main-breaks/export.csv', '/workforce/overtime/export',
  ];
  const leaks = [];
  for (const who of ['crew1', 'frontdesk']) {
    for (const p of paths) {
      const r = await api('GET', p, { token: tokens[who] });
      assert.ok(r.status < 500, `${who} ${p}: ${r.status}`);
      if (r.status >= 300) continue;
      if (typeof r.body === 'string') {
        const head = r.body.split('\n')[0];
        if (/(cost|cents|\brate\b|amount|price|\$)/i.test(head) || /\$\d/.test(r.body)) leaks.push(`${who} ${p}: ${head.slice(0, 120)}`);
      } else for (const m of moneyIn(r.body)) leaks.push(`${who} ${p} ${m}`);
    }
  }
  assert.deepEqual(leaks.slice(0, 40), [], `${leaks.length} money fields reach the crew or front desk`);
  // A manager still gets them: the job's labor cost and the asset's costs.
  const c = await api('GET', `/assets/work-orders/${wo.id}/costs`, { token: mgr });
  assert.equal(c.status, 200);
  assert.ok(moneyIn(c.body).length > 0, 'a manager sees the costs');
  const a = await api('GET', `/assets/register/${asset.id}`, { token: mgr });
  assert.ok(a.body.work_orders.some((w) => w.labor_cents > 0), 'a manager sees labor on the asset\'s work orders');
  // The crew still sees hours.
  const cc = await api('GET', `/assets/work-orders/${wo.id}/costs`, { token: tokens.crew1 });
  assert.equal(cc.status, 200);
  assert.ok(cc.body.labor_hours > 0, 'the crew sees the hours');
});

test('3. request numbers: 40 public reports at once across two municipalities all succeed, each numbered once and in order', async () => {
  const A = await createMuniTenant(base); const B = await createMuniTenant(base);
  const catOf = async (X) => (await api('GET', '/requests/meta', { token: X.token })).body.categories.find((c) => /pothole/i.test(c.name)).id;
  const [ca, cb] = [await catOf(A), await catOf(B)];
  const sends = [];
  for (let i = 0; i < 40; i += 1) {
    const X = i % 2 ? B : A;
    sends.push(api('POST', `/public/${X.slug}/report`, { body: { category_id: i % 2 ? cb : ca, cross_street: `Main Street at ${i + 1}th Avenue`, description: `Hole ${i}` }, headers: { 'x-forwarded-for': `10.9.${i}.1` } }));
  }
  const got = await Promise.all(sends);
  const bad = got.filter((r) => r.status !== 201 && r.status !== 200).map((r) => `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  assert.deepEqual(bad, [], 'every report is taken');
  for (const X of [A, B]) {
    const [list] = await pool.query("SELECT reference FROM requests WHERE tenant_id = ? AND source = 'web' ORDER BY id", [X.id]);
    const nums = list.map((r) => Number(r.reference.slice(2))).sort((x, y) => x - y);
    assert.equal(nums.length, 20);
    assert.deepEqual(nums, Array.from({ length: 20 }, (_, i) => 1001 + i), 'R-1001 to R-1020, none twice, none skipped');
  }
});

test('2 and 4. the water customer list: 30,000 rows in one import; account numbers kept as their last 4 only; a clear 413 above the limit', async () => {
  const W = await createMuniTenant(base, { modules: { water: true } });
  is(await api('POST', '/requests/streets/import', { token: W.token, body: { text: 'Market Street\nBridge Street' } }), [200, 201]);
  const lines = ['account_number,street,house_number,unit,phone,email'];
  for (let i = 0; i < 30000; i += 1) lines.push(`10-22${String(i).padStart(5, '0')},${i % 2 ? 'Market Street' : 'Bridge Street'},${100 + i},,,`);
  const csv = lines.join('\n');
  assert.ok(csv.length > 400 * 1024 && csv.length < 5_000_000, `${csv.length} bytes`);
  const r = await api('POST', '/street-notices/service-addresses/import', { token: W.token, body: { csv, file_name: 'billing.csv' } });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.equal(r.body.added, 30000);
  // Only the last 4 of each account number is kept, and that is all any endpoint gives.
  const [[full]] = await pool.query("SELECT COUNT(*) AS n FROM service_addresses WHERE tenant_id = ? AND (CHAR_LENGTH(account_number) > 4 OR account_number LIKE '%-%')", [W.id]);
  assert.equal(Number(full.n), 0, 'no whole account number is stored');
  const [[st]] = await pool.query("SELECT id FROM streets WHERE tenant_id = ? AND name = 'Market Street'", [W.id]);
  const list = await api('GET', `/street-notices/service-addresses?street_id=${st.id}`, { token: W.token });
  assert.equal(list.status, 200);
  const first = list.body.data.find((x) => x.house_number === '101');
  assert.equal(first.account_last4, '0001'); assert.equal(first.account_number, undefined);
  assert.ok(!JSON.stringify(list.body).includes('10-22'), 'no whole number in the list');
  // A second import of the same file matches every address by the hashed number: nothing new.
  const again = await api('POST', '/street-notices/service-addresses/import', { token: W.token, body: { csv: lines.slice(0, 101).join('\n') } });
  assert.equal(again.body.added, 0); assert.equal(again.body.updated, 100);
  // A row stored before this release (the whole number) is cut to the last 4 by the migration step.
  await pool.query("UPDATE service_addresses SET account_number = '10-2200007' WHERE tenant_id = ? AND house_number = '107'", [W.id]);
  const step = require('../db/steps/m2-release')({ tableExists: async () => true, columnExists: async () => true }).find((s) => /account_number/.test(s[0]));
  const conn = await pool.getConnection();
  try { assert.equal(await step[1](conn), false); await conn.query(step[2]); assert.equal(await step[1](conn), true); } finally { conn.release(); }
  const [[cut]] = await pool.query("SELECT account_number FROM service_addresses WHERE tenant_id = ? AND house_number = '107'", [W.id]);
  assert.equal(cut.account_number, '0007');
  // Above 5 MB: a plain 413, not a parse error.
  const big = await api('POST', '/street-notices/service-addresses/import', { token: W.token, body: { csv: `${csv}\n${'x'.repeat(6_500_000)}` } });
  assert.equal(big.status, 413);
  assert.match(big.body.error, /larger than 5 MB/);
});

test('5. Apps and add-ons: adding or removing one add-on keeps every other one on (trial, no charge, paid until a date, and a subscription)', async () => {
  const onOf = async (X) => (await api('GET', '/billing/apps', { token: X.token })).body.apps.filter((a) => a.on).map((a) => a.key);
  const savedAddons = async (X) => (await pool.query('SELECT addons FROM tenant_billing WHERE tenant_id = ?', [X.id]))[0][0].addons;
  const addonId = async (X, key) => (await api('GET', '/billing/apps', { token: X.token })).body.apps.find((a) => a.key === key).addon_id;
  const check = async (X, why) => {
    is(await api('POST', '/billing/apps', { token: X.token, body: { module: 'stormwater', on: true } }), 200, why);
    let on = await onOf(X);
    for (const k of ['water', 'sewer', 'stormwater']) assert.ok(on.includes(k), `${why}: ${k} on after adding Stormwater (${on})`);
    const ids = String(await savedAddons(X)).split(',').map(Number);
    for (const k of ['water', 'sewer', 'stormwater']) assert.ok(ids.includes(await addonId(X, k)), `${why}: the plan choice holds ${k}`);
    is(await api('POST', '/billing/apps', { token: X.token, body: { module: 'sewer', on: false } }), 200, why);
    on = await onOf(X);
    assert.ok(on.includes('water') && on.includes('stormwater') && !on.includes('sewer'), `${why}: only Sewer went (${on})`);
  };
  await check(await createMuniTenant(base, { billing: 'trial', modules: { water: true, sewer: true } }), 'trial');
  await check(await createMuniTenant(base, { modules: { water: true, sewer: true } }), 'no charge');
  // Paid until a date outside Stripe (an invoice): the apps follow the saved choice, which must hold the others.
  const P = await createMuniTenant(base, { modules: { water: true, sewer: true } });
  const plan = (await api('GET', '/billing/apps', { token: P.token })).body;
  is(await api('PUT', `/platform/tenants/${P.id}/billing`, { headers: { 'x-platform-key': process.env.BOOTSTRAP_KEY }, body: { comped: false, paid_until: '2030-01-01', interval: 'year' } }), 200);
  await check(P, 'paid until a date');
  assert.ok(plan);

  // A subscription: Stripe is asked for the plan and every add-on on, plus the one added (a stand-in for Stripe's API).
  const http = require('http');
  const posted = [];
  let n = 0;
  const fake = http.createServer((req, res) => {
    let data = ''; req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const url = req.url.split('?')[0]; const params = new URLSearchParams(data);
      const send = (b) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b)); };
      if (req.method === 'GET' && url.startsWith('/v1/subscriptions/')) return send({ id: 'sub_x', items: { data: [{ id: 'si_old' }] } });
      if (req.method === 'POST' && url.startsWith('/v1/subscriptions/')) { posted.push([...params.entries()]); return send({ id: 'sub_x', status: 'active' }); }
      if (url === '/v1/products') return send({ id: `prod_${++n}` });
      if (url === '/v1/prices') return send({ id: `price_${++n}` });
      return send({ id: `x_${++n}` });
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const config = require('../src/config');
  const saved = { ...config.stripe };
  const [plansBefore] = await pool.query('SELECT * FROM billing_plans');
  try {
    Object.assign(config.stripe, { apiBase: `http://127.0.0.1:${fake.address().port}`, secretKey: 'sk_test_x', webhookSecret: 'whsec_x' });
    const S = await createMuniTenant(base, { modules: { water: true, sewer: true } });
    const ids = { water: await addonId(S, 'water'), sewer: await addonId(S, 'sewer') };
    const [[core]] = await pool.query("SELECT id FROM billing_plans WHERE code = 'muni-core'");
    await pool.query("UPDATE tenant_billing SET comped = 0, plan_id = ?, addons = ?, billing_interval = 'year', stripe_subscription_id = 'sub_x', sub_status = 'active' WHERE tenant_id = ?", [core.id, `${ids.water},${ids.sewer}`, S.id]);
    is(await api('POST', '/billing/apps', { token: S.token, body: { module: 'stormwater', on: true } }), 200, 'subscription');
    const items = posted.at(-1).filter(([k]) => /^items\[\d+\]\[price\]$/.test(k));
    assert.equal(items.length, 4, `the plan and three add-ons: ${JSON.stringify(posted.at(-1))}`);
    const on = await onOf(S);
    for (const k of ['water', 'sewer', 'stormwater']) assert.ok(on.includes(k), `subscription: ${k} on (${on})`);
    is(await api('POST', '/billing/apps', { token: S.token, body: { module: 'water', on: false } }), 200);
    assert.equal(posted.at(-1).filter(([k]) => /^items\[\d+\]\[price\]$/.test(k)).length, 3, 'the plan, Sewer and Stormwater');
    const after = await onOf(S);
    assert.ok(!after.includes('water') && after.includes('sewer') && after.includes('stormwater'), String(after));
  } finally {
    Object.assign(config.stripe, saved);
    await new Promise((r) => fake.close(r));
    for (const p of plansBefore) await pool.query('UPDATE billing_plans SET stripe_product = ?, stripe_month = ?, stripe_month_cents = ?, stripe_year = ?, stripe_year_cents = ?, stripe_season = ?, stripe_season_cents = ? WHERE id = ?', [p.stripe_product, p.stripe_month, p.stripe_month_cents, p.stripe_year, p.stripe_year_cents, p.stripe_season, p.stripe_season_cents, p.id]);
  }
});
