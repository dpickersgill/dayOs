'use strict';

// Lesson planning, best of breed (2026.11.9), Track GUEST: pools on the booking page, the next times with room when a
// lesson is full, the three placement questions (the booking page, Sell, the director's own wording) feeding the
// lineup's split, private hours from the season plan (closed days, lengths, hours, how many at once, re-checked when the
// request is made) and "confirm automatically when an instructor is free". Pools and private-hour rows are inserted here
// directly (Track PLAN makes them in the real flow).
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.BOOKING_RATE_LIMIT = '1000';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
process.env.MAIL_FROM = 'hello@summitops.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mailer = require('../src/lib/mailer');
const modules = require('../src/lib/modules');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const P = require('../src/lib/placement');

let server; let base; let pmMock; const mails = []; let n = 0;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const DEVICE = 'test-device-0123456789abcdef';
const q = async (sql, params) => (await pool.query(sql, params))[0];
const plus = (d, k) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const year = Number(today.slice(0, 4));
const D1 = plus(today, 3); const D2 = plus(today, 4); const D3 = plus(today, 5); const D4 = plus(today, 6);

async function call(prefix, method, path, { token, body } = {}) {
  const res = await fetch(`${base}${prefix}${path}`, { method, headers: { 'x-device': DEVICE, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const api = (m, p, o) => call('/api/v1', m, p, o);
const ok = (r, s) => { assert.ok(r.status < 300, `${r.status} ${r.text}`); if (s) assert.equal(r.status, s, r.text); return r.body; };
const is = (r, s, why) => assert.equal(r.status, s, `${why || ''} ${r.text}`);

const M = {}; const T = {}; const D = {};
let pub;
test.before(async () => {
  pmMock = http.createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { mails.push(JSON.parse(d)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m-${++n}` })); }); });
  await new Promise((r) => pmMock.listen(0, '127.0.0.1', r));
  mailer.settings.apiBase = `http://127.0.0.1:${pmMock.address().port}`;
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const slug = `lg-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Guest Peak', phone: '215-555-0000', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  M.slug = slug; M.id = (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id;
  await q('INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE enabled = 1', [M.id, 'school']);
  modules.invalidate(M.id);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  T.owner = await login(`owner@${slug}.test`);
  const staff = async (first, last) => ok(await api('POST', '/workforce/staff', { token: T.owner, body: { person: { first_name: first, last_name: last, email: `${first.toLowerCase()}.${suffix}@x.test` }, status: 'active' } }), 201).id;
  D.ivy = await staff('Ivy', 'Instructor'); D.max = await staff('Max', 'Other');
  const user = async (email, role, extra = {}) => { ok(await api('POST', '/users', { token: T.owner, body: { email, password: PW, role, ...extra } }), 201); return login(email); };
  T.ivy = await user(`ivy@${slug}.test`, 'instructor', { staff_id: D.ivy });
  T.desk = await user(`desk@${slug}.test`, 'counter');
  const prod = async (body) => ok(await api('POST', '/products', { token: T.owner, body })).id;
  D.kids = await prod({ kind: 'lesson', name: 'Kids Ski Group', base_price_cents: 9000 });
  D.adult = await prod({ kind: 'lesson', name: 'Adult Group', base_price_cents: 8000 });
  D.private = await prod({ kind: 'lesson', name: 'Private Lesson', base_price_cents: 14000 });
  ok(await api('PUT', '/tenant/profile', { token: T.owner, body: { online_booking: true, waiver_text: 'I accept the risks of skiing.', booking_notice_hours: 1 } }));
  // Ivy and Max teach ski and snowboard (kids too), are listed publicly and are open on D1 to D3 from 9 to 4.
  for (const sid of [D.ivy, D.max]) {
    await q("INSERT INTO instructor_profiles (tenant_id, staff_id, is_public, display_name, disciplines, ski_level_max, snowboard_level_max, teaches_kids) VALUES (?, ?, 1, NULL, 'ski,snowboard', ?, 9, 1)", [M.id, sid, sid === D.ivy ? 9 : 6]);
    for (const d of [D1, D2, D3]) await q("INSERT INTO instructor_open (tenant_id, staff_id, open_date, start_time, end_time) VALUES (?, ?, ?, '09:00', '16:00')", [M.id, sid, d]);
  }
  D.offer60 = ok(await api('POST', '/skischool/pay/private-offers', { token: T.owner, body: { product_id: D.private, minutes: 60, max_students: 2 } }), 201).id;
  D.offer120 = ok(await api('POST', '/skischool/pay/private-offers', { token: T.owner, body: { product_id: D.private, minutes: 120, max_students: 2 } }), 201).id;
  pub = (m, p, o) => call('/api/v1/public', m, `/${slug}${p}`, o);
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => pmMock.close(r)); await pool.end(); });

/** A lesson through the staff route; pool: true turns it into a plan-made pool (kind pool, no level range). */
async function lesson(product, day, from, to, { pool: isPool = false, ...extra } = {}) {
  const id = ok(await api('POST', '/skischool/sessions', { token: T.owner, body: { product_id: product, starts_at: `${day}T${from}`, ends_at: `${day}T${to}`, ...extra } }), 201).id;
  if (isPool) await q("UPDATE lesson_sessions SET kind = 'pool', level_min = NULL, level_max = NULL WHERE id = ?", [id]);
  return id;
}
let kid = 0;
async function book(sessionId) {
  kid += 1;
  return ok(await api('POST', `/skischool/sessions/${sessionId}/bookings`, { token: T.desk, body: { student: { first_name: `Kid${kid}`, last_name: `Guest${suffix}`, date_of_birth: `${year - 9}-02-02`, sex: 'female' }, sign_waiver: true } }), 201);
}
const contact = (k) => ({ contact_first_name: 'Pat', contact_last_name: `Parent${k}`, contact_email: `pat.${k}.${suffix}@x.test`, contact_phone: '215-555-0101' });

// ---------------------------------------------------------------- placement, the library
test('placement: three questions per discipline lead to a PSIA level; the last question must end on a level', () => {
  const qs = P.BUILT_IN;
  assert.equal(qs.ski.length, 3); assert.equal(qs.snowboard.length, 3);
  assert.equal(P.levelFor(qs, 'ski', [false]), 1, 'never skied: level 1');
  assert.equal(P.levelFor(qs, 'ski', [true, false]), 2);
  assert.equal(P.levelFor(qs, 'ski', [true, true, false]), 4);
  assert.equal(P.levelFor(qs, 'ski', [true, true, true]), 6);
  assert.equal(P.levelFor(qs, 'ski', [true]), null, 'more answers needed');
  assert.equal(P.levelFor(qs, 'telemark', [false]), null, 'telemark has no questions');
  const placed = P.place(qs, 'snowboard', [true, true, false]);
  assert.equal(placed.placement_level, 4);
  assert.match(placed.placement_answers, /Have you snowboarded before\? Yes \| Can you link turns on a green trail\? Yes \| .* No/);
  assert.equal(P.place(qs, 'ski', [false, true]).placement_answers, 'Have you skied before? No', 'only the questions asked are kept');
  assert.match(P.describe(4, 'ski').can, /my skis start to match/);
  const bad = { ski: [...qs.ski.slice(0, 2), { text: 'Last one here?', yes: null, no: 3 }], snowboard: qs.snowboard };
  assert.equal(P.schema.safeParse({ questions: bad }).success, false);
  assert.equal(P.schema.safeParse({ questions: qs }).success, true);
  assert.equal(P.schema.safeParse({ questions: null }).success, true);
});

test('the director edits the placement questions; everyone who sells reads them; an instructor cannot change them', async () => {
  const got = ok(await api('GET', '/skischool/placement', { token: T.desk }));
  assert.equal(got.custom, false);
  assert.deepEqual(got.questions, P.BUILT_IN);
  const mine = { ski: [{ text: 'Ever been on skis?', yes: null, no: 1 }, { text: 'Can you ride the chairlift alone?', yes: null, no: 3 }, { text: 'Do you ski black trails?', yes: 8, no: 5 }], snowboard: P.BUILT_IN.snowboard };
  is(await api('PUT', '/skischool/placement', { token: T.ivy, body: { questions: mine } }), 403, 'an instructor cannot');
  is(await api('PUT', '/skischool/placement', { token: T.owner, body: { questions: { ...mine, ski: mine.ski.slice(0, 2) } } }), 400, 'three questions');
  const saved = ok(await api('PUT', '/skischool/placement', { token: T.owner, body: { questions: mine } }));
  assert.equal(saved.custom, true);
  assert.equal(saved.questions.ski[2].yes, 8);
  const page = ok(await pub('GET', '/booking'));
  assert.equal(page.placement.ski[0].text, 'Ever been on skis?', 'the booking page asks the director\'s questions');
  assert.ok((await q("SELECT id FROM audit_log WHERE tenant_id = ? AND entity = 'school_settings'", [M.id])).length >= 1, 'audited');
  ok(await api('PUT', '/skischool/placement', { token: T.owner, body: { questions: null } }));
  assert.equal(ok(await api('GET', '/skischool/placement', { token: T.owner })).custom, false, 'back to the built-in questions');
});

// ---------------------------------------------------------------- pools and full times on the booking page
test('a pool reads as a time on the booking page and fits every level; a full lesson shows the next times with room', async () => {
  const p930 = await lesson(D.kids, D1, '09:30', '11:30', { pool: true, age_min: 7, age_max: 12, capacity: 1 });
  const p1300 = await lesson(D.kids, D1, '13:00', '15:00', { pool: true, age_min: 7, age_max: 12, capacity: 14 });
  const next1 = await lesson(D.kids, D2, '09:30', '11:30', { pool: true, age_min: 7, age_max: 12, capacity: 14 });
  const other = await lesson(D.kids, D1, '10:00', '12:00', { pool: true, age_min: 4, age_max: 6, capacity: 10 }); // another age band
  const adult = await lesson(D.adult, D1, '10:00', '12:00', { age_min: 18, capacity: 6, level_min: 4, level_max: 6 });
  const far = await lesson(D.kids, plus(D1, 9), '09:30', '11:30', { pool: true, age_min: 7, age_max: 12, capacity: 14 }); // after the next 7 days
  await book(p930);
  const page = ok(await pub('GET', '/booking'));
  const pool1300 = page.lessons.find((l) => l.id === p1300);
  assert.equal(pool1300.pool, true);
  assert.equal(pool1300.level_min, null); assert.equal(pool1300.level_words, 'All levels', 'a pool fits every level');
  assert.equal(pool1300.spots_left, 14);
  assert.equal(page.lessons.find((l) => l.id === adult).pool, false, 'a set class is not a pool');
  assert.ok(page.full.some((l) => l.id === p930 && l.waitlist), 'the full pool offers its waitlist');
  assert.ok(!page.lessons.some((l) => l.id === p930));
  const nx = ok(await pub('GET', `/booking/next/${p930}`));
  assert.equal(nx.full, true); assert.equal(nx.waitlist, true);
  assert.deepEqual(nx.next.map((l) => l.id), [p1300, next1], 'the same day first, then the next days; same product and ages only');
  assert.ok(!nx.next.some((l) => [other, adult, far].includes(l.id)));
  assert.equal(nx.next[0].spots_left, 14);
  // A lesson with room still answers (nothing noted as full).
  assert.equal(ok(await pub('GET', `/booking/next/${p1300}`)).full, false);
  is(await pub('GET', '/booking/next/999999999'), 404);
  D.pool1300 = p1300;
});

// ---------------------------------------------------------------- placement through a booking, Sell and the lineup
test('placement answers on the booking page are saved on the booking and the lineup\'s split uses them', async () => {
  const items = [
    { session_id: D.pool1300, student: { first_name: 'Ava', last_name: `Place${suffix}`, date_of_birth: `${year - 9}-05-05`, sex: 'female', discipline: 'ski', placement: [true, true, true] } },
    { session_id: D.pool1300, student: { first_name: 'Ben', last_name: `Place${suffix}`, date_of_birth: `${year - 8}-05-05`, sex: 'male', discipline: 'ski', placement: [false] } },
  ];
  const out = ok(await pub('POST', '/lesson-basket', { body: { ...contact('a'), items, waiver_accepted: true } }), 201);
  assert.equal(out.requests.length, 1);
  const raw = (await q('SELECT id, students FROM lesson_requests WHERE tenant_id = ? AND reference = ?', [M.id, out.requests[0].reference]))[0];
  const st = JSON.parse(raw.students).students;
  assert.equal(st[0].placement_level, 6); assert.equal(st[1].placement_level, 1);
  assert.equal(st[0].placement, undefined, 'the raw answers are not kept, only the questions as asked');
  ok(await api('POST', `/skischool/requests/${raw.id}/confirm`, { token: T.owner }));
  const bks = await q('SELECT p.first_name, b.placement_level, b.placement_answers, b.level FROM lesson_bookings b JOIN people p ON p.id = b.person_id WHERE b.tenant_id = ? AND b.session_id = ? ORDER BY p.first_name', [M.id, D.pool1300]);
  const ava = bks.find((b) => b.first_name === 'Ava'); const ben = bks.find((b) => b.first_name === 'Ben');
  assert.equal(ava.placement_level, 6); assert.equal(ben.placement_level, 1);
  assert.match(ava.placement_answers, /Can you make parallel turns on a blue trail\? Yes/);
  assert.equal(ava.level, null, 'placement is kept apart from the level an instructor sets');
  // Sell: "Ask 3 questions" at the window.
  ok(await api('POST', '/checkout', { token: T.desk, body: { channel: 'window', customer: { details: { first_name: 'Dee', last_name: `Place${suffix}`, date_of_birth: `${year - 40}-03-02`, sex: 'female', email: `dee.${suffix}@x.test` }, sign_waiver: true },
    participants: { cal: { details: { first_name: 'Cal', last_name: `Place${suffix}`, date_of_birth: `${year - 10}-03-02`, sex: 'male' }, sign_waiver: true, guardian: 'customer' } },
    lines: [{ type: 'lesson', session_id: D.pool1300, participant: 'cal', safety: { pickup: 'Mom', placement: [true, true, false] } }], payments: [{ tender: 'cash', amount_cents: 9000 }] } }));
  const cal = (await q("SELECT b.placement_level FROM lesson_bookings b JOIN people p ON p.id = b.person_id WHERE b.tenant_id = ? AND b.session_id = ? AND p.first_name = 'Cal'", [M.id, D.pool1300]))[0];
  assert.equal(cal.placement_level, 4);
  // The lineup board shows it and the suggested split sorts by it: Ben (1), Cal (4), Ava (6).
  const day = ok(await api('GET', `/skischool/lineups?date=${D1}`, { token: T.desk }));
  const lu = day.data.find((l) => String(l.starts_at).slice(11, 16) === '13:00');
  const board = ok(await api('GET', `/skischool/lineups/${lu.id}`, { token: T.desk }));
  const kids = board.classes.flatMap((c) => c.students);
  assert.equal(kids.find((s) => s.first_name === 'Ava').placement_level, 6);
  ok(await api('PATCH', `/skischool/lineups/${lu.id}`, { token: T.owner, body: { ratio: 1 } }));
  const sug = ok(await api('POST', `/skischool/lineups/${lu.id}/suggest`, { token: T.desk, body: { from: 'booked' } }));
  const order = sug.classes.map((c) => c.students.map((s) => s.first_name).join(','));
  assert.deepEqual(order, ['Ben', 'Cal', 'Ava'], 'lowest placement first');
  assert.deepEqual(sug.classes.map((c) => c.level_max), [1, 4, 6]);
});

// ---------------------------------------------------------------- private hours
test('private hours: nothing on a closed day, only the lengths offered, only inside the hours, no more at once than allowed', async () => {
  const times = async (date, offer, instructor = 'any') => ok(await pub('GET', `/private/times?date=${date}&offer_id=${offer}&instructor=${instructor}&discipline=ski&level=3`));
  // No row: as before, any open time.
  assert.ok((await times(D1, D.offer60)).times.length > 10);
  await q("INSERT INTO lesson_private_hours (tenant_id, on_date, start_time, end_time, at_once, lengths, closed) VALUES (?, ?, '09:00', '16:00', NULL, '60,120', 1)", [M.id, D2]);
  await q("INSERT INTO lesson_private_hours (tenant_id, on_date, start_time, end_time, at_once, lengths, closed) VALUES (?, ?, '10:00', '13:00', 1, '60', 0)", [M.id, D3]);
  const closed = await times(D2, D.offer60);
  assert.equal(closed.times.length, 0); assert.equal(closed.hours.closed, true);
  assert.match(closed.note, /not offered on this day/);
  assert.ok(!closed.open_days.includes(D2), 'a closed day is not pointed at');
  const long = await times(D3, D.offer120);
  assert.equal(long.times.length, 0, 'two hours is not sold that day');
  assert.match(long.note, /2 hours privates are not offered on this day\. This day offers 1 hour/);
  assert.ok(!long.open_days.includes(D3));
  const d3 = await times(D3, D.offer60);
  assert.deepEqual(d3.times.map((t) => t.time), ['10:00', '10:30', '11:00', '11:30', '12:00'], 'inside 10:00 to 1:00 only');
  assert.deepEqual(d3.hours, { start: '10:00', end: '13:00', lengths: [60], closed: false });
  // A private already made at 11:00 (at the window): one at once, so 10:30 to 11:30 are gone.
  await lesson(D.private, D3, '11:00', '12:00', { format: 'private', capacity: 1 });
  assert.deepEqual((await times(D3, D.offer60)).times.map((t) => t.time), ['10:00', '12:00']);
  // The server checks again when the request is made.
  const ask = (body) => pub('POST', '/private', { body: { offer_id: D.offer60, discipline: 'ski', instructor: 'any', ...contact(`h${++kid}`), students: [{ first_name: 'Hal', last_name: `Hours${suffix}`, date_of_birth: `${year - 30}-01-01`, sex: 'male', level: 3 }], waiver_accepted: true, ...body } });
  assert.match((await ask({ date: D3, time: '11:30' })).body.error, /just taken/);
  assert.match((await ask({ date: D3, time: '09:00' })).body.error, /run from 10:00 AM to 1:00 PM/);
  assert.match((await ask({ date: D2, time: '10:00' })).body.error, /not offered on this day/);
  assert.match((await ask({ date: D3, time: '10:00', offer_id: D.offer120 })).body.error, /not offered on this day/);
  const made = ok(await ask({ date: D3, time: '12:00' }), 201);
  assert.equal(made.status, 'waiting');
  assert.ok(!(await times(D3, D.offer60)).times.some((t) => t.time === '12:00'), 'a waiting request holds its place');
});

// ---------------------------------------------------------------- confirm automatically
test('confirm automatically: booked at once with the named instructor or the best free one; otherwise the instructor accepts', async () => {
  const ask = (body) => pub('POST', '/private', { body: { offer_id: D.offer60, discipline: 'ski', date: D1, ...contact(`c${++kid}`), students: [{ first_name: 'Kim', last_name: `Auto${kid}${suffix}`, date_of_birth: `${year - 9}-01-01`, sex: 'female', level: 3 }], waiver_accepted: true, ...body } });
  // The default: the instructor accepts.
  let r = ok(await ask({ instructor: D.ivy, time: '09:00' }), 201);
  assert.equal(r.status, 'waiting');
  ok(await api('PATCH', '/skischool/settings', { token: T.owner, body: { private_confirm: 'auto' } }));
  assert.equal(ok(await api('GET', '/skischool/settings', { token: T.owner })).private_confirm, 'auto');
  // Named: Ivy is free at 13:00, so it is booked with her straight away.
  mails.length = 0;
  r = ok(await ask({ instructor: D.ivy, time: '13:00' }), 201);
  assert.equal(r.status, 'accepted');
  const row = (await q('SELECT * FROM private_requests WHERE tenant_id = ? AND reference = ?', [M.id, r.reference]))[0];
  assert.equal(row.status, 'accepted'); assert.equal(row.staff_id, D.ivy);
  const s = (await q('SELECT * FROM lesson_sessions WHERE id = ?', [row.session_id]))[0];
  assert.equal(s.instructor_id, D.ivy); assert.equal(s.format, 'private'); assert.equal(s.origin, 'request');
  assert.equal((await q("SELECT COUNT(*) AS n FROM lesson_bookings WHERE session_id = ? AND status = 'booked'", [s.id]))[0].n, 1, 'the student is booked');
  assert.ok((await q("SELECT id FROM audit_log WHERE tenant_id = ? AND action = 'private_auto_confirm' AND entity_id = ?", [M.id, row.id])).length, 'audited');
  assert.ok(!mails.some((m) => /Private lesson request/.test(m.Subject || '')), 'no instructor is asked');
  assert.equal(ok(await pub('GET', `/private/r/${r.token}`)).status, 'accepted');
  // Any instructor: Ivy now teaches at 13:00, so Max (free, cleared) gets the 13:00 one.
  r = ok(await ask({ instructor: 'any', time: '13:00' }), 201);
  assert.equal(r.status, 'accepted');
  assert.equal((await q('SELECT staff_id FROM private_requests WHERE tenant_id = ? AND reference = ?', [M.id, r.reference]))[0].staff_id, D.max);
  // Any instructor at 10:00 with both free and one lesson each that day: the one cleared least far above it (Max, up to level 6).
  r = ok(await ask({ instructor: 'any', time: '10:00' }), 201);
  assert.equal((await q('SELECT staff_id FROM private_requests WHERE tenant_id = ? AND reference = ?', [M.id, r.reference]))[0].staff_id, D.max);
  // A level 8 student: only Ivy is cleared, and she is free at 15:00.
  r = ok(await ask({ instructor: 'any', time: '15:00', students: [{ first_name: 'Lee', last_name: `Auto${suffix}`, date_of_birth: `${year - 30}-01-01`, sex: 'male', level: 8 }] }), 201);
  assert.equal((await q('SELECT staff_id FROM private_requests WHERE tenant_id = ? AND reference = ?', [M.id, r.reference]))[0].staff_id, D.ivy);
  ok(await api('PATCH', '/skischool/settings', { token: T.owner, body: { private_confirm: 'accept' } }));
});

test('confirm automatically never books an instructor who is not free: the request waits instead', async () => {
  ok(await api('PATCH', '/skischool/settings', { token: T.owner, body: { private_confirm: 'auto' } }));
  // Max gets a group lesson at 14:00 after the time was shown; Ivy is not cleared for snowboard here.
  await q("UPDATE instructor_profiles SET disciplines = 'ski' WHERE tenant_id = ? AND staff_id = ?", [M.id, D.ivy]);
  const PR = require('../src/lib/lessonprivate');
  const [ins] = await pool.query(`INSERT INTO private_requests (tenant_id, reference, token_sha, status, source, staff_id, any_instructor, offer_id, product_id, discipline, starts_at, minutes, students, contact_name, contact_email, contact_phone, waiver_accepted, amount_cents, pay_at_desk)
    VALUES (?, ?, ?, 'waiting', 'public', NULL, 1, ?, ?, 'snowboard', ?, 60, ?, 'Pat Parent', ?, '215-555-0101', 1, 14000, 1)`,
  [M.id, 'AUTOBUSY', PR.sha(`t-${suffix}`), D.offer60, D.private, `${D2} 14:00:00`, JSON.stringify({ contact: { first_name: 'Pat', last_name: 'Parent' }, students: [{ first_name: 'Sam', last_name: `Busy${suffix}`, date_of_birth: `${year - 30}-01-01`, sex: 'male', level: 3 }] }), `pat.busy.${suffix}@x.test`]);
  await lesson(D.adult, D2, '14:00', '15:00', { instructor_id: D.max });
  const out = await PR.afterWaiting(M.id, ins.insertId);
  assert.equal(out.auto, false);
  assert.equal((await q('SELECT status FROM private_requests WHERE id = ?', [ins.insertId]))[0].status, 'waiting', 'left for an instructor to accept');
  await q("UPDATE instructor_profiles SET disciplines = 'ski,snowboard' WHERE tenant_id = ? AND staff_id = ?", [M.id, D.ivy]);
  ok(await api('PATCH', '/skischool/settings', { token: T.owner, body: { private_confirm: 'accept' } }));
});

// ---------------------------------------------------------------- review fixes (2026.11.9)
test('confirm automatically books one instructor once when two requests for the same time are confirmed together', async () => {
  ok(await api('PATCH', '/skischool/settings', { token: T.owner, body: { private_confirm: 'auto' } }));
  const PR = require('../src/lib/lessonprivate');
  // Two families paid for "any instructor" at the same time for a level 8 skier: only Ivy is cleared (Max teaches up to 6).
  // Three rounds, as the race is about timing.
  for (const time of ['11:00', '12:00', '13:00']) {
    const at = `${D2} ${time}:00`;
    const ids = [];
    for (const k of [1, 2]) {
      const [ins] = await pool.query(`INSERT INTO private_requests (tenant_id, reference, token_sha, status, source, staff_id, any_instructor, offer_id, product_id, discipline, starts_at, minutes, students, contact_name, contact_email, contact_phone, waiver_accepted, amount_cents, pay_at_desk)
        VALUES (?, ?, ?, 'waiting', 'public', NULL, 1, ?, ?, 'ski', ?, 60, ?, 'Pat Parent', ?, '215-555-0101', 1, 14000, 1)`,
      [M.id, PR.reference(), PR.sha(`race-${time}-${k}-${suffix}`), D.offer60, D.private, at, JSON.stringify({ contact: { first_name: 'Pat', last_name: `Race${k}` }, students: [{ first_name: `Rae${k}`, last_name: `Race${suffix}`, date_of_birth: `${year - 30}-01-01`, sex: 'female', level: 8 }] }), `pat.race${k}.${suffix}@x.test`]);
      ids.push(ins.insertId);
    }
    const out = await Promise.all(ids.map((id) => PR.afterWaiting(M.id, id)));
    assert.deepEqual(out.map((o) => o.auto).sort(), [false, true], `${time}: one booked, the other waits for an instructor`);
    const n = (await q("SELECT COUNT(*) AS n FROM lesson_sessions WHERE tenant_id = ? AND instructor_id = ? AND format = 'private' AND status <> 'cancelled' AND starts_at = ?", [M.id, D.ivy, at]))[0].n;
    assert.equal(Number(n), 1, `Ivy holds one private at ${time}`);
    assert.deepEqual((await q('SELECT status FROM private_requests WHERE id IN (?)', [ids])).map((r) => r.status).sort(), ['accepted', 'waiting']);
  }
  ok(await api('PATCH', '/skischool/settings', { token: T.owner, body: { private_confirm: 'accept' } }));
});

test('next times: only a lesson guests can book here; a full one is noted once per visitor per day; its own rate limit', async () => {
  const far = await lesson(D.kids, plus(today, 50), '09:30', '11:30', { pool: true, age_min: 7, age_max: 12, capacity: 8 });
  is(await pub('GET', `/booking/next/${far}`), 404, 'not on the booking page, so not "full"');
  const noted = async (id) => Number((await q('SELECT COUNT(*) AS n FROM lesson_full_searches WHERE tenant_id = ? AND session_id = ?', [M.id, id]))[0].n);
  assert.equal(await noted(far), 0);
  const full = await lesson(D.kids, D4, '09:30', '11:30', { pool: true, age_min: 7, age_max: 12, capacity: 1 });
  await book(full);
  for (let i = 0; i < 3; i += 1) assert.equal(ok(await pub('GET', `/booking/next/${full}`)).full, true);
  assert.equal(await noted(full), 1, 'one visitor, one search');
  const shas = await q('SELECT visitor_sha FROM lesson_full_searches WHERE tenant_id = ? AND session_id = ?', [M.id, full]);
  assert.match(shas[0].visitor_sha, /^[0-9a-f]{64}$/, 'a hash, never the address');
  let status = 200; let tries = 0;
  while (status !== 429 && tries < 40) { status = (await pub('GET', `/booking/next/${full}`)).status; tries += 1; }
  assert.equal(status, 429, 'a script soon hits the limit');
});
