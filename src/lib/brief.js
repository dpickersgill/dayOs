'use strict';

// The morning brief (every plan, no add-on). At 6:00 AM in the mountain's own time zone, on days its calendar says it is
// open (and the day before opening day), each person who gets a brief is sent the one for their role:
//   ops     owners and managers (the GM is a manager login)
//   patrol  patrol logins on the roster; on by default for the patrol director (rank Director or level Admin)
//   school  instructor logins at the Supervisor or Director level; on by default for the ski school Director
// Each person turns it on or off and picks email, phone alert or both (Settings, Morning brief); owners and managers can
// choose who gets it. One brief is made per mountain, day and kind (lib/briefdata.js gathers the facts, lib/briefwrite.js
// writes them), and each send is claimed in brief_sends first, so nobody is ever sent the same day's brief twice, however
// many times the job runs or overlaps.
//
// runDue() is the job: safe to repeat, sends in batches inside a time budget, and picks up where it stopped on the next
// run. It runs every 15 minutes (POST /internal/jobs/brief, scripts/brief-job.sh) and once more inside the daily job.
const { pool, rows, one } = require('../db');
const { addDays } = require('./util');
const modulesLib = require('./modules');
const D = require('./briefdata');
const W = require('./briefwrite');
const WX = require('./wxrun');

const SEND_AT = '06:00';
const LATEST = '12:00'; // a brief not sent by noon is not sent that day (it would be stale); the page still has it
const KEEP_DAYS = 30;
const CHANNELS = ['both', 'email', 'push'];
const OPEN = ['open', 'limited'];

/** Local date and HH:MM of a moment in a time zone. */
function localNow(timeZone, now = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}

const ymd = (d) => String(d).slice(0, 10);
const hm = (t) => (t ? String(t).slice(0, 5) : null);

/**
 * Which day's brief a mountain should send now, or null. { sentOn, forDate, opening_day, opening_tomorrow, hours }.
 * Opening day is an open day with no open day in the 14 before it.
 */
async function dueDay(db, t, now = new Date()) {
  const { date: today, hm: at } = localNow(t.timezone, now);
  if (at < SEND_AT || at >= LATEST) return null;
  return dayFor(db, t.id, today);
}

/** The brief day for a local date (no clock check): today when open, tomorrow when tomorrow is opening day. */
async function dayFor(db, tenantId, today) {
  const cal = await rows(db, 'SELECT on_date, status, open_time, close_time FROM calendar_days WHERE tenant_id = ? AND on_date BETWEEN ? AND ?', [tenantId, addDays(today, -15), addDays(today, 1)]);
  const by = new Map(cal.map((c) => [ymd(c.on_date), c]));
  const isOpen = (d) => Boolean(by.get(d) && OPEN.includes(by.get(d).status));
  const opening = (d) => { if (!isOpen(d)) return false; for (let i = 1; i <= 14; i += 1) if (isOpen(addDays(d, -i))) return false; return true; };
  const hours = (d) => { const c = by.get(d); return c && c.open_time ? { open: hm(c.open_time), close: hm(c.close_time) } : null; };
  if (isOpen(today)) return { sentOn: today, forDate: today, today, opening_day: opening(today), opening_tomorrow: false, hours: hours(today) };
  const tomorrow = addDays(today, 1);
  if (opening(tomorrow)) return { sentOn: today, forDate: tomorrow, today, opening_day: false, opening_tomorrow: true, hours: hours(tomorrow) };
  return null;
}

