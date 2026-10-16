'use strict';

// Patrol operations and the clinical fixes from the EMS review: on-duty sign-in (and dispatch seeing volunteers), the
// closing sweep, opening checks, the formulary and medication safety checks, stock, oxygen and AEDs, tourniquets,
// times in the future, submit rules, legal hold, records requests, the lost-person search, the daily log, lift drills,
// avalanche work, self sign-up, offline case starts, the protocol stamp and phone alert encryption.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { todayIn, nowIn, addDays } = require('../src/lib/util');
const PUSH = require('../src/lib/push');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${JSON.stringify(r.body)}`);
const M = {};
let tz; let today; let now;
const at = (mins) => new Date(Date.parse(`${now.replace(' ', 'T')}Z`) + mins * 60000).toISOString().slice(0, 16);

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const slug = `po-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Ops Peak', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  M.owner = await login(`owner@${slug}.test`);
  M.id = Number((await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]))[0][0].id);
  tz = (await pool.query('SELECT timezone FROM tenants WHERE id = ?', [M.id]))[0][0].timezone;
  today = todayIn(tz); now = nowIn(tz);
  // Lee leads (sweep, schedule), Val is a volunteer patroller, Pia is paid
  for (const [key, first, level] of [['lee', 'Lee', 'leader'], ['val', 'Val', 'patroller'], ['pia', 'Pia', 'patroller']]) {
    M[key] = Number(ok(await api('POST', '/patrol/team', { token: M.owner, body: { person: { first_name: first, last_name: 'Ops' }, level, employee: key === 'pia' } })).staff_id);
    ok(await api('POST', '/users', { token: M.owner, body: { email: `${key}@${slug}.test`, password: PW, role: 'patrol', staff_id: M[key] } }));
    M[`${key}T`] = await login(`${key}@${slug}.test`);
  }
  M.hut = Number(ok(await api('POST', '/patrol/stations', { token: M.owner, body: { name: 'Summit hut', kind: 'hut' } })).id);
  M.run1 = Number(ok(await api('POST', '/schedule/trails', { token: M.owner, body: { name: 'Ridge', difficulty: 'blue', status: 'closed' } })).id);
  M.run2 = Number(ok(await api('POST', '/schedule/trails', { token: M.owner, body: { name: 'Bowl', difficulty: 'black', status: 'closed' } })).id);
  M.lift = Number(ok(await api('POST', '/schedule/lifts', { token: M.owner, body: { name: 'Summit chair' } })).id);
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('volunteers sign in on duty, and dispatch can send them', async () => {
  is(await api('GET', '/workforce/time/clock-in', { token: M.valT }), 404);
  const r = ok(await api('POST', '/patrol/duty/sign-in', { token: M.valT, body: { station_id: M.hut, radio: '12' } }));
  assert.ok(r.id);
  is(await api('POST', '/patrol/duty/sign-in', { token: M.valT, body: {} }), 409, 'already signed in');
  is(await api('POST', '/patrol/duty/sign-in', { token: M.valT, body: { staff_id: M.lee } }), 403, 'signing someone else in is for leads');
  ok(await api('POST', '/patrol/duty/sign-in', { token: M.leeT, body: { staff_id: M.pia, source: 'room', clock_in: true } }));
  const entry = (await pool.query('SELECT id FROM time_entries WHERE tenant_id = ? AND staff_id = ? AND clock_out IS NULL', [M.id, M.pia]))[0][0];
  assert.ok(entry, 'the paid patroller was clocked in too');
  const avail = ok(await api('GET', '/patrol/dispatch/available', { token: M.leeT })).data;
  assert.deepEqual(avail.map((a) => a.staff_id).sort(), [M.val, M.pia].sort());
  assert.equal(avail.find((a) => a.staff_id === M.val).radio, '12');
  const duty = ok(await api('GET', '/patrol/duty', { token: M.valT }));
  assert.equal(duty.me.on_duty, true);
  assert.equal(duty.on_duty.length, 2);
  // send Val to a call: "On my way" is recorded
  const call = ok(await api('POST', '/patrol/dispatch', { token: M.leeT, body: { location: 'Ridge', priority: 'high' } }));
  ok(await api('POST', `/patrol/dispatch/${call.id}/responders`, { token: M.leeT, body: { staff_id: M.val } }));
  assert.equal(ok(await api('GET', '/patrol/dispatch-mine', { token: M.valT })).data.length, 1);
  ok(await api('POST', `/patrol/dispatch/${call.id}/ack`, { token: M.valT }));
  const c = ok(await api('GET', `/patrol/dispatch/${call.id}`, { token: M.leeT }));
  assert.ok(c.responders[0].acked_at);
  ok(await api('POST', `/patrol/dispatch/${call.id}/events`, { token: M.leeT, body: { kind: 'closed' } }));
});

