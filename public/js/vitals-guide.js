// Plain guides for reading vital signs at a glance. These are prompts for a patroller, not a diagnosis: the colour and the word
// ("High", "Low") only say "look again", and a number outside the band is never blocked from being saved.

/** [alert below, watch below, watch above, alert above] for each measurement, by age group. */
const BANDS = {
  adult: { pulse: [40, 50, 110, 130], resp: [8, 10, 24, 30], bp_sys: [80, 90, 180, 220], bp_dia: [40, 50, 110, 130], spo2: [90, 94, 101, 101], temp_c: [34, 35.5, 38, 39.5], glucose: [54, 70, 180, 300] },
  child: { pulse: [55, 65, 130, 150], resp: [10, 14, 30, 40], bp_sys: [65, 75, 125, 145], bp_dia: [30, 40, 85, 100], spo2: [90, 94, 101, 101], temp_c: [34, 35.5, 38, 39.5], glucose: [54, 70, 180, 300] },
};

export const ageGroup = (age) => (age !== null && age !== undefined && Number(age) < 12 ? 'child' : 'adult');

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
  if (v.gcs != null) parts.push(`GCS ${v.gcs}`);
  if (v.pain != null) parts.push(`pain ${v.pain}/10`);
  if (v.avpu) parts.push(v.avpu === 'alert' ? 'alert' : `AVPU ${v.avpu}`);
  if (v.temp_c != null) parts.push(`${v.temp_c} C`);
  if (v.glucose != null) parts.push(`glucose ${v.glucose}`);
  if (v.skin) parts.push(`skin ${v.skin}`);
  if (v.pupils) parts.push(`pupils ${v.pupils}`);
  return parts.join(', ');
}
