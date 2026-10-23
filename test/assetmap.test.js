'use strict';

// The asset map (Assets and fleet, Map): points, lines and areas in each system's layer, tied to assets in the register;
// staff add and move, only a manager deletes; shapes are checked; lengths are worked out; one mountain's map is its own;
// the satellite layer is offered on every map; and the map downloads as GeoJSON.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const modules = require('../src/lib/modules');
const MF = require('../src/lib/mapfeatures');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text, headers: res.headers };
}
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${r.text}`);
async function mountain(tag) {
  const slug = `amap${tag}-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: `Map ${tag}`, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  const owner = await login(`owner@${slug}.test`);
  is(await api('POST', '/users', { token: owner, body: { email: `mech@${slug}.test`, password: PW, role: 'staff' } }), 201);
  is(await api('POST', '/users', { token: owner, body: { email: `pat@${slug}.test`, password: PW, role: 'patrol' } }), 201);
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
  await pool.query('INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE enabled = 1', [t.id, 'assets']);
  modules.invalidate(t.id);
  return { slug, id: t.id, owner, staff: await login(`mech@${slug}.test`), patrol: await login(`pat@${slug}.test`) };
}

let A; let B; let pump;
test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain('a'); B = await mountain('b');
  pump = (await api('POST', '/assets/register', { token: A.owner, body: { name: 'Pond pump 1', kind: 'pump' } })).body.id;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

const P1 = [44.1, -71.2];
const LINE = [[44.1, -71.2], [44.1009, -71.2], [44.1009, -71.2012]];

test('staff put points, lines and areas on the map; shapes are checked; a line knows its length', async () => {
  is(await api('GET', '/assets/map', { token: A.patrol }), 403, 'patrol does not use the asset map');
  const v = await api('POST', '/assets/map/features', { token: A.staff, body: { kind: 'valve', points: [P1], name: 'Valve 12', size: '6 in', placed_how: 'gps', accuracy_m: 3.5 } });
  is(v, 201);
  assert.equal(v.body.system, 'water'); assert.equal(v.body.geometry, 'point'); assert.equal(v.body.accuracy_m, 3.5); assert.equal(v.body.placed_how, 'gps');
  const line = await api('POST', '/assets/map/features', { token: A.staff, body: { kind: 'water_line', points: LINE, size: '8 in', material: 'ductile iron', depth_ft: 5, installed_year: 1998, placed_how: 'walk' } });
  is(line, 201);
  // about 100 m north, then about 96 m west
  assert.ok(line.body.length_m > 190 && line.body.length_m < 205, `length ${line.body.length_m}`);
  const pond = await api('POST', '/assets/map/features', { token: A.staff, body: { kind: 'pond', points: [[44.1, -71.2], [44.101, -71.2], [44.101, -71.201], [44.1, -71.201]], name: 'Snowmaking pond' } });
  is(pond, 201); assert.ok(pond.body.area_m2 > 8000 && pond.body.area_m2 < 9500, `area ${pond.body.area_m2}`);
  is(await api('POST', '/assets/map/features', { token: A.staff, body: { kind: 'water_line', points: [P1] } }), 400, 'a line needs two points');
  is(await api('POST', '/assets/map/features', { token: A.staff, body: { kind: 'valve', points: LINE } }), 400, 'a point has one position');
  is(await api('POST', '/assets/map/features', { token: A.staff, body: { kind: 'pond', points: LINE.slice(0, 2) } }), 400, 'an area needs three');
  is(await api('POST', '/assets/map/features', { token: A.staff, body: { kind: 'valve', points: [[91, 0]] } }), 400, 'a real place');
  const map = (await api('GET', '/assets/map', { token: A.staff })).body;
  assert.equal(map.features.length, 3);
  assert.ok(map.kinds.some((k) => k.key === 'air_line') && map.systems.some((s) => s.key === 'power'));
  assert.ok(map.layers.some((l) => l.name === 'Satellite' && l.url.includes('basemap.nationalmap.gov')), 'satellite on the asset map');
  assert.ok(map.max_zoom >= 20, 'zooms deep enough for a valve');
  assert.equal(map.can_delete, false);
});

