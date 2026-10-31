'use strict';

// 2026.11.11 privacy fixes (track PRIVACY): export and erase of one person, text opt-outs and quiet hours, promotional
// email rules, The Good Day's consent history, a closed mountain's export window, the deletion ledger, third-party flows.
// Each test is the regression test for the review finding named in it (DP-n).
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pool } = require('../src/db');

// A stand-in for Postmark, Twilio and Anthropic: records every request.
const sink = [];
let sinkServer; let sinkBase;
let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
let A;
const q = async (sql, params) => (await pool.query(sql, params))[0];
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

async function api(method, p, { token, body, headers } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
/** Signs in; a new device may be asked for the emailed code, read from the stand-in. */
async function login(tenant, email) {
  const mark = sink.length;
  let r = await api('POST', '/auth/login', { body: { tenant, email, password: PW } });
  if (r.body.mfa_required) {
    await wait(100);
    const mail = sent(mark, (x) => x.u.startsWith('/email')).map((x) => JSON.parse(x.b)).pop();
    const code = /\b(\d{6})\b/.exec(mail.TextBody)[1];
    r = await api('POST', '/auth/mfa', { body: { mfa_token: r.body.mfa_token, code } });
  }
  assert.ok(r.body.token, JSON.stringify(r.body));
  return r.body.token;
}
async function mountain(slug) {
  const t = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `o@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(t.status, 201);
  const token = await login(slug, `o@${slug}.test`);
  const [[row]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
  return { slug, id: row.id, token };
}
const sent = (from, pred) => sink.slice(from).filter(pred);

test.before(async () => {
  sinkServer = http.createServer((req, res) => {
    let data = ''; req.on('data', (c) => { data += c; });
    req.on('end', () => {
      sink.push({ u: req.url, b: data, h: req.headers });
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/email')) return res.end(JSON.stringify({ ErrorCode: 0, MessageID: `pm${sink.length}` }));
      if (req.url.includes('/Messages.json')) return res.end(JSON.stringify({ sid: `SM${sink.length}` }));
      if (req.url.startsWith('/v1/messages')) return res.end(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'A great day on the snow.' }], usage: { input_tokens: 1, output_tokens: 1 } }));
      return res.end('{}');
    });
  });
  await new Promise((r) => { sinkServer.listen(0, '127.0.0.1', r); });
  sinkBase = `http://127.0.0.1:${sinkServer.address().port}`;
  Object.assign(process.env, {
    POSTMARK_SERVER_TOKEN: 'pm', MAIL_FROM: 'noreply@test.example', POSTMARK_API_BASE: sinkBase,
    TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+15555550100', TWILIO_API_BASE: sinkBase,
    ASSISTANT_API_KEY: 'k', ASSISTANT_API_BASE: sinkBase, ANTHROPIC_API_BASE: sinkBase,
  });
  require('../src/lib/mailer').settings.apiBase = sinkBase;
  const { createApp } = require('../src/app');
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`f11p-${suffix}`);
  await pool.query("UPDATE tenants SET address = '12 Summit Road, Spring City, PA 19475' WHERE id = ?", [A.id]);
  for (const role of ['manager', 'counter']) {
    assert.equal((await api('POST', '/users', { token: A.token, body: { email: `${role}@${A.slug}.test`, password: PW, role } })).status, 201);
    A[role] = await login(A.slug, `${role}@${A.slug}.test`);
  }
});
test.after(async () => { server.close(); sinkServer.close(); await pool.end(); });

