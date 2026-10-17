-- Tiered sign-in (2026.10.17): passkeys, second checks before sensitive actions, known devices, shared terminals with
-- personal PINs, and the console's per-mountain access. Secrets are kept only as hashes.

-- A passkey: a sign-in kept on a phone or computer (fingerprint, face or device PIN). Only its public key is stored.
CREATE TABLE IF NOT EXISTS user_passkeys (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id      BIGINT UNSIGNED NOT NULL,
  user_id        BIGINT UNSIGNED NOT NULL,
  credential_id  VARCHAR(512) NOT NULL,
  public_key     BLOB NOT NULL,
  sign_count     INT UNSIGNED NOT NULL DEFAULT 0,
  transports     VARCHAR(120) NULL,
  backed_up      TINYINT(1) NOT NULL DEFAULT 0,
  name           VARCHAR(60) NOT NULL,
  created_at     DATETIME NOT NULL,
  last_used_at   DATETIME NULL,
  UNIQUE KEY uq_user_passkeys_cred (credential_id(255)),
  KEY ix_user_passkeys_user (tenant_id, user_id)
) ENGINE=InnoDB;

-- The console's operators have passkeys of their own.
CREATE TABLE IF NOT EXISTS platform_operator_passkeys (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  operator_id    BIGINT UNSIGNED NOT NULL,
  credential_id  VARCHAR(512) NOT NULL,
  public_key     BLOB NOT NULL,
  sign_count     INT UNSIGNED NOT NULL DEFAULT 0,
  transports     VARCHAR(120) NULL,
  name           VARCHAR(60) NOT NULL,
  created_at     DATETIME NOT NULL,
  last_used_at   DATETIME NULL,
  UNIQUE KEY uq_op_passkeys_cred (credential_id(255)),
  KEY ix_op_passkeys_op (operator_id)
) ENGINE=InnoDB;

-- A one-time challenge for a passkey or an emailed code. Used once, gone in 5 minutes; works across servers.
CREATE TABLE IF NOT EXISTS auth_challenges (
  id_hash      CHAR(64) NOT NULL PRIMARY KEY,
  purpose      VARCHAR(20) NOT NULL,
  tenant_id    BIGINT UNSIGNED NULL,
  user_id      BIGINT UNSIGNED NULL,
  operator_id  BIGINT UNSIGNED NULL,
  challenge    VARCHAR(255) NOT NULL,
  tries        TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at   DATETIME NOT NULL,
  used_at      DATETIME NULL,
  KEY ix_auth_challenges_expire (expires_at)
) ENGINE=InnoDB;

-- Phones and computers each person has signed in from (a random id the browser keeps, stored here as a hash).
CREATE TABLE IF NOT EXISTS user_devices (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT UNSIGNED NOT NULL,
  user_id      BIGINT UNSIGNED NOT NULL,
  device_hash  CHAR(64) NOT NULL,
  label        VARCHAR(120) NULL,
  first_seen   DATETIME NOT NULL,
  last_seen    DATETIME NOT NULL,
  UNIQUE KEY uq_user_devices (user_id, device_hash),
  KEY ix_user_devices_tenant (tenant_id)
) ENGINE=InnoDB;

-- A shared computer a manager has enrolled (ticket window, rental counter, lift shack). Crew switch in with a PIN.
CREATE TABLE IF NOT EXISTS terminals (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT UNSIGNED NOT NULL,
  name         VARCHAR(60) NOT NULL,
  secret_hash  CHAR(64) NOT NULL,
  enrolled_by  BIGINT UNSIGNED NULL,
  created_at   DATETIME NOT NULL,
  last_seen    DATETIME NULL,
  revoked_at   DATETIME NULL,
  UNIQUE KEY uq_terminals_secret (secret_hash),
  KEY ix_terminals_tenant (tenant_id)
) ENGINE=InnoDB;

-- An operator opening one mountain in the console, for a while and for a reason.
CREATE TABLE IF NOT EXISTS platform_access (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  operator_id  BIGINT UNSIGNED NOT NULL,
  tenant_id    BIGINT UNSIGNED NOT NULL,
  reason       VARCHAR(300) NOT NULL,
  opened_at    DATETIME NOT NULL,
  expires_at   DATETIME NOT NULL,
  closed_at    DATETIME NULL,
  KEY ix_platform_access (operator_id, tenant_id, expires_at)
) ENGINE=InnoDB;
