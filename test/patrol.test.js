'use strict';

// Ski patrol: patient care reports (draft -> submitted -> approved), signatures, analytics, exports,
// and team management (roster, deployment, equipment, training).
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server;
let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r, status) => { assert.equal(r.status, status ?? (r.status < 300 ? r.status : -1), JSON.stringify(r.body)); return r.body; };

const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);

async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const l = await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } });
  return { slug, owner: l.body.token };
}
async function addUser(m, email, role, extra = {}) {
  ok(await api('POST', '/users', { token: m.owner, body: { email, password: PW, role, ...extra } }), 201);
  return (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token;
}

let A; let B;
const T = {}; const D = {};

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`pa-${suffix}`);
  B = await mountain(`pb-${suffix}`);
  const o = A.owner;
  const staff = async (first) => ok(await api('POST', '/workforce/staff', { token: o, body: { person: { first_name: first, last_name: 'Patroller' }, status: 'active' } }), 201).id;
  D.s1 = await staff('Pat'); D.s2 = await staff('Quinn'); D.s3 = await staff('Riley');
  D.inactive = ok(await api('POST', '/workforce/staff', { token: o, body: { person: { first_name: 'Old', last_name: 'Timer' }, status: 'inactive' } }), 201).id;
  T.pat = await addUser(A, `pat@${A.slug}.test`, 'patrol', { staff_id: D.s1 });
  T.quinn = await addUser(A, `quinn@${A.slug}.test`, 'patrol', { staff_id: D.s2 });
  T.unlinked = await addUser(A, `unlinked@${A.slug}.test`, 'patrol');
  T.counter = await addUser(A, `counter@${A.slug}.test`, 'counter');
  T.otherPat = await addUser(B, `pat@${B.slug}.test`, 'patrol');
  D.trail = ok(await api('POST', '/schedule/trails', { token: o, body: { name: 'Ridge Run', difficulty: 'blue' } }), 201).id;
  D.ann = ok(await api('POST', '/people', { token: o, body: { first_name: 'Ann', last_name: 'Guest', phone: '555-0100', date_of_birth: '1990-05-01' } }), 201).id;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

const newCase = (token, over = {}) => api('POST', '/patrol/incidents', { token, body: { occurred_at: `${today}T10:15`, location: 'Upper Ridge', category: 'injury', severity: 'moderate', summary: 'Wrist injury', trail_id: D.trail, ...over } });

test('a case gets a season case number, and the filer becomes the lead', async () => {
  const c = ok(await newCase(T.pat), 201);
  assert.match(c.case_number, /^\d{4}-\d{2}-\d{4}$/);
  assert.equal(c.report_state, 'draft');
  const d = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat }));
  assert.equal(d.case_number, c.case_number);
  assert.equal(d.trail, 'Ridge Run');
  assert.deepEqual(d.responders.map((r) => [r.staff_id, r.role]), [[D.s1, 'lead']]);

  // five filed at once all get different numbers
  const many = await Promise.all([1, 2, 3, 4, 5].map(() => newCase(T.pat)));
  assert.ok(many.every((r) => r.status === 201), JSON.stringify(many.map((r) => r.body)));
  assert.equal(new Set(many.map((r) => r.body.case_number)).size, 5);
});

test('the form works out what it can: age, run classification, summary and collision', async () => {
  const c = ok(await newCase(T.pat, { summary: 'Injury at Upper Ridge' }), 201);
  const d = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat }));
  assert.equal(d.form.run_classification, 'more_difficult', 'a blue trail is "more difficult"');
  const p = ok(await api('POST', `/patrol/incidents/${c.id}/patients`, { token: T.pat, body: { first_name: 'Ana', last_name: 'Lee', date_of_birth: '2000-01-01', chief_complaint: 'Pain in right ankle' } }), 201);
  let got = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat }));
  assert.ok(got.patients[0].age_years >= 20, 'age comes from the date of birth');
  assert.equal(got.summary, 'Pain in right ankle', 'the chief complaint replaces the automatic summary');
  ok(await api('PATCH', `/patrol/incidents/${c.id}/patients/${p.id}`, { token: T.pat, body: { chief_complaint: 'Right ankle sprain' } }));
  got = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat }));
  assert.equal(got.summary, 'Right ankle sprain', 'a summary copied from the complaint follows it');
  // a summary someone typed is never replaced
  const typed = ok(await newCase(T.pat, { summary: 'Skier down near the lift' }), 201);
  ok(await api('POST', `/patrol/incidents/${typed.id}/patients`, { token: T.pat, body: { first_name: 'Bo', last_name: 'Ng', chief_complaint: 'Knee pain' } }), 201);
  assert.equal(ok(await api('GET', `/patrol/incidents/${typed.id}`, { token: T.pat })).summary, 'Skier down near the lift');
  // a collision case starts its patients with the collision question answered
  const col = ok(await newCase(T.pat, { category: 'collision' }), 201);
  ok(await api('POST', `/patrol/incidents/${col.id}/patients`, { token: T.pat, body: { first_name: 'Cy', last_name: 'Ox' } }), 201);
  assert.equal(ok(await api('GET', `/patrol/incidents/${col.id}`, { token: T.pat })).patients[0].form.collided, 'yes');
});

