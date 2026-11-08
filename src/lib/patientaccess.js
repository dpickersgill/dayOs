'use strict';

// Who may open a patient care record without a fresh check (feat/auth-hardening). The idea, from healthcare: protect
// browsing of patient records hard, keep writing at the scene fast.
//
// No fresh check is needed for (CASE_HOURS = 12):
//   writing  a draft the person created themselves (the audit log's create row), at any age;
//   wrote    a case the person created or submitted (incidents.submitted_by), started in the last 12 hours;
//   and, for a case started (incidents.created_at) in the last 12 hours, when the person:
//   responder        is a responder on it (incident_responders, not marked entered in error);
//   dispatched       was sent to its call (dispatch_calls.incident_id with dispatch_responders, or with
//                    dispatch_responders_removed: taken off a call that had a case keeps the tie they had);
//   crew             shares an active crew (patrol_crews.active, patrol_crew_members) with someone who responded to it
//                    or was dispatched to it (a counted link), and both were signed in on patrol duty (patrol_duty) when
//                    the case was started: on duty with that crew.
// Being on duty alone is not enough (Dan, 2026-11-05): someone on shift who had no part in a case, and no crew mate
// who did, makes the records check like anyone else.
// A responder or dispatch link counts only when it is believable (LINK_RULE):
//   - it was there before this rule (added_by 0), or it was added within 30 minutes of the case being created (a
//     responder adding themselves at the scene), or
//   - it was added by someone tied to the case: its creator or submitter, the owner or a manager, a patrol Admin or
//     Approver, or a person whose own link on the case passes the first two tests. A late self-add, or two patrollers
//     adding each other later, does not count.
// Everything else needs the fresh check (the step-up with scope "records": passkey, app code, or for someone with
// neither, their password; counted per login). One check covers RECORDS_MINUTES (30) for that session. Signing in is
// never the check. Owners, managers and the ski area login follow the same rule. Every open is logged with how it was
// allowed (access) and whether a fresh check was used (fresh).
const { rows, one } = require('../db');
const { forbidden, notFound, bad } = require('./errors');
const { canonId } = require('./util');

const CASE_HOURS = 12;
const SCENE_MINUTES = 30;
const RECORDS_MINUTES = () => Number(process.env.RECORDS_CHECK_MINUTES || 30);
const ROOT_ROLES = ['owner', 'manager'];
const ROOT_LEVELS = ['admin', 'approver'];

function needed() {
  const err = forbidden('Confirm it is you to open this patient record');
  err.details = { code: 'step_up_required', what: 'open this patient record', scope: 'records' };
  return err;
}

