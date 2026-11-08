'use strict';

// Terrain park records (2026.11.12): only an inspection opens a feature; the history of every change with before and
// after values; corrections to past days that keep the original; checklists by feature type with notes on a fail;
// photos on closing and reopening; the opening sign-off per area; a feature larger than its area's rating; closing an area
// for weather; a patrol case linked to a feature with a snapshot, and the post-incident reopening rule; the phone's own
// times and ids for entries sent later (the outbox); one mountain never reaching another's park.
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
  A = await mountain(`prk-${suffix}`); B = await mountain(`prb-${suffix}`);
  for (const role of ['staff', 'counter', 'manager']) {
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

test('a new feature is not inspected yet; status is never set by hand, only by an inspection', async () => {
  const list = ok(await api('GET', '/park/features', { token: T.staff })).data;
  assert.equal(list.find((f) => f.id === D.rail).status, 'new', 'a new feature waits for its first inspection');
  is(await api('POST', '/park/features', { token: T.staff, body: { name: 'Sneaky', kind: 'butter_box', status: 'ready' } }), 400, 'no status on create');
  is(await api('PATCH', `/park/features/${D.rail}`, { token: T.staff, body: { status: 'ready' } }), 400, 'no status on edit');
  is(await api('PATCH', `/park/features/${D.rail}`, { token: T.manager, body: { status: 'retired' } }), 400, 'not even a manager, not through edit');
  ok(await api('POST', `/park/features/${D.rail}/inspections`, { token: T.staff, body: pass('rail_kinked') }), 201);
  assert.equal(ok(await api('GET', '/park/features', { token: T.staff })).data.find((f) => f.id === D.rail).status, 'ready');
  const words = ok(await api('GET', '/park/meta', { token: T.counter })).results;
  assert.equal(words.find((r) => r[0] === 'ok')[1], 'Inspected, no defects found, open', 'the pass never says safe');
});

test('closing needs a photo; a reopening inspection needs what was fixed and a photo', async () => {
  is(await api('POST', `/park/features/${D.rail}/inspections`, { token: T.staff, body: { ...pass('rail_kinked', { result: 'closed', notes: 'Bolt loose on the kink' }) } }), 400, 'close without a photo');
  const pic = (await photo(T.staff, D.rail)).body.id;
  const closed = ok(await api('POST', `/park/features/${D.rail}/inspections`, { token: T.staff, body: { ...pass('rail_kinked', { result: 'closed', notes: 'Bolt loose on the kink', photo_ids: [pic] }) } }), 201);
  assert.equal(closed.status, 'closed');
  is(await api('POST', `/park/features/${D.rail}/inspections`, { token: T.staff, body: { ...pass('rail_kinked', { result: 'closed', notes: 'Again', photo_ids: [pic] }) } }), 400, 'a photo already on an inspection cannot be used again');
  // reopening
  let r = is(await api('POST', `/park/features/${D.rail}/inspections`, { token: T.staff, body: pass('rail_kinked') }), 400, 'reopen with nothing');
  assert.equal(r.details.code, 'fixed_required');
  r = is(await api('POST', `/park/features/${D.rail}/inspections`, { token: T.staff, body: pass('rail_kinked', { fixed: 'Tightened the kink bolts' }) }), 400, 'reopen without a photo');
  assert.equal(r.details.code, 'photo_required');
  const pic2 = (await photo(T.staff, D.rail)).body.id;
  const re = ok(await api('POST', `/park/features/${D.rail}/inspections`, { token: T.staff, body: pass('rail_kinked', { fixed: 'Tightened the kink bolts', photo_ids: [pic2] }) }), 201);
  assert.equal(re.status, 'ready'); assert.equal(re.reopened, true);
  const hist = ok(await api('GET', `/park/features/${D.rail}/inspections`, { token: T.counter })).data;
  assert.equal(hist[0].fixed, 'Tightened the kink bolts'); assert.equal(hist[0].photos, 1); assert.equal(hist[0].result_label, 'Inspected, no defects found, open');
  // a closing with no signal: no photo, but the reason, and the photo follows onto that inspection
  const offline = ok(await api('POST', `/park/features/${D.rail}/inspections`, { token: T.staff, body: { ...pass('rail_kinked', { result: 'closed', notes: 'Cracked weld', no_photo_reason: 'No signal: photo to follow' }) } }), 201);
  ok(await photo(T.staff, D.rail, `?inspection_id=${offline.id}`), 201);
  const later = ok(await api('GET', `/park/features/${D.rail}/inspections`, { token: T.staff })).data.find((i) => i.id === offline.id);
  assert.equal(later.photos, 1, 'the photo joined the closing');
  // the photo is kept as uploaded and can be verified
  const v = ok(await api('GET', `/park/photos/${pic}/verify`, { token: T.staff }));
  assert.equal(v.unchanged, true);
  const orig = await fetch(`${base}/api/v1/park/photos/${pic}/original`, { headers: { authorization: `Bearer ${T.staff}` } });
  assert.equal(orig.headers.get('x-content-sha256'), v.recorded);
  is(await api('GET', `/park/photos/${pic}/verify`, { token: B.owner }), 404, 'another mountain cannot reach the photo');
  // reopen the rail for the tests below
  ok(await api('POST', `/park/features/${D.rail}/inspections`, { token: T.staff, body: pass('rail_kinked', { fixed: 'Welded', photo_ids: [(await photo(T.staff, D.rail)).body.id] }) }), 201);
});

test('the checklist follows the feature type; every item is answered and a fail needs a note', async () => {
  const keys = (k) => P.checklistFor(k).map((c) => c.key);
  assert.deepEqual(keys('tabletop'), ['approach', 'takeoff_lip', 'knuckle', 'landing', 'run_out', 'deck_gap', 'signage', 'surface']);
  assert.deepEqual(keys('rail_down'), ['burrs', 'hardware', 'end_caps', 'buried_ends', 'snow_on_off', 'signage', 'surface']);
  assert.deepEqual(keys('butter_box'), keys('rail_down'), 'boxes are checked like rails');
  assert.deepEqual(keys('halfpipe'), ['walls', 'deck', 'transitions', 'signage', 'surface']);
  assert.deepEqual(keys('wall_ride'), keys('halfpipe'), 'a wall ride is checked like a wall');
  const kinds = ok(await api('GET', '/park/kinds', { token: T.counter })).data;
  assert.ok(kinds.find((k) => k.key === 'tabletop').checks.length === 8, 'the screens get the checklist');
  let r = is(await api('POST', `/park/features/${D.table}/inspections`, { token: T.staff, body: { result: 'ok', kind: 'morning', checklist: checks('tabletop').slice(1) } }), 400, 'an item left out');
  assert.equal(r.details.code, 'checklist_missing');
  const failNoNote = checks('tabletop').map((c) => (c.key === 'knuckle' ? { key: 'knuckle', result: 'fail' } : c));
  r = is(await api('POST', `/park/features/${D.table}/inspections`, { token: T.staff, body: { result: 'needs_attention', kind: 'morning', notes: 'Knuckle', checklist: failNoNote } }), 400, 'a fail without a note');
  assert.equal(r.details.code, 'fail_note');
  r = is(await api('POST', `/park/features/${D.table}/inspections`, { token: T.staff, body: { result: 'ok', kind: 'morning', checklist: checks('tabletop', ['knuckle']) } }), 400, 'a fail cannot pass');
  assert.equal(r.details.code, 'fail_pass');
  is(await api('POST', `/park/features/${D.table}/inspections`, { token: T.staff, body: { result: 'ok', kind: 'whenever', checklist: checks('tabletop') } }), 400, 'an unknown inspection type');
  is(await api('POST', `/park/features/${D.table}/inspections`, { token: T.staff, body: { result: 'ok', kind: 'morning', checklist: [...checks('tabletop'), { key: 'bolts', result: 'pass' }] } }), 400, 'an item from another checklist');
  const saved = ok(await api('POST', `/park/features/${D.table}/inspections`, { token: T.staff, body: { result: 'needs_attention', kind: 'after_snow', notes: 'Soft knuckle', checklist: checks('tabletop', ['knuckle']) } }), 201);
  const row = ok(await api('GET', `/park/features/${D.table}/inspections`, { token: T.staff })).data.find((i) => i.id === saved.id);
  assert.equal(row.kind, 'after_snow'); assert.equal(row.checklist.length, 8, 'each item is saved');
  assert.equal(row.checklist.find((c) => c.key === 'knuckle').note, 'Knuckle worn');
  for (const k of ['morning', 'midday', 'after_grooming', 'after_snow', 'after_change', 'post_incident']) assert.ok(P.INSPECTION_KIND_KEYS.includes(k));
});

test('every change keeps before and after values; size and dimensions need a reason; retiring is a manager action', async () => {
  is(await api('PATCH', `/park/features/${D.box}`, { token: T.staff, body: { size: 'm' } }), 400, 'a size change needs a reason');
  is(await api('PATCH', `/park/features/${D.box}`, { token: T.staff, body: { dimensions: '12 ft' } }), 400, 'a dimension change needs a reason');
  ok(await api('PATCH', `/park/features/${D.box}`, { token: T.staff, body: { size: 'm', dimensions: '12 ft', reason: 'Swapped for the longer box' } }));
  ok(await api('PATCH', `/park/features/${D.box}`, { token: T.staff, body: { kind: 'down_box', name: 'Down box' } }));
  ok(await api('PATCH', `/park/features/${D.box}`, { token: T.staff, body: { notes: 'Only a note' } }), 200);
  const ch = await changesOf(D.box);
  assert.deepEqual(ch.find((c) => c.field === 'size'), { field: 'size', before_value: 's', after_value: 'm', reason: 'Swapped for the longer box', source: 'edit' });
  assert.equal(ch.find((c) => c.field === 'dimensions').before_value, null); assert.equal(ch.find((c) => c.field === 'dimensions').after_value, '12 ft');
  assert.equal(ch.find((c) => c.field === 'kind').before_value, 'butter_box');
  assert.equal(ch.find((c) => c.field === 'name').after_value, 'Down box');
  // an area's rating
  is(await api('PATCH', `/park/areas/${D.main}`, { token: T.staff, body: { level: 'l' } }), 400, 'a rating change needs a reason');
  is(await api('PATCH', `/park/areas/${D.main}`, { token: T.staff, body: { level: 'pro', reason: 'x y z' } }), 400, 'the old level names are gone');
  ok(await api('PATCH', `/park/areas/${D.main}`, { token: T.staff, body: { level: 'l', reason: 'Bigger jumps this season' } }));
  const ah = ok(await api('GET', `/park/areas/${D.main}/history`, { token: T.staff }));
  assert.equal(ah.changes[0].before_value, 'm'); assert.equal(ah.changes[0].after_value, 'l');
  // retiring
  const spare = ok(await api('POST', '/park/features', { token: T.staff, body: { name: 'Old barrel', kind: 'barrel', size: 's' } }), 201).id;
  is(await api('POST', `/park/features/${spare}/retire`, { token: T.staff, body: { reason: 'Split' } }), 403, 'crew do not retire');
  is(await api('POST', `/park/features/${spare}/retire`, { token: T.manager, body: {} }), 400, 'a reason is needed');
  ok(await api('POST', `/park/features/${spare}/retire`, { token: T.manager, body: { reason: 'Split down the middle' } }));
  ok(await api('POST', `/park/features/${spare}/unretire`, { token: T.manager, body: { reason: 'Repaired' } }));
  const sc = await changesOf(spare);
  assert.deepEqual(sc.map((c) => [c.before_value, c.after_value, c.source]), [['new', 'retired', 'retire'], ['retired', 'new', 'retire']], 'brought back as not inspected');
  // the history shows it all
  const h = ok(await api('GET', `/park/features/${D.box}/history`, { token: T.staff }));
  assert.ok(h.changes.some((c) => c.field === 'size' && c.reason === 'Swapped for the longer box'));
  assert.ok(h.changes.every((c) => c.changed_by), 'with who');
  const audits = (await pool.query("SELECT action FROM audit_log WHERE tenant_id = ? AND entity = 'park_features'", [A.tenant]))[0].map((r) => r.action);
  for (const a of ['update', 'retire', 'unretire', 'inspect', 'add_photo']) assert.ok(audits.includes(a), `${a} is audited`);
});

test('past days: no hard delete or silent edit; corrections keep the original; a late entry is flagged', async () => {
  is(await api('PUT', `/park/placements/${yesterday}/${D.rail}`, { token: T.staff, body: { ...spot(1), reason: 'Missed it' } }), 403, 'crew cannot change a past day');
  is(await api('PUT', `/park/placements/${yesterday}/${D.rail}`, { token: T.manager, body: spot(1) }), 400, 'a manager says why');
  const late = ok(await api('PUT', `/park/placements/${yesterday}/${D.rail}`, { token: T.manager, body: { ...spot(1), area_id: D.main, reason: 'Missed on the day' } }), 201);
  assert.equal(late.late, true);
  let y = ok(await api('GET', `/park/placements/${yesterday}`, { token: T.staff }));
  assert.equal(y.placed[0].late, true); assert.equal(y.placed[0].late_reason, 'Missed on the day'); assert.equal(y.editable, false);
  // a correction: the old position stays
  const c = ok(await api('PUT', `/park/placements/${yesterday}/${D.rail}`, { token: T.manager, body: { ...spot(2), area_id: D.main, note: 'Moved left', reason: 'Wrong spot recorded' } }));
  assert.equal(c.corrected, true);
  // taking it off a past day keeps it, struck through
  is(await api('DELETE', `/park/placements/${yesterday}/${D.rail}`, { token: T.manager }), 400, 'a reason is needed');
  ok(await api('DELETE', `/park/placements/${yesterday}/${D.rail}?reason=${encodeURIComponent('Was not set up that day')}`, { token: T.manager }));
  const kept = (await pool.query('SELECT voided_at, void_reason FROM park_placements WHERE tenant_id = ? AND feature_id = ? AND on_date = ?', [A.tenant, D.rail, yesterday]))[0][0];
  assert.ok(kept && kept.voided_at, 'the row is kept'); assert.equal(kept.void_reason, 'Was not set up that day');
  y = ok(await api('GET', `/park/placements/${yesterday}`, { token: T.staff }));
  assert.equal(y.placed.length, 0, 'not on the day now');
  const hist = ok(await api('GET', `/park/features/${D.rail}/history`, { token: T.staff }));
  const corr = hist.corrections.map((x) => x.action);
  assert.deepEqual(corr.sort(), ['change', 'remove']);
  const change = hist.corrections.find((x) => x.action === 'change');
  assert.ok(Math.abs(change.before.lat - spot(1).lat) < 1e-6, 'the original position is kept'); assert.ok(Math.abs(change.after.lat - spot(2).lat) < 1e-6);
  assert.equal(change.reason, 'Wrong spot recorded'); assert.ok(change.corrected_by);
  assert.ok(hist.data.some((p) => p.voided_at && p.void_reason === 'Was not set up that day'), 'the history shows it struck through');
  // copying onto a past day is a late entry too
  is(await api('POST', `/park/placements/${yesterday}/copy`, { token: T.manager, body: { from: day(-2) } }), 400, 'a reason is needed');
  // inspections are never edited or deleted; a manager corrects one with a new row
  const insp = ok(await api('GET', `/park/features/${D.table}/inspections`, { token: T.staff })).data[0];
  is(await api('DELETE', `/park/inspections/${insp.id}`, { token: T.manager }), 404);
  is(await api('POST', `/park/inspections/${insp.id}/correct`, { token: T.staff, body: { reason: 'Wrong feature' } }), 403, 'crew do not correct');
  const fixed = ok(await api('POST', `/park/inspections/${insp.id}/correct`, { token: T.manager, body: { reason: 'Logged on the wrong day', replacement: { result: 'needs_attention', notes: 'Soft knuckle, checked at 9' } } }));
  const after = ok(await api('GET', `/park/features/${D.table}/inspections`, { token: T.staff })).data;
  const orig = after.find((i) => i.id === insp.id); const repl = after.find((i) => i.id === fixed.id);
  assert.ok(orig.voided_at && orig.void_reason === 'Logged on the wrong day' && orig.voided_by, 'the original stays, marked, with who and why');
  assert.equal(orig.result, insp.result, 'and unchanged');
  assert.equal(repl.corrects_id, insp.id); assert.equal(repl.inspected_at, orig.inspected_at, 'the correction keeps the original time');
  is(await api('POST', `/park/inspections/${insp.id}/correct`, { token: T.manager, body: { reason: 'Again' } }), 409);
});

test('an area opens with the sign-off, and not while a feature in it is uninspected or closed (unless roped off)', async () => {
  ok(await api('PUT', `/park/placements/${today}/${D.rail}`, { token: T.staff, body: { ...spot(3), area_id: D.main } }), 201);
  ok(await api('PUT', `/park/placements/${today}/${D.table}`, { token: T.staff, body: { ...spot(4), area_id: D.main } }), 201);
  const all = Object.fromEntries(P.SIGNOFF_KEYS.map((k) => [k, true]));
  is(await api('PATCH', `/park/areas/${D.main}`, { token: T.staff, body: { status: 'open' } }), 400, 'not through edit');
  let r = is(await api('POST', `/park/areas/${D.main}/open`, { token: T.staff, body: { checklist: { ...all, test_ride: false }, supervisor_name: 'Sam Super' } }), 400, 'every item ticked');
  assert.deepEqual(r.details.missing, ['test_ride']);
  // the rail was inspected earlier today; the tabletop needs attention but was inspected today too: it is closed? no, needs attention
  // close the tabletop so it blocks
  ok(await api('POST', `/park/features/${D.table}/inspections`, { token: T.staff, body: { ...pass('tabletop', { result: 'closed', notes: 'Landing too hard', photo_ids: [(await photo(T.staff, D.table)).body.id] }) } }), 201);
  r = is(await api('POST', `/park/areas/${D.main}/open`, { token: T.staff, body: { checklist: all, supervisor_name: 'Sam Super' } }), 409, 'blocked by a closed feature');
  assert.equal(r.details.code, 'area_blocked');
  assert.deepEqual(r.details.blocking.map((b) => [b.name, b.why]), [['Tabletop', 'Closed']]);
  const check = ok(await api('GET', `/park/areas/${D.main}/open-check`, { token: T.staff }));
  assert.equal(check.blocking.length, 1);
  // an uninspected feature blocks too
  const fresh = ok(await api('POST', '/park/features', { token: T.staff, body: { name: 'New rail', kind: 'rail_flat', size: 's' } }), 201).id;
  ok(await api('PUT', `/park/placements/${today}/${fresh}`, { token: T.staff, body: { ...spot(5), area_id: D.main } }), 201);
  r = is(await api('POST', `/park/areas/${D.main}/open`, { token: T.staff, body: { checklist: all, supervisor_name: 'Sam Super' } }), 409);
  assert.ok(r.details.blocking.some((b) => b.name === 'New rail' && b.why === 'Not inspected today'));
  // rope the closed one off, inspect the new one
  is(await api('PUT', `/park/placements/${today}/${D.table}/rope`, { token: T.staff, body: { roped_off: true } }), 400, 'say why');
  ok(await api('PUT', `/park/placements/${today}/${D.table}/rope`, { token: T.staff, body: { roped_off: true, note: 'Landing being rebuilt' } }));
  ok(await api('POST', `/park/features/${fresh}/inspections`, { token: T.staff, body: pass('rail_flat') }), 201);
  is(await api('POST', `/park/areas/${D.main}/open`, { token: T.counter, body: { checklist: all, supervisor_name: 'Sam Super' } }), 403, 'a counter login cannot open the park');
  const opened = ok(await api('POST', `/park/areas/${D.main}/open`, { token: T.staff, body: { checklist: all, supervisor_name: 'Sam Super', client_ref: `open${suffix}` } }), 201);
  const again = ok(await api('POST', `/park/areas/${D.main}/open`, { token: T.staff, body: { checklist: all, supervisor_name: 'Sam Super', client_ref: `open${suffix}` } }));
  assert.equal(again.id, opened.id, 'sent twice from the phone: kept once');
  const areas = ok(await api('GET', '/park/areas', { token: T.counter })).data;
  const main = areas.find((a) => a.id === D.main);
  assert.equal(main.today_status, 'open'); assert.equal(main.today.supervisor_name, 'Sam Super');
  assert.equal(areas.find((a) => a.id === D.kids).today_status, 'not_opened');
  // the public conditions feed shows the area, its rating and whether it opened today; nothing about features
  const feed = ok(await api('GET', `/public/${A.slug}/conditions`));
  assert.deepEqual(feed.park_areas.find((a) => a.name === 'Main'), { name: 'Main', rating: 'L', status: 'open' });
  assert.equal(feed.park_areas.find((a) => a.name === 'Kids zone').status, 'closed', 'not opened today shows closed');
  assert.ok(!JSON.stringify(feed.park_areas).includes('Tabletop'));
});

test('a feature larger than its area\'s rating warns and needs an override reason; the levels moved across', async () => {
  let r = is(await api('PUT', `/park/placements/${today}/${D.box}`, { token: T.staff, body: { ...spot(6), area_id: D.kids } }), 409, 'an M box in a beginner zone');
  assert.equal(r.details.code, 'over_rating');
  ok(await api('PUT', `/park/placements/${today}/${D.box}`, { token: T.staff, body: { ...spot(6), area_id: D.kids, size_override: 'Coached session, roped lane' } }), 201);
  const p = ok(await api('GET', `/park/placements/${today}`, { token: T.staff })).placed.find((x) => x.feature_id === D.box);
  assert.equal(p.over_rating, true); assert.equal(p.size_override, 'Coached session, roped lane');
  ok(await api('PUT', `/park/placements/${today}/${D.box}`, { token: T.staff, body: { ...spot(7), area_id: D.kids, how: 'drag' } }), 200, 'moving it in the same area keeps the reason');
  // moving it to another area is an area change in its history
  ok(await api('PUT', `/park/placements/${today}/${D.box}`, { token: T.staff, body: { ...spot(7), area_id: D.main } }));
  const ch = (await changesOf(D.box)).filter((c) => c.field === 'area');
  assert.deepEqual(ch.map((c) => [c.before_value, c.after_value]), [['Kids zone', 'Main']]);
  assert.ok(P.overRating('l', 'm') && !P.overRating('m', 'm') && P.overRating('m', 'beginner') && !P.overRating('s', 'beginner') && !P.overRating('xl', 'xl'));
  // the migration step moves the old level names across, and runs twice safely
  const step = require('../db/steps/park-records')({ tableExists: async () => true, columnExists: async () => true });
  const move = step.find((s) => s[0].includes('(move)'));
  assert.match(move[2], /'learn' THEN 'beginner'.*'small' THEN 's'.*'medium' THEN 'm'.*'large' THEN 'l'.*'pro' THEN 'xl'/s);
  const [[col]] = await pool.query("SELECT column_type AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'park_areas' AND column_name = 'level'");
  assert.equal(String(col.t || col.COLUMN_TYPE), "enum('beginner','s','m','l','xl')");
  const conn = await pool.getConnection();
  try { for (const [, done] of step) assert.equal(Boolean(await done(conn)), true, 'every step reports done on a second run'); } finally { conn.release(); }
});

test('closing an area for weather closes every placed feature, one record each; each reopens through an inspection', async () => {
  const before = ok(await api('GET', `/park/placements/${today}`, { token: T.staff })).placed.filter((p) => p.area_id === D.main);
  const openOnes = before.filter((p) => !['closed', 'retired'].includes(p.feature_status));
  assert.ok(openOnes.length >= 2);
  is(await api('POST', `/park/areas/${D.main}/close`, { token: T.staff, body: { reason_kind: 'visibility', reason: '' } }), 400, 'a reason');
  const r = ok(await api('POST', `/park/areas/${D.main}/close`, { token: T.staff, body: { reason_kind: 'visibility', reason: 'Fog, cannot see the landings' } }), 201);
  assert.equal(r.closed, openOnes.length);
  const rows = (await pool.query("SELECT feature_id, before_value, after_value, reason, ref_id FROM park_feature_changes WHERE tenant_id = ? AND source = 'area_close'", [A.tenant]))[0];
  assert.equal(rows.length, openOnes.length, 'one record per feature');
  assert.ok(rows.every((x) => x.after_value === 'closed' && x.reason.includes('Fog') && Number(x.ref_id) === r.id));
  const after = ok(await api('GET', `/park/placements/${today}`, { token: T.staff })).placed.filter((p) => p.area_id === D.main);
  assert.ok(after.every((p) => p.feature_status === 'closed'));
  assert.equal(ok(await api('GET', '/park/areas', { token: T.staff })).data.find((a) => a.id === D.main).today_status, 'closed');
  is(await api('POST', `/park/features/${D.rail}/inspections`, { token: T.staff, body: pass('rail_kinked') }), 400, 'reopening after weather needs what changed and a photo');
  ok(await api('POST', `/park/features/${D.rail}/inspections`, { token: T.staff, body: pass('rail_kinked', { kind: 'midday', fixed: 'Fog lifted, landings visible', photo_ids: [(await photo(T.staff, D.rail)).body.id] }) }), 201);
});

test('patrol picks the feature, the case keeps a snapshot, and a post-incident close needs a post-incident inspection', async () => {
  const at = localNow(1); // just after the rail's last inspection (the suite runs in seconds)
  const c = ok(await api('POST', '/patrol/incidents', { token: T.patrol, body: { occurred_at: at, location: 'Main park', category: 'injury', severity: 'serious', summary: 'Fell on the rail', form: { incident_location: 'freestyle_terrain' } } }));
  const placed = ok(await api('GET', `/patrol/park/placed?date=${today}`, { token: T.patrol })).data;
  assert.ok(placed.some((f) => f.id === D.rail && f.area === 'Main' && f.size_label === 'M'));
  is(await api('GET', `/patrol/park/placed?date=${today}`, { token: T.counter }), 403, 'only patrol');
  const link = ok(await api('POST', `/patrol/incidents/${c.id}/park-links`, { token: T.patrol, body: { feature_id: D.rail } }), 201);
  const s = link.snapshot;
  assert.equal(s.name, 'Kinked rail'); assert.equal(s.kind_label, 'Kinked rail'); assert.equal(s.size, 'm'); assert.equal(s.dimensions, '14 ft');
  assert.equal(s.area, 'Main'); assert.equal(s.area_level_label, 'L'); assert.equal(s.status, 'ready');
  assert.ok(s.last_inspection && s.last_inspection.by && s.last_inspection.at && s.last_inspection.result === 'ok', 'the last inspection with its time and inspector');
  is(await api('POST', `/patrol/incidents/${c.id}/park-links`, { token: T.patrol, body: { feature_id: D.rail } }), 409, 'linked once');
  const kase = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.patrol }));
  assert.match(kase.form.park_feature, /Kinked rail, Kinked rail, size M, 14 ft, in Main/, 'the typed field is filled when empty, and stays as the fallback');
  // later changes to the feature do not change the case's snapshot
  ok(await api('PATCH', `/park/features/${D.rail}`, { token: T.staff, body: { size: 'l', reason: 'Raised after the incident' } }));
  assert.equal(ok(await api('GET', `/patrol/incidents/${c.id}/park-links`, { token: T.patrol })).data[0].snapshot.size, 'm');
  // close it for a post-incident inspection from the case
  const sent = []; require('../src/lib/push').setTransport(async (url) => { sent.push(url); return { status: 201 }; });
  ok(await api('POST', `/patrol/incidents/${c.id}/park-links/${link.id}/close`, { token: T.patrol }));
  const f = ok(await api('GET', '/park/features', { token: T.staff })).data.find((x) => x.id === D.rail);
  assert.equal(f.status, 'closed'); assert.equal(f.needs_post_incident, true);
  const inbox = (await pool.query(`SELECT m.body FROM chat_messages m JOIN chat_members cm ON cm.tenant_id = m.tenant_id AND cm.thread_id = m.thread_id
    JOIN users u ON u.id = cm.user_id WHERE m.tenant_id = ? AND u.role IN ('owner','manager') AND m.body LIKE '%post-incident%'`, [A.tenant]))[0];
  assert.ok(inbox.length >= 2, 'the owner and the manager are told in their Inbox');
  assert.ok(!inbox.some((m) => /Fell on the rail|Pat Ridge/.test(m.body)), 'no patient or case details in the notice');
  // only a post-incident inspection reopens it
  const pic = (await photo(T.staff, D.rail)).body.id;
  const r = is(await api('POST', `/park/features/${D.rail}/inspections`, { token: T.staff, body: pass('rail_kinked', { fixed: 'Checked after the fall', photo_ids: [pic] }) }), 400);
  assert.equal(r.details.code, 'post_incident_required');
  ok(await api('POST', `/park/features/${D.rail}/inspections`, { token: T.staff, body: pass('rail_kinked', { kind: 'post_incident', fixed: 'Checked after the fall, no defects found', photo_ids: [pic] }) }), 201);
  const f2 = ok(await api('GET', '/park/features', { token: T.staff })).data.find((x) => x.id === D.rail);
  assert.equal(f2.status, 'ready'); assert.equal(f2.needs_post_incident, false);
  // from the feature itself: the crew or patrol, with a reason; a counter login cannot
  is(await api('POST', `/park/features/${D.box}/close-for-incident`, { token: T.counter, body: { reason: 'Rider hurt' } }), 403);
  ok(await api('POST', `/park/features/${D.box}/close-for-incident`, { token: T.patrol, body: { reason: 'Rider hurt on the box' } }));
  assert.equal(ok(await api('GET', '/park/features', { token: T.staff })).data.find((x) => x.id === D.box).needs_post_incident, true);
  // the feature's history lists the case: number and date only, and only for the park crew and patrol
  const hist = ok(await api('GET', `/park/features/${D.rail}/history`, { token: T.staff }));
  assert.equal(hist.incidents.length, 1);
  assert.deepEqual(Object.keys(hist.incidents[0]).sort(), ['case_number', 'date', 'incident_id']);
  assert.equal(ok(await api('GET', `/park/features/${D.rail}/history`, { token: T.counter })).incidents, null, 'a counter login does not see cases');
  // an approved or held case cannot take a new link
  await pool.query('UPDATE incidents SET legal_hold = 1 WHERE tenant_id = ? AND id = ?', [A.tenant, c.id]);
  is(await api('POST', `/patrol/incidents/${c.id}/park-links`, { token: T.patrol, body: { feature_id: D.table } }), 409, 'legal hold');
  await pool.query('UPDATE incidents SET legal_hold = 0 WHERE tenant_id = ? AND id = ?', [A.tenant, c.id]);
  ok(await api('POST', `/patrol/incidents/${c.id}/park-links/${link.id}/void`, { token: T.patrol, body: { reason: 'Wrong rail' } }));
  assert.ok(ok(await api('GET', `/patrol/incidents/${c.id}/park-links`, { token: T.patrol })).data[0].voided_at, 'kept, marked entered in error');
});

