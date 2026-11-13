'use strict';

// The collection schedule (release 2026.11.22, the Trash and recycling app). lib/collection.js has the rules.
//
// router, at /api/v1/solid-waste (signed in; the app gate on /solid-waste checks Trash and recycling is on):
//   GET  /collection/shell               what the app's screen needs first: who collects, setup finished, add-ons on
//   GET  /collection/setup               settings, streams, zones (days, streets), holidays, events, changes, the check
//   PUT  /collection/settings            who collects, the hauler's contact, the holiday rule, the reminder hour (managers)
//   POST /collection/streams, PATCH /collection/streams/:id                 Trash, Recycling, Yard waste... (managers)
//   POST /collection/zones, PATCH /collection/zones/:id                     a zone and its day per stream (managers)
//   PUT  /collection/zones/:id/streets   the zone's streets: whole, or a house-number range on one or both sides
//   PUT  /collection/not-collected       streets (or parts) the borough does not collect (managers)
//   GET  /collection/setup/check         streets with no zone and not marked "not collected", and what else is missing
//   POST /collection/setup/finish        publishes the calendar; refused while the check finds anything (managers)
//   POST /collection/holidays, /collection/holidays/federal, DELETE /collection/holidays/:id   (managers)
//   POST /collection/events, PATCH/DELETE /collection/events/:id            leaf weeks, trees, hazardous waste days
//   POST /collection/changes, DELETE /collection/changes/:id                a day moved or canceled; drafts a notice
//   GET  /collection/calendar            each zone's collection days between two dates (the staff Calendar)
//   GET  /collection/day                 what is collected on a day, zone by zone, in driving order
//   GET  /collection/lookup, /collection/check   an address's zone and next days; "is it your day?" for a missed pickup
//   GET  /collection/missed              missed pickup requests, with the stream, the check and repeats
//   GET  /collection/reminders           how many residents get reminders, by stream, and what went out (managers)
//   GET/POST /collection/education, DELETE /collection/education/:id        the Act 101 education log
//   GET  /collection/mailer              the printable mailer's contents for a year
//
// publicRouter, at /api/v1/public (no sign-in; the page word 'collection' belongs to Trash and recycling):
//   GET /:slug/collection                    the calendar page: streams and what goes in each, notices, events, streets
//   GET /:slug/collection/lookup             street + house number -> the zone and the next date of each stream
//   GET /:slug/collection/year               a zone's year calendar to print
//   GET /:slug/collection/calendar.ics       the same as an iCalendar feed that stays up to date
//   GET /:slug/collection/check              "is it your day?" before a missed pickup is reported
// The public answers say only the zone and dates: never whether anyone lives at an address, has an account or signed up.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, dateStr, todayIn, addDays } = require('../lib/util');
const { notFound, conflict, bad, AppError } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { baseUrl } = require('../lib/baseurl');
const { card } = require('../lib/today');
const C = require('../lib/collection');

const router = express.Router();
const publicRouter = express.Router();
const anyone = requireRole('manager', 'counter', 'staff');
const desk = requireRole('manager', 'counter');
const mgr = requireRole('manager');
const n = (v) => Number(v || 0);
const first = (v) => String(Array.isArray(v) ? v[0] : v ?? '');
const idOf = (v) => { const x = Number(first(v)); return Number.isSafeInteger(x) && x > 0 ? x : null; };
const townOf = (tenantId) => one(pool, 'SELECT id, name, slug, timezone, phone FROM tenants WHERE id = ?', [tenantId]);
const MODEL_WORDS = { inhouse: 'The borough\'s own crew', contract: 'One contracted hauler', subscription: 'Licensed private haulers' };
const RULE_WORDS = { shift: 'A holiday moves that day and the rest of the week one day later', skip: 'No pickup on a holiday; it is not made up', none: 'Holidays change nothing' };
const EVENT_WORDS = { leaf: 'Leaf collection', tree: 'Christmas trees', hazardous: 'Household hazardous waste', other: 'Special collection' };
const pageLink = (req, slug) => `${baseUrl(req)}/collection/${encodeURIComponent(slug)}`;
const icsLink = (req, slug, zoneId) => `${baseUrl(req)}/api/v1/public/${encodeURIComponent(slug)}/collection/calendar.ics?zone=${zoneId}`;

// ================================================================ setup
async function zonesOf(db, tenantId) {
  const zones = await rows(db, 'SELECT id, name, sort, active FROM collection_zones WHERE tenant_id = ? ORDER BY sort, name', [tenantId]);
  const days = await rows(db, 'SELECT zone_id, stream_id, weekday FROM collection_zone_days WHERE tenant_id = ?', [tenantId]);
  const streets = await rows(db, `SELECT r.id, r.zone_id, r.street_id, s.name AS street, r.from_no, r.to_no, r.side, r.not_collected FROM collection_zone_streets r
    JOIN streets s ON s.tenant_id = r.tenant_id AND s.id = r.street_id WHERE r.tenant_id = ? ORDER BY s.name, r.from_no, r.id`, [tenantId]);
  const part = (r) => ({ id: Number(r.id), street_id: Number(r.street_id), street: r.street, from_no: r.from_no === null ? null : Number(r.from_no), to_no: r.to_no === null ? null : Number(r.to_no), side: r.side });
  return {
    zones: zones.map((zn) => ({ id: Number(zn.id), name: zn.name, sort: Number(zn.sort), active: Boolean(Number(zn.active)),
      days: days.filter((d) => Number(d.zone_id) === Number(zn.id)).map((d) => ({ stream_id: Number(d.stream_id), weekday: Number(d.weekday) })),
      streets: streets.filter((r) => Number(r.zone_id) === Number(zn.id) && !Number(r.not_collected)).map(part) })),
    not_collected: streets.filter((r) => Number(r.not_collected)).map(part),
  };
}

/**
 * The setup check: every active street is in a zone or marked "not collected" (a street split by house numbers counts
 * once any part of it is; partly covered streets are listed as a warning to look at), there is a stream, and every active
 * zone has a day for at least one stream. Returns { ok, unzoned: [{ id, name }], partial: [...], problems: [words] }.
 */
async function setupCheck(db, tenantId) {
  const streets = await rows(db, 'SELECT id, name FROM streets WHERE tenant_id = ? AND active = 1 ORDER BY name', [tenantId]);
  const parts = await rows(db, `SELECT r.street_id, r.from_no, r.to_no, r.side, r.not_collected, r.zone_id FROM collection_zone_streets r
    LEFT JOIN collection_zones z ON z.tenant_id = r.tenant_id AND z.id = r.zone_id WHERE r.tenant_id = ? AND (r.not_collected = 1 OR z.active = 1)`, [tenantId]);
  const by = new Map();
  for (const p of parts) { const k = Number(p.street_id); if (!by.has(k)) by.set(k, []); by.get(k).push(p); }
  const unzoned = streets.filter((s) => !by.has(Number(s.id))).map((s) => ({ id: Number(s.id), name: s.name }));
  const partial = streets.filter((s) => by.has(Number(s.id)) && !by.get(Number(s.id)).some((p) => p.from_no === null && p.to_no === null && (p.side || 'both') === 'both')).map((s) => ({ id: Number(s.id), name: s.name }));
  const problems = [];
  const streams = await C.streamsOf(db, tenantId);
  if (!streams.length) problems.push('Add at least one stream, such as Trash.');
  const zones = await rows(db, `SELECT z.id, z.name, (SELECT COUNT(*) FROM collection_zone_days d JOIN collection_streams s ON s.tenant_id = d.tenant_id AND s.id = d.stream_id AND s.active = 1
    WHERE d.tenant_id = z.tenant_id AND d.zone_id = z.id) AS days FROM collection_zones z WHERE z.tenant_id = ? AND z.active = 1 ORDER BY z.sort, z.name`, [tenantId]);
  if (!zones.length) problems.push('Add at least one zone.');
  for (const zn of zones) if (!n(zn.days)) problems.push(`Give ${zn.name} a collection day.`);
  for (const s of streams) if (['biweekly', 'monthly'].includes(s.frequency) && !s.anchor_date) problems.push(`Give ${s.name} a date it is collected, so we know which weeks.`);
  if (unzoned.length) problems.push(`${unzoned.length} street${unzoned.length === 1 ? ' is' : 's are'} in no zone and not marked "not collected".`);
  return { ok: !problems.length, unzoned, partial, problems };
}

