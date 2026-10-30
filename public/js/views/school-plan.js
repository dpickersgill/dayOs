// Lesson planning, best of breed (2026.11.9), Track PLAN: the season plan, in Ski school, Planning, Season plan.
// tabs(ctx) returns [key, label, render] items; school.js places them in its groups.
//   A plan has day types (Weekday, Weekend, Holiday, Holiday week, Closed, up to 6), each with its lesson slots and private
//   lesson hours; a day type for each weekday; periods (a date range on one day type); and changes for single days. The
//   calendar shows a month at a time. Check, then Publish makes the lessons; a publish can be undone while nothing in it
//   is booked. drawMonth() is shared with the fill view (school-staff.js).
import { get, post, put, del } from '../api.js';
import { h, clear, schoolCan, table, state, input, select, field, button, toast, formDialog, dialog, confirmDialog, val, num, todayStr, addDays, fmtDay, fmtDateTime, label, empty, errorBox, fail, appendAll, loading, hashParam, withHashParam, tabs as tabBar } from '../ui.js';
import { levelOptions, levelRange } from '../levels.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DISCIPLINES = [['ski', 'Ski'], ['snowboard', 'Snowboard'], ['telemark', 'Telemark'], ['adaptive', 'Adaptive']];
const FORMATS = [['group', 'Group'], ['semi_private', 'Semi-private (2 to 4)'], ['private', 'Private']];
const COLOR_NAMES = { '#2f6fb0': 'Blue', '#2e8b57': 'Green', '#c0392b': 'Red', '#b8860b': 'Gold', '#7f8c8d': 'Gray', '#8e44ad': 'Purple' };
const LENGTH_WORDS = { 30: '30 minutes', 45: '45 minutes', 60: '1 hour', 90: '1 and a half hours', 120: '2 hours', 180: '3 hours', 240: '4 hours', 360: 'Full day (6 hours)' };

const clock = (t) => { if (!t) return ''; const [hh, mm] = String(t).split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };
const day = (d) => fmtDay(`${d} 12:00:00`);
const plural = (n, one, many) => `${Number(n).toLocaleString('en-US')} ${n === 1 ? one : many || `${one}s`}`;
const ages = (s) => (s.age_min == null && s.age_max == null ? 'All ages' : s.age_max == null ? `Ages ${s.age_min}+` : s.age_min == null ? `Up to age ${s.age_max}` : `Ages ${s.age_min} to ${s.age_max}`);
const weekdayOf = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
const newKey = (p = 's') => `${p}${Math.random().toString(36).slice(2, 8)}`;
const copyOf = (o) => JSON.parse(JSON.stringify(o));

export function tabs() {
  return schoolCan('director') ? [['season', 'Season plan', (p) => render(p)]] : [];
}

// ---------------------------------------------------------------- the month calendar, shared with the fill view
/**
 * Draws a month (YYYY-MM) as a seven-column grid, Sunday first; on a phone it reads as a list of days by week.
 * days: [{ date, ... }] (days missing from the list show only their number); renderDay(day) returns the cell's content.
 */
export function drawMonth(container, month, days, renderDay) {
  const first = `${month}-01`;
  const byDate = new Map(days.map((d) => [d.date, d]));
  const grid = h('div', { class: 'plan-month', role: 'grid', 'aria-label': monthName(month) });
  grid.append(h('div', { class: 'plan-week plan-head', role: 'row' }, SHORT_DAYS.map((d, i) => h('div', { role: 'columnheader', 'aria-label': WEEKDAYS[i] }, d))));
  let d = addDays(first, -weekdayOf(first));
  while (d.slice(0, 7) <= month) {
    let any = false;
    for (let i = 0; i < 7; i += 1) if (byDate.has(addDays(d, i)) && addDays(d, i).slice(0, 7) === month) any = true;
    const week = h('div', { class: `plan-week${any ? '' : ' plan-week-empty'}`, role: 'row' });
    for (let i = 0; i < 7; i += 1) {
      const inMonth = d.slice(0, 7) === month;
      const info = byDate.get(d);
      const cell = h('div', { class: `plan-cell${inMonth ? '' : ' plan-out'}${info ? '' : ' plan-none'}${d === todayStr() ? ' plan-today' : ''}`, role: 'gridcell' });
      if (inMonth) {
        cell.append(h('span', { class: 'plan-num', 'aria-hidden': 'true' }, String(Number(d.slice(8)))), h('span', { class: 'plan-dayname' }, day(d)));
        if (info) { const c = renderDay(info); if (c) cell.append(c); }
      }
      week.append(cell);
      d = addDays(d, 1);
    }
    grid.append(week);
  }
  clear(container).append(grid);
  return grid;
}
function monthName(month) { return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(`${month}-01T12:00:00Z`)); }
const nextMonth = (m, k) => { const [y, mo] = m.split('-').map(Number); const t = new Date(Date.UTC(y, mo - 1 + k, 1)); return t.toISOString().slice(0, 7); };

// ---------------------------------------------------------------- the plan list
async function render(root) {
  const id = Number(hashParam('plan')) || null;
  if (id) return editor(root, id);
  return planList(root);
}

const go = (planId) => {
  // The open plan is ?plan= in the address, so a refresh or a shared link opens it again.
  let hash = withHashParam('plan', planId ? String(planId) : null);
  if (!planId) for (const k of ['part', 'month']) hash = withHashParam(k, null, hash);
  try { history.pushState(null, '', hash); } catch (_) { /* the page still changes */ }
};

