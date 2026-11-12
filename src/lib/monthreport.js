'use strict';

// The monthly report for the manager and council (release 2026.11.20, workstream "money"). One month of a municipality's
// public works on one page: work orders opened and closed by department and job type, hours and cost by department and
// fund, response times for resident requests against the standards, the streets with the most requests, programs,
// bulk pickup, street notices, building checks, the fleet, the largest jobs, and the Liquid Fuels fund by street for the
// year to date (for PennDOT's MS-965 report). Each part shows only when its app is on.
//
// It is a public record (Pennsylvania's Right-to-Know Law): no resident's name, phone, email, house number or own words.
// A work order made from a request is named by its category and street; its photos have where they were taken removed
// when they are shown (routes/workmoney.js). Costs by person are not shown: labor is added up by department and fund.
const { rows, one } = require('../db');
const { addDays, dayRange } = require('./util');
const W = require('./workcosts');

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
/** The first and last day of a month 'YYYY-MM'. */
function monthDays(month) {
  const m = MONTH.exec(month || '');
  if (!m) return null;
  const from = `${month}-01`;
  const next = Number(m[2]) === 12 ? `${Number(m[1]) + 1}-01-01` : `${m[1]}-${String(Number(m[2]) + 1).padStart(2, '0')}-01`;
  return { from, to: addDays(next, -1) };
}
const n = (v) => Number(v || 0);
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;

