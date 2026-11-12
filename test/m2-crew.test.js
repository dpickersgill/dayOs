'use strict';

// Release 2026.11.20, workstream "crew": the crew board and Today by role, on call (rotations, swaps, holidays, the
// after-hours alert), overtime and call-outs, the public works certification types and operator licenses, assigning
// several work orders at once, the work orders map and the water/sewer/stormwater filter, the program words that Today
// and the program page share, and Settings, Apps (adding and removing an add-on through the plan). Through real HTTP.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const OC = require('../src/lib/oncall');
const { progressWords } = require('../src/lib/programprogress');
const { MUNI_CERTS } = require('../src/lib/crewcerts');
const { usualHolidays } = require('../src/routes/crew');
const { createMuniTenant } = require('./helpers/muni');

const KEY = 'test-bootstrap-key';
const PW = 'correct-horse-battery';
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
let server; let base;
let A; let B; let ski; let skiToken;
const staffA = {}; let crew; let desk; let mgrA;

async function api(method, p, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body).slice(0, 400)}`);
const day = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
const lastWeekday = (want, from) => { let d = from; for (let i = 0; i < 14; i += 1) { d = new Date(Date.parse(`${d}T12:00:00Z`) - 86400000).toISOString().slice(0, 10); if (day(d) === want) return d; } return d; };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function person(M, first, last) {
  const r = await api('POST', '/workforce/staff', { token: M.token, body: { person: { first_name: first, last_name: last }, status: 'active' } });
  is(r, 201, `staff ${first}`);
  return r.body.id;
}

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await createMuniTenant(base, { slug: `mc-a-${suffix}`, name: `Crew Test ${suffix}`, modules: { water: true, sewer: true } });
  B = await createMuniTenant(base, { slug: `mc-b-${suffix}`, name: `Other Crew ${suffix}` });
  staffA.luis = await person(A, 'Luis', 'Ortega');
  staffA.tom = await person(A, 'Tom', 'Kowalski');
  staffA.ann = await person(A, 'Ann', 'Lee');
  crew = await A.addLogin('staff', { staff_id: staffA.luis });
  mgrA = await A.addLogin('manager');
  desk = await A.addLogin('counter');
  const made = await api('POST', '/platform/tenants', { headers: { 'x-platform-key': KEY }, body: { slug: `mc-ski-${suffix}`, name: `Pine Crew ${suffix}`, billing: 'comped', owner: { email: `gm@mc-ski-${suffix}.test`, password: PW, first_name: 'Gale', last_name: 'Ridge' } } });
  is(made, 201);
  ski = { id: Number(made.body.id), slug: `mc-ski-${suffix}` };
  skiToken = (await api('POST', '/auth/login', { body: { tenant: ski.slug, login: `gm@mc-ski-${suffix}.test`, password: PW } })).body.token;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

// ---------------------------------------------------------------- certifications
test('a new municipality has the public works certification types; a ski area does not', async () => {
  const list = (await api('GET', '/workforce/certifications?limit=100', { token: A.token })).body.data.map((c) => c.name);
  for (const [, name] of MUNI_CERTS) assert.ok(list.includes(name), `${name} in ${list.join(', ')}`);
  const skiList = (await api('GET', '/workforce/certifications?limit=100', { token: skiToken })).body.data.map((c) => c.name);
  assert.ok(!skiList.includes('CDL Class A'), 'a ski area keeps its own list');
});

test('operator licenses: the people holding an unexpired water operator license, with their logins', async () => {
  const certs = (await api('GET', '/workforce/certifications?limit=100', { token: A.token })).body.data;
  const water = certs.find((c) => c.name === 'Pennsylvania water operator');
  is(await api('PUT', `/workforce/staff/${staffA.luis}/certifications`, { token: A.token, body: { certification_id: water.id, expires_on: '2030-01-01' } }), 200);
  is(await api('PUT', `/workforce/staff/${staffA.tom}/certifications`, { token: A.token, body: { certification_id: water.id, expires_on: '2020-01-01' } }), 200); // expired
  const r = await api('GET', '/workforce/licenses?kind=water', { token: A.token });
  is(r, 200);
  assert.deepEqual(r.body.data.map((x) => x.staff_id), [staffA.luis], 'only the unexpired license');
  assert.deepEqual(r.body.data[0].user_ids, [Number(crew.id)], 'with the login linked to the staff record');
  is(await api('GET', '/workforce/licenses?kind=water', { token: crew.token }), 403, 'managers only');
  is(await api('GET', '/workforce/licenses?kind=gas', { token: A.token }), 400);
});

// ---------------------------------------------------------------- on call
test('on call: a weekly rotation, a swap, holidays, who is on now; managers change it, everyone reads it', async () => {
  const t = today();
  const monday = day(t) === 1 ? t : lastWeekday(1, t);
  const meta = (await api('GET', '/requests/meta', { token: A.token })).body;
  const water = meta.categories.find((c) => /water leak/i.test(c.name));
  const made = await api('POST', '/workforce/oncall/rotations', { token: A.token, body: { name: 'Water and sewer', department: 'Water', members: [staffA.luis, staffA.tom], starts_on: monday, period_days: 7, category_ids: [water.id] } });
  is(made, 201);
  is(await api('POST', '/workforce/oncall/rotations', { token: A.token, body: { name: 'Water and sewer', members: [], starts_on: monday } }), 409, 'one name once');
  is(await api('POST', '/workforce/oncall/rotations', { token: A.token, body: { name: 'Twice', members: [staffA.luis, staffA.luis], starts_on: monday } }), 400, 'a person once');
  is(await api('POST', '/workforce/oncall/rotations', { token: crew.token, body: { name: 'Crew made', members: [], starts_on: monday } }), 403);
  const other = await person(B, 'Bea', 'Other');
  is(await api('POST', '/workforce/oncall/rotations', { token: A.token, body: { name: 'Theirs', members: [other], starts_on: monday } }), 404, 'another municipality\'s staff');

  const cal = await api('GET', `/workforce/oncall?from=${monday}&days=14`, { token: A.token });
  is(cal, 200);
  const rot = cal.body.rotations.find((r) => r.name === 'Water and sewer');
  assert.equal(rot.days[0].staff_id, staffA.luis, 'the first turn is the first person');
  assert.equal(rot.days[6].staff_id, staffA.luis);
  assert.equal(rot.days[7].staff_id, staffA.tom, 'the next week, the next person');
  assert.deepEqual(rot.member_names.map((m) => m.name), ['Luis Ortega', 'Tom Kowalski']);
  // The department typed as "Water" is the Water department from the list (2026.11.20 assembly: money's departments).
  const waterDept = cal.body.departments.find((d) => d.name === 'Water');
  assert.ok(waterDept, 'the municipality\'s departments come with the calendar');
  assert.equal(rot.department_id, waterDept.id); assert.equal(rot.department, 'Water');
  const otherDept = (await api('GET', '/workforce/oncall', { token: B.token })).body.departments.find((d) => d.name === 'Sewer');
  is(await api('PATCH', `/workforce/oncall/rotations/${made.body.id}`, { token: A.token, body: { department_id: otherDept.id } }), 404, 'another municipality\'s department');
  const sewerDept = cal.body.departments.find((d) => d.name === 'Sewer');
  is(await api('PATCH', `/workforce/oncall/rotations/${made.body.id}`, { token: A.token, body: { department_id: sewerDept.id } }), 200);
  const changed = (await api('GET', '/workforce/oncall', { token: A.token })).body.rotations.find((r) => r.id === made.body.id);
  assert.equal(changed.department, 'Sewer');
  assert.deepEqual([changed.category_ids, changed.period_days], [[water.id], 7], 'changing the department leaves the rest as it was');
  is(await api('PATCH', `/workforce/oncall/rotations/${made.body.id}`, { token: A.token, body: { department_id: waterDept.id } }), 200);
  // A swap: Ann takes the second Tuesday and Wednesday.
  const sw = await api('POST', '/workforce/oncall/overrides', { token: A.token, body: { rotation_id: made.body.id, staff_id: staffA.ann, starts_on: rot.days[8].date, ends_on: rot.days[9].date, reason: 'swap', note: 'Dentist' } });
  is(sw, 201);
  is(await api('POST', '/workforce/oncall/overrides', { token: A.token, body: { rotation_id: made.body.id, staff_id: staffA.ann, starts_on: rot.days[9].date, ends_on: rot.days[8].date } }), 400, 'last day before the first');
  const cal2 = (await api('GET', `/workforce/oncall?from=${monday}&days=14`, { token: crew.token })).body;
  const r2 = cal2.rotations.find((r) => r.name === 'Water and sewer');
  assert.equal(r2.days[8].staff_id, staffA.ann); assert.equal(r2.days[8].why, 'swap'); assert.equal(r2.days[10].staff_id, staffA.tom, 'back to the rotation after the swap');
  assert.equal(cal2.can_manage, false, 'the crew reads it, a manager changes it');
  // Holidays.
  const hol = await api('POST', '/workforce/oncall/holidays/usual', { token: A.token, body: { year: 2027 } });
  is(hol, 200); assert.equal(hol.body.added, 11);
  assert.equal((await api('POST', '/workforce/oncall/holidays/usual', { token: A.token, body: { year: 2027 } })).body.added, 0, 'twice adds nothing');
  const days2027 = (await api('GET', '/workforce/oncall/holidays?year=2027', { token: A.token })).body.data.map((x) => x.day);
  assert.ok(days2027.includes('2027-11-25') && days2027.includes('2027-07-05') && days2027.includes('2027-12-24'), `Thanksgiving, and the 4th and Christmas observed on a weekday: ${days2027}`);
  is(await api('POST', '/workforce/oncall/holidays', { token: A.token, body: { day: '2027-04-02', name: 'Good Friday' } }), 201);
  is(await api('POST', '/workforce/oncall/holidays', { token: A.token, body: { day: '2027-04-02', name: 'Again' } }), 409);
  // Who is on call now: the front desk reads it to pass calls on.
  const now = await api('GET', '/workforce/oncall/now', { token: desk.token });
  is(now, 200);
  const w = now.body.data.find((x) => x.rotation.name === 'Water and sewer');
  assert.ok(w.now && [staffA.luis, staffA.tom, staffA.ann].includes(w.now.staff_id) && w.now.name);
  // The other municipality never sees it.
  assert.equal((await api('GET', '/workforce/oncall', { token: B.token })).body.rotations.length, 0);
  is(await api('PATCH', `/workforce/oncall/rotations/${made.body.id}`, { token: B.token, body: { name: 'Mine now' } }), 404);
  is(await api('DELETE', `/workforce/oncall/overrides/${sw.body.id}`, { token: B.token }), 404);
});

test('on call: the rules for a turn, after hours and the handover', () => {
  const rot = OC.shape({ id: 1, name: 'R', members: '5,6,7', starts_on: '2026-11-02', period_days: 7, handover: '07:00:00', workday_start: '07:00:00', workday_end: '15:30:00', category_ids: '', active: 1 });
  assert.equal(OC.rotationPick(rot, '2026-11-02'), 5);
  assert.equal(OC.rotationPick(rot, '2026-11-09'), 6);
  assert.equal(OC.rotationPick(rot, '2026-11-23'), 5, 'round again');
  assert.equal(OC.rotationPick(rot, '2026-10-26'), 7, 'before the start, counting back');
  assert.equal(OC.turnDay(rot, '2026-11-09 06:30:00'), '2026-11-08', 'before the handover it is still last week\'s turn');
  assert.equal(OC.turnDay(rot, '2026-11-09 07:00:00'), '2026-11-09');
  const none = new Map();
  assert.equal(OC.isAfterHours(rot, '2026-11-10 10:00:00', none), false, 'a Tuesday morning');
  assert.equal(OC.isAfterHours(rot, '2026-11-10 15:30:00', none), true, 'after the working day');
  assert.equal(OC.isAfterHours(rot, '2026-11-10 06:59:00', none), true, 'before it');
  assert.equal(OC.isAfterHours(rot, '2026-11-14 11:00:00', none), true, 'a Saturday');
  assert.equal(OC.isAfterHours(rot, '2026-11-26 11:00:00', new Map([['2026-11-26', 'Thanksgiving']])), true, 'a holiday');
  const ov = [{ id: 1, rotation_id: 1, starts_on: '2026-11-10', ends_on: '2026-11-11', staff_id: 9, reason: 'cover', note: null }];
  assert.equal(OC.onCallFor(rot, '2026-11-10', ov).staff_id, 9);
  assert.equal(OC.onCallFor(rot, '2026-11-12', ov).staff_id, 6);
  assert.equal(usualHolidays(2026).find(([, n]) => n === 'Independence Day')[0], '2026-07-03', 'July 4 on a Saturday is observed on the Friday');
});

test('a water request reported after hours alerts the person on call once; one in office hours does not', async () => {
  const meta = (await api('GET', '/requests/meta', { token: A.token })).body;
  const water = meta.categories.find((c) => /water leak/i.test(c.name));
  const pothole = meta.categories.find((c) => /pothole/i.test(c.name));
  const t = today();
  const saturday = lastWeekday(6, t);
  let tuesday = lastWeekday(2, t);
  const hols = (await api('GET', `/workforce/oncall/holidays?year=${tuesday.slice(0, 4)}`, { token: A.token })).body.data.map((x) => x.day);
  if (hols.includes(tuesday)) tuesday = lastWeekday(2, tuesday);
  const take = (category, at) => api('POST', '/requests', { token: mgrA.token, body: { category_id: category.id, cross_street: 'Main Street at Bridge Street', source: 'phone', reported_at: at, reported_reason: 'Taken on the after-hours line' } });
  const night = await take(water, `${saturday} 23:10`); is(night, 201);
  const office = await take(water, `${tuesday} 10:00`); is(office, 201);
  const other = await take(pothole, `${saturday} 23:20`); is(other, 201);
  const alerts = async (id) => { for (let i = 0; i < 40; i += 1) { const [r] = await pool.query('SELECT * FROM oncall_alerts WHERE tenant_id = ? AND request_id = ?', [A.id, id]); if (r.length || i === 39) return r; await new Promise((x) => setTimeout(x, 50)); } return []; };
  const a = await alerts(night.body.id);
  assert.equal(a.length, 1, 'the after-hours water request alerted the rotation');
  const rot = (await api('GET', `/workforce/oncall?from=${saturday}&days=7`, { token: A.token })).body.rotations.find((r) => r.name === 'Water and sewer');
  assert.equal(Number(a[0].staff_id), rot.days[0].staff_id, 'the person on call that night');
  await new Promise((x) => setTimeout(x, 300));
  assert.equal((await alerts(office.body.id)).length, 0, 'in office hours: the usual alert only');
  assert.equal((await alerts(other.body.id)).length, 0, 'a category the rotation does not cover');
  // A second try for the same request does nothing more.
  const R = require('../src/lib/requests');
  const r = await R.requestOf(pool, A.id, night.body.id);
  assert.equal(await OC.alertAfterHours(A.id, r, 'Main Street'), 0);
});

// ---------------------------------------------------------------- the crew board and my day
test('the crew board is for managers; my day is the crew member\'s own work; nothing about residents on the board', async () => {
  const wo = await api('POST', '/ops/work-orders', { token: A.token, body: { title: 'Flush hydrant on Main Street', priority: 'high', assigned_staff_id: staffA.luis, due_date: today() } });
  is(wo, 201);
  is(await api('POST', '/workforce/time/clock-in', { token: crew.token, body: {} }), 201);
  const b = await api('GET', '/workforce/crew-board', { token: A.token });
  is(b, 200);
  const luis = b.body.people.find((p) => p.staff_id === staffA.luis);
  assert.equal(luis.state, 'in');
  assert.ok(luis.work.some((w) => w.id === wo.body.id), 'his work today');
  assert.ok(b.body.people.find((p) => p.staff_id === staffA.ann).state === 'off');
  assert.ok(Array.isArray(b.body.oncall) && b.body.oncall.length >= 1);
  assert.ok(b.body.certifications.some((c) => c.name === 'Tom Kowalski' && c.expired), 'the expired license is on the board');
  is(await api('GET', '/workforce/crew-board', { token: crew.token }), 403);
  is(await api('GET', '/workforce/crew-board', { token: desk.token }), 403);
  const d = await api('GET', '/workforce/my-day', { token: crew.token });
  is(d, 200);
  assert.equal(d.body.clock.in, true);
  assert.ok(d.body.work.some((w) => w.id === wo.body.id && w.today));
  // A request's work order on the board leaves the house number off (the board is often on a wall screen).
  const meta = (await api('GET', '/requests/meta', { token: A.token })).body;
  await api('POST', '/requests/streets', { token: A.token, body: { name: 'Market Street' } });
  const street = (await api('GET', '/requests/streets', { token: A.token })).body.data.find((s) => s.name === 'Market Street');
  const rq = await api('POST', '/requests', { token: A.token, body: { category_id: meta.categories.find((c) => /pothole/i.test(c.name)).id, street_id: street.id, house_number: '111', source: 'phone' } });
  is(rq, 201);
  const made = await api('POST', `/requests/${rq.body.id}/work-order`, { token: A.token, body: { assigned_staff_id: staffA.luis } });
  assert.ok([200, 201].includes(made.status), JSON.stringify(made.body));
  const b2 = (await api('GET', '/workforce/crew-board', { token: A.token })).body;
  const titles = b2.people.find((p) => p.staff_id === staffA.luis).work.map((w) => w.title).join(' | ');
  assert.ok(/Market Street/.test(titles) && !/\b111\b/.test(titles), `the street, no house number on the board: ${titles}`);
  assert.ok((await api('GET', '/workforce/my-day', { token: crew.token })).body.work.some((w) => /111 Market Street/.test(`${w.title} ${w.where}`)), 'the crew member sees the address on their own phone');
  // Call-out: the crew member's open punch is marked; a second call says so.
  const co = await api('POST', '/workforce/oncall/callout', { token: crew.token, body: {} });
  is(co, 200); assert.equal(co.body.already_in, true);
  assert.equal((await api('GET', '/workforce/my-day', { token: crew.token })).body.clock.callout, true);
  is(await api('POST', '/workforce/oncall/callout', { token: crew.token, body: { staff_id: staffA.tom } }), 403, 'only for yourself');
  is(await api('POST', '/workforce/time/clock-out', { token: crew.token, body: {} }), 200);
  const co2 = await api('POST', '/workforce/oncall/callout', { token: crew.token, body: {} });
  is(co2, 201, 'clocks in for a call-out');
  is(await api('POST', '/workforce/time/clock-out', { token: crew.token, body: {} }), 200);
});

// ---------------------------------------------------------------- overtime
test('overtime: hours over 40 a week per person and the call-outs, on screen and as a spreadsheet', async () => {
  const monday = lastWeekday(1, lastWeekday(1, today()));
  const add = (d, a, b) => api('POST', '/workforce/time/entries', { token: A.token, body: { staff_id: staffA.tom, clock_in: `${d} ${a}`, clock_out: `${d} ${b}`, note: 'Paper time sheet' } });
  for (let i = 0; i < 5; i += 1) is(await add(new Date(Date.parse(`${monday}T12:00:00Z`) + i * 86400000).toISOString().slice(0, 10), '06:00', '15:00'), 201); // 5 x 9 h = 45 h
  const night = await add(new Date(Date.parse(`${monday}T12:00:00Z`) + 2 * 86400000).toISOString().slice(0, 10), '21:00', '23:00');
  is(night, 201);
  is(await api('PATCH', `/workforce/overtime/entries/${night.body.id}`, { token: A.token, body: { callout: true } }), 200);
  is(await api('PATCH', `/workforce/overtime/entries/${night.body.id}`, { token: B.token, body: { callout: true } }), 404, 'another municipality');
  const o = await api('GET', `/workforce/overtime?start=${monday}`, { token: A.token });
  is(o, 200);
  const tom = o.body.data.find((r) => r.staff_id === staffA.tom);
  assert.equal(tom.worked_minutes, 47 * 60);
  assert.equal(tom.overtime_minutes, 7 * 60);
  assert.equal(tom.regular_minutes, 40 * 60);
  assert.equal(tom.callouts, 1); assert.equal(tom.callout_minutes, 120);
  is(await api('GET', `/workforce/overtime?start=${monday}`, { token: crew.token }), 403);
  const csv = await api('GET', `/workforce/overtime/export?start=${monday}`, { token: A.token });
  is(csv, 200);
  assert.match(String(csv.body), /^name,staff_id,week_starting,worked_hours,regular_hours,overtime_hours,callouts,callout_hours/);
  assert.match(String(csv.body), /"Tom Kowalski","\d+","[\d-]+","47\.00","40\.00","7\.00","1","2\.00"/);
});

// ---------------------------------------------------------------- work orders: assign several, the map, the system filter
test('work orders: a manager assigns several at once; done ones and other municipalities\' are refused', async () => {
  const ids = [];
  for (const title of ['Patch pothole A', 'Patch pothole B', 'Patch pothole C']) ids.push((await api('POST', '/ops/work-orders', { token: A.token, body: { title } })).body.id);
  const r = await api('POST', '/ops/work-orders/assign', { token: A.token, body: { ids, assigned_staff_id: staffA.ann, due_date: '2027-03-01' } });
  is(r, 200); assert.equal(r.body.updated, 3);
  for (const id of ids) { const w = (await api('GET', `/ops/work-orders/${id}`, { token: A.token })).body; assert.equal(w.assigned_staff_id, staffA.ann); assert.equal(String(w.due_date).slice(0, 10), '2027-03-01'); }
  // Keep their due dates: leave due_date out.
  is(await api('POST', '/ops/work-orders/assign', { token: A.token, body: { ids: [ids[0]], assigned_staff_id: staffA.tom } }), 200);
  assert.equal(String((await api('GET', `/ops/work-orders/${ids[0]}`, { token: A.token })).body.due_date).slice(0, 10), '2027-03-01');
  is(await api('POST', '/ops/work-orders/assign', { token: A.token, body: { ids, assigned_staff_id: null } }), 200, 'unassign');
  is(await api('POST', '/ops/work-orders/assign', { token: crew.token, body: { ids, assigned_staff_id: staffA.luis } }), 403, 'managers only');
  is(await api('POST', `/ops/work-orders/${ids[2]}/status`, { token: A.token, body: { status: 'cancelled' } }), 200);
  is(await api('POST', '/ops/work-orders/assign', { token: A.token, body: { ids, assigned_staff_id: staffA.luis } }), 409, 'a canceled one in the list');
  is(await api('POST', '/ops/work-orders/assign', { token: B.token, body: { ids: [ids[0]], assigned_staff_id: null } }), 404, 'another municipality\'s work order');
  is(await api('POST', '/ops/work-orders/assign', { token: A.token, body: { ids: [ids[0]], assigned_staff_id: 999999 } }), 404, 'unknown person');
});

test('work orders: the water, sewer and stormwater filter matches Today\'s cards, and the map shows open ones with a place', async () => {
  const at = [40.12, -75.51];
  const valve = await api('POST', '/assets/map/features', { token: A.token, body: { kind: 'valve', tag: 'V-114', points: [at] } });
  is(valve, 201);
  const mh = await api('POST', '/assets/map/features', { token: A.token, body: { kind: 'sewer_manhole', tag: 'MH-9', points: [[40.121, -75.511]] } });
  is(mh, 201);
  const onValve = (await api('POST', '/ops/work-orders', { token: A.token, body: { title: 'Exercise V-114', map_feature_id: valve.body.id, priority: 'urgent' } })).body.id;
  const onMh = (await api('POST', '/ops/work-orders', { token: A.token, body: { title: 'Raise MH-9', map_feature_id: mh.body.id } })).body.id;
  const list = async (q) => (await api('GET', `/ops/work-orders?status=open&${q}`, { token: A.token })).body.data.map((w) => w.id);
  const water = await list('system=water');
  assert.ok(water.includes(onValve) && !water.includes(onMh));
  const sewer = await list('system=sewer');
  assert.ok(sewer.includes(onMh) && !sewer.includes(onValve));
  assert.ok((await list('system=nonsense')).includes(onMh), 'an unknown system is no filter');
  const card = (await api('GET', '/water/today', { token: A.token })).body.cards.find((c) => /work orders/.test(c.title));
  // The card opens the Water department's work orders (2026.11.20 assembly: money's departments), and counts that list.
  const deptId = (card.href.match(/^#\/works\?department_id=(\d+)$/) || [])[1];
  assert.ok(deptId, card.href);
  const inDept = await list(`department_id=${deptId}`);
  assert.ok(inDept.includes(onValve) && !inDept.includes(onMh), 'a valve job is charged to Water, a manhole job is not');
  assert.equal(card.count, inDept.length, 'the card counts what the list shows');
  const risk = (await api('GET', '/water/today', { token: A.token })).body.cards.find((c) => /high risk/.test(c.title));
  if (risk) assert.equal(risk.href, '#/assets/map?risk=high&system=water');
  const m = await api('GET', '/ops/work-orders/map', { token: crew.token });
  is(m, 200);
  const w = m.body.data.find((x) => x.id === onValve);
  assert.ok(w && Math.abs(w.lat - at[0]) < 1e-6 && Math.abs(w.lng - at[1]) < 1e-6 && w.priority === 'urgent' && w.place === 'V-114');
  assert.ok(m.body.unplaced >= 1, 'work orders with no place are counted, not drawn');
  assert.ok((await api('GET', '/ops/work-orders/map?system=sewer', { token: A.token })).body.data.every((x) => x.id !== onValve));
  is(await api('GET', '/ops/work-orders/map', { token: desk.token }), 403, 'the front desk has no work orders map');
  assert.ok(!(await api('GET', '/ops/work-orders/map', { token: B.token })).body.data.some((x) => x.id === onValve), 'not another municipality\'s');
});

test('program progress: one set of words for Today and the program page', () => {
  assert.equal(progressWords({ total: 24, done: 11, skipped: 1, failed: 2 }), '11 of 24 done, 1 skipped, 2 failed, 12 to do');
  assert.equal(progressWords({ total: 5, done: 5, skipped: 0, failed: 0 }), '5 of 5 done');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'assetprograms.js'), 'utf8');
  assert.ok(/text: `\$\{p\.progress\.words\}/.test(src), 'the Today card uses the program\'s own words');
});

