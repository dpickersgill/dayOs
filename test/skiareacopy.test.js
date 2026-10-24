'use strict';

// Our own copy of the US ski areas (scripts/ski-areas-build.js): built from OpenSkiData's GeoJSON files, read as a
// stream whatever their layout or compression, and then searched by the demo page with no live map server at all.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.SANDBOX_RATE_LIMIT = '1000';
process.env.TRY_EMAIL_CHECK = 'off';
process.env.OVERPASS_URLS = 'http://127.0.0.1:9/never'; // must not be asked
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const pa = (locality) => [{ iso3166_1Alpha2: 'US', iso3166_2: 'US-PA', localized: { en: { country: 'United States', region: 'Pennsylvania', locality } } }];
const ln = (lat, lon, n = 30) => ({ type: 'LineString', coordinates: Array.from({ length: n }, (_x, i) => [lon + i * 0.00003, lat - i * 0.0001, 300 - i]) });
const sa = (id, name) => ({ type: 'Feature', properties: { type: 'skiArea', id, name } });
const SKI_AREAS = [
  { type: 'Feature', geometry: { type: 'Point', coordinates: [-75.47, 40.295] }, properties: { type: 'skiArea', id: 'h1', name: 'Spring Mountain', activities: ['downhill'], status: 'operating', sources: [{ type: 'openstreetmap', id: 'way/1001' }], places: pa('Spring Mount'), websites: ['https://example.org'], viewportHint: { center: [-75.4701, 40.2951] } } },
  { type: 'Feature', geometry: { type: 'Point', coordinates: [-75.9, 40.9] }, properties: { type: 'skiArea', id: 'h2', name: 'Spring Valley Nordic', activities: ['nordic'], status: 'operating', sources: [{ type: 'skimap.org', id: '77' }], places: pa('Elsewhere') } },
  { type: 'Feature', geometry: { type: 'Point', coordinates: [6.8, 45.9] }, properties: { type: 'skiArea', id: 'h3', name: 'Spring Alpine', activities: ['downhill'], status: 'operating', sources: [{ type: 'skimap.org', id: '88' }], places: [{ iso3166_1Alpha2: 'FR', iso3166_2: 'FR-ARA', localized: { en: { country: 'France', region: null, locality: null } } }] } },
  { type: 'Feature', geometry: { type: 'Point', coordinates: [-76.5, 40.1] }, properties: { type: 'skiArea', id: 'h4', name: 'Old Spring Hill', activities: ['downhill'], status: 'abandoned', sources: [{ type: 'skimap.org', id: '99' }], places: pa('Gone') } },
];
const LIFTS = [
  { type: 'Feature', geometry: ln(40.292, -75.471, 4), properties: { type: 'lift', liftType: 'chair_lift', status: 'operating', access: null, name: 'Summit Express', occupancy: 4, skiAreas: [sa('h1', 'Spring Mountain')] } },
  { type: 'Feature', geometry: ln(40.292, -75.469, 4), properties: { type: 'lift', liftType: 'chair_lift', status: 'operating', access: null, name: null, occupancy: 2, skiAreas: [sa('h1', 'Spring Mountain')] } },
  { type: 'Feature', geometry: ln(40.2915, -75.468, 2), properties: { type: 'lift', liftType: 'magic_carpet', status: 'operating', access: null, name: 'Learning Carpet', skiAreas: [sa('h1', 'Spring Mountain')] } },
  { type: 'Feature', geometry: ln(40.29, -75.47, 2), properties: { type: 'lift', liftType: 'chair_lift', status: 'abandoned', name: 'Old Double', skiAreas: [sa('h1', 'Spring Mountain')] } },
  { type: 'Feature', geometry: ln(45.9, 6.8, 2), properties: { type: 'lift', liftType: 'gondola', status: 'operating', name: 'Télécabine', skiAreas: [sa('h3', 'Spring Alpine')] } },
];
const RUNS = [
  ['Gentle Ben', 'easy'], ['Learning Area', 'novice'], ['Ridge Line', 'intermediate'], ['Ridge Line', 'advanced'], ['Orchard', 'intermediate'], ['Plunge', 'advanced'], ['The Wall', 'expert'], ['Terrain Park', 'intermediate'], [null, 'easy'],
].map(([name, difficulty], i) => ({ type: 'Feature', geometry: ln(40.296, -75.472 + i * 0.0005), properties: { type: 'run', uses: ['downhill'], name, difficulty, skiAreas: [sa('h1', 'Spring Mountain')], places: pa('Spring Mount') } }))
  .concat([{ type: 'Feature', geometry: ln(40.3, -75.46), properties: { type: 'run', uses: ['nordic'], name: 'Woods Loop {with "braces"} [and] \\escapes', difficulty: 'easy', skiAreas: [sa('h1', 'Spring Mountain')] } }]);

