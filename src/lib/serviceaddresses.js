'use strict';

// The water customer list (release 2026.11.20): the service addresses from the utility billing system, imported as a CSV
// (street, house number, unit, account number, and a phone or email when the billing system has one). Kept apart from the
// alert sign-ups (alert_signups): a customer on this list never signed up for anything, so the list is used for water and
// sewer notices only (Water outage, Boil water advisory, Sewer), and only like this:
//   - a phone or email is kept only when the manager who imports the file confirms the municipality has the customers'
//     consent to be texted or emailed about their service (the attestation, recorded with the import, the manager's name
//     and the audit log). Without it the file's phones and emails are not stored at all.
//   - a phone that texted STOP, or an address that used the stop link, stays stopped: the import is not a new yes, and every
//     message to a customer ends with Reply STOP (texts) or the stop link (emails), like every other alert.
//   - every other address on the affected streets is on the door hanger and mail list: addresses only, never a name,
//     account number, phone or email.
// An address that is no longer in the billing system (an import that replaces the list) is ended and its phone and email
// are removed at once; ended addresses are deleted by the daily retention run after 13 months.
const crypto = require('crypto');
const { pool, rows, one } = require('../db');
const config = require('../config');
const sms = require('./sms');

/** The notice types that reach the water customer list (lib/streetnotices.js TYPES with the water topic). */
const reachesCustomers = (type) => {
  const t = require('./streetnotices').TYPE[type];
  return Boolean(t && t.topic === 'water');
};

const norm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
/**
 * The key an address is matched on in the next import: the account number, else street + house number + unit. The account
 * number is kept in the key only as a keyed hash, so erasing it from the row (lib/personal.js) leaves nothing readable.
 */
const matchKey = ({ account, streetId, houseNumber, unit }) => (account
  ? `acct:${crypto.createHmac('sha256', config.linkSecret).update(`service-account:${norm(account)}`).digest('hex').slice(0, 40)}`
  : `addr:${streetId}|${norm(houseNumber).slice(0, 20)}|${norm(unit).slice(0, 20)}`);
/** The same address for matching a sign-up to a service address: street, house number, unit. */
const placeKey = (streetId, houseNumber, unit) => `${Number(streetId)}|${norm(houseNumber)}|${norm(unit)}`;

/**
 * Service addresses inside these notice areas: [{ id, street_id, street_name, house_number, house_no, unit, phone, email, contact_ok }].
 * Uses the same area rule as the sign-ups (lib/streetnotices.js areaSql): an address whose house number has no digits is
 * inside any range on its street.
 */
async function inAreas(db, tenantId, areas) {
  const [where, vals] = require('./streetnotices').areaSql(areas);
  return rows(db, `SELECT s.id, s.street_id, st.name AS street_name, s.house_number, s.house_no, s.unit, s.phone, s.email, s.contact_ok
    FROM service_addresses s JOIN streets st ON st.tenant_id = s.tenant_id AND st.id = s.street_id
    WHERE s.tenant_id = ? AND s.active = 1 AND ${where} ORDER BY st.name, s.house_no IS NULL, s.house_no, s.house_number, s.unit, s.id`, [tenantId, ...vals]);
}

/**
 * Who on the water customer list a notice of this type on these areas reaches, given what the sign-ups already reach.
 * reached: Set of 'sms:<key>' / 'email:<addr>' the sign-ups send to; places: Set of placeKey for sign-up addresses that get
 * a message. Returns { send: [{ service_address_id, channel, to }], opted_out: [...], with_consent, door_hangers, total, list }
 * where list is the door hanger addresses.
 */
async function reach(tenantId, type, areas, { reached = new Set(), places = new Set(), stopped = new Set() } = {}) {
  const empty = { send: [], opted_out: [], with_consent: 0, door_hangers: 0, total: 0, list: [] };
  if (!reachesCustomers(type) || !areas.length) return empty;
  const found = await inAreas(pool, tenantId, areas);
  if (!found.length) return empty;
  const SN = require('./streetnotices');
  const wanted = [];
  for (const a of found) {
    if (!Number(a.contact_ok)) continue;
    if (a.phone && sms.phoneKey(a.phone)) wanted.push({ a, channel: 'sms', key: sms.phoneKey(a.phone), to: SN.phoneAddr(a.phone) });
    if (a.email && SN.emailAddr(a.email)) wanted.push({ a, channel: 'email', key: SN.emailAddr(a.email), to: SN.emailAddr(a.email) });
  }
  const addrs = await SN.addressesOf(tenantId, wanted.map((w) => [w.channel, w.key]));
  const no = await SN.phonesSaidNo(tenantId, [...new Set(wanted.filter((w) => w.channel === 'sms').map((w) => w.key))]);
  const send = []; const optedOut = []; const seen = new Set(); const contactable = new Set();
  for (const w of wanted) {
    const id = `${w.channel}:${w.key}`;
    const row = addrs.get(id);
    const said = stopped.has(id) || !row || row.stopped_at || (w.channel === 'sms' && no.has(w.key));
    if (said) { if (!seen.has(id) && !reached.has(id)) { optedOut.push({ service_address_id: Number(w.a.id), channel: w.channel, to: w.to }); seen.add(id); } continue; }
    contactable.add(Number(w.a.id));
    if (reached.has(id) || seen.has(id)) continue; // the sign-up list (or another address on this list) already has it
    seen.add(id);
    send.push({ service_address_id: Number(w.a.id), channel: w.channel, to: w.to });
  }
  const list = found.filter((a) => !contactable.has(Number(a.id)) && !places.has(placeKey(a.street_id, a.house_number, a.unit)))
    .map((a) => ({ street: a.street_name, house_number: a.house_number, unit: a.unit, house_no: a.house_no }));
  return { send, opted_out: optedOut, with_consent: contactable.size, door_hangers: list.length, total: found.length, list };
}

/** The door hanger and mail list for these areas: addresses only, in street and house number order. */
async function doorHangers(tenantId, type, areas) {
  const aud = await require('./streetnotices').audienceOf(tenantId, type, areas, { withDoorList: true });
  return aud.door_list || [];
}

/** Is this service address still on the list with this contact, consent kept (a follow-up checks again)? */
async function stillContact(db, tenantId, id, channel, to) {
  const a = await one(db, 'SELECT phone, email, contact_ok, active FROM service_addresses WHERE tenant_id = ? AND id = ?', [tenantId, id]);
  if (!a || !Number(a.active) || !Number(a.contact_ok)) return false;
  const SN = require('./streetnotices');
  return channel === 'sms' ? SN.phoneAddr(a.phone) === to : SN.emailAddr(a.email) === String(to || '').toLowerCase();
}

/** The daily retention run: an address ended more than `days` ago is deleted (its phone and email went when it ended). */
async function purge(days) {
  const [r] = await pool.query('DELETE FROM service_addresses WHERE active = 0 AND ended_at IS NOT NULL AND ended_at < UTC_TIMESTAMP() - INTERVAL ? DAY LIMIT 50000', [days]);
  return r.affectedRows;
}

/**
 * What is kept of a customer's account number (2026.11.20 review): its last 4 letters or digits, to tell two customers
 * apart on screen ("…0100"). The whole number is never stored: an import matches on matchKey(), a keyed hash.
 */
const accountLast4 = (account) => { const a = String(account || '').replace(/[^0-9A-Za-z]/g, ''); return a ? a.slice(-4) : null; };

module.exports = { accountLast4, reachesCustomers, matchKey, placeKey, inAreas, reach, doorHangers, stillContact, purge, norm };
