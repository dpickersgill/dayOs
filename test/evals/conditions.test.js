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

// ---------------------------------------------------------------- the 2026.11.15 review of the facts guard
const probe = () => {
  const f = { mountain: 'Demo Mountain', date: '2026-11-12', weekday: 'Thursday', status: 'open', day_set: true, opens: '09:00', closes: '16:00', day_note: null,
    lifts: [{ name: 'Summit Quad', status: 'wind_hold', word: 'Wind hold' }, { name: 'Bear', status: 'open', word: 'Open' }, { name: 'Lodge Carpet', status: 'closed', word: 'Closed' }],
    lifts_open: 1, lifts_total: 3, trails_open: 1, trails_total: 2, open_trails: ['Bear Run'], trail_names: ['Bear Run', 'Easy Street'], groomed: ['Bear Run'],
    new_snow_in: 4, new_snow_from: 'crew', base_in: 30, surface: null, weather: { temp_f: 22, wind_mph: 10, gust_mph: 25, sky: 'clear' }, events: [] };
  return { f, t: writer.template(f) };
};
const flags = (f, t, k, v) => writer.check({ ...t, [k]: v }, f);

test('review: a lift on hold or closed is never called open or running, and an open lift is never called closed', () => {
  const { f, t } = probe();
  assert.deepEqual(writer.check(t, f), [], 'the template passes');
  for (const bad of ['Summit Quad is open and spinning today.', 'Summit Quad opens at 9 AM.', 'Running: Bear, Summit Quad.', 'We are spinning Summit Quad.',
    'Bear and Summit Quad are open.', 'Lodge Carpet is running.', 'Lodge Carpet (open) for beginners.']) {
    assert.match(flags(f, t, 'note', bad).join(), /do not call it open or running/, bad);
  }
  for (const bad of ['Bear is closed today.', 'Bear is on hold.', 'Bear is not running yet.', 'Bear is down for now.']) {
    assert.match(flags(f, t, 'note', bad).join(), /Bear is open, so do not call it closed/, bad);
  }
  for (const good of ['Summit Quad is on wind hold, and Bear is open.', 'Summit Quad is on wind hold until the gusts drop.', 'Summit Quad (wind hold). Bear is spinning.',
    'Bear closes at 4 PM.', 'Summit Quad is not running yet.', 'Lodge Carpet is closed.', 'Bear Run is open.', 'Summit Quad and Lodge Carpet are not open.']) {
    assert.deepEqual(flags(f, t, 'note', good), [], good);
  }
});

test('review: the date is not a fact to count with, but the day written as a date is fine', () => {
  const { f, t } = probe();
  assert.match(flags(f, t, 'note', 'We got 12 inches overnight.').join(), /the number 12 is not in the facts/);
  assert.match(flags(f, t, 'note', 'Base is 2026 inches.').join(), /2026/);
  assert.match(flags(f, t, 'note', 'Lifts open at 16.').join(), /the number 16/, 'a 24-hour hour is not how guests read it');
  for (const good of ['Thursday, November 12: 4 in new.', 'Nov. 12th, 2026: 4 in new on a 30 in base.', 'Conditions for 11/12.', 'See you on the 12th.']) {
    assert.deepEqual(flags(f, t, 'note', good), [], good);
  }
  assert.match(flags(f, t, 'note', 'See you on November 13.').join(), /13/, 'another day keeps its numbers');
});

test('review: names match as whole words, and a made-up person, place or lift is refused', () => {
  const { f, t } = probe();
  assert.match(flags(f, t, 'note', 'Grizzly Bear Bowl is groomed.').join(), /"Grizzly Bear Bowl" is not a lift or trail/);
  assert.match(flags(f, t, 'note', 'We groomed Big Bear Bowl.').join(), /Big Bear Bowl/);
  assert.match(flags(f, t, 'snow_report', 'Patroller John Smith says hi.').join(), /"Patroller John Smith" is not a name in the facts/);
  assert.match(flags(f, t, 'email_body', 'Hi {first_name},\n\nAsk Maria at the lodge. See you on the hill.').join(), /Maria/);
  assert.match(flags(f, t, 'social', 'Head to Aspen Village after.').join(), /Aspen Village/);
  // The other way: the mountain's own name, weekdays, months, holidays, AM and PM, and ordinary words starting a sentence.
  for (const good of ['Good morning from Demo Mountain! Fresh corduroy on Bear Run this Thursday in November.', 'Groomers worked Bear Run overnight, and the groomers say it is soft.',
    'Expect clear skies. Bundle up: it is 22 degrees.', 'Happy Thanksgiving week! Open 9 AM to 4 PM.', 'Demo is spinning Bear at 9 AM.', 'Twenty-two degrees? No problem. See you Saturday.',
    'Summit Quad is on wind hold. We will update you.']) {
    assert.deepEqual(flags(f, t, 'snow_report', good), [], good);
  }
});

test('review: links and web addresses are refused, and the email subject is one line', () => {
  const { f, t } = probe();
  for (const bad of ['Free tickets at evil.example for everyone.', 'More at https://example.org/deal', 'Book at www.demo-tickets.com', 'Write to deals@demo.test', '[Book now](/shop)']) {
    assert.match(flags(f, t, 'note', bad).join(), /links and web addresses/, bad);
  }
  assert.deepEqual(flags(f, t, 'note', 'Open 9 AM to 4 PM. 4 in new.'), []);
  assert.match(flags(f, t, 'email_subject', 'Line one\nBcc: x@y.z').join(), /one line/);
  const d = writer.parseDraft(JSON.stringify({ ...t, email_subject: 'Demo Mountain today\r\nBcc: someone@example.com' }));
  assert.doesNotMatch(d.email_subject, /[\r\n]/);
  assert.equal(d.email_subject, 'Demo Mountain today Bcc: someone@example.com');
  const proposals = require('../../src/lib/proposals');
  const def = proposals.kindOf(writer.KIND);
  const e = proposals.applyEdits(def, { email_subject: 'x' }, { email_subject: 'Snow day\r\nBcc: a@b.c\nX-Other: 1' });
  assert.equal(e.payload.email_subject, 'Snow day Bcc: a@b.c X-Other: 1');
  assert.equal(proposals.applyEdits(def, {}, { email_body: 'Hi,\r\n\r\nBye' }).payload.email_body, 'Hi,\n\nBye', 'the body keeps its lines');
});