router.get('/collection/shell', anyone, async (req, res) => {
  const t = req.auth.tenantId;
  const s = await C.settingsOf(pool, t);
  const on = await require('../lib/modules').enabledKeys(t);
  res.json({ model: s.model, setup_done: Boolean(s.setup_done_at), on, missed_waiting: await missedWaiting(pool, t) });
});

// The plain lists other screens pick from (the routes and tonnage workstreams' pickers): active streams and zones.
router.get('/collection/streams', anyone, async (req, res) => { res.json({ data: await C.streamsOf(pool, req.auth.tenantId) }); });
router.get('/collection/zones', anyone, async (req, res) => {
  res.json({ data: (await rows(pool, 'SELECT id, name, sort FROM collection_zones WHERE tenant_id = ? AND active = 1 ORDER BY sort, name', [req.auth.tenantId])).map((z) => ({ id: Number(z.id), name: z.name, sort: Number(z.sort) })) });
});

router.get('/collection/setup', anyone, async (req, res) => {
  const t = req.auth.tenantId;
  const town = await townOf(t);
  const today = todayIn(town.timezone);
  const [s, streams, zoned, holidays, events, changes, streets, check] = await Promise.all([
    C.settingsOf(pool, t), C.streamsOf(pool, t, { all: true }), zonesOf(pool, t),
    rows(pool, 'SELECT id, on_date, name FROM collection_holidays WHERE tenant_id = ? AND on_date >= ? ORDER BY on_date', [t, addDays(today, -60)]),
    rows(pool, 'SELECT id, kind, name, starts_on, ends_on, notes, zone_ids FROM collection_events WHERE tenant_id = ? AND ends_on >= ? ORDER BY starts_on', [t, addDays(today, -60)]),
    rows(pool, 'SELECT id, on_date, moved_to, zone_ids, reason, note, notice_id, created_at FROM collection_changes WHERE tenant_id = ? AND (on_date >= ? OR moved_to >= ?) ORDER BY on_date, id', [t, addDays(today, -30), addDays(today, -30)]),
    rows(pool, 'SELECT id, name FROM streets WHERE tenant_id = ? AND active = 1 ORDER BY name', [t]),
    setupCheck(pool, t),
  ]);
  res.json({
    settings: { ...s, setup_done: Boolean(s.setup_done_at) }, models: Object.entries(MODEL_WORDS).map(([key, label]) => ({ key, label })), holiday_rules: Object.entries(RULE_WORDS).map(([key, label]) => ({ key, label })),
    streams, ...zoned, streets: streets.map((x) => ({ id: Number(x.id), name: x.name })),
    holidays: holidays.map((h) => ({ id: Number(h.id), on_date: h.on_date, name: h.name })),
    events: events.map((e) => ({ id: Number(e.id), kind: e.kind, kind_label: EVENT_WORDS[e.kind], name: e.name, starts_on: e.starts_on, ends_on: e.ends_on, notes: e.notes, zone_ids: C.asList(e.zone_ids) })),
    changes: changes.map((c) => ({ id: Number(c.id), on_date: c.on_date, moved_to: c.moved_to, zone_ids: C.asList(c.zone_ids), reason: c.reason, note: c.note, notice_id: c.notice_id ? Number(c.notice_id) : null, created_at: c.created_at })),
    check, today, page: pageLink(req, town.slug), event_kinds: Object.entries(EVENT_WORDS).map(([key, label]) => ({ key, label })),
    kinds: C.KINDS.map((k) => ({ key: k, label: C.KIND_WORDS[k] })), is_manager: ['owner', 'manager'].includes(req.auth.role),
  });
});

const blank = (v) => (v === '' || v === undefined ? null : v);
const opt = (s) => s.nullable().optional();
router.put('/collection/settings', mgr, validate(z.object({
  model: z.enum(['inhouse', 'contract', 'subscription']).optional(),
  hauler_name: opt(z.string().trim().max(120)), hauler_phone: opt(z.string().trim().max(40)), hauler_email: opt(z.union([z.string().trim().email('Type a full email address').max(255), z.literal('')])),
  hauler_url: opt(z.union([z.string().trim().url('Type the full web address, starting with https://').max(255), z.literal('')])),
  holiday_rule: z.enum(['shift', 'none', 'skip']).optional(), reminder_hour: z.number().int().min(12).max(20).optional(),
  ordinance_materials: opt(z.string().trim().max(4000)), curb_by: opt(z.string().trim().max(80)),
})), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const sets = {};
  for (const k of ['model', 'holiday_rule', 'reminder_hour']) if (b[k] !== undefined) sets[k] = b[k];
  for (const k of ['hauler_name', 'hauler_phone', 'hauler_email', 'hauler_url', 'ordinance_materials', 'curb_by']) if (b[k] !== undefined) sets[k] = blank(b[k]);
  const keys = Object.keys(sets);
  if (!keys.length) throw bad('Nothing to change');
  await tx(async (conn) => {
    await conn.query('INSERT IGNORE INTO collection_settings (tenant_id) VALUES (?)', [t]);
    await conn.query(`UPDATE collection_settings SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE tenant_id = ?`, [...keys.map((k) => sets[k]), t]);
    await audit(conn, req, 'settings', 'collection_settings', null, sets);
  });
  res.json({ ok: true, settings: await C.settingsOf(pool, t) });
});

