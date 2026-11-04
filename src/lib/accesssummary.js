'use strict';

// The weekly patient-record access summary (feat/auth-hardening). One email on Monday morning, in the mountain's time
// zone, to the owner and the patrol Admins (a real roster row at Admin): how many patient care records were opened last
// week, and every open that was not of a case the person created and is working on in their shift. That includes opens
// after a fresh check, opens by an exception (responder, sent to the call, on duty, crew, a self-added responder) and
// writing access to the person's own drafts older than 12 hours. One line per person and case: what was opened (the
// case, photos, signatures, the scene, the report check), how often, how it was allowed and whether a fresh check was
// used. Case numbers and dates only: never a patient's name or any detail of their care. A link goes to the access log.
// Runs from the daily job (Monday, or the next two days if the job missed Monday), once a week. Only the owner can turn
// it off (Settings, Patrol, Patient record access); the owner is emailed if anyone else changes the setting.
const { pool, one, rows } = require('../db');
const mailer = require('./mailer');
const { todayIn, addDays, dayRange } = require('./util');
const { weekStartOf } = require('./weekly');
const { eachTenant } = require('./jobs');
const { isSandbox } = require('./sandbox');
const PX = require('./patientaccess');

// What is listed comes from one place: every audit row about a case that passed the patient-record rule carries how it
// was allowed (lib/audit.js adds req.patientAccess to it), so every read or change of a case through Patrol, the area
// login, a records request or a witness link is here, whatever its action is called. Rows that show a case without that
// rule (a chat link preview, an outside claim-file link being opened) are listed by name in PX.ALSO_LISTED.
const WHAT = PX.ACTION_LABELS;
const HOW = { no_rule: 'a preview in a message', outside_link: 'an outside link', checked: 'fresh check', responder: 'responder', responder_self: 'added themselves as responder', dispatched: 'sent to the call', on_duty: 'on duty', crew: 'crew', writing: 'own draft, older than 12 hours', wrote: 'wrote it' };

const caseNo = (r) => (r.seq ? `${r.season}-${String(r.seq).padStart(4, '0')}` : `Case ${r.incident_id}`);
const parse = (d) => { if (!d) return {}; if (typeof d === 'object') return d; try { return JSON.parse(d); } catch (_) { return {}; } };

/** Last week's summary for one mountain. weekStart: the Monday (YYYY-MM-DD) the week began, in the mountain's time. */
async function build(tenantId, weekStart) {
  const t = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const [from] = dayRange(t.timezone, weekStart);
  const [to] = dayRange(t.timezone, addDays(weekStart, 7));
  const list = await rows(pool, `SELECT a.user_id, a.action, a.entity_id AS incident_id, a.detail, a.at, i.season, i.seq, i.created_at,
      COALESCE(NULLIF(TRIM(CONCAT(COALESCE(p.first_name, sp.first_name, ''), ' ', COALESCE(p.last_name, sp.last_name, ''))), ''), u.email, u.username) AS who
    FROM audit_log a JOIN incidents i ON i.tenant_id = a.tenant_id AND i.id = a.entity_id
      LEFT JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.user_id LEFT JOIN people p ON p.tenant_id = u.tenant_id AND p.id = u.person_id
      LEFT JOIN staff st ON st.tenant_id = u.tenant_id AND st.id = u.staff_id LEFT JOIN people sp ON sp.tenant_id = st.tenant_id AND sp.id = st.person_id
    WHERE a.tenant_id = ? AND a.entity = 'incidents' AND (JSON_EXTRACT(a.detail, '$.access') IS NOT NULL OR a.action IN (?)) AND a.at >= ? AND a.at < ? ORDER BY a.at`, [tenantId, PX.ALSO_LISTED, from, to]);
  const records = new Set(list.map((r) => `${r.user_id}|${r.incident_id}`));
  const lines = new Map();
  for (const r of list) {
    const d = parse(r.detail);
    const access = d.access || (r.user_id ? 'no_rule' : 'outside_link');
    if (access === 'wrote') continue; // their own recent work
    if (access === 'writing' && Date.parse(`${String(r.at).replace(' ', 'T')}Z`) - Date.parse(`${String(r.created_at).replace(' ', 'T')}Z`) <= PX.CASE_HOURS * 3_600_000) continue;
    const key = `${r.user_id}|${r.incident_id}`;
    if (!lines.has(key)) lines.set(key, { who: r.who || (r.user_id ? 'Unknown login' : `Outside link${d.shared_with ? ` (${String(d.shared_with).slice(0, 60)})` : ''}`), user_id: Number(r.user_id), case_number: caseNo(r), first_at: r.at, last_at: r.at, times: 0, what: new Set(), how: new Set(), fresh: false });
    const l = lines.get(key);
    l.times += 1; l.last_at = r.at; l.what.add(WHAT[r.action] || r.action); l.how.add(access); if (d.fresh) l.fresh = true;
  }
  return {
    week_start: weekStart, week_end: addDays(weekStart, 6), opened: records.size,
    entries: [...lines.values()].map((l) => ({ ...l, what: [...l.what], how: [...l.how] })).sort((a, b) => a.who.localeCompare(b.who) || a.case_number.localeCompare(b.case_number)),
  };
}

