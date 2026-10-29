'use strict';

// Ski school, round 2, the director's tools: copy a day (with and without instructors), templates and undo; the weather
// playbook across lessons and programs (delay, cancel, move) with each family's choice (makeup, credit, refund to the
// card through the fake Stripe server) and the 7-day default to a credit; the staffing gap; shift offers (first to
// accept); and the reports on a known data set.
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
const mailer = require('../src/lib/mailer');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const director = require('../src/routes/schooldirector');

let server; let base; let stripeMock; let pmMock; const mails = []; const refunds = []; let n = 0;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const addDays = (d, k) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const q = async (sql, params) => (await pool.query(sql, params))[0];

const DEVICE = 'test-device-0123456789abcdef'; // the app always says which device signs in
async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'x-device': DEVICE, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const ok = (r, s) => { assert.ok(r.status < 300, `${r.status} ${r.text}`); if (s) assert.equal(r.status, s, r.text); return r.body; };

/** A fresh mountain with a manager, a counter login, two instructors with sign-ins, and a group lesson product. */
const made = new Map();
const mountain = (tag) => { if (!made.has(tag)) made.set(tag, newMountain(tag)); return made.get(tag); };
async function newMountain(tag) {
  const slug = `ld${tag}-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: `Peak ${tag}`, phone: '215-555-0000', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const login = async (email) => (await call('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  const M = { slug, id: (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id };
  M.owner = await login(`owner@${slug}.test`);
  ok(await call('POST', '/users', { token: M.owner, body: { email: `counter@${slug}.test`, password: PW, role: 'counter' } }));
  M.counter = await login(`counter@${slug}.test`);
  for (const [k, first] of [['ivy', 'Ivy'], ['max', 'Max']]) {
    const st = ok(await call('POST', '/workforce/staff', { token: M.owner, body: { person: { first_name: first, last_name: 'Teach', email: `${k}@${slug}.test` }, status: 'active' } }));
    M[`${k}Id`] = st.id;
    ok(await call('POST', '/users', { token: M.owner, body: { email: `${k}@${slug}.test`, password: PW, role: 'instructor', staff_id: st.id } }));
    M[k] = await login(`${k}@${slug}.test`);
    // what they teach (an instructor with no teaching profile is not cleared for anything yet)
    ok(await call('PUT', `/skischool/instructors/${st.id}/profile`, { token: M.owner, body: { disciplines: ['ski', 'snowboard'], ski_level_max: 9, snowboard_level_max: 9, teaches_kids: true, teaches_adaptive: false, psia_level: 'level1' } }));
  }
  M.group = ok(await call('POST', '/products', { token: M.owner, body: { kind: 'lesson', name: 'Group Lesson', base_price_cents: 8000 } })).id;
  return M;
}
const lesson = (M, date, time, extra = {}) => call('POST', '/skischool/sessions', { token: M.owner, body: { product_id: M.group, starts_at: `${date}T${time}`, ends_at: `${date}T${String(Number(time.slice(0, 2)) + 2).padStart(2, '0')}:${time.slice(3)}`, ...extra } });
/** Sells a lesson at the window for cash and returns the booking id. */
async function sellLesson(M, sessionId, first, last, extra = {}) {
  const r = ok(await call('POST', '/checkout', { token: M.counter, body: { channel: 'window', customer: { details: { first_name: first, last_name: last, date_of_birth: '1985-03-02', sex: 'female', email: `${first}.${last}@x.test`.toLowerCase(), ...extra }, sign_waiver: true }, lines: [{ type: 'lesson', session_id: sessionId }], payments: [{ tender: 'cash', amount_cents: 8000 }] } }));
  const [b] = await q('SELECT b.id, b.person_id FROM lesson_bookings b JOIN people p ON p.id = b.person_id WHERE b.tenant_id = ? AND b.session_id = ? AND p.first_name = ?', [M.id, sessionId, first]);
  return { ...b, order_id: r.order_id || r.id };
}
const linkFrom = (mail) => { const m = /\/weather\/[^/\s]+\/([A-Za-z0-9_-]{32,64})/.exec(mail.TextBody || ''); return m ? m[1] : null; };

test.before(async () => {
  stripeMock = http.createServer((req, res) => {
    let data = ''; req.on('data', (c) => { data += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/refunds') { const p = Object.fromEntries(new URLSearchParams(data)); refunds.push(p); res.end(JSON.stringify({ id: `re_${++n}`, payment_intent: p.payment_intent, status: 'succeeded' })); }
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
});
test.after(async () => { await new Promise((r) => server.close(r)); stripeMock.close(); pmMock.close(); await pool.end(); });

test('copy a day with and without instructors, save and apply a template, and undo a copy', async () => {
  const M = await mountain('c');
  const src = addDays(today, 20); const tgt = addDays(today, 27); const tgt2 = addDays(today, 34);
  const a = ok(await lesson(M, src, '10:00', { instructor_id: M.ivyId, meeting_place: 'Magic carpet', capacity: 5 })).id;
  ok(await lesson(M, src, '13:00', { instructor_id: M.maxId }));
  ok(await lesson(M, src, '15:00'));
  // On the target day Ivy already teaches at 10:00, so her copied lesson must come without her.
  ok(await lesson(M, tgt, '10:30', { instructor_id: M.ivyId }));
  assert.equal((await call('POST', '/skischool/director/copy/preview', { token: M.ivy, body: { source: { from: src }, targets: [tgt] } })).status, 403, 'instructors cannot copy days');
  const pv = ok(await call('POST', '/skischool/director/copy/preview', { token: M.owner, body: { source: { from: src }, targets: [tgt], with_instructors: true } }));
  assert.equal(pv.to_make, 3);
  assert.equal(pv.without_instructor, 1);
  assert.match(pv.lessons.find((l) => l.start === '10:00').instructor_problem, /Teaching a lesson/);
  const made = ok(await call('POST', '/skischool/director/copy', { token: M.owner, body: { source: { from: src }, targets: [tgt], with_instructors: true } }), 201);
  const copies = await q("SELECT * FROM lesson_sessions WHERE tenant_id = ? AND copy_id = ? ORDER BY starts_at", [M.id, made.id]);
  assert.equal(copies.length, 3);
  assert.equal(copies[0].origin, 'copy');
  assert.equal(copies[0].instructor_id, null, 'copied without the busy instructor');
  assert.equal(copies[0].meeting_place, 'Magic carpet');
  assert.equal(copies[0].capacity, 5);
  assert.equal(copies[1].instructor_id, M.maxId, 'a free instructor comes with the copy');
  // Copying again finds the lessons already there.
  assert.equal((await call('POST', '/skischool/director/copy', { token: M.owner, body: { source: { from: src }, targets: [tgt] } })).status, 409);
  // Without instructors, to two days at once.
  const plain = ok(await call('POST', '/skischool/director/copy', { token: M.owner, body: { source: { from: src }, targets: [tgt2, addDays(tgt2, 1)] } }), 201);
  assert.equal(plain.to_make, 6);
  assert.equal((await q('SELECT COUNT(*) AS n FROM lesson_sessions WHERE tenant_id = ? AND copy_id = ? AND instructor_id IS NOT NULL', [M.id, plain.id]))[0].n, 0);
  // Undo keeps a copied lesson someone booked and deletes the rest.
  const kept = (await q('SELECT id FROM lesson_sessions WHERE tenant_id = ? AND copy_id = ? ORDER BY starts_at LIMIT 1', [M.id, plain.id]))[0].id;
  await sellLesson(M, kept, 'Kim', 'Kept');
  const un = ok(await call('POST', `/skischool/director/copies/${plain.id}/undo`, { token: M.owner }));
  assert.equal(un.deleted, 5);
  assert.equal(un.kept.length, 1);
  assert.equal((await call('POST', `/skischool/director/copies/${plain.id}/undo`, { token: M.owner })).status, 409, 'only once');
  // A template from the source day, applied to a new day.
  const tpl = ok(await call('POST', '/skischool/director/templates', { token: M.owner, body: { name: 'Holiday Saturday', date: src } }), 201);
  assert.equal(tpl.lessons, 3);
  const list = ok(await call('GET', '/skischool/director/templates', { token: M.owner })).data;
  assert.equal(list[0].name, 'Holiday Saturday');
  const tday = addDays(today, 41);
  const applied = ok(await call('POST', '/skischool/director/copy', { token: M.owner, body: { source: { template_id: tpl.id }, targets: [tday], with_instructors: true } }), 201);
  assert.equal(applied.to_make, 3);
  const onDay = await q("SELECT instructor_id FROM lesson_sessions WHERE tenant_id = ? AND DATE(starts_at) = ? ORDER BY starts_at", [M.id, tday]);
  assert.deepEqual(onDay.map((x) => x.instructor_id), [M.ivyId, M.maxId, null]);
  assert.ok(a);
});

/** A program with one day group meeting on `day`, a makeup week on standby, and one enrolled child (paid 400 for 4 weeks). */
async function program(M, day, kidEmail) {
  const [p] = await pool.query("INSERT INTO programs (tenant_id, name, kind, season) VALUES (?, 'Sunday Shredders', 'club', '2026-27')", [M.id]);
  const [t] = await pool.query("INSERT INTO program_terms (tenant_id, program_id, name, starts_on, weeks, makeup_weeks, start_time, end_time, price_cents, status) VALUES (?, ?, 'Winter', ?, 4, 1, '10:00:00', '12:00:00', 40000, 'open')", [M.id, p.insertId, day]);
  const [g] = await pool.query('INSERT INTO program_groups (tenant_id, term_id, weekday, coach_staff_id) VALUES (?, ?, ?, ?)', [M.id, t.insertId, new Date(`${day}T12:00:00Z`).getUTCDay(), M.maxId]);
  const [m] = await pool.query("INSERT INTO program_sessions (tenant_id, program_id, term_id, group_id, starts_at, ends_at, kind, status, coach_staff_id) VALUES (?, ?, ?, ?, ?, ?, 'regular', 'scheduled', ?)", [M.id, p.insertId, t.insertId, g.insertId, `${day} 10:00:00`, `${day} 12:00:00`, M.maxId]);
  const [mk] = await pool.query("INSERT INTO program_sessions (tenant_id, program_id, term_id, group_id, starts_at, ends_at, kind, status, coach_staff_id) VALUES (?, ?, ?, ?, ?, ?, 'makeup', 'standby', ?)", [M.id, p.insertId, t.insertId, g.insertId, `${addDays(day, 28)} 10:00:00`, `${addDays(day, 28)} 12:00:00`, M.maxId]);
  const [kid] = await pool.query("INSERT INTO people (tenant_id, first_name, last_name, email, date_of_birth) VALUES (?, 'Pia', 'Program', ?, '2015-01-01')", [M.id, kidEmail]);
  const [e] = await pool.query("INSERT INTO program_enrollments (tenant_id, program_id, person_id, status, paid_cents, term_id, group_id, price_cents) VALUES (?, ?, ?, 'enrolled', 40000, ?, ?, 40000)", [M.id, p.insertId, kid.insertId, t.insertId, g.insertId]);
  return { program: p.insertId, meeting: m.insertId, makeup: mk.insertId, kid: kid.insertId, enrollment: e.insertId, group: g.insertId };
}

test('delay shifts the day for lessons and program meetings together, and tells families and instructors', async () => {
  const M = await mountain('d');
  const day = addDays(today, 6);
  const s = ok(await lesson(M, day, '10:00', { instructor_id: M.ivyId })).id;
  await sellLesson(M, s, 'Dee', 'Delay');
  const P = await program(M, day, 'pia.d@x.test');
  const before = mails.length;
  const pv = ok(await call('POST', '/skischool/director/weather/preview', { token: M.owner, body: { action: 'delay', date: day, delay_minutes: 45 } }));
  assert.equal(pv.counts.lessons, 1); assert.equal(pv.counts.meetings, 1); assert.equal(pv.counts.families, 2);
  assert.match(pv.words, /start 45 minutes later/);
  ok(await call('POST', '/skischool/director/weather', { token: M.owner, body: { action: 'delay', date: day, delay_minutes: 45, reason: 'Wind hold on the main lift' } }), 201);
  const [row] = await q('SELECT starts_at, ends_at, delay_minutes FROM lesson_sessions WHERE id = ?', [s]);
  assert.equal(row.starts_at, `${day} 10:45:00`); assert.equal(row.ends_at, `${day} 12:45:00`); assert.equal(row.delay_minutes, 45);
  assert.equal((await q('SELECT starts_at FROM program_sessions WHERE id = ?', [P.meeting]))[0].starts_at, `${day} 10:45:00`);
  const sent = mails.slice(before);
  assert.ok(sent.some((m) => m.To === 'dee.delay@x.test' && /10:45 AM/.test(m.TextBody)), 'the family is told the new time');
  assert.ok(sent.some((m) => m.To === 'pia.d@x.test'), 'the program family too');
  assert.ok(sent.some((m) => m.To === `ivy@${M.slug}.test` && /Weather call/.test(m.Subject)), 'the instructor is told');
  assert.ok(!sent.some((m) => /allerg|medical/i.test(m.TextBody)), 'no safety details in weather messages');
});

test('cancel across lessons and programs in one call, then each family chooses: makeup, credit or refund; no answer becomes a credit', async () => {
  const M = await mountain('w');
  const day = addDays(today, 8); const later = addDays(today, 9);
  const s1 = ok(await lesson(M, day, '10:00', { instructor_id: M.ivyId })).id;
  const s2 = ok(await lesson(M, day, '13:00')).id;
  const other = ok(await lesson(M, later, '10:00')).id; // a lesson to make up in
  const ana = await sellLesson(M, s1, 'Ana', 'Card');
  const ben = await sellLesson(M, s1, 'Ben', 'Cash');
  const cal = await sellLesson(M, s2, 'Cal', 'Makeup');
  const dot = await sellLesson(M, s2, 'Dot', 'Late');
  // Ana's order was paid by card through Stripe (a card reader payment), so her refund goes back to the card.
  await q("UPDATE order_payments SET processor = 'stripe', reference = 'pi_ana_123', tender = 'card' WHERE tenant_id = ? AND order_id = ?", [M.id, ana.order_id]);
  const P = await program(M, day, 'pia.w@x.test');
  const pv = ok(await call('POST', '/skischool/director/weather/preview', { token: M.owner, body: { action: 'cancel', date: day } }));
  assert.equal(pv.counts.lessons, 2); assert.equal(pv.counts.meetings, 1); assert.equal(pv.counts.students, 4);
  assert.equal(pv.counts.lesson_value_cents, 32000);
  assert.equal(pv.meetings[0].makeup_date, addDays(day, 28));
  const before = mails.length;
  const r = ok(await call('POST', '/skischool/director/weather', { token: M.owner, body: { action: 'cancel', date: day, reason: 'Ice storm, lifts closed' } }), 201);
  assert.equal(r.lessons, 2); assert.equal(r.meetings, 1);
  assert.equal((await q("SELECT COUNT(*) AS n FROM lesson_sessions WHERE tenant_id = ? AND DATE(starts_at) = ? AND status = 'cancelled'", [M.id, day]))[0].n, 2, 'every lesson that day is canceled');
  assert.equal((await q('SELECT status FROM program_sessions WHERE id = ?', [P.meeting]))[0].status, 'cancelled');
  assert.equal((await q('SELECT status FROM program_sessions WHERE id = ?', [P.makeup]))[0].status, 'scheduled', 'the makeup week takes its place');
  assert.equal((await call('POST', '/skischool/director/weather', { token: M.owner, body: { action: 'cancel', date: day, reason: 'again' } })).status, 400, 'nothing left to cancel');
  const sent = mails.slice(before);
  const tok = (email) => linkFrom(sent.find((m) => m.To === email));
  for (const who of ['ana.card@x.test', 'ben.cash@x.test', 'cal.makeup@x.test', 'dot.late@x.test', 'pia.w@x.test']) assert.ok(tok(who), `a link for ${who}`);
  assert.ok(sent.some((m) => m.To === `ivy@${M.slug}.test`), 'Ivy hears her lesson is off');

  // Cal takes a makeup: the same booking row moves into the other lesson.
  const calPage = ok(await call('GET', `/public/${M.slug}/weather/${tok('cal.makeup@x.test')}`));
  assert.equal(calPage.student, 'Cal'); assert.equal(calPage.choice, 'open');
  assert.ok(calPage.makeups.some((x) => x.id === other));
  assert.equal(calPage.refund.cents, 8000);
  ok(await call('POST', `/public/${M.slug}/weather/${tok('cal.makeup@x.test')}/choose`, { body: { choice: 'makeup', session_id: other } }));
  const [calRow] = await q('SELECT id, session_id, status, moved_from_session_id FROM lesson_bookings WHERE id = ?', [cal.id]);
  assert.equal(calRow.session_id, other); assert.equal(calRow.status, 'booked'); assert.equal(calRow.moved_from_session_id, s2);
  // ...and can still change their mind to a credit before the makeup.
  ok(await call('POST', `/public/${M.slug}/weather/${tok('cal.makeup@x.test')}/choose`, { body: { choice: 'credit' } }));
  assert.equal((await q('SELECT status FROM lesson_bookings WHERE id = ?', [cal.id]))[0].status, 'cancelled');
  const calCredit = await q("SELECT * FROM lesson_credits WHERE tenant_id = ? AND person_id = ? AND source = 'weather'", [M.id, cal.person_id]);
  assert.equal(calCredit.length, 1); assert.equal(calCredit[0].total, 1);
  assert.equal((await call('POST', `/public/${M.slug}/weather/${tok('cal.makeup@x.test')}/choose`, { body: { choice: 'refund' } })).status, 409, 'a credit is final');
  // The credit shows in the makeup bank on the family lesson page, and can be used online.
  const lessonTok = await (async () => { const crypto = require('crypto'); const t = crypto.randomBytes(24).toString('base64url'); await q('UPDATE lesson_bookings SET token_sha = ? WHERE id = ?', [crypto.createHash('sha256').update(t).digest('hex'), cal.id]); return t; })();
  const bank = ok(await call('GET', `/public/${M.slug}/lesson/${lessonTok}/credits`)).data;
  assert.equal(bank.length, 1); assert.equal(bank[0].left, 1);
  const calAfter = ok(await call('GET', `/public/${M.slug}/weather/${tok('cal.makeup@x.test')}`));
  assert.ok(calAfter.credit_lessons.some((x) => x.id === other));
  ok(await call('POST', `/public/${M.slug}/weather/${tok('cal.makeup@x.test')}/use-credit`, { body: { session_id: other } }), 201);
  assert.equal((await q("SELECT used FROM lesson_credits WHERE id = ?", [calCredit[0].id]))[0].used, 1);
  assert.equal((await q("SELECT status FROM lesson_bookings WHERE session_id = ? AND person_id = ?", [other, cal.person_id]))[0].status, 'booked');

  // Ana takes a refund: back to her card through Stripe.
  const nRef = refunds.length;
  const anaPage = ok(await call('GET', `/public/${M.slug}/weather/${tok('ana.card@x.test')}`));
  assert.equal(anaPage.refund.how, 'card');
  ok(await call('POST', `/public/${M.slug}/weather/${tok('ana.card@x.test')}/choose`, { body: { choice: 'refund' } }));
  assert.equal(refunds.length, nRef + 1, 'sent to Stripe');
  assert.equal(refunds.at(-1).payment_intent, 'pi_ana_123');
  assert.equal(Number(refunds.at(-1).amount), 8000);
  // Ben paid cash: his refund is listed for the desk.
  ok(await call('POST', `/public/${M.slug}/weather/${tok('ben.cash@x.test')}/choose`, { body: { choice: 'refund' } }));
  const choices = ok(await call('GET', `/skischool/director/weather/calls/${r.call_id}/choices`, { token: M.counter })).data;
  const benRow = choices.find((c) => c.first_name === 'Ben');
  assert.equal(benRow.refund_how, 'desk'); assert.equal(benRow.refund_cents, 8000);
  // The program family has its makeup week already; it may pick a refund of one lesson's share instead.
  const piaPage = ok(await call('GET', `/public/${M.slug}/weather/${tok('pia.w@x.test')}`));
  assert.equal(piaPage.choice, 'makeup'); assert.equal(piaPage.refund.cents, 10000);
  assert.equal(piaPage.credit_ok, true);
  // Bad or wrong-mountain links reveal nothing.
  assert.equal((await call('GET', `/public/${M.slug}/weather/${'x'.repeat(40)}`)).status, 404);
  // Dot never answers: after the deadline the daily job turns it into a credit.
  await q("UPDATE weather_choices SET expires_at = '2000-01-01 00:00:00' WHERE tenant_id = ? AND person_id = ?", [M.id, dot.person_id]);
  const job = await director.daily();
  assert.ok(job.weather.credits >= 1);
  const dotChoice = (await q('SELECT choice, chosen_via, credit_id FROM weather_choices WHERE tenant_id = ? AND person_id = ?', [M.id, dot.person_id]))[0];
  assert.equal(dotChoice.choice, 'credit'); assert.equal(dotChoice.chosen_via, 'auto'); assert.ok(dotChoice.credit_id);
  // The credit works at the counter like a package lesson.
  const use = await call('POST', `/skischool/sessions/${other}/bookings`, { token: M.counter, body: { person_id: dot.person_id, use_credit_id: dotChoice.credit_id } });
  assert.equal(use.status, 201, use.text);
  const hist = ok(await call('GET', '/skischool/director/weather/calls', { token: M.owner })).data;
  assert.equal(hist[0].action, 'cancel'); assert.equal(hist[0].choices.credit, 2);
});

test('move a day to a makeup day: lessons are copied with free instructors, families keep the same booking row, programs get an extra date', async () => {
  const M = await mountain('d');
  const day = addDays(today, 10); const mk = addDays(today, 11);
  const s = ok(await lesson(M, day, '10:00', { instructor_id: M.ivyId, meeting_place: 'Clock tower' })).id;
  ok(await lesson(M, mk, '10:00', { instructor_id: M.ivyId })); // Ivy is busy on the makeup day at that time
  const eve = await sellLesson(M, s, 'Eve', 'Moved');
  const P = await program(M, day, 'pia.m@x.test');
  const r = ok(await call('POST', '/skischool/director/weather', { token: M.owner, body: { action: 'move', date: day, makeup_date: mk, reason: 'Rain' } }), 201);
  assert.equal(r.moved, 1);
  assert.equal(r.instructors_dropped.length, 1, 'Ivy cannot take the moved lesson');
  const [b] = await q('SELECT session_id, status, moved_from_session_id FROM lesson_bookings WHERE id = ?', [eve.id]);
  assert.equal(b.status, 'booked'); assert.equal(b.moved_from_session_id, s);
  const [ns] = await q('SELECT starts_at, instructor_id, meeting_place, origin FROM lesson_sessions WHERE id = ?', [b.session_id]);
  assert.equal(ns.starts_at, `${mk} 10:00:00`); assert.equal(ns.instructor_id, null); assert.equal(ns.meeting_place, 'Clock tower');
  assert.equal((await q('SELECT status FROM lesson_sessions WHERE id = ?', [s]))[0].status, 'cancelled');
  const extra = await q("SELECT kind, status FROM program_sessions WHERE tenant_id = ? AND group_id = ? AND DATE(starts_at) = ?", [M.id, P.group, mk]);
  assert.deepEqual(extra.map((x) => [x.kind, x.status]), [['extra', 'scheduled']]);
  assert.equal((await q('SELECT status FROM program_sessions WHERE id = ?', [P.makeup]))[0].status, 'standby', 'the reserve makeup week stays in reserve');
  const ch = (await q('SELECT choice, chosen_via FROM weather_choices WHERE tenant_id = ? AND booking_id = ?', [M.id, eve.id]))[0];
  assert.deepEqual([ch.choice, ch.chosen_via], ['makeup', 'move']);
  assert.equal((await call('POST', '/skischool/director/weather', { token: M.owner, body: { action: 'move', date: day, makeup_date: day, reason: 'x y z' } })).status, 400);
  // An unpaid booking on a canceled lesson gets a new day, never a free credit.
  const day3 = addDays(today, 12);
  const s3 = ok(await lesson(M, day3, '10:00')).id;
  ok(await call('POST', `/skischool/sessions/${s3}/bookings`, { token: M.counter, body: { person_id: eve.person_id, sign_waiver: true } }), 201);
  ok(await call('POST', '/skischool/director/weather', { token: M.owner, body: { action: 'cancel', date: day3, reason: 'Wind' } }), 201);
  const un = (await q('SELECT id FROM weather_choices WHERE tenant_id = ? AND session_id = ?', [M.id, s3]))[0];
  const deskView = ok(await call('GET', `/skischool/director/weather/choices/${un.id}`, { token: M.counter }));
  assert.equal(deskView.credit_ok, false); assert.equal(deskView.refund_ok, false);
  assert.equal((await call('POST', `/skischool/director/weather/choices/${un.id}/choose`, { token: M.counter, body: { choice: 'credit' } })).status, 409);
});

test('a weather makeup canceled for a refund is closed: no credit or refund on top, and a refund never exceeds the child\'s own line', async () => {
  const M = await mountain('w');
  const crypto = require('crypto');
  const day = addDays(today, 2); const later = addDays(today, 3);
  const s1 = ok(await lesson(M, day, '10:00', { instructor_id: M.ivyId })).id;
  const other = ok(await lesson(M, later, '10:00')).id;
  const ana = await sellLesson(M, s1, 'Ana', 'Online');
  // An online card booking, as onlinesale.confirmRequest leaves it: a confirmed request with its order.
  await q("UPDATE order_payments SET processor = 'stripe', reference = 'pi_ana_1', tender = 'card' WHERE tenant_id = ? AND order_id = ?", [M.id, ana.order_id]);
  const [lr] = await pool.query("INSERT INTO lesson_requests (tenant_id, session_id, reference, contact_name, contact_email, contact_phone, students, waiver_accepted, status, amount_cents, payment_intent, order_id, policy_accepted) VALUES (?, ?, 'ANAREF01', 'Ana Online', 'ana.online@x.test', '215-555-0101', '{\"students\":[{}]}', 1, 'confirmed', 8000, 'pi_ana_1', ?, 1)", [M.id, s1, ana.order_id]);
  await q('UPDATE lesson_bookings SET request_id = ? WHERE id = ?', [lr.insertId, ana.id]);
  const before = mails.length;
  ok(await call('POST', '/skischool/director/weather', { token: M.owner, body: { action: 'cancel', date: day, reason: 'Ice storm, lifts closed' } }));
  const wtok = linkFrom(mails.slice(before).find((m) => m.To === 'ana.online@x.test'));
  ok(await call('POST', `/public/${M.slug}/weather/${wtok}/choose`, { body: { choice: 'makeup', session_id: other } }));
  const [line] = await q("SELECT session_id FROM order_items WHERE tenant_id = ? AND order_id = ? AND line_kind = 'lesson'", [M.id, ana.order_id]);
  assert.equal(line.session_id, other, 'the sale line moved with the makeup');
  // The family cancels the makeup from their lesson page: a full refund to the card.
  const ltok = crypto.randomBytes(24).toString('base64url');
  await q('UPDATE lesson_bookings SET token_sha = ? WHERE id = ?', [crypto.createHash('sha256').update(ltok).digest('hex'), ana.id]);
  const c = ok(await call('POST', `/public/${M.slug}/lesson/${ltok}/cancel`));
  assert.equal(c.refund_cents, 8000);
  // The weather link is now closed: no credit, no refund, no new makeup.
  const view = ok(await call('GET', `/public/${M.slug}/weather/${wtok}`));
  assert.ok(view.closed, JSON.stringify(view)); assert.equal(view.credit_ok, false); assert.equal(view.refund_ok, false); assert.deepEqual(view.makeups, []);
  for (const body of [{ choice: 'credit' }, { choice: 'refund' }, { choice: 'makeup', session_id: other }]) assert.equal((await call('POST', `/public/${M.slug}/weather/${wtok}/choose`, { body })).status, 409, JSON.stringify(body));
  assert.equal((await q("SELECT COUNT(*) AS n FROM lesson_credits WHERE tenant_id = ? AND person_id = ? AND source = 'weather'", [M.id, ana.person_id]))[0].n, 0);
  assert.equal((await q('SELECT refunded_cents FROM orders WHERE id = ?', [ana.order_id]))[0].refunded_cents, 8000, 'refunded once');

  // Two children on one card order at different prices: the weather refund of the cheaper one is her own line only.
  const s3 = ok(await lesson(M, addDays(today, 4), '10:00')).id;
  const sale = ok(await call('POST', '/checkout', { token: M.counter, body: { channel: 'window', customer: { details: { first_name: 'Pam', last_name: 'Parent', date_of_birth: '1980-01-01', sex: 'female', email: 'pam.parent@x.test' }, sign_waiver: true },
    participants: { a: { details: { first_name: 'Bo', last_name: 'Parent', date_of_birth: '2016-01-01', sex: 'male' }, sign_waiver: true }, b: { details: { first_name: 'Cy', last_name: 'Parent', date_of_birth: '2015-01-01', sex: 'male' }, sign_waiver: true } },
    lines: [{ type: 'lesson', session_id: s3, participant: 'a' }, { type: 'lesson', session_id: s3, participant: 'b' }], payments: [{ tender: 'cash', amount_cents: 16000 }] } }));
  const orderId = sale.order_id || sale.id;
  const kids = await q("SELECT b.id, b.person_id, p.first_name FROM lesson_bookings b JOIN people p ON p.id = b.person_id WHERE b.tenant_id = ? AND b.session_id = ? ORDER BY p.first_name", [M.id, s3]);
  await q("UPDATE order_items SET unit_price_cents = 5000 WHERE tenant_id = ? AND order_id = ? AND person_id = ?", [M.id, orderId, kids[0].person_id]);
  await q("UPDATE order_items SET unit_price_cents = 11000 WHERE tenant_id = ? AND order_id = ? AND person_id = ?", [M.id, orderId, kids[1].person_id]);
  await q("UPDATE order_payments SET processor = 'stripe', reference = 'pi_two_kids', tender = 'card' WHERE tenant_id = ? AND order_id = ?", [M.id, orderId]);
  const [lr2] = await pool.query("INSERT INTO lesson_requests (tenant_id, session_id, reference, contact_name, contact_email, contact_phone, students, waiver_accepted, status, amount_cents, payment_intent, order_id, policy_accepted) VALUES (?, ?, 'TWOKIDS1', 'Pam Parent', 'pam.parent@x.test', '215-555-0102', '{\"students\":[{},{}]}', 1, 'confirmed', 16000, 'pi_two_kids', ?, 1)", [M.id, s3, orderId]);
  await q('UPDATE lesson_bookings SET request_id = ?, contact_email = ? WHERE tenant_id = ? AND session_id = ?', [lr2.insertId, 'pam.parent@x.test', M.id, s3]);
  const b2 = mails.length;
  ok(await call('POST', '/skischool/director/weather', { token: M.owner, body: { action: 'cancel', date: addDays(today, 4), reason: 'Wind' } }));
  const links = mails.slice(b2).filter((m) => m.To === 'pam.parent@x.test').map(linkFrom);
  const views = await Promise.all(links.map(async (t) => ({ t, v: ok(await call('GET', `/public/${M.slug}/weather/${t}`)) })));
  const bo = views.find((x) => x.v.student === 'Bo');
  assert.equal(bo.v.refund.cents, 5000, 'Bo\'s own line, not an even share of the order');
  const r = ok(await call('POST', `/public/${M.slug}/weather/${bo.t}/choose`, { body: { choice: 'refund' } }));
  assert.equal(r.refund_cents, 5000);
  assert.ok((await q('SELECT refunded_at FROM order_items WHERE tenant_id = ? AND order_id = ? AND person_id = ?', [M.id, orderId, kids[0].person_id]))[0].refunded_at, 'Bo\'s line is marked refunded');
  assert.equal((await q('SELECT refunded_at FROM order_items WHERE tenant_id = ? AND order_id = ? AND person_id = ?', [M.id, orderId, kids[1].person_id]))[0].refunded_at, null, 'Cy\'s line is untouched');
});

test('a weather makeup canceled by weather again keeps what was paid: the second link offers the credit or refund, the first is closed', async () => {
  const M = await mountain('w');
  const d1 = addDays(today, 12); const d2 = addDays(today, 13);
  const s1 = ok(await lesson(M, d1, '10:00')).id;
  const s2 = ok(await lesson(M, d2, '10:00')).id;
  await sellLesson(M, s1, 'Cal', 'Cash');
  let before = mails.length;
  ok(await call('POST', '/skischool/director/weather', { token: M.owner, body: { action: 'cancel', date: d1, reason: 'Ice storm' } }));
  const t1 = linkFrom(mails.slice(before).find((m) => m.To === 'cal.cash@x.test'));
  ok(await call('POST', `/public/${M.slug}/weather/${t1}/choose`, { body: { choice: 'makeup', session_id: s2 } }));
  before = mails.length;
  ok(await call('POST', '/skischool/director/weather', { token: M.owner, body: { action: 'cancel', date: d2, reason: 'Wind' } }));
  const t2 = linkFrom(mails.slice(before).find((m) => m.To === 'cal.cash@x.test'));
  const second = ok(await call('GET', `/public/${M.slug}/weather/${t2}`));
  assert.equal(second.refund.cents, 8000); assert.equal(second.credit_ok, true); assert.equal(second.refund_ok, true);
  assert.equal((await call('POST', `/public/${M.slug}/weather/${t1}/choose`, { body: { choice: 'credit' } })).status, 409, 'the first link is closed');
  ok(await call('POST', `/public/${M.slug}/weather/${t2}/choose`, { body: { choice: 'credit' } }));
  assert.equal((await q("SELECT COUNT(*) AS n FROM lesson_credits c JOIN people p ON p.id = c.person_id WHERE c.tenant_id = ? AND p.first_name = 'Cal' AND p.last_name = 'Cash' AND c.source = 'weather'", [M.id]))[0].n, 1, 'one credit for one paid lesson');
});

test('a weather delay shows the moved start on the family page once', async () => {
  const M = await mountain('w');
  const crypto = require('crypto');
  const day = addDays(today, 5);
  const s = ok(await lesson(M, day, '10:00', { instructor_id: M.ivyId })).id;
  const b = await sellLesson(M, s, 'Dee', 'Delay');
  ok(await call('POST', '/skischool/director/weather', { token: M.owner, body: { action: 'delay', date: day, delay_minutes: 45, reason: 'Wind hold on the main lift' } }));
  const tok = crypto.randomBytes(24).toString('base64url');
  await q('UPDATE lesson_bookings SET token_sha = ? WHERE id = ?', [crypto.createHash('sha256').update(tok).digest('hex'), b.id]);
  const page = ok(await call('GET', `/public/${M.slug}/lesson/${tok}`));
  assert.equal(page.lesson.starts_at, `${day} 10:45:00`);
  assert.equal(page.lesson.new_start, `${day} 10:45:00`, 'not 11:30');
  assert.equal(page.lesson.was_start, `${day} 10:00:00`);
});

test('staffing: booked plus expected walk-ups against instructors gives the gap; first instructor to accept a shift offer gets it', async () => {
  const M = await mountain('s');
  const day = addDays(today, 6);
  const pastDay = addDays(day, -7);
  // Last week, same weekday: a kids lesson with two walk-ups (booked on the day).
  const [ps] = await pool.query("INSERT INTO lesson_sessions (tenant_id, product_id, discipline, starts_at, ends_at, capacity, age_min, age_max, age_group, status) VALUES (?, ?, 'ski', ?, ?, 6, 4, 12, 'kids', 'completed')", [M.id, M.group, `${pastDay} 10:00:00`, `${pastDay} 12:00:00`]);
  for (const k of [1, 2]) {
    const [p] = await pool.query("INSERT INTO people (tenant_id, first_name, last_name) VALUES (?, 'Walk', ?)", [M.id, `Up${k}`]);
    await pool.query("INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status, created_at) VALUES (?, ?, ?, 'attended', ?)", [M.id, ps.insertId, p.insertId, `${pastDay} 15:00:00`]);
  }
  // This week: two kids lessons at 10:00 with 7 booked, one with Ivy, one with nobody.
  const a = ok(await lesson(M, day, '10:00', { instructor_id: M.ivyId, capacity: 6 })).id;
  const b = ok(await lesson(M, day, '10:00', { capacity: 6 })).id;
  await q("UPDATE lesson_sessions SET age_min = 4, age_max = 12, age_group = 'kids' WHERE id IN (?)", [[a, b]]);
  for (let k = 0; k < 7; k += 1) {
    const [p] = await pool.query("INSERT INTO people (tenant_id, first_name, last_name) VALUES (?, 'Kid', ?)", [M.id, `K${k}`]);
    await pool.query("INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status) VALUES (?, ?, ?, 'booked')", [M.id, k < 4 ? a : b, p.insertId]);
  }
  const v = ok(await call('GET', `/skischool/director/staffing?from=${today}`, { token: M.owner }));
  const slot = v.slots.find((x) => x.date === day && x.time === '10:00');
  assert.equal(slot.booked, 7); assert.equal(slot.walkups, 2);
  assert.equal(slot.need, 2, 'nine kids at five per instructor'); assert.equal(slot.scheduled, 1); assert.equal(slot.gap, 1);
  assert.match(slot.words, /need 1 more kids instructor$/);
  assert.equal(slot.available, 1, 'Max is free');
  // A school holiday with no past holidays counts half again busier.
  ok(await call('POST', '/skischool/director/holidays', { token: M.owner, body: { on_date: day, name: 'Presidents Day' } }), 201);
  const v2 = ok(await call('GET', `/skischool/director/staffing?from=${today}`, { token: M.owner }));
  assert.equal(v2.slots.find((x) => x.date === day && x.time === '10:00').walkups, 3);
  // The offer: Max and Ivy are asked (Ivy is busy at 10:00, so only Max is free). Add a third instructor to race.
  const st = ok(await call('POST', '/workforce/staff', { token: M.owner, body: { person: { first_name: 'Zoe', last_name: 'Teach', email: `zoe@${M.slug}.test` }, status: 'active' } }));
  ok(await call('POST', '/users', { token: M.owner, body: { email: `zoe@${M.slug}.test`, password: PW, role: 'instructor', staff_id: st.id } }));
  const zoe = (await call('POST', '/auth/login', { body: { tenant: M.slug, email: `zoe@${M.slug}.test`, password: PW } })).body.token;
  // An instructor with no teaching profile yet is not offered a shift: nobody has said what they teach.
  const notSetUp = ok(await call('GET', `/skischool/director/staffing?from=${today}`, { token: M.owner })).slots.find((x) => x.date === day && x.time === '10:00');
  assert.equal(notSetUp.available, 1, 'Zoe is not set up yet, so only Max counts as free');
  ok(await call('PUT', `/skischool/instructors/${st.id}/profile`, { token: M.owner, body: { disciplines: ['ski'], ski_level_max: 4, snowboard_level_max: null, teaches_kids: true, teaches_adaptive: false, psia_level: 'level1' } }));
  assert.equal((await call('POST', '/skischool/director/offers', { token: M.ivy, body: { starts_at: `${day}T10:00`, ends_at: `${day}T12:00` } })).status, 403);
  const before = mails.length;
  const off = ok(await call('POST', '/skischool/director/offers', { token: M.owner, body: { starts_at: `${day}T10:00`, ends_at: `${day}T12:00`, discipline: 'ski', level_max: 2, kids: true, session_id: b } }), 201);
  assert.equal(off.sent_to, 2, 'Max and Zoe, not busy Ivy');
  assert.ok(mails.slice(before).some((m) => m.To === `max@${M.slug}.test` && /Can you teach/.test(m.Subject)));
  const mine = ok(await call('GET', '/skischool/offers/mine', { token: zoe })).data;
  assert.equal(mine.length, 1); assert.match(mine[0].words, /kids/);
  ok(await call('POST', `/skischool/offers/${off.id}/accept`, { token: zoe }));
  const late = await call('POST', `/skischool/offers/${off.id}/accept`, { token: M.max });
  assert.equal(late.status, 409); assert.match(late.body.error, /already took/);
  assert.equal((await q('SELECT instructor_id FROM lesson_sessions WHERE id = ?', [b]))[0].instructor_id, st.id, 'Zoe now teaches the lesson');
  assert.ok(mails.some((m) => m.To === `max@${M.slug}.test` && /is filled/.test(m.TextBody)), 'Max is told it is filled');
  const v3 = ok(await call('GET', `/skischool/director/staffing?from=${today}`, { token: M.owner }));
  assert.equal(v3.slots.find((x) => x.date === day && x.time === '10:00').scheduled, 2);
});

test('reports: seat fill, revenue per lesson and instructor, first lesson to return, no-shows and the CSV', async () => {
  const M = await mountain('c');
  const d1 = addDays(today, 3); const d2 = addDays(today, 13);
  const s1 = ok(await lesson(M, d1, '10:00', { instructor_id: M.ivyId, capacity: 6 })).id;
  const s2 = ok(await lesson(M, d2, '10:00', { instructor_id: M.maxId, capacity: 4 })).id;
  const x = await sellLesson(M, s1, 'Rae', 'Return');
  const y = await sellLesson(M, s1, 'Sid', 'Once');
  await q("UPDATE lesson_bookings SET status = 'no_show' WHERE id = ?", [y.id]);
  ok(await call('POST', `/skischool/sessions/${s2}/bookings`, { token: M.counter, body: { person_id: x.person_id, sign_waiver: true } }), 201); // unpaid second lesson
  assert.equal((await call('GET', '/skischool/director/reports', { token: M.ivy })).status, 403);
  const r = ok(await call('GET', `/skischool/director/reports?from=${d1}&to=${d2}`, { token: M.owner }));
  assert.equal(r.totals.lessons, 2); assert.equal(r.totals.seats, 10); assert.equal(r.totals.students, 3); assert.equal(r.totals.fill_pct, 30);
  assert.equal(r.totals.revenue_cents, 16000); assert.equal(r.totals.no_shows, 1);
  assert.equal(r.per_instructor.find((i) => i.staff_id === M.ivyId).revenue_cents, 16000);
  assert.equal(r.per_instructor.find((i) => i.staff_id === M.maxId).revenue_cents, 0);
  assert.equal(r.fill.by_day.find((dd) => dd.key === d1).fill_pct, 33.3);
  assert.equal(r.returning.total.first_timers, 2); assert.equal(r.returning.total.back_30, 1); assert.equal(r.returning.total.back_30_pct, 50);
  assert.equal(r.no_shows.length, 1);
  const csv = await fetch(`${base}/api/v1/skischool/director/reports?from=${d1}&to=${d2}&format=csv&part=instructors`, { headers: { authorization: `Bearer ${M.owner}` } });
  assert.equal(csv.status, 200);
  const text = await csv.text();
  assert.match(text, /"instructor","lessons"|instructor,lessons/);
  assert.match(text, /"160.00"/);
  // Certifications: one expiring soon shows on the list.
  const [c] = await pool.query("INSERT INTO certifications (tenant_id, name) VALUES (?, 'PSIA Level 1')", [M.id]);
  await pool.query('INSERT INTO staff_certifications (tenant_id, staff_id, certification_id, expires_on) VALUES (?, ?, ?, ?)', [M.id, M.ivyId, c.insertId, addDays(today, 10)]);
  const certs = ok(await call('GET', '/skischool/director/certs', { token: M.owner }));
  assert.equal(certs.expiring.length, 1); assert.equal(certs.expiring[0].name, 'Ivy Teach');
});
