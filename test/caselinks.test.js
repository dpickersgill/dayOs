'use strict';

// Patrol reports linked to the rest of the mountain: the conditions at the time taken from the mountain's own records
// (trail, grooming, snow, weather, lift), suggested into the report's Conditions section; who was told and when (sent
// twice, kept once); the new "told" items the director can require; and the lift on the case.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { todayIn, nowIn } = require('../src/lib/util');
const COND = require('../src/lib/caseconditions');

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
const tz = 'America/New_York';
const today = todayIn(tz);
// The case happens an hour ago, so trail and lift status count (opened within three hours).
const hourAgo = () => { const n = nowIn(tz); return new Date(Date.parse(`${n.replace(' ', 'T')}Z`) - 3600_000).toISOString().slice(0, 16); };
const minusMin = (iso, m) => new Date(Date.parse(`${iso.replace(' ', 'T').slice(0, 16)}:00Z`) - m * 60000).toISOString().slice(0, 19).replace('T', ' ');

test('the rules: snapshot answers in the report\'s own choices', () => {
  const s = { weather: { at: '2026-12-05 09:40:00', temp_f: 22, sky: 'snow' }, snow: { new_snow_in: 5 }, trail: { groomed: { at: '2026-12-05 03:10:00', shift: 'night' } } };
  const g = COND.suggest(s);
  assert.equal(g.weather.value, 'snowing'); assert.match(g.weather.from, /9:40 AM/);
  assert.equal(g.temperature.value, 'minus10_to_0');
  assert.equal(g.snow.value, '10_to_15');
  assert.equal(g.surface.value, 'groomed'); assert.match(g.surface.from, /3:10 AM/);
  assert.deepEqual(COND.suggest(null), {});
  assert.equal(COND.clock('2026-12-05 00:05:00'), '12:05 AM');
  assert.equal(COND.clock('2026-12-05 12:30:00'), '12:30 PM');
});

