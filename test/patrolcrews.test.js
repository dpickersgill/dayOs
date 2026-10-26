'use strict';

// Patrol crews: a repeating shift with how many it needs, the fewest it runs with and the roles it must have. Generating
// its days makes one spot per patroller wanted, standing members first; patrollers sign up for the rest (approved by a
// schedule builder when the patrol wants that); the week shows each crew's coverage and no-shows; a storm day adds
// spots; and on Thursday a short weekend is messaged to the schedule builders.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { todayIn, addDays } = require('../src/lib/util');
const C = require('../src/lib/patrolcrews');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);

const M = {};
const today = todayIn('America/New_York');
// The first Saturday at least three weeks out
let sat = addDays(today, 21);
while (C.dayOf(sat) !== 6) sat = addDays(sat, 1);
const sun = addDays(sat, 1);

async function inboxText(token) {
  const threads = ok(await api('GET', '/inbox/threads', { token })).data;
  const out = [];
  for (const t of threads) out.push(...ok(await api('GET', `/inbox/threads/${t.id}/messages`, { token })).data.map((m) => m.body));
  return out.join('\n');
}
const spots = async (crewId, date) => (await pool.query("SELECT * FROM patrol_shifts WHERE crew_id = ? AND DATE(starts_at) = ? AND status <> 'cancelled' ORDER BY id", [crewId, date]))[0];

