'use strict';

// A demo built on the visitor's own mountain: found on OpenStreetMap (through the Overpass API), confirmed with a drawing
// of its lifts and runs, and built with those real names, its place and its map. Overpass is replaced here by a stub
// that answers like it does, for one made-up ski area.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.SANDBOX_RATE_LIMIT = '1000';
process.env.TRY_EMAIL_CHECK = 'off';
const http = require('http');

const asked = [];
let down = false;
const line = (lat, lon, n = 5, dLat = -0.002, dLon = 0.0005) => Array.from({ length: n }, (_x, i) => ({ lat: lat + (dLat * i) / (n - 1), lon: lon + (dLon * i) / (n - 1) }));
const AREA = { type: 'way', id: 1001, center: { lat: 40.2950, lon: -75.4700 }, tags: { landuse: 'winter_sports', name: 'Spring Mountain', 'addr:city': 'Spring Mount', website: 'https://example.org' } };
const OTHER = { type: 'relation', id: 2002, center: { lat: 40.9, lon: -75.9 }, tags: { landuse: 'winter_sports', name: 'Spring Valley Snow Park' } };
const SEARCH = [AREA, { ...AREA, id: 1003 }, OTHER, { type: 'way', id: 3003, center: { lat: 41, lon: -76 }, tags: { landuse: 'winter_sports', name: 'Blue Knob' } }];
const DETAIL = [
  AREA,
  { type: 'way', id: 1, tags: { aerialway: 'chair_lift', 'aerialway:occupancy': '4', name: 'Summit Express' }, geometry: line(40.292, -75.471, 6, 0.004, 0.001) },
  { type: 'way', id: 2, tags: { aerialway: 'chair_lift', 'aerialway:occupancy': '2' }, geometry: line(40.292, -75.469, 4, 0.003, 0.0005) },
  { type: 'way', id: 3, tags: { aerialway: 'magic_carpet', name: 'Learning Carpet' }, geometry: line(40.2915, -75.468, 2, 0.0003, 0) },
  { type: 'way', id: 4, tags: { aerialway: 'zip_line', name: 'Zip' }, geometry: line(40.29, -75.47, 2) },
  { type: 'way', id: 10, tags: { 'piste:type': 'downhill', 'piste:difficulty': 'easy', name: 'Gentle Ben' }, geometry: line(40.296, -75.472) },
  { type: 'way', id: 11, tags: { 'piste:type': 'downhill', 'piste:difficulty': 'novice', 'piste:name': 'Learning Area' }, geometry: line(40.2925, -75.468, 3) },
  { type: 'way', id: 12, tags: { 'piste:type': 'downhill', 'piste:difficulty': 'intermediate', name: 'Ridge Line' }, geometry: line(40.296, -75.471) },
  { type: 'way', id: 13, tags: { 'piste:type': 'downhill', 'piste:difficulty': 'advanced', name: 'Ridge Line' }, geometry: line(40.294, -75.4705) },
  { type: 'way', id: 14, tags: { 'piste:type': 'downhill', 'piste:difficulty': 'intermediate', name: 'Orchard' }, geometry: line(40.296, -75.47) },
  { type: 'way', id: 15, tags: { 'piste:type': 'downhill', 'piste:difficulty': 'advanced', name: 'Plunge' }, geometry: line(40.296, -75.469) },
  { type: 'way', id: 16, tags: { 'piste:type': 'downhill', 'piste:difficulty': 'expert', name: 'The Wall' }, geometry: line(40.296, -75.4685) },
  { type: 'way', id: 17, tags: { 'piste:type': 'downhill', 'piste:difficulty': 'intermediate', name: 'Terrain Park' }, geometry: line(40.295, -75.4695) },
  { type: 'way', id: 18, tags: { 'piste:type': 'downhill', 'piste:difficulty': 'easy' }, geometry: line(40.296, -75.4675) },
  { type: 'way', id: 19, tags: { 'piste:type': 'nordic', name: 'Woods Loop' }, geometry: line(40.296, -75.466) },
];
const PLACES = [{ type: 'area', id: 1, tags: { name: 'Montgomery County', admin_level: '6' } }, { type: 'area', id: 2, tags: { name: 'Upper Salford Township', admin_level: '8' } }, { type: 'sep', id: 3, tags: { i: '0' } }];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const q = new URLSearchParams(body).get('data') || '';
    asked.push({ q, ua: req.headers['user-agent'] });
    if (down) { res.statusCode = 504; res.end('busy'); return; }
    const elements = q.includes('map_to_area') ? DETAIL : q.includes('is_in(') ? PLACES : q.includes('ISO3166-2') ? SEARCH : [];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ elements }));
  });
}).listen(0);
process.env.OVERPASS_URLS = `http://127.0.0.1:${stub.address().port}/api/interpreter`;

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const SA = require('../src/lib/skiarea');

