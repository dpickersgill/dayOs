'use strict';

// The deletion ledger (2026.11.11). Every anonymise and every mountain deletion is one row here, and one line in Cloud
// Logging (the audit copy outside the database). A database restored from a backup is older than the ledger, so after any
// restore db/deletions.js applies every erasure again (RECOVERY.md, "After any restore").
const { trail } = require('./audit');

/** Records one erasure inside the caller's transaction. kind: 'anonymise' (ref = person id) or 'mountain' (ref = tenant id). */
async function record(conn, { tenantId, kind, refId, by }) {
  await conn.query('INSERT INTO deletion_ledger (tenant_id, kind, ref_id, done_by) VALUES (?, ?, ?, ?)', [tenantId, kind, refId, by == null ? null : String(by).slice(0, 100)]);
  trail({ tenant: tenantId, action: 'deletion_ledger', entity: kind, entity_id: refId, actor: by == null ? null : String(by).slice(0, 100) });
}

module.exports = { record };
