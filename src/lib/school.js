'use strict';

// Ski school helpers: the default level ladder, and a student's report card.
const { rows, one } = require('../db');
const levelsLib = require('./levels');

const DISCIPLINES = ['ski', 'snowboard', 'telemark', 'adaptive'];

// The nine levels (PSIA-AASI, lib/levels.js) are the ladder for every mountain: level names and descriptions come from
// lib/levels.js, and each level starts with a few "I can" skills the mountain can rename, add to or remove.
const SKILLS = {
  ski: [
    null,
    ['I can put on and take off my skis', 'I can walk and glide on flat snow', 'I can stop with a wedge (pizza)'],
    ['I can stop on the beginner slope when I want to', 'I can make a wedge turn both ways', 'I can ride the magic carpet'],
    ['I can link wedge turns on a green run', 'I can control my speed by turning', 'I can get on and off the chairlift'],
    ['My skis match at the end of my turns', 'I can stop with my skis side by side', 'I can ski every green run'],
    ['I make parallel turns on green runs', 'I can ski easy blue runs with wedge turns', 'I use my poles to time my turns'],
    ['I make parallel turns on blue runs', 'I can stop quickly (a hockey stop)', 'I can ski a little soft or bumpy snow'],
    ['I am confident on every blue run', 'I can carve on groomed runs', 'I can try an easy black run'],
    ['I ski black runs with control', 'I can ski bumps', 'I can ski powder or crud'],
    ['I ski steeps and trees', 'I can change turn size and speed at will', 'I can ski the terrain park safely'],
  ],
  snowboard: [
    null,
    ['I can strap in and skate with one foot free', 'I can glide and stop on flat snow', 'I can stand up from sitting'],
    ['I can slide on my heel edge and stop', 'I can slide on my toe edge and stop', 'I can ride the magic carpet'],
    ['I can do the falling leaf on my heel edge', 'I can do the falling leaf on my toe edge', 'I can make a J turn both ways'],
    ['I can get on and off the chairlift', 'I can link a few turns on a green run', 'I can stop on either edge'],
    ['I link turns on every green run', 'I can ride some easy blue runs', 'I can control my speed with my turns'],
    ['I ride blue runs with control', 'I can ride a little switch', 'I can ride a little soft or bumpy snow'],
    ['I am confident on every blue run', 'I can carve on groomed runs', 'I can try an easy black run'],
    ['I ride black runs with control', 'I can ride bumps', 'I can ride small features in the park'],
    ['I ride steeps and trees', 'I can ride powder with control', 'I can ride the terrain park safely'],
  ],
};
// The names the first ladder (before the nine levels) gave, so a mountain that never changed them gets the new words.
const OLD_NAMES = ['First steps', 'Beginner', 'Advanced beginner', 'Intermediate', 'Advanced intermediate', 'Advanced'];

/**
 * Makes sure the mountain has the nine levels for ski and snowboard (creating any that are missing, with their default
 * skills). A level still named as the old default ladder named it is renamed to the nine-level words; anything the
 * mountain named itself is kept. Levels above 9 from the old ladder are no longer shown.
 */
async function ensureLadder(conn, tenantId) {
  const have = await rows(conn, "SELECT id, discipline, rank_no, name FROM school_levels WHERE tenant_id = ? AND discipline IN ('ski','snowboard')", [tenantId]);
  const need = have.filter((l) => l.rank_no <= 9).length < 18 || have.some((l) => l.rank_no <= 9 && OLD_NAMES.includes(l.name));
  if (!need) return false;
  for (const discipline of ['ski', 'snowboard']) {
    const words = levelsLib.list(discipline);
    for (const w of words) {
      const cur = have.find((l) => l.discipline === discipline && l.rank_no === w.level);
      if (cur) {
        if (OLD_NAMES.includes(cur.name)) await conn.query('UPDATE school_levels SET name = ?, description = ? WHERE tenant_id = ? AND id = ?', [w.short, w.can.slice(0, 300), tenantId, cur.id]);
        continue;
      }
      const [r] = await conn.query('INSERT IGNORE INTO school_levels (tenant_id, discipline, rank_no, name, description) VALUES (?, ?, ?, ?, ?)', [tenantId, discipline, w.level, w.short, w.can.slice(0, 300)]);
      if (!r.insertId) continue;
      const skills = SKILLS[discipline][w.level];
      for (let j = 0; j < skills.length; j++) await conn.query('INSERT INTO school_skills (tenant_id, level_id, name, sort_no) VALUES (?, ?, ?, ?)', [tenantId, r.insertId, skills[j], j + 1]);
    }
  }
  return true;
}

/** The whole ladder with each level's skills. */
async function ladder(conn, tenantId) {
  const levels = await rows(conn, "SELECT id, discipline, rank_no, name, description FROM school_levels WHERE tenant_id = ? AND rank_no <= 9 ORDER BY discipline, rank_no", [tenantId]);
  const skills = await rows(conn, 'SELECT id, level_id, name, sort_no FROM school_skills WHERE tenant_id = ? ORDER BY sort_no, id', [tenantId]);
  return levels.map((l) => ({ ...l, skills: skills.filter((s) => s.level_id === l.id).map((s) => ({ id: s.id, name: s.name })) }));
}

