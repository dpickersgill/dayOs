'use strict';

// Outreach in the platform console (mounted at /platform/outreach, behind the console's sign-in). See lib/outreach.js.
//   GET  /                       the mailbox, settings, templates, drafts waiting for approval, and every sequence
//   PUT  /settings, /templates/:step
//   POST /enroll                 start outreach to people (prospect contacts with an email address)
//   PATCH /messages/:id          edit a draft; POST /messages/:id/approve, /messages/:id/redraft
//   GET  /sequences/:id          one sequence: every email, and what comes next
//   POST /sequences/:id/stop     stop it now
//   POST /run                    send what is due now (inside the sending hours unless force)
//   POST /test                   a test email to yourself
const express = require('express');
const { pool, rows, one } = require('../db');
const { z, validate, paramId } = require('../lib/util');
const { bad, notFound, AppError } = require('../lib/errors');
const O = require('../lib/outreach');
const gmail = require('../lib/gmail');

module.exports = function outreachRouter(log) {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    const t = gmail.current();
    const s = await O.settings();
    const drafts = await rows(pool, `SELECT m.id, m.sequence_id, m.subject, m.body, m.drafted_by, m.created_at, m.error, sq.email, sq.prospect_id, p.name AS mountain, c.name AS person, c.title
      FROM outreach_messages m JOIN outreach_sequences sq ON sq.id = m.sequence_id JOIN prospects p ON p.id = sq.prospect_id JOIN prospect_contacts c ON c.id = sq.contact_id
      WHERE m.status = 'draft' AND sq.status = 'pending' ORDER BY m.id`);
    const seqs = await rows(pool, `SELECT sq.id, sq.prospect_id, sq.email, sq.status, sq.step, sq.next_at, sq.started_at, sq.stopped_at, sq.stop_reason, p.name AS mountain, p.state, c.name AS person,
        (SELECT COUNT(*) FROM outreach_messages m WHERE m.sequence_id = sq.id AND m.status = 'sent') AS sent,
        (SELECT m.status FROM outreach_messages m WHERE m.sequence_id = sq.id AND m.step = 1 ORDER BY m.id DESC LIMIT 1) AS first_status,
        (SELECT m.error FROM outreach_messages m WHERE m.sequence_id = sq.id AND m.error IS NOT NULL ORDER BY m.id DESC LIMIT 1) AS last_error
      FROM outreach_sequences sq JOIN prospects p ON p.id = sq.prospect_id JOIN prospect_contacts c ON c.id = sq.contact_id ORDER BY FIELD(sq.status, 'pending','active','nurture','replied','bounced','not_interested','stopped'), sq.next_at, sq.id DESC LIMIT 1000`);
    const [[today]] = await pool.query("SELECT COUNT(*) AS n FROM outreach_messages WHERE status = 'sent' AND sent_at >= UTC_TIMESTAMP() - INTERVAL 1 DAY");
    const [[supp]] = await pool.query('SELECT COUNT(*) AS n FROM outreach_suppress');
    res.json({
      mailbox: { ready: t.ready(), sender: t.sender() || null, link_base: O.linkBase() || null },
      settings: s, templates: Object.values(await O.templates()), fields: O.FIELDS, steps: O.STEPS,
      drafts, sequences: seqs, sent_last_day: Number(today.n), suppressed: Number(supp.n),
      assistant: Boolean(require('../config').assistant.on),
    });
  });

  router.put('/settings', validate(z.object({
    sender_name: z.string().trim().min(2).max(100), company_line: z.string().trim().max(150).nullable().optional(),
    postal_address: z.string().trim().min(8, 'A postal address is required in every email (CAN-SPAM)').max(300),
    daily_cap: z.number().int().min(1).max(200), send_from_hour: z.number().int().min(0).max(23), send_to_hour: z.number().int().min(1).max(24),
    timezone: z.string().max(40), offsets: z.array(z.number().int().min(0).max(365)).length(O.STEPS), nurture_days: z.number().int().min(14).max(365),
    use_ai: z.boolean(), paused: z.boolean(),
  })), async (req, res) => {
    const b = req.body;
    try { new Intl.DateTimeFormat('en-US', { timeZone: b.timezone }); } catch (_) { throw bad('That time zone is not known'); }
    if (b.send_to_hour <= b.send_from_hour) throw bad('The sending hours end before they start');
    if (b.offsets[0] !== 0 || b.offsets.some((d, i) => i && d <= b.offsets[i - 1])) throw bad('The first email goes on day 0 and each later one on a later day');
    await O.settings();
    await pool.query('UPDATE outreach_settings SET sender_name = ?, company_line = ?, postal_address = ?, daily_cap = ?, send_from_hour = ?, send_to_hour = ?, timezone = ?, offsets = ?, nurture_days = ?, use_ai = ?, paused = ? WHERE id = 1',
      [b.sender_name, b.company_line || null, b.postal_address, b.daily_cap, b.send_from_hour, b.send_to_hour, b.timezone, JSON.stringify(b.offsets), b.nurture_days, b.use_ai ? 1 : 0, b.paused ? 1 : 0]);
    await log(pool, req, null, 'outreach_settings', { paused: b.paused, daily_cap: b.daily_cap });
    res.json({ ok: true });
  });

  router.put('/templates/:step', validate(z.object({ subject: z.string().trim().min(3).max(200), body: z.string().trim().min(20).max(4000) })), async (req, res) => {
    const step = Number(req.params.step);
    if (!Number.isInteger(step) || step < 1 || step > O.NURTURE) throw notFound('Template');
    const unknown = [...`${req.body.subject} ${req.body.body}`.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).filter((k) => !O.FIELDS.includes(k));
    if (unknown.length) throw bad(`Unknown field${unknown.length === 1 ? '' : 's'}: ${[...new Set(unknown)].map((k) => `{${k}}`).join(', ')}`);
    await pool.query('INSERT INTO outreach_templates (step, subject, body) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE subject = VALUES(subject), body = VALUES(body)', [step, req.body.subject, req.body.body]);
    await log(pool, req, null, 'outreach_template', { step });
    res.json({ ok: true });
  });

  router.post('/enroll', validate(z.object({ contact_ids: z.array(z.number().int().positive()).min(1).max(200) })), async (req, res) => {
    const s = await O.settings();
    if (!s.sender_name || !s.postal_address) throw bad('Fill in your name and postal address under Outreach, Settings first. Every email needs them.');
    const out = [];
    for (const id of req.body.contact_ids) out.push({ contact_id: id, ...(await O.enroll(pool, id, req.operator)) });
    await log(pool, req, null, 'outreach_enroll', { started: out.filter((x) => x.id).length, skipped: out.filter((x) => x.skipped).length });
    res.json({ data: out });
  });

  const draftOf = async (req) => {
    const m = await one(pool, "SELECT m.*, sq.status AS seq_status FROM outreach_messages m JOIN outreach_sequences sq ON sq.id = m.sequence_id WHERE m.id = ?", [paramId(req)]);
    if (!m) throw notFound('Draft');
    if (m.status !== 'draft' || m.seq_status !== 'pending') throw new AppError(409, 'That email is no longer a draft');
    return m;
  };

  router.patch('/messages/:id', validate(z.object({ subject: z.string().trim().min(3).max(200), body: z.string().trim().min(20).max(4000) })), async (req, res) => {
    const m = await draftOf(req);
    await pool.query("UPDATE outreach_messages SET subject = ?, body = ?, drafted_by = 'operator' WHERE id = ?", [req.body.subject, req.body.body, m.id]);
    res.json({ ok: true });
  });

  router.post('/messages/:id/redraft', async (req, res) => {
    const m = await draftOf(req);
    const seq = await one(pool, 'SELECT * FROM outreach_sequences WHERE id = ?', [m.sequence_id]);
    const d = await O.draftFirst(pool, seq, await O.settings());
    await pool.query('UPDATE outreach_messages SET subject = ?, body = ?, drafted_by = ? WHERE id = ?', [d.subject, d.body, d.by, m.id]);
    res.json({ subject: d.subject, body: d.body, drafted_by: d.by });
  });

  // Approving sends it on the next run inside the sending hours; the follow-ups then go on their own.
  router.post('/messages/:id/approve', async (req, res) => {
    const m = await draftOf(req);
    await pool.query("UPDATE outreach_messages SET status = 'approved', approved_by = ? WHERE id = ?", [req.operator || null, m.id]);
    await pool.query("UPDATE outreach_sequences SET status = 'active', next_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'pending'", [m.sequence_id]);
    await log(pool, req, null, 'outreach_approve', { message: m.id });
    res.json({ ok: true });
  });

  router.get('/sequences/:id', async (req, res) => {
    const seq = await one(pool, `SELECT sq.*, p.name AS mountain, c.name AS person, c.title FROM outreach_sequences sq JOIN prospects p ON p.id = sq.prospect_id JOIN prospect_contacts c ON c.id = sq.contact_id WHERE sq.id = ?`, [paramId(req)]);
    if (!seq) throw notFound('Sequence');
    const messages = await rows(pool, 'SELECT id, step, subject, body, status, drafted_by, approved_by, sent_at, error FROM outreach_messages WHERE sequence_id = ? ORDER BY step, id', [seq.id]);
    // What the follow-ups will say, written from today's templates (they are written for real when they go).
    const s = await O.settings(); const tpl = await O.templates(); const ctx = await O.contextFor(pool, seq, s);
    ctx.first_subject = seq.first_subject || (messages[0] && messages[0].subject) || '';
    const upcoming = [];
    for (let step = Math.max(seq.step + 1, 2); step <= O.STEPS; step++) upcoming.push({ step, day: s.offsets[step - 1], subject: O.render(tpl[step].subject, ctx), body: O.render(tpl[step].body, ctx) });
    res.json({ ...seq, token: undefined, messages, upcoming, footer: O.footer(s, seq) });
  });

  router.post('/sequences/:id/stop', async (req, res) => {
    const seq = await one(pool, 'SELECT id FROM outreach_sequences WHERE id = ?', [paramId(req)]);
    if (!seq) throw notFound('Sequence');
    await O.stop(pool, seq.id, 'stopped', `Stopped by ${req.operator || 'an operator'}`);
    await log(pool, req, null, 'outreach_stop', { sequence: seq.id });
    res.json({ ok: true });
  });

  router.post('/run', validate(z.object({ force: z.boolean().optional() })), async (req, res) => {
    const out = await O.runDue({ force: Boolean(req.body.force) });
    await log(pool, req, null, 'outreach_run', out);
    res.json(out);
  });

  router.post('/test', validate(z.object({ to: z.string().trim().email() })), async (req, res) => {
    const t = gmail.current();
    if (!t.ready()) throw bad('The outreach mailbox is not connected yet (OUTREACH_GMAIL_KEY and OUTREACH_SENDER)');
    const s = await O.settings();
    try {
      await t.send({ fromName: s.sender_name || 'Verdynt/OS', to: req.body.to, subject: 'Verdynt/OS outreach test', text: `This is a test from the Verdynt/OS console. If it arrived, the outreach mailbox works.\n${O.footer(s, { token: 'test' })}` });
    } catch (err) { throw bad(err.message); }
    res.json({ ok: true });
  });

  return router;
};
