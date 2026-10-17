'use strict';

// DAY/OS Patrol: a patrol on its own. The Patrol only plan, runs and lifts kept from Patrol when Lifts and trails is
// off, the roster imported from a spreadsheet, the website's patrol sign-up, and the ski area's free read-only login
// (the day's patrol in numbers and approved reports only, nothing else).
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.SITE_CONTACT_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const config = require('../src/config');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const KEY = 'test-bootstrap-key';
const slug = `po-${suffix}`;
let T; let owner;

async function api(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);
const login = async (who) => (await api('POST', '/auth/login', { body: { tenant: slug, login: who, password: PW } })).body.token;

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  is(await api('POST', '/tenants', { headers: { 'x-bootstrap-key': KEY }, body: { slug, name: `Ridge Patrol ${suffix}`, owner: { email: `dir@${slug}.test`, password: PW, first_name: 'Dana', last_name: 'Director' } } }), 201);
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
  T = t.id;
  // Patrol and Documents only: everything else off, as the Patrol only plan sets it.
  const off = Object.fromEntries(['sell', 'catalog', 'gate', 'conditions', 'park', 'rentals', 'school', 'programs', 'availability', 'messages', 'shop', 'money', 'workforce'].map((k) => [k, false]));
  is(await api('PUT', `/platform/tenants/${T}/modules`, { headers: { 'x-platform-key': KEY }, body: { modules: { ...off, patrol: true, documents: true } } }), 200);
  owner = await login(`dir@${slug}.test`);
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('the Patrol only plan is on the website, with Patrol and Documents', async () => {
  const r = await api('GET', '/site/plans');
  const p = r.body.plans.find((x) => x.code === 'patrol-only');
  assert.ok(p, 'listed with the plans');
  assert.equal(p.monthly_cents, 14900);
  assert.deepEqual(p.apps.map((a) => a.label).sort(), ['Documents', 'Patrol']);
});

test('a patrol on its own keeps its runs and lifts, but the rest of Lifts and trails stays off', async () => {
  const me = (await api('GET', '/auth/me', { token: owner })).body;
  assert.ok(me.modules.includes('patrol') && !me.modules.includes('conditions'));
  is(await api('POST', '/schedule/trails', { token: owner, body: { name: 'Upper Ridge', difficulty: 'blue', status: 'closed' } }), 201);
  is(await api('POST', '/schedule/lifts', { token: owner, body: { name: 'Summit Quad', status: 'closed' } }), 201);
  const trails = await api('GET', '/schedule/trails', { token: owner });
  is(trails, 200);
  assert.ok((trails.body.data || trails.body).some((x) => x.name === 'Upper Ridge'));
  is(await api('GET', '/ops/grooming', { token: owner }), 403, 'grooming belongs to Lifts and trails');
  is(await api('GET', '/products', { token: owner }), 403, 'no front desk');
});

test('the roster comes in from a spreadsheet; people already on it, and leaders, are skipped', async () => {
  const rows = [
    { first_name: 'Ava', last_name: 'Alpine', email: `ava@${slug}.test`, level: 'patroller', cert_level: 'oec', callsign: 'P12' },
    { first_name: 'Ben', last_name: 'Bindings', email: null, level: 'candidate', cert_level: 'emt' },
    { first_name: 'Cal', last_name: 'Cornice', level: 'director' },
    { first_name: 'Ava', last_name: 'Alpine', email: `AVA@${slug}.test` },
  ];
  const r = await api('POST', '/patrol/team/import', { token: owner, body: { rows } });
  is(r, 200);
  assert.equal(r.body.added, 2);
  assert.deepEqual(r.body.skipped.map((x) => x.row), [3, 4]);
  assert.match(r.body.skipped[0].why, /set by hand/);
  assert.match(r.body.skipped[1].why, /Already on the roster/);
  const team = (await api('GET', '/patrol/team', { token: owner })).body;
  const list = team.data || team.members || team;
  const ava = list.find((m) => m.first_name === 'Ava');
  assert.equal(ava.cert_level, 'oec'); assert.equal(ava.callsign, 'P12'); assert.equal(ava.access_level, 'patrol');
  assert.equal(list.find((m) => m.first_name === 'Ben').cert_level, 'emt');
  is(await api('POST', '/patrol/team/import', { token: owner, body: { rows } }), 200, 'safe to run again');
  assert.equal((await api('POST', '/patrol/team/import', { token: owner, body: { rows } })).body.added, 0);
});

