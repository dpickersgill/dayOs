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
