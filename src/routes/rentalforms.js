'use strict';

// The guest rental form and rental groups. router is mounted at /rentals (staff); publicRouter under /public
// (the form page at /rental-form/<mountain>, no sign-in). The rules live in lib/rentalforms.js.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, dateStr, todayIn, addDays, seasonFor } = require('../lib/util');
const { notFound, conflict, bad, AppError } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { baseUrl } = require('../lib/baseurl');
const { ON_FILE } = require('../lib/waivers');
const { esc } = require('../lib/format');
const mailer = require('../lib/mailer');
const R = require('../lib/rentals');
const F = require('../lib/rentalforms');

const router = express.Router();
const publicRouter = express.Router();
const counter = requireRole('counter', 'manager');
const AHEAD_DAYS = 60; // how far ahead a walk-in form can be for
const dayOf = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);

// ---------------------------------------------------------------- public: the form
async function publicTenant(slug) {
  const t = await one(pool, 'SELECT id, slug, name, phone, timezone, status, waiver_text FROM tenants WHERE slug = ?', [slug]);
  if (!t || t.status !== 'active') throw new AppError(404, 'Page not found');
  return t;
}

/** Which order or group a link is for. Never more than the day and how many renters: no names go back without staff. */
async function linkOf(t, q) {
  if (q.t !== undefined && q.t !== '') {
    if (!F.tokenOk(String(q.t))) throw new AppError(404, 'That link is not right. Check the link in your email.');
    const o = await one(pool, 'SELECT id, created_at FROM orders WHERE tenant_id = ? AND rental_form_token_sha = ?', [t.id, F.sha(q.t)]);
    if (!o) throw new AppError(404, 'That link is not right. Check the link in your email.');
    const lines = await F.rentalLines(pool, t.id, o.id);
    return { kind: 'order', id: o.id, day: lines.day || todayIn(t.timezone), renters: lines.count };
  }
  if (q.g !== undefined && q.g !== '') {
    if (!F.tokenOk(String(q.g))) throw new AppError(404, 'That link is not right. Ask your group leader for it again.');
    const g = await one(pool, 'SELECT id, name, rental_on, status FROM rental_groups WHERE tenant_id = ? AND link_token_sha = ?', [t.id, F.sha(q.g)]);
    if (!g || g.status === 'closed') throw new AppError(404, 'That link is not right. Ask your group leader for it again.');
    return { kind: 'group', id: g.id, day: dayOf(g.rental_on), name: g.name };
  }
  return { kind: 'walk_in' };
}

publicRouter.get('/:slug/rental-form', async (req, res) => {
  const t = await publicTenant(req.params.slug);
  const link = await linkOf(t, req.query);
  const today = todayIn(t.timezone);
  const brand = await one(pool, 'SELECT color, logo FROM shop_brand WHERE tenant_id = ?', [t.id]);
  if (link.day && link.day < today) throw new AppError(410, 'This rental day has passed. Please fill in the form at the rental shop.');
  let sent = false;
  if (link.kind === 'order') sent = Boolean(await one(pool, "SELECT id FROM rental_forms WHERE tenant_id = ? AND order_id = ? AND status <> 'discarded' LIMIT 1", [t.id, link.id]));
  res.json({
    mountain: t.name, phone: t.phone, today, last_day: addDays(today, AHEAD_DAYS), brand: brand || null, max_people: F.MAX_PEOPLE, adult_age: F.ADULT_AGE,
    waiver_link: t.waiver_text ? `${baseUrl(req)}/waiver/${t.slug}` : null,
    order: link.kind === 'order' ? { day: link.day, renters: link.renters, sent } : null,
    group: link.kind === 'group' ? { name: link.name, day: link.day } : null,
  });
});

