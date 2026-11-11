'use strict';

// Resident requests with a repair record (muni release 1, workstream "requests"). Everything through the real routes:
// the public report page and its status page, triage into a work order, completing it, made safe, referred, duplicate,
// the response standards, the ledger and its Right-to-Know exports, the public map, texts only to residents who said yes
// (and never after STOP), module gating and tenant isolation, and the residents lib.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '100000';
process.env.PLATFORM_RATE_LIMIT = '100000';
process.env.PUBLIC_RATE_LIMIT = '100000';
process.env.PUBLIC_RATE_LIMIT_ALL = '100000';
process.env.REPORT_RATE_LIMIT = '60';
// Email is turned on once everyone has signed in (with email on, a sign-in from a new device asks for an emailed code).
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'tw-token';
process.env.TWILIO_FROM = '+16105550000';
process.env.TWILIO_WEBHOOK_URL = 'https://app.verdynt.test/api/v1/twilio/sms';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const mailer = require('../src/lib/mailer');
const push = require('../src/lib/push');
const MOD = require('../src/lib/modules');
const Q = require('../src/lib/requests');
const RES = require('../src/lib/residents');
const { photoFacts } = require('../src/lib/exif');
const { signature } = require('../src/routes/twilioinbound');
const { createMuniTenant } = require('./helpers/muni');

const KEY = 'test-bootstrap-key';
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
let server; let base; let tw; let pm;
const texts = []; const mails = []; const pushes = [];
let A; let B; let ski; // two municipalities and a ski area
const T = {}; // A's logins: owner token in A.token, plus manager, desk, crew

async function api(method, p, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, headers: res.headers, buf };
}
const bytes = async (method, p, buf, { token } = {}) => api(method, p, { token, headers: { 'content-type': 'application/octet-stream' }, body: undefined, raw: buf }).catch(() => null);
async function upload(p, buf, { token } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: buf });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
void bytes;
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${typeof r.body === 'string' ? r.body.slice(0, 300) : JSON.stringify(r.body).slice(0, 400)}`);
const platform = (method, p, body) => api(method, `/platform${p}`, { headers: { 'x-platform-key': KEY }, body });
const q = async (sql, params) => (await pool.query(sql, params))[0];
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
async function waitFor(fn, ms = 3000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(25); } }
/** Runs fn with email off, so a new login's sign-in does not ask for an emailed code. */
async function quietly(fn) { const k = process.env.POSTMARK_SERVER_TOKEN; delete process.env.POSTMARK_SERVER_TOKEN; try { return await fn(); } finally { if (k) process.env.POSTMARK_SERVER_TOKEN = k; } }
const textsTo = (digits) => texts.filter((t) => String(t.To).replace(/\D/g, '').endsWith(digits));
const phone = () => `610${String(crypto.randomInt(2000000, 9999999))}`;

/** A small JPEG with an EXIF block: DateTimeOriginal and a GPS position (as test/fieldkit.test.js makes it). */
function jpegWithGps({ when = '2026:01:17 10:42:05', lat = [40, 7, 48], lng = [75, 30, 54] } = {}) {
  const tiff = Buffer.alloc(400);
  tiff.write('II', 0, 'latin1'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  let o = 8; tiff.writeUInt16LE(2, o); o += 2;
  const exifAt = 38;
  tiff.writeUInt16LE(0x8769, o); tiff.writeUInt16LE(4, o + 2); tiff.writeUInt32LE(1, o + 4); tiff.writeUInt32LE(exifAt, o + 8); o += 12;
  const gpsAt = exifAt + 2 + 12 + 4 + 20;
  tiff.writeUInt16LE(0x8825, o); tiff.writeUInt16LE(4, o + 2); tiff.writeUInt32LE(1, o + 4); tiff.writeUInt32LE(gpsAt, o + 8); o += 12;
  tiff.writeUInt32LE(0, o);
  o = exifAt; tiff.writeUInt16LE(1, o); o += 2;
  const dateAt = exifAt + 2 + 12 + 4;
  tiff.writeUInt16LE(0x9003, o); tiff.writeUInt16LE(2, o + 2); tiff.writeUInt32LE(20, o + 4); tiff.writeUInt32LE(dateAt, o + 8); o += 12;
  tiff.writeUInt32LE(0, o);
  tiff.write(`${when}\0`, dateAt, 'latin1');
  o = gpsAt; tiff.writeUInt16LE(4, o); o += 2;
  const ratAt = gpsAt + 2 + 4 * 12 + 4;
  const ent = (tag, type, count, valueOrOffset, inline) => { tiff.writeUInt16LE(tag, o); tiff.writeUInt16LE(type, o + 2); tiff.writeUInt32LE(count, o + 4); if (inline) tiff.write(inline, o + 8, 'latin1'); else tiff.writeUInt32LE(valueOrOffset, o + 8); o += 12; };
  ent(1, 2, 2, 0, 'N\0'); ent(2, 5, 3, ratAt); ent(3, 2, 2, 0, 'W\0'); ent(4, 5, 3, ratAt + 24);
  tiff.writeUInt32LE(0, o);
  [...lat, ...lng].forEach((v, i) => { tiff.writeUInt32LE(v, ratAt + i * 8); tiff.writeUInt32LE(1, ratAt + i * 8 + 4); });
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff.subarray(0, ratAt + 48)]);
  const app1 = Buffer.alloc(4); app1.writeUInt16BE(0xffe1, 0); app1.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, body, Buffer.from([0xff, 0xda, 0x00, 0x02]), crypto.randomBytes(256), Buffer.from([0xff, 0xd9])]);
}

/** Streets through the foundation's street list API, then their class through Requests settings. */
async function addStreets(M, names) {
  const out = {};
  for (const [name] of names) {
    const r = await api('POST', '/requests/streets', { token: M.token, body: { name } });
    is(r, 201, name);
    out[name] = r.body.id;
  }
  const classed = names.filter(([, cls]) => cls).map(([name, cls]) => ({ id: out[name], street_class: cls }));
  if (classed.length) is(await api('PUT', '/requests/street-classes', { token: M.token, body: { streets: classed } }), 200);
  return out;
}
/** A resident's report through the public page. */
const report = (M, body, headers) => api('POST', `/public/${M.slug}/report`, { body, headers });
const catId = (M, name) => M.cats.find((c) => c.name === name).id;

/** Posts a text to the inbound webhook, signed as Twilio would sign it. */
async function textIn(from, words) {
  const params = { AccountSid: 'ACtest', MessageSid: `SM${crypto.randomBytes(8).toString('hex')}`, From: `+1${from}`, To: '+16105550000', Body: words };
  const res = await fetch(`${base}/api/v1/twilio/sms`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature('tw-token', process.env.TWILIO_WEBHOOK_URL, params) }, body: new URLSearchParams(params).toString() });
  return res.status;
}

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const listen = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });
  let n = 0;
  tw = await listen((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { texts.push({ url: req.url, ...Object.fromEntries(new URLSearchParams(d)) }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ sid: `SM${++n}` })); }); });
  pm = await listen((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { mails.push(JSON.parse(d)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m-${++n}` })); }); });
  process.env.TWILIO_API_BASE = `http://127.0.0.1:${tw.address().port}`;
  mailer.settings.apiBase = `http://127.0.0.1:${pm.address().port}`;
  push.notifyUsers = async (tenantId, userIds, message) => { pushes.push({ tenantId, userIds, message }); return userIds.length; };

  A = await createMuniTenant(base, { slug: `rq-a-${suffix}`, name: `Riverbend Borough ${suffix}` });
  B = await createMuniTenant(base, { slug: `rq-b-${suffix}`, name: `Elm Township ${suffix}` });
  T.manager = await A.addLogin('manager');
  T.desk = await A.addLogin('counter');
  T.crew = await A.addLogin('staff');
  A.streets = await addStreets(A, [['Main Street', 'arterial'], ['Bridge Street', 'collector'], ['Church Street', 'local']]);
  B.streets = await addStreets(B, [['Elm Avenue', 'local']]);
  for (const M of [A, B]) M.cats = (await api('GET', `/public/${M.slug}/report`)).body.categories;
  const made = await platform('POST', '/tenants', { slug: `rq-ski-${suffix}`, name: `Pine Ridge ${suffix}`, billing: 'comped', owner: { email: `gm@rq-ski-${suffix}.test`, password: A.password, first_name: 'Gale', last_name: 'Ridge' } });
  is(made, 201);
  ski = { id: made.body.id, slug: `rq-ski-${suffix}` };
  ski.token = (await api('POST', '/auth/login', { body: { tenant: ski.slug, login: `gm@${ski.slug}.test`, password: A.password } })).body.token;
  process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
  process.env.MAIL_FROM = 'hello@verdynt.test';
});
test.after(async () => { await new Promise((r) => server.close(r)); tw.close(); pm.close(); await pool.end(); });

