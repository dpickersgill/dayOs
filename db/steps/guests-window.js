'use strict';
// Guests, round 2, Track WINDOW: group prices per product (a price per person from N people), and the log of tickets
// moved to another day at the window (the same code, the price difference charged or given back).
module.exports = ({ tableExists }) => [
  ['group_prices', (c) => tableExists(c, 'group_prices'), `CREATE TABLE group_prices (
    tenant_id     BIGINT UNSIGNED NOT NULL,
    product_id    BIGINT UNSIGNED NOT NULL,
    min_people    SMALLINT UNSIGNED NOT NULL,
    price_cents   INT UNSIGNED NOT NULL,
    updated_by    BIGINT UNSIGNED NULL,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, product_id),
    CONSTRAINT fk_group_prices_product FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
  ) ENGINE=InnoDB`],
  ['window_changes', (c) => tableExists(c, 'window_changes'), `CREATE TABLE window_changes (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id     BIGINT UNSIGNED NOT NULL,
    ticket_id     BIGINT UNSIGNED NOT NULL,
    order_id      BIGINT UNSIGNED NOT NULL,
    from_date     DATE NOT NULL,
    to_date       DATE NOT NULL,
    old_cents     INT UNSIGNED NOT NULL,
    new_cents     INT UNSIGNED NOT NULL,
    diff_cents    INT NOT NULL,
    paid_order_id BIGINT UNSIGNED NULL,
    refund_id     BIGINT UNSIGNED NULL,
    user_id       BIGINT UNSIGNED NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_window_changes_ticket (tenant_id, ticket_id)
  ) ENGINE=InnoDB`],
];
