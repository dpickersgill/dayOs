'use strict';

// The ski school's families (Track PARENTS): find my level, the family booking basket with tickets and rentals, the family
// lesson page by its link, changing a date, recaps (approval, photos, the AI writer), tips, the waitlist, and texts only
// with the add-on. Stripe, Postmark and Twilio are mocks; the Stripe webhook is signed like the real one.
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
const sms = require('../src/lib/sms');
const modules = require('../src/lib/modules');
const links = require('../src/lib/lessonlinks');
const assistant = require('../src/lib/assistant');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base; let mock; let pm; let n = 0;
const calls = []; const mails = []; const texts = []; const pages = new Map();
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const q = async (sql, params) => (await pool.query(sql, params))[0];
const year = new Date().getFullYear();

async function call(prefix, method, path, { token, body, raw, type } = {}) {
  const headers = { 'x-device': 'test-device-0123456789abcdef', 'content-type': type || 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const res = await fetch(`${base}${prefix}${path}`, { method, headers, body: raw || (body ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text, type: res.headers.get('content-type') };
}
const api = (m, p, o) => call('/api/v1', m, p, o);
const wall = (hoursAhead) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(Date.now() + hoursAhead * 3_600_000));
async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'x-device': 'test-device-0123456789abcdef', 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: `Mount ${slug}`, phone: '215-555-0000', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const owner = (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token;
  return { slug, owner, id: (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id };
}
const webhook = async (event) => {
  const raw = JSON.stringify(event);
  const res = await fetch(`${base}/api/v1/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripe.signWebhook(raw, 'whsec_mock') }, body: raw });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const paid = (sessionId, amount, metadata) => ({ id: `evt_${++n}`, type: 'checkout.session.completed', data: { object: { id: sessionId, payment_status: 'paid', amount_total: amount, payment_intent: `pi_${sessionId}`, metadata } } });

let A; let B; let pub; const D = {}; const T = {};
async function lesson(hoursAhead, extra = {}) {
  const e = { capacity: 4, level_min: null, level_max: null, age_min: null, age_max: null, discipline: 'ski', product: D.group, hours: 2, instructor: null, ...extra };
  const [r] = await pool.query("INSERT INTO lesson_sessions (tenant_id, product_id, discipline, starts_at, ends_at, capacity, status, level_min, level_max, age_min, age_max, instructor_id, format) VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, 'group')",
    [A.id, e.product, e.discipline, wall(hoursAhead), wall(hoursAhead + e.hours), e.capacity, e.level_min, e.level_max, e.age_min, e.age_max, e.instructor]);
  return r.insertId;
}
async function personAndBooking(sessionId, first, extra = {}) {
  const [p] = await pool.query('INSERT INTO people (tenant_id, first_name, last_name, date_of_birth) VALUES (?, ?, ?, ?)', [A.id, first, 'Family', `${year - 8}-03-03`]);
  const [b] = await pool.query("INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status, contact_email, contact_phone, photo_ok, text_ok, allergies) VALUES (?, ?, ?, 'booked', ?, '215-555-0199', ?, ?, ?)",
    [A.id, sessionId, p.insertId, `${first.toLowerCase()}.parent@x.test`, extra.photo_ok ? 1 : 0, extra.text_ok ? 1 : 0, extra.allergies || null]);
  const token = await links.issue(pool, A.id, b.insertId);
  return { person: p.insertId, booking: b.insertId, token };
}
const kid = (first, age = 8, extra = {}) => ({ first_name: first, last_name: 'Family', date_of_birth: `${year - age}-02-01`, sex: 'female', ...extra });
const basket = (items, extra = {}) => ({ contact_first_name: 'Pat', contact_last_name: 'Parent', contact_email: 'pat@x.test', contact_phone: '215-555-0100', items, waiver_accepted: true, policy_accepted: true, ...extra });

test.before(async () => {
  mock = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const params = Object.fromEntries(new URLSearchParams(data));
      calls.push({ path: req.url, params });
      res.setHeader('content-type', 'application/json');
      let m;
      if (req.url === '/v1/checkout/sessions') { const id = `cs_test_${++n}`; pages.set(id, { id, status: 'open', amount_total: Number(params['line_items[0][price_data][unit_amount]']) }); res.end(JSON.stringify({ id, url: `https://checkout.stripe.test/c/${n}` })); }
      else if ((m = req.url.match(/^\/v1\/checkout\/sessions\/(cs_test_\d+)$/))) res.end(JSON.stringify(pages.get(m[1]) || {}));
      else if (req.url === '/v1/refunds') res.end(JSON.stringify({ id: `re_${++n}`, status: 'succeeded' }));
      else if (req.url.startsWith('/v1/refunds?')) res.end(JSON.stringify({ data: [] }));
      else { res.statusCode = 404; res.end('{}'); }
    });
  });
  pm = http.createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { mails.push(JSON.parse(d)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m-${++n}` })); }); });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  await new Promise((r) => pm.listen(0, '127.0.0.1', r));
  config.stripe.apiBase = `http://127.0.0.1:${mock.address().port}`;
  mailer.settings.apiBase = `http://127.0.0.1:${pm.address().port}`;
  sms.send = async (m) => { texts.push(m); return { ok: true }; }; // familynotify calls sms.send: record instead of sending
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`pa-${suffix}`); B = await mountain(`pb-${suffix}`);
  pub = (m, p, o) => call('/api/v1/public', m, `/${A.slug}${p}`, o);
  const mk = async (body) => { const r = await api('POST', '/products', { token: A.owner, body }); assert.equal(r.status, 201, r.text); return r.body.id; };
  D.group = await mk({ kind: 'lesson', name: 'Kids Group', base_price_cents: 8000 });
  D.other = await mk({ kind: 'lesson', name: 'Adult Group', base_price_cents: 9000 });
  D.ticket = await mk({ kind: 'day_ticket', name: 'Day ticket', base_price_cents: 6000 });
  D.rental = await mk({ kind: 'rental', name: 'Ski rental', base_price_cents: 3500 });
  assert.equal((await api('PUT', '/tenant/profile', { token: A.owner, body: { online_booking: true, booking_notice_hours: 1, online_payment: true, refund_full_hours: 48, refund_half_hours: 24, refund_half_percent: 50, waiver_text: 'I accept the risks.' } })).status, 200);
  // Instructors: Ivy teaches the lessons below; Max is another instructor.
  for (const [k, first] of [['ivy', 'Ivy'], ['max', 'Max']]) {
    const st = await api('POST', '/workforce/staff', { token: A.owner, body: { person: { first_name: first, last_name: 'Teacher' }, status: 'active' } });
    D[k] = st.body.id;
    assert.equal((await api('POST', '/users', { token: A.owner, body: { email: `${k}@${A.slug}.test`, password: PW, role: 'instructor', staff_id: D[k] } })).status, 201);
    T[k] = (await api('POST', '/auth/login', { body: { tenant: A.slug, email: `${k}@${A.slug}.test`, password: PW } })).body.token;
  }
  assert.equal((await api('POST', '/users', { token: A.owner, body: { email: `desk@${A.slug}.test`, password: PW, role: 'counter' } })).status, 201);
  T.desk = (await api('POST', '/auth/login', { body: { tenant: A.slug, email: `desk@${A.slug}.test`, password: PW } })).body.token;
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => mock.close(r)); await new Promise((r) => pm.close(r)); await pool.end(); });

