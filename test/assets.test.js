'use strict';

// Assets and fleet (add-on): the register with tags, places and parts of parts; meters that only go up; fuel; papers that
// run out; inspections that open work orders; service plans by miles closed by their work order; parts, stock and
// purchase orders; labor and outside costs; lifecycle; and who may change money.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const modules = require('../src/lib/modules');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);

const T = {}; const D = {};
async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const owner = (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token;
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
  return { slug, owner, id: t.id };
}
const turnOn = async (m) => { await pool.query('INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE enabled = 1', [m.id, 'assets']); modules.invalidate(m.id); };

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  D.a = await mountain(`as-${suffix}`);
  D.b = await mountain(`bs-${suffix}`);
  T.owner = D.a.owner;
  ok(await api('POST', '/users', { token: T.owner, body: { email: `mech@${D.a.slug}.test`, password: PW, role: 'staff' } }));
  T.staff = (await api('POST', '/auth/login', { body: { tenant: D.a.slug, email: `mech@${D.a.slug}.test`, password: PW } })).body.token;
  ok(await api('POST', '/users', { token: T.owner, body: { email: `pat@${D.a.slug}.test`, password: PW, role: 'patrol' } }));
  T.patrol = (await api('POST', '/auth/login', { body: { tenant: D.a.slug, email: `pat@${D.a.slug}.test`, password: PW } })).body.token;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('the add-on is off until the operator turns it on, and patrol never uses it', async () => {
  const off = await api('GET', '/assets/register', { token: T.owner });
  is(off, 403);
  assert.equal(off.body.details.module, 'assets');
  await turnOn(D.a);
  ok(await api('GET', '/assets/register', { token: T.owner }));
  is(await api('GET', '/assets/register', { token: T.patrol }), 403, 'patrol');
});

test('the register: tags are given in order, places and parts of parts, papers that run out, money for managers only', async () => {
  const o = T.owner;
  const shop = ok(await api('POST', '/assets/locations', { token: o, body: { name: 'Vehicle shop', kind: 'shop' } })).id;
  D.vendor = ok(await api('POST', '/assets/vendors', { token: o, body: { name: 'Mountain Diesel Supply', phone: '555-0101' } })).id;
  is(await api('POST', '/assets/vendors', { token: T.staff, body: { name: 'Nope' } }), 403, 'vendors are a manager\'s');
  const truck = ok(await api('POST', '/assets/register', { token: o, body: { name: 'Plow truck 2', kind: 'truck', location_id: shop, model_year: 2019, vin: '1FTFW1E50KFA00001', plate: 'PA 12345', miles: 41250, hours: 0, purchased_on: '2019-10-01', purchase_cents: 5200000, useful_life_years: 8, salvage_cents: 800000, registration_expires: '2000-01-01', insurance_expires: '2099-01-01', critical: true } }));
  const lift = ok(await api('POST', '/assets/register', { token: o, body: { name: 'Summit chair drive', kind: 'lift_component', purchased_on: '2005-06-01', purchase_cents: 9000000, useful_life_years: 15 } }));
  const box = ok(await api('POST', '/assets/register', { token: T.staff, body: { name: 'Summit chair gearbox', kind: 'lift_component', parent_id: lift.id } }));
  is(await api('POST', '/assets/register', { token: T.staff, body: { name: 'Sneaky', kind: 'tool', purchase_cents: 100 } }), 403, 'staff do not set purchase cost');
  is(await api('PATCH', `/assets/register/${lift.id}`, { token: o, body: { parent_id: box.id } }), 400, 'no loops');
  is(await api('POST', '/assets/register', { token: o, body: { name: 'Dup tag', kind: 'tool', asset_tag: 'A-0001' } }), 409);
  const list = ok(await api('GET', '/assets/register', { token: o })).data;
  const t = list.find((x) => x.id === truck.id);
  assert.equal(t.asset_tag, 'A-0001');
  assert.equal(list.find((x) => x.id === box.id).asset_tag, 'A-0003');
  assert.equal(t.category, 'fleet');
  assert.equal(t.location, 'Vehicle shop');
  assert.deepEqual(t.papers.map((p) => [p.key, p.state]), [['registration_expires', 'expired'], ['insurance_expires', 'ok']]);
  assert.equal(list.find((x) => x.id === box.id).parent, 'Summit chair drive');
  assert.equal(ok(await api('GET', '/assets/tag/A-0002', { token: T.staff })).id, lift.id, 'a scanned tag finds the asset');
  const detail = ok(await api('GET', `/assets/register/${lift.id}`, { token: T.staff }));
  assert.equal(detail.children.length, 1);
  assert.equal(detail.purchase_cents, undefined, 'staff do not see what it cost');
  assert.ok(ok(await api('GET', `/assets/register/${lift.id}`, { token: o })).lifecycle.replace, 'a 2005 drive with a 15-year life is past it');
  // other mountains see nothing
  await turnOn(D.b);
  is(await api('GET', `/assets/register/${truck.id}`, { token: D.b.owner }), 404);
  is(await api('GET', '/assets/tag/A-0001', { token: D.b.owner }), 404);
  D.truck = truck.id; D.lift = lift.id; D.shop = shop;
});

