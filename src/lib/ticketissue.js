'use strict';
// One lift ticket for one person, from a sold line item (2026.11.13). Sell's checkout (routes/checkout.js) issues a
// ticket line this way, and a learn to ski ladder lesson issues its included ticket the same way at check-in
// (lib/learnladder.js), so both tickets read and scan alike.
const { newCode, addDays } = require('./util');

/** Inserts the ticket: valid from validOn for the product's days, with its uses. Returns { id, code, valid_from, valid_to }. */
async function issueTicket(conn, tenantId, { orderItemId, personId, product, validOn }) {
  const validTo = addDays(validOn, Math.max(Number(product.valid_days) || 1, 1) - 1);
  const code = newCode();
  const [tk] = await conn.query('INSERT INTO tickets (tenant_id, order_item_id, person_id, product_id, code, valid_from, valid_to, uses_remaining) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [tenantId, orderItemId, personId, product.id, code, validOn, validTo, product.uses ?? null]);
  return { id: tk.insertId, code, valid_from: validOn, valid_to: validTo };
}

module.exports = { issueTicket };
