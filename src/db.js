'use strict';

const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool({
  socketPath: config.db.socketPath,
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  connectionLimit: config.db.connectionLimit,
  waitForConnections: true,
  // Return DATE / DATETIME as plain strings so no timezone conversion happens.
  dateStrings: true,
  // Keep BIGINT ids as numbers (they stay well under 2^53 for this workload).
  supportBigNumbers: true,
  bigNumberStrings: false,
  decimalNumbers: true,
  ssl: config.db.sslOptions,
});

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
