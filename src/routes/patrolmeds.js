'use strict';

// Medications, oxygen and AEDs (mounted under /patrol).
//
// The formulary is the list of drugs this patrol may give, set by its medical director: for each, whether it is a
// standing order, assisting with the patient's own medication, or only on medical control; the routes and the largest
// single dose; and the lowest certification allowed to give it. A medication recorded on a case is checked against it
// (see checkMedication, called from the case routes). Stock is kept by lot and station: giving a dose on a case takes
// it from the lot chosen, and the lot is written on the case.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, dateStr } = require('../lib/util');
const { notFound, bad, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const PA = require('../lib/patrolaccess');
const OPS = require('../lib/patrolops');

const router = express.Router();
const patrol = requireRole('patrol', 'manager');
const needs = (f, m) => PA.needs(pool, f, m);

const CERTS = ['none', 'oec', 'emr', 'emt', 'aemt', 'paramedic', 'rn', 'md'];
const CERT_LABEL = { none: 'No medical certification', oec: 'OEC', emr: 'EMR', emt: 'EMT', aemt: 'Advanced EMT', paramedic: 'Paramedic', rn: 'Nurse', md: 'Doctor' };
const UNITS = ['mg', 'mcg', 'g', 'mL', 'units', 'puffs', 'tablets', 'drops', 'L/min'];
const ROUTES = ['oral', 'chewed', 'sublingual', 'inhaled', 'intramuscular', 'intranasal', 'other'];

// The list a patrol starts with: what OEC technicians commonly give or help with. The medical director changes it.
const STARTER = [
  { name: 'Oxygen', authority: 'standing_order', routes: 'inhaled', max_dose: 15, dose_unit: 'L/min', notes: 'Give for low oxygen or shortness of breath per protocol.' },
  { name: 'Oral glucose', authority: 'standing_order', routes: 'oral', max_dose: 30, dose_unit: 'g', notes: 'Only for a patient who can swallow and protect their airway.' },
  { name: 'Aspirin', authority: 'standing_order', routes: 'chewed', max_dose: 324, dose_unit: 'mg', notes: 'Suspected cardiac chest pain, no allergy or bleeding risk.' },
  { name: 'Epinephrine auto-injector', authority: 'assist_own', routes: 'intramuscular', max_dose: 0.3, dose_unit: 'mg', notes: "Assist with the patient's own prescribed auto-injector." },
  { name: 'Albuterol inhaler', authority: 'assist_own', routes: 'inhaled', max_dose: null, dose_unit: 'puffs', notes: "Assist with the patient's own prescribed inhaler." },
  { name: 'Nitroglycerin', authority: 'assist_own', routes: 'sublingual', max_dose: 0.4, dose_unit: 'mg', notes: "Assist with the patient's own. Not with a top blood pressure under 100, or erectile dysfunction medication in the last 48 hours." },
];

/** The mountain's formulary; the starter list is put in the first time it is needed. */
async function formularyOf(db, t) {
  let list = await rows(db, 'SELECT * FROM patrol_formulary WHERE tenant_id = ? ORDER BY name', [t]);
  if (!list.length) {
    for (const f of STARTER) await db.query('INSERT IGNORE INTO patrol_formulary (tenant_id, name, authority, routes, max_dose, dose_unit, notes) VALUES (?, ?, ?, ?, ?, ?, ?)', [t, f.name, f.authority, f.routes, f.max_dose, f.dose_unit, f.notes]);
    list = await rows(db, 'SELECT * FROM patrol_formulary WHERE tenant_id = ? ORDER BY name', [t]);
  }
  return list.map((f) => ({ ...f, id: Number(f.id), active: Boolean(f.active), controlled: Boolean(f.controlled), max_dose: f.max_dose === null ? null : Number(f.max_dose), routes: f.routes ? f.routes.split(',') : [] }));
}

const norm = (s) => String(s || '').trim().toLowerCase();
const NO_ALLERGY = /^(none|nka|nkda|no known( drug)? allergies|no)$/i;
const AUTH_TEXT = { standing_order: 'Standing order', assist_own: "Patient's own medication", medical_control: 'Medical control (by radio or phone)' };

/**
 * Checks a medication about to be recorded on a patient. Throws with the reason when it must not be saved as given.
 *   - on the formulary and active; the route and dose within it; given by someone with the certification it needs
 *   - authority matches (medical control needs it said; assisting needs it to be the patient's own)
 *   - allergies were checked, and a drug named in the allergies needs an override reason
 *   - nitroglycerin: a blood pressure in the last 5 minutes of at least 100, and no erectile dysfunction medication
 * Returns { formulary, stock } for the caller to record the use.
 */
async function checkMedication(conn, t, patient, data, latestVitals) {
  const detail = data.detail || {};
  const list = await formularyOf(conn, t);
  const drug = list.find((f) => norm(f.name) === norm(data.medication));
  if (!drug || !drug.active) throw conflict(`${data.medication} is not on this patrol's formulary. The medical director adds medications on Patrol, Gear, Medications.`);
  if (data.route && drug.routes.length && !drug.routes.includes(data.route)) throw conflict(`${drug.name} is given ${drug.routes.join(' or ')} here, not ${data.route}.`);
  if (drug.max_dose !== null && detail.dose_unit && drug.dose_unit && detail.dose_unit === drug.dose_unit && Number(detail.dose_value) > drug.max_dose) {
    throw conflict(`${drug.name}: ${detail.dose_value} ${detail.dose_unit} is more than the formulary's single dose of ${drug.max_dose} ${drug.dose_unit}.`);
  }
  if (drug.authority === 'medical_control' && !/medical control/i.test(detail.authorised_by || '')) throw conflict(`${drug.name} is only given on medical control. Record who authorized it.`);
  if (drug.authority === 'assist_own' && !/own/i.test(detail.authorised_by || '')) throw conflict(`Patrol only helps with the patient's own ${drug.name}. Record it as the patient's own medication.`);
  // Who gave it: the named patroller, or the person recording it.
  const giver = data.performed_by_staff || data._recorder_staff;
  if (CERTS.indexOf(drug.min_cert) > CERTS.indexOf('none')) {
    const m = giver ? await one(conn, 'SELECT cert_level FROM patrol_members WHERE tenant_id = ? AND staff_id = ?', [t, giver]) : null;
    const level = m ? m.cert_level : 'none';
    if (CERTS.indexOf(level) < CERTS.indexOf(drug.min_cert)) throw conflict(`${drug.name} needs a ${CERT_LABEL[drug.min_cert]} or higher to give it. Record who gave it, or ask the lead.`);
  }
  const allergies = String(patient.allergies || '').trim();
  if (allergies && !NO_ALLERGY.test(allergies)) {
    if (!detail.allergy_checked) throw conflict(`Check the patient's allergies first: ${allergies}`);
    const first = norm(drug.name).split(/[\s-]/)[0];
    if (allergies.toLowerCase().includes(first) && !detail.allergy_override) throw conflict(`The patient is recorded as allergic to "${allergies}". Give a reason to go ahead, or do not give ${drug.name}.`);
  }
  if (/nitro/i.test(drug.name)) {
    if (!['no', 'yes'].includes(detail.pde5)) throw conflict('Ask about erectile dysfunction medication (Viagra, Cialis, Levitra) in the last 48 hours before nitroglycerin.');
    if (detail.pde5 === 'yes' && !detail.bp_override) throw conflict('Nitroglycerin is not given after erectile dysfunction medication in the last 48 hours.');
    const when = String(data.performed_at || '');
    const recent = latestVitals.filter((v) => v.bp_sys !== null && v.bp_sys !== undefined && !v.voided_at && (!when || String(v.taken_at) >= minus(when, 5)));
    const bp = recent[recent.length - 1];
    if (!bp && !detail.bp_override) throw conflict('Take a blood pressure (in the last 5 minutes) before nitroglycerin.');
    if (bp && Number(bp.bp_sys) < 100 && !detail.bp_override) throw conflict(`The last blood pressure was ${bp.bp_sys}/${bp.bp_dia ?? '?'}. Nitroglycerin is not given under 100.`);
  }
  let stock = null;
  if (detail.stock_id) {
    stock = await one(conn, 'SELECT * FROM patrol_med_stock WHERE tenant_id = ? AND id = ? AND active = 1 FOR UPDATE', [t, detail.stock_id]);
    if (!stock || Number(stock.formulary_id) !== drug.id) throw notFound('That lot of this medication');
    if (stock.expires_on && String(stock.expires_on).slice(0, 10) < String(data.performed_at || '').slice(0, 10)) throw conflict(`Lot ${stock.lot || stock.id} expired on ${String(stock.expires_on).slice(0, 10)}. Use another lot.`);
    if (Number(stock.quantity) < Number(detail.stock_amount || 1)) throw conflict(`Only ${Number(stock.quantity)} ${stock.unit} left in that lot.`);
  }
  return { drug, stock };
}
const minus = (dt, m) => new Date(Date.parse(`${String(dt).replace(' ', 'T')}Z`) - m * 60000).toISOString().slice(0, 19).replace('T', ' ');

/** Record the use of a lot on a case (inside the case's transaction). */
async function useStock(conn, req, stock, amount, incidentId, treatmentId, at) {
  await conn.query('UPDATE patrol_med_stock SET quantity = quantity - ? WHERE tenant_id = ? AND id = ?', [amount, req.auth.tenantId, stock.id]);
  await conn.query("INSERT INTO patrol_med_moves (tenant_id, stock_id, delta, reason, incident_id, treatment_id, by_user, at) VALUES (?, ?, ?, 'used', ?, ?, ?, ?)", [req.auth.tenantId, stock.id, -amount, incidentId, treatmentId, req.auth.userId, at]);
}

/** A medication entered in error puts its dose back in the lot it came from. */
async function returnStock(conn, req, treatment, at) {
  const move = await one(conn, "SELECT stock_id, delta FROM patrol_med_moves WHERE tenant_id = ? AND treatment_id = ? AND reason = 'used'", [req.auth.tenantId, treatment.id]);
  if (!move) return;
  await conn.query('UPDATE patrol_med_stock SET quantity = quantity - ? WHERE tenant_id = ? AND id = ?', [move.delta, req.auth.tenantId, move.stock_id]);
  await conn.query("INSERT INTO patrol_med_moves (tenant_id, stock_id, delta, reason, treatment_id, by_user, at, note) VALUES (?, ?, ?, 'adjust', ?, ?, ?, 'Entered in error on the case')", [req.auth.tenantId, move.stock_id, -move.delta, treatment.id, req.auth.userId, at]);
}

// ---------------------------------------------------------------- the medications page
router.get('/meds', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  const { today } = await OPS.clock(pool, t);
  const soon = OPS.addDays(today, 30);
  const [formulary, stock, moves, counts, equipment, settings] = await Promise.all([
    formularyOf(pool, t),
    rows(pool, 'SELECT k.*, f.name AS drug, f.controlled, st.name AS station FROM patrol_med_stock k JOIN patrol_formulary f ON f.tenant_id = k.tenant_id AND f.id = k.formulary_id LEFT JOIN patrol_stations st ON st.tenant_id = k.tenant_id AND st.id = k.station_id WHERE k.tenant_id = ? AND k.active = 1 ORDER BY f.name, k.expires_on', [t]),
    rows(pool, `SELECT m.*, f.name AS drug, k.lot, COALESCE(u.email, u.username) AS by_name FROM patrol_med_moves m JOIN patrol_med_stock k ON k.tenant_id = m.tenant_id AND k.id = m.stock_id JOIN patrol_formulary f ON f.tenant_id = k.tenant_id AND f.id = k.formulary_id
      LEFT JOIN users u ON u.tenant_id = m.tenant_id AND u.id = m.by_user WHERE m.tenant_id = ? ORDER BY m.at DESC, m.id DESC LIMIT 60`, [t]),
    rows(pool, `SELECT c.*, COALESCE(u.email, u.username) AS by_name, CONCAT(p.first_name, ' ', p.last_name) AS witness FROM patrol_med_counts c LEFT JOIN users u ON u.tenant_id = c.tenant_id AND u.id = c.by_user
      LEFT JOIN staff s ON s.tenant_id = c.tenant_id AND s.id = c.witness_staff LEFT JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE c.tenant_id = ? ORDER BY c.counted_at DESC LIMIT 20`, [t]),
    rows(pool, "SELECT e.id, e.name, e.kind, e.status, e.o2_size, e.o2_psi, e.pads_expire_on, e.battery_expire_on, e.expires_on, e.needs_download, st.name AS station FROM patrol_equipment e LEFT JOIN patrol_stations st ON st.tenant_id = e.tenant_id AND st.id = e.station_id WHERE e.tenant_id = ? AND e.status <> 'retired' AND e.kind IN ('oxygen', 'aed') ORDER BY e.kind, e.name", [t]),
    OPS.settingsOf(pool, t),
  ]);
  const d = (v) => (v ? String(v).slice(0, 10) : null);
  const flags = [];
  for (const k of stock) {
    if (d(k.expires_on) && d(k.expires_on) < today) flags.push({ level: 'bad', text: `${k.drug} lot ${k.lot || k.id} expired ${d(k.expires_on)}${k.station ? ` (${k.station})` : ''}` });
    else if (d(k.expires_on) && d(k.expires_on) <= soon) flags.push({ level: 'warn', text: `${k.drug} lot ${k.lot || k.id} expires ${d(k.expires_on)}${k.station ? ` (${k.station})` : ''}` });
    if (k.low_at !== null && Number(k.quantity) <= Number(k.low_at)) flags.push({ level: 'warn', text: `${k.drug} is low: ${Number(k.quantity)} ${k.unit} left${k.station ? ` at ${k.station}` : ''}` });
  }
  for (const e of equipment) {
    if (e.kind === 'oxygen' && e.o2_psi !== null && Number(e.o2_psi) < settings.o2_refill_psi) flags.push({ level: 'warn', text: `${e.name}: ${e.o2_psi} psi, refill` });
    if (e.kind === 'aed' && Number(e.needs_download)) flags.push({ level: 'bad', text: `${e.name} was used on a patient: download its data and fit new pads` });
    for (const [k, word] of [['pads_expire_on', 'pads'], ['battery_expire_on', 'battery']]) {
      if (d(e[k]) && d(e[k]) < today) flags.push({ level: 'bad', text: `${e.name}: ${word} expired ${d(e[k])}` });
      else if (d(e[k]) && d(e[k]) <= soon) flags.push({ level: 'warn', text: `${e.name}: ${word} expire ${d(e[k])}` });
    }
  }
  res.json({
    formulary, stock: stock.map((k) => ({ ...k, id: Number(k.id), quantity: Number(k.quantity), low_at: k.low_at === null ? null : Number(k.low_at), controlled: Boolean(k.controlled) })),
    moves, counts, equipment, flags, controlled_counts: settings.controlled_counts, o2_refill_psi: settings.o2_refill_psi,
    medical_director: settings.medical_director, protocol_version: settings.protocol_version,
    certs: CERTS.map((c) => [c, CERT_LABEL[c]]), units: UNITS, routes: ROUTES,
    can_edit: await PA.can(pool, req, 'manage_meds'),
  });
});

