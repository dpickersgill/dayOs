'use strict';

// Release 2026.11.11, patrol track: regressions for the Oct 31 review findings (PATROL-1 to 14, CR-3, DP-8, DP-9, DP-10)
// and the patrol suspicions that were confirmed. Each test is the review's proof turned around: it fails if the defect returns.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '100000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server;
let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const TZ = 'America/New_York';

async function api(method, path, { token, body, headers } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const ok = (r, want) => { assert.ok(want ? r.status === want : r.status < 300, `HTTP ${r.status}: ${r.text.slice(0, 300)}`); return r.body; };
const q = async (sql, params) => (await pool.query(sql, params))[0];
let n = 0;
async function mountain(tag) {
  const slug = `f11p${tag}-${suffix}-${++n}`.slice(0, 40);
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const owner = (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token;
  const tenantId = (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id;
  return { slug, owner, tenantId };
}
async function addUser(m, email, role, extra = {}) {
  ok(await api('POST', '/users', { token: m.owner, body: { email, password: PW, role, ...extra } }), 201);
  return (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token;
}
const staff = async (m, first) => ok(await api('POST', '/workforce/staff', { token: m.owner, body: { person: { first_name: first, last_name: 'Patroller' }, status: 'active' } }), 201).id;
const tzNow = (addMin = 0) => {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(Date.now() + addMin * 60000)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
// A new mountain is limited to 5 a minute from one address: tests share mountains unless they need a fresh one.
const made = new Map();
async function patrolMountain(tag = 'main') {
  if (made.has(tag)) return made.get(tag);
  const m = await mountain(tag);
  made.set(tag, m);
  m.s1 = await staff(m, 'Pat');
  m.pat = await addUser(m, `pat@${m.slug}.test`, 'patrol', { staff_id: m.s1 });
  return m;
}
const newCase = async (token, over = {}) => ok(await api('POST', '/patrol/incidents', { token, body: { occurred_at: tzNow(-30), location: 'Upper Ridge', category: 'injury', severity: 'minor', summary: 'Wrist injury', ...over } }), 201);
async function readyCase(token, over = {}) {
  const c = await newCase(token, over);
  const p = ok(await api('POST', `/patrol/incidents/${c.id}/patients`, { token, body: { first_name: 'Sam', last_name: 'Skier', age_years: 30, chief_complaint: 'Left wrist pain', disposition: 'treated_released', form: { head_strike: 'no' } } }), 201);
  return { id: c.id, pid: p.id };
}
async function approvedCase(m) {
  const c = await readyCase(m.pat);
  ok(await api('POST', `/patrol/incidents/${c.id}/submit`, { token: m.pat }));
  ok(await api('POST', `/patrol/incidents/${c.id}/approve`, { token: m.owner }));
  return c;
}

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

// ---------------------------------------------------------------- PATROL-1
test('PATROL-1: a case on legal hold cannot be reopened, signed off or approved, and its protocol stamp never changes', async () => {
  const m = await patrolMountain();
  ok(await api('PUT', '/patrol/ops-settings', { token: m.owner, body: { medical_director: 'Dr. Original', protocol_version: 'v1' } }));
  const c = await approvedCase(m);
  ok(await api('PUT', `/patrol/incidents/${c.id}/legal-hold`, { token: m.owner, body: { hold: true, note: 'Claim received' } }));
  const before = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: m.owner }));
  assert.equal((await api('POST', `/patrol/incidents/${c.id}/reopen`, { token: m.owner, body: { reason: 'tidy up' } })).status, 409);
  assert.equal((await api('POST', `/patrol/incidents/${c.id}/submit`, { token: m.owner })).status, 409);
  assert.equal((await api('POST', `/patrol/incidents/${c.id}/approve`, { token: m.owner })).status, 409);
  const after = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: m.owner }));
  assert.equal(after.report_state, 'approved');
  assert.equal(after.versions.length, before.versions.length);
  // A draft on hold cannot be signed off either.
  const d = await readyCase(m.pat);
  ok(await api('PUT', `/patrol/incidents/${d.id}/legal-hold`, { token: m.owner, body: { hold: true, note: 'Claim received' } }));
  const sub = await api('POST', `/patrol/incidents/${d.id}/submit`, { token: m.pat });
  assert.equal(sub.status, 409);
  assert.match(sub.body.error, /legal hold/);
});

