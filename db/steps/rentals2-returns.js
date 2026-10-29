'use strict';
// Rentals round 2, returns track: card deposits. Each try at holding a deposit (or saving the card) on the counter's
// card reader is one row here, so the counter screen can ask how it is going, the daily job can find holds near their
// end, and a capture or charge later goes back through the right Stripe account. The contract keeps the summary
// (deposit_mode, deposit_status, deposit_ref, deposit_customer, deposit_card). Loaded by db/migrate.js after rentals2.
module.exports = ({ tableExists }) => [
  ['rental_deposits', (c) => tableExists(c, 'rental_deposits'), `CREATE TABLE rental_deposits (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id      BIGINT UNSIGNED NOT NULL,
    contract_id    BIGINT UNSIGNED NOT NULL,
    reader_id      BIGINT UNSIGNED NULL,
    kind           ENUM('hold','saved') NOT NULL,
    intent         VARCHAR(80) NOT NULL,
    account        VARCHAR(64) NULL,
    customer       VARCHAR(80) NULL,
    payment_method VARCHAR(80) NULL,
    amount_cents   INT UNSIGNED NOT NULL DEFAULT 0,
    status         ENUM('waiting','held','saved','released','captured','charged','failed','canceled','expired') NOT NULL DEFAULT 'waiting',
    failure        VARCHAR(255) NULL,
    card_brand     VARCHAR(20) NULL,
    card_last4     CHAR(4) NULL,
    expires_at     DATETIME NULL,
    warned_at      DATETIME NULL,
    taken_cents    INT UNSIGNED NOT NULL DEFAULT 0,
    order_id       BIGINT UNSIGNED NULL,
    created_by     BIGINT UNSIGNED NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_deposits_contract (tenant_id, contract_id),
    KEY ix_deposits_status (status, expires_at)
  ) ENGINE=InnoDB`],
];
