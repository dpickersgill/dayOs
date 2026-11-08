'use strict';

// Ski school safety (feat/school-safety): ages enforced at the desk and online, the lineup split keeps assigned
// instructors and is not offered for nobody, one level scale, pickup with authorized adults, lost child tied to patrol
// dispatch, ratios by age band, adaptive intake, live updates, where the groups are, and who may see each of these.
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
const SS = require('../src/lib/schoolsafety');
const SSR = require('../src/routes/schoolsafety');

let server; let base; let pm;
const mails = [];
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const TZ = 'America/New_York';
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const nowLocal = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:00`; };
const minus = (dt, m) => new Date(Date.parse(`${dt.replace(' ', 'T')}Z`) - m * 60000).toISOString().slice(0, 16);
const today = nowLocal().slice(0, 10);
const day2 = addDays(today, 2);
const PHOTO = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString('base64')}`;

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const ok = (r, status = 200) => { assert.equal(r.status, status, r.text); return r.body; };
const q = async (sql, params) => (await pool.query(sql, params))[0];
let A; let tid; const T = {}; const D = {};

async function addUser(email, role, extra = {}) {
  ok(await call('POST', '/users', { token: A.owner, body: { email, password: PW, role, ...extra } }), 201);
  return (await call('POST', '/auth/login', { body: { tenant: A.slug, email, password: PW } })).body.token;
}
async function instructor(first, { max = 9, kids = 1, adaptive = 0 } = {}) {
  const st = ok(await call('POST', '/workforce/staff', { token: A.owner, body: { person: { first_name: first, last_name: 'Teach' }, status: 'active' } }), 201);
  await q('INSERT INTO instructor_profiles (tenant_id, staff_id, disciplines, ski_level_max, teaches_kids, teaches_adaptive) VALUES (?, ?, ?, ?, ?, ?)', [tid, st.id, 'ski,adaptive', max, kids, adaptive]);
  return st.id;
}
const session = async (extra = {}) => ok(await call('POST', '/skischool/sessions', { token: A.owner, body: { product_id: D.group, starts_at: `${day2}T10:00`, ends_at: `${day2}T12:00`, capacity: 20, ...extra } }), 201).id;
const book = async (sid, first, dob, extra = {}, token = T.counter) => call('POST', `/skischool/sessions/${sid}/bookings`, { token, body: { student: { first_name: first, last_name: `Fam${suffix}`, date_of_birth: dob, sex: 'female' }, sign_waiver: true, send_confirmation: false, ...extra } });
const KID = '2018-04-04'; // 8 on day2
const SMALL = '2021-01-10'; // 5 or 6
const ADULT = '1980-02-02';