let server; let base;
async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };

test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => { server.on('listening', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  await pool.query("DELETE FROM ski_area_cache WHERE ref IN ('way/1001', 'relation/2002')");
});
test.after(async () => { await new Promise((r) => server.close(r)); stub.close(); await pool.end(); });

test('the name search leaves out words every ski area has, and ranks the closest name first', () => {
  assert.deepEqual(SA.keyWords('Spring Mountain Ski Area'), ['spring']);
  assert.deepEqual(SA.keyWords('Mount Snow'), ['mount', 'snow'], 'only common words: they are all kept');
  const q = SA.searchQuery('Spring Mountain Adventures', 'PA');
  assert.match(q, /"ISO3166-2"="US-PA"/); assert.match(q, /"name"~"spring",i/);
  assert.throws(() => SA.searchQuery('  ', 'PA'));
  const r = SA.rank('Spring Mountain', SEARCH);
  assert.deepEqual(r.map((x) => x.name), ['Spring Mountain', 'Spring Valley Snow Park'], 'duplicates joined, non-matches dropped');
  assert.equal(r[0].ref, 'way/1001'); assert.equal(r[0].city, 'Spring Mount');
  assert.throws(() => SA.detailQuery('node/5; out;'), /Not a ski area/);
});

test('lifts and runs: real names kept, unnamed lifts named by type, segments joined at their hardest, park by name', () => {
  const d = SA.parseDetails('way/1001', DETAIL, 'PA');
  assert.equal(d.name, 'Spring Mountain'); assert.equal(d.timezone, 'America/New_York');
  assert.deepEqual(d.lifts.map((l) => l.name), ['Summit Express', 'Double 1', 'Learning Carpet'], 'the zip line is not a lift');
  assert.equal(d.lifts.find((l) => l.name === 'Learning Carpet').small, true);
  const by = Object.fromEntries(d.trails.map((t) => [t.name, t.difficulty]));
  assert.deepEqual(by, { 'Gentle Ben': 'green', 'Learning Area': 'green', Orchard: 'blue', 'Ridge Line': 'black', Plunge: 'black', 'The Wall': 'double_black', 'Terrain Park': 'park' });
  assert.ok(!('Woods Loop' in by), 'cross-country trails are left out');
  assert.equal(d.unnamed_runs, 1);
  assert.ok(d.trails.every((t) => typeof t.lat === 'number'));
  assert.ok(d.zoom >= 12 && d.zoom <= 17);
  assert.ok(d.preview.lines.length >= 12 && d.preview.lines.every((l) => /^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+)*$/.test(l.d)));
  assert.equal(SA.zoneOf('CO'), 'America/Denver'); assert.equal(SA.zoneOf('VT'), 'America/New_York');
  assert.deepEqual(SA.parsePlaces(PLACES, 1), ['Upper Salford Township'], 'the town before the county');
});

