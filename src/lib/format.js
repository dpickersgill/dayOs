'use strict';

// Small text helpers shared by emails, receipts and error messages.

/** Cents as dollars with two decimals: 1250 -> "$12.50". */
const money = (cents) => `$${(cents / 100).toFixed(2)}`;

/** Makes text safe to put inside HTML (emails). */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = { money, esc };