// Laid out three different ways, as the real files might be: one feature per line, gzipped as a file, and all on one line.
const collection = (features, oneLine) => (oneLine ? JSON.stringify({ type: 'FeatureCollection', features }) : `{"type":"FeatureCollection","features":[\n${features.map((f) => JSON.stringify(f)).join(',\n')}\n]}\n`);
const FILES = { 'ski_areas.geojson': collection(SKI_AREAS), 'lifts.geojson': zlib.gzipSync(collection(LIFTS)), 'runs.geojson': collection(RUNS, true) };
const fetched = [];
const stub = http.createServer((req, res) => {
  const name = req.url.split('/').pop();
  fetched.push({ name, ua: req.headers['user-agent'] });
  const body = FILES[name];
  if (!body) { res.statusCode = 404; res.end(); return; }
  // dribble it out in small pieces, so features cross chunk edges
  const buf = Buffer.from(body); let at = 0;
  const next = () => { if (at >= buf.length) { res.end(); return; } res.write(buf.subarray(at, at + 97)); at += 97; setImmediate(next); };
  next();
}).listen(0);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skicopy-'));
const OUT = path.join(dir, 'ski-areas-us.json.gz');
process.env.SKI_AREAS_FILE = OUT;

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const SA = require('../src/lib/skiarea');

let server; let base;
async function api(method, p, body) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };

test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => { server.on('listening', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); stub.close(); await pool.end(); fs.rmSync(dir, { recursive: true, force: true }); });

test('the build script keeps US downhill areas with their working lifts and downhill runs, whatever the file layout', { timeout: 60_000 }, async () => {
  const script = path.join(__dirname, '..', 'scripts', 'ski-areas-build.js');
  const out = await new Promise((resolve, reject) => execFile(process.execPath, [script, OUT], { env: { ...process.env, OPENSKIDATA_URL: `http://127.0.0.1:${stub.address().port}/geojson` } }, (e, so, se) => (e ? reject(new Error(se || e.message)) : resolve(so))));
  assert.match(out, /Wrote 1 ski areas/);
  assert.match(out, /Spring Mountain, Spring Mount PA: 3 lifts, 8 named runs/);
  assert.deepEqual(fetched.map((f) => f.name), ['ski_areas.geojson', 'lifts.geojson', 'runs.geojson']);
  assert.ok(fetched.every((f) => /Verdynt\/OS/.test(f.ua)));
  const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(OUT)));
  assert.match(d.credit, /OpenSkiData/);
  const a = d.areas[0];
  assert.equal(a.ref, 'way/1001'); assert.equal(a.state, 'PA'); assert.equal(a.lat, 40.2951);
  assert.deepEqual(a.lifts.map((l) => l[0]), ['Summit Express', null, 'Learning Carpet']);
  assert.equal(a.runs.length, 9, 'the nordic loop is left out');
  assert.ok(a.runs.every((r) => r[2].length <= 13 && r[2].length >= 2), 'lines trimmed to a few points');
});

test('the demo page searches our own copy, with no map server', async () => {
  SA.reload();
  const f = ok(await api('POST', '/trial/find', { mountain: 'spring mtn', state: 'PA' }));
  assert.deepEqual(f.data.map((x) => x.name), ['Spring Mountain']);
  assert.equal(f.data[0].city, 'Spring Mount');
  assert.match(f.credit, /OpenSkiData/);
  assert.deepEqual(ok(await api('POST', '/trial/find', { mountain: 'Spring', state: 'VT' })).data, []);
  const a = ok(await api('POST', '/trial/area', { ref: 'way/1001', state: 'PA' }));
  assert.deepEqual(a.lifts, ['Summit Express', 'Double 1', 'Learning Carpet']);
  const by = Object.fromEntries(a.trails.map((t) => [t.name, t.difficulty]));
  assert.deepEqual(by, { 'Gentle Ben': 'green', 'Learning Area': 'green', Orchard: 'blue', 'Ridge Line': 'black', Plunge: 'black', 'The Wall': 'double_black', 'Terrain Park': 'park' });
  assert.equal(a.usable, true); assert.ok(a.preview.lines.length >= 10);
  assert.equal((await api('POST', '/trial/area', { ref: 'way/1001', state: 'NY' })).status, 404);
  assert.equal((await api('POST', '/trial/area', { ref: 'skimap/99', state: 'PA' })).status, 404, 'abandoned areas are not in the copy');
});
