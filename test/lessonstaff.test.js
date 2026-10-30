'use strict';

// Lesson planning, best of breed (2026.11.9), Track STAFF: spots that follow staff (advance sale up to the cap, instructors
// free x the ratio, never above the cap or below what is booked, shared across lessons at the same time, the most
// constrained first, an assigned instructor kept), the hooks that recount (availability, an instructor assigned, a shift
// offer taken), the fill view with its marks, Fill the gap, the staffing target on My day with "I can work", when a
// lesson fills, and sold-out demand with its suggestions.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.BOOKING_RATE_LIMIT = '1000';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
process.env.MAIL_FROM = 'hello@summitops.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mailer = require('../src/lib/mailer');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const LS = require('../src/lib/lessonspots');
const LD = require('../src/lib/lessondemand');
const staffPart = require('../src/routes/schoolstaff');

let server; let base; let pmMock; const mails = []; let n = 0;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const addDays = (d, k) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const q = async (sql, params) => (await pool.query(sql, params))[0];
const cap = async (id) => Number((await q('SELECT capacity FROM lesson_sessions WHERE id = ?', [id]))[0].capacity);

const DEVICE = 'test-device-0123456789abcdef';
async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'x-device': DEVICE, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const ok = (r, s) => { assert.ok(r.status < 300, `${r.status} ${r.text}`); if (s) assert.equal(r.status, s, r.text); return r.body; };

/** A fresh mountain with a manager, a counter, three instructors with sign-ins (Ivy, Max, Zoe) and a group lesson product. */
async function mountain(tag) {
  const slug = `lst${tag}-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: `Peak ${tag}`, phone: '215-555-0000', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const login = async (email) => (await call('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  const M = { slug, id: (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id };
  M.owner = await login(`owner@${slug}.test`);
  ok(await call('POST', '/users', { token: M.owner, body: { email: `counter@${slug}.test`, password: PW, role: 'counter' } }));
  M.counter = await login(`counter@${slug}.test`);
  for (const [k, first] of [['ivy', 'Ivy'], ['max', 'Max'], ['zoe', 'Zoe']]) {
    const st = ok(await call('POST', '/workforce/staff', { token: M.owner, body: { person: { first_name: first, last_name: 'Teach', email: `${k}@${slug}.test` }, status: 'active' } }));
    M[`${k}Id`] = st.id;
    ok(await call('POST', '/users', { token: M.owner, body: { email: `${k}@${slug}.test`, password: PW, role: 'instructor', staff_id: st.id } }));
    M[k] = await login(`${k}@${slug}.test`);
    ok(await call('PUT', `/skischool/instructors/${st.id}/profile`, { token: M.owner, body: { disciplines: ['ski', 'snowboard'], ski_level_max: 9, snowboard_level_max: 9, teaches_kids: true, teaches_adaptive: false, psia_level: 'level1' } }));
  }
  M.group = ok(await call('POST', '/products', { token: M.owner, body: { kind: 'lesson', name: 'Group Lesson', base_price_cents: 8000 } })).id;
  return M;
}
/** A lesson; { pool: cap } makes it a pool whose spots follow staff with that cap. */
async function lesson(M, date, time, extra = {}, { pool: poolCap } = {}) {
  const end = `${String(Number(time.slice(0, 2)) + 2).padStart(2, '0')}:${time.slice(3)}`;
  const id = ok(await call('POST', '/skischool/sessions', { token: M.owner, body: { product_id: M.group, starts_at: `${date}T${time}`, ends_at: `${date}T${end}`, ...extra } })).id;
  if (poolCap) await q("UPDATE lesson_sessions SET kind = 'pool', spots_mode = 'staff', spots_cap = ? WHERE id = ?", [poolCap, id]);
  return id;
}
/** Books n students into a lesson (each with an allergy note that must never reach the planning screens). */
async function sell(M, sessionId, k, tag) {
  for (let i = 0; i < k; i += 1) {
    const [p] = await pool.query("INSERT INTO people (tenant_id, first_name, last_name, date_of_birth) VALUES (?, ?, ?, '2017-03-02')", [M.id, `Kid${tag}${i}`, `Fam${tag}`]);
    await pool.query("INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status, allergies) VALUES (?, ?, ?, 'booked', 'PEANUT-SECRET')", [M.id, sessionId, p.insertId]);
  }
}
const openOn = (M, who, dates, from = '08:00', to = '16:00') => call('POST', '/availability/windows', { token: M.owner, body: { staff_id: M[`${who}Id`], dates, start_time: from, end_time: to } });
const kids = { age_min: 5, age_max: 12 };

test.before(async () => {
  pmMock = http.createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { mails.push(JSON.parse(d)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m-${++n}` })); }); });
  await new Promise((r) => pmMock.listen(0, '127.0.0.1', r));
  mailer.settings.apiBase = `http://127.0.0.1:${pmMock.address().port}`;
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); pmMock.close(); await pool.end(); });

