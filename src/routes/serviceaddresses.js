'use strict';

// The water customer list for street notices (release 2026.11.20, lib/serviceaddresses.js), and a notice's door hanger list.
// Mounted at /api/v1/street-notices ahead of routes/streetnotices.js, so it is part of Resident requests:
//   GET  /service-addresses/streets       service addresses by street, with how many have a phone or email kept (anyone who sees notices)
//   GET  /service-addresses?street_id=    the addresses on one street, with their phone and email (managers and front desk)
//   GET  /service-addresses/imports       the imports, with who confirmed consent and what they wrote (managers)
//   POST /service-addresses/import        the CSV from the billing system (managers): phones and emails kept only with the
//                                         consent attestation; replace ends the addresses that are not in the file
//   POST /service-addresses/clear         ends the whole list and removes every phone and email on it (managers)
//   GET  /:id/door-hangers                the addresses a notice does not reach by text or email (addresses only; ?format=csv)
// Every import and clear is in the audit log, without any address, phone or email in it.
const express = require('express');
const { pool, rows, one, tx } = require('../db');
const { requireRole, isManager } = require('../middleware/auth');
const { z, validate, paramId } = require('../lib/util');
const { notFound, bad } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { toCsv } = require('../lib/csv');
const SN = require('../lib/streetnotices');
const SA = require('../lib/serviceaddresses');
const RES = require('../lib/residents');

const router = express.Router();
const anyone = requireRole('manager', 'counter', 'staff');
const desk = requireRole('manager', 'counter');
const mgr = requireRole('manager');

router.get('/service-addresses/streets', anyone, async (req, res) => {
  const t = req.auth.tenantId;
  const data = await rows(pool, `SELECT st.id AS street_id, st.name, COUNT(*) AS addresses, SUM(s.contact_ok = 1 AND (s.phone IS NOT NULL OR s.email IS NOT NULL)) AS with_contact
    FROM service_addresses s JOIN streets st ON st.tenant_id = s.tenant_id AND st.id = s.street_id WHERE s.tenant_id = ? AND s.active = 1 GROUP BY st.id, st.name ORDER BY st.name`, [t]);
  const last = await one(pool, 'SELECT id, created_at, rows_in, consent FROM service_address_imports WHERE tenant_id = ? ORDER BY id DESC LIMIT 1', [t]);
  const n = (v) => Number(v || 0);
  res.json({
    data: data.map((r) => ({ street_id: Number(r.street_id), name: r.name, addresses: n(r.addresses), with_contact: n(r.with_contact) })),
    total: data.reduce((s, r) => s + n(r.addresses), 0), with_contact: data.reduce((s, r) => s + n(r.with_contact), 0),
    last_import: last ? { at: last.created_at, rows: n(last.rows_in), consent: Boolean(last.consent) } : null,
  });
});

router.get('/service-addresses', desk, async (req, res) => {
  const street = Number(req.query.street_id);
  if (!Number.isInteger(street) || street <= 0) throw bad('Pick a street');
  const data = await rows(pool, `SELECT s.id, s.house_number, s.unit, s.account_number, s.phone, s.email, s.contact_ok,
      (SELECT a.stopped_at FROM alert_addresses a WHERE a.tenant_id = s.tenant_id AND a.channel = 'sms' AND a.addr = RIGHT(REGEXP_REPLACE(COALESCE(s.phone, ''), '[^0-9]', ''), 10)) AS texts_stopped_at,
      (SELECT a.stopped_at FROM alert_addresses a WHERE a.tenant_id = s.tenant_id AND a.channel = 'email' AND a.addr = LOWER(s.email)) AS emails_stopped_at
    FROM service_addresses s WHERE s.tenant_id = ? AND s.street_id = ? AND s.active = 1 ORDER BY s.house_no IS NULL, s.house_no, s.house_number, s.unit, s.id LIMIT 5000`, [req.auth.tenantId, street]);
  res.set('Cache-Control', 'private, no-store').json({ data: data.map((r) => ({ ...r, contact_ok: Boolean(r.contact_ok) })) });
});

router.get('/service-addresses/imports', mgr, async (req, res) => {
  const NAME = "COALESCE(NULLIF(TRIM(CONCAT(COALESCE(p.first_name, ''), ' ', COALESCE(p.last_name, ''))), ''), u.username, u.email)";
  res.json({ data: await rows(pool, `SELECT i.id, i.file_name, i.rows_in, i.added, i.updated, i.ended, i.skipped, i.with_contacts, i.consent, i.consent_note, i.replace_all, i.created_at, ${NAME} AS by_name
    FROM service_address_imports i LEFT JOIN users u ON u.tenant_id = i.tenant_id AND u.id = i.created_by LEFT JOIN people p ON p.tenant_id = u.tenant_id AND p.id = u.person_id
    WHERE i.tenant_id = ? ORDER BY i.id DESC LIMIT 50`, [req.auth.tenantId]) });
});

