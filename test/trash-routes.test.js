'use strict';

// Collection routes and hauler oversight (release 2026.11.22, workstream "routes"), through real HTTP: routes built from
// the zones and the street order; who sees which route (Crew: their own, and today's nobody is on); start with the truck,
// odometer and pre-trip; Done / Skipped with a reason and a photo; replays from the phone's queue kept once; go-backs and
// the missed-pickup check; finishing costs the day by fund (Sanitation; plowing on Streets / Liquid Fuels) into the
// monthly report; a snow day moves the days, marks routes Delayed and drafts a street notice; the hauler's link (token,
// expiry, scope) and the scorecard's math; add-on gating (each add-on, a mountain); no money for crew and front desk;
// one municipality never reaches another's; the migration is up to date.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.PUBLIC_RATE_LIMIT = '100000';
process.env.USERS_RATE_LIMIT = '1000';
process.env.HAULER_RATE_LIMIT = '100000';
const MESSAGING = { POSTMARK_SERVER_TOKEN: 'pm', MAIL_FROM: 'noreply@test.example' };

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { createMuniTenant } = require('./helpers/muni');
const M = require('../src/lib/modules');

const KEY = 'test-bootstrap-key';
const PW = 'correct-horse-battery';
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
let server; let base; let mock;
const sink = [];
const q = async (sql, params) => (await pool.query(sql, params))[0];
const NY = 'America/New_York';
const todayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const nowIn = (tz) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`; };
const plus = (d, k) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const wd17 = (d) => { const w = new Date(`${d}T12:00:00Z`).getUTCDay(); return w === 0 ? 7 : w; };
const TODAY = todayIn(NY);

async function call(method, p, { token, body, raw } = {}) {
  const res = await fetch(`${base}${p}`, { method, headers: { 'content-type': raw ? 'application/octet-stream' : 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: raw || (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text, headers: res.headers };
}
const api = (m, p, o) => call(m, `/api/v1${p}`, o);
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${r.text}`);
const emails = (from) => sink.slice(from).filter((x) => x.u.startsWith('/email')).map((x) => JSON.parse(x.b));
const JPEG = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]), crypto.randomBytes(200), Buffer.from([0xff, 0xd9])]);
const cref = () => crypto.randomBytes(6).toString('hex');

let A; let B; let C; let D; let skiToken;
let crew1; let crew2; let desk; let mgr;
const S = {}; // A's streets by name
const Z = {}; // A's zones and streams

/** Turns an add-on on the way the platform does (a tenant_modules row), and clears the module cache. */
async function addon(m, key, on = true) {
  await q('INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)', [m.id, key, on ? 1 : 0]);
  M.invalidate(m.id);
}
/** A municipality's schedule (the schedule workstream's tables, written directly): zones, streams, days, streets. */
async function schedule(m, streetNames) {
  const ids = {};
  for (const name of streetNames) ids[name] = (await q('INSERT INTO streets (tenant_id, name) VALUES (?, ?)', [m.id, name])).insertId;
  const trash = (await q("INSERT INTO collection_streams (tenant_id, name, kind, frequency, color, sort) VALUES (?, 'Trash', 'trash', 'weekly', '#555555', 1)", [m.id])).insertId;
  const recycling = (await q("INSERT INTO collection_streams (tenant_id, name, kind, frequency, color, sort) VALUES (?, 'Recycling', 'recycling', 'weekly', '#1565c0', 2)", [m.id])).insertId;
  const north = (await q("INSERT INTO collection_zones (tenant_id, name, sort) VALUES (?, 'North', 1)", [m.id])).insertId;
  const south = (await q("INSERT INTO collection_zones (tenant_id, name, sort) VALUES (?, 'South', 2)", [m.id])).insertId;
  const w = wd17(TODAY);
  await q('INSERT INTO collection_zone_days (tenant_id, zone_id, stream_id, weekday) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)', [m.id, north, trash, w, m.id, north, recycling, w, m.id, south, trash, w]);
  await q("INSERT INTO collection_settings (tenant_id, model, holiday_rule) VALUES (?, 'inhouse', 'shift')", [m.id]);
  return { ids, trash, recycling, north, south };
}

