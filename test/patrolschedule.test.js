'use strict';

// Patrol keeps its own roster and schedule: volunteers are added in Patrol and never appear in Staff and schedule; paid
// patrollers can be on both; patrol shifts are built in Patrol (by those with the schedule permission), checked against
// work shifts for paid patrollers, published with Inbox messages, shown read-only in Staff and schedule, counted as days
// patrolled, and paid patrollers' patrol time counts toward their hours.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { todayIn, addDays, nowIn } = require('../src/lib/util');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);

const M = {};
const monday = (() => { const d = addDays(todayIn('America/New_York'), 35); const wd = new Date(`${d}T00:00:00Z`).getUTCDay(); return addDays(d, -((wd + 6) % 7)); })();
const at = (day, hm) => `${addDays(monday, day)}T${hm}`;
const week = () => `from=${monday}&to=${addDays(monday, 6)}`;

async function inboxText(token) {
  const threads = ok(await api('GET', '/inbox/threads', { token })).data;
  const out = [];
  for (const t of threads) out.push(...ok(await api('GET', `/inbox/threads/${t.id}/messages`, { token })).data.map((m) => m.body));
  return out.join('\n');
}

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const slug = `ps-${suffix}`;
  M.slug = slug;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Patrol Peak', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  M.owner = await login(`owner@${slug}.test`);
  M.id = Number((await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]))[0][0].id);
  // Paula is paid (on the staff list); Vic and Val are volunteers, added in Patrol
  M.paula = Number(ok(await api('POST', '/workforce/staff', { token: M.owner, body: { person: { first_name: 'Paula', last_name: 'Paid' }, status: 'active' } })).id);
  ok(await api('POST', '/patrol/team', { token: M.owner, body: { staff_id: M.paula, level: 'leader' } }));
  M.vic = Number(ok(await api('POST', '/patrol/team', { token: M.owner, body: { person: { first_name: 'Vic', last_name: 'Volunteer', email: 'vic@example.test' } } })).staff_id);
  M.val = Number(ok(await api('POST', '/patrol/team', { token: M.owner, body: { person: { first_name: 'Val', last_name: 'Volunteer' }, level: 'candidate' } })).staff_id);
  for (const [who, sid] of [['paula', M.paula], ['vic', M.vic]]) {
    ok(await api('POST', '/users', { token: M.owner, body: { email: `${who}@${slug}.test`, password: PW, role: 'patrol', staff_id: sid } }));
    M[`${who}T`] = await login(`${who}@${slug}.test`);
  }
  M.hut = Number(ok(await api('POST', '/patrol/stations', { token: M.owner, body: { name: 'Summit hut', kind: 'hut' } })).id);
  M.lift = Number(ok(await api('POST', '/workforce/positions', { token: M.owner, body: { name: 'Lift operator', department: 'lifts' } })).id);
  M.patrolPos = Number(ok(await api('POST', '/workforce/positions', { token: M.owner, body: { name: 'Patroller', department: 'patrol', visits_per_staff: 100 } })).id);
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('everyone is on the staff list, marked employee or volunteer; volunteers stay off the time clock', async () => {
  const roster = ok(await api('GET', '/patrol/team', { token: M.owner })).data;
  assert.deepEqual(roster.map((m) => [m.first_name, m.on_staff_list]).sort(), [['Paula', true], ['Val', false], ['Vic', false]]);
  const staff = ok(await api('GET', '/workforce/staff', { token: M.owner })).data;
  assert.deepEqual(staff.map((s) => [s.first_name, s.employee, s.on_patrol]).sort(), [['Paula', true, true], ['Val', false, true], ['Vic', false, true]]);
  assert.deepEqual(ok(await api('GET', '/workforce/staff?type=volunteer', { token: M.owner })).data.map((s) => s.first_name).sort(), ['Val', 'Vic']);
  assert.deepEqual(ok(await api('GET', '/workforce/staff?type=employee', { token: M.owner })).data.map((s) => s.first_name), ['Paula']);
  const kiosk = ok(await api('GET', '/kiosk-admin/overview', { token: M.owner })).people.map((p) => p.first_name);
  assert.ok(!kiosk.includes('Vic'), 'volunteers are not on the time clock');
  const c = ok(await api('POST', '/workforce/shifts/candidates', { token: M.owner, body: { position_id: M.lift, starts_at: at(0, '08:00'), ends_at: at(0, '16:00') } })).data;
  assert.equal(c.find((x) => x.name === 'Vic Volunteer').volunteer, true, 'volunteers can be scheduled, and are marked');
  is(await api('POST', '/workforce/time/clock-in', { token: M.vicT }), 400, 'volunteers do not clock in');
  // details are kept in Patrol, and a volunteer can become an employee (and back)
  ok(await api('PATCH', `/patrol/team/${M.val}`, { token: M.owner, body: { phone: '555-0199', first_name: 'Valerie' } }));
  ok(await api('PATCH', `/patrol/team/${M.val}`, { token: M.owner, body: { on_staff_list: true } }));
  assert.ok(ok(await api('GET', '/workforce/staff?type=employee', { token: M.owner })).data.some((s) => s.first_name === 'Valerie'));
  ok(await api('PATCH', `/workforce/staff/${M.val}`, { token: M.owner, body: { employee: false } }));
  assert.ok(ok(await api('GET', '/workforce/staff?type=volunteer', { token: M.owner })).data.some((s) => s.first_name === 'Valerie'));
  is(await api('POST', '/patrol/team', { token: M.owner, body: { staff_id: M.vic } }), 409, 'already on the roster');
  is(await api('POST', '/patrol/team', { token: M.owner, body: {} }), 400);
  // someone new added in Patrol as an employee
  const e = ok(await api('POST', '/patrol/team', { token: M.owner, body: { person: { first_name: 'Eve', last_name: 'Employee' }, employee: true } }));
  assert.equal(ok(await api('GET', `/workforce/staff/${e.staff_id}`, { token: M.owner })).employee, true);
  is(await api('DELETE', `/patrol/team/${e.staff_id}`, { token: M.owner }), 204);
});

