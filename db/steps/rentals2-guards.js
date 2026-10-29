'use strict';
// Rentals round 2, the review fixes. A card deposit is claimed ('taking') before money is taken from it, so two staff
// pressing Take at once cannot both record it; a saved card remembers when it was let go (detached_at), so the daily
// job can find cards still on file. A group records how it pays: a paid sale in Sell (billing_order_id) or a manager's
// note such as "invoice to the school" (billing_note, billing_by, billing_at). Loaded by db/migrate.js after the other
// rentals2 steps.
const statusHasTaking = async (c) => {
  const [r] = await c.query("SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rental_deposits' AND COLUMN_NAME = 'status'");
  return Boolean(r.length && String(r[0].t).includes("'taking'"));
};

module.exports = ({ columnExists }) => [
  ['rental_deposits.status taking', statusHasTaking,
    "ALTER TABLE rental_deposits MODIFY status ENUM('waiting','held','saved','taking','released','captured','charged','failed','canceled','expired') NOT NULL DEFAULT 'waiting'"],
  ['rental_deposits.detached_at', (c) => columnExists(c, 'rental_deposits', 'detached_at'), 'ALTER TABLE rental_deposits ADD COLUMN detached_at DATETIME NULL'],
  ['rental_groups.billing_at', (c) => columnExists(c, 'rental_groups', 'billing_at'),
    'ALTER TABLE rental_groups ADD COLUMN billing_order_id BIGINT UNSIGNED NULL, ADD COLUMN billing_note VARCHAR(200) NULL, ADD COLUMN billing_by BIGINT UNSIGNED NULL, ADD COLUMN billing_at DATETIME NULL'],
];
