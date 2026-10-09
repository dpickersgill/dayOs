'use strict';

// The weekly owner report: the numbers for a Monday-to-Sunday week, the comparison with the week before, who gets the
// email on Monday and that it goes once.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
process.env.MAIL_FROM = 'hello@summitops.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mailer = require('../src/lib/mailer');
const weekly = require('../src/lib/weekly');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { todayIn, addDays } = require('../src/lib/util');

let server; let base; let pm; const mails = [];
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const q = async (sql, params) => (await pool.query(sql, params))[0];
let A; let B; let T = {};
const thisMon = weekly.weekStartOf(todayIn('America/New_York'));
const lastMon = addDays(thisMon, -7); const prevMon = addDays(thisMon, -14);

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: `Mount ${slug}`, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const owner = (await call('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token;
  return { slug, owner, id: (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id };
}
/** An order made at noon (mountain time, about 16:00 UTC) on a day. total includes the tax. */
async function order(tenantId, day, { total, tax = 0, channel = 'window', kind = 'ticket' }) {
  const at = `${day} 16:00:00`;
  const [o] = await pool.query("INSERT INTO orders (tenant_id, status, subtotal_cents, total_cents, tax_cents, channel, created_at) VALUES (?, 'paid', ?, ?, ?, ?, ?)", [tenantId, total - tax, total, tax, channel, at]);
  await pool.query('INSERT INTO order_items (tenant_id, order_id, line_kind, unit_price_cents, quantity, tax_cents) VALUES (?, ?, ?, ?, 1, ?)', [tenantId, o.insertId, kind, total - tax, tax]);
  await pool.query("INSERT INTO order_payments (tenant_id, order_id, tender, amount_cents) VALUES (?, ?, 'card', ?)", [tenantId, o.insertId, total]);
}

test.before(async () => {
  pm = http.createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { mails.push(JSON.parse(d)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: 'm' })); }); });
  await new Promise((r) => pm.listen(0, '127.0.0.1', r));
  mailer.settings.apiBase = `http://127.0.0.1:${pm.address().port}`;
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`wa-${suffix}`); B = await mountain(`wb-${suffix}`);
  for (const role of ['manager', 'counter']) {
    assert.equal((await call('POST', '/users', { token: A.owner, body: { email: `${role}@${A.slug}.test`, password: PW, role } })).status, 201);
    T[role] = (await call('POST', '/auth/login', { body: { tenant: A.slug, email: `${role}@${A.slug}.test`, password: PW } })).body.token;
  }
  // last week: $110 (with $10 tax) at the window on Tuesday, $55 (with $5 tax) online on Saturday; the week before: $55 (with $5 tax)
  await order(A.id, addDays(lastMon, 1), { total: 11000, tax: 1000 });
  await order(A.id, addDays(lastMon, 5), { total: 5500, tax: 500, channel: 'online', kind: 'lesson' });
  await order(A.id, addDays(prevMon, 2), { total: 5500, tax: 500 });
  await order(B.id, addDays(lastMon, 1), { total: 99900 });
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => pm.close(r)); await pool.end(); });

test('weekly numbers: before tax, compared with the week before, split by type and channel; managers only', async () => {
  assert.equal((await call('GET', '/reports/weekly', { token: T.counter })).status, 403);
  const w = (await call('GET', '/reports/weekly', { token: T.manager })).body;
  assert.equal(w.week_start, lastMon); assert.equal(w.complete, true);
  assert.equal(w.totals.revenue_cents, 15000, '$165 less $15 tax');
  assert.equal(w.totals.orders, 2);
  assert.equal(w.prev.revenue_cents, 5000);
  assert.equal(w.change.revenue_pct, 200);
  assert.equal(w.best_day.date, addDays(lastMon, 1));
  assert.deepEqual(w.channels.map((c) => c.channel).sort(), ['online', 'window']);
  assert.equal(w.online_share_pct, 33, 'online is $55 of $165');
  assert.equal(w.types.find((t) => t.kind === 'lesson').cents, 5000);
  assert.equal(w.days.length, 7);
  assert.equal(w.days[1].revenue_cents, 10000);
  // any date in a week picks that week; another mountain's money never shows
  assert.equal((await call('GET', `/reports/weekly?week=${addDays(lastMon, 4)}`, { token: T.manager })).body.week_start, lastMon);
  assert.equal((await call('GET', '/reports/weekly?week=nope', { token: T.manager })).status, 400);
  assert.equal((await call('GET', '/reports/weekly', { token: B.owner })).body.totals.revenue_cents, 99900 - 0);
});

test('the email says the numbers and can be sent to yourself', async () => {
  const before = mails.length;
  const r = await call('POST', '/reports/weekly/email-me', { token: T.manager, body: {} });
  assert.equal(r.status, 200, r.text);
  const m = mails.slice(before)[0];
  assert.equal(m.To, `manager@${A.slug}.test`);
  assert.match(m.TextBody, /\$150/);
  assert.match(m.TextBody, /up 200% on the week before/);
  assert.match(m.HtmlBody, /Day by day/);
});

test('Monday: owners and managers get it once, counter staff do not; a late or switched-off week sends nothing', async () => {
  const t = await q('SELECT * FROM tenants WHERE id = ?', [A.id]).then((x) => x[0]);
  const before = mails.length;
  assert.deepEqual(await weekly.runForTenant(t, { now: addDays(thisMon, 3) }), { skipped: 'late' });
  assert.equal(mails.length, before);
  assert.equal((await weekly.runForTenant({ ...t, weekly_report: 0 }, { now: thisMon })).skipped, 'off');
  assert.equal(mails.length, before);
  const first = await weekly.runForTenant(t, { now: thisMon });
  assert.equal(first.sent, 2);
  const to = mails.slice(before).map((m) => m.To).sort();
  assert.deepEqual(to, [`manager@${A.slug}.test`, `owner@${A.slug}.test`]);
  assert.equal((await weekly.runForTenant(t, { now: addDays(thisMon, 1) })).skipped, 'already sent');
  assert.equal(mails.length, before + 2);
  const row = (await q('SELECT * FROM weekly_reports WHERE tenant_id = ? AND week_start = ?', [A.id, lastMon]))[0];
  assert.ok(row.emailed_at); assert.equal(JSON.parse(row.summary).totals.revenue_cents, 15000);
});

test('the daily job runs the weekly report too, and the toggle is a mountain setting', async () => {
  assert.equal((await call('PUT', '/tenant/profile', { token: A.owner, body: { weekly_report: false } })).status, 200);
  assert.equal((await call('GET', '/tenant/profile', { token: A.owner })).body.weekly_report, false);
  assert.equal((await call('PUT', '/tenant/profile', { token: A.owner, body: { weekly_report: true } })).status, 200);
  process.env.JOBS_KEY = 'jobs-key-weekly';
  const res = await fetch(`${base}/api/v1/internal/jobs/daily`, { method: 'POST', headers: { 'x-jobs-key': 'jobs-key-weekly' } });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray((await res.json()).weekly_reports));
});
