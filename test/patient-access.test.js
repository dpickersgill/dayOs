'use strict';

// Patient-record access and who may reset whom (feat/auth-hardening). Every rule Dan approved, and every walk-around the
// independent reviews found (H1, H2, M1 to M4, L1 to L5, N1, N2, the M2 residual, non-digit ids, managers making
// themselves roster Admin, the person_id link), each as a test:
//   Remember me refused by the server; the fresh-check rule and its exceptions (own drafts, recent own work, responder,
//   dispatched, on duty, crew) and their limits; sign-in and an ordinary check are never the records check; every
//   patient-data read and write on another case needs it, however the address is spelled; summaries hidden on unchecked
//   lists; quick resume and the 8-hour cap; the passkey prompts; reset rules; roster Admin rules; staff links above
//   Patrol; the weekly access summary; responder rows from before the upgrade.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.AUDIT_LOG_STDOUT = 'off';
const http = require('node:http');

const mails = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => { try { mails.push(JSON.parse(body)); } catch (_) { /* not JSON */ } res.setHeader('content-type', 'application/json'); res.end('{"ErrorCode":0,"MessageID":"x"}'); });
}).listen(0);
process.env.POSTMARK_API_BASE = `http://127.0.0.1:${stub.address().port}`;
process.env.POSTMARK_SERVER_TOKEN = 'test-token';
process.env.MAIL_FROM = 'hello@test.example';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const totp = require('../src/lib/totp');
const PX = require('../src/lib/patientaccess');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const DEVICE = 'patient-access-device-0123456789';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