test('opening checks set runs open, on hold or closed; opening without a check needs a lead and a reason', async () => {
  is(await api('POST', '/patrol/opening', { token: M.valT, body: { trail_id: M.run1, decision: 'open', hazards_marked: true } }), 400, 'every check ticked to open');
  ok(await api('POST', '/patrol/opening', { token: M.valT, body: { trail_id: M.run1, decision: 'open', hazards_marked: true, ropes_signs: true, padding: true } }));
  is(await api('POST', '/patrol/opening', { token: M.valT, body: { trail_id: M.run2, decision: 'hold' } }), 400, 'a hold needs a reason');
  ok(await api('POST', '/patrol/opening', { token: M.valT, body: { trail_id: M.run2, decision: 'hold', reason: 'Wind loading' } }));
  const trails = (await pool.query('SELECT id, status, closure_reason FROM trails WHERE tenant_id = ? ORDER BY id', [M.id]))[0];
  assert.deepEqual(trails.map((t) => [t.status, t.closure_reason]), [['open', null], ['hold', 'Wind loading']]);
  is(await api('POST', `/patrol/trails/${M.run2}/status`, { token: M.valT, body: { status: 'open' } }), 409, 'no check today');
  is(await api('POST', `/patrol/trails/${M.run2}/status`, { token: M.valT, body: { status: 'open', override_reason: 'Wind dropped' } }), 403, 'only a lead overrides');
  ok(await api('POST', `/patrol/trails/${M.run2}/status`, { token: M.leeT, body: { status: 'open', override_reason: 'Wind dropped, checked by radio' } }));
  const list = ok(await api('GET', '/patrol/opening', { token: M.valT })).data;
  assert.equal(list.find((x) => x.id === M.run1).check.decision, 'open');
});

test('the closing sweep: routes, marks, a person called in, and mountain clear signs everyone out', async () => {
  is(await api('POST', '/patrol/sweep/routes', { token: M.valT, body: { name: 'North', items: [{ trail_id: M.run1 }] } }), 403);
  const route = Number(ok(await api('POST', '/patrol/sweep/routes', { token: M.leeT, body: { name: 'North', items: [{ lift_id: M.lift }, { trail_id: M.run1 }, { label: 'Lodge deck' }] } })).id);
  is(await api('POST', '/patrol/sweep/routes', { token: M.leeT, body: { name: 'Bad', items: [{ trail_id: M.run1, label: 'x' }] } }), 400, 'one kind of stop each');
  ok(await api('POST', '/patrol/sweep/start', { token: M.leeT, body: { assignments: [{ route_id: route, staff_id: M.val }] } }));
  is(await api('POST', '/patrol/sweep/start', { token: M.leeT, body: {} }), 409, 'one sweep a day');
  const s = ok(await api('GET', '/patrol/sweep', { token: M.valT })).sweep;
  const run = s.runs[0];
  assert.equal(run.staff_id, M.val);
  assert.equal(run.stops.length, 3);
  is(await api('POST', `/patrol/sweep/runs/${run.id}/clear`, { token: M.valT, body: {} }), 409, 'stops not marked');
  ok(await api('POST', `/patrol/sweep/runs/${run.id}/marks`, { token: M.valT, body: { item_id: run.stops[0].id } }));
  is(await api('POST', `/patrol/sweep/runs/${run.id}/marks`, { token: M.valT, body: { item_id: run.stops[1].id, flag: 'person' } }), 400, 'say what was found');
  const mark = ok(await api('POST', `/patrol/sweep/runs/${run.id}/marks`, { token: M.valT, body: { item_id: run.stops[1].id, flag: 'person', note: 'Skier resting by the sign' } }));
  ok(await api('POST', `/patrol/sweep/runs/${run.id}/marks`, { token: M.valT, body: { item_id: run.stops[2].id } }));
  ok(await api('POST', `/patrol/sweep/runs/${run.id}/clear`, { token: M.valT, body: {} }));
  is(await api('POST', '/patrol/sweep/clear', { token: M.leeT, body: {} }), 409, 'someone found and not called in');
  const callR = ok(await api('POST', `/patrol/sweep/marks/${mark.id}/call`, { token: M.valT }));
  assert.match(callR.call_no, /^\d{4}-\d{2}$/);
  const out = ok(await api('POST', '/patrol/sweep/clear', { token: M.leeT, body: { note: 'All clear' } }));
  assert.equal(out.signed_out, 2, 'Val and Pia signed out by the sweep');
  const duty = ok(await api('GET', '/patrol/duty', { token: M.leeT }));
  assert.equal(duty.on_duty.length, 0);
  assert.ok(duty.signed_out.every((d) => Number(d.auto_closed) === 1));
  // the daily log shows it
  const log = ok(await api('GET', '/patrol/daily-log', { token: M.leeT }));
  assert.equal(log.sweep.status, 'clear');
  assert.equal(log.duty.length, 2);
  assert.equal(log.opening.length, 2);
});

