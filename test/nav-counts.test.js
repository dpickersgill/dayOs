'use strict';

// Release 2026.11.21, workstream "counts": the counts beside the menu's apps (GET /nav/counts) and what "+ New" may
// offer (GET /nav/new). Through real HTTP, for a municipality (owner, manager, crew, front desk) and a ski area (owner,
// counter, patroller, the patrol director who reviews): each count equals the number its Today card shows the same
// person; zero gives no entry; an app turned off gives no entry; a crew member never sees another's assignments;
// another tenant's rows never count; a ski area gets no municipal counts and a municipality no ski ones.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.MODULE_CACHE_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const modules = require('../src/lib/modules');
const { createMuniTenant } = require('./helpers/muni');

const KEY = 'test-bootstrap-key';
const PW = 'correct-horse-battery';
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
let server; let base;
const REC = require('./helpers/records').records(() => base, () => PW); // the patient-record check, once per sign-in
const todayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const today = todayIn('America/New_York');
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

async function api(method, p, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const is = (r, status, why) => { assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body).slice(0, 400)}`); return r.body; };
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body).slice(0, 400)}`); return r.body; };
const counts = async (token) => is(await api('GET', '/nav/counts', { token }), 200).counts;
const newItems = async (token) => is(await api('GET', '/nav/new', { token }), 200).items;
/** The number on one of a municipal app's Today cards, as this person's Today shows it. */
const card = async (token, path, title) => {
  const c = is(await api('GET', path, { token }), 200).cards.find((x) => x.title === title);
  assert.ok(c, `a "${title}" card at ${path}`);
  return c.count;
};
const setModules = async (tenantId, change) => {
  is(await api('PUT', `/platform/tenants/${tenantId}/modules`, { headers: { 'x-platform-key': KEY }, body: { modules: change } }), 200);
  modules.invalidate(tenantId);
};

// ---------------------------------------------------------------- the two municipalities and the two ski areas
let A; let B; let ski; let other;
const P = {}; // the people of municipality A: { mgr, luis, tom, loose, desk } each { id, token }
const staffA = {};
const S = {}; // the ski area's staff ids
const T = {}; // the ski area's tokens
const U = {}; // the ski area's user ids

async function person(token, first, last) {
  return ok(await api('POST', '/workforce/staff', { token, body: { person: { first_name: first, last_name: last }, status: 'active' } })).id;
}
async function muniStart(M) {
  M.street = ok(await api('POST', '/requests/streets', { token: M.token, body: { name: 'Main Street' } })).id;
  M.category = is(await api('GET', `/public/${M.slug}/report`), 200).categories.find((c) => c.name === 'Pothole').id;
}
const request = async (M, token) => ok(await api('POST', '/requests', { token: token || M.token, body: { category_id: M.category, street_id: M.street, source: 'phone' } })).id;
const workOrder = async (token, body) => ok(await api('POST', '/ops/work-orders', { token, body })).id;