async function raw(method, p, { token, body, headers = {}, device = DEVICE } = {}) {
  const res = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...(device ? { 'x-device': device } : {}), ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const api = (method, p, opts) => raw(method, `/api/v1${p}`, opts);
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body).slice(0, 400)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body).slice(0, 300)}`);
const asks = (r, why) => { is(r, 403, why); assert.equal(r.body.details && r.body.details.code, 'step_up_required', why); assert.equal(r.body.details.scope, 'records', why); };
const settle = (ms = 300) => new Promise((r) => { setTimeout(r, ms); });
const login = (who, password = PW, extra = {}, device = DEVICE) => api('POST', '/auth/login', { body: { tenant: M.slug, login: who, password, ...extra }, device });
const tokenOf = async (who) => ok(await login(who)).token;
const records = (token, password = PW) => api('POST', '/auth/step-up', { token, body: { scope: 'records', password } });
const stepUp = (token, password = PW) => api('POST', '/auth/step-up', { token, body: { password } });
const sidHash = (t) => require('../src/lib/sessions').hash(JSON.parse(Buffer.from(t.split('.')[1], 'base64url')).sid);
const codeNow = (secret) => totp.hotp(secret, totp.stepAt(Date.now()));
const freshCode = async (userId, secret) => { await pool.query('UPDATE users SET totp_last_step = NULL WHERE id = ?', [userId]); return codeNow(secret); };

let M; const U = {};
/** A login (patrol by default) with a staff record, on the roster at `level` when given. */
async function person(key, { role = 'patrol', level = null, email = true } = {}) {
  const staff = ok(await api('POST', '/workforce/staff', { token: M.owner, body: { person: { first_name: key, last_name: 'Tester' }, status: 'active' } })).id;
  const login_ = `${key.toLowerCase()}@${M.slug}.test`;
  const u = ok(await api('POST', '/users', { token: M.owner, body: { ...(email ? { email: login_ } : { username: `${key.toLowerCase()}-${suffix}` }), password: PW, role, staff_id: staff } }));
  if (level) ok(await api('POST', '/patrol/team', { token: M.owner, body: { staff_id: staff, access_level: level, level: level === 'admin' ? 'director' : level === 'manager' ? 'leader' : 'patroller' } }));
  const who = email ? login_ : `${key.toLowerCase()}-${suffix}`;
  U[key] = { id: u.id, staff, login: who, token: await tokenOf(who) };
  return U[key];
}
const newCase = async (token, extra = {}) => ok(await api('POST', '/patrol/incidents', { token, body: { occurred_at: `${today}T10:15`, location: 'Upper Ridge', category: 'injury', severity: 'minor', summary: 'Knee', ...extra } })).id;
/** Moves a case (and the links made with it) back in time. */
async function age(id, hours) {
  await pool.query('UPDATE incidents SET created_at = DATE_SUB(created_at, INTERVAL ? HOUR) WHERE id = ?', [hours, id]);
  await pool.query('UPDATE incident_responders SET added_at = DATE_SUB(added_at, INTERVAL ? HOUR) WHERE incident_id = ? AND added_at IS NOT NULL', [hours, id]);
}
const accessRow = async (id, userId) => {
  const [[r]] = await pool.query("SELECT detail FROM audit_log WHERE entity = 'incidents' AND entity_id = ? AND user_id = ? AND action = 'view' ORDER BY id DESC LIMIT 1", [id, userId]);
  return r ? (typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail) : null;
};
const wall = (minutesAgo) => PX.wallClock(new Date(Date.now() - minutesAgo * 60_000), 'America/New_York');
const onDuty = (staff, fromMin, toMin = null) => pool.query('INSERT INTO patrol_duty (tenant_id, staff_id, on_date, signed_in_at, signed_out_at, source) VALUES (?, ?, ?, ?, ?, ?)', [M.id, staff, today, wall(fromMin), toMin === null ? null : wall(toMin), 'phone']);
const offDuty = (staff) => pool.query('UPDATE patrol_duty SET signed_out_at = ? WHERE tenant_id = ? AND staff_id = ? AND signed_out_at IS NULL', [wall(0), M.id, staff]);

test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => { server.on('listening', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const slug = `pa-${suffix}`;
  const r = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Access Peak', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(r.status, 201);
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
  M = { slug, id: t.id };
  M.owner = (await (await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-device': DEVICE }, body: JSON.stringify({ tenant: slug, login: `owner@${slug}.test`, password: PW }) })).json()).token;
  ok(await stepUp(M.owner));
  for (const k of ['Pat', 'Pia', 'Pete', 'Paz']) await person(k, { level: 'patrol' });
  await person('Dir', { level: 'admin' });
  await person('Ada', { level: 'admin' }); // a second roster Admin
  await person('Pmgr', { level: 'manager' });
  await person('Appr', { level: 'approver' });
  await person('Cal', { role: 'counter' });
  // A manager with a staff record of their own (for "make myself Admin"), and one without.
  await person('Mgr', { role: 'manager' });
  const mgr2 = ok(await api('POST', '/users', { token: M.owner, body: { email: `mona@${M.slug}.test`, password: PW, role: 'manager' } }));
  U.Mona = { id: mgr2.id, login: `mona@${M.slug}.test`, token: await tokenOf(`mona@${M.slug}.test`) };
});
test.after(async () => { await new Promise((r) => server.close(r)); stub.close(); await pool.end(); });

// ================================================================ Remember me (L1)
test('Remember me is issued only on an own device, never on a shared terminal and never for patient-record logins', async () => {
  const owner = `owner@${M.slug}.test`;
  const remembered = async (out) => Number((await pool.query('SELECT remember FROM user_sessions WHERE id_hash = ?', [sidHash(out.token)]))[0][0].remember);
  let out = ok(await login(owner, PW, { remember: true }));
  assert.equal(out.remember, false); assert.equal(out.remember_refused, 'not_own_device'); assert.equal(await remembered(out), 0);
  out = ok(await login(owner, PW, { remember: true, own_device: true }));
  assert.equal(out.remember, true); assert.equal(await remembered(out), 1, 'an owner on their own device');
  // No device id: a code is emailed first (a new device); finishing it still gives no remembered session.
  const half = ok(await login(owner, PW, { remember: true, own_device: true }, null));
  assert.equal(half.methods.email, true);
  await settle();
  const code = /(\d{6})/.exec(mails.filter((m) => m.To === owner && /sign-in code/.test(m.Subject)).at(-1).Subject)[1];
  out = ok(await api('POST', '/auth/mfa', { body: { mfa_token: half.mfa_token, code }, device: null }));
  assert.equal(out.remember, false); assert.equal(out.remember_refused, 'no_device_id');
  const term = ok(await api('POST', '/terminals', { token: M.owner, body: { name: 'Front desk' } }));
  out = ok(await login(owner, PW, { remember: true, own_device: true, terminal: term.secret }));
  assert.equal(out.remember, false); assert.equal(out.remember_refused, 'shared_terminal');
  out = ok(await login(U.Pat.login, PW, { remember: true, own_device: true }));
  assert.equal(out.remember, false); assert.equal(out.remember_refused, 'patient_records', 'never for patrol');
  // A counter login whose person is on the patrol roster (as Host) can open Patrol: no Remember me either.
  const cal = await person('Cass', { role: 'counter' });
  ok(await api('POST', '/patrol/team', { token: M.owner, body: { staff_id: cal.staff, access_level: 'host' } }));
  assert.equal(ok(await login(cal.login, PW, { remember: true, own_device: true })).remember, false);
  ok(await api('POST', '/auth/logout', { token: out.token }));
});

// ================================================================ the fresh-check rule (588.2, M4)
test('own drafts open at any age; anyone else, and older own work, needs the records check, which sign-in and an ordinary check never are', async () => {
  const id = await newCase(U.Pat.token);
  ok(await api('GET', `/patrol/incidents/${id}`, { token: U.Pat.token }));
  assert.equal((await accessRow(id, U.Pat.id)).access, 'writing');
  await age(id, 72);
  ok(await api('GET', `/patrol/incidents/${id}`, { token: U.Pat.token }), 'a draft I started, three days on');
  asks(await api('GET', `/patrol/incidents/${id}`, { token: U.Pia.token }), 'someone else');
  ok(await stepUp(U.Pia.token));
  asks(await api('GET', `/patrol/incidents/${id}`, { token: U.Pia.token }), 'an ordinary second check is not the records check');
  asks(await api('GET', `/patrol/incidents/${id}`, { token: await tokenOf(U.Pia.login) }), 'a fresh sign-in is not the records check');
  ok(await records(U.Pia.token));
  ok(await api('GET', `/patrol/incidents/${id}`, { token: U.Pia.token }));
  assert.deepEqual(await accessRow(id, U.Pia.id), { access: 'checked', fresh: true });
  // One check lasts 30 minutes.
  await pool.query('UPDATE user_sessions SET records_checked_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 31 MINUTE) WHERE id_hash = ?', [sidHash(U.Pia.token)]);
  asks(await api('GET', `/patrol/incidents/${id}`, { token: U.Pia.token }), 'after 30 minutes');
  // The records check does not stand in for the second check on exports, and the reverse.
  await pool.query('UPDATE user_sessions SET stepped_up_at = NULL WHERE id_hash = ?', [sidHash(U.Dir.token)]);
  ok(await records(U.Dir.token));
  is(await api('GET', '/patrol/incidents.csv', { token: U.Dir.token }), 403, 'export still asks its own check');
  // Owners and managers follow the same rule.
  asks(await api('GET', `/patrol/incidents/${id}`, { token: U.Mona.token }), 'a manager');
  // Own work that is no longer a draft, started over 12 hours ago, needs the check.
  const done = await newCase(U.Pat.token);
  await pool.query("UPDATE incidents SET report_state = 'approved' WHERE id = ?", [done]);
  ok(await api('GET', `/patrol/incidents/${done}`, { token: U.Pat.token }));
  assert.equal((await accessRow(done, U.Pat.id)).access, 'wrote');
  await age(done, 13);
  asks(await api('GET', `/patrol/incidents/${done}`, { token: U.Pat.token }), 'my own approved case, 13 hours on');
  // Submitted by me, started by someone else, in the last 12 hours.
  const sub = await newCase(M.owner);
  await pool.query("UPDATE incidents SET report_state = 'submitted', submitted_by = ? WHERE id = ?", [U.Paz.id, sub]);
  ok(await api('GET', `/patrol/incidents/${sub}`, { token: U.Paz.token }));
  assert.equal((await accessRow(sub, U.Paz.id)).access, 'wrote');
});

test('a password records check is counted per login: wrong ones lock like sign-in', async () => {
  const p = await person('Wren', { level: 'patrol' });
  const n = Number(process.env.LOGIN_LOCK_AFTER || 10);
  for (let i = 0; i < n; i += 1) is(await records(p.token, 'not-the-password-123'), 403);
  is(await records(p.token), 429, 'locked');
});

// ================================================================ exceptions and their limits (588.2, M2)
test('responder, sent to the call, on duty and crew open a case started in the last 12 hours, and not after', async () => {
  const id = await newCase(M.owner);
  asks(await api('GET', `/patrol/incidents/${id}`, { token: U.Pia.token }));
  ok(await api('POST', `/patrol/incidents/${id}/responders`, { token: M.owner, body: { staff_id: U.Pia.staff, role: 'assist' } }));
  ok(await api('GET', `/patrol/incidents/${id}`, { token: U.Pia.token }));
  assert.equal((await accessRow(id, U.Pia.id)).access, 'responder');
  // Sent to the call that became the case.
  const call = ok(await api('POST', '/patrol/dispatch', { token: M.owner, body: { location: 'Lift 2 top' } }));
  await pool.query('UPDATE dispatch_calls SET incident_id = ? WHERE id = ?', [id, call.id]);
  ok(await api('POST', `/patrol/dispatch/${call.id}/responders`, { token: M.owner, body: { staff_id: U.Pete.staff } }));
  ok(await api('GET', `/patrol/incidents/${id}`, { token: U.Pete.token }));
  assert.equal((await accessRow(id, U.Pete.id)).access, 'dispatched');
  // On duty when the case was started (the row began before it and had not ended).
  await onDuty(U.Paz.staff, 60);
  const later = await newCase(M.owner);
  ok(await api('GET', `/patrol/incidents/${later}`, { token: U.Paz.token }));
  assert.equal((await accessRow(later, U.Paz.id)).access, 'on_duty');
  // Signing in on duty after the case started does not count; nor does a row that ended before it.
  await onDuty(U.Pat.staff, 120, 90);
  asks(await api('GET', `/patrol/incidents/${later}`, { token: U.Pat.token }), 'a shift that ended before the case');
  await onDuty(U.Pat.staff, -1);
  asks(await api('GET', `/patrol/incidents/${later}`, { token: U.Pat.token }), 'signed in after the case started');
  // Crew: on duty, and an active crew shares a responder. An inactive crew does not count (it is plain on duty then).
  const [crew] = await pool.query("INSERT INTO patrol_crews (tenant_id, name, days, start_time, end_time, target, minimum, active) VALUES (?, 'A crew', '1234567', '08:00', '16:00', 4, 2, 1)", [M.id]);
  for (const s of [U.Paz.staff, U.Pia.staff]) await pool.query('INSERT INTO patrol_crew_members (tenant_id, crew_id, staff_id) VALUES (?, ?, ?)', [M.id, crew.insertId, s]);
  const crewCase = await newCase(M.owner);
  ok(await api('POST', `/patrol/incidents/${crewCase}/responders`, { token: M.owner, body: { staff_id: U.Pia.staff, role: 'assist' } }));
  ok(await api('GET', `/patrol/incidents/${crewCase}`, { token: U.Paz.token }));
  assert.equal((await accessRow(crewCase, U.Paz.id)).access, 'crew');
  await pool.query('UPDATE patrol_crews SET active = 0 WHERE id = ?', [crew.insertId]);
  ok(await api('GET', `/patrol/incidents/${crewCase}`, { token: U.Paz.token }));
  assert.equal((await accessRow(crewCase, U.Paz.id)).access, 'on_duty', 'an inactive crew does not count');
  await offDuty(U.Paz.staff); await offDuty(U.Pat.staff);
  // Past 12 hours every exception ends.
  await age(id, 13);
  asks(await api('GET', `/patrol/incidents/${id}`, { token: U.Pia.token }), 'responder, 13 hours on');
  asks(await api('GET', `/patrol/incidents/${id}`, { token: U.Pete.token }), 'dispatched, 13 hours on');
});

test('M2: adding yourself later, or a buddy adding you, does not open a case; adding yourself at the scene does', async () => {
  // At the scene: within 30 minutes of the case starting.
  const fresh = await newCase(M.owner);
  ok(await api('POST', `/patrol/incidents/${fresh}/responders/me`, { token: U.Pia.token, body: { role: 'assist' } }));
  ok(await api('GET', `/patrol/incidents/${fresh}`, { token: U.Pia.token }));
  assert.equal((await accessRow(fresh, U.Pia.id)).access, 'responder_self');
  // Two hours on: the add goes through (no check under 12 hours), but it does not open the case.
  const old = await newCase(M.owner);
  await age(old, 2);
  ok(await api('POST', `/patrol/incidents/${old}/responders/me`, { token: U.Pete.token, body: { role: 'assist' } }));
  asks(await api('GET', `/patrol/incidents/${old}`, { token: U.Pete.token }), 'a late self-add');
  // Pete (checked) adds his buddy Paz: Pete's own link is a late self-add, so Paz's does not count either.
  ok(await records(U.Pete.token));
  ok(await api('POST', `/patrol/incidents/${old}/responders`, { token: U.Pete.token, body: { staff_id: U.Paz.staff, role: 'assist' } }));
  asks(await api('GET', `/patrol/incidents/${old}`, { token: U.Paz.token }), 'added later by someone not tied to the case');
  // ...and Paz adding Pete back changes nothing (the first add is kept).
  ok(await records(U.Paz.token));
  ok(await api('POST', `/patrol/incidents/${old}/responders`, { token: U.Paz.token, body: { staff_id: U.Pete.staff, role: 'assist' } }));
  const pete2 = await tokenOf(U.Pete.login);
  asks(await api('GET', `/patrol/incidents/${old}`, { token: pete2 }), 'two patrollers adding each other');
  // Added later by someone tied to the case (an approver) counts.
  ok(await records(U.Appr.token));
  ok(await api('POST', `/patrol/incidents/${old}/responders`, { token: U.Appr.token, body: { staff_id: U.Pat.staff, role: 'assist' } }));
  ok(await api('GET', `/patrol/incidents/${old}`, { token: U.Pat.token }));
  // A dispatch link the person made for themselves late does not count.
  const call = ok(await api('POST', '/patrol/dispatch', { token: M.owner, body: { location: 'Glades' } }));
  await pool.query('UPDATE dispatch_calls SET incident_id = ?, received_at = DATE_SUB(received_at, INTERVAL 2 HOUR) WHERE id = ?', [old, call.id]);
  const wren = await person('Wade', { level: 'patrol' });
  ok(await api('POST', `/patrol/dispatch/${call.id}/responders`, { token: wren.token, body: { staff_id: wren.staff } }));
  asks(await api('GET', `/patrol/incidents/${old}`, { token: wren.token }), 'a late dispatch self-add');
  // A row from before the upgrade (added_by 0) counts; one with no adder recorded does not.
  await pool.query('UPDATE incident_responders SET added_by = 0 WHERE incident_id = ? AND staff_id = ?', [old, U.Pete.staff]);
  ok(await api('GET', `/patrol/incidents/${old}`, { token: await tokenOf(U.Pete.login) }));
  await pool.query('UPDATE incident_responders SET added_by = NULL WHERE incident_id = ? AND staff_id = ?', [old, U.Pete.staff]);
  asks(await api('GET', `/patrol/incidents/${old}`, { token: await tokenOf(U.Pete.login) }), 'no adder recorded never counts');
});

test('N2: the database step marks responder and dispatch rows from before the upgrade as added by someone else, at their case time', async () => {
  const id = await newCase(M.owner);
  await pool.query('INSERT INTO incident_responders (tenant_id, incident_id, staff_id, role) VALUES (?, ?, ?, ?)', [M.id, id, U.Paz.staff, 'assist']);
  const steps = require('../db/steps/auth-hardening')({ tableExists: async () => true, columnExists: async () => true });
  const [, , ddl] = steps.find((s) => s[0] === 'incident_responders.added_by');
  await pool.query(ddl[1]);
  const [[r]] = await pool.query('SELECT r.added_by, r.added_at = i.created_at AS same FROM incident_responders r JOIN incidents i ON i.id = r.incident_id WHERE r.incident_id = ? AND r.staff_id = ?', [id, U.Paz.staff]);
  assert.equal(Number(r.added_by), 0); assert.equal(Number(r.same), 1);
  ok(await api('GET', `/patrol/incidents/${id}`, { token: U.Paz.token }));
  const [, , dd] = steps.find((s) => s[0] === 'dispatch_responders.added_by');
  assert.match(dd[1], /SET r\.added_by = 0, r\.added_at = c\.received_at WHERE r\.added_by IS NULL/);
});

// ================================================================ H1: the reporter field
test('H1: who wrote the report never opens a case, and only an approver or someone on the case may change it', async () => {
  const id = await newCase(M.owner);
  await age(id, 72);
  asks(await api('PATCH', `/patrol/incidents/${id}`, { token: U.Pia.token, body: { reported_by_staff: U.Pia.staff } }), 'the original walk-around');
  ok(await records(U.Pia.token));
  is(await api('PATCH', `/patrol/incidents/${id}`, { token: U.Pia.token, body: { reported_by_staff: U.Pia.staff } }), 403, 'checked, but not tied to the case');
  ok(await records(U.Appr.token));
  ok(await api('PATCH', `/patrol/incidents/${id}`, { token: U.Appr.token, body: { reported_by_staff: U.Pia.staff } }));
  const [[a]] = await pool.query("SELECT detail FROM audit_log WHERE entity = 'incidents' AND entity_id = ? AND action = 'reporter_change'", [id]);
  const d = typeof a.detail === 'string' ? JSON.parse(a.detail) : a.detail;
  assert.equal(d.from_staff, null); assert.equal(d.to_staff, U.Pia.staff);
  asks(await api('GET', `/patrol/incidents/${id}`, { token: await tokenOf(U.Pia.login) }), 'named as the reporter, still asked');
});

// ================================================================ every read and write path (L2, L5, the route table)
test('every patient-data read and write on another person\'s older case needs the check; after it, they work', async () => {
  const id = await newCase(M.owner);
  const pid = ok(await api('POST', `/patrol/incidents/${id}/patients`, { token: M.owner, body: { first_name: 'Zelda', last_name: 'Quill', chief_complaint: 'seizure' } })).id;
  await age(id, 30);
  const t = await tokenOf(U.Pete.login);
  const paths = [
    ['GET', ''], ['GET', '/check'], ['GET', '/versions/1'], ['GET', '/signatures/1'], ['GET', '/photos'], ['GET', '/photos/1/preview'], ['GET', '/photos/1/original'],
    ['GET', '/scene'], ['GET', '/witness-links'], ['GET', '/claim-file'], ['GET', '/doc-score'], ['GET', '/shares'], ['GET', '/records'], ['GET', '/search'], ['GET', '/kit-use'],
    ['POST', '/story-fill', {}], ['PATCH', '', { location: 'Changed' }], ['PATCH', `/patients/${pid}`, { first_name: 'Changed' }], ['POST', '/notes', { body: 'A note' }],
    ['PUT', '/collision', {}], ['POST', '/responders', { staff_id: U.Pete.staff, role: 'assist' }], ['POST', `/patients/${pid}/handoff-printed`, {}],
  ];
  for (const [m, p, body] of paths) asks(await api(m, `/patrol/incidents/${id}${p}`, { token: t, body }), `${m} ${p || '/'}`);
  asks(await api('GET', '/patrol/incidents?q=Zelda', { token: t }), 'a search can find a patient by name');
  ok(await records(t));
  const c = ok(await api('GET', `/patrol/incidents/${id}`, { token: t }));
  assert.equal(c.patients[0].first_name, 'Zelda');
  ok(await api('PATCH', `/patrol/incidents/${id}`, { token: t, body: { location: 'Upper Ridge, left' } }));
  assert.ok(ok(await api('GET', '/patrol/incidents?q=Zelda', { token: t })).data.some((r) => r.id === id));
  const [[u]] = await pool.query('SELECT first_name FROM incident_patients WHERE id = ?', [pid]);
  assert.equal(u.first_name, 'Zelda', 'nothing changed before the check');
});

test('the ski area login makes the check before opening an approved report', async () => {
  const gm = ok(await api('POST', '/users', { token: M.owner, body: { email: `gm@${M.slug}.test`, password: PW, role: 'area' } }));
  const t = await tokenOf(`gm@${M.slug}.test`);
  const id = await newCase(M.owner);
  await pool.query("UPDATE incidents SET report_state = 'approved' WHERE id = ?", [id]);
  await pool.query("INSERT INTO incident_versions (tenant_id, incident_id, version_no, kind, snapshot, created_by) VALUES (?, ?, 1, 'approved', '{}', ?)", [M.id, id, gm.id]);
  asks(await api('GET', `/area/reports/${id}`, { token: t }));
  ok(await records(t));
  ok(await api('GET', `/area/reports/${id}`, { token: t }));
});

// ================================================================ N1 and non-digit ids
test('N1: no spelling of the address skips the check (capitals, %-escapes, a trailing slash, other id forms)', async () => {
  const id = await newCase(M.owner);
  const pid = ok(await api('POST', `/patrol/incidents/${id}/patients`, { token: M.owner, body: { first_name: 'Una', last_name: 'Spell' } })).id;
  await age(id, 30);
  const t = await tokenOf(U.Paz.login);
  asks(await raw('PATCH', `/api/v1/patrol/INCIDENTS/${id}`, { token: t, body: { location: 'X' } }), 'capitals');
  asks(await raw('PATCH', `/api/v1/patrol/Incidents/${id}/patients/${pid}`, { token: t, body: { first_name: 'X' } }), 'mixed case');
  asks(await raw('GET', `/api/v1/patrol/INCIDENTS/${id}/kit-use`, { token: t }), 'kit use');
  asks(await raw('POST', `/api/v1/patrol/Incidents/${id}/story-fill`, { token: t, body: {} }), 'story fill');
  asks(await raw('GET', `/api/v1/patrol/incidents/${id}/`, { token: t }), 'a trailing slash');
  const esc = `%3${String(id)[0]}${String(id).slice(1)}`;
  is(await raw('PATCH', `/api/v1/patrol/incidents/${esc}`, { token: t, body: { location: 'X' } }), 404, 'a %-escaped digit');
  is(await raw('GET', `/api/v1/%70atrol/incidents/${id}`, { token: t }), 404, 'a %-escaped letter');
  assert.notEqual((await raw('GET', `/api/v1/patrol//incidents/${id}`, { token: t })).status, 200, 'double slashes');
  for (const form of [`${id}.0`, `${id}e0`, `0x${id.toString(16)}`, `%2B${id}`, `%20${id}`, `0${id}`, `-${id}`, `${id}%00`, '1'.repeat(21)]) {
    for (const [m, p, body] of [['PATCH', '', { location: 'X' }], ['PATCH', `/patients/${pid}`, { first_name: 'X' }], ['POST', '/notes', { body: 'x' }], ['GET', '/kit-use'], ['POST', '/story-fill', {}], ['POST', '/responders/me', { role: 'assist' }], ['PUT', '/collision', {}]]) {
      const r = await raw(m, `/api/v1/patrol/incidents/${form}${p}`, { token: t, body });
      assert.ok([400, 404].includes(r.status), `${m} ${form}${p}: ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    }
  }
  is(await raw('HEAD', `/api/v1/patrol/incidents/${id}.0`, { token: t }), 400, 'HEAD too');
  const [[c]] = await pool.query('SELECT location FROM incidents WHERE id = ?', [id]);
  assert.equal(c.location, 'Upper Ridge', 'the case is untouched');
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM incident_responders WHERE incident_id = ?', [id]))[0][0].n, 0, 'nobody added themselves');
});

test('N1: the other checks that read the address hold for any spelling (an app turned off, someone taken off the roster)', async () => {
  const modules = require('../src/lib/modules');
  await pool.query("INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, 'park', 0) ON DUPLICATE KEY UPDATE enabled = 0", [M.id]);
  modules.invalidate(M.id);
  for (const p of ['/api/v1/park/features', '/api/v1/PARK/features', '/api/v1/Park/features/']) assert.ok([403, 404].includes((await raw('GET', p, { token: M.owner })).status), p);
  await pool.query("UPDATE tenant_modules SET enabled = 1 WHERE tenant_id = ? AND module = 'park'", [M.id]);
  modules.invalidate(M.id);
  const gone = await person('Gone', { level: 'patrol' });
  ok(await api('DELETE', `/patrol/team/${gone.staff}`, { token: M.owner }));
  for (const p of ['/api/v1/patrol/home', '/api/v1/PATROL/home', '/api/v1/Patrol/home/']) is(await raw('GET', p, { token: gone.token }), 403, p);
});

// ================================================================ M3: summaries on unchecked lists
test('M3: lists, home, the day log, map pins and the review queue hide summaries of cases the person may not open unchecked', async () => {
  const secret = 'seizure, epileptic, on Keppra';
  const id = await newCase(M.owner, { summary: secret });
  await pool.query('UPDATE incidents SET gps_lat = 44.1, gps_lng = -71.2 WHERE id = ?', [id]);
  await age(id, 20);
  const mine = await newCase(U.Pete.token, { summary: 'My own sprain' });
  const t = await tokenOf(U.Pete.login);
  const leak = (x) => JSON.stringify(x).includes('Keppra');
  const list = ok(await api('GET', '/patrol/incidents', { token: t }));
  const row = list.data.find((r) => r.id === id);
  assert.equal(row.summary, null); assert.equal(row.summary_hidden, true);
  assert.equal(list.data.find((r) => r.id === mine).summary, 'My own sprain', 'own recent work shows');
  assert.ok(!leak(list), 'case list');
  assert.ok(!leak(ok(await api('GET', '/patrol/home', { token: t }))), 'patrol home');
  assert.ok(!leak(ok(await api('GET', `/patrol/daily-log?date=${today}`, { token: t }))), 'day log');
  assert.ok(!leak(ok(await api('GET', '/patrol/map-pins', { token: t }))), 'map pins');
  ok(await records(t));
  assert.ok(leak(ok(await api('GET', '/patrol/incidents', { token: t }))), 'after the check the summary shows');
  // The review queue: an approver sees summaries after one check for the sitting.
  await pool.query("UPDATE incidents SET report_state = 'submitted', submitted_by = ?, submitted_at = UTC_TIMESTAMP() WHERE id = ?", [M.id === 0 ? 0 : U.Pat.id, id]);
  const appr = await tokenOf(U.Appr.login);
  const q = ok(await api('GET', '/patrol/review/queue', { token: appr }));
  assert.ok(q.data.some((r) => r.id === id && r.summary === null && r.summary_hidden), 'hidden before the check');
  ok(await records(appr));
  assert.ok(ok(await api('GET', '/patrol/review/queue', { token: appr })).data.some((r) => r.id === id && r.summary === secret));
});

// ================================================================ quick resume (588.3)
test('quick resume: after 30 minutes a leader resumes with an app code, never past 8 hours, after signing out or a password change', async () => {
  const p = await person('Rex', { level: 'patrol' });
  ok(await stepUp(p.token));
  const { secret } = ok(await api('POST', '/auth/mfa/setup', { token: p.token }));
  ok(await api('POST', '/auth/mfa/enable', { token: p.token, body: { code: codeNow(secret) } }));
  const signIn = async () => ok(await api('POST', '/auth/mfa', { body: { mfa_token: ok(await login(p.login)).mfa_token, code: await freshCode(p.id, secret) } })).token;
  let t = await signIn();
  const h = sidHash(t);
  const [[before]] = await pool.query('SELECT expires_at, idle_min FROM user_sessions WHERE id_hash = ?', [h]);
  assert.equal(Number(before.idle_min), 30);
  await pool.query('UPDATE user_sessions SET last_seen = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 31 MINUTE) WHERE id_hash = ?', [h]);
  const paused = await api('GET', '/auth/me', { token: t });
  is(paused, 401); assert.equal(paused.body.details.code, 'resume');
  assert.deepEqual(ok(await api('POST', '/auth/resume/options', { token: t })).methods, ['app']);
  // Wrong codes are counted per login.
  for (let i = 0; i < 5; i += 1) is(await api('POST', '/auth/resume', { token: t, body: { code: '000000' === codeNow(secret) ? '111111' : '000000' } }), 403);
  is(await api('POST', '/auth/resume', { token: t, body: { code: await freshCode(p.id, secret) } }), 429);
  await pool.query('UPDATE users SET mfa_locked_until = NULL, mfa_failures = 0 WHERE id = ?', [p.id]);
  ok(await api('POST', '/auth/resume', { token: t, body: { code: await freshCode(p.id, secret) } }));
  ok(await api('GET', '/auth/me', { token: t }));
  const [[after]] = await pool.query('SELECT expires_at FROM user_sessions WHERE id_hash = ?', [h]);
  assert.equal(String(after.expires_at), String(before.expires_at), 'the 8-hour end never moves');
  // The tab lock pauses it on the server too.
  assert.equal(ok(await api('POST', '/auth/lock', { token: t })).locked, true);
  assert.equal((await api('GET', '/auth/me', { token: t })).body.details.code, 'resume');
  ok(await api('POST', '/auth/resume', { token: t, body: { code: await freshCode(p.id, secret) } }));
  // Past 8 hours: no resume.
  await pool.query('UPDATE user_sessions SET expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE id_hash = ?', [h]);
  is(await api('POST', '/auth/resume', { token: t, body: { code: await freshCode(p.id, secret) } }), 401, 'past 8 hours');
  assert.notEqual((await api('GET', '/auth/me', { token: t })).body.details?.code, 'resume');
  // Signed out: no resume.
  t = await signIn();
  await pool.query('UPDATE user_sessions SET locked_at = UTC_TIMESTAMP() WHERE id_hash = ?', [sidHash(t)]);
  is(await api('POST', '/auth/logout', { token: t }), 204, 'signing out works from the paused screen');
  is(await api('POST', '/auth/resume', { token: t, body: { code: await freshCode(p.id, secret) } }), 401, 'after signing out');
  // A password change ends every session, paused ones too.
  t = await signIn();
  await pool.query('UPDATE user_sessions SET locked_at = UTC_TIMESTAMP() WHERE id_hash = ?', [sidHash(t)]);
  const other = await signIn();
  ok(await api('POST', '/auth/change-password', { token: other, body: { current_password: PW, new_password: 'rex-a-new-password-42' } }));
  is(await api('POST', '/auth/resume', { token: t, body: { code: await freshCode(p.id, secret) } }), 401, 'after a password change');
  is(await api('POST', '/auth/resume', { body: { code: '123456' } }), 401, 'never without the session token');
});

test('quick resume is for patrol and leaders with a passkey or app; others keep 60 minutes and sign in again', async () => {
  // A counter login: 60 minutes, no resume.
  const t = await tokenOf(U.Cal.login);
  await pool.query('UPDATE user_sessions SET last_seen = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 40 MINUTE) WHERE id_hash = ?', [sidHash(t)]);
  ok(await api('GET', '/auth/me', { token: t }));
  await pool.query('UPDATE user_sessions SET last_seen = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 61 MINUTE) WHERE id_hash = ?', [sidHash(t)]);
  const r = await api('GET', '/auth/me', { token: t }); is(r, 401); assert.notEqual(r.body.details?.code, 'resume');
  // A patroller with neither passkey nor app: 30 minutes, then a full sign-in.
  const p = await tokenOf(U.Pia.login);
  await pool.query('UPDATE user_sessions SET last_seen = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 31 MINUTE) WHERE id_hash = ?', [sidHash(p)]);
  const r2 = await api('GET', '/auth/me', { token: p }); is(r2, 401); assert.notEqual(r2.body.details?.code, 'resume');
  is(await api('POST', '/auth/resume', { token: p, body: { code: '123456' } }), 401);
  // The tab lock ends a session that cannot be resumed.
  const c = await tokenOf(U.Cal.login);
  assert.equal(ok(await api('POST', '/auth/lock', { token: c })).locked, false);
  is(await api('GET', '/auth/me', { token: c }), 401);
});

// ================================================================ passkeys for leaders (588.4)
test('leaders are asked for two passkeys after signing in, patrollers once; the logins list shows each one\'s count', async () => {
  const me = async (t) => ok(await api('GET', '/auth/me', { token: t })).passkey_prompt;
  assert.deepEqual(await me(M.owner), { kind: 'leader', have: 0, want: 2 });
  assert.deepEqual(await me(await tokenOf(U.Dir.login)), { kind: 'leader', have: 0, want: 2 });
  assert.deepEqual(await me(await tokenOf(U.Mona.login)), { kind: 'leader', have: 0, want: 2 });
  const pt = await tokenOf(U.Pat.login);
  assert.deepEqual(await me(pt), { kind: 'once', have: 0, want: 1 });
  is(await api('POST', '/auth/passkey-prompt/seen', { token: pt }), 204);
  assert.equal(await me(await tokenOf(U.Pat.login)), null, 'offered once');
  assert.equal(await me(await tokenOf(U.Cal.login)), null, 'not for counter staff');
  // One passkey: still asked for the second.
  await pool.query("INSERT INTO user_passkeys (tenant_id, user_id, credential_id, public_key, sign_count, name, created_at) VALUES (?, ?, ?, ?, 0, 'Phone', UTC_TIMESTAMP())", [M.id, U.Dir.id, `cred-${suffix}`, Buffer.from('x')]);
  const dt = await tokenOf(U.Dir.login).catch(() => null);
  if (dt) assert.deepEqual(await me(dt), { kind: 'leader', have: 1, want: 2 });
  const list = ok(await api('GET', '/users', { token: M.owner })).data;
  const dir = list.find((u) => u.id === U.Dir.id);
  assert.equal(Number(dir.passkeys), 1); assert.equal(dir.patrol_level, 'admin');
  await pool.query('DELETE FROM user_passkeys WHERE user_id = ?', [U.Dir.id]);
});

// ================================================================ reset rules by role (588.5, M1)
test('who may reset whom: managers not managers or patrol leaders; patrol leaders by the owner or a patrol Admin; a patrol Admin resets patrol logins only', async () => {
  const mona = await tokenOf(U.Mona.login); ok(await stepUp(mona));
  const refused = async (r, why) => { is(r, 403, why); assert.equal(r.body.details && r.body.details.code, 'reset_refused', why); };
  const body = { new_password: PW, temporary: false }; // the same password, so later tests still sign in
  await refused(await api('POST', `/users/${U.Dir.id}/reset-password`, { token: mona, body }), 'manager resets the patrol director');
  await refused(await api('POST', `/users/${U.Pmgr.id}/reset-mfa`, { token: mona }), 'manager resets a patrol Manager');
  await refused(await api('POST', `/users/${U.Mgr.id}/reset-password`, { token: mona, body }), 'manager resets a manager');
  ok(await api('POST', `/users/${U.Pat.id}/reset-password`, { token: mona, body }));
  // A roster Admin (a patrol login) resets patrol logins and other patrol leaders, nothing else.
  const ada = await tokenOf(U.Ada.login); ok(await stepUp(ada));
  ok(await api('POST', `/users/${U.Paz.id}/reset-password`, { token: ada, body }));
  ok(await api('POST', `/users/${U.Pmgr.id}/reset-password`, { token: ada, body }));
  await refused(await api('POST', `/users/${U.Cal.id}/reset-password`, { token: ada, body }), 'a patrol Admin resets a counter login');
  // M1: even after putting the counter login on the roster.
  ok(await api('POST', '/patrol/team', { token: ada, body: { staff_id: U.Cal.staff, access_level: 'patrol' } }));
  await refused(await api('POST', `/users/${U.Cal.id}/reset-password`, { token: ada, body }), 'roster membership does not make it a patrol login');
  ok(await api('DELETE', `/patrol/team/${U.Cal.staff}`, { token: ada }));
  // Line patrollers reset nobody.
  is(await api('POST', `/users/${U.Paz.id}/reset-password`, { token: await tokenOf(U.Pete.login), body }), 403);
  // The owner may.
  ok(await api('POST', `/users/${U.Dir.id}/reset-mfa`, { token: M.owner }));
  await settle();
  assert.ok(mails.some((m) => m.To === U.Dir.login && /Two-step sign-in was reset/.test(m.Subject)), 'the person is emailed');
  U.Dir.token = await tokenOf(U.Dir.login); U.Pat.token = await tokenOf(U.Pat.login); U.Paz.token = await tokenOf(U.Paz.login); U.Pmgr.token = await tokenOf(U.Pmgr.login);
});

test('M1: a counter login put on the roster by a manager joins as Host, and only the owner or a patrol Admin raises it', async () => {
  const s = await person('Lou', { role: 'counter' });
  const mona = await tokenOf(U.Mona.login);
  is(await api('POST', '/patrol/team', { token: mona, body: { staff_id: s.staff, access_level: 'patrol' } }), 403, 'more than Host');
  assert.equal(ok(await api('POST', '/patrol/team', { token: mona, body: { staff_id: s.staff } })).access_level, 'host');
  is(await api('GET', '/patrol/incidents', { token: s.token }), 403, 'Host sees no cases');
  is(await api('PATCH', `/patrol/team/${s.staff}`, { token: mona, body: { access_level: 'patrol' } }), 403, 'raising it needs a patrol Admin');
  ok(await api('PATCH', `/patrol/team/${s.staff}`, { token: U.Dir.token, body: { access_level: 'patrol' } }));
});

test('H2: nobody can lower a patrol leader and reset them; a lowered login waits 24 hours, and never for the one who lowered it', async () => {
  const mona = await tokenOf(U.Mona.login); ok(await stepUp(mona));
  const body = { new_password: PW, temporary: false }; // the same password, so later tests still sign in
  // A manager cannot lower or remove a director, by any route.
  is(await api('PUT', `/patrol/team/${U.Dir.staff}/access`, { token: mona, body: { access_level: 'patrol' } }), 403, 'demote');
  is(await api('PATCH', `/patrol/team/${U.Dir.staff}`, { token: mona, body: { access_level: 'patrol' } }), 403, 'demote by edit');
  is(await api('PATCH', `/patrol/team/${U.Dir.staff}`, { token: mona, body: { level: 'patroller' } }), 403, 'demote by rank');
  is(await api('DELETE', `/patrol/team/${U.Dir.staff}`, { token: mona }), 403, 'remove from the roster');
  for (const b of [{ staff_id: null }, { staff_id: U.Paz.staff }, { email: `elsewhere-${suffix}@example.com` }, { active: false }, { role: 'counter' }, { access_ends_on: today }]) {
    const r = await api('PATCH', `/users/${U.Dir.id}`, { token: mona, body: b });
    is(r, 403, `change ${Object.keys(b)[0]} of the director's login`);
  }
  // The owner lowers a patrol Manager: the login is on the record, and a manager's reset waits 24 hours.
  ok(await api('PUT', `/patrol/team/${U.Pmgr.staff}/access`, { token: M.owner, body: { access_level: 'patrol' } }));
  const [[c]] = await pool.query("SELECT kind, from_value, to_value, by_user FROM login_access_changes WHERE tenant_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1", [M.id, U.Pmgr.id]);
  assert.deepEqual({ ...c, by_user: Number(c.by_user) }, { kind: 'lowered', from_value: 'manager', to_value: 'patrol', by_user: Number((await pool.query("SELECT id FROM users WHERE tenant_id = ? AND role = 'owner'", [M.id]))[0][0].id) });
  is(await api('POST', `/users/${U.Pmgr.id}/reset-password`, { token: mona, body }), 403, 'lowered in the last 24 hours');
  await pool.query('UPDATE login_access_changes SET at = DATE_SUB(at, INTERVAL 25 HOUR) WHERE user_id = ?', [U.Pmgr.id]);
  ok(await api('POST', `/users/${U.Pmgr.id}/reset-password`, { token: mona, body }));
  // A roster Admin lowers an approver; they can never reset that login, whatever the time.
  const ada = await tokenOf(U.Ada.login); ok(await stepUp(ada));
  ok(await api('PUT', `/patrol/team/${U.Appr.staff}/access`, { token: ada, body: { access_level: 'patrol' } }));
  await pool.query('UPDATE login_access_changes SET at = DATE_SUB(at, INTERVAL 30 DAY) WHERE user_id = ?', [U.Appr.id]);
  is(await api('POST', `/users/${U.Appr.id}/reset-password`, { token: ada, body }), 403, 'the person who lowered it');
  ok(await api('PUT', `/patrol/team/${U.Appr.staff}/access`, { token: M.owner, body: { access_level: 'approver' } }));
  // The owner unlinks a director's staff record: recorded as a lowering, so a manager cannot reset it.
  const z = await person('Zoe', { level: 'admin' });
  ok(await api('PATCH', `/users/${z.id}`, { token: M.owner, body: { staff_id: null } }));
  assert.ok((await pool.query("SELECT id FROM login_access_changes WHERE user_id = ? AND kind = 'unlinked'", [z.id]))[0].length);
  is(await api('POST', `/users/${z.id}/reset-password`, { token: mona, body }), 403, 'unlinked in the last 24 hours');
  ok(await api('POST', `/users/${z.id}/reset-password`, { token: M.owner, body }), 'the owner still can');
});

