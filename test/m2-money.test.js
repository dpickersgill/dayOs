'use strict';

// What public works costs, and the monthly report (release 2026.11.20, workstream "money"): departments and funds made
// for a municipality and never for a ski area; work orders take theirs from the asset, the map item, the request or the
// place; Mark done records each person's hours at their own rate, equipment hours, parts from stock, one-off materials and
// the outside bill in one go; the crew never sees a person's rate; the Done tab filters by date and adds up; the asset's
// Costs tab shows real numbers; the monthly report adds up by department, fund and street (Liquid Fuels), leaves out
// residents' contact details and house numbers, and is a manager's; each municipality sees only its own.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.USERS_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { createMuniTenant } = require('./helpers/muni');

const KEY = 'test-bootstrap-key';
const PW = 'correct-horse-battery';
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
let server; let base;
const q = async (sql, params) => (await pool.query(sql, params))[0];
async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${r.text}`);
const todayNY = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

let A; let B; let skiToken; let crew; let mgr;
const staff = {}; const streets = {};
/** A staff record (person + staff) for a login, so its hours are this person's. */
async function staffFor(m, userId, first, last) {
  const [p] = await pool.query('INSERT INTO people (tenant_id, first_name, last_name) VALUES (?, ?, ?)', [m.id, first, last]);
  const [s] = await pool.query("INSERT INTO staff (tenant_id, person_id, status) VALUES (?, ?, 'active')", [m.id, p.insertId]);
  if (userId) await pool.query('UPDATE users SET staff_id = ?, person_id = ? WHERE tenant_id = ? AND id = ?', [s.insertId, p.insertId, m.id, userId]);
  return Number(s.insertId);
}

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await createMuniTenant(base, { slug: `mo-a-${suffix}`, modules: { water: true, sewer: true } });
  B = await createMuniTenant(base, { slug: `mo-b-${suffix}` });
  for (const name of ['Main Street', 'Bridge Street', 'Church Street']) { const r = await q('INSERT INTO streets (tenant_id, name) VALUES (?, ?)', [A.id, name]); streets[name] = Number(r.insertId); }
  const c = await A.addLogin('staff'); const m = await A.addLogin('manager');
  staff.luis = await staffFor(A, c.id, 'Luis', 'Ortega');
  staff.kevin = await staffFor(A, null, 'Kevin', 'Brandt');
  crew = { ...c, token: await A.login(c.username) };
  mgr = m;
  const res = await fetch(`${base}/api/v1/platform/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-platform-key': KEY },
    body: JSON.stringify({ slug: `mo-ski-${suffix}`, name: `Pine Ridge ${suffix}`, billing: 'comped', modules: { assets: true }, owner: { email: `gm@mo-ski-${suffix}.test`, password: PW, first_name: 'G', last_name: 'M' } }) });
  assert.equal(res.status, 201, await res.text());
  skiToken = (await call('POST', '/auth/login', { body: { tenant: `mo-ski-${suffix}`, login: `gm@mo-ski-${suffix}.test`, password: PW } })).body.token;
});
test.after(async () => { server.close(); await pool.end(); });