test('the formulary, allergy and nitroglycerin checks, stock by lot, and dose limits', async () => {
  const meds = ok(await api('GET', '/patrol/meds', { token: M.leeT }));
  assert.deepEqual(meds.formulary.map((f) => f.name).sort(), ['Albuterol inhaler', 'Aspirin', 'Epinephrine auto-injector', 'Nitroglycerin', 'Oral glucose', 'Oxygen']);
  const asp = meds.formulary.find((f) => f.name === 'Aspirin');
  const stock = Number(ok(await api('POST', '/patrol/meds/stock', { token: M.leeT, body: { formulary_id: asp.id, lot: 'A1', expires_on: addDays(today, 200), quantity: 4, unit: 'tablets' } })).id);
  const c = ok(await api('POST', '/patrol/incidents', { token: M.valT, body: { occurred_at: at(-30), location: 'Ridge', category: 'medical', severity: 'serious', summary: 'Chest pain' } }));
  const p = ok(await api('POST', `/patrol/incidents/${c.id}/patients`, { token: M.valT, body: { first_name: 'Carl', last_name: 'Chest', age_years: 61, allergies: 'Codeine' } }));
  const tr = (body) => api('POST', `/patrol/incidents/${c.id}/patients/${p.id}/treatments`, { token: M.valT, body });
  is(await tr({ kind: 'medication', medication: 'Ibuprofen', dose: '400 mg' }), 409, 'not on the formulary');
  is(await tr({ kind: 'medication', medication: 'Aspirin', dose: '324 mg', route: 'chewed', detail: { dose_value: 324, dose_unit: 'mg', authorised_by: 'Standing order' } }), 409, 'allergies not checked');
  is(await tr({ kind: 'medication', medication: 'Aspirin', dose: '650 mg', route: 'chewed', detail: { dose_value: 650, dose_unit: 'mg', authorised_by: 'Standing order', allergy_checked: true } }), 409, 'over the dose');
  is(await tr({ kind: 'medication', medication: 'Aspirin', dose: '324 mg', route: 'oral', detail: { dose_value: 324, dose_unit: 'mg', authorised_by: 'Standing order', allergy_checked: true } }), 409, 'wrong route');
  ok(await tr({ kind: 'medication', medication: 'Aspirin', dose: '324 mg', route: 'chewed', detail: { dose_value: 324, dose_unit: 'mg', authorised_by: 'Standing order', allergy_checked: true, stock_id: stock, stock_amount: 4 } }));
  assert.equal(Number((await pool.query('SELECT quantity FROM patrol_med_stock WHERE id = ?', [stock]))[0][0].quantity), 0, 'taken from the lot');
  const got = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: M.valT })).patients[0].treatments.find((t) => t.kind === 'medication');
  assert.equal(got.detail.lot, 'A1');
  // entered in error puts it back
  ok(await api('POST', `/patrol/incidents/${c.id}/patients/${p.id}/treatments/${got.id}/void`, { token: M.valT, body: { reason: 'Wrong patient' } }));
  assert.equal(Number((await pool.query('SELECT quantity FROM patrol_med_stock WHERE id = ?', [stock]))[0][0].quantity), 4);
  // nitroglycerin: assisting with their own, ED medication asked, a blood pressure of at least 100 in the last 5 minutes
  const nitro = (detail, extra = {}) => tr({ kind: 'medication', medication: 'Nitroglycerin', dose: '0.4 mg', route: 'sublingual', ...extra, detail: { dose_value: 0.4, dose_unit: 'mg', allergy_checked: true, authorised_by: "Patient's own medication", ...detail } });
  is(await nitro({ authorised_by: 'Standing order', pde5: 'no' }), 409, 'patrol only assists with their own');
  is(await nitro({}), 409, 'ED medication not asked');
  is(await nitro({ pde5: 'yes' }), 409, 'not after ED medication');
  is(await nitro({ pde5: 'no' }), 409, 'no blood pressure');
  ok(await api('POST', `/patrol/incidents/${c.id}/patients/${p.id}/vitals`, { token: M.valT, body: { bp_sys: 92, bp_dia: 60, pulse: 88 } }));
  const low = await nitro({ pde5: 'no' });
  is(low, 409); assert.match(low.body.error, /92\/60/);
  ok(await api('POST', `/patrol/incidents/${c.id}/patients/${p.id}/vitals`, { token: M.valT, body: { bp_sys: 128, bp_dia: 80 } }));
  ok(await nitro({ pde5: 'no' }));
  // a drug named in the allergies needs a reason
  ok(await api('PATCH', `/patrol/incidents/${c.id}/patients/${p.id}`, { token: M.valT, body: { allergies: 'Aspirin (hives)' } }));
  is(await tr({ kind: 'medication', medication: 'Aspirin', dose: '81 mg', route: 'chewed', detail: { dose_value: 81, dose_unit: 'mg', authorised_by: 'Standing order', allergy_checked: true } }), 409, 'allergic to it');
  // certification: a drug for EMTs and above
  ok(await api('POST', '/patrol/meds/formulary', { token: M.owner, body: { name: 'Naloxone', authority: 'standing_order', routes: ['intranasal'], max_dose: 4, dose_unit: 'mg', min_cert: 'emt' } }));
  is(await tr({ kind: 'medication', medication: 'Naloxone', dose: '4 mg', route: 'intranasal', detail: { dose_value: 4, dose_unit: 'mg', authorised_by: 'Standing order', allergy_checked: true } }), 409, 'Val is OEC');
  ok(await api('PATCH', `/patrol/team/${M.val}`, { token: M.owner, body: { cert_level: 'emt' } }));
  ok(await tr({ kind: 'medication', medication: 'Naloxone', dose: '4 mg', route: 'intranasal', detail: { dose_value: 4, dose_unit: 'mg', authorised_by: 'Standing order', allergy_checked: true } }));
  M.case = c.id; M.patient = p.id;
});

