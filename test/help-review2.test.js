'use strict';

// The re-review of the guest help release: held alerts are saved and sent by a durable path (the 5-minute guests job),
// once; the "no one on duty" fallback is one summary per mountain a minute, with the patrol phone's texts capped. The
// in-process timers are off here, as when Cloud Run gives a process no CPU between requests or restarts it.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '100000';
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'tw-token';
process.env.TWILIO_FROM = '+16105550000';
process.env.PUBLIC_URL = 'https://app.verdynt.test';
process.env.HELP_FLOOD_ALERT_GAP_S = '1';
process.env.HELP_NOBODY_GAP_S = '3';
process.env.HELP_NOBODY_TEXT_HOURLY_CAP = '3';
process.env.HELP_ALERT_TIMERS = 'off';
process.env.JOBS_KEY = 'test-jobs-key-help-review-2';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { signature, PATH } = require('../src/routes/helpsms');
const HL = require('../src/lib/helpline');
const PUSH = require('../src/lib/push');

let server; let base; let tw;
const sent = []; // texts our server asked Twilio to send
const pushes = []; // phone alerts to staff on duty
const userPushes = []; // phone alerts to owners and managers
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const REC = require('./helpers/records').records(() => base, () => PW);
let phoneN = 1000 + Math.floor(Math.random() * 8000);
const guestPhone = () => `+1610555${String(phoneN++).padStart(4, '0')}`;
let sidN = 0;
const sid = () => `SM${suffix}${String(++sidN).padStart(6, '0')}`.padEnd(34, '0').slice(0, 34);
let ipN = 0;
const freshIp = () => `10.77.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`;
const rid = () => require('crypto').randomBytes(16).toString('hex');

async function api(method, p, { token, body, headers } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const ok = (r, want) => { assert.ok(want ? r.status === want : r.status < 300, `HTTP ${r.status}: ${String(r.text).slice(0, 300)}`); return r.body; };
const q = async (sql, params) => (await pool.query(sql, params))[0];
const waitFor = async (fn, ms = 5000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 50)); } };
const notes = async (callId) => (await q('SELECT note FROM dispatch_events WHERE call_id = ? ORDER BY id', [callId])).map((e) => e.note || '');

async function text(fields) {
  const params = { AccountSid: 'ACtest', MessageSid: sid(), NumMedia: '0', ...fields };
  const headers = { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature('tw-token', `${process.env.PUBLIC_URL}${PATH}`, params) };
  const res = await fetch(`${base}${PATH}`, { method: 'POST', headers, body: new URLSearchParams(params).toString() });
  const body = await res.text();
  const m = body.match(/<Message>([\s\S]*)<\/Message>/);
  return { status: res.status, reply: m ? m[1] : null, params };
}
const latestSms = async (M, phone) => (await q("SELECT * FROM dispatch_calls WHERE tenant_id = ? AND caller_phone = ? AND source = 'sms' ORDER BY id DESC LIMIT 1", [M.id, phone]))[0];
const help = (M, body, { dev, ip } = {}) => api('POST', `/public/${M.slug}/help`, { body, headers: { 'x-forwarded-for': ip || freshIp(), ...(dev ? { 'x-device': dev } : {}) } });
const callOf = async (token) => (await q('SELECT * FROM dispatch_calls WHERE guest_token = ?', [token]))[0];

