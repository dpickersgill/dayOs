'use strict';
// Patrol checklists: which built-in lists each patrol has switched on, the lists a patrol admin writes, and the words
// kept with every tick (so a tick reads the same after a list is renamed or archived). Lists are in src/lib/checklists.js.
// Each entry: [name, (conn) => Promise<boolean> already done, ddl]. Loaded by db/migrate.js.
module.exports = ({ tableExists, columnExists }) => [
  // What was ticked, in the words on screen at the time. Older ticks have none and read from the built-in lists.
  ['incident_checklist.list_id', (c) => columnExists(c, 'incident_checklist', 'list_id'), 'ALTER TABLE incident_checklist ADD COLUMN list_id VARCHAR(40) NULL'],
  ['incident_checklist.list_title', (c) => columnExists(c, 'incident_checklist', 'list_title'), 'ALTER TABLE incident_checklist ADD COLUMN list_title VARCHAR(150) NULL'],
  ['incident_checklist.item_label', (c) => columnExists(c, 'incident_checklist', 'item_label'), 'ALTER TABLE incident_checklist ADD COLUMN item_label VARCHAR(255) NULL'],
  // When a tick reached the server, for one taken with no signal and sent later (done_at is when it was ticked).
  ['incident_checklist.entered_at', (c) => columnExists(c, 'incident_checklist', 'entered_at'), 'ALTER TABLE incident_checklist ADD COLUMN entered_at TIMESTAMP NULL'],
  // A patrol admin's choice for a built-in list. No row: the list's starting choice (src/lib/checklists.js startsOn).
  ['patrol_checklist_switches', (c) => tableExists(c, 'patrol_checklist_switches'), `CREATE TABLE IF NOT EXISTS patrol_checklist_switches (
    tenant_id   BIGINT UNSIGNED NOT NULL,
    list_id     VARCHAR(40) NOT NULL,
    enabled     TINYINT(1) NOT NULL,
    updated_by  BIGINT UNSIGNED NULL,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, list_id),
    CONSTRAINT fk_pchksw_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  // A mountain's own lists. Archived, never deleted: ticks on past cases point at them.
  ['patrol_checklists', (c) => tableExists(c, 'patrol_checklists'), `CREATE TABLE IF NOT EXISTS patrol_checklists (
    id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id        BIGINT UNSIGNED NOT NULL,
    title            VARCHAR(150) NOT NULL,
    when_text        VARCHAR(300) NULL,
    scope            ENUM('patient','case') NOT NULL DEFAULT 'case',
    attraction_type  VARCHAR(40) NULL,
    enabled          TINYINT(1) NOT NULL DEFAULT 1,
    archived_at      DATETIME NULL,
    archived_by      BIGINT UNSIGNED NULL,
    created_by       BIGINT UNSIGNED NULL,
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by       BIGINT UNSIGNED NULL,
    updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_pchk_tenant_id (tenant_id, id),
    KEY ix_pchk_active (tenant_id, archived_at),
    CONSTRAINT fk_pchklist_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  // Their items, in order. An item taken off a list keeps its row (removed_at), so its key never means anything else.
  ['patrol_checklist_items', (c) => tableExists(c, 'patrol_checklist_items'), `CREATE TABLE IF NOT EXISTS patrol_checklist_items (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    checklist_id  BIGINT UNSIGNED NOT NULL,
    label         VARCHAR(255) NOT NULL,
    sort          SMALLINT NOT NULL DEFAULT 0,
    removed_at    DATETIME NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_pchki_list (tenant_id, checklist_id, sort),
    CONSTRAINT fk_pchkitem_list FOREIGN KEY (tenant_id, checklist_id) REFERENCES patrol_checklists(tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
];
