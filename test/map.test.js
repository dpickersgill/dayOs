'use strict';

// The patrol map: tile layers and security policy, where the map opens, pins recorded on incidents, and the
// Map tab's list of pins.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server;
let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  return { slug, owner: (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token };
}
async function addUser(m, email, role, extra = {}) {
  assert.equal((await api('POST', '/users', { token: m.owner, body: { email, password: PW, role, ...extra } })).status, 201);
  return (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token;
}

let A; let B; const T = {}; const D = {};
const newCase = (token, over = {}) => api('POST', '/patrol/incidents', { token, body: { occurred_at: `${today}T10:15`, location: 'Upper Ridge', category: 'injury', severity: 'moderate', summary: 'Wrist injury', ...over } });

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`ma-${suffix}`);
  B = await mountain(`mb-${suffix}`);
  const staff = (await api('POST', '/workforce/staff', { token: A.owner, body: { person: { first_name: 'Pat', last_name: 'Patroller' }, status: 'active' } })).body.id;
  T.patrol = await addUser(A, `pat@${A.slug}.test`, 'patrol', { staff_id: staff });
  T.staff = await addUser(A, `staff@${A.slug}.test`, 'staff');
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('the page allows map tiles from the configured tile servers and serves the map library itself', async () => {
  const res = await fetch(`${base}/`);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /img-src[^;]*'self'[^;]*https:\/\/tile\.openstreetmap\.org/);
  assert.match(csp, /img-src[^;]*https:\/\/\*\.tile\.opentopomap\.org/);
  assert.match(csp, /script-src 'self'/, 'scripts still only from this server');
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  const js = await fetch(`${base}/vendor/leaflet/leaflet.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${base}/vendor/leaflet/leaflet.css`)).status, 200);
});

test('the map settings: layers, no starting view yet, and who may change it', async () => {
  const m = await api('GET', '/patrol/map', { token: T.patrol });
  assert.equal(m.status, 200, m.text);
  assert.ok(m.body.layers.length >= 1);
  assert.match(m.body.layers[0].url, /\{z\}\/\{x\}\/\{y\}/);
  assert.ok(m.body.layers[0].attribution.includes('OpenStreetMap'));
  assert.equal(m.body.center, null);
  assert.equal(m.body.can_admin, false);
  assert.equal((await api('GET', '/patrol/map', { token: A.owner })).body.can_admin, true);
  assert.equal((await api('GET', '/patrol/map', { token: T.staff })).status, 403);
  assert.equal((await api('PUT', '/patrol/map-config', { token: T.patrol, body: { lat: 44.5, lng: -72.8, zoom: 15 } })).status, 403);
  assert.equal((await api('PUT', '/patrol/map-config', { token: A.owner, body: { lat: 91, lng: 0, zoom: 15 } })).status, 400);
  assert.equal((await api('PUT', '/patrol/map-config', { token: A.owner, body: { lat: 44.5, lng: -200, zoom: 15 } })).status, 400);
  assert.equal((await api('PUT', '/patrol/map-config', { token: A.owner, body: { lat: 44.5, lng: -72.8, zoom: 40 } })).status, 400);
});

test('a pin is recorded on the incident as coordinates, and must be real coordinates', async () => {
  const c = (await newCase(A.owner)).body;
  const p = await api('PATCH', `/patrol/incidents/${c.id}`, { token: A.owner, body: { gps_lat: 44.475883, gps_lng: -73.212072 } });
  assert.equal(p.status, 200, p.text);
  const got = (await api('GET', `/patrol/incidents/${c.id}`, { token: A.owner })).body;
  assert.equal(Number(got.gps_lat), 44.475883);
  assert.equal(Number(got.gps_lng), -73.212072);
  assert.equal((await api('PATCH', `/patrol/incidents/${c.id}`, { token: A.owner, body: { gps_lat: 91, gps_lng: 0 } })).status, 400);
  assert.equal((await api('PATCH', `/patrol/incidents/${c.id}`, { token: A.owner, body: { gps_lat: 10, gps_lng: 181 } })).status, 400);
  D.pinned = c.id;
  // the GPS field counts as answered when the form's mandatory fields are checked
  const form = (await api('GET', `/patrol/incidents/${c.id}`, { token: A.owner })).body;
  assert.equal(form.gps_lat !== null, true);
});

