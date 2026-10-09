'use strict';

// CSV for accountants: every cell quoted, and cells that start with a formula character are defused so a customer
// name like "=HYPERLINK(...)" cannot run when the file is opened in a spreadsheet.
const cell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
const toCsv = (cols, data) => [cols.join(','), ...data.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
const dollars = (cents) => (cents === null || cents === undefined ? '' : (Number(cents) / 100).toFixed(2));

module.exports = { cell, toCsv, dollars };