// ---------------------------------------------------------------- DP-1
test('DP-1: every table with a person, email, phone or health column is in the registry (or named as not a guest)', async () => {
  const { REGISTRY, NOT_GUESTS } = require('../src/lib/personal');
  const known = new Set([...REGISTRY.map((e) => e.table), ...Object.keys(NOT_GUESTS), 'assistant_log', 'audit_log', 'platform_audit', 'person_tombstones']);
  const cols = await q(`SELECT DISTINCT c.table_name AS t FROM information_schema.columns c JOIN information_schema.tables x ON x.table_schema = c.table_schema AND x.table_name = c.table_name
    WHERE c.table_schema = DATABASE() AND x.table_type = 'BASE TABLE' AND (c.column_name LIKE '%person_id' OR c.column_name LIKE '%email%' OR c.column_name LIKE '%phone%'
      OR c.column_name IN ('allergies', 'medical', 'medical_history', 'date_of_birth', 'signer_dob', 'guardian_id', 'adult_id', 'member_id'))
      AND c.column_name NOT IN ('emailed', 'emailed_at', 'email_verified', 'emails_stopped_at', 'confirm_email')`);
  const missing = cols.map((r) => r.t || r.TABLE_NAME).filter((t) => !known.has(t));
  assert.deepEqual(missing, [], `add these tables to src/lib/personal.js (REGISTRY or NOT_GUESTS): ${missing.join(', ')}`);
  for (const e of REGISTRY) assert.ok(e.erase === 'delete' || e.erase.keep || e.erase.set, `${e.table} says what erasing does`);
});

