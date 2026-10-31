'use strict';
// 2026.11.11 money fixes. Loaded by db/migrate.js. Additive and safe to run twice.
//   payment_plan_charges.charging_at  set while an installment is being charged at Stripe (the claim; refunds, cancel and
//                                     settle wait for it). Older than 10 minutes means abandoned: looked up at Stripe.
//   payment_plan_charges.charge_key   the idempotency key of a try whose outcome is not known yet, kept so the next try
//                                     looks the payment up and asks again with the same key instead of charging twice
module.exports = ({ columnExists }) => [
  ['payment_plan_charges.charging_at', (c) => columnExists(c, 'payment_plan_charges', 'charging_at'), 'ALTER TABLE payment_plan_charges ADD COLUMN charging_at DATETIME NULL'],
  ['payment_plan_charges.charge_key', (c) => columnExists(c, 'payment_plan_charges', 'charge_key'), 'ALTER TABLE payment_plan_charges ADD COLUMN charge_key VARCHAR(160) NULL'],
];
