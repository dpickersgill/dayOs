'use strict';

// Mountain places (help/places): describe() in the words patrollers use, sign codes, who may map, the GPS accuracy gate,
// CSV both ways, the help link in a sign's QR code, the call's location panel, "Guest needs help here" from staff, and
// one mountain never seeing or changing another's places.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const nodePath = require('path');
const { pathToFileURL } = require('url');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const P = require('../src/lib/places');
const PUSH = require('../src/lib/push');

let server; let base;
const PW = 'correct-horse-battery';
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const REC = require('./helpers/records').records(() => base, () => PW);
async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);

// A spot on the mountain, and points a number of meters north and east of it.
const LAT0 = 39.6; const LNG0 = -105.9;
const off = (north, east, from = { lat: LAT0, lng: LNG0 }) => ({ lat: from.lat + north / 111320, lng: from.lng + east / (111320 * Math.cos(from.lat * Math.PI / 180)) });

async function mountain(slug, name) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201, await res.text());
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  const M = { slug, login };
  M.owner = await REC(await login(`owner@${slug}.test`));
  M.id = Number((await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]))[0][0].id);
  M.lift = Number(ok(await api('POST', '/schedule/lifts', { token: M.owner, body: { name: 'Summit Quad' } })).id);
  M.trail = Number(ok(await api('POST', '/schedule/trails', { token: M.owner, body: { name: 'Ridge Run', difficulty: 'blue', status: 'open' } })).id);
  return M;
}
async function person(M, key, first, level, role = 'patrol') {
  const staff = level
    ? Number(ok(await api('POST', '/patrol/team', { token: M.owner, body: { person: { first_name: first, last_name: 'Places' }, level } })).staff_id)
    : Number(ok(await api('POST', '/workforce/staff', { token: M.owner, body: { person: { first_name: first, last_name: 'Places' }, status: 'active' } })).id);
  ok(await api('POST', '/users', { token: M.owner, body: { email: `${key}@${M.slug}.test`, password: PW, role, staff_id: staff } }));
  M[key] = staff;
  M[`${key}T`] = await REC(await M.login(`${key}@${M.slug}.test`));
}
const place = async (M, row) => {
  const [r] = await pool.query(`INSERT INTO mountain_places (tenant_id, kind, name, code, lift_id, tower_no, trail_id, lat, lng, accuracy_m, marked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 5, NOW())`, [M.id, row.kind, row.name, row.code, row.lift_id ?? null, row.tower_no ?? null, row.trail_id ?? null, row.lat, row.lng]);
  return r.insertId;
};

let M; let N;
test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  M = await mountain(`hp-${suffix}`, 'Places Peak');
  N = await mountain(`hq-${suffix}`, 'Other Peak');
  await person(M, 'dir', 'Dana', 'director'); // patrol Admin
  await person(M, 'lead', 'Lee', 'leader'); // patrol Manager
  await person(M, 'pat', 'Pat', 'patroller'); // Patrol
  await person(M, 'lifty', 'Lou', null, 'staff'); // Lift and mountain staff
  // The fixtures for describe(): a trail sign, the lift tower 40 m north of it, and a junction 2 km away.
  M.sign = await place(M, { kind: 'sign', name: 'Ridge Run', code: 'R7', trail_id: M.trail, ...off(0, 0) });
  M.tower = await place(M, { kind: 'tower', name: 'Summit Quad tower 7', code: 'S7', lift_id: M.lift, tower_no: 7, ...off(40, 0) });
  M.junction = await place(M, { kind: 'junction', name: 'Ridge Run and Bowl', code: 'J1', ...off(2000, 0) });
  // A lodge 10 m from the test spot and a sign 580 m from it, 5 km east (help review: the nearest is named).
  M.lodgeAt = off(0, 5000);
  M.lodge = await place(M, { kind: 'building', name: 'Summit Lodge', code: 'L1', ...M.lodgeAt });
  M.farSign = await place(M, { kind: 'sign', name: 'Upper Ridge', code: 'U1', ...off(0, 590, M.lodgeAt) });
  // Two signs 60 m apart (north and south of a point), 10 km east.
  M.gapAt = off(0, 10000);
  M.gullyTop = await place(M, { kind: 'sign', name: 'Gully Top', code: 'G1', ...off(0, -30, M.gapAt) });
  M.gullyBottom = await place(M, { kind: 'sign', name: 'Gully Bottom', code: 'G2', ...off(0, 30, M.gapAt) });
  // A sign and a building the same distance from a point (20 m north and 20 m east), 15 km east.
  M.tieAt = off(0, 15000);
  M.tieBuilding = await place(M, { kind: 'building', name: 'Aspen Hut', code: 'AH1', ...off(20, 0, M.tieAt) });
  M.tieSign = await place(M, { kind: 'sign', name: 'Aspen Glade', code: 'AG1', ...off(0, 20, M.tieAt) });
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

// ---------------------------------------------------------------- describe()
// Through the call view's own route (GET /patrol/places/describe), as dispatch reads it.
const words = async (at, acc) => ok(await api('GET', `/patrol/places/describe?lat=${at.lat}&lng=${at.lng}${acc === undefined ? '' : `&acc=${acc}`}`, { token: M.owner })).words;

