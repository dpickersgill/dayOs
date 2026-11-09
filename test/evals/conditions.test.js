'use strict';

// Evaluations for the conditions writer (AI release 1). Six realistic mornings (scripts/ai-evals-conditions.js): a
// powder day, a wind hold, rain, early season with one lift, a closed day and a holiday. With a stand-in model these check
// our side: the facts sent, the voice examples masked, the facts guard (a second try, then the template), the template on
// its own, and the label. The same fixtures run against the real model with scripts/ai-evals.js (opt in).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const config = require('../../src/config');
const A = require('../../src/lib/assistant');
const writer = require('../../src/lib/conditionswriter');
const { FIXTURES, checks, run } = require('../../scripts/ai-evals-conditions');

let fake; const calls = []; let replies = [];
const reply = (obj) => ({ stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 }, content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] });
const call = ({ system, messages }) => A.callModel({ model: config.assistant.model, system, messages });

test.before(async () => {
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      calls.push(body);
      const next = replies.length ? replies.shift() : reply('{}');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(typeof next === 'function' ? next(body) : next));
    });
  });
  await new Promise((r) => { fake.listen(0, r); });
  config.assistant = { on: true, key: 'sk-eval', apiBase: `http://127.0.0.1:${fake.address().port}`, model: 'claude-haiku-5-5', dataModel: 'claude-sonnet-5-5' };
});
test.after(() => new Promise((r) => fake.close(r)));

test('there are six fixtures, one for each kind of morning', () => {
  assert.deepEqual(FIXTURES.map((f) => f.key), ['powder', 'wind', 'rain', 'early', 'closed', 'holiday']);
});

for (const fx of FIXTURES) {
  test(`${fx.title}: the template (no AI) passes every check`, async () => {
    const out = await run(fx, null);
    assert.equal(out.by, 'template'); assert.equal(out.reason, 'no_ai');
    assert.deepEqual(checks(fx, out), [], JSON.stringify(out.draft, null, 1));
  });

  test(`${fx.title}: the model is given exactly the day's facts, and a draft that keeps to them is used`, async () => {
    // A stand-in that writes from the facts it was sent: the template made from them is a draft that keeps to them.
    replies = [(body) => { const sent = JSON.parse(body.messages[0].content.replace(/^[^{]*/, '')); assert.equal(sent.mountain, fx.facts.mountain); return reply(writer.template(fx.facts)); }];
    const out = await run(fx, call);
    const sent = JSON.parse(calls.at(-1).messages[0].content.replace(/^[^{]*/, ''));
    assert.equal(sent.new_snow_inches, fx.facts.new_snow_in);
    assert.equal(sent.base_inches, fx.facts.base_in);
    assert.equal(sent.lifts_open, fx.facts.lifts_open);
    assert.equal(sent.trails_open, fx.facts.trails_open);
    assert.equal(sent.lifts.length, fx.facts.lifts.length);
    assert.doesNotMatch(JSON.stringify(sent), /patient|incident|injur/i);
    assert.equal(out.by, 'assistant'); assert.equal(out.tries, 1);
    assert.deepEqual(checks(fx, out), []);
  });

  test(`${fx.title}: an invented number is caught, tried once more, then the template is used`, async () => {
    const bad = { ...writer.template(fx.facts), social: 'Biggest dump of the year: 99 inches!' };
    replies = [reply(bad), reply({ ...bad, note: 'Upper Goat Glades is open.' })];
    const n = calls.length;
    const out = await run(fx, call);
    assert.equal(calls.length, n + 2, 'one retry, no more');
    assert.match(calls.at(-1).messages.at(-1).content, /the number 99 is not in the facts/);
    assert.equal(out.by, 'template'); assert.equal(out.reason, 'facts');
    assert.ok(out.problems.some((p) => /Upper Goat Glades/.test(p)));
    assert.deepEqual(checks(fx, out), []);
  });
}

test('the guard: spelled-out numbers, decimals and names with numbers in them', () => {
  const f = FIXTURES.find((x) => x.key === 'powder').facts;
  const t = writer.template(f);
  assert.deepEqual(writer.check({ ...t, social: 'Fourteen inches overnight!' }, f), []);
  assert.match(writer.check({ ...t, social: 'Twenty inches overnight!' }, f).join(), /"Twenty"/);
  assert.match(writer.check({ ...t, note: '14.5 in new.' }, f).join(), /14\.5/);
  const g = { ...f, lifts: [...f.lifts, { name: 'Chair 7', status: 'open', word: 'Open' }] };
  assert.deepEqual(writer.check({ ...writer.template(g), note: 'Chair 7 is open.' }, g), [], 'a number inside a known name is not a claim');
  assert.match(writer.check({ ...t, note: 'The Summit Six is open.' }, f).join(), /Summit Six/);
  assert.match(writer.check({ ...t, social: 'x'.repeat(281) }, f).join(), /characters/);
});

test('the mountain\'s voice: at most five examples, clipped, numbers hidden', () => {
  const v = writer.voiceOf(['14 inches! Go go go.', 'b', 'c', 'd', 'e', 'f', `${'long '.repeat(200)}end`]);
  assert.equal(v.length, 5);
  assert.equal(v[0], 'N inches! Go go go.');
  const p = writer.prompt(FIXTURES[0].facts, ['Base is 48 in and 14 new.', `${'word '.repeat(400)}`]);
  assert.match(p.system, /Base is N in and N new\./);
  assert.ok(p.system.length < 4000, 'kept small');
});

test('closed day and wind hold: a draft that calls a held lift open, or a closed day open, fails the eval checks', () => {
  const wind = FIXTURES.find((x) => x.key === 'wind');
  assert.ok(checks(wind, { draft: { ...writer.template(wind.facts), note: 'Summit Quad is open today.' } }).length);
  const closed = FIXTURES.find((x) => x.key === 'closed');
  assert.ok(checks(closed, { draft: { ...writer.template(closed.facts), social: 'Open today 9 to 4!' } }).length);
});
