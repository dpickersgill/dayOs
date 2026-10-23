'use strict';

// "Fill in from the story": the patroller speaks or types what happened, and Verdynt/OS proposes answers for the
// report's empty fields from it. Proposals only: nothing is saved until the patroller ticks the ones that are right,
// and those go through the normal patient update, audited like any edit.
//
// Guard rails:
//   - Off unless the server has PATROL_AI=on and ANTHROPIC_API_KEY (config.patrolAi) AND the mountain has turned it on.
//   - Only a fixed list of fields, only those still empty, and never a clinical decision (the spine decision, the
//     outcome, a clearance to ski) or anything that identifies the patient.
//   - Every proposal must quote the words in the story it came from, and the quote must really be in the story.
//     A select answer must be one of the field's own options. Anything else is dropped.
//   - Only the story and the field list are sent: no names, dates of birth, addresses or phone numbers.

const config = require('../config');
const { FIELDS } = require('./nsaar');
const { AppError } = require('./errors');

/** The fields the story may fill. Answers a patroller states in words, never decisions or identity. */
const FILLABLE = [
  'chief_complaint', 'allergies', 'medications', 'medical_history', 'drugs_alcohol', 'last_meal',
  'opqrst_onset', 'opqrst_provokes', 'opqrst_quality', 'opqrst_region', 'opqrst_severity', 'opqrst_time',
  'head_loc', 'head_loc_minutes', 'head_amnesia_before', 'head_amnesia_after', 'head_repeating', 'head_vomiting', 'head_vomit_count', 'head_headache', 'head_seizure', 'head_helmet_damage',
  'spine_mechanism', 'spine_midline', 'spine_neuro', 'spine_alert', 'spine_intox', 'spine_distracting',
  'activity', 'equipment', 'helmet', 'ability', 'lesson',
  'collided', 'collision_description', 'cause', 'cause_detail',
  'destination_type', 'hospital_name', 'handoff_to',
];
const FIELD = new Map(FIELDS.filter((f) => f.scope === 'patient' && FILLABLE.includes(f.key)).map((f) => [f.key, f]));

const available = () => Boolean(config.patrolAi && config.patrolAi.on);
const empty = (v) => v === undefined || v === null || (typeof v === 'string' && !v.trim());
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The current value of a field for a patient: a column for some (allergies, chief complaint), the form for the rest. */
function currentValue(f, p) {
  if (f.col) return p[f.col];
  return { ...(p.derived || {}), ...(p.form || {}) }[f.key];
}

function describeField(f) {
  const d = { key: f.key, label: f.label, type: f.type === 'select' ? 'choice' : f.type === 'number' ? 'number' : 'text' };
  if (f.options) d.options = f.options.map((o) => o.value);
  if (f.min !== undefined) d.min = f.min;
  if (f.max !== undefined) d.max = f.max;
  return d;
}

const SYSTEM = `You help a ski patroller complete a patient care report. You are given the patroller's own account of an incident and a list of report fields that are still empty.
Propose a value for a field ONLY when the account states it plainly. Do not infer, guess, diagnose or fill in what is merely likely.
For a choice field, the value must be exactly one of its options. For "no" answers, propose "no" only when the account says the patient denied it or did not have it.
For each proposal, quote the exact words from the account that support it (copy them character for character, at most 200 characters).
If there are several patients, use the patient label given to say which one each proposal is for. When unsure which patient a statement is about, skip it.
Propose nothing rather than something uncertain.`;

const TOOL = {
  name: 'propose_fields',
  description: 'Proposed values for empty report fields, each with the words from the account that support it.',
  input_schema: {
    type: 'object',
    properties: {
      proposals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            patient: { type: 'string', description: 'The patient label, for example "P1"' },
            field: { type: 'string' },
            value: { type: ['string', 'number'] },
            quote: { type: 'string' },
          },
          required: ['patient', 'field', 'value', 'quote'],
        },
      },
    },
    required: ['proposals'],
  },
};

/** Calls the model. Kept separate so tests can point ANTHROPIC_API_BASE at a stand-in. */
async function ask(story, patients) {
  const c = config.patrolAi;
  const body = {
    model: c.model,
    max_tokens: 2000,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: TOOL.name },
    messages: [{
      role: 'user',
      content: `Patroller's account:\n"""\n${story}\n"""\n\nPatients and their empty fields (JSON):\n${JSON.stringify(patients)}`,
    }],
  };
  let res;
  try {
    res = await fetch(`${c.apiBase}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': c.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
  } catch (_) { throw new AppError(502, 'The story reader could not be reached. Fill the fields in by hand, or try again.'); }
  if (!res.ok) throw new AppError(502, `The story reader is not available right now (${res.status}). Fill the fields in by hand, or try again.`);
  const data = await res.json();
  const use = (data.content || []).find((b) => b.type === 'tool_use' && b.name === TOOL.name);
  return use && use.input && Array.isArray(use.input.proposals) ? use.input.proposals : [];
}

/** Checks one raw proposal against the field and the story. Returns a clean value or null. */
function accept(raw, f, storyKey) {
  if (!raw || typeof raw.quote !== 'string' || !raw.quote.trim()) return null;
  const q = squash(raw.quote);
  if (q.length < 3 || !storyKey.includes(q)) return null; // the words must really be in the story
  let v = raw.value;
  if (f.type === 'select') {
    v = String(v).trim().toLowerCase();
    if (!f.options.some((o) => o.value === v)) return null;
  } else if (f.type === 'number') {
    v = Number(v);
    if (!Number.isFinite(v) || (f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) return null;
  } else {
    v = String(v).trim().slice(0, 255);
    if (!v) return null;
  }
  return v;
}

/**
 * Proposals for a case as loadCase returns it. Each: { patient_id, patient, field, label, section, col, value,
 * value_label, quote }. Throws a plain error when the story is empty or nothing is left to fill.
 */
async function propose(c) {
  const story = String(c.narrative || '').trim();
  if (story.length < 20) throw new AppError(400, 'Write or speak the story first, then fill in from it');
  const patients = (c.patients || []).filter((p) => !p.voided_at);
  if (!patients.length) throw new AppError(400, 'Add the patient first');
  const label = new Map(patients.map((p, i) => [`P${i + 1}`, p]));
  const asked = [...label].map(([key, p]) => ({
    patient: key,
    age: p.age_years ?? undefined,
    empty_fields: [...FIELD.values()].filter((f) => empty(currentValue(f, p))).map(describeField),
  })).filter((x) => x.empty_fields.length);
  if (!asked.length) return [];
  const raw = await ask(story, asked);
  const storyKey = squash(story);
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    const p = label.get(String(r && r.patient));
    const f = FIELD.get(String(r && r.field));
    if (!p || !f || !empty(currentValue(f, p))) continue;
    const key = `${p.id}:${f.key}`;
    if (seen.has(key)) continue;
    const v = accept(r, f, storyKey);
    if (v === null) continue;
    seen.add(key);
    const opt = f.options && f.options.find((o) => o.value === v);
    out.push({
      patient_id: p.id, patient: `${p.first_name || ''} ${p.last_name || ''}`.trim() || r.patient,
      field: f.key, label: f.label, section: f.section, col: f.col || null,
      value: v, value_label: opt ? opt.label : String(v), quote: String(r.quote).trim().slice(0, 200),
    });
  }
  return out;
}

module.exports = { available, propose, accept, FILLABLE };
