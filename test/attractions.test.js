'use strict';

// Attractions: setting them up (managers), the list every screen reads, open, hold and closed by the people who change
// a lift's status, the daily opening inspection (a failed one blocks opening, and an open cannot slip past a failing
// inspection), downtime kept in step, archive instead of delete, the patrol report's attraction and activities, the
// statistics and the season risk report, the morning board and the public feed, suggested staff, and other mountains
// kept out.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.MODULE_CACHE_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { todayIn } = require('../src/lib/util');
const A = require('../src/lib/attractions');
const NSAAR = require('../src/lib/nsaar');

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
async function addUser(m, email, role, extra = {}) {
  ok(await api('POST', '/users', { token: m.owner, body: { email, password: PW, role, ...extra } }));
  return (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token;
}

let M; let O; const T = {};
test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  M = await mountain(`at-${suffix}`);
  O = await mountain(`ao-${suffix}`);
  T.staff = await addUser(M, `lifty@${M.slug}.test`, 'staff');
  T.counter = await addUser(M, `counter@${M.slug}.test`, 'counter');
  T.manager = await addUser(M, `gm@${M.slug}.test`, 'manager');
  const sid = ok(await api('POST', '/workforce/staff', { token: M.owner, body: { person: { first_name: 'Pat', last_name: 'Rol' }, status: 'active' } })).id;
  T.patrol = await addUser(M, `pat@${M.slug}.test`, 'patrol', { staff_id: sid });
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

const today = () => todayIn(M.tz);
const add = (body, token = M.owner) => api('POST', '/attractions', { token, body });
const setStatus = (id, body, token = T.staff) => api('PATCH', `/attractions/${id}/status`, { token, body });

test('every type has activity, default opening checks and staff suggestions; old activity values keep their meaning', () => {
  for (const t of A.TYPES) {
    assert.ok(t.activity, `${t.key} activity`);
    const checks = A.templateFor(t.key);
    assert.ok(checks.length >= 5, `${t.key} has opening checks`);
    assert.equal(new Set(checks.map((c) => c.key)).size, checks.length, `${t.key} keys are unique`);
    assert.ok(checks.every((c) => /^[a-z_]+$/.test(c.key) && c.label.length > 8 && !/—|–/.test(c.label)), `${t.key} items are plain`);
    assert.ok(A.staffFor(t.key).positions.length >= 1);
  }
  assert.deepEqual(A.TYPE_KEYS, ['zipline', 'coaster', 'tubing', 'ice_rink', 'scenic_lift', 'bike_park', 'disc_golf', 'aerial_park', 'climbing_wall', 'other']);
  assert.equal(A.typeLabel('coaster'), 'Mountain coaster');
  assert.equal(A.activityFor('ice_rink'), 'ice_skating');
  const activity = NSAAR.FIELDS.find((f) => f.key === 'activity').options.map((o) => o.value);
  for (const v of ['alpine', 'snowboard', 'telemark', 'nordic', 'touring', 'tubing', 'non_skiing', 'other', 'zipline', 'mountain_coaster', 'ice_skating', 'scenic_lift', 'mountain_biking', 'disc_golf', 'aerial_park', 'climbing']) assert.ok(activity.includes(v), v);
  for (const t of A.TYPES) assert.ok(activity.includes(t.activity), `${t.key} maps to a report activity`);
  assert.equal(activity.indexOf('tubing'), 5, 'tubing keeps its place');
  // A reworded item keeps its key; a new one gets a key of its own.
  const n = A.normalizeChecklist([{ key: 'cables', label: 'Cables checked' }, { label: 'Cables checked twice' }, { label: 'Radio check' }]);
  assert.deepEqual(n.map((i) => i.key), ['cables', 'cables_checked_twice', 'radio_check']);
});

test('managers set attractions up; every signed-in screen reads the active list', async () => {
  is(await add({ name: 'Nope', type: 'zipline' }, T.staff), 403, 'staff do not set up');
  is(await add({ name: 'Bad', type: 'water_slide' }), 400, 'unknown type');
  is(await add({ name: 'Heavy', type: 'coaster', min_weight_lb: 200, max_weight_lb: 100 }), 400, 'weights the wrong way round');
  const zip = ok(await add({ name: 'Summit Zip', type: 'zipline', min_height_in: 48, min_weight_lb: 70, max_weight_lb: 275, min_age: 7 }));
  assert.equal(zip.waiver_required, true, 'a waiver by default');
  assert.equal(zip.checklist_custom, false);
  assert.deepEqual(zip.checklist, A.templateFor('zipline'));
  is(await add({ name: 'Summit Zip', type: 'coaster' }), 409, 'names are unique');
  const rink = ok(await add({ name: 'Village Rink', type: 'ice_rink', waiver_required: false, checklist: [{ label: 'Ice surface checked' }, { label: 'Doors latched' }] }, T.manager));
  assert.equal(rink.checklist_custom, true);
  assert.deepEqual(rink.checklist.map((c) => c.key), ['ice_surface_checked', 'doors_latched']);
  M.zip = zip.id; M.rink = rink.id;

  const list = ok(await api('GET', '/attractions', { token: T.counter })).data;
  const z = list.find((a) => a.id === M.zip);
  assert.deepEqual({ name: z.name, type: z.type, type_label: z.type_label, status: z.status, min_height_in: z.min_height_in, max_weight_lb: z.max_weight_lb, min_age: z.min_age, waiver_required: z.waiver_required },
    { name: 'Summit Zip', type: 'zipline', type_label: 'Zipline or canopy tour', status: 'closed', min_height_in: 48, max_weight_lb: 275, min_age: 7, waiver_required: true });
  assert.equal(z.checklist, undefined, 'the list leaves out the checks');
  const metaOut = ok(await api('GET', '/attractions/meta', { token: T.counter }));
  assert.equal(metaOut.types.length, A.TYPES.length);
  assert.ok(metaOut.downtime_reasons.some((r) => r.value === 'day_end'));

  ok(await api('PATCH', `/attractions/${M.zip}`, { token: M.owner, body: { min_age: 8, sort: 1 } }));
  is(await api('PATCH', `/attractions/${M.zip}`, { token: M.owner, body: { max_weight_lb: 50 } }), 400, 'below the lightest');
  is(await api('PATCH', `/attractions/${M.zip}`, { token: T.staff, body: { min_age: 1 } }), 403);
  const [[aud]] = await pool.query("SELECT detail FROM audit_log WHERE tenant_id = ? AND entity = 'attractions' AND entity_id = ? AND action = 'update' ORDER BY id DESC LIMIT 1", [M.id, M.zip]);
  assert.match(JSON.stringify(aud.detail), /"before":\{"min_age":7/);
});

test('each attraction has its own opening checks; going back to the defaults follows the type', async () => {
  const own = ok(await api('PUT', `/attractions/${M.zip}/checklist`, { token: M.owner, body: { items: [{ key: 'cables', label: 'Cables and clamps checked from the platforms' }, { label: 'Wind under 25 mph at the top' }] } }));
  assert.deepEqual(own.checklist.map((c) => c.key), ['cables', 'wind_under_25_mph_at_the_top']);
  assert.equal(own.checklist_custom, true);
  is(await api('PUT', `/attractions/${M.zip}/checklist`, { token: T.staff, body: { items: null } }), 403);
  is(await api('PUT', `/attractions/${M.zip}/checklist`, { token: M.owner, body: { items: [] } }), 400, 'at least one');
  const back = ok(await api('PUT', `/attractions/${M.zip}/checklist`, { token: M.owner, body: { items: null } }));
  assert.equal(back.checklist_custom, false);
  assert.deepEqual(back.checklist, A.templateFor('zipline'));
});

test('status: the people who change a lift change it; hold needs a note; downtime follows', async () => {
  is(await setStatus(M.zip, { status: 'open' }, T.counter), 403, 'the counter does not change status');
  is(await setStatus(M.zip, { status: 'hold' }), 400, 'hold says why');
  ok(await setStatus(M.zip, { status: 'open' }));
  ok(await setStatus(M.zip, { status: 'hold', note: 'Wind over 30 at the top platform', reason: 'wind' }, T.patrol));
  let [[d]] = await pool.query('SELECT * FROM attraction_downtime WHERE tenant_id = ? AND attraction_id = ? AND ended_at IS NULL', [M.id, M.zip]);
  assert.equal(d.reason, 'wind'); assert.equal(d.note, 'Wind over 30 at the top platform');
  const today1 = ok(await api('GET', '/attractions/today', { token: T.counter })).data.find((a) => a.id === M.zip);
  assert.equal(today1.status, 'hold'); assert.equal(today1.status_note, 'Wind over 30 at the top platform'); assert.equal(today1.down.reason, 'wind');
  ok(await setStatus(M.zip, { status: 'open' }, T.manager));
  [[d]] = await pool.query('SELECT * FROM attraction_downtime WHERE tenant_id = ? AND id = ?', [M.id, d.id]);
  assert.ok(d.ended_at, 'open ends the entry');
  // Closed for the day starts no downtime.
  ok(await setStatus(M.zip, { status: 'closed', reason: 'day_end' }));
  const [open] = await pool.query('SELECT id FROM attraction_downtime WHERE tenant_id = ? AND attraction_id = ? AND ended_at IS NULL', [M.id, M.zip]);
  assert.equal(open.length, 0);
  const [[aud]] = await pool.query("SELECT detail FROM audit_log WHERE tenant_id = ? AND entity = 'attractions' AND entity_id = ? AND action = 'status' ORDER BY id DESC LIMIT 1", [M.id, M.zip]);
  assert.match(JSON.stringify(aud.detail), /"from":"open","to":"closed"/);
});

test('downtime is listed, logged by hand and corrected, never deleted', async () => {
  const day = today();
  const id = ok(await api('POST', '/attractions/downtime', { token: T.staff, body: { attraction_id: M.rink, started_at: `${day}T09:00`, ended_at: `${day}T09:40`, reason: 'mechanical', note: 'Door latch' } })).id;
  is(await api('POST', '/attractions/downtime', { token: T.staff, body: { attraction_id: M.rink, started_at: `${day}T09:00`, ended_at: `${day}T08:00` } }), 400);
  is(await api('POST', '/attractions/downtime', { token: T.counter, body: { attraction_id: M.rink, started_at: `${day}T09:00` } }), 403);
  ok(await api('PATCH', `/attractions/downtime/${id}`, { token: T.patrol, body: { reason: 'electrical', note: 'Door sensor' } }));
  const list = ok(await api('GET', `/attractions/downtime?from=${day}`, { token: T.staff })).data;
  const row = list.find((x) => x.id === id);
  assert.equal(row.reason, 'electrical'); assert.equal(row.minutes, 40); assert.equal(row.attraction, 'Village Rink');
  is(await api('DELETE', `/attractions/downtime/${id}`, { token: M.owner }), 404, 'there is no delete');
  const [[aud]] = await pool.query("SELECT detail FROM audit_log WHERE tenant_id = ? AND entity = 'attraction_downtime' AND entity_id = ? AND action = 'update'", [M.id, id]);
  assert.match(JSON.stringify(aud.detail), /"before":\{"reason":"mechanical"/);
});

test('the opening inspection: one a day, item by item, a failure blocks opening until a new one passes', async () => {
  const keys = A.templateFor('zipline').map((c) => c.key);
  const c1 = await api('POST', `/attractions/${M.zip}/checks`, { token: T.staff });
  is(c1, 201);
  assert.equal(c1.body.attempt, 1); assert.equal(c1.body.status, 'in_progress'); assert.equal(c1.body.items.length, keys.length);
  const again = await api('POST', `/attractions/${M.zip}/checks`, { token: T.patrol });
  is(again, 200, 'the one under way comes back'); assert.equal(again.body.id, c1.body.id);
  is(await api('POST', `/attractions/${M.zip}/checks`, { token: T.counter }), 403);
  // A manager rewords the list mid-inspection: the inspection keeps the words it started with.
  ok(await api('PUT', `/attractions/${M.zip}/checklist`, { token: M.owner, body: { items: [{ key: 'cables', label: 'Something else entirely' }] } }));
  const t1 = ok(await api('PATCH', `/attractions/checks/${c1.body.id}`, { token: T.staff, body: { items: [{ key: 'weather', result: 'pass' }, { key: 'cables', result: 'pass' }] } }));
  assert.equal(t1.items.find((i) => i.key === 'cables').label, A.templateFor('zipline').find((i) => i.key === 'cables').label);
  assert.ok(t1.items.find((i) => i.key === 'weather').by, 'who');
  assert.ok(t1.items.find((i) => i.key === 'weather').at, 'when');
  is(await api('PATCH', `/attractions/checks/${c1.body.id}`, { token: T.staff, body: { items: [{ key: 'nope', result: 'pass' }] } }), 400);
  is(await api('POST', `/attractions/checks/${c1.body.id}/finish`, { token: T.staff, body: {} }), 400, 'cannot pass with items still to check');
  ok(await api('PATCH', `/attractions/checks/${c1.body.id}`, { token: T.staff, body: { items: [{ key: 'braking', result: 'fail' }] } }));
  is(await api('POST', `/attractions/checks/${c1.body.id}/finish`, { token: T.staff, body: {} }), 400, 'a failed item says what is wrong');
  ok(await api('PATCH', `/attractions/checks/${c1.body.id}`, { token: T.staff, body: { items: [{ key: 'braking', result: 'fail', note: 'Brake block worn on line 2' }] } }));
  const done = ok(await api('POST', `/attractions/checks/${c1.body.id}/finish`, { token: T.staff, body: { note: 'Called the maintenance lead' } }));
  assert.equal(done.status, 'fail'); assert.equal(done.closed, false, 'it was closed already');
  is(await api('PATCH', `/attractions/checks/${c1.body.id}`, { token: T.staff, body: { items: [{ key: 'braking', result: 'pass' }] } }), 409, 'a finished inspection stays as it was');

  const blocked = await setStatus(M.zip, { status: 'open' }, M.owner);
  is(blocked, 409, 'a failed inspection blocks opening, even for the owner');
  assert.match(blocked.body.error, /failed its opening inspection today/);
  assert.equal(ok(await api('GET', '/attractions/today', { token: T.staff })).data.find((a) => a.id === M.zip).blocked, true);
  ok(await setStatus(M.zip, { status: 'hold', note: 'Waiting for the brake block' }), 'hold is still fine');

  // After the fix: a second attempt, from the attraction's checks as they are now.
  const c2 = ok(await api('POST', `/attractions/${M.zip}/checks`, { token: T.staff }));
  assert.equal(c2.attempt, 2);
  assert.deepEqual(c2.items.map((i) => i.label), ['Something else entirely']);
  is(await setStatus(M.zip, { status: 'open' }), 409, 'still blocked while the new one is under way');
  ok(await api('PATCH', `/attractions/checks/${c2.id}`, { token: T.staff, body: { items: [{ key: 'cables', result: 'pass' }] } }));
  assert.equal(ok(await api('POST', `/attractions/checks/${c2.id}/finish`, { token: T.staff, body: {} })).status, 'pass');
  ok(await setStatus(M.zip, { status: 'open' }));
  is(await api('POST', `/attractions/${M.zip}/checks`, { token: T.staff }), 409, 'one passed inspection a day');
  const hist = ok(await api('GET', `/attractions/${M.zip}/checks?from=${today()}`, { token: T.staff })).data;
  assert.deepEqual(hist.map((c) => [c.attempt, c.status]), [[2, 'pass'], [1, 'fail']]);
  assert.equal(hist[1].note, 'Called the maintenance lead');
  const [[aud]] = await pool.query("SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ? AND entity = 'attraction_checks' AND action = 'inspect'", [M.id]);
  assert.equal(Number(aud.n), 2);
});

test('an inspection that fails closes an open attraction, and a fail and an open at the same moment cannot both win', async () => {
  const coaster = ok(await add({ name: 'Alpine Coaster', type: 'coaster' })).id;
  ok(await api('PUT', `/attractions/${coaster}/checklist`, { token: M.owner, body: { items: [{ key: 'track', label: 'Track walked' }, { key: 'brakes', label: 'Brakes tested' }] } }));
  // Open, then an inspection fails: it closes, with downtime for the inspection.
  ok(await setStatus(coaster, { status: 'open' }));
  const c = ok(await api('POST', `/attractions/${coaster}/checks`, { token: T.staff }));
  ok(await api('PATCH', `/attractions/checks/${c.id}`, { token: T.staff, body: { items: [{ key: 'brakes', result: 'fail', note: 'Sled 4 brake soft' }] } }));
  const out = ok(await api('POST', `/attractions/checks/${c.id}/finish`, { token: T.staff, body: {} }));
  assert.equal(out.closed, true);
  const now = ok(await api('GET', '/attractions/today', { token: T.staff })).data.find((a) => a.id === coaster);
  assert.equal(now.status, 'closed'); assert.match(now.status_note, /Brakes tested/); assert.equal(now.down.reason, 'inspection');

  // The race, several times over: a new attempt fails while someone presses Open.
  const [[{ id: tenantId }]] = await pool.query('SELECT tenant_id AS id FROM attractions WHERE id = ?', [coaster]);
  for (let i = 0; i < 4; i++) {
    // Clear today's attempts so the attraction may open, then start one that will fail.
    await pool.query('DELETE FROM attraction_checks WHERE tenant_id = ? AND attraction_id = ?', [tenantId, coaster]);
    await pool.query("UPDATE attractions SET status = 'closed' WHERE tenant_id = ? AND id = ?", [tenantId, coaster]);
    const k = ok(await api('POST', `/attractions/${coaster}/checks`, { token: T.staff }));
    ok(await api('PATCH', `/attractions/checks/${k.id}`, { token: T.staff, body: { items: [{ key: 'track', result: 'fail', note: 'Branch on the track' }] } }));
    const [fin, open] = await Promise.all([
      api('POST', `/attractions/checks/${k.id}/finish`, { token: T.staff, body: {} }),
      setStatus(coaster, { status: 'open' }, T.patrol),
    ]);
    is(fin, 200);
    assert.ok([200, 409].includes(open.status), JSON.stringify(open.body));
    const [[row]] = await pool.query('SELECT status FROM attractions WHERE tenant_id = ? AND id = ?', [tenantId, coaster]);
    assert.equal(row.status, 'closed', `round ${i}: never left open after a failed inspection (open said ${open.status}, finish closed=${fin.body.closed})`);
    assert.equal(fin.body.closed, open.status === 200, 'the fail closed it exactly when the open got in first');
  }
  M.coaster = coaster;
});

test('archive instead of delete: it closes, leaves the lists, and comes back on restore', async () => {
  const tube = ok(await add({ name: 'Tube Park', type: 'tubing' })).id;
  ok(await setStatus(tube, { status: 'open' }));
  is(await api('POST', `/attractions/${tube}/archive`, { token: T.staff }), 403);
  ok(await api('POST', `/attractions/${tube}/archive`, { token: M.owner }));
  const [[row]] = await pool.query('SELECT status, active FROM attractions WHERE tenant_id = ? AND id = ?', [M.id, tube]);
  assert.deepEqual([row.status, Number(row.active)], ['closed', 0]);
  assert.ok(!ok(await api('GET', '/attractions', { token: M.owner })).data.some((a) => a.id === tube));
  assert.ok(!ok(await api('GET', '/attractions?all=1', { token: T.staff })).data.some((a) => a.id === tube), 'only managers see archived ones');
  assert.ok(ok(await api('GET', '/attractions?all=1', { token: M.owner })).data.some((a) => a.id === tube && !a.active));
  is(await setStatus(tube, { status: 'open' }), 404, 'an archived attraction has no status to change');
  is(await api('POST', `/attractions/${tube}/checks`, { token: T.staff }), 404);
  is(await api('DELETE', `/attractions/${tube}`, { token: M.owner }), 404, 'there is no delete');
  ok(await api('POST', `/attractions/${tube}/restore`, { token: M.owner }));
  assert.ok(ok(await api('GET', '/attractions', { token: M.owner })).data.some((a) => a.id === tube));
  M.tube = tube;
});

test('a patrol case at an attraction: the place, the report, statistics and the season risk report', async () => {
  const at = `${today()}T11:20`;
  const c = ok(await api('POST', '/patrol/incidents', { token: M.owner, body: { occurred_at: at, location: 'Summit Zip', category: 'injury', severity: 'minor', summary: 'Hand caught in trolley', attraction_id: M.zip } }));
  const full = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: M.owner }));
  assert.equal(full.attraction_id, M.zip); assert.equal(full.attraction, 'Summit Zip'); assert.equal(full.attraction_type_label, 'Zipline or canopy tour');
  assert.equal(full.form.incident_location, 'attraction', 'the NSAAR location says attraction');
  // Another case moves to the coaster later.
  const c2 = ok(await api('POST', '/patrol/incidents', { token: M.owner, body: { occurred_at: at, location: 'Base area', category: 'injury', severity: 'minor', summary: 'Fall', form: { incident_location: 'premises' } } }));
  ok(await api('PATCH', `/patrol/incidents/${c2.id}`, { token: M.owner, body: { attraction_id: M.coaster, location: 'Alpine Coaster' } }));
  const two = ok(await api('GET', `/patrol/incidents/${c2.id}`, { token: M.owner }));
  assert.equal(two.attraction, 'Alpine Coaster'); assert.equal(two.location, 'Alpine Coaster');
  assert.equal(two.form.incident_location, 'premises', 'an answered location is left alone');
  // Another mountain's attraction is not a place for this case.
  const theirs = ok(await api('POST', '/attractions', { token: O.owner, body: { name: 'Their Zip', type: 'zipline' } })).id;
  is(await api('PATCH', `/patrol/incidents/${c2.id}`, { token: M.owner, body: { attraction_id: theirs } }), 404);
  is(await api('POST', '/patrol/incidents', { token: M.owner, body: { occurred_at: at, location: 'x', category: 'injury', severity: 'minor', summary: 'x', attraction_id: theirs } }), 404);
  // A patient on the zipline case, with the attraction's activity.
  ok(await api('POST', `/patrol/incidents/${c.id}/patients`, { token: M.owner, body: { first_name: 'Zed', last_name: 'Rider', form: { activity: 'zipline' } } }));

  const a = ok(await api('GET', `/patrol/analytics?from=${today()}&to=${today()}`, { token: M.owner }));
  const zipRow = a.cases_by_attraction.find((x) => x.label === 'Summit Zip');
  assert.deepEqual([zipRow.n, zipRow.patients, zipRow.type_label], [1, 1, 'Zipline or canopy tour']);
  assert.equal(a.cases_by_attraction.find((x) => x.label === 'Alpine Coaster').n, 1);
  assert.ok(a.patients_by_activity.some((x) => x.label === 'zipline'));

  const r = ok(await api('GET', '/patrol/risk-report', { token: M.owner }));
  assert.deepEqual(r.attractions.find((x) => x.name === 'Summit Zip'), { name: 'Summit Zip', type_label: 'Zipline or canopy tour', cases: 1, patients: 1 });

  // Archived later, the case still names it.
  ok(await api('POST', `/attractions/${M.coaster}/archive`, { token: M.owner }));
  assert.equal(ok(await api('GET', `/patrol/incidents/${c2.id}`, { token: M.owner })).attraction, 'Alpine Coaster');
  ok(await api('POST', `/attractions/${M.coaster}/restore`, { token: M.owner }));
});

