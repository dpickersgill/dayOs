#!/usr/bin/env node
'use strict';

// The morning brief's evaluations against the real model (opt-in). The same 8 mountain days as the brief evaluations in the tests,
// written by the model named in ASSISTANT_MODEL (the small one), then checked the way a good brief must be:
//   the assistant's text was kept (every number checked out against the facts), three summary lines, at most three
//   actions each linking a screen the role can open, nothing from a patrol case beyond counts, no em dashes.
// It writes made-up mountains into the database it is pointed at, so use a test database:
//
//   ASSISTANT_API_KEY=sk-... DB_NAME=aib_test node scripts/ai-evals-brief.js
//
// It refuses a database whose name does not say test, eval or dev unless given --any-db. Prints PASS or FAIL per check
// and exits 1 when anything failed. The tests (npm test) run the same fixtures with a fake model and never a real key.
const http = require('http');

// scripts/ai-evals.js loads this file too (with the other features) and calls runAll(); run alone, it runs main().
const dbAllowed = () => /test|eval|dev/i.test(process.env.DB_NAME || '') || process.argv.includes('--any-db');
const REFUSED = () => `Refusing database "${process.env.DB_NAME || ''}": it writes made-up mountains. Use a test database, or pass --any-db.`;

const KIND = { powderSaturday: 'ops', windDay: 'ops', rainDay: 'ops', slowTuesday: 'ops', openingDay: 'ops', understaffedSchool: 'school', failedCheck: 'patrol', patrolBusyDay: 'patrol' };

// Runs every fixture and returns { pass, fail } (counted per check). Leaves the database pool open for the caller.
async function runAll() {
  const modules = require('../src/lib/modules');
  const W = require('../src/lib/briefwrite');
  const F = require('./brief-eval-fixtures');
  const { pool } = require('../src/db');
  // The fixtures' forecasts come from a stand-in weather service on this machine (only the model is real).
  const wx = new Map();
  const weather = http.createServer((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams; const w = wx.get(Number(q.get('latitude')).toFixed(3)); const day = q.get('start_date');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(w ? { daily: { time: [day], temperature_2m_max: [w.high], temperature_2m_min: [w.low], snowfall_sum: [w.snow], precipitation_sum: [w.precip], wind_speed_10m_max: [w.wind], wind_gusts_10m_max: [w.gust], weather_code: [w.code] } } : { daily: { time: [] } }));
  });
  await new Promise((r) => { weather.listen(0, r); });
  process.env.WEATHER = 'on';
  process.env.WEATHER_URL = `http://127.0.0.1:${weather.address().port}`;
  F.setup({ pool, wx, modules, base: null, api: null, ok: null });

  let failed = 0; let passed = 0;
  const check = (name, okay, detail = '') => { console.log(`${okay ? 'PASS' : 'FAIL'}  ${name}${!okay && detail ? `  (${detail})` : ''}`); if (okay) passed += 1; else failed += 1; };
  for (const [fixture, kind] of Object.entries(KIND)) {
    const m = await F.ALL[fixture]();
    const data = await F.facts(m, kind);
    const w = await W.write(data, { tenantId: m.id, kind });
    const words = JSON.stringify(w.body);
    console.log(`\n${fixture} (${kind} brief): ${w.source}${w.reason ? `, ${w.reason}` : ''}`);
    check(`${fixture}: the assistant's brief was kept (every number is in the facts)`, w.source === 'ai', w.reason || '');
    check(`${fixture}: three summary lines`, w.body.summary.length === 3);
    const allowed = new Set(data.screens.map((s) => s.href));
    check(`${fixture}: at most 3 actions, each to a screen the role can open`, w.body.actions.length <= 3 && w.body.actions.every((a) => allowed.has(a.href)));
    check(`${fixture}: no em dashes`, !/[—–]/.test(words));
    check(`${fixture}: nothing from a patrol case beyond counts`, F.PATROL_SECRETS.every((x) => !words.includes(x)));
    const lines = [...w.body.summary, ...w.body.sections.flatMap((x) => [x.title, ...x.lines]), ...w.body.actions.map((x) => x.text)];
    check(`${fixture}: never tells anyone to open a lift or that one is safe to run`, !lines.some((l) => W.goAheadIn(l, W.liftNamesOf(data))));
    check(`${fixture}: names only lifts, trails, areas and features in the facts, and no person`, !W.unknownNamesIn(w.body, data).length, W.unknownNamesIn(w.body, data).join(', '));
    const wh = data.wind_holds;
    if (wh && wh.caveat && (wh.lifts_over_limit.length || wh.lifts_near_limit.length)) check(`${fixture}: the wind line is under the wind section`, w.body.sections.some((x) => /wind|weather/i.test(x.title) && x.lines.includes(wh.caveat)));
    if (w.source === 'ai') console.log(w.body.summary.map((l) => `      ${l}`).join('\n'));
  }
  weather.close();
  return { pass: passed, fail: failed };
}

async function main() {
  if (!process.env.ASSISTANT_API_KEY) { console.log('Set ASSISTANT_API_KEY to run the brief evaluations against the real model. Nothing was run.'); process.exit(0); }
  if (!dbAllowed()) { console.error(REFUSED()); process.exit(2); }
  const { fail } = await runAll();
  await require('../src/db').pool.end();
  console.log(`\n${fail ? `${fail} check${fail === 1 ? '' : 's'} failed` : 'Every check passed'}.`);
  process.exit(fail ? 1 : 0);
}

module.exports = { feature: 'Morning brief', runAll, dbAllowed, REFUSED };
if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