async function planList(root) {
  const [{ data }, patterns] = await Promise.all([get('/skischool/plans'), get('/skischool/plan-patterns').catch(() => ({ data: [] }))]);
  const open = (p) => { go(p.id); editor(clear(root), p.id); };
  const statusOf = (p) => (p.status === 'published' ? state('Published', 'good') : state('Draft', 'neutral'));
  appendAll(clear(root),
    h('div', { class: 'row between' },
      h('div', null, h('h2', null, 'Season plan'), h('p', { class: 'muted' }, 'Set up the season\'s lessons once: the lesson times for each kind of day, then publish. Guests can book them as soon as they are published.')),
      button('New plan', () => newPlan(data, patterns.data, open), { kind: 'primary' })),
    data.length ? table([
      { head: 'Plan', cell: (p) => h('strong', null, p.name) },
      { head: 'Dates', cell: (p) => `${day(p.from_on)} to ${day(p.to_on)}` },
      { head: 'Status', cell: statusOf },
      { head: 'Lessons', num: true, cell: (p) => p.lessons.toLocaleString('en-US') },
      { head: '', actions: true, cell: (p) => button('Open', () => open(p), { small: true, label: `Open ${p.name}` }) },
    ], data) : empty('No plans yet. A plan is the season\'s lesson times: start one, add the lesson times for a weekday and a weekend day, and publish.', button('Start a plan', () => newPlan(data, patterns.data, open), { kind: 'primary' })),
    patterns.data.length ? h('section', { class: 'stack plan-patterns' }, h('h3', null, 'Saved patterns'),
      h('p', { class: 'muted small' }, 'A pattern is a plan\'s day types and weekdays, saved to start next season\'s plan.'),
      table([
        { head: 'Pattern', cell: (p) => h('strong', null, p.name) },
        { head: 'Day types', cell: (p) => p.day_types.join(', ') },
        { head: 'Lesson times', num: true, cell: (p) => String(p.slots) },
        { head: '', actions: true, cell: (p) => button('Delete', () => confirmDialog(`Delete the pattern ${p.name}?`, 'Plans started from it stay as they are.', 'Delete pattern', async () => { await del(`/skischool/plan-patterns/${p.id}`); toast('Pattern deleted'); await planList(root); }, { danger: true }), { small: true, kind: 'quiet', label: `Delete ${p.name}` }) },
      ], patterns.data)) : null);
}

function newPlan(plans, patterns, open) {
  const t = todayStr();
  const startFrom = select([['blank', 'Five day types, no lesson times yet'], ...patterns.map((p) => [`pattern:${p.id}`, `Saved pattern: ${p.name}`]), ...plans.map((p) => [`plan:${p.id}`, `A copy of ${p.name}`])], patterns.length ? `pattern:${patterns[0].id}` : 'blank', { name: 'start' });
  formDialog('New season plan', [
    field('Name', input({ name: 'name', required: true, maxlength: 80, placeholder: 'For example: Winter 2026-27' })),
    h('div', { class: 'plan-pair' }, field('First day', input({ type: 'date', name: 'from_on', value: t, required: true })), field('Last day', input({ type: 'date', name: 'to_on', value: addDays(t, 120), required: true }), 'At most 200 days')),
    field('Start from', startFrom, 'A copy keeps the day types and lesson times, not the periods or single-day changes'),
  ], async (fd) => {
    const s = val(fd, 'start') || 'blank';
    const body = { name: val(fd, 'name') || '', from_on: val(fd, 'from_on'), to_on: val(fd, 'to_on') };
    if (s.startsWith('pattern:')) body.pattern_id = Number(s.slice(8));
    if (s.startsWith('plan:')) body.copy_of = Number(s.slice(5));
    const p = await post('/skischool/plans', body);
    toast('Plan started');
    open(p);
  }, { submitText: 'Start the plan' });
}

// ---------------------------------------------------------------- the editor
async function editor(root, planId) {
  clear(root).append(loading('Opening the plan'));
  let plan; let opts;
  try { [plan, opts] = await Promise.all([get(`/skischool/plans/${planId}`), get('/skischool/plans/options')]); } catch (err) { clear(root).append(errorBox(err), button('All plans', () => { go(null); planList(clear(root)); })); return; }
  const products = new Map(opts.products.map((p) => [p.id, p]));
  const people = new Map(opts.instructors.map((p) => [p.id, p.name]));
  const head = h('div', { class: 'plan-head-card card stack' });
  const body = h('div');
  const ctx = { plan, opts, products, people, save, redraw: () => drawHead() };

  async function save(doc, what = 'Saved') {
    const next = await put(`/skischool/plans/${planId}`, { doc });
    ctx.plan = plan = next;
    drawHead();
    if (what) toast(what);
    return next;
  }
  function drawHead() {
    plan = ctx.plan;
    const st = plan.status !== 'published' ? state('Draft: not published yet', 'neutral') : plan.unpublished ? state('Changes not published yet', 'warn') : state('Published', 'good');
    appendAll(clear(head),
      h('div', { class: 'row between' },
        h('div', null, h('h2', null, plan.name), h('p', { class: 'muted' }, `${day(plan.from_on)} to ${day(plan.to_on)}. ${plural(plan.lessons, 'lesson')} made so far.`)),
        h('div', { class: 'row' }, st)),
      h('div', { class: 'row wrap' },
        button('All plans', () => { go(null); planList(clear(root)); }, { small: true }),
        button('Name and dates', () => editPlan(), { small: true }),
        button('Save as pattern', () => savePattern(), { small: true }),
        !plan.published_ever ? button('Delete plan', () => confirmDialog(`Delete ${plan.name}?`, 'It has never been published, so no lessons go with it.', 'Delete plan', async () => { await del(`/skischool/plans/${planId}`); toast('Plan deleted'); go(null); await planList(clear(root)); }, { danger: true }), { small: true, kind: 'quiet' }) : null));
  }
  function editPlan() {
    formDialog('Name and dates', [
      field('Name', input({ name: 'name', value: plan.name, required: true, maxlength: 80 })),
      h('div', { class: 'plan-pair' }, field('First day', input({ type: 'date', name: 'from_on', value: plan.from_on })), field('Last day', input({ type: 'date', name: 'to_on', value: plan.to_on }), 'At most 200 days')),
    ], async (fd) => {
      ctx.plan = plan = await put(`/skischool/plans/${planId}`, { name: val(fd, 'name') || '', from_on: val(fd, 'from_on'), to_on: val(fd, 'to_on') });
      drawHead(); toast('Saved');
    });
  }
  function savePattern() {
    formDialog('Save as pattern', [h('p', { class: 'muted' }, 'Saves the day types, their lesson times and private hours, and the weekdays. Start next season\'s plan from it.'),
      field('Pattern name', input({ name: 'name', required: true, maxlength: 80, value: plan.name }))], async (fd) => {
      await post('/skischool/plan-patterns', { name: val(fd, 'name') || '', plan_id: planId });
      toast('Pattern saved');
    });
  }
  drawHead();
  const parts = [
    ['types', 'Day types', (p) => dayTypesPart(p, ctx)],
    ['days', 'Weekdays and periods', (p) => weekdaysPart(p, ctx)],
    ['calendar', 'Calendar', (p) => calendarPart(p, ctx)],
    ['publish', 'Check and publish', (p) => publishPart(p, ctx)],
    ['history', 'History', (p) => historyPart(p, ctx)],
  ];
  const bar = tabBar(parts.map(([k, t, fn]) => [k, t, (p) => { const box = h('div', { class: 'stack' }); p.append(box); return fn(box); }]), 'types', { param: 'part' });
  bar.classList.add('plan-parts');
  body.append(bar);
  clear(root).append(h('div', { class: 'stack plan-editor' }, head, body));
}

