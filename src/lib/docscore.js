'use strict';

// The documentation score: how complete a patrol's reports are against the patrol's own report requirements, how
// quickly they are submitted, and how red-flag cases were handled. For the patrol director, the owner, and (as counts
// only) the season risk report a broker sees at insurance renewal.
//
// Per report: the items the patrol director requires to submit or to approve that apply to this case (lib/requirements),
// answered or marked N/A with a reason, as a percentage. With nothing required, the recommended items are used instead;
// with nothing set at all there is no score. Approving with an exception does not count as answered: the item is still
// missing, the exception only explains why.
//
// A red-flag case is one an insurer would want to hear about: serious or critical, a lift involved, a patient under 18,
// on legal hold, or with a records request from an insurer, attorney or court. The who-was-told log shows whether
// management and the insurer were told.

const { rows } = require('../db');
const RQ = require('./requirements');
const { seasonFor } = require('./util');

const ON_TIME_HOURS = 24;
const REVIEW_OVERDUE_HOURS = 72;
const CLAIM_KINDS = ['insurer', 'attorney', 'court'];
const FLAG_LABEL = { serious: 'Serious or critical', lift: 'A lift involved', minor: 'Patient under 18', legal_hold: 'On legal hold', claim: 'Records request from an insurer, attorney or court' };

const toMs = (v) => (v ? Date.parse(`${String(v).replace(' ', 'T').slice(0, 19)}Z`) : null);
const hoursBetween = (a, b) => (a && b ? Math.round(((toMs(b) - toMs(a)) / 3_600_000) * 10) / 10 : null);
const told = (c, who) => (c.contacts || []).some((x) => !x.voided_at && x.who === who);

/** The score of one loaded case (routes/patrol.js loadCase). */
async function forCase(db, tenantId, c) {
  const set = c.report_state === 'draft' || !c.rules_version_id ? await RQ.current(db, tenantId) : await RQ.version(db, tenantId, c.rules_version_id);
  const items = RQ.evaluate(set.rules, c, { exceptions: c.exceptions || [] });
  const required = items.filter((i) => ['submit', 'approve'].includes(i.level));
  const base = required.length ? required : items.filter((i) => i.level === 'recommended');
  const met = base.filter((i) => i.met).length;
  const requests = await rows(db, 'SELECT requester_kind FROM patrol_records_requests WHERE tenant_id = ? AND incident_id = ?', [tenantId, c.id]).catch(() => []);
  const flags = [];
  if (['serious', 'critical'].includes(c.severity)) flags.push('serious');
  if (c.lift_id) flags.push('lift');
  if (RQ.conditionHolds('minor', c, null)) flags.push('minor');
  if (Number(c.legal_hold)) flags.push('legal_hold');
  if (requests.some((r) => CLAIM_KINDS.includes(r.requester_kind))) flags.push('claim');
  const hours = hoursBetween(c.occurred_at, c.submitted_at);
  return {
    score: base.length ? Math.round((met / base.length) * 100) : null,
    basis: required.length ? 'required' : base.length ? 'recommended' : 'none',
    items: base.length, answered: met,
    missing: base.filter((i) => !i.met).map((i) => ({ message: RQ.message(i), level: i.level, exception: Boolean(i.exception) })),
    na: items.filter((i) => i.na).length,
    skips: (c.skips || []).length,
    exceptions: (c.exceptions || []).length,
    hours_to_submit: hours,
    on_time: hours === null ? null : hours <= ON_TIME_HOURS,
    red_flags: flags.map((key) => ({ key, label: FLAG_LABEL[key] })),
    told: { management: told(c, 'management'), insurer: told(c, 'insurer'), parent: told(c, 'parent'), ems: told(c, 'ems') },
    state: c.report_state,
  };
}

/** What makes a case's score change: its state, its times, its rules, and its who-was-told log and requests. */
const stampOf = (r) => [r.report_state, r.submitted_at, r.approved_at, r.review_round, r.rules_version_id, r.told_n, r.req_n, r.legal_hold].map((x) => (x === null || x === undefined ? '' : String(x))).join('|').slice(0, 80);

/**
 * The season: every submitted or approved report from August to July, scored once per state and kept
 * (incident_doc_scores). loadCase is passed in (routes/patrol.js) so this library does not depend on the route.
 */
