'use strict';
// The Mountain calendar (2026.11.10, Track CALENDAR). router is mounted at /api/v1/calendar (signed in); feedRouter at
// /api/v1/calendar-feed (no sign-in: the private link is the key). The rules live in lib/mountaincal.js.
//   GET    /calendar?from=&to=&team=&kinds=   what this person may see, with the teams and kinds to filter by
//   GET    /calendar/coming-up                today and the next 2 days, for the Today page
//   POST   /calendar/events                   add an event (owners and managers; ski school directors and patrol leads for their team)
//   PATCH  /calendar/events/:id               change one
//   DELETE /calendar/events/:id               delete one
//   GET    /calendar/feed                     is my calendar link on?
//   POST   /calendar/feed                     make my private link (a new one replaces the old one)
//   DELETE /calendar/feed                     turn my link off
//   GET    /calendar-feed/<secret>.ics        the feed itself, for a phone's calendar app
// The mountain comes only from the signed token (or, for the feed, from the link's owner).
const express = require('express');
const { pool, one } = require('../db');
const { validate, paramId, partialOf, addDays, todayIn } = require('../lib/util');
const { notFound, forbidden, bad } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { baseUrl } = require('../lib/baseurl');
const C = require('../lib/mountaincal');

const router = express.Router();
const feedRouter = express.Router();

const meta = (who) => ({
  teams: C.TEAMS.map(([key, label]) => ({ key, label, mine: who.teams.includes(key) })),
  kinds: C.ALL_KINDS.map(([key, label]) => ({ key, label, can_add: C.KIND_KEYS.includes(key) })),
  me: { manager: who.manager, teams: who.teams, add_for: who.addFor },
});

/** The area login (the ski area's read-only view) never reaches this: middleware/auth.js keeps it to its own paths. */
router.get('/', async (req, res) => {
  const { tenantId } = req.auth;
  const { from, to } = C.range(String(req.query.from || ''), String(req.query.to || ''));
  const who = await C.viewer(pool, req.auth);
  const team = req.query.team && req.query.team !== 'all' && req.query.team !== 'mine' ? String(req.query.team) : null;
  if (team && !C.TEAM_KEYS.includes(team)) throw bad('Not a team');
  const kinds = req.query.kinds ? String(req.query.kinds).split(',').filter((k) => C.ALL_KINDS.some((x) => x[0] === k)) : null;
  const out = await C.itemsFor(pool, tenantId, who, from, to, { team, kinds });
  // "My teams" for an owner or manager is everything; for others the server only ever returns what they may see.
  res.json({ from, to, today: out.today, items: out.items, ...meta(who) });
});

router.get('/coming-up', async (req, res) => {
  const who = await C.viewer(pool, req.auth);
  const tz = (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId])).timezone;
  const today = todayIn(tz);
  const out = await C.itemsFor(pool, req.auth.tenantId, who, today, addDays(today, 2));
  // Managers see everything elsewhere; on the Today card a long list helps nobody, so it is cut to the first 8.
  res.json({ today, items: out.items.slice(0, 8), more: Math.max(0, out.items.length - 8) });
});

async function eventOf(tenantId, id) {
  const e = await one(pool, 'SELECT * FROM mountain_events WHERE tenant_id = ? AND id = ?', [tenantId, id]);
  if (!e) throw notFound('Event');
  return e;
}
const refuse = (who) => forbidden(who.addFor === 'all' ? 'Your role cannot do that'
  : who.addFor.length ? `You can add events for ${who.addFor.map((t) => C.TEAM_LABEL[t]).join(' and ')} only. Choose only that team.`
    : 'Only managers and owners add events. Ask one to add it.');

