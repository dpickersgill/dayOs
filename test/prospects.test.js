'use strict';

// Prospects in the platform console: a research batch loads once, importing again never overwrites an operator's work,
// the pipeline (stage, next step, timeline) works, people can be added and removed, and only the console can see it.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const P = require('../src/lib/prospects');

let server; let base;
const KEY = 'test-bootstrap-key';
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
async function api(method, p, { key, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(key ? { 'x-platform-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const plat = (method, p, body) => api(method, `/platform${p}`, { key: KEY, body });

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('the shipped research batch is well formed and was loaded by the migration', async () => {
  const file = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'db', 'data', 'prospects-2026-10.json'), 'utf8'));
  assert.ok(file.batch && Array.isArray(file.prospects) && file.prospects.length >= 20);
  for (const p of file.prospects) {
    assert.ok(P.fromResearch(p).name, 'every ski area has a name');
    for (const c of p.contacts || []) assert.ok(!c.name || c.source_url, `${p.name}: ${c.name} needs a source`);
  }
  const [[b]] = await pool.query('SELECT name FROM prospect_batches WHERE name = ?', [file.batch]);
  assert.ok(b, 'the migration loaded the batch');
  const list = await plat('GET', '/prospects?stage=');
  assert.equal(list.status, 200);
  assert.ok(list.body.data.length >= 20);
  assert.ok(!list.body.data.some((p) => p.indy_pass), 'no Indy Pass resorts');
  for (const n of file.excluded_indy_pass || []) assert.ok(!list.body.data.some((p) => p.name === n), `${n} is not on the list`);
  assert.ok(list.body.data.some((p) => p.leader && p.leader.name), 'the list shows who runs each area');
});

test('only the console sees prospects', async () => {
  assert.equal((await api('GET', '/platform/prospects')).status, 403);
  assert.equal((await api('GET', '/platform/prospects', { key: 'wrong' })).status, 403);
});

test('add, pipeline, people and timeline', async () => {
  const name = `Test Hill ${suffix}`;
  assert.equal((await plat('POST', '/prospects', { name, state: 'PA', indy_pass: true })).status, 400, 'Indy Pass resorts stay off the list');
  const made = await plat('POST', '/prospects', { name, state: 'pa', town: 'Testville', vertical_ft: 400, lifts: 3, indy_pass: false, website: '' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.id;
  assert.equal((await plat('POST', '/prospects', { name, state: 'PA' })).status, 400, 'no duplicates');

  const gm = await plat('POST', `/prospects/${id}/contacts`, { role: 'general_manager', name: 'Gina Manager', title: 'General Manager', email: 'gina@testhill.test', source_url: 'https://testhill.test/about' });
  assert.equal(gm.status, 201, JSON.stringify(gm.body));
  assert.equal((await plat('POST', `/prospects/${id}/contacts`, { role: 'patrol_director', email: 'not-an-email' })).status, 400);
  assert.equal((await plat('POST', `/prospects/${id}/contacts`, { role: 'patrol_director' })).status, 400, 'a name, email or phone is needed');
  const pd = await plat('POST', `/prospects/${id}/contacts`, { role: 'patrol_director', name: 'Pat Director' });

  // Logging a call moves it out of research; a stage change writes itself on the timeline.
  assert.equal((await plat('POST', `/prospects/${id}/notes`, { kind: 'call', body: 'Spoke with Gina, wants a demo in November.' })).status, 201);
  let one = await plat('GET', `/prospects/${id}`);
  assert.equal(one.body.stage, 'contacted');
  assert.equal(one.body.state, 'PA');
  assert.equal(one.body.indy_pass, false);
  assert.equal(one.body.website, null);
  assert.equal(one.body.contacts[0].role, 'general_manager', 'the GM comes first');
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  assert.equal((await plat('PATCH', `/prospects/${id}`, { stage: 'demo', next_step: 'Send the demo link', next_on: yesterday, priority: 1 })).status, 200);
  one = await plat('GET', `/prospects/${id}`);
  assert.equal(one.body.stage, 'demo');
  assert.ok(one.body.notes.some((n) => n.kind === 'stage' && n.body.includes('Demo done')));

  const due = await plat('GET', '/prospects?due=1');
  assert.ok(due.body.data.some((p) => p.id === id), 'a follow-up that is due shows in Follow-ups due');
  assert.ok(due.body.due >= 1);
  const found = await plat('GET', `/prospects?q=${encodeURIComponent('Pat Director')}&stage=`);
  assert.ok(found.body.data.some((p) => p.id === id), 'search finds a person');
  const row = found.body.data.find((p) => p.id === id);
  assert.equal(row.leader.name, 'Gina Manager');

  assert.equal((await plat('PATCH', `/prospects/${id}/contacts/${pd.body.id}`, { title: 'Patrol Director' })).status, 200);
  assert.equal((await plat('DELETE', `/prospects/${id}/contacts/${pd.body.id}`)).status, 200);
  assert.equal((await plat('PATCH', `/prospects/${id}/contacts/${pd.body.id}`, { title: 'x' })).status, 404);

  const csv = await fetch(`${base}/api/v1/platform/prospects/export.csv`, { headers: { 'x-platform-key': KEY } });
  const text = await csv.text();
  assert.match(text, /"Ski area","State"/);
  assert.ok(text.includes('Gina Manager'));

  assert.equal((await plat('DELETE', `/prospects/${id}`)).status, 200);
  assert.equal((await plat('GET', `/prospects/${id}`)).status, 404);
});

test('importing again fills gaps and adds new people, but keeps what an operator changed', async () => {
  const name = `Import Hill ${suffix}`;
  const first = await plat('POST', '/prospects/import', { prospects: [{ name, state: 'VT', town: null, size: { vertical_ft: 900 }, contacts: [{ role: 'general_manager', name: 'Old GM', title: 'GM', source_url: 'https://x.test' }] }] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body, { added: 1, updated: 0, contacts: 1, skipped: 0 });
  const id = (await plat('GET', `/prospects?q=${encodeURIComponent(name)}&stage=`)).body.data[0].id;
  await plat('PATCH', `/prospects/${id}`, { vertical_ft: 950, stage: 'talking' });
  const again = await plat('POST', '/prospects/import', [{ name, state: 'VT', town: 'Newtown', size: { vertical_ft: 100 }, contacts: [{ role: 'general_manager', name: 'Old GM' }, { role: 'marketing', name: 'Mia Marketing' }] }, { name: `Indy Hill ${suffix}`, state: 'VT', indy_pass: true }]);
  assert.deepEqual(again.body, { added: 0, updated: 1, contacts: 1, skipped: 1 });
  const one = (await plat('GET', `/prospects/${id}`)).body;
  assert.equal(one.vertical_ft, 950, 'an operator\'s change stays');
  assert.equal(one.town, 'Newtown', 'an empty fact is filled');
  assert.equal(one.stage, 'talking');
  assert.equal(one.contacts.length, 2);
  assert.equal((await plat('POST', '/prospects/import', { prospects: [] })).status, 400);
  await plat('DELETE', `/prospects/${id}`);
});
