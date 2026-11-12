'use strict';

// Collection routes and hauler oversight (release 2026.11.22, workstream "routes"; the rules are in lib/collectionroutes.js).
// Mounted at /api/v1/solid-waste, so the Trash and recycling gate (lib/modules.js) covers every path; each part also needs
// its own add-on (requireAddon: 403 module_disabled). Money only to owners and managers (lib/nomoney.js lists both prefixes).
//
// Collection routes (`collectionroutes`):
//   GET  /routes/today                  Today's cards: routes in progress, go-backs waiting (a crew member: their own route)
//   GET  /routes?date=                  a day's routes for this person (Crew: their own, and today's nobody is on yet)
//   GET  /routes/board?date=            the office's progress board: routes, truck, crew, marks for the map (managers, front desk)
//   GET  /routes/costs?from=&to=        collection and plowing days: hours, tons, and costs (managers)
//   GET  /routes/trucks, PUT /routes/trucks   the trucks to choose from; which collect and which plow (PUT: managers)
//   POST /routes/trucks/:id/hours       a truck's hours on a job (plowing, collection) with the crew's, costed by fund
//   POST /routes/trucks/:id/changeover  a plow / spreader changeover work order
//   GET  /routes/gobacks, POST /routes/gobacks, POST /routes/gobacks/:id/cancel   missed pickups to go back for
//   GET  /routes/snow-days, POST /routes/snow-days, POST /routes/snow-days/:id/undo  (declare and undo: managers)
//   GET  /routes/check?street_id=&house_number=&stream_id=&date=   where the route stands for an address (the office)
//   GET  /routes/:id                    the route: stops in order, go-backs, bulk stops, crew, truck, pre-trip
//   POST /routes/:id/start              truck, odometer, pre-trip
//   POST /routes/:id/photos             a photo as taken (raw body; ?stop_id=&lat=&lng=&client_ref=)
//   GET  /routes/:id/photos/:photoId    the photo as taken, with its SHA-256
//   POST /routes/:id/stops/:stopId/mark Done / Skipped (reason, photo) / To do; client_ref makes a replay harmless
//   PUT  /routes/:id/crew               who is on it (managers)
//   POST /routes/:id/finish             odometer, hours, landfill and recycling tickets
// Hauler oversight (`hauler`):
//   GET  /hauler/today, GET/PUT /hauler/contract, GET /hauler/missed, POST /hauler/missed/:requestId/forward,
//   POST /hauler/forwards/:id/collected, GET /hauler/scorecard?month=, GET /hauler/scorecards?months=
// Public (no sign-in; the page word 'hauler' belongs to Trash and recycling, and the hauler add-on must be on):
//   GET  /public/:slug/hauler/:token, POST /public/:slug/hauler/:token/collected
const express = require('express');
const { pool, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, dateStr, todayIn, addDays } = require('../lib/util');
const { bad, notFound } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { baseUrl } = require('../lib/baseurl');
const { todayRoute } = require('../lib/today');
const R = require('../lib/collectionroutes');

const router = express.Router();
const publicRouter = express.Router();
const anyone = requireRole('manager', 'counter', 'staff');
const office = requireRole('manager', 'counter');
const crew = requireRole('manager', 'staff');
const managers = requireRole('manager');
const routesOn = R.C.requireAddon('collectionroutes');
const haulerOn = R.C.requireAddon('hauler');
const MAX_PHOTO = 15 * 1024 * 1024;
const tzOf = async (t) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone;
const dateOf = async (req) => {
  const d = req.query.date ? String(req.query.date) : todayIn(await tzOf(req.auth.tenantId));
  if (!dateStr.safeParse(d).success) throw bad('date must be YYYY-MM-DD');
  return d;
};
const lat = z.number().min(-90).max(90).optional();
const lng = z.number().min(-180).max(180).optional();
const ref = z.string().regex(/^[A-Za-z0-9_-]{6,40}$/).optional();

