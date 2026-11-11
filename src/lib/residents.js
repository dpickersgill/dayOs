'use strict';

// Residents (muni release 1): a resident's contact, kept apart from everything public. The requests workstream owns this
// file and the residents table; this is the notices workstream's copy with the shared signature (SPEC.md, Shared tables),
// so street notice sign-ups and imports write to the same table. When both are merged, the requests copy is kept.
//
// upsertResident(conn, tenantId, { name, phone, email, streetId, houseNumber, unit, textsOk, emailsOk }) -> id
//   Finds the resident by phone (its 10-digit key, however it was written) and then by email (any case), or adds one.
//   On a match: a phone or email the record lacks is filled in (one it has is never replaced by someone typing another),
//   a name and an address given replace the old ones, and textsOk / emailsOk change only when given (true or false).
// Names, phones, emails and addresses are personal data: never log them, never put them on a public page or in AI.
const { one } = require('../db');

/** The 10-digit US/Canada key of a phone number, or null. */
function phoneKey(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  const k = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  return k.length === 10 ? k : null;
}
const cleanEmail = (e) => { const s = String(e || '').trim().toLowerCase(); return s || null; };
const clip = (s, n) => { const t = String(s ?? '').trim(); return t ? t.slice(0, n) : null; };
/** How a phone is stored: +1 and its ten digits. */
const storedPhone = (phone) => { const k = phoneKey(phone); return k ? `+1${k}` : null; };

/** The resident with this phone (by its key) or, failing that, this email. Locks the row inside a transaction. */
async function findResident(conn, tenantId, { phone, email }) {
  const key = phoneKey(phone);
  if (key) {
    const r = await one(conn, "SELECT * FROM residents WHERE tenant_id = ? AND RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', ''), 10) = ? ORDER BY id LIMIT 1 FOR UPDATE", [tenantId, key]);
    if (r) return r;
  }
  const e = cleanEmail(email);
  if (e) return one(conn, 'SELECT * FROM residents WHERE tenant_id = ? AND LOWER(email) = ? ORDER BY id LIMIT 1 FOR UPDATE', [tenantId, e]);
  return null;
}

async function upsertResident(conn, tenantId, { name, phone, email, streetId, houseNumber, unit, textsOk, emailsOk } = {}) {
  const ph = storedPhone(phone); const em = cleanEmail(email);
  if (!ph && !em) throw new Error('upsertResident needs a phone or an email');
  const found = await findResident(conn, tenantId, { phone: ph, email: em });
  if (!found) {
    const [r] = await conn.query(`INSERT INTO residents (tenant_id, name, phone, email, street_id, house_number, unit, texts_ok, emails_ok)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [tenantId, clip(name, 120), ph, em ? em.slice(0, 255) : null, streetId || null, clip(houseNumber, 20), clip(unit, 20), textsOk ? 1 : 0, emailsOk ? 1 : 0]);
    return Number(r.insertId);
  }
  const sets = []; const vals = [];
  const set = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };
  if (clip(name, 120)) set('name', clip(name, 120));
  if (ph && !found.phone) set('phone', ph);
  if (em && !found.email) set('email', em.slice(0, 255));
  if (streetId) { set('street_id', streetId); set('house_number', clip(houseNumber, 20)); set('unit', clip(unit, 20)); }
  if (typeof textsOk === 'boolean') set('texts_ok', textsOk ? 1 : 0);
  if (typeof emailsOk === 'boolean') set('emails_ok', emailsOk ? 1 : 0);
  if (sets.length) await conn.query(`UPDATE residents SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, tenantId, found.id]);
  return Number(found.id);
}

module.exports = { upsertResident, findResident, phoneKey, storedPhone };
