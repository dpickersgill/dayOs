'use strict';

// Staff injuries, first step: patrol marks a patient as staff on duty, staff off duty or a volunteer on duty. The owner
// and GM are told (once, and again if the patient goes to hospital), staff hurt while working are not counted as guests,
// and they never get the guest follow-up email.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
const http = require('http');

const mails = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => { try { mails.push(JSON.parse(body)); } catch (_) { /* not JSON */ } res.setHeader('content-type', 'application/json'); res.end('{"ErrorCode":0,"MessageID":"x"}'); });
}).listen(0);
process.env.POSTMARK_API_BASE = `http://127.0.0.1:${stub.address().port}`;
process.env.POSTMARK_SERVER_TOKEN = 'test-token';
process.env.MAIL_FROM = 'patrol@test.example';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const SI = require('../src/lib/staffinjury');
const followups = require('../src/lib/followups');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const slug = `si-${suffix}`;
const owner = `owner@${slug}.test`;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const T = {};

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
const toOwner = () => mails.filter((m) => m.To === owner);

test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => { server.on('listening', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Staff Hurt Peak', owner: { email: owner, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  T.owner = (await api('POST', '/auth/login', { body: { tenant: slug, email: owner, password: PW } })).body.token;
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
  T.id = t.id;
  const s1 = ok(await api('POST', '/workforce/staff', { token: T.owner, body: { person: { first_name: 'Pat', last_name: 'Rescuer' }, status: 'active' } })).id;
  ok(await api('POST', '/patrol/team', { token: T.owner, body: { staff_id: s1, callsign: 'Patrol 4', patrol_number: '417' } }));
  ok(await api('POST', '/users', { token: T.owner, body: { email: `pat@${slug}.test`, password: PW, role: 'patrol', staff_id: s1 } }));
  T.pat = (await api('POST', '/auth/login', { body: { tenant: slug, email: `pat@${slug}.test`, password: PW } })).body.token;
});
test.after(async () => { await new Promise((r) => server.close(r)); stub.close(); await pool.end(); });

const newCase = async (name, over = {}) => ok(await api('POST', '/patrol/incidents', { token: T.pat, body: { occurred_at: `${today}T10:15`, location: 'Lift 2 top', category: 'injury', severity: 'moderate', summary: 'Hurt at work', patient: name, ...over } }));

test('who the patient is: legacy activity "staff" counts as on duty; on duty is left out of guest figures', () => {
  assert.equal(SI.kindOf({ form: { patient_type: 'staff_work' } }), 'staff_work');
  assert.equal(SI.kindOf({ form: JSON.stringify({ patient_type: 'volunteer_work' }) }), 'volunteer_work');
  assert.equal(SI.kindOf({ form: null, activity: 'staff' }), 'staff_work');
  assert.equal(SI.kindOf({ form: { patient_type: 'guest' } }), null);
  assert.equal(SI.onDuty({ form: { patient_type: 'staff_off' } }), false);
  assert.equal(SI.onDuty({ form: { patient_type: 'volunteer_work' } }), true);
  const m = SI.message({ name: 'X' }, { id: 1, case_number: '2026-0001', occurred_at: '2026-12-01 10:00:00', location: 'Base' }, { first_name: 'Val', last_name: 'Unteer', disposition: 'transported_ambulance' }, 'volunteer_work', true, 'http://x/#/patrol/case/1');
  assert.match(m.text, /volunteer/i); assert.match(m.text, /8 hours/); assert.match(m.text, /1-800-321-6742/);
  assert.match(m.subject, /went to hospital/);
});