test('full report: patient, vitals, injuries, treatments, timeline, responders', async () => {
  const c = ok(await newCase(T.pat, { summary: 'Skier down on Ridge Run' }), 201);
  const id = c.id;
  const p = ok(await api('POST', `/patrol/incidents/${id}/patients`, { token: T.pat, body: { person_id: D.ann, activity: 'ski', ability: 'intermediate', helmet: 'yes', age_years: 35 } }), 201);
  const detail = async () => ok(await api('GET', `/patrol/incidents/${id}`, { token: T.pat }));
  let d = await detail();
  assert.equal(d.patients[0].first_name, 'Ann', 'name filled from the person record');
  assert.equal(d.patients[0].phone, '555-0100');

  // vitals need a measurement; two sets are kept in order
  assert.equal((await api('POST', `/patrol/incidents/${id}/patients/${p.id}/vitals`, { token: T.pat, body: { notes: 'nothing measured' } })).status, 400);
  ok(await api('POST', `/patrol/incidents/${id}/patients/${p.id}/vitals`, { token: T.pat, body: { taken_at: `${today}T10:20`, pulse: 96, resp: 18, bp_sys: 128, bp_dia: 82, spo2: 98, gcs: 15, pain: 6, avpu: 'alert' } }), 201);
  ok(await api('POST', `/patrol/incidents/${id}/patients/${p.id}/vitals`, { token: T.pat, body: { taken_at: `${today}T10:35`, pulse: 84, pain: 4 } }), 201);
  assert.equal((await api('POST', `/patrol/incidents/${id}/patients/${p.id}/vitals`, { token: T.pat, body: { pulse: 900 } })).status, 400, 'impossible pulse');

  ok(await api('POST', `/patrol/incidents/${id}/patients/${p.id}/injuries`, { token: T.pat, body: { body_region: 'wrist_hand', side: 'left', injury_type: 'fracture' } }), 201);
  assert.equal((await api('POST', `/patrol/incidents/${id}/patients/${p.id}/treatments`, { token: T.pat, body: { kind: 'medication', medication: 'Ibuprofen' } })).status, 400, 'a medication needs a dose');
  ok(await api('POST', `/patrol/incidents/${id}/patients/${p.id}/treatments`, { token: T.pat, body: { kind: 'medication', medication: 'Ibuprofen', dose: '400 mg', route: 'oral' } }), 201);
  ok(await api('POST', `/patrol/incidents/${id}/patients/${p.id}/treatments`, { token: T.pat, body: { kind: 'splint', description: 'SAM splint left wrist' } }), 201);

  // timeline: times default to now when omitted, and come back in time order (earlier times are set yesterday so the test does not depend on the hour it runs)
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 864e5).toISOString().slice(0, 10);
  ok(await api('POST', `/patrol/incidents/${id}/events`, { token: T.pat, body: { kind: 'on_scene', at: `${yesterday}T10:18` } }), 201);
  ok(await api('POST', `/patrol/incidents/${id}/events`, { token: T.pat, body: { kind: 'call_received', at: `${yesterday}T10:15` } }), 201);
  ok(await api('POST', `/patrol/incidents/${id}/events`, { token: T.pat, body: { kind: 'at_aid_room', at: `${yesterday}T10:40` } }), 201);
  ok(await api('POST', `/patrol/incidents/${id}/events`, { token: T.pat, body: { kind: 'cleared' } }), 201);

  // naming a new lead demotes the old one
  ok(await api('POST', `/patrol/incidents/${id}/responders`, { token: T.pat, body: { staff_id: D.s2, role: 'lead' } }), 201);
  d = await detail();
  assert.deepEqual(d.events.map((e) => e.kind).slice(0, 3), ['call_received', 'on_scene', 'at_aid_room']);
  assert.ok(d.events.find((e) => e.kind === 'cleared').at, 'default time filled in');
  assert.equal(d.responders.filter((r) => r.role === 'lead').length, 1);
  assert.equal(d.responders[0].staff_id, D.s2);
  assert.equal(d.patients[0].vitals.length, 2);
  assert.equal(d.patients[0].vitals[0].pulse, 96);
  assert.equal(d.patients[0].injuries[0].injury_type, 'fracture');
  assert.equal(d.patients[0].treatments.length, 2);

  // a wrong entry is marked entered in error with a reason, never deleted
  const ev = d.events.find((e) => e.kind === 'cleared');
  assert.equal((await api('DELETE', `/patrol/incidents/${id}/events/${ev.id}`, { token: T.pat })).status, 404, 'there is no delete');
  assert.equal((await api('POST', `/patrol/incidents/${id}/events/${ev.id}/void`, { token: T.pat, body: {} })).status, 400, 'a reason is needed');
  ok(await api('POST', `/patrol/incidents/${id}/events/${ev.id}/void`, { token: T.pat, body: { reason: 'Stamped too early' } }));
  assert.equal((await api('POST', `/patrol/incidents/${id}/events/${ev.id}/void`, { token: T.pat, body: { reason: 'again' } })).status, 409);
  const after = ok(await api('GET', `/patrol/incidents/${id}`, { token: T.pat })).events.find((e) => e.id === ev.id);
  assert.equal(after.void_reason, 'Stamped too early');
  assert.ok(after.voided_at && after.voided_by_email, 'it stays on the record, with who and when');
  D.fullCase = id; D.fullPatient = p.id;
});

