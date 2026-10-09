'use strict';

// The day board: tiles by role, personal and default layouts, alerts, shift notes, and mountain-to-mountain isolation.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base;
const suffix = Date.now().toString(36) + Math.floor(Math.random() * 100);
const PW = 'correct-horse-battery';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
let A; let B; const T = {};

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
async function mountain(slug) {
  const t = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `o@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(t.status, 201);
  const l = await api('POST', '/auth/login', { body: { tenant: slug, email: `o@${slug}.test`, password: PW } });
  return { slug, token: l.body.token };
}
const keys = (r) => r.body.layout.tiles;

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`bd-a-${suffix}`); B = await mountain(`bd-b-${suffix}`);
  for (const role of ['manager', 'counter', 'patrol', 'staff']) {
    assert.equal((await api('POST', '/users', { token: A.token, body: { email: `${role}@${A.slug}.test`, password: PW, role } })).status, 201);
    T[role] = (await api('POST', '/auth/login', { body: { tenant: A.slug, email: `${role}@${A.slug}.test`, password: PW } })).body.token;
  }
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [A.slug]);
  A.id = t.id;
  const [l1] = await pool.query("INSERT INTO lifts (tenant_id, name, status) VALUES (?, 'Summit Quad', 'open')", [A.id]);
  await pool.query("INSERT INTO lifts (tenant_id, name, status) VALUES (?, 'Ridge Triple', 'wind_hold')", [A.id]);
  const [l3] = await pool.query("INSERT INTO lifts (tenant_id, name, status) VALUES (?, 'Valley Double', 'closed')", [A.id]);
  await pool.query("INSERT INTO lift_checks (tenant_id, lift_id, check_date, kind, result, items) VALUES (?, ?, ?, 'pre_open', 'pass', '[]')", [A.id, l1.insertId, today]);
  await pool.query("INSERT INTO lift_checks (tenant_id, lift_id, check_date, kind, result, items) VALUES (?, ?, ?, 'pre_open', 'fail', '[]')", [A.id, l3.insertId, today]);
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('each role gets its own starting tiles, and only ones it may see', async () => {
  const mgr = await api('GET', '/board', { token: T.manager });
  assert.equal(mgr.status, 200, JSON.stringify(mgr.body));
  assert.equal(mgr.body.layout.source, 'default');
  for (const k of ['lifts', 'sales', 'staffing', 'notes']) assert.ok(keys(mgr).includes(k), k);
  const counter = await api('GET', '/board', { token: T.counter });
  assert.ok(keys(counter).includes('rentals') && keys(counter).includes('lessons'));
  assert.ok(!keys(counter).includes('sales') && !keys(counter).includes('staffing'), 'money and staffing are for managers');
  assert.equal(counter.body.data.sales, undefined);
  const patrol = await api('GET', '/board', { token: T.patrol });
  assert.equal(keys(patrol)[0], 'patrol');
  assert.ok(!patrol.body.catalog.some((c) => c.key === 'sales'));
});

test('alerts: a failed inspection and a wind hold lead the band', async () => {
  const r = await api('GET', '/board', { token: T.manager });
  assert.equal(r.body.alerts[0].level, 'stop');
  assert.match(r.body.alerts[0].text, /Valley Double failed its inspection/);
  assert.ok(r.body.alerts.some((a) => a.level === 'warn' && /Ridge Triple is on a wind hold/.test(a.text)));
  const lifts = r.body.data.lifts.lifts;
  assert.equal(lifts.find((l) => l.name === 'Summit Quad').check, 'pass');
  assert.equal(lifts.find((l) => l.name === 'Valley Double').check, 'fail');
  assert.deepEqual((await api('GET', '/board', { token: B.token })).body.data.lifts.lifts, [], 'another mountain sees none of them');
});

test('a person can choose, reorder and reset their own tiles', async () => {
  assert.equal((await api('PUT', '/board/layout', { token: T.counter, body: { tiles: ['sales'] } })).status, 400, 'a counter cannot add the sales tile');
  assert.equal((await api('PUT', '/board/layout', { token: T.counter, body: { tiles: ['nope'] } })).status, 400);
  assert.equal((await api('PUT', '/board/layout', { token: T.counter, body: { tiles: ['snow', 'notes', 'snow'] } })).status, 200);
  let r = await api('GET', '/board', { token: T.counter });
  assert.deepEqual(keys(r), ['snow', 'notes']); assert.equal(r.body.layout.source, 'user');
  assert.deepEqual(Object.keys(r.body.data).sort(), ['notes', 'snow'], 'only chosen tiles are loaded');
  assert.equal((await api('DELETE', '/board/layout', { token: T.counter })).status, 200);
  r = await api('GET', '/board', { token: T.counter });
  assert.equal(r.body.layout.source, 'default');
});

test('a manager sets the default for a role; a personal choice still wins', async () => {
  assert.equal((await api('PUT', '/board/layout/role/counter', { token: T.counter, body: { tiles: ['notes'] } })).status, 403);
  assert.equal((await api('PUT', '/board/layout/role/counter', { token: T.manager, body: { tiles: ['notes', 'rentals', 'sales'] } })).status, 200);
  const r = await api('GET', '/board', { token: T.counter });
  assert.deepEqual(keys(r), ['notes', 'rentals'], 'a tile the role cannot see is left out');
  assert.equal(r.body.layout.source, 'role');
  await api('PUT', '/board/layout', { token: T.counter, body: { tiles: ['lifts'] } });
  assert.deepEqual(keys(await api('GET', '/board', { token: T.counter })), ['lifts']);
  assert.deepEqual(keys(await api('GET', '/board', { token: B.token })).includes('notes'), true);
  assert.equal((await api('DELETE', '/board/layout/role/counter', { token: T.manager })).status, 200);
});

test('turning an app off removes its tiles', async () => {
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [A.slug]);
  const put = await fetch(`${base}/api/v1/platform/tenants/${t.id}/modules`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-platform-key': 'test-bootstrap-key' }, body: JSON.stringify({ modules: { rentals: false } }) });
  assert.equal(put.status, 200);
  require('../src/lib/modules').invalidate(t.id);
  const r = await api('GET', '/board', { token: T.manager });
  assert.ok(!r.body.catalog.some((c) => c.key === 'rentals'));
  assert.ok(!keys(r).includes('rentals'));
});

test('shift notes: anyone posts, only managers pin, you remove your own', async () => {
  await api('DELETE', '/board/layout', { token: T.counter });
  const mine = (await api('POST', '/board/notes', { token: T.counter, body: { body: 'Valley Double down until noon', pinned: true } })).body.id;
  assert.ok(mine);
  let notes = (await api('GET', '/board', { token: T.counter })).body.data.notes.notes;
  assert.equal(notes.length, 1); assert.equal(notes[0].pinned, false, 'a counter cannot pin'); assert.equal(notes[0].mine, true);
  assert.equal((await api('PATCH', `/board/notes/${mine}`, { token: T.counter, body: { pinned: true } })).status, 403);
  assert.equal((await api('PATCH', `/board/notes/${mine}`, { token: T.manager, body: { pinned: true } })).status, 200);
  const other = (await api('POST', '/board/notes', { token: T.staff, body: { body: 'Gate 2 radio is charging' } })).body.id;
  assert.equal((await api('DELETE', `/board/notes/${other}`, { token: T.counter })).status, 403, 'not their note');
  notes = (await api('GET', '/board', { token: T.manager })).body.data.notes.notes;
  assert.equal(notes[0].pinned, true, 'pinned notes come first');
  assert.equal(notes[0].author.includes('counter') || notes[0].author.length > 0, true);
  assert.equal((await api('GET', '/board', { token: B.token })).body.data.notes.notes.length, 0, 'another mountain sees none');
  assert.equal((await api('DELETE', `/board/notes/${mine}`, { token: B.token })).status, 404, 'cannot touch another mountain\'s note');
  assert.equal((await api('DELETE', `/board/notes/${mine}`, { token: T.counter })).status, 200);
  assert.equal((await api('DELETE', `/board/notes/${other}`, { token: T.manager })).status, 200);
});

test('only managers can look at another day', async () => {
  assert.equal((await api('GET', '/board?date=2020-01-02', { token: T.manager })).body.date, '2020-01-02');
  assert.equal((await api('GET', '/board?date=2020-01-02', { token: T.counter })).body.date, today);
  assert.equal((await api('GET', '/board?date=garbage', { token: T.manager })).status, 400);
  assert.deepEqual((await api('GET', '/board?date=2020-01-02', { token: T.manager })).body.alerts, [], 'alerts are about today only');
});
