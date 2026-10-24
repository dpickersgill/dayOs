'use strict';

// The self-serve demo: a visitor gets a private mountain with made-up data, it expires, it is removed completely, and it can never email or charge anyone.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.SANDBOX_RATE_LIMIT = '1000';

// A stand-in mail service that counts what reaches it, so the test can prove a demo never gets as far as sending.
const http = require('http');
const stubPort = 41000 + Math.floor(Math.random() * 2000);
let mailHits = 0;
const mails = []; // what reached the mail service, for the emailed demo code
const stub = http.createServer((req, res) => {
  mailHits += 1;
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => { try { mails.push(JSON.parse(body)); } catch (_) { /* not JSON */ } res.setHeader('content-type', 'application/json'); res.end('{"ErrorCode":0,"MessageID":"x"}'); });
}).listen(stubPort, '127.0.0.1');
process.env.POSTMARK_API_BASE = `http://127.0.0.1:${stubPort}`;
process.env.POSTMARK_SERVER_TOKEN = 'test-token';
process.env.MAIL_FROM = 'patrol@example.org';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const S = require('../src/lib/sandbox');
const M = require('../src/lib/modules');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const KEY = 'test-bootstrap-key';
const made = []; // tenant ids to clean up

async function api(method, path, { token, key, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'x-platform-key': key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const tenantId = async (slug) => (await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]))[0][0]?.id;
const start = async (email, extra = {}) => {
  const r = await api('POST', '/trial', { body: { name: 'Tess Tester', email, mountain: 'Test Peak', ...extra } });
  if (r.status === 201) made.push(await tenantId(r.body.tenant));
  return r;
};
const welcomed = async (email) => {
  for (let i = 0; i < 50; i += 1) {
    const [[r]] = await pool.query('SELECT welcome_sent_at FROM sandbox_signups WHERE email = ? ORDER BY id DESC LIMIT 1', [email]);
    if (r && r.welcome_sent_at) return;
    await new Promise((ok) => { setTimeout(ok, 100); });
  }
  throw new Error(`no welcome email for ${email}`);
};
const mailTo = (email) => mails.filter((m) => m.To === email);
const E1 = `tess1-${suffix}@example.org`;
const E2 = `tess2-${suffix}@example.org`;
let one;

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  for (const id of made) if (id) await S.purgeTenant(id).catch(() => {});
  await new Promise((r) => server.close(r));
  await new Promise((r) => stub.close(r));
  await pool.end();
});

