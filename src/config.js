'use strict';

const env = process.env;
const isProd = env.NODE_ENV === 'production';

// Staging (STAGE=staging): the private copy of Verdynt/OS where each release is checked before it goes live. It runs like
// production, with its own database, and three guards so nothing on it can reach a real guest or real money:
//   Stripe live keys are refused (test keys only), every email goes to STAGING_INBOX instead of the person it names,
//   and texts go to STAGING_SMS_TO (or nowhere). STAGING_GATE, a shared password, keeps the public out, and search
//   engines are told to keep away.
const staging = env.STAGE === 'staging';
if (staging && /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY || '')) {
  throw new Error('Staging must use a Stripe test key (sk_test_...), never a live one');
}

if (isProd && (!env.JWT_SECRET || env.JWT_SECRET.length < 32)) {
  throw new Error('JWT_SECRET must be set to at least 32 characters in production');
}

// Production refuses settings that are unsafe however they came about (2026.11.11). Each message says what to set.
//   JWT_SECRET      at least 32 characters and not a run of a few characters ("aaaa...", "abcabc..."): it signs every session.
//   BOOTSTRAP_KEY   empty (the platform key is off) or at least 24 characters with some variety: it opens the console.
//   DB_USER         set, and not root: the app signs in to the database as its own limited login (scripts/harden.sh).
//   DB_SSL          on when the database is reached over the network (DB_HOST that is not this machine, no DB_SOCKET).
//   PUBLIC_URL      set, https: links in emails and the website's own address never come from a request's Host header.
// The automated tests and local runs are not production, so none of this applies there. It runs when the server starts
// (src/server.js), not when this file loads, so scripts that read the settings (migrations from Cloud Shell) still work.
const variety = (v) => new Set(String(v)).size;
function refuseUnsafe() {
  const problems = [];
  if (env.JWT_SECRET && variety(env.JWT_SECRET) < 10) problems.push('JWT_SECRET is too simple (a run of a few characters). Use a long random value: openssl rand -base64 48');
  if (env.BOOTSTRAP_KEY && (env.BOOTSTRAP_KEY.length < 24 || variety(env.BOOTSTRAP_KEY) < 10)) problems.push('BOOTSTRAP_KEY (the platform key) must be at least 24 random characters, or left empty to turn it off');
  if (!env.DB_USER || env.DB_USER === 'root') problems.push('DB_USER must be set to the app\'s own database login, not root (scripts/harden.sh sets summitops_app)');
  const local = ['127.0.0.1', 'localhost', '::1'].includes(String(env.DB_HOST || '127.0.0.1'));
  if (!env.DB_SOCKET && !local && env.DB_SSL !== 'true') problems.push('DB_SSL=true is needed when the database is reached over the network (or use DB_SOCKET for Cloud SQL)');
  if (!/^https:\/\/[^\s/]+/.test(String(env.PUBLIC_URL || ''))) problems.push('PUBLIC_URL must be set to this service\'s https address (deploy.sh and promote.sh set it)');
  if (problems.length) throw new Error(`Unsafe settings for production:\n  - ${problems.join('\n  - ')}`);
}

// Map tiles for the patrol map. The defaults are the free OpenStreetMap-based layers, which are fine for a
// small admin tool but have usage limits and no guarantee. For production use, take a plan from a tile
// provider (MapTiler, Stadia, Mapbox and others) and set MAP_TILE_URL, for example
//   https://api.maptiler.com/maps/outdoor/{z}/{x}/{y}.png?key=YOUR_KEY
// {s} may be used for subdomains. MAP_TILE_ATTRIBUTION must carry the provider's required credit.
// Every map also offers Satellite: by default the USGS National Map's aerial imagery (public domain, the whole US, no key
// or account), or MAP_IMAGERY_URL from a paid provider. maxZoom is the deepest level the provider has tiles for; the map
// zooms further by enlarging those (up to MAP_MAX_ZOOM), which is what pinning a single valve needs.
const imagery = {
  name: 'Satellite',
  url: env.MAP_IMAGERY_URL || 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
  attribution: env.MAP_IMAGERY_URL ? (env.MAP_IMAGERY_ATTRIBUTION || '') : 'Imagery: <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">USGS The National Map</a>, USDA NAIP',
  maxZoom: Number(env.MAP_IMAGERY_MAX_ZOOM || 16),
};
const mapLayers = env.MAP_TILE_URL
  ? [{ name: env.MAP_TILE_NAME || 'Map', url: env.MAP_TILE_URL, attribution: env.MAP_TILE_ATTRIBUTION || '', maxZoom: Number(env.MAP_TILE_MAX_ZOOM || 19) }, imagery]
  : [
      { name: 'Street map', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 19 },
      imagery,
      { name: 'Terrain', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', attribution: 'Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)', maxZoom: 17 },
    ];
