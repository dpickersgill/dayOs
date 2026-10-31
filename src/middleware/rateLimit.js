'use strict';

/**
 * Fixed-window limiter, keyed by client address unless keyOf says otherwise.
 * The counts are shared by every server through lib/ratestore.js (MySQL, 2026.11.10), so a limit of 10 a minute stays
 * 10 a minute however many servers Cloud Run starts. Locally and in the tests they stay in this process's memory.
 *
 * Each limit has its own counts. Its name is `name` when given, otherwise where it is made in the code (file and line,
 * the same on every server running the same build), plus its window and maximum, so changing a limit starts it fresh.
 */
const path = require('node:path');
const { storeFor } = require('../lib/ratestore');

const ROOT = path.join(__dirname, '..', '..');

/** "src/app.js:218:19": the line that called rateLimit(), the same on every server running this build. */
function callSite() {
  const lines = String(new Error().stack || '').split('\n').slice(1);
  for (const line of lines) {
    const m = /\(?((?:[A-Za-z]:)?[^():]+):(\d+):(\d+)\)?\s*$/.exec(line.trim());
    if (!m || m[1] === __filename) continue;
    return `${path.relative(ROOT, m[1]).split(path.sep).join('/')}:${m[2]}:${m[3]}`;
  }
  return 'unknown';
}

/**
 * skipSuccessful: a request that ends well (an answer under 400) gives its count back, so only failures use up the
 * limit. For sign-in: a whole crew signing in from the mountain's one internet address at opening is never stopped,
 * while wrong passwords from that address still are.
 */
function rateLimit({ windowMs, max, message = 'Too many requests, slow down', keyOf = (req) => req.ip, name = null, skipSuccessful = false }) {
  const c = counter({ windowMs, max, name: name || callSite() });

  return async (req, res, next) => {
    try {
      const key = keyOf(req);
      const { over, retryAfter } = await c.hit(key);
      if (over) {
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ error: message });
      }
      const store = c.store;
      if (skipSuccessful) res.on('finish', () => { if (res.statusCode < 400) store.decrement(key).catch(() => {}); });
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * The count behind a limit, for code that decides itself when a request counts (the gates' failed sign-ins, 2026.11.10):
 * hit(key) counts one and says whether the key is over max, and for how many seconds.
 */
function counter({ windowMs, max, name = null }) {
  const store = storeFor(`${name || callSite()}|${windowMs}|${max}`);
  store.init({ windowMs });
  return {
    store,
    async hit(key) {
      const { totalHits, resetTime } = await store.increment(key);
      if (totalHits <= max) return { over: false, retryAfter: 0 };
      const reset = resetTime || (store.resetTimeOf ? await store.resetTimeOf(key) : undefined);
      return { over: true, retryAfter: reset ? Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000)) : Math.ceil(windowMs / 1000) };
    },
  };
}

module.exports = { rateLimit, counter, callSite };
