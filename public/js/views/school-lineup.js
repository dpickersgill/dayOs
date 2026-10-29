// The ski school, round 2 (lineup). school.js adds these tabs to Ski school and these pages to Settings, Ski school.
// tabs(ctx): [[key, label, (panel) => render]], ctx = { staff, names, certs }. settingsPages: { key: { title, render(panel) } }.
//
// Check-in: the day's students by lesson time, a search and a scan box (the confirmation's code 'L' + booking number,
// or a receipt's 'ORD-' + order number). The lineup board: one column per class of a lineup, the students checked in,
// "Not checked in", the suggested split and moving a student (drag, or tap and "Move to"). Labels for each student.
import { get, post, patch, del } from '../api.js';
import { h, clear, can, isManager, state, input, select, field, button, toast, dialog, formDialog, todayStr, addDays, fmtTime, fmtDate, empty, errorBox, fail, appendAll, val } from '../ui.js';
import { code128 } from '../barcode.js';
import { printDialog } from '../print.js';
import { levelOptions } from '../levels.js';
import { card, row, toggle, amount } from './settings-kit.js';

const desk = () => can('counter');
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(`lineup.${k}`); return v === null ? d : v; } catch (_) { return d; } },
  set: (k, v) => { try { localStorage.setItem(`lineup.${k}`, v); } catch (_) { /* a private window: not remembered */ } },
};
const COLOR_CSS = { Red: 'c-red', Blue: 'c-blue', Green: 'c-green', Orange: 'c-orange', Purple: 'c-purple', Yellow: 'c-yellow', Pink: 'c-pink', Teal: 'c-teal', Brown: 'c-brown', Gray: 'c-gray' };
const swatch = (color) => (color ? h('span', { class: `lu-swatch ${COLOR_CSS[color] || ''}`, 'aria-hidden': 'true' }) : null);
const flags = (s) => [s.has_allergy ? state('Allergy', 'bad') : null, s.has_medical ? state('Medical', 'bad') : null].filter(Boolean);

export function tabs(_ctx) {
  if (!desk()) return [];
  return [['checkin', 'Check-in', (p) => checkinTab(p)], ['lineup', 'Lineup', (p) => lineupTab(p)]];
}

// ---------------------------------------------------------------- labels
/** One label: first name and last initial, level, class color, an allergy mark (never the details), instructor, meeting place, barcode. */
function labelEl(l, format) {
  return h('article', { class: `sheet lesson-label ${format}`, 'data-sheet': 'lesson-label', 'data-code': l.code },
    h('div', { class: 'll-top' }, h('strong', { class: 'll-name' }, `${l.first_name} ${l.last_initial}.`), l.allergy ? h('span', { class: 'll-allergy' }, 'ALLERGY') : null),
    h('div', { class: 'll-mid' }, l.color ? h('span', { class: `ll-color ${COLOR_CSS[l.color] || ''}` }, l.color) : null, h('span', null, l.level_words)),
    h('div', { class: 'll-small' }, [fmtTime(l.starts_at), l.instructor ? `with ${l.instructor}` : null, l.meeting_place ? `at ${l.meeting_place}` : null].filter(Boolean).join(' ')),
    h('div', { class: 'll-code' }, code128(l.code, { height: 26, module: 1.2 }), h('span', null, l.code)));
}
/** Fetches and prints labels. query: 'lineup_id=3', 'session_id=4' or 'booking_ids=5,6'. */
export async function printLabels(query, title = 'Labels') {
  let data;
  try { data = (await get(`/skischool/labels?${query}`)).data; } catch (err) { fail(err); return; }
  if (!data.length) { toast('Nobody to print a label for yet', 'error'); return; }
  let format = store.get('labelFormat', 'roll');
  const area = h('div', { class: 'label-area' });
  const draw = () => { clear(area).append(h('div', { class: format === 'sheet' ? 'label-sheet' : 'label-roll' }, data.map((l) => labelEl(l, format)))); };
  const pick = select([['roll', 'Label printer (2.25 x 1.25 inch)'], ['sheet', 'Plain paper sheet']], format, { 'aria-label': 'Label size', class: 'no-print' });
  pick.addEventListener('change', () => { format = pick.value; store.set('labelFormat', format); draw(); });
  draw();
  printDialog(`${title} (${data.length})`, area, [h('label', { class: 'no-print' }, 'Print on ', pick)]);
}

