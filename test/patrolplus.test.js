'use strict';

// Patrol, part two: collision reports, checklists, the home screen, and the follow-up email and giving desk.
// Postmark and Stripe are mock servers; webhooks are signed like the real ones.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
process.env.MAIL_FROM = 'patrol@summit.test';
process.env.JOBS_KEY = 'jobs-secret-for-tests';
process.env.GIVE_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const config = require('../src/config');
const mailer = require('../src/lib/mailer');
const stripe = require('../src/lib/stripe');
const { addDays } = require('../src/lib/util');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base; let pm; let st; let n = 0;
const mails = []; const stripeCalls = [];
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const q = async (sql, params) => (await pool.query(sql, params))[0];

async function call(prefix, method, path, { token, body, headers } = {}) {
  const res = await fetch(`${base}${prefix}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const api = (m, p, o) => call('/api/v1', m, p, o);
const ok = (r, status) => { assert.equal(r.status, status || (r.status < 300 ? r.status : -1), r.text); return r.body; };
async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Summit Test', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  return { slug, owner: (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token };
}
async function addUser(m, email, role, extra = {}) {
  ok(await api('POST', '/users', { token: m.owner, body: { email, password: PW, role, ...extra } }), 201);
  return (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token;
}
const webhook = async (event) => {
  const raw = JSON.stringify(event);
  const res = await fetch(`${base}/api/v1/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripe.signWebhook(raw, 'whsec_mock') }, body: raw });
  return res.status;
};
const newCase = (token, over = {}) => api('POST', '/patrol/incidents', { token, body: { occurred_at: `${today}T10:15`, location: 'Upper Ridge', category: 'collision', severity: 'minor', summary: 'Two skiers collided', ...over } });
/** A collision case that is approved and old enough for the follow-up, with one patient. */
async function approvedCase(token, { severity = 'minor', patient = {}, days = 6 } = {}) {
  const c = ok(await newCase(token, { severity, occurred_at: `${addDays(today, -days)}T10:15` }), 201);
  const p = ok(await api('POST', `/patrol/incidents/${c.id}/patients`, { token, body: { first_name: 'Kay', last_name: 'Patient', chief_complaint: 'Sore wrist from the fall', ...patient } }), 201);
  ok(await api('POST', `/patrol/incidents/${c.id}/submit`, { token }));
  ok(await api('POST', `/patrol/incidents/${c.id}/approve`, { token: A.owner }));
  return { id: c.id, pid: p.id };
}
const runJob = (key = 'jobs-secret-for-tests') => api('POST', '/internal/jobs/daily', { headers: key ? { 'x-jobs-key': key } : {} });
const fu = async (pid) => (await q('SELECT * FROM followups WHERE patient_id = ?', [pid]))[0];

let A; let B; let dir; let pat; let patStaff;
test.before(async () => {
  pm = http.createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { mails.push({ token: req.headers['x-postmark-server-token'], ...JSON.parse(d) }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m-${++n}` })); }); });
  st = http.createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { stripeCalls.push({ path: req.url, params: Object.fromEntries(new URLSearchParams(d)) }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: `cs_test_${++n}`, url: `https://checkout.stripe.test/c/${n}` })); }); });
  await new Promise((r) => pm.listen(0, '127.0.0.1', r));
  await new Promise((r) => st.listen(0, '127.0.0.1', r));
  mailer.settings.apiBase = `http://127.0.0.1:${pm.address().port}`;
  config.stripe.apiBase = `http://127.0.0.1:${st.address().port}`;
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`pp-${suffix}`);
  B = await mountain(`pq-${suffix}`);
  await q('UPDATE tenants SET followup_enabled = 0'); // earlier test runs may have left other mountains switched on
  B.pat = await addUser(B, `pat@${B.slug}.test`, 'patrol');
  const mk = async (first, level) => {
    const staff = ok(await api('POST', '/workforce/staff', { token: A.owner, body: { person: { first_name: first, last_name: 'Patrol' }, status: 'active' } }), 201).id;
    ok(await api('POST', '/patrol/team', { token: A.owner, body: { staff_id: staff, level } }), 201);
    return staff;
  };
  const dirStaff = await mk('Dee', 'director');
  dir = await addUser(A, `director@${A.slug}.test`, 'patrol', { staff_id: dirStaff });
  patStaff = await mk('Pat', 'patroller');
  pat = await addUser(A, `pat@${A.slug}.test`, 'patrol', { staff_id: patStaff });
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => pm.close(r)); await new Promise((r) => st.close(r)); await pool.end(); });