let lineN = 0;
async function mountain(tag) {
  const slug = `hr${tag}-${suffix}`.slice(0, 40);
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key', 'x-forwarded-for': freshIp() }, body: JSON.stringify({ slug, name: `Mount ${tag.toUpperCase()}`, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201, await res.text());
  const owner = await REC((await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token);
  const id = Number((await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id);
  const line = `+1484${String(Date.now() + (++lineN) * 7919).slice(-7)}`;
  const patrolPhone = `+1215${String(Date.now() * 7 + lineN * 104729).slice(-7)}`; // unique per run: the guests job serves every mountain
  ok(await api('PUT', '/patrol/guest-help', { token: owner, body: { enabled: true } }));
  ok(await api('PUT', '/patrol/text-help', { token: owner, body: { help_number: line, patrol_phone: patrolPhone } }));
  const ownerUser = Number((await q('SELECT id FROM users WHERE tenant_id = ? AND role = ? LIMIT 1', [id, 'owner']))[0].id);
  return { slug, owner, id, line, patrolPhone, ownerUser, name: `Mount ${tag.toUpperCase()}` };
}
/** Someone signed in on patrol duty for the length of fn. */
async function onDuty(M, fn) {
  const staff = ok(await api('POST', '/workforce/staff', { token: M.owner, body: { person: { first_name: 'Duty', last_name: 'Patroller' }, status: 'active' } }), 201).id;
  const now = require('../src/lib/util').nowIn((await q('SELECT timezone FROM tenants WHERE id = ?', [M.id]))[0].timezone);
  await pool.query("INSERT INTO patrol_duty (tenant_id, staff_id, on_date, signed_in_at, source) VALUES (?, ?, ?, ?, 'phone')", [M.id, staff, now.slice(0, 10), now]);
  try { return await fn(Number(staff)); } finally { await pool.query('UPDATE patrol_duty SET signed_out_at = signed_in_at WHERE tenant_id = ? AND staff_id = ?', [M.id, staff]); }
}

let A; let B;
test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  let n = 0;
  tw = await new Promise((r) => {
    const s = http.createServer((req, res) => {
      let d = '';
      req.on('data', (c) => { d += c; });
      req.on('end', () => { sent.push(Object.fromEntries(new URLSearchParams(d))); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ sid: `SM${++n}` })); });
    });
    s.listen(0, '127.0.0.1', () => r(s));
  });
  process.env.TWILIO_API_BASE = `http://127.0.0.1:${tw.address().port}`;
  PUSH.notifyStaff = async (tenantId, staffIds, message) => { pushes.push({ tenantId, staffIds: staffIds.map(Number), message }); return staffIds.length; };
  PUSH.notifyUsers = async (tenantId, userIds, message) => { userPushes.push({ tenantId, userIds: userIds.map(Number), message }); return userIds.length; };
  A = await mountain('a2');
  B = await mountain('b2');
});
test.after(async () => { await new Promise((r) => server.close(r)); tw.close(); await pool.end(); });
const job = async () => ok(await api('POST', '/internal/jobs/guests', { headers: { 'x-jobs-key': process.env.JOBS_KEY } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a held flood alert whose timer never fires is sent by the guests job, exactly once', async () => {
  await onDuty(A, async () => {
    const ip = freshIp();
    for (let i = 0; i < 6; i++) ok(await help(A, { kind: 'help', rid: rid() }, { dev: `flood-two-${i}-abcdefghij`, ip }), 201);
    const head = (await q('SELECT flood_of FROM dispatch_calls WHERE tenant_id = ? AND flood_of IS NOT NULL ORDER BY id LIMIT 1', [A.id]))[0].flood_of;
    const flood = () => pushes.filter((p) => p.message.tag === `flood-${head}`);
    await waitFor(() => flood().length === 1);
    ok(await help(A, { kind: 'help', rid: rid(), location: 'Last junk' }, { dev: 'flood-two-7-abcdefghij', ip }), 201); // inside the gap: held
    await waitFor(async () => (await q('SELECT flood_pending_at FROM dispatch_calls WHERE id = ?', [head]))[0].flood_pending_at);
    assert.ok((await q('SELECT flood_pending_at FROM dispatch_calls WHERE id = ?', [head]))[0].flood_pending_at, 'saved, not only in memory');
    await sleep(2300); // the gap is up; no timer runs in this process
    assert.equal(flood().length, 1, 'nothing sent yet without the timer');
    const out = await job();
    assert.ok(out.help_alerts.floods >= 1, JSON.stringify(out.help_alerts)); // other mountains' held alerts may go too
    assert.equal(flood().length, 2, 'the job sent it');
    assert.match(flood()[1].message.title, /2 more requests from the same place/);
    assert.match(flood()[1].message.body, /^Latest: Last junk\./);
    assert.equal((await q('SELECT flood_pending_at FROM dispatch_calls WHERE id = ?', [head]))[0].flood_pending_at, null);
    // Never twice: the job again, and the board (which also sends what is due).
    await job();
    ok(await api('GET', '/patrol/dispatch', { token: A.owner }));
    await sleep(200);
    assert.equal(flood().length, 2);
  });
});

test('no one on duty: one summary per mountain a minute, texts capped per hour, a note on every call, and a lost child at once', async () => {
  const toPatrol = () => sent.filter((x) => x.To === B.patrolPhone);
  const pushed = () => userPushes.filter((p) => p.tenantId === B.id);
  const ip = freshIp();
  const calls = [];
  for (let i = 0; i < 6; i++) calls.push(await callOf(ok(await help(B, { kind: 'help', rid: rid(), location: `Spot ${i}` }, { dev: `nobody-phone-${i}-abcdefg`, ip: freshIp() }), 201).token));
  await waitFor(async () => (await q("SELECT COUNT(*) AS n FROM dispatch_events WHERE tenant_id = ? AND note LIKE 'No one on duty was alerted%'", [B.id]))[0].n === 6);
  for (const c of calls) assert.equal((await notes(c.id)).filter((n) => n.startsWith('No one on duty was alerted')).length, 1, 'every call gets the note');
  const board = ok(await api('GET', '/patrol/dispatch', { token: B.owner })).data;
  assert.ok(calls.every((c) => board.find((x) => x.id === c.id).nobody_alerted), 'and the red banner');
  assert.equal(toPatrol().length, 1, JSON.stringify(toPatrol().map((x) => x.Body)));
  assert.equal(pushed().length, 1, 'one push to owners and managers, not six');
  // A lost child, inside the minute: its own fallback at once.
  const lc = await callOf(ok(await help(B, { kind: 'lost_child', rid: rid(), location: 'Magic carpet' }, { dev: 'nobody-parent-abcdefg', ip }), 201).token);
  await waitFor(() => toPatrol().length === 2);
  assert.match(toPatrol()[1].Body, /^No one on duty\. Lost child: patrol call /);
  assert.ok(pushed().some((p) => p.message.tag === `call-${lc.id}`));
  // The minute is up: the job sends the summary of the other five, once.
  await sleep(4300);
  await job();
  assert.equal(toPatrol().length, 3);
  assert.equal(pushed().length, 3);
  assert.equal(pushed()[2].message.title, '5 help requests, no one on duty was alerted');
  assert.match(toPatrol()[2].Body, /^5 help requests, no one on duty was alerted\. Latest: Spot 5\./);
  await job();
  assert.equal(pushed().length, 3, 'never twice');
  assert.equal(toPatrol().length, 3);
  // The hourly cap (3 here) is reached: the next summary is pushed but not texted. A lost child still is.
  ok(await help(B, { kind: 'help', rid: rid(), location: 'Spot 7' }, { dev: 'nobody-phone-7-abcdefg', ip: freshIp() }), 201);
  await sleep(4300);
  await job();
  assert.equal(pushed().length, 4);
  assert.equal(toPatrol().length, 3, 'capped');
  ok(await help(B, { kind: 'lost_child', rid: rid(), location: 'Lodge' }, { dev: 'nobody-parent2-abcdef', ip: freshIp() }), 201);
  await waitFor(() => toPatrol().length === 4);
  assert.equal(toPatrol().length, 4, 'a lost child is never capped');
});