test('meters only go up (a manager can correct), fuel records meters, and a service plan by miles is closed by its work order', async () => {
  const o = T.owner;
  is(await api('POST', `/assets/register/${D.truck}/meter`, { token: T.staff, body: { miles: 41000 } }), 400, 'going backwards');
  ok(await api('POST', `/assets/register/${D.truck}/meter`, { token: T.staff, body: { miles: 41500 } }));
  is(await api('POST', `/assets/register/${D.truck}/meter`, { token: T.staff, body: { miles: 41400, correct: true } }), 403);
  ok(await api('POST', `/assets/register/${D.truck}/meter`, { token: o, body: { miles: 41450, correct: true } }));
  ok(await api('POST', `/assets/register/${D.truck}/fuel`, { token: T.staff, body: { gallons: 22.5, cost_cents: 9000, miles: 41700, vendor_id: D.vendor } }));
  let a = ok(await api('GET', `/assets/register/${D.truck}`, { token: o }));
  assert.equal(a.miles, 41700);
  assert.deepEqual(a.meters.slice(0, 3).map((m) => [Number(m.value), m.source]), [[41700, 'fuel'], [41450, 'manual'], [41500, 'manual']], 'every reading is kept, newest first');
  assert.equal(a.fuel[0].fuel_type, null);

  const pm = ok(await api('POST', '/ops/pm', { token: o, body: { name: 'Oil and filter', asset_id: D.truck, interval_miles: 5000, checklist: 'Drain oil\nNew filter\nTop up' } })).id;
  await pool.query('UPDATE pm_tasks SET last_done_miles = 36000, last_done_on = NULL WHERE id = ?', [pm]);
  a = ok(await api('GET', `/assets/register/${D.truck}`, { token: o }));
  const plan = a.service.find((s) => s.id === pm);
  assert.equal(plan.state, 'overdue', '41700 is past 36000 + 5000');
  assert.equal(plan.miles_left, -700);
  const wo = ok(await api('POST', `/ops/pm/${pm}/work-order`, { token: o })).id;
  assert.equal(ok(await api('POST', `/ops/pm/${pm}/work-order`, { token: o })).id, wo, 'one open work order per plan');
  assert.match(ok(await api('GET', `/ops/work-orders/${wo}`, { token: o })).description, /New filter/);
  ok(await api('PATCH', `/assets/work-orders/${wo}/costs`, { token: T.staff, body: { meter_miles: 41720 } }));
  ok(await api('POST', `/ops/work-orders/${wo}/status`, { token: T.staff, body: { status: 'done', resolution: 'Oil and filter changed' } }));
  a = ok(await api('GET', `/assets/register/${D.truck}`, { token: o }));
  const after = a.service.find((s) => s.id === pm);
  assert.equal(Number(after.last_done_miles), 41720, 'completing the work order marked the plan done at the miles on the order');
  assert.equal(after.state, 'ok');
  assert.equal(a.miles, 41720);
  D.pmWo = wo;
});

