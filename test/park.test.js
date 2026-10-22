'use strict';

// The terrain park: features, daily placements on the map, copying a day, inspections, who may change what.
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
const today = day(0); const yesterday = day(-1); const tomorrow = day(1);

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
  A = await mountain(`pk-${suffix}`); B = await mountain(`pb-${suffix}`);
  for (const role of ['staff', 'counter', 'patrol', 'manager']) {
    ok(await api('POST', '/users', { token: A.owner, body: { email: `${role}@${A.slug}.test`, password: PW, role } }), 201);
    T[role] = await login(A, `${role}@${A.slug}.test`);
  }
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

const spot = (n = 0) => ({ lat: 44.1234 + n * 0.0001, lng: -71.5678 - n * 0.0001 });

test('the catalog: types, areas and features, with crew allowed to edit and others only to look', async () => {
  const kinds = ok(await api('GET', '/park/kinds', { token: T.counter })).data;
  assert.ok(kinds.find((k) => k.key === 'butter_box' && k.portable) && kinds.find((k) => k.key === 'halfpipe' && !k.portable));
  D.area = ok(await api('POST', '/park/areas', { token: T.staff, body: { name: 'Main Park', level: 'medium' } }), 201).id;
  is(await api('POST', '/park/areas', { token: T.staff, body: { name: 'Main Park' } }), 409, 'duplicate area name');
  is(await api('POST', '/park/features', { token: T.counter, body: { name: 'Nope', kind: 'butter_box' } }), 403, 'a counter login cannot add features');
  is(await api('POST', '/park/features', { token: T.staff, body: { name: 'Bad', kind: 'trampoline' } }), 400, 'unknown type');
  D.box = ok(await api('POST', '/park/features', { token: T.staff, body: { name: 'Butter box 1', kind: 'butter_box', size: 's', dimensions: '8 ft' } }), 201).id;
  D.rail = ok(await api('POST', '/park/features', { token: T.staff, body: { name: 'Down rail 1', kind: 'rail_down', size: 'm' } }), 201).id;
  D.hip = ok(await api('POST', '/park/features', { token: T.manager, body: { name: 'Big hip', kind: 'hip', size: 'xl' } }), 201).id;
  is(await api('POST', '/park/features', { token: T.staff, body: { name: 'Butter box 1', kind: 'butter_box' } }), 409, 'duplicate feature name');
  const list = ok(await api('GET', '/park/features', { token: T.patrol })).data;
  assert.equal(list.length, 3);
  assert.equal(list.find((f) => f.id === D.hip).portable, false, 'a hip is not portable by default');
  assert.equal(list.find((f) => f.id === D.box).portable, true);
  ok(await api('PATCH', `/park/features/${D.rail}`, { token: T.staff, body: { dimensions: '14 ft', size: 'l' } }));
  is(await api('PATCH', `/park/features/${D.rail}`, { token: T.counter, body: { size: 'm' } }), 403);
});

