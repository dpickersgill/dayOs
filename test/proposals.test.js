'use strict';

// Prepared actions (AI release 1, lib/proposals.js) and the first kind, the conditions writer (lib/conditionswriter.js).
// Approving re-checks the person's role and apps, applies their edits, runs as them through the screen's own code, audits
// the decision and the outcome, and only once when two people press Approve together. Expired drafts cannot be approved,
// and a handler that fails is recorded. The writer publishes the conditions note on Approve, emails passholders only when
// a manager ticks it, keeps to the facts, and falls back to a template. Neither file reads patrol tables.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
process.env.MAIL_FROM = 'noreply@test.example';
process.env.CONDITIONS_DRAFT_LIMIT = '100';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const config = require('../src/config');
const mailer = require('../src/lib/mailer');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const modules = require('../src/lib/modules');
const proposals = require('../src/lib/proposals');
const writer = require('../src/lib/conditionswriter');
const { audit } = require('../src/lib/audit');
const { todayIn } = require('../src/lib/util');

let server; let base; let fake;
const calls = []; const mail = [];
let replies = [];
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const slug = `pr-${suffix}`;
const DEVICE = 'test-device-0123456789abcdef';

async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'x-device': DEVICE, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);
const reply = (obj, usage = { input_tokens: 1500, output_tokens: 300 }) => ({ stop_reason: 'end_turn', usage, content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] });
const aiOn = () => { config.assistant = { on: true, key: 'sk-test', apiBase: `http://127.0.0.1:${fake.address().port}`, model: 'claude-haiku-5-5', dataModel: 'claude-sonnet-5-5' }; };
const aiOff = () => { config.assistant = { on: false, key: '', apiBase: '', model: 'x', dataModel: 'y' }; };
const setModule = async (m, on) => { await pool.query('INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)', [T.id, m, on ? 1 : 0]); modules.invalidate(T.id); };
const row = async (id) => (await pool.query('SELECT * FROM ai_proposals WHERE id = ?', [id]))[0][0];
const audits = async (id) => (await pool.query("SELECT action, user_id FROM audit_log WHERE tenant_id = ? AND entity = 'ai_proposals' AND entity_id = ? ORDER BY id", [T.id, id]))[0];

