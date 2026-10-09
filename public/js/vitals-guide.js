// Plain guides for reading vital signs at a glance. These are prompts for a patroller, not a diagnosis: the colour and the word
// ("High", "Low") only say "look again", and a number outside the band is never blocked from being saved.

/**
 * [alert below, watch below, watch above, alert above] for each measurement, by age group. Children's bands follow the
 * usual paediatric normal ranges: a heart rate of 150 is fine for a baby and worrying for a ten-year-old.
 */
const COMMON = { spo2: [90, 94, 101, 101], temp_c: [34, 35.5, 38, 39.5], glucose: [54, 70, 180, 300] };
const BANDS = {
  infant: { pulse: [80, 100, 160, 180], resp: [20, 30, 60, 70], bp_sys: [60, 70, 110, 130], bp_dia: [30, 35, 70, 85], ...COMMON },
  toddler: { pulse: [70, 90, 150, 170], resp: [16, 24, 40, 50], bp_sys: [70, 80, 115, 130], bp_dia: [35, 45, 75, 90], ...COMMON },
  preschool: { pulse: [65, 80, 140, 160], resp: [14, 22, 34, 44], bp_sys: [75, 80, 120, 135], bp_dia: [35, 45, 80, 95], ...COMMON },
  school: { pulse: [55, 70, 120, 140], resp: [12, 18, 30, 36], bp_sys: [75, 85, 125, 145], bp_dia: [35, 45, 85, 100], ...COMMON },
  adult: { pulse: [40, 50, 110, 130], resp: [8, 10, 24, 30], bp_sys: [80, 90, 180, 220], bp_dia: [40, 50, 110, 130], ...COMMON },
};
export const GROUP_LABEL = { infant: 'a baby under 1', toddler: 'a toddler (1 to 3)', preschool: 'a young child (4 to 5)', school: 'a school-age child (6 to 11)', adult: 'an adult or teenager' };

export function ageGroup(age) {
  if (age === null || age === undefined || age === '' || Number.isNaN(Number(age))) return 'adult';
  const a = Number(age);
  if (a < 1) return 'infant';
  if (a < 4) return 'toddler';
  if (a < 6) return 'preschool';
  if (a < 12) return 'school';
  return 'adult';
}

/** { level: 'ok' | 'watch' | 'alert', word: 'High' | 'Low' | '' } for one measurement. */
export function flag(key, value, age) {
  if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) return { level: 'none', word: '' };
  const v = Number(value);
  if (key === 'gcs') return v <= 12 ? { level: 'alert', word: 'Low' } : v < 15 ? { level: 'watch', word: 'Low' } : { level: 'ok', word: '' };
  if (key === 'pain') return v >= 9 ? { level: 'alert', word: 'Severe' } : v >= 7 ? { level: 'watch', word: 'High' } : { level: 'ok', word: '' };
  const b = (BANDS[ageGroup(age)] || BANDS.adult)[key];
  if (!b) return { level: 'ok', word: '' };
  if (v < b[0]) return { level: 'alert', word: 'Low' };
  if (v > b[3]) return { level: 'alert', word: 'High' };
  if (v < b[1]) return { level: 'watch', word: 'Low' };
  if (v > b[2]) return { level: 'watch', word: 'High' };
  return { level: 'ok', word: '' };
}

export function flagAvpu(avpu) {
  if (!avpu) return { level: 'none', word: '' };
  if (avpu === 'alert') return { level: 'ok', word: '' };
  return avpu === 'verbal' ? { level: 'watch', word: 'Check' } : { level: 'alert', word: 'Check' };
}

/** 'up', 'down' or 'same' against the set before it, or null when there is nothing to compare. */
export function trend(prev, cur) {
  if (prev === null || prev === undefined || cur === null || cur === undefined) return null;
  const d = Number(cur) - Number(prev);
  return d === 0 ? 'same' : d > 0 ? 'up' : 'down';
}
export const ARROW = { up: '▲', down: '▼', same: '–' };
export const ARROW_WORD = { up: 'up from last set', down: 'down from last set', same: 'same as last set' };

/** The measurements shown on the bedside strip, in the order a patroller reads them. */
export const STRIP = [
  { key: 'pulse', label: 'Pulse' }, { key: 'resp', label: 'Resp' }, { key: 'bp', label: 'BP' },
  { key: 'spo2', label: 'SpO₂' }, { key: 'pain', label: 'Pain' }, { key: 'gcs', label: 'GCS' },
];

/** One line for a set of vitals, for the text hand-off: "P 104, R 20, BP 132/84, SpO2 97%, GCS 15, pain 8/10, alert". */
export function vitalsLine(v) {
  const parts = [];
  if (v.pulse != null) parts.push(`P ${v.pulse}`);
  if (v.resp != null) parts.push(`R ${v.resp}`);
  if (v.bp_sys != null) parts.push(`BP ${v.bp_sys}/${v.bp_dia ?? '?'}`);
  if (v.spo2 != null) parts.push(`SpO2 ${v.spo2}%`);
  if (v.gcs != null) parts.push(v.gcs_e ? `GCS ${v.gcs} (E${v.gcs_e} V${v.gcs_v} M${v.gcs_m})` : `GCS ${v.gcs}`);
  if (v.pain != null) parts.push(`pain ${v.pain}/10`);
  if (v.avpu) parts.push(v.avpu === 'alert' ? 'alert' : `AVPU ${v.avpu}`);
  if (v.temp_c != null) parts.push(`${v.temp_c} C`);
  if (v.glucose != null) parts.push(`glucose ${v.glucose}`);
  if (v.skin) parts.push(`skin ${v.skin}`);
  if (v.pupil_left || v.pupil_right) parts.push(`pupils L ${v.pupil_left || '?'} R ${v.pupil_right || '?'}`);
  else if (v.pupils) parts.push(`pupils ${v.pupils}`);
  return parts.join(', ');
}