// ---------------------------------------------------------------- who
/** The brief a login can have (null: none), and whether it is on for them when nobody has chosen. */
function kindFor(u, modules) {
  if (u.role === 'owner' || u.role === 'manager') return { kind: 'ops', byDefault: true };
  if ((u.role === 'patrol' || u.access_level) && modules.has('patrol') && !u.patrol_removed_at) {
    const level = u.access_level || (u.role === 'patrol' ? 'patrol' : null); // a patrol login not on the roster is a plain Patrol (lib/patrolaccess.js)
    if (['admin', 'manager', 'approver', 'patrol'].includes(level)) return { kind: 'patrol', byDefault: u.rank === 'director' || level === 'admin' };
  }
  if (u.role === 'instructor' && modules.has('school') && ['director', 'supervisor'].includes(u.school_access)) return { kind: 'school', byDefault: u.school_access === 'director' };
  return null;
}

/** Every login at a mountain that can have a brief: [{ id, email, name, role, kind, on, channel, chosen }]. */
async function people(db, tenantId, today, modules) {
  const list = await rows(db, `SELECT u.id, u.email, u.username, u.role, u.staff_id, u.patrol_removed_at, pm.level AS \`rank\`, pm.access_level, ip.school_access,
      p.first_name, p.last_name, bp.on_off, bp.channel
    FROM users u LEFT JOIN staff s ON s.tenant_id = u.tenant_id AND s.id = u.staff_id LEFT JOIN people p ON p.tenant_id = u.tenant_id AND p.id = s.person_id
      LEFT JOIN patrol_members pm ON pm.tenant_id = u.tenant_id AND pm.staff_id = u.staff_id
      LEFT JOIN instructor_profiles ip ON ip.tenant_id = u.tenant_id AND ip.staff_id = u.staff_id
      LEFT JOIN brief_prefs bp ON bp.tenant_id = u.tenant_id AND bp.user_id = u.id
    WHERE u.tenant_id = ? AND u.active = 1 AND u.role <> 'area' AND (u.access_ends_on IS NULL OR u.access_ends_on >= ?) ORDER BY FIELD(u.role, 'owner','manager','patrol','instructor'), u.id`, [tenantId, today]);
  const out = [];
  for (const u of list) {
    const k = kindFor(u, modules);
    if (!k) continue;
    const chosen = u.on_off !== null && u.on_off !== undefined;
    out.push({ id: Number(u.id), email: u.email || null, name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || u.email, role: u.role,
      kind: k.kind, on: chosen ? Boolean(u.on_off) : k.byDefault, channel: CHANNELS.includes(u.channel) ? u.channel : 'both', chosen, default_on: k.byDefault });
  }
  return out;
}

/** One login's brief: { kind, on, channel } or null when their role has none. */
async function forUser(db, tenantId, userId, today) {
  const modules = new Set(await modulesLib.enabledKeys(tenantId));
  return (await people(db, tenantId, today, modules)).find((p) => p.id === Number(userId)) || null;
}

async function setPref(db, tenantId, userId, { on, channel }, byUserId) {
  const cur = await one(db, 'SELECT on_off, channel FROM brief_prefs WHERE tenant_id = ? AND user_id = ?', [tenantId, userId]);
  const p = await forUser(db, tenantId, userId, '1970-01-01');
  const next = { on: on === undefined ? (cur ? Boolean(cur.on_off) : Boolean(p && p.on)) : Boolean(on), channel: channel || (cur && cur.channel) || 'both' };
  await db.query(`INSERT INTO brief_prefs (tenant_id, user_id, on_off, channel, updated_by) VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE on_off = VALUES(on_off), channel = VALUES(channel), updated_by = VALUES(updated_by)`, [tenantId, userId, next.on ? 1 : 0, next.channel, byUserId]);
  return next;
}

// ---------------------------------------------------------------- the brief itself
const TENANT_COLS = 'id, name, slug, timezone, map_lat, map_lng, online_shop, online_daily_limit, sandbox_expires_at';

/** Thrown by ensure() when the run's time is up before a slow step: the run stops, and the next run makes the brief. */
class OutOfTime extends Error {}

/**
 * The day's brief of a kind for a mountain: made once (facts, then words), then read back. opts.run: the job's weather run
 * (lib/wxrun.js). opts.deadline: a time (ms) after which no slow step is started (the weather lookup in the facts, the
 * model call), so a run overruns its budget by one call at most (2026.11.15 review).
 */