const mapMaxZoom = Math.min(22, Math.max(18, Number(env.MAP_MAX_ZOOM || 21)));

// Card payments for online lesson booking (Stripe Checkout). Leave STRIPE_SECRET_KEY unset and online payment stays off.
//   STRIPE_SECRET_KEY      the secret key (sk_live_... or sk_test_...)
//   STRIPE_WEBHOOK_SECRET  the signing secret of the webhook endpoint (whsec_...)
//   PUBLIC_URL             this service's public address, used for Stripe's return links (defaults to the request's own host)
//   STRIPE_API_BASE        only for automated tests
//   STRIPE_CONNECT_WEBHOOK_SECRET  the signing secret of the Connect webhook endpoint (events from mountains' own accounts)
//   STRIPE_GUEST_FALLBACK  'on' lets a mountain with no connected Stripe account take guest card payments into the
//                          platform's own account (the old way). Off in production, where guest money only ever goes to
//                          the mountain's own account; on elsewhere so tests and local runs need no Connect setup.
const stripe = {
  secretKey: env.STRIPE_SECRET_KEY || '',
  webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
  connectWebhookSecret: env.STRIPE_CONNECT_WEBHOOK_SECRET || '',
  guestFallback: env.STRIPE_GUEST_FALLBACK ? env.STRIPE_GUEST_FALLBACK === 'on' : !isProd,
  apiBase: env.STRIPE_API_BASE || 'https://api.stripe.com',
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
};

