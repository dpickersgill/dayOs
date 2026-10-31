'use strict';
// Signing in, 2026.11.10: a session whose last tab closed is marked closing. It ends unless it is used again within two
// minutes (a reload uses it again at once), so a closed browser no longer stays listed for an hour. Loaded by db/migrate.js.
module.exports = ({ columnExists }) => [
  ['user_sessions.closing_at', (c) => columnExists(c, 'user_sessions', 'closing_at'),
    'ALTER TABLE user_sessions ADD COLUMN closing_at DATETIME NULL'],
];
