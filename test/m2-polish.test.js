'use strict';

// Release 2026.11.20, workstream "polish" (the public works director's walkthrough). Everything through the real routes:
// request references in order, targets in one unit, valves' turns to close, the public works truck pre-trip taking a
// truck out of service, the passkey offer put off for 30 days, Jump to finding records by role and app, and the
// municipal words for map kinds.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '100000';
process.env.PLATFORM_RATE_LIMIT = '100000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const Q = require('../src/lib/requests');
const MF = require('../src/lib/mapfeatures');
const { createMuniTenant } = require('./helpers/muni');

const KEY = 'test-bootstrap-key';
const PW = 'correct-horse-battery';
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
let server; let base; let A; let B; let ski; let crew; let desk;

async function api(method, p, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);
const P = (i) => [40.1 + i * 0.001, -75.5];

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await createMuniTenant(base, { modules: { water: true } });
  B = await createMuniTenant(base, { modules: { water: true } });
  crew = await A.addLogin('staff');
  desk = await A.addLogin('counter');
  const made = await api('POST', '/platform/tenants', { headers: { 'x-platform-key': KEY }, body: { slug: `pol-ski-${suffix}`, name: `Polish Ski ${suffix}`, billing: 'comped', modules: { assets: true }, owner: { email: `gm@pol-ski-${suffix}.test`, password: PW, first_name: 'Gale', last_name: 'Ridge' } } });
  is(made, 201, 'ski area');
  ski = { id: Number(made.body.id), token: (await api('POST', '/auth/login', { body: { tenant: `pol-ski-${suffix}`, login: `gm@pol-ski-${suffix}.test`, password: PW } })).body.token };
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

async function street(M, name) { const r = await api('POST', '/requests/streets', { token: M.token, body: { name } }); is(r, 201, 'street'); return r.body.id; }
async function newRequest(M, streetId, token = M.token) {
  const meta = (await api('GET', '/requests/meta', { token: M.token })).body;
  const cat = meta.categories.find((c) => c.name === 'Pothole');
  const r = await api('POST', '/requests', { token, body: { category_id: cat.id, street_id: streetId, source: 'phone' } });
  is(r, 201, 'request');
  return r.body;
}

test('request references run in order per municipality from R-1001; the status link still uses its own token', async () => {
  const st = await street(A, `Market Street ${suffix}`);
  const one = await newRequest(A, st); const two = await newRequest(A, st, desk.token);
  assert.equal(one.reference, 'R-1001'); assert.equal(two.reference, 'R-1002');
  const theirs = await newRequest(B, await street(B, `Elm Avenue ${suffix}`));
  assert.equal(theirs.reference, 'R-1001', 'each municipality counts on its own');
  // A number an older random reference already holds is skipped.
  await pool.query("UPDATE requests SET reference = 'R-1003' WHERE tenant_id = ? AND id = ?", [A.id, two.id]);
  const three = await newRequest(A, st);
  assert.equal(three.reference, 'R-1004');
  const full = (await api('GET', `/requests/${one.id}`, { token: A.token })).body;
  const token = full.status_link.split('#s=')[1];
  assert.match(token, /^[0-9a-f]{32}$/, 'the status link is the unguessable token, not the reference');
  assert.ok(!full.status_link.includes('1001'));
  // Two at once never share a number.
  const both = await Promise.all([newRequest(A, st), newRequest(A, st)]);
  assert.notEqual(both[0].reference, both[1].reference);
});

test('targets read in one unit everywhere: hours under 48, days from 48 on', async () => {
  assert.equal(Q.targetWords(24), '24 hours'); assert.equal(Q.targetWords(47), '47 hours');
  assert.equal(Q.targetWords(48), '2 days'); assert.equal(Q.targetWords(120), '5 days'); assert.equal(Q.targetWords(60), '2.5 days'); assert.equal(Q.targetWords(50), '2 days 2 hours');
  assert.equal(Q.standardWords({ make_safe_hours: 24, fix_hours: 120 }), 'make safe within 24 hours, fix within 5 days');
  const late = Q.measure('Fixed', '2026-11-01 08:00:00', null, 48, '2026-11-03 20:00:00', 'UTC');
  assert.equal(late.words, 'Open 2.5 days, 12 hours past the target of 2 days');
  const st = await street(A, `Bridge Street ${suffix}`);
  const r = await newRequest(A, st);
  const meta = (await api('GET', '/requests/meta', { token: A.token })).body;
  const cat = meta.categories.find((c) => c.name === 'Pothole');
  is(await api('PUT', '/requests/standards', { token: A.token, body: { standards: [{ category_id: cat.id, street_class: 'any', make_safe_hours: 24, fix_hours: 120 }] } }), 200);
  const one = (await api('GET', `/requests/${r.id}`, { token: A.token })).body;
  assert.equal(one.standard.words, 'make safe within 24 hours, fix within 5 days');
  assert.match(one.fix.words, /target 5 days$/);
  const listed = (await api('GET', '/requests?view=open', { token: A.token })).body.data.find((x) => x.id === r.id);
  assert.match(listed.fix.words, /target 5 days$/, 'the list says the same as the request');
});

