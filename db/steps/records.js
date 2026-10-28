'use strict';
// Parts of a patrol record that used to be removed outright (responders, collision parties, rental gear on a case) are
// marked entered in error instead, with a reason, who and when, like clinical entries (src/routes/patrol.js voidCaseRow).
// Each entry: [name, (conn) => Promise<boolean> already done, ddl]. Loaded by db/migrate.js.
const voidCols = (table, columnExists) => [`${table}.voided_at`, (c) => columnExists(c, table, 'voided_at'),
  `ALTER TABLE ${table} ADD COLUMN voided_at DATETIME NULL, ADD COLUMN void_reason VARCHAR(255) NULL, ADD COLUMN voided_by BIGINT UNSIGNED NULL`];
module.exports = ({ columnExists }) => [
  voidCols('incident_responders', columnExists),
  voidCols('incident_parties', columnExists),
  voidCols('incident_rentals', columnExists),
];
