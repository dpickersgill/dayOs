'use strict';
// Copy a day (or a weekend) of lessons to other days, and day templates ("Holiday Saturday"). A copy keeps every lesson's
// time, product, levels, ages, spots, meeting place, type and required certification, and optionally its instructor
// (only when the instructor passes the same checks as assigning by hand; otherwise the lesson is copied without them and
// the reason is shown). Copied lessons carry origin 'copy' and the copy's id, so a copy made by mistake can be undone:
// undo deletes the copied lessons nobody has booked or asked for, and lists the rest.
const { tx, one, rows, pool } = require('../db');
const { bad, conflict, notFound } = require('./errors');
const { audit } = require('./audit');
const { addDays } = require('./util');
const { staffProblems } = require('./workforce');
const levels = require('./levels');

const MAX_TARGETS = 30;
const MAX_LESSONS = 400;
const hhmm = (dt) => String(dt).slice(11, 16);

/** The lessons on a day as template rows (times, not dates). */
async function dayLessons(db, tenantId, date) {
  const list = await rows(db, `SELECT s.*, pr.name AS product FROM lesson_sessions s JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
    WHERE s.tenant_id = ? AND s.status <> 'cancelled' AND s.starts_at >= ? AND s.starts_at < ? AND s.origin NOT IN ('split','request','rebook') ORDER BY s.starts_at, s.id`, [tenantId, `${date} 00:00:00`, `${addDays(date, 1)} 00:00:00`]);
  return list.map(asTemplate);
}

/** One lesson as a template row. A lesson that ran past midnight is not expected; the end time is kept as it is. */
const asTemplate = (s) => ({
  start: hhmm(s.starts_at), end: hhmm(s.ends_at), product_id: s.product_id, product: s.product, discipline: s.discipline, ability_level: s.ability_level,
  level_min: s.level_min, level_max: s.level_max, age_min: s.age_min, age_max: s.age_max, age_group: s.age_group, format: s.format,
  capacity: s.capacity, meeting_place: s.meeting_place, notes: s.notes, instructor_id: s.instructor_id, required_certification_id: s.required_certification_id,
});

/**
 * The plan: for each target day, the source lessons to create there. source: { from, days } (days 1 or 2: a day or a
 * weekend) or { template_id }. targets: the first day of each copy. Source day i lands on target + i.
 */
async function plan(db, tenantId, { source, targets, with_instructors: withInstructors }) {
  if (!targets || !targets.length) throw bad('Pick at least one day to copy to');
  if (targets.length > MAX_TARGETS) throw bad(`Copy to at most ${MAX_TARGETS} days at once`);
  let days = [];
  let label;
  if (source.template_id) {
    const tpl = await one(db, 'SELECT * FROM lesson_day_templates WHERE tenant_id = ? AND id = ?', [tenantId, source.template_id]);
    if (!tpl) throw notFound('Template');
    days = [JSON.parse(tpl.lessons)];
    label = `Template ${tpl.name}`;
  } else {
    const n = Math.min(Math.max(Number(source.days) || 1, 1), 2);
    for (let i = 0; i < n; i += 1) days.push(await dayLessons(db, tenantId, addDays(source.from, i)));
    label = n === 2 ? `Weekend of ${source.from}` : `Day ${source.from}`;
  }
  if (!days.some((d) => d.length)) throw bad('There are no lessons to copy on that day');
  const out = [];
  for (const start of [...new Set(targets)].sort()) {
    for (let i = 0; i < days.length; i += 1) {
      const date = addDays(start, i);
      if (!source.template_id && date >= source.from && date < addDays(source.from, days.length)) throw bad('A day cannot be copied onto itself');
      const existing = await rows(db, "SELECT product_id, starts_at, discipline, level_min, level_max, age_min, age_max FROM lesson_sessions WHERE tenant_id = ? AND status <> 'cancelled' AND starts_at >= ? AND starts_at < ?",
        [tenantId, `${date} 00:00:00`, `${addDays(date, 1)} 00:00:00`]);
      const same = (l) => existing.some((e) => e.product_id === l.product_id && hhmm(e.starts_at) === l.start && e.discipline === l.discipline && (e.level_min || null) === (l.level_min || null) && (e.level_max || null) === (l.level_max || null) && (e.age_min || null) === (l.age_min || null) && (e.age_max || null) === (l.age_max || null));
      for (const l of days[i]) out.push({ ...l, date, starts_at: `${date} ${l.start}:00`, ends_at: `${date} ${l.end}:00`, skip: same(l) ? 'Already on that day' : null, instructor_id: withInstructors ? l.instructor_id : null, instructor_problem: null });
    }
  }
  if (out.length > MAX_LESSONS) throw bad(`That would make ${out.length} lessons. Copy fewer days at once (at most ${MAX_LESSONS} lessons).`);
  return { label, lessons: out };
}

