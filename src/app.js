'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { pool } = require('./db');
const { authenticate } = require('./middleware/auth');
const { rateLimit } = require('./middleware/rateLimit');
const followPublic = require('./routes/followpublic');
const patrolPlus = require('./routes/patrolplus');
const kiosk = require('./routes/kiosk');
const { errorHandler, AppError } = require('./lib/errors');
const config = require('./config');

const authRoutes = require('./routes/auth');
const people = require('./routes/people');
const customerplus = require('./routes/customerplus');
const messagesRoutes = require('./routes/messages');
const shopRoutes = require('./routes/shop');
const shopAdmin = require('./routes/shopadmin');
const crm = require('./routes/crm');
const { products, pricing } = require('./routes/catalog');
const sales = require('./routes/sales');
const { checkout, giftCards } = require('./routes/checkout');
const rentals = require('./routes/rentals');
const board = require('./routes/board');
const { schedule, publicRouter } = require('./routes/schedule');
const workforce = require('./routes/workforce');
const skischool = require('./routes/skischool');
const schoolplus = require('./routes/schoolplus');
const lessonbook = require('./routes/lessonbook');
const { logFailure } = require('./lib/jobs');
const patrol = require('./routes/patrol');
const patrolTeam = require('./routes/team');
const dispatch = require('./routes/dispatch');
const patrolForm = require('./routes/form');
const patrolMap = require('./routes/map');
const park = require('./routes/park');
const opsRoutes = require('./routes/ops');
const maintenance = require('./routes/maintenance');
const documents = require('./routes/documents');
const availability = require('./routes/availability');
const waiverRoutes = require('./routes/waivers');
const programs = require('./routes/programs');
const reports = require('./routes/reports');
const finance = require('./routes/finance');
const platform = require('./routes/platform');
const sandboxRoutes = require('./routes/sandbox');
const modules = require('./lib/modules');

