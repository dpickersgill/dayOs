'use strict';

// Mountain operations: grooming, snow and weather, snowmaking, fleet, work orders, recurring jobs, lift inspections, downtime, handoffs and the daily report.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const day = (offset) => fmt.format(new Date(Date.now() + offset * 86400000));
const today = day(0); const yesterday = day(-1);

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r, status) => { assert.equal(r.status, status ?? (r.status < 300 ? r.status : -1), JSON.stringify(r.body)); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);

async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201, await res.text());
  return { slug, owner: (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token };
}
const login = async (m, email) => (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token;

let A; let B; const T = {}; const D = {};

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`op-${suffix}`); B = await mountain(`ob-${suffix}`);
  for (const role of ['staff', 'counter', 'patrol', 'manager']) {
    ok(await api('POST', '/users', { token: A.owner, body: { email: `${role}@${A.slug}.test`, password: PW, role } }), 201);
    T[role] = await login(A, `${role}@${A.slug}.test`);
  }
  D.t1 = ok(await api('POST', '/schedule/trails', { token: T.manager, body: { name: 'Upper Run', difficulty: 'blue' } }), 201).id;
  D.t2 = ok(await api('POST', '/schedule/trails', { token: T.manager, body: { name: 'Lower Run', difficulty: 'green' } }), 201).id;
  D.lift = ok(await api('POST', '/schedule/lifts', { token: T.manager, body: { name: 'Summit Chair', status: 'closed' } }), 201).id;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('the fleet, with the meter only going up and a counter login kept out', async () => {
  is(await api('GET', '/ops/assets', { token: T.counter }), 403);
  D.groomer = ok(await api('POST', '/ops/assets', { token: T.staff, body: { name: 'PistenBully 1', kind: 'groomer', hours: 1200 } }), 201).id;
  is(await api('POST', '/ops/assets', { token: T.staff, body: { name: 'PistenBully 1', kind: 'groomer' } }), 409);
  is(await api('POST', '/ops/assets', { token: T.staff, body: { name: 'X', kind: 'spaceship' } }), 400);
  is(await api('POST', `/ops/assets/${D.groomer}/hours`, { token: T.staff, body: { hours: 1100 } }), 400, 'meter cannot go back');
  ok(await api('POST', `/ops/assets/${D.groomer}/hours`, { token: T.staff, body: { hours: 1210.5 } }));
  assert.equal(ok(await api('GET', '/ops/assets', { token: T.patrol })).data[0].hours, 1210.5);
  is(await api('POST', `/ops/assets/${D.groomer}/hours`, { token: B.owner, body: { hours: 5000 } }), 404, 'other mountain');
  is(await api('DELETE', `/ops/assets/${D.groomer}`, { token: T.staff }), 403);
});

test('the grooming plan: fill, start, finish and the groomed flag', async () => {
  const p = ok(await api('POST', '/ops/groom/plan', { token: T.staff, body: { plan_date: today, shift: 'night', trail_id: D.t1, asset_id: D.groomer } }), 201).id;
  is(await api('POST', '/ops/groom/plan', { token: T.staff, body: { plan_date: today, shift: 'night', trail_id: D.t1 } }), 409, 'trail twice');
  const fill = ok(await api('POST', '/ops/groom/plan/fill', { token: T.staff, body: { plan_date: today, shift: 'night', all: true } }));
  assert.equal(fill.added, 1, 'only the missing trail is added');
  ok(await api('POST', `/ops/groom/plan/${p}/start`, { token: T.staff }));
  is(await api('POST', `/ops/groom/plan/${p}/finish`, { token: T.staff, body: { machine_hours: -1, fuel_gal: 3 } }), 400);
  ok(await api('POST', `/ops/groom/plan/${p}/finish`, { token: T.staff, body: { machine_hours: 2.5, fuel_gal: 14 } }));
  const trails = ok(await api('GET', '/schedule/trails', { token: T.staff })).data;
  assert.equal(Number(trails.find((t) => t.id === D.t1).groomed), 1);
  assert.equal(ok(await api('GET', '/ops/assets', { token: T.staff })).data[0].hours, 1213);
  const list = ok(await api('GET', `/ops/groom/plan?date=${today}&shift=night`, { token: T.patrol }));
  assert.equal(list.data.length, 2);
  ok(await api('PATCH', `/ops/assets/${D.groomer}`, { token: T.manager, body: { status: 'out_of_service' } }));
  const q = list.data.find((r) => r.trail_id === D.t2).id;
  ok(await api('PATCH', `/ops/groom/plan/${q}`, { token: T.staff, body: { asset_id: D.groomer } }));
  is(await api('POST', `/ops/groom/plan/${q}/start`, { token: T.staff }), 409, 'machine out of service');
  ok(await api('PATCH', `/ops/assets/${D.groomer}`, { token: T.manager, body: { status: 'in_service' } }));
  is(await api('POST', '/ops/groom/clear-marks', { token: T.staff }), 403);
  ok(await api('POST', '/ops/groom/clear-marks', { token: T.manager }));
});

