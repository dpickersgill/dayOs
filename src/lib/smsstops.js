'use strict';

// Texted STOPs, remembered for the number they were sent to (2026.11.20 review). A phone that texts STOP before it is on
// any list (no customer, resident or alert sign-up has it yet) must still never get a text from that number later, after
// an import or a sign-up. Each STOP is kept as a keyed hash of the phone (never the number), for:
//   scope_tenant = 0                the shared Verdynt/OS numbers: every tenant that texts from them
//   scope_tenant = <municipality>   that municipality's own texting number
// Only a texted START to the same number lifts it. lib/sms.js send() asks stopped() before every text; the customer list
// and alert imports ask it for each phone they keep.
const crypto = require('crypto');
const { pool, one } = require('../db');
const config = require('../config');

const hashOf = (key) => crypto.createHmac('sha256', config.linkSecret).update(`sms-stop:${key}`).digest('hex');
const keyOf = (phone) => require('./sms').phoneKey(phone);

/** Records a STOP or lifts it on START. tenantIds: the municipalities whose own number it came to; none: a shared number. */
async function record(phone, intent, { tenantIds = [] } = {}) {
  const key = keyOf(phone);
  if (!key || !['stop', 'start'].includes(intent)) return 0;
  const scopes = tenantIds && tenantIds.length ? tenantIds.map(Number) : [0];
  for (const s of scopes) {
    if (intent === 'stop') await pool.query('INSERT INTO sms_stops (phone_hash, scope_tenant) VALUES (?, ?) ON DUPLICATE KEY UPDATE stopped_at = UTC_TIMESTAMP()', [hashOf(key), s]);
    else await pool.query('DELETE FROM sms_stops WHERE phone_hash = ? AND scope_tenant = ?', [hashOf(key), s]);
  }
  return scopes.length;
}

/** The scope a text from this tenant goes out under: its own number (the municipality) or a shared one (0). */
async function scopeOf(tenantId, from) {
  if (!from) return 0;
  const own = await one(pool, 'SELECT tenant_id FROM street_notice_settings WHERE tenant_id = ? AND from_number = ?', [tenantId, from]).catch(() => null);
  if (own) return Number(tenantId);
  return require('./sms').sharedNumbers().includes(from) ? 0 : null; // another number (a Text HELP line) keeps its own STOP list
}

/** Did this phone text STOP to the number a text from this tenant would come from (and not START since)? */
async function stopped(tenantId, phone, from = null) {
  const key = keyOf(phone);
  if (!key) return false;
  const scope = await scopeOf(tenantId, from);
  if (scope === null) return false;
  return Boolean(await one(pool, 'SELECT 1 AS y FROM sms_stops WHERE phone_hash = ? AND scope_tenant = ?', [hashOf(key), scope]));
}

/** For an import or sign-up at a municipality: did this phone text STOP to the number its texts come from? */
async function stoppedAt(tenantId, phone) {
  const s = await one(pool, 'SELECT from_number FROM street_notice_settings WHERE tenant_id = ?', [tenantId]).catch(() => null);
  return stopped(tenantId, phone, s && s.from_number ? s.from_number : null);
}

module.exports = { record, stopped, stoppedAt, hashOf };