test('find my level: the answers map to the nine levels, and the page and server agree', async () => {
  const Q = require('../src/lib/levelquiz');
  assert.deepEqual(Q.levelFor('ski', [0]), { level: 1 }, 'never skied');
  assert.deepEqual(Q.levelFor('ski', [1, 0]), { level: 2 });
  assert.deepEqual(Q.levelFor('ski', [1, 1, 0]), { level: 3 });
  assert.deepEqual(Q.levelFor('ski', [1, 1, 1, 0]), { level: 4 });
  assert.deepEqual(Q.levelFor('ski', [1, 1, 1, 1]), { level: 5 });
  assert.deepEqual(Q.levelFor('ski', [1, 1, 1, 2, 0]), { level: 6 });
  assert.deepEqual(Q.levelFor('snowboard', [1, 1, 1, 2, 3]), { level: 9 });
  assert.deepEqual(Q.levelFor('ski', [1, 1]), { next: 2 }, 'still a question to answer');
  assert.equal(Q.levelFor('ski', [7]), null, 'a bad answer');
  for (const d of ['ski', 'snowboard']) assert.equal(Q.QUESTIONS[d].length, 5, 'five questions');
  const page = await import('../public/js/levelquiz.js');
  assert.deepEqual(page.QUESTIONS, Q.QUESTIONS, 'public/js/levelquiz.js matches the server');
  const r = await pub('GET', '/level-quiz');
  assert.equal(r.status, 200);
  assert.equal(r.body.levels.ski.length, 9);
  assert.equal((await call('/api/v1/public', 'GET', '/no-such-mountain/level-quiz')).status, 404);
});

test('the booking page gives level ranges and ages, a fits rule, and holds no private data', async () => {
  D.l1 = await lesson(100, { level_min: 1, level_max: 2, age_min: 5, age_max: 12 });
  D.l2 = await lesson(100, { level_min: 5, level_max: 7, age_min: 5, age_max: 12, product: D.other });
  const page = (await pub('GET', '/booking')).body;
  const one = page.lessons.find((l) => l.id === D.l1);
  assert.equal(one.level_words, 'Levels 1 to 2');
  assert.equal(one.ages, 'Ages 5 to 12');
  assert.equal(page.assistant, false, 'no assistant without Assistant Plus, so the page does not ask for it');
  assert.equal(page.texts_available, false);
  const F = require('../src/lib/lessonfamily');
  assert.equal(F.fits({ level_min: 1, level_max: 2, age_min: 5, age_max: 12 }, { age: 8, level: 1 }), true);
  assert.equal(F.fits({ level_min: 1, level_max: 2, age_min: 5, age_max: 12 }, { age: 8, level: 4 }), false, 'level too high');
  assert.equal(F.fits({ level_min: 1, level_max: 2, age_min: 5, age_max: 12 }, { age: 30, level: 1 }), false, 'too old');
  assert.equal(F.fits({ level_min: null, level_max: null }, { age: 30, level: 9 }), true, 'a lesson with no range takes anyone');
  // the server refuses a student outside the lesson's ages
  const r = await pub('POST', '/lesson-basket', { body: basket([{ session_id: D.l1, student: kid('Ada', 30) }]) });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Ages 5 to 12/i);
});

