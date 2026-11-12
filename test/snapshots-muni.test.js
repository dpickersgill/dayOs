'use strict';

// Release 2026.11.21, the forecast fix: forecast data (lib/snapshots.js) is a ski area's. The morning run, a single
// take(), the backfill and scripts/snapshot-backfill.js pass a municipality by, and the migration step
// (db/steps/nav-counts.js) removes the rows an earlier release wrote for municipalities, leaving every ski area's alone.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.WEATHER = 'off'; // no weather lookups: the forecast kind is skipped for everyone here

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const S = require('../src/lib/snapshots');
const { addDays } = require('../src/lib/util');
const { createMuniTenant } = require('./helpers/muni');

const KEY = 'test-bootstrap-key';
const PW = 'correct-horse-battery';
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
let server; let base; let muni; let ski;
const q = async (sql, args) => (await pool.query(sql, args))[0];
const rowsOf = async (tenantId) => Number((await q('SELECT COUNT(*) AS n FROM daily_snapshots WHERE tenant_id = ?', [tenantId]))[0].n);
const tableExists = async (c, name) => (await c.query('SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [name]))[0].length > 0;
const step = () => require('../db/steps/nav-counts')({ tableExists, columnExists: async () => true })[0];
/** Rows as the release before this one wrote them for any tenant: yesterday's presales and staffing, and a backfilled day. */
async function oldRows(tenantId) {
  const day = addDays(S.dateIn('America/New_York'), -1);
  await S.save(pool, tenantId, day, 'presales', { days: [] });
  await S.save(pool, tenantId, day, 'staffing', { shifts: [], worked: [] });
  await S.save(pool, tenantId, addDays(day, -30), 'presales', { days: [] }, { backfilled: true });
}

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  muni = await createMuniTenant(base, { slug: `sm-boro-${suffix}`, name: `Snapshot Borough ${suffix}` });
  const slug = `sm-ski-${suffix}`;
  const made = await fetch(`${base}/api/v1/platform/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-platform-key': KEY }, body: JSON.stringify({ slug, name: `Snapshot Peak ${suffix}`, billing: 'comped', owner: { email: `gm@${slug}.test`, password: PW, first_name: 'Gale', last_name: 'Ridge' } }) });
  assert.equal(made.status, 201);
  ski = { id: Number((await made.json()).id), slug };
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('the migration step removes the rows written for municipalities, keeps every ski area\'s, and is safe to run twice', async () => {
  await oldRows(muni.id); await oldRows(ski.id);
  assert.equal(await rowsOf(muni.id), 3); assert.equal(await rowsOf(ski.id), 3);
  const [name, done, sql] = step();
  assert.match(name, /daily_snapshots/);
  assert.equal(await done(pool), false, 'there is something to remove');
  await pool.query(sql);
  assert.equal(await rowsOf(muni.id), 0, 'the municipality\'s rows are gone');
  assert.equal(await rowsOf(ski.id), 3, 'the ski area\'s are untouched');
  assert.equal(await done(pool), true, 'done: a second migration does nothing');
  await pool.query(sql); // and running it again anyway changes nothing
  assert.equal(await rowsOf(ski.id), 3);
  // A database with no snapshot table yet (an older one) counts as done.
  assert.equal(await require('../db/steps/nav-counts')({ tableExists: async () => false })[0][1](pool), true);
});

test('the morning run never includes a municipality', async () => {
  const none = await S.runAll({ only: muni.id });
  assert.equal(none.mountains, 0, 'not in the run at all, so not in its counts or its time budget');
  assert.equal(none.taken + none.skipped + none.failed, 0);
  assert.equal(await rowsOf(muni.id), 0, 'nothing written');
  const one = await S.runAll({ only: ski.id });
  assert.equal(one.mountains, 1);
  assert.ok(one.taken >= 3, `presales, staffing and prices for the ski area: ${JSON.stringify(one)}`);
  assert.equal(one.failed, 0);
  const today = S.dateIn((await S.tenantRow(pool, ski.id)).timezone);
  assert.deepEqual((await q('SELECT kind FROM daily_snapshots WHERE tenant_id = ? AND on_date = ? ORDER BY kind', [ski.id, today])).map((r) => r.kind), ['presales', 'prices', 'staffing']);
});

test('a single snapshot, and all kinds for one tenant, are skipped for a municipality', async () => {
  for (const kind of S.KINDS) {
    const r = await S.take(pool, muni.id, kind);
    assert.equal(r.status, 'skipped', kind);
    assert.match(r.reason, /municipality/);
  }
  const all = await S.takeAll(pool, await S.tenantRow(pool, muni.id));
  assert.ok(all.length === S.KINDS.length && all.every((r) => r.status === 'skipped'), JSON.stringify(all));
  assert.equal(await rowsOf(muni.id), 0);
  assert.equal((await S.take(pool, ski.id, 'staffing')).status, 'taken', 'a ski area is taken as before');
});

test('the backfill passes a municipality by, and the script lists ski areas only', async () => {
  const r = await S.backfill(pool, muni.id, { from: addDays(S.dateIn('America/New_York'), -10) });
  assert.equal(r.days, 0); assert.match(r.skipped, /municipality/);
  assert.equal(await rowsOf(muni.id), 0);
  const filled = await S.backfill(pool, ski.id, { from: addDays(S.dateIn('America/Denver'), -3) });
  assert.ok(filled.days >= 2 && !filled.skipped, JSON.stringify(filled));
  const script = require('../scripts/snapshot-backfill');
  const list = await script.tenantsToFill();
  assert.ok(list.some((t) => Number(t.id) === ski.id), 'the ski area is in the list');
  assert.ok(!list.some((t) => Number(t.id) === muni.id), 'the municipality is not');
  assert.ok(list.every((t) => t.org_type === 'mountain'));
  // Asked for by id, it is said to be skipped and nothing is written.
  const argv = process.argv; const log = console.log; const said = [];
  process.argv = [argv[0], 'snapshot-backfill.js', '--tenant', String(muni.id)];
  console.log = (...a) => said.push(a.join(' '));
  try { await script.main(); } finally { process.argv = argv; console.log = log; }
  assert.ok(said.some((line) => line.includes(muni.slug) && /skipped/.test(line)), said.join('\n'));
  assert.ok(!said.some((line) => /presales/.test(line)), 'no presales or staffing line for a municipality');
  assert.equal(await rowsOf(muni.id), 0);
});

test('the daily retention run clears anything an old release wrote for a municipality after the migration', async () => {
  await oldRows(muni.id);
  const before = await rowsOf(ski.id);
  await S.purge();
  assert.equal(await rowsOf(muni.id), 0);
  assert.equal(await rowsOf(ski.id), before, 'a ski area keeps its three years');
});