test('PATROL-1: re-signing a reopened report keeps the first protocol stamp', async () => {
  const m = await patrolMountain();
  ok(await api('PUT', '/patrol/ops-settings', { token: m.owner, body: { medical_director: 'Dr. Original', protocol_version: 'v1' } }));
  const c = await approvedCase(m);
  const first = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: m.owner })).protocol_stamp;
  assert.match(first, /Dr\. Original/);
  ok(await api('PUT', '/patrol/ops-settings', { token: m.owner, body: { medical_director: 'Dr. New', protocol_version: 'v2' } }));
  ok(await api('POST', `/patrol/incidents/${c.id}/reopen`, { token: m.owner, body: { reason: 'Fix the outcome' } }));
  ok(await api('POST', `/patrol/incidents/${c.id}/submit`, { token: m.pat }));
  assert.equal(ok(await api('GET', `/patrol/incidents/${c.id}`, { token: m.owner })).protocol_stamp, first);
});

// ---------------------------------------------------------------- PATROL-2
test('PATROL-2: a reopened report is not shown or released as approved', async () => {
  const m = await patrolMountain();
  const c = await approvedCase(m);
  ok(await api('POST', `/patrol/incidents/${c.id}/reopen`, { token: m.owner, body: { reason: 'Wrong outcome recorded' } }));
  const cf = ok(await api('GET', `/patrol/incidents/${c.id}/claim-file`, { token: m.owner }));
  assert.equal(cf.basis, 'reopened');
  assert.equal(cf.report.report_state, 'draft');
  assert.equal(cf.withdrawn.version_no, 2);
  const score = ok(await api('GET', `/patrol/incidents/${c.id}/doc-score`, { token: m.owner }));
  assert.notEqual(score.basis, 'approved');
  ok(await api('POST', '/auth/step-up', { token: m.owner, body: { password: PW } }));
  const rq = ok(await api('POST', '/patrol/records', { token: m.owner, body: { incident_id: c.id, requester_kind: 'insurer', requester_name: 'Acme Mutual', received_on: tzNow().slice(0, 10), authorization: 'signed_release' } }), 201);
  const rel = await api('POST', `/patrol/records/${rq.id}/release`, { token: m.owner, body: {} });
  assert.equal(rel.status, 409);
  assert.match(rel.body.error, /reopened/);
});

// ---------------------------------------------------------------- PATROL-13
test('PATROL-13: the Reopened note is stamped on the mountain clock', async () => {
  const m = await patrolMountain();
  const c = await approvedCase(m);
  ok(await api('POST', `/patrol/incidents/${c.id}/reopen`, { token: m.owner, body: { reason: 'Wrong disposition' } }));
  ok(await api('POST', `/patrol/incidents/${c.id}/notes`, { token: m.owner, body: { body: 'Corrected after reopening.' } }), 201);
  const cs = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: m.owner }));
  const [reopen, later] = cs.notes;
  assert.match(reopen.body, /^Reopened/);
  assert.ok(String(reopen.created_at) <= String(later.created_at), `${reopen.created_at} > ${later.created_at}`);
  assert.ok(Math.abs(Date.parse(String(reopen.created_at).replace(' ', 'T')) - Date.parse(tzNow())) < 5 * 60000);
});

// ---------------------------------------------------------------- PATROL-3
async function sweepOn(m) {
  const t1 = ok(await api('POST', '/schedule/trails', { token: m.owner, body: { name: `Upper ${n}`, difficulty: 'blue' } }), 201).id;
  const t2 = ok(await api('POST', '/schedule/trails', { token: m.owner, body: { name: `Lower ${n}`, difficulty: 'green' } }), 201).id;
  const route = ok(await api('POST', '/patrol/sweep/routes', { token: m.owner, body: { name: 'Ridge', items: [{ trail_id: t1 }, { trail_id: t2 }] } }), 201).id;
  ok(await api('POST', '/patrol/sweep/start', { token: m.owner, body: { assignments: [{ route_id: route, staff_id: m.s1 }] } }), 201);
  const sw = ok(await api('GET', '/patrol/sweep', { token: m.pat }));
  return (sw.sweep || sw).runs[0];
}
test('PATROL-3: a person found on the sweep cannot be overwritten or deleted; undo keeps it with a reason', async () => {
  const m = await patrolMountain('sw');
  const run = await sweepOn(m);
  const [a, b] = run.stops;
  ok(await api('POST', `/patrol/sweep/runs/${run.id}/marks`, { token: m.pat, body: { item_id: a.id, flag: 'person', note: 'Child in trees' } }), 201);
  assert.equal((await api('POST', `/patrol/sweep/runs/${run.id}/marks`, { token: m.pat, body: { item_id: a.id, flag: 'none' } })).status, 409);
  assert.equal((await api('DELETE', `/patrol/sweep/runs/${run.id}/marks/${a.id}`, { token: m.pat })).status, 400, 'undo needs a reason');
  ok(await api('POST', `/patrol/sweep/runs/${run.id}/marks`, { token: m.pat, body: { item_id: b.id } }), 201);
  ok(await api('POST', `/patrol/sweep/runs/${run.id}/clear`, { token: m.pat, body: {} }));
  const clear = await api('POST', '/patrol/sweep/clear', { token: m.owner, body: {} });
  assert.equal(clear.status, 409);
  assert.match(clear.body.error, /dispatch call/);
  const log = ok(await api('GET', '/patrol/daily-log', { token: m.owner }));
  assert.equal(Number(log.sweep.routes[0].finds), 1);
});

