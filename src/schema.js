'use strict';

// The last thing the migration adds (an index, a column or a table's key). /readyz checks it exists, so a version running
// against a database that was not migrated for it shows up straight away instead of as errors later. Update it when the
// migration gains a step.
module.exports = { LATEST: { table: 'incidents', index: 'uq_incidents_client_ref' } };
