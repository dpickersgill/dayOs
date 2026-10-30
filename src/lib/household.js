'use strict';
// The household: the people one guest account sees and buys for. It is the signed-in adult, the people linked to them as
// guardian (person_links relation 'guardian'), any second adult linked as family (relation 'family') and that adult's
// children too. Shared by the household account and the shop (Track ACCOUNT), the welcome-back card's family history
// (WINDOW) and the birthday email to a parent (LOYALTY). Never shows anyone outside these links.
const { rows, one } = require('../db');

const COLS = 'p.id, p.first_name, p.last_name, p.email, p.date_of_birth, p.height_in, p.weight_lb, p.boot_size, p.stance, p.discipline, p.ability_level, p.ski_level, p.snowboard_level, (p.photo IS NOT NULL) AS has_photo';

/** The ids of everyone in one person's household (the person first). */
async function idsOf(db, tenantId, personId) {
  const id = Number(personId);
  if (!id) return [];
  // Adults in the same household: family links either way.
  const adults = await rows(db, "SELECT IF(adult_id = ?, member_id, adult_id) AS id FROM person_links WHERE tenant_id = ? AND relation = 'family' AND (adult_id = ? OR member_id = ?)", [id, tenantId, id, id]);
  const grown = [id, ...adults.map((a) => Number(a.id))];
  const kids = await rows(db, "SELECT member_id AS id FROM person_links WHERE tenant_id = ? AND relation = 'guardian' AND adult_id IN (?)", [tenantId, grown]);
  return [...new Set([...grown, ...kids.map((k) => Number(k.id))])];
}

/**
 * Everyone in one person's household, with what the account and the window use: names, birthday, sizes, levels, and
 * relation ('self', 'adult' for a second adult, 'child' for someone they are guardian of). Never notes, allergies or medical.
 */
async function membersOf(db, tenantId, personId) {
  const ids = await idsOf(db, tenantId, personId);
  if (!ids.length) return [];
  const kids = new Set((await rows(db, "SELECT member_id FROM person_links WHERE tenant_id = ? AND relation = 'guardian' AND adult_id IN (?)", [tenantId, ids])).map((k) => Number(k.member_id)));
  const list = await rows(db, `SELECT ${COLS} FROM people p WHERE p.tenant_id = ? AND p.id IN (?) AND p.anonymised_at IS NULL`, [tenantId, ids]);
  const rel = (p) => (Number(p.id) === Number(personId) ? 'self' : kids.has(Number(p.id)) ? 'child' : 'adult');
  return list.map((p) => ({ ...p, has_photo: Boolean(p.has_photo), date_of_birth: p.date_of_birth ? String(p.date_of_birth instanceof Date ? p.date_of_birth.toISOString() : p.date_of_birth).slice(0, 10) : null, relation: rel(p) }))
    .sort((a, b) => ['self', 'adult', 'child'].indexOf(a.relation) - ['self', 'adult', 'child'].indexOf(b.relation) || String(a.date_of_birth || '').localeCompare(String(b.date_of_birth || '')) || a.first_name.localeCompare(b.first_name));
}

/**
 * The household behind a signed-in email: the adults with that email (the oldest record first is "you") and everyone in
 * their households, plus children on a program place they booked. { adults: [ids], ids: [all], primary: id|null }.
 */
async function forEmail(db, tenantId, email) {
  const adults = await rows(db, 'SELECT id FROM people WHERE tenant_id = ? AND LOWER(email) = ? AND anonymised_at IS NULL ORDER BY id', [tenantId, String(email || '').toLowerCase()]);
  if (!adults.length) return { adults: [], ids: [], primary: null };
  const a = adults.map((x) => Number(x.id));
  const all = new Set(a);
  for (const id of a) for (const m of await idsOf(db, tenantId, id)) all.add(m);
  const prog = await rows(db, 'SELECT DISTINCT person_id FROM program_enrollments WHERE tenant_id = ? AND guardian_id IN (?)', [tenantId, a]).catch(() => []);
  for (const p of prog) all.add(Number(p.person_id));
  return { adults: a, ids: [...all], primary: a[0] };
}

/** True when a person is in the household (the check every account and shop route makes before touching a person). */
const has = (hh, personId) => Boolean(hh && hh.ids.includes(Number(personId)));

/** Links a second adult (relation 'family') or a child (guardian) to the signed-in adult. */
async function link(conn, tenantId, adultId, memberId, child) {
  if (Number(adultId) === Number(memberId)) return;
  const had = await one(conn, 'SELECT relation FROM person_links WHERE tenant_id = ? AND ((adult_id = ? AND member_id = ?) OR (adult_id = ? AND member_id = ?)) LIMIT 1', [tenantId, adultId, memberId, memberId, adultId]);
  if (had) return;
  await conn.query('INSERT INTO person_links (tenant_id, adult_id, member_id, relation) VALUES (?, ?, ?, ?)', [tenantId, adultId, memberId, child ? 'guardian' : 'family']);
}

module.exports = { idsOf, membersOf, forEmail, has, link };