// ---------------------------------------------------------------- (1) day types
function slotWords(s, products) {
  const p = products.get(s.product_id);
  return `${clock(s.start)} ${p ? p.name : 'Unknown product'}`;
}

function dayTypesPart(root, ctx) {
  const draw = () => {
    const doc = ctx.plan.doc;
    const cards = doc.day_types.map((t, i) => typeCard(t, i, ctx, draw));
    appendAll(clear(root),
      h('p', { class: 'muted' }, 'Each kind of day has its own lesson times. A pool is a time guests book (the lineup sorts students into classes by level). A set class has a fixed level range and spots, for clinics, adaptive lessons and camps.'),
      ...cards,
      doc.day_types.length < ctx.opts.max_types ? h('div', { class: 'row' }, button('Add a day type', () => editType(null, ctx, draw))) : h('p', { class: 'muted small' }, `A plan has at most ${ctx.opts.max_types} day types.`));
  };
  draw();
}

function typeCard(t, i, ctx, draw) {
  const doc = ctx.plan.doc;
  const used = doc.weekdays.filter((k) => k === t.key).length;
  const p = t.private;
  const privateLine = t.closed ? null : p ? `Private lessons ${clock(p.start)} to ${clock(p.end)}, ${p.lengths.map((n) => LENGTH_WORDS[n] || `${n} minutes`).join(', ')}, ${p.at_once ? `at most ${p.at_once} at once` : 'as many as instructors allow'}.` : 'Private lessons: no set hours (any time instructors are free).';
  const mutate = async (fn, what) => { const d = copyOf(ctx.plan.doc); fn(d); try { await ctx.save(d, what); draw(); } catch (err) { fail(err); } };
  const slotsTable = t.slots.length ? table([
    { head: 'Time', cell: (s) => `${clock(s.start)} to ${clock(s.end)}` },
    { head: 'Lesson', cell: (s) => h('span', null, h('strong', null, (ctx.products.get(s.product_id) || {}).name || 'Unknown product'), h('div', { class: 'muted small' }, `${s.kind === 'pool' ? 'Pool' : `Set class, ${label(s.format)}`}, ${label(s.discipline)}`)) },
    { head: 'Levels and ages', cell: (s) => h('span', null, levelRange(s.level_min, s.level_max), h('div', { class: 'muted small' }, ages(s))) },
    { head: 'Spots', num: true, cell: (s) => h('span', null, String(s.spots), h('div', { class: 'muted small' }, (s.spots_mode || (s.kind === 'pool' ? ctx.opts.pool_spots_mode : 'fixed')) === 'staff' ? 'Follows staff' : 'Fixed')) },
    { head: 'Meet at', cell: (s) => s.meeting_place || h('span', { class: 'muted' }, 'Not set') },
    { head: 'Instructor', cell: (s) => (s.instructor_id ? ctx.people.get(s.instructor_id) || 'Not an instructor now' : h('span', { class: 'muted' }, 'Assign later')) },
    { head: '', actions: true, cell: (s) => h('div', { class: 'row' },
      button('Edit', () => slotDialog(s, ctx, (n) => mutate((d) => { const tt = d.day_types[i]; tt.slots = tt.slots.map((x) => (x.key === s.key ? n : x)); }, 'Lesson time saved')), { small: true, label: `Edit ${slotWords(s, ctx.products)}` }),
      button('Copy', () => slotDialog({ ...s, key: newKey() }, ctx, (n) => mutate((d) => { d.day_types[i].slots.push(n); }, 'Lesson time added'), 'Copy lesson time'), { small: true, label: `Copy ${slotWords(s, ctx.products)}` }),
      button('Remove', () => confirmDialog('Remove this lesson time?', `${slotWords(s, ctx.products)} on every ${t.name} day. Lessons already made stay until you publish and tick Also remove.`, 'Remove', () => mutate((d) => { d.day_types[i].slots = d.day_types[i].slots.filter((x) => x.key !== s.key); }, 'Lesson time removed'), { danger: true }), { small: true, kind: 'quiet', label: `Remove ${slotWords(s, ctx.products)}` })) },
  ], [...t.slots].sort((a, b) => a.start.localeCompare(b.start))) : h('p', { class: 'muted' }, t.closed ? 'Closed: no lessons and no private lessons on these days.' : 'No lesson times yet.');
  return h('section', { class: 'card stack plan-type', style: `--type:${t.color}`, 'aria-label': t.name },
    h('div', { class: 'row between' },
      h('h3', null, h('span', { class: 'plan-swatch', 'aria-hidden': 'true' }), t.name, t.closed && t.name.toLowerCase() !== 'closed' ? h('span', { class: 'muted small' }, ' (closed)') : null),
      h('span', { class: 'muted small' }, used ? `Used on ${plural(used, 'weekday')}` : 'Not a weekday default')),
    slotsTable,
    privateLine ? h('p', { class: 'small' }, privateLine) : null,
    h('div', { class: 'row wrap' },
      t.closed ? null : button('Add a lesson time', () => slotDialog(null, ctx, (n) => mutate((d) => { d.day_types[i].slots.push(n); }, 'Lesson time added')), { kind: 'primary', small: true, label: `Add a lesson time to ${t.name}` }),
      t.closed ? null : button('Load a day template', () => loadTemplate(ctx, (slots) => mutate((d) => { d.day_types[i].slots.push(...slots); }, `${plural(slots.length, 'lesson time')} added`)), { small: true, label: `Load a day template into ${t.name}` }),
      t.closed ? null : button(p ? 'Private hours' : 'Set private hours', () => privateDialog(t, (np) => mutate((d) => { d.day_types[i].private = np; }, 'Private hours saved')), { small: true, label: `Private hours for ${t.name}` }),
      button('Rename', () => editType(t, ctx, draw), { small: true, label: `Rename ${t.name}` }),
      ctx.plan.doc.day_types.length > 1 ? button('Remove day type', () => {
        const inUse = ctx.plan.doc.weekdays.includes(t.key) || ctx.plan.doc.periods.some((x) => x.day_type === t.key) || ctx.plan.doc.exceptions.some((x) => x.day_type === t.key);
        if (inUse) { toast(`${t.name} is used by a weekday, a period or a single day. Change those first.`, 'error'); return; }
        confirmDialog(`Remove ${t.name}?`, 'Its lesson times go with it.', 'Remove day type', () => mutate((d) => { d.day_types.splice(i, 1); }, 'Day type removed'), { danger: true });
      }, { small: true, kind: 'quiet', label: `Remove ${t.name}` }) : null));
}

