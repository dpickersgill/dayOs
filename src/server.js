'use strict';

const config = require('./config');
const { createApp } = require('./app');
const { pool } = require('./db');

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`SummitOps API listening on :${config.port}`);
});

// Cloud Run sends SIGTERM before stopping an instance; finish in-flight requests, then close the pool.
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
