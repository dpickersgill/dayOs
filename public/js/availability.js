// The public instructor availability page (/availability/<mountain>). Read only: guests see which instructors are open and
// when, with a short bio, but they cannot book, request or contact anyone from here. The mountain turns it on, and each
// instructor chooses whether to be listed.

import { h, clear } from './ui.js';

const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const root = document.getElementById('avail');
const dateOf = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
const dayLong = (s) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(dateOf(s));
const clock = (t) => { const hr = +t.slice(0, 2); return `${hr % 12 || 12}:${t.slice(3, 5)} ${hr < 12 ? 'AM' : 'PM'}`; };
const badge = (t, cls = '') => h('span', { class: `badge ${cls}`.trim() }, t);

async function main() {
  let data;
  try {
    const res = await fetch(`/api/v1/public/${encodeURIComponent(slug)}/instructor-availability`);
    if (!res.ok) throw new Error();
    data = await res.json();
  } catch (_) {
    clear(root).append(h('main', { class: 'layout', id: 'avail-main' }, h('section', { class: 'card stack' }, h('h2', null, 'Not available'), h('p', null, 'This page is not available right now. Please call the ski school to ask about instructors.'))));
    return;
  }
  document.title = `Instructor availability, ${data.mountain}`;
  const byId = new Map(data.instructors.map((i) => [i.id, i]));
  let discipline = ''; let level = '';
  const list = h('div', { class: 'stack' });
  const filters = h('div', { class: 'stack' });
  const cards = h('div', { class: 'inst-grid' });

  const present = (key) => [...new Set(data.instructors.flatMap((i) => i[key]))];
  function chipRow(name, values, names, current, set) {
    if (values.length < 2) return null;
    const row = h('div', { class: 'chips-row', role: 'group', 'aria-label': name });
    for (const [value, text] of [['', 'All'], ...values.map((v) => [v, names[v]])]) {
      const b = h('button', { type: 'button', class: 'pill', 'aria-pressed': String(current === value) }, text);
      b.addEventListener('click', () => { set(value); drawFilters(); drawList(); });
      row.append(b);
    }
    return h('div', { class: 'stack tight' }, h('strong', { class: 'small' }, name), row);
  }
  function drawFilters() {
    clear(filters);
    for (const el of [chipRow('Teaches', present('disciplines'), data.disciplines, discipline, (v) => { discipline = v; }), chipRow('Level', present('levels'), data.levels, level, (v) => { level = v; })]) if (el) filters.append(el);
  }
  const matches = (inst) => inst && (!discipline || inst.disciplines.includes(discipline)) && (!level || inst.levels.includes(level));
  function drawList() {
    clear(list);
    let shown = 0;
    for (const day of data.days) {
      const slots = day.slots.filter((s) => matches(byId.get(s.instructor)));
      if (!slots.length) continue;
      shown += 1;
      list.append(h('section', { class: 'card stack' }, h('h2', null, dayLong(day.date)),
        h('ul', { class: 'slots' }, ...slots.map((s) => {
          const i = byId.get(s.instructor);
          return h('li', null, h('strong', { class: 'slot-time' }, `${clock(s.start)} to ${clock(s.end)}`),
            h('span', { class: 'slot-who' }, h('span', null, i.name), s.note ? h('span', { class: 'muted small' }, s.note) : null),
            h('span', { class: 'badges' }, ...i.disciplines.map((d) => badge(data.disciplines[d]))));
        }))));
    }
    if (!shown) list.append(h('section', { class: 'card stack' }, h('h2', null, 'No open times'), h('p', { class: 'muted' }, data.days.length ? 'No instructors match those choices. Try clearing a filter.' : 'No instructor has open times posted right now. Please check back soon.')));
  }
  for (const i of data.instructors) {
    cards.append(h('article', { class: 'card stack' }, h('h3', null, i.name), i.bio ? h('p', null, i.bio) : null,
      h('div', { class: 'badges' }, ...i.disciplines.map((d) => badge(data.disciplines[d])), ...i.levels.map((l) => badge(data.levels[l], 'good')))));
  }
  const call = data.phone ? h('a', { class: 'call', href: `tel:${data.phone.replace(/[^\d+]/g, '')}` }, `Call ${data.phone}`) : null;
  clear(root).append(
    h('header', { class: 'hero' }, h('div', { class: 'hero-in' }, h('span', { class: 'eyebrow' }, data.mountain), h('h1', null, 'Instructor availability'),
      h('p', { class: 'sub' }, 'When our instructors have open times over the next two months. Times change, so check back often.'),
      h('p', { class: 'note' }, 'This page is for information only. To book a lesson or ask about an instructor, please contact the ski school.'), call)),
    h('main', { class: 'layout avail-layout', id: 'avail-main' }, h('div', { class: 'main' }, h('section', { class: 'card stack' }, h('h2', null, 'Find a time'), filters), list),
      h('aside', { class: 'aside stack' }, h('h2', null, 'Our instructors'), data.instructors.length ? cards : h('p', { class: 'muted' }, 'No instructors are listed yet.'))));
  drawFilters(); drawList();
}
main();