test('PATROL-3: undo of a find marks it entered in error; a hazard needs a resolution before Mountain clear; all of it is logged', async () => {
  const m = await patrolMountain('sh');
  const run = await sweepOn(m);
  const [a, b] = run.stops;
  ok(await api('POST', `/patrol/sweep/runs/${run.id}/marks`, { token: m.pat, body: { item_id: a.id, flag: 'person', note: 'Thought I saw someone' } }), 201);
  assert.equal((await api('DELETE', `/patrol/sweep/runs/${run.id}/marks/${a.id}`, { token: m.pat, body: { reason: 'Tapped the wrong stop' } })).status, 204);
  const mk = (await q('SELECT * FROM patrol_sweep_marks WHERE tenant_id = ? AND run_id = ? AND item_id = ?', [m.tenantId, run.id, a.id]))[0];
  assert.equal(mk.flag, 'person');
  assert.equal(mk.resolved_kind, 'error');
  assert.equal(mk.resolution, 'Tapped the wrong stop');
  const hz = ok(await api('POST', `/patrol/sweep/runs/${run.id}/marks`, { token: m.pat, body: { item_id: b.id, flag: 'hazard', note: 'Rock exposed by the cat track' } }), 201).id;
  ok(await api('POST', `/patrol/sweep/runs/${run.id}/clear`, { token: m.pat, body: {} }));
  const blocked = await api('POST', '/patrol/sweep/clear', { token: m.owner, body: {} });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /hazard/);
  ok(await api('POST', `/patrol/sweep/marks/${hz}/resolve`, { token: m.owner, body: { resolution: 'Roped off and signed' } }));
  ok(await api('POST', '/patrol/sweep/clear', { token: m.owner, body: {} }));
  const hist = await q('SELECT action, flag FROM patrol_sweep_mark_log WHERE tenant_id = ? AND run_id = ? ORDER BY id', [m.tenantId, run.id]);
  assert.deepEqual(hist.map((x) => `${x.action}:${x.flag}`), ['mark:person', 'error:person', 'mark:hazard', 'resolve:hazard']);
});

// ---------------------------------------------------------------- PATROL-4
test('PATROL-4: a flood of guest help requests never shuts the page; repeats from one phone are grouped on the board', async () => {
  const m = await patrolMountain('gh');
  ok(await api('PUT', '/patrol/guest-help', { token: m.owner, body: { enabled: true, message: 'Tell us where you are' } }));
  const send = (body, dev, ip) => api('POST', `/public/${m.slug}/help`, { body, headers: { 'x-forwarded-for': ip, ...(dev ? { 'x-device': dev } : {}) } });
  let made = 0; let warned = 0;
  for (let i = 0; i < 25; i++) {
    const r = await send({ location: `Lift ${i} tower`, description: 'help' }, 'prank-phone-0123456789', '203.0.113.9');
    if (r.status === 201) made += 1;
    if (r.body.warning) warned += 1;
  }
  assert.equal(made, 25, 'every request is accepted');
  assert.ok(warned >= 15, 'the same phone sending again and again is told patrol already has its requests');
  const real = await send({ location: 'Upper Ridge, by the trees', description: 'My son hit a tree' }, 'real-guest-phone-abcdef12', '198.51.100.77');
  assert.equal(real.status, 201);
  assert.equal(real.body.warning, undefined);
  const board = ok(await api('GET', '/patrol/dispatch', { token: m.owner }));
  const realCall = board.data.find((c) => c.location.startsWith('Upper Ridge'));
  assert.ok(realCall && !realCall.flood_of, 'the real request is on the board on its own');
  const group = board.data.find((c) => c.repeats && c.repeats.length);
  assert.ok(group, 'the flood is grouped');
  assert.equal(group.repeats.length, 23);
  assert.equal(board.data.filter((c) => c.location.startsWith('Lift ')).length, 2, 'the first two from the phone, then one group');
  assert.equal(group.sender_hash, undefined);
  assert.equal(group.ip_hash, undefined);
  const n = (await q("SELECT COUNT(*) AS n FROM dispatch_calls WHERE tenant_id = ? AND source = 'guest'", [m.tenantId]))[0].n;
  assert.equal(Number(n), 26, 'nothing is dropped');
});