// ---------------------------------------------------------------- the migration and the residents lib
test('the migration step is complete and safe to run again: every check says done', async () => {
  const steps = require('../db/steps/muni-requests')({
    tableExists: async (c, t) => (await c.query('SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [t]))[0].length > 0,
    columnExists: async (c, t, col) => (await c.query('SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [t, col]))[0].length > 0,
  });
  for (const [name, done] of steps) assert.ok(await done(pool), `${name} would run again`);
  const [[src]] = await pool.query("SELECT COLUMN_TYPE AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'work_orders' AND column_name = 'source'");
  assert.equal(src.t, "enum('manual','inspection','preventive','request','program','notice')");
  for (const t of ['residents', 'resident_consent', 'request_categories', 'request_standards', 'request_settings', 'requests', 'request_photos', 'request_events', 'request_messages']) {
    const [u] = await pool.query("SELECT COUNT(*) AS n FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND non_unique = 0 AND column_name IN ('tenant_id','id') GROUP BY index_name HAVING n = 2", [t]);
    assert.ok(u.length, `${t} has a composite unique (tenant_id, id)`);
  }
});

test('residents lib: upsertResident matches by phone key, then by email; consent is a ledger', async () => {
  const conn = pool;
  const id = await RES.upsertResident(conn, B.id, { name: 'Dana Reyes', phone: '(610) 555-0142', email: 'Dana@Example.test', textsOk: true });
  assert.ok(id);
  assert.equal(await RES.upsertResident(conn, B.id, { phone: '+1 610.555.0142' }), id, 'the same phone written another way');
  assert.equal(await RES.upsertResident(conn, B.id, { email: 'dana@example.test', name: 'Dana R.' }), id, 'by email when no phone is given');
  const other = await RES.upsertResident(conn, B.id, { phone: '610-555-0199', email: 'dana@example.test' });
  assert.equal(other, id, 'a new phone with a known email finds the same resident');
  const [[row]] = await pool.query('SELECT name, phone, email, texts_ok, emails_ok FROM residents WHERE id = ?', [id]);
  assert.equal(row.name, 'Dana R.'); assert.equal(row.phone, '(610) 555-0142', 'the number the yes was given for is kept'); assert.equal(row.email, 'dana@example.test');
  assert.equal(Number(row.texts_ok), 1); assert.equal(Number(row.emails_ok), 0);
  assert.equal(await RES.upsertResident(conn, A.id, { phone: '6105550142' }) === id, false, 'another municipality never matches');
  // Not ticking "text me" leaves the yes alone; an explicit no is recorded.
  await RES.upsertResident(conn, B.id, { phone: '6105550142' });
  assert.equal(Number((await q('SELECT texts_ok FROM residents WHERE id = ?', [id]))[0].texts_ok), 1);
  await RES.upsertResident(conn, B.id, { phone: '6105550142', textsOk: false, emailsOk: true });
  const hist = await RES.consentHistory(conn, B.id, id);
  assert.deepEqual(hist.map((h) => `${h.channel}:${h.status}`), ['email:opted_in', 'sms:opted_out', 'sms:opted_in']);
  assert.equal(await RES.upsertResident(conn, B.id, {}), null, 'nothing to identify anyone');
});

// ---------------------------------------------------------------- the public report page
test('the report page: what it needs, small and standalone, Call 911 on every screen', async () => {
  const page = await api('GET', `/public/${A.slug}/report`);
  is(page, 200);
  assert.equal(page.body.municipality, A.name);
  assert.deepEqual(page.body.categories.map((c) => c.name), Q.DEFAULT_CATEGORIES.map((c) => c[0]));
  assert.ok(page.body.categories.find((c) => c.name === 'Sewer backup').after_hours);
  assert.ok(page.body.categories.find((c) => c.name === 'Water leak or low pressure').after_hours);
  assert.deepEqual(page.body.streets.map((s) => s.name), ['Bridge Street', 'Church Street', 'Main Street']);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'report.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'report.js'), 'utf8');
  assert.doesNotMatch(html, /app\.css/);
  assert.deepEqual([...js.matchAll(/^import .* from\s+'([^']+)'/gm)].map((m) => m[1]), [], 'report.js loads nothing else');
  assert.ok(Buffer.byteLength(html) + Buffer.byteLength(js) < 48 * 1024, 'under 50 KB with room to spare');
  assert.match(html, /<header class="bar"[^]*For an emergency, call 911\.[^]*href="tel:911"/, 'the 911 bar sits outside the screens, so it is on every one');
  assert.match(js, /For an emergency, call 911/);
  assert.doesNotMatch(js, /within \d+ (hours|days)|we will fix|guarantee/i, 'never promises a response time');
  const served = await fetch(`${base}/report/${A.slug}`);
  is({ status: served.status, body: '' }, 200);
  assert.match(await served.text(), /Call 911/);
});

test('a report without contact details: a reference, a status link, and nobody\'s details on the status page', async () => {
  pushes.length = 0;
  const r = await report(A, { category_id: catId(A, 'Pothole'), street_id: A.streets['Main Street'], house_number: '120', description: 'Deep pothole by the curb' });
  is(r, 201);
  assert.match(r.body.reference, /^R-\d{4,}$/);
  assert.match(r.body.token, /^[0-9a-f]{32}$/);
  const [row] = await q('SELECT * FROM requests WHERE tenant_id = ? AND reference = ?', [A.id, r.body.reference]);
  assert.equal(row.source, 'web'); assert.equal(row.status, 'new'); assert.equal(row.resident_id, null);
  assert.ok(row.reported_at, 'when the municipality was told');
  const s = await api('GET', `/public/${A.slug}/report/${r.body.token}`);
  is(s, 200);
  assert.equal(s.body.status_words, 'Received');
  assert.equal(s.body.reference, r.body.reference);
  assert.equal(s.body.place, 'Main Street', 'no house number on the status page');
  const audit = await q("SELECT action FROM audit_log WHERE tenant_id = ? AND entity = 'requests' AND entity_id = ?", [A.id, row.id]);
  assert.deepEqual(audit.map((a) => a.action), ['create'], 'the report is in the audit log');
  // Another municipality's address with the same token finds nothing.
  is(await api('GET', `/public/${B.slug}/report/${r.body.token}`), 404);
  is(await api('GET', `/public/${A.slug}/report/${'0'.repeat(32)}`), 404);
});

test('a report with contact details: the resident is kept apart, texted only because they asked, with STOP', async () => {
  const ph = phone();
  const r = await report(A, { category_id: catId(A, 'Street light out'), street_id: A.streets['Church Street'], house_number: '14', name: 'Jordan Pike', phone: ph, email: 'jordan@example.test', texts_ok: true, emails_ok: false });
  is(r, 201);
  const sent = await waitFor(() => textsTo(ph).length);
  assert.ok(sent, 'the received text went');
  const body = textsTo(ph)[0].Body;
  assert.match(body, new RegExp(`^${A.name}: we got your report ${r.body.reference} \\(Street light out\\)\\.`));
  assert.match(body, /Reply STOP to stop texts\.$/);
  assert.match(body, new RegExp(`/report/${A.slug}#s=${r.body.token}`));
  // The municipality's test name and its link carry a random suffix (which can spell "days"), so they are taken out first.
  assert.doesNotMatch(body.split(A.name).join('').replace(/https?:\/\/\S+/g, ''), /within|hours|days/, 'no promised time');
  await sleep(100);
  assert.equal(mails.filter((m) => m.To === 'jordan@example.test').length, 0, 'no email: they did not ask');
  const [row] = await q('SELECT r.updates_by_text, r.updates_by_email, x.name, x.texts_ok FROM requests r JOIN residents x ON x.tenant_id = r.tenant_id AND x.id = r.resident_id WHERE r.tenant_id = ? AND r.reference = ?', [A.id, r.body.reference]);
  assert.equal(row.name, 'Jordan Pike'); assert.equal(Number(row.updates_by_text), 1); assert.equal(Number(row.updates_by_email), 0); assert.equal(Number(row.texts_ok), 1);
  const s = await api('GET', `/public/${A.slug}/report/${r.body.token}`);
  const words = JSON.stringify(s.body);
  for (const secret of ['Jordan', 'Pike', ph, 'jordan@example.test', '"14']) assert.ok(!words.includes(secret), `the status page holds no ${secret}`);
  const msg = await q('SELECT kind, channel, ok FROM request_messages WHERE tenant_id = ?', [A.id]);
  assert.ok(msg.some((m) => m.kind === 'received' && m.channel === 'sms' && Number(m.ok) === 1));
  // Texts need a number; a sewer backup needs a way to reach the resident.
  is(await report(A, { category_id: catId(A, 'Pothole'), street_id: A.streets['Main Street'], texts_ok: true }), 400);
  const sewer = await report(A, { category_id: catId(A, 'Sewer backup'), street_id: A.streets['Main Street'] });
  is(sewer, 400); assert.match(sewer.body.error, /phone number or email/);
  is(await report(A, { category_id: catId(A, 'Pothole') }), 400, 'somewhere is needed');
  is(await report(A, { category_id: catId(B, 'Pothole'), street_id: A.streets['Main Street'] }), 404, 'another municipality\'s category');
  is(await report(A, { category_id: catId(A, 'Pothole'), street_id: B.streets['Elm Avenue'] }), 404, 'another municipality\'s street');
});

test('the phone\'s location, a retry of the same send, and the hidden field', async () => {
  const rid = crypto.randomBytes(16).toString('hex');
  const first = await report(A, { category_id: catId(A, 'Tree or branch down'), lat: 40.1301, lng: -75.5149, accuracy: 12, rid });
  is(first, 201);
  const again = await report(A, { category_id: catId(A, 'Tree or branch down'), lat: 40.1301, lng: -75.5149, accuracy: 9, rid });
  is(again, 200); assert.equal(again.body.reference, first.body.reference); assert.equal(again.body.joined, true);
  const before = (await q('SELECT COUNT(*) AS n FROM requests WHERE tenant_id = ?', [A.id]))[0].n;
  const bot = await report(A, { category_id: catId(A, 'Pothole'), street_id: A.streets['Main Street'], website: 'http://spam.example' });
  is(bot, 202);
  assert.equal((await q('SELECT COUNT(*) AS n FROM requests WHERE tenant_id = ?', [A.id]))[0].n, before, 'a bot creates nothing');
});

test('photos with a report: kept as taken with a fingerprint, shown publicly without where they were taken, up to 3', async () => {
  const r = await report(A, { category_id: catId(A, 'Sidewalk or curb'), street_id: A.streets['Bridge Street'], house_number: '7' });
  const jpg = jpegWithGps();
  assert.ok(photoFacts(jpg).lat > 40, 'the test photo carries a position');
  const up = await upload(`/public/${A.slug}/report/${r.body.token}/photos?client_ref=abc123`, jpg);
  is(up, 201);
  is(await upload(`/public/${A.slug}/report/${r.body.token}/photos?client_ref=abc123`, jpg), 200, 'the same upload again is kept once');
  const [ph] = await q('SELECT id, sha256, taken_lat, by_resident, stage FROM request_photos WHERE tenant_id = ? AND id = ?', [A.id, up.body.id]);
  assert.equal(ph.sha256, crypto.createHash('sha256').update(jpg).digest('hex'));
  assert.ok(Number(ph.taken_lat) > 40); assert.equal(Number(ph.by_resident), 1); assert.equal(ph.stage, 'report');
  const shown = await fetch(`${base}/api/v1/public/${A.slug}/report/${r.body.token}/photos/${ph.id}`);
  assert.equal(shown.status, 200);
  const pub = Buffer.from(await shown.arrayBuffer());
  assert.deepEqual(photoFacts(pub), { taken_at: '2026-01-17 10:42:05', lat: null, lng: null }, 'the position is gone, the rest stays');
  // Staff get the original, byte for byte, with its fingerprint.
  const reqId = (await q('SELECT id FROM requests WHERE tenant_id = ? AND reference = ?', [A.id, r.body.reference]))[0].id;
  const orig = await fetch(`${base}/api/v1/requests/${reqId}/photos/${ph.id}`, { headers: { authorization: `Bearer ${T.crew.token}` } });
  assert.equal(orig.headers.get('x-content-sha256'), ph.sha256);
  assert.ok(Buffer.from(await orig.arrayBuffer()).equals(jpg));
  const v = await api('GET', `/requests/${reqId}/photos/${ph.id}/verify`, { token: T.crew.token });
  assert.equal(v.body.unchanged, true);
  is(await upload(`/public/${A.slug}/report/${r.body.token}/photos`, jpegWithGps()), 201);
  is(await upload(`/public/${A.slug}/report/${r.body.token}/photos`, jpegWithGps()), 201);
  const fourth = await upload(`/public/${A.slug}/report/${r.body.token}/photos`, jpegWithGps());
  is(fourth, 409); assert.match(fourth.body.error, /Up to 3 photos/);
  is(await upload(`/public/${A.slug}/report/${r.body.token}/photos`, Buffer.from('not a photo at all, just text')), 400);
  const s = await api('GET', `/public/${A.slug}/report/${r.body.token}`);
  assert.equal(s.body.photos.length, 3); assert.equal(s.body.can_add_photos, false);
  is(await api('GET', `/public/${B.slug}/report/${r.body.token}/photos/${ph.id}`), 404, 'another municipality');
});

test('rate limit: reports from one address to one municipality stop after the limit; another municipality is not affected', async () => {
  const C = await quietly(() => createMuniTenant(base, { slug: `rq-c-${suffix}` }));
  const streets = await addStreets(C, [['Oak Lane']]);
  const cat = (await api('GET', `/public/${C.slug}/report`)).body.categories[0].id;
  let last;
  for (let i = 0; i < 61; i += 1) last = await report(C, { category_id: cat, street_id: streets['Oak Lane'] });
  is(last, 429);
  assert.match(last.body.error, /Too many reports/);
  is(await report(A, { category_id: catId(A, 'Other'), street_id: A.streets['Main Street'] }), 201, 'another municipality still takes reports');
});

// ---------------------------------------------------------------- staff, triage and the repair record
async function staffRequest(token, body) {
  const r = await api('POST', '/requests', { token, body: { category_id: catId(A, 'Pothole'), street_id: A.streets['Main Street'], source: 'phone', ...body } });
  is(r, 201);
  return r.body.id;
}

test('staff take requests by phone, at the counter and from the field; the manager alone can say they were told earlier', async () => {
  const ph = phone();
  const id = await staffRequest(T.desk.token, { house_number: '300', contact: { name: 'Sam Ortiz', phone: ph, texts_ok: true } });
  assert.ok(await waitFor(() => textsTo(ph).length), 'the resident who said yes is told it was received');
  const crewId = await staffRequest(T.crew.token, { source: 'crew', lat: 40.13, lng: -75.51, accuracy: 6, street_id: null, cross_street: 'Bridge Street' });
  const d = await api('GET', `/requests/${crewId}`, { token: T.crew.token });
  is(d, 200); assert.equal(d.body.source, 'crew'); assert.equal(d.body.place, 'Near Bridge Street');
  // Crew do not see the resident's contact details; Front desk and managers do.
  const seen = await api('GET', `/requests/${id}`, { token: T.crew.token });
  assert.equal(seen.body.contact, null); assert.equal(seen.body.has_resident, true);
  assert.equal((await api('GET', `/requests/${id}`, { token: T.desk.token })).body.contact.name, 'Sam Ortiz');
  // When the municipality was told: a manager, for a phone report, with a reason, audited.
  const earlier = (await api('GET', `/requests/${id}`, { token: T.manager.token })).body.reported_at.slice(0, 10);
  const at = `${earlier}T06:15`;
  is(await api('POST', `/requests/${id}/reported-at`, { token: T.desk.token, body: { reported_at: at, reason: 'Voicemail left overnight' } }), 403);
  is(await api('POST', `/requests/${id}/reported-at`, { token: T.manager.token, body: { reported_at: at, reason: '' } }), 400);
  is(await api('POST', `/requests/${id}/reported-at`, { token: T.manager.token, body: { reported_at: at, reason: 'Voicemail left overnight' } }), 200);
  const [row] = await q('SELECT reported_at FROM requests WHERE id = ?', [id]);
  assert.equal(row.reported_at, `${earlier} 06:15:00`);
  const [a] = await q("SELECT detail FROM audit_log WHERE tenant_id = ? AND entity = 'requests' AND entity_id = ? AND action = 'reported_at'", [A.id, id]);
  assert.match(JSON.stringify(a.detail), /Voicemail left overnight/);
  const web = await report(A, { category_id: catId(A, 'Pothole'), street_id: A.streets['Main Street'] });
  const webId = (await q('SELECT id FROM requests WHERE reference = ? AND tenant_id = ?', [web.body.reference, A.id]))[0].id;
  const refused = await api('POST', `/requests/${webId}/reported-at`, { token: T.manager.token, body: { reported_at: at, reason: 'Trying' } });
  is(refused, 400); assert.match(refused.body.error, /keeps the time it arrived/);
});

test('triage: Front desk turns a request into a work order for the crew; completing it fixes the request and texts the resident who said yes', async () => {
  const yes = phone(); const no = phone();
  const r1 = await report(A, { category_id: catId(A, 'Pothole'), street_id: A.streets['Bridge Street'], house_number: '9', phone: yes, texts_ok: true });
  const r2 = await report(A, { category_id: catId(A, 'Pothole'), street_id: A.streets['Bridge Street'], house_number: '11', phone: no });
  const id1 = (await q('SELECT id FROM requests WHERE tenant_id = ? AND reference = ?', [A.id, r1.body.reference]))[0].id;
  const id2 = (await q('SELECT id FROM requests WHERE tenant_id = ? AND reference = ?', [A.id, r2.body.reference]))[0].id;
  await waitFor(() => textsTo(yes).length);
  is(await api('POST', `/requests/${id1}/work-order`, { token: T.crew.token, body: {} }), 403, 'the crew does not triage');
  const wo = await api('POST', `/requests/${id1}/work-order`, { token: T.desk.token, body: { priority: 'high', tell_resident: true } });
  is(wo, 201);
  const [w] = await q('SELECT source, request_id, title, status, priority FROM work_orders WHERE tenant_id = ? AND id = ?', [A.id, wo.body.work_order_id]);
  assert.equal(w.source, 'request'); assert.equal(Number(w.request_id), id1); assert.equal(w.priority, 'high');
  assert.match(w.title, /^Pothole: 9 Bridge Street/);
  assert.equal((await api('GET', `/requests/${id1}`, { token: T.desk.token })).body.status, 'assigned');
  assert.ok(textsTo(yes).some((t) => /work on your report .* is scheduled/.test(t.Body)), 'work scheduled, because Front desk chose to tell them');
  is(await api('POST', `/requests/${id1}/work-order`, { token: T.desk.token, body: {} }), 409, 'one open work order at a time');
  const wo2 = await api('POST', `/requests/${id2}/work-order`, { token: T.manager.token, body: {} });
  is(wo2, 201);
  // The crew completes the work orders in Work orders.
  is(await api('POST', `/ops/work-orders/${wo.body.work_order_id}/status`, { token: T.crew.token, body: { status: 'done', resolution: 'Filled and rolled' } }), 200);
  is(await api('POST', `/ops/work-orders/${wo2.body.work_order_id}/status`, { token: T.crew.token, body: { status: 'done', resolution: 'Filled' } }), 200);
  const d = (await api('GET', `/requests/${id1}`, { token: T.desk.token })).body;
  assert.equal(d.status, 'fixed'); assert.ok(d.fixed_at);
  assert.ok(d.events.some((e) => /Work order \d+ completed: Filled and rolled/.test(e.body)));
  assert.ok(textsTo(yes).some((t) => /is marked fixed/.test(t.Body)), 'fixed, to the resident who said yes');
  assert.equal(textsTo(no).length, 0, 'nothing to the resident who did not ask');
  const pub = await api('GET', `/public/${A.slug}/report/${r1.body.token}`);
  assert.equal(pub.body.status_words, 'Fixed');
  // Completing it again (reopened and done) does not text twice.
  const before = textsTo(yes).length;
  is(await api('POST', `/ops/work-orders/${wo.body.work_order_id}/status`, { token: T.crew.token, body: { status: 'open' } }), 200);
  is(await api('POST', `/ops/work-orders/${wo.body.work_order_id}/status`, { token: T.crew.token, body: { status: 'done' } }), 200);
  assert.equal(textsTo(yes).length, before);
});

test('never after STOP: a STOP texted back turns texts off for the resident, and START by text turns them on again', async () => {
  const ph = phone();
  const r = await report(A, { category_id: catId(A, 'Pothole'), street_id: A.streets['Church Street'], phone: ph, texts_ok: true });
  await waitFor(() => textsTo(ph).length);
  assert.equal(await textIn(ph, 'STOP'), 200);
  const [res0] = await q('SELECT x.id, x.texts_ok FROM residents x WHERE x.tenant_id = ? AND REGEXP_REPLACE(x.phone, \'[^0-9]\', \'\') = ?', [A.id, ph]);
  assert.equal(Number(res0.texts_ok), 0);
  const id = (await q('SELECT id FROM requests WHERE tenant_id = ? AND reference = ?', [A.id, r.body.reference]))[0].id;
  const n = textsTo(ph).length;
  is(await api('POST', `/requests/${id}/fixed`, { token: T.crew.token, body: { resolution: 'Cold patch' } }), 200);
  await sleep(100);
  assert.equal(textsTo(ph).length, n, 'nothing after STOP');
  // A new report that ticks "text me" from the same phone is still not texted while the STOP stands.
  const again = await report(A, { category_id: catId(A, 'Pothole'), street_id: A.streets['Church Street'], phone: ph, texts_ok: true });
  is(again, 201); await sleep(150);
  assert.equal(textsTo(ph).length, n);
  // The page says so, in the same words every municipal form uses, and START by text is the only way back.
  assert.equal(again.body.texts_off, 'This phone has texts turned off. Text START to 610-555-0000 to turn them back on.');
  assert.equal(r.body.texts_off, undefined, 'nothing to say before the STOP');
  const byDesk = await api('POST', '/requests', { token: T.desk.token, body: { category_id: catId(A, 'Pothole'), street_id: A.streets['Church Street'], source: 'phone', contact: { name: 'Sam Stopped', phone: ph, texts_ok: true } } });
  is(byDesk, 201); assert.match(byDesk.body.texts_off, /Text START to 610-555-0000/);
  assert.equal(Number((await q('SELECT texts_ok FROM residents WHERE id = ?', [res0.id]))[0].texts_ok), 0, 'ticking the box at the front desk does not turn texts back on');
  assert.equal(await textIn(ph, 'START'), 200);
  const hist = await RES.consentHistory(pool, A.id, res0.id);
  assert.equal(hist[0].status, 'opted_in'); assert.equal(hist[0].source, 'text_reply');
  const after = await report(A, { category_id: catId(A, 'Pothole'), street_id: A.streets['Church Street'], phone: ph, texts_ok: true });
  is(after, 201); assert.equal(after.body.texts_off, undefined);
  await waitFor(() => textsTo(ph).length > n);
  assert.ok(textsTo(ph).length > n, 'texted again after START');
});

test('made safe, with its time and a photo; fixed from the Requests view completes the work order', async () => {
  const id = await staffRequest(T.desk.token, { category_id: catId(A, 'Sign down or damaged'), street_id: A.streets['Main Street'], house_number: '410' });
  const wo = (await api('POST', `/requests/${id}/work-order`, { token: T.desk.token, body: {} })).body.work_order_id;
  const safe = await api('POST', `/requests/${id}/made-safe`, { token: T.crew.token, body: { note: 'Cones and a sign' } });
  is(safe, 200);
  is(await upload(`/requests/${id}/photos?stage=made_safe`, jpegWithGps(), { token: T.crew.token }), 201);
  is(await api('POST', `/requests/${id}/made-safe`, { token: T.crew.token, body: {} }), 409, 'once');
  let d = (await api('GET', `/requests/${id}`, { token: T.crew.token })).body;
  assert.equal(d.status, 'made_safe'); assert.equal(d.made_safe_note, 'Cones and a sign');
  assert.equal(d.photos[0].stage, 'made_safe');
  assert.match(d.make_safe.words, /^Made safe in \d+ minutes?, no target set$/);
  is(await api('POST', `/requests/${id}/fixed`, { token: T.desk.token, body: { resolution: 'New post' } }), 403, 'Front desk does not mark fixed');
  is(await upload(`/requests/${id}/photos?stage=after`, jpegWithGps(), { token: T.crew.token }), 201);
  is(await api('POST', `/requests/${id}/fixed`, { token: T.crew.token, body: { resolution: 'New post and sign', public_note: 'The stop sign is back up.' } }), 200);
  d = (await api('GET', `/requests/${id}`, { token: T.crew.token })).body;
  assert.equal(d.status, 'fixed'); assert.equal(d.public_note, 'The stop sign is back up.');
  const [w] = await q('SELECT status, resolution FROM work_orders WHERE tenant_id = ? AND id = ?', [A.id, wo]);
  assert.equal(w.status, 'done'); assert.equal(w.resolution, 'New post and sign');
  is(await api('POST', `/requests/${id}/fixed`, { token: T.crew.token, body: { resolution: 'Again' } }), 409);
  is(await api('POST', `/requests/${id}/reopen`, { token: T.desk.token, body: { reason: 'Sign fell again' } }), 403);
  is(await api('POST', `/requests/${id}/reopen`, { token: T.manager.token, body: { reason: 'Sign fell again' } }), 200);
  d = (await api('GET', `/requests/${id}`, { token: T.crew.token })).body;
  assert.equal(d.status, 'made_safe'); assert.equal(d.fixed_at, null);
  assert.ok(d.events.some((e) => /Reopened \(it was fixed at /.test(e.body)), 'the earlier fix stays in the timeline');
});

test('referred and duplicate: the resident hears it is closed, and a duplicate\'s resident hears when the first report is fixed', async () => {
  const ph = phone(); const dup = phone();
  const r = await report(A, { category_id: catId(A, 'Pothole'), street_id: A.streets['Main Street'], phone: ph, texts_ok: true });
  const id = (await q('SELECT id FROM requests WHERE tenant_id = ? AND reference = ?', [A.id, r.body.reference]))[0].id;
  is(await api('POST', `/requests/${id}/refer`, { token: T.desk.token, body: { referred_to: 'PennDOT', note: 'State road' } }), 200);
  const s = await api('GET', `/public/${A.slug}/report/${r.body.token}`);
  assert.equal(s.body.status_words, 'Passed to PennDOT');
  assert.ok(await waitFor(() => textsTo(ph).some((t) => /is closed\. It is looked after by PennDOT/.test(t.Body))));
  is(await api('POST', `/requests/${id}/close`, { token: T.desk.token, body: { reason: 'Done already' } }), 409, 'already closed');

  const first = await staffRequest(T.desk.token, { street_id: A.streets['Church Street'], house_number: '2' });
  const firstRef = (await q('SELECT reference FROM requests WHERE id = ?', [first]))[0].reference;
  const second = await report(A, { category_id: catId(A, 'Pothole'), street_id: A.streets['Church Street'], phone: dup, texts_ok: true });
  const secondId = (await q('SELECT id FROM requests WHERE tenant_id = ? AND reference = ?', [A.id, second.body.reference]))[0].id;
  is(await api('POST', `/requests/${secondId}/duplicate`, { token: T.desk.token, body: { of: secondId } }), 400, 'not of itself');
  is(await api('POST', `/requests/${secondId}/duplicate`, { token: T.desk.token, body: { of: firstRef.toLowerCase().replace('-', '') } }), 200, 'by its reference, typed loosely');
  const d = (await api('GET', `/requests/${first}`, { token: T.desk.token })).body;
  assert.deepEqual(d.duplicates.map((x) => x.reference), [second.body.reference]);
  assert.equal((await api('GET', `/public/${A.slug}/report/${second.body.token}`)).body.status_words, 'Already reported');
  is(await api('POST', `/requests/${first}/fixed`, { token: T.crew.token, body: { resolution: 'Patched' } }), 200);
  assert.ok(textsTo(dup).some((t) => /is marked fixed/.test(t.Body)), 'the duplicate\'s resident hears it is fixed');
  const closeId = await staffRequest(T.desk.token, {});
  is(await api('POST', `/requests/${closeId}/close`, { token: T.desk.token, body: { reason: '' } }), 400);
  is(await api('POST', `/requests/${closeId}/close`, { token: T.desk.token, body: { reason: 'Private property' } }), 200);
  assert.equal((await q('SELECT status, closed_reason FROM requests WHERE id = ?', [closeId]))[0].closed_reason, 'Private property');
});

test('response standards: the math in plain words, by category and street class', async () => {
  const tz = 'America/New_York';
  assert.equal(Q.spanWords(0.5), '30 minutes'); assert.equal(Q.spanWords(31), '31 hours'); assert.equal(Q.spanWords(100), '4 days'); assert.equal(Q.spanWords(110), '4.5 days');
  assert.equal(Q.targetWords(48), '2 days'); assert.equal(Q.targetWords(36), '36 hours'); assert.equal(Q.targetWords(4), '4 hours');
  const m = Q.measure('Fixed', '2026-11-02 08:00:00', '2026-11-03 15:00:00', 48, '2026-11-05 00:00:00', tz);
  assert.equal(m.words, 'Fixed in 31 hours, target 2 days'); assert.equal(m.met, true); assert.equal(m.hours, 31);
  const late = Q.measure('Fixed', '2026-11-02 08:00:00', null, 48, '2026-11-04 20:00:00', tz);
  assert.equal(late.words, 'Open 60 hours, 12 hours past the 2-day target'); assert.equal(late.met, false);
  const dst = Q.measure('Fixed', '2026-10-31 12:00:00', '2026-11-01 12:00:00', 24, '2026-11-02 00:00:00', tz);
  assert.equal(dst.hours, 25, 'the night the clocks go back is an hour longer');
  assert.equal(dst.met, false);
  const std = [{ category_id: 1, street_class: 'any', make_safe_hours: 24, fix_hours: 72 }, { category_id: 1, street_class: 'arterial', make_safe_hours: 4, fix_hours: null }];
  assert.deepEqual(Q.standardFor(std, 1, 'arterial'), { make_safe_hours: 4, fix_hours: 72 }, 'the class\'s own, then the category\'s');
  assert.deepEqual(Q.standardFor(std, 1, 'local'), { make_safe_hours: 24, fix_hours: 72 });
  assert.deepEqual(Q.standardFor(std, 2, 'local'), { make_safe_hours: null, fix_hours: null });

  const pot = catId(A, 'Pothole');
  is(await api('PUT', '/requests/standards', { token: T.desk.token, body: { standards: [] } }), 403);
  is(await api('PUT', '/requests/standards', { token: T.manager.token, body: { standards: [{ category_id: pot, make_safe_hours: 96, fix_hours: 48 }] } }), 400);
  is(await api('PUT', '/requests/standards', { token: T.manager.token, body: { standards: [{ category_id: pot, street_class: 'any', make_safe_hours: 24, fix_hours: 48 }, { category_id: pot, street_class: 'arterial', make_safe_hours: 4, fix_hours: 24 }] } }), 200);
  // A phone report told yesterday morning, fixed now: on Main Street (arterial), the 24-hour fix target.
  const id = await staffRequest(T.manager.token, { street_id: A.streets['Church Street'] });
  const [[now]] = await pool.query('SELECT reported_at FROM requests WHERE id = ?', [id]);
  const ms = Date.parse(`${now.reported_at.replace(' ', 'T')}Z`) - 31 * 3600000;
  const told = new Date(ms).toISOString().slice(0, 16);
  is(await api('POST', `/requests/${id}/reported-at`, { token: T.manager.token, body: { reported_at: told, reason: 'Called the office' } }), 200);
  is(await api('POST', `/requests/${id}/fixed`, { token: T.crew.token, body: { resolution: 'Patched' } }), 200);
  const d = (await api('GET', `/requests/${id}`, { token: T.crew.token })).body;
  assert.match(d.fix.words, /^Fixed in (30|31|32) hours, target 2 days$/, d.fix.words);
  assert.equal(d.fix.met, true);
  assert.match(d.make_safe.words, /^Made safe in (30|31|32) hours, target 24 hours$/, 'fixing it made it safe, later than the target');
  assert.equal(d.make_safe.met, false);
  const art = await staffRequest(T.manager.token, { street_id: A.streets['Main Street'] });
  const a = (await api('GET', `/requests/${art}`, { token: T.crew.token })).body;
  assert.equal(a.standard.make_safe_hours, 4); assert.equal(a.street_class, 'arterial');
  assert.match(a.make_safe.words, /^Open \d+ minutes?, target 4 hours$/);
  const audit = await q("SELECT detail FROM audit_log WHERE tenant_id = ? AND action = 'standards' ORDER BY id DESC LIMIT 1", [A.id]);
  assert.match(JSON.stringify(audit[0].detail), /arterial/, 'the standard itself is audited');
});

test('the ledger: by street in time order, met-target percentages, exports without contact details unless a manager asks (audited)', async () => {
  const ph = '6105550177';
  const id = await staffRequest(T.desk.token, { street_id: A.streets['Bridge Street'], house_number: '55', contact: { name: 'Robin Vance', phone: ph, email: 'robin@example.test' } });
  is(await api('POST', `/requests/${id}/fixed`, { token: T.crew.token, body: { resolution: 'Done' } }), 200);
  const l = await api('GET', `/requests/ledger?street_id=${A.streets['Bridge Street']}`, { token: T.crew.token });
  is(l, 200);
  assert.ok(l.body.data.length >= 3);
  assert.ok(l.body.data.every((x) => x.street === 'Bridge Street'));
  const times = l.body.data.map((x) => x.reported_at);
  assert.deepEqual(times, [...times].sort(), 'in time order');
  const pot = l.body.summary.find((s) => s.category === 'Pothole');
  assert.ok(pot && pot.fix_n >= 1 && pot.fix_pct !== null, 'met target, per category');
  assert.ok(!JSON.stringify(l.body).includes('Robin'), 'no contact details by default');
  assert.ok(!JSON.stringify(l.body).includes('"house_number"'));
  const csv = await api('GET', `/requests/ledger.csv?street_id=${A.streets['Bridge Street']}`, { token: T.desk.token });
  is(csv, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const head = String(csv.body).split('\r\n')[0];
  assert.ok(!/name|phone|email|house_number/.test(head), head);
  for (const secret of ['Robin', ph, 'robin@example.test', '"55"']) assert.ok(!String(csv.body).includes(secret), `the public-record CSV holds no ${secret}`);
  assert.match(String(csv.body), /(before|after|report|made_safe) [0-9a-f]{64}/, 'photo fingerprints are in it');
  is(await api('GET', `/requests/ledger.csv?contacts=1`, { token: T.desk.token }), 403, 'only a manager');
  is(await api('GET', `/requests/ledger?contacts=1`, { token: T.crew.token }), 403);
  const full = await api('GET', `/requests/ledger.csv?street_id=${A.streets['Bridge Street']}&contacts=1`, { token: T.manager.token });
  is(full, 200);
  assert.match(String(full.body).split('\r\n')[0], /house_number.*name.*phone.*email/);
  assert.ok(String(full.body).includes('Robin Vance') && String(full.body).includes('"55"'));
  const audit = await q("SELECT action, user_id, detail FROM audit_log WHERE tenant_id = ? AND entity = 'requests' AND action IN ('export','export_contacts') ORDER BY id", [A.id]);
  assert.deepEqual(audit.map((a) => a.action), ['export', 'export_contacts']);
  assert.equal(Number(audit[1].user_id), T.manager.id);
  is(await api('GET', '/requests/ledger?from=2026-12-01&to=2026-11-01', { token: T.crew.token }), 400);
});

test('the public map of open requests: off by default; on, it has no personal details and no house numbers', async () => {
  is(await api('GET', `/public/${A.slug}/open-requests`), 404);
  is(await api('PUT', '/requests/settings', { token: T.desk.token, body: { public_map: true } }), 403);
  is(await api('PUT', '/requests/settings', { token: T.manager.token, body: { public_map: true, after_hours_phone: '610-555-0911', office_phone: '610-555-0100' } }), 200);
  await report(A, { category_id: catId(A, 'Pothole'), street_id: A.streets['Main Street'], house_number: '777', lat: 40.123456, lng: -75.512345, accuracy: 5, name: 'Casey Lin', phone: '6105550188', description: 'Next to Casey\'s blue car' });
  const m = await api('GET', `/public/${A.slug}/open-requests`);
  is(m, 200);
  const text = JSON.stringify(m.body);
  for (const secret of ['Casey', '6105550188', '777', 'blue car', 'house', 'description', 'reference', 'token']) assert.ok(!text.includes(secret), `no ${secret}`);
  const pin = m.body.open.find((x) => x.at);
  assert.ok(pin);
  assert.notEqual(pin.at.lat, 40.123456, 'rounded');
  assert.ok(Math.abs(pin.at.lat - 40.123456) < 0.0003 && Math.abs(pin.at.lng + 75.512345) < 0.0004, 'to about 50 m');
  assert.ok(m.body.fixed.length >= 1, 'recently fixed ones too');
  assert.deepEqual(Object.keys(m.body.open[0]).sort(), ['at', 'category', 'color', 'fixed_on', 'reported_on', 'status', 'street']);
  const page = (await api('GET', `/public/${A.slug}/report`)).body;
  assert.equal(page.after_hours_phone, '610-555-0911'); assert.equal(page.open_map, true);
  is(await api('GET', `/public/${B.slug}/open-requests`), 404, 'another municipality keeps its own setting');
});

test('new requests alert the chosen people by phone and Inbox, without the resident\'s details', async () => {
  is(await api('PUT', '/requests/settings', { token: T.manager.token, body: { alert_user_ids: [T.desk.id, T.manager.id] } }), 200);
  is(await api('PUT', '/requests/settings', { token: T.manager.token, body: { alert_user_ids: [999999999] } }), 404);
  pushes.length = 0;
  const r = await report(A, { category_id: catId(A, 'Water leak or low pressure'), street_id: A.streets['Church Street'], house_number: '88', name: 'Morgan Hale', phone: '6105550166' });
  assert.ok(await waitFor(() => pushes.length));
  assert.deepEqual(pushes[0].userIds.sort(), [T.desk.id, T.manager.id].sort());
  assert.match(pushes[0].message.title, /Water leak/);
  assert.equal(pushes[0].message.body, 'Church Street');
  const [msg] = await q("SELECT m.body, m.refs FROM chat_messages m JOIN chat_threads t ON t.tenant_id = m.tenant_id AND t.id = m.thread_id WHERE m.tenant_id = ? AND t.name = 'New resident requests' ORDER BY m.id DESC LIMIT 1", [A.id]);
  assert.match(msg.body, new RegExp(`New request ${r.body.reference}: Water leak or low pressure, Church Street\\.`));
  // The request's own reference is random digits (R-4881 would hold "88"), so it is taken out before looking for the house number.
  const said = msg.body.split(r.body.reference).join('');
  for (const s of ['Morgan', '6105550166', '88']) assert.ok(!said.includes(s) && !String(pushes[0].message.body).includes(s), `${s} in ${said}`);
  const inbox = await api('GET', '/inbox/threads', { token: T.desk.token });
  if (inbox.status === 200) assert.ok(JSON.stringify(inbox.body).includes('New resident requests'));
  // A staff member who takes the request is not alerted about their own.
  pushes.length = 0;
  await staffRequest(T.desk.token, {});
  assert.ok(await waitFor(() => pushes.length));
  assert.deepEqual(pushes[0].userIds, [T.manager.id]);
});

test('the resident can stop updates from the status page', async () => {
  const ph = phone();
  const r = await report(A, { category_id: catId(A, 'Pothole'), street_id: A.streets['Main Street'], phone: ph, email: 'stopme@example.test', texts_ok: true, emails_ok: true });
  await waitFor(() => textsTo(ph).length && mails.some((m) => m.To === 'stopme@example.test'));
  const mail = mails.find((m) => m.To === 'stopme@example.test');
  assert.match(mail.TextBody, /choose Stop updates/); assert.match(mail.Subject, new RegExp(`We got your report \\(${r.body.reference}\\)`));
  is(await api('POST', `/public/${A.slug}/report/${r.body.token}/stop`), 200);
  const s = (await api('GET', `/public/${A.slug}/report/${r.body.token}`)).body;
  assert.deepEqual(s.updates, { text: false, email: false });
  const id = (await q('SELECT id FROM requests WHERE tenant_id = ? AND reference = ?', [A.id, r.body.reference]))[0].id;
  const n = textsTo(ph).length;
  is(await api('POST', `/requests/${id}/fixed`, { token: T.crew.token, body: { resolution: 'Done' } }), 200);
  assert.equal(textsTo(ph).length, n);
});

test('Right-to-Know: the work order spreadsheet leaves out the house number unless a manager includes contact details, and the crew still see it', async () => {
  const id = await staffRequest(T.desk.token, { category_id: catId(A, 'Pothole'), street_id: A.streets['Church Street'], house_number: '8125', description: 'Deep hole. Ask for Dana at the blue house.', contact: { name: 'Dana Whitlow', phone: '6105550177' } });
  const made = await api('POST', `/requests/${id}/work-order`, { token: T.desk.token, body: {} });
  is(made, 201);
  const wo = made.body.work_order_id;
  // The crew's own screen: the full location, to find the job.
  const seen = await api('GET', `/ops/work-orders/${wo}`, { token: T.crew.token });
  is(seen, 200);
  assert.match(seen.body.location, /8125 Church Street/);
  assert.match(seen.body.title, /8125 Church Street/);
  const line = (csv) => csv.split('\r\n').find((l) => l.startsWith(`"${wo}"`));
  // The public record: the street stays, the house number and the resident's own words do not.
  for (const token of [T.crew.token, T.manager.token]) {
    const plain = await api('GET', '/ops/work-orders/export?status=all&source=request', { token });
    is(plain, 200);
    assert.match(plain.headers.get('content-type'), /text\/csv/);
    assert.match(plain.headers.get('content-disposition'), /work-orders\.csv/);
    assert.ok(line(plain.body), 'the work order is in the spreadsheet');
    // Without the request's own reference and the work order's number, which are random digits.
    const [ref] = await q('SELECT reference FROM requests WHERE tenant_id = ? AND id = ?', [A.id, id]);
    const row = line(plain.body).split(ref.reference).join('').replace(`"${wo}"`, '');
    assert.match(row, /Pothole: Church Street/);
    assert.ok(!row.includes('8125') && !row.includes('Dana') && !row.includes('blue house'), row);
    assert.ok(!plain.body.includes('Whitlow') && !plain.body.includes('6105550177'));
  }
  // With contact details: managers only, and written to the audit log.
  assert.equal((await api('GET', '/ops/work-orders/export?status=all&contacts=1', { token: T.crew.token })).status, 403);
  const full = await api('GET', '/ops/work-orders/export?status=all&contacts=1', { token: T.manager.token });
  is(full, 200);
  assert.match(full.headers.get('content-disposition'), /work-orders-with-contacts\.csv/);
  assert.ok(line(full.body).includes('8125 Church Street') && line(full.body).includes('blue house'));
  const log = await q("SELECT action, user_id FROM audit_log WHERE tenant_id = ? AND entity = 'work_orders' AND action IN ('export', 'export_contacts') ORDER BY id", [A.id]);
  assert.deepEqual(log.map((l) => l.action), ['export', 'export', 'export_contacts']);
  assert.equal(Number(log[2].user_id), Number(T.manager.id));
  // A work order that is not from a request is exported as it is.
  const own = await api('POST', '/ops/work-orders', { token: T.manager.token, body: { title: 'Replace plow blade on truck 12', priority: 'normal', location: 'Garage bay 2' } });
  is(own, 201);
  const all = await api('GET', '/ops/work-orders/export?status=all', { token: T.crew.token });
  assert.ok(all.body.includes('Replace plow blade on truck 12') && all.body.includes('Garage bay 2'));
});

test('Today: new to look at, open past target, fixed today', async () => {
  const t = await api('GET', '/requests/today', { token: T.desk.token });
  is(t, 200);
  assert.deepEqual(t.body.cards.map((c) => c.title), ['New requests', 'Open past target', 'Fixed today']);
  const [[n]] = await pool.query("SELECT COUNT(*) AS n FROM requests WHERE tenant_id = ? AND status = 'new'", [A.id]);
  assert.equal(t.body.cards[0].count, Number(n.n));
  assert.ok(t.body.cards[2].count >= 3);
  for (const c of t.body.cards) assert.ok(c.href.startsWith('#/requests'));
  assert.ok(!JSON.stringify(t.body).match(/Robin|Jordan|Casey|Morgan/));
});

test('the list and the map for staff: new, open, done, late, and positions', async () => {
  const fresh = await api('GET', '/requests?view=new', { token: T.crew.token });
  is(fresh, 200);
  assert.ok(fresh.body.data.every((r) => r.status === 'new'));
  const done = await api('GET', '/requests?view=done', { token: T.crew.token });
  assert.ok(done.body.data.every((r) => ['fixed', 'closed_no_action', 'duplicate', 'referred'].includes(r.status)));
  const ref = done.body.data[0].reference;
  const found = await api('GET', `/requests?view=all&q=${encodeURIComponent(ref.replace('R-', 'r'))}`, { token: T.crew.token });
  assert.ok(found.body.data.some((r) => r.reference === ref));
  const map = await api('GET', '/requests/map', { token: T.crew.token });
  is(map, 200);
  assert.ok(map.body.layers.length && map.body.data.every((r) => r.lat !== null));
  assert.ok(!JSON.stringify(map.body.data).match(/Casey|6105550188/));
  const meta = await api('GET', '/requests/meta', { token: T.desk.token });
  is(meta, 200); assert.equal(meta.body.work_orders, true); assert.equal(meta.body.sees_contact, true);
  assert.equal((await api('GET', '/requests/meta', { token: T.crew.token })).body.sees_contact, false);
});

test('settings: categories and street classes, managers only', async () => {
  const add = await api('POST', '/requests/categories', { token: T.manager.token, body: { name: 'Snow not plowed', color: '#123456' } });
  is(add, 201);
  is(await api('POST', '/requests/categories', { token: T.manager.token, body: { name: 'Snow not plowed' } }), 409);
  is(await api('POST', '/requests/categories', { token: T.desk.token, body: { name: 'Nope' } }), 403);
  is(await api('PATCH', `/requests/categories/${add.body.id}`, { token: T.manager.token, body: { active: false } }), 200);
  assert.ok(!(await api('GET', `/public/${A.slug}/report`)).body.categories.some((c) => c.name === 'Snow not plowed'), 'a hidden category is not on the page');
  is(await report(A, { category_id: add.body.id, street_id: A.streets['Main Street'] }), 404);
  is(await api('PUT', '/requests/street-classes', { token: T.manager.token, body: { streets: [{ id: A.streets['Church Street'], street_class: 'collector' }] } }), 200);
  is(await api('PUT', '/requests/street-classes', { token: T.manager.token, body: { streets: [{ id: B.streets['Elm Avenue'], street_class: 'collector' }] } }), 404, 'another municipality\'s street');
  const s = await api('GET', '/requests/settings', { token: T.manager.token });
  assert.equal(s.body.streets.find((x) => x.name === 'Church Street').street_class, 'collector');
  assert.equal(s.body.alert_thread_id, undefined);
  await api('PUT', '/requests/street-classes', { token: T.manager.token, body: { streets: [{ id: A.streets['Church Street'], street_class: 'local' }] } });
});

// ---------------------------------------------------------------- gating and isolation
test('module gating: a mountain never reaches requests; a municipality with the app off neither', async () => {
  for (const p of ['/requests', '/requests/today', '/requests/meta', '/requests/ledger', '/requests/1']) {
    const r = await api('GET', p, { token: ski.token });
    is(r, 403, p); assert.equal(r.body.details.code, 'module_disabled');
  }
  is(await api('POST', '/requests', { token: ski.token, body: { category_id: 1, street_id: 1 } }), 403);
  for (const w of ['report', 'open-requests']) is(await api('GET', `/public/${ski.slug}/${w}`), 404, w);
  is(await api('POST', `/public/${ski.slug}/report`, { body: { category_id: 1, street_id: 1 } }), 404);

  const D = await quietly(() => createMuniTenant(base, { slug: `rq-d-${suffix}`, modules: { requests: false } }));
  const off = await api('GET', '/requests', { token: D.token });
  is(off, 403); assert.equal(off.body.details.code, 'module_disabled');
  is(await api('GET', `/public/${D.slug}/report`), 404);
  is(await api('POST', `/public/${D.slug}/report`, { body: { category_id: 1, street_id: 1 } }), 404);
  // Turned off later: the status links stop answering too.
  const r = await report(B, { category_id: catId(B, 'Pothole'), street_id: B.streets['Elm Avenue'] });
  is(await platform('PUT', `/tenants/${B.id}/modules`, { modules: { requests: false } }), 200);
  MOD.invalidate(B.id);
  is(await api('GET', `/public/${B.slug}/report/${r.body.token}`), 404);
  is(await platform('PUT', `/tenants/${B.id}/modules`, { modules: { requests: true } }), 200);
  MOD.invalidate(B.id);
  is(await api('GET', `/public/${B.slug}/report/${r.body.token}`), 200);
  // Work orders need Assets and fleet.
  const E = await quietly(() => createMuniTenant(base, { slug: `rq-e-${suffix}`, modules: { assets: false } }));
  const es = await addStreets(E, [['High Street']]);
  const ecat = (await api('GET', `/public/${E.slug}/report`)).body.categories[0].id;
  const ereq = await api('POST', '/requests', { token: E.token, body: { category_id: ecat, street_id: es['High Street'] } });
  is(ereq, 201);
  const ewo = await api('POST', `/requests/${ereq.body.id}/work-order`, { token: E.token, body: {} });
  is(ewo, 409); assert.match(ewo.body.error, /Assets and fleet/);
});

test('tenant isolation: another municipality cannot read, change or act on these requests, photos or settings', async () => {
  const [mine] = await q('SELECT id FROM requests WHERE tenant_id = ? ORDER BY id LIMIT 1', [A.id]);
  const [photo] = await q('SELECT id, request_id FROM request_photos WHERE tenant_id = ? LIMIT 1', [A.id]);
  const before = JSON.stringify(await q('SELECT * FROM requests WHERE tenant_id = ? ORDER BY id', [A.id]));
  const id = mine.id;
  const tries = [
    ['GET', `/requests/${id}`], ['PATCH', `/requests/${id}`, { description: 'x' }], ['POST', `/requests/${id}/work-order`, {}], ['POST', `/requests/${id}/refer`, { referred_to: 'PennDOT' }],
    ['POST', `/requests/${id}/duplicate`, { of: id }], ['POST', `/requests/${id}/close`, { reason: 'nope' }], ['POST', `/requests/${id}/made-safe`, {}], ['POST', `/requests/${id}/fixed`, { resolution: 'nope' }],
    ['POST', `/requests/${id}/reopen`, { reason: 'nope' }], ['POST', `/requests/${id}/notes`, { body: 'x' }], ['POST', `/requests/${id}/reported-at`, { reported_at: '2026-11-01T08:00', reason: 'nope' }],
    ['GET', `/requests/${photo.request_id}/photos/${photo.id}`], ['GET', `/requests/${photo.request_id}/photos/${photo.id}/verify`],
    ['PATCH', `/requests/categories/${catId(A, 'Pothole')}`, { name: 'Taken' }],
  ];
  for (const [m, p, body] of tries) {
    const r = await api(m, p, { token: B.token, body });
    assert.ok([404].includes(r.status), `${m} ${p}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  }
  is(await upload(`/requests/${id}/photos`, jpegWithGps(), { token: B.token }), 404);
  // B's create cannot use A's category or street.
  is(await api('POST', '/requests', { token: B.token, body: { category_id: catId(A, 'Pothole'), street_id: B.streets['Elm Avenue'] } }), 404);
  is(await api('POST', '/requests', { token: B.token, body: { category_id: catId(B, 'Pothole'), street_id: A.streets['Main Street'] } }), 404);
  is(await api('PUT', '/requests/standards', { token: B.token, body: { standards: [{ category_id: catId(A, 'Pothole'), make_safe_hours: 1, fix_hours: 2 }] } }), 404);
  // B's lists and ledger hold nothing of A's.
  for (const p of ['/requests?view=all', '/requests/map', '/requests/ledger', '/requests/settings', '/requests/today']) {
    const r = await api('GET', p, { token: B.token });
    is(r, 200, p);
    assert.ok(!JSON.stringify(r.body).includes(A.name) && !JSON.stringify(r.body).includes('Main Street'), p);
  }
  assert.equal(JSON.stringify(await q('SELECT * FROM requests WHERE tenant_id = ? ORDER BY id', [A.id])), before, 'nothing of A\'s changed');
});

// ---------------------------------------------------------------- privacy
test('privacy: residents are in the personal-data register; requests and residents never reach AI', () => {
  const { REGISTRY } = require('../src/lib/personal');
  const e = REGISTRY.find((x) => x.table === 'residents');
  assert.ok(e && e.by.phone && e.by.email && e.erase.set.name === 'Former resident' && e.erase.set.phone === null);
  const ai = ['src/lib/brief.js', 'src/lib/briefdata.js', 'src/lib/briefwrite.js', 'src/lib/proposals.js', 'src/lib/conditionswriter.js', 'src/lib/assistant.js', 'src/lib/assistanttools.js', 'src/routes/assistant.js', 'src/routes/ai.js'];
  for (const f of ai) {
    if (!fs.existsSync(path.join(__dirname, '..', f))) continue;
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(src, /\b(residents|resident_consent|requests|request_photos|request_events|request_messages)\b(?=[\s`'"]*(WHERE|JOIN|,|\)|$))|FROM\s+`?(residents|requests|request_)/i, `${f} reads no resident or request table`);
    assert.doesNotMatch(src, /require\(['"][./]*(lib\/)?(requests|residents)['"]\)/, `${f} loads no requests code`);
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'requests.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'requests.js'), 'utf8');
  assert.doesNotMatch(src, /console\.(log|error|warn)\([^)]*(phone|email|name|house)/, 'no contact details in logs');
});
