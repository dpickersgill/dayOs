'use strict';

// Waivers: signing on the public page and at the counter, guardians for children, the signed copy, voiding, new wording with
// "ask everyone to sign again", the wording history, and that one mountain never sees another's.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.WAIVER_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const SIG = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('a tiny drawn signature')]).toString('base64')}`;
const WORDING = 'Skiing is risky. I accept the risks and release the mountain.';
const yearsAgo = (n) => { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - n); return d.toISOString().slice(0, 10); };

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text, type: res.headers.get('content-type') };
}
const ok = (r, status) => { assert.equal(r.status, status ?? (r.status < 300 ? r.status : -1), JSON.stringify(r.body)); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);

async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201, await res.text());
  return { slug, owner: (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token };
}
const login = async (m, email) => (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token;

let A; let B; const T = {};
const family = (over = {}) => ({
  agree: true, self: true, typed_name: 'Pat Parent', signature: SIG,
  signer: { first_name: 'Pat', last_name: 'Parent', date_of_birth: yearsAgo(40), email: `pat-${suffix}@example.test` },
  children: [{ first_name: 'Kit', last_name: 'Parent', date_of_birth: yearsAgo(9) }],
  ...over,
});

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`wv-${suffix}`); B = await mountain(`wx-${suffix}`);
  for (const [role, who] of [['manager', 'mgr'], ['counter', 'counter'], ['patrol', 'patrol']]) {
    ok(await api('POST', '/users', { token: A.owner, body: { email: `${who}@${A.slug}.test`, password: PW, role } }), 201);
    T[who] = await login(A, `${who}@${A.slug}.test`);
  }
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

let sha; let copyToken;

test('the page says when there is nothing to sign, and a manager adds the wording', async () => {
  const before = ok(await api('GET', `/public/${A.slug}/waiver`));
  assert.equal(before.open, false);
  is(await api('POST', `/public/${A.slug}/waiver/sign`, { body: family({ sha: 'a'.repeat(64) }) }), 400, 'nothing to sign yet');
  is(await api('PUT', '/waivers/text', { token: T.counter, body: { text: WORDING } }), 403, 'counter cannot change the wording');
  ok(await api('PUT', '/waivers/text', { token: T.mgr, body: { text: WORDING } }));
  const page = ok(await api('GET', `/public/${A.slug}/waiver`));
  assert.equal(page.open, true); assert.equal(page.text, WORDING); assert.equal(page.sha.length, 64);
  sha = page.sha;
  is(await api('GET', '/public/no-such-mountain-here/waiver'), 404);
});

test('signing checks the signer, the children, the typed name, the signature and the wording', async () => {
  const sign = (over) => api('POST', `/public/${A.slug}/waiver/sign`, { body: family({ sha, ...over }) });
  is(await sign({ signer: { first_name: 'Teen', last_name: 'Ager', date_of_birth: yearsAgo(16) }, typed_name: 'Teen Ager', children: [] }), 400, 'under 18 cannot sign');
  is(await sign({ children: [{ first_name: 'Big', last_name: 'Kid', date_of_birth: yearsAgo(19) }] }), 400, 'an adult child signs for themselves');
  is(await sign({ typed_name: 'Someone Else' }), 400, 'typed name must match');
  is(await sign({ signature: '' }), 400, 'a drawn signature is needed');
  is(await sign({ signature: 'data:text/html;base64,PHNjcmlwdD4=' }), 400, 'only a picture');
  is(await sign({ signature: `data:image/png;base64,${Buffer.from('not really a png').toString('base64')}` }), 400, 'a real PNG');
  is(await sign({ agree: false }), 400, 'must tick agree');
  is(await sign({ self: false, children: [] }), 400, 'someone must be covered');
  is(await sign({ sha: 'b'.repeat(64) }), 409, 'old wording');
  const r = ok(await sign({}), 201);
  assert.deepEqual(r.covered.sort(), ['Kit Parent', 'Pat Parent']);
  assert.match(r.token, /^[a-f0-9]{32}$/);
  copyToken = r.token;
});

test('the signed copy shows exactly what was signed, and only with its link', async () => {
  const c = ok(await api('GET', `/public/${A.slug}/waiver/copy/${copyToken}`));
  assert.equal(c.text, WORDING); assert.equal(c.signature, SIG); assert.equal(c.signer, 'Pat Parent');
  assert.equal(c.covered.find((x) => x.name === 'Kit Parent').relation, 'guardian');
  is(await api('GET', `/public/${A.slug}/waiver/copy/${'0'.repeat(32)}`), 404);
  is(await api('GET', `/public/${B.slug}/waiver/copy/${copyToken}`), 404, 'another mountain cannot open it');
});

let kitId; let patId; let kitWaiver;

