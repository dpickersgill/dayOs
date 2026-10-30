'use strict';

// The Good Day in the platform console (mounted at /platform/goodday, behind the console's sign-in). See lib/goodday.js.
//   GET  /                     counts, every issue with how many got it, the settings, and the signed-in operator's email
//   GET  /subscribers          the list (?status=pending|confirmed|unsubscribed, ?q=)
//   GET  /subscribers.csv      the same as a spreadsheet, consent included
//   PUT  /settings             the sender name and the postal address every issue carries
//   POST /preview              the email for an issue, as it will look (nothing is sent)
//   POST /test                 the email to one address, marked [Test]
//   POST /send                 to every confirmed subscriber who has not had it. The second check: type issue-N.
const express = require('express');
const { pool, one } = require('../db');
const { z, validate } = require('../lib/util');
const { bad } = require('../lib/errors');
const { toCsv } = require('../lib/csv');
const GD = require('../lib/goodday');

const origin = (req) => require('./site').canonicalOrigin(req);
const issueBody = { n: z.number().int().positive(), subject: z.string().trim().max(200).optional().default(''), intro: z.string().trim().max(1000).optional().default('') };

module.exports = function goodDayRouter(log) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const me = req.operatorId ? await one(pool, 'SELECT email FROM platform_operators WHERE id = ?', [req.operatorId]) : null;
    res.json({
      counts: await GD.counts(), issues: (await GD.issueStatus()).map((i) => ({ ...i, default_subject: GD.defaultSubject(i) })),
      settings: await GD.settings(), my_email: me ? me.email : null, roles: GD.ROLES, email_on: require('../lib/mailer').enabled(), site: origin(req),
    });
  });

  const listQuery = (q) => ({ status: ['pending', 'confirmed', 'unsubscribed'].includes(q.status) ? q.status : '', q: String(q.q || '').slice(0, 100) });
  router.get('/subscribers', async (req, res) => res.json({ data: await GD.subscribers({ ...listQuery(req.query), limit: 1000 }) }));
  router.get('/subscribers.csv', async (req, res) => {
    const list = await GD.subscribers({ ...listQuery(req.query), limit: 50000 });
    await log(pool, req, null, 'goodday_export', { rows: list.length });
    const when = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) : '');
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="good-day-subscribers-${new Date().toISOString().slice(0, 10)}.csv"` });
    res.send(toCsv(['email', 'name', 'role', 'status', 'signed_up_on', 'consent_at_utc', 'consent_wording', 'consent_ip', 'confirmed_at_utc', 'unsubscribed_at_utc', 'unsubscribed_how'],
      list.map((s) => ({ email: s.email, name: s.name, role: GD.ROLES[s.role] || s.role, status: s.status, signed_up_on: s.source, consent_at_utc: when(s.consent_at), consent_wording: s.consent_wording,
        consent_ip: s.consent_ip, confirmed_at_utc: when(s.confirmed_at), unsubscribed_at_utc: when(s.unsubscribed_at), unsubscribed_how: s.unsubscribe_how }))));
  });

  router.put('/settings', validate(z.object({ from_name: z.string().trim().min(2).max(100), postal_address: z.string().trim().min(8, 'A postal address is required in every issue (CAN-SPAM)').max(300) })), async (req, res) => {
    await GD.settings();
    await pool.query('UPDATE goodday_settings SET from_name = ?, postal_address = ?, updated_by = ? WHERE id = 1', [req.body.from_name, req.body.postal_address, req.operator || null]);
    await log(pool, req, null, 'goodday_settings', { from_name: req.body.from_name });
    res.json({ ok: true });
  });

  router.post('/preview', validate(z.object(issueBody)), async (req, res) => {
    const m = GD.preview({ ...req.body, origin: origin(req), postal: (await GD.settings()).postal_address });
    if (!m) throw bad('That issue is not in the list');
    res.json(m);
  });

  router.post('/test', validate(z.object({ ...issueBody, to: z.string().trim().email() })), async (req, res) => {
    const r = await GD.sendTest({ ...req.body, origin: origin(req) });
    if (!r.ok) throw bad(r.error || 'The test did not go');
    await log(pool, req, null, 'goodday_test', { issue: req.body.n, to: req.body.to });
    res.json({ ok: true });
  });

  router.post('/send', validate(z.object({ ...issueBody, confirm: z.string().trim() })), async (req, res) => {
    if (req.body.confirm.toLowerCase() !== `issue-${req.body.n}`) throw bad(`Type issue-${req.body.n} to confirm`);
    const r = await GD.sendAll({ ...req.body, origin: origin(req), operator: req.operator });
    if (!r.ok) throw bad(r.error);
    await log(pool, req, null, 'goodday_send', { issue: req.body.n, sent: r.sent, failed: r.failed, left: r.left });
    res.json(r);
  });

  return router;
};
