'use strict';

// Patrol crews: the plain rules, kept apart from the routes so the tests can check them directly.
//
// A crew is a repeating patrol shift (the Saturday day crew, 8:00 to 4:30 at the summit hut) with how many patrollers it
// wants (target), the fewest it can safely run with (minimum), and the roles it must have (one Patrol leader at least a
// Leader, two with an EMT or higher). Generating the season makes one spot per patroller wanted on each of its days:
// the role spots first, then plain spots. A day's coverage compares who is on those spots with what the crew needs.
const RANKS = ['candidate', 'patroller', 'senior', 'leader', 'director'];
const RANK_LABEL = { candidate: 'Candidate', patroller: 'Patroller', senior: 'Senior', leader: 'Leader', director: 'Director' };
const CERTS = ['none', 'oec', 'emr', 'emt', 'aemt', 'paramedic', 'rn', 'md'];
const CERT_LABEL = { none: 'No medical certification', oec: 'OEC', emr: 'EMR', emt: 'EMT', aemt: 'Advanced EMT', paramedic: 'Paramedic', rn: 'Nurse', md: 'Doctor' };
const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const dayOf = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const hhmm = (t) => String(t || '').slice(0, 5);

/** The crew's days as numbers (0 Sunday to 6 Saturday), from '6,0'. */
const daysOf = (crew) => String(crew.days || '').split(',').filter((x) => /^[0-6]$/.test(x)).map(Number);
const skipsOf = (crew) => new Set(String(crew.skip_dates || '').split(',').map((x) => x.trim()).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)));
const rolesOf = (crew) => {
  if (Array.isArray(crew.roles)) return crew.roles;
  try { const r = JSON.parse(crew.roles || '[]'); return Array.isArray(r) ? r : []; } catch { return []; }
};

/** The dates in [from, to] this crew runs on: its days of the week, inside its season, not a skipped date. */
function datesFor(crew, from, to) {
  const days = new Set(daysOf(crew)); const skips = skipsOf(crew);
  const start = crew.from_date && String(crew.from_date).slice(0, 10) > from ? String(crew.from_date).slice(0, 10) : from;
  const end = crew.to_date && String(crew.to_date).slice(0, 10) < to ? String(crew.to_date).slice(0, 10) : to;
  const out = [];
  for (let d = start; d <= end && out.length < 400; d = addDays(d, 1)) if (days.has(dayOf(d)) && !skips.has(d)) out.push(d);
  return out;
}

/** When the crew starts and ends on a date (an end at or before the start runs past midnight). */
function timesOn(crew, date) {
  const s = hhmm(crew.start_time); const e = hhmm(crew.end_time);
  return { starts_at: `${date} ${s}:00`, ends_at: `${e <= s ? addDays(date, 1) : date} ${e}:00` };
}

/**
 * The spots one day of the crew needs: each role's spots (with its rank and certification), then plain spots up to the
 * target. A crew whose roles add up to more than its target gets the roles.
 */
function spotsFor(crew) {
  const out = [];
  for (const r of rolesOf(crew)) for (let i = 0; i < Math.max(1, Number(r.count) || 1); i += 1) out.push({ role_label: r.label, need_rank: r.rank || null, need_cert: r.cert || null });
  while (out.length < Number(crew.target)) out.push({ role_label: null, need_rank: null, need_cert: null });
  return out;
}

/** Why this patroller cannot fill a spot that needs a rank or a certification (empty when they can). */
function fitProblems(member, spot) {
  const out = [];
  if (spot.need_rank && RANKS.indexOf(member.level) < RANKS.indexOf(spot.need_rank)) out.push(`${spot.role_label || 'This spot'} needs a ${RANK_LABEL[spot.need_rank]} or above`);
  if (spot.need_cert && CERTS.indexOf(member.cert_level || 'oec') < CERTS.indexOf(spot.need_cert)) out.push(`${spot.role_label || 'This spot'} needs ${CERT_LABEL[spot.need_cert]} or higher`);
  return out;
}
const fits = (member, spot) => !fitProblems(member, spot).length;

/**
 * Coverage of one crew on one day from its spots (patrol_shifts rows with crew_id, not canceled): how many are filled
 * against the target and the minimum, which roles have nobody, and a tone: good (at target), short (below target, at
 * or above the minimum) or critical (below the minimum, or a role with nobody). Extra spots from a storm call count.
 */
function coverage(crew, spots, members = new Map()) {
  const live = spots.filter((s) => s.status !== 'cancelled');
  const filled = live.filter((s) => s.staff_id).length;
  const missing = [];
  for (const r of rolesOf(crew)) {
    const want = Math.max(1, Number(r.count) || 1);
    // Anyone on the crew that day who meets the role counts toward it, not only the one on the role's own spot.
    const ok = live.filter((s) => s.staff_id && (s.role_label === r.label || fits(members.get(Number(s.staff_id)) || {}, { need_rank: r.rank, need_cert: r.cert }))).length;
    if (ok < want) missing.push(want - ok > 1 ? `${want - ok} ${r.label}` : r.label);
  }
  const target = Number(crew.target); const minimum = Number(crew.minimum);
  const tone = filled < minimum || missing.length ? 'critical' : filled < target ? 'short' : 'good';
  return { filled, target, minimum, open: live.filter((s) => !s.staff_id).length, missing, tone, published: live.some((s) => s.status === 'published'), drafts: live.filter((s) => s.status === 'draft').length };
}

/** "Sat and Sun, 8:00 to 16:30" for lists. */
/** '16:30' as '4:30 PM'. */
const clock12 = (t) => { const [hh, mm] = hhmm(t).split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };
const summary = (crew) => `${daysOf(crew).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAY_LABEL[d]).join(', ') || 'No days'}, ${clock12(crew.start_time)} to ${clock12(crew.end_time)}`;

/** Whether a sign-in counts as a no-show: a published, filled spot that started over 15 minutes ago with nobody signed in. */
const NO_SHOW_MIN = 15;
function isNoShow(spot, now, signedIn) {
  if (!spot.staff_id || spot.status !== 'published' || signedIn) return false;
  const late = new Date(Date.parse(`${String(spot.starts_at).replace(' ', 'T')}Z`) + NO_SHOW_MIN * 60000).toISOString().slice(0, 19).replace('T', ' ');
  return String(now) >= late;
}

module.exports = { clock12, RANKS, RANK_LABEL, CERTS, CERT_LABEL, DAY_LABEL, dayOf, addDays, daysOf, rolesOf, skipsOf, datesFor, timesOn, spotsFor, fitProblems, fits, coverage, summary, isNoShow, NO_SHOW_MIN };
