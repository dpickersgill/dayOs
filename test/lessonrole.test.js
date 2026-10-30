'use strict';

// Lesson planning, best of breed (2026.11.9), Track ROLE: the ski school Director and Supervisor access levels end to end.
// Only owners and managers set the level (the staff page); a Director plans, edits lessons, approves pay, sets lesson
// prices, sells lessons and refunds lesson-only orders up to the counter refund limit, and is refused Money, billing, a
// ticket product's price, a ticket sale and a lift-ticket refund; a Director must use two-step sign-in. A Supervisor runs
// the day (lineup, assigning instructors) and is refused publishing, pay and settings. Instructors and managers are unchanged.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.BOOKING_RATE_LIMIT = '1000';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
process.env.MAIL_FROM = 'hello@summitops.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const config = require('../src/config');
const mailer = require('../src/lib/mailer');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { authenticate } = require('../src/middleware/auth');
const SA = require('../src/lib/schoolaccess');
const menus = require('../src/lib/menus');

let server; let side; let base; let sideBase; let pmMock;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const addDays = (d, k) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const q = async (sql, params) => (await pool.query(sql, params))[0];

const DEVICE = 'test-device-0123456789abcdef';
async function call(method, path, { token, body, at = base } = {}) {
  const res = await fetch(`${at}${at === base ? '/api/v1' : ''}${path}`, { method, headers: { 'x-device': DEVICE, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const ok = (r, s) => { assert.ok(r.status < 300, `${r.status} ${r.text}`); if (s) assert.equal(r.status, s, r.text); return r.body; };
const no = (r, msg) => { assert.equal(r.status, 403, `${msg}: ${r.status} ${r.text}`); return r.body; };

/** A mountain: owner, manager, counter, and three instructors (Dana the director, Sam the supervisor, Ivy the instructor). */
let M;
async function newMountain() {
  const slug = `lr-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Role Peak', phone: '215-555-0000', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const login = async (email) => (await call('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  const m = { slug, id: (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id, login };
  m.owner = await login(`owner@${slug}.test`);
  for (const role of ['counter', 'manager']) {
    ok(await call('POST', '/users', { token: m.owner, body: { email: `${role}@${slug}.test`, password: PW, role } }));
    m[role] = await login(`${role}@${slug}.test`);
  }
  for (const [k, first] of [['dana', 'Dana'], ['sam', 'Sam'], ['ivy', 'Ivy']]) {
    const st = ok(await call('POST', '/workforce/staff', { token: m.owner, body: { person: { first_name: first, last_name: 'Teach', email: `${k}@${slug}.test` }, status: 'active' } }));
    m[`${k}Id`] = st.id;
    ok(await call('POST', '/users', { token: m.owner, body: { email: `${k}@${slug}.test`, password: PW, role: 'instructor', staff_id: st.id } }));
    m[k] = await login(`${k}@${slug}.test`);
  }
  m.group = ok(await call('POST', '/products', { token: m.owner, body: { kind: 'lesson', name: 'Group Lesson', base_price_cents: 8000 } })).id;
  m.ticket = ok(await call('POST', '/products', { token: m.owner, body: { kind: 'day_ticket', name: 'Day Ticket', base_price_cents: 6000 } })).id;
  return m;
}
const lesson = (token, date, time, extra = {}) => call('POST', '/skischool/sessions', { token, body: { product_id: M.group, starts_at: `${date}T${time}`, ends_at: `${date}T${String(Number(time.slice(0, 2)) + 2).padStart(2, '0')}:${time.slice(3)}`, ...extra } });
const customer = (first) => ({ details: { first_name: first, last_name: 'Guest', date_of_birth: '1985-03-02', sex: 'female', email: `${first}.guest.${suffix}@x.test`.toLowerCase() }, sign_waiver: true });

test.before(async () => {
  pmMock = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: 'm-1' })); }); });
  await new Promise((r) => pmMock.listen(0, '127.0.0.1', r));
  mailer.settings.apiBase = `http://127.0.0.1:${pmMock.address().port}`;
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  // The season plan's publish (Track PLAN) and the fill view (Track STAFF) guard themselves with school('director') and
  // school('supervisor'); a tiny app here stands in for them with the same guards behind the real sign-in check.
  const app = express();
  app.use(express.json(), authenticate);
  app.post('/plans/:id/publish', SA.school('director'), (_req, res) => res.json({ published: true }));
  app.get('/fill', SA.school('supervisor'), (_req, res) => res.json({ ok: true }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, details: err.details }));
  await new Promise((r) => { side = app.listen(0, r); });
  sideBase = `http://127.0.0.1:${side.address().port}`;
  M = await newMountain();
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => side.close(r)); pmMock.close(); await pool.end(); });

test('only owners and managers set the school access level, and the login sees it at once', async () => {
  const before = ok(await call('GET', `/skischool/access/${M.danaId}`, { token: M.owner }));
  assert.equal(before.level, 'instructor');
  assert.equal(before.login_role, 'instructor');
  no(await call('PUT', `/skischool/access/${M.danaId}`, { token: M.dana, body: { level: 'director' } }), 'an instructor cannot set her own level');
  no(await call('PUT', `/skischool/access/${M.danaId}`, { token: M.counter, body: { level: 'director' } }), 'counter staff cannot set a level');
  assert.equal(ok(await call('PUT', `/skischool/access/${M.danaId}`, { token: M.owner, body: { level: 'director' } })).level, 'director');
  // a manager can set it too; Sam has no teaching profile yet, so one is made
  assert.equal((await q('SELECT COUNT(*) AS n FROM instructor_profiles WHERE tenant_id = ? AND staff_id = ?', [M.id, M.samId]))[0].n, 0);
  assert.equal(ok(await call('PUT', `/skischool/access/${M.samId}`, { token: M.manager, body: { level: 'supervisor' } })).level, 'supervisor');
  assert.equal((await q('SELECT school_access FROM instructor_profiles WHERE tenant_id = ? AND staff_id = ?', [M.id, M.samId]))[0].school_access, 'supervisor');
  const [a] = await q("SELECT detail FROM audit_log WHERE tenant_id = ? AND action = 'school_access' AND entity_id = ? ORDER BY id DESC LIMIT 1", [M.id, M.samId]);
  assert.match(typeof a.detail === 'string' ? a.detail : JSON.stringify(a.detail), /supervisor/);
  // A director cannot promote anyone either (only owners and managers).
  no(await call('PUT', `/skischool/access/${M.ivyId}`, { token: M.dana, body: { level: 'supervisor' } }), 'a director cannot set levels');
  no(await call('GET', `/skischool/access/${M.ivyId}`, { token: M.dana }), 'a director cannot read levels');
  assert.equal((await call('PUT', `/skischool/access/${M.ivyId}`, { token: M.owner, body: { level: 'boss' } })).status, 400);

  const me = ok(await call('GET', '/auth/me', { token: M.dana }));
  assert.equal(me.school_access, 'director');
  assert.deepEqual(me.menu.apps.slice(0, 3), ['school', 'sell', 'catalog'], 'a director gets Sell and Products after Ski school');
  assert.equal(ok(await call('GET', '/auth/me', { token: M.sam })).school_access, 'supervisor');
  assert.ok(!ok(await call('GET', '/auth/me', { token: M.sam })).menu.apps.includes('sell'));
  assert.equal(ok(await call('GET', '/auth/me', { token: M.ivy })).school_access, 'instructor');
  assert.equal(ok(await call('GET', '/auth/me', { token: M.manager })).school_access, 'director');
  assert.equal(ok(await call('GET', '/auth/me', { token: M.counter })).school_access, null);
  assert.equal(menus.menuFor('instructor', null, 'supervisor').apps.includes('sell'), false);
});

test('a director plans, edits lessons, approves pay and sets lesson prices; never Money, billing or a ticket price', async () => {
  ok(await call('POST', '/plans/1/publish', { token: M.dana, at: sideBase }));
  ok(await call('GET', '/fill', { token: M.dana, at: sideBase }));
  const day = addDays(today, 10);
  const id = ok(await lesson(M.dana, day, '10:00', { capacity: 4 }), 201).id;
  ok(await call('PATCH', `/skischool/sessions/${id}`, { token: M.dana, body: { capacity: 6 } }));
  assert.equal((await q('SELECT capacity FROM lesson_sessions WHERE id = ?', [id]))[0].capacity, 6);
  ok(await call('PATCH', '/skischool/settings', { token: M.dana, body: {} }));
  ok(await call('PUT', `/skischool/instructors/${M.ivyId}/profile`, { token: M.dana, body: { disciplines: ['ski'], ski_level_max: 9, snowboard_level_max: null, teaches_kids: true, teaches_adaptive: false, psia_level: 'level1' } }));
  ok(await call('POST', '/skischool/levels', { token: M.dana, body: { discipline: 'ski', name: 'Race prep' } }), 201);
  ok(await call('GET', `/skischool/pay/payroll?from=${addDays(today, -6)}&to=${today}`, { token: M.dana }));
  ok(await call('POST', '/skischool/pay/payroll/approve', { token: M.dana, body: { from: addDays(today, -6), to: today, staff_ids: [M.ivyId], approved: true } }));
  ok(await call('GET', `/skischool/pay/mine?staff_id=${M.ivyId}`, { token: M.dana }));
  ok(await call('GET', '/skischool/director/reports', { token: M.dana }));
  // certifications on a teaching profile, but not on someone who does not teach
  const cert = ok(await call('POST', '/workforce/certifications', { token: M.owner, body: { name: 'PSIA Level 1' } }), 201).id;
  ok(await call('PUT', `/workforce/staff/${M.ivyId}/certifications`, { token: M.dana, body: { certification_id: cert } }));
  const lifty = ok(await call('POST', '/workforce/staff', { token: M.owner, body: { person: { first_name: 'Lou', last_name: 'Lift' }, status: 'active' } })).id;
  no(await call('PUT', `/workforce/staff/${lifty}/certifications`, { token: M.dana, body: { certification_id: cert } }), 'not a lift operator');
  // lesson products and prices
  ok(await call('PATCH', `/products/${M.group}`, { token: M.dana, body: { base_price_cents: 8500 } }));
  ok(await call('PUT', `/products/${M.group}/tiers`, { token: M.dana, body: { tiers: [{ tier: 'child', price_cents: 7000 }] } }));
  ok(await call('GET', `/products/${M.group}/pricing`, { token: M.dana }));
  const newLesson = ok(await call('POST', '/products', { token: M.dana, body: { kind: 'lesson', name: 'Private Hour', base_price_cents: 12000 } }), 201);
  assert.equal(newLesson.kind, 'lesson');
  no(await call('PATCH', `/products/${M.ticket}`, { token: M.dana, body: { base_price_cents: 1 } }), 'a ticket price');
  no(await call('PUT', `/products/${M.ticket}/tiers`, { token: M.dana, body: { tiers: [{ tier: 'adult', price_cents: 1 }] } }), 'ticket tiers');
  no(await call('PUT', `/products/${M.ticket}/calendar`, { token: M.dana, body: { entries: [{ on_date: day, price_cents: 1 }] } }), 'ticket calendar');
  no(await call('PATCH', `/products/${M.group}`, { token: M.dana, body: { kind: 'day_ticket' } }), 'turning a lesson into a ticket');
  no(await call('POST', '/products', { token: M.dana, body: { kind: 'day_ticket', name: 'Cheap', base_price_cents: 1 } }), 'a new ticket product');
  assert.equal((await q('SELECT base_price_cents FROM products WHERE id = ?', [M.ticket]))[0].base_price_cents, 6000);
  // Money, billing, other apps' settings, logins
  no(await call('GET', '/billing', { token: M.dana }), 'billing');
  no(await call('GET', `/till?date=${today}`, { token: M.dana }), 'the till (Money)');
  no(await call('GET', '/reports/weekly', { token: M.dana }), 'weekly reports (Money)');
  no(await call('POST', '/tax-rules', { token: M.dana, body: { name: 'x', applies_to: 'all', rate_bps: 100 } }), 'tax rules');
  no(await call('GET', '/workforce/staff', { token: M.dana }), 'the whole staff list');
  no(await call('POST', '/users', { token: M.dana, body: { email: `x@${M.slug}.test`, password: PW, role: 'counter' } }), 'logins');
  no(await call('POST', '/workforce/certifications', { token: M.dana, body: { name: 'Lift ops' } }), 'certification types');
});

test('a director sells lessons and refunds lesson-only orders up to the counter limit; never tickets', async () => {
  const day = addDays(today, 3);
  const sid = ok(await lesson(M.owner, day, '09:00', { capacity: 6 }), 201).id;
  const menu = ok(await call('GET', '/checkout/menu', { token: M.dana }));
  assert.equal(menu.lessons_only, true);
  assert.equal(menu.tickets.length, 0);
  assert.ok(menu.lessons.some((l) => l.id === sid));
  assert.ok(ok(await call('GET', '/checkout/menu', { token: M.counter })).tickets.length > 0, 'counter staff see tickets as before');
  const price = (await q('SELECT base_price_cents AS c FROM products WHERE id = ?', [M.group]))[0].c;
  const sale = ok(await call('POST', '/checkout', { token: M.dana, body: { channel: 'window', customer: customer('Lena'), lines: [{ type: 'lesson', session_id: sid }], payments: [{ tender: 'cash', amount_cents: price }] } }), 201);
  const orderId = sale.order_id || sale.id;
  no(await call('POST', '/checkout', { token: M.dana, body: { channel: 'window', customer: customer('Tom'), lines: [{ type: 'ticket', product_id: M.ticket }], payments: [{ tender: 'cash', amount_cents: 6000 }] } }), 'a ticket sale');
  no(await call('POST', '/checkout', { token: M.dana, body: { channel: 'window', customer: customer('Mix'), lines: [{ type: 'lesson', session_id: sid }, { type: 'ticket', product_id: M.ticket }], payments: [{ tender: 'cash', amount_cents: price + 6000 }] } }), 'a lesson with a ticket');
  const ticketSale = ok(await call('POST', '/checkout', { token: M.counter, body: { channel: 'window', customer: customer('Tess'), lines: [{ type: 'ticket', product_id: M.ticket }], payments: [{ tender: 'cash', amount_cents: 6000 }] } }), 201);
  const ticketOrder = ticketSale.order_id || ticketSale.id;
  // With no counter refund limit, only a manager gives money back.
  assert.equal((await call('POST', `/orders/${orderId}/refund`, { token: M.dana, body: { reason: 'customer_request' } })).status, 403);
  await q('INSERT INTO guest_settings (tenant_id, counter_refund_limit_cents) VALUES (?, 1000) ON DUPLICATE KEY UPDATE counter_refund_limit_cents = 1000', [M.id]);
  const over = no(await call('POST', `/orders/${orderId}/refund`, { token: M.dana, body: { reason: 'customer_request' } }), 'over the counter limit');
  assert.match(over.error || over.message || JSON.stringify(over), /up to/);
  await q('UPDATE guest_settings SET counter_refund_limit_cents = 20000 WHERE tenant_id = ?', [M.id]);
  ok(await call('GET', `/orders/${orderId}`, { token: M.dana }));
  no(await call('GET', `/orders/${ticketOrder}`, { token: M.dana }), 'reading a ticket order');
  const list = ok(await call('GET', '/orders', { token: M.dana })).data.map((o) => o.id);
  assert.ok(list.includes(orderId) && !list.includes(ticketOrder), 'the order list holds lesson orders only');
  no(await call('POST', `/orders/${ticketOrder}/refund`, { token: M.dana, body: { reason: 'customer_request' } }), 'a lift-ticket refund');
  ok(await call('POST', `/orders/${orderId}/refund`, { token: M.dana, body: { reason: 'customer_request' } }));
  assert.equal((await q("SELECT status FROM lesson_bookings b JOIN people p ON p.id = b.person_id WHERE b.session_id = ? AND p.first_name = 'Lena'", [sid]))[0].status, 'cancelled');
});

test('a supervisor runs the day and assigns instructors; never publishing, pay or settings', async () => {
  const day = addDays(today, 5);
  const sid = ok(await lesson(M.owner, day, '10:00', { capacity: 6 }), 201).id;
  ok(await call('PUT', `/skischool/instructors/${M.ivyId}/profile`, { token: M.owner, body: { disciplines: ['ski'], ski_level_max: 9, snowboard_level_max: null, teaches_kids: true, teaches_adaptive: false, psia_level: 'level1' } }));
  ok(await call('PATCH', `/skischool/sessions/${sid}/instructor`, { token: M.sam, body: { instructor_id: M.ivyId } }));
  assert.equal((await q('SELECT instructor_id FROM lesson_sessions WHERE id = ?', [sid]))[0].instructor_id, M.ivyId);
  ok(await call('GET', `/skischool/sessions/${sid}/eligible-instructors`, { token: M.sam }));
  const lu = ok(await call('GET', `/skischool/lineups?date=${day}`, { token: M.sam }));
  assert.ok(lu.data.length >= 1);
  ok(await call('POST', `/skischool/lineups/${lu.data[0].id}/suggest`, { token: M.sam, body: { from: 'booked' } }));
  ok(await call('PATCH', `/skischool/lineups/${lu.data[0].id}`, { token: M.sam, body: { ratio: 5 } }));
  ok(await call('GET', `/skischool/checkin?date=${day}`, { token: M.sam }));
  ok(await call('GET', '/skischool/requests', { token: M.sam }));
  ok(await call('GET', '/skischool/waitlists', { token: M.sam }));
  ok(await call('GET', `/skischool/my-day?date=${day}&staff_id=${M.ivyId}`, { token: M.sam }));
  const roster = ok(await call('GET', `/skischool/sessions/${sid}/roster`, { token: M.sam }));
  assert.equal(roster.details, true, 'a supervisor sees the roster details to run the day');
  ok(await call('GET', '/fill', { token: M.sam, at: sideBase }));
  no(await call('POST', '/plans/1/publish', { token: M.sam, at: sideBase }), 'publishing a plan');
  no(await lesson(M.sam, day, '13:00'), 'adding lessons');
  no(await call('POST', '/skischool/pay/payroll/approve', { token: M.sam, body: { from: addDays(today, -6), to: today, staff_ids: [M.ivyId], approved: true } }), 'pay approval');
  no(await call('GET', `/skischool/pay/mine?staff_id=${M.ivyId}`, { token: M.sam }), 'another instructor\'s pay');
  no(await call('PATCH', '/skischool/settings', { token: M.sam, body: {} }), 'school settings');
  no(await call('PATCH', `/products/${M.group}`, { token: M.sam, body: { base_price_cents: 1 } }), 'lesson prices');
  no(await call('GET', '/checkout/menu', { token: M.sam }), 'Sell');
  no(await call('PUT', `/skischool/access/${M.ivyId}`, { token: M.sam, body: { level: 'director' } }), 'setting levels');
});

test('an instructor and a manager are unchanged', async () => {
  const day = addDays(today, 6);
  const mine = ok(await lesson(M.manager, day, '10:00', { instructor_id: M.ivyId }), 201).id;
  const other = ok(await lesson(M.manager, day, '13:00'), 201).id;
  no(await call('PATCH', `/skischool/sessions/${other}/instructor`, { token: M.ivy, body: { instructor_id: M.ivyId } }), 'an instructor assigning');
  no(await lesson(M.ivy, day, '15:00'), 'an instructor adding lessons');
  no(await call('GET', '/skischool/lineups', { token: M.ivy }), 'the lineup board');
  no(await call('GET', '/checkout/menu', { token: M.ivy }), 'Sell');
  no(await call('PATCH', `/products/${M.group}`, { token: M.ivy, body: { base_price_cents: 1 } }), 'lesson prices');
  assert.equal((await call('GET', `/skischool/my-day?staff_id=${M.samId}`, { token: M.ivy })).status, 403, 'only her own day');
  ok(await call('GET', `/skischool/my-day?date=${day}`, { token: M.ivy }));
  assert.equal(ok(await call('GET', `/skischool/sessions/${other}/roster`, { token: M.ivy })).details, false, 'no children\'s details on someone else\'s lesson');
  assert.equal(ok(await call('GET', `/skischool/sessions/${mine}/roster`, { token: M.ivy })).details, true);
  assert.equal(ok(await call('GET', '/auth/me', { token: M.ivy })).menu.apps.includes('sell'), false);
  // a manager does everything as before
  ok(await call('PATCH', `/skischool/sessions/${other}/instructor`, { token: M.manager, body: { instructor_id: M.ivyId } }));
  ok(await call('POST', '/plans/1/publish', { token: M.manager, at: sideBase }));
  ok(await call('GET', '/checkout/menu', { token: M.manager }));
  ok(await call('PATCH', `/products/${M.ticket}`, { token: M.manager, body: { base_price_cents: 6100 } }));
  ok(await call('PATCH', '/skischool/settings', { token: M.manager, body: {} }));
  ok(await call('GET', '/workforce/staff', { token: M.manager }));
  // the counter's desk work still works, and counter staff still cannot plan
  ok(await call('GET', `/skischool/checkin?date=${day}`, { token: M.counter }));
  no(await call('POST', '/plans/1/publish', { token: M.counter, at: sideBase }), 'counter publishing');
  // a level change reaches the next request: Ivy made a supervisor can open the lineup at once, and back again
  ok(await call('PUT', `/skischool/access/${M.ivyId}`, { token: M.owner, body: { level: 'supervisor' } }));
  ok(await call('GET', '/skischool/lineups', { token: M.ivy }));
  ok(await call('PUT', `/skischool/access/${M.ivyId}`, { token: M.owner, body: { level: 'instructor' } }));
  no(await call('GET', '/skischool/lineups', { token: M.ivy }), 'back to instructor');
});

test('a director must use two-step sign-in; a supervisor need not', async () => {
  const was = config.requireAdminMfa;
  config.requireAdminMfa = true;
  try {
    const r = await call('GET', '/skischool/sessions', { token: M.dana });
    assert.equal(r.status, 403);
    assert.equal(r.body.details.code, 'mfa_enrollment_required');
    assert.equal(r.body.details.why, 'school_director');
    const me = ok(await call('GET', '/auth/me', { token: M.dana }));
    assert.equal(me.mfa_rule, 'school_director');
    assert.equal(me.mfa_enrollment_required, true);
    ok(await call('GET', '/skischool/sessions', { token: M.sam }));
    ok(await call('GET', '/skischool/sessions', { token: M.ivy }));
    // a director cannot use a PIN either
    const u = (await q('SELECT id FROM users WHERE tenant_id = ? AND staff_id = ?', [M.id, M.danaId]))[0];
    const { mfaRule } = require('../src/middleware/auth');
    assert.equal(mfaRule({ role: 'instructor', school_access: 'director', sandbox: 0 }), 'school_director');
    assert.equal(mfaRule({ role: 'instructor', school_access: 'supervisor', sandbox: 0 }), null);
    assert.ok(u);
  } finally {
    config.requireAdminMfa = was;
  }
  ok(await call('GET', '/skischool/sessions', { token: M.dana }));
});