test('family booking: two children, two lessons, a ticket and a rental, one payment; safety details, level and rentals to fit', async () => {
  assert.equal((await api('PUT', `/skischool/families/extras/${D.group}`, { token: A.owner, body: { ticket_product_id: D.ticket, rental_product_id: D.rental } })).status, 200);
  assert.equal((await api('PUT', `/skischool/families/extras/${D.group}`, { token: T.desk, body: { ticket_product_id: D.ticket, rental_product_id: null } })).status, 403);
  const page = (await pub('GET', '/booking')).body;
  assert.equal(page.lessons.find((l) => l.id === D.l1).offers_ticket, true);
  assert.equal(page.lessons.find((l) => l.id === D.l2).offers_rental, false);
  const items = [
    { session_id: D.l1, student: kid('Mia', 8, { level: 2, discipline: 'ski', allergies: 'Peanuts', pickup: 'Grandma Jo', photo_ok: true, text_ok: true }), ticket: true, rental: true },
    { session_id: D.l2, student: kid('Leo', 10, { level: 6, discipline: 'ski' }) },
  ];
  const quote = await pub('POST', '/lesson-basket/quote', { body: { items } });
  assert.equal(quote.status, 200, quote.text);
  assert.equal(quote.body.total_cents, 8000 + 6000 + 3500 + 9000, 'two lessons, a ticket and a rental');
  assert.equal((await pub('POST', '/lesson-basket', { body: basket(items, { waiver_accepted: false }) })).status, 400);
  const made = await pub('POST', '/lesson-basket', { body: basket(items) });
  assert.equal(made.status, 201, made.text);
  assert.ok(made.body.checkout_url);
  assert.equal(made.body.amount_cents, 26500);
  assert.equal(calls.filter((c) => c.path === '/v1/checkout/sessions').at(-1).params['line_items[0][price_data][unit_amount]'], '26500');
  const bk = (await q('SELECT * FROM lesson_baskets WHERE tenant_id = ? AND reference = ?', [A.id, made.body.reference]))[0];
  assert.equal(bk.status, 'awaiting_payment');
  assert.equal((await q('SELECT COUNT(*) AS n FROM lesson_requests WHERE basket_id = ?', [bk.id]))[0].n, 2, 'one request per lesson');
  // the spots are held while the family pays
  assert.equal((await pub('GET', '/booking')).body.lessons.find((l) => l.id === D.l1).spots_left, 3);
  const w = await webhook(paid(bk.stripe_session_id, 26500, { kind: 'lesson_basket', tenant_id: String(A.id), basket_id: String(bk.id), reference: bk.reference }));
  assert.equal(w.status, 200, JSON.stringify(w.body));
  assert.equal((await webhook(paid(bk.stripe_session_id, 26500, { kind: 'lesson_basket', tenant_id: String(A.id), basket_id: String(bk.id) }))).body.duplicate, true, 'a repeat is harmless');
  assert.equal((await q('SELECT status FROM lesson_baskets WHERE id = ?', [bk.id]))[0].status, 'paid');
  const mia = (await q("SELECT b.*, p.ski_level, p.level_source FROM lesson_bookings b JOIN people p ON p.id = b.person_id WHERE b.tenant_id = ? AND b.session_id = ? AND p.first_name = 'Mia'", [A.id, D.l1]))[0];
  assert.equal(mia.allergies, 'Peanuts');
  assert.equal(mia.pickup, 'Grandma Jo');
  assert.equal(mia.photo_ok, 1);
  assert.equal(mia.level, 2);
  assert.equal(mia.contact_email, 'pat@x.test');
  assert.equal(mia.ski_level, 2, 'the quiz level is saved on the child');
  assert.equal(mia.level_source, 'quiz');
  assert.equal(mia.unpaid, 0);
  const extras = (await q('SELECT oi.line_kind, oi.unit_price_cents, oi.contract_id FROM order_items oi JOIN lesson_baskets b ON b.extras_order_id = oi.order_id WHERE b.id = ? ORDER BY oi.id', [bk.id]));
  assert.deepEqual(extras.map((x) => [x.line_kind, x.unit_price_cents]), [['ticket', 6000], ['rental', 3500]]);
  const contract = (await q('SELECT status, person_id, valid_on FROM rental_contracts WHERE id = ?', [extras[1].contract_id]))[0];
  assert.equal(contract.status, 'to_fit', 'the rental waits in the rental shop\'s Ready to fit');
  assert.equal(contract.person_id, mia.person_id, 'for the child, not the parent');
  assert.equal((await q('SELECT COUNT(*) AS n FROM tickets t JOIN order_items oi ON oi.id = t.order_item_id WHERE oi.order_id = (SELECT extras_order_id FROM lesson_baskets WHERE id = ?)', [bk.id]))[0].n, 1, 'a lift ticket for the lesson day');
  const st = await pub('POST', `/lesson-basket/${bk.reference}/status`, { body: { email: 'pat@x.test' } });
  assert.equal(st.body.status, 'paid');
  assert.equal(st.body.lessons.length, 2);
  assert.equal((await pub('POST', `/lesson-basket/${bk.reference}/status`, { body: { email: 'other@x.test' } })).status, 404);
  D.mia = mia;
});

test('a basket that cannot be honored is refunded in full, and the same child cannot be in two lessons at once', async () => {
  const overlap = await lesson(100.5, { level_min: 1, level_max: 3 });
  const two = await pub('POST', '/lesson-basket', { body: basket([{ session_id: D.l1, student: kid('Zed') }, { session_id: overlap, student: kid('Zed') }]) });
  assert.equal(two.status, 409);
  assert.match(two.body.error, /two lessons at the same time/);
  const small = await lesson(120, { capacity: 1 });
  const made = await pub('POST', '/lesson-basket', { body: basket([{ session_id: small, student: kid('Una') }]) });
  assert.equal(made.status, 201, made.text);
  const bk = (await q('SELECT * FROM lesson_baskets WHERE tenant_id = ? AND reference = ?', [A.id, made.body.reference]))[0];
  // the desk sells the last place while the family pays
  const [p] = await pool.query('INSERT INTO people (tenant_id, first_name, last_name) VALUES (?, ?, ?)', [A.id, 'Walk', 'Up']);
  await pool.query("INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status) VALUES (?, ?, ?, 'booked')", [A.id, small, p.insertId]);
  const w = await webhook(paid(bk.stripe_session_id, bk.amount_cents, { kind: 'lesson_basket', tenant_id: String(A.id), basket_id: String(bk.id) }));
  assert.equal(w.body.refunded, true);
  assert.equal((await q('SELECT status FROM lesson_baskets WHERE id = ?', [bk.id]))[0].status, 'expired');
  assert.equal((await q("SELECT COUNT(*) AS n FROM lesson_bookings b JOIN people p ON p.id = b.person_id WHERE b.session_id = ? AND p.first_name = 'Una'", [small]))[0].n, 0, 'nothing half-made is kept');
});

