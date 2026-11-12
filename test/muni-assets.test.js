'use strict';

// Asset management for water, sewer and stormwater (muni release 1, the "assets" workstream): condition, criticality and
// risk on the register and the map; the municipal map kinds, each turned on by its add-on; work orders and inspections
// on map features; the new checklist item kinds (readings with ranges, choices, yes or no, text, condition, photos); the
// built-in template packs, given once when an add-on is on; programs over many targets; pump run hours by month; and
// one tenant never reaching another's. A ski area keeps everything it had.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const CR = require('../src/lib/checkrules');
const TP = require('../src/lib/templatepacks');
const { createMuniTenant } = require('./helpers/muni');

const KEY = 'test-bootstrap-key';
const PW = 'correct-horse-battery';
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
// A tiny real JPEG (the same one the claims test uses).
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
let server; let base;
let A; let B; let crewA; let ski; let skiToken;

async function api(method, p, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, {
    method,
    headers: { 'content-type': raw ? 'image/jpeg' : 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw || (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);
const platform = (method, p, body) => api(method, `/platform${p}`, { headers: { 'x-platform-key': KEY }, body });
const P = (i, j = 0) => [40 + i * 0.001, -75.5 - j * 0.001];
const point = async (M, kind, at, extra = {}) => { const r = await api('POST', '/assets/map/features', { token: M.token, body: { kind, points: [at], ...extra } }); is(r, 201, `add ${kind}`); return r.body; };
const templatesOf = async (M) => (await api('GET', '/assets/templates', { token: M.token })).body.data;
const tplNamed = async (M, name) => (await templatesOf(M)).find((t) => t.name === name);

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await createMuniTenant(base, { slug: `ma-a-${suffix}`, name: `Riverbend Test ${suffix}` });
  B = await createMuniTenant(base, { slug: `ma-b-${suffix}`, name: `Other Borough ${suffix}`, modules: { water: true, sewer: true, stormwater: true } });
  crewA = await A.addLogin('staff');
  const made = await platform('POST', '/tenants', { slug: `ma-ski-${suffix}`, name: `Pine Test ${suffix}`, billing: 'comped', modules: { assets: true }, owner: { email: `gm@ma-ski-${suffix}.test`, password: PW, first_name: 'Gale', last_name: 'Ridge' } });
  is(made, 201);
  ski = { id: Number(made.body.id), slug: `ma-ski-${suffix}` };
  skiToken = (await api('POST', '/auth/login', { body: { tenant: ski.slug, login: `gm@ma-ski-${suffix}.test`, password: PW } })).body.token;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

// ---------------------------------------------------------------- map kinds by add-on and kind of tenant
test('municipal map kinds come with their add-on; snowmaking kinds are a ski area\'s only; the old utility kinds are for both', async () => {
  let map = (await api('GET', '/assets/map', { token: A.token })).body;
  const keys = () => map.kinds.map((k) => k.key);
  assert.ok(keys().includes('valve') && keys().includes('sewer_line') && keys().includes('catch_basin'), 'utility kinds for both');
  assert.ok(keys().includes('streetlight') && keys().includes('sign'), 'streets kinds are core');
  assert.ok(!keys().includes('fire_hydrant') && !keys().includes('sewer_manhole') && !keys().includes('storm_outfall'), 'no add-on, no kinds');
  assert.ok(!keys().includes('hydrant') && !keys().includes('air_line'), 'no snowmaking for a municipality');
  assert.equal(map.kinds.find((k) => k.key === 'valve').system, 'potable', 'a municipality\'s valve is drinking water');

  const refused = await api('POST', '/assets/map/features', { token: A.token, body: { kind: 'fire_hydrant', points: [P(1)] } });
  is(refused, 400); assert.match(refused.body.error, /Water add-on/);
  is(await api('POST', '/assets/map/features', { token: A.token, body: { kind: 'hydrant', points: [P(1)] } }), 400, 'snowmaking hydrant');
  await point(A, 'streetlight', P(1, 1));

  is(await platform('PUT', `/tenants/${A.id}/modules`, { modules: { water: true, sewer: true, stormwater: true } }), 200);
  map = (await api('GET', '/assets/map', { token: A.token })).body;
  for (const k of ['fire_hydrant', 'water_service', 'curb_stop', 'sewer_manhole', 'lift_station', 'force_main', 'storm_outfall', 'storm_inlet', 'storm_pipe', 'bmp']) assert.ok(keys().includes(k), k);
  assert.deepEqual(map.kinds.find((k) => k.key === 'bmp').geometries, ['area', 'point']);
  const h = await point(A, 'fire_hydrant', P(2), { tag: 'H-201', condition_score: 3, criticality: 4, ownership: 'own' });
  assert.equal(h.system, 'potable'); assert.equal(h.group, 'water'); assert.equal(h.kind_label, 'Fire hydrant');
  assert.deepEqual(h.risk, { score: 12, level: 'high', label: 'High' });
  // A stormwater facility is an area, or a point when it is small.
  await point(A, 'bmp', P(3), { geometry: 'point', name: 'Rain garden at the library' });
  is(await api('POST', '/assets/map/features', { token: A.token, body: { kind: 'bmp', points: [P(3), P(4), P(5)] } }), 201);
  is(await api('POST', '/assets/map/features', { token: A.token, body: { kind: 'fire_hydrant', geometry: 'line', points: [P(3), P(4)] } }), 400);
  // A tag is one map item's only.
  const dup = await api('POST', '/assets/map/features', { token: A.token, body: { kind: 'fire_hydrant', points: [P(6)], tag: 'H-201' } });
  is(dup, 409); assert.match(dup.body.error, /tag/);
  // A valve cannot become a pipe; a hydrant can only change to a kind this municipality may use.
  is(await api('PATCH', `/assets/map/features/${h.id}`, { token: A.token, body: { kind: 'hydrant' } }), 400);
});

test('a ski area keeps its map: snowmaking hydrants yes, fire hydrants and pump stations never, and no built-in packs', async () => {
  const map = (await api('GET', '/assets/map', { token: skiToken })).body;
  const keys = map.kinds.map((k) => k.key);
  assert.ok(keys.includes('hydrant') && keys.includes('water_line') && keys.includes('air_line') && keys.includes('valve'));
  assert.ok(!keys.includes('fire_hydrant') && !keys.includes('lift_station') && !keys.includes('streetlight'));
  assert.equal(map.kinds.find((k) => k.key === 'valve').system, 'water', 'a ski area\'s valve is snowmaking water');
  is(await api('POST', '/assets/map/features', { token: skiToken, body: { kind: 'fire_hydrant', points: [[44.1, -71.2]] } }), 400);
  const v = await api('POST', '/assets/map/features', { token: skiToken, body: { kind: 'hydrant', points: [[44.1, -71.2]], condition_score: 2, criticality: 5 } });
  is(v, 201); assert.equal(v.body.risk.label, 'Medium');
  const names = (await templatesOf({ token: skiToken })).map((t) => t.name);
  assert.ok(names.includes('Groomer pre-shift') && names.includes('Vehicle pre-trip'));
  assert.ok(!names.includes('Valve exercise') && !names.includes('Pump station round'));
  // Even if asked to, a ski area is never given a pack.
  const conn = await pool.getConnection();
  try { assert.deepEqual(await TP.seed(conn, ski.id), []); } finally { conn.release(); }
});

// ---------------------------------------------------------------- template packs
test('template packs: given when the add-on is turned on, once, and editable afterward', async () => {
  // Every item in every pack passes the same checks a manager's own checklist does.
  for (const [pack, list] of Object.entries(TP.PACKS)) for (const [name, , , items] of list) for (const it of items) assert.ok(CR.stepSchema.safeParse(it).success, `${pack} ${name} ${it.key}`);
  const names = (await templatesOf(A)).map((t) => t.name);
  for (const n of ['Valve exercise', 'Hydrant flush and inspection', 'Manhole inspection', 'Pump station round', 'Outfall dry-weather screening', 'Inlet inspection', 'Stormwater facility inspection']) assert.ok(names.includes(n), n);
  assert.ok(names.includes('Public works truck pre-trip') && !names.includes('Vehicle pre-trip'), 'the trucks\' pre-trip too (2026.11.20: the public works one, not the ski area\'s)');
  assert.ok(!names.includes('Groomer pre-shift') && !names.includes('Snowmobile or UTV pre-ride'), 'nothing about snow for a municipality');
  const valve = await tplNamed(A, 'Valve exercise');
  assert.deepEqual(valve.map_kinds, ['valve']); assert.equal(valve.sets_condition, true); assert.equal(valve.pack, 'water');
  assert.ok(valve.items.some((i) => i.type === 'choice') && valve.items.some((i) => i.type === 'condition') && valve.items.some((i) => i.type === 'yesno'));

  // Renamed and retired, then the add-on goes off and on again: nothing comes back, nothing doubles.
  is(await api('PATCH', `/assets/templates/${valve.id}`, { token: A.token, body: { name: 'Valve exercising (ours)', active: false } }), 200);
  is(await platform('PUT', `/tenants/${A.id}/modules`, { modules: { water: false } }), 200);
  is(await platform('PUT', `/tenants/${A.id}/modules`, { modules: { water: true } }), 200);
  await templatesOf(A);
  const again = await templatesOf(A);
  assert.equal(again.filter((t) => t.name === 'Valve exercise').length, 0);
  assert.equal(again.filter((t) => t.name === 'Valve exercising (ours)').length, 1);
  assert.equal(again.filter((t) => t.name === 'Hydrant flush and inspection').length, 1);
  const [[packs]] = await pool.query('SELECT COUNT(*) AS n FROM asset_template_packs WHERE tenant_id = ?', [A.id]);
  assert.equal(Number(packs.n), 4, 'water, sewer, stormwater and the fleet pack every municipality gets');
  is(await api('PATCH', `/assets/templates/${valve.id}`, { token: A.token, body: { name: 'Valve exercise', active: true } }), 200);
  // A pack checklist that sets the condition keeps its condition item.
  const noCond = valve.items.filter((i) => i.type !== 'condition');
  const r = await api('PATCH', `/assets/templates/${valve.id}`, { token: A.token, body: { items: noCond } });
  is(r, 400); assert.match(r.body.error, /condition score item/);
  // Only a manager changes checklists.
  is(await api('PATCH', `/assets/templates/${valve.id}`, { token: crewA.token, body: { active: false } }), 403);
});

// ---------------------------------------------------------------- inspections with measured fields
test('each new item kind: a reading outside its range, a failing choice and a yes that fails all fail by themselves', async () => {
  const tpl = await api('POST', '/assets/templates', { token: A.token, body: { name: `Every kind ${suffix}`, map_kinds: ['valve'], sets_condition: true, items: [
    { key: 'pressure', label: 'Pressure', type: 'number', unit: 'psi', min: 20, max: 150 },
    { key: 'box', label: 'Valve box', type: 'choice', options: ['Good', 'Damaged'], fail_options: ['Damaged'] },
    { key: 'seen', label: 'What you saw', type: 'text' },
    { key: 'leak', label: 'Leaking', type: 'yesno', fail_on: 'yes' },
    { key: 'cond', label: 'Condition', type: 'condition' },
    { key: 'lid', label: 'Lid', type: 'pass', photo: true },
  ] } });
  is(tpl, 201);
  // Bad set-ups are refused with a plain reason.
  const bad1 = await api('POST', '/assets/templates', { token: A.token, body: { name: `Bad ${suffix}`, items: [{ key: 'x', label: 'Pick', type: 'choice', options: ['Only one'] }] } });
  is(bad1, 400); assert.match(JSON.stringify(bad1.body), /two choices/);
  is(await api('POST', '/assets/templates', { token: A.token, body: { name: `Bad2 ${suffix}`, items: [{ key: 'x', label: 'Pick', type: 'choice', options: ['A', 'B'], fail_options: ['C'] }] } }), 400);
  is(await api('POST', '/assets/templates', { token: A.token, body: { name: `Bad3 ${suffix}`, items: [{ key: 'x', label: 'X', type: 'text' }], map_kinds: ['not_a_kind'] } }), 400);

  const v = await point(A, 'valve', P(10), { tag: 'V-114', criticality: 3 });
  const pic = await api('POST', `/assets/map/features/${v.id}/photos?caption=Lid`, { token: crewA.token, raw: JPEG });
  is(pic, 201); assert.equal(pic.body.sha256.length, 64);
  const good = [
    { key: 'pressure', value: 80 }, { key: 'box', value: 'Good' }, { key: 'seen', value: 'Turned easily' }, { key: 'leak', value: 'no' }, { key: 'cond', value: 2 }, { key: 'lid', result: 'pass', photo_id: pic.body.id },
  ];
  const ins = (items, token = crewA.token) => api('POST', `/assets/map/features/${v.id}/inspections`, { token, body: { template_id: tpl.body.id, items } });
  // Each item answered by its kind.
  const missingPhoto = await ins(good.map((i) => (i.key === 'lid' ? { key: 'lid', result: 'pass' } : i)));
  is(missingPhoto, 400); assert.match(missingPhoto.body.error, /Lid: take a photo/);
  is(await ins(good.map((i) => (i.key === 'box' ? { key: 'box', value: 'Shiny' } : i))), 400, 'not one of the choices');
  is(await ins(good.map((i) => (i.key === 'seen' ? { key: 'seen', value: '  ' } : i))), 400, 'text is written');
  is(await ins(good.map((i) => (i.key === 'leak' ? { key: 'leak', value: 'maybe' } : i))), 400, 'yes or no');
  is(await ins(good.map((i) => (i.key === 'cond' ? { key: 'cond', value: 7 } : i))), 400, 'condition 1 to 5');
  is(await ins(good.map((i) => (i.key === 'pressure' ? { key: 'pressure', value: true } : i))), 400, 'a reading is a number');

  const pass = await ins(good);
  is(pass, 201); assert.equal(pass.body.result, 'pass'); assert.equal(pass.body.work_order_id, null); assert.equal(pass.body.condition_score, 2);
  let panel = (await api('GET', `/assets/map/features/${v.id}`, { token: crewA.token })).body;
  assert.equal(panel.condition_score, 2, 'the checklist set the condition');
  assert.equal(panel.risk.score, 6);
  assert.equal(panel.last_inspection.result, 'pass');
  assert.equal(panel.photos.length, 1); assert.equal(panel.photos[0].inspection_id, pass.body.id);
  assert.equal(panel.inspections[0].items.find((i) => i.key === 'lid').photo_id, pic.body.id);
  // The same photo cannot answer a second inspection.
  is(await ins(good), 409);

  // Fails by itself: the reading below range, the damaged box, the yes. A work order opens on the valve.
  const pic2 = await api('POST', `/assets/map/features/${v.id}/photos`, { token: crewA.token, raw: JPEG });
  const fail = await ins([{ key: 'pressure', value: 12 }, { key: 'box', value: 'damaged' }, { key: 'seen', value: 'Box cracked' }, { key: 'leak', value: true }, { key: 'cond', value: 4 }, { key: 'lid', result: 'pass', photo_id: pic2.body.id }]);
  is(fail, 201); assert.equal(fail.body.result, 'fail'); assert.ok(fail.body.work_order_id);
  const wo = (await api('GET', `/ops/work-orders/${fail.body.work_order_id}`, { token: crewA.token })).body;
  assert.equal(wo.map_feature_id, v.id); assert.equal(wo.source, 'inspection'); assert.equal(wo.feature_tag, 'V-114');
  assert.match(wo.description, /Pressure \(12 psi\): 12 psi is below the lowest allowed, 20 psi/);
  assert.match(wo.description, /Valve box: Damaged/); assert.match(wo.description, /Leaking: Answered yes/);
  panel = (await api('GET', `/assets/map/features/${v.id}`, { token: crewA.token })).body;
  assert.equal(panel.condition_score, 4); assert.equal(panel.open_orders, 1);
  assert.deepEqual(panel.inspections.map((i) => i.condition_score), [4, 2], 'each inspection keeps its own score');
  // An old pass/fail checklist still works on an asset, with no type on its steps.
  const truck = await api('POST', '/assets/register', { token: A.token, body: { name: `Plow truck ${suffix}`, kind: 'truck' } });
  // (A municipality's own pre-trip is typed since 2026.11.20, so the old kind of checklist is made here as it was stored.)
  await pool.query("INSERT INTO inspection_templates (tenant_id, name, kinds, items) VALUES (?, ?, 'truck', ?)", [A.id, `Old pre-trip ${suffix}`, JSON.stringify([{ key: 'brakes', label: 'Brakes' }, { key: 'lights', label: 'Lights' }])]);
  const pre = await tplNamed(A, `Old pre-trip ${suffix}`);
  const r = await api('POST', `/assets/register/${truck.body.id}/inspections`, { token: crewA.token, body: { template_id: pre.id, items: pre.items.map((i) => ({ key: i.key, result: 'pass' })) } });
  is(r, 201); assert.equal(r.body.result, 'pass');
});

// ---------------------------------------------------------------- condition, criticality, risk
test('condition times criticality is risk, with its words; the register filters and sorts by it; the highest-risk list mixes assets and map items', async () => {
  const mk = async (name, condition, criticality) => { const r = await api('POST', '/assets/register', { token: A.token, body: { name: `${name} ${suffix}`, kind: 'pump', condition_score: condition, criticality, ownership: 'own', material: 'Cast iron', size: '6 in', installed_year: 1962 } }); is(r, 201); return r.body.id; };
  const low = await mk('Low pump', 1, 3); const med = await mk('Medium pump', 2, 4); const hi = await mk('High pump', 4, 4); const vhi = await mk('Very high pump', 5, 5);
  await mk('Unscored pump', null, 4);
  const reg = (q) => api('GET', `/assets/register?${q}`, { token: A.token });
  const all = (await reg('q=pump')).body.data;
  const by = (id) => all.find((a) => a.id === id);
  assert.deepEqual([by(low).risk.label, by(med).risk.label, by(hi).risk.label, by(vhi).risk.label], ['Low', 'Medium', 'High', 'Very high']);
  assert.equal(by(hi).risk.score, 16); assert.equal(by(hi).material, 'Cast iron'); assert.equal(by(hi).installed_year, 1962);
  assert.equal(all.find((a) => a.name.startsWith('Unscored')).risk, null);
  const high = (await reg('q=pump&risk=high')).body.data.map((a) => a.id).sort();
  assert.deepEqual(high, [hi, vhi].sort());
  const sorted = (await reg('q=pump&sort=risk')).body.data.map((a) => a.id);
  assert.deepEqual(sorted.slice(0, 4), [vhi, hi, med, low]);
  is(await reg('risk=scary'), 400);
  // Out-of-range scores are refused.
  is(await api('PATCH', `/assets/register/${low}`, { token: A.token, body: { condition_score: 6 } }), 400);
  is(await api('PATCH', `/assets/register/${low}`, { token: crewA.token, body: { criticality: 2 } }), 200, 'the crew can score');

  const f = await point(A, 'sewer_manhole', P(20), { tag: 'MH-9', condition_score: 5, criticality: 4 });
  const risk = (await api('GET', '/assets/risk', { token: crewA.token })).body.data;
  assert.equal(risk[0].type, 'asset'); assert.equal(risk[0].id, vhi);
  const mh = risk.find((x) => x.type === 'feature' && x.id === f.id);
  assert.equal(mh.risk.score, 20); assert.equal(mh.name, 'Sewer manhole MH-9'); assert.equal(mh.href, `#/assets/map/f${f.id}`);
  assert.ok(risk.length <= 25);
  for (let i = 1; i < risk.length; i += 1) assert.ok(risk[i - 1].risk.score >= risk[i].risk.score);
  assert.equal((await api('GET', '/assets/risk?limit=2', { token: A.token })).body.data.length, 2);
  // Changing a map item's scores is audited with the new values.
  is(await api('PATCH', `/assets/map/features/${f.id}`, { token: crewA.token, body: { condition_score: 3 } }), 200);
  const [[log]] = await pool.query("SELECT detail FROM audit_log WHERE tenant_id = ? AND entity = 'map_features' AND entity_id = ? ORDER BY id DESC LIMIT 1", [A.id, f.id]);
  assert.match(typeof log.detail === 'string' ? log.detail : JSON.stringify(log.detail), /condition_score/);
});

// ---------------------------------------------------------------- work orders on map features
test('a work order opened from a map item shows the item and its shape; the map counts open work orders; a used item is not deleted', async () => {
  const main = await api('POST', '/assets/map/features', { token: A.token, body: { kind: 'potable_line', points: [P(30), P(31), P(31, 1)], tag: 'WM-3', size: '8 in' } });
  is(main, 201);
  const wo = await api('POST', `/assets/map/features/${main.body.id}/work-orders`, { token: crewA.token, body: { title: 'Main break at the corner', priority: 'urgent', out_of_service: true } });
  is(wo, 201);
  const w = (await api('GET', `/ops/work-orders/${wo.body.id}`, { token: crewA.token })).body;
  assert.equal(w.map_feature_id, main.body.id); assert.equal(w.feature_kind, 'potable_line'); assert.equal(w.feature_kind_label, 'Drinking water line');
  assert.equal(w.feature_points.length, 3); assert.equal(typeof w.feature_lat, 'number');
  const list = (await api('GET', `/ops/work-orders?map_feature_id=${main.body.id}`, { token: A.token })).body.data;
  assert.deepEqual(list.map((x) => x.id), [wo.body.id]);
  const map = (await api('GET', '/assets/map', { token: A.token })).body;
  const f = map.features.find((x) => x.id === main.body.id);
  assert.equal(f.open_orders, 1); assert.equal(f.status, 'out_of_service');
  // The general work order form takes a map item too, and refuses one that is not there.
  is(await api('POST', '/ops/work-orders', { token: A.token, body: { title: 'Paint the hydrant', map_feature_id: main.body.id } }), 201);
  is(await api('POST', '/ops/work-orders', { token: A.token, body: { title: 'Nowhere', map_feature_id: 99999999 } }), 404);
  // History stays: a manager cannot delete an item with work on it, and is told to mark it abandoned.
  const del = await api('DELETE', `/assets/map/features/${main.body.id}`, { token: A.token });
  is(del, 409); assert.match(del.body.error, /Abandoned in place/);
  const fresh = await point(A, 'sign', P(32));
  is(await api('DELETE', `/assets/map/features/${fresh.id}`, { token: A.token }), 200);
});

// ---------------------------------------------------------------- run hours
test('pump station rounds keep the hour meters; run hours by month add up the hours between readings, and download', async () => {
  const st = await point(A, 'lift_station', P(40), { name: 'Mill Street pump station', tag: 'PS-1', criticality: 5 });
  const tpl = await tplNamed(A, 'Pump station round');
  const round = (h1, h2) => api('POST', `/assets/map/features/${st.id}/inspections`, { token: crewA.token, body: { template_id: tpl.id, items: [
    { key: 'pump1_hours', value: h1 }, { key: 'pump2_hours', value: h2 }, { key: 'wet_well', value: 'Normal' }, { key: 'alarms', result: 'pass' },
    { key: 'generator_fuel', value: 80 }, { key: 'odor', value: 'no' }, { key: 'check_valves', result: 'pass' }, { key: 'security', result: 'pass' }] } });
  const r1 = await round(1000, 2000); is(r1, 201);
  const r2 = await round(1100, 2050); is(r2, 201);
  const r3 = await round(1180, 2130); is(r3, 201);
  // The first round was last month: its reading starts the count, and this month has the hours since.
  await pool.query("UPDATE station_run_hours SET read_at = DATE_SUB(read_at, INTERVAL 40 DAY) WHERE tenant_id = ? AND inspection_id = ?", [A.id, r1.body.id]);
  const rh = (await api('GET', `/assets/map/features/${st.id}/run-hours`, { token: crewA.token })).body;
  assert.deepEqual(rh.pumps.map((p) => p.key), ['pump1_hours', 'pump2_hours']);
  assert.equal(rh.months.length, 2);
  assert.deepEqual(rh.months[0].hours, { pump1_hours: 180, pump2_hours: 130 }); assert.equal(rh.months[0].total, 310);
  assert.deepEqual(rh.months[1].hours, { pump1_hours: 0, pump2_hours: 0 });
  // A replaced meter (reading lower) counts again from its new reading.
  is(await round(5, 2200), 201);
  const after = (await api('GET', `/assets/map/features/${st.id}/run-hours`, { token: crewA.token })).body;
  assert.deepEqual(after.months[0].hours, { pump1_hours: 180, pump2_hours: 200 });
  const csv = await fetch(`${base}/api/v1/assets/map/features/${st.id}/run-hours?format=csv`, { headers: { authorization: `Bearer ${A.token}` } });
  assert.equal(csv.status, 200); assert.match(csv.headers.get('content-disposition'), /ps-1-run-hours\.csv/);
  const text = await csv.text();
  assert.match(text, /^Month,Pump 1 run hour meter \(hours run\),Pump 2 run hour meter \(hours run\),Total hours run/);
  assert.match(text, /,180,200,380/);
  // The panel carries the table for a station; a generator fuel reading below half fails the round.
  assert.ok((await api('GET', `/assets/map/features/${st.id}`, { token: A.token })).body.run_hours.months.length >= 2);
  const low = await api('POST', `/assets/map/features/${st.id}/inspections`, { token: crewA.token, body: { template_id: tpl.id, items: [
    { key: 'pump1_hours', result: 'na' }, { key: 'pump2_hours', result: 'na' }, { key: 'wet_well', value: 'At the alarm level' }, { key: 'alarms', result: 'pass' },
    { key: 'generator_fuel', value: 30 }, { key: 'odor', value: 'yes' }, { key: 'check_valves', result: 'pass' }, { key: 'security', result: 'pass' }] } });
  is(low, 201); assert.equal(low.body.result, 'fail');
  const w = (await api('GET', `/ops/work-orders/${low.body.work_order_id}`, { token: A.token })).body;
  assert.equal(w.priority, 'urgent', 'criticality 5 makes the work order urgent');
});

// ---------------------------------------------------------------- programs
test('programs end to end: pick targets on the map, do them, skip one, a failure opens a program work order, close, copy', async () => {
  // Six valves in a box, one outside it, one abandoned.
  const inBox = [];
  for (let i = 0; i < 6; i += 1) inBox.push(await point(A, 'valve', [40.1 + i * 0.0005, -75.6], { tag: `Z3-${i}` }));
  const outside = await point(A, 'valve', [40.3, -75.9], { tag: 'FAR-1' });
  await point(A, 'valve', [40.1002, -75.6], { tag: 'OLD-1', status: 'abandoned' });
  const hydrant = await point(A, 'fire_hydrant', [40.1, -75.601], { tag: 'H-9' });
  const tpl = await tplNamed(A, 'Valve exercise');
  const box = { south: 40.09, west: -75.61, north: 40.11, east: -75.59 };

  is(await api('POST', '/assets/programs', { token: crewA.token, body: { name: 'Exercise zone 3 valves', template_id: tpl.id, targets: { pick: { kinds: ['valve'], box } } } }), 403, 'a manager plans it');
  const made = await api('POST', '/assets/programs', { token: A.token, body: { name: `Exercise zone 3 valves ${suffix}`, template_id: tpl.id, due_on: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10), crew: 'Water crew', targets: { pick: { kinds: ['valve'], box }, features: [hydrant.id] } } });
  is(made, 201); assert.equal(made.body.targets, 7, 'six valves in the box and the hydrant; not the far one or the abandoned one');
  const pid = made.body.id;
  let p = (await api('GET', `/assets/programs/${pid}`, { token: crewA.token })).body;
  assert.deepEqual(p.progress, { total: 7, done: 0, skipped: 0, todo: 7, failed: 0, percent: 0, words: '0 of 7 done, 7 to do' });
  assert.ok(!p.targets.some((g) => g.map_feature_id === outside.id));
  assert.ok(p.targets.every((g) => typeof g.lat === 'number' && typeof g.lng === 'number'));
  assert.equal(p.template.name, 'Valve exercise');
  // More can be added; the same one is not added twice.
  const more = await api('POST', `/assets/programs/${pid}/targets`, { token: A.token, body: { features: [outside.id, inBox[0].id] } });
  is(more, 201); assert.equal(more.body.added, 1);

  const answers = (opts = {}) => [
    { key: 'turns_expected', value: 18 }, { key: 'turns_counted', value: 18 }, { key: 'direction', value: 'Right to close' },
    { key: 'operated_fully', value: opts.stuck ? 'no' : 'yes' }, { key: 'box_condition', value: 'Good' }, { key: 'condition', value: opts.stuck ? 4 : 2 },
  ];
  const tgt = (fid) => p.targets.find((g) => g.map_feature_id === fid);
  const done = await api('POST', `/assets/programs/${pid}/targets/${tgt(inBox[0].id).id}/inspect`, { token: crewA.token, body: { items: answers() } });
  is(done, 201); assert.equal(done.body.result, 'pass');
  is(await api('POST', `/assets/programs/${pid}/targets/${tgt(inBox[0].id).id}/inspect`, { token: crewA.token, body: { items: answers() } }), 409, 'already done');
  const stuck = await api('POST', `/assets/programs/${pid}/targets/${tgt(inBox[1].id).id}/inspect`, { token: crewA.token, body: { items: answers({ stuck: true }) } });
  is(stuck, 201); assert.equal(stuck.body.result, 'fail');
  const w = (await api('GET', `/ops/work-orders/${stuck.body.work_order_id}`, { token: A.token })).body;
  assert.equal(w.source, 'program'); assert.equal(w.program_id, pid); assert.equal(w.map_feature_id, inBox[1].id); assert.match(w.program, /Exercise zone 3 valves/);
  // The valve's condition moved with the program's inspection too.
  assert.equal((await api('GET', `/assets/map/features/${inBox[1].id}`, { token: A.token })).body.condition_score, 4);

  is(await api('POST', `/assets/programs/${pid}/targets/${tgt(inBox[2].id).id}/skip`, { token: crewA.token, body: { reason: '' } }), 400, 'skipping needs a reason');
  is(await api('POST', `/assets/programs/${pid}/targets/${tgt(inBox[2].id).id}/skip`, { token: crewA.token, body: { reason: 'Paved over on Elm Street' } }), 200);
  // A manager puts a skipped one back, and the crew skips it again.
  is(await api('POST', `/assets/programs/${pid}/targets/${tgt(inBox[2].id).id}/reopen`, { token: A.token }), 200);
  is(await api('POST', `/assets/programs/${pid}/targets/${tgt(inBox[2].id).id}/skip`, { token: crewA.token, body: { reason: 'Paved over on Elm Street' } }), 200);
  is(await api('DELETE', `/assets/programs/${pid}/targets/${tgt(inBox[0].id).id}`, { token: A.token }), 409, 'a done one stays');

  p = (await api('GET', `/assets/programs/${pid}`, { token: crewA.token })).body;
  assert.deepEqual(p.progress, { total: 8, done: 2, skipped: 1, todo: 5, failed: 1, percent: 38, words: '2 of 8 done, 1 skipped, 1 failed, 5 to do' });
  assert.equal(p.failures.length, 1); assert.equal(p.failures[0].work_order.id, stuck.body.work_order_id);
  assert.equal(tgt(inBox[2].id).skip_reason, 'Paved over on Elm Street');

  // Today shows it with its progress.
  const today = (await api('GET', '/assets/programs/today', { token: crewA.token })).body.cards;
  const c = today.find((x) => x.href === `#/assetprograms/${pid}`);
  assert.ok(c, JSON.stringify(today)); assert.equal(c.count, 5); assert.match(c.text, /2 of 8 done, 1 skipped, 1 failed, 5 to do/);

  // The spreadsheet has every target and no resident data.
  const csv = await fetch(`${base}/api/v1/assets/programs/${pid}/export.csv`, { headers: { authorization: `Bearer ${A.token}` } });
  const text = await csv.text();
  assert.equal(text.split('\n').length, 9); assert.match(text, /Paved over on Elm Street/);

  // Closing: refused while some are to do, unless the rest are skipped with a reason.
  const refuse = await api('POST', `/assets/programs/${pid}/close`, { token: A.token, body: {} });
  is(refuse, 409); assert.match(refuse.body.error, /5 targets are still to do/);
  is(await api('POST', `/assets/programs/${pid}/close`, { token: crewA.token, body: { skip_rest_reason: 'Season over' } }), 403);
  const closed = await api('POST', `/assets/programs/${pid}/close`, { token: A.token, body: { skip_rest_reason: 'Moved to next year' } });
  is(closed, 200); assert.equal(closed.body.skipped_at_close, 5);
  is(await api('POST', `/assets/programs/${pid}/targets/${tgt(inBox[3].id).id}/inspect`, { token: crewA.token, body: { items: answers() } }), 409, 'closed');
  assert.equal((await api('GET', '/assets/programs', { token: A.token })).body.data.some((x) => x.id === pid), false, 'the list shows open ones');
  assert.equal((await api('GET', '/assets/programs?status=closed', { token: A.token })).body.data.some((x) => x.id === pid), true);

  // Copied for next year: same checklist and targets, all to do.
  const copy = await api('POST', `/assets/programs/${pid}/copy`, { token: A.token, body: { name: `Exercise zone 3 valves, next year ${suffix}`, due_on: '2027-10-01' } });
  is(copy, 201); assert.equal(copy.body.targets, 8);
  const c2 = (await api('GET', `/assets/programs/${copy.body.id}`, { token: A.token })).body;
  assert.equal(c2.status, 'open'); assert.equal(c2.copied_from, pid); assert.equal(c2.progress.todo, 8); assert.equal(c2.crew, 'Water crew');
});

test('a program over assets in the register works the same way', async () => {
  const pump = await api('POST', '/assets/register', { token: A.token, body: { name: `Booster pump ${suffix}`, kind: 'pump' } });
  const tpl = await tplNamed(A, 'Facility walk-through');
  const made = await api('POST', '/assets/programs', { token: A.token, body: { name: `Pump checks ${suffix}`, template_id: tpl.id, targets: { assets: [pump.body.id] } } });
  is(made, 201);
  const p = (await api('GET', `/assets/programs/${made.body.id}`, { token: A.token })).body;
  assert.equal(p.targets[0].type, 'asset'); assert.equal(p.targets[0].name, `Booster pump ${suffix}`);
  const r = await api('POST', `/assets/programs/${made.body.id}/targets/${p.targets[0].id}/inspect`, { token: crewA.token, body: { items: tpl.items.map((i) => ({ key: i.key, result: 'pass' })), hours: 12 } });
  is(r, 201);
  const a = (await api('GET', `/assets/register/${pump.body.id}`, { token: A.token })).body;
  assert.equal(a.inspections[0].program_id, made.body.id); assert.equal(a.hours, 12);
  is(await api('POST', `/assets/programs/${made.body.id}/close`, { token: A.token, body: {} }), 200);
});

// ---------------------------------------------------------------- one tenant never reaches another's
test('tenant isolation: another municipality\'s map items, programs, checklists and photos are not found', async () => {
  const theirs = await point(B, 'fire_hydrant', P(50), { tag: 'B-1' });
  const theirTpl = await tplNamed(B, 'Hydrant flush and inspection');
  const theirProg = await api('POST', '/assets/programs', { token: B.token, body: { name: `Their flushing ${suffix}`, template_id: theirTpl.id, targets: { features: [theirs.id] } } });
  is(theirProg, 201);
  const theirTarget = (await api('GET', `/assets/programs/${theirProg.body.id}`, { token: B.token })).body.targets[0];
  const pic = await api('POST', `/assets/map/features/${theirs.id}/photos`, { token: B.token, raw: JPEG });
  is(pic, 201);
  const mine = await tplNamed(A, 'Hydrant flush and inspection');
  const tok = A.token;
  is(await api('GET', `/assets/map/features/${theirs.id}`, { token: tok }), 404);
  is(await api('PATCH', `/assets/map/features/${theirs.id}`, { token: tok, body: { condition_score: 5 } }), 404);
  is(await api('DELETE', `/assets/map/features/${theirs.id}`, { token: tok }), 404);
  is(await api('POST', `/assets/map/features/${theirs.id}/inspections`, { token: tok, body: { template_id: mine.id, items: [{ key: 'x', result: 'pass' }] } }), 404);
  is(await api('POST', `/assets/map/features/${theirs.id}/work-orders`, { token: tok, body: { title: 'Not ours' } }), 404);
  is(await api('POST', `/assets/map/features/${theirs.id}/photos`, { token: tok, raw: JPEG }), 404);
  is(await api('GET', `/assets/map/features/${theirs.id}/run-hours`, { token: tok }), 404);
  is(await api('GET', `/assets/photos/${pic.body.id}`, { token: tok }), 404);
  is(await api('GET', `/assets/photos/${pic.body.id}/verify`, { token: tok }), 404);
  is(await api('POST', '/ops/work-orders', { token: tok, body: { title: 'Not ours', map_feature_id: theirs.id } }), 404);
  is(await api('POST', '/assets/programs', { token: tok, body: { name: 'Steal it', template_id: mine.id, targets: { features: [theirs.id] } } }), 404);
  is(await api('POST', '/assets/programs', { token: tok, body: { name: 'Their checklist', template_id: theirTpl.id } }), 404);
  is(await api('GET', `/assets/programs/${theirProg.body.id}`, { token: tok }), 404);
  is(await api('PATCH', `/assets/programs/${theirProg.body.id}`, { token: tok, body: { name: 'Renamed' } }), 404);
  is(await api('POST', `/assets/programs/${theirProg.body.id}/targets`, { token: tok, body: { features: [theirs.id] } }), 404);
  is(await api('POST', `/assets/programs/${theirProg.body.id}/targets/${theirTarget.id}/skip`, { token: tok, body: { reason: 'Not ours to skip' } }), 404);
  is(await api('POST', `/assets/programs/${theirProg.body.id}/targets/${theirTarget.id}/inspect`, { token: tok, body: { items: [{ key: 'x', result: 'pass' }] } }), 404);
  is(await api('POST', `/assets/programs/${theirProg.body.id}/close`, { token: tok, body: {} }), 404);
  is(await api('POST', `/assets/programs/${theirProg.body.id}/copy`, { token: tok, body: { name: 'Copy theirs' } }), 404);
  is(await api('GET', `/assets/programs/${theirProg.body.id}/export.csv`, { token: tok }), 404);
  // A target of one of our programs cannot be reached through theirs, and their items never show in our lists.
  assert.ok(!(await api('GET', '/assets/risk', { token: tok })).body.data.some((x) => x.type === 'feature' && x.id === theirs.id));
  assert.ok(!(await api('GET', '/assets/map', { token: tok })).body.features.some((f) => f.id === theirs.id));
  // Their photo in our inspection is refused.
  const ours = await point(A, 'fire_hydrant', P(51));
  const items = mine.items.map((i) => (i.type === 'pass' ? { key: i.key, result: 'pass' } : i.type === 'number' ? { key: i.key, value: 60 } : i.type === 'yesno' ? { key: i.key, value: 'yes', ...(i.key === 'out_of_service' ? { value: 'no' } : {}) } : i.type === 'condition' ? { key: i.key, value: 2 } : { key: i.key, result: 'na' }));
  items.find((i) => i.key === 'chlorine').value = 1;
  is(await api('POST', `/assets/map/features/${ours.id}/inspections`, { token: tok, body: { template_id: mine.id, items } }), 201, 'our own hydrant passes');
  items[0].photo_id = pic.body.id;
  const r = await api('POST', `/assets/map/features/${ours.id}/inspections`, { token: tok, body: { template_id: mine.id, items } });
  is(r, 400); assert.match(r.body.error, /not taken of this map item/);
});

test('the work orders Today card and the asset page still work for a ski area with Assets and fleet on', async () => {
  const pump = await api('POST', '/assets/register', { token: skiToken, body: { name: `Snowmaking pump ${suffix}`, kind: 'pump', condition_score: 4, criticality: 5 } });
  is(pump, 201);
  const a = (await api('GET', `/assets/register/${pump.body.id}`, { token: skiToken })).body;
  assert.equal(a.risk.label, 'Very high'); assert.deepEqual(a.photos, []); assert.equal(a.run_hours, null);
  // Programs are part of Assets and fleet, so a ski area can run one too (snow gun checks before the season).
  const tpl = (await templatesOf({ token: skiToken })).find((t) => t.name === 'General pre-use');
  is(await api('POST', '/assets/programs', { token: skiToken, body: { name: `Pre-season ${suffix}`, template_id: tpl.id, targets: { assets: [pump.body.id] } } }), 201);
});

test('the Water, Sewer and Stormwater Today cards: open work orders and high risk on their own map items, only with the add-on on', async () => {
  const water = (await api('GET', '/water/today', { token: crewA.token })).body.cards;
  const wo = water.find((c) => c.title === 'Water work orders');
  assert.ok(wo && wo.count >= 1 && /^#\/works\?department_id=\d+$/.test(wo.href), JSON.stringify(water)); // the Water department's list (2026.11.20)
  const sewer = (await api('GET', '/sewer/today', { token: A.token })).body.cards;
  assert.ok(sewer.some((c) => c.title === 'Sewer: high risk' || c.title === 'Sewer work orders'), JSON.stringify(sewer));
  // Nothing in the stormwater system needs anyone: an empty list.
  const fresh = await createMuniTenant(base, { modules: { stormwater: true } });
  assert.deepEqual((await api('GET', '/stormwater/today', { token: fresh.token })).body, { cards: [] });
  is(await api('GET', '/water/today', { token: fresh.token }), 403, 'the Water add-on is off');
  is(await api('GET', '/water/today', { token: skiToken }), 403, 'never for a ski area');
});
