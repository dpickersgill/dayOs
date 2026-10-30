'use strict';
// The season plan (2026.11.9, Track PLAN). A director describes the season once: up to 6 day types (Weekday, Weekend,
// Holiday, Holiday week, Closed), each with its lesson slots and private lesson hours; which day type each weekday uses;
// periods (a date range that uses one day type every day, such as Christmas week); and exceptions for single days (close
// a day, change its type, add a one-off slot, remove a slot). School holidays use the Holiday day type.
//
// expand() turns the plan into days. preview() compares those days with the lessons the plan already made and says what a
// publish would create, update, keep (booked, never changed) and remove. publish() does it in one transaction and records
// what it did so undo() can take it back while nothing in it is booked. Lessons made by a plan carry origin 'plan',
// plan_id and plan_slot (the slot's key), so a re-publish finds them again.
const { one, rows } = require('../db');
const { z, dateStr, addDays, weekdayOf, todayIn, nowIn } = require('./util');
const { bad, conflict, notFound } = require('./errors');
const LV = require('./levels');
const { allowedOn } = require('./saledays');
const { priceFrom } = require('./pricing');
const { staffProblems } = require('./workforce');
const { teachingStaff, clearanceGaps } = require('./school');
const settings = require('./schoolsettings');

const MAX_TYPES = 6;
const MAX_DAYS = 200;
const MAX_LESSONS = 2000;
const EARLIEST = '06:00';
const LATEST = '21:00';
const DISCIPLINES = ['ski', 'snowboard', 'telemark', 'adaptive'];
const FORMATS = ['group', 'semi_private', 'private'];
const MAX_SEATS = { pool: 200, group: 60, semi_private: 4, private: 6 };
const LENGTHS = [30, 45, 60, 90, 120, 180, 240, 360];
const COLORS = ['#2f6fb0', '#2e8b57', '#c0392b', '#b8860b', '#7f8c8d', '#8e44ad'];

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 09:30');
const key = z.string().trim().regex(/^[a-z0-9_-]{1,40}$/, 'A short key of letters and numbers');
const level = z.number().int().min(LV.MIN).max(LV.MAX).nullable().optional();
const age = z.number().int().min(0).max(99).nullable().optional();
const id = z.number().int().positive().nullable().optional();

const slotSchema = z.object({
  key: key.optional(),
  start: hhmm,
  end: hhmm,
  product_id: z.number().int().positive(),
  kind: z.enum(['pool', 'class']).default('pool'),
  format: z.enum(FORMATS).default('group'),
  discipline: z.enum(DISCIPLINES).default('ski'),
  level_min: level,
  level_max: level,
  age_min: age,
  age_max: age,
  spots: z.number().int().min(1).max(MAX_SEATS.pool),
  spots_mode: z.enum(['staff', 'fixed']).nullable().optional(),
  meeting_place: z.string().trim().max(120).nullable().optional(),
  cert: id,
  instructor_id: id,
}).superRefine((s, ctx) => {
  if (s.end <= s.start) ctx.addIssue({ code: 'custom', path: ['end'], message: 'The end time must be after the start' });
  if (s.level_min != null && s.level_max != null && s.level_min > s.level_max) ctx.addIssue({ code: 'custom', path: ['level_max'], message: 'The lowest level must not be above the highest' });
  if (s.age_min != null && s.age_max != null && s.age_min > s.age_max) ctx.addIssue({ code: 'custom', path: ['age_max'], message: 'The youngest age must not be above the oldest' });
  const most = s.kind === 'pool' ? MAX_SEATS.pool : MAX_SEATS[s.format];
  if (s.spots > most) ctx.addIssue({ code: 'custom', path: ['spots'], message: `A ${s.kind === 'pool' ? 'pool' : s.format.replace('_', ' ')} holds at most ${most} students` });
});

const privateSchema = z.object({
  start: hhmm,
  end: hhmm,
  at_once: z.number().int().min(1).max(200).nullable().optional(), // null: as many as instructors allow
  lengths: z.array(z.number().int().refine((n) => LENGTHS.includes(n), 'Pick lengths from the list')).min(1).max(8),
}).refine((p) => p.end > p.start, { message: 'Private hours must end after they start', path: ['end'] });

const dayTypeSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9_]{1,20}$/),
  name: z.string().trim().min(1, 'Name each day type').max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#7f8c8d'),
  closed: z.boolean().default(false),
  slots: z.array(slotSchema).max(60).default([]),
  private: privateSchema.nullable().optional(),
});

