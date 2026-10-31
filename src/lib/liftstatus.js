'use strict';

// One word for a lift's status, the same on every screen and in every feed (2026.11.10). Keep in step with
// public/js/liftstatus.js (test/slim.test.js checks they agree).
const LIFT_WORDS = { open: 'Open', hold: 'On hold', wind_hold: 'Wind hold', closed: 'Closed' };
const CANNOT_OPEN = 'Cannot open';

/** The word for a lift: its status, or Cannot open when today's inspection failed and it is not open. */
function liftWord(status, check = null) {
  if (check === 'fail' && status !== 'open') return CANNOT_OPEN;
  return LIFT_WORDS[status] || 'Not set';
}

module.exports = { LIFT_WORDS, CANNOT_OPEN, liftWord };
