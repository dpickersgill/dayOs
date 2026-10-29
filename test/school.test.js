'use strict';

// Ski school: formats and series, level ladder and report cards, packages, the instructors' day, notes and tips,
// and the public booking page with its request queue.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.BOOKING_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const day2 = addDays(today, 2);

async function call(prefix, method, path, { token, body } = {}) {
  const res = await fetch(`${base}${prefix}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const api = (m, p, o) => call('/api/v1', m, p, o);
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
const tid = async (slug) => (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id;
const ADULT = { date_of_birth: '1985-03-02', sex: 'female' };
const person = (first, last, extra = {}) => ({ details: { first_name: first, last_name: last, ...ADULT, email: `${first}.${last}@x.test`.toLowerCase(), ...extra } });

let A; let B; const T = {}; const D = {};

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`sa-${suffix}`);
  B = await mountain(`sb-${suffix}`);
  T.counter = await addUser(A, `counter@${A.slug}.test`, 'counter');
  T.manager = await addUser(A, `manager@${A.slug}.test`, 'manager');
  const st = await api('POST', '/workforce/staff', { token: A.owner, body: { person: { first_name: 'Ivy', last_name: 'Instructor' }, status: 'active' } });
  assert.equal(st.status, 201, st.text);
  D.ivy = st.body.id;
  T.instructor = await addUser(A, `ivy@${A.slug}.test`, 'instructor', { staff_id: D.ivy });
  const st2 = await api('POST', '/workforce/staff', { token: A.owner, body: { person: { first_name: 'Max', last_name: 'Other' }, status: 'active' } });
  D.max = st2.body.id;
  await addUser(A, `max@${A.slug}.test`, 'instructor', { staff_id: D.max }); // round 2: the picker lists only staff who teach
  const prod = async (body) => (await api('POST', '/products', { token: A.owner, body })).body.id;
  D.group = await prod({ kind: 'lesson', name: 'Group Lesson', base_price_cents: 8000 });
  D.private = await prod({ kind: 'lesson', name: 'Private Lesson', base_price_cents: 20000 });
  D.pack = await prod({ kind: 'lesson', name: '3-Lesson Card', base_price_cents: 21000, uses: 3, valid_days: 60 });
  D.ticket = await prod({ kind: 'day_ticket', name: 'Day', base_price_cents: 9000 });
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

const sell = (token, body) => api('POST', '/checkout', { token, body });
const session = (extra = {}) => api('POST', '/skischool/sessions', { token: A.owner, body: { product_id: D.group, starts_at: `${day2}T10:00`, ends_at: `${day2}T12:00`, ...extra } });

test('lesson formats set the seats, packages cannot be scheduled, and a series makes many sessions at once', async () => {
  const g = await session();
  assert.equal(g.status, 201, g.text);
  const priv = await session({ product_id: D.private, format: 'private', meeting_place: 'Base lodge door 2' });
  assert.equal(priv.status, 201);
  const list = (await api('GET', `/skischool/sessions?from=${day2}&to=${day2}`, { token: A.owner })).body.data;
  assert.equal(list.find((s) => s.id === priv.body.id).capacity, 1, 'a private lesson defaults to one student');
  assert.equal(list.find((s) => s.id === priv.body.id).meeting_place, 'Base lodge door 2');
  assert.equal(list.find((s) => s.id === g.body.id).capacity, 6);
  assert.equal((await session({ format: 'private', capacity: 9 })).status, 400, 'too many for a private lesson');
  assert.equal((await session({ product_id: D.pack })).status, 400, 'a package is not a lesson');
  assert.equal((await api('POST', '/skischool/sessions', { token: T.counter, body: { product_id: D.group, starts_at: `${day2}T10:00`, ends_at: `${day2}T12:00` } })).status, 403);
  const series = await api('POST', '/skischool/sessions/series', { token: A.owner, body: { product_id: D.group, dates: [addDays(today, 5), addDays(today, 6), addDays(today, 6)], start_time: '09:00', end_time: '10:30', format: 'semi_private' } });
  assert.equal(series.status, 201, series.text);
  assert.equal(series.body.count, 2, 'a repeated date is only made once');
  const some = (await api('GET', `/skischool/sessions?from=${addDays(today, 5)}&to=${addDays(today, 6)}`, { token: A.owner })).body.data;
  assert.equal(some.length, 2);
  assert.equal(some[0].capacity, 3, 'semi-private default');
  D.g = g.body.id; D.priv = priv.body.id;
});

test('the level ladder starts with sensible defaults, is editable, and keeps skills that were passed', async () => {
  const lv = await api('GET', '/skischool/levels', { token: T.counter });
  assert.equal(lv.status, 200);
  const ski = lv.body.data.filter((l) => l.discipline === 'ski');
  assert.equal(ski.length, 9, 'the nine levels (round 2)');
  assert.ok(ski[0].skills.length >= 3);
  assert.ok(lv.body.data.some((l) => l.discipline === 'snowboard'));
  assert.equal((await api('POST', '/skischool/levels', { token: T.counter, body: { discipline: 'ski', name: 'x' } })).status, 403);
  const made = await api('POST', '/skischool/levels', { token: T.manager, body: { discipline: 'telemark', name: 'Telemark 1' } });
  assert.equal(made.status, 201);
  assert.equal(made.body.rank_no, 1);
  const sk = await api('POST', `/skischool/levels/${made.body.id}/skills`, { token: T.manager, body: { name: 'Free the heel' } });
  assert.equal(sk.status, 201);
  assert.equal((await api('PATCH', `/skischool/skills/${sk.body.id}`, { token: T.manager, body: { name: 'Free the heel and glide' } })).status, 200);
  assert.equal((await api('PATCH', `/skischool/levels/${made.body.id}`, { token: T.manager, body: { description: 'First telemark day' } })).status, 200);
  assert.equal((await api('DELETE', `/skischool/skills/${sk.body.id}`, { token: T.manager })).status, 200, 'unused skill can go');
  // another mountain has its own ladder
  const other = await api('GET', '/skischool/levels', { token: B.owner });
  assert.ok(!other.body.data.some((l) => l.name === 'Telemark 1'));
  D.skiLevel1 = ski[0];
});

test('report card: skills are passed by instructors, level changes are recorded, lessons and notes show up', async () => {
  const stu = await sell(T.counter, { channel: 'window', customer: { ...person('Sam', 'Student'), sign_waiver: true }, lines: [{ type: 'lesson', session_id: D.g }], payments: [{ tender: 'cash', amount_cents: 8000 }] });
  assert.equal(stu.status, 201, stu.text);
  // the waiver is needed for a lesson sale
  D.sam = stu.body.lessons ? stu.body.lessons[0].person_id : null;
  assert.ok(D.sam, JSON.stringify(stu.body));
  const first = D.skiLevel1.skills[0].id;
  assert.equal((await api('PUT', `/skischool/students/${D.sam}/skills/${first}`, { token: T.counter, body: { passed: true } })).status, 403, 'counter staff cannot pass skills');
  assert.equal((await api('PUT', `/skischool/students/${D.sam}/skills/${first}`, { token: T.instructor, body: { passed: true } })).status, 200);
  let card = (await api('GET', `/skischool/students/${D.sam}/card`, { token: T.instructor })).body;
  let ski = card.disciplines.find((d) => d.discipline === 'ski');
  assert.equal(ski.levels[0].skills[0].passed_on, today);
  assert.equal(ski.levels[0].complete, false);
  assert.equal(ski.next_level, 1);
  for (const s of D.skiLevel1.skills.slice(1)) await api('PUT', `/skischool/students/${D.sam}/skills/${s.id}`, { token: T.manager, body: { passed: true } });
  assert.equal((await api('POST', '/skischool/progress', { token: T.instructor, body: { person_id: D.sam, discipline: 'ski', level: 2, notes: 'Ready for the green run' } })).status, 201);
  card = (await api('GET', `/skischool/students/${D.sam}/card`, { token: T.instructor })).body;
  ski = card.disciplines.find((d) => d.discipline === 'ski');
  assert.equal(ski.levels[0].complete, true);
  assert.equal(ski.current_level, 2);
  assert.equal(ski.next_level, 2, 'the next level to work on is the first unfinished one');
  assert.equal(card.history[0].notes, 'Ready for the green run');
  assert.equal(card.lessons.length, 1);
  // an unpassed skill can be undone, and a skill passed by a student cannot be deleted
  assert.equal((await api('PUT', `/skischool/students/${D.sam}/skills/${first}`, { token: T.instructor, body: { passed: false } })).status, 200);
  assert.equal((await api('PUT', `/skischool/students/${D.sam}/skills/${first}`, { token: T.instructor, body: { passed: true } })).status, 200);
  assert.equal((await api('DELETE', `/skischool/skills/${first}`, { token: T.manager })).status, 409);
  assert.equal((await api('GET', `/skischool/students/${D.sam}/card`, { token: B.owner })).status, 404, 'another mountain cannot see this student');
  // lesson notes: only for the instructor's own lessons
  await api('PATCH', `/skischool/sessions/${D.g}/instructor`, { token: A.owner, body: { instructor_id: D.ivy } });
  const roster = (await api('GET', `/skischool/sessions/${D.g}/roster`, { token: T.instructor })).body.data;
  assert.equal((await api('PATCH', `/skischool/bookings/${roster[0].booking_id}/notes`, { token: T.instructor, body: { instructor_notes: 'Great first day, work on stopping' } })).status, 200);
  card = (await api('GET', `/skischool/students/${D.sam}/card`, { token: T.instructor })).body;
  assert.equal(card.lessons[0].instructor_notes, 'Great first day, work on stopping');
  await api('PATCH', `/skischool/sessions/${D.g}/instructor`, { token: A.owner, body: { instructor_id: D.max } });
  assert.equal((await api('PATCH', `/skischool/bookings/${roster[0].booking_id}/notes`, { token: T.instructor, body: { instructor_notes: 'x' } })).status, 400, 'not their lesson');
  await api('PATCH', `/skischool/sessions/${D.g}/instructor`, { token: A.owner, body: { instructor_id: D.ivy } });
});

test('the instructors day board, who could teach, hours and tips', async () => {
  const board = (await api('GET', `/skischool/board?date=${day2}`, { token: T.counter })).body;
  assert.equal(board.date, day2);
  const g = board.sessions.find((s) => s.id === D.g);
  assert.equal(g.instructor, 'Ivy Instructor');
  assert.equal(g.students.length, 1);
  assert.equal(g.students[0].first_name, 'Sam');
  assert.equal(board.unassigned, 1, 'the private lesson has nobody yet');
  assert.equal(board.instructors[0].lessons, 1);
  assert.equal(board.instructors[0].minutes, 120);
  const el = (await api('GET', `/skischool/sessions/${D.priv}/eligible-instructors`, { token: T.manager })).body.data;
  assert.deepEqual(el.filter((x) => x.ok).map((x) => x.name), ['Max Other'], 'Ivy teaches the group lesson at the same time');
  assert.equal((await api('GET', `/skischool/sessions/${D.priv}/eligible-instructors`, { token: T.counter })).status, 403);
  assert.equal((await api('PATCH', `/skischool/sessions/${D.g}/details`, { token: T.instructor, body: { tip_cents: 2500, notes: 'Meet at the flag' } })).status, 200);
  assert.equal((await api('PATCH', `/skischool/sessions/${D.priv}/details`, { token: T.instructor, body: { tip_cents: 100 } })).status, 400, 'not their lesson');
  const hrs = (await api('GET', `/skischool/hours?from=${today}&to=${addDays(today, 10)}`, { token: T.manager })).body.data;
  const ivy = hrs.find((h) => h.name === 'Ivy Instructor');
  assert.equal(ivy.hours, 2);
  assert.equal(ivy.tip_cents, 2500);
  assert.equal((await api('GET', `/skischool/hours?from=${today}&to=${today}`, { token: T.counter })).status, 403);
});

test('lesson packages: sold in the basket, spent one lesson at a time, given back on cancel, voided on refund', async () => {
  const menu = (await api('GET', '/checkout/menu', { token: T.counter })).body;
  assert.equal(menu.packages.length, 1);
  assert.equal(menu.lessons.find((l) => l.id === D.priv).format, 'private');
  const buy = await sell(T.counter, { channel: 'window', customer: person('Pat', 'Package'), lines: [{ type: 'lesson_package', product_id: D.pack }], payments: [{ tender: 'cash', amount_cents: 21000 }] });
  assert.equal(buy.status, 201, buy.text);
  assert.equal(buy.body.packages.length, 1);
  const pid = buy.body.packages[0].person_id;
  assert.equal(buy.body.packages[0].lessons, 3);
  assert.ok(buy.body.packages[0].expires_on > today);
  const credits = (await api('GET', `/skischool/credits?person_id=${pid}`, { token: T.counter })).body.data;
  assert.equal(credits[0].left, 3);
  // book with the credit (the waiver is needed first)
  await q("INSERT INTO waivers (tenant_id, person_id, season, kind) VALUES (?, ?, ?, 'general')", [await tid(A.slug), pid, require('../src/lib/util').seasonFor(day2)]);
  const b1 = await api('POST', `/skischool/sessions/${D.g}/bookings`, { token: T.counter, body: { person_id: pid, use_credit_id: credits[0].id, requested_instructor_id: D.ivy } });
  assert.equal(b1.status, 201, b1.text);
  assert.equal((await api('GET', `/skischool/credits?person_id=${pid}`, { token: T.counter })).body.data[0].left, 2);
  assert.equal((await api('POST', `/skischool/sessions/${D.g}/bookings`, { token: T.counter, body: { person_id: pid, use_credit_id: credits[0].id } })).status, 409, 'already booked');
  assert.equal((await api('PATCH', `/skischool/bookings/${b1.body.id}`, { token: T.counter, body: { status: 'cancelled' } })).status, 200);
  assert.equal((await api('GET', `/skischool/credits?person_id=${pid}`, { token: T.counter })).body.data[0].left, 3, 'the lesson is given back');
  // another student's package cannot be used
  const other = await sell(T.counter, { channel: 'window', customer: person('Oli', 'Other'), lines: [{ type: 'ticket', product_id: D.ticket }], payments: [{ tender: 'cash', amount_cents: 9000 }] });
  const oid = (await q('SELECT person_id FROM orders WHERE id = ?', [other.body.id]))[0].person_id;
  await q("INSERT INTO waivers (tenant_id, person_id, season, kind) VALUES (?, ?, ?, 'general')", [await tid(A.slug), oid, require('../src/lib/util').seasonFor(day2)]);
  assert.equal((await api('POST', `/skischool/sessions/${D.g}/bookings`, { token: T.counter, body: { person_id: oid, use_credit_id: credits[0].id } })).status, 409);
  // refund: unused package is voided; a used one is refused
  const rf = await api('POST', `/orders/${buy.body.id}/refund`, { token: T.manager, body: { reason: 'customer_request' } });
  assert.equal(rf.status, 200, rf.text);
  assert.equal((await api('GET', `/skischool/credits?person_id=${pid}`, { token: T.counter })).body.data.length, 0);
  const buy2 = await sell(T.counter, { channel: 'window', customer: person('Una', 'Used'), lines: [{ type: 'lesson_package', product_id: D.pack }], payments: [{ tender: 'cash', amount_cents: 21000 }] });
  const uid = buy2.body.packages[0].person_id;
  await q("INSERT INTO waivers (tenant_id, person_id, season, kind) VALUES (?, ?, ?, 'general')", [await tid(A.slug), uid, require('../src/lib/util').seasonFor(day2)]);
  const cid = buy2.body.packages[0].credit_id;
  assert.equal((await api('POST', `/skischool/sessions/${D.g}/bookings`, { token: T.counter, body: { person_id: uid, use_credit_id: cid } })).status, 201);
  assert.equal((await api('POST', `/orders/${buy2.body.id}/refund`, { token: T.manager, body: { reason: 'customer_request' } })).status, 409);
  assert.equal((await sell(T.counter, { channel: 'window', customer: person('Ned', 'Notpack'), lines: [{ type: 'lesson_package', product_id: D.group }], payments: [{ tender: 'cash', amount_cents: 8000 }] })).status, 400, 'a single lesson product is not a package');
});

test('public booking page: closed until switched on, then requests are queued, confirmed by staff and paid at the desk', async () => {
  const pub = (m, p, o) => call('/api/v1/public', m, `/${A.slug}${p}`, o);
  assert.equal((await pub('GET', '/booking')).status, 404, 'off by default');
  assert.equal((await api('PUT', '/tenant/profile', { token: T.counter, body: { online_booking: true } })).status, 403);
  assert.equal((await api('PUT', '/tenant/profile', { token: T.manager, body: { online_booking: true, booking_notice_hours: 1, booking_message: 'Welcome!', cancel_hours: 24 } })).status, 200);
  const page = await pub('GET', '/booking');
  assert.equal(page.status, 200);
  assert.equal(page.body.message, 'Welcome!');
  assert.ok(page.body.lessons.find((l) => l.id === D.priv));
  assert.equal(JSON.stringify(page.body).includes('@'), false, 'no personal data on the public page');
  const kid = { first_name: 'Kit', last_name: 'Kid', date_of_birth: `${Number(today.slice(0, 4)) - 9}-02-01`, sex: 'male', discipline: 'ski' };
  const req = (extra = {}) => ({ session_id: D.priv, contact_first_name: 'Pam', contact_last_name: 'Parent', contact_email: 'pam.parent@x.test', contact_phone: '215-555-0100', students: [kid], waiver_accepted: true, ...extra });
  assert.equal((await pub('POST', '/requests', { body: req({ waiver_accepted: false }) })).status, 400);
  assert.equal((await pub('POST', '/requests', { body: req({ website: 'bot' }) })).status, 202, 'honeypot looks like success');
  assert.equal((await q('SELECT COUNT(*) AS n FROM lesson_requests WHERE tenant_id = ?', [await tid(A.slug)]))[0].n, 0, '...but creates nothing');
  const two = await pub('POST', '/requests', { body: req({ students: [kid, { ...kid, first_name: 'Kay' }] }) });
  assert.equal(two.status, 409, 'a private lesson only has one place');
  const ok = await pub('POST', '/requests', { body: req() });
  assert.equal(ok.status, 201, ok.text);
  assert.match(ok.body.reference, /^[A-Z2-9]{8}$/);
  D.ref = ok.body.reference;
  // the spot is held for the pending request, so the same lesson is no longer offered
  assert.equal((await pub('GET', '/booking')).body.lessons.some((l) => l.id === D.priv), false);
  assert.equal((await pub('POST', '/requests', { body: req({ contact_email: 'someone@else.test' }) })).status, 409);
  // the guest can look the request up only with the matching email
  assert.equal((await pub('POST', `/requests/${D.ref}/status`, { body: { email: 'pam.parent@x.test' } })).body.status, 'pending');
  assert.equal((await pub('POST', `/requests/${D.ref}/status`, { body: { email: 'nope@x.test' } })).status, 404);
  assert.equal((await pub('POST', `/requests/AAAAAAAA/status`, { body: { email: 'pam.parent@x.test' } })).status, 404);
  // staff see it, and only staff
  const listed = await api('GET', '/skischool/requests', { token: T.counter });
  assert.equal(listed.body.pending, 1);
  assert.equal(listed.body.data[0].students[0].first_name, 'Kit');
  assert.equal((await api('GET', '/skischool/requests', { token: B.owner })).body.data.length, 0, 'other mountains see nothing');
  assert.equal((await api('GET', '/skischool/requests', { token: T.instructor })).status, 403);
  const conf = await api('POST', `/skischool/requests/${listed.body.data[0].id}/confirm`, { token: T.counter });
  assert.equal(conf.status, 200, conf.text);
  assert.deepEqual(conf.body.waiver_needed, [], 'the parent accepted the waiver for the child');
  assert.equal(conf.body.booked.length, 1);
  assert.equal((await api('POST', `/skischool/requests/${listed.body.data[0].id}/confirm`, { token: T.counter })).status, 409, 'only once');
  const bk = (await api('GET', `/skischool/sessions/${D.priv}/roster`, { token: T.counter })).body.data;
  assert.equal(bk[0].unpaid, 1);
  // the child is on file, linked to the parent, with the waiver signed by the guardian
  const kidRow = (await q("SELECT id FROM people WHERE tenant_id = ? AND first_name = 'Kit'", [await tid(A.slug)]))[0];
  const link = await q("SELECT relation FROM person_links WHERE tenant_id = ? AND member_id = ?", [await tid(A.slug), kidRow.id]);
  assert.equal(link[0].relation, 'guardian');
  const w = (await q('SELECT signer_relation, signed_by_name FROM waivers WHERE person_id = ?', [kidRow.id]))[0];
  assert.equal(w.signer_relation, 'guardian');
  assert.equal(w.signed_by_name, 'Pam Parent');
  // paying at the desk adopts the held booking instead of failing as "already booked"
  const pay = await sell(T.counter, { channel: 'window', customer: { person_id: kidRow.id }, participants: {}, lines: [{ type: 'lesson', session_id: D.priv, tier: 'child' }], payments: [{ tender: 'cash', amount_cents: 20000 }] });
  assert.equal(pay.status, 201, pay.text + JSON.stringify(pay.body));
  assert.equal((await api('GET', `/skischool/sessions/${D.priv}/roster`, { token: T.counter })).body.data[0].unpaid, 0);
  // once paid, the guest cannot cancel it online
  const cancel = await pub('POST', `/requests/${D.ref}/cancel`, { body: { email: 'pam.parent@x.test' } });
  assert.equal(cancel.status, 409);
});

test('requests can be declined or canceled, an unpaid confirmed lesson can be canceled online, and rules are enforced', async () => {
  const pub = (m, p, o) => call('/api/v1/public', m, `/${A.slug}${p}`, o);
  const adult = { first_name: 'Ann', last_name: 'Adult', ...ADULT, sex: 'female' };
  const mk = (extra = {}) => pub('POST', '/requests', { body: { session_id: D.g, contact_first_name: 'Ann', contact_last_name: 'Adult', contact_email: 'ann@x.test', contact_phone: '215-555-0111', students: [adult], waiver_accepted: true, ...extra } });
  const r1 = await mk();
  assert.equal(r1.status, 201, r1.text);
  assert.equal((await pub('POST', `/requests/${r1.body.reference}/cancel`, { body: { email: 'ANN@x.test' } })).status, 200, 'email match ignores case');
  assert.equal((await pub('POST', `/requests/${r1.body.reference}/status`, { body: { email: 'ann@x.test' } })).body.status, 'cancelled');
  const r2 = await mk();
  const id2 = (await api('GET', '/skischool/requests', { token: T.manager })).body.data.find((r) => r.reference === r2.body.reference).id;
  assert.equal((await api('POST', `/skischool/requests/${id2}/decline`, { token: T.manager, body: { staff_note: 'Class canceled for wind' } })).status, 200);
  assert.equal((await pub('POST', `/requests/${r2.body.reference}/status`, { body: { email: 'ann@x.test' } })).body.staff_note, 'Class canceled for wind');
  // a child cannot book themselves in
  const kid = { first_name: 'Ann', last_name: 'Adult', date_of_birth: `${Number(today.slice(0, 4)) - 10}-01-01`, sex: 'female' };
  assert.equal((await mk({ students: [kid] })).status, 400, 'the contact must be an adult');
  // adult booked by someone else: confirmed, but they must sign at the desk
  const r3 = await mk({ contact_first_name: 'Bob', contact_last_name: 'Booker', contact_email: 'bob@x.test', students: [{ ...adult, first_name: 'Cy', last_name: 'Friend' }] });
  const id3 = (await api('GET', '/skischool/requests', { token: T.manager })).body.data.find((r) => r.reference === r3.body.reference).id;
  const c3 = await api('POST', `/skischool/requests/${id3}/confirm`, { token: T.manager });
  assert.equal(c3.status, 200, c3.text);
  assert.deepEqual(c3.body.waiver_needed, ['Cy Friend'], 'one adult cannot sign for another');
  // unpaid and far enough away: the guest can cancel online and the spot is freed
  const left = (await api('GET', `/skischool/sessions/${D.g}/roster`, { token: T.manager })).body.data.length;
  assert.equal((await pub('POST', `/requests/${r3.body.reference}/cancel`, { body: { email: 'bob@x.test' } })).status, 200);
  assert.equal((await api('GET', `/skischool/sessions/${D.g}/roster`, { token: T.manager })).body.data.length, left - 1);
  // too close to the start: "call us"
  await q("UPDATE tenants SET booking_notice_hours = 0, cancel_hours = 60000 WHERE slug = ?", [A.slug]);
  const r4 = await mk({ contact_email: 'dee@x.test', students: [{ ...adult, first_name: 'Dee' }], contact_first_name: 'Dee' });
  const id4 = (await api('GET', '/skischool/requests', { token: T.manager })).body.data.find((r) => r.reference === r4.body.reference).id;
  assert.equal((await api('POST', `/skischool/requests/${id4}/confirm`, { token: T.manager })).status, 200);
  assert.equal((await pub('POST', `/requests/${r4.body.reference}/cancel`, { body: { email: 'dee@x.test' } })).status, 409);
  // switching the page off closes everything
  await api('PUT', '/tenant/profile', { token: T.manager, body: { online_booking: false } });
  assert.equal((await pub('GET', '/booking')).status, 404);
  assert.equal((await pub('POST', '/requests', { body: { session_id: D.g } })).status, 400);
});

test('another mountain can never see or touch this one\'s school data', async () => {
  const bt = await tid(B.slug);
  assert.equal((await api('PUT', `/skischool/students/${D.sam}/skills/${D.skiLevel1.skills[0].id}`, { token: B.owner, body: { passed: true } })).status, 404);
  assert.equal((await api('GET', `/skischool/board?date=${day2}`, { token: B.owner })).body.sessions.length, 0);
  assert.equal((await api('GET', `/skischool/credits?person_id=${D.sam}`, { token: B.owner })).body.data.length, 0);
  assert.ok(bt);
});
