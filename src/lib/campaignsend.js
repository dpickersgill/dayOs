'use strict';

// Writing and sending a message to customers, as one person (a manager), with every rule the Messages screen keeps:
// the Messages app on, email set up, the mountain's postal address in every marketing email, the audience decided by
// the consent history (lib/messaging.js), an unsubscribe link in each email, and a claim so a message cannot go twice.
// The Messages routes and an approved draft (the conditions writer's passholder email) both send through here.
const { pool, one } = require('../db');
const { conflict, forbidden } = require('./errors');
const { audit } = require('./audit');
const { roleAllows } = require('./roleallows');
const mailer = require('./mailer');
const sms = require('./sms');
const messaging = require('./messaging');
const mailkinds = require('./mailkinds');
const modules = require('./modules');

const SEND_ROLES = ['manager']; // and the owner

/** Refuses unless this person may send messages to customers here. */
async function mayMessage(req) {
  if (!roleAllows(req.auth, SEND_ROLES)) throw forbidden('Only managers send messages to customers.');
  if (!(await modules.enabledKeys(req.auth.tenantId)).includes('messages')) throw forbidden('Messages is not on for your mountain.');
}

/** Saves a draft message. b: { name, channel, subject, body, audience } (checked by the caller's schema). Returns its id. */
async function createAs(req, b) {
  await mayMessage(req);
  const [r] = await pool.query('INSERT INTO campaigns (tenant_id, name, channel, subject, body, audience, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [req.auth.tenantId, b.name, b.channel, b.channel === 'email' ? b.subject : null, b.body, b.audience, req.auth.userId]);
  await audit(pool, req, 'campaign_create', 'campaigns', r.insertId, { channel: b.channel, audience: b.audience });
  return r.insertId;
}

/** Why a message cannot go right now, or null. */
async function blockedFor(tenantId, channel) {
  if (channel === 'email' && !mailer.enabled()) return 'Email is not set up yet';
  if (channel === 'sms' && !sms.enabled()) return 'Text messages are not set up yet';
  // Marketing email must carry the mountain's postal address (CAN-SPAM); refused before anything is sent.
  if (channel === 'email' && !(await mailkinds.postalAddress(pool, tenantId))) return mailkinds.NO_ADDRESS;
  return null;
}

/** Sends a draft message to its audience. Returns { total, sent, failed, held }. */
async function sendAs(req, campaignId, base) {
  await mayMessage(req);
  const c = await one(pool, 'SELECT * FROM campaigns WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, campaignId]);
  if (!c) throw conflict('That message is gone');
  const t = await one(pool, 'SELECT * FROM tenants WHERE id = ?', [req.auth.tenantId]);
  const why = await blockedFor(t.id, c.channel);
  if (why) throw conflict(why);
  // Claim it so a double click cannot send twice.
  const [claim] = await pool.query("UPDATE campaigns SET status = 'sending' WHERE tenant_id = ? AND id = ? AND status = 'draft'", [t.id, c.id]);
  if (!claim.affectedRows) throw conflict('This message has already been sent');
  let result;
  try { result = await messaging.sendCampaign(t, c, base); } catch (err) {
    await pool.query("UPDATE campaigns SET status = 'draft' WHERE tenant_id = ? AND id = ?", [t.id, c.id]);
    throw err;
  }
  await pool.query("UPDATE campaigns SET status = 'sent', sent_at = NOW(), total = ?, sent = ?, failed = ?, held = ? WHERE tenant_id = ? AND id = ?", [result.total, result.sent, result.failed, result.held || 0, t.id, c.id]);
  await audit(pool, req, 'campaign_send', 'campaigns', c.id, result);
  return result;
}

module.exports = { createAs, sendAs, mayMessage, blockedFor, SEND_ROLES };
