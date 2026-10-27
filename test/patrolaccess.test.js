'use strict';

// Patrol access levels (Admin, Manager, Approver, Patrol, Host) and the feature table an Admin can change.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

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
  assert.equal(res.status, 201);
  return { slug, owner: (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token };
}
async function login(m, email) { return (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token; }

let A; let B; const T = {}; const D = {};

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`ac-${suffix}`); B = await mountain(`bc-${suffix}`);
  const o = A.owner;
  // one patrol login per level, each linked to a staff record on the roster
  for (const level of ['admin', 'manager', 'approver', 'patrol', 'host']) {
    const staff = ok(await api('POST', '/workforce/staff', { token: o, body: { person: { first_name: level, last_name: 'Level' }, status: 'active' } }), 201).id;
    D[level] = staff;
    ok(await api('POST', '/users', { token: o, body: { email: `${level}@${A.slug}.test`, password: PW, role: 'patrol', staff_id: staff } }), 201);
    ok(await api('POST', '/patrol/team', { token: o, body: { staff_id: staff, access_level: level } }), 201);
    T[level] = await login(A, `${level}@${A.slug}.test`);
  }
  D.extra = ok(await api('POST', '/workforce/staff', { token: o, body: { person: { first_name: 'New', last_name: 'Recruit' }, status: 'active' } }), 201).id;
  ok(await api('POST', '/users', { token: B.owner, body: { email: `host@${B.slug}.test`, password: PW, role: 'patrol' } }), 201);
  T.hostB = await login(B, `host@${B.slug}.test`);
  D.ann = ok(await api('POST', '/people', { token: o, body: { first_name: 'Ann', last_name: 'Guest', phone: '555-0100', date_of_birth: '1990-05-01' } }), 201).id;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

const newCase = (token) => api('POST', '/patrol/incidents', { token, body: { occurred_at: `${today}T10:15`, location: 'Upper Ridge', category: 'injury', severity: 'minor', summary: 'Sprain' } });

test('each login sees its own level and the features that come with it', async () => {
  const me = async (t) => ok(await api('GET', '/patrol/me', { token: t }));
  assert.equal((await me(T.admin)).access_level, 'admin');
  assert.equal((await me(T.host)).access_level, 'host');
  const host = await me(T.host);
  assert.deepEqual(host.features.sort(), ['trail_checks']);
  assert.ok((await me(T.patrol)).features.includes('create_case'));
  assert.ok(!(await me(T.patrol)).features.includes('approve_case'));
  assert.ok((await me(T.approver)).features.includes('approve_case'));
  assert.ok(!(await me(T.manager)).features.includes('approve_case'), 'Manager does not approve reports unless an Admin allows it');
  assert.ok((await me(T.manager)).features.includes('manage_team'));
  // owners always have everything
  const owner = await me(A.owner);
  assert.equal(owner.access_level, 'admin');
  assert.ok(owner.features.includes('view_access_log') && owner.features.includes('manage_settings'));
});

test('a Host cannot reach cases, patients, guests or dispatch, but can use the map, posts and trail checks', async () => {
  const c = ok(await newCase(T.patrol), 201);
  is(await api('GET', '/patrol/incidents', { token: T.host }), 403, 'case list');
  is(await api('GET', `/patrol/incidents/${c.id}`, { token: T.host }), 403, 'case');
  is(await newCase(T.host), 403, 'new case');
  is(await api('GET', '/patrol/dispatch', { token: T.host }), 403, 'dispatch board');
  is(await api('GET', '/patrol/map-pins', { token: T.host }), 403, 'case pins');
  is(await api('GET', `/people?q=Ann`, { token: T.host }), 403, 'guest search');
  is(await api('GET', `/people/lookup?q=Ann`, { token: T.host }), 403, 'guest lookup');
  is(await api('GET', '/patrol/analytics', { token: T.host }), 403, 'analytics');
  is(await api('GET', '/patrol/followups', { token: T.host }), 403, 'follow-ups');
  is(await api('GET', '/patrol/access-log', { token: T.host }), 403, 'access log');
  is(await api('GET', '/patrol/map', { token: T.host }), 200, 'the map itself');
  is(await api('GET', '/patrol/team', { token: T.host }), 200, 'the team list');
  is(await api('GET', '/patrol/deployments', { token: T.host }), 200, "today's posts");
  const trail = ok(await api('POST', '/schedule/trails', { token: A.owner, body: { name: 'Ridge Run', difficulty: 'blue' } }), 201).id;
  is(await api('POST', '/patrol/trail-checks', { token: T.host, body: { trail_id: trail, hazards: 'Icy patch near the merge' } }), 201, 'trail check');
  const home = ok(await api('GET', '/patrol/home', { token: T.host }));
  assert.deepEqual([home.mine, home.recent, home.waiting], [[], [], []]);
  assert.equal(home.can_view_cases, false);
  const mine = ok(await api('GET', '/patrol/home', { token: T.patrol }));
  assert.equal(mine.can_view_cases, true);
  assert.ok(mine.recent.length >= 1, 'a Patrol level still sees draft cases');
});