const docSchema = z.object({
  day_types: z.array(dayTypeSchema).min(1).max(MAX_TYPES, `At most ${MAX_TYPES} day types`),
  weekdays: z.array(z.string()).length(7),
  periods: z.array(z.object({ from: dateStr, to: dateStr, day_type: z.string(), name: z.string().trim().max(60).nullable().optional() })).max(60).default([]),
  exceptions: z.array(z.object({
    date: dateStr,
    day_type: z.string().nullable().optional(),
    add: z.array(slotSchema).max(20).default([]),
    remove: z.array(key).max(60).default([]),
  })).max(400).default([]),
}).superRefine((d, ctx) => {
  const keys = new Set();
  d.day_types.forEach((t, i) => { if (keys.has(t.key)) ctx.addIssue({ code: 'custom', path: ['day_types', i, 'key'], message: 'Two day types have the same key' }); keys.add(t.key); });
  const known = (k) => k == null || keys.has(k);
  d.weekdays.forEach((k, i) => { if (!known(k)) ctx.addIssue({ code: 'custom', path: ['weekdays', i], message: 'Pick a day type for each weekday' }); });
  d.periods.forEach((p, i) => {
    if (!known(p.day_type)) ctx.addIssue({ code: 'custom', path: ['periods', i, 'day_type'], message: 'Pick a day type for the period' });
    if (p.to < p.from) ctx.addIssue({ code: 'custom', path: ['periods', i, 'to'], message: 'A period must end on or after its first day' });
  });
  const dates = new Set();
  d.exceptions.forEach((x, i) => {
    if (!known(x.day_type)) ctx.addIssue({ code: 'custom', path: ['exceptions', i, 'day_type'], message: 'Pick a day type' });
    if (dates.has(x.date)) ctx.addIssue({ code: 'custom', path: ['exceptions', i, 'date'], message: 'One change per day' });
    dates.add(x.date);
  });
  const slotKeys = new Set();
  const all = [...d.day_types.flatMap((t) => t.slots), ...d.exceptions.flatMap((x) => x.add)];
  for (const s of all) {
    if (!s.key) continue;
    if (slotKeys.has(s.key)) ctx.addIssue({ code: 'custom', path: ['day_types'], message: `Two slots share the key ${s.key}` });
    slotKeys.add(s.key);
  }
});

const newKey = (prefix = 's') => `${prefix}${Math.random().toString(36).slice(2, 8)}`;

