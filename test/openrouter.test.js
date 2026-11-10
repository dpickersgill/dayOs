'use strict';

// The assistant through OpenRouter. The same Anthropic Messages request goes to OpenRouter's /api/v1/messages with a
// bearer key and OpenRouter's model names, told to use only the chosen companies and only ones that keep no data. The
// reply comes back in the same shape, so the assistant, recap writer and outreach drafts need nothing else. Patrol's
// story reader is never affected. Needs no database.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

/** A fresh copy of config with these environment settings, then the old ones back. */
function configWith(vars) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  delete require.cache[require.resolve('../src/config')];
  try { return require('../src/config'); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    delete require.cache[require.resolve('../src/config')];
  }
}
const clean = { ASSISTANT_PROVIDER: undefined, ASSISTANT_API_BASE: undefined, ANTHROPIC_API_BASE: undefined, OPENROUTER_PROVIDERS: undefined };

test('an OpenRouter key picks OpenRouter by itself; an Anthropic key stays on Anthropic', () => {
  const or = configWith({ ...clean, ASSISTANT_API_KEY: 'sk-or-v1-abcdefghijklmnopqrstuvwxyz' }).assistant;
  assert.equal(or.provider, 'openrouter');
  assert.equal(or.apiBase, 'https://openrouter.ai/api');
  assert.deepEqual(or.routing.only, ['anthropic'], 'Anthropic only unless told otherwise');
  const an = configWith({ ...clean, ASSISTANT_API_KEY: 'sk-ant-abcdefghijklmnopqrstuvwxyz' }).assistant;
  assert.equal(an.provider, 'anthropic');
  assert.equal(an.apiBase, 'https://api.anthropic.com');
  assert.equal(configWith({ ...clean, ASSISTANT_API_KEY: 'sk-ant-x', ASSISTANT_PROVIDER: 'openrouter' }).assistant.provider, 'openrouter');
  assert.equal(configWith({ ...clean, ASSISTANT_API_KEY: 'sk-or-x', ASSISTANT_PROVIDER: 'anthropic' }).assistant.provider, 'anthropic');
  assert.deepEqual(configWith({ ...clean, ASSISTANT_API_KEY: 'sk-or-x', OPENROUTER_PROVIDERS: 'any' }).assistant.routing.only, []);
  assert.deepEqual(configWith({ ...clean, ASSISTANT_API_KEY: 'sk-or-x', OPENROUTER_PROVIDERS: 'Anthropic, amazon-bedrock' }).assistant.routing.only, ['anthropic', 'amazon-bedrock']);
});

test('patrol\'s story reader keeps its own key and goes straight to Anthropic whatever the assistant uses', () => {
  const c = configWith({ ...clean, ASSISTANT_API_KEY: 'sk-or-v1-x', ASSISTANT_PROVIDER: 'openrouter', PATROL_AI: 'on', ANTHROPIC_API_KEY: 'sk-ant-baa' });
  assert.equal(c.patrolAi.key, 'sk-ant-baa');
  assert.equal(c.patrolAi.apiBase, 'https://api.anthropic.com');
});

test('model names: Anthropic names become OpenRouter names, names with a slash are kept', () => {
  const { routerModel } = require('../src/lib/assistant');
  assert.equal(routerModel('claude-haiku-5-5'), 'anthropic/claude-haiku-5.5');
  assert.equal(routerModel('claude-sonnet-5-5'), 'anthropic/claude-sonnet-5.5');
  assert.equal(routerModel('claude-opus-5'), 'anthropic/claude-opus-5');
  assert.equal(routerModel('openai/gpt-6-luna'), 'openai/gpt-6-luna');
});

