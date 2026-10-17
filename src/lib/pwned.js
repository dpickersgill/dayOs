'use strict';

// Refuses passwords that are already in known data breaches, using the Pwned Passwords range API with k-anonymity:
// only the first 5 characters of the password's SHA-1 leave the server, never the password or its full hash.
// If the service cannot be reached in 2.5 seconds the password is allowed (a slow outside service must not stop
// anyone choosing a password); set PWNED_CHECK=off to skip the check altogether.
const crypto = require('node:crypto');
const { bad } = require('./errors');

const settings = { apiBase: process.env.PWNED_API_BASE || 'https://api.pwnedpasswords.com', timeoutMs: 2500 };

/** How many times the password appears in known breaches, or null when the check could not be made. */
async function timesSeen(password) {
  if (process.env.PWNED_CHECK === 'off') return null;
  const sha = crypto.createHash('sha1').update(String(password)).digest('hex').toUpperCase();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), settings.timeoutMs);
  try {
    const res = await fetch(`${settings.apiBase}/range/${sha.slice(0, 5)}`, { headers: { 'Add-Padding': 'true', 'User-Agent': 'DAY/OS' }, signal: ctrl.signal });
    if (!res.ok) return null;
    const rest = sha.slice(5);
    for (const line of (await res.text()).split('\n')) {
      const [suffix, count] = line.trim().split(':');
      if (suffix === rest) return Number(count) || 0;
    }
    return 0;
  } catch (_) { return null; } finally { clearTimeout(timer); }
}

/** Throws a plain-language 400 when the password is known from breaches. */
async function refuseBreached(password) {
  const n = await timesSeen(password);
  if (n && n > 0) throw bad('That password has appeared in data breaches elsewhere, so it is easy to guess. Choose a different one.');
}

module.exports = { timesSeen, refuseBreached, settings };