test('placing features on the map for a day, moving them, and taking them off', async () => {
  const day0 = ok(await api('GET', `/park/placements/${today}`, { token: T.patrol }));
  assert.equal(day0.placed.length, 0);
  assert.equal(day0.unplaced.length, 3, 'every feature is free to place');
  is(await api('PUT', `/park/placements/${today}/${D.box}`, { token: T.counter, body: spot() }), 403, 'only crew place');
  is(await api('PUT', `/park/placements/${today}/${D.box}`, { token: T.staff, body: { lat: 200, lng: 0 } }), 400, 'bad coordinates');
  is(await api('PUT', `/park/placements/${today}/${D.box}`, { token: T.staff, body: { ...spot(), area_id: 999999 } }), 404, 'unknown area');
  is(await api('PUT', `/park/placements/${today}/${D.box}`, { token: T.staff, body: { ...spot(1), area_id: D.area, note: 'Under the lip' } }), 201);
  is(await api('PUT', `/park/placements/${today}/${D.rail}`, { token: T.staff, body: spot(2) }), 201);
  assert.equal(ok(await api('PUT', `/park/placements/${today}/${D.box}`, { token: T.staff, body: { ...spot(3), area_id: D.area } })).moved, true, 'placing again moves it');
  const d = ok(await api('GET', `/park/placements/${today}`, { token: T.counter }));
  assert.equal(d.placed.length, 2); assert.equal(d.unplaced.length, 1);
  const box = d.placed.find((p) => p.feature_id === D.box);
  assert.equal(box.area, 'Main Park'); assert.ok(Math.abs(box.lat - spot(3).lat) < 1e-6, 'moved to the new spot');
  assert.equal(d.editable, true);
  ok(await api('DELETE', `/park/placements/${today}/${D.rail}`, { token: T.staff }));
  is(await api('DELETE', `/park/placements/${today}/${D.rail}`, { token: T.staff }), 404);
  assert.equal(ok(await api('GET', `/park/placements/${today}`, { token: T.staff })).placed.length, 1);
  const audits = (await pool.query("SELECT action FROM audit_log WHERE entity = 'park_placements' ORDER BY id"))[0].map((r) => r.action);
  for (const a of ['place', 'move', 'unplace']) assert.ok(audits.includes(a), `${a} is audited`);
});

test('a pin remembers how it was put down: GPS with its accuracy, a tap, or a drag; editing the note keeps it', async () => {
  const at = spot(7);
  is(await api('PUT', `/park/placements/${today}/${D.rail}`, { token: T.staff, body: { ...at, how: 'gps', accuracy_m: 4.6 } }), 201);
  const pin = async () => ok(await api('GET', `/park/placements/${today}`, { token: T.staff })).placed.find((p) => p.feature_id === D.rail);
  let p = await pin();
  assert.equal(p.placed_how, 'gps'); assert.equal(p.accuracy_m, 5);
  ok(await api('PUT', `/park/placements/${today}/${D.rail}`, { token: T.staff, body: { ...at, note: 'Kicker on the left' } }));
  p = await pin();
  assert.equal(p.placed_how, 'gps', 'same spot: still placed by GPS'); assert.equal(p.accuracy_m, 5); assert.equal(p.note, 'Kicker on the left');
  ok(await api('PUT', `/park/placements/${today}/${D.rail}`, { token: T.staff, body: { ...spot(8), how: 'drag', accuracy_m: 50 } }));
  p = await pin();
  assert.equal(p.placed_how, 'drag'); assert.equal(p.accuracy_m, null, 'a dragged pin has no GPS accuracy');
  is(await api('PUT', `/park/placements/${today}/${D.rail}`, { token: T.staff, body: { ...at, how: 'teleport' } }), 400);
  ok(await api('DELETE', `/park/placements/${today}/${D.rail}`, { token: T.staff }));
});

test('a past day is a record: crew cannot change it but a manager can; tomorrow can be planned; copy a day forward', async () => {
  is(await api('PUT', `/park/placements/${yesterday}/${D.box}`, { token: T.staff, body: spot() }), 403, 'crew cannot edit yesterday');
  is(await api('PUT', `/park/placements/${yesterday}/${D.box}`, { token: T.manager, body: spot() }), 201, 'a manager can');
  is(await api('PUT', `/park/placements/${yesterday}/${D.rail}`, { token: T.manager, body: spot(5) }), 201);
  assert.equal(ok(await api('GET', `/park/placements/${yesterday}`, { token: T.staff })).editable, false);
  is(await api('POST', `/park/placements/${today}/copy`, { token: T.staff, body: { from: today } }), 400, 'cannot copy a day onto itself');
  const c = ok(await api('POST', `/park/placements/${today}/copy`, { token: T.staff, body: { from: yesterday } }));
  assert.equal(c.copied, 1, 'the rail comes over; the box is already placed today and is left alone');
  const t = ok(await api('GET', `/park/placements/${today}`, { token: T.staff })).placed;
  assert.equal(t.length, 2);
  assert.ok(Math.abs(t.find((p) => p.feature_id === D.box).lat - spot(3).lat) < 1e-6, 'copy does not move what is already placed');
  is(await api('PUT', `/park/placements/${tomorrow}/${D.hip}`, { token: T.staff, body: spot(9) }), 201, 'tomorrow can be planned');
  const days = ok(await api('GET', '/park/days', { token: T.patrol })).data;
  assert.ok(days.length >= 3);
  const hist = ok(await api('GET', `/park/features/${D.box}/history`, { token: T.patrol })).data;
  assert.ok(hist.length >= 2, 'the history shows where the box has been');
});

