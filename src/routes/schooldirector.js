'use strict';

// The ski school, round 2: the director: copy a day, the weather playbook, staffing, shift offers and reports (Track DIRECTOR).
// router is mounted at /skischool (staff); publicRouter under /public (no sign-in).
// tick() runs every few minutes (POST /jobs/lessons) and daily() once a day (POST /jobs/daily): return a small summary.
const express = require('express');
const { pool, tx, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, dateStr, todayIn, addDays } = require('../lib/util');
const { notFound, bad, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { baseUrl } = require('../lib/baseurl');
const { toCsv } = require('../lib/csv');
const LC = require('../lib/lessoncopy');
const W = require('../lib/lessonweather');
const ST = require('../lib/lessonstaffing');
const R = require('../lib/lessonreports');
const lessonlinks = require('../lib/lessonlinks');
const lessonconfirm = require('../lib/lessonconfirm');
const cardrefund = require('../lib/cardrefund');

const router = express.Router();
const publicRouter = express.Router();
const SA = require('../lib/schoolaccess'); // 2026.11.9: the school director and supervisor
const manager = SA.school('director');
const desk = SA.school('supervisor', 'counter');
const DISCIPLINES = ['ski', 'snowboard', 'telemark', 'adaptive'];
const hhmm = z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM');
const dt = z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/).transform((s) => { const t = s.replace('T', ' '); return t.length === 16 ? `${t}:00` : t; });
const tzOf = async (tenantId) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;

