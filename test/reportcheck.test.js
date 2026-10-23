'use strict';

// The patrol report check and "fill in from the story". The check points out gaps (head injury questions, CMS around a
// splint, oxygen flow, a medication's effect, abnormal last vitals, times out of order, loaded words in the narrative)
// but never blocks a submit. Filling in from the story is off until the server has a key and the mountain turns it on;
// it proposes only for empty fields, only from words that are really in the story, and saves nothing itself.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const config = require('../src/config');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { checkCase } = require('../src/lib/reportcheck');

let server; let base; let fake; const seen = [];
let reply = () => ({ proposals: [] });
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);

const T = {};
test.before(async () => {
  // A stand-in for the AI provider: records what it was sent and answers with a forced tool call.
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push({ headers: req.headers, body, url: req.url });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ content: [{ type: 'tool_use', name: 'propose_fields', input: reply(body) }] }));
    });
  });
  await new Promise((r) => { fake.listen(0, r); });
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const slug = `rc-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  T.owner = (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token;
  const s1 = ok(await api('POST', '/workforce/staff', { token: T.owner, body: { person: { first_name: 'Pat', last_name: 'Rescuer' }, status: 'active' } })).id;
  ok(await api('POST', '/patrol/team', { token: T.owner, body: { staff_id: s1, callsign: 'Patrol 4', patrol_number: '417' } }));
  ok(await api('POST', '/users', { token: T.owner, body: { email: `pat@${slug}.test`, password: PW, role: 'patrol', staff_id: s1 } }));
  T.pat = (await api('POST', '/auth/login', { body: { tenant: slug, email: `pat@${slug}.test`, password: PW } })).body.token;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => fake.close(r));
  await pool.end();
});

const newCase = (over = {}) => api('POST', '/patrol/incidents', { token: T.pat, body: { occurred_at: `${today}T10:15`, location: 'Upper Ridge', category: 'injury', severity: 'moderate', summary: 'Skier down', ...over } });
const has = (list, re) => list.some((x) => re.test(x.message));

test('the check finds the gaps a reviewer would, and points at each one', async () => {
  const c = ok(await newCase());
  const b = `/patrol/incidents/${c.id}/patients`;
  const p = ok(await api('POST', b, { token: T.pat, body: { first_name: 'Hal', last_name: 'Head' } }));
  ok(await api('POST', `${b}/${p.id}/injuries`, { token: T.pat, body: { body_region: 'head', side: 'na', injury_type: 'concussion' } }));
  ok(await api('POST', `${b}/${p.id}/vitals`, { token: T.pat, body: { pulse: 132, resp: 18 } }));
  ok(await api('POST', `${b}/${p.id}/treatments`, { token: T.pat, body: { kind: 'splint', detail: { cms_before: { c: 'present', m: 'present', s: 'present' } } } }));
  ok(await api('POST', `${b}/${p.id}/treatments`, { token: T.pat, body: { kind: 'oxygen', detail: { o2_device: 'mask' } } }));
  ok(await api('POST', `/patrol/incidents/${c.id}/events`, { token: T.pat, body: { kind: 'call_received', at: `${today}T10:20` } }));
  ok(await api('POST', `/patrol/incidents/${c.id}/events`, { token: T.pat, body: { kind: 'on_scene', at: `${today}T10:12` } }));
  ok(await api('PATCH', `/patrol/incidents/${c.id}`, { token: T.pat, body: { narrative: 'The skier was obviously drunk and it was his fault he hit the tree. He said his head hurt and he could not remember the run down.' } }));

  const list = ok(await api('GET', `/patrol/incidents/${c.id}/check`, { token: T.pat })).data;
  assert.ok(has(list, /no AVPU or GCS/), 'level of consciousness');
  assert.ok(has(list, /head injury questions not answered/), 'head questions');
  assert.ok(has(list, /helmet use not recorded/), 'helmet');
  assert.ok(has(list, /only one set of vitals/), 'trend');
  assert.ok(has(list, /splint .* without CMS after/), 'CMS after');
  assert.ok(has(list, /oxygen .* without the flow rate/), 'flow');
  assert.ok(has(list, /abnormal \(pulse 132\)/), 'abnormal vitals');
  assert.ok(has(list, /no pain score/), 'pain');
  assert.ok(has(list, /On scene \(10:12\) is before Call received \(10:20\)/), 'times out of order');
  assert.ok(has(list, /"obviously"/) && has(list, /"drunk"/) && has(list, /"his fault"/), 'loaded words');
  const head = list.find((x) => /head injury questions/.test(x.message));
  assert.deepEqual([head.scope, head.section, head.field, head.patient_id], ['patient', 'head', 'head_loc', p.id], 'a jump link to the field');
  assert.ok(list.every((x) => x.why), 'each says why it matters');
  assert.equal(ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat })).check.length, list.length, 'the case carries the same list for reviewers');

  // Answering them clears them.
  ok(await api('PATCH', `${b}/${p.id}`, { token: T.pat, body: { form: { head_loc: 'no', head_amnesia_before: 'no', head_amnesia_after: 'yes', head_vomiting: 'no', head_headache: 'yes', helmet: 'owned' } } }));
  ok(await api('POST', `${b}/${p.id}/vitals`, { token: T.pat, body: { pulse: 96, avpu: 'alert', gcs_e: 4, gcs_v: 5, gcs_m: 6, pain: 4 } }));
  const after = ok(await api('GET', `/patrol/incidents/${c.id}/check`, { token: T.pat })).data;
  for (const re of [/no AVPU or GCS/, /head injury questions/, /helmet/, /only one set/, /abnormal/, /no pain score/]) assert.ok(!has(after, re), `cleared: ${re}`);
});

test('the check never blocks: a case with suggestions still submits', async () => {
  const c = ok(await newCase({ category: 'equipment', summary: 'Broken fence' }));
  assert.deepEqual(ok(await api('GET', `/patrol/incidents/${c.id}/check`, { token: T.pat })).data, [], 'nothing to check on a case without a patient');
  const m = ok(await newCase({ category: 'medical', summary: 'Felt faint' }));
  ok(await api('POST', `/patrol/incidents/${m.id}/patients`, { token: T.pat, body: { first_name: 'Fay', last_name: 'Faint' } }));
  const pid = ok(await api('GET', `/patrol/incidents/${m.id}`, { token: T.pat })).patients[0].id;
  ok(await api('POST', `/patrol/incidents/${m.id}/patients/${pid}/treatments`, { token: T.pat, body: { kind: 'medication', medication: 'Oral glucose', dose: '15 g', route: 'oral', detail: { dose_value: 15, dose_unit: 'g' } } }));
  const list = ok(await api('GET', `/patrol/incidents/${m.id}/check`, { token: T.pat })).data;
  assert.ok(has(list, /without the reason/) && has(list, /without the effect/) && has(list, /allergies left blank/));
  // Submit does not look at the suggestions; only the required-field check can stop it.
  const r = await api('POST', `/patrol/incidents/${m.id}/submit`, { token: T.pat });
  assert.ok(!JSON.stringify(r.body).includes('allergies left blank'), 'suggestions are not submit problems');
});

test('the check on its own: spine decision, tourniquet hand-off, a short story, words that are fine', () => {
  const base_ = { category: 'injury', narrative: 'Skier fell on the groomer, landed on the left shoulder. Said the pain was 6 out of 10. Splinted, CMS intact before and after. Walked to the patrol room with a patroller and was released to a friend at 11:05 after a second set of vitals.', events: [] };
  const p = { id: 7, first_name: 'Sam', last_name: 'Spine', form: { spine_midline: 'yes', destination_type: 'hospital' }, disposition: 'transported_ambulance', vitals: [{ pulse: 80, pain: 5, taken_at: '2026-01-01 10:00:00' }], injuries: [], treatments: [{ kind: 'tourniquet', performed_at: '2026-01-01 10:05:00', detail: { limb: 'left_leg' } }] };
  const list = checkCase({ ...base_, patients: [p] });
  assert.ok(has(list, /spine concern with no decision/));
  assert.ok(has(list, /tourniquet on and sent to higher care/));
  assert.ok(!has(list, /narrative/i), 'a plain story raises nothing');
  const short = checkCase({ ...base_, narrative: 'Fell. Hurt arm.', patients: [] });
  assert.ok(has(short, /very short/));
  const decided = checkCase({ ...base_, patients: [{ ...p, form: { ...p.form, spine_decision: 'not_indicated', handoff_to: 'Medic 3, J. Ruiz' } }] });
  assert.ok(has(decided, /marked not indicated/), 'midline tenderness against a "not indicated" decision');
  assert.ok(!has(decided, /tourniquet/));
});

test('fill in from the story: off by default, then proposals only for empty fields, quoted from the story', async () => {
  const c = ok(await newCase());
  const b = `/patrol/incidents/${c.id}/patients`;
  const p = ok(await api('POST', b, { token: T.pat, body: { first_name: 'Sue', last_name: 'Story', allergies: 'Penicillin' } }));
  const story = 'Called to the lower part of Upper Ridge. Snowboarder caught an edge and fell backwards, hitting the back of her head. Wearing her own helmet, which was cracked. She said she did not black out but she cannot remember getting on the lift. No vomiting. Says she has no allergies. Taken to Valley Hospital by Medic 3.';
  ok(await api('PATCH', `/patrol/incidents/${c.id}`, { token: T.pat, body: { narrative: story } }));

  config.patrolAi = { on: false, key: '', model: 'x', apiBase: '' };
  is(await api('POST', `/patrol/incidents/${c.id}/story-fill`, { token: T.pat }), 403, 'not set up on the server');
  assert.equal(ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat })).story_fill, false);

  config.patrolAi = { on: true, key: 'sk-test', model: 'claude-test', apiBase: `http://127.0.0.1:${fake.address().port}` };
  is(await api('POST', `/patrol/incidents/${c.id}/story-fill`, { token: T.pat }), 403, 'the mountain has not turned it on');
  assert.equal(ok(await api('GET', '/patrol/ops-settings', { token: T.owner })).story_fill_available, true);
  is(await api('PUT', '/patrol/ops-settings', { token: T.pat, body: { story_fill: true } }), 403, 'only those who run settings');
  ok(await api('PUT', '/patrol/ops-settings', { token: T.owner, body: { story_fill: true } }));
  assert.equal(ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat })).story_fill, true);

  reply = () => ({
    proposals: [
      { patient: 'P1', field: 'helmet', value: 'owned', quote: 'Wearing her own helmet' },
      { patient: 'P1', field: 'head_helmet_damage', value: 'yes', quote: 'helmet, which was cracked' },
      { patient: 'P1', field: 'head_loc', value: 'no', quote: 'she did not black out' },
      { patient: 'P1', field: 'head_amnesia_before', value: 'yes', quote: 'cannot remember getting on the lift' },
      { patient: 'P1', field: 'head_vomiting', value: 'no', quote: 'No vomiting.' },
      { patient: 'P1', field: 'activity', value: 'snowboard', quote: 'Snowboarder caught an edge' },
      { patient: 'P1', field: 'hospital_name', value: 'Valley Hospital', quote: 'Taken to Valley Hospital' },
      { patient: 'P1', field: 'allergies', value: 'None', quote: 'Says she has no allergies' }, // already filled: dropped
      { patient: 'P1', field: 'head_seizure', value: 'yes', quote: 'had a seizure on the snow' }, // not in the story: dropped
      { patient: 'P1', field: 'helmet', value: 'rental', quote: 'Wearing her own helmet' }, // a second answer for the same field: dropped
      { patient: 'P1', field: 'ability', value: 'pro', quote: 'Snowboarder' }, // not an option: dropped
      { patient: 'P1', field: 'spine_decision', value: 'smr', quote: 'Snowboarder' }, // a decision: never filled
      { patient: 'P1', field: 'first_name', value: 'Susan', quote: 'Snowboarder' }, // identity: never filled
      { patient: 'P9', field: 'head_headache', value: 'yes', quote: 'hitting the back of her head' }, // no such patient
    ],
  });
  const got = ok(await api('POST', `/patrol/incidents/${c.id}/story-fill`, { token: T.pat })).data;
  assert.deepEqual(got.map((x) => x.field).sort(), ['activity', 'head_amnesia_before', 'head_helmet_damage', 'head_loc', 'head_vomiting', 'helmet', 'hospital_name']);
  const helmet = got.find((x) => x.field === 'helmet');
  assert.deepEqual([helmet.value, helmet.value_label, helmet.patient_id, helmet.section], ['owned', 'Owned', p.id, 'equipment']);

  // What was sent: the story and the field list. No names; the key in the header; a forced tool call.
  const sent = seen.at(-1);
  assert.equal(sent.url, '/v1/messages');
  assert.equal(sent.headers['x-api-key'], 'sk-test');
  assert.equal(sent.body.tool_choice.name, 'propose_fields');
  const text = JSON.stringify(sent.body);
  assert.ok(!text.includes('Story') && !text.includes('Penicillin'), 'no patient name, and no field that is already filled');
  assert.ok(!text.includes('"spine_decision"') && !text.includes('"first_name"'), 'decisions and identity are not offered');

  // Nothing is saved until the patroller applies it.
  assert.equal(ok(await api('GET', `/patrol/incidents/${c.id}`, { token: T.pat })).patients[0].form.helmet, undefined);
  const [[log]] = await pool.query("SELECT detail FROM audit_log WHERE entity = 'incidents' AND entity_id = ? AND action = 'story_fill' ORDER BY id DESC LIMIT 1", [c.id]);
  assert.ok(!String(log.detail).includes('helmet'), 'the log keeps the count, not the answers');

  // Once filled, the field is not proposed again.
  ok(await api('PATCH', `${b}/${p.id}`, { token: T.pat, body: { form: { helmet: 'owned' } } }));
  assert.ok(!ok(await api('POST', `/patrol/incidents/${c.id}/story-fill`, { token: T.pat })).data.some((x) => x.field === 'helmet'));

  ok(await api('PATCH', `/patrol/incidents/${c.id}`, { token: T.pat, body: { narrative: 'Fell.' } }));
  is(await api('POST', `/patrol/incidents/${c.id}/story-fill`, { token: T.pat }), 400, 'a story first');
});
