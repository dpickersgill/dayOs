'use strict';

// The collection schedule, through real HTTP (release 2026.11.22, Trash and recycling, workstream "schedule"): the setup
// screens and the check that blocks publishing until every street is zoned or marked not collected; the public calendar
// page (lookup, year, the iCalendar feed) that says nothing about residents and is rate limited; holiday shifts and
// moved or canceled days as residents see them; zone-targeted street notices; night-before reminders through the alert
// sign-up (consent by code, STOP, once per phone); "is it your day?" for missed pickups (public and staff, with repeats
// flagged to managers); roles; the add-on's gate for a ski area and a municipality without it; tenant isolation.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '100000';
process.env.PLATFORM_RATE_LIMIT = '100000';
process.env.PUBLIC_RATE_LIMIT = '100000';
process.env.ALERTS_RATE_LIMIT = '100000';
process.env.REPORT_RATE_LIMIT = '100000';
process.env.USERS_RATE_LIMIT = '100000';
process.env.COLLECTION_LOOKUP_LIMIT = '12';
process.env.MODULE_CACHE_MS = '0';
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'tw-token';
process.env.TWILIO_FROM = '+16105550000';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
process.env.MAIL_FROM = 'alerts@verdynt.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const mailer = require('../src/lib/mailer');
const { signature } = require('../src/routes/twilioinbound');
const helper = require('./helpers/muni');
const REM = require('../src/lib/collectionremind');

async function withoutMail(fn) {
  const was = process.env.POSTMARK_SERVER_TOKEN; delete process.env.POSTMARK_SERVER_TOKEN;
  try { return await fn(); } finally { process.env.POSTMARK_SERVER_TOKEN = was; }
}
async function createMuniTenant(b, opts) {
  const M = await withoutMail(() => helper.createMuniTenant(b, opts));
  const add = M.addLogin;
  M.addLogin = (role, extra) => withoutMail(() => add(role, extra));
  return M;
}

let server; let base; let tw; let pm;
const texts = []; const mails = [];
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const keyOf = (p) => String(p).replace(/\D/g, '').slice(-10);
let phoneN = Number(String(Date.now()).slice(-4));
const newPhone = () => `610-555-${String((phoneN++) % 10000).padStart(4, '0')}`;
async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text, headers: res.headers };
}
const ok = (r, want) => { assert.ok(want ? r.status === want : r.status < 300, `HTTP ${r.status}: ${String(r.text).slice(0, 500)}`); return r.body; };
const q = async (sql, params) => (await pool.query(sql, params))[0];
const textsTo = (phone) => texts.filter((t) => keyOf(t.To) === keyOf(phone));
const lastCode = (phone) => { const t = textsTo(phone).reverse().find((x) => /your code is (\d{6})/.test(x.Body)); return t ? /your code is (\d{6})/.exec(t.Body)[1] : null; };
const todayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const plus = (d, k) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const iso = (d) => { const w = new Date(`${d}T12:00:00Z`).getUTCDay(); return w === 0 ? 7 : w; };
/** A fixed-offset time zone where the local hour is now `hour` (Etc/GMT names are the other way round). */
function zoneAtHour(hour) {
  const off = ((hour - new Date().getUTCHours() + 36) % 24) - 12;
  return off === 0 ? 'Etc/GMT' : off > 0 ? `Etc/GMT-${off}` : `Etc/GMT+${-off}`;
}
async function textBack(from, word) {
  const params = { AccountSid: 'ACtest', MessageSid: `SM${Date.now()}${Math.random()}`.slice(0, 34), From: `+1${keyOf(from)}`, To: '+16105550000', Body: word };
  const url = `${base}/api/v1/twilio/sms`;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature('tw-token', url, params) }, body: new URLSearchParams(params).toString() });
  assert.equal(res.status, 200, await res.text());
}