const formPerson = z.object({
  first_name: z.string().max(100), last_name: z.string().max(100), date_of_birth: z.string().max(10),
  discipline: z.enum(['ski', 'snowboard']).optional(), height_in: z.coerce.number().min(0).max(120).nullable().optional(), weight_lb: z.coerce.number().min(0).max(700).nullable().optional(),
  boot_size: z.string().max(10).nullable().optional(), shoe_size: z.string().max(20).nullable().optional(), stance: z.enum(['regular', 'goofy', '']).nullable().optional(),
  ability: z.enum(['cautious', 'moderate', 'aggressive', '']).optional(), helmet: z.boolean().optional(),
  signer_name: z.string().max(120), signer_relation: z.enum(['self', 'parent', 'guardian']), signature: z.string().max(F.MAX_SIGNATURE_CHARS + 100), agree: z.boolean().optional(),
});
const formBody = z.object({
  t: z.string().max(64).optional(), g: z.string().max(64).optional(),
  contact_name: z.string().trim().min(1, 'Enter your name').max(120), phone: z.string().trim().max(30).optional().or(z.literal('')),
  email: z.string().trim().max(255).email('Please check the email address').optional().or(z.literal('')),
  rental_on: dateStr.optional(), people: z.array(formPerson).min(1, 'Add at least one person').max(F.MAX_PEOPLE),
  website: z.string().max(200).optional(), // left empty by people; filled in by bots
});

publicRouter.post('/:slug/rental-form', validate(formBody), async (req, res) => {
  const t = await publicTenant(req.params.slug);
  const b = req.body;
  if (b.website) return res.status(201).json({ ok: true, people: b.people.length, day: todayIn(t.timezone), for: 'walk_in' }); // a bot: say thanks, keep nothing
  const link = await linkOf(t, b);
  const today = todayIn(t.timezone);
  const day = link.day || b.rental_on || today;
  if (day < today) throw bad('Pick today or a later day');
  if (day > addDays(today, AHEAD_DAYS)) throw bad('That day is too far ahead. Fill in the form closer to the day.');
  if (link.kind === 'walk_in' && !String(b.phone || '').replace(/\D/g, '').length) throw bad('Enter a phone number so the shop can find your form');
  const people = b.people.map((p) => F.cleanPerson(p, day));
  const id = await tx(async (conn) => {
    // filling in the order's form again replaces the one still waiting
    if (link.kind === 'order') await conn.query("UPDATE rental_forms SET status = 'discarded' WHERE tenant_id = ? AND order_id = ? AND status = 'waiting'", [t.id, link.id]);
    const [r] = await conn.query('INSERT INTO rental_forms (tenant_id, order_id, group_id, contact_name, phone, email, rental_on, people) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [t.id, link.kind === 'order' ? link.id : null, link.kind === 'group' ? link.id : null, b.contact_name, b.phone || null, b.email || null, day, JSON.stringify(people)]);
    await audit(conn, { auth: { tenantId: t.id, userId: null }, ip: req.ip }, 'submit', 'rental_forms', r.insertId, { people: people.length, via: link.kind });
    return r.insertId;
  });
  res.status(201).json({ ok: true, id, day, people: people.length, for: link.kind });
});

// ---------------------------------------------------------------- staff: forms waiting at the counter
const formRow = (f) => ({ ...f, rental_on: dayOf(f.rental_on), people: F.withoutSignatures(F.parsePeople(f.people)) });

router.get('/forms', counter, async (req, res) => {
  const { tenantId } = req.auth;
  const today = todayIn((await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day || '')) ? String(req.query.day) : today;
  const where = ['f.tenant_id = ?', "f.status = 'waiting'"]; const params = [tenantId];
  // Today's forms; "coming" shows the days ahead. Yesterday's waiting forms drop off on their own.
  if (req.query.coming === '1') { where.push('f.rental_on > ?'); params.push(today); } else { where.push('f.rental_on = ?'); params.push(day); }
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q) {
    const digits = q.replace(/\D/g, '');
    const parts = ['f.contact_name LIKE ?', "JSON_SEARCH(JSON_EXTRACT(f.people, '$[*].first_name'), 'one', ?) IS NOT NULL", "JSON_SEARCH(JSON_EXTRACT(f.people, '$[*].last_name'), 'one', ?) IS NOT NULL"];
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    if (digits.length >= 3) { parts.push("REPLACE(REPLACE(REPLACE(REPLACE(f.phone, '-', ''), ' ', ''), '(', ''), ')', '') LIKE ?"); params.push(`%${digits}%`); }
    if (/^\d{1,9}$/.test(q)) { parts.push('f.order_id = ?'); params.push(Number(q)); }
    where.push(`(${parts.join(' OR ')})`);
  }
  const data = await rows(pool, `SELECT f.id, f.order_id, f.group_id, f.status, f.contact_name, f.phone, f.email, f.rental_on, f.people, f.created_at, g.name AS group_name
    FROM rental_forms f LEFT JOIN rental_groups g ON g.tenant_id = f.tenant_id AND g.id = f.group_id WHERE ${where.join(' AND ')} ORDER BY f.rental_on, f.id DESC LIMIT 200`, params);
  res.json({ day, today, data: data.map(formRow) });
});

