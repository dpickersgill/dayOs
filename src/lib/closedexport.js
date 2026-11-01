'use strict';

// A closed mountain's export window (2026.11.11, privacy). Closing pauses a mountain at once, but the Security page
// promises 60 days to download everything. During that window the owner can still sign in, to an export-only mode: the
// mountain's spreadsheets and nothing else. After the window the daily job marks the mountain due for deletion and the
// console shows it to the operator (lib/retention.js).
const { todayIn } = require('./util');

/** Is this mountain closed and still inside its export window? row: closed_at, delete_after, data_deleted_at, timezone. */
function inWindow(row) {
  if (!row || !row.closed_at || row.data_deleted_at || !row.delete_after) return false;
  const last = row.delete_after instanceof Date ? row.delete_after.toISOString().slice(0, 10) : String(row.delete_after).slice(0, 10);
  return last >= todayIn(row.timezone || 'America/New_York');
}
/** Only the owner signs in to a closed mountain, and only during the window. */
const ownerMayExport = (row) => Boolean(row) && row.role === 'owner' && inWindow(row);

// What export-only mode can reach: who am I, sign out, the list of files, and the files themselves.
const FILES = [
  ['Customers', '/api/v1/people/export.csv'],
  ['Sales', '/api/v1/exports/sales.csv'],
  ['Payments', '/api/v1/exports/payments.csv'],
  ['Refunds', '/api/v1/exports/refunds.csv'],
  ['Daily summary', '/api/v1/exports/daily-summary.csv'],
  ['Signed waivers', '/api/v1/waivers/export.csv'],
  ['Patrol case records', '/api/v1/patrol/incidents.csv'],
  ['Patrol patient statistics', '/api/v1/patrol/patients.csv'],
];
const PATHS = new Set(['/api/v1/auth/me', '/api/v1/auth/logout', '/api/v1/auth/back', '/api/v1/auth/closing', '/api/v1/closed-export', ...FILES.map((f) => f[1])]);
const allowedPath = (path) => PATHS.has(String(path).split('?')[0].replace(/\/+$/, ''));

module.exports = { inWindow, ownerMayExport, allowedPath, FILES };
