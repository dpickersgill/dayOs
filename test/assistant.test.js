'use strict';

// The Verdynt/OS Assistant. Staff questions are answered from the Help articles their role can read and the mountain's
// own setup; links it gives are checked; with Assistant Plus it looks up the mountain's data with read-only tools limited
// to the asker's role. Guests get it only on the pages the mountain chose, and only public facts (plus their own family's
// places on the family page). Every question is logged with its cost, and a monthly cap stops it.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
process.env.MAIL_FROM = 'noreply@test.example';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const config = require('../src/config');
const mailer = require('../src/lib/mailer');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const modules = require('../src/lib/modules');
const { shape } = require('../src/lib/assistant');

let server; let base; let fake;
const calls = []; const mail = [];
let replies = [];
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const slug = `as-${suffix}`;

const DEVICE = 'test-device-0123456789abcdef'; // the app always says which device signs in; leaving it out asks for an emailed code
async function api(method, path, { token, body, headers } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'x-device': DEVICE,  'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);
const text = (t, usage = { input_tokens: 2000, output_tokens: 100 }) => ({ stop_reason: 'end_turn', usage, content: [{ type: 'text', text: t }] });
const lastSystem = () => calls.at(-1).body.system;

const T = {};
test.before(async () => {
  // A stand-in for both the AI provider and the email provider.
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/email') { mail.push(body); return res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m${mail.length}` })); }
      calls.push({ headers: req.headers, body });
      const next = replies.length ? replies.shift() : text('Fine.');
      const out = typeof next === 'function' ? next(body) : next;
      if (out.__status) { res.statusCode = out.__status; delete out.__status; }
      return res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => { fake.listen(0, r); });
  mailer.settings.apiBase = `http://127.0.0.1:${fake.address().port}`;
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Pine Knob', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  T.owner = (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token;
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
  T.id = t.id;
  for (const m of ['programs', 'shop', 'school']) await pool.query('INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE enabled = 1', [T.id, m]);
  modules.invalidate(T.id);
  for (const [email, role] of [[`ina@${slug}.test`, 'instructor'], [`cal@${slug}.test`, 'counter']]) {
    ok(await api('POST', '/users', { token: T.owner, body: { email, password: PW, role } }));
    T[role] = (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  }
  await pool.query("INSERT INTO products (tenant_id, kind, name, base_price_cents, valid_days, uses, active, online) VALUES (?, 'day_ticket', 'Adult day', 6900, 1, 1, 1, 1), (?, 'day_ticket', 'Staff comp day', 100, 1, 1, 1, 0)", [T.id, T.id]);
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => fake.close(r));
  await pool.end();
});
const on = () => { config.assistant = { on: true, key: 'sk-assist', apiBase: `http://127.0.0.1:${fake.address().port}`, model: 'claude-haiku-5-5', dataModel: 'claude-sonnet-5-5' }; };

test('off until the server has a key', async () => {
  config.assistant = { on: false, key: '', apiBase: '', model: 'x', dataModel: 'y' };
  assert.equal(ok(await api('GET', '/assistant', { token: T.counter })).on, false);
  is(await api('POST', '/assistant/ask', { token: T.counter, body: { question: 'How do I refund?' } }), 503);
  on();
  assert.equal(ok(await api('GET', '/assistant', { token: T.counter })).on, true);
});

test('links in an answer are checked: only Help articles it was given and real-looking screens survive', () => {
  const s = shape('[[unsure]] Try this. [[help:sell-pay]] [[help:made-up]] [[go:#/sell|Open Sell]] [[go:javascript:alert(1)]] [[weird]]', { helpIds: new Set(['sell-pay']), allowGo: true });
  assert.equal(s.unsure, true);
  assert.equal(s.answer, 'Try this.');
  assert.deepEqual(s.links, [{ help: 'sell-pay' }, { go: '#/sell', label: 'Open Sell' }]);
  assert.deepEqual(shape('Hi [[go:#/sell]]', { helpIds: new Set(), allowGo: false }).links, []);
});

test('a how-to question is answered from Help the asker can read, with the cheap model and no look-ups', async () => {
  on();
  replies = [text('Press Charge on reader and the guest taps their card. [[help:sell-pay]] [[help:money-recon]] [[go:#/sell|Open Sell]]')];
  const r = ok(await api('POST', '/assistant/ask', { token: T.counter, body: { question: 'How do I take a card payment on the reader?', page: 'sell', views: ['sell', 'gate'] } }));
  const call = calls.at(-1);
  assert.equal(call.headers['x-api-key'], 'sk-assist');
  assert.equal(call.body.model, 'claude-haiku-5-5');
  assert.equal(call.body.tools, undefined, 'no look-ups without Assistant Plus');
  assert.match(lastSystem(), /\[sell-pay\] Take payment/);
  assert.match(lastSystem(), /Charge on reader/, 'the corrected card reader tip');
  assert.doesNotMatch(lastSystem(), /does not run a card terminal/);
  assert.match(lastSystem(), /Adult day \(day ticket\) \$69/);
  assert.match(r.answer, /Charge on reader/);
  assert.ok(r.links.some((l) => l.kind === 'help' && l.id === 'sell-pay' && l.href === '#/help/sell-pay' && /Take payment/.test(l.label)));
  assert.ok(r.links.some((l) => l.kind === 'go' && l.href === '#/sell'));
  const [[row]] = await pool.query('SELECT * FROM assistant_log WHERE id = ?', [r.id]);
  assert.equal(row.audience, 'staff');
  assert.equal(row.input_tokens, 2000);
  assert.equal(Number(row.cost_micros), 250, '2000 x $0.10 + 100 x $0.50 per million = 250 millionths');
});