/** Checks each instructor on the plan the way assigning by hand does, counting the lessons the copy itself adds. */
async function checkInstructors(conn, tenantId, lessons) {
  const profiles = new Map((await rows(conn, 'SELECT * FROM instructor_profiles WHERE tenant_id = ?', [tenantId])).map((p) => [p.staff_id, p]));
  const taken = [];
  for (const l of lessons) {
    if (l.skip || !l.instructor_id) continue;
    let problems = await staffProblems(conn, tenantId, { staffId: l.instructor_id, certificationIds: l.required_certification_id ? [l.required_certification_id] : [], startsAt: l.starts_at, endsAt: l.ends_at });
    if (!levels.instructorCovers(profiles.get(l.instructor_id), l.discipline, l.level_max)) problems = [...problems, `Not cleared to teach ${levels.range(l.level_min, l.level_max)}`];
    if (taken.some((x) => x.id === l.instructor_id && x.s < l.ends_at && x.e > l.starts_at)) problems = [...problems, 'Teaching another copied lesson then'];
    if (problems.length) { l.instructor_problem = problems[0]; l.instructor_id = null; } else taken.push({ id: l.instructor_id, s: l.starts_at, e: l.ends_at });
  }
}

/** What a copy would make, with any instructor problems, without making it. */
async function preview(tenantId, body) {
  const p = await plan(pool, tenantId, body);
  await checkInstructors(pool, tenantId, p.lessons);
  return summarize(p);
}

function summarize(p) {
  const make = p.lessons.filter((l) => !l.skip);
  return {
    label: p.label,
    lessons: p.lessons.map((l) => ({ date: l.date, start: l.start, end: l.end, product: l.product, discipline: l.discipline, level_words: levels.range(l.level_min, l.level_max), capacity: l.capacity, format: l.format, meeting_place: l.meeting_place, instructor_id: l.instructor_id, instructor_problem: l.instructor_problem, skip: l.skip })),
    days: [...new Set(p.lessons.map((l) => l.date))].sort(),
    to_make: make.length, skipped: p.lessons.length - make.length, without_instructor: make.filter((l) => l.instructor_problem).length,
  };
}

