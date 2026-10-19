'use strict';

// Version numbers and What's new: the version is YEAR.MONTH.N and matches the newest change log entry; /version and
// /readyz say which version is running; each person sees only the notes for their role and their mountain's apps;
// the badge count goes to zero once they have looked; the console sees everything and the deploy history; and
// deploy.sh's check refuses to put an older version over a newer one.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const modules = require('../src/lib/modules');
const V = require('../src/lib/version');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';

async function api(method, p, { token, key, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'x-platform-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };

const M = {};
test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const slug = `rel-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Release Hill', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  M.owner = await login(`owner@${slug}.test`);
  for (const role of ['counter', 'patrol', 'instructor']) {
    ok(await api('POST', '/users', { token: M.owner, body: { email: `${role}@${slug}.test`, password: PW, role } }));
    M[role] = await login(`${role}@${slug}.test`);
  }
  M.id = Number((await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]))[0][0].id);
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('the version is a calendar version and the change log is complete and well formed', () => {
  assert.match(V.VERSION, /^\d{4}\.(1[0-2]|[1-9])\.\d+$/);
  assert.equal(V.RELEASES[0].version, V.VERSION, 'the newest change log entry is this version');
  const help = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'help-content.js'), 'utf8');
  for (let i = 0; i < V.RELEASES.length; i += 1) {
    const r = V.RELEASES[i];
    if (i) assert.ok(V.compare(V.RELEASES[i - 1].version, r.version) > 0, `${r.version}: releases are newest first, each number once`);
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(r.notes.length, `${r.version} has notes`);
    for (const n of r.notes) {
      assert.ok(['new', 'improved', 'fixed'].includes(n.kind), `${r.version}: kind ${n.kind}`);
      assert.ok(n.app === null || modules.KEYS.includes(n.app), `${r.version}: app ${n.app}`);
      assert.ok(n.who === null || n.who === 'platform' || (Array.isArray(n.who) && n.who.every((w) => ['counter', 'instructor', 'patrol', 'staff'].includes(w))), `${r.version}: who ${JSON.stringify(n.who)}`);
      assert.ok(typeof n.text === 'string' && n.text.length > 10, `${r.version}: text`);
      if (n.help) assert.ok(help.includes(`id: '${n.help}'`), `${r.version}: help article ${n.help} exists`);
    }
  }
  assert.equal(require('../package-lock.json').version, V.VERSION, 'package-lock.json has the same version');
});

test('compare orders calendar versions by number, not as text', () => {
  assert.ok(V.compare('2026.10.10', '2026.10.9') > 0);
  assert.ok(V.compare('2026.9.4', '2026.10.1') < 0);
  assert.ok(V.compare('2027.1.1', '2026.12.9') > 0);
  assert.equal(V.compare('2026.10.4', '2026.10.4'), 0);
  assert.ok(V.compare('2026.10.4', '') > 0, 'no version counts as oldest');
});

test('/version and /readyz say which version is running', async () => {
  const v = await (await fetch(`${base}/version`)).json();
  assert.equal(v.version, V.VERSION);
  assert.ok(!('build' in v), 'the build is only for someone signed in');
  const r = await (await fetch(`${base}/readyz`)).json();
  assert.equal(r.ok, true);
  assert.equal(r.version, V.VERSION);
});

test("What's new shows each person only their role's notes and their mountain's apps", async () => {
  const all = (w) => w.releases.flatMap((r) => r.notes);
  const owner = ok(await api('GET', '/whats-new', { token: M.owner }));
  const counter = ok(await api('GET', '/whats-new', { token: M.counter }));
  const patrol = ok(await api('GET', '/whats-new', { token: M.patrol }));
  assert.equal(owner.version, V.VERSION);
  const textOf = (w) => all(w).map((n) => n.text).join('\n');
  assert.ok(!/console/i.test(textOf(owner)), 'console-only notes never reach a mountain');
  assert.ok(all(owner).some((n) => n.app === 'patrol') && all(owner).some((n) => n.app === 'gate'), 'an owner sees every app the mountain has');
  assert.ok(all(patrol).some((n) => n.app === 'patrol'));
  assert.ok(!all(patrol).some((n) => n.app === 'gate' && n.kind === 'fixed'), 'gate fixes are for the counter and lift staff');
  assert.ok(!all(counter).some((n) => n.app === 'patrol'), 'patrol notes are not shown at the counter');
  assert.ok(all(counter).some((n) => n.app === 'gate'));
  assert.ok(all(counter).some((n) => n.app === null), 'everyone sees the notes for everyone');
  for (const w of [owner, counter, patrol]) assert.ok(w.releases.every((r) => r.notes.length), 'releases with nothing for this person are left out');

  // An app the mountain does not have: its notes disappear, even for the owner.
  await pool.query("INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, 'gate', 0) ON DUPLICATE KEY UPDATE enabled = 0", [M.id]);
  modules.invalidate(M.id);
  assert.ok(!all(ok(await api('GET', '/whats-new', { token: M.owner }))).some((n) => n.app === 'gate'));
  await pool.query("UPDATE tenant_modules SET enabled = 1 WHERE tenant_id = ? AND module = 'gate'", [M.id]);
  modules.invalidate(M.id);
});

test('the roadmap is in Help for owners and managers only, behind sign-in, and not on the website', async () => {
  const r = ok(await api('GET', '/whats-new/roadmap', { token: M.owner }));
  assert.deepEqual(r.stages.map((st) => st.key), ['now', 'next', 'later']);
  for (const st of r.stages) {
    assert.ok(st.label && st.items.length, `${st.key} has items`);
    for (const it of st.items) {
      assert.ok(it.title && it.text, 'each item has a title and a line');
      assert.ok(it.app === null || modules.MODULES.some((m) => m.key === it.app) || ['dashboard', 'sell', 'catalog', 'money'].includes(it.app), `${it.title}: app ${it.app}`);
      assert.ok(!/\u2014|TODO|Dan\b|platform fee|\$\d/.test(`${it.title} ${it.text}`), `${it.title}: written for mountains`);
    }
  }
  assert.equal((await api('GET', '/whats-new/roadmap', { token: M.counter })).status, 403, 'staff do not see it');
  assert.equal((await api('GET', '/whats-new/roadmap')).status, 401, 'not without signing in');
  assert.equal((await fetch(`${base}/site/roadmap`)).status, 404, 'not a website page');
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'public', 'roadmap.json')), 'not a public file');
});

test('the badge: the newest release for someone who never looked, nothing once they have, more when a release arrives', async () => {
  const first = ok(await api('GET', '/whats-new/count', { token: M.instructor }));
  const mine = ok(await api('GET', '/whats-new', { token: M.instructor }));
  assert.equal(first.unseen, mine.releases[0].notes.length, 'never looked: only the newest release counts');
  assert.ok(first.unseen > 0);
  ok(await api('POST', '/whats-new/seen', { token: M.instructor }));
  assert.equal(ok(await api('GET', '/whats-new/count', { token: M.instructor })).unseen, 0);
  assert.equal(ok(await api('GET', '/whats-new/count', { token: M.patrol })).unseen > 0, true, 'one person looking does not clear it for another');

  // Someone who last looked two releases ago counts every note since then.
  const older = V.RELEASES[2].version;
  await pool.query('UPDATE users SET seen_version = ? WHERE tenant_id = ? AND role = ?', [older, M.id, 'patrol']);
  const p = ok(await api('GET', '/whats-new', { token: M.patrol }));
  const expect = p.releases.filter((r) => V.compare(r.version, older) > 0).reduce((n, r) => n + r.notes.length, 0);
  assert.equal(p.unseen, expect);
  assert.equal(p.seen, older);
  assert.equal((await api('GET', '/whats-new')).status, 401, 'needs a sign-in');
});

test('unseenCount ignores notes written for a version that is not deployed yet', () => {
  const rel = [{ version: '2999.1.1', notes: [{}, {}] }, { version: V.VERSION, notes: [{}] }];
  assert.equal(V.unseenCount(rel, V.VERSION), 0);
  assert.equal(V.unseenCount(rel, null), 0);
});

test('the console sees the full change log and the deploy history', async () => {
  await pool.query('INSERT INTO app_deploys (version, build, deployed_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE last_started_at = CURRENT_TIMESTAMP', [V.VERSION, 'test123', 'ops@example.test']);
  const r = ok(await api('GET', '/platform/releases', { key: 'test-bootstrap-key' }));
  assert.equal(r.version, V.VERSION);
  assert.ok(r.releases.some((x) => x.notes.some((n) => n.who === 'platform')), 'console-only notes are here');
  assert.ok(r.deploys.some((d) => d.build === 'test123' && d.deployed_by === 'ops@example.test'));
  assert.equal((await api('GET', '/platform/releases', { token: M.owner })).status, 403, 'not for a mountain login');
});

test("deploy.sh's version check: newer and same go ahead, older stops unless asked", () => {
  const script = path.join(__dirname, '..', 'scripts', 'check-version.js');
  const run = (...args) => { try { return { code: 0, out: execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: 'pipe' }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; } };
  assert.equal(run('').code, 0, 'a live site from before version numbers');
  assert.equal(run('2026.9.1').code, 0);
  assert.match(run('2026.9.1').out, new RegExp(`Deploying ${V.VERSION.replace(/\./g, '\\.')} over 2026\\.9\\.1`));
  assert.equal(run(V.VERSION).code, 0, 'a redeploy of the same version');
  const stopped = run('2999.1.1');
  assert.equal(stopped.code, 1);
  assert.match(stopped.out, /Stopped/);
  assert.equal(run('2999.1.1', '--allow-older').code, 0);
});

test('the browser shows the version in the account menu, on the sign-in screen and in Help', () => {
  const js = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8');
  assert.match(js('nav.js'), /who-version/);
  assert.match(js('main.js'), /signInVersion/);
  assert.match(js('views/help.js'), /whats-new/);
});
