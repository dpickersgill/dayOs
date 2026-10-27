'use strict';

// Claim files, the documentation score, the season risk report, and secure links for an insurer or broker
// (routes/patrolclaims.js, lib/docscore.js).
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { todayIn, nowIn } = require('../src/lib/util');
const DS = require('../src/lib/docscore');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
async function api(method, p, { token, body, headers = {}, raw = false } = {}) {
  const res = await fetch(`${base}${raw ? '' : '/api/v1'}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get('content-type') || '';
  if (!type.includes('json')) return { status: res.status, body: Buffer.from(await res.arrayBuffer()), type };
  return { status: res.status, body: await res.json(), type };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);
const M = {};
let today; let now;
const ago = (mins) => new Date(Date.parse(`${now.replace(' ', 'T')}Z`) - mins * 60000).toISOString().slice(0, 16);
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const slug = `cl-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Claim Peak', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  M.owner = await login(`owner@${slug}.test`);
  M.id = Number((await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]))[0][0].id);
  const tz = (await pool.query('SELECT timezone FROM tenants WHERE id = ?', [M.id]))[0][0].timezone;
  today = todayIn(tz); now = nowIn(tz);
  M.pat = Number(ok(await api('POST', '/patrol/team', { token: M.owner, body: { person: { first_name: 'Pat', last_name: 'Claims' }, level: 'patroller' } })).staff_id);
  ok(await api('POST', '/users', { token: M.owner, body: { email: `pat@${slug}.test`, password: PW, role: 'patrol', staff_id: M.pat } }));
  M.patT = await login(`pat@${slug}.test`);
  M.lift = Number(ok(await api('POST', '/schedule/lifts', { token: M.owner, body: { name: 'Summit chair' } })).id);

  // A serious lift case with a 12-year-old, management told, one photo, approved.
  const c = ok(await api('POST', '/patrol/incidents', { token: M.patT, body: { occurred_at: ago(180), location: 'Summit chair unload', category: 'injury', severity: 'serious', lift_id: M.lift, summary: 'Fell at the unload ramp' } }));
  M.case = Number(c.id);
  const p = ok(await api('POST', `/patrol/incidents/${M.case}/patients`, { token: M.patT, body: { first_name: 'Riley', last_name: 'Zebulon', date_of_birth: `${Number(today.slice(0, 4)) - 12}-01-15` } }));
  ok(await api('PATCH', `/patrol/incidents/${M.case}/patients/${p.id}`, { token: M.patT, body: { chief_complaint: 'Right wrist pain', disposition: 'transported_private' } }));
  ok(await api('POST', `/patrol/incidents/${M.case}/patients/${p.id}/vitals`, { token: M.patT, body: { taken_at: ago(170), pulse: 104, resp: 20, bp_sys: 118, bp_dia: 74, spo2: 98, gcs: 15, pain: 7, avpu: 'alert' } }));
  ok(await api('POST', `/patrol/incidents/${M.case}/responders`, { token: M.patT, body: { staff_id: M.pat, role: 'lead' } }));
  ok(await api('POST', `/patrol/incidents/${M.case}/contacts`, { token: M.patT, body: { at: ago(150), who: 'management', method: 'radio' } }));
  await pool.query('INSERT INTO incident_media (tenant_id, incident_id, mime, bytes, sha256, original, preview, caption, taken_at, uploaded_by, uploaded_at) VALUES (?, ?, \'image/jpeg\', ?, ?, ?, ?, \'Unload ramp\', ?, NULL, ?)',
    [M.id, M.case, JPEG.length, crypto.createHash('sha256').update(JPEG).digest('hex'), JPEG, JPEG, now, now]);
  ok(await api('POST', `/patrol/incidents/${M.case}/submit`, { token: M.patT }));
  const st = ok(await api('GET', `/patrol/incidents/${M.case}`, { token: M.owner }));
  if (st.report_state !== 'approved') ok(await api('POST', `/patrol/incidents/${M.case}/approve`, { token: M.owner, body: {} }));
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('the claim file: the approved report, frozen, with photos, who was told, score and the audit trail; opening it is logged', async () => {
  const f = ok(await api('GET', `/patrol/incidents/${M.case}/claim-file`, { token: M.owner }));
  assert.equal(f.basis, 'approved');
  assert.ok(f.version && f.version.version_no >= 1);
  assert.equal(f.report.patients[0].last_name, 'Zebulon');
  assert.equal(f.report.photos.length, 1);
  assert.match(f.report.photos[0].sha256, /^[0-9a-f]{64}$/);
  assert.ok(f.report.contacts.some((x) => x.who === 'management'));
  assert.deepEqual(f.score.red_flags.map((x) => x.key).sort(), ['lift', 'minor', 'serious']);
  assert.equal(f.score.told.management, true); assert.equal(f.score.told.insurer, false);
  assert.ok(typeof f.score.hours_to_submit === 'number' && f.score.on_time);
  assert.equal(f.scene, null, 'no scene drawn');
  const again = ok(await api('GET', `/patrol/incidents/${M.case}/claim-file`, { token: M.owner }));
  assert.ok(again.audit.some((a) => a.action === 'claim_file_view'), 'opening it is logged');
  // a patroller who can view cases can open it, without the audit trail
  const pat = ok(await api('GET', `/patrol/incidents/${M.case}/claim-file`, { token: M.patT }));
  assert.equal(pat.audit, null); assert.deepEqual(pat.shares, []);
});