test('an inspection must be answered in full; a failure opens a work order and flags the asset', async () => {
  const meta = ok(await api('GET', '/assets/meta', { token: T.staff }));
  const tpl = meta.templates.find((x) => x.name === 'Vehicle pre-trip');
  assert.ok(tpl && tpl.kinds.includes('truck'), 'the standard checklists are there');
  const answers = tpl.items.map((i) => ({ key: i.key, result: 'pass' }));
  is(await api('POST', `/assets/register/${D.truck}/inspections`, { token: T.staff, body: { template_id: tpl.id, items: answers.slice(1) } }), 400, 'every item');
  answers[0] = { key: answers[0].key, result: 'fail' };
  is(await api('POST', `/assets/register/${D.truck}/inspections`, { token: T.staff, body: { template_id: tpl.id, items: answers } }), 400, 'a failure needs a note');
  answers[0].note = 'Parking brake does not hold on the grade';
  const r = ok(await api('POST', `/assets/register/${D.truck}/inspections`, { token: T.staff, body: { template_id: tpl.id, items: answers, miles: 41730 } }));
  assert.equal(r.result, 'fail');
  const w = ok(await api('GET', `/ops/work-orders/${r.work_order_id}`, { token: T.staff }));
  assert.equal(w.priority, 'urgent', 'a critical asset gets an urgent work order');
  assert.match(w.description, /Parking brake/);
  const a = ok(await api('GET', `/assets/register/${D.truck}`, { token: T.staff }));
  assert.equal(a.status, 'needs_service');
  assert.equal(a.inspections[0].result, 'fail');
  assert.equal(a.miles, 41730);
  const p = ok(await api('POST', `/assets/register/${D.lift}/problem`, { token: T.staff, body: { title: 'Grinding noise from the drive', out_of_service: true } }));
  assert.equal(ok(await api('GET', `/assets/register/${D.lift}`, { token: T.staff })).status, 'out_of_service');
  assert.ok(p.id);
  D.brakeWo = r.work_order_id;
});

test('parts: stock moves are counted, issued to a work order at cost, returned, and bought on purchase orders', async () => {
  const o = T.owner;
  const pad = ok(await api('POST', '/assets/parts', { token: o, body: { sku: 'BP-114', name: 'Brake pads, front', unit: 'set', unit_cost_cents: 6500, qty_on_hand: 3, reorder_point: 2, reorder_qty: 4, vendor_id: D.vendor, location_id: D.shop, bin: 'B2' } })).id;
  is(await api('POST', '/assets/parts', { token: o, body: { sku: 'BP-114', name: 'Dup' } }), 409);
  is(await api('PATCH', `/assets/parts/${pad}`, { token: T.staff, body: { unit_cost_cents: 1 } }), 403, 'costs are a manager\'s');
  is(await api('POST', `/assets/work-orders/${D.brakeWo}/parts`, { token: T.staff, body: { part_id: pad, qty: 5 } }), 400, 'not that many on hand');
  ok(await api('POST', `/assets/work-orders/${D.brakeWo}/parts`, { token: T.staff, body: { part_id: pad, qty: 2 } }));
  is(await api('POST', `/assets/work-orders/${D.brakeWo}/parts`, { token: T.staff, body: { part_id: pad, qty: -3 } }), 400, 'cannot return more than was used');
  ok(await api('POST', `/assets/work-orders/${D.brakeWo}/parts`, { token: T.staff, body: { part_id: pad, qty: -1 } }));
  let p = ok(await api('GET', `/assets/parts/${pad}`, { token: T.staff }));
  assert.equal(p.qty_on_hand, 2);
  assert.equal(p.low, true, 'at the reorder point');
  ok(await api('POST', `/assets/work-orders/${D.brakeWo}/labor`, { token: T.staff, body: { worker: 'Sam Mechanic', hours: 1.5 } }));
  ok(await api('PUT', '/assets/settings', { token: o, body: { labor_rate_cents: 6000 } }));
  ok(await api('POST', `/assets/work-orders/${D.brakeWo}/labor`, { token: T.staff, body: { worker: 'Sam Mechanic', hours: 0.5 } }));
  is(await api('PATCH', `/assets/work-orders/${D.brakeWo}/costs`, { token: T.staff, body: { vendor_cost_cents: 100 } }), 403);
  ok(await api('PATCH', `/assets/work-orders/${D.brakeWo}/costs`, { token: o, body: { vendor_id: D.vendor, vendor_cost_cents: 12000 } }));
  const c = ok(await api('GET', `/assets/work-orders/${D.brakeWo}/costs`, { token: T.staff }));
  assert.equal(c.labor_cents, 1.5 * 4500 + 0.5 * 6000, 'each labor entry keeps the rate of its day');
  assert.equal(c.parts_cents, 6500);
  assert.equal(c.total_cents, 6750 + 3000 + 6500 + 12000);
  assert.equal(Number(ok(await api('GET', `/ops/work-orders/${D.brakeWo}`, { token: T.staff })).labor_hours), 2);

  // purchase orders: draft from the reorder list, order, receive in two parts
  is(await api('POST', '/assets/purchase-orders/reorder', { token: T.staff, body: { vendor_id: D.vendor } }), 403);
  const po = ok(await api('POST', '/assets/purchase-orders/reorder', { token: o, body: { vendor_id: D.vendor } }));
  assert.equal(po.po_number, 1001);
  let full = ok(await api('GET', `/assets/purchase-orders/${po.id}`, { token: o }));
  assert.equal(full.lines[0].qty, 4);
  is(await api('POST', `/assets/purchase-orders/${po.id}/receive`, { token: T.staff, body: { lines: [{ line_id: full.lines[0].id, qty: 1 }] } }), 409, 'order it first');
  ok(await api('PUT', `/assets/purchase-orders/${po.id}`, { token: o, body: { vendor_id: D.vendor, lines: [{ part_id: pad, qty: 4, unit_cost_cents: 7000 }, { description: 'Shop rags, box', qty: 1, unit_cost_cents: 2500 }] } }));
  ok(await api('POST', `/assets/purchase-orders/${po.id}/order`, { token: o }));
  is(await api('PUT', `/assets/purchase-orders/${po.id}`, { token: o, body: { vendor_id: D.vendor, lines: [{ part_id: pad, qty: 1 }] } }), 409, 'ordered: no more changes');
  full = ok(await api('GET', `/assets/purchase-orders/${po.id}`, { token: o }));
  assert.equal(full.total_cents, 4 * 7000 + 2500);
  const [padLine, rags] = full.lines;
  is(await api('POST', `/assets/purchase-orders/${po.id}/receive`, { token: T.staff, body: { lines: [{ line_id: padLine.id, qty: 5 }] } }), 400, 'more than ordered');
  assert.equal(ok(await api('POST', `/assets/purchase-orders/${po.id}/receive`, { token: T.staff, body: { lines: [{ line_id: padLine.id, qty: 3 }] } })).status, 'partial');
  is(await api('POST', `/assets/purchase-orders/${po.id}/cancel`, { token: o }), 409, 'something already arrived');
  assert.equal(ok(await api('POST', `/assets/purchase-orders/${po.id}/receive`, { token: T.staff, body: { lines: [{ line_id: padLine.id, qty: 1 }, { line_id: rags.id, qty: 1 }] } })).status, 'received');
  p = ok(await api('GET', `/assets/parts/${pad}`, { token: o }));
  assert.equal(p.qty_on_hand, 6);
  assert.equal(p.unit_cost_cents, 7000, 'the part now costs what was last paid');
  ok(await api('POST', `/assets/parts/${pad}/stock`, { token: T.staff, body: { count: 5, note: 'Shelf count' } }));
  is(await api('POST', `/assets/parts/${pad}/stock`, { token: T.staff, body: { change: -9, note: 'Lost' } }), 400);
  assert.equal(ok(await api('GET', `/assets/parts/${pad}`, { token: o })).moves[0].kind, 'count');
});

