'use strict';

// Residents (muni release 1): a resident's contact, kept apart from everything public. A request, a bulk pickup booking
// and a street notice sign-up all write to the same table through upsertResident, so one person with one phone is one
// row. The requests workstream owns this file; this copy has the same signature until it is merged (the assembler keeps one).
//
// A resident's name, phone, email and address are personal data: never on a public page, in a log, in the assistant or in a
// public record export.
const { one } = require('../db');

/** The 10-digit US/Canada key of a phone number, or null. */
function phoneKey(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  const k = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  return k.length === 10 ? k : null;
}

const clean = (v, max) => {
  const s = v === undefined || v === null ? '' : String(v).trim();
  return s ? s.slice(0, max) : null;
};

/**
 * Finds the resident by phone (its 10-digit key) and then by email, or adds one. Returns the resident's id.
 * Given fields replace what is on file (the latest answer to texts and emails wins); fields left undefined are kept.
 */
async function upsertResident(conn, tenantId, { name, phone, email, streetId, houseNumber, unit, textsOk, emailsOk } = {}) {
  const key = phoneKey(phone);
  const mail = clean(email, 255) ? clean(email, 255).toLowerCase() : null;
  let found = null;
  if (key) {
    found = await one(conn, `SELECT id FROM residents WHERE tenant_id = ? AND phone IS NOT NULL
      AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', ''), 10) = ? ORDER BY id LIMIT 1 FOR UPDATE`, [tenantId, key]);
  }
  if (!found && mail) found = await one(conn, 'SELECT id FROM residents WHERE tenant_id = ? AND email = ? ORDER BY id LIMIT 1 FOR UPDATE', [tenantId, mail]);
  const fields = {
    name: clean(name, 120), phone: clean(phone, 40), email: mail,
    street_id: streetId === undefined ? undefined : (streetId || null),
    house_number: houseNumber === undefined ? undefined : clean(houseNumber, 20),
    unit: unit === undefined ? undefined : clean(unit, 20),
    texts_ok: textsOk === undefined ? undefined : (textsOk ? 1 : 0),
    emails_ok: emailsOk === undefined ? undefined : (emailsOk ? 1 : 0),
  };
  if (found) {
    const set = []; const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      if (v === null && ['name', 'phone', 'email'].includes(k)) continue; // a blank never wipes what is on file
      set.push(`${k} = ?`); vals.push(v);
    }
    if (set.length) await conn.query(`UPDATE residents SET ${set.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, tenantId, found.id]);
    return Number(found.id);
  }
  const [r] = await conn.query(
    'INSERT INTO residents (tenant_id, name, phone, email, street_id, house_number, unit, texts_ok, emails_ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [tenantId, fields.name || 'Resident', fields.phone, fields.email, fields.street_id ?? null, fields.house_number ?? null, fields.unit ?? null, fields.texts_ok ?? 0, fields.emails_ok ?? 0],
  );
  return Number(r.insertId);
}

module.exports = { upsertResident, phoneKey };