function editType(t, ctx, draw) {
  const colors = ctx.opts.colors.map((c) => [c, COLOR_NAMES[c] || c]);
  const used = new Set(ctx.plan.doc.day_types.map((x) => x.color));
  const closed = h('input', { type: 'checkbox', name: 'closed', checked: Boolean(t && t.closed) });
  formDialog(t ? `Rename ${t.name}` : 'Add a day type', [
    field('Name', input({ name: 'name', required: true, maxlength: 40, value: t ? t.name : '', placeholder: 'For example: Spring weekend' })),
    field('Color on the calendar', select(colors, t ? t.color : (ctx.opts.colors.find((c) => !used.has(c)) || ctx.opts.colors[0]), { name: 'color' })),
    h('label', { class: 'check' }, closed, ' Closed: no lessons and no private lessons on these days'),
  ], async (fd) => {
    const d = copyOf(ctx.plan.doc);
    const name = val(fd, 'name') || '';
    if (t) { const x = d.day_types.find((y) => y.key === t.key); x.name = name; x.color = val(fd, 'color'); x.closed = closed.checked; if (x.closed) { x.slots = []; x.private = null; } } else {
      let k = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 16) || 'type';
      while (d.day_types.some((y) => y.key === k)) k = `${k.slice(0, 14)}${Math.floor(Math.random() * 90 + 10)}`;
      d.day_types.push({ key: k, name, color: val(fd, 'color'), closed: closed.checked, slots: [], private: null });
    }
    await ctx.save(d, 'Day type saved');
    draw();
  });
}

/** The lesson time dialog: pool or set class, product, times, discipline, levels, ages, spots, meeting place, instructor. */
function slotDialog(cur, ctx, done, title) {
  const s = cur || { key: newKey(), start: '09:30', end: '11:30', product_id: (ctx.opts.products.find((p) => p.active) || ctx.opts.products[0] || {}).id, kind: 'pool', format: 'group', discipline: 'ski', spots: 40, spots_mode: ctx.opts.pool_spots_mode };
  if (!ctx.opts.products.length) { toast('Add a lesson product first, in Products.', 'error'); return; }
  const kindPool = h('input', { type: 'radio', name: 'kind', value: 'pool', checked: s.kind === 'pool' });
  const kindClass = h('input', { type: 'radio', name: 'kind', value: 'class', checked: s.kind !== 'pool' });
  const kinds = h('fieldset', { class: 'wx-choices plan-kinds' }, h('legend', null, 'Kind of lesson time'),
    h('label', { class: 'wx-choice' }, kindPool, h('span', null, h('strong', null, 'Pool'), h('small', null, 'Guests book the time. The lineup sorts them into classes by level.'))),
    h('label', { class: 'wx-choice' }, kindClass, h('span', null, h('strong', null, 'Set class'), h('small', null, 'A fixed level range and spots: clinics, adaptive, camps.'))));
  const format = select(FORMATS, s.format || 'group', { name: 'format' });
  const formatField = field('Type', format);
  const disc = select(DISCIPLINES, s.discipline || 'ski', { name: 'discipline' });
  const lmin = select([['', 'Any'], ...levelOptions(s.discipline || 'ski')], s.level_min || '', { name: 'level_min' });
  const lmax = select([['', 'Any'], ...levelOptions(s.discipline || 'ski')], s.level_max || '', { name: 'level_max' });
  disc.addEventListener('change', () => { for (const el of [lmin, lmax]) { const v = el.value; clear(el); for (const [k, t] of [['', 'Any'], ...levelOptions(disc.value)]) el.append(h('option', { value: k, selected: k === v }, t)); } });
  const follows = h('input', { type: 'checkbox', name: 'follows', checked: (s.spots_mode || (s.kind === 'pool' ? ctx.opts.pool_spots_mode : 'fixed')) === 'staff' });
  const spots = input({ type: 'number', name: 'spots', min: 1, max: 200, value: s.spots, required: true, inputmode: 'numeric' });
  const levelHint = h('span', { class: 'hint' }, 'A pool fits every level unless you set a range');
  const sync = () => {
    const pool = kindPool.checked;
    formatField.hidden = pool;
    levelHint.textContent = pool ? 'A pool fits every level unless you set a range' : 'The levels this class teaches';
    spots.max = pool ? 200 : ({ group: 60, semi_private: 4, private: 6 }[format.value]);
  };
  // A new lesson time starts with the school's choice for pools (Settings) and fixed spots for set classes.
  const kindChanged = () => { if (!cur) follows.checked = kindPool.checked ? ctx.opts.pool_spots_mode === 'staff' : false; sync(); };
  kindPool.addEventListener('change', kindChanged); kindClass.addEventListener('change', kindChanged); format.addEventListener('change', sync);
  const instr = select([['', 'Assign later'], ...ctx.opts.instructors.map((p) => [p.id, p.name])], s.instructor_id || '', { name: 'instructor_id' });
  const cert = select([['', 'None'], ...ctx.opts.certifications.map((c) => [c.id, c.name])], s.cert || '', { name: 'cert' });
  const ratioWords = `Kids lessons (12 and under) use ${ctx.opts.ratio_kids} students per instructor, others ${ctx.opts.ratio_adults}.`;
  formDialog(title || (cur ? 'Edit lesson time' : 'Add a lesson time'), [
    kinds,
    h('div', { class: 'plan-pair' }, field('Starts', input({ type: 'time', name: 'start', value: s.start, required: true, step: 300 })), field('Ends', input({ type: 'time', name: 'end', value: s.end, required: true, step: 300 }))),
    field('Lesson product', select(ctx.opts.products.map((p) => [p.id, p.active ? p.name : `${p.name} (not on sale)`]), s.product_id, { name: 'product_id' }), 'Sets the price guests pay'),
    formatField,
    field('Discipline', disc),
    h('div', { class: 'plan-pair' }, h('label', { class: 'field' }, 'Lowest level', lmin, levelHint), field('Highest level', lmax)),
    h('div', { class: 'plan-pair' }, field('Youngest age', input({ type: 'number', name: 'age_min', min: 0, max: 99, value: s.age_min ?? '', inputmode: 'numeric' }), 'Blank: any age'), field('Oldest age', input({ type: 'number', name: 'age_max', min: 0, max: 99, value: s.age_max ?? '', inputmode: 'numeric' }), '12 or under is a kids lesson')),
    field('Spots', spots, 'With Follows staff on, this is the most it can grow to'),
    h('label', { class: 'check' }, follows, ' Follows staff: open spots grow and shrink with the instructors free at that time'),
    h('p', { class: 'muted small' }, ratioWords),
    field('Meet at', input({ name: 'meeting_place', maxlength: 120, value: s.meeting_place || '', placeholder: 'For example: Clock tower' })),
    field('Instructor', instr, 'A named instructor who is busy or not cleared on a day gets Assign later that day'),
    field('Required certification', cert),
  ], async (fd) => {
    const pool = val(fd, 'kind') === 'pool';
    const n = {
      key: s.key, start: val(fd, 'start'), end: val(fd, 'end'), product_id: num(fd, 'product_id'), kind: pool ? 'pool' : 'class', format: pool ? 'group' : val(fd, 'format'),
      discipline: val(fd, 'discipline'), level_min: num(fd, 'level_min') || null, level_max: num(fd, 'level_max') || null,
      age_min: val(fd, 'age_min') === null ? null : num(fd, 'age_min'), age_max: val(fd, 'age_max') === null ? null : num(fd, 'age_max'),
      spots: num(fd, 'spots'), spots_mode: follows.checked ? 'staff' : 'fixed', meeting_place: val(fd, 'meeting_place'), cert: num(fd, 'cert') || null, instructor_id: num(fd, 'instructor_id') || null,
    };
    if (!n.start || !n.end || n.end <= n.start) throw new Error('The end time must be after the start.');
    if (!n.spots || n.spots < 1) throw new Error('Say how many spots.');
    await done(n);
  }, { wide: true });
  sync();
}

