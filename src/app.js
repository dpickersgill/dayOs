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
const safetyRoutes = require('./routes/safety');
const demoTours = require('./routes/demotours');
const inboxRoutes = require('./routes/inbox');
const patrolReview = require('./routes/patrolreview');
const patrolTeam = require('./routes/team');
const dispatch = require('./routes/dispatch');
const patrolForm = require('./routes/form');
const patrolMap = require('./routes/map');
const park = require('./routes/park');
const opsRoutes = require('./routes/ops');
const maintenance = require('./routes/maintenance');
const assetRoutes = require('./routes/assets');
const accessRoutes = require('./routes/access');
const documents = require('./routes/documents');
const availability = require('./routes/availability');
const waiverRoutes = require('./routes/waivers');
const programs = require('./routes/programs');
const reports = require('./routes/reports');
const finance = require('./routes/finance');
const platform = require('./routes/platform');
const sandboxRoutes = require('./routes/sandbox');
const modules = require('./lib/modules');
const release = require('./lib/version');
const whatsNew = require('./routes/whatsnew');

function createApp() {
  const app = express();
  // Cloud Run terminates TLS in front of the container (one hop). Behind the Cloud Armor load balancer there are two, so
  // cloud-armor.sh sets TRUST_PROXY_HOPS=2; otherwise every visitor would share the load balancer's address for rate limits.
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
  app.disable('x-powered-by');
  // The patrol map loads tile images from the configured tile servers, so only those hosts are added to img-src.
  const tileHosts = [...new Set(config.map.layers.map((l) => (l.url.match(/^https:\/\/[^/]+/) || [''])[0].replace('{s}', '*')).filter(Boolean))];
  // On the product website's own addresses only, Cloudflare Web Analytics may load its beacon and report visits (no
  // cookies); the app, the console and the mountains' pages keep the strict policy.
  const siteOnly = (value) => (req) => (config.site.hosts.includes(String(req.hostname || '').toLowerCase()) ? value : "'self'");
  app.use(helmet({ contentSecurityPolicy: { directives: { ...helmet.contentSecurityPolicy.getDefaultDirectives(), 'img-src': ["'self'", 'data:', 'blob:', ...tileHosts],
    'script-src': ["'self'", siteOnly('https://static.cloudflareinsights.com')], 'connect-src': ["'self'", siteOnly('https://cloudflareinsights.com')] } } }));
  // Smaller pages for slow mountain connections and faster loads (search engines rank on it). Event streams are left alone.
  app.use(require('compression')({ filter: (req, res) => !String(res.getHeader('Content-Type') || '').includes('event-stream') && require('compression').filter(req, res) }));
  const origins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: origins.length ? origins : false }));
  // Staging: kept out of search engines and, with STAGING_GATE, behind a shared password (middleware/staging.js).
  app.use(require('./middleware/staging').staging());
  // Stripe signs the exact bytes it sends, so this one route reads the raw body before the JSON parser sees anything.
  app.post('/api/v1/stripe/webhook', express.raw({ type: '*/*', limit: '200kb' }), async (req, res) => {
    const stripe = require('./lib/stripe');
    if (!stripe.enabled()) return res.status(404).json({ error: 'Not found' });
    let event;
    try {
      // Two endpoints in Stripe can point here: the platform's own events, and Connect events from the mountains' accounts.
      const sig = req.get('stripe-signature');
      const okSig = Buffer.isBuffer(req.body) && (stripe.verifyWebhook(req.body, sig, { secret: config.stripe.webhookSecret })
        || (config.stripe.connectWebhookSecret && stripe.verifyWebhook(req.body, sig, { secret: config.stripe.connectWebhookSecret })));
      if (!okSig) throw new Error('bad signature');
      event = JSON.parse(req.body.toString('utf8'));
    } catch (_) {
      // Logged so an alert fires: a wrong STRIPE_WEBHOOK_SECRET silently stops every online sale.
      logFailure({ job: 'stripe_webhook', message: 'bad signature' });
      return res.status(400).json({ error: 'Bad signature' });
    }
    try {
      const connect = require('./lib/connect');
      const screened = await connect.screen(event); // an event from a mountain's own account only counts for that mountain
      if (screened.done) return res.json({ received: true, ...screened.done });
      if (!event.account) {
        const billed = await require('./routes/billing').handleWebhook(event); // the mountain's own Verdynt/OS subscription
        if (billed) return res.json({ received: true, ...billed });
      }
      const out = await lessonbook.handleWebhook(event, config.stripe.publicUrl || `${req.protocol}://${req.get('host')}`);
      res.json({ received: true, ...out }); } catch (err) {
      logFailure({ job: 'stripe_webhook', event: event && event.type, message: err.message });
      res.status(500).json({ error: 'Try again' });
    }
  });
  app.use(/^\/api\/v1\/public\/[^/]+\/shop\/orders$/, express.json({ limit: '2mb' })); // season pass photos ride along with the basket
  app.use(/^\/api\/v1\/public\/[^/]+\/rental-form$/, express.json({ limit: '1200kb' })); // a signature for each renter on the guest rental form
  app.use('/api/v1/online-shop/brand', express.json({ limit: '1200kb' })); // logo and hero photo together
  app.use('/api/v1/platform/prospects/import', express.json({ limit: '2mb' })); // a research batch of ski areas
  app.use(express.json({ limit: '400kb' })); // a customer photo is about 40 KB; a card statement a few hundred rows

  // The product website: its pages at /site everywhere, and at / on its own addresses (SITE_HOSTS).
  const site = require('./routes/site');
  app.use(site.pages);

  // The admin web app: plain files, no build step. HTML/JS/CSS revalidate on every load so an update
  // shows up immediately; fonts never change and cache for a year.
  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      setHeaders(res, file) {
        // Fonts never change. The website's own files are asked for with ?v=<version>, so they can be kept a year too.
        const versioned = res.req && res.req.query && res.req.query.v && /[\\/]public[\\/]site[\\/]/.test(file);
        res.setHeader('Cache-Control', file.endsWith('.woff2') || versioned ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    }),
  );

  // The guest help page (opened from a QR code on a trail sign). It is a static page that reads its mountain from the URL.
  // Locating a caller: the one-time link dispatch texts to a guest.
  app.get('/locate/:token', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'locate.html')));
  app.get('/help/:slug', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'help.html')));
  app.get('/lost/:slug', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'lost.html')));
  app.get('/reserve/:slug', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'reserve.html')));
  app.get('/c/:token', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'claim-share.html'))); // a claim file or season report shared with an insurer
  app.get('/w/:token', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'witness.html'))); // a witness writes their own statement
  // An outreach email's "not interested" link: the page, and a mail app's one-click unsubscribe (a POST to the same address).
  app.get('/o/:token', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'outreach-stop.html')));
  app.post('/o/:token', rateLimit({ windowMs: 60_000, max: 30 }), async (req, res, next) => {
    try {
      if (!/^[a-f0-9]{32}$/.test(req.params.token)) return res.status(404).send('Not found');
      const seq = await require('./lib/outreach').notInterested(require('./db').pool, req.params.token);
      return seq ? res.status(200).send('Unsubscribed') : res.status(404).send('Not found');
    } catch (err) { return next(err); }
  });

  // The public lesson booking page, one per mountain, read from the URL like the help page.
  app.get('/book/:slug', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'book.html')));
  // The ski school's family pages (2026.11.5): one lesson booking (check in, details, change the date, the recap and a tip),
  // find my level, claiming a waitlist spot, asking for a private by name, and a weather change to choose from.
  app.get('/lesson/:slug/:token', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'lesson.html')));
  app.get('/level/:slug', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'level.html')));
  app.get('/waitlist/:slug/:token', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'waitlist.html')));
  app.get('/private/:slug', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'private.html')));
  app.get('/weather/:slug/:token', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'weather.html')));
  app.get(['/season/:slug/:token', '/season/:slug/share/:token'], (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'season.html'))); // a guest's day or season recap (guests round 2)
  // Fair by design (guests round 2, FAIR): the conditions guarantee, a pass on hold, a payment plan's card, a renewal, a waitlist offer.
  app.get(['/guarantee/:slug/:token', '/blocked/:slug/:token', '/plan/:slug/:token', '/renew/:slug/:token', '/pass-offer/:slug/:token'], (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'fair.html')));
  app.get('/shop/:slug', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'shop.html')));
  app.get('/programs/:slug', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'register.html')));
  app.get('/family/:slug', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'family.html')));
  app.get('/reload/:slug', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'shop.html'))); // reload an RFID card online (Guests round 2)
  app.get(['/gift/:slug/:token', '/gift-balance/:slug'], (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'gift.html'))); // a gift experience, the gift card balance
  app.get('/try', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'try.html')));
  app.get('/platform', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'platform.html')));
  // The public waiver signing page: /waiver/<mountain>, and a signed copy at /waiver/<mountain>?copy=<token>.
  // The guest rental form: /rental-form/<mountain>, with ?t= for an order or ?g= for a group.
  app.get('/rental-form/:slug', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'rental-form.html')));
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
    const [r] = LATEST.column
      ? await pool.query('SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1', [LATEST.table, LATEST.column])
      : await pool.query('SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1', [LATEST.table, LATEST.index]);
    if (!r.length) return res.status(503).json({ ok: false, reason: 'run npm run migrate', version: release.VERSION });
    // Staging also says which build it runs, so promote.sh can check it is putting live exactly what was checked.
    return res.json({ ok: true, version: release.VERSION, ...(config.staging ? { stage: 'staging', build: release.BUILD } : {}) });
  });
  // security.txt (RFC 9116): where to report a security problem.
  app.get('/.well-known/security.txt', (_req, res) => {
    const exp = new Date(Date.now() + 180 * 86400000).toISOString().replace(/\.\d+Z$/, 'Z');
    res.type('text/plain').set('Cache-Control', 'public, max-age=86400').send(`Contact: mailto:${config.site.supportEmail}\nExpires: ${exp}\nPreferred-Languages: en\n`);
  });
  // Which version is running: open to anyone (the sign-in screen shows it, and deploy.sh reads it before deploying).
  // The build and its date only for someone signed in (Help shows them); everyone else sees the release number alone.
  app.get('/version', (req, res) => {
    res.set('Cache-Control', 'no-store');
    let signedIn = false;
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (m) { try { signedIn = !require('jsonwebtoken').verify(m[1], config.jwtSecret, { algorithms: ['HS256'] }).typ; } catch (_) { signedIn = false; } }
    const stage = config.staging ? { stage: 'staging' } : {};
    const support = { support_email: config.site.supportEmail };
    res.json(signedIn ? { version: release.VERSION, build: release.BUILD, built_at: release.BUILT_AT, ...support, ...stage } : { version: release.VERSION, ...support, ...stage });
  });

  const api = express.Router();
  // Responses can hold guest and patient details: tell browsers and proxies never to keep a copy.
  api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  // 10 sign-in attempts a minute per address. LOGIN_RATE_LIMIT exists so automated tests can raise it.
  api.use('/auth/login', rateLimit({ windowMs: 60_000, max: Number(process.env.LOGIN_RATE_LIMIT) || 10, message: 'Too many login attempts' }));
  api.use('/auth/mfa', rateLimit({ windowMs: 60_000, max: Number(process.env.LOGIN_RATE_LIMIT) || 20, message: 'Too many attempts' }));
  api.use(['/auth/passkey', '/auth/pin-login', '/auth/terminal'], rateLimit({ windowMs: 60_000, max: Number(process.env.LOGIN_RATE_LIMIT) || 20, message: 'Too many sign-in attempts' }));
  // Emailed sign-in and reset codes: asking for one is limited per address (each sends an email), and so is trying them.
  api.post('/auth/email-code', rateLimit({ windowMs: 600_000, max: Number(process.env.LOGIN_RATE_LIMIT) || 6, message: 'Too many codes asked for from here. Wait a few minutes, or sign in with your password.' }));
  api.use(['/auth/email-code/verify', '/auth/password-reset'], rateLimit({ windowMs: 60_000, max: Number(process.env.LOGIN_RATE_LIMIT) || 10, message: 'Too many attempts' }));
  api.use('/tenants', rateLimit({ windowMs: 60_000, max: 5 }));
  api.use('/auth/change-password', rateLimit({ windowMs: 60_000, max: 10, message: 'Too many attempts' }));
  api.use('/users', rateLimit({ windowMs: 60_000, max: 60 }));
  // The guest help form is open to anyone with the link, so it gets its own tight limit: 5 requests per 10 minutes per address.
  api.post('/public/locate/:token', rateLimit({ windowMs: 600_000, max: 30, message: 'Too many tries. Please call patrol.' }));
  api.post('/public/:slug/partner/:id/reserve', rateLimit({ windowMs: 600_000, max: Number(process.env.HELP_RATE_LIMIT) || 10, message: 'Too many reservations from here. Please call the mountain.' }));
  api.post('/public/:slug/lost', rateLimit({ windowMs: 600_000, max: Number(process.env.HELP_RATE_LIMIT) || 5, message: 'Too many reports from here. Please call the mountain.' }));
  api.post('/public/:slug/help', rateLimit({ windowMs: 600_000, max: Number(process.env.HELP_RATE_LIMIT) || 5, message: 'Too many requests. Please call patrol or flag down a patroller.' }));
  // Online lesson requests take a name and contact details from anyone, so they get a tight limit too: 8 a hour per address.
  // "Next times with room" for a full lesson: a guest looks a few times; a script inflating sold-out demand does not get far.
  api.get('/public/:slug/booking/next/:id', rateLimit({ windowMs: 600_000, max: Number(process.env.NEXT_TIMES_RATE_LIMIT) || 30, message: 'Too many looks from this address. Please try again in a few minutes.' }));
  api.post('/public/:slug/requests', rateLimit({ windowMs: 3_600_000, max: Number(process.env.BOOKING_RATE_LIMIT) || 8, message: 'Too many requests from this address. Please call the ski school.' }));
  api.post('/public/:slug/shop/orders', rateLimit({ windowMs: 3_600_000, max: Number(process.env.SHOP_RATE_LIMIT) || 12, message: 'Too many orders from this address. Please call the mountain.' }));
  api.post(['/public/:slug/programs/register', '/public/:slug/programs/waitlist', '/public/:slug/family/link', '/public/:slug/family/session'], rateLimit({ windowMs: 3_600_000, max: Number(process.env.SHOP_RATE_LIMIT) || 12, message: 'Too many registrations from this address. Please call the mountain.' }));
  // The guest assistant costs money per question: 20 questions and 5 messages to the mountain an hour per address.
  api.post('/public/:slug/assistant/ask', rateLimit({ windowMs: 3_600_000, max: Number(process.env.ASSISTANT_GUEST_LIMIT) || 20, message: 'That is a lot of questions. Please call the mountain.' }));
  api.post('/public/:slug/assistant/contact', rateLimit({ windowMs: 3_600_000, max: 5, message: 'Too many messages from this address. Please call the mountain.' }));
  api.post(['/public/:slug/shop/waitlist', '/public/:slug/shop/group', '/public/:slug/shop/orders/:token/change'], rateLimit({ windowMs: 3_600_000, max: Number(process.env.SHOP_RATE_LIMIT) || 12, message: 'Too many requests from this address. Please call the mountain.' }));
  // Anyone can sign a waiver, so signing has its own limit: a family signing at the counter tablet stays well inside it.
  api.post('/public/:slug/waiver/sign', rateLimit({ windowMs: 3_600_000, max: Number(process.env.WAIVER_RATE_LIMIT) || 40, message: 'Too many waivers from this address. Please ask at the ticket window.' }));
  // The rental form takes names and signatures from anyone: a family fits well inside it, a bot does not.
  api.post('/public/:slug/rental-form', rateLimit({ windowMs: 3_600_000, max: Number(process.env.RENTAL_FORM_RATE_LIMIT) || 20, message: 'Too many forms from this address. Please fill it in at the rental shop.' }));
  api.post(['/public/followup/:token/give', '/public/:slug/give'], rateLimit({ windowMs: 600_000, max: Number(process.env.GIVE_RATE_LIMIT) || 20, message: 'Too many attempts. Please try again later.' }));
  // The kiosk has no login, so its doors are rate limited: pairing is tight, and each PIN is also locked per person after five misses.
  api.post('/kiosk/pair', rateLimit({ windowMs: 600_000, max: Number(process.env.KIOSK_PAIR_LIMIT) || 10, message: 'Too many tries. Ask a manager for a new code.' }));
  api.use('/kiosk', rateLimit({ windowMs: 60_000, max: Number(process.env.KIOSK_RATE_LIMIT) || 60, message: 'Too many requests, slow down' }), kiosk.publicRouter);
  // Gates, turnstiles and handheld readers: no login, the device's own key. A busy gate checks a tap every few seconds.
  api.post('/device/pair', rateLimit({ windowMs: 600_000, max: Number(process.env.DEVICE_PAIR_LIMIT) || 10, message: 'Too many tries. Ask a manager for a new code.' }));
  api.use('/device', rateLimit({ windowMs: 60_000, max: Number(process.env.DEVICE_RATE_LIMIT) || 600, message: 'Too many requests, slow down' }), accessRoutes.deviceRouter);
  api.use('/internal/jobs', rateLimit({ windowMs: 60_000, max: 10 }), followPublic.jobs);
  // Map lookups on the demo page ("Is this you?") have their own limit, so looking for your mountain does not use up demos.
  const trialLimit = rateLimit({ windowMs: 3_600_000, max: Number(process.env.SANDBOX_RATE_LIMIT) || 15, message: 'Too many demo requests from this address. Try again later, or ask us for a walkthrough.' });
  api.use('/trial', (req, res, next) => (['/find', '/area'].includes(req.path) ? next() : trialLimit(req, res, next)), sandboxRoutes);
  // Operator sign-in has its own, tighter limit (on top of each login's lockout).
  api.post(['/platform/login', '/platform/login/setup', '/platform/login/passkey', '/platform/login/passkey/options'], rateLimit({ windowMs: 15 * 60_000, max: Number(process.env.PLATFORM_LOGIN_RATE_LIMIT) || 20, message: 'Too many sign-in attempts from this address. Try again in 15 minutes.' }));
  api.use('/platform', rateLimit({ windowMs: 60_000, max: Number(process.env.PLATFORM_RATE_LIMIT) || 60, message: 'Too many attempts' }), platform);
  api.use(site.api); // the website's plans and contact form (no sign-in)
  api.use('/public', rateLimit({ windowMs: 60_000, max: 120 }), modules.publicGate, followPublic.publicRouter, messagesRoutes.publicRouter, shopRoutes.publicRouter, require('./routes/programreg').publicRouter, require('./routes/family').publicRouter, require('./routes/assistant').publicRouter, publicRouter, dispatch.publicRouter, require('./routes/lostfound').publicRouter, require('./routes/partnerpasses').publicRouter, require('./routes/patrolclaims').publicRouter, require('./routes/patrolscene').publicRouter, lessonbook, availability.publicRouter, waiverRoutes.publicRouter, require('./routes/rentalforms').publicRouter, require('./routes/schoollineup').publicRouter, require('./routes/schoolparents').publicRouter, require('./routes/schoolpay').publicRouter, require('./routes/schooldirector').publicRouter, require('./routes/guestswindow').publicRouter, require('./routes/guestsaccount').publicRouter, require('./routes/guestsloyalty').publicRouter, require('./routes/guestsfair').publicRouter);
  api.use(authRoutes); // login, tenants, users, me (each route applies authenticate itself where needed)
  api.use(require('./routes/security')); // passkeys, the second check, sessions, devices, PINs, terminals (each route authenticates)
  // A person's private calendar link for their phone's calendar app (2026.11.10): no sign-in, the link is the key.
  api.use('/calendar-feed', rateLimit({ windowMs: 60_000, max: Number(process.env.CALENDAR_FEED_RATE_LIMIT) || 30, message: 'Too many requests, slow down' }), require('./routes/mountaincal').feedRouter);

  // Everything below requires a valid token; tenant comes from the token only.
  api.use(authenticate);
  api.use(modules.moduleGate);
  api.use(require('./lib/billing').gate); // a lapsed subscription: read only, except patrol, the time clock and billing
  api.use(require('./routes/billing').router);
  api.use('/whats-new', whatsNew);
  api.use('/assistant', require('./routes/assistant').router);
  api.use('/area', require('./routes/areaview')); // the ski area's read-only patrol view
  api.use('/demo-tours', rateLimit({ windowMs: 60_000, max: 120 }), demoTours.router);
  // Per person, not per address: a mountain's staff usually share one internet address. Reads (the polling) are not counted.
  const inboxLimit = rateLimit({ windowMs: 60_000, max: Number(process.env.INBOX_RATE_LIMIT) || 120, message: 'Too many messages, slow down', keyOf: (req) => `${req.auth.tenantId}:${req.auth.userId}` });
  api.use('/inbox', (req, res, next) => (req.method === 'GET' ? next() : inboxLimit(req, res, next)), inboxRoutes);
  api.use('/messages', messagesRoutes.router);
  api.use('/online-shop', shopRoutes.router);
  api.use('/online-shop', shopAdmin.router);
  api.use('/people', customerplus);
  api.use('/people', people);
  api.use('/checkout', checkout);
  api.use('/terminal', require('./routes/terminal').router); // card readers at the counter
  api.use('/guest-types', require('./routes/guesttypes')); // the kinds of guest a mountain prices by
  // Gift card codes are the secret, so balance checks are rate limited against guessing.
  api.use('/gift-cards', rateLimit({ windowMs: 60_000, max: 40, message: 'Too many gift card checks, slow down' }), giftCards);
  api.use('/crm', crm);
  api.use('/products', products);
  api.use('/pricing', pricing);
  api.use(sales); // /orders, /tickets/scan
  api.use('/rentals', rentals);
  api.use('/rentals', require('./routes/rentalforms').router); // the guest rental form at the counter, and groups
  api.use('/schedule', schedule);
  api.use('/attractions', require('./routes/attractions').router);
  api.use('/workforce', workforce);
  api.use('/staff-injuries', require('./routes/staffinjuries'));
  api.use('/lost-found', require('./routes/lostfound').router);
  api.use('/partner-passes', require('./routes/partnerpasses').router);
  api.use('/workforce', require('./routes/workforcetime'));
  api.use('/workforce', require('./routes/attractions').workforceRouter); // suggested staff for attractions
  api.use('/kiosk-admin', kiosk.adminRouter);
  api.use('/skischool', skischool);
  api.use('/skischool', schoolplus);
  api.use('/skischool', require('./routes/schoolsettings'));
  api.use('/skischool', require('./routes/schoollineup').router); // the lineup, check-in, the counter
  api.use('/skischool', require('./routes/schoolparents').router); // recaps, waitlists, levels
  api.use('/skischool', require('./routes/schoolpay').router); // instructor pay, privates by name
  api.use('/skischool', require('./routes/schooldirector').router); // copy a day, weather, staffing, reports
  api.use('/skischool', require('./routes/schoolplan').router); // 2026.11.9: the season plan, private hours, placement
  api.use('/skischool', require('./routes/schoolstaff').router); // 2026.11.9: spots that follow staff, the fill view, demand
  api.use('/guests', require('./routes/guests').router); // guest settings (round 2)
  api.use('/guests', require('./routes/guestswindow').router); // the welcome-back card, the window
  api.use('/guests', require('./routes/guestsaccount').router); // household accounts, confirmations
  api.use('/guests', require('./routes/guestsloyalty').router); // birthdays, loyalty, recaps
  api.use('/guests', require('./routes/guestsfair').router); // fair pricing promises, payment plans
  api.use('/patrol', patrol);
  api.use('/patrol', require('./routes/patrolmedia')); // photos on a case
  api.use('/patrol', patrolPlus);
  api.use('/patrol', patrolTeam);
  api.use('/patrol', dispatch.router);
  api.use('/patrol', patrolForm);
  api.use('/patrol', patrolMap);
  api.use('/patrol', safetyRoutes);
  api.use('/patrol', patrolReview);
  api.use('/patrol', require('./routes/patrolschedule').router);
  api.use('/patrol', require('./routes/patrolclaims').router); // claim files, documentation score, season risk report
  api.use('/patrol', require('./routes/patrolscene').router); // scene diagram and witness statement links
  api.use('/patrol', require('./routes/patrolcover').router);
  api.use('/patrol', require('./routes/patrolcrews').router);
  api.use('/patrol', require('./routes/patrolkits').router);
  api.use('/patrol', require('./routes/patrolduty').router);
  api.use('/patrol', require('./routes/patrolsweep').router);
  api.use('/patrol', require('./routes/patrolmeds').router);
  api.use('/patrol', require('./routes/patrolrecords').router);
  api.use('/park', park);
  api.use('/ops', opsRoutes);
  api.use('/ops', maintenance);
  api.use('/assets', assetRoutes);
  api.use('/access', accessRoutes.adminRouter);
  api.use('/documents', documents);
  api.use('/availability', availability.router);
  api.use('/waivers', waiverRoutes.router);
  api.use('/programs', programs);
  api.use('/reports', reports);
  api.use('/board', board);
  api.use('/calendar', require('./routes/mountaincal').router); // 2026.11.10: the Mountain calendar
  api.use(finance); // tax rules, tenant profile, till, reconciliation, receipts, exports

  app.use('/api/v1', api);
  app.use(site.notFound);
  app.use((_req, _res, next) => next(new AppError(404, 'Not found')));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