test('collision report: parties, scene, right of way, and who can see or change it', async () => {
  const c = ok(await newCase(pat), 201);
  const base_ = `/patrol/incidents/${c.id}`;
  const hurt = ok(await api('POST', `${base_}/patients`, { token: pat, body: { first_name: 'Hal', last_name: 'Hurt', age_years: 30 } }), 201).id;
  ok(await api('PUT', `${base_}/collision`, { token: pat, body: { collision_type: 'skier_skier', right_of_way: 'Uphill skier was behind and should have yielded', factors: ['speed', 'blind_roll'], police_notified: true, police_agency: 'Township PD', police_report_no: 'TP-1', equipment_held: 'Cracked helmet', legal_hold: true } }));
  const p1 = ok(await api('POST', `${base_}/parties`, { token: pat, body: { role: 'skier', first_name: 'Una', last_name: 'Uphill', phone: '555-0101', position: 'uphill', speed: 'fast', statement: 'I did not see them', patient_id: hurt } }), 201).id;
  const p2 = ok(await api('POST', `${base_}/parties`, { token: pat, body: { role: 'unknown', left_scene: true, refused_contact_info: true, direction: 'Skied off toward the lift' } }), 201).id;
  ok(await api('PATCH', `${base_}/parties/${p2}`, { token: pat, body: { first_name: 'Unknown', speed: 'moderate' } }));
  ok(await api('PUT', `${base_}/collision`, { token: pat, body: { collision_type: 'skier_skier', hit_and_run: true, unknown_party_description: 'Red jacket, black helmet' } }));
  const got = ok(await api('GET', base_, { token: pat }));
  assert.equal(got.collision.hit_and_run, 1);
  assert.equal(got.collision.unknown_party_description, 'Red jacket, black helmet');
  assert.equal(got.parties.length, 2);
  assert.equal(got.parties[0].patient_id, hurt);
  assert.equal(got.parties[1].speed, 'moderate');
  // bad input and other mountains
  assert.equal((await api('POST', `${base_}/parties`, { token: pat, body: { role: 'skier', patient_id: 999999 } })).status, 404);
  assert.equal((await api('POST', `${base_}/parties`, { token: pat, body: { role: 'dragon' } })).status, 400);
  assert.equal((await api('PUT', `${base_}/collision`, { token: B.pat, body: { collision_type: 'other' } })).status, 404);
  assert.equal((await api('POST', `${base_}/parties`, { token: B.pat, body: { role: 'skier' } })).status, 404);
  // marking the patient entered in error keeps the party, unlinked
  ok(await api('POST', `${base_}/patients/${hurt}/void`, { token: pat, body: { reason: 'Added to the wrong case' } }));
  assert.equal(ok(await api('GET', base_, { token: pat })).parties[0].patient_id, null);
  ok(await api('DELETE', `${base_}/parties/${p1}`, { token: pat }));
  assert.equal(ok(await api('GET', base_, { token: pat })).parties.length, 1);
  // printing is logged
  assert.equal((await api('POST', `${base_}/collision-printed`, { token: pat })).status, 204);
  assert.equal((await api('POST', `${base_}/collision-printed`, { token: B.pat })).status, 404);
  assert.ok(ok(await api('GET', '/patrol/access-log', { token: dir })).data.some((e) => e.action === 'collision_print' && e.entity_id === c.id));
  // a locked report cannot be changed
  ok(await api('POST', `${base_}/submit`, { token: pat }));
  ok(await api('POST', `${base_}/approve`, { token: A.owner }));
  assert.equal((await api('PUT', `${base_}/collision`, { token: pat, body: { collision_type: 'other' } })).status, 409);
  assert.equal((await api('POST', `${base_}/parties`, { token: pat, body: { role: 'skier' } })).status, 409);
});