/** For the medication sheet on a case: the formulary and the lots in stock. */
router.get('/meds/for-case', patrol, async (req, res) => {
  const t = req.auth.tenantId;
  const [formulary, stock] = await Promise.all([
    formularyOf(pool, t),
    rows(pool, 'SELECT k.id, k.formulary_id, k.lot, k.expires_on, k.quantity, k.unit, st.name AS station FROM patrol_med_stock k LEFT JOIN patrol_stations st ON st.tenant_id = k.tenant_id AND st.id = k.station_id WHERE k.tenant_id = ? AND k.active = 1 AND k.quantity > 0 ORDER BY k.expires_on', [t]),
  ]);
  res.json({ formulary: formulary.filter((f) => f.active), stock: stock.map((k) => ({ ...k, id: Number(k.id), formulary_id: Number(k.formulary_id), quantity: Number(k.quantity) })), auth_text: AUTH_TEXT });
});

const drugFields = {
  name: z.string().trim().min(1).max(100), authority: z.enum(['standing_order', 'assist_own', 'medical_control']),
  routes: z.array(z.enum(ROUTES)).max(7).optional(), max_dose: z.number().min(0).max(100000).nullable().optional(), dose_unit: z.enum(UNITS).nullable().optional(),
  min_cert: z.enum(CERTS).optional(), controlled: z.boolean().optional(), active: z.boolean().optional(), notes: z.string().max(255).nullable().optional(),
};
const drugCols = (b) => {
  const out = {};
  for (const k of Object.keys(drugFields)) if (b[k] !== undefined) out[k] = k === 'routes' ? b[k].join(',') || null : typeof b[k] === 'boolean' ? Number(b[k]) : b[k];
  return out;
};

