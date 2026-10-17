'use strict';

const config = require('./config');
const { createApp } = require('./app');
const { pool } = require('./db');

const app = createApp();
const release = require('./lib/version');

const server = app.listen(config.port, () => {
  console.log(`DAY/OS ${release.VERSION} (build ${release.BUILD}) listening on :${config.port}`);
  recordStart();
});

// The console's deploy history: each version and build that has started on this database, first and latest start,
// and who deployed it (deploy.sh passes the Google account). Before the migration has run, the table is missing: skip.
function recordStart() {
  pool.query('INSERT INTO app_deploys (version, build, deployed_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE last_started_at = CURRENT_TIMESTAMP',
    [release.VERSION, release.BUILD, process.env.DEPLOYED_BY || null]).catch((err) => console.warn('Could not record this version in app_deploys:', err.message));
}

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