test('controlled counts need a witness, and a count that does not match needs a note', async () => {
  const f = Number(ok(await api('POST', '/patrol/meds/formulary', { token: M.owner, body: { name: 'Fentanyl', authority: 'medical_control', routes: ['intranasal'], min_cert: 'paramedic', controlled: true } })).id);
  const k = Number(ok(await api('POST', '/patrol/meds/stock', { token: M.leeT, body: { formulary_id: f, lot: 'F1', quantity: 5, unit: 'vials' } })).id);
  is(await api('POST', `/patrol/meds/stock/${k}/moves`, { token: M.leeT, body: { reason: 'wasted', delta: 1 } }), 400, 'a witness is needed');
  is(await api('POST', '/patrol/meds/counts', { token: M.leeT, body: { witness_staff: M.lee, lines: [{ stock_id: k, counted: 5 }] } }), 400, 'not your own witness');
  is(await api('POST', '/patrol/meds/counts', { token: M.leeT, body: { witness_staff: M.val, lines: [{ stock_id: k, counted: 4 }] } }), 400, 'a mismatch needs a note');
  const r = ok(await api('POST', '/patrol/meds/counts', { token: M.leeT, body: { witness_staff: M.val, lines: [{ stock_id: k, counted: 4 }], note: 'Vial broken, not logged' } }));
  assert.equal(r.discrepancy, true);
  is(await api('POST', '/patrol/meds/formulary', { token: M.valT, body: { name: 'X', authority: 'standing_order' } }), 403, 'patrollers do not change the formulary');
});