let truck; let loader; let part; let valve;
test('departments and funds: made for a municipality, never for a ski area; managers change them', async () => {
  const b = await call('GET', '/assets/books', { token: A.token });
  is(b, 200);
  assert.deepEqual(b.body.departments.map((d) => d.name), ['Streets', 'Water', 'Sewer', 'Stormwater', 'Sanitation', 'Parks', 'Buildings', 'Fleet']);
  assert.deepEqual(b.body.funds.map((f) => f.name), ['General', 'Water', 'Sewer', 'Sanitation', 'Liquid Fuels', 'Capital']);
  assert.equal(b.body.departments.find((d) => d.name === 'Water').fund, 'Water');
  assert.equal(b.body.funds.find((f) => f.name === 'Liquid Fuels').kind, 'liquid_fuels');
  // Calling again makes nothing twice.
  is(await call('GET', '/assets/books', { token: A.token }), 200);
  assert.equal((await q('SELECT COUNT(*) AS n FROM departments WHERE tenant_id = ?', [A.id]))[0].n, 8);
  // Streets road work goes to Liquid Fuels in this borough.
  const lf = b.body.funds.find((f) => f.name === 'Liquid Fuels').id;
  const streetsDept = b.body.departments.find((d) => d.name === 'Streets').id;
  is(await call('PATCH', `/assets/departments/${streetsDept}`, { token: mgr.token, body: { fund_id: lf } }), 200);
  is(await call('PATCH', `/assets/departments/${streetsDept}`, { token: crew.token, body: { fund_id: lf } }), 403, 'crew');
  is(await call('POST', '/assets/departments', { token: mgr.token, body: { name: 'Water' } }), 409, 'same name');
  is(await call('POST', '/assets/funds', { token: mgr.token, body: { name: 'Highway Aid', code: '35', liquid_fuels: true } }), 201);
  is(await call('PATCH', `/assets/departments/${streetsDept}`, { token: B.token, body: { name: 'Mine' } }), 404, 'other municipality');
  // A ski area has none of it, and its own work orders are left as they were.
  is(await call('GET', '/assets/books', { token: skiToken }), 404);
  is(await call('GET', '/assets/month-report?month=2026-10', { token: skiToken }), 404);
  const skiTenant = (await q('SELECT id FROM tenants WHERE slug = ?', [`mo-ski-${suffix}`]))[0].id;
  assert.equal((await q('SELECT COUNT(*) AS n FROM departments WHERE tenant_id = ?', [skiTenant]))[0].n, 0);
});

test('assets: department, fund and hourly rate are a manager\'s; a suggested rate when none is set', async () => {
  const b = (await call('GET', '/assets/books', { token: A.token })).body;
  const fleet = b.departments.find((d) => d.name === 'Fleet').id;
  is(await call('POST', '/assets/register', { token: crew.token, body: { name: 'Plow 1', kind: 'truck', hourly_rate_cents: 8500 } }), 403);
  const t = await call('POST', '/assets/register', { token: mgr.token, body: { name: 'Plow 1', kind: 'truck', hourly_rate_cents: 8500, department_id: fleet } });
  is(t, 201); truck = t.body.id;
  const l = await call('POST', '/assets/register', { token: mgr.token, body: { name: 'Jet-Vac 1', kind: 'truck' } });
  is(l, 201); loader = l.body.id;
  const reg = (await call('GET', `/assets/register/${loader}`, { token: mgr.token })).body;
  assert.equal(reg.suggested_rate_cents, 15000, 'a jet-vac suggests $150 an hour');
  assert.equal((await call('GET', `/assets/register/${truck}`, { token: crew.token })).body.hourly_rate_cents, undefined, 'crew does not see the rate');
  is(await call('POST', '/assets/register', { token: mgr.token, body: { name: 'Bad', kind: 'truck', department_id: 999999999 } }), 404);
  const p = await call('POST', '/assets/parts', { token: mgr.token, body: { sku: 'CP-50', name: 'Cold patch, 50 lb bag', unit: 'bag', unit_cost_cents: 1450, qty_on_hand: 40 } });
  is(p, 201); part = p.body.id;
  const f = await call('POST', '/assets/map/features', { token: mgr.token, body: { kind: 'valve', tag: 'V-1', points: [[40.1, -75.5]] } });
  is(f, 201, 'valve'); valve = f.body.id;
});