/** A student's report card: where they are in each discipline, the skills passed, and their lesson history. */
async function studentCard(conn, tenantId, personId, opts = {}) {
  const person = await one(conn, 'SELECT id, first_name, last_name, date_of_birth, discipline, ski_level, snowboard_level, level_source, level_set_at FROM people WHERE tenant_id = ? AND id = ?', [tenantId, personId]);
  if (!person) return null;
  await ensureLadder(conn, tenantId);
  const all = await ladder(conn, tenantId);
  const passed = new Map((await rows(conn, 'SELECT skill_id, passed_on FROM student_skills WHERE tenant_id = ? AND person_id = ?', [tenantId, personId])).map((r) => [r.skill_id, r.passed_on]));
  const history = await rows(conn, `SELECT sp.id, sp.discipline, sp.level, sp.notes, sp.recorded_at FROM student_progress sp WHERE sp.tenant_id = ? AND sp.person_id = ? ORDER BY sp.recorded_at DESC, sp.id DESC LIMIT 100`, [tenantId, personId]);
  const lessons = await rows(conn,
    `SELECT b.id AS booking_id, b.status, b.instructor_notes, b.unpaid, s.id AS session_id, s.starts_at, s.discipline, s.format, pr.name AS product, pe.first_name AS instructor_first, pe.last_name AS instructor_last
     FROM lesson_bookings b JOIN lesson_sessions s ON s.id = b.session_id AND s.tenant_id = b.tenant_id JOIN products pr ON pr.id = s.product_id AND pr.tenant_id = s.tenant_id
     LEFT JOIN staff st ON st.id = s.instructor_id AND st.tenant_id = s.tenant_id LEFT JOIN people pe ON pe.id = st.person_id AND pe.tenant_id = st.tenant_id
     WHERE b.tenant_id = ? AND b.person_id = ? AND b.status <> 'cancelled' ORDER BY s.starts_at DESC LIMIT 100`, [tenantId, personId]);
  const disciplines = [];
  for (const d of DISCIPLINES) {
    const levels = all.filter((l) => l.discipline === d).map((l) => {
      const skills = l.skills.map((s) => ({ ...s, passed_on: passed.get(s.id) || null }));
      return { ...l, skills, complete: skills.length > 0 && skills.every((s) => s.passed_on) };
    });
    const latest = history.find((x) => x.discipline === d);
    const onFile = d === 'ski' || d === 'snowboard' ? levelsLib.personLevel(person, d) : null;
    if (!levels.length && !latest) continue;
    const current = onFile || (latest ? latest.level : null);
    const next = levels.find((l) => !l.complete);
    disciplines.push({ discipline: d, current_level: current, level_words: current ? levelsLib.name(current, d) : null, next_level: next ? next.rank_no : null, levels });
  }
  const credits = await rows(conn, "SELECT c.id, c.total, c.used, c.expires_on, pr.name AS product FROM lesson_credits c JOIN products pr ON pr.id = c.product_id AND pr.tenant_id = c.tenant_id WHERE c.tenant_id = ? AND c.person_id = ? AND c.status = 'active' ORDER BY c.id DESC", [tenantId, personId]);
  // Programs run in sessions count on the report card too: each place, its class and how many lessons attended.
  const programs = await rows(conn, `SELECT e.id, pr.name AS program, pt.name AS term, g.weekday, l.name AS class_name, e.discipline,
      (SELECT COUNT(*) FROM attendance a JOIN program_sessions s ON s.tenant_id = a.tenant_id AND s.id = a.session_id WHERE a.tenant_id = e.tenant_id AND a.person_id = e.person_id AND s.group_id = e.group_id AND a.present = 1) AS attended,
      (SELECT COUNT(*) FROM program_sessions s WHERE s.tenant_id = e.tenant_id AND s.group_id = e.group_id AND s.status = 'scheduled') AS lessons
    FROM program_enrollments e JOIN programs pr ON pr.tenant_id = e.tenant_id AND pr.id = e.program_id
    JOIN program_terms pt ON pt.tenant_id = e.tenant_id AND pt.id = e.term_id JOIN program_groups g ON g.tenant_id = e.tenant_id AND g.id = e.group_id
    LEFT JOIN program_levels l ON l.tenant_id = e.tenant_id AND l.id = e.level_id
    WHERE e.tenant_id = ? AND e.person_id = ? AND e.status = 'enrolled' ORDER BY pt.starts_on DESC LIMIT 50`, [tenantId, personId]);
  // The discipline the report card opens on: the one asked for (the lesson's), else the one they have a level in.
  const focus = opts.discipline && ['ski', 'snowboard'].includes(opts.discipline) ? opts.discipline : opts.discipline === 'telemark' || opts.discipline === 'adaptive' ? 'ski'
    : person.snowboard_level && !person.ski_level ? 'snowboard' : person.discipline === 'snowboard' ? 'snowboard' : 'ski';
  return { person, focus, disciplines, history, lessons, programs: programs.map((p) => ({ ...p, attended: Number(p.attended), lessons: Number(p.lessons) })), credits: credits.map((c) => ({ ...c, left: c.total - c.used })) };
}

