'use strict';

// Ski school round 2, Track LINEUP: check-in (the family's link and the desk), labels, the lineup board with its
// suggested split, moving a student, and the window (guest types that follow the person, the different-day warning,
// safety details on a lesson line, the receipt).
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.BOOKING_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const mailer = require('../src/lib/mailer');
const links = require('../src/lib/lessonlinks');
const LL = require('../src/lib/lessonlineup');
const GT = require('../src/lib/guesttypes');

let server; let base; let pm;
const mails = [];
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const TZ = 'America/New_York';
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const nowLocal = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:00`; };
const today = nowLocal().slice(0, 10);
const day2 = addDays(today, 2);
const day3 = addDays(today, 3);

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const api = call;
async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  return { slug, owner: (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token };
}
async function addUser(m, email, role, extra = {}) {
  assert.equal((await api('POST', '/users', { token: m.owner, body: { email, password: PW, role, ...extra } })).status, 201);
  return (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token;
}
const q = async (sql, params) => (await pool.query(sql, params))[0];
const ADULT = { date_of_birth: '1985-03-02', sex: 'female' };

let A; let B; let tidA; const T = {}; const D = {};

/** An instructor: a staff member with an instructor profile (cleared to a ski level, kids or not). */
async function instructor(first, { max = 9, kids = 1, email = null } = {}) {
  const st = await api('POST', '/workforce/staff', { token: A.owner, body: { person: { first_name: first, last_name: 'Teach', ...(email ? { email } : {}) }, status: 'active' } });
  assert.equal(st.status, 201, st.text);
  await q('INSERT INTO instructor_profiles (tenant_id, staff_id, disciplines, ski_level_max, teaches_kids) VALUES (?, ?, ?, ?, ?)', [tidA, st.body.id, 'ski', max, kids]);
  return st.body.id;
}
const session = async (extra = {}) => {
  const r = await api('POST', '/skischool/sessions', { token: A.owner, body: { product_id: D.group, starts_at: `${day2}T10:00`, ends_at: `${day2}T12:00`, capacity: 20, ...extra } });
  assert.equal(r.status, 201, r.text);
  return r.body.id;
};
/** Books a child into a lesson at the counter (with a waiver) and sets their level. */
async function bookKid(sessionId, first, level, { dob = '2016-05-01' } = {}) {
  const r = await api('POST', `/skischool/sessions/${sessionId}/bookings`, { token: T.counter, body: { student: { first_name: first, last_name: `Kid${suffix}`, date_of_birth: dob, sex: 'male' }, sign_waiver: true } });
  assert.equal(r.status, 201, r.text);
  if (level) await q('UPDATE people SET ski_level = ? WHERE id = ?', [level, r.body.person_id]);
  return r.body;
}

test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  pm = http.createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { mails.push(JSON.parse(d)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m-${mails.length}` })); }); });
  await new Promise((r) => pm.listen(0, r));
  mailer.settings.apiBase = `http://127.0.0.1:${pm.address().port}`;
  A = await mountain(`ll-a-${suffix}`);
  B = await mountain(`ll-b-${suffix}`);
  tidA = (await q('SELECT id FROM tenants WHERE slug = ?', [A.slug]))[0].id;
  await q('UPDATE tenants SET timezone = ? WHERE id = ?', [TZ, tidA]);
  T.counter = await addUser(A, `counter@${A.slug}.test`, 'counter');
  T.manager = await addUser(A, `manager@${A.slug}.test`, 'manager');
  T.counterB = await addUser(B, `counter@${B.slug}.test`, 'counter');
  // email on only after signing in (a new device would otherwise be asked for an emailed code)
  process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
  process.env.MAIL_FROM = 'hello@summitops.test';
  const prod = async (body) => (await api('POST', '/products', { token: A.owner, body })).body.id;
  D.group = await prod({ kind: 'lesson', name: 'Kids Group', base_price_cents: 8000 });
  D.ticket = await prod({ kind: 'day_ticket', name: 'Day', base_price_cents: 9000 });
  D.rental = await prod({ kind: 'rental', name: 'Ski package', base_price_cents: 4000 });
  for (const [p, cents] of [[D.group, 6000], [D.ticket, 5000], [D.rental, 2500]]) {
    await q("INSERT INTO price_tiers (tenant_id, product_id, tier, price_cents) VALUES (?, ?, 'child', ?)", [tidA, p, cents]);
  }
});
test.after(async () => { server.close(); pm.close(); await pool.end(); });

