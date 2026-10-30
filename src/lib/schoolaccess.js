'use strict';
// The ski school director role (2026.11.9, Track ROLE fills this in). An instructor login carries a school access level on
// the instructor's teaching profile (instructor_profiles.school_access): instructor (default), supervisor or director.
//   director    runs the school: plans the season, lessons, bookings, instructors, pay approval, school settings and
//               reports, lesson products and prices, sells and refunds lessons (up to the counter refund limit).
//               Never Money, billing, logins for other teams or other apps' settings. Two-step sign-in required.
//   supervisor  runs the day: lineup, check-in, rosters, assigning instructors, bookings, requests, waitlists, weather calls.
// Owners and managers can do everything either can. Only owners and managers set someone's level.
//
// Every track guards its ski school routes with school('director') or school('supervisor') instead of requireRole('manager')
// where the school director should be let in. Until Track ROLE lands this is managers only.
const { requireRole } = require('../middleware/auth');

const LEVELS = ['instructor', 'supervisor', 'director'];

/** The school access level of a signed-in request: 'director' for owners and managers (they can do everything). */
async function levelOf(_db, auth) {
  if (!auth) return null;
  if (auth.role === 'owner' || auth.role === 'manager') return 'director';
  return auth.role === 'instructor' ? 'instructor' : null;
}

/** Route guard: lets in owners, managers, and (once Track ROLE lands) school logins at this level or above. */
function school(level) {
  if (!LEVELS.includes(level)) throw new Error(`Unknown school level ${level}`);
  return requireRole('manager');
}

module.exports = { LEVELS, levelOf, school };
