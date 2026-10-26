'use strict';

// Program sessions: a program (After-School Ski & Ride) runs as sessions through the season (Session 1, Session 2).
// A session meets once a week for a number of weeks, on one or more weekdays; each weekday is its own group with its own
// spots, and the parent picks the day. After the regular weeks come makeup weeks, held in reserve ("standby"): when a
// day's meeting is canceled for weather, that group's first standby date becomes a real lesson.
//
// Prices: the session price, or a day's own price, with optional price steps by date (early bird, regular, late), and an
// optional sibling discount on the second and later child in the same program. Bundles sell several sessions at once.
// A program can include a lift ticket (issued for the session's dates) and a rental (shown on the roster for the shop).

const { rows, one } = require('../db');
const { conflict, bad, notFound } = require('./errors');
const { addDays, newCode } = require('./util');
const mailer = require('./mailer');

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dstr = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const tstr = (t) => String(t || '').slice(0, 5);
const clock12 = (t) => { const [hh, mm] = tstr(t).split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'am' : 'pm'}`; };
const weekdayOf = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
const parseJson = (s, fallback) => { if (!s) return fallback; if (typeof s !== 'string') return s; try { return JSON.parse(s); } catch (_) { return fallback; } };

/**
 * The dates one weekday group meets: the regular weeks, then the makeup weeks. A skipped date (a holiday, a school
 * break) is not a lesson; the run carries on the next week, so a group always gets its full number of weeks.
 */
function meetingDates({ starts_on: startsOn, weeks, makeup_weeks: makeup, skip_dates: skipRaw }, weekday) {
  const skip = new Set(parseJson(skipRaw, []).map(dstr));
  let d = dstr(startsOn);
  while (weekdayOf(d) !== Number(weekday)) d = addDays(d, 1);
  const out = [];
  let guard = 0;
  while (out.length < Number(weeks) + Number(makeup || 0) && guard < 200) {
    if (!skip.has(d)) out.push({ date: d, kind: out.length < Number(weeks) ? 'regular' : 'makeup' });
    d = addDays(d, 7); guard += 1;
  }
  return out;
}

/** Creates a group's meetings: regular weeks scheduled, makeup weeks on standby. */
async function buildMeetings(conn, tenantId, term, group) {
  const start = tstr(group.start_time || term.start_time); const end = tstr(group.end_time || term.end_time);
  for (const m of meetingDates(term, group.weekday)) {
    await conn.query("INSERT INTO program_sessions (tenant_id, program_id, term_id, group_id, starts_at, ends_at, kind, status, coach_staff_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [tenantId, term.program_id, term.id, group.id, `${m.date} ${start}:00`, `${m.date} ${end}:00`, m.kind, m.kind === 'makeup' ? 'standby' : 'scheduled', group.coach_staff_id || null]);
  }
}

/**
 * The price for a place on one day of a session, on a given date: the day's own price or the session's, unless a price
 * step is still running (the first step whose last day has not passed). Returns { cents, label, until, next }.
 */
function priceNow(term, group, today) {
  const base = group && group.price_cents != null ? Number(group.price_cents) : Number(term.price_cents);
  const steps = parseJson(term.price_steps, []).filter((s) => s && s.until && Number.isFinite(Number(s.price_cents)))
    .sort((a, b) => (a.until < b.until ? -1 : 1));
  const step = steps.find((s) => dstr(s.until) >= today);
  if (!step) return { cents: base, label: null, until: null };
  // A day with its own price keeps the same gap to the session price during a step.
  const shift = group && group.price_cents != null ? Number(group.price_cents) - Number(term.price_cents) : 0;
  return { cents: Math.max(0, Number(step.price_cents) + shift), label: step.label || 'Early bird', until: dstr(step.until), regular_cents: base };
}

/** The sibling discount on one line: nothing for the first child in a program, the program's discount for the rest. */
function siblingOff(program, unitCents, childIndex) {
  if (!childIndex || program.sibling_mode === 'none' || !program.sibling_value) return 0;
  if (program.sibling_mode === 'percent') return Math.round((unitCents * Math.min(100, Number(program.sibling_value))) / 100);
  return Math.min(unitCents, Number(program.sibling_value));
}

/** Places taken per group (enrolled only; the waitlist does not take a place). */
async function takenByGroup(conn, tenantId, groupIds) {
  if (!groupIds.length) return new Map();
  const r = await rows(conn, "SELECT group_id, SUM(status = 'enrolled') AS enrolled, SUM(status = 'waitlist') AS waiting FROM program_enrollments WHERE tenant_id = ? AND group_id IN (?) GROUP BY group_id", [tenantId, groupIds]);
  return new Map(r.map((x) => [Number(x.group_id), { enrolled: Number(x.enrolled || 0), waiting: Number(x.waiting || 0) }]));
}

/** A session with its days, each with its meetings, places taken and today's price. */
async function termDetail(conn, tenantId, termId, today) {
  const term = await one(conn, 'SELECT * FROM program_terms WHERE tenant_id = ? AND id = ?', [tenantId, termId]);
  if (!term) throw notFound('Session');
  const groups = await rows(conn, 'SELECT * FROM program_groups WHERE tenant_id = ? AND term_id = ? ORDER BY weekday', [tenantId, termId]);
  const ids = groups.map((g) => g.id);
  const [meetings, taken, levels] = await Promise.all([
    ids.length ? rows(conn, 'SELECT id, group_id, starts_at, ends_at, kind, status, cancel_reason FROM program_sessions WHERE tenant_id = ? AND group_id IN (?) ORDER BY starts_at', [tenantId, ids]) : [],
    takenByGroup(conn, tenantId, ids),
    ids.length ? rows(conn, 'SELECT id, group_id, name, coach_staff_id, sort FROM program_levels WHERE tenant_id = ? AND group_id IN (?) ORDER BY sort, id', [tenantId, ids]) : [],
  ]);
  return {
    ...shapeTerm(term),
    groups: groups.map((g) => {
      const t = taken.get(g.id) || { enrolled: 0, waiting: 0 };
      const price = priceNow(term, g, today);
      return {
        id: g.id, weekday: g.weekday, day: WEEKDAYS[g.weekday], discipline: g.discipline || 'any', start_time: tstr(g.start_time || term.start_time), end_time: tstr(g.end_time || term.end_time),
        capacity: g.capacity, price_cents: g.price_cents, coach_staff_id: g.coach_staff_id, enrolled: t.enrolled, waiting: t.waiting,
        left: g.capacity == null ? null : Math.max(0, g.capacity - t.enrolled), price_now: price,
        meetings: meetings.filter((m) => m.group_id === g.id).map((m) => ({ ...m, date: dstr(m.starts_at) })),
        levels: levels.filter((l) => l.group_id === g.id),
      };
    }),
  };
}

function shapeTerm(t) {
  return {
    id: t.id, program_id: t.program_id, name: t.name, starts_on: dstr(t.starts_on), weeks: t.weeks, makeup_weeks: t.makeup_weeks,
    start_time: tstr(t.start_time), end_time: tstr(t.end_time), price_cents: t.price_cents, price_steps: parseJson(t.price_steps, []),
    skip_dates: parseJson(t.skip_dates, []), reg_opens_on: t.reg_opens_on ? dstr(t.reg_opens_on) : null, reg_closes_on: t.reg_closes_on ? dstr(t.reg_closes_on) : null, status: t.status,
  };
}

/** Is online registration open for this session today? */
function regOpen(term, today) {
  if (term.status !== 'open') return false;
  if (term.reg_opens_on && dstr(term.reg_opens_on) > today) return false;
  if (term.reg_closes_on && dstr(term.reg_closes_on) < today) return false;
  return true;
}

/**
 * Puts a person in one day of a session. A full day puts them on that day's waitlist (or throws when `mustFit`, as a paid
 * sale must). One place per person per session.
 */
async function enroll(conn, tenantId, { program, term, group, personId, guardianId = null, priceCents = 0, discountCents = 0, paidCents = 0, bundleId = null, orderId = null, anyDay = false, mustFit = false, details = null }) {
  await conn.query('SELECT id FROM program_groups WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, group.id]);
  const existing = await one(conn, 'SELECT id, status, group_id FROM program_enrollments WHERE tenant_id = ? AND program_id = ? AND term_key = ? AND person_id = ?', [tenantId, program.id, term.id, personId]);
  if (existing && existing.status !== 'withdrawn') throw conflict(`Already ${existing.status === 'waitlist' ? 'on the waitlist' : 'enrolled'} in ${term.name}`);
  const { n } = await one(conn, "SELECT COUNT(*) AS n FROM program_enrollments WHERE tenant_id = ? AND group_id = ? AND status = 'enrolled'", [tenantId, group.id]);
  const full = group.capacity != null && Number(n) >= group.capacity;
  if (full && mustFit) throw conflict(`${WEEKDAYS[group.weekday]}s in ${term.name} are full`);
  const status = full ? 'waitlist' : 'enrolled';
  const vals = [status, guardianId, term.id, group.id, bundleId, anyDay ? 1 : 0, priceCents, discountCents, paidCents, orderId];
  let id;
  if (existing) {
    await conn.query('UPDATE program_enrollments SET status = ?, guardian_id = ?, term_id = ?, group_id = ?, bundle_id = ?, any_day = ?, price_cents = ?, discount_cents = ?, paid_cents = ?, order_id = ?, level_id = NULL, created_at = NOW() WHERE tenant_id = ? AND id = ?', [...vals, tenantId, existing.id]);
    id = existing.id;
  } else {
    const [r] = await conn.query('INSERT INTO program_enrollments (tenant_id, program_id, person_id, status, guardian_id, term_id, group_id, bundle_id, any_day, price_cents, discount_cents, paid_cents, order_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [tenantId, program.id, personId, ...vals]);
    id = r.insertId;
  }
  if (details) await saveDetails(conn, tenantId, id, details);
  return { id, status };
}

const DETAIL_COLS = ['discipline', 'pass_status', 'needs_rental', 'needs_helmet', 'lesson_cents', 'ticket_cents', 'rental_cents', 'helmet_cents', 'allergies', 'medical', 'pickup'];
/** The child's answers and the price parts on a place. Pickup is a list of { name, phone, relation }. */
async function saveDetails(conn, tenantId, enrollmentId, d) {
  const keys = DETAIL_COLS.filter((k) => d[k] !== undefined);
  if (!keys.length) return;
  const val = (k) => (k === 'pickup' ? JSON.stringify((d.pickup || []).slice(0, 6)) : typeof d[k] === 'boolean' ? (d[k] ? 1 : 0) : d[k] === '' ? null : d[k]);
  await conn.query(`UPDATE program_enrollments SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...keys.map(val), tenantId, enrollmentId]);
}

