// A student's report card: where they are on each ladder, the skills passed, lesson history with the instructor's
// notes, and any lesson packages. Instructors and managers tick skills off and move the student up a level.

import { get, post, put } from '../api.js';
import { h, clear, can, label, state, button, toast, dialog, fmtDate, fmtDateTime, errorBox, loading, todayStr, fail } from '../ui.js';
import { printDialog } from '../print.js';

const ageOf = (dob) => {
  if (!dob) return null;
  const t = todayStr();
  let a = Number(t.slice(0, 4)) - Number(dob.slice(0, 4));
  if (t.slice(5) < dob.slice(5, 10)) a -= 1;
  return a;
};

/** The printable card. data is GET /skischool/students/:id/card, mountain is the mountain's name. */
export function cardSheet(card, mountain) {
  const p = card.person;
  const blocks = card.disciplines.map((d) => {
    const done = d.levels.filter((l) => l.complete).length;
    return h('section', { class: 'rcard-block' },
      h('h3', null, `${label(d.discipline)}${d.current_level ? `: working at level ${d.current_level}` : ''}`),
      h('p', { class: 'muted small' }, `${done} of ${d.levels.length} levels complete`),
      h('ul', { class: 'rcard-levels' }, d.levels.filter((l) => l.skills.some((s) => s.passed_on) || l.complete).map((l) => h('li', null,
        h('strong', null, `Level ${l.rank_no}: ${l.name}${l.complete ? ' (complete)' : ''}`),
        h('ul', null, l.skills.map((s) => h('li', { class: s.passed_on ? 'passed' : 'todo' }, `${s.passed_on ? 'Passed' : 'Not yet'}: ${s.name}${s.passed_on ? `  ${fmtDate(s.passed_on)}` : ''}`)))))));
  });
  const notes = card.lessons.filter((l) => l.instructor_notes).slice(0, 8);
  return h('article', { class: 'sheet report-card', 'data-sheet': 'report-card' },
    h('header', null, h('strong', null, mountain || 'Ski school'), h('h2', null, 'Student report card'), h('div', null, `${p.first_name} ${p.last_name}`), h('div', { class: 'muted small' }, `Printed ${fmtDate(todayStr())}`)),
    blocks.length ? blocks : h('p', null, 'No levels recorded yet.'),
    card.programs && card.programs.length ? h('section', { class: 'rcard-block' }, h('h3', null, 'Programs'), h('ul', null, card.programs.map((x) => h('li', null, `${x.program}, ${x.term}${x.class_name ? `, ${x.class_name}` : ''}: ${x.attended} of ${x.lessons} lessons attended`)))) : null,
        notes.length ? h('section', { class: 'rcard-block' }, h('h3', null, 'Instructor notes'), h('ul', null, notes.map((n) => h('li', null, `${fmtDate(n.starts_at)}: ${n.instructor_notes}`)))) : null);
}

export async function cardDialog(personId, { onChange } = {}) {
  const body = h('div', { class: 'stack' }, loading());
  const dlg = dialog('Report card', body, { wide: true });
  const editable = can('instructor');
  async function load() {
    try {
      const card = await get(`/skischool/students/${personId}/card`);
      const profile = await get('/tenant/profile').catch(() => ({}));
      const p = card.person;
      const age = ageOf(p.date_of_birth);
      const parts = [
        h('p', null, h('strong', null, `${p.first_name} ${p.last_name}`), age !== null ? h('span', { class: 'muted' }, `  age ${age}`) : null),
        card.credits.length ? h('div', { class: 'credits' }, card.credits.map((c) => state(`${c.product}: ${c.left} of ${c.total} left${c.expires_on ? `, until ${fmtDate(c.expires_on)}` : ''}`, c.left ? 'good' : 'neutral'))) : null,
      ];
      for (const d of card.disciplines) {
        const next = d.levels.find((l) => l.complete && (d.current_level || 0) <= l.rank_no);
        parts.push(h('section', { class: 'panel stack', 'data-discipline': d.discipline },
          h('div', { class: 'row between' }, h('h3', null, label(d.discipline)), d.current_level ? state(`Working at level ${d.current_level}`, 'good') : state('No level recorded', 'neutral')),
          d.levels.map((l) => h('details', { class: 'level', open: !l.complete && l.rank_no === d.next_level },
            h('summary', null, `Level ${l.rank_no}: ${l.name} `, l.complete ? state('Complete', 'good') : state(`${l.skills.filter((s) => s.passed_on).length} of ${l.skills.length} skills`, 'neutral')),
            l.description ? h('p', { class: 'muted small' }, l.description) : null,
            h('ul', { class: 'skills' }, l.skills.map((s) => {
              const box = h('input', { type: 'checkbox', checked: Boolean(s.passed_on), disabled: !editable, 'data-skill': s.id, 'aria-label': s.name });
              box.addEventListener('change', async () => {
                box.disabled = true;
                try { await put(`/skischool/students/${personId}/skills/${s.id}`, { passed: box.checked }); await load(); if (onChange) onChange(); } catch (err) { fail(err); box.checked = !box.checked; box.disabled = false; }
              });
              return h('li', null, h('label', { class: 'check' }, box, ` ${s.name}`), s.passed_on ? h('span', { class: 'muted small' }, `  ${fmtDate(s.passed_on)}`) : null);
            })))),
          editable && next ? h('div', { class: 'row' }, button(`Move up to level ${Math.min(next.rank_no + 1, 9)}`, async () => {
            await post('/skischool/progress', { person_id: personId, discipline: d.discipline, level: Math.min(next.rank_no + 1, 9), notes: `Passed level ${next.rank_no}: ${next.name}` });
            toast('Level recorded');
            await load();
            if (onChange) onChange();
          }, { kind: 'primary', small: true })) : null));
      }
      if (!card.disciplines.length) parts.push(h('p', { class: 'muted' }, 'No level ladder is set up yet.'));
      if (card.history.length) parts.push(h('details', null, h('summary', null, 'Level history'), h('ul', null, card.history.map((x) => h('li', null, `${fmtDate(x.recorded_at)}: ${label(x.discipline)} level ${x.level}${x.notes ? `. ${x.notes}` : ''}`)))));
      if (card.lessons.length) parts.push(h('details', { open: true }, h('summary', null, 'Lessons'), h('ul', { class: 'lesson-history' }, card.lessons.slice(0, 20).map((l) => h('li', null,
        `${fmtDateTime(l.starts_at)}, ${l.product}${l.instructor_first ? ` with ${l.instructor_first} ${l.instructor_last}` : ''} `, state(label(l.status), l.status === 'attended' ? 'good' : 'neutral'), l.unpaid ? state('Unpaid', 'warn') : null,
        l.instructor_notes ? h('div', { class: 'muted small' }, l.instructor_notes) : null)))));
      parts.push(h('div', { class: 'row' }, button('Print report card', () => printDialog(`Report card for ${p.first_name} ${p.last_name}`, cardSheet(card, profile.name)), { small: true })));
      clear(body).append(h('div', { class: 'stack' }, parts));
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  await load();
  return dlg;
}
