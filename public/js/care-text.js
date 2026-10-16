// Patient care in words: one place that turns the stored entries into the short phrases the bedside card, the hand-off
// sheet and the draft narrative all use, so the three always say the same thing.

import { fmtTime, label } from './ui.js';

const CMS_WORD = { present: 'ok', absent: 'absent', not_checked: 'not checked' };
export const O2_DEVICES = [['nasal_cannula', 'Nasal cannula'], ['mask', 'Mask'], ['non_rebreather', 'Non-rebreather'], ['bvm', 'Bag-valve mask'], ['other', 'Other']];
const O2 = Object.fromEntries(O2_DEVICES.map(([k, v]) => [k, v.toLowerCase()]));
export const ARREST_ACTIONS = { start: 'CPR started', stop: 'CPR stopped', pads_on: 'Pads on', shock: 'Shock delivered', no_shock: 'No shock advised', rhythm_check: 'Rhythm check' };

export const live = (list) => (list || []).filter((x) => !x.voided_at);
/** The clock time of a stamp typed on this phone ('YYYY-MM-DDTHH:MM[:SS]'), as the rest of the page shows times. */
export const atTime = (s) => fmtTime(`${String(s).replace('T', ' ').slice(0, 16)}:00`);

export function cmsText(c) {
  if (!c) return null;
  return `C ${CMS_WORD[c.c] || '?'}, M ${CMS_WORD[c.m] || '?'}, S ${CMS_WORD[c.s] || '?'}`;
}
/** True when something present before splinting is absent after it (a loss that was there before is not new). */
export const cmsLost = (after, before) => Boolean(after && ['c', 'm', 's'].some((k) => after[k] === 'absent' && !(before && before[k] === 'absent')));

export const LIMB = { left_arm: 'left arm', right_arm: 'right arm', left_leg: 'left leg', right_leg: 'right leg', junctional: 'junctional' };

/** The name of a treatment as a patroller says it. */
export function treatmentName(t) {
  if (t.kind === 'rosc') return 'Pulse returned';
  if (t.kind === 'aed') return 'AED';
  if (t.kind === 'cpr') return 'CPR';
  if (t.kind === 'spinal_motion_restriction') return 'Spinal motion restriction';
  return label(t.kind);
}

/** The detail after the name: "Ibuprofen 400 mg oral, for knee pain", "15 L/min by non-rebreather", "CMS before C ok…". */
export function treatmentDetail(t) {
  const d = t.detail || {};
  const bits = [];
  if (t.kind === 'medication') bits.push(`${t.medication} ${t.dose}${t.route ? ` ${t.route}` : ''}`);
  if (t.kind === 'oxygen' && (d.o2_lpm != null || d.o2_device)) bits.push([d.o2_lpm != null ? `${d.o2_lpm} L/min` : null, d.o2_device ? O2[d.o2_device] : null].filter(Boolean).join(' by '));
  if (d.action && t.kind === 'aed') bits.push(ARREST_ACTIONS[d.action].toLowerCase());
  if (d.action && t.kind === 'cpr') bits.push(d.action === 'start' ? 'started' : d.action === 'stop' ? 'stopped' : ARREST_ACTIONS[d.action].toLowerCase());
  if (d.joules) bits.push(`${d.joules} J`);
  if (d.limb) bits.push(LIMB[d.limb] || d.limb);
  if (d.lot) bits.push(`lot ${d.lot}`);
  if (d.body_part) bits.push(d.body_part);
  if (d.cms_before || d.cms_after) bits.push(`CMS before ${cmsText(d.cms_before) || 'not recorded'}; after ${cmsText(d.cms_after) || 'not recorded'}`);
  if (d.indication) bits.push(`for ${d.indication}`);
  if (d.authorised_by) bits.push(`authorised by ${d.authorised_by}`);
  if (t.description) bits.push(t.description);
  return bits.join('; ');
}

