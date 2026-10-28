'use strict';

// Patrol, part two: the collision report, checklists, the patrol home screen, and the follow-up email desk.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, partialOf, setClause, todayIn, addDays, dateTimeStr, normDateTime } = require('../lib/util');
const { notFound, bad, forbidden, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const CL = require('../lib/checklists');
const { TYPE_KEYS: ATTRACTION_TYPES, TYPES: ATTRACTION_TYPE_LIST } = require('../lib/attractions');
const followups = require('../lib/followups');
const mailer = require('../lib/mailer');
const patrolRouter = require('./patrol');

const router = express.Router();
const patrol = requireRole('patrol', 'manager');
const PA = require('../lib/patrolaccess');
const { baseUrl } = require('../lib/baseurl');
const needs = (feature, message) => PA.needs(pool, feature, message);
const editable = (conn, req, id) => patrolRouter.editableCase(conn, req, id);
const admin = async (req) => { if (!(await PA.can(pool, req, 'followups'))) throw forbidden('Your patrol access level cannot manage follow-up emails'); };
const bool = z.boolean().transform((v) => (v ? 1 : 0));
const txt = (n) => z.string().max(n).nullable().optional();

// ---------------------------------------------------------------- collision report
const collisionSchema = z.object({
  collision_type: z.enum(['skier_skier', 'skier_object', 'skier_lift_structure', 'skier_vehicle', 'skier_animal', 'other']).default('skier_skier'),
  hit_and_run: bool.optional(), unknown_party_description: txt(1000), right_of_way: txt(1000),
  factors: z.array(z.string().max(60)).max(20).transform((a) => a.join(',')).optional(),
  police_notified: bool.optional(), police_agency: txt(150), police_report_no: txt(60), risk_notified: bool.optional(),
  equipment_held: txt(500), property_damage: txt(1000), findings: z.string().max(20000).nullable().optional(), legal_hold: bool.optional(),
});
const collisionCols = Object.keys(collisionSchema.shape);

router.put('/incidents/:id/collision', patrol, needs('create_case'), validate(collisionSchema), async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    await editable(conn, req, id);
    const keys = Object.keys(req.body).filter((k) => collisionCols.includes(k));
    await conn.query(
      `INSERT INTO incident_collisions (tenant_id, incident_id, ${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (?, ?, ${keys.map(() => '?').join(', ')})
       ON DUPLICATE KEY UPDATE ${keys.map((k) => `\`${k}\` = VALUES(\`${k}\`)`).join(', ')}`,
      [req.auth.tenantId, id, ...keys.map((k) => req.body[k])],
    );
    await audit(conn, req, 'save_collision', 'incidents', id, { fields: keys });
  });
  res.json({ ok: true });
});

const partyFields = {
  role: z.enum(['skier', 'snowboarder', 'other_snow', 'pedestrian', 'employee', 'vehicle', 'unknown']).default('skier'),
  first_name: txt(100), last_name: txt(100), age_years: z.number().int().min(0).max(120).nullable().optional(),
  phone: txt(40), email: z.string().email().max(255).nullable().optional(), address: txt(255),
  helmet: z.enum(['yes', 'no', 'unknown']).optional(), equipment: txt(255), direction: txt(255),
  position: z.enum(['uphill', 'downhill', 'side_by_side', 'crossing', 'stopped', 'unknown']).optional(),
  speed: z.enum(['stopped', 'slow', 'moderate', 'fast', 'unknown']).optional(),
  statement: z.string().max(10000).nullable().optional(), left_scene: bool.optional(), refused_contact_info: bool.optional(),
  patient_id: z.number().int().positive().nullable().optional(),
};
const partyCols = Object.keys(partyFields);

async function checkPatient(conn, req, id, patientId) {
  if (patientId && !(await one(conn, 'SELECT id FROM incident_patients WHERE tenant_id = ? AND incident_id = ? AND id = ?', [req.auth.tenantId, id, patientId]))) throw notFound('Patient');
}

router.post('/incidents/:id/parties', patrol, needs('create_case'), validate(z.object(partyFields)), async (req, res) => {
  const id = paramId(req);
  const newId = await tx(async (conn) => {
    await editable(conn, req, id);
    await checkPatient(conn, req, id, req.body.patient_id);
    const keys = Object.keys(req.body).filter((k) => partyCols.includes(k));
    const [r] = await conn.query(`INSERT INTO incident_parties (tenant_id, incident_id, ${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (?, ?, ${keys.map(() => '?').join(', ')})`, [req.auth.tenantId, id, ...keys.map((k) => req.body[k])]);
    await audit(conn, req, 'add_party', 'incidents', id, { row: r.insertId });
    return r.insertId;
  });
  res.status(201).json({ id: newId });
});

router.patch('/incidents/:id/parties/:rowId', patrol, needs('create_case'), validate(partialOf(partyFields)), async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    await editable(conn, req, id);
    await checkPatient(conn, req, id, req.body.patient_id);
    if (await one(conn, 'SELECT id FROM incident_parties WHERE tenant_id = ? AND incident_id = ? AND id = ? AND voided_at IS NOT NULL', [req.auth.tenantId, id, paramId(req, 'rowId')])) throw conflict('This person was marked entered in error');
    const set = setClause(req.body, partyCols);
    if (!set) throw bad('No updatable fields supplied');
    const [r] = await conn.query(`UPDATE incident_parties SET ${set.sql} WHERE tenant_id = ? AND incident_id = ? AND id = ?`, [...set.values, req.auth.tenantId, id, paramId(req, 'rowId')]);
    if (!r.affectedRows) throw notFound('Party');
    await audit(conn, req, 'update_party', 'incidents', id, { row: paramId(req, 'rowId'), fields: Object.keys(req.body) });
  });
  res.json({ ok: true });
});

/** A person recorded by mistake is marked entered in error with a reason; they and their statement stay on the record. DELETE does the same. */
async function voidParty(req, res) {
  const id = paramId(req);
  await tx(async (conn) => {
    await editable(conn, req, id);
    const r = await patrolRouter.voidCaseRow(conn, req, id, 'incident_parties', paramId(req, 'rowId'), 'Party');
    await audit(conn, req, 'void_party', 'incidents', id, { row: Number(r.id), reason: req.body.reason });
  });
  res.json({ ok: true });
}
router.post('/incidents/:id/parties/:rowId/void', patrol, needs('create_case'), validate(patrolRouter.voidSchema), voidParty);
router.delete('/incidents/:id/parties/:rowId', patrol, needs('create_case'), validate(patrolRouter.voidSchema), voidParty);

/** The printed collision report goes to insurers and other parties, so printing it is logged. */
router.post('/incidents/:id/collision-printed', patrol, needs('create_case'), async (req, res) => {
  const id = paramId(req);
  if (!(await one(pool, 'SELECT id FROM incidents WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]))) throw notFound('Incident');
  await audit(pool, req, 'collision_print', 'incidents', id);
  res.status(204).end();
});

// ---------------------------------------------------------------- checklists
// The built-in library (src/lib/checklists.js) a patrol admin switches on or off, plus the mountain's own lists. Every
// tick keeps the list's title and the item's words as they were, so a past case reads the same after a list changes.

/** The lists patrollers can use. With ?case=<id>, lists already ticked on that case come too, even if switched off. */
router.get('/checklists', patrol, needs('view_cases'), async (req, res) => {
  const caseId = /^\d{1,15}$/.test(String(req.query.case || '')) ? Number(req.query.case) : null;
  res.json({ data: await CL.listsFor(pool, req.auth.tenantId, { incidentId: caseId }) });
});

/** A tick's list and words: built-in, or one of the mountain's own (tenant-scoped). Null when there is no such item. */
async function checklistItem(conn, tenantId, key) {
  const b = CL.BY_KEY.get(key);
  if (b) return { listId: b.list.id, title: b.list.title, label: b.label, scope: b.list.scope, on: CL.builtinOn(b.list, await CL.contextOf(conn, tenantId)), removed: false };
  const c = CL.parseCustomKey(key);
  if (!c) return null;
  const r = await one(conn, `SELECT l.id, l.title, l.scope, l.enabled, l.archived_at, i.label, i.removed_at FROM patrol_checklist_items i
    JOIN patrol_checklists l ON l.tenant_id = i.tenant_id AND l.id = i.checklist_id WHERE i.tenant_id = ? AND i.id = ? AND i.checklist_id = ?`, [tenantId, c.itemId, c.listId]);
  if (!r) return null;
  return { listId: CL.customId(r.id), title: r.title, label: r.label, scope: r.scope, on: Boolean(Number(r.enabled)) && !r.archived_at, removed: Boolean(r.removed_at) };
}

/** A mountain wall-clock time ('YYYY-MM-DD HH:MM:SS') as UTC, the way done_at is kept. */
function utcOf(local, timeZone) {
  const offset = (ms) => {
    const f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
  };
  const g = Date.parse(`${local.replace(' ', 'T')}Z`);
  let t = g - offset(g); t = g - offset(t);
  return t;
}

// A tick sent from the phone's outbox carries the time it was taken (`at`, the mountain's clock) and its own id.
router.post('/incidents/:id/checklist', patrol, needs('create_case'), validate(z.object({
  key: z.string().max(60), patient_id: z.number().int().positive().optional(), done: z.boolean(),
  at: dateTimeStr.transform(normDateTime).optional(), client_ref: z.string().regex(/^[a-z0-9]{6,40}$/).optional(),
})), async (req, res) => {
  const id = paramId(req);
  const { key, done } = req.body;
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    await editable(conn, req, id);
    await checkPatient(conn, req, id, req.body.patient_id);
    const item = await checklistItem(conn, t, key);
    if (!item) throw bad('Unknown checklist item');
    const pid = req.body.patient_id || 0;
    if (item.scope === 'patient' && !pid) throw bad('This checklist is for one patient: say which');
    if (item.scope === 'case' && pid) throw bad('This checklist is for the whole case, not one patient');
    // A list switched off (or archived) takes ticks only on a case where it was already in use.
    if (!item.on && !(await CL.tickedLists(conn, t, id)).has(item.listId)) throw conflict('This checklist is switched off for your patrol. A patrol admin can switch it on in Settings, Patrol, Checklists.');
    if (done) {
      if (item.removed) throw conflict('This item was taken off its checklist');
      const tz = (await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone;
      const at = req.body.at ? utcOf(req.body.at, tz) : null;
      const ok = at !== null && Number.isFinite(at) && at <= Date.now() + 5 * 60000 && at >= Date.now() - 72 * 3600000;
      const doneAt = new Date(ok ? at : Date.now()).toISOString().slice(0, 19).replace('T', ' ');
      await conn.query(`INSERT IGNORE INTO incident_checklist (tenant_id, incident_id, patient_id, item_key, done_by, done_at, entered_at, list_id, list_title, item_label)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?)`, [t, id, pid, key, req.auth.userId, doneAt, item.listId, item.title, item.label]);
    } else {
      await conn.query('DELETE FROM incident_checklist WHERE tenant_id = ? AND incident_id = ? AND patient_id = ? AND item_key = ?', [t, id, pid, key]);
    }
    await audit(conn, req, done ? 'check' : 'uncheck', 'incidents', id, { key, patient_id: pid || null, list: item.listId, list_title: item.title, item: item.label });
  });
  res.json({ ok: true });
});

// ---- setup: Settings, Patrol, Checklists (the patrol admin)
const checklistAdmin = needs('manage_settings', 'Only a patrol admin can change the checklists');

/** How many cases each list has been ticked on: Map listId -> count. */
async function checklistUse(db, tenantId) {
  const [r] = await db.query('SELECT DISTINCT incident_id, list_id, item_key FROM incident_checklist WHERE tenant_id = ?', [tenantId]);
  const seen = new Map();
  for (const x of r) {
    const lid = x.list_id || (CL.BY_KEY.get(x.item_key) ? CL.BY_KEY.get(x.item_key).list.id : (CL.parseCustomKey(x.item_key) ? CL.customId(CL.parseCustomKey(x.item_key).listId) : null));
    if (!lid) continue;
    if (!seen.has(lid)) seen.set(lid, new Set());
    seen.get(lid).add(Number(x.incident_id));
  }
  return new Map([...seen].map(([k, v]) => [k, v.size]));
}

router.get('/checklists/setup', patrol, checklistAdmin, async (req, res) => {
  const t = req.auth.tenantId;
  const [ctx, used, own] = await Promise.all([CL.contextOf(pool, t), checklistUse(pool, t), CL.customLists(pool, t, { withArchived: true })]);
  res.json({
    groups: CL.GROUPS.map(([key, label]) => ({ key, label })),
    attraction_types: ATTRACTION_TYPE_LIST.map((x) => ({ key: x.key, label: x.label })),
    builtin: CL.LISTS.map((l) => {
      const start = CL.startsOn(l, ctx);
      return { ...CL.shape(l), enabled: CL.builtinOn(l, ctx), chosen: ctx.switches.has(l.id), starts_on: start.on, start_note: start.why, original: CL.ORIGINAL.includes(l.id), cases: used.get(l.id) || 0 };
    }),
    custom: own.map((l) => ({ ...l, cases: used.get(l.id) || 0 })),
  });
});

router.put('/checklists/builtin/:listId', patrol, checklistAdmin, validate(z.object({ enabled: z.boolean() })), async (req, res) => {
  const l = CL.BY_ID.get(String(req.params.listId));
  if (!l) throw notFound('Checklist');
  await tx(async (conn) => {
    await conn.query('INSERT INTO patrol_checklist_switches (tenant_id, list_id, enabled, updated_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), updated_by = VALUES(updated_by)',
      [req.auth.tenantId, l.id, req.body.enabled ? 1 : 0, req.auth.userId]);
    await audit(conn, req, req.body.enabled ? 'checklist_on' : 'checklist_off', 'patrol_checklists', null, { list: l.id, title: l.title });
  });
  res.json({ ok: true });
});

const customItems = z.array(z.object({ id: z.number().int().positive().optional(), label: z.string().trim().min(1, 'Every item needs words').max(255) })).min(1, 'Add at least one item').max(40);
const customFields = {
  title: z.string().trim().min(1, 'Give the list a title').max(150),
  when: z.string().trim().max(300).nullable().optional(),
  scope: z.enum(['patient', 'case']),
  attraction_type: z.enum(ATTRACTION_TYPES).nullable().optional(),
  enabled: z.boolean().optional(),
  items: customItems,
};

async function titleFree(conn, tenantId, title, exceptId = 0) {
  if (await one(conn, 'SELECT id FROM patrol_checklists WHERE tenant_id = ? AND archived_at IS NULL AND title = ? AND id <> ?', [tenantId, title, exceptId])) throw conflict('Your patrol already has a checklist with that title');
}

router.post('/checklists/custom', patrol, checklistAdmin, validate(z.object(customFields).refine((b) => !b.items.some((i) => i.id), { message: 'A new list has new items only' })), async (req, res) => {
  const b = req.body; const t = req.auth.tenantId;
  const out = await tx(async (conn) => {
    await titleFree(conn, t, b.title);
    const [r] = await conn.query('INSERT INTO patrol_checklists (tenant_id, title, when_text, scope, attraction_type, enabled, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [t, b.title, b.when || null, b.scope, b.attraction_type || null, b.enabled === false ? 0 : 1, req.auth.userId, req.auth.userId]);
    const lid = r.insertId;
    let sort = 0;
    for (const it of b.items) await conn.query('INSERT INTO patrol_checklist_items (tenant_id, checklist_id, label, sort) VALUES (?, ?, ?, ?)', [t, lid, it.label, (sort += 1)]);
    await audit(conn, req, 'checklist_create', 'patrol_checklists', lid, { title: b.title, scope: b.scope, attraction_type: b.attraction_type || null, items: b.items.length });
    return lid;
  });
  res.status(201).json({ id: CL.customId(out), db_id: out });
});

router.patch('/checklists/custom/:id', patrol, checklistAdmin, validate(partialOf(customFields)), async (req, res) => {
  const id = paramId(req); const t = req.auth.tenantId; const b = req.body;
  await tx(async (conn) => {
    const l = await one(conn, 'SELECT * FROM patrol_checklists WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (!l) throw notFound('Checklist');
    if (l.archived_at) throw conflict('This checklist is archived. Bring it back before changing it.');
    const changed = [];
    if (b.title !== undefined && b.title !== l.title) { await titleFree(conn, t, b.title, id); changed.push('title'); }
    if (b.scope !== undefined && b.scope !== l.scope) {
      // Ticks already recorded belong to one patient or to the whole case; that cannot change under them.
      if (await one(conn, 'SELECT id FROM incident_checklist WHERE tenant_id = ? AND list_id = ? LIMIT 1', [t, CL.customId(id)])) throw conflict('This checklist is already in use on cases, so it cannot switch between one patient and the whole case. Archive it and write a new one.');
      changed.push('scope');
    }
    const cols = { title: b.title, when_text: b.when === undefined ? undefined : (b.when || null), scope: b.scope, attraction_type: b.attraction_type === undefined ? undefined : (b.attraction_type || null), enabled: b.enabled === undefined ? undefined : (b.enabled ? 1 : 0) };
    const set = Object.entries(cols).filter(([, v]) => v !== undefined);
    if (set.length) await conn.query(`UPDATE patrol_checklists SET ${set.map(([k]) => `\`${k}\` = ?`).join(', ')}, updated_by = ? WHERE tenant_id = ? AND id = ?`, [...set.map(([, v]) => v), req.auth.userId, t, id]);
    let items = null;
    if (b.items) {
      const current = await rows(conn, 'SELECT id, label FROM patrol_checklist_items WHERE tenant_id = ? AND checklist_id = ? AND removed_at IS NULL', [t, id]);
      const known = new Map(current.map((x) => [Number(x.id), x]));
      if (b.items.some((i) => i.id && !known.has(i.id))) throw bad('An item is not on this checklist');
      const kept = new Set(b.items.filter((i) => i.id).map((i) => i.id));
      if (kept.size !== b.items.filter((i) => i.id).length) throw bad('An item is listed twice');
      items = { added: 0, reworded: 0, removed: 0 };
      let sort = 0;
      for (const it of b.items) {
        sort += 1;
        if (it.id) {
          if (known.get(it.id).label !== it.label) items.reworded += 1;
          await conn.query('UPDATE patrol_checklist_items SET label = ?, sort = ? WHERE tenant_id = ? AND id = ?', [it.label, sort, t, it.id]);
        } else {
          await conn.query('INSERT INTO patrol_checklist_items (tenant_id, checklist_id, label, sort) VALUES (?, ?, ?, ?)', [t, id, it.label, sort]);
          items.added += 1;
        }
      }
      // An item taken off keeps its row, so its key is never given to anything else; ticks keep their own words.
      for (const x of current) if (!kept.has(Number(x.id))) { await conn.query('UPDATE patrol_checklist_items SET removed_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ?', [t, x.id]); items.removed += 1; }
    }
    await audit(conn, req, 'checklist_update', 'patrol_checklists', id, { fields: Object.keys(b).filter((k) => k !== 'items'), changed, items });
  });
  res.json({ ok: true });
});

/** Archive: off for good, kept for the cases that used it. Bring back undoes it. Never deleted. */
async function archiveList(req, res, archive) {
  const id = paramId(req); const t = req.auth.tenantId;
  await tx(async (conn) => {
    const l = await one(conn, 'SELECT id, title, archived_at FROM patrol_checklists WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (!l) throw notFound('Checklist');
    if (!archive) await titleFree(conn, t, l.title, id);
    await conn.query(`UPDATE patrol_checklists SET archived_at = ${archive ? 'UTC_TIMESTAMP()' : 'NULL'}, archived_by = ?, updated_by = ? WHERE tenant_id = ? AND id = ?`, [archive ? req.auth.userId : null, req.auth.userId, t, id]);
    await audit(conn, req, archive ? 'checklist_archive' : 'checklist_restore', 'patrol_checklists', id, { title: l.title });
  });
  res.json({ ok: true });
}
router.post('/checklists/custom/:id/archive', patrol, checklistAdmin, (req, res) => archiveList(req, res, true));
router.post('/checklists/custom/:id/restore', patrol, checklistAdmin, (req, res) => archiveList(req, res, false));

// ---------------------------------------------------------------- the patrol home screen
router.get('/home', patrol, async (req, res) => {
  const { tenantId, staffId } = req.auth;
  const access = await PA.accessOf(pool, req);
  const reviewSet = await require('../lib/review').settingsOf(pool, tenantId);
  const canApprove = await require('../lib/review').canReview(pool, req, reviewSet);
  const reviewCats = reviewSet.enabled ? reviewSet.categories : null;
  const canView = access.features.has('view_cases');
  const cols = `i.id, i.season, i.seq, i.occurred_at, i.location, i.category, i.severity, i.summary, i.report_state, (SELECT COUNT(*) FROM incident_patients p WHERE p.tenant_id = i.tenant_id AND p.incident_id = i.id AND p.voided_at IS NULL) AS patient_count`;
  const num = (r) => ({ ...r, case_number: r.seq ? `${r.season}-${String(r.seq).padStart(4, '0')}` : null });
  const mine = staffId && canView
    ? await rows(pool, `SELECT ${cols} FROM incidents i WHERE i.tenant_id = ? AND i.report_state = 'draft' AND EXISTS (SELECT 1 FROM incident_responders r WHERE r.tenant_id = i.tenant_id AND r.incident_id = i.id AND r.staff_id = ? AND r.voided_at IS NULL) ORDER BY i.occurred_at DESC LIMIT 20`, [tenantId, staffId])
    : [];
  const recent = canView ? await rows(pool, `SELECT ${cols} FROM incidents i WHERE i.tenant_id = ? AND i.report_state = 'draft' ORDER BY i.occurred_at DESC LIMIT 10`, [tenantId]) : [];
  // a reviewer's own reports are reviewed by someone else, so they are not in their own queue
  const waiting = canApprove && canView ? await rows(pool, `SELECT ${cols} FROM incidents i WHERE i.tenant_id = ? AND i.report_state = 'submitted'${reviewCats ? ' AND (i.submitted_by IS NULL OR i.submitted_by <> ?)' : ''} ORDER BY i.submitted_at LIMIT 30`, reviewCats ? [tenantId, req.auth.userId] : [tenantId]) : [];
  const [held] = canApprove ? await rows(pool, "SELECT COUNT(*) AS n FROM followups WHERE tenant_id = ? AND status = 'held'", [tenantId]) : [{ n: 0 }];
  const t = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const today = todayIn(t.timezone);
  const [stale] = !canView ? [{ n: 0 }] : await rows(pool, "SELECT COUNT(*) AS n FROM incidents WHERE tenant_id = ? AND report_state = 'draft' AND occurred_at < ? AND category IN ('injury','medical','collision')", [tenantId, `${addDays(today, -1)} 00:00:00`]);
  res.json({ mine: mine.map(num), recent: recent.map(num), waiting: waiting.map(num), followups_held: held.n, stale_drafts: stale.n, can_approve: canApprove, can_view_cases: canView });
});

// ---------------------------------------------------------------- follow-up desk (directors and managers)
const settingsSchema = z.object({
  followup_enabled: bool.optional(), followup_days: z.number().int().min(1).max(30).optional(),
  patrol_org_name: txt(150), mail_address: txt(300), reply_to: z.string().email().max(255).nullable().optional(),
  donate_amounts: z.string().max(60).regex(/^\d{1,4}(,\s*\d{1,4}){0,5}$/, 'Use whole dollar amounts separated by commas, for example 25,50,100,250').optional(),
  donate_blurb: txt(600), tax_note: txt(500),
});
const settingCols = ['followup_enabled', 'followup_days', 'patrol_org_name', 'mail_address', 'reply_to', 'donate_amounts', 'donate_blurb', 'tax_note'];

router.get('/followup-settings', patrol, needs('followups'), async (req, res) => {
  await admin(req);
  const t = await one(pool, `SELECT name, slug, ${settingCols.join(', ')}, (SELECT COUNT(*) FROM donations d WHERE d.tenant_id = tenants.id) AS donation_count FROM tenants WHERE id = ?`, [req.auth.tenantId]);
  res.json({ ...t, followup_enabled: Boolean(t.followup_enabled), email_ready: mailer.enabled(), card_ready: (await require('../lib/connect').payee(req.auth.tenantId)).ok });
});

router.put('/followup-settings', patrol, needs('followups'), validate(settingsSchema), async (req, res) => {
  await admin(req);
  const set = setClause(req.body, settingCols);
  if (!set) throw bad('Nothing to save');
  await pool.query(`UPDATE tenants SET ${set.sql} WHERE id = ?`, [...set.values, req.auth.tenantId]);
  await audit(pool, req, 'followup_settings', 'tenants', req.auth.tenantId, { fields: Object.keys(req.body) });
  res.json({ ok: true });
});

router.get('/followups', patrol, needs('followups'), async (req, res) => {
  await admin(req);
  const status = ['held', 'queued', 'sent', 'skipped', 'failed', 'unsubscribed'].includes(req.query.status) ? req.query.status : null;
  const data = await rows(pool, `SELECT f.id, f.incident_id, f.status, f.hold_reason, f.due_on, f.sent_at, f.error, f.for_guardian, f.to_email, f.rating, f.comment, f.responded_at,
      i.season, i.seq, i.severity, i.occurred_at, p.first_name
    FROM followups f JOIN incidents i ON i.tenant_id = f.tenant_id AND i.id = f.incident_id JOIN incident_patients p ON p.tenant_id = f.tenant_id AND p.id = f.patient_id
    WHERE f.tenant_id = ? ${status ? 'AND f.status = ?' : ''} ORDER BY FIELD(f.status, 'held', 'failed', 'queued', 'sent', 'skipped', 'unsubscribed'), f.due_on DESC, f.id DESC LIMIT 300`, status ? [req.auth.tenantId, status] : [req.auth.tenantId]);
  await audit(pool, req, 'view_followups', 'audit_log', null, { rows: data.length });
  res.json({ data: data.map((r) => ({ ...r, case_number: r.seq ? `${r.season}-${String(r.seq).padStart(4, '0')}` : null })) });
});

router.get('/followup-summary', patrol, needs('followups'), async (req, res) => {
  await admin(req);
  const t = req.auth.tenantId;
  const by = await rows(pool, 'SELECT status, COUNT(*) AS n FROM followups WHERE tenant_id = ? GROUP BY status', [t]);
  const [fb] = await rows(pool, 'SELECT COUNT(rating) AS rated, ROUND(AVG(rating), 1) AS avg_rating FROM followups WHERE tenant_id = ?', [t]);
  const [don] = await rows(pool, 'SELECT COUNT(*) AS gifts, COALESCE(SUM(amount_cents), 0) AS cents, SUM(monthly) AS monthly FROM donations WHERE tenant_id = ?', [t]);
  const comments = await rows(pool, "SELECT rating, comment, responded_at FROM followups WHERE tenant_id = ? AND comment IS NOT NULL AND comment <> '' ORDER BY responded_at DESC LIMIT 10", [t]);
  const gifts = await rows(pool, 'SELECT amount_cents, monthly, name, created_at, followup_id IS NOT NULL AS from_email FROM donations WHERE tenant_id = ? ORDER BY id DESC LIMIT 15', [t]);
  res.json({ by_status: Object.fromEntries(by.map((x) => [x.status, x.n])), rated: fb.rated, avg_rating: fb.avg_rating, gifts: don.gifts, total_cents: Number(don.cents), monthly_gifts: Number(don.monthly || 0), comments, recent_gifts: gifts });
});

async function loadFollowup(req) {
  await admin(req);
  const f = await one(pool, 'SELECT * FROM followups WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!f) throw notFound('Follow-up');
  return f;
}
router.post('/followups/:id/approve', patrol, needs('followups'), async (req, res) => {
  const f = await loadFollowup(req);
  if (f.status !== 'held') throw bad('Only a held follow-up can be approved');
  await pool.query("UPDATE followups SET status = 'queued', hold_reason = NULL WHERE id = ?", [f.id]);
  await audit(pool, req, 'followup_approve', 'incidents', f.incident_id, { followup_id: f.id });
  res.json({ ok: true });
});
router.post('/followups/:id/skip', patrol, needs('followups'), async (req, res) => {
  const f = await loadFollowup(req);
  if (!['held', 'queued', 'failed'].includes(f.status)) throw bad('That follow-up has already gone out or been closed');
  await pool.query("UPDATE followups SET status = 'skipped' WHERE id = ?", [f.id]);
  await audit(pool, req, 'followup_skip', 'incidents', f.incident_id, { followup_id: f.id });
  res.json({ ok: true });
});
router.post('/followups/:id/send', patrol, needs('followups'), async (req, res) => {
  const f = await loadFollowup(req);
  if (!['held', 'queued', 'failed'].includes(f.status)) throw bad('That follow-up has already gone out or been closed');
  if (!mailer.enabled()) throw bad('Email is not set up yet. Add the Postmark token and sender address first.');
  const tenant = await one(pool, 'SELECT * FROM tenants WHERE id = ?', [req.auth.tenantId]);
  const status = await followups.sendOne(f, tenant, baseUrl(req));
  if (status === 'busy') throw conflict('That follow-up is already being sent');
  await audit(pool, req, 'followup_send', 'incidents', f.incident_id, { followup_id: f.id, status });
  res.json({ status });
});

module.exports = router;
