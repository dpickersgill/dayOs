'use strict';

// Usage of demo mountains, for the platform console's Demos dashboard: when each demo was last used, how many requests it
// made and in which parts of the app, how many of them changed something, and how many times its owner signed in. Only demo mountains are counted.
// Requests are added up in memory and written at most every 30 seconds (and on a timer), so a busy demo costs a handful
// of writes, not one per click. Counts can be a few seconds behind, and a server that stops may lose its last 30 seconds.
const { pool } = require('../db');
const { logFailure } = require('./jobs');
const M = require('./modules');

const FLUSH_MS = 30_000;
const buffer = new Map(); // tenantId -> { n, w, areas: Map(area -> n), first, last }
let lastFlush = Date.now();
let flushing = null;

const stamp = (d) => d.toISOString().slice(0, 19).replace('T', ' '); // UTC, as every connection uses

/** The part of the app a request belongs to: the first word after /api/v1, as a short name. */
function areaOf(url) {
  const seg = String(url || '').split('?')[0].split('/')[3] || '';
  return seg.replace(/[^a-z0-9_-]/gi, '').slice(0, 40).toLowerCase() || 'other';
}

/** Called for every signed-in request to a demo mountain. */
function touch(tenantId, url, method = 'GET') {
  const now = new Date();
  let b = buffer.get(tenantId);
  if (!b) { b = { n: 0, w: 0, areas: new Map(), first: now, last: now }; buffer.set(tenantId, b); }
  b.n += 1; b.last = now;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') b.w += 1; // something added, changed or removed
  const a = areaOf(url);
  b.areas.set(a, (b.areas.get(a) || 0) + 1);
  if (Date.now() - lastFlush > FLUSH_MS) flush().catch(() => {});
}

/** Writes what has been counted. Safe to call at any time; never throws. */
async function flush() {
  if (flushing) return flushing;
  lastFlush = Date.now();
  const batch = [...buffer.entries()];
  buffer.clear();
  flushing = (async () => {
    for (const [tenantId, b] of batch) {
      try {
        const [[s]] = await pool.query('SELECT id FROM sandbox_signups WHERE tenant_id = ? ORDER BY id DESC LIMIT 1', [tenantId]);
        if (!s) continue; // a demo still being built, or one just removed
        await pool.query(`UPDATE sandbox_signups SET requests = requests + ?, changes = COALESCE(changes, 0) + ?, first_used_at = COALESCE(first_used_at, ?),
          last_used_at = GREATEST(COALESCE(last_used_at, ?), ?) WHERE id = ?`, [b.n, b.w, stamp(b.first), stamp(b.last), stamp(b.last), s.id]);
        for (const [area, n] of b.areas) {
          await pool.query(`INSERT INTO sandbox_usage (signup_id, area, requests, last_at) VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE requests = requests + VALUES(requests), last_at = GREATEST(last_at, VALUES(last_at))`, [s.id, area, n, stamp(b.last)]);
        }
      } catch (err) { logFailure({ job: 'demo_usage', tenantId, message: err.message }); }
    }
  })();
  try { await flushing; } finally { flushing = null; }
}

/** A successful sign-in to a demo mountain. */
async function signedIn(tenantId) {
  await pool.query(`UPDATE sandbox_signups SET sign_ins = sign_ins + 1, last_used_at = UTC_TIMESTAMP(), first_used_at = COALESCE(first_used_at, UTC_TIMESTAMP())
    WHERE tenant_id = ? ORDER BY id DESC LIMIT 1`, [tenantId]).catch(() => {});
}

// Friendly names for the parts of the app, from the app list, plus the screens every mountain has.
const BASE = { auth: 'Sign-in', dashboard: 'Today', people: 'Customers', crm: 'Customers', settings: 'Account', users: 'Account', tenant: 'Account', help: 'Help', search: 'Search', waivers: 'Waivers', board: 'Today', myshifts: 'My shifts' };
function labelOf(area) {
  if (BASE[area]) return BASE[area];
  const m = M.MODULES.find((x) => (x.paths || []).some((p) => p.split('/')[1] === area));
  return m ? m.label.replace(/ \(add-on\)$/, '') : area.charAt(0).toUpperCase() + area.slice(1).replace(/[-_]/g, ' ');
}

const timer = setInterval(() => { flush().catch(() => {}); }, FLUSH_MS);
if (timer.unref) timer.unref();

module.exports = { touch, flush, signedIn, labelOf, areaOf };
