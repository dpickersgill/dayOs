'use strict';

// Repeat callers and duplicates (release 2026.11.20). Mounted at /api/v1/requests/checks, ahead of routes/requests.js (so
// "checks" is never read as a request id); part of Resident requests.
//   GET  /similar?category_id=&street_id=&house_number=&exclude_id=
//        open requests and open work orders of the same category on the same block (the same hundred of house numbers on
//        the street; the whole street when no number is given), newest first, in words: "Open: R-1042 Pothole at 111
//        Market Street, reported 2 days ago". Anyone who takes or works requests (Crew, Front desk, managers).
//   GET  /callers?phone= | ?email=
//        the earlier requests made with this phone or email (the contact typed on the request, or the resident's record).
//        Managers and Front desk only; never public, never in an export. Audited without the phone or email.
//   POST /link   { request_id, work_order_id }
//        a request taken for a problem that already has an open work order with no request of its own: the work order
//        becomes this request's, so completing it marks the request fixed and tells the resident.
const express = require('express');
const { pool, rows, one, tx } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, nowIn } = require('../lib/util');
const { notFound, bad, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const sms = require('../lib/sms');
const Q = require('../lib/requests');

const router = express.Router();
const anyone = requireRole('manager', 'counter', 'staff');
const desk = requireRole('manager', 'counter');

const first = (v) => String(Array.isArray(v) ? v[0] : v ?? '');
const idOf = (v) => { const n = Number(first(v)); return Number.isInteger(n) && n > 0 ? n : null; };
const tz = async (t) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone;
const houseNo = (s) => { const m = /^\s*(\d{1,7})/.exec(String(s || '')); return m ? Number(m[1]) : null; };
const OPEN_REQ = "('new','assigned','made_safe')";

/** "today", "yesterday", "3 days ago", "2 weeks ago" from a local 'YYYY-MM-DD HH:MM:SS' and now. */
function ago(at, now) {
  const days = Math.floor((Date.parse(`${String(now).slice(0, 10)}T00:00:00Z`) - Date.parse(`${String(at instanceof Date ? at.toISOString() : at).slice(0, 10)}T00:00:00Z`)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}
const sameBlock = (a, b) => a === null || b === null || Math.floor(a / 100) === Math.floor(b / 100);

/**
 * What is already open for this problem here: { matches: [{ type: 'request'|'work_order', id, reference, request_id,
 * work_order_id, words, reported_at, same_address }] }. A work order matches when it was made from a request of the same
 * category, or when it is on the street and its title names the category (a job the crew opened themselves).
 */
async function similar(t, { categoryId, streetId, houseNumber, excludeId = null }) {
  if (!categoryId || !streetId) return [];
  const cat = await one(pool, 'SELECT id, name FROM request_categories WHERE tenant_id = ? AND id = ?', [t, categoryId]);
  const street = await one(pool, 'SELECT id, name FROM streets WHERE tenant_id = ? AND id = ?', [t, streetId]);
  if (!cat || !street) return [];
  const n = houseNo(houseNumber);
  const now = nowIn(await tz(t));
  const reqs = await rows(pool, `SELECT r.id, r.reference, r.house_number, r.cross_street, r.reported_at, r.status, r.work_order_id FROM requests r
    WHERE r.tenant_id = ? AND r.category_id = ? AND r.street_id = ? AND r.status IN ${OPEN_REQ} ${excludeId ? 'AND r.id <> ?' : ''} ORDER BY r.reported_at DESC LIMIT 50`,
  excludeId ? [t, cat.id, street.id, excludeId] : [t, cat.id, street.id]);
  const out = [];
  for (const r of reqs) {
    const h = houseNo(r.house_number);
    if (!sameBlock(n, h)) continue;
    out.push({ type: 'request', id: Number(r.id), reference: r.reference, request_id: Number(r.id), work_order_id: r.work_order_id ? Number(r.work_order_id) : null,
      same_address: n !== null && h === n, reported_at: r.reported_at,
      words: `Open: ${r.reference} ${cat.name.toLowerCase()} at ${Q.placeWords({ ...r, street_name: street.name })}, reported ${ago(r.reported_at, now)}` });
  }
  // Open work orders on the street that no matched request already stands for.
  const seenWo = new Set(out.map((m) => m.work_order_id).filter(Boolean));
  const words = cat.name.toLowerCase().replace(/s$/, '');
  const wos = await rows(pool, `SELECT w.id, w.title, w.location, w.opened_at, w.request_id, rq.reference, rq.category_id, rq.house_number, rq.street_id AS rq_street
    FROM work_orders w LEFT JOIN requests rq ON rq.tenant_id = w.tenant_id AND rq.id = w.request_id
    WHERE w.tenant_id = ? AND w.status NOT IN ('done','cancelled') AND (rq.id IS NULL OR rq.category_id = ?) AND (w.location LIKE ? OR w.title LIKE ? OR rq.street_id = ?)
    ORDER BY w.opened_at DESC LIMIT 50`, [t, cat.id, `%${street.name}%`, `%${street.name}%`, street.id]);
  for (const w of wos) {
    if (seenWo.has(Number(w.id)) || (excludeId && Number(w.request_id) === Number(excludeId))) continue;
    if (w.request_id && out.some((m) => m.request_id === Number(w.request_id))) continue;
    if (!w.request_id && !`${w.title} ${w.location || ''}`.toLowerCase().includes(words)) continue;
    const place = `${w.title} ${w.location || ''}`;
    const h = w.request_id ? houseNo(w.house_number) : houseNo((new RegExp(`(\\d{1,6})\\s+${street.name.split(' ')[0]}`, 'i').exec(place) || [])[1]);
    if (!sameBlock(n, h)) continue;
    out.push({ type: 'work_order', id: Number(w.id), reference: w.reference || null, request_id: w.request_id ? Number(w.request_id) : null, work_order_id: Number(w.id),
      same_address: n !== null && h === n, reported_at: w.opened_at,
      words: `Open: work order ${w.id}, ${w.title}${w.location && !w.title.includes(w.location) ? ` (${w.location})` : ''}, opened ${ago(w.opened_at, now)}` });
  }
  return out.sort((a, b) => Number(b.same_address) - Number(a.same_address) || String(b.reported_at).localeCompare(String(a.reported_at))).slice(0, 8);
}

router.get('/similar', anyone, async (req, res) => {
  const matches = await similar(req.auth.tenantId, { categoryId: idOf(req.query.category_id), streetId: idOf(req.query.street_id), houseNumber: first(req.query.house_number).slice(0, 20), excludeId: idOf(req.query.exclude_id) });
  res.set('Cache-Control', 'private, no-store').json({ matches });
});

router.get('/callers', desk, async (req, res) => {
  const t = req.auth.tenantId;
  const key = req.query.phone ? sms.phoneKey(first(req.query.phone)) : null;
  const email = req.query.email ? first(req.query.email).trim().toLowerCase().slice(0, 190) : null;
  if (!key && !(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw bad('Type a full phone number with its area code, or a full email address');
  const where = key
    ? "(RIGHT(REGEXP_REPLACE(COALESCE(r.contact_phone, ''), '[^0-9]', ''), 10) = ? OR RIGHT(REGEXP_REPLACE(COALESCE(x.phone, ''), '[^0-9]', ''), 10) = ?)"
    : '(LOWER(r.contact_email) = ? OR LOWER(x.email) = ?)';
  const v = key || email;
  const now = nowIn(await tz(t));
  const list = await rows(pool, `SELECT r.id, r.reference, r.status, r.reported_at, r.house_number, r.cross_street, c.name AS category, s.name AS street_name
    FROM requests r JOIN request_categories c ON c.tenant_id = r.tenant_id AND c.id = r.category_id LEFT JOIN streets s ON s.tenant_id = r.tenant_id AND s.id = r.street_id
    LEFT JOIN residents x ON x.tenant_id = r.tenant_id AND x.id = r.resident_id WHERE r.tenant_id = ? AND ${where} ORDER BY r.reported_at DESC LIMIT 20`, [t, v, v]);
  await audit(pool, req, 'caller_lookup', 'requests', null, { by: key ? 'phone' : 'email', found: list.length });
  res.set('Cache-Control', 'private, no-store').json({
    requests: list.map((r) => ({ id: Number(r.id), reference: r.reference, status: r.status, status_words: Q.STATUS_WORDS[r.status], category: r.category, place: Q.placeWords(r), reported_at: r.reported_at,
      words: `${r.reference} ${r.category.toLowerCase()} at ${Q.placeWords(r)}, ${Q.STATUS_WORDS[r.status].toLowerCase()}, reported ${ago(r.reported_at, now)}` })),
  });
});

router.post('/link', desk, validate(z.object({ request_id: z.number().int().positive(), work_order_id: z.number().int().positive() })), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  await tx(async (conn) => {
    const r = await one(conn, 'SELECT id, reference, status, work_order_id FROM requests WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, b.request_id]);
    if (!r) throw notFound('Request');
    const w = await one(conn, 'SELECT id, status, request_id FROM work_orders WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, b.work_order_id]);
    if (!w) throw notFound('Work order');
    if (!['new', 'assigned', 'made_safe'].includes(r.status)) throw conflict(`${r.reference} is closed already`);
    if (['done', 'cancelled'].includes(w.status)) throw conflict('That work order is closed. Make a new one for this request.');
    if (w.request_id && Number(w.request_id) !== Number(r.id)) throw conflict('That work order belongs to another request. Mark this request a duplicate of that one instead.');
    if (r.work_order_id && Number(r.work_order_id) !== Number(w.id)) throw conflict('This request already has a work order');
    const now = nowIn(await tz(t));
    await conn.query('UPDATE work_orders SET request_id = ? WHERE tenant_id = ? AND id = ? AND request_id IS NULL', [r.id, t, w.id]);
    await conn.query("UPDATE requests SET work_order_id = ?, assigned_at = COALESCE(assigned_at, ?), status = IF(status = 'new', 'assigned', status) WHERE tenant_id = ? AND id = ?", [w.id, now, t, r.id]);
    await Q.event(conn, t, r.id, now, `Linked to work order ${w.id}, already open for this problem.`, req.auth.userId);
    await audit(conn, req, 'link_work_order', 'requests', r.id, { work_order_id: Number(w.id) });
  });
  res.json({ ok: true });
});

module.exports = { router, similar };