test('sign-off: submit lists what is missing, managers approve, approved reports are locked', async () => {
  const c = ok(await newCase(T.pat, { summary: 'Knee injury' }), 201);
  const id = c.id;

  const none = await api('POST', `/patrol/incidents/${id}/submit`, { token: T.pat });
  assert.equal(none.status, 409);
  assert.ok(none.body.details.some((x) => /at least one patient/i.test(x.message)));

  const p = ok(await api('POST', `/patrol/incidents/${id}/patients`, { token: T.pat, body: { first_name: 'Sam', last_name: 'Skier' } }), 201);
  const gaps = await api('POST', `/patrol/incidents/${id}/submit`, { token: T.pat });
  assert.ok(gaps.body.details.some((x) => /chief complaint/i.test(x.message)));
  assert.ok(gaps.body.details.some((x) => /outcome/i.test(x.message)));
  // every item says where it lives, so the screen can link to it
  const cc = gaps.body.details.find((x) => /chief complaint/i.test(x.message));
  assert.equal(cc.scope, 'patient');
  assert.equal(cc.field, 'chief_complaint');
  assert.ok(cc.section && cc.patient_id, JSON.stringify(cc));
  assert.equal(none.body.details.find((x) => /at least one patient/i.test(x.message)).area, 'patients');

  ok(await api('PATCH', `/patrol/incidents/${id}/patients/${p.id}`, { token: T.pat, body: { chief_complaint: 'Left knee pain', disposition: 'treated_released' } }));
  ok(await api('POST', `/patrol/incidents/${id}/submit`, { token: T.pat }));

  // submitted: patrollers wait, managers may still edit, only managers approve
  assert.equal((await api('PATCH', `/patrol/incidents/${id}/patients/${p.id}`, { token: T.pat, body: { assessment: 'late edit' } })).status, 409);
  assert.equal((await api('PATCH', `/patrol/incidents/${id}/patients/${p.id}`, { token: A.owner, body: { assessment: 'Swelling, stable' } })).status, 200);
  assert.equal((await api('POST', `/patrol/incidents/${id}/approve`, { token: T.pat })).status, 403);
  assert.equal((await api('POST', `/patrol/incidents/${id}/reopen`, { token: A.owner, body: { reason: '' } })).status, 400);
  ok(await api('POST', `/patrol/incidents/${id}/reopen`, { token: A.owner, body: { reason: 'Add the treatment times' } }));
  assert.equal((await api('PATCH', `/patrol/incidents/${id}/patients/${p.id}`, { token: T.pat, body: { assessment: 'Swelling, stable, ice applied' } })).status, 200, 'sent back, so editable again');
  ok(await api('POST', `/patrol/incidents/${id}/submit`, { token: T.pat }));
  ok(await api('POST', `/patrol/incidents/${id}/approve`, { token: A.owner }));

  const locked = await api('GET', `/patrol/incidents/${id}`, { token: T.pat });
  assert.equal(locked.body.report_state, 'approved');
  assert.equal(locked.body.status, 'closed');
  assert.ok(locked.body.approved_at);
  for (const [method, path, body] of [
    ['PATCH', `/patrol/incidents/${id}`, { summary: 'changed' }],
    ['POST', `/patrol/incidents/${id}/patients`, { first_name: 'X', last_name: 'Y' }],
    ['PATCH', `/patrol/incidents/${id}/patients/${p.id}`, { chief_complaint: 'changed' }],
    ['POST', `/patrol/incidents/${id}/patients/${p.id}/vitals`, { pulse: 80 }],
    ['POST', `/patrol/incidents/${id}/events`, { kind: 'cleared' }],
    ['POST', `/patrol/incidents/${id}/witnesses`, { name: 'Late Witness' }],
    ['POST', `/patrol/incidents/${id}/responders`, { staff_id: D.s2 }],
    ['POST', `/patrol/incidents/${id}/patients/${p.id}/void`, { reason: 'wrong patient' }],
  ]) {
    for (const token of [T.pat, A.owner]) assert.equal((await api(method, path, { token, body })).status, 409, `${method} ${path}`);
  }
  // notes are still allowed, as the record of corrections
  assert.equal((await api('POST', `/patrol/incidents/${id}/notes`, { token: T.pat, body: { body: 'Addendum: patient called next day, doing well.' } })).status, 201);

  // a manager can reopen; the reason is written into the record
  ok(await api('POST', `/patrol/incidents/${id}/reopen`, { token: A.owner, body: { reason: 'Wrong disposition' } }));
  const reopened = (await api('GET', `/patrol/incidents/${id}`, { token: T.pat })).body;
  assert.equal(reopened.report_state, 'draft');
  assert.equal(reopened.status, 'open');
  assert.ok(reopened.notes.some((n) => /Wrong disposition/.test(n.body)));
});

test('refusal of care needs a signature, and signatures cannot be removed', async () => {
  const c = ok(await newCase(T.pat, { summary: 'Refused transport' }), 201);
  const id = c.id;
  const p = ok(await api('POST', `/patrol/incidents/${id}/patients`, { token: T.pat, body: { first_name: 'Rae', last_name: 'Refuser', chief_complaint: 'Head bump', disposition: 'refused_care' } }), 201);
  const gaps = await api('POST', `/patrol/incidents/${id}/submit`, { token: T.pat });
  assert.ok(gaps.body.details.some((x) => /refusal signature/i.test(x.message)), JSON.stringify(gaps.body));

  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const sign = (body) => api('POST', `/patrol/incidents/${id}/signatures`, { token: T.pat, body });
  assert.equal((await sign({ kind: 'refusal_of_care', signer_name: 'Rae Refuser', patient_id: p.id, image: 'not an image' })).status, 400);
  assert.equal((await sign({ kind: 'refusal_of_care', signer_name: 'Rae Refuser', patient_id: p.id, image: `data:image/png;base64,${'A'.repeat(95_000)}` })).status, 400, 'too large');
  assert.equal((await sign({ kind: 'refusal_of_care', signer_name: 'Rae Refuser', patient_id: 999999, image: png })).status, 404);
  const s = ok(await sign({ kind: 'refusal_of_care', signer_name: 'Rae Refuser', patient_id: p.id, image: png }), 201);

  const d = ok(await api('GET', `/patrol/incidents/${id}`, { token: T.pat }));
  assert.equal(d.signatures.length, 1);
  assert.equal(d.signatures[0].image, undefined, 'the case view does not carry signature images');
  const one = ok(await api('GET', `/patrol/incidents/${id}/signatures/${s.id}`, { token: T.pat }));
  assert.equal(one.image, png);

  assert.equal((await api('DELETE', `/patrol/incidents/${id}/patients/${p.id}`, { token: T.pat })).status, 404, 'patients are never deleted');
  assert.equal((await api('DELETE', `/patrol/incidents/${id}/signatures/${s.id}`, { token: T.pat })).status, 404, 'there is no way to delete a signature');

  ok(await api('POST', `/patrol/incidents/${id}/submit`, { token: T.pat }));
  const [views] = await pool.query("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'incidents' AND entity_id = ? AND action IN ('view', 'view_signature')", [id]);
  assert.equal(views[0].n, 2, 'reading the case and the signature were both logged');
});

test('other mountains and other roles cannot reach a case', async () => {
  const id = D.fullCase;
  assert.equal((await api('GET', `/patrol/incidents/${id}`, { token: T.otherPat })).status, 404);
  assert.equal((await api('POST', `/patrol/incidents/${id}/patients`, { token: T.otherPat, body: { first_name: 'A', last_name: 'B' } })).status, 404);
  assert.equal((await api('POST', `/patrol/incidents/${id}/events`, { token: T.otherPat, body: { kind: 'cleared' } })).status, 404);
  assert.equal((await api('POST', `/patrol/incidents/${id}/submit`, { token: T.otherPat })).status, 404);
  for (const [m, p] of [['GET', '/patrol/incidents'], ['GET', '/patrol/analytics'], ['GET', '/patrol/team'], ['GET', '/patrol/equipment'], ['GET', '/patrol/deployments'], ['GET', '/patrol/training']]) {
    assert.equal((await api(m, p, { token: T.counter })).status, 403, `${m} ${p}`);
  }
  // a staff member from another mountain cannot be named as a responder
  assert.equal((await api('POST', `/patrol/incidents/${id}/responders`, { token: T.pat, body: { staff_id: 999999 } })).status, 404);
});

