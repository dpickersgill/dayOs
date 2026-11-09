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
  // Marketing texts held overnight (quiet hours) go out from 8 AM at each mountain.
  if (kind === 'tick') {
    try { out.held_texts = await require('./sms').sendHeld(); } catch (err) { out.held_texts = { error: err.message }; }
    // Guest help alerts held by their gap (a flood's next push, the "no one on duty" summary) whose timer was lost.
    try { out.help_alerts = await require('../routes/dispatch').sendDueAlerts(); } catch (err) { out.help_alerts = { error: err.message }; }
    // Texts to the shared help number still waiting for a ski area, in case the every-minute job is not set up.
    try { out.help_texts = await require('./sharedhelp').tick(); } catch (err) { out.help_texts = { error: err.message }; }
    // The morning conditions draft (AI Operations add-on), at each mountain's own draft time.
    try { out.conditions_writer = await require('./conditionswriter').tick(); } catch (err) { out.conditions_writer = { error: err.message }; }
  }
  return out;
}
module.exports = { tick: () => run('tick'), daily: () => run('daily') };
