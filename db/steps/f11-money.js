'use strict';
// 2026.11.11 money fixes. Loaded by db/migrate.js. Additive and safe to run twice.
//   payment_plan_charges.charging_at  set while an installment is being charged at Stripe (the claim; refunds, cancel and
//                                     settle wait for it). Older than 10 minutes means abandoned: looked up at Stripe.
//   payment_plan_charges.charge_key   the idempotency key of a try whose outcome is not known yet, kept so the next try
//                                     looks the payment up and asks again with the same key instead of charging twice
//   program_enrollments.order_item_id the order line a place was sold on, so a refund of that line withdraws exactly its
//                                     places (every session of a bundle, and never another order's place)
module.exports = ({ columnExists }) => [
  ['payment_plan_charges.charging_at', (c) => columnExists(c, 'payment_plan_charges', 'charging_at'), 'ALTER TABLE payment_plan_charges ADD COLUMN charging_at DATETIME NULL'],
  ['program_enrollments.order_item_id', (c) => columnExists(c, 'program_enrollments', 'order_item_id'), 'ALTER TABLE program_enrollments ADD COLUMN order_item_id BIGINT UNSIGNED NULL'],
  ['payment_plan_charges.charge_key', (c) => columnExists(c, 'payment_plan_charges', 'charge_key'), 'ALTER TABLE payment_plan_charges ADD COLUMN charge_key VARCHAR(160) NULL'],
];
