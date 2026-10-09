'use strict';

// Ski school helpers: the default level ladder, and a student's report card.
const { rows, one } = require('../db');

const DISCIPLINES = ['ski', 'snowboard', 'telemark', 'adaptive'];

// A sensible starting ladder. A mountain edits names, skills and levels on the Levels tab; nothing here is fixed.
const LADDER = {
  ski: [
    ['First steps', 'Never skied before', ['Puts on and takes off skis', 'Walks and glides on flat snow', 'Stops using a wedge (pizza)']],
    ['Beginner', 'Comfortable on gentle slopes', ['Makes wedge turns on a gentle slope', 'Rides the magic carpet or lift with help', 'Controls speed by turning']],
    ['Advanced beginner', 'Links turns on green runs', ['Links wedge turns on a green run', 'Loads and unloads a chairlift', 'Starts to match skis (parallel) at the end of turns']],
    ['Intermediate', 'Blue runs with control', ['Parallel turns on blue runs', 'Controls speed on steeper terrain', 'Skis varied snow (groomed, packed, a little soft)']],
    ['Advanced intermediate', 'Confident on all blue runs', ['Carved turns on groomed blue runs', 'Skis moguls or soft snow with basic control', 'Uses poles for timing']],
    ['Advanced', 'Black runs and varied terrain', ['Skis black runs with control', 'Skis moguls, trees or powder', 'Adjusts turn size and speed at will']],
  ],
  snowboard: [
    ['First steps', 'Never snowboarded before', ['Straps in and moves with one foot free', 'Glides and stands up from a sit', 'Falling leaf (side slip) down a gentle slope']],
    ['Beginner', 'Heel and toe side control', ['Links J turns', 'Rides the magic carpet or lift with help', 'Stops on both edges']],
    ['Advanced beginner', 'Links turns on green runs', ['Links turns on a green run', 'Loads and unloads a chairlift', 'Keeps the board across the slope with control']],
    ['Intermediate', 'Blue runs with control', ['Linked turns on blue runs', 'Controls speed on steeper terrain', 'Rides varied snow']],
    ['Advanced intermediate', 'Confident on all blue runs', ['Carved turns on groomed runs', 'Rides in soft snow with basic control', 'Rides switch (the other way) on flats']],
    ['Advanced', 'Black runs and varied terrain', ['Rides black runs with control', 'Rides trees, bumps or powder', 'Adjusts turn size and speed at will']],
  ],
};

/** Creates the default ladder the first time a mountain looks at its levels (ski and snowboard only). */
async function ensureLadder(conn, tenantId) {
  const have = await one(conn, 'SELECT COUNT(*) AS n FROM school_levels WHERE tenant_id = ?', [tenantId]);
  if (Number(have.n) > 0) return false;
  for (const [discipline, levels] of Object.entries(LADDER)) {
    for (let i = 0; i < levels.length; i++) {
      const [name, description, skills] = levels[i];
      const [r] = await conn.query('INSERT IGNORE INTO school_levels (tenant_id, discipline, rank_no, name, description) VALUES (?, ?, ?, ?, ?)', [tenantId, discipline, i + 1, name, description]);
      if (!r.insertId) continue;
      for (let j = 0; j < skills.length; j++) await conn.query('INSERT INTO school_skills (tenant_id, level_id, name, sort_no) VALUES (?, ?, ?, ?)', [tenantId, r.insertId, skills[j], j + 1]);
    }
  }
  return true;
}

/** The whole ladder with each level's skills. */
async function ladder(conn, tenantId) {
  const levels = await rows(conn, 'SELECT id, discipline, rank_no, name, description FROM school_levels WHERE tenant_id = ? ORDER BY discipline, rank_no', [tenantId]);
  const skills = await rows(conn, 'SELECT id, level_id, name, sort_no FROM school_skills WHERE tenant_id = ? ORDER BY sort_no, id', [tenantId]);
  return levels.map((l) => ({ ...l, skills: skills.filter((s) => s.level_id === l.id).map((s) => ({ id: s.id, name: s.name })) }));
}

/** A student's report card: where they are in each discipline, the skills passed, and their lesson history. */
async function studentCard(conn, tenantId, personId) {
  const person = await one(conn, 'SELECT id, first_name, last_name, date_of_birth FROM people WHERE tenant_id = ? AND id = ?', [tenantId, personId]);
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
    if (!levels.length && !latest) continue;
    const next = levels.find((l) => !l.complete);
    disciplines.push({ discipline: d, current_level: latest ? latest.level : null, next_level: next ? next.rank_no : null, levels });
  }
  const credits = await rows(conn, "SELECT c.id, c.total, c.used, c.expires_on, pr.name AS product FROM lesson_credits c JOIN products pr ON pr.id = c.product_id AND pr.tenant_id = c.tenant_id WHERE c.tenant_id = ? AND c.person_id = ? AND c.status = 'active' ORDER BY c.id DESC", [tenantId, personId]);
  return { person, disciplines, history, lessons, credits: credits.map((c) => ({ ...c, left: c.total - c.used })) };
}

module.exports = { DISCIPLINES, ensureLadder, ladder, studentCard };