// ================================================================ roster Admin (609)
test('only the owner or a real roster Admin gives Admin or Manager, changes access or the review group; nobody raises their own level', async () => {
  const mgr = await tokenOf(U.Mgr.login); // a manager with a staff record of their own
  is(await api('POST', '/patrol/team', { token: mgr, body: { staff_id: U.Mgr.staff, access_level: 'admin', level: 'director' } }), 403, 'make myself Admin');
  is(await api('POST', '/patrol/team', { token: mgr, body: { staff_id: U.Mgr.staff, level: 'director' } }), 403, 'make myself Admin by rank');
  const k = await person('Kai', { role: 'patrol' });
  is(await api('POST', '/patrol/team', { token: mgr, body: { staff_id: k.staff, access_level: 'manager' } }), 403, 'make someone else Manager');
  is(await api('PUT', `/patrol/team/${U.Paz.staff}/access`, { token: mgr, body: { access_level: 'admin' } }), 403);
  is(await api('PUT', `/patrol/team/${U.Paz.staff}/permissions`, { token: mgr, body: { exceptions: [{ feature: 'view_access_log', allowed: true }] } }), 403, 'per-person permissions');
  is(await api('PUT', '/patrol/access/rules', { token: mgr, body: { rules: [{ level: 'patrol', feature: 'records', allowed: true }] } }), 403, 'level rules');
  is(await api('DELETE', '/patrol/access/rules', { token: mgr }), 403);
  const rs = ok(await api('GET', '/patrol/review/settings', { token: mgr }));
  assert.equal(rs.can_edit_group, false);
  is(await api('PUT', '/patrol/review/settings', { token: mgr, body: { reviewers: [{ user_id: U.Mgr.id, lead: true }], categories: ['injury'], nudge_hours: 72 } }), 403, 'the review group');
  ok(await api('GET', '/patrol/access', { token: mgr }), 'managers still see the screens');
  // A patrol Manager cannot raise themselves.
  const pm = await person('Max', { level: 'manager' });
  is(await api('PATCH', `/patrol/team/${pm.staff}`, { token: pm.token, body: { access_level: 'admin' } }), 403);
  // A roster Admin can; and an Admin grant is recorded and emails the owner.
  mails.length = 0;
  ok(await api('PUT', '/patrol/access/rules', { token: U.Dir.token, body: { rules: [{ level: 'patrol', feature: 'records', allowed: false }] } }));
  ok(await api('POST', '/patrol/team', { token: U.Dir.token, body: { staff_id: k.staff, access_level: 'admin', level: 'director' } }));
  assert.ok((await pool.query("SELECT id FROM login_access_changes WHERE user_id = ? AND kind = 'granted' AND to_value = 'admin'", [k.id]))[0].length);
  await settle();
  assert.ok(mails.some((m) => m.To === `owner@${M.slug}.test` && /patrol Admin level/.test(m.Subject)), 'the owner is told');
  is(await api('DELETE', `/patrol/team/${k.staff}`, { token: mgr }), 403, 'a manager cannot remove an Admin');
  ok(await api('DELETE', `/patrol/team/${k.staff}`, { token: M.owner }));
});

