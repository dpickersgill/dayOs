'use strict';
// The ski school, round 2, Track CORE: what to bring, in the confirmation email (a school setting; a lesson product's
// own description is used when the mountain leaves it blank). Loaded by db/migrate.js right after lessons2.
module.exports = ({ columnExists }) => [
  ['school_settings.what_to_bring', (c) => columnExists(c, 'school_settings', 'what_to_bring'), 'ALTER TABLE school_settings ADD COLUMN what_to_bring VARCHAR(500) NULL'],
];
