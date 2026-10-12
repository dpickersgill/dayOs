'use strict';

// Patrol case review: a signed-off report goes to the review group (the Patrol Director and named backups) when its
// kind of case is one the group reviews; a reviewer approves it (with the review checks), sends it back with comments,
// or escalates it; nobody reviews their own report; the group hears about new reports and gets a nudge after 72 hours
// in its own Inbox conversation; the patroller hears back in a one-to-one message.
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

const T = {}; const U = {}; const S = {}; let slug; let tenantId;
test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  slug = `rv-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Review Peak', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
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
  [[{ id: tenantId }]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

/** A report ready to sign off: one patient with a chief complaint and an outcome. */
async function readyCase(token, category = 'injury', summary = 'Knee injury') {
  const c = ok(await api('POST', '/patrol/incidents', { token, body: { occurred_at: `${today}T10:15`, location: 'Ridge Run', category, severity: 'moderate', summary } }));
  const p = ok(await api('POST', `/patrol/incidents/${c.id}/patients`, { token, body: { first_name: 'Sam', last_name: 'Skier' } }));
  ok(await api('PATCH', `/patrol/incidents/${c.id}/patients/${p.id}`, { token, body: { chief_complaint: 'Left knee pain', disposition: 'treated_released' } }));
  const lead = Object.keys(T).find((k) => T[k] === token);
  ok(await api('POST', `/patrol/incidents/${c.id}/responders`, { token, body: { staff_id: S[lead] || S.pat, role: 'lead' } }));
  return { id: c.id, patient: p.id };
}
const groupMessages = async (token) => {
  const s = ok(await api('GET', '/patrol/review/settings', { token }));
  return ok(await api('GET', `/inbox/threads/${s.thread_id}/messages?limit=100`, { token })).data;
};
const directFrom = async (token, name) => {
  const t = ok(await api('GET', '/inbox/threads', { token })).data.find((x) => x.kind === 'direct' && x.title === name);
  return t ? ok(await api('GET', `/inbox/threads/${t.id}/messages`, { token })).data : [];
};

test('setting up the review group: who may, and its own Inbox conversation', async () => {
  const body = { reviewers: [{ user_id: U.director, lead: true }, { user_id: U.backup }], categories: ['injury', 'collision', 'medical'], nudge_hours: 72 };
  is(await api('PUT', '/patrol/review/settings', { token: T.pat, body }), 403, 'a patroller is neither a patrol admin nor in the group');
  is(await api('PUT', '/patrol/review/settings', { token: T.owner, body: { ...body, reviewers: [{ user_id: U.director, lead: true }, { user_id: U.backup, lead: true }] } }), 400, 'one director');
  is(await api('PUT', '/patrol/review/settings', { token: T.owner, body: { ...body, categories: [] } }), 400);
  const s = ok(await api('PUT', '/patrol/review/settings', { token: T.owner, body }));
  assert.equal(s.enabled, true); assert.deepEqual(s.categories, ['injury', 'collision', 'medical']);
  assert.equal(s.reviewers.find((r) => r.lead).name, 'Dana Ridge');
  // the group (not only admins) chooses which kinds of case it reviews
  ok(await api('PUT', '/patrol/review/settings', { token: T.backup, body: { ...body, categories: ['injury', 'collision', 'medical', 'lost_person'] } }));
  const director = ok(await api('GET', '/inbox/threads', { token: T.director })).data.find((t) => t.title === R.THREAD_NAME);
  assert.ok(director, 'the group has its own conversation');
  assert.ok(!ok(await api('GET', '/inbox/threads', { token: T.pat })).data.some((t) => t.title === R.THREAD_NAME), 'patrollers are not in it');
  is(await api('POST', `/inbox/threads/${director.id}/leave`, { token: T.director }), 403, 'left by leaving the group, not the conversation');
  const me = ok(await api('GET', '/patrol/me', { token: T.director }));
  assert.equal(me.is_reviewer, true); assert.equal(me.can_manage_review, true);
  assert.equal(ok(await api('GET', '/patrol/me', { token: T.pat })).is_reviewer, false);
});

test('sign off, then approve with the review checks; nobody else edits it meanwhile', async () => {
  const c = await readyCase(T.pat);
  assert.equal(ok(await api('POST', `/patrol/incidents/${c.id}/submit`, { token: T.pat })).review, 'review');
  const note = (await groupMessages(T.director)).find((m) => m.links.some((l) => l.id === c.id));
  assert.match(note.body, /Pat Ridge signed off Case .* Waiting for review/);
  is(await api('PATCH', `/patrol/incidents/${c.id}/patients/${c.patient}`, { token: T.pat, body: { assessment: 'late' } }), 409);
  is(await api('PATCH', `/patrol/incidents/${c.id}/patients/${c.patient}`, { token: T.owner, body: { assessment: 'edit' } }), 409, 'not even the owner edits a report under review');
  is(await api('POST', `/patrol/incidents/${c.id}/approve`, { token: T.owner, body: { checklist: ALL } }), 403, 'the owner is not in the review group');
  is(await api('POST', `/patrol/incidents/${c.id}/approve`, { token: T.director, body: {} }), 400, 'the review checks first');
  const queue = ok(await api('GET', '/patrol/review/queue', { token: T.backup })).data;
  assert.ok(queue.some((q) => q.id === c.id && q.submitted_by === 'Pat Ridge'));
  ok(await api('POST', `/patrol/incidents/${c.id}/approve`, { token: T.director, body: { checklist: ALL, note: 'Well written' } }));
  const done = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat }));
  assert.equal(done.report_state, 'approved');
  assert.equal(done.review.history[0].outcome, 'approved'); assert.equal(done.review.history[0].reviewer, 'Dana Ridge');
  assert.deepEqual(done.review.history[0].checklist, ALL);
  const dm = await directFrom(T.pat, 'Dana Ridge');
  assert.ok(dm.some((m) => /was reviewed and approved\. Note: Well written/.test(m.body) && m.links[0].id === c.id));
});

test('sent back with comments, corrected, signed again, approved', async () => {
  const c = await readyCase(T.pat, 'collision', 'Two skiers collided');
  ok(await api('POST', `/patrol/incidents/${c.id}/submit`, { token: T.pat }));
  is(await api('POST', `/patrol/incidents/${c.id}/return`, { token: T.backup, body: { comments: [] } }), 400, 'at least one comment');
  is(await api('POST', `/patrol/incidents/${c.id}/return`, { token: T.backup, body: { comments: [{ section: 'Salary', text: 'nope' }] } }), 400);
  ok(await api('POST', `/patrol/incidents/${c.id}/return`, { token: T.backup, body: { comments: [{ section: 'Narrative', text: 'Add the time you arrived on scene' }, { section: 'Witnesses', text: 'Get the other skier\'s phone number' }] } }));
  const back = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat }));
  assert.equal(back.report_state, 'draft');
  assert.equal(back.review.changes_requested.by, 'Ben Ridge');
  assert.deepEqual(back.review.changes_requested.comments.map((x) => x.section), ['Narrative', 'Witnesses']);
  const dm = await directFrom(T.pat, 'Ben Ridge');
  assert.ok(dm.some((m) => /needs changes[\s\S]*Narrative: Add the time/.test(m.body)));
  ok(await api('PATCH', `/patrol/incidents/${c.id}`, { token: T.pat, body: { narrative: 'Arrived on scene at 10:22.' } }));
  ok(await api('POST', `/patrol/incidents/${c.id}/submit`, { token: T.pat }));
  assert.ok((await groupMessages(T.director)).some((m) => /corrected and signed again/.test(m.body)));
  assert.equal(ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat })).review.changes_requested, null, 'signed again: no longer waiting on changes');
  ok(await api('POST', `/patrol/incidents/${c.id}/approve`, { token: T.director, body: { checklist: ALL } }));
  const h = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.director })).review.history;
  assert.deepEqual(h.map((x) => [x.round, x.outcome]), [[1, 'returned'], [2, 'approved']]);
});

test('nobody reviews their own report; kinds the group does not review are signed off directly', async () => {
  const own = await readyCase(T.director, 'medical', 'Lightheaded skier');
  ok(await api('POST', `/patrol/incidents/${own.id}/submit`, { token: T.director }));
  is(await api('POST', `/patrol/incidents/${own.id}/approve`, { token: T.director, body: { checklist: ALL } }), 403);
  is(await api('POST', `/patrol/incidents/${own.id}/return`, { token: T.director, body: { comments: [{ section: 'Other', text: 'self review' }] } }), 403);
  assert.equal(ok(await api('GET', `/patrol/incidents/${own.id}`, { token: T.director })).review.own_report, true);
  ok(await api('POST', `/patrol/incidents/${own.id}/approve`, { token: T.backup, body: { checklist: ALL } }));

  const gear = await readyCase(T.pat, 'equipment', 'Broken binding');
  assert.equal(ok(await api('POST', `/patrol/incidents/${gear.id}/submit`, { token: T.pat })).review, 'not_required');
  const g = ok(await api('GET', `/patrol/incidents/${gear.id}`, { token: T.pat }));
  assert.equal(g.report_state, 'approved');
  assert.equal(g.review.history[0].outcome, 'not_required');
  assert.ok(!ok(await api('GET', '/patrol/review/queue', { token: T.director })).data.some((q) => q.id === gear.id));
});

test('escalate tells the owner and managers; reopening is for approved reports only', async () => {
  const c = await readyCase(T.pat, 'injury', 'Possible fracture, guest upset');
  ok(await api('POST', `/patrol/incidents/${c.id}/submit`, { token: T.pat }));
  is(await api('POST', `/patrol/incidents/${c.id}/reopen`, { token: T.director, body: { reason: 'old way' } }), 409, 'send it back instead');
  const out = ok(await api('POST', `/patrol/incidents/${c.id}/escalate`, { token: T.director, body: { note: 'Guest mentioned a lawyer' } }));
  assert.equal(out.told, 1);
  const dm = await directFrom(T.owner, 'Dana Ridge');
  assert.ok(dm.some((m) => /Escalated: Case .* Guest mentioned a lawyer/.test(m.body)));
  const c2 = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.backup }));
  assert.equal(c2.report_state, 'submitted', 'it still needs a review decision');
  assert.equal(c2.review.escalated.note, 'Guest mentioned a lawyer');
  ok(await api('POST', `/patrol/incidents/${c.id}/approve`, { token: T.backup, body: { checklist: ALL } }));
  is(await api('POST', `/patrol/incidents/${c.id}/reopen`, { token: T.pat, body: { reason: 'not mine to reopen' } }), 403);
  ok(await api('POST', `/patrol/incidents/${c.id}/reopen`, { token: T.director, body: { reason: 'Add the ambulance number' } }));
});

test('a nudge after 72 hours, then again every 72 hours until it is reviewed', async () => {
  const c = await readyCase(T.pat, 'injury', 'Waiting a while');
  ok(await api('POST', `/patrol/incidents/${c.id}/submit`, { token: T.pat }));
  assert.equal(await R.nudgeTenant(tenantId), 0, 'not yet');
  await pool.query('UPDATE incidents SET submitted_at = DATE_SUB(submitted_at, INTERVAL 73 HOUR) WHERE id = ?', [c.id]);
  assert.equal(await R.nudgeTenant(tenantId), 1);
  const msg = (await groupMessages(T.backup)).filter((m) => /^Reminder:/.test(m.body));
  assert.ok(msg.some((m) => /waiting for review for 72 hours or more/.test(m.body) && m.links.some((l) => l.id === c.id)));
  assert.equal(await R.nudgeTenant(tenantId), 0, 'once per 72 hours');
  await pool.query('UPDATE incidents SET last_nudge_at = DATE_SUB(last_nudge_at, INTERVAL 73 HOUR) WHERE id = ?', [c.id]);
  assert.equal(await R.nudgeTenant(tenantId), 1, 'and again');
  ok(await api('POST', `/patrol/incidents/${c.id}/approve`, { token: T.director, body: { checklist: ALL } }));
  await pool.query('UPDATE incidents SET last_nudge_at = DATE_SUB(last_nudge_at, INTERVAL 200 HOUR) WHERE id = ?', [c.id]);
  assert.equal(await R.nudgeTenant(tenantId), 0, 'reviewed: no more nudges');
  // the unread count of a reviewer goes up when a nudge arrives
  assert.ok(ok(await api('GET', '/inbox/unread', { token: T.backup })).unread >= 1);
});

test('fixes from the review: nothing gets stuck, nothing gets around the group', async () => {
  // a report of a kind the group stops reviewing still waits in the queue and gets nudged
  const c = await readyCase(T.pat, 'medical', 'Dizzy at the summit');
  ok(await api('POST', `/patrol/incidents/${c.id}/submit`, { token: T.pat }));
  const body = { reviewers: [{ user_id: U.director, lead: true }, { user_id: U.backup }], categories: ['injury', 'collision'], nudge_hours: 72 };
  ok(await api('PUT', '/patrol/review/settings', { token: T.backup, body }));
  assert.ok(ok(await api('GET', '/patrol/review/queue', { token: T.director })).data.some((q) => q.id === c.id), 'still in the queue');
  await pool.query('UPDATE incidents SET submitted_at = DATE_SUB(submitted_at, INTERVAL 80 HOUR) WHERE id = ?', [c.id]);
  assert.ok(await R.nudgeTenant(tenantId) >= 1);
  ok(await api('POST', `/patrol/incidents/${c.id}/approve`, { token: T.director, body: { checklist: ALL } }));
  // only a patrol admin turns review off (a member cannot empty the group to get round it)
  is(await api('PUT', '/patrol/review/settings', { token: T.director, body: { reviewers: [], categories: [], nudge_hours: 72 } }), 403);
  // the type of case stays once signed off, so a sent-back report cannot be moved out of review
  const d = await readyCase(T.pat, 'injury', 'Shoulder');
  ok(await api('POST', `/patrol/incidents/${d.id}/submit`, { token: T.pat }));
  ok(await api('POST', `/patrol/incidents/${d.id}/return`, { token: T.director, body: { comments: [{ section: 'Narrative', text: 'More detail please' }] } }));
  is(await api('PATCH', `/patrol/incidents/${d.id}`, { token: T.pat, body: { category: 'other' } }), 409);
  ok(await api('POST', `/patrol/incidents/${d.id}/submit`, { token: T.pat }));
  // the submitter cannot escalate their own report; a report is escalated once
  is(await api('POST', `/patrol/incidents/${d.id}/escalate`, { token: T.pat, body: { note: 'me' } }), 403);
  ok(await api('POST', `/patrol/incidents/${d.id}/escalate`, { token: T.backup, body: { note: 'Possible claim' } }));
  is(await api('POST', `/patrol/incidents/${d.id}/escalate`, { token: T.director, body: { note: 'again' } }), 409);
  assert.equal(ok(await api('GET', `/patrol/incidents/${d.id}`, { token: T.pat })).review.escalated, null, 'the reason is not shown to the patroller');
  ok(await api('POST', `/patrol/incidents/${d.id}/approve`, { token: T.director, body: { checklist: ALL } }));
  // reopened later: the old "changes requested" does not come back
  ok(await api('POST', `/patrol/incidents/${d.id}/reopen`, { token: T.director, body: { reason: 'Add the ambulance number' } }));
  assert.equal(ok(await api('GET', `/patrol/incidents/${d.id}`, { token: T.pat })).review.changes_requested, null);
  // the group's conversation is managed by the group
  const s = ok(await api('GET', '/patrol/review/settings', { token: T.director }));
  is(await api('POST', `/inbox/threads/${s.thread_id}/members`, { token: T.director, body: { user_ids: [U.pat] } }), 403);
  is(await api('PATCH', `/inbox/threads/${s.thread_id}`, { token: T.director, body: { name: 'x' } }), 403);
  // a kind not reviewed is signed off with an approved copy kept
  const g = await readyCase(T.pat, 'equipment', 'Bent pole');
  ok(await api('POST', `/patrol/incidents/${g.id}/submit`, { token: T.pat }));
  const [[v]] = await pool.query("SELECT GROUP_CONCAT(kind) AS kinds FROM incident_versions WHERE incident_id = ?", [g.id]);
  assert.equal(v.kinds, 'approved');
});

test('removing everyone turns the group off and the older approval rule applies again', async () => {
  ok(await api('PUT', '/patrol/review/settings', { token: T.owner, body: { reviewers: [], categories: [], nudge_hours: 72 } }));
  const c = await readyCase(T.pat);
  ok(await api('POST', `/patrol/incidents/${c.id}/submit`, { token: T.pat }));
  ok(await api('POST', `/patrol/incidents/${c.id}/approve`, { token: T.owner }));
  assert.ok(!ok(await api('GET', '/inbox/threads', { token: T.director })).data.some((t) => t.title === R.THREAD_NAME), 'they left its conversation');
});