test('the public feed lists attractions without staff notes; the morning board and its alerts include them', async () => {
  ok(await setStatus(M.rink, { status: 'hold', note: 'Zamboni driver late' }));
  const feed = await fetch(`${base}/api/v1/public/${M.slug}/conditions`).then((r) => r.json());
  const rink = feed.attractions.find((x) => x.name === 'Village Rink');
  assert.deepEqual(rink, { name: 'Village Rink', type: 'ice_rink', type_label: 'Ice skating', status: 'hold' });
  assert.ok(!JSON.stringify(feed).includes('Zamboni'), 'the note stays with staff');
  assert.equal(feed.attractions_open, feed.attractions.filter((x) => x.status === 'open').length);

  // A failed inspection shows on the board and as an alert.
  const c = ok(await api('POST', `/attractions/${M.tube}/checks`, { token: T.staff }));
  ok(await api('PATCH', `/attractions/checks/${c.id}`, { token: T.staff, body: { items: [{ key: 'tubes', result: 'fail', note: 'Six tubes torn' }] } }));
  ok(await api('POST', `/attractions/checks/${c.id}/finish`, { token: T.staff, body: {} }));
  ok(await api('PUT', '/board/layout', { token: M.owner, body: { tiles: ['morning'] } }));
  const b = ok(await api('GET', '/board', { token: M.owner }));
  const tube = b.data.morning.attractions.find((x) => x.name === 'Tube Park');
  assert.equal(tube.check, 'fail'); assert.match(tube.detail, /Inspection failed/);
  assert.equal(b.data.morning.attractions.find((x) => x.name === 'Village Rink').detail, 'Zamboni driver late');
  assert.ok(b.alerts.some((x) => x.level === 'stop' && /Tube Park failed its opening inspection/.test(x.text)));
});

