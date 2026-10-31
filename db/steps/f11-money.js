'use strict';
// 2026.11.11 money fixes. Loaded by db/migrate.js. Additive and safe to run twice.
//   payment_plan_charges.charging_at  set while an installment is being charged at Stripe (the claim; refunds, cancel and
//                                     settle wait for it). Older than 10 minutes means abandoned: looked up at Stripe.
//   payment_plan_charges.charge_key   the idempotency key of a try whose outcome is not known yet, kept so the next try
//                                     looks the payment up and asks again with the same key instead of charging twice
//   program_enrollments.order_item_id the order line a place was sold on, so a refund of that line withdraws exactly its
//                                     places (every session of a bundle, and never another order's place)
//   card numbers typed into payment free-text fields (approval code, reference, a refund's note, an order's payment
//                                     reference) masked to their last 4 digits; the app refuses new ones (lib/pan.js)
const PAN = '(?<![0-9])(?:[0-9][ -]?){9,15}([0-9]{4})(?![0-9])';
const PAN_COLS = [['order_payments', 'auth_code'], ['order_payments', 'reference'], ['order_refunds', 'note'], ['orders', 'payment_ref']];
const panLeft = async (c) => {
  for (const [t, col] of PAN_COLS) {
    const [[r]] = await c.query(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} REGEXP ?`, [PAN]);
    if (Number(r.n)) return false;
  }
  return true;
};
module.exports = ({ columnExists }) => [
  ['payment_plan_charges.charging_at', (c) => columnExists(c, 'payment_plan_charges', 'charging_at'), 'ALTER TABLE payment_plan_charges ADD COLUMN charging_at DATETIME NULL'],
  ['program_enrollments.order_item_id', (c) => columnExists(c, 'program_enrollments', 'order_item_id'), 'ALTER TABLE program_enrollments ADD COLUMN order_item_id BIGINT UNSIGNED NULL'],
  ['payment_plan_charges.charge_key', (c) => columnExists(c, 'payment_plan_charges', 'charge_key'), 'ALTER TABLE payment_plan_charges ADD COLUMN charge_key VARCHAR(160) NULL'],
  ['payment free text: card numbers masked', panLeft, PAN_COLS.map(([t, col]) => `UPDATE ${t} SET ${col} = REGEXP_REPLACE(${col}, '${PAN}', '************\\\\1') WHERE ${col} REGEXP '${PAN}'`)],
];
