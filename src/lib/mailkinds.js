'use strict';

// Every email a mountain sends is transactional or promotional, decided here by its tag (2026.11.11, privacy). The mailer
// asks this file before it sends. Promotional email (CAN-SPAM "commercial" mail):
//   - never goes to an address on the do-not-email list, or whose latest email answer (on any record with that address) is "no"
//   - carries the mountain's postal address, an unsubscribe link, List-Unsubscribe and List-Unsubscribe-Post (one click)
//   - is refused when the mountain has no postal address (Settings, Mountain details)
//   - goes on the broadcast stream, apart from tickets, receipts and patrol mail
// Everything else is transactional: receipts, tickets, confirmations, changes and cancellations, reminders about a
// booking, rental or pass the guest has, sign-in codes, patrol and staff mail, The Good Day (Verdynt/OS's own list, with
// its own unsubscribe). A new promotional email must be added to PROMOTIONAL below.
const { one } = require('../db');
const config = require('../config');
const { esc } = require('./format');

const PROMOTIONAL = {
  'msg-campaign': 'A message a manager writes under Messages',
  'loyalty-thanks': 'A thank-you to a top loyal guest',
  'recap-day': 'A guest’s day recap',
  'recap-season': 'A guest’s season recap',
  'lesson-followup': 'Book the next lesson',
  'reward-*': 'Birthday, milestone, first-timer and loyalty offers',
};
const isPromotional = (tag) => Boolean(tag) && (Object.prototype.hasOwnProperty.call(PROMOTIONAL, tag) || /^reward-/.test(tag));
const kindOf = (tag) => (isPromotional(tag) ? 'promotional' : 'transactional');

/** The postal address printed on promotional email: Mountain details address, else the patrol follow-up mailing address. */
async function postalAddress(db, tenantId) {
  const t = await one(db, 'SELECT name, address, mail_address FROM tenants WHERE id = ?', [tenantId]);
  if (!t) return null;
  const a = String(t.address || t.mail_address || '').trim();
  return a ? { name: t.name, address: a } : null;
}
const NO_ADDRESS = 'Add the mountain’s postal address in Settings, Mountain details first. The law requires it on every marketing email.';

/** Has this address said no to email at this mountain (the do-not-email list, or the latest answer on any record with it)? */
async function saidNo(db, tenantId, email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return true;
  if (await one(db, 'SELECT 1 AS x FROM email_suppressions WHERE tenant_id = ? AND email = ?', [tenantId, e])) return true;
  const last = await one(db, `SELECT c.status FROM consent_events c JOIN people p ON p.tenant_id = c.tenant_id AND p.id = c.person_id
    WHERE c.tenant_id = ? AND c.channel = 'email' AND p.email = ? ORDER BY c.id DESC LIMIT 1`, [tenantId, e]);
  return Boolean(last && last.status === 'opted_out');
}

/**
 * Makes a promotional email lawful, or refuses it. Returns { ok: false, error } or { ok: true, text, html, headers, stream }.
 * personId: the customer the unsubscribe link stops (found by address when not given). base: the app's address for links.
 */
async function prepare(db, { tenantId, to, text, html, headers, personId, base }) {
  if (await saidNo(db, tenantId, to)) return { ok: false, error: 'This guest asked not to get these emails', unsubscribed: true };
  const postal = await postalAddress(db, tenantId);
  if (!postal) return { ok: false, error: NO_ADDRESS };
  let pid = personId;
  if (!pid) pid = (await one(db, 'SELECT MIN(id) AS id FROM people WHERE tenant_id = ? AND email = ? AND anonymised_at IS NULL', [tenantId, String(to).trim().toLowerCase()]) || {}).id;
  const root = base || config.stripe.publicUrl;
  if (!pid || !root) return { ok: false, error: 'No way to unsubscribe from this email, so it was not sent' };
  const messaging = require('./messaging');
  const url = messaging.unsubUrl(root, tenantId, pid, 'email');
  let t = String(text || ''); let hBody = html;
  if (!t.includes(url)) t = `${t}\n\n--\n${postal.name}, ${postal.address}\nYou get this because you are a guest of ${postal.name}. To stop these emails: ${url}`;
  else if (!t.includes(postal.address)) t = `${t}\n${postal.address}`;
  if (hBody && !hBody.includes(esc(url))) {
    const foot = `<p style="font:12px/1.5 Arial,Helvetica,sans-serif;color:#55687a;text-align:center;margin:12px 0">${esc(postal.name)}, ${esc(postal.address)}<br>You get this because you are a guest of ${esc(postal.name)}. <a href="${esc(url)}">Stop these emails</a></p>`;
    hBody = hBody.includes('</body>') ? hBody.replace('</body>', `${foot}</body>`) : `${hBody}${foot}`;
  }
  const rest = (headers || []).filter((x) => !/^List-Unsubscribe/i.test(x.Name));
  return { ok: true, text: t, html: hBody, stream: 'broadcast', headers: [...rest, { Name: 'List-Unsubscribe', Value: `<${url}>` }, { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }] };
}

module.exports = { PROMOTIONAL, isPromotional, kindOf, postalAddress, saidNo, prepare, NO_ADDRESS };