test('the rules: days, spots, who fits a role, coverage and no-shows', () => {
  const crew = { days: '6,0', start_time: '08:00:00', end_time: '16:30:00', target: 4, minimum: 3, roles: JSON.stringify([{ label: 'Hill captain', count: 1, rank: 'leader' }, { label: 'EMT', count: 1, cert: 'emt' }]), from_date: '2026-12-01', to_date: '2027-04-15', skip_dates: '2026-12-26' };
  const dates = C.datesFor(crew, '2026-11-20', '2026-12-31');
  assert.equal(dates[0], '2026-12-05', 'the season starts Dec 1; the first Saturday is the 5th');
  assert.ok(!dates.includes('2026-12-26'), 'skipped');
  assert.ok(dates.every((d) => [0, 6].includes(C.dayOf(d))));
  assert.deepEqual(C.timesOn({ start_time: '22:00', end_time: '06:00' }, '2026-12-05'), { starts_at: '2026-12-05 22:00:00', ends_at: '2026-12-06 06:00:00' }, 'past midnight');
  const sp = C.spotsFor(crew);
  assert.deepEqual(sp.map((s) => s.role_label), ['Hill captain', 'EMT', null, null]);
  assert.deepEqual(C.fitProblems({ level: 'senior', cert_level: 'oec' }, sp[0]), ['Hill captain needs a Leader or above']);
  assert.ok(C.fits({ level: 'director', cert_level: 'oec' }, sp[0]));
  assert.equal(C.fitProblems({ level: 'patroller', cert_level: 'oec' }, sp[1]).length, 1);
  assert.ok(C.fits({ level: 'candidate', cert_level: 'paramedic' }, sp[1]));
  const members = new Map([[1, { level: 'leader', cert_level: 'oec' }], [2, { level: 'patroller', cert_level: 'oec' }], [3, { level: 'patroller', cert_level: 'emt' }]]);
  const row = (staff, role) => ({ staff_id: staff, role_label: role, status: 'published' });
  let c = C.coverage(crew, [row(1, 'Hill captain'), row(null, 'EMT'), row(2, null), row(null, null)], members);
  assert.equal(c.filled, 2); assert.equal(c.tone, 'critical'); assert.deepEqual(c.missing, ['EMT']);
  c = C.coverage(crew, [row(1, 'Hill captain'), row(null, 'EMT'), row(2, null), row(3, null)], members);
  assert.equal(c.tone, 'short', 'an EMT on a plain spot covers the role; 3 of 4 is at the minimum');
  assert.deepEqual(c.missing, []);
  assert.equal(C.coverage(crew, [row(1, 'Hill captain'), row(3, 'EMT'), row(2, null), row(4, null)], members).tone, 'good');
  const s = { staff_id: 1, status: 'published', starts_at: '2026-12-05 08:00:00' };
  assert.equal(C.isNoShow(s, '2026-12-05 08:14:00', false), false);
  assert.equal(C.isNoShow(s, '2026-12-05 08:15:00', false), true);
  assert.equal(C.isNoShow(s, '2026-12-05 09:00:00', true), false);
  assert.equal(C.summary(crew), 'Sat, Sun, 8:00 AM to 4:30 PM');
  assert.equal(C.clock12('00:15'), '12:15 AM'); assert.equal(C.clock12('12:00:00'), '12:00 PM');
});

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const slug = `pcr-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Crew Peak', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  M.tenant = Number((await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]))[0][0].id);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  M.owner = await login(`owner@${slug}.test`);
  for (const [key, first, level] of [['lee', 'Lee', 'leader'], ['ema', 'Ema', 'patroller'], ['pat', 'Pat', 'patroller'], ['cal', 'Cal', 'candidate']]) {
    M[key] = Number(ok(await api('POST', '/patrol/team', { token: M.owner, body: { person: { first_name: first, last_name: 'Crew' }, level } })).staff_id);
    ok(await api('POST', '/users', { token: M.owner, body: { email: `${key}@${slug}.test`, password: PW, role: 'patrol', staff_id: M[key] } }));
    M[`${key}T`] = await login(`${key}@${slug}.test`);
  }
  await pool.query("UPDATE patrol_members SET cert_level = 'emt' WHERE staff_id = ?", [M.ema]);
  M.hut = Number(ok(await api('POST', '/patrol/stations', { token: M.owner, body: { name: 'Summit hut', kind: 'hut' } })).id);
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('a crew is set up by those who build the schedule, with sensible numbers', async () => {
  const body = { name: 'Weekend day crew', days: [6, 0], start_time: '08:00', end_time: '16:30', station_id: M.hut, target: 4, minimum: 3, roles: [{ label: 'Hill captain', count: 1, rank: 'leader' }, { label: 'EMT', count: 1, cert: 'emt' }], from_date: today, to_date: addDays(today, 120), skip_dates: [addDays(sun, 7)] };
  is(await api('POST', '/patrol/crews', { token: M.patT, body }), 403, 'patrollers do not build crews');
  is(await api('POST', '/patrol/crews', { token: M.owner, body: { ...body, minimum: 5 } }), 400, 'minimum above target');
  is(await api('POST', '/patrol/crews', { token: M.owner, body: { ...body, roles: [...body.roles, { label: 'emt' }] } }), 400, 'two roles with one name');
  const c = ok(await api('POST', '/patrol/crews', { token: M.owner, body }));
  M.crew = c.id;
  assert.deepEqual(c.days, [0, 6]);
  assert.equal(c.station, 'Summit hut');
  ok(await api('PUT', `/patrol/crews/${M.crew}/members`, { token: M.owner, body: { members: [{ staff_id: M.lee, role_label: 'Hill captain' }, { staff_id: M.cal }] } }));
  is(await api('PUT', `/patrol/crews/${M.crew}/members`, { token: M.owner, body: { members: [{ staff_id: M.pat, role_label: 'Sweep' }] } }), 400, 'no such role');
  const list = ok(await api('GET', '/patrol/crews', { token: M.patT }));
  assert.equal(list.can_edit, false);
  assert.deepEqual(list.crews[0].members.map((m) => m.name).sort(), ['Cal Crew', 'Lee Crew']);
});

test('generating the days makes the spots, standing members on first, and skips days already made', async () => {
  const r = ok(await api('POST', `/patrol/crews/${M.crew}/generate`, { token: M.owner, body: { from: sat, to: addDays(sun, 7) } }));
  assert.equal(r.days, 3, 'Sat, Sun, Sat; the second Sunday is skipped');
  assert.equal(r.created, 12); assert.equal(r.filled, 6);
  const s = await spots(M.crew, sat);
  assert.deepEqual(s.map((x) => [x.role_label, x.staff_id && Number(x.staff_id)]), [['Hill captain', M.lee], ['EMT', null], [null, M.cal], [null, null]]);
  assert.ok(s.every((x) => x.status === 'draft' && Number(x.station_id) === M.hut && String(x.starts_at).endsWith('08:00:00')));
  assert.equal(s[1].need_cert, 'emt');
  const again = ok(await api('POST', `/patrol/crews/${M.crew}/generate`, { token: M.owner, body: { from: sat, to: sun } }));
  assert.equal(again.created, 0); assert.equal(again.skipped, 2);
  // the week: coverage by crew and day (drafts for builders, nothing for patrollers yet)
  const w = ok(await api('GET', `/patrol/schedule?from=${sat}&to=${sun}`, { token: M.owner }));
  const d = w.coverage.find((x) => x.date === sat);
  assert.equal(d.filled, 2); assert.equal(d.target, 4); assert.equal(d.tone, 'critical'); assert.deepEqual(d.missing, ['EMT']);
  const pw = ok(await api('GET', `/patrol/schedule?from=${sat}&to=${sun}`, { token: M.patT }));
  assert.equal(pw.shifts.length, 0); assert.ok(pw.coverage.every((x) => x.filled === 0 && !x.generated));
  // clearing drafts takes back a day, then it can be made again
  assert.equal(ok(await api('POST', `/patrol/crews/${M.crew}/clear`, { token: M.owner, body: { from: addDays(sat, 7), to: addDays(sat, 7) } })).removed, 4);
  ok(await api('POST', '/patrol/schedule/publish', { token: M.owner, body: { from: sat, to: sun } }));
});

test('patrollers sign up for open spots; a role spot needs the rank or certification', async () => {
  ok(await api('PUT', '/patrol/ops-settings', { token: M.owner, body: { self_signup: true } }));
  const s = await spots(M.crew, sat);
  const emtSpot = Number(s[1].id); const plain = Number(s[3].id);
  const r = await api('POST', `/patrol/cover/open/${emtSpot}/take`, { token: M.patT });
  is(r, 409, 'Pat is no EMT'); assert.match(JSON.stringify(r.body), /EMT or higher/);
  const board = ok(await api('GET', '/patrol/cover', { token: M.patT }));
  const seen = board.open_shifts.find((x) => x.id === emtSpot);
  assert.equal(seen.can_take, false); assert.equal(seen.crew, 'Weekend day crew');
  assert.equal(ok(await api('POST', `/patrol/cover/open/${emtSpot}/take`, { token: M.emaT })).status, 'approved');
  assert.equal(ok(await api('POST', `/patrol/cover/open/${plain}/take`, { token: M.patT })).status, 'approved');
  const d = ok(await api('GET', `/patrol/crews/coverage?from=${sat}&to=${sat}`, { token: M.owner })).days[0];
  assert.equal(d.tone, 'good'); assert.equal(d.filled, 4);
});

test('with approval on, a sign-up waits for a schedule builder', async () => {
  ok(await api('PUT', '/patrol/ops-settings', { token: M.owner, body: { signup_approval: true } }));
  const s = await spots(M.crew, sun);
  const plain = Number(s[3].id);
  const r = ok(await api('POST', `/patrol/cover/open/${plain}/take`, { token: M.patT }));
  assert.equal(r.status, 'pending');
  is(await api('POST', `/patrol/cover/open/${plain}/take`, { token: M.patT }), 409, 'asked already');
  ok(await api('POST', `/patrol/cover/open/${plain}/take`, { token: M.emaT }));
  assert.equal((await spots(M.crew, sun))[3].staff_id, null, 'still open');
  assert.ok(ok(await api('GET', '/patrol/cover', { token: M.patT })).open_shifts.find((x) => x.id === plain).asked);
  is(await api('GET', '/patrol/signups', { token: M.patT }), 403);
  const list = ok(await api('GET', '/patrol/signups', { token: M.owner })).data.filter((x) => x.shift_id === plain);
  assert.equal(list.length, 2);
  assert.equal(ok(await api('GET', `/patrol/schedule?from=${sat}&to=${sun}`, { token: M.owner })).signups.length, 2);
  ok(await api('POST', `/patrol/signups/${list.find((x) => x.staff_id === M.pat).id}/approve`, { token: M.owner }));
  assert.equal(Number((await spots(M.crew, sun))[3].staff_id), M.pat);
  assert.equal(ok(await api('GET', '/patrol/signups', { token: M.owner })).data.length, 0, 'Ema\'s ask on the same spot is closed');
  assert.match(await inboxText(M.emaT), /went to someone else/);
  assert.match(await inboxText(M.patT), /Approved: you are on the patrol shift/);
  // decline and withdraw
  const other = Number(s[1].id);
  const mine = ok(await api('POST', `/patrol/cover/open/${other}/take`, { token: M.emaT }));
  is(await api('DELETE', `/patrol/signups/${mine.signup_id}`, { token: M.patT }), 403, 'not yours');
  ok(await api('POST', `/patrol/signups/${mine.signup_id}/decline`, { token: M.owner, body: { note: 'We need you on Saturday' } }));
  assert.match(await inboxText(M.emaT), /Not approved.*We need you on Saturday/s);
  ok(await api('PUT', '/patrol/ops-settings', { token: M.owner, body: { signup_approval: false } }));
});

test('a storm day adds open spots and tells those free', async () => {
  const r = ok(await api('POST', '/patrol/crews/call', { token: M.owner, body: { crew_id: M.crew, date: sat, extra: 2, note: 'Two feet overnight' } }));
  assert.equal(r.added, 2);
  assert.equal(r.told, 0, 'everyone on the roster is already on Saturday');
  const s = await spots(M.crew, sat);
  assert.equal(s.filter((x) => Number(x.extra)).length, 2);
  assert.ok(s.filter((x) => Number(x.extra)).every((x) => x.status === 'published' && !x.staff_id));
  const d = ok(await api('GET', `/patrol/crews/coverage?from=${sat}&to=${sat}`, { token: M.owner })).days[0];
  assert.equal(d.open, 2); assert.equal(d.filled, 4);
  // a storm on Sunday: Cal is free then
  const r2 = ok(await api('POST', '/patrol/crews/call', { token: M.owner, body: { crew_id: M.crew, date: sun, extra: 1 } }));
  assert.ok(r2.told >= 1);
  assert.match(await inboxText(M.calT), /Extra patrollers needed: Weekend day crew/);
  // generating again skips the day; extra spots are not copied to another week
  assert.equal(ok(await api('POST', `/patrol/crews/${M.crew}/generate`, { token: M.owner, body: { from: sat, to: sat } })).created, 0);
});

test('on Thursday a short weekend is messaged to those who build the schedule', async () => {
  // Make "this weekend" the generated one by checking it directly: the check looks two and three days ahead.
  const thu = addDays(sat, -2);
  const days = (await require('../src/routes/patrolcrews').coverageRange(pool, M.tenant, addDays(thu, 2), addDays(thu, 3), { drafts: false })).days;
  assert.equal(days.length, 2);
  assert.ok(days.some((d) => d.tone !== 'good'), 'Sunday is missing its EMT');
  await pool.query("UPDATE patrol_settings SET short_alert_last = NULL WHERE tenant_id = ?", [M.tenant]);
  const sent = await require('../src/routes/patrolcrews').shortAlertAll({ force: M.tenant, today: thu });
  assert.equal(sent, 1);
  const text = await inboxText(M.leeT);
  assert.match(text, /This weekend's patrol is short/);
  assert.match(text, /no EMT/);
});

test('sign-in matches the scheduled spot, and a spot nobody signed in for is a no-show', async () => {
  const id = Number(ok(await api('POST', '/patrol/schedule', { token: M.owner, body: { staff_id: M.cal, starts_at: `${today}T00:01`, ends_at: `${today}T23:58` } })).id);
  ok(await api('POST', '/patrol/schedule/publish', { token: M.owner, body: { from: today, to: today } }));
  const w = ok(await api('GET', `/patrol/schedule?from=${today}&to=${today}`, { token: M.owner }));
  const s = w.shifts.find((x) => Number(x.id) === id);
  assert.equal(s.signed_in, false);
  assert.equal(s.no_show, w.now >= `${today} 00:16:00`);
  const duty = ok(await api('GET', '/patrol/duty', { token: M.owner }));
  assert.equal(duty.scheduled_not_in.find((x) => Number(x.staff_id) === M.cal).late, s.no_show);
  const signed = ok(await api('POST', '/patrol/duty/sign-in', { token: M.calT, body: {} }));
  assert.equal(signed.patrol_shift_id, id);
  const w2 = ok(await api('GET', `/patrol/schedule?from=${today}&to=${today}`, { token: M.owner }));
  assert.equal(w2.shifts.find((x) => Number(x.id) === id).no_show, false);
});
