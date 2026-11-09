'use strict';
// Guest help review fixes (fix/help-review, after 2026.11.16). Loaded by db/migrate.js, last. Safe to run twice, and on a
// 2026.11.12 or later database (help-guest adds dispatch_calls' guest columns first).
//
//   dispatch_calls.same_phone_of   a new request from a phone that asked for help in the last 2 minutes (a different
//                                  press, not a retry of the same one) is its own call, linked to the earlier one so
//                                  patrol sees "From the same phone as call 1109-03".
//   dispatch_alert_state               per mountain: requests waiting for the "no one on duty" summary (one a minute at
//                                  most), when the last went, and the patrol phone texts this hour (capped).
//   dispatch_calls.flood_pending_at on a flood's first call: a flood alert held by the 30-second gap, waiting to go. The
//                                  next dispatch request at that mountain or the 5-minute guests job sends it, once.
module.exports = ({ tableExists, columnExists }) => [
  ['dispatch_calls.same_phone_of', (c) => columnExists(c, 'dispatch_calls', 'same_phone_of'),
    'ALTER TABLE dispatch_calls ADD COLUMN same_phone_of BIGINT UNSIGNED NULL'],
  ['dispatch_alert_state', (c) => tableExists(c, 'dispatch_alert_state'), `CREATE TABLE dispatch_alert_state (
    tenant_id         BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    nobody_pending    INT NOT NULL DEFAULT 0,
    nobody_taken      INT NOT NULL DEFAULT 0,
    nobody_last_call  BIGINT UNSIGNED NULL,
    nobody_last_at    DATETIME NULL,
    texts_hour_start  DATETIME NULL,
    texts_in_hour     INT NOT NULL DEFAULT 0,
    updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_dalert_pending (nobody_pending)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['dispatch_calls.flood_pending_at', (c) => columnExists(c, 'dispatch_calls', 'flood_pending_at'),
    'ALTER TABLE dispatch_calls ADD COLUMN flood_pending_at DATETIME NULL, ADD KEY ix_dcall_flood_pending (flood_pending_at)'],
];
