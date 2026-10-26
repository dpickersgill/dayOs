'use strict';

// The staff injury register: the owner's private record of work injuries and illnesses, kept with the fields of OSHA's
// Form 300 (the log) and Form 301 (the incident report), and summed up each calendar year in the Form 300A layout.
//
// Records are numbered per calendar year (2026-001), as the OSHA log is. A patrol case where the patient is staff or a
// volunteer on duty makes its record on its own, filled in with who, when, where and what happened; the injury details
// stay on the case. Whether the mountain must keep the OSHA log at all depends on its size and industry; the register is
// useful either way.
const { pool, rows, one } = require('../db');

const KINDS = [['injury', 'Injury'], ['skin', 'Skin disorder'], ['respiratory', 'Respiratory condition'], ['poisoning', 'Poisoning'], ['hearing', 'Hearing loss'], ['other_illness', 'All other illnesses']];
const OUTCOMES = [['death', 'Death'], ['days_away', 'Days away from work'], ['restricted', 'Job transfer or restriction'], ['other_recordable', 'Other recordable case'], ['not_recordable', 'Not recordable (first aid only)']];
const RECORDABLE = ['death', 'days_away', 'restricted', 'other_recordable'];

/** The next number in a calendar year. Call inside a transaction (the unique key stops two at once). */
async function nextSeq(conn, t, year) {
  const r = await one(conn, 'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM staff_injuries WHERE tenant_id = ? AND year = ? FOR UPDATE', [t, year]);
  return Number(r.n);
}

/** Who may open the register: the owner always; anyone the owner has named. */
async function canSee(db, t, user) {
  if (user.role === 'owner') return true;
  return Boolean(await one(db, 'SELECT user_id FROM staff_injury_access WHERE tenant_id = ? AND user_id = ?', [t, user.id]));
}

/**
 * Makes the register record for a patrol patient who is staff or a volunteer on duty, once. Never fails the patrol save
 * that called it.
 */
async function fromPatrol(t, incidentId, p, kind) {
  try {
    if (await one(pool, 'SELECT id FROM staff_injuries WHERE tenant_id = ? AND patient_id = ?', [t, p.id])) return null;
    const inc = await one(pool, 'SELECT occurred_at, location, summary FROM incidents WHERE tenant_id = ? AND id = ?', [t, incidentId]);
    const person = p.person_id ? await one(pool, 'SELECT s.id FROM staff s WHERE s.tenant_id = ? AND s.person_id = ?', [t, p.person_id]) : null;
    const year = Number(String(inc.occurred_at).slice(0, 4));
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const seq = await nextSeq(conn, t, year);
      const [r] = await conn.query(`INSERT INTO staff_injuries (tenant_id, year, seq, source, incident_id, patient_id, staff_id, volunteer, employee_name, job_title, occurred_at, place, description)
        VALUES (?, ?, ?, 'patrol', ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [t, year, seq, incidentId, p.id, person ? person.id : null, kind === 'volunteer_work' ? 1 : 0,
        `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'Not recorded', kind === 'volunteer_work' ? 'Volunteer' : null, inc.occurred_at, (inc.location || '').slice(0, 150) || null, (inc.summary || '').slice(0, 500) || null]);
      await conn.commit();
      return r.insertId;
    } catch (e) { await conn.rollback(); if (e.code === 'ER_DUP_ENTRY') return null; throw e; } finally { conn.release(); }
  } catch (e) {
    console.warn('Could not add to the staff injury register:', e.message);
    return null;
  }
}

/**
 * The year's summary in the Form 300A layout: case counts by outcome, days away and restricted, counts by kind, and the
 * hours worked and average employees (entered by the owner, or worked out from the time clock).
 */
async function summary(db, t, year) {
  const list = await rows(db, 'SELECT outcome, kind, days_away, days_restricted FROM staff_injuries WHERE tenant_id = ? AND year = ? AND outcome IN (?)', [t, year, RECORDABLE]);
  const count = (o) => list.filter((x) => x.outcome === o).length;
  const kinds = Object.fromEntries(KINDS.map(([k]) => [k, list.filter((x) => x.kind === k).length]));
  const set = await one(db, 'SELECT hours_worked, avg_employees, certified_by, certified_at FROM staff_injury_years WHERE tenant_id = ? AND year = ?', [t, year]);
  const clock = await one(db, `SELECT ROUND(SUM(TIMESTAMPDIFF(MINUTE, clock_in, clock_out)) / 60) AS hours, COUNT(DISTINCT staff_id) AS people,
      COUNT(DISTINCT YEARWEEK(clock_in, 3)) AS weeks FROM time_entries WHERE tenant_id = ? AND clock_out IS NOT NULL AND YEAR(clock_in) = ?`, [t, year]);
  // The average: people on the clock in each week, averaged over the weeks anyone worked (a stand-in for pay periods).
  const weekly = await one(db, `SELECT AVG(n) AS avg FROM (SELECT COUNT(DISTINCT staff_id) AS n FROM time_entries WHERE tenant_id = ? AND YEAR(clock_in) = ? GROUP BY YEARWEEK(clock_in, 3)) w`, [t, year]);
  return {
    year,
    deaths: count('death'), days_away_cases: count('days_away'), restricted_cases: count('restricted'), other_cases: count('other_recordable'),
    days_away: list.reduce((n, x) => n + Number(x.days_away || 0), 0), days_restricted: list.reduce((n, x) => n + Number(x.days_restricted || 0), 0),
    kinds,
    hours_worked: set && set.hours_worked !== null ? Number(set.hours_worked) : null,
    avg_employees: set && set.avg_employees !== null ? Number(set.avg_employees) : null,
    from_clock: { hours: clock && clock.hours !== null ? Number(clock.hours) : 0, avg_employees: weekly && weekly.avg !== null ? Math.round(Number(weekly.avg)) : 0, weeks: clock ? Number(clock.weeks) : 0 },
    certified_by: set ? set.certified_by : null, certified_at: set && set.certified_at ? String(set.certified_at).slice(0, 10) : null,
  };
}

module.exports = { KINDS, OUTCOMES, RECORDABLE, nextSeq, canSee, fromPatrol, summary };
