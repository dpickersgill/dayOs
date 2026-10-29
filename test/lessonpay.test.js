'use strict';

// Ski school round 2, Track PAY: pay modes and rates, lineup time, request bonuses, hourly pay from the time clock or the
// lesson minutes, privates asked for by name (accept, clashes, decline and expiry both ways, refunds), tips in pay,
// payroll export, and that an instructor sees only their own pay.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.BOOKING_RATE_LIMIT = '1000';
process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
process.env.MAIL_FROM = 'hello@summitops.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const config = require('../src/config');
const stripe = require('../src/lib/stripe');
const mailer = require('../src/lib/mailer');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const modules = require('../src/lib/modules');
const P = require('../src/lib/lessonpay');
const PR = require('../src/lib/lessonprivate');

let server; let base; let stripeMock; let pmMock; const mails = []; const refunds = []; const checkouts = []; let n = 0;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const DEVICE = 'test-device-0123456789abcdef';
const q = async (sql, params) => (await pool.query(sql, params))[0];
const plus = (d, k) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const D1 = plus(today, 3); const D2 = plus(today, 4); const D3 = plus(today, 5); const D4 = plus(today, 6);
const year = Number(today.slice(0, 4));

async function call(prefix, method, path, { token, body } = {}) {
  const res = await fetch(`${base}${prefix}${path}`, { method, headers: { 'x-device': DEVICE, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const api = (m, p, o) => call('/api/v1', m, p, o);
const ok = (r, s) => { assert.ok(r.status < 300, `${r.status} ${r.text}`); if (s) assert.equal(r.status, s); return r.body; };
const is = (r, s, why) => assert.equal(r.status, s, `${why || ''} ${r.text}`);
const webhook = async (event) => {
  const raw = JSON.stringify(event);
  const res = await fetch(`${base}/api/v1/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripe.signWebhook(raw, 'whsec_mock') }, body: raw });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const M = {}; const T = {}; const D = {};
let pub;
test.before(async () => {
  stripeMock = http.createServer((req, res) => {
    let data = ''; req.on('data', (c) => { data += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/checkout/sessions') { const p = Object.fromEntries(new URLSearchParams(data)); checkouts.push(p); res.end(JSON.stringify({ id: `cs_pay_${++n}`, url: `https://checkout.stripe.test/c/${n}` })); }
      else if (req.url === '/v1/refunds') { const p = Object.fromEntries(new URLSearchParams(data)); refunds.push(p); res.end(JSON.stringify({ id: `re_${++n}`, payment_intent: p.payment_intent, status: 'succeeded' })); }
      else { res.statusCode = 404; res.end('{}'); }
    });
  });
  pmMock = http.createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { mails.push(JSON.parse(d)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m-${++n}` })); }); });
  await new Promise((r) => stripeMock.listen(0, '127.0.0.1', r));
  await new Promise((r) => pmMock.listen(0, '127.0.0.1', r));
  config.stripe.apiBase = `http://127.0.0.1:${stripeMock.address().port}`;
  mailer.settings.apiBase = `http://127.0.0.1:${pmMock.address().port}`;
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const slug = `lp-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Pine Peak', phone: '215-555-0000', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  M.slug = slug; M.id = (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id;
  await q('INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE enabled = 1', [M.id, 'school']);
  modules.invalidate(M.id);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  T.owner = await login(`owner@${slug}.test`);
  const staff = async (first, last) => ok(await api('POST', '/workforce/staff', { token: T.owner, body: { person: { first_name: first, last_name: last, email: `${first.toLowerCase()}.${suffix}@x.test` }, status: 'active' } }), 201).id;
  D.ivy = await staff('Ivy', 'Instructor'); D.max = await staff('Max', 'Other'); D.zed = await staff('Zed', 'Quiet');
  const user = async (email, role, extra = {}) => { ok(await api('POST', '/users', { token: T.owner, body: { email, password: PW, role, ...extra } }), 201); return login(email); };
  T.ivy = await user(`ivy@${slug}.test`, 'instructor', { staff_id: D.ivy });
  T.max = await user(`max@${slug}.test`, 'instructor', { staff_id: D.max });
  T.desk = await user(`desk@${slug}.test`, 'counter');
  T.mgr = await user(`mgr@${slug}.test`, 'manager');
  const prod = async (body) => ok(await api('POST', '/products', { token: T.owner, body })).id;
  D.group = await prod({ kind: 'lesson', name: 'Group Lesson', base_price_cents: 8000 });
  D.private = await prod({ kind: 'lesson', name: 'Private Lesson (1 hour)', base_price_cents: 14000 });
  ok(await api('PUT', '/tenant/profile', { token: T.owner, body: { online_payment: true, waiver_text: 'I accept the risks of skiing.', booking_notice_hours: 1 } }));
  // Ivy and Max are listed publicly and open on D1 and D2 from 9 to 4; Zed is not listed.
  for (const sid of [D.ivy, D.max]) {
    await q("INSERT INTO instructor_profiles (tenant_id, staff_id, is_public, display_name, disciplines, ski_level_max) VALUES (?, ?, 1, NULL, 'ski,snowboard', 9)", [M.id, sid]);
    for (const d of [D1, D2, D3]) await q("INSERT INTO instructor_open (tenant_id, staff_id, open_date, start_time, end_time) VALUES (?, ?, ?, '09:00', '16:00')", [M.id, sid, d]);
  }
  pub = (m, p, o) => call('/api/v1/public', m, `/${slug}${p}`, o);
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => stripeMock.close(r)); await new Promise((r) => pmMock.close(r)); await pool.end(); });

const settings = async (body) => ok(await api('PATCH', '/skischool/settings', { token: T.owner, body }));
const rate = (staff_id, kind, cents, effective_from) => api('POST', '/skischool/pay/rates', { token: T.owner, body: { staff_id, kind, cents, effective_from: effective_from || plus(today, -30) } });
async function lesson(day, from, to, extra = {}) {
  // Ivy keeps open dates for privates (D1 to D3), so a lesson on another day is assigned anyway, with the reason.
  return ok(await api('POST', '/skischool/sessions', { token: T.owner, body: { product_id: D.group, starts_at: `${day}T${from}`, ends_at: `${day}T${to}`, instructor_id: D.ivy, override_reason: 'Pay test lesson', ...extra } }), 201).id;
}
let kid = 0;
async function book(sessionId, extra = {}) {
  kid += 1;
  return ok(await api('POST', `/skischool/sessions/${sessionId}/bookings`, { token: T.desk, body: { student: { first_name: `Kid${kid}`, last_name: `Pay${suffix}`, date_of_birth: `${year - 9}-02-02`, sex: 'female' }, sign_waiver: true, ...extra } }), 201);
}
const myDay = async (token, date) => ok(await api('GET', `/skischool/pay/my-day?date=${date}`, { token }));

test('rates: a school default, an instructor\'s own rate, the latest in force; managers only', async () => {
  is(await rate(null, 'group', 3000), 201);
  is(await rate(null, 'private', 3600), 201);
  is(await rate(D.ivy, 'private', 4000), 201);
  is(await rate(null, 'private', 9900, plus(today, 300)), 201, 'a future rate is not in force yet');
  is(await rate(null, 'hourly', 2000), 201);
  is(await api('POST', '/skischool/pay/rates', { token: T.ivy, body: { staff_id: D.ivy, kind: 'private', cents: 99999 } }), 403, 'an instructor cannot set pay');
  is(await api('GET', '/skischool/pay/rates', { token: T.desk }), 403);
  const r = ok(await api('GET', '/skischool/pay/rates', { token: T.mgr }));
  assert.ok(r.rates.length >= 5 && r.instructors.some((i) => i.id === D.ivy));
  const rates = await q('SELECT staff_id, kind, cents, effective_from FROM instructor_pay_rates WHERE tenant_id = ?', [M.id]);
  assert.equal(P.rateFrom(rates, D.ivy, 'private', D1), 4000, 'her own rate');
  assert.equal(P.rateFrom(rates, D.max, 'private', D1), 3600, 'the default');
  assert.equal(P.rateFrom(rates, D.max, 'private', plus(today, 301)), 9900, 'the later rate from its day');
  assert.equal(P.rateFrom(rates, D.max, 'program', D1), null);
});

test('per lesson: the lesson rate, the request bonus on top, nothing for a lesson with no students', async () => {
  await settings({ pay_mode: 'per_lesson', lineup_paid: false, request_bonus_cents: 600 });
  D.g1 = await lesson(D4, '09:00', '11:00');
  D.p1 = await lesson(D4, '13:00', '14:00', { product_id: D.private, format: 'private' });
  D.empty = await lesson(D4, '15:00', '16:00');
  await book(D.g1);
  await book(D.p1, { requested_instructor_id: D.ivy });
  const day = await myDay(T.ivy, D4);
  assert.equal(day.lessons[D.g1].cents, 3000);
  assert.equal(day.lessons[D.g1].words, 'group lesson 30.00');
  assert.equal(day.lessons[D.p1].cents, 4600, 'private 40 + request 6');
  assert.equal(day.lessons[D.p1].words, 'private 40.00 + request 6.00');
  assert.equal(day.lessons[D.empty].cents, 0);
  assert.match(day.lessons[D.empty].note, /No students/);
  assert.equal(typeof day.waiting_requests, 'number');
});

test('lineup time is paid once per start time, at the hourly rate, only when the school pays it', async () => {
  await settings({ lineup_paid: true, lineup_minutes: 15 });
  // A second group class at the same start (a split at the lineup) shares the one lineup.
  const [s] = await pool.query("INSERT INTO lesson_sessions (tenant_id, product_id, discipline, format, starts_at, ends_at, capacity, instructor_id, origin) VALUES (?, ?, 'ski', 'group', ?, ?, 6, ?, 'split')", [M.id, D.group, `${D4} 09:00:00`, `${D4} 11:00:00`, D.ivy]);
  await book(s.insertId);
  const g2 = await lesson(D4, '11:00', '12:00');
  await book(g2);
  const { lines } = await P.lines(pool, M.id, { from: D4, to: D4, staffId: D.ivy });
  const lineups = lines.filter((l) => l.kind === 'lineup');
  assert.equal(lineups.length, 2, 'one at 9:00 (two classes), one at 11:00; none for the private');
  assert.ok(lineups.every((l) => l.cents === 500), '15 minutes at 20.00 an hour');
  const day = await myDay(T.ivy, D4);
  assert.equal(day.lessons[D.g1].cents + (day.lessons[s.insertId] ? day.lessons[s.insertId].cents : 0), 3000 + 500 + 3000, 'the lineup is folded into one of the 9:00 classes');
  await settings({ lineup_paid: false });
  assert.equal((await P.lines(pool, M.id, { from: D4, to: D4, staffId: D.ivy })).lines.filter((l) => l.kind === 'lineup').length, 0);
  D.split = s.insertId; D.g2 = g2;
});

test('hourly: the lesson minutes when there is no time card, the clocked time when there is; both adds the lesson rate', async () => {
  await settings({ pay_mode: 'hourly', lineup_paid: true });
  let day = await myDay(T.ivy, D4);
  assert.equal(day.lessons[D.g1].cents, 4000 + 500, '2 h at 20.00, plus the lineup');
  assert.match(day.lessons[D.g1].words, /2 h lesson time 40.00/);
  assert.equal(day.lessons[D.p1].cents, 2000 + 4000 + 600, '1 h, the private rate on top, and the request bonus');
  assert.match(day.lessons[D.g1].note, /lesson time/);
  // A time card on that day: 6.5 hours clocked, paid instead of lesson minutes and lineups.
  const [a] = require('../src/lib/util').dayRange('America/New_York', D4);
  const clockIn = new Date(`${a.replace(' ', 'T')}Z`); clockIn.setUTCHours(clockIn.getUTCHours() + 8, 30);
  const clockOut = new Date(clockIn); clockOut.setUTCMinutes(clockOut.getUTCMinutes() + 390);
  const iso = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  await q('INSERT INTO time_entries (tenant_id, staff_id, clock_in, clock_out) VALUES (?, ?, ?, ?)', [M.id, D.ivy, iso(clockIn), iso(clockOut)]);
  const { lines } = await P.lines(pool, M.id, { from: D4, to: D4, staffId: D.ivy });
  const card = lines.find((l) => l.kind === 'clock');
  assert.equal(card.minutes, 390);
  assert.equal(card.cents, 13000, '6.5 h at 20.00');
  assert.equal(lines.filter((l) => l.kind === 'lineup').length, 0, 'the time card covers the lineup');
  day = await myDay(T.ivy, D4);
  assert.equal(day.lessons[D.g1].cents, 0);
  assert.match(day.lessons[D.g1].note, /time card/);
  assert.equal(day.lessons[D.p1].cents, 4600, 'the private rate and bonus still on top');
  await settings({ pay_mode: 'both' });
  day = await myDay(T.ivy, D4);
  assert.equal(day.lessons[D.g1].cents, 3000, 'the group rate; the hours are on the time card');
  await q('DELETE FROM time_entries WHERE tenant_id = ? AND staff_id = ?', [M.id, D.ivy]);
  day = await myDay(T.ivy, D4);
  assert.equal(day.lessons[D.g1].cents, 3000 + 4000 + 500, 'both: the lesson rate, the hours and the lineup');
  await settings({ pay_mode: 'per_lesson', lineup_paid: false });
});

// ---------------------------------------------------------------- privates asked for by name
const contact = (tag) => ({ contact_first_name: 'Pat', contact_last_name: `Parent${tag}`, contact_email: `pat.${tag}.${suffix}@x.test`, contact_phone: '215-555-0150' });
const student = (first, extra = {}) => ({ first_name: first, last_name: `Fam${suffix}`, date_of_birth: `${year - 10}-03-03`, sex: 'male', level: 3, allergies: 'Peanuts', ...extra });
async function ask(body) {
  return pub('POST', '/private', { body: { offer_id: D.offer, discipline: 'ski', date: D1, time: '10:00', instructor: D.ivy, ...contact('a'), students: [student('Leo')], waiver_accepted: true, policy_accepted: true, ...body } });
}
async function payFor(token) {
  const row = (await q('SELECT * FROM private_requests WHERE tenant_id = ? AND token_sha = ?', [M.id, PR.sha(token)]))[0];
  ok(await webhook({ id: `evt_${++n}`, type: 'checkout.session.completed', data: { object: { id: row.stripe_session_id, payment_status: 'paid', amount_total: row.amount_cents, payment_intent: `pi_${row.stripe_session_id}`, metadata: { tenant_id: String(M.id), private_id: String(row.id), kind: 'private' } } } }));
  return (await q('SELECT * FROM private_requests WHERE id = ?', [row.id]))[0];
}

test('the private page: lengths, public instructors only, open times inside their open dates', async () => {
  is(await pub('GET', '/private'), 404, 'nothing offered yet');
  D.offer = ok(await api('POST', '/skischool/pay/private-offers', { token: T.owner, body: { product_id: D.private, minutes: 60, max_students: 2, extra_student_cents: 3000, meeting_place: 'Ski school bell' } }), 201).id;
  is(await api('POST', '/skischool/pay/private-offers', { token: T.ivy, body: { product_id: D.private, minutes: 90 } }), 403);
  const page = ok(await pub('GET', '/private'));
  assert.deepEqual(page.instructors.map((i) => i.name).sort(), ['Ivy I.', 'Max O.'], 'Zed is not listed');
  assert.equal(page.offers[0].price_cents, 14000);
  assert.ok(page.pay_online);
  const times = ok(await pub('GET', `/private/times?date=${D1}&offer_id=${D.offer}&instructor=${D.ivy}&discipline=ski&level=3`));
  assert.ok(times.times.some((x) => x.time === '09:00') && times.times.some((x) => x.time === '15:00'));
  assert.ok(!times.times.some((x) => x.time === '15:30'), 'a one-hour lesson must end by 4');
  assert.ok(times.open_days.includes(D1));
  assert.equal(ok(await pub('GET', `/private/times?date=${D4}&offer_id=${D.offer}&instructor=${D.ivy}&discipline=ski&level=3`)).times.length, 0, 'not open that day');
  is(await ask({ instructor: D.zed }), 400, 'not a public instructor');
  is(await ask({ students: [student('A'), student('B'), student('C')] }), 400, 'too many for this length');
});

test('a private asked for by name: paid, waiting with a deadline, shown on My day with its pay, accepted into a real lesson', async () => {
  await settings({ request_bonus_cents: 600, private_accept_minutes: 60, private_decline: 'offer_other' });
  const r = ok(await ask({ students: [student('Leo'), student('Mia', { sex: 'female', level: 4, photo_ok: true })] }), 201);
  assert.ok(r.checkout_url && r.token);
  assert.equal(r.amount_cents, 14000 + 3000);
  assert.equal(checkouts[checkouts.length - 1]['metadata[kind]'], 'private');
  // the time is held while the family pays
  assert.ok(!ok(await pub('GET', `/private/times?date=${D1}&offer_id=${D.offer}&instructor=${D.ivy}&discipline=ski&level=3`)).times.some((x) => x.time === '10:00'));
  let view = ok(await pub('GET', `/private/r/${r.token}`));
  assert.equal(view.status, 'awaiting_payment');
  is(await pub('GET', '/private/r/not-a-real-token-at-all-0123456789abcdef'), 404);
  const row = await payFor(r.token);
  assert.equal(row.status, 'waiting');
  assert.ok(row.deadline_at, 'the clock is running');
  assert.ok(mails.some((m) => m.To === `ivy@${M.slug}.test` && /Private lesson request/.test(m.Subject)), 'Ivy is told');
  view = ok(await pub('GET', `/private/r/${r.token}`));
  assert.equal(view.status, 'waiting'); assert.equal(view.instructor, 'Ivy I.');
  const day = await myDay(T.ivy, D1);
  assert.equal(day.waiting_requests, 1);
  assert.equal(day.requests[0].pay.cents, 4000 + 600, 'her private rate and the request bonus');
  assert.equal(day.requests[0].students.length, 2);
  assert.equal((await myDay(T.max, D1)).waiting_requests, 0, 'not sent to Max');
  is(await api('POST', `/skischool/pay/requests/${row.id}/accept`, { token: T.max }), 409, 'Max cannot take Ivy\'s request');
  const acc = ok(await api('POST', `/skischool/pay/requests/${row.id}/accept`, { token: T.ivy }));
  const s = (await q('SELECT * FROM lesson_sessions WHERE id = ?', [acc.session_id]))[0];
  assert.equal(s.origin, 'request'); assert.equal(s.format, 'private'); assert.equal(s.instructor_id, D.ivy);
  assert.equal(s.capacity, 2); assert.equal(s.level_min, 3); assert.equal(s.level_max, 4); assert.equal(s.meeting_place, 'Ski school bell');
  const bookings = await q('SELECT * FROM lesson_bookings WHERE session_id = ? ORDER BY id', [acc.session_id]);
  assert.equal(bookings.length, 2);
  assert.ok(bookings.every((b) => b.requested_instructor_id === D.ivy && b.unpaid === 0 && b.allergies === 'Peanuts'));
  assert.deepEqual(bookings.map((b) => b.photo_ok), [0, 1], 'photos only where the family said yes');
  const lr = (await q('SELECT * FROM lesson_requests WHERE id = (SELECT lesson_request_id FROM private_requests WHERE id = ?)', [row.id]))[0];
  assert.equal(lr.status, 'confirmed'); assert.ok(lr.order_id, 'the sale is in the books');
  const order = (await q('SELECT total_cents, status FROM orders WHERE id = ?', [lr.order_id]))[0];
  assert.equal(order.total_cents, 17000);
  assert.equal(ok(await pub('GET', `/private/r/${r.token}`)).status, 'accepted');
  assert.equal((await myDay(T.ivy, D1)).lessons[acc.session_id].cents, 4600, 'the pay line on My day');
  is(await api('POST', `/skischool/pay/requests/${row.id}/accept`, { token: T.ivy }), 409, 'only once');
  D.leoSession = acc.session_id;
});

test('accepting refuses a clash: the instructor busy, or a student already in a lesson then; nothing is half made', async () => {
  // Max is asked for 13:00 on D1; Ivy is given it by hand while she teaches then.
  const r = ok(await ask({ instructor: D.max, time: '13:00', ...contact('b'), students: [student('Leo')] }), 201);
  const row = await payFor(r.token);
  const busy = await lesson(D1, '12:30', '14:00');
  is(await api('POST', `/skischool/pay/requests/${row.id}/assign`, { token: T.desk, body: { staff_id: D.ivy } }), 409, 'Ivy teaches then');
  // Leo (the same family) is booked in a group lesson at 13:00 with Ivy: Max accepting must refuse.
  const leo = (await q('SELECT b.person_id FROM lesson_bookings b JOIN people p ON p.id = b.person_id WHERE b.session_id = ? AND p.first_name = ?', [D.leoSession, 'Leo']))[0].person_id;
  ok(await api('POST', `/skischool/sessions/${busy}/bookings`, { token: T.desk, body: { person_id: leo } }), 201);
  const before = (await q('SELECT COUNT(*) AS n FROM lesson_sessions WHERE tenant_id = ?', [M.id]))[0].n;
  const res = await api('POST', `/skischool/pay/requests/${row.id}/accept`, { token: T.max });
  is(res, 409, 'Leo is in a lesson then');
  assert.match(res.body.error, /Leo/);
  assert.equal((await q('SELECT COUNT(*) AS n FROM lesson_sessions WHERE tenant_id = ?', [M.id]))[0].n, before, 'no lesson left behind');
  assert.equal((await q('SELECT status FROM private_requests WHERE id = ?', [row.id]))[0].status, 'waiting', 'still waiting');
  D.clashRequest = row.id;
});

test('decline with "offer another instructor": the family picks one, the clock restarts; no answer then refunds in full', async () => {
  const r = ok(await ask({ instructor: D.ivy, date: D2, time: '11:00', ...contact('c') }), 201);
  const row = await payFor(r.token);
  const out = ok(await api('POST', `/skischool/pay/requests/${row.id}/decline`, { token: T.ivy, body: { reason: 'Racing that day' } }));
  assert.equal(out.outcome, 'offered');
  assert.ok(mails.some((m) => m.To === `pat.c.${suffix}@x.test` && /Pick another instructor/.test(m.Subject)), 'the family is asked to pick');
  // A new link went out by email; the old one still names the same request until replaced, so read the new one from the mail.
  const mail = mails.filter((m) => m.To === `pat.c.${suffix}@x.test` && /Pick another/.test(m.Subject)).pop();
  const token = mail.TextBody.match(/\?r=([A-Za-z0-9_-]+)/)[1];
  let view = ok(await pub('GET', `/private/r/${token}`));
  assert.equal(view.status, 'offered');
  assert.deepEqual(view.choices.map((c) => c.id), [D.max], 'Max is free then; Ivy declined');
  is(await pub('POST', `/private/r/${token}/pick`, { body: { instructor: D.ivy } }), 409, 'not Ivy again');
  view = ok(await pub('POST', `/private/r/${token}/pick`, { body: { instructor: D.max } }));
  assert.equal(view.status, 'waiting'); assert.equal(view.instructor, 'Max O.');
  assert.equal((await myDay(T.max, D2)).requests.filter((x) => x.starts_at.startsWith(D2)).length, 1);
  // Max does not answer in time: nobody else is free, so the whole payment goes back.
  await q('UPDATE private_requests SET deadline_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE id = ?', [row.id]);
  const before = refunds.length;
  const tick = await require('../src/routes/schoolpay').tick();
  assert.ok(tick.expired >= 1);
  const after = (await q('SELECT status, refund_cents FROM private_requests WHERE id = ?', [row.id]))[0];
  assert.equal(after.status, 'refunded'); assert.equal(after.refund_cents, 14000);
  assert.equal(refunds.length, before + 1, 'sent to Stripe');
  assert.equal(refunds[refunds.length - 1].payment_intent, row.payment_intent);
  assert.equal(Number(refunds[refunds.length - 1].amount), 14000);
});

test('decline with "refund": the family is refunded straight away; the family can also cancel while it waits', async () => {
  await settings({ private_decline: 'refund' });
  const r = ok(await ask({ instructor: D.max, date: D2, time: '14:00', ...contact('d') }), 201);
  const row = await payFor(r.token);
  const before = refunds.length;
  assert.equal(ok(await api('POST', `/skischool/pay/requests/${row.id}/decline`, { token: T.max, body: {} })).outcome, 'refunded');
  assert.equal(refunds.length, before + 1);
  assert.ok(mails.some((m) => m.To === `pat.d.${suffix}@x.test` && /refunded in full/.test(m.TextBody)));
  is(await api('POST', `/skischool/pay/requests/${row.id}/accept`, { token: T.max }), 409, 'closed');
  // The family changes their mind before anyone answers.
  const r2 = ok(await ask({ instructor: D.max, date: D3, time: '09:00', ...contact('e') }), 201);
  await payFor(r2.token);
  const back = ok(await pub('POST', `/private/r/${r2.token}/refund`));
  assert.equal(back.refund_cents, 14000); assert.equal(back.status, 'refunded');
  await settings({ private_decline: 'offer_other' });
});

test('with card payment off, the request goes straight to the instructor and the family pays at the desk', async () => {
  ok(await api('PUT', '/tenant/profile', { token: T.owner, body: { online_payment: false } }));
  const r = ok(await ask({ instructor: 'any', date: D3, time: '13:00', ...contact('f') }), 201);
  assert.equal(r.status, 'waiting'); assert.ok(!r.checkout_url);
  const row = (await q('SELECT * FROM private_requests WHERE tenant_id = ? AND reference = ?', [M.id, r.reference]))[0];
  assert.equal(row.any_instructor, 1);
  assert.equal((await myDay(T.max, D3)).requests.filter((x) => x.id === row.id).length, 1, 'any instructor who teaches it sees it');
  assert.equal(ok(await api('POST', `/skischool/pay/requests/${row.id}/decline`, { token: T.ivy, body: {} })).outcome, 'passed', 'one no leaves it open for the others');
  assert.equal((await myDay(T.ivy, D3)).requests.filter((x) => x.id === row.id).length, 0);
  const acc = ok(await api('POST', `/skischool/pay/requests/${row.id}/accept`, { token: T.max }));
  const b = (await q('SELECT unpaid, requested_instructor_id FROM lesson_bookings WHERE session_id = ?', [acc.session_id]))[0];
  assert.equal(b.unpaid, 1, 'paid at the desk');
  assert.equal(b.requested_instructor_id, null, 'no request bonus for "any instructor"');
  const staffList = ok(await api('GET', '/skischool/pay/requests?scope=all&status=all', { token: T.desk }));
  assert.ok(staffList.requests.some((x) => x.id === row.id && x.status === 'accepted' && x.staff_name === 'Max Other'));
  ok(await api('PUT', '/tenant/profile', { token: T.owner, body: { online_payment: true } }));
});

test('a private with a child goes only to instructors who teach kids; with no teaching profile, nobody is cleared', async () => {
  ok(await api('PUT', '/tenant/profile', { token: T.owner, body: { online_payment: false } }));
  await q('UPDATE instructor_profiles SET teaches_kids = 0 WHERE tenant_id = ? AND staff_id = ?', [M.id, D.max]);
  const r = ok(await ask({ instructor: 'any', date: D3, time: '15:00', ...contact('k'), students: [student('Kit')] }), 201); // Kit is 10
  const row = (await q('SELECT * FROM private_requests WHERE tenant_id = ? AND reference = ?', [M.id, r.reference]))[0];
  assert.equal((await myDay(T.max, D3)).requests.filter((x) => x.id === row.id).length, 0, 'not listed for an instructor who does not teach kids');
  is(await api('POST', `/skischool/pay/requests/${row.id}/accept`, { token: T.max }), 409, 'and cannot be accepted by one');
  // an adult private is fine for Max
  const adult = ok(await ask({ instructor: 'any', date: D3, time: '15:00', ...contact('ad'), students: [student('Abe', { date_of_birth: '1980-03-03' })] }), 201);
  const arow = (await q('SELECT id FROM private_requests WHERE tenant_id = ? AND reference = ?', [M.id, adult.reference]))[0];
  assert.equal((await myDay(T.max, D3)).requests.filter((x) => x.id === arow.id).length, 1);
  // no teaching profile on file: not cleared for anything (never "cleared for everything")
  const [prof] = await q('SELECT * FROM instructor_profiles WHERE tenant_id = ? AND staff_id = ?', [M.id, D.max]);
  await q('DELETE FROM instructor_profiles WHERE tenant_id = ? AND staff_id = ?', [M.id, D.max]);
  assert.equal((await myDay(T.max, D3)).requests.filter((x) => x.id === arow.id).length, 0);
  const no = await api('POST', `/skischool/pay/requests/${arow.id}/accept`, { token: T.max });
  assert.equal(no.status, 409); assert.match(no.body.error, /not set up/);
  await q('INSERT INTO instructor_profiles SET ?', [prof]);
  await q('UPDATE instructor_profiles SET teaches_kids = 1 WHERE tenant_id = ? AND staff_id = ?', [M.id, D.max]);
  await q("UPDATE private_requests SET status = 'declined' WHERE id IN (?)", [[row.id, arow.id]]);
  ok(await api('PUT', '/tenant/profile', { token: T.owner, body: { online_payment: true } }));
});

test('tips show in My pay by lesson; an instructor sees only their own pay', async () => {
  const leoBooking = (await q('SELECT id FROM lesson_bookings WHERE session_id = ? LIMIT 1', [D.leoSession]))[0].id;
  await q("INSERT INTO lesson_tips (tenant_id, booking_id, session_id, staff_id, amount_cents, status, paid_at) VALUES (?, ?, ?, ?, 1500, 'paid', UTC_TIMESTAMP()), (?, ?, ?, ?, 900, 'pending', NULL)",
    [M.id, leoBooking, D.leoSession, D.ivy, M.id, leoBooking, D.leoSession, D.ivy]);
  const mine = ok(await api('GET', `/skischool/pay/mine?from=${today}&to=${D4}`, { token: T.ivy }));
  const tips = mine.lines.filter((l) => l.tip);
  assert.equal(tips.length, 1, 'only the paid tip');
  assert.equal(mine.tips_cents, 1500);
  assert.ok(mine.total_cents > 0 && mine.lines.some((l) => l.kind === 'lesson'));
  assert.ok(mine.lines.every((l) => l.staff_id === D.ivy));
  is(await api('GET', `/skischool/pay/mine?staff_id=${D.ivy}`, { token: T.max }), 403, 'not another instructor\'s pay');
  const maxPay = ok(await api('GET', `/skischool/pay/mine?from=${today}&to=${D4}`, { token: T.max }));
  assert.equal(maxPay.tips_cents, 0); assert.ok(maxPay.lines.every((l) => l.staff_id === D.max));
  is(await api('GET', `/skischool/pay/payroll?from=${today}&to=${D4}`, { token: T.ivy }), 403);
  is(await api('GET', `/skischool/pay/my-day?date=${D1}&staff_id=${D.max}`, { token: T.ivy }), 403);
  ok(await api('GET', `/skischool/pay/mine?staff_id=${D.ivy}&from=${today}&to=${D4}`, { token: T.mgr }));
  const askQ = ok(await api('POST', '/skischool/pay/question', { token: T.ivy, body: { line: 'Group Lesson: group lesson 30.00', message: 'Was my lineup counted?' } }));
  assert.ok(askQ.sent >= 1, 'emailed to the managers');
});

test('payroll: approve, export CSV with tips listed apart, mark tips paid out, never pay a line twice', async () => {
  // Only lessons that have ended are paid: Ivy's lessons on D4 are still ahead, so the period lists them as later.
  const ahead = ok(await api('GET', `/skischool/pay/payroll?from=${today}&to=${D4}`, { token: T.mgr }));
  assert.ok(ahead.later > 0, 'lessons not over yet are counted apart');
  assert.ok(!ahead.instructors.some((g) => g.lines.some((l) => l.kind === 'lesson' || l.kind === 'lineup')), 'and are not in the export');
  // Those lessons are taught: they move to yesterday.
  await q('UPDATE lesson_sessions SET starts_at = starts_at - INTERVAL 7 DAY, ends_at = ends_at - INTERVAL 7 DAY WHERE tenant_id = ? AND DATE(starts_at) = ?', [M.id, D4]);
  const from = plus(today, -1); const to = D4;
  const p = ok(await api('GET', `/skischool/pay/payroll?from=${from}&to=${to}`, { token: T.mgr }));
  const ivy = p.instructors.find((g) => g.staff_id === D.ivy);
  assert.ok(ivy && ivy.pay_cents > 0 && ivy.tips_cents === 1500);
  is(await api('POST', '/skischool/pay/payroll/export', { token: T.mgr, body: { from, to } }), 409, 'nothing approved yet');
  const ap = ok(await api('POST', '/skischool/pay/payroll/approve', { token: T.mgr, body: { from, to, staff_ids: [D.ivy], approved: true } }));
  assert.ok(ap.instructors.find((g) => g.staff_id === D.ivy).approved);
  const ex = ok(await api('POST', '/skischool/pay/payroll/export', { token: T.mgr, body: { from, to } }));
  assert.ok(ex.lines > 0 && ex.tips === 1);
  assert.match(ex.lines_csv, /"Ivy Instructor"/);
  assert.match(ex.lines_csv, /tips \(pass-through\)","[^"]*","1 line","","15.00"/);
  assert.doesNotMatch(ex.lines_csv, /Max Other/, 'Max was not approved');
  const sum = ex.summary_csv.split('\r\n');
  assert.equal(sum[0], '"instructor","staff_id","hours","lessons","lineup","hourly","program","request_bonus","pay_total","tips_pass_through"'.replace(/"/g, ''));
  assert.match(sum[1], /"Ivy Instructor".*"15.00"$/);
  assert.ok((await q("SELECT paid_out_at FROM lesson_tips WHERE tenant_id = ? AND status = 'paid'", [M.id]))[0].paid_out_at, 'tip marked paid out');
  // A longer period that overlaps does not pay Ivy's exported lines again.
  const later = ok(await api('GET', `/skischool/pay/payroll?from=${plus(today, -2)}&to=${D4}`, { token: T.mgr }));
  assert.ok(!later.instructors.some((g) => g.staff_id === D.ivy && g.lines.some((l) => l.kind === 'lesson')), 'already paid');
  assert.ok(later.earlier > 0);
  const runs = ok(await api('GET', '/skischool/pay/payroll/runs', { token: T.mgr }));
  assert.ok(runs.runs.some((r) => r.id === ex.run_id));
  const csv = await fetch(`${base}/api/v1/skischool/pay/payroll/runs/${ex.run_id}/summary.csv`, { headers: { authorization: `Bearer ${T.mgr}`, 'x-device': DEVICE } });
  assert.equal(csv.status, 200); assert.match(await csv.text(), /Ivy Instructor/);
  const mine = ok(await api('GET', `/skischool/pay/mine?from=${from}&to=${today}`, { token: T.ivy }));
  assert.ok(mine.lines.filter((l) => !l.tip && l.cents > 0).every((l) => l.paid), 'My pay shows them as paid');
});

test('a weather delay never makes a second lineup line, and a canceled lesson is never paid', async () => {
  await settings({ pay_mode: 'both', lineup_paid: true, lineup_minutes: 15 });
  const day = plus(today, 9);
  const a = await lesson(day, '09:00', '11:00');
  await book(a);
  const before = (await P.lines(pool, M.id, { from: day, to: day, staffId: D.ivy })).lines.filter((l) => l.kind === 'lineup');
  assert.equal(before.length, 1);
  // A 30 minute weather delay moves the lesson and notes the delay; the lineup keeps its key (its first start time).
  await q('UPDATE lesson_sessions SET starts_at = starts_at + INTERVAL 30 MINUTE, ends_at = ends_at + INTERVAL 30 MINUTE, delay_minutes = 30 WHERE id = ?', [a]);
  const after = (await P.lines(pool, M.id, { from: day, to: day, staffId: D.ivy })).lines.filter((l) => l.kind === 'lineup');
  assert.equal(after.length, 1);
  assert.equal(after[0].key, before[0].key, 'same lineup, same line, so an export after the delay cannot pay it twice');
  // canceled: no line at all
  await q("UPDATE lesson_sessions SET status = 'cancelled' WHERE id = ?", [a]);
  assert.equal((await P.lines(pool, M.id, { from: day, to: day, staffId: D.ivy })).lines.filter((l) => l.session_id === a).length, 0);
  // lineDone: a lesson is paid only once it has ended, a time card once its day is over
  assert.equal(P.lineDone({ kind: 'lesson', ends_at: `${day} 11:00:00` }, `${day} 10:59:00`), false);
  assert.equal(P.lineDone({ kind: 'lesson', ends_at: `${day} 11:00:00` }, `${day} 11:00:00`), true);
  assert.equal(P.lineDone({ kind: 'lineup', ends_at: `${day} 09:00:00`, done_at: `${day} 11:00:00` }, `${day} 10:00:00`), false, 'a lineup waits for its lesson to end');
  assert.equal(P.lineDone({ kind: 'clock', day }, `${day} 23:00:00`), false);
  assert.equal(P.lineDone({ kind: 'clock', day }, `${plus(day, 1)} 00:01:00`), true);
});

test('rebook my guests: past private guests, an offer email with the prefilled link, a manager books one directly', async () => {
  const g = ok(await api('GET', '/skischool/pay/guests', { token: T.ivy }));
  // Leo and Mia's private was on D1, still ahead: guests are past lessons, so move it back a week for this check.
  await q('UPDATE lesson_sessions SET starts_at = starts_at - INTERVAL 8 DAY, ends_at = ends_at - INTERVAL 8 DAY WHERE id = ?', [D.leoSession]);
  const g2 = ok(await api('GET', '/skischool/pay/guests', { token: T.ivy }));
  assert.ok(g2.guests.length > g.guests.length);
  const leo = g2.guests.find((x) => x.first_name === 'Leo');
  assert.ok(leo && leo.reachable);
  const before = mails.length;
  ok(await api('POST', `/skischool/pay/guests/${leo.person_id}/offer`, { token: T.ivy, body: { message: 'Leo was flying last week!' } }));
  const m = mails.slice(before).find((x) => x.To === `pat.a.${suffix}@x.test`);
  assert.ok(m && m.TextBody.includes(`/private/${M.slug}?i=${D.ivy}`));
  is(await api('POST', `/skischool/pay/guests/${leo.person_id}/book`, { token: T.ivy, body: { staff_id: D.ivy, offer_id: D.offer, starts_at: `${D3}T15:00` } }), 403, 'managers book directly');
  const bk = ok(await api('POST', `/skischool/pay/guests/${leo.person_id}/book`, { token: T.mgr, body: { staff_id: D.ivy, offer_id: D.offer, starts_at: `${D3}T15:00` } }), 201);
  const s = (await q('SELECT origin, format, instructor_id FROM lesson_sessions WHERE id = ?', [bk.session_id]))[0];
  assert.equal(s.origin, 'rebook'); assert.equal(s.format, 'private');
  const b = (await q('SELECT allergies, requested_instructor_id, unpaid FROM lesson_bookings WHERE id = ?', [bk.booking_id]))[0];
  assert.equal(b.allergies, 'Peanuts', 'safety details carried over'); assert.equal(b.unpaid, 1);
  is(await api('POST', `/skischool/pay/guests/${leo.person_id}/book`, { token: T.mgr, body: { staff_id: D.max, offer_id: D.offer, starts_at: `${D3}T15:00` } }), 409, 'Leo is already in a lesson then');
});
