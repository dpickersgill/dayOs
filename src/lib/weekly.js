'use strict';

// The weekly owner report: last week in numbers, compared with the week before, emailed to owners and managers on Monday.
// Weeks run Monday to Sunday in the mountain's own time. Day figures come from the same code as the Today screen, so the
// two never disagree. Sandbox (demo) mountains never send.
const { pool, one, rows } = require('../db');
const { todayIn, addDays, weekdayOf, dayRange } = require('./util');
const mailer = require('./mailer');
const { isSandbox } = require('./sandbox');
const { dailyReport } = require('./daily');
const { eachTenant } = require('./jobs');
const { money, esc } = require('./format');

const dollars = (c) => /* whole dollars, for headline numbers */ `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const weekStartOf = (date) => addDays(date, -((weekdayOf(date) + 6) % 7)); // the Monday on or before
const pct = (now, before) => (before > 0 ? Math.round(((now - before) / before) * 100) : null);
const LABEL = { ticket: 'Tickets and passes', lesson: 'Lessons', rental: 'Rentals', program: 'Programs', gift_card: 'Gift cards sold' };
const CHANNEL = { window: 'Ticket window', online: 'Online', phone: 'Phone', group: 'Groups' };
const dayName = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${d}T12:00:00Z`));

async function daySeries(tenantId, start, dailyReport) {
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    const r = await dailyReport(tenantId, d);
    out.push({ date: d, revenue_cents: r.sales.revenue_cents, gross_cents: r.sales.gross_cents, tax_cents: r.sales.tax_cents, comp_cents: r.sales.comp_cents, orders: r.sales.orders, guests: Number(r.guests_scanned || 0),
      refunds_cents: r.sales.refunds.amount_cents, tenders: r.sales.tenders, top: r.sales.top_products });
  }
  return out;
}
const sum = (list, k) => list.reduce((n, x) => n + Number(x[k] || 0), 0);

