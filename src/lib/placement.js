'use strict';
// Level placement before lineup (2026.11.9, Track GUEST). Three plain yes or no questions per discipline, asked for each
// student when a lesson is booked (the booking page, Sell's lesson checkout), point to a level on the PSIA-AASI nine-level
// scale (lib/levels.js). The answer is kept on the booking (lesson_bookings.placement_level and placement_answers) and the
// lineup's suggested split uses it for a student with no level yet. Ski and snowboard have questions; telemark and
// adaptive do not (those students are placed by the instructor).
//
// A question: { text, yes, no }. yes and no are a level (1 to 9) or null for "go on to the next question". The last
// question must lead to a level both ways. The director can change the wording and where each answer leads
// (school_settings.placement_questions, JSON { ski: [3], snowboard: [3] }; null uses the built-in ones below).
const { z } = require('./util');
const L = require('./levels');

const DISCIPLINES = ['ski', 'snowboard'];
const COUNT = 3;

const BUILT_IN = {
  ski: [
    { text: 'Have you skied before?', yes: null, no: 1 },
    { text: 'Can you stop and turn on a green trail?', yes: null, no: 2 },
    { text: 'Can you make parallel turns on a blue trail?', yes: 6, no: 4 },
  ],
  snowboard: [
    { text: 'Have you snowboarded before?', yes: null, no: 1 },
    { text: 'Can you link turns on a green trail?', yes: null, no: 2 },
    { text: 'Can you ride a blue trail with linked turns?', yes: 6, no: 4 },
  ],
};

const dest = z.number().int().min(L.MIN).max(L.MAX).nullable();
const questionSchema = z.object({ text: z.string().trim().min(5).max(160), yes: dest, no: dest });
const setSchema = z.array(questionSchema).length(COUNT).superRefine((qs, ctx) => {
  const last = qs[COUNT - 1];
  if (last && (last.yes === null || last.no === null)) ctx.addIssue({ code: 'custom', message: 'The last question must lead to a level for yes and for no' });
});
/** The body of PUT /skischool/placement: both disciplines, or null to go back to the built-in questions. */
const schema = z.object({ questions: z.object({ ski: setSchema, snowboard: setSchema }).nullable() });

/** The questions in use: the director's own, or the built-in ones. settings: lib/schoolsettings get(). */
function questionsFrom(settings) {
  const raw = settings && settings.placement_questions;
  if (raw) {
    try {
      const parsed = schema.shape.questions.safeParse(typeof raw === 'string' ? JSON.parse(raw) : raw);
      if (parsed.success && parsed.data) return parsed.data;
    } catch (_) { /* a bad saved value falls back to the built-in questions */ }
  }
  return BUILT_IN;
}

async function questions(db, tenantId) {
  return questionsFrom(await require('./schoolsettings').get(db, tenantId));
}

/** The questions for one discipline, or [] (telemark, adaptive). */
const forDiscipline = (qs, discipline) => (DISCIPLINES.includes(discipline) ? qs[discipline] || [] : []);

/**
 * The level for a list of answers (true for yes, false for no, in order), or null while more answers are needed or for a
 * discipline with no questions. Answers after the one that reaches a level are ignored.
 */
function levelFor(qs, discipline, answers) {
  const list = forDiscipline(qs, discipline);
  if (!list.length || !Array.isArray(answers)) return null;
  for (let i = 0; i < list.length; i++) {
    if (typeof answers[i] !== 'boolean') return null;
    const to = answers[i] ? list[i].yes : list[i].no;
    if (to) return to;
  }
  return null;
}

/** What a placed level looks like, in the guest's words: { level, name, can }. */
function describe(level, discipline) {
  if (!L.valid(Number(level))) return null;
  const row = (discipline === 'snowboard' ? L.SNOWBOARD : L.SKI)[Number(level)];
  return { level: Number(level), name: L.name(level, discipline), can: row.can };
}

/**
 * Works out a student's placement from their answers: { placement_level, placement_answers } to save on the booking, or
 * null when there is nothing to save. placement_answers keeps the questions as they were asked, so a later change to the
 * wording does not change what this family said.
 */
function place(qs, discipline, answers) {
  const level = levelFor(qs, discipline, answers);
  if (!level) return null;
  const list = forDiscipline(qs, discipline);
  const asked = [];
  for (let i = 0; i < list.length; i++) {
    asked.push(`${list[i].text} ${answers[i] ? 'Yes' : 'No'}`);
    if ((answers[i] ? list[i].yes : list[i].no)) break;
  }
  return { placement_level: level, placement_answers: asked.join(' | ').slice(0, 400) };
}

/** The questions as the public pages need them: the wording and where each answer leads, per discipline. */
const publicShape = (qs) => ({ ski: qs.ski.map((q) => ({ text: q.text, yes: q.yes, no: q.no })), snowboard: qs.snowboard.map((q) => ({ text: q.text, yes: q.yes, no: q.no })) });

module.exports = { BUILT_IN, DISCIPLINES, COUNT, schema, answersSchema: z.array(z.boolean()).min(1).max(COUNT), questionsFrom, questions, forDiscipline, levelFor, describe, place, publicShape };
