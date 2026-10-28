'use strict';
// Running attractions day to day: each attraction's own opening checks, the daily opening inspection, and the downtime
// log. Additive and safe to run twice. Each entry: [name, (conn) => Promise<boolean> already done, ddl].
// Loaded by db/migrate.js after steps/attractions.js (which made the attractions table).
module.exports = ({ tableExists, columnExists }) => [
  // The attraction's own opening checks as JSON [{ key, label }]; NULL uses its type's defaults (src/lib/attractions.js).
  ['attractions.checklist', (c) => columnExists(c, 'attractions', 'checklist'),
    'ALTER TABLE attractions ADD COLUMN checklist MEDIUMTEXT NULL'],
  // One opening inspection per attraction per day. A failed one can be followed by a new attempt after the fix, so the
  // day keeps every attempt. `items` is JSON: [{ key, label, result: pass|fail|null, note, at, by }], with the words as
  // they were when the inspection started, so a later edit of the list never changes what was ticked.
  ['attraction_checks', (c) => tableExists(c, 'attraction_checks'), `CREATE TABLE IF NOT EXISTS attraction_checks (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id       BIGINT UNSIGNED NOT NULL,
    attraction_id   BIGINT UNSIGNED NOT NULL,
    check_date      DATE NOT NULL,
    attempt         TINYINT UNSIGNED NOT NULL DEFAULT 1,
    status          ENUM('in_progress','pass','fail') NOT NULL DEFAULT 'in_progress',
    items           MEDIUMTEXT NOT NULL,
    note            VARCHAR(500) NULL,
    started_by      BIGINT UNSIGNED NULL,
    started_by_name VARCHAR(100) NULL,
    started_at      DATETIME NOT NULL,
    finished_by     BIGINT UNSIGNED NULL,
    finished_by_name VARCHAR(100) NULL,
    finished_at     DATETIME NULL,
    UNIQUE KEY uq_attraction_checks (tenant_id, attraction_id, check_date, attempt),
    KEY ix_attraction_checks_day (tenant_id, check_date),
    CONSTRAINT fk_attraction_checks FOREIGN KEY (tenant_id, attraction_id) REFERENCES attractions(tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  // Every time an attraction stopped taking guests, and why. Kept in step with its status (open ends the entry).
  ['attraction_downtime', (c) => tableExists(c, 'attraction_downtime'), `CREATE TABLE IF NOT EXISTS attraction_downtime (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id       BIGINT UNSIGNED NOT NULL,
    attraction_id   BIGINT UNSIGNED NOT NULL,
    started_at      DATETIME NOT NULL,
    ended_at        DATETIME NULL,
    reason          VARCHAR(20) NOT NULL DEFAULT 'other',
    note            VARCHAR(255) NULL,
    user_id         BIGINT UNSIGNED NULL,
    KEY ix_attraction_downtime (tenant_id, attraction_id, started_at),
    CONSTRAINT fk_attraction_downtime FOREIGN KEY (tenant_id, attraction_id) REFERENCES attractions(tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
];