// ---------------------------------------------------------------- PATROL-14
test('PATROL-14: number boxes (height, weight) are at least 64 px wide, even in an input row', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  assert.match(css, /\.input-row input\.short-num[^{]*\{[^}]*min-width:\s*64px/);
});

// ---------------------------------------------------------------- PATROL-5, DP-9: staff injury notices
/** Turns email on for one test, with a stand-in Postmark that can be down. */
async function withMail(fn) {
  const http = require('node:http');
  const mailer = require('../src/lib/mailer');
  const box = { up: true, got: [] };
  const pm = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
      if (!box.up) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"ErrorCode":503,"Message":"down"}'); return; }
      box.got.push(JSON.parse(b)); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ErrorCode":0,"MessageID":"x"}');
    });
  });
  await new Promise((r) => pm.listen(0, '127.0.0.1', r));
  const was = { base: mailer.settings.apiBase, token: process.env.POSTMARK_SERVER_TOKEN, from: process.env.MAIL_FROM };
  mailer.settings.apiBase = `http://127.0.0.1:${pm.address().port}`; process.env.POSTMARK_SERVER_TOKEN = 'test'; process.env.MAIL_FROM = 'patrol@example.test';
  try { await fn(box); } finally {
    mailer.settings.apiBase = was.base;
    if (was.token === undefined) delete process.env.POSTMARK_SERVER_TOKEN; else process.env.POSTMARK_SERVER_TOKEN = was.token;
    if (was.from === undefined) delete process.env.MAIL_FROM; else process.env.MAIL_FROM = was.from;
    pm.close();
  }
}

test('PATROL-5: an OSHA notice that could not be sent is not marked sent, and is sent on the next save or by the job', async () => {
  const m = await patrolMountain();
  await withMail(async (box) => {
    box.up = false;
    const c = await newCase(m.pat, { severity: 'serious' });
    const p = ok(await api('POST', `/patrol/incidents/${c.id}/patients`, { token: m.pat, body: { first_name: 'Lee', last_name: 'Liftop', form: { patient_type: 'staff_work' }, disposition: 'transported_ambulance' } }), 201);
    const row = (await q('SELECT staff_noted_at, staff_serious_noted_at FROM incident_patients WHERE id = ?', [p.id]))[0];
    assert.equal(row.staff_noted_at, null, 'not marked sent while Postmark is down');
    assert.equal(row.staff_serious_noted_at, null);
    box.up = true;
    const SI = require('../src/lib/staffinjury');
    const r = await SI.retryDue('http://app.test');
    assert.ok(r.sent >= 1);
    assert.equal(box.got.filter((g) => /OSHA/.test(g.TextBody)).length, 1, 'the OSHA notice went out once');
    const again = await SI.retryDue('http://app.test');
    assert.equal(box.got.filter((g) => /OSHA/.test(g.TextBody)).length, 1, 'and only once');
    assert.equal(again.due >= 0, true);
  });
});

test('DP-9: staff injury notices go only to owners and the people named for the register, with no name in the subject', async () => {
  const m = await patrolMountain();
  await addUser(m, `mgr@${m.slug}.test`, 'manager');
  const named = await addUser(m, `hr@${m.slug}.test`, 'manager');
  const hrId = (await q('SELECT id FROM users WHERE tenant_id = ? AND email = ?', [m.tenantId, `hr@${m.slug}.test`]))[0].id;
  await q('INSERT INTO staff_injury_access (tenant_id, user_id) VALUES (?, ?)', [m.tenantId, hrId]);
  assert.ok(named);
  await withMail(async (box) => {
    const c = await newCase(m.pat, { severity: 'serious' });
    ok(await api('POST', `/patrol/incidents/${c.id}/patients`, { token: m.pat, body: { first_name: 'Erin', last_name: 'Workerdp9', form: { patient_type: 'staff_work' }, disposition: 'transported_ambulance' } }), 201);
    const to = box.got.map((g) => g.To).sort();
    assert.deepEqual(to, [`hr@${m.slug}.test`, `owner@${m.slug}.test`]);
    for (const g of box.got) {
      assert.doesNotMatch(g.Subject, /Erin|Workerdp9|hospital/);
      assert.match(g.TextBody, /Erin Workerdp9/, 'the body, to the register people only, names them');
    }
  });
  // A privacy case is never named, not even in the body.
  const c2 = await newCase(m.pat, { severity: 'minor' });
  const p2 = ok(await api('POST', `/patrol/incidents/${c2.id}/patients`, { token: m.pat, body: { first_name: 'Pia', last_name: 'Privatedp9', form: { patient_type: 'staff_work' }, disposition: 'treated_released' } }), 201);
  await q('UPDATE staff_injuries SET privacy_case = 1 WHERE tenant_id = ? AND patient_id = ?', [m.tenantId, p2.id]);
  await withMail(async (box) => {
    ok(await api('PATCH', `/patrol/incidents/${c2.id}/patients/${p2.id}`, { token: m.pat, body: { disposition: 'transported_ambulance' } }));
    assert.ok(box.got.length >= 1);
    for (const g of box.got) assert.doesNotMatch(`${g.Subject} ${g.TextBody}`, /Pia|Privatedp9/);
  });
});