router.post('/events', validate(C.eventSchema), async (req, res) => {
  const who = await C.viewer(pool, req.auth);
  const e = C.cleanEvent(req.body);
  if (!C.canWrite(who, e.teams)) throw refuse(who);
  const [r] = await pool.query(`INSERT INTO mountain_events (tenant_id, title, kind, starts_on, ends_on, all_day, start_time, end_time, place, note, teams, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [req.auth.tenantId, e.title, e.kind, e.starts_on, e.ends_on, e.all_day, e.start_time, e.end_time, e.place, e.note, e.teams ? e.teams.join(',') : null, req.auth.userId, req.auth.userId]);
  await audit(pool, req, 'create', 'mountain_events', r.insertId, { ...e });
  res.status(201).json(C.eventItem(await eventOf(req.auth.tenantId, r.insertId), who));
});

router.patch('/events/:id', validate(partialOf(C.eventFields)), async (req, res) => {
  const id = paramId(req);
  const who = await C.viewer(pool, req.auth);
  const cur = await eventOf(req.auth.tenantId, id);
  const curTeams = cur.teams ? cur.teams.split(',') : null;
  if (!C.canWrite(who, curTeams)) throw refuse(who);
  const merged = {
    title: cur.title, kind: cur.kind, starts_on: cur.starts_on, ends_on: cur.ends_on, all_day: Boolean(Number(cur.all_day)),
    start_time: cur.start_time, end_time: cur.end_time, place: cur.place, note: cur.note, teams: curTeams,
    ...Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined)),
  };
  // A new first day after the old last day moves the whole event, unless a last day was given too.
  if (req.body.starts_on && req.body.ends_on === undefined && merged.ends_on < merged.starts_on) merged.ends_on = merged.starts_on;
  const e = C.cleanEvent(merged);
  if (!C.canWrite(who, e.teams)) throw refuse(who);
  await pool.query(`UPDATE mountain_events SET title = ?, kind = ?, starts_on = ?, ends_on = ?, all_day = ?, start_time = ?, end_time = ?, place = ?, note = ?, teams = ?, updated_by = ?
    WHERE tenant_id = ? AND id = ?`, [e.title, e.kind, e.starts_on, e.ends_on, e.all_day, e.start_time, e.end_time, e.place, e.note, e.teams ? e.teams.join(',') : null, req.auth.userId, req.auth.tenantId, id]);
  const before = { title: cur.title, kind: cur.kind, starts_on: cur.starts_on, ends_on: cur.ends_on, teams: curTeams };
  await audit(pool, req, 'update', 'mountain_events', id, { before, after: e });
  res.json(C.eventItem(await eventOf(req.auth.tenantId, id), who));
});

router.delete('/events/:id', async (req, res) => {
  const id = paramId(req);
  const who = await C.viewer(pool, req.auth);
  const cur = await eventOf(req.auth.tenantId, id);
  if (!C.canWrite(who, cur.teams ? cur.teams.split(',') : null)) throw refuse(who);
  await pool.query('DELETE FROM mountain_events WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
  await audit(pool, req, 'delete', 'mountain_events', id, { title: cur.title, starts_on: cur.starts_on, ends_on: cur.ends_on, teams: cur.teams });
  res.json({ deleted: true });
});

// ---------------------------------------------------------------- my private calendar link
const feedUrl = (req, token) => `${baseUrl(req)}/api/v1/calendar-feed/${token}.ics`;

router.get('/feed', async (req, res) => {
  const f = await one(pool, 'SELECT created_at, last_used_at FROM calendar_feeds WHERE tenant_id = ? AND user_id = ?', [req.auth.tenantId, req.auth.userId]);
  res.json({ on: Boolean(f), created_at: f ? f.created_at : null, last_used_at: f ? f.last_used_at : null });
});

// The link is shown once, when it is made: only a hash of it is kept. Making a new one stops the old one working.
router.post('/feed', async (req, res) => {
  const token = C.newFeedToken();
  await pool.query(`INSERT INTO calendar_feeds (tenant_id, user_id, token_sha) VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE token_sha = VALUES(token_sha), created_at = CURRENT_TIMESTAMP, last_used_at = NULL`, [req.auth.tenantId, req.auth.userId, C.sha(token)]);
  await audit(pool, req, 'feed_link', 'calendar_feeds', req.auth.userId, null);
  const url = feedUrl(req, token);
  res.status(201).json({ on: true, url, webcal: url.replace(/^https?:/, 'webcal:') });
});

router.delete('/feed', async (req, res) => {
  const [r] = await pool.query('DELETE FROM calendar_feeds WHERE tenant_id = ? AND user_id = ?', [req.auth.tenantId, req.auth.userId]);
  if (r.affectedRows) await audit(pool, req, 'feed_off', 'calendar_feeds', req.auth.userId, null);
  res.json({ on: false });
});

// ---------------------------------------------------------------- the feed (no sign-in)
// Unknown, turned off and no-longer-allowed links all get the same plain 404, so a guess learns nothing.
feedRouter.get('/:file', async (req, res) => {
  const m = /^([A-Za-z0-9_-]{40,60})\.ics$/.exec(req.params.file);
  const auth = m ? await C.feedOwner(pool, m[1]) : null;
  if (!auth) { res.status(404).type('text/plain').send('Not found'); return; }
  const t = await one(pool, 'SELECT name, timezone FROM tenants WHERE id = ?', [auth.tenantId]);
  const today = todayIn(t.timezone);
  const who = await C.viewer(pool, auth);
  // The longest stretch one request may cover is MAX_SPAN days, so the feed asks in pieces.
  const items = []; const seen = new Set();
  for (let from = addDays(today, -C.FEED_BACK); from <= addDays(today, C.FEED_AHEAD); from = addDays(from, C.MAX_SPAN)) {
    const to = addDays(from, C.MAX_SPAN - 1);
    for (const x of (await C.itemsFor(pool, auth.tenantId, who, from, to)).items) if (!seen.has(x.id)) { seen.add(x.id); items.push(x); }
  }
  pool.query('UPDATE calendar_feeds SET last_used_at = NOW() WHERE tenant_id = ? AND user_id = ?', [auth.tenantId, auth.userId]).catch(() => {});
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Robots-Tag', 'noindex');
  res.type('text/calendar; charset=utf-8').send(C.toIcs(items, { name: `${t.name} calendar`, tz: t.timezone, host: req.hostname || 'verdynt', stamp }));
});

module.exports = { router, feedRouter };
