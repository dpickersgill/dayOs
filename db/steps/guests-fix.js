'use strict';
// Guests round 2, fixes: what a ticket line was worth before any discount, and how much of a guest reward went on it.
//   order_items.list_cents    the unit price before any promo or reward (NULL on older lines: use unit_price_cents).
//   order_items.reward_cents  the part of a guest reward (lib/rewards.js) taken off this line. At the window it is
//                             already out of unit_price_cents; online it is part of discount_cents. Either way it says
//                             which lines a credit paid for, so a refund of some of them gives back only their part.
// Read with lib/linevalue.js.
//   fair_renewals.renewing_for, renewing_at  a renewal run's claim on the row (lib/autorenew.js renewOne), so two runs at
//                             once cannot both charge and make a pass.
// Each entry: [name, (conn) => done?, ddl].
module.exports = ({ columnExists }) => [
  ['order_items.list_cents', (c) => columnExists(c, 'order_items', 'list_cents'), 'ALTER TABLE order_items ADD COLUMN list_cents INT UNSIGNED NULL'],
  ['order_items.reward_cents', (c) => columnExists(c, 'order_items', 'reward_cents'), 'ALTER TABLE order_items ADD COLUMN reward_cents INT UNSIGNED NOT NULL DEFAULT 0'],
  ['fair_renewals.renewing_for', (c) => columnExists(c, 'fair_renewals', 'renewing_for'), 'ALTER TABLE fair_renewals ADD COLUMN renewing_for VARCHAR(10) NULL, ADD COLUMN renewing_at DATETIME NULL'],
];