test('the people covered now have a waiver everywhere the app checks', async () => {
  const look = ok(await api('GET', '/people/lookup?q=Parent', { token: T.counter }));
  const kit = look.data.find((p) => p.first_name === 'Kit'); const pat = look.data.find((p) => p.first_name === 'Pat');
  assert.ok(kit && pat, 'both records were made');
  assert.equal(kit.summary.waiver_this_season, true); assert.equal(pat.summary.waiver_this_season, true);
  kitId = kit.id; patId = pat.id;
  const ws = ok(await api('GET', `/people/${kitId}/waivers`, { token: T.counter })).data;
  assert.equal(ws[0].counts, true); assert.equal(ws[0].method, 'signed_online'); assert.equal(ws[0].signer_relation, 'guardian');
  is(await api('GET', '/waivers?q=Kit', { token: T.patrol }), 403, 'patrol do not browse the register');
  const list = ok(await api('GET', '/waivers?q=Kit', { token: T.counter }));
  kitWaiver = list.data.find((w) => w.person_id === kitId);
  assert.equal(kitWaiver.method_label, 'Signed online'); assert.equal(kitWaiver.has_signature, true);
  const d = ok(await api('GET', `/waivers/${kitWaiver.id}`, { token: T.counter }));
  assert.equal(d.text, WORDING); assert.equal(d.signing.signature, SIG); assert.equal(d.signing.typed_name, 'Pat Parent');
  assert.equal(d.covered.length, 2, 'shows who else the same signing covers');
  is(await api('GET', `/waivers/${kitWaiver.id}`, { token: B.owner }), 404, 'another mountain cannot see it');
  const sum = ok(await api('GET', '/waivers/summary', { token: T.counter }));
  assert.equal(sum.people, 2); assert.equal(sum.signings, 1);
});

test('a manager voids a waiver, and it stops counting but is kept', async () => {
  is(await api('POST', `/waivers/${kitWaiver.id}/void`, { token: T.counter, body: { reason: 'Wrong child' } }), 403);
  is(await api('POST', `/waivers/${kitWaiver.id}/void`, { token: T.mgr, body: { reason: '' } }), 400, 'a reason is needed');
  ok(await api('POST', `/waivers/${kitWaiver.id}/void`, { token: T.mgr, body: { reason: 'Signed for the wrong child' } }));
  is(await api('POST', `/waivers/${kitWaiver.id}/void`, { token: T.mgr, body: { reason: 'again' } }), 404, 'already voided');
  const kit = ok(await api('GET', '/people/lookup?q=Kit', { token: T.counter })).data.find((p) => p.id === kitId);
  assert.equal(kit.summary.waiver_this_season, false);
  const c = ok(await api('GET', `/public/${A.slug}/waiver/copy/${copyToken}`));
  assert.equal(c.covered.find((x) => x.name === 'Kit Parent').voided, true, 'the guest copy shows it too');
});

test('signing at the counter for an existing child; patrol cannot sign', async () => {
  const body = { sha, self: false, agree: true, typed_name: 'Pat Parent', signature: SIG, signer: { first_name: 'Pat', last_name: 'Parent', date_of_birth: yearsAgo(40) }, children: [{ person_id: kitId, first_name: 'Kit', last_name: 'Parent', date_of_birth: yearsAgo(9) }] };
  is(await api('POST', '/waivers/sign', { token: T.patrol, body }), 403);
  const r = ok(await api('POST', '/waivers/sign', { token: T.counter, body }), 201);
  assert.deepEqual(r.covered.map((c) => c.id), [kitId], 'the same record, not a new one');
  const ws = ok(await api('GET', `/people/${kitId}/waivers`, { token: T.counter })).data;
  assert.equal(ws[0].method, 'signed_counter'); assert.equal(ws[0].counts, true);
  const look = ok(await api('GET', '/people/lookup?q=Parent', { token: T.counter })).data;
  assert.equal(look.filter((p) => p.first_name === 'Kit').length, 1, 'no duplicate child record');
});

test('new wording keeps the old one, and "ask again" makes everyone sign again', async () => {
  ok(await api('PUT', '/waivers/text', { token: T.mgr, body: { text: `${WORDING} Updated for terrain parks.`, ask_again: true } }));
  const pat = ok(await api('GET', '/people/lookup?q=Pat', { token: T.counter })).data.find((p) => p.id === patId);
  assert.equal(pat.summary.waiver_this_season, false, 'signed before the new wording, so it no longer counts');
  is(await api('POST', `/public/${A.slug}/waiver/sign`, { body: family({ sha }) }), 409, 'the old wording cannot be signed any more');
  const page = ok(await api('GET', `/public/${A.slug}/waiver`));
  ok(await api('POST', `/public/${A.slug}/waiver/sign`, { body: family({ sha: page.sha, children: [] }) }), 201);
  const again = ok(await api('GET', '/people/lookup?q=Pat', { token: T.counter })).data.find((p) => p.id === patId);
  assert.equal(again.summary.waiver_this_season, true);
  const sum = ok(await api('GET', '/waivers/summary', { token: T.mgr }));
  assert.equal(sum.versions.length, 2);
  const old = sum.versions.find((v) => !v.current);
  assert.ok(old.signed >= 2);
  assert.equal(ok(await api('GET', `/waivers/texts/${old.sha}`, { token: T.mgr })).body, WORDING, 'the old wording is kept word for word');
  const list = ok(await api('GET', `/waivers?q=Pat`, { token: T.mgr })).data;
  assert.ok(list.some((w) => !w.counts && !w.voided_at), 'old signings are listed as no longer counting');
});

