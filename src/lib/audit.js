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

/**
 * The audit trail holds what was done, to which record, by whom: field names and ids, never what someone typed about a
 * person (2026.11.11, CR-3). It is copied to Cloud Logging, outside the database's access controls and deletion. So
 * whatever a caller passes, typed free text and personal details are taken out here (the field's name is kept, under
 * text_fields) and any other text is cut short. A short override reason (why a manager went over a limit) is kept.
 */
const FREE_TEXT = /^(description|descr|note|notes|[a-z_]*_notes?|narrative|complaint|chief_complaint|allergies|allergy|medical|medical_history|medications?|assessment|summary|findings|mechanism|symptoms|treatments?|condition|history|statement|signature|comments?|body|text|message|caption|pickup|instructions|safety|health|diagnosis|injury|injuries|first_name|last_name|full_name|[a-z_]*_(?:first|last|full)_name|caller_name|requester_name|employee_name|patient_name|guardian_name|signer_name|[a-z_]*contact_name|phone|mobile|[a-z_]*_(?:phone|mobile|email|address)|email|address|street|home_town|date_of_birth|dob|last_oral_intake|destination|resolution|refusal_[a-z_]*|fa_[a-z_]*|void_reason)$/i;
const MAX_TEXT = 200;
function clean(v, depth = 0, dropped = new Set()) {
  if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT)}...` : v;
  if (depth > 4) return '[nested]';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clean(x, depth + 1, dropped));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (FREE_TEXT.test(k) && (typeof x === 'string' || (x && typeof x === 'object'))) { dropped.add(k); continue; } // a number (a note's id) stays
      out[k] = clean(x, depth + 1, dropped);
    }
    return out;
  }
  return String(v).slice(0, MAX_TEXT);
}
/** The detail as it may be kept: free text and personal details out (named under text_fields), the rest cut short. */
function safeDetail(detail) {
  if (detail === null || detail === undefined) return null;
  const dropped = new Set();
  let out = clean(detail, 0, dropped);
  if (dropped.size) out = Array.isArray(out) || typeof out !== 'object' ? { value: out, text_fields: [...dropped] } : { ...out, text_fields: [...dropped] };
  return out;
}

/**
 * Which sign-in and which address an action came from, without keeping either (2026.11.11, DP-10): the session part is the
 * start of the session's own id hash (user_sessions.id_hash begins with it), so after a stolen token the rows of that one
 * session can be told from the real user's; the address part is a keyed hash, the same for the same address.
 */
const crypto = require('crypto');
const sessionTag = (req) => (req.auth && req.auth.sid ? crypto.createHash('sha256').update(String(req.auth.sid)).digest('hex').slice(0, 16) : null);
const addressTag = (req) => (req.ip ? crypto.createHmac('sha256', require('../config').linkSecret).update(`ip:${req.ip}`).digest('hex').slice(0, 16) : null);

/** Append an audit row. `db` is the pool or a transaction connection so the audit commits with the change. */
async function audit(db, req, action, entity, entityId, detail) {
  const safe = safeDetail(detail);
  const text = safe ? JSON.stringify(safe) : null;
  const session = sessionTag(req); const address = addressTag(req);
  await db.query(
    'INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, detail, session_hash, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [req.auth.tenantId, req.auth.userId, action, entity, entityId ?? null, text, session, address],
  );
  trail({ tenant: req.auth.tenantId, user: req.auth.userId, action, entity, entity_id: entityId ?? null, detail: text, ip: req.ip || null, session });
}

module.exports = { audit, trail, safeDetail };