test('analytics and exports reflect the cases and keep names out', async () => {
  assert.equal((await api('GET', '/patrol/analytics', { token: T.quinn })).status, 403, 'a plain Patrol level has no reports by default');
  const a = ok(await api('GET', '/patrol/analytics', { token: A.owner }));
  assert.ok(a.cases >= 8);
  assert.ok(a.patients >= 3);
  assert.ok(a.by_category.find((x) => x.label === 'injury').n >= 1);
  assert.ok(a.injuries_by_region.find((x) => x.label === 'wrist_hand'));
  assert.ok(a.injuries_by_type.find((x) => x.label === 'fracture'));
  assert.ok(a.patients_by_activity.find((x) => x.label === 'ski'));
  assert.equal(a.helmet_use_on_snow.find((x) => x.label === 'yes').n, 1);
  assert.ok(a.top_places.find((x) => x.label === 'Ridge Run'));
  assert.equal(a.response_times.timed_cases, 1);
  assert.equal(a.response_times.call_to_scene_min, 3);
  assert.equal(a.response_times.scene_to_aid_room_min, 22);
  assert.ok(a.cases_by_lead.length >= 1);
  assert.equal((await api('GET', '/patrol/analytics?from=nope', { token: A.owner })).status, 400);

  assert.equal((await api('GET', '/patrol/patients.csv', { token: T.pat })).status, 403, 'exports need the reports feature, which a plain Patrol level does not have');
  const csv = await api('GET', '/patrol/patients.csv', { token: A.owner });
  assert.equal(csv.status, 200);
  assert.match(csv.body.split('\r\n')[0], /^case_number,occurred_at,age_years,sex,activity/);
  assert.match(csv.body, /wrist_hand:fracture/);
  assert.doesNotMatch(csv.body, /Ann|Guest|555-0100|Skier/, 'no names or phone numbers in the statistics export');
  const cases = await api('GET', '/patrol/incidents.csv', { token: A.owner });
  assert.match(cases.body.split('\r\n')[0], /^case_number,id,occurred_at/);

  const list = ok(await api('GET', '/patrol/incidents?q=Wrist', { token: T.pat }));
  assert.ok(list.data.length >= 1 && list.data.every((r) => /wrist/i.test(r.summary + r.location)));
  const draftOnly = ok(await api('GET', '/patrol/incidents?report_state=approved', { token: T.pat }));
  assert.ok(draftOnly.data.every((r) => r.report_state === 'approved'));
});

test('team: roster, levels, certification flags and who may see what', async () => {
  const o = A.owner;
  ok(await api('POST', '/team'.replace('/team', '/patrol/team'), { token: o, body: { staff_id: D.s1, level: 'leader', callsign: 'Patrol 1', emergency_contact: 'Jo 555-0111' } }), 201);
  ok(await api('POST', '/patrol/team', { token: o, body: { staff_id: D.s2, callsign: 'Patrol 2' } }), 201);
  assert.equal((await api('POST', '/patrol/team', { token: o, body: { staff_id: D.s2 } })).status, 409, 'already on the roster');
  assert.equal((await api('POST', '/patrol/team', { token: T.quinn, body: { staff_id: D.s3 } })).status, 403, 'a plain patroller cannot change the roster (a leader now has the Manager level and can)');

  const cert = ok(await api('POST', '/workforce/certifications', { token: o, body: { name: 'OEC' } }), 201);
  const long = `${Number(today.slice(0, 4)) + 2}-01-01`;
  ok(await api('PUT', `/workforce/staff/${D.s1}/certifications`, { token: o, body: { certification_id: cert.id, expires_on: long } }));
  ok(await api('PUT', `/workforce/staff/${D.s2}/certifications`, { token: o, body: { certification_id: cert.id, expires_on: '2020-01-01' } }));

  const forPatrol = ok(await api('GET', '/patrol/team', { token: T.quinn })).data;
  assert.equal(forPatrol.length, 2);
  assert.equal(forPatrol[0].level, 'leader', 'leaders sort first');
  assert.equal(forPatrol[0].emergency_contact, undefined, 'patrollers do not see emergency contacts');
  assert.equal(forPatrol[0].certifications[0].state, 'current');
  assert.equal(forPatrol[1].certifications[0].state, 'expired');
  assert.ok(forPatrol[0].cases_led_season >= 1);

  const forManager = ok(await api('GET', '/patrol/team', { token: o })).data;
  assert.equal(forManager[0].emergency_contact, 'Jo 555-0111');
  assert.equal((await api('PATCH', `/patrol/team/${D.s2}`, { token: o, body: { level: 'senior' } })).status, 200);
  assert.equal((await api('PATCH', `/patrol/team/${D.s2}`, { token: T.quinn, body: { level: 'director' } })).status, 403);
});

