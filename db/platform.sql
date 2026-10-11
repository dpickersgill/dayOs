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

-- People who run the platform console. Each signs in with their own email, password and authenticator code; the
-- platform key stays as the way in for setting up the first one, or if everyone is locked out.
CREATE TABLE IF NOT EXISTS platform_operators (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email               VARCHAR(255) NOT NULL,
  name                VARCHAR(100) NOT NULL,
  password_hash       VARCHAR(100) NOT NULL,
  password_changed_at DATETIME     NOT NULL,
  session_epoch       INT UNSIGNED NOT NULL DEFAULT 0, -- raised to end every open session (password change, reset, switched off)
  totp_secret         VARCHAR(300) NULL,
  totp_enabled        TINYINT(1)   NOT NULL DEFAULT 0,
  totp_last_step      BIGINT       NULL,
  failures            INT UNSIGNED NOT NULL DEFAULT 0,
  locked_until        DATETIME     NULL,
  active              TINYINT(1)   NOT NULL DEFAULT 1,
  last_login_at       DATETIME     NULL,
  created_by          VARCHAR(100) NULL,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_platform_operator_email (email)
) ENGINE=InnoDB;

-- Guided tours taken in a demo: how far each visitor got in each tour, for the Demos dashboard.
CREATE TABLE IF NOT EXISTS sandbox_tours (
  signup_id    BIGINT UNSIGNED NOT NULL,
  tour         VARCHAR(40)  NOT NULL,
  steps_seen   TINYINT UNSIGNED NOT NULL DEFAULT 0,
  steps_total  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  started_at   DATETIME     NOT NULL,
  finished_at  DATETIME     NULL,
  PRIMARY KEY (signup_id, tour)
) ENGINE=InnoDB;
