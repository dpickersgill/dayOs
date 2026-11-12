'use strict';

// The counts beside the menu's apps, and what the "+ New" menu may offer (release 2026.11.21, routes/nav.js).
//
// A count shows only when something in that app waits on THIS person, and never when it is zero. Each number comes from
// the same function its Today card reads (lib/waiting.js, lib/crewday.js), so the menu and Today cannot disagree:
//
//   requests  new requests nobody has decided on        the front desk, managers        Today: New requests
//   bulk      missed pickups nobody has decided on      the front desk, managers        Today: Missed pickups
//   works     overdue work orders (red)                  managers: all of them           Today: Overdue work orders
//                                                        crew: only their own            Today: My work today, Overdue
//   patrol    my open cases, and reports to review       patrollers; the review group    Patrol's home: My open cases, Waiting for review
//   school    online lesson requests to answer           the counter, supervisors, managers   Today: Lessons, "requests waiting"
//   rentals   reservations to hand out today             the rental counter, managers    Today: Rentals, "to pick up today"
//
// Inbox keeps its own unread count (routes/inbox.js). Only apps that are on for the tenant and that this person may
// open; a ski area never gets a municipal count and a municipality never gets a ski one. Nothing here reads another
// person's assignments: a crew member's number is counted from their own staff record only.
//
// Not counted, on purpose: the Online shop (will-call is a search; no order there waits to be handed out, and no Today
// card counts one), a ski area's work orders (Today counts open and urgent ones, not overdue), and anything Today marks
// "Needs a look" rather than waiting for an answer. Add a count only where a Today card already defines it.
const { pool, one } = require('../db');
const { todayIn, nowIn } = require('./util');
const M = require('./modules');
const W = require('./waiting');

const MANAGERS = ['owner', 'manager'];
const isMgr = (a) => MANAGERS.includes(a.role);
/** The same rule as middleware/auth.js requireRole: owners and managers everywhere, and the roles listed. */
const has = (a, ...roles) => isMgr(a) || roles.includes(a.role) || (roles.includes('patrol') && Boolean(a.onPatrol));
// A mountain with Patrol and none of the front-desk or mountain apps is a patrol on its own (public/js/main.js patrolOnly).
const patrolOnly = (on) => on.has('patrol') && !['sell', 'conditions', 'rentals', 'school'].some((k) => on.has(k));
const toMs = (v) => Date.parse(`${String(v).slice(0, 19).replace(' ', 'T')}Z`);

/** Who is asking, and what their tenant has: { a (req.auth), on (Set of app keys), muni, tz }. Null for the read-only ski area login. */
async function setting(req) {
  const a = req.auth;
  if (!a || a.role === 'area') return null;
  const { on, org } = await M.stateOf(a.tenantId);
  const t = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [a.tenantId]);
  return { a, on, muni: org === 'municipality', tz: t.timezone };
}

/** May this person use Patrol at all? A patrol login taken off the roster may not (middleware/auth.js). */
const patrolOpen = (s) => s.on.has('patrol') && has(s.a, 'patrol') && !(s.a.role === 'patrol' && s.a.offRoster);

/**
 * The counts for the person behind this request: { <view key>: { n, says, alert? } }. says: the words a screen reader
 * hears after the number; alert: true shows it red (overdue). An app with nothing waiting has no entry.
 */
