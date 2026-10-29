'use strict';

// Ski school round 2, Track CORE: no double-booking (lessons and program meetings), availability from marked dates,
// the instructor picker and its hard problems, the coaching clash both ways, safety details only for the right people,
// the confirmation email, the private seat limit, attendance only on your own lessons, and level writes.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.BOOKING_RATE_LIMIT = '1000';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
process.env.MAIL_FROM = 'hello@summitops.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mailer = require('../src/lib/mailer');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base; let pm; const mails = [];
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const day = addDays(today, 3);

const DEVICE = 'test-device-0123456789abcdef'; // the app says which device signs in; leaving it out asks for an emailed code
async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'x-device': DEVICE, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const ok = (r, status = 200) => { assert.equal(r.status, status, r.text); return r.body; };
async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'x-device': DEVICE, 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  return { slug, owner: (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token };
}
async function addUser(m, email, role, extra = {}) {
  ok(await api('POST', '/users', { token: m.owner, body: { email, password: PW, role, ...extra } }), 201);
  return (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token;
}
async function instructor(m, first) {
  const id = ok(await api('POST', '/workforce/staff', { token: m.owner, body: { person: { first_name: first, last_name: 'Teach' }, status: 'active' } }), 201).id;
  const token = await addUser(m, `${first.toLowerCase()}@${m.slug}.test`, 'instructor', { staff_id: id });
  return { id, token };
}
const q = async (sql, params) => (await pool.query(sql, params))[0];

let A; let B; const T = {}; const D = {};

test.before(async () => {
  pm = http.createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { mails.push(JSON.parse(d)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m-${mails.length}` })); }); });
  await new Promise((r) => pm.listen(0, '127.0.0.1', r));
  mailer.settings.apiBase = `http://127.0.0.1:${pm.address().port}`;
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`lc-${suffix}`);
  B = await mountain(`lcb-${suffix}`);
  T.counter = await addUser(A, `counter@${A.slug}.test`, 'counter');
  T.manager = await addUser(A, `manager@${A.slug}.test`, 'manager');
  D.ivy = await instructor(A, 'Ivy');
  D.max = await instructor(A, 'Max');
  D.kim = await instructor(A, 'Kim');
  const prod = async (body) => ok(await api('POST', '/products', { token: A.owner, body }), 201).id;
  D.group = await prod({ kind: 'lesson', name: 'Kids Group', base_price_cents: 8000 });
  D.private = await prod({ kind: 'lesson', name: 'Private Lesson', base_price_cents: 20000 });
  D.cert = ok(await api('POST', '/workforce/certifications', { token: A.owner, body: { name: 'PSIA Children' } }), 201).id;
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => pm.close(r)); await pool.end(); });

const lesson = (extra = {}, start = '10:00', end = '12:00') => api('POST', '/skischool/sessions', { token: A.owner, body: { product_id: D.group, starts_at: `${day}T${start}`, ends_at: `${day}T${end}`, ...extra } });
const kid = (first, extra = {}) => ({ student: { first_name: first, last_name: 'Kidd', date_of_birth: '2017-02-02', ...extra }, sign_waiver: true });

test('lessons use the nine levels and ages, and say the range in words', async () => {
  const s = ok(await lesson({ level_min: 2, level_max: 3, age_min: 5, age_max: 8, meeting_place: 'Magic carpet' }), 201);
  D.a = s.id;
  const row = (await q('SELECT level_min, level_max, ability_level, age_group FROM lesson_sessions WHERE id = ?', [D.a]))[0];
  assert.deepEqual([row.level_min, row.level_max, row.ability_level, row.age_group], [2, 3, 'beginner', 'kids'], 'the old words follow the new fields');
  const list = ok(await api('GET', `/skischool/sessions?from=${day}&to=${day}`, { token: T.counter })).data;
  assert.equal(list.find((x) => x.id === D.a).level_words, 'Levels 2 to 3');
  // the old word still works for older screens
  const old = ok(await lesson({ ability_level: 'advanced' }, '13:00', '14:00'), 201);
  const r2 = (await q('SELECT level_min, level_max FROM lesson_sessions WHERE id = ?', [old.id]))[0];
  assert.deepEqual([r2.level_min, r2.level_max], [7, 9]);
  assert.equal((await lesson({ level_min: 5, level_max: 3 })).status, 400, 'lowest above highest');
});

test('a private is never a big group, and a private format keeps its seat limit', async () => {
  assert.equal((await lesson({ product_id: D.private, format: 'group' })).status, 400, 'a private product as a 60-seat group');
  assert.equal((await lesson({ product_id: D.private, format: 'private', capacity: 9 })).status, 400);
  ok(await lesson({ product_id: D.private, format: 'private' }, '14:00', '15:00'), 201);
});

test('double-booking is refused, for another lesson and for a program meeting', async () => {
  const b = ok(await api('POST', `/skischool/sessions/${D.a}/bookings`, { token: T.counter, body: kid('Maya') }), 201);
  D.maya = b.person_id; D.mayaBooking = b.id;
  const other = ok(await lesson({ level_min: 2, level_max: 4 }, '11:00', '13:00'), 201).id;
  D.other = other;
  const clash = await api('POST', `/skischool/sessions/${other}/bookings`, { token: T.counter, body: { person_id: D.maya } });
  assert.equal(clash.status, 409);
  assert.match(clash.body.error || clash.text, /Already booked in Kids Group at 10:00 AM/);
  // a program meeting at the same time
  const prog = ok(await api('POST', '/programs', { token: A.owner, body: { name: 'Sunday Club', season: '2026-27' } }), 201).id;
  D.prog = prog;
  ok(await api('POST', `/programs/${prog}/sessions`, { token: A.owner, body: { starts_at: `${day}T14:00`, ends_at: `${day}T16:00` } }), 201);
  ok(await api('POST', `/programs/${prog}/enrollments`, { token: A.owner, body: { person_id: D.maya } }), 201);
  const late = ok(await lesson({}, '15:00', '16:00'), 201).id;
  const r = await api('POST', `/skischool/sessions/${late}/bookings`, { token: T.counter, body: { person_id: D.maya } });
  assert.equal(r.status, 409);
  assert.match(r.text, /Already in Sunday Club at 2:00 PM/);
});

test('availability: someone who marked open dates only is available only on those dates', async () => {
  const d2 = addDays(day, 1);
  ok(await api('PUT', `/skischool/instructors/${D.kim.id}/profile`, { token: T.manager, body: { disciplines: ['ski', 'snowboard'], ski_level_max: 9, snowboard_level_max: 9, teaches_kids: true, teaches_adaptive: false, psia_level: 'none' } }), 200);
  ok(await api('POST', '/availability/windows', { token: D.kim.token, body: { dates: [d2], start_time: '09:00', end_time: '16:00' } }), 201);
  const s = ok(await lesson({}, '09:00', '10:00'), 201).id; // on `day`, not a date Kim marked
  const fit = ok(await api('GET', `/skischool/sessions/${s}/eligible-instructors`, { token: T.manager })).data;
  const kim = fit.find((x) => x.id === D.kim.id);
  assert.ok(kim.problems.includes('Outside their availability'), JSON.stringify(kim));
  // No teaching profile yet: not cleared for everything, a soft "Not set up" a manager can assign anyway.
  const bare = fit.find((x) => x.id === D.max.id);
  assert.deepEqual(bare.problems, ['Not set up: set what they teach'], JSON.stringify(bare));
  assert.equal(bare.ok, false); assert.equal(bare.not_set_up, true);
  const anyway = ok(await api('PATCH', `/skischool/sessions/${s}/instructor`, { token: T.manager, body: { instructor_id: D.max.id } }));
  assert.ok(anyway, 'a manager can still assign someone not set up');
  ok(await api('PATCH', `/skischool/sessions/${s}/instructor`, { token: T.manager, body: { instructor_id: null } }));
  ok(await api('PUT', `/skischool/instructors/${D.max.id}/profile`, { token: T.manager, body: { disciplines: ['ski', 'snowboard'], ski_level_max: 9, snowboard_level_max: 9, teaches_kids: true, teaches_adaptive: false, psia_level: 'none' } }), 200);
  const fit2 = ok(await api('GET', `/skischool/sessions/${s}/eligible-instructors`, { token: T.manager })).data;
  assert.equal(fit2.find((x) => x.id === D.max.id).ok, true, 'Max said nothing about dates, so he can work any time');
  const onDate = ok(await api('POST', '/skischool/sessions', { token: A.owner, body: { product_id: D.group, starts_at: `${d2}T09:00`, ends_at: `${d2}T10:00` } }), 201).id;
  assert.equal(ok(await api('GET', `/skischool/sessions/${onDate}/eligible-instructors`, { token: T.manager })).data.find((x) => x.id === D.kim.id).ok, true);
});

test('the picker lists only people who teach, best fit first, and hard problems need "assign anyway" with a reason', async () => {
  // a plain staff member who does not teach is not listed
  ok(await api('POST', '/workforce/staff', { token: A.owner, body: { person: { first_name: 'Lift', last_name: 'Op' }, status: 'active' } }), 201);
  ok(await api('PUT', `/skischool/instructors/${D.max.id}/profile`, { token: T.manager, body: { disciplines: ['ski'], ski_level_max: 2, snowboard_level_max: null, teaches_kids: true, teaches_adaptive: false, psia_level: 'level1' } }), 200);
  ok(await api('PUT', `/skischool/instructors/${D.ivy.id}/profile`, { token: T.manager, body: { disciplines: ['ski', 'snowboard'], ski_level_max: 9, snowboard_level_max: 6, teaches_kids: true, teaches_adaptive: false, psia_level: 'level2' } }), 200);
  const s = ok(await lesson({ level_min: 3, level_max: 4, age_max: 10, required_certification_id: D.cert }, '12:30', '13:30'), 201).id;
  let fit = ok(await api('GET', `/skischool/sessions/${s}/eligible-instructors`, { token: T.manager })).data;
  assert.ok(!fit.some((x) => x.name === 'Lift Op'), 'only staff who teach');
  const max = fit.find((x) => x.id === D.max.id);
  assert.ok(max.problems.some((p) => /Cleared to level 2/.test(p)), JSON.stringify(max));
  assert.ok(max.problems.some((p) => /PSIA Children/.test(p)));
  // Ivy holds the certification and is cleared: first in the list
  ok(await api('PUT', `/workforce/staff/${D.ivy.id}/certifications`, { token: A.owner, body: { certification_id: D.cert } }), 200);
  fit = ok(await api('GET', `/skischool/sessions/${s}/eligible-instructors`, { token: T.manager })).data;
  assert.equal(fit[0].id, D.ivy.id);
  assert.equal(fit[0].ok, true);
  const no = await api('PATCH', `/skischool/sessions/${s}/instructor`, { token: T.manager, body: { instructor_id: D.max.id } });
  assert.equal(no.status, 409, 'not cleared and missing the certification');
  ok(await api('PATCH', `/skischool/sessions/${s}/instructor`, { token: T.manager, body: { instructor_id: D.max.id, override_reason: 'Shadowing Ivy today' } }));
  const audit = await q("SELECT detail FROM audit_log WHERE action = 'assign_anyway' AND entity_id = ? ORDER BY id DESC LIMIT 1", [s]);
  assert.match(JSON.stringify(audit[0].detail), /Shadowing Ivy/);
  assert.equal((await api('PATCH', `/skischool/sessions/${s}/instructor`, { token: T.counter, body: { instructor_id: D.ivy.id } })).status, 403);
  // counter staff see the instructor's name on the lesson list
  const list = ok(await api('GET', `/skischool/sessions?from=${day}&to=${day}`, { token: T.counter })).data;
  assert.equal(list.find((x) => x.id === s).instructor_name, 'Max Teach');
});

test('coaching a program meeting and teaching a lesson cannot overlap, both ways', async () => {
  // Kim coaches a meeting at 14:00 to 16:00
  const kimDay = addDays(day, 1);
  ok(await api('POST', `/programs/${D.prog}/sessions`, { token: A.owner, body: { starts_at: `${kimDay}T13:00`, ends_at: `${kimDay}T15:00`, coach_staff_id: D.kim.id } }), 201);
  const s = ok(await api('POST', '/skischool/sessions', { token: A.owner, body: { product_id: D.group, starts_at: `${kimDay}T14:00`, ends_at: `${kimDay}T15:30` } }), 201).id;
  const r = await api('PATCH', `/skischool/sessions/${s}/instructor`, { token: T.manager, body: { instructor_id: D.kim.id } });
  assert.equal(r.status, 409);
  assert.match(r.text, /Coaching Sunday Club/);
  // the other way: Ivy teaches a lesson, then cannot be named coach of a meeting then
  ok(await api('PATCH', `/skischool/sessions/${D.a}/instructor`, { token: T.manager, body: { instructor_id: D.ivy.id } }));
  const m = await api('POST', `/programs/${D.prog}/sessions`, { token: A.owner, body: { starts_at: `${day}T10:30`, ends_at: `${day}T11:30`, coach_staff_id: D.ivy.id } });
  assert.equal(m.status, 409);
  assert.match(m.text, /Teaching a lesson/);
});

test('safety details are saved, prefilled next time, and shown only to the desk, managers and the lesson instructor', async () => {
  const b = ok(await api('POST', `/skischool/sessions/${D.a}/bookings`, { token: T.counter, body: { ...kid('Leo', { email: 'parent.leo@x.test' }), allergies: 'Peanuts', medical: 'Asthma, inhaler in pocket', pickup: 'Dad (Sam)', contact_name: 'Sam Kidd', contact_phone: '555-0100', contact_email: 'sam.kidd@x.test', photo_ok: true, send_confirmation: false } }), 201);
  D.leo = b.person_id; D.leoBooking = b.id;
  assert.equal(b.confirmation, null, 'no confirmation when unticked');
  const row = (await q('SELECT allergies, medical, pickup, contact_phone, photo_ok FROM lesson_bookings WHERE id = ?', [b.id]))[0];
  assert.deepEqual([row.allergies, row.medical, row.pickup, row.contact_phone, row.photo_ok], ['Peanuts', 'Asthma, inhaler in pocket', 'Dad (Sam)', '555-0100', 1]);
  const pre = ok(await api('GET', `/skischool/students/${D.leo}/safety`, { token: T.counter }));
  assert.equal(pre.allergies, 'Peanuts'); assert.equal(pre.contact_email, 'sam.kidd@x.test');
  assert.equal((await api('GET', `/skischool/students/${D.leo}/safety`, { token: D.max.token })).status, 403);
  // Ivy teaches lesson A: she sees the details; Max does not
  const mine = ok(await api('GET', `/skischool/sessions/${D.a}/roster`, { token: D.ivy.token }));
  assert.equal(mine.details, true);
  assert.equal(mine.data.find((x) => x.person_id === D.leo).allergies, 'Peanuts');
  const theirs = ok(await api('GET', `/skischool/sessions/${D.a}/roster`, { token: D.max.token }));
  const leo = theirs.data.find((x) => x.person_id === D.leo);
  assert.equal(leo.allergies, undefined); assert.equal(leo.medical, undefined); assert.equal(leo.contact_phone, undefined);
  assert.equal(leo.has_allergies, true, 'the flag shows, the words do not');
  const desk = ok(await api('GET', `/skischool/sessions/${D.a}/roster`, { token: T.counter }));
  assert.equal(desk.data.find((x) => x.person_id === D.leo).medical, 'Asthma, inhaler in pocket');
  const board = ok(await api('GET', `/skischool/board?date=${day}`, { token: D.max.token }));
  assert.equal(board.sessions.find((s) => s.id === D.a).students.find((x) => x.person_id === D.leo).allergies, undefined);
  // never in the audit log
  ok(await api('PATCH', `/skischool/bookings/${b.id}/safety`, { token: D.ivy.token, body: { allergies: 'Peanuts, tree nuts' } }));
  assert.equal((await api('PATCH', `/skischool/bookings/${b.id}/safety`, { token: D.max.token, body: { allergies: 'x' } })).status, 403);
  const logs = await q('SELECT detail FROM audit_log WHERE tenant_id = (SELECT id FROM tenants WHERE slug = ?)', [A.slug]);
  assert.ok(logs.length > 5);
  assert.ok(!logs.some((l) => /Peanuts|Asthma/.test(JSON.stringify(l.detail))), 'children\'s details never in the audit log');
});

test('the confirmation email has the lesson, the meeting place, what to bring, the family link and the policy', async () => {
  ok(await api('PATCH', '/skischool/settings', { token: T.manager, body: { what_to_bring: 'Helmet, goggles and a snack.' } }));
  const before = mails.length;
  const b = ok(await api('POST', `/skischool/sessions/${D.a}/bookings`, { token: T.counter, body: { ...kid('Zoe'), contact_email: 'zoe.parent@x.test', contact_name: 'Pat Kidd' } }), 201);
  assert.equal(b.confirmation.ok, true, JSON.stringify(b.confirmation));
  const mail = mails.slice(before).find((m) => m.To === 'zoe.parent@x.test');
  assert.ok(mail, 'sent to the contact email');
  assert.match(mail.TextBody, /Zoe is booked in Kids Group/);
  assert.match(mail.TextBody, /Meet at: Magic carpet/);
  assert.match(mail.TextBody, /Helmet, goggles and a snack/);
  assert.match(mail.TextBody, new RegExp(`/lesson/${A.slug}/[A-Za-z0-9_-]{32,}`));
  assert.match(mail.TextBody, /Cancel at least/);
  assert.ok(!/Peanuts|Asthma/.test(mail.TextBody));
  assert.ok((await q('SELECT confirmed_at, token_sha FROM lesson_bookings WHERE id = ?', [b.id]))[0].confirmed_at);
  // resend from the roster; turned off by the school, the counter booking sends none but Resend still works
  ok(await api('PATCH', '/skischool/settings', { token: T.manager, body: { confirm_email: false } }));
  const n = mails.length;
  ok(await api('POST', `/skischool/sessions/${D.a}/bookings`, { token: T.counter, body: { ...kid('Ava'), contact_email: 'ava.parent@x.test' } }), 201);
  assert.equal(mails.length, n, 'off: none sent');
  ok(await api('POST', `/skischool/bookings/${b.id}/confirmation`, { token: T.counter }));
  assert.equal(mails.length, n + 1);
  assert.equal((await api('POST', `/skischool/bookings/${b.id}/confirmation`, { token: D.ivy.token })).status, 403);
  ok(await api('PATCH', '/skischool/settings', { token: T.manager, body: { confirm_email: true } }));
});

test('attendance: an instructor marks only their own lessons, all present in one tap', async () => {
  const r = await api('PATCH', `/skischool/bookings/${D.leoBooking}`, { token: D.max.token, body: { status: 'attended' } });
  assert.equal(r.status, 403, 'not their lesson');
  assert.equal((await api('POST', `/skischool/sessions/${D.a}/all-present`, { token: D.max.token })).status, 403);
  ok(await api('PATCH', `/skischool/bookings/${D.leoBooking}`, { token: D.ivy.token, body: { status: 'no_show' } }));
  assert.equal((await api('PATCH', `/skischool/bookings/${D.leoBooking}`, { token: D.ivy.token, body: { status: 'cancelled' } })).status, 403, 'instructors do not cancel bookings');
  const all = ok(await api('POST', `/skischool/sessions/${D.a}/all-present`, { token: D.ivy.token }));
  assert.ok(all.marked >= 2);
  const st = await q("SELECT status FROM lesson_bookings WHERE session_id = ? AND status <> 'cancelled'", [D.a]);
  assert.ok(st.every((x) => x.status !== 'booked'));
  assert.equal(st.filter((x) => x.status === 'no_show').length, 1, 'all present leaves a no-show alone');
  // program attendance: only the coach
  const meeting = (await q('SELECT id FROM program_sessions WHERE program_id = ? AND coach_staff_id = ? LIMIT 1', [D.prog, D.kim.id]))[0].id;
  assert.equal((await api('PUT', `/programs/sessions/${meeting}/attendance`, { token: D.ivy.token, body: { marks: [{ person_id: D.maya, present: true }] } })).status, 403);
  ok(await api('PUT', `/programs/sessions/${meeting}/attendance`, { token: D.kim.token, body: { marks: [{ person_id: D.maya, present: true }] } }));
});

test('My day: my lessons and program meetings in time order, with the roster and details; nobody else\'s', async () => {
  const mine = ok(await api('GET', `/skischool/my-day?date=${day}`, { token: D.ivy.token }));
  const a = mine.items.find((x) => x.kind === 'lesson' && x.id === D.a);
  assert.ok(a, JSON.stringify(mine.items.map((x) => x.id)));
  assert.equal(a.level_words, 'Levels 2 to 3');
  const leo = a.students.find((x) => x.person_id === D.leo);
  assert.match(leo.allergies, /Peanuts/); assert.equal(leo.phone, '555-0100'); assert.equal(leo.age, Number(day.slice(0, 4)) - 2017 - (day.slice(5) < '02-02' ? 1 : 0));
  const kimDay = addDays(day, 1);
  const kim = ok(await api('GET', `/skischool/my-day?date=${kimDay}`, { token: D.kim.token }));
  const meeting = kim.items.find((x) => x.kind === 'program');
  assert.ok(meeting, 'the meeting Kim coaches');
  assert.ok(meeting.students.some((x) => x.person_id === D.maya));
  assert.equal((await api('GET', `/skischool/my-day?date=${day}&staff_id=${D.ivy.id}`, { token: D.max.token })).status, 403);
  ok(await api('GET', `/skischool/my-day?date=${day}&staff_id=${D.ivy.id}`, { token: T.manager }));
  const sched = ok(await api('GET', '/skischool/my-schedule', { token: D.ivy.token })).data;
  assert.ok(sched.some((x) => x.id === D.a));
});

test('levels: passing a level on the report card writes the guest\'s level, and the card opens on their discipline', async () => {
  ok(await api('POST', '/skischool/progress', { token: D.ivy.token, body: { person_id: D.leo, discipline: 'ski', level: 3, notes: 'Passed level 2' } }), 201);
  const p = (await q('SELECT ski_level, level_source FROM people WHERE id = ?', [D.leo]))[0];
  assert.deepEqual([p.ski_level, p.level_source], [3, 'instructor']);
  const card = ok(await api('GET', `/skischool/students/${D.leo}/card?discipline=ski`, { token: D.ivy.token }));
  assert.equal(card.focus, 'ski');
  const ski = card.disciplines.find((d) => d.discipline === 'ski');
  assert.equal(ski.current_level, 3);
  assert.equal(ski.levels.length, 9);
  assert.equal(ski.levels[2].name, 'Wedge turns');
  const lv = ok(await api('GET', '/skischool/levels', { token: T.manager })).data;
  assert.equal(lv.filter((l) => l.discipline === 'snowboard').length, 9);
});

test('another mountain sees none of it', async () => {
  assert.equal((await api('GET', `/skischool/sessions/${D.a}/roster`, { token: B.owner })).status, 404);
  assert.equal((await api('POST', `/skischool/bookings/${D.leoBooking}/confirmation`, { token: B.owner })).status, 404);
  assert.equal((await api('GET', `/skischool/students/${D.leo}/safety`, { token: B.owner })).status, 404);
});