let woValve; let woRoad; let woTruck;
test('work orders take their department, fund and street from the asset, the map item and the place', async () => {
  const b = (await call('GET', '/assets/books', { token: A.token })).body;
  const id = (name) => b.departments.find((d) => d.name === name).id;
  woValve = (await call('POST', '/ops/work-orders', { token: crew.token, body: { title: 'Valve box broken', map_feature_id: valve } })).body.id;
  woRoad = (await call('POST', '/ops/work-orders', { token: crew.token, body: { title: 'Patch potholes', location: 'Bridge Street, 200 to 400 block' } })).body.id;
  woTruck = (await call('POST', '/ops/work-orders', { token: crew.token, body: { title: 'Plow 1 hydraulic leak', asset_id: truck } })).body.id;
  const v = (await call('GET', `/ops/work-orders/${woValve}`, { token: crew.token })).body;
  assert.equal(v.department, 'Water'); assert.equal(v.fund, 'Water');
  const r = (await call('GET', `/ops/work-orders/${woRoad}`, { token: crew.token })).body;
  assert.equal(r.department, 'Streets'); assert.equal(r.fund, 'Liquid Fuels'); assert.equal(r.street, 'Bridge Street');
  const tk = (await call('GET', `/ops/work-orders/${woTruck}`, { token: crew.token })).body;
  assert.equal(tk.department, 'Fleet'); assert.equal(tk.fund, 'General');
  // Crew cannot move it to another department; a manager can, and it stays where they put it.
  is(await call('PATCH', `/ops/work-orders/${woTruck}`, { token: crew.token, body: { department_id: id('Water') } }), 403);
  is(await call('PATCH', `/ops/work-orders/${woTruck}`, { token: mgr.token, body: { department_id: id('Fleet') } }), 200);
  // Made some other way (SQL, as a program or notice might): filled in the first time the list is read.
  const [x] = await pool.query("INSERT INTO work_orders (tenant_id, title, location, source, opened_by) VALUES (?, 'Sewer smell', 'Church Street at Main Street', 'manual', ?)", [A.id, mgr.id]);
  const list = (await call('GET', '/ops/work-orders?status=open', { token: mgr.token })).body.data;
  const made = list.find((w) => w.id === Number(x.insertId));
  assert.equal(made.department, 'Sewer'); assert.equal(made.street, 'Church Street');
});

