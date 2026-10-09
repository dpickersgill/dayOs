'use strict';

// Patient care from the rescuer's side: entries marked in error instead of deleted, late entries, frozen versions,
// GCS in parts, the recheck timer on the patient, structured treatments, answers filled in from the bedside entries,
// the refusal rules (capacity, under 18), and the receiving provider's signature.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { derive, bodyMap } = require('../src/lib/carederive');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);

const T = {}; const D = {};
test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const slug = `pc-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  T.owner = (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token;
  D.s1 = ok(await api('POST', '/workforce/staff', { token: T.owner, body: { person: { first_name: 'Pat', last_name: 'Rescuer' }, status: 'active' } })).id;
  ok(await api('POST', '/patrol/team', { token: T.owner, body: { staff_id: D.s1, callsign: 'Patrol 4', patrol_number: '417' } }));
  ok(await api('POST', '/users', { token: T.owner, body: { email: `pat@${slug}.test`, password: PW, role: 'patrol', staff_id: D.s1 } }));
  T.pat = (await api('POST', '/auth/login', { body: { tenant: slug, email: `pat@${slug}.test`, password: PW } })).body.token;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

const newCase = (over = {}) => api('POST', '/patrol/incidents', { token: T.pat, body: { occurred_at: `${today}T10:15`, location: 'Upper Ridge', category: 'injury', severity: 'moderate', summary: 'Skier down', ...over } });

test('the sign-in fills in who completes the report', async () => {
  const me = ok(await api('GET', '/patrol/me', { token: T.pat }));
  assert.equal(me.name, 'Pat Rescuer');
  assert.equal(me.patrol_number, '417');
});

test('vitals: GCS in parts adds up, both pupils, the recheck timer is on the patient, a late entry is marked', async () => {
  const c = ok(await newCase());
  const b = `/patrol/incidents/${c.id}/patients`;
  const p = ok(await api('POST', b, { token: T.pat, body: { first_name: 'Gil', last_name: 'Gauge' } }));
  is(await api('POST', `${b}/${p.id}/vitals`, { token: T.pat, body: { gcs_e: 4, gcs_v: 4 } }), 400, 'all three parts or none');
  is(await api('POST', `${b}/${p.id}/vitals`, { token: T.pat, body: { gcs_e: 5, gcs_v: 4, gcs_m: 6 } }), 400, 'eyes go to 4');
  ok(await api('POST', `${b}/${p.id}/vitals`, { token: T.pat, body: { gcs_e: 4, gcs_v: 4, gcs_m: 6, pupil_left: 'normal', pupil_right: 'dilated', skin: 'Pale, Cool, Clammy', recheck_minutes: 10 } }));
  ok(await api('POST', `${b}/${p.id}/vitals`, { token: T.pat, body: { pulse: 88, taken_at: `${today}T08:00` } }));
  const got = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat })).patients[0];
  const first = got.vitals.find((v) => v.gcs_e);
  assert.equal(first.gcs, 14, 'the total is worked out');
  assert.deepEqual([first.pupil_left, first.pupil_right, first.skin], ['normal', 'dilated', 'Pale, Cool, Clammy']);
  assert.ok(got.vitals_due_at, 'the next check is due on the patient record');
  const late = got.vitals.find((v) => v.pulse === 88);
  assert.equal(late.taken_at.slice(11, 16), '08:00');
  assert.ok(late.entered_at > late.taken_at, 'the time it was typed in is kept');
  ok(await api('POST', `${b}/${p.id}/vitals`, { token: T.pat, body: { pulse: 80, recheck_minutes: 0 } }));
  assert.equal(ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat })).patients[0].vitals_due_at, null, 'no reminder clears it');
});

test('treatments carry structure: CMS before and after, oxygen flow, a medication with its effect, the arrest log', async () => {
  const c = ok(await newCase());
  const b = `/patrol/incidents/${c.id}/patients`;
  const p = ok(await api('POST', b, { token: T.pat, body: { first_name: 'Tia', last_name: 'Treat' } }));
  const t = (body) => api('POST', `${b}/${p.id}/treatments`, { token: T.pat, body });
  const yes = { c: 'present', m: 'present', s: 'present' };
  ok(await t({ kind: 'splint', detail: { cms_before: yes, cms_after: { ...yes, s: 'absent' }, body_part: 'Left lower leg' } }));
  is(await t({ kind: 'splint', detail: { cms_before: { c: 'maybe', m: 'present', s: 'present' } } }), 400);
  is(await t({ kind: 'splint', detail: { colour: 'blue' } }), 400, 'unknown details are refused');
  ok(await t({ kind: 'oxygen', detail: { o2_device: 'non_rebreather', o2_lpm: 15 } }));
  const med = ok(await t({ kind: 'medication', medication: 'Acetaminophen', dose: '500 mg', route: 'oral', performed_by_staff: D.s1, detail: { dose_value: 500, dose_unit: 'mg', indication: 'Leg pain 7/10', authorised_by: 'Standing order' } }));
  ok(await api('POST', `${b}/${p.id}/treatments/${med.id}/effect`, { token: T.pat, body: { effect: 'Pain down to 4/10' } }));
  ok(await t({ kind: 'cpr', detail: { action: 'start' } }));
  ok(await t({ kind: 'aed', detail: { action: 'shock', joules: 200 } }));
  ok(await t({ kind: 'rosc' }));
  const got = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat })).patients[0];
  const m = got.treatments.find((x) => x.kind === 'medication');
  assert.equal(m.detail.effect, 'Pain down to 4/10');
  assert.ok(m.detail.effect_at);
  assert.equal(m.performed_by_name, 'Pat Rescuer');
  assert.equal(got.treatments.find((x) => x.kind === 'oxygen').detail.o2_lpm, 15);
  // the form answers the bedside entries give
  assert.match(got.derived.fa_scene, /Splint \(Left lower leg; CMS before C ok, M ok, S ok; after C ok, M ok, S absent\)/);
  assert.match(got.derived.fa_scene, /Oxygen \(15 L\/min by non-rebreather\)/);
  assert.match(got.derived.fa_scene, /AED \(shock delivered; 200 J\)/);
  assert.equal(got.derived.medication_text, 'Acetaminophen 500 mg oral');
  assert.equal(got.derived.medication_by, 'Pat Rescuer');
});

test('nothing clinical is deleted: entries and patients are marked entered in error, and drop out of the counts', async () => {
  const c = ok(await newCase());
  const b = `/patrol/incidents/${c.id}/patients`;
  const p = ok(await api('POST', b, { token: T.pat, body: { first_name: 'Val', last_name: 'Void' } }));
  const v = ok(await api('POST', `${b}/${p.id}/vitals`, { token: T.pat, body: { pulse: 300 } }));
  const i = ok(await api('POST', `${b}/${p.id}/injuries`, { token: T.pat, body: { body_region: 'knee', side: 'left', injury_type: 'sprain_strain' } }));
  is(await api('DELETE', `${b}/${p.id}/vitals/${v.id}`, { token: T.pat }), 404);
  is(await api('POST', `${b}/${p.id}/vitals/${v.id}/void`, { token: T.pat, body: { reason: 'no' } }), 400, 'a real reason');
  ok(await api('POST', `${b}/${p.id}/vitals/${v.id}/void`, { token: T.pat, body: { reason: 'Typed 300 for 130' } }));
  ok(await api('POST', `${b}/${p.id}/injuries/${i.id}/void`, { token: T.pat, body: { reason: 'Wrong knee' } }));
  let got = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat })).patients[0];
  assert.equal(got.vitals[0].void_reason, 'Typed 300 for 130');
  assert.equal(got.derived.body_parts, undefined, 'a voided injury is not on the body map');

  const wrong = ok(await api('POST', b, { token: T.pat, body: { first_name: 'Dup', last_name: 'Licate' } }));
  ok(await api('POST', `${b}/${wrong.id}/void`, { token: T.pat, body: { reason: 'Same person added twice' } }));
  is(await api('POST', `${b}/${wrong.id}/vitals`, { token: T.pat, body: { pulse: 80 } }), 409, 'nothing more is added to a voided patient');
  is(await api('PATCH', `${b}/${wrong.id}`, { token: T.pat, body: { chief_complaint: 'x' } }), 409);
  got = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat }));
  assert.equal(got.patients.length, 2, 'both are still on the record');
  const list = ok(await api('GET', '/patrol/incidents', { token: T.pat })).data.find((x) => x.id === c.id);
  assert.equal(Number(list.patient_count), 1, 'the voided one is not counted');
  // the submit check ignores the voided patient
  const gaps = await api('POST', `/patrol/incidents/${c.id}/submit`, { token: T.pat });
  assert.equal(gaps.body.details.some((x) => /Dup Licate/.test(x.message)), false);
});

test('refusal: a patient who cannot decide cannot refuse, and a parent or guardian signs for a minor', async () => {
  const c = ok(await newCase({ summary: 'Refusal' }));
  const b = `/patrol/incidents/${c.id}/patients`;
  const kid = ok(await api('POST', b, { token: T.pat, body: { first_name: 'Kim', last_name: 'Kid', age_years: 12, chief_complaint: 'Wrist pain', disposition: 'refused_care', form: { refusal_capacity: 'no' } } }));
  is(await api('POST', `/patrol/incidents/${c.id}/signatures`, { token: T.pat, body: { kind: 'refusal_of_care', signer_name: 'Kim Kid', patient_id: kid.id, image: PNG } }), 409, 'no refusal signature without capacity');
  let gaps = (await api('POST', `/patrol/incidents/${c.id}/submit`, { token: T.pat })).body.details.map((x) => x.message).join(' | ');
  assert.match(gaps, /cannot refuse care/);
  assert.match(gaps, /parent or guardian signs/);
  ok(await api('PATCH', `${b}/${kid.id}`, { token: T.pat, body: { form: { refusal_capacity: 'yes', refusal_signer: 'guardian', refusal_guardian_name: 'Kay Kid', refusal_guardian_relation: 'Mother', refusal_care_offered: 'Splint and a ride to the clinic' } } }));
  ok(await api('POST', `/patrol/incidents/${c.id}/signatures`, { token: T.pat, body: { kind: 'refusal_of_care', signer_name: 'Kay Kid', signer_role: 'Mother', patient_id: kid.id, image: PNG } }));
  ok(await api('POST', `/patrol/incidents/${c.id}/signatures`, { token: T.pat, body: { kind: 'witness', signer_name: 'Wes Witness', patient_id: kid.id, image: PNG } }));
  gaps = (await api('POST', `/patrol/incidents/${c.id}/submit`, { token: T.pat })).body;
  assert.equal(JSON.stringify(gaps).includes('guardian'), false, JSON.stringify(gaps));
});

test('the receiving provider signs, submit fills the form from the bedside, and each submit or approval is kept as a version', async () => {
  const c = ok(await newCase());
  const id = c.id;
  const b = `/patrol/incidents/${id}/patients`;
  const p = ok(await api('POST', b, { token: T.pat, body: { first_name: 'Han', last_name: 'Doff', chief_complaint: 'Left knee pain' } }));
  is(await api('POST', `/patrol/incidents/${id}/signatures`, { token: T.pat, body: { kind: 'receiving_provider', signer_name: 'J. Alvarez', image: PNG } }), 400, 'it belongs to a patient');
  ok(await api('POST', `/patrol/incidents/${id}/events`, { token: T.pat, body: { kind: 'on_scene', at: `${today}T10:20` } }));
  ok(await api('POST', `/patrol/incidents/${id}/events`, { token: T.pat, body: { kind: 'at_aid_room', at: `${today}T10:50` } }));
  ok(await api('POST', `/patrol/incidents/${id}/events`, { token: T.pat, body: { kind: 'handoff', at: `${today}T11:05` } }));
  ok(await api('POST', `${b}/${p.id}/injuries`, { token: T.pat, body: { body_region: 'knee', side: 'left', injury_type: 'sprain_strain' } }));
  ok(await api('POST', `${b}/${p.id}/treatments`, { token: T.pat, body: { kind: 'ice', performed_at: `${today}T10:25` } }));
  ok(await api('POST', `${b}/${p.id}/treatments`, { token: T.pat, body: { kind: 'bandage', performed_at: `${today}T10:55` } }));
  ok(await api('POST', `/patrol/incidents/${id}/signatures`, { token: T.pat, body: { kind: 'receiving_provider', signer_name: 'J. Alvarez', signer_role: 'Paramedic, Medic 12', patient_id: p.id, image: PNG } }));
  ok(await api('PATCH', `${b}/${p.id}`, { token: T.pat, body: { disposition: 'transported_ambulance', form: { fa_base: 'Typed by hand' } } }));

  const before = ok(await api('GET', `/patrol/incidents/${id}`, { token: T.pat }));
  const d = before.patients[0].derived;
  assert.deepEqual([d.scene_on, d.base_in, d.base_out, d.handoff_time], ['10:20', '10:50', '11:05', '11:05']);
  assert.deepEqual(d.body_parts, { knee: 'L' });
  assert.match(d.fa_scene, /10:25 Ice/);
  assert.match(d.fa_base, /10:55 Bandage/);
  assert.equal(before.signatures.find((s) => s.kind === 'receiving_provider').signer_role, 'Paramedic, Medic 12');

  ok(await api('POST', `/patrol/incidents/${id}/submit`, { token: T.pat }));
  const after = ok(await api('GET', `/patrol/incidents/${id}`, { token: T.pat }));
  const f = after.patients[0].form;
  assert.deepEqual(f.body_parts, { knee: 'L' }, 'blanks were filled from the bedside');
  assert.equal(f.scene_on, '10:20');
  assert.equal(f.fa_base, 'Typed by hand', 'what was typed is kept');
  assert.equal(after.form.completed_by_name, 'Pat Rescuer');
  assert.equal(after.form.completed_by_number, '417');
  assert.equal(after.versions.length, 1);
  assert.equal(after.versions[0].kind, 'submitted');

  ok(await api('POST', `/patrol/incidents/${id}/approve`, { token: T.owner }));
  const vs = ok(await api('GET', `/patrol/incidents/${id}`, { token: T.pat })).versions;
  assert.deepEqual(vs.map((v) => [v.version_no, v.kind]), [[1, 'submitted'], [2, 'approved']]);
  const v1 = ok(await api('GET', `/patrol/incidents/${id}/versions/${vs[0].id}`, { token: T.pat }));
  assert.equal(v1.case.report_state, 'submitted', 'the frozen copy shows the report as it was then');
  assert.equal(v1.case.patients[0].form.scene_on, '10:20');
  is(await api('GET', `/patrol/incidents/${id}/versions/999999`, { token: T.pat }), 404);
  const [[log]] = await pool.query("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'incidents' AND entity_id = ? AND action = 'view_version'", [id]);
  assert.equal(Number(log.n), 1);
});

test('the body map from bedside injuries', () => {
  assert.deepEqual(bodyMap([{ body_region: 'knee', side: 'left', injury_type: 'sprain_strain' }, { body_region: 'knee', side: 'right', injury_type: 'contusion' }, { body_region: 'head', side: 'na', injury_type: 'concussion' }, { body_region: 'back', side: 'midline', injury_type: 'spinal' }]), { knee: 'B', head: 'X' });
  assert.deepEqual(bodyMap([{ body_region: 'chest', side: 'na', injury_type: 'cardiac' }]), { medical: 'X' });
  assert.deepEqual(derive({ events: [] }, { form: {}, injuries: [], treatments: [], vitals: [] }), {});
});