// ---------------------------------------------------------------- check-in
test('the family checks in by link only on the lesson day, from 90 minutes before the start, with the right token', async () => {
  const now = nowLocal();
  const start = now.slice(11, 16) < '00:10' ? `${today} 00:00` : `${today} ${LL.plusMinutes(now, -10).slice(11, 16)}`;
  const sid = await session({ starts_at: start.replace(' ', 'T'), ends_at: `${today}T23:59` });
  const kid = await bookKid(sid, 'Maya', 3);
  const token = await links.issue(pool, tidA, kid.id);
  // a lesson two days out: not yet
  const later = await bookKid(await session({ starts_at: `${day3}T10:00`, ends_at: `${day3}T12:00` }), 'Noah', 2);
  const laterToken = await links.issue(pool, tidA, later.id);
  const early = await call('POST', `/public/${A.slug}/lesson/${laterToken}/here`);
  assert.equal(early.status, 409, early.text);
  assert.match(early.body.error || early.text, /90 minutes/);
  // a wrong token, and a right token on another mountain's address
  assert.equal((await call('POST', `/public/${A.slug}/lesson/${'x'.repeat(40)}/here`)).status, 404);
  assert.equal((await call('POST', `/public/${B.slug}/lesson/${token}/here`)).status, 404);
  const ok = await call('POST', `/public/${A.slug}/lesson/${token}/here`);
  assert.equal(ok.status, 200, ok.text);
  const [row] = await q('SELECT checked_in_at, checked_in_via FROM lesson_bookings WHERE id = ?', [kid.id]);
  assert.ok(row.checked_in_at);
  assert.equal(row.checked_in_via, 'link');
  assert.equal((await call('POST', `/public/${A.slug}/lesson/${token}/here`)).body.already, true);
  // the school can turn the link off
  assert.equal((await api('PATCH', '/skischool/settings', { token: T.manager, body: { checkin_link: false } })).status, 200);
  const off = await bookKid(sid, 'Ola', 1);
  const offToken = await links.issue(pool, tidA, off.id);
  assert.equal((await call('POST', `/public/${A.slug}/lesson/${offToken}/here`)).status, 409);
  await api('PATCH', '/skischool/settings', { token: T.manager, body: { checkin_link: true } });
  D.todaySession = sid; D.offBooking = off;
});

test('the desk checks students in from the list, a search and a scan, and sees a missing waiver or unpaid', async () => {
  const list = await api('GET', `/skischool/checkin?date=${today}`, { token: T.counter });
  assert.equal(list.status, 200, list.text);
  const ola = list.body.data.find((r) => r.booking_id === D.offBooking.id);
  assert.ok(ola, 'today\'s students are listed');
  assert.equal(ola.checked_in_at, null);
  assert.equal(ola.waiver_ok, true);
  assert.equal(ola.code, `L${D.offBooking.id}`);
  // search by name
  const found = await api('GET', `/skischool/checkin?date=${today}&q=Ola`, { token: T.counter });
  assert.ok(found.body.data.every((r) => r.first_name === 'Ola'));
  // a scan of the confirmation code checks in
  const scan = await api('POST', '/skischool/checkin/scan', { token: T.counter, body: { code: `l${D.offBooking.id}` } });
  assert.equal(scan.status, 200, scan.text);
  assert.ok(scan.body.data[0].checked_in_at);
  const [row] = await q('SELECT checked_in_via FROM lesson_bookings WHERE id = ?', [D.offBooking.id]);
  assert.equal(row.checked_in_via, 'desk');
  // undo
  assert.equal((await api('DELETE', `/skischool/bookings/${D.offBooking.id}/checkin`, { token: T.counter })).status, 200);
  assert.equal((await q('SELECT checked_in_at FROM lesson_bookings WHERE id = ?', [D.offBooking.id]))[0].checked_in_at, null);
  assert.equal((await api('POST', `/skischool/bookings/${D.offBooking.id}/checkin`, { token: T.counter })).status, 200);
  // a missing waiver shows (the waiver is withdrawn for this test) and an unpaid booking shows
  await q('UPDATE lesson_bookings SET unpaid = 1 WHERE id = ?', [D.offBooking.id]);
  const again = (await api('GET', `/skischool/checkin?date=${today}&q=L${D.offBooking.id}`, { token: T.counter })).body.data[0];
  assert.equal(again.unpaid, true);
  await q('UPDATE lesson_bookings SET unpaid = 0 WHERE id = ?', [D.offBooking.id]);
  // instructors and other mountains cannot use the desk
  assert.equal((await api('POST', '/skischool/checkin/scan', { token: T.counterB, body: { code: `L${D.offBooking.id}` } })).status, 404);
  // a code that is not a lesson
  assert.equal((await api('POST', '/skischool/checkin/scan', { token: T.counter, body: { code: 'HELLO' } })).status, 400);
});

