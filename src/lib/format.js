'use strict';

// Small text helpers shared by emails, receipts and error messages.

/** Cents as dollars with two decimals: 1250 -> "$12.50". */
const money = (cents) => `$${(cents / 100).toFixed(2)}`;

/** Makes text safe to put inside HTML (emails). */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A day as people read it, the app's date format: '2026-10-31' -> "Sat, Oct 31, 2026". Anything else is returned as it came. */
const dayText = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d ?? ''));
  if (!m) return String(d ?? '');
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
};
/** Two days as a range: one day when they are the same. */
const daysText = (a, b) => (!b || String(a).slice(0, 10) === String(b).slice(0, 10) ? dayText(a) : `${dayText(a)} to ${dayText(b)}`);

module.exports = { money, esc, dayText, daysText };
