'use strict';
// "Find my level": five plain questions, one at a time, that place a guest on the nine-level scale (lib/levels.js).
// Each answer either gives the level straight away or goes on to the next question. The same questions are in
// public/js/levelquiz.js for the page; keep the two in step (test/lessonparents.test.js checks they agree).

const QUESTIONS = {
  ski: [
    { q: 'Have you skied before?', help: 'Even once counts.', options: [{ a: 'Never', level: 1 }, { a: 'Yes', next: true }] },
    { q: 'Can you stop and turn on the beginner slope?', help: 'The gentle slope by the magic carpet.', options: [{ a: 'Not yet', level: 2 }, { a: 'Yes', next: true }] },
    { q: 'Can you ride the chairlift and link turns on green runs?', help: 'Turn left, turn right, without stopping in between.', options: [{ a: 'Not yet', level: 3 }, { a: 'Yes', next: true }] },
    { q: 'Are your skis side by side (parallel) when you turn?', help: 'No more pizza, at least on the easy runs.', options: [{ a: 'Not yet', level: 4 }, { a: 'On green runs', level: 5 }, { a: 'On blue runs too', next: true }] },
    { q: 'How do you feel on blue and black runs?', help: 'Pick the one that sounds most like you.', options: [{ a: 'Some blues are still hard', level: 6 }, { a: 'All blues, trying blacks', level: 7 }, { a: 'Blacks and bumps', level: 8 }, { a: 'Anything, anywhere', level: 9 }] },
  ],
  snowboard: [
    { q: 'Have you snowboarded before?', help: 'Even once counts.', options: [{ a: 'Never', level: 1 }, { a: 'Yes', next: true }] },
    { q: 'Can you slide and stop on your heel edge on the beginner slope?', help: 'The gentle slope by the magic carpet.', options: [{ a: 'Not yet', level: 2 }, { a: 'Yes', next: true }] },
    { q: 'Can you ride the chairlift and link turns on green runs?', help: 'Heel side to toe side without sitting down.', options: [{ a: 'Not yet', level: 3 }, { a: 'Yes', next: true }] },
    { q: 'Do you link turns on every green run and easy blues?', help: 'Smooth turns, not just sliding sideways.', options: [{ a: 'Not yet', level: 4 }, { a: 'On green runs', level: 5 }, { a: 'On blue runs too', next: true }] },
    { q: 'How do you feel on blue and black runs?', help: 'Pick the one that sounds most like you.', options: [{ a: 'Some blues are still hard', level: 6 }, { a: 'All blues, carving', level: 7 }, { a: 'Blacks, bumps and the park', level: 8 }, { a: 'Anything, anywhere', level: 9 }] },
  ],
};

const questions = (discipline) => (discipline === 'snowboard' ? QUESTIONS.snowboard : QUESTIONS.ski);

/**
 * The level for a list of answers (the index of the option picked for each question, in order). Returns
 * { level } when the answers reach one, { next: i } when question i still needs an answer, or null for a bad answer.
 */
function levelFor(discipline, answers) {
  const qs = questions(discipline);
  for (let i = 0; i < qs.length; i++) {
    if (!Array.isArray(answers) || answers.length <= i) return { next: i };
    const opt = qs[i].options[Number(answers[i])];
    if (!opt) return null;
    if (opt.level) return { level: opt.level };
  }
  return null;
}

module.exports = { QUESTIONS, questions, levelFor };
