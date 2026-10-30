'use strict';
// The ski school director role (2026.11.9). An instructor login carries a school access level on the instructor's
// teaching profile (instructor_profiles.school_access): instructor (default), supervisor or director.
//   director    runs the school: plans the season, lessons, bookings, instructors, pay approval, school settings and
//               reports, lesson products and prices, sells and refunds lessons (up to the counter refund limit).
//               Never Money, billing, logins for other teams or other apps' settings. Two-step sign-in required.
//   supervisor  runs the day: lineup, check-in, rosters, assigning instructors, bookings, requests, waitlists, weather calls.
// Owners and managers can do everything either can. Only owners and managers set someone's level.
//
// The level is read once per request when the login is checked (middleware/auth.js TIER_SQL, school_access) and kept on
// req.auth.schoolLevel. Routes guard with school('director') or school('supervisor'), optionally letting other login roles
// in too: school('supervisor', 'counter') is the desk (counter staff, supervisors and up).
const { unauthorized, forbidden } = require('./errors');

const LEVELS = ['instructor', 'supervisor', 'director'];
const RANK = { instructor: 0, supervisor: 1, director: 2 };
const LABEL = { instructor: 'Instructor', supervisor: 'Supervisor', director: 'Director' };
const MANAGERS = ['owner', 'manager'];

const clean = (v) => (LEVELS.includes(v) ? v : 'instructor');

/**
 * The school access level of a signed-in request: 'director' for owners and managers (they can do everything), the
 * teaching profile's level for an instructor login, null for anyone else. Uses req.auth.schoolLevel when the sign-in
 * check already read it; otherwise reads it (db: a pool or connection).
 */
async function levelOf(db, auth) {
  if (!auth) return null;
  if (MANAGERS.includes(auth.role)) return 'director';
  if (auth.role !== 'instructor') return null;
  if (auth.schoolLevel !== undefined) return clean(auth.schoolLevel);
  if (!auth.staffId || !db) return 'instructor';
  const [r] = await db.query('SELECT school_access FROM instructor_profiles WHERE tenant_id = ? AND staff_id = ?', [auth.tenantId, auth.staffId]);
  auth.schoolLevel = clean(r[0] && r[0].school_access);
  return auth.schoolLevel;
}

/** The level right now, from what the sign-in check read (no database). */
function levelNow(auth) {
  if (!auth) return null;
  if (MANAGERS.includes(auth.role)) return 'director';
  return auth.role === 'instructor' ? clean(auth.schoolLevel) : null;
}

/** Is this request at the level or above (owners and managers always are)? */
const atLeast = (req, level) => {
  const mine = levelNow(req.auth);
  return Boolean(mine) && RANK[mine] >= RANK[level];
};

/** An instructor login that sees only its own lessons (not a supervisor or director). */
const ownOnly = (req) => Boolean(req.auth) && req.auth.role === 'instructor' && !atLeast(req, 'supervisor');

/** An instructor login at the director level (not an owner or manager): the one held to lessons only outside Ski school. */
const isSchoolDirector = (req) => Boolean(req.auth) && req.auth.role === 'instructor' && clean(req.auth.schoolLevel) === 'director';

/**
 * Route guard: lets in owners, managers, instructor logins at this level or above, and any other login roles listed
 * (school('supervisor', 'counter') for the desk). Everyone else: 403 "Your role cannot do that".
 */
function school(level, ...alsoRoles) {
  if (!LEVELS.includes(level)) throw new Error(`Unknown school level ${level}`);
  return (req, _res, next) => {
    if (!req.auth) return next(unauthorized());
    if (MANAGERS.includes(req.auth.role) || alsoRoles.includes(req.auth.role)) return next();
    if (atLeast(req, level)) return next();
    return next(forbidden('Your role cannot do that'));
  };
}

/**
 * Route guard outside Ski school (Products, Sell, refunds): the roles listed get in as before; a school director gets in
 * only when test(req) says this is lessons only (async, may throw its own 403 or 404). Everyone else: 403.
 */
function directorFor(roles, test, refusal = 'A ski school director can do this for lessons only') {
  return async (req, _res, next) => {
    try {
      if (!req.auth) return next(unauthorized());
      if (MANAGERS.includes(req.auth.role) || roles.includes(req.auth.role)) return next();
      if (isSchoolDirector(req) && (await test(req))) return next();
      return next(forbidden(isSchoolDirector(req) ? refusal : 'Your role cannot do that'));
    } catch (err) { return next(err); }
  };
}

module.exports = { LEVELS, RANK, LABEL, levelOf, levelNow, atLeast, ownOnly, isSchoolDirector, school, directorFor };