// ---------------------------------------------------------------- the lineup and the split
test('the lineup board groups lessons, and the split respects ratio, level, kids, clearance and availability', async () => {
  await api('PATCH', '/skischool/settings', { token: T.manager, body: { ratio_kids: 3 } });
  D.big = await instructor('Ian', { max: 4, kids: 1, email: `ian@${A.slug}.test` });
  D.low = await instructor('Lou', { max: 2, kids: 1 });
  D.nokids = await instructor('Ned', { max: 9, kids: 0 });
  D.busy = await instructor('Bea', { max: 9, kids: 1 });
  // Bea teaches another lesson at the same time
  await session({ product_id: D.group, format: 'private', capacity: 1, instructor_id: D.busy, starts_at: `${day2}T09:30`, ends_at: `${day2}T11:00` });
  const sid = await session({ age_group: 'kids', meeting_place: 'Magic Carpet' });
  await q('UPDATE lesson_sessions SET age_min = 4, age_max = 12, level_min = 1, level_max = 4 WHERE id = ?', [sid]);
  const kids = [];
  for (const [name, lv] of [['Ava', 3], ['Ben', 1], ['Cal', 2], ['Dee', 1], ['Eli', 3], ['Fay', 1], ['Gus', 2], ['Hal', 4]]) kids.push(await bookKid(sid, name, lv));
  const day = await api('GET', `/skischool/lineups?date=${day2}`, { token: T.counter });
  assert.equal(day.status, 200, day.text);
  const lu = day.body.data.find((l) => l.age_group === 'kids');
  assert.ok(lu, 'the kids lessons are one lineup');
  assert.equal(Number(lu.students), 8);
  D.lineup = lu.id;
  const sug = await api('POST', `/skischool/lineups/${lu.id}/suggest`, { token: T.counter, body: { from: 'booked' } });
  assert.equal(sug.status, 200, sug.text);
  const cls = sug.body.classes;
  assert.equal(cls.length, 3, 'eight kids at three a class make three classes');
  assert.ok(cls.every((c) => c.students.length <= 3));
  assert.deepEqual(cls.map((c) => c.students.map((s) => s.level)), [[1, 1, 1], [2, 2, 3], [3, 4]], 'grouped by level');
  assert.equal(cls[0].session_id, sid, 'the lineup\'s own lesson is used first');
  assert.equal(cls[1].session_id, null);
  const used = cls.map((c) => c.instructor_id).filter(Boolean);
  assert.ok(!used.includes(D.nokids), 'kids classes only go to instructors who teach kids');
  assert.ok(!used.includes(D.busy), 'not someone teaching another lesson then');
  assert.equal(cls[2].instructor_id, D.big, 'the Level 4 class goes to the one cleared for it');
  assert.equal(cls[0].instructor_id, D.low, 'the least cleared instructor who fits takes the first-timers');
  assert.ok(cls[1].needs_instructor, 'no third instructor fits, so the class says it needs one');
  // checked in only: nobody is checked in yet
  const none = await api('POST', `/skischool/lineups/${lu.id}/suggest`, { token: T.counter, body: { from: 'checked_in' } });
  assert.equal(none.body.classes.length, 0);
  assert.equal(none.body.left_out.length, 8);
  // the counter cannot apply a split; a manager can
  const body = { classes: cls.map((c) => ({ session_id: c.session_id, booking_ids: c.students.map((s) => s.booking_id), instructor_id: c.instructor_id || null, level_min: c.level_min, level_max: c.level_max })) };
  assert.equal((await api('POST', `/skischool/lineups/${lu.id}/apply`, { token: T.counter, body })).status, 403);
  const before = await q('SELECT id FROM lesson_bookings WHERE session_id = ? ORDER BY id', [sid]);
  const applied = await api('POST', `/skischool/lineups/${lu.id}/apply`, { token: T.manager, body });
  assert.equal(applied.status, 200, applied.text);
  assert.equal(applied.body.board.classes.length, 3);
  const split = await q("SELECT id, origin, level_min, level_max, instructor_id, lineup_id, meeting_place FROM lesson_sessions WHERE lineup_id = ? AND origin = 'split'", [lu.id]);
  assert.equal(split.length, 2, 'two new lessons were made');
  assert.ok(split.every((s) => s.meeting_place === 'Magic Carpet'));
  const after = await q('SELECT id, session_id, moved_from_session_id FROM lesson_bookings WHERE id IN (?) ORDER BY id', [before.map((b) => b.id)]);
  assert.deepEqual(after.map((b) => b.id), before.map((b) => b.id), 'the same booking rows, moved');
  assert.equal(after.filter((b) => b.moved_from_session_id === sid).length, 5);
  assert.equal((await q("SELECT status FROM lesson_lineups WHERE id = ?", [lu.id]))[0].status, 'split');
  D.classes = applied.body.board.classes;
  D.kids = kids;
});