test('an instructor is not given manager-only Help, and cannot see managers\' money', async () => {
  replies = [text('[[unsure]] I do not know that.')];
  const r = ok(await api('POST', '/assistant/ask', { token: T.instructor, body: { question: 'How do I export sales and refunds csv for the accountant?', page: 'school' } }));
  assert.doesNotMatch(lastSystem(), /\[money-export\]/);
  assert.equal(r.unsure, true);
  replies = [text('Use Exports. [[help:money-export]]')];
  ok(await api('POST', '/assistant/ask', { token: T.owner, body: { question: 'How do I export sales and refunds csv for the accountant?' } }));
  assert.match(lastSystem(), /\[money-export\]/);
});

test('Ask support sends the question, the answer and a drafted reply to support@, once', async () => {
  replies = [text('[[unsure]] Not sure.'), text('Hi! You can do that under Settings.')];
  const r = ok(await api('POST', '/assistant/ask', { token: T.counter, body: { question: 'Can I print a ticket twice?', page: 'sell' } }));
  is(await api('POST', `/assistant/${r.id}/escalate`, { token: T.instructor, body: {} }), 404, 'someone else\'s answer');
  const before = mail.length;
  const e = ok(await api('POST', `/assistant/${r.id}/escalate`, { token: T.counter, body: { note: 'The printer jammed.' } }));
  assert.equal(e.to, config.site.supportEmail);
  const m = mail.at(-1);
  assert.equal(mail.length, before + 1);
  assert.equal(m.To, config.site.supportEmail);
  assert.equal(m.ReplyTo, `cal@${slug}.test`);
  assert.match(m.TextBody, /Can I print a ticket twice\?/);
  assert.match(m.TextBody, /The printer jammed/);
  assert.match(m.TextBody, /You can do that under Settings/);
  assert.ok(ok(await api('POST', `/assistant/${r.id}/escalate`, { token: T.counter, body: {} })).already);
  assert.equal(mail.length, before + 1);
  ok(await api('POST', `/assistant/${r.id}/rate`, { token: T.counter, body: { helpful: false } }));
  const q = ok(await api('GET', '/assistant/questions', { token: T.owner })).data.find((x) => x.id === r.id);
  assert.equal(q.rating, -1); assert.ok(q.escalated_at); assert.equal(q.unanswered, true);
  is(await api('GET', '/assistant/questions', { token: T.counter }), 403);
});

test('with Assistant Plus, staff questions about live data use read-only look-ups limited by role', async () => {
  is(await api('PUT', '/assistant/settings', { token: T.owner, body: { staff_on: true, guest_pages: ['shop'] } }), 409, 'guest assistant needs the add-on');
  await pool.query("INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, 'assistant_plus', 1) ON DUPLICATE KEY UPDATE enabled = 1", [T.id]);
  modules.invalidate(T.id);
  replies = [
    { stop_reason: 'tool_use', usage: { input_tokens: 3000, output_tokens: 50 }, content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'tu1', name: 'day_report', input: {} }] },
    (body) => { const res = body.messages.at(-1).content[0]; assert.equal(res.type, 'tool_result'); assert.equal(res.tool_use_id, 'tu1'); return text('Here is today.', { input_tokens: 3500, output_tokens: 80 }); },
  ];
  const r = ok(await api('POST', '/assistant/ask', { token: T.counter, body: { question: 'How many scans today?', page: 'dashboard' } }));
  const first = calls.at(-2).body;
  assert.equal(first.model, 'claude-sonnet-5-5');
  const names = first.tools.map((x) => x.name);
  assert.ok(names.includes('day_report'));
  assert.ok(names.includes('lessons_on'));
  assert.ok(!names.includes('sales_summary'), 'counter staff get no sales totals');
  assert.deepEqual(r.looked_up, ['day_report']);
  const [[row]] = await pool.query('SELECT * FROM assistant_log WHERE id = ?', [r.id]);
  assert.equal(row.input_tokens, 6500);
  assert.equal(Number(row.cost_micros), 6500 * 2 + 130 * 10);
  replies = [text('Sales are fine.')];
  ok(await api('POST', '/assistant/ask', { token: T.owner, body: { question: 'What did we sell yesterday?' } }));
  assert.ok(calls.at(-1).body.tools.some((x) => x.name === 'sales_summary'));
  // A forced call to a tool the role does not have is refused, not run.
  const tools = require('../src/lib/assistanttools');
  const out = await tools.run(pool, { tenantId: T.id, role: 'counter', modules: new Set(['sell', 'school']), today: '2026-01-01' }, 'sales_summary', {});
  assert.ok(out.error);
});

