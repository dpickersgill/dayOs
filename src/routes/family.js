'use strict';

// The parent account (/family/<mountain>): one page for a family's program places. No password: the parent asks for a
// sign-in link by email, and the page keeps a session on their phone for 30 days. They see every child's sessions, day,
// class, every lesson date (canceled, makeup), attendance, what they owe, the lift ticket and the report card; they can
// update allergies, medical notes and who may pick up, switch day and withdraw within the program's rules.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { z, validate, todayIn, addDays } = require('../lib/util');
const { notFound, conflict, unauthorized } = require('../lib/errors');
const { baseUrl } = require('../lib/baseurl');
const mailer = require('../lib/mailer');
const cardrefund = require('../lib/cardrefund');
const { audit } = require('../lib/audit');
const { studentCard } = require('../lib/school');
const PS = require('../lib/programsessions');
const PP = require('../lib/programplus');

const publicRouter = express.Router();
const system = (tenantId) => ({ auth: { tenantId, userId: null } });

async function tenantFor(slug) {
  const t = await one(pool, 'SELECT id, name, slug, phone, timezone FROM tenants WHERE slug = ?', [slug]);
  if (!t) throw notFound('Mountain');
  return t;
}

/** The signed-in family, from the session the page keeps (x-family-session). */
async function familyFor(req) {
  const t = await tenantFor(req.params.slug);
  const email = await PP.sessionEmail(t.id, req.get('x-family-session'));
  if (!email) throw unauthorized('Sign in again: ask for a new link');
  const fam = await PP.familyOf(pool, t.id, email);
  return { t, email, fam };
}

/** Asks for a sign-in link. The reply is the same whether or not the email is known, so it reveals nothing. */
publicRouter.post('/:slug/family/link', validate(z.object({ email: z.string().trim().toLowerCase().email().max(255), website: z.string().max(200).optional() })), async (req, res) => {
  const t = await tenantFor(req.params.slug);
  res.set('Cache-Control', 'no-store');
  if (req.body.website) return res.json({ ok: true });
  const fam = await PP.familyOf(pool, t.id, req.body.email);
  const recent = await one(pool, "SELECT COUNT(*) AS n FROM family_tokens WHERE tenant_id = ? AND email = ? AND kind = 'link' AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)", [t.id, req.body.email]);
  if (fam.adults.length && Number(recent.n) < 5 && mailer.enabled()) {
    const token = await PP.newToken(t.id, req.body.email, 'link');
    const link = `${baseUrl(req)}/family/${t.slug}?t=${token}`;
    await mailer.send({ tenantId: t.id, to: req.body.email, fromName: t.name, subject: `Sign in to your family page at ${t.name}`, tag: 'family-link',
      text: [`Hi ${fam.adults[0].first_name},`, '', `Here is your sign-in link for ${t.name}. It works once, for the next 30 minutes:`, link, '', 'If you did not ask for it, you can ignore this email.', t.name].join('\n') }).catch(() => {});
  }
  res.json({ ok: true });
});

publicRouter.post('/:slug/family/session', validate(z.object({ token: z.string().trim().min(10).max(100) })), async (req, res) => {
  const t = await tenantFor(req.params.slug);
  res.set('Cache-Control', 'no-store');
  const s = await PP.redeemLink(t.id, req.body.token);
  res.json({ session: s.token, email: s.email });
});

publicRouter.post('/:slug/family/signout', async (req, res) => {
  const t = await tenantFor(req.params.slug);
  if (req.get('x-family-session')) await PP.endSession(t.id, req.get('x-family-session'));
  res.json({ ok: true });
});

