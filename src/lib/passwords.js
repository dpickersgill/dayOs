'use strict';

// What makes an acceptable password (NIST SP 800-63B): length, not character rules. At least 12 characters, up to 128,
// any characters at all (spaces and passphrases welcome), never one seen in a data breach, and never built from the
// person's own login, the mountain's name or the product's (DAY/OS, runmyresort, and the old name SummitOps). Nobody is made to change a password on a schedule; only after
// a reset or a suspected leak.
const { z } = require('./util');
const { bad } = require('./errors');
const { refuseBreached } = require('./pwned');

const MIN = 12;
const MAX = 128;
const schema = z.string().min(MIN, `Use at least ${MIN} characters. A short phrase is easiest to remember.`).max(MAX);

const fold = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Throws a plain-language 400 when the password is weak for this person; also checks known breaches. */
async function refuseWeak(pw, { username, email, tenantSlug, tenantName } = {}) {
  const p = String(pw || '');
  if (p.length < MIN) throw bad(`Use at least ${MIN} characters. A short phrase is easiest to remember.`);
  if (p.length > MAX) throw bad(`Use at most ${MAX} characters`);
  const f = fold(p);
  if (/^(.)\1+$/.test(p) || new Set(p).size < 4) throw bad('That password repeats too few characters. Use a phrase of a few words.');
  const words = [username, email && String(email).split('@')[0], tenantSlug, tenantName, 'summitops', 'dayos', 'runmyresort']
    .map(fold).filter((w) => w.length >= 4);
  for (const w of words) {
    if (f.includes(w)) throw bad('Do not use your username, your email, the mountain\'s name or "DAY/OS" in your password');
  }
  await refuseBreached(p);
}

module.exports = { MIN, MAX, schema, refuseWeak };