test('the overview and the lifecycle report add it all up; staff do not see the money', async () => {
  const o = T.owner;
  const ov = ok(await api('GET', '/assets/overview', { token: o }));
  assert.ok(ov.counts.assets >= 3);
  assert.ok(ov.papers_due.some((p) => p.key === 'registration_expires' && p.state === 'expired'));
  assert.ok(ov.replace.some((r) => r.id === D.lift));
  assert.ok(ov.spend_month_cents > 0);
  const st = ok(await api('GET', '/assets/overview', { token: T.staff }));
  assert.equal(st.spend_month_cents, null);
  assert.deepEqual(st.replace, []);
  is(await api('GET', '/assets/lifecycle', { token: T.staff }), 403);
  const lc = ok(await api('GET', '/assets/lifecycle', { token: o })).data.find((x) => x.id === D.truck);
  assert.equal(lc.parts, 6500);
  assert.equal(lc.fuel, 9000);
  assert.equal(lc.vendor, 12000);
  assert.ok(lc.cost_per_mile_cents >= 0);
  assert.ok(lc.book_value_cents < 5200000 && lc.book_value_cents >= 800000, 'depreciated, never below salvage');
  const csv = await fetch(`${base}/api/v1/assets/lifecycle?format=csv`, { headers: { authorization: `Bearer ${o}` } });
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /^tag,name,category/);
});