// ---------------------------------------------------------------- check-in
async function checkinTab(root) {
  const date = input({ type: 'date', value: todayStr(), 'aria-label': 'Day' });
  const search = input({ type: 'search', placeholder: 'Name, phone or order number', 'aria-label': 'Find a student', autocomplete: 'off' });
  const scan = input({ class: 'scan-input lu-scan', placeholder: 'Scan the confirmation or receipt', 'aria-label': 'Scan a code', autocomplete: 'off', autocapitalize: 'characters' });
  const autoLabel = h('input', { type: 'checkbox', checked: store.get('labelOnCheckin', '0') === '1' });
  autoLabel.addEventListener('change', () => store.set('labelOnCheckin', autoLabel.checked ? '1' : '0'));
  const body = h('div', { class: 'stack', 'aria-live': 'polite' });
  const status = h('div', { role: 'status' });
  root.append(h('p', { class: 'muted' }, 'Check students in as they arrive. Scan the code on their confirmation or receipt, or find them by name. Families can also tap "We\'re here" on their lesson link.'),
    h('form', { class: 'lu-scan-row', onsubmit: (e) => { e.preventDefault(); doScan(); } }, scan, button('Check in', () => doScan(), { kind: 'primary' })),
    status,
    h('div', { class: 'inline-form' }, field('Day', date), field('Find', search), h('label', { class: 'check' }, autoLabel, ' Print a label at check-in')), body);
  let timer = null;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
  date.addEventListener('change', load);

  async function after(rowsIn) {
    if (autoLabel.checked && rowsIn.length) await printLabels(`booking_ids=${rowsIn.map((r) => r.booking_id).join(',')}`, 'Label');
  }
  async function doScan() {
    const code = scan.value.trim();
    if (!code) { scan.focus(); return; }
    clear(status);
    try {
      const r = await post('/skischool/checkin/scan', { code });
      scan.value = '';
      status.append(h('div', { class: 'notice good' }, r.data.map((x) => h('div', null, h('strong', null, `${x.first_name} ${x.last_name}`), x.already ? ' was already checked in' : ' checked in', `: ${x.product} ${fmtTime(x.starts_at)}`,
        ...problems(x)))));
      await load();
      await after(r.data.filter((x) => !x.already));
    } catch (err) { status.append(errorBox(err)); }
    scan.focus();
  }
  function problems(x) {
    return [!x.waiver_ok ? h('span', null, ' ', state('No waiver this season', 'bad')) : null, x.unpaid ? h('span', null, ' ', state('Unpaid', 'warn')) : null];
  }
  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading…'));
    try {
      const { data } = await get(`/skischool/checkin?date=${date.value}&q=${encodeURIComponent(search.value.trim())}`);
      clear(body);
      if (!data.length) { body.append(empty(search.value.trim() ? 'Nobody matches.' : 'No students on this day.')); return; }
      const done = data.filter((r) => r.checked_in_at).length;
      body.append(h('p', { class: 'muted' }, `${done} of ${data.length} checked in`));
      const byTime = new Map();
      for (const r of data) { const k = `${r.starts_at}|${r.product}`; if (!byTime.has(k)) byTime.set(k, []); byTime.get(k).push(r); }
      for (const list of byTime.values()) {
        const r0 = list[0];
        body.append(h('section', { class: 'panel stack tight lu-time' },
          h('header', { class: 'row between' }, h('h3', null, `${fmtTime(r0.starts_at)} ${r0.product}`), h('span', { class: 'muted small' }, `${list.filter((r) => r.checked_in_at).length} of ${list.length} here`)),
          h('ul', { class: 'plain lu-list' }, list.map((r) => h('li', { class: `lu-row${r.checked_in_at ? ' in' : ''}`, 'data-booking': r.booking_id },
            h('div', { class: 'lu-who' }, h('strong', null, `${r.first_name} ${r.last_name}`),
              h('span', { class: 'muted small' }, [r.age !== null ? `age ${r.age}` : null, r.student_level ? `Level ${r.student_level}` : null, r.instructor_first ? `with ${r.instructor_first}` : 'no instructor yet', r.meeting_place ? `meet at ${r.meeting_place}` : null].filter(Boolean).join(', ')),
              h('span', { class: 'row tight' }, ...flags(r), ...problems(r), r.delay_minutes ? state(`Delayed ${r.delay_minutes} min`, 'warn') : null)),
            h('div', { class: 'lu-act' },
              r.checked_in_at ? [state(r.checked_in_via === 'link' ? 'Here (family link)' : 'Here', 'good'), button('Undo', async () => { try { await del(`/skischool/bookings/${r.booking_id}/checkin`); await load(); } catch (err) { fail(err); } }, { small: true, label: `Undo check-in for ${r.first_name}` })]
                : button('Check in', async () => { try { const x = await post(`/skischool/bookings/${r.booking_id}/checkin`, {}); toast(`${r.first_name} checked in`); await load(); await after([x]); } catch (err) { fail(err); } }, { kind: 'primary', small: true, label: `Check in ${r.first_name} ${r.last_name}` }),
              button('Label', () => printLabels(`booking_ids=${r.booking_id}`, `Label for ${r.first_name}`), { small: true, label: `Print a label for ${r.first_name}` })))))));
      }
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  await load();
  setTimeout(() => scan.focus(), 0);
}

// ---------------------------------------------------------------- moving a student
/**
 * "Move to": the classes this student can join (same day, same time), then the move. Used from the lineup board and,
 * for an instructor, from their roster ("Move up a group"). student: { booking_id, first_name }. done() after a move.
 */
export async function moveDialog(student, done) {
  let opts;
  try { opts = (await get(`/skischool/bookings/${student.booking_id}/move-options`)).data; } catch (err) { fail(err); return; }
  if (!opts.length) { toast('There is no other class at this time to move to', 'error'); return; }
  const pick = select(opts.map((s) => [s.id, `${s.instructor_first ? `${s.instructor_first}'s group` : 'No instructor yet'}, ${s.level_words}${s.meeting_place ? `, ${s.meeting_place}` : ''} (${s.spots_left ? `${s.spots_left} spot${s.spots_left === 1 ? '' : 's'} left` : 'full'})`]), opts[0].id, { name: 'session_id' });
  const reason = input({ name: 'reason', maxlength: 300, placeholder: 'Only when the class is full' });
  const reasonRow = field('Reason to go over by one (managers)', reason);
  const sync = () => { const s = opts.find((x) => String(x.id) === pick.value); reasonRow.hidden = !(s && !s.spots_left && isManager()); };
  pick.addEventListener('change', sync); sync();
  formDialog(`Move ${student.first_name}`, h('div', { class: 'form' }, field('Move to', pick, 'The family and the new instructor are told.'), reasonRow), async (fd) => {
    const body = { session_id: Number(pick.value) };
    if (val(fd, 'reason')) body.reason = val(fd, 'reason');
    await post(`/skischool/bookings/${student.booking_id}/move`, body);
    toast(`${student.first_name} moved`);
    if (done) await done();
  }, { submitText: 'Move' });
}

/** A move from a drag on the board: asks for a reason when the class is full and a manager is moving. */
async function moveTo(student, sessionId, done) {
  try {
    await post(`/skischool/bookings/${student.booking_id}/move`, { session_id: sessionId });
    toast(`${student.first_name} moved`);
  } catch (err) {
    if (err.details && err.details.needs_reason && isManager()) {
      formDialog('That class is full', h('div', { class: 'form' }, h('p', { class: 'wide' }, `Add ${student.first_name} as one over the class size?`), field('Reason', input({ name: 'reason', required: true, minlength: 3, maxlength: 300 }))), async (fd) => {
        await post(`/skischool/bookings/${student.booking_id}/move`, { session_id: sessionId, reason: val(fd, 'reason') });
        toast(`${student.first_name} moved`);
        await done();
      }, { submitText: 'Move anyway' });
      return;
    }
    fail(err);
  }
  await done();
}

// ---------------------------------------------------------------- the lineup board
async function lineupTab(root) {
  const date = input({ type: 'date', value: todayStr(), 'aria-label': 'Day' });
  const which = select([], '', { 'aria-label': 'Lineup' });
  const head = h('div', { class: 'stack tight' });
  const boardEl = h('div', { class: 'lu-board', 'aria-live': 'polite' });
  const wrap = h('div', { class: 'stack lu-host' });
  root.append(h('div', { class: 'inline-form lu-tools' }, field('Day', date), field('Lineup', which),
    button('Today', () => { date.value = todayStr(); loadDay(); }, { small: true }), button('Tomorrow', () => { date.value = addDays(todayStr(), 1); loadDay(); }, { small: true }),
    button('Wall screen', () => { if (wrap.requestFullscreen) wrap.requestFullscreen().catch(() => {}); }, { small: true })), wrap);
  wrap.append(head, boardEl);
  let lineups = [];
  let b = null;
  let suggestion = null; // while the director edits a suggested split, the board does not refresh under them
  date.addEventListener('change', () => loadDay());
  which.addEventListener('change', () => { suggestion = null; loadBoard(); });

  async function loadDay() {
    try {
      const r = await get(`/skischool/lineups?date=${date.value}`);
      lineups = r.data;
      clear(which).append(...lineups.map((l) => h('option', { value: String(l.id) }, `${fmtTime(l.starts_at)} ${l.product}, ${l.discipline}${l.age_group !== 'all' ? `, ${l.age_group}` : ''} (${l.checked_in} of ${l.students} here)`)));
      if (r.next_id) which.value = String(r.next_id);
      suggestion = null;
      if (!lineups.length) { clear(head); clear(boardEl).append(empty('No group lessons on this day.')); return; }
      await loadBoard();
    } catch (err) { clear(boardEl).append(errorBox(err)); }
  }
  async function loadBoard() {
    if (!which.value) return;
    try { b = await get(`/skischool/lineups/${which.value}`); } catch (err) { clear(boardEl).append(errorBox(err)); return; }
    draw();
  }

  function studentChip(s, { classes, onPick, draggable = true, color = null }) {
    const chip = h('li', { class: `lu-chip${s.checked_in ? ' in' : ''}`, draggable: draggable ? 'true' : 'false', 'data-booking': s.booking_id, tabindex: '0', role: 'button',
      'aria-label': `${s.first_name} ${s.last_name}${s.level ? `, level ${s.level}` : ''}${s.checked_in ? ', checked in' : ', not checked in'}. Press Enter for choices.` },
    swatch(color), h('span', { class: 'lu-chip-name' }, `${s.first_name} ${s.last_name.slice(0, 1)}.`), h('span', { class: 'lu-chip-meta' }, [s.level ? `L${s.level}` : 'L?', s.age !== null ? `${s.age}y` : null].filter(Boolean).join(' ')),
    s.has_allergy || s.has_medical ? h('span', { class: 'lu-chip-flag', title: 'Allergy or medical note' }, '!') : null);
    chip.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(s.booking_id)); chip.classList.add('dragging'); });
    chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
    const open = () => onPick(s, classes);
    chip.addEventListener('click', open);
    chip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return chip;
  }
  function dropZone(el, onDrop) {
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('over'); const id = Number(e.dataTransfer.getData('text/plain')); if (id) onDrop(id); });
  }

  // a student tapped on the live board: check in or undo, move, label
  function studentMenu(s) {
    const d = dialog(`${s.first_name} ${s.last_name}`, h('div', { class: 'stack' },
      h('p', null, [s.level ? `Level ${s.level}` : 'Level not known yet', s.age !== null ? `age ${s.age}` : null].filter(Boolean).join(', '), ' ', ...flags(s), s.unpaid ? state('Unpaid', 'warn') : null),
      h('div', { class: 'row' },
        s.checked_in ? button('Undo check-in', async () => { try { await del(`/skischool/bookings/${s.booking_id}/checkin`); d.close(); await loadBoard(); } catch (err) { fail(err); } })
          : button('Check in', async () => { try { await post(`/skischool/bookings/${s.booking_id}/checkin`, {}); d.close(); await loadBoard(); } catch (err) { fail(err); } }, { kind: 'primary' }),
        button('Move to…', () => { d.close(); moveDialog(s, loadBoard); }),
        button('Print label', () => printLabels(`booking_ids=${s.booking_id}`, `Label for ${s.first_name}`)))));
  }

  function draw() {
    if (suggestion) { drawSuggestion(); return; }
    const L = b.lineup;
    const notIn = b.classes.flatMap((c) => c.students.filter((s) => !s.checked_in && s.status !== 'no_show').map((s) => ({ ...s, color: c.color })));
    appendAll(clear(head),
      h('div', { class: 'row between lu-head' },
        h('div', null, h('h2', null, `${fmtTime(L.starts_at)} ${L.product}`), h('p', { class: 'muted' }, `${fmtDate(L.starts_at)}. ${b.counts.checked_in} of ${b.counts.students} checked in. Up to ${L.ratio} students a class${L.kids ? ' (kids)' : ''}.`,
          L.locked ? h('span', null, ' ', state('Started: the split is locked', 'neutral')) : L.status === 'split' ? h('span', null, ' ', state('Split done', 'good')) : null)),
        h('div', { class: 'row' },
          !L.locked ? button('Suggest a split', () => suggest(), { kind: 'primary' }) : null,
          button('Print labels', () => printLabels(`lineup_id=${L.id}`, 'Labels for this lineup')),
          isManager() ? button('Class size', () => ratioDialog(), { small: true }) : null)));
    const cols = b.classes.map((c) => {
      const list = h('ul', { class: 'plain lu-chips' }, c.students.filter((s) => s.checked_in).map((s) => studentChip(s, { onPick: studentMenu, color: c.color })));
      const col = h('section', { class: `lu-col${c.instructor_id ? '' : ' attention'}`, 'data-session': c.id, 'aria-label': `${c.color} class` },
        h('header', null, h('div', { class: 'row between' }, h('strong', null, swatch(c.color), ` ${c.color}`), h('span', { class: 'muted small' }, `${c.students.filter((s) => s.checked_in).length} here, ${c.students.length} booked of ${c.capacity}`)),
          h('div', null, c.instructor ? h('strong', null, c.instructor) : state('Needs an instructor', 'warn')),
          h('div', { class: 'muted small' }, [c.level_words, c.meeting_place, c.origin === 'split' ? 'split off' : null].filter(Boolean).join(', '))),
        c.students.some((s) => s.checked_in) ? list : h('p', { class: 'muted small lu-empty' }, 'Nobody checked in yet. Drop a student here to move them.'));
      dropZone(col, (id) => {
        const s = b.classes.flatMap((x) => x.students).find((x) => x.booking_id === id);
        if (s && s.session_id !== c.id) moveTo(s, c.id, loadBoard);
      });
      return col;
    });
    const waiting = h('section', { class: 'lu-col lu-waiting', 'aria-label': 'Not checked in' },
      h('header', null, h('strong', null, `Not checked in (${notIn.length})`), h('div', { class: 'muted small' }, 'Tap a name to check them in')),
      notIn.length ? h('ul', { class: 'plain lu-chips' }, notIn.map((s) => studentChip(s, { onPick: studentMenu, color: s.color, draggable: true }))) : h('p', { class: 'muted small lu-empty' }, 'Everyone is here.'));
    appendAll(clear(boardEl), waiting, ...cols);
  }

  function ratioDialog() {
    formDialog('Class size for this lineup', h('div', { class: 'form' }, field('Students per instructor', input({ type: 'number', name: 'ratio', min: 1, max: 20, value: b.lineup.ratio }), 'Only this lineup. The school\'s usual sizes are in Settings, Ski school.')), async (fd) => {
      b = await patch(`/skischool/lineups/${b.lineup.id}`, { ratio: Number(val(fd, 'ratio')) || null });
      draw();
    });
  }

  // ---- the suggested split: edited on screen, then used
  async function suggest(from = store.get('splitFrom', 'checked_in')) {
    try { suggestion = await post(`/skischool/lineups/${b.lineup.id}/suggest`, { from }); } catch (err) { fail(err); return; }
    store.set('splitFrom', from);
    drawSuggestion();
  }
  function drawSuggestion() {
    const sg = suggestion;
    const all = sg.classes;
    const fromPick = select([['checked_in', 'Students checked in'], ['booked', 'Everyone booked']], sg.from, { 'aria-label': 'Split who' });
    fromPick.addEventListener('change', () => suggest(fromPick.value));
    let teachers = [];
    appendAll(clear(head),
      h('div', { class: 'notice stack tight' }, h('strong', null, 'Suggested split'),
        h('p', { class: 'small' }, `${all.reduce((n, c) => n + c.students.length, 0)} students in ${all.length} class${all.length === 1 ? '' : 'es'} of up to ${sg.ratio}, grouped by level then age. Move students between classes (drag, or tap a name), pick instructors, then press Use this split. Families whose child changes class are told.`),
        sg.left_out.length ? h('p', { class: 'small' }, `${sg.left_out.length} not checked in yet and left out: ${sg.left_out.map((s) => s.first_name).join(', ')}.`) : null,
        h('div', { class: 'row' }, h('label', null, 'Split ', fromPick),
          isManager() ? button('Use this split', () => useSplit(), { kind: 'primary' }) : h('span', { class: 'muted small' }, 'A manager presses Use this split.'),
          button('Add a class', () => { all.push({ session_id: null, color: 'New', level_min: null, level_max: null, students: [], instructor_id: null, instructor: null }); drawSuggestion(); }),
          button('Cancel', () => { suggestion = null; draw(); }))));
    const relevel = (c) => { const lv = c.students.map((s) => s.level).filter(Boolean); if (lv.length) { c.level_min = Math.min(...lv); c.level_max = Math.max(...lv); } };
    const moveIn = (id, target) => {
      const src = all.find((c) => c.students.some((s) => s.booking_id === id));
      if (!src || src === target) return;
      const s = src.students.find((x) => x.booking_id === id);
      src.students = src.students.filter((x) => x.booking_id !== id);
      target.students.push(s);
      relevel(src); relevel(target);
      drawSuggestion();
    };
    const pickFor = (s) => {
      const opts = all.map((c, i) => [String(i), `${c.color === 'New' ? `New class ${i + 1}` : `${c.color} class`}${c.instructor ? `, ${c.instructor}` : ''}`]);
      const sel = select(opts, String(all.findIndex((c) => c.students.includes(s))), { name: 'to' });
      formDialog(`Move ${s.first_name} to`, h('div', { class: 'form' }, field('Class', sel)), async () => { moveIn(s.booking_id, all[Number(sel.value)]); });
    };
    const cols = all.map((c, i) => {
      const lvMin = select([['', 'Lowest'], ...levelOptions(b.lineup.discipline)], c.level_min ? String(c.level_min) : '', { 'aria-label': `Lowest level, class ${i + 1}` });
      const lvMax = select([['', 'Highest'], ...levelOptions(b.lineup.discipline)], c.level_max ? String(c.level_max) : '', { 'aria-label': `Highest level, class ${i + 1}` });
      lvMin.addEventListener('change', () => { c.level_min = Number(lvMin.value) || null; });
      lvMax.addEventListener('change', () => { c.level_max = Number(lvMax.value) || null; });
      const teach = select([['', c.needs_instructor ? 'Nobody free and cleared' : 'No instructor'], ...(c.instructor_id ? [[String(c.instructor_id), c.instructor]] : [])], c.instructor_id ? String(c.instructor_id) : '', { 'aria-label': `Instructor, class ${i + 1}`, class: 'lu-teach' });
      teach.addEventListener('change', () => { c.instructor_id = Number(teach.value) || null; c.instructor = teach.selectedOptions[0] ? teach.selectedOptions[0].textContent : null; });
      teachers.push([teach, c]);
      const col = h('section', { class: 'lu-col suggest', 'aria-label': `Class ${i + 1}` },
        h('header', { class: 'stack tight' }, h('div', { class: 'row between' }, h('strong', null, swatch(c.color === 'New' ? null : c.color), ` ${c.session_id ? `${c.color} class` : `New class ${i + 1}`}`), h('span', { class: 'muted small' }, `${c.students.length} of ${sg.ratio}`)),
          c.students.length > sg.ratio ? state('Over the class size', 'warn') : null,
          c.instructor_problem ? h('div', { class: 'small' }, state(`${c.was_instructor}: ${c.instructor_problem}`, 'warn')) : null,
          teach, h('div', { class: 'row tight' }, lvMin, lvMax)),
        c.students.length ? h('ul', { class: 'plain lu-chips' }, c.students.map((s) => studentChip(s, { onPick: pickFor }))) : h('p', { class: 'muted small lu-empty' }, 'Empty. Drop students here.'));
      dropZone(col, (id) => moveIn(id, c));
      return col;
    });
    const empties = (sg.empty || []).length ? h('p', { class: 'muted small' }, `${sg.empty.length} class${sg.empty.length === 1 ? ' is' : 'es are'} not needed and stay empty: cancel them from Lessons, or keep them for walk-ups.`) : null;
    appendAll(clear(boardEl), ...cols);
    if (empties) head.append(empties);
    // the instructors who can take each class (free, cleared, kids): the same list for each, minus those picked elsewhere
    get('/skischool/lineup-teachers?lineup_id=' + b.lineup.id).then((r) => {
      for (const [sel, c] of teachers) {
        const cur = sel.value;
        // free and cleared for this class's highest level (the server refuses anything else when the split is used)
        const ok = r.data.filter((t) => c.instructor_id === t.id || (!t.problem && (!t.max || !c.level_max || t.max >= c.level_max)));
        clear(sel).append(h('option', { value: '' }, 'No instructor'), ...ok.map((t) => h('option', { value: String(t.id) }, `${t.name}${t.max ? ` (to Level ${t.max})` : ''}`)));
        sel.value = cur;
      }
    }).catch(() => {});
  }
  async function useSplit() {
    const sg = suggestion;
    const classes = sg.classes.filter((c) => c.session_id || c.students.length).map((c) => ({ session_id: c.session_id || null, booking_ids: c.students.map((s) => s.booking_id),
      instructor_id: c.instructor_id || null, level_min: c.level_min || null, level_max: c.level_max || null }));
    try {
      const r = await post(`/skischool/lineups/${b.lineup.id}/apply`, { classes });
      toast(`Split saved. ${r.moved} student${r.moved === 1 ? '' : 's'} moved and their families told.`);
      suggestion = null;
      b = r.board;
      draw();
    } catch (err) { fail(err); }
  }

  await loadDay();
  // late changes (a walk-up, a late instructor, a family checking in by link) show without a reload
  const poll = setInterval(() => {
    if (!wrap.isConnected) { clearInterval(poll); return; }
    if (!suggestion && document.visibilityState !== 'hidden') loadBoard();
  }, 15000);
}

