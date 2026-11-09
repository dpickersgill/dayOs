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
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

// ---------------------------------------------------------------- describe()
test('describe(): a trail sign with a tower above it, in English and Spanish', async () => {
  const at = off(0, 30);
  const w = await P.describe(pool, M.id, at.lat, at.lng, 8);
  assert.equal(w.text, 'Near Ridge Run, below Summit Quad tower 7, about 30 m');
  assert.equal(w.text_es, 'Cerca de Ridge Run, debajo de la torre 7 de Summit Quad, a unos 30 m');
  assert.equal(w.place_id, M.sign);
  assert.equal(w.distance_m, 30);
  assert.equal(w.confidence, 'high');
});

test('describe(): a junction, rough accuracy, and nothing mapped', async () => {
  const j = off(2000, 0);
  const near = off(0, 60, j);
  const w = await P.describe(pool, M.id, near.lat, near.lng, 20);
  assert.equal(w.text, 'Near Ridge Run and Bowl, about 60 m');
  assert.equal(w.text_es, 'Cerca de Ridge Run and Bowl, a unos 60 m');
  assert.equal(w.confidence, 'medium', 'over 50 m from the nearest point');
  // A phone out by 150 m looks out to 450 m, and says the place is rough.
  const far = off(-300, 0, j);
  const r = await P.describe(pool, M.id, far.lat, far.lng, 150);
  assert.equal(r.text, 'Near Ridge Run and Bowl, about 300 m (location rough)');
  assert.equal(r.text_es, 'Cerca de Ridge Run and Bowl, a unos 300 m (ubicación aproximada)');
  assert.equal(r.confidence, 'low');
  // The same spot with a good fix looks only 150 m out: nothing there.
  assert.equal(await P.describe(pool, M.id, far.lat, far.lng, 10), null);
  // Never past 600 m, however rough the phone.
  const out = off(650, 0, j);
  assert.equal(await P.describe(pool, M.id, out.lat, out.lng, 5000), null);
  // Nothing mapped on this mountain at all.
  assert.equal(await P.describe(pool, N.id, LAT0, LNG0, 5), null);
  // Only a tower in range: the words start from it.
  const t = P.wordsFor([{ id: 9, kind: 'tower', lift_name: 'Summit Quad', tower_no: 3, distance_m: 12 }], 10);
  assert.equal(t.text, 'Below Summit Quad tower 3, about 10 m');
  assert.equal(t.text_es, 'Debajo de la torre 3 de Summit Quad, a unos 10 m');
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
  assert.equal(w.text, 'Near Ridge Run, below Summit Quad tower 7, about 30 m');
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
  assert.equal(w.words.text, 'Near Ridge Run, below Summit Quad tower 7, about 30 m');
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
  assert.equal(r.body.location, 'Near Ridge Run, below Summit Quad tower 7, about 30 m');
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
  // As for a radio call, the patroller a dispatcher sends gets the phone alert.
  ok(await api('POST', '/patrol/duty/sign-in', { token: M.patT, body: {} }));
  const pushed = [];
  const real = PUSH.notifyStaff;
  PUSH.notifyStaff = async (tenantId, ids, msg) => { pushed.push({ tenantId, ids, msg }); return ids.length; };
  try { ok(await api('POST', `/patrol/dispatch/${c.id}/responders`, { token: M.leadT, body: { staff_id: M.pat } })); } finally { PUSH.notifyStaff = real; }
  assert.equal(pushed.length, 1);
  assert.deepEqual(pushed[0].ids, [M.pat]);
  assert.match(pushed[0].msg.body, /^Near Ridge Run, below Summit Quad tower 7/);
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
