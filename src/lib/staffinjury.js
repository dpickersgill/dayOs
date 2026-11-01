'use strict';

// Staff injuries, first step. Patrol marks who the patient is: a guest, a staff member on duty, a staff member off duty,
// or a volunteer on duty. Then:
//   - On duty (staff or volunteer): not a guest injury. Left out of the injury network and guest stats, and never sent a
//     guest follow-up email.
//   - Off duty: an ordinary guest case (OSHA does not count injuries from voluntary recreation), but the owner is told.
//   - Every kind: the owners, and the people the owner named for the staff injury register, get an email straight away,
//     and a text if texting is set up and they have a phone number. Nobody else (the register is private). Subjects and
//     texts never carry the name; a privacy case is never named anywhere. A volunteer is flagged: whether they count as
//     staff depends on the state and the insurer.
//   - A notice is marked sent only once an email went out. If none could be sent it is tried again on the next save and
//     by the 5-minute and daily jobs (retryDue), for 7 days.
//   - If the patient goes to hospital, or the case is critical, a second notice gives OSHA's deadlines.
// The notice says who, when and where, and how they left. It never carries the injury or any treatment.
const { pool, rows, one } = require('../db');
const mailer = require('./mailer');
const sms = require('./sms');
const { isSandbox } = require('./sandbox');
const { logFailure } = require('./jobs');

const KINDS = {
  staff_work: { label: 'Staff member, on duty', onDuty: true },
  volunteer_work: { label: 'Volunteer, on duty', onDuty: true, volunteer: true },
  staff_off: { label: 'Staff member, off duty', onDuty: false },
};
const HOSPITAL = ['transported_ambulance', 'transported_private'];
const OSHA = 'OSHA: a death must be reported within 8 hours; an in-patient hospital admission, an amputation or the loss of an eye within 24 hours. Call 1-800-321-6742 or report at osha.gov/report. Being seen in the emergency room and sent home does not count as an admission.';

const parse = (f) => { if (!f) return {}; if (typeof f === 'object') return f; try { return JSON.parse(f) || {}; } catch (_) { return {}; } };

/** 'staff_work' | 'volunteer_work' | 'staff_off' | null for one patient row ({ form, activity }). */
function kindOf(p) {
  const t = parse(p.form).patient_type;
  if (KINDS[t]) return t;
  return p.activity === 'staff' ? 'staff_work' : null;
}
const onDuty = (p) => Boolean(KINDS[kindOf(p)] && KINDS[kindOf(p)].onDuty);

/** SQL that is true for a patient row aliased `p` who is NOT staff or a volunteer working (for guest-only figures). */
const GUEST_SQL = "(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(p.form, '$.patient_type')), '') NOT IN ('staff_work','volunteer_work') AND COALESCE(p.activity, '') <> 'staff')";

function message(tenant, inc, p, kind, serious, link, { privacy = false } = {}) {
  const k = KINDS[kind];
  const name = privacy ? 'A staff member (a privacy case, so not named)' : (`${p.first_name} ${p.last_name}`.trim() || 'A patient');
  const caseNo = inc.case_number || inc.id;
  const when = String(inc.occurred_at).slice(0, 16).replace('T', ' ');
  const outcome = { treated_released: 'treated and released', transported_ambulance: 'taken to hospital by ambulance', transported_private: 'taken to hospital by private vehicle', refused_care: 'refused care', no_injury: 'no injury found', referred: 'referred to a doctor', other: 'other' }[p.disposition] || 'not recorded yet';
  const lines = [
    `${name} was seen by ski patrol and marked as: ${k.label}.`,
    '',
    `Case ${inc.case_number || inc.id}, ${when}, ${inc.location || 'location not recorded'}.`,
    `Outcome so far: ${outcome}.`,
  ];
  if (k.volunteer) lines.push('', 'This is a volunteer. Whether a volunteer counts as staff for workers\' comp and the OSHA log depends on your state and your insurer. If you are not sure, ask your insurer.');
  if (kind === 'staff_off') lines.push('', 'Off duty, so it stays a guest case: injuries during voluntary recreation are not work-related for OSHA. No action is needed unless you know otherwise.');
  if (k.onDuty) {
    lines.push('', 'What to do now: tell your workers\' comp insurer. Most states set a deadline of a few days, and some much less.');
    lines.push('', serious ? `This patient went to hospital or the case is critical. ${OSHA}` : `If this becomes serious: ${OSHA}`);
  }
  if (k.onDuty) lines.push('', 'It is in your staff injury register (Staff and schedule, Injuries), ready for the OSHA log details.');
  lines.push('', `The case: ${link}`, '', 'This note has no injury or treatment details. Open the case to see them.');
  // No name and no "went to hospital" in a subject or a text: both show on lock screens and in inbox lists.
  const subject = serious && k.onDuty ? `Staff injury, case ${caseNo}: check OSHA's deadline` : `Staff injury, case ${caseNo} (${k.label.toLowerCase()})`;
  return { subject, text: lines.join('\n'), sms: `${tenant.name}: patrol saw a ${k.label.toLowerCase()}, case ${caseNo}.${serious && k.onDuty ? ' Check OSHA\'s deadline today.' : ''} Details in email.` };
}

/**
 * Sends whatever notices are now due for one patient, at most once each: the first notice when they are marked staff,
 * and the hospital notice when they go to hospital (on duty only). Safe to call after every change. Never throws.
 */