test('a patroller turned on from the staff page can open Patrol whatever their login role', async () => {
  const lift = Number(ok(await api('POST', '/workforce/staff', { token: M.owner, body: { person: { first_name: 'Lou', last_name: 'Lift' }, status: 'active' } })).id);
  ok(await api('POST', '/users', { token: M.owner, body: { username: 'loulift', password: PW, role: 'staff', staff_id: lift } }));
  const t = (await api('POST', '/auth/login', { body: { tenant: M.slug, login: 'loulift', password: PW } })).body.token;
  is(await api('GET', '/patrol/me', { token: t }), 403, 'a staff login cannot open Patrol');
  ok(await api('POST', '/patrol/team', { token: M.owner, body: { staff_id: lift, level: 'patroller' } }));
  assert.equal(ok(await api('GET', '/auth/me', { token: t })).on_patrol, true);
  const me = ok(await api('GET', '/patrol/me', { token: t }));
  assert.equal(me.access_level, 'patrol');
  ok(await api('GET', `/patrol/schedule?${week()}`, { token: t }));
  is(await api('POST', '/patrol/schedule', { token: t, body: { starts_at: at(21, '08:00'), ends_at: at(21, '12:00') } }), 403, 'their level decides what they can do');
  // a patrol Admin gives Lou the schedule permission alone; everyone else at his level is unchanged
  ok(await api('PUT', `/patrol/team/${lift}/permissions`, { token: M.owner, body: { exceptions: [{ feature: 'manage_schedule', allowed: true }, { feature: 'dispatch', allowed: false }] } }));
  const perms = ok(await api('GET', `/patrol/team/${lift}/permissions`, { token: M.owner }));
  const f = (k) => perms.features.find((x) => x.key === k);
  assert.deepEqual([f('manage_schedule').from_level, f('manage_schedule').exception, f('manage_schedule').has], [false, true, true]);
  assert.deepEqual([f('dispatch').from_level, f('dispatch').exception, f('dispatch').has], [true, false, false]);
  ok(await api('POST', '/patrol/schedule', { token: t, body: { starts_at: at(21, '08:00'), ends_at: at(21, '12:00') } }));
  assert.ok(!ok(await api('GET', '/patrol/me', { token: t })).features.includes('dispatch'));
  assert.ok(!ok(await api('GET', '/patrol/me', { token: M.vicT })).features.includes('manage_schedule'), 'Vic, also Patrol level, is unchanged');
  assert.equal(ok(await api('GET', '/patrol/team', { token: M.owner })).data.find((m) => Number(m.staff_id) === lift).exceptions, 2);
  // only a patrol Admin sets permissions; clearing an exception goes back to the level
  is(await api('PUT', `/patrol/team/${lift}/permissions`, { token: M.vicT, body: { exceptions: [] } }), 403);
  ok(await api('PUT', `/patrol/team/${lift}/permissions`, { token: M.owner, body: { exceptions: [{ feature: 'dispatch', allowed: null }] } }));
  assert.ok(ok(await api('GET', '/patrol/me', { token: t })).features.includes('dispatch'));
  is(await api('PUT', `/patrol/team/${lift}/permissions`, { token: M.owner, body: { exceptions: [{ feature: 'not_a_thing', allowed: true }] } }), 400);
  // taken off patrol: Patrol closes again
  is(await api('DELETE', `/patrol/team/${lift}`, { token: M.owner }), 204);
  is(await api('GET', '/patrol/me', { token: t }), 403);
});

