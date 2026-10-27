'use strict';
// Witness statements by link and the scene diagram (src/routes/patrolscene.js).
// Each entry: [name, (conn) => Promise<boolean> already done, ddl]. Loaded by db/migrate.js.
module.exports = ({ tableExists, columnExists }) => [
  // A statement written by the witness on their own phone, from a link the patroller sent. Never edited by staff:
  // a wrong one is marked entered in error with a reason, like other parts of the record.
  ['incident_witnesses.source', (c) => columnExists(c, 'incident_witnesses', 'source'), "ALTER TABLE incident_witnesses ADD COLUMN source ENUM('patroller','link') NOT NULL DEFAULT 'patroller'"],
  ['incident_witnesses.statement_signature', (c) => columnExists(c, 'incident_witnesses', 'statement_signature'), 'ALTER TABLE incident_witnesses ADD COLUMN statement_signature MEDIUMTEXT NULL'],
  ['incident_witnesses.received_at', (c) => columnExists(c, 'incident_witnesses', 'received_at'), 'ALTER TABLE incident_witnesses ADD COLUMN received_at DATETIME NULL'],
  ['incident_witnesses.received_ip', (c) => columnExists(c, 'incident_witnesses', 'received_ip'), 'ALTER TABLE incident_witnesses ADD COLUMN received_ip VARCHAR(45) NULL'],
  ['incident_witnesses.voided_at', (c) => columnExists(c, 'incident_witnesses', 'voided_at'), 'ALTER TABLE incident_witnesses ADD COLUMN voided_at DATETIME NULL'],
  ['incident_witnesses.void_reason', (c) => columnExists(c, 'incident_witnesses', 'void_reason'), 'ALTER TABLE incident_witnesses ADD COLUMN void_reason VARCHAR(255) NULL'],
  ['incident_witnesses.voided_by', (c) => columnExists(c, 'incident_witnesses', 'voided_by'), 'ALTER TABLE incident_witnesses ADD COLUMN voided_by BIGINT UNSIGNED NULL'],
  ['patrol_witness_links', (c) => tableExists(c, 'patrol_witness_links'), `CREATE TABLE patrol_witness_links (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    incident_id   BIGINT UNSIGNED NOT NULL,
    token_hash    CHAR(64) NOT NULL,
    name          VARCHAR(150) NOT NULL,
    phone         VARCHAR(40) NULL,
    email         VARCHAR(255) NULL,
    status        ENUM('sent','opened','received','canceled') NOT NULL DEFAULT 'sent',
    sent_by       VARCHAR(20) NULL,
    send_note     VARCHAR(255) NULL,
    expires_at    DATETIME NOT NULL,
    opened_at     DATETIME NULL,
    received_at   DATETIME NULL,
    witness_id    BIGINT UNSIGNED NULL,
    note_id       BIGINT UNSIGNED NULL,
    statement     TEXT NULL,
    signature     MEDIUMTEXT NULL,
    received_ip   VARCHAR(45) NULL,
    created_by    BIGINT UNSIGNED NOT NULL,
    created_at    DATETIME NOT NULL,
    UNIQUE KEY uq_pwl_token (token_hash),
    KEY ix_pwl_case (tenant_id, incident_id),
    CONSTRAINT fk_pwl_incident FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id)
  ) ENGINE=InnoDB`],
  // The scene diagram: the drawing as JSON (to edit it again) and as SVG (for the report and the claim file).
  ['patrol_scenes', (c) => tableExists(c, 'patrol_scenes'), `CREATE TABLE patrol_scenes (
    tenant_id   BIGINT UNSIGNED NOT NULL,
    incident_id BIGINT UNSIGNED NOT NULL,
    data        TEXT NOT NULL,
    svg         MEDIUMTEXT NOT NULL,
    updated_by  BIGINT UNSIGNED NULL,
    updated_at  DATETIME NOT NULL,
    PRIMARY KEY (tenant_id, incident_id),
    CONSTRAINT fk_pscene_incident FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id)
  ) ENGINE=InnoDB`],
];