// Column names billing systems use, to the field each one fills.
const HEADS = {
  street: 'street', street_name: 'street', house_number: 'house_number', house: 'house_number', number: 'house_number', house_no: 'house_number', street_number: 'house_number',
  unit: 'unit', apt: 'unit', apartment: 'unit', suite: 'unit', account: 'account', account_number: 'account', account_no: 'account', acct: 'account', account_id: 'account',
  phone: 'phone', cell: 'phone', mobile: 'phone', phone_number: 'phone', email: 'email', email_address: 'email',
  address: 'address', service_address: 'address', location: 'address', premise_address: 'address',
};
const importBody = z.object({
  csv: z.string().min(1, 'Paste the list or pick the file').max(5_000_000),
  file_name: z.string().trim().max(200).nullable().optional(),
  replace: z.boolean().optional(),
  consent: z.boolean().optional(),
  consent_note: z.string().trim().max(300).nullable().optional(),
}).superRefine((b, ctx) => {
  if (b.consent && (!b.consent_note || b.consent_note.length < 5)) ctx.addIssue({ code: 'custom', path: ['consent_note'], message: 'Say how the customers agreed, for example "Water bill sign-up form, text and email box ticked"' });
});

/** "123A Main St" -> { house: '123A', street: 'Main St' }; an address with no number is all street. */
function splitAddress(s) {
  const m = /^\s*(\d+[A-Za-z]?(?:[-/]\d+[A-Za-z]?)?)\s+(.+?)\s*$/.exec(String(s || ''));
  return m ? { house: m[1], street: m[2] } : { house: null, street: String(s || '').trim() };
}

