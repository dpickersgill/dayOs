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
  const add = (pid) => conn.query(
    'INSERT INTO consent_events (tenant_id, person_id, channel, status, source, wording, recorded_by, recorded_by_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [tenantId, pid, channel, status, source, WORDING, by ? by.userId || null : null, name],
  );
  await add(personId);
  // A "no" belongs to the address, not the record: every other record at this mountain with the same phone (texts) or
  // email (email) that still says yes gets the same "no", so a family that shares a phone is not texted again.
  if (status === 'opted_out') {
    const col = channel === 'sms' ? 'phone_key' : 'email';
    const me = await one(conn, `SELECT ${col} AS v FROM people WHERE tenant_id = ? AND id = ?`, [tenantId, personId]);
    if (me && me.v) {
      const [others] = await conn.query(`SELECT p.id, (SELECT c.status FROM consent_events c WHERE c.tenant_id = p.tenant_id AND c.person_id = p.id AND c.channel = ? ORDER BY c.id DESC LIMIT 1) AS st
        FROM people p WHERE p.tenant_id = ? AND p.${col} = ? AND p.id <> ?`, [channel, tenantId, me.v, personId]);
      for (const o of others) if (o.st === 'opted_in') await add(o.id);
    }
  }
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
