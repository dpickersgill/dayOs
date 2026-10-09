'use strict';

// The customer form definition and its settings. Anyone who sells or books reads the form (the screens draw
// themselves from it); only a manager or owner changes which details are mandatory.
const express = require('express');
const { pool, tx } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate } = require('../lib/util');
const { bad, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { FIELDS, BY_KEY, GROUPS, SCOPES, PURCHASER_KEY, requiredFor } = require('../lib/customers');

const router = express.Router();
const reader = requireRole('counter', 'instructor', 'manager');

router.get('/form', reader, async (req, res) => {
  const required = {};
  for (const scope of SCOPES) required[scope] = [...(await requiredFor(pool, req.auth.tenantId, scope))];
  res.json({ fields: FIELDS, groups: GROUPS, required, purchaser_key: PURCHASER_KEY, can_admin: ['owner', 'manager'].includes(req.auth.role) });
});

router.put(
  '/form-config',
  requireRole('manager'),
  validate(z.object({ required: z.object({ ticket: z.array(z.string().max(40)).max(50), lesson: z.array(z.string().max(40)).max(50) }) })),
  async (req, res) => {
    if (!['owner', 'manager'].includes(req.auth.role)) throw forbidden('Only a manager can change which details are mandatory');
    const { tenantId } = req.auth;
    for (const scope of SCOPES) {
      for (const key of req.body.required[scope]) {
        if (key === PURCHASER_KEY) { if (scope !== 'ticket') throw bad('The purchaser setting only applies to ticket sales'); continue; }
        const f = BY_KEY.get(key);
        if (!f) throw bad(`Unknown field: ${key}`);
        if (f.fixed) throw bad(`${f.label} cannot be switched ${f.fixed === 'required' ? '(it is always required)' : '(it cannot be made mandatory)'}`);
      }
    }
    await tx(async (conn) => {
      await conn.query('DELETE FROM customer_form_config WHERE tenant_id = ?', [tenantId]);
      for (const scope of SCOPES) {
        const keys = [...FIELDS.filter((f) => !f.fixed).map((f) => f.key), ...(scope === 'ticket' ? [PURCHASER_KEY] : [])];
        for (const key of keys) {
          await conn.query('INSERT INTO customer_form_config (tenant_id, scope, field_key, required) VALUES (?, ?, ?, ?)', [tenantId, scope, key, req.body.required[scope].includes(key) ? 1 : 0]);
        }
      }
      await audit(conn, req, 'set_form_config', 'customer_form_config', null, { ticket: req.body.required.ticket.length, lesson: req.body.required.lesson.length });
    });
    res.json({ ok: true });
  },
);

module.exports = router;