test('a request through OpenRouter: bearer key, its model name, provider limits, the same reply shape', async () => {
  const seen = [];
  let status = 200; let reply = { stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'Hi.' }] };
  const fake = http.createServer((req, res) => {
    let raw = ''; req.on('data', (d) => { raw += d; });
    req.on('end', () => { seen.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) }); res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(reply)); });
  });
  await new Promise((r) => { fake.listen(0, r); });
  const config = require('../src/config');
  const saved = config.assistant;
  const A = require('../src/lib/assistant');
  try {
    config.assistant = { on: true, provider: 'openrouter', key: 'sk-or-v1-test', apiBase: `http://127.0.0.1:${fake.address().port}/api`, model: 'claude-haiku-5-5', dataModel: 'claude-sonnet-5-5', routing: { only: ['anthropic'] } };
    const out = await A.callModel({ model: 'claude-haiku-5-5', system: 'Be brief.', messages: [{ role: 'user', content: 'Hello' }], tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }] });
    assert.equal(out.content[0].text, 'Hi.');
    const s = seen.at(-1);
    assert.equal(s.url, '/api/v1/messages');
    assert.equal(s.headers.authorization, 'Bearer sk-or-v1-test');
    assert.equal(s.headers['x-api-key'], undefined, 'the key is never sent as an Anthropic key header');
    assert.equal(s.headers['x-title'], 'Verdynt/OS');
    assert.equal(s.body.model, 'anthropic/claude-haiku-5.5');
    assert.deepEqual(s.body.provider, { data_collection: 'deny', only: ['anthropic'] });
    assert.equal(s.body.tools[0].name, 't', 'tools pass through in the Anthropic shape');

    config.assistant = { ...config.assistant, routing: { only: [] } };
    await A.callModel({ model: 'openai/gpt-6-luna', system: 's', messages: [{ role: 'user', content: 'x' }] });
    assert.deepEqual(seen.at(-1).body.provider, { data_collection: 'deny' }, 'any provider, still none that keep data');
    assert.equal(seen.at(-1).body.model, 'openai/gpt-6-luna');

    // Straight to Anthropic is unchanged: x-api-key, Anthropic's model name, no provider block.
    config.assistant = { on: true, key: 'sk-ant-test', apiBase: `http://127.0.0.1:${fake.address().port}`, model: 'claude-haiku-5-5', dataModel: 'claude-sonnet-5-5' };
    await A.callModel({ model: 'claude-haiku-5-5', system: 's', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(seen.at(-1).url, '/v1/messages');
    assert.equal(seen.at(-1).headers['x-api-key'], 'sk-ant-test');
    assert.equal(seen.at(-1).body.model, 'claude-haiku-5-5');
    assert.equal(seen.at(-1).body.provider, undefined);
  } finally {
    config.assistant = saved;
    await new Promise((r) => fake.close(r));
  }
});

test('OpenRouter errors are explained in OpenRouter\'s words for the console', async () => {
  const fake = http.createServer((req, res) => {
    req.resume(); req.on('end', () => { res.statusCode = 402; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: { message: 'Insufficient credits' } })); });
  });
  await new Promise((r) => { fake.listen(0, r); });
  const config = require('../src/config');
  const saved = config.assistant;
  const jobs = require('../src/lib/jobs');
  const savedLog = jobs.logFailure;
  jobs.logFailure = () => {}; // no database here
  const A = require('../src/lib/assistant');
  try {
    config.assistant = { on: true, provider: 'openrouter', key: 'sk-or-v1-test', apiBase: `http://127.0.0.1:${fake.address().port}/api`, model: 'claude-haiku-5-5', dataModel: 'claude-sonnet-5-5', routing: { only: ['anthropic'] } };
    await assert.rejects(A.callModel({ model: 'claude-haiku-5-5', system: 's', messages: [{ role: 'user', content: 'x' }] }), (e) => /OpenRouter account is out of credit/.test(e.reason));
    assert.equal(A.lastFailure().provider, 'OpenRouter');
  } finally {
    config.assistant = saved;
    jobs.logFailure = savedLog;
    await new Promise((r) => fake.close(r));
  }
});