/** The walk-in link for the poster. */
router.get('/forms/link', counter, async (req, res) => {
  const t = await one(pool, 'SELECT slug, name FROM tenants WHERE id = ?', [req.auth.tenantId]);
  res.json({ url: F.walkInLink(baseUrl(req), t.slug), mountain: t.name });
});

router.get('/forms/:id', counter, async (req, res) => {
  const { tenantId } = req.auth;
  const f = await one(pool, 'SELECT f.*, g.name AS group_name FROM rental_forms f LEFT JOIN rental_groups g ON g.tenant_id = f.tenant_id AND g.id = f.group_id WHERE f.tenant_id = ? AND f.id = ?', [tenantId, paramId(req)]);
  if (!f) throw notFound('Rental form');
  const people = F.parsePeople(f.people);
  const season = seasonFor(dayOf(f.rental_on));
  for (const p of people) {
    p.candidates = await F.candidates(pool, tenantId, p);
    for (const c of p.candidates) { c.dob_match = Boolean(Number(c.dob_match)); c.date_of_birth = dayOf(c.date_of_birth); c.waiver_signed = Boolean(await one(pool, ON_FILE, [tenantId, c.id, season])); }
    p.age = F.ageOn(p.date_of_birth, dayOf(f.rental_on));
  }
  const toFit = f.order_id ? await rows(pool, `SELECT c.id, c.person_id, c.stage, p.first_name, p.last_name FROM rental_contracts c JOIN people p ON p.tenant_id = c.tenant_id AND p.id = c.person_id
    WHERE c.tenant_id = ? AND c.order_id = ? AND c.status = 'to_fit' ORDER BY c.id`, [tenantId, f.order_id]) : [];
  await audit(pool, req, 'view', 'rental_forms', f.id, null);
  res.json({ ...f, rental_on: dayOf(f.rental_on), people, season, to_fit: toFit });
});

