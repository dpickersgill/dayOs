'use strict';

// The collection schedule's library (release 2026.11.22, Trash and recycling, src/lib/collection.js): the rules every
// part of the app and the other two workstreams depend on. Each test fails without its rule: the holiday shift across a
// week (and skip and none), every other week from the anchor, monthly, seasons (and one across New Year), changes and
// cancels by zone, house-number ranges and odd/even sides, "today" in the municipality's own time zone, the day's routes
// in driving order, the add-ons gated by requireAddon, the billing rows, and the migration applying nothing twice.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.USERS_RATE_LIMIT = '1000';
process.env.MODULE_CACHE_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const C = require('../src/lib/collection');
const M = require('../src/lib/modules');
const { createMuniTenant } = require('./helpers/muni');

const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
let server; let base;
let A; let K; let P; let N;
const q = async (sql, params) => (await pool.query(sql, params))[0];
const todayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function street(t, name) { return (await q('INSERT INTO streets (tenant_id, name) VALUES (?, ?)', [t.id, name])).insertId; }
async function stream(t, name, extra = {}) {
  const s = { kind: 'trash', frequency: 'weekly', anchor_date: null, season_start: null, season_end: null, color: '#336699', sort: 10, ...extra };
  return (await q('INSERT INTO collection_streams (tenant_id, name, kind, frequency, anchor_date, season_start, season_end, color, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [t.id, name, s.kind, s.frequency, s.anchor_date, s.season_start, s.season_end, s.color, s.sort])).insertId;
}
async function zone(t, name, days) {
  const id = (await q('INSERT INTO collection_zones (tenant_id, name) VALUES (?, ?)', [t.id, name])).insertId;
  for (const [streamId, weekday] of days) await q('INSERT INTO collection_zone_days (tenant_id, zone_id, stream_id, weekday) VALUES (?, ?, ?, ?)', [t.id, id, streamId, weekday]);
  return id;
}
const days = (t, zoneId, from, to) => C.collectionDays(pool, t.id, { zoneId, from, to });
const dates = async (t, zoneId, from, to, streamId) => (await days(t, zoneId, from, to)).filter((x) => !streamId || x.streamId === streamId).map((x) => x.date);
const rule = (t, r) => q('INSERT INTO collection_settings (tenant_id, holiday_rule) VALUES (?, ?) ON DUPLICATE KEY UPDATE holiday_rule = VALUES(holiday_rule)', [t.id, r]);

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await createMuniTenant(base, { slug: `cl-a-${suffix}`, modules: { solidwaste: true } });
  // The same moment is a different day in these two: Kiritimati is UTC+14, Pago Pago UTC-11.
  K = await createMuniTenant(base, { slug: `cl-k-${suffix}`, modules: { solidwaste: true }, timezone: 'Pacific/Kiritimati' });
  P = await createMuniTenant(base, { slug: `cl-p-${suffix}`, modules: { solidwaste: true }, timezone: 'Pacific/Pago_Pago' });
  N = await createMuniTenant(base, { slug: `cl-n-${suffix}` }); // no Trash and recycling
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('the holiday rule "shift": a holiday on or before the day in the same week moves it, and the rest of the week, one day later', async () => {
  const trash = await stream(A, 'Trash shift');
  const mon = await zone(A, 'Monday', [[trash, 1]]);
  const wed = await zone(A, 'Wednesday', [[trash, 3]]);
  const thu = await zone(A, 'Thursday', [[trash, 4]]);
  const fri = await zone(A, 'Friday', [[trash, 5]]);
  await q('INSERT INTO collection_holidays (tenant_id, on_date, name) VALUES (?, ?, ?), (?, ?, ?)', [A.id, '2026-11-26', 'Thanksgiving Day', A.id, '2026-09-07', 'Labor Day']);
  await rule(A, 'shift');
  // Thanksgiving, a Thursday: Monday and Wednesday stay, Thursday goes to Friday, Friday to Saturday.
  assert.deepEqual(await dates(A, mon, '2026-11-23', '2026-11-29'), ['2026-11-23']);
  assert.deepEqual(await dates(A, wed, '2026-11-23', '2026-11-29'), ['2026-11-25']);
  const th = await days(A, thu, '2026-11-23', '2026-11-29');
  assert.deepEqual(th.map((x) => [x.date, x.original, x.moved, x.reason]), [['2026-11-27', '2026-11-26', true, 'holiday']]);
  assert.deepEqual(await dates(A, fri, '2026-11-23', '2026-11-29'), ['2026-11-28']);
  // Labor Day, a Monday: the whole week slides, and the next week is back to normal.
  assert.deepEqual(await dates(A, mon, '2026-09-07', '2026-09-20'), ['2026-09-08', '2026-09-14']);
  assert.deepEqual(await dates(A, fri, '2026-09-07', '2026-09-20'), ['2026-09-12', '2026-09-18']);
  // A day pushed past the end of the range is left out, and one pushed in from the day before is kept.
  assert.deepEqual(await dates(A, thu, '2026-11-26', '2026-11-26'), []);
  assert.deepEqual(await dates(A, thu, '2026-11-27', '2026-11-27'), ['2026-11-27']);
  // "skip" drops the holiday itself; "none" moves nothing.
  await rule(A, 'skip');
  assert.deepEqual(await dates(A, thu, '2026-11-23', '2026-11-29'), []);
  assert.deepEqual(await dates(A, fri, '2026-11-23', '2026-11-29'), ['2026-11-27']);
  await rule(A, 'none');
  assert.deepEqual(await dates(A, thu, '2026-11-23', '2026-11-29'), ['2026-11-26']);
  await rule(A, 'shift');
});

test('every other week counts from the anchor\'s week, whatever weekday the anchor is; monthly keeps the numbered weekday', async () => {
  const rec = await stream(A, 'Recycling biweekly', { kind: 'recycling', frequency: 'biweekly', anchor_date: '2026-11-02' }); // a Monday
  const z = await zone(A, 'Thursday recycling', [[rec, 4]]);
  assert.deepEqual(await dates(A, z, '2026-11-01', '2026-12-10'), ['2026-11-05', '2026-11-19', '2026-12-03']);
  // A zone on the other weeks is a second stream anchored a week later.
  const rec2 = await stream(A, 'Recycling other week', { kind: 'recycling', frequency: 'biweekly', anchor_date: '2026-11-12' });
  const z2 = await zone(A, 'Thursday recycling B', [[rec2, 4]]);
  assert.deepEqual(await dates(A, z2, '2026-11-01', '2026-12-10'), ['2026-11-12', '2026-11-27', '2026-12-10'], 'Thanksgiving week moves its Thursday to Friday');
  // Across New Year: weeks keep counting.
  assert.deepEqual(await dates(A, z, '2026-12-28', '2027-01-20'), ['2026-12-31', '2027-01-14']);
  const bulk = await stream(A, 'Monthly bulk', { kind: 'other', frequency: 'monthly', anchor_date: '2026-01-14' }); // the 2nd Wednesday
  const zm = await zone(A, 'Monthly zone', [[bulk, 3]]);
  assert.deepEqual(await dates(A, zm, '2026-12-01', '2027-02-28'), ['2026-12-09', '2027-01-13', '2027-02-10']);
});

test('seasons: yard waste only from April 1 to November 30; a season across New Year works; out of season, the next date is next year', async () => {
  const yard = await stream(A, 'Yard waste', { kind: 'yard', season_start: '04-01', season_end: '11-30' });
  const z = await zone(A, 'Yard Monday', [[yard, 1]]);
  assert.deepEqual(await dates(A, z, '2026-11-23', '2026-12-14'), ['2026-11-23', '2026-11-30']);
  assert.deepEqual(await dates(A, z, '2027-03-22', '2027-04-12'), ['2027-04-05', '2027-04-12']);
  const next = await C.nextFor(pool, A.id, { zoneId: z, today: '2026-12-15' });
  assert.equal(next.length, 1);
  assert.equal(next[0].date, '2027-04-05');
  const tree = await stream(A, 'Winter only', { kind: 'other', season_start: '11-01', season_end: '03-31' });
  const zw = await zone(A, 'Winter zone', [[tree, 2]]);
  assert.deepEqual(await dates(A, zw, '2026-10-20', '2026-11-04'), ['2026-11-03']);
  assert.deepEqual(await dates(A, zw, '2027-03-29', '2027-04-07'), ['2027-03-30']);
});

test('changes: a day moved or canceled for the zones listed (or all), matched after the holiday rule; the newest change wins', async () => {
  const trash = await stream(A, 'Trash for changes');
  const z1 = await zone(A, 'Change zone 1', [[trash, 2]]);
  const z2 = await zone(A, 'Change zone 2', [[trash, 2]]);
  const z3 = await zone(A, 'Change zone 3', [[trash, 4]]);
  // Snow on Tuesday December 15 for zone 1 only: moved to Wednesday.
  await q("INSERT INTO collection_changes (tenant_id, on_date, moved_to, zone_ids, reason) VALUES (?, '2026-12-15', '2026-12-16', ?, 'snow')", [A.id, JSON.stringify([z1])]);
  const d1 = await days(A, z1, '2026-12-14', '2026-12-20');
  assert.deepEqual(d1.map((x) => [x.date, x.original, x.moved, x.reason]), [['2026-12-16', '2026-12-15', true, 'snow']]);
  assert.deepEqual(await dates(A, z2, '2026-12-14', '2026-12-20'), ['2026-12-15'], 'zone 2 was not in the change');
  // Canceled for every zone (empty list) on December 22.
  await q("INSERT INTO collection_changes (tenant_id, on_date, moved_to, zone_ids, reason) VALUES (?, '2026-12-22', NULL, '[]', 'weather')", [A.id]);
  assert.deepEqual(await dates(A, z1, '2026-12-21', '2026-12-27'), []);
  assert.deepEqual(await dates(A, z2, '2026-12-21', '2026-12-27'), []);
  // Thanksgiving moved zone 3's Thursday to Friday; a change for that Friday then applies to it.
  await q("INSERT INTO collection_changes (tenant_id, on_date, moved_to, zone_ids, reason) VALUES (?, '2026-11-27', '2026-11-30', ?, 'other')", [A.id, JSON.stringify([z3])]);
  assert.deepEqual((await days(A, z3, '2026-11-23', '2026-12-01')).map((x) => [x.date, x.original, x.reason]), [['2026-11-30', '2026-11-26', 'other']]);
  // A newer change for the same day wins.
  await q("INSERT INTO collection_changes (tenant_id, on_date, moved_to, zone_ids, reason) VALUES (?, '2026-12-15', '2026-12-17', ?, 'snow')", [A.id, JSON.stringify([z1])]);
  assert.deepEqual(await dates(A, z1, '2026-12-14', '2026-12-20'), ['2026-12-17']);
  // A day moved into the range from before it is found.
  assert.deepEqual(await dates(A, z1, '2026-12-17', '2026-12-17'), ['2026-12-17']);
});

test('zoneFor: house-number ranges and odd and even sides, a whole street for the rest, "not collected", and an unknown street', async () => {
  const s = await street(A, `Long Street ${suffix}`);
  const other = await street(A, `Short Lane ${suffix}`);
  const zOdd = await zone(A, 'Odd side', []); const zEven = await zone(A, 'Even side', []); const zRest = await zone(A, 'The rest', []);
  const add = (zoneId, from, to, side, notCollected = 0) => q('INSERT INTO collection_zone_streets (tenant_id, zone_id, street_id, from_no, to_no, side, not_collected) VALUES (?, ?, ?, ?, ?, ?, ?)', [A.id, zoneId, s, from, to, side, notCollected]);
  await add(zRest, null, null, 'both');
  await add(zOdd, 1, 99, 'odd');
  await add(zEven, 1, 99, 'even');
  await add(null, 500, 600, 'both', 1);
  const at = (no) => C.zoneFor(pool, A.id, { streetId: s, houseNo: no });
  assert.deepEqual(await at(13), { zoneId: zOdd, zoneName: 'Odd side' });
  assert.deepEqual(await at('13A'), { zoneId: zOdd, zoneName: 'Odd side' });
  assert.deepEqual(await at('14'), { zoneId: zEven, zoneName: 'Even side' });
  assert.deepEqual(await at(150), { zoneId: zRest, zoneName: 'The rest' });
  assert.deepEqual(await at(101), { zoneId: zRest, zoneName: 'The rest' });
  assert.deepEqual(await at(550), { notCollected: true });
  assert.deepEqual(await at(null), { zoneId: zRest, zoneName: 'The rest' }, 'no number: the whole-street row');
  assert.equal(await C.zoneFor(pool, A.id, { streetId: other, houseNo: 1 }), null);
  // An inactive zone covers nothing.
  await q('UPDATE collection_zones SET active = 0 WHERE tenant_id = ? AND id = ?', [A.id, zOdd]);
  assert.deepEqual(await at(13), { zoneId: zRest, zoneName: 'The rest' });
  // Another municipality's street is not found here.
  assert.equal(await C.zoneFor(pool, K.id, { streetId: s, houseNo: 13 }), null);
});

test('"today" is the municipality\'s own day: Kiritimati and Pago Pago, a day apart at the same moment', async () => {
  const kToday = todayIn('Pacific/Kiritimati'); const pToday = todayIn('Pacific/Pago_Pago');
  assert.notEqual(kToday, pToday);
  for (const [t, today] of [[K, kToday], [P, pToday]]) {
    const s = await stream(t, 'Trash');
    const z = await zone(t, 'Every day of its week', [[s, C.isoDay(today)]]);
    assert.equal(await C.todayFor(pool, t.id), today);
    const next = await C.nextFor(pool, t.id, { zoneId: z });
    assert.equal(next[0].date, today, `${t.slug}: collected today, its own today`);
  }
});

test('dayRoutes: what is collected on a day, zone by zone, streets in the driving order set for that weekday', async () => {
  const T = await createMuniTenant(base, { slug: `cl-r-${suffix}`, modules: { solidwaste: true } });
  const [s1, s2, s3] = [await street(T, 'Alpha Street'), await street(T, 'Bravo Street'), await street(T, 'Charlie Street')];
  const trash = await stream(T, 'Trash'); const rec = await stream(T, 'Recycling', { kind: 'recycling', sort: 20 });
  const z = await zone(T, 'Monday', [[trash, 1], [rec, 1]]);
  const zz = await zone(T, 'Tuesday', [[trash, 2]]);
  for (const sid of [s1, s2, s3]) await q('INSERT INTO collection_zone_streets (tenant_id, zone_id, street_id) VALUES (?, ?, ?)', [T.id, z, sid]);
  await q('INSERT INTO collection_zone_streets (tenant_id, zone_id, street_id, from_no, to_no, side) VALUES (?, ?, ?, 1, 49, ?)', [T.id, zz, s1, 'odd']);
  // Monday's driving order: Charlie, Alpha (Bravo not in it: last).
  await q('INSERT INTO bulk_route_order (tenant_id, weekday, street_id, position) VALUES (?, 1, ?, 1), (?, 1, ?, 2)', [T.id, s3, T.id, s1]);
  const mon = await C.dayRoutes(pool, T.id, '2026-12-07');
  assert.deepEqual(mon.map((r) => [r.zoneName, r.streamName]), [['Monday', 'Trash'], ['Monday', 'Recycling']]);
  assert.deepEqual(mon[0].streets.map((s) => s.name), ['Charlie Street', 'Alpha Street', 'Bravo Street']);
  const tue = await C.dayRoutes(pool, T.id, '2026-12-08');
  assert.deepEqual(tue.map((r) => [r.zoneName, r.streets.map((s) => [s.name, s.fromNo, s.toNo, s.side])]), [['Tuesday', [['Alpha Street', 1, 49, 'odd']]]]);
  // A holiday Monday: the Monday zone is collected Tuesday, in Monday's driving order, marked moved.
  await q("INSERT INTO collection_holidays (tenant_id, on_date, name) VALUES (?, '2026-12-07', 'Test holiday')", [T.id]);
  const moved = await C.dayRoutes(pool, T.id, '2026-12-08');
  assert.deepEqual(moved.map((r) => [r.zoneName, r.streamName, Boolean(r.moved)]), [['Monday', 'Trash', true], ['Monday', 'Recycling', true]], 'Tuesday\'s own collection slid to Wednesday');
  assert.deepEqual((await C.dayRoutes(pool, T.id, '2026-12-09')).map((r) => r.zoneName), ['Tuesday']);
  assert.deepEqual(moved[0].streets.map((s) => s.name), ['Charlie Street', 'Alpha Street', 'Bravo Street']);
  assert.deepEqual(await C.dayRoutes(pool, T.id, '2026-12-07'), []);
});

test('the add-ons: Collection routes and Hauler oversight are off without Trash and recycling, never for a mountain, and requireAddon refuses them', async () => {
  assert.ok(!M.keysFor('mountain').includes('collectionroutes'));
  assert.ok(!M.keysFor('mountain').includes('hauler'));
  assert.deepEqual(M.settle({ collectionroutes: true, hauler: true }, 'municipality').filter((k) => ['solidwaste', 'collectionroutes', 'hauler'].includes(k)), [], 'they never turn Trash and recycling on');
  assert.deepEqual(M.settle({ solidwaste: true, collectionroutes: true }, 'municipality').filter((k) => ['solidwaste', 'collectionroutes', 'hauler'].includes(k)), ['solidwaste', 'collectionroutes']);
  assert.ok(!M.settle({ collectionroutes: true }, 'mountain').includes('collectionroutes'));
  assert.equal(M.PUBLIC.collection, 'solidwaste');
  assert.equal(M.PUBLIC['hauler-report'], 'solidwaste');
  assert.equal(M.PUBLIC['cart-request'], 'solidwaste');
  const run = async (tenantId) => new Promise((resolve) => C.requireAddon('collectionroutes')({ auth: { tenantId } }, {}, (err) => resolve(err || null)));
  const off = await run(A.id);
  assert.equal(off.status, 403);
  assert.equal(off.details.code, 'module_disabled');
  assert.equal(off.details.module, 'collectionroutes');
  await q("INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, 'collectionroutes', 1) ON DUPLICATE KEY UPDATE enabled = 1", [A.id]);
  M.invalidate(A.id);
  assert.equal(await run(A.id), null, 'on: passes');
  // Trash and recycling turned off: the add-on is off with it.
  await q("UPDATE tenant_modules SET enabled = 0 WHERE tenant_id = ? AND module = 'solidwaste'", [A.id]);
  M.invalidate(A.id);
  assert.equal((await run(A.id)).status, 403);
  await q("UPDATE tenant_modules SET enabled = 1 WHERE tenant_id = ? AND module = 'solidwaste'", [A.id]);
  M.invalidate(A.id);
  assert.equal((await run(N.id)).status, 403, 'a municipality without the app');
  assert.throws(() => C.requireAddon('nonsense'));
});

test('billing: Collection routes and Hauler oversight at $1,200 a year each; Trash and recycling stays $1,800 with its new words', async () => {
  const plans = await q("SELECT code, name, kind, modules, monthly_cents, yearly_cents, org_type, blurb FROM billing_plans WHERE code IN ('muni-solidwaste','muni-routes','muni-hauler') ORDER BY code");
  const by = Object.fromEntries(plans.map((p) => [p.code, p]));
  assert.deepEqual([by['muni-routes'].name, by['muni-routes'].modules, by['muni-routes'].monthly_cents, by['muni-routes'].yearly_cents, by['muni-routes'].kind, by['muni-routes'].org_type], ['Collection routes', 'collectionroutes', 10000, 120000, 'addon', 'municipality']);
  assert.deepEqual([by['muni-hauler'].name, by['muni-hauler'].modules, by['muni-hauler'].monthly_cents, by['muni-hauler'].yearly_cents], ['Hauler oversight', 'hauler', 10000, 120000]);
  assert.deepEqual([by['muni-solidwaste'].monthly_cents, by['muni-solidwaste'].yearly_cents], [15000, 180000]);
  assert.match(by['muni-solidwaste'].blurb, /collection schedule and calendar/);
  const apps = await fetch(`${base}/api/v1/billing/apps`, { headers: { authorization: `Bearer ${A.token}` } }).then((r) => r.json());
  const keys = apps.apps.map((a) => a.key);
  assert.ok(keys.includes('collectionroutes') && keys.includes('hauler'), 'Settings, Apps lists them');
});

test('the missed pickup category is renamed by its code, and the migration applies nothing the second time', async () => {
  // A municipality set up before this release has "Missed trash or recycling"; an old request points at it by id.
  const T = await createMuniTenant(base, { slug: `cl-m-${suffix}` });
  await fetch(`${base}/api/v1/requests/meta`, { headers: { authorization: `Bearer ${T.token}` } });
  const cat = (await q("SELECT id, name, code FROM request_categories WHERE tenant_id = ? AND code = 'missed'", [T.id]))[0];
  assert.equal(cat.name, 'Missed pickup', 'a new municipality gets the new name and the code');
  await q("UPDATE request_categories SET name = 'Missed trash or recycling', code = NULL WHERE tenant_id = ? AND id = ?", [T.id, cat.id]);
  await q("DELETE FROM schema_steps WHERE name IN ('request_categories: mark the missed pickup category', 'request_categories: Missed pickup')");
  const out = execFileSync(process.execPath, ['db/migrate.js'], { cwd: require('node:path').join(__dirname, '..'), env: process.env, encoding: 'utf8' });
  assert.match(out, /request_categories: Missed pickup/);
  const after = (await q('SELECT id, name, code FROM request_categories WHERE tenant_id = ? AND id = ?', [T.id, cat.id]))[0];
  assert.deepEqual([after.name, after.code], ['Missed pickup', 'missed']);
  const again = execFileSync(process.execPath, ['db/migrate.js'], { cwd: require('node:path').join(__dirname, '..'), env: process.env, encoding: 'utf8' });
  assert.match(again, /\(0 changes applied\)/);
});