test('labor rates are a manager\'s; Mark done records crew hours, equipment, parts, materials and outside work at once', async () => {
  is(await call('PUT', `/assets/labor-rates/${staff.luis}`, { token: crew.token, body: { rate_cents: 3800 } }), 403);
  is(await call('PUT', `/assets/labor-rates/${staff.luis}`, { token: mgr.token, body: { rate_cents: 3800 } }), 200);
  is(await call('PUT', `/assets/labor-rates/${staff.kevin}`, { token: mgr.token, body: { rate_cents: 3200 } }), 200);
  const rates = (await call('GET', '/assets/labor-rates', { token: mgr.token })).body;
  assert.equal(rates.data.find((r) => r.staff_id === staff.luis).rate_cents, 3800);
  is(await call('GET', '/assets/labor-rates', { token: crew.token }), 403);
  is(await call('PUT', `/assets/labor-rates/${staff.luis}`, { token: B.token, body: { rate_cents: 1 } }), 404, 'other municipality');

  // Crew cannot record the outside bill.
  is(await call('POST', `/assets/work-orders/${woRoad}/complete`, { token: crew.token, body: { resolution: 'x', vendor_cost_cents: 100 } }), 403);
  // Not enough in stock: nothing is saved.
  is(await call('POST', `/assets/work-orders/${woRoad}/complete`, { token: crew.token, body: { resolution: 'Filled', labor: [{ staff_id: staff.luis, hours: 2 }], parts: [{ part_id: part, qty: 400 }] } }), 400);
  assert.equal((await q('SELECT COUNT(*) AS n FROM work_order_labor WHERE tenant_id = ? AND work_order_id = ?', [A.id, woRoad]))[0].n, 0, 'all or nothing');
  const done = await call('POST', `/assets/work-orders/${woRoad}/complete`, { token: crew.token, body: {
    resolution: 'Eleven potholes filled with cold patch.',
    labor: [{ staff_id: staff.luis, hours: 3 }, { staff_id: staff.kevin, hours: 3 }],
    equipment: [{ asset_id: truck, hours: 2.5 }],
    parts: [{ part_id: part, qty: 6 }],
    materials: [{ description: 'Tack coat', qty: 2, unit: 'gal', unit_cost_cents: 1800 }],
  } });
  is(done, 200);
  assert.equal(done.body.labor_hours, 6);
  assert.equal(done.body.total_cents, undefined, 'crew sees hours, not the cost');
  assert.equal(Number((await q('SELECT qty_on_hand FROM parts WHERE id = ?', [part]))[0].qty_on_hand), 34, 'stock went down');
  is(await call('POST', `/assets/work-orders/${woRoad}/complete`, { token: crew.token, body: { resolution: 'again' } }), 409, 'already done');
  // 3 h x $38 + 3 h x $32 + 2.5 h x $85 + 6 x $14.50 + 2 x $18 = 114 + 96 + 212.50 + 87 + 36 = $545.50
  const m = (await call('GET', `/assets/work-orders/${woRoad}/costs`, { token: mgr.token })).body;
  assert.equal(m.total_cents, 54550);
  assert.equal(m.labor_cents, 21000); assert.equal(m.equipment_cents, 21250); assert.equal(m.parts_cents, 8700); assert.equal(m.materials_cents, 3600);
  const c = (await call('GET', `/assets/work-orders/${woRoad}/costs`, { token: crew.token })).body;
  assert.equal(c.labor_cents, undefined); assert.equal(c.total_cents, undefined); // no money at all for the crew (2026.11.20)
  assert.ok(c.labor.every((l) => l.rate_cents === undefined), 'a person\'s rate is pay');
  assert.equal(c.labor_hours, 6);

  // A manager closes the truck repair with an outside bill and time out of service.
  const vendor = (await call('POST', '/assets/vendors', { token: mgr.token, body: { name: 'County Truck Service' } })).body.id;
  is(await call('POST', `/assets/work-orders/${woTruck}/complete`, { token: mgr.token, body: { resolution: 'Hose replaced.', labor: [{ worker: 'Tom (mechanic)', hours: 1.5 }], vendor_id: vendor, vendor_cost_cents: 42000, downtime_hours: 36 } }), 200);
  const tc = (await call('GET', `/assets/work-orders/${woTruck}/costs`, { token: mgr.token })).body;
  assert.equal(tc.total_cents, 42000 + 1.5 * 4500, 'a helper without a rate is at the shop rate');
  // Lines are kept to this municipality.
  is(await call('POST', `/assets/work-orders/${woValve}/equipment`, { token: B.token, body: { asset_id: truck, hours: 1 } }), 404);
  is(await call('POST', `/assets/work-orders/${woValve}/materials`, { token: crew.token, body: { description: 'Valve box lid', qty: 1, unit_cost_cents: 6500 } }), 201);
  const e = await call('POST', `/assets/work-orders/${woValve}/equipment`, { token: crew.token, body: { asset_id: loader, hours: 1 } });
  is(e, 201);
  assert.equal((await q('SELECT rate_cents FROM work_order_equipment WHERE id = ?', [e.body.id]))[0].rate_cents, 15000, 'the suggested rate when none is set');
  is(await call('DELETE', `/assets/work-orders/${woValve}/equipment/${e.body.id}`, { token: crew.token }), 204);
});

test('the asset\'s Costs tab and the Done tab show real numbers', async () => {
  const lc = (await call('GET', '/assets/lifecycle', { token: mgr.token })).body.data.find((a) => a.id === truck);
  assert.equal(lc.vendor, 42000); assert.ok(lc.labor > 0, 'labor on its repair');
  const today = todayNY();
  const d = await call('GET', `/ops/work-orders?status=closed&from=${today}&to=${today}&totals=1`, { token: mgr.token });
  is(d, 200);
  assert.equal(d.body.totals.count, 2); assert.equal(d.body.totals.labor_hours, 7.5); assert.equal(d.body.totals.cost_cents, 54550 + 42000 + 6750);
  const crewView = (await call('GET', `/ops/work-orders?status=closed&from=${today}&to=${today}&totals=1`, { token: crew.token })).body;
  assert.equal(crewView.totals.cost_cents, undefined); assert.equal(crewView.totals.labor_hours, 7.5, "the crew sees the hours"); assert.equal(crewView.data[0].cost_cents, undefined);
  assert.equal((await call('GET', '/ops/work-orders?status=closed&from=2000-01-01&to=2000-01-31&totals=1', { token: mgr.token })).body.totals.count, 0);
  is(await call('GET', '/ops/work-orders?status=closed&from=yesterday', { token: mgr.token }), 400);
});