async function season(db, tenantId, { season: s, today, loadCase }) {
  const y = Number(s.slice(0, 4));
  const from = `${y}-08-01 00:00:00`; const to = `${y + 1}-08-01 00:00:00`;
  const list = await rows(db, `SELECT i.id, i.season, i.seq, i.occurred_at, i.category, i.severity, i.report_state, i.submitted_at, i.approved_at, i.review_round, i.rules_version_id, i.legal_hold,
      (SELECT COUNT(*) FROM incident_contacts x WHERE x.tenant_id = i.tenant_id AND x.incident_id = i.id) AS told_n,
      (SELECT COUNT(*) FROM patrol_records_requests q WHERE q.tenant_id = i.tenant_id AND q.incident_id = i.id) AS req_n,
      d.stamp, d.score, d.detail
    FROM incidents i LEFT JOIN incident_doc_scores d ON d.tenant_id = i.tenant_id AND d.incident_id = i.id
    WHERE i.tenant_id = ? AND i.occurred_at >= ? AND i.occurred_at < ? ORDER BY i.occurred_at`, [tenantId, from, to]);
  const reports = [];
  for (const r of list.filter((x) => x.report_state !== 'draft')) {
    let detail = null;
    if (r.stamp === stampOf(r) && r.detail) { try { detail = JSON.parse(r.detail); } catch (_) { detail = null; } }
    if (!detail) {
      const c = await loadCase(db, tenantId, r.id);
      if (!c) continue;
      detail = await forCase(db, tenantId, c);
      await db.query('INSERT INTO incident_doc_scores (tenant_id, incident_id, stamp, score, detail) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE stamp = VALUES(stamp), score = VALUES(score), detail = VALUES(detail), computed_at = CURRENT_TIMESTAMP',
        [tenantId, r.id, stampOf(r), detail.score, JSON.stringify(detail)]);
    }
    reports.push({ id: Number(r.id), case_number: r.seq ? `${r.season}-${String(r.seq).padStart(4, '0')}` : `Case ${r.id}`, occurred_at: r.occurred_at, category: r.category, severity: r.severity, state: r.report_state, submitted_at: r.submitted_at, ...detail });
  }
  const scored = reports.filter((r) => r.score !== null);
  const timed = reports.filter((r) => r.hours_to_submit !== null);
  const sortedHours = timed.map((r) => r.hours_to_submit).sort((a, b) => a - b);
  const nowMs = toMs(today.length > 10 ? today : `${today} 12:00:00`);
  const overdue = reports.filter((r) => r.state === 'submitted' && r.submitted_at && (nowMs - toMs(r.submitted_at)) / 3_600_000 > REVIEW_OVERDUE_HOURS);
  const drafts = list.filter((x) => x.report_state === 'draft');
  const oldDrafts = drafts.filter((x) => (nowMs - toMs(x.occurred_at)) / 3_600_000 > ON_TIME_HOURS);
  const flagged = reports.filter((r) => r.red_flags.length);
  const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);
  return {
    season: s,
    reports: reports.length,
    drafts: drafts.length,
    drafts_late: oldDrafts.length,
    score: scored.length ? Math.round(scored.reduce((n, r) => n + r.score, 0) / scored.length) : null,
    complete: scored.filter((r) => r.score === 100).length,
    on_time_pct: pct(timed.filter((r) => r.on_time).length, timed.length),
    median_hours: sortedHours.length ? sortedHours[Math.floor((sortedHours.length - 1) / 2)] : null,
    reviews_overdue: overdue.length,
    red_flags: flagged.length,
    red_flags_management: flagged.filter((r) => r.told.management).length,
    red_flags_insurer: flagged.filter((r) => r.told.insurer).length,
    exceptions: reports.reduce((n, r) => n + r.exceptions, 0),
    na: reports.reduce((n, r) => n + r.na, 0),
    cases: reports,
    rules: { on_time_hours: ON_TIME_HOURS, review_overdue_hours: REVIEW_OVERDUE_HOURS },
  };
}

/** The brief, no case list: what a dashboard or a broker sees. */
const brief = (s) => { const { cases, ...rest } = s; void cases; return rest; };

const currentSeason = (today) => seasonFor(today.slice(0, 10));

module.exports = { ON_TIME_HOURS, REVIEW_OVERDUE_HOURS, FLAG_LABEL, forCase, season, brief, stampOf, currentSeason, hoursBetween };