test('oxygen pressure and AED use are tracked; an AED used on a patient waits for its download', async () => {
  const o2 = Number(ok(await api('POST', '/patrol/equipment', { token: M.leeT, body: { name: 'O2 D-1', kind: 'oxygen', o2_size: 'D' } })).id);
  const out = ok(await api('POST', `/patrol/equipment/${o2}/checks`, { token: M.valT, body: { result: 'ok', psi: 300 } }));
  assert.equal(out.status, 'needs_attention', 'below the refill level');
  const aed = Number(ok(await api('POST', '/patrol/equipment', { token: M.leeT, body: { name: 'AED hut', kind: 'aed', pads_expire_on: addDays(today, 10) } })).id);
  ok(await api('POST', `/patrol/incidents/${M.case}/patients/${M.patient}/treatments`, { token: M.valT, body: { kind: 'aed', detail: { action: 'pads_on', equipment_id: aed } } }));
  is(await api('POST', `/patrol/equipment/${aed}/checks`, { token: M.leeT, body: { result: 'ok' } }), 409, 'download first');
  ok(await api('POST', `/patrol/equipment/${aed}/checks`, { token: M.leeT, body: { result: 'ok', downloaded: true } }));
  const flags = ok(await api('GET', '/patrol/meds', { token: M.leeT })).flags.map((f) => f.text).join('\n');
  assert.match(flags, /O2 D-1: 300 psi, refill/);
  assert.match(flags, /AED hut: pads expire/);
});

test('tourniquet with its limb, times in the future refused, and the vitals timer stops at hand-off', async () => {
  const b = `/patrol/incidents/${M.case}/patients/${M.patient}`;
  is(await api('POST', `${b}/treatments`, { token: M.valT, body: { kind: 'tourniquet' } }), 400, 'which limb');
  ok(await api('POST', `${b}/treatments`, { token: M.valT, body: { kind: 'tourniquet', detail: { limb: 'left_leg' } } }));
  is(await api('POST', `${b}/vitals`, { token: M.valT, body: { pulse: 90, taken_at: at(120) } }), 400, 'two hours ahead');
  ok(await api('POST', `${b}/vitals`, { token: M.valT, body: { pulse: 90, recheck_minutes: 5 } }));
  assert.ok(ok(await api('GET', `/patrol/incidents/${M.case}`, { token: M.valT })).patients[0].vitals_due_at);
  ok(await api('POST', `/patrol/incidents/${M.case}/events`, { token: M.valT, body: { kind: 'handoff', patient_id: M.patient } }));
  assert.equal(ok(await api('GET', `/patrol/incidents/${M.case}`, { token: M.valT })).patients[0].vitals_due_at, null);
  const d = ok(await api('GET', `/patrol/incidents/${M.case}`, { token: M.valT })).patients[0].derived;
  assert.match(d.fa_scene, /Tourniquet \(left leg\)/);
});