router.post('/forms/:id/use', counter, validate(z.object({
  people: z.array(z.object({ index: z.number().int().min(0).max(F.MAX_PEOPLE), person_id: z.number().int().positive().nullable().optional(), skip: z.boolean().optional() })).max(F.MAX_PEOPLE).default([]),
  order_id: z.number().int().positive().optional(),
})), async (req, res) => {
  const { tenantId } = req.auth;
  const out = await tx(async (conn) => {
    const f = await one(conn, 'SELECT * FROM rental_forms WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, paramId(req)]);
    if (!f) throw notFound('Rental form');
    if (f.status !== 'waiting') throw conflict(`That form was already ${f.status}`);
    if (req.body.order_id && f.order_id && req.body.order_id !== f.order_id) throw bad(`This form is for order #${f.order_id}`);
    const settings = await R.getSettings(conn, tenantId);
    const r = await F.useForm(conn, tenantId, f, req.body.people, { orderId: req.body.order_id, userId: req.auth.userId, settings });
    await audit(conn, req, 'use', 'rental_forms', f.id, { people: r.people.map((p) => p.person_id), attached: r.attached.map((a) => a.contract_id) });
    return r;
  });
  res.json(out);
});

router.post('/forms/:id/discard', counter, async (req, res) => {
  const [r] = await pool.query("UPDATE rental_forms SET status = 'discarded', used_by = ? WHERE tenant_id = ? AND id = ? AND status = 'waiting'", [req.auth.userId, req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Waiting form');
  await audit(pool, req, 'discard', 'rental_forms', paramId(req), null);
  res.json({ ok: true });
});

/** The rental form link for an order (printed on the receipt; staff can read it out or text it). */
router.get('/orders/:id/form-link', counter, async (req, res) => {
  const { tenantId } = req.auth;
  const o = await one(pool, 'SELECT id FROM orders WHERE tenant_id = ? AND id = ?', [tenantId, paramId(req)]);
  if (!o) throw notFound('Order');
  if (!(await F.rentalLines(pool, tenantId, o.id)).count) throw bad('That order has no rentals');
  const t = await one(pool, 'SELECT slug FROM tenants WHERE id = ?', [tenantId]);
  res.json({ url: await F.orderFormLink(pool, tenantId, o.id, baseUrl(req), t.slug) });
});

// ---------------------------------------------------------------- staff: groups
const groupFields = {
  name: z.string().trim().min(1, 'Name the group').max(120), leader_name: z.string().trim().max(120).nullable().optional(),
  leader_phone: z.string().trim().max(30).nullable().optional(), leader_email: z.string().trim().max(255).email('Check the leader email').nullable().optional().or(z.literal('')),
  rental_on: dateStr, days: z.number().int().min(1).max(30).default(1), notes: z.string().trim().max(500).nullable().optional(),
};
const tzOf = async (tenantId) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;

router.get('/groups', counter, async (req, res) => {
  const { tenantId } = req.auth;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? String(req.query.from) : addDays(todayIn(await tzOf(tenantId)), -1);
  const data = await rows(pool, `SELECT g.*, (SELECT COUNT(*) FROM rental_contracts c WHERE c.tenant_id = g.tenant_id AND c.group_id = g.id AND c.status <> 'cancelled') AS members,
      (SELECT COUNT(*) FROM rental_contracts c WHERE c.tenant_id = g.tenant_id AND c.group_id = g.id AND c.status = 'to_fit' AND c.stage = 'set') AS set_aside,
      (SELECT COUNT(*) FROM rental_contracts c WHERE c.tenant_id = g.tenant_id AND c.group_id = g.id AND c.status IN ('out','overdue')) AS out_now,
      (SELECT COUNT(*) FROM rental_forms f WHERE f.tenant_id = g.tenant_id AND f.group_id = g.id AND f.status = 'waiting') AS forms_waiting
    FROM rental_groups g WHERE g.tenant_id = ? AND (DATE_ADD(g.rental_on, INTERVAL g.days - 1 DAY) >= ? OR g.status IN ('set','out')) AND g.status <> 'closed' ORDER BY g.rental_on, g.name LIMIT 200`, [tenantId, from]);
  res.json({ data: data.map((g) => ({ ...g, rental_on: dayOf(g.rental_on), link_token_sha: undefined, members: Number(g.members), set_aside: Number(g.set_aside), out_now: Number(g.out_now), forms_waiting: Number(g.forms_waiting) })) });
});

router.post('/groups', counter, validate(z.object(groupFields)), async (req, res) => {
  const { tenantId } = req.auth;
  const b = req.body;
  const id = await tx(async (conn) => {
    const [r] = await conn.query('INSERT INTO rental_groups (tenant_id, name, leader_name, leader_phone, leader_email, rental_on, days, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [tenantId, b.name, b.leader_name || null, b.leader_phone || null, b.leader_email || null, b.rental_on, b.days, b.notes || null, req.auth.userId ?? null]);
    const t = await one(conn, 'SELECT slug FROM tenants WHERE id = ?', [tenantId]);
    await F.groupLink(conn, tenantId, r.insertId, baseUrl(req), t.slug);
    await audit(conn, req, 'create', 'rental_groups', r.insertId, { name: b.name, rental_on: b.rental_on });
    return r.insertId;
  });
  res.status(201).json({ id });
});

async function loadGroup(conn, tenantId, id, lock = false) {
  const g = await one(conn, `SELECT * FROM rental_groups WHERE tenant_id = ? AND id = ?${lock ? ' FOR UPDATE' : ''}`, [tenantId, id]);
  if (!g) throw notFound('Group');
  return g;
}

router.get('/groups/:id', counter, async (req, res) => {
  const { tenantId } = req.auth;
  const g = await loadGroup(pool, tenantId, paramId(req));
  const day = dayOf(g.rental_on);
  const season = seasonFor(day);
  const settings = await R.getSettings(pool, tenantId);
  const members = await rows(pool, `SELECT c.id AS contract_id, c.status, c.stage, c.due_at, c.valid_on, c.person_id, p.first_name, p.last_name, p.date_of_birth, p.email, p.phone, p.height_in, p.weight_lb, p.boot_size, p.stance, p.skier_type, p.discipline,
      rp.boot_sole_mm, rp.shoe_size, rp.skier_type AS profile_skier_type
    FROM rental_contracts c JOIN people p ON p.tenant_id = c.tenant_id AND p.id = c.person_id LEFT JOIN rental_profiles rp ON rp.tenant_id = c.tenant_id AND rp.person_id = c.person_id
    WHERE c.tenant_id = ? AND c.group_id = ? AND c.status <> 'cancelled' ORDER BY p.last_name, p.first_name`, [tenantId, g.id]);
  for (const m of members) {
    m.date_of_birth = dayOf(m.date_of_birth); m.valid_on = dayOf(m.valid_on);
    m.age = F.ageOn(m.date_of_birth, day);
    m.skier_type = m.profile_skier_type || m.skier_type; delete m.profile_skier_type;
    m.details_in = Boolean(m.height_in && m.weight_lb && (m.boot_size || m.shoe_size) && m.skier_type && m.date_of_birth);
    m.signed = Boolean(await F.signoffFor(pool, tenantId, { id: m.contract_id, person_id: m.person_id, valid_on: day }, settings));
    m.waiver_signed = Boolean(await one(pool, ON_FILE, [tenantId, m.person_id, season]));
    m.gear = await rows(pool, `SELECT li.rental_item_id, li.din_setting, li.tech_name, li.test_result, li.returned_at, r.sku, r.category, r.brand, r.model, r.size, r.status AS item_status
      FROM rental_contract_items li JOIN rental_items r ON r.tenant_id = li.tenant_id AND r.id = li.rental_item_id WHERE li.tenant_id = ? AND li.contract_id = ? ORDER BY li.id`, [tenantId, m.contract_id]);
    m.code = F.contractCode(m.contract_id);
  }
  const forms = await rows(pool, "SELECT id, contact_name, phone, email, rental_on, people, created_at FROM rental_forms WHERE tenant_id = ? AND group_id = ? AND status = 'waiting' ORDER BY id", [tenantId, g.id]);
  const t = await one(pool, 'SELECT slug, waiver_text FROM tenants WHERE id = ?', [tenantId]);
  const link = await F.groupLink(pool, tenantId, g.id, baseUrl(req), t.slug);
  await audit(pool, req, 'view', 'rental_groups', g.id, null);
  res.json({
    group: { ...g, rental_on: day, link_token_sha: undefined }, link, waiver_link: t.waiver_text ? `${baseUrl(req)}/waiver/${t.slug}` : null, season,
    require_signoff: settings.require_signoff === undefined ? true : Boolean(Number(settings.require_signoff)), require_binding_record: settings.require_binding_record,
    members, forms: forms.map(formRow), email_ready: mailer.enabled(),
  });
});

router.patch('/groups/:id', counter, validate(z.object({ ...Object.fromEntries(Object.entries(groupFields).map(([k, v]) => [k, v.optional()])), status: z.enum(['open', 'closed']).optional() })), async (req, res) => {
  const { tenantId } = req.auth;
  const b = req.body;
  await tx(async (conn) => {
    const g = await loadGroup(conn, tenantId, paramId(req), true);
    if (b.status === 'closed') {
      const live = await one(conn, "SELECT COUNT(*) AS n FROM rental_contracts WHERE tenant_id = ? AND group_id = ? AND status IN ('out','overdue')", [tenantId, g.id]);
      if (Number(live.n)) throw conflict('Some gear is still out. Check it in before you close the group.');
      const waiting = await rows(conn, "SELECT id FROM rental_contracts WHERE tenant_id = ? AND group_id = ? AND status = 'to_fit'", [tenantId, g.id]);
      for (const c of waiting) await F.releaseSetAside(conn, tenantId, c.id);
      await conn.query("UPDATE rental_contracts SET status = 'cancelled', stage = NULL WHERE tenant_id = ? AND group_id = ? AND status = 'to_fit'", [tenantId, g.id]);
    }
    const cols = ['name', 'leader_name', 'leader_phone', 'leader_email', 'rental_on', 'days', 'notes', 'status'].filter((k) => b[k] !== undefined);
    if (cols.length) await conn.query(`UPDATE rental_groups SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...cols.map((k) => (b[k] === '' ? null : b[k])), tenantId, g.id]);
    // a new day moves the members still to be fitted with it
    if (b.rental_on || b.days) {
      const fresh = await loadGroup(conn, tenantId, g.id);
      const settings = await R.getSettings(conn, tenantId);
      const day = dayOf(fresh.rental_on);
      await conn.query("UPDATE rental_contracts SET valid_on = ?, due_at = ?, group_name = ? WHERE tenant_id = ? AND group_id = ? AND status = 'to_fit'", [day, F.closingOn(addDays(day, fresh.days - 1), settings), fresh.name, tenantId, g.id]);
    }
    await audit(conn, req, 'update', 'rental_groups', g.id, b);
  });
  res.json({ ok: true });
});

const memberRow = z.object({
  first_name: z.string().trim().min(1).max(100), last_name: z.string().trim().min(1).max(100), date_of_birth: dateStr.nullable().optional(),
  height_in: z.number().int().min(20).max(100).nullable().optional(), weight_lb: z.number().int().min(20).max(500).nullable().optional(),
  boot_size: z.string().trim().max(10).nullable().optional(), skier_type: z.enum(['1', '2', '3']).nullable().optional(), discipline: z.enum(['ski', 'snowboard']).nullable().optional(),
  person_id: z.number().int().positive().optional(),
});

/** Adds members, from a pasted list or one at a time. Each gets a customer record (matched on name and date of birth) and a to_fit contract. */
router.post('/groups/:id/members', counter, validate(z.object({ rows: z.array(memberRow).min(1).max(200) })), async (req, res) => {
  const { tenantId } = req.auth;
  const out = await tx(async (conn) => {
    const g = await loadGroup(conn, tenantId, paramId(req), true);
    if (g.status === 'closed') throw conflict('That group is closed');
    const settings = await R.getSettings(conn, tenantId);
    let added = 0; let matched = 0;
    for (const r of req.body.rows) {
      const who = await F.personFor(conn, tenantId, r, r.person_id, 'group');
      if (!who.created) matched += 1;
      await F.saveDetails(conn, tenantId, who.id, { ...r, skier_type: r.skier_type || null });
      const m = await F.addMember(conn, tenantId, g, who.id, settings);
      if (m.added) added += 1;
    }
    await audit(conn, req, 'add_members', 'rental_groups', g.id, { rows: req.body.rows.length, added });
    return { added, matched, already: req.body.rows.length - added };
  });
  res.status(201).json(out);
});

async function memberContract(conn, tenantId, groupId, contractId) {
  const c = await one(conn, 'SELECT * FROM rental_contracts WHERE tenant_id = ? AND id = ? AND group_id = ? FOR UPDATE', [tenantId, contractId, groupId]);
  if (!c) throw notFound('Group member');
  return c;
}

router.delete('/groups/:id/members/:contractId', counter, async (req, res) => {
  const { tenantId } = req.auth;
  await tx(async (conn) => {
    const c = await memberContract(conn, tenantId, paramId(req), paramId(req, 'contractId'));
    if (c.status !== 'to_fit') throw conflict('That member already has gear out. Check it in from Out now.');
    await F.releaseSetAside(conn, tenantId, c.id);
    await conn.query("UPDATE rental_contracts SET status = 'cancelled', stage = NULL WHERE tenant_id = ? AND id = ?", [tenantId, c.id]);
    await audit(conn, req, 'remove_member', 'rental_groups', paramId(req), { contract_id: c.id });
  });
  res.json({ ok: true });
});

/** Set gear aside for a member the night before. Sends the whole set each time; an empty list puts it all back. */
router.put('/groups/:id/members/:contractId/gear', counter, validate(z.object({ items: z.array(R.gearLine.omit({ person_id: true })).max(10) })), async (req, res) => {
  const { tenantId } = req.auth;
  await tx(async (conn) => {
    const g = await loadGroup(conn, tenantId, paramId(req), true);
    const c = await memberContract(conn, tenantId, g.id, paramId(req, 'contractId'));
    if (c.status !== 'to_fit') throw conflict('That member already has their gear');
    await F.setAside(conn, tenantId, c, req.body.items);
    const left = await one(conn, "SELECT COUNT(*) AS n FROM rental_contracts WHERE tenant_id = ? AND group_id = ? AND status = 'to_fit' AND (stage IS NULL OR stage <> 'set')", [tenantId, g.id]);
    if (g.status === 'open' && !Number(left.n)) await conn.query("UPDATE rental_groups SET status = 'set' WHERE tenant_id = ? AND id = ?", [tenantId, g.id]);
    if (g.status === 'set' && Number(left.n)) await conn.query("UPDATE rental_groups SET status = 'open' WHERE tenant_id = ? AND id = ?", [tenantId, g.id]);
    await audit(conn, req, 'set_aside', 'rental_contracts', c.id, { items: req.body.items.map((i) => i.rental_item_id) });
  });
  res.json({ ok: true });
});

/** Hands out one member's bag: checks the waiver, the signed details and the binding record, then the gear goes out. */
async function handOut(conn, req, c, settings, season) {
  const { tenantId } = req.auth;
  const p = await one(conn, 'SELECT first_name, last_name FROM people WHERE tenant_id = ? AND id = ?', [tenantId, c.person_id]);
  const name = `${p.first_name} ${p.last_name}`;
  if (c.status !== 'to_fit') return { name, skipped: c.status === 'out' ? 'Already handed out' : `Contract is ${c.status}` };
  const lines = await rows(conn, 'SELECT li.*, r.sku, r.category, r.status AS item_status FROM rental_contract_items li JOIN rental_items r ON r.tenant_id = li.tenant_id AND r.id = li.rental_item_id WHERE li.tenant_id = ? AND li.contract_id = ? AND li.returned_at IS NULL FOR UPDATE', [tenantId, c.id]);
  if (!lines.length) return { name, skipped: 'No gear set aside yet' };
  if (!(await one(conn, ON_FILE, [tenantId, c.person_id, season]))) return { name, skipped: 'No signed waiver for the season' };
  const needSignoff = settings.require_signoff === undefined ? true : Boolean(Number(settings.require_signoff));
  if (needSignoff && lines.some((l) => ['ski', 'snowboard'].includes(l.category)) && !(await F.signoffFor(conn, tenantId, c, settings))) return { name, skipped: 'Details not signed yet' };
  for (const l of lines) {
    if (l.test_result === 'fail') return { name, skipped: `${l.sku} failed its binding test` };
    if (settings.require_binding_record && l.category === 'ski' && (l.din_setting == null || !l.tech_name)) return { name, skipped: `Record the binding setting and who set it for ${l.sku}` };
    if (l.item_status !== 'set_aside') return { name, skipped: `${l.sku} is ${String(l.item_status).replace('_', ' ')}, not set aside` };
  }
  await conn.query("UPDATE rental_items SET status = 'rented', uses_count = uses_count + 1 WHERE tenant_id = ? AND id IN (?)", [tenantId, lines.map((l) => l.rental_item_id)]);
  await conn.query("UPDATE rental_contracts SET status = 'out', stage = NULL, checked_out_at = NOW() WHERE tenant_id = ? AND id = ?", [tenantId, c.id]);
  await audit(conn, req, 'checkout', 'rental_contracts', c.id, { items: lines.map((l) => l.rental_item_id), via: 'group' });
  return { name, contract_id: c.id, out: true };
}

async function groupAfterHandout(conn, tenantId, groupId) {
  const left = await one(conn, "SELECT COUNT(*) AS n FROM rental_contracts WHERE tenant_id = ? AND group_id = ? AND status = 'to_fit'", [tenantId, groupId]);
  if (!Number(left.n)) await conn.query("UPDATE rental_groups SET status = 'out' WHERE tenant_id = ? AND id = ? AND status IN ('open','set')", [tenantId, groupId]);
}

/** The morning: scan a bag label (RC-<contract>) and that member's gear goes out. */
router.post('/groups/scan', counter, validate(z.object({ code: z.string().trim().min(1).max(40) })), async (req, res) => {
  const { tenantId } = req.auth;
  const id = F.parseContractCode(req.body.code);
  if (!id) throw bad('That is not a bag label. Bag labels start with RC-.');
  const out = await tx(async (conn) => {
    const c = await one(conn, 'SELECT * FROM rental_contracts WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, id]);
    if (!c || !c.group_id) throw notFound('Group bag');
    const settings = await R.getSettings(conn, tenantId);
    const r = await handOut(conn, req, c, settings, seasonFor(todayIn(await tzOf(tenantId))));
    if (r.out) await groupAfterHandout(conn, tenantId, c.group_id);
    return { ...r, group_id: c.group_id };
  });
  res.json(out);
});

/** Hand out every bag that is ready, for a leader collecting for the whole group. Members who are not ready are listed with why. */
router.post('/groups/:id/handout', counter, validate(z.object({ contract_ids: z.array(z.number().int().positive()).max(200).optional() })), async (req, res) => {
  const { tenantId } = req.auth;
  const out = await tx(async (conn) => {
    const g = await loadGroup(conn, tenantId, paramId(req), true);
    const settings = await R.getSettings(conn, tenantId);
    const season = seasonFor(todayIn(await tzOf(tenantId)));
    const list = await rows(conn, "SELECT * FROM rental_contracts WHERE tenant_id = ? AND group_id = ? AND status = 'to_fit' ORDER BY id FOR UPDATE", [tenantId, g.id]);
    const want = req.body.contract_ids ? list.filter((c) => req.body.contract_ids.includes(c.id)) : list;
    const results = [];
    for (const c of want) results.push(await handOut(conn, req, c, settings, season));
    await groupAfterHandout(conn, tenantId, g.id);
    return { out: results.filter((r) => r.out), skipped: results.filter((r) => !r.out) };
  });
  res.json(out);
});

/** Email the leader the link for parents, and the waiver link. */
router.post('/groups/:id/send-link', counter, async (req, res) => {
  const { tenantId } = req.auth;
  const g = await loadGroup(pool, tenantId, paramId(req));
  if (!g.leader_email) throw bad('Add the leader email first');
  if (!mailer.enabled()) throw bad('Email is not set up yet. Copy the link and send it yourself.');
  const t = await one(pool, 'SELECT slug, name, phone, waiver_text FROM tenants WHERE id = ?', [tenantId]);
  const link = await F.groupLink(pool, tenantId, g.id, baseUrl(req), t.slug);
  const waiver = t.waiver_text ? `${baseUrl(req)}/waiver/${t.slug}` : null;
  const day = dayOf(g.rental_on);
  const text = [`Hi ${g.leader_name || 'there'},`, '', `${g.name} is renting gear at ${t.name} on ${day}. Please send this link to each family. A parent fills in each child's height, weight, boot size and ability, and signs that they are true. It takes about two minutes on a phone.`, '', link, '',
    ...(waiver ? ['Everyone wearing rental gear also needs a signed waiver for the season:', waiver, ''] : []), t.phone ? `Questions? Call ${t.phone}.` : ''].join('\n');
  const html = `<p>Hi ${esc(g.leader_name || 'there')},</p><p>${esc(g.name)} is renting gear at ${esc(t.name)} on ${esc(day)}. Please send this link to each family. A parent fills in each child's height, weight, boot size and ability, and signs that they are true. It takes about two minutes on a phone.</p><p><a href="${link}">Fill in the rental form</a></p>${waiver ? `<p>Everyone wearing rental gear also needs a signed waiver for the season: <a href="${waiver}">sign the waiver</a></p>` : ''}`;
  const r = await mailer.send({ tenantId, to: g.leader_email, fromName: t.name, subject: `Rental form for ${g.name}`, text, html, tag: 'rental-group-link' });
  if (!r.ok) throw bad(`The email could not be sent: ${r.error}`);
  await audit(pool, req, 'send_link', 'rental_groups', g.id, null);
  res.json({ sent: true, to: g.leader_email });
});

module.exports = { router, publicRouter };
