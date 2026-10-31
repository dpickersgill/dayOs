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

// ---------------------------------------------------------------- DP-4, DP-5, DP-6: texts and promotional email
const newPerson = async (body) => { const r = await api('POST', '/people', { token: A.manager, body }); assert.equal(r.status, 201, r.text); return r.body.id || r.body.data.id; };
const consent = (id, channel, status) => api('POST', `/people/${id}/consent`, { token: A.manager, body: { channel, status, source: 'counter' } });
async function campaign(channel, extra = {}) {
  const cm = await api('POST', '/messages/campaigns', { token: A.manager, body: { name: `C ${Math.random()}`, channel, subject: channel === 'email' ? 'Powder day sale' : undefined, body: 'Half price tickets this weekend.', audience: 'all', ...extra } });
  assert.equal(cm.status, 201, cm.text);
  return cm.body.id;
}
const texts = (mark, phone) => sent(mark, (x) => x.u.includes('/Messages.json')).map((x) => new URLSearchParams(x.b)).filter((p) => p.get('To') === `+1${phone}`);
const mails = (mark, to) => sent(mark, (x) => x.u === '/email').map((x) => JSON.parse(x.b)).filter((m) => m.To === to);

test('DP-4: a text opt-out covers the phone, not one record (family sharing a phone)', async () => {
  const quiet = require('../src/lib/quiet');
  quiet.clock.now = () => new Date('2026-12-15T17:00:00Z'); // noon at the mountain
  try {
    const phone = `484555${String(Date.now()).slice(-4)}`;
    const parent = await newPerson({ first_name: 'Parent', last_name: `Txt${suffix}`, phone });
    const child = await newPerson({ first_name: 'Child', last_name: `Txt${suffix}`, phone });
    for (const id of [parent, child]) await consent(id, 'sms', 'opted_in');
    assert.equal((await consent(parent, 'sms', 'opted_out')).status, 201);
    const [[c]] = await pool.query("SELECT status FROM consent_events WHERE tenant_id = ? AND person_id = ? AND channel = 'sms' ORDER BY id DESC LIMIT 1", [A.id, child]);
    assert.equal(c.status, 'opted_out', 'the shared phone’s other record says no too');
    const mark = sink.length;
    const s = await api('POST', `/messages/campaigns/${await campaign('sms')}/send`, { token: A.manager, body: { confirm: true } });
    assert.equal(s.status, 200);
    await wait(100);
    assert.equal(texts(mark, phone).length, 0, 'the opted-out phone gets no campaign text');
    // An older record that still says yes (from before this release) is covered by the audience rule too.
    await pool.query("INSERT INTO consent_events (tenant_id, person_id, channel, status, source, wording) VALUES (?, ?, 'sms', 'opted_in', 'counter', 'v1')", [A.id, child]);
    await pool.query("INSERT INTO consent_events (tenant_id, person_id, channel, status, source, wording) VALUES (?, ?, 'sms', 'opted_out', 'counter', 'v1')", [A.id, parent]);
    const list = await require('../src/lib/messaging').audienceOf({ id: A.id, timezone: 'America/New_York' }, 'sms', 'all');
    assert.ok(!list.some((p) => String(p.addr).replace(/\D/g, '').endsWith(phone)));
  } finally { quiet.clock.now = () => new Date(); }
});