/** Validates a plan doc and gives every slot a short, stable key. Throws 400 with the problems. */
function parseDoc(raw) {
  const r = docSchema.safeParse(raw);
  if (!r.success) throw bad('The plan has a problem', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  const doc = r.data;
  const used = new Set();
  const fill = (s, prefix) => { if (!s.key) { let k; do k = newKey(prefix); while (used.has(k)); s.key = k; } used.add(s.key); return s; };
  for (const t of doc.day_types) for (const s of t.slots) if (s.key) used.add(s.key);
  for (const x of doc.exceptions) for (const s of x.add) if (s.key) used.add(s.key);
  for (const t of doc.day_types) t.slots = t.slots.map((s) => fill(s, 's'));
  for (const x of doc.exceptions) x.add = x.add.map((s) => fill(s, 'x'));
  doc.exceptions = doc.exceptions.filter((x) => x.day_type || x.add.length || x.remove.length).sort((a, b) => a.date.localeCompare(b.date));
  doc.periods.sort((a, b) => a.from.localeCompare(b.from));
  return doc;
}

/** A new plan: five day types with no slots yet, Monday to Friday Weekday, Saturday and Sunday Weekend. */
function defaults() {
  return {
    day_types: [
      { key: 'weekday', name: 'Weekday', color: COLORS[0], closed: false, slots: [], private: null },
      { key: 'weekend', name: 'Weekend', color: COLORS[1], closed: false, slots: [], private: null },
      { key: 'holiday', name: 'Holiday', color: COLORS[2], closed: false, slots: [], private: null },
      { key: 'holiday_week', name: 'Holiday week', color: COLORS[3], closed: false, slots: [], private: null },
      { key: 'closed', name: 'Closed', color: COLORS[4], closed: true, slots: [], private: null },
    ],
    weekdays: ['weekend', 'weekday', 'weekday', 'weekday', 'weekday', 'weekday', 'weekend'],
    periods: [],
    exceptions: [],
  };
}

/** Every date from..to (inclusive). */
function datesOf(from, to) {
  const out = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Each date's day type and slots. Order: the day's exception, then a period, then a school holiday (the Holiday day
 * type, key 'holiday'), then the weekday default. holidays: Map of date -> name.
 * -> [{ date, day_type, source, holiday, closed, slots, private, exception }]
 */
function expand(doc, from, to, holidays = new Map()) {
  const types = new Map(doc.day_types.map((t) => [t.key, t]));
  const exceptions = new Map(doc.exceptions.map((x) => [x.date, x]));
  const out = [];
  for (const date of datesOf(from, to)) {
    const x = exceptions.get(date);
    let typeKey = null; let source = 'weekday';
    if (x && x.day_type && types.has(x.day_type)) { typeKey = x.day_type; source = 'exception'; }
    if (!typeKey) {
      const p = [...doc.periods].reverse().find((q) => q.from <= date && q.to >= date && types.has(q.day_type));
      if (p) { typeKey = p.day_type; source = 'period'; }
    }
    if (!typeKey && holidays.has(date) && types.has('holiday')) { typeKey = 'holiday'; source = 'holiday'; }
    if (!typeKey) typeKey = doc.weekdays[weekdayOf(date)];
    const t = types.get(typeKey) || null;
    const closed = Boolean(t && t.closed);
    let slots = closed || !t ? [] : t.slots.slice();
    if (x && !closed) {
      const gone = new Set(x.remove);
      slots = slots.filter((s) => !gone.has(s.key)).concat(x.add);
    }
    slots.sort((a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key));
    out.push({ date, day_type: t ? t.key : null, day_name: t ? t.name : 'No day type', color: t ? t.color : null, source, holiday: holidays.get(date) || null,
      closed, slots, private: closed || !t ? null : t.private || null, exception: Boolean(x) });
  }
  return out;
}

/** The old age group words for an age range (as skischool.js does), so older screens and reports keep working. */
function ageGroupFor(min, max) {
  if (max != null && max <= 12) return 'kids';
  if (min != null && min >= 18) return 'adults';
  if (min != null && min >= 13 && max != null && max <= 17) return 'teens';
  return 'all';
}

/** The lesson row a slot makes on a date. Pools are group lessons with no level range unless one is set. */
function lessonRow(slot, date, planId, poolMode) {
  const pool = slot.kind === 'pool';
  const lmin = slot.level_min ?? null; const lmax = slot.level_max ?? null;
  const amin = slot.age_min ?? null; const amax = slot.age_max ?? null;
  const mode = slot.spots_mode || (pool ? poolMode : 'fixed');
  return {
    product_id: slot.product_id, discipline: slot.discipline, level_min: lmin, level_max: lmax, age_min: amin, age_max: amax,
    ability_level: LV.toLegacy(lmax || lmin) || 'beginner', age_group: ageGroupFor(amin, amax),
    format: pool ? 'group' : slot.format, meeting_place: slot.meeting_place || null,
    starts_at: `${date} ${slot.start}:00`, ends_at: `${date} ${slot.end}:00`,
    capacity: slot.spots, spots_cap: slot.spots, spots_mode: mode, kind: pool ? 'pool' : 'class',
    instructor_id: slot.instructor_id || null, required_certification_id: slot.cert || null, plan_id: planId, plan_slot: slot.key,
  };
}

// What a re-publish compares. capacity only for fixed spots: lib/lessonspots.js moves it for staff-following lessons.
const COMPARE = ['product_id', 'discipline', 'level_min', 'level_max', 'age_min', 'age_max', 'format', 'meeting_place', 'starts_at', 'ends_at', 'spots_cap', 'spots_mode', 'kind', 'required_certification_id'];
const FIELD_WORDS = { product_id: 'lesson product', discipline: 'discipline', level_min: 'levels', level_max: 'levels', age_min: 'ages', age_max: 'ages', format: 'type', meeting_place: 'meeting place',
  starts_at: 'time', ends_at: 'time', spots_cap: 'spots', capacity: 'spots', spots_mode: 'follows staff', kind: 'pool or set class', required_certification_id: 'certification', instructor_id: 'instructor' };
const same = (a, b) => (a == null ? null : String(a)) === (b == null ? null : String(b));
/** The fields of an existing lesson that differ from what the plan wants now. */
function differs(cur, want) {
  const out = COMPARE.filter((f) => !same(cur[f], want[f]));
  if (want.spots_mode === 'fixed' && !same(cur.capacity, want.capacity)) out.push('capacity');
  if (want.instructor_id && !same(cur.instructor_id, want.instructor_id)) out.push('instructor_id');
  return out;
}
const words = (fields) => [...new Set(fields.map((f) => FIELD_WORDS[f] || f))];

const clock = (t) => { const [hh, mm] = String(t).split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };
const dayText = require('./format').dayText;

/** Days in a list as words, the first few then "and 9 more". */
function daysWords(dates, most = 4) {
  const list = [...new Set(dates)].sort();
  const shown = list.slice(0, most).map(dayText).join('; ');
  return list.length > most ? `${shown}; and ${list.length - most} more` : shown;
}

/** Is a lesson product priced and on sale that day? No calendar blackout, sold on that weekday, a price above zero. */
function priceProblem(product, cal, tierPrices, date) {
  if (!product.active) return 'is not on sale';
  if (!allowedOn(product.sale_days, date)) return 'is not sold on that weekday';
  const p = priceFrom(product, cal, null, null);
  if (p.blackout) return 'is blacked out';
  if (!p.cents && !tierPrices.some((t) => t.price_cents > 0)) return 'has no price';
  return null;
}

/** A lesson's bookings, requests and waitlist: active ones block a change; any row at all blocks deleting it. */
const USE_SQL = `(SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status IN ('booked','attended','no_show')) AS booked,
  (SELECT COUNT(*) FROM lesson_requests r WHERE r.tenant_id = s.tenant_id AND r.session_id = s.id AND r.status IN ('pending','awaiting_payment')) AS asked,
  (SELECT COUNT(*) FROM lesson_waitlist w WHERE w.tenant_id = s.tenant_id AND w.session_id = s.id AND w.status IN ('waiting','offered')) AS waiting,
  ((SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id) + (SELECT COUNT(*) FROM lesson_requests r WHERE r.tenant_id = s.tenant_id AND r.session_id = s.id)
   + (SELECT COUNT(*) FROM lesson_waitlist w WHERE w.tenant_id = s.tenant_id AND w.session_id = s.id) + (SELECT COUNT(*) FROM order_items i WHERE i.tenant_id = s.tenant_id AND i.session_id = s.id)) AS refs`;
const inUse = (s) => Number(s.booked) + Number(s.asked) + Number(s.waiting) > 0;

async function tzOf(db, tenantId) { return (await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone; }

async function holidaysOf(db, tenantId, from, to) {
  return new Map((await rows(db, 'SELECT on_date, name FROM school_holidays WHERE tenant_id = ? AND on_date BETWEEN ? AND ?', [tenantId, from, to])).map((r) => [String(r.on_date).slice(0, 10), r.name]));
}

/** The plan's lessons from a day on (not cancelled), with how they are used. lock: FOR UPDATE inside a publish. */
async function planLessons(db, tenantId, planId, fromDate, { lock = false } = {}) {
  if (lock) await db.query("SELECT id FROM lesson_sessions WHERE tenant_id = ? AND plan_id = ? AND status <> 'cancelled' AND starts_at >= ? FOR UPDATE", [tenantId, planId, `${fromDate} 00:00:00`]);
  return rows(db, `SELECT s.*, ${USE_SQL} FROM lesson_sessions s WHERE s.tenant_id = ? AND s.plan_id = ? AND s.status <> 'cancelled' AND s.starts_at >= ? ORDER BY s.starts_at, s.id`,
    [tenantId, planId, `${fromDate} 00:00:00`]);
}

/**
 * What publishing the plan would do now. plan: the lesson_plans row (doc as text or object).
 * -> { from, to, days, create, update, keep, remove, private, assign_later, warnings, blocked, counts }
 * Days before today, and today's slots that already started, are left alone.
 */
async function preview(db, tenantId, plan, { lock = false } = {}) {
  const doc = typeof plan.doc === 'string' ? parseDoc(JSON.parse(plan.doc)) : parseDoc(plan.doc);
  const tz = await tzOf(db, tenantId);
  const today = todayIn(tz);
  const now = nowIn(tz);
  const planFrom = String(plan.from_on).slice(0, 10);
  const planTo = String(plan.to_on).slice(0, 10);
  const from = planFrom < today ? today : planFrom;
  const warnings = [];
  const warn = (code, text, extra = {}) => warnings.push({ code, text, ...extra });
  const span = Math.round((Date.parse(`${planTo}T00:00:00Z`) - Date.parse(`${planFrom}T00:00:00Z`)) / 86400000) + 1;
  let blocked = false;
  if (span > MAX_DAYS) { blocked = true; warn('range', `The plan covers ${span} days. A plan can cover at most ${MAX_DAYS} days; split the season into two plans.`, { block: true }); }
  if (planTo < today) { blocked = true; warn('past', 'Every day of this plan is in the past.', { block: true }); }
  const days = planTo < from || blocked ? [] : expand(doc, from, planTo, await holidaysOf(db, tenantId, from, planTo));
  if (planFrom < today && planTo >= today) warn('past', `Days before today (${dayText(today)}) are left as they are.`);

  const s = await settings.get(db, tenantId);
  const productIds = [...new Set(days.flatMap((d) => d.slots.map((x) => x.product_id)))];
  const products = new Map(productIds.length ? (await rows(db, 'SELECT id, name, kind, uses, active, sale_days, base_price_cents FROM products WHERE tenant_id = ? AND id IN (?)', [tenantId, productIds])).map((p) => [p.id, p]) : []);
  const cal = productIds.length && days.length ? await rows(db, 'SELECT product_id, on_date, tier, price_cents, blackout FROM price_calendar WHERE tenant_id = ? AND product_id IN (?) AND on_date BETWEEN ? AND ?', [tenantId, productIds, from, planTo]) : [];
  const tiers = productIds.length ? await rows(db, 'SELECT product_id, tier, price_cents FROM price_tiers WHERE tenant_id = ? AND product_id IN (?)', [tenantId, productIds]) : [];
  const staff = new Map((await teachingStaff(db, tenantId)).map((m) => [m.id, m]));

  // Slots that cannot be made (no such lesson product) are left out and listed once each.
  const badSlot = new Map();
  const priceGaps = new Map(); // product id -> { problem -> dates }
  const odd = new Map(); // slot key -> slot, for times outside 6 AM to 9 PM
  const wanted = [];
  for (const d of days) {
    for (const slot of d.slots) {
      const p = products.get(slot.product_id);
      if (!p || p.kind !== 'lesson' || (p.uses && p.uses > 1)) {
        const why = !p ? 'is not a product of this mountain' : p.kind !== 'lesson' ? `${p.name} is not a lesson product` : `${p.name} is a lesson package, not a single lesson`;
        if (!badSlot.has(slot.key)) badSlot.set(slot.key, { slot, why, dates: [] });
        badSlot.get(slot.key).dates.push(d.date);
        continue;
      }
      if (`${d.date} ${slot.start}:00` <= now) continue; // already started today
      if (slot.start < EARLIEST || slot.end > LATEST) odd.set(slot.key, slot);
      const problem = priceProblem(p, cal.filter((c) => c.product_id === p.id && String(c.on_date).slice(0, 10) === d.date), tiers.filter((t) => t.product_id === p.id), d.date);
      if (problem) {
        if (!priceGaps.has(p.id)) priceGaps.set(p.id, new Map());
        const m = priceGaps.get(p.id);
        if (!m.has(problem)) m.set(problem, []);
        m.get(problem).push(d.date);
      }
      wanted.push({ date: d.date, slot, product: p.name, row: lessonRow(slot, d.date, plan.id, s.pool_spots_mode) });
    }
  }
  for (const { slot, why, dates } of badSlot.values()) warn('product', `${clock(slot.start)} slot: ${why}. It is left out on ${dates.length === 1 ? dayText(dates[0]) : `${dates.length} days`}.`, { block: false });
  for (const [pid, m] of priceGaps) for (const [problem, dates] of m) warn('price', `${products.get(pid).name} ${problem} on ${dates.length === 1 ? 'one day' : `${dates.length} days`}: ${daysWords(dates)}. Guests cannot buy it those days until it has a price.`, { dates: [...new Set(dates)] });
  for (const slot of odd.values()) warn('time', `A slot runs ${clock(slot.start)} to ${clock(slot.end)}, outside 6:00 AM to 9:00 PM. Check the time.`);
  if (wanted.length > MAX_LESSONS) { blocked = true; warn('size', `That would be ${wanted.length.toLocaleString('en-US')} lessons. A plan makes at most ${MAX_LESSONS.toLocaleString('en-US')}; shorten the dates or split the season into two plans.`, { block: true }); }

  // Match what the plan wants with the lessons it already made: by slot key first, then the same time and product.
  const existing = blocked ? [] : await planLessons(db, tenantId, plan.id, from, { lock });
  const byDay = new Map();
  for (const e of existing) { const k = String(e.starts_at).slice(0, 10); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(e); }
  const create = []; const update = []; const keep = []; const taken = new Set();
  const matchFor = (w) => {
    const list = (byDay.get(w.date) || []).filter((e) => !taken.has(e.id));
    return list.find((e) => e.plan_slot === w.slot.key)
      || list.find((e) => String(e.starts_at).slice(11, 16) === w.slot.start && e.product_id === w.row.product_id && e.discipline === w.row.discipline);
  };
  const assignLater = [];
  const busyBy = []; // instructors this plan already gives a lesson, so two slots do not share one person
  for (const w of blocked ? [] : wanted) {
    const e = matchFor(w);
    if (e) taken.add(e.id);
    if (e && String(e.starts_at) <= now) continue;
    // A named instructor who is busy, not cleared or not free that day: the lesson is made with "Assign later".
    if (w.row.instructor_id && !(e && inUse(e))) {
      const m = staff.get(w.row.instructor_id);
      let problems = m ? clearanceGaps(m, w.row) : ['Not an instructor'];
      if (!problems.length) problems = await staffProblems(db, tenantId, { staffId: w.row.instructor_id, certificationIds: w.row.required_certification_id ? [w.row.required_certification_id] : [], startsAt: w.row.starts_at, endsAt: w.row.ends_at, ignoreLessonId: e ? e.id : null });
      if (!problems.length && busyBy.some((b) => b.id === w.row.instructor_id && b.s < w.row.ends_at && b.e > w.row.starts_at)) problems = ['Named on another slot of this plan at that time'];
      if (problems.length) {
        assignLater.push({ date: w.date, start: w.slot.start, product: w.product, instructor_id: w.row.instructor_id, instructor: m ? `${m.first_name} ${m.last_name}` : 'Unknown', problem: problems[0] });
        w.row.instructor_id = null;
      } else busyBy.push({ id: w.row.instructor_id, s: w.row.starts_at, e: w.row.ends_at });
    }
    if (!e) { create.push(w); continue; }
    const diff = differs(e, w.row);
    if (e.plan_slot !== w.slot.key) diff.push('plan_slot');
    if (!diff.length) continue;
    if (inUse(e)) {
      const shown = words(diff.filter((f) => f !== 'plan_slot'));
      if (shown.length) keep.push({ id: e.id, date: w.date, start: String(e.starts_at).slice(11, 16), product: w.product, booked: Number(e.booked), asked: Number(e.asked), waiting: Number(e.waiting), differs: shown });
      continue;
    }
    update.push({ id: e.id, date: w.date, product: w.product, before: e, row: w.row, differs: words(diff.filter((f) => f !== 'plan_slot')) });
  }
  const remove = existing.filter((e) => !taken.has(e.id) && String(e.starts_at) > now).map((e) => ({ id: e.id, date: String(e.starts_at).slice(0, 10), start: String(e.starts_at).slice(11, 16), product_id: e.product_id, booked: Number(e.booked), asked: Number(e.asked), waiting: Number(e.waiting), in_use: inUse(e), refs: Number(e.refs), before: e }));
  if (assignLater.length) warn('instructor', `${assignLater.length === 1 ? 'One lesson is' : `${assignLater.length} lessons are`} made with "Assign later" because the named instructor cannot teach it that day. See the list below.`);

  const privateDays = days.filter((d) => d.private || d.closed).map((d) => ({ date: d.date, closed: d.closed, private: d.private }));
  const createSpots = create.reduce((n, w) => n + w.row.spots_cap, 0);
  const counts = {
    create: create.length, create_spots: createSpots, create_days: new Set(create.map((w) => w.date)).size,
    update: update.length, keep: keep.length, remove: remove.filter((r) => !r.in_use).length, remove_booked: remove.filter((r) => r.in_use).length,
    days: days.length, private_days: privateDays.length,
  };
  return { plan_id: plan.id, from, to: planTo, today, doc, days, create, update, keep, remove, private: privateDays, assign_later: assignLater, warnings, blocked, counts };
}

/** "Adds 186 lessons, 1,240 spots across 27 days; updates 4; keeps 12 with bookings" */
function summaryWords(c) {
  const n = (k) => Number(k).toLocaleString('en-US');
  const parts = [c.create ? `Adds ${n(c.create)} ${c.create === 1 ? 'lesson' : 'lessons'}, ${n(c.create_spots)} spots across ${n(c.create_days)} ${c.create_days === 1 ? 'day' : 'days'}` : 'Adds no lessons'];
  if (c.update) parts.push(`updates ${n(c.update)}`);
  if (c.keep) parts.push(`keeps ${n(c.keep)} with bookings`);
  if (c.removed !== undefined ? c.removed : c.remove) parts.push(`removes ${n(c.removed !== undefined ? c.removed : c.remove)}`);
  return parts.join('; ');
}

/** The preview as the screen needs it (no raw rows). */
function shape(p) {
  const byDate = new Map();
  for (const w of p.create) { const d = byDate.get(w.date) || { date: w.date, create: 0, spots: 0 }; d.create += 1; d.spots += w.row.spots_cap; byDate.set(w.date, d); }
  return {
    plan_id: p.plan_id, from: p.from, to: p.to, blocked: p.blocked, counts: p.counts, words: summaryWords(p.counts), warnings: p.warnings,
    create_by_day: [...byDate.values()],
    update: p.update.map((u) => ({ id: u.id, date: u.date, start: String(u.row.starts_at).slice(11, 16), product: u.product, differs: u.differs })),
    keep: p.keep,
    remove: p.remove.map(({ before, ...r }) => r),
    assign_later: p.assign_later,
  };
}

const INSERT_COLS = ['product_id', 'discipline', 'ability_level', 'level_min', 'level_max', 'age_min', 'age_max', 'format', 'age_group', 'meeting_place', 'starts_at', 'ends_at', 'capacity', 'instructor_id', 'required_certification_id', 'plan_id', 'plan_slot', 'kind', 'spots_mode', 'spots_cap'];
const UPDATE_COLS = ['product_id', 'discipline', 'ability_level', 'level_min', 'level_max', 'age_min', 'age_max', 'format', 'age_group', 'meeting_place', 'starts_at', 'ends_at', 'capacity', 'required_certification_id', 'plan_slot', 'kind', 'spots_mode', 'spots_cap'];
// What undo puts back on a lesson the publish changed or removed.
const RESTORE_COLS = [...UPDATE_COLS, 'instructor_id', 'status', 'notes', 'plan_id', 'origin', 'copy_id', 'lineup_id'];

/**
 * Publishes the plan in one transaction (conn is a transaction connection). opts.remove: also remove unbooked lessons
 * this plan made that are no longer in it. -> { publish_id, counts, words, kept, assign_later, session_ids }
 */
async function publish(conn, tenantId, planId, { remove = false, userId = null } = {}) {
  const plan = await one(conn, 'SELECT * FROM lesson_plans WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, planId]);
  if (!plan) throw notFound('Plan');
  const p = await preview(conn, tenantId, plan, { lock: true });
  if (p.blocked) throw conflict(p.warnings.filter((w) => w.block).map((w) => w.text).join(' '));
  const created = []; const before = []; const touched = [];
  for (const w of p.create) {
    const r = w.row;
    const [ins] = await conn.query(`INSERT INTO lesson_sessions (tenant_id, ${INSERT_COLS.join(', ')}, origin) VALUES (?, ${INSERT_COLS.map(() => '?').join(', ')}, 'plan')`, [tenantId, ...INSERT_COLS.map((c) => r[c] ?? null)]);
    created.push(ins.insertId);
  }
  for (const u of p.update) {
    const r = { ...u.row };
    // Spots that follow staff keep the number lib/lessonspots.js set while the cap is the same.
    if (r.spots_mode === 'staff' && u.before.spots_mode === 'staff' && Number(u.before.spots_cap) === r.spots_cap) r.capacity = u.before.capacity;
    const sets = UPDATE_COLS.map((c) => `${c} = ?`);
    const vals = UPDATE_COLS.map((c) => r[c] ?? null);
    if (r.instructor_id) { sets.push('instructor_id = ?'); vals.push(r.instructor_id); }
    await conn.query(`UPDATE lesson_sessions SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, tenantId, u.id]);
    before.push({ id: u.id, how: 'updated', row: pick(u.before, RESTORE_COLS) });
    touched.push(u.id);
  }
  let removed = 0;
  if (remove) {
    for (const r of p.remove) {
      if (r.in_use) continue;
      if (r.refs) await conn.query("UPDATE lesson_sessions SET status = 'cancelled' WHERE tenant_id = ? AND id = ?", [tenantId, r.id]);
      else await conn.query('DELETE FROM lesson_sessions WHERE tenant_id = ? AND id = ?', [tenantId, r.id]);
      before.push({ id: r.id, how: r.refs ? 'cancelled' : 'deleted', row: pick(r.before, ['id', 'tenant_id', ...RESTORE_COLS, 'ability_level', 'age_group', 'capacity']) });
      removed += 1;
    }
  }
  // Private lesson hours for every day of the plan from today: closed days are closed, a day type with no hours has no row.
  const privateBefore = await rows(conn, 'SELECT on_date, start_time, end_time, at_once, lengths, closed, plan_id FROM lesson_private_hours WHERE tenant_id = ? AND on_date BETWEEN ? AND ? FOR UPDATE', [tenantId, p.from, p.to]);
  const wantPrivate = new Map(p.private.map((d) => [d.date, d]));
  for (const r of privateBefore) {
    const date = String(r.on_date).slice(0, 10);
    if (!wantPrivate.has(date) && Number(r.plan_id) === Number(planId)) await conn.query('DELETE FROM lesson_private_hours WHERE tenant_id = ? AND on_date = ?', [tenantId, date]);
  }
  for (const d of p.private) {
    const pr = d.private || { start: '00:00', end: '00:01', at_once: null, lengths: [60] };
    await conn.query(`INSERT INTO lesson_private_hours (tenant_id, on_date, start_time, end_time, at_once, lengths, closed, plan_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE start_time = VALUES(start_time), end_time = VALUES(end_time), at_once = VALUES(at_once), lengths = VALUES(lengths), closed = VALUES(closed), plan_id = VALUES(plan_id)`,
    [tenantId, d.date, `${pr.start}:00`, `${pr.end}:00`, pr.at_once ?? null, pr.lengths.join(','), d.closed ? 1 : 0, planId]);
  }
  const counts = { ...p.counts, removed };
  const text = summaryWords(counts);
  const [pub] = await conn.query(`INSERT INTO lesson_plan_publishes (tenant_id, plan_id, created_n, updated_n, removed_n, kept_n, created_ids, before_rows, private_before, summary, doc_sha, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [tenantId, planId, created.length, p.update.length, removed, p.keep.length, JSON.stringify(created), JSON.stringify(before),
    JSON.stringify({ from: p.from, to: p.to, rows: privateBefore }), text.slice(0, 400), shaOf(p.doc), userId]);
  await conn.query("UPDATE lesson_plans SET status = 'published', published_at = UTC_TIMESTAMP(), published_by = ?, doc = ? WHERE tenant_id = ? AND id = ?", [userId, JSON.stringify(p.doc), tenantId, planId]);
  await require('./lessonspots').sync(conn, tenantId, { sessionIds: [...created, ...touched] });
  return { publish_id: pub.insertId, counts, words: text, kept: p.keep, assign_later: p.assign_later, session_ids: [...created, ...touched] };
}

/** A fingerprint of a plan doc, to tell whether the plan changed since it was published. */
const shaOf = (doc) => require('crypto').createHash('sha256').update(JSON.stringify(doc)).digest('hex');

const pick = (o, cols) => Object.fromEntries(cols.filter((c) => c in o).map((c) => [c, o[c]]));

/**
 * Undoes one publish (the plan's latest that is not undone). Lessons it made that are still not booked are removed;
 * lessons it changed or removed are put back while nothing is booked on them; the rest are listed and kept.
 */
async function undo(conn, tenantId, publishId, userId = null) {
  const pub = await one(conn, 'SELECT * FROM lesson_plan_publishes WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, publishId]);
  if (!pub) throw notFound('Publish');
  if (pub.undone_at) throw conflict('That publish was already undone');
  await one(conn, 'SELECT id FROM lesson_plans WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, pub.plan_id]);
  const later = await one(conn, 'SELECT id FROM lesson_plan_publishes WHERE tenant_id = ? AND plan_id = ? AND id > ? AND undone_at IS NULL LIMIT 1', [tenantId, pub.plan_id, publishId]);
  if (later) throw conflict('Undo the later publish first. Only the most recent publish can be undone.');
  const kept = []; let removed = 0; let restored = 0; const synced = [];
  const ids = JSON.parse(pub.created_ids || '[]');
  if (ids.length) {
    await conn.query('SELECT id FROM lesson_sessions WHERE tenant_id = ? AND id IN (?) FOR UPDATE', [tenantId, ids]);
    const list = await rows(conn, `SELECT s.id, s.starts_at, s.status, pr.name AS product, ${USE_SQL} FROM lesson_sessions s JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id WHERE s.tenant_id = ? AND s.id IN (?)`, [tenantId, ids]);
    for (const s of list) {
      if (inUse(s)) { kept.push({ id: s.id, starts_at: s.starts_at, product: s.product, booked: Number(s.booked) }); continue; }
      if (Number(s.refs)) await conn.query("UPDATE lesson_sessions SET status = 'cancelled' WHERE tenant_id = ? AND id = ?", [tenantId, s.id]);
      else await conn.query('DELETE FROM lesson_sessions WHERE tenant_id = ? AND id = ?', [tenantId, s.id]);
      removed += 1;
    }
  }
  for (const b of JSON.parse(pub.before_rows || '[]')) {
    const cur = await one(conn, `SELECT s.id, s.starts_at, s.status, ${USE_SQL} FROM lesson_sessions s WHERE s.tenant_id = ? AND s.id = ? FOR UPDATE`, [tenantId, b.id]);
    if (cur && inUse(cur)) { kept.push({ id: b.id, starts_at: cur.starts_at, product: null, booked: Number(cur.booked) }); continue; }
    if (b.how === 'deleted' && !cur) {
      const cols = Object.keys(b.row);
      await conn.query(`INSERT INTO lesson_sessions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => b.row[c]));
    } else if (cur) {
      const cols = RESTORE_COLS.filter((c) => c in b.row);
      await conn.query(`UPDATE lesson_sessions SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...cols.map((c) => b.row[c]), tenantId, b.id]);
    } else continue;
    restored += 1; synced.push(b.id);
  }
  // The private hours go back to what they were before this publish.
  const pb = JSON.parse(pub.private_before || 'null');
  if (pb) {
    await conn.query('DELETE FROM lesson_private_hours WHERE tenant_id = ? AND on_date BETWEEN ? AND ? AND plan_id = ?', [tenantId, pb.from, pb.to, pub.plan_id]);
    for (const r of pb.rows) {
      await conn.query(`INSERT INTO lesson_private_hours (tenant_id, on_date, start_time, end_time, at_once, lengths, closed, plan_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE start_time = VALUES(start_time), end_time = VALUES(end_time), at_once = VALUES(at_once), lengths = VALUES(lengths), closed = VALUES(closed), plan_id = VALUES(plan_id)`,
      [tenantId, String(r.on_date).slice(0, 10), r.start_time, r.end_time, r.at_once, r.lengths, r.closed, r.plan_id]);
    }
  }
  await conn.query('UPDATE lesson_plan_publishes SET undone_at = UTC_TIMESTAMP(), undone_by = ? WHERE tenant_id = ? AND id = ?', [userId, tenantId, publishId]);
  const left = await one(conn, 'SELECT COUNT(*) AS n FROM lesson_plan_publishes WHERE tenant_id = ? AND plan_id = ? AND undone_at IS NULL', [tenantId, pub.plan_id]);
  if (!Number(left.n)) await conn.query("UPDATE lesson_plans SET status = 'draft' WHERE tenant_id = ? AND id = ?", [tenantId, pub.plan_id]);
  if (synced.length) await require('./lessonspots').sync(conn, tenantId, { sessionIds: synced });
  return { plan_id: pub.plan_id, removed, restored, kept };
}

/**
 * The plan's days for one month (YYYY-MM), for the calendar: each day's type, slots and the lessons this plan made on it.
 * -> [{ date, day_type, day_name, color, source, holiday, closed, exception, slots, private, lessons: [ids], booked }]
 */
async function calendar(db, tenantId, plan, month) {
  const doc = typeof plan.doc === 'string' ? JSON.parse(plan.doc) : plan.doc;
  const first = `${month}-01`;
  const last = addDays(addDays(first, 31).slice(0, 8) + '01', -1);
  const from = String(plan.from_on).slice(0, 10) > first ? String(plan.from_on).slice(0, 10) : first;
  const to = String(plan.to_on).slice(0, 10) < last ? String(plan.to_on).slice(0, 10) : last;
  if (to < from) return [];
  const days = expand(parseDoc(doc), from, to, await holidaysOf(db, tenantId, from, to));
  const lessons = await rows(db, `SELECT s.id, s.starts_at, s.plan_slot, (SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status IN ('booked','attended')) AS booked
    FROM lesson_sessions s WHERE s.tenant_id = ? AND s.plan_id = ? AND s.status <> 'cancelled' AND s.starts_at >= ? AND s.starts_at < ? ORDER BY s.starts_at`, [tenantId, plan.id, `${from} 00:00:00`, `${addDays(to, 1)} 00:00:00`]);
  const names = new Map((await rows(db, "SELECT id, name FROM products WHERE tenant_id = ? AND kind = 'lesson'", [tenantId])).map((p) => [p.id, p.name]));
  return days.map((d) => {
    const mine = lessons.filter((l) => String(l.starts_at).slice(0, 10) === d.date);
    return { ...d, slots: d.slots.map((s) => ({ ...s, product: names.get(s.product_id) || 'Unknown product' })), lessons: mine.map((l) => l.id), booked: mine.reduce((n, l) => n + Number(l.booked), 0) };
  });
}

/** A day template (lesson_day_templates) as slot rows for a day type: group lessons with no level range become pools. */
async function templateSlots(db, tenantId, templateId, poolMode) {
  const t = await one(db, 'SELECT * FROM lesson_day_templates WHERE tenant_id = ? AND id = ?', [tenantId, templateId]);
  if (!t) throw notFound('Template');
  return JSON.parse(t.lessons).map((l) => {
    const pool = (l.format || 'group') === 'group' && l.level_min == null && l.level_max == null;
    return { key: newKey('s'), start: l.start, end: l.end, product_id: l.product_id, kind: pool ? 'pool' : 'class', format: l.format || 'group', discipline: l.discipline || 'ski',
      level_min: l.level_min ?? null, level_max: l.level_max ?? null, age_min: l.age_min ?? null, age_max: l.age_max ?? null,
      spots: Math.min(Number(l.capacity) || 6, pool ? MAX_SEATS.pool : MAX_SEATS[l.format || 'group']), spots_mode: pool ? poolMode : 'fixed',
      meeting_place: l.meeting_place || null, cert: l.required_certification_id || null, instructor_id: l.instructor_id || null };
  });
}

module.exports = { MAX_TYPES, MAX_DAYS, MAX_LESSONS, LENGTHS, COLORS, docSchema, slotSchema, parseDoc, defaults, expand, preview, shape, publish, undo, calendar, templateSlots, summaryWords, lessonRow, newKey, shaOf };