test('submit: head injury signs keep a patient off the slopes, clouded capacity needs a note, serious cases need vitals; the protocol is stamped', async () => {
  ok(await api('PUT', '/patrol/ops-settings', { token: M.owner, body: { medical_director: 'Dr. Ana Ruiz', protocol_version: 'OEC 6 local 2026' } }));
  const c = ok(await api('POST', '/patrol/incidents', { token: M.valT, body: { occurred_at: at(-20), location: 'Bowl', category: 'injury', severity: 'serious', summary: 'Head strike' } }));
  const p = ok(await api('POST', `/patrol/incidents/${c.id}/patients`, { token: M.valT, body: { first_name: 'Hal', last_name: 'Head', age_years: 30, chief_complaint: 'Headache', disposition: 'treated_released', form: { head_loc: 'yes', destination_type: 'return_to_ski' } } }));
  let probs = (await api('POST', `/patrol/incidents/${c.id}/submit`, { token: M.valT })).body.details.map((x) => x.message).join('\n');
  assert.match(probs, /lost consciousness, so not back to skiing/);
  assert.match(probs, /at least one set of vitals for a serious case/);
  ok(await api('PATCH', `/patrol/incidents/${c.id}/patients/${p.id}`, { token: M.valT, body: { disposition: 'refused_care', form: { refusal_capacity: 'yes', drugs_alcohol: '3 beers' } } }));
  probs = (await api('POST', `/patrol/incidents/${c.id}/submit`, { token: M.valT })).body.details.map((x) => x.message).join('\n');
  assert.match(probs, /drugs or alcohol, lost consciousness recorded, so say how you judged/);
  assert.doesNotMatch(probs, /not back to skiing/, 'a refusal is their choice');
  ok(await api('PATCH', `/patrol/incidents/${c.id}/patients/${p.id}`, { token: M.valT, body: { form: { refusal_capacity_note: 'Oriented x4, repeated the risks back' } } }));
  probs = (await api('POST', `/patrol/incidents/${c.id}/submit`, { token: M.valT })).body.details.map((x) => x.message).join('\n');
  assert.doesNotMatch(probs, /how you judged/);
  // stamp: a simple case that can be submitted
  const s = ok(await api('POST', '/patrol/incidents', { token: M.valT, body: { occurred_at: at(-10), location: 'Lot', category: 'other', summary: 'Lost glove' } }));
  ok(await api('POST', `/patrol/incidents/${s.id}/submit`, { token: M.valT }));
  const stamp = (await pool.query('SELECT protocol_stamp FROM incidents WHERE id = ?', [s.id]))[0][0].protocol_stamp;
  assert.equal(stamp, 'Medical director: Dr. Ana Ruiz. Protocols: OEC 6 local 2026');
});

test('checklists include an on-duty injury or exposure and a lift incident', async () => {
  const lists = ok(await api('GET', '/patrol/checklists', { token: M.valT })).data.map((l) => l.id);
  assert.ok(lists.includes('on_duty_injury') && lists.includes('lift_incident'));
  ok(await api('POST', `/patrol/incidents/${M.case}/checklist`, { token: M.valT, body: { key: 'state_notified', done: true } }));
});

test('legal hold, and records requests released only with authority and only once approved', async () => {
  ok(await api('POST', '/patrol/incidents', { token: M.valT, body: { occurred_at: at(-5), location: 'Ridge', category: 'other', summary: 'Sign down', client_ref: 'offlinecase001' } }));
  const again = ok(await api('POST', '/patrol/incidents', { token: M.valT, body: { occurred_at: at(-5), location: 'Ridge', category: 'other', summary: 'Sign down', client_ref: 'offlinecase001' } }));
  assert.equal(again.repeat, true, 'a case sent twice from a phone is made once');
  const quick = ok(await api('POST', '/patrol/incidents', { token: M.valT, body: { occurred_at: at(-4), location: 'Bowl', category: 'injury', summary: 'x', patient: { first_name: 'Quinn', chief_complaint: 'Wrist pain' } } }));
  assert.equal(ok(await api('GET', `/patrol/incidents/${quick.id}`, { token: M.valT })).patients[0].chief_complaint, 'Wrist pain');

  is(await api('PUT', `/patrol/incidents/${M.case}/legal-hold`, { token: M.valT, body: { hold: true, note: 'x' } }), 403, 'patrol Admins only');
  is(await api('PUT', `/patrol/incidents/${M.case}/legal-hold`, { token: M.owner, body: { hold: true } }), 400, 'say why');
  ok(await api('PUT', `/patrol/incidents/${M.case}/legal-hold`, { token: M.owner, body: { hold: true, note: 'Claim letter 10/16' } }));
  const tr = ok(await api('GET', `/patrol/incidents/${M.case}`, { token: M.valT })).patients[0].treatments[0];
  is(await api('POST', `/patrol/incidents/${M.case}/patients/${M.patient}/treatments/${tr.id}/void`, { token: M.valT, body: { reason: 'Mistake' } }), 409, 'on hold');
  is(await api('POST', `/patrol/incidents/${M.case}/patients/${M.patient}/void`, { token: M.valT, body: { reason: 'Mistake' } }), 409);

  const r = Number(ok(await api('POST', '/patrol/records', { token: M.owner, body: { incident_id: M.case, requester_kind: 'insurer', requester_name: 'Acme Mutual', received_on: today } })).id);
  is(await api('POST', `/patrol/records/${r}/release`, { token: M.owner, body: {} }), 409, 'no authority yet');
  ok(await api('PATCH', `/patrol/records/${r}`, { token: M.owner, body: { authorization: 'signed_release', auth_note: 'Release dated today' } }));
  is(await api('POST', `/patrol/records/${r}/release`, { token: M.owner, body: {} }), 409, 'not approved');
  // approve it (owner reviews: no review group)
  const c = M.case;
  await pool.query("UPDATE incidents SET report_state = 'approved' WHERE id = ?", [c]);
  await pool.query("INSERT INTO incident_versions (tenant_id, incident_id, version_no, kind, snapshot, created_by, created_at) VALUES (?, ?, 1, 'approved', '{}', 0, ?)", [M.id, c, now]);
  const rel = ok(await api('POST', `/patrol/records/${r}/release`, { token: M.owner, body: { note: 'Secure email' } }));
  assert.match(rel.release_no, /^R\d{4}-001$/);
  const pack = ok(await api('GET', `/patrol/records/${r}/pack`, { token: M.owner }));
  assert.equal(pack.request.release_no, rel.release_no);
  assert.equal(ok(await api('GET', `/patrol/incidents/${c}/records`, { token: M.valT })).data[0].status, 'released');
});