router.post('/meds/formulary', patrol, needs('manage_meds'), validate(z.object(drugFields)), async (req, res) => {
  const t = req.auth.tenantId;
  await formularyOf(pool, t);
  const c = drugCols(req.body);
  try {
    const [r] = await pool.query(`INSERT INTO patrol_formulary (tenant_id, ${Object.keys(c).join(', ')}) VALUES (?, ${Object.keys(c).map(() => '?').join(', ')})`, [t, ...Object.values(c)]);
    await audit(pool, req, 'create', 'patrol_formulary', r.insertId, req.body);
    res.status(201).json({ id: r.insertId });
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw conflict('That medication is already on the formulary'); throw e; }
});

router.patch('/meds/formulary/:id', patrol, needs('manage_meds'), validate(z.object(drugFields).partial()), async (req, res) => {
  const t = req.auth.tenantId; const c = drugCols(req.body);
  if (!Object.keys(c).length) throw bad('Nothing to change');
  const [r] = await pool.query(`UPDATE patrol_formulary SET ${Object.keys(c).map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...Object.values(c), t, paramId(req)]);
  if (!r.affectedRows) throw notFound('Medication');
  await audit(pool, req, 'update', 'patrol_formulary', paramId(req), req.body);
  res.json({ ok: true });
});

/** Stock received: a new lot at a station. */
router.post('/meds/stock', patrol, needs('manage_meds'), validate(z.object({
  formulary_id: z.number().int().positive(), station_id: z.number().int().positive().nullable().optional(), lot: z.string().trim().max(40).nullable().optional(),
  expires_on: dateStr.nullable().optional(), quantity: z.number().min(0).max(100000), unit: z.string().trim().min(1).max(20).default('doses'), low_at: z.number().min(0).max(100000).nullable().optional(),
})), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const id = await tx(async (conn) => {
    if (!(await one(conn, 'SELECT id FROM patrol_formulary WHERE tenant_id = ? AND id = ?', [t, b.formulary_id]))) throw notFound('Medication');
    if (b.station_id && !(await one(conn, 'SELECT id FROM patrol_stations WHERE tenant_id = ? AND id = ?', [t, b.station_id]))) throw notFound('Station');
    const { now } = await OPS.clock(conn, t);
    const [r] = await conn.query('INSERT INTO patrol_med_stock (tenant_id, formulary_id, station_id, lot, expires_on, quantity, unit, low_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [t, b.formulary_id, b.station_id || null, b.lot || null, b.expires_on || null, b.quantity, b.unit, b.low_at ?? null]);
    await conn.query("INSERT INTO patrol_med_moves (tenant_id, stock_id, delta, reason, by_user, at) VALUES (?, ?, ?, 'received', ?, ?)", [t, r.insertId, b.quantity, req.auth.userId, now]);
    await audit(conn, req, 'receive', 'patrol_med_stock', r.insertId, b);
    return r.insertId;
  });
  res.status(201).json({ id });
});

/**
 * Change a lot's quantity: wasted, expired (removed), an adjustment, or more received. Wasting a controlled drug needs a
 * witness on the roster who is not the person recording it.
 */
router.post('/meds/stock/:id/moves', patrol, needs('manage_meds'), validate(z.object({
  reason: z.enum(['received', 'wasted', 'expired', 'adjust']), delta: z.number().min(-100000).max(100000).refine((v) => v !== 0, 'Give an amount'),
  note: z.string().trim().max(255).nullable().optional(), witness_staff: z.number().int().positive().nullable().optional(),
})), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  await tx(async (conn) => {
    const k = await one(conn, 'SELECT k.*, f.controlled, f.name FROM patrol_med_stock k JOIN patrol_formulary f ON f.tenant_id = k.tenant_id AND f.id = k.formulary_id WHERE k.tenant_id = ? AND k.id = ? FOR UPDATE', [t, paramId(req)]);
    if (!k) throw notFound('Lot');
    const delta = ['wasted', 'expired'].includes(b.reason) ? -Math.abs(b.delta) : b.reason === 'received' ? Math.abs(b.delta) : b.delta;
    if (Number(k.quantity) + delta < 0) throw conflict(`Only ${Number(k.quantity)} ${k.unit} in this lot`);
    if (Number(k.controlled) && b.reason !== 'received') {
      if (!b.witness_staff) throw bad(`${k.name} is a controlled medication: name a witness`);
      if (Number(b.witness_staff) === Number(req.auth.staffId)) throw bad('The witness must be someone else');
      if (!(await one(conn, 'SELECT staff_id FROM patrol_members WHERE tenant_id = ? AND staff_id = ?', [t, b.witness_staff]))) throw notFound('Witness on the roster');
    }
    if (b.reason === 'adjust' && !b.note) throw bad('Say why the amount changed');
    const { now } = await OPS.clock(conn, t);
    await conn.query('UPDATE patrol_med_stock SET quantity = quantity + ?, active = IF(? = \'expired\' AND quantity + ? <= 0, 0, active) WHERE tenant_id = ? AND id = ?', [delta, b.reason, delta, t, k.id]);
    await conn.query('INSERT INTO patrol_med_moves (tenant_id, stock_id, delta, reason, by_user, witness_staff, at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [t, k.id, delta, b.reason, req.auth.userId, b.witness_staff || null, now, b.note || null]);
    await audit(conn, req, `stock_${b.reason}`, 'patrol_med_stock', k.id, { delta });
  });
  res.status(201).json({ ok: true });
});

router.patch('/meds/stock/:id', patrol, needs('manage_meds'), validate(z.object({ low_at: z.number().min(0).max(100000).nullable().optional(), active: z.boolean().optional(), station_id: z.number().int().positive().nullable().optional() })), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const cols = Object.keys(b).filter((k) => b[k] !== undefined);
  if (!cols.length) throw bad('Nothing to change');
  if (b.station_id && !(await one(pool, 'SELECT id FROM patrol_stations WHERE tenant_id = ? AND id = ?', [t, b.station_id]))) throw notFound('Station');
  const [r] = await pool.query(`UPDATE patrol_med_stock SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...cols.map((k) => (typeof b[k] === 'boolean' ? Number(b[k]) : b[k])), t, paramId(req)]);
  if (!r.affectedRows) throw notFound('Lot');
  res.json({ ok: true });
});

