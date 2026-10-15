'use strict';

// Staff and schedule: reading availability and position requirements before editing them (so saving never wipes them),
// editing shifts with every check run again, the candidate list, copying a week and week templates, Inbox notices when
// shifts are published or changed, a person leaving comes off future shifts, instructors' open dates count as
// availability, staffing needs count only filled shifts, and Hours: the week, fixing and adding punches, approval and
// the payroll export.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { todayIn, addDays, nowIn } = require('../src/lib/util');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';

async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);

const M = {};
// A Monday a few weeks ahead (shift times are local wall-clock, so far-future weeks keep the tests independent of today).
const monday = (() => { const d = addDays(todayIn('America/Denver'), 28); const wd = new Date(`${d}T00:00:00Z`).getUTCDay(); return addDays(d, -((wd + 6) % 7)); })();
const at = (dayOffset, hm) => `${addDays(monday, dayOffset)}T${hm}`;

async function person(first, last, extra = {}) {
  return Number(ok(await api('POST', '/workforce/staff', { token: M.owner, body: { person: { first_name: first, last_name: last }, status: 'active', ...extra } })).id);
}

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const slug = `sch-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Schedule Peak', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  M.owner = await login(`owner@${slug}.test`);
  M.id = Number((await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]))[0][0].id);
  M.cert = Number(ok(await api('POST', '/workforce/certifications', { token: M.owner, body: { name: 'Lift operations' } })).id);
  M.cert2 = Number(ok(await api('POST', '/workforce/certifications', { token: M.owner, body: { name: 'First aid' } })).id);
  M.lift = Number(ok(await api('POST', '/workforce/positions', { token: M.owner, body: { name: 'Lift operator', department: 'lifts', visits_per_staff: 100 } })).id);
  M.rent = Number(ok(await api('POST', '/workforce/positions', { token: M.owner, body: { name: 'Rental tech', department: 'rentals' } })).id);
  ok(await api('PUT', `/workforce/positions/${M.lift}/requirements`, { token: M.owner, body: { certification_ids: [M.cert] } }));
  M.ann = await person('Ann', 'Able');
  M.bob = await person('Bob', 'Baker');
  M.cy = await person('Cy', 'Cole');
  for (const s of [M.ann, M.bob]) ok(await api('PUT', `/workforce/staff/${s}/certifications`, { token: M.owner, body: { certification_id: M.cert } }));
  // Ann and Bob have logins, so they can be told about their shifts.
  for (const [who, sid] of [['ann', M.ann], ['bob', M.bob]]) {
    ok(await api('POST', '/users', { token: M.owner, body: { email: `${who}@${slug}.test`, password: PW, role: 'staff', staff_id: sid } }));
    M[`${who}T`] = await login(`${who}@${slug}.test`);
  }
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('availability and requirements are read back, so editing them starts from what is saved', async () => {
  const w = [{ weekday: 1, start_time: '07:00', end_time: '17:00' }, { weekday: 6, start_time: '08:00', end_time: '16:00' }];
  ok(await api('PUT', `/workforce/staff/${M.cy}/availability`, { token: M.owner, body: { windows: w } }));
  assert.deepEqual(ok(await api('GET', `/workforce/staff/${M.cy}/availability`, { token: M.owner })).windows, w);
  // a staff member reads their own, not someone else's
  ok(await api('PUT', `/workforce/staff/${M.ann}/availability`, { token: M.annT, body: { windows: [] } }));
  assert.deepEqual(ok(await api('GET', `/workforce/staff/${M.ann}/availability`, { token: M.annT })).windows, []);
  is(await api('GET', `/workforce/staff/${M.cy}/availability`, { token: M.annT }), 403);

  assert.deepEqual(ok(await api('GET', `/workforce/positions/${M.lift}/requirements`, { token: M.owner })).certification_ids, [M.cert]);
  const ov = ok(await api('GET', '/workforce/positions-overview', { token: M.owner })).data.find((p) => p.id === M.lift);
  assert.deepEqual(ov.requires.map((c) => c.name), ['Lift operations']);
});

test('a shift can be edited, every check runs again, and clashes say what they clash with', async () => {
  const a = ok(await api('POST', '/workforce/shifts', { token: M.owner, body: { position_id: M.lift, staff_id: M.ann, starts_at: at(0, '08:00'), ends_at: at(0, '16:00'), notes: 'Summit chair' } })).id;
  const b = ok(await api('POST', '/workforce/shifts', { token: M.owner, body: { position_id: M.rent, starts_at: at(0, '17:00'), ends_at: at(0, '21:00') } })).id;
  const clash = await api('PATCH', `/workforce/shifts/${b}`, { token: M.owner, body: { starts_at: at(0, '15:00'), staff_id: M.ann } });
  is(clash, 409);
  assert.match(JSON.stringify(clash.body), /Already on Lift operator 8:00 AM to 4:00 PM on/);
  // Cy has no lift certification: moving him onto a lift shift is refused
  is(await api('PATCH', `/workforce/shifts/${a}`, { token: M.owner, body: { staff_id: M.cy } }), 409);
  // a time change on the same person is fine and saved
  const after = ok(await api('PATCH', `/workforce/shifts/${a}`, { token: M.owner, body: { ends_at: at(0, '16:30'), notes: 'Summit chair, then sweep' } }));
  assert.equal(after.ends_at, `${addDays(monday, 0)} 16:30:00`);
  assert.equal(after.notes, 'Summit chair, then sweep');
  is(await api('PATCH', `/workforce/shifts/${a}`, { token: M.owner, body: { ends_at: at(0, '07:00') } }), 400, 'must end after it starts');
  is(await api('PATCH', `/workforce/shifts/${a}`, { token: M.owner, body: { ends_at: at(2, '07:00') } }), 400, 'at most 24 hours');
  M.shiftA = a; M.shiftB = b;
});

test('candidates: who can work it first, the reasons for everyone else, and hours booked', async () => {
  ok(await api('PUT', `/workforce/staff/${M.bob}/positions`, { token: M.owner, body: { position_ids: [M.lift] } }));
  const c = ok(await api('POST', '/workforce/shifts/candidates', { token: M.owner, body: { position_id: M.lift, starts_at: at(1, '08:00'), ends_at: at(1, '16:00') } })).data;
  assert.equal(c[0].name, 'Bob Baker', 'certified and trained for the position comes first');
  assert.ok(c[0].ok && c[0].trained);
  const ann = c.find((x) => x.name === 'Ann Able');
  assert.ok(ann.ok && !ann.trained);
  assert.equal(ann.week_minutes, 510, 'Ann already has 8.5 hours that week');
  const cy = c.find((x) => x.name === 'Cy Cole');
  assert.ok(!cy.ok);
  assert.ok(cy.problems.some((p) => /Lift operations/.test(p)));
  assert.ok(c.indexOf(cy) > c.indexOf(ann), 'blocked people come last');
  // availability alone is overridable
  const sat = ok(await api('POST', '/workforce/shifts/candidates', { token: M.owner, body: { position_id: M.rent, starts_at: at(5, '17:00'), ends_at: at(5, '20:00') } })).data.find((x) => x.name === 'Cy Cole');
  assert.equal(sat.overridable, true);
  assert.deepEqual(sat.problems, ['Outside their availability']);
});

test("an instructor's open date counts as availability (one roster)", async () => {
  // Saturday 17:00-20:00 is outside Cy's weekly pattern; marking the date open on Instructor availability makes it fine.
  ok(await api('POST', '/availability/windows', { token: M.owner, body: { staff_id: M.cy, dates: [addDays(monday, 5)], start_time: '16:00', end_time: '21:00' } }));
  const sat = ok(await api('POST', '/workforce/shifts/candidates', { token: M.owner, body: { position_id: M.rent, starts_at: at(5, '17:00'), ends_at: at(5, '20:00') } })).data.find((x) => x.name === 'Cy Cole');
  assert.equal(sat.ok, true);
});

test('copy a week and apply a template: drafts, people kept only where they can still work, no doubles', async () => {
  const next = addDays(monday, 7);
  const r = ok(await api('POST', '/workforce/shifts/copy', { token: M.owner, body: { from: monday, to: next } }));
  assert.equal(r.created, 2);
  const again = ok(await api('POST', '/workforce/shifts/copy', { token: M.owner, body: { from: monday, to: next } }));
  assert.equal(again.created, 0, 'copying twice adds nothing');
  assert.equal(again.skipped, 2);
  const copied = ok(await api('GET', `/workforce/shifts?from=${next}&to=${addDays(next, 6)}`, { token: M.owner })).data;
  assert.ok(copied.every((s) => s.status === 'draft'));
  assert.ok(copied.some((s) => s.staff_id === M.ann && s.notes === 'Summit chair, then sweep'));

  const tpl = ok(await api('POST', '/workforce/shift-templates', { token: M.owner, body: { name: 'Standard week', from: monday } })).id;
  assert.equal(ok(await api('GET', '/workforce/shift-templates', { token: M.owner })).data.find((x) => x.id === tpl).shifts, 2);
  // Ann leaves before week 3: the template still applies, her shift left unfilled
  const wk3 = addDays(monday, 14);
  await pool.query("INSERT INTO staff_certifications (tenant_id, staff_id, certification_id, expires_on) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE expires_on = VALUES(expires_on)", [M.id, M.ann, M.cert, addDays(wk3, -1)]);
  const applied = ok(await api('POST', `/workforce/shift-templates/${tpl}/apply`, { token: M.owner, body: { week: wk3 } }));
  assert.equal(applied.created, 2);
  assert.equal(applied.unfilled, 2, 'the lift shift lost Ann (expired cert) and the rental shift was open');
  assert.match(applied.left_open[0].reason, /Lift operations/);
  await pool.query('UPDATE staff_certifications SET expires_on = NULL WHERE tenant_id = ? AND staff_id = ?', [M.id, M.ann]);
  is(await api('POST', '/workforce/shifts/copy', { token: M.owner, body: { from: addDays(monday, 70), to: monday } }), 400, 'an empty week has nothing to copy');
});

async function inboxText(token) {
  const threads = ok(await api('GET', '/inbox/threads', { token })).data;
  const out = [];
  for (const t of threads) out.push(...ok(await api('GET', `/inbox/threads/${t.id}/messages`, { token })).data.map((m) => m.body));
  return out.join('\n');
}

test('publishing tells each person their shifts; changing or cancelling a published shift tells whoever it affects', async () => {
  const pub = ok(await api('POST', '/workforce/shifts/publish', { token: M.owner, body: { from: monday, to: addDays(monday, 6) } }));
  assert.equal(pub.published, 2);
  assert.equal(pub.notified, 1, 'Ann has a login and a shift; nobody else is on one');
  assert.match(await inboxText(M.annT), /Your schedule is published\. You are on 1 shift:\n- Lift operator 8:00 AM to 4:30 PM/);
  // swap Ann for Bob on the published shift
  ok(await api('PATCH', `/workforce/shifts/${M.shiftA}`, { token: M.owner, body: { staff_id: M.bob } }));
  assert.match(await inboxText(M.annT), /You are no longer on Lift operator/);
  assert.match(await inboxText(M.bobT), /You have a new shift: Lift operator 8:00 AM to 4:30 PM .*Note: Summit chair, then sweep/);
  ok(await api('PATCH', `/workforce/shifts/${M.shiftA}`, { token: M.owner, body: { starts_at: at(0, '09:00') } }));
  assert.match(await inboxText(M.bobT), /Your shift changed\. It was Lift operator 8:00 AM.*It is now Lift operator 9:00 AM/s);
  is(await api('DELETE', `/workforce/shifts/${M.shiftA}`, { token: M.owner }), 204);
  assert.match(await inboxText(M.bobT), /is cancelled/);
  is(await api('PATCH', `/workforce/shifts/${M.shiftA}`, { token: M.owner, body: { notes: 'x' } }), 409, 'a cancelled shift stays cancelled');
});

test('someone who stops working comes off future shifts, left unfilled, and is told', async () => {
  const wk3 = addDays(monday, 14);
  const lift = ok(await api('GET', `/workforce/shifts?from=${wk3}&to=${addDays(wk3, 6)}`, { token: M.owner })).data.find((s) => s.position_id === M.lift);
  ok(await api('PATCH', `/workforce/shifts/${lift.id}`, { token: M.owner, body: { staff_id: M.bob } }));
  const before = ok(await api('GET', `/workforce/staff/${M.bob}`, { token: M.owner }));
  assert.ok(before.future_shifts >= 1);
  assert.deepEqual(before.positions.map((p) => p.name), ['Lift operator']);
  assert.equal(before.login.email.startsWith('bob@'), true);
  const r = ok(await api('PATCH', `/workforce/staff/${M.bob}`, { token: M.owner, body: { status: 'inactive', phone: '555-0100', first_name: 'Robert' } }));
  assert.ok(r.unassigned >= 1);
  const after = ok(await api('GET', `/workforce/staff/${M.bob}`, { token: M.owner }));
  assert.equal(after.future_shifts, 0);
  assert.equal(after.first_name, 'Robert');
  assert.equal(after.phone, '555-0100');
  assert.equal(ok(await api('GET', `/workforce/shifts?from=${wk3}&to=${addDays(wk3, 6)}`, { token: M.owner })).data.find((s) => s.id === lift.id).staff_id, null);
  ok(await api('PATCH', `/workforce/staff/${M.bob}`, { token: M.owner, body: { status: 'active' } }));
  // search and position filter on the staff list
  assert.deepEqual(ok(await api('GET', '/workforce/staff?q=robert', { token: M.owner })).data.map((s) => s.id), [M.bob]);
  assert.deepEqual(ok(await api('GET', `/workforce/staff?position_id=${M.lift}`, { token: M.owner })).data.map((s) => s.id), [M.bob]);
  // a certification can be removed
  is(await api('DELETE', `/workforce/staff/${M.bob}/certifications/${M.cert}`, { token: M.owner }), 204);
  assert.equal(ok(await api('GET', `/workforce/staff/${M.bob}`, { token: M.owner })).certifications.length, 0);
  ok(await api('PUT', `/workforce/staff/${M.bob}/certifications`, { token: M.owner, body: { certification_id: M.cert } }));
});

test('staffing needs count only filled shifts and list empty ones apart', async () => {
  const wk3 = addDays(monday, 14);
  const r = ok(await api('GET', `/workforce/staffing-suggestion?date=${wk3}&forecast=250`, { token: M.owner }));
  const lift = r.data.find((p) => p.position_id === M.lift);
  assert.equal(lift.suggested, 3);
  assert.equal(lift.scheduled, 0);
  assert.equal(lift.unfilled, 1);
  assert.equal(lift.gap, 3);
  const auto = ok(await api('GET', `/workforce/staffing-suggestion?date=${wk3}`, { token: M.owner }));
  assert.equal(auto.basis, 'tickets_and_passes');
  assert.equal(auto.forecast_visits, auto.tickets + auto.pass_estimate);
});

test('Hours: the week, a missed clock-out fixed with a reason, a forgotten punch added, approval and export', async () => {
  const tz = 'America/Denver';
  await pool.query('UPDATE tenants SET timezone = ? WHERE id = ?', [tz, M.id]);
  // Ann clocks in from My shifts and forgets to clock out; the punch is 20 hours old
  ok(await api('POST', '/workforce/time/clock-in', { token: M.annT }));
  await pool.query('UPDATE time_entries SET clock_in = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 HOUR) WHERE tenant_id = ? AND staff_id = ? AND clock_out IS NULL', [M.id, M.ann]);
  const today = todayIn(tz);
  const week = (() => { const wd = new Date(`${today}T00:00:00Z`).getUTCDay(); return addDays(today, -((wd + 6) % 7)); })();
  let w = ok(await api('GET', `/workforce/time/week?start=${today}`, { token: M.owner }));
  assert.equal(w.start, week);
  let ann = w.data.find((p) => p.staff_id === M.ann);
  // the punch may have started in last week if today is Monday morning; only check it when it is in this week
  if (ann) {
    assert.ok(ann.entries[0].flags.includes('missed_clock_out'));
    assert.equal(ann.needs_attention, true);
    // approval skips her while she is still clocked in
    ok(await api('POST', '/workforce/time/approve', { token: M.owner, body: { start: week } }));
    w = ok(await api('GET', `/workforce/time/week?start=${week}`, { token: M.owner }));
    assert.equal(w.data.find((p) => p.staff_id === M.ann).approved, false);
  }
  const open = (await pool.query('SELECT id, clock_in FROM time_entries WHERE tenant_id = ? AND staff_id = ? AND clock_out IS NULL', [M.id, M.ann]))[0][0];
  const inLocal = require('../src/lib/util').localTime(open.clock_in, tz).replace(' ', 'T').slice(0, 16);
  const outLocal = new Date(Date.parse(`${inLocal}:00Z`) + 8 * 3600_000).toISOString().slice(0, 16);
  is(await api('PATCH', `/workforce/time/entries/${open.id}`, { token: M.owner, body: { clock_out: `${outLocal}` } }), 400, 'a reason is required');
  ok(await api('PATCH', `/workforce/time/entries/${open.id}`, { token: M.owner, body: { clock_out: outLocal, note: 'Forgot to clock out, left at close' } }));
  const fixed = (await pool.query('SELECT clock_in, clock_out, edit_note, out_method FROM time_entries WHERE id = ?', [open.id]))[0][0];
  assert.ok(Math.abs(require('../src/lib/shifts').minutesBetween(fixed.clock_in, fixed.clock_out) - 480) <= 1, 'local times are saved as the right UTC times');
  assert.equal(fixed.out_method, 'manager');
  // a forgotten punch, and one that overlaps is refused
  const d = addDays(today, -3);
  const added = ok(await api('POST', '/workforce/time/entries', { token: M.owner, body: { staff_id: M.cy, clock_in: `${d}T08:00`, clock_out: `${d}T12:00`, note: 'Kiosk was down' } }));
  is(await api('POST', '/workforce/time/entries', { token: M.owner, body: { staff_id: M.cy, clock_in: `${d}T11:00`, clock_out: `${d}T13:00`, note: 'Kiosk was down' } }), 409);
  is(await api('POST', '/workforce/time/entries', { token: M.owner, body: { staff_id: M.cy, clock_in: `${addDays(today, 2)}T08:00`, clock_out: `${addDays(today, 2)}T12:00`, note: 'future' } }), 400);
  const dWeek = (() => { const wd = new Date(`${d}T00:00:00Z`).getUTCDay(); return addDays(d, -((wd + 6) % 7)); })();
  ok(await api('POST', '/workforce/time/approve', { token: M.owner, body: { start: dWeek } }));
  const cy = ok(await api('GET', `/workforce/time/week?start=${dWeek}`, { token: M.owner })).data.find((p) => p.staff_id === M.cy);
  assert.equal(cy.worked_minutes, 240);
  assert.equal(cy.approved, true);
  // editing an approved punch undoes approval
  ok(await api('PATCH', `/workforce/time/entries/${added.id}`, { token: M.owner, body: { clock_out: `${d}T12:30`, note: 'Stayed to finish' } }));
  assert.equal(ok(await api('GET', `/workforce/time/week?start=${dWeek}`, { token: M.owner })).data.find((p) => p.staff_id === M.cy).approved, false);
  // export: one row per person, hours in decimals; detail has one row per punch
  const csv = await api('GET', `/workforce/time/export?start=${dWeek}`, { token: M.owner });
  assert.equal(csv.status, 200);
  assert.match(csv.text, /^name,staff_id,week_starting,scheduled_hours,worked_hours,regular_hours,overtime_hours,approved/);
  assert.match(csv.text, /"Cy Cole","\d+","\d{4}-\d{2}-\d{2}","[\d.]+","4\.50","4\.50","0\.00","no"/);
  const detail = await api('GET', `/workforce/time/export?start=${dWeek}&detail=1`, { token: M.owner });
  assert.match(detail.text, /Stayed to finish/);
  // remove a punch made in error, with a reason
  is(await api('DELETE', `/workforce/time/entries/${added.id}`, { token: M.owner, body: { note: 'Wrong person' } }), 204);
  is(await api('GET', `/workforce/time/week?start=${dWeek}`, { token: M.annT }), 403, 'managers only');
});

test('overtime is time over 40 hours in the week', async () => {
  const tz = 'America/Denver';
  const base0 = addDays(todayIn(tz), -21);
  const wk = (() => { const wd = new Date(`${base0}T00:00:00Z`).getUTCDay(); return addDays(base0, -((wd + 6) % 7)); })();
  for (let i = 0; i < 5; i += 1) ok(await api('POST', '/workforce/time/entries', { token: M.owner, body: { staff_id: M.ann, clock_in: `${addDays(wk, i)}T07:00`, clock_out: `${addDays(wk, i)}T16:30`, note: 'Backfill from paper sheet' } }));
  const ann = ok(await api('GET', `/workforce/time/week?start=${wk}`, { token: M.owner })).data.find((p) => p.staff_id === M.ann);
  assert.equal(ann.worked_minutes, 5 * 570);
  assert.equal(ann.overtime_minutes, 5 * 570 - 2400);
  assert.equal(ann.regular_minutes, 2400);
});

test('clocking in from My shifts links the punch to the shift it is for', async () => {
  const tz = 'America/Denver';
  const now = nowIn(tz);
  const start = new Date(Date.parse(`${now.replace(' ', 'T')}Z`) - 30 * 60000).toISOString().slice(0, 16);
  const end = new Date(Date.parse(`${now.replace(' ', 'T')}Z`) + 6 * 3600000).toISOString().slice(0, 16);
  const id = ok(await api('POST', '/workforce/shifts', { token: M.owner, body: { position_id: M.rent, staff_id: M.cy, starts_at: start, ends_at: end, override_availability: true } })).id;
  ok(await api('POST', '/workforce/shifts/publish', { token: M.owner, body: { from: start.slice(0, 10), to: start.slice(0, 10) } }));
  ok(await api('POST', '/workforce/time/clock-in', { token: M.owner, body: { staff_id: M.cy } }));
  const e = (await pool.query('SELECT shift_id FROM time_entries WHERE tenant_id = ? AND staff_id = ? AND clock_out IS NULL', [M.id, M.cy]))[0][0];
  assert.equal(Number(e.shift_id), id);
  ok(await api('POST', '/workforce/time/clock-out', { token: M.owner, body: { staff_id: M.cy } }));
});

test('templates and hours stay inside their mountain', async () => {
  const slug = `sch2-${suffix}`;
  await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Other Peak', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'O', last_name: 'P' } }) });
  const other = (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token;
  const tpl = ok(await api('GET', '/workforce/shift-templates', { token: M.owner })).data[0];
  is(await api('POST', `/workforce/shift-templates/${tpl.id}/apply`, { token: other, body: { week: monday } }), 404);
  assert.equal(ok(await api('GET', '/workforce/shift-templates', { token: other })).data.length, 0);
  is(await api('GET', `/workforce/staff/${M.ann}`, { token: other }), 404);
  is(await api('GET', `/workforce/shifts/${M.shiftB}/candidates`, { token: other }), 404);
  const entry = (await pool.query('SELECT id FROM time_entries WHERE tenant_id = ? LIMIT 1', [M.id]))[0][0];
  is(await api('PATCH', `/workforce/time/entries/${entry.id}`, { token: other, body: { clock_out: null, note: 'not mine' } }), 404);
});