test('the family lesson page works only with its link, and shows safety details only to that family', async () => {
  D.when = await lesson(72, { instructor: D.ivy, level_min: 1, level_max: 3 });
  D.fam = await personAndBooking(D.when, 'Nora', { allergies: 'Bees' });
  const r = await pub('GET', `/lesson/${D.fam.token}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.student.first_name, 'Nora');
  assert.equal(r.body.lesson.instructor, 'Ivy');
  assert.equal(r.body.lesson.level_words, 'Levels 1 to 3');
  assert.equal(r.body.booking.allergies, 'Bees');
  assert.equal(r.body.checkin_open, false, 'not the lesson day');
  assert.equal(r.body.policy.can_change, true);
  assert.equal((await pub('GET', `/lesson/${'x'.repeat(32)}`)).status, 404, 'a guessed link shows nothing');
  assert.equal((await call('/api/v1/public', 'GET', `/${B.slug}/lesson/${D.fam.token}`)).status, 404, 'another mountain shows nothing');
  // the family switches photos on; texts stay off without the add-on
  assert.equal((await pub('PATCH', `/lesson/${D.fam.token}`, { body: { photo_ok: true, text_ok: true, pickup: 'Aunt Sue' } })).status, 200);
  const row = (await q('SELECT photo_ok, text_ok, pickup FROM lesson_bookings WHERE id = ?', [D.fam.booking]))[0];
  assert.deepEqual([row.photo_ok, row.text_ok, row.pickup], [1, 0, 'Aunt Sue']);
  // check-in opens on the lesson day, 90 minutes before the start
  const soon = await lesson(1, {});
  const s2 = await personAndBooking(soon, 'Ola');
  assert.equal((await pub('GET', `/lesson/${s2.token}`)).body.checkin_open, true);
  const F = require('../src/lib/lessonfamily');
  // a delay shows the new start: a weather delay moves starts_at and ends_at and notes delay_minutes, and the page never
  // adds the delay a second time (the start, the check-in window and "ended" all use the moved times)
  const [[before]] = await pool.query('SELECT starts_at, ends_at FROM lesson_sessions WHERE id = ?', [soon]);
  await pool.query('UPDATE lesson_sessions SET starts_at = DATE_ADD(starts_at, INTERVAL 30 MINUTE), ends_at = DATE_ADD(ends_at, INTERVAL 30 MINUTE), delay_minutes = 30 WHERE id = ?', [soon]);
  const [[after]] = await pool.query('SELECT starts_at, ends_at FROM lesson_sessions WHERE id = ?', [soon]);
  const d = (await pub('GET', `/lesson/${s2.token}`)).body;
  assert.equal(d.lesson.delay_minutes, 30);
  assert.equal(d.lesson.starts_at, after.starts_at);
  assert.equal(d.lesson.new_start, after.starts_at, 'the new start is the moved start, not 30 more minutes');
  assert.equal(d.lesson.was_start, before.starts_at);
  assert.equal(F.checkinOpen({ ...d.lesson, status: 'booked', session_status: 'scheduled', starts_at: after.starts_at, ends_at: after.ends_at, delay_minutes: 30 }, F.plusMinutes(after.ends_at, 10)), false, 'check-in closes at the moved end, not 30 minutes after it');
  assert.equal(F.checkinOpen({ status: 'booked', session_status: 'scheduled', starts_at: after.starts_at, ends_at: after.ends_at, delay_minutes: 30 }, F.plusMinutes(after.ends_at, -10)), true);
});

test('changing the date keeps the same booking row and refuses a clash', async () => {
  const to = await lesson(96, { level_min: 1, level_max: 3 });
  const dates = await pub('GET', `/lesson/${D.fam.token}/dates`);
  assert.equal(dates.status, 200);
  assert.ok(dates.body.lessons.some((l) => l.id === to), JSON.stringify(dates.body));
  assert.ok(!dates.body.lessons.some((l) => l.id === D.l2), 'a lesson that does not fit the level is not offered');
  // the child is already in another lesson at that time: refused
  const busy = await lesson(96.5, { level_min: 1, level_max: 3 });
  const [bb] = await pool.query("INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status) VALUES (?, ?, ?, 'booked')", [A.id, busy, D.fam.person]);
  const refused = await pub('POST', `/lesson/${D.fam.token}/move`, { body: { session_id: to } });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /Already booked/);
  await pool.query("UPDATE lesson_bookings SET status = 'cancelled' WHERE id = ?", [bb.insertId]);
  const ok = await pub('POST', `/lesson/${D.fam.token}/move`, { body: { session_id: to } });
  assert.equal(ok.status, 200, ok.text);
  const row = (await q('SELECT id, session_id, moved_from_session_id, moved_at, allergies, photo_ok, token_sha FROM lesson_bookings WHERE id = ?', [D.fam.booking]))[0];
  assert.equal(row.session_id, to);
  assert.equal(row.moved_from_session_id, D.when);
  assert.ok(row.moved_at);
  assert.equal(row.allergies, 'Bees', 'safety details stay');
  assert.equal(row.photo_ok, 1, 'consents stay');
  assert.equal((await pub('GET', `/lesson/${D.fam.token}`)).status, 200, 'the same link still works');
  // inside the free window, no more changes online
  const late = await lesson(10, { level_min: 1, level_max: 3 });
  const s3 = await personAndBooking(late, 'Liv');
  const dd = (await pub('GET', `/lesson/${s3.token}/dates`)).body;
  assert.equal(dd.can_change, false);
  assert.match(dd.why, /48 hours/);
});

test('changing the date never moves to a day that costs more than what was paid', async () => {
  const from = await lesson(100, { level_min: 1, level_max: 3 });
  const st = await personAndBooking(from, 'Pia');
  const [o] = await pool.query("INSERT INTO orders (tenant_id, status, subtotal_cents, total_cents, channel) VALUES (?, 'paid', 8000, 8000, 'window')", [A.id]);
  await pool.query("INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, person_id, session_id, tier, quantity, unit_price_cents, discount_cents, tax_cents) VALUES (?, ?, ?, 'lesson', ?, ?, 'child', 1, 8000, 0, 0)", [A.id, o.insertId, D.group, st.person, from]);
  const cheap = await lesson(120, { level_min: 1, level_max: 3 });
  const dear = await lesson(200, { level_min: 1, level_max: 3 }); // a holiday: the same lesson costs more that day
  const [[d]] = await pool.query('SELECT DATE(starts_at) AS day, DATE(starts_at) = (SELECT DATE(starts_at) FROM lesson_sessions WHERE id = ?) AS same FROM lesson_sessions WHERE id = ?', [cheap, dear]);
  assert.equal(Number(d.same), 0, 'the two lessons are on different days');
  await pool.query('INSERT INTO price_calendar (tenant_id, product_id, on_date, tier, price_cents) VALUES (?, ?, ?, NULL, 12000)', [A.id, D.group, d.day]);
  const dates = await pub('GET', `/lesson/${st.token}/dates`);
  assert.equal(dates.status, 200, dates.text);
  assert.ok(dates.body.lessons.some((l) => l.id === cheap), 'the same price is offered');
  assert.ok(!dates.body.lessons.some((l) => l.id === dear), 'a dearer day is not offered');
  const r = await pub('POST', `/lesson/${st.token}/move`, { body: { session_id: dear } });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /costs more/);
  const m = await pub('POST', `/lesson/${st.token}/move`, { body: { session_id: cheap } });
  assert.equal(m.status, 200, m.text);
  assert.equal((await q("SELECT session_id FROM order_items WHERE tenant_id = ? AND order_id = ?", [A.id, o.insertId]))[0].session_id, cheap, 'the sale line follows the lesson');
});

test('recaps: only the lesson\'s instructor writes one, nothing goes out until approved, photos only with a yes', async () => {
  const done = await lesson(-1.5, { instructor: D.ivy, hours: 1, level_min: 1, level_max: 3 });
  const yes = await personAndBooking(done, 'Ruby', { photo_ok: true, allergies: 'Peanuts' });
  const no = await personAndBooking(done, 'Sam', { photo_ok: false });
  const tick = await fetch(`${base}/api/v1/internal/jobs/lessons`, { method: 'POST', headers: { 'x-jobs-key': 'nope' } });
  assert.equal(tick.status, 401, 'the job needs its key');
  assert.ok(await require('../src/lib/lessonrecap').tick() >= 2, 'the job makes recaps for lessons that just ended');
  const mine = await api('GET', '/skischool/recaps', { token: T.ivy });
  assert.equal(mine.status, 200);
  const l = mine.body.lessons.find((x) => x.session_id === done);
  assert.equal(l.students.length, 2);
  const ruby = l.students.find((s) => s.first_name === 'Ruby');
  assert.ok(ruby.skills_offered.length >= 2, 'the skills for this level and the next');
  assert.equal(JSON.stringify(mine.body).includes('Peanuts'), false, 'no medical or allergy notes in the recap list');
  assert.equal((await api('GET', '/skischool/recaps', { token: T.max })).body.lessons.some((x) => x.session_id === done), false, 'another instructor does not see it');
  assert.equal((await api('POST', `/skischool/recaps/${yes.booking}/send`, { token: T.max, body: { body: 'Great day on the snow.' } })).status, 403);
  assert.equal((await api('GET', '/skischool/recaps/count', { token: T.ivy })).body.count >= 2, true);
  // photos: only for the child whose family said yes
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
  assert.equal((await api('POST', `/skischool/recaps/${no.booking}/photos`, { token: T.ivy, raw: jpeg, type: 'image/jpeg' })).status, 403);
  const ph = await api('POST', `/skischool/recaps/${yes.booking}/photos`, { token: T.ivy, raw: jpeg, type: 'image/jpeg' });
  assert.equal(ph.status, 201, ph.text);
  // saved as a draft: the family sees nothing yet
  assert.equal((await api('PUT', `/skischool/recaps/${yes.booking}`, { token: T.ivy, body: { note: 'Linked turns', level: 3, skills: [{ name: ruby.skills_offered[0].name }] } })).status, 200);
  assert.equal((await pub('GET', `/lesson/${yes.token}`)).body.recap, null, 'not sent until the instructor approves');
  // the AI writer is off without Assistant Plus or the lesson_ai add-on
  assert.equal((await api('POST', `/skischool/recaps/${yes.booking}/write`, { token: T.ivy, body: { note: 'x' } })).status, 403);
  const before = mails.length;
  const sent = await api('POST', `/skischool/recaps/${yes.booking}/send`, { token: T.ivy, body: { body: 'Ruby linked her first turns today and rode the carpet on her own.', level: 3, note: 'Linked turns', skills: [{ name: ruby.skills_offered[0].name }] } });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(mails.length, before + 1, 'the family gets one email');
  const mail = mails.at(-1);
  assert.equal(mail.To, 'ruby.parent@x.test');
  assert.equal(mail.TextBody.includes('Peanuts'), false);
  const recapToken = mail.TextBody.match(/\/lesson\/[^/]+\/([A-Za-z0-9_-]{32,64})/)[1];
  assert.equal(texts.length, 0, 'no texts without the add-on');
  const fam = (await pub('GET', `/lesson/${recapToken}`)).body;
  assert.match(fam.recap.body, /first turns/);
  assert.equal(fam.recap.level_words, 'Level 3: Wedge turns');
  assert.equal(fam.recap.photos.length, 1);
  const img = await pub('GET', `/lesson/${recapToken}/photos/${fam.recap.photos[0]}`);
  assert.equal(img.status, 200);
  assert.match(img.type, /image\/jpeg/);
  assert.equal((await call('/api/v1/public', 'GET', `/${B.slug}/lesson/${recapToken}/photos/${fam.recap.photos[0]}`)).status, 404);
  const person = (await q('SELECT ski_level, level_source FROM people WHERE id = ?', [yes.person]))[0];
  assert.deepEqual([person.ski_level, person.level_source], [3, 'instructor'], 'the recap writes the level, as the instructor');
  assert.equal(fam.progress.levels[0].level, 3);
  assert.equal(fam.progress.recaps.length, 1);
  assert.equal((await api('POST', `/skischool/recaps/${yes.booking}/send`, { token: T.ivy, body: { body: 'Again and again and again' } })).status, 409, 'sent once');
  // saying no to photos later hides them
  await pub('PATCH', `/lesson/${recapToken}`, { body: { photo_ok: false } });
  assert.equal((await pub('GET', `/lesson/${recapToken}/photos/${fam.recap.photos[0]}`)).status, 404);
  D.done = { done, yes, no, recapToken };
});

test('the AI writer drafts only with the add-on, and sends only the first name, skills and note', async () => {
  await pool.query("INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, 'lesson_ai', 1) ON DUPLICATE KEY UPDATE enabled = 1", [A.id]);
  modules.invalidate(A.id);
  let sentToModel = null;
  const real = assistant.callModel;
  assistant.callModel = async (body) => { sentToModel = body; return { content: [{ type: 'text', text: 'Sam had a great day — stopping like a pro.' }] }; };
  try {
    const r = await api('POST', `/skischool/recaps/${D.done.no.booking}/write`, { token: T.ivy, body: { note: 'Great stops', level: 2, skills: [{ name: 'Stop on the beginner slope' }] } });
    assert.equal(r.status, 200, r.text);
    assert.match(r.body.body, /great day/);
    assert.equal(r.body.body.includes('—'), false, 'no em dashes');
    const said = JSON.stringify(sentToModel.messages);
    assert.match(said, /Sam/);
    assert.match(said, /Great stops/);
    assert.equal(said.includes('Family'), false, 'no last name');
    assert.equal(said.includes('parent@x.test'), false, 'no contact details');
  } finally { assistant.callModel = real; await pool.query("DELETE FROM tenant_modules WHERE tenant_id = ? AND module = 'lesson_ai'", [A.id]); modules.invalidate(A.id); }
});

test('tips: a family tips from the recap, Stripe takes it on the mountain\'s account, and the webhook marks it paid', async () => {
  const view = (await pub('GET', `/lesson/${D.done.recapToken}`)).body;
  assert.ok(view.tips, 'tips are on by default');
  assert.equal(view.tips.policy, 'Tips go in full to your instructor.');
  assert.equal((await pub('GET', `/lesson/${D.fam.token}`)).body.tips, null, 'no tips before the lesson');
  const r = await pub('POST', `/lesson/${D.done.recapToken}/tip`, { body: { amount_cents: 1000 } });
  assert.equal(r.status, 201, r.text);
  const tip = (await q('SELECT * FROM lesson_tips WHERE id = ?', [r.body.tip_id]))[0];
  assert.equal(tip.status, 'pending');
  assert.equal(tip.staff_id, D.ivy);
  assert.equal(tip.amount_cents, 1000);
  const w = await webhook(paid(tip.stripe_session_id, 1000, { kind: 'lesson_tip', tenant_id: String(A.id), tip_id: String(tip.id) }));
  assert.equal(w.status, 200, JSON.stringify(w.body));
  const after = (await q('SELECT status, paid_at FROM lesson_tips WHERE id = ?', [tip.id]))[0];
  assert.equal(after.status, 'paid');
  assert.ok(after.paid_at);
  // the return check: Stripe says the page was paid, before any webhook
  const r2 = await pub('POST', `/lesson/${D.done.recapToken}/tip`, { body: { amount_cents: 500 } });
  const t2 = (await q('SELECT * FROM lesson_tips WHERE id = ?', [r2.body.tip_id]))[0];
  pages.set(t2.stripe_session_id, { id: t2.stripe_session_id, status: 'complete', payment_status: 'paid', amount_total: 500, payment_intent: 'pi_tip_return' });
  assert.equal((await pub('POST', `/lesson/${D.done.recapToken}/tips/${t2.id}/check`)).body.status, 'paid');
  await pool.query("UPDATE school_settings SET tips_on = 0 WHERE tenant_id = ?", [A.id]);
  await pool.query("INSERT IGNORE INTO school_settings (tenant_id, tips_on) VALUES (?, 0)", [A.id]);
  assert.equal((await pub('GET', `/lesson/${D.done.recapToken}`)).body.tips, null, 'a mountain can turn tips off');
  assert.equal((await pub('POST', `/lesson/${D.done.recapToken}/tip`, { body: { amount_cents: 500 } })).status, 409);
  await pool.query('UPDATE school_settings SET tips_on = 1 WHERE tenant_id = ?', [A.id]);
});

test('waitlist: a full lesson takes names, a cancellation offers the spot, a claim books it, and an offer that runs out moves on', async () => {
  const full = await lesson(150, { capacity: 1, level_min: 1, level_max: 3 });
  const first = await personAndBooking(full, 'Fay');
  const page = (await pub('GET', '/booking')).body;
  assert.ok(page.full.some((l) => l.id === full), 'the full lesson is listed for the waitlist');
  assert.ok(!page.lessons.some((l) => l.id === full));
  const join = (name, email) => pub('POST', '/waitlist', { body: { session_id: full, contact_name: `${name} Parent`, contact_email: email, contact_phone: '215-555-0111', text_ok: true, student: { first_name: name, last_name: 'Wait', date_of_birth: `${year - 7}-01-01` } } });
  const j1 = await join('Gus', 'gus@x.test');
  assert.equal(j1.status, 201, j1.text);
  assert.equal(j1.body.position, 1);
  assert.equal((await join('Hal', 'hal@x.test')).body.position, 2);
  assert.equal((await join('Gus', 'gus@x.test')).body.position, 1, 'joining twice keeps one place');
  assert.equal((await api('GET', `/skischool/sessions/${full}/waitlist`, { token: T.desk })).body.data.length, 2, 'the desk sees the waitlist');
  // Fay cancels (more than 48 hours ahead): the spot goes to Gus
  const before = mails.length;
  const c = await pub('POST', `/lesson/${first.token}/cancel`);
  assert.equal(c.status, 409, 'a lesson paid at the counter is canceled at the desk');
  await pool.query("UPDATE lesson_bookings SET status = 'cancelled' WHERE id = ?", [first.booking]);
  assert.equal(await require('../src/lib/lessonwaitlist').offerNext(A.id, full, base), 1);
  assert.equal(mails.length, before + 1);
  const offer = mails.at(-1);
  assert.equal(offer.To, 'gus@x.test');
  assert.equal(texts.length, 0, 'no text without the add-on, even with a yes');
  const token = offer.TextBody.match(/\/waitlist\/[^/]+\/([A-Za-z0-9_-]{32,64})/)[1];
  // the spot is held for Gus: nobody else can book it
  assert.equal((await pub('POST', '/lesson-basket', { body: basket([{ session_id: full, student: kid('Ivo') }]) })).status, 409);
  const view = await pub('GET', `/waitlist/${token}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.status, 'open');
  assert.equal(view.body.student.first_name, 'Gus');
  const claim = await pub('POST', `/waitlist/${token}/claim`, { body: { contact_first_name: 'Gus', contact_last_name: 'Parent', contact_email: 'gus@x.test', contact_phone: '215-555-0111', student: kid('Gus', 7), waiver_accepted: true, policy_accepted: true } });
  assert.equal(claim.status, 201, claim.text);
  assert.ok(claim.body.checkout_url, 'paid like any online booking');
  assert.equal((await q('SELECT status FROM lesson_waitlist WHERE tenant_id = ? AND contact_email = ?', [A.id, 'gus@x.test']))[0].status, 'claimed');
  assert.equal((await pub('POST', `/waitlist/${token}/claim`, { body: { contact_first_name: 'Gus', contact_last_name: 'Parent', contact_email: 'gus@x.test', contact_phone: '215-555-0111', student: kid('Gus', 7), waiver_accepted: true, policy_accepted: true } })).status, 409);
  // with texts on, the next offer also goes by text when they said yes; Hal's offer runs out and nobody is left
  await pool.query("INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, 'lesson_texts', 1) ON DUPLICATE KEY UPDATE enabled = 1", [A.id]);
  modules.invalidate(A.id);
  await pool.query("UPDATE lesson_requests SET status = 'expired' WHERE tenant_id = ? AND session_id = ?", [A.id, full]); // Gus never paid
  assert.equal((await q("SELECT text_ok FROM lesson_waitlist WHERE tenant_id = ? AND contact_email = 'hal@x.test'", [A.id]))[0].text_ok, 0, 'without the add-on the yes to texts was not kept');
  await pool.query("UPDATE lesson_waitlist SET text_ok = 1 WHERE tenant_id = ? AND contact_email = 'hal@x.test'", [A.id]); // as if they joined with texts on
  assert.equal(await require('../src/lib/lessonwaitlist').offerNext(A.id, full, base), 1);
  assert.equal(texts.length, 1, 'a text with the add-on and a yes');
  assert.match(texts[0].body, /spot opened for Hal/);
  await pool.query("UPDATE lesson_waitlist SET offer_expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE tenant_id = ? AND contact_email = 'hal@x.test'", [A.id]);
  const t = await require('../src/lib/lessonwaitlist').tick(base);
  assert.ok(t.expired >= 1);
  assert.equal((await q("SELECT status FROM lesson_waitlist WHERE tenant_id = ? AND contact_email = 'hal@x.test'", [A.id]))[0].status, 'expired');
  await pool.query("DELETE FROM tenant_modules WHERE tenant_id = ? AND module = 'lesson_texts'", [A.id]);
  modules.invalidate(A.id);
});

