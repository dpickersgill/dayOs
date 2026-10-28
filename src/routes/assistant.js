'use strict';

// The Verdynt/OS Assistant (lib/assistant.js). Staff: ask, rate an answer, send it to Verdynt/OS support, and managers
// set it up. Guests (Assistant Plus): ask on the pages the mountain turned it on for, and contact the mountain.
const express = require('express');
const { pool, rows, one } = require('../db');
const { z, validate, paramId } = require('../lib/util');
const { AppError, notFound } = require('../lib/errors');
const { requireRole, MANAGER_ROLES } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const config = require('../config');
const mailer = require('../lib/mailer');
const A = require('../lib/assistant');
const V = require('../lib/version');
const modulesLib = require('../lib/modules');
const PP = require('../lib/programplus');
const PS = require('../lib/programsessions');

const router = express.Router();
const publicRouter = express.Router();

const perPerson = rateLimit({ windowMs: 3_600_000, max: Number(process.env.ASSISTANT_RATE_LIMIT) || 60, message: 'That is a lot of questions this hour. Help still works, and the assistant is back shortly.', keyOf: (req) => `a:${req.auth.tenantId}:${req.auth.userId}` });
const history = z.array(z.object({ q: z.string().max(1000), a: z.string().max(4000).nullable().optional() })).max(6).optional();

/** Is it on for this person? Tells the screen whether to show the Ask button, and what Assistant Plus adds. */
router.get('/', async (req, res) => {
  const s = await A.settingsOf(pool, req.auth.tenantId);
  const mods = await modulesLib.enabledKeys(req.auth.tenantId);
  res.json({ on: config.assistant.on && s.staff_on, plus: mods.includes('assistant_plus'), support_email: config.site.supportEmail });
});

/**
 * The earlier questions a follow-up builds on: this person's own answers from the last few hours, read back from the
 * log by id. Text a screen sends is never used for this: on a shared device it could be the last person's answers (an
 * owner's sales figures carried into a clerk's question), or it could be made up.
 */
async function ownHistory(req, ids) {
  if (!ids || !ids.length) return [];
  const list = await rows(pool, `SELECT question, answer FROM assistant_log WHERE tenant_id = ? AND user_id = ? AND audience = 'staff' AND id IN (?)
    AND created_at >= DATE_SUB(NOW(), INTERVAL 8 HOUR) ORDER BY id DESC LIMIT 3`, [req.auth.tenantId, req.auth.userId, ids]);
  return list.reverse().map((r) => ({ q: r.question, a: r.answer }));
}

// history (the questions and answers as text) is still accepted from screens opened before this change, and ignored.
router.post('/ask', perPerson, validate(z.object({ question: z.string().trim().min(2).max(1000), page: z.string().trim().max(40).optional(), views: z.array(z.string().max(40)).max(80).optional(), history_ids: z.array(z.number().int().positive()).max(6).optional(), history })), async (req, res) => {
  const s = await A.settingsOf(pool, req.auth.tenantId);
  if (!s.staff_on) throw new AppError(403, 'The assistant is turned off for your mountain');
  const out = await A.ask({ tenantId: req.auth.tenantId, audience: 'staff', userId: req.auth.userId, role: req.auth.role, page: req.body.page, views: req.body.views || [] }, req.body.question, { history: await ownHistory(req, req.body.history_ids) });
  res.json(out);
});

async function ownRow(req) {
  const r = await one(pool, "SELECT * FROM assistant_log WHERE tenant_id = ? AND id = ? AND audience = 'staff' AND user_id = ?", [req.auth.tenantId, paramId(req), req.auth.userId]);
  if (!r) throw notFound('Answer');
  return r;
}

router.post('/:id/rate', validate(z.object({ helpful: z.boolean() })), async (req, res) => {
  const r = await ownRow(req);
  await pool.query('UPDATE assistant_log SET rating = ? WHERE id = ?', [req.body.helpful ? 1 : -1, r.id]);
  res.json({ ok: true });
});

