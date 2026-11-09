// STAND-IN, replaced at merge.
'use strict';

// The real module comes from help/guest (table dispatch_messages). This file exists only so
// help/sms builds and tests against the agreed interface; the merge takes help/guest's file whole.
//   toGuest(db, call, body, staff)     saves the message, shows it on the status page, and texts it if the guest gave a
//                                      phone and texts are set up
//   fromGuest(db, call, body, channel) saves a message from the guest ('page' or 'sms')
// Here the messages are kept in memory (_log) and nothing is written to the database.

const SMS = require('./sms');

const _log = [];

async function toGuest(db, call, body, staff) {
  const row = { call_id: Number(call.id), tenant_id: Number(call.tenant_id), direction: 'to_guest', channel: call.caller_phone ? 'sms' : 'page', body: String(body), sent_by: staff ? staff.userId || staff.id || null : null, at: new Date(), delivered: 0 };
  _log.push(row);
  if (call.caller_phone && SMS.enabled()) {
    const r = await SMS.send({ tenantId: call.tenant_id, to: call.caller_phone, body: String(body) });
    row.delivered = r.ok ? 1 : 0;
    return { id: _log.length, texted: Boolean(r.ok), error: r.ok ? null : r.error };
  }
  return { id: _log.length, texted: false };
}

async function fromGuest(db, call, body, channel) {
  _log.push({ call_id: Number(call.id), tenant_id: Number(call.tenant_id), direction: 'from_guest', channel, body: String(body), sent_by: null, at: new Date(), delivered: 1 });
  return { id: _log.length };
}

module.exports = { toGuest, fromGuest, _log };