test('staff: the Attractions department, and suggested positions and certifications added in one step', async () => {
  ok(await api('POST', '/workforce/positions', { token: M.owner, body: { name: 'Rink lead', department: 'attractions' } }));
  is(await api('GET', '/workforce/attraction-staff', { token: T.staff }), 403);
  const s = ok(await api('GET', '/workforce/attraction-staff', { token: M.owner })).data;
  assert.deepEqual(s.map((x) => x.type), ['zipline', 'coaster', 'tubing', 'ice_rink'], 'the types the mountain runs');
  const zip = s.find((x) => x.type === 'zipline');
  assert.ok(zip.positions.every((p) => !p.exists));
  assert.equal(zip.attractions, 'Summit Zip');
  is(await api('POST', '/workforce/attraction-staff', { token: T.manager, body: { type: 'zipline', positions: ['Not a suggestion'] } }), 400);
  const made = ok(await api('POST', '/workforce/attraction-staff', { token: T.manager, body: { type: 'zipline' } }));
  assert.deepEqual(made.positions, ['Zip guide', 'Lead zip guide']);
  assert.deepEqual(made.certifications.sort(), ['First aid and CPR', 'Zipline guide', 'Zipline rescue']);
  const ov = ok(await api('GET', '/workforce/positions-overview', { token: M.owner })).data;
  const lead = ov.find((p) => p.name === 'Lead zip guide');
  assert.equal(lead.department, 'attractions');
  assert.deepEqual(lead.requires.map((c) => c.name).sort(), ['First aid and CPR', 'Zipline guide', 'Zipline rescue']);
  // Again: nothing new. First aid already there: not made twice for the rink.
  assert.deepEqual(ok(await api('POST', '/workforce/attraction-staff', { token: M.owner, body: { type: 'zipline' } })), { positions: [], certifications: [] });
  const rink = ok(await api('POST', '/workforce/attraction-staff', { token: M.owner, body: { type: 'ice_rink', positions: ['Rink attendant'] } }));
  assert.deepEqual(rink, { positions: ['Rink attendant'], certifications: [] });
  // A position in the Attractions department can be scheduled.
  const pos = ov.find((p) => p.name === 'Zip guide').id;
  const sid = ok(await api('POST', '/workforce/staff', { token: M.owner, body: { person: { first_name: 'Zoe', last_name: 'Guide' }, status: 'active' } })).id;
  const shift = await api('POST', '/workforce/shifts', { token: M.owner, body: { position_id: pos, starts_at: `${today()}T09:00`, ends_at: `${today()}T17:00` } });
  ok(shift);
  assert.ok(sid);
});