test('snow depth, weather and snowmaking', async () => {
  is(await api('POST', '/ops/snow', { token: T.staff, body: {} }), 400, 'a reading needs a value');
  ok(await api('POST', '/ops/snow', { token: T.staff, body: { base_in: 42, new_snow_in: 3, surface: 'packed_powder', quality: 'good' } }), 201);
  is(await api('POST', '/ops/snow', { token: T.staff, body: { base_in: 42, surface: 'lava' } }), 400);
  assert.equal(Number(ok(await api('GET', '/ops/snow/latest', { token: T.patrol })).mountain.base_in), 42);
  ok(await api('POST', '/ops/weather', { token: T.patrol, body: { temp_f: 18, wind_mph: 22, gust_mph: 35, wind_dir: 'NW', sky: 'snow' } }), 201);
  const run = ok(await api('POST', '/ops/snowmaking', { token: T.staff, body: { trail_id: D.t2, guns: 6 } }), 201).id;
  is(await api('POST', '/ops/snowmaking', { token: T.staff, body: { trail_id: D.t2 } }), 409, 'already running');
  ok(await api('POST', `/ops/snowmaking/${run}/stop`, { token: T.staff, body: { water_gal: 90000 } }));
  is(await api('POST', `/ops/snowmaking/${run}/stop`, { token: T.staff, body: {} }), 409, 'already stopped');
});

test('work orders: open, note, complete only with a resolution', async () => {
  const id = ok(await api('POST', '/ops/work-orders', { token: T.staff, body: { title: 'Replace groomer track', priority: 'high', asset_id: D.groomer } }), 201).id;
  is(await api('POST', '/ops/work-orders', { token: T.staff, body: { title: 'x', asset_id: 999999 } }), 404);
  ok(await api('POST', `/ops/work-orders/${id}/notes`, { token: T.patrol, body: { body: 'Parts ordered' } }), 201);
  is(await api('POST', `/ops/work-orders/${id}/status`, { token: T.staff, body: { status: 'done' } }), 400, 'needs a resolution');
  ok(await api('POST', `/ops/work-orders/${id}/status`, { token: T.staff, body: { status: 'done', resolution: 'Track replaced', labor_hours: 3 } }));
  const w = ok(await api('GET', `/ops/work-orders/${id}`, { token: T.staff }));
  assert.equal(w.status, 'done'); assert.ok(w.completed_at); assert.ok(w.notes.length >= 2);
  assert.equal(ok(await api('GET', '/ops/work-orders', { token: T.staff })).data.length, 0, 'closed orders leave the open list');
  is(await api('GET', `/ops/work-orders/${id}`, { token: B.owner }), 404);
  is(await api('DELETE', `/ops/work-orders/${id}`, { token: T.staff }), 403);
});

test('recurring jobs: due by date and by hours, then done', async () => {
  is(await api('POST', '/ops/pm', { token: T.staff, body: { name: 'Oil change' } }), 400, 'needs an interval');
  is(await api('POST', '/ops/pm', { token: T.staff, body: { name: 'Oil change', interval_hours: 250 } }), 400, 'hours need a machine');
  const id = ok(await api('POST', '/ops/pm', { token: T.staff, body: { name: 'Oil change', asset_id: D.groomer, interval_hours: 250, interval_days: 90 } }), 201).id;
  assert.equal(ok(await api('GET', '/ops/pm', { token: T.staff })).data[0].state, 'never');
  ok(await api('POST', `/ops/pm/${id}/done`, { token: T.staff, body: {} }));
  const t = ok(await api('GET', '/ops/pm', { token: T.staff })).data[0];
  assert.equal(t.state, 'ok'); assert.equal(Number(t.last_done_hours), 1213);
  ok(await api('POST', `/ops/assets/${D.groomer}/hours`, { token: T.staff, body: { hours: 1470 } }));
  assert.equal(ok(await api('GET', '/ops/pm', { token: T.staff })).data[0].state, 'overdue');
  const wo = ok(await api('POST', `/ops/pm/${id}/work-order`, { token: T.staff }), 201).id;
  assert.equal(ok(await api('GET', `/ops/work-orders/${wo}`, { token: T.staff })).source, 'preventive');
  assert.equal(ok(await api('GET', `/ops/pm/${id}/log`, { token: T.staff })).data.length, 1);
});