function privateDialog(t, done) {
  const p = t.private || { start: '09:00', end: '16:00', at_once: null, lengths: [60, 120, 180, 360] };
  const boxes = Object.entries(LENGTH_WORDS).map(([n, w]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'len', value: n, checked: p.lengths.includes(Number(n)) }), ` ${w}`));
  const limit = h('input', { type: 'checkbox', name: 'limit', checked: p.at_once != null });
  const atOnce = input({ type: 'number', name: 'at_once', min: 1, max: 200, value: p.at_once ?? 4, inputmode: 'numeric' });
  const atField = field('How many at once', atOnce);
  const sync = () => { atField.hidden = !limit.checked; };
  limit.addEventListener('change', sync);
  const dlg = formDialog(`Private lessons on ${t.name} days`, [
    h('p', { class: 'muted' }, 'Guests can ask for a private lesson inside these hours, in the lengths you offer, when an instructor is free.'),
    h('div', { class: 'plan-pair' }, field('From', input({ type: 'time', name: 'start', value: p.start, step: 900 })), field('Until', input({ type: 'time', name: 'end', value: p.end, step: 900 }))),
    h('fieldset', { class: 'plan-lengths' }, h('legend', null, 'Lengths offered'), ...boxes),
    h('label', { class: 'check' }, limit, ' Limit how many privates run at the same time'),
    atField,
    t.private ? h('div', { class: 'row' }, button('No set hours', async () => { await done(null); dlg.close(); }, { small: true, kind: 'quiet' })) : null,
  ], async (fd) => {
    const lengths = fd.getAll('len').map(Number).sort((a, b) => a - b);
    if (!lengths.length) throw new Error('Offer at least one length.');
    await done({ start: val(fd, 'start'), end: val(fd, 'end'), at_once: limit.checked ? num(fd, 'at_once') : null, lengths });
  });
  sync();
}

async function loadTemplate(ctx, done) {
  const { data } = await get('/skischool/plan-templates');
  if (!data.length) { toast('No day templates yet. Save one in Copy a day.', 'error'); return; }
  formDialog('Load a day template', [
    h('p', { class: 'muted' }, 'The template\'s lessons are added as lesson times. Group lessons with no level range become pools.'),
    field('Template', select(data.map((t) => [t.id, `${t.name} (${plural(t.lessons, 'lesson')})`]), data[0].id, { name: 'template' })),
  ], async (fd) => {
    const slots = (await get(`/skischool/plan-templates/${num(fd, 'template')}/slots`)).data;
    const known = new Set(ctx.opts.products.map((p) => p.id));
    await done(slots.filter((s) => known.has(s.product_id)));
  }, { submitText: 'Add lesson times' });
}

