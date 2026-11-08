'use strict';

// Terrain park review fixes (after 2026.11.12): a feature closed after an incident stays closed until a post-incident
// inspection passes, and an area does not open around a feature that is closed, waits for that inspection, needs
// attention or never passed (unless roped off); a closing that arrives late from a phone with no signal wins over an
// opening made before it arrived, the same on every screen and the public feed; photos on an inspection are that day's.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.AUDIT_LOG_STDOUT = 'off';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const P = require('../src/lib/park');
const OPS = require('../src/lib/parkops');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const TZ = 'America/New_York';
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
const day = (offset) => fmt.format(new Date(Date.now() + offset * 86400000));
const today = day(0); const yesterday = day(-1);
const localNow = (minutes = 0) => {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(Date.now() + minutes * 60000)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};

async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r, status) => { assert.ok(r.status < 300 && (!status || r.status === status), `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const is = (r, status, why) => { assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`); return r.body; };
async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, timezone: TZ, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201, await res.text());
  const tenant = Number((await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]))[0][0].id);
  return { slug, tenant, owner: (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token };
}
const login = async (m, email) => (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token;
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
async function photo(token, featureId, query = '?for=inspection') {
  const res = await fetch(`${base}/api/v1/park/features/${featureId}/photos${query}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'image/jpeg' }, body: JPEG });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) };
}
const checks = (kind, fail = []) => P.checklistFor(kind).map((c) => (fail.includes(c.key) ? { key: c.key, result: 'fail', note: `${c.label} worn` } : { key: c.key, result: 'pass' }));
const pass = (kind, more = {}) => ({ result: 'ok', kind: 'morning', checklist: checks(kind), ...more });
const spot = (n = 0) => ({ lat: 44.2 + n * 0.0001, lng: -71.6 - n * 0.0001 });
const changesOf = async (featureId) => (await pool.query('SELECT field, before_value, after_value, reason, source FROM park_feature_changes WHERE feature_id = ? ORDER BY id', [featureId]))[0];

let A; let B; const T = {}; const D = {};

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`prv-${suffix}`); B = await mountain(`prw-${suffix}`);
  for (const role of ["staff","counter","manager"]) {
    ok(await api('POST', '/users', { token: A.owner, body: { email: `${role}@${A.slug}.test`, password: PW, role } }), 201);
    T[role] = await login(A, `${role}@${A.slug}.test`);
  }
  const pat = Number(ok(await api('POST', '/patrol/team', { token: A.owner, body: { person: { first_name: 'Pat', last_name: 'Ridge' }, level: 'patroller' } })).staff_id);
  ok(await api('POST', '/users', { token: A.owner, body: { email: `pat@${A.slug}.test`, password: PW, role: 'patrol', staff_id: pat } }));
  T.patrol = await login(A, `pat@${A.slug}.test`);
  D.main = ok(await api('POST', '/park/areas', { token: T.staff, body: { name: 'Main', level: 'm' } }), 201).id;
  D.kids = ok(await api('POST', '/park/areas', { token: T.staff, body: { name: 'Kids zone', level: 'beginner' } }), 201).id;
  D.rail = ok(await api('POST', '/park/features', { token: T.staff, body: { name: 'Kinked rail', kind: 'rail_kinked', size: 'm', dimensions: '14 ft' } }), 201).id;
  D.table = ok(await api('POST', '/park/features', { token: T.staff, body: { name: 'Tabletop', kind: 'tabletop', size: 'l', dimensions: '30 ft' } }), 201).id;
  D.box = ok(await api('POST', '/park/features', { token: T.staff, body: { name: 'Butter box', kind: 'butter_box', size: 's' } }), 201).id;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

const all = Object.fromEntries(P.SIGNOFF.map(([k]) => [k, true]));
const feed = async () => (await (await fetch(`${base}/api/v1/public/${A.slug}/conditions`)).json());
const featureOf = async (id) => ok(await api('GET', '/park/features', { token: T.staff })).data.find((x) => x.id === id);
const areaOf = async (id) => ok(await api('GET', '/park/areas', { token: T.staff })).data.find((a) => a.id === id);
const storedStatus = async (id) => (await pool.query('SELECT status FROM park_areas WHERE id = ?', [id]))[0][0].status;
const openArea = (id, more = {}) => api('POST', `/park/areas/${id}/open`, { token: T.staff, body: { checklist: all, supervisor_name: 'Sam Super', ...more } });
const hm = (local) => local.slice(11, 16);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

test('a feature closed after an incident stays closed through a needs-attention inspection, and its area cannot open', async () => {
  ok(await api('PUT', `/park/placements/${today}/${D.rail}`, { token: T.staff, body: { ...spot(1), area_id: D.main } }));
  ok(await api('POST', `/park/features/${D.rail}/inspections`, { token: T.staff, body: pass('rail_kinked') }), 201);
  ok(await api('POST', `/park/features/${D.rail}/close-for-incident`, { token: T.patrol, body: { reason: 'Rider hurt on the rail' } }));
  const na = ok(await api('POST', `/park/features/${D.rail}/inspections`, { token: T.staff, body: { result: 'needs_attention', kind: 'morning', notes: 'Some wear', checklist: checks('rail_kinked') } }), 201);
  assert.equal(na.status, 'closed'); assert.equal(na.needs_post_incident, true);
  let f = await featureOf(D.rail);
  assert.equal(f.status, 'closed', 'a needs-attention inspection does not move it off Closed');
  assert.equal(f.needs_post_incident, true);
  // a post-incident inspection that does not pass keeps it closed too
  ok(await api('POST', `/park/features/${D.rail}/inspections`, { token: T.staff, body: { result: 'needs_attention', kind: 'post_incident', notes: 'Weld cracked', checklist: checks('rail_kinked') } }), 201);
  assert.equal((await featureOf(D.rail)).status, 'closed');
  const r = is(await openArea(D.main), 409, 'the area does not open with it');
  assert.equal(r.details.code, 'area_blocked');
  const b = r.details.blocking.find((x) => x.name === 'Kinked rail');
  assert.equal(b.why, 'Needs a post-incident inspection');
  assert.match(b.todo, /post-incident inspection that finds no defects, or rope it off/);
  assert.ok(r.error.includes('Kinked rail: Needs a post-incident inspection.'));
  assert.equal((await feed()).park_areas.find((a) => a.name === 'Main').status, 'closed');
  assert.equal(await storedStatus(D.main), 'closed');
  // a passing inspection of another kind is refused; a passing post-incident inspection reopens it and the area opens
  is(await api('POST', `/park/features/${D.rail}/inspections`, { token: T.staff, body: pass('rail_kinked', { fixed: 'Rewelded', photo_ids: [(await photo(T.staff, D.rail)).body.id] }) }), 400);
  ok(await api('POST', `/park/features/${D.rail}/inspections`, { token: T.staff, body: pass('rail_kinked', { kind: 'post_incident', fixed: 'Rewelded the joint', photo_ids: [(await photo(T.staff, D.rail)).body.id] }) }), 201);
  f = await featureOf(D.rail);
  assert.equal(f.status, 'ready'); assert.equal(f.needs_post_incident, false);
  ok(await openArea(D.main), 201);
  assert.equal((await feed()).park_areas.find((a) => a.name === 'Main').status, 'open');
});

test('an area does not open around a feature that needs attention or never passed, unless it is roped off with a reason', async () => {
  const area = ok(await api('POST', '/park/areas', { token: T.staff, body: { name: 'Side line', level: 'l' } }), 201).id;
  const fresh = ok(await api('POST', '/park/features', { token: T.staff, body: { name: 'Fresh box', kind: 'butter_box', size: 's' } }), 201).id;
  const worn = ok(await api('POST', '/park/features', { token: T.staff, body: { name: 'Worn rail', kind: 'rail_kinked', size: 'm' } }), 201).id;
  const voided = ok(await api('POST', '/park/features', { token: T.staff, body: { name: 'Voided box', kind: 'butter_box', size: 's' } }), 201).id;
  for (const [n, id] of [[3, fresh], [4, worn], [5, voided]]) ok(await api('PUT', `/park/placements/${today}/${id}`, { token: T.staff, body: { ...spot(n), area_id: area } }));
  // brand new and never passed: its first inspection finds a problem
  ok(await api('POST', `/park/features/${fresh}/inspections`, { token: T.staff, body: { result: 'needs_attention', kind: 'morning', notes: 'Edge lifting', checklist: checks('butter_box') } }), 201);
  // passed earlier, then needs attention today
  ok(await api('POST', `/park/features/${worn}/inspections`, { token: T.staff, body: pass('rail_kinked') }), 201);
  ok(await api('POST', `/park/features/${worn}/inspections`, { token: T.staff, body: { result: 'needs_attention', kind: 'midday', notes: 'Paint worn', checklist: checks('rail_kinked') } }), 201);
  // its only pass was entered in error
  const only = ok(await api('POST', `/park/features/${voided}/inspections`, { token: T.staff, body: pass('butter_box') }), 201).id;
  ok(await api('POST', `/park/inspections/${only}/correct`, { token: T.manager, body: { reason: 'Logged on the wrong feature' } }));
  ok(await api('POST', `/park/features/${voided}/inspections`, { token: T.staff, body: { result: 'needs_attention', kind: 'midday', notes: 'Not checked properly', checklist: checks('butter_box') } }), 201);
  await pool.query('UPDATE park_features SET status = \'ready\' WHERE id = ?', [voided]); // as it stood before the correction
  const check = ok(await api('GET', `/park/areas/${area}/open-check`, { token: T.staff }));
  assert.deepEqual(check.blocking.map((x) => [x.name, x.why]), [['Fresh box', 'Needs attention'], ['Voided box', 'Never passed an inspection'], ['Worn rail', 'Needs attention']]);
  assert.ok(check.blocking.find((x) => x.name === 'Fresh box').reasons.includes('never_passed'));
  for (const x of check.blocking) assert.ok(x.todo.endsWith('or rope it off with a reason.'), x.todo);
  is(await openArea(area), 409);
  for (const id of [fresh, worn, voided]) ok(await api('PUT', `/park/placements/${today}/${id}/rope`, { token: T.staff, body: { roped_off: true, note: 'Roped off until fixed' } }));
  ok(await openArea(area), 201);
});

test('a closing kept with no signal that arrives after a later opening closes the area everywhere, and says so', async () => {
  ok(await api('PUT', `/park/placements/${today}/${D.box}`, { token: T.staff, body: { ...spot(2), area_id: D.kids } }));
  ok(await api('POST', `/park/features/${D.box}/inspections`, { token: T.staff, body: pass('butter_box') }), 201);
  const openedAt = localNow(-10); const sentAt = localNow(-20);
  ok(await openArea(D.kids, { at: openedAt }), 201);
  assert.equal((await areaOf(D.kids)).today_status, 'open');
  // made 20 minutes ago with no signal, arriving now: after the opening it was made before
  const c = ok(await api('POST', `/park/areas/${D.kids}/close`, { token: T.staff, body: { reason_kind: 'wind', reason: 'Gusts over the box line', at: sentAt, client_ref: `cl${suffix}` } }), 201);
  assert.equal(c.status, 'closed');
  const [[row]] = await pool.query('SELECT received_at FROM park_area_days WHERE id = ?', [c.id]);
  const arrived = hm(OPS.local({ at: row.received_at }, TZ).at);
  const msg = `A closing sent at ${hm(sentAt)} arrived at ${arrived} and closed the area.`;
  assert.equal(c.message, msg);
  assert.equal((await featureOf(D.box)).status, 'closed', 'the features underneath are closed');
  const a = await areaOf(D.kids);
  assert.equal(a.today_status, 'closed', 'park screen'); assert.equal(a.status, 'closed');
  assert.deepEqual(a.late_notes, [msg]);
  assert.equal(await storedStatus(D.kids), 'closed', 'stored area status');
  assert.equal((await feed()).park_areas.find((x) => x.name === 'Kids zone').status, 'closed', 'public feed');
  const rec = ok(await api('GET', `/park/areas/${D.kids}/record/${today}`, { token: T.staff }));
  assert.equal(rec.status, 'closed', 'day record'); assert.deepEqual(rec.late_notes, [msg]);
  assert.equal(rec.days.find((d) => d.action === 'close').late_message, msg);
  // an opening made after the closing arrived wins
  ok(await api('POST', `/park/features/${D.box}/inspections`, { token: T.staff, body: pass('butter_box', { kind: 'midday', fixed: 'Wind dropped', photo_ids: [(await photo(T.staff, D.box)).body.id] }) }), 201);
  await sleep(1100);
  const re = ok(await openArea(D.kids), 201);
  assert.equal(re.status, 'open');
  assert.equal((await areaOf(D.kids)).today_status, 'open');
  assert.equal(await storedStatus(D.kids), 'open');
  assert.equal((await feed()).park_areas.find((x) => x.name === 'Kids zone').status, 'open');
  assert.equal(ok(await api('GET', `/park/areas/${D.kids}/record/${today}`, { token: T.staff })).status, 'open');
});

test('an opening kept with no signal, made before a closing reached the server, does not open the area', async () => {
  const area = ok(await api('POST', '/park/areas', { token: T.staff, body: { name: 'Empty line', level: 's' } }), 201).id;
  ok(await api('POST', `/park/areas/${area}/close`, { token: T.staff, body: { reason_kind: 'visibility', reason: 'Fog on the landings' } }), 201);
  const o = ok(await openArea(area, { at: localNow(-5) }), 201);
  assert.equal(o.status, 'closed'); assert.match(o.message, /stays closed/);
  assert.equal((await areaOf(area)).today_status, 'closed');
  assert.equal(await storedStatus(area), 'closed');
});

test('the rule itself: a tie or an unclear order is closed', () => {
  const S = (days) => OPS.areaState(days, TZ).status;
  const open = (at, id = 1) => ({ id, action: 'open', at, received_at: at });
  const close = (at, received_at, id = 2) => ({ id, action: 'close', at, received_at });
  assert.equal(S([]), 'not_opened');
  assert.equal(S([open('2026-11-08 15:30:00')]), 'open');
  assert.equal(S([open('2026-11-08 15:30:00'), close('2026-11-08 15:20:00', '2026-11-08 15:41:00')]), 'closed', 'late closing wins');
  assert.equal(S([open('2026-11-08 15:41:00'), close('2026-11-08 15:20:00', '2026-11-08 15:41:00')]), 'closed', 'a tie is closed');
  assert.equal(S([open('2026-11-08 15:42:00'), close('2026-11-08 15:20:00', '2026-11-08 15:41:00')]), 'open', 'opened after it arrived');
  assert.equal(S([open('2026-11-08 15:10:00'), close('2026-11-08 15:20:00', '2026-11-08 15:20:00'), open('2026-11-08 15:50:00', 3)]), 'open');
  assert.equal(S([close('2026-11-08 15:20:00', '2026-11-08 15:10:00')]), 'closed', 'a closing with a fast clock still counts from its own time');
  const late = OPS.areaState([open('2026-11-08 15:30:00'), close('2026-11-08 15:20:00', '2026-11-08 15:41:00')], TZ).late;
  assert.deepEqual(late.map((x) => x.message), ['A closing sent at 10:20 arrived at 10:41 and closed the area.']);
});

test('crew add photos only to a standing inspection from today; a manager corrects with a reason', async () => {
  const id = ok(await api('POST', '/park/features', { token: T.staff, body: { name: 'Photo box', kind: 'butter_box', size: 's' } }), 201).id;
  const closing = ok(await api('POST', `/park/features/${id}/inspections`, { token: T.staff, body: { result: 'closed', kind: 'morning', notes: 'Cracked top', checklist: checks('butter_box'), no_photo_reason: 'No signal: photo to follow' } }), 201).id;
  ok(await photo(T.staff, id, `?inspection_id=${closing}`), 201);
  const old = ok(await api('POST', `/park/features/${id}/inspections`, { token: T.staff, body: { result: 'closed', kind: 'midday', notes: 'Still cracked', checklist: checks('butter_box'), no_photo_reason: 'Camera not working' } }), 201).id;
  await pool.query('UPDATE park_inspections SET inspected_on = ? WHERE id = ?', [yesterday, old]);
  is(await photo(T.staff, id, `?inspection_id=${old}`), 403, 'another day: crew');
  ok(await api('POST', `/park/inspections/${closing}/correct`, { token: T.manager, body: { reason: 'Wrong box' } }));
  is(await photo(T.staff, id, `?inspection_id=${closing}`), 403, 'entered in error: crew');
  is(await photo(T.manager, id, `?inspection_id=${old}`), 400, 'a manager says why');
  const added = ok(await photo(T.manager, id, `?inspection_id=${old}&reason=${encodeURIComponent('Photo from the crew phone')}`), 201).id;
  const [[ph]] = await pool.query('SELECT inspection_id, late_reason FROM park_photos WHERE id = ?', [added]);
  assert.equal(Number(ph.inspection_id), old); assert.equal(ph.late_reason, 'Photo from the crew phone');
});

test('a reopening photo is taken that day in the feature\'s inspection, not an old or unrelated one', async () => {
  const id = ok(await api('POST', '/park/features', { token: T.staff, body: { name: 'Reopen rail', kind: 'rail_kinked', size: 's' } }), 201).id;
  ok(await api('POST', `/park/features/${id}/inspections`, { token: T.staff, body: { result: 'closed', kind: 'morning', notes: 'Bent', checklist: checks('rail_kinked'), no_photo_reason: 'Camera not working' } }), 201);
  const reopen = (pid) => api('POST', `/park/features/${id}/inspections`, { token: T.staff, body: pass('rail_kinked', { kind: 'midday', fixed: 'Straightened', photo_ids: [pid] }) });
  const plain = ok(await photo(T.staff, id, ''), 201).id; // not taken in the inspection
  let r = is(await reopen(plain), 400); assert.equal(r.details.code, 'photo_not_today');
  const stale = ok(await photo(T.staff, id), 201).id;
  await pool.query('UPDATE park_photos SET uploaded_at = uploaded_at - INTERVAL 2 DAY WHERE id = ?', [stale]);
  r = is(await reopen(stale), 400, 'an old photo'); assert.equal(r.details.code, 'photo_not_today');
  const oldShot = ok(await photo(T.staff, id, `?for=inspection&taken_at=${yesterday}T09:00`), 201).id;
  is(await reopen(oldShot), 400, 'a photo taken another day');
  assert.equal((await featureOf(id)).status, 'closed');
  ok(await reopen(ok(await photo(T.staff, id), 201).id), 201);
  assert.equal((await featureOf(id)).status, 'ready');
});

test('the day record names the time zone as people say it', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/views/park.js'), 'utf8');
  assert.ok(!src.includes('Times are ${r.timezone}'));
  assert.ok(src.includes("timeZoneName: 'longGeneric'"));
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longGeneric' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName');
  assert.equal(p.value.replace(/ Time$/, ' time'), 'Eastern time');
});

test('the website says what the code does about failed items, notes and photos', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '../src/site', f), 'utf8');
  const park = read('terrainpark.html'); const guide = read('guide-terrainpark.html'); const product = read('product.html');
  for (const s of [park, guide]) assert.ok(!/A failed check closes the feature|fails inspection shows as closed|failed check that keeps the feature closed/.test(s));
  assert.ok(park.includes('A failed item is logged as Needs attention or Closed'));
  assert.ok(park.includes('closing needs a photo or a reason there is none'));
  assert.ok(guide.includes('a failed item is logged as Needs attention or Closed'));
  assert.ok(!product.includes('a problem needs a note and a photo'));
  assert.ok(product.includes('Needs attention needs a note, closing needs a photo or a reason there is none'));
});
