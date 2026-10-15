'use strict';

// The last thing the migration adds (an index, or a column). /readyz checks it exists, so a version running against a
// database that was not migrated for it shows up straight away instead of as errors later. Update it when db/migrate.js
// gains a step.
module.exports = { LATEST: { table: 'time_entries', column: 'patrol_shift_id' } };