// ---------------------------------------------------------------- PATROL-6
test('PATROL-6: a kit check sent late with an older time is kept but does not undo a newer use', async () => {
  const m = await patrolMountain();
  ok(await api('POST', '/patrol/kits/types/starter', { token: m.owner, body: { names: ['Trauma bag'] } }), 201);
  let board = ok(await api('GET', '/patrol/kits', { token: m.owner }));
  const type = board.types[0];
  const kit = ok(await api('POST', '/patrol/kits', { token: m.owner, body: { type_id: type.id, count: 1, location: 'Summit shack' } }), 201).data[0];
  const full = Object.fromEntries(type.contents.map((c) => [c.key, { qty: c.qty, expires_on: c.expires ? '2027-06-30' : null }]));
  const c = await readyCase(m.pat);
  ok(await api('POST', `/patrol/kits/${kit.id}/checks`, { token: m.owner, body: { kind: 'use', used: { tourniquet: 1 }, incident_id: c.id } }), 201);
  const late = ok(await api('POST', `/patrol/kits/${kit.id}/checks`, { token: m.pat, body: { kind: 'full', items: full, at: `${tzNow(-90).replace('T', ' ')}:00`, client_ref: `offline${suffix}` } }), 201);
  assert.equal(late.applied, false);
  board = ok(await api('GET', '/patrol/kits', { token: m.owner }));
  const end = board.kits.find((k) => k.id === kit.id);
  const stock = typeof end.stock === 'string' ? JSON.parse(end.stock) : end.stock || {};
  assert.notEqual(end.status, 'ready');
  assert.equal(stock.tourniquet.qty, 0);
  const one = ok(await api('GET', `/patrol/kits/${kit.id}`, { token: m.owner }));
  assert.ok(one.checks.some((x) => x.kind === 'full' && Number(x.applied) === 0), 'the late check is on the record');
  // A check made now does change it.
  ok(await api('POST', `/patrol/kits/${kit.id}/checks`, { token: m.pat, body: { kind: 'full', items: full } }), 201);
  board = ok(await api('GET', '/patrol/kits', { token: m.owner }));
  assert.equal(board.kits.find((k) => k.id === kit.id).status, 'ready');
});

// ---------------------------------------------------------------- suspicion: a phone clock running fast
test('suspicion: an entry refused for a future time carries the server clock so the phone can correct and resend it', async () => {
  const m = await patrolMountain();
  const c = await readyCase(m.pat);
  const far = new Date(Date.parse(`${tzNow()}:00Z`) + 3 * 86400000).toISOString().slice(0, 16);
  const r = await api('POST', `/patrol/incidents/${c.id}/patients/${c.pid}/vitals`, { token: m.pat, body: { taken_at: far, pulse: 80, client_ref: `fast${suffix}` } });
  assert.equal(r.status, 400);
  assert.equal(r.body.details.code, 'future_time');
  assert.equal(r.body.details.field, 'taken_at');
  assert.match(r.body.details.server_now, /^\d{4}-\d\d-\d\d \d\d:\d\d/);
  const fixed = await api('POST', `/patrol/incidents/${c.id}/patients/${c.pid}/vitals`, { token: m.pat, body: { taken_at: r.body.details.server_now.replace(' ', 'T').slice(0, 16), pulse: 80, client_ref: `fast${suffix}` } });
  assert.equal(fixed.status, 201);
});