test('Patrol writes and submits cases; Approver approves; Manager does not approve by default', async () => {
  const c = ok(await newCase(T.patrol), 201);
  const id = c.id;
  ok(await api('POST', `/patrol/incidents/${id}/patients`, { token: T.patrol, body: { form: { head_strike: 'no' }, first_name: 'Gus', last_name: 'Guest', chief_complaint: 'Wrist', disposition: 'treated_released' } }), 201);
  ok(await api('PATCH', `/patrol/incidents/${id}`, { token: T.patrol, body: { narrative: 'Fell on the flats. Splinted and released.' } }));
  const sub = await api('POST', `/patrol/incidents/${id}/submit`, { token: T.patrol });
  assert.ok([200, 400].includes(sub.status), JSON.stringify(sub.body)); // 400 only when a mandatory field is missing; the guard is what matters here
  const state = ok(await api('GET', `/patrol/incidents/${id}`, { token: T.admin })).report_state;
  assert.equal(state, 'submitted', 'the report reached the approval step');
  is(await api('POST', `/patrol/incidents/${id}/approve`, { token: T.patrol }), 403, 'Patrol cannot approve');
  is(await api('POST', `/patrol/incidents/${id}/approve`, { token: T.manager }), 403, 'Manager cannot approve by default');
  is(await api('POST', `/patrol/incidents/${id}/approve`, { token: T.approver }), 200, 'Approver approves');
  is(await api('POST', `/patrol/incidents/${id}/reopen`, { token: T.patrol, body: { reason: 'Add detail' } }), 403);
  is(await api('POST', `/patrol/incidents/${id}/reopen`, { token: T.approver, body: { reason: 'Add detail' } }), 200);
});

test('Manager runs the team but cannot hand out the higher levels or change access', async () => {
  is(await api('POST', '/patrol/team', { token: T.manager, body: { staff_id: D.extra, access_level: 'host' } }), 201, 'adds a Host');
  is(await api('PUT', `/patrol/team/${D.extra}/access`, { token: T.manager, body: { access_level: 'approver' } }), 403, 'only an Admin changes levels');
  is(await api('PATCH', `/patrol/team/${D.extra}`, { token: T.manager, body: { access_level: 'approver' } }), 403, 'nor can a Manager raise someone to Approver');
  is(await api('PATCH', `/patrol/team/${D.extra}`, { token: T.manager, body: { access_level: 'patrol' } }), 200, 'but can make them Patrol');
  is(await api('GET', '/patrol/access', { token: T.manager }), 403);
  is(await api('GET', '/patrol/followups', { token: T.manager }), 403, 'follow-up emails are for Approvers and Admins by default');
  is(await api('GET', '/patrol/access-log', { token: T.manager }), 403);
  is(await api('POST', '/patrol/equipment', { token: T.manager, body: { name: 'AED base', kind: 'aed' } }), 201, 'equipment is the Manager feature');
  is(await api('POST', '/patrol/equipment', { token: T.patrol, body: { name: 'AED nope', kind: 'aed' } }), 403);
  is(await api('DELETE', `/patrol/team/${D.extra}`, { token: T.manager }), 204);
});

