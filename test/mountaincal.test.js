'use strict';

// The Mountain calendar (2026.11.10, Track CALENDAR): events people add, what the app already knows gathered onto it,
// who sees what by team and role, who may add for which team, the Today card, and the private calendar feed link.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.CALENDAR_FEED_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const C = require('../src/lib/mountaincal');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const addDays = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const q = async (sql, params) => (await pool.query(sql, params))[0];

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text, type: res.headers.get('content-type') };
}
const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body; };
async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const id = (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id;
  return { slug, id, owner: (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token };
}
async function addUser(m, key, role, extra = {}) {
  const email = `${key}@${m.slug}.test`;
  ok(await api('POST', '/users', { token: m.owner, body: { email, password: PW, role, ...extra } }), 201);
  return (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token;
}
const staffFor = async (m, first) => ok(await api('POST', '/workforce/staff', { token: m.owner, body: { person: { first_name: first, last_name: 'Test' }, status: 'active' } }), 201).id;
const cal = (token, from = today, to = addDays(today, 13), extra = '') => api('GET', `/calendar?from=${from}&to=${to}${extra}`, { token });
const titles = (r) => r.body.items.map((x) => x.title);

let A; let B; const T = {};
test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`mc-a-${suffix}`);
  B = await mountain(`mc-b-${suffix}`);
  T.manager = await addUser(A, 'manager', 'manager');
  T.counter = await addUser(A, 'counter', 'counter');
  T.staff = await addUser(A, 'lifty', 'staff');
  T.instructor = await addUser(A, 'ivy', 'instructor');
  // A ski school director and a patrol lead (patrol Manager level), each linked to a staff record.
  const dana = await staffFor(A, 'Dana');
  T.director = await addUser(A, 'dana', 'instructor', { staff_id: dana });
  await q("INSERT INTO instructor_profiles (tenant_id, staff_id, is_public, school_access) VALUES (?, ?, 0, 'director')", [A.id, dana]);
  const lee = await staffFor(A, 'Lee');
  await q("INSERT INTO patrol_members (tenant_id, staff_id, level, access_level) VALUES (?, ?, 'leader', 'manager')", [A.id, lee]);
  T.lead = await addUser(A, 'lee', 'patrol', { staff_id: lee });
  const pat = await staffFor(A, 'Pat');
  await q("INSERT INTO patrol_members (tenant_id, staff_id, level, access_level) VALUES (?, ?, 'patroller', 'patrol')", [A.id, pat]);
  T.patrol = await addUser(A, 'pat', 'patrol', { staff_id: pat });
  T.bOwner = B.owner;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('owners and managers add, change and delete events; each change is audited', async () => {
  const made = ok(await api('POST', '/calendar/events', { token: T.manager, body: { title: 'All staff meeting', kind: 'meeting', starts_on: addDays(today, 1), all_day: false, start_time: '07:30', end_time: '08:15', place: 'Base lodge', note: 'Coffee at 7', teams: [] } }), 201);
  assert.equal(made.teams, null, 'no teams chosen: everyone');
  assert.equal(made.start_time, '07:30');
  assert.equal(made.editable, true);
  const ch = ok(await api('PATCH', `/calendar/events/${made.event_id}`, { token: T.manager, body: { title: 'All staff meeting (moved)', start_time: '08:00', end_time: '08:45' } }));
  assert.equal(ch.title, 'All staff meeting (moved)');
  assert.equal(ch.start_time, '08:00');
  const range = ok(await api('POST', '/calendar/events', { token: A.owner, body: { title: 'Race week', kind: 'event', starts_on: addDays(today, 2), ends_on: addDays(today, 5), teams: ['ski_school', 'front_desk'] } }), 201);
  assert.deepEqual(range.teams, ['front_desk', 'ski_school']);
  const every = ok(await api('POST', '/calendar/events', { token: A.owner, body: { title: 'Everyone, every team', starts_on: today, teams: C.TEAM_KEYS } }), 201);
  assert.equal(every.teams, null, 'every team chosen is the same as everyone');
  ok(await api('DELETE', `/calendar/events/${every.event_id}`, { token: A.owner }));
  const audits = await q("SELECT action FROM audit_log WHERE tenant_id = ? AND entity = 'mountain_events' ORDER BY id", [A.id]);
  assert.deepEqual(audits.map((a) => a.action), ['create', 'update', 'create', 'create', 'delete']);
});

test('plain words for a bad event: days in order, a start time, a sensible length', async () => {
  const bad = async (body, words) => { const r = await api('POST', '/calendar/events', { token: T.manager, body: { title: 'X', starts_on: today, ...body } }); assert.equal(r.status, 400, JSON.stringify(r.body)); assert.match(JSON.stringify(r.body), words); };
  await bad({ ends_on: addDays(today, -1) }, /last day must be on or after/);
  await bad({ all_day: false }, /start time/);
  await bad({ all_day: false, start_time: '10:00', end_time: '09:00' }, /end time must be after/);
  await bad({ ends_on: addDays(today, 200) }, /at most 120 days/);
  await bad({ title: '' }, /title/);
  await bad({ teams: ['kitchen'] }, /./);
  assert.equal((await cal(T.manager, today, addDays(today, 90))).status, 400, 'at most 62 days a request');
  assert.equal((await cal(T.manager, addDays(today, 3), today)).status, 400);
  assert.equal((await cal(T.manager, 'tomorrow', today)).status, 400);
});

test('everyone else reads; ski school directors add for the ski school, patrol leads for patrol, and only that', async () => {
  for (const who of ['counter', 'staff', 'instructor', 'patrol']) {
    const r = await api('POST', '/calendar/events', { token: T[who], body: { title: 'Nope', starts_on: today } });
    assert.equal(r.status, 403, who);
    assert.match(r.body.error, /Only managers and owners add events/);
  }
  const sch = ok(await api('POST', '/calendar/events', { token: T.director, body: { title: 'Instructor clinic', kind: 'training', starts_on: addDays(today, 3), teams: ['ski_school'] } }), 201);
  assert.equal(sch.editable, true);
  const wide = await api('POST', '/calendar/events', { token: T.director, body: { title: 'For everyone', starts_on: today } });
  assert.equal(wide.status, 403);
  assert.match(wide.body.error, /Ski school only/);
  assert.equal((await api('POST', '/calendar/events', { token: T.director, body: { title: 'Two teams', starts_on: today, teams: ['ski_school', 'patrol'] } })).status, 403);
  const pat = ok(await api('POST', '/calendar/events', { token: T.lead, body: { title: 'Toboggan training', kind: 'training', starts_on: addDays(today, 4), teams: ['patrol'] } }), 201);
  // A director cannot touch the patrol's event or widen their own; a patrol lead cannot touch the school's.
  assert.equal((await api('PATCH', `/calendar/events/${pat.event_id}`, { token: T.director, body: { title: 'Mine now' } })).status, 403);
  assert.equal((await api('DELETE', `/calendar/events/${sch.event_id}`, { token: T.lead })).status, 403);
  assert.equal((await api('PATCH', `/calendar/events/${sch.event_id}`, { token: T.director, body: { teams: null } })).status, 403);
  ok(await api('PATCH', `/calendar/events/${sch.event_id}`, { token: T.director, body: { place: 'Learning area' } }));
  // A manager's event for everyone is read only to a director.
  const all = (await cal(T.director)).body.items.find((x) => x.title.startsWith('All staff meeting'));
  assert.equal(all.editable, false);
  assert.equal((await api('DELETE', `/calendar/events/${all.event_id}`, { token: T.director })).status, 403);
});

test('each person sees everyone\'s events and their own teams\' events; "My teams" comes back with the answer', async () => {
  const lists = {};
  for (const who of ['manager', 'counter', 'staff', 'instructor', 'director', 'patrol']) lists[who] = titles(await cal(T[who]));
  for (const who of Object.keys(lists)) assert.ok(lists[who].some((t) => t.startsWith('All staff meeting')), `${who} sees the everyone event`);
  assert.ok(lists.counter.includes('Race week'), 'front desk sees an event for front desk');
  assert.ok(lists.instructor.includes('Race week') && lists.instructor.includes('Instructor clinic'));
  assert.ok(!lists.staff.includes('Race week') && !lists.staff.includes('Instructor clinic') && !lists.staff.includes('Toboggan training'), 'lift staff see none of those');
  assert.ok(!lists.counter.includes('Toboggan training') && lists.patrol.includes('Toboggan training'));
  assert.ok(lists.manager.includes('Toboggan training') && lists.manager.includes('Instructor clinic'), 'managers see everything');
  const r = await cal(T.counter);
  assert.deepEqual(r.body.me.teams, ['front_desk', 'rentals']);
  assert.equal(r.body.today, today);
  // Filters: a team (what is for it, plus everyone's) and kinds.
  const school = titles(await cal(T.manager, today, addDays(today, 13), '&team=patrol'));
  assert.ok(school.includes('Toboggan training') && !school.includes('Race week') && school.some((t) => t.startsWith('All staff meeting')));
  const training = titles(await cal(T.manager, today, addDays(today, 13), '&kinds=training'));
  assert.deepEqual(training.sort(), ['Instructor clinic', 'Toboggan training']);
  // A staff record's department adds its team: a lift operator who also works the rental shop.
  const pos = ok(await api('POST', '/workforce/positions', { token: A.owner, body: { name: 'Rental tech', department: 'rentals' } }), 201).id;
  const sam = await staffFor(A, 'Sam');
  await q('INSERT INTO staff_positions (tenant_id, staff_id, position_id) VALUES (?, ?, ?)', [A.id, sam, pos]);
  const samTok = await addUser(A, 'sam', 'staff', { staff_id: sam });
  assert.deepEqual((await cal(samTok)).body.me.teams, ['rentals', 'lifts']);
});

test('gathered from the app: closed days, season dates, groups (name and size only), programs, school, patrol, upkeep, ticket days', async () => {
  const d1 = addDays(today, 1); const d2 = addDays(today, 2); const d3 = addDays(today, 3);
  // Operating calendar and the season.
  ok(await api('PUT', `/schedule/days/${d2}`, { token: A.owner, body: { status: 'closed', notes: 'Wind storm' } }));
  await q('UPDATE tenants SET season_ends_on = ? WHERE id = ?', [d3, A.id]);
  // Rental group with two renters, and a booked group inquiry (contact details must not show).
  const [g] = await pool.query("INSERT INTO rental_groups (tenant_id, name, rental_on, days, status) VALUES (?, 'Scout Troop 12', ?, 2, 'open')", [A.id, d1]);
  await q("INSERT INTO group_enquiries (tenant_id, contact_name, organisation, email, phone, group_size, preferred_on, status) VALUES (?, 'Carla Contact', 'Valley High Ski Club', 'carla@private.test', '610-555-0100', 24, ?, 'booked')", [A.id, d1]); // spelling-ok
  await q("INSERT INTO group_enquiries (tenant_id, contact_name, organisation, email, group_size, preferred_on, status) VALUES (?, 'New Person', 'Not yet', 'n@x.test', 9, ?, 'new')", [A.id, d1]); // spelling-ok
  // A program with two groups meeting on one day: one line, first start to last end.
  const prog = ok(await api('POST', '/programs', { token: A.owner, body: { name: 'Junior Race Team', kind: 'race_team', season: '2026-27', capacity: 20, price_cents: 0 } }), 201).id;
  await q('INSERT INTO program_sessions (tenant_id, program_id, starts_at, ends_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)', [A.id, prog, `${d1} 09:00:00`, `${d1} 11:00:00`, A.id, prog, `${d1} 13:00:00`, `${d1} 15:00:00`]);
  // School holiday and a published season plan with a named period and a closed exception day.
  await q("INSERT INTO school_holidays (tenant_id, on_date, name) VALUES (?, ?, 'Teacher in-service')", [A.id, d2]);
  const L = require('../src/lib/lessonplan');
  const doc = L.defaults();
  doc.periods = [{ from: d1, to: d3, day_type: 'holiday_week', name: 'Thanksgiving week' }];
  doc.exceptions = [{ date: d3, day_type: 'closed', add: [], remove: [] }];
  await q("INSERT INTO lesson_plans (tenant_id, name, from_on, to_on, doc, status) VALUES (?, 'Winter', ?, ?, ?, 'published')", [A.id, today, addDays(today, 30), JSON.stringify(doc)]);
  await q("INSERT INTO lesson_plans (tenant_id, name, from_on, to_on, doc, status) VALUES (?, 'Draft', ?, ?, ?, 'draft')", [A.id, today, addDays(today, 30), JSON.stringify({ ...doc, periods: [{ from: d1, to: d1, day_type: 'weekday', name: 'Draft only' }] })]);
  // Patrol training on the published schedule (and a regular shift, which is not shown).
  await q("INSERT INTO patrol_shifts (tenant_id, starts_at, ends_at, role_label, status) VALUES (?, ?, ?, 'OEC refresher training', 'published'), (?, ?, ?, 'OEC refresher training', 'published'), (?, ?, ?, 'Sweep', 'published'), (?, ?, ?, 'Training', 'draft')",
    [A.id, `${d2} 08:00:00`, `${d2} 12:00:00`, A.id, `${d2} 08:30:00`, `${d2} 12:30:00`, A.id, `${d2} 08:00:00`, `${d2} 16:00:00`, A.id, `${d3} 08:00:00`, `${d3} 16:00:00`]);
  // Upkeep: a preventive task due in two days, one overdue, and a work order due tomorrow.
  const lift = ok(await api('POST', '/schedule/lifts', { token: A.owner, body: { name: 'Summit Quad' } }), 201).id;
  await q("INSERT INTO pm_tasks (tenant_id, name, lift_id, interval_days, last_done_on) VALUES (?, 'Haul rope inspection', ?, 7, ?), (?, 'Brake test', ?, 7, ?)", [A.id, lift, addDays(today, -5), A.id, lift, addDays(today, -10)]);
  await q("INSERT INTO work_orders (tenant_id, title, priority, status, lift_id, due_date) VALUES (?, 'Replace sheave liner', 'high', 'open', ?, ?)", [A.id, lift, d1]);
  // Ticket days: a blackout and a special price on one product.
  const prod = ok(await api('POST', '/products', { token: A.owner, body: { kind: 'day_ticket', name: 'Adult Day', base_price_cents: 6000 } }), 201).id;
  await q('INSERT INTO price_calendar (tenant_id, product_id, on_date, price_cents, blackout) VALUES (?, ?, ?, NULL, 1), (?, ?, ?, 8900, 0)', [A.id, prod, d3, A.id, prod, d2]);

  const all = (await cal(T.manager)).body.items;
  const find = (re) => all.find((x) => re.test(x.title));
  assert.equal(find(/^Mountain closed$/).starts_on, d2);
  assert.equal(find(/^Mountain closed$/).note, 'Wind storm');
  assert.equal(find(/^Closing day$/).starts_on, d3);
  const rg = find(/^Rental group: Scout Troop 12/);
  assert.equal(rg.ends_on, d2, 'two rental days');
  assert.equal(rg.link, '#/rentals?tab=groups');
  const gi = find(/Valley High Ski Club/);
  assert.equal(gi.title, 'Group: Valley High Ski Club (24)');
  assert.ok(!find(/Not yet/), 'only booked inquiries');
  const pr = find(/^Junior Race Team$/);
  assert.equal(pr.start_time, '09:00'); assert.equal(pr.end_time, '15:00');
  assert.equal(pr.link, `#/programs/${prog}`);
  assert.ok(find(/^School holiday: Teacher in-service$/));
  const period = find(/^Ski school: Thanksgiving week/);
  assert.equal(period.starts_on, d1); assert.equal(period.ends_on, d3);
  assert.ok(find(/^Ski school closed$/));
  assert.ok(!find(/Draft only/), 'only published plans');
  const tr = all.filter((x) => /^Patrol: OEC refresher training$/.test(x.title));
  assert.equal(tr.length, 1, 'one line for the day');
  assert.equal(tr[0].note, '2 patrollers');
  assert.equal(tr[0].start_time, '08:00'); assert.equal(tr[0].end_time, '12:30');
  assert.ok(!find(/Sweep/));
  assert.equal(find(/^Due: Haul rope inspection/).starts_on, d2);
  const late = find(/^Overdue: Brake test/);
  assert.equal(late.starts_on, today); assert.match(late.note, /Was due/);
  assert.equal(find(/^Work order due: Replace sheave liner/).note, 'High priority');
  assert.equal(find(/^Blackout: Adult Day$/).starts_on, d3);
  assert.equal(find(/^Special price: Adult Day$/).starts_on, d2);
  for (const x of all) assert.ok(C.ALL_KINDS.some((k) => k[0] === x.kind), `${x.title} has a known kind`);
  // Nothing private rides along: no contact names, emails or phones anywhere in the answer.
  const text = JSON.stringify(all);
  for (const secret of ['Carla', 'carla@private.test', '555-0100']) assert.ok(!text.includes(secret), secret);
  // By team: lift staff see upkeep and the closed day, not the rental group, the school or patrol training.
  const lifty = titles(await cal(T.staff));
  assert.ok(lifty.includes('Mountain closed') && lifty.some((t) => t.startsWith('Due: Haul rope')));
  assert.ok(!lifty.some((t) => /Rental group|Ski school|Patrol|Valley High|Blackout/.test(t)));
  const desk = titles(await cal(T.counter));
  assert.ok(desk.some((t) => t.startsWith('Rental group')) && desk.includes('Blackout: Adult Day') && desk.includes('Junior Race Team'));
  assert.ok(!desk.some((t) => /Haul rope|Patrol:/.test(t)));
  const pat = titles(await cal(T.patrol));
  assert.ok(pat.includes('Patrol: OEC refresher training') && !pat.some((t) => /Blackout|Rental group/.test(t)));
  void g;
});

test('an app turned off for the mountain gathers nothing', async () => {
  await q('INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, ?, 0) ON DUPLICATE KEY UPDATE enabled = 0', [A.id, 'rentals']);
  require('../src/lib/modules').invalidate(A.id);
  assert.ok(!titles(await cal(T.manager)).some((t) => t.startsWith('Rental group')));
  await q('DELETE FROM tenant_modules WHERE tenant_id = ? AND module = ?', [A.id, 'rentals']);
  require('../src/lib/modules').invalidate(A.id);
  assert.ok(titles(await cal(T.manager)).some((t) => t.startsWith('Rental group')));
});

test('coming up: today and the next two days, for the Today page', async () => {
  const r = ok(await api('GET', '/calendar/coming-up', { token: T.staff }));
  assert.equal(r.today, today);
  for (const x of r.items) assert.ok(x.starts_on <= addDays(today, 2) && x.ends_on >= today, x.title);
  assert.ok(r.items.length <= 8);
  assert.ok(!r.items.some((x) => /Rental group/.test(x.title)), 'still only what this person may see');
});

test('mountains never see each other\'s calendar', async () => {
  const b = (await cal(T.bOwner)).body.items;
  assert.equal(b.length, 0, JSON.stringify(b.map((x) => x.title)));
  const a = (await cal(T.manager)).body.items.find((x) => x.event_id);
  assert.equal((await api('PATCH', `/calendar/events/${a.event_id}`, { token: T.bOwner, body: { title: 'Hijack' } })).status, 404);
  assert.equal((await api('DELETE', `/calendar/events/${a.event_id}`, { token: T.bOwner })).status, 404);
  assert.equal((await api('GET', '/calendar?from=2026-01-01&to=2026-01-02')).status, 401, 'signed in only');
});

test('the private calendar feed: a link per person, only what they may see, revocable, and dead for a login that is off', async () => {
  assert.equal(ok(await api('GET', '/calendar/feed', { token: T.staff })).on, false);
  const made = ok(await api('POST', '/calendar/feed', { token: T.staff }), 201);
  assert.match(made.url, /\/api\/v1\/calendar-feed\/[A-Za-z0-9_-]{43}\.ics$/);
  assert.match(made.webcal, /^webcal:/);
  assert.equal(ok(await api('GET', '/calendar/feed', { token: T.staff })).on, true);
  const path = new URL(made.url).pathname.replace('/api/v1', '');
  const stored = await q('SELECT token_sha FROM calendar_feeds WHERE tenant_id = ?', [A.id]);
  assert.ok(stored.length && !stored.some((s) => made.url.includes(s.token_sha)), 'only a hash is kept');
  const feed = await api('GET', path);
  assert.equal(feed.status, 200);
  assert.match(feed.type, /text\/calendar/);
  assert.match(feed.text, /^BEGIN:VCALENDAR\r\n/);
  assert.match(feed.text, /SUMMARY:Mountain closed/);
  assert.match(feed.text, /SUMMARY:Due: Haul rope inspection/);
  assert.ok(!/Rental group|Toboggan|Instructor clinic|Valley High/.test(feed.text), 'never more than the person can see');
  assert.match(feed.text, /DTSTART;TZID=America\/New_York:\d{8}T080000/, 'timed events in the mountain\'s zone');
  assert.ok(feed.text.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), 'lines folded');
  // A new link replaces the old; turning it off ends it; a login that is turned off has no feed.
  const again = ok(await api('POST', '/calendar/feed', { token: T.staff }), 201);
  assert.equal((await api('GET', path)).status, 404, 'the old link stops working');
  const path2 = new URL(again.url).pathname.replace('/api/v1', '');
  assert.equal((await api('GET', path2)).status, 200);
  ok(await api('DELETE', '/calendar/feed', { token: T.staff }));
  assert.equal((await api('GET', path2)).status, 404);
  const third = ok(await api('POST', '/calendar/feed', { token: T.counter }), 201);
  const path3 = new URL(third.url).pathname.replace('/api/v1', '');
  assert.equal((await api('GET', path3)).status, 200);
  await q("UPDATE users SET active = 0 WHERE tenant_id = ? AND email = ?", [A.id, `counter@${A.slug}.test`]);
  assert.equal((await api('GET', path3)).status, 404);
  await q("UPDATE users SET active = 1 WHERE tenant_id = ? AND email = ?", [A.id, `counter@${A.slug}.test`]);
  // Guesses get the same plain 404.
  for (const p of ['/calendar-feed/nope.ics', `/calendar-feed/${'a'.repeat(43)}.ics`, '/calendar-feed/x']) assert.equal((await api('GET', p)).status, 404, p);
  const acts = (await q("SELECT action FROM audit_log WHERE tenant_id = ? AND entity = 'calendar_feeds' ORDER BY id", [A.id])).map((a) => a.action);
  assert.deepEqual(acts, ['feed_link', 'feed_link', 'feed_off', 'feed_link']);
});

