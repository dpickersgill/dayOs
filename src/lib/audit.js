'use strict';

/**
 * A copy of every audit event in Cloud Logging, outside the database. With a log sink to a locked bucket (RUNBOOK.md,
 * "Audit trail"), nobody who can change the database, the app included, can change this copy.
 */
function trail(fields) {
  if (process.env.AUDIT_LOG_STDOUT === 'off') return;
  const entry = { severity: 'NOTICE', logName: 'summitops-audit', audit: true, at: new Date().toISOString(), ...fields };
  if (entry.detail && entry.detail.length > 2000) entry.detail = `${entry.detail.slice(0, 2000)}...`;
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

/** Append an audit row. `db` is the pool or a transaction connection so the audit commits with the change. */
async function audit(db, req, action, entity, entityId, detail) {
  const text = detail ? JSON.stringify(detail) : null;
  await db.query(
    'INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)',
    [req.auth.tenantId, req.auth.userId, action, entity, entityId ?? null, text],
  );
  trail({ tenant: req.auth.tenantId, user: req.auth.userId, action, entity, entity_id: entityId ?? null, detail: text, ip: req.ip || null });
}

module.exports = { audit, trail };
