'use strict';

// End-to-end test against a real MySQL/MariaDB database (see README for the env vars).
// It creates two mountains and checks the behavior that matters most: tenant isolation,
// pricing and ticket validation, rental availability, certification-gated scheduling,
// capacity limits, and role-based access.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server;
let base;
const suffix = Date.now().toString(36);

async function api(method, path, { token, body, headers } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const tomorrow = addDays(today, 1);

let A; // mountain A context
let B; // mountain B context
const ctx = {};

async function createMountain(slug, name) {
  const t = await api('POST', '/tenants', {
    headers: { 'x-bootstrap-key': 'test-bootstrap-key' },
    body: { slug, name, owner: { email: `owner@${slug}.test`, password: 'correct-horse-battery', first_name: 'Olive', last_name: 'Owner' } },
  });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  const login = await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: 'correct-horse-battery' } });
  assert.equal(login.status, 200);
  return { slug, token: login.body.token };
}

test.before(async () => {
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await createMountain(`alpine-${suffix}`, 'Alpine Test Mountain');
  B = await createMountain(`bear-${suffix}`, 'Bear Test Mountain');
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('tenant creation requires the bootstrap key', async () => {
  const r = await api('POST', '/tenants', { body: { slug: `nokey-${suffix}`, name: 'No Key', owner: { email: 'x@y.test', password: 'correct-horse-battery', first_name: 'A', last_name: 'B' } } });
  assert.equal(r.status, 403);
});

test('auth: missing token, bad password and bad token are rejected', async () => {
  assert.equal((await api('GET', '/people')).status, 401);
  assert.equal((await api('GET', '/people', { token: 'garbage' })).status, 401);
  const bad = await api('POST', '/auth/login', { body: { tenant: A.slug, email: `owner@${A.slug}.test`, password: 'wrong-password-here' } });
  assert.equal(bad.status, 401);
  const me = await api('GET', '/auth/me', { token: A.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.role, 'owner');
});

test('tenant isolation: mountain B cannot see or touch mountain A data', async () => {
  const p = await api('POST', '/people', { token: A.token, body: { first_name: 'Ada', last_name: 'Skier', email: 'ada@example.test' } });
  assert.equal(p.status, 201);
  ctx.ada = p.body.id;

  assert.equal((await api('GET', `/people/${ctx.ada}`, { token: B.token })).status, 404);
  assert.equal((await api('PATCH', `/people/${ctx.ada}`, { token: B.token, body: { first_name: 'Hacked' } })).status, 404);
  const listB = await api('GET', '/people', { token: B.token });
  assert.equal(listB.body.data.find((x) => x.id === ctx.ada), undefined);
  assert.equal((await api('GET', `/people/${ctx.ada}`, { token: A.token })).body.first_name, 'Ada');

  // A foreign id inside a body must be rejected by the tenant-scoped foreign keys / lookups.
  const prod = await api('POST', '/products', { token: B.token, body: { kind: 'day_ticket', name: 'B Day', base_price_cents: 5000 } });
  const cross = await api('POST', '/orders', { token: A.token, body: { items: [{ product_id: prod.body.id }] } });
  assert.equal(cross.status, 404);
});

test('pricing: tier, calendar override, blackout and promo codes', async () => {
  const prod = await api('POST', '/products', { token: A.token, body: { kind: 'day_ticket', name: 'Adult Day', base_price_cents: 6000 } });
  assert.equal(prod.status, 201);
  ctx.day = prod.body.id;
  await api('PUT', `/products/${ctx.day}/tiers`, { token: A.token, body: { tiers: [{ tier: 'youth', price_cents: 4000 }, { tier: 'senior', price_cents: 3500 }] } });
  await api('PUT', `/products/${ctx.day}/calendar`, {
    token: A.token,
    body: { entries: [{ on_date: tomorrow, price_cents: 8000 }, { on_date: addDays(today, 2), blackout: true }, { on_date: tomorrow, tier: 'youth', price_cents: 5000 }] },
  });

  const q = (date, tier) => api('POST', '/pricing/quote', { token: A.token, body: { date, items: [{ product_id: ctx.day, tier }] } });
  assert.equal((await q(today, 'adult')).body.total_cents, 6000);       // base
  assert.equal((await q(today, 'youth')).body.total_cents, 4000);       // tier
  assert.equal((await q(tomorrow, 'adult')).body.total_cents, 8000);    // date override, all tiers
  assert.equal((await q(tomorrow, 'youth')).body.total_cents, 5000);    // tier-specific override beats general override
  assert.equal((await q(addDays(today, 2), 'adult')).status, 409);      // blackout

  const promo = await api('POST', '/pricing/promos', { token: A.token, body: { code: 'save10', percent_off: 10, max_uses: 1 } });
  assert.equal(promo.status, 201);
  const withPromo = await api('POST', '/pricing/quote', { token: A.token, body: { date: today, promo_code: 'save10', items: [{ product_id: ctx.day, quantity: 2 }] } });
  assert.equal(withPromo.body.subtotal_cents, 12000);
  assert.equal(withPromo.body.discount_cents, 1200);
  assert.equal(withPromo.body.total_cents, 10800);
});

test('ticketing: order, scan, replay rules, promo limit, refund', async () => {
  const order = await api('POST', '/orders', { token: A.token, body: { person_id: ctx.ada, promo_code: 'SAVE10', items: [{ product_id: ctx.day, quantity: 2 }] } });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  assert.equal(order.body.total_cents, 10800);
  assert.equal(order.body.tickets.length, 2);
  const [t1, t2] = order.body.tickets;

  // Promo had max_uses = 1, so a second order with it must fail and leave no order behind.
  const again = await api('POST', '/orders', { token: A.token, body: { promo_code: 'SAVE10', items: [{ product_id: ctx.day }] } });
  assert.equal(again.status, 400);

  const ok = await api('POST', '/tickets/scan', { token: A.token, body: { code: t1.code, location: 'Main lift' } });
  assert.equal(ok.body.result, 'ok');
  assert.equal((await api('POST', '/tickets/scan', { token: A.token, body: { code: 'ABCDEF123456' } })).body.result, 'unknown');

  // Future-dated ticket is not valid yet.
  const future = await api('POST', '/orders', { token: A.token, body: { items: [{ product_id: ctx.day, valid_on: tomorrow }] } });
  assert.equal((await api('POST', '/tickets/scan', { token: A.token, body: { code: future.body.tickets[0].code } })).body.result, 'not_yet_valid');

  // Past dates cannot be sold.
  assert.equal((await api('POST', '/orders', { token: A.token, body: { items: [{ product_id: ctx.day, valid_on: addDays(today, -1) }] } })).status, 400);

  // A used order cannot be refunded; an untouched one can, and then its tickets are void.
  assert.equal((await api('POST', `/orders/${order.body.id}/refund`, { token: A.token, body: { reason: 'customer_request' } })).status, 409);
  const refund = await api('POST', `/orders/${future.body.id}/refund`, { token: A.token, body: { reason: 'customer_request' } });
  assert.equal(refund.status, 200);
  assert.equal((await api('POST', '/tickets/scan', { token: A.token, body: { code: future.body.tickets[0].code } })).body.result, 'void');
  assert.ok(t2.code);
});

test('punch cards decrement and run out', async () => {
  const card = await api('POST', '/products', { token: A.token, body: { kind: 'punch_card', name: '2-Visit Card', base_price_cents: 9000, valid_days: 30, uses: 2 } });
  const order = await api('POST', '/orders', { token: A.token, body: { items: [{ product_id: card.body.id }] } });
  const code = order.body.tickets[0].code;
  const scan = async (override) => (await api('POST', '/tickets/scan', { token: A.token, body: { code, override } })).body.result;
  assert.equal(await scan(), 'ok');
  assert.equal(await scan(), 'duplicate'); // straight back through the gate: a pass-back warning, nothing used
  assert.equal(await scan(true), 'ok');
  assert.equal(await scan(true), 'no_uses');
});

test('rentals: waiver required, no double checkout, damage goes to maintenance', async () => {
  const mk = async (sku, category) => (await api('POST', '/rentals/items', { token: A.token, body: { sku, category, size: '170' } })).body.id;
  const skiId = await mk('SKI-1', 'ski');
  const bootId = await mk('BOOT-1', 'boot');
  const due = `${today}T16:30`;

  const noWaiver = await api('POST', '/rentals/contracts', { token: A.token, body: { person_id: ctx.ada, due_at: due, items: [{ rental_item_id: skiId }] } });
  assert.equal(noWaiver.status, 409);

  assert.equal((await api('POST', `/people/${ctx.ada}/waivers`, { token: A.token, body: {} })).status, 201);

  const out = await api('POST', '/rentals/contracts', { token: A.token, body: { person_id: ctx.ada, due_at: due, items: [{ rental_item_id: skiId, din_setting: 6.5 }, { rental_item_id: bootId }] } });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const twice = await api('POST', '/rentals/contracts', { token: A.token, body: { person_id: ctx.ada, due_at: due, items: [{ rental_item_id: skiId }] } });
  assert.equal(twice.status, 409);

  const partial = await api('POST', `/rentals/contracts/${out.body.id}/checkin`, { token: A.token, body: { items: [{ rental_item_id: skiId, damage_notes: 'Edge damage' }] } });
  assert.deepEqual(partial.body, { status: 'out', outstanding: 1, fees: [] });
  const full = await api('POST', `/rentals/contracts/${out.body.id}/checkin`, { token: A.token, body: {} });
  assert.deepEqual(full.body, { status: 'returned', outstanding: 0, fees: [] });

  const items = (await api('GET', '/rentals/items', { token: A.token })).body.data;
  assert.equal(items.find((i) => i.sku === 'SKI-1').status, 'maintenance');
  assert.equal(items.find((i) => i.sku === 'BOOT-1').status, 'available');
});

test('workforce: certification gating, overlap and availability checks', async () => {
  const pos = await api('POST', '/workforce/positions', { token: A.token, body: { name: 'Lift Operator', department: 'lifts', visits_per_staff: 100 } });
  const cert = await api('POST', '/workforce/certifications', { token: A.token, body: { name: 'Lift Operator Training' } });
  await api('PUT', `/workforce/positions/${pos.body.id}/requirements`, { token: A.token, body: { certification_ids: [cert.body.id] } });
  const staff = await api('POST', '/workforce/staff', { token: A.token, body: { person: { first_name: 'Sam', last_name: 'Seasonal' }, status: 'active' } });
  ctx.sam = staff.body.id;
  ctx.liftPos = pos.body.id;
  ctx.liftCert = cert.body.id;

  const shift = (staffId, start, end, extra = {}) => api('POST', '/workforce/shifts', { token: A.token, body: { position_id: ctx.liftPos, staff_id: staffId, starts_at: `${tomorrow}T${start}`, ends_at: `${tomorrow}T${end}`, ...extra } });

  const noCert = await shift(ctx.sam, '08:00', '16:00');
  assert.equal(noCert.status, 409);
  assert.match(JSON.stringify(noCert.body.details), /certification/i);

  // Expired certification does not count.
  await api('PUT', `/workforce/staff/${ctx.sam}/certifications`, { token: A.token, body: { certification_id: ctx.liftCert, expires_on: addDays(today, -5) } });
  assert.equal((await shift(ctx.sam, '08:00', '16:00')).status, 409);

  await api('PUT', `/workforce/staff/${ctx.sam}/certifications`, { token: A.token, body: { certification_id: ctx.liftCert, expires_on: addDays(today, 200) } });
  const good = await shift(ctx.sam, '08:00', '12:00');
  assert.equal(good.status, 201, JSON.stringify(good.body));
  assert.equal((await shift(ctx.sam, '11:00', '15:00')).status, 409); // overlap
  assert.equal((await shift(ctx.sam, '12:00', '16:00')).status, 201); // back-to-back is fine

  // Availability: declared windows are enforced unless a manager overrides.
  const wd = new Date(`${addDays(tomorrow, 7)}T00:00:00Z`).getUTCDay();
  await api('PUT', `/workforce/staff/${ctx.sam}/availability`, { token: A.token, body: { windows: [{ weekday: wd, start_time: '09:00', end_time: '14:00' }] } });
  const nextWeek = addDays(tomorrow, 7);
  const body = (s, e, extra = {}) => ({ position_id: ctx.liftPos, staff_id: ctx.sam, starts_at: `${nextWeek}T${s}`, ends_at: `${nextWeek}T${e}`, ...extra });
  assert.equal((await api('POST', '/workforce/shifts', { token: A.token, body: body('08:00', '12:00') })).status, 409);
  assert.equal((await api('POST', '/workforce/shifts', { token: A.token, body: body('08:00', '12:00', { override_availability: true }) })).status, 201);
  assert.equal((await api('POST', '/workforce/shifts', { token: A.token, body: body('12:00', '14:00') })).status, 201);

  // Unfilled shift, then suggestion.
  await api('POST', '/workforce/shifts', { token: A.token, body: { position_id: ctx.liftPos, starts_at: `${tomorrow}T09:00`, ends_at: `${tomorrow}T17:00` } });
  const sug = await api('GET', `/workforce/staffing-suggestion?date=${tomorrow}&forecast=450`, { token: A.token });
  const row = sug.body.data.find((d) => d.position_id === ctx.liftPos);
  assert.equal(row.suggested, 5); // ceil(450 / 100)
  assert.ok(row.scheduled >= 3);
  const unfilled = await api('GET', `/workforce/shifts?from=${tomorrow}&to=${tomorrow}&unfilled=true`, { token: A.token });
  assert.equal(unfilled.body.data.length, 1);
});

test('time clock: cannot clock in twice', async () => {
  assert.equal((await api('POST', '/workforce/time/clock-in', { token: A.token, body: { staff_id: ctx.sam } })).status, 201);
  assert.equal((await api('POST', '/workforce/time/clock-in', { token: A.token, body: { staff_id: ctx.sam } })).status, 409);
  assert.equal((await api('POST', '/workforce/time/clock-out', { token: A.token, body: { staff_id: ctx.sam } })).status, 200);
  assert.equal((await api('POST', '/workforce/time/clock-out', { token: A.token, body: { staff_id: ctx.sam } })).status, 409);
});

test('ski school: instructor certification, capacity and waiver rules', async () => {
  const lesson = await api('POST', '/products', { token: A.token, body: { kind: 'lesson', name: 'Group Lesson', base_price_cents: 7500 } });
  const sessionBody = (extra = {}) => ({ product_id: lesson.body.id, starts_at: `${tomorrow}T13:00`, ends_at: `${tomorrow}T14:30`, capacity: 2, required_certification_id: ctx.liftCert, ...extra });

  const bad = await api('POST', '/skischool/sessions', { token: A.token, body: sessionBody({ instructor_id: ctx.sam + 0, starts_at: `${tomorrow}T11:00`, ends_at: `${tomorrow}T12:30` }) });
  assert.equal(bad.status, 409); // Sam is on a lift shift 08-12 tomorrow: overlap

  const session = await api('POST', '/skischool/sessions', { token: A.token, body: sessionBody() });
  assert.equal(session.status, 201, JSON.stringify(session.body));
  const sid = session.body.id;

  const book = (personId) => api('POST', `/skischool/sessions/${sid}/bookings`, { token: A.token, body: { person_id: personId } });
  const mkPerson = async (n) => {
    const p = await api('POST', '/people', { token: A.token, body: { first_name: `Kid${n}`, last_name: 'Student' } });
    await api('POST', `/people/${p.body.id}/waivers`, { token: A.token, body: { season: undefined } });
    return p.body.id;
  };
  const noWaiver = await api('POST', '/people', { token: A.token, body: { first_name: 'No', last_name: 'Waiver' } });
  assert.equal((await book(noWaiver.body.id)).status, 409);

  const [k1, k2, k3] = [await mkPerson(1), await mkPerson(2), await mkPerson(3)];
  assert.equal((await book(k1)).status, 201);
  assert.equal((await book(k2)).status, 201);
  const full = await book(k3);
  assert.equal(full.status, 409);
  assert.match(full.body.error, /full/i);

  const list = await api('GET', `/skischool/sessions?from=${tomorrow}&to=${tomorrow}`, { token: A.token });
  assert.equal(list.body.data[0].spots_left, 0);
  const roster = await api('GET', `/skischool/sessions/${sid}/roster`, { token: A.token });
  assert.equal(roster.body.data.length, 2);
  assert.equal((await api('POST', '/skischool/progress', { token: A.token, body: { person_id: k1, discipline: 'ski', level: 2, notes: 'Linking turns' } })).status, 201);
});

test('patrol: role gating, audit trail and safe CSV export', async () => {
  // Create restricted users.
  const counter = await api('POST', '/users', { token: A.token, body: { email: 'counter@a.test', password: 'long-enough-pass', role: 'counter' } });
  const patrol = await api('POST', '/users', { token: A.token, body: { email: 'patrol@a.test', password: 'long-enough-pass', role: 'patrol' } });
  assert.equal(counter.status, 201);
  assert.equal(patrol.status, 201);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: A.slug, email, password: 'long-enough-pass' } })).body.token;
  const counterToken = await login('counter@a.test');
  const patrolToken = await login('patrol@a.test');

  assert.equal((await api('GET', '/patrol/incidents', { token: counterToken })).status, 403);

  const inc = await api('POST', '/patrol/incidents', {
    token: patrolToken,
    body: { occurred_at: `${today}T10:15`, location: '=HYPERLINK("http://evil.test","x") Upper Ridge', category: 'injury', severity: 'moderate', summary: 'Wrist injury, name given as Ada Lovelace', person_id: ctx.ada },
  });
  assert.equal(inc.status, 201, JSON.stringify(inc.body));
  await api('POST', `/patrol/incidents/${inc.body.id}/notes`, { token: patrolToken, body: { body: 'Transported to base' } });
  const detail = await api('GET', `/patrol/incidents/${inc.body.id}`, { token: patrolToken });
  assert.equal(detail.body.notes.length, 1);
  assert.equal((await api('PATCH', `/patrol/incidents/${inc.body.id}`, { token: patrolToken, body: { status: 'closed', disposition: 'transported' } })).status, 200);

  // Patrol cannot export; managers can, and formulas are neutralized.
  assert.equal((await api('GET', '/patrol/incidents.csv', { token: patrolToken })).status, 403);
  const csv = await api('GET', '/patrol/incidents.csv', { token: A.token });
  assert.equal(csv.status, 200);
  assert.ok(csv.body.includes(`"'=HYPERLINK`), 'formula injection should be neutralized');
  assert.ok(!csv.body.includes('Ada Lovelace'), 'free text (which can hold a name) stays out of the export');

  // Sensitive reads are audited.
  const [rows] = await pool.query("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'incidents' AND action = 'view' AND entity_id = ?", [inc.body.id]);
  assert.equal(rows[0].n, 1);

  // Mountain B cannot see A's incident.
  assert.equal((await api('GET', `/patrol/incidents/${inc.body.id}`, { token: B.token })).status, 404);
  // Managers cannot be created by non-owners.
  assert.equal((await api('POST', '/users', { token: counterToken, body: { email: 'x@a.test', password: 'long-enough-pass', role: 'manager' } })).status, 403);
});