/** "YYYY-MM-DD HH:MM:SS" in a time zone, for a UTC date (patrol duty times are kept as the mountain's wall clock). */
function wallClock(utc, timeZone) {
  const d = utc instanceof Date ? utc : new Date(`${String(utc).replace(' ', 'T')}Z`);
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
const ms = (s) => new Date(`${String(s).replace(' ', 'T')}Z`).getTime();

/**
 * How this person may open each of these cases without a fresh check: Map id -> access ('writing', 'wrote',
 * 'responder', 'responder_self', 'dispatched', 'crew'), or no entry when the check is needed.
 */
async function relations(db, req, ids) {
  const out = new Map();
  const list = [...new Set(ids.map(Number).filter((x) => Number.isSafeInteger(x) && x > 0))];
  if (!list.length || !req.auth) return out;
  const t = req.auth.tenantId; const me = Number(req.auth.userId); const myStaff = req.auth.staffId ? Number(req.auth.staffId) : null;
  const incs = await rows(db, `SELECT id, created_at, report_state, submitted_by, (created_at > UTC_TIMESTAMP() - INTERVAL ${CASE_HOURS} HOUR) AS recent
    FROM incidents WHERE tenant_id = ? AND id IN (?)`, [t, list]);
  if (!incs.length) return out;
  const creates = await rows(db, "SELECT entity_id, user_id FROM audit_log WHERE tenant_id = ? AND entity = 'incidents' AND action = 'create' AND entity_id IN (?)", [t, incs.map((i) => i.id)]);
  const creatorOf = new Map(); for (const c of creates) if (!creatorOf.has(Number(c.entity_id))) creatorOf.set(Number(c.entity_id), Number(c.user_id));
  const recent = incs.filter((i) => Number(i.recent));
  for (const i of incs) {
    const mine = creatorOf.get(Number(i.id)) === me;
    if (mine && i.report_state === 'draft') out.set(Number(i.id), 'writing');
    else if (Number(i.recent) && (mine || Number(i.submitted_by) === me)) out.set(Number(i.id), 'wrote');
  }
  if (!myStaff || !recent.length) return out;
  const rid = recent.map((i) => i.id);
  const [resp, disp] = await Promise.all([
    rows(db, 'SELECT incident_id, staff_id, added_by, added_at FROM incident_responders WHERE tenant_id = ? AND incident_id IN (?) AND voided_at IS NULL', [t, rid]),
    rows(db, `SELECT c.incident_id, d.staff_id, d.added_by, d.added_at FROM dispatch_responders d JOIN dispatch_calls c ON c.tenant_id = d.tenant_id AND c.id = d.call_id
      WHERE d.tenant_id = ? AND c.incident_id IN (?)
      UNION ALL SELECT c.incident_id, x.staff_id, x.added_by, x.added_at FROM dispatch_responders_removed x JOIN dispatch_calls c ON c.tenant_id = x.tenant_id AND c.id = x.call_id
      WHERE x.tenant_id = ? AND c.incident_id IN (?)`, [t, rid, t, rid]),
  ]);
  const links = [...resp.map((r) => ({ ...r, kind: 'responder' })), ...disp.map((r) => ({ ...r, kind: 'dispatched' }))];
  // Who added each link: their role, patrol level and staff record.
  const adders = [...new Set(links.map((l) => Number(l.added_by)).filter((x) => x > 0))];
  const people = adders.length ? await rows(db, `SELECT u.id, u.role, u.staff_id, m.access_level FROM users u LEFT JOIN patrol_members m ON m.tenant_id = u.tenant_id AND m.staff_id = u.staff_id
    WHERE u.tenant_id = ? AND u.id IN (?)`, [t, adders]) : [];
  const who = new Map(people.map((p) => [Number(p.id), p]));
  const tz = ((await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [t])) || {}).timezone || 'America/New_York';
  const crewMates = await rows(db, `SELECT DISTINCT b.staff_id FROM patrol_crew_members a JOIN patrol_crews c ON c.tenant_id = a.tenant_id AND c.id = a.crew_id AND c.active = 1
    JOIN patrol_crew_members b ON b.tenant_id = a.tenant_id AND b.crew_id = a.crew_id WHERE a.tenant_id = ? AND a.staff_id = ? AND b.staff_id <> a.staff_id`, [t, myStaff]);
  const mates = new Set(crewMates.map((r) => Number(r.staff_id)));
  const duty = await rows(db, 'SELECT staff_id, signed_in_at, signed_out_at FROM patrol_duty WHERE tenant_id = ? AND staff_id IN (?) AND on_date >= DATE_SUB(CURDATE(), INTERVAL 2 DAY)', [t, [myStaff, ...mates]]);
  const onDutyAt = (staff, at) => duty.some((d) => Number(d.staff_id) === staff && String(d.signed_in_at) <= at && (!d.signed_out_at || String(d.signed_out_at) > at));
  for (const i of recent) {
    const id = Number(i.id);
    if (out.has(id)) continue;
    const created = ms(i.created_at);
    const isRoot = (u) => {
      if (!(u > 0)) return false; // no adder recorded (null) is never the creator, the submitter or anyone else
      const p = who.get(u);
      return Boolean((p && (ROOT_ROLES.includes(p.role) || ROOT_LEVELS.includes(p.access_level))) || u === creatorOf.get(id) || (i.submitted_by !== null && u === Number(i.submitted_by)));
    };
    const mineLinks = links.filter((l) => Number(l.incident_id) === id);
    // A link passes on its own: from before this rule, made at the scene, or added by someone tied to the case.
    const base = (l) => (l.added_by !== null && l.added_by !== undefined && Number(l.added_by) === 0) || (l.added_at && ms(l.added_at) <= created + SCENE_MINUTES * 60_000) || isRoot(Number(l.added_by));
    const baseStaff = new Set(mineLinks.filter(base).map((l) => Number(l.staff_id)));
    const counts = (l) => {
      if (base(l)) return true;
      const adder = l.added_by === null ? null : who.get(Number(l.added_by));
      // Added later by someone else who holds a link that passes on its own (never by the person themselves).
      return Boolean(adder && adder.staff_id && Number(adder.staff_id) !== Number(l.staff_id) && baseStaff.has(Number(adder.staff_id)));
    };
    const counted = mineLinks.filter(counts);
    const own = counted.find((l) => Number(l.staff_id) === myStaff);
    if (own) { out.set(id, own.kind === 'responder' && Number(own.added_by) === me ? 'responder_self' : own.kind); continue; }
    if (!mates.size) continue;
    const at = wallClock(i.created_at, tz);
    if (!onDutyAt(myStaff, at)) continue;
    if (counted.some((l) => mates.has(Number(l.staff_id)) && onDutyAt(Number(l.staff_id), at))) out.set(id, 'crew');
  }
  return out;
}