test('inspections move a feature to ready, needs attention or closed, and show on the day', async () => {
  is(await api('POST', `/park/features/${D.box}/inspections`, { token: T.counter, body: { result: 'ok' } }), 403);
  is(await api('POST', `/park/features/${D.box}/inspections`, { token: T.staff, body: { result: 'closed' } }), 400, 'a problem needs a note');
  assert.equal(ok(await api('POST', `/park/features/${D.box}/inspections`, { token: T.staff, body: { result: 'needs_attention', notes: 'Loose bolt' } }), 201).status, 'needs_attention');
  let d = ok(await api('GET', `/park/placements/${today}`, { token: T.staff }));
  assert.equal(d.placed.find((p) => p.feature_id === D.box).feature_status, 'needs_attention');
  assert.equal(d.placed.find((p) => p.feature_id === D.box).inspected_result, 'needs_attention');
  assert.equal(d.placed.find((p) => p.feature_id === D.rail).inspected_result, null, 'not inspected yet today');
  ok(await api('POST', `/park/features/${D.box}/inspections`, { token: T.staff, body: { result: 'ok', notes: 'Tightened' } }), 201);
  d = ok(await api('GET', `/park/placements/${today}`, { token: T.staff }));
  assert.equal(d.placed.find((p) => p.feature_id === D.box).feature_status, 'ready');
  const hist = ok(await api('GET', `/park/features/${D.box}/inspections`, { token: T.patrol })).data;
  assert.equal(hist.length, 2); assert.equal(hist[0].result, 'ok');
  const f = ok(await api('GET', '/park/features', { token: T.staff })).data.find((x) => x.id === D.box);
  assert.equal(f.last_result, 'ok');
});

test('retired features cannot be placed or inspected, and one mountain never sees another\'s park', async () => {
  ok(await api('PATCH', `/park/features/${D.hip}`, { token: T.manager, body: { status: 'retired' } }));
  is(await api('PUT', `/park/placements/${today}/${D.hip}`, { token: T.staff, body: spot() }), 409);
  is(await api('POST', `/park/features/${D.hip}/inspections`, { token: T.staff, body: { result: 'ok' } }), 409);
  assert.ok(!ok(await api('GET', `/park/placements/${today}`, { token: T.staff })).unplaced.some((f) => f.id === D.hip), 'retired features are not offered');
  assert.equal(ok(await api('GET', '/park/features', { token: B.owner })).data.length, 0);
  is(await api('PUT', `/park/placements/${today}/${D.box}`, { token: B.owner, body: spot() }), 404, 'another mountain cannot place our feature');
  is(await api('GET', '/park/placements/not-a-date', { token: T.staff }), 400);
  const m = ok(await api('GET', '/park/map', { token: T.staff }));
  assert.ok(m.layers.length && m.can_edit && m.center && m.center.source === 'park', 'the map opens on the placements');
  assert.equal(ok(await api('GET', '/park/map', { token: T.counter })).can_edit, false);
  ok(await api('PATCH', `/park/areas/${D.area}`, { token: T.staff, body: { status: 'closed' } }));
  assert.equal(ok(await api('GET', '/park/areas', { token: T.patrol })).data[0].status, 'closed');
});