router.post('/service-addresses/import', mgr, validate(importBody), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const table = require('../lib/places').parseCsv(b.csv).filter((r) => r.some((c) => String(c || '').trim()));
  if (table.length < 2) throw bad('The list needs a header row (street, house_number, unit, account_number, phone, email) and at least one address.');
  if (table.length > 30001) throw bad('Import at most 30,000 addresses at a time.');
  const head = table[0].map((h) => HEADS[String(h).trim().toLowerCase().replace(/[\s.#-]+/g, '_').replace(/_+$/, '')] || null);
  if (!head.includes('street') && !head.includes('address')) throw bad('The header row needs a street column (or a service address column like "123 Main St").');
  const streets = await rows(pool, 'SELECT id, name, aliases FROM streets WHERE tenant_id = ?', [t]);
  // Billing systems shorten street names ("Walnut St", "Ridge Ave"): the last word is read in full before matching.
  const SUFFIX = { st: 'street', str: 'street', ave: 'avenue', av: 'avenue', rd: 'road', dr: 'drive', ln: 'lane', ct: 'court', pl: 'place', blvd: 'boulevard', ter: 'terrace', cir: 'circle', pk: 'pike', hwy: 'highway', aly: 'alley', way: 'way' };
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').replace(/ (\w+)$/, (m, w) => ` ${SUFFIX[w] || w}`);
  const byName = new Map();
  for (const s of streets) { byName.set(norm(s.name), Number(s.id)); for (const a of String(s.aliases || '').split(/[,;]/)) if (norm(a)) byName.set(norm(a), Number(s.id)); }
  const consent = Boolean(b.consent);
  const clean = (v) => String(v ?? '').trim().replace(/^'(?=[=+\-@])/, '');
  const out = { added: 0, updated: 0, ended: 0, skipped: [], contacts_kept: 0, contacts_dropped: 0, stopped: 0 };

  const result = await tx(async (conn) => {
    const [imp] = await conn.query('INSERT INTO service_address_imports (tenant_id, file_name, rows_in, consent, consent_note, replace_all, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [t, b.file_name || null, table.length - 1, consent ? 1 : 0, consent ? b.consent_note : null, b.replace ? 1 : 0, req.auth.userId]);
    const importId = imp.insertId;
    const have = new Map((await rows(conn, 'SELECT id, match_key FROM service_addresses WHERE tenant_id = ? FOR UPDATE', [t])).map((r) => [r.match_key, Number(r.id)]));
    const seen = new Set();
    for (let i = 1; i < table.length; i += 1) {
      const row = {}; head.forEach((k, j) => { if (k && row[k] === undefined) row[k] = clean(table[i][j]); });
      const line = i + 1;
      let street = row.street; let house = row.house_number || null;
      if (!street && row.address) { const sp = splitAddress(row.address); street = sp.street; house = house || sp.house; }
      const streetId = byName.get(norm(street));
      if (!streetId) { out.skipped.push({ line, reason: street ? 'Street not on your street list' : 'No street' }); continue; }
      const unit = row.unit ? row.unit.slice(0, 20) : null;
      const account = row.account ? row.account.slice(0, 40) : null;
      let phone = null; let email = null;
      if (consent) {
        phone = row.phone ? SN.phoneAddr(row.phone) : null;
        email = row.email ? SN.emailAddr(row.email) : null;
        if (row.phone && !phone) out.skipped.push({ line, reason: 'Phone is not a US number with an area code; the address is kept without it' });
        if (row.email && !email) out.skipped.push({ line, reason: 'Email is not a valid address; the address is kept without it' });
      } else if (row.phone || row.email) out.contacts_dropped += 1;
      const key = SA.matchKey({ account, streetId, houseNumber: house, unit });
      seen.add(key);
      const vals = [streetId, house ? house.slice(0, 20) : null, SN.houseNo(house), unit, account, phone, email, phone || email ? 1 : 0, importId];
      if (have.has(key)) {
        await conn.query('UPDATE service_addresses SET street_id = ?, house_number = ?, house_no = ?, unit = ?, account_number = ?, phone = ?, email = ?, contact_ok = ?, import_id = ?, active = 1, ended_at = NULL WHERE tenant_id = ? AND id = ?', [...vals, t, have.get(key)]);
        out.updated += 1;
      } else {
        const [r] = await conn.query('INSERT INTO service_addresses (street_id, house_number, house_no, unit, account_number, phone, email, contact_ok, import_id, tenant_id, match_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [...vals, t, key]);
        have.set(key, Number(r.insertId));
        out.added += 1;
      }
      // A phone or email kept with consent is on the alert address list, so a STOP or the stop link reaches it. One that
      // already said stop stays stopped: the import is not a new yes.
      for (const [channel, v] of [['sms', phone], ['email', email]]) {
        if (!v) continue;
        out.contacts_kept += 1;
        const a = await SN.addressRow(conn, t, channel, v);
        if (a.stopped_at || (channel === 'sms' && await RES.stoppedByText(conn, t, v))) { out.stopped += 1; continue; }
        if (!a.confirmed_at) {
          await conn.query("UPDATE alert_addresses SET confirmed_at = UTC_TIMESTAMP(), confirmed_by = 'import' WHERE tenant_id = ? AND id = ?", [t, a.id]);
          await SN.recordAnswer(conn, t, a.id, 'opted_in', 'water_customers', req.auth.userId);
        }
      }
    }
    if (b.replace) {
      const gone = [...have.entries()].filter(([k]) => !seen.has(k)).map(([, id]) => id);
      for (let i = 0; i < gone.length; i += 1000) {
        const [r] = await conn.query('UPDATE service_addresses SET active = 0, ended_at = UTC_TIMESTAMP(), phone = NULL, email = NULL, contact_ok = 0 WHERE tenant_id = ? AND active = 1 AND id IN (?)', [t, gone.slice(i, i + 1000)]);
        out.ended += r.affectedRows;
      }
    }
    await conn.query('UPDATE service_address_imports SET added = ?, updated = ?, ended = ?, skipped = ?, with_contacts = ? WHERE tenant_id = ? AND id = ?',
      [out.added, out.updated, out.ended, out.skipped.filter((s) => !/kept without it/.test(s.reason)).length, out.contacts_kept, t, importId]);
    await audit(conn, req, 'import', 'service_addresses', importId, { rows: table.length - 1, added: out.added, updated: out.updated, ended: out.ended, skipped: out.skipped.length,
      contacts_kept: out.contacts_kept, contacts_dropped: out.contacts_dropped, consent_attested: consent, replace: Boolean(b.replace) });
    return importId;
  });
  res.json({ import_id: Number(result), ...out, skipped: out.skipped.slice(0, 200) });
});

router.post('/service-addresses/clear', mgr, validate(z.object({ confirm: z.literal(true, { message: 'Confirm that you want to remove the whole list' }) })), async (req, res) => {
  const [r] = await pool.query('UPDATE service_addresses SET active = 0, ended_at = UTC_TIMESTAMP(), phone = NULL, email = NULL, contact_ok = 0 WHERE tenant_id = ? AND active = 1', [req.auth.tenantId]);
  await audit(pool, req, 'clear', 'service_addresses', null, { ended: r.affectedRows });
  res.json({ ended: r.affectedRows });
});

/** The door hanger and mail list for a notice: the water customer addresses it does not reach by text or email. */
router.get('/:id/door-hangers', anyone, async (req, res) => {
  const t = req.auth.tenantId;
  const n = await one(pool, 'SELECT id, code, type, title, status FROM street_notices WHERE tenant_id = ? AND id = ?', [t, paramId(req)]);
  if (!n) throw notFound('Notice');
  const areas = await SN.areasOf(pool, t, n.id);
  const list = SA.reachesCustomers(n.type) ? await SA.doorHangers(t, n.type, areas) : [];
  await audit(pool, req, 'door_hangers', 'street_notices', n.id, { addresses: list.length, format: req.query.format === 'csv' ? 'csv' : 'screen' });
  if (req.query.format === 'csv') {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="door-hangers-${n.code}.csv"`, 'Cache-Control': 'private, no-store' })
      .send(toCsv(['street', 'house_number', 'unit'], list.map((a) => ({ street: a.street, house_number: a.house_number || '', unit: a.unit || '' }))));
    return;
  }
  res.set('Cache-Control', 'private, no-store').json({ notice: { id: Number(n.id), code: n.code, title: n.title, type_label: SN.TYPE[n.type].label, status: n.status }, streets: SN.areasWords(areas),
    reaches_customers: SA.reachesCustomers(n.type), addresses: list.map((a) => ({ street: a.street, house_number: a.house_number, unit: a.unit })), is_manager: isManager(req) });
});

module.exports = router;
