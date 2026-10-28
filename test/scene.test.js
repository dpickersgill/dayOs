'use strict';
// Scene diagram and witness statements by link (src/routes/patrolscene.js, public/js/scene-draw.js).

process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.HELP_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server;
let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const is = (r, status, why) => { assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`); return r.body; };

async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: `Mount ${slug}`, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const l = await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } });
  return { slug, owner: l.body.token };
}
async function addUser(m, email, role, extra = {}) {
  is(await api('POST', '/users', { token: m.owner, body: { email, password: PW, role, ...extra } }), 201);
  return (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token;
}

let A; let B;
const T = {}; const D = {};
let draw;

test.before(async () => {
  draw = await import('../public/js/scene-draw.js');
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`sa-${suffix}`);
  B = await mountain(`sb-${suffix}`);
  const staff = is(await api('POST', '/workforce/staff', { token: A.owner, body: { person: { first_name: 'Pat', last_name: 'Patroller' }, status: 'active' } }), 201).id;
  T.pat = await addUser(A, `pat@${A.slug}.test`, 'patrol', { staff_id: staff });
  T.counter = await addUser(A, `counter@${A.slug}.test`, 'counter');
  T.otherPat = await addUser(B, `pat@${B.slug}.test`, 'patrol');
  D.trail = is(await api('POST', '/schedule/trails', { token: A.owner, body: { name: 'Ridge <Run>', difficulty: 'blue' } }), 201).id;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

const newCase = async (over = {}) => is(await api('POST', '/patrol/incidents', { token: T.pat, body: { occurred_at: `${today}T10:15`, location: 'Upper Ridge', category: 'injury', severity: 'moderate', summary: 'Wrist injury, Ann Guest', trail_id: D.trail, ...over } }), 201).id;

async function signOff(id, { approve = false } = {}) {
  const p = is(await api('POST', `/patrol/incidents/${id}/patients`, { token: T.pat, body: { form: { head_strike: 'no' }, first_name: 'Ann', last_name: 'Guest', chief_complaint: 'Wrist pain', disposition: 'treated_released' } }), 201);
  is(await api('POST', `/patrol/incidents/${id}/submit`, { token: T.pat }), 200);
  if (approve) is(await api('POST', `/patrol/incidents/${id}/approve`, { token: A.owner }), 200);
  return p;
}
const drawing = {
  items: [
    { id: 'a1', t: 'travel', x: 100, y: 100, x2: 300, y2: 200 },
    { id: 'a2', t: 'impact', x: 320, y: 210 },
    { id: 'a3', t: 'tree', x: 360, y: 240, r: 0, label: 'Big pine' },
    { id: 'a4', t: 'rope', x: 400, y: 50, x2: 400, y2: 400 },
    { id: 'a5', t: 'text', x: 500, y: 300, label: 'Icy patch <b>' },
  ],
  compass: { mode: 'uphill', angle: 0 },
  note: 'Not to scale',
};
const tokenOf = (link) => link.split('/w/')[1];
const statement = (over = {}) => ({ name: 'Wendy Witness', phone: '555-0199', email: 'wendy@example.com', address: '1 Main St', city: 'Stowe', region: 'VT', postal: '05672', statement: 'I saw the skier catch an edge on the ice and fall near the big pine.', signature: SIG, confirm: true, ...over });

test('drawing: clean keeps only what can be drawn, and text is escaped', () => {
  assert.throws(() => draw.clean(null));
  assert.throws(() => draw.clean({ items: [{ t: 'bomb', x: 1, y: 1 }] }), /Unknown item/);
  assert.throws(() => draw.clean({ items: Array.from({ length: draw.MAX_ITEMS + 1 }, () => ({ t: 'tree', x: 1, y: 1 })) }));
  const d = draw.clean({ items: [{ t: 'tree', x: -50, y: 99999, label: 'x'.repeat(80) }, { t: 'text', x: 5, y: 5 }, { t: 'travel', x: 10, y: 10, x2: 'junk' }], compass: { mode: 'weird', angle: 45 } });
  assert.equal(d.items.length, 2, 'a label with no text is dropped');
  assert.deepEqual([d.items[0].x, d.items[0].y, d.items[0].label.length], [0, draw.H, 40]);
  assert.equal(d.items[1].x2, 130, 'a two-point item gets a default end');
  assert.equal(d.compass.mode, 'uphill');
  const svg = draw.sceneSvg(drawing, { trail: 'Ridge <Run>', when: 'today' });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(!svg.includes('<b>') && svg.includes('Icy patch &lt;b&gt;'));
  assert.ok(svg.includes('Ridge &lt;Run&gt;'));
});

test('scene: save, read back, audited, read-only cases refused', async () => {
  const id = await newCase();
  const empty = is(await api('GET', `/patrol/incidents/${id}/scene`, { token: T.pat }), 200);
  assert.equal(empty.data, null);

  is(await api('PUT', `/patrol/incidents/${id}/scene`, { token: T.pat, body: { data: { items: [{ t: 'nope' }] } } }), 400);
  is(await api('PUT', `/patrol/incidents/${id}/scene`, { token: T.pat, body: { data: { ...drawing, items: [...drawing.items, { id: 'z', t: 'tree', x: 1, y: 1, onload: 'alert(1)' }] } } }), 200);
  const got = is(await api('GET', `/patrol/incidents/${id}/scene`, { token: T.pat }), 200);
  assert.equal(got.data.items.length, 6);
  assert.ok(!('onload' in got.data.items[5]), 'unknown fields are dropped');
  assert.ok(!got.svg.includes('onload') && !got.svg.includes('<b>'));
  assert.ok(got.svg.includes('Ridge &lt;Run&gt;'), 'the trail is labeled');
  assert.ok(got.updated_at);
  const [[a]] = await pool.query("SELECT COUNT(*) n FROM audit_log WHERE action = 'scene_diagram' AND entity_id = ?", [id]);
  assert.equal(Number(a.n), 1);

  // access: other roles and other mountains
  is(await api('GET', `/patrol/incidents/${id}/scene`, { token: T.counter }), 403);
  assert.ok([403, 404].includes((await api('GET', `/patrol/incidents/${id}/scene`, { token: T.otherPat })).status));
  assert.ok([403, 404].includes((await api('PUT', `/patrol/incidents/${id}/scene`, { token: T.otherPat, body: { data: drawing } })).status));

  // submitted: a patroller waits; approved: nobody changes it
  await signOff(id);
  is(await api('PUT', `/patrol/incidents/${id}/scene`, { token: T.pat, body: { data: drawing } }), 409);
  is(await api('PUT', `/patrol/incidents/${id}/scene`, { token: A.owner, body: { data: drawing } }), 200);
  is(await api('POST', `/patrol/incidents/${id}/approve`, { token: A.owner }), 200);
  is(await api('PUT', `/patrol/incidents/${id}/scene`, { token: A.owner, body: { data: drawing } }), 409);
  is(await api('GET', `/patrol/incidents/${id}/scene`, { token: T.pat }), 200, 'still readable');

  // legal hold
  const held = await newCase();
  is(await api('PUT', `/patrol/incidents/${held}/legal-hold`, { token: A.owner, body: { hold: true, note: 'Claim' } }), 200);
  const r = is(await api('PUT', `/patrol/incidents/${held}/scene`, { token: A.owner, body: { data: drawing } }), 409);
  assert.match(r.error || JSON.stringify(r), /legal hold/i);
});

test('witness link: the witness writes, signs and sends their own statement once', async () => {
  const id = await newCase();
  is(await api('POST', `/patrol/incidents/${id}/witness-links`, { token: T.pat, body: { name: 'Wendy', send: 'show' } }), 400, 'a phone or an email is needed');
  is(await api('POST', `/patrol/incidents/${id}/witness-links`, { token: T.counter, body: { name: 'Wendy', phone: '555-0199', send: 'show' } }), 403);
  const made = is(await api('POST', `/patrol/incidents/${id}/witness-links`, { token: T.pat, body: { name: 'Wendy', phone: '555-0199', send: 'show' } }), 201);
  assert.match(made.link, /\/w\/[A-Za-z0-9_-]{32}$/);
  const token = tokenOf(made.link);
  const [[row]] = await pool.query('SELECT token_hash FROM patrol_witness_links WHERE id = ?', [made.id]);
  assert.notEqual(row.token_hash, token, 'only a hash of the token is kept');
  const [[aud]] = await pool.query("SELECT COUNT(*) n FROM audit_log WHERE detail LIKE ?", [`%${token}%`]);
  assert.equal(Number(aud.n), 0, 'the token never reaches the audit log');

  let list = is(await api('GET', `/patrol/incidents/${id}/witness-links`, { token: T.pat }), 200);
  assert.equal(list.links[0].status, 'sent');

  // the witness opens it: the mountain, when and where, never the patient
  const page = is(await api('GET', `/public/witness-link/${token}`), 200);
  assert.equal(page.mountain, `Mount sa-${suffix}`);
  assert.ok(page.when && page.where);
  assert.ok(!JSON.stringify(page).includes('Ann'), 'no patient details on the witness page');
  list = is(await api('GET', `/patrol/incidents/${id}/witness-links`, { token: T.pat }), 200);
  assert.equal(list.links[0].status, 'opened');

  // validation
  is(await api('POST', `/public/witness-link/${token}`, { body: statement({ confirm: false }) }), 400);
  is(await api('POST', `/public/witness-link/${token}`, { body: statement({ signature: 'javascript:1' }) }), 400);
  is(await api('POST', `/public/witness-link/${token}`, { body: statement({ phone: '', email: '' }) }), 400);
  is(await api('POST', `/public/witness-link/${token}`, { body: statement({ statement: 'short' }) }), 400);
  is(await api('GET', '/public/witness-link/not-a-real-token-at-all-xxxxxxxxx'), 404);

  is(await api('POST', `/public/witness-link/${token}`, { body: statement() }), 201);
  is(await api('POST', `/public/witness-link/${token}`, { body: statement() }), 410, 'single use');
  is(await api('GET', `/public/witness-link/${token}`), 410);

  const c = is(await api('GET', `/patrol/incidents/${id}`, { token: T.pat }), 200);
  const w = c.witnesses.find((x) => x.name === 'Wendy Witness');
  assert.equal(w.source, 'link');
  assert.ok(w.received_at);
  assert.ok(c.notes.some((n) => /written and signed by them/.test(n.body)));
  const [[sig]] = await pool.query('SELECT statement_signature, received_ip FROM incident_witnesses WHERE id = ?', [w.id]);
  assert.equal(sig.statement_signature, SIG);
  list = is(await api('GET', `/patrol/incidents/${id}/witness-links`, { token: T.pat }), 200);
  assert.equal(list.links[0].status, 'received');
  assert.equal(list.statements.length, 1);

  // staff never edit or remove it; they mark it entered in error with a reason
  is(await api('DELETE', `/patrol/incidents/${id}/witnesses/${w.id}`, { token: T.pat }), 400, 'removing asks for a reason and only marks it entered in error');
  is(await api('POST', `/patrol/incidents/${id}/witness-statements/${w.id}/void`, { token: T.pat, body: { reason: '' } }), 400);
  is(await api('POST', `/patrol/incidents/${id}/witness-statements/${w.id}/void`, { token: T.pat, body: { reason: 'Sent for the wrong accident' } }), 200);
  is(await api('POST', `/patrol/incidents/${id}/witness-statements/${w.id}/void`, { token: T.pat, body: { reason: 'Again please' } }), 409);
  const after = is(await api('GET', `/patrol/incidents/${id}`, { token: T.pat }), 200);
  const v = after.witnesses.find((x) => x.id === w.id);
  assert.ok(v.voided_at);
  assert.equal(v.void_reason, 'Sent for the wrong accident');
  assert.equal(v.statement, w.statement, 'the words are kept');

  // resend and cancel are refused once received
  is(await api('POST', `/patrol/witness-links/${made.id}/resend`, { token: T.pat, body: { send: 'show' } }), 409);
  is(await api('POST', `/patrol/witness-links/${made.id}/cancel`, { token: T.pat }), 409);
  // other mountains cannot see the links
  assert.ok([403, 404].includes((await api('GET', `/patrol/incidents/${id}/witness-links`, { token: T.otherPat })).status));
  assert.ok([403, 404].includes((await api('POST', `/patrol/witness-links/${made.id}/cancel`, { token: T.otherPat })).status));
});

test('witness link: resend replaces the token, cancel and expiry close it', async () => {
  const id = await newCase();
  const made = is(await api('POST', `/patrol/incidents/${id}/witness-links`, { token: T.pat, body: { name: 'Rex', email: 'rex@example.com', send: 'show' } }), 201);
  const again = is(await api('POST', `/patrol/witness-links/${made.id}/resend`, { token: T.pat, body: { send: 'show' } }), 200);
  assert.notEqual(tokenOf(again.link), tokenOf(made.link));
  assert.ok([404, 410].includes((await api('GET', `/public/witness-link/${tokenOf(made.link)}`)).status), 'the old link stops working');
  is(await api('GET', `/public/witness-link/${tokenOf(again.link)}`), 200);

  is(await api('POST', `/patrol/witness-links/${made.id}/cancel`, { token: T.pat }), 200);
  const gone = is(await api('GET', `/public/witness-link/${tokenOf(again.link)}`), 410);
  assert.match(gone.error || JSON.stringify(gone), /no longer in use/);
  is(await api('POST', `/patrol/witness-links/${made.id}/resend`, { token: T.pat, body: { send: 'show' } }), 409);

  const old = is(await api('POST', `/patrol/incidents/${id}/witness-links`, { token: T.pat, body: { name: 'Old', phone: '555-0101', send: 'show' } }), 201);
  await pool.query('UPDATE patrol_witness_links SET expires_at = DATE_SUB(expires_at, INTERVAL 80 HOUR) WHERE id = ?', [old.id]);
  const exp = is(await api('GET', `/public/witness-link/${tokenOf(old.link)}`), 410);
  assert.match(exp.error || JSON.stringify(exp), /expired/);
  is(await api('POST', `/public/witness-link/${tokenOf(old.link)}`, { body: statement() }), 410);
  const list = is(await api('GET', `/patrol/incidents/${id}/witness-links`, { token: T.pat }), 200);
  assert.equal(list.links.find((x) => x.id === old.id).status, 'expired');
  assert.equal(list.links.find((x) => x.id === made.id).status, 'canceled');
});

test('witness link: after sign-off the statement is an addendum; texting and email need setup', async () => {
  const id = await newCase();
  const made = is(await api('POST', `/patrol/incidents/${id}/witness-links`, { token: T.pat, body: { name: 'Ada', phone: '555-0122', send: 'show' } }), 201);
  await signOff(id, { approve: true });
  is(await api('POST', `/public/witness-link/${tokenOf(made.link)}`, { body: statement({ name: 'Ada Late' }) }), 201);
  const c = is(await api('GET', `/patrol/incidents/${id}`, { token: T.pat }), 200);
  assert.ok(!c.witnesses.some((w) => w.name === 'Ada Late'), 'the signed-off report stays as it was');
  const note = c.notes.find((n) => /^Addendum: witness statement/.test(n.body));
  assert.ok(note && note.body.includes('catch an edge'));
  const [[l]] = await pool.query('SELECT status, statement, note_id FROM patrol_witness_links WHERE id = ?', [made.id]);
  assert.equal(l.status, 'received');
  assert.equal(Number(l.note_id), Number(note.id));

  // a link can still go out after sign-off: whatever comes back is an addendum
  is(await api('POST', `/patrol/incidents/${id}/witness-links`, { token: A.owner, body: { name: 'Bo', phone: '555-0123', send: 'show' } }), 201);

  // a held case takes no voids
  const held = await newCase();
  const h = is(await api('POST', `/patrol/incidents/${held}/witness-links`, { token: T.pat, body: { name: 'Hal', phone: '555-0124', send: 'show' } }), 201);
  is(await api('POST', `/public/witness-link/${tokenOf(h.link)}`, { body: statement({ name: 'Hal Held' }) }), 201);
  const hw = is(await api('GET', `/patrol/incidents/${held}`, { token: T.pat }), 200).witnesses.find((w) => w.name === 'Hal Held');
  is(await api('PUT', `/patrol/incidents/${held}/legal-hold`, { token: A.owner, body: { hold: true, note: 'Claim' } }), 200);
  is(await api('POST', `/patrol/incidents/${held}/witness-statements/${hw.id}/void`, { token: A.owner, body: { reason: 'Wrong case' } }), 409);

  // texting is not set up in tests: asking for a text says so, it does not pretend
  const list = is(await api('GET', `/patrol/incidents/${held}/witness-links`, { token: T.pat }), 200);
  if (!list.texting) {
    const t = await api('POST', `/patrol/incidents/${held}/witness-links`, { token: T.pat, body: { name: 'Tex', phone: '555-0125', send: 'text' } });
    assert.ok(t.status === 201 ? /text/i.test(t.body.note || '') : t.status === 409 || t.status === 400, JSON.stringify(t.body));
  }
});