test('programs: capacity, waitlist and automatic promotion', async () => {
  const prog = await api('POST', '/programs', { token: A.token, body: { name: 'Junior Race Team', kind: 'race_team', season: '2026-27', capacity: 1, price_cents: 45000 } });
  assert.equal(prog.status, 201, JSON.stringify(prog.body));
  const mk = async (n) => (await api('POST', '/people', { token: A.token, body: { first_name: `Racer${n}`, last_name: 'Junior' } })).body.id;
  const [r1, r2] = [await mk(1), await mk(2)];

  const e1 = await api('POST', `/programs/${prog.body.id}/enrollments`, { token: A.token, body: { person_id: r1, guardian_id: ctx.ada } });
  const e2 = await api('POST', `/programs/${prog.body.id}/enrollments`, { token: A.token, body: { person_id: r2 } });
  assert.equal(e1.body.status, 'enrolled');
  assert.equal(e2.body.status, 'waitlist');
  assert.equal((await api('POST', `/programs/${prog.body.id}/enrollments`, { token: A.token, body: { person_id: r1 } })).status, 409);

  const w = await api('POST', `/programs/${prog.body.id}/enrollments/${e1.body.id}/withdraw`, { token: A.token });
  assert.equal(w.body.promoted_person_id, r2);
  const roster = await api('GET', `/programs/${prog.body.id}/roster`, { token: A.token });
  assert.deepEqual(roster.body.data.map((r) => [r.person_id, r.status]), [[r2, 'enrolled']]);

  const sess = await api('POST', `/programs/${prog.body.id}/sessions`, { token: A.token, body: { starts_at: `${tomorrow}T16:00`, ends_at: `${tomorrow}T18:00` } });
  assert.equal(sess.status, 201);
  assert.equal((await api('PUT', `/programs/sessions/${sess.body.id}/attendance`, { token: A.token, body: { marks: [{ person_id: r2, present: true }] } })).status, 200);
});