// ---------------------------------------------------------------- streams
const mmdd = z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Use month-day, like 04-01');
const streamFields = {
  name: z.string().trim().min(1, 'Give the stream a name').max(60), kind: z.enum(C.KINDS).default('other'), frequency: z.enum(C.FREQUENCIES).default('weekly'),
  anchor_date: opt(dateStr), season_start: opt(z.union([mmdd, z.literal('')])), season_end: opt(z.union([mmdd, z.literal('')])),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Pick a color').default('#5b6770'), materials: opt(z.string().trim().max(4000)), not_accepted: opt(z.string().trim().max(4000)),
  sort: z.number().int().min(0).max(9999).optional(), active: z.boolean().optional(),
};
function checkStream(b) {
  if ((b.season_start && !b.season_end) || (!b.season_start && b.season_end)) throw bad('Give the season a first and a last day, or neither');
  if (['biweekly', 'monthly'].includes(b.frequency) && !b.anchor_date) throw bad('Every other week and monthly need a date it is collected, so we know which weeks');
}
router.post('/collection/streams', mgr, validate(z.object(streamFields)), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  checkStream(b);
  const [r] = await pool.query('INSERT INTO collection_streams (tenant_id, name, kind, frequency, anchor_date, season_start, season_end, color, materials, not_accepted, sort, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [t, b.name, b.kind, b.frequency, blank(b.anchor_date), blank(b.season_start), blank(b.season_end), b.color, blank(b.materials), blank(b.not_accepted), b.sort ?? 100, b.active === false ? 0 : 1]);
  await audit(pool, req, 'create', 'collection_streams', r.insertId, { name: b.name, frequency: b.frequency });
  res.status(201).json({ id: r.insertId });
});
router.patch('/collection/streams/:id', mgr, validate(z.object(streamFields).partial()), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = req.body;
  const cur = await one(pool, 'SELECT * FROM collection_streams WHERE tenant_id = ? AND id = ?', [t, id]);
  if (!cur) throw notFound('Stream');
  const merged = { ...cur, ...Object.fromEntries(Object.entries(b).map(([k, v]) => [k, blank(v)])) };
  checkStream(merged);
  const sets = {};
  for (const k of ['name', 'kind', 'frequency', 'color', 'sort']) if (b[k] !== undefined) sets[k] = b[k];
  for (const k of ['anchor_date', 'season_start', 'season_end', 'materials', 'not_accepted']) if (b[k] !== undefined) sets[k] = blank(b[k]);
  if (b.active !== undefined) sets.active = b.active ? 1 : 0;
  const keys = Object.keys(sets);
  if (!keys.length) throw bad('Nothing to change');
  await pool.query(`UPDATE collection_streams SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...keys.map((k) => sets[k]), t, id]);
  await audit(pool, req, 'update', 'collection_streams', id, sets);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- zones and their streets
const daysSchema = z.array(z.object({ stream_id: z.number().int().positive(), weekday: z.number().int().min(1).max(7).nullable() })).max(30);
const zoneFields = { name: z.string().trim().min(1, 'Give the zone a name').max(60), sort: z.number().int().min(0).max(9999).optional(), active: z.boolean().optional(), days: daysSchema.optional() };
async function writeDays(conn, t, zoneId, days) {
  if (!days) return;
  const ids = [...new Set(days.map((d) => d.stream_id))];
  if (ids.length) {
    const [[c]] = await conn.query('SELECT COUNT(*) AS n FROM collection_streams WHERE tenant_id = ? AND id IN (?)', [t, ids]);
    if (n(c.n) !== ids.length) throw notFound('Stream');
  }
  await conn.query('DELETE FROM collection_zone_days WHERE tenant_id = ? AND zone_id = ?', [t, zoneId]);
  for (const d of days) if (d.weekday) await conn.query('INSERT INTO collection_zone_days (tenant_id, zone_id, stream_id, weekday) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE weekday = VALUES(weekday)', [t, zoneId, d.stream_id, d.weekday]);
}
router.post('/collection/zones', mgr, validate(z.object(zoneFields)), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const id = await tx(async (conn) => {
    const [r] = await conn.query('INSERT INTO collection_zones (tenant_id, name, sort, active) VALUES (?, ?, ?, ?)', [t, b.name, b.sort ?? 100, b.active === false ? 0 : 1]);
    await writeDays(conn, t, r.insertId, b.days);
    await audit(conn, req, 'create', 'collection_zones', r.insertId, { name: b.name, days: b.days || [] });
    return r.insertId;
  });
  res.status(201).json({ id });
});
router.patch('/collection/zones/:id', mgr, validate(z.object(zoneFields).partial()), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = req.body;
  await tx(async (conn) => {
    if (!(await one(conn, 'SELECT id FROM collection_zones WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]))) throw notFound('Zone');
    const sets = {};
    if (b.name !== undefined) sets.name = b.name;
    if (b.sort !== undefined) sets.sort = b.sort;
    if (b.active !== undefined) sets.active = b.active ? 1 : 0;
    const keys = Object.keys(sets);
    if (keys.length) await conn.query(`UPDATE collection_zones SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...keys.map((k) => sets[k]), t, id]);
    await writeDays(conn, t, id, b.days);
    await audit(conn, req, 'update', 'collection_zones', id, b);
  });
  res.json({ ok: true });
});

const intOrNull = z.preprocess((v) => (v === '' || v === undefined ? null : v), z.coerce.number().int().min(0).max(9999999).nullable());
const partSchema = z.object({ street_id: z.coerce.number().int().positive(), from_no: intOrNull.optional(), to_no: intOrNull.optional(), side: z.enum(['both', 'odd', 'even']).default('both') })
  .refine((a) => a.from_no == null || a.to_no == null || a.from_no <= a.to_no, { message: 'The first house number must not be higher than the last', path: ['to_no'] });
