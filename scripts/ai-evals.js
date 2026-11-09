#!/usr/bin/env node
'use strict';

// Runs the AI features' evaluation fixtures against the real model and prints pass and fail. Opt in: it needs
// ASSISTANT_API_KEY (and uses ASSISTANT_MODEL, as the app does). It spends a little money, so it is never part of npm
// test; the same fixtures run there against a stand-in model (the evals folder of the tests).
//
//   ASSISTANT_API_KEY=sk-... node scripts/ai-evals.js              every feature
//   ASSISTANT_API_KEY=sk-... node scripts/ai-evals.js conditions   one feature (scripts/ai-evals-conditions.js)
//
// Each scripts/ai-evals-<feature>.js exports { feature, FIXTURES, run(fixture, call), checks(fixture, output) }.
// A draft that fell back to the template counts as a fail here: the real model should keep to the facts first time.
// No database is needed: the fixtures hold the facts, and nothing is logged against a mountain.
const fs = require('fs');
const path = require('path');

if (!process.env.ASSISTANT_API_KEY) {
  console.log('Set ASSISTANT_API_KEY to run the AI evaluations against the real model. Nothing was run.');
  process.exit(0);
}
const config = require('../src/config');
const A = require('../src/lib/assistant');

const dir = __dirname;
const only = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => /^ai-evals-[a-z0-9-]+\.js$/.test(f) && (!only || f === `ai-evals-${only}.js`));
if (!files.length) { console.log(`No fixtures${only ? ` for "${only}"` : ''} (scripts/ai-evals-<feature>.js).`); process.exit(1); }

const call = ({ system, messages }) => A.callModel({ model: config.assistant.model, system, messages });

(async () => {
  let pass = 0; let fail = 0;
  for (const f of files) {
    const mod = require(path.join(dir, f));
    console.log(`\n${mod.feature} (${config.assistant.model})`);
    for (const fx of mod.FIXTURES) {
      const started = Date.now();
      let problems;
      try {
        const out = await mod.run(fx, call);
        problems = mod.checks(fx, out);
        if (out.by === 'template') problems.unshift(`fell back to the template (${out.reason}${out.problems ? `: ${out.problems.join('; ')}` : ''})`);
      } catch (err) { problems = [`error: ${err.message}`]; }
      const ms = Date.now() - started;
      if (problems.length) { fail += 1; console.log(`  FAIL ${fx.title} (${ms} ms)\n${problems.map((p) => `       - ${p}`).join('\n')}`); } else { pass += 1; console.log(`  pass ${fx.title} (${ms} ms)`); }
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
