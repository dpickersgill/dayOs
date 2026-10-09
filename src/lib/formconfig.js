'use strict';

// Which incident form fields a mountain has made mandatory, and who may change that.
const { rows } = require('../db');
const { FIELDS } = require('./nsaar');
const patrolaccess = require('./patrolaccess');

/** Whether this person may change patrol settings (mandatory fields, map view, guest help): the manage_settings feature. */
async function isPatrolAdmin(pool, req) {
  return patrolaccess.can(pool, req, 'manage_settings');
}

/**
 * The mandatory fields for a mountain: { case: Set, patient: Set }.
 * A field with no saved choice follows the form's default (chief complaint and outcome are mandatory unless an
 * administrator switches them off); locked fields are decided by the form itself.
 */
async function requiredFields(conn, tenantId) {
  const saved = await rows(conn, 'SELECT scope, field_key, required FROM patrol_form_config WHERE tenant_id = ?', [tenantId]);
  const choice = new Map(saved.map((r) => [`${r.scope}.${r.field_key}`, Boolean(r.required)]));
  const out = { case: new Set(), patient: new Set() };
  for (const f of FIELDS) {
    if (f.locked) continue;
    const k = `${f.scope}.${f.key}`;
    const on = choice.has(k) ? choice.get(k) : Boolean(f.defaultRequired);
    if (on) out[f.scope].add(f.key);
  }
  return out;
}

module.exports = { isPatrolAdmin, requiredFields };
