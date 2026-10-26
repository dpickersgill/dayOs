'use strict';

// Patrol kits: start from the suggested lists, add numbered kits, check them (ready only when every item is there and
// nothing has expired), sign off an unbroken seal when seals are on, take supplies off for a case (needs restock), and
// restock. A check sent twice from a phone counts once, and only those who manage equipment change the lists.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const K = require('../src/lib/patrolkits');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);
const M = {};
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const plus = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

test('the rules: ready only when full and in date; use takes stock off; the board', () => {
  const contents = [{ key: 'gauze', label: 'Gauze', qty: 10, expires: true }, { key: 'shears', label: 'Shears', qty: 1, expires: false }];
  let e = K.evaluate(contents, { gauze: { qty: 10, expires_on: '2027-01-01' }, shears: { qty: 1 } }, '2026-12-01');
  assert.equal(e.result, 'ready'); assert.equal(e.earliest, '2027-01-01');
  e = K.evaluate(contents, { gauze: { qty: 8, expires_on: '2026-11-01' }, shears: { qty: 1 } }, '2026-12-01');
  assert.equal(e.result, 'not_ready'); assert.equal(e.short[0].have, 8); assert.equal(e.expired[0].key, 'gauze');
  assert.deepEqual(K.afterUse({ gauze: { qty: 10, expires_on: 'x' } }, { gauze: 3 }), { gauze: { qty: 7, expires_on: 'x' } });
  const type = { every_days: 7 };
  assert.equal(K.standing({ status: 'ready', last_check_at: null }, type, '2026-12-10'), 'check_due');
  assert.equal(K.standing({ status: 'ready', last_check_at: '2026-12-05 08:00:00' }, type, '2026-12-10'), 'ready');
  assert.equal(K.standing({ status: 'ready', last_check_at: '2026-12-03 08:00:00' }, type, '2026-12-10'), 'check_due');
  assert.equal(K.standing({ status: 'ready', last_check_at: '2026-12-09 08:00:00', earliest_expiry: '2026-12-01' }, type, '2026-12-10'), 'expired');
  assert.ok(K.STARTERS.every((s) => new Set(s.contents.map((c) => c.key)).size === s.contents.length), 'item keys are unique');
});

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const slug = `kt-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Kit Peak', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  M.owner = await login(`owner@${slug}.test`);
  M.pat = Number(ok(await api('POST', '/patrol/team', { token: M.owner, body: { person: { first_name: 'Pat', last_name: 'Ridge' }, level: 'patroller' } })).staff_id);
  ok(await api('POST', '/users', { token: M.owner, body: { email: `pat@${slug}.test`, password: PW, role: 'patrol', staff_id: M.pat } }));
  M.patT = await login(`pat@${slug}.test`);
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('set up from the suggested lists, then numbered kits', async () => {
  const first = ok(await api('GET', '/patrol/kits', { token: M.patT }));
  assert.equal(first.types.length, 0); assert.equal(first.starters.length, 3); assert.equal(first.can_manage, false);
  is(await api('POST', '/patrol/kits/types/starter', { token: M.patT, body: { names: ['Trauma bag'] } }), 403);
  ok(await api('POST', '/patrol/kits/types/starter', { token: M.owner, body: { names: ['Trauma bag', 'Lift evacuation kit'] } }));
  const r = ok(await api('GET', '/patrol/kits', { token: M.owner }));
  M.tb = r.types.find((x) => x.name === 'Trauma bag');
  is(await api('PATCH', `/patrol/kits/types/${M.tb.id}`, { token: M.owner, body: { contents: [{ key: 'a', label: 'A', qty: 1 }, { key: 'a', label: 'B', qty: 1 }] } }), 400, 'item names must differ');
  // a short list keeps the test readable
  ok(await api('PATCH', `/patrol/kits/types/${M.tb.id}`, { token: M.owner, body: { every_days: 1, contents: [{ key: 'gauze', label: 'Gauze pads', qty: 10, expires: true }, { key: 'shears', label: 'Trauma shears', qty: 1 }] } }));
  const made = ok(await api('POST', '/patrol/kits', { token: M.owner, body: { type_id: M.tb.id, count: 2, location: 'Top shack' } })).data;
  assert.deepEqual(made.map((x) => x.label), ['TB-1', 'TB-2']);
  M.kit = made[0].id;
  const b = ok(await api('GET', '/patrol/kits', { token: M.patT }));
  assert.equal(b.kits.find((k) => k.id === M.kit).standing, 'check_due', 'a new kit needs a check');
});

test('a check: not ready when short or out of date; ready when full; sent twice, kept once', async () => {
  const short = ok(await api('POST', `/patrol/kits/${M.kit}/checks`, { token: M.patT, body: { kind: 'full', items: { gauze: { qty: 6, expires_on: plus(today, 200) }, shears: { qty: 1 } } } }));
  assert.equal(short.result, 'not_ready');
  const body = { kind: 'full', items: { gauze: { qty: 10, expires_on: plus(today, 200) }, shears: { qty: 1 } }, client_ref: `kit${suffix}` };
  const a = ok(await api('POST', `/patrol/kits/${M.kit}/checks`, { token: M.patT, body }));
  const b = ok(await api('POST', `/patrol/kits/${M.kit}/checks`, { token: M.patT, body }));
  assert.equal(a.id, b.id); assert.equal(a.result, 'ready');
  const k = ok(await api('GET', `/patrol/kits/${M.kit}`, { token: M.patT }));
  assert.equal(k.kit.standing, 'ready'); assert.equal(k.kit.earliest_expiry, plus(today, 200));
  assert.equal(k.checks.length, 2);
  const old = ok(await api('POST', `/patrol/kits/${M.kit}/checks`, { token: M.patT, body: { kind: 'full', items: { gauze: { qty: 10, expires_on: plus(today, -1) }, shears: { qty: 1 } } } }));
  assert.equal(old.result, 'not_ready');
  assert.equal(ok(await api('GET', `/patrol/kits/${M.kit}`, { token: M.patT })).kit.standing, 'expired');
});

test('seals: only when the patrol uses them, and only the same number signs it off', async () => {
  is(await api('POST', `/patrol/kits/${M.kit}/checks`, { token: M.patT, body: { kind: 'seal', seal_no: '123' } }), 409, 'seals are off');
  ok(await api('PUT', '/patrol/ops-settings', { token: M.owner, body: { kit_seals: true } }));
  ok(await api('POST', `/patrol/kits/${M.kit}/checks`, { token: M.patT, body: { kind: 'restock', items: { gauze: { qty: 10, expires_on: plus(today, 300) } }, seal_no: 'S-5501' } }));
  let k = ok(await api('GET', `/patrol/kits/${M.kit}`, { token: M.patT })).kit;
  assert.equal(k.standing, 'ready'); assert.equal(k.sealed, true); assert.equal(k.seal_no, 'S-5501');
  is(await api('POST', `/patrol/kits/${M.kit}/checks`, { token: M.patT, body: { kind: 'seal', seal_no: 'S-9999' } }), 409, 'a different seal means a full check');
  assert.equal(ok(await api('POST', `/patrol/kits/${M.kit}/checks`, { token: M.patT, body: { kind: 'seal', seal_no: 'S-5501' } })).result, 'ready');
  k = ok(await api('GET', `/patrol/kits/${M.kit}`, { token: M.patT })).kit;
  assert.equal(k.stock.gauze.qty, 10);
});

test('supplies used on a case: the kit needs a restock, and the case shows what came from where', async () => {
  const c = ok(await api('POST', '/patrol/incidents', { token: M.patT, body: { occurred_at: `${today}T10:15`, location: 'Ridge', category: 'injury', severity: 'minor', summary: 'Cut' } }));
  is(await api('POST', `/patrol/kits/${M.kit}/checks`, { token: M.patT, body: { kind: 'use', incident_id: c.id } }), 400, 'say what was used');
  ok(await api('POST', `/patrol/kits/${M.kit}/checks`, { token: M.patT, body: { kind: 'use', used: { gauze: 4 }, incident_id: c.id } }));
  const k = ok(await api('GET', `/patrol/kits/${M.kit}`, { token: M.patT })).kit;
  assert.equal(k.standing, 'needs_restock'); assert.equal(k.stock.gauze.qty, 6); assert.equal(k.sealed, false, 'opened, so the seal is gone');
  const use = ok(await api('GET', `/patrol/incidents/${c.id}/kit-use`, { token: M.patT })).data;
  assert.equal(use[0].label, 'TB-1'); assert.deepEqual(use[0].items, { gauze: 4 });
  assert.equal(ok(await api('POST', `/patrol/kits/${M.kit}/checks`, { token: M.patT, body: { kind: 'restock', items: {} } })).result, 'ready');
  // out of service stays out until a full check or restock
  ok(await api('PATCH', `/patrol/kits/${M.kit}`, { token: M.owner, body: { out_of_service: true } }));
  assert.equal(ok(await api('GET', `/patrol/kits/${M.kit}`, { token: M.patT })).kit.standing, 'out_of_service');
  is(await api('PATCH', `/patrol/kits/${M.kit}`, { token: M.patT, body: { out_of_service: false } }), 403);
});