/** Ask support: the question, the answer, the screen and who asked go to support@, with a drafted reply for us. */
router.post('/:id/escalate', validate(z.object({ note: z.string().trim().max(2000).optional() })), async (req, res) => {
  const r = await ownRow(req);
  if (r.escalated_at) return res.json({ ok: true, already: true });
  const t = await one(pool, 'SELECT name, slug FROM tenants WHERE id = ?', [req.auth.tenantId]);
  const u = await one(pool, 'SELECT username, email, role FROM users WHERE id = ? AND tenant_id = ?', [req.auth.userId, req.auth.tenantId]);
  const draft = await A.draftReply(r, t.name);
  const text = [`${u.username} (${u.role}) at ${t.name} [${t.slug}] asked the assistant on the ${r.page || 'unknown'} screen, version ${V.VERSION}.`, '',
    `Question:\n${r.question}`, '', `The assistant answered${r.unanswered ? ' (it was unsure)' : ''}:\n${r.answer}`, '',
    req.body.note ? `They added:\n${req.body.note}\n` : '', draft ? `A reply you could send:\n${draft}\n` : '',
    `Reply to ${u.email || 'them (no email on file: reply through the mountain)'}. Answer #${r.id}.`].join('\n');
  const sent = await mailer.sendPlatform({ to: config.site.supportEmail, replyTo: u.email || undefined, subject: `Assistant question from ${t.name}: ${r.question.slice(0, 60)}`, text, tag: 'assistant-support' });
  if (!sent.ok) throw new AppError(503, `That could not be sent. Write to ${config.site.supportEmail}.`);
  await pool.query('UPDATE assistant_log SET escalated_at = NOW() WHERE id = ?', [r.id]);
  res.json({ ok: true, to: config.site.supportEmail, reply_to: u.email || null });
});

// ---------------------------------------------------------------- managers
const managers = requireRole(...MANAGER_ROLES);
async function settingsView(tenantId) {
  const s = await A.settingsOf(pool, tenantId);
  const spent = await A.spentThisMonth(pool, tenantId);
  const mods = await modulesLib.enabledKeys(tenantId);
  const owner = await one(pool, "SELECT email FROM users WHERE tenant_id = ? AND role = 'owner' AND active = 1 AND email IS NOT NULL ORDER BY id LIMIT 1", [tenantId]);
  return { ...s, available: config.assistant.on, plus: mods.includes('assistant_plus'), owner_email: owner ? owner.email : null, pages: A.GUEST_PAGES,
    month: { questions: spent.questions, spent_cents: Math.round(spent.micros / 10000), cap_cents: s.monthly_cap_cents } };
}
router.get('/settings', managers, async (req, res) => res.json(await settingsView(req.auth.tenantId)));
router.put('/settings', managers, validate(z.object({ staff_on: z.boolean(), guest_pages: z.array(z.enum(A.GUEST_PAGES)).max(4), contact_email: z.string().trim().toLowerCase().email().max(255).nullable().optional() })), async (req, res) => {
  const mods = await modulesLib.enabledKeys(req.auth.tenantId);
  if (req.body.guest_pages.length && !mods.includes('assistant_plus')) throw new AppError(409, 'The guest assistant comes with Assistant Plus. Add it under Billing.');
  await pool.query(`INSERT INTO assistant_settings (tenant_id, staff_on, guest_pages, contact_email) VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE staff_on = VALUES(staff_on), guest_pages = VALUES(guest_pages), contact_email = VALUES(contact_email)`, [req.auth.tenantId, req.body.staff_on ? 1 : 0, req.body.guest_pages.join(','), req.body.contact_email || null]);
  res.json(await settingsView(req.auth.tenantId));
});
/** The questions asked this month, newest first: what staff and guests want to know, and what it could not answer. */
router.get('/questions', managers, async (req, res) => {
  const data = await rows(pool, `SELECT l.id, l.audience, l.page, l.question, l.answer, l.unanswered, l.rating, l.escalated_at, l.created_at, u.username
    FROM assistant_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.tenant_id = ? AND l.created_at >= DATE_SUB(NOW(), INTERVAL 31 DAY) ORDER BY l.id DESC LIMIT 200`, [req.auth.tenantId]);
  res.json({ data: data.map((r) => ({ ...r, unanswered: Boolean(r.unanswered) })) });
});

// ---------------------------------------------------------------- guests
async function guestTenant(slug, page) {
  const t = await one(pool, 'SELECT id, name, slug, phone FROM tenants WHERE slug = ?', [slug]);
  if (!t) throw notFound('Mountain');
  const s = await A.settingsOf(pool, t.id);
  const on = config.assistant.on && (await modulesLib.enabledKeys(t.id)).includes('assistant_plus') && s.guest_pages.includes(page);
  return { t, s, on };
}
const pageQ = z.enum(A.GUEST_PAGES);

publicRouter.get('/:slug/assistant', async (req, res) => {
  const page = pageQ.safeParse(req.query.page);
  if (!page.success) return res.json({ on: false });
  const { on } = await guestTenant(req.params.slug, page.data);
  res.json({ on });
});