test('lost-person search: details, areas assigned and searched, found', async () => {
  const c = ok(await api('POST', '/patrol/incidents', { token: M.leeT, body: { occurred_at: at(-60), location: 'Base', category: 'lost_person', summary: 'Child missing' } }));
  ok(await api('PUT', `/patrol/incidents/${c.id}/search`, { token: M.leeT, body: { person_name: 'Sam Small', age_years: 9, clothing: 'Red jacket', last_seen_at: at(-70), last_seen_place: 'Magic carpet' } }));
  const a = ok(await api('POST', `/patrol/incidents/${c.id}/search/areas`, { token: M.leeT, body: { area: 'Trees left of Ridge', trail_id: M.run1, staff_id: M.val } }));
  ok(await api('POST', `/patrol/incidents/${c.id}/search/areas/${a.id}/searched`, { token: M.valT, body: {} }));
  is(await api('PUT', `/patrol/incidents/${c.id}/search`, { token: M.leeT, body: { outcome: 'found_well' } }), 400, 'when they were found');
  ok(await api('PUT', `/patrol/incidents/${c.id}/search`, { token: M.leeT, body: { outcome: 'found_well', found_at: at(-10), found_place: 'Ski school hut' } }));
  const s = ok(await api('GET', `/patrol/incidents/${c.id}/search`, { token: M.valT }));
  assert.equal(s.search.outcome, 'found_well');
  assert.equal(s.areas[0].status, 'searched');
});

test('the daily log: notes, sign-off, then only addenda; search finds them', async () => {
  is(await api('PUT', '/patrol/daily-log', { token: M.valT, body: { date: today, notes: 'x' } }), 403, 'leads write it');
  ok(await api('PUT', '/patrol/daily-log', { token: M.leeT, body: { date: today, notes: 'Rope line at Upper Ridge replaced' } }));
  is(await api('POST', '/patrol/daily-log/addenda', { token: M.leeT, body: { date: today, body: 'x' } }), 409, 'not signed yet');
  ok(await api('POST', '/patrol/daily-log/sign', { token: M.leeT, body: { date: today } }));
  is(await api('PUT', '/patrol/daily-log', { token: M.leeT, body: { date: today, notes: 'changed' } }), 409);
  ok(await api('POST', '/patrol/daily-log/addenda', { token: M.leeT, body: { date: today, body: 'Late note: the rope line was re-tied at 4 PM' } }));
  const found = ok(await api('GET', '/patrol/daily-log/search?q=rope%20line', { token: M.valT })).data;
  assert.equal(found.length, 2);
});

test('a lift drill gives each patroller a training record and counts them ready for that lift', async () => {
  ok(await api('PUT', `/patrol/lift-evac/${M.lift}/plan`, { token: M.leeT, body: { plan: 'Stop, call, rope teams', patrollers_needed: 2 } }));
  ok(await api('POST', `/patrol/lift-evac/${M.lift}/evacs`, { token: M.leeT, body: { kind: 'drill', started_at: at(-120), ended_at: at(-60), staff_ids: [M.val, M.pia] } }));
  const t = (await pool.query("SELECT COUNT(*) AS n FROM training_records WHERE tenant_id = ? AND kind = 'ride_evac'", [M.id]))[0][0].n;
  assert.equal(Number(t), 2);
  ok(await api('POST', '/patrol/duty/sign-in', { token: M.valT, body: {} }));
  const l = ok(await api('GET', '/patrol/lift-evac', { token: M.valT })).data[0];
  assert.deepEqual(l.ready_on_duty, ['Val Ops']);
  assert.equal(l.needed, 2);
});

