'use strict';

// The incident form definition and its settings. Everyone on patrol can read the form (the screens draw
// themselves from it) and the report requirements (the screens mark what is required, offline too); only the patrol
// director (the manage_settings feature: the patrol admin level, owners and managers) changes the requirements.
const express = require('express');
const { pool, tx, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate } = require('../lib/util');
const { bad, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { FIELDS, SECTIONS, describe } = require('../lib/nsaar');
const { isPatrolAdmin } = require('../lib/formconfig');
const RQ = require('../lib/requirements');

const router = express.Router();
const patrol = requireRole('patrol', 'manager');

router.get('/form', patrol, async (req, res) => {
  const [rules, tenant, admin] = await Promise.all([
    RQ.current(pool, req.auth.tenantId),
    one(pool, 'SELECT name, legal_name FROM tenants WHERE id = ?', [req.auth.tenantId]),
    isPatrolAdmin(pool, req),
  ]);
  // required: what an injury report must hold before it is submitted (kept for screens that only mark one list);
  // rules: every kind of case, every level, so the phone can mark fields and run the checklist with no signal.
  const submitLevel = (scope) => Object.entries(rules.rules.injury || {}).filter(([id, r]) => id.startsWith(`${scope}.`) && r.level === 'submit' && !(r.when || []).length).map(([id]) => id.slice(scope.length + 1));
  res.json({
    ...describe(), required: { case: submitLevel('case'), patient: submitLevel('patient') },
    rules: rules.rules, rules_version_id: rules.id, levels: RQ.LEVELS.map((l) => ({ value: l, label: RQ.LEVEL_LABEL[l] })), na_reasons: RQ.N_A.map(([value, label]) => ({ value, label })),
    resort: { name: tenant.name, legal_name: tenant.legal_name }, can_admin: admin,
  });
});

// ---------------------------------------------------------------- report requirements (the patrol director)
/** Everything the settings screen needs: the rules now, what each kind of case can require, the starting setups and the history. */
router.get('/requirements', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  const [now, hist, admin] = await Promise.all([RQ.current(pool, t), RQ.history(pool, t), isPatrolAdmin(pool, req)]);
  const sectionTitle = new Map([...SECTIONS.map((x) => [x.id, x.title]), ['report', 'Report']]);
  res.json({
    rules: now.rules, version: { id: now.id, preset: now.preset, changed_at: now.changed_at, changed_by: now.changed_by },
    types: RQ.TYPES.map(([key, label]) => ({
      key, label, patient_care: RQ.isCare(key), conditions: RQ.conditionsFor(key),
      items: RQ.itemsFor(key).map((i) => ({ id: i.id, scope: i.scope, key: i.key, section: i.section, section_title: sectionTitle.get(i.section) || i.section, label: i.label, locked: i.locked, when_field: i.field && i.field.when ? true : false })),
    })),
    levels: RQ.LEVELS.map((l) => ({ value: l, label: RQ.LEVEL_LABEL[l] })),
    presets: RQ.PRESETS, always: RQ.ALWAYS, history: hist, can_admin: admin,
  });
});

/** A starting setup, and what loading it would change, before anything is saved. */
router.get('/requirements/presets/:key', patrol, async (req, res) => {
  const rules = RQ.presetRules(req.params.key);
  if (!rules) throw bad('Unknown starting setup');
  const now = await RQ.current(pool, req.auth.tenantId);
  res.json({ rules, changes: RQ.diff(now.rules, rules) });
});

router.put('/requirements', patrol, validate(z.object({
  rules: z.object({ options: z.object({ leave: z.boolean() }).partial().optional() }).catchall(z.record(z.string().max(60), z.object({ level: z.string().max(12), when: z.array(z.string().max(20)).max(10).optional() }))),
  preset: z.string().max(20).nullable().optional(), note: z.string().trim().max(255).nullable().optional(),
})), async (req, res) => {
  if (!(await isPatrolAdmin(pool, req))) throw forbidden('Only the patrol director can change the report requirements');
  let rules;
  try { rules = RQ.clean(req.body.rules); } catch (err) { throw bad(err.message); }
  const preset = req.body.preset && RQ.PRESETS.some((p) => p.key === req.body.preset) ? req.body.preset : null;
  const id = await tx(async (conn) => {
    const before = await RQ.current(conn, req.auth.tenantId);
    const vid = await RQ.save(conn, req.auth.tenantId, req.auth.userId, rules, { preset, note: req.body.note || null });
    await audit(conn, req, 'set_requirements', 'patrol_rule_versions', vid, { preset, changes: RQ.diff(before.rules, rules).length });
    return vid;
  });
  res.json({ ok: true, version_id: id });
});

router.put(
  '/form-config',
  patrol,
  validate(z.object({ required: z.object({ case: z.array(z.string().max(40)).max(200), patient: z.array(z.string().max(40)).max(200) }).optional(), legal_name: z.string().max(255).nullable().optional() })),
  async (req, res) => {
    if (!(await isPatrolAdmin(pool, req))) throw forbidden('Only a manager or the patrol director can change which fields are mandatory');
    const { tenantId } = req.auth;
    if (!req.body.required) { // just the legal name
      if (req.body.legal_name !== undefined) await pool.query('UPDATE tenants SET legal_name = ? WHERE id = ?', [req.body.legal_name || null, tenantId]);
      await audit(pool, req, 'set_legal_name', 'tenants', tenantId);
      return res.json({ ok: true });
    }
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
      // Older screens tick mandatory fields for injury and medical reports: keep the report requirements in step.
      const now = await RQ.current(conn, tenantId);
      const next = { ...now.rules };
      for (const t of ['injury', 'medical']) {
        const kept = Object.fromEntries(Object.entries(now.rules[t] || {}).filter(([, r]) => r.level !== 'submit' || (r.when || []).length));
        for (const scope of ['case', 'patient']) for (const key of req.body.required[scope]) kept[`${scope}.${key}`] = { level: 'submit' };
        next[t] = kept;
      }
      await RQ.save(conn, tenantId, req.auth.userId, next, { note: 'Mandatory fields changed' });
      await audit(conn, req, 'set_form_config', 'patrol_form_config', null, { case: req.body.required.case.length, patient: req.body.required.patient.length });
    });
    res.json({ ok: true, sections: SECTIONS.length });
  },
);

module.exports = router;