/** A municipality with streets, Trash weekly and Recycling every other week, zones, and its calendar published. */
async function borough(slug, { tz = 'America/New_York', weekday = 4, publish = true } = {}) {
  const M = await createMuniTenant(base, { slug: `${slug}-${suffix}`, name: `Borough ${slug} ${suffix}`, modules: { solidwaste: true }, timezone: tz });
  M.streets = {};
  for (const n of ['Main Street', 'Bridge Street', 'Mill Street', 'Canal Street']) M.streets[n] = (await q('INSERT INTO streets (tenant_id, name) VALUES (?, ?)', [M.id, n])).insertId;
  M.trash = ok(await api('POST', '/solid-waste/collection/streams', { token: M.token, body: { name: 'Trash', kind: 'trash', frequency: 'weekly', color: '#5b6770', materials: 'Bagged trash' } }), 201).id;
  M.rec = ok(await api('POST', '/solid-waste/collection/streams', { token: M.token, body: { name: 'Recycling', kind: 'recycling', frequency: 'biweekly', anchor_date: '2026-11-02', color: '#1565c0' } }), 201).id;
  M.zone = ok(await api('POST', '/solid-waste/collection/zones', { token: M.token, body: { name: 'Thursday', days: [{ stream_id: M.trash, weekday }, { stream_id: M.rec, weekday }] } }), 201).id;
  M.zone2 = ok(await api('POST', '/solid-waste/collection/zones', { token: M.token, body: { name: 'Monday', days: [{ stream_id: M.trash, weekday: 1 }] } }), 201).id;
  ok(await api('PUT', `/solid-waste/collection/zones/${M.zone}/streets`, { token: M.token, body: { streets: [{ street_id: M.streets['Main Street'] }, { street_id: M.streets['Bridge Street'], from_no: 1, to_no: 199, side: 'odd' }] } }));
  ok(await api('PUT', `/solid-waste/collection/zones/${M.zone2}/streets`, { token: M.token, body: { streets: [{ street_id: M.streets['Mill Street'] }, { street_id: M.streets['Bridge Street'] }] } }));
  ok(await api('PUT', '/solid-waste/collection/not-collected', { token: M.token, body: { streets: [{ street_id: M.streets['Canal Street'] }] } }));
  if (publish) ok(await api('POST', '/solid-waste/collection/setup/finish', { token: M.token }));
  return M;
}
const pub = (M, path) => api('GET', `/public/${M.slug}/collection${path}`);