test('guests get it only on the pages the mountain chose, with public facts only, and can contact the mountain', async () => {
  assert.equal(ok(await api('GET', `/public/${slug}/assistant?page=shop`)).on, false);
  is(await api('POST', `/public/${slug}/assistant/ask`, { body: { question: 'When are you open?', page: 'shop' } }), 404);
  const s = ok(await api('PUT', '/assistant/settings', { token: T.owner, body: { staff_on: true, guest_pages: ['shop', 'family'], contact_email: `desk@${slug}.test` } }));
  assert.deepEqual(s.guest_pages, ['shop', 'family']);
  assert.equal(ok(await api('GET', `/public/${slug}/assistant?page=shop`)).on, true);
  assert.equal(ok(await api('GET', `/public/${slug}/assistant?page=booking`)).on, false);
  replies = [text('A day ticket is $69. [[go:#/money]] [[help:sell-pay]]')];
  const r = ok(await api('POST', `/public/${slug}/assistant/ask`, { body: { question: 'How much is a day ticket?', page: 'shop' } }));
  assert.equal(r.answer, 'A day ticket is $69.', 'no staff links for guests');
  const sys = lastSystem();
  assert.equal(calls.at(-1).body.tools, undefined);
  assert.match(sys, /Adult day/);
  assert.doesNotMatch(sys, /Staff comp day/, 'products not sold online stay private');
  assert.doesNotMatch(sys, /Help articles/);
  assert.doesNotMatch(sys, /Apps this mountain has/);
  is(await api('POST', `/public/${slug}/assistant/ask`, { body: { question: 'Hi there', page: 'booking' } }), 404);
  ok(await api('POST', `/public/${slug}/assistant/contact`, { body: { page: 'shop', email: 'guest@example.com', name: 'Gina', message: 'Can I bring a dog?', answer_id: r.id } }));
  const m = mail.at(-1);
  assert.equal(m.To, `desk@${slug}.test`);
  assert.equal(m.ReplyTo, 'guest@example.com');
  assert.match(m.TextBody, /Can I bring a dog\?/);
  assert.match(m.TextBody, /How much is a day ticket\?/);
});

test('the monthly cap stops it, for staff and guests', async () => {
  await pool.query('UPDATE assistant_settings SET monthly_cap_cents = 1 WHERE tenant_id = ?', [T.id]);
  const n = calls.length;
  const r = await api('POST', '/assistant/ask', { token: T.counter, body: { question: 'How do I sell a ticket?' } });
  is(r, 429); assert.match(r.body.error || r.body.message || '', /allowance/);
  is(await api('POST', `/public/${slug}/assistant/ask`, { body: { question: 'Open today?', page: 'shop' } }), 429);
  assert.equal(calls.length, n, 'nothing was sent to the model');
  const s = ok(await api('GET', '/assistant/settings', { token: T.owner }));
  assert.ok(s.month.questions >= 6);
  assert.ok(s.month.spent_cents >= 1);
  await pool.query('UPDATE assistant_settings SET monthly_cap_cents = 5000 WHERE tenant_id = ?', [T.id]);
});

test('managers can turn it off for staff', async () => {
  ok(await api('PUT', '/assistant/settings', { token: T.owner, body: { staff_on: false, guest_pages: [] } }));
  assert.equal(ok(await api('GET', '/assistant', { token: T.counter })).on, false);
  is(await api('POST', '/assistant/ask', { token: T.counter, body: { question: 'How do I sell?' } }), 403);
  is(await api('PUT', '/assistant/settings', { token: T.counter, body: { staff_on: true, guest_pages: [] } }), 403);
  ok(await api('PUT', '/assistant/settings', { token: T.owner, body: { staff_on: true, guest_pages: [] } }));
});

test('an Anthropic error tells staff only that it is unavailable; the reason goes to the console', async () => {
  replies = [{ __status: 400, type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }];
  const r = await api('POST', '/assistant/ask', { token: T.counter, body: { question: 'How do I sell a ticket?' } });
  is(r, 502);
  assert.match(JSON.stringify(r.body), /Help still has every article/);
  assert.doesNotMatch(JSON.stringify(r.body), /credit/);
  const { lastFailure } = require('../src/lib/assistant');
  assert.match(lastFailure().reason, /out of credit/);
  replies = [{ __status: 404, type: 'error', error: { type: 'not_found_error', message: 'model: claude-nope' } }];
  is(await api('POST', '/assistant/ask', { token: T.counter, body: { question: 'How do I sell a ticket?' } }), 502);
  assert.match(lastFailure().reason, /does not know the model/);
});