test('DP-1: the download has every table holding the guest; anonymise clears children’s health details and says plainly what stays', async () => {
  const T = A.id; const tag = `Qv${suffix}`;
  const first = `Zyxw${tag}`; const last = `Plorian${tag}`; const email = `${tag.toLowerCase()}@kid.example`; const phone = `61055${String(Date.now()).slice(-5)}`;
  const allergy = `peanut-${tag}`; const medical = `asthma-${tag}`;
  const [p] = await pool.query('INSERT INTO people (tenant_id, first_name, last_name, email, phone, date_of_birth) VALUES (?,?,?,?,?,?)', [T, first, last, email, phone, '2016-03-04']);
  const pid = p.insertId;
  const [prod] = await pool.query("INSERT INTO products (tenant_id, kind, name, base_price_cents) VALUES (?, 'lesson', 'Group', 5000)", [T]);
  const [s] = await pool.query("INSERT INTO lesson_sessions (tenant_id, product_id, starts_at, ends_at, capacity) VALUES (?, ?, '2026-12-20 10:00:00', '2026-12-20 12:00:00', 8)", [T, prod.insertId]);
  await pool.query("INSERT INTO lesson_bookings (tenant_id, session_id, person_id, status, allergies, medical, pickup, contact_name, contact_phone, contact_email) VALUES (?,?,?, 'booked', ?,?,?,?,?,?)",
    [T, s.insertId, pid, allergy, medical, JSON.stringify([{ name: `Uncle ${last}`, phone }]), `Parent ${last}`, phone, email]);
  const [ws] = await pool.query("INSERT INTO waiver_signings (tenant_id, season, source, signer_person_id, signer_name, signer_email, signer_phone, signer_dob, covered_names, typed_name, signature, text_sha) VALUES (?, '2026-27', 'online', ?, ?, ?, ?, '2016-03-04', ?, ?, 'x', 'x')",
    [T, pid, `${first} ${last}`, email, phone, `${first} ${last}`, `${first} ${last}`]);
  await pool.query("INSERT INTO waivers (tenant_id, person_id, season, signed_by_name, signing_id) VALUES (?,?, '2026-27', ?, ?)", [T, pid, `${first} ${last}`, ws.insertId]);
  await pool.query("INSERT INTO message_log (tenant_id, person_id, kind, channel, to_addr, status) VALUES (?,?, 'campaign', 'email', ?, 'sent')", [T, pid, email]);
  await pool.query("INSERT INTO assistant_log (tenant_id, audience, question) VALUES (?, 'guest', ?)", [T, `My daughter ${first} ${last} has ${allergy}, can she join?`]);
  await pool.query("INSERT INTO lost_reports (tenant_id, kind, lost_on, name, email, phone) VALUES (?, 'other', '2026-12-01', ?, ?, ?)", [T, `${first} ${last}`, email, phone]);
  await pool.query("INSERT INTO lesson_waitlist (tenant_id, session_id, contact_name, contact_email, contact_phone, student) VALUES (?, ?, ?, ?, ?, ?)", [T, s.insertId, `Parent ${last}`, email, phone, JSON.stringify({ first_name: first, allergies: allergy })]);
  const [inc] = await pool.query("INSERT INTO incidents (tenant_id, occurred_at, location, category, summary) VALUES (?, NOW(), 'Bunny hill', 'injury', 'fall')", [T]);
  await pool.query('INSERT INTO incident_patients (tenant_id, incident_id, person_id, first_name, last_name, phone, allergies) VALUES (?,?,?,?,?,?,?)', [T, inc.insertId, pid, first, last, phone, allergy]);

  const ex = await api('GET', `/people/${pid}/data-export`, { token: A.manager });
  assert.equal(ex.status, 200);
  const all = ex.body.all_records;
  for (const t of ['lesson_bookings', 'waiver_signings', 'message_log', 'assistant_log', 'lost_reports', 'lesson_waitlist']) assert.ok(all[t], `export has ${t}`);
  assert.equal(all.lesson_bookings[0].allergies, allergy);
  assert.equal(all.waiver_signings[0].signer_phone, phone);
  assert.equal(all.waiver_signings[0].signature, undefined, 'no signatures or tokens in the file');
  assert.equal(ex.body.patrol_records.exists, true);
  assert.match(ex.body.patrol_records.how_to_request, /Records requests/);
  assert.ok(!ex.text.includes('Bunny hill'), 'patrol care rows are not copied into the download');

  const an = await api('POST', `/people/${pid}/anonymise`, { token: A.manager, body: { confirm: true } });
  assert.equal(an.status, 200);
  const keptTables = new Set(an.body.kept.flatMap((k) => k.tables));
  assert.ok(keptTables.has('incident_patients') && keptTables.has('waiver_signings'));
  for (const k of an.body.kept) assert.ok(k.why.length > 20, 'each kept record says why');
  const [[lb]] = await pool.query('SELECT allergies, medical, pickup, contact_email FROM lesson_bookings WHERE tenant_id = ? AND person_id = ?', [T, pid]);
  assert.deepEqual(lb, { allergies: null, medical: null, pickup: null, contact_email: null });
  const [[w]] = await pool.query('SELECT signer_email, signer_phone, signer_dob, typed_name FROM waiver_signings WHERE id = ?', [ws.insertId]);
  assert.equal(w.signer_email, null); assert.equal(w.signer_dob, null); assert.equal(w.typed_name, `${first} ${last}`);
  const [[wl]] = await pool.query('SELECT contact_email, student FROM lesson_waitlist WHERE tenant_id = ? AND session_id = ?', [T, s.insertId]);
  assert.equal(wl.contact_email, ''); assert.ok(!wl.student.includes(allergy) && !wl.student.includes(first));
  const [[al]] = await pool.query('SELECT COUNT(*) AS n FROM assistant_log WHERE tenant_id = ? AND question LIKE ?', [T, `%${tag}%`]);
  assert.equal(Number(al.n), 0);
  const [[lr]] = await pool.query('SELECT COUNT(*) AS n FROM lost_reports WHERE tenant_id = ? AND (email = ? OR name LIKE ?)', [T, email, `%${tag}%`]);
  assert.equal(Number(lr.n), 0);
  const [[ml]] = await pool.query('SELECT COUNT(*) AS n FROM message_log WHERE tenant_id = ? AND to_addr = ?', [T, email]);
  assert.equal(Number(ml.n), 0);
  const [[pk]] = await pool.query('SELECT phone_key FROM people WHERE id = ?', [pid]);
  assert.equal(pk.phone_key, null);
  const [[led]] = await pool.query("SELECT COUNT(*) AS n FROM deletion_ledger WHERE tenant_id = ? AND kind = 'anonymise' AND ref_id = ?", [T, pid]);
  assert.equal(Number(led.n), 1, 'the erasure is in the deletion ledger');
});

test('DP-1: guest page audit rows carry an email reference, not the address', async () => {
  for (const f of ['src/routes/family.js', 'src/routes/guestsaccount.js']) assert.ok(!/audit\([^\n]*[{,] email \}/.test(read(f)), `${f} audits the email itself`);
});