async function ensure(db, t, kind, day, modules, { run = null, deadline = null } = {}) {
  const have = await one(db, 'SELECT * FROM morning_briefs WHERE tenant_id = ? AND sent_on = ? AND kind = ?', [t.id, day.sentOn, kind]);
  if (have) return shape(have);
  const late = () => deadline !== null && Date.now() >= deadline;
  if (late()) throw new OutOfTime('time budget reached before the facts');
  const data = await D.assemble(db, t, kind, { date: day.forDate, today: day.today || day.sentOn, opening_day: day.opening_day, opening_tomorrow: day.opening_tomorrow, hours: day.hours }, modules, { run });
  if (late()) throw new OutOfTime('time budget reached before the model call');
  const w = await W.write(data, { tenantId: t.id, kind });
  await db.query('INSERT IGNORE INTO morning_briefs (tenant_id, sent_on, for_date, kind, data, body, source, fallback_reason, model, cost_micros) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [t.id, day.sentOn, day.forDate, kind, JSON.stringify(data), JSON.stringify(w.body), w.source, w.reason, w.model, w.cost_micros]);
  return shape(await one(db, 'SELECT * FROM morning_briefs WHERE tenant_id = ? AND sent_on = ? AND kind = ?', [t.id, day.sentOn, kind]));
}

const parse = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch (_) { return null; } };
function shape(r) {
  if (!r) return null;
  return { id: Number(r.id), kind: r.kind, kind_label: D.KIND_LABEL[r.kind], sent_on: ymd(r.sent_on), for_date: ymd(r.for_date), body: parse(r.body), source: r.source, label: W.labelOf(r.source), made_at: r.created_at };
}

// ---------------------------------------------------------------- delivery
async function deliver(t, person, brief, base) {
  const link = `${base || ''}/#/brief`;
  let emailOk = null; let phones = null;
  if (person.channel !== 'push' && person.email) {
    const m = W.renderEmail(brief, t, link);
    const r = await require('./mailer').send({ tenantId: t.id, to: person.email, fromName: t.name, subject: m.subject, text: m.text, html: m.html, tag: 'morning-brief' });
    emailOk = Boolean(r && r.ok);
  }
  if (person.channel !== 'email') {
    phones = await require('./push').notifyUsers(t.id, [person.id], { title: `Morning brief: ${t.name}`, body: brief.body.summary[0], url: '#/brief', tag: `brief-${brief.sent_on}` }, { urgency: 'normal', ttl: 6 * 3600 });
  }
  return { emailOk, phones };
}

/**
 * Sends what is due, everywhere. Safe to run again at any time: each person's send for a day is claimed (a unique row)
 * before anything goes out, and a claimed send is never made again. Stops starting new sends after budgetMs or maxSends,
 * and the next run carries on; ensure() checks the same deadline before its weather lookup and its model call, so a run
 * ends at most one call (45 seconds, the model's timeout) after budgetMs. run: a weather breaker to share (lib/wxrun.js).
 * now: the moment to act as (tests).
 */