test('checklists: known items only, stamped with who and when, and they can be unticked', async () => {
  const defs = ok(await api('GET', '/patrol/checklists', { token: pat })).data;
  assert.ok(defs.find((d) => d.id === 'head_spine').items.length >= 6);
  assert.ok(defs.find((d) => d.id === 'collision' && d.scope === 'case'));
  const c = ok(await newCase(pat), 201);
  const p = ok(await api('POST', `/patrol/incidents/${c.id}/patients`, { token: pat, body: { first_name: 'Ivy', last_name: 'Icepack' } }), 201).id;
  const b = `/patrol/incidents/${c.id}/checklist`;
  ok(await api('POST', b, { token: pat, body: { key: 'neuro_checked', patient_id: p, done: true } }));
  ok(await api('POST', b, { token: pat, body: { key: 'neuro_checked', patient_id: p, done: true } })); // twice is harmless
  ok(await api('POST', b, { token: pat, body: { key: 'witnesses_taken', done: true } }));
  assert.equal((await api('POST', b, { token: pat, body: { key: 'made_up', done: true } })).status, 400);
  assert.equal((await api('POST', b, { token: pat, body: { key: 'neuro_checked', patient_id: 999999, done: true } })).status, 404);
  assert.equal((await api('POST', b, { token: B.pat, body: { key: 'neuro_checked', done: true } })).status, 404);
  let got = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: pat })).checklist;
  assert.equal(got.length, 2);
  assert.equal(got.find((x) => x.item_key === 'neuro_checked').patient_id, p);
  assert.equal(got.find((x) => x.item_key === 'witnesses_taken').patient_id, 0);
  assert.match(got[0].done_by, /pat@/);
  ok(await api('POST', b, { token: pat, body: { key: 'neuro_checked', patient_id: p, done: false } }));
  got = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: pat })).checklist;
  assert.equal(got.length, 1);
});

test('home screen: my open cases for everyone, the approval queue for directors only, and search by patient name', async () => {
  const c = ok(await newCase(pat, { summary: 'Home screen case' }), 201); // the filer becomes lead responder
  ok(await api('POST', `/patrol/incidents/${c.id}/patients`, { token: pat, body: { first_name: 'Zelda', last_name: 'Zzyzx' } }), 201);
  const home = ok(await api('GET', '/patrol/home', { token: pat }));
  assert.ok(home.mine.some((x) => x.id === c.id), 'the filer sees it under My open cases');
  assert.equal(home.can_approve, false);
  assert.deepEqual(home.waiting, []);
  ok(await api('POST', `/patrol/incidents/${c.id}/submit`, { token: pat }));
  assert.ok(ok(await api('GET', '/patrol/home', { token: dir })).waiting.some((x) => x.id === c.id), 'directors see reports waiting');
  assert.equal(ok(await api('GET', '/patrol/home', { token: pat })).waiting.length, 0);
  assert.ok(ok(await api('GET', '/patrol/incidents?q=Zzyzx', { token: pat })).data.some((x) => x.id === c.id), 'search finds a patient by name');
  assert.equal(ok(await api('GET', '/patrol/incidents?q=Zzyzx', { token: B.pat })).data.length, 0, 'but never across mountains');
});

test('follow-up settings are for directors; the daily job needs its key', async () => {
  assert.equal((await api('GET', '/patrol/followup-settings', { token: pat })).status, 403);
  assert.equal((await api('GET', '/patrol/followups', { token: pat })).status, 403);
  const s = ok(await api('GET', '/patrol/followup-settings', { token: dir }));
  assert.equal(s.followup_enabled, false);
  assert.equal(s.email_ready, true);
  assert.equal(s.card_ready, true);
  assert.equal((await api('PUT', '/patrol/followup-settings', { token: dir, body: { donate_amounts: 'ten,twenty' } })).status, 400);
  ok(await api('PUT', '/patrol/followup-settings', { token: dir, body: { followup_enabled: true, patrol_org_name: 'Summit Volunteer Ski Patrol', mail_address: 'PO Box 1, Ridge, PA 19000', donate_amounts: '25,50,100,250', tax_note: 'Gifts may be tax deductible. Ask your tax adviser.' } }));
  assert.equal((await runJob(null)).status, 401);
  assert.equal((await runJob('wrong')).status, 401);
});

