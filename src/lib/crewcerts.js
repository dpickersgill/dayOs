'use strict';

// The certification types a public works department tracks (release 2026.11.20). A municipality gets them when it is
// made (routes/platform.js) and the migration gives them to every municipality made before (db/steps/m2-crew.js). Each
// carries a code so the app can find it whatever the municipality renames it to: the boil water advisory's certified
// operators come from the people who hold a water operator license (lib/crewday.js licenseHolders). No requires here:
// the migration loads this file.
const MUNI_CERTS = [
  ['cdl_a', 'CDL Class A'],
  ['cdl_b', 'CDL Class B'],
  ['dot_medical', 'DOT medical card'],
  ['pa_water_operator', 'Pennsylvania water operator'],
  ['pa_wastewater_operator', 'Pennsylvania wastewater operator'],
  ['cpsi', 'Certified playground safety inspector'],
  ['flagger', 'Flagger'],
  ['pesticide', 'Pesticide applicator'],
  ['first_aid_cpr', 'First aid/CPR'],
];
const OPERATOR_CODES = { water: 'pa_water_operator', wastewater: 'pa_wastewater_operator' };

/** Gives a municipality the built-in types it does not have yet; one it already has by name keeps its id and gets the code. */
async function seedCertifications(conn, tenantId) {
  for (const [code, name] of MUNI_CERTS) {
    await conn.query('INSERT INTO certifications (tenant_id, name, code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE code = COALESCE(code, VALUES(code))', [tenantId, name, code]);
  }
}

module.exports = { MUNI_CERTS, OPERATOR_CODES, seedCertifications };