test('marking a patient staff on duty tells the owner once, and again (once) when they go to hospital', async () => {
  const c = await newCase({ first_name: 'Liam', last_name: 'Liftop' });
  const path = `/patrol/incidents/${c.id}/patients/${c.patient_id}`;
  const before = toOwner().length;
  ok(await api('PATCH', path, { token: T.pat, body: { form: { patient_type: 'staff_work' } } }));
  const first = toOwner().slice(before);
  assert.equal(first.length, 1);
  assert.match(first[0].Subject, /Staff injury: Liam Liftop \(staff member, on duty\)/);
  assert.match(first[0].TextBody, /tell your workers' comp insurer/i);
  assert.doesNotMatch(first[0].TextBody, /went to hospital or the case is critical/);
  // saving again does not send again
  ok(await api('PATCH', path, { token: T.pat, body: { form: { patient_type: 'staff_work' }, chief_complaint: 'Cut hand' } }));
  assert.equal(toOwner().length, before + 1);
  assert.doesNotMatch(first[0].TextBody, /Cut hand/, 'the notice never carries the injury');
  // off to hospital: one more notice, with OSHA's deadlines
  ok(await api('PATCH', path, { token: T.pat, body: { disposition: 'transported_ambulance' } }));
  const second = toOwner().slice(before + 1);
  assert.equal(second.length, 1);
  assert.match(second[0].Subject, /went to hospital/);
  assert.match(second[0].TextBody, /within 24 hours/);
  ok(await api('PATCH', path, { token: T.pat, body: { disposition: 'transported_ambulance' } }));
  assert.equal(toOwner().length, before + 2);
});

test('off duty stays a guest case but the owner is told; a guest is never reported', async () => {
  const off = await newCase({ first_name: 'Olga', last_name: 'Offday' });
  const before = toOwner().length;
  ok(await api('PATCH', `/patrol/incidents/${off.id}/patients/${off.patient_id}`, { token: T.pat, body: { form: { patient_type: 'staff_off' }, disposition: 'transported_private' } }));
  const got = toOwner().slice(before);
  assert.equal(got.length, 1, 'off duty: one notice, no hospital escalation');
  assert.match(got[0].TextBody, /stays a guest case/);
  const guest = await newCase({ first_name: 'Gus', last_name: 'Guest' });
  ok(await api('PATCH', `/patrol/incidents/${guest.id}/patients/${guest.patient_id}`, { token: T.pat, body: { form: { patient_type: 'guest' }, disposition: 'transported_ambulance' } }));
  assert.equal(toOwner().length, before + 1);
});

test('a volunteer on duty: flagged for the owner, no guest follow-up email, not in guest figures', async () => {
  const c = await newCase({ first_name: 'Vera', last_name: 'Volunteer' });
  const before = toOwner().length;
  ok(await api('PATCH', `/patrol/incidents/${c.id}/patients/${c.patient_id}`, { token: T.pat, body: { form: { patient_type: 'volunteer_work', activity: 'alpine' }, email: 'vera@example.test' } }));
  assert.match(toOwner().slice(before)[0].TextBody, /depends on your state and your insurer/);
  const g = await newCase({ first_name: 'Gina', last_name: 'Guest' });
  ok(await api('PATCH', `/patrol/incidents/${g.id}/patients/${g.patient_id}`, { token: T.pat, body: { form: { activity: 'alpine' }, email: 'gina@example.test' } }));
  // As if both reports were approved five days ago: only the guest is queued for the follow-up email.
  await pool.query("UPDATE incidents SET report_state = 'approved', occurred_at = DATE_SUB(occurred_at, INTERVAL 6 DAY) WHERE tenant_id = ? AND id IN (?, ?)", [T.id, c.id, g.id]);
  const [[tenant]] = await pool.query('SELECT * FROM tenants WHERE id = ?', [T.id]);
  await followups.queueDue(tenant, today);
  const [queued] = await pool.query('SELECT patient_id FROM followups WHERE tenant_id = ?', [T.id]);
  const ids = queued.map((q) => Number(q.patient_id));
  assert.ok(ids.includes(Number(g.patient_id)), 'the guest is queued');
  assert.ok(!ids.includes(Number(c.patient_id)), 'the volunteer is not');
  const a = ok(await api('GET', `/patrol/analytics?from=${today.slice(0, 4)}-01-01&to=${today}`, { token: T.owner }));
  assert.ok(a.staff_patients_on_duty >= 2, 'Liam and Vera');
  const skiers = (a.patients_by_activity.find((x) => x.label === 'alpine') || { n: 0 }).n;
  assert.equal(skiers, 1, 'only the guest skier counts toward guest activity');
});