test('a waitlist offer holds its spot at Sell too, and one offer makes one booking request even when claimed three times at once', async () => {
  const full = await lesson(170, { capacity: 1 });
  const first = await personAndBooking(full, 'Una');
  const j = await pub('POST', '/waitlist', { body: { session_id: full, contact_name: 'Vic Parent', contact_email: 'vic@x.test', contact_phone: '215-555-0112', student: { first_name: 'Vic', last_name: 'Wait', date_of_birth: `${year - 7}-01-01` } } });
  assert.equal(j.status, 201, j.text);
  await pool.query("UPDATE lesson_bookings SET status = 'cancelled' WHERE id = ?", [first.booking]);
  const before = mails.length;
  assert.equal(await require('../src/lib/lessonwaitlist').offerNext(A.id, full, base), 1);
  const token = mails.slice(before).find((m) => m.To === 'vic@x.test').TextBody.match(/\/waitlist\/[^/]+\/([A-Za-z0-9_-]{32,64})/)[1];
  // Sell at the window cannot take the held spot (the counter's booking screen already could not)
  const sale = await api('POST', '/checkout', { token: T.desk, body: { channel: 'window', customer: { details: { first_name: 'Walt', last_name: 'Walkup', date_of_birth: '1985-03-02', sex: 'male', email: 'walt@x.test' }, sign_waiver: true }, lines: [{ type: 'lesson', session_id: full }], payments: [{ tender: 'cash', amount_cents: 8000 }] } });
  assert.equal(sale.status, 409, sale.text);
  assert.match(sale.body.error, /waitlist/);
  // a double tap and a second tab: one request for the one spot
  const body = { contact_first_name: 'Vic', contact_last_name: 'Parent', contact_email: 'vic@x.test', contact_phone: '215-555-0112', student: kid('Vic', 7), waiver_accepted: true, policy_accepted: true };
  const rs = await Promise.all([1, 2, 3].map(() => pub('POST', `/waitlist/${token}/claim`, { body })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409], rs.map((r) => r.text).join(' | '));
  const open = await q("SELECT id FROM lesson_requests WHERE tenant_id = ? AND session_id = ? AND status IN ('pending','awaiting_payment')", [A.id, full]);
  assert.equal(open.length, 1);
  assert.equal((await q('SELECT status FROM lesson_waitlist WHERE tenant_id = ? AND session_id = ?', [A.id, full]))[0].status, 'claimed');
  // the request waiting for its payment holds the spot at Sell as well
  const sale2 = await api('POST', '/checkout', { token: T.desk, body: { channel: 'window', customer: { details: { first_name: 'Walt', last_name: 'Walkup', date_of_birth: '1985-03-02', sex: 'male', email: 'walt@x.test' }, sign_waiver: true }, lines: [{ type: 'lesson', session_id: full }], payments: [{ tender: 'cash', amount_cents: 8000 }] } });
  assert.equal(sale2.status, 409, sale2.text);
  await pool.query("UPDATE lesson_requests SET status = 'expired' WHERE tenant_id = ? AND session_id = ?", [A.id, full]);
});