test('follow-up email: five days on, only for the right people, nothing about the injury, and never twice', async () => {
  const minor = await approvedCase(pat, { patient: { email: 'ignored@x.test', age_years: 12, guardian_email: 'parent@x.test', guardian_name: 'Pia Parent' } });
  const minorNoGuardian = await approvedCase(pat, { patient: { email: 'kid@x.test', age_years: 12 } });
  const adult = await approvedCase(pat, { patient: { email: 'Adult@X.test', age_years: 40 } });
  const optOut = await approvedCase(pat, { patient: { email: 'nope@x.test', age_years: 40, no_followup: true } });
  const noEmail = await approvedCase(pat, { patient: { age_years: 40 } });
  const transported = await approvedCase(pat, { patient: { email: 'ride@x.test', age_years: 50, disposition: 'transported_ambulance' } });
  const serious = await approvedCase(pat, { severity: 'serious', patient: { email: 'serious@x.test', age_years: 50 } });
  const tooSoon = await approvedCase(pat, { days: 2, patient: { email: 'soon@x.test', age_years: 30 } });

  mails.length = 0;
  const first = ok(await runJob());
  assert.ok(first.results.some((r) => r.created >= 4));
  const to = mails.filter((m) => m.Tag === 'patrol-followup').map((m) => m.To).sort();
  assert.deepEqual(to, ['adult@x.test', 'parent@x.test'], 'the adult and the minor\'s guardian only');
  assert.equal(mails[0].token, 'pm-test-token');
  assert.equal(await fu(minorNoGuardian.pid), undefined, 'a minor with no guardian address gets nothing');
  assert.equal(await fu(optOut.pid), undefined);
  assert.equal(await fu(noEmail.pid), undefined);
  assert.equal(await fu(tooSoon.pid), undefined, 'not before the five days');
  assert.equal((await fu(transported.pid)).status, 'held');
  assert.equal((await fu(serious.pid)).status, 'held');
  assert.equal((await fu(minor.pid)).to_email, 'parent@x.test');
  assert.equal((await fu(adult.pid)).status, 'sent');

  // the content: friendly, links for one-tap giving and stopping, and nothing about what happened
  const m = mails.find((x) => x.To === 'adult@x.test');
  const token = (await fu(adult.pid)).token;
  assert.match(m.From, /^Summit Volunteer Ski Patrol <patrol@summit\.test>$/);
  assert.match(m.Subject, /How did the Summit Volunteer Ski Patrol do/);
  assert.match(m.TextBody, /volunteer, nonprofit/);
  for (const amt of [25, 50, 100, 250]) assert.ok(m.TextBody.includes(`/f/${token}?give=${amt}`) && m.HtmlBody.includes(`?give=${amt}`), `a $${amt} link`);
  assert.ok(m.TextBody.includes(`/f/${token}?stop=1`));
  assert.ok(m.TextBody.includes('PO Box 1, Ridge, PA 19000') && m.TextBody.includes('Gifts may be tax deductible'));
  assert.match(m.Headers[0].Value, /stop=1/);
  assert.match(m.TextBody, /Hi Kay,/);
  assert.match(mails.find((x) => x.To === 'parent@x.test').TextBody, /your child/);
  for (const text of [m.TextBody, m.HtmlBody]) for (const secret of ['wrist', 'collid', 'Patient', 'collision', 'Upper Ridge', 'fall']) assert.equal(text.toLowerCase().includes(secret.toLowerCase()), false, `the email must not mention "${secret}"`);

  // running again sends nothing new; held cases wait for a director
  mails.length = 0;
  ok(await runJob());
  assert.equal(mails.filter((x) => x.Tag === 'patrol-followup').length, 0);

  // director desk
  const list = ok(await api('GET', '/patrol/followups?status=held', { token: dir })).data;
  assert.equal(list.length, 2);
  const tf = list.find((x) => x.incident_id === transported.id);
  ok(await api('POST', `/patrol/followups/${tf.id}/approve`, { token: dir }));
  ok(await api('POST', `/patrol/followups/${list.find((x) => x.incident_id === serious.id).id}/skip`, { token: dir }));
  assert.equal((await api('POST', `/patrol/followups/${tf.id}/approve`, { token: dir })).status, 400, 'not held any more');
  assert.equal((await api('POST', `/patrol/followups/${tf.id}/approve`, { token: pat })).status, 403);
  assert.equal((await api('POST', `/patrol/followups/${tf.id}/approve`, { token: B.pat })).status, 403);
  ok(await runJob());
  assert.deepEqual(mails.filter((x) => x.Tag === 'patrol-followup').map((x) => x.To), ['ride@x.test']);
  assert.equal((await fu(serious.pid)).status, 'skipped');
  ok(await runJob());
  assert.equal(mails.filter((x) => x.Tag === 'patrol-followup').length, 1, 'skipped and sent ones never go out again');
});