// ---------------------------------------------------------------- collection routes
router.use('/routes', routesOn);
router.get('/routes/today', anyone, todayRoute((req) => R.todayCards(req)));
router.get('/routes', anyone, async (req, res) => res.json(await R.dayView(req, await dateOf(req))));
router.get('/routes/board', office, async (req, res) => res.json(await R.board(req, await dateOf(req))));
router.get('/routes/costs', managers, async (req, res) => {
  const tz = await tzOf(req.auth.tenantId); const today = todayIn(tz);
  const from = String(req.query.from || `${today.slice(0, 7)}-01`); const to = String(req.query.to || today);
  if (!dateStr.safeParse(from).success || !dateStr.safeParse(to).success || to < from) throw bad('from and to must be dates (YYYY-MM-DD), from first');
  if (to > addDays(from, 400)) throw bad('Pick at most about a year');
  res.json(await R.costs(req, from, to));
});

router.get('/routes/trucks', anyone, async (req, res) => res.json({ data: await R.trucks(req.auth.tenantId, await dateOf(req)) }));
router.put('/routes/trucks', managers, validate(z.object({ trucks: z.array(z.object({ truck_id: z.number().int().positive(), plows: z.boolean().default(false) })).max(200) })), async (req, res) => res.json(await R.saveTrucks(req, req.body.trucks)));
router.post('/routes/trucks/:id/hours', crew, validate(z.object({
  job: z.enum(['collection', 'plowing']), hours: z.number().positive().max(24), on_date: dateStr.optional(), note: z.string().trim().max(255).optional(),
  odometer: z.number().min(0).max(99999999).optional(),
  crew: z.array(z.object({ staff_id: z.number().int().positive(), hours: z.number().positive().max(24) })).max(20).optional(),
})), async (req, res) => {
  // A Crew login logs hours for itself; a manager for anyone.
  if (!['owner', 'manager'].includes(req.auth.role) && (req.body.crew || []).some((c) => c.staff_id !== req.auth.staffId)) throw bad('Log your own hours; a manager logs anyone\'s');
  res.status(201).json(await R.logTruckHours(req, { ...req.body, truck_id: paramId(req) }));
});
router.post('/routes/trucks/:id/changeover', crew, validate(z.object({ to: z.enum(['plow', 'collection']) })), async (req, res) => res.status(201).json(await R.changeover(req, paramId(req), req.body.to)));

router.get('/routes/gobacks', anyone, async (req, res) => {
  const status = String(req.query.status || 'waiting');
  if (!['waiting', 'done', 'cancelled', 'all'].includes(status)) throw bad('status must be waiting, done, cancelled or all');
  res.json({ data: await R.gobackList(req, { status }) });
});
router.post('/routes/gobacks', office, validate(z.object({
  request_id: z.number().int().positive().optional(), street_id: z.number().int().positive().optional(),
  house_number: z.string().trim().max(20).optional(), stream_id: z.number().int().positive().optional(),
  note: z.string().trim().max(200).optional(), due_on: dateStr.optional(),
}).refine((b) => b.request_id || b.street_id, 'Pick the request, or the street')), async (req, res) => res.status(201).json(await R.addGoback(req, req.body)));
router.post('/routes/gobacks/:id/cancel', office, async (req, res) => { await R.cancelGoback(req, paramId(req)); res.json({ ok: true }); });

router.get('/routes/snow-days', anyone, async (req, res) => res.json({ data: await R.snowDays(req.auth.tenantId, todayIn(await tzOf(req.auth.tenantId))), rule: (await R.settingsOf(pool, req.auth.tenantId)).holiday_rule || 'shift' }));
router.post('/routes/snow-days', managers, validate(z.object({ on_date: dateStr, zone_ids: z.array(z.number().int().positive()).max(100).default([]), note: z.string().trim().max(255).optional() })), async (req, res) => res.status(201).json(await R.declareSnowDay(req, req.body)));
router.post('/routes/snow-days/:id/undo', managers, async (req, res) => res.json(await R.undoSnowDay(req, paramId(req))));

router.get('/routes/check', office, async (req, res) => {
  const q = z.object({ street_id: z.coerce.number().int().positive(), house_number: z.string().trim().max(20).optional(), stream_id: z.coerce.number().int().positive().optional(), date: dateStr.optional() }).safeParse(req.query);
  if (!q.success) throw bad('Give the street, house number and stream');
  const date = q.data.date || todayIn(await tzOf(req.auth.tenantId));
  res.json({ date, result: await R.routeCheck(pool, req.auth.tenantId, { streetId: q.data.street_id, houseNo: q.data.house_number || null, streamId: q.data.stream_id || null, date }) });
});

