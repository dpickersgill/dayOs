'use strict';
// 2026.11.11 sign-in and access fixes. Loaded by db/migrate.js. Additive and safe to run twice.
//   users.device_key_epoch     goes up when every session of a login ends (password change or reset, Sign out
//                              everywhere): the key that seals offline patient entries on a phone changes with it.
//   users.patrol_removed_at    when the login's person was taken off the patrol roster: a patrol login whose person was
//                              removed has no patrol access until they are put back on the roster.
//   platform_sessions_ended    console sessions ended by signing out (the hash of the session's id, and when the session
//                              would have run out anyway, so the daily job can drop old rows).

module.exports = ({ columnExists, tableExists }) => [
  ['users.device_key_epoch', (c) => columnExists(c, 'users', 'device_key_epoch'), 'ALTER TABLE users ADD COLUMN device_key_epoch INT NOT NULL DEFAULT 0'],
  ['users.patrol_removed_at', (c) => columnExists(c, 'users', 'patrol_removed_at'), 'ALTER TABLE users ADD COLUMN patrol_removed_at DATETIME NULL'],
  ['platform_sessions_ended', (c) => tableExists(c, 'platform_sessions_ended'), `CREATE TABLE platform_sessions_ended (
    id_hash CHAR(64) NOT NULL PRIMARY KEY,
    ends_at DATETIME NOT NULL,
    KEY ix_ends (ends_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],
];
