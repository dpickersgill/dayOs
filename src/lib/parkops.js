'use strict';

// Terrain park record keeping shared by the park screens and Patrol: the history of every change to a feature or an
// area's rating, status changes (only an inspection opens a feature), the time a phone says something happened, closing a
// feature after an incident (and telling the park supervisor), and the snapshot of a feature a patrol case keeps.
const { one, rows } = require('../db');
const { bad } = require('./errors');
const { nowIn, todayIn, normDateTime, utcFromLocal } = require('./util');
const { KINDS, SIZES, LEVELS, RESULTS, INSPECTION_KINDS } = require('./park');

const label = (list, key) => (list.find((x) => x[0] === key) || [key, key])[1];
const sizeLabel = (s) => label(SIZES, s);
const levelLabel = (l) => label(LEVELS, l);
const resultLabel = (r) => label(RESULTS, r);
const kindLabel = (k) => (KINDS.find((x) => x.key === k) || { label: k }).label;
const inspectionKindLabel = (k) => label(INSPECTION_KINDS, k);
const STATUS_LABEL = { new: 'Not inspected yet', ready: 'Open', needs_attention: 'Needs attention', closed: 'Closed', retired: 'Retired' };
const statusLabel = (s) => STATUS_LABEL[s] || s;

const tzOf = async (db, tenantId) => (await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
const utcNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const shift = (local, minutes) => new Date(Date.parse(`${local.replace(' ', 'T')}Z`) + minutes * 60000).toISOString().slice(0, 19).replace('T', ' ');
const MAX_AGE_MIN = 24 * 60;

/**
 * When something really happened: the phone's own time (mountain time, 'YYYY-MM-DDTHH:MM[:SS]') for an entry kept while
 * there was no signal, or now. A time in the future is refused the way Patrol refuses it (so a phone whose clock runs fast
 * can move its waiting entries back and resend); one more than a day old is refused too.
 * Returns { local, utc, date, now, today, tz }.
 */
async function phoneTime(db, tenantId, at) {
  const tz = await tzOf(db, tenantId);
  const now = nowIn(tz);
  const today = todayIn(tz);
  if (!at) return { local: now, utc: utcNow(), date: today, now, today, tz };
  const local = normDateTime(String(at));
  if (local > shift(now, Number(process.env.PATROL_FUTURE_SLACK_MIN || 5))) throw bad(`That time (${local.slice(11, 16)}) is in the future. Check the hour.`, { code: 'future_time', field: 'at', server_now: now });
  if (local < shift(now, -MAX_AGE_MIN)) throw bad('That time is more than a day ago. Record it as it is now, with a note.');
  return { local, utc: utcFromLocal(local, tz), date: local.slice(0, 10), now, today, tz };
}

/** One row of history: a field of a feature (or an area's rating) from one value to another, with who, why and where from. */
async function logChange(conn, req, { featureId = null, areaId = null, onDate = null, field, before, after, reason = null, source = 'edit', refId = null }) {
  const s = (v) => (v === null || v === undefined ? null : String(v).slice(0, 255));
  await conn.query(`INSERT INTO park_feature_changes (tenant_id, feature_id, area_id, on_date, field, before_value, after_value, reason, source, ref_id, changed_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [req.auth.tenantId, featureId, areaId, onDate, field, s(before), s(after), s(reason), source, refId, req.auth.userId]);
}

/** Moves a feature's status, keeping the change in its history. Returns true when it changed. */
async function setStatus(conn, req, feature, to, { reason = null, source, refId = null, onDate = null, extra = '' } = {}) {
  if (feature.status === to) return false;
  await conn.query(`UPDATE park_features SET status = ?${extra} WHERE tenant_id = ? AND id = ?`, [to, req.auth.tenantId, feature.id]);
  await logChange(conn, req, { featureId: feature.id, onDate, field: 'status', before: feature.status, after: to, reason, source, refId });
  return true;
}

/**
 * Closes a feature for a post-incident inspection: closed now, and it cannot reopen until an inspection of type
 * post-incident passes. Inside the caller's transaction. Returns the feature as it was.
 */
async function closeForIncident(conn, req, featureId, { incidentId = null, reason }) {
  const f = await one(conn, 'SELECT id, name, status, needs_post_incident FROM park_features WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, featureId]);
  if (!f) return null;
  if (f.status === 'retired') throw bad('This feature is retired');
  const today = todayIn(await tzOf(conn, req.auth.tenantId));
  await conn.query('UPDATE park_features SET status = \'closed\', needs_post_incident = 1, closed_for_incident_id = COALESCE(?, closed_for_incident_id) WHERE tenant_id = ? AND id = ?', [incidentId, req.auth.tenantId, f.id]);
  await logChange(conn, req, { featureId: f.id, onDate: today, field: 'status', before: f.status, after: 'closed', reason: reason || 'Closed for a post-incident inspection', source: 'post_incident', refId: incidentId });
  return f;
}

/** Who runs the park: owners and managers (park manage access). */
const supervisors = async (db, tenantId) => (await rows(db, "SELECT id FROM users WHERE tenant_id = ? AND active = 1 AND role IN ('owner','manager')", [tenantId])).map((u) => Number(u.id));

/**
 * Tells the park supervisors, in their Inbox (a message from the person who closed it) and on their phones. Never fails
 * the change it reports. No patient details: the feature, the time and the case number at most.
 */
async function tellSupervisors(pool, req, text, { url = '#/park', tag = 'park' } = {}) {
  try {
    const ids = await supervisors(pool, req.auth.tenantId);
    const review = require('./review');
    for (const u of ids) if (u !== req.auth.userId) await review.direct(pool, req.auth.tenantId, req.auth.userId, u, text);
    await require('./push').notifyUsers(req.auth.tenantId, ids.filter((u) => u !== req.auth.userId), { title: 'Terrain park feature closed', body: text.slice(0, 180), url, tag });
    return ids.length;
  } catch (err) { console.warn('Could not tell the park supervisor:', err.message); return 0; }
}

/**
 * What a feature was at a moment: its name, type, size and dimensions, where it was placed that day and the area's rating,
 * its status, and the last inspection before that moment. A patrol case keeps this, so later changes to the feature do not
 * change what the case says. beforeUtc: the incident time as database (UTC) time, or null for now.
 */
async function snapshot(db, tenantId, featureId, onDate, beforeUtc) {
  const f = await one(db, 'SELECT id, name, kind, size, dimensions, status, needs_post_incident FROM park_features WHERE tenant_id = ? AND id = ?', [tenantId, featureId]);
  if (!f) return null;
  const p = await one(db, `SELECT p.on_date, p.roped_off, a.name AS area, a.level AS area_level FROM park_placements p LEFT JOIN park_areas a ON a.tenant_id = p.tenant_id AND a.id = p.area_id
    WHERE p.tenant_id = ? AND p.feature_id = ? AND p.on_date = ? AND p.voided_at IS NULL`, [tenantId, featureId, onDate]);
  const i = await one(db, `SELECT i.id, i.result, i.kind, i.inspected_at, COALESCE(u.email, u.username) AS by_name FROM park_inspections i LEFT JOIN users u ON u.tenant_id = i.tenant_id AND u.id = i.inspected_by
    WHERE i.tenant_id = ? AND i.feature_id = ? AND i.voided_at IS NULL${beforeUtc ? ' AND i.inspected_at <= ?' : ''} ORDER BY i.inspected_at DESC, i.id DESC LIMIT 1`, beforeUtc ? [tenantId, featureId, beforeUtc] : [tenantId, featureId]);
  return {
    feature_id: Number(f.id), name: f.name, kind: f.kind, kind_label: kindLabel(f.kind), size: f.size, size_label: sizeLabel(f.size), dimensions: f.dimensions || null,
    on_date: onDate, placed: Boolean(p), area: p ? p.area || null : null, area_level: p ? p.area_level || null : null, area_level_label: p && p.area_level ? levelLabel(p.area_level) : null,
    roped_off: Boolean(p && Number(p.roped_off)), status: f.status, status_label: statusLabel(f.status),
    last_inspection: i ? { id: Number(i.id), result: i.result, result_label: resultLabel(i.result), kind: i.kind || null, kind_label: i.kind ? inspectionKindLabel(i.kind) : null, at: i.inspected_at, by: i.by_name || null } : null,
    taken_at: utcNow(),
  };
}

module.exports = { phoneTime, logChange, setStatus, closeForIncident, tellSupervisors, supervisors, snapshot, statusLabel, sizeLabel, levelLabel, resultLabel, kindLabel, inspectionKindLabel, tzOf, utcNow, STATUS_LABEL };
