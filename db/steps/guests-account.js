'use strict';
// Guests, round 2, Track ACCOUNT: the household account, the designed confirmation and the morning-of message, card
// reload online and gift experiences. Each entry: [name, (conn) => done?, ddl].
module.exports = ({ tableExists }) => [
  // ---- one row per mountain: what the confirmation says about arriving, and when the morning-of message goes.
  ['account_settings', (c) => tableExists(c, 'account_settings'), `CREATE TABLE account_settings (
    tenant_id      BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    park_text      VARCHAR(300) NULL,
    first_text     VARCHAR(300) NULL,
    morning_on     TINYINT(1) NOT NULL DEFAULT 1,
    morning_time   CHAR(5) NOT NULL DEFAULT '07:00',
    updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_account_settings_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
  // ---- the morning-of message: once per order per visit day (the primary key is the claim).
  ['morning_messages', (c) => tableExists(c, 'morning_messages'), `CREATE TABLE morning_messages (
    tenant_id   BIGINT UNSIGNED NOT NULL,
    order_id    BIGINT UNSIGNED NOT NULL,
    on_date     DATE NOT NULL,
    emailed     TINYINT(1) NOT NULL DEFAULT 0,
    texted      TINYINT(1) NOT NULL DEFAULT 0,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, order_id, on_date)
  ) ENGINE=InnoDB`],
  // ---- a gift experience ("First day on snow"): bought in the shop or at the window, delivered to the person receiving
  // it on a date, revealed on a private page, redeemed once into their household account. Its value is a gift card.
  ['gift_experiences', (c) => tableExists(c, 'gift_experiences'), `CREATE TABLE gift_experiences (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id       BIGINT UNSIGNED NOT NULL,
    gift_card_id    BIGINT UNSIGNED NULL,
    order_id        BIGINT UNSIGNED NULL,
    theme           VARCHAR(80) NOT NULL,
    includes        JSON NOT NULL,
    from_name       VARCHAR(150) NOT NULL,
    recipient_name  VARCHAR(150) NOT NULL,
    recipient_email VARCHAR(255) NOT NULL,
    message         VARCHAR(500) NULL,
    deliver_on      DATE NOT NULL,
    token_hash      CHAR(64) NOT NULL,
    delivered_at    DATETIME NULL,
    revealed_at     DATETIME NULL,
    redeemed_at     DATETIME NULL,
    redeemed_person_id BIGINT UNSIGNED NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_gift_exp_token (token_hash),
    KEY ix_gift_exp_deliver (tenant_id, delivered_at, deliver_on),
    CONSTRAINT fk_gift_exp_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB`],
];