test('the iCalendar text: escaping, folding, all-day ends the day after, a timed range repeats daily', () => {
  assert.equal(C.icsText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  const long = C.fold(`SUMMARY:${'x'.repeat(200)}`);
  assert.ok(long.split('\r\n').every((l) => Buffer.byteLength(l) <= 75));
  assert.equal(long.replace(/\r\n /g, ''), `SUMMARY:${'x'.repeat(200)}`);
  const ics = C.toIcs([
    { id: 'event:1', kind: 'closure', title: 'Closed', starts_on: '2026-12-25', ends_on: '2026-12-26', all_day: true, teams: null, source_label: 'Added by staff' },
    { id: 'event:2', kind: 'training', title: 'Clinic', starts_on: '2026-12-01', ends_on: '2026-12-03', all_day: false, start_time: '09:00', end_time: '16:00', place: 'Lodge, upstairs', teams: ['ski_school'], source_label: 'Added by staff' },
  ], { name: 'Test calendar', tz: 'America/New_York', host: 'x.test', stamp: '20261101T000000Z' });
  assert.match(ics, /DTSTART;VALUE=DATE:20261225\r\nDTEND;VALUE=DATE:20261227/);
  assert.match(ics, /DTSTART;TZID=America\/New_York:20261201T090000\r\nDTEND;TZID=America\/New_York:20261201T160000\r\nRRULE:FREQ=DAILY;COUNT=3/);
  assert.match(ics, /LOCATION:Lodge\\, upstairs/);
  assert.match(ics, /For: Ski school/);
});
