'use strict';
// Guest help review fixes (fix/help-review, after 2026.11.16). Loaded by db/migrate.js, last. Safe to run twice, and on a
// 2026.11.12 or later database (help-guest adds dispatch_calls' guest columns first).
//
//   dispatch_calls.same_phone_of   a new request from a phone that asked for help in the last 2 minutes (a different
//                                  press, not a retry of the same one) is its own call, linked to the earlier one so
//                                  patrol sees "From the same phone as call 1109-03".
module.exports = ({ columnExists }) => [
  ['dispatch_calls.same_phone_of', (c) => columnExists(c, 'dispatch_calls', 'same_phone_of'),
    'ALTER TABLE dispatch_calls ADD COLUMN same_phone_of BIGINT UNSIGNED NULL'],
];