/** The report as data. on: the apps that are on (a Set). */
async function build(conn, t, month, on) {
  const days = monthDays(month);
  if (!days) return null;
  const { from, to } = days;
  const tz = (await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone;
  const town = await one(conn, 'SELECT name FROM tenants WHERE id = ?', [t]);
  await W.fillBooks(conn, t);
  const { departments, funds } = await W.books(conn, t);
  const deptName = new Map(departments.map((d) => [d.id, d.name]));
  const fundName = new Map(funds.map((f) => [f.id, f.name]));
  const fromUtc = dayRange(tz, from)[0]; const toUtc = dayRange(tz, to)[1];
  const Q = require('./requests');

  // ---- work orders opened or closed in the month, and every one a cost line in the month is on
  const lines = await W.costLines(conn, t, from, to);
  const orders = await rows(conn, `SELECT w.id, w.title, w.status, w.source, w.priority, w.location, w.opened_at, w.completed_at, w.resolution, w.department_id, w.fund_id, w.street_id, w.asset_id,
      w.map_feature_id, w.request_id, w.downtime_hours, a.category AS asset_category, a.name AS asset, mf.kind AS feature_kind, mf.tag AS feature_tag, rc.name AS request_category,
      rq.house_number, rq.cross_street, st.name AS street_name, wst.name AS street
    FROM work_orders w
    LEFT JOIN ops_assets a ON a.tenant_id = w.tenant_id AND a.id = w.asset_id
    LEFT JOIN map_features mf ON mf.tenant_id = w.tenant_id AND mf.id = w.map_feature_id
    LEFT JOIN requests rq ON rq.tenant_id = w.tenant_id AND rq.id = w.request_id
    LEFT JOIN request_categories rc ON rc.tenant_id = rq.tenant_id AND rc.id = rq.category_id
    LEFT JOIN streets st ON st.tenant_id = rq.tenant_id AND st.id = rq.street_id
    LEFT JOIN streets wst ON wst.tenant_id = w.tenant_id AND wst.id = w.street_id
    WHERE w.tenant_id = ? AND ((w.opened_at BETWEEN ? AND ?) OR (w.status = 'done' AND w.completed_at BETWEEN ? AND ?) ${lines.length ? 'OR w.id IN (?)' : ''})`,
  [t, fromUtc, toUtc, `${from} 00:00:00`, `${to} 23:59:59`, ...(lines.length ? [[...new Set(lines.map((l) => l.work_order_id))]] : [])]);
  const MF = require('./mapfeatures');
  for (const w of orders) {
    w.feature_kind_label = w.feature_kind ? MF.kindLabel(w.feature_kind, 'municipality') : null;
    w.category = W.categoryOf(w);
    // Times are strings ('YYYY-MM-DD HH:MM:SS'): opened_at is UTC, completed_at the municipality's own clock.
    w.opened = Boolean(w.opened_at) && String(w.opened_at) >= fromUtc && String(w.opened_at) <= toUtc;
    w.closed = w.status === 'done' && Boolean(w.completed_at) && W.sameDay(w.completed_at) >= from && W.sameDay(w.completed_at) <= to;
  }
  const byId = new Map(orders.map((w) => [Number(w.id), w]));
  const dName = (id) => (id ? deptName.get(Number(id)) || 'Unknown department' : 'No department');
  const fName = (id) => (id ? fundName.get(Number(id)) || 'Unknown fund' : 'No fund');

  // Work orders by department and by job type: opened, closed, hours and cost in the month.
  const tally = (keyOf) => {
    const m = new Map();
    const get = (k) => { if (!m.has(k)) m.set(k, { name: k, opened: 0, closed: 0, labor_hours: 0, equipment_hours: 0, labor_cents: 0, equipment_cents: 0, parts_cents: 0, materials_cents: 0, outside_cents: 0, total_cents: 0 }); return m.get(k); };
    for (const w of orders) { const s = get(keyOf(w)); if (w.opened) s.opened += 1; if (w.closed) s.closed += 1; }
    for (const l of lines) {
      const w = byId.get(l.work_order_id); if (!w) continue;
      const s = get(keyOf(w));
      if (l.kind === 'labor') s.labor_hours += l.hours;
      if (l.kind === 'equipment') s.equipment_hours += l.hours;
      s[`${l.kind}_cents`] += l.cents; s.total_cents += l.cents;
    }
    return [...m.values()].map((s) => ({ ...s, labor_hours: r2(s.labor_hours), equipment_hours: r2(s.equipment_hours) })).sort((a, b) => b.total_cents - a.total_cents || b.closed - a.closed || a.name.localeCompare(b.name));
  };
  const byDepartment = tally((w) => dName(w.department_id));
  const byCategory = tally((w) => w.category);
  const byFund = tally((w) => fName(w.fund_id));
  // Department by fund: the cost of each pair, for the table that has a column per fund.
  const pairs = new Map();
  for (const l of lines) {
    const w = byId.get(l.work_order_id); if (!w) continue;
    const k = `${dName(w.department_id)}|${fName(w.fund_id)}`;
    const p = pairs.get(k) || { department: dName(w.department_id), fund: fName(w.fund_id), hours: 0, total_cents: 0 };
    if (l.kind === 'labor') p.hours += l.hours;
    p.total_cents += l.cents; pairs.set(k, p);
  }
  const totals = byDepartment.reduce((s, d) => ({ opened: s.opened + d.opened, closed: s.closed + d.closed, labor_hours: r2(s.labor_hours + d.labor_hours), equipment_hours: r2(s.equipment_hours + d.equipment_hours), total_cents: s.total_cents + d.total_cents }),
    { opened: 0, closed: 0, labor_hours: 0, equipment_hours: 0, total_cents: 0 });
  const still = await one(conn, "SELECT COUNT(*) AS n FROM work_orders WHERE tenant_id = ? AND opened_at <= ? AND (status NOT IN ('done','cancelled') OR completed_at > ?)", [t, toUtc, `${to} 23:59:59`]);
  totals.open_at_end = n(still.n);

  const out = { month, from, to, town: town.name, totals, by_department: byDepartment, by_category: byCategory, by_fund: byFund,
    department_fund: [...pairs.values()].map((p) => ({ ...p, hours: r2(p.hours) })).sort((a, b) => a.department.localeCompare(b.department) || a.fund.localeCompare(b.fund)) };

  // ---- resident requests: response times against the standards (made safe, fixed), and the streets with the most
  if (on.has('requests')) {
    const led = await Q.ledger(conn, t, { from, to });
    const streets = new Map();
    for (const d of led.data) { const k = d.street || 'No street given'; streets.set(k, (streets.get(k) || 0) + 1); }
    const safeN = led.summary.reduce((s, c) => s + c.safe_n, 0); const safeMet = led.summary.reduce((s, c) => s + c.safe_met, 0);
    const fixN = led.summary.reduce((s, c) => s + c.fix_n, 0); const fixMet = led.summary.reduce((s, c) => s + c.fix_met, 0);
    const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
    out.requests = {
      received: led.data.length, fixed: led.data.filter((d) => d.status === 'fixed').length, open: led.data.filter((d) => Q.OPEN.includes(d.status)).length,
      made_safe: { n: safeN, met: safeMet, pct: pct(safeMet, safeN) }, fix: { n: fixN, met: fixMet, pct: pct(fixMet, fixN) },
      by_category: led.summary,
      top_streets: [...streets.entries()].map(([street, count]) => ({ street, count })).sort((a, b) => b.count - a.count || a.street.localeCompare(b.street)).slice(0, 10),
    };
  }

  // ---- programs: every one open during the month, with how far along it is
  const programs = await rows(conn, `SELECT p.id, p.name, p.due_on, p.status, p.closed_at,
      (SELECT COUNT(*) FROM asset_program_targets g WHERE g.tenant_id = p.tenant_id AND g.program_id = p.id) AS total,
      (SELECT COUNT(*) FROM asset_program_targets g WHERE g.tenant_id = p.tenant_id AND g.program_id = p.id AND g.status = 'done') AS done,
      (SELECT COUNT(*) FROM asset_program_targets g WHERE g.tenant_id = p.tenant_id AND g.program_id = p.id AND g.status = 'skipped') AS skipped,
      (SELECT COUNT(*) FROM asset_program_targets g WHERE g.tenant_id = p.tenant_id AND g.program_id = p.id AND g.result = 'fail') AS failed,
      (SELECT COUNT(*) FROM asset_program_targets g WHERE g.tenant_id = p.tenant_id AND g.program_id = p.id AND g.status IN ('done','skipped') AND g.done_at BETWEEN ? AND ?) AS this_month
    FROM asset_programs p WHERE p.tenant_id = ? AND p.created_at <= ? AND (p.status = 'open' OR p.closed_at >= ?) ORDER BY p.due_on IS NULL, p.due_on, p.name`,
  [`${from} 00:00:00`, `${to} 23:59:59`, t, toUtc, `${from} 00:00:00`]);
  out.programs = programs.map((p) => ({ id: Number(p.id), name: p.name, due_on: W.sameDay(p.due_on), status: p.status, total: n(p.total), done: n(p.done), skipped: n(p.skipped), failed: n(p.failed), this_month: n(p.this_month) }));

  // ---- bulk pickup: bookings for collection days in the month, and what they brought in
  if (on.has('solidwaste')) {
    const b = await one(conn, `SELECT COUNT(*) AS bookings, SUM(outcome = 'picked_up') AS picked_up, SUM(outcome = 'not_out') AS not_out,
        COALESCE(SUM(paid_cents), 0) - COALESCE(SUM(refunded_cents), 0) AS revenue_cents,
        COALESCE(SUM((SELECT SUM(i.quantity) FROM bulk_booking_items i WHERE i.tenant_id = b.tenant_id AND i.booking_id = b.id)), 0) AS items
      FROM bulk_bookings b WHERE b.tenant_id = ? AND b.status = 'booked' AND b.collection_date BETWEEN ? AND ?`, [t, from, to]);
    out.bulk = { bookings: n(b.bookings), items: n(b.items), picked_up: n(b.picked_up), not_out: n(b.not_out), revenue_cents: n(b.revenue_cents) };
  }

  // ---- street notices sent in the month
  {
    const list = await rows(conn, `SELECT s.id, s.type, s.title, s.sent_at, s.status,
        (SELECT COUNT(*) FROM street_notice_deliveries d WHERE d.tenant_id = s.tenant_id AND d.notice_id = s.id AND d.status = 'sent') AS delivered
      FROM street_notices s WHERE s.tenant_id = ? AND s.sent_at BETWEEN ? AND ? ORDER BY s.sent_at`, [t, `${from} 00:00:00`, `${to} 23:59:59`]);
    out.notices = { sent: list.length, delivered: list.reduce((s, x) => s + n(x.delivered), 0), list: list.map((x) => ({ id: Number(x.id), type: x.type, title: x.title, sent_at: x.sent_at, status: x.status, delivered: n(x.delivered) })) };
  }

  // ---- building checks: done in the month, and overdue now
  if (on.has('buildings')) {
    const B = require('./buildings');
    const done = await one(conn, 'SELECT COUNT(*) AS n FROM pm_log l JOIN building_plans p ON p.tenant_id = l.tenant_id AND p.pm_task_id = l.pm_task_id WHERE l.tenant_id = ? AND l.done_on BETWEEN ? AND ?', [t, from, to]);
    const { todayIn } = require('./util');
    const plans = await B.plansOf(conn, t, todayIn(tz));
    out.buildings = { done: n(done.n), overdue: plans.filter((p) => p.state === 'overdue').length, never: plans.filter((p) => p.state === 'never').length, plans: plans.length };
  }

  // ---- fleet: each vehicle and machine, its cost in the month (upkeep and fuel), its hours on jobs, its time out of service
  {
    const fleet = await rows(conn, "SELECT id, name, asset_tag, status FROM ops_assets WHERE tenant_id = ? AND category IN ('fleet','equipment') AND status <> 'retired' ORDER BY name", [t]);
    const ids = fleet.map((a) => a.id);
    if (ids.length) {
      const [labor, parts, mats, vendor, fuel, used, down] = await Promise.all([
        rows(conn, 'SELECT w.asset_id, SUM(ROUND(l.hours * l.rate_cents)) AS c FROM work_order_labor l JOIN work_orders w ON w.tenant_id = l.tenant_id AND w.id = l.work_order_id WHERE l.tenant_id = ? AND w.asset_id IN (?) AND l.worked_on BETWEEN ? AND ? GROUP BY w.asset_id', [t, ids, from, to]),
        rows(conn, "SELECT asset_id, SUM(ROUND(-qty * unit_cost_cents)) AS c FROM part_moves WHERE tenant_id = ? AND asset_id IN (?) AND kind IN ('issue','return') AND at BETWEEN ? AND ? GROUP BY asset_id", [t, ids, `${from} 00:00:00`, `${to} 23:59:59`]),
        rows(conn, 'SELECT w.asset_id, SUM(ROUND(m.qty * m.unit_cost_cents)) AS c FROM work_order_materials m JOIN work_orders w ON w.tenant_id = m.tenant_id AND w.id = m.work_order_id WHERE m.tenant_id = ? AND w.asset_id IN (?) AND m.used_on BETWEEN ? AND ? GROUP BY w.asset_id', [t, ids, from, to]),
        rows(conn, "SELECT asset_id, SUM(vendor_cost_cents) AS c FROM work_orders WHERE tenant_id = ? AND asset_id IN (?) AND status = 'done' AND completed_at BETWEEN ? AND ? GROUP BY asset_id", [t, ids, `${from} 00:00:00`, `${to} 23:59:59`]),
        rows(conn, 'SELECT asset_id, SUM(cost_cents) AS c, SUM(gallons) AS g FROM asset_fuel WHERE tenant_id = ? AND asset_id IN (?) AND filled_at BETWEEN ? AND ? GROUP BY asset_id', [t, ids, `${from} 00:00:00`, `${to} 23:59:59`]),
        rows(conn, 'SELECT asset_id, SUM(hours) AS h, SUM(ROUND(hours * rate_cents)) AS c FROM work_order_equipment WHERE tenant_id = ? AND asset_id IN (?) AND used_on BETWEEN ? AND ? GROUP BY asset_id', [t, ids, from, to]),
        rows(conn, "SELECT asset_id, SUM(downtime_hours) AS h, COUNT(*) AS jobs FROM work_orders WHERE tenant_id = ? AND asset_id IN (?) AND status = 'done' AND completed_at BETWEEN ? AND ? GROUP BY asset_id", [t, ids, `${from} 00:00:00`, `${to} 23:59:59`]),
      ]);
      const pick = (list, id, k = 'c') => n((list.find((x) => Number(x.asset_id) === Number(id)) || {})[k]);
      out.fleet = fleet.map((a) => {
        const upkeep = pick(labor, a.id) + pick(parts, a.id) + pick(mats, a.id) + pick(vendor, a.id);
        return { id: Number(a.id), name: a.name, tag: a.asset_tag, status: a.status, upkeep_cents: upkeep, fuel_cents: pick(fuel, a.id), gallons: r2(pick(fuel, a.id, 'g')), cost_cents: upkeep + pick(fuel, a.id),
          job_hours: r2(pick(used, a.id, 'h')), job_value_cents: pick(used, a.id), repairs: pick(down, a.id, 'jobs'), out_of_service_days: Math.round((pick(down, a.id, 'h') / 24) * 10) / 10 };
      }).filter((a) => a.cost_cents || a.job_hours || a.repairs || a.status === 'out_of_service')
        .sort((a, b) => b.cost_cents - a.cost_cents || a.name.localeCompare(b.name));
    } else out.fleet = [];
  }

  // ---- the largest jobs completed in the month, with their photos
  const closed = orders.filter((w) => w.closed);
  const costs = await W.orderCosts(conn, t, closed.map((w) => Number(w.id)));
  const top = closed.map((w) => ({ w, c: costs.get(Number(w.id)) })).filter((x) => x.c.total_cents > 0).sort((a, b) => b.c.total_cents - a.c.total_cents).slice(0, 5);
  out.highlights = [];
  for (const { w, c } of top) {
    const fromRequest = Boolean(w.request_id);
    const photos = [];
    if (w.request_id) for (const p of await rows(conn, "SELECT id, stage FROM request_photos WHERE tenant_id = ? AND request_id = ? AND stage IN ('before','after') ORDER BY FIELD(stage, 'before', 'after'), id LIMIT 2", [t, w.request_id])) photos.push({ kind: 'request', id: Number(p.id), stage: p.stage });
    if (photos.length < 2 && (w.asset_id || w.map_feature_id)) {
      const col = w.map_feature_id ? 'map_feature_id' : 'asset_id';
      for (const p of await rows(conn, `SELECT id FROM asset_photos WHERE tenant_id = ? AND ${col} = ? AND uploaded_at BETWEEN ? AND ? ORDER BY id DESC LIMIT ?`, [t, w.map_feature_id || w.asset_id, String(w.opened_at), `${to} 23:59:59`, 2 - photos.length])) photos.push({ kind: 'asset', id: Number(p.id), stage: null });
    }
    out.highlights.push({
      work_order_id: Number(w.id), title: fromRequest ? `${w.category}, ${Q.publicPlace(w)}` : w.title, department: dName(w.department_id), category: w.category,
      completed_on: W.sameDay(w.completed_at), labor_hours: r2(c.labor_hours), equipment_hours: r2(c.equipment_hours), total_cents: c.total_cents,
      resolution: fromRequest ? Q.withoutHouseNumber(w.resolution, w) : w.resolution, photos,
    });
  }

  // ---- the Liquid Fuels fund by street, January 1 to the end of the month
  const lf = funds.filter((f) => f.kind === 'liquid_fuels').map((f) => f.id);
  if (lf.length) {
    const ytd = await W.costLines(conn, t, `${month.slice(0, 4)}-01-01`, to);
    const ids = [...new Set(ytd.map((l) => l.work_order_id))];
    const wos = ids.length ? await rows(conn, 'SELECT w.id, w.fund_id, st.name AS street FROM work_orders w LEFT JOIN streets st ON st.tenant_id = w.tenant_id AND st.id = w.street_id WHERE w.tenant_id = ? AND w.id IN (?)', [t, ids]) : [];
    const lfOrders = new Map(wos.filter((w) => lf.includes(Number(w.fund_id))).map((w) => [Number(w.id), w.street || 'Street not set']));
    const by = new Map();
    for (const l of ytd) {
      if (!lfOrders.has(l.work_order_id)) continue;
      const k = lfOrders.get(l.work_order_id);
      const s = by.get(k) || { street: k, labor_cents: 0, equipment_cents: 0, materials_cents: 0, outside_cents: 0, total_cents: 0, month_cents: 0, jobs: new Set() };
      const bucket = l.kind === 'parts' ? 'materials' : l.kind;
      s[`${bucket}_cents`] += l.cents; s.total_cents += l.cents; if (l.day >= from) s.month_cents += l.cents; s.jobs.add(l.work_order_id);
      by.set(k, s);
    }
    const list = [...by.values()].map((s) => ({ ...s, jobs: s.jobs.size })).sort((a, b) => (a.street === 'Street not set') - (b.street === 'Street not set') || b.total_cents - a.total_cents);
    out.liquid_fuels = { fund: funds.filter((f) => lf.includes(f.id)).map((f) => f.name).join(', '), from: `${month.slice(0, 4)}-01-01`, to, streets: list, total_cents: list.reduce((s, x) => s + x.total_cents, 0) };
  }
  return out;
}

/** The report as one spreadsheet: a row per line of every section, the section named in the first column. */
function csvRows(r) {
  const out = [];
  const add = (section, item, extra = {}) => out.push({ section, item, ...extra });
  const d = (c) => (c === null || c === undefined ? '' : (Number(c) / 100).toFixed(2));
  add('Summary', 'Work orders opened', { count: r.totals.opened });
  add('Summary', 'Work orders completed', { count: r.totals.closed });
  add('Summary', 'Work orders open at the end of the month', { count: r.totals.open_at_end });
  add('Summary', 'Labor hours', { hours: r.totals.labor_hours });
  add('Summary', 'Equipment hours', { hours: r.totals.equipment_hours });
  add('Summary', 'Cost', { cost: d(r.totals.total_cents) });
  for (const [section, list] of [['By department', r.by_department], ['By job type', r.by_category], ['By fund', r.by_fund]]) {
    for (const x of list) add(section, x.name, { opened: x.opened, completed: x.closed, hours: x.labor_hours, equipment_hours: x.equipment_hours, labor: d(x.labor_cents), equipment: d(x.equipment_cents), materials: d(x.parts_cents + x.materials_cents), outside: d(x.outside_cents), cost: d(x.total_cents) });
  }
  for (const p of r.department_fund) add('Department and fund', `${p.department} / ${p.fund}`, { hours: p.hours, cost: d(p.total_cents) });
  if (r.requests) {
    add('Requests', 'Received', { count: r.requests.received });
    add('Requests', 'Made safe within target', { count: r.requests.made_safe.met, of: r.requests.made_safe.n, percent: r.requests.made_safe.pct ?? '' });
    add('Requests', 'Fixed within target', { count: r.requests.fix.met, of: r.requests.fix.n, percent: r.requests.fix.pct ?? '' });
    for (const c of r.requests.by_category) add('Requests by category', c.category, { count: c.requests, made_safe_met: c.safe_met, made_safe_of: c.safe_n, made_safe_percent: c.safe_pct ?? '', fixed_met: c.fix_met, fixed_of: c.fix_n, fixed_percent: c.fix_pct ?? '' });
    for (const s of r.requests.top_streets) add('Top streets by requests', s.street, { count: s.count });
  }
  for (const p of r.programs) add('Programs', p.name, { count: p.done, of: p.total, skipped: p.skipped, failed: p.failed, this_month: p.this_month, due: p.due_on || '' });
  if (r.bulk) add('Bulk pickup', 'Bookings', { count: r.bulk.bookings, items: r.bulk.items, picked_up: r.bulk.picked_up, not_out: r.bulk.not_out, cost: d(r.bulk.revenue_cents) });
  for (const x of r.notices.list) add('Street notices', x.title, { date: String(x.sent_at).slice(0, 10), count: x.delivered });
  if (r.buildings) add('Building checks', 'Done this month', { count: r.buildings.done, overdue: r.buildings.overdue, never: r.buildings.never });
  for (const a of r.fleet) add('Fleet', `${a.name}${a.tag ? ` (${a.tag})` : ''}`, { cost: d(a.cost_cents), upkeep: d(a.upkeep_cents), fuel: d(a.fuel_cents), hours: a.job_hours, repairs: a.repairs, out_of_service_days: a.out_of_service_days });
  for (const h of r.highlights) add('Largest jobs', h.title, { department: h.department, date: h.completed_on, hours: h.labor_hours, cost: d(h.total_cents) });
  if (r.liquid_fuels) for (const s of r.liquid_fuels.streets) add('Liquid Fuels by street, year to date', s.street, { count: s.jobs, labor: d(s.labor_cents), equipment: d(s.equipment_cents), materials: d(s.materials_cents), outside: d(s.outside_cents), cost: d(s.total_cents), this_month: d(s.month_cents) });
  const cols = ['section', 'item', 'department', 'date', 'count', 'of', 'percent', 'opened', 'completed', 'hours', 'equipment_hours', 'labor', 'equipment', 'materials', 'outside', 'upkeep', 'fuel', 'cost', 'this_month',
    'made_safe_met', 'made_safe_of', 'made_safe_percent', 'fixed_met', 'fixed_of', 'fixed_percent', 'skipped', 'failed', 'due', 'items', 'picked_up', 'not_out', 'overdue', 'never', 'repairs', 'out_of_service_days'];
  return { cols, data: out };
}

module.exports = { build, csvRows, monthDays };
