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
 * May this buyer act as guardian for this child online? Yes when the child record was just made, has no guardian yet,
 * or already lists the buyer. A stranger who knows a child's name and birth date cannot attach themselves.
 */
async function mayActAsGuardian(conn, tenantId, adultId, childId, justCreated) {
  if (!adultId) return false;
  if (justCreated) return true;
  const g = await rows(conn, "SELECT adult_id FROM person_links WHERE tenant_id = ? AND member_id = ? AND relation = 'guardian'", [tenantId, childId]);
  return !g.length || g.some((x) => x.adult_id === adultId);
}

const isMinor = (dob, today) => { const a = ageOn(dob, today); return a !== null && a < MINOR_AGE; };

module.exports = { MINOR_AGE, addLink, familyOf, isMinor, mayActAsGuardian };