/** The place's details from a priced part and the child's answers. */
const detailsOf = (reg, part, answers = {}) => ({
  discipline: reg.discipline || null, pass_status: part.pass_status || 'none', needs_rental: Boolean(answers.needs_rental), needs_helmet: Boolean(answers.needs_helmet),
  lesson_cents: part.lesson_cents, ticket_cents: part.ticket_cents, rental_cents: part.rental_cents, helmet_cents: part.helmet_cents,
  ...(answers.allergies !== undefined ? { allergies: answers.allergies || null } : {}), ...(answers.medical !== undefined ? { medical: answers.medical || null } : {}),
  ...(answers.pickup !== undefined ? { pickup: answers.pickup || [] } : {}),
});

/** The first and last dates a group can still meet (makeup weeks included), and how many meetings that is. */
async function groupSpan(conn, tenantId, groupId) {
  const r = await one(conn, "SELECT MIN(starts_at) AS first, MAX(starts_at) AS last, COUNT(*) AS n FROM program_sessions WHERE tenant_id = ? AND group_id = ? AND status <> 'cancelled'", [tenantId, groupId]);
  return { first: r.first ? dstr(r.first) : null, last: r.last ? dstr(r.last) : null, count: Number(r.n || 0) };
}

/**
 * The lift ticket a program includes: one ticket for the participant, good from the first to the last date the group can
 * meet, for as many days as it meets. It goes on the order at no charge, so it shows on the receipt and scans at the gate.
 */
