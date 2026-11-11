'use strict';

// Buildings (muni release 1): a municipality's own buildings and their life-safety calendar. The library of recurring
// checks is seeded when Buildings is turned on (once); each check on each piece of equipment is a service plan whose due
// date is its last date plus its interval; staff rounds pass, fail (with a work order) or flag missing items; a vendor
// visit covers many items at once with a certificate filed in Documents; certificates are reminded 60, 30 and 7 days
// ahead; the binder holds everything in a date range. Only a municipality with Buildings on reaches any of it.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.PUBLIC_RATE_LIMIT = '100000';
process.env.MODULE_CACHE_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { createMuniTenant } = require('./helpers/muni');
const { addDays, todayIn } = require('../src/lib/util');
const B = require('../src/lib/buildings');
const { textPdf } = require('../db/demo-municipal/60-buildings');

const KEY = 'test-bootstrap-key';
const PW = 'correct-horse-battery';
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
let server; let base;
let muni; let other; let plain; let skiToken; let crew; let desk;
let today;

async function api(method, p, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, {
    method,
    headers: { ...(raw ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw || (body === undefined ? undefined : JSON.stringify(body)),
  });
  const type = res.headers.get('content-type') || '';
  if (!type.includes('json')) return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  return { status: res.status, body: await res.json(), headers: res.headers };
}
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${r.body && !Buffer.isBuffer(r.body) ? JSON.stringify(r.body) : ''}`);
const platform = (method, p, body) => api(method, `/platform${p}`, { headers: { 'x-platform-key': KEY }, body });
const q = async (sql, params) => (await pool.query(sql, params))[0];

// One building set up for most tests.
const S = {};

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  muni = await createMuniTenant(base, { slug: `bld-a-${suffix}`, name: `Elmhurst Borough ${suffix}`, modules: { buildings: true } });
  other = await createMuniTenant(base, { slug: `bld-b-${suffix}`, name: `Oakdale Township ${suffix}`, modules: { buildings: true } });
  plain = await createMuniTenant(base, { slug: `bld-c-${suffix}`, name: `Ashford Borough ${suffix}` });
  const made = await platform('POST', '/tenants', { slug: `bld-ski-${suffix}`, name: `Pine Knob ${suffix}`, billing: 'comped', owner: { email: `gm@bld-ski-${suffix}.test`, password: PW, first_name: 'Gale', last_name: 'Ridge' } });
  is(made, 201);
  skiToken = (await api('POST', '/auth/login', { body: { tenant: `bld-ski-${suffix}`, login: `gm@bld-ski-${suffix}.test`, password: PW } })).body.token;
  crew = await muni.addLogin('staff');
  desk = await muni.addLogin('counter');
  today = todayIn('America/New_York');
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

// ---------------------------------------------------------------- gating
test('only a municipality with Buildings on reaches it', async () => {
  const ski = await api('GET', '/buildings', { token: skiToken });
  is(ski, 403, 'a ski area never has Buildings');
  const off = await api('GET', '/buildings/calendar', { token: plain.token });
  is(off, 403, 'a municipality without the add-on');
  assert.match(off.body.error, /Buildings/);
  is(await api('GET', '/buildings/today', { token: plain.token }), 403);
  is(await api('GET', '/buildings', { token: muni.token }), 200);
  is(await api('GET', '/buildings/today', { token: desk.token }), 200, 'the front desk reads Today');
});

// ---------------------------------------------------------------- library
test('the life-safety library is seeded when Buildings is turned on, once', async () => {
  // Turning it on through the console seeds the library at once.
  is(await platform('PUT', `/tenants/${plain.id}/modules`, { modules: { buildings: true } }), 200);
  const [s] = await q('SELECT library_seeded_at FROM building_settings WHERE tenant_id = ?', [plain.id]);
  assert.ok(s && s.library_seeded_at, 'seeded when turned on');
  const n = async (t) => Number((await q('SELECT COUNT(*) AS n FROM life_safety_tasks WHERE tenant_id = ?', [t]))[0].n);
  assert.equal(await n(plain.id), B.LIBRARY.length);

  const lib = await api('GET', '/buildings/library', { token: muni.token });
  is(lib, 200);
  assert.equal(lib.body.data.length, B.LIBRARY.length);
  const ext = lib.body.data.find((x) => x.code === 'ext_monthly');
  assert.equal(ext.who, 'staff'); assert.equal(ext.interval_days, 31); assert.equal(ext.standard, 'NFPA 10'); assert.equal(ext.every, 'Monthly');
  assert.ok(ext.items.some((i) => i.key === 'pressure'));
  const elev = lib.body.data.find((x) => x.code === 'elevator_semiannual');
  assert.equal(elev.certificate, 'Certificate of operation'); assert.equal(elev.standard, '34 Pa. Code 405.7');
  assert.equal(lib.body.data.find((x) => x.code === 'backflow_annual').items.find((i) => i.key === 'check1').type, 'number');
  // The asset register's own starting checklists are still there.
  assert.ok((await q("SELECT id FROM inspection_templates WHERE tenant_id = ? AND name = 'Vehicle pre-trip'", [muni.id])).length);

  // A manager removes one and renames another; asking again does not put either back.
  const roof = lib.body.data.find((x) => x.code === 'roof_annual');
  is(await api('PATCH', `/buildings/library/${roof.id}`, { token: muni.token, body: { active: false } }), 200);
  is(await api('PATCH', `/buildings/library/${ext.id}`, { token: muni.token, body: { name: 'Extinguisher monthly walk' } }), 200);
  B._seeded.clear(); // as a new server would
  await B.ensureLibrary(muni.id);
  const again = await api('GET', '/buildings/library', { token: muni.token });
  assert.equal(again.body.data.length, B.LIBRARY.length, 'nothing added twice');
  assert.equal(again.body.data.find((x) => x.id === roof.id).active, false);
  assert.ok(again.body.data.some((x) => x.name === 'Extinguisher monthly walk'));
  assert.ok(!again.body.data.some((x) => x.name === 'Fire extinguisher monthly check'));
  is(await api('PATCH', `/buildings/library/${ext.id}`, { token: muni.token, body: { name: 'Fire extinguisher monthly check' } }), 200);
  is(await api('PATCH', `/buildings/library/${ext.id}`, { token: crew.token, body: { interval_days: 30 } }), 403, 'the crew does not change the library');
});

// ---------------------------------------------------------------- buildings and equipment
test('a building with rooms and equipment gets a service plan for each check, on Work orders too', async () => {
  const mk = await api('POST', '/buildings', { token: muni.token, body: { name: 'Town Hall', type: 'office', address: '1 Center Square', year_built: 1958, square_feet: 15000, rooms: ['Lobby', 'Boiler room'] } });
  is(mk, 201);
  S.building = mk.body.id;
  is(await api('POST', '/buildings', { token: crew.token, body: { name: 'Shed' } }), 403, 'the crew does not add buildings');
  is(await api('POST', '/buildings', { token: muni.token, body: { name: 'Town Hall' } }), 409);
  const b = await api('GET', `/buildings/${S.building}`, { token: muni.token });
  assert.deepEqual(b.body.rooms.map((r) => r.name).sort(), ['Boiler room', 'Lobby']);
  S.lobby = b.body.rooms.find((r) => r.name === 'Lobby').id;
  S.boilerRoom = b.body.rooms.find((r) => r.name === 'Boiler room').id;

  const ext = await api('POST', `/buildings/${S.building}/equipment`, { token: crew.token, body: { name: 'Town Hall extinguisher', kind: 'fire_extinguisher', room_id: S.lobby, count: 3 } });
  is(ext, 201);
  assert.equal(ext.body.ids.length, 3);
  assert.equal(ext.body.plans_made, 6, 'monthly check and annual maintenance for each');
  S.ext = ext.body.ids;
  const elev = await api('POST', `/buildings/${S.building}/equipment`, { token: muni.token, body: { name: 'Town Hall elevator', kind: 'elevator', room_id: S.lobby, critical: true } });
  is(elev, 201);
  S.elevator = elev.body.ids[0];
  const tags = await q('SELECT asset_tag, location_id, category FROM ops_assets WHERE tenant_id = ? AND id IN (?)', [muni.id, [...S.ext, S.elevator]]);
  assert.ok(tags.every((x) => /^A-\d{4}$/.test(x.asset_tag)), 'each has a QR tag on the register');
  assert.ok(tags.every((x) => x.location_id === S.lobby && x.category === 'facility'));

  const page = await api('GET', `/buildings/${S.building}`, { token: muni.token });
  assert.equal(page.body.equipment.length, 4);
  assert.equal(page.body.plans.length, 7);
  assert.ok(page.body.plans.every((p) => p.state === 'never'), 'no record yet');
  assert.equal(page.body.equipment.find((e) => e.id === S.elevator).room, 'Lobby');
  S.plan = (asset, code) => page.body.plans.find((p) => p.asset_id === asset && p.task === B.LIBRARY.find((l) => l[0] === code)[1]).plan_id;
  // The same plans on Work orders' service plans (the assets app's /ops/pm).
  const pm = await api('GET', '/ops/pm', { token: muni.token });
  is(pm, 200);
  assert.ok(page.body.plans.every((p) => pm.body.data.some((x) => x.id === p.plan_id && x.interval_days === p.interval_days)));

  // Moving equipment out of every building pauses its plans; moving it back resumes them.
  is(await api('PATCH', `/buildings/${S.building}/equipment/${S.ext[2]}`, { token: muni.token, body: { room_id: S.boilerRoom } }), 200);
  assert.equal((await api('GET', `/buildings/${S.building}`, { token: muni.token })).body.equipment.find((e) => e.id === S.ext[2]).room, 'Boiler room');
});

test('service plan due math: the last time done plus the interval, the same on Work orders', async () => {
  const v = await api('GET', '/buildings/meta', { token: muni.token });
  const vendor = (await api('POST', '/assets/vendors', { token: muni.token, body: { name: `Allied Fire ${suffix}` } })).body.id;
  S.vendor = vendor;
  assert.ok(v.body.equipment_kinds.some((k) => k.value === 'fire_extinguisher'));
  // Three monthly checks recorded on three dates through a visit (the visit's date is the day each was done).
  for (const [i, ago] of [[0, 40], [1, 25], [2, 10]]) {
    const r = await api('POST', '/buildings/visits', { token: muni.token, body: { vendor_id: vendor, visit_on: addDays(today, -ago), items: [{ plan_id: S.plan(S.ext[i], 'ext_monthly'), result: 'pass' }] } });
    is(r, 201);
  }
  const cal = await api('GET', `/buildings/calendar?building_id=${S.building}`, { token: muni.token });
  is(cal, 200);
  const st = (i) => cal.body.plans.find((p) => p.plan_id === S.plan(S.ext[i], 'ext_monthly'));
  assert.equal(st(0).due_on, addDays(today, -40 + 31)); assert.equal(st(0).state, 'overdue');
  assert.equal(st(1).due_on, addDays(today, 6)); assert.equal(st(1).state, 'week');
  assert.equal(st(2).due_on, addDays(today, 21)); assert.equal(st(2).state, 'month');
  assert.equal(cal.body.counts.overdue, 1);
  assert.equal(cal.body.counts.never, 4, 'three annual services and the elevator have no record');
  const pm = (await api('GET', '/ops/pm', { token: muni.token })).body.data;
  assert.equal(pm.find((x) => x.id === S.plan(S.ext[0], 'ext_monthly')).due_on, st(0).due_on, 'Work orders shows the same due date');
  // A visit dated earlier than the last record does not move the plan backward.
  is(await api('POST', '/buildings/visits', { token: muni.token, body: { vendor_id: vendor, visit_on: addDays(today, -60), items: [{ plan_id: S.plan(S.ext[2], 'ext_monthly'), result: 'pass' }] } }), 201);
  assert.equal((await api('GET', `/buildings/calendar?building_id=${S.building}`, { token: muni.token })).body.plans.find((p) => p.plan_id === S.plan(S.ext[2], 'ext_monthly')).due_on, addDays(today, 21));
  is(await api('POST', '/buildings/visits', { token: muni.token, body: { vendor_id: vendor, visit_on: addDays(today, 2), items: [{ plan_id: S.plan(S.ext[2], 'ext_monthly'), result: 'pass' }] } }), 400, 'not in the future');

  const cards = await api('GET', '/buildings/today', { token: muni.token });
  is(cards, 200);
  const byTitle = Object.fromEntries(cards.body.cards.map((c) => [c.title, c]));
  assert.equal(byTitle['Building checks overdue'].count, 1);
  assert.match(byTitle['Building checks overdue'].text, /4 more with no record yet/);
  assert.equal(byTitle['Building checks due this week'].count, 1);
  assert.equal(byTitle['Certificates expiring in 30 days'].count, 0);
  assert.ok(cards.body.cards.every((c) => c.href && c.href.startsWith('#/buildings')));
});

test('the year grid: done, late and missed months', () => {
  // Monthly (31 days), done Jan 5, Feb 3, then Apr 20 (late: due Mar 6, so March is missed), today is Jun 10.
  const cells = B.yearCells(['2026-01-05', '2026-02-03', '2026-04-20'], 31, 2026, '2026-06-10');
  assert.equal(cells[0], 'done'); assert.equal(cells[1], 'done'); assert.equal(cells[2], 'missed'); assert.equal(cells[3], 'late');
  assert.equal(cells[4], 'missed', 'due May 21, nothing done'); assert.equal(cells[5], 'due', 'due Jun 21 is still ahead');
  assert.equal(cells[11], 'due');
  // Yearly: one cell a year.
  const y = B.yearCells(['2025-03-01'], 365, 2026, '2026-06-10');
  assert.deepEqual(y.map((c, i) => [i, c]).filter(([, c]) => c !== 'none'), [[2, 'missed']]);
  assert.ok(B.yearCells([], 31, 2026, '2026-06-10').every((c) => c === 'none'));
});

// ---------------------------------------------------------------- staff rounds
test('a staff round: one-tap pass, fail with a work order and a photo, missing flagged, then finished', async () => {
  const start = await api('POST', `/buildings/${S.building}/rounds`, { token: crew.token, body: {} });
  is(start, 201);
  // Due this week, overdue or never: extinguishers 1 and 2 (3 is not due for 21 days). Annual vendor work is not on a staff round.
  assert.equal(start.body.stops, 2);
  const again = await api('POST', `/buildings/${S.building}/rounds`, { token: crew.token, body: {} });
  is(again, 200); assert.equal(again.body.id, start.body.id, 'an open round is picked up again');
  is(await api('POST', `/buildings/${S.building}/rounds`, { token: desk.token, body: {} }), 403, 'the front desk reads, it does not record');
  const round = start.body.id;
  is(await api('POST', `/buildings/rounds/${round}/finish`, { token: crew.token, body: {} }), 200);
  // Pick the checks: every extinguisher's monthly check.
  const extTask = (await api('GET', '/buildings/library', { token: muni.token })).body.data.find((x) => x.code === 'ext_monthly').id;
  const r2 = await api('POST', `/buildings/${S.building}/rounds`, { token: crew.token, body: { task_ids: [extTask] } });
  is(r2, 201); assert.equal(r2.body.stops, 3);
  const view = await api('GET', `/buildings/rounds/${r2.body.id}`, { token: crew.token });
  is(view, 200);
  assert.ok(view.body.stops.every((s) => s.steps.length && s.asset_tag), 'each stop carries its checklist and tag for scanning');
  const stop = (asset) => view.body.stops.find((s) => s.asset_id === asset).id;

  const pass = await api('POST', `/buildings/rounds/${r2.body.id}/stops/${stop(S.ext[0])}`, { token: crew.token, body: { result: 'pass', scanned: true } });
  is(pass, 200); assert.equal(pass.body.result, 'pass'); assert.equal(pass.body.work_order_id, null);
  const [p0] = await q('SELECT last_done_on FROM pm_tasks WHERE tenant_id = ? AND id = ?', [muni.id, S.plan(S.ext[0], 'ext_monthly')]);
  assert.equal(String(p0.last_done_on).slice(0, 10), today);
  is(await api('POST', `/buildings/rounds/${r2.body.id}/stops/${stop(S.ext[0])}`, { token: crew.token, body: { result: 'pass' } }), 409, 'checked once per round');

  is(await api('POST', `/buildings/rounds/${r2.body.id}/stops/${stop(S.ext[1])}`, { token: crew.token, body: { result: 'fail' } }), 400, 'a failure needs what is wrong');
  const fail = await api('POST', `/buildings/rounds/${r2.body.id}/stops/${stop(S.ext[1])}`, { token: crew.token, body: { result: 'fail', failed_keys: ['pressure'], note: 'Needle in the red' } });
  is(fail, 200); assert.equal(fail.body.result, 'fail'); assert.ok(fail.body.work_order_id);
  S.failWo = fail.body.work_order_id;
  const [wo] = await q('SELECT title, source, priority, asset_id, location, description FROM work_orders WHERE tenant_id = ? AND id = ?', [muni.id, S.failWo]);
  assert.equal(wo.source, 'inspection'); assert.equal(wo.asset_id, S.ext[1]); assert.match(wo.location, /Town Hall, Lobby/); assert.match(wo.description, /Needle in the red/);
  const [ins] = await q('SELECT result, items FROM asset_inspections WHERE tenant_id = ? AND id = ?', [muni.id, (await q('SELECT inspection_id FROM building_round_stops WHERE id = ?', [stop(S.ext[1])]))[0].inspection_id]);
  assert.equal(ins.result, 'fail');
  assert.equal(JSON.parse(ins.items).find((i) => i.key === 'pressure').result, 'fail');
  assert.equal((await q('SELECT status FROM ops_assets WHERE id = ?', [S.ext[1]]))[0].status, 'needs_service');
  // The photo, kept as taken with its fingerprint.
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0'), Buffer.alloc(80, 7)]);
  const photo = await api('POST', `/buildings/rounds/${r2.body.id}/stops/${stop(S.ext[1])}/photo`, { token: crew.token, raw: jpeg });
  is(photo, 201);
  assert.equal(photo.body.sha256, require('crypto').createHash('sha256').update(jpeg).digest('hex'));
  const back = await api('GET', `/buildings/photos/${photo.body.id}`, { token: crew.token });
  is(back, 200); assert.ok(Buffer.compare(back.body, jpeg) === 0, 'the same bytes back');
  is(await api('POST', `/buildings/rounds/${r2.body.id}/stops/${stop(S.ext[2])}/photo`, { token: crew.token, raw: jpeg }), 400, 'check the item first');

  const before = (await q('SELECT last_done_on FROM pm_tasks WHERE id = ?', [S.plan(S.ext[2], 'ext_monthly')]))[0].last_done_on;
  const miss = await api('POST', `/buildings/rounds/${r2.body.id}/stops/${stop(S.ext[2])}`, { token: crew.token, body: { result: 'missing' } });
  is(miss, 200); assert.equal(miss.body.result, 'missing'); assert.ok(miss.body.work_order_id);
  assert.match((await q('SELECT title FROM work_orders WHERE id = ?', [miss.body.work_order_id]))[0].title, /^Missing: /);
  assert.equal(String((await q('SELECT last_done_on FROM pm_tasks WHERE id = ?', [S.plan(S.ext[2], 'ext_monthly')]))[0].last_done_on), String(before), 'a missing item is not counted as checked');

  const fin = await api('POST', `/buildings/rounds/${r2.body.id}/finish`, { token: crew.token, body: {} });
  is(fin, 200);
  assert.deepEqual(fin.body, { passed: 1, failed: 1, missing: 1, skipped: 0 });
  is(await api('POST', `/buildings/rounds/${r2.body.id}/stops/${stop(S.ext[2])}`, { token: crew.token, body: { result: 'pass' } }), 409, 'a finished round takes no more checks');
  const defs = await api('GET', `/buildings/deficiencies?building_id=${S.building}`, { token: muni.token });
  assert.equal(defs.body.data.length, 2);
  assert.ok(defs.body.data.every((d) => d.open && d.source === 'round'));
});

// ---------------------------------------------------------------- vendor visits and certificates
test('a vendor visit covers many items at once, renews a certificate and files the report under the building', async () => {
  const items = [
    { plan_id: S.plan(S.ext[0], 'ext_annual'), result: 'pass', answers: [{ key: 'maintenance', result: 'pass' }, { key: 'hydro_due', value: addDays(today, 800) }] },
    { plan_id: S.plan(S.ext[1], 'ext_annual'), result: 'fail', note: 'Shell dented; replace' },
    { plan_id: S.plan(S.ext[2], 'ext_annual'), result: 'na', note: 'Not found on site' },
    { plan_id: S.plan(S.elevator, 'elevator_semiannual'), result: 'pass', certificate: { expires_on: addDays(today, 20), number: 'EL-4471' } },
  ];
  is(await api('POST', '/buildings/visits', { token: desk.token, body: { vendor_id: S.vendor, visit_on: today, items } }), 403);
  is(await api('POST', '/buildings/visits', { token: crew.token, body: { vendor_id: S.vendor, visit_on: today, items: [{ plan_id: S.plan(S.ext[0], 'ext_monthly'), result: 'pass', certificate: { expires_on: addDays(today, 30) } }] } }), 400, 'a monthly check renews no certificate');
  const v = await api('POST', '/buildings/visits', { token: crew.token, body: { vendor_id: S.vendor, visit_on: today, technician: 'R. Diaz', items, deficiencies: [{ building_id: S.building, description: 'Exit sign by the stairs is unlit', priority: 'normal' }] } });
  is(v, 201);
  S.visit = v.body.id;
  assert.equal(v.body.items.length, 4);
  assert.equal(v.body.work_orders.length, 2, 'the failed item and the finding');
  assert.equal(v.body.certificates.length, 1);
  assert.equal(v.body.items.find((i) => i.plan_id === S.plan(S.ext[2], 'ext_annual')).result, 'na');
  const cal = (await api('GET', `/buildings/calendar?building_id=${S.building}`, { token: muni.token })).body.plans;
  assert.equal(cal.find((p) => p.plan_id === S.plan(S.ext[0], 'ext_annual')).due_on, addDays(today, 365));
  assert.equal(cal.find((p) => p.plan_id === S.plan(S.ext[1], 'ext_annual')).last_done_on, today, 'a failed inspection still happened');
  assert.equal(cal.find((p) => p.plan_id === S.plan(S.ext[2], 'ext_annual')).state, 'never', 'not applicable leaves it due');
  assert.equal(cal.find((p) => p.plan_id === S.plan(S.elevator, 'elevator_semiannual')).due_on, addDays(today, 183));
  const [inspector] = await q('SELECT inspector FROM asset_inspections WHERE tenant_id = ? AND asset_id = ? ORDER BY id DESC LIMIT 1', [muni.id, S.elevator]);
  assert.equal(inspector.inspector, `Allied Fire ${suffix}, R. Diaz`);
  assert.equal(String((await q('SELECT inspection_expires FROM ops_assets WHERE id = ?', [S.elevator]))[0].inspection_expires).slice(0, 10), addDays(today, 20), 'the asset register shows the certificate date');

  // The report: a PDF, filed in Documents and listed under the building; the certificate points at it.
  const pdf = textPdf(['Allied Fire', 'Annual service', 'Sample']);
  is(await api('PUT', `/buildings/visits/${S.visit}/file`, { token: crew.token, raw: Buffer.from('MZ not a pdf'), headers: { 'x-filename': 'report.pdf' } }), 400);
  const f = await api('PUT', `/buildings/visits/${S.visit}/file`, { token: crew.token, raw: pdf, headers: { 'x-filename': 'allied-report.pdf' } });
  is(f, 201);
  const docId = f.body.document_id;
  const bpage = await api('GET', `/buildings/${S.building}`, { token: desk.token });
  assert.ok(bpage.body.documents.some((d) => d.id === docId && d.visit_id === S.visit), 'in the building\'s documents');
  assert.equal(bpage.body.certificates[0].document_id, docId);
  assert.equal(bpage.body.certificates[0].number, 'EL-4471');
  const file = await api('GET', `/buildings/documents/${docId}/file`, { token: desk.token });
  is(file, 200); assert.equal(Buffer.compare(file.body, pdf), 0);
  const docs = await api('GET', '/documents/documents', { token: muni.token });
  const d = docs.body.data.find((x) => x.id === docId);
  assert.equal(d.category, B.CATEGORY); assert.equal(d.file_name, 'allied-report.pdf');
  const visit = await api('GET', `/buildings/visits/${S.visit}`, { token: muni.token });
  assert.equal(visit.body.lines.length, 4); assert.equal(visit.body.deficiencies.length, 2); assert.equal(visit.body.document_id, docId);
  assert.deepEqual(visit.body.buildings.map((x) => x.id), [S.building]);

  const today2 = await api('GET', '/buildings/today', { token: muni.token });
  assert.equal(today2.body.cards.find((c) => c.title === 'Certificates expiring in 30 days').count, 1);
});

test('certificate reminders: 60, 30 and 7 days ahead, to the managers\' Inbox, each once', async () => {
  const manager = await muni.addLogin('manager');
  const r1 = await B.remindAll({ tenantId: muni.id });
  assert.equal(r1.sent, 1, 'the elevator certificate (20 days left) gets its 30-day reminder');
  assert.equal((await B.remindAll({ tenantId: muni.id })).sent, 0, 'never twice');
  const sent = await q('SELECT days, state FROM building_cert_reminders WHERE tenant_id = ? ORDER BY days', [muni.id]);
  assert.deepEqual(sent.map((s) => [s.days, s.state]), [[30, 'sent'], [60, 'skipped']], 'a late start skips the wider window');
  const r7 = await B.remindAll({ tenantId: muni.id, today: addDays(today, 15) });
  assert.equal(r7.sent, 1, 'the 7-day reminder');
  const rx = await B.remindAll({ tenantId: muni.id, today: addDays(today, 21) });
  assert.equal(rx.sent, 1, 'and once when it has expired');
  for (const who of [muni.token, manager.token]) {
    const threads = await api('GET', '/inbox/threads', { token: who });
    const th = threads.body.data.find((x) => x.name === B.THREAD_NAME);
    assert.ok(th, 'the managers\' conversation');
    const msgs = await api('GET', `/inbox/threads/${th.id}/messages`, { token: who });
    assert.equal(msgs.body.data.length, 3);
    assert.ok(msgs.body.data.some((m) => /runs out on .* in 20 days/.test(m.body)));
    assert.ok(msgs.body.data.some((m) => /expired on/.test(m.body)));
  }
  const crewThreads = await api('GET', '/inbox/threads', { token: crew.token });
  assert.ok(!crewThreads.body.data.some((x) => x.name === B.THREAD_NAME), 'the crew is not in it');
  // A newer certificate replaces it: nothing more about the old one.
  is(await api('POST', '/buildings/certificates', { token: muni.token, body: { asset_id: S.elevator, name: 'Certificate of operation', expires_on: addDays(today, 200) } }), 201);
  assert.equal((await B.remindAll({ tenantId: muni.id, today: addDays(today, 25) })).sent, 0);
  is(await api('POST', '/buildings/certificates', { token: crew.token, body: { asset_id: S.elevator, name: 'Certificate of operation', expires_on: addDays(today, 200) } }), 403);
});

// ---------------------------------------------------------------- the binder
test('the binder: one building and a date range, as a page and a spreadsheet', async () => {
  // Close one deficiency, so it shows with its date fixed.
  is(await api('POST', `/ops/work-orders/${S.failWo}/status`, { token: crew.token, body: { status: 'done', resolution: 'Replaced the extinguisher' } }), 200);
  const all = await api('GET', `/buildings/binder?building_id=${S.building}&from=${addDays(today, -365)}&to=${today}`, { token: desk.token });
  is(all, 200);
  const bd = all.body;
  assert.equal(bd.buildings.length, 1);
  assert.equal(bd.buildings[0].name, 'Town Hall'); assert.equal(bd.buildings[0].rooms, 2); assert.equal(bd.buildings[0].equipment, 4);
  assert.ok(bd.buildings[0].by_kind.some((k) => k.kind === 'fire_extinguisher' && k.n === 3));
  assert.ok(bd.inspections.some((i) => i.date === addDays(today, -40) && i.source === 'visit'));
  assert.ok(bd.inspections.some((i) => i.source === 'round' && i.result === 'fail' && i.failed.some((x) => /Needle in the red/.test(x))));
  assert.ok(bd.inspections.some((i) => i.readings.some((x) => /Next hydrostatic test due/.test(x))), 'readings are shown');
  assert.ok(bd.visits.some((v) => v.id === S.visit && v.document));
  assert.equal(bd.certificates.length, 1); assert.equal(bd.certificates[0].expires_on, addDays(today, 200));
  const fixed = bd.deficiencies.find((d) => d.work_order_id === S.failWo);
  assert.equal(fixed.open, false); assert.equal(fixed.fixed_on, today);
  assert.equal(bd.deficiencies.filter((d) => d.open).length, 3);
  assert.ok(bd.overdue.some((p) => p.plan_id === S.plan(S.ext[0], 'ext_monthly')) === false, 'checked today, so not overdue');
  assert.ok(bd.overdue.some((p) => p.plan_id === S.plan(S.ext[2], 'ext_annual') && p.state === 'never'));

  // The range filters: the last 30 days leaves out the check 40 days ago.
  const recent = await api('GET', `/buildings/binder?building_id=${S.building}&from=${addDays(today, -30)}&to=${today}`, { token: muni.token });
  assert.ok(!recent.body.inspections.some((i) => i.date === addDays(today, -40)));
  assert.ok(recent.body.inspections.some((i) => i.date === addDays(today, -25)));
  assert.ok(!recent.body.visits.some((v) => v.visit_on === addDays(today, -40)));
  is(await api('GET', `/buildings/binder?from=${today}&to=${addDays(today, -1)}`, { token: muni.token }), 400);

  const csv = await api('GET', `/buildings/binder?building_id=${S.building}&from=${addDays(today, -365)}&to=${today}&format=csv`, { token: muni.token });
  is(csv, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const text = csv.body.toString('utf8');
  assert.match(text.split('\r\n')[0], /^section,building,date,item/);
  for (const s of ['"Building"', '"Inspection"', '"Vendor visit"', '"Certificate"', '"Deficiency"', '"Overdue"']) assert.ok(text.includes(s), s);
  assert.ok(text.includes('"Fixed"'));
  assert.ok((await q("SELECT id FROM audit_log WHERE tenant_id = ? AND action = 'export' AND entity = 'buildings'", [muni.id])).length, 'the download is logged');

  const year = await api('GET', `/buildings/${S.building}/year`, { token: muni.token });
  is(year, 200);
  const extRow = year.body.tasks.find((x) => x.task === 'Fire extinguisher monthly check');
  assert.equal(extRow.plans, 3);
  assert.equal(extRow.cells[Number(today.slice(5, 7)) - 1].done >= 1, true);
});

// ---------------------------------------------------------------- isolation
test('another municipality reaches none of it', async () => {
  is(await api('GET', `/buildings/${S.building}`, { token: other.token }), 404);
  is(await api('GET', `/buildings/visits/${S.visit}`, { token: other.token }), 404);
  is(await api('POST', `/buildings/${S.building}/rounds`, { token: other.token, body: {} }), 404);
  is(await api('POST', `/buildings/${S.building}/equipment`, { token: other.token, body: { name: 'X', kind: 'roof' } }), 404);
  const ov = (await api('POST', '/assets/vendors', { token: other.token, body: { name: 'Other vendor' } })).body.id;
  is(await api('POST', '/buildings/visits', { token: other.token, body: { vendor_id: ov, visit_on: today, items: [{ plan_id: S.plan(S.ext[0], 'ext_monthly'), result: 'pass' }] } }), 404);
  is(await api('POST', '/buildings/visits', { token: other.token, body: { vendor_id: S.vendor, visit_on: today, items: [{ plan_id: S.plan(S.ext[0], 'ext_monthly'), result: 'pass' }] } }), 404);
  const visit = await q('SELECT document_id FROM building_visits WHERE id = ?', [S.visit]);
  is(await api('GET', `/buildings/documents/${visit[0].document_id}/file`, { token: other.token }), 404);
  const photo = await q('SELECT id FROM building_photos WHERE tenant_id = ? LIMIT 1', [muni.id]);
  is(await api('GET', `/buildings/photos/${photo[0].id}`, { token: other.token }), 404);
  const list = await api('GET', '/buildings', { token: other.token });
  assert.deepEqual(list.body.data, []);
  const binder = await api('GET', '/buildings/binder', { token: other.token });
  assert.equal(binder.body.inspections.length, 0);
  assert.equal((await api('GET', '/buildings/calendar', { token: other.token })).body.plans.length, 0);
});

// ---------------------------------------------------------------- demo
test('the demo borough gets its buildings, history, two vendor visits with certificates and one open deficiency, once', async () => {
  const path = require('path'); const { execFileSync } = require('child_process');
  const demo = `bld-demo-${suffix}`.slice(0, 40);
  const run = () => execFileSync(process.execPath, [path.join(__dirname, '..', 'db', 'demo-municipal.js'), demo], { cwd: path.join(__dirname, '..'), env: { ...process.env, SEED_PASSWORD: 'a-demo-password-1' }, timeout: 180000 }).toString();
  run();
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [demo]);
  const count = async () => Object.fromEntries(await Promise.all(['buildings', 'building_plans', 'building_visits', 'building_certificates', 'building_deficiencies', 'building_documents', 'asset_inspections'].map(async (x) => [x, Number((await q(`SELECT COUNT(*) AS n FROM ${x} WHERE tenant_id = ?`, [t.id]))[0].n)])));
  const first = await count();
  assert.equal(first.buildings, 6);
  assert.equal(first.building_visits, 2);
  assert.equal(first.building_certificates, 2);
  assert.equal(first.building_deficiencies, 1);
  assert.ok(first.asset_inspections > 300, 'twelve months of checks');
  assert.ok((await q("SELECT COUNT(*) AS n FROM ops_assets a JOIN tenants x ON x.id = a.tenant_id WHERE a.tenant_id = ? AND a.kind = 'fire_extinguisher' AND a.name LIKE 'Borough Hall extinguisher %'", [t.id]))[0].n === 14);
  const pdf = await q("SELECT f.content FROM documents d JOIN document_files f ON f.tenant_id = d.tenant_id AND f.document_id = d.id WHERE d.tenant_id = ? AND d.title LIKE 'Valley Elevator%'", [t.id]);
  assert.equal(pdf[0].content.subarray(0, 5).toString(), '%PDF-');
  run();
  assert.deepEqual(await count(), first, 'the second run adds nothing');
  const today = todayIn('America/New_York');
  const certs = await B.currentCerts(pool, t.id, today);
  assert.ok(certs.some((c) => c.state === 'soon'), 'the elevator certificate runs out within 30 days');
  const plans = await B.plansOf(pool, t.id, today);
  assert.ok(plans.some((p) => p.state === 'overdue') && plans.some((p) => p.state === 'never'));
});
