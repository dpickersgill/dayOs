'use strict';

// The consent ledger. Every change to what a customer has agreed to is one row, never edited, so the mountain can show
// what was agreed, when, and how. people.marketing_opt_in stays as the quick answer for email and follows the latest email row.
const { one } = require('../db');

const CHANNELS = ['email', 'sms'];
const WORDING = 'v1';

/** Adds a consent row. `by` is { userId, name } or null for something the guest did or a system step. */
async function recordConsent(conn, tenantId, personId, channel, status, source, by) {
  let name = by ? by.name || null : null;
  if (by && by.userId && !name) name = (await one(conn, 'SELECT COALESCE(email, username) AS email FROM users WHERE tenant_id = ? AND id = ?', [tenantId, by.userId]) || {}).email || null;
  await conn.query(
    'INSERT INTO consent_events (tenant_id, person_id, channel, status, source, wording, recorded_by, recorded_by_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [tenantId, personId, channel, status, source, WORDING, by ? by.userId || null : null, name],
  );
}

/** The current answer for each channel: { email: {status, since, source}|null, sms: ... }. */
async function currentConsent(conn, tenantId, personId) {
  const out = {};
  for (const channel of CHANNELS) {
    const row = await one(conn, 'SELECT status, source, created_at FROM consent_events WHERE tenant_id = ? AND person_id = ? AND channel = ? ORDER BY id DESC LIMIT 1', [tenantId, personId, channel]);
    out[channel] = row ? { status: row.status, source: row.source, since: row.created_at } : null;
  }
  return out;
}

module.exports = { CHANNELS, WORDING, recordConsent, currentConsent };