module.exports = {
  isProd,
  staging,
  stagingSettings: { inbox: env.STAGING_INBOX || '', smsTo: env.STAGING_SMS_TO || '', gate: env.STAGING_GATE || '' },
  stripe,
  map: { layers: mapLayers, maxZoom: mapMaxZoom },
  // Patrol "fill in from the story": off unless PATROL_AI=on and a key is set. The story holds patient health
  // information, so turn it on only once the AI provider has signed a business associate agreement.
  patrolAi: {
    on: env.PATROL_AI === 'on' && Boolean(env.ANTHROPIC_API_KEY),
    key: env.ANTHROPIC_API_KEY || '',
    model: env.PATROL_AI_MODEL || 'claude-sonnet-5-5',
    apiBase: (env.ANTHROPIC_API_BASE || 'https://api.anthropic.com').replace(/\/$/, ''),
  },
  // The Verdynt/OS Assistant (staff and guests). Off until ASSISTANT_API_KEY is set (a plain key: it never sees patient
  // data). A small model answers how-to and setup questions; a stronger one when it looks up the mountain's data.
  assistant: {
    on: Boolean(env.ASSISTANT_API_KEY) && env.ASSISTANT !== 'off',
    key: env.ASSISTANT_API_KEY || '',
    apiBase: (env.ASSISTANT_API_BASE || env.ANTHROPIC_API_BASE || 'https://api.anthropic.com').replace(/\/$/, ''),
    model: env.ASSISTANT_MODEL || 'claude-haiku-5-5',
    dataModel: env.ASSISTANT_DATA_MODEL || 'claude-sonnet-5-5',
  },
  port: Number(env.PORT || 8080),
  jwtSecret: env.JWT_SECRET || 'dev-only-secret-change-me-dev-only-secret',
  // Separate keys so sign-in tokens can be rotated on their own. Each falls back to JWT_SECRET, which is what was used
  // before these existed: before rotating JWT_SECRET, set all three to its current value (see RUNBOOK.md).
  //   TOTP_KEY     encrypts two-step sign-in secrets and recovery codes
  //   LINK_SECRET  signs unsubscribe links in emails and texts
  //   KIOSK_SECRET signs staff badges and kiosk sessions
  totpKey: env.TOTP_KEY || env.JWT_SECRET || 'dev-only-secret-change-me-dev-only-secret',
  linkSecret: env.LINK_SECRET || env.JWT_SECRET || 'dev-only-secret-change-me-dev-only-secret',
  kioskSecret: env.KIOSK_SECRET || env.JWT_SECRET || 'dev-only-secret-change-me-dev-only-secret',
  jwtTtl: env.JWT_TTL || '8h',
  // Owners and managers must use two-step sign-in. On in production unless REQUIRE_ADMIN_MFA=off; off elsewhere unless =on.
  requireAdminMfa: env.REQUIRE_ADMIN_MFA ? env.REQUIRE_ADMIN_MFA === 'on' : isProd,
  // Required to create a new tenant (mountain). Leave unset to disable the endpoint.
  bootstrapKey: env.BOOTSTRAP_KEY || '',
  // Where the "ask for a walkthrough" link in a demo mountain points (the marketing site's contact page). Leave unset to show no link.
  marketingUrl: env.MARKETING_URL || '',
  // The product website (public/site), served by this same service.
  //   SITE_HOSTS          the website's own addresses, comma separated (www.runmyresort.com,runmyresort.com). On those,
  //                       / is the website's home page; everywhere it is also at /site.
  //   APP_URL             where the app lives (https://app.runmyresort.com), for the website's Sign in and Try the demo
  //                       links. Unset: the same address the website is on.
  //   SITE_CONTACT_EMAIL  who gets walkthrough and trial requests from the Contact page (they are also in the console, Leads)
  site: {
    hosts: String(env.SITE_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
    appUrl: (env.APP_URL || '').replace(/\/$/, ''),
    // The company behind Verdynt/OS, named in the footer, Terms, Privacy and the structured data. Add the legal suffix
    // here when it is settled (for example "Verdynt Consulting Group, LLC"); every page reads it from this one place.
    company: { name: 'Verdynt Consulting Group', place: 'Pennsylvania' },
    // The public addresses on the website and in the app: sales and general questions, and help for customers. These are
    // the only place the email domain is set (runmyresort.com today): change these three lines, or set SITE_HELLO_EMAIL,
    // SITE_SUPPORT_EMAIL and SITE_CONTACT_EMAIL, when the new domain arrives.
    helloEmail: env.SITE_HELLO_EMAIL || 'hello@runmyresort.com',
    supportEmail: env.SITE_SUPPORT_EMAIL || 'support@runmyresort.com',
    // Where Contact page requests go: hello@ unless SITE_CONTACT_EMAIL says otherwise.
    contactEmail: env.SITE_CONTACT_EMAIL || env.SITE_HELLO_EMAIL || 'hello@runmyresort.com',
    // Search Console and Bing Webmaster ownership checks (the code from their "HTML tag" option)
    verify: { google: env.GOOGLE_SITE_VERIFICATION || '', bing: env.BING_SITE_VERIFICATION || '' },
    // SITE_SAME_AS: the company's own profiles elsewhere (the LinkedIn page), comma-separated. Search engines use them to
    // tie the profiles to the website; a LinkedIn address is also linked from the footer.
    // Demo emails come from the company: the name they show (DEMO_MAIL_NAME), and optionally a verified sender address
    // (DEMO_MAIL_FROM, e.g. hello@runmyresort.com; otherwise MAIL_FROM). Replies go to hello@.
    demoFromName: env.DEMO_MAIL_NAME || 'Verdynt/OS',
    demoFrom: env.DEMO_MAIL_FROM || '',
    sameAs: String(env.SITE_SAME_AS || '').split(',').map((u) => u.trim()).filter((u) => /^https:\/\/[^\s"<>]+$/.test(u)),
  },
  db: {
    // Cloud SQL: DB_SOCKET=/cloudsql/<project>:<region>:<instance> (the socket Cloud Run provides). It replaces host and port.
    socketPath: env.DB_SOCKET || undefined,
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER || 'root',
    password: env.DB_PASSWORD || '',
    database: env.DB_NAME || 'summitops',
    // Aiven MySQL requires TLS. Set DB_SSL=true and optionally DB_CA to the CA certificate text.
    ssl: env.DB_SSL === 'true',
    ca: env.DB_CA || '',
    connectionLimit: Number(env.DB_POOL || 10),
  },
};

/** TLS settings for every database connection (the app's pool and the migration script). */
module.exports.db.sslOptions = module.exports.db.ssl
  ? (module.exports.db.ca ? { ca: module.exports.db.ca, rejectUnauthorized: true } : { rejectUnauthorized: true })
  : undefined;

/** src/server.js calls this at start: production refuses unsafe settings (see refuseUnsafe above). */
module.exports.refuseUnsafe = () => { if (isProd) refuseUnsafe(); };
