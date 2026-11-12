'use strict';

// Check steps that ask for more than pass or fail: a number (extinguisher pressure, an oxygen cylinder's psi, a battery's
// volts) with an allowed range, or a date (AED pads, a first-aid kit) with a rule such as "fails within 30 days of
// expiry". An answer outside the rule fails by itself, with the reason written for the person who fixes it, so nothing
// slips through on a busy morning. Used by the mountain's own checklists (Assets) and anything else built the same way.
const { z } = require('./util');

const KEY = z.string().regex(/^[a-z0-9_]{1,30}$/);
const OPTION = z.string().trim().min(1).max(60);
/**
 * One step of a checklist as a manager sets it up. Old checklists have only key and label: those are pass/fail.
 *   pass       pass, fail or not applicable
 *   number     a reading, with a unit and an allowed range (outside it fails by itself); run_hours marks a pump's hour meter
 *   date       a date that fails once passed, or within so many days of it
 *   choice     one of a list (options); an answer in fail_options fails by itself
 *   text       a few words, written down
 *   yesno      yes or no; fail_on 'yes' or 'no' fails by itself on that answer
 *   condition  a condition score, 1 (new) to 5 (failed); fail_at fails by itself at that score or worse
 * Any step can need a photo (photo: true): it is answered only with a photo taken for it. A step with stops_use takes the
 * asset out of service when it fails (2026.11.20: a truck's brakes, steering, lights or tires), not just to needs service.
 */
const stepSchema = z.object({
  key: KEY,
  label: z.string().trim().min(1).max(150),
  type: z.enum(['pass', 'number', 'date', 'choice', 'text', 'yesno', 'condition']).default('pass'),
  unit: z.string().trim().max(20).nullable().optional(),
  min: z.number().min(-1e9).max(1e9).nullable().optional(),
  max: z.number().min(-1e9).max(1e9).nullable().optional(),
  within_days: z.number().int().min(0).max(3650).nullable().optional(),
  options: z.array(OPTION).max(12).nullable().optional(),
  fail_options: z.array(OPTION).max(12).nullable().optional(),
  fail_on: z.enum(['yes', 'no']).nullable().optional(),
  fail_at: z.number().int().min(1).max(5).nullable().optional(),
  photo: z.boolean().optional(),
  run_hours: z.boolean().optional(),
  stops_use: z.boolean().optional(), // a failure takes the asset out of service (a vehicle's brakes, steering, lights, tires)
}).superRefine((s, ctx) => {
  if (s.type === 'number' && s.min != null && s.max != null && s.min > s.max) ctx.addIssue({ code: 'custom', message: `${s.label}: the lowest allowed reading is above the highest` });
  if (s.type === 'choice') {
    const opts = s.options || [];
    if (opts.length < 2) ctx.addIssue({ code: 'custom', message: `${s.label}: give at least two choices` });
    if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) ctx.addIssue({ code: 'custom', message: `${s.label}: each choice can be listed once` });
    for (const f of s.fail_options || []) if (!opts.includes(f)) ctx.addIssue({ code: 'custom', message: `${s.label}: "${f}" fails, but it is not one of the choices` });
  }
  if (s.run_hours && s.type !== 'number') ctx.addIssue({ code: 'custom', message: `${s.label}: only a reading can be a run hour meter` });
});

/** One answer: pass/fail/na for a plain step, a value for the other kinds (or na), and the photo taken for it. */
const answerSchema = z.object({
  key: z.string().max(30),
  result: z.enum(['pass', 'fail', 'na']).optional(),
  value: z.union([z.number(), z.boolean(), z.string().max(500)]).nullable().optional(),
  note: z.string().max(255).nullable().optional(),
  photo_id: z.number().int().positive().nullable().optional(),
});

const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
const withUnit = (n, unit) => `${fmt(n)}${unit ? ` ${unit}` : ''}`;
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** What a step asks for, in words: "Reading, 100 to 175 psi", "Date, fails within 30 days", "Yes or no, yes fails". */
function ruleText(s) {
  const photo = s.photo ? ', with a photo' : '';
  if (s.type === 'number') {
    const range = s.min != null && s.max != null ? `${withUnit(s.min, s.unit)} to ${withUnit(s.max, s.unit)}` : s.min != null ? `at least ${withUnit(s.min, s.unit)}` : s.max != null ? `at most ${withUnit(s.max, s.unit)}` : (s.unit || 'any value');
    return `${s.run_hours ? 'Hour meter reading' : 'Reading'}, ${range}${photo}`;
  }
  if (s.type === 'date') return `${s.within_days ? `Date, fails within ${s.within_days} days of it` : 'Date, fails once it has passed'}${photo}`;
  if (s.type === 'choice') return `One of: ${(s.options || []).join(', ')}${(s.fail_options || []).length ? `. ${s.fail_options.join(', ')} fails` : ''}${photo}`;
  if (s.type === 'text') return `A few words${photo}`;
  if (s.type === 'yesno') return `Yes or no${s.fail_on ? `, ${s.fail_on} fails` : ''}${photo}`;
  if (s.type === 'condition') return `Condition, 1 (new) to 5 (failed)${s.fail_at ? `, ${s.fail_at} or worse fails` : ''}${photo}`;
  return `Pass or fail${photo}`;
}

/**
 * Checks one answer against its step. Returns the stored item { key, label, type, result, value, unit, note } or throws
 * a message for the person filling it in. `today` is the mountain's date (YYYY-MM-DD).
 */
