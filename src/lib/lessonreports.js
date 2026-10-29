'use strict';
// The director's reports for a stretch of days: seat fill (by day, time, product and level), revenue per lesson and per
// instructor, first lesson to return, no-shows, privates and requests per instructor, recaps sent and tips (counts only).
//
// Revenue method (also shown on the page): each lesson's money is what was paid for a seat in it, before tax, less refunds.
//   - a lesson sold at the counter: its order line (price times quantity, less discount);
//   - a lesson booked and paid online: the order, before tax, shared evenly between the students on that request;
//   - a lesson from a package: the package's price shared evenly over its lessons;
//   - a weather credit or an unpaid booking: nothing (the money was counted on the first lesson).
// A lesson's revenue goes to the instructor who taught it.
const { pool, rows, one } = require('../db');
const levels = require('./levels');
const { addDays } = require('./util');

const hhmm = (dt) => String(dt).slice(11, 16);
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

async function tableHas(table, column) {
  const r = await one(pool, 'SELECT 1 AS ok FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return Boolean(r);
}

/** Every lesson in the range (not canceled) with its seats, students, instructor and revenue. */
async function lessonsIn(tenantId, from, to) {
  const list = await rows(pool, `SELECT s.id, s.starts_at, s.ends_at, s.discipline, s.format, s.level_min, s.level_max, s.capacity, s.instructor_id, s.product_id, pr.name AS product,
      CONCAT(p.first_name, ' ', p.last_name) AS instructor
    FROM lesson_sessions s JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
    LEFT JOIN staff st ON st.tenant_id = s.tenant_id AND st.id = s.instructor_id LEFT JOIN people p ON p.tenant_id = st.tenant_id AND p.id = st.person_id
    WHERE s.tenant_id = ? AND s.status <> 'cancelled' AND s.starts_at >= ? AND s.starts_at < ? ORDER BY s.starts_at, s.id`, [tenantId, `${from} 00:00:00`, `${addDays(to, 1)} 00:00:00`]);
  if (!list.length) return list;
  const ids = list.map((s) => s.id);
  const bookings = await rows(pool, `SELECT b.id, b.session_id, b.person_id, b.status, b.credit_id, b.request_id, b.requested_instructor_id FROM lesson_bookings b
    WHERE b.tenant_id = ? AND b.session_id IN (?) AND b.status IN ('booked','attended','no_show')`, [tenantId, ids]);
  const items = await rows(pool, `SELECT i.session_id, i.person_id, i.unit_price_cents * i.quantity - i.discount_cents AS cents FROM order_items i
    WHERE i.tenant_id = ? AND i.session_id IN (?) AND i.refunded_at IS NULL`, [tenantId, ids]);
  const reqIds = [...new Set(bookings.filter((b) => b.request_id).map((b) => b.request_id))];
  const reqs = reqIds.length ? await rows(pool, `SELECT r.id, o.total_cents - o.tax_cents - o.refunded_cents AS cents, (SELECT COUNT(*) FROM lesson_bookings x WHERE x.tenant_id = r.tenant_id AND x.request_id = r.id) AS n
    FROM lesson_requests r JOIN orders o ON o.tenant_id = r.tenant_id AND o.id = r.order_id WHERE r.tenant_id = ? AND r.id IN (?) AND r.status = 'confirmed'`, [tenantId, reqIds]) : [];
  const creditIds = [...new Set(bookings.filter((b) => b.credit_id).map((b) => b.credit_id))];
  const credits = creditIds.length ? await rows(pool, `SELECT c.id, c.total, c.source, i.unit_price_cents * i.quantity - i.discount_cents AS cents FROM lesson_credits c
    LEFT JOIN order_items i ON i.tenant_id = c.tenant_id AND i.id = c.order_item_id WHERE c.tenant_id = ? AND c.id IN (?)`, [tenantId, creditIds]) : [];
  const itemOf = new Map(items.map((i) => [`${i.session_id}|${i.person_id}`, Math.max(0, Number(i.cents))]));
  const reqOf = new Map(reqs.map((r) => [r.id, Math.max(0, Math.round(Number(r.cents) / Math.max(1, Number(r.n))))]));
  const creditOf = new Map(credits.map((c) => [c.id, c.source === 'package' && c.cents ? Math.round(Number(c.cents) / Math.max(1, Number(c.total))) : 0]));
  const by = new Map(list.map((s) => [s.id, { ...s, students: 0, attended: 0, no_shows: 0, requested: 0, revenue_cents: 0, people: [] }]));
  for (const b of bookings) {
    const s = by.get(b.session_id);
    s.students += 1; s.people.push(b.person_id);
    if (b.status === 'attended') s.attended += 1;
    if (b.status === 'no_show') s.no_shows += 1;
    if (b.requested_instructor_id && b.requested_instructor_id === s.instructor_id) s.requested += 1;
    s.revenue_cents += b.credit_id ? creditOf.get(b.credit_id) || 0 : b.request_id ? reqOf.get(b.request_id) || 0 : itemOf.get(`${b.session_id}|${b.person_id}`) || 0;
  }
  return [...by.values()];
}

function groupFill(lessons, keyOf, labelOf) {
  const m = new Map();
  for (const s of lessons) {
    const k = keyOf(s);
    const x = m.get(k) || { key: k, label: labelOf(s), lessons: 0, seats: 0, students: 0, revenue_cents: 0 };
    x.lessons += 1; x.seats += Number(s.capacity); x.students += s.students; x.revenue_cents += s.revenue_cents;
    m.set(k, x);
  }
  return [...m.values()].map((x) => ({ ...x, fill_pct: pct(x.students, x.seats) })).sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

/** First lesson to return: students whose first ever lesson fell in the range, and how many came back within 30 and 60 days. */
async function returning(tenantId, from, to) {
  const firsts = await rows(pool, `SELECT b.person_id, MIN(s.starts_at) AS first_at FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id
    WHERE b.tenant_id = ? AND b.status IN ('booked','attended','no_show') AND s.status <> 'cancelled' GROUP BY b.person_id HAVING first_at >= ? AND first_at < ?`, [tenantId, `${from} 00:00:00`, `${addDays(to, 1)} 00:00:00`]);
  const byProduct = new Map();
  for (const f of firsts) {
    const first = await one(pool, `SELECT pr.name AS product FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
      WHERE b.tenant_id = ? AND b.person_id = ? AND s.starts_at = ? AND b.status IN ('booked','attended','no_show') LIMIT 1`, [tenantId, f.person_id, f.first_at]);
    const day = String(f.first_at).slice(0, 10);
    const next = await one(pool, `SELECT MIN(s.starts_at) AS at FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id
      WHERE b.tenant_id = ? AND b.person_id = ? AND b.status IN ('booked','attended','no_show') AND s.status <> 'cancelled' AND s.starts_at > ?`, [tenantId, f.person_id, f.first_at]);
    const prog = await one(pool, "SELECT MIN(created_at) AS at FROM program_enrollments WHERE tenant_id = ? AND person_id = ? AND status <> 'withdrawn' AND created_at > ?", [tenantId, f.person_id, f.first_at]);
    const dates = [next && next.at ? String(next.at).slice(0, 10) : null, prog && prog.at ? String(prog.at).slice(0, 10) : null].filter(Boolean).sort();
    const back = dates[0] || null;
    const k = first ? first.product : 'Lesson';
    const x = byProduct.get(k) || { product: k, first_timers: 0, back_30: 0, back_60: 0 };
    x.first_timers += 1;
    if (back && back <= addDays(day, 30)) x.back_30 += 1;
    if (back && back <= addDays(day, 60)) x.back_60 += 1;
    byProduct.set(k, x);
  }
  const list = [...byProduct.values()].map((x) => ({ ...x, back_30_pct: pct(x.back_30, x.first_timers), back_60_pct: pct(x.back_60, x.first_timers) }));
  const total = list.reduce((a, x) => ({ first_timers: a.first_timers + x.first_timers, back_30: a.back_30 + x.back_30, back_60: a.back_60 + x.back_60 }), { first_timers: 0, back_30: 0, back_60: 0 });
  return { by_product: list, total: { ...total, back_30_pct: pct(total.back_30, total.first_timers), back_60_pct: pct(total.back_60, total.first_timers) } };
}

async function report(tenantId, from, to) {
  const lessons = await lessonsIn(tenantId, from, to);
  const fill = {
    by_day: groupFill(lessons, (s) => String(s.starts_at).slice(0, 10), (s) => String(s.starts_at).slice(0, 10)),
    by_time: groupFill(lessons, (s) => hhmm(s.starts_at), (s) => hhmm(s.starts_at)),
    by_product: groupFill(lessons, (s) => s.product, (s) => s.product),
    by_level: groupFill(lessons, (s) => `${String(s.level_min || 0).padStart(2, '0')}-${String(s.level_max || 9).padStart(2, '0')}`, (s) => levels.range(s.level_min, s.level_max)),
  };
  const seats = lessons.reduce((n, s) => n + Number(s.capacity), 0);
  const students = lessons.reduce((n, s) => n + s.students, 0);
  const revenue = lessons.reduce((n, s) => n + s.revenue_cents, 0);
  const inst = new Map();
  for (const s of lessons) {
    const k = s.instructor_id || 0;
    const x = inst.get(k) || { staff_id: s.instructor_id, name: s.instructor || 'No instructor', lessons: 0, students: 0, revenue_cents: 0, privates: 0, requested: 0, no_shows: 0, tips: 0 };
    x.lessons += 1; x.students += s.students; x.revenue_cents += s.revenue_cents; x.no_shows += s.no_shows; x.requested += s.requested;
    if (s.format !== 'group') x.privates += 1;
    inst.set(k, x);
  }
  // Tips, counts only: never amounts here.
  let tipsPaid = 0;
  if (await tableHas('lesson_tips', 'status')) {
    const tips = await rows(pool, `SELECT t.staff_id, COUNT(*) AS n FROM lesson_tips t JOIN lesson_sessions s ON s.tenant_id = t.tenant_id AND s.id = t.session_id
      WHERE t.tenant_id = ? AND t.status = 'paid' AND s.starts_at >= ? AND s.starts_at < ? GROUP BY t.staff_id`, [tenantId, `${from} 00:00:00`, `${addDays(to, 1)} 00:00:00`]);
    for (const tp of tips) { tipsPaid += Number(tp.n); const x = inst.get(tp.staff_id); if (x) x.tips = Number(tp.n); }
  }
  // Recaps sent: the recap table belongs to the family side (Track PARENTS); counted when it is there.
  let recaps = null;
  for (const [table, col] of [['lesson_recaps', 'sent_at']]) {
    if (await tableHas(table, col)) {
      const r = await one(pool, `SELECT COUNT(*) AS n FROM ${table} r JOIN lesson_sessions s ON s.tenant_id = r.tenant_id AND s.id = r.session_id WHERE r.tenant_id = ? AND r.${col} IS NOT NULL AND s.starts_at >= ? AND s.starts_at < ?`,
        [tenantId, `${from} 00:00:00`, `${addDays(to, 1)} 00:00:00`]).catch(() => null);
      recaps = r ? Number(r.n) : null;
    }
  }
  const noShows = lessons.filter((s) => s.no_shows).map((s) => ({ session_id: s.id, starts_at: s.starts_at, product: s.product, no_shows: s.no_shows, students: s.students }));
  return {
    from, to,
    totals: { lessons: lessons.length, seats, students, fill_pct: pct(students, seats), revenue_cents: revenue, no_shows: lessons.reduce((n, s) => n + s.no_shows, 0), privates: lessons.filter((s) => s.format !== 'group').length, requested: lessons.reduce((n, s) => n + s.requested, 0), tips_paid: tipsPaid, recaps_sent: recaps },
    fill,
    per_lesson: lessons.map((s) => ({ session_id: s.id, starts_at: s.starts_at, product: s.product, level_words: levels.range(s.level_min, s.level_max), instructor: s.instructor, capacity: Number(s.capacity), students: s.students, no_shows: s.no_shows, revenue_cents: s.revenue_cents })),
    per_instructor: [...inst.values()].sort((a, b) => b.revenue_cents - a.revenue_cents),
    returning: await returning(tenantId, from, to),
    no_shows: noShows,
  };
}

/** One part of the report as CSV rows. */
function csvRows(r, part) {
  const d = (c) => (Number(c) / 100).toFixed(2);
  if (part === 'instructors') return { cols: ['instructor', 'lessons', 'students', 'revenue', 'privates', 'requested', 'no_shows', 'tips'], data: r.per_instructor.map((x) => ({ instructor: x.name, lessons: x.lessons, students: x.students, revenue: d(x.revenue_cents), privates: x.privates, requested: x.requested, no_shows: x.no_shows, tips: x.tips })) };
  if (part === 'returning') return { cols: ['product', 'first_timers', 'back_within_30_days', 'back_within_60_days', 'pct_30', 'pct_60'], data: r.returning.by_product.map((x) => ({ product: x.product, first_timers: x.first_timers, back_within_30_days: x.back_30, back_within_60_days: x.back_60, pct_30: x.back_30_pct, pct_60: x.back_60_pct })) };
  if (part.startsWith('fill_')) {
    const k = { fill_day: 'by_day', fill_time: 'by_time', fill_product: 'by_product', fill_level: 'by_level' }[part] || 'by_day';
    return { cols: ['group', 'lessons', 'seats', 'students', 'fill_pct', 'revenue'], data: r.fill[k].map((x) => ({ group: x.label, lessons: x.lessons, seats: x.seats, students: x.students, fill_pct: x.fill_pct, revenue: d(x.revenue_cents) })) };
  }
  return { cols: ['date', 'time', 'lesson', 'levels', 'instructor', 'seats', 'students', 'no_shows', 'revenue'], data: r.per_lesson.map((x) => ({ date: String(x.starts_at).slice(0, 10), time: hhmm(x.starts_at), lesson: x.product, levels: x.level_words, instructor: x.instructor || '', seats: x.capacity, students: x.students, no_shows: x.no_shows, revenue: d(x.revenue_cents) })) };
}

module.exports = { report, csvRows, lessonsIn, returning };
