'use strict';
// The guests job (POST /internal/jobs/guests, every 5 minutes) and its part of the daily job. One failing part does not stop the others.
const PARTS = ['window', 'account', 'loyalty', 'fair'];
async function run(kind) {
  const out = {};
  for (const p of PARTS) {
    try { out[p] = await require(`../routes/guests${p}`)[kind](); } catch (err) {
      console.error(JSON.stringify({ severity: 'ERROR', job: `guests_${kind}`, part: p, message: err.message }));
      out[p] = { error: err.message };
    }
  }
  return out;
}
module.exports = { tick: () => run('tick'), daily: () => run('daily') };