test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  pm = http.createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { mails.push(JSON.parse(d)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m-${mails.length}` })); }); });
  await new Promise((r) => pm.listen(0, r));
  mailer.settings.apiBase = `http://127.0.0.1:${pm.address().port}`;
  const slug = `ss-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  A = { slug, owner: (await call('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token };
  tid = (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id;
  await q('UPDATE tenants SET timezone = ? WHERE id = ?', [TZ, tid]);
  T.counter = await addUser(`counter@${slug}.test`, 'counter');
  D.ian = await instructor('Ian');
  D.ola = await instructor('Ola');
  D.ada = await instructor('Ada', { adaptive: 1 });
  T.ian = await addUser(`ian@${slug}.test`, 'instructor', { staff_id: D.ian });
  T.ola = await addUser(`ola@${slug}.test`, 'instructor', { staff_id: D.ola });
  T.ada = await addUser(`ada@${slug}.test`, 'instructor', { staff_id: D.ada });
  const pst = ok(await call('POST', '/workforce/staff', { token: A.owner, body: { person: { first_name: 'Pat', last_name: 'Rol' }, status: 'active' } }), 201);
  T.patrol = await addUser(`patrol@${slug}.test`, 'patrol', { staff_id: pst.id });
  // email on only after signing in (a new device would otherwise be asked for an emailed code)
  process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
  process.env.MAIL_FROM = 'hello@summitops.test';
  D.group = ok(await call('POST', '/products', { token: A.owner, body: { kind: 'lesson', name: 'Group lesson', base_price_cents: 8000 } }), 201).id;
});
test.after(async () => { server.close(); pm.close(); await pool.end(); });

// ---------------------------------------------------------------- 1. ages
test('ages: the desk is warned about an adult in a kids lesson; a manager books anyway with a reason (audited); the counter cannot', async () => {
  const sid = await session({ age_min: 5, age_max: 12 });
  const warn = await book(sid, 'Adult', ADULT);
  assert.equal(warn.status, 409, warn.text);
  assert.equal(warn.body.details.needs_override, true);
  assert.match(warn.body.error, /is \d+, and this lesson is for ages 5 to 12/);
  // the counter cannot override; the student record was saved, nothing booked
  const pid = warn.body.details.person_id;
  const counter = await call('POST', `/skischool/sessions/${sid}/bookings`, { token: T.counter, body: { person_id: pid, sign_waiver: true, override_reason: 'Parent asked', send_confirmation: false } });
  assert.equal(counter.status, 403, counter.text);
  assert.equal((await q('SELECT COUNT(*) AS n FROM lesson_bookings WHERE session_id = ?', [sid]))[0].n, 0);
  // the owner (a manager) gives a reason
  const yes = ok(await call('POST', `/skischool/sessions/${sid}/bookings`, { token: A.owner, body: { person_id: pid, sign_waiver: true, override_reason: 'Assisting a child in the class', send_confirmation: false } }), 201);
  const [b] = await q('SELECT override_reason FROM lesson_bookings WHERE id = ?', [yes.id]);
  assert.equal(b.override_reason, 'Assisting a child in the class');
  const [a] = await q("SELECT detail FROM audit_log WHERE tenant_id = ? AND action = 'age_override' ORDER BY id DESC LIMIT 1", [tid]);
  assert.match(JSON.stringify(a.detail), /Assisting a child/);
  // a child in range books with no warning
  ok(await book(sid, 'Kid', KID), 201);
});

test('online: the family\'s pickup list and an adaptive intake go on the booking when the request is confirmed', async () => {
  ok(await call('PUT', '/tenant/profile', { token: A.owner, body: { online_booking: true, waiver_text: 'I accept the risks.', booking_notice_hours: 1 } }));
  const sid = await session({ discipline: 'adaptive', format: 'semi_private', capacity: 2, starts_at: `${day2}T14:00`, ends_at: `${day2}T15:00` });
  const r = ok(await call('POST', `/public/${A.slug}/requests`, { body: { session_id: sid, contact_first_name: 'Pat', contact_last_name: 'Online', contact_email: `po.${suffix}@x.test`, contact_phone: '215-555-0100',
    students: [{ first_name: 'Ona', last_name: 'Line', date_of_birth: KID, sex: 'female', pickup_adults: [{ name: 'Pat Online', relationship: 'Mom', phone: '215-555-0100' }], adaptive: { needs: 'Autism', equipment: ['tethers'] } }], waiver_accepted: true } }), 201);
  const req = (await q('SELECT id FROM lesson_requests WHERE reference = ?', [r.reference]))[0];
  ok(await call('POST', `/skischool/requests/${req.id}/confirm`, { token: T.counter, body: {} }));
  const [b] = await q('SELECT id, pickup FROM lesson_bookings WHERE session_id = ?', [sid]);
  assert.equal(b.pickup, 'Pat Online (Mom)');
  const [ai] = await q('SELECT needs, equipment FROM lesson_adaptive_intake WHERE booking_id = ?', [b.id]);
  assert.deepEqual([ai.needs, ai.equipment], ['Autism', 'tethers']);
});

test('ages: online booking refuses a student outside the lesson ages', async () => {
  ok(await call('PUT', '/tenant/profile', { token: A.owner, body: { online_booking: true, waiver_text: 'I accept the risks.', booking_notice_hours: 1 } }));
  const sid = await session({ age_min: 5, age_max: 12 });
  const r = await call('POST', `/public/${A.slug}/requests`, { body: { session_id: sid, contact_first_name: 'Pat', contact_last_name: 'Parent', contact_email: `p.${suffix}@x.test`, contact_phone: '215-555-0100',
    students: [{ first_name: 'Grown', last_name: 'Up', date_of_birth: ADULT, sex: 'male' }], waiver_accepted: true } });
  assert.equal(r.status, 409, r.text);
  assert.match(r.body.error, /ages 5 to 12/i);
});

// ---------------------------------------------------------------- 8. ratios by age band
test('ratios: the band sizes are settings; the desk is warned over the band, online stops at it, the board shows it in red', async () => {
  const s0 = ok(await call('GET', '/skischool/settings', { token: T.counter }));
  assert.deepEqual(s0.ratio_bands.map((b) => [b.age_min, b.age_max, b.size]), [[3, 4, 4], [5, 6, 6], [7, 12, 8], [13, 17, 8], [18, null, 10]]);
  assert.equal(s0.ratio_adaptive, 1);
  // a manager sets a 7 to 12 band of 2 for this test
  const bands = s0.ratio_bands.map((b) => (b.age_min === 7 ? { ...b, size: 2 } : b));
  ok(await call('PATCH', '/skischool/settings', { token: A.owner, body: { ratio_bands: bands } }));
  assert.equal((await call('PATCH', '/skischool/settings', { token: A.owner, body: { ratio_bands: [{ label: 'Bad', age_min: 9, age_max: 3, size: 4 }] } })).status, 400);
  const sid = await session({ age_min: 7, age_max: 12 });
  ok(await book(sid, 'One', KID), 201);
  ok(await book(sid, 'Two', KID), 201);
  const third = await book(sid, 'Three', KID);
  assert.equal(third.status, 409, third.text);
  assert.match(third.body.error, /Ages 7 to 12 classes take 2 students per instructor/);
  assert.ok(third.body.details.problems.some((p) => p.kind === 'ratio'));
  // online: the page shows no places left, and a request is refused
  const page = ok(await call('GET', `/public/${A.slug}/booking`));
  assert.equal(page.lessons.some((l) => l.id === sid), false, 'a class at its band size is not offered online');
  // a manager adds one over with a reason; the board shows the class in red with the reason
  ok(await call('POST', `/skischool/sessions/${sid}/bookings`, { token: A.owner, body: { person_id: third.body.details.person_id, sign_waiver: true, override_reason: 'Sibling stays with sister', send_confirmation: false } }), 201);
  const board = ok(await call('GET', `/skischool/safety/board?date=${day2}`, { token: T.counter }));
  assert.equal(board.sessions[sid].over_ratio, true);
  assert.match(board.sessions[sid].ratio_reason, /3 students: Ages 7 to 12 classes take 2/);
  ok(await call('PATCH', '/skischool/settings', { token: A.owner, body: { ratio_bands: s0.ratio_bands } }));
  D.overSession = sid;
});

test('ratios: the lineup split makes classes no bigger than the youngest student\'s band', async () => {
  const sid = await session({ age_min: 3, age_max: 12, starts_at: `${day2}T09:00`, ends_at: `${day2}T10:30` });
  // age 4: a band of 4 (a manager books the fifth and sixth past the warning)
  for (let i = 0; i < 6; i++) ok(await book(sid, `Tiny${i}`, `${Number(day2.slice(0, 4)) - 4}-01-0${i + 1}`, { override_reason: 'Testing the split' }, A.owner), 201);
  ok(await call('GET', `/skischool/lineups?date=${day2}`, { token: T.counter }));
  const lu = { id: (await q('SELECT lineup_id FROM lesson_sessions WHERE id = ?', [sid]))[0].lineup_id };
  const sg = ok(await call('POST', `/skischool/lineups/${lu.id}/suggest`, { token: T.counter, body: { from: 'booked' } }));
  assert.ok(sg.classes.length >= 2, 'six four-year-olds need two classes');
  assert.ok(sg.classes.every((c) => c.students.length <= 4), JSON.stringify(sg.classes.map((c) => c.students.length)));
});

// ---------------------------------------------------------------- 2 and 3. the lineup split
test('split: an assigned instructor stays on their class, even outside their availability or level; an empty lineup is not split', async () => {
  // Ian is cleared only to level 2 and has no availability set: the split used to drop or swap him
  await q('UPDATE instructor_profiles SET ski_level_max = 2 WHERE tenant_id = ? AND staff_id = ?', [tid, D.ian]);
  const sid = await session({ starts_at: `${day2}T13:00`, ends_at: `${day2}T15:00`, age_min: 5, age_max: 12, product_id: D.group });
  await q('UPDATE lesson_sessions SET instructor_id = ? WHERE id = ?', [D.ian, sid]);
  const kids = [];
  for (const [n, lv] of [['Ava', 5], ['Ben', 6], ['Cal', 6]]) { const b = ok(await book(sid, n, KID), 201); await q('UPDATE people SET ski_level = ? WHERE id = ?', [lv, b.person_id]); kids.push(b); }
  const lu = (await q('SELECT lineup_id FROM lesson_sessions WHERE id = ?', [sid]));
  const lineups = ok(await call('GET', `/skischool/lineups?date=${day2}`, { token: T.counter })).data;
  const lineupId = (await q('SELECT lineup_id FROM lesson_sessions WHERE id = ?', [sid]))[0].lineup_id || lu[0].lineup_id;
  assert.ok(lineups.some((l) => l.id === lineupId));
  for (let run = 0; run < 3; run++) {
    const sg = ok(await call('POST', `/skischool/lineups/${lineupId}/suggest`, { token: T.counter, body: { from: 'booked' } }));
    const mine = sg.classes.find((c) => c.session_id === sid);
    assert.equal(mine.instructor_id, D.ian, `run ${run}: the class keeps its instructor`);
    assert.ok(mine.instructor_note, 'the director sees why to look (cleared to a lower level)');
    assert.equal(sg.can_use, true);
  }
  // used as suggested: Ian is still on it
  const sg = ok(await call('POST', `/skischool/lineups/${lineupId}/suggest`, { token: T.counter, body: { from: 'booked' } }));
  ok(await call('POST', `/skischool/lineups/${lineupId}/apply`, { token: A.owner, body: { classes: sg.classes.map((c) => ({ session_id: c.session_id, booking_ids: c.students.map((s) => s.booking_id), instructor_id: c.instructor_id, level_min: c.level_min, level_max: c.level_max })) } }));
  assert.equal((await q('SELECT instructor_id FROM lesson_sessions WHERE id = ?', [sid]))[0].instructor_id, D.ian);
  await q('UPDATE instructor_profiles SET ski_level_max = 9 WHERE tenant_id = ? AND staff_id = ?', [tid, D.ian]);

  // nobody checked in: the suggestion says so and cannot be used
  const sid2 = await session({ starts_at: `${day2}T08:00`, ends_at: `${day2}T09:00` });
  ok(await book(sid2, 'Early', KID), 201);
  const lid2 = (await q('SELECT lineup_id FROM lesson_sessions WHERE id = ?', [sid2]))[0].lineup_id || (ok(await call('GET', `/skischool/lineups?date=${day2}`, { token: T.counter })), (await q('SELECT lineup_id FROM lesson_sessions WHERE id = ?', [sid2]))[0].lineup_id);
  const none = ok(await call('POST', `/skischool/lineups/${lid2}/suggest`, { token: T.counter, body: { from: 'checked_in' } }));
  assert.equal(none.students, 0);
  assert.equal(none.can_use, false);
  const refused = await call('POST', `/skischool/lineups/${lid2}/apply`, { token: A.owner, body: { classes: [{ session_id: sid2, booking_ids: [] }] } });
  assert.equal(refused.status, 409, refused.text);
  assert.match(refused.body.error, /nobody to split/);
});

// ---------------------------------------------------------------- 4. one level scale
test('levels: the customer form and the public availability page use levels 1 to 9; old words are mapped', async () => {
  const form = ok(await call('GET', '/crm/form', { token: T.counter }));
  assert.equal(form.fields.some((f) => f.key === 'ability_level'), false, 'the old four words are gone from the form');
  const lv = form.fields.find((f) => f.key === 'ski_level');
  assert.ok(lv, 'a level field');
  assert.deepEqual(lv.options.map(String), ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  // a new student with a level from the roster form
  const r = ok(await call('POST', `/skischool/sessions/${await session()}/bookings`, { token: T.counter, body: { student: { first_name: 'Lev', last_name: `El${suffix}`, date_of_birth: KID, sex: 'male', ski_level: 4 }, sign_waiver: true, send_confirmation: false } }), 201);
  assert.equal((await q('SELECT ski_level FROM people WHERE id = ?', [r.person_id]))[0].ski_level, 4);
  // an older screen still sending the old word is mapped onto the scale
  const old = ok(await call('POST', `/skischool/sessions/${await session()}/bookings`, { token: T.counter, body: { student: { first_name: 'Old', last_name: `Word${suffix}`, date_of_birth: KID, sex: 'male', ability_level: 'intermediate' }, sign_waiver: true, send_confirmation: false } }), 201);
  assert.equal((await q('SELECT ski_level FROM people WHERE id = ?', [old.person_id]))[0].ski_level, 4);
  // the public availability page: levels from what each instructor is cleared to teach
  ok(await call('PUT', '/availability/settings', { token: A.owner, body: { public: true } }).catch(() => ({ status: 200 })));
  const meta = ok(await call('GET', '/availability/meta', { token: T.ian }));
  assert.deepEqual(meta.levels.map((x) => x.value), ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  assert.match(meta.levels[0].label, /^Level 1/);
});

// ---------------------------------------------------------------- 6. pickup
test('pickup: the list is given at booking; only the lesson\'s instructor, the desk and managers see it; release to a listed adult tells the family', async () => {
  const sid = await session({ age_min: 5, age_max: 12 });
  await q('UPDATE lesson_sessions SET instructor_id = ? WHERE id = ?', [D.ian, sid]);
  // a photo needs the parent's consent
  const noConsent = await book(sid, 'Pia', KID, { contact_email: `fam.${suffix}@x.test`, pickup_adults: [{ name: 'Kate Novak', relationship: 'Mom', phone: '610-555-0142', photo: PHOTO }] });
  assert.equal(noConsent.status, 409, noConsent.text);
  const b = ok(await call('POST', `/skischool/sessions/${sid}/bookings`, { token: T.counter, body: { person_id: noConsent.body.details ? noConsent.body.details.person_id : undefined, student: noConsent.body.details ? undefined : { first_name: 'Pia', last_name: `Fam${suffix}`, date_of_birth: KID, sex: 'female' }, sign_waiver: true, send_confirmation: false, contact_email: `fam.${suffix}@x.test`,
    pickup_adults: [{ name: 'Kate Novak', relationship: 'Mom', phone: '610-555-0142', photo: PHOTO }, { name: 'Joe Novak', relationship: 'Grandpa' }], pickup_photo_consent: true } }), 201);
  D.pia = b.id;
  const [row] = await q('SELECT pickup FROM lesson_bookings WHERE id = ?', [b.id]);
  assert.equal(row.pickup, 'Kate Novak (Mom), Joe Novak (Grandpa)');
  const [ph] = await q('SELECT photo_consent_at FROM lesson_pickup_adults WHERE booking_id = ? AND name = ?', [b.id, 'Kate Novak']);
  assert.ok(ph.photo_consent_at, 'consent recorded');
  // who may see it
  const mine = ok(await call('GET', `/skischool/bookings/${b.id}/pickup`, { token: T.ian }));
  assert.equal(mine.adults.length, 2);
  assert.equal(mine.needs_release, true);
  assert.equal(mine.adults[0].photo, undefined, 'no photo in the list itself');
  assert.equal((await call('GET', `/skischool/bookings/${b.id}/pickup`, { token: T.ola })).status, 403, 'another instructor');
  ok(await call('GET', `/skischool/bookings/${b.id}/pickup`, { token: T.counter }));
  const photo = ok(await call('GET', `/skischool/pickup-adults/${mine.adults[0].id}/photo`, { token: T.ian }));
  assert.equal(photo.photo, PHOTO);
  assert.equal((await call('GET', `/skischool/pickup-adults/${mine.adults[0].id}/photo`, { token: T.ola })).status, 403);
  assert.ok((await q("SELECT id FROM audit_log WHERE tenant_id = ? AND action = 'pickup_view' AND entity_id = ?", [tid, b.id])).length, 'reading the list is audited');
  // another instructor cannot release; ID must be confirmed
  assert.equal((await call('POST', `/skischool/bookings/${b.id}/release`, { token: T.ola, body: { adult_id: mine.adults[0].id, id_seen: true } })).status, 403);
  assert.equal((await call('POST', `/skischool/bookings/${b.id}/release`, { token: T.ian, body: { adult_id: mine.adults[0].id } })).status, 400);
  // the instructor releases to someone not on the list: refused (a manager and a reason are needed)
  const other = await call('POST', `/skischool/bookings/${b.id}/release`, { token: T.ian, body: { other_name: 'Uncle Bob', id_seen: true, override_reason: 'Mom called' } });
  assert.equal(other.status, 403, other.text);
  mails.length = 0;
  const rel = ok(await call('POST', `/skischool/bookings/${b.id}/release`, { token: T.ian, body: { adult_id: mine.adults[0].id, id_seen: true } }));
  assert.equal(rel.released_to, 'Kate Novak');
  const [after] = await q('SELECT released_at, released_to, released_by, released_id_seen FROM lesson_bookings WHERE id = ?', [b.id]);
  assert.ok(after.released_at); assert.equal(after.released_id_seen, 1); assert.ok(after.released_by);
  const mail = mails.find((m) => m.To === `fam.${suffix}@x.test`);
  assert.ok(mail, 'the family is told');
  assert.match(mail.TextBody, /Picked up by Kate Novak at \d{1,2}:\d{2} (AM|PM)/);
  assert.equal((await call('POST', `/skischool/bookings/${b.id}/release`, { token: T.ian, body: { adult_id: mine.adults[0].id, id_seen: true } })).status, 409, 'once');
});

test('pickup: someone not on the list needs a manager and a reason (audited); adults need no release; the board lists who still waits', async () => {
  const now = nowLocal();
  if (now.slice(11, 13) < '02') return; // the lesson must have ended today
  const sid = await session({ starts_at: `${minus(now, 120)}`, ends_at: `${minus(now, 60)}`, age_min: 4, age_max: 12 });
  const kid = ok(await book(sid, 'Wes', KID, { pickup_adults: [{ name: 'Dana Wes', relationship: 'Dad' }] }), 201);
  const kid2 = ok(await book(sid, 'Zoe', KID), 201);
  const board = ok(await call('GET', `/skischool/safety/board?date=${today}`, { token: T.counter }));
  const wes = board.waiting.find((w) => w.booking_id === kid.id);
  assert.ok(wes, 'still waiting after the lesson');
  assert.equal(wes.late, true, 'an hour after the end is past the 15 minute window');
  const pick = ok(await call('GET', `/skischool/pickup?date=${today}`, { token: T.counter }));
  assert.equal(pick.data.find((x) => x.booking_id === kid.id).state, 'late');
  assert.equal((await call('GET', `/skischool/pickup?date=${today}`, { token: T.ian })).status, 403, 'a plain instructor uses My day');
  const need = await call('POST', `/skischool/bookings/${kid2.id}/release`, { token: A.owner, body: { other_name: 'Neighbor Ann', id_seen: true } });
  assert.equal(need.status, 409, need.text);
  assert.equal(need.body.details.needs_reason, true);
  ok(await call('POST', `/skischool/bookings/${kid2.id}/release`, { token: A.owner, body: { other_name: 'Neighbor Ann', id_seen: true, override_reason: 'Parent phoned the desk' } }));
  const [a] = await q("SELECT detail FROM audit_log WHERE tenant_id = ? AND action = 'release_override' AND entity_id = ?", [tid, kid2.id]);
  assert.match(JSON.stringify(a.detail), /Parent phoned the desk/);
  const board2 = ok(await call('GET', `/skischool/safety/board?date=${today}`, { token: T.counter }));
  assert.equal(board2.waiting.some((w) => w.booking_id === kid2.id), false);
  // an adult in a lesson needs no release
  assert.equal(SS.needsRelease(30, { age_max: null }), false);
  assert.equal(SS.needsRelease(12, { age_max: null }), true);
  assert.equal(SS.needsRelease(null, { age_group: 'kids', age_max: 12 }), true);
  assert.equal((await call('GET', `/skischool/safety/board?date=${today}`, { token: T.ian })).status, 403, 'the board is for the desk and managers');
});

test('pickup: the family changes its own list on the lesson link; nobody else\'s email carries it', async () => {
  const token = await links.issue(pool, tid, D.pia);
  const view = ok(await call('GET', `/public/${A.slug}/lesson/${token}`));
  assert.equal(view.safety.pickup_adults.length, 2);
  assert.equal(view.safety.released.to, 'Kate Novak');
  assert.equal(view.safety.place, undefined, 'no location reaches a family');
  // already picked up: no more changes
  assert.equal((await call('PUT', `/public/${A.slug}/lesson/${token}/pickup`, { body: { pickup_adults: [{ name: 'Someone Else' }] } })).status, 409);
  // a moved-student email to an instructor never carries the pickup list
  const moved = mails.filter((m) => m.Tag === 'lesson-move-staff');
  assert.ok(moved.every((m) => !/Kate Novak|610-555-0142/.test(m.TextBody)));
});

// ---------------------------------------------------------------- 7. lost child
test('lost child: opens a patrol dispatch call with the child\'s details; the school sees its status; found closes it with who, where and when', async () => {
  const now = nowLocal();
  const sid = await session({ starts_at: `${today}T${now.slice(11, 16) < '00:10' ? '00:00' : minus(now, 10).slice(11, 16)}`, ends_at: `${today}T23:59`, age_min: 4, age_max: 12, meeting_place: 'Magic carpet' });
  await q('UPDATE lesson_sessions SET instructor_id = ? WHERE id = ?', [D.ian, sid]);
  const kid = ok(await book(sid, 'Emma', KID, { allergies: 'Peanuts', pickup_adults: [{ name: 'Secret Parent', phone: '610-555-9999' }] }), 201);
  ok(await call('POST', `/skischool/bookings/${kid.id}/checkin`, { token: T.counter }));
  assert.equal((await call('POST', `/skischool/bookings/${kid.id}/lost`, { token: T.ola, body: { jacket_color: 'Red' } })).status, 403, 'not their class');
  const lost = ok(await call('POST', `/skischool/bookings/${kid.id}/lost`, { token: T.ian, body: { jacket_color: 'Red', helmet_color: 'White' } }), 201);
  const [c] = await q('SELECT * FROM dispatch_calls WHERE id = ?', [lost.call_id]);
  assert.equal(c.call_type, 'lost_child');
  assert.equal(c.source, 'school');
  assert.equal(c.status, 'new', 'patrol dispatches it by its own rules');
  assert.equal(c.incident_id, null, 'no patient record is made');
  assert.match(c.description, /Lost child: Emma, age \d+\. Jacket Red\. Helmet White\. Class: Group lesson/);
  assert.match(c.description, /with Ian/);
  assert.match(c.description, /Meeting place Magic carpet/);
  assert.match(c.description, /Checked in at the desk at/);
  assert.equal(/Peanuts|Secret Parent|610-555-9999|Fam/.test(c.description), false, 'no allergies, pickup list or last name on the call');
  assert.equal((await q('SELECT COUNT(*) AS n FROM incidents WHERE tenant_id = ?', [tid]))[0].n, 0);
  // a second report while open is refused
  assert.equal((await call('POST', `/skischool/bookings/${kid.id}/lost`, { token: T.counter })).status, 409);
  // the school sees the call's status; patrol moves it
  await q("UPDATE dispatch_calls SET status = 'dispatched' WHERE id = ?", [lost.call_id]);
  const list = ok(await call('GET', `/skischool/lost?date=${today}`, { token: T.counter }));
  assert.equal(list.data.find((x) => x.id === lost.id).call_status, 'dispatched');
  assert.equal(ok(await call('GET', `/skischool/lost?date=${today}`, { token: T.ola })).data.some((x) => x.id === lost.id), false);
  // the report with the photo: the school and patrol
  ok(await call('GET', `/skischool/lost/${lost.id}`, { token: T.ian }));
  assert.equal((await call('GET', `/skischool/lost/${lost.id}`, { token: T.ola })).status, 403);
  // patrol, on the dispatch board, finds the report behind the call and the child's photo
  const patrol = T.patrol;
  const byCall = ok(await call('GET', `/skischool/lost-by-call/${lost.call_id}`, { token: patrol }));
  assert.equal(byCall.id, lost.id);
  const seen = ok(await call('GET', `/skischool/lost/${lost.id}`, { token: patrol }));
  assert.equal(seen.first_name, 'Emma');
  assert.equal(seen.jacket_color, 'Red');
  assert.equal(seen.last_name, undefined);
  assert.equal((await call('GET', `/skischool/lost-by-call/${lost.call_id}`, { token: T.counter })).status, 403, 'the lookup by call is for patrol');
  // found
  ok(await call('POST', `/skischool/lost/${lost.id}/found`, { token: T.counter, body: { found_by: 'Patroller Sam', found_where: 'Lift 2 base' } }));
  const [lc] = await q('SELECT status, found_by, found_where, found_at FROM school_lost_children WHERE id = ?', [lost.id]);
  assert.deepEqual([lc.status, lc.found_by, lc.found_where], ['found', 'Patroller Sam', 'Lift 2 base']);
  assert.ok(lc.found_at);
  const [c2] = await q('SELECT status FROM dispatch_calls WHERE id = ?', [lost.call_id]);
  assert.equal(c2.status, 'closed');
  const ev = await q('SELECT note FROM dispatch_events WHERE call_id = ? ORDER BY id', [lost.call_id]);
  assert.ok(ev.some((e) => /Found by Patroller Sam at Lift 2 base/.test(e.note || '')));
  D.liveSession = sid; D.emma = kid.id;
});

// ---------------------------------------------------------------- 9. adaptive intake
test('adaptive: the intake is taken at booking, seen only by the lesson\'s instructors, the desk and managers; staffing uses the adaptive ratio', async () => {
  const sid = await session({ discipline: 'adaptive', format: 'semi_private', capacity: 2 });
  await q('UPDATE lesson_sessions SET instructor_id = ? WHERE id = ?', [D.ada, sid]);
  const b = ok(await book(sid, 'Sam', KID, { adaptive: { needs: 'Low vision', equipment: ['bi_ski', 'tethers'], extra_staff: 1, notes: 'Likes music' } }), 201);
  const mine = ok(await call('GET', `/skischool/bookings/${b.id}/adaptive`, { token: T.ada }));
  assert.deepEqual(mine.intake.equipment, ['bi_ski', 'tethers']);
  assert.equal(mine.intake.extra_staff, 1);
  assert.equal((await call('GET', `/skischool/bookings/${b.id}/adaptive`, { token: T.ola })).status, 403);
  ok(await call('GET', `/skischool/bookings/${b.id}/adaptive`, { token: T.counter }));
  ok(await call('PUT', `/skischool/bookings/${b.id}/adaptive`, { token: T.ada, body: { needs: 'Low vision', equipment: ['bi_ski'], extra_staff: 1, notes: 'Likes music' } }));
  // one student at an adaptive ratio of 1, plus one extra staff: two staff needed, one assigned
  const board = ok(await call('GET', `/skischool/safety/board?date=${day2}`, { token: T.counter }));
  assert.equal(board.sessions[sid].staff_needed, 2);
  assert.equal(board.sessions[sid].over_ratio, true);
  assert.match(board.sessions[sid].ratio_reason, /Needs 2 staff/);
  // a second student is over the adaptive ratio of one per instructor
  const second = await book(sid, 'Tia', KID);
  assert.equal(second.status, 409, second.text);
  assert.match(second.body.error, /adaptive lesson takes 1 student per instructor/);
});

// ---------------------------------------------------------------- 10. live updates
test('live updates: a line goes to every family; a photo only to families who allowed photos; families can turn them off', async () => {
  const sid = D.liveSession;
  const yes = ok(await book(sid, 'Photo', KID, { contact_email: `yes.${suffix}@x.test`, photo_ok: true }), 201);
  const no = ok(await book(sid, 'NoPhoto', KID, { contact_email: `no.${suffix}@x.test`, photo_ok: false }), 201);
  const off = ok(await book(sid, 'Quiet', KID, { contact_email: `off.${suffix}@x.test`, photo_ok: true }), 201);
  const offToken = await links.issue(pool, tid, off.id);
  ok(await call('PATCH', `/public/${A.slug}/lesson/${offToken}/safety`, { body: { updates_off: true } }));
  assert.equal((await call('POST', `/skischool/sessions/${sid}/updates`, { token: T.ola, body: { body: 'Hi' } })).status, 403, 'not their lesson');
  mails.length = 0;
  ok(await call('POST', `/skischool/sessions/${sid}/updates`, { token: T.ian, body: { body: 'First run on the magic carpet!' } }), 201);
  assert.ok(mails.some((m) => m.To === `yes.${suffix}@x.test` && /magic carpet/.test(m.TextBody)));
  assert.ok(mails.some((m) => m.To === `no.${suffix}@x.test`));
  assert.equal(mails.some((m) => m.To === `off.${suffix}@x.test`), false, 'updates off');
  mails.length = 0;
  const ph = ok(await call('POST', `/skischool/sessions/${sid}/updates`, { token: T.ian, body: { photo: PHOTO } }), 201);
  assert.ok(mails.some((m) => m.To === `yes.${suffix}@x.test`));
  assert.equal(mails.some((m) => m.To === `no.${suffix}@x.test`), false, 'no photo to a family that said no');
  // the lesson pages
  const yesToken = await links.issue(pool, tid, yes.id);
  const noToken = await links.issue(pool, tid, no.id);
  const vy = ok(await call('GET', `/public/${A.slug}/lesson/${yesToken}`));
  const vn = ok(await call('GET', `/public/${A.slug}/lesson/${noToken}`));
  assert.equal(vy.safety.updates.length, 2);
  assert.equal(vn.safety.updates.length, 1);
  assert.equal(vn.safety.updates[0].body, 'First run on the magic carpet!');
  const pic = await fetch(`${base}/api/v1/public/${A.slug}/lesson/${yesToken}/updates/${ph.id}/photo`);
  assert.equal(pic.status, 200);
  assert.equal((await fetch(`${base}/api/v1/public/${A.slug}/lesson/${noToken}/updates/${ph.id}/photo`)).status, 404);
  assert.equal(ok(await call('GET', `/public/${A.slug}/lesson/${offToken}`)).safety.updates.length, 0);
});

// ---------------------------------------------------------------- 11. where are my groups
test('places: "We\'re at" a named spot and a lift scan show on the board for today; families and other instructors never see them; kept for the day only', async () => {
  const sid = D.liveSession;
  const places = ok(await call('GET', '/skischool/settings', { token: T.counter })).group_places;
  assert.deepEqual(places, ['Magic carpet', 'Lift 2 base', 'Lodge']);
  assert.equal((await call('POST', `/skischool/sessions/${sid}/at`, { token: T.ian, body: { place: 'The moon' } })).status, 400);
  assert.equal((await call('POST', `/skischool/sessions/${sid}/at`, { token: T.ola, body: { place: 'Lodge' } })).status, 403);
  ok(await call('POST', `/skischool/sessions/${sid}/at`, { token: T.ian, body: { place: 'Lift 2 base' } }), 201);
  let board = ok(await call('GET', `/skischool/safety/board?date=${today}`, { token: T.counter }));
  assert.equal(board.sessions[sid].place.place, 'Lift 2 base');
  assert.equal(board.sessions[sid].place.source, 'instructor');
  // a lesson code scanned at a lift gate a minute later
  await q("INSERT INTO scans (tenant_id, code, location, result, scanned_at) VALUES (?, ?, 'Summit Quad', 'unknown', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 MINUTE))", [tid, `L${D.emma}`]);
  board = ok(await call('GET', `/skischool/safety/board?date=${today}`, { token: T.counter }));
  assert.equal(board.sessions[sid].place.place, 'Summit Quad');
  assert.equal(board.sessions[sid].place.source, 'gate');
  // the family page has no place
  const token = await links.issue(pool, tid, D.emma);
  const view = await call('GET', `/public/${A.slug}/lesson/${token}`);
  assert.equal(/Summit Quad|Lift 2 base/.test(view.text), false);
  // the daily job deletes taps from before today
  await q("INSERT INTO school_group_places (tenant_id, session_id, on_date, place, at) VALUES (?, ?, DATE_SUB(?, INTERVAL 1 DAY), 'Lodge', NOW())", [tid, sid, today]);
  await SSR.daily();
  const left = await q('SELECT on_date FROM school_group_places WHERE tenant_id = ?', [tid]);
  assert.ok(left.length >= 1 && left.every((r) => String(r.on_date).slice(0, 10) === today));
});
