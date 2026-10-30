'use strict';
// Spots that follow staff (2026.11.9, Track STAFF fills this in). A lesson with spots_mode 'staff' keeps its capacity equal
// to the instructors free and cleared for it times the student ratio (school_settings ratio_kids or ratio_adults by its age
// band), never above spots_cap and never below what is already booked or held. Every place that sells or books a lesson
// keeps reading lesson_sessions.capacity, so nothing else changes: sync() moves capacity when staffing changes.
//
// Call sync() after anything that changes who can teach a lesson time: a plan publish, an instructor's availability or
// day off, a shift offer accepted, an instructor assigned or moved. The lessons job also runs it every 5 minutes for the
// next 21 days. Safe to call often; it only writes rows whose number changed.

/** sync(conn, tenantId, { sessionIds } | { from, to }) -> { checked, changed }. Stub until Track STAFF: changes nothing. */
async function sync(_conn, _tenantId, _scope = {}) {
  return { checked: 0, changed: 0 };
}

/** What a staff-following lesson's capacity would be now, with the reason: { spots, instructors, ratio, cap }. Stub. */
async function staffSpots(_db, _tenantId, session) {
  return { spots: Number(session.capacity) || 0, instructors: null, ratio: null, cap: session.spots_cap ?? null };
}

module.exports = { sync, staffSpots };