export function treatmentLine(t) {
  const d = treatmentDetail(t);
  const effect = t.detail && t.detail.effect ? `. Effect: ${t.detail.effect}` : '';
  return `${fmtTime(t.performed_at)} ${treatmentName(t)}${d ? ` (${d})` : ''}${effect}`;
}

/** "GCS 14 (E4 V4 M6)" or "GCS 14". */
export function gcsText(v) {
  if (v.gcs == null) return '';
  return v.gcs_e ? `GCS ${v.gcs} (E${v.gcs_e} V${v.gcs_v} M${v.gcs_m})` : `GCS ${v.gcs}`;
}

const PUPIL = { normal: 'normal', dilated: 'dilated', small: 'small', sluggish: 'sluggish', fixed: 'no reaction' };
export const PUPIL_CHOICES = [['normal', 'Normal'], ['dilated', 'Dilated'], ['small', 'Small'], ['sluggish', 'Sluggish'], ['fixed', 'No reaction']];
export function pupilsText(v) {
  if (v.pupil_left || v.pupil_right) {
    if (v.pupil_left === 'normal' && v.pupil_right === 'normal') return 'Pupils equal and reactive';
    return `Pupils L ${PUPIL[v.pupil_left] || 'not checked'}, R ${PUPIL[v.pupil_right] || 'not checked'}`;
  }
  return v.pupils ? `Pupils ${v.pupils}` : '';
}

// ---- units. Stored metric; shown in the unit this phone prefers, with the other one beside it where it matters.
const PREF = 'so.tempUnit';
export function tempUnit() { try { return globalThis.localStorage.getItem(PREF) === 'F' ? 'F' : 'C'; } catch (_) { return 'C'; } }
export function setTempUnit(u) { try { globalThis.localStorage.setItem(PREF, u === 'F' ? 'F' : 'C'); } catch (_) { /* a preference only */ } }
export const cToF = (c) => Math.round((Number(c) * 9 / 5 + 32) * 10) / 10;
export const fToC = (f) => Math.round(((Number(f) - 32) * 5 / 9) * 10) / 10;
export function tempText(c, both = false) {
  if (c == null) return '';
  const f = cToF(c);
  if (tempUnit() === 'F') return both ? `${f} °F (${Number(c)} °C)` : `${f} °F`;
  return both ? `${Number(c)} °C (${f} °F)` : `${Number(c)} °C`;
}

/** A height or weight: stored as { v, u } (new) or as typed text (older reports). */
export function measureText(m) {
  if (m == null || m === '') return '';
  if (typeof m !== 'object') return String(m);
  const v = Number(m.v);
  const other = { kg: [v * 2.20462, 'lb'], lb: [v / 2.20462, 'kg'], cm: [v / 2.54, 'in'], in: [v * 2.54, 'cm'] }[m.u];
  return other ? `${v} ${m.u} (${Math.round(other[0])} ${other[1]})` : `${v} ${m.u}`;
}

/** Minutes between two mountain-clock timestamps ('YYYY-MM-DD HH:MM[:SS]' or with a T). */
export function minutesBetween(a, b) {
  const t = (s) => { const x = String(s).replace('T', ' '); return Date.UTC(+x.slice(0, 4), +x.slice(5, 7) - 1, +x.slice(8, 10), +x.slice(11, 13), +x.slice(14, 16)); };
  return Math.round((t(b) - t(a)) / 60000);
}
/** An entry typed in more than 15 minutes after (or before) the time it records: "Entered 14:32". */
export function lateNote(row, timeKey) {
  if (!row.entered_at || !row[timeKey]) return null;
  return Math.abs(minutesBetween(row[timeKey], row.entered_at)) > 15 ? `Entered ${fmtTime(row.entered_at)}` : null;
}

export function vitalsWords(v) {
  return [v.avpu && label(v.avpu), gcsText(v), v.skin && `Skin ${v.skin.toLowerCase()}`, pupilsText(v), v.temp_c != null && tempText(v.temp_c), v.glucose != null && `Glucose ${v.glucose}`, v.notes].filter(Boolean);
}
