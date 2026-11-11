'use strict';

// Test helpers for the municipal edition (muni release 1). A feature workstream's test makes its municipality with
// createMuniTenant(base) and signs people in with the returned login():
//
//   const { createMuniTenant } = require('./helpers/muni');
//   const M = await createMuniTenant(base, { modules: { solidwaste: true } });   // the core apps, plus Trash and recycling
//   const crew = await M.addLogin('staff');                                         // a Crew login: { id, username, token }
//   await fetch(`${base}/api/v1/requests/streets`, { headers: { authorization: `Bearer ${M.token}` } });
//
// It goes through the platform console's real route (POST /api/v1/platform/tenants with the platform key, so the test
// needs process.env.BOOTSTRAP_KEY set before src/app is loaded, and PLATFORM_KEY_SIGNIN=on as npm test sets it).
const crypto = require('crypto');

const PASSWORD = 'correct-horse-battery';

async function call(base, method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}

/**
 * A new municipality with its owner signed in. opts: slug, name, modules ({ key: true|false } on top of the municipal
 * defaults), key (the platform key, default process.env.BOOTSTRAP_KEY), timezone.
 * Returns { id, slug, name, token, ownerEmail, password, login(username), addLogin(role, extra) }.
 */
async function createMuniTenant(base, opts = {}) {
  const suffix = crypto.randomBytes(4).toString('hex');
  const slug = opts.slug || `muni-${suffix}`;
  const name = opts.name || `Test Borough ${suffix}`;
  const ownerEmail = opts.ownerEmail || `manager@${slug}.test`;
  const key = opts.key || process.env.BOOTSTRAP_KEY;
  const made = await call(base, 'POST', '/platform/tenants', {
    headers: { 'x-platform-key': key },
    body: { slug, name, org_type: 'municipality', timezone: opts.timezone || 'America/New_York', billing: 'comped', modules: opts.modules || {},
      owner: { email: ownerEmail, password: PASSWORD, first_name: 'Pat', last_name: 'Manager' } },
  });
  if (made.status !== 201) throw new Error(`createMuniTenant: ${made.status} ${JSON.stringify(made.body)}`);
  const login = async (who) => {
    const r = await call(base, 'POST', '/auth/login', { body: { tenant: slug, login: who, password: PASSWORD } });
    if (r.status !== 200 || !r.body.token) throw new Error(`login ${who}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.token;
  };
  const token = await login(ownerEmail);
  const out = { id: Number(made.body.id), slug, name, token, ownerEmail, password: PASSWORD, login };
  /** A login with this role ('manager', 'staff' = Crew, 'counter' = Front desk): { id, username, token }. */
  out.addLogin = async (role, extra = {}) => {
    const username = extra.username || `${role}-${crypto.randomBytes(3).toString('hex')}`;
    const r = await call(base, 'POST', '/users', { token, body: { username, password: PASSWORD, role, ...(role === 'manager' ? { email: `${username}@${slug}.test` } : {}), ...extra } });
    if (r.status !== 201) throw new Error(`addLogin ${role}: ${r.status} ${JSON.stringify(r.body)}`);
    return { id: r.body.id, username: r.body.username, token: await login(r.body.username) };
  };
  return out;
}

module.exports = { createMuniTenant, PASSWORD };