test('spots follow staff: advance sale, instructors x ratio, the cap, never below booked, and the hooks that recount', async () => {
  const M = await mountain('a');
  const d = addDays(today, 10);
  const p = await lesson(M, d, '09:30', kids, { pool: 40 });
  // Nobody has said when they can work: the pool sells up to its cap.
  const r0 = await LS.sync(pool, M.id, { sessionIds: [p] });
  assert.equal(r0.checked, 1);
  assert.equal(await cap(p), 40);
  const why0 = ok(await call('GET', `/skischool/staff/spots/${p}`, { token: M.owner }));
  assert.equal(why0.advance, true);
  assert.match(why0.words, /sells up to the cap of 40/);
  // Ivy marks the day open (the hook recounts). Max and Zoe never said anything, so they can work any time: 3 x 5 = 15.
  ok(await openOn(M, 'ivy', [d]), 201);
  assert.equal(await cap(p), 15);
  const why = ok(await call('GET', `/skischool/staff/spots/${p}`, { token: M.owner }));
  assert.equal(why.instructors, 3);
  assert.equal(why.ratio, 5);
  assert.equal(why.words, '3 instructors free x 5 = 15 spots, cap 40');
  // Zoe marks another day open, so on this day she is not available any more.
  ok(await openOn(M, 'zoe', [addDays(d, 1)]), 201);
  await LS.sync(pool, M.id, { dates: [d] });
  assert.equal(await cap(p), 10);
  // The adult ratio from school settings applies to a pool for older students; the kids ratio changes with the setting.
  ok(await call('PATCH', '/skischool/settings', { token: M.owner, body: { ratio_kids: 4 } }));
  await LS.sync(pool, M.id, { dates: [d] });
  assert.equal(await cap(p), 8);
  // Never above the cap.
  await q('UPDATE lesson_sessions SET spots_cap = 6 WHERE id = ?', [p]);
  await LS.sync(pool, M.id, { dates: [d] });
  assert.equal(await cap(p), 6);
  await q('UPDATE lesson_sessions SET spots_cap = 40 WHERE id = ?', [p]);
  // Sell 7, then Ivy and Max become busy: never below what is booked.
  await LS.sync(pool, M.id, { dates: [d] });
  await sell(M, p, 7, 'a');
  ok(await call('POST', '/availability/windows/clear', { token: M.owner, body: { staff_id: M.ivyId, dates: [d] } }));
  assert.equal(await cap(p), 40, 'nobody has said when they work that day any more: back to the cap');
  ok(await openOn(M, 'ivy', [d], '13:00', '16:00'), 201); // Ivy works the afternoon only
  const busy = await lesson(M, d, '09:00', { age_min: 18 }); // a set class Max is assigned to (the assign hook recounts)
  ok(await call('PATCH', `/skischool/sessions/${busy}/instructor`, { token: M.owner, body: { instructor_id: M.maxId } }));
  assert.equal(await cap(p), 7, 'kept at what is booked');
  const kept = ok(await call('GET', `/skischool/staff/spots/${p}`, { token: M.owner }));
  assert.match(kept.words, /Kept at 7 because 7 are booked or held/);
  // A lesson whose spots are fixed is never touched.
  const fixed = await lesson(M, d, '13:00', { ...kids, capacity: 9 });
  await LS.sync(pool, M.id, { dates: [d] });
  assert.equal(await cap(fixed), 9);
  // Only rows that change are written, and a summary is audited.
  const again = await LS.sync(pool, M.id, { dates: [d] });
  assert.equal(again.changed, 0);
  assert.ok((await q("SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ? AND action = 'spots_sync'", [M.id]))[0].n >= 1);
  // Inside a caller's transaction (a plan publish), the rows are written in that transaction.
  await q("UPDATE lesson_sessions SET capacity = 33 WHERE id = ?", [p]);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const r = await LS.sync(conn, M.id, { sessionIds: [p] });
    assert.equal(r.changed, 1);
    await conn.rollback();
  } finally { conn.release(); }
  assert.equal(await cap(p), 33, 'rolled back with the caller');
  await LS.sync(pool, M.id, { sessionIds: [p] });
  assert.equal(await cap(p), 7);
  // Instructors cannot see the reasons.
  assert.equal((await call('GET', `/skischool/staff/spots/${p}`, { token: M.ivy })).status, 403);
});

