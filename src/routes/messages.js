'use strict';

// Messages to customers: write one, see who it would reach, send a test, send it, and read what happened.
// Only managers send. Who is reached is decided by the consent history, never by the screen.
const express = require('express');
const { pool, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId } = require('../lib/util');
const { notFound, conflict, bad } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { baseUrl } = require('../lib/baseurl');
const mailer = require('../lib/mailer');
const sms = require('../lib/sms');
const messaging = require('../lib/messaging');

const router = express.Router();
const publicRouter = express.Router();
const mgr = requireRole('manager');
const tenantOf = (req) => one(pool, 'SELECT * FROM tenants WHERE id = ?', [req.auth.tenantId]);
const AUD = messaging.AUDIENCES.map((a) => a.key);

router.get('/status', mgr, async (_req, res) => {
  res.json({ email_ready: mailer.enabled(), sms_ready: sms.enabled(), audiences: messaging.AUDIENCES, max_recipients: messaging.MAX_RECIPIENTS });
});

const previewBody = z.object({ channel: z.enum(['email', 'sms']), audience: z.enum(AUD) });
router.post('/preview', mgr, validate(previewBody), async (req, res) => {
  const t = await tenantOf(req);
  const list = await messaging.audienceOf(t, req.body.channel, req.body.audience);
  res.json({ count: Math.min(list.length, messaging.MAX_RECIPIENTS), more_than_limit: list.length > messaging.MAX_RECIPIENTS, sample: list.slice(0, 5).map((p) => p.first_name) });
});

const campaignBody = z.object({
  name: z.string().trim().min(1).max(120),
  channel: z.enum(['email', 'sms']),
  subject: z.string().trim().max(200).nullable().optional(),
  body: z.string().trim().min(1).max(2000),
  audience: z.enum(AUD),
}).superRefine((v, ctx) => {
  if (v.channel === 'email' && !(v.subject || '').trim()) ctx.addIssue({ code: 'custom', path: ['subject'], message: 'An email needs a subject' });
  if (v.channel === 'sms' && v.body.length > 320) ctx.addIssue({ code: 'custom', path: ['body'], message: 'Keep a text message under 320 characters' });
});

router.get('/campaigns', mgr, async (req, res) => {
  res.json({ data: await rows(pool, 'SELECT id, name, channel, audience, status, created_at, sent_at, total, sent, failed FROM campaigns WHERE tenant_id = ? ORDER BY id DESC LIMIT 100', [req.auth.tenantId]) });
});