test('moving a student keeps the booking row, refuses a clash and a full class, and tells the family and the instructor', async () => {
  const [low, mid, high] = D.classes; // levels 1, 2 to 3, 3 to 4
  const maya = mid.students[0];
  // a counter move into a class with room: the family and the new instructor are told
  const mailsBefore = mails.length;
  await q('UPDATE lesson_bookings SET contact_email = ? WHERE id = ?', [`family${suffix}@example.com`, maya.booking_id]);
  const mv = await api('POST', `/skischool/bookings/${maya.booking_id}/move`, { token: T.counter, body: { session_id: high.id } });
  assert.equal(mv.status, 200, mv.text);
  const row = (await q('SELECT session_id, moved_from_session_id, moved_at FROM lesson_bookings WHERE id = ?', [maya.booking_id]))[0];
  assert.equal(row.session_id, high.id);
  assert.equal(row.moved_from_session_id, mid.id);
  assert.ok(row.moved_at);
  const fam = mails.slice(mailsBefore).find((m) => m.To === `family${suffix}@example.com`);
  assert.ok(fam, 'the family got an email');
  assert.match(fam.TextBody, new RegExp(`${maya.first_name} moved to Ian's group, Levels? .*meeting at Magic Carpet`));
  assert.ok(mails.slice(mailsBefore).some((m) => m.To === `ian@${A.slug}.test`), 'the new instructor got an email');
  // the high class now holds 3 of 3: full for the counter
  await q('UPDATE lesson_sessions SET capacity = 3 WHERE id = ?', [high.id]);
  const other = low.students[0];
  const full = await api('POST', `/skischool/bookings/${other.booking_id}/move`, { token: T.counter, body: { session_id: high.id } });
  assert.equal(full.status, 409);
  const noReason = await api('POST', `/skischool/bookings/${other.booking_id}/move`, { token: T.manager, body: { session_id: high.id } });
  assert.equal(noReason.status, 409);
  const over = await api('POST', `/skischool/bookings/${other.booking_id}/move`, { token: T.manager, body: { session_id: high.id, reason: 'Sister in this group' } });
  assert.equal(over.status, 200, over.text);
  assert.equal(over.body.over_by_one, true);
  assert.equal((await q('SELECT capacity FROM lesson_sessions WHERE id = ?', [high.id]))[0].capacity, 4);
  // a clash: the student is in another lesson that overlaps the target class
  const clashLesson = await session({ product_id: D.group, starts_at: `${day2}T11:00`, ends_at: `${day2}T13:00`, discipline: 'snowboard' });
  const k = low.students[1];
  // (booking it through the counter is refused now: it overlaps the class the student is in, so it is put on file directly)
  const r = await api('POST', `/skischool/sessions/${clashLesson}/bookings`, { token: T.counter, body: { person_id: k.person_id } });
  assert.equal(r.status, 409, 'the counter refuses a booking that overlaps the class the student is in');
  await q("INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status) VALUES (?, ?, ?, 'booked')", [tidA, clashLesson, k.person_id]);
  const clash = await api('POST', `/skischool/bookings/${k.booking_id}/move`, { token: T.manager, body: { session_id: high.id, reason: 'testing a clash' } });
  assert.equal(clash.status, 409);
  assert.match(clash.body.error || clash.text, /Already booked in Kids Group/);
  // another day is not a move
  const tomorrow = await session({ starts_at: `${day3}T10:00`, ends_at: `${day3}T12:00` });
  assert.equal((await api('POST', `/skischool/bookings/${k.booking_id}/move`, { token: T.manager, body: { session_id: tomorrow } })).status, 400);
  // move options list the other classes of the time with spots left
  const opts = await api('GET', `/skischool/bookings/${k.booking_id}/move-options`, { token: T.counter });
  assert.equal(opts.status, 200);
  assert.ok(opts.body.data.some((s) => s.id === mid.id));
  // other mountains cannot move it
  assert.equal((await api('POST', `/skischool/bookings/${k.booking_id}/move`, { token: T.counterB, body: { session_id: mid.id } })).status, 404);
});