// ---------------------------------------------------------------- PATROL-7
test('PATROL-7: a controlled waste, count or voided dose waits until the witness confirms it themselves', async () => {
  const m = await patrolMountain('cs');
  const sWit = await staff(m, 'Wanda');
  const wit = await addUser(m, `wanda@${m.slug}.test`, 'patrol', { staff_id: sWit });
  await q("INSERT IGNORE INTO patrol_members (tenant_id, staff_id, level, access_level) VALUES (?, ?, 'patroller', 'patrol'), (?, ?, 'leader', 'manager')", [m.tenantId, sWit, m.tenantId, m.s1]);
  await q("UPDATE patrol_members SET access_level = 'manager' WHERE tenant_id = ? AND staff_id = ?", [m.tenantId, m.s1]);
  const drug = ok(await api('POST', '/patrol/meds/formulary', { token: m.owner, body: { name: 'Fentanyl nasal', authority: 'standing_order', routes: ['intranasal'], max_dose: 100, dose_unit: 'mcg', min_cert: 'none', controlled: true } }), 201).id;
  const lot = ok(await api('POST', '/patrol/meds/stock', { token: m.owner, body: { formulary_id: drug, lot: 'F1', quantity: 10, unit: 'doses' } }), 201).id;
  const qty = async () => Number((await q('SELECT quantity FROM patrol_med_stock WHERE id = ?', [lot]))[0].quantity);
  // (a) a waste naming a witness is pending; the recorder cannot confirm it; the witness can.
  const w = ok(await api('POST', `/patrol/meds/stock/${lot}/moves`, { token: m.pat, body: { reason: 'wasted', delta: 3, note: 'Dropped vials', witness_staff: sWit } }), 201);
  assert.equal(w.pending, true);
  assert.equal(await qty(), 10, 'nothing changes until the witness confirms');
  assert.equal((await api('POST', `/patrol/meds/moves/${w.id}/confirm`, { token: m.pat, body: {} })).status, 403, 'the recorder cannot confirm their own witness');
  const meds = ok(await api('GET', '/patrol/meds', { token: wit }));
  assert.ok(meds.pending.moves.some((x) => x.id === w.id && x.i_witness));
  ok(await api('POST', `/patrol/meds/moves/${w.id}/confirm`, { token: wit, body: {} }));
  assert.equal(await qty(), 7);
  const mv = (await q('SELECT status, witness_user, witness_via FROM patrol_med_moves WHERE id = ?', [w.id]))[0];
  assert.equal(mv.status, 'done'); assert.equal(mv.witness_via, 'login'); assert.ok(mv.witness_user);
  // (b) a voided dose goes back only once someone else witnesses it.
  const c = await readyCase(m.pat);
  const tr = ok(await api('POST', `/patrol/incidents/${c.id}/patients/${c.pid}/treatments`, { token: m.pat, body: { kind: 'medication', medication: 'Fentanyl nasal', dose: '50 mcg', route: 'intranasal', detail: { dose_value: 50, dose_unit: 'mcg', stock_id: lot, stock_amount: 1, allergy_checked: true } } }), 201);
  assert.equal(await qty(), 6);
  ok(await api('POST', `/patrol/incidents/${c.id}/patients/${c.pid}/treatments/${tr.id}/void`, { token: m.pat, body: { reason: 'wrong entry' } }));
  assert.equal(await qty(), 6, 'the voided dose waits for a witness');
  const back = (await q("SELECT id, status FROM patrol_med_moves WHERE stock_id = ? AND reason = 'adjust'", [lot]))[0];
  assert.equal(back.status, 'pending');
  assert.equal((await api('POST', `/patrol/meds/moves/${back.id}/decline`, { token: m.pat })).status, 409, 'a voided dose cannot be declined away');
  ok(await api('POST', `/patrol/meds/moves/${back.id}/confirm`, { token: wit, body: {} }));
  assert.equal(await qty(), 7);
  // (c) a count waits too, and a wrong PIN does not confirm it.
  const cnt = ok(await api('POST', '/patrol/meds/counts', { token: m.pat, body: { witness_staff: sWit, lines: [{ stock_id: lot, counted: 6 }], note: 'One missing' } }), 201);
  assert.equal(cnt.pending, true);
  assert.equal(await qty(), 7);
  assert.equal((await api('POST', `/patrol/meds/counts/${cnt.id}/confirm`, { token: m.pat, body: { pin: '9999' } })).status, 401);
  ok(await api('POST', `/patrol/meds/counts/${cnt.id}/confirm`, { token: wit, body: {} }));
  assert.equal(await qty(), 6);
});