// 2026.11.12 merge: a case's park links follow the patient-record rule (feat/auth-hardening), and the feature's history
// lists the linked cases by case number and date only.
test('park links on a case need the records check for someone with no part in it; the feature lists case number and date only', async () => {
  const c = ok(await api('POST', '/patrol/incidents', { token: T.patrol, body: { occurred_at: localNow(1), location: 'Main park', category: 'injury', severity: 'minor', summary: 'Slid out on the rail', form: { incident_location: 'freestyle_terrain' } } }));
  const link = ok(await api('POST', `/patrol/incidents/${c.id}/park-links`, { token: T.patrol, body: { feature_id: D.rail } }), 201);
  const l = { id: link.id, incident_id: c.id, feature_id: D.rail };
  const other = Number(ok(await api('POST', '/patrol/team', { token: A.owner, body: { person: { first_name: 'Sam', last_name: 'Other' }, level: 'patroller' } })).staff_id);
  ok(await api('POST', '/users', { token: A.owner, body: { email: `pat2@${A.slug}.test`, password: PW, role: 'patrol', staff_id: other } }));
  const t2 = await login(A, `pat2@${A.slug}.test`);
  let r = is(await api('GET', `/patrol/incidents/${l.incident_id}/park-links`, { token: t2 }), 403, 'not their case');
  assert.equal(r.details.code, 'step_up_required');
  r = is(await api('POST', `/patrol/incidents/${l.incident_id}/park-links/${l.id}/close`, { token: t2 }), 403, 'no write either');
  assert.equal(r.details.scope, 'records');
  is(await api('GET', `/patrol/incidents/0${l.incident_id}/park-links`, { token: t2 }), 400, 'one spelling of the id');
  await require('./helpers/records').records(base, PW)(t2);
  assert.ok(ok(await api('GET', `/patrol/incidents/${l.incident_id}/park-links`, { token: t2 })).data.length, 'opens after the check');
  const hist = ok(await api('GET', `/park/features/${l.feature_id}/history`, { token: T.staff }));
  assert.ok(hist.incidents.length);
  for (const i of hist.incidents) assert.deepEqual(Object.keys(i).sort(), ['case_number', 'date', 'incident_id']);
  assert.equal(ok(await api('GET', `/park/features/${l.feature_id}/history`, { token: T.counter })).incidents, null, 'not for the ticket window');
});