/** Everything in the report for the week starting on `weekStart` (a Monday, 'YYYY-MM-DD'). */
async function buildWeek(tenantId, weekStart) {
  const tenant = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const tz = tenant.timezone;
  const end = addDays(weekStart, 6);
  const [from] = dayRange(tz, weekStart); const [to] = dayRange(tz, addDays(end, 1));
  const today = todayIn(tz);
  const days = await daySeries(tenantId, weekStart, dailyReport);
  const prevDays = await daySeries(tenantId, addDays(weekStart, -7), dailyReport);
  const tot = { revenue_cents: sum(days, 'revenue_cents'), gross_cents: sum(days, 'gross_cents'), tax_cents: sum(days, 'tax_cents'), comp_cents: sum(days, 'comp_cents'), orders: sum(days, 'orders'), guests: sum(days, 'guests'), refunds_cents: sum(days, 'refunds_cents') };
  const prev = { revenue_cents: sum(prevDays, 'revenue_cents'), orders: sum(prevDays, 'orders'), guests: sum(prevDays, 'guests') };
  const tenders = {};
  for (const d of days) for (const [k, v] of Object.entries(d.tenders)) tenders[k] = (tenders[k] || 0) + Number(v);
  const top = new Map();
  for (const d of days) for (const p of d.top) top.set(p.name, (top.get(p.name) || 0) + Number(p.units));
  const channels = await rows(pool, "SELECT channel, COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS cents FROM orders WHERE tenant_id = ? AND status = 'paid' AND created_at >= ? AND created_at < ? GROUP BY channel ORDER BY cents DESC", [tenantId, from, to]);
  const types = await rows(pool, "SELECT i.line_kind AS kind, COALESCE(SUM(i.unit_price_cents * i.quantity - i.discount_cents), 0) AS cents FROM order_items i JOIN orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id WHERE i.tenant_id = ? AND o.status = 'paid' AND o.created_at >= ? AND o.created_at < ? GROUP BY i.line_kind ORDER BY cents DESC", [tenantId, from, to]);
  const people = await one(pool, 'SELECT COUNT(*) AS n FROM people WHERE tenant_id = ? AND anonymised_at IS NULL AND created_at >= ? AND created_at < ?', [tenantId, from, to]);
  const optIns = await one(pool, "SELECT COUNT(*) AS n FROM consent_events WHERE tenant_id = ? AND channel = 'email' AND status = 'opted_in' AND created_at >= ? AND created_at < ?", [tenantId, from, to]);
  const lessons = await one(pool, "SELECT COUNT(*) AS sessions, COALESCE(SUM((SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status IN ('booked','attended'))), 0) AS students FROM lesson_sessions s WHERE s.tenant_id = ? AND s.status <> 'cancelled' AND DATE(s.starts_at) >= ? AND DATE(s.starts_at) <= ?", [tenantId, weekStart, end]);
  const inc = await one(pool, 'SELECT COUNT(*) AS n FROM incidents WHERE tenant_id = ? AND DATE(occurred_at) >= ? AND DATE(occurred_at) <= ?', [tenantId, weekStart, end]);
  const [overdue, unfilled, passes, openInc] = await Promise.all([
    one(pool, "SELECT COUNT(*) AS n FROM rental_contracts WHERE tenant_id = ? AND status = 'out' AND due_at < NOW()", [tenantId]),
    one(pool, "SELECT COUNT(*) AS n FROM shifts WHERE tenant_id = ? AND status <> 'cancelled' AND staff_id IS NULL AND DATE(starts_at) >= ? AND DATE(starts_at) < ?", [tenantId, today, addDays(today, 7)]),
    one(pool, "SELECT COUNT(*) AS n FROM tickets t JOIN products p ON p.id = t.product_id AND p.tenant_id = t.tenant_id WHERE t.tenant_id = ? AND p.kind = 'season_pass' AND t.status = 'active' AND t.valid_to >= ? AND t.valid_to <= ?", [tenantId, today, addDays(today, 14)]),
    one(pool, "SELECT COUNT(*) AS n FROM incidents WHERE tenant_id = ? AND status = 'open'", [tenantId]),
  ]);
  const online = channels.find((c) => c.channel === 'online');
  const best = [...days].sort((a, b) => b.revenue_cents - a.revenue_cents)[0];
  return {
    week_start: weekStart, week_end: end, complete: today > end,
    days: days.map((d) => ({ date: d.date, revenue_cents: d.revenue_cents, orders: d.orders, guests: d.guests })),
    totals: tot, prev, change: { revenue_pct: pct(tot.revenue_cents, prev.revenue_cents), orders_pct: pct(tot.orders, prev.orders), guests_pct: pct(tot.guests, prev.guests) },
    best_day: best && best.revenue_cents > 0 ? { date: best.date, revenue_cents: best.revenue_cents } : null,
    channels: channels.map((c) => ({ channel: c.channel, orders: Number(c.orders), cents: Number(c.cents) })),
    online_share_pct: online && tot.gross_cents > 0 ? Math.round((Number(online.cents) / tot.gross_cents) * 100) : 0,
    types: types.map((t) => ({ kind: t.kind, cents: Number(t.cents) })),
    tenders, top_products: [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, units]) => ({ name, units })),
    new_customers: Number(people.n), new_email_opt_ins: Number(optIns.n),
    ski_school: { sessions: Number(lessons.sessions), students: Number(lessons.students) },
    patrol: { incidents: Number(inc.n) },
    attention: { overdue_rentals: Number(overdue.n), unfilled_shifts_next_7_days: Number(unfilled.n), season_passes_ending_14_days: Number(passes.n), open_incidents: Number(openInc.n) },
  };
}

const arrow = (p) => (p === null ? 'no week before to compare' : p === 0 ? 'same as the week before' : `${p > 0 ? 'up' : 'down'} ${Math.abs(p)}% on the week before`);