test('patrol shifts are built in Patrol, not in Staff and schedule', async () => {
  is(await api('POST', '/workforce/shifts', { token: M.owner, body: { position_id: M.patrolPos, starts_at: at(0, '08:00'), ends_at: at(0, '16:00') } }), 400);
  M.s1 = Number(ok(await api('POST', '/patrol/schedule', { token: M.owner, body: { staff_id: M.vic, starts_at: at(5, '08:00'), ends_at: at(5, '16:30'), station_id: M.hut, role_label: 'Sweep' } })).id);
  M.s2 = Number(ok(await api('POST', '/patrol/schedule', { token: M.owner, body: { starts_at: at(5, '08:00'), ends_at: at(5, '16:30') } })).id);
  is(await api('POST', '/patrol/schedule', { token: M.vicT, body: { starts_at: at(5, '08:00'), ends_at: at(5, '16:30') } }), 403, 'a plain patroller cannot build the schedule');
  // a patroller sees only published shifts; drafts are for the people building it
  assert.equal(ok(await api('GET', `/patrol/schedule?${week()}`, { token: M.vicT })).shifts.length, 0);
  const mine = ok(await api('GET', `/patrol/schedule?${week()}`, { token: M.owner }));
  assert.equal(mine.shifts.length, 2);
  assert.equal(mine.can_edit, true);
  assert.equal(mine.shifts.find((s) => s.id === M.s1).station, 'Summit hut');
  // the same person twice at once is refused, and someone not on the roster cannot be put on
  const twice = await api('PATCH', `/patrol/schedule/${M.s2}`, { token: M.owner, body: { staff_id: M.vic } });
  is(twice, 409);
  assert.match(JSON.stringify(twice.body), /Already on patrol 8:00 AM to 4:30 PM on/);
  const owner = Number((await pool.query('SELECT staff_id FROM users WHERE tenant_id = ? AND role = ?', [M.id, 'owner']))[0][0].staff_id || 0);
  if (owner) is(await api('PATCH', `/patrol/schedule/${M.s2}`, { token: M.owner, body: { staff_id: owner } }), 409);
});