test('describe(): the nearest place, by its own distance; a tower by its lift and number, never above or below', async () => {
  // A trail sign, and the tower 40 m north of it: 30 m east of the sign the sign is nearest (the tower is 50 m off).
  const w = await words(off(0, 30), 8);
  assert.equal(w.text, 'Near Ridge Run, about 30 m');
  assert.equal(w.text_es, 'Cerca de Ridge Run, a unos 30 m');
  assert.equal(w.place_id, M.sign); assert.equal(w.distance_m, 30); assert.equal(w.confidence, 'high');
  // Right by the tower: named by its lift and number, with its own distance. No height data, so no "below" or "above".
  const t = await words(off(55, 0), 8);
  assert.equal(t.text, 'Near Summit Quad tower 7, about 15 m');
  assert.equal(t.text_es, 'Cerca de la torre 7 de Summit Quad, a unos 15 m');
  assert.equal(t.place_id, M.tower);
  assert.doesNotMatch(`${w.text} ${t.text}`, /below|above/i);
});

test('describe(): a lodge 10 m away is named, not a sign 580 m away', async () => {
  const at = off(0, 10, M.lodgeAt);
  const w = await words(at, 200); // a rough phone looks out to 600 m, so both are found
  assert.equal(w.text, 'Near Summit Lodge, about 10 m (location rough)');
  assert.equal(w.text_es, 'Cerca de Summit Lodge, a unos 10 m (ubicación aproximada)');
  assert.equal(w.place_id, M.lodge);
  assert.equal(w.distance_m, 10, 'the distance is to the place named');
});

test('describe(): between two places only when both are close and the phone is between them', async () => {
  // Two signs 60 m apart, the phone halfway: between them, nearest first, each with its own distance.
  const mid = off(0, 0, M.gapAt);
  const w = await words(off(0, -5, mid), 5);
  assert.equal(w.text, 'Between Gully Top (about 25 m) and Gully Bottom (about 35 m)');
  assert.equal(w.text_es, 'Entre Gully Top (a unos 25 m) y Gully Bottom (a unos 35 m)');
  assert.equal(w.place_id, M.gullyTop);
  // Off to one side of both (the two in the same direction): only the nearest.
  const side = await words(off(0, -70, mid), 5);
  assert.equal(side.text, 'Near Gully Top, about 40 m');
  // Both close, but not on either side of the phone (45 m north of the line): only the nearest.
  const aside = await words(off(45, -5, mid), 5);
  assert.equal(aside.text, 'Near Gully Top, about 50 m');
});

test('describe(): ties name a trail sign first, then by name', async () => {
  // A building and a sign at the same distance: the sign.
  const w = await words(M.tieAt, 5);
  assert.equal(w.text, 'Near Aspen Glade, about 20 m');
  assert.equal(w.place_id, M.tieSign);
  // Two signs at the same distance: by name.
  const two = P.wordsFor([{ id: 2, kind: 'sign', name: 'Zephyr', distance_m: 12.2 }, { id: 1, kind: 'sign', name: 'Birch', distance_m: 12.4 }], 5);
  assert.equal(two.text, 'Near Birch, about 10 m');
  assert.equal(two.place_id, 1);
});

test('describe(): rough accuracy, a junction, and far from everything ("No mapped place within 600 m")', async () => {
  const j = off(2000, 0);
  const near = off(0, 60, j);
  const w = await words(near, 20);
  assert.equal(w.text, 'Near Ridge Run and Bowl, about 60 m');
  assert.equal(w.text_es, 'Cerca de Ridge Run and Bowl, a unos 60 m');
  assert.equal(w.confidence, 'medium', 'over 50 m from the nearest point');
  // A phone out by 150 m looks out to 450 m, and says the place is rough.
  const far = off(-300, 0, j);
  const r = await words(far, 150);
  assert.equal(r.text, 'Near Ridge Run and Bowl, about 300 m (location rough)');
  assert.equal(r.text_es, 'Cerca de Ridge Run and Bowl, a unos 300 m (ubicación aproximada)');
  assert.equal(r.confidence, 'low');
  // The same spot with a good fix looks only 150 m out: nothing there, and it says so.
  const none = await words(far, 10);
  assert.equal(none.text, 'No mapped place within 150 m'); assert.equal(none.place_id, null);
  // Never past 600 m, however rough the phone.
  const out = await words(off(650, 0, j), 5000);
  assert.deepEqual([out.text, out.text_es, out.place_id, out.confidence], ['No mapped place within 600 m', 'Ningún lugar marcado a menos de 600 m', null, 'none']);
  // Nothing mapped on this mountain at all: no words.
  assert.equal(await P.describe(pool, N.id, LAT0, LNG0, 5), null);
});

test('describe() helpers: the search range scales with accuracy, and distances are rounded as patrollers say them', () => {
  assert.equal(P.rangeFor(10), 150);
  assert.equal(P.rangeFor(100), 300);
  assert.equal(P.rangeFor(900), 600);
  assert.equal(P.rangeFor(null), 150);
  assert.deepEqual([3, 31, 47, 64, 186, 230, 474].map(P.rounded), [5, 30, 45, 60, 190, 250, 450]);
  assert.ok(Math.abs(P.haversine(LAT0, LNG0, off(1000, 0).lat, LNG0) - 1000) < 3, 'a kilometer north is a kilometer (to a few meters)');
});