/** What the program's rules allow for one place today: switching day, and withdrawing with what refund. */
async function policyFor(conn, tenantId, e, program, today) {
  const m = await rows(conn, "SELECT starts_at FROM program_sessions WHERE tenant_id = ? AND group_id = ? AND status = 'scheduled' ORDER BY starts_at", [tenantId, e.group_id]);
  const first = m.length ? PS.dstr(m[0].starts_at) : null; const last = m.length ? PS.dstr(m.at(-1).starts_at) : null;
  const out = { can_switch: false, switch_to: [], can_withdraw: false, withdraw_until: null, refund_cents: 0, fee_cents: 0 };
  if (e.status === 'waitlist') { out.can_withdraw = true; return out; }
  if (e.status !== 'enrolled') return out;
  if (program.allow_switch && last && last >= today) {
    const groups = await rows(conn, 'SELECT g.id, g.weekday, g.capacity, g.discipline, (SELECT COUNT(*) FROM program_enrollments x WHERE x.tenant_id = g.tenant_id AND x.group_id = g.id AND x.status = \'enrolled\') AS n FROM program_groups g WHERE g.tenant_id = ? AND g.term_id = ? AND g.id <> ?', [tenantId, e.term_id, e.group_id]);
    out.switch_to = groups.filter((g) => (g.capacity == null || Number(g.n) < g.capacity) && (!e.discipline || g.discipline === 'any' || g.discipline === e.discipline)).map((g) => ({ group_id: g.id, day: PS.WEEKDAYS[g.weekday] }));
    out.can_switch = out.switch_to.length > 0;
  }
  if (program.cancel_days != null && first) {
    out.withdraw_until = addDays(first, -Number(program.cancel_days));
    if (today <= out.withdraw_until) {
      out.can_withdraw = true;
      out.fee_cents = Math.min(Number(program.cancel_fee_cents || 0), Number(e.paid_cents || 0));
      out.refund_cents = Math.max(0, Number(e.paid_cents || 0) - out.fee_cents);
    }
  }
  return out;
}

