'use strict';
// The confirmation a family gets when a lesson is booked (at the counter, online, from a waitlist, a moved date or an
// accepted private): when and where, what to bring, the family's link (check in, change the date) and how to cancel.
// Track CORE implements it. Everyone who books calls it after the booking commits; it never throws.

/** Sends (or re-sends) the confirmation for one booking. base: the site's base URL (lib/baseurl). Returns { ok, error? }. */
async function sendConfirmation(_db, _tenantId, _bookingId, _base, _opts = {}) { return { ok: false, error: 'Not built yet' }; }

module.exports = { sendConfirmation };
