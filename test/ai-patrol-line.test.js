'use strict';

// The patrol line for AI release 1 (2026.11.15): patient care records stay out of AI completely. AI may see only counts
// of patrol cases by area and day, from the one aggregate query in the morning brief (briefdata.js patrolCounts).
//
// This scans every file the AI features are made of for the names of patrol and patient care tables. The only patrol
// case table any of them may name is `incidents`, and only inside patrolCounts. Three patrol tables that hold no patient
// and no case are allowed by name, each in the file and for the reason given: the patrol roster (who gets the patrol
// brief), patrol shifts (how many shifts are covered) and phone alert subscriptions (made with patrol; a device, never a case). Nothing else: no incident_* table, no patient, care, dispatch,
// injury or follow-up table, and no patrol code required. The guest help release adds the places patrol maps (mountain_places,
// lib/places.js): they place callers for dispatch, so they stay out of AI too.
// (test/proposals.test.js, test/evals/brief.test.js and test/evals/conditions.test.js prove the same at run time.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** Every patrol and patient care table, from the schema files and every step. */
function patrolTables() {
  const db = path.join(ROOT, 'db');
  const names = new Set();
  for (const f of ['patrol.sql', 'patrolops.sql']) for (const m of read(`db/${f}`).matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+`?(\w+)/gi)) names.add(m[1]);
  const all = [read('db/schema.sql'), read('db/migrate.js'), ...fs.readdirSync(path.join(db, 'steps')).map((f) => read(`db/steps/${f}`))].join('\n');
  for (const m of all.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+`?(\w+)/gi)) if (/^(incident|patrol|patient|dispatch|injury|staff_injur|followup|care_|case_|mountain_places)/.test(m[1])) names.add(m[1]);
  names.delete('IF'); names.delete('if');
  return [...names];
}

// The AI release's files: the brief, the prepared-actions layer, the conditions writer and the forecast data.
const FILES = ['src/lib/brief.js', 'src/lib/briefdata.js', 'src/lib/briefwrite.js', 'src/lib/proposals.js', 'src/lib/conditionswriter.js',
  'src/lib/conditionsnote.js', 'src/lib/snapshots.js', 'src/routes/brief.js', 'src/routes/ai.js'];

// Patrol tables that hold no patient and no case, allowed by name in one file each.
const ALLOWED = {
  'src/lib/brief.js': { patrol_members: 'the roster level decides who gets the patrol brief', push_subscriptions: 'phone alerts for the brief (made with patrol, holds a device, never a case)' },
  'src/routes/brief.js': { push_subscriptions: 'phone alerts for the brief (made with patrol, holds a device, never a case)' },
  'src/lib/briefdata.js': { patrol_shifts: 'how many patrol shifts are on the schedule and covered' },
  'src/lib/snapshots.js': { patrol_shifts: 'staffing counts and hours by department' },
};

const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

test('the AI files name no patrol or patient table, except the brief\'s one aggregate count of cases', () => {
  const tables = patrolTables();
  assert.ok(tables.includes('incidents') && tables.includes('incident_patients') && tables.length > 15, `found ${tables.length} patrol tables`);
  // help/guest (Nov 9): a guest's messages with dispatch and their phone's positions are patrol and dispatch data too.
  for (const t of ['dispatch_calls', 'dispatch_messages', 'dispatch_positions', 'mountain_places']) assert.ok(tables.includes(t), `${t} is on the patrol line`);
  // help/sms: Text HELP's tables are patrol and dispatch data too, and are checked like the rest.
  for (const t of ['patrol_help_lines', 'dispatch_sms_threads', 'dispatch_sms_optouts', 'dispatch_sms_log']) assert.ok(tables.includes(t), `${t} is a patrol table`);
  // fix/help-review: the held alerts' state (counts and a call id, no words) is dispatch data too.
  assert.ok(tables.includes('dispatch_alert_state'), 'dispatch_alert_state is a patrol table');
  for (const f of FILES) {
    let src = code(read(f));
    if (f === 'src/lib/briefdata.js') {
      // The one place a case table may be named: patrolCounts, one SELECT of COUNT(*) grouped by area.
      const start = src.indexOf('async function patrolCounts');
      const end = src.indexOf('\n}\n', start);
      assert.ok(start > 0 && end > start, 'patrolCounts is there');
      const fn = src.slice(start, end);
      assert.equal((fn.match(/SELECT/g) || []).length, 1, 'one query');
      assert.match(fn, /SELECT COALESCE\(t\.name, l\.name, 'Other places'\) AS area, COUNT\(\*\) AS n FROM incidents i/);
      assert.match(fn, /GROUP BY area/);
      assert.doesNotMatch(fn, /\bi\.(?!tenant_id|trail_id|lift_id|occurred_at)\w+/, 'only the place, the day and the mountain are read from a case');
      src = src.slice(0, start) + src.slice(end);
    }
    for (const t of tables) {
      if (ALLOWED[f] && ALLOWED[f][t]) continue;
      assert.ok(!new RegExp(`\\b${t}\\b`).test(src), `${f} names the patrol table ${t}`);
    }
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) assert.doesNotMatch(m[1], /patrol|patient|incident|care|scrub|injur|dispatch|nsaar|places|staffhelp/i, `${f} requires ${m[1]}`);
  }
});

