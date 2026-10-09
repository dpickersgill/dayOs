'use strict';

// The incident form definition and its settings. Everyone on patrol can read the form (the screens draw
// themselves from it); only a patrol administrator can change which fields are mandatory.
const express = require('express');
const { pool, tx, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate } = require('../lib/util');
const { bad, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { FIELDS, SECTIONS, describe } = require('../lib/nsaar');
const { isPatrolAdmin, requiredFields } = require('../lib/formconfig');

const router = express.Router();
const patrol = requireRole('patrol', 'manager');

router.get('/form', patrol, async (req, res) => {
  const [req_, tenant, admin] = await Promise.all([
    requiredFields(pool, req.auth.tenantId),
    one(pool, 'SELECT name, legal_name FROM tenants WHERE id = ?', [req.auth.tenantId]),
    isPatrolAdmin(pool, req),
  ]);
  res.json({ ...describe(), required: { case: [...req_.case], patient: [...req_.patient] }, resort: { name: tenant.name, legal_name: tenant.legal_name }, can_admin: admin });
});

router.put(
  '/form-config',
  patrol,
  validate(z.object({ required: z.object({ case: z.array(z.string().max(40)).max(200), patient: z.array(z.string().max(40)).max(200) }), legal_name: z.string().max(255).nullable().optional() })),
  async (req, res) => {
    if (!(await isPatrolAdmin(pool, req))) throw forbidden('Only a manager or the patrol director can change which fields are mandatory');
    const { tenantId } = req.auth;
    for (const scope of ['case', 'patient']) {
      for (const key of req.body.required[scope]) {
        const f = FIELDS.find((x) => x.scope === scope && x.key === key);
        if (!f) throw bad(`Unknown field: ${key}`);
        if (f.locked) throw bad(`${f.label} cannot be switched ${f.locked === 'always' ? '(it is always required)' : '(it cannot be made mandatory)'}`);
      }
    }
    await tx(async (conn) => {
      await conn.query('DELETE FROM patrol_form_config WHERE tenant_id = ?', [tenantId]);
      for (const f of FIELDS) {
        if (f.locked) continue;
        await conn.query('INSERT INTO patrol_form_config (tenant_id, scope, field_key, required) VALUES (?, ?, ?, ?)', [tenantId, f.scope, f.key, req.body.required[f.scope].includes(f.key) ? 1 : 0]);
      }
      if (req.body.legal_name !== undefined) await conn.query('UPDATE tenants SET legal_name = ? WHERE id = ?', [req.body.legal_name || null, tenantId]);
      await audit(conn, req, 'set_form_config', 'patrol_form_config', null, { case: req.body.required.case.length, patient: req.body.required.patient.length });
    });
    res.json({ ok: true, sections: SECTIONS.length });
  },
);

module.exports = router;
