'use strict';

// Addresses written in only one way (feat/auth-hardening). A %-escape of a letter, a digit or one of - . _ ~ is never
// needed (RFC 3986 calls these unreserved), and no part of the app sends one. Express decodes them before matching
// routes, so /incidents/%31 reaches the same route as /incidents/1, and any check that read the address as written could
// be walked around that way. Such an address is answered 404 before anything else looks at it.
// Capitals and a trailing slash still reach the same route (real clients do send those), so every check that reads the
// address itself compares it in lower case with the slash taken off, and the records check reads the matched route
// parameter instead (lib/patientaccess.js byParam).
const UNRESERVED_ESCAPE = /%(?:[46][1-9a-f]|[57][0-9a]|3[0-9]|2d|2e|5f|7e)/i;

function oneSpelling(req, res, next) {
  const raw = String(req.originalUrl || '').split('?')[0];
  if (UNRESERVED_ESCAPE.test(raw)) return res.status(404).json({ error: 'Not found' });
  return next();
}

/** The address as checks should read it: lower case, without a trailing slash. */
const normal = (p) => String(p || '').split('?')[0].toLowerCase().replace(/(.)\/+$/, '$1');

module.exports = { oneSpelling, normal, UNRESERVED_ESCAPE };