test('a valve keeps its turns to close; without them the exercise estimates from the size, and other kinds have none', async () => {
  const v = await api('POST', '/assets/map/features', { token: A.token, body: { kind: 'valve', points: [P(1)], tag: `V-${suffix}`, size: '8 in', turns_expected: 25 } });
  is(v, 201);
  assert.equal(v.body.turns_expected, 25); assert.deepEqual(v.body.turns, { value: 25, estimated: false, words: '25 turns (from the valve\'s record)' });
  const est = await api('POST', '/assets/map/features', { token: A.token, body: { kind: 'valve', points: [P(2)], size: '6"' } });
  assert.equal(est.body.turns.value, 20); assert.equal(est.body.turns.estimated, true); assert.match(est.body.turns.words, /estimate/);
  const none = await api('POST', '/assets/map/features', { token: A.token, body: { kind: 'valve', points: [P(3)] } });
  assert.equal(none.body.turns, null, 'no size, no turns: the form leaves the comparison out');
  const hyd = await api('POST', '/assets/map/features', { token: A.token, body: { kind: 'fire_hydrant', points: [P(4)], size: '6 in', turns_expected: 12 } });
  assert.equal(hyd.body.turns, null); assert.equal(hyd.body.turns_expected, null, 'only a valve keeps turns');
  is(await api('PATCH', `/assets/map/features/${none.body.id}`, { token: A.token, body: { turns_expected: 19 } }), 200);
  assert.equal((await api('GET', `/assets/map/features/${none.body.id}`, { token: A.token })).body.turns.value, 19);
  // A program's targets carry the turns, and an inspection that answers N/A for an unknown record saves.
  const tpl = (await api('GET', '/assets/templates', { token: A.token })).body.data.find((t) => t.name === 'Valve exercise');
  const item = tpl.items.find((i) => i.key === 'turns_expected');
  assert.equal(item.label, 'Turns expected');
  const prog = await api('POST', '/assets/programs', { token: A.token, body: { name: `Exercise ${suffix}`, template_id: tpl.id, targets: { features: [v.body.id, est.body.id] } } });
  is(prog, 201);
  const p = (await api('GET', `/assets/programs/${prog.body.id}`, { token: crew.token })).body;
  assert.deepEqual(p.targets.map((g) => g.turns && g.turns.value), [25, 20]);
  assert.equal(MF.inchesOf('200 mm'), null, 'a size in mm is not guessed at');
});

test('the public works truck pre-trip: a failed brake takes the truck out of service; the odometer reading is its miles', async () => {
  const truck = await api('POST', '/assets/register', { token: A.token, body: { name: `Plow 1 ${suffix}`, kind: 'truck' } });
  is(truck, 201);
  const tpls = (await api('GET', '/assets/templates', { token: A.token })).body.data;
  const pre = tpls.find((t) => t.name === 'Public works truck pre-trip');
  assert.ok(pre, 'every municipality gets it, whatever its add-ons');
  assert.ok(!tpls.some((t) => t.name === 'Vehicle pre-trip'), 'a new municipality does not also get the ski area\'s');
  assert.deepEqual(pre.kinds, ['truck', 'bus']);
  for (const k of ['air_buildup', 'air_leak', 'hydraulics', 'plow_mount', 'packer', 'extinguisher', 'odometer']) assert.ok(pre.items.some((i) => i.key === k), k);
  assert.deepEqual(pre.items.filter((i) => i.stops_use).map((i) => i.key).sort(), ['air_buildup', 'air_leak', 'brakes', 'lights', 'steering', 'tires']);
  const answers = (fail) => pre.items.map((i) => (i.key === 'odometer' ? { key: i.key, value: 48210 } : i.key === fail ? { key: i.key, result: 'fail', note: 'Parking brake does not hold' } : i.key === 'packer' ? { key: i.key, result: 'na' } : { key: i.key, result: 'pass' }));
  const bad = await api('POST', `/assets/register/${truck.body.id}/inspections`, { token: crew.token, body: { template_id: pre.id, items: answers('brakes') } });
  is(bad, 201);
  assert.equal(bad.body.result, 'fail'); assert.equal(bad.body.out_of_service, true); assert.ok(bad.body.work_order_id);
  const a = (await api('GET', `/assets/register/${truck.body.id}`, { token: A.token })).body;
  assert.equal(a.status, 'out_of_service');
  assert.equal(Number(a.miles), 48210, 'the odometer reading is the truck\'s miles');
  // Any other failure only needs service.
  const pickup = await api('POST', '/assets/register', { token: A.token, body: { name: `Pickup 4 ${suffix}`, kind: 'truck' } });
  const meh = await api('POST', `/assets/register/${pickup.body.id}/inspections`, { token: crew.token, body: { template_id: pre.id, items: answers('wipers') } });
  is(meh, 201); assert.equal(meh.body.out_of_service, undefined);
  assert.equal((await api('GET', `/assets/register/${pickup.body.id}`, { token: A.token })).body.status, 'needs_service');
  // A ski area keeps its own pre-trip and gets none of the municipal pack.
  const skiTpls = (await api('GET', '/assets/templates', { token: ski.token })).body.data;
  assert.ok(skiTpls.some((t) => t.name === 'Vehicle pre-trip')); assert.ok(!skiTpls.some((t) => t.name === 'Public works truck pre-trip'));
});

