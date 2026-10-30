'use strict';
// The ski school's frequent job (POST /jobs/lessons, every 5 minutes) and its part of the daily job. Each part of the
// school does its own work in tick() and daily(); one failing does not stop the others.
const PARTS = ['lineup', 'parents', 'pay', 'director', 'plan', 'staff'];

async function run(kind) {
  const out = {};
  for (const p of PARTS) {
    try { out[p] = await require(`../routes/school${p}`)[kind](); } catch (err) {
      console.error(JSON.stringify({ severity: 'ERROR', job: `lessons_${kind}`, part: p, message: err.message }));
      out[p] = { error: err.message };
    }
  }
  return out;
}

module.exports = { tick: () => run('tick'), daily: () => run('daily') };