// ---------------------------------------------------------------- copy a day, templates
const copyBody = z.object({
  source: z.union([z.object({ from: dateStr, days: z.number().int().min(1).max(2).default(1) }), z.object({ template_id: z.number().int().positive() })]),
  targets: z.array(dateStr).min(1).max(30),
  with_instructors: z.boolean().default(false),
});
router.get('/director/day', manager, async (req, res) => {
  const date = dateStr.safeParse(req.query.date).success ? req.query.date : todayIn(await tzOf(req.auth.tenantId));
  res.json({ date, data: await LC.dayLessons(pool, req.auth.tenantId, date) });
});
router.post('/director/copy/preview', manager, validate(copyBody), async (req, res) => res.json(await LC.preview(req.auth.tenantId, req.body)));
router.post('/director/copy', manager, validate(copyBody), async (req, res) => res.status(201).json(await LC.copy(req.auth.tenantId, req.body, req)));
router.get('/director/copies', manager, async (req, res) => res.json({ data: await LC.recent(req.auth.tenantId) }));
router.post('/director/copies/:id/undo', manager, async (req, res) => res.json(await LC.undo(req.auth.tenantId, paramId(req), req)));
router.get('/director/templates', manager, async (req, res) => res.json({ data: await LC.templates(req.auth.tenantId) }));
router.post('/director/templates', manager, validate(z.object({ name: z.string().trim().min(2).max(80), date: dateStr })), async (req, res) => res.status(201).json(await LC.saveTemplate(req.auth.tenantId, req.body, req)));
router.delete('/director/templates/:id', manager, async (req, res) => {
  const [r] = await pool.query('DELETE FROM lesson_day_templates WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Template');
  await audit(pool, req, 'delete', 'lesson_day_templates', paramId(req), null);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- the weather playbook
const weatherScope = {
  action: z.enum(['delay', 'cancel', 'move']), date: dateStr, from_time: hhmm.optional(), to_time: hhmm.optional(),
  delay_minutes: z.number().int().min(5).max(360).optional(), makeup_date: dateStr.optional(),
};
const checkScope = (b) => {
  if (b.from_time && b.to_time && b.to_time <= b.from_time) throw bad('The end of the time window is before its start');
  if (b.action === 'delay' && !b.delay_minutes) throw bad('Say how many minutes to delay');
  if (b.action === 'move' && !b.makeup_date) throw bad('Pick the makeup day');
};
router.post('/director/weather/preview', SA.school('supervisor'), validate(z.object(weatherScope)), async (req, res) => {
  checkScope(req.body);
  const p = await W.preview(req.auth.tenantId, req.body);
  res.json({ ...p, words: W.words(req.body.action, p, req.body) });
});
router.post('/director/weather', SA.school('supervisor'), validate(z.object({ ...weatherScope, reason: z.string().trim().min(3, 'Say why, in a few words').max(300) })), async (req, res) => {
  checkScope(req.body);
  res.status(201).json(await W.run(req.auth.tenantId, req.body, req, baseUrl(req)));
});
router.get('/director/weather/calls', desk, async (req, res) => res.json({ data: await W.history(req.auth.tenantId) }));
router.get('/director/weather/calls/:id/choices', desk, async (req, res) => res.json({ data: await W.choicesOf(req.auth.tenantId, paramId(req)) }));
/** The desk records a family's choice for them (on the phone, at the window). */
router.post('/director/weather/choices/:id/choose', desk, validate(z.object({ choice: z.enum(['makeup', 'credit', 'refund']), session_id: z.number().int().positive().optional(), meeting_id: z.number().int().positive().optional() })), async (req, res) => {
  const t = req.auth.tenantId;
  const out = await tx(async (conn) => {
    const c = await one(conn, 'SELECT * FROM weather_choices WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, paramId(req)]);
    if (!c) throw notFound('Choice');
    return W.choose(conn, t, c, req.body, 'staff', req.auth.userId);
  });
  await after(t, out, baseUrl(req));
  res.json(out);
});
/** The makeups for one choice, so the desk can pick with the family. */
router.get('/director/weather/choices/:id', desk, async (req, res) => {
  const t = req.auth.tenantId;
  const c = await one(pool, 'SELECT token_sha FROM weather_choices WHERE tenant_id = ? AND id = ?', [t, paramId(req)]);
  if (!c) throw notFound('Choice');
  res.json(await W.familyViewById(t, paramId(req)));
});

async function after(tenantId, out, base) {
  if (out.refund_id) await cardrefund.send(tenantId, out.refund_id).catch(() => {});
  if (out.booking_id) await lessonconfirm.sendConfirmation(pool, tenantId, out.booking_id, base, { reason: 'weather' }).catch(() => {});
}

router.get('/director/settings', manager, async (req, res) => res.json(await W.settingsOf(pool, req.auth.tenantId)));
router.put('/director/settings', manager, validate(z.object({ weather_credit_product_id: z.number().int().positive().nullable().optional(), choice_days: z.number().int().min(1).max(30).optional() })), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  if (b.weather_credit_product_id && !(await one(pool, "SELECT id FROM products WHERE tenant_id = ? AND id = ? AND kind = 'lesson'", [t, b.weather_credit_product_id]))) throw bad('Pick a lesson product');
  const cur = await W.settingsOf(pool, t);
  const next = { ...cur, ...b };
  await pool.query('INSERT INTO school_director_settings (tenant_id, weather_credit_product_id, choice_days) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE weather_credit_product_id = VALUES(weather_credit_product_id), choice_days = VALUES(choice_days)',
    [t, next.weather_credit_product_id || null, next.choice_days]);
  await audit(pool, req, 'update', 'school_director_settings', null, b);
  res.json(next);
});

// ---------------------------------------------------------------- staffing, holidays, shift offers, certifications
router.get('/director/staffing', manager, async (req, res) => {
  const from = dateStr.safeParse(req.query.from).success ? req.query.from : undefined;
  res.json(await ST.view(req.auth.tenantId, { from, days: Number(req.query.days) || 14 }));
});
router.get('/director/holidays', manager, async (req, res) => {
  res.json({ data: (await pool.query('SELECT id, on_date, name FROM school_holidays WHERE tenant_id = ? ORDER BY on_date', [req.auth.tenantId]))[0] });
});
router.post('/director/holidays', manager, validate(z.object({ on_date: dateStr, name: z.string().trim().min(2).max(80) })), async (req, res) => {
  const [r] = await pool.query('INSERT INTO school_holidays (tenant_id, on_date, name) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), id = LAST_INSERT_ID(id)', [req.auth.tenantId, req.body.on_date, req.body.name]);
  await audit(pool, req, 'create', 'school_holidays', r.insertId, req.body);
  res.status(201).json({ id: r.insertId });
});
router.delete('/director/holidays/:id', manager, async (req, res) => {
  const [r] = await pool.query('DELETE FROM school_holidays WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Holiday');
  await audit(pool, req, 'delete', 'school_holidays', paramId(req), null);
  res.json({ ok: true });
});
router.get('/director/offers', manager, async (req, res) => res.json({ data: await ST.offersForManager(req.auth.tenantId, todayIn(await tzOf(req.auth.tenantId))) }));
router.get('/director/offers/free', manager, async (req, res) => {
  const q = z.object({ starts_at: dt, ends_at: dt, discipline: z.enum(DISCIPLINES).default('ski'), level_max: z.coerce.number().int().min(1).max(9).optional(), kids: z.enum(['0', '1']).optional() }).parse(req.query);
  const list = await ST.freeFor(pool, req.auth.tenantId, { ...q, kids: q.kids === '1' });
  res.json({ data: list.map((i) => ({ id: i.id, name: `${i.first_name} ${i.last_name}`, has_phone: Boolean(i.phone), has_email: Boolean(i.email) })) });
});
router.post('/director/offers', manager, validate(z.object({
  starts_at: dt, ends_at: dt, discipline: z.enum(DISCIPLINES).default('ski'), level_min: z.number().int().min(1).max(9).optional(), level_max: z.number().int().min(1).max(9).optional(),
  kids: z.boolean().default(false), spots: z.number().int().min(1).max(20).default(1), session_id: z.number().int().positive().optional(), note: z.string().trim().max(200).optional(),
  staff_ids: z.array(z.number().int().positive()).max(200).optional(),
})), async (req, res) => res.status(201).json(await ST.createOffer(req.auth.tenantId, req.body, req, baseUrl(req))));
router.post('/director/offers/:id/close', manager, async (req, res) => {
  const [r] = await pool.query("UPDATE shift_offers SET status = 'closed' WHERE tenant_id = ? AND id = ? AND status = 'open'", [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Open offer');
  await audit(pool, req, 'close', 'shift_offers', paramId(req), null);
  res.json({ ok: true });
});
const myStaff = (req) => { if (!req.auth.staffId) throw forbidden('Your sign-in is not linked to a staff member'); return req.auth.staffId; };
router.get('/offers/mine', requireRole('instructor', 'manager'), async (req, res) => {
  if (!req.auth.staffId) return res.json({ data: [] });
  res.json({ data: await ST.offersForStaff(req.auth.tenantId, req.auth.staffId, todayIn(await tzOf(req.auth.tenantId))) });
});
router.post('/offers/:id/accept', requireRole('instructor', 'manager'), async (req, res) => res.json(await ST.accept(req.auth.tenantId, paramId(req), myStaff(req), req)));
router.post('/offers/:id/decline', requireRole('instructor', 'manager'), async (req, res) => { await ST.decline(req.auth.tenantId, paramId(req), myStaff(req)); res.json({ ok: true }); });
router.get('/director/certs', manager, async (req, res) => res.json(await ST.certWatch(req.auth.tenantId)));

// ---------------------------------------------------------------- reports
router.get('/director/reports', manager, async (req, res) => {
  const today = todayIn(await tzOf(req.auth.tenantId));
  const from = dateStr.safeParse(req.query.from).success ? req.query.from : addDays(today, -30);
  const to = dateStr.safeParse(req.query.to).success ? req.query.to : today;
  if (to < from) throw bad('The last day is before the first');
  if (addDays(from, 366) < to) throw bad('Pick at most a year');
  const r = await R.report(req.auth.tenantId, from, to);
  if (req.query.format === 'csv') {
    const part = ['lessons', 'instructors', 'returning', 'fill_day', 'fill_time', 'fill_product', 'fill_level'].includes(req.query.part) ? req.query.part : 'lessons';
    const { cols, data } = R.csvRows(r, part);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="ski-school-${part}-${from}-to-${to}.csv"`);
    return res.send(toCsv(cols, data));
  }
  res.json(r);
});

// ---------------------------------------------------------------- the family's weather page (public, by token)
async function mountain(slug) {
  const t = await one(pool, "SELECT id, name, slug, timezone FROM tenants WHERE slug = ? AND status = 'active'", [String(slug || '')]);
  if (!t) throw notFound('Page');
  return t;
}
const gone = () => notFound('This link is not valid any more. Please call the ski school.');
publicRouter.get('/:slug/weather/:token', async (req, res) => {
  const t = await mountain(req.params.slug);
  const v = await W.familyView(t.id, req.params.token);
  if (!v) throw gone();
  res.set('cache-control', 'no-store').json(v);
});
publicRouter.post('/:slug/weather/:token/choose', validate(z.object({ choice: z.enum(['makeup', 'credit', 'refund']), session_id: z.number().int().positive().optional(), meeting_id: z.number().int().positive().optional() })), async (req, res) => {
  const t = await mountain(req.params.slug);
  const out = await tx(async (conn) => {
    const c = await W.choiceByToken(conn, t.id, req.params.token, true);
    if (!c) throw gone();
    return W.choose(conn, t.id, c, req.body, 'family');
  });
  await after(t.id, out, baseUrl(req));
  res.json({ ok: true, ...out, refund_id: undefined });
});
publicRouter.post('/:slug/weather/:token/use-credit', validate(z.object({ session_id: z.number().int().positive() })), async (req, res) => {
  const t = await mountain(req.params.slug);
  const id = await tx(async (conn) => {
    const c = await W.choiceByToken(conn, t.id, req.params.token, true);
    if (!c) throw gone();
    return W.useCredit(conn, t.id, c, req.body.session_id);
  });
  await after(t.id, { booking_id: id }, baseUrl(req));
  res.status(201).json({ ok: true });
});
/** The makeup bank for the family lesson page (Track PARENTS shows it): weather credits still to use. */
publicRouter.get('/:slug/lesson/:token/credits', async (req, res) => {
  const t = await mountain(req.params.slug);
  const b = await lessonlinks.find(pool, t.id, req.params.token);
  if (!b) throw gone();
  res.set('cache-control', 'no-store').json({ data: await W.creditsFor(pool, t.id, b.person_id) });
});

// ---------------------------------------------------------------- jobs
async function tick() { return {}; }
/** Weather choices not made in time become a lesson credit. */
async function daily() { return { weather: await W.expireOpen() }; }

module.exports = { router, publicRouter, tick, daily };
