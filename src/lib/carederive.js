'use strict';

// "Enter once": the NSAAR form answers that can be worked out from what was logged at the bedside. The case page shows
// them in the form as already filled in (the patroller can change any of them), the submit check counts them as answered,
// and submitting copies them into the blanks so the stored report stands on its own.

const hhmm = (t) => (t ? String(t).slice(11, 16) : null);
const live = (list) => (list || []).filter((x) => !x.voided_at);
const word = (k) => String(k).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Where a bedside injury sits on the NSAAR body map. Regions that do not map to one box (back, abdomen, "multiple") are left for the patroller. */
const BODY = { head: 'head', face: 'face', neck: 'neck', shoulder: 'shoulder', arm: 'upper_arm', elbow: 'elbow', wrist_hand: 'wrist', chest: 'chest', hip: 'hip', thigh: 'thigh', knee: 'knee', lower_leg: 'lower_leg', ankle_foot: 'ankle' };
const PLAIN = new Set(['head', 'face']);
const SIDE = { left: 'L', right: 'R', both: 'B', midline: 'B' };

function bodyMap(injuries) {
  const map = {};
  for (const i of live(injuries)) {
    if (['illness', 'cardiac'].includes(i.injury_type)) { map.medical = 'X'; continue; }
    const part = BODY[i.body_region];
    if (!part) continue;
    if (PLAIN.has(part)) { map[part] = 'X'; continue; }
    const s = SIDE[i.side];
    if (!s) continue;
    map[part] = map[part] && map[part] !== s ? 'B' : s;
  }
  return map;
}

const parseDetail = (d) => { if (!d) return {}; if (typeof d === 'object') return d; try { return JSON.parse(d); } catch (_) { return {}; } };
const CMS_WORD = { present: 'ok', absent: 'absent', not_checked: 'not checked' };
const cmsText = (c) => (c ? `C ${CMS_WORD[c.c] || '?'}, M ${CMS_WORD[c.m] || '?'}, S ${CMS_WORD[c.s] || '?'}` : null);
const O2 = { nasal_cannula: 'nasal cannula', mask: 'mask', non_rebreather: 'non-rebreather', bvm: 'bag-valve mask', other: 'other device' };
const ACTION = { start: 'started', stop: 'stopped', pads_on: 'pads on', shock: 'shock delivered', no_shock: 'no shock advised', rhythm_check: 'rhythm check' };

/** One treatment in words: "13:05 Splint (CMS before C ok, M ok, S ok; after C ok, M ok, S ok)". */
function treatmentText(t) {
  const d = parseDetail(t.detail);
  const bits = [];
  if (t.kind === 'medication') bits.push(`${t.medication} ${t.dose}${t.route ? ` ${t.route}` : ''}`);
  if (t.kind === 'oxygen' && (d.o2_lpm != null || d.o2_device)) bits.push([d.o2_lpm != null ? `${d.o2_lpm} L/min` : null, d.o2_device ? O2[d.o2_device] : null].filter(Boolean).join(' by '));
  if (d.action) bits.push(ACTION[d.action] || d.action);
  if (d.joules) bits.push(`${d.joules} J`);
  if (d.body_part) bits.push(d.body_part);
  if (d.cms_before || d.cms_after) bits.push(`CMS before ${cmsText(d.cms_before) || 'not recorded'}; after ${cmsText(d.cms_after) || 'not recorded'}`);
  if (d.indication) bits.push(`for ${d.indication}`);
  if (d.effect) bits.push(`effect: ${d.effect}`);
  if (t.description) bits.push(t.description);
  const name = t.kind === 'rosc' ? 'Pulse returned' : t.kind === 'aed' ? 'AED' : t.kind === 'cpr' ? 'CPR' : word(t.kind);
  return `${hhmm(t.performed_at)} ${name}${bits.length ? ` (${bits.join('; ')})` : ''}`;
}

/**
 * Derived NSAAR patient answers. `c` is the case as the API returns it (events, responders), `p` one patient with
 * injuries, treatments and vitals. Only answers that can be worked out are returned.
 */
function derive(c, p) {
  const out = {};
  const ev = live(c.events);
  const first = (...kinds) => { for (const k of kinds) { const e = ev.find((x) => x.kind === k); if (e) return e; } return null; };
  const scene = first('on_scene', 'patient_contact');
  const transport = first('transport_started');
  const aid = first('at_aid_room');
  const handoff = first('handoff');
  const out_ = handoff || first('cleared');
  if (scene) out.scene_on = hhmm(scene.at);
  if (transport) out.scene_transported = hhmm(transport.at);
  if (aid) out.base_in = hhmm(aid.at);
  if (aid && out_ && String(out_.at) >= String(aid.at)) out.base_out = hhmm(out_.at);
  if (handoff) out.handoff_time = hhmm(handoff.at);
  const f = p.form || {};
  if (f.handoff_time) out.handoff_time = f.handoff_time;

  const tr = live(p.treatments);
  const atBase = (t) => aid && String(t.performed_at) >= String(aid.at);
  const sceneList = tr.filter((t) => !atBase(t)).map(treatmentText);
  const baseList = tr.filter(atBase).map(treatmentText);
  if (sceneList.length) out.fa_scene = sceneList.join('\n');
  if (baseList.length) out.fa_base = baseList.join('\n');
  if (live(p.vitals).length) out.fa_attached = true;

  const meds = tr.filter((t) => t.kind === 'medication');
  if (meds.length) {
    out.medication_text = meds.map((t) => `${t.medication} ${t.dose}${t.route ? ` ${t.route}` : ''}`).join('; ');
    out.medication_time = hhmm(meds[0].performed_at);
    const by = [...new Set(meds.map((t) => t.performed_by_name).filter(Boolean))];
    if (by.length) out.medication_by = by.join(', ');
  }
  const map = bodyMap(p.injuries);
  if (Object.keys(map).length) out.body_parts = map;
  return out;
}

module.exports = { derive, treatmentText, bodyMap, parseDetail, cmsText };