test("a paid patroller's work shifts and patrol shifts cannot overlap, either way round", async () => {
  ok(await api('POST', '/patrol/schedule', { token: M.owner, body: { staff_id: M.paula, starts_at: at(1, '08:00'), ends_at: at(1, '16:00') } }));
  const work = await api('POST', '/workforce/shifts', { token: M.owner, body: { position_id: M.lift, staff_id: M.paula, starts_at: at(1, '12:00'), ends_at: at(1, '18:00') } });
  is(work, 409);
  assert.match(JSON.stringify(work.body), /On patrol 8:00 AM to 4:00 PM/);
  ok(await api('POST', '/workforce/shifts', { token: M.owner, body: { position_id: M.lift, staff_id: M.paula, starts_at: at(2, '08:00'), ends_at: at(2, '16:00') } }));
  const pat = await api('POST', '/patrol/schedule', { token: M.owner, body: { staff_id: M.paula, starts_at: at(2, '10:00'), ends_at: at(2, '14:00') } });
  is(pat, 409);
  assert.match(JSON.stringify(pat.body), /Working Lift operator/);
  const c = ok(await api('POST', '/patrol/schedule/candidates', { token: M.owner, body: { starts_at: at(2, '10:00'), ends_at: at(2, '14:00') } })).data;
  assert.equal(c.find((x) => x.name === 'Paula Paid').ok, false);
  assert.equal(c[0].ok, true, 'free people first');
  // Paula's week counts both: 8 h patrol + 8 h lifts
  assert.equal(c.find((x) => x.name === 'Paula Paid').week_minutes, 960);
});

test('publishing tells patrollers; a change tells whoever it affects; staff see patrol read-only', async () => {
  const r = ok(await api('POST', '/patrol/schedule/publish', { token: M.owner, body: { from: monday, to: addDays(monday, 6) } }));
  assert.equal(r.published, 3);
  assert.equal(r.notified, 2, 'Vic and Paula have logins and shifts');
  assert.match(await inboxText(M.vicT), /The patrol schedule is published\. You are on 1 patrol shift:\n- 8:00 AM to 4:30 PM on .* at Summit hut, Sweep/);
  assert.equal(ok(await api('GET', `/patrol/schedule?${week()}`, { token: M.vicT })).shifts.length, 3, 'published shifts are visible to the whole patrol');
  ok(await api('PATCH', `/patrol/schedule/${M.s1}`, { token: M.owner, body: { staff_id: M.val } }));
  assert.match(await inboxText(M.vicT), /You are no longer on patrol 8:00 AM to 4:30 PM/);
  // My shifts shows patrol shifts too
  const me = ok(await api('GET', '/workforce/me', { token: M.paulaT }));
  assert.ok(me.shifts.some((s) => s.kind === 'patrol' && /^Patrol/.test(s.position)));
  // Staff and schedule sees the coverage, read only
  const cov = ok(await api('GET', `/workforce/patrol-coverage?${week()}`, { token: M.owner })).data;
  assert.equal(cov.length, 3);
  is(await api('GET', `/workforce/patrol-coverage?${week()}`, { token: M.vicT }), 403);
  // staffing needs count the patrol position from the patrol schedule
  const need = ok(await api('GET', `/workforce/staffing-suggestion?date=${addDays(monday, 5)}&forecast=300`, { token: M.owner })).data.find((p) => p.position_id === M.patrolPos);
  assert.equal(need.scheduled, 1);
  assert.equal(need.unfilled, 1);
  assert.equal(need.gap, 2);
});

test('copying a patrol week keeps people where they can still come, and leaving the roster frees future shifts', async () => {
  const next = addDays(monday, 7);
  const r = ok(await api('POST', '/patrol/schedule/copy', { token: M.owner, body: { from: monday, to: next } }));
  assert.equal(r.created, 3);
  assert.equal(ok(await api('POST', '/patrol/schedule/copy', { token: M.owner, body: { from: monday, to: next } })).created, 0, 'no doubles');
  is(await api('DELETE', `/patrol/team/${M.val}`, { token: M.owner }), 204);
  const left = ok(await api('GET', `/patrol/schedule?from=${monday}&to=${addDays(next, 6)}`, { token: M.owner })).shifts;
  assert.ok(!left.some((s) => Number(s.staff_id) === M.val), 'Val is off every shift ahead');
  ok(await api('POST', '/patrol/team', { token: M.owner, body: { staff_id: M.val, level: 'candidate' } }));
});