test('team: stations and daily deployment, with leaders allowed to post people', async () => {
  const o = A.owner;
  const st = ok(await api('POST', '/patrol/stations', { token: T.pat, body: { name: 'Summit hut', kind: 'hut' } }), 201); // Pat is a leader
  ok(await api('POST', '/patrol/stations', { token: o, body: { name: 'Aid room', kind: 'aid_room' } }), 201);
  assert.equal((await api('POST', '/patrol/stations', { token: T.quinn, body: { name: 'Quinn hut' } })).status, 403, 'Quinn is not a leader');
  assert.equal((await api('POST', '/patrol/stations', { token: o, body: { name: 'Aid room' } })).status, 409, 'duplicate names are refused');

  // a shift on the patrol schedule puts Quinn on today's list (patrol is scheduled in Patrol, not Staff and schedule)
  const pos = ok(await api('POST', '/workforce/positions', { token: o, body: { name: 'Patroller', department: 'patrol' } }), 201);
  assert.equal((await api('POST', '/workforce/shifts', { token: o, body: { position_id: pos.id, staff_id: D.s2, starts_at: `${today}T08:00`, ends_at: `${today}T16:00` } })).status, 400, 'patrol positions get no work shifts');
  ok(await api('POST', '/patrol/schedule', { token: o, body: { staff_id: D.s2, starts_at: `${today}T08:00`, ends_at: `${today}T16:00` } }), 201);

  const before = ok(await api('GET', `/patrol/deployments?date=${today}`, { token: T.quinn }));
  assert.deepEqual(before.assignments, []);
  assert.deepEqual(before.scheduled.map((s) => [s.staff_id, s.deployed]), [[D.s2, false]]);

  ok(await api('PUT', `/patrol/deployments/${today}`, { token: T.pat, body: { assignments: [{ staff_id: D.s1, station_id: st.id, role_label: 'Patrol leader', callsign: 'Patrol 1' }, { staff_id: D.s2, station_id: st.id }] } }));
  const after = ok(await api('GET', `/patrol/deployments?date=${today}`, { token: T.quinn }));
  assert.equal(after.assignments.length, 2);
  assert.equal(after.assignments[0].station, 'Summit hut');
  assert.equal(after.scheduled[0].deployed, true);

  assert.equal((await api('PUT', `/patrol/deployments/${today}`, { token: T.quinn, body: { assignments: [] } })).status, 403);
  assert.equal((await api('PUT', `/patrol/deployments/${today}`, { token: o, body: { assignments: [{ staff_id: D.inactive }] } })).status, 409, 'inactive staff cannot be posted');
  assert.equal((await api('PUT', `/patrol/deployments/${today}`, { token: o, body: { assignments: [{ staff_id: D.s1 }, { staff_id: D.s1 }] } })).status, 400, 'twice in one day');
  assert.equal(ok(await api('GET', `/patrol/deployments?date=${today}`, { token: o })).assignments.length, 2, 'a refused change leaves the day as it was');
  assert.equal((await api('PUT', '/patrol/deployments/not-a-date', { token: o, body: { assignments: [] } })).status, 400);
});

test('team: equipment checks move status, and training can be logged by self or a leader', async () => {
  const o = A.owner;
  const e = ok(await api('POST', '/patrol/equipment', { token: T.pat, body: { name: 'AED summit', kind: 'aed', serial: 'A-100' } }), 201);
  assert.equal((await api('POST', '/patrol/equipment', { token: T.quinn, body: { name: 'Nope' } })).status, 403);

  let list = ok(await api('GET', '/patrol/equipment', { token: T.quinn })).data;
  assert.equal(list[0].status, 'in_service');
  assert.equal(list[0].last_checked_at, null, 'never checked');

  ok(await api('POST', `/patrol/equipment/${e.id}/checks`, { token: T.quinn, body: { result: 'needs_attention', notes: 'Pads expire next month' } }), 201);
  list = ok(await api('GET', '/patrol/equipment', { token: T.pat })).data;
  assert.equal(list[0].status, 'needs_attention');
  assert.equal(list[0].last_result, 'needs_attention');
  assert.equal((await api('POST', `/patrol/equipment/${e.id}/checks`, { token: T.quinn, body: { result: 'ok' } })).status, 403, 'only a leader returns a flagged item to service');
  ok(await api('POST', `/patrol/equipment/${e.id}/checks`, { token: T.pat, body: { result: 'ok', reading: 'Battery 100%' } }), 201);
  assert.equal(ok(await api('GET', '/patrol/equipment', { token: T.pat })).data[0].status, 'in_service');
  assert.equal(ok(await api('GET', `/patrol/equipment/${e.id}/checks`, { token: T.pat })).data.length, 2);

  ok(await api('PATCH', `/patrol/equipment/${e.id}`, { token: o, body: { status: 'retired' } }));
  assert.equal((await api('POST', `/patrol/equipment/${e.id}/checks`, { token: T.quinn, body: { result: 'ok' } })).status, 409);
  assert.equal((await api('POST', '/patrol/equipment/999999/checks', { token: T.quinn, body: { result: 'ok' } })).status, 404);

  // training: yourself, or anyone if you lead
  ok(await api('POST', '/patrol/training', { token: T.quinn, body: { title: 'Toboggan refresher', kind: 'toboggan', hours: 3, completed_on: today } }), 201);
  assert.equal((await api('POST', '/patrol/training', { token: T.quinn, body: { staff_id: D.s1, title: 'Not mine', hours: 1, completed_on: today } })).status, 403);
  assert.equal((await api('POST', '/patrol/training', { token: T.unlinked, body: { title: 'Nobody', hours: 1, completed_on: today } })).status, 400, 'an unlinked login has no staff record');
  ok(await api('POST', '/patrol/training', { token: T.pat, body: { staff_id: D.s2, title: 'OEC refresher', kind: 'oec', hours: 8.5, completed_on: today } }), 201);
  const mine = ok(await api('GET', `/patrol/training?staff_id=${D.s2}`, { token: T.quinn })).data;
  assert.equal(mine.length, 2);
  const roster = ok(await api('GET', '/patrol/team', { token: T.quinn })).data.find((m) => m.staff_id === D.s2);
  assert.equal(roster.training_hours_season, 11.5);
  assert.equal((await api('DELETE', `/patrol/training/${mine[0].id}`, { token: T.quinn })).status, 403, 'only people with the training feature delete records');
  assert.equal((await api('DELETE', `/patrol/training/${mine[0].id}`, { token: o })).status, 204);

  const me = ok(await api('GET', '/patrol/me', { token: T.pat }));
  assert.equal(me.can_lead, true);
  assert.equal(ok(await api('GET', '/patrol/me', { token: T.quinn })).can_lead, false);
});

