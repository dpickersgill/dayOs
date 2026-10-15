'use strict';

// Patrol case review, the group's side (mounted under /patrol): who is in the review group, which kinds of case it
// reviews, how long before a nudge, and the queue of reports waiting. Patrol admins (owner, managers, patrol admin
// level) and the group's own members can change the group. Review decisions themselves are in routes/patrol.js.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, nowIn } = require('../lib/util');
const { bad, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const R = require('../lib/review');

const router = express.Router();
const patrol = requireRole('patrol', 'manager');

router.get('/review/settings', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  const s = await R.settingsOf(pool, t);
  const canEdit = await R.canManage(pool, req, s);
  // Who could be in the group: anyone who can open Patrol (patrol logins, owners and managers).
  const candidates = canEdit ? await rows(pool, `SELECT u.id, COALESCE(NULLIF(TRIM(CONCAT(COALESCE(p.first_name, sp.first_name, ''), ' ', COALESCE(p.last_name, sp.last_name, ''))), ''), u.email, u.username) AS name, u.role
      FROM users u LEFT JOIN people p ON p.tenant_id = u.tenant_id AND p.id = u.person_id LEFT JOIN staff st ON st.tenant_id = u.tenant_id AND st.id = u.staff_id LEFT JOIN people sp ON sp.tenant_id = st.tenant_id AND sp.id = st.person_id
      WHERE u.tenant_id = ? AND u.active = 1 AND u.role IN ('owner','manager','patrol') ORDER BY name`, [t]) : [];
  res.json({
    ...s, can_edit: canEdit, me_in_group: s.reviewers.some((r) => r.user_id === req.auth.userId && r.active),
    all_categories: R.CATEGORIES.map(([value, label]) => ({ value, label })),
    // current members who can no longer open Patrol are listed too, so they can be taken off
    candidates: [...candidates.map((c) => ({ id: Number(c.id), name: c.name, role: c.role })), ...s.reviewers.filter((r) => !candidates.some((c) => Number(c.id) === r.user_id)).map((r) => ({ id: r.user_id, name: r.name, role: r.active ? r.role : 'no longer signs in', stale: true }))],
  });
});

router.put('/review/settings', patrol, validate(z.object({
  reviewers: z.array(z.object({ user_id: z.number().int().positive(), lead: z.boolean().default(false) })).max(30),
  categories: z.array(z.enum(R.CATEGORY_KEYS)).max(R.CATEGORY_KEYS.length),
  nudge_hours: z.number().int().min(1).max(720).default(72),
})), async (req, res) => {
  const t = req.auth.tenantId;
  const b = req.body;
  if (!(await R.canManage(pool, req))) throw forbidden('Only a patrol admin or a member of the review group can change it');
  const ids = [...new Set(b.reviewers.map((r) => r.user_id))];
  if (b.reviewers.filter((r) => r.lead).length > 1) throw bad('Choose one Patrol Director');
  if (ids.length) {
    const ok = await rows(pool, "SELECT id FROM users WHERE tenant_id = ? AND active = 1 AND role IN ('owner','manager','patrol') AND id IN (?)", [t, ids]);
    if (ok.length !== ids.length) throw bad('Everyone in the review group needs an active login that can open Patrol');
  }
  if (ids.length && !b.categories.length) throw bad('Choose at least one kind of case to review, or remove everyone to turn review off');
  if (!ids.length && (await R.settingsOf(pool, t)).enabled && (await require('../lib/patrolaccess').levelOf(pool, req)) !== 'admin') throw forbidden('Only a patrol admin can turn review off');
  await tx(async (conn) => {
    await conn.query('INSERT INTO patrol_review_settings (tenant_id, categories, nudge_hours, updated_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE categories = VALUES(categories), nudge_hours = VALUES(nudge_hours), updated_by = VALUES(updated_by)',
      [t, b.categories.join(','), b.nudge_hours, req.auth.userId]);
    await conn.query('DELETE FROM patrol_reviewers WHERE tenant_id = ?', [t]);
    for (const r of b.reviewers) await conn.query('INSERT IGNORE INTO patrol_reviewers (tenant_id, user_id, is_lead) VALUES (?, ?, ?)', [t, r.user_id, r.lead ? 1 : 0]);
    await R.syncThread(conn, t, req.auth.userId);
    await audit(conn, req, 'review_group', 'patrol_review_settings', t, { reviewers: ids, categories: b.categories, nudge_hours: b.nudge_hours });
  });
  res.json(await R.settingsOf(pool, t));
});

/** Reports waiting for the review group, oldest first, with how long each has waited. */
router.get('/review/queue', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  const s = await R.settingsOf(pool, t);
  if (!(await R.canReview(pool, req, s))) return res.json({ data: [], can_review: false });
  const tz = (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone;
  const now = Date.parse(`${nowIn(tz).replace(' ', 'T')}Z`);
  // Every report waiting, whatever its kind: one submitted before the group changed its kinds still needs a decision.
  const list = await rows(pool, `SELECT i.id, i.season, i.seq, i.occurred_at, i.location, i.category, i.severity, i.summary, i.submitted_at, i.submitted_by, i.escalated_at, i.review_round,
      COALESCE(NULLIF(TRIM(CONCAT(COALESCE(p.first_name, sp.first_name, ''), ' ', COALESCE(p.last_name, sp.last_name, ''))), ''), u.email, u.username) AS submitted_by_name
    FROM incidents i LEFT JOIN users u ON u.tenant_id = i.tenant_id AND u.id = i.submitted_by
      LEFT JOIN people p ON p.tenant_id = u.tenant_id AND p.id = u.person_id LEFT JOIN staff st ON st.tenant_id = u.tenant_id AND st.id = u.staff_id LEFT JOIN people sp ON sp.tenant_id = st.tenant_id AND sp.id = st.person_id
    WHERE i.tenant_id = ? AND i.report_state = 'submitted' ORDER BY i.submitted_at LIMIT 200`, [t]);
  res.json({
    can_review: true, nudge_hours: s.nudge_hours,
    data: list.map((r) => ({
      id: r.id, case_number: R.caseNo(r), occurred_at: r.occurred_at, location: r.location, category: r.category, severity: r.severity, summary: r.summary,
      submitted_at: r.submitted_at, submitted_by: r.submitted_by_name, own: Number(r.submitted_by) === req.auth.userId,
      waiting_hours: r.submitted_at ? Math.max(0, Math.floor((now - Date.parse(`${String(r.submitted_at).replace(' ', 'T')}Z`)) / 3_600_000)) : null,
      escalated: Boolean(r.escalated_at), round: r.review_round,
    })),
  });
});

module.exports = router;