test('the documentation score: per case and the season; only admins see the season', async () => {
  const one = ok(await api('GET', `/patrol/incidents/${M.case}/doc-score`, { token: M.patT }));
  assert.ok(one.score === null || (one.score >= 0 && one.score <= 100));
  is(await api('GET', '/patrol/doc-score', { token: M.patT }), 403);
  const s = ok(await api('GET', '/patrol/doc-score', { token: M.owner }));
  assert.equal(s.reports, 1);
  assert.equal(s.red_flags, 1); assert.equal(s.red_flags_management, 1); assert.equal(s.red_flags_insurer, 0);
  assert.equal(s.on_time_pct, 100);
  assert.equal(s.cases[0].id, M.case);
  const [[cached]] = await pool.query('SELECT stamp, score FROM incident_doc_scores WHERE tenant_id = ? AND incident_id = ?', [M.id, M.case]);
  assert.ok(cached.stamp.startsWith('approved|'), 'kept once per state of the report');
  const brief = ok(await api('GET', '/patrol/doc-score?brief=1', { token: M.owner }));
  assert.equal(brief.cases, undefined);
  is(await api('GET', '/patrol/doc-score?season=2026', { token: M.owner }), 400);
  // the library: a draft with nothing required scores against what is recommended, or not at all
  assert.equal(DS.hoursBetween('2026-12-01 10:00:00', '2026-12-01 16:30:00'), 6.5);
});

test('the season risk report: counts only, never a name', async () => {
  const r = ok(await api('GET', '/patrol/risk-report', { token: M.owner }));
  const text = JSON.stringify(r);
  assert.ok(!text.includes('Zebulon') && !text.includes('Riley'), 'no patient names');
  assert.equal(r.injuries.patients, 1);
  assert.equal(r.red_flags.cases, 1);
  assert.ok(r.network === null && r.network_note);
  assert.ok(r.compliance && 'kits' in r.compliance);
  assert.ok(r.last_season.season);
  is(await api('GET', '/patrol/risk-report', { token: M.patT }), 403);
});