// ---------------------------------------------------------------- who may map
test('mapping needs the role: patrol Admins and Managers and managers, not patrollers or lift staff', async () => {
  for (const [who, status] of [['owner', 200], ['dirT', 200], ['leadT', 200], ['patT', 403], ['liftyT', 403]]) is(await api('GET', '/patrol/places', { token: M[who] }), status, who);
  const body = { kind: 'sign', name: 'Patroller try', lat: LAT0, lng: LNG0, accuracy_m: 5 };
  is(await api('POST', '/patrol/places', { token: M.patT, body }), 403);
  is(await api('POST', '/patrol/places', { token: M.liftyT, body }), 403);
  is(await api('POST', `/patrol/places/${M.sign}/retire`, { token: M.patT }), 403);
  is(await api('GET', '/patrol/places/export', { token: M.patT }), 403);
  // Patrol still gets a position in words for its own calls.
  const w = ok(await api('GET', `/patrol/places/describe?lat=${off(0, 30).lat}&lng=${off(0, 30).lng}&acc=8`, { token: M.patT })).words;
  assert.equal(w.text, 'Near Ridge Run, about 30 m');
});

// ---------------------------------------------------------------- the GPS gate and codes
test('the GPS accuracy gate: a spot is marked only from a fix under 30 m', async () => {
  const at = off(500, 500);
  const body = { kind: 'building', name: 'Summit hut', ...at };
  is(await api('POST', '/patrol/places', { token: M.leadT, body }), 400, 'no accuracy: not from GPS');
  is(await api('POST', '/patrol/places', { token: M.leadT, body: { ...body, accuracy_m: 45 } }), 400);
  is(await api('POST', '/patrol/places', { token: M.leadT, body: { ...body, accuracy_m: 30 } }), 400, '30 m is not under 30 m');
  const made = ok(await api('POST', '/patrol/places', { token: M.leadT, body: { ...body, accuracy_m: 12.4 } }));
  const row = (await pool.query('SELECT accuracy_m, marked_by FROM mountain_places WHERE id = ?', [made.id]))[0][0];
  assert.equal(row.accuracy_m, 12);
  assert.ok(row.marked_by);
  // Moving it takes a new GPS mark under the same rule.
  is(await api('PUT', `/patrol/places/${made.id}/position`, { token: M.leadT, body: { ...off(510, 500), accuracy_m: 31 } }), 400);
  ok(await api('PUT', `/patrol/places/${made.id}/position`, { token: M.leadT, body: { ...off(510, 500), accuracy_m: 6 } }));
  const audit = (await pool.query("SELECT action FROM audit_log WHERE tenant_id = ? AND entity = 'mountain_places' AND entity_id = ? ORDER BY id", [M.id, made.id]))[0].map((r) => r.action);
  assert.deepEqual(audit, ['create', 'move']);
});

test('sign codes are unique on a mountain, 2 to 5 letters and digits, and suggested from the trail or lift', async () => {
  const at = { ...off(800, 0), accuracy_m: 5 };
  // Suggestions: a tower is its lift's initial and number; a trail sign is the trail's initial and the next free number.
  assert.equal(ok(await api('POST', '/patrol/places/code', { token: M.leadT, body: { kind: 'tower', lift_id: M.lift, tower_no: 8 } })).code, 'S8');
  assert.equal(ok(await api('POST', '/patrol/places/code', { token: M.leadT, body: { kind: 'tower', lift_id: M.lift, tower_no: 7 } })).code, 'SQ7', 'S7 is taken');
  assert.equal(ok(await api('POST', '/patrol/places/code', { token: M.leadT, body: { kind: 'sign', trail_id: M.trail } })).code, 'R1');
  // Taken, too short, not letters and digits: refused. Lower case is made upper case.
  is(await api('POST', '/patrol/places', { token: M.leadT, body: { kind: 'sign', trail_id: M.trail, code: 'R7', ...at } }), 409);
  is(await api('POST', '/patrol/places', { token: M.leadT, body: { kind: 'sign', trail_id: M.trail, code: 'R', ...at } }), 400);
  is(await api('POST', '/patrol/places', { token: M.leadT, body: { kind: 'sign', trail_id: M.trail, code: 'R-8', ...at } }), 400);
  is(await api('POST', '/patrol/places', { token: M.leadT, body: { kind: 'sign', trail_id: M.trail, code: 'RIDGE1', ...at } }), 400);
  const r = ok(await api('POST', '/patrol/places', { token: M.leadT, body: { kind: 'sign', trail_id: M.trail, code: 'r8', ...at } }));
  assert.equal(r.code, 'R8');
  assert.equal(r.name, 'Ridge Run', 'a sign with no name takes its trail’s');
  // A blank code gets the suggestion; a tower needs its lift and number.
  const t = ok(await api('POST', '/patrol/places', { token: M.leadT, body: { kind: 'tower', lift_id: M.lift, tower_no: 8, ...at } }));
  assert.equal(t.code, 'S8'); assert.equal(t.name, 'Summit Quad tower 8');
  is(await api('POST', '/patrol/places', { token: M.leadT, body: { kind: 'tower', lift_id: M.lift, ...at } }), 400);
  // Renaming to a taken code is refused; a retired place keeps its code taken (an old sign is never sent somewhere new).
  is(await api('PATCH', `/patrol/places/${r.id}`, { token: M.leadT, body: { code: 'S7' } }), 409);
  ok(await api('POST', `/patrol/places/${r.id}/retire`, { token: M.leadT }));
  assert.equal(await P.byCode(pool, M.id, 'R8'), null, 'a retired place is not found by its code');
  is(await api('POST', '/patrol/places', { token: M.leadT, body: { kind: 'sign', trail_id: M.trail, code: 'R8', ...at } }), 409);
  ok(await api('POST', `/patrol/places/${r.id}/restore`, { token: M.leadT }));
  assert.equal((await P.byCode(pool, M.id, 'r8')).id, r.id);
  // The same code on another mountain is fine.
  const other = await place(N, { kind: 'sign', name: 'Other sign', code: 'R7', ...off(0, 0) });
  assert.ok(other);
});

