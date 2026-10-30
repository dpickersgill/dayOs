'use strict';
// Payment plans for passes (Track FAIR fills this in): installments on the mountain's own Stripe account (Affirm later).
// The online shop asks quote() to offer "Pay in 3" and calls start() after the first payment.

/** Is a plan offered for this basket? { available: false } or { available: true, count, first_cents, then: [{ on, cents }] }. */
async function quote(_db, _tenantId, _basket) { return { available: false }; }
/** Starts a plan for a paid order (inside its transaction): saves the card for later charges and the schedule. */
async function start(_conn, _tenantId, _order, _opts) { return null; }

module.exports = { quote, start };
