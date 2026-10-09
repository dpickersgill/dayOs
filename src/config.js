'use strict';

const env = process.env;
const isProd = env.NODE_ENV === 'production';

if (isProd && (!env.JWT_SECRET || env.JWT_SECRET.length < 32)) {
  throw new Error('JWT_SECRET must be set to at least 32 characters in production');
}

// Map tiles for the patrol map. The defaults are the free OpenStreetMap-based layers, which are fine for a
// small admin tool but have usage limits and no guarantee. For production use, take a plan from a tile
// provider (MapTiler, Stadia, Mapbox and others) and set MAP_TILE_URL, for example
//   https://api.maptiler.com/maps/outdoor/{z}/{x}/{y}.png?key=YOUR_KEY
// {s} may be used for subdomains. MAP_TILE_ATTRIBUTION must carry the provider's required credit.
const mapLayers = env.MAP_TILE_URL
  ? [{ name: env.MAP_TILE_NAME || 'Map', url: env.MAP_TILE_URL, attribution: env.MAP_TILE_ATTRIBUTION || '', maxZoom: Number(env.MAP_TILE_MAX_ZOOM || 19) }]
  : [
      { name: 'Street map', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 19 },
      { name: 'Terrain', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', attribution: 'Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)', maxZoom: 17 },
    ];

// Card payments for online lesson booking (Stripe Checkout). Leave STRIPE_SECRET_KEY unset and online payment stays off.
//   STRIPE_SECRET_KEY      the secret key (sk_live_... or sk_test_...)
//   STRIPE_WEBHOOK_SECRET  the signing secret of the webhook endpoint (whsec_...)
//   PUBLIC_URL             this service's public address, used for Stripe's return links (defaults to the request's own host)
//   STRIPE_API_BASE        only for automated tests
const stripe = {
  secretKey: env.STRIPE_SECRET_KEY || '',
  webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
  apiBase: env.STRIPE_API_BASE || 'https://api.stripe.com',
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
};

module.exports = {
  isProd,
  stripe,
  map: { layers: mapLayers },
  port: Number(env.PORT || 8080),
  jwtSecret: env.JWT_SECRET || 'dev-only-secret-change-me-dev-only-secret',
  jwtTtl: env.JWT_TTL || '8h',
  // Required to create a new tenant (mountain). Leave unset to disable the endpoint.
  bootstrapKey: env.BOOTSTRAP_KEY || '',
  // Where the "ask for a walkthrough" link in a demo mountain points (the marketing site's contact page). Leave unset to show no link.
  marketingUrl: env.MARKETING_URL || '',
  db: {
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