// ---------------------------------------------------------------- CSV
test('CSV round trip: the export imports back unchanged, onto this mountain or another one', async () => {
  const res = await fetch(`${base}/api/v1/patrol/places/export`, { headers: { authorization: `Bearer ${M.leadT}` } });
  assert.equal(res.status, 200);
  const csv = await res.text();
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'kind,name,code,lift,tower,trail,lat,lng');
  assert.ok(lines.some((l) => l.startsWith('"tower","Summit Quad tower 7","S7","Summit Quad","7","",')));
  assert.ok(csv.includes(`"'${LNG0.toFixed(6)}"`), 'a west longitude is defused for spreadsheets, and read back below');
  const before = (await P.list(pool, M.id)).map((p) => [p.code, p.kind, p.name, p.lat, p.lng, p.tower_no]).sort();
  // Back onto the same mountain: every row updates its place by code, nothing is added.
  const back = ok(await api('POST', '/patrol/places/import', { token: M.leadT, body: { csv } }));
  assert.equal(back.added, 0); assert.equal(back.updated, before.length);
  assert.deepEqual((await P.list(pool, M.id)).map((p) => [p.code, p.kind, p.name, p.lat, p.lng, p.tower_no]).sort(), before);
  // Onto another mountain with the same lift and trail names: the same places, its own rows.
  await pool.query('DELETE FROM mountain_places WHERE tenant_id = ?', [N.id]);
  const there = ok(await api('POST', '/patrol/places/import', { token: N.owner, body: { csv } }));
  assert.equal(there.added, before.length);
  assert.deepEqual((await P.list(pool, N.id)).map((p) => [p.code, p.kind, p.name, p.lat, p.lng, p.tower_no]).sort(), before);
  const nLift = (await P.byCode(pool, N.id, 'S7')).lift_id;
  assert.equal(Number(nLift), N.lift, 'the lift is matched by name on that mountain');
  // A bad row: nothing is imported and each problem is named with its line.
  const bad = 'kind,name,code,lift,tower,trail,lat,lng\r\nsign,New sign,N1,,,,39.61,-105.9\r\ntower,,N2,No Such Lift,3,,39.62,-105.9\r\nsign,Far,N3,,,,95,-105.9';
  const r = await api('POST', '/patrol/places/import', { token: M.leadT, body: { csv: bad } });
  is(r, 400);
  assert.deepEqual(r.body.details.errors.map((e) => e.line), [3, 4]);
  assert.match(r.body.details.errors[0].error, /no lift called "No Such Lift"/);
  assert.equal(await P.byCode(pool, M.id, 'N1'), null, 'all or nothing');
});

// ---------------------------------------------------------------- signs
test('a sign carries the help link for its code, and its QR code reads back to that link', async () => {
  const r = ok(await api('GET', `/patrol/places/signs?ids=${M.sign},${M.tower}`, { token: M.leadT }));
  assert.equal(r.mountain, 'Places Peak');
  const sign = r.places.find((p) => p.code === 'R7');
  assert.equal(sign.url, `${base}/help/${M.slug}?c=R7`);
  assert.deepEqual(r.places.map((p) => p.code).sort(), ['R7', 'S7']);
  const stencil = ok(await api('GET', `/patrol/places/signs?lift=${M.lift}`, { token: M.leadT }));
  assert.deepEqual(stencil.places.map((p) => p.code), ['S7', 'S8'], 'the stencil lists the lift’s towers in order');
  is(await api('GET', '/patrol/places/signs', { token: M.patT }), 403);

  // The sign sheet's own QR code (the app's QR library), drawn into pixels and read back with jsQR.
  const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'hp-sign-'));
  try {
    fs.mkdirSync(nodePath.join(tmp, 'js')); fs.mkdirSync(nodePath.join(tmp, 'vendor', 'qrcode'), { recursive: true });
    fs.copyFileSync(nodePath.join(__dirname, '..', 'public', 'js', 'signsheet.js'), nodePath.join(tmp, 'js', 'signsheet.js'));
    fs.copyFileSync(nodePath.join(__dirname, '..', 'public', 'vendor', 'qrcode', 'qrcode.js'), nodePath.join(tmp, 'vendor', 'qrcode', 'qrcode.js'));
    fs.writeFileSync(nodePath.join(tmp, 'package.json'), '{"type":"module"}');
    const S = await import(pathToFileURL(nodePath.join(tmp, 'js', 'signsheet.js')).href);
    const m = S.qrMatrix(sign.url);
    const scale = 5; const quiet = 4; const w = (m.n + quiet * 2) * scale;
    const px = new Uint8ClampedArray(w * w * 4).fill(255);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
      const row = Math.floor(y / scale) - quiet; const col = Math.floor(x / scale) - quiet;
      if (row >= 0 && col >= 0 && row < m.n && col < m.n && m.dark(row, col)) { const i = (y * w + x) * 4; px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; }
    }
    const self = {};
    new Function('self', fs.readFileSync(nodePath.join(__dirname, '..', 'public', 'vendor', 'jsqr', 'jsQR.js'), 'utf8'))(self);
    const out = self.jsQR(px, w, w, { inversionAttempts: 'dontInvert' });
    assert.ok(out, 'the QR code was read');
    assert.equal(out.data, `${base}/help/${M.slug}?c=R7`);
    // The words: the code very large, the text line only with a help number, and 911 always.
    assert.deepEqual(S.signWords({ code: 'R7', mountain: 'Places Peak', number: null }), { ask: 'Need ski patrol?', how: 'Scan this code', code: 'R7', emergency: 'Emergency? Call 911', mountain: 'Places Peak' });
    assert.equal(S.signWords({ code: 'R7', mountain: 'Places Peak', number: '555-0100' }).how, 'Scan, or text HELP R7 to 555-0100');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- calls
