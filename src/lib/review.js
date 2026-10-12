'use strict';

// Patrol case review. When a patroller signs off a report it goes to the review group: the Patrol Director and the
// backups the mountain names. The group chooses which kinds of case it reviews; any other kind is signed off without
// review. A reviewer approves it, sends it back with comments, or escalates it to the owner and managers. Nobody
// reviews a report they submitted themselves. New reports and nudges (after 72 hours by default) arrive in the
// group's own Inbox conversation; the patroller hears back in a one-to-one message.
//
// With no review group set up, the older rule applies: anyone whose patrol access level can approve reports does so.

const { pool, rows, one } = require('../db');
const PA = require('./patrolaccess');
const { nowIn } = require('./util');

const CATEGORIES = [['injury', 'Injury'], ['collision', 'Collision'], ['lost_person', 'Lost person'], ['equipment', 'Equipment'], ['medical', 'Medical'], ['conduct', 'Conduct'], ['other', 'Other']];
const CATEGORY_KEYS = CATEGORIES.map((c) => c[0]);
const CHECKS = [
  ['complete', 'Required fields and times are complete and in a sensible order'],
  ['objective', 'The narrative is objective: what was seen and done, no opinions or blame'],
  ['protocol', 'Treatment matches the protocol for what was found'],
  ['signatures', 'Signatures are in place (patroller, and patient or witness where needed)'],
  ['refusal', 'A refusal of care is signed, if care was refused'],
  ['collision', 'The collision report is done, if there was a collision'],
];
const CHECK_KEYS = CHECKS.map((c) => c[0]);
const SECTIONS = ['Patient', 'Complaint and treatment', 'Assessment', 'First aid', 'Location', 'Conditions', 'Activity and equipment', 'Cause', 'Transport', 'Narrative', 'Witnesses', 'Signatures', 'Timeline', 'Other'];
const THREAD_NAME = 'Patrol case review';

const caseNo = (i) => (i.seq ? `${i.season}-${String(i.seq).padStart(4, '0')}` : String(i.id));
const NAME = "COALESCE(NULLIF(TRIM(CONCAT(COALESCE(p.first_name, sp.first_name, ''), ' ', COALESCE(p.last_name, sp.last_name, ''))), ''), u.email)";
const USER_JOIN = 'LEFT JOIN people p ON p.tenant_id = u.tenant_id AND p.id = u.person_id LEFT JOIN staff s ON s.tenant_id = u.tenant_id AND s.id = u.staff_id LEFT JOIN people sp ON sp.tenant_id = s.tenant_id AND sp.id = s.person_id';
async function nameOf(db, tenantId, userId) {
  if (!userId) return null;
  const r = await one(db, `SELECT ${NAME} AS name FROM users u ${USER_JOIN} WHERE u.tenant_id = ? AND u.id = ?`, [tenantId, userId]);
  return r ? r.name : null;
}

/** The review group for a mountain. enabled = at least one reviewer. */
async function settingsOf(db, tenantId) {
  const s = await one(db, 'SELECT categories, nudge_hours, thread_id FROM patrol_review_settings WHERE tenant_id = ?', [tenantId]);
  const reviewers = await rows(db, `SELECT r.user_id, r.is_lead, ${NAME} AS name, u.role, u.active FROM patrol_reviewers r JOIN users u ON u.tenant_id = r.tenant_id AND u.id = r.user_id ${USER_JOIN}
    WHERE r.tenant_id = ? ORDER BY r.is_lead DESC, name`, [tenantId]);
  const active = reviewers.filter((r) => r.active);
  return {
    enabled: active.length > 0,
    categories: s ? String(s.categories || '').split(',').filter((c) => CATEGORY_KEYS.includes(c)) : [...CATEGORY_KEYS],
    nudge_hours: s ? Number(s.nudge_hours) : 72,
    thread_id: s ? s.thread_id : null,
    reviewers: reviewers.map((r) => ({ user_id: Number(r.user_id), name: r.name, role: r.role, lead: Boolean(r.is_lead), active: Boolean(r.active) })),
  };
}

const isMember = (settings, userId) => settings.reviewers.some((r) => r.user_id === userId && r.active);