test('dispatch: calls, timeline, responders, available patrollers and linking a case', async () => {
  const o = A.owner;
  // Both are already on the roster from the team test, so adding them again is refused; make sure they are there.
  is(await api('POST', '/patrol/team', { token: o, body: { staff_id: D.s1, level: 'leader' } }), 409);
  is(await api('POST', '/patrol/team', { token: o, body: { staff_id: D.s2, level: 'patroller' } }), 409);
  assert.deepEqual(ok(await api('GET', '/patrol/dispatch/available', { token: T.pat })).data, [], 'nobody clocked in yet');
  ok(await api('POST', '/workforce/time/clock-in', { token: T.pat, body: {} }), 201);
  const avail = ok(await api('GET', '/patrol/dispatch/available', { token: T.pat })).data;
  assert.equal(avail.length, 1);
  assert.equal(avail[0].state, 'available');

  const call = ok(await api('POST', '/patrol/dispatch', { token: T.quinn, body: { location: 'Top of Ridge Run', description: 'Skier down, wrist', priority: 'high', source: 'radio' } }), 201);
  assert.match(call.call_no, /^\d{4}-\d{2}$/);
  assert.equal((await api('POST', '/patrol/dispatch', { token: T.counter, body: { location: 'x' } })).status, 403);

  ok(await api('POST', `/patrol/dispatch/${call.id}/responders`, { token: T.quinn, body: { staff_id: D.s1 } }), 201);
  assert.equal((await api('POST', `/patrol/dispatch/${call.id}/responders`, { token: T.quinn, body: { staff_id: D.s1 } })).status, 409, 'already sent');
  assert.equal((await api('POST', `/patrol/dispatch/${call.id}/responders`, { token: T.quinn, body: { staff_id: D.inactive } })).status, 409, 'inactive staff');
  assert.equal(ok(await api('GET', '/patrol/dispatch/available', { token: T.pat })).data[0].state, 'on_call');

  ok(await api('POST', `/patrol/dispatch/${call.id}/events`, { token: T.pat, body: { kind: 'on_scene', note: 'Stable, splinting' } }), 201);
  ok(await api('POST', `/patrol/dispatch/${call.id}/events`, { token: T.pat, body: { kind: 'transporting' } }), 201);
  assert.equal((await api('POST', `/patrol/dispatch/${call.id}/events`, { token: T.pat, body: { kind: 'note' } })).status, 400, 'a note needs text');
  const board = ok(await api('GET', '/patrol/dispatch', { token: T.quinn })).data;
  assert.equal(board.length, 1);
  assert.equal(board[0].status, 'transporting');
  assert.equal(board[0].responders.length, 1);

  const made = ok(await api('POST', `/patrol/dispatch/${call.id}/case`, { token: T.pat, body: { category: 'injury', severity: 'moderate' } }), 201);
  assert.match(made.case_number, /^\d{4}-\d{2}-\d{4}$/);
  assert.equal((await api('POST', `/patrol/dispatch/${call.id}/case`, { token: T.pat, body: {} })).status, 409, 'one case per call');

  ok(await api('POST', `/patrol/dispatch/${call.id}/events`, { token: T.pat, body: { kind: 'closed', note: 'Handed to aid room' } }), 201);
  assert.equal((await api('POST', `/patrol/dispatch/${call.id}/events`, { token: T.pat, body: { kind: 'note', note: 'late' } })).status, 409, 'closed calls are final');
  assert.equal(ok(await api('GET', '/patrol/dispatch', { token: T.pat })).data.length, 0, 'closed calls leave the active board');
  const one = ok(await api('GET', `/patrol/dispatch/${call.id}`, { token: T.pat }));
  assert.deepEqual(one.events.map((e) => e.kind), ['received', 'dispatched', 'on_scene', 'transporting', 'closed']);
  assert.equal(one.case.id, made.id);
  assert.equal((await api('GET', `/patrol/dispatch/${call.id}`, { token: T.otherPat })).status, 404, 'other mountains cannot see it');
  ok(await api('POST', '/workforce/time/clock-out', { token: T.pat, body: {} }));
});

test('guest help: off by default, then a rate-limited public request that lands as a new call', async () => {
  const o = A.owner;
  assert.equal((await api('GET', `/public/${A.slug}/help`)).status, 404, 'disabled by default');
  assert.equal((await api('POST', `/public/${A.slug}/help`, { body: { location: 'Ridge Run' } })).status, 404);
  assert.equal((await api('PUT', '/patrol/guest-help', { token: T.pat, body: { enabled: true } })).status, 403, 'managers only');
  ok(await api('PUT', '/patrol/guest-help', { token: o, body: { enabled: true, message: 'Patrol phone: 555-0111' } }));
  const page = ok(await api('GET', `/public/${A.slug}/help`));
  assert.equal(page.message, 'Patrol phone: 555-0111');
  assert.ok(page.places.includes('Ridge Run'));
  assert.equal(JSON.stringify(page).includes('Patroller'), false, 'no staff names leak');

  const sent = ok(await api('POST', `/public/${A.slug}/help`, { body: { location: 'Ridge Run, near the glades', description: 'Friend hurt knee', name: 'Sam', phone: '555-0199' } }), 201);
  assert.match(sent.reference, /^\d{4}-\d{2}$/);
  const bot = await api('POST', `/public/${A.slug}/help`, { body: { location: 'Ridge Run', website: 'http://spam.example' } });
  assert.equal(bot.status, 202, 'bots get a fake success');
  const board = ok(await api('GET', '/patrol/dispatch', { token: T.pat })).data;
  assert.equal(board.length, 1, 'only the real request was created');
  assert.equal(board[0].source, 'guest');
  assert.equal(board[0].status, 'new');
  assert.equal((await api('POST', `/public/${A.slug}/help`, { body: { location: '' } })).status, 400);
  assert.equal(ok(await api('GET', `/patrol/guest-help`, { token: o })).path, `/help/${A.slug}`);
  assert.equal((await api('GET', `/public/${B.slug}/help`)).status, 404, 'another mountain is still off');
  const html = await fetch(`${base}/help/${A.slug}`);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /911/);
  ok(await api('PUT', '/patrol/guest-help', { token: o, body: { enabled: false } }));
  assert.equal((await api('POST', `/public/${A.slug}/help`, { body: { location: 'Ridge Run' } })).status, 404, 'switched off again');
});