test('instructors are shared across lessons at the same time: the most constrained first, an assigned instructor kept', async () => {
  const M = await mountain('b');
  const d = addDays(today, 12);
  for (const who of ['ivy', 'max']) ok(await openOn(M, who, [d]), 201);
  ok(await openOn(M, 'zoe', [addDays(d, 3)]), 201); // Zoe is away that day
  const adults = await lesson(M, d, '10:00', { age_min: 18 }, { pool: 30 });
  const little = await lesson(M, d, '10:30', kids, { pool: 30 });
  await LS.sync(pool, M.id, { dates: [d] });
  // Two instructors free, both lessons overlap: the kids pool takes both first (it is more constrained), the adults get none.
  assert.equal(await cap(little), 10);
  assert.equal(await cap(adults), 0);
  // Max is assigned to the adult pool: he stays with it. Ivy goes to the kids.
  ok(await call('PATCH', `/skischool/sessions/${adults}/instructor`, { token: M.owner, body: { instructor_id: M.maxId } }));
  assert.equal(await cap(adults), 6);
  assert.equal(await cap(little), 5);
  // A later lesson that does not overlap gets everyone again.
  const later = await lesson(M, d, '13:00', kids, { pool: 30 });
  await LS.sync(pool, M.id, { sessionIds: [later] });
  assert.equal(await cap(later), 10);
  // Snowboard only for an instructor who teaches ski: not cleared, not counted.
  ok(await call('PUT', `/skischool/instructors/${M.ivyId}/profile`, { token: M.owner, body: { disciplines: ['ski'], ski_level_max: 9, snowboard_level_max: null, teaches_kids: true, teaches_adaptive: false, psia_level: 'level1' } }));
  const board = await lesson(M, d, '14:00', { ...kids, discipline: 'snowboard' }, { pool: 30 });
  await LS.sync(pool, M.id, { sessionIds: [board] });
  assert.equal(await cap(board), 5, 'only Max teaches snowboard');
});

test('the fill view, Fill the gap, a shift offer taken, and the staffing target on My day with I can work', async () => {
  const M = await mountain('c');
  const d = addDays(today, 9);
  ok(await openOn(M, 'ivy', [d]), 201);
  ok(await openOn(M, 'max', [addDays(d, 2)]), 201); // Max and Zoe are not in that day
  ok(await openOn(M, 'zoe', [addDays(d, 2)]), 201);
  const set = await lesson(M, d, '09:30', { ...kids, capacity: 12 }); // a set class: 11 kids need 3 instructors at 5 each
  await sell(M, set, 11, 'c');
  const p = await lesson(M, d, '09:30', kids, { pool: 20 });
  await LS.sync(pool, M.id, { dates: [d] });
  const month = ok(await call('GET', `/skischool/staff/fill?month=${d.slice(0, 7)}`, { token: M.owner }));
  const row = month.days.find((x) => x.date === d);
  assert.equal(row.booked, 11);
  assert.equal(row.mark, 'red');
  assert.equal(row.need, 3);
  assert.equal(row.available, 1);
  assert.equal(row.groups, undefined, 'the month is light');
  const dayv = ok(await call('GET', `/skischool/staff/fill/day?date=${d}`, { token: M.owner }));
  const g = dayv.groups.find((x) => x.time === '09:30');
  assert.equal(g.short, 2);
  assert.equal(g.lessons.length, 2);
  assert.match(g.words, /^Short 2 instructors .*9:30 AM, kids ski$/);
  assert.ok(g.lessons.find((l) => l.id === p).follows_staff);
  assert.equal(g.lessons.find((l) => l.id === p).capacity, 0, 'Ivy went to the class already sold');
  assert.equal(JSON.stringify(dayv).includes('PEANUT'), false, 'no allergy or medical notes on planning screens');
  // Instructors cannot see the fill view or fill the gap; the counter neither.
  assert.equal((await call('GET', `/skischool/staff/fill?month=${d.slice(0, 7)}`, { token: M.ivy })).status, 403);
  assert.equal((await call('POST', '/skischool/staff/fill/ask', { token: M.counter, body: { date: d, time: '09:30', discipline: 'ski', band: 'kids' } })).status, 403);
  // The staffing target: Max sees the day (he is cleared and not counted) with I can work.
  const needs = ok(await call('GET', '/skischool/staff/needs', { token: M.max })).data;
  const need = needs.find((x) => x.date === d);
  assert.match(need.words, /needs 2 more people \(kids ski, 9:30 AM\)$/);
  assert.equal(need.counted, false);
  // Fill the gap: one tap asks Max and Zoe (not Ivy, she is counted already).
  const ask = ok(await call('POST', '/skischool/staff/fill/ask', { token: M.owner, body: { date: d, time: '09:30', discipline: 'ski', band: 'kids' } }), 201);
  assert.deepEqual(ask.asked.sort(), ['Max Teach', 'Zoe Teach']);
  const offer = (await q('SELECT * FROM shift_offers WHERE id = ?', [ask.offer_id]))[0];
  assert.equal(offer.spots, 2);
  // Max says yes: he counts for that time, and spots recount.
  ok(await call('POST', `/skischool/offers/${ask.offer_id}/accept`, { token: M.max }));
  const after = ok(await call('GET', `/skischool/staff/fill/day?date=${d}`, { token: M.owner }));
  assert.equal(after.groups.find((x) => x.time === '09:30').short, 1);
  assert.deepEqual(after.asks[0].accepted, ['Max Teach']);
  assert.equal(after.asks[0].asked.length, 2);
  // Zoe says I can work from My day: an open time for her, and the gap closes.
  assert.ok(ok(await call('GET', '/skischool/staff/needs', { token: M.zoe })).data.some((x) => x.date === d));
  ok(await call('POST', '/skischool/staff/needs/can-work', { token: M.zoe, body: { date: d, time: '09:30', discipline: 'ski', band: 'kids' } }), 201);
  assert.equal((await q('SELECT COUNT(*) AS n FROM instructor_open WHERE tenant_id = ? AND staff_id = ? AND open_date = ?', [M.id, M.zoeId, d]))[0].n, 1);
  const closed = ok(await call('GET', `/skischool/staff/fill/day?date=${d}`, { token: M.owner }));
  assert.equal(closed.groups.find((x) => x.time === '09:30').short, 0);
  assert.equal(ok(await call('GET', '/skischool/staff/needs', { token: M.zoe })).data.some((x) => x.date === d), false);
  assert.equal((await call('POST', '/skischool/staff/fill/ask', { token: M.owner, body: { date: d, time: '09:30', discipline: 'ski', band: 'kids' } })).status, 409, 'nothing to fill');
  assert.equal((await call('POST', '/skischool/staff/needs/can-work', { token: M.zoe, body: { date: d, time: '09:30', discipline: 'ski', band: 'kids' } })).status, 409);
});