// ---------------------------------------------------------------- Settings, Apps
test('apps: the owner adds and removes an add-on through the plan; a manager only looks; core apps stay', async () => {
  const look = await api('GET', '/billing/apps', { token: mgrA.token });
  is(look, 200);
  assert.equal(look.body.can_change, false);
  const st = look.body.apps.find((a) => a.key === 'stormwater');
  assert.ok(st && st.addon && !st.on && st.yearly_cents === 120000, JSON.stringify(st));
  assert.ok(look.body.apps.find((a) => a.key === 'requests' && !a.addon && a.on));
  assert.ok(!look.body.apps.some((a) => a.key === 'patrol' || a.key === 'sell'), 'no ski apps offered');
  assert.ok(!look.body.apps.some((a) => /ski|lift|snow|mountain/i.test(a.blurb)), 'municipal words');
  is(await api('POST', '/billing/apps', { token: mgrA.token, body: { module: 'stormwater', on: true } }), 403);
  is(await api('GET', '/stormwater/today', { token: A.token }), 403, 'off before');
  const add = await api('POST', '/billing/apps', { token: A.token, body: { module: 'stormwater', on: true } });
  is(add, 200);
  assert.ok(add.body.apps.find((a) => a.key === 'stormwater').on);
  is(await api('GET', '/stormwater/today', { token: A.token }), 200, 'on straight away (no charge: no subscription to wait for)');
  const bill = (await api('GET', '/billing', { token: A.token })).body;
  assert.ok(bill.billing.addons.includes(st.addon_id), 'the plan choice holds the add-on');
  is(await api('POST', '/billing/apps', { token: A.token, body: { module: 'stormwater', on: false } }), 200);
  is(await api('GET', '/stormwater/today', { token: A.token }), 403, 'off again');
  assert.ok(!(await api('GET', '/billing', { token: A.token })).body.billing.addons.includes(st.addon_id));
  is(await api('POST', '/billing/apps', { token: A.token, body: { module: 'requests', on: false } }), 400, 'part of the plan');
  is(await api('POST', '/billing/apps', { token: A.token, body: { module: 'patrol', on: true } }), 400, 'not offered');
  const [log] = await pool.query("SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ? AND action IN ('app_added','app_removed')", [A.id]);
  assert.equal(Number(log[0].n), 2, 'each change is logged');
});
