'use strict';

// The injury network: mountains choose to share de-identified injury counts; the platform's network report counts
// only those mountains, only finished reports, hides any count under 5 (and a second cell where one could be worked
// out), and never carries a name, age, free text or place; each sharing mountain sees how it compares, with early
// warnings only for itself; stopping sharing takes a mountain out at once.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const S = require('../src/lib/safety');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const KEY = 'test-bootstrap-key';
const SEASON = '2025-26';

async function api(method, path, { token, body, key } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'x-platform-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);
const plat = (path) => api('GET', `/platform${path}`, { key: KEY });

const M = {};
async function mountain(name) {
  const slug = `${name}-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': KEY }, body: JSON.stringify({ slug, name: `${name.toUpperCase()} Mountain ${suffix}`, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const token = (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token;
  const [[t]] = await pool.query('SELECT id, name FROM tenants WHERE slug = ?', [slug]);
  return { slug, token, id: Number(t.id), name: t.name };
}

// Words that must never reach the network report: they are in the patient records below.
const SECRETS = ['Zebediah', 'Quillfeather', 'Secret Glade', 'Townsville', 'hit the lip', 'St Mercy', '555-0199', '1990-02-03', 'Hidden Bowl'];

let day = 0;
/** One finished report with one patient, written straight to the tables the patrol app writes. */
async function patient(m, { pform = {}, cform = {}, injuries = [['knee', 'sprain_strain']], state = 'approved', voided = false, category = 'injury', age = 30, dob = null, sex = 'female', disposition = 'treated_released', hour = 11 } = {}) {
  day = (day % 27) + 1;
  const at = `2026-01-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:20:00`;
  const [i] = await pool.query("INSERT INTO incidents (tenant_id, occurred_at, location, category, severity, summary, narrative, report_state, form) VALUES (?, ?, 'Secret Glade', ?, 'moderate', 'Zebediah fell at Secret Glade', 'He said he hit the lip', ?, ?)",
    [m.id, at, category, state, JSON.stringify({ incident_location: 'marked_run', run_classification: 'more_difficult', surface: 'groomed', light: 'flat', weather: 'snowing', park_feature: 'Hidden Bowl jump', ...cform })]);
  const [p] = await pool.query(`INSERT INTO incident_patients (tenant_id, incident_id, first_name, last_name, date_of_birth, age_years, sex, phone, home_town, disposition, destination, form, voided_at)
     VALUES (?, ?, 'Zebediah', 'Quillfeather', ?, ?, ?, '555-0199', 'Townsville', ?, 'St Mercy', ?, ?)`,
  [m.id, i.insertId, dob, dob ? null : age, sex, disposition, JSON.stringify({ activity: 'alpine', ability: 'beginner', helmet: 'owned', patient_type: 'guest', description: 'I hit the lip of the jump', hospital_name: 'St Mercy', ...pform }), voided ? '2026-01-30 10:00:00' : null]);
  for (const [region, type] of injuries) await pool.query("INSERT INTO incident_injuries (tenant_id, patient_id, body_region, side, injury_type, notes) VALUES (?, ?, ?, 'left', ?, 'Zebediah said it hurt')", [m.id, p.insertId, region, type]);
}
const many = async (m, n, opts) => { for (let k = 0; k < n; k += 1) await patient(m, opts); };

/** Skier visits: `tickets` tickets each scanned on `days` days (twice a day, so only the first counts), plus a refused scan. */
async function visits(m, tickets, days) {
  const values = [];
  for (let t = 0; t < tickets; t += 1) {
    for (let d = 1; d <= days; d += 1) {
      const dd = String(d).padStart(2, '0');
      values.push([m.id, 900000 + t, 'X'.repeat(20), 'ok', `2026-01-${dd} 16:00:00`], [m.id, 900000 + t, 'X'.repeat(20), 'ok', `2026-01-${dd} 20:00:00`], [m.id, 900000 + t, 'X'.repeat(20), 'duplicate', `2026-01-${dd} 20:00:05`]);
    }
  }
  await pool.query('INSERT INTO scans (tenant_id, ticket_id, code, result, scanned_at) VALUES ?', [values]);
}
const share = (m, extra = {}) => api('PUT', '/patrol/network/sharing', { token: m.token, body: { share: true, named: false, region: 'rocky_mountain', state: 'Colorado', agree: true, signer_name: 'Pat Director', signer_title: 'Patrol director', ...extra } });

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  // The test database is shared with earlier runs: start this network from nobody sharing.
  await pool.query('UPDATE safety_sharing SET share = 0');
  for (const k of ['a', 'b', 'c', 'd', 'e']) M[k] = await mountain(`sf${k}`);

  // A: 10 beginners falling off the lift, 6 snowboard wrist fractures, plus records that must not count.
  await many(M.a, 10, { pform: { collided: 'no', cause: 'lift_fall_unloading' }, cform: { incident_location: 'lift_incident', run_classification: 'na' } });
  await many(M.a, 6, { pform: { activity: 'snowboard', ability: 'intermediate', collided: 'no', cause: 'fall_caught_edge' }, injuries: [['wrist_hand', 'fracture']], dob: '1990-02-03' });
  await many(M.a, 2, { pform: { patient_type: 'staff_work', collided: 'no', cause: 'fall_lost_control' } });
  await patient(M.a, { pform: { involvement: 'competition', collided: 'no', cause: 'fall_jumping' } });
  await patient(M.a, { category: 'medical', injuries: [['chest', 'cardiac']], disposition: 'transported_ambulance' });
  await patient(M.a, { state: 'draft' });
  await patient(M.a, { voided: true });
  await visits(M.a, 50, 20); // 1,000 visits

  // B: 8 falls, 9 lift unloading, 4 near collisions (a small count that has to be hidden).
  await many(M.b, 8, { pform: { collided: 'no', cause: 'fall_lost_control' } });
  await many(M.b, 9, { pform: { collided: 'no', cause: 'lift_fall_unloading' } });
  await many(M.b, 4, { pform: { collided: 'no', cause: 'near_collision' } });
  await visits(M.b, 100, 20); // 2,000 visits
  // C: 8 snowboard falls.
  await many(M.c, 8, { pform: { activity: 'snowboard', collided: 'no', cause: 'fall_terrain' }, sex: 'male' });
  await visits(M.c, 30, 10); // 300 visits
  // E: 8 collisions.
  await many(M.e, 8, { pform: { collided: 'yes' }, injuries: [['head', 'concussion']], age: 15 });
  await visits(M.e, 50, 20); // 1,000 visits
  // D never shares.
  await many(M.d, 9, { pform: { collided: 'no', cause: 'fall_lost_control' } });
  await visits(M.d, 10, 10);
});
test.after(async () => {
  await pool.query('UPDATE safety_sharing SET share = 0 WHERE tenant_id IN (?)', [Object.values(M).map((m) => m.id)]);
  await new Promise((r) => server.close(r)); await pool.end();
});

test('a patient becomes categories and nothing else', () => {
  const c = S.classify({ tenant_id: 1, category: 'injury', month: '2026-01', hr: 15, activity: null, ability: null, helmet: 'unknown', sex: 'male', disposition: 'transported_ambulance', age: 9,
    pform: JSON.stringify({ activity: 'telemark', ability: 'novice', helmet: 'rental', collided: 'no', cause: 'lift_fall_loading', to_first_aid: 'toboggan', description: 'secret words' }),
    cform: JSON.stringify({ incident_location: 'half_pipe', run_classification: 'extreme', surface: 'moguls', light: 'whiteout', weather: 'fog' }) },
  [{ body_region: 'ankle_foot', injury_type: 'fracture' }, { body_region: 'chest', injury_type: 'illness' }]);
  assert.deepEqual(c.cats, { activity: 'ski', ability: 'beginner', age: '0_12', sex: 'male', helmet: 'yes', cause: 'lift_loading', location: 'terrain_park', run: 'extreme', surface: 'moguls', light: 'whiteout', weather: 'fog', time: '14_16', month: '2026-01', outcome: 'transported_ambulance', to_aid: 'toboggan' });
  assert.deepEqual(c.injuries, [['lower_leg', 'fracture']], 'a medical entry is not an injury');
  assert.deepEqual(c.excluded, []);
  assert.ok(!JSON.stringify(c).includes('secret'));
  // NSAA's usual exclusions
  const ex = (pform, more = {}) => S.classify({ tenant_id: 1, hr: 9, month: '2026-01', category: 'injury', ...more, pform: JSON.stringify(pform) }, more.inj || []).excluded;
  assert.deepEqual(ex({ patient_type: 'staff_work' }), ['staff']);
  assert.deepEqual(ex({ involvement: 'training' }), ['competition']);
  assert.deepEqual(ex({ cause: 'prior_medical' }), ['medical']);
  assert.deepEqual(ex({}, { category: 'medical' }), ['medical']);
  assert.deepEqual(ex({}, { category: 'medical', inj: [{ body_region: 'knee', injury_type: 'sprain_strain' }] }), [], 'a medical call with a real injury counts');
  assert.deepEqual(ex({}, { disposition: 'no_injury' }), ['no_injury']);
  assert.equal(S.classify({ tenant_id: 1, hr: 9, month: '2026-01', activity: 'pedestrian', pform: '{"helmet":"none"}' }, []).cats.helmet, null, 'helmet is only asked of people on snow');
  assert.equal(S.classify({ tenant_id: 1, hr: 9, month: '2026-01', pform: 'not json' }, []).cats.activity, 'not_recorded');
});

test('small counts are hidden, with enough others that none can be worked out; seasons in progress stop at a month end', () => {
  const list = S.protectList([{ n: 20 }, { n: 3 }, { n: 7 }, { n: 0 }]);
  assert.deepEqual(list.map((c) => c.hidden), [false, true, true, false]);
  const two = S.protectList([{ n: 20 }, { n: 3 }, { n: 2 }]);
  assert.deepEqual(two.map((c) => c.hidden), [true, true, true], 'two small hidden cells would add up to a small number, so more is hidden');
  // A season in progress stops at the last full month; past seasons are whole.
  assert.deepEqual(S.periodOf({ season: '2026-27' }, '2026-12-19', { fullMonths: true }), { from: '2026-08-01', to: '2026-11-30', season: '2026-27', partial: true });
  assert.equal(S.periodOf({ season: '2025-26' }, '2026-12-19', { fullMonths: true }).to, '2026-07-31');
  assert.equal(S.periodOf({ season: '2026-27' }, '2026-08-10', { fullMonths: true }).empty, true);
});

test('sharing needs the director, the terms, a name, a title and a region', async () => {
  ok(await api('POST', '/users', { token: M.b.token, body: { email: `pat@${M.b.slug}.test`, password: PW, role: 'patrol' } }));
  const pat = (await api('POST', '/auth/login', { body: { tenant: M.b.slug, email: `pat@${M.b.slug}.test`, password: PW } })).body.token;
  is(await api('PUT', '/patrol/network/sharing', { token: pat, body: { share: true, agree: true, signer_name: 'x', signer_title: 'y', region: 'northeast' } }), 403, 'a patroller cannot');
  is(await share(M.b, { agree: false }), 400);
  is(await share(M.b, { signer_title: '' }), 400);
  is(await share(M.b, { region: null }), 400);
  is(await share(M.b, { region: 'atlantis' }), 400);
  await pool.query('UPDATE tenants SET sandbox_expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY) WHERE id = ?', [M.d.id]);
  is(await share(M.d), 403, 'a demo mountain cannot join');
  await pool.query('UPDATE tenants SET sandbox_expires_at = NULL WHERE id = ?', [M.d.id]);
  const before = ok(await api('GET', '/patrol/network', { token: M.b.token }));
  assert.equal(before.sharing.share, false);
  assert.equal(before.can_change, true);
  assert.equal(ok(await share(M.b)).sharing.agreed_name, 'Pat Director');
  const after = ok(await api('GET', '/patrol/network', { token: M.b.token }));
  assert.equal(after.sharing.agreement_version, S.AGREEMENT_VERSION);
  assert.equal(after.history[0].by_title, 'Patrol director');
  // One mountain's history is its own.
  assert.equal(ok(await api('GET', '/patrol/network', { token: M.a.token })).history.length, 0);
});

test('the network report: only sharing mountains, finished reports, no small counts, nothing about a person', async () => {
  is(await api('GET', `/patrol/network/benchmark?season=${SEASON}`, { token: M.d.token }), 200);
  let r = ok(await plat(`/safety?season=${SEASON}`));
  assert.equal(r.too_few_mountains, true, 'one mountain is not a network');
  ok(await share(M.a, { named: true, state: 'Colorado' }));
  ok(await share(M.c, { region: 'northeast' }));
  ok(await share(M.e));

  r = ok(await plat(`/safety?season=${SEASON}`));
  assert.equal(r.mountains.sharing, 4);
  assert.equal(r.mountains.with_visits, 4);
  assert.equal(r.mountains.named, 1);
  assert.equal(r.patients, 53, 'A 16 + B 21 + C 8 + E 8; not D, not staff, racers, medical, drafts or voided');
  assert.equal(r.visits, 4000, '4,300 first scans per ticket per day, to the nearest 1,000');
  assert.equal(r.per_1000, 12.33, '53 patients per 4,300 visits');
  const ex = Object.fromEntries(r.excluded.map((e) => [e.key, e]));
  assert.equal(ex.staff.n, null); assert.equal(ex.staff.hidden, true);

  const cause = Object.fromEntries(r.breakdowns.cause.cells.map((c) => [c.key, c]));
  assert.equal(cause.lift_unloading.n, 19);
  assert.equal(cause.fall.n, 22);
  assert.equal(cause.near_collision.n, null); assert.equal(cause.near_collision.hidden, true);
  assert.equal(cause.collision.n, null, 'the next smallest is hidden too, so 53 minus the rest does not give the 1 away');
  assert.equal(cause.collision.hidden, true, 'marked the same way as the small one');
  assert.equal(cause.lift_unloading.per_1000, 4.42, '19 per 4,300 visits');
  assert.equal(r.breakdowns.cause.recorded_pct, null, 'not given when a count is hidden: it would be a second total');
  assert.equal(r.breakdowns.age.cells.find((c) => c.key === '13_17').n, 8);
  assert.ok(r.breakdowns.activity.recorded_pct === 100);

  // Every count shown is 0 or at least 5.
  const counts = [...Object.values(r.breakdowns).flatMap((b) => b.cells.map((c) => c.n)), ...r.injuries.cells.flat(), ...r.regions.map((g) => g.patients)];
  for (const n of counts) assert.ok(n === null || n === undefined || n === 0 || n >= 5, `count ${n} shown`);
  assert.equal(r.injuries.cells[r.injuries.body.findIndex((b) => b.key === 'wrist_hand')][r.injuries.types.findIndex((t) => t.key === 'fracture')], 6);

  // Nothing that identifies a person or a place.
  const text = JSON.stringify(r);
  for (const s of SECRETS) assert.ok(!text.includes(s), `"${s}" leaked`);
  assert.ok(!text.includes(M.d.name), 'a mountain that does not share is not in it');
  for (const m of [M.b, M.c, M.e]) assert.ok(!text.includes(m.name), 'an anonymous mountain is not named');
  assert.equal(r.named[0].name, M.a.name);
  assert.equal(r.named[0].patients, undefined, 'no mountain\'s own count');

  // Regions: three mountains, and the rest of the network none or three, or the network minus the region is one mountain.
  const regions = Object.fromEntries(r.regions.map((g) => [g.key, g]));
  assert.equal(regions.rocky_mountain.mountains, 3);
  assert.equal(regions.rocky_mountain.too_few_mountains, true, 'C alone is outside it');
  assert.equal(regions.rocky_mountain.patients, undefined);
  assert.equal(regions.northeast.too_few_mountains, true);
  assert.equal(ok(await plat(`/safety?season=${SEASON}&region=northeast`)).too_few_mountains, true);
  const rocky = ok(await plat(`/safety?season=${SEASON}&region=rocky_mountain`));
  assert.equal(rocky.too_few_mountains, true); assert.equal(rocky.reason, 'rest_of_network');
  assert.equal(rocky.patients, undefined);

  // Whole seasons only: a report one day shorter could be subtracted.
  is(await plat('/safety?season=2025'), 400);
  is(await plat('/safety?season=2025-30'), 400);
  assert.equal(ok(await plat(`/safety?season=${SEASON}&from=2026-01-01&to=2026-01-02`)).patients, 53, 'dates are ignored');
  is(await api('GET', `/platform/safety?season=${SEASON}`, { token: M.a.token }), 403, 'a mountain cannot read the network report');

  // The download: the same numbers, small ones written as "fewer than 5", and the download is logged.
  const csv = await plat(`/safety.csv?season=${SEASON}`);
  is(csv, 200);
  assert.match(csv.headers.get('content-disposition'), /injury-network-2025-26\.csv/);
  assert.match(csv.body, /"Cause","Lift: unloading","19"/);
  assert.match(csv.body, /"Cause","Avoiding a collision","not shown"/);
  for (const s of SECRETS) assert.ok(!csv.body.includes(s), `"${s}" leaked into the download`);
  const [[logged]] = await pool.query("SELECT COUNT(*) AS n FROM platform_audit WHERE action = 'injury_report_download' AND at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE)");
  assert.ok(Number(logged.n) >= 1);

  const members = ok(await plat('/safety/members')).data.filter((m) => Object.values(M).some((x) => x.id === Number(m.id)));
  assert.equal(members.filter((m) => m.share).length, 4);
  assert.ok(members.every((m) => m.current_terms));
});

test('each sharing mountain sees how it compares, and its own early warnings', async () => {
  const b = ok(await api('GET', `/patrol/network/benchmark?season=${SEASON}`, { token: M.a.token }));
  assert.equal(b.own.patients, 16);
  assert.equal(b.own.per_1000, 16);
  const ownCause = Object.fromEntries(b.own.breakdowns.cause.cells.map((c) => [c.key, c]));
  assert.equal(ownCause.lift_unloading.n, 10);
  assert.equal(b.peers.mountains, 3, 'the network without A');
  assert.equal(b.peers.patients_about, 40, '37 others, rounded');
  assert.equal(JSON.stringify(b.peers).includes('"n"'), false, 'shares, not counts');
  const lift = b.alerts.find((x) => x.key === 'lift_unloading');
  assert.ok(lift, JSON.stringify(b.alerts));
  assert.equal(lift.own_pct, 62.5, '10 of A\'s 16');
  assert.equal(lift.network_pct, 24, '9 of the other mountains\' 37, as a whole percent');
  assert.equal(lift.ratio, 2.6);
  assert.ok(!b.alerts.some((x) => x.key === 'flat'), 'conditions every mountain shares are not flagged');
  // the peers' numbers follow the same hiding rule
  const peerCause = Object.fromEntries(b.peers.breakdowns.cause.cells.map((c) => [c.key, c]));
  assert.equal(peerCause.near_collision.hidden, true); assert.equal(peerCause.near_collision.pct, null);
  for (const s of SECRETS) assert.ok(!JSON.stringify(b.peers).includes(s));

  // D does not share, so it sees its own season only.
  const d = ok(await api('GET', `/patrol/network/benchmark?season=${SEASON}`, { token: M.d.token }));
  assert.equal(d.own.patients, 9);
  assert.equal(d.peers, null);
  assert.deepEqual(d.alerts, []);
});

test('stopping sharing takes a mountain out at once, and the history shows it', async () => {
  ok(await api('PUT', '/patrol/network/sharing', { token: M.a.token, body: { share: false } }));
  const r = ok(await plat(`/safety?season=${SEASON}`));
  assert.equal(r.mountains.sharing, 3);
  assert.equal(r.patients, 37);
  assert.equal(r.named.length, 0);
  assert.ok(!JSON.stringify(r).includes(M.a.name));
  const n = ok(await api('GET', '/patrol/network', { token: M.a.token }));
  assert.equal(n.sharing.share, false);
  assert.deepEqual(n.history.map((h) => h.share), [false, true]);
  assert.equal(n.history[0].by_name, 'Olive Owner');
  const bench = ok(await api('GET', `/patrol/network/benchmark?season=${SEASON}`, { token: M.a.token }));
  assert.equal(bench.peers, null, 'no comparison without sharing');
  // the Patrol app off: the network pages go with it
  await pool.query("INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, 'patrol', 0) ON DUPLICATE KEY UPDATE enabled = 0", [M.a.id]);
  require('../src/lib/modules').invalidate(M.a.id);
  is(await api('GET', '/patrol/network', { token: M.a.token }), 403);
});