// ---------------------------------------------------------------- (2) weekdays and periods
function weekdaysPart(root, ctx) {
  const draw = () => {
    const doc = ctx.plan.doc;
    const types = doc.day_types.map((t) => [t.key, t.name]);
    const sels = WEEKDAYS.map((w, i) => {
      const s = select(types, doc.weekdays[i], { name: `wd${i}`, 'aria-label': `Day type on ${w}` });
      s.addEventListener('change', async () => { const d = copyOf(ctx.plan.doc); d.weekdays[i] = s.value; try { await ctx.save(d, `${w}s saved`); } catch (err) { fail(err); } });
      return field(w, s);
    });
    const typeName = (k) => (doc.day_types.find((t) => t.key === k) || {}).name || k;
    const mutate = async (fn, what) => { const d = copyOf(ctx.plan.doc); fn(d); try { await ctx.save(d, what); draw(); } catch (err) { fail(err); } };
    appendAll(clear(root),
      h('section', { class: 'card stack' }, h('h3', null, 'Each weekday'), h('p', { class: 'muted' }, 'The day type a day gets unless a period, a school holiday or a single-day change says otherwise.'), h('div', { class: 'plan-weekdays' }, ...sels)),
      h('section', { class: 'card stack' }, h('h3', null, 'Periods'),
        h('p', { class: 'muted' }, 'A period uses one day type every day, such as Holiday week from Dec 26 to Jan 1. School holidays (set in Staffing) use the Holiday day type.'),
        doc.periods.length ? table([
          { head: 'Name', cell: (p) => p.name || h('span', { class: 'muted' }, 'No name') },
          { head: 'Dates', cell: (p) => (p.from === p.to ? day(p.from) : `${day(p.from)} to ${day(p.to)}`) },
          { head: 'Day type', cell: (p) => typeName(p.day_type) },
          { head: '', actions: true, cell: (p) => button('Remove', () => mutate((d) => { d.periods = d.periods.filter((x) => !(x.from === p.from && x.to === p.to && x.day_type === p.day_type)); }, 'Period removed'), { small: true, kind: 'quiet', label: `Remove period ${p.name || p.from}` }) },
        ], doc.periods) : h('p', { class: 'muted' }, 'No periods.'),
        h('div', { class: 'row' }, button('Add a period', () => formDialog('Add a period', [
          field('Name', input({ name: 'name', maxlength: 60, placeholder: 'For example: Christmas week' })),
          h('div', { class: 'plan-pair' }, field('First day', input({ type: 'date', name: 'from', value: ctx.plan.from_on, required: true })), field('Last day', input({ type: 'date', name: 'to', value: ctx.plan.from_on, required: true }))),
          field('Day type', select(types, doc.day_types.some((t) => t.key === 'holiday_week') ? 'holiday_week' : types[0][0], { name: 'day_type' })),
        ], async (fd) => {
          const p = { name: val(fd, 'name'), from: val(fd, 'from'), to: val(fd, 'to'), day_type: val(fd, 'day_type') };
          if (!p.from || !p.to || p.to < p.from) throw new Error('The last day must be on or after the first day.');
          const d = copyOf(ctx.plan.doc); d.periods.push(p); await ctx.save(d, 'Period added'); draw();
        })))),
      doc.exceptions.length ? h('section', { class: 'card stack' }, h('h3', null, 'Single-day changes'), h('p', { class: 'muted' }, 'Made on the calendar: tap a day.'),
        table([
          { head: 'Day', cell: (x) => day(x.date) },
          { head: 'Change', cell: (x) => [x.day_type ? `Uses ${typeName(x.day_type)}` : null, x.add.length ? `adds ${plural(x.add.length, 'lesson time')}` : null, x.remove.length ? `removes ${plural(x.remove.length, 'lesson time')}` : null].filter(Boolean).join(', ') },
          { head: '', actions: true, cell: (x) => button('Undo change', () => mutate((d) => { d.exceptions = d.exceptions.filter((y) => y.date !== x.date); }, 'Change removed'), { small: true, kind: 'quiet', label: `Undo the change on ${day(x.date)}` }) },
        ], doc.exceptions)) : null);
  };
  draw();
}

// ---------------------------------------------------------------- (4) the calendar
async function calendarPart(root, ctx) {
  const plan = ctx.plan;
  let month = hashParam('month') && /^\d{4}-\d{2}$/.test(hashParam('month')) ? hashParam('month') : (todayStr() > plan.from_on && todayStr() <= plan.to_on ? todayStr().slice(0, 7) : plan.from_on.slice(0, 7));
  const title = h('h3', { 'aria-live': 'polite' });
  const prev = button('Previous month', () => move(-1), { small: true });
  const next = button('Next month', () => move(1), { small: true });
  const legend = h('div', { class: 'plan-legend' });
  const box = h('div');
  async function move(k) { month = nextMonth(month, k); try { history.replaceState(null, '', withHashParam('month', month)); } catch (_) { /* fine */ } await load(); }
  async function load() {
    title.textContent = monthName(month);
    prev.disabled = month <= ctx.plan.from_on.slice(0, 7);
    next.disabled = month >= ctx.plan.to_on.slice(0, 7);
    clear(box).append(loading());
    try {
      const { days } = await get(`/skischool/plans/${ctx.plan.id}/calendar?month=${month}`);
      clear(legend).append(...ctx.plan.doc.day_types.map((t) => h('span', { class: 'plan-key', style: `--type:${t.color}` }, h('span', { class: 'plan-swatch', 'aria-hidden': 'true' }), t.name)));
      drawMonth(box, month, days, (d) => h('button', { type: 'button', class: `plan-daybtn${d.closed ? ' plan-closed' : ''}`, style: d.color ? `--type:${d.color}` : null, 'aria-label': `${day(d.date)}: ${d.day_name}${d.holiday ? `, ${d.holiday}` : ''}, ${plural(d.slots.length, 'lesson time')}${d.exception ? ', changed for this day' : ''}`, onclick: () => dayDialog(d, ctx, load) },
        h('span', { class: 'plan-type-name' }, d.day_name, d.exception ? ' *' : ''),
        d.holiday ? h('span', { class: 'plan-holiday' }, d.holiday) : null,
        h('span', { class: 'plan-lines' }, ...d.slots.slice(0, 4).map((s) => h('span', null, `${clock(s.start).replace(':00', '')} ${s.product}`)), d.slots.length > 4 ? h('span', null, `and ${d.slots.length - 4} more`) : null),
        h('span', { class: 'plan-count' }, d.closed ? 'Closed' : plural(d.slots.length, 'lesson time')),
        d.booked ? h('span', { class: 'plan-booked' }, `${d.booked} booked`) : null));
    } catch (err) { clear(box).append(errorBox(err)); }
  }
  appendAll(clear(root), h('div', { class: 'row between plan-cal-head' }, prev, title, next), legend, h('p', { class: 'muted small' }, 'Tap a day to change it for that day only. A star marks a day you changed.'), box);
  await load();
}

