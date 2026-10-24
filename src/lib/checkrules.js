'use strict';

// Check steps that ask for more than pass or fail: a number (extinguisher pressure, an oxygen cylinder's psi, a battery's
// volts) with an allowed range, or a date (AED pads, a first-aid kit) with a rule such as "fails within 30 days of
// expiry". An answer outside the rule fails by itself, with the reason written for the person who fixes it, so nothing
// slips through on a busy morning. Used by the mountain's own checklists (Assets) and anything else built the same way.
const { z } = require('./util');

const KEY = z.string().regex(/^[a-z0-9_]{1,30}$/);
/** One step of a checklist as a manager sets it up. Old checklists have only key and label: those are pass/fail. */
const stepSchema = z.object({
  key: KEY,
  label: z.string().trim().min(1).max(150),
  type: z.enum(['pass', 'number', 'date']).default('pass'),
  unit: z.string().trim().max(20).nullable().optional(),
  min: z.number().min(-1e9).max(1e9).nullable().optional(),
  max: z.number().min(-1e9).max(1e9).nullable().optional(),
  within_days: z.number().int().min(0).max(3650).nullable().optional(),
}).superRefine((s, ctx) => {
  if (s.type === 'number' && s.min != null && s.max != null && s.min > s.max) ctx.addIssue({ code: 'custom', message: `${s.label}: the lowest allowed reading is above the highest` });
});

/** One answer: pass/fail/na for a plain step, a value for a reading or a date (or na). */
const answerSchema = z.object({
  key: z.string().max(30),
  result: z.enum(['pass', 'fail', 'na']).optional(),
  value: z.union([z.number(), z.string().max(10)]).nullable().optional(),
  note: z.string().max(255).nullable().optional(),
});

const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
const withUnit = (n, unit) => `${fmt(n)}${unit ? ` ${unit}` : ''}`;
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** What a step asks for, in words: "Number, 100 to 175 psi", "Date, fails within 30 days". */
function ruleText(s) {
  if (s.type === 'number') {
    const range = s.min != null && s.max != null ? `${withUnit(s.min, s.unit)} to ${withUnit(s.max, s.unit)}` : s.min != null ? `at least ${withUnit(s.min, s.unit)}` : s.max != null ? `at most ${withUnit(s.max, s.unit)}` : (s.unit || 'any value');
    return `Reading, ${range}`;
  }
  if (s.type === 'date') return s.within_days ? `Date, fails within ${s.within_days} days of it` : 'Date, fails once it has passed';
  return 'Pass or fail';
}

/**
 * Checks one answer against its step. Returns the stored item { key, label, type, result, value, unit, note } or throws
 * a message for the person filling it in. `today` is the mountain's date (YYYY-MM-DD).
 */
function evaluate(step, answer, today) {
  const type = step.type || 'pass';
  const base = { key: step.key, label: step.label, type };
  const note = answer.note ? String(answer.note).trim() : null;
  if (answer.result === 'na') return { ...base, result: 'na', value: null, note };
  if (type === 'pass') {
    if (!['pass', 'fail'].includes(answer.result)) throw new Error(`${step.label}: choose pass, fail or not applicable`);
    if (answer.result === 'fail' && !note) throw new Error('Say what is wrong with each item that failed');
    return { ...base, result: answer.result, note };
  }
  if (type === 'number') {
    const v = typeof answer.value === 'number' ? answer.value : Number(String(answer.value ?? '').trim());
    if (answer.value === null || answer.value === undefined || answer.value === '' || !Number.isFinite(v)) throw new Error(`${step.label}: enter the reading`);
    let why = null;
    if (step.min != null && v < step.min) why = `${withUnit(v, step.unit)} is below the lowest allowed, ${withUnit(step.min, step.unit)}`;
    else if (step.max != null && v > step.max) why = `${withUnit(v, step.unit)} is above the highest allowed, ${withUnit(step.max, step.unit)}`;
    // A reading inside the range can still be failed by hand (a gauge that is cracked), with a note.
    const result = why || answer.result === 'fail' ? 'fail' : 'pass';
    if (result === 'fail' && !why && !note) throw new Error('Say what is wrong with each item that failed');
    return { ...base, result, value: v, unit: step.unit || null, note: [why, note].filter(Boolean).join('. ') || null, auto: Boolean(why) };
  }
  if (type === 'date') {
    const v = String(answer.value ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new Error(`${step.label}: enter the date`);
    let why = null;
    if (v < today) why = `Expired on ${v}`;
    else if (step.within_days && v <= addDays(today, step.within_days)) why = `Expires on ${v}, within ${step.within_days} days`;
    const result = why || answer.result === 'fail' ? 'fail' : 'pass';
    if (result === 'fail' && !why && !note) throw new Error('Say what is wrong with each item that failed');
    return { ...base, result, value: v, note: [why, note].filter(Boolean).join('. ') || null, auto: Boolean(why) };
  }
  throw new Error(`${step.label}: unknown kind of step`);
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

module.exports = { stepSchema, answerSchema, evaluate, evaluateAll, ruleText };
