'use strict';

// Passkeys (WebAuthn): a sign-in that lives on a person's phone or computer, unlocked with a fingerprint, face or the
// device's own PIN. It cannot be phished (the browser only offers it to this site), reused or guessed, and the server
// keeps only a public key. Used for signing in, as the second step, and for the second check before sensitive actions.
//
// The site a passkey belongs to is the address it was made on, or WEBAUTHN_RP_ID (for example runmyresort.com, so one
// passkey works on app.runmyresort.com and any other address under it).
const W = require('@simplewebauthn/server');
const { pool, rows, one } = require('../db');
const challenges = require('./challenges');
const { bad, forbidden } = require('./errors');

const utcNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

function rp(req) {
  const host = String(req.get('host') || '');
  const id = process.env.WEBAUTHN_RP_ID || req.hostname;
  const origins = String(process.env.WEBAUTHN_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean);
  return { id, name: 'DAY/OS', origin: origins.length ? origins : `${req.protocol}://${host}` };
}

// Which table: the mountains' logins, or the console's operators.
const KIND = {
  user: { table: 'user_passkeys', owner: 'user_id' },
  operator: { table: 'platform_operator_passkeys', owner: 'operator_id' },
};

async function listFor(kind, ownerId) {
  const k = KIND[kind];
  return rows(pool, `SELECT id, credential_id, transports, name, created_at, last_used_at FROM ${k.table} WHERE ${k.owner} = ? ORDER BY created_at`, [ownerId]);
}

/** Options for making a new passkey. userName/displayName are what the phone shows in its list of passkeys. */
async function registrationOptions(req, { kind, ownerId, tenantId = null, userName, displayName }) {
  const r = rp(req);
  const existing = await listFor(kind, ownerId);
  const options = await W.generateRegistrationOptions({
    rpName: r.name, rpID: r.id, userName, userDisplayName: displayName,
    userID: new TextEncoder().encode(`${kind}:${tenantId || 0}:${ownerId}`),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: c.transports ? c.transports.split(',') : undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  const handle = await challenges.put(`${kind}_register`, options.challenge, { tenantId, userId: kind === 'user' ? ownerId : null, operatorId: kind === 'operator' ? ownerId : null });
  return { handle, options };
}

/** Checks the new passkey and keeps it. Returns its id. */
async function register(req, { kind, ownerId, tenantId = null, handle, response, name }) {
  const ch = await challenges.take(`${kind}_register`, handle);
  const mine = ch && (kind === 'user' ? Number(ch.user_id) === Number(ownerId) : Number(ch.operator_id) === Number(ownerId));
  if (!mine) throw bad('That took too long. Try adding the passkey again.');
  const r = rp(req);
  let v;
  try {
    v = await W.verifyRegistrationResponse({ response, expectedChallenge: ch.challenge, expectedOrigin: r.origin, expectedRPID: r.id, requireUserVerification: true });
  } catch (e) { throw bad(`The passkey could not be checked: ${e.message}`); }
  if (!v.verified || !v.registrationInfo) throw bad('The passkey could not be checked');
  const { credential, credentialBackedUp } = v.registrationInfo;
  const k = KIND[kind];
  const label = String(name || '').trim().slice(0, 60) || 'Passkey';
  try {
    const cols = kind === 'user' ? '(tenant_id, user_id, credential_id, public_key, sign_count, transports, backed_up, name, created_at)' : '(operator_id, credential_id, public_key, sign_count, transports, name, created_at)';
    const vals = kind === 'user'
      ? [tenantId, ownerId, credential.id, Buffer.from(credential.publicKey), credential.counter || 0, (response.response && response.response.transports || []).join(',') || null, credentialBackedUp ? 1 : 0, label, utcNow()]
      : [ownerId, credential.id, Buffer.from(credential.publicKey), credential.counter || 0, (response.response && response.response.transports || []).join(',') || null, label, utcNow()];
    const [ins] = await pool.query(`INSERT INTO ${k.table} ${cols} VALUES (${vals.map(() => '?').join(', ')})`, vals);
    return ins.insertId;
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw bad('That passkey is already added');
    throw e;
  }
}

/**
 * Options for using a passkey. With ownerId, only that person's passkeys are offered (second step, second check);
 * without, the phone offers whichever passkeys it holds for this site (signing in without typing a name).
 */
async function authenticationOptions(req, { kind, purpose, ownerId = null, tenantId = null }) {
  const r = rp(req);
  const allow = ownerId ? (await listFor(kind, ownerId)).map((c) => ({ id: c.credential_id, transports: c.transports ? c.transports.split(',') : undefined })) : undefined;
  if (ownerId && !allow.length) throw bad('There is no passkey on this login yet');
  const options = await W.generateAuthenticationOptions({ rpID: r.id, userVerification: 'required', allowCredentials: allow });
  const handle = await challenges.put(`${kind}_${purpose}`, options.challenge, { tenantId, userId: kind === 'user' ? ownerId : null, operatorId: kind === 'operator' ? ownerId : null });
  return { handle, options };
}

/**
 * Checks a passkey answer. Returns the stored passkey row ({ id, user_id or operator_id, tenant_id }). With ownerId set
 * the passkey must be that person's; with tenantId set it must belong to that mountain.
 */
async function authenticate(req, { kind, purpose, handle, response, ownerId = null, tenantId = null }) {
  const ch = await challenges.take(`${kind}_${purpose}`, handle);
  if (!ch) throw forbidden('That took too long. Try the passkey again.');
  const k = KIND[kind];
  const cred = response && typeof response.id === 'string' ? await one(pool, `SELECT * FROM ${k.table} WHERE credential_id = ?`, [response.id]) : null;
  if (!cred) throw forbidden('That passkey is not known here. Sign in with your password, then add it again in Account.');
  const owner = Number(cred[k.owner]);
  if (ownerId && owner !== Number(ownerId)) throw forbidden('That passkey belongs to someone else');
  if (ch.user_id && kind === 'user' && Number(ch.user_id) !== owner) throw forbidden('That passkey belongs to someone else');
  if (ch.operator_id && kind === 'operator' && Number(ch.operator_id) !== owner) throw forbidden('That passkey belongs to someone else');
  if (tenantId && Number(cred.tenant_id) !== Number(tenantId)) throw forbidden('That passkey is for another mountain');
  const r = rp(req);
  let v;
  try {
    v = await W.verifyAuthenticationResponse({
      response, expectedChallenge: ch.challenge, expectedOrigin: r.origin, expectedRPID: r.id, requireUserVerification: true,
      credential: { id: cred.credential_id, publicKey: new Uint8Array(cred.public_key), counter: Number(cred.sign_count), transports: cred.transports ? cred.transports.split(',') : undefined },
    });
  } catch (e) { throw forbidden(`The passkey could not be checked: ${e.message}`); }
  if (!v.verified) throw forbidden('The passkey could not be checked');
  await pool.query(`UPDATE ${k.table} SET sign_count = ?, last_used_at = UTC_TIMESTAMP() WHERE id = ?`, [v.authenticationInfo.newCounter || 0, cred.id]);
  return cred;
}

async function count(kind, ownerId) {
  const k = KIND[kind];
  const [[r]] = await pool.query(`SELECT COUNT(*) AS n FROM ${k.table} WHERE ${k.owner} = ?`, [ownerId]);
  return Number(r.n);
}

module.exports = { rp, listFor, registrationOptions, register, authenticationOptions, authenticate, count };