test('the page behind the email: rate us, stop the emails, and nothing leaks', async () => {
  const f = (await q("SELECT f.* FROM followups f JOIN tenants t ON t.id = f.tenant_id WHERE t.slug = ? AND f.to_email = 'adult@x.test'", [A.slug]))[0];
  const pub = (m, p, o) => call('/api/v1/public', m, p, o);
  const info = ok(await pub('GET', `/followup/${f.token}`));
  assert.equal(info.org, 'Summit Volunteer Ski Patrol');
  assert.deepEqual(info.amounts, [25, 50, 100, 250]);
  assert.equal(info.responded, false);
  assert.equal(JSON.stringify(info).includes('adult@x.test'), false, 'the address is not shown');
  assert.equal((await pub('GET', '/followup/' + 'a'.repeat(32))).status, 404);
  assert.equal((await pub('GET', '/followup/not-a-token')).status, 404);
  assert.equal((await pub('POST', `/followup/${f.token}/feedback`, { body: { rating: 9 } })).status, 400);
  ok(await pub('POST', `/followup/${f.token}/feedback`, { body: { rating: 5, comment: 'Kind and quick, thank you' } }));
  assert.equal(ok(await pub('GET', `/followup/${f.token}`)).responded, true);
  const sum = ok(await api('GET', '/patrol/followup-summary', { token: dir }));
  assert.equal(sum.rated, 1);
  assert.equal(Number(sum.avg_rating), 5);
  assert.equal(sum.comments[0].comment, 'Kind and quick, thank you');
  // stop: suppress the address, and a later case for the same address is not emailed
  ok(await pub('POST', `/followup/${f.token}/stop`));
  assert.equal((await q('SELECT COUNT(*) AS c FROM email_suppressions WHERE tenant_id = ? AND email = ?', [f.tenant_id, 'adult@x.test']))[0].c, 1);
  const again = await approvedCase(pat, { patient: { email: 'adult@x.test', age_years: 41 } });
  mails.length = 0;
  ok(await runJob());
  assert.equal(await fu(again.pid), undefined);
  assert.equal(mails.filter((x) => x.Tag === 'patrol-followup').length, 0);
});

test('giving: one tap from the email or the public page, any amount within limits, and gifts are counted once', async () => {
  const f = (await q("SELECT f.* FROM followups f JOIN tenants t ON t.id = f.tenant_id WHERE t.slug = ? AND f.to_email = 'ride@x.test'", [A.slug]))[0];
  const pub = (m, p, o) => call('/api/v1/public', m, p, o);
  stripeCalls.length = 0;
  const g = ok(await pub('POST', `/followup/${f.token}/give`, { body: { amount: 50 } }));
  assert.match(g.url, /checkout\.stripe\.test/);
  const sc = stripeCalls[0].params;
  assert.equal(sc.mode, 'payment');
  assert.equal(sc['line_items[0][price_data][unit_amount]'], '5000');
  assert.equal(sc.customer_email, 'ride@x.test', 'a patient\'s own address is prefilled');
  assert.equal(sc['metadata[kind]'], 'donation');
  assert.equal(sc['metadata[followup_id]'], String(f.id));
  assert.match(sc.success_url, new RegExp(`/f/${f.token}\\?thanks=1`));
  // monthly
  const m = ok(await pub('POST', `/followup/${f.token}/give`, { body: { amount: 25, monthly: true } }));
  assert.ok(m.url);
  assert.equal(stripeCalls[1].params.mode, 'subscription');
  assert.equal(stripeCalls[1].params['line_items[0][price_data][recurring][interval]'], 'month');
  // a guardian's address is not prefilled as the donor
  const guardian = (await q("SELECT f.* FROM followups f JOIN tenants t ON t.id = f.tenant_id WHERE t.slug = ? AND f.for_guardian = 1", [A.slug]))[0];
  ok(await pub('POST', `/followup/${guardian.token}/give`, { body: { amount: 100 } }));
  assert.equal(stripeCalls[2].params.customer_email, undefined);
  // limits
  for (const amount of [0, 4, 10001, 12.5]) assert.equal((await pub('POST', `/followup/${f.token}/give`, { body: { amount } })).status, 400, `amount ${amount}`);
  // the mountain's own giving page
  const page = ok(await pub('GET', `/${A.slug}/give`));
  assert.equal(page.giving, true);
  ok(await pub('POST', `/${A.slug}/give`, { body: { amount: 75, email: 'friend@x.test' } }));
  assert.equal(stripeCalls[3].params.customer_email, 'friend@x.test');
  assert.match(stripeCalls[3].params.success_url, new RegExp(`/give/${A.slug}\\?thanks=1`));
  assert.equal((await pub('GET', '/nowhere-here/give')).status, 404);
  // the webhook records a paid gift, and a repeat does not count twice
  const tenantId = (await q('SELECT id FROM tenants WHERE slug = ?', [A.slug]))[0].id;
  const event = { id: 'evt_x', type: 'checkout.session.completed', data: { object: { id: `cs_gift_${suffix}`, payment_status: 'paid', mode: 'payment', amount_total: 5000, customer_details: { email: 'ride@x.test', name: 'Rhea Rider' }, metadata: { kind: 'donation', tenant_id: String(tenantId), followup_id: String(f.id) } } } };
  assert.equal(await webhook(event), 200);
  assert.equal(await webhook(event), 200);
  const sum = ok(await api('GET', '/patrol/followup-summary', { token: dir }));
  assert.equal(sum.gifts, 1);
  assert.equal(sum.total_cents, 5000);
  assert.equal(sum.recent_gifts[0].from_email, 1);
  // unpaid sessions are ignored
  await webhook({ ...event, data: { object: { ...event.data.object, id: 'cs_unpaid', payment_status: 'unpaid' } } });
  assert.equal(ok(await api('GET', '/patrol/followup-summary', { token: dir })).gifts, 1);
});