test('the ski area\'s read-only login sees the day in numbers and approved reports, nothing else', async () => {
  is(await api('POST', '/users', { token: owner, body: { username: `area${suffix}`, password: PW, role: 'area' } }), 400, 'needs an email');
  const made = await api('POST', '/users', { token: owner, body: { username: `area${suffix}`, email: `gm@${slug}.test`, password: PW, role: 'area' } });
  is(made, 201);
  const area = await login(`gm@${slug}.test`);
  assert.equal((await api('GET', '/auth/me', { token: area })).body.role, 'area');

  // An approved report (with its frozen copy) and one still in progress.
  const [[staff]] = await pool.query('SELECT s.id FROM staff s WHERE s.tenant_id = ? LIMIT 1', [T]);
  void staff;
  const today = new Date().toISOString().slice(0, 10);
  const [a] = await pool.query("INSERT INTO incidents (tenant_id, occurred_at, location, category, severity, summary, report_state, status, season, seq) VALUES (?, ?, 'Upper Ridge', 'injury', 'moderate', 'Fall on ice', 'approved', 'closed', '2026-27', 901)", [T, `${today} 10:15:00`]);
  const [b] = await pool.query("INSERT INTO incidents (tenant_id, occurred_at, location, category, severity, summary, report_state, status) VALUES (?, ?, 'Base', 'medical', 'minor', 'Feeling faint', 'draft', 'open')", [T, `${today} 11:00:00`]);
  const snapshot = { occurred_at: `${today} 10:15:00`, location: 'Upper Ridge', category: 'injury', severity: 'moderate', summary: 'Fall on ice', narrative: 'Caught an edge.', patients: [{ first_name: 'Pat', last_name: 'Guest', age_years: 34, injuries: [{ injury_type: 'fracture', body_region: 'wrist_hand', side: 'left' }], treatments: [], vitals: [] }], responders: [] };
  await pool.query("INSERT INTO incident_versions (tenant_id, incident_id, version_no, kind, snapshot, created_by) VALUES (?, ?, 1, 'approved', ?, ?)", [T, a.insertId, JSON.stringify(snapshot), made.body.id]);

  const sum = await api('GET', '/area/summary', { token: area });
  is(sum, 200);
  assert.equal(sum.body.calls.total, 2); assert.equal(sum.body.reports.approved, 1); assert.equal(sum.body.reports.waiting, 1);
  assert.ok(!JSON.stringify(sum.body).includes('Guest'), 'no patient names in the summary');
  const list = await api('GET', '/area/reports', { token: area });
  assert.deepEqual(list.body.data.map((r) => r.id), [a.insertId], 'approved only');
  assert.equal(list.body.data[0].case_number, '2026-27-0901');
  const one = await api('GET', `/area/reports/${a.insertId}`, { token: area });
  is(one, 200);
  assert.equal(one.body.case.patients[0].first_name, 'Pat');
  is(await api('GET', `/area/reports/${b.insertId}`, { token: area }), 404, 'a case in progress stays with patrol');
  const [[logged]] = await pool.query("SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ? AND action = 'area_view' AND entity_id = ?", [T, a.insertId]);
  assert.equal(logged.n, 1, 'every report opened is in the audit log');

  // Nothing else, and nothing changed
  for (const path of ['/patrol/incidents', `/patrol/incidents/${b.insertId}`, '/patrol/team', '/documents/categories', '/inbox/unread', '/board', '/users']) {
    const r = await api('GET', path, { token: area });
    is(r, 403, path);
  }
  is(await api('POST', '/schedule/trails', { token: area, body: { name: 'Nope' } }), 403);
  is(await api('GET', '/auth/security', { token: area }), 200, 'their own sign-in settings');
  // In production it must use two-step sign-in, like anyone who reads patient reports.
  const was = config.requireAdminMfa; config.requireAdminMfa = true;
  try {
    assert.equal((await api('GET', '/auth/me', { token: area })).body.mfa_rule, 'area');
    is(await api('GET', '/area/summary', { token: area }), 403);
  } finally { config.requireAdminMfa = was; }
  // Owners and managers can open it too
  is(await api('GET', '/area/summary', { token: owner }), 200);
  is(await api('GET', '/area/summary?date=2999-01-01', { token: owner }), 400);
});

test('the website takes a patrol-only sign-up as a lead', async () => {
  const r = await api('POST', '/site/contact', { body: { kind: 'patrol', name: 'Dana Director', mountain: `Ridge ${suffix}`, email: `dana@${slug}.test`, message: '40 volunteers' } });
  is(r, 201);
  const [[lead]] = await pool.query('SELECT kind FROM site_leads WHERE mountain = ?', [`Ridge ${suffix}`]);
  assert.equal(lead.kind, 'patrol');
  await pool.query('DELETE FROM site_leads WHERE mountain = ?', [`Ridge ${suffix}`]);
});