test('DP-4: campaign texts between 9 PM and 8 AM at the mountain wait for 8 AM, and are dropped if the phone says no first', async () => {
  const quiet = require('../src/lib/quiet');
  const sms = require('../src/lib/sms');
  const phone = `610777${String(Date.now()).slice(-4)}`; const phone2 = `610778${String(Date.now()).slice(-4)}`;
  const p1 = await newPerson({ first_name: 'Night', last_name: `Owl${suffix}`, phone });
  const p2 = await newPerson({ first_name: 'Late', last_name: `Change${suffix}`, phone: phone2 });
  await consent(p1, 'sms', 'opted_in'); await consent(p2, 'sms', 'opted_in');
  quiet.clock.now = () => new Date('2026-12-16T04:30:00Z'); // 11:30 PM at the mountain
  try {
    const mark = sink.length;
    const id = await campaign('sms');
    const s = await api('POST', `/messages/campaigns/${id}/send`, { token: A.manager, body: { confirm: true } });
    assert.equal(s.status, 200); assert.ok(s.body.held >= 2, JSON.stringify(s.body));
    await wait(100);
    assert.equal(texts(mark, phone).length, 0, 'nothing is texted at night');
    const [[h]] = await pool.query('SELECT send_after FROM sms_held WHERE tenant_id = ? AND phone_key = ? ORDER BY id DESC LIMIT 1', [A.id, phone]);
    assert.equal(new Date(h.send_after).toISOString().slice(0, 16), '2026-12-16T13:00', 'held until 8 AM Eastern');
    const [[log]] = await pool.query("SELECT status FROM message_log WHERE tenant_id = ? AND campaign_id = ? AND person_id = ?", [A.id, id, p1]);
    assert.equal(log.status, 'held');
    // The second guest says no before morning.
    await consent(p2, 'sms', 'opted_out');
    // Still night: the job sends nothing.
    await pool.query('UPDATE sms_held SET send_after = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE tenant_id = ?', [A.id]);
    await sms.sendHeld();
    assert.equal(texts(mark, phone).length, 0);
    quiet.clock.now = () => new Date('2026-12-16T13:05:00Z'); // 8:05 AM
    await pool.query('UPDATE sms_held SET send_after = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE tenant_id = ?', [A.id]);
    const out = await sms.sendHeld();
    await wait(100);
    assert.ok(out.sent >= 1 && out.dropped >= 1, JSON.stringify(out));
    assert.equal(texts(mark, phone).length, 1, 'sent at 8 AM');
    assert.equal(texts(mark, phone2).length, 0, 'the phone that said no overnight is never texted');
    const [[log2]] = await pool.query("SELECT status FROM message_log WHERE tenant_id = ? AND campaign_id = ? AND person_id = ?", [A.id, id, p1]);
    assert.equal(log2.status, 'sent');
  } finally { quiet.clock.now = () => new Date(); }
});

