'use strict';
// Fair by design (Track FAIR fills this in): the walk-up cap, when a day's price rises next, the price promise and the
// conditions guarantee. Each is a mountain setting, off by default (lib/guestsettings.js). Callers: lib/pricing.js and the
// window (cap), the online shop calendar (nextRise, badges), the confirmation email (guaranteeLink).

/** The window or same-day price after the walk-up cap, given the online price for the same ticket and day. */
async function capWalkup(_db, _tenantId, { windowCents }) { return windowCents; }
/** When this product's price for this day goes up next, or null: { on: 'YYYY-MM-DD', cents }. */
async function nextRise(_db, _tenantId, _productId, _day) { return null; }
/** Badges for the shop: [{ key: 'price_promise', text: 'Price promise' }, ...]. */
async function badges(_db, _tenantId) { return []; }
/** A link for the guest's conditions guarantee on a ticket, or null when it is off. */
async function guaranteeLink(_db, _tenantId, _ticketId, _base) { return null; }

module.exports = { capWalkup, nextRise, badges, guaranteeLink };
