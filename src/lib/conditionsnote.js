'use strict';

// The public note on a day (calendar_days.notes): the line guests read on the conditions feed for the mountain's website
// ("Night skiing until 9", "Six inches overnight, groomers on every blue"). Managers set it with the rest of the day;
// lift staff, who keep the lifts and trails current through the morning, may set the note on its own (2026.11, the
// conditions writer: whoever approves the morning draft publishes it here, through this one function).
const { one } = require('../db');
const { forbidden, bad } = require('./errors');
const { audit } = require('./audit');
const { roleAllows } = require('./roleallows');
const modules = require('./modules');

const NOTE_ROLES = ['manager', 'staff']; // and the owner
const MAX = 500;

/** Sets the day's public note as the person in req. A day not set yet is added as closed, which is what the feed shows for it. */
async function setNote(db, req, date, notes) {
  if (!roleAllows(req.auth, NOTE_ROLES)) throw forbidden('Your role cannot do that');
  if (!(await modules.enabledKeys(req.auth.tenantId)).includes('conditions')) throw forbidden('Lifts and trails is not on for your mountain');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw bad('Use YYYY-MM-DD');
  const text = notes === null || notes === undefined ? null : String(notes).replace(/\s+/g, ' ').trim().slice(0, MAX) || null;
  await db.query(`INSERT INTO calendar_days (tenant_id, on_date, status, notes) VALUES (?, ?, 'closed', ?)
    ON DUPLICATE KEY UPDATE notes = VALUES(notes)`, [req.auth.tenantId, date, text]);
  await audit(db, req, 'set_day_note', 'calendar_days', null, { date, notes: text });
  return one(db, 'SELECT on_date, status, open_time, close_time, notes FROM calendar_days WHERE tenant_id = ? AND on_date = ?', [req.auth.tenantId, date]);
}

module.exports = { setNote, NOTE_ROLES, MAX };