/** May this login review reports? A member of the review group; with no group, the approve_case access level. */
async function canReview(db, req, settings) {
  const s = settings || await settingsOf(db, req.auth.tenantId);
  if (s.enabled) return isMember(s, req.auth.userId);
  return PA.can(pool, req, 'approve_case');
}

/** May this login change the review group? Patrol admins (owners, managers, patrol admin level) and its members. */
async function canManage(db, req, settings) {
  if ((await PA.levelOf(pool, req)) === 'admin') return true;
  const s = settings || await settingsOf(db, req.auth.tenantId);
  return isMember(s, req.auth.userId);
}

const needsReview = (settings, category) => !settings.enabled || settings.categories.includes(category);

// ---------------------------------------------------------------- Inbox messages
async function postSystem(conn, tenantId, threadId, text, refs = []) {
  if (!threadId) return;
  await conn.query('INSERT INTO chat_messages (tenant_id, thread_id, user_id, body, refs) VALUES (?, ?, NULL, ?, ?)', [tenantId, threadId, text, refs.length ? JSON.stringify(refs) : null]);
  await conn.query('UPDATE chat_threads SET last_message_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ?', [tenantId, threadId]);
}

/** A one-to-one message from one person to another (the same conversation they always share). */
async function direct(conn, tenantId, fromUser, toUser, text, refs = []) {
  if (!fromUser || !toUser || fromUser === toUser) return;
  const key = [fromUser, toUser].sort((a, b) => a - b).join(':');
  await conn.query("INSERT IGNORE INTO chat_threads (tenant_id, kind, direct_key, created_by) VALUES (?, 'direct', ?, ?)", [tenantId, key, fromUser]);
  const t = await one(conn, 'SELECT id FROM chat_threads WHERE tenant_id = ? AND direct_key = ?', [tenantId, key]);
  for (const u of [fromUser, toUser]) await conn.query('INSERT INTO chat_members (thread_id, tenant_id, user_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE left_at = NULL', [t.id, tenantId, u]);
  const [r] = await conn.query('INSERT INTO chat_messages (tenant_id, thread_id, user_id, body, refs) VALUES (?, ?, ?, ?, ?)', [tenantId, t.id, fromUser, text, refs.length ? JSON.stringify(refs) : null]);
  await conn.query('UPDATE chat_threads SET last_message_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ?', [tenantId, t.id]);
  await conn.query('UPDATE chat_members SET last_read_id = GREATEST(last_read_id, ?) WHERE tenant_id = ? AND thread_id = ? AND user_id = ?', [r.insertId, tenantId, t.id, fromUser]);
}

/**
 * Keep the group's Inbox conversation in step with the group: made the first time, members added (seeing it from
 * then on) and removed as the group changes.
 */
async function syncThread(conn, tenantId, byUser) {
  const s = await settingsOf(conn, tenantId);
  const ids = s.reviewers.filter((r) => r.active).map((r) => r.user_id);
  let threadId = s.thread_id;
  if (threadId && !(await one(conn, 'SELECT id FROM chat_threads WHERE tenant_id = ? AND id = ?', [tenantId, threadId]))) threadId = null;
  if (!threadId && ids.length) {
    const [r] = await conn.query("INSERT INTO chat_threads (tenant_id, kind, name, created_by) VALUES (?, 'group', ?, ?)", [tenantId, THREAD_NAME, byUser]);
    threadId = r.insertId;
    await conn.query('UPDATE patrol_review_settings SET thread_id = ? WHERE tenant_id = ?', [threadId, tenantId]);
  }
  if (!threadId) return null;
  const { top } = await one(conn, 'SELECT COALESCE(MAX(id), 0) AS top FROM chat_messages WHERE tenant_id = ? AND thread_id = ?', [tenantId, threadId]);
  const current = new Set((await rows(conn, 'SELECT user_id FROM chat_members WHERE tenant_id = ? AND thread_id = ? AND left_at IS NULL', [tenantId, threadId])).map((r) => Number(r.user_id)));
  for (const u of ids) {
    if (current.has(u)) continue;
    await conn.query(`INSERT INTO chat_members (thread_id, tenant_id, user_id, visible_from_id, last_read_id) VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE left_at = NULL, visible_from_id = VALUES(visible_from_id), last_read_id = VALUES(last_read_id)`, [threadId, tenantId, u, top, top]);
  }
  for (const u of current) if (!ids.includes(u)) await conn.query('UPDATE chat_members SET left_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND thread_id = ? AND user_id = ?', [tenantId, threadId, u]);
  return threadId;
}