async function mountain(slug, name) {
  const made = await api('POST', '/platform/tenants', { headers: { 'x-platform-key': KEY }, body: { slug, name, billing: 'comped', owner: { email: `gm@${slug}.test`, password: PW, first_name: 'Gale', last_name: 'Ridge' } } });
  is(made, 201);
  const login = async (who) => REC(is(await api('POST', '/auth/login', { body: { tenant: slug, login: who, password: PW } }), 200).token);
  return { id: Number(made.body.id), slug, login, token: await login(`gm@${slug}.test`) };
}
/** A report ready to sign off, with its lead responder (the same steps as a patroller at the bedside). */
async function patrolCase(M, token, staffId) {
  const day = todayIn('America/New_York');
  const c = ok(await api('POST', '/patrol/incidents', { token, body: { occurred_at: `${day}T08:15`, location: 'Ridge Run', category: 'injury', severity: 'moderate', summary: 'Knee injury' } }));
  const p = ok(await api('POST', `/patrol/incidents/${c.id}/patients`, { token, body: { form: { head_strike: 'no' }, first_name: 'Sam', last_name: 'Skier' } }));
  ok(await api('PATCH', `/patrol/incidents/${c.id}/patients/${p.id}`, { token, body: { chief_complaint: 'Left knee pain', disposition: 'treated_released' } }));
  ok(await api('POST', `/patrol/incidents/${c.id}/responders`, { token, body: { staff_id: staffId, role: 'lead' } }));
  return c.id;
}
/** An online lesson request waiting for an answer, and a rental reservation held for today (rows, as the public pages write them). */
async function skiWaiting(M, { requests = 0, pickups = 0, tomorrow = 0 } = {}) {
  if (!M.session) {
    M.product = ok(await api('POST', '/products', { token: M.token, body: { kind: 'lesson', name: 'Group Lesson', base_price_cents: 8000 } })).id;
    M.session = ok(await api('POST', '/skischool/sessions', { token: M.token, body: { product_id: M.product, starts_at: `${addDays(today, 3)}T10:00`, ends_at: `${addDays(today, 3)}T12:00` } })).id;
    M.guest = ok(await api('POST', '/people', { token: M.token, body: { first_name: 'Robin', last_name: 'Renter' } })).id;
  }
  for (let i = 0; i < requests; i += 1) {
    await pool.query("INSERT INTO lesson_requests (tenant_id, session_id, reference, contact_name, contact_email, contact_phone, students, waiver_accepted, status) VALUES (?, ?, ?, 'Pat Parent', 'pat@example.test', '6105550100', '[]', 1, 'pending')",
      [M.id, M.session, Math.random().toString(36).slice(2, 10).toUpperCase().padEnd(8, 'X')]);
  }
  const day = todayIn('America/New_York');
  for (let i = 0; i < pickups; i += 1) await pool.query("INSERT INTO rental_reservations (tenant_id, person_id, pickup_on, days, status) VALUES (?, ?, ?, 1, 'held')", [M.id, M.guest, day]);
  for (let i = 0; i < tomorrow; i += 1) await pool.query("INSERT INTO rental_reservations (tenant_id, person_id, pickup_on, days, status) VALUES (?, ?, ?, 1, 'held')", [M.id, M.guest, addDays(day, 1)]);
}

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await createMuniTenant(base, { slug: `nc-a-${suffix}`, name: `Counts Borough ${suffix}`, modules: { solidwaste: true, water: true } });
  B = await createMuniTenant(base, { slug: `nc-b-${suffix}`, name: `Other Borough ${suffix}` });
  await muniStart(A); await muniStart(B);
  staffA.luis = await person(A.token, 'Luis', 'Ortega');
  staffA.tom = await person(A.token, 'Tom', 'Kowalski');
  P.mgr = await A.addLogin('manager');
  P.luis = await A.addLogin('staff', { staff_id: staffA.luis });
  P.tom = await A.addLogin('staff', { staff_id: staffA.tom });
  P.loose = await A.addLogin('staff'); // a Crew login linked to nobody
  P.desk = await A.addLogin('counter');

  ski = await mountain(`nc-ski-${suffix}`, `Counts Peak ${suffix}`);
  other = await mountain(`nc-ski2-${suffix}`, `Other Peak ${suffix}`);
  T.owner = ski.token;
  for (const [key, first, role] of [['director', 'Dana', 'patrol'], ['pat', 'Pat', 'patrol'], ['counter', 'Cam', 'counter'], ['teacher', 'Ines', 'instructor'], ['liftie', 'Lee', 'staff']]) {
    S[key] = await person(ski.token, first, 'Ridge');
    U[key] = ok(await api('POST', '/users', { token: ski.token, body: { email: `${key}@${ski.slug}.test`, password: PW, role, staff_id: S[key] } })).id;
    T[key] = await ski.login(`${key}@${ski.slug}.test`);
  }
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

// ---------------------------------------------------------------- reachable, and empty when nothing waits
test('anyone signed in may ask, for either kind of tenant; nobody else', async () => {
  is(await api('GET', '/nav/counts'), 401);
  is(await api('GET', '/nav/new'), 401);
  for (const token of [A.token, P.mgr.token, P.luis.token, P.desk.token, T.owner, T.counter, T.pat, T.director, T.teacher]) {
    assert.deepEqual(await counts(token), {}, 'nothing waits yet, so no entry at all');
    assert.ok(Array.isArray(await newItems(token)));
  }
});

