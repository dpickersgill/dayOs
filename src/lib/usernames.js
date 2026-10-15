'use strict';

// Usernames: a way to sign in without an email (volunteer patrollers, seasonal staff). One per login, unique at each
// mountain, case does not matter (kept in lowercase). 3 to 40 letters, numbers, dots, dashes and underscores, starting
// with a letter or number. No @, so the sign-in box can tell a username from an email.
const PATTERN = /^[a-z0-9][a-z0-9._-]{2,39}$/;
const RULE = 'Use 3 to 40 letters, numbers, dots, dashes or underscores, starting with a letter or number';

const clean = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const normalize = (s) => String(s || '').trim().toLowerCase();

/** "mellis" from Mia Ellis; else the email before the @; else "user" plus the id. A number is added if taken. */
function suggestUsername({ first_name: first, last_name: last, email, id }, taken = new Set()) {
  let base = clean(first).slice(0, 1) + clean(last);
  if (base.length < 3) base = String(email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[^a-z0-9]+/, '');
  if (base.length < 3) base = `user${id || ''}`.padEnd(4, '0');
  base = base.slice(0, 36);
  let name = base; let n = 2;
  while (taken.has(name)) { name = `${base}${n}`; n += 1; }
  return name;
}

module.exports = { PATTERN, RULE, normalize, suggestUsername };
