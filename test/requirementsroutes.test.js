'use strict';

// Report requirements through the API: only the patrol director changes them; a mountain that never changed them keeps
// its old mandatory fields; submitting stops on "required to submit" and lists "required to approve" for the reviewer;
// N/A with a reason counts as an answer; approval is judged against the rules the report was submitted under; only the
// Patrol Director approves with an exception, and the exception travels with the approved copy.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.INBOX_RATE_LIMIT = '5000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const R = require('../src/lib/review');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);
const ALL = Object.fromEntries(R.CHECK_KEYS.map((k) => [k, true]));

const T = {}; const U = {}; const S = {}; let slug;
test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  slug = `rq-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Rules Peak', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  T.owner = await login(`owner@${slug}.test`);
  for (const [key, first] of [['director', 'Dana'], ['backup', 'Ben'], ['pat', 'Pat']]) {
    S[key] = ok(await api('POST', '/workforce/staff', { token: T.owner, body: { person: { first_name: first, last_name: 'Ridge' }, status: 'active' } })).id;
    ok(await api('POST', '/users', { token: T.owner, body: { email: `${key}@${slug}.test`, password: PW, role: 'patrol', staff_id: S[key] } }));
    T[key] = await login(`${key}@${slug}.test`);
  }
  const [users] = await pool.query('SELECT id, email FROM users WHERE tenant_id = (SELECT id FROM tenants WHERE slug = ?)', [slug]);
  for (const u of users) U[u.email.split('@')[0]] = Number(u.id);
  ok(await api('PUT', '/patrol/review/settings', { token: T.owner, body: { reviewers: [{ user_id: U.director, lead: true }, { user_id: U.backup }], categories: ['injury', 'collision', 'medical', 'lost_person'], nudge_hours: 72 } }));
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

async function newCase(token, { category = 'injury', complaint = 'Left knee pain', outcome = 'treated_released' } = {}) {
  const c = ok(await api('POST', '/patrol/incidents', { token, body: { occurred_at: `${today}T10:15`, location: 'Ridge Run', category, severity: 'moderate', summary: 'Knee injury' } }));
  let p = null;
  if (['injury', 'medical'].includes(category)) {
    p = ok(await api('POST', `/patrol/incidents/${c.id}/patients`, { token, body: { first_name: 'Sam', last_name: 'Skier' } })).id;
    ok(await api('PATCH', `/patrol/incidents/${c.id}/patients/${p}`, { token, body: { chief_complaint: complaint, disposition: outcome } }));
  }
  ok(await api('POST', `/patrol/incidents/${c.id}/responders`, { token, body: { staff_id: S.pat, role: 'lead' } }));
  return { id: c.id, patient: p };
}
const rulesWith = (injury, other = {}) => ({ injury, ...other });

test('a mountain that never changed anything keeps its old mandatory fields', async () => {
  const r = ok(await api('GET', '/patrol/requirements', { token: T.pat }));
  assert.equal(r.version.id, null);
  assert.deepEqual(Object.keys(r.rules.injury).sort(), ['patient.chief_complaint', 'patient.disposition']);
  assert.deepEqual(r.rules.lost_person, {});
  assert.equal(r.can_admin, false);
  assert.ok(r.types.find((t) => t.key === 'lost_person').items.every((i) => i.scope === 'case'));
  assert.ok(r.always.length >= 5);
  // a report with no outcome is held up, as before
  const c = await newCase(T.pat, { outcome: null });
  const res = await api('POST', `/patrol/incidents/${c.id}/submit`, { token: T.pat });
  is(res, 409);
  assert.ok(res.body.details.some((d) => /Outcome/.test(d.message) && d.level === 'submit'));
});

test('only the patrol director changes the requirements, and nonsense is refused', async () => {
  const body = { rules: rulesWith({ 'patient.phone': { level: 'submit' } }) };
  is(await api('PUT', '/patrol/requirements', { token: T.pat, body }), 403);
  is(await api('PUT', '/patrol/requirements', { token: T.owner, body: { rules: { injury: { 'patient.phone': { level: 'urgent' } } } } }), 400);
  is(await api('PUT', '/patrol/requirements', { token: T.owner, body: { rules: { lost_person: { 'patient.phone': { level: 'submit' } } } } }), 400, 'no patient fields on a lost person case');
  const preview = ok(await api('GET', '/patrol/requirements/presets/nsaa', { token: T.owner }));
  assert.ok(preview.changes.length > 10);
  assert.ok(preview.changes.some((x) => x.type === 'lost_person' && x.id === 'case.narrative'));
  is(await api('GET', '/patrol/requirements/presets/nope', { token: T.owner }), 400);
  ok(await api('PUT', '/patrol/requirements', { token: T.owner, body: { rules: preview.rules, preset: 'nsaa' } }));
  const r = ok(await api('GET', '/patrol/requirements', { token: T.owner }));
  assert.equal(r.version.preset, 'nsaa');
  assert.equal(r.history.length, 2, 'the old mandatory fields are kept as the first version');
  assert.match(r.history[1].note, /before report requirements/);
});

test('submit stops on required to submit, lists required to approve, and N/A counts as an answer', async () => {
  ok(await api('PUT', '/patrol/requirements', { token: T.owner, body: { rules: rulesWith({ 'patient.phone': { level: 'submit' }, 'patient.date_of_birth': { level: 'approve' }, 'patient.disposition': { level: 'submit' }, 'patient.handoff_to': { level: 'submit', when: ['transported'] }, 'case.narrative': { level: 'recommended' } }) } }));
  const c = await newCase(T.pat);
  const view = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat }));
  assert.equal(view.requirements.summary.submit_left, 1, 'phone; hand-off only when transported');
  assert.equal(view.requirements.summary.approve_left, 1);
  assert.ok(view.check.some((x) => /Narrative/.test(x.message)), 'recommended items join the report check');
  let res = await api('POST', `/patrol/incidents/${c.id}/submit`, { token: T.pat });
  is(res, 409);
  assert.deepEqual(res.body.details.map((d) => d.field), ['phone']);
  // N/A: never for the name; "other" needs a note; a reason answers it
  is(await api('PUT', `/patrol/incidents/${c.id}/na`, { token: T.pat, body: { scope: 'patient', field: 'name', patient_id: c.patient, reason: 'declined' } }), 400);
  is(await api('PUT', `/patrol/incidents/${c.id}/na`, { token: T.pat, body: { scope: 'patient', field: 'phone', patient_id: c.patient, reason: 'other' } }), 400);
  ok(await api('PUT', `/patrol/incidents/${c.id}/na`, { token: T.pat, body: { scope: 'patient', field: 'phone', patient_id: c.patient, reason: 'declined' } }));
  res = ok(await api('POST', `/patrol/incidents/${c.id}/submit`, { token: T.pat }));
  assert.equal(res.review, 'review');
  assert.deepEqual(res.for_approval.map((x) => x.field), ['date_of_birth']);
  const after = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat }));
  assert.equal(after.patients[0].na.phone.reason, 'declined');
  assert.ok(after.rules_version_id, 'the report keeps the rules it was submitted under');
});

test('approval: judged against the submitted rules; only the Patrol Director approves with an exception', async () => {
  ok(await api('PUT', '/patrol/requirements', { token: T.owner, body: { rules: rulesWith({ 'patient.disposition': { level: 'submit' }, 'patient.date_of_birth': { level: 'approve' }, 'case.weather': { level: 'approve' } }) } }));
  const c = await newCase(T.pat);
  ok(await api('POST', `/patrol/incidents/${c.id}/submit`, { token: T.pat }));
  // tightening the rules afterwards does not move the goalposts for this report
  ok(await api('PUT', '/patrol/requirements', { token: T.owner, body: { rules: rulesWith({ 'patient.disposition': { level: 'submit' }, 'patient.date_of_birth': { level: 'approve' }, 'case.weather': { level: 'approve' }, 'patient.address': { level: 'approve' } }) } }));
  let res = await api('POST', `/patrol/incidents/${c.id}/approve`, { token: T.backup, body: { checklist: ALL } });
  is(res, 409);
  assert.deepEqual(res.body.details.map((d) => d.field).sort(), ['date_of_birth', 'weather']);
  assert.equal(res.body.exceptions_possible, false, 'a backup reviewer cannot approve with an exception');
  const exc = [{ scope: 'patient', field: 'date_of_birth', patient_id: c.patient, reason: 'Patient left before it was taken; phone on file' }];
  is(await api('POST', `/patrol/incidents/${c.id}/approve`, { token: T.backup, body: { checklist: ALL, exceptions: exc } }), 403);
  res = await api('POST', `/patrol/incidents/${c.id}/approve`, { token: T.director, body: { checklist: ALL, exceptions: exc } });
  is(res, 409, 'every gap needs a reason');
  assert.deepEqual(res.body.details.map((d) => d.field), ['weather']);
  is(await api('POST', `/patrol/incidents/${c.id}/approve`, { token: T.director, body: { checklist: ALL, exceptions: [...exc, { scope: 'case', field: 'weather', reason: 'no' }] } }), 400, 'a reason, not a word');
  ok(await api('POST', `/patrol/incidents/${c.id}/approve`, { token: T.director, body: { checklist: ALL, exceptions: [...exc, { scope: 'case', field: 'weather', reason: 'Reported a day later; conditions unknown' }] } }));
  const done = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat }));
  assert.equal(done.report_state, 'approved');
  assert.deepEqual(done.exceptions.map((e) => e.key).sort(), ['date_of_birth', 'weather']);
  assert.equal(done.exceptions[0].approved_by, 'Dana Ridge');
  const [[v]] = await pool.query("SELECT snapshot FROM incident_versions WHERE incident_id = ? AND kind = 'approved' ORDER BY version_no DESC LIMIT 1", [c.id]);
  assert.equal(JSON.parse(v.snapshot).exceptions.length, 2, 'the approved copy, and any copy released from it, shows the exceptions');
});

test('a gap that is required to submit can never be approved with an exception', async () => {
  // no review group for this one: approve straight from draft as the director
  ok(await api('PUT', '/patrol/requirements', { token: T.owner, body: { rules: rulesWith({ 'patient.disposition': { level: 'submit' }, 'patient.phone': { level: 'submit' } }) } }));
  const c = await newCase(T.pat);
  ok(await api('PUT', '/patrol/review/settings', { token: T.owner, body: { reviewers: [], categories: [], nudge_hours: 72 } }));
  const res = await api('POST', `/patrol/incidents/${c.id}/approve`, { token: T.owner, body: { exceptions: [{ scope: 'patient', field: 'phone', patient_id: c.patient, reason: 'Patient declined to give it' }] } });
  is(res, 409);
  assert.match(res.body.error, /cannot be approved with an exception/);
  ok(await api('PUT', '/patrol/review/settings', { token: T.owner, body: { reviewers: [{ user_id: U.director, lead: true }, { user_id: U.backup }], categories: ['injury', 'collision', 'medical', 'lost_person'], nudge_hours: 72 } }));
});

test('every kind of case has its own list', async () => {
  ok(await api('PUT', '/patrol/requirements', { token: T.owner, body: { rules: { injury: {}, lost_person: { 'case.narrative': { level: 'submit' }, 'case.witnesses': { level: 'approve' } } } } }));
  const c = await newCase(T.pat, { category: 'lost_person' });
  let res = await api('POST', `/patrol/incidents/${c.id}/submit`, { token: T.pat });
  is(res, 409);
  assert.deepEqual(res.body.details.map((d) => d.area || d.field), ['narrative']);
  ok(await api('PATCH', `/patrol/incidents/${c.id}`, { token: T.pat, body: { narrative: 'Child separated from parents at the base area; found at the rental shop after 20 minutes.' } }));
  res = ok(await api('POST', `/patrol/incidents/${c.id}/submit`, { token: T.pat }));
  assert.deepEqual(res.for_approval.map((d) => d.field), ['witnesses']);
  // an injury case now needs nothing beyond the always-checked rules
  const i = await newCase(T.pat, { outcome: null });
  ok(await api('POST', `/patrol/incidents/${i.id}/submit`, { token: T.pat }));
});

test('before the patient leaves: each item done or skipped with a reason, and sending twice keeps one copy', async () => {
  ok(await api('PUT', '/patrol/requirements', { token: T.owner, body: { rules: { injury: { 'patient.disposition': { level: 'submit' } }, options: { leave: true } } } }));
  const c = await newCase(T.pat);
  ok(await api('PATCH', `/patrol/incidents/${c.id}/patients/${c.patient}`, { token: T.pat, body: { age_years: 15, form: { equipment: 'area_rental' } } }));
  let view = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat }));
  assert.deepEqual(view.leave.map((i) => [i.item, i.met]), [['contact', false], ['guardian', false], ['rental', false], ['witnesses', false]]);
  let res = await api('POST', `/patrol/incidents/${c.id}/submit`, { token: T.pat });
  is(res, 409);
  assert.equal(res.body.details.filter((d) => d.area === 'leave').length, 4);
  // done: a parent's email and name, the rental number; skipped: witnesses
  ok(await api('PATCH', `/patrol/incidents/${c.id}/patients/${c.patient}`, { token: T.pat, body: { guardian_name: 'Maria Skier', guardian_email: 'maria@example.com', form: { rental_boot: 'B-1142' } } }));
  is(await api('POST', `/patrol/incidents/${c.id}/skips`, { token: T.pat, body: { item: 'witnesses', reason: 'other' } }), 400, 'Other needs a note');
  const skip = { item: 'witnesses', reason: 'other', note: 'Fell alone on an empty run', client_ref: `sk${suffix}`.slice(0, 40).toLowerCase().replace(/[^a-z0-9]/g, '') };
  ok(await api('POST', `/patrol/incidents/${c.id}/skips`, { token: T.pat, body: skip }));
  ok(await api('POST', `/patrol/incidents/${c.id}/skips`, { token: T.pat, body: skip }));
  view = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat }));
  assert.equal(view.skips.length, 1, 'sent twice from a phone, kept once');
  assert.ok(view.leave.every((i) => i.met || i.skip));
  ok(await api('POST', `/patrol/incidents/${c.id}/submit`, { token: T.pat }));
  ok(await api('PUT', '/patrol/requirements', { token: T.owner, body: { rules: { injury: { 'patient.disposition': { level: 'submit' } } } } }));
});

test('a signature and a witness kept on a phone with no signal arrive once, with the time they were taken', async () => {
  const c = await newCase(T.pat);
  const ref = `sg${suffix}`.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
  const img = `data:image/png;base64,${Buffer.from('signature').toString('base64')}`;
  const tz = 'America/New_York';
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(Date.now() - 40 * 60000));
  const g = (t) => p.find((x) => x.type === t).value;
  const signedAt = `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
  const body = { kind: 'patient_acknowledgment', signer_name: 'Sam Skier', patient_id: c.patient, image: img, client_ref: ref, signed_at: signedAt };
  const a = ok(await api('POST', `/patrol/incidents/${c.id}/signatures`, { token: T.pat, body }));
  const b = ok(await api('POST', `/patrol/incidents/${c.id}/signatures`, { token: T.pat, body }));
  assert.equal(a.id, b.id);
  const w = { name: 'Lee Witness', phone: '555-0101', client_ref: `wt${ref}`.slice(0, 40) };
  ok(await api('POST', `/patrol/incidents/${c.id}/witnesses`, { token: T.pat, body: w }));
  ok(await api('POST', `/patrol/incidents/${c.id}/witnesses`, { token: T.pat, body: w }));
  const view = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat }));
  assert.equal(view.signatures.length, 1);
  assert.equal(view.witnesses.length, 1);
  assert.equal(String(view.signatures[0].signed_at).slice(0, 16).replace(' ', 'T'), signedAt, 'kept the time it was signed, not the time it arrived');
});
