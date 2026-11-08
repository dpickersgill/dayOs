'use strict';
// A connection the database or the network drops while idle must not turn into a failed request or a 503 on /readyz
// (the console's uptime alert, Nov 5 and 6, 2026: /readyz answered 503 in a few milliseconds).
const test = require('node:test');
const assert = require('node:assert');
const { pool } = require('../src/db');

test('idle connections stay up to 5 minutes, then the pool closes them before the database drops them', () => {
  const c = pool.pool.config;
  // maxIdle is the whole pool, so the 5-minute idle timeout (not a 1-second trim down to maxIdle) decides when one closes.
  assert.strictEqual(c.maxIdle, c.connectionLimit);
  assert.strictEqual(c.idleTimeout, 5 * 60 * 1000);
  assert.strictEqual(c.connectionConfig.enableKeepAlive, true);
  // The idle check runs (mysql2 does not start it itself when maxIdle equals the pool size), and does not hold Node open.
  const t = pool.pool._removeIdleTimeoutConnectionsTimer;
  assert.ok(t, 'the idle check is running');
  assert.strictEqual(t.hasRef(), false);
});

// 2026.11.12 review: with maxIdle 1, every connection but one was closed within about a second of a burst, so the next
// burst connected to Cloud SQL again. Now a burst reuses the connections the last one opened.
test('a second burst of queries reuses the connections the first burst opened', async () => {
  const burst = () => Promise.all(Array.from({ length: 4 }, () => pool.query('SELECT CONNECTION_ID() AS id, SLEEP(0.05)').then(([r]) => r[0].id)));
  const first = new Set(await burst());
  assert.ok(first.size >= 2, 'the burst used several connections at once');
  await new Promise((r) => setTimeout(r, 2500)); // longer than the 1-second idle check, twice over
  assert.ok(pool.pool._freeConnections.length >= first.size, 'the idle connections are still open');
  const second = await burst();
  for (const id of second) assert.ok(first.has(id), `connection ${id} was opened again instead of reused`);
});

test('a connection idle longer than the idle timeout is closed and replaced', async () => {
  const c = pool.pool.config;
  const keep = c.idleTimeout;
  const [[{ id: before }]] = await pool.query('SELECT CONNECTION_ID() AS id');
  c.idleTimeout = 300; // stand in for 5 minutes
  try {
    await new Promise((r) => setTimeout(r, 2500));
    assert.strictEqual(pool.pool._freeConnections.length, 0, 'every idle connection was closed');
  } finally { c.idleTimeout = keep; }
  const [[{ id: after }]] = await pool.query('SELECT CONNECTION_ID() AS id');
  assert.notStrictEqual(after, before, 'a fresh connection took its place');
});

// This guards the retry path; a silent network drop (no reset sent) cannot be reproduced locally, so it also passes on the old code.
test('/readyz retries once when a pooled connection was dropped', async () => {
  const { createApp } = require('../src/app');
  const server = require('node:http').createServer(createApp()).listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    // Drop every connection the pool holds, from outside the pool, the way the database or the network would.
    const held = [];
    for (let i = 0; i < 2; i += 1) held.push(await pool.getConnection());
    const ids = held.map((c) => c.threadId);
    held.forEach((c) => c.release());
    const killer = await require('mysql2/promise').createConnection({
      host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD || '',
    });
    for (const id of ids) await killer.query(`KILL ${Number(id)}`).catch(() => {});
    await killer.end();
    await new Promise((r) => setTimeout(r, 200));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/readyz`);
    assert.strictEqual(res.status, 200, 'a dropped connection is retried, not reported as not ready');
  } finally {
    server.close();
    await pool.end();
  }
});

// 2026.11.12: the idle check runs on a timer that must not keep a script (or a test file) that only loads src/db.js alive.
test('loading the database module does not keep Node running', () => {
  const r = require('node:child_process').spawnSync(process.execPath, ['-e', "require('./src/db')"], { cwd: require('node:path').join(__dirname, '..'), timeout: 15000, env: process.env });
  assert.strictEqual(r.status, 0, `exited on its own (${r.signal || 'no signal'})`);
});