async function issueTicket(conn, tenantId, { program, group, personId, orderId, enrollmentId }) {
  if (!program.includes_ticket || !program.ticket_product_id || !orderId) return null;
  // A season pass holder (found, or said so and to be checked at the first lesson) gets no program ticket.
  const e = await one(conn, 'SELECT pass_status FROM program_enrollments WHERE tenant_id = ? AND id = ?', [tenantId, enrollmentId]);
  if (e && ['verified', 'claimed'].includes(e.pass_status)) return null;
  const span = await groupSpan(conn, tenantId, group.id);
  if (!span.first) return null;
  const [it] = await conn.query("INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, person_id, tier, quantity, unit_price_cents, valid_on, discount_cents, tax_cents, program_id) VALUES (?, ?, ?, 'ticket', ?, 'child', 1, 0, ?, 0, 0, ?)",
    [tenantId, orderId, program.ticket_product_id, personId, span.first, program.id]);
  const code = newCode();
  const [t] = await conn.query('INSERT INTO tickets (tenant_id, order_item_id, person_id, product_id, code, valid_from, valid_to, uses_remaining) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [tenantId, it.insertId, personId, program.ticket_product_id, code, span.first, span.last, span.count]);
  await conn.query('UPDATE program_enrollments SET ticket_id = ? WHERE tenant_id = ? AND id = ?', [t.insertId, tenantId, enrollmentId]);
  return { id: t.insertId, code };
}

/** Keeps the included tickets of a group good through its last meeting after a date is added. */
async function stretchTickets(conn, tenantId, groupId) {
  const span = await groupSpan(conn, tenantId, groupId);
  if (!span.last) return;
  await conn.query(`UPDATE tickets t JOIN program_enrollments e ON e.tenant_id = t.tenant_id AND e.ticket_id = t.id
    SET t.valid_to = GREATEST(t.valid_to, ?), t.uses_remaining = GREATEST(COALESCE(t.uses_remaining, 0), ?)
    WHERE e.tenant_id = ? AND e.group_id = ? AND e.status = 'enrolled' AND t.status = 'active'`, [span.last, span.count, tenantId, groupId]);
}

/**
 * Cancels one meeting (weather). The group's first makeup date still in reserve becomes a lesson. When there is none
 * left, the result says so, with each family's share of one lesson, so the manager can add a date, credit or refund.
 */
async function cancelMeeting(conn, tenantId, meetingId, reason) {
  const m = await one(conn, 'SELECT s.*, t.weeks, t.price_cents AS term_price FROM program_sessions s LEFT JOIN program_terms t ON t.tenant_id = s.tenant_id AND t.id = s.term_id WHERE s.tenant_id = ? AND s.id = ? FOR UPDATE', [tenantId, meetingId]);
  if (!m) throw notFound('Lesson date');
  if (m.status === 'cancelled') throw conflict('That date is already canceled');
  if (m.status === 'standby') throw conflict('That is a makeup date that is not in use. There is nothing to cancel.');
  await conn.query("UPDATE program_sessions SET status = 'cancelled', cancel_reason = ?, cancelled_at = NOW() WHERE tenant_id = ? AND id = ?", [reason, tenantId, meetingId]);
  let makeup = null;
  if (m.group_id) {
    makeup = await one(conn, "SELECT id, starts_at, ends_at FROM program_sessions WHERE tenant_id = ? AND group_id = ? AND status = 'standby' AND starts_at > ? ORDER BY starts_at LIMIT 1 FOR UPDATE", [tenantId, m.group_id, m.starts_at]);
    if (makeup) await conn.query("UPDATE program_sessions SET status = 'scheduled' WHERE tenant_id = ? AND id = ?", [tenantId, makeup.id]);
  }
  const perLesson = m.weeks ? Math.round(Number(m.term_price) / Number(m.weeks)) : null;
  return { id: m.id, group_id: m.group_id, term_id: m.term_id, program_id: m.program_id, date: dstr(m.starts_at), starts_at: m.starts_at, makeup: makeup ? { id: makeup.id, date: dstr(makeup.starts_at), starts_at: makeup.starts_at } : null, no_makeup_left: Boolean(m.group_id) && !makeup, per_lesson_cents: perLesson };
}

/** Who to tell about a group: the parent or guardian on each place, else the participant, with an email address. */
async function familiesOf(conn, tenantId, groupId) {
  return rows(conn, `SELECT e.id AS enrollment_id, p.first_name, p.last_name, COALESCE(g.email, p.email) AS email, COALESCE(g.phone, p.phone) AS phone, COALESCE(g.first_name, p.first_name) AS to_first
    FROM program_enrollments e JOIN people p ON p.tenant_id = e.tenant_id AND p.id = e.person_id
    LEFT JOIN people g ON g.tenant_id = e.tenant_id AND g.id = e.guardian_id
    WHERE e.tenant_id = ? AND e.group_id = ? AND e.status = 'enrolled'`, [tenantId, groupId]);
}

const longDay = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${d}T12:00:00Z`));

/** Emails each family in the group that the date is off, and the makeup date if one was used. Returns how many were sent. */
async function notifyCancel(conn, tenantId, out, reason) {
  if (!out.group_id) return 0;
  await textCancel(conn, tenantId, out, reason).catch(() => {});
  if (!mailer.enabled()) return 0;
  const [fam, t, pg] = await Promise.all([
    familiesOf(conn, tenantId, out.group_id),
    one(conn, 'SELECT name, phone FROM tenants WHERE id = ?', [tenantId]),
    one(conn, 'SELECT name FROM programs WHERE tenant_id = ? AND id = ?', [tenantId, out.program_id]),
  ]);
  let sent = 0;
  const seen = new Set();
  for (const f of fam) {
    if (!f.email) continue;
    const kids = fam.filter((x) => x.email === f.email).map((x) => x.first_name);
    if (seen.has(f.email)) continue;
    seen.add(f.email);
    const text = [`Hi ${f.to_first},`, '', `${pg.name} on ${longDay(out.date)} is cancelled${reason ? ` (${reason})` : ''}.`, '',
      out.makeup ? `The makeup lesson for ${kids.join(' and ')} is ${longDay(out.makeup.date)}, same time and place.` : 'We will be in touch about a makeup lesson or a credit.',
      '', t.phone ? `Questions? Call ${t.phone}.` : '', t.name].join('\n');
    const r = await mailer.send({ tenantId, to: f.email, fromName: t.name, subject: `${pg.name}: ${longDay(out.date)} is canceled`, text, tag: 'program-cancelled' }).catch(() => ({ ok: false }));
    if (r.ok) sent += 1;
  }
  return sent;
}

/** A text to each family's phone as well, when the mountain sends texts and wants weather calls texted. */
async function textCancel(conn, tenantId, out, reason) {
  const sms = require('./sms');
  if (!sms.enabled()) return 0;
  const set = await require('./programplus').settingsOf(conn, tenantId);
  if (!set.text_cancellations) return 0;
  const [fam, pg] = await Promise.all([familiesOf(conn, tenantId, out.group_id), one(conn, 'SELECT name FROM programs WHERE tenant_id = ? AND id = ?', [tenantId, out.program_id])]);
  const seen = new Set(); let sent = 0;
  for (const f of fam) {
    const to = sms.e164(f.phone);
    if (!to || seen.has(to)) continue;
    seen.add(to);
    const body = `${pg.name} on ${longDay(out.date)} is cancelled${reason ? ` (${reason})` : ''}.${out.makeup ? ` Makeup lesson: ${longDay(out.makeup.date)}, same time.` : ''}`;
    const r = await sms.send({ tenantId, to, body: body.slice(0, 300) });
    if (r.ok) sent += 1;
  }
  return sent;
}

/** When a place opens, the first person waiting for that day moves in, else the first who said any day works. */
async function promoteWaitlist(conn, tenantId, group) {
  let next = await one(conn, "SELECT id, person_id FROM program_enrollments WHERE tenant_id = ? AND group_id = ? AND status = 'waitlist' ORDER BY created_at, id LIMIT 1", [tenantId, group.id]);
  if (!next) {
    next = await one(conn, "SELECT id, person_id FROM program_enrollments WHERE tenant_id = ? AND term_id = ? AND status = 'waitlist' AND any_day = 1 ORDER BY created_at, id LIMIT 1", [tenantId, group.term_id]);
    if (next) await conn.query('UPDATE program_enrollments SET group_id = ? WHERE tenant_id = ? AND id = ?', [group.id, tenantId, next.id]);
  }
  if (next) await conn.query("UPDATE program_enrollments SET status = 'enrolled' WHERE tenant_id = ? AND id = ?", [tenantId, next.id]);
  return next;
}

/**
 * Prices one registration: one day of one session ({ term_id, group_id }) or a bundle of sessions ({ bundle_id, groups:
 * [{ term_id, group_id }] }, one day per session). Online it must be a program sold online with registration open.
 *
 * Each place is built from parts: the lessons (session or day price, early bird, a bundle's share), a lift ticket when
 * the program includes one and the child has no season pass, rental when asked for, a helmet when asked for. A child
 * joining after a day group has started pays for what is left when the program prorates late joiners.
 *   r.discipline, r.needs_rental, r.needs_helmet: the child's answers. r.age: their age at the start, when known.
 *   opts.pass(term): resolves to the child's pass status for that session ('verified', 'claimed' or 'none').
 * Returns { program, parts: [{ term, group, lesson_cents, ticket_cents, rental_cents, helmet_cents, list_cents,
 *   pass_status, factor }], list_cents, lesson_cents, name, detail, step, late }.
 */
async function priceRegistration(conn, tenantId, r, today, { online = false, pass = async () => 'none' } = {}) {
  const program = await one(conn, 'SELECT * FROM programs WHERE tenant_id = ? AND id = ?', [tenantId, r.program_id]);
  if (!program || (online && (!program.online || !program.active))) throw notFound('Program');
  const allowed = String(program.disciplines || 'ski,snowboard').split(',').filter(Boolean);
  const discipline = r.discipline || (allowed.length === 1 ? allowed[0] : null);
  if (r.discipline && !allowed.includes(r.discipline)) throw bad(`${program.name} is ${allowed.join(' or ')} only`);
  if (discipline === 'snowboard' && program.snowboard_age_min != null && r.age != null && r.age < program.snowboard_age_min) throw bad(`Snowboarding in ${program.name} starts at age ${program.snowboard_age_min}`);
  const loadPart = async (termId, groupId) => {
    const term = await one(conn, 'SELECT * FROM program_terms WHERE tenant_id = ? AND id = ? AND program_id = ?', [tenantId, termId, program.id]);
    if (!term) throw notFound('Session');
    if (online && !regOpen(term, today)) throw conflict(`Registration for ${term.name} is not open`);
    if (!online && ['archived'].includes(term.status)) throw conflict(`${term.name} is archived`);
    const group = await one(conn, 'SELECT * FROM program_groups WHERE tenant_id = ? AND id = ? AND term_id = ?', [tenantId, groupId, term.id]);
    if (!group) throw bad(`Choose a day for ${term.name}`);
    if (discipline && group.discipline !== 'any' && group.discipline !== discipline) throw bad(`${WEEKDAYS[group.weekday]}s in ${term.name} are ${group.discipline} only`);
    // Late: the day group has already had a lesson. Closed online, else the rest of the lessons are prorated or full price.
    const m = await rows(conn, "SELECT starts_at FROM program_sessions WHERE tenant_id = ? AND group_id = ? AND status = 'scheduled' ORDER BY starts_at", [tenantId, group.id]);
    const held = m.filter((x) => dstr(x.starts_at) < today).length;
    let factor = 1;
    if (held > 0 && m.length) {
      if (held >= m.length) throw conflict(`${term.name} has finished on ${WEEKDAYS[group.weekday]}s`);
      if (program.late_join === 'closed' && online) throw conflict(`${term.name} has started. Please call the mountain to join.`);
      if (program.late_join === 'prorate') factor = (m.length - held) / m.length;
    }
    return { term, group, factor, late: held > 0 };
  };
  let parts;
  let bundle = null;
  if (r.bundle_id) {
    bundle = await one(conn, 'SELECT * FROM program_bundles WHERE tenant_id = ? AND id = ? AND program_id = ? AND active = 1', [tenantId, r.bundle_id, program.id]);
    if (!bundle) throw notFound('Bundle');
    const termIds = parseJson(bundle.term_ids, []).map(Number);
    const chosen = new Map((r.groups || []).map((g) => [Number(g.term_id), Number(g.group_id)]));
    parts = [];
    for (const tid of termIds) {
      if (!chosen.has(tid)) throw bad(`Choose a day for every session in ${bundle.name}`);
      parts.push(await loadPart(tid, chosen.get(tid)));
    }
    // The bundle's lesson price is shared across its sessions in proportion to their own prices, so a refund of one is fair.
    const weights = parts.map((x) => Number(x.term.price_cents) || 1);
    const sum = weights.reduce((a, b) => a + b, 0);
    let left = Number(bundle.price_cents);
    parts.forEach((x, i) => { x.lesson_list = i === parts.length - 1 ? left : Math.round((Number(bundle.price_cents) * weights[i]) / sum); left -= x.lesson_list; });
  } else {
    const part = await loadPart(r.term_id, r.group_id);
    const price = priceNow(part.term, part.group, today);
    part.lesson_list = price.cents; part.step = price.label ? { label: price.label, until: price.until } : null;
    parts = [part];
  }
  for (const x of parts) {
    x.pass_status = program.includes_ticket ? await pass(x.term) : 'none';
    const f = x.factor;
    x.lesson_cents = Math.round(x.lesson_list * f);
    x.ticket_cents = program.includes_ticket && !['verified', 'claimed'].includes(x.pass_status) ? Math.round(Number(x.term.ticket_cents) * f) : 0;
    x.rental_cents = program.includes_rental && r.needs_rental ? Math.round(Number(x.term.rental_cents) * f) : 0;
    x.helmet_cents = program.offers_helmet && r.needs_helmet ? Number(x.term.helmet_cents) : 0;
    x.list_cents = x.lesson_cents + x.ticket_cents + x.rental_cents + x.helmet_cents;
    delete x.lesson_list;
  }
  const one_ = parts[0];
  const sum = (k) => parts.reduce((n, x) => n + x[k], 0);
  return {
    program, bundle, parts, discipline,
    list_cents: sum('list_cents'), lesson_cents: sum('lesson_cents'), ticket_cents: sum('ticket_cents'), rental_cents: sum('rental_cents'), helmet_cents: sum('helmet_cents'),
    name: bundle ? `${program.name}: ${bundle.name}` : `${program.name}: ${one_.term.name}`,
    detail: bundle ? parts.map((x) => `${x.term.name} ${WEEKDAYS[x.group.weekday]}s`).join(', ') : `${WEEKDAYS[one_.group.weekday]}s, ${clock12(one_.group.start_time || one_.term.start_time)} to ${clock12(one_.group.end_time || one_.term.end_time)}`,
    step: bundle ? null : one_.step || null, late: parts.some((x) => x.late && x.factor < 1),
  };
}

/** Sibling discounts across priced registrations: per program, the second and later child (by `child`) get it, on the lessons. */
function applySiblings(regs) {
  const seen = new Map();
  for (const r of regs) {
    const kids = seen.get(r.program.id) || [];
    let idx = kids.indexOf(r.child);
    if (idx < 0) { kids.push(r.child); idx = kids.length - 1; seen.set(r.program.id, kids); }
    r.sibling_cents = siblingOff(r.program, r.lesson_cents, idx);
    r.unit_cents = r.list_cents - r.sibling_cents;
    // Shared across the parts like the lesson price.
    let left = r.sibling_cents;
    r.parts.forEach((x, i) => { x.discount_cents = i === r.parts.length - 1 ? left : Math.round((r.sibling_cents * x.lesson_cents) / (r.lesson_cents || 1)); left -= x.discount_cents; });
  }
  return regs;
}

/** Room for every place asked for, counting several children asking for the same day. Throws naming the first full day. */
async function checkRoom(conn, tenantId, regs) {
  const want = new Map();
  for (const r of regs) for (const x of r.parts) want.set(x.group.id, { n: (want.get(x.group.id)?.n || 0) + 1, x });
  const taken = await takenByGroup(conn, tenantId, [...want.keys()]);
  for (const [gid, { n, x }] of want) {
    if (x.group.capacity == null) continue;
    const left = x.group.capacity - ((taken.get(gid) || {}).enrolled || 0);
    if (left < n) throw conflict(left > 0 ? `Only ${left} place${left === 1 ? '' : 's'} left on ${WEEKDAYS[x.group.weekday]}s in ${x.term.name}` : `${WEEKDAYS[x.group.weekday]}s in ${x.term.name} are full. Join the waitlist instead.`);
  }
}

/**
 * Moves a place to another day of the same session, when it has room and matches the child's discipline. The included
 * ticket follows the new day's dates, and the old day's first waiting child moves in. Returns the promoted person or null.
 */
async function moveDay(conn, tenantId, e, toGroupId) {
  const to = await one(conn, 'SELECT * FROM program_groups WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, toGroupId]);
  if (!to) throw notFound('Day');
  if (to.term_id !== e.term_id) throw bad('Moves stay within the same session');
  if (to.id === e.group_id) return null;
  if (e.discipline && to.discipline !== 'any' && to.discipline !== e.discipline) throw bad(`${WEEKDAYS[to.weekday]}s are ${to.discipline} only`);
  const { n } = await one(conn, "SELECT COUNT(*) AS n FROM program_enrollments WHERE tenant_id = ? AND group_id = ? AND status = 'enrolled'", [tenantId, to.id]);
  if (to.capacity != null && Number(n) >= to.capacity) throw conflict(`${WEEKDAYS[to.weekday]} is full`);
  const from = await one(conn, 'SELECT * FROM program_groups WHERE tenant_id = ? AND id = ?', [tenantId, e.group_id]);
  await conn.query("UPDATE program_enrollments SET group_id = ?, level_id = NULL, status = 'enrolled' WHERE tenant_id = ? AND id = ?", [to.id, tenantId, e.id]);
  if (e.ticket_id) {
    const span = await groupSpan(conn, tenantId, to.id);
    await conn.query('UPDATE tickets SET valid_from = ?, valid_to = ?, uses_remaining = ? WHERE tenant_id = ? AND id = ?', [span.first, span.last, span.count, tenantId, e.ticket_id]);
  }
  return e.status === 'enrolled' ? promoteWaitlist(conn, tenantId, from) : null;
}

function validTime(t) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(t))) throw bad('Times are 24 hour, like 15:45'); return t; }

module.exports = {
  WEEKDAYS, meetingDates, buildMeetings, priceNow, siblingOff, takenByGroup, termDetail, shapeTerm, regOpen, enroll, groupSpan,
  issueTicket, stretchTickets, moveDay, priceRegistration, applySiblings, checkRoom, saveDetails, detailsOf, DETAIL_COLS, clock12, cancelMeeting, notifyCancel, familiesOf, promoteWaitlist, validTime, dstr, tstr, parseJson, longDay,
};