test('entries sent later from the phone keep their own time, are kept once, and a time in the future is refused', async () => {
  const at = localNow(-45);
  const ref = `ph${suffix}x1`;
  const first = ok(await api('POST', `/park/features/${D.table}/inspections`, { token: T.staff, body: { ...pass('tabletop', { result: 'needs_attention', notes: 'Ruts on the landing', at, client_ref: ref }) } }), 201);
  const repeat = ok(await api('POST', `/park/features/${D.table}/inspections`, { token: T.staff, body: { ...pass('tabletop', { result: 'needs_attention', notes: 'Ruts on the landing', at, client_ref: ref }) } }), 200);
  assert.equal(repeat.id, first.id); assert.equal(repeat.repeat, true);
  const row = ok(await api('GET', `/park/features/${D.table}/inspections`, { token: T.staff })).data.find((i) => i.id === first.id);
  assert.equal(row.inspected_at.slice(0, 16), at.replace('T', ' '), 'the time it happened, in mountain time');
  assert.ok(row.received_at > row.inspected_at, 'and when it reached the server');
  const fut = is(await api('POST', `/park/features/${D.table}/inspections`, { token: T.staff, body: { ...pass('tabletop', { result: 'needs_attention', notes: 'x', at: localNow(60 * 26) }) } }), 400);
  assert.equal(fut.details.code, 'future_time'); assert.equal(fut.details.field, 'at'); assert.ok(fut.details.server_now, 'so the phone can move its clock back');
  is(await api('POST', `/park/features/${D.table}/inspections`, { token: T.staff, body: { ...pass('tabletop', { result: 'needs_attention', notes: 'x', at: localNow(-60 * 30) }) } }), 400, 'more than a day old');
  // photos are kept once by their phone id too
  const p1 = await photo(T.staff, D.table, `?client_ref=pic${suffix}`); const p2 = await photo(T.staff, D.table, `?client_ref=pic${suffix}`);
  assert.equal(p1.status, 201); assert.equal(p2.status, 200); assert.equal(p2.body.id, p1.body.id);
  // the screens send park writes through the patrol outbox, under the park's own queue
  const view = fs.readFileSync(path.join(__dirname, '../public/js/views/park.js'), 'utf8');
  const box = fs.readFileSync(path.join(__dirname, '../public/js/outbox.js'), 'utf8');
  assert.match(box, /export const PARK_QUEUE = 0/);
  for (const what of ['/inspections`, body, { caseId: PARK_QUEUE', '/open`, body, { caseId: PARK_QUEUE', '/close`, {', '/rope`, {', "send('PUT', `/park/placements/"]) assert.ok(view.includes(what), `the view queues ${what}`);
  assert.match(view, /Not saved: \$\{x\.label\}/, 'a refused entry shows as Not saved');
  assert.match(view, /fixClock/, 'with Fix the time and send');
  assert.ok(view.includes('sendPhoto(`/park/features/${fid}/photos'), 'inspection photos go through the outbox too (2026.11.13)');
  assert.match(view, /All checks OK/);
});