const partsSchema = z.object({ streets: z.array(partSchema).max(3000) });
async function writeParts(conn, req, zoneId, parts) {
  const t = req.auth.tenantId;
  const ids = [...new Set(parts.map((p) => p.street_id))];
  if (ids.length) {
    const [[c]] = await conn.query('SELECT COUNT(*) AS n FROM streets WHERE tenant_id = ? AND id IN (?)', [t, ids]);
    if (n(c.n) !== ids.length) throw bad('One of the streets is not on your street list. Reload the page and pick again.');
  }
  if (zoneId) await conn.query('DELETE FROM collection_zone_streets WHERE tenant_id = ? AND zone_id = ? AND not_collected = 0', [t, zoneId]);
  else await conn.query('DELETE FROM collection_zone_streets WHERE tenant_id = ? AND not_collected = 1', [t]);
  for (const p of parts) {
    await conn.query('INSERT INTO collection_zone_streets (tenant_id, zone_id, street_id, from_no, to_no, side, not_collected) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [t, zoneId || null, p.street_id, p.from_no ?? null, p.to_no ?? null, p.side || 'both', zoneId ? 0 : 1]);
  }
}
router.put('/collection/zones/:id/streets', mgr, validate(partsSchema), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  await tx(async (conn) => {
    if (!(await one(conn, 'SELECT id FROM collection_zones WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]))) throw notFound('Zone');
    await writeParts(conn, req, id, req.body.streets);
    await audit(conn, req, 'zone_streets', 'collection_zones', id, { streets: req.body.streets.length });
  });
  res.json({ ok: true, check: await setupCheck(pool, t) });
});
router.put('/collection/not-collected', mgr, validate(partsSchema), async (req, res) => {
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    await writeParts(conn, req, null, req.body.streets);
    await audit(conn, req, 'not_collected', 'collection_zone_streets', null, { streets: req.body.streets.length });
  });
  res.json({ ok: true, check: await setupCheck(pool, t) });
});

router.get('/collection/setup/check', anyone, async (req, res) => { res.json(await setupCheck(pool, req.auth.tenantId)); });
router.post('/collection/setup/finish', mgr, async (req, res) => {
  const t = req.auth.tenantId;
  const check = await setupCheck(pool, t);
  if (!check.ok) throw conflict(`Setup is not finished: ${check.problems.join(' ')}`, { code: 'setup_incomplete', ...check });
  await tx(async (conn) => {
    await conn.query('INSERT IGNORE INTO collection_settings (tenant_id) VALUES (?)', [t]);
    await conn.query('UPDATE collection_settings SET setup_done_at = COALESCE(setup_done_at, UTC_TIMESTAMP()) WHERE tenant_id = ?', [t]);
    await audit(conn, req, 'setup_finished', 'collection_settings', null, null);
  });
  const town = await townOf(t);
  res.json({ ok: true, page: pageLink(req, town.slug) });
});

// ---------------------------------------------------------------- holidays, events, changes
router.post('/collection/holidays', mgr, validate(z.object({ on_date: dateStr, name: z.string().trim().min(1).max(80) })), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const [r] = await pool.query('INSERT INTO collection_holidays (tenant_id, on_date, name) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [t, b.on_date, b.name]);
  await audit(pool, req, 'create', 'collection_holidays', r.insertId || null, b);
  res.status(201).json({ ok: true });
});
router.post('/collection/holidays/federal', mgr, validate(z.object({ year: z.number().int().min(2020).max(2099) })), async (req, res) => {
  const t = req.auth.tenantId;
  let added = 0;
  for (const h of C.federalHolidays(req.body.year)) { const [r] = await pool.query('INSERT IGNORE INTO collection_holidays (tenant_id, on_date, name) VALUES (?, ?, ?)', [t, h.on_date, h.name]); added += r.affectedRows; }
  await audit(pool, req, 'federal_holidays', 'collection_holidays', null, { year: req.body.year, added });
  res.json({ added });
});
router.delete('/collection/holidays/:id', mgr, async (req, res) => {
  const [r] = await pool.query('DELETE FROM collection_holidays WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Holiday');
  await audit(pool, req, 'delete', 'collection_holidays', paramId(req), null);
  res.json({ ok: true });
});

async function checkZones(db, t, ids) {
  const list = [...new Set(ids || [])];
  if (!list.length) return [];
  const [[c]] = await db.query('SELECT COUNT(*) AS n FROM collection_zones WHERE tenant_id = ? AND id IN (?)', [t, list]);
  if (n(c.n) !== list.length) throw notFound('Zone');
  return list;
}
const eventFields = z.object({ kind: z.enum(['leaf', 'tree', 'hazardous', 'other']), name: z.string().trim().min(1).max(120), starts_on: dateStr, ends_on: dateStr, notes: opt(z.string().trim().max(2000)), zone_ids: z.array(z.number().int().positive()).max(100).default([]) })
  .refine((e) => e.starts_on <= e.ends_on, { message: 'The last day is before the first', path: ['ends_on'] });
router.post('/collection/events', mgr, validate(eventFields), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const zones = await checkZones(pool, t, b.zone_ids);
  const [r] = await pool.query('INSERT INTO collection_events (tenant_id, kind, name, starts_on, ends_on, notes, zone_ids) VALUES (?, ?, ?, ?, ?, ?, ?)', [t, b.kind, b.name, b.starts_on, b.ends_on, blank(b.notes), JSON.stringify(zones)]);
  await audit(pool, req, 'create', 'collection_events', r.insertId, { kind: b.kind, starts_on: b.starts_on, ends_on: b.ends_on });
  res.status(201).json({ id: r.insertId });
});
router.patch('/collection/events/:id', mgr, validate(eventFields), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const zones = await checkZones(pool, t, b.zone_ids);
  const [r] = await pool.query('UPDATE collection_events SET kind = ?, name = ?, starts_on = ?, ends_on = ?, notes = ?, zone_ids = ? WHERE tenant_id = ? AND id = ?', [b.kind, b.name, b.starts_on, b.ends_on, blank(b.notes), JSON.stringify(zones), t, paramId(req)]);
  if (!r.affectedRows) throw notFound('Event');
  await audit(pool, req, 'update', 'collection_events', paramId(req), { kind: b.kind });
  res.json({ ok: true });
});
router.delete('/collection/events/:id', mgr, async (req, res) => {
  const [r] = await pool.query('DELETE FROM collection_events WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Event');
  await audit(pool, req, 'delete', 'collection_events', paramId(req), null);
  res.json({ ok: true });
});

const CHANGE_REASON = { snow: 'snow', weather: 'the weather', holiday: 'the holiday', other: 'a schedule change' };
/**
 * A day moved or canceled for some zones (or all), and with notice: true a draft street notice to those zones (type
 * "Trash schedule change", its streets taken from the zones) for a manager to check and send from Street notices.
 */
router.post('/collection/changes', mgr, validate(z.object({
  on_date: dateStr, moved_to: dateStr.nullable(), zone_ids: z.array(z.number().int().positive()).max(100).default([]), reason: z.enum(['snow', 'weather', 'holiday', 'other']),
  note: opt(z.string().trim().max(255)), notice: z.boolean().default(true),
})), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  if (b.moved_to && b.moved_to === b.on_date) throw bad('Pick a different day to move it to');
  const out = await tx(async (conn) => {
    const zones = await checkZones(conn, t, b.zone_ids);
    const [r] = await conn.query('INSERT INTO collection_changes (tenant_id, on_date, moved_to, zone_ids, reason, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)', [t, b.on_date, b.moved_to, JSON.stringify(zones), b.reason, blank(b.note), req.auth.userId]);
    let noticeId = null;
    if (b.notice) noticeId = await draftNotice(conn, req, { id: r.insertId, ...b, zone_ids: zones });
    await audit(conn, req, 'create', 'collection_changes', r.insertId, { on_date: b.on_date, moved_to: b.moved_to, zones, reason: b.reason, notice_id: noticeId });
    return { id: r.insertId, notice_id: noticeId };
  });
  res.status(201).json(out);
});
async function draftNotice(conn, req, ch) {
  const t = req.auth.tenantId;
  const zoneIds = ch.zone_ids.length ? ch.zone_ids : (await rows(conn, 'SELECT id FROM collection_zones WHERE tenant_id = ? AND active = 1', [t])).map((x) => Number(x.id));
  const areas = await C.zoneAreas(conn, t, zoneIds);
  if (!areas.length) return null;
  const zoneNames = (await rows(conn, 'SELECT name FROM collection_zones WHERE tenant_id = ? AND id IN (?) ORDER BY sort, name', [t, zoneIds])).map((x) => x.name);
  const why = CHANGE_REASON[ch.reason];
  const day = C.longDay(ch.on_date);
  const smsText = ch.moved_to ? `${day.split(',')[0]}'s trash and recycling pickup moves to ${C.longDay(ch.moved_to)} because of ${why}.` : `No trash or recycling pickup on ${day} because of ${why}.`;
  // The "out by" rule is the borough's own (Schedule, Setup); without one, nothing is said about a time.
  const curb = ((await C.settingsOf(conn, t)) || {}).curb_by;
  const body = `${smsText}${ch.note ? ` ${ch.note}` : ''}\n\nThis is for ${ch.zone_ids.length ? `these collection zones: ${zoneNames.join(', ')}` : 'every collection zone'}.${curb ? ` ${String(curb).replace(/\.?\s*$/, '.')}` : ''}`;
  const title = ch.moved_to ? `Pickup moves to ${C.longDay(ch.moved_to)}` : `No pickup on ${day}`;
  const code = () => Array.from(require('crypto').randomBytes(6), (x) => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[x % 31]).join('');
  let id = null;
  for (let i = 0; i < 5 && !id; i += 1) {
    try {
      const [r] = await conn.query(`INSERT INTO street_notices (tenant_id, code, type, title, sms_text, body, collection_zone_ids, created_by) VALUES (?, ?, 'trash_change', ?, ?, ?, ?, ?)`,
        [t, code(), title.slice(0, 120), smsText.slice(0, 320), body, JSON.stringify(ch.zone_ids), req.auth.userId]);
      id = r.insertId;
    } catch (err) { if (err.code !== 'ER_DUP_ENTRY') throw err; }
  }
  for (const a of areas) await conn.query('INSERT INTO street_notice_areas (tenant_id, notice_id, street_id, from_no, to_no, side) VALUES (?, ?, ?, ?, ?, ?)', [t, id, a.street_id, a.from_no, a.to_no, a.side]);
  await conn.query('UPDATE collection_changes SET notice_id = ? WHERE tenant_id = ? AND id = ?', [id, t, ch.id]);
  await audit(conn, req, 'create', 'street_notices', id, { type: 'trash_change', from: 'collection_change', change_id: ch.id });
  return id;
}
router.delete('/collection/changes/:id', mgr, async (req, res) => {
  const t = req.auth.tenantId;
  const c = await one(pool, 'SELECT id, notice_id FROM collection_changes WHERE tenant_id = ? AND id = ?', [t, paramId(req)]);
  if (!c) throw notFound('Change');
  await pool.query('DELETE FROM collection_changes WHERE tenant_id = ? AND id = ?', [t, c.id]);
  await audit(pool, req, 'delete', 'collection_changes', c.id, null);
  res.json({ ok: true, notice_id: c.notice_id ? Number(c.notice_id) : null });
});

