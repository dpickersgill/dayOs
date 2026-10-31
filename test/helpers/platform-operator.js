'use strict';

// A named console operator with two-step sign-in, for tests that read one mountain in the console (2026.11.10: the
// platform key alone no longer reads a mountain's details). Returns a function that calls the console as that operator.
const crypto = require('crypto');
const totp = require('../../src/lib/totp');

async function operatorConsole(base, key) {
  const post = async (path, body, headers = {}) => {
    const r = await fetch(`${base}/api/v1/platform${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(json)}`);
    return json;
  };
  const email = `op-${crypto.randomBytes(5).toString('hex')}@operators.test`; const password = 'a-long-operator-password';
  await post('/operators', { email, name: 'Test Operator', password }, { 'x-platform-key': key });
  const first = await post('/login', { email, password });
  const { session } = await post('/login/setup', { setup_token: first.setup_token, code: totp.hotp(first.secret, totp.stepAt(Date.now())) });
  return async (method, path, body) => {
    const r = await fetch(`${base}/api/v1/platform${path}`, { method, headers: { 'content-type': 'application/json', 'x-platform-session': session }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch (_) { json = text; }
    return { status: r.status, body: json };
  };
}

module.exports = { operatorConsole };