test('the Map tab lists pinned cases only, filtered, with no patient names', async () => {
  const plain = (await newCase(A.owner, { summary: 'No pin on this one', category: 'medical' })).body;
  const second = (await newCase(A.owner, { summary: 'Collision at the merge', location: 'Merge' })).body;
  await api('PATCH', `/patrol/incidents/${second.id}`, { token: A.owner, body: { gps_lat: 44.4801, gps_lng: -73.2005 } });
  await api('POST', `/patrol/incidents/${second.id}/patients`, { token: A.owner, body: { first_name: 'Secret', last_name: 'Patient' } });

  const all = await api('GET', '/patrol/map-pins', { token: T.patrol });
  assert.equal(all.status, 200, all.text);
  const ids = all.body.data.map((x) => x.id);
  assert.ok(ids.includes(D.pinned) && ids.includes(second.id));
  assert.ok(!ids.includes(plain.id), 'a case without a pin is not on the map');
  const pin = all.body.data.find((x) => x.id === second.id);
  assert.equal(typeof pin.gps_lat, 'number');
  assert.match(pin.case_number, /^\d{4}-\d{2}-\d{4}$/);
  assert.doesNotMatch(all.text, /Secret|Patient/);
  assert.equal((await api('GET', `/patrol/map-pins?category=medical`, { token: T.patrol })).body.data.length, 0);
  assert.equal((await api('GET', `/patrol/map-pins?from=${today}&to=${today}`, { token: T.patrol })).body.data.length >= 2, true);
  assert.equal((await api('GET', `/patrol/map-pins?from=2001-01-01&to=2001-12-31`, { token: T.patrol })).body.data.length, 0);
  assert.equal((await api('GET', '/patrol/map-pins', { token: T.staff })).status, 403);
  // another mountain sees none of it
  assert.equal((await api('GET', '/patrol/map-pins', { token: B.owner })).body.data.length, 0);
});

test('the map opens on the middle of recent pins, until an administrator chooses a view', async () => {
  const m = (await api('GET', '/patrol/map', { token: T.patrol })).body;
  assert.equal(m.center.source, 'cases');
  assert.ok(m.center.lat > 44.47 && m.center.lat < 44.49);
  assert.equal((await api('PUT', '/patrol/map-config', { token: A.owner, body: { lat: 44.5, lng: -72.8, zoom: 14 } })).status, 200);
  const after = (await api('GET', '/patrol/map', { token: T.patrol })).body;
  assert.deepEqual(after.center, { lat: 44.5, lng: -72.8, zoom: 14, source: 'resort' });
  assert.equal((await api('GET', '/patrol/map', { token: B.owner })).body.center, null, 'settings are per mountain');
});

test('editing one field leaves fields with defaults alone (zod .partial() regression)', async () => {
  const o = A.owner;
  const c = (await newCase(o, { severity: 'serious' })).body;
  const id = c.id || c.incident?.id;
  assert.equal((await api('PATCH', `/patrol/incidents/${id}`, { token: o, body: { gps_lat: 44.5, gps_lng: -72.7 } })).status, 200);
  const got = (await api('GET', `/patrol/incidents/${id}`, { token: o })).body;
  assert.equal((got.incident || got).severity, 'serious', 'a coordinates-only save must not reset severity');

  const st = (await api('POST', '/patrol/stations', { token: o, body: { name: 'Hut X', kind: 'hut' } })).body;
  await api('PATCH', `/patrol/stations/${st.id}`, { token: o, body: { name: 'Hut Y' } });
  const sts = (await api('GET', '/patrol/stations', { token: o })).body;
  assert.equal((sts.data || sts).find((s) => s.id === st.id).kind, 'hut');

  const eq = (await api('POST', '/patrol/equipment', { token: o, body: { name: 'AED 1', kind: 'aed' } })).body;
  await api('PATCH', `/patrol/equipment/${eq.id}`, { token: o, body: { name: 'AED 2' } });
  const eqs = (await api('GET', '/patrol/equipment', { token: o })).body;
  assert.equal((eqs.data || eqs).find((e) => e.id === eq.id).kind, 'aed');

  const card = (await api('POST', '/products', { token: o, body: { kind: 'punch_card', name: 'Card', base_price_cents: 9000, valid_days: 30, uses: 2 } })).body;
  await api('PATCH', `/products/${card.id}`, { token: o, body: { name: 'Card 2' } });
  const prods = (await api('GET', '/products', { token: o })).body;
  assert.equal((prods.data || prods).find((p) => p.id === card.id).valid_days, 30);

  const prog = (await api('POST', '/programs', { token: o, body: { name: 'Race', kind: 'race_team', season: '2026-27', price_cents: 45000 } })).body;
  await api('PATCH', `/programs/${prog.id}`, { token: o, body: { name: 'Race 2' } });
  const progs = (await api('GET', '/programs', { token: o })).body;
  assert.equal((progs.data || progs).find((p) => p.id === prog.id).price_cents, 45000);
});
