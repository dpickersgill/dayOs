'use strict';

// Staging only (STAGE=staging). Every response is kept out of search engines, and with STAGING_GATE set, a shared
// password stands in front of the whole site: one sign-in per browser, remembered for 30 days. The health checks, the
// version, Stripe's webhook and the daily job stay open so deploys, payments in test mode and jobs keep working.
const crypto = require('node:crypto');
const express = require('express');
const config = require('../config');

const COOKIE = 'dayos_staging';
const OPEN = [/^\/healthz$/, /^\/readyz$/, /^\/version$/, /^\/robots\.txt$/, /^\/api\/v1\/stripe\/webhook$/, /^\/api\/v1\/internal\/jobs\//];
const pass = () => crypto.createHmac('sha256', config.stagingSettings.gate).update('dayos-staging-ok').digest('hex');
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
  router.post('/__staging', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
    const next = safeNext(req.body && req.body.next);
    if (!same(String((req.body && req.body.password) || ''), config.stagingSettings.gate)) return res.status(401).type('html').send(page(next, true));
    res.cookie(COOKIE, pass(), { httpOnly: true, secure: req.secure, sameSite: 'lax', maxAge: 30 * 86_400_000, path: '/' });
    return res.redirect(303, next);
  });
  router.use((req, res, next) => {
    if (OPEN.some((r) => r.test(req.path)) || same(cookieOf(req), pass())) return next();
    if (req.method === 'GET' && req.accepts(['html', 'json']) === 'html') return res.status(401).type('html').send(page(req.originalUrl, false));
    return res.status(401).json({ error: 'This is Verdynt/OS staging. Open it in a browser and enter the staging password first.' });
  });
  return router;
}

module.exports = { staging, COOKIE };
