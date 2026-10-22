'use strict';

// Day by day: the nightly job writes each finished day (weather at the mountain's map point, crew new snow, open or
// closed, visits, tickets sold and sold ahead online, lessons, revenue); a failed weather lookup still records the day
// and keeps weather already recorded; managers can fill in the past year; staff cannot see it; demo mountains are skipped.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.WEATHER = 'on';
process.env.DAY_RECORDS = 'on';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { todayIn, addDays } = require('../src/lib/util');
const dayrecord = require('../src/lib/dayrecord');

let server; let base; let wxServer; let wxCalls = []; let wxDown = false;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
async function api(method, path, { token, body, headers } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${r.text}`);

let M; let today; let yday;
test.before(async () => {
  // A stand-in for Open-Meteo: every day asked for gets the same weather, 6 inches of snow.
  wxServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    wxCalls.push(u);
    if (wxDown) { res.writeHead(503); res.end(); return; }
    const time = [];
    for (let d = u.searchParams.get('start_date'); d <= u.searchParams.get('end_date'); d = addDays(d, 1)) time.push(d);
    const each = (v) => time.map(() => v);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ daily: { time, temperature_2m_max: each(28.4), temperature_2m_min: each(12.1), snowfall_sum: each(6.2), precipitation_sum: each(0.55), wind_speed_10m_max: each(14), wind_gusts_10m_max: each(31), weather_code: each(73) } }));
  });
  await new Promise((r) => wxServer.listen(0, r));
  process.env.WEATHER_URL = `http://127.0.0.1:${wxServer.address().port}`;
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;

  const slug = `days-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Days Mountain', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  const owner = await login(`owner@${slug}.test`);
  is(await api('POST', '/users', { token: owner, body: { email: `counter@${slug}.test`, password: PW, role: 'counter' } }), 201);
  const id = (await pool.query('SELECT id, timezone FROM tenants WHERE slug = ?', [slug]))[0][0];
  M = { id: id.id, owner, counter: await login(`counter@${slug}.test`) };
  today = todayIn(id.timezone); yday = addDays(today, -1);
  // Yesterday: open, the crew logged 5 inches, two tickets for the day sold online two days before, one at the window.
  await pool.query("INSERT INTO calendar_days (tenant_id, on_date, status) VALUES (?, ?, 'open')", [M.id, yday]);
  await pool.query('INSERT INTO snow_readings (tenant_id, trail_id, read_at, base_in, new_snow_in) VALUES (?, NULL, ?, 40, 5)', [M.id, `${yday} 07:30:00`]);
  const prod = (await api('POST', '/products', { token: owner, body: { kind: 'day_ticket', name: 'Day', base_price_cents: 5000 } })).body.id;
  const [o1] = await pool.query("INSERT INTO orders (tenant_id, status, total_cents, channel, created_at) VALUES (?, 'paid', 10000, 'online', ?)", [M.id, `${addDays(today, -3)} 18:00:00`]);
  await pool.query("INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, quantity, unit_price_cents, valid_on) VALUES (?, ?, ?, 'ticket', 2, 5000, ?)", [M.id, o1.insertId, prod, yday]);
  const [o2] = await pool.query("INSERT INTO orders (tenant_id, status, total_cents, channel, created_at) VALUES (?, 'paid', 5000, 'window', ?)", [M.id, `${yday} 17:00:00`]);
  await pool.query("INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, quantity, unit_price_cents, valid_on) VALUES (?, ?, ?, 'ticket', 1, 5000, ?)", [M.id, o2.insertId, prod, yday]);
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => wxServer.close(r)); await pool.end(); });

// The nightly run, for this test's mountain only (the test database holds hundreds of others).
const runJob = async () => ({ status: (await dayrecord.runAll({ only: M.id })).some((x) => x.error) ? 500 : 200 });
const dayOf = async (date) => (await api('GET', `/ops/days?from=${date}&to=${date}`, { token: M.owner })).body.days[0];

test('without a location the day is still recorded, just without weather; then a location brings the weather', async () => {
  is(await runJob(), 200);
  const r = await api('GET', '/ops/days', { token: M.owner });
  is(r, 200); assert.equal(r.body.has_location, false);
  const d = r.body.days.find((x) => x.on_date === yday);
  assert.ok(d, 'yesterday is recorded');
  assert.equal(d.high_f, null); assert.equal(d.status, 'open');
  assert.equal(d.crew_new_snow_in, 5); assert.equal(d.crew_base_in, 40);
  assert.equal(d.tickets_for_day, 3); assert.equal(d.presold_online, 2, 'the two bought online ahead of the day');
  assert.ok(!r.body.days.some((x) => x.on_date === today), 'today is not finished, so not recorded');

  is(await api('PUT', '/ops/days/location', { token: M.counter, body: { lat: 44.1, lng: -71.2 } }), 403);
  is(await api('PUT', '/ops/days/location', { token: M.owner, body: { lat: 44.1, lng: -71.2 } }), 200);
  wxCalls = [];
  is(await runJob(), 200);
  const w = await dayOf(yday);
  assert.equal(w.high_f, 28.4); assert.equal(w.low_f, 12.1); assert.equal(w.snowfall_in, 6.2); assert.equal(w.gust_mph, 31); assert.equal(w.weather_code, 73);
  assert.equal(w.weather_source, 'open-meteo');
  assert.equal(wxCalls.length, 1, 'one request covers the three days');
  const q = wxCalls[0].searchParams;
  assert.equal(q.get('latitude'), '44.1'); assert.equal(q.get('temperature_unit'), 'fahrenheit'); assert.equal(q.get('end_date'), yday);
});

test('a failed weather lookup keeps the weather already recorded', async () => {
  wxDown = true;
  is(await runJob(), 200);
  wxDown = false;
  const w = await dayOf(yday);
  assert.equal(w.high_f, 28.4, 'kept'); assert.equal(w.tickets_for_day, 3, 'the rest is still recorded');
});

test('managers fill in the past year: older days come from the archive', async () => {
  is(await api('POST', '/ops/days/backfill', { token: M.counter, body: { days: 365 } }), 403);
  is(await api('GET', '/ops/days', { token: M.counter }), 403, 'staff do not see it');
  wxCalls = [];
  const r = await api('POST', '/ops/days/backfill', { token: M.owner, body: { days: 120 } });
  is(r, 200); assert.equal(r.body.days, 120); assert.equal(r.body.weather, 120);
  assert.deepEqual(wxCalls.map((u) => u.pathname).sort(), ['/v1/archive', '/v1/forecast']);
  const list = await api('GET', `/ops/days?from=${addDays(today, -120)}&to=${yday}`, { token: M.owner });
  assert.equal(list.body.days.length, 120);
  assert.equal(list.body.days[0].on_date, yday, 'newest first');
});