// ---------------------------------------------------------------- settings
export const settingsPages = {
  lineup: { title: 'Check-in and lineup', who: 'manager', render: async (panel) => {
    const s = await get('/skischool/settings');
    const kids = input({ type: 'number', min: 1, max: 20, value: s.ratio_kids, name: 'ratio_kids' });
    const adults = input({ type: 'number', min: 1, max: 20, value: s.ratio_adults, name: 'ratio_adults' });
    const link = toggle({ checked: Boolean(s.checkin_link), name: 'checkin_link' });
    const save = button('Save', async () => {
      const k = Number(kids.value); const a = Number(adults.value);
      if (!(k >= 1 && k <= 20) || !(a >= 1 && a <= 20)) throw new Error('A class size is 1 to 20 students');
      await patch('/skischool/settings', { ratio_kids: k, ratio_adults: a, checkin_link: link.checked });
      toast('Saved');
    }, { kind: 'primary' });
    panel.append(card('Check-in and lineup', [
      row('Kids per instructor', amount(kids, 'students'), 'Class size when the lineup splits a kids lesson (ages 12 and under).'),
      row('Adults and teens per instructor', amount(adults, 'students'), 'Class size for every other group lesson.'),
      row('"We\'re here" link', link, 'Families can check in from their lesson link, from 90 minutes before the lesson.'),
    ], { intro: 'How the 9:45 lineup splits groups, and how families check in.', actions: save }));
  } },
};