test('the lessons job recounts, records when a lesson fills and opens again, and demand turns into suggestions', async () => {
  const M = await mountain('d');
  const d = addDays(today, 5);
  const p = await lesson(M, d, '10:00', kids, { pool: 3 });
  await q('UPDATE lesson_sessions SET capacity = 1 WHERE id = ?', [p]);
  const t = await staffPart.tick();
  assert.ok(t.tenants >= 1);
  assert.equal(await cap(p), 3, 'advance: up to the cap');
  await sell(M, p, 3, 'd');
  await staffPart.tick();
  const full = (await q('SELECT full_at, full_since, reopened_at FROM lesson_sessions WHERE id = ?', [p]))[0];
  assert.ok(full.full_at && full.full_since);
  await q("UPDATE lesson_sessions SET spots_cap = 5, capacity = 5 WHERE id = ?", [p]);
  await staffPart.tick();
  const open = (await q('SELECT full_at, full_since, reopened_at FROM lesson_sessions WHERE id = ?', [p]))[0];
  assert.equal(open.full_since, null);
  assert.ok(open.reopened_at);
  assert.equal(String(open.full_at), String(full.full_at), 'the first fill is kept');

  // Demand: three past Saturdays at 9:30 kids ski filled 3 days ahead, with waitlist sign-ups and searches that found it full.
  let sat = addDays(today, -1); while (new Date(`${sat}T12:00:00Z`).getUTCDay() !== 6) sat = addDays(sat, -1);
  for (let w = 0; w < 3; w += 1) {
    const day = addDays(sat, -7 * w);
    const [r] = await pool.query("INSERT INTO lesson_sessions (tenant_id, product_id, discipline, ability_level, age_min, age_max, format, age_group, starts_at, ends_at, capacity, kind, spots_mode, spots_cap, full_at) VALUES (?, ?, 'ski', 'beginner', 5, 12, 'group', 'kids', ?, ?, 10, 'pool', 'staff', 10, ?)",
      [M.id, M.group, `${day} 09:30:00`, `${day} 11:30:00`, `${addDays(day, -3)} 18:00:00`]);
    for (let k = 0; k < 4; k += 1) await pool.query("INSERT INTO lesson_waitlist (tenant_id, session_id, contact_name, contact_email, student) VALUES (?, ?, 'Pat Parent', 'pat@x.test', '{}')", [M.id, r.insertId]);
    assert.equal(await LD.noteFull(pool, M.id, r.insertId), true);
  }
  const dem = ok(await call('GET', '/skischool/staff/demand', { token: M.owner }));
  const top = dem.rows[0];
  assert.equal(top.time, '09:30');
  assert.equal(top.filled, 3);
  assert.equal(top.days_ahead, 3);
  assert.equal(top.waitlist, 12);
  assert.equal(top.searches, 3);
  assert.match(top.words, /^Sat 9:30 AM kids ski filled 3 of the last 3 Saturdays, 3 days ahead on average, 12 on the waitlist, 3 searches found it full\.$/);
  const sug = dem.suggestions[0];
  assert.equal(sug.time, '10:00');
  assert.match(sug.words, /^Add a 10:00 AM kids ski pool on Saturdays: about \d+ more lessons each Saturday\.$/);
  assert.equal((await call('GET', '/skischool/staff/demand', { token: M.ivy })).status, 403);
  assert.equal((await call('GET', '/skischool/staff/demand', { token: M.counter })).status, 403);
  // Nothing was added by itself.
  assert.equal((await q("SELECT COUNT(*) AS n FROM lesson_sessions WHERE tenant_id = ? AND TIME(starts_at) = '10:00:00' AND DAYOFWEEK(starts_at) = 7", [M.id]))[0].n, 0);
});

