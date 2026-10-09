'use strict';

// The self-serve demo: a visitor gets a private mountain with made-up data, it expires, it is removed completely, and it can never email or charge anyone.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.SANDBOX_RATE_LIMIT = '1000';

// A stand-in mail service that counts what reaches it, so the test can prove a demo never gets as far as sending.
const http = require('http');
const stubPort = 41000 + Math.floor(Math.random() * 2000);
let mailHits = 0;
const stub = http.createServer((_req, res) => { mailHits += 1; res.setHeader('content-type', 'application/json'); res.end('{"ErrorCode":0,"MessageID":"x"}'); }).listen(stubPort, '127.0.0.1');
process.env.POSTMARK_API_BASE = `http://127.0.0.1:${stubPort}`;
process.env.POSTMARK_SERVER_TOKEN = 'test-token';
process.env.MAIL_FROM = 'patrol@example.org';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const S = require('../src/lib/sandbox');
const M = require('../src/lib/modules');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const KEY = 'test-bootstrap-key';
const made = []; // tenant ids to clean up

async function api(method, path, { token, key, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'x-platform-key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const tenantId = async (slug) => (await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]))[0][0]?.id;
const start = async (email, extra = {}) => {
  const r = await api('POST', '/trial', { body: { name: 'Tess Tester', email, mountain: 'Test Peak', ...extra } });
  if (r.status === 201) made.push(await tenantId(r.body.tenant));
  return r;
};
const E1 = `tess1-${suffix}@example.org`;
const E2 = `tess2-${suffix}@example.org`;
let one;

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  for (const id of made) if (id) await S.purgeTenant(id).catch(() => {});
  await new Promise((r) => server.close(r));
  await new Promise((r) => stub.close(r));
  await pool.end();
});