async function dayDialog(d, ctx, reload) {
  const doc = copyOf(ctx.plan.doc);
  let x = doc.exceptions.find((e) => e.date === d.date);
  if (!x) { x = { date: d.date, day_type: null, add: [], remove: [] }; doc.exceptions.push(x); }
  const types = doc.day_types.map((t) => [t.key, t.name]);
  const baseType = (() => { const keep = x.day_type; x.day_type = null; const t = typeFor(doc, d.date, d.holiday); x.day_type = keep; return t; })();
  const typeSel = select([['', `As planned (${(doc.day_types.find((t) => t.key === baseType) || {}).name || 'none'})`], ...types], x.day_type || '', { 'aria-label': 'Day type for this day' });
  const slotsBox = h('div', { class: 'stack' });
  const booked = h('div', { class: 'stack' }, loading('Looking for lessons on this day'));
  const t = () => doc.day_types.find((y) => y.key === (x.day_type || baseType));
  const drawSlots = () => {
    const tt = t();
    const base = tt && !tt.closed ? tt.slots : [];
    const rowsOf = [...base.map((s) => ({ s, from: 'type' })), ...x.add.map((s) => ({ s, from: 'add' }))].sort((a, b) => a.s.start.localeCompare(b.s.start));
    clear(slotsBox).append(
      tt && tt.closed ? h('p', null, 'Closed this day: no lessons and no private lessons.') : rowsOf.length ? table([
        { head: 'Time', cell: (r) => `${clock(r.s.start)} to ${clock(r.s.end)}` },
        { head: 'Lesson', cell: (r) => h('span', null, (ctx.products.get(r.s.product_id) || {}).name || 'Unknown product', h('div', { class: 'muted small' }, `${r.s.kind === 'pool' ? 'Pool' : 'Set class'}, ${r.s.spots} spots${r.from === 'add' ? ', this day only' : ''}`)) },
        { head: '', actions: true, cell: (r) => (r.from === 'add' ? button('Remove', () => { x.add = x.add.filter((y) => y.key !== r.s.key); drawSlots(); }, { small: true, kind: 'quiet', label: `Remove ${slotWords(r.s, ctx.products)}` })
          : x.remove.includes(r.s.key) ? h('span', null, state('Not this day', 'warn'), ' ', button('Put back', () => { x.remove = x.remove.filter((k) => k !== r.s.key); drawSlots(); }, { small: true, label: `Put back ${slotWords(r.s, ctx.products)}` }))
            : button('Not this day', () => { x.remove.push(r.s.key); drawSlots(); }, { small: true, kind: 'quiet', label: `Remove ${slotWords(r.s, ctx.products)} on this day` })) },
      ], rowsOf) : h('p', { class: 'muted' }, 'No lesson times this day.'),
      tt && tt.closed ? null : h('div', { class: 'row' }, button('Add a lesson time this day', () => slotDialog(null, ctx, (n) => { x.add.push({ ...n, key: newKey('x') }); drawSlots(); }), { small: true })));
  };
  typeSel.addEventListener('change', () => { x.day_type = typeSel.value || null; drawSlots(); });
  const saveBtn = button('Save this day', async () => {
    if (!x.day_type && !x.add.length && !x.remove.length) doc.exceptions = doc.exceptions.filter((e) => e.date !== d.date);
    await ctx.save(doc, `${day(d.date)} saved`);
    dlg.close(); await reload();
  }, { kind: 'primary' });
  const resetBtn = d.exception ? button('Back to the plan', async () => {
    doc.exceptions = doc.exceptions.filter((e) => e.date !== d.date);
    await ctx.save(doc, `${day(d.date)} back to the plan`);
    dlg.close(); await reload();
  }) : null;
  const dlg = dialog(day(d.date), [
    d.holiday ? h('p', null, `School holiday: ${d.holiday}.`) : null,
    field('Day type this day', typeSel),
    h('h3', null, 'Lesson times'), slotsBox,
    h('h3', null, 'Already on this day'), booked,
  ], { wide: true, footer: h('div', { class: 'row' }, resetBtn, saveBtn) });
  drawSlots();
  try {
    const { data } = await get(`/skischool/plans/${ctx.plan.id}/day?date=${d.date}`);
    clear(booked).append(data.length ? table([
      { head: 'Time', cell: (l) => clock(String(l.starts_at).slice(11, 16)) },
      { head: 'Lesson', cell: (l) => h('span', null, l.product, h('div', { class: 'muted small' }, `${l.kind === 'pool' ? 'Pool' : label(l.format)}${l.from_plan ? '' : ', not from this plan'}`)) },
      { head: 'Booked', num: true, cell: (l) => `${l.booked} of ${l.capacity}` },
    ], data) : h('p', { class: 'muted' }, 'No lessons made for this day yet.'));
  } catch (err) { clear(booked).append(errorBox(err)); }
}

/** The day type a day gets from the plan (the server's expand() decides; this mirrors it for the day dialog). */
function typeFor(doc, date, holiday) {
  const x = doc.exceptions.find((e) => e.date === date);
  if (x && x.day_type) return x.day_type;
  const p = [...doc.periods].reverse().find((q) => q.from <= date && q.to >= date);
  if (p) return p.day_type;
  if (holiday && doc.day_types.some((t) => t.key === 'holiday')) return 'holiday';
  return doc.weekdays[weekdayOf(date)];
}