async function notifyIfDue(tenantId, incidentId, patientId, base) {
  try {
    const p = await one(pool, `SELECT p.id, p.person_id, p.first_name, p.last_name, p.form, p.activity, p.disposition, p.voided_at, p.staff_noted_at, p.staff_serious_noted_at
      FROM incident_patients p WHERE p.tenant_id = ? AND p.incident_id = ? AND p.id = ?`, [tenantId, incidentId, patientId]);
    if (!p || p.voided_at) return { sent: 0 };
    const kind = kindOf(p);
    if (!kind) return { sent: 0 };
    // On duty: a record in the owner's staff injury register (Staff and schedule, Injuries), made once.
    if (KINDS[kind].onDuty) await require('./injuryregister').fromPatrol(tenantId, incidentId, p, kind);
    const row = await one(pool, 'SELECT id, season, seq, occurred_at, location, severity FROM incidents WHERE tenant_id = ? AND id = ?', [tenantId, incidentId]);
    const inc = { ...row, case_number: row.seq ? `${row.season}-${String(row.seq).padStart(4, '0')}` : null };
    const serious = HOSPITAL.includes(p.disposition) || inc.severity === 'critical';
    const first = !p.staff_noted_at;
    const escalate = KINDS[kind].onDuty && serious && !p.staff_serious_noted_at;
    if (!first && !escalate) return { sent: 0 };
    // Claim the notice before sending, so two quick saves cannot send it twice. The claim is a unique mark; it is given
    // back if no email could be sent, so the notice is tried again (next save, or retryDue from the jobs).
    const col = first ? 'staff_noted_at' : 'staff_serious_noted_at';
    const both = first && escalate;
    const mark = new Date(Date.now() - (Date.now() % 1000)).toISOString().slice(0, 19).replace('T', ' ');
    const [claim] = await pool.query(`UPDATE incident_patients SET ${col} = ?${both ? ', staff_serious_noted_at = ?' : ''} WHERE tenant_id = ? AND id = ? AND ${col} IS NULL`, [mark, ...(both ? [mark] : []), tenantId, patientId]);
    if (!claim.affectedRows) return { sent: 0 };
    if (await isSandbox(tenantId)) return { sent: 0 };
    let sent = 0;
    try {
      const tenant = await one(pool, 'SELECT id, name FROM tenants WHERE id = ?', [tenantId]);
      const reg = await one(pool, 'SELECT privacy_case FROM staff_injuries WHERE tenant_id = ? AND patient_id = ?', [tenantId, patientId]);
      const m = message(tenant, inc, p, kind, serious, `${base}/#/patrol/case/${incidentId}`, { privacy: Boolean(reg && Number(reg.privacy_case)) });
      // The owners and the people the owner named for the register: nobody else hears about a staff injury.
      const to = await rows(pool, `SELECT u.email, pe.phone FROM users u LEFT JOIN people pe ON pe.tenant_id = u.tenant_id AND pe.id = u.person_id
        WHERE u.tenant_id = ? AND u.active = 1 AND (u.role = 'owner' OR u.id IN (SELECT a.user_id FROM staff_injury_access a WHERE a.tenant_id = u.tenant_id))`, [tenantId]);
      for (const u of to) {
        if (u.email && (await mailer.send({ tenantId, to: u.email, subject: m.subject, text: m.text, tag: 'staff-injury' })).ok) sent += 1;
        if (u.phone && KINDS[kind].onDuty) await sms.send({ tenantId, to: u.phone, body: m.sms });
      }
    } finally {
      // Given back only when email is set up but nothing went out (with no email set up there is nothing to retry).
      if (!sent && mailer.enabled()) {
        await pool.query(`UPDATE incident_patients SET ${col} = NULL${both ? ', staff_serious_noted_at = NULL' : ''} WHERE tenant_id = ? AND id = ? AND ${col} = ?`, [tenantId, patientId, mark]);
        logFailure({ job: 'staff_injury_notice', tenant: tenantId, message: 'no email could be sent; it will be tried again' });
      }
    }
    return { sent };
  } catch (e) {
    logFailure({ job: 'staff_injury_notice', tenant: tenantId, message: e.message });
    return { sent: 0 };
  }
}

/**
 * Notices not sent yet (a failed send gives its claim back): tried again for patients marked staff or a volunteer in the
 * last 7 days. Runs from the 5-minute and daily jobs.
 */
async function retryDue(base) {
  const due = await rows(pool, `SELECT p.tenant_id, p.incident_id, p.id FROM incident_patients p JOIN incidents i ON i.tenant_id = p.tenant_id AND i.id = p.incident_id
    WHERE p.voided_at IS NULL AND i.occurred_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 8 DAY)
      AND (COALESCE(JSON_UNQUOTE(JSON_EXTRACT(p.form, '$.patient_type')), '') IN ('staff_work','volunteer_work','staff_off') OR p.activity = 'staff')
      AND (p.staff_noted_at IS NULL OR (p.staff_serious_noted_at IS NULL AND (p.disposition IN (?) OR i.severity = 'critical')))
    ORDER BY p.id LIMIT 200`, [HOSPITAL]);
  let sent = 0;
  for (const d of due) sent += (await notifyIfDue(Number(d.tenant_id), Number(d.incident_id), Number(d.id), base)).sent;
  return { due: due.length, sent };
}

module.exports = { KINDS, kindOf, onDuty, GUEST_SQL, message, notifyIfDue, retryDue };