test('the monthly report: by department, fund and street, a public record, a manager\'s', async () => {
  // A resident request with a house number and the resident's name, made into a work order and completed.
  await call('GET', '/requests/meta', { token: A.token });
  const cat = (await q("SELECT id FROM request_categories WHERE tenant_id = ? AND name = 'Pothole'", [A.id]))[0].id;
  const rq = await call('POST', '/requests', { token: A.token, body: { category_id: Number(cat), street_id: streets['Main Street'], house_number: '417', description: 'Pothole outside my house', contact: { name: 'Rae Unique-Resident', phone: '610-555-0199' } } });
  is(rq, 201);
  const wo = await call('POST', `/requests/${rq.body.id}/work-order`, { token: A.token, body: {} });
  is(wo, 201);
  is(await call('POST', `/assets/work-orders/${wo.body.work_order_id}/complete`, { token: crew.token, body: { resolution: 'Filled the pothole at 417 Main Street.', labor: [{ staff_id: staff.luis, hours: 1 }] } }), 200);
  const month = todayNY().slice(0, 7);
  is(await call('GET', `/assets/month-report?month=${month}`, { token: crew.token }), 403);
  is(await call('GET', '/assets/month-report?month=2026-13', { token: mgr.token }), 400);
  const r = (await call('GET', `/assets/month-report?month=${month}`, { token: mgr.token })).body;
  const streetsRow = r.by_department.find((d) => d.name === 'Streets');
  assert.equal(streetsRow.total_cents, 54550 + 3800);
  assert.equal(r.by_department.find((d) => d.name === 'Fleet').total_cents, 48750);
  assert.equal(r.by_fund.find((f) => f.name === 'Liquid Fuels').total_cents, 54550 + 3800);
  assert.equal(r.totals.closed, 3);
  assert.ok(r.requests.received >= 1);
  assert.equal(r.requests.top_streets[0].street, 'Main Street');
  const lf = r.liquid_fuels.streets;
  assert.deepEqual(lf.map((s) => s.street), ['Bridge Street', 'Main Street']);
  assert.equal(lf[0].total_cents, 54550);
  assert.equal(r.highlights[0].work_order_id, woRoad);
  const pothole = r.highlights.find((h) => h.work_order_id === wo.body.work_order_id);
  assert.equal(pothole.title, 'Pothole, Main Street');
  const fleet = r.fleet.find((a) => a.id === truck);
  assert.equal(fleet.out_of_service_days, 1.5); assert.equal(fleet.job_hours, 2.5);
  const all = JSON.stringify(r);
  assert.ok(!all.includes('417'), 'no house number'); assert.ok(!all.includes('Unique-Resident'), 'no resident name'); assert.ok(!all.includes('555-0199'), 'no phone');
  const csv = await fetch(`${base}/api/v1/assets/month-report.csv?month=${month}`, { headers: { authorization: `Bearer ${mgr.token}` } });
  assert.equal(csv.status, 200);
  const text = await csv.text();
  assert.match(text, /"Liquid Fuels by street, year to date","Bridge Street"/);
  assert.ok(!text.includes('417') && !text.includes('Unique-Resident'));
  // Another municipality sees its own empty month.
  const rb = (await call('GET', `/assets/month-report?month=${month}`, { token: B.token })).body;
  assert.equal(rb.totals.closed, 0); assert.equal(rb.highlights.length, 0);
  assert.ok((await q("SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ? AND action = 'export' AND entity = 'work_orders'", [A.id]))[0].n >= 1);
});
