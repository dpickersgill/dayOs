'use strict';

// feat/school-pay: unpaid roster bookings and Take payment, the guardian who signs a child's waiver at the roster, the
// pay-rate setup warning, the "moved to Settings" note per login, the pay ladder by certification level with credential
// add-ons, training time, My pay flags, payroll that never pays a line twice, the owner reports (owners and managers
// only), the instructor satisfaction score and its comments, the learn to ski ladder, and group programs.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.BOOKING_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const modules = require('../src/lib/modules');
const links = require('../src/lib/lessonlinks');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const q = async (sql, params) => (await pool.query(sql, params))[0];
const plus = (d, k) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const year = Number(today.slice(0, 4));
const seasonStart = Number(today.slice(5, 7)) >= 8 ? year : year - 1;
const P1 = plus(today, -3); const P2 = plus(today, -2); const F1 = plus(today, 3);

async function call(prefix, method, path, { token, body } = {}) {
  const res = await fetch(`${base}${prefix}${path}`, { method, headers: { 'x-device': 'test-device-0123456789abcdef', 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const api = (m, p, o) => call('/api/v1', m, p, o);
const pub = (m, p, o) => call('/api/v1/public', m, `/${M.slug}${p}`, o);
const ok = (r, s) => { assert.ok(r.status < 300, `${r.status} ${r.text}`); if (s) assert.equal(r.status, s, r.text); return r.body; };
const is = (r, s, why) => assert.equal(r.status, s, `${why || ''} ${r.text}`);

const M = {}; const T = {}; const D = {};
test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  M.slug = `sp-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug: M.slug, name: 'Pay Peak', phone: '215-555-0100', owner: { email: `owner@${M.slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  M.id = (await q('SELECT id FROM tenants WHERE slug = ?', [M.slug]))[0].id;
  for (const k of ['school', 'programs']) await q('INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE enabled = 1', [M.id, k]);
  modules.invalidate(M.id);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: M.slug, email, password: PW } })).body.token;
  T.owner = await login(`owner@${M.slug}.test`);
  for (const role of ['manager', 'counter']) { ok(await api('POST', '/users', { token: T.owner, body: { email: `${role}@${M.slug}.test`, password: PW, role } })); T[role] = await login(`${role}@${M.slug}.test`); }
  for (const [k, first] of [['ivy', 'Ivy'], ['max', 'Max'], ['dana', 'Dana'], ['sam', 'Sam']]) {
    D[k] = ok(await api('POST', '/workforce/staff', { token: T.owner, body: { person: { first_name: first, last_name: 'Teach', email: `${k}.${suffix}@x.test` }, status: 'active' } })).id;
    ok(await api('POST', '/users', { token: T.owner, body: { email: `${k}@${M.slug}.test`, password: PW, role: 'instructor', staff_id: D[k] } }));
    T[k] = await login(`${k}@${M.slug}.test`);
    ok(await api('PUT', `/skischool/instructors/${D[k]}/profile`, { token: T.owner, body: { disciplines: ['ski', 'adaptive'], ski_level_max: 9, snowboard_level_max: null, teaches_kids: true, teaches_adaptive: true, psia_level: 'none' } }));
  }
  ok(await api('PUT', `/skischool/access/${D.dana}`, { token: T.owner, body: { level: 'director' } }));
  ok(await api('PUT', `/skischool/access/${D.sam}`, { token: T.owner, body: { level: 'supervisor' } }));
  T.dana = await login(`dana@${M.slug}.test`); T.sam = await login(`sam@${M.slug}.test`);
  const prod = async (body) => ok(await api('POST', '/products', { token: T.owner, body })).id;
  D.group = await prod({ kind: 'lesson', name: 'Group Lesson', base_price_cents: 8000 });
  D.pack = await prod({ kind: 'lesson', name: '3-Lesson Card', base_price_cents: 21000, uses: 3, valid_days: 60 });
  D.ticket = await prod({ kind: 'day_ticket', name: 'Day Ticket', base_price_cents: 6000 });
  D.rental = await prod({ kind: 'rental', name: 'Ski Rental', base_price_cents: 4000 });
  D.pass = await prod({ kind: 'season_pass', name: 'Season Pass', base_price_cents: 50000, valid_days: 200 });
  ok(await api('PUT', '/tenant/profile', { token: T.owner, body: { waiver_text: 'I accept the risks of skiing.', online_payment: false } }));
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

let kid = 0;
const adult = () => { kid += 1; return { first_name: `Ada${kid}`, last_name: `Pay${suffix}`, date_of_birth: '1988-04-04', sex: 'female', email: `ada${kid}.${suffix}@x.test` }; };
const child = () => { kid += 1; return { first_name: `Kit${kid}`, last_name: `Pay${suffix}`, date_of_birth: `${year - 9}-02-02`, sex: 'male' }; };
async function lesson(day, from = '10:00', to = '12:00', extra = {}) {
  return ok(await api('POST', '/skischool/sessions', { token: T.owner, body: { product_id: D.group, starts_at: `${day}T${from}`, ends_at: `${day}T${to}`, instructor_id: D.ivy, override_reason: 'School pay test', ...extra } }), 201).id;
}
const book = (sid, body, token = T.counter) => api('POST', `/skischool/sessions/${sid}/bookings`, { token, body: { sign_waiver: true, send_confirmation: false, ...body } });

// ---------------------------------------------------------------- 1. unpaid roster bookings
test('a roster booking takes no money: it is unpaid on the roster, check-in and board until paid in Sell, and revenue counts only paid money', async () => {
  const sid = await lesson(F1);
  const b = ok(await book(sid, { student: adult() }), 201);
  assert.equal(b.unpaid, true, 'booked at the roster: unpaid');
  const row = ok(await api('GET', `/skischool/sessions/${sid}/roster`, { token: T.counter })).data.find((r) => r.booking_id === b.id);
  assert.equal(Number(row.unpaid), 1);
  const ci = ok(await api('GET', `/skischool/checkin?date=${F1}`, { token: T.counter })).data.find((r) => r.booking_id === b.id);
  assert.equal(ci.unpaid, true, 'check-in shows it unpaid');
  const board = ok(await api('GET', `/skischool/board?date=${F1}`, { token: T.counter }));
  assert.ok(board.sessions.find((s) => s.id === sid).students.find((x) => x.booking_id === b.id || x.person_id === b.person_id).unpaid, 'the board shows it unpaid');
  let rev = ok(await api('GET', `/skischool/owner-reports/revenue-per-hour?from=${F1}&to=${F1}`, { token: T.owner }));
  assert.equal(rev.total.revenue_cents, 0, 'nothing paid, so no revenue');
  // Take payment: what Sell puts in the basket
  const pay = ok(await api('GET', `/skischool/bookings/${b.id}/payment`, { token: T.counter }));
  assert.equal(pay.unpaid, true); assert.equal(pay.session_id, sid); assert.equal(pay.person.id, b.person_id); assert.ok(pay.tier);
  is(await api('GET', `/skischool/bookings/${b.id}/payment`, { token: T.ivy }), 403, 'a plain instructor does not take payment');
  // the desk sells it: the sale picks up the held booking
  const sale = ok(await api('POST', '/checkout', { token: T.counter, body: { channel: 'window', customer: { person_id: b.person_id }, lines: [{ type: 'lesson', session_id: sid, tier: pay.tier }], payments: [{ tender: 'cash', amount_cents: 8000 }] } }), 201);
  assert.equal(sale.lessons[0].booking_id, b.id, 'the same booking, not a second one');
  assert.equal((await q('SELECT unpaid FROM lesson_bookings WHERE id = ?', [b.id]))[0].unpaid, 0, 'paid now');
  assert.equal(ok(await api('GET', `/skischool/bookings/${b.id}/payment`, { token: T.counter })).unpaid, false);
  rev = ok(await api('GET', `/skischool/owner-reports/revenue-per-hour?from=${F1}&to=${F1}`, { token: T.owner }));
  assert.equal(rev.total.revenue_cents, 8000, 'the paid lesson counts');
  // a booking paid by a lesson package is not unpaid
  const p = ok(await api('POST', '/checkout', { token: T.counter, body: { channel: 'window', customer: { details: adult(), sign_waiver: true }, lines: [{ type: 'lesson_package', product_id: D.pack }], payments: [{ tender: 'cash', amount_cents: 21000 }] } }), 201);
  const credit = p.packages[0].credit_id;
  const viaPack = ok(await book(sid, { person_id: p.packages[0].person_id, use_credit_id: credit }), 201);
  assert.equal(viaPack.unpaid, false, 'a package lesson is paid');
});

// ---------------------------------------------------------------- 2. the guardian who signs
test('a child\'s waiver at the roster records the parent or guardian who signed; an adult signs for themselves', async () => {
  const sid = await lesson(plus(today, 4));
  const kidNoName = await book(sid, { student: child() });
  is(kidNoName, 409, 'a child needs the name of who signed');
  assert.equal(kidNoName.body.details.needs_guardian, true);
  const pid = kidNoName.body.details.person_id;
  is(await book(sid, { person_id: pid, waiver_signer: { name: `Kit${kid} Pay${suffix}` } }), 409, 'a child cannot sign their own waiver');
  ok(await book(sid, { person_id: pid, waiver_signer: { name: 'Gina Guardian' } }), 201);
  const w = (await q('SELECT signed_by_name, signer_relation, text_sha, method FROM waivers WHERE tenant_id = ? AND person_id = ?', [M.id, pid]))[0];
  assert.equal(w.signed_by_name, 'Gina Guardian'); assert.equal(w.signer_relation, 'guardian'); assert.equal(w.text_sha.length, 64, 'the wording they signed is kept'); assert.equal(w.method, 'recorded_by_staff');
  const a = ok(await book(sid, { student: adult() }), 201);
  const wa = (await q('SELECT signed_by_name, signer_relation, signed_by_person_id FROM waivers WHERE tenant_id = ? AND person_id = ?', [M.id, a.person_id]))[0];
  assert.equal(wa.signer_relation, 'self'); assert.equal(Number(wa.signed_by_person_id), a.person_id);
});

// ---------------------------------------------------------------- 3 and 6. setup warning and the pay ladder
test('pay rates not set are listed for the director; the pay ladder by level and credential add-ons fill them, and an own rate wins', async () => {
  let s = ok(await api('GET', '/skischool/pay/setup-check', { token: T.dana }));
  assert.ok(s.missing.some((m) => m.staff_id === D.ivy && m.kinds.some((k) => k.kind === 'group')), 'Ivy has no group rate');
  is(await api('GET', '/skischool/pay/setup-check', { token: T.ivy }), 403);
  // certification levels: the old words still work and move to PSIA-AASI; the director cannot set their own
  ok(await api('PUT', `/skischool/instructors/${D.ivy}/profile`, { token: T.owner, body: { disciplines: ['ski', 'adaptive'], ski_level_max: 9, snowboard_level_max: null, teaches_kids: true, teaches_adaptive: true, psia_level: 'level2', credentials: ['kids2', 'adaptive'] } }));
  const prof = (await q('SELECT psia_level, credentials FROM instructor_profiles WHERE tenant_id = ? AND staff_id = ?', [M.id, D.ivy]))[0];
  assert.equal(prof.psia_level, 'psia2'); assert.equal(prof.credentials, 'kids2,adaptive');
  ok(await api('PUT', `/skischool/instructors/${D.max}/profile`, { token: T.dana, body: { disciplines: ['ski'], ski_level_max: 9, snowboard_level_max: null, teaches_kids: true, teaches_adaptive: false, psia_level: 'csia3' } }));
  is(await api('PUT', `/skischool/instructors/${D.dana}/profile`, { token: T.dana, body: { disciplines: ['ski'], ski_level_max: 9, snowboard_level_max: null, teaches_kids: true, teaches_adaptive: false, psia_level: 'psia_te' } }), 403, 'a director does not set their own level');
  // the migration: widen, move the old values across, narrow (run here on one row, as on a 2026.11.12 database)
  const steps = require('../db/steps/school-pay')({ tableExists: async () => true, columnExists: async () => true });
  const step = (re) => steps.find(([n]) => re.test(n));
  const conn = await pool.getConnection();
  try {
    await conn.query(step(/certs \(widen\)/)[2]);
    await conn.query("UPDATE instructor_profiles SET psia_level = 'level3' WHERE tenant_id = ? AND staff_id = ?", [M.id, D.sam]);
    assert.equal(await step(/certs \(move\)/)[1](conn), false, 'an old value is waiting to move');
    await conn.query(step(/certs \(move\)/)[2]);
    assert.equal(await step(/certs \(move\)/)[1](conn), true);
    await conn.query(step(/certs \(narrow\)/)[2]);
  } finally { conn.release(); }
  assert.equal((await q('SELECT psia_level FROM instructor_profiles WHERE tenant_id = ? AND staff_id = ?', [M.id, D.sam]))[0].psia_level, 'psia3', 'level3 became PSIA-AASI Level 3');
  assert.equal((await q("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'instructor_profiles' AND column_name = 'psia_level' AND column_type LIKE '%level1%'"))[0].n, 0, 'the old values are gone from the column');
  // the ladder: owners and managers set it; a director reads it
  const rung = (body, token = T.owner) => api('POST', '/skischool/pay/ladder', { token, body: { effective_from: plus(today, -60), ...body } });
  is(await rung({ rung: 'psia2', kind: 'group', cents: 5000 }, T.dana), 403, 'a director does not set the ladder');
  ok(await rung({ rung: 'psia2', kind: 'group', cents: 5000 }));
  ok(await rung({ rung: 'psia2', kind: 'hourly', cents: 2400 }));
  ok(await rung({ rung: 'kids2', kind: 'lesson_addon', cents: 700 }));
  ok(await rung({ rung: 'adaptive', kind: 'lesson_addon', cents: 900 }));
  is(await rung({ rung: 'kids1', kind: 'group', cents: 100 }), 400, 'a credential pays an add-on');
  assert.ok(ok(await api('GET', '/skischool/pay/ladder', { token: T.dana })).ladder.length >= 4);
  // school defaults for the rest
  for (const [kind, cents] of [['group', 3000], ['semi_private', 3500], ['private', 4000], ['hourly', 2000]]) ok(await api('POST', '/skischool/pay/rates', { token: T.owner, body: { staff_id: null, kind, cents, effective_from: plus(today, -60) } }));
  s = ok(await api('GET', '/skischool/pay/setup-check', { token: T.owner }));
  assert.equal(s.missing.length, 0, 'everyone has a rate now');
  // pay lines: Ivy on the ladder with add-ons on a kids lesson; Max (CSIA 3, no ladder rung) on the default
  const kidsLesson = await lesson(P1, '09:00', '11:00', { age_min: 6, age_max: 10 });
  ok(await book(kidsLesson, { student: adult() }), 201);
  const mine = ok(await api('GET', `/skischool/pay/mine?from=${P1}&to=${P1}`, { token: T.ivy }));
  const line = mine.lines.find((l) => l.session_id === kidsLesson && l.kind === 'lesson');
  assert.equal(line.cents, 5000 + 700, 'ladder rate plus the Children\'s Specialist 2 add-on');
  assert.ok(line.parts.some((p) => /Children's Specialist 2 add-on/.test(p.label)));
  const adaptive = await lesson(P1, '13:00', '14:00', { discipline: 'adaptive' });
  ok(await book(adaptive, { student: adult() }), 201);
  assert.equal(ok(await api('GET', `/skischool/pay/mine?from=${P1}&to=${P1}`, { token: T.ivy })).lines.find((l) => l.session_id === adaptive).cents, 5000 + 900, 'the Adaptive add-on on an adaptive lesson');
  // an own rate wins over the ladder and the add-ons
  ok(await api('POST', '/skischool/pay/rates', { token: T.owner, body: { staff_id: D.ivy, kind: 'group', cents: 6100, effective_from: plus(today, -60) } }));
  assert.equal(ok(await api('GET', `/skischool/pay/mine?from=${P1}&to=${P1}`, { token: T.ivy })).lines.find((l) => l.session_id === kidsLesson).cents, 6100);
  D.kidsLesson = kidsLesson;
});

// ---------------------------------------------------------------- 6. training, flags, payroll
test('training time is a paid line; an instructor flags a line before payroll; payroll exports training and never pays a line twice', async () => {
  const tr = { title: 'Kids lineup clinic', starts_at: `${P2}T08:00`, ends_at: `${P2}T09:30`, attendees: [{ staff_id: D.ivy }, { staff_id: D.max, minutes: 60 }] };
  is(await api('POST', '/skischool/training', { token: T.ivy, body: tr }), 403, 'only the director logs training');
  is(await api('POST', '/skischool/training', { token: T.dana, body: { ...tr, attendees: [{ staff_id: D.dana }] } }), 403, 'a director does not log paid time for themselves');
  const id = ok(await api('POST', '/skischool/training', { token: T.dana, body: tr }), 201).id;
  const ivy = ok(await api('GET', `/skischool/pay/mine?from=${P2}&to=${P2}`, { token: T.ivy })).lines.find((l) => l.kind === 'training');
  assert.equal(ivy.minutes, 90); assert.equal(ivy.cents, 3600, '1.5 h at the PSIA 2 ladder hourly rate of 24.00');
  const max = ok(await api('GET', `/skischool/pay/mine?from=${P2}&to=${P2}`, { token: T.max })).lines.find((l) => l.kind === 'training');
  assert.equal(max.minutes, 60); assert.equal(max.cents, 2000, 'his own minutes at the default hourly rate');
  is(await api('GET', `/skischool/pay/mine?from=${P2}&to=${P2}&staff_id=${D.ivy}`, { token: T.max }), 403, 'only your own pay');
  // flag a line
  ok(await api('POST', '/skischool/pay/flags', { token: T.max, body: { line_key: max.key, day: P2, message: 'I stayed the whole 90 minutes' } }), 201);
  is(await api('POST', '/skischool/pay/flags', { token: T.max, body: { line_key: max.key, day: P2, message: 'again' } }), 409);
  is(await api('POST', '/skischool/pay/flags', { token: T.max, body: { line_key: `lesson:${D.kidsLesson}`, day: P1, message: 'not my line' } }), 404, 'only your own lines');
  const flags = ok(await api('GET', `/skischool/pay/flags?from=${P2}&to=${P2}`, { token: T.dana })).data;
  assert.equal(flags.length, 1); assert.equal(flags[0].name, 'Max Teach');
  assert.equal(ok(await api('GET', '/skischool/pay/flags', { token: T.ivy })).data.length, 0, 'an instructor sees only their own flags');
  ok(await api('POST', `/skischool/pay/flags/${flags[0].id}/answer`, { token: T.dana, body: { answer: 'Changed to 90 minutes' } }));
  ok(await api('PUT', `/skischool/training/${id}`, { token: T.dana, body: { ...tr, attendees: [{ staff_id: D.ivy }, { staff_id: D.max }] } }));
  const period = ok(await api('GET', '/skischool/pay/period/mine', { token: T.max }));
  assert.equal(period.flags[0].status, 'answered');
  // payroll: approve and export; then again: nothing is paid twice
  const range = { from: plus(today, -5), to: plus(today, -1) };
  let pr = ok(await api('GET', `/skischool/pay/payroll?from=${range.from}&to=${range.to}`, { token: T.owner }));
  assert.ok(pr.instructors.find((g) => g.staff_id === D.max).lines.some((l) => l.kind === 'training'));
  ok(await api('POST', '/skischool/pay/payroll/approve', { token: T.owner, body: { ...range, staff_ids: pr.instructors.map((g) => g.staff_id), approved: true } }));
  assert.equal(ok(await api('GET', '/skischool/pay/period/mine', { token: T.max })).period.approved, true, 'My pay shows the period approved');
  const ex = ok(await api('POST', '/skischool/pay/payroll/export', { token: T.owner, body: range }));
  assert.ok(ex.lines > 0);
  assert.match(ex.summary_csv.split('\n')[0], /training/); assert.match(ex.summary_csv.split('\n')[0], /credential_addons/);
  const csvRows = ex.summary_csv.split('\r\n').map((r) => r.split(',').map((c) => c.replace(/^"|"$/g, '')));
  const maxRow = csvRows.find((r) => r[0] === 'Max Teach');
  assert.equal(maxRow[csvRows[0].indexOf('training')], '30.00', 'training pay in its own column (90 minutes at 20.00 an hour)');
  const ivyRow = csvRows.find((r) => r[0] === 'Ivy Teach');
  assert.equal(ivyRow[csvRows[0].indexOf('training')], '36.00');
  assert.match(ex.lines_csv, /training/);
  const paidBefore = (await q('SELECT COUNT(*) AS n, SUM(cents) AS c FROM payroll_items WHERE tenant_id = ?', [M.id]))[0];
  // a second period that overlaps: the lines already paid are left out
  const range2 = { from: plus(today, -4), to: plus(today, -2) };
  pr = ok(await api('GET', `/skischool/pay/payroll?from=${range2.from}&to=${range2.to}`, { token: T.owner }));
  assert.equal(pr.instructors.length, 0, 'everything in it was paid already');
  assert.ok(pr.earlier > 0);
  // exporting the same period again pays nothing new
  await api('POST', '/skischool/pay/payroll/export', { token: T.owner, body: range });
  const paidAfter = (await q('SELECT COUNT(*) AS n, SUM(cents) AS c FROM payroll_items WHERE tenant_id = ?', [M.id]))[0];
  assert.deepEqual([Number(paidAfter.n), Number(paidAfter.c)], [Number(paidBefore.n), Number(paidBefore.c)], 'no line is paid twice');
  is(await api('PUT', `/skischool/training/${id}`, { token: T.dana, body: tr }), 409, 'a paid training cannot change');
  is(await api('DELETE', `/skischool/training/${id}`, { token: T.dana }), 409);
});

// ---------------------------------------------------------------- 8. satisfaction score
test('families answer 0 to 10 after the lesson; directors see scores, instructors only their own number, and comments stay with owners, managers and the director', async () => {
  const sid = await lesson(P1, '14:00', '15:00');
  const answers = [[10, 'Ivy was wonderful'], [9, null], [6, 'Too fast for us']];
  for (const [score, comment] of answers) {
    const b = ok(await book(sid, { student: adult() }), 201);
    const token = await links.issue(pool, M.id, b.id);
    ok(await pub('POST', `/lesson/${token}/rating`, { body: { score, comment } }));
    if (score === 10) {
      const view = ok(await pub('GET', `/lesson/${token}`));
      assert.equal(view.rating.score, 10, 'the family page shows their answer');
      assert.equal(view.rating.asked, true);
    }
  }
  const future = await lesson(F1, '13:00', '14:00');
  const fb = ok(await book(future, { student: adult() }), 201);
  is(await pub('POST', `/lesson/${await links.issue(pool, M.id, fb.id)}/rating`, { body: { score: 9 } }), 409, 'not before the lesson is over');
  is(await pub('POST', '/lesson/not-a-real-token-0000000000/rating', { body: { score: 9 } }), 404);
  const sum = ok(await api('GET', `/skischool/ratings/summary?from=${P1}&to=${P1}`, { token: T.dana })).data.find((r) => r.staff_id === D.ivy);
  assert.deepEqual([sum.count, sum.nps], [3, 33], '2 of 3 said 9 or 10, 1 said 6: +33');
  is(await api('GET', '/skischool/ratings/summary', { token: T.ivy }), 403, 'an instructor sees no one else');
  is(await api('GET', '/skischool/ratings/summary', { token: T.sam }), 403, 'nor a supervisor');
  assert.deepEqual(ok(await api('GET', '/skischool/ratings/mine', { token: T.ivy })), { nps: 33, count: 3 }, 'their own number, no comments');
  for (const t of ['ivy', 'sam', 'counter']) is(await api('GET', `/skischool/ratings?staff_id=${D.ivy}`, { token: T[t] }), 403, `${t} cannot read comments`);
  const c = ok(await api('GET', `/skischool/ratings?staff_id=${D.ivy}`, { token: T.owner })).data;
  assert.deepEqual(c.map((x) => x.comment).sort(), ['Ivy was wonderful', 'Too fast for us']);
  assert.equal(ok(await api('GET', `/skischool/ratings?staff_id=${D.ivy}`, { token: T.manager })).data.length, 2);
  assert.equal(ok(await api('GET', `/skischool/ratings?staff_id=${D.ivy}`, { token: T.dana })).data.length, 2, 'the director reads comments about instructors');
  is(await api('GET', `/skischool/ratings?staff_id=${D.dana}`, { token: T.dana }), 403, 'but not about themselves');
});

// ---------------------------------------------------------------- 9. learn to ski ladder
test('a learn to ski ladder is sold as a package, shows lesson 2 of 3 on the progress card, and graduates get the season pass offer', async () => {
  is(await api('POST', '/skischool/ladders', { token: T.ivy, body: { name: 'Learn to ski', lessons: 3, price_cents: 19900 } }), 403);
  is(await api('POST', '/skischool/ladders', { token: T.owner, body: { name: 'Learn to ski', lessons: 3, price_cents: 19900, pass_percent: 25 } }), 400, 'a discount needs the pass it is for');
  const lid = ok(await api('POST', '/skischool/ladders', { token: T.dana, body: { name: 'Learn to ski in 3', lessons: 3, price_cents: 19900, ticket_product_id: D.ticket, rental_product_id: D.rental, pass_product_id: D.pass, pass_percent: 25, pass_days: 30 } }), 201).id;
  const l = ok(await api('GET', '/skischool/ladders', { token: T.counter })).data.find((x) => x.id === lid);
  assert.equal(l.lessons, 3); assert.equal(l.includes, 'Day Ticket and Ski Rental');
  D.ladderProduct = l.product_id;
  const sale = ok(await api('POST', '/checkout', { token: T.counter, body: { channel: 'window', customer: { details: adult(), sign_waiver: true }, lines: [{ type: 'lesson_package', product_id: l.product_id }], payments: [{ tender: 'cash', amount_cents: 19900 }] } }), 201);
  const pid = sale.packages[0].person_id; const credit = sale.packages[0].credit_id;
  D.ladderPerson = pid;
  const days = [plus(today, -9), plus(today, -8), plus(today, -7)];
  const bookings = [];
  for (const d of days) {
    const sid = await lesson(d, '09:00', '10:00');
    const b = ok(await book(sid, { person_id: pid, use_credit_id: credit, level: 1 }), 201);
    assert.equal(b.unpaid, false);
    bookings.push(b);
    if (!D.ladderSession) {
      D.ladderSession = sid;
      const r = ok(await api('GET', `/skischool/sessions/${sid}/roster`, { token: T.counter })).data[0];
      assert.equal(r.ladder.includes, 'Day Ticket and Ski Rental', 'the roster names what the ladder lesson includes');
    }
  }
  ok(await api('PATCH', `/skischool/bookings/${bookings[0].id}`, { token: T.owner, body: { status: 'attended' } }));
  let prog = ok(await api('GET', `/skischool/ladders/progress/${pid}`, { token: T.counter })).data[0];
  assert.deepEqual([prog.attended, prog.lessons, prog.graduated, prog.offer], [1, 3, false, null], 'lesson 2 of 3 next');
  for (const b of bookings.slice(1)) ok(await api('PATCH', `/skischool/bookings/${b.id}`, { token: T.owner, body: { status: 'attended' } }));
  prog = ok(await api('GET', `/skischool/ladders/progress/${pid}`, { token: T.counter })).data[0];
  assert.equal(prog.graduated, true);
  assert.equal(prog.offer.percent, 25); assert.match(prog.offer.code, /^[A-Z0-9]{10}$/);
  const reward = (await q('SELECT kind, status, options FROM guest_rewards WHERE tenant_id = ? AND person_id = ?', [M.id, pid]));
  assert.equal(reward.length, 1, 'one offer, made once');
  const opts = typeof reward[0].options === 'string' ? JSON.parse(reward[0].options) : reward[0].options;
  assert.equal(opts.percent.product_id, D.pass, 'percent off the season pass only');
  // the family's progress card shows it
  const token = await links.issue(pool, M.id, bookings[2].id);
  const view = ok(await pub('GET', `/lesson/${token}`));
  assert.equal(view.progress.ladders[0].graduated, true);
  assert.equal(view.progress.ladders[0].offer.code, prog.offer.code);
});

// ---------------------------------------------------------------- 7. owner reports
test('owner reports: revenue per hour, cost against revenue, instructor return rate and first-timer conversion, with CSV; owners and managers only', async () => {
  // last season: Ivy and Max taught; this season only Ivy (and Dana, new)
  const last = `${seasonStart - 1}-12-20`;
  await lesson(last, '10:00', '11:00');
  await lesson(last, '11:00', '12:00', { instructor_id: D.max });
  await lesson(plus(today, -1), '10:00', '11:00', { instructor_id: D.dana });
  const ret = ok(await api('GET', '/skischool/owner-reports/return-rate', { token: T.owner }));
  assert.equal(ret.total.taught_last_season, 2); assert.equal(ret.total.returned, 1); assert.equal(ret.total.return_pct, 50);
  assert.ok(ret.rows.find((r) => r.staff_id === D.ivy).returned); assert.ok(!ret.rows.find((r) => r.staff_id === D.max).returned);
  // conversion: a first-timer at Level 1 who booked again within 30 days, one who did not, the ladder graduate
  const s1 = await lesson(plus(today, -6), '13:00', '14:00'); const s2 = await lesson(plus(today, -1), '13:00', '14:00');
  const back = ok(await book(s1, { student: adult(), level: 1 }), 201);
  ok(await book(s2, { person_id: back.person_id }), 201);
  ok(await book(s2, { student: adult(), level: 1 }), 201);
  ok(await book(s1, { student: adult(), level: 4 }), 201); // not a first-timer
  const conv = ok(await api('GET', '/skischool/owner-reports/conversion', { token: T.manager }));
  const any = conv.rows[0];
  assert.ok(conv.first_timers >= 3, JSON.stringify(conv));
  assert.ok(any.d30 >= 2, 'the return lesson and the ladder count');
  assert.ok(conv.rows.find((r) => r.kind === 'ladder').season >= 1, 'the learn to ski ladder counts');
  assert.ok(conv.rows.find((r) => r.kind === 'lesson').d30 >= 1);
  const cost = ok(await api('GET', `/skischool/owner-reports/cost?from=${plus(today, -10)}&to=${F1}`, { token: T.owner }));
  assert.ok(cost.by_product.find((x) => x.key === 'Group Lesson').cost_cents > 0, 'instructor cost by product');
  assert.ok(cost.by_product.find((x) => x.key === 'Training').cost_cents > 0, 'training is its own row');
  assert.ok(cost.by_day.length > 1);
  const rph = ok(await api('GET', `/skischool/owner-reports/revenue-per-hour?from=${plus(today, -10)}&to=${F1}`, { token: T.owner }));
  assert.ok(rph.rows.find((r) => r.staff_id === D.ivy).hours > 0);
  for (const kind of ['revenue-per-hour', 'cost', 'return-rate', 'conversion']) {
    const csv = await fetch(`${base}/api/v1/skischool/owner-reports/${kind}?format=csv`, { headers: { authorization: `Bearer ${T.owner}`, 'x-device': 'test-device-0123456789abcdef' } });
    assert.equal(csv.status, 200, kind); assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.ok((await csv.text()).split('\n').length >= 2, `${kind} CSV has a header and rows`);
    for (const t of ['dana', 'sam', 'ivy', 'counter']) is(await api('GET', `/skischool/owner-reports/${kind}`, { token: T[t] }), 403, `${t} cannot read ${kind}`);
  }
});

// ---------------------------------------------------------------- 4. the moved-to-Settings note
test('a dismissed note stays dismissed for that login only', async () => {
  assert.deepEqual(ok(await api('GET', '/notices', { token: T.owner })).dismissed, []);
  ok(await api('POST', '/notices/dismiss', { token: T.owner, body: { key: 'moved:school' } }));
  ok(await api('POST', '/notices/dismiss', { token: T.owner, body: { key: 'moved:school' } }));
  assert.deepEqual(ok(await api('GET', '/notices', { token: T.owner })).dismissed, ['moved:school']);
  assert.deepEqual(ok(await api('GET', '/notices', { token: T.manager })).dismissed, [], 'another login still sees it');
  is(await api('POST', '/notices/dismiss', { token: T.owner, body: { key: 'bad key!' } }), 400);
});

// ---------------------------------------------------------------- 10. group programs
test('a group program: private link with a deadline, the leader fills the roster and chaperones, parents sign by link, drop-off and pickup per meeting', async () => {
  const first = plus(today, 10);
  const body = { org_name: 'Valley Elementary', leader_name: 'Lee Leader', leader_email: `lee.${suffix}@x.test`, first_day: first, weeks: 6, start_time: '15:30', end_time: '17:00', max_students: 3, per_chaperone: 2, deadline_hours: 72, meeting_place: 'The bell' };
  is(await api('POST', '/skischool/groups', { token: T.sam, body }), 403, 'the director books group programs');
  const g = ok(await api('POST', '/skischool/groups', { token: T.dana, body }), 201);
  assert.match(g.link, new RegExp(`/group/${M.slug}/[A-Za-z0-9_-]{20,}$`));
  assert.equal(String(g.deadline_at).slice(0, 16), `${plus(first, -3)} 15:30`, '72 hours before the first meeting');
  const token = g.link.split('/').pop();
  const G = (m, p, o) => pub(m, `/group/${token}${p}`, o);
  const view = ok(await G('GET', ''));
  assert.equal(view.meetings.length, 6); assert.equal(view.open, true); assert.equal(view.weekday.length > 3, true);
  assert.equal(view.leader_email, undefined, 'the page does not echo contact details');
  const kids = [];
  for (const n of [1, 2, 3]) kids.push(ok(await G('POST', '/students', { body: { first_name: `Gia${n}`, last_name: `Group${suffix}`, date_of_birth: `${year - 8}-05-0${n}`, guardian_name: `Pat Parent${n}` } }), 201));
  is(await G('POST', '/students', { body: { first_name: 'Too', last_name: 'Many', date_of_birth: `${year - 8}-05-05`, guardian_name: 'Pat Parent' } }), 409, 'the group is full');
  is(await G('PUT', '/chaperones', { body: { chaperones: [{ name: 'Cam Chap', phone: '2155550111' }, { name: 'x', phone: '1' }] } }), 400);
  ok(await G('PUT', '/chaperones', { body: { chaperones: [{ name: 'Cam Chap', phone: '2155550111' }, { name: 'Dee Chap', phone: '2155550112' }] } }));
  let staffView = ok(await api('GET', `/skischool/groups/${g.id}`, { token: T.counter }));
  assert.equal(staffView.students.length, 3); assert.equal(staffView.chaperones_needed, 2); assert.equal(staffView.chaperones.length, 2);
  assert.equal(staffView.students.filter((s) => s.waiver_signed).length, 0);
  // a parent signs by link
  const wt = kids[0].waiver_link.split('/').pop();
  const W = (m, o) => pub(m, `/group-waiver/${wt}`, o);
  assert.equal(ok(await W('GET')).child, 'Gia1');
  is(await W('POST', { body: { signer_name: `Gia1 Group${suffix}`, relation: 'parent', accept: true } }), 400, 'the child does not sign');
  ok(await W('POST', { body: { signer_name: 'Pat Parent1', relation: 'parent', accept: true } }), 201);
  const w = (await q('SELECT w.signed_by_name, w.signer_relation, w.method, w.season FROM waivers w JOIN group_program_students s ON s.waiver_id = w.id WHERE s.id = ?', [kids[0].id]))[0];
  assert.deepEqual([w.signed_by_name, w.signer_relation, w.method], ['Pat Parent1', 'guardian', 'signed_online']);
  assert.equal(ok(await W('GET')).signed.by, 'Pat Parent1');
  // the instructor sees the meetings on My day (reused Programs code): assign one for every week
  staffView = ok(await api('GET', `/skischool/groups/${g.id}`, { token: T.dana }));
  ok(await api('PATCH', `/skischool/groups/${g.id}/meetings/${staffView.meetings[0].id}`, { token: T.dana, body: { coach_staff_id: D.ivy, all: true } }));
  const day = ok(await api('GET', `/skischool/my-day?date=${first}`, { token: T.ivy }));
  const item = day.items.find((i) => i.kind === 'program');
  assert.ok(item, 'on Ivy\'s My day'); assert.equal(item.students.length, 3);
  // drop-off and pickup per meeting
  const mid = staffView.meetings[0].id;
  is(await api('POST', `/skischool/groups/${g.id}/meetings/${mid}/handoff`, { token: T.counter, body: { what: 'pickup', by: 'Cam Chap', count: 3 } }), 409, 'drop-off first');
  ok(await api('POST', `/skischool/groups/${g.id}/meetings/${mid}/handoff`, { token: T.counter, body: { what: 'dropoff', by: 'Cam Chap', count: 3 } }));
  const pick = ok(await api('POST', `/skischool/groups/${g.id}/meetings/${mid}/handoff`, { token: T.counter, body: { what: 'pickup', by: 'Dee Chap', count: 2 } }));
  assert.match(pick.mismatch, /3 were dropped off and 2 picked up/);
  const m0 = ok(await api('GET', `/skischool/groups/${g.id}`, { token: T.counter })).meetings[0];
  assert.deepEqual([m0.dropoff.by, m0.pickup.by, m0.pickup.count], ['Cam Chap', 'Dee Chap', 2]);
  // after the deadline the leader cannot change the roster
  await q('UPDATE group_programs SET deadline_at = ? WHERE id = ?', [`${plus(today, -1)} 12:00:00`, g.id]);
  assert.equal(ok(await G('GET', '')).open, false);
  is(await G('POST', '/students', { body: { first_name: 'Late', last_name: 'Kid', date_of_birth: `${year - 8}-05-05`, guardian_name: 'Pat Parent' } }), 409, 'closed at the deadline');
  is(await G('DELETE', `/students/${kids[1].id}`), 409);
  // a new link replaces the old one
  const nl = ok(await api('POST', `/skischool/groups/${g.id}/link`, { token: T.dana }));
  is(await G('GET', ''), 404, 'the old link stops working');
  ok(await pub('GET', `/group/${nl.link.split('/').pop()}`));
  is(await api('GET', `/skischool/groups/${g.id}`, { token: T.ivy }), 403, 'a plain instructor does not open group bookings');
});
