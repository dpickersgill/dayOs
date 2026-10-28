'use strict';

// Programs run in sessions: an after-school program meets once a week for 4 weeks, with a new group each weekday the
// parent picks, plus a makeup week held in reserve for weather. Several sessions a season, sold one at a time or as a
// bundle; early-bird prices and sibling discounts; a lift ticket included if the mountain says so; children sorted into
// classes by level on the first day, or ahead of time.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.SHOP_RATE_LIMIT = '1000';
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
const PS = require('../src/lib/programsessions');

let server; let base; let stripeMock; let pmMock; const mails = []; const refunds = []; const sessions = []; let n = 0;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const q = async (sql, params) => (await pool.query(sql, params))[0];
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const plus = (d, k) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const dow = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
let monday = plus(today, 14); while (dow(monday) !== 1) monday = plus(monday, 1);
const year = Number(today.slice(0, 4));

const DEVICE = 'test-device-0123456789abcdef'; // the app always says which device signs in; leaving it out asks for an emailed code
async function call(prefix, method, path, { token, body } = {}) {
  const res = await fetch(`${base}${prefix}${path}`, { method, headers: { 'x-device': DEVICE,  'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
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
const paid = (row, tenant) => ({ id: `evt_${++n}`, type: 'checkout.session.completed', data: { object: { id: row.stripe_session_id, payment_status: 'paid', amount_total: row.amount_cents, payment_intent: `pi_${row.stripe_session_id}`, metadata: { tenant_id: String(tenant), registration_id: String(row.id), kind: 'program' } } } });

const M = {};
let pub;
test.before(async () => {
  stripeMock = http.createServer((req, res) => {
    let data = ''; req.on('data', (c) => { data += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/checkout/sessions') { sessions.push({ key: req.headers['idempotency-key'], amount: Object.fromEntries(new URLSearchParams(data))['line_items[0][price_data][unit_amount]'] }); res.end(JSON.stringify({ id: `cs_prog_${++n}`, url: `https://checkout.stripe.test/c/${n}` })); }
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
  const slug = `ps-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Pine Peak', phone: '215-555-0000', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  M.slug = slug; M.id = (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id;
  for (const m of ['programs', 'shop']) await q('INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE enabled = 1', [M.id, m]);
  modules.invalidate(M.id);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  M.owner = await login(`owner@${slug}.test`);
  ok(await api('POST', '/users', { token: M.owner, body: { email: `inst@${slug}.test`, password: PW, role: 'instructor' } }));
  ok(await api('POST', '/users', { token: M.owner, body: { email: `desk@${slug}.test`, password: PW, role: 'counter' } }));
  M.inst = await login(`inst@${slug}.test`); M.desk = await login(`desk@${slug}.test`);
  M.ticket = ok(await api('POST', '/products', { token: M.owner, body: { kind: 'day_ticket', name: 'Program lift ticket', base_price_cents: 0 } })).id;
  ok(await api('POST', '/tax-rules', { token: M.owner, body: { name: 'Sales tax', applies_to: 'program', rate_percent: 6 } }));
  ok(await api('PUT', '/tenant/profile', { token: M.owner, body: { online_shop: true, waiver_text: 'I accept the risks of skiing.' } }));
  pub = (m, p, o) => call('/api/v1/public', m, `/${slug}${p}`, o);
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => stripeMock.close(r)); await new Promise((r) => pmMock.close(r)); await pool.end(); });

const person = async (first, last, dob) => ok(await api('POST', '/people', { token: M.owner, body: { first_name: first, last_name: last, date_of_birth: dob, sex: 'female', email: `${first.toLowerCase()}.${suffix}@x.test`, phone: '215-555-0199' } })).id;

test('the dates: four weeks on the chosen weekday, a skipped holiday moves the run on a week, then the makeup week', () => {
  const term = { starts_on: plus(monday, -2), weeks: 4, makeup_weeks: 1, skip_dates: JSON.stringify([plus(monday, 14)]) };
  const d = PS.meetingDates(term, 1);
  assert.deepEqual(d.map((x) => [x.date, x.kind]), [[monday, 'regular'], [plus(monday, 7), 'regular'], [plus(monday, 21), 'regular'], [plus(monday, 28), 'regular'], [plus(monday, 35), 'makeup']]);
  assert.equal(PS.meetingDates(term, 3)[0].date, plus(monday, 2), 'Wednesdays start that week');
  const steps = { price_cents: 20000, price_steps: JSON.stringify([{ label: 'Early bird', until: plus(today, 5), price_cents: 17500 }]) };
  assert.deepEqual([PS.priceNow(steps, null, today).cents, PS.priceNow(steps, null, plus(today, 6)).cents], [17500, 20000]);
  assert.equal(PS.priceNow(steps, { price_cents: 22000 }, today).cents, 19500, 'a dearer day keeps its gap during the early bird');
  assert.equal(PS.siblingOff({ sibling_mode: 'percent', sibling_value: 10 }, 20000, 1), 2000);
  assert.equal(PS.siblingOff({ sibling_mode: 'percent', sibling_value: 10 }, 20000, 0), 0, 'the first child pays full price');
});

test('a manager sets up a session once: a group for each weekday, its dates made, the makeup week held in reserve', async () => {
  M.program = ok(await api('POST', '/programs', { token: M.owner, body: { name: 'After-School Ski & Ride', kind: 'school_program', season: '2026-27', price_cents: 0, age_min: 6, age_max: 12, online: true, includes_ticket: true, ticket_product_id: M.ticket, includes_rental: true, sibling_mode: 'percent', sibling_value: 10 } })).id;
  is(await api('POST', `/programs/${M.program}/terms`, { token: M.inst, body: {} }), 403, 'managers set up sessions');
  const s1 = ok(await api('POST', `/programs/${M.program}/terms`, { token: M.owner, body: {
    name: 'Session 1', starts_on: monday, weeks: 4, makeup_weeks: 1, start_time: '15:45', end_time: '17:45', price_cents: 20000, status: 'open',
    price_steps: [{ label: 'Early bird', until: plus(today, 7), price_cents: 18000 }],
    days: [{ weekday: 1, capacity: 2 }, { weekday: 2, capacity: 10 }, { weekday: 3, capacity: 10 }, { weekday: 4, capacity: 10, price_cents: 21000 }],
  } }), 201);
  M.s1 = s1.id;
  assert.deepEqual(s1.groups.map((g) => g.day), ['Monday', 'Tuesday', 'Wednesday', 'Thursday']);
  for (const g of s1.groups) {
    assert.equal(g.meetings.length, 5);
    assert.deepEqual(g.meetings.map((m) => m.status), ['scheduled', 'scheduled', 'scheduled', 'scheduled', 'standby']);
  }
  M.mon = s1.groups[0]; M.tue = s1.groups[1]; M.thu = s1.groups[3];
  assert.equal(M.mon.price_now.cents, 18000, 'early bird now');
  assert.equal(M.thu.price_now.cents, 19000, 'Thursday keeps its $10 more');
  assert.equal(M.mon.meetings[0].date, monday);
  is(await api('POST', `/programs/${M.program}/terms`, { token: M.owner, body: { name: 'x', starts_on: monday, weeks: 4, start_time: '17:00', end_time: '16:00', price_cents: 1, days: [{ weekday: 1 }] } }), 400, 'end after start');

  const s2 = ok(await api('POST', `/programs/terms/${M.s1}/copy`, { token: M.owner, body: { name: 'Session 2', starts_on: plus(monday, 42) } }), 201);
  M.s2 = s2.id;
  assert.equal(s2.status, 'draft', 'a copy starts as a draft');
  assert.equal(s2.groups.length, 4);
  assert.equal(s2.groups[0].meetings[0].date, plus(monday, 42));
  assert.equal(s2.price_steps[0].until, plus(today, 49), 'the early bird moves with it');
  ok(await api('PATCH', `/programs/terms/${M.s2}`, { token: M.owner, body: { status: 'open' } }));
  M.s2g = s2.groups;
});

test('staff enroll by day; a full day takes a waitlist; withdrawing moves the next child in; moving days keeps the session', async () => {
  const a = await person('Ava', 'Ames', `${year - 9}-01-10`); const b = await person('Ben', 'Bell', `${year - 8}-02-10`); const c = await person('Cy', 'Cole', `${year - 10}-03-10`);
  const d = await person('Di', 'Dunn', `${year - 7}-04-10`);
  const enroll = (pid, gid, extra = {}) => api('POST', `/programs/terms/${M.s1}/enroll`, { token: M.desk, body: { person_id: pid, group_id: gid, ...extra } });
  assert.equal(ok(await enroll(a, M.mon.id)).status, 'enrolled');
  assert.equal(ok(await enroll(b, M.mon.id)).status, 'enrolled');
  assert.equal(ok(await enroll(c, M.mon.id)).status, 'waitlist', 'Mondays hold 2');
  assert.equal(ok(await enroll(d, M.tue.id)).status, 'enrolled');
  is(await enroll(a, M.tue.id), 409, 'one day per session');
  const roster = ok(await api('GET', `/programs/groups/${M.mon.id}/roster`, { token: M.inst }));
  assert.deepEqual(roster.data.map((r) => r.status), ['enrolled', 'enrolled', 'waitlist']);
  assert.equal(roster.data[0].owes_cents, 18000, 'nothing paid yet');
  assert.equal(roster.program.includes_rental, true);
  const ben = roster.data.find((r) => r.first_name === 'Ben');
  ok(await api('POST', `/programs/enrollments/${ben.enrollment_id}/move`, { token: M.desk, body: { group_id: M.tue.id } }));
  const mon = ok(await api('GET', `/programs/groups/${M.mon.id}/roster`, { token: M.inst })).data;
  assert.ok(mon.some((r) => r.first_name === 'Cy' && r.status === 'enrolled'), 'Cy moved in off the waitlist');
  is(await api('POST', `/programs/enrollments/${ben.enrollment_id}/move`, { token: M.desk, body: { group_id: M.s2g[0].id } }), 400, 'not into another session');
  M.kids = { a, b, c, d };
});

test('weather: canceling a day uses that group\'s makeup date and tells the families; with none left, the manager adds a date', async () => {
  const before = mails.length;
  const first = M.mon.meetings[0];
  is(await api('POST', `/programs/meetings/${first.id}/cancel`, { token: M.inst, body: { reason: 'Ice storm' } }), 403);
  const out = ok(await api('POST', `/programs/meetings/${first.id}/cancel`, { token: M.owner, body: { reason: 'Ice storm' } }));
  assert.equal(out.makeup.date, plus(monday, 28), 'the makeup Monday is now a lesson');
  assert.equal(out.emailed, 2, 'both Monday families');
  const sent = mails.slice(before);
  assert.ok(sent.every((m) => /canceled/.test(m.Subject) && m.TextBody.includes('makeup lesson')));
  const tue = ok(await api('GET', `/programs/terms/${M.s1}`, { token: M.owner })).groups.find((g) => g.id === M.tue.id);
  assert.deepEqual(tue.meetings.map((m) => m.status), ['scheduled', 'scheduled', 'scheduled', 'scheduled', 'standby'], 'Tuesday is untouched');
  const again = ok(await api('POST', `/programs/meetings/${M.mon.meetings[1].id}/cancel`, { token: M.owner, body: { reason: 'Wind hold', notify: false } }));
  assert.equal(again.makeup, null);
  assert.equal(again.no_makeup_left, true);
  assert.equal(again.per_lesson_cents, 5000, '$200 over 4 lessons');
  is(await api('POST', `/programs/meetings/${M.mon.meetings[1].id}/cancel`, { token: M.owner, body: { reason: 'Wind hold' } }), 409, 'already canceled');
  ok(await api('POST', `/programs/groups/${M.mon.id}/meetings`, { token: M.owner, body: { date: plus(monday, 35) } }), 201);
  const mon = ok(await api('GET', `/programs/terms/${M.s1}`, { token: M.owner })).groups.find((g) => g.id === M.mon.id);
  assert.equal(mon.meetings.filter((m) => m.status === 'scheduled').length, 4, 'still four lessons');
});

test('a storm day cancels every program lesson on that date and nothing else', async () => {
  const wed = plus(monday, 9);
  const preview = ok(await api('POST', '/programs/cancel-day', { token: M.owner, body: { date: wed, reason: 'Snowstorm', preview: true } }));
  assert.equal(preview.data.length, 1, 'only the Wednesday group meets that day');
  const done = ok(await api('POST', '/programs/cancel-day', { token: M.owner, body: { date: wed, reason: 'Snowstorm', notify: false } }));
  assert.equal(done.data[0].makeup.date, plus(monday, 30));
  const day = ok(await api('GET', `/programs/day?date=${wed}`, { token: M.inst }));
  assert.equal(day.data[0].status, 'cancelled');
  is(await api('POST', '/programs/cancel-day', { token: M.owner, body: { date: wed, reason: 'Snowstorm' } }), 409, 'nothing left to cancel');
});

test('classes by level: split on the first day, or preset from last session; attendance on the lesson date', async () => {
  const mon = M.mon.id;
  const green = ok(await api('POST', `/programs/groups/${mon}/levels`, { token: M.inst, body: { name: 'Green' } }), 201).id;
  const blue = ok(await api('POST', `/programs/groups/${mon}/levels`, { token: M.inst, body: { name: 'Blue' } }), 201).id;
  const kids = ok(await api('GET', `/programs/groups/${mon}/roster`, { token: M.inst })).data.filter((r) => r.status === 'enrolled');
  ok(await api('PUT', `/programs/groups/${mon}/levels/assign`, { token: M.inst, body: { assignments: [{ enrollment_id: kids[0].enrollment_id, level_id: green }, { enrollment_id: kids[1].enrollment_id, level_id: blue }] } }));
  // Session 2 Mondays: the classes were copied? (Session 2 was copied before the classes existed, so add them.)
  const s2mon = M.s2g[0].id;
  ok(await api('POST', `/programs/groups/${s2mon}/levels`, { token: M.owner, body: { name: 'Green' } }), 201);
  const s2blue = ok(await api('POST', `/programs/groups/${s2mon}/levels`, { token: M.owner, body: { name: 'Blue' } }), 201).id;
  ok(await api('POST', `/programs/terms/${M.s2}/enroll`, { token: M.owner, body: { person_id: kids[1].person_id, group_id: s2mon } }), 201);
  const preset = ok(await api('POST', `/programs/groups/${s2mon}/levels/preset`, { token: M.owner }));
  assert.equal(preset.placed, 1);
  const s2 = ok(await api('GET', `/programs/groups/${s2mon}/roster`, { token: M.owner })).data;
  assert.equal(s2[0].level_id, s2blue, 'Blue last session, Blue again');
  const meeting = M.mon.meetings[2];
  ok(await api('PUT', `/programs/sessions/${meeting.id}/attendance`, { token: M.inst, body: { marks: kids.map((k, i) => ({ person_id: k.person_id, present: i === 0 })) } }));
  const sheet = ok(await api('GET', `/programs/meetings/${meeting.id}`, { token: M.inst }));
  assert.deepEqual(sheet.data.map((k) => k.present).sort(), [false, true]);
});

test('at the counter: a place on a day, the second child gets the sibling discount, the lift ticket is issued; bundles sell both sessions', async () => {
  const mom = await person('Mia', 'Moss', `${year - 40}-01-01`);
  const k1 = await person('Max', 'Moss', `${year - 9}-05-05`); const k2 = await person('Mo', 'Moss', `${year - 7}-06-06`);
  const sale = ok(await api('POST', '/checkout', { token: M.desk, body: {
    customer: { person_id: mom }, participants: { a: { person_id: k1 }, b: { person_id: k2 } },
    lines: [{ type: 'program', program_id: M.program, term_id: M.s1, group_id: M.thu.id, participant: 'a' }, { type: 'program', program_id: M.program, term_id: M.s1, group_id: M.thu.id, participant: 'b' }],
    payments: [{ tender: 'cash', amount_cents: 19000 + 17100 + 1140 + 1026 }],
  } }), 201);
  const order = (await q('SELECT subtotal_cents, tax_cents FROM orders WHERE tenant_id = ? AND id = ?', [M.id, sale.id]))[0];
  assert.equal(order.subtotal_cents, 19000 + 17100, 'Thursday early bird $190, sibling 10% off');
  assert.equal(order.tax_cents, Math.round(19000 * 0.06) + Math.round(17100 * 0.06));
  assert.equal(sale.programs.length, 2);
  const ticket = (await q('SELECT t.valid_from, t.valid_to, t.uses_remaining FROM tickets t JOIN program_enrollments e ON e.ticket_id = t.id WHERE e.tenant_id = ? AND e.person_id = ?', [M.id, k1]))[0];
  assert.deepEqual([String(ticket.valid_from).slice(0, 10), String(ticket.valid_to).slice(0, 10), ticket.uses_remaining], [plus(monday, 3), plus(monday, 31), 5], 'good for the Thursdays, makeup included');
  const thu = ok(await api('GET', `/programs/groups/${M.thu.id}/roster`, { token: M.inst })).data;
  assert.ok(thu.every((r) => r.ticket_code && r.owes_cents === 0));

  const bundle = ok(await api('POST', `/programs/${M.program}/bundles`, { token: M.owner, body: { name: 'Both sessions', price_cents: 36000, term_ids: [M.s1, M.s2] } }), 201).id;
  const k3 = await person('Nia', 'Nash', `${year - 9}-07-07`);
  const two = ok(await api('POST', '/checkout', { token: M.desk, body: {
    customer: { person_id: mom }, participants: { n: { person_id: k3 } }, lines: [{ type: 'program', program_id: M.program, participant: 'n', bundle_id: bundle, groups: [{ term_id: M.s1, group_id: M.tue.id }, { term_id: M.s2, group_id: M.s2g[1].id }] }],
    payments: [{ tender: 'cash', amount_cents: 36000 + 2160 }],
  } }), 201);
  assert.equal(two.programs.length, 2, 'one place in each session');
  const places = await q('SELECT term_id, price_cents, bundle_id FROM program_enrollments WHERE tenant_id = ? AND person_id = ? ORDER BY term_id', [M.id, k3]);
  assert.equal(places.reduce((s, p) => s + p.price_cents, 0), 36000, 'the bundle price is shared between the sessions');
  assert.ok(places.every((p) => p.bundle_id === bundle));
  M.bundle = bundle;
});

test('online: parents see what is open, prices with the early bird and sibling discount, pay, and get every date by email', async () => {
  const page = ok(await pub('GET', '/programs'));
  const p = page.programs.find((x) => x.id === M.program);
  assert.deepEqual(p.terms.map((t) => t.name), ['Session 1', 'Session 2']);
  const tue = p.terms[0].groups.find((g) => g.day === 'Tuesday');
  assert.equal(tue.dates.length, 4); assert.equal(tue.makeup_dates.length, 1);
  assert.equal(p.bundles[0].name, 'Both sessions');
  const kidA = { first_name: 'Ella', last_name: 'Ford', date_of_birth: `${year - 8}-01-01` };
  const kidB = { first_name: 'Finn', last_name: 'Ford', date_of_birth: `${year - 10}-01-01` };
  const regs = [{ program_id: M.program, term_id: M.s1, group_id: M.tue.id, child: kidA }, { program_id: M.program, term_id: M.s1, group_id: M.tue.id, child: kidB }];
  const qt = ok(await pub('POST', '/programs/quote', { body: { registrations: regs } }));
  assert.deepEqual(qt.lines.map((l) => [l.list_cents, l.sibling_cents]), [[18000, 0], [18000, 1800]]);
  assert.equal(qt.total_cents, Math.round(18000 * 1.06) + Math.round(16200 * 1.06));
  is(await pub('POST', '/programs/quote', { body: { registrations: [{ ...regs[0], child: { ...kidA, date_of_birth: `${year - 15}-01-01` } }] } }), 400, 'too old');
  const contact = { contact_first_name: 'Fay', contact_last_name: 'Ford', contact_email: `fay.${suffix}@x.test`, contact_phone: '215-555-0101' };
  is(await pub('POST', '/programs/register', { body: { ...contact, registrations: regs } }), 400, 'the waiver');
  const r = ok(await pub('POST', '/programs/register', { body: { ...contact, registrations: regs, waiver_accepted: true } }), 201);
  assert.match(r.checkout_url, /checkout\.stripe\.test/);
  const row = (await q('SELECT * FROM program_registrations WHERE tenant_id = ? AND reference = ?', [M.id, r.reference]))[0];
  // Each registration has its own Stripe key (two families paying the same amount must never share one).
  assert.equal(sessions.at(-1).key, `checkout-program-${row.id}-${row.amount_cents}`);
  assert.equal((await q('SELECT COUNT(*) AS n FROM program_enrollments e JOIN people p ON p.id = e.person_id WHERE e.tenant_id = ? AND p.last_name = ?', [M.id, 'Ford']))[0].n, 0, 'nothing held before paying');
  const before = mails.length;
  ok(await webhook(paid(row, M.id)));
  ok(await webhook(paid(row, M.id)), 200);
  const places = await q("SELECT e.status, e.ticket_id, e.guardian_id FROM program_enrollments e JOIN people p ON p.id = e.person_id WHERE e.tenant_id = ? AND p.last_name = 'Ford'", [M.id]);
  assert.equal(places.length, 2, 'a repeated event makes nothing twice');
  assert.ok(places.every((x) => x.status === 'enrolled' && x.ticket_id && x.guardian_id));
  const email = mails.slice(before).find((m) => /registered/.test(m.Subject));
  assert.ok(email && email.TextBody.includes('Makeup date') && email.TextBody.includes('Lift ticket'));
  const view = ok(await pub('GET', `/programs/registrations/${row.view_token}`));
  assert.equal(view.places.length, 2);
  assert.equal(view.places[0].dates.length, 4);
  const waivers = await q("SELECT COUNT(*) AS n FROM waivers w JOIN people p ON p.id = w.person_id WHERE w.tenant_id = ? AND p.last_name = 'Ford'", [M.id]);
  assert.equal(waivers[0].n, 2, 'signed online by the parent');
});

test('online: a day that filled while the parent paid is refunded in full; a full day takes a waitlist sign-up', async () => {
  const mon = M.mon.id; // full: Ava and Cy
  const contact = { contact_first_name: 'Gus', contact_last_name: 'Gray', contact_email: `gus.${suffix}@x.test`, contact_phone: '215-555-0102' };
  const kid = { first_name: 'Hal', last_name: 'Gray', date_of_birth: `${year - 9}-01-01` };
  is(await pub('POST', '/programs/register', { body: { ...contact, waiver_accepted: true, registrations: [{ program_id: M.program, term_id: M.s1, group_id: mon, child: kid }] } }), 409, 'full');
  // Wednesday: register, then fill it before the payment lands.
  const wed = (await q('SELECT id FROM program_groups WHERE tenant_id = ? AND term_id = ? AND weekday = 3', [M.id, M.s1]))[0].id;
  ok(await api('PATCH', `/programs/groups/${wed}`, { token: M.owner, body: { capacity: 1 } }));
  const r = ok(await pub('POST', '/programs/register', { body: { ...contact, waiver_accepted: true, registrations: [{ program_id: M.program, term_id: M.s1, group_id: wed, child: { ...kid, first_name: 'Ivy' } }] } }), 201);
  const other = await person('Jo', 'Jett', `${year - 9}-01-01`);
  ok(await api('POST', `/programs/terms/${M.s1}/enroll`, { token: M.owner, body: { person_id: other, group_id: wed } }), 201);
  const row = (await q('SELECT * FROM program_registrations WHERE tenant_id = ? AND reference = ?', [M.id, r.reference]))[0];
  const res = ok(await webhook(paid(row, M.id)));
  assert.equal(res.refunded, true);
  assert.equal(refunds.at(-1).payment_intent, `pi_${row.stripe_session_id}`);
  assert.equal((await q('SELECT status FROM program_registrations WHERE id = ?', [row.id]))[0].status, 'refunded');
  const w = ok(await pub('POST', '/programs/waitlist', { body: { ...contact, program_id: M.program, term_id: M.s1, group_id: mon, any_day: true, child: kid } }), 201);
  assert.equal(w.status, 'waitlist');
  // A place opening on Monday goes to the first waiting for Monday (Hal).
  const ava = (await q("SELECT e.id FROM program_enrollments e JOIN people p ON p.id = e.person_id WHERE e.tenant_id = ? AND p.first_name = 'Ava' AND e.term_id = ?", [M.id, M.s1]))[0].id;
  const out = ok(await api('POST', `/programs/${M.program}/enrollments/${ava}/withdraw`, { token: M.owner }));
  const hal = (await q("SELECT id FROM people WHERE tenant_id = ? AND first_name = 'Hal'", [M.id]))[0].id;
  assert.equal(out.promoted_person_id, hal);
});

test('online: a registration whose saved card page was lost is still made when the payment lands with the right amount', async () => {
  const contact = { contact_first_name: 'Lou', contact_last_name: 'Lane', contact_email: `lou.${suffix}@x.test`, contact_phone: '215-555-0103' };
  const r = ok(await pub('POST', '/programs/register', { body: { ...contact, waiver_accepted: true, registrations: [{ program_id: M.program, term_id: M.s1, group_id: M.tue.id, child: { first_name: 'Max', last_name: 'Lane', date_of_birth: `${year - 9}-01-01` } }] } }), 201);
  const row = (await q('SELECT * FROM program_registrations WHERE tenant_id = ? AND reference = ?', [M.id, r.reference]))[0];
  await q('UPDATE program_registrations SET stripe_session_id = NULL WHERE id = ?', [row.id]);
  assert.equal(ok(await webhook(paid(row, M.id))).ok, true);
  assert.equal((await q('SELECT status FROM program_registrations WHERE id = ?', [row.id]))[0].status, 'paid');
  const n0 = refunds.length;
  const again = ok(await webhook(paid({ ...row, stripe_session_id: `cs_prog_other_${suffix}` }, M.id)));
  assert.equal(again.refunded, true, 'a second page for a registration already paid goes back');
  assert.equal(refunds.length, n0 + 1);
});

test('dates cannot be rebuilt once children are enrolled; the old program without sessions still works', async () => {
  is(await api('PATCH', `/programs/terms/${M.s1}`, { token: M.owner, body: { weeks: 6 } }), 409);
  ok(await api('PATCH', `/programs/terms/${M.s1}`, { token: M.owner, body: { price_cents: 21000 } }));
  const club = ok(await api('POST', '/programs', { token: M.owner, body: { name: 'Race club', kind: 'race_team', season: '2026-27', price_cents: 50000, capacity: 1 } })).id;
  const a = await person('Kai', 'King', `${year - 12}-01-01`); const b = await person('Lu', 'Lake', `${year - 12}-01-01`);
  assert.equal(ok(await api('POST', `/programs/${club}/enrollments`, { token: M.owner, body: { person_id: a } })).status, 'enrolled');
  assert.equal(ok(await api('POST', `/programs/${club}/enrollments`, { token: M.owner, body: { person_id: b } })).status, 'waitlist');
  is(await api('POST', `/programs/${club}/enrollments`, { token: M.owner, body: { person_id: a } }), 409);
});