router.get('/routes/:id', anyone, async (req, res) => res.json(await R.routeView(req, paramId(req))));
router.post('/routes/:id/start', crew, validate(z.object({
  truck_id: z.number().int().positive(), odometer: z.number().min(0).max(99999999).optional(),
  pretrip_inspection_id: z.number().int().positive().optional(), pretrip_skipped: z.boolean().optional(), lat, lng,
})), async (req, res) => res.json(await R.start(req, paramId(req), req.body)));
router.post('/routes/:id/photos', crew, express.raw({ type: () => true, limit: MAX_PHOTO }), async (req, res) => {
  const q = z.object({ stop_id: z.coerce.number().int().positive().optional(), lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional(), client_ref: ref, queued: z.string().optional() }).safeParse(req.query);
  if (!q.success) throw bad('Something about that photo upload was not right');
  const out = await R.addPhoto(req, paramId(req), req.body, q.data);
  res.status(out.repeat ? 200 : 201).json(out);
});
router.get('/routes/:id/photos/:photoId', anyone, async (req, res) => {
  const t = req.auth.tenantId;
  await R.routeView(req, paramId(req)); // 404 for a route this person may not see
  const p = await one(pool, 'SELECT id, mime, sha256, original FROM collection_photos WHERE tenant_id = ? AND route_id = ? AND id = ?', [t, paramId(req), paramId(req, 'photoId')]);
  if (!p) throw notFound('Photo');
  await audit(pool, req, 'route_photo_view', 'collection_routes', paramId(req), { photo_id: Number(p.id) });
  res.set('Content-Type', p.mime).set('X-Content-SHA256', p.sha256).set('Cache-Control', 'no-store').send(p.original);
});
router.post('/routes/:id/stops/:stopId/mark', crew, validate(z.object({
  status: z.enum(['done', 'skipped', 'todo']), reason: z.enum(Object.keys(R.REASONS)).optional(), note: z.string().trim().max(200).optional(),
  photo_id: z.number().int().positive().optional(), photo_ref: ref, client_ref: ref, at: z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/).optional(), queued: z.boolean().optional(), lat, lng,
})), async (req, res) => res.json(await R.mark(req, paramId(req), paramId(req, 'stopId'), req.body)));
router.put('/routes/:id/crew', managers, validate(z.object({ user_ids: z.array(z.number().int().positive()).max(12) })), async (req, res) => res.json(await R.setCrew(req, paramId(req), [...new Set(req.body.user_ids)])));
router.post('/routes/:id/finish', crew, validate(z.object({
  truck_id: z.number().int().positive().optional(), odometer: z.number().min(0).max(99999999).optional(), truck_hours: z.number().positive().max(24).optional(),
  crew: z.array(z.object({ user_id: z.number().int().positive(), hours: z.number().min(0).max(24) })).max(12).optional(),
  tickets: z.array(z.object({
    facility: z.string().trim().min(2, 'Name the landfill or recycling place').max(120), facility_id: z.number().int().positive().optional(), stream_id: z.number().int().positive().optional(),
    ticket_no: z.string().trim().max(40).optional(), net_tons: z.number().positive().max(60), gross_lbs: z.number().min(0).max(200000).optional(), tare_lbs: z.number().min(0).max(200000).optional(),
    fee_cents: z.number().int().min(0).max(10000000).optional(), client_ref: ref,
  })).max(12).optional(),
  client_ref: ref,
})), async (req, res) => res.json(await R.finish(req, paramId(req), req.body)));