// ================================================================ staff links above Patrol (614)
test('614: no path links a login to a patrol leader\'s record unless the owner or a roster Admin does it, and self-service never does', async () => {
  // A director on the roster with no login yet.
  const staff = ok(await api('POST', '/workforce/staff', { token: M.owner, body: { person: { first_name: 'Nora', last_name: 'Director' }, status: 'active' } })).id;
  ok(await api('POST', '/patrol/team', { token: M.owner, body: { staff_id: staff, access_level: 'admin', level: 'director' } }));
  const [[s]] = await pool.query('SELECT person_id FROM staff WHERE id = ?', [staff]);
  const mona = await tokenOf(U.Mona.login);
  const refused = (r, why) => { is(r, 403, why); assert.equal(r.body.details && r.body.details.code, 'link_refused', why); };
  refused(await api('POST', '/users', { token: mona, body: { username: `nora-a-${suffix}`, password: PW, role: 'patrol', person_id: s.person_id } }), 'the probe: a login for the director\'s person');
  refused(await api('POST', '/users', { token: mona, body: { username: `nora-b-${suffix}`, password: PW, role: 'patrol', staff_id: staff } }), 'a login straight to the staff record');
  refused(await api('PATCH', `/users/${U.Cal.id}`, { token: mona, body: { staff_id: staff } }), 'relinking another login');
  refused(await api('PATCH', `/users/${U.Cal.id}`, { token: mona, body: { staff_id: U.Appr.staff } }), 'an Approver\'s record is above Patrol too');
  // The owner may: recorded as a grant, and the owner is told.
  mails.length = 0;
  const made = ok(await api('POST', '/users', { token: M.owner, body: { username: `nora-${suffix}`, password: PW, role: 'patrol', person_id: s.person_id } }));
  assert.ok((await pool.query("SELECT id FROM login_access_changes WHERE user_id = ? AND kind = 'linked'", [made.id]))[0].length);
  await settle();
  assert.ok(mails.some((m) => m.To === `owner@${M.slug}.test` && /linked/.test(m.Subject)));
  // "Add me as a responder" never links that login to the director's record (self-service).
  const nt = await tokenOf(`nora-${suffix}`);
  const recent = await newCase(M.owner);
  refused(await api('POST', `/patrol/incidents/${recent}/responders/me`, { token: nt, body: { role: 'assist' } }), 'responders/me');
  assert.equal((await pool.query('SELECT staff_id FROM users WHERE id = ?', [made.id]))[0][0].staff_id, null, 'still unlinked');
  // A plain patrol login with no record still gets one of its own there.
  const plain = ok(await api('POST', '/users', { token: mona, body: { username: `plain-${suffix}`, password: PW, role: 'patrol' } }));
  const out = ok(await api('POST', `/patrol/incidents/${recent}/responders/me`, { token: await tokenOf(`plain-${suffix}`), body: { role: 'assist' } }));
  assert.equal(out.linked, true); assert.equal(out.created, true);
  assert.ok(plain.id);
});

