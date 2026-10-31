'use strict';

// Lift inspections by lift type (2026.11.10, SLIM 7d): a type on each lift, built-in daily and weekly lists per type,
// the mountain's own copies, an inspection started from the lift's type and ticked item by item with who and when,
// sign-off, a failed required item that keeps the lift from opening (daily: today; weekly: until a new weekly passes),
// a failed optional item that opens a work order but passes, the older one-step form still counting, and other
// mountains kept out.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.MODULE_CACHE_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const L = require('../src/lib/liftchecks');
const O = require('../src/lib/ops');

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

async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const l = await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } });
  const [[t]] = await pool.query('SELECT id, timezone FROM tenants WHERE slug = ?', [slug]);
  return { slug, owner: l.body.token, id: Number(t.id), tz: t.timezone };
}
async function addUser(m, email, role) {
  ok(await api('POST', '/users', { token: m.owner, body: { email, password: PW, role } }));
  return (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token;
}

let M; let X; const T = {};
test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  M = await mountain(`lc-${suffix}`);
  X = await mountain(`lx-${suffix}`);
  T.staff = await addUser(M, `lifty@${M.slug}.test`, 'staff');
  T.manager = await addUser(M, `gm@${M.slug}.test`, 'manager');
  T.counter = await addUser(M, `counter@${M.slug}.test`, 'counter');
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

const newLift = async (name, type) => {
  const l = ok(await api('POST', '/schedule/lifts', { token: M.owner, body: { name } }));
  if (type) ok(await api('PATCH', `/ops/lifts/${l.id}/type`, { token: T.manager, body: { lift_type: type } }));
  return l.id;
};
const start = (id, kind = 'daily', token = T.staff) => api('POST', `/ops/lifts/${id}/inspections`, { token, body: { kind } });
const tick = (cid, items, token = T.staff) => api('PATCH', `/ops/lift-inspections/${cid}`, { token, body: { items } });
const finish = (cid, note, token = T.staff) => api('POST', `/ops/lift-inspections/${cid}/finish`, { token, body: { note } });
const passAll = (c) => c.items.map((i) => ({ key: i.key, result: 'pass' }));
const setOpen = (id) => api('PATCH', `/schedule/lifts/${id}`, { token: T.staff, body: { status: 'open' } });

test('every lift type has a daily and a weekly list in plain words, with unique keys and required items', () => {
  assert.deepEqual(L.TYPE_KEYS, ['fixed_grip', 'detachable', 'gondola_tram', 'surface', 'carpet']);
  for (const t of L.TYPE_KEYS) {
    for (const k of L.KIND_KEYS) {
      const list = L.builtIn(t, k);
      assert.ok(list.length >= 7, `${t} ${k} has items`);
      assert.equal(new Set(list.map((i) => i.key)).size, list.length, `${t} ${k} keys are unique`);
      assert.ok(list.some((i) => i.required), `${t} ${k} has required items`);
      assert.ok(list.every((i) => /^[a-z_]+$/.test(i.key) && i.label.length > 8 && !/[—–$]/.test(i.label) && !/B77/.test(i.label)), `${t} ${k} items are plain`);
    }
  }
  assert.ok(L.builtIn('detachable', 'daily').some((i) => i.key === 'grip_test'), 'detachables test grips every day');
  assert.ok(L.builtIn('surface', 'daily').some((i) => i.key === 'safety_gate'), 'surface lifts test the stop gate');
  // A lift with no type keeps the standard list it always had.
  assert.deepEqual(L.builtIn(null, 'daily').map((i) => i.key), O.LIFT_CHECKLIST.map((i) => i.key));
});

test('a manager sets a lift\'s type; staff and counter cannot', async () => {
  const id = ok(await api('POST', '/schedule/lifts', { token: M.owner, body: { name: `Typed ${suffix}` } })).id;
  is(await api('PATCH', `/ops/lifts/${id}/type`, { token: T.staff, body: { lift_type: 'carpet' } }), 403);
  is(await api('PATCH', `/ops/lifts/${id}/type`, { token: T.manager, body: { lift_type: 'escalator' } }), 400);
  const r = ok(await api('PATCH', `/ops/lifts/${id}/type`, { token: T.manager, body: { lift_type: 'carpet' } }));
  assert.equal(r.lift_type_label, 'Conveyor (magic carpet)');
  is(await api('GET', '/ops/lift-types', { token: T.counter }), 403);
  const meta = ok(await api('GET', '/ops/lift-types', { token: T.staff }));
  assert.equal(meta.types.length, 5);
  assert.equal(meta.types.find((t) => t.key === 'carpet').lists.daily.custom, false);
});

test('starting an inspection uses the lift\'s type, and the mountain\'s own copy once it has one', async () => {
  const id = await newLift(`Bunny Carpet ${suffix}`, 'carpet');
  const c = ok(await start(id));
  assert.equal(c.status, 'in_progress');
  assert.deepEqual(c.items.map((i) => i.key), L.builtIn('carpet', 'daily').map((i) => i.key));
  assert.ok(c.started_by && c.started_at, 'who started it and when');
  // Starting again picks up the same one.
  assert.equal(ok(await start(id)).id, c.id);

  // The mountain edits its copy: a reworded item keeps its key, a new item gets one, required can be turned off.
  is(await api('PUT', '/ops/lift-templates/carpet/daily', { token: T.staff, body: { items: [{ label: 'x' }] } }), 403);
  const base0 = L.builtIn('carpet', 'daily');
  const mine = [{ key: base0[0].key, label: 'Belt clean and dry', required: true }, { label: 'Heat tape on below 20 degrees', required: false }, { label: 'Stop buttons tested at both ends' }];
  const saved = ok(await api('PUT', '/ops/lift-templates/carpet/daily', { token: T.manager, body: { items: mine } }));
  assert.equal(saved.custom, true);
  assert.deepEqual(saved.items.map((i) => i.key), [base0[0].key, 'heat_tape_on_below_20_degrees', 'stop_buttons_tested_at_both_ends']);
  assert.deepEqual(saved.items.map((i) => i.required), [true, false, true]);
  // The inspection already started keeps its words.
  assert.equal(ok(await api('GET', `/ops/lift-inspections/${c.id}`, { token: T.staff })).items[0].label, base0[0].label);
  // Another carpet started now uses the copy.
  const id2 = await newLift(`Tubing Carpet ${suffix}`, 'carpet');
  const c2 = ok(await start(id2));
  assert.deepEqual(c2.items.map((i) => i.label), ['Belt clean and dry', 'Heat tape on below 20 degrees', 'Stop buttons tested at both ends']);
  // Back to the built-in list.
  assert.equal(ok(await api('PUT', '/ops/lift-templates/carpet/daily', { token: T.manager, body: { items: null } })).custom, false);
  is(await api('PUT', '/ops/lift-templates/escalator/daily', { token: T.manager, body: { items: null } }), 404);
  // Another mountain's lists are its own.
  const theirs = ok(await api('GET', '/ops/lift-types', { token: X.owner }));
  assert.equal(theirs.types.find((t) => t.key === 'carpet').lists.daily.custom, false);
});

test('results keep who and when on every item; sign-off needs every item answered and a note on a failed one', async () => {
  const id = await newLift(`Summit Double ${suffix}`, 'fixed_grip');
  const c = ok(await start(id));
  const ticked = ok(await tick(c.id, [{ key: c.items[0].key, result: 'pass' }]));
  assert.equal(ticked.items[0].result, 'pass');
  assert.ok(ticked.items[0].at && ticked.items[0].by, 'who and when');
  is(await tick(c.id, [{ key: 'nope', result: 'pass' }]), 400);
  const req = c.items.find((i) => i.required); const opt = c.items.find((i) => !i.required);
  is(await tick(c.id, [{ key: req.key, result: 'na' }]), 400, 'a required item is never not applicable');
  ok(await tick(c.id, [{ key: opt.key, result: 'na' }]));
  is(await finish(c.id), 400, 'items still to check');
  ok(await tick(c.id, passAll(c).filter((i) => i.key !== opt.key)));
  const f = ok(await finish(c.id, 'All good'));
  assert.equal(f.status, 'pass');
  assert.ok(f.finished_by && f.finished_at);
  assert.equal(f.work_order_id, null);
  is(await tick(c.id, passAll(c)), 409, 'signed off');
  is(await finish(c.id), 409);
  // It is written to the inspection record the board and reports read.
  const [[k]] = await pool.query("SELECT result, kind, inspector FROM lift_checks WHERE tenant_id = ? AND lift_id = ? ORDER BY id DESC LIMIT 1", [M.id, id]);
  assert.deepEqual({ result: k.result, kind: k.kind }, { result: 'pass', kind: 'pre_open' });
  const day = ok(await api('GET', '/ops/lift-inspections/day', { token: T.staff }));
  const row = day.data.find((r) => r.id === id);
  assert.equal(row.daily_result, 'pass');
  assert.equal(row.blocked, false);
  assert.equal(row.weekly_due, true, 'no weekly inspection yet');
  ok(await setOpen(id));
});

test('a failed required item fails the inspection, opens a work order and keeps the lift from opening until one passes', async () => {
  const id = await newLift(`East T-Bar ${suffix}`, 'surface');
  const c = ok(await start(id));
  const gate = c.items.find((i) => i.key === 'safety_gate');
  ok(await tick(c.id, [{ key: gate.key, result: 'fail' }]));
  is(await finish(c.id), 400, 'say what is wrong');
  ok(await tick(c.id, [{ key: gate.key, result: 'fail', note: 'Gate does not stop the lift' }]));
  const f = ok(await finish(c.id));
  assert.equal(f.status, 'fail', 'fails before the rest are answered');
  assert.ok(f.work_order_id);
  const [[wo]] = await pool.query('SELECT priority, lift_id, source, description FROM work_orders WHERE tenant_id = ? AND id = ?', [M.id, f.work_order_id]);
  assert.equal(wo.priority, 'high'); assert.equal(Number(wo.lift_id), id); assert.equal(wo.source, 'inspection');
  assert.match(wo.description, /Gate does not stop the lift/);
  const r = await setOpen(id);
  is(r, 409); assert.match(r.body.error, /failed its inspection today/);
  assert.equal(ok(await api('GET', '/ops/lift-inspections/day', { token: T.staff })).data.find((x) => x.id === id).blocked, true);
  // A new inspection started (not yet signed off) does not clear it.
  const c2 = ok(await start(id));
  assert.notEqual(c2.id, c.id);
  is(await setOpen(id), 409);
  ok(await tick(c2.id, passAll(c2)));
  assert.equal(ok(await finish(c2.id)).status, 'pass');
  ok(await setOpen(id));
});

test('a failed optional item opens a work order but the inspection passes', async () => {
  const id = await newLift(`West Carpet ${suffix}`, 'carpet');
  const c = ok(await start(id));
  const opt = c.items.find((i) => !i.required);
  ok(await tick(c.id, passAll(c).map((i) => (i.key === opt.key ? { key: i.key, result: 'fail', note: 'Canopy light out' } : i))));
  const f = ok(await finish(c.id));
  assert.equal(f.status, 'pass');
  assert.ok(f.work_order_id, 'the problem still goes to the mechanics');
  ok(await setOpen(id));
});

test('a failed weekly inspection keeps the lift closed on later days until a weekly one passes', async () => {
  const id = await newLift(`North Detach ${suffix}`, 'detachable');
  const w = ok(await start(id, 'periodic'));
  assert.equal(w.kind, 'periodic');
  assert.deepEqual(w.items.map((i) => i.key), L.builtIn('detachable', 'periodic').map((i) => i.key));
  ok(await tick(w.id, [{ key: 'brake_test', result: 'fail', note: 'Stopping distance too long' }]));
  assert.equal(ok(await finish(w.id)).status, 'fail');
  // Move it to last week: a daily pass today does not clear a failed weekly.
  await pool.query("UPDATE lift_checks SET check_date = DATE_SUB(check_date, INTERVAL 3 DAY) WHERE tenant_id = ? AND lift_id = ? AND kind = 'periodic'", [M.id, id]);
  const d = ok(await start(id));
  ok(await tick(d.id, passAll(d)));
  assert.equal(ok(await finish(d.id)).status, 'pass');
  const r = await setOpen(id);
  is(r, 409); assert.match(r.body.error, /weekly inspection/);
  const row = ok(await api('GET', '/ops/lift-inspections/day', { token: T.staff })).data.find((x) => x.id === id);
  assert.equal(row.blocked, true); assert.equal(row.weekly_result, 'fail'); assert.equal(row.weekly_due, true);
  const w2 = ok(await start(id, 'periodic'));
  ok(await tick(w2.id, passAll(w2)));
  assert.equal(ok(await finish(w2.id)).status, 'pass');
  ok(await setOpen(id));
  const row2 = ok(await api('GET', '/ops/lift-inspections/day', { token: T.staff })).data.find((x) => x.id === id);
  assert.equal(row2.weekly_due, false); assert.equal(row2.blocked, false);
});

test('a lift with no type uses the standard list, and the older one-step form still counts', async () => {
  const id = await newLift(`Old Chair ${suffix}`, null);
  const c = ok(await start(id));
  assert.deepEqual(c.items.map((i) => i.key), O.LIFT_CHECKLIST.map((i) => i.key));
  const items = O.LIFT_CHECKLIST.map((i, n) => ({ key: i.key, result: n ? 'pass' : 'fail', note: n ? null : 'Ice on the ramp' }));
  ok(await api('POST', '/ops/lift-checks', { token: T.staff, body: { lift_id: id, items } }));
  const row = ok(await api('GET', '/ops/lift-inspections/day', { token: T.staff })).data.find((x) => x.id === id);
  assert.equal(row.daily_result, 'fail'); assert.equal(row.blocked, true);
  is(await setOpen(id), 409);
});

test('another mountain cannot see, start, tick or sign off this mountain\'s inspections or lists', async () => {
  const id = await newLift(`Private Lift ${suffix}`, 'gondola_tram');
  const c = ok(await start(id));
  is(await api('GET', `/ops/lift-inspections/${c.id}`, { token: X.owner }), 404);
  is(await api('GET', `/ops/lifts/${id}/inspections`, { token: X.owner }), 404);
  is(await api('POST', `/ops/lifts/${id}/inspections`, { token: X.owner, body: { kind: 'daily' } }), 404);
  is(await api('PATCH', `/ops/lift-inspections/${c.id}`, { token: X.owner, body: { items: [{ key: c.items[0].key, result: 'pass' }] } }), 404);
  is(await api('POST', `/ops/lift-inspections/${c.id}/finish`, { token: X.owner, body: {} }), 404);
  is(await api('PATCH', `/ops/lifts/${id}/type`, { token: X.owner, body: { lift_type: 'carpet' } }), 404);
  const day = ok(await api('GET', '/ops/lift-inspections/day', { token: X.owner }));
  assert.ok(!day.data.some((r) => r.id === id));
  // History is this mountain's.
  assert.equal(ok(await api('GET', `/ops/lifts/${id}/inspections`, { token: T.staff })).data[0].id, c.id);
});
