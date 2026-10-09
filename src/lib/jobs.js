'use strict';

// The daily job runs several stages, each over every active mountain. These helpers keep one failure from stopping
// the rest: a stage that throws is reported and the next stage still runs, and a mountain that throws is skipped and
// logged while the other mountains carry on. Each failure is written as one JSON line, which Cloud Logging can alert on.
const { pool, rows } = require('../db');

const logFailure = (fields) => console.error(JSON.stringify({ severity: 'ERROR', ...fields }));

/** Runs fn(tenant) for every active mountain (optionally narrowed by `where`). Returns [{ tenant, ...result }]. */
async function eachTenant(job, fn, { columns = '*', where = '' } = {}) {
  const tenants = await rows(pool, `SELECT ${columns} FROM tenants WHERE status = 'active'${where ? ` AND (${where})` : ''} ORDER BY id`);
  const out = [];
  for (const t of tenants) {
    try { out.push({ tenant: t.id, ...(await fn(t)) }); } catch (err) {
      logFailure({ job, tenant: t.id, message: err.message });
      out.push({ tenant: t.id, error: true });
    }
  }
  return out;
}

/** Runs one stage of the daily job. A stage that throws returns { error } instead of stopping the job. */
async function stage(job, fn) {
  try { return await fn(); } catch (err) {
    logFailure({ job, message: err.message });
    return { error: err.message };
  }
}

module.exports = { eachTenant, stage, logFailure };