test('labels carry first name, last initial, level, color, an allergy mark, the instructor and meeting place, and the code', async () => {
  const k = D.classes[0].students[1];
  await q("UPDATE lesson_bookings SET allergies = 'Peanuts' WHERE id = ?", [k.booking_id]);
  const r = await api('GET', `/skischool/labels?lineup_id=${D.lineup}`, { token: T.counter });
  assert.equal(r.status, 200, r.text);
  const lab = r.body.data.find((x) => x.booking_id === k.booking_id);
  assert.equal(lab.first_name, k.first_name);
  assert.equal(lab.last_initial, 'K');
  assert.equal(lab.allergy, true);
  assert.ok(!JSON.stringify(r.body).includes('Peanuts'), 'the label never prints the allergy itself');
  assert.equal(lab.code, `L${k.booking_id}`);
  assert.equal(lab.meeting_place, 'Magic Carpet');
  assert.ok(['Red', 'Blue', 'Green'].includes(lab.color));
  assert.ok(lab.level_words.startsWith('Level '));
});

// ---------------------------------------------------------------- the window
test('a guest type follows the person: a child on the lesson is a child on the rental and the ticket', async () => {
  const lesson = await session({ starts_at: `${day2}T13:00`, ends_at: `${day2}T15:00` });
  const body = (lines, extra = {}) => ({
    channel: 'window', follow_types: true,
    customer: { details: { first_name: 'Pat', last_name: `Parent${suffix}`, ...ADULT, email: `pat${suffix}@example.com` }, sign_waiver: true },
    participants: { p1: { details: { first_name: 'Kit', last_name: `Parent${suffix}`, date_of_birth: '2017-02-02', sex: 'male' }, sign_waiver: true, guardian: 'customer' } },
    lines, payments: [], ...extra,
  });
  const lines = [
    { type: 'lesson', session_id: lesson, tier: 'child', participant: 'p1', safety: { allergies: 'Bee stings', pickup: 'Pat or Grandma Jo', contact_phone: '555-0100', text_ok: true, photo_ok: false } },
    { type: 'rental', product_id: D.rental, tier: 'adult', participant: 'p1' },
    { type: 'ticket', product_id: D.ticket, tier: 'adult', quantity: 2, valid_on: day2, holders: ['customer', 'p1'] },
  ];
  const chk = await api('POST', '/checkout/check', { token: T.counter, body: body(lines) });
  assert.equal(chk.status, 200, chk.text);
  // lesson 60 (child) + rental 25 (child) + adult ticket 90 + child ticket 50
  assert.equal(chk.body.total_cents, 6000 + 2500 + 9000 + 5000, JSON.stringify(chk.body.lines));
  assert.ok(chk.body.type_changes.some((c) => c.line === 'rental' && c.to === 'child'));
  const sold = await api('POST', '/checkout', { token: T.counter, body: body(lines, { payments: [{ tender: 'cash', amount_cents: chk.body.total_cents }] }) });
  assert.equal(sold.status, 201, sold.text);
  const items = await q('SELECT line_kind, tier, unit_price_cents FROM order_items WHERE order_id = ? ORDER BY id', [sold.body.id]);
  assert.ok(items.find((i) => i.line_kind === 'rental').tier === 'child');
  // the lesson line's safety details are on the booking
  const bk = (await q('SELECT allergies, pickup, contact_phone, text_ok, photo_ok FROM lesson_bookings WHERE id = ?', [sold.body.lessons[0].booking_id]))[0];
  assert.deepEqual({ ...bk }, { allergies: 'Bee stings', pickup: 'Pat or Grandma Jo', contact_phone: '555-0100', text_ok: 1, photo_ok: 0 });
  // the receipt names the student, the lesson, the time and the meeting place
  assert.equal(sold.body.lessons[0].student, `Kit Parent${suffix}`);
  const rc = await api('GET', `/orders/${sold.body.id}/receipt`, { token: T.counter });
  assert.equal(rc.status, 200);
  assert.equal(rc.body.lessons.length, 1);
  assert.equal(rc.body.lessons[0].first_name, 'Kit');
  assert.equal(rc.body.lessons[0].product, 'Kids Group');
  assert.ok(rc.body.lessons[0].starts_at.startsWith(day2));
  D.kitOrder = sold.body.id;
  // the scan of the receipt (ORD-) checks in lessons on that order only on their day
  const sc = await api('POST', '/skischool/checkin/scan', { token: T.counter, body: { code: `ORD-${sold.body.id}` } });
  assert.equal(sc.status, 404, 'the lesson is not today');
  // the clash rule holds at the window: Kit cannot be sold another lesson at the same time
  const lesson2 = await session({ starts_at: `${day2}T14:00`, ends_at: `${day2}T15:30` });
  const kitId = sold.body.lessons[0].person_id;
  const again = await api('POST', '/checkout/check', { token: T.counter, body: { channel: 'window', customer: { person_id: kitId }, lines: [{ type: 'lesson', session_id: lesson2 }] } });
  assert.equal(again.status, 409, again.text);
});

