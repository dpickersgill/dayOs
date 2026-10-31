'use strict';
// 2026.11.11 patrol fixes after the Oct 31 reviews. Loaded by db/migrate.js. Additive and safe to run twice.
//   patrol_sweep_marks.resolution/resolved_*  how a person or hazard found on the sweep was dealt with, or why it was
//                                             entered in error. A find is never overwritten or deleted (PATROL-3).
//   patrol_sweep_mark_log                     every mark, change, undo and resolution, append-only.
module.exports = ({ tableExists, columnExists }) => [
  ['patrol_sweep_marks.resolution', (c) => columnExists(c, 'patrol_sweep_marks', 'resolution'),
    "ALTER TABLE patrol_sweep_marks ADD COLUMN resolution VARCHAR(255) NULL, ADD COLUMN resolved_kind ENUM('dealt_with','error') NULL, ADD COLUMN resolved_at DATETIME NULL, ADD COLUMN resolved_by BIGINT UNSIGNED NULL"],
  ['patrol_sweep_mark_log', (c) => tableExists(c, 'patrol_sweep_mark_log'), `CREATE TABLE patrol_sweep_mark_log (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id  BIGINT UNSIGNED NOT NULL,
    run_id     BIGINT UNSIGNED NOT NULL,
    item_id    BIGINT UNSIGNED NOT NULL,
    mark_id    BIGINT UNSIGNED NULL,
    action     ENUM('mark','undo','resolve','error') NOT NULL,
    flag       ENUM('none','person','hazard','rope','other') NOT NULL,
    note       VARCHAR(255) NULL,
    reason     VARCHAR(255) NULL,
    at         DATETIME NOT NULL,
    by_user    BIGINT UNSIGNED NOT NULL,
    by_staff   BIGINT UNSIGNED NULL,
    KEY ix_psmlog_run (tenant_id, run_id, item_id),
    CONSTRAINT fk_psmlog_run FOREIGN KEY (tenant_id, run_id) REFERENCES patrol_sweep_runs(tenant_id, id)
  ) ENGINE=InnoDB`],
];
