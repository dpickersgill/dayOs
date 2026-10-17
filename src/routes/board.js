'use strict';

// The day board: the home page as a set of tiles each person can choose and reorder.
// A person's own choice wins, then a manager's default for their role, then the built-in layout.
const express = require('express');
const { pool, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, dateStr, todayIn, nowIn, addDays, dayRange } = require('../lib/util');
const { bad, notFound, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const modules = require('../lib/modules');
const { dailyReport } = require('../lib/daily');
const patrolaccess = require('../lib/patrolaccess');
const { pmStatus } = require('../lib/ops');

const router = express.Router();
const ROLES = ['owner', 'manager', 'staff', 'patrol', 'instructor', 'counter'];
const isMgr = (role) => role === 'owner' || role === 'manager';

// who: null = everyone; a list = those roles (owners and managers always qualify); [] = managers only.
const TILES = [
  { key: 'morning', label: 'Morning board', module: 'conditions', who: null },
  { key: 'lifts', label: 'Lifts', module: 'conditions', who: null },
  { key: 'trails', label: 'Trails and grooming', module: 'conditions', who: null },
  { key: 'snow', label: 'Snow and weather', module: 'conditions', who: null },
  { key: 'maintenance', label: 'Work orders', module: 'conditions', who: null },
  { key: 'gate', label: 'Guests scanned', module: 'gate', who: ['counter', 'staff'] },
  { key: 'sales', label: 'Sales', module: 'sell', who: [] },
  { key: 'rentals', label: 'Rentals', module: 'rentals', who: ['counter'] },
  { key: 'lessons', label: 'Lessons', module: 'school', who: ['counter', 'instructor'] },
  { key: 'staffing', label: 'Staffing', module: 'workforce', who: [] },
  { key: 'certs', label: 'Certifications expiring', module: 'workforce', who: [] },
  { key: 'patrol', label: 'Patrol', module: 'patrol', who: ['patrol'] },
  { key: 'notes', label: 'Shift notes', module: null, who: null },
];
const KEYS = TILES.map((t) => t.key);

const BUILTIN = {
  owner: ['morning', 'snow', 'sales', 'rentals', 'lessons', 'staffing', 'patrol', 'maintenance', 'certs', 'notes'],
  counter: ['notes', 'rentals', 'lessons', 'gate', 'lifts', 'snow'],
  instructor: ['lessons', 'notes', 'snow', 'lifts'],
  patrol: ['morning', 'patrol', 'snow', 'notes'],
  staff: ['morning', 'snow', 'notes'],
};
BUILTIN.manager = BUILTIN.owner;

/** Database timestamps are UTC; the screens show a mountain's local clock. */
function localFromUtc(text, tz) {
  const d = new Date(`${String(text).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return text;
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

const mayHave = (tile, role) => tile.who === null || isMgr(role) || tile.who.includes(role);

/** The tiles this person can use right now: their role allows it and the mountain has the app on. */
async function availableTiles(tenantId, role) {
  const on = new Set(await modules.enabledKeys(tenantId));
  return TILES.filter((t) => mayHave(t, role) && (!t.module || on.has(t.module)));
}

const parseTiles = (text) => { try { const v = JSON.parse(text); return Array.isArray(v) ? v.filter((k) => KEYS.includes(k)) : null; } catch (_) { return null; } };

async function resolveLayout(tenantId, userId, role, available) {
  const ok = new Set(available.map((t) => t.key));
  const pick = (list) => [...new Set(list)].filter((k) => ok.has(k));
  const mine = await one(pool, "SELECT tiles FROM board_layouts WHERE tenant_id = ? AND owner_type = 'user' AND owner_key = ?", [tenantId, String(userId)]);
  const mineList = mine && parseTiles(mine.tiles);
  if (mineList) return { tiles: pick(mineList), source: 'user' };
  const theirs = await one(pool, "SELECT tiles FROM board_layouts WHERE tenant_id = ? AND owner_type = 'role' AND owner_key = ?", [tenantId, role]);
  const roleList = theirs && parseTiles(theirs.tiles);
  if (roleList) return { tiles: pick(roleList), source: 'role' };
  return { tiles: pick(BUILTIN[role] || BUILTIN.staff), source: 'default' };
}

// ------------------------------------------------------------------ tile data
function dataFor(c) {
  const memo = new Map();
  const get = (key) => { if (!memo.has(key)) memo.set(key, TILE_DATA[key](c, get)); return memo.get(key); };
  return get;
}

const hhmm = (local) => String(local || '').slice(11, 16);
const REASON = { wind: 'wind', mechanical: 'a mechanical problem', electrical: 'an electrical problem', weather: 'weather', rescue: 'a rescue', staffing: 'staffing', inspection: 'inspection', scheduled: 'scheduled work', other: 'another reason' };

const TILE_DATA = {
  /**
   * The morning board: the whole mountain on one card, as the website shows it. Each lift with why it is or isn't
   * open, patrol's opening (who is on duty, runs checked, holds), tonight's grooming, machines due for service, and
   * the three numbers that need someone: unfilled shifts, open work orders, open incidents. Only the apps the
   * mountain has on; patrol is counts and run names only, never patients.
   */
  async morning(c, get) {
    const on = new Set(await modules.enabledKeys(c.tenantId));
    const [{ lifts }, trails] = await Promise.all([get('lifts'), get('trails')]);
    const ids = lifts.map((l) => l.id);
    const [checks, downs] = ids.length ? await Promise.all([
      rows(pool, 'SELECT lift_id, result, checked_at, note FROM lift_checks WHERE tenant_id = ? AND check_date = ? ORDER BY checked_at, id', [c.tenantId, c.today]),
      rows(pool, 'SELECT lift_id, started_at, reason, note FROM lift_downtime WHERE tenant_id = ? AND ended_at IS NULL ORDER BY started_at', [c.tenantId]),
    ]) : [[], []];
    const lastCheck = new Map(checks.map((k) => [Number(k.lift_id), k]));
    const down = new Map(downs.map((d) => [Number(d.lift_id), d]));
    const liftRows = lifts.map((l) => {
      const k = lastCheck.get(l.id); const d = down.get(l.id);
      let detail;
      if (k && k.result === 'fail') detail = `Inspection failed${k.note ? `: ${k.note}` : ''}`;
      else if (d && l.status !== 'open') detail = `${l.status === 'wind_hold' ? 'Wind hold' : 'Stopped'} since ${String(d.started_at).slice(11, 16)}${d.note ? `: ${d.note}` : d.reason ? `, ${REASON[d.reason] || d.reason}` : ''}`;
      else if (k) detail = `Passed inspection at ${hhmm(localFromUtc(k.checked_at, c.tz))}`;
      else detail = 'Not inspected yet today';
      return { name: l.name, status: l.status, check: l.check, detail };
    });
    const out = { lifts: liftRows, grooming: { plan: trails.plan, groomed: trails.groomed, total: trails.total, open: trails.open } };
    if (on.has('patrol')) {
      const [duty, checked, holds] = await Promise.all([
        one(pool, 'SELECT COUNT(*) AS n FROM patrol_duty WHERE tenant_id = ? AND on_date = ? AND signed_out_at IS NULL', [c.tenantId, c.today]),
        one(pool, 'SELECT COUNT(DISTINCT trail_id) AS n FROM patrol_opening_checks WHERE tenant_id = ? AND on_date = ?', [c.tenantId, c.today]),
        rows(pool, "SELECT name, closure_reason FROM trails WHERE tenant_id = ? AND status = 'hold' ORDER BY name LIMIT 5", [c.tenantId]),
      ]);
      out.patrol = { on_duty: Number(duty.n), checked: Number(checked.n), trails: trails.total, holds: holds.map((x) => ({ name: x.name, reason: x.closure_reason })) };
    }
    // Machines and lifts due for service (by days, hours or miles), the most pressing first
    const tasks = await rows(pool, `SELECT t.*, a.name AS asset, a.asset_tag, a.hours AS asset_hours, a.miles AS asset_miles, a.status AS asset_status, l.name AS lift
      FROM pm_tasks t LEFT JOIN ops_assets a ON a.tenant_id = t.tenant_id AND a.id = t.asset_id LEFT JOIN lifts l ON l.tenant_id = t.tenant_id AND l.id = t.lift_id
      WHERE t.tenant_id = ? AND t.active = 1 AND (a.id IS NULL OR a.status <> 'retired')`, [c.tenantId]);
    const num = (v) => (v === null || v === undefined ? null : Number(v));
    const due = tasks.map((t) => ({ t, s: pmStatus(t, t.asset_id ? { hours: num(t.asset_hours), miles: num(t.asset_miles) } : null, c.today) }))
      .filter((x) => x.s.state === 'overdue' || x.s.state === 'soon')
      .sort((x, y) => (x.s.state === y.s.state ? 0 : x.s.state === 'overdue' ? -1 : 1));
    const downAssets = on.has('assets') ? await one(pool, "SELECT COUNT(*) AS n FROM ops_assets WHERE tenant_id = ? AND status = 'out_of_service'", [c.tenantId]) : { n: 0 };
    out.fleet = {
      due: due.slice(0, 3).map(({ t, s }) => ({ name: t.asset ? `${t.asset}${t.asset_tag ? `, ${t.asset_tag}` : ''}` : t.lift || t.name, task: t.name, state: s.state, due_on: s.due_on, hours_left: s.hours_left, miles_left: s.miles_left })),
      due_count: due.length, out_of_service: Number(downAssets.n),
    };
    const m = await get('maintenance');
    out.counts = { open_orders: m.open, urgent_orders: m.urgent };
    if (on.has('workforce')) out.counts.unfilled = (await one(pool, "SELECT COUNT(*) AS n FROM shifts WHERE tenant_id = ? AND status <> 'cancelled' AND staff_id IS NULL AND DATE(starts_at) = ?", [c.tenantId, c.date])).n * 1;
    if (on.has('patrol')) out.counts.incidents = (await one(pool, "SELECT COUNT(*) AS n FROM incidents WHERE tenant_id = ? AND status = 'open'", [c.tenantId])).n * 1;
    out.as_of = c.now;
    return out;
  },
  async lifts(c) {
    const lifts = await rows(pool, 'SELECT id, name, status FROM lifts WHERE tenant_id = ? ORDER BY name', [c.tenantId]);
    const checks = await rows(pool, 'SELECT lift_id, result FROM lift_checks WHERE tenant_id = ? AND check_date = ? ORDER BY checked_at, id', [c.tenantId, c.today]);
    const latest = new Map(checks.map((k) => [Number(k.lift_id), k.result]));
    return { lifts: lifts.map((l) => ({ id: Number(l.id), name: l.name, status: l.status, check: latest.get(Number(l.id)) || null })) };
  },
  async trails(c) {
    const t = await one(pool, 'SELECT COUNT(*) AS total, COALESCE(SUM(status = \'open\'), 0) AS open, COALESCE(SUM(groomed), 0) AS groomed FROM trails WHERE tenant_id = ?', [c.tenantId]);
    const plan = await rows(pool, 'SELECT status, COUNT(*) AS n FROM groom_plans WHERE tenant_id = ? AND plan_date = ? GROUP BY status', [c.tenantId, c.today]);
    return { total: Number(t.total), open: Number(t.open), groomed: Number(t.groomed), plan: Object.fromEntries(plan.map((p) => [p.status, Number(p.n)])) };
  },
  async snow(c) {
    const reading = await one(pool, 'SELECT read_at, base_in, new_snow_in, surface, quality FROM snow_readings WHERE tenant_id = ? AND trail_id IS NULL ORDER BY read_at DESC, id DESC LIMIT 1', [c.tenantId]);
    const weather = await one(pool, 'SELECT logged_at, place, temp_f, wind_mph, gust_mph, wind_dir, sky FROM weather_logs WHERE tenant_id = ? ORDER BY logged_at DESC, id DESC LIMIT 1', [c.tenantId]);
    return { reading: reading || null, weather: weather || null };
  },
  async maintenance(c) {
    const counts = await rows(pool, "SELECT priority, COUNT(*) AS n FROM work_orders WHERE tenant_id = ? AND status IN ('open','in_progress','waiting_parts') GROUP BY priority", [c.tenantId]);
    const top = await rows(pool, "SELECT id, title, priority, status FROM work_orders WHERE tenant_id = ? AND status IN ('open','in_progress','waiting_parts') AND priority IN ('urgent','high') ORDER BY FIELD(priority, 'urgent', 'high'), opened_at LIMIT 5", [c.tenantId]);
    const by = Object.fromEntries(counts.map((r) => [r.priority, Number(r.n)]));
    return { open: Object.values(by).reduce((a, b) => a + b, 0), urgent: by.urgent || 0, high: by.high || 0, top };
  },
  async gate(c) {
    const [from, to] = dayRange(c.tz, c.date);
    const r = await one(pool, "SELECT COUNT(DISTINCT ticket_id) AS guests FROM scans WHERE tenant_id = ? AND result = 'ok' AND scanned_at >= ? AND scanned_at < ?", [c.tenantId, from, to]);
    return { guests: Number(r.guests) };
  },
  async sales(c) {
    const d = await dailyReport(c.tenantId, c.date);
    return { orders: d.sales.orders, revenue_cents: d.sales.revenue_cents, refunds_cents: d.sales.refunds.amount_cents, top_products: d.sales.top_products.slice(0, 5), guests_scanned: d.guests_scanned };
  },
  async rentals(c) {
    const out = await one(pool, "SELECT COUNT(*) AS n, COALESCE(SUM(due_at < ?), 0) AS overdue, COALESCE(SUM(due_at >= ? AND due_at < DATE_ADD(?, INTERVAL 2 HOUR)), 0) AS soon FROM rental_contracts WHERE tenant_id = ? AND status = 'out'", [c.now, c.now, c.now, c.tenantId]);
    const held = await one(pool, "SELECT COUNT(*) AS n FROM rental_reservations WHERE tenant_id = ? AND status = 'held' AND pickup_on = ?", [c.tenantId, c.today]);
    return { out: Number(out.n), overdue: Number(out.overdue), due_soon: Number(out.soon), reservations_today: Number(held.n) };
  },
  async lessons(c) {
    const sessions = await rows(pool, `SELECT s.id, s.starts_at, s.ends_at, s.capacity, s.discipline, s.ability_level, pr.name,
      (SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status IN ('booked','attended')) AS booked
      FROM lesson_sessions s JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
      WHERE s.tenant_id = ? AND s.status <> 'cancelled' AND DATE(s.starts_at) = ? ORDER BY s.starts_at LIMIT 12`, [c.tenantId, c.date]);
    const pending = await one(pool, "SELECT COUNT(*) AS n FROM lesson_requests WHERE tenant_id = ? AND status = 'pending'", [c.tenantId]);
    return { sessions: sessions.map((s) => ({ ...s, id: Number(s.id), booked: Number(s.booked) })), pending_requests: Number(pending.n) };
  },
  async staffing(c) {
    const total = await one(pool, "SELECT COUNT(*) AS n FROM shifts WHERE tenant_id = ? AND status <> 'cancelled' AND DATE(starts_at) = ?", [c.tenantId, c.date]);
    const unfilled = await rows(pool, `SELECT s.id, po.name AS position, s.starts_at, s.ends_at FROM shifts s JOIN positions po ON po.tenant_id = s.tenant_id AND po.id = s.position_id
      WHERE s.tenant_id = ? AND s.status <> 'cancelled' AND s.staff_id IS NULL AND DATE(s.starts_at) = ? ORDER BY s.starts_at LIMIT 8`, [c.tenantId, c.date]);
    const clocked = await one(pool, 'SELECT COUNT(*) AS n FROM time_entries WHERE tenant_id = ? AND clock_out IS NULL', [c.tenantId]);
    return { shifts: Number(total.n), unfilled: unfilled.map((u) => ({ ...u, id: Number(u.id) })), clocked_in: Number(clocked.n) };
  },
  async certs(c) {
    const list = await rows(pool, `SELECT p.first_name, p.last_name, ce.name AS certification, sc.expires_on
      FROM staff_certifications sc JOIN staff s ON s.id = sc.staff_id AND s.tenant_id = sc.tenant_id AND s.status = 'active'
      JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id JOIN certifications ce ON ce.id = sc.certification_id AND ce.tenant_id = sc.tenant_id
      WHERE sc.tenant_id = ? AND sc.expires_on IS NOT NULL AND sc.expires_on <= ? ORDER BY sc.expires_on LIMIT 10`, [c.tenantId, addDays(c.today, 30)]);
    return { list: list.map((r) => ({ name: `${r.first_name} ${r.last_name}`, certification: r.certification, expires_on: r.expires_on, overdue: String(r.expires_on) < c.today })) };
  },
  async patrol(c) {
    const inc = await one(pool, "SELECT COUNT(*) AS n FROM incidents WHERE tenant_id = ? AND status = 'open'", [c.tenantId]);
    const calls = await one(pool, "SELECT COUNT(*) AS n FROM dispatch_calls WHERE tenant_id = ? AND status NOT IN ('closed','cancelled')", [c.tenantId]);
    const recent = c.seeCases === false ? [] : await rows(pool, "SELECT id, occurred_at, location, category, severity FROM incidents WHERE tenant_id = ? AND status = 'open' ORDER BY occurred_at DESC LIMIT 5", [c.tenantId]);
    return { open_incidents: Number(inc.n), active_calls: Number(calls.n), recent: recent.map((r) => ({ ...r, id: Number(r.id) })) };
  },
  async notes(c) {
    const pinned = await rows(pool, 'SELECT id, body, author, user_id, created_at FROM board_notes WHERE tenant_id = ? AND pinned = 1 ORDER BY created_at DESC LIMIT 5', [c.tenantId]);
    const recent = await rows(pool, 'SELECT id, body, author, user_id, created_at FROM board_notes WHERE tenant_id = ? AND pinned = 0 ORDER BY created_at DESC, id DESC LIMIT 8', [c.tenantId]);
    const mark = (n, pin) => ({ id: Number(n.id), body: n.body, author: n.author, created_at: localFromUtc(n.created_at, c.tz), pinned: pin, mine: Number(n.user_id) === Number(c.userId) });
    return { notes: [...pinned.map((n) => mark(n, true)), ...recent.map((n) => mark(n, false))] };
  },
};

/** The red and amber band at the top: what blocks opening or needs someone now. Only things this person can act on. */
async function alertsFor(c, has, get) {
  const out = [];
  if (has('lifts')) {
    for (const l of (await get('lifts')).lifts) {
      if (l.check === 'fail') out.push({ level: 'stop', text: `${l.name} failed its inspection and cannot open`, link: 'conditions' });
      else if (l.status === 'wind_hold') out.push({ level: 'warn', text: `${l.name} is on a wind hold`, link: 'conditions' });
    }
  }
  if (has('maintenance')) {
    const m = await get('maintenance');
    if (m.urgent) out.push({ level: 'stop', text: `${m.urgent} urgent work order${m.urgent === 1 ? '' : 's'} open`, link: 'conditions' });
  }
  if (has('rentals')) {
    const r = await get('rentals');
    if (r.overdue) out.push({ level: 'warn', text: `${r.overdue} rental${r.overdue === 1 ? '' : 's'} overdue`, link: 'rentals' });
  }
  if (has('patrol')) {
    const p = await get('patrol');
    if (p.active_calls) out.push({ level: 'stop', text: `${p.active_calls} active patrol call${p.active_calls === 1 ? '' : 's'}`, link: 'patrol' });
    else if (p.open_incidents) out.push({ level: 'warn', text: `${p.open_incidents} incident${p.open_incidents === 1 ? '' : 's'} still open`, link: 'patrol' });
  }
  if (has('staffing')) {
    const s = await get('staffing');
    if (s.unfilled.length) out.push({ level: 'warn', text: `${s.unfilled.length} unfilled shift${s.unfilled.length === 1 ? '' : 's'} today`, link: 'workforce' });
  }
  if (has('certs')) {
    const k = await get('certs');
    const soon = k.list.filter((x) => String(x.expires_on) <= addDays(c.today, 14));
    if (soon.length) out.push({ level: 'warn', text: `${soon.length} certification${soon.length === 1 ? '' : 's'} expired or expiring within 14 days`, link: 'workforce' });
  }
  if (has('lessons')) {
    const l = await get('lessons');
    if (l.pending_requests) out.push({ level: 'info', text: `${l.pending_requests} lesson request${l.pending_requests === 1 ? '' : 's'} waiting for an answer`, link: 'school' });
  }
  const rank = { stop: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

// ------------------------------------------------------------------ routes
router.get('/', async (req, res) => {
  const { tenantId, userId, role } = req.auth;
  const tz = (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
  const today = todayIn(tz);
  let date = today;
  if (req.query.date && isMgr(role)) { date = String(req.query.date); if (!dateStr.safeParse(date).success) throw bad('date must be YYYY-MM-DD'); }
  const available = await availableTiles(tenantId, role);
  const layout = await resolveLayout(tenantId, userId, role, available);
  // Case details on the patrol tile follow the patroller's access level (a Host sees counts only).
  const seeCases = role !== 'patrol' || await patrolaccess.can(pool, req, 'view_cases');
  const c = { tenantId, userId, role, tz, today, date, now: nowIn(tz), seeCases };
  const get = dataFor(c);
  const have = new Set(available.map((t) => t.key));
  const alerts = date === today ? await alertsFor(c, (k) => have.has(k), get) : [];
  const data = {};
  await Promise.all(layout.tiles.map(async (k) => { data[k] = await get(k); }));
  res.json({
    date, today, timezone: tz, role, can_set_default: isMgr(role),
    layout,
    catalog: available.map(({ key, label }) => ({ key, label })),
    alerts, data,
  });
});

const tilesBody = z.object({ tiles: z.array(z.enum(KEYS)).max(20) });

router.put('/layout', validate(tilesBody), async (req, res) => {
  const { tenantId, userId, role } = req.auth;
  const ok = new Set((await availableTiles(tenantId, role)).map((t) => t.key));
  const tiles = [...new Set(req.body.tiles)];
  if (tiles.some((k) => !ok.has(k))) throw bad('One of those tiles is not available to you');
  await pool.query("INSERT INTO board_layouts (tenant_id, owner_type, owner_key, tiles) VALUES (?, 'user', ?, ?) ON DUPLICATE KEY UPDATE tiles = VALUES(tiles)", [tenantId, String(userId), JSON.stringify(tiles)]);
  res.json({ tiles, source: 'user' });
});

router.delete('/layout', async (req, res) => {
  await pool.query("DELETE FROM board_layouts WHERE tenant_id = ? AND owner_type = 'user' AND owner_key = ?", [req.auth.tenantId, String(req.auth.userId)]);
  res.json({ ok: true });
});

// A manager's default for everyone in a role who has not chosen their own tiles.
router.put('/layout/role/:role', requireRole('manager'), validate(tilesBody), async (req, res) => {
  const role = String(req.params.role);
  if (!ROLES.includes(role)) throw bad('Unknown role');
  const tiles = [...new Set(req.body.tiles)];
  await pool.query("INSERT INTO board_layouts (tenant_id, owner_type, owner_key, tiles) VALUES (?, 'role', ?, ?) ON DUPLICATE KEY UPDATE tiles = VALUES(tiles)", [req.auth.tenantId, role, JSON.stringify(tiles)]);
  await audit(pool, req, 'update', 'board_layout', null, { role, tiles });
  res.json({ role, tiles });
});

router.delete('/layout/role/:role', requireRole('manager'), async (req, res) => {
  const role = String(req.params.role);
  if (!ROLES.includes(role)) throw bad('Unknown role');
  await pool.query("DELETE FROM board_layouts WHERE tenant_id = ? AND owner_type = 'role' AND owner_key = ?", [req.auth.tenantId, role]);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ shift notes
router.post('/notes', validate(z.object({ body: z.string().trim().min(1).max(1000), pinned: z.boolean().optional() })), async (req, res) => {
  const { tenantId, userId, role } = req.auth;
  const who = await one(pool, "SELECT COALESCE(NULLIF(TRIM(CONCAT(p.first_name, ' ', p.last_name)), ''), u.email, u.username) AS name FROM users u LEFT JOIN people p ON p.id = u.person_id AND p.tenant_id = u.tenant_id WHERE u.tenant_id = ? AND u.id = ?", [tenantId, userId]);
  const pinned = req.body.pinned && isMgr(role) ? 1 : 0;
  const [r] = await pool.query('INSERT INTO board_notes (tenant_id, body, pinned, user_id, author) VALUES (?, ?, ?, ?, ?)', [tenantId, req.body.body, pinned, userId, (who && who.name || '').slice(0, 100)]);
  res.status(201).json({ id: r.insertId });
});

router.patch('/notes/:id', requireRole('manager'), validate(z.object({ pinned: z.boolean() })), async (req, res) => {
  const [r] = await pool.query('UPDATE board_notes SET pinned = ? WHERE tenant_id = ? AND id = ?', [req.body.pinned ? 1 : 0, req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Note not found');
  res.json({ ok: true });
});

router.delete('/notes/:id', async (req, res) => {
  const { tenantId, userId, role } = req.auth;
  const n = await one(pool, 'SELECT user_id FROM board_notes WHERE tenant_id = ? AND id = ?', [tenantId, paramId(req)]);
  if (!n) throw notFound('Note not found');
  if (!isMgr(role) && Number(n.user_id) !== Number(userId)) throw forbidden('You can only remove your own notes');
  await pool.query('DELETE FROM board_notes WHERE tenant_id = ? AND id = ?', [tenantId, paramId(req)]);
  res.json({ ok: true });
});

module.exports = router;
