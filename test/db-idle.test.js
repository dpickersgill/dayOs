'use strict';
// A connection the database or the network drops while idle must not turn into a failed request or a 503 on /readyz
// (the console's uptime alert, Nov 5 and 6, 2026: /readyz answered 503 in a few milliseconds).
const test = require('node:test');
const assert = require('node:assert');
const { pool } = require('../src/db');

test('idle connections are closed by the pool before the database drops them', () => {
  const c = pool.pool.config;
  assert.strictEqual(c.maxIdle, 1);
  assert.ok(c.idleTimeout > 0 && c.idleTimeout <= 10 * 60 * 1000);
  assert.strictEqual(c.connectionConfig.enableKeepAlive, true);
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
