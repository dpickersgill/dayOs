'use strict';

// Forecast data (lib/snapshots.js): the four kinds the daily job takes each morning (presales, the hourly weather
// forecast with the weather call faked, staffing, prices), one kind failing without stopping the others, the time
// budget, 3-year retention, no personal data in any snapshot, the backfill safe to run twice, the mountain's day at the
// day boundary, and the Money, Forecast data screen's API (owners and managers only).
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.WEATHER = 'on';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { addDays } = require('../src/lib/util');
const S = require('../src/lib/snapshots');

let server; let base; let wx; let wxCalls = []; let wxDown = false;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const TZ = 'America/Denver';
async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${r.text}`);
const q = async (sql, args) => (await pool.query(sql, args))[0];

// A stand-in for Open-Meteo's hourly forecast: 72 hours from the mountain's midnight today, wind rising through the day.
// Several comma-separated points answer as a list, one point as a single answer, like the real service.
function hourly(day, elevation) {
  const time = []; const n = 72;
  for (let i = 0; i < n; i++) time.push(`${addDays(day, Math.floor(i / 24))}T${String(i % 24).padStart(2, '0')}:00`);
  const f = (fn) => time.map((_, i) => fn(i));
  return { latitude: 0, longitude: 0, elevation, hourly: { time, temperature_2m: f(() => 21.5), precipitation: f(() => 0.02), snowfall: f(() => 0.3), wind_speed_10m: f((i) => 5 + (i % 24)), wind_gusts_10m: f((i) => 12 + (i % 24) * 2), weather_code: f(() => 73) } };
}

let M; let today;
test.before(async () => {
  wx = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); wxCalls.push(u);
    if (wxDown) { res.writeHead(503); res.end(); return; }
    const lats = u.searchParams.get('latitude').split(',');
    const day = S.dateIn(u.searchParams.get('timezone'));
    const list = lats.map((_, i) => hourly(day, i === 0 ? 1200 : 1850));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(lats.length > 1 ? list : list[0]));
  });
  await new Promise((r) => wx.listen(0, r));
  process.env.WEATHER_URL = `http://127.0.0.1:${wx.address().port}`;
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;

  const slug = `snaps-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Snapshot Mountain', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  const owner = await login(`owner@${slug}.test`);
  is(await api('POST', '/users', { token: owner, body: { email: `counter@${slug}.test`, password: PW, role: 'counter' } }), 201);
  is(await api('POST', '/users', { token: owner, body: { email: `manager@${slug}.test`, password: PW, role: 'manager' } }), 201);
  const id = (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id;
  await q('UPDATE tenants SET timezone = ? WHERE id = ?', [TZ, id]);
  M = { id, slug, owner, counter: await login(`counter@${slug}.test`), manager: await login(`manager@${slug}.test`) };
  today = S.dateIn(TZ);

  // Guests and staff with names, emails and phones: none of it may reach a snapshot.
  const person = async (first, last, n) => (await q('INSERT INTO people (tenant_id, first_name, last_name, email, phone) VALUES (?, ?, ?, ?, ?)', [id, first, last, `${first.toLowerCase()}.${suffix}@guest.test`, `555-01${String(n).padStart(2, '0')}`])).insertId;
  M.people = [await person('Harriet', 'Quillfeather', 1), await person('Bartholomew', 'Snowmantle', 2), await person('Ingrid', 'Powderhorn', 3), await person('Desmond', 'Liftwright', 4)];

  // Products: an online day ticket with 10% off when bought 3+ days ahead, a lesson, a rental.
  const prod = async (kind, name, cents, extra = {}) => (await q('INSERT INTO products (tenant_id, kind, name, base_price_cents, online, advance_days, advance_percent, sale_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, kind, name, cents, extra.online ?? 1, extra.advance_days ?? null, extra.advance_percent ?? null, extra.sale_days ?? 127])).insertId;
  M.day = await prod('day_ticket', 'All-day lift ticket', 8000, { advance_days: 3, advance_percent: 10 });
  M.weekend = await prod('day_ticket', 'Weekend ticket', 9000, { sale_days: 65 }); // Saturdays and Sundays only
  M.lesson = await prod('lesson', 'Group lesson', 6000);
  M.rental = await prod('rental', 'Ski package', 4000);
  await q("INSERT INTO price_tiers (tenant_id, product_id, tier, price_cents) VALUES (?, ?, 'child', 5000)", [id, M.day]);
  await q('INSERT INTO price_calendar (tenant_id, product_id, on_date, tier, price_cents, blackout) VALUES (?, ?, ?, NULL, 9500, 0)', [id, M.day, addDays(today, 5)]);
  await q('INSERT INTO price_calendar (tenant_id, product_id, on_date, tier, price_cents, blackout) VALUES (?, ?, ?, NULL, NULL, 1)', [id, M.day, addDays(today, 6)]);

  // Sales for tomorrow: 3 tickets online, 1 at the window, 1 refunded (does not count); 2 rentals online.
  const order = async (channel, items, createdAt = '2026-01-01 12:00:00') => {
    const o = (await q("INSERT INTO orders (tenant_id, person_id, status, total_cents, channel, created_at) VALUES (?, ?, 'paid', 1000, ?, ?)", [id, M.people[0], channel, createdAt])).insertId;
    for (const it of items) {
      await q('INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, person_id, session_id, quantity, unit_price_cents, valid_on, refunded_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1000, ?, ?)',
        [id, o, it.product, it.kind, it.person ?? M.people[0], it.session ?? null, it.qty ?? 1, it.on, it.refunded ?? null]);
    }
    return o;
  };
  const tomorrow = addDays(today, 1);
  M.recent = new Date(Date.now() - 3600e3).toISOString().slice(0, 19).replace('T', ' ');
  await order('online', [{ product: M.day, kind: 'ticket', qty: 3, on: tomorrow }, { product: M.rental, kind: 'rental', qty: 2, on: tomorrow }], M.recent);
  await order('window', [{ product: M.day, kind: 'ticket', qty: 1, on: tomorrow }], M.recent);
  await order('window', [{ product: M.day, kind: 'ticket', qty: 1, on: tomorrow, refunded: M.recent }], M.recent);
  // A lesson for kids 4-12 tomorrow at 10 am (the mountain's clock): one booked online, one at the desk, one cancelled.
  M.session = (await q("INSERT INTO lesson_sessions (tenant_id, product_id, starts_at, ends_at, age_min, age_max) VALUES (?, ?, ?, ?, 4, 12)", [id, M.lesson, `${tomorrow} 10:00:00`, `${tomorrow} 12:00:00`])).insertId;
  await q("INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status, contact_name, contact_email, contact_phone, created_at) VALUES (?, ?, ?, 'booked', 'Harriet Quillfeather', 'harriet@guest.test', '555-0101', ?)", [id, M.session, M.people[1], M.recent]);
  await q("INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status, created_at) VALUES (?, ?, ?, 'booked', ?)", [id, M.session, M.people[2], M.recent]);
  await q("INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status, created_at) VALUES (?, ?, ?, 'cancelled', ?)", [id, M.session, M.people[3], M.recent]);
  await order('online', [{ product: M.lesson, kind: 'lesson', on: tomorrow, session: M.session, person: M.people[1] }], M.recent);
  await q("INSERT INTO rental_reservations (tenant_id, person_id, pickup_on, notes, created_at) VALUES (?, ?, ?, 'Size 27 boots for Ingrid', ?)", [id, M.people[2], tomorrow, M.recent]);

  // Staff: a lift operator scheduled today (filled) and an unfilled ski school shift.
  const pos = async (name, dept) => (await q('INSERT INTO positions (tenant_id, name, department) VALUES (?, ?, ?)', [id, name, dept])).insertId;
  M.liftPos = await pos('Lift operator', 'lifts'); M.schoolPos = await pos('Instructor', 'ski_school');
  M.staff = (await q("INSERT INTO staff (tenant_id, person_id, status) VALUES (?, ?, 'active')", [id, M.people[3]])).insertId;
  M.shift = (await q("INSERT INTO shifts (tenant_id, position_id, staff_id, starts_at, ends_at, status) VALUES (?, ?, ?, ?, ?, 'published')", [id, M.liftPos, M.staff, `${today} 08:00:00`, `${today} 16:30:00`])).insertId;
  await q("INSERT INTO shifts (tenant_id, position_id, staff_id, starts_at, ends_at, status) VALUES (?, ?, NULL, ?, ?, 'draft')", [id, M.schoolPos, `${today} 09:00:00`, `${today} 13:00:00`]);
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => wx.close(r)); await pool.end(); });

// ---------------------------------------------------------------- the four kinds
test('presales: tickets, lessons by product and age band, rentals, online orders and the share bought online, for 14 days', async () => {
  const r = await S.take(pool, M.id, 'presales');
  assert.equal(r.status, 'taken'); assert.equal(r.on_date, today);
  const s = await S.latest(pool, M.id, today, 'presales');
  assert.equal(s.stale, false); assert.equal(s.backfilled, false);
  assert.equal(s.data.days.length, 14); assert.equal(s.data.days[0].date, today); assert.equal(s.data.days[13].date, addDays(today, 13));
  const d = s.data.days[1];
  assert.deepEqual(d.tickets, { sold: 4, online: 3, by_product: [{ product_id: M.day, product: 'All-day lift ticket', sold: 4 }] }, 'the refunded ticket does not count');
  assert.deepEqual(d.lessons, { sold: 2, online: 1, by_product: [{ product_id: M.lesson, product: 'Group lesson', age_band: '4-12', sold: 2, online: 1 }] }, 'the cancelled booking does not count');
  assert.deepEqual(d.rentals, { sold: 2, online: 2, reserved: 1 });
  assert.equal(d.online_orders, 2);
  assert.equal(d.online_share, Math.round((6 / 8) * 1000) / 1000);
  assert.equal(s.data.days[2].tickets.sold, 0); assert.equal(s.data.days[2].online_share, null);
  // Taken again the same day: still one row, replaced.
  await S.take(pool, M.id, 'presales');
  assert.equal((await q("SELECT COUNT(*) AS n FROM daily_snapshots WHERE tenant_id = ? AND kind = 'presales' AND on_date = ?", [M.id, today]))[0].n, 1);
});

test('forecast: the hourly forecast for 72 hours from the same weather service; one point says which it is', async () => {
  await q('UPDATE tenants SET map_lat = 39.6, map_lng = -105.9, wx_summit_lat = NULL, wx_summit_lng = NULL WHERE id = ?', [M.id]);
  wxCalls = [];
  assert.equal((await S.take(pool, M.id, 'forecast')).status, 'taken');
  assert.equal(wxCalls.length, 1);
  const u = wxCalls[0];
  assert.equal(u.pathname, '/v1/forecast');
  assert.equal(u.searchParams.get('forecast_hours'), '72');
  assert.equal(u.searchParams.get('timezone'), TZ, 'hours on the mountain’s clock');
  for (const v of ['temperature_2m', 'precipitation', 'snowfall', 'wind_speed_10m', 'wind_gusts_10m']) assert.ok(u.searchParams.get('hourly').split(',').includes(v), v);
  const s = (await S.latest(pool, M.id, today, 'forecast')).data;
  assert.equal(s.source, 'open-meteo'); assert.equal(s.resolution, 'hourly');
  assert.equal(s.points.length, 1); assert.equal(s.points[0].role, 'map_point');
  const p = s.points[0];
  assert.equal(p.elevation_m, 1200);
  assert.equal(p.hourly.time.length, 72);
  for (const k of ['temp_f', 'precip_in', 'snow_in', 'wind_mph', 'gust_mph']) assert.equal(p.hourly[k].length, 72, k);
  assert.equal(p.hourly.gust_mph[10], 32); assert.equal(p.hourly.wind_mph[10], 15);
});

test('forecast: with a summit as well, base and summit in one request', async () => {
  await q('UPDATE tenants SET wx_summit_lat = 39.58, wx_summit_lng = -105.94 WHERE id = ?', [M.id]);
  wxCalls = [];
  await S.take(pool, M.id, 'forecast');
  assert.equal(wxCalls.length, 1);
  assert.equal(wxCalls[0].searchParams.get('latitude'), '39.6,39.58');
  const s = (await S.latest(pool, M.id, today, 'forecast')).data;
  assert.deepEqual(s.points.map((p) => [p.role, p.elevation_m]), [['base', 1200], ['summit', 1850]]);
});

test('forecast: the weather switch off or no location skips it; a failed lookup fails it without throwing in the lookup', async () => {
  process.env.WEATHER = 'off';
  assert.deepEqual(await S.take(pool, M.id, 'forecast'), { kind: 'forecast', on_date: today, status: 'skipped', reason: 'weather lookup is off' });
  process.env.WEATHER = 'on';
  const dayrecord = require('../src/lib/dayrecord');
  wxDown = true;
  assert.equal(await dayrecord.fetchHourly([{ role: 'base', lat: 1, lng: 2 }], TZ), null, 'the lookup never throws');
  await assert.rejects(S.take(pool, M.id, 'forecast'), /hourly weather lookup failed/);
  wxDown = false;
});

test('staffing: today’s shifts by department and yesterday’s hours worked, counts and hours only', async () => {
  const [yFrom] = require('../src/lib/util').dayRange(TZ, addDays(today, -1));
  const at = (h) => new Date(Date.parse(`${yFrom.replace(' ', 'T')}Z`) + h * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
  await q('INSERT INTO time_entries (tenant_id, staff_id, shift_id, clock_in, clock_out) VALUES (?, ?, ?, ?, ?)', [M.id, M.staff, M.shift, at(8), at(16.5)]);
  await q('INSERT INTO time_entries (tenant_id, staff_id, shift_id, clock_in, clock_out) VALUES (?, ?, NULL, ?, ?)', [M.id, M.staff, at(17), at(18)]);
  await S.take(pool, M.id, 'staffing');
  const s = (await S.latest(pool, M.id, today, 'staffing')).data;
  assert.deepEqual(s.today.by_department, { lifts: { shifts: 1, unfilled: 0, published: 1, hours: 8.5 }, ski_school: { shifts: 1, unfilled: 1, published: 0, hours: 4 } });
  assert.equal(s.today.shifts, 2); assert.equal(s.today.hours, 12.5);
  assert.deepEqual(s.yesterday.by_department, { lifts: { entries: 1, headcount: 1, hours: 8.5 }, unscheduled: { entries: 1, headcount: 1, hours: 1 } });
  assert.equal(s.yesterday.date, addDays(today, -1));
});

test('prices: the online prices for each of the next 14 days by product and guest type, with the early-buy discount', async () => {
  await S.take(pool, M.id, 'prices');
  const s = (await S.latest(pool, M.id, today, 'prices')).data;
  assert.deepEqual(s.products.map((p) => p.product), ['All-day lift ticket', 'Weekend ticket']);
  assert.equal(s.days.length, 14);
  const of = (i, pid) => s.days[i].by_product.find((x) => x.product_id === pid);
  assert.deepEqual(of(0, M.day).cents, { child: 5000, youth: 8000, adult: 8000, senior: 8000 }, 'today: no early-buy discount');
  assert.equal(of(0, M.day).early, false);
  assert.equal(of(3, M.day).cents.adult, 7200, '3 days ahead: 10% off'); assert.equal(of(3, M.day).list_cents.adult, 8000); assert.equal(of(3, M.day).early, true);
  assert.equal(of(5, M.day).cents.adult, 8550, 'the date price, less 10%');
  assert.equal(of(6, M.day).status, 'blackout');
  for (const d of s.days) {
    const w = d.by_product.find((x) => x.product_id === M.weekend);
    assert.equal(w.status, [0, 6].includes(d.weekday) ? 'on_sale' : 'not_sold', d.date);
  }
});

// ---------------------------------------------------------------- isolation and time
test('one kind failing does not stop the others, and the daily run carries on', async () => {
  const real = S._build.presales;
  S._build.presales = async () => { throw new Error('presales broke'); };
  wxDown = true;
  try {
    const got = await S.takeAll(pool, await S.tenantRow(pool, M.id));
    assert.deepEqual(Object.fromEntries(got.map((r) => [r.kind, r.status])), { presales: 'failed', staffing: 'taken', prices: 'taken', forecast: 'failed' });
    const run = await S.runAll({ only: M.id });
    assert.deepEqual([run.mountains, run.taken, run.failed, run.not_reached], [1, 2, 2, 0]);
    assert.equal(typeof run.seconds, 'number');
  } finally { S._build.presales = real; wxDown = false; }
});

test('a weather service that is down is asked 3 times in a run, not once per mountain', async () => {
  wxDown = true; wxCalls = [];
  try {
    const t = await S.tenantRow(pool, M.id); const run = { wxFailed: 0 };
    for (let i = 0; i < 5; i++) await assert.rejects(S.take(pool, M.id, 'forecast', { tenant: t, run }));
    assert.equal(wxCalls.length, 3);
  } finally { wxDown = false; }
});

test('the run stops at its time budget, counts what it did not reach, and does not throw', async () => {
  const run = await S.runAll({ budgetMs: -1 });
  assert.equal(run.taken, 0); assert.ok(run.mountains >= 1); assert.equal(run.not_reached, run.mountains);
  process.env.SNAPSHOTS = 'off';
  assert.deepEqual(await S.runAll({ only: M.id }), { skipped: true });
  delete process.env.SNAPSHOTS;
});

test('the daily job runs snapshots as its own stage', () => {
  const src = require('fs').readFileSync(require.resolve('../src/routes/followpublic.js'), 'utf8');
  assert.match(src, /stage\('snapshots', \(\) => require\('\.\.\/lib\/snapshots'\)\.runAll\(\)\)/);
});

// ---------------------------------------------------------------- the day boundary
test('the mountain’s day decides the snapshot’s date, what counts as sold, and which hours are yesterday’s', async () => {
  const D = addDays(today, 20);
  // 06:30 UTC is 11:30 pm the evening before in Denver (UTC-7 in winter, -6 in summer): still the day before.
  const now = new Date(`${D}T06:30:00Z`);
  const local = S.dateIn(TZ, now);
  assert.equal(local, addDays(D, -1));
  const r = await S.take(pool, M.id, 'presales', { now });
  assert.equal(r.on_date, local);
  // Sold before that instant counts; sold after does not, even on the same UTC date.
  const ticket = async (createdAt) => {
    const o = (await q("INSERT INTO orders (tenant_id, status, total_cents, channel, created_at) VALUES (?, 'paid', 1000, 'online', ?)", [M.id, createdAt])).insertId;
    await q("INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, quantity, unit_price_cents, valid_on) VALUES (?, ?, ?, 'ticket', 1, 1000, ?)", [M.id, o, M.day, addDays(D, 2)]);
  };
  await ticket(`${D} 06:00:00`); await ticket(`${D} 07:00:00`);
  await S.take(pool, M.id, 'presales', { now });
  const s = await S.latest(pool, M.id, local, 'presales');
  assert.equal(s.on_date, local);
  assert.equal(s.data.days.find((d) => d.date === addDays(D, 2)).tickets.sold, 1);
  // Yesterday's hours are the mountain's yesterday: an entry at 05:30 UTC on (local - 1) is 10:30 pm on (local - 2).
  const st = (await q("INSERT INTO staff (tenant_id, person_id, status) VALUES (?, ?, 'active')", [M.id, M.people[0]])).insertId;
  await q('INSERT INTO time_entries (tenant_id, staff_id, clock_in, clock_out) VALUES (?, ?, ?, ?)', [M.id, st, `${addDays(local, -1)} 05:30:00`, `${addDays(local, -1)} 06:30:00`]);
  await q('INSERT INTO time_entries (tenant_id, staff_id, clock_in, clock_out) VALUES (?, ?, ?, ?)', [M.id, st, `${local} 05:30:00`, `${local} 07:30:00`]);
  await S.take(pool, M.id, 'staffing', { now });
  const y = (await S.latest(pool, M.id, local, 'staffing')).data.yesterday;
  assert.equal(y.date, addDays(local, -1));
  assert.deepEqual(y.by_department, { unscheduled: { entries: 1, headcount: 1, hours: 2 } }, 'only the entry on the mountain’s yesterday');
  await q('DELETE FROM daily_snapshots WHERE tenant_id = ? AND on_date > ?', [M.id, today]);
});

// ---------------------------------------------------------------- retention
test('kept 3 years: the daily retention run removes older snapshots and keeps the rest', async () => {
  const day = (years, days) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - years); return addDays(d.toISOString().slice(0, 10), days); };
  await S.save(pool, M.id, day(3, -2), 'presales', { days: [] });
  await S.save(pool, M.id, day(3, 2), 'presales', { days: [] });
  const out = await require('../src/lib/retention').runAll();
  assert.ok(out.snapshots >= 1);
  const left = (await q("SELECT on_date FROM daily_snapshots WHERE tenant_id = ? AND on_date < ? - INTERVAL 2 YEAR", [M.id, today])).map((r) => String(r.on_date).slice(0, 10));
  assert.deepEqual(left, [day(3, 2)]);
  await q("DELETE FROM daily_snapshots WHERE tenant_id = ? AND on_date < ? - INTERVAL 2 YEAR", [M.id, today]);
});

// ---------------------------------------------------------------- no personal data
/** Every name, email, phone and person, staff or login id that could leak, and the keys that would carry one. */
async function personalFinder(tenantId) {
  const people = await q('SELECT id, first_name, last_name, email, phone FROM people WHERE tenant_id = ?', [tenantId]);
  const users = await q('SELECT id, email FROM users WHERE tenant_id = ?', [tenantId]);
  const needles = [...people.flatMap((p) => [`${p.first_name} ${p.last_name}`, p.last_name, p.email, p.phone]), ...users.map((u) => u.email)]
    .filter((x) => x && String(x).length >= 5).map((x) => String(x).toLowerCase());
  const badKey = /(^|_)(person|people|staff|user|customer|instructor|guest|holder|patient|contact|birth|dob)(_|s$|$)|(order|booking|ticket|case)_(id|ref|number)|first_name|last_name|email|phone|^id$|^name$/i;
  return function find(data) {
    const hits = [];
    const walk = (v, path) => {
      if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
      if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) { if (badKey.test(k)) hits.push(`${path}.${k} (key)`); walk(x, `${path}.${k}`); } return; }
      if (typeof v === 'string') { const low = v.toLowerCase(); for (const n of needles) if (low.includes(n)) hits.push(`${path}: ${v}`); }
    };
    walk(data, '$');
    return hits;
  };
}

test('no snapshot holds a person’s name, email, phone or id', async () => {
  await S.takeAll(pool, await S.tenantRow(pool, M.id));
  await S.backfill(pool, M.id, { from: addDays(today, -3) });
  const find = await personalFinder(M.id);
  // The check itself catches what it should.
  assert.ok(find({ x: [{ note: 'harriet quillfeather' }] }).length);
  assert.ok(find({ person_id: 3 }).length); assert.ok(find({ a: { contact_email: null } }).length); assert.ok(find({ y: `${M.people[0]}`, id: 1 }).length);
  const all = await q('SELECT kind, on_date, data FROM daily_snapshots WHERE tenant_id = ?', [M.id]);
  assert.deepEqual([...new Set(all.map((r) => r.kind))].sort(), ['forecast', 'presales', 'prices', 'staffing']);
  for (const r of all) assert.deepEqual(find(JSON.parse(r.data)), [], `${r.kind} on ${String(r.on_date).slice(0, 10)}`);
});

test('the snapshot table is in the personal-data register as holding no person', () => {
  const { NOT_GUESTS } = require('../src/lib/personal');
  assert.ok(NOT_GUESTS.daily_snapshots);
});

// ---------------------------------------------------------------- the backfill
test('the backfill rebuilds presales by days ahead from order times, weather from the day record, and is safe twice', async () => {
  const D = addDays(today, -10);
  // Two tickets for D: one bought 3 days ahead, one on the day itself (after the mountain's midnight).
  const [mid] = require('../src/lib/util').dayRange(TZ, D);
  const after = new Date(Date.parse(`${mid.replace(' ', 'T')}Z`) + 3600e3).toISOString().slice(0, 19).replace('T', ' ');
  const sell = async (createdAt) => {
    const o = (await q("INSERT INTO orders (tenant_id, status, total_cents, channel, created_at) VALUES (?, 'paid', 1000, 'online', ?)", [M.id, createdAt])).insertId;
    await q("INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, quantity, unit_price_cents, valid_on) VALUES (?, ?, ?, 'ticket', 1, 1000, ?)", [M.id, o, M.day, D]);
  };
  await sell(`${addDays(D, -3)} 18:00:00`); await sell(after);
  await q("INSERT INTO day_records (tenant_id, on_date, weekday, high_f, low_f, snowfall_in, wind_mph, gust_mph, weather_source) VALUES (?, ?, 1, 30, 10, 4, 12, 30, 'open-meteo') ON DUPLICATE KEY UPDATE gust_mph = 30, weather_source = 'open-meteo'", [M.id, D]);
  // A day the daily job already took stays as it was.
  await S.save(pool, M.id, addDays(D, -1), 'presales', { live: true, days: [] });

  const run = () => require('child_process').execFileSync(process.execPath, ['scripts/snapshot-backfill.js', '--tenant', String(M.id), '--from', addDays(D, -5), '--to', D], { cwd: require('path').join(__dirname, '..'), env: process.env, encoding: 'utf8' });
  const first = run();
  assert.match(first, /6 day\(s\)/);
  const snap = async () => q('SELECT on_date, kind, backfilled, data FROM daily_snapshots WHERE tenant_id = ? AND on_date BETWEEN ? AND ? ORDER BY on_date, kind', [M.id, addDays(D, -5), D]);
  const once = await snap();
  run();
  const twice = await snap();
  assert.deepEqual(twice, once, 'running it again gives the same rows');

  const ahead = (on) => JSON.parse(once.find((r) => String(r.on_date).slice(0, 10) === on && r.kind === 'presales').data).days;
  assert.equal(ahead(addDays(D, -5)).find((d) => d.date === D).tickets.sold, 0, '5 days ahead: nothing sold yet');
  assert.equal(ahead(addDays(D, -2)).find((d) => d.date === D).tickets.sold, 1, '2 days ahead: the early one');
  assert.equal(ahead(D).find((d) => d.date === D).tickets.sold, 1, 'the day itself, as it began: the one bought that morning is not counted yet');
  const live = once.find((r) => String(r.on_date).slice(0, 10) === addDays(D, -1) && r.kind === 'presales');
  assert.equal(Number(live.backfilled), 0); assert.deepEqual(JSON.parse(live.data), { live: true, days: [] });
  assert.ok(once.filter((r) => String(r.on_date).slice(0, 10) !== addDays(D, -1)).every((r) => Number(r.backfilled) === 1), 'rebuilt rows are marked');
  const w = once.find((r) => String(r.on_date).slice(0, 10) === D && r.kind === 'forecast');
  const wd = JSON.parse(w.data);
  assert.equal(wd.source, 'day_record'); assert.equal(wd.resolution, 'daily'); assert.equal(wd.days[0].gust_mph, 30);
  assert.ok(!once.some((r) => r.kind === 'prices'), 'past prices are not rebuilt');
});

// ---------------------------------------------------------------- the screen's API
test('Forecast data: owners and managers see coverage, presales against last year and today’s wind; others cannot', async () => {
  await S.takeAll(pool, await S.tenantRow(pool, M.id));
  // Last year's snapshot, 52 weeks back, as it stood then.
  const was = S.presalesFrom({ items: [], lessons: [], holds: [] }, addDays(today, -364), '2000-01-01 00:00:00');
  was.days[1].tickets.sold = 7;
  await S.save(pool, M.id, addDays(today, -364), 'presales', was, { backfilled: true });
  is(await api('GET', '/reports/forecast-data', { token: M.counter }), 403);
  const r = await api('GET', '/reports/forecast-data', { token: M.manager });
  is(r, 200);
  assert.equal(r.body.today, today);
  assert.deepEqual(Object.keys(r.body.days[0].kinds).sort(), ['forecast', 'presales', 'prices', 'staffing']);
  assert.equal(r.body.presales.days.length, 14);
  assert.equal(r.body.presales.days[1].sold, 8);
  assert.deepEqual(r.body.presales.days[1].last_year, { date: addDays(today, -363), sold: 7 });
  assert.equal(r.body.wind.points.length, 2);
  assert.ok(r.body.wind.points[0].hours.length >= 1 && r.body.wind.points[0].hours.every((h) => h.time.startsWith(today)));
  is(await api('PUT', '/reports/forecast-data/summit', { token: M.counter, body: { lat: 1, lng: 2 } }), 403);
  is(await api('PUT', '/reports/forecast-data/summit', { token: M.owner, body: { lat: 39.5, lng: null } }), 400);
  is(await api('PUT', '/reports/forecast-data/summit', { token: M.owner, body: { lat: null, lng: null } }), 200);
  assert.equal((await api('GET', '/reports/forecast-data', { token: M.owner })).body.points.summit, null);
});
