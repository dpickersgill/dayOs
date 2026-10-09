'use strict';

/** Append an audit row. `db` is the pool or a transaction connection so the audit commits with the change. */
async function audit(db, req, action, entity, entityId, detail) {
  await db.query(
    'INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)',
    [req.auth.tenantId, req.auth.userId, action, entity, entityId ?? null, detail ? JSON.stringify(detail) : null],
  );
}

module.exports = { audit };