// ================================================================ the calendar, a day, an address
const rangeQuery = (req, today) => {
  const from = C.isDate(first(req.query.from)) ? first(req.query.from) : today;
  const to = C.isDate(first(req.query.to)) ? first(req.query.to) : addDays(from, 41);
  if (to < from) throw bad('The last day is before the first');
  if (C.mondayOf(to) > addDays(from, 400)) throw bad('Ask for a year at most');
  return { from, to };
};
router.get('/collection/calendar', anyone, async (req, res) => {
  const t = req.auth.tenantId; const town = await townOf(t);
  const { from, to } = rangeQuery(req, todayIn(town.timezone));
  const zoneId = idOf(req.query.zone_id);
  const zones = await rows(pool, `SELECT id, name FROM collection_zones WHERE tenant_id = ? AND active = 1${zoneId ? ' AND id = ?' : ''} ORDER BY sort, name`, zoneId ? [t, zoneId] : [t]);
  const streams = await C.streamsOf(pool, t);
  const out = [];
  for (const zn of zones) out.push({ id: Number(zn.id), name: zn.name, days: await C.collectionDays(pool, t, { zoneId: zn.id, from, to }) });
  const holidays = await rows(pool, 'SELECT on_date, name FROM collection_holidays WHERE tenant_id = ? AND on_date BETWEEN ? AND ? ORDER BY on_date', [t, from, to]);
  const events = await rows(pool, 'SELECT id, kind, name, starts_on, ends_on, zone_ids FROM collection_events WHERE tenant_id = ? AND ends_on >= ? AND starts_on <= ? ORDER BY starts_on', [t, from, to]);
  res.json({ from, to, today: todayIn(town.timezone), zones: out, streams: streams.map((s) => ({ id: s.id, name: s.name, color: s.color, kind: s.kind })), holidays,
    events: events.map((e) => ({ ...e, kind_label: EVENT_WORDS[e.kind], zone_ids: C.asList(e.zone_ids) })) });
});
router.get('/collection/day', anyone, async (req, res) => {
  const t = req.auth.tenantId; const town = await townOf(t);
  const date = C.isDate(first(req.query.date)) ? first(req.query.date) : todayIn(town.timezone);
  res.json({ date, today: todayIn(town.timezone), routes: await C.dayRoutes(pool, t, date) });
});

/** An address's zone and the next date of each stream (the same words for staff and the public page). */
async function addressAnswer(db, tenantId, streetId, houseNo, today) {
  const zone = await C.zoneFor(db, tenantId, { streetId, houseNo });
  if (!zone) return { found: false, message: 'We could not find a collection day for that address. Check the street and number, or call the office.' };
  if (zone.notCollected) return { found: true, not_collected: true, message: 'The borough does not collect at this address. It may use a private hauler.' };
  const days = await C.zoneDaysOf(db, tenantId, zone.zoneId);
  const next = await C.nextFor(db, tenantId, { zoneId: zone.zoneId, today });
  return {
    found: true, not_collected: false, zone: { id: zone.zoneId, name: zone.zoneName },
    next: next.map((x) => { const d = days.find((y) => y.stream.id === x.streamId); return { stream_id: x.streamId, stream: x.streamName, kind: x.kind, color: x.color, date: x.date, original: x.original, moved: x.moved, reason: x.reason || null, words: C.dayWords(x), how_often: d ? C.howOften(d.stream, d.weekday) : null, season: d && d.stream.season_start ? { from: d.stream.season_start, to: d.stream.season_end } : null }; }),
  };
}
router.get('/collection/lookup', anyone, async (req, res) => {
  const t = req.auth.tenantId; const town = await townOf(t);
  const streetId = idOf(req.query.street_id || req.query.street);
  if (!streetId) throw bad('Pick the street');
  res.json(await addressAnswer(pool, t, streetId, first(req.query.house_number || req.query.no).slice(0, 20), todayIn(town.timezone)));
});
router.get('/collection/check', anyone, async (req, res) => {
  const streetId = idOf(req.query.street);
  if (!streetId) throw bad('Pick the street');
  res.json(await C.pickupCheck(pool, req.auth.tenantId, { streetId, houseNo: first(req.query.no).slice(0, 20), streamId: idOf(req.query.stream) }));
});

// ================================================================ missed pickups
/** Missed pickup requests not yet answered (status new): the Missed pickups tab, the menu's count and the Today card. */
const missedWaiting = (db, tenantId) => require('../lib/waiting').missedPickups(db, tenantId);
const CHECK_WORDS = { not_collected: 'Not on the collection', not_your_day: 'Not their day', not_yet: 'Truck not there yet', skipped: 'Street skipped', done: 'Street done', ok_to_report: 'Collection day' };
router.get('/collection/missed', anyone, async (req, res) => {
  const t = req.auth.tenantId;
  const Q = require('../lib/requests');
  const show = first(req.query.show) === 'all' ? 'all' : 'open';
  const list = await rows(pool, `${Q.REQ_SQL} WHERE r.tenant_id = ? AND c.code = 'missed'${show === 'open' ? " AND r.status IN ('new','assigned','made_safe')" : ' AND r.reported_at >= UTC_TIMESTAMP() - INTERVAL 120 DAY'} ORDER BY r.reported_at DESC LIMIT 500`, [t]);
  const streams = new Map((await C.streamsOf(pool, t, { all: true })).map((s) => [s.id, s]));
  const counts = list.length ? await rows(pool, `SELECT r.street_id, r.house_number, COUNT(*) AS n FROM requests r JOIN request_categories c ON c.tenant_id = r.tenant_id AND c.id = r.category_id
    WHERE r.tenant_id = ? AND c.code = 'missed' AND r.reported_at >= UTC_TIMESTAMP() - INTERVAL 60 DAY AND r.street_id IS NOT NULL GROUP BY r.street_id, r.house_number`, [t]) : [];
  const repeat = new Map(counts.map((c) => [`${c.street_id}|${String(c.house_number || '').trim().toLowerCase()}`, n(c.n)]));
  res.json({
    show, waiting: await missedWaiting(pool, t),
    data: list.map((r) => {
      const s = r.stream_id ? streams.get(Number(r.stream_id)) : null;
      const times = repeat.get(`${r.street_id}|${String(r.house_number || '').trim().toLowerCase()}`) || 1;
      return { id: Number(r.id), reference: r.reference, place: Q.placeWords(r), street: r.street_name || null, status: r.status, status_words: Q.STATUS_WORDS[r.status], reported_at: r.reported_at, source: r.source,
        stream: s ? s.name : null, stream_color: s ? s.color : null, check: r.pickup_check || null, check_words: r.pickup_check ? CHECK_WORDS[r.pickup_check] || r.pickup_check : null, repeat: times > 1 ? times : 0 };
    }),
  });
});