const T = {}; const U = {};
const ran = [];
test.before(async () => {
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      res.setHeader('content-type', 'application/json');
      if (req.url === '/email') { mail.push(body); return res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m${mail.length}` })); }
      calls.push(body);
      const next = replies.length ? replies.shift() : reply('{}');
      return res.end(JSON.stringify(typeof next === 'function' ? next(body) : next));
    });
  });
  await new Promise((r) => { fake.listen(0, r); });
  mailer.settings.apiBase = `http://127.0.0.1:${fake.address().port}`;
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Pine Knob', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  U.owner = (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token;
  const [[t]] = await pool.query('SELECT id, timezone FROM tenants WHERE slug = ?', [slug]);
  T.id = t.id; T.today = todayIn(t.timezone);
  await pool.query("UPDATE tenants SET address = '1 Summit Road, Pine Knob, PA' WHERE id = ?", [T.id]);
  for (const m of ['assistant_plus', 'conditions', 'messages']) await setModule(m, true);
  for (const role of ['manager', 'staff', 'counter', 'patrol']) {
    const email = `${role}@${slug}.test`;
    const u = ok(await api('POST', '/users', { token: U.owner, body: { email, password: PW, role } }));
    U[`${role}Id`] = u.id;
    U[role] = (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  }
  const [[o]] = await pool.query('SELECT id FROM users WHERE tenant_id = ? AND role = ?', [T.id, 'owner']); U.ownerId = o.id;
  // The mountain's morning: two lifts (one on wind hold), three trails, a grooming log, a snow reading, the day's hours.
  await pool.query("INSERT INTO lifts (tenant_id, name, status) VALUES (?, 'Summit Quad', 'wind_hold'), (?, 'Easy Rider Chair', 'open')", [T.id, T.id]);
  await pool.query("INSERT INTO trails (tenant_id, name, difficulty, status, groomed) VALUES (?, 'Bunny Hollow', 'green', 'open', 1), (?, 'Ridge Run', 'blue', 'open', 0), (?, 'Widowmaker', 'black', 'closed', 0)", [T.id, T.id, T.id]);
  await pool.query("INSERT INTO snow_readings (tenant_id, read_at, base_in, new_snow_in, surface) VALUES (?, ?, 32, 4, 'packed_powder')", [T.id, `${T.today} 06:30:00`]);
  await pool.query("INSERT INTO calendar_days (tenant_id, on_date, status, open_time, close_time) VALUES (?, ?, 'open', '09:00', '16:00')", [T.id, T.today]);

  // Kinds for the layer's own tests.
  proposals.register('test_echo', { roles: ['owner', 'manager'], module: 'assistant_plus', editable: [{ key: 'text', label: 'Text', max: 20 }],
    async run(db, ctx, p) { ran.push({ p, user: ctx.auth.userId }); await audit(db, ctx, 'test_echo_ran', 'ai_proposals', null, null); return { echo: p.text }; } });
  proposals.register('test_fail', { roles: ['owner', 'manager'], module: 'assistant_plus', async run() { const e = new Error('The lift list moved'); e.status = 409; throw e; } });
  proposals.register('test_ocr', { roles: ['owner', 'manager'], module: 'doc_ocr', async run() { ran.push('ocr'); return {}; } });
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => fake.close(r));
  await pool.end();
});

const make = (extra = {}) => proposals.create(pool, { tenantId: T.id, kind: 'test_echo', title: 'Echo', summary: 'Say it back', payload: { text: 'draft' }, preview: { text: 'draft' }, ...extra });

// ---------------------------------------------------------------- the layer
test('only people whose role and apps allow it see a draft, and approving re-checks the role at that moment', async () => {
  const id = await make({ forRoles: ['manager'] });
  const mine = ok(await api('GET', '/ai/proposals', { token: U.manager })).data.find((p) => p.id === id);
  assert.ok(mine, 'the manager sees it');
  assert.equal(mine.label, 'Drafted by the assistant');
  assert.deepEqual(mine.editable.map((f) => f.key), ['text']);
  assert.ok(!ok(await api('GET', '/ai/proposals', { token: U.counter })).data.some((p) => p.id === id), 'counter staff do not');
  is(await api('POST', `/ai/proposals/${id}/approve`, { token: U.counter }), 403);
  is(await api('POST', `/ai/proposals/${id}/approve`, { token: U.staff }), 403);
  // The manager is made counter staff after the draft was made: the role is checked when they press Approve.
  await pool.query("UPDATE users SET role = 'counter' WHERE id = ?", [U.managerId]);
  try {
    is(await api('POST', `/ai/proposals/${id}/approve`, { token: U.manager }), 403, 'the role they have now decides');
  } finally { await pool.query("UPDATE users SET role = 'manager' WHERE id = ?", [U.managerId]); }
  assert.equal((await row(id)).status, 'pending');
  assert.equal(ran.length, 0);
  ok(await api('POST', `/ai/proposals/${id}/approve`, { token: U.manager }));
  assert.equal(ran.at(-1).user, U.managerId, 'it ran as the approver');
});

test('a draft whose app is off cannot be approved or seen', async () => {
  const id = await proposals.create(pool, { tenantId: T.id, kind: 'test_ocr', title: 'Scan', payload: {} });
  assert.ok(!ok(await api('GET', '/ai/proposals', { token: U.owner })).data.some((p) => p.id === id));
  const r = await api('POST', `/ai/proposals/${id}/approve`, { token: U.owner });
  is(r, 403); assert.match(r.body.error, /not on for your mountain/);
  assert.ok(!ran.includes('ocr'));
  // The add-on itself switched off: its drafts wait, unapproved.
  const echo = await make();
  await setModule('assistant_plus', false);
  try { is(await api('POST', `/ai/proposals/${echo}/approve`, { token: U.owner }), 403); } finally { await setModule('assistant_plus', true); }
  assert.equal((await row(echo)).status, 'pending');
});

test('an expired draft cannot be approved', async () => {
  const id = await make({ expiresAt: new Date(Date.now() - 60000) });
  assert.ok(!ok(await api('GET', '/ai/proposals', { token: U.owner })).data.some((p) => p.id === id), 'not listed');
  const r = await api('POST', `/ai/proposals/${id}/approve`, { token: U.owner });
  is(r, 409); assert.match(r.body.error, /past its time/);
  assert.equal((await row(id)).status, 'expired');
  // One that expires between listing and pressing Approve is refused the same way.
  const soon = await make({ expiresAt: new Date(Date.now() + 1500) });
  await new Promise((r2) => { setTimeout(r2, 1700); });
  is(await api('POST', `/ai/proposals/${soon}/approve`, { token: U.owner }), 409);
  assert.equal((await row(soon)).status, 'expired');
});

test('two people pressing Approve at once: it runs once, the second is told it is done', async () => {
  const id = await make();
  const before = ran.length;
  const [a, b] = await Promise.all([api('POST', `/ai/proposals/${id}/approve`, { token: U.owner }), api('POST', `/ai/proposals/${id}/approve`, { token: U.manager })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.match((a.status === 409 ? a : b).body.error, /already approved/);
  assert.equal(ran.length, before + 1, 'the handler ran once');
  is(await api('POST', `/ai/proposals/${id}/reject`, { token: U.owner }), 409, 'and cannot be set aside after');
});

test('the approver\'s edits are applied, only on fields the kind allows', async () => {
  const id = await make();
  is(await api('POST', `/ai/proposals/${id}/approve`, { token: U.owner, body: { edits: { title: 'x' } } }), 400, 'not an editable field');
  is(await api('POST', `/ai/proposals/${id}/approve`, { token: U.owner, body: { edits: { text: 'x'.repeat(21) } } }), 400, 'too long');
  assert.equal((await row(id)).status, 'pending', 'a refused edit claims nothing');
  const r = ok(await api('POST', `/ai/proposals/${id}/approve`, { token: U.owner, body: { edits: { text: '  Fresh words  ' } } }));
  assert.equal(r.result.echo, 'Fresh words');
  assert.equal(ran.at(-1).p.text, 'Fresh words');
  const saved = await row(id);
  assert.deepEqual(JSON.parse(saved.edits), { text: 'Fresh words' });
  assert.equal(JSON.parse(saved.payload).text, 'draft', 'the draft as made is kept');
  assert.equal(Number(saved.decided_by), U.ownerId);
});

test('the decision and the outcome are audited, and Not now is too', async () => {
  const id = await make();
  ok(await api('POST', `/ai/proposals/${id}/approve`, { token: U.manager }));
  const a = await audits(id);
  assert.deepEqual(a.map((x) => x.action), ['ai_proposal_approve', 'ai_proposal_done']);
  assert.ok(a.every((x) => Number(x.user_id) === U.managerId));
  const [[ranRow]] = await pool.query("SELECT user_id FROM audit_log WHERE tenant_id = ? AND action = 'test_echo_ran' ORDER BY id DESC LIMIT 1", [T.id]);
  assert.equal(Number(ranRow.user_id), U.managerId, 'the handler\'s own audit row is the approver\'s');
  const r = await make();
  ok(await api('POST', `/ai/proposals/${r}/reject`, { token: U.owner }));
  assert.equal((await row(r)).status, 'rejected');
  assert.deepEqual((await audits(r)).map((x) => x.action), ['ai_proposal_reject']);
  is(await api('POST', `/ai/proposals/${r}/approve`, { token: U.owner }), 409);
});

test('a handler that fails is recorded as failed, with why, and audited', async () => {
  const id = await proposals.create(pool, { tenantId: T.id, kind: 'test_fail', title: 'Fails', payload: {} });
  const r = await api('POST', `/ai/proposals/${id}/approve`, { token: U.owner });
  is(r, 409); assert.match(r.body.error, /did not go through: The lift list moved/);
  const saved = await row(id);
  assert.equal(saved.status, 'failed'); assert.equal(saved.error, 'The lift list moved');
  assert.deepEqual((await audits(id)).map((x) => x.action), ['ai_proposal_approve', 'ai_proposal_failed']);
  is(await api('POST', `/ai/proposals/${id}/approve`, { token: U.owner }), 409, 'not again');
});

test('another mountain\'s draft does not exist for you', async () => {
  const [[other]] = await pool.query('SELECT id FROM tenants WHERE id <> ? ORDER BY id LIMIT 1', [T.id]);
  if (!other) return;
  const id = await proposals.create(pool, { tenantId: other.id, kind: 'test_echo', title: 'Theirs', payload: { text: 'x' } });
  is(await api('POST', `/ai/proposals/${id}/approve`, { token: U.owner }), 404);
  await pool.query('DELETE FROM ai_proposals WHERE id = ?', [id]);
});

// ---------------------------------------------------------------- the conditions writer
const GOOD = { note: 'Open 9 AM to 4 PM with 4 in of new snow on a 32 in base. Summit Quad is on wind hold.', snow_report: 'Good morning! We got 4 inches overnight on a 32 inch base. Easy Rider Chair is spinning, Summit Quad is on wind hold, and Bunny Hollow was groomed. 1 of 2 lifts and 2 of 3 trails are open.', social: '4 in new at Pine Knob! Easy Rider Chair is open, Summit Quad on wind hold. Open 9 to 4.', email_subject: '4 inches of new snow today', email_body: 'Hi {first_name},\n\n4 inches fell overnight. See you on the hill.' };

test('without an AI key, Draft now fills the template from the same records, and a manager approves it', async () => {
  aiOff();
  const n = calls.length;
  is(await api('POST', '/ai/conditions/draft', { token: U.staff }), 403, 'lift staff do not draft the public update');
  const d = ok(await api('POST', '/ai/conditions/draft', { token: U.manager }));
  assert.equal(d.by, 'template'); assert.equal(d.reason, 'no_ai');
  assert.equal(calls.length, n, 'nothing sent to a model');
  assert.ok(!ok(await api('GET', '/ai/proposals', { token: U.staff })).data.some((x) => x.id === d.id), 'lift staff do not see it');
  const p = ok(await api('GET', '/ai/proposals', { token: U.manager })).data.find((x) => x.id === d.id);
  // No AI was used, so the card must not say the assistant drafted it.
  assert.equal(p.kind, 'conditions_update'); assert.equal(p.label, 'Filled in from today\u2019s records');
  assert.equal(p.preview.by, 'template');
  assert.match(p.preview.note, /Open 9 AM to 4 PM\. 1 of 2 lifts and 2 of 3 trails open\. 4 in of new snow, 32 in base\. Summit Quad \(wind hold\)\. Groomed: Bunny Hollow\./);
  assert.ok(p.preview.social.length <= 280);
  assert.match(p.preview.email_body, /^Hi \{first_name\},/);
  assert.equal(writer.check(p.preview, await writer.gather(pool, T.id)).length, 0, 'the template keeps to the facts');
  assert.ok(!ok(await api('GET', '/ai/proposals', { token: U.counter })).data.some((x) => x.id === d.id), 'counter staff do not see it');
  is(await api('POST', '/ai/conditions/draft', { token: U.counter }), 403);
  is(await api('POST', '/ai/conditions/draft', { token: U.patrol }), 403, 'patrol changes lifts, but does not draft the public update');
  // Lift staff are refused (it publishes on a public page), and the draft still waits.
  const refused = await api('POST', `/ai/proposals/${d.id}/approve`, { token: U.staff, body: { edits: { note: 'Staff wrote this' } } });
  is(refused, 403);
  assert.equal((await row(d.id)).status, 'pending');
  assert.notEqual(ok(await api('GET', `/public/${slug}/conditions`)).day.notes, 'Staff wrote this');
  // The manager approves with an edit: the note is published on the conditions feed, as them.
  const r = ok(await api('POST', `/ai/proposals/${d.id}/approve`, { token: U.manager, body: { edits: { note: 'Open 9 to 4. Summit Quad on wind hold for now.' } } }));
  assert.deepEqual(r.result, { published: true, emailed: false });
  const feed = ok(await api('GET', `/public/${slug}/conditions`));
  assert.equal(feed.day.notes, 'Open 9 to 4. Summit Quad on wind hold for now.');
  assert.equal(feed.day.status, 'open', 'the day itself is unchanged');
  const [[a]] = await pool.query("SELECT user_id FROM audit_log WHERE tenant_id = ? AND action = 'set_day_note' ORDER BY id DESC LIMIT 1", [T.id]);
  assert.equal(Number(a.user_id), U.managerId);
});

test('with the model: facts and the mountain\'s voice go in (numbers hidden), the cost is logged, and a good draft is kept', async () => {
  aiOn();
  ok(await api('PUT', '/ai/conditions/settings', { token: U.owner, body: { voice: ['Bluebird Monday! 14 inches of cold smoke on the Ridge. Get here early, folks.', '  ', 'Second one'] } }));
  is(await api('PUT', '/ai/conditions/settings', { token: U.staff, body: { voice: [] } }), 403, 'managers set the voice');
  replies = [reply(GOOD)];
  const d = ok(await api('POST', '/ai/conditions/draft', { token: U.manager }));
  assert.equal(d.by, 'assistant');
  const sent = calls.at(-1);
  assert.equal(sent.model, 'claude-haiku-5-5');
  assert.match(sent.system, /Bluebird Monday! N inches of cold smoke/, 'voice example, numbers masked');
  assert.doesNotMatch(sent.system, /14 inches/);
  const facts = JSON.parse(sent.messages[0].content.replace(/^[^{]*/, ''));
  assert.equal(facts.new_snow_inches, 4); assert.equal(facts.base_inches, 32); assert.equal(facts.lifts_open, 1);
  assert.deepEqual(facts.lifts, ['Easy Rider Chair: Open', 'Summit Quad: Wind hold']);
  assert.deepEqual(facts.groomed_trails, ['Bunny Hollow']);
  assert.equal(facts.hours, '9 AM to 4 PM');
  const [[log]] = await pool.query("SELECT * FROM assistant_log WHERE tenant_id = ? AND page = 'conditions' ORDER BY id DESC LIMIT 1", [T.id]);
  assert.equal(Number(log.user_id), U.managerId); assert.equal(Number(log.cost_micros), 1500 * 0.1 + 300 * 0.5);
  const p = ok(await api('GET', '/ai/proposals', { token: U.manager })).data.find((x) => x.id === d.id);
  assert.equal(p.preview.by, 'assistant'); assert.equal(p.preview.social, GOOD.social);
});

test('the facts guard: an invented number or trail is written again once, then the template is used', async () => {
  aiOn();
  // Wrong once (an invented 12 inches and a trail that does not exist), right the second time: the second draft is kept.
  replies = [reply({ ...GOOD, snow_report: 'A foot of powder: 12 inches on Upper Goat Glades!' }), reply(GOOD)];
  const n = calls.length;
  const one = ok(await api('POST', '/ai/conditions/draft', { token: U.manager }));
  assert.equal(one.by, 'assistant'); assert.equal(calls.length, n + 2);
  const retry = calls.at(-1).messages.at(-1).content;
  assert.match(retry, /the number 12 is not in the facts/);
  assert.match(retry, /"Upper Goat Glades" is not a lift or trail/);
  // Wrong twice: the plain template, and the screen says why.
  replies = [reply({ ...GOOD, note: '87% of the mountain is open.' }), reply({ ...GOOD, social: 'Base is 40 in!' })];
  const two = ok(await api('POST', '/ai/conditions/draft', { token: U.manager }));
  assert.equal(two.by, 'template'); assert.equal(two.reason, 'facts');
  const p = ok(await api('GET', '/ai/proposals', { token: U.manager })).data.find((x) => x.id === two.id);
  assert.equal(p.preview.fallback, 'facts');
  assert.doesNotMatch(JSON.stringify(p.preview), /87|40 in/);
  assert.ok(!ok(await api('GET', '/ai/proposals', { token: U.manager })).data.some((x) => x.id === one.id), 'a newer draft takes the older one\'s place');
  // Not JSON at all counts as a failed draft too.
  replies = [reply('Sure! Here is your update.'), reply('Still not JSON')];
  assert.equal(ok(await api('POST', '/ai/conditions/draft', { token: U.manager })).reason, 'facts');
});

test('at the monthly cap the writer uses the template and sends nothing to the model', async () => {
  aiOn();
  await pool.query('INSERT INTO assistant_settings (tenant_id, monthly_cap_cents) VALUES (?, 0) ON DUPLICATE KEY UPDATE monthly_cap_cents = 0', [T.id]);
  try {
    const n = calls.length;
    const d = ok(await api('POST', '/ai/conditions/draft', { token: U.manager }));
    assert.equal(d.by, 'template'); assert.equal(d.reason, 'cap'); assert.equal(calls.length, n);
  } finally { await pool.query('UPDATE assistant_settings SET monthly_cap_cents = 5000 WHERE tenant_id = ?', [T.id]); }
});

test('Also email passholders: only a manager, only when ticked, through Messages with its consent and unsubscribe rules', async () => {
  aiOff();
  // One current pass holder who agreed to email, one who did not.
  const [pr] = await pool.query("INSERT INTO products (tenant_id, name, kind, base_price_cents) VALUES (?, 'Season pass', 'season_pass', 50000)", [T.id]);
  const [or] = await pool.query("INSERT INTO orders (tenant_id, status, channel, total_cents) VALUES (?, 'paid', 'window', 50000)", [T.id]);
  for (const [name, yes] of [['Pat', true], ['Quinn', false]]) {
    const p = ok(await api('POST', '/people', { token: U.owner, body: { first_name: name, last_name: 'Holder', email: `${name.toLowerCase()}${suffix}@example.com`, marketing_opt_in: yes } }));
    const [oi] = await pool.query("INSERT INTO order_items (tenant_id, order_id, product_id, quantity, unit_price_cents, line_kind) VALUES (?, ?, ?, 1, 50000, 'ticket')", [T.id, or.insertId, pr.insertId]);
    await pool.query('INSERT INTO tickets (tenant_id, order_item_id, person_id, product_id, code, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?, ?)', [T.id, oi.insertId, p.id, pr.insertId, `PC${suffix}${name}`.slice(0, 20), '2020-01-01', '2099-12-31']);
  }
  const d = ok(await api('POST', '/ai/conditions/draft', { token: U.manager }));
  // Lift staff cannot approve it at all, with or without the email: refused before anything is claimed.
  const r = await api('POST', `/ai/proposals/${d.id}/approve`, { token: U.staff, body: { edits: { send_email: true } } });
  is(r, 403);
  assert.equal((await row(d.id)).status, 'pending');
  const forManager = ok(await api('GET', '/ai/proposals', { token: U.manager })).data.find((x) => x.id === d.id);
  assert.equal(forManager.viewer.can_email, true); assert.equal(forManager.viewer.passholders, 1);
  const before = mail.length;
  const done = ok(await api('POST', `/ai/proposals/${d.id}/approve`, { token: U.manager, body: { edits: { send_email: true, email_subject: 'Fresh snow at Pine Knob' } } }));
  assert.equal(done.result.emailed, true); assert.equal(done.result.sent, 1);
  const sent = mail.slice(before);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].To, `pat${suffix}@example.com`);
  assert.equal(sent[0].Subject, 'Fresh snow at Pine Knob');
  assert.match(sent[0].TextBody, /^Hi Pat,/);
  assert.match(sent[0].TextBody, /\/api\/v1\/public\/unsub\//, 'with its unsubscribe link');
  const [[c]] = await pool.query('SELECT audience, status, created_by FROM campaigns WHERE id = ?', [done.result.campaign_id]);
  assert.deepEqual([c.audience, c.status, Number(c.created_by)], ['passholders', 'sent', U.managerId]);
  // Not ticked: no email.
  const d2 = ok(await api('POST', '/ai/conditions/draft', { token: U.manager }));
  const m2 = mail.length;
  ok(await api('POST', `/ai/proposals/${d2.id}/approve`, { token: U.manager }));
  assert.equal(mail.length, m2);
});

test('the morning run drafts once a day at the mountain\'s time, only on a day on its calendar', async () => {
  aiOff();
  await pool.query('UPDATE ai_proposals SET status = \'expired\' WHERE tenant_id = ? AND status = \'pending\'', [T.id]);
  ok(await api('PUT', '/ai/conditions/settings', { token: U.owner, body: { draft_at: '23:59', auto_on: true } }));
  await writer.tick();
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM ai_proposals WHERE tenant_id = ? AND status = 'pending'", [T.id]))[0][0].n, 0, 'not before its time');
  ok(await api('PUT', '/ai/conditions/settings', { token: U.owner, body: { draft_at: '00:00' } }));
  await pool.query('UPDATE conditions_writer_settings SET last_drafted_on = NULL WHERE tenant_id = ?', [T.id]);
  await Promise.all([writer.tick(), writer.tick()]);
  await writer.tick();
  const [list] = await pool.query("SELECT source FROM ai_proposals WHERE tenant_id = ? AND status = 'pending'", [T.id]);
  assert.deepEqual(list.map((x) => x.source), ['schedule'], 'once, however many runs');
  // Off: nothing.
  ok(await api('PUT', '/ai/conditions/settings', { token: U.owner, body: { auto_on: false } }));
  await pool.query('UPDATE conditions_writer_settings SET last_drafted_on = NULL WHERE tenant_id = ?', [T.id]);
  await writer.tick();
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM ai_proposals WHERE tenant_id = ? AND status = 'pending'", [T.id]))[0][0].n, 1);
});

test('the day\'s public note on its own: owners and managers only; lift staff and counter staff get 403', async () => {
  ok(await api('PUT', `/schedule/days/${T.today}/note`, { token: U.manager, body: { notes: 'Night skiing until 9' } }));
  assert.equal(ok(await api('GET', `/public/${slug}/conditions`)).day.notes, 'Night skiing until 9');
  ok(await api('PUT', `/schedule/days/${T.today}/note`, { token: U.owner, body: { notes: 'Night skiing until 9' } }));
  is(await api('PUT', `/schedule/days/${T.today}/note`, { token: U.staff, body: { notes: 'Staff wrote this' } }), 403, 'it changes a public page');
  is(await api('PUT', `/schedule/days/${T.today}/note`, { token: U.counter, body: { notes: 'x' } }), 403);
  assert.equal(ok(await api('GET', `/public/${slug}/conditions`)).day.notes, 'Night skiing until 9');
  // The shared lib refuses too, whoever calls it.
  await assert.rejects(require('../src/lib/conditionsnote').setNote(pool, { auth: { tenantId: T.id, userId: U.staffId, role: 'staff' } }, T.today, 'x'), (e) => e.status === 403);
  assert.deepEqual(writer.ROLES, ['owner', 'manager']);
  assert.deepEqual(proposals.kindOf('conditions_update').roles, ['owner', 'manager'], 'the kind is for owners and managers');
  is(await api('PUT', `/schedule/days/${T.today}`, { token: U.staff, body: { status: 'closed' } }), 403, 'the day itself stays a manager\'s');
});

// ---------------------------------------------------------------- patient care records stay out
// Every table of patrol and patient care, from the schema files and the database itself.
function patrolTables() {
  const root = path.join(__dirname, '..', 'db');
  const names = new Set();
  for (const f of ['patrol.sql', 'patrolops.sql']) for (const m of fs.readFileSync(path.join(root, f), 'utf8').matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+`?(\w+)/gi)) names.add(m[1]);
  const all = [fs.readFileSync(path.join(root, 'schema.sql'), 'utf8'), fs.readFileSync(path.join(root, 'migrate.js'), 'utf8'), ...fs.readdirSync(path.join(root, 'steps')).map((f) => fs.readFileSync(path.join(root, 'steps', f), 'utf8'))].join('\n');
  for (const m of all.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+`?(\w+)/gi)) if (/^(incident|patrol|dispatch|injury|staff_injur|followup|care_|case_)/.test(m[1])) names.add(m[1]);
  return [...names];
}
const MINE = ['src/lib/proposals.js', 'src/lib/conditionswriter.js', 'src/lib/conditionsnote.js', 'src/lib/roleallows.js', 'src/routes/ai.js'];

test('patient records: the proposals layer and the conditions writer never require patrol code or query patrol tables', () => {
  const tables = patrolTables();
  assert.ok(tables.includes('incidents') && tables.includes('incident_patients') && tables.length > 15, `found ${tables.length} patrol tables`);
  for (const f of MINE) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) assert.doesNotMatch(m[1], /patrol|patient|incident|care|scrub|injur|dispatch/i, `${f} requires ${m[1]}`);
    for (const t of tables) assert.ok(!new RegExp(`\\b${t}\\b`).test(src), `${f} names the patrol table ${t}`);
  }
  // And nothing they load, however deep, is patrol code: load them in a fresh process and look at every module it pulled in.
  const script = `${MINE.map((f) => `require(${JSON.stringify(path.join(__dirname, '..', f))});`).join('')}process.stdout.write(JSON.stringify(Object.keys(require.cache)));`;
  const loaded = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: process.env, encoding: 'utf8' }));
  const patrolish = loaded.filter((p) => p.includes(`${path.sep}src${path.sep}`) && /patrol|patient|incident|carederive|caseconditions|injuryregister|staffinjury|nsaar/i.test(path.basename(p)));
  assert.deepEqual(patrolish, []);
});

test('the facts the writer gathers hold no patrol data, even on a day with a patrol case', async () => {
  await pool.query("INSERT INTO incidents (tenant_id, occurred_at, location, category, severity, summary) VALUES (?, ?, 'Ridge Run', 'injury', 'serious', 'Patient Zed broke a leg')", [T.id, `${T.today} 10:00:00`]).catch(() => {});
  const f = await writer.gather(pool, T.id);
  assert.doesNotMatch(JSON.stringify(f) + writer.prompt(f, []).user, /Zed|broke|injur|incident|patient|serious/i);
  assert.doesNotMatch(writer.prompt(f, []).system, /Zed|broke|serious/i);
});