async function runDue({ now = new Date(), budgetMs = 100000, maxSends = 500, base = null, only = null, run = null } = {}) {
  const started = Date.now();
  const deadline = started + budgetMs;
  const wx = run || WX.newRun(); // one weather breaker for the run (the daily job passes its own, shared with its other stages)
  const out = { mountains: 0, made: 0, sent: 0, failed: 0, more: false };
  const conn = await pool.getConnection();
  try {
    const [[got]] = await conn.query("SELECT GET_LOCK('summitops_brief_job', 0) AS ok");
    if (!Number(got.ok)) return { ...out, busy: true };
    const tenants = await rows(pool, `SELECT ${TENANT_COLS} FROM tenants WHERE status = 'active' AND sandbox_expires_at IS NULL${only ? ' AND id = ?' : ''} ORDER BY id`, only ? [only] : []);
    for (const t of tenants) {
      if (Date.now() - started > budgetMs || out.sent + out.failed >= maxSends) { out.more = true; break; }
      try {
        const day = await dueDay(pool, t, now);
        if (!day) continue;
        out.mountains += 1;
        const modules = new Set(await modulesLib.enabledKeys(t.id));
        const sent = new Set((await rows(pool, 'SELECT user_id FROM brief_sends WHERE tenant_id = ? AND sent_on = ?', [t.id, day.sentOn])).map((r) => Number(r.user_id)));
        const waiting = (await people(pool, t.id, day.sentOn, modules)).filter((p) => p.on && !sent.has(p.id) && (p.email || p.channel !== 'email'));
        const briefs = new Map();
        for (const p of waiting) {
          if (Date.now() - started > budgetMs || out.sent + out.failed >= maxSends) { out.more = true; break; }
          if (!briefs.has(p.kind)) {
            const had = await one(pool, 'SELECT id FROM morning_briefs WHERE tenant_id = ? AND sent_on = ? AND kind = ?', [t.id, day.sentOn, p.kind]);
            briefs.set(p.kind, await ensure(pool, t, p.kind, day, modules, { run: wx, deadline }));
            if (!had) out.made += 1;
            if (Date.now() - started > budgetMs) { out.more = true; break; } // made; the next run sends it
          }
          const brief = briefs.get(p.kind);
          // The claim: a second run (or a second server) finds the row and moves on.
          const [claim] = await pool.query('INSERT IGNORE INTO brief_sends (tenant_id, user_id, sent_on, brief_id, channel) VALUES (?, ?, ?, ?, ?)', [t.id, p.id, day.sentOn, brief.id, p.channel]);
          if (!claim.affectedRows) continue;
          const r = await deliver(t, p, brief, base);
          const ok = r.emailOk === true || Number(r.phones) > 0;
          await pool.query("UPDATE brief_sends SET status = ?, email_ok = ?, phones = ?, sent_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND user_id = ? AND sent_on = ?",
            [ok ? 'sent' : 'failed', r.emailOk === null ? null : r.emailOk ? 1 : 0, r.phones, t.id, p.id, day.sentOn]);
          if (ok) out.sent += 1; else out.failed += 1;
        }
      } catch (err) {
        if (err instanceof OutOfTime) { out.more = true; break; }
        require('./jobs').logFailure({ job: 'morning_brief', tenant: t.id, message: err.message });
      }
      if (out.more) break;
    }
    return out;
  } finally {
    await conn.query("SELECT RELEASE_LOCK('summitops_brief_job')").catch(() => {});
    conn.release();
  }
}

/** Briefs and sends older than 30 days go (the daily job's retention stage). */
async function purge() {
  const [a] = await pool.query('DELETE FROM brief_sends WHERE created_at < UTC_TIMESTAMP() - INTERVAL ? DAY LIMIT 50000', [KEEP_DAYS]);
  const [b] = await pool.query('DELETE FROM morning_briefs WHERE created_at < UTC_TIMESTAMP() - INTERVAL ? DAY LIMIT 50000', [KEEP_DAYS]);
  return { sends: a.affectedRows, briefs: b.affectedRows };
}

/** Today's brief and the 7 before it, of one kind, for the page. */
async function recent(db, tenantId, kind, today) {
  const list = await rows(db, 'SELECT * FROM morning_briefs WHERE tenant_id = ? AND kind = ? AND sent_on <= ? ORDER BY sent_on DESC LIMIT 8', [tenantId, kind, today]);
  return list.map(shape);
}

module.exports = { runDue, OutOfTime, dueDay, dayFor, localNow, kindFor, people, forUser, setPref, ensure, recent, purge, shape, CHANNELS, SEND_AT, LATEST, KEEP_DAYS };