/** Makes the copy in one transaction and returns its id and summary. */
async function copy(tenantId, body, req) {
  return tx(async (conn) => {
    const p = await plan(conn, tenantId, body);
    await checkInstructors(conn, tenantId, p.lessons);
    const make = p.lessons.filter((l) => !l.skip);
    if (!make.length) throw conflict('Every lesson is already on those days. Nothing to copy.');
    const [c] = await conn.query("INSERT INTO lesson_copies (tenant_id, kind, label, target_dates, lessons_n, with_instructors, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [tenantId, body.source.template_id ? 'template' : 'day', p.label, JSON.stringify([...new Set(make.map((l) => l.date))].sort()).slice(0, 800), make.length, body.with_instructors ? 1 : 0, req.auth.userId || null]);
    for (const l of make) {
      await conn.query(`INSERT INTO lesson_sessions (tenant_id, product_id, discipline, ability_level, format, age_group, meeting_place, notes, starts_at, ends_at, capacity, instructor_id,
          required_certification_id, level_min, level_max, age_min, age_max, origin, copy_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'copy', ?)`,
      [tenantId, l.product_id, l.discipline, l.ability_level || levels.toLegacy(l.level_max) || 'beginner', l.format || 'group', l.age_group || 'all', l.meeting_place || null, l.notes || null,
        l.starts_at, l.ends_at, l.capacity || 6, l.instructor_id || null, l.required_certification_id || null, l.level_min || null, l.level_max || null, l.age_min || null, l.age_max || null, c.insertId]);
    }
    await audit(conn, req, 'copy_day', 'lesson_copies', c.insertId, { label: p.label, lessons: make.length, with_instructors: Boolean(body.with_instructors) });
    return { id: c.insertId, ...summarize(p) };
  });
}

/** Undo: deletes the copied lessons that nobody booked or asked for. Lessons with bookings stay and are listed. */
async function undo(tenantId, copyId, req) {
  return tx(async (conn) => {
    const c = await one(conn, 'SELECT * FROM lesson_copies WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, copyId]);
    if (!c) throw notFound('Copy');
    if (c.undone_at) throw conflict('That copy was already undone');
    const list = await rows(conn, `SELECT s.id, s.starts_at, pr.name AS product,
        (SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id) AS b,
        (SELECT COUNT(*) FROM lesson_requests r WHERE r.tenant_id = s.tenant_id AND r.session_id = s.id) AS r,
        (SELECT COUNT(*) FROM order_items i WHERE i.tenant_id = s.tenant_id AND i.session_id = s.id) AS i
      FROM lesson_sessions s JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id WHERE s.tenant_id = ? AND s.copy_id = ? FOR UPDATE`, [tenantId, copyId]);
    const kept = []; let deleted = 0;
    for (const s of list) {
      if (Number(s.b) || Number(s.r) || Number(s.i)) { kept.push({ id: s.id, starts_at: s.starts_at, product: s.product }); continue; }
      await conn.query('DELETE FROM lesson_sessions WHERE tenant_id = ? AND id = ?', [tenantId, s.id]);
      deleted += 1;
    }
    await conn.query('UPDATE lesson_copies SET undone_at = NOW(), undone_by = ? WHERE tenant_id = ? AND id = ?', [req.auth.userId || null, tenantId, copyId]);
    await audit(conn, req, 'undo_copy', 'lesson_copies', copyId, { deleted, kept: kept.length });
    return { deleted, kept };
  });
}

/** Saves a day as a named template (replacing one with the same name). */
async function saveTemplate(tenantId, { name, date }, req) {
  const lessons = await dayLessons(pool, tenantId, date);
  if (!lessons.length) throw bad('There are no lessons on that day to save');
  return tx(async (conn) => {
    const [r] = await conn.query(`INSERT INTO lesson_day_templates (tenant_id, name, lessons, source_date, created_by) VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE lessons = VALUES(lessons), source_date = VALUES(source_date), id = LAST_INSERT_ID(id)`, [tenantId, name, JSON.stringify(lessons), date, req.auth.userId || null]);
    await audit(conn, req, 'save_template', 'lesson_day_templates', r.insertId, { name, lessons: lessons.length });
    return { id: r.insertId, lessons: lessons.length };
  });
}

async function templates(tenantId) {
  return (await rows(pool, 'SELECT id, name, lessons, source_date, updated_at FROM lesson_day_templates WHERE tenant_id = ? ORDER BY name', [tenantId]))
    .map((t) => { const l = JSON.parse(t.lessons); return { id: t.id, name: t.name, source_date: t.source_date, updated_at: t.updated_at, lessons: l.length, first: l.length ? l[0].start : null, last: l.length ? l[l.length - 1].start : null }; });
}

async function recent(tenantId) {
  return rows(pool, 'SELECT id, kind, label, target_dates, lessons_n, with_instructors, created_at, undone_at FROM lesson_copies WHERE tenant_id = ? ORDER BY id DESC LIMIT 10', [tenantId]);
}

module.exports = { plan, preview, copy, undo, saveTemplate, templates, recent, dayLessons };