/** Called inside the sign-off transaction. Returns 'review' (sent to the group) or 'not_required' (signed off). */
async function afterSubmit(conn, req, inc, now) {
  const s = await settingsOf(conn, req.auth.tenantId);
  if (!s.enabled) return 'review';
  const link = [{ type: 'patrol_case', id: inc.id }];
  if (!needsReview(s, inc.category)) {
    await conn.query("UPDATE incidents SET report_state = 'approved', status = 'closed', approved_by = NULL, approved_at = ?, review_round = review_round + 1, returned_at = NULL, returned_by = NULL, escalated_at = NULL, escalated_by = NULL, escalation_note = NULL WHERE tenant_id = ? AND id = ?", [now, inc.tenant_id, inc.id]);
    await conn.query("INSERT INTO incident_reviews (tenant_id, incident_id, round, outcome, note) VALUES (?, ?, ?, 'not_required', ?)", [inc.tenant_id, inc.id, (inc.review_round || 0) + 1, `The review group does not review ${inc.category.replace('_', ' ')} cases`]);
    return 'not_required';
  }
  // a new round: the last round's "changes requested" and escalation are done with
  await conn.query('UPDATE incidents SET review_round = review_round + 1, last_nudge_at = NULL, returned_at = NULL, returned_by = NULL, escalated_at = NULL, escalated_by = NULL, escalation_note = NULL WHERE tenant_id = ? AND id = ?', [inc.tenant_id, inc.id]);
  const who = await nameOf(conn, inc.tenant_id, req.auth.userId);
  const again = inc.returned_at ? ' (corrected and signed again)' : '';
  await postSystem(conn, inc.tenant_id, s.thread_id, `${who || 'A patroller'} signed off Case ${caseNo(inc)}${again}: ${inc.severity} ${inc.category.replace('_', ' ')}. Waiting for review.`, link);
  return 'review';
}

async function record(conn, inc, outcome, reviewer, { checklist = null, comments = null, note = null } = {}) {
  await conn.query('INSERT INTO incident_reviews (tenant_id, incident_id, round, outcome, reviewer_user, checklist, comments, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [inc.tenant_id, inc.id, Math.max(1, inc.review_round || 0), outcome, reviewer, checklist ? JSON.stringify(checklist) : null, comments ? JSON.stringify(comments) : null, note]);
}

/** What the case page needs: is review set up, may this reader review, has it been sent back, and the review log. */
async function caseInfo(db, req, c) {
  const s = await settingsOf(db, req.auth.tenantId);
  const log = await rows(db, `SELECT r.id, r.round, r.outcome, r.checklist, r.comments, r.note, r.created_at, ${NAME} AS reviewer
    FROM incident_reviews r LEFT JOIN users u ON u.tenant_id = r.tenant_id AND u.id = r.reviewer_user ${USER_JOIN} WHERE r.tenant_id = ? AND r.incident_id = ? ORDER BY r.id`, [req.auth.tenantId, c.id]);
  const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch (_) { return null; } };
  const history = log.map((r) => ({ ...r, checklist: parse(r.checklist), comments: parse(r.comments) }));
  const lastReturn = [...history].reverse().find((r) => r.outcome === 'returned');
  const mayReview = await canReview(db, req, s);
  return {
    group: s.enabled,
    required: needsReview(s, c.category),
    can_review: mayReview && c.report_state === 'submitted',
    can_reopen: mayReview && c.report_state === 'approved',
    own_report: Boolean(c.submitted_by && Number(c.submitted_by) === req.auth.userId),
    changes_requested: c.report_state === 'draft' && lastReturn && c.returned_at ? { by: lastReturn.reviewer, at: lastReturn.created_at, comments: lastReturn.comments || [], note: lastReturn.note } : null,
    // the reason for an escalation (a possible claim, say) is for reviewers, the owner and managers, not the patroller
    escalated: c.escalated_at && (mayReview || ['owner', 'manager'].includes(req.auth.role)) ? { at: c.escalated_at, note: c.escalation_note, by: await nameOf(db, req.auth.tenantId, c.escalated_by) } : null,
    signed_again: c.report_state === 'submitted' && history.length > 0 && history[history.length - 1].outcome === 'returned',
    checks: CHECKS.map(([key, label]) => ({ key, label })),
    sections: SECTIONS,
    history,
  };
}