test('other mountains and switched-off apps are kept out', async () => {
  assert.ok(!ok(await api('GET', '/attractions', { token: O.owner })).data.some((a) => a.id === M.zip));
  is(await api('GET', `/attractions/${M.zip}`, { token: O.owner }), 404);
  is(await api('PATCH', `/attractions/${M.zip}`, { token: O.owner, body: { name: 'Mine now' } }), 404);
  is(await api('PATCH', `/attractions/${M.zip}/status`, { token: O.owner, body: { status: 'closed' } }), 404);
  is(await api('POST', `/attractions/${M.zip}/checks`, { token: O.owner }), 404);
  is(await api('POST', `/attractions/${M.zip}/archive`, { token: O.owner }), 404);
  is(await api('PUT', `/attractions/${M.zip}/checklist`, { token: O.owner, body: { items: null } }), 404);
  is(await api('PATCH', '/attractions/checks/1', { token: O.owner, body: { items: [{ key: 'x', result: 'pass' }] } }), 404);
  const [[k]] = await pool.query('SELECT id FROM attraction_checks WHERE tenant_id = ? ORDER BY id DESC LIMIT 1', [M.id]);
  is(await api('POST', `/attractions/checks/${k.id}/finish`, { token: O.owner, body: {} }), 404);
  is(await api('POST', '/attractions/downtime', { token: O.owner, body: { attraction_id: M.zip, started_at: `${today()}T09:00` } }), 404);
  assert.ok(!ok(await api('GET', '/attractions/downtime', { token: O.owner })).data.length);

  // Lifts and trails off, Patrol on: the list stays readable (a case's place), running them does not.
  await pool.query("INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, 'conditions', 0) ON DUPLICATE KEY UPDATE enabled = 0", [M.id]);
  try {
    assert.ok(ok(await api('GET', '/attractions', { token: T.patrol })).data.length);
    is(await api('GET', '/attractions/today', { token: T.patrol }), 403);
    is(await setStatus(M.zip, { status: 'closed' }, T.patrol), 403);
  } finally {
    await pool.query("DELETE FROM tenant_modules WHERE tenant_id = ? AND module = 'conditions'", [M.id]);
  }
});
