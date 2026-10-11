-- Injury network: mountains that choose to share de-identified injury counts with the network report.
-- Applied by db/migrate.js. Everything is CREATE TABLE IF NOT EXISTS, so it is safe to re-run.

-- One row per mountain once it has made a choice. No row means not sharing.
CREATE TABLE IF NOT EXISTS safety_sharing (
  tenant_id          BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  share              TINYINT(1) NOT NULL DEFAULT 0,
  named              TINYINT(1) NOT NULL DEFAULT 0,     -- may the mountain be named in the network report
  region             VARCHAR(30) NULL,
  state              VARCHAR(40) NULL,
  agreement_version  VARCHAR(20) NULL,
  agreed_by          BIGINT UNSIGNED NULL,
  agreed_name        VARCHAR(100) NULL,
  agreed_title       VARCHAR(100) NULL,
  agreed_at          DATETIME NULL,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_safety_sharing_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- Every change, so the mountain and the platform can see who turned sharing on or off, and when.
CREATE TABLE IF NOT EXISTS safety_sharing_log (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id          BIGINT UNSIGNED NOT NULL,
  share              TINYINT(1) NOT NULL,
  named              TINYINT(1) NOT NULL,
  region             VARCHAR(30) NULL,
  state              VARCHAR(40) NULL,
  agreement_version  VARCHAR(20) NULL,
  by_user            BIGINT UNSIGNED NULL,
  by_name            VARCHAR(100) NULL,
  by_title           VARCHAR(100) NULL,
  at                 TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_safety_log_tenant (tenant_id, at),
  CONSTRAINT fk_safety_log_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;