// ---------------------------------------------------------------- a municipality
test('a municipality: each count is the number on that person\'s Today card', async () => {
  // Three new requests (one taken by the front desk); one already has a work order, so it no longer waits.
  const first = await request(A); await request(A); await request(A, P.desk.token);
  const handled = await request(A);
  ok(await api('POST', `/requests/${handled}/work-order`, { token: A.token, body: {} }));
  // Work orders: two overdue for Luis, one overdue with nobody, one due today for Luis, one overdue but done.
  const late = addDays(today, -3);
  await workOrder(A.token, { title: 'Patch pothole on Main', assigned_staff_id: staffA.luis, due_date: late });
  const second = await workOrder(A.token, { title: 'Reset sign on Oak', assigned_staff_id: staffA.luis, due_date: addDays(today, -1) });
  await workOrder(A.token, { title: 'Clear inlet on Elm', due_date: late });
  await workOrder(A.token, { title: 'Sweep the lot', assigned_staff_id: staffA.luis, due_date: today });
  const done = await workOrder(A.token, { title: 'Old job', assigned_staff_id: staffA.tom, due_date: late });
  ok(await api('POST', `/ops/work-orders/${done}/status`, { token: A.token, body: { status: 'done', resolution: 'Finished last week' } }));

  for (const who of [A, P.mgr]) { // the owner and a manager
    const c = await counts(who.token);
    assert.deepEqual(Object.keys(c).sort(), ['requests', 'works']);
    assert.equal(c.requests.n, await card(who.token, '/requests/today', 'New requests'));
    assert.equal(c.requests.n, 3);
    assert.equal(c.requests.says, 'new'); assert.equal(c.requests.alert, undefined, 'a quiet count');
    assert.equal(c.works.n, await card(who.token, '/ops/work-orders/today', 'Overdue work orders'));
    assert.equal(c.works.n, 3, 'every overdue work order, whoever has it');
    assert.equal(c.works.says, 'overdue'); assert.equal(c.works.alert, true, 'overdue is red');
  }
  // The front desk: new requests, as on its Today; it cannot open Work orders, so no count for them.
  const desk = await counts(P.desk.token);
  assert.deepEqual(Object.keys(desk), ['requests']);
  assert.equal(desk.requests.n, await card(P.desk.token, '/requests/today', 'New requests'));
  is(await api('GET', '/ops/work-orders/today', { token: P.desk.token }), 403);
  // Crew: only their own overdue work, as My work today marks it. New requests wait on the desk, not on them.
  const luis = await counts(P.luis.token);
  assert.deepEqual(Object.keys(luis), ['works']);
  const myDay = is(await api('GET', '/workforce/my-day', { token: P.luis.token }), 200);
  assert.equal(luis.works.n, myDay.work.filter((w) => w.overdue).length);
  assert.equal(luis.works.n, 2, 'his two, not the unassigned one');
  assert.equal(luis.works.alert, true);

  // A count goes down as the work is done, and its entry goes when nothing is left.
  ok(await api('POST', `/ops/work-orders/${second}/status`, { token: P.luis.token, body: { status: 'done', resolution: 'Sign reset' } }));
  assert.equal((await counts(P.luis.token)).works.n, 1);
  assert.equal((await counts(P.mgr.token)).works.n, 2);
  ok(await api('POST', `/requests/${first}/close`, { token: P.desk.token, body: { reason: 'Not ours: a state road' } }));
  assert.equal((await counts(P.desk.token)).requests.n, 2);
  assert.equal((await counts(P.desk.token)).requests.n, await card(P.desk.token, '/requests/today', 'New requests'));
});

test('a crew member never gets a count from someone else\'s work, and one linked to nobody gets none', async () => {
  // Tom has nothing overdue (his one overdue job is done); Luis and the unassigned pile do.
  assert.deepEqual(await counts(P.tom.token), {}, 'no entry, not a zero');
  assert.deepEqual(await counts(P.loose.token), {});
  const mine = await workOrder(A.token, { title: 'Tom\'s hydrant', assigned_staff_id: staffA.tom, due_date: addDays(today, -2) });
  assert.equal((await counts(P.tom.token)).works.n, 1);
  assert.equal((await counts(P.luis.token)).works.n, 1, 'Luis\'s number did not move');
  // Handed to Luis: it leaves Tom's count and joins Luis's.
  ok(await api('PATCH', `/ops/work-orders/${mine}`, { token: A.token, body: { assigned_staff_id: staffA.luis } }));
  assert.deepEqual(await counts(P.tom.token), {});
  assert.equal((await counts(P.luis.token)).works.n, 2);
  assert.equal((await counts(P.luis.token)).works.n, is(await api('GET', '/workforce/my-day', { token: P.luis.token }), 200).work.filter((w) => w.overdue).length);
});

test('another municipality\'s rows never count', async () => {
  const before = await counts(P.mgr.token);
  for (let i = 0; i < 4; i += 1) await request(B);
  for (let i = 0; i < 5; i += 1) await workOrder(B.token, { title: `B job ${i}`, due_date: addDays(today, -9) });
  assert.deepEqual(await counts(P.mgr.token), before, 'A is as it was');
  const b = await counts(B.token);
  assert.equal(b.requests.n, 4); assert.equal(b.works.n, 5);
  assert.equal(b.requests.n, await card(B.token, '/requests/today', 'New requests'));
  assert.equal(b.works.n, await card(B.token, '/ops/work-orders/today', 'Overdue work orders'));
});