test('the call’s location panel: words, nearby places, Open in maps and when the caller last moved', async () => {
  const at = off(0, 30);
  const call = ok(await api('POST', '/patrol/dispatch', { token: M.patT, body: { location: 'Ridge Run', gps_lat: at.lat, gps_lng: at.lng } }));
  const w = ok(await api('GET', `/patrol/dispatch/${call.id}/where`, { token: M.patT }));
  assert.equal(w.words.text, 'Near Ridge Run, about 30 m');
  assert.deepEqual(w.places.slice(0, 2).map((p) => p.code), ['R7', 'S7']);
  assert.equal(w.places[0].distance_m, 30);
  assert.match(w.maps_url, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=39\.6/);
  assert.equal(typeof w.minutes_since_move, 'number');
  assert.ok(w.trail.length >= 1);
  // A call with no position says so.
  const none = ok(await api('POST', '/patrol/dispatch', { token: M.patT, body: { location: 'Somewhere' } }));
  const n = ok(await api('GET', `/patrol/dispatch/${none.id}/where`, { token: M.patT }));
  assert.equal(n.position, null); assert.equal(n.words, null);
  is(await api('GET', `/patrol/dispatch/${call.id}/where`, { token: M.liftyT }), 403, 'lift staff do not open the board');
});

test('Guest needs help here: one tap from lift staff makes a call at their position, audited, and responders get their alert', async () => {
  const at = off(5, 32);
  const r = await api('POST', '/patrol/staff-help', { token: M.liftyT, body: { lat: at.lat, lng: at.lng, accuracy_m: 9 } });
  is(r, 201);
  assert.equal(r.body.location, 'Near Ridge Run, about 30 m');
  const c = (await pool.query('SELECT * FROM dispatch_calls WHERE tenant_id = ? AND id = ?', [M.id, r.body.id]))[0][0];
  assert.equal(c.source, 'staff'); assert.equal(c.status, 'new'); assert.equal(c.priority, 'normal');
  assert.equal(c.caller_name, 'Staff: Lou Places');
  assert.equal(Number(c.located_accuracy_m), 9);
  assert.ok(Math.abs(Number(c.gps_lat) - at.lat) < 1e-6);
  const audit = (await pool.query("SELECT detail FROM audit_log WHERE tenant_id = ? AND action = 'staff_help' AND entity_id = ?", [M.id, c.id]))[0][0];
  assert.ok(audit, 'audited');
  assert.deepEqual(typeof audit.detail === 'string' ? JSON.parse(audit.detail) : audit.detail, { gps: true, accuracy_m: 9, confidence: 'high' });
  // On the board as a New call from staff.
  const board = ok(await api('GET', '/patrol/dispatch', { token: M.patT })).data;
  assert.equal(board.find((x) => x.id === c.id).source, 'staff');
  // Who and a short note afterwards, only by the person who sent it.
  is(await api('POST', `/patrol/staff-help/${c.id}/details`, { token: M.patT, body: { who: 'Someone else' } }), 404);
  ok(await api('POST', `/patrol/staff-help/${c.id}/details`, { token: M.liftyT, body: { who: 'Child in a red jacket', note: 'Fell at the top' } }));
  const after = (await pool.query('SELECT description FROM dispatch_calls WHERE id = ?', [c.id]))[0][0];
  assert.equal(after.description, 'Who: Child in a red jacket. Fell at the top');
  // Nobody signed in on duty: the call is on the board and staff are told no phone was alerted.
  assert.equal(r.body.alerted, 0); assert.equal(r.body.on_duty, 0);
  // As for a radio call, the patroller a dispatcher sends gets the phone alert.
  ok(await api('POST', '/patrol/duty/sign-in', { token: M.patT, body: {} }));
  const pushed = [];
  const real = PUSH.notifyStaff;
  PUSH.notifyStaff = async (tenantId, ids, msg) => { pushed.push({ tenantId, ids, msg }); return ids.length; };
  try { ok(await api('POST', `/patrol/dispatch/${c.id}/responders`, { token: M.leadT, body: { staff_id: M.pat } })); } finally { PUSH.notifyStaff = real; }
  assert.equal(pushed.length, 1);
  assert.deepEqual(pushed[0].ids, [M.pat]);
  assert.match(pushed[0].msg.body, /^Near Ridge Run, about 30 m/);
  // With a patroller on duty and no dispatcher: a staff call alerts patrol on duty at once, the same people and the same
  // way as a guest's request from the help page (2026.11.16). The alert says where, never the guest's words.
  pushed.length = 0;
  PUSH.notifyStaff = async (tenantId, ids, msg) => { pushed.push({ tenantId, ids, msg }); return ids.length; };
  let staffCall; let guestCall;
  try {
    staffCall = await api('POST', '/patrol/staff-help', { token: M.liftyT, body: { lat: at.lat, lng: at.lng, accuracy_m: 9 } });
    is(staffCall, 201);
    await pool.query('UPDATE tenants SET guest_help_enabled = 1 WHERE id = ?', [M.id]);
    guestCall = await api('POST', `/public/${M.slug}/help`, { body: { kind: 'help', gps_lat: at.lat, gps_lng: at.lng, accuracy: 9, description: 'my knee hurts', rid: require('crypto').randomBytes(16).toString('hex') } });
    is(guestCall, 201);
    for (let i = 0; i < 40 && pushed.length < 2; i++) await new Promise((res) => setTimeout(res, 25)); // the guest's alert does not hold up its answer
  } finally { PUSH.notifyStaff = real; }
  assert.equal(staffCall.body.alerted, 1); assert.equal(staffCall.body.on_duty, 1);
  const sAlert = pushed.find((p) => /^Guest needs help here: patrol call /.test(p.msg.title));
  const gAlert = pushed.find((p) => /^Guest help: patrol call /.test(p.msg.title));
  assert.ok(sAlert && gAlert, JSON.stringify(pushed.map((p) => p.msg.title)));
  assert.deepEqual(sAlert.ids, [M.pat]); assert.deepEqual(gAlert.ids, sAlert.ids, 'the same people');
  assert.equal(sAlert.msg.url, gAlert.msg.url);
  assert.match(sAlert.msg.body, /^Near Ridge Run, about 30 m\. Open the app/);
  assert.match(gAlert.msg.body, /^Near Ridge Run, about 30 m/);
  assert.doesNotMatch(gAlert.msg.body, /knee/, 'never the guest\'s words');
  assert.equal(sAlert.msg.tag, `call-${staffCall.body.id}`);
  // No GPS: the staff member says where. Neither: refused.
  const typed = ok(await api('POST', '/patrol/staff-help', { token: M.liftyT, body: { location: 'Bottom of Summit Quad' } }));
  assert.equal(typed.location, 'Bottom of Summit Quad');
  is(await api('POST', '/patrol/staff-help', { token: M.liftyT, body: {} }), 400);
});