test('training passport: skills, leader sign-off with expiry, own view only, and equipment clearance', async () => {
  const o = A.owner;
  const c1 = ok(await api('POST', '/patrol/competencies', { token: T.pat, body: { name: 'Toboggan handling', category: 'Rescue', valid_months: 12 } }), 201).id;
  const c2 = ok(await api('POST', '/patrol/competencies', { token: o, body: { name: 'Spinal stabilization' } }), 201).id;
  assert.equal((await api('POST', '/patrol/competencies', { token: o, body: { name: 'Spinal stabilization' } })).status, 409);
  assert.equal((await api('POST', '/patrol/competencies', { token: T.quinn, body: { name: 'Nope' } })).status, 403);

  const empty = ok(await api('GET', `/patrol/passport/${D.s2}`, { token: T.quinn }));
  assert.equal(empty.skills.length, 2);
  assert.ok(empty.skills.every((s) => s.state === 'not_started'));

  assert.equal((await api('PUT', `/patrol/passport/${D.s2}/${c1}`, { token: T.quinn, body: { status: 'signed_off' } })).status, 403, 'not a leader');
  assert.equal((await api('PUT', `/patrol/passport/${D.s1}/${c1}`, { token: T.pat, body: { status: 'signed_off' } })).status, 403, 'a leader cannot sign themselves off');
  const signed = ok(await api('PUT', `/patrol/passport/${D.s2}/${c1}`, { token: T.pat, body: { status: 'signed_off', signed_on: '2020-01-31' } }));
  assert.equal(signed.expires_on, '2021-01-31');
  ok(await api('PUT', `/patrol/passport/${D.s2}/${c2}`, { token: T.pat, body: { status: 'signed_off' } }));
  const pass = ok(await api('GET', `/patrol/passport/${D.s2}`, { token: T.quinn })).skills;
  assert.equal(pass.find((s) => s.competency_id === c1).state, 'expired');
  assert.equal(pass.find((s) => s.competency_id === c2).state, 'signed_off');
  assert.equal((await api('GET', `/patrol/passport/${D.s1}`, { token: T.quinn })).status, 403, 'only your own passport');
  const overview = ok(await api('GET', '/patrol/passport', { token: T.pat })).data.find((m) => m.staff_id === D.s2);
  assert.equal(overview.expired, 1);
  assert.equal(overview.signed_off, 1);
  assert.equal((await api('GET', '/patrol/passport', { token: T.quinn })).status, 403);

  // equipment clearance
  const e = ok(await api('POST', '/patrol/equipment', { token: o, body: { name: 'AED base', kind: 'aed' } }), 201);
  assert.equal((await api('POST', `/patrol/equipment/${e.id}/clear`, { token: T.pat, body: { notes: 'fine' } })).status, 409, 'not flagged');
  ok(await api('POST', `/patrol/equipment/${e.id}/checks`, { token: T.quinn, body: { result: 'out_of_service', notes: 'Battery dead' } }), 201);
  assert.equal((await api('POST', `/patrol/equipment/${e.id}/clear`, { token: T.quinn, body: { notes: 'New battery fitted' } })).status, 403, 'leaders clear');
  ok(await api('POST', `/patrol/equipment/${e.id}/clear`, { token: T.pat, body: { notes: 'New battery fitted' } }));
  const list = ok(await api('GET', '/patrol/equipment', { token: T.pat })).data.find((x) => x.id === e.id);
  assert.equal(list.status, 'in_service');
  assert.match(list.last_notes, /Cleared: New battery/);
});

test('analytics include skier visits and patients per 1000 visits', async () => {
  const a = ok(await api('GET', '/patrol/analytics', { token: A.owner }));
  assert.equal(typeof a.visits, 'number');
  assert.ok('patients_per_1000_visits' in a);
});