/** How this request may open case id: { access, fresh } or throws step_up_required (403) or 404. */
async function check(db, req, id) {
  const n = canonId(id);
  if (!n) throw bad('Invalid id');
  if (req.patientAccess && req.patientAccess.id === n) return req.patientAccess;
  if (!(await one(db, 'SELECT id FROM incidents WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, n]))) throw notFound('Incident');
  const access = (await relations(db, req, [n])).get(n);
  let result;
  if (access) result = { id: n, access, fresh: false };
  else if (req.auth.recordsChecked) result = { id: n, access: 'checked', fresh: true };
  else throw needed();
  req.patientAccess = result;
  return result;
}

/**
 * Router guard for every /incidents/:id address (router.use('/incidents/:id', byParam) on each patrol router that has
 * them). It reads the id Express matched, so how the address is spelled (capitals, a trailing slash, %-escapes) cannot
 * skip it, and refuses any id not written as plain digits with no leading zero.
 * One exception: "add me as a responder" on a case started in the last 12 hours needs no check, so a patroller at the
 * scene can join the case; that add opens the case only by LINK_RULE (within 30 minutes of the case starting).
 */
function byParam(req, _res, next) {
  (async () => {
    const pool = require('../db').pool;
    // Someone who cannot use Patrol at all is refused by the route itself; this rule is for those who can.
    if (!req.auth || !(['owner', 'manager', 'patrol'].includes(req.auth.role) || req.auth.onPatrol)) return;
    const n = canonId(req.params.id);
    if (!n) throw bad('Invalid id');
    const rest = String(req.path || '').toLowerCase().replace(/\/+$/, '');
    if (req.method === 'POST' && rest === '/responders/me') {
      const inc = await one(pool, `SELECT id, (created_at > UTC_TIMESTAMP() - INTERVAL ${CASE_HOURS} HOUR) AS recent FROM incidents WHERE tenant_id = ? AND id = ?`, [req.auth.tenantId, n]);
      if (inc && Number(inc.recent)) return;
    }
    await check(pool, req, n);
  })().then(() => next(), next);
}

/**
 * Router guard for an address keyed by a child id (a witness link, a records request, a dispatch call): the row's case
 * gets the same rule as /incidents/:id. sql: one row by (tenant, id) with an incident_id column (null: no case, no rule).
 * A non-canonical id is refused (400) unless skipOther is set (a sibling route such as /dispatch/available).
 */
function byChild(param, sql, { skipOther = false, allow = null } = {}) {
  return (req, _res, next) => {
    (async () => {
      if (!req.auth || !(['owner', 'manager', 'patrol'].includes(req.auth.role) || req.auth.onPatrol)) return;
      const n = canonId(req.params[param]);
      if (!n) { if (skipOther) return; throw bad('Invalid id'); }
      const pool = require('../db').pool;
      const row = await one(pool, sql, [req.auth.tenantId, n]);
      if (!row) return; // the route answers "not found"
      if (allow && (await allow(req, row))) return;
      if (row.incident_id) await check(pool, req, Number(row.incident_id));
      else if (allow) throw needed(); // a row that is not open to everyone and has no case of its own: the check
    })().then(() => next(), next);
  };
}

/** For a read that names a case some other way (a records request's pack, the area login's report). */
const guard = (db, req, id) => check(db, req, id);

/** Searching cases can find a patient by name: it needs the fresh check, whatever the cases are. */
function searchCheck(req) {
  if (!req.auth.recordsChecked) throw needed();
}

/** Whether this person may see cases at all (the patrol feature "See cases"; owners and managers always may). */
const caseReader = (db, req) => require('./patrolaccess').can(db, req, 'view_cases');

/**
 * For lists that show cases (the case list, home, the review queue, the day log, map pins, kit and medication notes):
 * which of these the person may see the summary of. Without a fresh check, only the cases they could open without one.
 * The records check is never permission on its own: someone who may not see cases (a Host) sees none of them, checked
 * or not (review 2026.11.12).
 */
async function openable(db, req, ids) {
  if (!(await caseReader(db, req))) return { all: false, has: () => false };
  if (req.auth.recordsChecked) return { all: true, has: () => true };
  const rel = await relations(db, req, ids);
  return { all: false, has: (id) => rel.has(Number(id)) };
}

/** A case row for a list, with the summary (and chief complaint) taken out when the person may not open it unchecked. */
const HIDDEN = 'Open the case to see more';
function trimRow(row, may, idKey = 'id') {
  if (may.has(row[idKey])) return row;
  const out = { ...row, summary: null, summary_hidden: true };
  if ('chief_complaint' in out) out.chief_complaint = null;
  if ('narrative' in out) out.narrative = null;
  if ('patient_names' in out) out.patient_names = null;
  return out;
}

// Names for the weekly summary (any other action is shown by its own name), and the actions that show a case without
// passing the rule above, listed anyway.
const ACTION_LABELS = {
  view: 'case', view_check: 'report check', view_version: 'saved copy', view_signature: 'signature', view_photo: 'photo', view_photo_preview: 'photo', view_photos: 'photos',
  view_scene: 'scene', view_score: 'documentation score', claim_file_view: 'claim file', story_fill: 'story fill', handoff_print: 'hand-off sheet', records_pack_view: 'release pack',
  area_view: 'approved report', view_link: 'chat link preview', claim_share: 'outside claim-file link made', claim_share_view: 'outside claim-file link opened', records_release: 'records release',
  records_request: 'records request', witness_link: 'witness link', witness_link_resend: 'witness link sent again', witness_link_cancel: 'witness link canceled', update: 'case changed', add_note: 'note added',
};
const ALSO_LISTED = ['view_link', 'claim_share_view'];

module.exports = { ACTION_LABELS, ALSO_LISTED, relations, check, byParam, byChild, guard, searchCheck, openable, caseReader, trimRow, needed, wallClock, CASE_HOURS, SCENE_MINUTES, RECORDS_MINUTES, HIDDEN };