test('the passkey offer: a leader who says Not now is asked again after 30 days, not every session', async () => {
  const me = async (t) => (await api('GET', '/auth/me', { token: t })).body.passkey_prompt;
  const mgr = await A.addLogin('manager');
  assert.equal((await me(mgr.token)).kind, 'leader');
  is(await api('POST', '/auth/passkey-prompt/seen', { token: mgr.token }), 204);
  assert.equal(await me(await A.login(mgr.username)), null, 'a new session is not asked again');
  await pool.query("UPDATE audit_log SET at = UTC_TIMESTAMP() - INTERVAL 31 DAY WHERE tenant_id = ? AND user_id = ? AND action = 'passkey_offer_seen'", [A.id, mgr.id]);
  assert.equal((await me(await A.login(mgr.username))).kind, 'leader', 'asked again after 30 days');
});

test('Jump to finds records by tag, kind, number and reference, only for the roles and apps that open them', async () => {
  const tag = `V-9${suffix.slice(-3)}`;
  await api('POST', '/assets/map/features', { token: A.token, body: { kind: 'valve', points: [P(9)], tag } });
  await api('POST', '/assets/map/features', { token: A.token, body: { kind: 'fire_hydrant', points: [P(10)], tag: `H-${suffix}` } });
  const wo = await api('POST', '/ops/work-orders', { token: A.token, body: { title: `Clear storm inlet ${suffix}`, priority: 'normal' } });
  is(wo, 201);
  const q = async (token, text) => { const r = await api('GET', `/jump?q=${encodeURIComponent(text)}`, { token }); is(r, 200); return r.body.data; };
  assert.ok((await q(crew.token, tag)).some((x) => x.type === 'feature' && x.href.startsWith('#/assets/map/f')), 'a valve by its tag');
  assert.ok((await q(crew.token, 'hydrant')).some((x) => x.type === 'feature' && x.title.includes(`H-${suffix}`)), '"hydrant" finds the fire hydrants');
  assert.ok((await q(crew.token, `#${wo.body.id}`)).some((x) => x.type === 'work_order' && x.href === `#/works/${wo.body.id}`), 'a work order by number');
  assert.ok((await q(A.token, `inlet ${suffix}`)).some((x) => x.type === 'work_order'), 'a work order by words');
  const req = await newRequest(A, await street(A, `Canal Street ${suffix}`));
  const found = (await q(desk.token, req.reference)).find((x) => x.type === 'request');
  assert.ok(found, 'Front desk finds a request by reference');
  assert.ok((await q(desk.token, req.reference.slice(0, 4))).some((x) => x.type === 'request'), 'or by the start of one ("R-10")');
  assert.ok(!JSON.stringify(found).match(/\d+ Canal/), 'never the house number');
  assert.deepEqual((await q(desk.token, tag)).filter((x) => x.type === 'feature'), [], 'Front desk does not open Assets');
  is(await api('POST', '/workforce/staff', { token: A.token, body: { person: { first_name: 'Rachel', last_name: `Moore${suffix}` }, employee: true, status: 'active' } }), 201);
  assert.ok((await q(A.token, `Moore${suffix}`)).some((x) => x.type === 'person' && x.href.startsWith('#/workforce/staff/')), 'managers find people');
  assert.deepEqual((await q(crew.token, `Moore${suffix}`)).filter((x) => x.type === 'person'), [], 'the crew does not open Staff and schedule');
  assert.deepEqual(await q(B.token, tag), [], 'another municipality finds nothing of this one');
  assert.deepEqual((await api('GET', '/jump?q=a', { token: A.token })).body.data, [], 'one letter: nothing yet');
  is(await api('GET', '/jump?q=hydrant'), 401);
  // A % in the box is a plain character, not "everything".
  assert.deepEqual((await q(crew.token, '%%')).filter((x) => x.type === 'feature'), []);
});

test('map kinds in a municipality\'s words: Road, not Road or cat track; fiber in US English for everyone', async () => {
  const mk = (await api('GET', '/assets/map/view', { token: A.token })).body.kinds;
  assert.equal(mk.find((k) => k.key === 'road').label, 'Road');
  assert.equal(mk.find((k) => k.key === 'comms_line').label, 'Phone, fiber or data line');
  const sk = (await api('GET', '/assets/map/view', { token: ski.token })).body.kinds;
  assert.equal(sk.find((k) => k.key === 'road').label, 'Road or cat track', 'a ski area keeps its word');
  const road = await api('POST', '/assets/map/features', { token: A.token, body: { kind: 'road', points: [P(20), P(21)] } });
  is(road, 201); assert.equal(road.body.kind_label, 'Road');
});