test('followPerson: a date of birth sets the type, a type picked on purpose is kept, shared ticket lines split by holder', async () => {
  const body = {
    customer: { details: { first_name: 'A', last_name: 'B', date_of_birth: '1980-01-01' } },
    participants: { k: { details: { first_name: 'C', last_name: 'D', date_of_birth: '2018-01-01' } }, m: { details: { first_name: 'E', last_name: 'F', date_of_birth: '1990-01-01' } } },
    lines: [
      { type: 'ticket', product_id: 1, tier: 'adult', quantity: 3, holders: ['customer', 'k', 'm'] },
      { type: 'rental', product_id: 2, tier: 'adult', participant: 'k' },
      { type: 'rental', product_id: 2, tier: 'military', participant: 'm' },
    ],
  };
  const changes = await GT.followPerson(pool, tidA, body, today);
  const tickets = body.lines.filter((l) => l.type === 'ticket');
  assert.deepEqual(tickets.map((t) => [t.tier, t.quantity, t.holders]).sort(), [['adult', 1, ['customer']], ['child', 1, ['k']], ['military', 1, ['m']]].sort());
  assert.equal(body.lines.find((l) => l.participant === 'k').tier, 'child');
  assert.equal(body.lines.find((l) => l.participant === 'm').tier, 'military');
  assert.ok(changes.length >= 2);
});

test('the basket warns, never refuses, when the lesson and the lift ticket are for different days', async () => {
  const lesson = await session({ starts_at: `${day2}T09:00`, ends_at: `${day2}T09:45` });
  const wrong = await api('POST', '/checkout/quote', { token: T.counter, body: { lines: [{ type: 'lesson', session_id: lesson }, { type: 'ticket', product_id: D.ticket, valid_on: today }] } });
  assert.equal(wrong.status, 200, wrong.text);
  assert.equal(wrong.body.warnings.length, 1);
  assert.match(wrong.body.warnings[0], /The lesson is on .*, but the lift ticket is for /);
  const right = await api('POST', '/checkout/quote', { token: T.counter, body: { lines: [{ type: 'lesson', session_id: lesson }, { type: 'ticket', product_id: D.ticket, valid_on: day2 }] } });
  assert.equal(right.body.warnings.length, 0);
});

test('the window lists lessons with level range, ages, instructor first name and whether they started', async () => {
  const menu = await api('GET', '/checkout/menu', { token: T.counter });
  assert.equal(menu.status, 200);
  const l = menu.body.lessons.find((x) => x.id === D.classes[2].id);
  assert.ok(l, menu.text.slice(0, 300));
  assert.equal(l.instructor_first, 'Ian');
  assert.match(l.level_words, /^Levels? \d/);
  assert.equal(l.age_words, 'Ages 4 to 12');
  assert.equal(l.started, false);
  const started = menu.body.lessons.find((x) => x.id === D.todaySession);
  assert.equal(started.started, true);
});
