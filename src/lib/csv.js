'use strict';

// CSV for accountants: every cell quoted, and cells that start with a formula character are defused so a customer
// name like "=HYPERLINK(...)" cannot run when the file is opened in a spreadsheet.
// A plain number ("-75.512", "+3", "1e5") is left as it is, so a longitude or a negative amount stays a number in the
// spreadsheet (review fix, 2026.11.19); anything else starting with = + - @ is defused.
const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const defuse = (s) => (/^[=+\-@\t\r]/.test(s) && !PLAIN_NUMBER.test(s) ? `'${s}` : s);
const cell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return `"${defuse(s).replace(/"/g, '""')}"`;
};
const toCsv = (cols, data) => [cols.join(','), ...data.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
const dollars = (cents) => (cents === null || cents === undefined ? '' : (Number(cents) / 100).toFixed(2));

module.exports = { cell, toCsv, dollars, defuse, PLAIN_NUMBER };
