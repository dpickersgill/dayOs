'use strict';

/**
 * Minimal fixed-window limiter keyed by client IP.
 * It is per-instance memory, so on Cloud Run with several instances the effective limit is
 * (limit x instances). Replace with a shared store (Redis, Cloud Armor) before heavy production use.
 */
function rateLimit({ windowMs, max, message = 'Too many requests, slow down' }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  timer.unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    let entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    return next();
  };
}

module.exports = { rateLimit };
