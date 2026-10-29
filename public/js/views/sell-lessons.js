// Sell, Lessons (Track LINEUP): the lessons for one day at a time (today first, then the next days), filtered by
// discipline, age and level, with the level range, ages, instructor's first name and spots left. Picking the student
// first shows the lessons that fit their age and level, and puts the student on the line, so checkout knows who it is.
// Lessons that already started are hidden unless a manager chooses to show them.
import { get } from '../api.js';
import { h, clear, isManager, money, state, input, select, field, button, toast, fmtTime, fmtDate, label, empty, addDays } from '../ui.js';
import { levelOptions } from '../levels.js';

const DISCIPLINES = [['', 'Any'], ['ski', 'Ski'], ['snowboard', 'Snowboard'], ['telemark', 'Telemark'], ['adaptive', 'Adaptive']];
const fits = (s, age, level) => {
  if (age !== null && ((s.age_min && age < s.age_min) || (s.age_max && age > s.age_max))) return false;
  if (level && ((s.level_min && level < s.level_min) || (s.level_max && level > s.level_max))) return false;
  return true;
};

/** Draws the Lessons tab into b. add(line) puts a line in the basket; price(p, tier) is the menu price for a guest type. */
export function drawLessons(b, { menu, tiers, first, add, price }) {
  const today = menu.today;
  const days = [...new Set([today, ...menu.lessons.map((s) => String(s.starts_at).slice(0, 10))])].filter((d) => d >= today).sort().slice(0, 10);
  let day = days.find((d) => menu.lessons.some((s) => String(s.starts_at).slice(0, 10) === d && !s.started)) || today;
  let student = null; // { person, age, ski_level, snowboard_level, first_name }
  const tier = select(tiers, first, { name: 'lesson-tier', 'aria-label': 'Student type' });
  const disc = select(DISCIPLINES, '', { 'aria-label': 'Discipline' });
  const age = input({ type: 'number', min: 2, max: 99, inputmode: 'numeric', placeholder: 'Any', 'aria-label': 'Student age', class: 'sl-age' });
  const level = select([['', 'Any level'], ...levelOptions('ski')], '', { 'aria-label': 'Student level' });
  const started = h('input', { type: 'checkbox' });
  const strip = h('div', { class: 'seg sl-days', role: 'group', 'aria-label': 'Day' });
  const list = h('div', { class: 'sl-list', 'aria-live': 'polite' });
  const who = h('div', { class: 'sl-who' });

  // ---- the student first (optional): search the customer list, then their age and level fill the filters
  const find = input({ type: 'search', placeholder: 'Find the student (name or phone)', 'aria-label': 'Find the student', autocomplete: 'off' });
  const results = h('ul', { class: 'plain sl-results', role: 'listbox', 'aria-label': 'Students found' });
  let timer = null;
  find.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      clear(results);
      const q = find.value.trim();
      if (q.length < 2) return;
      try {
        const { data } = await get(`/people/lookup?q=${encodeURIComponent(q)}`);
        results.append(...data.slice(0, 6).map((p) => h('li', null, h('button', { type: 'button', class: 'btn small', onclick: () => pick(p) }, `${p.first_name} ${p.last_name}${p.date_of_birth ? `, born ${fmtDate(p.date_of_birth)}` : ''}`))));
        if (!data.length) results.append(h('li', { class: 'muted small' }, 'Nobody found. Type their age instead, and add their details at checkout.'));
      } catch (_) { /* the search is a shortcut; the filters still work */ }
    }, 250);
  });
  async function pick(p) {
    try {
      const x = await get(`/skischool/lesson-safety/${p.id}`);
      student = { person: p, ...x };
      if (x.age !== null && x.age !== undefined) age.value = String(x.age);
      const lv = disc.value === 'snowboard' ? x.snowboard_level : x.ski_level;
      level.value = lv ? String(lv) : '';
      // the student's guest type from their age (Child, Youth, Adult...) when the mountain gives types an age range
      clear(results); find.value = '';
      draw();
    } catch (err) { toast(err.message || 'Could not load that student', 'error'); }
  }
  const clearStudent = () => { student = null; age.value = ''; level.value = ''; draw(); };

  for (const el of [disc, level, started]) el.addEventListener('change', () => { if (el === disc && student) { const lv = disc.value === 'snowboard' ? student.snowboard_level : student.ski_level; level.value = lv ? String(lv) : ''; } draw(); });
  age.addEventListener('input', () => draw());

  function draw() {
    clear(strip).append(...days.map((d) => {
      const n = menu.lessons.filter((s) => String(s.starts_at).slice(0, 10) === d && (started.checked || !s.started)).length;
      return h('button', { type: 'button', class: 'btn', 'aria-pressed': String(d === day), onclick: () => { day = d; draw(); } },
        h('span', null, d === today ? 'Today' : d === addDays(today, 1) ? 'Tomorrow' : fmtDate(d)), h('small', { class: 'muted' }, ` ${n}`));
    }));
    clear(who);
    if (student) who.append(h('div', { class: 'notice sl-student' }, h('span', null, 'Lesson for ', h('strong', null, `${student.person.first_name} ${student.person.last_name}`), student.age !== null ? `, age ${student.age}` : '', level.value ? `, Level ${level.value}` : ', level not known yet'), ' ', button('Clear', clearStudent, { small: true })));
    const a = age.value.trim() ? Number(age.value) : null;
    const lv = Number(level.value) || null;
    const ofDay = menu.lessons.filter((s) => String(s.starts_at).slice(0, 10) === day && (started.checked || !s.started) && (!disc.value || s.discipline === disc.value));
    const good = ofDay.filter((s) => fits(s, a, lv));
    const other = ofDay.filter((s) => !fits(s, a, lv));
    clear(list);
    if (!ofDay.length) { list.append(empty(day === today ? 'No more lessons today. Pick another day above.' : 'No lessons on this day.')); return; }
    if (!good.length) list.append(h('p', { class: 'muted' }, 'No lesson fits that age and level on this day. These are the others:'));
    list.append(...good.map((s) => card(s, true)));
    if (good.length && other.length) list.append(h('details', { class: 'sl-other' }, h('summary', null, `${other.length} other lesson${other.length === 1 ? '' : 's'} that do not fit`), ...other.map((s) => card(s, false))));
    else if (!good.length) list.append(...other.map((s) => card(s, false)));
  }

  function card(s, fit) {
    const full = !s.spots_left;
    const add1 = button(full ? 'Full' : 'Add', () => {
      add({ type: 'lesson', session_id: s.id, name: s.name, tier: tier.value, quantity: 1, day: String(s.starts_at).slice(0, 10), detail: `${fmtDate(s.starts_at)} ${fmtTime(s.starts_at)}${student ? `, for ${student.person.first_name}` : ''}`, ...(student ? { student: student.person, safety_prefill: student.safety } : {}) });
      toast(`${s.name} added${student ? ` for ${student.person.first_name}` : ''}`);
    }, { kind: fit ? 'primary' : null, label: `Add ${s.name} at ${fmtTime(s.starts_at)}` });
    add1.disabled = full;
    return h('article', { class: `sl-card${fit ? '' : ' unfit'}`, 'data-session': s.id },
      h('div', { class: 'sl-time' }, h('strong', null, fmtTime(s.starts_at)), h('small', { class: 'muted' }, `to ${fmtTime(s.ends_at)}`)),
      h('div', { class: 'sl-what' }, h('strong', null, s.name), h('div', { class: 'small' }, [label(s.discipline), s.level_words, s.age_words].join(', ')),
        h('div', { class: 'muted small' }, [s.instructor_first ? `with ${s.instructor_first}` : 'instructor not set yet', s.meeting_place ? `meet at ${s.meeting_place}` : null, s.format !== 'group' ? label(s.format) : null].filter(Boolean).join(', ')),
        s.started ? state('Started', 'warn') : null),
      h('div', { class: 'sl-side' }, h('span', { class: 'tile-price' }, money(price(s, tier.value))), h('small', null, full ? state('Full', 'bad') : `${s.spots_left} left`), add1));
  }

  tier.addEventListener('change', draw);
  b.append(
    h('div', { class: 'sl-find' }, find, results), who,
    h('div', { class: 'menu-tools sl-tools' }, field('Discipline', disc), field('Age', age), field('Level', level), field('Student type', tier),
      isManager() ? h('label', { class: 'check' }, started, ' Show lessons that started') : null),
    strip, list);
  draw();
}