/**
 * A two-person count of controlled medications (at a change of shift). Each lot counted is set to the number found;
 * a difference is flagged and needs a note.
 */
router.post('/meds/counts', patrol, needs('manage_meds'), validate(z.object({
  witness_staff: z.number().int().positive(), lines: z.array(z.object({ stock_id: z.number().int().positive(), counted: z.number().min(0).max(100000) })).min(1).max(200),
  note: z.string().trim().max(500).nullable().optional(),
})), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  if (Number(b.witness_staff) === Number(req.auth.staffId)) throw bad('The witness must be someone else');
  const out = await tx(async (conn) => {
    if (!(await one(conn, 'SELECT staff_id FROM patrol_members WHERE tenant_id = ? AND staff_id = ?', [t, b.witness_staff]))) throw notFound('Witness on the roster');
    const { now } = await OPS.clock(conn, t);
    const lines = []; let off = false;
    for (const l of b.lines) {
      const k = await one(conn, 'SELECT id, quantity FROM patrol_med_stock WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, l.stock_id]);
      if (!k) throw notFound('Lot');
      const expected = Number(k.quantity);
      lines.push({ stock_id: l.stock_id, expected, counted: l.counted });
      if (expected !== l.counted) {
        off = true;
        await conn.query('UPDATE patrol_med_stock SET quantity = ? WHERE tenant_id = ? AND id = ?', [l.counted, t, k.id]);
        await conn.query("INSERT INTO patrol_med_moves (tenant_id, stock_id, delta, reason, by_user, witness_staff, at, note) VALUES (?, ?, ?, 'count', ?, ?, ?, ?)", [t, k.id, l.counted - expected, req.auth.userId, b.witness_staff, now, 'Count did not match']);
      }
    }
    if (off && !b.note) throw bad('The count does not match. Say what happened in the note.');
    const [r] = await conn.query('INSERT INTO patrol_med_counts (tenant_id, counted_at, by_user, witness_staff, count_lines, discrepancy, note) VALUES (?, ?, ?, ?, ?, ?, ?)', [t, now, req.auth.userId, b.witness_staff, JSON.stringify(lines), off ? 1 : 0, b.note || null]);
    await audit(conn, req, 'med_count', 'patrol_med_counts', r.insertId, { discrepancy: off });
    return { id: r.insertId, discrepancy: off };
  });
  res.status(201).json(out);
});

/** The daily job: equipment past its expiry date (or AED pads or battery) is flagged for attention. */
async function flagAll() {
  const list = await rows(pool, `SELECT e.id, e.tenant_id, t.timezone FROM patrol_equipment e JOIN tenants t ON t.id = e.tenant_id
    WHERE e.status = 'in_service' AND (e.expires_on IS NOT NULL OR e.pads_expire_on IS NOT NULL OR e.battery_expire_on IS NOT NULL)`);
  let n = 0;
  for (const e of list) {
    const today = require('../lib/util').todayIn(e.timezone);
    const [r] = await pool.query("UPDATE patrol_equipment SET status = 'needs_attention' WHERE id = ? AND status = 'in_service' AND (expires_on < ? OR pads_expire_on < ? OR battery_expire_on < ?)", [e.id, today, today, today]);
    if (r.affectedRows) {
      await pool.query("INSERT INTO equipment_checks (tenant_id, equipment_id, checked_by, result, notes) VALUES (?, ?, 0, 'needs_attention', 'Past its expiry date')", [e.tenant_id, e.id]);
      n += 1;
    }
  }
  return n;
}

module.exports = { router, checkMedication, useStock, returnStock, formularyOf, flagAll, CERTS, CERT_LABEL };