test('review fixes: no price leaks, a plan marked once per order, returns at issue cost, places in a loop, miles from the first reading', async () => {
  const o = T.owner; const s = T.staff;
  // prices: the crew does not see purchase prices anywhere, including the older Maintenance routes
  assert.equal(ok(await api('GET', '/assets/register', { token: s })).data.find((a) => a.id === D.truck).purchase_cents, undefined);
  assert.ok(ok(await api('GET', '/assets/register', { token: o })).data.find((a) => a.id === D.truck).purchase_cents > 0);
  const core = ok(await api('GET', '/ops/assets', { token: T.patrol })).data.find((a) => a.id === D.truck);
  assert.equal(core.purchase_cents, undefined); assert.equal(core.vin, undefined);
  assert.equal(ok(await api('GET', `/ops/work-orders/${D.brakeWo}`, { token: T.patrol })).vendor_cost_cents, undefined);
  is(await api('POST', '/assets/parts', { token: s, body: { sku: 'X-1', name: 'Priced by crew', unit_cost_cents: 100 } }), 403);
  is(await api('POST', '/assets/parts/1/stock', { token: s, body: { change: 0.005, note: 'Too fine' } }), 400, '2 decimal places');

  // a preventive order reopened and completed again does not mark the plan twice
  const logs = async () => (await pool.query('SELECT COUNT(*) AS n FROM pm_log WHERE work_order_id = ?', [D.pmWo]))[0][0].n;
  assert.equal(Number(await logs()), 1);
  ok(await api('POST', `/ops/work-orders/${D.pmWo}/status`, { token: s, body: { status: 'open' } }));
  ok(await api('POST', `/ops/work-orders/${D.pmWo}/status`, { token: s, body: { status: 'done' } }));
  assert.equal(Number(await logs()), 1);

  // a return is credited at what the part cost when issued, not at today's price
  const bolt = ok(await api('POST', '/assets/parts', { token: o, body: { sku: `BOLT-${suffix}`, name: 'Bolt', unit_cost_cents: 1000, qty_on_hand: 5 } })).id;
  ok(await api('POST', `/assets/work-orders/${D.brakeWo}/parts`, { token: s, body: { part_id: bolt, qty: 2 } }));
  ok(await api('PATCH', `/assets/parts/${bolt}`, { token: o, body: { unit_cost_cents: 1500 } }));
  ok(await api('POST', `/assets/work-orders/${D.brakeWo}/parts`, { token: s, body: { part_id: bolt, qty: -1 } }));
  const c = ok(await api('GET', `/assets/work-orders/${D.brakeWo}/costs`, { token: s }));
  assert.equal(c.parts.find((p) => p.part_id === bolt).cost, 1000);
  // parts come back off a canceled order, but nothing new goes on it
  ok(await api('POST', `/ops/work-orders/${D.brakeWo}/status`, { token: o, body: { status: 'cancelled' } }));
  ok(await api('POST', `/assets/work-orders/${D.brakeWo}/parts`, { token: s, body: { part_id: bolt, qty: -1 } }));
  is(await api('POST', `/assets/work-orders/${D.brakeWo}/parts`, { token: s, body: { part_id: bolt, qty: 1 } }), 409);
  is(await api('POST', `/assets/work-orders/${D.brakeWo}/labor`, { token: s, body: { worker: 'Sam', hours: 1 } }), 409);

  // places cannot sit inside each other
  const x = ok(await api('POST', '/assets/locations', { token: s, body: { name: `Yard ${suffix}`, kind: 'yard' } })).id;
  const y = ok(await api('POST', '/assets/locations', { token: s, body: { name: `Bay ${suffix}`, kind: 'shop', parent_id: x } })).id;
  is(await api('PATCH', `/assets/locations/${x}`, { token: s, body: { parent_id: y } }), 400);

  // a miles plan done before the odometer was known counts from the first reading
  const van = ok(await api('POST', '/assets/register', { token: o, body: { name: `Van ${suffix}`, kind: 'truck' } })).id;
  const plan = ok(await api('POST', '/ops/pm', { token: o, body: { name: 'Van oil', asset_id: van, interval_miles: 5000 } })).id;
  ok(await api('POST', `/ops/pm/${plan}/done`, { token: o, body: {} }));
  ok(await api('POST', `/assets/register/${van}/meter`, { token: s, body: { miles: 40000 } }));
  ok(await api('POST', `/assets/register/${van}/meter`, { token: s, body: { miles: 45500 } }));
  assert.equal(ok(await api('GET', `/assets/register/${van}`, { token: o })).service.find((p) => p.id === plan).state, 'overdue');

  // a name that a spreadsheet would run as a formula goes out as text
  ok(await api('PATCH', `/assets/register/${van}`, { token: s, body: { name: '=HYPERLINK("x")' } }));
  const csv = await (await fetch(`${base}/api/v1/assets/lifecycle?format=csv`, { headers: { authorization: `Bearer ${o}` } })).text();
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
});
