'use strict';
// Claim files, documentation score, season risk report and insurer sharing (src/routes/patrolclaims.js).
// Each entry: [name, (conn) => Promise<boolean> already done, ddl]. Loaded by db/migrate.js.
module.exports = ({ tableExists }) => [
  // Each submitted or approved report's documentation score, worked out once per state of the report (stamp) so the
  // season figures do not reload every case on every visit.
  ['incident_doc_scores', (c) => tableExists(c, 'incident_doc_scores'), `CREATE TABLE incident_doc_scores (
    tenant_id   BIGINT UNSIGNED NOT NULL,
    incident_id BIGINT UNSIGNED NOT NULL,
    stamp       VARCHAR(80) NOT NULL,
    score       TINYINT UNSIGNED NULL,
    detail      TEXT NULL,
    computed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, incident_id)
  ) ENGINE=InnoDB`],
  // A secure link for an insurer (one released claim file) or a broker (the season risk report, counts only).
  // Only a hash of the link's token is kept; the link itself is shown once, when it is made.
  ['claim_shares', (c) => tableExists(c, 'claim_shares'), `CREATE TABLE claim_shares (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id       BIGINT UNSIGNED NOT NULL,
    kind            ENUM('claim','risk') NOT NULL,
    incident_id     BIGINT UNSIGNED NULL,
    request_id      BIGINT UNSIGNED NULL,
    season          VARCHAR(9) NULL,
    shared_with     VARCHAR(150) NOT NULL,
    token_hash      CHAR(64) NOT NULL,
    passcode_hash   CHAR(64) NULL,
    failed_attempts INT UNSIGNED NOT NULL DEFAULT 0,
    expires_at      DATETIME NOT NULL,
    revoked_at      DATETIME NULL,
    revoked_by      BIGINT UNSIGNED NULL,
    created_by      BIGINT UNSIGNED NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_claim_share_token (token_hash),
    KEY ix_claim_share_case (tenant_id, incident_id),
    CONSTRAINT fk_claim_share_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  ['claim_share_views', (c) => tableExists(c, 'claim_share_views'), `CREATE TABLE claim_share_views (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id  BIGINT UNSIGNED NOT NULL,
    share_id   BIGINT UNSIGNED NOT NULL,
    at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ip         VARCHAR(64) NULL,
    user_agent VARCHAR(255) NULL,
    KEY ix_claim_view_share (share_id, at),
    CONSTRAINT fk_claim_view_share FOREIGN KEY (share_id) REFERENCES claim_shares(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`],
];