test('canceling a paid online lesson refunds this child\'s part under the policy, and the progress card and settings work', async () => {
  const c = await pub('GET', `/lesson/${await links.issue(pool, A.id, D.mia.id)}`);
  assert.equal(c.status, 200);
  assert.equal(c.body.policy.can_cancel, true);
  assert.equal(c.body.policy.refund_percent, 100);
  const tok = await links.issue(pool, A.id, D.mia.id);
  const r = await pub('POST', `/lesson/${tok}/cancel`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.refund_cents, 8000, 'Mia\'s lesson only, not her brother\'s');
  assert.equal((await q('SELECT status FROM lesson_bookings WHERE id = ?', [D.mia.id]))[0].status, 'cancelled');
  assert.equal((await q("SELECT COUNT(*) AS n FROM lesson_bookings b JOIN people p ON p.id = b.person_id WHERE b.session_id = ? AND p.first_name = 'Leo' AND b.status = 'booked'", [D.l2]))[0].n, 1);
  // the families' settings
  assert.equal((await api('PATCH', '/skischool/families/settings', { token: T.desk, body: { pass_on: true } })).status, 403);
  const s = await api('PATCH', '/skischool/families/settings', { token: A.owner, body: { pass_on: true, pass_words: 'Three lessons in: ask about a pass.', what_to_bring: 'Helmet, goggles, mittens' } });
  assert.equal(s.status, 200);
  assert.equal(s.body.pass_on, 1);
  const g = await api('GET', '/skischool/families/settings', { token: A.owner });
  assert.ok(g.body.lesson_products.some((p) => p.id === D.group && p.ticket_product_id === D.ticket));
  assert.equal((await pub('GET', `/lesson/${D.fam.token}`)).body.lesson.what_to_bring, 'Helmet, goggles, mittens');
});

test('the follow-up goes once, three days after a first lesson with nothing else booked', async () => {
  const [p] = await pool.query('INSERT INTO people (tenant_id, first_name, last_name) VALUES (?, ?, ?)', [A.id, 'Tia', 'First']);
  const [s] = await pool.query("INSERT INTO lesson_sessions (tenant_id, product_id, discipline, starts_at, ends_at, capacity, status) VALUES (?, ?, 'ski', ?, ?, 4, 'scheduled')", [A.id, D.group, wall(-72), wall(-70)]);
  await pool.query("INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status, contact_email) VALUES (?, ?, ?, 'attended', 'tia.parent@x.test')", [A.id, s.insertId, p.insertId]);
  const before = mails.length;
  const F = require('../src/lib/lessonfamily');
  assert.ok(await F.followups(base) >= 1);
  assert.ok(mails.slice(before).some((m) => m.To === 'tia.parent@x.test' && /next lesson/.test(m.Subject)));
  const again = mails.length;
  await F.followups(base);
  assert.equal(mails.slice(again).filter((m) => m.To === 'tia.parent@x.test').length, 0, 'once');
});
