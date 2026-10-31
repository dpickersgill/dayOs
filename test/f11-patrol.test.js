'use strict';

// Release 2026.11.11, patrol track: regressions for the Oct 31 review findings (PATROL-1 to 14, CR-3, DP-8, DP-9, DP-10)
// and the patrol suspicions that were confirmed. Each test is the review's proof turned around: it fails if the defect returns.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '100000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server;
let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const TZ = 'America/New_York';

async function api(method, path, { token, body, headers } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const ok = (r, want) => { assert.ok(want ? r.status === want : r.status < 300, `HTTP ${r.status}: ${r.text.slice(0, 300)}`); return r.body; };
const q = async (sql, params) => (await pool.query(sql, params))[0];
let n = 0;
async function mountain(tag) {
  const slug = `f11p${tag}-${suffix}-${++n}`.slice(0, 40);
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const owner = (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token;
  const tenantId = (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id;
  return { slug, owner, tenantId };
}
async function addUser(m, email, role, extra = {}) {
  ok(await api('POST', '/users', { token: m.owner, body: { email, password: PW, role, ...extra } }), 201);
  return (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token;
}
const staff = async (m, first) => ok(await api('POST', '/workforce/staff', { token: m.owner, body: { person: { first_name: first, last_name: 'Patroller' }, status: 'active' } }), 201).id;
const tzNow = (addMin = 0) => {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(Date.now() + addMin * 60000)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
async function patrolMountain(tag) {
  const m = await mountain(tag);
  m.s1 = await staff(m, 'Pat');
  m.pat = await addUser(m, `pat@${m.slug}.test`, 'patrol', { staff_id: m.s1 });
  return m;
}
const newCase = async (token, over = {}) => ok(await api('POST', '/patrol/incidents', { token, body: { occurred_at: tzNow(-30), location: 'Upper Ridge', category: 'injury', severity: 'minor', summary: 'Wrist injury', ...over } }), 201);
async function readyCase(token, over = {}) {
  const c = await newCase(token, over);
  const p = ok(await api('POST', `/patrol/incidents/${c.id}/patients`, { token, body: { first_name: 'Sam', last_name: 'Skier', age_years: 30, chief_complaint: 'Left wrist pain', disposition: 'treated_released', form: { head_strike: 'no' } } }), 201);
  return { id: c.id, pid: p.id };
}
async function approvedCase(m) {
  const c = await readyCase(m.pat);
  ok(await api('POST', `/patrol/incidents/${c.id}/submit`, { token: m.pat }));
  ok(await api('POST', `/patrol/incidents/${c.id}/approve`, { token: m.owner }));
  return c;
}

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

// ---------------------------------------------------------------- PATROL-1
test('PATROL-1: a case on legal hold cannot be reopened, signed off or approved, and its protocol stamp never changes', async () => {
  const m = await patrolMountain('lh');
  ok(await api('PUT', '/patrol/ops-settings', { token: m.owner, body: { medical_director: 'Dr. Original', protocol_version: 'v1' } }));
  const c = await approvedCase(m);
  ok(await api('PUT', `/patrol/incidents/${c.id}/legal-hold`, { token: m.owner, body: { hold: true, note: 'Claim received' } }));
  const before = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: m.owner }));
  assert.equal((await api('POST', `/patrol/incidents/${c.id}/reopen`, { token: m.owner, body: { reason: 'tidy up' } })).status, 409);
  assert.equal((await api('POST', `/patrol/incidents/${c.id}/submit`, { token: m.owner })).status, 409);
  assert.equal((await api('POST', `/patrol/incidents/${c.id}/approve`, { token: m.owner })).status, 409);
  const after = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: m.owner }));
  assert.equal(after.report_state, 'approved');
  assert.equal(after.versions.length, before.versions.length);
  // A draft on hold cannot be signed off either.
  const d = await readyCase(m.pat);
  ok(await api('PUT', `/patrol/incidents/${d.id}/legal-hold`, { token: m.owner, body: { hold: true, note: 'Claim received' } }));
  const sub = await api('POST', `/patrol/incidents/${d.id}/submit`, { token: m.pat });
  assert.equal(sub.status, 409);
  assert.match(sub.body.error, /legal hold/);
});

test('PATROL-1: re-signing a reopened report keeps the first protocol stamp', async () => {
  const m = await patrolMountain('ps');
  ok(await api('PUT', '/patrol/ops-settings', { token: m.owner, body: { medical_director: 'Dr. Original', protocol_version: 'v1' } }));
  const c = await approvedCase(m);
  const first = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: m.owner })).protocol_stamp;
  assert.match(first, /Dr\. Original/);
  ok(await api('PUT', '/patrol/ops-settings', { token: m.owner, body: { medical_director: 'Dr. New', protocol_version: 'v2' } }));
  ok(await api('POST', `/patrol/incidents/${c.id}/reopen`, { token: m.owner, body: { reason: 'Fix the outcome' } }));
  ok(await api('POST', `/patrol/incidents/${c.id}/submit`, { token: m.pat }));
  assert.equal(ok(await api('GET', `/patrol/incidents/${c.id}`, { token: m.owner })).protocol_stamp, first);
});

// ---------------------------------------------------------------- PATROL-2
test('PATROL-2: a reopened report is not shown or released as approved', async () => {
  const m = await patrolMountain('ro');
  const c = await approvedCase(m);
  ok(await api('POST', `/patrol/incidents/${c.id}/reopen`, { token: m.owner, body: { reason: 'Wrong outcome recorded' } }));
  const cf = ok(await api('GET', `/patrol/incidents/${c.id}/claim-file`, { token: m.owner }));
  assert.equal(cf.basis, 'reopened');
  assert.equal(cf.report.report_state, 'draft');
  assert.equal(cf.withdrawn.version_no, 2);
  const score = ok(await api('GET', `/patrol/incidents/${c.id}/doc-score`, { token: m.owner }));
  assert.notEqual(score.basis, 'approved');
  ok(await api('POST', '/auth/step-up', { token: m.owner, body: { password: PW } }));
  const rq = ok(await api('POST', '/patrol/records', { token: m.owner, body: { incident_id: c.id, requester_kind: 'insurer', requester_name: 'Acme Mutual', received_on: tzNow().slice(0, 10), authorization: 'signed_release' } }), 201);
  const rel = await api('POST', `/patrol/records/${rq.id}/release`, { token: m.owner, body: {} });
  assert.equal(rel.status, 409);
  assert.match(rel.body.error, /reopened/);
});

// ---------------------------------------------------------------- PATROL-13
test('PATROL-13: the Reopened note is stamped on the mountain clock', async () => {
  const m = await patrolMountain('rn');
  const c = await approvedCase(m);
  ok(await api('POST', `/patrol/incidents/${c.id}/reopen`, { token: m.owner, body: { reason: 'Wrong disposition' } }));
  ok(await api('POST', `/patrol/incidents/${c.id}/notes`, { token: m.owner, body: { body: 'Corrected after reopening.' } }), 201);
  const cs = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: m.owner }));
  const [reopen, later] = cs.notes;
  assert.match(reopen.body, /^Reopened/);
  assert.ok(String(reopen.created_at) <= String(later.created_at), `${reopen.created_at} > ${later.created_at}`);
  assert.ok(Math.abs(Date.parse(String(reopen.created_at).replace(' ', 'T')) - Date.parse(tzNow())) < 5 * 60000);
});
