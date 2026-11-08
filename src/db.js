'use strict';

const mysql = require('mysql2/promise');
const config = require('./config');

const IDLE_MS = 5 * 60 * 1000;

const pool = mysql.createPool({
  socketPath: config.db.socketPath,
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  connectionLimit: config.db.connectionLimit,
  waitForConnections: true,
  // A connection left idle is closed by us after 5 minutes, before the database or the network path can drop it quietly.
  // A quietly dropped connection fails the next query at once (seen as /readyz answering 503 in a few ms, Nov 5 and 6, 2026).
  // Every connection may stay idle for those 5 minutes (maxIdle is the whole pool), so a burst of requests reuses the
  // connections the last burst opened. With maxIdle below the pool size, mysql2 closes the free connections above it
  // within a second, whatever idleTimeout says, and each burst opened new connections to Cloud SQL (2026.11.12 review).
  maxIdle: config.db.connectionLimit,
  idleTimeout: IDLE_MS,
  enableKeepAlive: true,
  keepAliveInitialDelay: 30 * 1000,
  // Return DATE / DATETIME as plain strings so no timezone conversion happens.
  dateStrings: true,
  // Keep BIGINT ids as numbers (they stay well under 2^53 for this workload).
  supportBigNumbers: true,
  bigNumberStrings: false,
  decimalNumbers: true,
  ssl: config.db.sslOptions,
});

// The 5-minute close runs on mysql2's idle check, a timer every second. mysql2 starts it only when maxIdle is below the
// pool size, so with maxIdle equal to it the check is started here. Either way the timer must not keep Node running:
// a script or test that only loads this file never exited (2026.11.12). It is unref'd; the server stays up on its own
// listener.
{
  const base = pool.pool;
  if (base && typeof base._removeIdleTimeoutConnections === 'function') {
    const schedule = base._removeIdleTimeoutConnections.bind(base);
    const unref = () => {
      const t = base._removeIdleTimeoutConnectionsTimer;
      if (t && typeof t.unref === 'function') t.unref();
    };
    base._removeIdleTimeoutConnections = () => { schedule(); unref(); };
    if (!base._removeIdleTimeoutConnectionsTimer) base._removeIdleTimeoutConnections();
    unref();
  }
}

// Every timestamp the app writes and compares is UTC (dayRange turns a mountain's local day into UTC), so each connection
// uses UTC whatever the database server's own setting is.
pool.pool.on('connection', (conn) => { conn.query("SET time_zone = '+00:00'"); });

/**
 * Run fn(conn) inside a transaction; commits on success, rolls back on any error.
 * When the database picks this transaction as the loser of a lock collision (a "deadlock"), nothing was saved, so it is
 * simply run again, up to three more times.
 */
async function tx(fn) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await txOnce(fn);
    } catch (err) {
      const collision = err && (err.code === 'ER_LOCK_DEADLOCK' || err.errno === 1213);
      if (!collision || attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 60));
    }
  }
}

async function txOnce(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (_) {
      /* connection already broken; original error is more useful */
    }
    throw err;
  } finally {
    conn.release();
  }
}

/** Convenience: rows only. `db` may be the pool or a transaction connection. */
async function rows(db, sql, params = []) {
  const [result] = await db.query(sql, params);
  return result;
}

/** Convenience: first row or null. */
async function one(db, sql, params = []) {
  const result = await rows(db, sql, params);
  return result[0] || null;
}

module.exports = { pool, tx, rows, one };