test('suspicion: a patient marked entered in error gives back the medication given to them', async () => {
  const m = await patrolMountain('cs');
  const drug = ok(await api('POST', '/patrol/meds/formulary', { token: m.owner, body: { name: 'Glucose paste F11', authority: 'standing_order', routes: ['oral'], max_dose: 30, dose_unit: 'g', min_cert: 'none' } }), 201).id;
  const lot = ok(await api('POST', '/patrol/meds/stock', { token: m.owner, body: { formulary_id: drug, lot: 'G1', quantity: 5, unit: 'tubes' } }), 201).id;
  const c = await readyCase(m.pat);
  ok(await api('POST', `/patrol/incidents/${c.id}/patients/${c.pid}/treatments`, { token: m.pat, body: { kind: 'medication', medication: 'Glucose paste F11', dose: '15 g', route: 'oral', detail: { dose_value: 15, dose_unit: 'g', stock_id: lot, stock_amount: 1, allergy_checked: true } } }), 201);
  assert.equal(Number((await q('SELECT quantity FROM patrol_med_stock WHERE id = ?', [lot]))[0].quantity), 4);
  ok(await api('POST', `/patrol/incidents/${c.id}/patients/${c.pid}/void`, { token: m.pat, body: { reason: 'Wrong patient' } }));
  assert.equal(Number((await q('SELECT quantity FROM patrol_med_stock WHERE id = ?', [lot]))[0].quantity), 5);
});

// ---------------------------------------------------------------- PATROL-8 (the browser side is checked with Playwright: proof patrol-9)
test('PATROL-8: /sw.js names this release and keeps its app shell at the /r/<release>/ addresses', async () => {
  const assets = require('../src/lib/appassets');
  const res = await fetch(`${base}/sw.js`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.match(res.headers.get('content-type'), /javascript/);
  const text = await res.text();
  assert.ok(text.includes(`const RELEASE = ${JSON.stringify(assets.RELEASE)};`), 'the release is filled in');
  const list = JSON.parse(/const SHELL = (\[.*?\]);/.exec(text)[1]);
  assert.ok(list.includes('/'), 'the app page');
  assert.ok(list.includes(`${assets.PREFIX}/js/main.js`) && list.includes(`${assets.PREFIX}/js/outbox.js`) && list.includes(`${assets.PREFIX}/css/app.css`), 'scripts and styles at this release');
  assert.ok(!list.some((u) => u.startsWith('/js/') || u.startsWith('/api/')), 'nothing outside the release addresses, and never the API');
  assert.match(text, /name !== CACHE\) await caches\.delete/, 'a new release removes the old cache');
  // the page the shell keeps loads its scripts from the same release
  const page = await (await fetch(`${base}/`)).text();
  assert.ok(page.includes(`${assets.PREFIX}/js/main.js`));
});

test('PATROL-8: the app keeps the sign-in on a network error and clears it only on a real 401', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');
  const boot = src.slice(src.indexOf('async function start()'), src.indexOf('/** Opened with no signal'));
  assert.match(boot, /err && err\.status === 401\) \{\s*session\.clear\(\)/);
  assert.match(boot, /session\.keptMe\(\)/);
  assert.match(src, /navigator\.serviceWorker\.register\('\/sw\.js'/);
});

// ---------------------------------------------------------------- PATROL-9
test('PATROL-9: a kind the group does not review is not approved at once while a "Required to approve" item is missing', async () => {
  const m = await patrolMountain('nr');
  const ownerId = (await q("SELECT id FROM users WHERE tenant_id = ? AND role = 'owner'", [m.tenantId]))[0].id;
  ok(await api('PUT', '/patrol/review/settings', { token: m.owner, body: { reviewers: [{ user_id: ownerId, lead: true }], categories: ['injury'], nudge_hours: 72 } }));
  ok(await api('PUT', '/patrol/requirements', { token: m.owner, body: { rules: { collision: { 'patient.phone': { level: 'approve' } } } } }));
  const col = await readyCase(m.pat, { category: 'collision', summary: 'Two skiers collided' });
  const sub = ok(await api('POST', `/patrol/incidents/${col.id}/submit`, { token: m.pat }));
  assert.equal(sub.review, 'review');
  assert.equal(sub.for_approval.length, 1);
  const cs = ok(await api('GET', `/patrol/incidents/${col.id}`, { token: m.owner }));
  assert.equal(cs.report_state, 'submitted');
  assert.ok(!cs.versions.some((v) => v.kind === 'approved'));
  // With the item filled in, the same kind is still signed off and approved at once.
  const col2 = await readyCase(m.pat, { category: 'collision', summary: 'Second collision' });
  ok(await api('PATCH', `/patrol/incidents/${col2.id}/patients/${col2.pid}`, { token: m.pat, body: { phone: '610-555-0100' } }));
  const sub2 = ok(await api('POST', `/patrol/incidents/${col2.id}/submit`, { token: m.pat }));
  assert.equal(sub2.review, 'not_required');
  assert.equal(ok(await api('GET', `/patrol/incidents/${col2.id}`, { token: m.owner })).report_state, 'approved');
});