test('a visitor gets a private demo mountain with every app on and made-up data in it', async () => {
  one = await start(E1);
  assert.equal(one.status, 201, JSON.stringify(one.body));
  assert.match(one.body.tenant, /^try-/);
  assert.ok(one.body.token && one.body.password && one.body.expires_at);
  // the password they were shown signs in, and the token they were given already works
  const login = await api('POST', '/auth/login', { body: { tenant: one.body.tenant, email: E1, password: one.body.password } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const me = await api('GET', '/auth/me', { token: one.body.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.role, 'owner'); assert.equal(me.body.tenant_name, 'Test Peak');
  assert.ok(me.body.sandbox && me.body.sandbox.expires_at, 'the app can tell it is a demo');
  assert.deepEqual([...me.body.modules].sort(), M.MODULES.filter((m) => !m.addon).map((m) => m.key).sort(), 'every app is on; paid add-ons are not');
  const lifts = await api('GET', '/schedule/lifts', { token: one.body.token });
  const products = await api('GET', '/products', { token: one.body.token });
  const people = await api('GET', '/people', { token: one.body.token });
  assert.ok(lifts.body.data.length >= 4 && products.body.data.length >= 8, 'sample lifts and products are there');
  assert.ok((people.body.data || people.body).length >= 10, 'sample customers and staff are there');
  const [[t]] = await pool.query('SELECT storage_cap_mb, require_mfa FROM tenants WHERE slug = ?', [one.body.tenant]);
  assert.equal(t.storage_cap_mb, S.STORAGE_MB); assert.equal(Number(t.require_mfa), 0);
});

test('bots, bad addresses and a full demo are turned away', async () => {
  assert.equal((await api('POST', '/trial', { body: { name: 'Bot', email: `b-${suffix}@example.org`, website: 'http://spam.example' } })).status, 400);
  assert.equal((await api('POST', '/trial', { body: { name: 'X', email: 'not-an-email' } })).status, 400);
  assert.equal((await api('POST', '/trial', { body: { email: `n-${suffix}@example.org` } })).status, 400);
  const was = S.MAX_ACTIVE; S.MAX_ACTIVE = 0;
  try {
    const full = await api('POST', '/trial', { body: { name: 'Late Larry', email: `l-${suffix}@example.org` } });
    assert.equal(full.status, 503); assert.match(full.body.error, /full/);
  } finally { S.MAX_ACTIVE = was; }
  const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM sandbox_signups WHERE email IN (?, ?, ?)', [`b-${suffix}@example.org`, `n-${suffix}@example.org`, `l-${suffix}@example.org`]);
  assert.equal(Number(n.n), 0, 'nothing was recorded for the turned-away tries');
});

test('demo mountains are not mixed in with real ones, and they cannot see each other', async () => {
  const two = await start(E2, { mountain: 'Other Peak' });
  assert.equal(two.status, 201, JSON.stringify(two.body));
  const list = await api('GET', '/platform/tenants', { key: KEY });
  assert.ok(!list.body.data.some((t) => t.slug === one.body.tenant || t.slug === two.body.tenant), 'the console list is for real mountains');
  const a = (await api('GET', '/people', { token: one.body.token })).body;
  const b = (await api('GET', '/people', { token: two.body.token })).body;
  const ids = new Set((a.data || a).map((p) => p.id));
  assert.ok((b.data || b).every((p) => !ids.has(p.id)), 'no customer or staff record is shared between two demos');
  const leads = await api('GET', '/platform/sandboxes', { key: KEY });
  assert.equal(leads.status, 200);
  assert.ok(leads.body.data.some((s) => s.email === E1 && s.active && s.mountain === 'Test Peak'));
  assert.equal((await api('GET', '/platform/sandboxes')).status, 403, 'the lead list needs the platform key');
});

test('a demo can never send email or take a card payment', async () => {
  assert.equal(await S.isSandbox(await tenantId(one.body.tenant)), true);
  const real = await api('POST', '/platform/tenants', { key: KEY, body: { slug: `real-${suffix}`, name: 'Real Mountain', owner: { email: `o@real-${suffix}.test`, password: 'correct-horse-battery', first_name: 'Rae', last_name: 'Real' } } });
  assert.equal(real.status, 201);
  assert.equal(await S.isSandbox(real.body.id), false);
  assert.equal(await S.purgeTenant(real.body.id), false, 'the cleanup refuses to touch a real mountain');
  assert.ok(await tenantId(`real-${suffix}`), 'the real mountain is still there');
  // a follow-up email in a demo stops before it reaches the mail service
  const followups = require('../src/lib/followups');
  const sbId = await tenantId(one.body.tenant);
  const sbTenant = (await pool.query('SELECT * FROM tenants WHERE id = ?', [sbId]))[0][0];
  const [[pt]] = await pool.query('SELECT id, incident_id FROM incident_patients WHERE tenant_id = ? LIMIT 1', [sbId]);
  assert.ok(pt, 'the demo has a sample patrol case');
  await pool.query('DELETE FROM followups WHERE tenant_id = ? AND patient_id = ?', [sbId, pt.id]);
  const [ins] = await pool.query("INSERT INTO followups (tenant_id, incident_id, patient_id, to_email, due_on, status, token) VALUES (?, ?, ?, 'guest@example.com', CURDATE(), 'queued', ?)", [sbId, pt.incident_id, pt.id, 'f'.repeat(32)]);
  const [[fu]] = await pool.query('SELECT * FROM followups WHERE id = ?', [ins.insertId]);
  mailHits = 0;
  assert.equal(await followups.sendOne(fu, sbTenant, 'http://localhost'), 'failed');
  assert.equal(mailHits, 0, 'nothing reached the mail service');
  assert.match((await pool.query('SELECT error FROM followups WHERE id = ?', [fu.id]))[0][0].error, /switched off in the demo/);
  assert.equal(require('../src/lib/mailer').enabled(), true, 'the mail service was switched on for this test, so the block is the demo guard');
  await pool.query('DELETE FROM tenant_modules WHERE tenant_id = ?', [real.body.id]);
  await pool.query('DELETE FROM users WHERE tenant_id = ?', [real.body.id]);
  await pool.query('DELETE FROM people WHERE tenant_id = ?', [real.body.id]);
  await pool.query('DELETE FROM tenants WHERE id = ?', [real.body.id]);
});

test('starting again with the same email replaces the old demo', async () => {
  const oldId = await tenantId(one.body.tenant);
  const again = await start(E1, { mountain: 'Test Peak Two' });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(await tenantId(one.body.tenant), undefined, 'the first demo is gone');
  assert.ok(oldId);
  assert.equal((await api('GET', '/auth/me', { token: one.body.token })).status, 401, 'its token no longer works');
  one = again;
});

test('a finished demo stops working, then is removed with everything in it', async () => {
  const id = await tenantId(one.body.tenant);
  await pool.query('UPDATE tenants SET sandbox_expires_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?', [id]);
  const login = await api('POST', '/auth/login', { body: { tenant: one.body.tenant, email: E1, password: one.body.password } });
  assert.equal(login.status, 403); assert.match(login.body.error, /demo has ended/);
  assert.equal((await api('GET', '/products', { token: one.body.token })).status, 403);

  const gone = await api('POST', '/platform/sandboxes/purge', { key: KEY });
  assert.equal(gone.status, 200); assert.ok(gone.body.removed >= 1);
  assert.equal(await tenantId(one.body.tenant), undefined);
  // not one row is left behind, in any table that carries a mountain id
  const [tables] = await pool.query("SELECT table_name AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND column_name = 'tenant_id'");
  const left = [];
  for (const { t } of tables) {
    if (t === 'sandbox_signups') continue;
    const [[c]] = await pool.query('SELECT COUNT(*) AS n FROM `' + t + '` WHERE tenant_id = ?', [id]);
    if (Number(c.n)) left.push(`${t}: ${c.n}`);
  }
  assert.deepEqual(left, [], 'every table is clean');
  const [[lead]] = await pool.query('SELECT tenant_id FROM sandbox_signups WHERE email = ? ORDER BY id DESC LIMIT 1', [E1]);
  assert.equal(lead.tenant_id, null, 'the sign-up stays as a lead, no longer tied to a mountain');
});

test('the platform console deletes a running demo, or every demo, straight away', async () => {
  const a = await start(`del-a-${Date.now()}@example.test`);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const list = await api('GET', '/platform/sandboxes', { key: KEY });
  const row = list.body.data.find((x) => x.email === a.body.email);
  assert.ok(row && row.active, 'listed as running');
  assert.equal((await api('POST', `/platform/sandboxes/${row.id}/remove`, { key: KEY })).status, 200);
  assert.equal(await tenantId(a.body.tenant), undefined, 'gone at once');
  assert.equal((await api('POST', `/platform/sandboxes/${row.id}/remove`, { key: KEY })).status, 404, 'nothing left to delete');
  assert.ok([401, 403].includes((await api('POST', `/platform/sandboxes/${row.id}/remove`)).status), 'needs the platform key');

  const b = await start(`del-b-${Date.now()}@example.test`);
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const all = await api('POST', '/platform/sandboxes/remove-all', { key: KEY });
  assert.equal(all.status, 200); assert.ok(all.body.removed >= 1);
  assert.equal(await tenantId(b.body.tenant), undefined);
  const [[real]] = await pool.query('SELECT COUNT(*) AS n FROM tenants WHERE sandbox_expires_at IS NULL');
  assert.ok(Number(real.n) > 0, 'real mountains are never touched');
});
