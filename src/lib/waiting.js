'use strict';

// What waits on someone, kept in one place (release 2026.11.21). Today's cards and the counts beside the menu's apps
// (lib/navcounts.js) both read these, so the menu and Today can never disagree: a number is worked out here once and
// each screen only chooses how to show it. Every query is for one tenant, uses an index that starts with tenant_id, and
// returns a number or a short list. Add a function here before adding a count to the menu; never count in two places.
//
//   workOrders      routes/maintenance.js   Today's work order cards (a municipality's managers)
//   newRequests     routes/requests.js      Today's "New requests" card
//   lessonRequests  routes/board.js         the ski Today's Lessons tile and its "waiting for an answer" line
//   rentalPickups   routes/board.js         the ski Today's Rentals tile: reservations to pick up today
//   patrolDrafts,
//   patrolWaiting   routes/patrolplus.js    Patrol's own home page: My open cases, Waiting for review
// A crew member's own work orders are lib/crewday.js myWork (My work today).
const { rows, one } = require('../db');
const { addDays } = require('./util');

const n = (v) => Number(v || 0);

/** A tenant's work orders on a day: { open_n, overdue (open and past its due date), urgent, done_today }. */
async function workOrders(db, tenantId, today) {
  const c = await one(db, `SELECT SUM(status NOT IN ('done','cancelled')) AS open_n, SUM(status NOT IN ('done','cancelled') AND due_date < ?) AS overdue,
      SUM(status NOT IN ('done','cancelled') AND priority = 'urgent') AS urgent, SUM(status = 'done' AND completed_at >= ? AND completed_at < ?) AS done_today
    FROM work_orders WHERE tenant_id = ?`, [today, `${today} 00:00:00`, `${addDays(today, 1)} 00:00:00`, tenantId]);
  return { open_n: n(c.open_n), overdue: n(c.overdue), urgent: n(c.urgent), done_today: n(c.done_today) };
}

/** Resident requests nobody has decided on yet (status new). */
async function newRequests(db, tenantId) {
  return n((await one(db, "SELECT COUNT(*) AS n FROM requests WHERE tenant_id = ? AND status = 'new'", [tenantId])).n);
}

/** Online lesson requests waiting for the school's answer. */
async function lessonRequests(db, tenantId) {
  return n((await one(db, "SELECT COUNT(*) AS n FROM lesson_requests WHERE tenant_id = ? AND status = 'pending'", [tenantId])).n);
}

/** Rental reservations held for pickup on this day (not yet handed out). */
async function rentalPickups(db, tenantId, today) {
  return n((await one(db, "SELECT COUNT(*) AS n FROM rental_reservations WHERE tenant_id = ? AND status = 'held' AND pickup_on = ?", [tenantId, today])).n);
}

/**
 * Patrol: the draft reports on cases this person responded to, newest first (theirs to finish and sign off).
 * cols: the columns the caller shows (the home page's case rows); the count needs only the id.
 */
async function patrolDrafts(db, tenantId, staffId, cols = 'i.id') {
  if (!staffId) return [];
  return rows(db, `SELECT ${cols} FROM incidents i WHERE i.tenant_id = ? AND i.report_state = 'draft' AND EXISTS (SELECT 1 FROM incident_responders r WHERE r.tenant_id = i.tenant_id AND r.incident_id = i.id AND r.staff_id = ? AND r.voided_at IS NULL) ORDER BY i.occurred_at DESC LIMIT 20`, [tenantId, staffId]);
}

/**
 * Patrol: the signed-off reports waiting for a reviewer, oldest first. With a review group (notOwn), a reviewer's own
 * reports are left out: someone else reviews those, so they are not in their own queue.
 */
async function patrolWaiting(db, tenantId, userId, { notOwn = false } = {}, cols = 'i.id, i.submitted_at') {
  return rows(db, `SELECT ${cols} FROM incidents i WHERE i.tenant_id = ? AND i.report_state = 'submitted'${notOwn ? ' AND (i.submitted_by IS NULL OR i.submitted_by <> ?)' : ''} ORDER BY i.submitted_at LIMIT 30`, notOwn ? [tenantId, userId] : [tenantId]);
}

module.exports = { workOrders, newRequests, lessonRequests, rentalPickups, patrolDrafts, patrolWaiting };