// ================================================================ reminders and the Act 101 education log
router.get('/collection/reminders', mgr, async (req, res) => {
  const t = req.auth.tenantId;
  const streams = await C.streamsOf(pool, t);
  const signups = await rows(pool, "SELECT collection_streams, by_text, by_email FROM alert_signups WHERE tenant_id = ? AND status = 'active' AND collection_streams IS NOT NULL AND collection_streams <> '' AND FIND_IN_SET('trash', topics) > 0", [t]);
  const sends = await rows(pool, "SELECT DATE_FORMAT(for_date, '%Y-%m') AS month, channel, status, COUNT(*) AS n FROM collection_reminder_sends WHERE tenant_id = ? AND for_date >= UTC_DATE() - INTERVAL 13 MONTH GROUP BY month, channel, status ORDER BY month DESC", [t]);
  res.json({
    signups: signups.length, texts: signups.filter((s) => Number(s.by_text)).length, emails: signups.filter((s) => Number(s.by_email)).length,
    streams: streams.map((s) => ({ id: s.id, name: s.name, signups: signups.filter((x) => C.asList(x.collection_streams).includes(s.id)).length })),
    sends: sends.map((x) => ({ month: x.month, channel: x.channel, status: x.status, n: n(x.n) })), hour: (await C.settingsOf(pool, t)).reminder_hour,
  });
});

const EDU_KINDS = ['mailer', 'newsletter', 'website', 'event', 'notice', 'reminder', 'other'];
const EDU_WORDS = { mailer: 'Printed mailer', newsletter: 'Newsletter', website: 'Website', event: 'Event or school visit', notice: 'Street notice', reminder: 'Reminder texts and emails', other: 'Other' };
/**
 * The Act 101 education log: what the borough entered, plus what the app sent itself (trash and leaf street notices, and
 * each month's night-before reminders). Residents must be reminded at least every six months, with a printed form once a
 * year: { entries, last_at, next_due, printed_this_year }.
 */