/** The email: plain text, staff names, case numbers and UTC times only. */
function render(s, tenant, link) {
  const lines = [
    `Patient record access at ${tenant.name}, week of ${s.week_start} to ${s.week_end}`, '',
    `Patient care records opened: ${s.opened}`,
    s.entries.length ? `Opened outside the person's own work in their shift (${s.entries.length}):` : 'Every open was of a case the person was working on in their shift.', '',
    ...s.entries.map((e) => `- ${e.who}: Case ${e.case_number}, ${e.what.join(', ')}, ${e.times} time${e.times === 1 ? '' : 's'}, first ${String(e.first_at).slice(0, 16)} UTC. Allowed by: ${e.how.map((h) => HOW[h] || h).join(', ')}. Fresh check: ${e.fresh ? 'yes' : 'no'}.`),
    '', `The access log has every open: ${link}`, '',
    'This summary has case numbers only, never patient details. It comes every Monday. Only the owner can turn it off, in Settings, Patrol, Patient record access.',
  ];
  return { subject: `${tenant.name}: patient record access, week of ${s.week_start}`, text: lines.join('\n') };
}

/** The owner and patrol Admins (a real roster row at Admin) with an email. */
const recipients = (tenantId) => rows(pool, `SELECT DISTINCT u.email FROM users u LEFT JOIN patrol_members m ON m.tenant_id = u.tenant_id AND m.staff_id = u.staff_id
  WHERE u.tenant_id = ? AND u.active = 1 AND u.email IS NOT NULL AND u.email <> '' AND (u.role = 'owner' OR m.access_level = 'admin')`, [tenantId]);

async function runForTenant(t, { now, base } = {}) {
  if (Number(t.access_summary_off)) return { skipped: 'off' };
  if (await one(pool, "SELECT 1 AS x FROM tenant_modules WHERE tenant_id = ? AND module = 'patrol' AND enabled = 0", [t.id])) return { skipped: 'no patrol' };
  const today = now || todayIn(t.timezone);
  const thisMon = weekStartOf(today);
  const late = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${thisMon}T00:00:00Z`)) / 86_400_000);
  if (late > 2) return { skipped: 'not Monday' };
  const week = addDays(thisMon, -7);
  if (!mailer.enabled() || await isSandbox(t.id)) return { skipped: 'email not set up' };
  // Claimed before sending, so two runs never send twice.
  const [claim] = await pool.query('UPDATE tenants SET access_summary_week = ? WHERE id = ? AND (access_summary_week IS NULL OR access_summary_week < ?)', [week, t.id, week]);
  if (!claim.affectedRows) return { skipped: 'already sent' };
  const s = await build(t.id, week);
  const m = render(s, t, `${base || require('../config').stripe.publicUrl || ''}/#/patrol/access`);
  let sent = 0;
  for (const r of await recipients(t.id)) if ((await mailer.send({ tenantId: t.id, to: r.email, fromName: `${t.name} (Verdynt/OS)`, subject: m.subject, text: m.text, tag: 'patient-access-summary' })).ok) sent += 1;
  return { sent, opened: s.opened, listed: s.entries.length };
}

const runAll = (base) => eachTenant('access_summary', (t) => runForTenant(t, { base }));

module.exports = { build, render, runForTenant, runAll, recipients };