test('lift inspections: a failed item makes a work order and blocks opening the lift', async () => {
  const meta = ok(await api('GET', '/ops/meta', { token: T.staff }));
  const items = (fail) => meta.lift_checklist.map((i) => ({ key: i.key, result: fail && i.key === 'estop' ? 'fail' : 'pass', note: fail && i.key === 'estop' ? 'Left stop does not trip' : null }));
  is(await api('POST', '/ops/lift-checks', { token: T.staff, body: { lift_id: D.lift, items: items(false).slice(1) } }), 400, 'every item answered');
  const bad = items(true); bad.find((i) => i.key === 'estop').note = null;
  is(await api('POST', '/ops/lift-checks', { token: T.staff, body: { lift_id: D.lift, items: bad } }), 400, 'failed item needs a note');
  const f = ok(await api('POST', '/ops/lift-checks', { token: T.staff, body: { lift_id: D.lift, items: items(true) } }), 201);
  assert.equal(f.result, 'fail'); assert.ok(f.work_order_id);
  is(await api('PATCH', `/schedule/lifts/${D.lift}`, { token: T.staff, body: { status: 'open' } }), 409, 'blocked');
  ok(await api('PATCH', `/schedule/lifts/${D.lift}`, { token: T.staff, body: { status: 'hold' } }));
  ok(await api('POST', '/ops/lift-checks', { token: T.staff, body: { lift_id: D.lift, items: items(false) } }), 201);
  ok(await api('PATCH', `/schedule/lifts/${D.lift}`, { token: T.staff, body: { status: 'open' } }));
  const day = ok(await api('GET', '/ops/lift-checks/day', { token: T.staff }));
  assert.equal(day.data.find((r) => r.lift_id === D.lift).result, 'pass');
});

test('downtime follows lift status, and handoffs can be acknowledged', async () => {
  ok(await api('PATCH', `/schedule/lifts/${D.lift}`, { token: T.staff, body: { status: 'wind_hold' } }));
  await new Promise((r) => setTimeout(r, 300));
  const open = ok(await api('GET', '/ops/downtime?open=1', { token: T.staff })).data;
  assert.equal(open.length, 1); assert.equal(open[0].reason, 'wind');
  ok(await api('PATCH', `/schedule/lifts/${D.lift}`, { token: T.staff, body: { status: 'open' } }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(ok(await api('GET', '/ops/downtime?open=1', { token: T.staff })).data.length, 0);
  is(await api('POST', '/ops/downtime', { token: T.staff, body: { lift_id: D.lift, started_at: `${today} 10:00`, ended_at: `${today} 09:00` } }), 400);
  ok(await api('POST', '/ops/downtime', { token: T.staff, body: { lift_id: D.lift, started_at: `${yesterday} 10:00`, ended_at: `${yesterday} 11:30`, reason: 'mechanical' } }), 201);
  const sum = ok(await api('GET', '/ops/downtime/summary', { token: T.manager }));
  assert.ok(sum.by_lift[0].minutes >= 90);
  const h = ok(await api('POST', '/ops/handoffs', { token: T.staff, body: { dept: 'grooming', body: 'Upper Run needs a second pass', shift: 'night' } }), 201).id;
  ok(await api('POST', `/ops/handoffs/${h}/ack`, { token: T.patrol }));
  is(await api('POST', `/ops/handoffs/${h}/ack`, { token: T.patrol }), 409, 'already acknowledged');
  assert.equal(ok(await api('GET', '/ops/handoffs', { token: T.staff })).data[0].dept, 'grooming');
  is(await api('DELETE', `/ops/handoffs/${h}`, { token: T.staff }), 403);
});

test('the daily report pulls it together, with text to copy', async () => {
  const r = ok(await api('GET', '/ops/report', { token: T.staff }));
  assert.equal(r.date, today); assert.equal(r.lifts_total, 1); assert.equal(r.trails_total, 2);
  assert.equal(r.snow.base_in, 42); assert.equal(r.weather.max_gust_mph, 35);
  assert.equal(r.snowmaking.runs, 1); assert.ok(r.maintenance.open_orders >= 1);
  assert.match(r.text, /mountain report for/);
  is(await api('GET', '/ops/report?date=bad', { token: T.staff }), 400);
  is(await api('GET', '/ops/report', { token: T.counter }), 403);
  const other = ok(await api('GET', '/ops/report', { token: B.owner }));
  assert.equal(other.lifts_total, 0); assert.equal(other.snow, null);
});