/** The family page: each person in the family who has a program place, with everything about each place. */
publicRouter.get('/:slug/family', async (req, res) => {
  const { t, email, fam } = await familyFor(req);
  res.set('Cache-Control', 'no-store');
  const today = todayIn(t.timezone);
  const people = [];
  if (fam.ids.length) {
    const places = await rows(pool, `SELECT e.*, p.first_name, p.last_name, pr.name AS program, pr.meeting_place, pr.what_to_bring, pr.policy_text, pr.allow_switch, pr.cancel_days, pr.cancel_fee_cents, pr.includes_ticket,
        pt.name AS term, pt.starts_on, g.weekday, COALESCE(g.start_time, pt.start_time) AS start_time, COALESCE(g.end_time, pt.end_time) AS end_time, l.name AS class_name, tk.code AS ticket_code
      FROM program_enrollments e JOIN people p ON p.tenant_id = e.tenant_id AND p.id = e.person_id JOIN programs pr ON pr.tenant_id = e.tenant_id AND pr.id = e.program_id
      JOIN program_terms pt ON pt.tenant_id = e.tenant_id AND pt.id = e.term_id JOIN program_groups g ON g.tenant_id = e.tenant_id AND g.id = e.group_id
      LEFT JOIN program_levels l ON l.tenant_id = e.tenant_id AND l.id = e.level_id LEFT JOIN tickets tk ON tk.tenant_id = e.tenant_id AND tk.id = e.ticket_id
      WHERE e.tenant_id = ? AND e.person_id IN (?) AND e.status IN ('enrolled','waitlist') ORDER BY p.first_name, pt.starts_on`, [t.id, fam.ids]);
    const byPerson = new Map();
    for (const e of places) {
      const meetings = await rows(pool, `SELECT s.id, s.starts_at, s.kind, s.status, s.cancel_reason, a.present FROM program_sessions s
        LEFT JOIN attendance a ON a.tenant_id = s.tenant_id AND a.session_id = s.id AND a.person_id = ? WHERE s.tenant_id = ? AND s.group_id = ? ORDER BY s.starts_at`, [e.person_id, t.id, e.group_id]);
      const waitPos = e.status === 'waitlist' ? Number((await one(pool, "SELECT COUNT(*) AS n FROM program_enrollments WHERE tenant_id = ? AND group_id = ? AND status = 'waitlist' AND (created_at < ? OR (created_at = ? AND id <= ?))", [t.id, e.group_id, e.created_at, e.created_at, e.id])).n) : null;
      const place = {
        id: e.id, status: e.status, waitlist_position: waitPos, program: e.program, term: e.term, day: PS.WEEKDAYS[e.weekday], start_time: PS.tstr(e.start_time), end_time: PS.tstr(e.end_time),
        meeting_place: e.meeting_place, what_to_bring: e.what_to_bring, policy_text: e.policy_text, discipline: e.discipline, class_name: e.class_name,
        dates: meetings.filter((m) => m.status !== 'standby').map((m) => ({ date: PS.dstr(m.starts_at), status: m.status, kind: m.kind, reason: m.cancel_reason, present: m.present === null ? null : Boolean(m.present) })),
        makeup_reserve: meetings.filter((m) => m.status === 'standby').map((m) => PS.dstr(m.starts_at)),
        owes_cents: Math.max(0, Number(e.price_cents || 0) - Number(e.discount_cents || 0) - Number(e.paid_cents || 0)), paid_cents: Number(e.paid_cents || 0),
        ticket_code: e.ticket_code, pass_status: e.includes_ticket ? e.pass_status : null, needs_rental: Boolean(e.needs_rental), needs_helmet: Boolean(e.needs_helmet),
        allergies: e.allergies, medical: e.medical, pickup: PS.parseJson(e.pickup, []),
        policy: await policyFor(pool, t.id, e, e, today),
      };
      if (!byPerson.has(e.person_id)) byPerson.set(e.person_id, { id: e.person_id, first_name: e.first_name, last_name: e.last_name, places: [] });
      byPerson.get(e.person_id).places.push(place);
    }
    for (const p of byPerson.values()) {
      const card = await tx((conn) => studentCard(conn, t.id, p.id));
      p.report_card = card ? card.disciplines.map((d) => {
        const cur = d.levels.find((l) => l.rank_no === d.current_level); const next = d.levels.find((l) => l.rank_no === d.next_level);
        return { discipline: d.discipline, level: cur ? cur.name : null, next: next ? { name: next.name, skills: next.skills.map((s) => ({ name: s.name, passed: Boolean(s.passed_on) })) } : null };
      }) : [];
      people.push(p);
    }
  }
  // Single lessons (2026.11.5): each person's upcoming lessons and the progress card, across lessons, programs and seasons.
  if (fam.ids.length) {
    const L = require('../lib/levels'); const LF = require('../lib/lessonfamily');
    const lessons = await rows(pool, `SELECT b.person_id, b.status, s.starts_at, s.ends_at, s.meeting_place, s.level_min, s.level_max, s.status AS session_status, s.delay_minutes, pr.name AS product, p.first_name, p.last_name
      FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
      JOIN people p ON p.tenant_id = b.tenant_id AND p.id = b.person_id
      WHERE b.tenant_id = ? AND b.person_id IN (?) AND b.status IN ('booked','attended') AND DATE(s.starts_at) >= ? ORDER BY s.starts_at LIMIT 60`, [t.id, fam.ids, today]);
    const withHistory = await rows(pool, "SELECT DISTINCT b.person_id, p.first_name, p.last_name FROM lesson_bookings b JOIN people p ON p.tenant_id = b.tenant_id AND p.id = b.person_id WHERE b.tenant_id = ? AND b.person_id IN (?) AND b.status IN ('booked','attended')", [t.id, fam.ids]);
    for (const w of withHistory) if (!people.some((x) => x.id === w.person_id)) people.push({ id: w.person_id, first_name: w.first_name, last_name: w.last_name, places: [], report_card: [] });
    for (const p of people) {
      p.lessons = lessons.filter((l) => l.person_id === p.id).map((l) => ({ product: l.product, starts_at: l.starts_at, ends_at: l.ends_at, meeting_place: l.meeting_place, level_words: L.range(l.level_min, l.level_max), canceled: l.session_status === 'cancelled', delay_minutes: Number(l.delay_minutes || 0) }));
      p.progress = await LF.progressCard(pool, t.id, p.id, { recapBodies: true });
    }
  }
  await audit(pool, system(t.id), 'family_view', 'people', null, { email });
  res.json({ mountain: t.name, phone: t.phone, email, today, people });
});