// ================================================================ the weekly access summary (588.5, L3)
test('the weekly summary lists opens outside the opener\'s own work, with no patient details, once a week, and only the owner turns it off', async () => {
  const AS = require('../src/lib/accesssummary');
  const id = await newCase(M.owner, { summary: 'Fall, Henrietta Vale, wrist' });
  ok(await api('POST', `/patrol/incidents/${id}/patients`, { token: M.owner, body: { first_name: 'Henrietta', last_name: 'Vale' } }));
  await age(id, 20);
  const t = await tokenOf(U.Paz.login);
  ok(await records(t));
  ok(await api('GET', `/patrol/incidents/${id}`, { token: t }));
  ok(await api('GET', `/patrol/incidents/${id}/photos`, { token: t }));
  ok(await api('GET', `/patrol/incidents/${id}/scene`, { token: t }));
  const own = await newCase(U.Paz.token);
  ok(await api('GET', `/patrol/incidents/${own}`, { token: U.Paz.token }));
  const weekStart = require('../src/lib/weekly').weekStartOf(today);
  const seq = ok(await api('GET', `/patrol/incidents/${id}`, { token: t })).seq;
  const s = await AS.build(M.id, weekStart);
  const line = s.entries.find((e) => e.user_id === U.Paz.id && e.case_number.endsWith(String(seq).padStart(4, '0')));
  assert.ok(line, 'the checked open is listed');
  assert.equal(line.fresh, true); assert.ok(line.how.includes('checked'));
  assert.ok(line.what.includes('case') && line.what.includes('photos') && line.what.includes('scene'), `one line per person and case: ${line.what}`);
  assert.ok(!s.entries.some((e) => e.user_id === U.Paz.id && e.how.every((h) => h === 'wrote')), 'own recent work is not listed');
  assert.ok(s.opened >= 2);
  const m = AS.render(s, { name: 'Access Peak' }, 'https://app.example/#/patrol/access');
  for (const x of ['Henrietta', 'Vale', 'wrist', 'Knee']) assert.ok(!m.text.includes(x), `no patient details: ${x}`);
  assert.match(m.text, /Fresh check: yes/); assert.match(m.text, /#\/patrol\/access/);
  // Sent Monday to the owner and the roster Admins, once.
  const nextMonday = require('../src/lib/util').addDays(weekStart, 7);
  const [[tn]] = await pool.query('SELECT * FROM tenants WHERE id = ?', [M.id]);
  mails.length = 0;
  const sent = await AS.runForTenant(tn, { now: nextMonday, base });
  assert.ok(sent.sent >= 2, JSON.stringify(sent));
  await settle();
  const to = mails.filter((x) => /patient record access/.test(x.Subject)).map((x) => x.To);
  assert.ok(to.includes(`owner@${M.slug}.test`) && to.includes(U.Dir.login), to.join(', '));
  assert.equal((await AS.runForTenant({ ...tn, access_summary_week: null }, { now: nextMonday, base })).skipped, 'already sent');
  // Only the owner turns it off; someone else changing it tells the owner.
  is(await api('PUT', '/patrol/access-summary', { token: U.Dir.token, body: { on: false } }), 403);
  ok(await api('PUT', '/patrol/access-summary', { token: M.owner, body: { on: false } }));
  mails.length = 0;
  ok(await api('PUT', '/patrol/access-summary', { token: U.Dir.token, body: { on: true } }));
  await settle();
  assert.ok(mails.some((x) => x.To === `owner@${M.slug}.test` && /access summary setting was changed/.test(x.Subject)));
  ok(await api('PUT', '/patrol/access-summary', { token: M.owner, body: { on: false } }));
  const [[off]] = await pool.query('SELECT * FROM tenants WHERE id = ?', [M.id]);
  assert.equal((await AS.runForTenant(off, { now: require('../src/lib/util').addDays(nextMonday, 7), base })).skipped, 'off');
});

// ================================================================ the third review (C+): every route keyed by another id
/** An approved case started 30 hours ago by the owner, with a patient, and an approved frozen copy. */
async function approvedOldCase(summary = 'Fall on the ridge') {
  const id = await newCase(M.owner, { summary });
  ok(await api('POST', `/patrol/incidents/${id}/patients`, { token: M.owner, body: { first_name: 'Celia', last_name: 'Brightwater' } }));
  await pool.query("UPDATE incidents SET report_state = 'approved' WHERE id = ?", [id]);
  await pool.query("INSERT INTO incident_versions (tenant_id, incident_id, version_no, kind, snapshot, created_by) VALUES (?, ?, 1, 'approved', ?, ?)", [M.id, id, JSON.stringify({ id, summary, patients: [{ first_name: 'Celia' }], photos: [] }), U.Dir.id]);
  await age(id, 30);
  return id;
}

test('R1: witness links are keyed by their own id, and still need the records check on their case', async () => {
  const id = await newCase(U.Pat.token);
  const link = ok(await api('POST', `/patrol/incidents/${id}/witness-links`, { token: U.Pat.token, body: { name: 'Wanda Witness', phone: '+12155550111', send: 'show' } }));
  const t = await tokenOf(U.Pia.login);
  asks(await api('POST', `/patrol/witness-links/${link.id}/resend`, { token: t, body: { send: 'show' } }), 'resend by someone with no tie to the case');
  asks(await api('POST', `/patrol/witness-links/${link.id}/cancel`, { token: t }), 'cancel too');
  for (const form of [`${link.id}.0`, `0${link.id}`]) is(await api('POST', `/patrol/witness-links/${form}/resend`, { token: t, body: { send: 'show' } }), 400, form);
  const [[l]] = await pool.query('SELECT status FROM patrol_witness_links WHERE id = ?', [link.id]);
  assert.equal(l.status, 'sent', 'untouched');
  ok(await records(t));
  ok(await api('POST', `/patrol/witness-links/${link.id}/resend`, { token: t, body: { send: 'show' } }));
  ok(await api('POST', `/patrol/witness-links/${link.id}/resend`, { token: U.Pat.token, body: { send: 'show' } }), 'the patroller who wrote it, no check');
});

test('R2: a search inside an export needs the records check and is on the access log', async () => {
  const id = await approvedOldCase();
  const t = await tokenOf(U.Dir.login);
  ok(await stepUp(t)); // the ordinary second check the exports ask for
  ok(await raw('GET', '/api/v1/patrol/incidents.csv', { token: t }), 'no search: as before');
  asks(await raw('GET', '/api/v1/patrol/incidents.csv?q=Brightwater', { token: t }), 'incidents.csv search');
  asks(await raw('GET', '/api/v1/patrol/patients.csv?q=Brightwater', { token: t }), 'patients.csv search');
  ok(await records(t));
  const csv = await raw('GET', '/api/v1/patrol/patients.csv?q=Brightwater', { token: t });
  is(csv, 200);
  const [[a]] = await pool.query("SELECT detail FROM audit_log WHERE tenant_id = ? AND user_id = ? AND action = 'search' ORDER BY id DESC LIMIT 1", [M.id, U.Dir.id]);
  const d = typeof a.detail === 'string' ? JSON.parse(a.detail) : a.detail;
  assert.equal(d.export, 'patients.csv'); assert.ok(d.ids.includes(id), 'the case found is named');
  assert.ok(!JSON.stringify(d).includes('Brightwater'), 'never the words searched');
});

test('R3: releasing a record and making an outside link need the records check on that case; both, and the link opened, are in the weekly summary', async () => {
  const id = await approvedOldCase();
  const t = await tokenOf(U.Dir.login);
  ok(await stepUp(t));
  asks(await api('POST', '/patrol/records', { token: t, body: { incident_id: id, requester_kind: 'insurer', requester_name: 'Acme Mutual', received_on: today, authorization: 'signed_release' } }), 'logging a request names the case');
  ok(await records(t));
  const r = ok(await api('POST', '/patrol/records', { token: t, body: { incident_id: id, requester_kind: 'insurer', requester_name: 'Acme Mutual', received_on: today, authorization: 'signed_release' } }));
  await pool.query('UPDATE user_sessions SET records_checked_at = NULL WHERE id_hash = ?', [sidHash(t)]);
  asks(await api('POST', `/patrol/records/${r.id}/release`, { token: t, body: {} }), 'release with only the ordinary check');
  asks(await api('POST', `/patrol/records/${r.id}/share`, { token: t, body: { shared_with: 'Acme Mutual', passcode: false } }), 'outside link');
  asks(await api('GET', `/patrol/records/${r.id}/pack`, { token: t }), 'the pack');
  ok(await records(t));
  ok(await api('POST', `/patrol/records/${r.id}/release`, { token: t, body: {} }));
  const share = ok(await api('POST', `/patrol/records/${r.id}/share`, { token: t, body: { shared_with: 'Acme Mutual', passcode: false } }));
  const token = share.url.split('/').pop();
  ok(await api('GET', `/public/claim-share/${token}`, { device: null }));
  const s = await require('../src/lib/accesssummary').build(M.id, require('../src/lib/weekly').weekStartOf(today));
  const mine = s.entries.filter((e) => e.user_id === U.Dir.id).flatMap((e) => e.what);
  assert.ok(mine.includes('records release') && mine.includes('outside claim-file link made'), mine.join(', '));
  assert.ok(s.entries.some((e) => !e.user_id && e.what.includes('outside claim-file link opened') && /Acme/.test(e.who)), 'the outside link being opened');
});

test('R4: the dispatch board shows active and today\'s calls unchecked, hides words on calls whose case the person may not open, and needs the check for the season', async () => {
  const id = await newCase(M.owner, { summary: 'Celebrity fall' });
  await age(id, 20);
  const call = ok(await api('POST', '/patrol/dispatch', { token: M.owner, body: { location: 'Lift 3', description: 'Celebrity fall, says her name is Vera', caller_name: 'Vera Caller' } }));
  await pool.query('UPDATE dispatch_calls SET incident_id = ? WHERE id = ?', [id, call.id]);
  const old = ok(await api('POST', '/patrol/dispatch', { token: M.owner, body: { location: 'Glades', description: 'Old call words' } }));
  await pool.query("UPDATE dispatch_calls SET status = 'closed', call_date = DATE_SUB(call_date, INTERVAL 3 DAY) WHERE id = ?", [old.id]);
  const t = await tokenOf(U.Pia.login);
  const board = ok(await api('GET', '/patrol/dispatch', { token: t }));
  const row = board.data.find((c) => c.id === call.id);
  assert.equal(row.description, null); assert.equal(row.caller_name, null); assert.equal(row.words_hidden, true);
  const one_ = ok(await api('GET', `/patrol/dispatch/${call.id}`, { token: t }));
  assert.equal(one_.description, null); assert.ok(!JSON.stringify(one_).includes('Vera'));
  asks(await api('GET', '/patrol/dispatch?status=all', { token: t }), 'the season');
  asks(await api('GET', `/patrol/dispatch?status=closed&date=${require('../src/lib/util').addDays(today, -3)}`, { token: t }), 'another day');
  asks(await api('GET', `/patrol/dispatch/${old.id}`, { token: t }), 'an old call with no case');
  asks(await api('PATCH', `/patrol/dispatch/${old.id}`, { token: t, body: { description: 'changed' } }), 'changing an old call');
  ok(await api('GET', '/patrol/dispatch/available', { token: t }), 'other dispatch routes are unaffected');
  ok(await records(t));
  assert.ok(ok(await api('GET', '/patrol/dispatch?status=all', { token: t })).data.some((c) => c.id === call.id && /Vera/.test(c.description)));
  ok(await api('GET', `/patrol/dispatch/${old.id}`, { token: t }));
});

test('R5: the Approver level is a leader level: only the owner or a patrol Admin grants, changes, resets or relinks it', async () => {
  const mona = await tokenOf(U.Mona.login); ok(await stepUp(mona));
  is(await api('PATCH', `/users/${U.Appr.id}`, { token: mona, body: { email: `moved-${suffix}@example.com` } }), 403, 'email of an Approver');
  const r = await api('POST', `/users/${U.Appr.id}/reset-password`, { token: mona, body: { new_password: PW, temporary: false } });
  is(r, 403); assert.equal(r.body.details.code, 'reset_refused');
  const v = await person('Vic', { level: 'patrol' });
  is(await api('PUT', `/patrol/team/${v.staff}/access`, { token: mona, body: { access_level: 'approver' } }), 403, 'a manager grants Approver');
  is(await api('PATCH', `/patrol/team/${v.staff}`, { token: mona, body: { access_level: 'approver' } }), 403);
  is(await api('PUT', `/patrol/team/${U.Appr.staff}/access`, { token: mona, body: { access_level: 'patrol' } }), 403, 'a manager lowers an Approver');
  mails.length = 0;
  ok(await api('PUT', `/patrol/team/${v.staff}/access`, { token: M.owner, body: { access_level: 'approver' } }));
  assert.ok((await pool.query("SELECT id FROM login_access_changes WHERE user_id = ? AND kind = 'granted' AND to_value = 'approver'", [v.id]))[0].length);
  await settle();
  assert.ok(mails.some((m) => m.To === `owner@${M.slug}.test` && /Approver level/.test(m.Subject)));
  ok(await api('PUT', `/patrol/team/${v.staff}/access`, { token: M.owner, body: { access_level: 'patrol' } }));
  is(await api('POST', `/users/${v.id}/reset-password`, { token: mona, body: { new_password: PW, temporary: false } }), 403, 'lowered from Approver: the 24-hour hold');
});

test('R7: a leader\'s username and the season end are for the owner or a patrol Admin', async () => {
  const mona = await tokenOf(U.Mona.login); ok(await stepUp(mona));
  is(await api('PATCH', `/users/${U.Dir.id}`, { token: mona, body: { username: `dirx-${suffix}` } }), 403, 'a director\'s username');
  const end = require('../src/lib/util').addDays(today, 30);
  const out = ok(await api('POST', '/users/season-end', { token: mona, body: { date: end, roles: ['patrol'] } }));
  assert.ok(out.leaders_kept >= 1);
  const endOf = async (id) => (await pool.query('SELECT access_ends_on FROM users WHERE id = ?', [id]))[0][0].access_ends_on;
  assert.equal(await endOf(U.Dir.id), null, 'a director keeps no end date from a manager');
  assert.equal(String(await endOf(U.Pat.id)).slice(0, 10), end);
  ok(await api('POST', '/users/season-end', { token: M.owner, body: { date: end, roles: ['patrol'] } }));
  assert.equal(String(await endOf(U.Dir.id)).slice(0, 10), end, 'the owner may');
  await pool.query('UPDATE users SET access_ends_on = NULL WHERE tenant_id = ?', [M.id]);
  await pool.query('UPDATE tenants SET season_ends_on = NULL WHERE id = ?', [M.id]);
});

test('R9: the console platform-key code is counted for the key, not per address', async () => {
  const secret = totp.newSecret();
  const tries = require('../src/middleware/rateLimit').counter({ name: 'platform-key-code', windowMs: 15 * 60_000, max: 5 });
  await tries.store.resetKey('platform-key');
  process.env.PLATFORM_TOTP_SECRET = secret;
  try {
    const key = process.env.PLATFORM_KEY || process.env.BOOTSTRAP_KEY;
    const wrong = codeNow(secret) === '000000' ? '111111' : '000000';
    const answers = [];
    for (let i = 0; i < 6; i += 1) answers.push((await api('POST', '/platform/session', { body: { key, name: 'probe', code: wrong } })).status);
    assert.deepEqual(answers, [403, 403, 403, 403, 403, 429]);
    is(await api('POST', '/platform/session', { body: { key, name: 'probe', code: codeNow(secret) } }), 429, 'the right code is refused while locked');
  } finally { delete process.env.PLATFORM_TOTP_SECRET; await tries.store.resetKey('platform-key'); }
});

test('R10: the weekly summary lists every row that passed the records rule, writes included, and chat previews', async () => {
  const id = await approvedOldCase();
  const t = await tokenOf(U.Pete.login);
  ok(await records(t));
  ok(await api('POST', `/patrol/incidents/${id}/notes`, { token: t, body: { body: 'A correction' } }));
  await pool.query("INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, detail) VALUES (?, ?, 'view_link', 'incidents', ?, NULL)", [M.id, U.Pete.id, id]);
  const s = await require('../src/lib/accesssummary').build(M.id, require('../src/lib/weekly').weekStartOf(today));
  const what = s.entries.filter((e) => e.user_id === U.Pete.id).flatMap((e) => e.what);
  assert.ok(what.includes('chat link preview'), what.join(', '));
  assert.ok(what.some((w) => /note/.test(w)), `a write through the rule: ${what.join(', ')}`);
});

test('R11: follow-ups run the case rule on every action, and the list hides the patient for cases the person may not open', async () => {
  const id = await approvedOldCase();
  const [[p]] = await pool.query('SELECT id FROM incident_patients WHERE incident_id = ? LIMIT 1', [id]);
  const [f] = await pool.query("INSERT INTO followups (tenant_id, incident_id, patient_id, to_email, for_guardian, due_on, status, token, comment) VALUES (?, ?, ?, 'celia.b@example.test', 0, ?, 'held', ?, 'My knee still hurts')", [M.id, id, p.id, today, `fu-${suffix}`]);
  const t = await tokenOf(U.Dir.login);
  const row = ok(await api('GET', '/patrol/followups', { token: t })).data.find((x) => x.id === f.insertId);
  assert.ok(row.case_number && row.due_on && row.status, 'case number, due date and state stay');
  assert.equal(row.first_name, null); assert.equal(row.to_email, null); assert.equal(row.comment, null); assert.equal(row.details_hidden, true);
  for (const act of ['approve', 'skip', 'send']) asks(await api('POST', `/patrol/followups/${f.insertId}/${act}`, { token: t, body: {} }), act);
  assert.ok(!JSON.stringify(ok(await api('GET', '/patrol/followup-summary', { token: t }))).includes('knee still'), 'summary comments');
  ok(await records(t));
  const after = ok(await api('GET', '/patrol/followups', { token: t })).data.find((x) => x.id === f.insertId);
  assert.equal(after.first_name, 'Celia'); assert.equal(after.to_email, 'celia.b@example.test');
  ok(await api('POST', `/patrol/followups/${f.insertId}/approve`, { token: t, body: {} }));
  assert.ok(JSON.stringify(ok(await api('GET', '/patrol/followup-summary', { token: t }))).includes('knee still'));
});

test('R12: my calls hide a case\'s words after a late self-dispatch, and changing the words or timeline of a case call runs the rule', async () => {
  const id = await newCase(M.owner, { summary: 'Private fall' });
  await age(id, 20);
  const call = ok(await api('POST', '/patrol/dispatch', { token: M.owner, body: { location: 'Lift 4', description: 'Says her name is Odile', caller_name: 'Odile Caller' } }));
  await pool.query('UPDATE dispatch_calls SET incident_id = ?, received_at = DATE_SUB(received_at, INTERVAL 2 HOUR) WHERE id = ?', [id, call.id]);
  const t = await tokenOf(U.Pia.login);
  ok(await api('POST', `/patrol/dispatch/${call.id}/responders`, { token: t, body: { staff_id: U.Pia.staff } }), 'sending yourself stays open');
  const mine = ok(await api('GET', '/patrol/dispatch-mine', { token: t })).data.find((c) => c.id === call.id);
  assert.ok(mine, 'listed'); assert.ok(!JSON.stringify(mine).includes('Odile'), 'no words'); assert.equal(mine.words_hidden, true);
  asks(await api('PATCH', `/patrol/dispatch/${call.id}`, { token: t, body: { description: 'changed' } }), 'the words');
  asks(await api('POST', `/patrol/dispatch/${call.id}/events`, { token: t, body: { kind: 'note', note: 'added' } }), 'a timeline note');
  asks(await api('POST', `/patrol/dispatch/${call.id}/events`, { token: t, body: { kind: 'closed' } }), 'a status');
  const plain = ok(await api('POST', '/patrol/dispatch', { token: M.owner, body: { location: 'Base', description: 'No case yet' } }));
  ok(await api('PATCH', `/patrol/dispatch/${plain.id}`, { token: t, body: { description: 'Still no case' } }), 'a current call with no case');
  ok(await records(t));
  ok(await api('PATCH', `/patrol/dispatch/${call.id}`, { token: t, body: { priority: 'high' } }));
  assert.ok(JSON.stringify(ok(await api('GET', '/patrol/dispatch-mine', { token: t }))).includes('Odile'));
});

test('R13: the list of outside links shows who each case was shared with only after the records check', async () => {
  const id = await approvedOldCase();
  await pool.query("INSERT INTO claim_shares (tenant_id, kind, incident_id, shared_with, token_hash, expires_at, created_by, created_at) VALUES (?, 'claim', ?, 'Brokerage Insurer Ltd', ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 5 DAY), ?, UTC_TIMESTAMP())", [M.id, id, `h-${suffix}`, U.Dir.id]);
  const t = await tokenOf(U.Dir.login);
  const before = ok(await api('GET', '/patrol/shares', { token: t }));
  assert.ok(!JSON.stringify(before).includes('Brokerage'), 'no names'); assert.ok(before.case_links.total >= 1); assert.equal(before.records_check_needed, true);
  ok(await records(t));
  assert.ok(JSON.stringify(ok(await api('GET', '/patrol/shares', { token: t }))).includes('Brokerage'));
});