test('days patrolled this season, with a CSV; paid patrollers\' patrol time counts toward their hours', async () => {
  const tz = (await pool.query('SELECT timezone FROM tenants WHERE id = ?', [M.id]))[0][0].timezone;
  const today = todayIn(tz);
  const y = addDays(today, -2);
  // two past published shifts for Vic and one post on Today's posts on another day
  for (const d of [y, addDays(y, -1)]) await pool.query("INSERT INTO patrol_shifts (tenant_id, staff_id, starts_at, ends_at, status) VALUES (?, ?, ?, ?, 'published')", [M.id, M.vic, `${d} 08:00:00`, `${d} 16:00:00`]);
  ok(await api('PUT', `/patrol/deployments/${addDays(y, -3)}`, { token: M.owner, body: { assignments: [{ staff_id: M.vic, station_id: M.hut }] } }));
  const days = ok(await api('GET', '/patrol/schedule/days', { token: M.owner }));
  const vic = days.data.find((d) => d.staff_id === M.vic);
  if (addDays(y, -3) >= `${days.season.slice(0, 4)}-08-01`) {
    assert.equal(vic.days, 3);
    assert.equal(vic.minutes, 960);
  }
  assert.equal(vic.paid, false);
  const csv = await api('GET', '/patrol/schedule/days?format=csv', { token: M.owner });
  assert.match(csv.text, /^name,patrol_number,rank,paid,days_patrolled,hours_scheduled/);
  assert.match(csv.text, /"Vic Volunteer"/);
  // Paula clocks in for a patrol shift: the punch is linked to it, and Hours counts it as scheduled
  const now = nowIn(tz);
  const s = new Date(Date.parse(`${now.replace(' ', 'T')}Z`) - 20 * 60000).toISOString().slice(0, 16);
  const e = new Date(Date.parse(`${now.replace(' ', 'T')}Z`) + 4 * 3600000).toISOString().slice(0, 16);
  const ps = Number(ok(await api('POST', '/patrol/schedule', { token: M.owner, body: { staff_id: M.paula, starts_at: s, ends_at: e } })).id);
  ok(await api('POST', '/patrol/schedule/publish', { token: M.owner, body: { from: s.slice(0, 10), to: s.slice(0, 10) } }));
  ok(await api('POST', '/workforce/time/clock-in', { token: M.paulaT }));
  const entry = (await pool.query('SELECT shift_id, patrol_shift_id FROM time_entries WHERE tenant_id = ? AND staff_id = ? AND clock_out IS NULL', [M.id, M.paula]))[0][0];
  assert.equal(Number(entry.patrol_shift_id), ps);
  const wk = ok(await api('GET', `/workforce/time/week?start=${s.slice(0, 10)}`, { token: M.owner })).data.find((p) => p.staff_id === M.paula);
  assert.ok(wk.scheduled_minutes >= 260);
  assert.equal(wk.entries[0].shift.position, 'Patrol');
  ok(await api('POST', '/workforce/time/clock-out', { token: M.paulaT }));
});

test('a mountain only sees its own patrol schedule', async () => {
  const slug = `ps2-${suffix}`;
  await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Other', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'O', last_name: 'P' } }) });
  const other = (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token;
  assert.equal(ok(await api('GET', `/patrol/schedule?${week()}`, { token: other })).shifts.length, 0);
  is(await api('PATCH', `/patrol/schedule/${M.s2}`, { token: other, body: { notes: 'x' } }), 404);
  is(await api('POST', '/patrol/schedule', { token: other, body: { staff_id: M.vic, starts_at: at(3, '08:00'), ends_at: at(3, '12:00') } }), 409, 'not on their roster');
});
