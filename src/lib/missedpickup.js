'use strict';

// Missed pickups on the request forms (release 2026.11.22, Trash and recycling). The request category with code
// 'missed' ("Missed pickup", renamed from "Missed trash or recycling" by its id) asks which stream was missed, and is
// checked against the collection schedule before it is sent (lib/collection.js pickupCheck): a resident may send it only
// when the check says done, skipped or ok_to_report; the staff form shows the same words and records the answer. A
// second missed pickup at one address within 60 days is flagged to the managers in their "Missed pickups" Inbox
// conversation. Nothing here changes a request in any other category, or a municipality without Trash and recycling or
// whose calendar is not published yet.
const { pool, rows, one, tx } = require('../db');
const { AppError } = require('./errors');
const C = require('./collection');

const REPEAT_DAYS = 60;
const THREAD_NAME = 'Missed pickups';

/** { category_id, streams: [{ id, name }] } when the schedule checks missed pickups here; otherwise null. */
async function missedInfo(db, tenantId) {
  const st = await require('./modules').stateOf(tenantId);
  if (!st.on.has('solidwaste')) return null;
  const s = await C.settingsOf(db, tenantId);
  if (!s.setup_done_at) return null;
  const cat = await one(db, "SELECT id FROM request_categories WHERE tenant_id = ? AND code = 'missed'", [tenantId]);
  if (!cat) return null;
  return { category_id: Number(cat.id), streams: (await C.streamsOf(db, tenantId)).map((x) => ({ id: x.id, name: x.name })) };
}

/**
 * Before a request is saved: for a missed pickup, the stream is required and the schedule is checked. A resident's report
 * (staff false) is refused (409, code not_ok) unless the check lets it be sent. Returns { streamId, outcome } to save with
 * the request, or null when this is not a missed pickup the schedule checks.
 */
async function gate(db, tenantId, body, { staff = false } = {}) {
  const info = await missedInfo(db, tenantId);
  if (!info || Number(body.category_id) !== info.category_id) return null;
  const streamId = Number(body.stream_id) || null;
  if (!streamId || !info.streams.some((x) => x.id === streamId)) throw new AppError(400, 'Pick what was missed: trash, recycling or another collection');
  if (!body.street_id) return { streamId, outcome: null };
  const check = await C.pickupCheck(db, tenantId, { streetId: body.street_id, houseNo: body.house_number || null, streamId });
  if (!staff && !C.SEND_OK.includes(check.outcome)) {
    const e = new AppError(409, check.message, { code: 'not_ok', outcome: check.outcome });
    throw e;
  }
  return { streamId, outcome: check.outcome };
}

/** Inside the request's transaction: the stream and the check's answer go on the request. */
async function save(conn, tenantId, requestId, got) {
  if (!got) return;
  await conn.query('UPDATE requests SET stream_id = ?, pickup_check = ? WHERE tenant_id = ? AND id = ?', [got.streamId, got.outcome, tenantId, requestId]);
}

/** The owners and managers' "Missed pickups" Inbox conversation, made the first time and kept in step with who manages. */
async function managersThread(conn, tenantId) {
  const ids = (await rows(conn, "SELECT id FROM users WHERE tenant_id = ? AND active = 1 AND role IN ('owner','manager')", [tenantId])).map((u) => Number(u.id));
  if (!ids.length) return null;
  await conn.query('INSERT IGNORE INTO collection_settings (tenant_id) VALUES (?)', [tenantId]);
  let threadId = (await one(conn, 'SELECT repeat_thread_id FROM collection_settings WHERE tenant_id = ? FOR UPDATE', [tenantId])).repeat_thread_id;
  if (threadId && !(await one(conn, 'SELECT id FROM chat_threads WHERE tenant_id = ? AND id = ?', [tenantId, threadId]))) threadId = null;
  if (!threadId) {
    const [r] = await conn.query("INSERT INTO chat_threads (tenant_id, kind, name, created_by) VALUES (?, 'group', ?, ?)", [tenantId, THREAD_NAME, ids[0]]);
    threadId = r.insertId;
    await conn.query('UPDATE collection_settings SET repeat_thread_id = ? WHERE tenant_id = ?', [threadId, tenantId]);
  }
  const { top } = await one(conn, 'SELECT COALESCE(MAX(id), 0) AS top FROM chat_messages WHERE tenant_id = ? AND thread_id = ?', [tenantId, threadId]);
  const current = new Set((await rows(conn, 'SELECT user_id FROM chat_members WHERE tenant_id = ? AND thread_id = ? AND left_at IS NULL', [tenantId, threadId])).map((r) => Number(r.user_id)));
  for (const u of ids) {
    if (current.has(u)) continue;
    await conn.query(`INSERT INTO chat_members (thread_id, tenant_id, user_id, visible_from_id, last_read_id) VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE left_at = NULL, visible_from_id = VALUES(visible_from_id), last_read_id = VALUES(last_read_id)`, [threadId, tenantId, u, top, top]);
  }
  for (const u of current) if (!ids.includes(u)) await conn.query('UPDATE chat_members SET left_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND thread_id = ? AND user_id = ?', [tenantId, threadId, u]);
  return { threadId, ids };
}