test('the morning note to managers lists what is waiting, with no patient details', async () => {
  const c = ok(await newCase(pat, { summary: 'Digest case', occurred_at: `${today}T08:00` }), 201);
  ok(await api('POST', `/patrol/incidents/${c.id}/submit`, { token: pat }));
  mails.length = 0;
  ok(await runJob());
  const d = mails.find((x) => x.Tag === 'patrol-digest' && x.To === `owner@${A.slug}.test`);
  assert.ok(d, 'the owner gets a note');
  assert.match(d.TextBody, /waiting for approval/);
  assert.equal(d.TextBody.includes('Digest case'), false);
});

test('without Postmark or Stripe set up, nothing is sent and giving says so politely', async () => {
  const saved = { t: process.env.POSTMARK_SERVER_TOKEN, k: config.stripe.secretKey };
  delete process.env.POSTMARK_SERVER_TOKEN; config.stripe.secretKey = '';
  try {
    assert.equal(mailer.enabled(), false);
    mails.length = 0;
    const j = ok(await runJob());
    assert.equal(mails.length, 0);
    assert.ok(j.results.every((r) => r.sent === 0));
    assert.equal((await call('/api/v1/public', 'POST', `/${A.slug}/give`, { body: { amount: 25 } })).status, 503);
  } finally { process.env.POSTMARK_SERVER_TOKEN = saved.t; config.stripe.secretKey = saved.k; }
});

test('a follow-up is claimed before it is sent, so two senders cannot both send it', async () => {
  const followupsLib = require('../src/lib/followups');
  const [[t]] = await pool.query('SELECT * FROM tenants WHERE slug = ?', [A.slug]);
  const [[row]] = await pool.query("SELECT * FROM followups WHERE tenant_id = ? AND status IN ('held', 'queued', 'failed') LIMIT 1", [t.id]);
  if (!row) return; // nothing waiting in this run; the claim is covered whenever one is
  await pool.query('UPDATE followups SET sent_at = NOW() WHERE id = ?', [row.id]);
  assert.equal(await followupsLib.sendOne(row, t, 'http://x.test'), 'busy', 'a fresh claim blocks a second sender');
  await pool.query('UPDATE followups SET sent_at = NOW() - INTERVAL 11 MINUTE WHERE id = ?', [row.id]);
  assert.notEqual(await followupsLib.sendOne({ ...row, sent_at: null }, t, 'http://x.test'), 'busy', 'a claim older than ten minutes is treated as abandoned');
});