test('an app that is turned off gives no entry', async () => {
  await setModules(A.id, { requests: false });
  const c = await counts(P.mgr.token);
  assert.equal(c.requests, undefined, 'Resident requests is off');
  assert.ok(c.works, 'Work orders still counts');
  assert.deepEqual(await counts(P.desk.token), {});
  assert.ok(!(await newItems(P.mgr.token)).includes('request'));
  await setModules(A.id, { requests: true, assets: false });
  const d = await counts(P.mgr.token);
  assert.equal(d.works, undefined, 'Assets and fleet is off');
  assert.ok(d.requests);
  assert.deepEqual(await counts(P.luis.token), {});
  assert.ok(!(await newItems(P.luis.token)).includes('work_order'));
  await setModules(A.id, { assets: true });
  assert.ok((await counts(P.luis.token)).works);
});

// ---------------------------------------------------------------- a ski area
test('a ski area: lessons and rentals equal the Today tiles; only those who can act get them', async () => {
  await skiWaiting(ski, { requests: 2, pickups: 3, tomorrow: 1 });
  for (const token of [T.owner, T.counter]) {
    const c = await counts(token);
    const board = is(await api('GET', '/board', { token }), 200);
    assert.equal(c.school.n, board.data.lessons.pending_requests);
    assert.equal(c.school.n, 2); assert.equal(c.school.says, 'to answer');
    assert.equal(c.rentals.n, board.data.rentals.reservations_today);
    assert.equal(c.rentals.n, 3, 'today\'s pickups, not tomorrow\'s'); assert.equal(c.rentals.says, 'to hand out');
    assert.equal(c.shop, undefined, 'the Online shop has nothing that waits');
  }
  // An instructor sees the Lessons tile but cannot answer a request (the desk does), so nothing waits on them.
  is(await api('GET', '/skischool/requests', { token: T.teacher }), 403);
  assert.deepEqual(await counts(T.teacher), {});
  assert.deepEqual(await counts(T.liftie), {});
  // Answered or handed out: the number follows, and goes at zero.
  await pool.query("UPDATE lesson_requests SET status = 'declined' WHERE tenant_id = ?", [ski.id]);
  await pool.query("UPDATE rental_reservations SET status = 'picked_up' WHERE tenant_id = ? AND pickup_on = ? LIMIT 2", [ski.id, todayIn('America/New_York')]);
  const after = await counts(T.counter);
  assert.equal(after.school, undefined);
  assert.equal(after.rentals.n, 1);
  assert.equal(after.rentals.n, is(await api('GET', '/board', { token: T.counter }), 200).data.rentals.reservations_today);
});

