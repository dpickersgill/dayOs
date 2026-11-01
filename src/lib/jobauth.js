'use strict';
// Who may call /api/v1/internal/jobs/* (2026.11.11). Cloud Scheduler signs each call with a Google ID token (OIDC) for
// the summitops-jobs service account (scripts/jobs-oidc.sh). The app checks the token with Google's public keys:
// signed by Google, issued by accounts.google.com, for this service's address (JOBS_OIDC_AUDIENCES), for the jobs
// account (JOBS_OIDC_EMAIL), and not expired. Nothing secret is stored in Cloud Scheduler any more.
//
// The old x-jobs-key header still works only while OIDC is not set up (no JOBS_OIDC_EMAIL), so jobs keep running
// between this release and jobs-oidc.sh. Once OIDC is set up the header is refused, unless JOBS_KEY_FALLBACK=on.
//
// Google's keys are fetched from JOBS_OIDC_CERTS_URL (Google's address by default; tests point it at a local server)
// and kept for as long as Google says (Cache-Control max-age), at most a day.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { AppError } = require('./errors');

const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
let cache = { url: null, keys: null, until: 0 };

const list = (v) => String(v || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const settings = () => ({
  email: String(process.env.JOBS_OIDC_EMAIL || '').trim().toLowerCase(),
  audiences: list(process.env.JOBS_OIDC_AUDIENCES),
  certsUrl: process.env.JOBS_OIDC_CERTS_URL || GOOGLE_CERTS,
  key: process.env.JOBS_KEY || '',
  fallback: process.env.JOBS_KEY_FALLBACK === 'on',
});

async function keys(url, force = false) {
  if (!force && cache.url === url && cache.keys && Date.now() < cache.until) return cache.keys;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`certs ${res.status}`);
    const body = await res.json();
    const out = new Map();
    for (const k of body.keys || []) {
      if (k.kty === 'RSA' && k.kid) out.set(k.kid, crypto.createPublicKey({ key: k, format: 'jwk' }));
    }
    const age = Number((/max-age=(\d+)/.exec(res.headers.get('cache-control') || '') || [])[1]) || 3600;
    cache = { url, keys: out, until: Date.now() + Math.min(age, 86400) * 1000 };
    return out;
  } finally { clearTimeout(t); }
}

/** Resolves the token's claims when it is a good Google ID token for the jobs account; throws otherwise. */
async function verifyGoogleToken(token, s = settings()) {
  const head = jwt.decode(token, { complete: true });
  if (!head || head.header.alg !== 'RS256' || !head.header.kid) throw new Error('not a Google ID token');
  let pub = (await keys(s.certsUrl)).get(head.header.kid);
  if (!pub) pub = (await keys(s.certsUrl, true)).get(head.header.kid); // Google rotated its keys
  if (!pub) throw new Error('unknown signing key');
  if (!s.audiences.length) throw new Error('JOBS_OIDC_AUDIENCES is not set');
  const claims = jwt.verify(token, pub, { algorithms: ['RS256'], issuer: ISSUERS, audience: s.audiences, clockTolerance: 30 });
  if (String(claims.email || '').toLowerCase() !== s.email || claims.email_verified !== true) throw new Error('not the jobs account');
  return claims;
}

const keyMatches = (given, key) => {
  const a = Buffer.from(String(given || '')); const b = Buffer.from(key);
  return Boolean(key) && a.length === b.length && crypto.timingSafeEqual(a, b);
};

/** Express middleware for the job routes. */
async function jobAuth(req, _res, next) {
  const s = settings();
  const bearer = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  if (s.email && bearer) {
    try { await verifyGoogleToken(bearer[1], s); return next(); } catch (e) {
      console.warn(JSON.stringify({ severity: 'WARNING', job_auth: 'refused', reason: e.message }));
      return next(new AppError(401, 'Not allowed'));
    }
  }
  if ((!s.email || s.fallback) && keyMatches(req.get('x-jobs-key'), s.key)) return next();
  return next(new AppError(401, 'Not allowed'));
}

module.exports = { jobAuth, verifyGoogleToken, _reset: () => { cache = { url: null, keys: null, until: 0 }; } };