// ---------------------------------------------------------------- tenant isolation
test('another mountain sees none of these places and cannot change them', async () => {
  const mine = await P.list(pool, M.id, { all: true });
  const ids = mine.map((p) => p.id);
  const list = ok(await api('GET', '/patrol/places', { token: N.owner })).data;
  assert.ok(!list.some((p) => ids.includes(p.id)), 'no row of M in N’s list');
  for (const id of [M.sign, M.tower]) {
    is(await api('PATCH', `/patrol/places/${id}`, { token: N.owner, body: { name: 'Taken over' } }), 404);
    is(await api('PUT', `/patrol/places/${id}/position`, { token: N.owner, body: { lat: 1, lng: 1, accuracy_m: 3 } }), 404);
    is(await api('POST', `/patrol/places/${id}/retire`, { token: N.owner }), 404);
  }
  const signs = ok(await api('GET', `/patrol/places/signs?ids=${ids.join(',')}`, { token: N.owner }));
  assert.ok(!signs.places.some((p) => ids.includes(p.id)));
  assert.equal(ok(await api('GET', `/patrol/places/signs?lift=${M.lift}`, { token: N.owner })).places.length, 0);
  // N's lifts and trails only: M's lift id is not found.
  is(await api('POST', '/patrol/places', { token: N.owner, body: { kind: 'tower', lift_id: M.lift, tower_no: 1, lat: LAT0, lng: LNG0, accuracy_m: 3 } }), 404);
  is(await api('POST', '/patrol/places/code', { token: N.owner, body: { kind: 'sign', trail_id: M.trail } }), 404);
  // M's calls: not N's to read or add to.
  const call = (await pool.query("SELECT id FROM dispatch_calls WHERE tenant_id = ? AND source = 'staff' LIMIT 1", [M.id]))[0][0].id;
  is(await api('GET', `/patrol/dispatch/${call}/where`, { token: N.owner }), 404);
  is(await api('POST', `/patrol/staff-help/${call}/details`, { token: N.owner, body: { note: 'x' } }), 404);
  // Words come from N's own places only (N has the imported copies here, at the same spots; M's ids never appear).
  const w = ok(await api('GET', `/patrol/places/describe?lat=${off(0, 30).lat}&lng=${off(0, 30).lng}&acc=8`, { token: N.owner })).words;
  assert.ok(w && !ids.includes(w.place_id));
  // And M is untouched.
  const rowsOf = (list) => list.map((p) => [p.id, p.name, p.lat, p.active]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(rowsOf(await P.list(pool, M.id, { all: true })), rowsOf(mine));
});

// ---------------------------------------------------------------- map orientation
test('uphill: the average bearing from lift bottoms to lift tops, or from the base to the summit weather point', async () => {
  // Bearings as directions: 350 and 10 average to 0, never 180.
  assert.equal(Math.round(P.meanBearing([350, 10])), 0);
  assert.equal(Math.round(P.meanBearing([80, 100])), 90);
  assert.equal(P.meanBearing([90, 270]), null, 'opposite lifts cancel out');
  assert.equal(Math.round(P.bearing(LAT0, LNG0, off(100, 100).lat, off(100, 100).lng)), 45);
  // The weather points first (no lift ends on N yet): base at the map point, summit 1 km due east.
  const east = off(0, 1000);
  await pool.query('UPDATE tenants SET map_lat = ?, map_lng = ?, wx_summit_lat = ?, wx_summit_lng = ? WHERE id = ?', [LAT0, LNG0, east.lat, east.lng, N.id]);
  assert.deepEqual(await P.uphill(pool, N.id), { deg: 90, from: 'weather', count: 1 });
  // Two lifts: one runs north-east (45), one north-west (315): uphill is north.
  const lift2 = Number(ok(await api('POST', '/schedule/lifts', { token: N.owner, body: { name: 'West Double' } })).id);
  const ends = [[N.lift, 'lift_bottom', 'NB1', off(0, 0)], [N.lift, 'lift_top', 'NT1', off(500, 500)], [lift2, 'lift_bottom', 'NB2', off(0, 0)], [lift2, 'lift_top', 'NT2', off(400, -400)]];
  for (const [lift, kind, code, at] of ends) await place(N, { kind, name: code, code, lift_id: lift, ...at });
  const u = await P.uphill(pool, N.id);
  assert.equal(u.from, 'lifts'); assert.equal(u.count, 2); assert.ok(u.deg <= 1 || u.deg >= 359, `uphill ${u.deg}`);
  // A lift with only its bottom marked does not count.
  await place(N, { kind: 'lift_bottom', name: 'Lone bottom', code: 'NB3', lift_id: N.lift, ...off(10, 0) });
  assert.equal((await P.uphill(pool, N.id)).count, 2);
});

test('turning the map needs the role: owners, managers and the patrol Director or Admin', async () => {
  for (const who of ['patT', 'leadT']) is(await api('PUT', '/patrol/places/orientation', { token: M[who], body: { rotation_deg: 90 } }), 403, who);
  is(await api('PUT', '/patrol/places/orientation', { token: M.liftyT, body: { rotation_deg: 90 } }), 403, 'lift staff');
  is(await api('PUT', '/patrol/places/orientation', { token: M.dirT, body: { rotation_deg: 360 } }), 400, 'up to 359');
  assert.equal(ok(await api('PUT', '/patrol/places/orientation', { token: M.dirT, body: { rotation_deg: 135 } })).rotation_deg, 135);
  assert.equal(ok(await api('GET', '/patrol/places/orientation', { token: M.patT })).rotation_deg, 135, 'every patroller’s maps follow it');
  assert.equal(ok(await api('GET', '/patrol/places/orientation', { token: M.patT })).can_turn, false);
  assert.equal(ok(await api('GET', '/park/map', { token: M.liftyT })).map_rotation_deg, 135, 'the terrain park map is turned too');
  ok(await api('PUT', '/patrol/places/orientation', { token: M.owner, body: { rotation_deg: 0 } }));
  const a = (await pool.query("SELECT action FROM audit_log WHERE tenant_id = ? AND action = 'set_map_rotation'", [M.id]))[0];
  assert.equal(a.length, 2);
  assert.equal(ok(await api('GET', '/patrol/places/orientation', { token: N.owner })).mode, 'uphill', 'each mountain its own');
  is(await api('PUT', '/patrol/places/orientation', { token: M.owner, body: {} }), 400, 'a rotation or auto');
});

test('uphill up is the default, worked out again as lift ends are marked, and a manual turn sticks until Back to uphill up', async () => {
  ok(await api('PUT', '/patrol/places/orientation', { token: M.owner, body: { auto: true } }));
  // No lift ends and no summit point on M: north up for now, and the mapping screen asks for a lift bottom and top.
  let o = ok(await api('GET', '/patrol/places/orientation', { token: M.leadT }));
  assert.deepEqual([o.mode, o.rotation_deg, o.uphill], ['north', 0, null]);
  const mark = (kind, code, at, lift = M.lift) => api('POST', '/patrol/places', { token: M.leadT, body: { kind, lift_id: lift, code, ...at, accuracy_m: 5 } });
  ok(await mark('lift_bottom', 'QB', off(3000, 0)));
  assert.equal(ok(await api('GET', '/patrol/places/orientation', { token: M.leadT })).mode, 'north', 'a bottom alone is not enough');
  ok(await mark('lift_top', 'QT', off(3500, 500))); // north-east of its bottom
  o = ok(await api('GET', '/patrol/places/orientation', { token: M.leadT }));
  assert.deepEqual([o.mode, o.rotation_deg], ['uphill', 45], 'base at the bottom, by default');
  assert.equal(ok(await api('GET', '/park/map', { token: M.liftyT })).map_rotation_deg, 45);
  // A second lift running due north: worked out again, the average of the two.
  const lift2 = Number(ok(await api('POST', '/schedule/lifts', { token: M.owner, body: { name: 'North Double' } })).id);
  ok(await mark('lift_bottom', 'NDB', off(3000, 100), lift2));
  ok(await mark('lift_top', 'NDT', off(3600, 100), lift2));
  const both = ok(await api('GET', '/patrol/places/orientation', { token: M.leadT })).rotation_deg;
  assert.ok(both >= 22 && both <= 23, `the average of 45 and 0 is about 22.5, got ${both}`);
  // A manual turn sticks, however many lifts are marked after it.
  ok(await api('PUT', '/patrol/places/orientation', { token: M.dirT, body: { rotation_deg: 200 } }));
  ok(await mark('lift_top', 'NDX', off(3600, 300), lift2));
  o = ok(await api('GET', '/patrol/places/orientation', { token: M.leadT }));
  assert.deepEqual([o.mode, o.rotation_deg], ['manual', 200]);
  assert.ok(o.uphill, 'uphill is still worked out, ready for Back to uphill up');
  // Back to uphill up.
  o = ok(await api('PUT', '/patrol/places/orientation', { token: M.dirT, body: { auto: true } }));
  assert.equal(o.mode, 'uphill');
  assert.equal((await pool.query('SELECT map_rotation_deg FROM tenants WHERE id = ?', [M.id]))[0][0].map_rotation_deg, null);
});

test('the turned projection: 90, 180 and 270 degrees turn the points, never mirror them, and labels stay upright', async () => {
  const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'hp-turn-'));
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); } catch (_) { /* below */ }
  try {
    fs.cpSync(nodePath.join(__dirname, '..', 'public', 'js'), nodePath.join(tmp, 'js'), { recursive: true });
    fs.writeFileSync(nodePath.join(tmp, 'package.json'), '{"type":"module"}');
    const T = await import(pathToFileURL(nodePath.join(tmp, 'js', 'mapturn.js')).href);
    // 100 m east of the middle, with each direction at the top.
    const round = (p) => ({ x: Math.round(p.x) + 0, y: Math.round(p.y) + 0 });
    assert.deepEqual(round(T.turn(100, 0, 0)), { x: 100, y: 0 });
    assert.deepEqual(round(T.turn(100, 0, 90)), { x: 0, y: -100 }, 'east up: east is at the top');
    assert.deepEqual(round(T.turn(100, 0, 180)), { x: -100, y: 0 }, 'turned around: east is on the left');
    assert.deepEqual(round(T.turn(100, 0, 270)), { x: 0, y: 100 }, 'west up: east is at the bottom');
    for (const up of [0, 90, 180, 270, 37]) {
      // A turn, not a mirror: walking from north to east is still clockwise on screen.
      const n = T.turn(0, 1, up); const e = T.turn(1, 0, up);
      assert.ok(n.x * e.y - n.y * e.x > 0, `${up}: clockwise stays clockwise`);
      assert.deepEqual(round(T.northOnScreen(up)), round(T.turn(0, 1, up)));
    }
    if (!JSDOM) return;
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const saved = globalThis.document;
    globalThis.document = dom.window.document;
    try {
      const { placeMap } = await import(pathToFileURL(nodePath.join(tmp, 'js', 'placemap.js')).href);
      const pts = [{ code: 'MID', kind: 'sign', ...off(0, 0) }, { code: 'EAST', kind: 'sign', ...off(0, 200) }, { code: 'NORTH', kind: 'tower', ...off(200, 0) }];
      const at = (svgEl, code) => { const t = [...svgEl.querySelectorAll('text.pm-label')].find((x) => x.textContent === code); return { x: Number(t.getAttribute('x')), y: Number(t.getAttribute('y')), t }; };
      for (const [up, eastIs] of [[0, 'right'], [90, 'up'], [180, 'left'], [270, 'down']]) {
        const el = placeMap(pts, { width: 400, height: 400, rotation: up });
        const m = at(el, 'MID'); const e = at(el, 'EAST');
        const dx = e.x - m.x; const dy = e.y - m.y;
        const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
        assert.equal(dir, eastIs, `${up} degrees: east is ${eastIs}`);
        for (const t of el.querySelectorAll('text')) assert.ok(!t.getAttribute('transform') && !t.getAttribute('rotate'), `${up}: text "${t.textContent}" is upright`);
        assert.equal(el.querySelector('.pm-north').getAttribute('data-up'), String(up), 'a north arrow on every map');
      }
    } finally { globalThis.document = saved; }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the call map draws the guest’s last positions when help/guest keeps them (dispatch_positions)', async (t) => {
  const [[has]] = await pool.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'dispatch_positions'");
  if (!Number(has.n)) { t.skip('dispatch_positions comes with help/guest; this runs once the branches are together'); return; }
  const call = ok(await api('POST', '/patrol/dispatch', { token: M.patT, body: { location: 'Trail test' } }));
  const steps = [[0, 30, '10:00:00'], [5, 31, '10:01:00'], [80, 30, '10:02:00']];
  for (const [n, e, time] of steps) {
    const p = off(n, e);
    await pool.query('INSERT INTO dispatch_positions (tenant_id, call_id, lat, lng, accuracy_m, taken_at, received_at) VALUES (?, ?, ?, ?, 8, ?, ?)', [M.id, call.id, p.lat, p.lng, `2026-11-09 ${time}`, `2026-11-09 ${time}`]);
  }
  const w = ok(await api('GET', `/patrol/dispatch/${call.id}/where`, { token: M.patT }));
  assert.equal(w.trail.length, 3);
  assert.equal(w.position.at, '2026-11-09 10:02:00');
  assert.equal(w.last_moved_at, '2026-11-09 10:02:00', 'the 80 m step is the last move; the 5 m one is the phone wobbling');
});