test('patrol: my open cases for a patroller, the reports to review for whoever reviews', async () => {
  // With no review group, the people whose patrol level approves reports review them: the owner here.
  const c1 = await patrolCase(ski, T.pat, S.pat);
  let pat = await counts(T.pat);
  let home = is(await api('GET', '/patrol/home', { token: T.pat }), 200);
  assert.equal(pat.patrol.n, home.mine.length); assert.equal(pat.patrol.n, 1);
  assert.equal(pat.patrol.says, 'to sign off');
  assert.equal((await counts(T.owner)).patrol, undefined, 'a draft waits on its patroller, not on the owner');
  ok(await api('POST', `/patrol/incidents/${c1}/submit`, { token: T.pat }));
  assert.equal((await counts(T.pat)).patrol, undefined, 'signed off: it no longer waits on the patroller');
  let owner = await counts(T.owner);
  home = is(await api('GET', '/patrol/home', { token: T.owner }), 200);
  assert.equal(owner.patrol.n, home.waiting.length); assert.equal(owner.patrol.n, 1);
  assert.equal(owner.patrol.says, 'to review'); assert.equal(owner.patrol.alert, undefined);

  // A review group: the director reviews; the owner, who is not in it, no longer does.
  ok(await api('PUT', '/patrol/review/settings', { token: T.owner, body: { reviewers: [{ user_id: U.director, lead: true }], categories: ['injury', 'collision', 'medical'], nudge_hours: 72 } }));
  assert.equal((await counts(T.owner)).patrol, undefined);
  let dana = await counts(T.director);
  home = is(await api('GET', '/patrol/home', { token: T.director }), 200);
  assert.equal(home.can_approve, true);
  assert.equal(dana.patrol.n, home.mine.length + home.waiting.length); assert.equal(dana.patrol.n, 1);
  assert.equal(dana.patrol.says, 'to review');
  // The director's own case: a draft to sign off, then (signed off) someone else's to review, so not hers.
  const c2 = await patrolCase(ski, T.director, S.director);
  dana = await counts(T.director);
  home = is(await api('GET', '/patrol/home', { token: T.director }), 200);
  assert.equal(dana.patrol.n, home.mine.length + home.waiting.length); assert.equal(dana.patrol.n, 2);
  assert.equal(dana.patrol.says, 'to sign off or review');
  ok(await api('POST', `/patrol/incidents/${c2}/submit`, { token: T.director }));
  dana = await counts(T.director);
  home = is(await api('GET', '/patrol/home', { token: T.director }), 200);
  assert.equal(dana.patrol.n, home.waiting.length); assert.equal(dana.patrol.n, 1, 'nobody reviews their own report');
  // Red once a report has waited longer than Today's "Reviews overdue" allows (72 hours).
  await pool.query('UPDATE incidents SET submitted_at = DATE_SUB(submitted_at, INTERVAL 80 HOUR) WHERE tenant_id = ? AND id = ?', [ski.id, c1]);
  dana = await counts(T.director);
  assert.equal(dana.patrol.alert, true);
  assert.equal(is(await api('GET', '/patrol/doc-score?brief=1', { token: T.owner }), 200).reviews_overdue >= 1, true, 'Today says a review is overdue too');
  // The other people of the ski area have no Patrol count.
  for (const token of [T.counter, T.teacher, T.liftie]) assert.equal((await counts(token)).patrol, undefined);
  // Patrol turned off: no entry for anyone.
  await setModules(ski.id, { patrol: false });
  assert.equal((await counts(T.director)).patrol, undefined);
  assert.ok(!(await newItems(T.pat)).includes('incident'));
  await setModules(ski.id, { patrol: true });
  assert.equal((await counts(T.director)).patrol.n, 1);
});

test('a ski area gets no municipal counts, a municipality no ski ones, and another ski area\'s rows never count', async () => {
  // The ski area has overdue work orders of its own (Mountain status, Maintenance): Today there does not count them.
  await workOrder(T.owner, { title: 'Grease the bullwheel', due_date: addDays(today, -4) });
  const before = await counts(T.owner);
  for (const key of ['works', 'requests', 'conditions', 'assets']) assert.equal(before[key], undefined, key);
  const muni = await counts(P.mgr.token);
  for (const key of ['patrol', 'school', 'rentals', 'shop']) assert.equal(muni[key], undefined, key);
  // Another ski area with plenty waiting.
  await skiWaiting(other, { requests: 5, pickups: 6 });
  const theirs = await counts(other.token);
  assert.equal(theirs.school.n, 5); assert.equal(theirs.rentals.n, 6);
  assert.deepEqual(await counts(T.owner), before, 'this ski area is as it was');
});

// ---------------------------------------------------------------- + New
test('+ New for a municipality: what each person may create, and the server agrees', async () => {
  assert.deepEqual(await newItems(A.token), ['work_order', 'request', 'street_notice', 'bulk_booking', 'main_break', 'message']);
  assert.deepEqual(await newItems(P.mgr.token), ['work_order', 'request', 'street_notice', 'bulk_booking', 'main_break', 'message']);
  assert.deepEqual(await newItems(P.desk.token), ['request', 'bulk_booking']);
  assert.deepEqual(await newItems(P.luis.token), ['work_order', 'request', 'main_break']);
  // What is left out is what the server refuses.
  is(await api('POST', '/ops/work-orders', { token: P.desk.token, body: { title: 'Desk cannot' } }), 403);
  is(await api('POST', '/solid-waste/bookings', { token: P.luis.token, body: {} }), 403);
  is(await api('POST', '/water/main-breaks', { token: P.desk.token, body: {} }), 403);
  const notice = { type: 'street_closure', title: 'Main Street closed', sms_text: 'Main Street is closed today.', areas: [{ street_id: A.street }] };
  is(await api('POST', '/street-notices', { token: P.luis.token, body: notice }), 403, 'a crew member does not send notices');
  // A manager lets Luis send them: now + New offers it, and the server takes it.
  ok(await api('PUT', '/street-notices/settings', { token: A.token, body: { crew_senders: [P.luis.id] } }));
  assert.deepEqual(await newItems(P.luis.token), ['work_order', 'request', 'street_notice', 'main_break']);
  assert.ok(!(await newItems(P.tom.token)).includes('street_notice'), 'only the crew lead named');
  const made = await api('POST', '/street-notices', { token: P.luis.token, body: notice });
  assert.notEqual(made.status, 403, JSON.stringify(made.body));
  // An add-on that is off is not offered.
  await setModules(A.id, { water: false, solidwaste: false });
  assert.deepEqual(await newItems(P.mgr.token), ['work_order', 'request', 'street_notice', 'message']);
  await setModules(A.id, { water: true, solidwaste: true });
});