test('a Manager cannot demote or remove an Admin; guest lookups by Patrol are capped and logged', async () => {
  is(await api('PATCH', `/patrol/team/${D.admin}`, { token: T.manager, body: { access_level: 'patrol' } }), 403, 'a Manager cannot demote an Admin');
  is(await api('PATCH', `/patrol/team/${D.admin}`, { token: T.manager, body: { level: 'candidate' } }), 200, 'a rank change alone leaves a chosen level alone');
  is(await api('DELETE', `/patrol/team/${D.admin}`, { token: T.manager }), 403, 'nor remove them');
  assert.equal(ok(await api('GET', '/patrol/team', { token: T.admin })).data.find((m) => m.staff_id === D.admin).access_level, 'admin', 'still an Admin');
  is(await api('PATCH', `/patrol/team/${D.admin}`, { token: T.manager, body: { callsign: 'Admin 1' } }), 200, 'a Manager can still edit their callsign');

  // Patrol cannot page through the whole guest list: the cap of 20 holds however much is asked for
  for (let i = 0; i < 22; i++) ok(await api('POST', '/people', { token: A.owner, body: { first_name: `Cap${i}`, last_name: 'Capsule' } }), 201);
  const list = ok(await api('GET', '/people?q=Capsule&limit=500', { token: T.patrol }));
  assert.equal(list.data.length, 10);
  assert.equal(list.limit, 10);
  assert.equal(ok(await api('GET', '/people?q=Capsule&limit=500', { token: A.owner })).data.length, 22, 'managers are not capped');
  const one = list.data[0].id;
  is(await api('GET', `/people/${one}`, { token: T.patrol }), 404, 'a guest who is not a patient cannot be opened by number');
  const inc = ok(await newCase(T.patrol), 201).id;
  await pool.query("INSERT INTO incident_patients (tenant_id, incident_id, person_id, first_name, last_name) SELECT tenant_id, id, ?, 'Cap0', 'Capsule' FROM incidents WHERE id = ?", [one, inc]);
  const before = (await pool.query("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'people' AND action = 'lookup'"))[0][0].n;
  ok(await api('GET', `/people/${one}`, { token: T.patrol }));
  const after = (await pool.query("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'people' AND action = 'lookup'"))[0][0].n;
  assert.equal(after, before + 1, 'opening a guest by id is logged for Patrol');
  is(await api('GET', `/people/${one}`, { token: T.host }), 403, 'a Host cannot open guests');
});

test('an Admin sees the whole table and changes what a level can do; every change is logged', async () => {
  is(await api('GET', '/patrol/access', { token: T.patrol }), 403);
  const t = ok(await api('GET', '/patrol/access', { token: T.admin }));
  assert.deepEqual(t.levels.map((l) => l.key), ['admin', 'manager', 'approver', 'patrol', 'host']);
  assert.ok(t.features.length >= 12);
  assert.equal(t.matrix.admin.approve_case, true);
  assert.equal(t.matrix.manager.approve_case, false);
  assert.equal(t.matrix.host.view_cases, false);
  assert.equal(t.people.find((p) => p.staff_id === D.host).access_level, 'host');

  // let Managers approve, take trail checks away from Hosts
  ok(await api('PUT', '/patrol/access/rules', { token: T.admin, body: { rules: [{ level: 'manager', feature: 'approve_case', allowed: true }, { level: 'host', feature: 'trail_checks', allowed: false }] } }));
  assert.ok((await api('GET', '/patrol/me', { token: T.manager })).body.features.includes('approve_case'), 'the change applies at once');
  assert.deepEqual((await api('GET', '/patrol/me', { token: T.host })).body.features, []);
  const trail = ok(await api('GET', '/schedule/trails', { token: A.owner })).data[0].id;
  is(await api('POST', '/patrol/trail-checks', { token: T.host, body: { trail_id: trail, hazards: 'x' } }), 403);

  // another mountain is not affected
  assert.ok((await api('GET', '/patrol/me', { token: T.hostB })).body.features.includes('trail_checks'), "A's change did not touch mountain B");

  // the Admin level cannot be edited, unknown features are refused, and only Admins can edit
  is(await api('PUT', '/patrol/access/rules', { token: T.admin, body: { rules: [{ level: 'admin', feature: 'view_cases', allowed: false }] } }), 400);
  is(await api('PUT', '/patrol/access/rules', { token: T.admin, body: { rules: [{ level: 'patrol', feature: 'fly_helicopter', allowed: true }] } }), 400);
  is(await api('PUT', '/patrol/access/rules', { token: T.manager, body: { rules: [{ level: 'patrol', feature: 'reports', allowed: true }] } }), 403);

  const log = (await pool.query("SELECT detail FROM audit_log WHERE tenant_id = (SELECT id FROM tenants WHERE slug = ?) AND action = 'patrol_access_rules'", [A.slug]))[0];
  assert.ok(log.length >= 1, 'changes are in the audit log');

  // back to the built-in defaults
  const reset = ok(await api('DELETE', '/patrol/access/rules', { token: T.admin }));
  assert.equal(reset.matrix.manager.approve_case, false);
  assert.equal(reset.matrix.host.trail_checks, true);
  const stored = (await pool.query('SELECT COUNT(*) AS n FROM patrol_access_rules WHERE tenant_id = (SELECT id FROM tenants WHERE slug = ?)', [A.slug]))[0][0].n;
  assert.equal(Number(stored), 0, 'defaults are stored as no rows');
});