test('the demo page finds the mountain, shows its lifts and runs, and says when the map is down', async () => {
  const f = ok(await api('POST', '/trial/find', { body: { mountain: 'Spring Mountain', state: 'PA' } }));
  assert.equal(f.data[0].name, 'Spring Mountain'); assert.equal(f.data[0].state, 'PA');
  assert.equal(f.data[1].city, 'Upper Salford Township', 'a match with no town of its own gets one from the map');
  assert.match(f.credit, /OpenStreetMap/);
  assert.ok(asked.every((a) => /Verdynt\/OS/.test(a.ua)), 'the map service is told who is asking');
  assert.equal((await api('POST', '/trial/find', { body: { mountain: 'Spring', state: 'XX' } })).status, 400);
  const a = ok(await api('POST', '/trial/area', { body: { ref: 'way/1001', state: 'PA' } }));
  assert.deepEqual(a.lifts, ['Summit Express', 'Double 1', 'Learning Carpet']);
  assert.equal(a.trails.length, 7); assert.equal(a.usable, true); assert.ok(a.preview.lines.length);
  const n = asked.length;
  ok(await api('POST', '/trial/area', { body: { ref: 'way/1001', state: 'PA' } }));
  assert.equal(asked.length, n, 'kept for a week, not asked again');
  assert.equal((await api('POST', '/trial/area', { body: { ref: 'node/1', state: 'PA' } })).status, 400);
  down = true;
  try {
    const d = ok(await api('POST', '/trial/find', { body: { mountain: 'Blue Knob', state: 'PA' } }));
    assert.deepEqual(d.data, []); assert.equal(d.unavailable, true);
    assert.equal((await api('POST', '/trial/area', { body: { ref: 'relation/2002', state: 'PA' } })).status, 503);
  } finally { down = false; }
});

test('a demo built on the chosen mountain has its lifts, runs, place, time zone and map, with cases on its runs', { timeout: 200_000 }, async () => {
  const email = `real-${Date.now()}@example.com`;
  const out = ok(await api('POST', '/trial', { body: { name: 'Dan Tester', email, mountain: 'spring mtn', area_ref: 'way/1001', state: 'PA' } }));
  assert.equal(out.mountain, 'Spring Mountain', 'the name from the map'); assert.equal(out.real_map, true);
  const [[t]] = await pool.query('SELECT id, name, timezone, map_lat, map_lng, map_zoom FROM tenants WHERE slug = ?', [out.tenant]);
  assert.equal(t.timezone, 'America/New_York'); assert.equal(Number(t.map_lat), 40.295); assert.ok(t.map_zoom);
  const [lifts] = await pool.query('SELECT name, status FROM lifts WHERE tenant_id = ? ORDER BY id', [t.id]);
  assert.deepEqual(lifts.map((l) => l.name), ['Summit Express', 'Double 1', 'Learning Carpet']);
  assert.ok(lifts.some((l) => l.status === 'hold'));
  const [trails] = await pool.query('SELECT name, difficulty, status FROM trails WHERE tenant_id = ?', [t.id]);
  assert.equal(trails.length, 7);
  assert.equal(trails.find((x) => x.name === 'The Wall').status, 'closed', 'the hardest runs are closed for the day');
  const [cases] = await pool.query('SELECT location, gps_lat FROM incidents WHERE tenant_id = ?', [t.id]);
  assert.ok(cases.length >= 5);
  assert.ok(cases.some((c) => c.location === 'Gentle Ben' && c.gps_lat !== null), 'a case pinned on a real run');
  assert.ok(cases.every((c) => !['Bunny Hill', 'Ridge Run', 'Lower Meadow'].includes(c.location)), 'no sample run names');
  const [[su]] = await pool.query('SELECT area_ref FROM sandbox_signups WHERE email = ?', [email]);
  assert.equal(su.area_ref, 'way/1001');
});

test('without a chosen mountain, or with one that cannot be read, the sample mountain is built as before', { timeout: 200_000 }, async () => {
  down = true;
  await pool.query("DELETE FROM ski_area_cache WHERE ref = 'relation/2002'");
  try {
    const out = ok(await api('POST', '/trial', { body: { name: 'Sam Ple', email: `sample-${Date.now()}@example.com`, mountain: 'Spring Valley', area_ref: 'relation/2002', state: 'PA' } }));
    assert.equal(out.real_map, false); assert.equal(out.mountain, 'Spring Valley');
    const [[t]] = await pool.query('SELECT id, map_lat FROM tenants WHERE slug = ?', [out.tenant]);
    assert.equal(t.map_lat, null);
    const [lifts] = await pool.query('SELECT name FROM lifts WHERE tenant_id = ?', [t.id]);
    assert.ok(lifts.some((l) => l.name === 'Summit Quad'));
  } finally { down = false; }
});
