-- Platform management: which apps each mountain has turned on, and a log of what the operator changed.
-- A mountain with no rows has every app on, so existing mountains keep working after this upgrade.
CREATE TABLE IF NOT EXISTS tenant_modules (
  tenant_id BIGINT UNSIGNED NOT NULL,
  module    VARCHAR(30) NOT NULL,
  enabled   TINYINT(1) NOT NULL DEFAULT 1,
  changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, module),
  CONSTRAINT fk_tm_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS platform_audit (
  id        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  tenant_id BIGINT UNSIGNED NULL,
  action    VARCHAR(40) NOT NULL,
  detail    TEXT NULL,
  INDEX idx_pa_tenant (tenant_id, at)
) ENGINE=InnoDB;

-- People who tried the self-serve demo. The row stays after the demo mountain is removed, so it works as a list of leads.
CREATE TABLE IF NOT EXISTS sandbox_signups (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  email      VARCHAR(255) NOT NULL,
  name       VARCHAR(200) NOT NULL,
  mountain   VARCHAR(255) NOT NULL,
  tenant_id  BIGINT UNSIGNED NULL,
  expires_at DATETIME NULL,
  ip_hash    CHAR(16) NULL,
  INDEX idx_ss_email (email, at),
  INDEX idx_ss_tenant (tenant_id)
) ENGINE=InnoDB;

-- How each demo was used: requests per part of the app, kept after the demo mountain is removed (keyed by the sign-up).
CREATE TABLE IF NOT EXISTS sandbox_usage (
  signup_id  BIGINT UNSIGNED NOT NULL,
  area       VARCHAR(40)  NOT NULL,
  requests   INT UNSIGNED NOT NULL DEFAULT 0,
  last_at    DATETIME     NOT NULL,
  PRIMARY KEY (signup_id, area)
) ENGINE=InnoDB;
