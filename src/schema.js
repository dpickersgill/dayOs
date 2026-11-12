'use strict';

// The last thing the migration adds (an index, a column or a table's key). /readyz checks it exists, so a version running
// against a database that was not migrated for it shows up straight away instead of as errors later. Update it when the
// migration gains a step.
// 2026.11.16: the last step that leaves something to check is patrol_help_lines.help_number made nullable (the step after
// it only moves values and drops two duplicate columns); the "release" row in schema_steps covers a run cut off after it.
// fix/help-review: dispatch_calls.flood_pending_at (a held flood alert), after dispatch_alert_state.
// 2026.11.19 (municipal edition): the last table the municipal steps make is building_documents (db/steps/muni-buildings.js,
// after the foundation, assets, requests, bulk pickup and street notices steps); the step after it only rewords a plan.
// 2026.11.20: the last step that leaves something to check is oncall_rotations.department_id (db/steps/m2-release.js,
// after the polish, money, crew and utilities steps); the step after it only moves typed department names to it.
// 2026.11.21: the last step that leaves something to check is user_nav.bar (db/steps/nav-pins.js); the step after it
// (db/steps/nav-counts.js) only removes forecast rows written for municipalities.
module.exports = { LATEST: { table: 'user_nav', column: 'bar' } };
