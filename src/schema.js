'use strict';

// The last thing the migration adds (here, an index). /readyz checks it exists, so a version running against a database
// that was not migrated for it shows up straight away instead of as errors later. Update it when db/migrate.js gains a step.
module.exports = { LATEST: { table: 'pm_log', index: 'uq_pm_log_wo' } };