// ---------------------------------------------------------------- hauler oversight
router.use('/hauler', haulerOn);
router.get('/hauler/today', office, todayRoute(async (req) => {
  const t = req.auth.tenantId;
  const s = await R.settingsOf(pool, t);
  if (s.model !== 'contract') return [];
  const { forwards, not_sent: notSent } = await R.forwardsList(req, { show: 'open' });
  const late = forwards.filter((f) => f.late).length;
  const cards = [];
  if (forwards.length) cards.push({ title: 'Missed pickups with the hauler', count: forwards.length, text: late ? `${late} past the contract's time to collect` : 'All within the contract\'s time so far', href: '#/bulk?tab=hauler' });
  if (notSent.length) cards.push({ title: 'Missed pickups not sent to the hauler', count: notSent.length, text: 'Send them from the Hauler tab', href: '#/bulk?tab=hauler' });
  return cards;
}));
router.get('/hauler/contract', office, async (req, res) => {
  const t = req.auth.tenantId; const mgr = ['owner', 'manager'].includes(req.auth.role);
  const s = await R.settingsOf(pool, t);
  const list = await rows(pool, 'SELECT * FROM hauler_contracts WHERE tenant_id = ? ORDER BY starts_on DESC, id DESC LIMIT 20', [t]);
  res.json({ model: s.model, hauler: { name: s.hauler_name || null, phone: s.hauler_phone || null, email: s.hauler_email || null, url: s.hauler_url || null },
    contract: R.contractShape(list[0] || null, mgr), history: list.slice(1).map((c) => R.contractShape(c, mgr)), can_edit: mgr });
});
router.put('/hauler/contract', managers, validate(z.object({
  id: z.number().int().positive().optional(), hauler_name: z.string().trim().min(2, 'Name the hauler').max(120), starts_on: dateStr, ends_on: dateStr.optional().nullable(),
  service_hours: z.number().int().min(1).max(336), households: z.number().int().min(0).max(1000000).optional().nullable(),
  price_per_household_cents: z.number().int().min(0).max(1000000).optional().nullable(), penalty_cents: z.number().int().min(0).max(10000000).optional().nullable(),
  penalty_after: z.number().int().min(0).max(1000).optional(), terms: z.string().trim().max(8000).optional().nullable(),
})), async (req, res) => { const id = await R.saveContract(req, req.body); res.json({ id }); });
router.get('/hauler/missed', office, async (req, res) => {
  const show = String(req.query.show || 'open');
  if (!['open', 'all'].includes(show)) throw bad('show must be open or all');
  res.json(await R.forwardsList(req, { show }));
});
router.post('/hauler/missed/:requestId/forward', office, async (req, res) => {
  const out = await R.forward(req.auth.tenantId, paramId(req, 'requestId'), { base: baseUrl(req), by: req.auth.userId, req });
  delete out.link; // the link is for the hauler; the office resends instead of copying it
  res.status(201).json(out);
});
router.post('/hauler/forwards/:id/collected', office, validate(z.object({ note: z.string().trim().max(300).optional(), at: z.string().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/).optional() })), async (req, res) => {
  const t = req.auth.tenantId; const now = require('../lib/util').nowIn(await tzOf(t));
  const at = req.body.at ? `${req.body.at.replace('T', ' ')}:00` : now;
  if (at > now) throw bad('That time has not come yet');
  await R.markCollected(t, paramId(req), { at, via: 'staff', note: req.body.note || null, by: req.auth.userId, req });
  res.json({ ok: true });
});
router.get('/hauler/scorecard', office, async (req, res) => {
  const month = String(req.query.month || todayIn(await tzOf(req.auth.tenantId)).slice(0, 7));
  res.json(await R.scorecard(req, month));
});
router.get('/hauler/scorecards', managers, async (req, res) => {
  const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 36);
  const now = todayIn(await tzOf(req.auth.tenantId)).slice(0, 7);
  const list = [];
  let [y, m] = now.split('-').map(Number);
  for (let i = 0; i < months; i += 1) { list.push(await R.scorecard(req, `${y}-${String(m).padStart(2, '0')}`)); m -= 1; if (!m) { m = 12; y -= 1; } }
  res.json({ months: list.map(({ by_zone, by_week, complaints, ...x }) => x) });
});

// ---------------------------------------------------------------- the hauler's link (public)
const noStore = (res) => res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
async function publicOk(slug) {
  const t = await one(pool, "SELECT id FROM tenants WHERE slug = ? AND org_type = 'municipality'", [String(slug)]);
  if (!t || !(await R.addonOn(Number(t.id), 'hauler'))) throw notFound('Page');
}
publicRouter.get('/:slug/hauler/:token', async (req, res) => {
  noStore(res); await publicOk(req.params.slug);
  res.json(await R.haulerView(req.params.slug, req.params.token));
});
publicRouter.post('/:slug/hauler/:token/collected', validate(z.object({ note: z.string().trim().max(300).optional() })), async (req, res) => {
  noStore(res); await publicOk(req.params.slug);
  res.json(await R.haulerCollected(req.params.slug, req.params.token, req.body.note || null, req.ip));
});

module.exports = { router, publicRouter };
