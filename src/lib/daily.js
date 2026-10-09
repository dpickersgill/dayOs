'use strict';

// The day's numbers for one mountain: used by the Today screen, the day board and the weekly report.
const { pool, one, rows } = require('../db');
const { dateStr, todayIn, dayRange } = require('./util');
const { bad } = require('./errors');

/** The day's numbers for one mountain (also used by the day board). date: YYYY-MM-DD, or null for the mountain's today. */
async function dailyReport(tenantId, requested) {
  const tenant = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const date = requested || todayIn(tenant.timezone);
  if (!dateStr.safeParse(date).success) throw bad('date must be YYYY-MM-DD');
  const [from, to] = dayRange(tenant.timezone, date); // orders and scans are stamped in database time (UTC)

  const [scans, sales, giftSold, tenders, byProduct, taxRow, partial, refundsToday, shifts, unfilled, incidents, rentalsOut, overdue, lessons] = await Promise.all([
    one(pool, "SELECT COUNT(DISTINCT ticket_id) AS guests FROM scans WHERE tenant_id = ? AND result = 'ok' AND scanned_at >= ? AND scanned_at < ?", [tenantId, from, to]),
    one(pool, "SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS revenue_cents FROM orders WHERE tenant_id = ? AND status IN ('paid','refunded') AND created_at >= ? AND created_at < ?", [tenantId, from, to]),
    one(pool, "SELECT COALESCE(SUM(i.unit_price_cents * i.quantity), 0) AS cents FROM order_items i JOIN orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id WHERE i.tenant_id = ? AND i.line_kind = 'gift_card' AND o.status IN ('paid','refunded') AND o.created_at >= ? AND o.created_at < ?", [tenantId, from, to]),
    rows(pool, "SELECT pay.tender, SUM(pay.amount_cents) AS cents FROM order_payments pay JOIN orders o ON o.id = pay.order_id AND o.tenant_id = pay.tenant_id WHERE pay.tenant_id = ? AND o.status IN ('paid','refunded') AND o.created_at >= ? AND o.created_at < ? GROUP BY pay.tender", [tenantId, from, to]),
    rows(pool, "SELECT COALESCE(p.name, pg.name) AS name, SUM(i.quantity) AS units FROM order_items i JOIN orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id LEFT JOIN products p ON p.id = i.product_id AND p.tenant_id = i.tenant_id LEFT JOIN programs pg ON pg.id = i.program_id AND pg.tenant_id = i.tenant_id WHERE i.tenant_id = ? AND i.line_kind NOT IN ('gift_card','fee') AND o.status IN ('paid','refunded') AND o.created_at >= ? AND o.created_at < ? GROUP BY COALESCE(p.name, pg.name) ORDER BY units DESC LIMIT 10", [tenantId, from, to]),
    // Tax actually collected: when part of an order was given away free, that share of its tax was not collected either.
    one(pool, `SELECT COALESCE(SUM(o.tax_cents - ROUND(o.tax_cents * COALESCE(c.comp, 0) / NULLIF(o.total_cents, 0))), 0) AS tax FROM orders o
               LEFT JOIN (SELECT order_id, SUM(amount_cents) AS comp FROM order_payments WHERE tenant_id = ? AND tender = 'comp' GROUP BY order_id) c ON c.order_id = o.id
               WHERE o.tenant_id = ? AND o.status IN ('paid','refunded') AND o.created_at >= ? AND o.created_at < ?`, [tenantId, tenantId, from, to]),
    // Refunds count on the day they were given, whenever the sale was (so a past day's figures never change later).
    one(pool, `SELECT COALESCE(SUM(r.amount_cents), 0) AS amount, COALESCE(SUM(r.tax_cents), 0) AS tax,
               (SELECT COALESCE(SUM(i.unit_price_cents * i.quantity), 0) FROM order_items i WHERE i.tenant_id = ? AND i.line_kind = 'gift_card' AND i.refunded_at >= ? AND i.refunded_at < ?) AS gift
               FROM order_refunds r WHERE r.tenant_id = ? AND r.created_at >= ? AND r.created_at < ?`, [tenantId, from, to, tenantId, from, to]),
    rows(pool, "SELECT method, COUNT(*) AS n, SUM(amount_cents) AS cents FROM order_refunds WHERE tenant_id = ? AND created_at >= ? AND created_at < ? GROUP BY method", [tenantId, from, to]),
    one(pool, "SELECT COUNT(*) AS n FROM shifts WHERE tenant_id = ? AND status <> 'cancelled' AND DATE(starts_at) = ?", [tenantId, date]),
    one(pool, "SELECT COUNT(*) AS n FROM shifts WHERE tenant_id = ? AND status <> 'cancelled' AND staff_id IS NULL AND DATE(starts_at) = ?", [tenantId, date]),
    one(pool, "SELECT COUNT(*) AS opened_today, (SELECT COUNT(*) FROM incidents WHERE tenant_id = ? AND status = 'open') AS open_total FROM incidents WHERE tenant_id = ? AND DATE(occurred_at) = ?", [tenantId, tenantId, date]),
    one(pool, "SELECT COUNT(*) AS n FROM rental_contracts WHERE tenant_id = ? AND status = 'out'", [tenantId]),
    one(pool, "SELECT COUNT(*) AS n FROM rental_contracts WHERE tenant_id = ? AND status = 'out' AND due_at < NOW()", [tenantId]),
    one(pool, "SELECT COUNT(*) AS sessions, COALESCE(SUM((SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status IN ('booked','attended'))), 0) AS students FROM lesson_sessions s WHERE s.tenant_id = ? AND s.status <> 'cancelled' AND DATE(s.starts_at) = ?", [tenantId, date]),
  ]);

  const comps = Number((tenders.find((x) => x.tender === 'comp') || {}).cents || 0);
  return {
    date,
    guests_scanned: scans.guests,
    // Revenue leaves out gift cards sold (money owed to the guest, not yet earned); a gift card spent shows up as a sale when it is spent.
    sales: {
      orders: sales.orders,
      // What was earned, before tax: the day's sales, less tax collected, gift cards sold and things given away free, less
      // refunds given that day (before tax, leaving out gift cards, which were never counted as earned).
      revenue_cents: Number(sales.revenue_cents) - Number(taxRow.tax) - Number(giftSold.cents) - comps - (Number(partial.amount) - Number(partial.tax) - Number(partial.gift)),
      gross_cents: Number(sales.revenue_cents), tax_cents: Number(taxRow.tax), comp_cents: comps,
      gift_card_sales_cents: Number(giftSold.cents), top_products: byProduct,
      tenders: Object.fromEntries(['cash', 'card', 'gift_card', 'other', 'comp'].map((t) => [t, Number((tenders.find((x) => x.tender === t) || {}).cents || 0)])),
      refunds: { count: refundsToday.reduce((n, r) => n + Number(r.n), 0), amount_cents: refundsToday.reduce((n, r) => n + Number(r.cents), 0), by_method: Object.fromEntries(refundsToday.map((r) => [r.method, Number(r.cents)])) },
    },
    staffing: { shifts: shifts.n, unfilled_shifts: unfilled.n },
    patrol: { incidents_today: incidents.opened_today, open_incidents: incidents.open_total },
    rentals: { out: rentalsOut.n, overdue: overdue.n },
    ski_school: { sessions: lessons.sessions, students: Number(lessons.students) },
  };
}


module.exports = { dailyReport };