async function countsFor(req) {
  const s = await setting(req);
  const out = {};
  if (!s) return out;
  const { a, on, muni, tz } = s;
  const t = a.tenantId;
  const put = (key, n, says, alert) => { if (n > 0) out[key] = { n, says, ...(alert ? { alert: true } : {}) }; };
  /** Adds to an app's count (summed with what is there; the words of the first kept, or "waiting" when they differ). */
  const add = (key, n, says, alert) => { if (!(n > 0)) return; if (!out[key]) { put(key, n, says, alert); return; } out[key].n += n; if (out[key].says !== says) out[key].says = 'waiting'; if (alert) out[key].alert = true; };
  if (muni) {
    // Requests: new ones wait for the desk or a manager to decide what to do (routes/requests.js desk).
    if (on.has('requests') && has(a, 'counter')) put('requests', await W.newRequests(pool, t), 'new');
    // Trash and recycling: missed pickups nobody has decided on, for the desk and managers (Today: Missed pickups).
    // The key 'bulk' is shared: other Trash and recycling counts (the routes' go-backs) add to it with add('bulk', ...).
    if (on.has('solidwaste') && on.has('requests') && has(a, 'counter')) add('bulk', await W.missedPickups(pool, t), 'missed pickups waiting');
    // Work orders: overdue. A manager's is every overdue one; a crew member's is only what is assigned to them.
    if (on.has('assets') && isMgr(a)) put('works', (await W.workOrders(pool, t, todayIn(tz))).overdue, 'overdue', true);
    else if (on.has('assets') && a.role === 'staff' && a.staffId) {
      const mine = await require('./crewday').myWork(t, a.staffId, todayIn(tz));
      put('works', mine.filter((w) => w.overdue).length, 'overdue', true);
    }
    return out;
  }
  // A ski area.
  if (patrolOpen(s)) {
    const PA = require('./patrolaccess');
    const R = require('./review');
    if ((await PA.accessOf(pool, req)).features.has('view_cases')) {
      const group = await R.settingsOf(pool, t);
      const drafts = await W.patrolDrafts(pool, t, a.staffId);
      const waiting = (await R.canReview(pool, req, group)) ? await W.patrolWaiting(pool, t, a.userId, { notOwn: group.enabled }) : [];
      // Red when a report has waited longer than Today's "Reviews overdue" allows (lib/docscore.js).
      const late = require('./docscore').REVIEW_OVERDUE_HOURS * 3_600_000;
      const now = toMs(nowIn(tz));
      const overdue = waiting.some((r) => r.submitted_at && now - toMs(r.submitted_at) > late);
      put('patrol', drafts.length + waiting.length, drafts.length && waiting.length ? 'to sign off or review' : waiting.length ? 'to review' : 'to sign off', overdue);
    }
  }
  // Lessons: online requests wait for the desk (routes/schoolplus.js: the counter, supervisors and up, managers).
  if (on.has('school') && (has(a, 'counter') || require('./schoolaccess').atLeast(req, 'supervisor'))) put('school', await W.lessonRequests(pool, t), 'to answer');
  // Rentals: reservations held for pickup today, for the rental counter.
  if (on.has('rentals') && has(a, 'counter')) put('rentals', await W.rentalPickups(pool, t, todayIn(tz)), 'to hand out');
  return out;
}

/**
 * What this person may create, for the "+ New" menu: a list of item ids in menu order (public/js/newmenu.js knows each
 * one's words and address). Each rule is the one its create route applies, and its app must be on, so the menu never
 * offers a form the server would refuse.
 */
async function creatable(req) {
  const s = await setting(req);
  if (!s) return [];
  const { a, on, muni } = s;
  const out = [];
  const add = (id, ok) => { if (ok) out.push(id); };
  if (muni) {
    add('work_order', on.has('assets') && has(a, 'staff')); // routes/maintenance.js
    add('request', on.has('requests') && has(a, 'staff', 'counter')); // routes/requests.js: taken for a resident
    add('street_notice', on.has('requests') && has(a, 'staff') && await require('../routes/streetnotices').canSend(req)); // managers, and a crew lead a manager allowed
    add('bulk_booking', on.has('solidwaste') && has(a, 'counter')); // routes/bulkpickup.js office
    add('missed_pickup', on.has('solidwaste') && on.has('requests') && has(a, 'counter')); // routes/requests.js, the Missed pickup category
    add('main_break', on.has('water') && has(a, 'staff')); // routes/mainbreaks.js
    add('message', on.has('messages') && isMgr(a));
    return out;
  }
  const lone = patrolOnly(on);
  const director = require('./schoolaccess').isSchoolDirector(req); // a ski school director sells lessons only
  add('sale', on.has('sell') && has(a, 'counter'));
  add('lesson', on.has('sell') && on.has('school') && (has(a, 'counter') || director));
  add('rental', on.has('sell') && on.has('rentals') && has(a, 'counter'));
  add('incident', patrolOpen(s) && await require('./patrolaccess').can(pool, req, 'create_case'));
  add('work_order', on.has('conditions') && has(a, 'staff', 'patrol')); // routes/maintenance.js
  add('lost_item', !lone && has(a, 'counter', 'staff')); // routes/lostfound.js
  add('customer', !lone && has(a, 'counter', 'instructor')); // routes/people.js
  add('message', on.has('messages') && isMgr(a));
  // The Mountain calendar: managers add for everyone; a school director or a patrol lead for their own team.
  const who = await require('./mountaincal').viewer(pool, a);
  add('calendar_event', who.addFor === 'all' || who.addFor.length > 0);
  return out;
}

module.exports = { countsFor, creatable };