// Review fix (2026.11.9): a private request waiting for a named instructor holds their time; accepting a private recounts.
test('a private request waiting for a named instructor holds their time; declining frees it; accepting a private recounts', async () => {
  const PR = require('../src/lib/lessonprivate');
  const M = await mountain('held');
  const d = addDays(today, 9);
  for (const who of ['ivy', 'max']) ok(await openOn(M, who, [d]), 201);
  ok(await openOn(M, 'zoe', [addDays(d, 3)]), 201);
  const little = await lesson(M, d, '10:00', kids, { pool: 30 });
  await LS.sync(pool, M.id, { dates: [d] });
  assert.equal(await cap(little), 10, 'Ivy and Max');
  const priv = ok(await call('POST', '/products', { token: M.owner, body: { kind: 'lesson', name: 'Private Lesson', base_price_cents: 14000 } })).id;
  const offer = ok(await call('POST', '/skischool/pay/private-offers', { token: M.owner, body: { product_id: priv, minutes: 60, max_students: 2 } }), 201).id;
  const ask = async (ref, staffId) => (await pool.query(`INSERT INTO private_requests (tenant_id, reference, token_sha, status, source, staff_id, any_instructor, offer_id, product_id, discipline, starts_at, minutes, students, contact_name, contact_email, contact_phone, waiver_accepted, amount_cents, pay_at_desk, deadline_at)
    VALUES (?, ?, ?, 'waiting', 'public', ?, ?, ?, ?, 'ski', ?, 60, ?, 'Pat Parent', ?, '215-555-0101', 1, 14000, 1, UTC_TIMESTAMP() + INTERVAL 1 HOUR)`,
  [M.id, PR.reference(), PR.sha(`${ref}-${suffix}`), staffId, staffId ? 0 : 1, offer, priv, `${d} 10:30:00`, JSON.stringify({ contact: { first_name: 'Pat', last_name: 'Parent' }, students: [{ first_name: 'Kim', last_name: `Held${suffix}`, date_of_birth: '1990-01-01', sex: 'female', level: 3 }] }), `pat.${ref}.${suffix}@x.test`]))[0].insertId;
  // Asked for Ivy by name: her time is held while she decides.
  const a = await ask('heldivy', M.ivyId);
  await PR.afterWaiting(M.id, a);
  assert.equal(await cap(little), 5, 'only Max counts while Ivy is held');
  // She declines: the time is free again.
  ok(await call('POST', `/skischool/pay/requests/${a}/decline`, { token: M.ivy, body: { reason: 'Racing' } }));
  assert.equal(await cap(little), 10);
  // "Any instructor": nobody is held until Max accepts; accepting recounts at once.
  const b = await ask('heldany', null);
  await PR.afterWaiting(M.id, b);
  assert.equal(await cap(little), 10);
  ok(await call('POST', `/skischool/pay/requests/${b}/accept`, { token: M.max }));
  assert.equal(await cap(little), 5, 'Max now teaches the private');
});