/** The family's own places, for the assistant on the family page: names, days, dates, what is owed. Nothing medical. */
async function familyContext(t, session) {
  const email = session ? await PP.sessionEmail(t.id, session) : null;
  if (!email) return '';
  const fam = await PP.familyOf(pool, t.id, email);
  if (!fam.ids.length) return '';
  const places = await rows(pool, `SELECT e.id, e.status, e.group_id, e.price_cents, e.discount_cents, e.paid_cents, e.pass_status, p.first_name, pr.name AS program, pr.includes_ticket, pt.name AS term, g.weekday, l.name AS class_name
    FROM program_enrollments e JOIN people p ON p.tenant_id = e.tenant_id AND p.id = e.person_id JOIN programs pr ON pr.tenant_id = e.tenant_id AND pr.id = e.program_id
    JOIN program_terms pt ON pt.tenant_id = e.tenant_id AND pt.id = e.term_id JOIN program_groups g ON g.tenant_id = e.tenant_id AND g.id = e.group_id
    LEFT JOIN program_levels l ON l.tenant_id = e.tenant_id AND l.id = e.level_id WHERE e.tenant_id = ? AND e.person_id IN (?) AND e.status IN ('enrolled','waitlist')`, [t.id, fam.ids]);
  const out = [];
  for (const e of places) {
    const m = await rows(pool, 'SELECT starts_at, status FROM program_sessions WHERE tenant_id = ? AND group_id = ? ORDER BY starts_at', [t.id, e.group_id]);
    const owes = Math.max(0, Number(e.price_cents || 0) - Number(e.discount_cents || 0) - Number(e.paid_cents || 0));
    out.push(`${e.first_name}: ${e.program}, ${e.term}, ${PS.WEEKDAYS[e.weekday]}s, ${e.status === 'waitlist' ? 'on the waitlist' : 'enrolled'}${e.class_name ? `, class ${e.class_name}` : ''}. Dates: ${m.filter((x) => x.status !== 'standby').map((x) => `${PS.dstr(x.starts_at)}${x.status === 'cancelled' ? ' (canceled)' : ''}`).join(', ')}${m.some((x) => x.status === 'standby') ? `; makeup if needed ${m.filter((x) => x.status === 'standby').map((x) => PS.dstr(x.starts_at)).join(', ')}` : ''}.${owes ? ` Still to pay $${(owes / 100).toFixed(2)}.` : ''}${e.includes_ticket && ['verified', 'claimed'].includes(e.pass_status) ? ' Season pass noted, so no lift ticket charged.' : ''}`);
  }
  return out.join('\n');
}

publicRouter.post('/:slug/assistant/ask', validate(z.object({ question: z.string().trim().min(2).max(600), page: pageQ, history })), async (req, res) => {
  const { t, on } = await guestTenant(req.params.slug, req.body.page);
  if (!on) throw notFound('Page');
  const extra = req.body.page === 'family' ? await familyContext(t, req.get('x-family-session')) : '';
  const out = await A.ask({ tenantId: t.id, audience: 'guest', page: req.body.page }, req.body.question, { history: req.body.history || [], extra });
  res.json({ id: out.id, answer: out.answer, unsure: out.unsure, phone: t.phone || null });
});

/** Contact the mountain: the guest's question and their email go to the mountain's chosen address (or the owner). */
publicRouter.post('/:slug/assistant/contact', validate(z.object({ page: pageQ, email: z.string().trim().toLowerCase().email().max(255), name: z.string().trim().max(120).optional(), message: z.string().trim().min(2).max(2000), answer_id: z.number().int().positive().optional(), website: z.string().max(200).optional() })), async (req, res) => {
  const { t, s, on } = await guestTenant(req.params.slug, req.body.page);
  if (!on) throw notFound('Page');
  if (req.body.website) return res.json({ ok: true }); // the hidden field only robots fill in
  const owner = await one(pool, "SELECT email FROM users WHERE tenant_id = ? AND role = 'owner' AND active = 1 AND email IS NOT NULL ORDER BY id LIMIT 1", [t.id]);
  const to = s.contact_email || (owner && owner.email);
  if (!to) throw new AppError(409, `Please call ${t.name}${t.phone ? ` on ${t.phone}` : ''}.`);
  const prior = req.body.answer_id ? await one(pool, "SELECT id, question, answer FROM assistant_log WHERE tenant_id = ? AND id = ? AND audience = 'guest'", [t.id, req.body.answer_id]) : null;
  const where = { shop: 'online ticket shop', programs: 'program registration page', booking: 'lesson booking page', family: 'family page' }[req.body.page];
  const text = [`${req.body.name || 'A guest'} (${req.body.email}) wrote from your ${where}:`, '', req.body.message, '',
    prior ? `They had asked the assistant: ${prior.question}\nIt answered: ${prior.answer}\n` : '', 'Reply to this email to answer them.'].join('\n');
  const sent = await mailer.send({ tenantId: t.id, to, fromName: 'Verdynt/OS', replyTo: req.body.email, subject: `Question from ${req.body.name || req.body.email} (${where})`, text, tag: 'assistant-contact' });
  if (!sent.ok) throw new AppError(503, `Please call ${t.name}${t.phone ? ` on ${t.phone}` : ''}.`);
  if (prior) await pool.query('UPDATE assistant_log SET escalated_at = NOW() WHERE id = ?', [prior.id]);
  res.json({ ok: true });
});

module.exports = { router, publicRouter };