/**
 * The collection day each missed pickup is about: the last collection of its stream at the address on or before the day
 * it was reported (any stream when none was given), or the day it was reported when the schedule has none.
 * rows: [{ id, street_id, house_number, stream_id, reported_at }] at one address. Returns Map id -> 'YYYY-MM-DD'.
 */
async function missedDays(db, tenantId, list) {
  const out = new Map();
  if (!list.length) return out;
  const zone = await C.zoneFor(db, tenantId, { streetId: list[0].street_id, houseNo: list[0].house_number });
  for (const r of list) {
    const day = String(r.reported_at).slice(0, 10);
    let found = null;
    if (zone && zone.zoneId) {
      const { addDays } = require('./util');
      const days = (await C.collectionDays(db, tenantId, { zoneId: zone.zoneId, from: addDays(day, -40), to: day })).filter((x) => !r.stream_id || x.streamId === Number(r.stream_id));
      if (days.length) found = days[days.length - 1].date;
    }
    out.set(Number(r.id), found || day);
  }
  return out;
}

/**
 * After a missed pickup is saved: when the same address had a missed pickup on a different collection day in the last 60
 * days, the managers hear about it (a line in their Inbox and a phone alert) with the street and the request, never the
 * resident. The same miss reported twice (the same collection day) is not a repeat. Never throws. Returns how many
 * different collection days the address has had a missed pickup on in those 60 days.
 */
async function afterSaved(tenantId, requestId) {
  try {
    const r = await one(pool, `SELECT r.id, r.reference, r.street_id, r.house_number, r.reported_at, s.name AS street, c.code FROM requests r JOIN request_categories c ON c.tenant_id = r.tenant_id AND c.id = r.category_id
      LEFT JOIN streets s ON s.tenant_id = r.tenant_id AND s.id = r.street_id WHERE r.tenant_id = ? AND r.id = ?`, [tenantId, requestId]);
    if (!r || r.code !== 'missed' || !r.street_id || !String(r.house_number || '').trim()) return 0;
    const list = await rows(pool, `SELECT r.id, r.street_id, r.house_number, r.stream_id, r.reported_at FROM requests r JOIN request_categories c ON c.tenant_id = r.tenant_id AND c.id = r.category_id
      WHERE r.tenant_id = ? AND c.code = 'missed' AND r.street_id = ? AND LOWER(TRIM(r.house_number)) = LOWER(TRIM(?)) AND r.reported_at >= ? - INTERVAL ? DAY AND r.reported_at <= ? AND r.status <> 'duplicate'`,
    [tenantId, r.street_id, r.house_number, r.reported_at, REPEAT_DAYS, r.reported_at]);
    const days = await missedDays(pool, tenantId, list);
    const mine = days.get(Number(r.id));
    const times = new Set(days.values()).size;
    // A second report about a day already reported adds nothing new.
    if (times < 2 || [...days].some(([id, d]) => id !== Number(r.id) && d === mine)) return times;
    const text = `Repeat missed pickup on ${r.street}: missed on ${times} collection days at the same address in the last ${REPEAT_DAYS} days. Request ${r.reference}.`;
    const th = await tx(async (conn) => {
      const t2 = await managersThread(conn, tenantId);
      if (!t2) return null;
      await conn.query('INSERT INTO chat_messages (tenant_id, thread_id, user_id, body, refs) VALUES (?, ?, NULL, ?, ?)', [tenantId, t2.threadId, text, JSON.stringify([{ type: 'resident_request', id: Number(r.id) }])]);
      await conn.query('UPDATE chat_threads SET last_message_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ?', [tenantId, t2.threadId]);
      return t2;
    });
    if (th) await require('./push').notifyUsers(tenantId, th.ids, { title: 'Repeat missed pickup', body: text.slice(0, 180), url: `/#/requests/r/${r.id}`, tag: `missed-${r.id}` }).catch(() => 0);
    return times;
  } catch (err) {
    console.error(`[missed pickups] could not check for repeats: ${err && err.message}`);
    return 0;
  }
}

module.exports = { missedInfo, gate, save, afterSaved, missedDays, REPEAT_DAYS, THREAD_NAME };