test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const slug = `cl-${suffix}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Link Peak', timezone: tz, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  M.tenant = Number((await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]))[0][0].id);
  const login = async (email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
  M.owner = await login(`owner@${slug}.test`);
  M.pat = Number(ok(await api('POST', '/patrol/team', { token: M.owner, body: { person: { first_name: 'Pat', last_name: 'Ridge' }, level: 'patroller' } })).staff_id);
  ok(await api('POST', '/users', { token: M.owner, body: { email: `pat@${slug}.test`, password: PW, role: 'patrol', staff_id: M.pat } }));
  M.patT = await login(`pat@${slug}.test`);
  M.trail = ok(await api('POST', '/schedule/trails', { token: M.owner, body: { name: 'Ridge Run', difficulty: 'blue', status: 'open' } })).id;
  M.lift = ok(await api('POST', '/schedule/lifts', { token: M.owner, body: { name: 'Summit Quad', status: 'open' } })).id;
  const at = hourAgo().replace('T', ' ');
  M.at = at;
  await pool.query("INSERT INTO groom_plans (tenant_id, plan_date, shift, trail_id, status, finished_at) VALUES (?, ?, 'night', ?, 'done', ?)", [M.tenant, today, M.trail, minusMin(at, 300)]);
  await pool.query("INSERT INTO weather_logs (tenant_id, logged_at, place, temp_f, wind_mph, sky) VALUES (?, ?, 'Summit', 18, 12, 'snow')", [M.tenant, minusMin(at, 40)]);
  await pool.query('INSERT INTO weather_logs (tenant_id, logged_at, place, temp_f, sky) VALUES (?, ?, \'Base\', 40, \'clear\')', [M.tenant, minusMin(at, 60 * 20)]); // too old
  await pool.query("INSERT INTO snow_readings (tenant_id, trail_id, read_at, base_in, new_snow_in, surface) VALUES (?, NULL, ?, 30, 1, 'packed powder')", [M.tenant, minusMin(at, 200)]);
  await pool.query("INSERT INTO snow_readings (tenant_id, trail_id, read_at, base_in, new_snow_in, surface) VALUES (?, ?, ?, 24, 3, 'powder')", [M.tenant, M.trail, minusMin(at, 300)]);
  await pool.query("INSERT INTO lift_downtime (tenant_id, lift_id, started_at, ended_at, reason) VALUES (?, ?, ?, ?, 'wind')", [M.tenant, M.lift, minusMin(at, 20), minusMin(at, -10)]);
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('a case keeps the conditions at the time, and suggests them into the Conditions section', async () => {
  const c = ok(await api('POST', '/patrol/incidents', { token: M.patT, body: { occurred_at: M.at.replace(' ', 'T').slice(0, 16), location: 'Ridge Run', trail_id: M.trail, category: 'injury', severity: 'serious', summary: 'Knee' } }));
  M.case = c.id;
  const got = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: M.patT }));
  const s = got.conditions;
  assert.equal(s.trail.name, 'Ridge Run'); assert.equal(s.trail.status, 'open'); assert.equal(s.trail.groomed.shift, 'night');
  assert.equal(s.snow.base_in, 24, 'the trail\'s own reading comes first'); assert.equal(s.snow.on_trail, true);
  assert.equal(s.weather.temp_f, 18); assert.equal(s.weather.place, 'Summit');
  assert.equal(s.lift, null);
  assert.equal(got.conditions_suggest.weather.value, 'snowing');
  assert.equal(got.conditions_suggest.surface.value, 'groomed');
  // the lift: its stop at the time is kept
  is(await api('PATCH', `/patrol/incidents/${c.id}`, { token: M.patT, body: { lift_id: 999999 } }), 404);
  ok(await api('PATCH', `/patrol/incidents/${c.id}`, { token: M.patT, body: { lift_id: M.lift, lift_chair: '42' } }));
  const again = ok(await api('GET', `/patrol/incidents/${c.id}`, { token: M.patT }));
  assert.equal(again.lift, 'Summit Quad'); assert.equal(again.lift_chair, '42');
  assert.equal(again.conditions.lift.stop.reason, 'wind');
  // a case written up later: open or closed is not known, the rest still is
  const old = ok(await api('POST', '/patrol/incidents', { token: M.patT, body: { occurred_at: minusMin(M.at, 60 * 5).replace(' ', 'T').slice(0, 16), location: 'Ridge Run', trail_id: M.trail, category: 'injury', severity: 'minor', summary: 'Wrist' } }));
  const o = ok(await api('GET', `/patrol/incidents/${old.id}`, { token: M.patT })).conditions;
  assert.equal(o.trail.status, null); assert.equal(o.weather, null, 'no weather reading in the 12 hours before');
  // taken again on request
  const r = ok(await api('POST', `/patrol/incidents/${c.id}/conditions`, { token: M.patT }));
  assert.equal(r.conditions.lift.name, 'Summit Quad');
});

test('who was told: stamped, sent twice and kept once, and entered in error with a reason', async () => {
  const body = { who: 'insurer', who_name: 'Mountain Mutual', method: 'phone', note: 'Claim 55-1', client_ref: `ref${suffix}a` };
  const a = ok(await api('POST', `/patrol/incidents/${M.case}/contacts`, { token: M.patT, body }));
  const b = ok(await api('POST', `/patrol/incidents/${M.case}/contacts`, { token: M.patT, body }));
  assert.equal(a.id, b.id);
  is(await api('POST', `/patrol/incidents/${M.case}/contacts`, { token: M.patT, body: { who: 'other' } }), 400, 'someone else needs a name');
  ok(await api('POST', `/patrol/incidents/${M.case}/contacts`, { token: M.patT, body: { who: 'management', method: 'radio' } }));
  const wrong = ok(await api('POST', `/patrol/incidents/${M.case}/contacts`, { token: M.patT, body: { who: 'police' } }));
  ok(await api('POST', `/patrol/incidents/${M.case}/contacts/${wrong.id}/void`, { token: M.patT, body: { reason: 'Tapped the wrong one' } }));
  const c = ok(await api('GET', `/patrol/incidents/${M.case}`, { token: M.patT }));
  assert.deepEqual(c.contacts.map((x) => [x.who, Boolean(x.voided_at)]), [['insurer', false], ['management', false], ['police', true]]);
  assert.equal(c.contacts[0].recorded_by, 'Pat Ridge');
});

test('the director can require who was told, and a voided entry does not count', async () => {
  const pre = ok(await api('GET', '/patrol/requirements/presets/insurer', { token: M.owner }));
  assert.equal(pre.rules.injury['case.told_insurer'].level, 'approve');
  assert.deepEqual(pre.rules.injury['case.told_insurer'].when, ['serious']);
  assert.ok(!pre.rules.lost_person['case.told_parent'], 'no patient, no parent');
  const rules = { injury: { 'case.told_parent': { level: 'submit' }, 'case.told_management': { level: 'submit' } } };
  ok(await api('PUT', '/patrol/requirements', { token: M.owner, body: { rules } }));
  const c = ok(await api('GET', `/patrol/incidents/${M.case}`, { token: M.patT }));
  const items = c.requirements.items.filter((i) => i.key.startsWith('told_'));
  assert.deepEqual(items.map((i) => [i.key, i.met]).sort(), [['told_management', true], ['told_parent', false]]);
  assert.deepEqual(items.find((i) => i.key === 'told_parent').where, { area: 'contacts' });
});

test('rental gear on a case: found three ways, held until the shop inspects it', async () => {
  const t = M.tenant;
  const [p] = await pool.query("INSERT INTO people (tenant_id, first_name, last_name) VALUES (?, 'Riley', 'Renter')", [t]);
  const item = async (sku, category) => (await pool.query("INSERT INTO rental_items (tenant_id, sku, category, brand, model, size, status) VALUES (?, ?, ?, 'Rossignol', 'Experience', '160', 'rented')", [t, sku, category]))[0].insertId;
  const ski = await item(`SK${suffix}`, 'ski'); const boot = await item(`BT${suffix}`, 'boot');
  const [ct] = await pool.query("INSERT INTO rental_contracts (tenant_id, person_id, status, due_at) VALUES (?, ?, 'out', ?)", [t, p.insertId, `${today} 16:00:00`]);
  await pool.query("INSERT INTO rental_contract_items (tenant_id, contract_id, rental_item_id, din_setting, skier_type, boot_sole_mm, tech_name, set_at, test_result) VALUES (?, ?, ?, 6.5, 'II', 305, 'Terry Tech', ?, 'pass')", [t, ct.insertId, ski, `${today} 08:30:00`]);
  await pool.query('INSERT INTO rental_contract_items (tenant_id, contract_id, rental_item_id) VALUES (?, ?, ?)', [t, ct.insertId, boot]);
  await pool.query("INSERT INTO rental_service_log (tenant_id, rental_item_id, kind, done_by) VALUES (?, ?, 'tune', 'Shop')", [t, ski]);
  for (const q of [String(ct.insertId), `SK${suffix}`, 'Riley Ren']) {
    const r = ok(await api('GET', `/patrol/rental-lookup?q=${encodeURIComponent(q)}`, { token: M.patT }));
    assert.equal(r.data[0].id, ct.insertId, q);
  }
  const found = ok(await api('GET', `/patrol/rental-lookup?q=${ct.insertId}`, { token: M.patT })).data[0];
  const s = found.items.find((x) => x.item.id === ski);
  assert.equal(s.binding.din_setting, 6.5); assert.equal(s.binding.tech_name, 'Terry Tech'); assert.equal(s.last_service.kind, 'tune');
  const added = ok(await api('POST', `/patrol/incidents/${M.case}/rentals`, { token: M.patT, body: { rental_item_id: ski, contract_id: ct.insertId } }));
  assert.equal(added.held, true);
  is(await api('POST', `/patrol/incidents/${M.case}/rentals`, { token: M.patT, body: { rental_item_id: ski } }), 409, 'already on the case');
  const c = ok(await api('GET', `/patrol/incidents/${M.case}`, { token: M.patT }));
  assert.equal(c.rentals[0].detail.binding.din_setting, 6.5); assert.equal(c.rentals[0].held, true);
  // still out on the contract: it stays rented; when it comes back it goes to the shop, not the rack
  const status = async (id) => (await pool.query('SELECT status FROM rental_items WHERE id = ?', [id]))[0][0].status;
  assert.equal(await status(ski), 'rented');
  ok(await api('POST', `/rentals/contracts/${ct.insertId}/checkin`, { token: M.owner, body: {} }));
  assert.equal(await status(ski), 'maintenance'); assert.equal(await status(boot), 'available');
  const shop = ok(await api('GET', '/rentals/service', { token: M.owner }));
  assert.ok(shop.in_shop.find((x) => Number(x.id) === ski).patrol_case);
  is(await api('POST', `/rentals/items/${ski}/service`, { token: M.owner, body: { kind: 'tune', return_to_rack: true } }), 409, 'only an inspection releases it');
  is(await api('POST', `/rentals/items/${ski}/service`, { token: M.owner, body: { kind: 'inspection', return_to_rack: true } }), 400, 'say what it found');
  ok(await api('POST', `/rentals/items/${ski}/service`, { token: M.owner, body: { kind: 'inspection', notes: 'Bindings retested at 6.5, pass', return_to_rack: true } }));
  assert.equal(await status(ski), 'available');
  const after = ok(await api('GET', `/patrol/incidents/${M.case}`, { token: M.patT })).rentals[0];
  assert.ok(after.released_at); assert.match(after.inspection_note, /retested/);
  is(await api('DELETE', `/patrol/incidents/${M.case}/rentals/${after.id}`, { token: M.patT }), 409, 'inspected gear stays on the report');
  // added by mistake, then removed: back on the rack; with the shop's hold turned off, nothing is held
  const r2 = ok(await api('POST', `/patrol/incidents/${M.case}/rentals`, { token: M.patT, body: { rental_item_id: boot } }));
  assert.equal(await status(boot), 'maintenance');
  ok(await api('DELETE', `/patrol/incidents/${M.case}/rentals/${r2.id}`, { token: M.patT }));
  assert.equal(await status(boot), 'available');
  ok(await api('PUT', '/rentals/settings', { token: M.owner, body: { hold_after_incident: false } }));
  assert.equal(ok(await api('POST', `/patrol/incidents/${M.case}/rentals`, { token: M.patT, body: { rental_item_id: boot } })).held, false);
  assert.equal(await status(boot), 'available');
  // the report requirement "only when rental gear" now holds for this case
  const rq = ok(await api('GET', `/patrol/incidents/${M.case}`, { token: M.patT }));
  assert.ok(rq.rentals.length === 2);
});