/** The place, if it belongs to this family; locked for the change. */
async function placeOf(conn, t, fam, id) {
  const e = await one(conn, 'SELECT * FROM program_enrollments WHERE tenant_id = ? AND id = ? FOR UPDATE', [t.id, id]);
  if (!e || !fam.ids.includes(e.person_id) || !e.term_id) throw notFound('Place');
  return e;
}
const pickup = z.array(z.object({ name: z.string().trim().min(1).max(100), phone: z.string().trim().max(40).optional(), relation: z.string().trim().max(40).optional() })).max(6);

publicRouter.patch('/:slug/family/places/:id', validate(z.object({ allergies: z.string().trim().max(300).nullable().optional(), medical: z.string().trim().max(500).nullable().optional(), pickup: pickup.optional() })), async (req, res) => {
  const { t, fam, email } = await familyFor(req);
  await tx(async (conn) => {
    const e = await placeOf(conn, t, fam, Number(req.params.id));
    await PS.saveDetails(conn, t.id, e.id, req.body);
    await audit(conn, system(t.id), 'family_update_place', 'programs', e.program_id, { enrollment_id: e.id, fields: Object.keys(req.body), email });
  });
  res.json({ ok: true });
});

publicRouter.post('/:slug/family/places/:id/switch', validate(z.object({ group_id: z.number().int().positive() })), async (req, res) => {
  const { t, fam, email } = await familyFor(req);
  const today = todayIn(t.timezone);
  await tx(async (conn) => {
    const e = await placeOf(conn, t, fam, Number(req.params.id));
    const program = await one(conn, 'SELECT * FROM programs WHERE tenant_id = ? AND id = ?', [t.id, e.program_id]);
    const pol = await policyFor(conn, t.id, e, program, today);
    if (!pol.switch_to.some((g) => g.group_id === req.body.group_id)) throw conflict('That day cannot be chosen now. Please call the mountain.');
    await PS.moveDay(conn, t.id, e, req.body.group_id);
    await audit(conn, system(t.id), 'family_switch_day', 'programs', e.program_id, { enrollment_id: e.id, to: req.body.group_id, email });
  });
  res.json({ ok: true });
});

/** Withdraw within the program's cancellation window: the place opens, the ticket is voided, the refund goes to the card. */
publicRouter.post('/:slug/family/places/:id/withdraw', async (req, res) => {
  const { t, fam, email } = await familyFor(req);
  const today = todayIn(t.timezone);
  const out = await tx(async (conn) => {
    const e = await placeOf(conn, t, fam, Number(req.params.id));
    const program = await one(conn, 'SELECT * FROM programs WHERE tenant_id = ? AND id = ?', [t.id, e.program_id]);
    const pol = await policyFor(conn, t.id, e, program, today);
    if (!pol.can_withdraw) throw conflict(pol.withdraw_until ? `Online cancellation closed on ${pol.withdraw_until}. Please call the mountain.` : 'Please call the mountain to cancel.');
    let refund = { how: 'none', cents: 0 };
    if (e.status === 'enrolled' && pol.refund_cents > 0 && e.order_id) refund = await PP.refundPart(conn, t.id, { orderId: e.order_id, cents: pol.refund_cents, reason: 'customer_request', note: `${program.name}: withdrawn by the family` });
    await conn.query("UPDATE program_enrollments SET status = 'withdrawn', withdrawn_at = NOW(), refund_cents = ? WHERE tenant_id = ? AND id = ?", [refund.cents || 0, t.id, e.id]);
    if (e.ticket_id) await conn.query("UPDATE tickets SET status = 'void' WHERE tenant_id = ? AND id = ?", [t.id, e.ticket_id]);
    if (e.status === 'enrolled') await PS.promoteWaitlist(conn, t.id, await one(conn, 'SELECT * FROM program_groups WHERE tenant_id = ? AND id = ?', [t.id, e.group_id]));
    await audit(conn, system(t.id), 'family_withdraw', 'programs', e.program_id, { enrollment_id: e.id, refund: refund.cents || 0, how: refund.how, email });
    return refund;
  });
  if (out.refund_id) await cardrefund.send(t.id, out.refund_id);
  res.json({ ok: true, refund_cents: out.cents || 0, how: out.how });
});

module.exports = { publicRouter };