test.before(async () => {
  mock = http.createServer((req, res) => {
    let data = ''; req.on('data', (c) => { data += c; });
    req.on('end', () => { sink.push({ u: req.url, b: data }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: `pm${sink.length}` })); });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockBase = `http://127.0.0.1:${mock.address().port}`;
  process.env.POSTMARK_API_BASE = mockBase;
  require('../src/lib/mailer').settings.apiBase = mockBase;
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await createMuniTenant(base, { slug: `rt-a-${suffix}`, name: `Riverton Borough ${suffix}`, modules: { solidwaste: true } });
  B = await createMuniTenant(base, { slug: `rt-b-${suffix}`, modules: { solidwaste: true } }); // Trash and recycling, no add-ons
  C = await createMuniTenant(base, { slug: `rt-c-${suffix}` }); // no Trash and recycling: the add-ons stay off
  D = await createMuniTenant(base, { slug: `rt-d-${suffix}`, modules: { solidwaste: true } }); // both add-ons: another town
  for (const m of [A, D]) { await addon(m, 'collectionroutes'); await addon(m, 'hauler'); }
  await addon(C, 'collectionroutes'); await addon(C, 'hauler');
  const sa = await schedule(A, ['Main Street', 'Bridge Street', 'Church Street', 'Oak Lane']);
  Object.assign(S, sa.ids); Object.assign(Z, sa);
  // North: Main Street whole, Bridge Street odd side 1 to 99. South: Church Street and Oak Lane.
  await q('INSERT INTO collection_zone_streets (tenant_id, zone_id, street_id) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)', [A.id, Z.north, S['Main Street'], A.id, Z.south, S['Church Street'], A.id, Z.south, S['Oak Lane']]);
  await q("INSERT INTO collection_zone_streets (tenant_id, zone_id, street_id, from_no, to_no, side) VALUES (?, ?, ?, 1, 99, 'odd')", [A.id, Z.north, S['Bridge Street']]);
  // The driving order for today's weekday: Oak Lane before Church Street, Bridge before Main.
  const w0 = new Date(`${TODAY}T12:00:00Z`).getUTCDay();
  for (const [i, name] of ['Oak Lane', 'Church Street', 'Bridge Street', 'Main Street'].entries()) await q("INSERT INTO bulk_route_order (tenant_id, weekday, street_id, position, direction) VALUES (?, ?, ?, ?, 'up')", [A.id, w0, S[name], i + 1]);
  const sd = await schedule(D, ['Elm Street']);
  await q('INSERT INTO collection_zone_streets (tenant_id, zone_id, street_id) VALUES (?, ?, ?)', [D.id, sd.north, sd.ids['Elm Street']]);
  crew1 = await A.addLogin('staff'); crew2 = await A.addLogin('staff'); desk = await A.addLogin('counter'); mgr = await A.addLogin('manager');
  const ski = await fetch(`${base}/api/v1/platform/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-platform-key': KEY }, body: JSON.stringify({ slug: `rt-sk-${suffix}`, name: `Pine Ridge ${suffix}`, billing: 'comped', owner: { email: `gm@rt-sk-${suffix}.test`, password: PW, first_name: 'G', last_name: 'M' } }) });
  assert.equal(ski.status, 201);
  skiToken = (await api('POST', '/auth/login', { body: { tenant: `rt-sk-${suffix}`, login: `gm@rt-sk-${suffix}.test`, password: PW } })).body.token;
  Object.assign(process.env, MESSAGING);
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => mock.close(r)); await pool.end(); });

const routeNamed = async (token, name, date = TODAY) => (await api('GET', `/solid-waste/routes?date=${date}`, { token })).body.routes.find((r) => r.name === name);
let truck; let truck2; let truckOut;
async function makeTruck(m, name, extra = {}) {
  const r = await api('POST', '/assets/register', { token: m.token, body: { name, kind: 'truck', miles: 12000, ...extra } });
  is(r, 201, `truck ${name}`);
  return r.body.id;
}

// ---------------------------------------------------------------- gating
test('each add-on is gated: off for a town without it, without Trash and recycling, and for a mountain', async () => {
  is(await api('GET', '/solid-waste/routes', { token: A.token }), 200);
  is(await api('GET', '/solid-waste/hauler/contract', { token: A.token }), 200);
  for (const [token, why] of [[B.token, 'no add-ons'], [C.token, 'add-ons on, Trash and recycling off']]) {
    const r = await api('GET', '/solid-waste/routes', { token });
    is(r, 403, why); assert.equal(r.body.details.code, 'module_disabled');
    is(await api('GET', '/solid-waste/hauler/contract', { token }), 403, why);
  }
  await addon(B, 'collectionroutes');
  is(await api('GET', '/solid-waste/routes', { token: B.token }), 200, 'routes on');
  const h = await api('GET', '/solid-waste/hauler/missed', { token: B.token });
  is(h, 403, 'the hauler add-on is its own'); assert.equal(h.body.details.module, 'hauler');
  await addon(B, 'collectionroutes', false);
  is(await api('GET', '/solid-waste/routes', { token: skiToken }), 403, 'a ski area');
  is(await api('GET', '/solid-waste/hauler/scorecard', { token: skiToken }), 403, 'a ski area');
});

// ---------------------------------------------------------------- building
test('today\'s routes are built from the zones and the street order; a later day is a preview', async () => {
  const day = (await api('GET', `/solid-waste/routes?date=${TODAY}`, { token: A.token })).body;
  assert.equal(day.kept, true);
  assert.deepEqual(day.routes.map((r) => r.name).sort(), ['North, Recycling', 'North, Trash', 'South, Trash']);
  const south = await api('GET', `/solid-waste/routes/${day.routes.find((r) => r.name === 'South, Trash').id}`, { token: A.token });
  is(south, 200);
  assert.deepEqual(south.body.stops.map((s) => s.words), ['Oak Lane', 'Church Street'], 'the bulk pickup driving order');
  const north = (await api('GET', `/solid-waste/routes/${day.routes.find((r) => r.name === 'North, Trash').id}`, { token: A.token })).body;
  assert.deepEqual(north.stops.map((s) => s.words), ['Bridge Street 1 to 99, odd side', 'Main Street']);
  // Opening it again builds nothing twice.
  await api('GET', `/solid-waste/routes?date=${TODAY}`, { token: A.token });
  const [c] = await q('SELECT COUNT(*) AS n FROM collection_route_stops s JOIN collection_routes r ON r.id = s.route_id WHERE r.tenant_id = ? AND r.on_date = ?', [A.id, TODAY]);
  assert.equal(Number(c.n), 6);
  const later = (await api('GET', `/solid-waste/routes?date=${plus(TODAY, 7)}`, { token: A.token })).body;
  assert.equal(later.kept, false); assert.equal(later.routes.length, 3); assert.equal(later.routes[0].id, null);
});

// ---------------------------------------------------------------- who sees what
test('crew see their own routes and today\'s that nobody is on; the front desk reads but marks nothing', async () => {
  const nt = await routeNamed(A.token, 'North, Trash');
  is(await api('PUT', `/solid-waste/routes/${nt.id}/crew`, { token: crew1.token, body: { user_ids: [crew1.id] } }), 403, 'crew do not assign crew');
  is(await api('PUT', `/solid-waste/routes/${nt.id}/crew`, { token: mgr.token, body: { user_ids: [crew1.id] } }), 200);
  const c1 = (await api('GET', '/solid-waste/routes', { token: crew1.token })).body.routes.map((r) => r.name).sort();
  assert.deepEqual(c1, ['North, Recycling', 'North, Trash', 'South, Trash'], 'crew1: theirs, and the two nobody is on');
  const c2 = (await api('GET', '/solid-waste/routes', { token: crew2.token })).body.routes.map((r) => r.name).sort();
  assert.deepEqual(c2, ['North, Recycling', 'South, Trash'], 'crew2 does not see a route crew1 is on');
  is(await api('GET', `/solid-waste/routes/${nt.id}`, { token: crew2.token }), 404, 'nor open it');
  const d = await api('GET', `/solid-waste/routes/${nt.id}`, { token: desk.token });
  is(d, 200); assert.equal(d.body.can_work, false);
  is(await api('POST', `/solid-waste/routes/${nt.id}/stops/${d.body.stops[0].id}/mark`, { token: desk.token, body: { status: 'done' } }), 403, 'the front desk marks nothing');
  is(await api('POST', `/solid-waste/routes/${nt.id}/stops/${d.body.stops[0].id}/mark`, { token: crew2.token, body: { status: 'done' } }), 404, 'another crew cannot mark it');
});

// ---------------------------------------------------------------- the truck
test('starting a route: the truck from Assets and fleet, the pre-trip check, the odometer', async () => {
  truck = await makeTruck(A, `Truck 12 ${suffix}`);
  truck2 = await makeTruck(A, `Truck 14 ${suffix}`);
  truckOut = await makeTruck(A, `Truck 9 ${suffix}`);
  await q("UPDATE ops_assets SET status = 'out_of_service' WHERE tenant_id = ? AND id = ?", [A.id, truckOut]);
  const nt = await routeNamed(crew1.token, 'North, Trash');
  const r = await api('GET', `/solid-waste/routes/${nt.id}`, { token: crew1.token });
  assert.ok(r.body.trucks.some((x) => x.id === truck));
  assert.equal(r.body.trucks.find((x) => x.id === truckOut).out_of_service, true);
  const out = await api('POST', `/solid-waste/routes/${nt.id}/start`, { token: crew1.token, body: { truck_id: truckOut, pretrip_skipped: true } });
  is(out, 409); assert.match(out.body.error, /out of service/);
  const need = await api('POST', `/solid-waste/routes/${nt.id}/start`, { token: crew1.token, body: { truck_id: truck, odometer: 12100 } });
  is(need, 400); assert.equal(need.body.details.code, 'pretrip_needed');
  // The pre-trip check is Assets and fleet's own checklist, done on the truck.
  const tpl = (await api('GET', '/assets/templates', { token: crew1.token })).body.data.find((x) => /pre-trip/i.test(x.name) && (x.kinds || '').includes('truck'));
  assert.ok(tpl, 'a municipality has the truck pre-trip');
  const items = (typeof tpl.items === 'string' ? JSON.parse(tpl.items) : tpl.items).map((it) => (it.type === 'number' ? { key: it.key, value: 12100 } : { key: it.key, result: 'pass' }));
  const insp = await api('POST', `/assets/register/${truck}/inspections`, { token: crew1.token, body: { template_id: tpl.id, items } });
  is(insp, 201);
  const back = await api('POST', `/solid-waste/routes/${nt.id}/start`, { token: crew1.token, body: { truck_id: truck, odometer: 100 } });
  is(back, 400, 'an odometer that goes back'); assert.match(back.body.error, /only goes up/);
  is(await api('POST', `/solid-waste/routes/${nt.id}/start`, { token: crew1.token, body: { truck_id: truck, odometer: 12150 } }), 200);
  const v = (await api('GET', `/solid-waste/routes/${nt.id}`, { token: crew1.token })).body;
  assert.equal(v.status, 'started'); assert.equal(v.pretrip, 'done'); assert.equal(v.odometer_start, 12150); assert.equal(v.truck_id, truck);
  const [a] = await q('SELECT miles FROM ops_assets WHERE id = ?', [truck]);
  assert.equal(Number(a.miles), 12150, 'the register\'s odometer moved');
  const busy = await api('POST', `/solid-waste/routes/${(await routeNamed(crew1.token, 'North, Recycling')).id}/start`, { token: crew1.token, body: { truck_id: truck, pretrip_skipped: true } });
  is(busy, 409, 'a truck already out'); assert.match(busy.body.error, /is out on/);
});

// ---------------------------------------------------------------- done and skipped
test('Done, and Skipped with a reason and a photo; the photo is kept as taken', async () => {
  const nt = await routeNamed(crew1.token, 'North, Trash');
  const v = (await api('GET', `/solid-waste/routes/${nt.id}`, { token: crew1.token })).body;
  const [bridge, main] = v.stops;
  const mark = (stop, body) => api('POST', `/solid-waste/routes/${nt.id}/stops/${stop.id}/mark`, { token: crew1.token, body });
  is(await mark(bridge, { status: 'skipped' }), 400, 'a reason');
  const nophoto = await mark(bridge, { status: 'skipped', reason: 'parked_cars' });
  is(nophoto, 400); assert.match(nophoto.body.error, /photo/);
  is(await mark(bridge, { status: 'skipped', reason: 'other' }), 400, 'other needs words');
  // A photo from another route is refused.
  const sr = await routeNamed(crew1.token, 'South, Trash');
  const other = await api('POST', `/solid-waste/routes/${sr.id}/photos?client_ref=${cref()}`, { token: crew1.token, raw: JPEG() });
  is(other, 201);
  is(await mark(bridge, { status: 'skipped', reason: 'parked_cars', photo_id: other.body.id }), 400, 'not this route\'s photo');
  const buf = JPEG();
  const ph = await api('POST', `/solid-waste/routes/${nt.id}/photos?stop_id=${bridge.id}&lat=40.13&lng=-75.51&client_ref=${cref()}`, { token: crew1.token, raw: buf });
  is(ph, 201); assert.equal(ph.body.sha256, crypto.createHash('sha256').update(buf).digest('hex'));
  is(await mark(bridge, { status: 'skipped', reason: 'parked_cars', photo_id: ph.body.id, lat: 40.13, lng: -75.51, client_ref: cref() }), 200);
  is(await mark(main, { status: 'done', lat: 40.131, lng: -75.512, client_ref: cref() }), 200);
  const got = await api('GET', `/solid-waste/routes/${nt.id}/photos/${ph.body.id}`, { token: mgr.token });
  is(got, 200); assert.equal(got.headers.get('x-content-sha256'), ph.body.sha256);
  const after = (await api('GET', `/solid-waste/routes/${nt.id}`, { token: crew1.token })).body;
  assert.deepEqual(after.progress, { total: 2, done: 1, skipped: 1, left: 0, percent: 100 });
  assert.equal(after.stops[0].reason_words, 'Parked cars');
  const board = (await api('GET', '/solid-waste/routes/board', { token: desk.token })).body;
  assert.equal(board.points.filter((p) => p.route_id === nt.id).length, 2, 'the marks are on the office map');
  is(await api('GET', '/solid-waste/routes/board', { token: crew1.token }), 403, 'the board is the office\'s');
});

test('replays from the phone\'s queue are kept once; an older tap arriving late does not undo a newer one', async () => {
  const sr = await routeNamed(crew2.token, 'South, Trash');
  const v = (await api('GET', `/solid-waste/routes/${sr.id}`, { token: crew2.token })).body;
  const oak = v.stops[0];
  const ref = cref();
  const body = { status: 'done', client_ref: ref, at: nowIn(NY).replace(' ', 'T'), queued: true };
  const a = await api('POST', `/solid-waste/routes/${sr.id}/stops/${oak.id}/mark`, { token: crew2.token, body });
  const b = await api('POST', `/solid-waste/routes/${sr.id}/stops/${oak.id}/mark`, { token: crew2.token, body });
  is(a, 200); is(b, 200); assert.equal(b.body.repeat, true);
  const [m] = await q('SELECT COUNT(*) AS n FROM collection_stop_marks WHERE tenant_id = ? AND client_ref = ?', [A.id, ref]);
  assert.equal(Number(m.n), 1);
  // A photo sent twice with the same id is one photo.
  const pref = cref(); const buf = JPEG();
  const p1 = await api('POST', `/solid-waste/routes/${sr.id}/photos?client_ref=${pref}&queued=1`, { token: crew2.token, raw: buf });
  const p2 = await api('POST', `/solid-waste/routes/${sr.id}/photos?client_ref=${pref}&queued=1`, { token: crew2.token, raw: buf });
  is(p1, 201); is(p2, 200); assert.equal(p2.body.id, p1.body.id); assert.equal(p2.body.repeat, true);
  // A Skipped from the queue names its photo by the photo's own id from the phone (photo_ref).
  const church = v.stops[1];
  is(await api('POST', `/solid-waste/routes/${sr.id}/stops/${church.id}/mark`, { token: crew2.token, body: { status: 'skipped', reason: 'contaminated', photo_ref: pref, client_ref: cref(), queued: true } }), 200);
  // A tap taken an hour earlier, sent late: kept in the history, the stop stays as marked since.
  const old = await api('POST', `/solid-waste/routes/${sr.id}/stops/${oak.id}/mark`, { token: crew2.token, body: { status: 'skipped', reason: 'blocked', photo_ref: pref, client_ref: cref(), queued: true, at: `${TODAY}T00:01` } });
  is(old, 200); assert.equal(old.body.stale, true); assert.equal(old.body.status, 'done');
  // crew2 is on South now (the first tap put them on it): crew1 no longer sees it.
  is(await api('GET', `/solid-waste/routes/${sr.id}`, { token: crew1.token }), 404);
});

// ---------------------------------------------------------------- go-backs and the missed-pickup check
let missedCat;
async function missedRequest(m, streetId, house, reportedAt = null) {
  if (!missedCat) { is(await api('GET', '/requests/meta', { token: m.token }), 200); missedCat = true; }
  const [cat] = await q("SELECT id FROM request_categories WHERE tenant_id = ? AND name LIKE 'Missed%'", [m.id]);
  const ref = `R${crypto.randomBytes(4).toString('hex').toUpperCase()}`.slice(0, 12);
  const r = await q("INSERT INTO requests (tenant_id, reference, status_token, category_id, street_id, house_number, description, source, reported_at) VALUES (?, ?, ?, ?, ?, ?, 'Resident Ruth Private, 610-555-0199', 'phone', ?)",
    [m.id, ref, crypto.randomBytes(16).toString('hex'), cat.id, streetId, house, reportedAt || nowIn(NY)]);
  return { id: r.insertId, reference: ref };
}

test('the missed-pickup check reads the route: done with the time, skipped with the reason, not yet', async () => {
  const check = async (street, no, stream) => (await api('GET', `/solid-waste/routes/check?street_id=${S[street]}&house_number=${no}&stream_id=${stream}`, { token: desk.token })).body.result;
  const done = await check('Main Street', '120', Z.trash);
  assert.equal(done.outcome, 'done'); assert.ok(done.at.startsWith(TODAY));
  const skipped = await check('Bridge Street', '15', Z.trash);
  assert.equal(skipped.outcome, 'skipped'); assert.equal(skipped.reason_words, 'Parked cars');
  assert.equal((await check('Main Street', '120', Z.recycling)).outcome, 'not_yet', 'recycling has not been yet');
  assert.equal(await check('Bridge Street', '16', Z.trash), null, 'the even side is in no zone');
  is(await api('GET', `/solid-waste/routes/check?street_id=${S['Main Street']}`, { token: crew1.token }), 403, 'the office\'s');
  // The schedule's own missed-pickup check (lib/collection.js pickupCheck) answers from the route: each outcome.
  const sched = async (street, no, stream) => (await api('GET', `/solid-waste/collection/check?street=${S[street]}&no=${no}&stream=${stream}`, { token: desk.token })).body;
  const d1 = await sched('Main Street', '120', Z.trash);
  assert.equal(d1.outcome, 'done'); assert.match(d1.message, /marked your street done/);
  const s1 = await sched('Bridge Street', '15', Z.trash);
  assert.equal(s1.outcome, 'skipped'); assert.match(s1.message, /parked cars/);
  const n1 = await sched('Main Street', '120', Z.recycling);
  assert.equal(n1.outcome, 'not_yet'); assert.match(n1.message, /still on its route/);
});

test('a go-back goes on the day\'s route, counts for the crew on it and managers, and closes the missed pickup', async () => {
  const req = await missedRequest(A, S['Bridge Street'], '15');
  is(await api('POST', '/solid-waste/routes/gobacks', { token: crew1.token, body: { request_id: req.id } }), 403, 'the office adds go-backs');
  const g = await api('POST', '/solid-waste/routes/gobacks', { token: desk.token, body: { request_id: req.id, stream_id: Z.trash, due_on: TODAY, note: 'Cars gone now' } });
  is(g, 201);
  is(await api('POST', '/solid-waste/routes/gobacks', { token: desk.token, body: { request_id: req.id } }), 409, 'one waiting at a time');
  const nt = await routeNamed(crew1.token, 'North, Trash');
  const v = (await api('GET', `/solid-waste/routes/${nt.id}`, { token: crew1.token })).body;
  const stop = v.stops.find((s) => s.kind === 'goback');
  assert.ok(stop, 'on North, Trash'); assert.equal(stop.words, '15 Bridge Street');
  const counts = async (token) => (await api('GET', '/nav/counts', { token })).body;
  const cm = await counts(mgr.token); const c1 = await counts(crew1.token); const c2 = await counts(crew2.token);
  assert.equal((cm.counts || cm).bulk.n >= 1, true, 'managers: all');
  assert.equal((c1.counts || c1).bulk.n, 1, 'crew1: on their route');
  assert.equal((c2.counts || c2).bulk, undefined, 'crew2: none of theirs');
  const today = (await api('GET', '/solid-waste/routes/today', { token: mgr.token })).body.cards;
  const missed = await require('../src/lib/waiting').missedPickups(pool, A.id); // schedule's part of the same count
  assert.equal(today.find((c) => /go back/.test(c.title)).count + missed, (cm.counts || cm).bulk.n, 'the count is the Today card\'s go-backs plus the missed pickups waiting');
  const appToday = (await api('GET', '/solid-waste/today', { token: mgr.token })).body.cards;
  assert.ok(appToday.some((c) => /go back/.test(c.title)) && appToday.some((c) => c.title === 'Collection routes today'), 'the cards are on Trash and recycling\'s Today');
  is(await api('POST', `/solid-waste/routes/${nt.id}/stops/${stop.id}/mark`, { token: crew1.token, body: { status: 'done', client_ref: cref() } }), 200);
  const [r] = await q('SELECT status FROM requests WHERE id = ?', [req.id]);
  assert.equal(r.status, 'fixed');
  assert.equal(((await counts(crew1.token)).counts || {}).bulk, undefined);
});

// ---------------------------------------------------------------- finishing and costs
test('finishing costs the day on the Sanitation fund: crew hours, truck hours, tipping fees; tickets go to tonnage', async () => {
  await q('UPDATE ops_assets SET hourly_rate_cents = 9000 WHERE id = ?', [truck]);
  const nt = await routeNamed(crew1.token, 'North, Trash');
  const fin = await api('POST', `/solid-waste/routes/${nt.id}/finish`, { token: crew1.token, body: { odometer: 12190, truck_hours: 6.5, crew: [{ user_id: crew1.id, hours: 7 }], client_ref: cref(),
    tickets: [{ facility: 'Pottstown Landfill', ticket_no: 'L-4411', net_tons: 8.25, fee_cents: 57750, client_ref: cref() }] } });
  is(fin, 200);
  const again = await api('POST', `/solid-waste/routes/${nt.id}/finish`, { token: crew1.token, body: { client_ref: cref() } });
  is(again, 200, 'sent again from the queue'); assert.equal(again.body.repeat, true);
  const [wo] = await q('SELECT w.status, d.name AS dept, f.name AS fund FROM work_orders w LEFT JOIN departments d ON d.id = w.department_id LEFT JOIN funds f ON f.id = w.fund_id WHERE w.tenant_id = ? AND w.id = ?', [A.id, fin.body.work_order_id]);
  assert.deepEqual([wo.status, wo.dept, wo.fund], ['done', 'Sanitation', 'Sanitation']);
  const costs = (await api('GET', `/solid-waste/routes/costs?from=${TODAY}&to=${TODAY}`, { token: mgr.token })).body;
  const day = costs.days.find((x) => x.job === 'collection');
  assert.equal(day.truck_hours, 6.5); assert.equal(day.crew_hours, 7); assert.equal(day.tons, 8.25);
  assert.equal(day.equipment_cents, 58500); assert.equal(day.tipping_cents, 57750);
  assert.equal(day.total_cents, day.labor_cents + 58500 + 57750);
  // The monthly report's Sanitation line has it.
  const rep = await api('GET', `/assets/month-report?month=${TODAY.slice(0, 7)}`, { token: mgr.token });
  is(rep, 200);
  const san = rep.body.by_department.find((x) => x.name === 'Sanitation');
  assert.ok(san && san.total_cents >= day.total_cents, 'the Sanitation line of the monthly report has the day');
  assert.ok(rep.body.by_fund.find((x) => x.name === 'Sanitation'), 'and the Sanitation fund');
  const [k] = await q('SELECT net_tons, fee_cents FROM collection_route_tickets WHERE tenant_id = ? AND route_id = ?', [A.id, nt.id]);
  assert.equal(Number(k.net_tons), 8.25);
  // And the ticket is in the tonnage records (tonnage's addTicket), at a facility made from the name the driver typed.
  const [w] = await q("SELECT w.net_lb, w.fee_cents, w.source, w.ticket_no, f.name AS facility, f.kind FROM weigh_tickets w JOIN tonnage_facilities f ON f.id = w.facility_id WHERE w.tenant_id = ? AND w.ticket_no = 'L-4411'", [A.id]);
  assert.ok(w, 'the driver ticket reached tonnage');
  assert.equal(Number(w.net_lb), 16500); assert.equal(Number(w.fee_cents), 57750); assert.equal(w.source, 'driver'); assert.equal(w.facility, 'Pottstown Landfill');
});

test('plowing hours go on Streets and the Liquid Fuels fund; a changeover is a work order on the truck', async () => {
  const p = await api('POST', `/solid-waste/routes/trucks/${truck2}/hours`, { token: mgr.token, body: { job: 'plowing', hours: 4 } });
  is(p, 201);
  const [wo] = await q('SELECT d.name AS dept, f.name AS fund, f.kind FROM work_orders w LEFT JOIN departments d ON d.id = w.department_id LEFT JOIN funds f ON f.id = w.fund_id WHERE w.id = ?', [p.body.work_order_id]);
  assert.deepEqual([wo.dept, wo.fund], ['Streets', 'Liquid Fuels']);
  const ch = await api('POST', `/solid-waste/routes/trucks/${truck2}/changeover`, { token: crew1.token, body: { to: 'plow' } });
  is(ch, 201);
  const [w2] = await q('SELECT title, asset_id FROM work_orders WHERE id = ?', [ch.body.work_order_id]);
  assert.match(w2.title, /plow and spreader/); assert.equal(Number(w2.asset_id), truck2);
  const tr = (await api('GET', '/solid-waste/routes/trucks', { token: crew1.token })).body.data.find((x) => x.id === truck2);
  assert.equal(tr.plows, true); assert.equal(tr.setup, 'plow');
  is(await api('POST', `/solid-waste/routes/trucks/${truck2}/hours`, { token: crew1.token, body: { job: 'plowing', hours: 1, crew: [{ staff_id: 999999, hours: 1 }] } }), 400, 'crew log their own hours');
});

test('no money for crew and front desk: costs are a manager\'s, and every path is scrubbed', async () => {
  is(await api('GET', '/solid-waste/routes/costs', { token: crew1.token }), 403);
  is(await api('GET', '/solid-waste/routes/costs', { token: desk.token }), 403);
  const scan = (v) => JSON.stringify(v).match(/"[a-z_]*(cents|cost)[a-z_]*":\s*\d/g);
  for (const token of [crew1.token, desk.token]) {
    for (const p of ['/solid-waste/routes', '/solid-waste/routes/trucks', `/solid-waste/routes/${(await routeNamed(mgr.token, 'North, Trash')).id}`, '/solid-waste/hauler/contract', `/solid-waste/hauler/scorecard?month=${TODAY.slice(0, 7)}`, '/SOLID-WASTE/Hauler/contract']) {
      const r = await api('GET', p, { token });
      if (r.status === 200) assert.equal(scan(r.body), null, `${p} has no money for ${token === desk.token ? 'the desk' : 'crew'}`);
    }
  }
});

// ---------------------------------------------------------------- snow
test('a snow day: changes by the holiday rule, routes Delayed for snow, a drafted street notice; undo puts it back', async () => {
  is(await api('POST', '/solid-waste/routes/snow-days', { token: crew1.token, body: { on_date: TODAY } }), 403, 'a manager declares it');
  const r = await api('POST', '/solid-waste/routes/snow-days', { token: mgr.token, body: { on_date: TODAY, zone_ids: [Z.north], note: 'Six inches overnight' } });
  is(r, 201);
  const next = (() => { const x = plus(TODAY, 1); return new Date(`${x}T12:00:00Z`).getUTCDay() === 0 ? plus(TODAY, 2) : x; })();
  assert.deepEqual(r.body.changes, [{ from: TODAY, to: next }], 'one zone: that day only moves');
  const [ch] = await q("SELECT reason, moved_to, notice_id FROM collection_changes WHERE tenant_id = ? AND on_date = ? AND reason = 'snow'", [A.id, TODAY]);
  assert.equal(String(ch.moved_to instanceof Date ? ch.moved_to.toISOString() : ch.moved_to).slice(0, 10), next);
  const [n] = await q('SELECT status, type, sms_text FROM street_notices WHERE id = ?', [r.body.notice_id]);
  assert.equal(n.status, 'draft', 'drafted, not sent'); assert.equal(n.type, 'trash_change'); assert.match(n.sms_text, /snow/i);
  const areas = await q('SELECT street_id, from_no, to_no, side FROM street_notice_areas WHERE notice_id = ? ORDER BY street_id', [r.body.notice_id]);
  assert.deepEqual(areas.map((a) => Number(a.street_id)).sort(), [S['Main Street'], S['Bridge Street']].sort(), 'North\'s streets only');
  const day = (await api('GET', `/solid-waste/routes?date=${TODAY}`, { token: mgr.token })).body;
  const nr = day.routes.find((x) => x.name === 'North, Recycling');
  assert.equal(nr.status, 'delayed'); assert.match(nr.status_words, /Delayed for snow/);
  assert.equal(day.routes.find((x) => x.name === 'South, Trash').status, 'started', 'South still runs');
  const v = (await api('GET', `/solid-waste/routes/${nr.id}`, { token: crew1.token })).body;
  const m = await api('POST', `/solid-waste/routes/${nr.id}/stops/${v.stops[0].id}/mark`, { token: crew1.token, body: { status: 'done' } });
  is(m, 409); assert.match(m.body.error, /delayed/);
  const check = (await api('GET', `/solid-waste/routes/check?street_id=${S['Main Street']}&house_number=5&stream_id=${Z.recycling}`, { token: desk.token })).body.result;
  assert.equal(check.outcome, 'not_yet'); assert.equal(check.delayed, true);
  const nextDay = (await api('GET', `/solid-waste/routes?date=${next}`, { token: mgr.token })).body;
  assert.ok(nextDay.moved_in.length, 'the next day shows what moved to it');
  assert.ok(nextDay.routes.some((x) => x.name === 'North, Recycling'), 'North recycling runs the next day');
  is(await api('POST', '/solid-waste/routes/snow-days', { token: mgr.token, body: { on_date: TODAY, zone_ids: [Z.north] } }), 409, 'declared already');
  const u = await api('POST', `/solid-waste/routes/snow-days/${r.body.id}/undo`, { token: mgr.token });
  is(u, 200); assert.equal(u.body.notice_sent, false);
  assert.equal((await q('SELECT id FROM street_notices WHERE id = ?', [r.body.notice_id])).length, 0, 'the unsent draft is gone');
  assert.equal((await routeNamed(mgr.token, 'North, Recycling')).status, 'planned');
});

test('a whole-borough snow day with the shift rule moves the rest of the week', async () => {
  const dd = plus(TODAY, 7 + ((8 - wd17(TODAY)) % 7)); // a Monday next week or after
  const w = wd17(dd);
  assert.equal(w, 1);
  // Collection on Monday and Wednesday in D.
  const [z] = await q('SELECT id FROM collection_zones WHERE tenant_id = ? LIMIT 1', [D.id]);
  const [s] = await q('SELECT id FROM collection_streams WHERE tenant_id = ? AND kind = ? LIMIT 1', [D.id, 'trash']);
  await q('DELETE FROM collection_zone_days WHERE tenant_id = ?', [D.id]);
  await q('INSERT INTO collection_zone_days (tenant_id, zone_id, stream_id, weekday) VALUES (?, ?, ?, 1)', [D.id, z.id, s.id]);
  const z2 = (await q("INSERT INTO collection_zones (tenant_id, name) VALUES (?, 'Wednesday')", [D.id])).insertId;
  await q('INSERT INTO collection_zone_days (tenant_id, zone_id, stream_id, weekday) VALUES (?, ?, ?, 3)', [D.id, z2, s.id]);
  const r = await api('POST', '/solid-waste/routes/snow-days', { token: D.token, body: { on_date: dd } });
  is(r, 201);
  assert.deepEqual(r.body.changes, [{ from: dd, to: plus(dd, 1) }, { from: plus(dd, 2), to: plus(dd, 3) }]);
});

// ---------------------------------------------------------------- hauler oversight
test('a missed pickup goes to the contracted hauler with a no-login link: the address only, 30 days, one request', async () => {
  is(await api('PUT', '/solid-waste/hauler/contract', { token: desk.token, body: {} }), 403, 'a manager sets the contract');
  const k = await api('PUT', '/solid-waste/hauler/contract', { token: mgr.token, body: { hauler_name: 'Valley Waste', starts_on: `${TODAY.slice(0, 4)}-01-01`, service_hours: 24, households: 3600, price_per_household_cents: 22800, penalty_cents: 5000, penalty_after: 1 } });
  is(k, 200);
  const inhouse = await missedRequest(A, S['Oak Lane'], '7');
  const no = await api('POST', `/solid-waste/hauler/missed/${inhouse.id}/forward`, { token: desk.token });
  is(no, 409, 'only where a contracted hauler collects');
  await q("UPDATE collection_settings SET model = 'contract', hauler_name = 'Valley Waste', hauler_email = 'dispatch@valley.test' WHERE tenant_id = ?", [A.id]);
  const before = sink.length;
  await require('../src/lib/collectionroutes').forwardDue('https://app.test');
  const mail = emails(before).filter((e) => e.To === 'dispatch@valley.test');
  assert.ok(mail.length >= 1, 'the job emailed the hauler');
  const mine = mail.find((e) => e.TextBody.includes(inhouse.reference));
  assert.ok(mine);
  assert.match(mine.TextBody, /7 Oak Lane/);
  assert.doesNotMatch(mine.TextBody, /Ruth|610-555|Private/, 'never the resident\'s name, phone or words');
  const link = /https:\/\/app\.test\/hauler\/([^/]+)\/([A-Za-z0-9_-]+)/.exec(mine.TextBody);
  assert.equal(link[1], A.slug);
  const token = link[2];
  assert.ok(token.length >= 43, '32 random bytes');
  const [row] = await q('SELECT token_hash FROM hauler_forwards WHERE tenant_id = ? AND request_id = ?', [A.id, inhouse.id]);
  assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'), 'kept only as a hash');
  const pub = await call('GET', `/api/v1/public/${A.slug}/hauler/${token}`);
  is(pub, 200); assert.equal(pub.body.address, '7 Oak Lane'); assert.equal(JSON.stringify(pub.body).includes('Ruth'), false);
  is(await call('GET', `/api/v1/public/${D.slug}/hauler/${token}`), 404, 'another town\'s address with this link');
  is(await call('GET', `/api/v1/public/${A.slug}/hauler/${token.slice(0, -2)}xx`), 404, 'a wrong link');
  is(await call('GET', `/api/v1/public/${B.slug}/hauler/${token}`), 404, 'a town without the add-on');
  const page = await call('GET', `/hauler/${A.slug}/${token}`);
  is(page, 200); assert.match(page.text, /haulerpage\.js/);
  const done = await call('POST', `/api/v1/public/${A.slug}/hauler/${token}/collected`, { body: { note: 'Picked up 9:40' } });
  is(done, 200); assert.ok(done.body.collected_at);
  const [rq] = await q('SELECT status FROM requests WHERE id = ?', [inhouse.id]);
  assert.equal(rq.status, 'fixed');
  // Expired: 30 days on.
  await q('UPDATE hauler_forwards SET expires_at = ? WHERE tenant_id = ? AND request_id = ?', [`${plus(TODAY, -1)} 00:00:00`, A.id, inhouse.id]);
  is(await call('GET', `/api/v1/public/${A.slug}/hauler/${token}`), 410, 'the link has expired');
  // A resend makes a new link; the old one stops working.
  const again = await api('POST', `/solid-waste/hauler/missed/${inhouse.id}/forward`, { token: desk.token });
  is(again, 201); assert.equal(again.body.link, undefined, 'the office does not get the link');
  is(await call('GET', `/api/v1/public/${A.slug}/hauler/${token}`), 404);
});

test('the monthly scorecard: on time, late, still open, hours to collect, by zone, and penalties for managers', async () => {
  const month = TODAY.slice(0, 7);
  const before = (await api('GET', `/solid-waste/hauler/scorecard?month=${month}`, { token: mgr.token })).body;
  // Reported on the 1st at 08:00: one collected in 10 hours, one in 30 hours (late), one never (late, open).
  const at = `${month}-01 08:00:00`;
  const mk = async (street, no, got) => {
    const r = await missedRequest(A, S[street], no, at);
    await q('INSERT INTO hauler_forwards (tenant_id, request_id, token_hash, expires_at, reported_at, due_at, collected_at, collected_via) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [A.id, r.id, crypto.randomBytes(32).toString('hex'), `${plus(TODAY, 30)} 00:00:00`, at, `${month}-02 08:00:00`, got, got ? 'link' : null]);
  };
  await mk('Main Street', '10', `${month}-01 18:00:00`);
  await mk('Church Street', '11', `${month}-02 14:00:00`);
  await mk('Oak Lane', '12', null);
  const s = (await api('GET', `/solid-waste/hauler/scorecard?month=${month}`, { token: mgr.token })).body;
  assert.equal(s.missed - before.missed, 3);
  assert.equal(s.on_time - before.on_time, 1); assert.equal(s.late - before.late, 1);
  const openLate = TODAY > `${month}-02` ? 1 : 0;
  assert.equal(s.open_late - before.open_late, openLate);
  assert.ok(s.by_zone.find((z) => z.zone === 'South').missed >= 2);
  assert.equal(s.penalties.free, 1);
  assert.equal(s.penalties.total_cents, Math.max(0, s.late + s.open_late - 1) * 5000);
  assert.equal(s.contract_month_cents, Math.round((22800 * 3600) / 12));
  const d = (await api('GET', `/solid-waste/hauler/scorecard?month=${month}`, { token: desk.token })).body;
  assert.equal(d.penalties, undefined, 'the desk sees the counts, not the money');
  assert.equal(d.contract.price_per_household_cents, undefined);
  is(await api('GET', '/solid-waste/hauler/scorecard?month=2026-13', { token: mgr.token }), 400);
});

// ---------------------------------------------------------------- isolation and migration
test('one municipality never reaches another\'s routes, stops, photos, go-backs or hauler forwards', async () => {
  const nt = await routeNamed(A.token, 'North, Trash');
  const v = (await api('GET', `/solid-waste/routes/${nt.id}`, { token: A.token })).body;
  is(await api('GET', `/solid-waste/routes/${nt.id}`, { token: D.token }), 404);
  is(await api('POST', `/solid-waste/routes/${nt.id}/stops/${v.stops[0].id}/mark`, { token: D.token, body: { status: 'done' } }), 404);
  is(await api('POST', `/solid-waste/routes/${nt.id}/start`, { token: D.token, body: { truck_id: truck, pretrip_skipped: true } }), 404);
  is(await api('PUT', `/solid-waste/routes/${nt.id}/crew`, { token: D.token, body: { user_ids: [] } }), 404);
  const ph = await q('SELECT id FROM collection_photos WHERE tenant_id = ? AND route_id = ? LIMIT 1', [A.id, nt.id]);
  is(await api('GET', `/solid-waste/routes/${nt.id}/photos/${ph[0].id}`, { token: D.token }), 404);
  const [g] = await q('SELECT id FROM collection_gobacks WHERE tenant_id = ? LIMIT 1', [A.id]);
  is(await api('POST', `/solid-waste/routes/gobacks/${g.id}/cancel`, { token: D.token }), 404);
  is(await api('POST', `/solid-waste/routes/trucks/${truck}/changeover`, { token: D.token, body: { to: 'plow' } }), 404);
  const [f] = await q('SELECT id, request_id FROM hauler_forwards WHERE tenant_id = ? LIMIT 1', [A.id]);
  is(await api('POST', `/solid-waste/hauler/forwards/${f.id}/collected`, { token: D.token, body: {} }), 404);
  await q("INSERT INTO collection_settings (tenant_id, model, hauler_email) VALUES (?, 'contract', 'x@d.test') ON DUPLICATE KEY UPDATE model = 'contract', hauler_email = 'x@d.test'", [D.id]);
  is(await api('POST', `/solid-waste/hauler/missed/${f.request_id}/forward`, { token: D.token }), 404);
  is(await api('POST', '/solid-waste/routes/gobacks', { token: D.token, body: { street_id: S['Main Street'] } }), 400);
});

test('the migration is up to date: running it again applies nothing', () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'db', 'migrate.js')], { env: process.env, encoding: 'utf8' });
  assert.match(out, /\(0 changes applied\)/);
});
