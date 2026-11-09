'use strict';

// The last thing the migration adds (an index, a column or a table's key). /readyz checks it exists, so a version running
// against a database that was not migrated for it shows up straight away instead of as errors later. Update it when the
// migration gains a step.
// 2026.11.16: the last step that leaves something to check is patrol_help_lines.help_number made nullable (the step after
// it only moves values and drops two duplicate columns); the "release" row in schema_steps covers a run cut off after it.
// fix/help-review: dispatch_calls.flood_pending_at (a held flood alert), after dispatch_alert_state.
// help/shared: help_shared_log.message_sid, the last table of the shared Text HELP number's step.
module.exports = { LATEST: { table: 'help_shared_log', column: 'message_sid' } };
