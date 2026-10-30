'use strict';
// The Good Day newsletter on the product website (guests round 2, track SITE). Platform-level: these tables belong to
// Verdynt/OS itself, not to any mountain, so none of them has a tenant_id.
//   goodday_subscribers  one row per email address: pending until the confirmation link is used, then confirmed, or
//                        unsubscribed. The consent (when, the exact wording shown, the address it came from) is kept.
//   goodday_tokens       the links in emails (confirm, unsubscribe). Only a SHA-256 of each token is stored.
//   goodday_deliveries   one row per issue per subscriber, claimed before the email goes, so a resend never doubles.
//   goodday_sends        each time an operator pressed Send (the subject, the intro, who, how many).
//   goodday_settings     one row: the sender name and the postal address every issue carries (CAN-SPAM).
// Each entry: [name, (conn) => done?, ddl].
module.exports = ({ tableExists }) => [
  ['goodday_subscribers', (c) => tableExists(c, 'goodday_subscribers'), `CREATE TABLE goodday_subscribers (
    id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    email            VARCHAR(255) NOT NULL,
    name             VARCHAR(100) NULL,
    role             ENUM('owner_gm','patrol','other') NOT NULL DEFAULT 'other',
    status           ENUM('pending','confirmed','unsubscribed') NOT NULL DEFAULT 'pending',
    source           VARCHAR(60) NULL,
    consent_at       DATETIME NULL,
    consent_wording  VARCHAR(500) NULL,
    consent_ip       VARCHAR(64) NULL,
    confirm_sent_at  DATETIME NULL,
    confirmed_at     DATETIME NULL,
    confirmed_ip     VARCHAR(64) NULL,
    welcome_sent_at  DATETIME NULL,
    unsubscribed_at  DATETIME NULL,
    unsubscribe_how  VARCHAR(30) NULL,
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_goodday_email (email),
    KEY ix_goodday_status (status, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],
  ['goodday_tokens', (c) => tableExists(c, 'goodday_tokens'), `CREATE TABLE goodday_tokens (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    subscriber_id  BIGINT UNSIGNED NOT NULL,
    purpose        ENUM('confirm','unsubscribe') NOT NULL,
    token_hash     CHAR(64) NOT NULL,
    expires_at     DATETIME NULL,
    used_at        DATETIME NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_goodday_token (token_hash),
    KEY ix_goodday_token_sub (subscriber_id, purpose),
    CONSTRAINT fk_goodday_token_sub FOREIGN KEY (subscriber_id) REFERENCES goodday_subscribers(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`],
  ['goodday_sends', (c) => tableExists(c, 'goodday_sends'), `CREATE TABLE goodday_sends (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    issue_no     SMALLINT UNSIGNED NOT NULL,
    subject      VARCHAR(200) NOT NULL,
    intro        VARCHAR(1000) NULL,
    started_by   VARCHAR(100) NULL,
    sent         INT UNSIGNED NOT NULL DEFAULT 0,
    failed       INT UNSIGNED NOT NULL DEFAULT 0,
    skipped      INT UNSIGNED NOT NULL DEFAULT 0,
    left_over    INT UNSIGNED NOT NULL DEFAULT 0,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at  DATETIME NULL,
    KEY ix_goodday_sends_issue (issue_no, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],
  ['goodday_deliveries', (c) => tableExists(c, 'goodday_deliveries'), `CREATE TABLE goodday_deliveries (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    issue_no       SMALLINT UNSIGNED NOT NULL,
    subscriber_id  BIGINT UNSIGNED NOT NULL,
    send_id        BIGINT UNSIGNED NULL,
    status         ENUM('sending','sent','failed') NOT NULL DEFAULT 'sending',
    message_id     VARCHAR(100) NULL,
    error          VARCHAR(200) NULL,
    sent_at        DATETIME NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_goodday_delivery (issue_no, subscriber_id),
    CONSTRAINT fk_goodday_delivery_sub FOREIGN KEY (subscriber_id) REFERENCES goodday_subscribers(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`],
  ['goodday_settings', (c) => tableExists(c, 'goodday_settings'), `CREATE TABLE goodday_settings (
    id              TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    from_name       VARCHAR(100) NOT NULL DEFAULT 'Dan at The Good Day',
    postal_address  VARCHAR(300) NULL,
    updated_by      VARCHAR(100) NULL,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`],
];
