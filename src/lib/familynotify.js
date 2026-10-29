'use strict';
// Telling a family something about a lesson: an email always (when there is an address), and a text as well when the
// mountain has the "Texts to families" add-on (module lesson_texts) and the family said yes to texts for this booking
// (lesson_bookings.text_ok). Never throws: returns { email: result|null, text: result|null }.
const mailer = require('./mailer');
const sms = require('./sms');
const modules = require('./modules');

/** Does this mountain send lesson texts? */
async function textsOn(tenantId) {
  try { return (await modules.enabledKeys(tenantId)).includes('lesson_texts'); } catch (_) { return false; }
}

/**
 * tenant: the tenants row (id, name). to: { email, phone, textOk }. subject and text: the email. smsText: the text
 * message (keep it under 300 characters, with the link). tag: a short Postmark tag.
 */
async function notify({ tenant, to, subject, text, html, smsText, tag }) {
  const out = { email: null, text: null };
  try {
    if (to.email && subject) out.email = await mailer.send({ tenantId: tenant.id, to: to.email, fromName: tenant.name, subject, text, html, tag: tag || 'lessons' });
  } catch (err) { out.email = { ok: false, error: err.message }; }
  try {
    if (smsText && to.phone && to.textOk && (await textsOn(tenant.id))) out.text = await sms.send({ tenantId: tenant.id, to: to.phone, body: smsText });
  } catch (err) { out.text = { ok: false, error: err.message }; }
  return out;
}

/** Are AI lesson recaps on? With Assistant Plus, or turned on for the mountain by the operator at no cost (lesson_ai). */
async function aiRecapsOn(tenantId) {
  try { const k = await modules.enabledKeys(tenantId); return k.includes('assistant_plus') || k.includes('lesson_ai'); } catch (_) { return false; }
}

module.exports = { notify, textsOn, aiRecapsOn };