test('avalanche work is off until turned on; a shot can hold its run', async () => {
  is(await api('GET', '/patrol/avy', { token: M.leeT }), 403);
  is(await api('PUT', '/patrol/ops-settings', { token: M.leeT, body: { avalanche: true } }), 403, 'patrol Admins turn it on');
  ok(await api('PUT', '/patrol/ops-settings', { token: M.owner, body: { avalanche: true } }));
  const path = Number(ok(await api('POST', '/patrol/avy/paths', { token: M.leeT, body: { name: 'Headwall', trail_id: M.run2 } })).id);
  is(await api('POST', '/patrol/avy/shots', { token: M.leeT, body: { path_id: path, method: 'hand_charge', result: 'slide' } }), 400, 'a slide needs a size');
  ok(await api('POST', '/patrol/avy/shots', { token: M.leeT, body: { path_id: path, method: 'hand_charge', result: 'slide', size_d: 2, run_status: 'hold' } }));
  const t = (await pool.query('SELECT status, closure_reason FROM trails WHERE id = ?', [M.run2]))[0][0];
  assert.deepEqual([t.status, t.closure_reason], ['hold', 'Avalanche control: Headwall']);
  is(await api('POST', '/patrol/avy/obs', { token: M.valT, body: { hn24_cm: 20 } }), 403, 'patrollers read it');
});

test('volunteer days against the minimum, and self sign-up for open shifts', async () => {
  ok(await api('PUT', '/patrol/ops-settings', { token: M.leeT, body: { min_days: 10, self_signup: true } }));
  const mine = ok(await api('GET', '/patrol/commitment', { token: M.valT }));
  assert.equal(mine.me.target, 10);
  assert.ok(mine.me.days >= 1, 'today counts: signed in');
  assert.equal(mine.data.length, 1, 'a patroller sees only their own');
  const all = ok(await api('GET', '/patrol/commitment', { token: M.leeT }));
  assert.equal(all.data.find((x) => x.staff_id === M.pia).target, null, 'paid patrollers have no minimum');
  const day = addDays(today, 3);
  const open = Number(ok(await api('POST', '/patrol/schedule', { token: M.leeT, body: { starts_at: `${day}T08:00`, ends_at: `${day}T16:00` } })).id);
  ok(await api('POST', '/patrol/schedule/publish', { token: M.leeT, body: { from: day, to: day } }));
  const board = ok(await api('GET', '/patrol/cover', { token: M.valT }));
  assert.ok(board.open_shifts.some((s) => s.id === open && s.can_take));
  ok(await api('POST', `/patrol/cover/open/${open}/take`, { token: M.valT }));
  is(await api('POST', `/patrol/cover/open/${open}/take`, { token: M.piaT }), 409, 'already taken');
  ok(await api('PUT', '/patrol/ops-settings', { token: M.leeT, body: { self_signup: false } }));
});

test('phone alerts: subscribing, and the message is encrypted for that phone only', async () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16).toString('base64url');
  const seen = [];
  PUSH.setTransport(async (endpoint, init) => { seen.push({ endpoint, init }); return { status: 201 }; });
  ok(await api('POST', '/patrol/alerts/subscribe', { token: M.valT, body: { endpoint: 'https://push.example.test/abc', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth } } }));
  const r = ok(await api('POST', '/patrol/alerts/test', { token: M.valT }));
  assert.equal(r.sent, 1);
  const msg = JSON.parse(PUSH.decrypt(Buffer.from(seen[0].init.body), ua, auth));
  assert.equal(msg.title, 'SummitOps alerts are on');
  assert.match(seen[0].init.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  // a phone that is gone is forgotten
  PUSH.setTransport(async () => ({ status: 410 }));
  await api('POST', '/patrol/alerts/test', { token: M.valT });
  assert.equal(Number((await pool.query('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = (SELECT id FROM users WHERE tenant_id = ? AND staff_id = ?)', [M.id, M.val]))[0][0].n), 0);
});
