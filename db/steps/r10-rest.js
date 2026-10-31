'use strict';
// 2026.11.10 (SLIM 7d): lift inspection checklists by lift type. Each lift gets a type; each type has a daily and a
// weekly list (built in, src/lib/liftchecks.js) that a mountain edits as its own copy; an inspection is started, ticked
// item by item and signed off, like an attraction's. Additive and safe to run twice.
// Each entry: [name, (conn) => Promise<boolean> already done, ddl]. Loaded by db/migrate.js.
module.exports = ({ tableExists, columnExists }) => [
  // NULL: not set yet. The lift then keeps the standard list it always had.
  ['lifts.lift_type', (c) => columnExists(c, 'lifts', 'lift_type'), 'ALTER TABLE lifts ADD COLUMN lift_type VARCHAR(30) NULL'],
  // A finished weekly inspection is written to lift_checks too, beside the daily one, so the board and reports see it.
  ['lift_checks.kind periodic', async (c) => {
    const [[r]] = await c.query("SELECT column_type AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'lift_checks' AND column_name = 'kind'");
    return !r || /'periodic'/.test(r.t);
  }, "ALTER TABLE lift_checks MODIFY kind ENUM('pre_open','post_close','periodic') NOT NULL DEFAULT 'pre_open'"],
  // A mountain's own copy of a type's list. No row: the built-in list. items is JSON [{ key, label, required }].
  ['lift_check_templates', (c) => tableExists(c, 'lift_check_templates'), `CREATE TABLE IF NOT EXISTS lift_check_templates (
    tenant_id   BIGINT UNSIGNED NOT NULL,
    lift_type   VARCHAR(30) NOT NULL,
    kind        ENUM('daily','periodic') NOT NULL,
    items       MEDIUMTEXT NOT NULL,
    updated_by  BIGINT UNSIGNED NULL,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, lift_type, kind),
    CONSTRAINT fk_lift_check_templates_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  // One inspection, from start to sign-off. items is JSON [{ key, label, required, result: pass|fail|na|null, note, at,
  // by }] with the words as they were when it started. A finished one also writes a row to lift_checks (lift_check_id).
  ['lift_inspections', (c) => tableExists(c, 'lift_inspections'), `CREATE TABLE IF NOT EXISTS lift_inspections (
    id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id        BIGINT UNSIGNED NOT NULL,
    lift_id          BIGINT UNSIGNED NOT NULL,
    kind             ENUM('daily','periodic') NOT NULL DEFAULT 'daily',
    lift_type        VARCHAR(30) NULL,
    check_date       DATE NOT NULL,
    status           ENUM('in_progress','pass','fail') NOT NULL DEFAULT 'in_progress',
    items            MEDIUMTEXT NOT NULL,
    note             VARCHAR(500) NULL,
    started_by       BIGINT UNSIGNED NULL,
    started_by_name  VARCHAR(100) NULL,
    started_at       DATETIME NOT NULL,
    finished_by      BIGINT UNSIGNED NULL,
    finished_by_name VARCHAR(100) NULL,
    finished_at      DATETIME NULL,
    lift_check_id    BIGINT UNSIGNED NULL,
    work_order_id    BIGINT UNSIGNED NULL,
    KEY ix_lift_inspections_lift (tenant_id, lift_id, kind, check_date),
    KEY ix_lift_inspections_day (tenant_id, check_date),
    CONSTRAINT fk_lift_inspections_lift FOREIGN KEY (tenant_id, lift_id) REFERENCES lifts(tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
];