test('NSAAR form: every field is described, stored, validated and can be made mandatory by an administrator', async () => {
  const o = A.owner;
  const form = ok(await api('GET', '/patrol/form', { token: T.quinn }));
  assert.ok(form.fields.length > 80, 'the whole NSAAR is in the registry');
  assert.deepEqual(form.sections.map((s) => s.id).slice(0, 3), ['patient', 'complaint', 'assessment']);
  const keys = new Set(form.fields.map((f) => `${f.scope}.${f.key}`));
  for (const k of ['patient.body_parts', 'patient.treatment_protocol', 'patient.cause', 'case.weather', 'case.surface', 'patient.destination_type', 'case.completed_by_number', 'case.incident_location']) assert.ok(keys.has(k), k);
  assert.deepEqual(form.required.patient.sort(), ['chief_complaint', 'disposition'], 'defaults match the earlier sign-off rules');
  assert.equal(form.can_admin, false);
  assert.equal(ok(await api('GET', '/patrol/form', { token: T.pat })).can_admin, false, 'a leader is not an administrator');

  // values are validated against the form
  const c = ok(await newCase(T.pat, { summary: 'Form test', form: { weather: 'snowing', light: 'flat', temperature: 'minus10_to_0', surface: 'groomed', map_grid: 'C4' } }), 201);
  assert.equal((await api('PATCH', `/patrol/incidents/${c.id}`, { token: T.pat, body: { form: { weather: 'sunny-ish' } } })).status, 400, 'not one of the options');
  assert.equal((await api('PATCH', `/patrol/incidents/${c.id}`, { token: T.pat, body: { form: { nonsense: 1 } } })).status, 400, 'unknown field');
  ok(await api('PATCH', `/patrol/incidents/${c.id}`, { token: T.pat, body: { form: { snow: '0_to_5', map_grid: null } } }));
  const got = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat }));
  assert.deepEqual(got.form, { weather: 'snowing', light: 'flat', temperature: 'minus10_to_0', surface: 'groomed', snow: '0_to_5', run_classification: 'more_difficult' }, 'merged, null removes a field, and the run class comes from the trail');

  const p = ok(await api('POST', `/patrol/incidents/${c.id}/patients`, { token: T.pat, body: { first_name: 'Dana', last_name: 'Rider', chief_complaint: 'Wrist pain', disposition: 'transported_ambulance', form: { activity: 'snowboard', body_parts: { wrist: 'L', head: 'X' }, treatment_protocol: ['fracture'], from_base: 'ambulance', helmet: 'owned' } } }), 201);
  assert.equal((await api('PATCH', `/patrol/incidents/${c.id}/patients/${p.id}`, { token: T.pat, body: { form: { body_parts: { elbow: 'Q' } } } })).status, 400);
  assert.equal((await api('PATCH', `/patrol/incidents/${c.id}/patients/${p.id}`, { token: T.pat, body: { form: { scene_on: '25:99' } } })).status, 400, '24 hour time');
  const mine = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat })).patients[0];
  assert.deepEqual(mine.form.body_parts, { wrist: 'L', head: 'X' });

  // only an administrator changes what is mandatory
  const cfg = (required, token) => api('PUT', '/patrol/form-config', { token, body: { required, legal_name: 'Spring Mountain Resort LLC' } });
  const want = { case: ['weather', 'witnesses', 'completed_by_name', 'patroller_signature', 'park_feature'], patient: ['chief_complaint', 'date_of_birth', 'ambulance_code', 'description', 'patient_signature', 'allergies'] };
  assert.equal((await cfg(want, T.quinn)).status, 403);
  assert.equal((await cfg(want, T.pat)).status, 403, 'a leader is not an administrator');
  assert.equal((await cfg({ case: ['nope'], patient: [] }, o)).status, 400, 'unknown field');
  assert.equal((await cfg({ case: ['location'], patient: [] }, o)).status, 400, 'locked field');
  ok(await cfg(want, o));
  const after = ok(await api('GET', '/patrol/form', { token: T.quinn }));
  assert.equal(after.resort.legal_name, 'Spring Mountain Resort LLC');
  assert.ok(after.required.patient.includes('date_of_birth'));
  assert.ok(!after.required.patient.includes('disposition'), 'an administrator can switch a default off');

  // submit now lists what is missing; conditional fields only when they apply
  const gaps = await api('POST', `/patrol/incidents/${c.id}/submit`, { token: T.pat });
  assert.equal(gaps.status, 409);
  const text = gaps.body.details.map((x) => x.message).join(' | ');
  for (const bit of ['Dana Rider: Date of birth', 'Dana Rider: Attending ambulance number', "Dana Rider: Patient's description", 'Dana Rider: Patient signature', 'Dana Rider: Allergies', 'Witnesses: At least one witness', 'Sign off: Form completed by', 'Sign off: Patroller signature']) assert.ok(text.includes(bit), `${bit}\n${text}`);
  assert.ok(!text.includes('Park feature'), 'park feature only applies in a terrain park');
  assert.ok(!text.includes('Weather'), 'weather was given');
  assert.ok(!text.includes('Outcome'), 'outcome is no longer mandatory');

  // fill in everything
  ok(await api('PATCH', `/patrol/incidents/${c.id}/patients/${p.id}`, { token: T.pat, body: { date_of_birth: '1995-02-03', allergies: 'None', form: { ambulance_code: 'M-12', description: 'I caught an edge and slid.' } } }));
  ok(await api('PATCH', `/patrol/incidents/${c.id}`, { token: T.pat, body: { form: { witnesses_none: true, completed_by_name: 'Pat Patroller' } } }));
  ok(await api('POST', `/patrol/incidents/${c.id}/signatures`, { token: T.pat, body: { kind: 'patient_acknowledgment', signer_name: 'Dana Rider', patient_id: p.id, image: 'data:image/png;base64,iVBORw0KGgo=' } }), 201);
  ok(await api('POST', `/patrol/incidents/${c.id}/signatures`, { token: T.pat, body: { kind: 'patroller', signer_name: 'Pat Patroller', image: 'data:image/png;base64,iVBORw0KGgo=' } }), 201);
  ok(await api('POST', `/patrol/incidents/${c.id}/submit`, { token: T.pat }));

  // witnesses carry the full NSAAR details
  const c2 = ok(await newCase(T.pat, { summary: 'Witness test' }), 201);
  ok(await api('POST', `/patrol/incidents/${c2.id}/witnesses`, { token: T.pat, body: { relation: 'collided_with', name: 'Lee Skier', phone: '555-0101', address: '1 Main St', city: 'Royersford', region: 'PA', postal: '19468' } }), 201);
  const w = ok(await api('GET', `/patrol/incidents/${c2.id}`, { token: T.pat })).witnesses[0];
  assert.equal(w.relation, 'collided_with');
  assert.equal(w.postal, '19468');

  // another mountain has its own settings
  const other = ok(await api('GET', '/patrol/form', { token: T.otherPat }));
  assert.deepEqual(other.required.patient.sort(), ['chief_complaint', 'disposition']);
  assert.equal(other.resort.legal_name, null);
});

test('the patrol director can administer the form, and switching a field back off works', async () => {
  const o = A.owner;
  const dirStaff = ok(await api('POST', '/workforce/staff', { token: o, body: { person: { first_name: 'Dee', last_name: 'Director' }, status: 'active' } }), 201).id;
  ok(await api('POST', '/patrol/team', { token: o, body: { staff_id: dirStaff, level: 'director' } }), 201);
  const dir = await addUser(A, `director@${A.slug}.test`, 'patrol', { staff_id: dirStaff });
  assert.equal(ok(await api('GET', '/patrol/form', { token: dir })).can_admin, true);
  ok(await api('PUT', '/patrol/form-config', { token: dir, body: { required: { case: [], patient: ['chief_complaint', 'disposition'] } } }));
  const f = ok(await api('GET', '/patrol/form', { token: dir }));
  assert.deepEqual(f.required.case, []);
  assert.deepEqual(f.required.patient.sort(), ['chief_complaint', 'disposition']);
  assert.equal(f.resort.legal_name, 'Spring Mountain Resort LLC', 'omitting the legal name leaves it alone');
});

test('hand-off: fields are saved with the patient, printing is logged, and other mountains cannot touch it', async () => {
  const o = A.owner;
  const c = ok(await newCase(o, { summary: 'Hand-off test' }), 201);
  const p = ok(await api('POST', `/patrol/incidents/${c.id}/patients`, { token: o, body: { first_name: 'Hal', last_name: 'Handoff' } }), 201);
  ok(await api('PATCH', `/patrol/incidents/${c.id}/patients/${p.id}`, { token: o, body: { form: { handoff_to: 'Medic 9', handoff_time: '12:30' } } }));
  const got = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: o })).patients[0];
  assert.equal(got.form.handoff_to, 'Medic 9');
  assert.equal(got.form.handoff_time, '12:30');

  assert.equal((await api('POST', `/patrol/incidents/${c.id}/patients/${p.id}/handoff-printed`, { token: o })).status, 204);
  const log = ok(await api('GET', '/patrol/access-log', { token: o })).data;
  assert.ok(log.some((e) => e.action === 'handoff_print' && String(e.entity_id) === String(c.id) && e.detail.patient_id === p.id), 'printing is audited');

  assert.equal((await api('POST', `/patrol/incidents/${c.id}/patients/${p.id}/handoff-printed`, { token: T.otherPat })).status, 404);
  assert.equal((await api('POST', `/patrol/incidents/${c.id}/patients/999999/handoff-printed`, { token: o })).status, 404);
});
