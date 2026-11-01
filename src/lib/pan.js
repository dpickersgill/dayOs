'use strict';
// Card numbers never go into Verdynt/OS (2026.11.11). A clerk who types a whole card number into a payment's approval
// code, reference or note would put cardholder data into the database, receipts and exports, and take the mountain out
// of the simplest card rules (SAQ A). Every payment free-text field refuses a run of 13 to 19 digits, with or without
// spaces or dashes (the same test as lost and found), whether or not it passes the card checksum: the last 4 digits are
// all anyone needs. Existing rows were masked to their last 4 by db/steps/f11-money.js.
const { z } = require('./util');

const RUN = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/;
/** True when the text holds something that could be a card number. */
const hasCardNumber = (s) => RUN.test(String(s || ''));
const WORDS = 'Do not type card numbers here. Keep only the last 4 digits.';
/** A payment free-text field: max length, and no card numbers. */
const payText = (max) => z.string().trim().max(max).refine((s) => !hasCardNumber(s), WORDS);
/** The Luhn check: used by tests and kept for anyone who needs to tell a real card number from another long number. */
function luhn(digits) {
  const d = String(digits).replace(/\D/g, '');
  let sum = 0;
  for (let i = 0; i < d.length; i++) { let x = Number(d[d.length - 1 - i]); if (i % 2) { x *= 2; if (x > 9) x -= 9; } sum += x; }
  return d.length >= 13 && sum % 10 === 0;
}

module.exports = { hasCardNumber, payText, luhn, WORDS, RUN };