// ---------------------------------------------------------------- nudges
const localMinus = (local, hours) => new Date(Date.parse(`${local.replace(' ', 'T')}Z`) - hours * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');

/** Remind the group of reports that have waited nudge_hours or more (again every nudge_hours until they are reviewed). */
async function nudgeTenant(tenantId) {
  const s = await settingsOf(pool, tenantId);
  if (!s.enabled || !s.thread_id) return 0;
  const t = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const now = nowIn(t.timezone);
  const cutoff = localMinus(now, s.nudge_hours);
  // Every report still waiting, whatever its kind (one submitted before the group changed its kinds still needs a decision).
  const candidates = await rows(pool, `SELECT id FROM incidents WHERE tenant_id = ? AND report_state = 'submitted' AND submitted_at <= ?
    AND (last_nudge_at IS NULL OR last_nudge_at <= ?) ORDER BY submitted_at LIMIT 50`, [tenantId, cutoff, cutoff]);
  if (!candidates.length) return 0;
  // Claim them with a stamp only this run uses, so two servers never remind about the same report twice.
  const stamp = `${now.slice(0, 17)}${String(Math.floor(Math.random() * 60)).padStart(2, '0')}`;
  await pool.query(`UPDATE incidents SET last_nudge_at = ? WHERE tenant_id = ? AND id IN (?) AND report_state = 'submitted' AND (last_nudge_at IS NULL OR last_nudge_at <= ?)`, [stamp, tenantId, candidates.map((d) => d.id), cutoff]);
  const due = await rows(pool, 'SELECT id, season, seq, category, submitted_at FROM incidents WHERE tenant_id = ? AND id IN (?) AND last_nudge_at = ? ORDER BY submitted_at', [tenantId, candidates.map((d) => d.id), stamp]);
  if (!due.length) return 0; // another server got there first
  const list = due.slice(0, 5);
  const more = due.length > 5 ? ` and ${due.length - 5} more` : '';
  await postSystem(pool, tenantId, s.thread_id, `Reminder: ${due.length} report${due.length === 1 ? ' has' : 's have'} been waiting for review for ${s.nudge_hours} hours or more: Case ${list.map(caseNo).join(', Case ')}${more}.`,
    list.map((d) => ({ type: 'patrol_case', id: d.id })));
  return due.length;
}

// Checked whenever people are using the app (at most every 10 minutes per mountain), and by the daily job.
const lastCheck = new Map();
function maybeNudge(tenantId) {
  const now = Date.now();
  if (now - (lastCheck.get(tenantId) || 0) < 10 * 60_000) return;
  lastCheck.set(tenantId, now);
  nudgeTenant(tenantId).catch((err) => console.error(JSON.stringify({ severity: 'ERROR', job: 'review_nudge', tenant: tenantId, message: err.message })));
}

async function nudgeAll() {
  const list = await rows(pool, "SELECT DISTINCT r.tenant_id FROM patrol_reviewers r JOIN tenants t ON t.id = r.tenant_id WHERE t.status = 'active'");
  let n = 0;
  for (const r of list) n += await nudgeTenant(Number(r.tenant_id)).catch(() => 0);
  return { nudged: n };
}

module.exports = {
  CATEGORIES, CATEGORY_KEYS, CHECKS, CHECK_KEYS, SECTIONS, THREAD_NAME,
  settingsOf, canReview, canManage, needsReview, syncThread, afterSubmit, record, caseInfo, direct, postSystem, nameOf, caseNo,
  nudgeTenant, maybeNudge, nudgeAll,
};