async function educationLog(db, tenantId, today) {
  const own = await rows(db, 'SELECT id, on_date, kind, printed, title, audience, copies, note, created_at FROM collection_education WHERE tenant_id = ? ORDER BY on_date DESC, id DESC LIMIT 500', [tenantId]);
  const notices = await rows(db, `SELECT n.id, DATE(n.sent_at) AS on_date, n.title, n.type, (SELECT COUNT(*) FROM street_notice_deliveries d WHERE d.tenant_id = n.tenant_id AND d.notice_id = n.id AND d.status = 'sent') AS sent
    FROM street_notices n WHERE n.tenant_id = ? AND n.type IN ('trash_change','leaf_collection') AND n.sent_at IS NOT NULL ORDER BY n.sent_at DESC LIMIT 200`, [tenantId]);
  const months = await rows(db, "SELECT DATE_FORMAT(for_date, '%Y-%m') AS month, MAX(for_date) AS last_day, COUNT(*) AS n FROM collection_reminder_sends WHERE tenant_id = ? AND status = 'sent' GROUP BY month ORDER BY month DESC LIMIT 36", [tenantId]);
  const entries = [
    ...own.map((e) => ({ id: Number(e.id), on_date: e.on_date, kind: e.kind, kind_label: EDU_WORDS[e.kind], printed: Boolean(Number(e.printed)) || e.kind === 'mailer', title: e.title, audience: e.audience, copies: e.copies === null ? null : Number(e.copies), note: e.note, own: true })),
    ...notices.map((x) => ({ on_date: String(x.on_date).slice(0, 10), kind: 'notice', kind_label: EDU_WORDS.notice, printed: false, title: x.title, audience: `${n(x.sent)} texts and emails`, own: false })),
    ...months.map((m) => ({ on_date: String(m.last_day).slice(0, 10), kind: 'reminder', kind_label: EDU_WORDS.reminder, printed: false, title: `Night-before reminders, ${new Date(`${m.month}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`, audience: `${n(m.n)} sent`, own: false })),
  ].sort((a, b) => (a.on_date < b.on_date ? 1 : a.on_date > b.on_date ? -1 : 0));
  const last = entries.find((e) => e.on_date <= today);
  const lastAt = last ? last.on_date : null;
  const sixMonths = (d) => { const [y, m, dd] = d.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1 + 6, dd, 12)); return x.toISOString().slice(0, 10); };
  return { entries, last_at: lastAt, next_due: lastAt ? sixMonths(lastAt) : today, overdue: !lastAt || sixMonths(lastAt) < today, printed_this_year: entries.some((e) => e.printed && String(e.on_date).slice(0, 4) === today.slice(0, 4)), kinds: EDU_KINDS.map((k) => ({ key: k, label: EDU_WORDS[k] })) };
}
router.get('/collection/education', desk, async (req, res) => {
  const town = await townOf(req.auth.tenantId);
  res.json(await educationLog(pool, req.auth.tenantId, todayIn(town.timezone)));
});
router.post('/collection/education', desk, validate(z.object({
  on_date: dateStr, kind: z.enum(EDU_KINDS), title: z.string().trim().min(1).max(160), audience: opt(z.string().trim().max(160)), copies: z.number().int().min(0).max(10000000).nullable().optional(),
  note: opt(z.string().trim().max(500)), printed: z.boolean().optional(),
})), async (req, res) => {
  const b = req.body;
  const [r] = await pool.query('INSERT INTO collection_education (tenant_id, on_date, kind, printed, title, audience, copies, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [req.auth.tenantId, b.on_date, b.kind, b.printed || b.kind === 'mailer' ? 1 : 0, b.title, blank(b.audience), b.copies ?? null, blank(b.note), req.auth.userId]);
  await audit(pool, req, 'create', 'collection_education', r.insertId, { kind: b.kind, on_date: b.on_date });
  res.status(201).json({ id: r.insertId });
});
router.delete('/collection/education/:id', mgr, async (req, res) => {
  const [r] = await pool.query('DELETE FROM collection_education WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Entry');
  await audit(pool, req, 'delete', 'collection_education', paramId(req), null);
  res.json({ ok: true });
});

/** A zone's year: { zone, days, holidays, events } with each day's stream; the mailer and the public page print it. */
async function yearOf(db, tenantId, zoneId, year) {
  const from = `${year}-01-01`; const to = `${year}-12-31`;
  const days = await C.collectionDays(db, tenantId, { zoneId, from, to });
  const holidays = await rows(db, 'SELECT on_date, name FROM collection_holidays WHERE tenant_id = ? AND on_date BETWEEN ? AND ? ORDER BY on_date', [tenantId, from, to]);
  const events = (await rows(db, 'SELECT kind, name, starts_on, ends_on, notes, zone_ids FROM collection_events WHERE tenant_id = ? AND ends_on >= ? AND starts_on <= ? ORDER BY starts_on', [tenantId, from, to]))
    .filter((e) => { const z2 = C.asList(e.zone_ids); return !z2.length || z2.includes(Number(zoneId)); })
    .map((e) => ({ kind: e.kind, kind_label: EVENT_WORDS[e.kind], name: e.name, starts_on: e.starts_on, ends_on: e.ends_on, notes: e.notes }));
  const zdays = await C.zoneDaysOf(db, tenantId, zoneId);
  return { days: days.map((d) => ({ date: d.date, stream_id: d.streamId, stream: d.streamName, kind: d.kind, moved: d.moved, reason: d.reason || null })), holidays, events,
    streams: zdays.map((d) => ({ id: d.stream.id, name: d.stream.name, kind: d.stream.kind, color: d.stream.color, how_often: C.howOften(d.stream, d.weekday), season: d.stream.season_start ? { from: d.stream.season_start, to: d.stream.season_end } : null })) };
}
router.get('/collection/mailer', anyone, async (req, res) => {
  const t = req.auth.tenantId; const town = await townOf(t);
  const year = Number(first(req.query.year)) || Number(todayIn(town.timezone).slice(0, 4));
  if (year < 2020 || year > 2099) throw bad('Pick a year');
  const zones = await rows(pool, 'SELECT id, name FROM collection_zones WHERE tenant_id = ? AND active = 1 ORDER BY sort, name', [t]);
  const s = await C.settingsOf(pool, t);
  const out = [];
  for (const zn of zones) out.push({ id: Number(zn.id), name: zn.name, ...(await yearOf(pool, t, zn.id, year)) });
  const streams = await C.streamsOf(pool, t);
  res.json({ municipality: town.name, phone: town.phone, year, zones: out, streams, ordinance_materials: s.ordinance_materials, curb_by: s.curb_by, holiday_rule: RULE_WORDS[s.holiday_rule], page: pageLink(req, town.slug), hauler: s.model === 'contract' ? { name: s.hauler_name, phone: s.hauler_phone } : null });
});

// ================================================================ Today
/** Trash and recycling's own Today cards (GET /solid-waste/today adds them to bulk pickup's: routes/bulkpickup.js). */
C.addTodayCards(async (req) => {
  const t = req.auth.tenantId;
  const town = await townOf(t);
  const s = await C.settingsOf(pool, t);
  const isMgr = ['owner', 'manager'].includes(req.auth.role);
  const cards = [];
  if (!s.setup_done_at) {
    if (isMgr) cards.push(card({ title: 'Collection schedule not set up', count: null, text: 'Add the streams and zones, then finish setup to publish the calendar for residents.', href: '#/bulk?tab=schedule' }));
    return cards;
  }
  const today = todayIn(town.timezone);
  const routes = await C.dayRoutes(pool, t, today);
  if (routes.length) {
    const words = [...new Set(routes.map((r) => r.streamName))].join(', ');
    const moved = routes.filter((r) => r.moved).length;
    cards.push(card({ title: 'Collection today', count: new Set(routes.map((r) => r.zoneId)).size, text: `${words} in ${[...new Set(routes.map((r) => r.zoneName))].join(', ')}${moved ? '. Moved from another day' : ''}`, href: `#/bulk?tab=calendar&date=${today}` }));
  }
  if (['owner', 'manager', 'counter'].includes(req.auth.role)) {
    const waiting = await missedWaiting(pool, t);
    cards.push(card({ title: 'Missed pickups', count: waiting, text: waiting ? 'Waiting for someone to decide what to do' : 'Nothing waiting', href: '#/bulk?tab=missed' }));
  }
  return cards;
});

// ================================================================ public
const SLUG = /^[a-z0-9-]{1,80}$/i;
async function municipality(slug) {
  if (!SLUG.test(String(slug || ''))) throw new AppError(404, 'Page not found');
  const t = await one(pool, "SELECT id, name, slug, timezone, phone FROM tenants WHERE slug = ? AND org_type = 'municipality' AND status = 'active'", [slug]);
  if (!t) throw new AppError(404, 'Page not found');
  return t;
}
/** The municipality, once its calendar is published (setup finished). */
async function published(slug) {
  const t = await municipality(slug);
  const s = await C.settingsOf(pool, t.id);
  if (!s.setup_done_at) throw new AppError(404, 'The collection calendar is not published yet');
  return { t, s };
}
/** Active trash and leaf street notices: aimed at this zone, or at no zone in particular. */
async function noticesFor(tenantId, zoneId) {
  const list = await rows(pool, "SELECT id, code, type, title, sms_text, body, starts_at, ends_expected_at, sent_at, collection_zone_ids FROM street_notices WHERE tenant_id = ? AND status = 'active' AND type IN ('trash_change','leaf_collection') ORDER BY sent_at DESC LIMIT 10", [tenantId]);
  return list.filter((x) => { const zs = C.asList(x.collection_zone_ids); return !zs.length || !zoneId || zs.includes(Number(zoneId)); })
    .map((x) => ({ code: x.code, title: x.title, text: x.body || x.sms_text, sent_at: x.sent_at, until: x.ends_expected_at, zones: C.asList(x.collection_zone_ids) }));
}

publicRouter.get('/:slug/collection', async (req, res) => {
  const t = await municipality(req.params.slug);
  res.set('Cache-Control', 'no-store');
  const s = await C.settingsOf(pool, t.id);
  if (!s.setup_done_at) return res.json({ municipality: t.name, ready: false, phone: t.phone || null });
  const M = require('../lib/modules');
  const on = (await M.stateOf(t.id)).on;
  const today = todayIn(t.timezone);
  const [streams, streets, events, holidays, notices, zones] = await Promise.all([
    C.streamsOf(pool, t.id), rows(pool, 'SELECT id, name FROM streets WHERE tenant_id = ? AND active = 1 ORDER BY name', [t.id]),
    rows(pool, 'SELECT kind, name, starts_on, ends_on, notes, zone_ids FROM collection_events WHERE tenant_id = ? AND ends_on >= ? ORDER BY starts_on LIMIT 20', [t.id, today]),
    rows(pool, 'SELECT on_date, name FROM collection_holidays WHERE tenant_id = ? AND on_date >= ? ORDER BY on_date LIMIT 12', [t.id, today]),
    noticesFor(t.id, null), rows(pool, 'SELECT id, name FROM collection_zones WHERE tenant_id = ? AND active = 1 ORDER BY sort, name', [t.id]),
  ]);
  const report = on.has('requests') ? await one(pool, "SELECT id FROM request_categories WHERE tenant_id = ? AND code = 'missed' AND active = 1", [t.id]) : null;
  const sms = require('../lib/sms'); const mailer = require('../lib/mailer');
  res.json({
    municipality: t.name, ready: true, today, phone: t.phone || null, holiday_rule: RULE_WORDS[s.holiday_rule], curb_by: s.curb_by, ordinance_materials: s.ordinance_materials,
    hauler: s.model === 'contract' && (s.hauler_name || s.hauler_phone) ? { name: s.hauler_name, phone: s.hauler_phone, url: s.hauler_url } : null,
    streams: streams.map((x) => ({ id: x.id, name: x.name, kind: x.kind, color: x.color, materials: x.materials, not_accepted: x.not_accepted, season: x.season_start ? { from: x.season_start, to: x.season_end } : null })),
    streets: streets.map((x) => ({ id: Number(x.id), name: x.name })), zones: zones.map((x) => ({ id: Number(x.id), name: x.name })),
    events: events.map((e) => ({ kind: e.kind, kind_label: EVENT_WORDS[e.kind], name: e.name, starts_on: e.starts_on, ends_on: e.ends_on, notes: e.notes, zones: C.asList(e.zone_ids) })),
    holidays, notices,
    links: { bulk_pickup: `/bulk-pickup/${encodeURIComponent(t.slug)}`, report: report ? `/report/${encodeURIComponent(t.slug)}?category=missed` : null },
    reminders: on.has('requests') && (sms.enabled() || mailer.enabled()) ? { texts: sms.enabled(), emails: mailer.enabled() } : null,
  });
});

/** street + no from the query, checked against this municipality's streets. Never says more than "not found". */
async function streetFrom(req, tenantId) {
  const streetId = idOf(req.query.street);
  if (!streetId) throw bad('Pick your street');
  const s = await one(pool, 'SELECT id FROM streets WHERE tenant_id = ? AND id = ? AND active = 1', [tenantId, streetId]);
  if (!s) throw bad('Pick your street from the list');
  return Number(s.id);
}
publicRouter.get('/:slug/collection/lookup', async (req, res) => {
  const { t } = await published(req.params.slug);
  res.set('Cache-Control', 'no-store');
  const streetId = await streetFrom(req, t.id);
  const out = await addressAnswer(pool, t.id, streetId, first(req.query.no).slice(0, 20), todayIn(t.timezone));
  if (out.zone) {
    out.notices = await noticesFor(t.id, out.zone.id);
    out.ics = icsLink(req, t.slug, out.zone.id);
    const today = todayIn(t.timezone);
    out.events = (await rows(pool, 'SELECT kind, name, starts_on, ends_on, notes, zone_ids FROM collection_events WHERE tenant_id = ? AND ends_on >= ? ORDER BY starts_on LIMIT 20', [t.id, today]))
      .filter((e) => { const zs = C.asList(e.zone_ids); return !zs.length || zs.includes(out.zone.id); })
      .map((e) => ({ kind: e.kind, kind_label: EVENT_WORDS[e.kind], name: e.name, starts_on: e.starts_on, ends_on: e.ends_on, notes: e.notes }));
  }
  res.json(out);
});
publicRouter.get('/:slug/collection/year', async (req, res) => {
  const { t, s } = await published(req.params.slug);
  const zoneId = idOf(req.query.zone);
  const zn = zoneId ? await one(pool, 'SELECT id, name FROM collection_zones WHERE tenant_id = ? AND id = ? AND active = 1', [t.id, zoneId]) : null;
  if (!zn) throw new AppError(404, 'Zone not found');
  const year = Number(first(req.query.year)) || Number(todayIn(t.timezone).slice(0, 4));
  if (year < 2020 || year > 2099) throw bad('Pick a year');
  res.set('Cache-Control', 'no-store').json({ municipality: t.name, year, zone: { id: Number(zn.id), name: zn.name }, curb_by: s.curb_by, holiday_rule: RULE_WORDS[s.holiday_rule], ...(await yearOf(pool, t.id, zn.id, year)) });
});
publicRouter.get('/:slug/collection/check', async (req, res) => {
  const { t } = await published(req.params.slug);
  res.set('Cache-Control', 'no-store');
  const streetId = await streetFrom(req, t.id);
  const out = await C.pickupCheck(pool, t.id, { streetId, houseNo: first(req.query.no).slice(0, 20), streamId: idOf(req.query.stream) });
  res.json({ ...out, may_send: C.SEND_OK.includes(out.outcome) });
});

// ---------------------------------------------------------------- the iCalendar feed
const icsText = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** Folds a line to 75 octets, as RFC 5545 asks (continuation lines start with a space). */
function fold(line) {
  const out = []; let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}
const compact = (d) => String(d).slice(0, 10).replace(/-/g, '');
publicRouter.get('/:slug/collection/calendar.ics', async (req, res) => {
  const { t } = await published(req.params.slug);
  const zoneId = idOf(req.query.zone);
  const zn = zoneId ? await one(pool, 'SELECT id, name FROM collection_zones WHERE tenant_id = ? AND id = ? AND active = 1', [t.id, zoneId]) : null;
  if (!zn) throw new AppError(404, 'Zone not found');
  const only = C.asList(first(req.query.streams));
  const today = todayIn(t.timezone);
  const days = (await C.collectionDays(pool, t.id, { zoneId: zn.id, from: addDays(today, -30), to: addDays(today, 365) })).filter((d) => !only.length || only.includes(d.streamId));
  const events = (await rows(pool, 'SELECT id, kind, name, starts_on, ends_on, notes, zone_ids FROM collection_events WHERE tenant_id = ? AND ends_on >= ? ORDER BY starts_on', [t.id, addDays(today, -30)]))
    .filter((e) => { const zs = C.asList(e.zone_ids); return !zs.length || zs.includes(Number(zn.id)); });
  const host = String(req.hostname || 'verdynt').replace(/[^a-z0-9.-]/gi, '');
  const stamp = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Verdynt OS//Collection calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(`${t.name}: trash and recycling (${zn.name})`)}`, `X-WR-TIMEZONE:${icsText(t.timezone)}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT12H', 'X-PUBLISHED-TTL:PT12H'];
  for (const d of days) {
    lines.push('BEGIN:VEVENT', `UID:${compact(d.original)}-${d.streamId}-${zn.id}-${t.id}@${host}`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${compact(d.date)}`, `DTEND;VALUE=DATE:${compact(addDays(d.date, 1))}`,
      `SUMMARY:${icsText(`${d.streamName}${d.moved ? ` (${C.REASON_WORDS[d.reason] || 'moved'})` : ''}`)}`, `CATEGORIES:${icsText(C.KIND_WORDS[d.kind] || 'Collection')}`, 'TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:event-${e.id}-${t.id}@${host}`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${compact(e.starts_on)}`, `DTEND;VALUE=DATE:${compact(addDays(String(e.ends_on).slice(0, 10), 1))}`,
      `SUMMARY:${icsText(e.name)}`, ...(e.notes ? [`DESCRIPTION:${icsText(e.notes)}`] : []), 'TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `inline; filename="collection-${String(zn.name).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.ics"`, 'Cache-Control': 'public, max-age=3600' })
    .send(`${lines.map(fold).join('\r\n')}\r\n`);
});

module.exports = { router, publicRouter, missedWaiting, setupCheck, educationLog, CHECK_WORDS, draftNotice }; // draftNotice: also a snow day's (lib/collectionroutes.js)