test('+ New for a ski area: by role and patrol access level', async () => {
  assert.deepEqual(await newItems(T.owner), ['sale', 'lesson', 'rental', 'incident', 'work_order', 'lost_item', 'customer', 'message', 'calendar_event']);
  assert.deepEqual(await newItems(T.counter), ['sale', 'lesson', 'rental', 'lost_item', 'customer']);
  assert.deepEqual(await newItems(T.pat), ['incident', 'work_order']);
  assert.deepEqual(await newItems(T.teacher), ['customer']);
  assert.deepEqual(await newItems(T.liftie), ['work_order', 'lost_item']);
  is(await api('POST', '/lost-found/items', { token: T.pat, body: {} }), 403);
  is(await api('POST', '/people', { token: T.liftie, body: { first_name: 'No', last_name: 'Way' } }), 403);
  is(await api('POST', '/calendar/events', { token: T.counter, body: { title: 'Race day', starts_on: today } }), 403);
  // A patroller whose access level cannot write cases (a Host) is not offered Incident.
  ok(await api('POST', '/patrol/team', { token: T.owner, body: { staff_id: S.pat, level: 'patroller', access_level: 'host' } }));
  const level = is(await api('GET', '/patrol/me', { token: T.pat }), 200);
  if (!level.features.includes('create_case')) assert.ok(!(await newItems(T.pat)).includes('incident'));
  else assert.fail(`expected a Host without create_case, got ${level.access_level}`);
  // No ski item reaches a municipality, and no municipal one a ski area.
  for (const id of ['sale', 'lesson', 'rental', 'incident', 'lost_item', 'customer', 'calendar_event']) assert.ok(!(await newItems(A.token)).includes(id), id);
  for (const id of ['request', 'street_notice', 'bulk_booking', 'main_break']) assert.ok(!(await newItems(T.owner)).includes(id), id);
  // Apps off: Sell off takes the sale, the lesson and the rental with it.
  await setModules(ski.id, { sell: false });
  assert.deepEqual(await newItems(T.counter), ['lost_item', 'customer']);
  await setModules(ski.id, { sell: true });
});

