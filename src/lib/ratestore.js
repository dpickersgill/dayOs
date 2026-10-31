'use strict';

// Shared counters for the rate limits (2026.11.10, READY), so the limits still hold when the live site runs on several
// servers at once. Before this, each server kept its own counts in memory, so with 4 servers a "10 a minute" limit was
// really 40 a minute, and a server that started fresh forgot every count.
//
// There is no Redis, so the counts live in MySQL: one small row per limit and address (rate_limits: a hashed key, a count
// and the end of its window, in milliseconds). One statement per request counts and reads the count at once. The daily
// job removes rows whose window ended more than a day ago (cleanup below).
//
// The stores follow express-rate-limit's store interface (init, increment, decrement, resetKey), so the package could be
// dropped in later without changing them. middleware/rateLimit.js uses them.
//
// Which store: RATE_STORE=mysql or RATE_STORE=memory. Default: mysql in production (live and staging), memory elsewhere,
// so local runs and the automated tests keep their own counts per process as before.
// If the database cannot answer within RATE_STORE_TIMEOUT_MS (default 250), or the table is missing because the
// migration has not run, the request is counted in this server's memory instead and the problem is logged once a minute.
// A limit never stops the site because the database is slow: it falls back to the old per-server count.
// Slow queries never pile up (2026.11.10 fix): while a count for one key is still on its way to the database (even after
// its request gave up waiting), further hits on that key are counted in memory instead of sending another query, and at
// most RATE_STORE_MAX_PENDING (default 10) counting queries are in flight per server at once; past that, memory again.
const crypto = require('node:crypto');

const env = process.env;
const mode = () => (env.RATE_STORE || (env.NODE_ENV === 'production' ? 'mysql' : 'memory')).toLowerCase();
const timeoutMs = () => Number(env.RATE_STORE_TIMEOUT_MS) || 250;
const maxPending = () => Number(env.RATE_STORE_MAX_PENDING) || 10;
let inFlight = 0; // counting queries this server has sent and the database has not answered yet (all stores)

/** The counts in this server's memory: the old behavior, and the fallback when the database cannot answer. */
class MemoryStore {
  constructor() { this.hits = new Map(); this.localKeys = true; this.windowMs = 60_000; this.timer = null; }
  init(options) {
    this.windowMs = options.windowMs;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    }, Math.max(1000, this.windowMs));
    if (this.timer.unref) this.timer.unref();
  }
  async increment(key) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || e.reset <= now) { e = { count: 0, reset: now + this.windowMs }; this.hits.set(key, e); }
    e.count += 1;
    return { totalHits: e.count, resetTime: new Date(e.reset) };
  }
  async decrement(key) { const e = this.hits.get(key); if (e && e.count > 0) e.count -= 1; }
  async resetKey(key) { this.hits.delete(key); }
  async resetAll() { this.hits.clear(); }
}

let lastWarn = 0;
function warn(message) {
  if (Date.now() - lastWarn < 60_000) return;
  lastWarn = Date.now();
  require('./jobs').logFailure({ job: 'rate_store', message: `Rate limits fell back to this server's memory: ${message}` });
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_r, reject) => { t = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms); })]).finally(() => clearTimeout(t));
}

/**
 * The counts in MySQL, shared by every server. prefix names the limit (two limits never share a count); the key is
 * usually the visitor's address. Neither is stored as written: the row's key is a SHA-256 of both, so the table holds no
 * addresses.
 */
class MysqlStore {
  constructor({ prefix = '', pool = null } = {}) {
    this.prefix = prefix; this.localKeys = false; this.windowMs = 60_000;
    this.pool = pool; this.fallback = new MemoryStore();
    this.pending = new Set(); // row keys (hex) with a query still running
  }
  /** Runs a query for this row unless one for it is still running or too many are: then returns null (use memory). */
  guarded(k, run) {
    const id = k.toString('hex');
    if (this.pending.has(id) || inFlight >= maxPending()) return null;
    this.pending.add(id); inFlight += 1;
    const q = Promise.resolve().then(run);
    q.catch(() => {}).finally(() => { this.pending.delete(id); inFlight -= 1; });
    return withTimeout(q, timeoutMs());
  }
  init(options) { this.windowMs = options.windowMs; this.fallback.init(options); }
  db() { return this.pool || require('../db').pool; }
  rowKey(key) { return crypto.createHash('sha256').update(`${this.prefix}\u0000${key}`).digest(); }
  async increment(key) {
    const now = Date.now(); const end = now + this.windowMs; const k = this.rowKey(key);
    // Every hit is also counted in this server's memory, and the answer is never lower than that count: a hit counted in
    // memory while a query was still running is never lost, and two hits at once on one server never both count as the first.
    const local = await this.fallback.increment(key);
    try {
      // A new row counts 1. An existing row counts one more, or starts again at 1 once its window has ended.
      // LAST_INSERT_ID(x) hands the new count back with the write itself (insertId is 0 when the row was new).
      const sent = this.guarded(k, () => this.db().query(
        `INSERT INTO rate_limits (k, hits, reset_ms) VALUES (?, 1, ?)
         ON DUPLICATE KEY UPDATE hits = LAST_INSERT_ID(IF(reset_ms <= ?, 1, hits + 1)), reset_ms = IF(reset_ms <= ?, ?, reset_ms)`,
        [k, end, now, now, end]));
      if (!sent) return local; // a query for this key is still running: count here, send nothing
      const [r] = await sent;
      const shared = Number(r.insertId) || 1;
      const totalHits = Math.max(shared, local.totalHits);
      if (totalHits === 1) return { totalHits, resetTime: new Date(end) };
      return { totalHits, resetTime: shared >= local.totalHits ? undefined : local.resetTime, row: k };
    } catch (err) {
      warn(err.message);
      return local;
    }
  }
  /** When the window of a key ends (only read when a visitor is over the limit, for Retry-After). */
  async resetTimeOf(key) {
    try {
      const [[row]] = await withTimeout(this.db().query('SELECT reset_ms FROM rate_limits WHERE k = ?', [this.rowKey(key)]), timeoutMs());
      return row ? new Date(Number(row.reset_ms)) : undefined;
    } catch (_) { return undefined; }
  }
  async decrement(key) {
    const k = this.rowKey(key);
    const sent = this.guarded(k, () => this.db().query('UPDATE rate_limits SET hits = GREATEST(hits, 1) - 1 WHERE k = ?', [k]));
    await this.fallback.decrement(key);
    if (!sent) return;
    try { await sent; } catch (err) { warn(err.message); }
  }
  async resetKey(key) {
    try { await withTimeout(this.db().query('DELETE FROM rate_limits WHERE k = ?', [this.rowKey(key)]), timeoutMs()); } catch (err) { warn(err.message); }
    await this.fallback.resetKey(key);
  }
}

/** The store a new limit uses, by RATE_STORE (see the top of this file). */
function storeFor(prefix) { return mode() === 'mysql' ? new MysqlStore({ prefix }) : new MemoryStore(); }

/** The daily job: removes counts whose window ended more than a day ago. Returns how many it removed. */
async function cleanup(pool = require('../db').pool) {
  const before = Date.now() - 86_400_000;
  let removed = 0;
  for (;;) {
    const [r] = await pool.query('DELETE FROM rate_limits WHERE reset_ms < ? LIMIT 10000', [before]);
    removed += r.affectedRows;
    if (r.affectedRows < 10000) break;
  }
  return removed;
}

module.exports = { MemoryStore, MysqlStore, storeFor, cleanup, mode, inFlight: () => inFlight };
