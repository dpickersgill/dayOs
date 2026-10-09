-- The time clock kiosk: shared tablets that clock people in and out without a login.
-- Devices are paired once with a short code; people use a PIN or a QR badge. Snapshots are optional and expire.

CREATE TABLE IF NOT EXISTS kiosk_devices (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  name            VARCHAR(100) NOT NULL,
  token_hash      CHAR(64) NULL,
  pair_hash       CHAR(64) NULL,
  pair_expires_at DATETIME NULL,
  active          TINYINT(1) NOT NULL DEFAULT 1,
  paired_at       DATETIME NULL,
  last_seen_at    DATETIME NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_kiosk_token (token_hash),
  UNIQUE KEY uq_kiosk_pair (pair_hash),
  KEY ix_kiosk_tenant (tenant_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS kiosk_credentials (
  tenant_id       BIGINT UNSIGNED NOT NULL,
  staff_id        BIGINT UNSIGNED NOT NULL,
  pin_hash        VARCHAR(100) NULL,
  pin_set_at      DATETIME NULL,
  failed_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until    DATETIME NULL,
  badge_issued    TINYINT(1) NOT NULL DEFAULT 0,
  badge_version   SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, staff_id),
  CONSTRAINT fk_kiosk_cred_staff FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS time_photos (
  id        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  entry_id  BIGINT UNSIGNED NOT NULL,
  kind      ENUM('in','out') NOT NULL,
  image     MEDIUMTEXT NOT NULL,
  taken_at  DATETIME NOT NULL,
  UNIQUE KEY uq_time_photo (entry_id, kind),
  KEY ix_time_photo_taken (tenant_id, taken_at)
) ENGINE=InnoDB;