// ---------------------------------------------------------------- the client modules (jsdom; skipped when it is not installed)
// public/js/navcounts.js and public/js/newmenu.js against the real API, with a frame that only records what it is told
// (the real frame is another workstream's): what is drawn, what is cleared, how often the server is asked, and that
// each + New address opens its form and then takes ?new=1 off the address.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (_) { /* skipped below */ }
const noDom = () => !JSDOM && { skip: 'jsdom is not installed' };
let mods = null; let asked = []; let inflight = 0; let realFetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle() {
  let calm = 0;
  for (let i = 0; i < 300 && calm < 3; i += 1) { await sleep(15); calm = inflight === 0 && !document.querySelector('.loading') ? calm + 1 : 0; }
}
async function web() {
  if (mods) return mods;
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: `${base}/`, pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  for (const k of ['document', 'Node', 'HTMLElement', 'sessionStorage', 'localStorage', 'location', 'history', 'Event', 'CustomEvent', 'FormData']) Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: w, configurable: true, writable: true });
  realFetch = globalThis.fetch;
  globalThis.fetch = async (...a) => { inflight += 1; asked.push(String(a[0])); try { return await realFetch(...a); } finally { inflight -= 1; } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-navcounts-'));
  fs.cpSync(path.join(__dirname, '..', 'public', 'js'), path.join(tmp, 'js'), { recursive: true });
  fs.cpSync(path.join(__dirname, '..', 'public', 'vendor'), path.join(tmp, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  const imp = (f) => import(pathToFileURL(path.join(tmp, 'js', f)).href);
  mods = { api: await imp('api.js'), ui: await imp('ui.js'), counts: await imp('navcounts.js'), menu: await imp('newmenu.js'), view: (n) => imp(`views/${n}.js`) };
  mods.api.config.base = base;
  return mods;
}
/** Signs the page in as this person (their own /auth/me), at an address. */
async function as(token, hash = '#/') {
  const m = await web();
  m.ui.ctx.me = await (await realFetch(`${base}/api/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } })).json();
  m.ui.ctx.tz = m.ui.ctx.me.timezone;
  m.api.session.token = token;
  window.history.replaceState(null, '', hash);
  m.ui.newPage();
  for (const o of document.querySelectorAll('.overlay')) o.remove();
  return m;
}
/** A frame that records what the modules tell it. */
function fakeFrame() {
  const f = { badges: new Map(), calls: [], items: null, commands: [] };
  f.setBadge = (key, n, opts = {}) => { f.calls.push([key, n, opts]); if (n) f.badges.set(key, { n, ...opts }); else f.badges.delete(key); };
  f.setNew = (items) => { f.items = items; };
  f.addCommands = (fn) => { f.commands.push(fn); };
  return f;
}
const countAsks = () => asked.filter((u) => u.endsWith('/nav/counts')).length;

test('the counts module draws each count, clears one that went to zero, and asks no more often than it should', noDom(), async (t) => {
  const m = await as(P.luis.token);
  const frame = fakeFrame();
  const server = await counts(P.luis.token);
  asked = [];
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() }); // the clock only: the checks' own timers stay real and are never waited for
  m.counts.start(frame);
  await settle();
  assert.deepEqual(Object.fromEntries(frame.badges), { works: { n: server.works.n, says: 'overdue', alert: true } }, 'what the server said, with its words and its red');
  assert.equal(countAsks(), 1, 'asked once as the app opens');
  // The first page drawn as the app opens does not ask again, and neither does a burst of tab changes inside 10 seconds.
  for (let i = 0; i < 5; i += 1) window.dispatchEvent(new window.Event('nav:page'));
  t.mock.timers.tick(5000);
  for (let i = 0; i < 5; i += 1) window.dispatchEvent(new window.Event('nav:page'));
  await settle();
  assert.equal(countAsks(), 1, 'ten seconds have not passed');
  // The work is done meanwhile. After 10 seconds a page change asks again, and the count that went to zero is cleared.
  const mine = is(await api('GET', '/workforce/my-day', { token: P.luis.token }), 200).work.filter((w) => w.overdue);
  for (const w of mine) ok(await api('POST', `/ops/work-orders/${w.id}/status`, { token: P.luis.token, body: { status: 'done', resolution: 'Done' } }));
  t.mock.timers.tick(6000);
  window.dispatchEvent(new window.Event('nav:page'));
  await settle();
  assert.equal(countAsks(), 2);
  assert.equal(frame.badges.size, 0, 'cleared, not left at its old number');
  assert.deepEqual(frame.calls[frame.calls.length - 1].slice(0, 2), ['works', 0]);
  // A timed check is a poll: it does not count as someone using the app.
  assert.equal(typeof m.counts.refresh, 'function');
  // Inbox is never touched, and nothing is drawn after sign-out.
  m.counts.paint({ inbox: { n: 9, says: 'unread' }, requests: { n: 2, says: 'new' } });
  assert.deepEqual([...frame.badges.keys()], ['requests']);
  m.counts.stop();
  m.counts.paint({ works: { n: 4, says: 'overdue', alert: true } });
  assert.deepEqual([...frame.badges.keys()], ['requests'], 'a stopped module draws nothing');
});

test('the + New module: this person\'s items with their addresses, and a command for each', noDom(), async () => {
  const m = await as(P.luis.token);
  const frame = fakeFrame();
  await m.menu.start(frame);
  assert.deepEqual(frame.items, [
    { id: 'work_order', label: 'Work order', href: 'works?new=1', app: 'works', icon: 'works' },
    { id: 'request', label: 'Request', href: 'requests?new=1', app: 'requests', icon: 'requests' },
    { id: 'street_notice', label: 'Street notice', href: 'notices?new=1', app: 'notices', icon: 'notices' },
    { id: 'main_break', label: 'Main break', href: 'water?new=1', app: 'water', icon: 'water' },
  ]);
  const cmds = frame.commands[0]();
  assert.deepEqual(cmds.map((c) => c.title), ['New work order', 'New request', 'New street notice', 'New main break']);
  assert.ok(cmds.every((c) => c.id && c.icon && typeof c.run === 'function' && /new/.test(c.words)));
  cmds[1].run();
  assert.equal(window.location.hash, '#/requests?new=1');
  // The front desk: no Work order (it cannot open Work orders), no Street notice.
  const desk = fakeFrame();
  await (await as(P.desk.token)).menu.start(desk);
  assert.deepEqual(desk.items.map((i) => i.id), ['request', 'bulk_booking']);
  assert.equal(desk.items[1].href, 'bulk?tab=bookings&new=1');
  // A ski area's work order goes to Mountain status, Maintenance; its own items have their addresses.
  const owner = fakeFrame();
  await (await as(T.owner)).menu.start(owner);
  assert.deepEqual(owner.items.map((i) => [i.id, i.href]), [['sale', 'sell'], ['lesson', 'sell?tab=lessons'], ['rental', 'sell?tab=rentals'], ['incident', 'patrol/now?new=1'],
    ['work_order', 'conditions?tab=maint&new=1'], ['lost_item', 'lostfound?new=1'], ['customer', 'people?new=1'], ['message', 'messages?new=1'], ['calendar_event', 'calendar?new=1']]);
  // Someone who may create nothing gets an empty list, so the frame hides the button.
  const none = fakeFrame();
  m.ui.ctx.me = { ...m.ui.ctx.me, role: 'area' };
  await m.menu.start(none);
  assert.deepEqual(none.items, []);
});

test('?new=1 opens the form once and comes off the address; a page already on screen is told too', noDom(), async () => {
  const m = await as(P.mgr.token, '#/works?new=1');
  let opened = 0;
  const root = document.createElement('div');
  m.menu.whenNew(root, () => { opened += 1; });
  assert.equal(opened, 1, 'the address asked, so the form opens as the page draws');
  assert.equal(window.location.hash, '#/works', 'and a reload would not open it again');
  // Not on screen yet (the page is still drawing): a later ask is left to the page's own whenNew.
  window.location.hash = '#/works?new=1';
  await sleep(30);
  assert.equal(opened, 1);
  window.history.replaceState(null, '', '#/works');
  // On screen: + New on the page it belongs to opens the form again, and keeps the page's other filters.
  document.body.append(root);
  window.location.hash = '#/works?who=mine&new=1';
  await sleep(30);
  assert.equal(opened, 2);
  assert.equal(window.location.hash, '#/works?who=mine');
  // Another page's address is not this page's to open.
  window.location.hash = '#/requests?new=1';
  await sleep(30);
  assert.equal(opened, 2);
  assert.equal(window.location.hash, '#/requests?new=1', 'left for the page the router draws next');
  root.remove();
});

test('every + New address opens its form on the real screens', noDom(), async () => {
  const dialogTitle = () => { const o = document.querySelector('.overlay'); return o ? (o.querySelector('h2, h3') || o).textContent.trim() : null; };
  async function opens(token, href, name, params, want) {
    const m = await as(token, `#/${href}`);
    const holder = document.createElement('div');
    document.body.replaceChildren(holder);
    await (await m.view(name)).render(holder, params);
    await settle();
    assert.match(String(dialogTitle()), want, `${href} opens ${want}`);
    assert.ok(!/new=1/.test(window.location.hash), `${href}: the mark is off the address (${window.location.hash})`);
    assert.equal(holder.querySelector('.error-box'), null, `${href}: no error on the page`);
    for (const o of document.querySelectorAll('.overlay')) o.remove();
  }
  // A municipality, as a manager.
  await opens(P.mgr.token, 'works?new=1', 'works', [], /New work order/);
  await opens(P.mgr.token, 'requests?new=1', 'requests', [], /New request/);
  await opens(P.mgr.token, 'notices?new=1', 'street-notices', [], /notice/i);
  await opens(P.mgr.token, 'bulk?tab=bookings&new=1', 'bulk-pickup', [], /bulk pickup/i);
  await opens(P.mgr.token, 'water?new=1', 'water', [], /main break/i);
  await opens(P.mgr.token, 'messages?new=1', 'messages', [], /message/i);
  // A crew member who may not send notices: the address opens the page, never the form.
  const m = await as(P.tom.token, '#/notices?new=1');
  const holder = document.createElement('div');
  document.body.replaceChildren(holder);
  await (await m.view('street-notices')).render(holder, []);
  await settle();
  assert.equal(dialogTitle(), null, 'no form for someone who may not send a notice');
  // A ski area, as the owner.
  await opens(T.owner, 'conditions?tab=maint&new=1', 'conditions', [], /New work order/);
  await opens(T.owner, 'lostfound?new=1', 'lostfound', [], /found/i);
  await opens(T.owner, 'people?new=1', 'people', [], /Add a customer/);
  await opens(T.owner, 'messages?new=1', 'messages', [], /message/i);
  await opens(T.owner, 'calendar?new=1', 'calendar', [], /event/i);
  await opens(T.owner, 'patrol/now?new=1', 'patrol', ['now'], /case/i);
});