/** The email: plain text and a simple table layout that survives every mail program. */
function renderEmail(s, tenant) {
  const range = `${dayName(s.week_start)} to ${dayName(s.week_end)}`;
  const t = s.totals;
  const attention = [];
  if (s.attention.overdue_rentals) attention.push(`${s.attention.overdue_rentals} rental${s.attention.overdue_rentals > 1 ? 's' : ''} overdue`);
  if (s.attention.unfilled_shifts_next_7_days) attention.push(`${s.attention.unfilled_shifts_next_7_days} shift${s.attention.unfilled_shifts_next_7_days > 1 ? 's' : ''} with nobody assigned in the next 7 days`);
  if (s.attention.season_passes_ending_14_days) attention.push(`${s.attention.season_passes_ending_14_days} season pass${s.attention.season_passes_ending_14_days > 1 ? 'es' : ''} ending within 14 days`);
  if (s.attention.open_incidents) attention.push(`${s.attention.open_incidents} patrol case${s.attention.open_incidents > 1 ? 's' : ''} still open`);
  const lines = [
    `${tenant.name}: week of ${range}`, '',
    `Sales (before tax, after refunds): ${dollars(t.revenue_cents)}, ${arrow(s.change.revenue_pct)}`,
    `Orders: ${t.orders}, ${arrow(s.change.orders_pct)}`,
    `Guests on the lifts (tickets scanned, counted per day): ${t.guests}, ${arrow(s.change.guests_pct)}`,
    ...(s.best_day ? [`Best day: ${dayName(s.best_day.date)}, ${dollars(s.best_day.revenue_cents)}`] : []),
    '', 'Day by day:', ...s.days.map((d) => `  ${dayName(d.date)}: ${dollars(d.revenue_cents)}, ${d.orders} orders, ${d.guests} guests`),
    ...(s.types.length ? ['', 'Sales by type (before tax and refunds):', ...s.types.map((x) => `  ${LABEL[x.kind] || x.kind}: ${dollars(x.cents)}`)] : []),
    ...(s.channels.length ? ['', 'Where it was sold:', ...s.channels.map((x) => `  ${CHANNEL[x.channel] || x.channel}: ${x.orders} orders, ${money(x.cents)}`), `  Online share of sales: ${s.online_share_pct}%`] : []),
    ...(s.top_products.length ? ['', 'Top sellers:', ...s.top_products.map((p) => `  ${p.name}: ${p.units}`)] : []),
    '', `New customers: ${s.new_customers} (${s.new_email_opt_ins} agreed to email)`, `Ski school: ${s.ski_school.sessions} lessons, ${s.ski_school.students} students`, `Patrol cases: ${s.patrol.incidents}`,
    ...(attention.length ? ['', 'Needs attention:', ...attention.map((a) => `  - ${a}`)] : ['', 'Nothing needs attention.']),
    '', 'This report comes every Monday. Turn it off in Settings.',
  ];
  const td = 'padding:6px 10px;border-bottom:1px solid #e3e8eb;';
  const row = (a, b) => `<tr><td style="${td}">${esc(a)}</td><td style="${td}text-align:right;font-weight:bold">${esc(b)}</td></tr>`;
  const table = (title, items) => (items.length ? `<h3 style="margin:22px 0 6px;font-size:16px">${esc(title)}</h3><table style="border-collapse:collapse;width:100%;font-size:14px">${items.join('')}</table>` : '');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#12303a;max-width:600px;margin:0 auto"><h2 style="margin:0 0 4px">${esc(tenant.name)}</h2><div style="color:#4f636d">Week of ${esc(range)}</div>
    <table style="width:100%;margin-top:14px;border-collapse:collapse"><tr>${[['Sales', dollars(t.revenue_cents), arrow(s.change.revenue_pct)], ['Orders', String(t.orders), arrow(s.change.orders_pct)], ['Guests', String(t.guests), arrow(s.change.guests_pct)]]
      .map(([a, b, c]) => `<td style="padding:10px;vertical-align:top;width:33%"><div style="color:#4f636d;font-size:13px">${a}</div><div style="font-size:26px;font-weight:bold">${esc(b)}</div><div style="color:#4f636d;font-size:12px">${esc(c)}</div></td>`).join('')}</tr></table>
    ${table('Day by day', s.days.map((d) => row(dayName(d.date), `${dollars(d.revenue_cents)}  ·  ${d.guests} guests`)))}
    ${table('Sales by type (before tax and refunds)', s.types.map((x) => row(LABEL[x.kind] || x.kind, dollars(x.cents))))}
    ${table('Where it was sold', s.channels.map((x) => row(CHANNEL[x.channel] || x.channel, `${x.orders} orders  ·  ${money(x.cents)}`)))}
    ${table('Top sellers', s.top_products.map((p) => row(p.name, String(p.units))))}
    ${table('Also this week', [row('New customers', `${s.new_customers} (${s.new_email_opt_ins} agreed to email)`), row('Ski school', `${s.ski_school.sessions} lessons, ${s.ski_school.students} students`), row('Patrol cases', String(s.patrol.incidents))])}
    ${attention.length ? `<h3 style="margin:22px 0 6px;font-size:16px;color:#8a5300">Needs attention</h3><ul style="margin:0;padding-left:20px;font-size:14px">${attention.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : '<p style="font-size:14px;color:#17703f">Nothing needs attention.</p>'}
    <p style="color:#4f636d;font-size:12px;margin-top:24px">This report comes every Monday. A manager can turn it off in Settings.</p></div>`;
  return { subject: `${tenant.name}: your week of ${dayName(s.week_start)}`, text: lines.join('\n'), html };
}

/** Owners and managers with an email address. */
const recipients = (tenantId) => rows(pool, "SELECT email FROM users WHERE tenant_id = ? AND active = 1 AND role IN ('owner','manager') AND email <> ''", [tenantId]);

/** Make last week's report for a mountain if it is Monday to Wednesday and not yet done, and email it once. */
async function runForTenant(t, { now } = {}) {
  const today = now || todayIn(t.timezone);
  const thisMon = weekStartOf(today);
  const late = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${thisMon}T00:00:00Z`)) / 86_400_000);
  if (late > 2) return { skipped: 'late' };
  const week = addDays(thisMon, -7);
  let row = await one(pool, 'SELECT * FROM weekly_reports WHERE tenant_id = ? AND week_start = ?', [t.id, week]);
  if (!row) {
    const s = await buildWeek(t.id, week);
    await pool.query('INSERT IGNORE INTO weekly_reports (tenant_id, week_start, summary) VALUES (?, ?, ?)', [t.id, week, JSON.stringify(s)]);
    row = await one(pool, 'SELECT * FROM weekly_reports WHERE tenant_id = ? AND week_start = ?', [t.id, week]);
  }
  if (row.emailed_at) return { skipped: 'already sent' };
  if (!t.weekly_report) return { skipped: 'off' };
  if (!mailer.enabled() || await isSandbox(t.id)) return { skipped: 'email not set up' };
  const [claim] = await pool.query('UPDATE weekly_reports SET emailed_at = NOW() WHERE id = ? AND emailed_at IS NULL', [row.id]);
  if (!claim.affectedRows) return { skipped: 'already sent' };
  const s = JSON.parse(row.summary); const m = renderEmail(s, t); const sent = [];
  for (const r of await recipients(t.id)) {
    const out = await mailer.send({ to: r.email, fromName: t.name, subject: m.subject, text: m.text, html: m.html, tag: 'weekly-report' });
    if (out.ok) sent.push(r.email);
  }
  if (!sent.length) { await pool.query('UPDATE weekly_reports SET emailed_at = NULL WHERE id = ?', [row.id]); return { sent: 0 }; }
  await pool.query('UPDATE weekly_reports SET sent_to = ? WHERE id = ?', [sent.join(', ').slice(0, 600), row.id]);
  return { sent: sent.length };
}

async function runAll() {
  return eachTenant('weekly_report', (t) => runForTenant(t));
}

module.exports = { weekStartOf, buildWeek, renderEmail, runForTenant, runAll, recipients };
