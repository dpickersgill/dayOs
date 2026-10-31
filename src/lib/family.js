'use strict';

// Family on file. A 'guardian' link says adult_id is a parent or guardian of member_id; a 'family' link is a household
// connection. A guest under 18 is only sold anything with a guardian named, and the guardian signs the waiver.
const { rows, one } = require('../db');
const { ageOn } = require('./customers');

const MINOR_AGE = 18;

/** Adds a link if it is not already there. */
async function addLink(conn, tenantId, adultId, memberId, relation = 'guardian') {
  if (adultId === memberId) return;
  const existing = await one(conn, 'SELECT relation FROM person_links WHERE tenant_id = ? AND ((adult_id = ? AND member_id = ?) OR (adult_id = ? AND member_id = ?)) LIMIT 1', [tenantId, adultId, memberId, memberId, adultId]);
  if (existing) {
    if (relation === 'guardian' && existing.relation !== 'guardian') await conn.query("UPDATE person_links SET relation = 'guardian' WHERE tenant_id = ? AND adult_id = ? AND member_id = ?", [tenantId, adultId, memberId]);
    return;
  }
  await conn.query('INSERT INTO person_links (tenant_id, adult_id, member_id, relation) VALUES (?, ?, ?, ?)', [tenantId, adultId, memberId, relation]);
}

const SLIM = 'p.id, p.first_name, p.last_name, p.date_of_birth, p.sex, p.phone, p.email, (p.photo IS NOT NULL) AS has_photo';

/** The guardians, dependents and household members of one person. */
async function familyOf(conn, tenantId, id, today) {
  const guardians = await rows(conn, `SELECT ${SLIM} FROM person_links l JOIN people p ON p.id = l.adult_id AND p.tenant_id = l.tenant_id WHERE l.tenant_id = ? AND l.member_id = ? AND l.relation = 'guardian' ORDER BY p.first_name`, [tenantId, id]);
  const dependents = await rows(conn, `SELECT ${SLIM} FROM person_links l JOIN people p ON p.id = l.member_id AND p.tenant_id = l.tenant_id WHERE l.tenant_id = ? AND l.adult_id = ? AND l.relation = 'guardian' ORDER BY p.date_of_birth DESC, p.first_name`, [tenantId, id]);
  const household = await rows(conn, `SELECT ${SLIM} FROM person_links l JOIN people p ON p.tenant_id = l.tenant_id AND p.id = IF(l.adult_id = ?, l.member_id, l.adult_id) WHERE l.tenant_id = ? AND l.relation = 'family' AND (l.adult_id = ? OR l.member_id = ?) ORDER BY p.first_name`, [id, tenantId, id, id]);
  const dress = (p) => ({ ...p, has_photo: Boolean(p.has_photo), age: today ? ageOn(p.date_of_birth, today) : null });
  return { guardians: guardians.map(dress), dependents: dependents.map(dress), household: household.map(dress) };
}

/**
 * May this adult act as guardian for this child? Yes when the child record was just made for them, or already lists them
 * as guardian. A child already on file with no guardian is not open to anyone who knows the name and birth date: online,
 * nobody becomes that child's guardian (2026.11.11). Staff, who checked who is standing at the counter, pass staff: true
 * and may name the first guardian of a child who has none.
 */
async function mayActAsGuardian(conn, tenantId, adultId, childId, justCreated, { staff = false } = {}) {
  if (!adultId) return false;
  if (justCreated) return true;
  const g = await rows(conn, "SELECT adult_id FROM person_links WHERE tenant_id = ? AND member_id = ? AND relation = 'guardian'", [tenantId, childId]);
  if (g.some((x) => Number(x.adult_id) === Number(adultId))) return true;
  return staff && !g.length;
}

/**
 * A child already in this adult's care with the same name (and birth date, when both have one): an online buyer buying
 * again for their own child gets the same record, without matching anyone else's child by name.
 */
async function kinOf(conn, tenantId, adultId, { first_name, last_name, date_of_birth }) {
  if (!adultId) return null;
  const kin = await rows(conn, `SELECT p.id, p.date_of_birth FROM person_links l JOIN people p ON p.tenant_id = l.tenant_id AND p.id = l.member_id
    WHERE l.tenant_id = ? AND l.adult_id = ? AND l.relation = 'guardian' AND p.first_name = ? AND p.last_name = ? AND p.anonymised_at IS NULL ORDER BY p.id`, [tenantId, adultId, first_name, last_name]);
  const d10 = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10) : null);
  const hit = kin.find((k) => !date_of_birth || !k.date_of_birth || d10(k.date_of_birth) === date_of_birth);
  return hit ? hit.id : null;
}

const isMinor = (dob, today) => { const a = ageOn(dob, today); return a !== null && a < MINOR_AGE; };

module.exports = { MINOR_AGE, addLink, familyOf, isMinor, mayActAsGuardian, kinOf };