test('DP-6: a marketing email needs the mountain’s postal address, and carries the one-click unsubscribe headers', async () => {
  const email = `promo${suffix}@guest.example`;
  const id = await newPerson({ first_name: 'Mark', last_name: `Eting${suffix}`, email });
  await consent(id, 'email', 'opted_in');
  await pool.query('UPDATE tenants SET address = NULL, mail_address = NULL WHERE id = ?', [A.id]);
  try {
    const mark = sink.length;
    const s = await api('POST', `/messages/campaigns/${await campaign('email')}/send`, { token: A.manager, body: { confirm: true } });
    assert.equal(s.status, 409); assert.match(s.body.error, /postal address/);
    assert.equal(mails(mark, email).length, 0);
    assert.equal((await api('GET', '/messages/status', { token: A.manager })).body.postal_address, null);
  } finally { await pool.query("UPDATE tenants SET address = '12 Summit Road, Spring City, PA 19475' WHERE id = ?", [A.id]); }
  const mark = sink.length;
  const s = await api('POST', `/messages/campaigns/${await campaign('email')}/send`, { token: A.manager, body: { confirm: true } });
  assert.equal(s.status, 200);
  await wait(100);
  const [m] = mails(mark, email);
  assert.ok(m, 'sent once the address is there');
  assert.match(m.TextBody, /12 Summit Road/);
  const hs = Object.fromEntries((m.Headers || []).map((x) => [x.Name, x.Value]));
  assert.match(hs['List-Unsubscribe'], /\/api\/v1\/public\/unsub\//);
  assert.equal(hs['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.equal(m.MessageStream, 'broadcast');
  // One click: a POST to the link records the opt-out.
  const r = await fetch(hs['List-Unsubscribe'].slice(1, -1).replace(/^https?:\/\/[^/]+/, base), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  assert.equal(r.status, 200);
  const [[c]] = await pool.query("SELECT status FROM consent_events WHERE tenant_id = ? AND person_id = ? AND channel = 'email' ORDER BY id DESC LIMIT 1", [A.id, id]);
  assert.equal(c.status, 'opted_out');
});

test('DP-5: reward and loyalty email honors unsubscribe and carries the footer; every email is classified in one place', async () => {
  const kinds = require('../src/lib/mailkinds');
  for (const t of ['msg-campaign', 'loyalty-thanks', 'reward-birthday', 'reward-loyalty', 'recap-day', 'recap-season', 'lesson-followup']) assert.equal(kinds.kindOf(t), 'promotional', t);
  for (const t of ['shop-tickets', 'confirmation', 'msg-rental_overdue', 'sign-in-code', 'patrol-followup', 'goodday-confirm']) assert.equal(kinds.kindOf(t), 'transactional', t);
  const out = await newPerson({ first_name: 'Gone', last_name: `Away${suffix}`, email: `gone${suffix}@guest.example` });
  const stay = await newPerson({ first_name: 'Still', last_name: `Here${suffix}`, email: `here${suffix}@guest.example` });
  await consent(out, 'email', 'opted_in');
  const { unsubToken } = require('../src/lib/messaging');
  assert.equal((await fetch(`${base}/api/v1/public/unsub/${unsubToken(A.id, out, 'email')}`, { method: 'POST' })).status, 200);
  const mark = sink.length;
  const r = await api('POST', '/guests/loyalty/top/thanks', { token: A.manager, body: { person_ids: [out, stay], note: 'Passes are 20% off until Friday!' } });
  assert.equal(r.status, 200, r.text);
  await wait(100);
  assert.equal(mails(mark, `gone${suffix}@guest.example`).length, 0, 'an unsubscribed guest gets no promotional email');
  const [m] = mails(mark, `here${suffix}@guest.example`);
  assert.ok(m);
  assert.match(m.TextBody, /12 Summit Road/); assert.match(m.TextBody, /To stop these emails: http/);
  assert.ok((m.Headers || []).some((x) => x.Name === 'List-Unsubscribe-Post'));
});

// ---------------------------------------------------------------- DP-7
test('DP-7: a stranger signing up an unsubscribed Good Day reader erases nothing; every step is in the consent history', async () => {
  const email = `gd${suffix}@reader.example`;
  await pool.query(`INSERT INTO goodday_subscribers (email, name, role, status, source, consent_at, consent_wording, consent_ip, confirmed_at, unsubscribed_at, unsubscribe_how)
    VALUES (?, NULL, 'other', 'unsubscribed', 'website', '2025-11-02 10:00:00', 'Send me The Good Day (Signed up on: website)', '198.51.100.7', '2025-11-02 10:05:00', '2026-09-10 08:00:00', 'one-click')`, [email]);
  const [[before]] = await pool.query('SELECT status, consent_at, consent_ip, unsubscribed_at, unsubscribe_how FROM goodday_subscribers WHERE email = ?', [email]);
  const r = await fetch(`${base}/api/v1/site/good-day/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name: 'Someone Else', source: 'attacker' }) });
  assert.ok(r.status < 300);
  const [[after]] = await pool.query('SELECT status, consent_at, consent_ip, unsubscribed_at, unsubscribe_how FROM goodday_subscribers WHERE email = ?', [email]);
  assert.deepEqual(after, before, 'the unsubscribe and the earlier consent are untouched');
  const ev = await q('SELECT event, source FROM goodday_consent_events WHERE email = ? ORDER BY id', [email]);
  assert.deepEqual(ev.map((e) => e.event), ['subscribe']);
  assert.equal(ev[0].source, 'attacker');
  // The app may only add to the history (scripts/db-runtime-user.js).
  assert.ok(require('../scripts/db-runtime-user').APPEND_ONLY.includes('goodday_consent_events'));
});

// ---------------------------------------------------------------- DP-11
test('DP-11: a closed mountain’s owner signs in to export-only mode during the window, and only then', async () => {
  const m = await mountain(`f11c-${suffix}`);
  assert.equal((await api('POST', '/users', { token: m.token, body: { email: `mgr@${m.slug}.test`, password: PW, role: 'manager' } })).status, 201);
  await pool.query("UPDATE tenants SET status = 'suspended', closed_at = UTC_TIMESTAMP(), delete_after = DATE_ADD(CURDATE(), INTERVAL 60 DAY) WHERE id = ?", [m.id]);
  const tok = await login(m.slug, `o@${m.slug}.test`);
  const me = await api('GET', '/auth/me', { token: tok });
  assert.equal(me.status, 200); assert.equal(me.body.export_only, true);
  const x = await api('GET', '/closed-export', { token: tok });
  assert.equal(x.status, 200); assert.ok(x.body.files.some((f) => f.href === '/people/export.csv'));
  const csv = await api('GET', '/people/export.csv', { token: tok });
  assert.equal(csv.status, 200, csv.text);
  for (const [method, p] of [['GET', '/people'], ['POST', '/people'], ['GET', '/messages/campaigns'], ['DELETE', '/people/1']]) {
    const r = await api(method, p, { token: tok, body: method === 'POST' ? { first_name: 'A', last_name: 'B' } : undefined });
    assert.equal(r.status, 403, `${method} ${p} is closed`);
  }
  // Only the owner, and only inside the window.
  const mgr = await api('POST', '/auth/login', { body: { tenant: m.slug, email: `mgr@${m.slug}.test`, password: PW } });
  assert.equal(mgr.status, 403);
  await pool.query('UPDATE tenants SET delete_after = DATE_SUB(CURDATE(), INTERVAL 2 DAY) WHERE id = ?', [m.id]);
  assert.equal((await api('GET', '/auth/me', { token: tok })).status, 403, 'the window is over');
  const late = await api('POST', '/auth/login', { body: { tenant: m.slug, email: `o@${m.slug}.test`, password: PW } });
  assert.equal(late.status, 403);
});