test('an insurer link: only after a release with authority, passcode, every view logged, revocable', async () => {
  const req = Number(ok(await api('POST', '/patrol/records', { token: M.owner, body: { incident_id: M.case, requester_kind: 'insurer', requester_name: 'Acme Mutual', received_on: today, authorization: 'signed_release' } })).id);
  is(await api('POST', `/patrol/records/${req}/share`, { token: M.owner, body: {} }), 409, 'not released yet');
  ok(await api('POST', `/patrol/records/${req}/release`, { token: M.owner, body: { note: 'Secure link' } }));
  is(await api('POST', `/patrol/records/${req}/share`, { token: M.patT, body: {} }), 403, 'patrol admins only');
  const sh = ok(await api('POST', `/patrol/records/${req}/share`, { token: M.owner, body: { days: 14 } }));
  assert.match(sh.passcode, /^\d{6}$/);
  const token = sh.url.split('/c/')[1];
  assert.ok(token.length >= 30);
  const [[row]] = await pool.query('SELECT token_hash FROM claim_shares WHERE id = ?', [sh.id]);
  assert.notEqual(row.token_hash, token, 'only a hash is kept');

  const first = await api('GET', `/public/claim-share/${token}`);
  is(first, 401); assert.equal(first.body.needs_code, true);
  is(await api('GET', `/public/claim-share/${token}`, { headers: { 'x-share-code': '000000' === sh.passcode ? '111111' : '000000' } }), 401);
  const view = ok(await api('GET', `/public/claim-share/${token}`, { headers: { 'x-share-code': sh.passcode } }));
  assert.equal(view.kind, 'claim'); assert.equal(view.basis, 'approved');
  assert.match(view.release.release_no, /^R\d{4}-\d{3}$/);
  assert.equal(view.report.patients[0].last_name, 'Zebulon');
  assert.equal(view.audit, undefined, 'no audit trail outside');
  const photo = await api('GET', `/public/claim-share/${token}/photos/${view.report.photos[0].id}?k=${encodeURIComponent(view.view_key)}`);
  assert.equal(photo.status, 200); assert.equal(photo.type, 'image/jpeg');
  is(await api('GET', `/public/claim-share/${token}/photos/${view.report.photos[0].id}?k=nope`), 404);

  const shares = ok(await api('GET', `/patrol/incidents/${M.case}/shares`, { token: M.owner })).data;
  const s = shares.find((x) => x.id === sh.id);
  assert.equal(s.views, 1); assert.equal(s.state, 'active'); assert.equal(s.shared_with, 'Acme Mutual');
  assert.ok(s.view_log[0].ip);
  const log = ok(await api('GET', `/patrol/access-log?incident_id=${M.case}`, { token: M.owner })).data;
  assert.ok(log.some((a) => a.action === 'claim_share_view'), 'on the access log too');

  ok(await api('POST', `/patrol/shares/${sh.id}/revoke`, { token: M.owner }));
  is(await api('GET', `/public/claim-share/${token}`, { headers: { 'x-share-code': sh.passcode } }), 410);
  is(await api('GET', '/public/claim-share/not-a-real-token-at-all-xx'), 404);
});

test('too many wrong passcodes locks the link', async () => {
  const req = (await pool.query("SELECT id FROM patrol_records_requests WHERE tenant_id = ? AND status = 'released' LIMIT 1", [M.id]))[0][0].id;
  const sh = ok(await api('POST', `/patrol/records/${req}/share`, { token: M.owner, body: { shared_with: 'Acme adjuster' } }));
  const token = sh.url.split('/c/')[1];
  const wrong = sh.passcode === '123456' ? '654321' : '123456';
  let last;
  for (let i = 0; i < 10; i += 1) last = await api('GET', `/public/claim-share/${token}`, { headers: { 'x-share-code': wrong } });
  is(last, 423);
  is(await api('GET', `/public/claim-share/${token}`, { headers: { 'x-share-code': sh.passcode } }), 423, 'even the right code, once locked');
});

test('a broker link to the risk report: counts only, no passcode needed unless asked', async () => {
  const sh = ok(await api('POST', '/patrol/risk-report/share', { token: M.owner, body: { shared_with: 'Summit Insurance Brokers' } }));
  assert.equal(sh.passcode, null);
  assert.equal(sh.expires_at.slice(0, 10) > today, true);
  const token = sh.url.split('/c/')[1];
  const r = ok(await api('GET', `/public/claim-share/${token}`));
  assert.equal(r.kind, 'risk'); assert.equal(r.injuries.patients, 1);
  assert.ok(!JSON.stringify(r).includes('Zebulon'));
  const list = ok(await api('GET', '/patrol/shares', { token: M.owner })).data;
  assert.equal(list.find((x) => x.id === sh.id).views, 1);
  is(await api('POST', `/patrol/shares/${sh.id}/revoke`, { token: M.patT }), 403);
  // an expired link is gone
  await pool.query('UPDATE claim_shares SET expires_at = ? WHERE id = ?', ['2020-01-01 00:00:00', sh.id]);
  is(await api('GET', `/public/claim-share/${token}`), 410);
  // the page itself
  const page = await api('GET', `/c/${token}`, { raw: true });
  assert.equal(page.status, 200);
});
