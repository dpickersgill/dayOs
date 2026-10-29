// "Find my level" for the public pages: five plain questions, one at a time, with big buttons. Used on /level/<mountain>
// and inside the booking page. The questions and the answer-to-level rule are in levelquiz.js (the same as the server's).
import { h, clear } from './ui.js';
import { questions, levelFor } from './levelquiz.js';
import { levelName, levelList } from './levels.js';

const ES = {
  'Have you skied before?': '¿Has esquiado antes?', 'Have you snowboarded before?': '¿Has hecho snowboard antes?', 'Even once counts.': 'Aunque sea una vez cuenta.',
  'Never': 'Nunca', 'Yes': 'Sí', 'Not yet': 'Todavía no', 'Back': 'Atrás', 'Start over': 'Empezar de nuevo', 'Question': 'Pregunta', 'of': 'de',
  'Use this level': 'Usar este nivel', 'Your level': 'Tu nivel', 'On green runs': 'En pistas verdes', 'On blue runs too': 'También en pistas azules',
  'Anything, anywhere': 'Cualquier pista', 'Ski': 'Esquí', 'Snowboard': 'Snowboard',
};
const LS_KEY = (slug) => `level-${slug}`;

/** The last level found on this device for this mountain: { discipline, level } or null. */
export function rememberedLevel(slug) {
  try { const v = JSON.parse(localStorage.getItem(LS_KEY(slug)) || 'null'); return v && v.level ? v : null; } catch (_) { return null; }
}
export function rememberLevel(slug, discipline, level) {
  try { localStorage.setItem(LS_KEY(slug), JSON.stringify({ discipline, level, at: Date.now() })); } catch (_) { /* private mode: fine */ }
}

/**
 * The quiz in a box. opts: { discipline ('ski'|'snowboard'), who (a first name, or ''), lang ('en'|'es'), onDone(level),
 * onResult(level) when the answer shows, doneText }. Returns the element.
 */
export function quizPanel({ discipline = 'ski', who = '', lang = 'en', onDone, onResult, doneText = 'Use this level' }) {
  const T = (s) => (lang === 'es' && ES[s]) || s;
  const box = h('div', { class: 'quiz', role: 'group', 'aria-label': who ? `Find ${who}'s level` : 'Find my level' });
  const answers = [];
  const qs = questions(discipline);
  const live = h('p', { class: 'quiz-live', 'aria-live': 'polite' });
  function draw() {
    clear(box);
    const res = levelFor(discipline, answers);
    if (res && res.level) {
      const can = levelList(discipline)[res.level - 1].can;
      box.append(h('div', { class: 'quiz-result' },
        h('p', { class: 'quiz-step' }, who ? `${who}'s level` : T('Your level')),
        h('p', { class: 'quiz-level' }, levelName(res.level, discipline)),
        h('p', { class: 'quiz-can' }, `“${can}”`),
        h('div', { class: 'quiz-actions' },
          h('button', { type: 'button', class: 'btn primary big', onclick: () => onDone && onDone(res.level) }, T(doneText)),
          h('button', { type: 'button', class: 'btn link', onclick: () => { answers.length = 0; draw(); } }, T('Start over')))), live);
      live.textContent = levelName(res.level, discipline);
      if (onResult) onResult(res.level);
      return;
    }
    const i = res ? res.next : 0;
    const q = qs[i];
    const title = who ? q.q.replace(/^Have you/, `Has ${who}`).replace(/^Can you/, `Can ${who}`).replace(/^Are your/, `Are ${who}'s`).replace(/^Do you/, `Does ${who}`).replace(/^How do you feel/, `How does ${who} feel`).replace(/\byour\b/g, 'their').replace(/\byou\b/g, 'they') : q.q;
    box.append(h('p', { class: 'quiz-step' }, `${T('Question')} ${i + 1} ${T('of')} ${qs.length}`),
      h('h3', { class: 'quiz-q', id: `quiz-q-${i}`, tabindex: '-1' }, who ? title : T(q.q)), h('p', { class: 'muted small' }, T(q.help)),
      h('div', { class: 'quiz-options', role: 'group', 'aria-labelledby': `quiz-q-${i}` }, q.options.map((o, k) => h('button', { type: 'button', class: 'quiz-opt', onclick: () => { answers.push(k); draw(); } }, T(o.a)))),
      i > 0 ? h('button', { type: 'button', class: 'btn link', onclick: () => { answers.pop(); draw(); } }, `← ${T('Back')}`) : null, live);
    live.textContent = '';
    if (answers.length) box.querySelector('.quiz-q').focus?.({ preventScroll: true });
  }
  draw();
  return box;
}