function evaluate(step, answer, today) {
  const out = evaluateOne(step, answer, today);
  if (step.photo && out.result !== 'na') {
    if (!answer.photo_id) throw new Error(`${step.label}: take a photo`);
    out.photo_id = Number(answer.photo_id);
  } else if (answer.photo_id && out.result !== 'na') out.photo_id = Number(answer.photo_id);
  if (step.run_hours) out.run_hours = true;
  if (step.stops_use) out.stops_use = true;
  return out;
}

const NEEDS_NOTE = 'Say what is wrong with each item that failed';
/** A result for a step that can also be failed by hand (a reading inside its range, with a cracked gauge), with a note. */
function judged(base, value, why, answer, note, extra = {}) {
  const result = why || answer.result === 'fail' ? 'fail' : 'pass';
  if (result === 'fail' && !why && !note) throw new Error(NEEDS_NOTE);
  return { ...base, result, value, ...extra, note: [why, note].filter(Boolean).join('. ') || null, auto: Boolean(why) };
}

function evaluateOne(step, answer, today) {
  const type = step.type || 'pass';
  const base = { key: step.key, label: step.label, type };
  const note = answer.note ? String(answer.note).trim() : null;
  if (answer.result === 'na') return { ...base, result: 'na', value: null, note };
  const blank = answer.value === null || answer.value === undefined || answer.value === '';
  if (type === 'pass') {
    if (!['pass', 'fail'].includes(answer.result)) throw new Error(`${step.label}: choose pass, fail or not applicable`);
    if (answer.result === 'fail' && !note) throw new Error(NEEDS_NOTE);
    return { ...base, result: answer.result, note };
  }
  if (type === 'number') {
    const v = typeof answer.value === 'number' ? answer.value : Number(String(answer.value ?? '').trim());
    if (blank || typeof answer.value === 'boolean' || !Number.isFinite(v)) throw new Error(`${step.label}: enter the reading`);
    let why = null;
    if (step.min != null && v < step.min) why = `${withUnit(v, step.unit)} is below the lowest allowed, ${withUnit(step.min, step.unit)}`;
    else if (step.max != null && v > step.max) why = `${withUnit(v, step.unit)} is above the highest allowed, ${withUnit(step.max, step.unit)}`;
    return judged(base, v, why, answer, note, { unit: step.unit || null });
  }
  if (type === 'date') {
    const v = String(answer.value ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new Error(`${step.label}: enter the date`);
    let why = null;
    if (v < today) why = `Expired on ${v}`;
    else if (step.within_days && v <= addDays(today, step.within_days)) why = `Expires on ${v}, within ${step.within_days} days`;
    return judged(base, v, why, answer, note);
  }
  if (type === 'choice') {
    const v = blank ? '' : String(answer.value).trim();
    const opts = step.options || [];
    const match = opts.find((o) => o.toLowerCase() === v.toLowerCase());
    if (!match) throw new Error(`${step.label}: choose one of ${opts.join(', ')}`);
    const why = (step.fail_options || []).includes(match) ? `${match}` : null;
    return judged(base, match, why, answer, note);
  }
  if (type === 'text') {
    const v = blank ? '' : String(answer.value).trim();
    if (!v) throw new Error(`${step.label}: write what you found`);
    return judged(base, v.slice(0, 500), null, answer, note);
  }
  if (type === 'yesno') {
    const raw = answer.value;
    const v = raw === true || /^(yes|y|true)$/i.test(String(raw ?? '').trim()) ? 'yes' : raw === false || /^(no|n|false)$/i.test(String(raw ?? '').trim()) ? 'no' : null;
    if (!v) throw new Error(`${step.label}: answer yes or no`);
    const why = step.fail_on && v === step.fail_on ? `Answered ${v}` : null;
    return judged(base, v, why, answer, note);
  }
  if (type === 'condition') {
    const v = typeof answer.value === 'number' ? answer.value : Number(String(answer.value ?? '').trim());
    if (blank || !Number.isInteger(v) || v < 1 || v > 5) throw new Error(`${step.label}: choose a condition from 1 (new) to 5 (failed)`);
    const why = step.fail_at && v >= step.fail_at ? `Condition ${v} of 5` : null;
    return judged(base, v, why, answer, note);
  }
  throw new Error(`${step.label}: unknown kind of step`);
}

/** The condition score a checklist's answers give (the first condition step answered), or null. */
function conditionOf(items) {
  const c = items.find((i) => i.type === 'condition' && i.result !== 'na' && Number.isInteger(i.value));
  return c ? c.value : null;
}

/**
 * Checks a whole checklist: every step answered, no answers for steps that are not on it. Returns the stored items,
 * in the checklist's order. Throws Error with a plain message.
 */
function evaluateAll(steps, answers, today) {
  const given = new Map(answers.map((a) => [a.key, a]));
  if ([...given.keys()].some((k) => !steps.some((s) => s.key === k))) throw new Error('An answer is for an item that is not on this checklist');
  const missing = steps.filter((s) => !given.has(s.key));
  if (missing.length) throw new Error(`Answer every item. Missing: ${missing.map((m) => m.label).join('; ')}`);
  return steps.map((s) => evaluate(s, given.get(s.key), today));
}

module.exports = { stepSchema, answerSchema, evaluate, evaluateAll, ruleText, conditionOf };