test('one mountain never reaches another\'s park records', async () => {
  const insp = ok(await api('GET', `/park/features/${D.table}/inspections`, { token: T.staff })).data[0];
  const caseRow = (await pool.query('SELECT id FROM incidents WHERE tenant_id = ? LIMIT 1', [A.tenant]))[0][0];
  const link = (await pool.query('SELECT id FROM incident_park_links WHERE tenant_id = ? LIMIT 1', [A.tenant]))[0][0];
  const all = Object.fromEntries(P.SIGNOFF_KEYS.map((k) => [k, true]));
  for (const [m, p, body] of [
    ['GET', `/park/features/${D.rail}/history`], ['GET', `/park/features/${D.rail}/photos`], ['GET', `/park/areas/${D.main}/history`], ['GET', `/park/areas/${D.main}/record/${today}`],
    ['GET', `/park/areas/${D.main}/open-check`], ['POST', `/park/areas/${D.main}/open`, { checklist: all, supervisor_name: 'Bee' }], ['POST', `/park/areas/${D.main}/close`, { reason_kind: 'wind', reason: 'Windy day' }],
    ['POST', `/park/features/${D.rail}/inspections`, pass('rail_kinked')], ['POST', `/park/features/${D.rail}/retire`, { reason: 'Not ours' }], ['POST', `/park/features/${D.rail}/close-for-incident`, { reason: 'Not ours' }],
    ['POST', `/park/inspections/${insp.id}/correct`, { reason: 'Not ours' }], ['PUT', `/park/placements/${today}/${D.rail}/rope`, { roped_off: true, note: 'x' }],
    ['GET', `/patrol/incidents/${caseRow.id}/park-links`], ['POST', `/patrol/incidents/${caseRow.id}/park-links`, { feature_id: D.rail }], ['POST', `/patrol/incidents/${caseRow.id}/park-links/${link.id}/close`, {}],
  ]) {
    const r = await api(m, p, { token: B.owner, body });
    assert.ok([403, 404].includes(r.status), `${m} ${p}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  assert.equal((await photo(B.owner, D.rail)).status, 404, 'a photo onto our feature');
  assert.equal(ok(await api('GET', `/patrol/park/placed?date=${today}`, { token: B.owner })).data.length, 0);
  assert.equal(ok(await api('GET', '/park/areas', { token: B.owner })).data.length, 0);
});

test('the day record holds the layout, status changes with times, inspections with names, the sign-off and corrections', async () => {
  const r = ok(await api('GET', `/park/areas/${D.main}/record/${today}`, { token: T.counter }));
  assert.equal(r.area.name, 'Main'); assert.equal(r.area.level_label, 'L');
  assert.ok(r.features.length >= 3 && r.features.every((f) => typeof f.lat === 'number' && f.size_label));
  assert.ok(r.days.some((d) => d.action === 'open' && d.supervisor_name === 'Sam Super' && d.checklist.length === P.SIGNOFF.length));
  assert.ok(r.days.some((d) => d.action === 'close' && d.reason_kind === 'visibility'));
  assert.ok(r.changes.some((c) => c.field === 'status' && c.source === 'area_close' && c.changed_at && c.changed_by));
  assert.ok(r.changes.some((c) => c.field === 'roped'));
  assert.ok(r.inspections.length && r.inspections.every((i) => i.inspected_by && i.inspected_at));
  const y = ok(await api('GET', `/park/areas/${D.main}/record/${yesterday}`, { token: T.staff }));
  assert.ok(y.corrections.some((c) => c.action === 'remove' && c.reason === 'Was not set up that day'), 'corrections show on the past day');
  assert.ok(y.features.some((f) => f.voided_at), 'the removed placement is still listed, struck through');
  is(await api('GET', `/park/areas/${D.main}/record/not-a-day`, { token: T.staff }), 400);
});