test('an item ties to an asset, moves, changes kind within its shape, and only a manager deletes it', async () => {
  const p = (await api('POST', '/assets/map/features', { token: A.staff, body: { kind: 'pump', points: [[44.1002, -71.2003]], asset_id: pump } })).body;
  assert.equal(p.asset_name, 'Pond pump 1');
  assert.equal((await api('GET', `/assets/register/${pump}`, { token: A.staff })).body.on_map, 1, 'the asset page knows it is on the map');
  const moved = await api('PATCH', `/assets/map/features/${p.id}`, { token: A.staff, body: { points: [[44.1003, -71.2004]], placed_how: 'map' } });
  is(moved, 200); assert.deepEqual(moved.body.points, [[44.1003, -71.2004]]);
  is(await api('PATCH', `/assets/map/features/${p.id}`, { token: A.staff, body: { kind: 'pump_house' } }), 200, 'point to point');
  is(await api('PATCH', `/assets/map/features/${p.id}`, { token: A.staff, body: { kind: 'water_line' } }), 400, 'a point cannot become a line');
  const other = (await api('POST', '/assets/register', { token: B.owner, body: { name: 'B pump', kind: 'pump' } })).body.id;
  is(await api('PATCH', `/assets/map/features/${p.id}`, { token: A.staff, body: { asset_id: other } }), 404, 'another mountain’s asset');
  is(await api('DELETE', `/assets/map/features/${p.id}`, { token: A.staff }), 403);
  is(await api('DELETE', `/assets/map/features/${p.id}`, { token: A.owner }), 200);
  const [[audit]] = await pool.query("SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ? AND entity = 'map_features'", [A.id]);
  assert.ok(Number(audit.n) >= 4, 'every change is in the activity log');
});

test('one mountain’s map is its own; the map downloads as GeoJSON; managers set where maps open', async () => {
  assert.equal((await api('GET', '/assets/map', { token: B.owner })).body.features.length, 0);
  const aItem = (await api('GET', '/assets/map', { token: A.owner })).body.features[0];
  is(await api('PATCH', `/assets/map/features/${aItem.id}`, { token: B.owner, body: { name: 'Not yours' } }), 404);
  is(await api('DELETE', `/assets/map/features/${aItem.id}`, { token: B.owner }), 404);
  const g = await api('GET', '/assets/map/export.geojson', { token: A.staff });
  is(g, 200);
  assert.match(g.headers.get('content-disposition'), /asset-map\.geojson/);
  const fc = g.body;
  assert.equal(fc.type, 'FeatureCollection');
  const line = fc.features.find((f) => f.geometry.type === 'LineString');
  assert.deepEqual(line.geometry.coordinates[0], [-71.2, 44.1], 'longitude first, as GeoJSON wants');
  assert.equal(line.properties.material, 'ductile iron');
  assert.ok(line.properties.length_ft > 600);
  const poly = fc.features.find((f) => f.geometry.type === 'Polygon');
  assert.deepEqual(poly.geometry.coordinates[0][0], poly.geometry.coordinates[0].at(-1), 'a closed ring');
  is(await api('PUT', '/assets/map/view', { token: A.staff, body: { lat: 44.1, lng: -71.2, zoom: 17 } }), 403);
  is(await api('PUT', '/assets/map/view', { token: A.owner, body: { lat: 44.1, lng: -71.2, zoom: 20 } }), 200);
  assert.deepEqual((await api('GET', '/assets/map', { token: A.staff })).body.center, { lat: 44.1, lng: -71.2, zoom: 20 });
});

test('the patrol and park maps offer the satellite layer too', async () => {
  const park = (await api('GET', '/park/map', { token: A.owner })).body;
  assert.ok(park.layers.some((l) => l.name === 'Satellite'));
  assert.ok(park.max_zoom >= 20);
  assert.ok(MF.lengthOf([[0, 0], [0, 1]]) > 111000, 'a degree of longitude at the equator is about 111 km');
});
