'use strict';

// Stormwater rules shared by the screens and the inspection path (release 2026.11.20): MS4 permit years and the outfall
// screening hook. People decide: a case records what staff found and did; the app never says a discharge is illegal.
//
// A failed outfall screening (any item outside its rule on an inspection of a storm outfall) lowers the outfall's
// condition to at least 4 (Poor), so its risk (condition x criticality) shows it. An answer of yes to "Suspected illicit
// discharge" also opens an illicit discharge case on the outfall, linked to that screening, unless the outfall already has
// an open case: then the screening is added to that case's log.
const { one } = require('../db');

const FAILED_SCREENING_CONDITION = 4;
// The six minimum control measures of a Pennsylvania MS4 permit, in the order the annual report lists them.
const MCMS = [
  { mcm: 1, key: 'education', title: 'Public education and outreach', kinds: ['education'] },
  { mcm: 2, key: 'involvement', title: 'Public involvement and participation', kinds: ['involvement'] },
  { mcm: 3, key: 'idde', title: 'Illicit discharge detection and elimination', kinds: [] },
  { mcm: 4, key: 'construction', title: 'Construction site stormwater runoff control', kinds: ['construction'] },
  { mcm: 5, key: 'post_construction', title: 'Post-construction stormwater management', kinds: ['post_construction'] },
  { mcm: 6, key: 'housekeeping', title: 'Pollution prevention and good housekeeping', kinds: ['housekeeping', 'training'] },
];
const KIND_WORDS = { education: 'Education or outreach', involvement: 'Public involvement', construction: 'Construction site inspection', post_construction: 'Post-construction BMP inspection', housekeeping: 'Yard or facility inspection', training: 'Staff training' };
const KINDS = Object.keys(KIND_WORDS);

/** The permit year (July 1 to June 30) a date falls in: { year, start, end, label }, year being the July it starts. */
function permitYearOf(date) {
  const y = Number(String(date).slice(0, 4)); const m = Number(String(date).slice(5, 7));
  return permitYear(m >= 7 ? y : y - 1);
}
const permitYear = (year) => ({ year, start: `${year}-07-01`, end: `${year + 1}-06-30`, label: `July 1, ${year} to June 30, ${year + 1}` });

/** The next case reference for this municipality: IDD-2026-01, IDD-2026-02, ... (per calendar year). */
async function nextCaseRef(conn, tenantId, year) {
  const r = await one(conn, 'SELECT COUNT(*) AS n FROM idd_cases WHERE tenant_id = ? AND reference LIKE ?', [tenantId, `IDD-${year}-%`]);
  for (let n = Number(r.n) + 1; n < Number(r.n) + 50; n += 1) {
    const ref = `IDD-${year}-${String(n).padStart(2, '0')}`;
    if (!(await one(conn, 'SELECT id FROM idd_cases WHERE tenant_id = ? AND reference = ?', [tenantId, ref]))) return ref;
  }
  throw new Error('Could not make a case reference');
}

/**
 * Called by lib/assetinspect.js record() inside its transaction, after an inspection on a map item is saved. Does nothing
 * unless the item is a storm outfall. Returns { condition_score, case_id } for what it changed, or null.
 */
async function afterScreening(conn, req, target, items, inspectionId, failed, at) {
  if (target.type !== 'feature' || target.kind !== 'storm_outfall') return null;
  const t = req.auth.tenantId;
  const { audit } = require('./audit');
  const out = { condition_score: null, case_id: null };
  if (failed) {
    const [r] = await conn.query('UPDATE map_features SET condition_score = ? WHERE tenant_id = ? AND id = ? AND (condition_score IS NULL OR condition_score < ?)',
      [FAILED_SCREENING_CONDITION, t, target.id, FAILED_SCREENING_CONDITION]);
    if (r.affectedRows) {
      out.condition_score = FAILED_SCREENING_CONDITION;
      await audit(conn, req, 'condition', 'map_features', target.id, { condition_score: FAILED_SCREENING_CONDITION, why: 'failed outfall screening', inspection_id: inspectionId });
    }
  }
  const illicit = items.find((i) => i.key === 'illicit' && String(i.value).toLowerCase() === 'yes');
  if (!illicit) return out;
  const found = items.filter((i) => i.result === 'fail' || (i.value && !['no', 'none', 'no flow'].includes(String(i.value).toLowerCase()))).filter((i) => i.key !== 'illicit')
    .map((i) => `${i.label}: ${i.value === undefined || i.value === null ? (i.result || '') : i.value}${i.note ? ` (${i.note})` : ''}`).join('; ');
  const day = String(at).slice(0, 10);
  const open = await one(conn, "SELECT id, reference FROM idd_cases WHERE tenant_id = ? AND outfall_id = ? AND status IN ('open','source_found') ORDER BY id DESC LIMIT 1 FOR UPDATE", [t, target.id]);
  if (open) {
    await conn.query("INSERT INTO idd_case_entries (tenant_id, case_id, kind, on_date, body, map_feature_id, user_id) VALUES (?, ?, 'upstream', ?, ?, ?, ?)",
      [t, open.id, day, `Screened again (inspection ${inspectionId}): suspected illicit discharge still present. ${found}`.slice(0, 2000), target.id, req.auth.userId || null]);
    out.case_id = Number(open.id);
    return out;
  }
  const ref = await nextCaseRef(conn, t, Number(day.slice(0, 4)));
  const [c] = await conn.query("INSERT INTO idd_cases (tenant_id, reference, outfall_id, inspection_id, opened_at, status, description, created_by) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)",
    [t, ref, target.id, inspectionId, at, `Dry-weather screening of ${target.name} found a suspected illicit discharge. ${found}`.slice(0, 1000), req.auth.userId || null]);
  await conn.query("INSERT INTO idd_case_entries (tenant_id, case_id, kind, on_date, body, map_feature_id, user_id) VALUES (?, ?, 'note', ?, ?, ?, ?)",
    [t, c.insertId, day, `Case opened from the dry-weather screening (inspection ${inspectionId}).`, target.id, req.auth.userId || null]);
  await audit(conn, req, 'create', 'idd_cases', c.insertId, { reference: ref, outfall_id: target.id, inspection_id: inspectionId });
  out.case_id = Number(c.insertId);
  return out;
}

module.exports = { MCMS, KINDS, KIND_WORDS, FAILED_SCREENING_CONDITION, permitYear, permitYearOf, nextCaseRef, afterScreening };