test('staff record a paper waiver; a manager downloads the spreadsheet; sending a link needs email', async () => {
  const p = ok(await api('POST', '/people', { token: T.counter, body: { first_name: 'Paper', last_name: 'Signer' } }), 201);
  ok(await api('POST', `/people/${p.id}/waivers`, { token: T.counter, body: {} }), 201);
  const ws = ok(await api('GET', `/people/${p.id}/waivers`, { token: T.counter })).data;
  assert.equal(ws[0].method, 'recorded_by_staff');
  is(await api('POST', '/waivers/send-link', { token: T.counter, body: { person_id: p.id } }), 400, 'no email on file');
  is(await api('GET', '/waivers/export.csv', { token: T.counter }), 403);
  const csv = await api('GET', '/waivers/export.csv', { token: T.mgr });
  assert.equal(csv.status, 200); assert.match(csv.type, /text\/csv/);
  assert.match(csv.text, /Recorded by staff/); assert.match(csv.text, /Signed online/); assert.match(csv.text, /Signed for the wrong child/);
});

test('the public page cannot name a record, and only name plus date of birth finds one', async () => {
  // Naming a child's record from the public page is ignored: a new adult record is made, the child gets nothing.
  const before = ok(await api('GET', `/people/${kitId}/waivers`, { token: T.counter })).data.length;
  const page = ok(await api('GET', `/public/${A.slug}/waiver`));
  const evil = ok(await api('POST', `/public/${A.slug}/waiver/sign`, { body: { sha: page.sha, agree: true, self: true, typed_name: 'Eve Evil', signature: SIG, children: [],
    signer: { person_id: kitId, first_name: 'Eve', last_name: 'Evil', date_of_birth: yearsAgo(30) } } }), 201);
  assert.deepEqual(evil.covered, ['Eve Evil']);
  assert.equal(ok(await api('GET', `/people/${kitId}/waivers`, { token: T.counter })).data.length, before, 'the child record was not touched');
  // Someone else typing Pat's email gets their own record; Pat's waiver list and email stay as they were, and no copy is sent.
  const patBefore = ok(await api('GET', `/people/${patId}/waivers`, { token: T.counter })).data.length;
  const mary = ok(await api('POST', `/public/${A.slug}/waiver/sign`, { body: { sha: page.sha, agree: true, self: true, typed_name: 'Mary Other', signature: SIG, children: [],
    signer: { first_name: 'Mary', last_name: 'Other', date_of_birth: yearsAgo(35), email: `pat-${suffix}@example.test` } } }), 201);
  assert.equal(mary.emailed, false);
  assert.equal(ok(await api('GET', `/people/${patId}/waivers`, { token: T.counter })).data.length, patBefore);
  const c = ok(await api('GET', `/public/${A.slug}/waiver/copy/${mary.token}`));
  assert.deepEqual(c.covered.map((x) => x.name), ['Mary Other'], 'the copy shows the name as typed');
  const m = ok(await api('GET', '/people/lookup?q=Mary', { token: T.counter })).data.find((p) => p.first_name === 'Mary');
  assert.equal(m.email || null, null, 'the new record does not take an address someone else has');
});

test('a stranger cannot sign for a child who has a guardian on file', async () => {
  const page = ok(await api('GET', `/public/${A.slug}/waiver`));
  const r = ok(await api('POST', `/public/${A.slug}/waiver/sign`, { body: { sha: page.sha, agree: true, self: false, typed_name: 'Stan Ger', signature: SIG,
    signer: { first_name: 'Stan', last_name: 'Ger', date_of_birth: yearsAgo(45) }, children: [{ first_name: 'Kit', last_name: 'Parent', date_of_birth: yearsAgo(9) }] } }), 201);
  assert.deepEqual(r.covered, ['Kit Parent']);
  const kits = ok(await api('GET', '/people/lookup?q=Kit', { token: T.counter })).data.filter((p) => p.first_name === 'Kit');
  assert.equal(kits.length, 2, 'the signing went on a new record for staff to check');
  const fam = ok(await api('GET', `/people/${kitId}/waivers`, { token: T.counter })).data;
  assert.ok(fam.every((w) => w.signed_by_name !== 'Stan Ger'), 'nothing was added to the real child');
  // At the counter, staff are told instead.
  const body = { sha: page.sha, self: false, agree: true, typed_name: 'Stan Ger', signature: SIG, signer: { first_name: 'Stan', last_name: 'Ger', date_of_birth: yearsAgo(45) }, children: [{ person_id: kitId, first_name: 'Kit', last_name: 'Parent', date_of_birth: yearsAgo(9) }] };
  is(await api('POST', '/waivers/sign', { token: T.counter, body }), 400);
});

