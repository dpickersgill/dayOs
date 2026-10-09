-- Waivers you can show in court: every wording a mountain has used is kept word for word, and each signing on a screen
-- keeps the drawn signature, the typed name, when and from what device. One signing can cover the signer and their children;
-- each person covered still gets their own row in `waivers` (the table every check reads), pointing back here.

CREATE TABLE IF NOT EXISTS waiver_texts (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  sha         CHAR(64)     NOT NULL,
  body        MEDIUMTEXT   NOT NULL,
  created_by  BIGINT UNSIGNED NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_waiver_texts (tenant_id, sha)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS waiver_signings (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id         BIGINT UNSIGNED NOT NULL,
  token             CHAR(32)     NOT NULL,
  season            VARCHAR(20)  NOT NULL,
  source            ENUM('online','counter') NOT NULL,
  signer_person_id  BIGINT UNSIGNED NULL,
  signer_name       VARCHAR(200) NOT NULL,
  signer_email      VARCHAR(255) NULL,
  signer_phone      VARCHAR(40)  NULL,
  signer_dob        DATE         NULL,
  covered_names     TEXT         NULL,
  typed_name        VARCHAR(200) NOT NULL,
  signature         MEDIUMTEXT   NOT NULL,
  text_sha          CHAR(64)     NOT NULL,
  ip                VARCHAR(45)  NULL,
  user_agent        VARCHAR(300) NULL,
  recorded_by       BIGINT UNSIGNED NULL,
  emailed_at        TIMESTAMP    NULL,
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_waiver_signings_token (token),
  KEY ix_waiver_signings_when (tenant_id, created_at),
  KEY ix_waiver_signings_email (tenant_id, signer_email)
) ENGINE=InnoDB;