test('an Admin moves a person between levels, and a new rank carries the level along only when it was not customized', async () => {
  is(await api('PUT', `/patrol/team/${D.patrol}/access`, { token: T.patrol, body: { access_level: 'admin' } }), 403, 'cannot promote yourself');
  is(await api('PUT', `/patrol/team/${D.patrol}/access`, { token: T.admin, body: { access_level: 'approver' } }), 200);
  assert.equal((await api('GET', '/patrol/me', { token: T.patrol })).body.access_level, 'approver', 'a token that was already issued sees it at once');
  is(await api('PUT', `/patrol/team/${D.patrol}/access`, { token: T.admin, body: { access_level: 'patrol' } }), 200);
  is(await api('PUT', '/patrol/team/999999/access', { token: T.admin, body: { access_level: 'patrol' } }), 404);

  // rank follows: a new member made a leader starts as Manager; a customized level is left alone
  const o = A.owner;
  ok(await api('POST', '/patrol/team', { token: o, body: { staff_id: D.extra, level: 'leader' } }), 201);
  assert.equal(ok(await api('GET', '/patrol/team', { token: o })).data.find((m) => m.staff_id === D.extra).access_level, 'manager');
  ok(await api('PATCH', `/patrol/team/${D.extra}`, { token: o, body: { level: 'director' } }));
  assert.equal(ok(await api('GET', '/patrol/team', { token: o })).data.find((m) => m.staff_id === D.extra).access_level, 'admin', 'director rank moves an untouched level up');
  ok(await api('PUT', `/patrol/team/${D.extra}/access`, { token: o, body: { access_level: 'host' } }));
  ok(await api('PATCH', `/patrol/team/${D.extra}`, { token: o, body: { level: 'leader' } }));
  assert.equal(ok(await api('GET', '/patrol/team', { token: o })).data.find((m) => m.staff_id === D.extra).access_level, 'host', 'a chosen level is not overwritten by a rank change');
});

test('owners and system managers keep every patrol feature, and a login with no roster record is a plain Patrol', async () => {
  ok(await api('POST', '/users', { token: A.owner, body: { email: `mgr@${A.slug}.test`, password: PW, role: 'manager' } }), 201);
  const mgr = await login(A, `mgr@${A.slug}.test`);
  const me = ok(await api('GET', '/patrol/me', { token: mgr }));
  assert.equal(me.access_level, 'admin');
  assert.ok(me.features.includes('manage_settings'));
  is(await api('GET', '/patrol/access', { token: mgr }), 200);
  ok(await api('POST', '/users', { token: A.owner, body: { email: `loose@${A.slug}.test`, password: PW, role: 'patrol' } }), 201);
  const loose = await login(A, `loose@${A.slug}.test`);
  assert.equal((await api('GET', '/patrol/me', { token: loose })).body.access_level, 'patrol');
  is(await api('GET', '/patrol/incidents', { token: loose }), 200);
  // other roles are not patrol at all
  ok(await api('POST', '/users', { token: A.owner, body: { email: `ctr@${A.slug}.test`, password: PW, role: 'counter' } }), 201);
  is(await api('GET', '/patrol/incidents', { token: await login(A, `ctr@${A.slug}.test`) }), 403);
});
