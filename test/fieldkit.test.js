'use strict';

// The patrol field kit: photos on a case that stand up as evidence, a case started with no signal, locating a caller by a
// texted link, and check steps that take a reading or a date and fail by themselves outside their rule.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const modules = require('../src/lib/modules');
const { photoFacts, sniff } = require('../src/lib/exif');
const CR = require('../src/lib/checkrules');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const slug = `fk-${suffix}`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

async function api(method, path, { token, body, raw, type } = {}) {
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}) };
  if (raw) headers['content-type'] = type || 'application/octet-stream'; else if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: raw || (body ? JSON.stringify(body) : undefined) });
  const buf = Buffer.from(await res.arrayBuffer());
  let json; try { json = JSON.parse(buf.toString()); } catch (_) { json = buf; }
  return { status: res.status, body: json, headers: res.headers, bytes: buf };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body).slice(0, 300)}`);

/** A small JPEG with an EXIF block: DateTimeOriginal and a GPS position (little-endian TIFF). */
function jpegWithExif({ when = '2026:01:17 10:42:05', lat = [44, 30, 15], latRef = 'N', lng = [72, 47, 30], lngRef = 'W' } = {}) {
  const parts = []; // [offset, Buffer] inside the TIFF
  const tiff = Buffer.alloc(400);
  tiff.write('II', 0, 'latin1'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  // IFD0 at 8: 2 entries (ExifIFD pointer, GPS pointer)
  let o = 8; tiff.writeUInt16LE(2, o); o += 2;
  const exifAt = 8 + 2 + 2 * 12 + 4; // 38
  tiff.writeUInt16LE(0x8769, o); tiff.writeUInt16LE(4, o + 2); tiff.writeUInt32LE(1, o + 4); tiff.writeUInt32LE(exifAt, o + 8); o += 12;
  const gpsAt = exifAt + 2 + 12 + 4 + 20; // after Exif IFD and its date string
  tiff.writeUInt16LE(0x8825, o); tiff.writeUInt16LE(4, o + 2); tiff.writeUInt32LE(1, o + 4); tiff.writeUInt32LE(gpsAt, o + 8); o += 12;
  tiff.writeUInt32LE(0, o);
  // Exif IFD: DateTimeOriginal (ASCII 20 bytes) stored right after the IFD
  o = exifAt; tiff.writeUInt16LE(1, o); o += 2;
  const dateAt = exifAt + 2 + 12 + 4;
  tiff.writeUInt16LE(0x9003, o); tiff.writeUInt16LE(2, o + 2); tiff.writeUInt32LE(20, o + 4); tiff.writeUInt32LE(dateAt, o + 8); o += 12;
  tiff.writeUInt32LE(0, o);
  tiff.write(`${when}\0`, dateAt, 'latin1');
  // GPS IFD: 4 entries, rationals after it
  o = gpsAt; tiff.writeUInt16LE(4, o); o += 2;
  const ratAt = gpsAt + 2 + 4 * 12 + 4;
  const ent = (tag, type, count, valueOrOffset, inline) => { tiff.writeUInt16LE(tag, o); tiff.writeUInt16LE(type, o + 2); tiff.writeUInt32LE(count, o + 4); if (inline) tiff.write(inline, o + 8, 'latin1'); else tiff.writeUInt32LE(valueOrOffset, o + 8); o += 12; };
  ent(1, 2, 2, 0, `${latRef}\0`); ent(2, 5, 3, ratAt); ent(3, 2, 2, 0, `${lngRef}\0`); ent(4, 5, 3, ratAt + 24);
  tiff.writeUInt32LE(0, o);
  [...lat, ...lng].forEach((v, i) => { tiff.writeUInt32LE(v, ratAt + i * 8); tiff.writeUInt32LE(1, ratAt + i * 8 + 4); });
  void parts;
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff.subarray(0, ratAt + 48)]);
  const app1 = Buffer.alloc(4); app1.writeUInt16BE(0xffe1, 0); app1.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, body, Buffer.from([0xff, 0xda, 0x00, 0x02]), crypto.randomBytes(256), Buffer.from([0xff, 0xd9])]);
}
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), crypto.randomBytes(64)]);

const T = {};
test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => { server.on('listening', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Field Kit Peak', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  T.owner = (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token;
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
  T.id = t.id;
  await pool.query("INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, 'assets', 1) ON DUPLICATE KEY UPDATE enabled = 1", [T.id]);
  modules.invalidate(T.id);
  const s1 = ok(await api('POST', '/workforce/staff', { token: T.owner, body: { person: { first_name: 'Pat', last_name: 'Rescuer' }, status: 'active' } })).id;
  ok(await api('POST', '/patrol/team', { token: T.owner, body: { staff_id: s1, callsign: 'Patrol 4', patrol_number: '417' } }));
  ok(await api('POST', '/users', { token: T.owner, body: { email: `pat@${slug}.test`, password: PW, role: 'patrol', staff_id: s1 } }));
  T.pat = (await api('POST', '/auth/login', { body: { tenant: slug, email: `pat@${slug}.test`, password: PW } })).body.token;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

const newCase = (over = {}) => api('POST', '/patrol/incidents', { token: T.pat, body: { occurred_at: `${today}T10:15`, location: 'Upper Ridge', category: 'injury', severity: 'moderate', summary: 'Skier down', ...over } });

test('EXIF: when and where a photo was taken come from the file; other formats are recognized but carry none', () => {
  const f = photoFacts(jpegWithExif());
  assert.equal(f.taken_at, '2026-01-17 10:42:05');
  assert.equal(f.lat, 44.504167); assert.equal(f.lng, -72.791667);
  assert.deepEqual(photoFacts(PNG), { taken_at: null, lat: null, lng: null });
  assert.deepEqual(photoFacts(Buffer.from('not a photo at all')), { taken_at: null, lat: null, lng: null });
  assert.equal(sniff(PNG), 'image/png'); assert.equal(sniff(jpegWithExif()), 'image/jpeg'); assert.equal(sniff(Buffer.from('hello world, a text file')), null);
});

test('a case photo is kept byte for byte with its fingerprint, verified, previewed, and only ever marked entered in error', async () => {
  const c = ok(await newCase({ patient: { first_name: 'Hal', last_name: 'Head' } }));
  assert.ok(c.patient_id, 'the new case says which patient it made');
  const jpg = jpegWithExif();
  const up = await api('POST', `/patrol/incidents/${c.id}/photos?caption=Left%20wrist&patient_id=${c.patient_id}&client_ref=abc12345&lat=40&lng=-70&taken_at=${today}T09:00`, { token: T.pat, raw: jpg, type: 'image/jpeg' });
  is(up, 201);
  assert.equal(up.body.sha256, crypto.createHash('sha256').update(jpg).digest('hex'));
  assert.equal(up.body.from_photo, true);
  const again = await api('POST', `/patrol/incidents/${c.id}/photos?client_ref=abc12345`, { token: T.pat, raw: jpg });
  is(again, 200, 'the same upload twice is kept once'); assert.equal(again.body.id, up.body.id);
  is(await api('POST', `/patrol/incidents/${c.id}/photos`, { token: T.pat, raw: Buffer.from('this is a text file, not a picture') }), 400);
  // A PNG has no EXIF: the phone's own time and place are used.
  const png = ok(await api('POST', `/patrol/incidents/${c.id}/photos?lat=44.1&lng=-72.2&taken_at=${today}T11:30`, { token: T.pat, raw: PNG }));
  assert.equal(png.from_photo, false);

  const list = ok(await api('GET', `/patrol/incidents/${c.id}/photos`, { token: T.pat })).data;
  const p1 = list.find((x) => x.id === up.body.id); const p2 = list.find((x) => x.id === png.id);
  assert.equal(String(p1.taken_at).slice(0, 19).replace('T', ' '), '2026-01-17 10:42:05', 'the photo\'s own time wins');
  assert.equal(p1.taken_lat, 44.504167); assert.equal(p1.caption, 'Left wrist'); assert.equal(p1.patient_id, c.patient_id);
  assert.equal(p2.taken_lat, 44.1); assert.equal(String(p2.taken_at).slice(11, 16), '11:30');
  const orig = await api('GET', `/patrol/incidents/${c.id}/photos/${up.body.id}/original`, { token: T.pat });
  is(orig, 200); assert.ok(orig.bytes.equals(jpg), 'the original comes back byte for byte');
  assert.equal(orig.headers.get('x-content-sha256'), up.body.sha256);
  assert.equal(ok(await api('GET', `/patrol/incidents/${c.id}/photos/${up.body.id}/verify`, { token: T.pat })).unchanged, true);
  // Preview: a JPEG, set once.
  is(await api('GET', `/patrol/incidents/${c.id}/photos/${up.body.id}/preview`, { token: T.pat }), 404);
  is(await api('PUT', `/patrol/incidents/${c.id}/photos/${up.body.id}/preview`, { token: T.pat, raw: PNG }), 400);
  const small = jpegWithExif({ when: '2026:01:01 00:00:00' });
  ok(await api('PUT', `/patrol/incidents/${c.id}/photos/${up.body.id}/preview`, { token: T.pat, raw: small }));
  assert.ok((await api('GET', `/patrol/incidents/${c.id}/photos/${up.body.id}/preview`, { token: T.pat })).bytes.equals(small));
  // Tampering in the database shows up.
  await pool.query('UPDATE incident_media SET original = ? WHERE id = ?', [Buffer.concat([jpg, Buffer.from([0])]), up.body.id]);
  assert.equal(ok(await api('GET', `/patrol/incidents/${c.id}/photos/${up.body.id}/verify`, { token: T.pat })).unchanged, false);
  await pool.query('UPDATE incident_media SET original = ? WHERE id = ?', [jpg, up.body.id]);
  // The case carries its photos (no bytes), so a frozen version names each file's fingerprint.
  const full = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat }));
  assert.equal(full.photos.length, 2); assert.equal(full.photos[0].sha256, up.body.sha256); assert.equal(full.photos[0].original, undefined);
  // Entered in error, never deleted.
  is(await api('POST', `/patrol/incidents/${c.id}/photos/${png.id}/void`, { token: T.pat, body: { reason: 'no' } }), 400);
  ok(await api('POST', `/patrol/incidents/${c.id}/photos/${png.id}/void`, { token: T.pat, body: { reason: 'Wrong patient' } }));
  const after = ok(await api('GET', `/patrol/incidents/${c.id}/photos`, { token: T.pat })).data.find((x) => x.id === png.id);
  assert.ok(after.voided_at); assert.equal(after.void_reason, 'Wrong patient');
  // Another mountain sees nothing.
  const other = `fk2-${suffix}`;
  await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug: other, name: 'Other', owner: { email: `o@${other}.test`, password: PW, first_name: 'O', last_name: 'O' } }) });
  const ot = (await api('POST', '/auth/login', { body: { tenant: other, email: `o@${other}.test`, password: PW } })).body.token;
  is(await api('GET', `/patrol/incidents/${c.id}/photos/${up.body.id}/original`, { token: ot }), 404);
  // Once approved, the report is locked: no new photos.
  await pool.query("UPDATE incidents SET report_state = 'approved' WHERE id = ?", [c.id]);
  is(await api('POST', `/patrol/incidents/${c.id}/photos`, { token: T.pat, raw: jpg }), 409);
  const [[logged]] = await pool.query("SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ? AND action = 'view_photo'", [T.id]);
  assert.ok(Number(logged.n) >= 1, 'opening an original is logged');
});

test('a case started with no signal is made once, and says which patient it made so waiting entries can follow it', async () => {
  const body = { occurred_at: `${today}T12:00`, location: 'Lift 2', category: 'medical', severity: 'minor', summary: 'Dizzy', patient: { first_name: 'Unknown', last_name: 'Patient' }, client_ref: `off${suffix}` };
  const a = ok(await api('POST', '/patrol/incidents', { token: T.pat, body }));
  const b = ok(await api('POST', '/patrol/incidents', { token: T.pat, body }));
  assert.equal(a.id, b.id); assert.equal(b.repeat, true);
  assert.ok(a.patient_id); assert.equal(b.patient_id, a.patient_id);
  // A vitals set sent later to the real ids lands on that patient.
  ok(await api('POST', `/patrol/incidents/${a.id}/patients/${a.patient_id}/vitals`, { token: T.pat, body: { pulse: 88, taken_at: `${today}T12:05`, client_ref: `v${suffix}` } }));
  const c = ok(await api('GET', `/patrol/incidents/${a.id}`, { token: T.pat }));
  assert.equal(c.patients[0].vitals.length, 1);
});

test('dispatch can text a caller a link; their phone\'s position lands on the call, and the link dies with the call', async () => {
  const call = ok(await api('POST', '/patrol/dispatch', { token: T.owner, body: { location: 'Somewhere in the trees', priority: 'high', source: 'phone', caller_phone: '802-555-0142' } }));
  const out = ok(await api('POST', `/patrol/dispatch/${call.id}/locate`, { token: T.owner, body: {} }));
  assert.equal(out.texted, false, 'text messages are not set up in tests'); assert.match(out.link, /\/locate\/[0-9a-f]{32}$/);
  const token = out.link.split('/').pop();
  const board = ok(await api('GET', `/patrol/dispatch/${call.id}`, { token: T.owner }));
  assert.equal(board.locate_token, undefined, 'the token is never on the board'); assert.ok(board.locate_sent_at);
  assert.ok(!JSON.stringify(ok(await api('GET', '/patrol/dispatch', { token: T.owner }))).includes(token));
  const page = ok(await api('GET', `/public/locate/${token}`));
  assert.deepEqual(page, { mountain: 'Field Kit Peak', located: false }, 'the guest sees only the mountain');
  is(await api('POST', `/public/locate/${token}`, { body: { lat: 200, lng: 0 } }), 400);
  ok(await api('POST', `/public/locate/${token}`, { body: { lat: 44.5012, lng: -72.7801, accuracy: 12.4 } }));
  const after = ok(await api('GET', `/patrol/dispatch/${call.id}`, { token: T.owner }));
  assert.equal(Number(after.gps_lat), 44.5012); assert.equal(after.located_accuracy_m, 12); assert.ok(after.located_at);
  assert.ok(after.events.some((e) => /Caller shared their location \(within about 12 m\)/.test(e.note || '')));
  is(await api('GET', `/public/locate/${'0'.repeat(32)}`), 404);
  is(await api('GET', '/public/locate/not-a-token'), 404);
  // Too old, or the call closed: the link is dead.
  await pool.query('UPDATE dispatch_calls SET locate_sent_at = locate_sent_at - INTERVAL 3 HOUR WHERE id = ?', [call.id]);
  is(await api('GET', `/public/locate/${token}`), 404);
  await pool.query('UPDATE dispatch_calls SET locate_sent_at = locate_sent_at + INTERVAL 3 HOUR WHERE id = ?', [call.id]);
  ok(await api('POST', `/patrol/dispatch/${call.id}/events`, { token: T.owner, body: { kind: 'closed' } }));
  is(await api('POST', `/public/locate/${token}`, { body: { lat: 44, lng: -72 } }), 404);
  is(await api('POST', `/patrol/dispatch/${call.id}/locate`, { token: T.owner, body: {} }), 409);
  const noPhone = ok(await api('POST', '/patrol/dispatch', { token: T.owner, body: { location: 'Base', source: 'radio' } }));
  is(await api('POST', `/patrol/dispatch/${noPhone.id}/locate`, { token: T.owner, body: {} }), 400, 'needs a number');
});

test('the guest help page can send the phone\'s position with the request', async () => {
  await pool.query('UPDATE tenants SET guest_help_enabled = 1 WHERE id = ?', [T.id]);
  ok(await api('POST', `/public/${slug}/help`, { body: { location: 'Ridge Run', description: 'Friend hurt knee', gps_lat: 44.49, gps_lng: -72.79 } }));
  const [[c]] = await pool.query("SELECT gps_lat, gps_lng FROM dispatch_calls WHERE tenant_id = ? AND source = 'guest' ORDER BY id DESC LIMIT 1", [T.id]);
  assert.equal(Number(c.gps_lat), 44.49);
});

test('check rules: a reading outside its range or a date inside its warning fails by itself, with the reason', () => {
  const steps = [{ key: 'psi', label: 'Pressure', type: 'number', unit: 'psi', min: 500, max: 2200 }, { key: 'pads', label: 'Pads', type: 'date', within_days: 30 }, { key: 'look', label: 'Looks OK', type: 'pass' }];
  const good = CR.evaluateAll(steps, [{ key: 'psi', value: 1800 }, { key: 'pads', value: addDays(today, 90) }, { key: 'look', result: 'pass' }], today);
  assert.deepEqual(good.map((i) => i.result), ['pass', 'pass', 'pass']);
  const bad = CR.evaluateAll(steps, [{ key: 'psi', value: 400 }, { key: 'pads', value: addDays(today, 10) }, { key: 'look', result: 'na' }], today);
  assert.deepEqual(bad.map((i) => i.result), ['fail', 'fail', 'na']);
  assert.match(bad[0].note, /400 psi is below the lowest allowed, 500 psi/);
  assert.match(bad[1].note, /within 30 days/);
  assert.match(CR.evaluateAll(steps, [{ key: 'psi', value: 2500 }, { key: 'pads', value: addDays(today, -1) }, { key: 'look', result: 'pass' }], today)[1].note, /Expired/);
  assert.throws(() => CR.evaluateAll(steps, [{ key: 'psi', value: '' }, { key: 'pads', value: today }, { key: 'look', result: 'pass' }], today), /Pressure: enter the reading/);
  assert.throws(() => CR.evaluateAll(steps, [{ key: 'psi', value: 900 }], today), /Answer every item/);
  assert.equal(CR.ruleText(steps[0]), 'Reading, 500 psi to 2200 psi');
});

test('the mountain\'s own checklists take readings and dates; one outside its rule fails the inspection and opens a work order', async () => {
  const tpl = ok(await api('POST', '/assets/templates', { token: T.owner, body: { name: `Extinguisher ${suffix}`, items: [
    { key: 'gauge', label: 'Gauge pressure', type: 'number', unit: 'psi', min: 100, max: 175 },
    { key: 'tag', label: 'Service tag date', type: 'date', within_days: 30 },
    { key: 'pin', label: 'Pin and seal in place', type: 'pass' }] } }));
  is(await api('POST', '/assets/templates', { token: T.owner, body: { name: `Bad ${suffix}`, items: [{ key: 'x', label: 'X', type: 'number', min: 10, max: 5 }] } }), 400);
  const asset = ok(await api('POST', '/assets/register', { token: T.owner, body: { name: `Extinguisher lodge ${suffix}`, kind: 'other' } }));
  const pass = ok(await api('POST', `/assets/register/${asset.id}/inspections`, { token: T.owner, body: { template_id: tpl.id, items: [{ key: 'gauge', value: 150 }, { key: 'tag', value: addDays(today, 200) }, { key: 'pin', result: 'pass' }] } }));
  assert.equal(pass.result, 'pass');
  const fail = ok(await api('POST', `/assets/register/${asset.id}/inspections`, { token: T.owner, body: { template_id: tpl.id, items: [{ key: 'gauge', value: 80 }, { key: 'tag', value: addDays(today, 200) }, { key: 'pin', result: 'pass' }] } }));
  assert.equal(fail.result, 'fail'); assert.ok(fail.work_order_id, 'a failed reading opens a work order');
  const page = ok(await api('GET', `/assets/register/${asset.id}`, { token: T.owner }));
  const latest = page.inspections[0];
  assert.equal(latest.items[0].value, 80); assert.match(latest.items[0].note, /below the lowest allowed/);
  is(await api('POST', `/assets/register/${asset.id}/inspections`, { token: T.owner, body: { template_id: tpl.id, items: [{ key: 'gauge', value: 150 }, { key: 'tag', value: 'soon' }, { key: 'pin', result: 'pass' }] } }), 400);
});

test('patrol gear checks use steps per kind: low oxygen and close pad dates flag the item and update it', async () => {
  const steps = ok(await api('GET', '/patrol/gear-checklists', { token: T.pat })).data;
  assert.equal(steps.oxygen.own, false);
  assert.equal(steps.oxygen.steps.find((s) => s.key === 'pressure').min, 500, 'the refill level from Patrol settings');
  const o2 = ok(await api('POST', '/patrol/equipment', { token: T.owner, body: { name: `O2 #1 ${suffix}`, kind: 'oxygen' } }));
  const low = ok(await api('POST', `/patrol/equipment/${o2.id}/checks`, { token: T.pat, body: { result: 'ok', items: [{ key: 'pressure', value: 300 }, { key: 'regulator_ok', result: 'pass' }] } }));
  assert.equal(low.status, 'needs_attention'); assert.match(low.failed[0].note, /300 psi is below/);
  const list = ok(await api('GET', '/patrol/equipment', { token: T.pat })).data;
  const cyl = list.find((e) => e.id === o2.id);
  assert.equal(cyl.o2_psi, 300); assert.equal(cyl.last_reading, '300 psi');
  const aed = ok(await api('POST', '/patrol/equipment', { token: T.owner, body: { name: `AED lodge ${suffix}`, kind: 'aed' } }));
  const soon = addDays(today, 12);
  const r = ok(await api('POST', `/patrol/equipment/${aed.id}/checks`, { token: T.pat, body: { result: 'ok', items: [{ key: 'status_ok', result: 'pass' }, { key: 'pads_expiry', value: soon }, { key: 'battery_expiry', value: addDays(today, 400) }, { key: 'kit_ok', result: 'pass' }] } }));
  assert.equal(r.status, 'needs_attention');
  const a = ok(await api('GET', '/patrol/equipment', { token: T.pat })).data.find((e) => e.id === aed.id);
  assert.equal(String(a.pads_expire_on).slice(0, 10), soon);
  const hist = ok(await api('GET', `/patrol/equipment/${aed.id}/checks`, { token: T.pat })).data;
  assert.equal(JSON.parse(hist[0].items).find((i) => i.key === 'pads_expiry').result, 'fail');
  // A patrol sets its own steps; only those who manage equipment can.
  is(await api('PUT', '/patrol/gear-checklists/radio', { token: T.pat, body: { items: [{ key: 'volts', label: 'Battery volts', type: 'number', min: 7 }] } }), 403);
  ok(await api('PUT', '/patrol/gear-checklists/radio', { token: T.owner, body: { items: [{ key: 'volts', label: 'Battery volts', type: 'number', unit: 'V', min: 7 }] } }));
  const mine = ok(await api('GET', '/patrol/gear-checklists', { token: T.pat })).data.radio;
  assert.equal(mine.own, true); assert.equal(mine.steps[0].rule, 'Reading, at least 7 V');
  is(await api('PUT', '/patrol/gear-checklists/spaceship', { token: T.owner, body: { items: [] } }), 404);
  // The old way (no steps) still works.
  const tob = ok(await api('POST', '/patrol/equipment', { token: T.owner, body: { name: `Toboggan ${suffix}`, kind: 'toboggan' } }));
  assert.equal(ok(await api('POST', `/patrol/equipment/${tob.id}/checks`, { token: T.pat, body: { result: 'ok' } })).status, 'in_service');
});
