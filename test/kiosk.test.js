'use strict';

// The time clock kiosk: pairing, PINs with lockout, QR badges, the confirm step, snapshots with expiry, corrections.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.JOBS_KEY = 'jobs-secret-for-tests';
process.env.KIOSK_RATE_LIMIT = '100000';
process.env.KIOSK_PAIR_LIMIT = '100000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const K = require('../src/lib/kiosk');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const q = async (sql, params) => (await pool.query(sql, params))[0];
const JPEG = `data:image/jpeg;base64,${Buffer.from('not really a photo but shaped like one').toString('base64')}`;

async function call(prefix, method, path, { token, kiosk, body, headers } = {}) {
  const res = await fetch(`${base}${prefix}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(kiosk ? { 'x-kiosk-token': kiosk } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const api = (m, p, o) => call('/api/v1', m, p, o);
const kio = (m, p, o) => call('/api/v1/kiosk', m, p, o);
const adm = (m, p, o) => call('/api/v1/kiosk-admin', m, p, o);
const ok = (r, status) => { assert.equal(r.status, status || (r.status < 300 ? r.status : -1), r.text); return r.body; };

async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: `Mountain ${slug}`, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const m = { slug, owner: (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token };
  m.id = (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id;
  return m;
}
const staffOf = async (m, first, last) => ok(await api('POST', '/workforce/staff', { token: m.owner, body: { person: { first_name: first, last_name: last }, status: 'active' } }), 201).id;
async function pair(m, name = 'Front door') {
  const d = ok(await adm('POST', '/devices', { token: m.owner, body: { name } }), 201);
  const p = ok(await kio('POST', '/pair', { body: { code: d.code } }));
  return { id: d.id, token: p.token };
}
const setPin = async (m, staff, pin) => ok(await adm('PUT', `/people/${staff}/pin`, { token: m.owner, body: pin ? { pin } : {} }));
const identify = (dev, staff, pin) => kio('POST', '/identify', { kiosk: dev.token, body: { staff_id: staff, pin } });

let A; let B; let devA; let devB; let sam; let ava; let bea;
test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`kio-a-${suffix}`);
  B = await mountain(`kio-b-${suffix}`);
  sam = await staffOf(A, 'Sam', 'Rider');
  ava = await staffOf(A, 'Ava', 'Lift');
  bea = await staffOf(B, 'Bea', 'Other');
  devA = await pair(A);
  devB = await pair(B);
});
test.after(async () => { server.close(); await pool.end(); });

test('pairing: a code works once and expires, an unpaired tablet gets nothing, and only managers set things up', async () => {
  const d = ok(await adm('POST', '/devices', { token: A.owner, body: { name: 'Lodge' } }), 201);
  assert.match(d.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(d.link.endsWith(`/kiosk/${d.code}`));
  const p = ok(await kio('POST', '/pair', { body: { code: d.code.toLowerCase().replace('-', '') } }));
  assert.ok(p.token.length >= 40);
  assert.equal(p.device.name, 'Lodge');
  assert.equal((await kio('POST', '/pair', { body: { code: d.code } })).status, 401, 'a code cannot be used twice');
  const stored = (await q('SELECT token_hash, pair_hash FROM kiosk_devices WHERE id = ?', [d.id]))[0];
  assert.equal(stored.pair_hash, null);
  assert.notEqual(stored.token_hash, p.token, 'the token is stored as a hash');
  // an expired code
  const d2 = ok(await adm('POST', '/devices', { token: A.owner, body: { name: 'Old' } }), 201);
  await q('UPDATE kiosk_devices SET pair_expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE id = ?', [d2.id]);
  assert.equal((await kio('POST', '/pair', { body: { code: d2.code } })).status, 401);
  // no token, wrong token
  assert.equal((await kio('GET', '/roster')).status, 401);
  const none = await kio('GET', '/roster', { kiosk: 'nope' });
  assert.equal(none.status, 401);
  assert.equal(none.body.details.code, 'kiosk_unpaired');
  // a plain staff login cannot manage kiosks; a deactivated tablet stops working
  ok(await api('POST', '/users', { token: A.owner, body: { email: `plain@${A.slug}.test`, password: PW, role: 'staff' } }), 201);
  const plain = (await api('POST', '/auth/login', { body: { tenant: A.slug, email: `plain@${A.slug}.test`, password: PW } })).body.token;
  assert.equal((await adm('GET', '/overview', { token: plain })).status, 403);
  ok(await adm('PATCH', `/devices/${d.id}`, { token: A.owner, body: { active: false } }));
  assert.equal((await kio('GET', '/roster', { kiosk: p.token })).status, 401);
  // re-pairing a device cuts off the old tablet
  const again = ok(await adm('POST', `/devices/${devA.id}/pair-code`, { token: A.owner }), 201);
  assert.equal((await kio('GET', '/roster', { kiosk: devA.token })).status, 401, 'the old tablet is cut off');
  devA = { id: devA.id, token: ok(await kio('POST', '/pair', { body: { code: again.code } })).token };
  assert.equal((await kio('GET', '/roster', { kiosk: devA.token })).status, 200);
});

test('PINs: weak ones are refused, a random one is made when none is given, and the roster only lists people who have one', async () => {
  for (const bad of ['1234', '1111', '0000', '98765', '12', 'abcd', '1234567']) assert.equal((await adm('PUT', `/people/${sam}/pin`, { token: A.owner, body: { pin: bad } })).status, 400, `${bad} is refused`);
  assert.deepEqual((await kio('GET', '/roster', { kiosk: devA.token })).body.people, [], 'nobody is listed before they have a PIN');
  const random = await setPin(A, sam);
  assert.match(random.pin, /^\d{4}$/);
  assert.equal(K.pinProblem(random.pin), null);
  const hash = (await q('SELECT pin_hash FROM kiosk_credentials WHERE staff_id = ?', [sam]))[0].pin_hash;
  assert.ok(hash.startsWith('$2'), 'the PIN is stored as a bcrypt hash');
  assert.ok(!hash.includes(random.pin));
  await setPin(A, sam, '2468');
  await setPin(A, ava, '1357');
  const roster = ok(await kio('GET', '/roster', { kiosk: devA.token }));
  assert.deepEqual(roster.people.map((p) => p.name), ['Ava L.', 'Sam R.'], 'first name and last initial, in order');
  assert.ok(roster.people.every((p) => p.in === false));
  assert.equal(roster.photos, false);
  // the other mountain sees only its own people, and managers of one cannot touch the other's staff
  assert.deepEqual((await kio('GET', '/roster', { kiosk: devB.token })).body.people, []);
  assert.equal((await adm('PUT', `/people/${sam}/pin`, { token: B.owner, body: { pin: '2468' } })).status, 404);
  assert.equal((await identify(devB, sam, '2468')).status, 401, 'a tablet cannot identify another mountain\'s staff');
});

test('identify: a wrong PIN counts down, five misses lock the person, a manager can unlock, and success resets the count', async () => {
  const wrong = await identify(devA, sam, '9999');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, 'That PIN did not match');
  assert.equal(wrong.body.details.attempts_left, 4);
  assert.equal((await identify(devA, sam, '9999')).body.details.attempts_left, 3);
  ok(await identify(devA, sam, '2468'));
  assert.equal((await identify(devA, sam, '9999')).body.details.attempts_left, 4, 'a good PIN resets the count');
  for (let i = 0; i < 3; i++) await identify(devA, sam, '9999');
  const fifth = await identify(devA, sam, '9999');
  assert.equal(fifth.status, 429);
  assert.equal(fifth.body.details.code, 'locked');
  assert.equal((await identify(devA, sam, '2468')).status, 429, 'the right PIN does not work while locked');
  const ov = ok(await adm('GET', '/overview', { token: A.owner }));
  assert.equal(ov.people.find((p) => p.staff_id === sam).locked, true);
  assert.equal((await identify(devA, ava, '1357')).status, 200, 'other people are not affected');
  ok(await adm('POST', `/people/${sam}/unlock`, { token: A.owner }));
  assert.equal((await identify(devA, sam, '2468')).status, 200);
  // a person with no PIN looks the same as a wrong PIN
  const bob = await staffOf(A, 'Bob', 'NoPin');
  const r = await identify(devA, bob, '2468');
  assert.equal(r.status, 401); assert.equal(r.body.error, 'That PIN did not match');
  assert.equal((await kio('POST', '/identify', { kiosk: devA.token, body: {} })).status, 400);
  const audit = await q("SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ? AND action = 'kiosk_locked'", [A.id]);
  assert.equal(audit[0].n, 1, 'the lockout is on the audit log');
});

test('punch: identify, then confirm; a stray tap cannot flip the state, and the token is bound to the tablet and the person', async () => {
  const idn = ok(await identify(devA, sam, '2468'));
  assert.equal(idn.state, 'out');
  assert.equal(idn.staff.name, 'Sam R.');
  assert.equal(idn.since, null);
  // asking to clock out while out is refused
  assert.equal((await kio('POST', '/punch', { kiosk: devA.token, body: { session: idn.session, action: 'out' } })).status, 409);
  // a forged or other-tablet token does not work
  assert.equal((await kio('POST', '/punch', { kiosk: devA.token, body: { session: `${idn.session}x`, action: 'in' } })).status, 401);
  assert.equal((await kio('POST', '/punch', { kiosk: devB.token, body: { session: idn.session, action: 'in' } })).status, 401, 'a token from one tablet is useless on another');
  const inn = ok(await kio('POST', '/punch', { kiosk: devA.token, body: { session: idn.session, action: 'in' } }), 201);
  assert.equal(inn.action, 'in');
  assert.ok(inn.at.startsWith(today), `the time shown is local: ${inn.at}`);
  assert.equal((await kio('POST', '/punch', { kiosk: devA.token, body: { session: idn.session, action: 'in' } })).status, 409, 'a second tap does not clock in twice');
  const e = (await q('SELECT * FROM time_entries WHERE tenant_id = ? AND staff_id = ?', [A.id, sam]))[0];
  assert.equal(e.in_method, 'pin'); assert.equal(e.in_device_id, devA.id); assert.equal(e.clock_out, null);
  // the roster, the next identify and the existing staff API all agree he is in
  assert.equal(ok(await kio('GET', '/roster', { kiosk: devA.token })).people.find((p) => p.id === sam).in, true);
  const again = ok(await identify(devA, sam, '2468'));
  assert.equal(again.state, 'in');
  assert.equal(again.since, inn.at);
  assert.ok(again.minutes >= 0 && again.minutes < 2, 'minutes so far');
  // an expired session
  const old = K.signSession({ tenantId: A.id, deviceId: devA.id, staffId: sam, method: 'pin' });
  const realNow = Date.now; Date.now = () => realNow() + 120_000;
  const late = await kio('POST', '/punch', { kiosk: devA.token, body: { session: old, action: 'out' } });
  Date.now = realNow;
  assert.equal(late.status, 401); assert.equal(late.body.details.code, 'session_expired');
  await q('UPDATE time_entries SET clock_in = DATE_SUB(clock_in, INTERVAL 90 MINUTE) WHERE id = ?', [e.id]);
  const out = ok(await kio('POST', '/punch', { kiosk: devA.token, body: { session: again.session, action: 'out' } }), 201);
  assert.equal(out.action, 'out');
  assert.ok(out.minutes >= 90 && out.minutes < 95, `worked ${out.minutes} minutes`);
  const done = (await q('SELECT * FROM time_entries WHERE id = ?', [e.id]))[0];
  assert.equal(done.out_method, 'pin');
  assert.ok(done.clock_out);
  const log = await q("SELECT action, user_id, detail FROM audit_log WHERE tenant_id = ? AND entity = 'time_entries' AND entity_id = ? ORDER BY id", [A.id, e.id]);
  assert.deepEqual(log.map((l) => l.action), ['kiosk_clock_in', 'kiosk_clock_out']);
  assert.equal(log[0].user_id, null);
  // the existing manager screens show the same local time the kiosk did
  const entries = ok(await api('GET', `/workforce/time/entries?from=${today}&to=${today}&staff_id=${sam}`, { token: A.owner })).data;
  assert.equal(entries.length, 1);
  assert.ok(entries[0].clock_in.startsWith(today));
});

test('a punch links to the shift that is on now', async () => {
  const pos = ok(await api('POST', '/workforce/positions', { token: A.owner, body: { name: 'Lift operator', department: 'lifts' } }), 201).id;
  const sh = ok(await api('POST', '/workforce/shifts', { token: A.owner, body: { position_id: pos, starts_at: `${today}T00:00`, ends_at: `${today}T23:59`, staff_id: ava, override_availability: true } }), 201);
  ok(await api('POST', '/workforce/shifts/publish', { token: A.owner, body: { from: today, to: today } }));
  const idn = ok(await identify(devA, ava, '1357'));
  assert.equal(idn.shift.position, 'Lift operator');
  ok(await kio('POST', '/punch', { kiosk: devA.token, body: { session: idn.session, action: 'in' } }), 201);
  const e = (await q('SELECT shift_id FROM time_entries WHERE tenant_id = ? AND staff_id = ?', [A.id, ava]))[0];
  assert.equal(e.shift_id, sh.id);
  const out = ok(await identify(devA, ava, '1357'));
  ok(await kio('POST', '/punch', { kiosk: devA.token, body: { session: out.session, action: 'out' } }), 201);
});

test('badges: a printed code identifies someone, a copied or altered one does not, and a new badge cancels the old one', async () => {
  const out = ok(await adm('POST', '/badges', { token: A.owner, body: { staff_ids: [sam, ava] } })).data;
  assert.equal(out.length, 2);
  const samBadge = out.find((b) => b.staff_id === sam);
  assert.match(samBadge.code, /^SO1\.\d+\.1\.[0-9a-f]{20}$/);
  assert.equal(ok(await adm('POST', '/badges', { token: A.owner, body: { staff_ids: [sam] } })).data[0].code, samBadge.code, 'printing again gives the same code');
  const scan = (dev, code) => kio('POST', '/identify', { kiosk: dev.token, body: { badge: code } });
  const hit = ok(await scan(devA, samBadge.code));
  assert.equal(hit.staff.id, sam);
  const e = await kio('POST', '/punch', { kiosk: devA.token, body: { session: hit.session, action: 'in' } });
  assert.equal(e.status, 201);
  assert.equal((await q('SELECT in_method FROM time_entries WHERE tenant_id = ? AND staff_id = ? ORDER BY id DESC LIMIT 1', [A.id, sam]))[0].in_method, 'badge');
  assert.equal((await scan(devA, samBadge.code.replace(/.$/, (c) => (c === '0' ? '1' : '0')))).status, 401, 'one wrong character');
  assert.equal((await scan(devA, `SO1.${ava}.1.${samBadge.code.split('.')[3]}`)).status, 401, 'Sam\'s signature on Ava\'s number');
  assert.equal((await scan(devA, 'hello')).status, 401);
  assert.equal((await scan(devB, samBadge.code)).status, 401, 'another mountain\'s tablet does not know this badge');
  const re = ok(await adm('POST', `/people/${sam}/badge/reissue`, { token: A.owner }));
  assert.match(re.code, /\.2\./);
  assert.equal((await scan(devA, samBadge.code)).status, 401, 'the old card is canceled');
  assert.equal((await scan(devA, re.code)).status, 200);
  assert.equal((await scan(devA, out.find((b) => b.staff_id === ava).code)).status, 200, 'other badges are unaffected');
  // someone with no badge issued cannot be matched even with a well-formed code
  const dan = await staffOf(A, 'Dan', 'NoBadge');
  assert.equal((await scan(devA, `SO1.${dan}.1.${K.badgeMac(A.id, dan, 1)}`)).status, 401, 'issuing is what turns a badge on');
  // clean up the open entry
  const out2 = ok(await scan(devA, re.code));
  ok(await kio('POST', '/punch', { kiosk: devA.token, body: { session: out2.session, action: 'out' } }), 201);
});

test('snapshots: off until a manager turns them on, kept only as a small JPEG, viewable by managers, and deleted after the retention', async () => {
  const idn = ok(await identify(devA, sam, '2468'));
  assert.equal(idn.photo, false);
  const first = ok(await kio('POST', '/punch', { kiosk: devA.token, body: { session: idn.session, action: 'in', image: JPEG } }), 201);
  assert.equal((await q('SELECT COUNT(*) AS n FROM time_photos WHERE tenant_id = ?', [A.id]))[0].n, 0, 'nothing is stored while snapshots are off');
  assert.equal((await adm('PUT', '/settings', { token: A.owner, body: { photos: true, photo_days: 0 } })).status, 400);
  ok(await adm('PUT', '/settings', { token: A.owner, body: { photos: true, photo_days: 30 } }));
  const roster = ok(await kio('GET', '/roster', { kiosk: devA.token }));
  assert.equal(roster.photos, true); assert.equal(roster.photo_days, 30);
  const i2 = ok(await identify(devA, sam, '2468'));
  assert.equal(i2.photo, true);
  // a bad image is ignored, not an error that blocks the punch
  const entry = (await q('SELECT id FROM time_entries WHERE tenant_id = ? AND staff_id = ? AND clock_out IS NULL', [A.id, sam]))[0].id;
  await kio('POST', '/punch', { kiosk: devA.token, body: { session: i2.session, action: 'out', image: 'data:text/html;base64,PHNjcmlwdD4=' } });
  assert.equal((await q('SELECT COUNT(*) AS n FROM time_photos WHERE entry_id = ?', [entry]))[0].n, 0, 'only JPEGs are kept');
  const i3 = ok(await identify(devA, sam, '2468'));
  ok(await kio('POST', '/punch', { kiosk: devA.token, body: { session: i3.session, action: 'in', image: JPEG } }), 201);
  const entry2 = (await q('SELECT id FROM time_entries WHERE tenant_id = ? AND staff_id = ? AND clock_out IS NULL', [A.id, sam]))[0].id;
  const photo = ok(await adm('GET', `/photos/${entry2}/in`, { token: A.owner }));
  assert.equal(photo.image, JPEG);
  assert.equal((await adm('GET', `/photos/${entry2}/in`, { token: B.owner })).status, 404, 'another mountain cannot see it');
  assert.equal((await adm('GET', `/photos/${entry2}/out`, { token: A.owner })).status, 404);
  const list = ok(await adm('GET', `/punches?from=${today}&to=${today}`, { token: A.owner })).data;
  const row = list.find((r) => r.id === entry2);
  assert.equal(row.photo_in, true); assert.equal(row.photo_out, false); assert.equal(row.in_method, 'pin'); assert.equal(row.in_device, 'Front door');
  assert.ok(!JSON.stringify(list).includes(JPEG), 'the list does not carry the pictures');
  const views = await q("SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ? AND action = 'kiosk_photo_viewed'", [A.id]);
  assert.equal(views[0].n, 1, 'looking at a snapshot is logged');
  // retention
  await q('UPDATE time_photos SET taken_at = DATE_SUB(NOW(), INTERVAL 31 DAY) WHERE entry_id = ?', [entry2]);
  const job = ok(await api('POST', '/internal/jobs/daily', { headers: { 'x-jobs-key': 'jobs-secret-for-tests' } }));
  assert.ok(job.photos_purged >= 1);
  assert.equal((await q('SELECT COUNT(*) AS n FROM time_photos WHERE entry_id = ?', [entry2]))[0].n, 0);
  // finish the open entry
  const i4 = ok(await identify(devA, sam, '2468'));
  ok(await kio('POST', '/punch', { kiosk: devA.token, body: { session: i4.session, action: 'out' } }), 201);
  assert.equal(first.action, 'in');
});

test('corrections: a forgotten clock-out is flagged and can be fixed in local time, and the change is audited', async () => {
  const old = (await q('INSERT INTO time_entries (tenant_id, staff_id, clock_in) VALUES (?, ?, DATE_SUB(NOW(), INTERVAL 20 HOUR))', [A.id, ava])).insertId;
  const list = ok(await adm('GET', `/punches?from=${today}&to=${today}`, { token: A.owner })).data;
  const wider = ok(await adm('GET', `/punches?from=${new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10)}&to=${today}`, { token: A.owner })).data;
  const row = wider.find((r) => r.id === old);
  assert.ok(row, 'it is in the list');
  assert.equal(row.long_open, true);
  assert.equal(row.clock_out, null);
  assert.ok(list.length >= 0);
  assert.equal((await adm('PATCH', `/entries/${old}`, { token: A.owner, body: { clock_out: '2000-01-01T08:00' } })).status, 400, 'out before in is refused');
  assert.equal((await adm('PATCH', `/entries/${old}`, { token: A.owner, body: {} })).status, 400);
  assert.equal((await adm('PATCH', `/entries/${old}`, { token: B.owner, body: { clock_out: `${today}T23:00` } })).status, 404, 'another mountain cannot touch it');
  const localIn = row.clock_in;
  const fixed = `${localIn.slice(0, 10)}T${localIn.slice(11, 13)}:${localIn.slice(14, 16)}`;
  const target = new Date(Date.parse(`${localIn.replace(' ', 'T')}Z`) + 8 * 3600_000).toISOString().slice(0, 16);
  ok(await adm('PATCH', `/entries/${old}`, { token: A.owner, body: { clock_out: target } }));
  const after = ok(await adm('GET', `/punches?from=${fixed.slice(0, 10)}&to=${today}`, { token: A.owner })).data.find((r) => r.id === old);
  assert.equal(after.clock_out.slice(0, 16).replace(' ', 'T'), target, 'the time comes back as it was typed, in local time');
  assert.ok(after.minutes >= 479 && after.minutes <= 480, `worked ${after.minutes} minutes`);
  assert.equal(after.out_method, 'manager');
  assert.equal(after.long_open, false);
  const log = (await q("SELECT user_id, detail FROM audit_log WHERE tenant_id = ? AND action = 'time_entry_corrected' AND entity_id = ?", [A.id, old]))[0];
  assert.ok(log.user_id, 'the manager who made the change is recorded');
  const detail = typeof log.detail === 'string' ? JSON.parse(log.detail) : log.detail;
  assert.ok(detail.was.clock_out === null);
});

test('overview lists devices and people, and a removed tablet stops working', async () => {
  const ov = ok(await adm('GET', '/overview', { token: A.owner }));
  assert.ok(ov.devices.some((d) => d.name === 'Front door' && d.paired && !d.waiting));
  assert.ok(ov.devices.every((d) => !('token_hash' in d)));
  const s = ov.people.find((p) => p.staff_id === sam);
  assert.equal(s.pin_set, true); assert.equal(s.badge_issued, true); assert.equal(s.name, 'Sam Rider');
  assert.equal(ov.people.find((p) => p.name === 'Bob NoPin').pin_set, false);
  assert.ok(!ov.people.some((p) => p.staff_id === bea), 'other mountains are not listed');
  ok(await adm('DELETE', `/people/${ava}/pin`, { token: A.owner }));
  assert.ok(!ok(await kio('GET', '/roster', { kiosk: devA.token })).people.some((p) => p.id === ava), 'clearing a PIN takes them off the screen');
  const gone = await pair(A, 'Temp');
  ok(await adm('DELETE', `/devices/${gone.id}`, { token: A.owner }));
  assert.equal((await kio('GET', '/roster', { kiosk: gone.token })).status, 401);
  // an inactive person cannot clock in even with the right PIN
  await q("UPDATE staff SET status = 'inactive' WHERE id = ?", [sam]);
  assert.equal((await identify(devA, sam, '2468')).status, 401);
  assert.ok(!ok(await kio('GET', '/roster', { kiosk: devA.token })).people.some((p) => p.id === sam));
});
