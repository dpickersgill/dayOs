'use strict';

// The staff injury register: private to the owner and those the owner names (every look logged); a patrol case where
// the patient is staff on duty makes its record once; records numbered per calendar year; the log download in the Form
// 300 columns with privacy cases hidden; and the year summary with hours from the time clock.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
async function api(method, p, { token, body, raw } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (raw) return { status: res.status, body: text };
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);
const M = {};
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const year = Number(today.slice(0, 4));

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const slug = `ir-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Register Peak', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  M.tenant = Number((await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]))[0][0].id);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  M.owner = await login(`owner@${slug}.test`);
  ok(await api('POST', '/users', { token: M.owner, body: { email: `gm@${slug}.test`, password: PW, role: 'manager' } }));
  M.gm = await login(`gm@${slug}.test`);
  M.gmId = Number((await pool.query('SELECT id FROM users WHERE email = ?', [`gm@${slug}.test`]))[0][0].id);
  M.pat = Number(ok(await api('POST', '/patrol/team', { token: M.owner, body: { person: { first_name: 'Pat', last_name: 'Ridge' }, level: 'patroller' } })).staff_id);
  ok(await api('POST', '/users', { token: M.owner, body: { email: `pat@${slug}.test`, password: PW, role: 'patrol', staff_id: M.pat } }));
  M.patT = await login(`pat@${slug}.test`);
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('only the owner, and those the owner names, can open it', async () => {
  assert.equal(ok(await api('GET', '/auth/me', { token: M.owner })).staff_injuries, true);
  assert.equal(ok(await api('GET', '/auth/me', { token: M.gm })).staff_injuries, false);
  is(await api('GET', '/staff-injuries', { token: M.gm }), 403, 'a manager is not in by default');
  is(await api('GET', '/staff-injuries', { token: M.patT }), 403);
  is(await api('PUT', '/staff-injuries/access', { token: M.gm, body: { user_ids: [M.gmId] } }), 403);
  const users = ok(await api('GET', '/staff-injuries/access/users', { token: M.owner })).data;
  assert.ok(users.find((u) => u.id === M.gmId));
  ok(await api('PUT', '/staff-injuries/access', { token: M.owner, body: { user_ids: [M.gmId] } }));
  assert.equal(ok(await api('GET', '/auth/me', { token: M.gm })).staff_injuries, true);
  is(await api('GET', '/staff-injuries/access/users', { token: M.gm }), 403, 'only the owner chooses who');
});

test('a patrol case with a staff patient on duty makes its record once', async () => {
  const c = ok(await api('POST', '/patrol/incidents', { token: M.patT, body: { occurred_at: `${today}T10:15`, location: 'Rental shop', category: 'injury', severity: 'moderate', summary: 'Back strain lifting skis' } }));
  const p = ok(await api('POST', `/patrol/incidents/${c.id}/patients`, { token: M.patT, body: { first_name: 'Lee', last_name: 'Lift' } })).id;
  ok(await api('PATCH', `/patrol/incidents/${c.id}/patients/${p}`, { token: M.patT, body: { form: { patient_type: 'staff_work' } } }));
  ok(await api('PATCH', `/patrol/incidents/${c.id}/patients/${p}`, { token: M.patT, body: { disposition: 'treated_released' } }));
  const r = ok(await api('GET', '/staff-injuries', { token: M.gm }));
  const recs = r.data.filter((x) => x.incident_id === c.id);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].employee_name, 'Lee Lift'); assert.equal(recs[0].place, 'Rental shop'); assert.equal(recs[0].description, 'Back strain lifting skis');
  assert.equal(recs[0].number, `${year}-001`); assert.equal(recs[0].source, 'patrol');
  M.rec = recs[0].id;
  // each look is logged
  ok(await api('GET', `/staff-injuries/${M.rec}`, { token: M.gm }));
  const [[log]] = await pool.query("SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ? AND entity = 'staff_injuries' AND action = 'view'", [M.tenant]);
  assert.ok(Number(log.n) >= 1);
});

test('records added by hand, numbered in the year, with the log download and the summary', async () => {
  const b = ok(await api('POST', '/staff-injuries', { token: M.owner, body: { employee_name: 'Sam Snow', job_title: 'Snowmaker', occurred_at: `${today}T02:30`, place: 'Pump house', description: 'Frostbite, two fingers', kind: 'injury', outcome: 'days_away', days_away: 4, privacy_case: true } }));
  assert.equal(b.number, `${year}-002`);
  is(await api('POST', '/staff-injuries', { token: M.owner, body: { employee_name: 'X', occurred_at: `${today}T08:00`, outcome: 'death' } }), 400, 'a death needs its date');
  is(await api('PATCH', `/staff-injuries/${b.id}`, { token: M.owner, body: { occurred_at: `${year - 1}-12-30T08:00` } }), 400, 'stays in its year');
  ok(await api('PATCH', `/staff-injuries/${M.rec}`, { token: M.gm, body: { outcome: 'restricted', days_restricted: 3, job_title: 'Rental tech' } }));
  const csv = (await api('GET', `/staff-injuries/log.csv?year=${year}`, { token: M.owner, raw: true })).body;
  assert.match(csv, /Privacy case/); assert.doesNotMatch(csv, /Sam Snow/);
  assert.match(csv, /Lee Lift/); assert.match(csv, /Job transfer or restriction/);
  // hours from the time clock, unless the owner gives them
  await pool.query('INSERT INTO time_entries (tenant_id, staff_id, clock_in, clock_out) VALUES (?, ?, ?, ?), (?, ?, ?, ?)', [M.tenant, M.pat, `${today} 08:00:00`, `${today} 16:00:00`, M.tenant, M.pat, `${today} 08:00:00`, `${today} 08:30:00`]);
  let s = ok(await api('GET', `/staff-injuries/summary?year=${year}`, { token: M.owner }));
  assert.equal(s.days_away_cases, 1); assert.equal(s.restricted_cases, 1); assert.equal(s.days_away, 4); assert.equal(s.days_restricted, 3);
  assert.equal(s.kinds.injury, 2);
  assert.ok(s.from_clock.hours >= 8); assert.equal(s.hours_worked, null);
  s = ok(await api('PUT', `/staff-injuries/years/${year}`, { token: M.owner, body: { hours_worked: 52000, avg_employees: 41, certified_by: 'Olive Owner, Owner', certified_at: today } }));
  assert.equal(s.hours_worked, 52000); assert.equal(s.avg_employees, 41);
});