test('the counter signs for next season, and nothing further ahead', async () => {
  const sum = ok(await api('GET', '/waivers/summary', { token: T.counter }));
  const body = (season) => ({ sha: sum.sha, season, self: true, agree: true, typed_name: 'Nora Next', signature: SIG, children: [], signer: { first_name: 'Nora', last_name: 'Next', date_of_birth: yearsAgo(33) } });
  is(await api('POST', '/waivers/sign', { token: T.counter, body: body('2099-00') }), 400);
  const r = ok(await api('POST', '/waivers/sign', { token: T.counter, body: body(sum.next_season) }), 201);
  assert.equal(r.season, sum.next_season);
});

test('the copy link is kept only as a hash, works through the season, and is refused once it has ended', async () => {
  const crypto = require('crypto');
  const [[row]] = await pool.query('SELECT token, token_sha FROM waiver_signings WHERE token_sha = ?', [crypto.createHash('sha256').update(copyToken).digest('hex')]);
  assert.ok(row, 'the signing is found by the hash of its token');
  assert.equal(row.token, null, 'the plain token is not stored');
  assert.match(row.token_sha, /^[a-f0-9]{64}$/);
  // A row from before hashing still opens with its plain token.
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [A.slug]);
  const old = crypto.randomBytes(16).toString('hex');
  await pool.query('UPDATE waiver_signings SET token = ?, token_sha = NULL WHERE tenant_id = ? AND token_sha = ?', [old, t.id, row.token_sha]);
  ok(await api('GET', `/public/${A.slug}/waiver/copy/${old}`));
  is(await api('GET', `/public/${A.slug}/waiver/copy/${copyToken}`), 404, 'the old hash no longer matches anything');
  await pool.query('UPDATE waiver_signings SET token = NULL, token_sha = ? WHERE tenant_id = ? AND token = ?', [row.token_sha, t.id, old]);
  // Within the season: the link works. A season end in the past for the signing's season: refused. Staff still see it in the app.
  // Days on the mountain's own clock, as the server counts them (a UTC date can be a day ahead near midnight).
  const U = require('../src/lib/util');
  const [[tz]] = await pool.query('SELECT timezone FROM tenants WHERE id = ?', [t.id]);
  const todayLocal = U.todayIn(tz.timezone);
  const tomorrow = U.addDays(todayLocal, 1);
  const yesterday = U.addDays(todayLocal, -1);
  const season = ok(await api('GET', `/public/${A.slug}/waiver/copy/${copyToken}`)).season;
  const inSeason = (d) => require('../src/lib/util').seasonFor(d) === season;
  await pool.query('UPDATE tenants SET season_ends_on = ? WHERE id = ?', [tomorrow, t.id]);
  ok(await api('GET', `/public/${A.slug}/waiver/copy/${copyToken}`));
  if (inSeason(yesterday)) {
    await pool.query('UPDATE tenants SET season_ends_on = ? WHERE id = ?', [yesterday, t.id]);
    is(await api('GET', `/public/${A.slug}/waiver/copy/${copyToken}`), 410, 'the season has ended');
  }
  // With no season end, the link lasts twelve months after signing.
  await pool.query('UPDATE tenants SET season_ends_on = NULL WHERE id = ?', [t.id]);
  ok(await api('GET', `/public/${A.slug}/waiver/copy/${copyToken}`));
  await pool.query('UPDATE waiver_signings SET created_at = DATE_SUB(NOW(), INTERVAL 13 MONTH) WHERE tenant_id = ? AND token_sha = ?', [t.id, row.token_sha]);
  is(await api('GET', `/public/${A.slug}/waiver/copy/${copyToken}`), 410, 'twelve months have passed');
  const d = ok(await api('GET', `/waivers/${kitWaiver.id}`, { token: T.counter }));
  assert.equal(d.signing.signature, SIG, 'staff still open the signed copy from Waivers');
  await pool.query('UPDATE waiver_signings SET created_at = NOW() WHERE tenant_id = ? AND token_sha = ?', [t.id, row.token_sha]);
});