// ---------------------------------------------------------------- (5) check and publish
async function publishPart(root, ctx) {
  const out = h('div', { class: 'stack', 'aria-live': 'polite' });
  appendAll(clear(root),
    h('p', { class: 'muted' }, 'Check shows what publishing does before anything changes. Publishing never changes a lesson that has bookings; those are listed. You can publish again any time.'),
    h('div', { class: 'row' }, button('Check what publishing does', () => check(), { kind: 'primary' })), out);
  async function check() {
    clear(out).append(loading('Checking the plan'));
    let p;
    try { p = await post(`/skischool/plans/${ctx.plan.id}/preview`, {}); } catch (err) { clear(out).append(errorBox(err)); return; }
    const alsoRemove = h('input', { type: 'checkbox' });
    const blocks = p.warnings.filter((w) => w.block);
    const notes = p.warnings.filter((w) => !w.block);
    const removable = p.remove.filter((r) => !r.in_use);
    appendAll(clear(out),
      h('div', { class: 'card stack plan-summary' }, h('p', { class: 'plan-big' }, `${p.words}.`),
        h('p', { class: 'muted' }, `${day(p.from)} to ${day(p.to)}. ${p.counts.private_days ? `Private lesson hours set on ${plural(p.counts.private_days, 'day')}.` : 'No private lesson hours set; privates work as before.'}`)),
      blocks.length ? h('div', { class: 'error-box', role: 'alert' }, h('strong', null, 'This plan cannot be published yet'), h('ul', null, blocks.map((w) => h('li', null, w.text)))) : null,
      notes.length ? h('div', { class: 'notice warn stack' }, h('strong', null, 'Check these'), h('ul', null, notes.map((w) => h('li', null, w.text)))) : null,
      p.assign_later.length ? h('details', { class: 'panel' }, h('summary', null, h('strong', null, `Assign later on ${plural(p.assign_later.length, 'lesson')}`)),
        table([
          { head: 'Day', cell: (a) => day(a.date) }, { head: 'Time', cell: (a) => clock(a.start) }, { head: 'Lesson', cell: (a) => a.product },
          { head: 'Instructor', cell: (a) => h('span', null, a.instructor, h('div', { class: 'muted small' }, a.problem)) },
        ], p.assign_later)) : null,
      p.keep.length ? h('details', { class: 'panel', open: true }, h('summary', null, h('strong', null, `Kept as they are: ${plural(p.keep.length, 'lesson')} with bookings`)),
        h('p', { class: 'muted small' }, 'The plan now says something different for these. Change them one at a time in Lessons if you need to.'),
        table([
          { head: 'Day', cell: (k) => day(k.date) }, { head: 'Time', cell: (k) => clock(k.start) }, { head: 'Lesson', cell: (k) => k.product },
          { head: 'Booked', num: true, cell: (k) => String(k.booked + k.asked) }, { head: 'Differs in', cell: (k) => k.differs.join(', ') },
        ], p.keep)) : null,
      p.update.length ? h('details', { class: 'panel' }, h('summary', null, h('strong', null, `Updated: ${plural(p.update.length, 'lesson')} nobody has booked`)),
        table([{ head: 'Day', cell: (u) => day(u.date) }, { head: 'Time', cell: (u) => clock(u.start) }, { head: 'Lesson', cell: (u) => u.product }, { head: 'Changes', cell: (u) => u.differs.join(', ') }], p.update)) : null,
      p.remove.length ? h('div', { class: 'card stack' }, h('strong', null, `No longer in the plan: ${plural(p.remove.length, 'lesson')}`),
        table([{ head: 'Day', cell: (r) => day(r.date) }, { head: 'Time', cell: (r) => clock(r.start) }, { head: 'Bookings', cell: (r) => (r.in_use ? state(`${r.booked + r.asked + r.waiting} booked or waiting: stays`, 'warn') : 'None') }], p.remove),
        removable.length ? h('label', { class: 'check' }, alsoRemove, ` Also remove the ${plural(removable.length, 'lesson')} nobody has booked`) : null) : null,
      p.create_by_day.length ? h('details', { class: 'panel' }, h('summary', null, h('strong', null, `New lessons by day (${plural(p.create_by_day.length, 'day')})`)),
        table([{ head: 'Day', cell: (c) => day(c.date) }, { head: 'Lessons', num: true, cell: (c) => String(c.create) }, { head: 'Spots', num: true, cell: (c) => c.spots.toLocaleString('en-US') }], p.create_by_day)) : null,
      h('div', { class: 'row' }, p.blocked ? null : button('Publish', () => confirmDialog('Publish this plan?', `${p.words}. Guests can book the new lessons right away. You can undo this publish while nothing in it is booked.`, 'Publish', async () => {
        const r = await post(`/skischool/plans/${ctx.plan.id}/publish`, { remove: alsoRemove.checked });
        toast('Published');
        ctx.plan = await get(`/skischool/plans/${ctx.plan.id}`);
        ctx.redraw();
        appendAll(clear(out), h('div', { class: 'notice good stack' }, h('p', null, h('strong', null, `Published. ${r.words}.`)),
          r.kept.length ? h('p', null, `${plural(r.kept.length, 'lesson')} with bookings kept as they were.`) : null,
          r.assign_later.length ? h('p', null, `${plural(r.assign_later.length, 'lesson')} need an instructor: assign them on the Board or in Staffing.`) : null,
          h('div', { class: 'row' }, button('Undo this publish', () => undoPublish(r.publish_id, ctx, () => clear(out)), { small: true }))));
      }), { kind: 'primary' })));
  }
}

function undoPublish(id, ctx, after) {
  confirmDialog('Undo this publish?', 'The lessons it made that nobody has booked are removed, and lessons it changed go back to how they were. Anything with a booking stays and is listed.', 'Undo publish', async () => {
    const r = await post(`/skischool/plans/publishes/${id}/undo`, {});
    toast(`Undone: ${plural(r.removed, 'lesson')} removed, ${plural(r.restored, 'lesson')} put back`);
    if (r.kept.length) dialog('Some lessons stayed', h('div', { class: 'stack' }, h('p', null, 'These have bookings, so they stay. Cancel them from Lessons if you need to.'), h('ul', null, r.kept.map((k) => h('li', null, `${k.product || 'Lesson'}, ${fmtDateTime(k.starts_at)}, ${plural(k.booked, 'student')}`)))));
    ctx.plan = await get(`/skischool/plans/${ctx.plan.id}`);
    ctx.redraw();
    await after();
  }, { danger: true });
}

// ---------------------------------------------------------------- (6) history
async function historyPart(root, ctx) {
  const { data } = await get(`/skischool/plans/${ctx.plan.id}/publishes`);
  appendAll(clear(root),
    h('p', { class: 'muted' }, 'Each publish, newest first. Only the newest can be undone; undo them one at a time to go further back.'),
    data.length ? table([
      { head: 'When', cell: (x) => fmtDateTime(x.created_at) },
      { head: 'By', cell: (x) => x.by_email || '' },
      { head: 'What it did', cell: (x) => x.summary || `${plural(x.created_n, 'lesson')} added` },
      { head: '', actions: true, cell: (x) => (x.undone_at ? state('Undone', 'neutral') : x.can_undo ? button('Undo', () => undoPublish(x.id, ctx, () => historyPart(root, ctx)), { small: true, label: 'Undo the newest publish' }) : null) },
    ], data) : empty('Not published yet. Check and publish makes the lessons.'));
}