router.post('/campaigns', mgr, validate(campaignBody), async (req, res) => {
  const b = req.body;
  const [r] = await pool.query('INSERT INTO campaigns (tenant_id, name, channel, subject, body, audience, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [req.auth.tenantId, b.name, b.channel, b.channel === 'email' ? b.subject : null, b.body, b.audience, req.auth.userId]);
  await audit(pool, req, 'campaign_create', 'campaigns', r.insertId, { channel: b.channel, audience: b.audience });
  res.status(201).json(await one(pool, 'SELECT * FROM campaigns WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, r.insertId]));
});

async function campaign(req) {
  const c = await one(pool, 'SELECT * FROM campaigns WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!c) throw notFound('Message');
  return c;
}

router.get('/campaigns/:id', mgr, async (req, res) => {
  const c = await campaign(req);
  const problems = await rows(pool, "SELECT to_addr, error FROM message_log WHERE tenant_id = ? AND campaign_id = ? AND status = 'failed' ORDER BY id LIMIT 20", [req.auth.tenantId, c.id]);
  res.json({ ...c, problems });
});

router.put('/campaigns/:id', mgr, validate(campaignBody), async (req, res) => {
  const c = await campaign(req);
  if (c.status !== 'draft') throw conflict('A message that has gone out cannot be changed');
  const b = req.body;
  await pool.query('UPDATE campaigns SET name = ?, channel = ?, subject = ?, body = ?, audience = ? WHERE tenant_id = ? AND id = ?', [b.name, b.channel, b.channel === 'email' ? b.subject : null, b.body, b.audience, req.auth.tenantId, c.id]);
  res.json(await one(pool, 'SELECT * FROM campaigns WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, c.id]));
});

router.delete('/campaigns/:id', mgr, async (req, res) => {
  const c = await campaign(req);
  if (c.status !== 'draft') throw conflict('A message that has gone out stays on record');
  await pool.query('DELETE FROM campaigns WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, c.id]);
  res.json({ ok: true });
});

/** A test goes to the signed-in manager's own email, or to a phone number they type. It is not counted and not logged against a customer. */
router.post('/campaigns/:id/test', mgr, validate(z.object({ phone: z.string().max(40).optional() })), async (req, res) => {
  const c = await campaign(req);
  const t = await tenantOf(req);
  const me = await one(pool, 'SELECT email FROM users WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, req.auth.userId]);
  const person = { id: 0, first_name: 'Friend' };
  let r;
  if (c.channel === 'email') {
    if (!mailer.enabled()) throw conflict('Email is not set up yet');
    const m = messaging.renderEmail(t, c, person, baseUrl(req), `${baseUrl(req)}/api/v1/public/unsub/example`);
    r = await mailer.send({ tenantId: req.auth.tenantId, to: me.email, fromName: t.name, replyTo: t.reply_to || undefined, subject: `[Test] ${m.subject}`, text: m.text, html: m.html, tag: 'msg-test' });
  } else {
    if (!sms.enabled()) throw conflict('Text messages are not set up yet');
    if (!req.body.phone) throw bad('Enter the phone number to send the test to');
    r = await sms.send({ tenantId: req.auth.tenantId, to: req.body.phone, body: `[Test] ${messaging.renderSms(t, c, person)}` });
  }
  if (!r.ok) throw conflict(r.error);
  await audit(pool, req, 'campaign_test', 'campaigns', c.id, null);
  res.json({ ok: true, to: c.channel === 'email' ? me.email : req.body.phone });
});

router.post('/campaigns/:id/send', mgr, validate(z.object({ confirm: z.literal(true) })), async (req, res) => {
  const c = await campaign(req);
  const t = await tenantOf(req);
  if (c.channel === 'email' && !mailer.enabled()) throw conflict('Email is not set up yet');
  if (c.channel === 'sms' && !sms.enabled()) throw conflict('Text messages are not set up yet');
  // Claim it so a double click cannot send twice.
  const [claim] = await pool.query("UPDATE campaigns SET status = 'sending' WHERE tenant_id = ? AND id = ? AND status = 'draft'", [t.id, c.id]);
  if (!claim.affectedRows) throw conflict('This message has already been sent');
  let result;
  try { result = await messaging.sendCampaign(t, c, baseUrl(req)); } catch (err) {
    await pool.query("UPDATE campaigns SET status = 'draft' WHERE tenant_id = ? AND id = ?", [t.id, c.id]);
    throw err;
  }
  await pool.query("UPDATE campaigns SET status = 'sent', sent_at = NOW(), total = ?, sent = ?, failed = ? WHERE tenant_id = ? AND id = ?", [result.total, result.sent, result.failed, t.id, c.id]);
  await audit(pool, req, 'campaign_send', 'campaigns', c.id, result);
  res.json(result);
});

/** What was sent to one customer, for their record. */
router.get('/person/:id', requireRole('manager', 'counter', 'instructor'), async (req, res) => {
  res.json({ data: await rows(pool, `SELECT m.id, m.kind, m.channel, m.status, m.created_at, c.name AS campaign FROM message_log m LEFT JOIN campaigns c ON c.id = m.campaign_id AND c.tenant_id = m.tenant_id
    WHERE m.tenant_id = ? AND m.person_id = ? ORDER BY m.id DESC LIMIT 20`, [req.auth.tenantId, paramId(req)]) });
});

// ---------------------------------------------------------------- unsubscribe link (no sign-in)
const page = (title, inner) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;background:#edf1f3;color:#12303a;display:grid;place-items:center;min-height:100vh;margin:0}main{background:#fff;border:1px solid #d3dce1;border-radius:8px;padding:28px;max-width:420px;width:calc(100% - 32px)}button{font:inherit;font-weight:700;background:#1b5fc1;color:#fff;border:0;border-radius:6px;padding:12px 18px;cursor:pointer}</style></head><body><main>${inner}</main></body></html>`;
publicRouter.get('/unsub/:token', (req, res) => {
  const t = messaging.readUnsub(req.params.token);
  if (!t) return res.status(404).type('html').send(page('Link not found', '<h1>This link does not work</h1><p>It may have been copied wrongly. Reply to the message and ask us to take you off the list.</p>'));
  res.type('html').send(page('Stop messages', `<h1>Stop these ${t.channel === 'sms' ? 'texts' : 'emails'}?</h1><p>We will stop sending you news and offers. You will still get messages about your own rentals and passes.</p><form method="post"><button type="submit">Yes, stop them</button></form>`));
});
publicRouter.post('/unsub/:token', express.urlencoded({ extended: false }), async (req, res) => {
  const t = messaging.readUnsub(req.params.token);
  if (!t) return res.status(404).type('html').send(page('Link not found', '<h1>This link does not work</h1>'));
  await messaging.unsubscribe(t);
  res.type('html').send(page('Stopped', '<h1>You are off the list</h1><p>We will not send you news and offers any more. Thank you.</p>'));
});

// The automatic reminders run inside the daily job (see followpublic.js).

module.exports = { router, publicRouter };
