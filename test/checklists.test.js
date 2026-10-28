'use strict';

// Patrol checklists: the built-in library, which lists a patrol has switched on, the patrol's own lists, and ticks that
// keep their words after a list changes (the case, its frozen versions and the claim file).
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.AUDIT_LOG_STDOUT = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const CL = require('../src/lib/checklists');
const { TYPE_KEYS } = require('../src/lib/attractions');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const q = async (sql, params) => (await pool.query(sql, params))[0];
const DEVICE = 'test-device-0123456789abcdef';
async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'x-device': DEVICE, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const ok = (r, status) => { assert.equal(r.status, status || (r.status < 300 ? r.status : -1), r.text); return r.body; };
async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Checklist Test', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const owner = (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token;
  const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
  return { slug, owner, id: t.id };
}
async function addUser(m, email, role, extra = {}) {
  ok(await api('POST', '/users', { token: m.owner, body: { email, password: PW, role, ...extra } }), 201);
  return (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token;
}
const newCase = (token, over = {}) => api('POST', '/patrol/incidents', { token, body: { occurred_at: `${today}T10:15`, location: 'Upper Ridge', category: 'injury', severity: 'minor', summary: 'Skier fell', ...over } });
const tick = (token, id, key, more = {}) => api('POST', `/patrol/incidents/${id}/checklist`, { token, body: { key, done: true, ...more } });
const lists = async (token, caseId) => ok(await api('GET', `/patrol/checklists${caseId ? `?case=${caseId}` : ''}`, { token })).data;
const det = (r) => (typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail);
const audits = (tenant, action) => q('SELECT * FROM audit_log WHERE tenant_id = ? AND action = ? ORDER BY id', [tenant, action]);

let A; let B; let admin; let pat;
test.before(async () => {
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`cl-${suffix}`);
  B = await mountain(`cm-${suffix}`);
  const mk = async (first, level) => {
    const staff = ok(await api('POST', '/workforce/staff', { token: A.owner, body: { person: { first_name: first, last_name: 'Patrol' }, status: 'active' } }), 201).id;
    ok(await api('POST', '/patrol/team', { token: A.owner, body: { staff_id: staff, level } }), 201);
    return staff;
  };
  admin = await addUser(A, `director@${A.slug}.test`, 'patrol', { staff_id: await mk('Dee', 'director') });
  pat = await addUser(A, `pat@${A.slug}.test`, 'patrol', { staff_id: await mk('Pat', 'patroller') });
  B.pat = await addUser(B, `pat@${B.slug}.test`, 'patrol');
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

// ---------------------------------------------------------------- the library
test('library: unique ids and keys, the original seven unchanged, and every list well formed', () => {
  const ids = CL.LISTS.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length, 'list ids are unique');
  const keys = CL.LISTS.flatMap((l) => l.items.map((i) => i[0]));
  assert.equal(new Set(keys).size, keys.length, 'item keys are unique across every list');
  // the seven lists from before the library grew: same ids, same keys in the same order, so recorded ticks keep their meaning
  const ORIGINAL = {
    head_spine: ['manual_stabilization', 'mechanism_considered', 'neuro_checked', 'gcs_recorded', 'vitals_repeated', 'spine_motion_restricted', 'ems_considered', 'concussion_sheet'],
    minor: ['guardian_contacted', 'guardian_details', 'released_to_adult', 'group_leader_told'],
    collision: ['parties_identified', 'contact_exchanged', 'witnesses_taken', 'scene_noted', 'equipment_held', 'statements_separate', 'supervisor_notified', 'police_considered'],
    refusal: ['capacity_assessed', 'risks_explained', 'alternatives_offered', 'advice_given', 'refusal_signed'],
    transport: ['handoff_sheet', 'allergies_confirmed', 'belongings_sent', 'contact_family', 'handoff_recorded'],
    on_duty_injury: ['supervisor_told', 'first_aid_given', 'exposure_source', 'ppe_noted', 'referred_testing', 'first_report'],
    lift_incident: ['lift_stopped', 'maintenance_told', 'operator_statement', 'scene_photos', 'state_notified', 'evac_considered'],
  };
  for (const [id, want] of Object.entries(ORIGINAL)) assert.deepEqual(CL.BY_ID.get(id).items.map((i) => i[0]), want, `${id} keys unchanged`);
  assert.deepEqual(CL.ORIGINAL, Object.keys(ORIGINAL));
  assert.ok(CL.LISTS.length >= 25, 'a bigger library');
  const groups = new Set(CL.GROUPS.map((g) => g[0]));
  for (const l of CL.LISTS) {
    assert.match(l.id, /^[a-z][a-z0-9_]{1,39}$/, `${l.id}: id`);
    assert.ok(!/^c\d+$/.test(l.id), `${l.id}: never looks like a patrol's own list`);
    assert.ok(['patient', 'case'].includes(l.scope), `${l.id}: scope`);
    assert.ok(groups.has(l.group), `${l.id}: group`);
    assert.ok(l.title && l.title.length <= 150 && l.when && l.when.length <= 300, `${l.id}: title and when`);
    assert.ok(l.items.length >= 4 && l.items.length <= 14, `${l.id}: a short list`);
    for (const [key, label] of l.items) {
      assert.match(key, /^[a-z][a-z0-9_]{2,59}$/, `${l.id}: key ${key}`);
      assert.ok(!/^c\d+_\d+$/.test(key), `${key}: never looks like a patrol's own item`);
      assert.ok(label.length > 5 && label.length <= 255 && !/[—–]/.test(label), `${key}: label`);
    }
    for (const t of l.attraction || []) assert.ok(TYPE_KEYS.includes(t), `${l.id}: attraction type ${t}`);
    if (l.start === 'attraction') assert.ok((l.attraction || []).length, `${l.id}: an attraction list names its types`);
  }
  // the attraction lists the owner asked for, each tied to its type
  for (const t of ['zipline', 'coaster', 'ice_rink', 'tubing', 'scenic_lift', 'bike_park', 'aerial_park', 'climbing_wall']) assert.ok(CL.LISTS.some((l) => (l.attraction || []).includes(t)), `a list for ${t}`);
  // older ticks read from the built-in words; ticks with their own words are left alone
  const [old, own] = CL.labelTicks([{ item_key: 'neuro_checked', patient_id: 1 }, { item_key: 'neuro_checked', list_id: 'head_spine', list_title: 'Old title', item_label: 'Old words' }]);
  assert.deepEqual([old.list_id, old.list_title, old.item_label], ['head_spine', 'Head or spine injury', 'Movement and feeling checked in hands and feet']);
  assert.deepEqual([own.list_title, own.item_label], ['Old title', 'Old words']);
});

// ---------------------------------------------------------------- switching lists on and off
test('switching lists: patrol admin only, audited, and a list that is off takes ticks only where it was already used', async () => {
  // who may see and change the setup
  assert.equal((await api('GET', '/patrol/checklists/setup', { token: pat })).status, 403);
  assert.equal((await api('PUT', '/patrol/checklists/builtin/collision', { token: pat, body: { enabled: false } })).status, 403);
  const setup = ok(await api('GET', '/patrol/checklists/setup', { token: admin }));
  const byId = (id) => setup.builtin.find((l) => l.id === id);
  for (const id of CL.ORIGINAL) assert.equal(byId(id).enabled, true, `${id} starts on`);
  assert.equal(byId('cardiac_arrest').enabled, true, 'the general patrol lists start on');
  assert.equal(byId('avalanche').enabled, false, 'avalanche starts off where the mountain does no avalanche work');
  assert.equal(byId('zipline_rescue').enabled, false, 'an attraction list starts off with no such attraction');
  assert.ok(byId('zipline_rescue').start_note && byId('head_spine').items.length === 8);
  assert.equal((await api('PUT', '/patrol/checklists/builtin/made_up', { token: admin, body: { enabled: false } })).status, 404);

  // the starting choice follows the mountain: avalanche work, and an attraction of the list's type
  ok(await api('PUT', '/patrol/ops-settings', { token: admin, body: { avalanche: true } }));
  await q("INSERT INTO attractions (tenant_id, name, type, status) VALUES (?, 'Eagle Zip', 'zipline', 'open')", [A.id]);
  let ids = (await lists(pat)).map((l) => l.id);
  assert.ok(ids.includes('avalanche') && ids.includes('zipline_rescue'), 'both start on now');
  assert.ok(!ids.includes('coaster_incident'), 'no coaster, no coaster list');

  // a case ticked while collision is on, then collision switched off
  const used = ok(await newCase(pat, { category: 'collision' }), 201).id;
  ok(await tick(pat, used, 'parties_identified'));
  ok(await api('PUT', '/patrol/checklists/builtin/collision', { token: admin, body: { enabled: false } }));
  const log = await audits(A.id, 'checklist_off');
  assert.equal(det(log[log.length - 1]).list, 'collision', 'switching is audited');
  ids = (await lists(pat)).map((l) => l.id);
  assert.ok(!ids.includes('collision'), 'not offered any more');
  const fresh = ok(await newCase(pat, { category: 'collision' }), 201).id;
  const refused = await tick(pat, fresh, 'witnesses_taken');
  assert.equal(refused.status, 409);
  assert.match(refused.text, /switched off/);
  // the case that already used it can still be finished or corrected
  ok(await tick(pat, used, 'witnesses_taken'));
  ok(await api('POST', `/patrol/incidents/${used}/checklist`, { token: pat, body: { key: 'parties_identified', done: false } }));
  const forCase = await lists(pat, used);
  assert.equal(forCase.find((l) => l.id === 'collision').off, true, 'offered for that case, marked off');
  assert.ok(!(await lists(pat, fresh)).some((l) => l.id === 'collision'));
  // another mountain is untouched, and cannot read this one's case
  assert.ok((await lists(B.pat)).some((l) => l.id === 'collision'));
  assert.ok(!(await lists(B.pat, used)).some((l) => l.id === 'collision' && l.off));
  // back on
  ok(await api('PUT', '/patrol/checklists/builtin/collision', { token: A.owner, body: { enabled: true } }));
  ok(await tick(pat, fresh, 'witnesses_taken'));
  // a patient list needs a patient, a case list must not have one
  assert.equal((await tick(pat, fresh, 'neuro_checked')).status, 400);
  const p = ok(await api('POST', `/patrol/incidents/${fresh}/patients`, { token: pat, body: { form: { head_strike: 'no' }, first_name: 'Ivy', last_name: 'Ice' } }), 201).id;
  assert.equal((await tick(pat, fresh, 'witnesses_taken', { patient_id: p })).status, 400);
  ok(await tick(pat, fresh, 'neuro_checked', { patient_id: p }));
});

// ---------------------------------------------------------------- a patrol's own lists
test('own lists: written, edited and archived by the patrol admin only, audited, with stable keys and ticks that keep their words', async () => {
  const body = { title: 'Race day crash', when: 'A racer crashed on the course.', scope: 'case', items: [{ label: 'Race jury told' }, { label: 'Course held' }, { label: 'Bib number recorded' }] };
  assert.equal((await api('POST', '/patrol/checklists/custom', { token: pat, body })).status, 403);
  assert.equal((await api('POST', '/patrol/checklists/custom', { token: admin, body: { ...body, items: [] } })).status, 400);
  assert.equal((await api('POST', '/patrol/checklists/custom', { token: admin, body: { ...body, attraction_type: 'spaceship' } })).status, 400);
  const made = ok(await api('POST', '/patrol/checklists/custom', { token: admin, body }), 201);
  assert.match(made.id, /^c\d+$/);
  assert.equal((await api('POST', '/patrol/checklists/custom', { token: admin, body })).status, 409, 'one title once');
  let mine = (await lists(pat)).find((l) => l.id === made.id);
  assert.equal(mine.source, 'custom');
  assert.deepEqual(mine.items.map((i) => i.label), ['Race jury told', 'Course held', 'Bib number recorded']);
  for (const i of mine.items) assert.match(i.key, new RegExp(`^${made.id}_\\d+$`));
  assert.ok(!(await lists(B.pat)).some((l) => l.id === made.id), 'only this mountain sees it');

  const c = ok(await newCase(pat, { summary: 'Racer down at gate 12' }), 201).id;
  const [jury, held, bib] = mine.items;
  ok(await tick(pat, c, jury.key));
  ok(await tick(pat, c, held.key));
  assert.equal((await tick(B.pat, c, jury.key)).status, 404, 'another mountain cannot tick it');

  // edit: new title, a reworded item, an item taken off, a new one, a new order
  ok(await api('PATCH', `/patrol/checklists/custom/${made.db_id}`, { token: admin, body: { title: 'Race crash', items: [{ id: bib.id, label: 'Bib recorded' }, { id: jury.id, label: 'Jury and timing told' }, { label: 'Video asked for' }] } }));
  assert.equal((await api('PATCH', `/patrol/checklists/custom/${made.db_id}`, { token: pat, body: { title: 'X' } })).status, 403);
  assert.equal((await api('PATCH', `/patrol/checklists/custom/${made.db_id}`, { token: admin, body: { scope: 'patient' } })).status, 409, 'in use: the scope stays');
  assert.equal((await api('PATCH', `/patrol/checklists/custom/${made.db_id}`, { token: admin, body: { items: [{ id: 999999, label: 'Not mine' }] } })).status, 400);
  mine = (await lists(pat)).find((l) => l.id === made.id);
  assert.equal(mine.title, 'Race crash');
  assert.deepEqual(mine.items.map((i) => i.label), ['Bib recorded', 'Jury and timing told', 'Video asked for']);
  assert.equal(mine.items[1].key, jury.key, 'a reworded item keeps its key');
  assert.equal((await tick(pat, c, held.key)).status, 409, 'an item taken off cannot be ticked again');
  // the ticks read as they were ticked
  const got = ok(await api('GET', `/patrol/incidents/${c}`, { token: pat })).checklist;
  const juryRow = got.find((r) => r.item_key === jury.key);
  assert.deepEqual([juryRow.list_id, juryRow.list_title, juryRow.item_label], [made.id, 'Race day crash', 'Race jury told']);
  assert.equal(got.find((r) => r.item_key === held.key).item_label, 'Course held', 'the removed item still reads on the case');
  ok(await tick(pat, c, bib.key));
  assert.equal(ok(await api('GET', `/patrol/incidents/${c}`, { token: pat })).checklist.find((r) => r.item_key === bib.key).item_label, 'Bib recorded', 'a new tick takes the new words');
  const upd = await audits(A.id, 'checklist_update');
  assert.deepEqual(det(upd[upd.length - 1]).items, { added: 1, reworded: 2, removed: 1 });

  // switched off: not offered, but the case that used it can still be finished
  ok(await api('PATCH', `/patrol/checklists/custom/${made.db_id}`, { token: admin, body: { enabled: false } }));
  assert.ok(!(await lists(pat)).some((l) => l.id === made.id));
  const other = ok(await newCase(pat), 201).id;
  assert.equal((await tick(pat, other, jury.key)).status, 409);
  ok(await api('PATCH', `/patrol/checklists/custom/${made.db_id}`, { token: admin, body: { enabled: true } }));

  // archived: never deleted, offered only where it was used, and it can come back
  assert.equal((await api('POST', `/patrol/checklists/custom/${made.db_id}/archive`, { token: pat })).status, 403);
  ok(await api('POST', `/patrol/checklists/custom/${made.db_id}/archive`, { token: admin }));
  assert.ok(!(await lists(pat)).some((l) => l.id === made.id));
  assert.equal((await tick(pat, other, jury.key)).status, 409);
  const onCase = (await lists(pat, c)).find((l) => l.id === made.id);
  assert.ok(onCase && onCase.off, 'the case that used it still gets it');
  ok(await api('POST', `/patrol/incidents/${c}/checklist`, { token: pat, body: { key: bib.key, done: false } }));
  assert.equal((await api('PATCH', `/patrol/checklists/custom/${made.db_id}`, { token: admin, body: { title: 'Again' } })).status, 409, 'bring it back first');
  const setup = ok(await api('GET', '/patrol/checklists/setup', { token: admin }));
  const arch = setup.custom.find((l) => l.id === made.id);
  assert.ok(arch.archived_at && arch.cases === 1);
  assert.equal(Number((await q('SELECT COUNT(*) AS n FROM patrol_checklists WHERE id = ?', [made.db_id]))[0].n), 1, 'still there');
  ok(await api('POST', `/patrol/checklists/custom/${made.db_id}/restore`, { token: admin }));
  assert.ok((await lists(pat)).some((l) => l.id === made.id));
  for (const a of ['checklist_create', 'checklist_update', 'checklist_archive', 'checklist_restore']) assert.ok((await audits(A.id, a)).length, `${a} is audited`);
  assert.equal((await api('POST', `/patrol/checklists/custom/${made.db_id}/archive`, { token: B.pat })).status, 403);

  // an attraction type makes it suggest itself there (the case screen reads attraction_types)
  ok(await api('PATCH', `/patrol/checklists/custom/${made.db_id}`, { token: admin, body: { attraction_type: 'coaster' } }));
  assert.deepEqual((await lists(pat)).find((l) => l.id === made.id).attraction_types, ['coaster']);
});

// ---------------------------------------------------------------- the attraction a case happened at
test('a case at an attraction carries its type, and the attraction lists come with it', async () => {
  await q("INSERT INTO attractions (tenant_id, name, type, status) VALUES (?, 'Rocket Coaster', 'coaster', 'open')", [A.id]);
  const [[att]] = await pool.query("SELECT id FROM attractions WHERE tenant_id = ? AND name = 'Rocket Coaster'", [A.id]);
  const c = ok(await newCase(pat, { location: 'Coaster, turn 4' }), 201).id;
  await q('UPDATE incidents SET attraction_id = ? WHERE id = ?', [att.id, c]);
  const got = ok(await api('GET', `/patrol/incidents/${c}`, { token: pat }));
  assert.equal(got.attraction_type, 'coaster');
  const l = (await lists(pat, c)).find((x) => x.id === 'coaster_incident');
  assert.ok(l, 'the coaster list is on now the mountain has a coaster');
  assert.deepEqual(l.attraction_types, ['coaster']);
  // an attraction of another mountain is never read
  await q("INSERT INTO attractions (tenant_id, name, type, status) VALUES (?, 'Their Rink', 'ice_rink', 'open')", [B.id]);
  const [[theirs]] = await pool.query("SELECT id FROM attractions WHERE tenant_id = ? AND name = 'Their Rink'", [B.id]);
  await q('UPDATE incidents SET attraction_id = ? WHERE id = ?', [theirs.id, c]);
  assert.equal(ok(await api('GET', `/patrol/incidents/${c}`, { token: pat })).attraction_type, null);
});

// ---------------------------------------------------------------- integrity: frozen versions, the claim file, old ticks
test('frozen versions and the claim file show ticks as they were, and a tick sent later keeps the time it was taken', async () => {
  const made = ok(await api('POST', '/patrol/checklists/custom', { token: admin, body: { title: 'Night skiing call', scope: 'case', items: [{ label: 'Lights checked on the run' }] } }), 201);
  const key = (await lists(pat)).find((l) => l.id === made.id).items[0].key;
  const c = ok(await newCase(pat, { category: 'collision', summary: 'Two skiers collided' }), 201).id;
  const p = ok(await api('POST', `/patrol/incidents/${c}/patients`, { token: pat, body: { form: { head_strike: 'no' }, first_name: 'Kay', last_name: 'Patient', chief_complaint: 'Sore wrist' } }), 201).id;
  ok(await tick(pat, c, key));
  // a tick taken with no signal 20 minutes ago, sent now from the phone's outbox
  const at = new Date(Date.now() - 20 * 60000);
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const P = Object.fromEntries(local.map((x) => [x.type, x.value]));
  ok(await tick(pat, c, 'parties_identified', { at: `${P.year}-${P.month}-${P.day}T${P.hour}:${P.minute}:${P.second}`, client_ref: 'abc123def456' }));
  ok(await tick(pat, c, 'parties_identified', { client_ref: 'abc123def456' })); // the same tick sent twice keeps one copy
  const [row] = await q('SELECT done_at, entered_at FROM incident_checklist WHERE incident_id = ? AND item_key = ?', [c, 'parties_identified']);
  const doneMs = Date.parse(`${row.done_at.replace(' ', 'T')}Z`);
  assert.ok(Math.abs(doneMs - at.getTime()) < 2000, `done_at is when it was ticked (${row.done_at})`);
  assert.ok(Date.parse(`${row.entered_at.replace(' ', 'T')}Z`) - doneMs > 15 * 60000, 'entered_at is when it arrived');
  // a tick saved before ticks kept their words
  const [[u]] = await pool.query('SELECT id FROM users WHERE tenant_id = ? ORDER BY id LIMIT 1', [A.id]);
  await q("INSERT INTO incident_checklist (tenant_id, incident_id, patient_id, item_key, done_by) VALUES (?, ?, 0, 'scene_noted', ?)", [A.id, c, u.id]);
  const live = ok(await api('GET', `/patrol/incidents/${c}`, { token: pat })).checklist;
  const legacy = live.find((r) => r.item_key === 'scene_noted');
  assert.deepEqual([legacy.list_id, legacy.list_title, legacy.item_label], ['collision', 'Collision', 'Scene noted: impact point, signage, closures, conditions']);

  // signed off and approved: the frozen copy holds the ticks
  ok(await api('POST', `/patrol/incidents/${c}/submit`, { token: pat }));
  ok(await api('POST', `/patrol/incidents/${c}/approve`, { token: A.owner }));
  // then the list is renamed and reworded, and archived
  const item = (await lists(pat)).find((l) => l.id === made.id).items[0];
  ok(await api('PATCH', `/patrol/checklists/custom/${made.db_id}`, { token: admin, body: { title: 'Evening call', items: [{ id: item.id, label: 'Run lighting checked' }] } }));
  ok(await api('POST', `/patrol/checklists/custom/${made.db_id}/archive`, { token: admin }));
  const versions = ok(await api('GET', `/patrol/incidents/${c}`, { token: pat })).versions;
  const approved = versions.filter((v) => v.kind === 'approved').pop();
  const frozen = ok(await api('GET', `/patrol/incidents/${c}/versions/${approved.id}`, { token: pat })).case.checklist;
  const ownTick = frozen.find((r) => r.item_key === key);
  assert.deepEqual([ownTick.list_title, ownTick.item_label], ['Night skiing call', 'Lights checked on the run']);
  assert.equal(frozen.find((r) => r.item_key === 'scene_noted').item_label, 'Scene noted: impact point, signage, closures, conditions');
  const cf = ok(await api('GET', `/patrol/incidents/${c}/claim-file`, { token: A.owner }));
  assert.equal(cf.basis, 'approved');
  const cfTick = cf.report.checklist.find((r) => r.item_key === key);
  assert.deepEqual([cfTick.list_title, cfTick.item_label], ['Night skiing call', 'Lights checked on the run']);
  assert.match(cfTick.done_local, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'the claim file reads the mountain clock');
  // a snapshot frozen before ticks kept their words gets the built-in words when read
  const [[v]] = await pool.query('SELECT snapshot FROM incident_versions WHERE id = ?', [approved.id]);
  const snap = JSON.parse(v.snapshot);
  snap.checklist = snap.checklist.map(({ item_key, patient_id, done_at, done_by }) => ({ item_key, patient_id, done_at, done_by }));
  await q('UPDATE incident_versions SET snapshot = ? WHERE id = ?', [JSON.stringify(snap), approved.id]);
  const old = ok(await api('GET', `/patrol/incidents/${c}/versions/${approved.id}`, { token: pat })).case.checklist;
  assert.equal(old.find((r) => r.item_key === 'parties_identified').item_label, 'Every person involved identified, or described if they left');
  assert.equal(old.find((r) => r.item_key === 'parties_identified').list_title, 'Collision');
  // approved: locked
  assert.equal((await tick(pat, c, 'witnesses_taken')).status, 409);
  assert.ok(p);
});
