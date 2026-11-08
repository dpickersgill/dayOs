'use strict';
// Review of 2026.11.12 (fix/review-security). Loaded by db/migrate.js. Additive and safe to run twice.
//   dispatch_responders_removed  a responder taken off a call that has a case: who sent them and when (kept so the
//                                tie to that case still counts by the link rule, lib/patientaccess.js), and who took
//                                them off and when.
module.exports = ({ tableExists }) => [
  ['dispatch_responders_removed', (c) => tableExists(c, 'dispatch_responders_removed'),
    `CREATE TABLE IF NOT EXISTS dispatch_responders_removed (
      id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      tenant_id  BIGINT UNSIGNED NOT NULL,
      call_id    BIGINT UNSIGNED NOT NULL,
      staff_id   BIGINT UNSIGNED NOT NULL,
      added_by   BIGINT UNSIGNED NULL,
      added_at   DATETIME NULL,
      removed_by BIGINT UNSIGNED NULL,
      removed_at DATETIME NOT NULL,
      KEY ix_dresp_removed (tenant_id, call_id),
      CONSTRAINT fk_dresp_removed_call FOREIGN KEY (tenant_id, call_id) REFERENCES dispatch_calls(tenant_id, id)
    ) ENGINE=InnoDB`],
];