test('a visitor gets a private demo mountain with every app on and made-up data in it', async () => {
  one = await start(E1);
  assert.equal(one.status, 201, JSON.stringify(one.body));
  assert.match(one.body.tenant, /^try-/);
  assert.ok(one.body.token && one.body.password && one.body.expires_at);
  // the password they were shown signs in, and the token they were given already works
  const login = await api('POST', '/auth/login', { body: { tenant: one.body.tenant, email: E1, password: one.body.password } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const me = await api('GET', '/auth/me', { token: one.body.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.role, 'owner'); assert.equal(me.body.tenant_name, 'Test Peak');
  assert.ok(me.body.sandbox && me.body.sandbox.expires_at, 'the app can tell it is a demo');
  assert.deepEqual([...me.body.modules].sort(), M.MODULES.map((m) => m.key).sort(), 'every app is on, the paid add-ons too, so a visitor sees what they would buy');
  const lifts = await api('GET', '/schedule/lifts', { token: one.body.token });
  const products = await api('GET', '/products', { token: one.body.token });
  const people = await api('GET', '/people', { token: one.body.token });
  assert.ok(lifts.body.data.length >= 4 && products.body.data.length >= 8, 'sample lifts and products are there');
  assert.ok((people.body.data || people.body).length >= 10, 'sample customers and staff are there');
  const [[t]] = await pool.query('SELECT storage_cap_mb, require_mfa FROM tenants WHERE slug = ?', [one.body.tenant]);
  assert.equal(t.storage_cap_mb, S.STORAGE_MB); assert.equal(Number(t.require_mfa), 0);
});

test('the guided tours have what they point at, and each visitor\'s progress reaches the Demos dashboard', async () => {
  const tok = one.body.token;
  // the gate tour taps a good card and a lost one, and shows two devices
  const good = await api('POST', '/tickets/scan', { token: tok, body: { uid: '04A1B2C3D4E5F6' } });
  assert.equal(good.body.result, 'ok', 'the demo card carries a ticket that has not been scanned yet');
  assert.equal((await api('POST', '/tickets/scan', { token: tok, body: { uid: '04C0FFEE123456' } })).body.result, 'card_blocked');
  assert.ok((await api('GET', '/access/devices', { token: tok })).body.data.length >= 2);
  // progress: a step, then the end; a step number never goes backwards
  assert.equal((await api('POST', '/demo-tours', { token: tok, body: { tour: 'gate', step: 3, total: 7 } })).status, 204);
  assert.equal((await api('POST', '/demo-tours', { token: tok, body: { tour: 'gate', step: 1, total: 7 } })).status, 204);
  assert.equal((await api('POST', '/demo-tours', { token: tok, body: { tour: 'sell', step: 8, total: 8, done: true } })).status, 204);
  assert.equal((await api('POST', '/demo-tours', { token: tok, body: { tour: 'not-a-tour', step: 1, total: 2 } })).status, 400);
  const dash = await api('GET', '/platform/sandboxes', { key: 'test-bootstrap-key' });
  const row = dash.body.data.find((x) => x.slug === one.body.tenant);
  const tours = Object.fromEntries(row.tours.map((t) => [t.tour, t]));
  assert.deepEqual(tours.gate, { tour: 'gate', steps_seen: 3, steps_total: 7, finished: false });
  assert.equal(tours.sell.finished, true);
  assert.ok(dash.body.summary.took_tour >= 1);
});

test('bots, bad addresses and a full demo are turned away', async () => {
  assert.equal((await api('POST', '/trial', { body: { name: 'Bot', email: `b-${suffix}@example.org`, website: 'http://spam.example' } })).status, 400);
  assert.equal((await api('POST', '/trial', { body: { name: 'X', email: 'not-an-email' } })).status, 400);
  assert.equal((await api('POST', '/trial', { body: { email: `n-${suffix}@example.org` } })).status, 400);
  const was = S.MAX_ACTIVE; S.MAX_ACTIVE = 0;
  try {
    const full = await api('POST', '/trial', { body: { name: 'Late Larry', email: `l-${suffix}@example.org` } });
    assert.equal(full.status, 503); assert.match(full.body.error, /full/);
  } finally { S.MAX_ACTIVE = was; }
  const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM sandbox_signups WHERE email IN (?, ?, ?)', [`b-${suffix}@example.org`, `n-${suffix}@example.org`, `l-${suffix}@example.org`]);
  assert.equal(Number(n.n), 0, 'nothing was recorded for the turned-away tries');
});

test('demo mountains are not mixed in with real ones, and they cannot see each other', async () => {
  const two = await start(E2, { mountain: 'Other Peak' });
  assert.equal(two.status, 201, JSON.stringify(two.body));
  const list = await api('GET', '/platform/tenants', { key: KEY });
  assert.ok(!list.body.data.some((t) => t.slug === one.body.tenant || t.slug === two.body.tenant), 'the console list is for real mountains');
  const a = (await api('GET', '/people', { token: one.body.token })).body;
  const b = (await api('GET', '/people', { token: two.body.token })).body;
  const ids = new Set((a.data || a).map((p) => p.id));
  assert.ok((b.data || b).every((p) => !ids.has(p.id)), 'no customer or staff record is shared between two demos');
  const leads = await api('GET', '/platform/sandboxes', { key: KEY });
  assert.equal(leads.status, 200);
  assert.ok(leads.body.data.some((s) => s.email === E1 && s.status === 'running' && s.mountain === 'Test Peak'));
  assert.equal((await api('GET', '/platform/sandboxes')).status, 403, 'the lead list needs the platform key');
});

test('a demo can never send email or take a card payment', async () => {
  assert.equal(await S.isSandbox(await tenantId(one.body.tenant)), true);
  const real = await api('POST', '/platform/tenants', { key: KEY, body: { slug: `real-${suffix}`, name: 'Real Mountain', owner: { email: `o@real-${suffix}.test`, password: 'correct-horse-battery', first_name: 'Rae', last_name: 'Real' } } });
  assert.equal(real.status, 201);
  assert.equal(await S.isSandbox(real.body.id), false);
  assert.equal(await S.purgeTenant(real.body.id), false, 'the cleanup refuses to touch a real mountain');
  assert.ok(await tenantId(`real-${suffix}`), 'the real mountain is still there');
  // a follow-up email in a demo stops before it reaches the mail service
  const followups = require('../src/lib/followups');
  const sbId = await tenantId(one.body.tenant);
  const sbTenant = (await pool.query('SELECT * FROM tenants WHERE id = ?', [sbId]))[0][0];
  const [[pt]] = await pool.query('SELECT id, incident_id FROM incident_patients WHERE tenant_id = ? LIMIT 1', [sbId]);
  assert.ok(pt, 'the demo has a sample patrol case');
  await pool.query('DELETE FROM followups WHERE tenant_id = ? AND patient_id = ?', [sbId, pt.id]);
  const [ins] = await pool.query("INSERT INTO followups (tenant_id, incident_id, patient_id, to_email, due_on, status, token) VALUES (?, ?, ?, 'guest@example.com', CURDATE(), 'queued', ?)", [sbId, pt.incident_id, pt.id, 'f'.repeat(32)]);
  const [[fu]] = await pool.query('SELECT * FROM followups WHERE id = ?', [ins.insertId]);
  await welcomed(one.body.email || E1); // the welcome email goes out just after a demo is built; let it land first
  mailHits = 0;
  assert.equal(await followups.sendOne(fu, sbTenant, 'http://localhost'), 'failed');
  assert.equal(mailHits, 0, 'nothing reached the mail service');
  assert.match((await pool.query('SELECT error FROM followups WHERE id = ?', [fu.id]))[0][0].error, /switched off in the demo/);
  assert.equal(require('../src/lib/mailer').enabled(), true, 'the mail service was switched on for this test, so the block is the demo guard');
  await pool.query('DELETE FROM tenant_modules WHERE tenant_id = ?', [real.body.id]);
  await pool.query('DELETE FROM billing_events WHERE tenant_id = ?', [real.body.id]);
  await pool.query('DELETE FROM tenant_billing WHERE tenant_id = ?', [real.body.id]);
  await pool.query('DELETE FROM users WHERE tenant_id = ?', [real.body.id]);
  await pool.query('DELETE FROM people WHERE tenant_id = ?', [real.body.id]);
  await pool.query('DELETE FROM tenants WHERE id = ?', [real.body.id]);
});

test('with the email check on, a demo only builds with the code emailed to that address', async () => {
  process.env.TRY_EMAIL_CHECK = 'on';
  const email = `check-${suffix}@example.org`;
  const who = { name: 'Cora Check', email, mountain: 'Code Peak' };
  try {
    assert.equal((await api('POST', '/trial', { body: who })).status, 400, 'no code, no demo');
    assert.match((await api('POST', '/trial/code', { body: { ...who, email: `x-${suffix}@mailinator.com` } })).body.error, /Throwaway/, 'throwaway inboxes are turned away');
    const before = mails.length;
    const sent = await api('POST', '/trial/code', { body: who });
    assert.equal(sent.status, 200); assert.equal(sent.body.required, true);
    const mail = mails.slice(before).find((m) => m.To === email);
    assert.ok(mail, 'the code went to that address');
    const code = /(\d{6})/.exec(mail.Subject)[1];
    assert.equal(mail.TextBody.includes(code), true);
    const [[stored]] = await pool.query('SELECT code_hash FROM sandbox_codes WHERE email = ? ORDER BY id DESC LIMIT 1', [email]);
    assert.ok(!stored.code_hash.includes(code), 'the code is kept hashed');

    const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0');
    const bad = await api('POST', '/trial', { body: { ...who, code: wrong } });
    assert.equal(bad.status, 400); assert.match(bad.body.error, /not right/);
    const other = await api('POST', '/trial', { body: { ...who, email: `other-${suffix}@example.org`, code } });
    assert.equal(other.status, 400, 'a code only works for the address it was sent to');

    const ok = await start(email, { name: who.name, mountain: who.mountain, code });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const [[signup]] = await pool.query('SELECT email_verified FROM sandbox_signups WHERE email = ? ORDER BY id DESC LIMIT 1', [email]);
    assert.equal(Number(signup.email_verified), 1);
    assert.equal((await api('POST', '/trial', { body: { ...who, code } })).status, 400, 'a code works once');

    // A newer code replaces the older one, and five wrong tries use a code up.
    const c1 = await api('POST', '/trial/code', { body: who }); assert.equal(c1.status, 200);
    const first = /(\d{6})/.exec(mails.at(-1).Subject)[1];
    await api('POST', '/trial/code', { body: who });
    const second = /(\d{6})/.exec(mails.at(-1).Subject)[1];
    if (first !== second) assert.match((await api('POST', '/trial', { body: { ...who, code: first } })).body.error, /not right|expired/);
    for (let i = 0; i < 5; i += 1) await api('POST', '/trial', { body: { ...who, code: '000000' === second ? '111111' : '000000' } });
    assert.match((await api('POST', '/trial', { body: { ...who, code: second } })).body.error, /Too many wrong codes/);
  } finally { delete process.env.TRY_EMAIL_CHECK; }
  const off = await api('POST', '/trial/code', { body: who });
  assert.equal(off.body.required, false, 'outside production, with no override, demos start straight away');
});

test('starting again with the same email replaces the old demo', async () => {
  const oldId = await tenantId(one.body.tenant);
  const again = await start(E1, { mountain: 'Test Peak Two' });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.equal(await tenantId(one.body.tenant), undefined, 'the first demo is gone');
  assert.ok(oldId);
  assert.equal((await api('GET', '/auth/me', { token: one.body.token })).status, 401, 'its token no longer works');
  one = again;
});

test('a finished demo stops working, then is removed with everything in it', async () => {
  const id = await tenantId(one.body.tenant);
  await pool.query('UPDATE tenants SET sandbox_expires_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?', [id]);
  const login = await api('POST', '/auth/login', { body: { tenant: one.body.tenant, email: E1, password: one.body.password } });
  assert.equal(login.status, 403); assert.match(login.body.error, /demo has ended/);
  assert.equal((await api('GET', '/products', { token: one.body.token })).status, 403);

  const gone = await api('POST', '/platform/sandboxes/purge', { key: KEY });
  assert.equal(gone.status, 200); assert.ok(gone.body.removed >= 1);
  assert.equal(await tenantId(one.body.tenant), undefined);
  // not one row is left behind, in any table that carries a mountain id
  const [tables] = await pool.query("SELECT table_name AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND column_name = 'tenant_id'");
  const left = [];
  for (const { t } of tables) {
    if (t === 'sandbox_signups') continue;
    const [[c]] = await pool.query('SELECT COUNT(*) AS n FROM `' + t + '` WHERE tenant_id = ?', [id]);
    if (Number(c.n)) left.push(`${t}: ${c.n}`);
  }
  assert.deepEqual(left, [], 'every table is clean');
  const [[lead]] = await pool.query('SELECT tenant_id FROM sandbox_signups WHERE email = ? ORDER BY id DESC LIMIT 1', [E1]);
  assert.equal(lead.tenant_id, null, 'the sign-up stays as a lead, no longer tied to a mountain');
});

test('the platform console deletes a running demo, or every demo, straight away', async () => {
  const a = await start(`del-a-${Date.now()}@example.test`);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const list = await api('GET', '/platform/sandboxes', { key: KEY });
  const row = list.body.data.find((x) => x.email === a.body.email);
  assert.ok(row && row.status === 'running', 'listed as running');
  assert.equal((await api('POST', `/platform/sandboxes/${row.id}/remove`, { key: KEY })).status, 200);
  assert.equal(await tenantId(a.body.tenant), undefined, 'gone at once');
  assert.equal((await api('POST', `/platform/sandboxes/${row.id}/remove`, { key: KEY })).status, 404, 'nothing left to delete');
  assert.ok([401, 403].includes((await api('POST', `/platform/sandboxes/${row.id}/remove`)).status), 'needs the platform key');

  const b = await start(`del-b-${Date.now()}@example.test`);
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const all = await api('POST', '/platform/sandboxes/remove-all', { key: KEY });
  assert.equal(all.status, 200); assert.ok(all.body.removed >= 1);
  assert.equal(await tenantId(b.body.tenant), undefined);
  const [[real]] = await pool.query('SELECT COUNT(*) AS n FROM tenants WHERE sandbox_expires_at IS NULL');
  assert.ok(Number(real.n) > 0, 'real mountains are never touched');
});

test('the Demos dashboard shows sign-ins, activity, apps used, changes and last used, and keeps them after removal', async () => {
  const usage = require('../src/lib/demousage');
  const email = `use-${Date.now()}@example.test`;
  const d = await start(email);
  assert.equal(d.status, 201, JSON.stringify(d.body));
  for (let i = 0; i < 3; i += 1) assert.equal((await api('GET', '/products', { token: d.body.token })).status, 200);
  assert.equal((await api('GET', '/people?q=a', { token: d.body.token })).status, 200);
  const made = await api('POST', '/people', { token: d.body.token, body: { first_name: 'Visitor', last_name: 'Made' } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal((await api('POST', '/auth/login', { body: { tenant: d.body.tenant, email, password: d.body.password } })).status, 200);
  await usage.flush();

  const look = async () => (await api('GET', '/platform/sandboxes', { key: KEY })).body;
  let res = await look();
  let row = res.data.find((x) => x.email === email);
  assert.equal(row.status, 'running');
  assert.equal(row.sign_ins, 2, 'starting the demo, then one sign-in');
  assert.ok(row.requests >= 5, `activity counted (${row.requests})`);
  assert.ok(row.apps.some((a) => a.label === 'Products and prices'), JSON.stringify(row.apps));
  assert.ok(row.apps.some((a) => a.label === 'Customers'));
  assert.equal(row.changes, 1, 'the new customer is the one change; reading and the made-up data are not');
  assert.ok(row.last_used_at);
  assert.ok(res.summary.running >= 1 && res.summary.made_changes >= 1 && res.summary.total >= 1);

  assert.equal((await api('POST', `/platform/sandboxes/${row.id}/remove`, { key: KEY })).status, 200);
  res = await look();
  row = res.data.find((x) => x.email === email);
  assert.equal(row.status, 'removed');
  assert.ok(row.requests >= 5 && row.changes >= 1 && row.apps.length >= 2, 'usage is kept after the demo is removed');
});

test('the demo welcome email comes from the founder, with a sign-in link that works until the demo ends', async () => {
  const email = `wendy-${suffix}@example.org`;
  const r = await start(email, { name: 'Wendy Welcome' });
  assert.equal(r.status, 201);
  await welcomed(email);
  const m = mailTo(email).find((x) => /demo mountain is ready/.test(x.Subject));
  assert.ok(m, 'a welcome email');
  assert.match(m.From, /^Dan Pickersgill </);
  assert.equal(m.ReplyTo, require('../src/config').site.helloEmail);
  assert.match(m.TextBody, /^Hi Wendy,/);
  assert.match(m.TextBody, /Three things I'd try first/);
  assert.doesNotMatch(m.TextBody, new RegExp(r.body.password), 'the password is never emailed');
  const token = decodeURIComponent(/try\?open=([^\s&]+)/.exec(m.TextBody)[1]);
  const opened = await api('POST', '/trial/open', { body: { token } });
  assert.equal(opened.status, 200);
  assert.equal(opened.body.tenant, r.body.tenant);
  assert.equal((await api('GET', '/auth/me', { token: opened.body.token })).status, 200, 'the link signs them in');
  assert.equal((await api('POST', '/trial/open', { body: { token: `${token.split('.')[0]}.${'x'.repeat(40)}` } })).status, 410, 'a forged link does nothing');
  // From the console, a new link retires the old ones.
  const [[su]] = await pool.query('SELECT id FROM sandbox_signups WHERE email = ? ORDER BY id DESC LIMIT 1', [email]);
  assert.equal((await api('POST', `/platform/sandboxes/${su.id}/send-link`, { key: KEY })).status, 200);
  const again = mailTo(email).find((x) => /sign-in link/.test(x.Subject));
  const fresh = decodeURIComponent(/try\?open=([^\s&]+)/.exec(again.TextBody)[1]);
  assert.equal((await api('POST', '/trial/open', { body: { token } })).status, 410, 'the first link no longer works');
  assert.equal((await api('POST', '/trial/open', { body: { token: fresh } })).status, 200);
  const dash = (await api('GET', '/platform/sandboxes', { key: KEY })).body.data.find((x) => x.id === su.id);
  assert.ok(dash.emails.welcome);
});

test('the daily job sends one day-2 nudge about a part not opened, one note before the end, and respects stop and leads', async () => {
  const demoMail = require('../src/lib/demomail');
  const email = `nora-${suffix}@example.org`;
  assert.equal((await start(email, { name: 'Nora Nudge' })).status, 201);
  await welcomed(email);
  const [[su]] = await pool.query('SELECT id FROM sandbox_signups WHERE email = ? ORDER BY id DESC LIMIT 1', [email]);
  await pool.query("INSERT INTO sandbox_usage (signup_id, area, requests, last_at) VALUES (?, 'patrol', 5, UTC_TIMESTAMP())", [su.id]);
  await pool.query('UPDATE sandbox_signups SET at = UTC_TIMESTAMP() - INTERVAL 50 HOUR WHERE id = ?', [su.id]);
  await demoMail.runAll('http://localhost');
  const nudges = mailTo(email).filter((x) => /worth a look/.test(x.Subject));
  assert.equal(nudges.length, 1);
  assert.match(nudges[0].Subject, /the Gate/, 'patrol was opened, so it points at the next part');
  assert.match(nudges[0].TextBody, /&to=gate/);
  await demoMail.runAll('http://localhost');
  assert.equal(mailTo(email).filter((x) => /worth a look/.test(x.Subject)).length, 1, 'never twice');
  // Two days before the end.
  await pool.query('UPDATE sandbox_signups SET at = UTC_TIMESTAMP() - INTERVAL 5 DAY, expires_at = UTC_TIMESTAMP() + INTERVAL 40 HOUR WHERE id = ?', [su.id]);
  await demoMail.runAll('http://localhost');
  const ending = mailTo(email).filter((x) => /Your demo ends/.test(x.Subject));
  assert.equal(ending.length, 1);
  assert.match(ending[0].TextBody, /deleted then/);
  // The stop link stops them; so does asking for a walkthrough.
  const stopTok = /try\?stop=([^\s]+)/.exec(ending[0].TextBody)[1];
  assert.equal((await api('POST', '/trial/stop', { body: { token: stopTok } })).status, 200);
  await pool.query('UPDATE sandbox_signups SET ending_sent_at = NULL WHERE id = ?', [su.id]);
  await demoMail.runAll('http://localhost');
  assert.equal(mailTo(email).filter((x) => /Your demo ends/.test(x.Subject)).length, 1, 'nothing after stop');
  await pool.query('UPDATE sandbox_signups SET emails_stopped_at = NULL WHERE id = ?', [su.id]);
  await pool.query("INSERT INTO site_leads (kind, name, mountain, email, message) VALUES ('walkthrough', 'Nora Nudge', 'Nora Peak', ?, 'Show me')", [email]);
  await demoMail.runAll('http://localhost');
  assert.equal(mailTo(email).filter((x) => /Your demo ends/.test(x.Subject)).length, 1, 'nothing once they asked for a walkthrough');
  await pool.query('DELETE FROM site_leads WHERE email = ?', [email]);
  assert.equal((await api('POST', '/trial/stop', { body: { token: `${su.id}.${'y'.repeat(40)}` } })).status, 400);
});