let A; let B; let NO; let ski; let crew; let desk;
test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const listen = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });
  let n = 0;
  tw = await listen((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { texts.push(Object.fromEntries(new URLSearchParams(d))); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ sid: `SM${++n}` })); }); });
  pm = await listen((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { mails.push(JSON.parse(d)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m-${++n}` })); }); });
  process.env.TWILIO_API_BASE = `http://127.0.0.1:${tw.address().port}`;
  mailer.settings.apiBase = `http://127.0.0.1:${pm.address().port}`;
  A = await borough('ts-a');
  B = await borough('ts-b');
  NO = await createMuniTenant(base, { slug: `ts-no-${suffix}` });
  crew = await A.addLogin('staff'); desk = await A.addLogin('counter');
  const r = await fetch(`${base}/api/v1/platform/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-platform-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug: `ts-ski-${suffix}`, name: `Ski ${suffix}`, billing: 'comped', owner: { email: `gm@ts-ski-${suffix}.test`, password: helper.PASSWORD, first_name: 'G', last_name: 'M' } }) });
  assert.equal(r.status, 201);
  ski = (await withoutMail(() => api('POST', '/auth/login', { body: { tenant: `ts-ski-${suffix}`, login: `gm@ts-ski-${suffix}.test`, password: helper.PASSWORD } }))).body.token;
});
test.after(async () => { await new Promise((r) => server.close(r)); tw.close(); pm.close(); await pool.end(); });

// ---------------------------------------------------------------- gating and roles
test('the app is gated: a ski area and a municipality without Trash and recycling are refused, signed in and on the public page', async () => {
  const s = await api('GET', '/solid-waste/collection/setup', { token: ski });
  assert.equal(s.status, 403);
  const m = await api('GET', '/solid-waste/collection/setup', { token: NO.token });
  assert.equal(m.status, 403);
  assert.equal(m.body.details.code, 'module_disabled');
  assert.equal((await api('GET', `/public/${NO.slug}/collection`)).status, 404);
  assert.equal((await api('GET', `/public/ts-ski-${suffix}/collection`)).status, 404);
  const page = await fetch(`${base}/collection/${A.slug}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /collectionpage\.js/);
});

test('roles: the crew and front desk see the schedule; only managers change it; the front desk keeps the education log', async () => {
  ok(await api('GET', '/solid-waste/collection/setup', { token: crew.token }));
  ok(await api('GET', '/solid-waste/collection/calendar', { token: desk.token }));
  assert.equal((await api('PUT', '/solid-waste/collection/settings', { token: crew.token, body: { holiday_rule: 'none' } })).status, 403);
  assert.equal((await api('POST', '/solid-waste/collection/streams', { token: desk.token, body: { name: 'X' } })).status, 403);
  assert.equal((await api('POST', '/solid-waste/collection/setup/finish', { token: desk.token })).status, 403);
  assert.equal((await api('GET', '/solid-waste/collection/education', { token: crew.token })).status, 403);
  ok(await api('POST', '/solid-waste/collection/education', { token: desk.token, body: { on_date: '2026-03-01', kind: 'mailer', title: 'Spring calendar mailed', copies: 1200 } }), 201);
  const edu = ok(await api('GET', '/solid-waste/collection/education', { token: desk.token }));
  assert.equal(edu.printed_this_year, edu.entries.some((e) => e.printed && e.on_date.startsWith(todayIn('America/New_York').slice(0, 4))));
  assert.ok(edu.entries.some((e) => e.title === 'Spring calendar mailed' && e.printed));
});

// ---------------------------------------------------------------- the setup check
test('setup cannot be finished until every active street is in a zone or marked not collected; the public page waits for it', async () => {
  const T = await borough('ts-setup', { publish: false });
  assert.equal(ok(await pub(T, '')).ready, false);
  assert.equal((await pub(T, `/lookup?street=${T.streets['Main Street']}&no=1`)).status, 404);
  const extra = (await q('INSERT INTO streets (tenant_id, name) VALUES (?, ?)', [T.id, 'Orchard Lane'])).insertId;
  const no = await api('POST', '/solid-waste/collection/setup/finish', { token: T.token });
  assert.equal(no.status, 409);
  assert.equal(no.body.details.code, 'setup_incomplete');
  assert.deepEqual(no.body.details.unzoned.map((s) => s.name), ['Orchard Lane']);
  // An inactive street does not count; a zone with no day blocks too.
  await q('UPDATE streets SET active = 0 WHERE id = ?', [extra]);
  const z3 = ok(await api('POST', '/solid-waste/collection/zones', { token: T.token, body: { name: 'Empty zone' } }), 201).id;
  const no2 = await api('POST', '/solid-waste/collection/setup/finish', { token: T.token });
  assert.equal(no2.status, 409);
  assert.match(no2.body.error, /Give Empty zone a collection day/);
  ok(await api('PATCH', `/solid-waste/collection/zones/${z3}`, { token: T.token, body: { active: false } }));
  // A stream every other week needs its date.
  const bad = await api('POST', '/solid-waste/collection/streams', { token: T.token, body: { name: 'Glass', frequency: 'biweekly' } });
  assert.equal(bad.status, 400);
  const fine = ok(await api('GET', '/solid-waste/collection/setup/check', { token: T.token }));
  assert.equal(fine.ok, true);
  assert.deepEqual(fine.partial, [], 'Bridge Street has a whole-street row as well as its odd range');
  ok(await api('POST', '/solid-waste/collection/setup/finish', { token: T.token }));
  assert.equal(ok(await pub(T, '')).ready, true);
});

// ---------------------------------------------------------------- the public page
test('the public lookup: zone and next dates by house number and side; never anything about who lives there', async () => {
  const z = (r) => (r.body.zone ? r.body.zone.name : r.body.not_collected ? 'not collected' : null);
  assert.equal(z(await pub(A, `/lookup?street=${A.streets['Bridge Street']}&no=15`)), 'Thursday', 'odd side in range');
  assert.equal(z(await pub(A, `/lookup?street=${A.streets['Bridge Street']}&no=16`)), 'Monday', 'even side: the whole-street row');
  assert.equal(z(await pub(A, `/lookup?street=${A.streets['Canal Street']}&no=4`)), 'not collected');
  // A resident with a sign-up and a request at 10 Main Street; nobody at 12. The answers are the same but for nothing.
  await q("INSERT INTO residents (tenant_id, name, phone, email, street_id, house_number) VALUES (?, 'Pat Private', '610-555-0199', 'pat@example.com', ?, '10')", [A.id, A.streets['Main Street']]);
  const ten = await pub(A, `/lookup?street=${A.streets['Main Street']}&no=10`);
  const twelve = await pub(A, `/lookup?street=${A.streets['Main Street']}&no=12`);
  assert.deepEqual(ten.body, twelve.body);
  assert.doesNotMatch(ten.text, /Pat|555|example\.com|resident/i);
  assert.equal(ten.headers.get('cache-control'), 'no-store');
  // A street of another municipality is "pick your street", the same as a made-up one.
  const other = await pub(A, `/lookup?street=${B.streets['Main Street']}&no=10`);
  const madeUp = await pub(A, '/lookup?street=999999999&no=10');
  assert.equal(other.status, 400);
  assert.deepEqual(other.body, madeUp.body);
  const page = ok(await pub(A, ''));
  assert.doesNotMatch(JSON.stringify(page), /Pat Private|pat@example/);
  assert.deepEqual(page.streams.map((s) => s.name), ['Trash', 'Recycling']);
});

test('the public lookup is rate limited per address and municipality', async () => {
  const T = await borough('ts-rate');
  let last;
  for (let i = 0; i < 13; i += 1) last = await pub(T, `/lookup?street=${T.streets['Main Street']}&no=${i + 1}`);
  assert.equal(last.status, 429);
  assert.match(last.body.error, /Too many lookups/);
  // Another municipality's page is not used up.
  assert.equal((await pub(A, `/lookup?street=${A.streets['Main Street']}&no=1`)).status, 200);
});

test('holidays and changes as residents see them: Thanksgiving moves Thursday to Friday; a snow day moves one zone; a cancel drops the day', async () => {
  const T = await borough('ts-hol');
  ok(await api('POST', '/solid-waste/collection/holidays', { token: T.token, body: { on_date: '2026-11-26', name: 'Thanksgiving Day' } }));
  const fed = ok(await api('POST', '/solid-waste/collection/holidays/federal', { token: T.token, body: { year: 2027 } }));
  assert.equal(fed.added, 11);
  const year = ok(await pub(T, `/year?zone=${T.zone}&year=2026`));
  const nov = year.days.filter((d) => d.date >= '2026-11-23' && d.date <= '2026-11-29');
  assert.deepEqual(nov.map((d) => [d.date, d.stream, d.moved]), [['2026-11-27', 'Trash', true]], 'the off week for recycling; trash on Friday');
  // Snow on Thursday December 3 for the Thursday zone: moved to Friday. A manager does it; a draft notice to the zone follows.
  const ch = ok(await api('POST', '/solid-waste/collection/changes', { token: T.token, body: { on_date: '2026-12-03', moved_to: '2026-12-04', zone_ids: [T.zone], reason: 'snow' } }), 201);
  assert.ok(ch.notice_id);
  const n = (await q('SELECT type, status, title, sms_text, collection_zone_ids FROM street_notices WHERE tenant_id = ? AND id = ?', [T.id, ch.notice_id]))[0];
  assert.equal(n.type, 'trash_change'); assert.equal(n.status, 'draft');
  assert.match(n.sms_text, /moves to Friday, December 4 because of snow/);
  const areas = await q('SELECT street_id, from_no, to_no, side FROM street_notice_areas WHERE tenant_id = ? AND notice_id = ? ORDER BY street_id, from_no', [T.id, ch.notice_id]);
  assert.deepEqual(areas.map((a) => [a.street_id, a.side]).sort(), [[T.streets['Main Street'], 'both'], [T.streets['Bridge Street'], 'odd']].sort());
  const dec = ok(await pub(T, `/year?zone=${T.zone}&year=2026`)).days.filter((d) => d.date >= '2026-11-30' && d.date <= '2026-12-06');
  assert.deepEqual(dec.map((d) => [d.date, d.stream, d.reason]), [['2026-12-04', 'Trash', 'snow'], ['2026-12-04', 'Recycling', 'snow']]);
  const mon = ok(await pub(T, `/year?zone=${T.zone2}&year=2026`)).days.filter((d) => d.date >= '2026-11-30' && d.date <= '2026-12-06');
  assert.deepEqual(mon.map((d) => d.date), ['2026-11-30'], 'the Monday zone is not in the change');
  ok(await api('POST', '/solid-waste/collection/changes', { token: T.token, body: { on_date: '2026-12-10', moved_to: null, zone_ids: [], reason: 'weather', notice: false } }), 201);
  assert.deepEqual(ok(await pub(T, `/year?zone=${T.zone}&year=2026`)).days.filter((d) => d.date >= '2026-12-07' && d.date <= '2026-12-13'), []);
  // Undo the snow day: the calendar goes back.
  const id = (await q('SELECT id FROM collection_changes WHERE tenant_id = ? AND on_date = ?', [T.id, '2026-12-03']))[0].id;
  ok(await api('DELETE', `/solid-waste/collection/changes/${id}`, { token: T.token }));
  assert.deepEqual(ok(await pub(T, `/year?zone=${T.zone}&year=2026`)).days.filter((d) => d.date >= '2026-11-30' && d.date <= '2026-12-06').map((d) => d.date), ['2026-12-03', '2026-12-03']);
  // The notice, once sent, shows at the top of the page for that zone only.
  await q("UPDATE street_notices SET status = 'active', sent_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ?", [T.id, ch.notice_id]);
  assert.equal(ok(await pub(T, `/lookup?street=${T.streets['Main Street']}&no=1`)).notices.length, 1);
  assert.equal(ok(await pub(T, `/lookup?street=${T.streets['Mill Street']}&no=1`)).notices.length, 0);
});

test('the iCalendar feed: all-day events per collection, moved days named, folded CRLF lines, events, a stream filter, no resident data', async () => {
  const T = await borough('ts-ics');
  ok(await api('POST', '/solid-waste/collection/holidays', { token: T.token, body: { on_date: '2026-11-26', name: 'Thanksgiving Day' } }));
  ok(await api('POST', '/solid-waste/collection/events', { token: T.token, body: { kind: 'leaf', name: 'Leaf collection, a long name to make the line longer than seventy-five octets for folding, week 1', starts_on: '2026-11-30', ends_on: '2026-12-11', notes: 'Rake to the curb; not into the street, please', zone_ids: [T.zone] } }), 201);
  const res = await fetch(`${base}/api/v1/public/${T.slug}/collection/calendar.ics?zone=${T.zone}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/calendar/);
  const body = await res.text();
  assert.ok(body.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.ok(body.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(body), 'every line ends with CRLF');
  for (const line of body.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `folded: ${line}`);
  const unfolded = body.replace(/\r\n /g, '');
  const today = todayIn('America/New_York');
  if (today <= '2026-11-27') assert.match(unfolded, /DTSTART;VALUE=DATE:20261127\r\nDTEND;VALUE=DATE:20261128\r\nSUMMARY:Trash \(moved for the holiday\)/);
  assert.match(unfolded, /SUMMARY:Leaf collection\\, a long name/);
  assert.match(unfolded, /DESCRIPTION:Rake to the curb\\; not into the street\\, please/);
  assert.equal((unfolded.match(/BEGIN:VEVENT/g) || []).length, (unfolded.match(/END:VEVENT/g) || []).length);
  assert.doesNotMatch(unfolded, /@example|555-/);
  const onlyRec = await (await fetch(`${base}/api/v1/public/${T.slug}/collection/calendar.ics?zone=${T.zone}&streams=${T.rec}`)).text();
  assert.doesNotMatch(onlyRec, /SUMMARY:Trash/);
  assert.match(onlyRec, /SUMMARY:Recycling/);
  assert.equal((await fetch(`${base}/api/v1/public/${T.slug}/collection/calendar.ics?zone=${A.zone}`)).status, 404, 'another municipality\'s zone');
});

// ---------------------------------------------------------------- zone-targeted street notices
test('a street notice aimed at collection zones goes to those zones\' streets', async () => {
  const r = ok(await api('POST', '/street-notices', { token: A.token, body: { type: 'trash_change', title: 'Pickup moves', sms_text: 'Thursday pickup moves to Friday.', collection_zone_ids: [A.zone] } }), 201);
  assert.deepEqual(r.areas.map((a) => [a.street_name, a.side]).sort(), [['Bridge Street', 'odd'], ['Main Street', 'both']]);
  const bad = await api('POST', '/street-notices', { token: A.token, body: { type: 'trash_change', title: 'x', sms_text: 'y', collection_zone_ids: [B.zone] } });
  assert.equal(bad.status, 400, 'another municipality\'s zone');
  const none = await api('POST', '/street-notices', { token: A.token, body: { type: 'trash_change', title: 'x', sms_text: 'y' } });
  assert.equal(none.status, 400);
  const pre = ok(await api('POST', '/street-notices/preview', { token: A.token, body: { type: 'trash_change', collection_zone_ids: [A.zone2] } }));
  assert.equal(typeof pre.texts, 'number');
});

// ---------------------------------------------------------------- reminders
test('night-before reminders: only confirmed sign-ups, the streams they picked, once per phone, never after STOP or before the hour', async () => {
  const T = await borough('ts-rem', { weekday: iso(plus(todayIn('America/New_York'), 1)) });
  const today = todayIn('America/New_York'); const tomorrow = plus(today, 1);
  const main = T.streets['Main Street'];
  const signup = (body) => api('POST', `/public/${T.slug}/alerts`, { body: { street_id: main, house_number: '20', topics: [], ...body } });
  // Confirmed by code: a phone that wants trash (and recycling, if this is its week).
  const p1 = newPhone();
  const s1 = ok(await signup({ phone: p1, streams: [T.trash, T.rec] }), 201);
  ok(await api('POST', `/public/${T.slug}/alerts/confirm`, { body: { ref: s1.ref, code: lastCode(p1) } }));
  // The same phone again for another address in the zone: still one text.
  const s1b = ok(await signup({ phone: p1, house_number: '30', streams: [T.trash] }), 201);
  ok(await api('POST', `/public/${T.slug}/alerts/confirm`, { body: { ref: s1b.ref, code: lastCode(p1) } }));
  // Never confirmed: nothing.
  const p2 = newPhone();
  ok(await signup({ phone: p2, streams: [T.trash] }), 201);
  // Confirmed, but only for a stream that is not collected tomorrow (another zone's Monday stream: Bridge Street even side).
  const p3 = newPhone();
  const s3 = ok(await api('POST', `/public/${T.slug}/alerts`, { body: { street_id: T.streets['Mill Street'], house_number: '5', topics: [], phone: p3, streams: [T.trash] } }), 201);
  ok(await api('POST', `/public/${T.slug}/alerts/confirm`, { body: { ref: s3.ref, code: lastCode(p3) } }));
  // A stream from another municipality is refused.
  assert.equal((await signup({ phone: newPhone(), streams: [A.trash] })).status, 400);
  const before = texts.length;
  const early = await REM.remindDue(base, { now: `${today} 17:59:00`, tenantId: T.id });
  assert.equal(early.sent, 0, 'before 6 PM nothing goes');
  const late = await REM.remindDue(base, { now: `${today} 21:05:00`, tenantId: T.id });
  assert.equal(late.sent, 0, 'from 9 PM nothing goes');
  const run = await REM.remindDue(base, { now: `${today} 18:10:00`, tenantId: T.id });
  assert.equal(run.sent, 1);
  const sent = texts.slice(before);
  assert.equal(sent.length, 1);
  assert.equal(keyOf(sent[0].To), keyOf(p1));
  assert.match(sent[0].Body, /tomorrow, .* is pickup for Trash/);
  assert.match(sent[0].Body, /Reply STOP to stop texts\.$/);
  const runAgain = await REM.remindDue(base, { now: `${today} 19:30:00`, tenantId: T.id });
  assert.equal(runAgain.sent, 0, 'once');
  assert.equal(texts.length, before + 1);
  const log = await q('SELECT for_date, channel, status, addr_hash FROM collection_reminder_sends WHERE tenant_id = ?', [T.id]);
  assert.deepEqual(log.map((x) => [String(x.for_date).slice(0, 10), x.channel, x.status]), [[tomorrow, 'sms', 'sent']]);
  assert.doesNotMatch(JSON.stringify(log), new RegExp(keyOf(p1)), 'the log keeps a hash, not the phone');
  // STOP: the next week's reminder does not go.
  await textBack(p1, 'STOP');
  const nextWeek = plus(today, 7);
  const after = await REM.remindDue(base, { now: `${nextWeek} 18:10:00`, tenantId: T.id });
  assert.equal(after.sent, 0);
  assert.equal(after.opted_out, 1);
  assert.equal(texts.length, before + 1);
  // Managers see counts, never who.
  const rem = ok(await api('GET', '/solid-waste/collection/reminders', { token: T.token }));
  assert.equal(rem.texts, 3);
  assert.doesNotMatch(JSON.stringify(rem), new RegExp(keyOf(p1)));
});

test('a reminder by email names the streams and the move, with the manage link', async () => {
  // Today is the zone's day, but the weather moved it to tomorrow: tonight's reminder says so.
  const T = await borough('ts-remail', { weekday: iso(todayIn('America/New_York')) });
  const today = todayIn('America/New_York'); const tomorrow = plus(today, 1);
  ok(await api('POST', '/solid-waste/collection/changes', { token: T.token, body: { on_date: today, moved_to: tomorrow, zone_ids: [T.zone], reason: 'weather', notice: false } }), 201);
  const email = `rem-${suffix}@example.com`;
  const s = ok(await api('POST', `/public/${T.slug}/alerts`, { body: { street_id: T.streets['Main Street'], house_number: '8', topics: [], email, streams: [T.trash] } }), 201);
  assert.equal(s.needs_code, false);
  const m = mails.filter((x) => x.To === email).reverse().find((x) => /\/email\//.test(x.TextBody));
  ok(await api('POST', `/public/${T.slug}/alerts/email`, { body: { token: /\/email\/([^\s]+)/.exec(m.TextBody)[1] } }));
  const before = mails.length;
  const r = await REM.remindDue('https://town.example', { now: `${today} 18:00:00`, tenantId: T.id });
  assert.equal(r.sent, 1);
  const sent = mails.slice(before);
  assert.equal(sent.length, 1);
  assert.match(sent[0].Subject, /Trash tomorrow/);
  assert.match(sent[0].TextBody, /Trash moved for the weather/);
  assert.match(sent[0].TextBody, /To change or stop it: https:\/\/town\.example\/alerts\//);
});

// ---------------------------------------------------------------- missed pickups
test('"is it your day?": not collected, not your day (with the next date), not yet before 5 PM, and ok after; the report form follows it', async () => {
  // Today is the Thursday zone's day, it is 10 AM there: the truck may still come.
  const T = await borough('ts-miss', { tz: zoneAtHour(10) });
  const tz = (await q('SELECT timezone FROM tenants WHERE id = ?', [T.id]))[0].timezone;
  const today = todayIn(tz);
  ok(await api('PATCH', `/solid-waste/collection/zones/${T.zone}`, { token: T.token, body: { days: [{ stream_id: T.trash, weekday: iso(today) }, { stream_id: T.rec, weekday: iso(plus(today, 3)) }] } }));
  const check = (street, no, stream) => pub(T, `/check?street=${T.streets[street]}&no=${no}&stream=${stream}`);
  const nc = ok(await check('Canal Street', 4, T.trash));
  assert.equal(nc.outcome, 'not_collected'); assert.equal(nc.may_send, false);
  const ny = ok(await check('Main Street', 4, T.trash));
  assert.equal(ny.outcome, 'not_yet'); assert.equal(ny.may_send, false);
  assert.match(ny.message, /still on its route/);
  const nyd = ok(await check('Main Street', 4, T.rec));
  assert.equal(nyd.outcome, 'not_your_day');
  assert.match(nyd.message, /Your recycling is collected every other/);
  assert.ok(nyd.next.date > today);
  // The report form: the category, the stream, and the refusal in the same words.
  const page = ok(await api('GET', `/public/${T.slug}/report`));
  assert.ok(page.missed && page.missed.category_id);
  assert.deepEqual(page.missed.streams.map((x) => x.name), ['Trash', 'Recycling']);
  assert.equal(page.categories.find((c) => c.id === page.missed.category_id).name, 'Missed pickup');
  const send = (stream, no = '4') => api('POST', `/public/${T.slug}/report`, { body: { category_id: page.missed.category_id, street_id: T.streets['Main Street'], house_number: no, stream_id: stream, phone: '610-555-0142' } });
  const refused = await send(T.rec);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.details.outcome, 'not_your_day');
  assert.equal((await send(T.trash)).status, 409, 'not yet');
  assert.equal((await send(null)).status, 400, 'the stream is asked for');
  // At 6 PM there it may be reported, and is kept with its stream and the check.
  await q('UPDATE tenants SET timezone = ? WHERE id = ?', [zoneAtHour(18), T.id]);
  const tz2 = zoneAtHour(18);
  if (todayIn(tz2) === today) {
    const okr = ok(await check('Main Street', 4, T.trash));
    assert.equal(okr.outcome, 'ok_to_report'); assert.equal(okr.may_send, true);
    const sent = ok(await send(T.trash), 201);
    const row = (await q('SELECT stream_id, pickup_check FROM requests WHERE tenant_id = ? AND reference = ?', [T.id, sent.reference]))[0];
    assert.deepEqual([Number(row.stream_id), row.pickup_check], [T.trash, 'ok_to_report']);
  }
});

test('"is it your day?" uses the municipality\'s own date around midnight', async () => {
  // A zone where it is just after midnight (or just before it), so its date is not the server's UTC date.
  const utcHour = new Date().getUTCHours();
  const hour = utcHour >= 12 ? 0 : 23;
  const T = await borough('ts-mid', { tz: zoneAtHour(hour) });
  const tz = (await q('SELECT timezone FROM tenants WHERE id = ?', [T.id]))[0].timezone;
  const local = todayIn(tz);
  ok(await api('PATCH', `/solid-waste/collection/zones/${T.zone}`, { token: T.token, body: { days: [{ stream_id: T.trash, weekday: iso(local) }] } }));
  const r = ok(await pub(T, `/check?street=${T.streets['Main Street']}&no=2&stream=${T.trash}`));
  assert.equal(r.outcome, hour === 0 ? 'not_yet' : 'ok_to_report', `local ${local} in ${tz}`);
  const look = ok(await pub(T, `/lookup?street=${T.streets['Main Street']}&no=2`));
  assert.equal(look.next[0].date, local);
});

test('staff take a missed pickup the check refuses (with a tick on screen); a second miss at one address in 60 days is flagged to managers', async () => {
  const T = await borough('ts-staff', { tz: zoneAtHour(19) });
  const tz = (await q('SELECT timezone FROM tenants WHERE id = ?', [T.id]))[0].timezone;
  const today = todayIn(tz);
  ok(await api('PATCH', `/solid-waste/collection/zones/${T.zone}`, { token: T.token, body: { days: [{ stream_id: T.trash, weekday: iso(today) }, { stream_id: T.rec, weekday: iso(plus(today, 2)) }] } }));
  const meta = ok(await api('GET', '/requests/meta', { token: T.token }));
  const cat = meta.missed.category_id;
  const deskT = await T.addLogin('counter');
  const staffCheck = ok(await api('GET', `/solid-waste/collection/check?street=${T.streets['Main Street']}&no=44&stream=${T.rec}`, { token: deskT.token }));
  assert.equal(staffCheck.outcome, 'not_your_day');
  const one = ok(await api('POST', '/requests', { token: deskT.token, body: { category_id: cat, street_id: T.streets['Main Street'], house_number: '44', stream_id: T.rec, source: 'phone', contact: { phone: '610-555-0150' } } }), 201);
  assert.equal((await q('SELECT pickup_check FROM requests WHERE tenant_id = ? AND id = ?', [T.id, one.id]))[0].pickup_check, 'not_your_day');
  assert.equal((await q("SELECT COUNT(*) AS n FROM chat_threads WHERE tenant_id = ? AND name = 'Missed pickups'", [T.id]))[0].n, 0, 'one miss: no flag');
  ok(await api('POST', '/requests', { token: deskT.token, body: { category_id: cat, street_id: T.streets['Main Street'], house_number: '44', stream_id: T.trash, source: 'phone', contact: { phone: '610-555-0150' } } }), 201);
  const msgs = await q("SELECT m.body FROM chat_messages m JOIN chat_threads t ON t.tenant_id = m.tenant_id AND t.id = m.thread_id WHERE m.tenant_id = ? AND t.name = 'Missed pickups'", [T.id]);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].body, /Repeat missed pickup on Main Street: 2 at the same address/);
  assert.doesNotMatch(msgs[0].body, /44|555/);
  // The tab, the menu count, + New and the Today card read the same number.
  const list = ok(await api('GET', '/solid-waste/collection/missed', { token: deskT.token }));
  assert.equal(list.waiting, 2);
  assert.equal(list.data[0].repeat, 2);
  const counts = ok(await api('GET', '/nav/counts', { token: deskT.token })).counts;
  assert.equal(counts.bulk.n, 2);
  assert.ok(ok(await api('GET', '/nav/new', { token: deskT.token })).items.includes('missed_pickup'));
  const crewT = await T.addLogin('staff');
  assert.ok(!ok(await api('GET', '/nav/new', { token: crewT.token })).items.includes('missed_pickup'));
  assert.equal(ok(await api('GET', '/nav/counts', { token: crewT.token })).counts.bulk, undefined);
  const today2 = ok(await api('GET', '/solid-waste/today', { token: deskT.token }));
  assert.equal(today2.cards.find((c) => c.title === 'Missed pickups').count, 2);
  assert.ok(today2.cards.find((c) => c.title === 'Collection today'));
});

// ---------------------------------------------------------------- tenant isolation
test('each municipality sees and changes only its own schedule', async () => {
  assert.equal((await api('PATCH', `/solid-waste/collection/zones/${A.zone}`, { token: B.token, body: { name: 'Mine now' } })).status, 404);
  assert.equal((await api('PATCH', `/solid-waste/collection/streams/${A.trash}`, { token: B.token, body: { name: 'Mine now' } })).status, 404);
  assert.equal((await api('PUT', `/solid-waste/collection/zones/${B.zone}/streets`, { token: B.token, body: { streets: [{ street_id: A.streets['Main Street'] }] } })).status, 400);
  assert.equal((await api('PATCH', `/solid-waste/collection/zones/${B.zone}`, { token: B.token, body: { days: [{ stream_id: A.trash, weekday: 2 }] } })).status, 404);
  assert.equal((await api('POST', '/solid-waste/collection/changes', { token: B.token, body: { on_date: '2026-12-01', moved_to: null, zone_ids: [A.zone], reason: 'snow' } })).status, 404);
  const cal = ok(await api('GET', `/solid-waste/collection/calendar?zone_id=${A.zone}`, { token: B.token }));
  assert.deepEqual(cal.zones, []);
  assert.equal((await pub(B, `/year?zone=${A.zone}&year=2026`)).status, 404);
  assert.equal((await api('GET', `/solid-waste/collection/lookup?street_id=${A.streets['Main Street']}&house_number=1`, { token: B.token })).body.found, false);
  assert.deepEqual(ok(await api('GET', '/solid-waste/collection/streams', { token: B.token })).data.map((x) => x.id), [B.trash, B.rec]);
  assert.deepEqual(ok(await api('GET', '/solid-waste/collection/zones', { token: crew.token })).data.map((x) => x.id).sort(), [A.zone, A.zone2].sort());
  const setup = ok(await api('GET', '/solid-waste/collection/setup', { token: B.token }));
  assert.ok(!setup.zones.some((z) => z.id === A.zone));
  assert.ok(!setup.streams.some((s) => s.id === A.trash));
});
