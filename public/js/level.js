// Find my level (/level/<mountain>): five plain questions, one at a time, that give a level on the ski school's nine-level
// scale with its plain words. The result is remembered on this device, so the booking page starts with it.
import './stage.js';
import { h, clear } from './ui.js';
import { levelList } from './levels.js';
import { quizPanel, rememberLevel, rememberedLevel } from './levelpicker.js';

const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const root = document.getElementById('book');
let LANG = (navigator.language || '').toLowerCase().startsWith('es') ? 'es' : 'en';
try { const saved = localStorage.getItem('shop-lang'); if (saved === 'en' || saved === 'es') LANG = saved; } catch (_) { /* private mode */ }

async function main() {
  document.getElementById('fam-loading')?.remove();
  let info;
  try {
    const res = await fetch(`/api/v1/public/${encodeURIComponent(slug)}/level-quiz`);
    if (!res.ok) throw new Error('not found');
    info = await res.json();
  } catch (_) {
    root.append(h('main', { class: 'fam', id: 'fam-main' }, h('div', { class: 'card stack' }, h('h1', null, 'This page is not available'), h('p', { class: 'muted' }, 'Please call the ski school.'))));
    return;
  }
  document.title = `${info.mountain}: find my level`;
  const state = { discipline: (rememberedLevel(slug) || {}).discipline || 'ski' };
  const hero = h('header', { class: 'hero' }, h('div', { class: 'hero-in' }, h('span', { class: 'eyebrow' }, info.mountain), h('h1', null, 'Find my level'),
    h('p', { class: 'sub' }, 'Five quick questions. You get a level from 1 to 9 and the right lesson to book.')));
  const quizSlot = h('div');
  const ladderSlot = h('section', { class: 'card stack', 'aria-labelledby': 'ladder-h' });
  const discRow = h('div', { class: 'types', role: 'radiogroup', 'aria-label': 'Ski or snowboard' });
  const main = h('main', { class: 'fam', id: 'fam-main' }, h('section', { class: 'card stack' }, h('h2', null, 'Ski or snowboard?'), discRow, quizSlot), ladderSlot);
  root.append(hero, main);

  function drawLadder(current) {
    clear(ladderSlot).append(h('h2', { id: 'ladder-h' }, 'The nine levels'), h('p', { class: 'muted small' }, 'Every lesson at the mountain says which levels it is for.'),
      h('ol', { class: 'ladder' }, levelList(state.discipline).map((l) => h('li', { class: l.level === current ? 'now' : '' }, h('span', { class: 'n', 'aria-hidden': 'true' }, String(l.level)),
        h('span', null, h('strong', null, `Level ${l.level}: ${l.short}`), h('br'), h('span', { class: 'muted small' }, l.can), l.level === current ? h('span', { class: 'badge good' }, ' Your level') : null)))));
  }
  function draw() {
    clear(discRow).append(...['ski', 'snowboard'].map((d) => h('button', { type: 'button', class: 'pill', role: 'radio', 'aria-checked': String(state.discipline === d), 'aria-pressed': String(state.discipline === d), onclick: () => { state.discipline = d; draw(); } }, d === 'ski' ? 'Ski' : 'Snowboard')));
    clear(quizSlot).append(quizPanel({
      discipline: state.discipline, lang: LANG, doneText: info.online_booking ? 'Book a lesson at this level' : 'Done',
      onResult: (level) => { rememberLevel(slug, state.discipline, level); drawLadder(level); },
      onDone: () => { if (info.online_booking) location.href = `/book/${encodeURIComponent(slug)}`; else ladderSlot.scrollIntoView?.(); },
    }));
    const saved = rememberedLevel(slug);
    drawLadder(saved && saved.discipline === state.discipline ? saved.level : null);
  }
  draw();
}
main();
