'use strict';

// The operator's console: add a mountain, switch its apps on and off, pause it, limit its storage, reset a password.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const KEY = 'test-bootstrap-key';

async function api(method, path, { token, key, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'x-platform-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const plat = (method, path, body) => api(method, `/platform${path}`, { key: KEY, body });
const login = async (slug, email, pw = PW) => api('POST', '/auth/login', { body: { tenant: slug, email, password: pw } });

let slug; let id; let owner;
test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  slug = `pf-${suffix}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('the console needs the platform key, and a mountain\'s own login is not enough', async () => {
  assert.equal((await api('GET', '/platform/tenants')).status, 403);
  assert.equal((await api('GET', '/platform/tenants', { key: 'wrong-key' })).status, 403);
  const made = await plat('POST', '/tenants', { slug, name: 'Platform Test', owner: { email: `o@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' }, modules: { rentals: false, patrol: false }, storage_cap_mb: 20 });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  id = made.body.id;
  owner = (await login(slug, `o@${slug}.test`)).body.token;
  assert.equal((await api('GET', '/platform/tenants', { token: owner })).status, 403, 'an owner token is not a platform key');
  const list = await plat('GET', '/tenants');
  const row = list.body.data.find((t) => t.id === id);
  assert.equal(row.status, 'active'); assert.equal(row.storage_cap_mb, 20);
  assert.ok(!row.modules.includes('rentals') && !row.modules.includes('patrol') && row.modules.includes('sell'));
});

test('an app that is off is hidden and refused, and the rest keeps working', async () => {
  const me = await api('GET', '/auth/me', { token: owner });
  assert.ok(!me.body.modules.includes('rentals') && me.body.modules.includes('documents'));
  const r = await api('GET', '/rentals/items', { token: owner });
  assert.equal(r.status, 403); assert.equal(r.body.details.code, 'module_disabled'); assert.equal(r.body.details.module, 'rentals');
  assert.equal((await api('GET', '/patrol/incidents', { token: owner })).status, 403);
  assert.equal((await api('GET', '/documents/categories', { token: owner })).status, 200);
  assert.equal((await api('GET', '/people', { token: owner })).status, 200);
  assert.equal((await api('GET', '/reports/daily', { token: owner })).status, 200, 'the home page numbers are always there');
  // the public guest help page belongs to Patrol
  assert.equal((await api('GET', `/public/${slug}/help`)).body.error, 'Page not found');
});

test('turning an app on takes effect straight away, and apps that need each other move together', async () => {
  let r = await plat('PUT', `/tenants/${id}/modules`, { modules: { rentals: true } });
  assert.equal(r.status, 200); assert.ok(r.body.modules.includes('rentals'));
  assert.equal((await api('GET', '/rentals/items', { token: owner })).status, 200);
  // Sell needs Products and prices: turning Products off takes Sell with it
  r = await plat('PUT', `/tenants/${id}/modules`, { modules: { catalog: false } });
  assert.ok(!r.body.modules.includes('catalog') && !r.body.modules.includes('sell'));
  assert.equal((await api('GET', '/orders', { token: owner })).status, 403);
  // and turning Sell on brings Products back
  r = await plat('PUT', `/tenants/${id}/modules`, { modules: { sell: true } });
  assert.ok(r.body.modules.includes('catalog') && r.body.modules.includes('sell'));
  assert.equal((await api('GET', '/orders', { token: owner })).status, 200);
  assert.equal((await plat('PUT', `/tenants/${id}/modules`, { modules: { spaceship: true } })).status, 400);
});

test('lifts and trails stay readable to the apps that use them', async () => {
  await plat('PUT', `/tenants/${id}/modules`, { modules: { conditions: false, patrol: false, park: false, gate: false } });
  assert.equal((await api('GET', '/schedule/lifts', { token: owner })).status, 403);
  await plat('PUT', `/tenants/${id}/modules`, { modules: { patrol: true } });
  assert.equal((await api('GET', '/schedule/lifts', { token: owner })).status, 200, 'patrol reads the lift list');
  assert.equal((await api('POST', '/schedule/lifts', { token: owner, body: { name: 'X', status: 'closed' } })).status, 403, 'but cannot change it');
  const help = await api('GET', `/public/${slug}/help`);
  assert.notEqual(help.body.error, 'Page not found', 'with Patrol on, the help page answers for itself');
});

test('pausing signs everyone out and shuts the public pages; resuming brings it back', async () => {
  assert.equal((await plat('PATCH', `/tenants/${id}`, { status: 'suspended' })).status, 200);
  assert.equal((await api('GET', '/people', { token: owner })).status, 403);
  const l = await login(slug, `o@${slug}.test`);
  assert.equal(l.status, 403); assert.match(l.body.error, /paused/);
  assert.equal((await api('GET', `/public/${slug}/help`)).status, 404);
  assert.equal((await plat('PATCH', `/tenants/${id}`, { status: 'active' })).status, 200);
  assert.equal((await api('GET', '/people', { token: owner })).status, 200);
});

test('a reset password works and ends old sessions', async () => {
  const detail = await plat('GET', `/tenants/${id}`);
  assert.equal(detail.body.users.length, 1);
  assert.ok(detail.body.history.length >= 4);
  const newPw = 'a-brand-new-password';
  assert.equal((await plat('POST', `/tenants/${id}/reset-password`, { user_id: detail.body.users[0].id, password: newPw })).status, 200);
  await new Promise((r) => setTimeout(r, 1100)); // sessions are cut at whole seconds
  assert.equal((await api('GET', '/people', { token: owner })).status, 401, 'old session ended');
  assert.equal((await login(slug, `o@${slug}.test`)).status, 401, 'old password');
  assert.equal((await login(slug, `o@${slug}.test`, newPw)).status, 200);
  assert.equal((await plat('POST', `/tenants/${id}/reset-password`, { user_id: 999999999, password: newPw })).status, 404);
  assert.equal((await plat('GET', '/audit')).status, 200);
});
