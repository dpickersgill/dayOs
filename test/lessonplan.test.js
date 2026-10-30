'use strict';

// Lesson planning, best of breed (2026.11.9), Track PLAN: the season plan. Expanding a plan into days (exception, then
// period, then school holiday, then the weekday default); preview with its warnings (no price, not a lesson product, a
// named instructor who is busy, a time outside the day, a range too long); publish (pools follow staff by default, set
// classes keep their number, private hours per day, closed days); re-publish (booked lessons are kept and listed,
// unbooked ones updated, removed only when asked); undo (only the latest; booked lessons stay); patterns and day
// templates; the calendar; and who may do it.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.BOOKING_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const LP = require('../src/lib/lessonplan');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const addDays = (d, k) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const weekday = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const q = async (sql, params) => (await pool.query(sql, params))[0];
/** The next date on or after d that falls on weekday w (0 Sunday). */
const nextWd = (d, w) => { let x = d; while (weekday(x) !== w) x = addDays(x, 1); return x; };

const DEVICE = 'test-device-0123456789abcdef';
async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'x-device': DEVICE, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const ok = (r, s) => { assert.ok(r.status < 300, `${r.status} ${r.text}`); if (s) assert.equal(r.status, s, r.text); return r.body; };

const made = new Map();
const mountain = (tag) => { if (!made.has(tag)) made.set(tag, newMountain(tag)); return made.get(tag); };
async function newMountain(tag) {
  const slug = `lp${tag}-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: `Peak ${tag}`, phone: '215-555-0000', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const login = async (email) => (await call('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  const M = { slug, id: (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id };
  M.owner = await login(`owner@${slug}.test`);
  ok(await call('POST', '/users', { token: M.owner, body: { email: `counter@${slug}.test`, password: PW, role: 'counter' } }));
  M.counter = await login(`counter@${slug}.test`);
  const st = ok(await call('POST', '/workforce/staff', { token: M.owner, body: { person: { first_name: 'Ivy', last_name: 'Teach', email: `ivy@${slug}.test` }, status: 'active' } }));
  M.ivyId = st.id;
  ok(await call('POST', '/users', { token: M.owner, body: { email: `ivy@${slug}.test`, password: PW, role: 'instructor', staff_id: st.id } }));
  M.ivy = await login(`ivy@${slug}.test`);
  ok(await call('PUT', `/skischool/instructors/${st.id}/profile`, { token: M.owner, body: { disciplines: ['ski'], ski_level_max: 9, snowboard_level_max: 1, teaches_kids: true, teaches_adaptive: false, psia_level: 'level1' } }));
  M.group = ok(await call('POST', '/products', { token: M.owner, body: { kind: 'lesson', name: 'Kids Ski Group', base_price_cents: 9000 } })).id;
  M.clinic = ok(await call('POST', '/products', { token: M.owner, body: { kind: 'lesson', name: 'Adult Clinic', base_price_cents: 0 } })).id;
  M.ticket = ok(await call('POST', '/products', { token: M.owner, body: { kind: 'day_ticket', name: 'Day Ticket', base_price_cents: 5000 } })).id;
  return M;
}
const pool930 = (M, extra = {}) => ({ key: 'kids930', start: '09:30', end: '11:30', product_id: M.group, kind: 'pool', discipline: 'ski', age_min: 7, age_max: 12, spots: 40, meeting_place: 'Clock tower', ...extra });
const clinic = (M, extra = {}) => ({ key: 'clinic1', start: '13:00', end: '15:00', product_id: M.clinic, kind: 'class', format: 'group', discipline: 'ski', level_min: 6, level_max: 8, age_min: 18, spots: 8, ...extra });

/** A student booked into a lesson (the booking itself is what matters to the plan). */
async function sell(M, sessionId, first) {
  const [p] = await pool.query('INSERT INTO people (tenant_id, first_name, last_name) VALUES (?, ?, ?)', [M.id, first, 'Guest']);
  await pool.query("INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status) VALUES (?, ?, ?, 'booked')", [M.id, sessionId, p.insertId]);
}

test.before(async () => { await new Promise((r) => { server = createApp().listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('expand: exception, then period, then holiday, then the weekday default; adds and removes on one day', () => {
  const doc = LP.parseDoc(LP.defaults());
  doc.day_types[0].slots = [{ key: 'a', start: '10:00', end: '12:00', product_id: 1, kind: 'pool', format: 'group', discipline: 'ski', spots: 20 }];
  doc.day_types[1].slots = [{ key: 'b', start: '09:30', end: '11:30', product_id: 1, kind: 'pool', format: 'group', discipline: 'ski', spots: 40 }, { key: 'c', start: '13:00', end: '15:00', product_id: 1, kind: 'pool', format: 'group', discipline: 'ski', spots: 40 }];
  doc.day_types[3].slots = [{ key: 'd', start: '09:00', end: '11:00', product_id: 1, kind: 'pool', format: 'group', discipline: 'ski', spots: 60 }];
  doc.day_types[3].private = { start: '09:00', end: '16:00', at_once: 4, lengths: [60, 120] };
  doc.periods = [{ from: '2026-12-26', to: '2027-01-01', day_type: 'holiday_week' }];
  doc.exceptions = [{ date: '2027-01-02', day_type: null, add: [{ key: 'x1', start: '15:00', end: '16:00', product_id: 1, kind: 'class', format: 'private', discipline: 'ski', spots: 1 }], remove: ['c'] },
    { date: '2026-12-31', day_type: 'closed', add: [], remove: [] }];
  const days = LP.expand(LP.parseDoc(doc), '2026-12-21', '2027-01-04', new Map([['2026-12-25', 'Christmas'], ['2027-01-04', 'Jan holiday']]));
  const at = (d) => days.find((x) => x.date === d);
  assert.equal(at('2026-12-21').day_type, 'weekday'); // a Monday
  assert.equal(at('2026-12-21').source, 'weekday');
  assert.equal(at('2026-12-25').day_type, 'holiday');
  assert.equal(at('2026-12-25').source, 'holiday');
  assert.equal(at('2026-12-27').day_type, 'holiday_week', 'a period wins over the weekday');
  assert.deepEqual(at('2026-12-27').private, { start: '09:00', end: '16:00', at_once: 4, lengths: [60, 120] });
  assert.equal(at('2026-12-31').day_type, 'closed', 'an exception wins over a period');
  assert.equal(at('2026-12-31').closed, true);
  assert.equal(at('2026-12-31').slots.length, 0);
  assert.deepEqual(at('2027-01-02').slots.map((s) => s.key), ['b', 'x1'], 'a Saturday without its 1 PM slot and with a one-off private');
  assert.equal(at('2027-01-04').day_type, 'holiday', 'a school holiday on a Monday');
  // Keys are filled in and kept; two slots may not share one.
  const d2 = LP.parseDoc({ ...LP.defaults(), day_types: [{ key: 'weekday', name: 'Weekday', slots: [{ start: '09:00', end: '10:00', product_id: 1, spots: 5 }] }], weekdays: Array(7).fill('weekday') });
  assert.match(d2.day_types[0].slots[0].key, /^s[a-z0-9]+$/);
  assert.throws(() => LP.parseDoc({ ...LP.defaults(), day_types: [{ key: 'weekday', name: 'W', slots: [{ key: 'k', start: '09:00', end: '10:00', product_id: 1, spots: 5 }, { key: 'k', start: '11:00', end: '12:00', product_id: 1, spots: 5 }] }], weekdays: Array(7).fill('weekday') }), /problem/);
  assert.throws(() => LP.parseDoc({ ...LP.defaults(), weekdays: Array(7).fill('nope') }), /problem/);
  assert.throws(() => LP.parseDoc({ ...LP.defaults(), day_types: [...LP.defaults().day_types, { key: 'six', name: 'Six' }, { key: 'seven', name: 'Seven' }] }), /problem/, 'at most 6 day types');
});

test('a plan: preview with warnings, publish, the calendar, private hours, and who may do it', async () => {
  const M = await mountain('a');
  const from = addDays(today, 3); const to = addDays(from, 13);
  const sat = nextWd(from, 6);
  // Ivy already teaches at 1 PM on the first Tuesday, so the clinic named for her that day is made with "Assign later".
  const tue = nextWd(from, 2);
  ok(await call('POST', '/skischool/sessions', { token: M.owner, body: { product_id: M.group, starts_at: `${tue}T12:30`, ends_at: `${tue}T14:30`, instructor_id: M.ivyId } }));

  assert.equal((await call('POST', '/skischool/plans', { token: M.ivy, body: { name: 'Season', from_on: from, to_on: to } })).status, 403, 'an instructor cannot plan');
  assert.equal((await call('POST', '/skischool/plans', { token: M.counter, body: { name: 'Season', from_on: from, to_on: to } })).status, 403, 'the counter cannot plan');
  assert.equal((await call('POST', '/skischool/plans', { token: M.owner, body: { name: 'Too long', from_on: from, to_on: addDays(from, 250) } })).status, 400, 'at most 200 days');
  const plan = ok(await call('POST', '/skischool/plans', { token: M.owner, body: { name: 'Early season', from_on: from, to_on: to } }), 201);
  assert.equal(plan.status, 'draft');
  assert.deepEqual(plan.doc.day_types.map((t) => t.name), ['Weekday', 'Weekend', 'Holiday', 'Holiday week', 'Closed']);
  assert.deepEqual(plan.doc.weekdays, ['weekend', 'weekday', 'weekday', 'weekday', 'weekday', 'weekday', 'weekend']);
  const opts = ok(await call('GET', '/skischool/plans/options', { token: M.owner }));
  assert.equal(opts.pool_spots_mode, 'staff');
  assert.ok(opts.products.some((p) => p.id === M.group) && !opts.products.some((p) => p.id === M.ticket));

  const doc = plan.doc;
  doc.day_types[0].slots = [clinic(M, { instructor_id: M.ivyId })];
  doc.day_types[0].private = { start: '09:00', end: '15:00', at_once: null, lengths: [60, 120] };
  doc.day_types[1].slots = [pool930(M), { key: 'early', start: '05:30', end: '07:00', product_id: M.group, kind: 'pool', discipline: 'ski', spots: 10 }, { key: 'tix', start: '10:00', end: '12:00', product_id: M.ticket, kind: 'pool', discipline: 'ski', spots: 10 }];
  doc.day_types[1].private = { start: '08:30', end: '16:00', at_once: 3, lengths: [60, 120, 180] };
  const wed = nextWd(from, 3);
  doc.exceptions = [{ date: wed, day_type: 'closed', add: [], remove: [] }];
  ok(await call('PUT', `/skischool/plans/${plan.id}`, { token: M.owner, body: { doc } }));
  assert.equal((await call('PUT', `/skischool/plans/${plan.id}`, { token: M.owner, body: { doc: { ...doc, weekdays: ['weekend'] } } })).status, 400);

  const pv = ok(await call('POST', `/skischool/plans/${plan.id}/preview`, { token: M.owner }));
  const weekdays = []; const weekends = [];
  for (let d = from; d <= to; d = addDays(d, 1)) { if ([0, 6].includes(weekday(d))) weekends.push(d); else if (d !== wed) weekdays.push(d); }
  assert.equal(pv.counts.create, weekdays.length + weekends.length * 2, 'one clinic each open weekday, two pools each weekend day');
  assert.equal(pv.counts.create_spots, weekdays.length * 8 + weekends.length * 50);
  assert.match(pv.words, /^Adds \d+ lessons, [\d,]+ spots across \d+ days$/);
  const codes = pv.warnings.map((w) => w.code);
  assert.ok(codes.includes('price'), 'the clinic has no price');
  assert.ok(pv.warnings.find((w) => w.code === 'product' && /Day Ticket is not a lesson product/.test(w.text)));
  assert.ok(codes.includes('time'), '5:30 AM is outside the day');
  assert.ok(codes.includes('instructor'));
  assert.deepEqual(pv.assign_later.map((a) => a.date), [tue]);
  assert.match(pv.assign_later[0].problem, /Teaching a lesson/);

  const pub = ok(await call('POST', `/skischool/plans/${plan.id}/publish`, { token: M.owner, body: {} }), 201);
  assert.equal(pub.counts.create, pv.counts.create);
  const lessons = await q('SELECT * FROM lesson_sessions WHERE tenant_id = ? AND plan_id = ? ORDER BY starts_at', [M.id, plan.id]);
  assert.equal(lessons.length, pv.counts.create);
  const pool1 = lessons.find((l) => l.plan_slot === 'kids930' && l.starts_at.startsWith(sat));
  assert.equal(pool1.origin, 'plan');
  assert.equal(pool1.kind, 'pool');
  assert.equal(pool1.spots_mode, 'staff', 'pools follow staff by default');
  assert.equal(pool1.spots_cap, 40);
  assert.equal(pool1.capacity, 40);
  assert.equal(pool1.format, 'group');
  assert.equal(pool1.level_min, null);
  assert.equal(pool1.age_group, 'kids');
  assert.equal(pool1.meeting_place, 'Clock tower');
  const cl = lessons.filter((l) => l.plan_slot === 'clinic1');
  assert.ok(cl.every((l) => l.kind === 'class' && l.spots_mode === 'fixed' && l.level_min === 6 && l.level_max === 8 && l.capacity === 8));
  assert.equal(cl.find((l) => l.starts_at.startsWith(tue)).instructor_id, null, 'busy that day: Assign later');
  assert.ok(cl.filter((l) => !l.starts_at.startsWith(tue)).every((l) => l.instructor_id === M.ivyId));
  assert.ok(!lessons.some((l) => l.starts_at.startsWith(wed)), 'nothing on the closed day');
  // Private hours: one row per day of the plan, the closed day closed.
  const ph = await q('SELECT * FROM lesson_private_hours WHERE tenant_id = ? ORDER BY on_date', [M.id]);
  assert.equal(ph.length, weekdays.length + weekends.length + 1);
  const closedRow = ph.find((r) => r.on_date === wed);
  assert.equal(closedRow.closed, 1);
  const satRow = ph.find((r) => r.on_date === sat);
  assert.equal(satRow.start_time, '08:30:00');
  assert.equal(satRow.at_once, 3);
  assert.equal(satRow.lengths, '60,120,180');
  assert.equal(ph.find((r) => r.on_date === weekdays[0]).at_once, null, 'as many as instructors allow');

  // The calendar for the month of the first Saturday, and the day view.
  const cal = ok(await call('GET', `/skischool/plans/${plan.id}/calendar?month=${sat.slice(0, 7)}`, { token: M.owner }));
  const cs = cal.days.find((d) => d.date === sat);
  assert.equal(cs.day_type, 'weekend');
  assert.deepEqual(cs.slots.map((s) => s.key), ['early', 'kids930', 'tix']);
  assert.equal(cs.lessons.length, 2);
  assert.equal(cal.days.find((d) => d.date === wed)?.closed ?? true, true);
  const day = ok(await call('GET', `/skischool/plans/${plan.id}/day?date=${sat}`, { token: M.owner }));
  assert.equal(day.data.length, 2);
  assert.ok(day.data.every((l) => l.from_plan && l.booked === 0));
  const got = ok(await call('GET', `/skischool/plans/${plan.id}`, { token: M.owner }));
  assert.equal(got.status, 'published');
  assert.equal(got.unpublished, false);
  assert.equal(got.lessons, lessons.length);
  const logged = await q("SELECT action FROM audit_log WHERE tenant_id = ? AND entity = 'lesson_plans'", [M.id]);
  assert.deepEqual([...new Set(logged.map((a) => a.action))].sort(), ['create', 'publish', 'update']);

  // A draft that never published can be deleted; a published plan cannot.
  assert.equal((await call('DELETE', `/skischool/plans/${plan.id}`, { token: M.owner })).status, 409);
  const draft = ok(await call('POST', '/skischool/plans', { token: M.owner, body: { name: 'Scratch', from_on: from, to_on: from } }), 201);
  ok(await call('DELETE', `/skischool/plans/${draft.id}`, { token: M.owner }));
});

test('re-publish keeps booked lessons, updates the rest, removes only when asked; undo the latest publish', async () => {
  const M = await mountain('b');
  const from = addDays(today, 4); const sat = nextWd(from, 6); const sun = addDays(sat, 1);
  const plan = ok(await call('POST', '/skischool/plans', { token: M.owner, body: { name: 'Weekend', from_on: sat, to_on: sun } }), 201);
  const doc = plan.doc;
  doc.day_types[1].slots = [pool930(M, { spots_mode: 'fixed', spots: 30 }), { key: 'pm', start: '13:00', end: '15:00', product_id: M.group, kind: 'pool', discipline: 'ski', age_min: 7, age_max: 12, spots: 20, spots_mode: 'fixed' }];
  ok(await call('PUT', `/skischool/plans/${plan.id}`, { token: M.owner, body: { doc } }));
  const first = ok(await call('POST', `/skischool/plans/${plan.id}/publish`, { token: M.owner, body: {} }), 201);
  assert.equal(first.counts.create, 4);
  const lessonAt = async (date, slot) => (await q("SELECT * FROM lesson_sessions WHERE tenant_id = ? AND plan_id = ? AND plan_slot = ? AND starts_at LIKE ? AND status <> 'cancelled'", [M.id, plan.id, slot, `${date}%`]))[0];
  const satPool = await lessonAt(sat, 'kids930');
  await sell(M, satPool.id, 'Ada');

  // Change the spots and drop the afternoon slot.
  doc.day_types[1].slots = [pool930(M, { spots_mode: 'fixed', spots: 24 })];
  ok(await call('PUT', `/skischool/plans/${plan.id}`, { token: M.owner, body: { doc } }));
  assert.equal(ok(await call('GET', `/skischool/plans/${plan.id}`, { token: M.owner })).unpublished, true);
  const pv = ok(await call('POST', `/skischool/plans/${plan.id}/preview`, { token: M.owner }));
  assert.equal(pv.counts.create, 0);
  assert.equal(pv.counts.update, 1, 'Sunday 9:30 has no bookings');
  assert.equal(pv.counts.keep, 1, 'Saturday 9:30 is booked');
  assert.deepEqual(pv.keep[0].differs, ['spots']);
  assert.equal(pv.keep[0].booked, 1);
  assert.equal(pv.counts.remove, 2, 'both afternoon pools could go');
  assert.match(pv.words, /updates 1; keeps 1 with bookings/);

  const second = ok(await call('POST', `/skischool/plans/${plan.id}/publish`, { token: M.owner, body: {} }), 201);
  assert.equal(second.counts.removed, 0, 'not removed unless asked');
  assert.equal((await lessonAt(sat, 'kids930')).capacity, 30, 'a booked lesson never changes');
  assert.equal((await lessonAt(sun, 'kids930')).capacity, 24);
  assert.ok(await lessonAt(sat, 'pm'));
  // Book the Saturday afternoon pool, then publish with "Also remove": only Sunday's afternoon goes.
  await sell(M, (await lessonAt(sat, 'pm')).id, 'Ben');
  const third = ok(await call('POST', `/skischool/plans/${plan.id}/publish`, { token: M.owner, body: { remove: true } }), 201);
  assert.equal(third.counts.removed, 1);
  assert.equal(await lessonAt(sun, 'pm'), undefined);
  assert.ok(await lessonAt(sat, 'pm'), 'booked, so it stays');

  // Only the latest publish can be undone. Undo the third: Sunday afternoon comes back.
  const hist = ok(await call('GET', `/skischool/plans/${plan.id}/publishes`, { token: M.owner })).data;
  assert.equal(hist.length, 3);
  assert.deepEqual(hist.map((h) => h.can_undo), [true, false, false]);
  assert.equal((await call('POST', `/skischool/plans/publishes/${first.publish_id}/undo`, { token: M.owner })).status, 409);
  const u3 = ok(await call('POST', `/skischool/plans/publishes/${third.publish_id}/undo`, { token: M.owner }));
  assert.equal(u3.restored, 1);
  assert.equal((await lessonAt(sun, 'pm')).capacity, 20);
  // Undo the second: Sunday morning goes back to 30 spots.
  const u2 = ok(await call('POST', `/skischool/plans/publishes/${second.publish_id}/undo`, { token: M.owner }));
  assert.equal(u2.restored, 1);
  assert.equal((await lessonAt(sun, 'kids930')).capacity, 30);
  // Undo the first: the two booked lessons stay and are listed; the two unbooked ones go.
  const u1 = ok(await call('POST', `/skischool/plans/publishes/${first.publish_id}/undo`, { token: M.owner }));
  assert.equal(u1.removed, 2);
  assert.equal(u1.kept.length, 2);
  assert.equal(ok(await call('GET', `/skischool/plans/${plan.id}`, { token: M.owner })).status, 'draft');
  assert.equal((await call('POST', `/skischool/plans/publishes/${first.publish_id}/undo`, { token: M.owner })).status, 409, 'already undone');
  // Re-publishing finds the kept lessons again instead of making second copies.
  const again = ok(await call('POST', `/skischool/plans/${plan.id}/publish`, { token: M.owner, body: {} }), 201);
  assert.equal(again.counts.create, 1, 'only Sunday 9:30 is made again');
});

test('patterns, day templates and a plan with too many lessons', async () => {
  const M = await mountain('c');
  const from = addDays(today, 5);
  const plan = ok(await call('POST', '/skischool/plans', { token: M.owner, body: { name: 'Base', from_on: from, to_on: addDays(from, 6) } }), 201);
  const doc = plan.doc;
  doc.day_types[0].name = 'Midweek';
  doc.day_types[0].slots = [pool930(M)];
  doc.periods = [{ from, to: addDays(from, 2), day_type: 'holiday_week' }];
  ok(await call('PUT', `/skischool/plans/${plan.id}`, { token: M.owner, body: { doc } }));
  const pt = ok(await call('POST', '/skischool/plan-patterns', { token: M.owner, body: { name: 'Standard week', plan_id: plan.id } }), 201);
  const pats = ok(await call('GET', '/skischool/plan-patterns', { token: M.owner })).data;
  assert.equal(pats.length, 1);
  assert.equal(pats[0].slots, 1);
  const p2 = ok(await call('POST', '/skischool/plans', { token: M.owner, body: { name: 'Next season', from_on: addDays(from, 30), to_on: addDays(from, 40), pattern_id: pt.id } }), 201);
  assert.equal(p2.doc.day_types[0].name, 'Midweek');
  assert.equal(p2.doc.day_types[0].slots[0].key, 'kids930');
  assert.equal(p2.doc.periods.length, 0, 'periods belong to their own season');
  ok(await call('DELETE', `/skischool/plan-patterns/${pt.id}`, { token: M.owner }));

  // A day template becomes slot rows: a group lesson with no levels is a pool, one with levels a set class.
  const d = addDays(today, 2);
  ok(await call('POST', '/skischool/sessions', { token: M.owner, body: { product_id: M.group, starts_at: `${d}T09:30`, ends_at: `${d}T11:30`, capacity: 12, age_min: 4, age_max: 6 } }));
  ok(await call('POST', '/skischool/sessions', { token: M.owner, body: { product_id: M.group, starts_at: `${d}T13:00`, ends_at: `${d}T15:00`, level_min: 3, level_max: 5 } }));
  const tpl = ok(await call('POST', '/skischool/director/templates', { token: M.owner, body: { name: 'Busy Saturday', date: d } }), 201);
  const listed = ok(await call('GET', '/skischool/plan-templates', { token: M.owner })).data;
  assert.equal(listed[0].name, 'Busy Saturday');
  const slots = ok(await call('GET', `/skischool/plan-templates/${tpl.id}/slots`, { token: M.owner })).data;
  assert.deepEqual(slots.map((s) => [s.start, s.kind, s.spots, s.spots_mode]), [['09:30', 'pool', 12, 'staff'], ['13:00', 'class', 6, 'fixed']]);

  // 200 days with 12 slots each is more than 2,000 lessons: the preview says so and publish refuses.
  const big = ok(await call('POST', '/skischool/plans', { token: M.owner, body: { name: 'Huge', from_on: from, to_on: addDays(from, 199) } }), 201);
  const bd = big.doc;
  const many = Array.from({ length: 12 }, (_, i) => ({ key: `m${i}`, start: `${String(8 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`, end: '17:00', product_id: M.group, kind: 'pool', discipline: 'ski', spots: 10 }));
  bd.day_types[0].slots = many; bd.day_types[1].slots = many.map((s) => ({ ...s, key: `w${s.key}` }));
  ok(await call('PUT', `/skischool/plans/${big.id}`, { token: M.owner, body: { doc: bd } }));
  const bpv = ok(await call('POST', `/skischool/plans/${big.id}/preview`, { token: M.owner }));
  assert.equal(bpv.blocked, true);
  assert.ok(bpv.warnings.some((w) => w.code === 'size' && w.block));
  assert.equal((await call('POST', `/skischool/plans/${big.id}/publish`, { token: M.owner, body: {} })).status, 409);
  assert.equal(await q('SELECT COUNT(*) AS n FROM lesson_sessions WHERE tenant_id = ? AND plan_id = ?', [M.id, big.id]).then((r) => Number(r[0].n)), 0);
});