test('the allowed patrol tables hold no patient: the roster and shifts are read for levels and counts only', () => {
  const brief = code(read('src/lib/brief.js'));
  for (const m of brief.matchAll(/\bpm\.(\w+)/g)) assert.ok(['level', 'access_level', 'tenant_id', 'staff_id'].includes(m[1]), `brief.js reads patrol_members.${m[1]}`);
  for (const f of ['src/lib/briefdata.js', 'src/lib/snapshots.js']) {
    const src = code(read(f));
    for (const m of src.matchAll(/FROM patrol_shifts[^`"]*/g)) assert.doesNotMatch(m[0], /\b(note|notes|name|person|patient)\b/i, `${f}: ${m[0]}`);
  }
});

test('a patrol case\'s words never reach a brief, a draft or a snapshot: the run-time checks are in place', () => {
  // The run-time proofs live beside each feature; this keeps them from being dropped in a merge.
  const brief = read('test/evals/brief.test.js');
  assert.match(brief, /patrol busy day: yesterday.{1,2}s cases as counts by area from one query, and nothing else from patrol/);
  assert.match(brief, /the model never sees/);
  const prop = read('test/proposals.test.js');
  assert.match(prop, /patient records: the proposals layer and the conditions writer never require patrol code or query patrol tables/);
  assert.match(prop, /the facts the writer gathers hold no patrol data, even on a day with a patrol case/);
  const snaps = read('test/snapshots.test.js');
  assert.match(snaps, /no snapshot holds a person.s name, email, phone or id/);
  assert.match(read('test/evals/conditions.test.js'), /patient\|incident\|injur/);
});

test('guest help requests never reach AI: no AI or assistant file names a dispatch table or loads the guest help code', () => {
  // help/guest (Nov 9): what a guest tapped, typed or sent to dispatch, their pass hint and where their phone was are
  // dispatch data. The brief, the drafts and the guest and staff assistant never read them.
  const files = [...FILES, 'src/lib/assistant.js', 'src/lib/assistanttools.js', 'src/routes/assistant.js'];
  // The guest help release's tables (2026.11.16): dispatch's, the places patrol mapped and the Text HELP numbers.
  const dispatch = patrolTables().filter((t) => /^dispatch|^mountain_places$|^patrol_help_lines$/.test(t));
  for (const t of ['dispatch_messages', 'dispatch_positions', 'mountain_places', 'patrol_help_lines', 'dispatch_sms_threads', 'dispatch_sms_optouts', 'dispatch_sms_log']) assert.ok(dispatch.includes(t), `${t} is checked`);
  assert.ok(dispatch.length >= 5, dispatch.join(', '));
  for (const f of files) {
    const src = code(read(f));
    for (const t of dispatch) assert.ok(!new RegExp(`\\b${t}\\b`).test(src), `${f} names ${t}`);
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) assert.doesNotMatch(m[1], /guestmsg|guesthelp|places|dispatch|sms/i, `${f} requires ${m[1]}`);
    assert.doesNotMatch(src, /last_scan_hint|guest_token|place_text/, `${f} reads a guest help column`);
  }
});

test('help requests by text (help/sms) never reach AI: no AI file, nor the guest or staff assistant, reads them', () => {
  const more = ['src/lib/assistant.js', 'src/lib/assistanttools.js', 'src/routes/assistant.js'].filter((f) => fs.existsSync(path.join(ROOT, f)));
  for (const f of [...FILES, ...more]) {
    const src = code(read(f));
    for (const t of ['patrol_help_lines', 'dispatch_sms_threads', 'dispatch_sms_optouts', 'dispatch_sms_log', 'dispatch_messages']) assert.ok(!new RegExp(`\\b${t}\\b`).test(src), `${f} names ${t}`);
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) assert.doesNotMatch(m[1], /helpline|helpsms|guestmsg/, `${f} requires ${m[1]}`);
  }
  // And the Text HELP files call no AI.
  for (const f of ['src/lib/helpline.js', 'src/routes/helpsms.js']) {
    for (const m of code(read(f)).matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) assert.doesNotMatch(m[1], /assistant|brief|proposals|conditions|storyfill|anthropic/i, `${f} requires ${m[1]}`);
  }
});