test('schedule: staff update lift status; public feed needs no login and leaks nothing private', async () => {
  const lift = await api('POST', '/schedule/lifts', { token: A.token, body: { name: 'Summit Quad' } });
  assert.equal(lift.status, 201);
  await api('POST', '/schedule/trails', { token: A.token, body: { name: 'Easy Does It', difficulty: 'green', status: 'open', groomed: 1 } });
  await api('PUT', `/schedule/days/${today}`, { token: A.token, body: { status: 'open', open_time: '09:00', close_time: '16:00', notes: 'Fresh groom' } });
  await api('PATCH', `/schedule/lifts/${lift.body.id}`, { token: A.token, body: { status: 'open' } });

  const feed = await api('GET', `/public/${A.slug}/conditions`);
  assert.equal(feed.status, 200);
  assert.equal(feed.body.lifts_open, 1);
  assert.equal(feed.body.trails_open, 1);
  assert.equal(feed.body.day.status, 'open');
  const raw = JSON.stringify(feed.body);
  assert.ok(!/ada@example|Ada|owner@/.test(raw));
  assert.equal((await api('GET', '/public/not-a-real-slug/conditions')).status, 404);
  // B's feed is independent of A's.
  assert.equal((await api('GET', `/public/${B.slug}/conditions`)).body.lifts_open, 0);
});

test('reports: daily dashboard reflects the day', async () => {
  const r = await api('GET', '/reports/daily', { token: A.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.guests_scanned >= 1);
  assert.ok(r.body.sales.orders >= 1);
  assert.ok(r.body.sales.revenue_cents > 0);
  assert.equal(r.body.patrol.incidents_today, 1);
  assert.equal(r.body.rentals.out, 0);
  const empty = await api('GET', '/reports/daily', { token: B.token });
  assert.equal(empty.body.sales.orders, 0);
});

test('validation and errors never leak internals', async () => {
  const r = await api('POST', '/people', { token: A.token, body: { first_name: '', last_name: 5 } });
  assert.equal(r.status, 400);
  assert.ok(Array.isArray(r.body.details));
  const dup = await api('POST', '/rentals/items', { token: A.token, body: { sku: 'SKI-1', category: 'ski' } });
  assert.equal(dup.status, 409);
  assert.ok(!/ER_|SQL|sqlMessage/i.test(JSON.stringify(dup.body)));
  assert.equal((await api('GET', '/people/not-a-number', { token: A.token })).status, 400);
  assert.equal((await api('GET', '/nope', { token: A.token })).status, 404);
});