// ---------------------------------------------------------------- PATROL-10
test('PATROL-10: a photo time from the phone must fall in the case window, and where the time came from is kept and shown', async () => {
  const m = await patrolMountain();
  const c = await readyCase(m.pat);
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a7a5d5a50000000049454e44ae426082', 'hex');
  const up = async (taken) => {
    const res = await fetch(`${base}/api/v1/patrol/incidents/${c.id}/photos?caption=Scene&taken_at=${encodeURIComponent(taken)}`, { method: 'POST', headers: { authorization: `Bearer ${m.pat}`, 'content-type': 'image/png' }, body: PNG });
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await up('2025-01-15T09:00')).status, 400, 'a year before the case');
  assert.equal((await up('2099-03-01T12:00')).status, 400, 'in the future');
  const good = await up(tzNow(-10));
  assert.equal(good.status, 201);
  assert.equal(good.body.taken_from, 'phone');
  const cs = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: m.owner }));
  assert.equal(cs.photos.length, 1);
  assert.equal(cs.photos[0].taken_from, 'phone');
  assert.equal(cs.photos[0].taken_outside, false);
});

// ---------------------------------------------------------------- PATROL-11
test('PATROL-11: adding a responder again after an entered-in-error marking makes a new row and keeps the struck one', async () => {
  const m = await patrolMountain();
  const s2 = await staff(m, 'Quinn');
  const c = await readyCase(m.pat);
  const r = ok(await api('POST', `/patrol/incidents/${c.id}/responders`, { token: m.pat, body: { staff_id: s2, role: 'assist' } }), 201);
  ok(await api('POST', `/patrol/incidents/${c.id}/responders/${r.id}/void`, { token: m.pat, body: { reason: 'Not on this call' } }));
  const r2 = ok(await api('POST', `/patrol/incidents/${c.id}/responders`, { token: m.pat, body: { staff_id: s2, role: 'transport' } }), 201);
  assert.notEqual(r2.id, r.id);
  // adding the same person again while they are on the case changes their role, still one live row
  ok(await api('POST', `/patrol/incidents/${c.id}/responders`, { token: m.pat, body: { staff_id: s2, role: 'assist' } }), 201);
  const cs = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: m.owner }));
  const rows = cs.responders.filter((x) => x.staff_id === s2);
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((x) => !x.voided_at).length, 1);
  assert.equal(rows.find((x) => x.voided_at).void_reason, 'Not on this call');
});

// ---------------------------------------------------------------- PATROL-12
test('PATROL-12: a change of legal authority on a records request is audited before and after, and the release names it', async () => {
  const m = await patrolMountain();
  const c = await approvedCase(m);
  const rq = ok(await api('POST', '/patrol/records', { token: m.owner, body: { incident_id: c.id, requester_kind: 'attorney', requester_name: 'Plaintiff counsel', received_on: tzNow().slice(0, 10) } }), 201);
  ok(await api('PATCH', `/patrol/records/${rq.id}`, { token: m.owner, body: { authorization: 'subpoena', auth_note: 'Subpoena 26-CV-001' } }));
  ok(await api('PATCH', `/patrol/records/${rq.id}`, { token: m.owner, body: { authorization: 'court_order', auth_note: 'Order of Judge X' } }));
  ok(await api('POST', '/auth/step-up', { token: m.owner, body: { password: PW } }));
  ok(await api('POST', `/patrol/records/${rq.id}/release`, { token: m.owner, body: {} }));
  const aud = await q("SELECT action, detail FROM audit_log WHERE tenant_id = ? AND entity = 'incidents' AND entity_id = ? AND action LIKE 'records%' ORDER BY id", [m.tenantId, c.id]);
  const d = (a) => (typeof a.detail === 'string' ? JSON.parse(a.detail) : a.detail);
  const changes = aud.filter((a) => a.action === 'records_request_change').map(d);
  assert.deepEqual(changes.map((x) => [x.authorization_before, x.authorization_after]), [['none', 'subpoena'], ['subpoena', 'court_order']]);
  assert.ok(changes.every((x) => x.auth_note_changed === true && !JSON.stringify(x).includes('Judge')), 'the typed note is not copied into the audit');
  assert.equal(d(aud.find((a) => a.action === 'records_release')).authorization, 'court_order');
});
