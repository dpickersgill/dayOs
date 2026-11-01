'use strict';

// Staging only (STAGE=staging). Every response is kept out of search engines, and with STAGING_GATE set, a shared
// password stands in front of the whole site: one sign-in per browser, remembered for 7 days (2026.11.11: was 30). Each
// browser gets its own pass (a random id, its end and a signature made with the password), so passes can be told apart
// and changing the password ends them all. Guesses are limited: STAGING_GATE_TRIES (10) tries from one address in 15
// minutes, counted across servers (lib/ratestore.js), then 429. The health checks, the
// version, Stripe's webhook and the daily job stay open so deploys, payments in test mode and jobs keep working.
const crypto = require('node:crypto');
const express = require('express');
const config = require('../config');

const COOKIE = 'dayos_staging';
const OPEN = [/^\/healthz$/, /^\/readyz$/, /^\/version$/, /^\/robots\.txt$/, /^\/api\/v1\/stripe\/webhook$/, /^\/api\/v1\/internal\/jobs\//];
const DAYS = 7;
const sig = (body) => crypto.createHmac('sha256', config.stagingSettings.gate).update(`dayos-staging:${body}`).digest('base64url');
/** A new pass for one browser: "<id>.<ends, ms>.<signature>". */
const newPass = () => { const body = `${crypto.randomBytes(12).toString('base64url')}.${Date.now() + DAYS * 86_400_000}`; return `${body}.${sig(body)}`; };
const passOk = (v) => {
  const parts = String(v || '').split('.');
  if (parts.length !== 3 || !(Number(parts[1]) > Date.now())) return false;
  return same(parts[2], sig(`${parts[0]}.${parts[1]}`));
};
const cookieOf = (req) => (String(req.get('cookie') || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === COOKIE) || [])[1] || '';
const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)[^\s]*$/.test(n) ? n : '/');

function page(next, wrong) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>Verdynt/OS staging</title><style>body{font-family:system-ui,sans-serif;background:#0e2632;color:#eaf3f7;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
form{background:#fff;color:#12303a;border-radius:14px;padding:28px;max-width:360px;width:100%;box-sizing:border-box}h1{margin:0 0 6px;font-size:1.4rem}p{margin:0 0 16px;color:#4b6570}
label{display:block;font-weight:700;margin-bottom:6px}input{width:100%;box-sizing:border-box;font:inherit;padding:10px 12px;border:1px solid #b5ccd9;border-radius:8px}
button{margin-top:14px;width:100%;font:inherit;font-weight:700;padding:11px;border:0;border-radius:8px;background:#1b5fc1;color:#fff;cursor:pointer}.bad{color:#8a1f17;font-weight:700}</style></head>
<body><form method="post" action="/__staging"><h1>Verdynt/OS staging</h1><p>The test copy of Verdynt/OS, for checking a release before it goes live. Payments are in test mode and email goes to the team.</p>
${wrong ? '<p class="bad">That password is not right.</p>' : ''}<label for="pw">Staging password</label><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
<input type="hidden" name="next" value="${String(next).replace(/[&"<>]/g, '')}"><button>Open staging</button></form></body></html>`;
}

function staging() {
  const router = express.Router();
  if (!config.staging) return router;
  router.use((_req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });
  router.get('/robots.txt', (_req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  if (!config.stagingSettings.gate) return router;
  const tries = require('./rateLimit').counter({ name: 'staging-gate', windowMs: 15 * 60_000, max: Number(process.env.STAGING_GATE_TRIES) || 10 });
  router.post('/__staging', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res, nextMw) => {
    try {
      const next = safeNext(req.body && req.body.next);
      const { over, retryAfter } = await tries.hit(req.ip);
      if (over) return res.status(429).set('Retry-After', String(retryAfter)).type('text/plain').send('Too many tries. Wait 15 minutes.');
      if (!same(String((req.body && req.body.password) || ''), config.stagingSettings.gate)) return res.status(401).type('html').send(page(next, true));
      tries.store.decrement(req.ip).catch(() => {}); // the right password does not use up a try
      res.cookie(COOKIE, newPass(), { httpOnly: true, secure: req.secure, sameSite: 'lax', maxAge: DAYS * 86_400_000, path: '/' });
      return res.redirect(303, next);
    } catch (err) { return nextMw(err); }
  });
  router.use((req, res, next) => {
    if (OPEN.some((r) => r.test(req.path)) || passOk(cookieOf(req))) return next();
    if (req.method === 'GET' && req.accepts(['html', 'json']) === 'html') return res.status(401).type('html').send(page(req.originalUrl, false));
    return res.status(401).json({ error: 'This is Verdynt/OS staging. Open it in a browser and enter the staging password first.' });
  });
  return router;
}

module.exports = { staging, COOKIE };