function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Cloud Run terminates TLS in front of the container
  app.disable('x-powered-by');
  // The patrol map loads tile images from the configured tile servers, so only those hosts are added to img-src.
  const tileHosts = [...new Set(config.map.layers.map((l) => (l.url.match(/^https:\/\/[^/]+/) || [''])[0].replace('{s}', '*')).filter(Boolean))];
  app.use(helmet({ contentSecurityPolicy: { directives: { ...helmet.contentSecurityPolicy.getDefaultDirectives(), 'img-src': ["'self'", 'data:', ...tileHosts] } } }));
  const origins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: origins.length ? origins : false }));
  // Stripe signs the exact bytes it sends, so this one route reads the raw body before the JSON parser sees anything.
  app.post('/api/v1/stripe/webhook', express.raw({ type: '*/*', limit: '200kb' }), async (req, res) => {
    const stripe = require('./lib/stripe');
    if (!stripe.enabled()) return res.status(404).json({ error: 'Not found' });
    let event;
    try {
      if (!Buffer.isBuffer(req.body) || !stripe.verifyWebhook(req.body, req.get('stripe-signature'), { secret: config.stripe.webhookSecret })) throw new Error('bad signature');
      event = JSON.parse(req.body.toString('utf8'));
    } catch (_) {
      // Logged so an alert fires: a wrong STRIPE_WEBHOOK_SECRET silently stops every online sale.
      logFailure({ job: 'stripe_webhook', message: 'bad signature' });
      return res.status(400).json({ error: 'Bad signature' });
    }
    try { res.json({ received: true, ...(await lessonbook.handleWebhook(event, config.stripe.publicUrl || `${req.protocol}://${req.get('host')}`)) }); } catch (err) {
      logFailure({ job: 'stripe_webhook', event: event && event.type, message: err.message });
      res.status(500).json({ error: 'Try again' });
    }
  });
  app.use(/^\/api\/v1\/public\/[^/]+\/shop\/orders$/, express.json({ limit: '2mb' })); // season pass photos ride along with the basket
  app.use('/api/v1/online-shop/brand', express.json({ limit: '1200kb' })); // logo and hero photo together
  app.use(express.json({ limit: '400kb' })); // a customer photo is about 40 KB; a card statement a few hundred rows

  // The admin web app: plain files, no build step. HTML/JS/CSS revalidate on every load so an update
  // shows up immediately; fonts never change and cache for a year.
  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      setHeaders(res, file) {
        res.setHeader('Cache-Control', file.endsWith('.woff2') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    }),
  );

  // The guest help page (opened from a QR code on a trail sign). It is a static page that reads its mountain from the URL.
  app.get('/help/:slug', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'help.html')));

  // The public lesson booking page, one per mountain, read from the URL like the help page.
  app.get('/book/:slug', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'book.html')));
  app.get('/shop/:slug', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'shop.html')));
  app.get('/try', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'try.html')));
  app.get('/platform', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'platform.html')));
  // The public waiver signing page: /waiver/<mountain>, and a signed copy at /waiver/<mountain>?copy=<token>.
  app.get('/waiver/:slug', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'waiver.html')));
  app.get('/availability/:slug', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'availability.html')));

  // Pages behind the follow-up email: /f/<token> (rate us, give, stop) and /give/<mountain> (give).
  app.get(['/f/:token', '/give/:slug'], (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'give.html')));

  // The time clock kiosk page: /kiosk on a paired tablet, /kiosk/<code> once, to pair it.
  app.get(['/kiosk', '/kiosk/:code'], (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'kiosk.html')));

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/readyz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
    } catch (_) {
      return res.status(503).json({ ok: false, reason: 'database' });
    }
    // The database is reachable; is it migrated for this version?
    const { LATEST } = require('./schema');
    const [r] = await pool.query('SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1', [LATEST.table, LATEST.index]);
    if (!r.length) return res.status(503).json({ ok: false, reason: 'run npm run migrate' });
    return res.json({ ok: true });
  });

  const api = express.Router();
  // Responses can hold guest and patient details: tell browsers and proxies never to keep a copy.
  api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  // 10 sign-in attempts a minute per address. LOGIN_RATE_LIMIT exists so automated tests can raise it.
  api.use('/auth/login', rateLimit({ windowMs: 60_000, max: Number(process.env.LOGIN_RATE_LIMIT) || 10, message: 'Too many login attempts' }));
  api.use('/auth/mfa', rateLimit({ windowMs: 60_000, max: Number(process.env.LOGIN_RATE_LIMIT) || 20, message: 'Too many attempts' }));
  api.use('/tenants', rateLimit({ windowMs: 60_000, max: 5 }));
  api.use('/auth/change-password', rateLimit({ windowMs: 60_000, max: 10, message: 'Too many attempts' }));
  api.use('/users', rateLimit({ windowMs: 60_000, max: 60 }));
  // The guest help form is open to anyone with the link, so it gets its own tight limit: 5 requests per 10 minutes per address.
  api.post('/public/:slug/help', rateLimit({ windowMs: 600_000, max: Number(process.env.HELP_RATE_LIMIT) || 5, message: 'Too many requests. Please call patrol or flag down a patroller.' }));
  // Online lesson requests take a name and contact details from anyone, so they get a tight limit too: 8 a hour per address.
  api.post('/public/:slug/requests', rateLimit({ windowMs: 3_600_000, max: Number(process.env.BOOKING_RATE_LIMIT) || 8, message: 'Too many requests from this address. Please call the ski school.' }));
  api.post('/public/:slug/shop/orders', rateLimit({ windowMs: 3_600_000, max: Number(process.env.SHOP_RATE_LIMIT) || 12, message: 'Too many orders from this address. Please call the mountain.' }));
  api.post(['/public/:slug/shop/waitlist', '/public/:slug/shop/group', '/public/:slug/shop/orders/:token/change'], rateLimit({ windowMs: 3_600_000, max: Number(process.env.SHOP_RATE_LIMIT) || 12, message: 'Too many requests from this address. Please call the mountain.' }));
  // Anyone can sign a waiver, so signing has its own limit: a family signing at the counter tablet stays well inside it.
  api.post('/public/:slug/waiver/sign', rateLimit({ windowMs: 3_600_000, max: Number(process.env.WAIVER_RATE_LIMIT) || 40, message: 'Too many waivers from this address. Please ask at the ticket window.' }));
  api.post(['/public/followup/:token/give', '/public/:slug/give'], rateLimit({ windowMs: 600_000, max: Number(process.env.GIVE_RATE_LIMIT) || 20, message: 'Too many attempts. Please try again later.' }));
  // The kiosk has no login, so its doors are rate limited: pairing is tight, and each PIN is also locked per person after five misses.
  api.post('/kiosk/pair', rateLimit({ windowMs: 600_000, max: Number(process.env.KIOSK_PAIR_LIMIT) || 10, message: 'Too many tries. Ask a manager for a new code.' }));
  api.use('/kiosk', rateLimit({ windowMs: 60_000, max: Number(process.env.KIOSK_RATE_LIMIT) || 60, message: 'Too many requests, slow down' }), kiosk.publicRouter);
  api.use('/internal/jobs', rateLimit({ windowMs: 60_000, max: 10 }), followPublic.jobs);
  api.use('/trial', rateLimit({ windowMs: 3_600_000, max: Number(process.env.SANDBOX_RATE_LIMIT) || 5, message: 'Too many demo requests from this address. Try again later, or ask us for a walkthrough.' }), sandboxRoutes);
  api.use('/platform', rateLimit({ windowMs: 60_000, max: Number(process.env.PLATFORM_RATE_LIMIT) || 60, message: 'Too many attempts' }), platform);
  api.use('/public', rateLimit({ windowMs: 60_000, max: 120 }), modules.publicGate, followPublic.publicRouter, messagesRoutes.publicRouter, shopRoutes.publicRouter, publicRouter, dispatch.publicRouter, lessonbook, availability.publicRouter, waiverRoutes.publicRouter);
  api.use(authRoutes); // login, tenants, users, me (each route applies authenticate itself where needed)

  // Everything below requires a valid token; tenant comes from the token only.
  api.use(authenticate);
  api.use(modules.moduleGate);
  api.use('/messages', messagesRoutes.router);
  api.use('/online-shop', shopRoutes.router);
  api.use('/online-shop', shopAdmin.router);
  api.use('/people', customerplus);
  api.use('/people', people);
  api.use('/checkout', checkout);
  // Gift card codes are the secret, so balance checks are rate limited against guessing.
  api.use('/gift-cards', rateLimit({ windowMs: 60_000, max: 40, message: 'Too many gift card checks, slow down' }), giftCards);
  api.use('/crm', crm);
  api.use('/products', products);
  api.use('/pricing', pricing);
  api.use(sales); // /orders, /tickets/scan
  api.use('/rentals', rentals);
  api.use('/schedule', schedule);
  api.use('/workforce', workforce);
  api.use('/kiosk-admin', kiosk.adminRouter);
  api.use('/skischool', skischool);
  api.use('/skischool', schoolplus);
  api.use('/patrol', patrol);
  api.use('/patrol', patrolPlus);
  api.use('/patrol', patrolTeam);
  api.use('/patrol', dispatch.router);
  api.use('/patrol', patrolForm);
  api.use('/patrol', patrolMap);
  api.use('/park', park);
  api.use('/ops', opsRoutes);
  api.use('/ops', maintenance);
  api.use('/documents', documents);
  api.use('/availability', availability.router);
  api.use('/waivers', waiverRoutes.router);
  api.use('/programs', programs);
  api.use('/reports', reports);
  api.use('/board', board);
  api.use(finance); // tax rules, tenant profile, till, reconciliation, receipts, exports

  app.use('/api/v1', api);
  app.use((_req, _res, next) => next(new AppError(404, 'Not found')));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