module.exports = { DISCIPLINES, ensureLadder, ladder, studentCard };

// ---------------------------------------------------------------- who can teach a lesson (the instructor picker)
const { staffProblems } = require('./workforce');
const csvOf = (s) => (s ? String(s).split(',').filter(Boolean) : []);

/** Active staff who teach: an instructor profile, or a login with the instructor role. */
async function teachingStaff(db, tenantId) {
  return rows(db, `SELECT st.id, p.first_name, p.last_name, ip.disciplines, ip.ski_level_max, ip.snowboard_level_max, ip.teaches_kids, ip.teaches_adaptive, ip.psia_level, ip.staff_id AS has_profile
    FROM staff st JOIN people p ON p.id = st.person_id AND p.tenant_id = st.tenant_id
    LEFT JOIN instructor_profiles ip ON ip.tenant_id = st.tenant_id AND ip.staff_id = st.id
    WHERE st.tenant_id = ? AND st.status = 'active'
      AND (ip.staff_id IS NOT NULL OR EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = st.tenant_id AND u.staff_id = st.id AND u.role = 'instructor' AND u.active = 1))
    ORDER BY p.first_name, p.last_name LIMIT 300`, [tenantId]);
}

/** The gap for an instructor with no teaching profile: not cleared for everything, but a manager may assign anyway. */
const NOT_SET_UP = 'Not set up: set what they teach';

/** Is this instructor cleared for this lesson? Words for each gap: level, kids, adaptive, the discipline. */
function clearanceGaps(profile, s) {
  const gaps = [];
  // No profile on file means nobody has said what they teach yet: never "cleared for everything".
  if (!profile || !profile.has_profile) return [NOT_SET_UP];
  const disc = s.discipline || 'ski';
  const listed = csvOf(profile.disciplines);
  if (listed.length && !listed.includes(disc)) gaps.push(`Does not teach ${disc}`);
  if (!levelsLib.instructorCovers(profile, disc, s.level_max)) {
    const cap = disc === 'snowboard' ? profile.snowboard_level_max : profile.ski_level_max;
    gaps.push(`Cleared to level ${cap}, this lesson goes to level ${s.level_max}`);
  }
  if (s.age_max && Number(s.age_max) <= 12 && profile.teaches_kids === 0) gaps.push('Not cleared to teach kids');
  if (disc === 'adaptive' && profile.teaches_adaptive === 0) gaps.push('Not cleared for adaptive lessons');
  return gaps;
}

/**
 * Every teaching staff member for a lesson, best fit first: { id, name, problems (hard: clash, missing certification,
 * not cleared, outside availability), ok, requested_by, psia_level }. s: the lesson (saved or about to be).
 */
async function instructorFit(db, tenantId, s, { ignoreLessonId = null, onlyStaffId = null } = {}) {
  let staff = await teachingStaff(db, tenantId);
  if (onlyStaffId) {
    staff = staff.filter((m) => m.id === Number(onlyStaffId));
    if (!staff.length) {
      const other = await one(db, 'SELECT st.id, p.first_name, p.last_name FROM staff st JOIN people p ON p.id = st.person_id AND p.tenant_id = st.tenant_id WHERE st.tenant_id = ? AND st.id = ?', [tenantId, onlyStaffId]);
      if (!other) return [];
      staff = [{ ...other, not_instructor: true }];
    }
  }
  const asked = s.id ? await rows(db, "SELECT requested_instructor_id AS id, COUNT(*) AS n FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND status <> 'cancelled' AND requested_instructor_id IS NOT NULL GROUP BY requested_instructor_id", [tenantId, s.id]) : [];
  const out = [];
  for (const m of staff) {
    const problems = await staffProblems(db, tenantId, { staffId: m.id, certificationIds: s.required_certification_id ? [s.required_certification_id] : [], startsAt: s.starts_at, endsAt: s.ends_at, ignoreLessonId: ignoreLessonId || s.id || null });
    // Someone with no instructor login or profile is not listed in the picker, but older screens and imports may still assign them.
    problems.push(...clearanceGaps(m, s));
    const listed = csvOf(m.disciplines);
    out.push({ id: m.id, name: `${m.first_name} ${m.last_name}`, first_name: m.first_name, problems, ok: problems.length === 0, not_set_up: problems.includes(NOT_SET_UP), requested_by: Number((asked.find((a) => a.id === m.id) || {}).n || 0),
      teaches: listed.includes(s.discipline || 'ski'), psia_level: m.psia_level || 'none' });
  }
  out.sort((a, b) => Number(b.ok) - Number(a.ok) || b.requested_by - a.requested_by || Number(b.teaches) - Number(a.teaches) || a.problems.length - b.problems.length || a.name.localeCompare(b.name));
  return out;
}

module.exports.teachingStaff = teachingStaff;
module.exports.clearanceGaps = clearanceGaps;
module.exports.NOT_SET_UP = NOT_SET_UP;
module.exports.instructorFit = instructorFit;
