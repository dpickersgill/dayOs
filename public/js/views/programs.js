// Programs: clubs, camps, leagues and lesson programs.
//   #/programs                    every program
//   #/programs/today              today's program lessons: attendance, and the storm-day cancel
//   #/programs/<id>               one program: its sessions, each with a card per weekday, and its bundles
//   #/programs/<id>/day/<groupId> one weekday group: the children by class, the waitlist, and its lesson dates
// A program can run in sessions (Session 1, Session 2), each meeting weekly on the days the mountain picks, with makeup
// weeks held in reserve for weather. An older program without sessions keeps its single roster.
import { get, post, put, patch, del } from '../api.js';
import { h, clear, can, isManager, money, toCents, centsToInput, table, state, input, select, field, button, toast, formDialog, confirmDialog, dialog, tabs, val, num, todayStr, fmtDate, fmtRange, label, empty, errorBox, fail } from '../ui.js';
import { personPicker } from '../widgets.js';
import { cardDialog } from './school-card.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ageOf = (dob) => { if (!dob) return ''; const d = new Date(`${dob}T12:00:00Z`); const n = new Date(); let a = n.getUTCFullYear() - d.getUTCFullYear(); if (n.getUTCMonth() < d.getUTCMonth() || (n.getUTCMonth() === d.getUTCMonth() && n.getUTCDate() < d.getUTCDate())) a -= 1; return String(a); };
const time12 = (t) => { if (!t) return ''; const [hh, mm] = t.split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')}${hh < 12 ? ' am' : ' pm'}`; };
const shortDate = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${d}T12:00:00Z`));
const back = (href, text) => h('a', { class: 'back-link', href }, `‹ ${text}`);

export async function render(root, params = []) {
  if (params[0] === 'today') return todayView(root);
  if (/^\d+$/.test(params[0] || '')) {
    if (params[1] === 'day' && /^\d+$/.test(params[2] || '')) return dayView(root, Number(params[0]), Number(params[2]));
    return programView(root, Number(params[0]));
  }
  return listView(root);
}

// ================================================================ every program
let typesCache = null;
async function types(force = false) {
  if (!typesCache || force) { try { typesCache = (await get('/programs/types')).data; } catch (_) { typesCache = []; } }
  return typesCache;
}

async function listView(root) {
  const body = h('div', { class: 'stack' });
  const seasonIn = input({ placeholder: 'All seasons', 'aria-label': 'Season' });
  const all = await types(true);
  const typeIn = select([['', 'All types'], ...all.filter((x) => !x.hidden).map((x) => [x.id, x.name])], '', { 'aria-label': 'Type' });
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Programs'),
    h('div', { class: 'row' }, can('instructor') ? h('a', { class: 'btn', href: '#/programs/today' }, "Today's lessons") : null,
      isManager() ? button('Add program', () => editProgram(null, (id) => { location.hash = `#/programs/${id}`; }), { kind: 'primary' }) : null)),
  h('div', { class: 'inline-form' }, field('Type', typeIn), field('Season', seasonIn, 'Such as 2026-27'), button('Filter', () => load())), body);

  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading…'));
    try {
      const ts = await types();
      const qs = `${seasonIn.value.trim() ? `&season=${encodeURIComponent(seasonIn.value.trim())}` : ''}${typeIn.value ? `&type_id=${typeIn.value}` : ''}`;
      const { data } = await get(`/programs?limit=200${qs}`);
      if (!data.length) { clear(body).append(empty('No programs yet. Add one to set up its sessions.')); return; }
      // Grouped by type, in the mountain's order: the same headings parents see online.
      const groups = [...ts.map((x) => [x, data.filter((p) => p.type_id === x.id)]), [{ id: null, name: 'No type' }, data.filter((p) => !p.type_id || !ts.some((x) => x.id === p.type_id))]].filter(([, list]) => list.length);
      clear(body).append(...groups.map(([x, list]) => h('section', { class: 'stack tight' }, h('h2', { class: 'ptype-head' }, x.name, h('span', { class: 'muted small' }, ` ${list.length}`)),
        table([
          { head: 'Program', cell: (p) => h('a', { href: `#/programs/${p.id}` }, h('strong', null, p.name)) },
          { head: 'Season', cell: (p) => p.season },
          { head: 'Online', cell: (p) => (p.online ? state('Registration on', 'good') : '') },
          { head: '', actions: true, cell: (p) => [h('a', { class: 'btn small primary', href: `#/programs/${p.id}` }, 'Open')] },
        ], list))));
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  await load();
}

/** Setup shown in Settings, Programs (managers): registration and reminders, and the program types. */
export const settingsPages = {
  registration: { title: 'Registration and reminders', render: (panel) => drawProgramSettings(panel) },
  types: { title: 'Program types', render: (panel) => drawTypes(panel) },
};

/** The mountain's own list of program types: add, rename, hide, put in order. */
async function drawTypes(panel) {
  const list = h('ol', { class: 'plain ptypes' });
  panel.append(h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'The headings programs are grouped under, here and on the registration page. Hide a type you no longer use; its programs keep it.'), list,
    h('div', { class: 'row' }, button('Add a type', () => formDialog('Add a type', field('Name', input({ name: 'name', required: true, maxlength: 60, placeholder: 'Homeschool, Scouts, Women\'s clinic' })), async (fd) => { await post('/programs/types', { name: val(fd, 'name') }); await draw(); }), { kind: 'primary' }))));
  async function draw() {
    const ts = await types(true);
    clear(list).append(...ts.map((x, i) => h('li', { class: `spread ptype${x.hidden ? ' is-hidden' : ''}` }, h('span', null, h('b', null, x.name), x.hidden ? h('span', { class: 'muted small' }, ' hidden') : null),
      h('span', { class: 'row tight' },
        button('Up', async () => { const ids = ts.map((y) => y.id); [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]; await put('/programs/types/order', { ids }); await draw(); }, { small: true, label: `Move ${x.name} up` }),
        button('Rename', () => formDialog(`Rename ${x.name}`, field('Name', input({ name: 'name', required: true, maxlength: 60, value: x.name })), async (fd) => { await patch(`/programs/types/${x.id}`, { name: val(fd, 'name') }); await draw(); }), { small: true }),
        button(x.hidden ? 'Show' : 'Hide', async () => { await patch(`/programs/types/${x.id}`, { hidden: !x.hidden }); await draw(); }, { small: true, kind: 'quiet' })))));
    const firstUp = list.querySelector('li button'); if (firstUp) firstUp.disabled = true;
    if (!ts.length) list.append(h('li', { class: 'muted' }, 'No types yet.'));
  }
  await draw();
}

/** The mountain's program settings: a pass bought after registering, reminders, weather texts. */
async function drawProgramSettings(panel) {
  const s = await get('/programs/settings');
  const form = h('form', { class: 'stack', novalidate: true },
    h('fieldset', { class: 'plain-set' }, h('legend', null, 'A season pass bought after registering'),
      h('p', { class: 'muted small' }, 'When a child in a program that charged a lift ticket part gets a season pass, at the window or online:'),
      field('Then', select([['none', 'Nothing changes'], ['refund', 'Refund the lift ticket part (to the card it was paid with)'], ['credit', 'Give the family a credit (as a gift card)']], s.pass_later, { name: 'pass_later' })),
      field('How much', select([['unused', 'The share for lessons still to come'], ['full', 'The whole lift ticket part']], s.pass_later_share, { name: 'pass_later_share' }))),
    h('fieldset', { class: 'plain-set' }, h('legend', null, 'Telling families'),
      field('Reminder the day before', select([['first', 'Before the first lesson (and any makeup)'], ['every', 'Before every lesson'], ['off', 'Off']], s.reminders, { name: 'reminders' }), 'By email, with the time, the meeting place and what to bring'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'text_cancellations', checked: s.text_cancellations }), ' Text families when a lesson is canceled for weather (needs text messages set up)')),
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn primary' }, 'Save')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await put('/programs/settings', { pass_later: val(fd, 'pass_later'), pass_later_share: val(fd, 'pass_later_share'), reminders: val(fd, 'reminders'), text_cancellations: Boolean(fd.get('text_cancellations')) });
      toast('Program settings saved');
    } catch (err) { fail(err); }
  });
  panel.append(form);
}

/** A program's own settings: type, who it is for, what the price is made of, discounts, classes and its rules. */
async function editProgram(p, done) {
  let products = [];
  try { products = (await get('/products?limit=200')).data || []; } catch (_) { products = []; }
  const ts = (await types(true)).filter((x) => !x.hidden || (p && p.type_id === x.id));
  const tickets = products.filter((x) => ['day_ticket', 'multi_day', 'punch_card', 'season_pass'].includes(x.kind));
  const rentals = products.filter((x) => x.kind === 'rental');
  const chk = (name, on, text) => h('label', { class: 'check wide' }, h('input', { type: 'checkbox', name, checked: Boolean(on) }), ` ${text}`);
  const f = h('div', { class: 'stack' },
    h('div', { class: 'form' },
      field('Name', input({ name: 'name', required: true, maxlength: 255, value: p ? p.name : '', placeholder: 'After-School Ski & Ride' })),
      field('Type', select([['', 'Choose a type'], ...ts.map((x) => [x.id, x.name])], p ? p.type_id || '' : '', { name: 'type_id' }), 'Manage the list in Settings, Programs'),
      field('Season', input({ name: 'season', required: true, value: p ? p.season : '', placeholder: '2026-27' })),
      field('Youngest age', input({ name: 'age_min', type: 'number', min: 0, max: 99, value: p && p.age_min != null ? p.age_min : '' })),
      field('Oldest age', input({ name: 'age_max', type: 'number', min: 0, max: 99, value: p && p.age_max != null ? p.age_max : '' })),
      field('Ski or snowboard', select([['ski,snowboard', 'Both'], ['ski', 'Ski only'], ['snowboard', 'Snowboard only']], p ? p.disciplines : 'ski,snowboard', { name: 'disciplines' })),
      field('Snowboard from age', input({ name: 'snowboard_age_min', type: 'number', min: 0, max: 99, value: p && p.snowboard_age_min != null ? p.snowboard_age_min : '' }), 'Blank: the same as skiing'),
      field('Meeting place', input({ name: 'meeting_place', maxlength: 160, value: p ? p.meeting_place || '' : '', placeholder: 'The bell outside the ski school' })),
      field('What to bring', input({ name: 'what_to_bring', maxlength: 300, value: p ? p.what_to_bring || '' : '', placeholder: 'Helmet, goggles, a snack' })),
      h('div', { class: 'wide' }, field('Description for parents', h('textarea', { name: 'description', rows: 3, maxlength: 2000 }, p && p.description ? p.description : ''), 'Shown on the online registration page'))),
    h('fieldset', { class: 'plain-set' }, h('legend', null, 'What the price is made of'),
      h('p', { class: 'muted small' }, 'Lessons always. Set each part\'s price on the session.'),
      chk('includes_ticket', p && p.includes_ticket, 'A lift ticket part: not charged when the child has a season pass'),
      field('Ticket product', select([['', 'Choose the ticket'], ...tickets.map((x) => [x.id, x.name])], p ? p.ticket_product_id || '' : '', { name: 'ticket_product_id' }), 'Issued at no extra charge, good on the lesson dates'),
      chk('includes_rental', p && p.includes_rental, 'Rental gear, for those who ask (sizes are taken at registration)'),
      rentals.length ? field('Rental package', select([['', 'None in particular'], ...rentals.map((x) => [x.id, x.name])], p ? p.rental_product_id || '' : '', { name: 'rental_product_id' })) : null,
      chk('offers_helmet', p && p.offers_helmet, 'A helmet, for those who ask')),
    h('fieldset', { class: 'plain-set' }, h('legend', null, 'Discounts and classes'),
      h('div', { class: 'form' },
        field('Sibling discount', select([['none', 'None'], ['percent', 'Percent off'], ['amount', 'Dollars off']], p ? p.sibling_mode : 'none', { name: 'sibling_mode' }), 'On the lessons, for the second and later child'),
        field('Discount', input({ name: 'sibling_value', inputmode: 'decimal', value: p ? (p.sibling_mode === 'amount' ? centsToInput(p.sibling_value) : p.sibling_value || '') : '' }), '10 for 10%, or 25.00 for $25 off'),
        field('Classes by level', select([['on_arrival', 'Split on the first day'], ['preset', 'Preset by the school before the first day']], p ? p.level_mode : 'on_arrival', { name: 'level_mode' })))),
    h('fieldset', { class: 'plain-set' }, h('legend', null, 'Rules for families'),
      h('div', { class: 'form' },
        field('Cancel online up to (days before the first lesson)', input({ name: 'cancel_days', type: 'number', min: 0, max: 365, value: p && p.cancel_days != null ? p.cancel_days : '' }), 'Blank: families call to cancel'),
        field('Cancellation fee ($)', input({ name: 'cancel_fee', inputmode: 'decimal', value: p ? centsToInput(p.cancel_fee_cents || 0) : '0.00' })),
        field('Joining after the first lesson', select([['prorate', 'Allowed: pay for the lessons left'], ['full', 'Allowed: full price'], ['closed', 'Not online (staff can still add)']], p ? p.late_join : 'prorate', { name: 'late_join' }))),
      chk('allow_switch', p ? p.allow_switch : true, 'Families can switch to another day with room, from their family page'),
      chk('ask_safety', p ? p.ask_safety : true, 'Ask for allergies, medical notes and who may pick up'),
      field('Policy shown to parents', h('textarea', { name: 'policy_text', rows: 2, maxlength: 1000 }, p && p.policy_text ? p.policy_text : ''), 'Missed lessons, makeups, refunds: in your words')),
    chk('online', p && p.online, 'Parents can register online'));
  formDialog(p ? `Settings: ${p.name}` : 'Add a program', f, async (fd) => {
    const mode = val(fd, 'sibling_mode');
    const raw = String(fd.get('sibling_value') || '').trim();
    const sv = mode === 'amount' ? toCents(raw || '0') : Number(raw || 0);
    if (sv === null || !Number.isFinite(sv)) throw new Error('The sibling discount is a number, like 10 or 25.00');
    if (fd.get('includes_ticket') && !fd.get('ticket_product_id')) throw new Error('Choose which ticket is issued');
    const fee = toCents(fd.get('cancel_fee') || '0');
    if (fee === null) throw new Error('The cancellation fee is an amount like 25.00');
    const text = (k) => String(fd.get(k) || '').trim() || null;
    const body = {
      name: val(fd, 'name'), type_id: fd.get('type_id') ? Number(fd.get('type_id')) : null, season: val(fd, 'season'), age_min: num(fd, 'age_min'), age_max: num(fd, 'age_max'),
      disciplines: val(fd, 'disciplines'), snowboard_age_min: num(fd, 'snowboard_age_min'), meeting_place: text('meeting_place'), what_to_bring: text('what_to_bring'),
      description: text('description'), online: Boolean(fd.get('online')),
      includes_ticket: Boolean(fd.get('includes_ticket')), ticket_product_id: fd.get('ticket_product_id') ? Number(fd.get('ticket_product_id')) : null,
      includes_rental: Boolean(fd.get('includes_rental')), rental_product_id: fd.get('rental_product_id') ? Number(fd.get('rental_product_id')) : null, offers_helmet: Boolean(fd.get('offers_helmet')),
      sibling_mode: mode, sibling_value: mode === 'none' ? 0 : sv, level_mode: val(fd, 'level_mode'),
      cancel_days: num(fd, 'cancel_days'), cancel_fee_cents: fee, late_join: val(fd, 'late_join'), allow_switch: Boolean(fd.get('allow_switch')), ask_safety: Boolean(fd.get('ask_safety')), policy_text: text('policy_text'),
    };
    const out = p ? await patch(`/programs/${p.id}`, body) : await post('/programs', { ...body, price_cents: 0 });
    toast('Program saved');
    await done(p ? p.id : out.id);
  }, { wide: true });
}

// ================================================================ one program
async function programView(root, id) {
  const page = h('div', { class: 'stack' });
  root.append(page);
  await types();
  async function load() {
    let o;
    try { o = await get(`/programs/${id}/overview`); } catch (err) { clear(page).append(back('#/programs', 'All programs'), errorBox(err)); return; }
    const p = o.program;
    const chips = [
      p.age_min != null || p.age_max != null ? state(`Ages ${p.age_min ?? 0} to ${p.age_max ?? '99'}`) : null,
      p.online ? state('Online registration on', 'good') : state('Not sold online'),
      p.includes_ticket ? state('Lift ticket part (not for pass holders)') : null,
      p.includes_rental ? state('Rental on request') : null,
      p.offers_helmet ? state('Helmet on request') : null,
      p.disciplines !== 'ski,snowboard' ? state(p.disciplines === 'ski' ? 'Ski only' : 'Snowboard only') : null,
      p.cancel_days != null ? state(`Cancel online up to ${p.cancel_days} days before`) : null,
      p.sibling_mode !== 'none' && p.sibling_value ? state(`Siblings ${p.sibling_mode === 'percent' ? `${p.sibling_value}%` : money(p.sibling_value)} off`) : null,
      state(p.level_mode === 'preset' ? 'Classes preset by the school' : 'Classes split on the first day'),
    ];
    const link = `${location.origin}/programs/${o.slug}`;
    clear(page).append(
      back('#/programs', 'All programs'),
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, p.name), h('p', { class: 'muted' }, `${(typesCache || []).find((x) => x.id === p.type_id)?.name || 'No type'}, ${p.season}${p.meeting_place ? `. Meet at ${p.meeting_place}` : ''}`)),
        h('div', { class: 'row' },
          isManager() ? button('New session', () => termDialog(p, null, load), { kind: 'primary' }) : null,
          isManager() ? button('Settings', () => editProgram(p, load)) : null,
          isManager() && o.terms.length ? button('Cancel a day', () => stormDialog(load)) : null)),
      h('div', { class: 'chip-row' }, chips),
      p.online ? h('p', { class: 'muted small' }, 'Parents register at ', h('a', { href: link, target: '_blank', rel: 'noopener' }, link), '. Only sessions set to Open, inside their registration dates, show there.') : null,
      ...(o.terms.length ? o.terms.map((t) => termPanel(p, t, o.today, load)) : [noTerms(p, load)]),
      o.terms.length > 1 || o.bundles.length ? bundlesPanel(p, o, load) : null);
  }
  await load();
}

function noTerms(p, reload) {
  return h('section', { class: 'panel stack' },
    h('h2', null, 'Sessions'),
    h('p', null, 'Set up a session: the weeks it runs, the weekdays parents can choose, spots and price. Each weekday becomes its own group with its own lesson dates, and the makeup week is held in reserve for weather.'),
    h('div', { class: 'row' }, isManager() ? button('New session', () => termDialog(p, null, reload), { kind: 'primary' }) : null,
      button('Use one roster instead', () => legacyDetail(p))));
}

const STATUS_TONE = { open: 'good', draft: 'warn', closed: 'neutral', archived: 'neutral' };

function termPanel(p, t, today, reload) {
  const last = t.groups.flatMap((g) => g.meetings.map((m) => m.date)).sort().at(-1);
  const step = (t.price_steps || []).find((s) => s.until >= today);
  const dayWord = t.groups.map((g) => SHORT[g.weekday]).join(', ');
  return h('section', { class: 'panel stack pterm', 'data-term': t.id },
    h('div', { class: 'spread' },
      h('div', null, h('h2', null, t.name, ' ', state(label(t.status), STATUS_TONE[t.status])),
        h('p', { class: 'muted' }, `${dayWord}. ${shortDate(t.starts_on)} to ${last ? shortDate(last) : '…'}: ${t.weeks} week${t.weeks === 1 ? '' : 's'}${t.makeup_weeks ? ` plus ${t.makeup_weeks} makeup week${t.makeup_weeks === 1 ? '' : 's'}` : ''}, ${time12(t.start_time)} to ${time12(t.end_time)}.`),
        h('p', null, h('b', null, `Lessons ${money(t.price_cents)}`), step ? ` (${step.label || 'early bird'} ${money(step.price_cents)} until ${shortDate(step.until)})` : '',
          p.includes_ticket ? ` + lift ticket ${money(t.ticket_cents)}` : '', p.includes_rental ? ` + rental ${money(t.rental_cents)}` : '', p.offers_helmet ? ` + helmet ${money(t.helmet_cents)}` : '',
          t.reg_opens_on || t.reg_closes_on ? h('span', { class: 'muted' }, ` · Registration ${t.reg_opens_on ? `opens ${shortDate(t.reg_opens_on)}` : ''}${t.reg_opens_on && t.reg_closes_on ? ', ' : ''}${t.reg_closes_on ? `closes ${shortDate(t.reg_closes_on)}` : ''}`) : null)),
      isManager() ? h('div', { class: 'row' },
        button('Edit', () => termDialog(p, t, reload), { small: true }),
        button('Copy to next session', () => copyDialog(t, reload), { small: true }),
        t.groups.length < 7 ? button('Add a day', () => addDayDialog(t, reload), { small: true }) : null) : null),
    h('div', { class: 'pdays' }, t.groups.map((g) => dayCard(p, t, g))));
}

/** One weekday group: how full it is, the price now, and every lesson date as a strip. */
function dayCard(p, t, g) {
  const pct = g.capacity ? Math.min(100, Math.round((g.enrolled / g.capacity) * 100)) : 0;
  const full = g.capacity != null && g.enrolled >= g.capacity;
  return h('a', { class: `pday${full ? ' is-full' : ''}`, href: `#/programs/${p.id}/day/${g.id}`, 'aria-label': `${g.day}s: ${g.enrolled} enrolled${g.capacity ? ` of ${g.capacity}` : ''}` },
    h('div', { class: 'pday-head' }, h('span', { class: 'pday-name' }, `${g.day}s`), h('span', { class: 'pday-time' }, `${time12(g.start_time)}–${time12(g.end_time)}`)),
    g.discipline && g.discipline !== 'any' ? h('span', { class: 'pday-disc' }, g.discipline === 'ski' ? 'Ski only' : 'Snowboard only') : null,
    h('div', { class: 'pday-fill' },
      h('div', { class: 'pday-count' }, h('b', null, String(g.enrolled)), g.capacity ? ` of ${g.capacity}` : ' enrolled', g.waiting ? h('span', { class: 'pday-wait' }, ` · ${g.waiting} waiting`) : null),
      g.capacity ? h('div', { class: 'pday-bar', role: 'presentation' }, h('i', { style: `width:${pct}%` })) : null),
    dateStrip(g.meetings),
    h('div', { class: 'pday-foot muted small' }, money(g.price_now.cents), g.price_now.label ? ` ${g.price_now.label.toLowerCase()}` : '', g.price_cents != null ? ' (this day\'s own price)' : ''));
}

/** Every lesson date: a lesson, a canceled one (struck through) and a makeup held in reserve (dashed). */
function dateStrip(meetings, onPick) {
  return h('ol', { class: 'pdates', 'aria-label': 'Lesson dates' }, meetings.map((m) => {
    const cls = m.status === 'cancelled' ? 'is-off' : m.status === 'standby' ? 'is-reserve' : m.kind !== 'regular' ? 'is-makeup' : '';
    const title = m.status === 'cancelled' ? `Cancelled${m.cancel_reason ? `: ${m.cancel_reason}` : ''}` : m.status === 'standby' ? 'Makeup date, held in reserve' : m.kind === 'makeup' ? 'Makeup lesson' : m.kind === 'extra' ? 'Added date' : 'Lesson';
    const el = onPick ? h('button', { type: 'button', class: `pdate ${cls}`, title }, shortDate(m.date)) : h('span', { class: `pdate ${cls}`, title }, shortDate(m.date));
    if (onPick) el.addEventListener('click', () => onPick(m));
    return h('li', null, el, h('span', { class: 'visually-hidden' }, ` ${title}`));
  }));
}

/** New session, or edit one. The dates can change only before anyone is enrolled. */
function termDialog(p, t, reload) {
  const chosen = new Set(t ? t.groups.map((g) => g.weekday) : [1, 2, 3, 4]);
  const step = t && t.price_steps && t.price_steps[0];
  const dayBoxes = h('div', { class: 'daypick', role: 'group', 'aria-label': 'Weekdays' }, [1, 2, 3, 4, 5, 6, 0].map((d) => {
    const cb = h('input', { type: 'checkbox', name: `day${d}`, checked: chosen.has(d), disabled: Boolean(t) });
    return h('label', { class: 'daypick-item' }, cb, h('span', null, SHORT[d]));
  }));
  const f = h('div', { class: 'stack' },
    h('div', { class: 'form' },
      field('Name', input({ name: 'name', required: true, maxlength: 100, value: t ? t.name : '', placeholder: 'Session 1' })),
      field('Status', select([['draft', 'Draft (not on sale)'], ['open', 'Open for registration'], ['closed', 'Closed'], ['archived', 'Archived']], t ? t.status : 'draft', { name: 'status' })),
      field('First week starts', input({ name: 'starts_on', type: 'date', required: true, value: t ? t.starts_on : '' }), 'Each day group starts on its first weekday from here'),
      field('Weeks', input({ name: 'weeks', type: 'number', min: 1, max: 40, required: true, value: t ? t.weeks : 4 })),
      field('Makeup weeks', input({ name: 'makeup_weeks', type: 'number', min: 0, max: 6, value: t ? t.makeup_weeks : 1 }), 'Held in reserve, used only when a lesson is canceled'),
      field('Starts at', input({ name: 'start_time', type: 'time', required: true, value: t ? t.start_time : '15:45' })),
      field('Ends at', input({ name: 'end_time', type: 'time', required: true, value: t ? t.end_time : '17:45' })),
      t ? null : field('Spots per day', input({ name: 'capacity', type: 'number', min: 1, max: 2000, placeholder: 'No limit' }), 'Change any day afterwards'),
      field('Lessons price ($)', input({ name: 'price', inputmode: 'decimal', required: true, value: t ? centsToInput(t.price_cents) : '' })),
      p.includes_ticket ? field('Lift ticket part ($)', input({ name: 'ticket', inputmode: 'decimal', value: t ? centsToInput(t.ticket_cents) : '' }), 'Not charged to season pass holders') : null,
      p.includes_rental ? field('Rental ($)', input({ name: 'rental', inputmode: 'decimal', value: t ? centsToInput(t.rental_cents) : '' }), 'For those who ask') : null,
      p.offers_helmet ? field('Helmet ($)', input({ name: 'helmet', inputmode: 'decimal', value: t ? centsToInput(t.helmet_cents) : '' })) : null,
      field('Early bird lessons price ($)', input({ name: 'early_price', inputmode: 'decimal', value: step ? centsToInput(step.price_cents) : '' }), 'Blank for none'),
      field('Early bird until', input({ name: 'early_until', type: 'date', value: step ? step.until : '' })),
      field('Registration opens', input({ name: 'reg_opens_on', type: 'date', value: t && t.reg_opens_on ? t.reg_opens_on : '' })),
      field('Registration closes', input({ name: 'reg_closes_on', type: 'date', value: t && t.reg_closes_on ? t.reg_closes_on : '' })),
      h('div', { class: 'wide' }, field('No lessons on', input({ name: 'skip', value: t ? (t.skip_dates || []).join(', ') : '', placeholder: '2027-01-18, 2027-02-15' }), 'Holidays and school breaks, as dates separated by commas. That week is skipped and the run carries on.'))),
    t ? h('p', { class: 'muted small' }, 'Days: ', t.groups.map((g) => DAYS[g.weekday]).join(', '), '. Add a day from the session, or change a day\'s spots and price from its page.') : h('div', null, h('p', { class: 'field-label' }, 'Days parents can choose'), dayBoxes));
  formDialog(t ? `Edit ${t.name}` : `New session of ${p.name}`, f, async (fd) => {
    const price = toCents(fd.get('price'));
    if (price === null) throw new Error('The price is an amount like 200.00');
    const ep = String(fd.get('early_price') || '').trim();
    let steps = [];
    if (ep) {
      const c = toCents(ep);
      if (c === null || !fd.get('early_until')) throw new Error('An early bird needs a price and the last day it applies');
      steps = [{ label: 'Early bird', until: val(fd, 'early_until'), price_cents: c }];
    }
    const skip = String(fd.get('skip') || '').split(/[\s,]+/).filter(Boolean);
    if (skip.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) throw new Error('Write skipped dates as YYYY-MM-DD');
    const part = (k) => { const raw = String(fd.get(k) || '').trim(); if (!raw) return 0; const c = toCents(raw); if (c === null) throw new Error('Prices are amounts like 80.00'); return c; };
    const body = {
      name: val(fd, 'name'), status: val(fd, 'status'), starts_on: val(fd, 'starts_on'), weeks: num(fd, 'weeks'), makeup_weeks: num(fd, 'makeup_weeks') ?? 0,
      start_time: val(fd, 'start_time'), end_time: val(fd, 'end_time'), price_cents: price, price_steps: steps, skip_dates: skip,
      ticket_cents: part('ticket'), rental_cents: part('rental'), helmet_cents: part('helmet'),
      reg_opens_on: val(fd, 'reg_opens_on') || null, reg_closes_on: val(fd, 'reg_closes_on') || null,
    };
    if (t) await patch(`/programs/terms/${t.id}`, body);
    else {
      const days = [0, 1, 2, 3, 4, 5, 6].filter((d) => fd.get(`day${d}`));
      if (!days.length) throw new Error('Choose at least one day');
      const cap = num(fd, 'capacity');
      await post(`/programs/${p.id}/terms`, { ...body, days: days.map((d) => ({ weekday: d, capacity: cap })) });
    }
    toast(t ? 'Session saved' : 'Session set up, with every day\'s dates');
    await reload();
  }, { wide: true, submitText: t ? 'Save' : 'Set up session' });
}

function copyDialog(t, reload) {
  formDialog(`Copy ${t.name}`, h('div', { class: 'form' },
    field('Name', input({ name: 'name', required: true, value: t.name.replace(/(\d+)\s*$/, (m) => String(Number(m) + 1)) })),
    field('First week starts', input({ name: 'starts_on', type: 'date', required: true }), 'Same days, spots, times, prices and classes. The early bird moves by the same number of days.')),
  async (fd) => {
    await post(`/programs/terms/${t.id}/copy`, { name: val(fd, 'name'), starts_on: val(fd, 'starts_on') });
    toast('Session copied as a draft. Open it for registration when it is ready.');
    await reload();
  }, { submitText: 'Copy' });
}

function addDayDialog(t, reload) {
  const used = new Set(t.groups.map((g) => g.weekday));
  formDialog(`Add a day to ${t.name}`, h('div', { class: 'form' },
    field('Day', select([1, 2, 3, 4, 5, 6, 0].filter((d) => !used.has(d)).map((d) => [d, DAYS[d]]), '', { name: 'weekday' })),
    field('Spots', input({ name: 'capacity', type: 'number', min: 1, max: 2000, placeholder: 'No limit' })),
    field('Who', select([['any', 'Ski and snowboard'], ['ski', 'Ski only'], ['snowboard', 'Snowboard only']], 'any', { name: 'discipline' }))),
  async (fd) => {
    await post(`/programs/terms/${t.id}/days`, { weekday: Number(fd.get('weekday')), capacity: num(fd, 'capacity'), discipline: val(fd, 'discipline') });
    toast('Day added, with its dates');
    await reload();
  }, { submitText: 'Add day' });
}

/** A storm day: every program lesson on one date. A preview first, then each day group uses its own makeup date. */
function stormDialog(reload) {
  const date = input({ type: 'date', name: 'date', required: true, value: todayStr() });
  const reason = input({ name: 'reason', required: true, maxlength: 255, placeholder: 'Snowstorm: roads closed' });
  const tell = h('input', { type: 'checkbox', name: 'notify', checked: true });
  const list = h('div');
  const look = async () => {
    clear(list);
    if (!date.value) return;
    try {
      const pv = await post('/programs/cancel-day', { date: date.value, reason: reason.value.trim() || 'Weather', preview: true });
      list.append(pv.data.length ? h('ul', { class: 'plain' }, pv.data.map((m) => h('li', null, `${m.program}, ${m.term || ''} ${m.weekday != null ? `${DAYS[m.weekday]}s` : ''}, ${String(m.starts_at).slice(11, 16)}`))) : h('p', { class: 'muted' }, 'No program lessons that day.'));
    } catch (err) { list.append(errorBox(err)); }
  };
  date.addEventListener('change', look);
  formDialog('Cancel a day for weather', h('div', { class: 'stack' },
    h('div', { class: 'form' }, field('Date', date), field('Reason', reason, 'Goes in the email to families')),
    h('label', { class: 'check' }, tell, ' Email the families'),
    h('h3', null, 'Lessons that day'), list,
    h('p', { class: 'muted small' }, 'Only this date is canceled. Each day group\'s makeup date becomes a lesson; a group with no makeup left is listed so you can add a date or credit the families.')),
  async (fd) => {
    const out = await post('/programs/cancel-day', { date: val(fd, 'date'), reason: val(fd, 'reason'), notify: Boolean(fd.get('notify')) });
    const short = out.data.filter((x) => x.no_makeup_left);
    toast(`${out.data.length} lesson${out.data.length === 1 ? '' : 's'} cancelled${short.length ? `. ${short.length} had no makeup date left` : ''}`);
    if (short.length) dialog('No makeup date left', [h('p', null, 'These groups have used their makeup weeks. Add a date from the day\'s page, or credit or refund each family\'s share of one lesson.'),
      h('ul', null, short.map((x) => h('li', null, `${x.program}, ${x.term}: ${money(x.per_lesson_cents || 0)} a lesson`)))]);
    await reload();
  }, { submitText: 'Cancel lessons', wide: true });
  look();
}

function bundlesPanel(p, o, reload) {
  const nameOf = new Map(o.terms.map((t) => [t.id, t.name]));
  const edit = (b) => {
    const boxes = o.terms.map((t) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: `t${t.id}`, checked: b ? b.term_ids.includes(t.id) : true }), ` ${t.name}`));
    formDialog(b ? `Edit ${b.name}` : 'New bundle', h('div', { class: 'stack' }, h('div', { class: 'form' },
      field('Name', input({ name: 'name', required: true, maxlength: 100, value: b ? b.name : 'Full season' })),
      field('Price ($)', input({ name: 'price', inputmode: 'decimal', required: true, value: b ? centsToInput(b.price_cents) : '' }))),
    h('p', { class: 'field-label' }, 'Sessions in the bundle'), h('div', { class: 'stack tight' }, boxes),
    b ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: Boolean(b.active) }), ' On sale') : null),
    async (fd) => {
      const cents = toCents(fd.get('price'));
      if (cents === null) throw new Error('The price is an amount like 360.00');
      const ids = o.terms.filter((t) => fd.get(`t${t.id}`)).map((t) => t.id);
      if (ids.length < 2) throw new Error('A bundle has two or more sessions');
      const body = { name: val(fd, 'name'), price_cents: cents, term_ids: ids, ...(b ? { active: Boolean(fd.get('active')) } : {}) };
      if (b) await patch(`/programs/bundles/${b.id}`, body); else await post(`/programs/${p.id}/bundles`, body);
      toast('Bundle saved');
      await reload();
    });
  };
  return h('section', { class: 'panel stack' },
    h('div', { class: 'spread' }, h('h2', null, 'Bundles'), isManager() && o.terms.length > 1 ? button('New bundle', () => edit(null), { small: true }) : null),
    h('p', { class: 'muted' }, 'Several sessions at one price. The parent picks a day for each session.'),
    o.bundles.length ? table([
      { head: 'Bundle', cell: (b) => h('strong', null, b.name) },
      { head: 'Sessions', cell: (b) => b.term_ids.map((x) => nameOf.get(x) || '?').join(' + ') },
      { head: 'Price', num: true, cell: (b) => money(b.price_cents) },
      { head: '', cell: (b) => (b.active ? state('On sale', 'good') : state('Off')) },
      { head: '', actions: true, cell: (b) => (isManager() ? button('Edit', () => edit(b), { small: true }) : null) },
    ], o.bundles) : empty('No bundles yet.'));
}

// ================================================================ one weekday group
async function dayView(root, programId, groupId) {
  const page = h('div', { class: 'stack' });
  root.append(page);
  async function load() {
    let r; let term;
    try {
      r = await get(`/programs/groups/${groupId}/roster`);
      term = await get(`/programs/terms/${r.group.term_id}`);
    } catch (err) { clear(page).append(back(`#/programs/${programId}`, 'Program'), errorBox(err)); return; }
    const g = term.groups.find((x) => x.id === groupId);
    const enrolled = r.data.filter((x) => x.status === 'enrolled');
    const waiting = r.data.filter((x) => x.status === 'waitlist');
    const levels = r.levels;
    const levelPick = (row) => {
      const s = select([['', 'Not placed'], ...levels.map((l) => [l.id, l.name])], row.level_id || '', { 'aria-label': `Class for ${row.first_name}` });
      s.addEventListener('change', async () => {
        try { await put(`/programs/groups/${groupId}/levels/assign`, { assignments: [{ enrollment_id: row.enrollment_id, level_id: s.value ? Number(s.value) : null }] }); toast(`${row.first_name} placed`); await load(); } catch (err) { toast(err.message, 'error'); }
      });
      return s;
    };
    // The pass column: found on file, said so and to check at the first lesson (with the two answers), or a ticket.
    const passCell = (x) => {
      if (x.pass_status === 'verified') return state('Season pass', 'good');
      if (x.pass_status === 'claimed') {
        return h('span', { class: 'stack tight' }, state('Says pass: check it', 'warn'), h('span', { class: 'row tight' },
          button('Seen', async () => { await post(`/programs/enrollments/${x.enrollment_id}/pass`, { result: 'verified' }); toast('Pass checked'); await load(); }, { small: true }),
          button('No pass', () => confirmDialog(`No season pass for ${x.first_name}?`, 'The lift ticket part is added to what the family owes, and the program ticket is issued.', 'Add ticket part', async () => { const o = await post(`/programs/enrollments/${x.enrollment_id}/pass`, { result: 'no_pass' }); toast(`${money(o.owes_added_cents)} added`); await load(); }), { small: true, kind: 'quiet' })));
      }
      return x.ticket_code ? h('code', null, x.ticket_code) : h('span', { class: 'muted' }, x.pass_status === 'no_pass' ? 'Ticket owed' : 'At payment');
    };
    const care = (x) => [x.allergies ? h('span', { class: 'care-flag', title: `Allergies: ${x.allergies}` }, `Allergy: ${x.allergies}`) : null, x.medical ? h('span', { class: 'care-flag', title: x.medical }, 'Medical note') : null,
      x.pickup && x.pickup.length ? h('span', { class: 'muted small' }, `Pickup: ${x.pickup.map((p) => p.name).join(', ')}`) : null];
    const cols = [
      { head: 'Child', cell: (x) => h('span', { class: 'stack tight' }, h('span', null, h('strong', null, `${x.first_name} ${x.last_name}`), x.any_day ? h('span', { class: 'muted small' }, ' any day') : null),
        x.guardian_first_name ? h('span', { class: 'muted small' }, `${x.guardian_first_name} ${x.guardian_last_name}${x.guardian_phone ? `, ${x.guardian_phone}` : ''}`) : null, ...care(x).filter(Boolean)) },
      { head: 'Age', num: true, cell: (x) => ageOf(x.date_of_birth) },
      { head: 'Ski or board', cell: (x) => (x.discipline ? label(x.discipline) : h('span', { class: 'muted' }, 'Not said')) },
      (r.program.includes_rental || r.program.offers_helmet) ? { head: 'Gear', cell: (x) => (x.needs_rental || x.needs_helmet ? h('span', null, [x.needs_rental ? 'Rental' : null, x.needs_helmet ? 'Helmet' : null].filter(Boolean).join(', '), x.needs_rental ? h('span', { class: 'muted small' }, ` ${[x.height_in ? `${x.height_in} in` : '', x.weight_lb ? `${x.weight_lb} lb` : '', x.boot_size ? `boot ${x.boot_size}` : ''].filter(Boolean).join(', ') || 'sizes not on file'}`) : null) : h('span', { class: 'muted' }, 'Own gear')) } : null,
      { head: 'Paid', cell: (x) => (x.owes_cents ? state(`Owes ${money(x.owes_cents)}`, 'warn') : state('Paid', 'good')) },
      r.program.includes_ticket ? { head: 'Pass or ticket', cell: passCell } : null,
      levels.length ? { head: 'Class', cell: levelPick } : null,
      { head: '', actions: true, cell: (x) => [
        button('Report card', () => cardDialog(x.person_id, { onChange: load }), { small: true }),
        button('More', () => detailsDialog(x, r.program, load, { move: () => moveDialog(x, term, groupId, load), withdraw: () => withdraw(x, load) }), { small: true, label: `More for ${x.first_name}` })] },
    ].filter(Boolean);
    const byLevel = [...levels.map((l) => [l.name, enrolled.filter((x) => x.level_id === l.id), l]), ['Not placed yet', enrolled.filter((x) => !x.level_id || !levels.some((l) => l.id === x.level_id)), null]].filter(([, list, l]) => list.length || l);
    clear(page).append(
      back(`#/programs/${programId}`, r.program.name),
      h('div', { class: 'page-head' },
        h('div', null, h('h1', null, `${r.group.day}s, ${r.term.name}`), h('p', { class: 'muted' }, `${r.program.name}. ${time12(g.start_time)} to ${time12(g.end_time)}. ${enrolled.length}${g.capacity ? ` of ${g.capacity}` : ''} enrolled${waiting.length ? `, ${waiting.length} waiting` : ''}.`)),
        h('div', { class: 'row' },
          button('Enroll a child', () => enrollDialog(r, groupId, load), { kind: 'primary' }),
          isManager() ? button('Spots and price', () => dayEdit(g, load)) : null)),
      h('section', { class: 'panel stack' },
        h('div', { class: 'spread' }, h('h2', null, 'Lesson dates'), isManager() ? button('Add a date', () => addDate(groupId, load), { small: true }) : null),
        dateStrip(g.meetings, (m) => dateMenu(m, load)),
        h('p', { class: 'muted small' }, 'Select a date for attendance or to cancel it. Dashed: makeup date held in reserve. Struck through: canceled.')),
      h('section', { class: 'panel stack' },
        h('div', { class: 'spread' }, h('h2', null, 'Classes'),
          h('div', { class: 'row' }, button('Add a class', () => levelDialog(groupId, load), { small: true }),
            levels.length ? button('Preset from last session', async () => { const out = await post(`/programs/groups/${groupId}/levels/preset`); toast(`${out.placed} placed${out.left ? `, ${out.left} to place by hand` : ''}`); await load(); }, { small: true }) : null)),
        h('p', { class: 'muted small' }, r.program.level_mode === 'preset' ? 'This program presets classes before the first day: from last session\'s class, else the ability on file.' : 'Children are split into classes on the first day. Add the classes, then place each child.'),
        enrolled.length ? byLevel.map(([name, list, l]) => h('div', { class: 'stack tight plevel' },
          h('div', { class: 'spread' }, h('h3', null, `${name} (${list.length})`), l ? h('div', { class: 'row' }, button('Rename', () => levelDialog(groupId, load, l), { small: true }), button('Remove', () => confirmDialog(`Remove ${l.name}?`, 'Its children become not placed.', 'Remove', async () => { await del(`/programs/levels/${l.id}`); await load(); }, { danger: true }), { small: true, kind: 'quiet' })) : null),
          list.length ? table(cols, list) : h('p', { class: 'muted' }, 'Nobody in this class yet.'))) : empty('No one enrolled on this day yet.')),
      h('section', { class: 'panel stack' }, h('h2', null, `Waitlist (${waiting.length})`),
        waiting.length ? table([
          { head: 'Order', num: true, cell: (x) => String(waiting.indexOf(x) + 1) },
          { head: 'Child', cell: (x) => h('strong', null, `${x.first_name} ${x.last_name}`) },
          { head: 'Parent', cell: (x) => (x.guardian_first_name ? `${x.guardian_first_name} ${x.guardian_last_name}, ${x.guardian_phone || x.guardian_email || ''}` : '') },
          { head: 'Any day', cell: (x) => (x.any_day ? 'Yes' : '') },
          { head: '', actions: true, cell: (x) => button('Remove', () => withdraw(x, load), { small: true, kind: 'quiet' }) },
        ], waiting) : h('p', { class: 'muted' }, 'Nobody waiting. When a place opens, the first child waiting for this day moves in, then anyone who said any day works.')));
  }
  await load();
}

function enrollDialog(r, groupId, reload) {
  const picker = personPicker({ label: 'Child', required: true });
  const guardian = personPicker({ label: 'Parent or guardian' });
  const any = h('input', { type: 'checkbox' });
  const go = button('Enroll', async () => {
    if (!picker.get()) throw new Error('Choose the child');
    const out = await post(`/programs/terms/${r.term.id}/enroll`, { person_id: picker.get().id, group_id: groupId, guardian_id: guardian.get() ? guardian.get().id : null, any_day: any.checked });
    toast(out.status === 'waitlist' ? 'This day is full. Added to its waitlist' : 'Enrolled. Take payment in Sell, or record it on the roster.');
    dlg.close();
    await reload();
  }, { kind: 'primary' });
  const dlg = dialog(`Enroll on ${r.group.day}s, ${r.term.name}`, [picker.el, guardian.el, h('label', { class: 'check' }, any, ' If this day is full, any day works'), h('p', { class: 'muted small' }, 'To take payment at the same time, sell the place from Sell, Programs.'), h('div', { class: 'footer row' }, go)]);
}

function moveDialog(x, term, from, reload) {
  const opts = term.groups.filter((g) => g.id !== from).map((g) => [g.id, `${g.day}s${g.left === 0 ? ' (full)' : g.left != null ? ` (${g.left} left)` : ''}`]);
  if (!opts.length) { toast('This session has only one day', 'error'); return; }
  formDialog(`Move ${x.first_name} to another day`, field('Day', select(opts, '', { name: 'group_id' })), async (fd) => {
    await post(`/programs/enrollments/${x.enrollment_id}/move`, { group_id: Number(fd.get('group_id')) });
    toast('Moved');
    await reload();
  }, { submitText: 'Move' });
}

function withdraw(x, reload) {
  confirmDialog(`Withdraw ${x.first_name} ${x.last_name}?`, x.status === 'waitlist' ? 'They come off the waitlist.' : 'Their place opens and the first child waiting moves in. Refund from the sale if one is due.', 'Withdraw', async () => {
    const pid = Number(location.hash.split('/')[2]);
    const out = await post(`/programs/${pid}/enrollments/${x.enrollment_id}/withdraw`);
    toast(out.promoted_person_id ? 'Withdrawn. The next child moved in off the waitlist' : 'Withdrawn');
    await reload();
  }, { danger: true });
}

function dayEdit(g, reload) {
  formDialog(`${g.day}s`, h('div', { class: 'form' },
    field('Spots', input({ name: 'capacity', type: 'number', min: 1, max: 2000, value: g.capacity ?? '', placeholder: 'No limit' }), 'More spots move children up from the waitlist'),
    field('This day\'s lessons price ($)', input({ name: 'price', inputmode: 'decimal', value: g.price_cents != null ? centsToInput(g.price_cents) : '' }), 'Blank: the session price'),
    field('Who', select([['any', 'Ski and snowboard'], ['ski', 'Ski only'], ['snowboard', 'Snowboard only']], g.discipline || 'any', { name: 'discipline' }))),
  async (fd) => {
    const raw = String(fd.get('price') || '').trim();
    const cents = raw ? toCents(raw) : null;
    if (raw && cents === null) throw new Error('The price is an amount like 210.00');
    const out = await patch(`/programs/groups/${g.id}`, { capacity: num(fd, 'capacity'), price_cents: cents, discipline: val(fd, 'discipline') });
    toast(out.promoted ? `Saved. ${out.promoted} moved in off the waitlist` : 'Saved');
    await reload();
  });
}

/** A class: one of the ski school's levels (so report cards carry over), or a name of the school's own choosing. */
async function levelDialog(groupId, reload, l) {
  if (l) {
    formDialog(`Rename ${l.name}`, field('Name', input({ name: 'name', required: true, maxlength: 60, value: l.name })), async (fd) => { await patch(`/programs/levels/${l.id}`, { name: val(fd, 'name') }); await reload(); });
    return;
  }
  let ladder = [];
  try { ladder = (await get('/skischool/levels')).data || []; } catch (_) { ladder = []; }
  const opts = [['', 'Not a school level: name it below'], ...ladder.filter((x) => ['ski', 'snowboard'].includes(x.discipline)).map((x) => [x.id, `${label(x.discipline)} ${x.rank_no}: ${x.name}`])];
  formDialog('Add a class', h('div', { class: 'stack' },
    ladder.length ? field('School level', select(opts, '', { name: 'school_level_id' }), 'Children are preset from their report card, and their progress carries on') : null,
    field('Name', input({ name: 'name', maxlength: 60, placeholder: 'Beginner, Green, Never-ever' }), 'Leave blank to use the level\'s name')), async (fd) => {
    const sl = fd.get('school_level_id') ? Number(fd.get('school_level_id')) : null;
    const name = String(fd.get('name') || '').trim();
    if (!sl && !name) throw new Error('Choose a school level or name the class');
    await post(`/programs/groups/${groupId}/levels`, { ...(name ? { name } : {}), ...(sl ? { school_level_id: sl } : {}) });
    await reload();
  });
}

/** The child's details for this place: ski or board, gear, allergies, medical notes, who may pick them up. */
function detailsDialog(x, program, reload, more = {}) {
  const pick = (x.pickup || []).concat([{}, {}]).slice(0, Math.max(2, (x.pickup || []).length + 1));
  formDialog(`${x.first_name} ${x.last_name}`, h('div', { class: 'stack' },
    h('div', { class: 'form' },
      field('Ski or snowboard', select([['', 'Not said'], ['ski', 'Ski'], ['snowboard', 'Snowboard']], x.discipline || '', { name: 'discipline' })),
      program.includes_rental ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'needs_rental', checked: x.needs_rental }), ' Rental gear') : null,
      program.offers_helmet ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'needs_helmet', checked: x.needs_helmet }), ' Helmet') : null,
      field('Allergies', input({ name: 'allergies', maxlength: 300, value: x.allergies || '' })),
      h('div', { class: 'wide' }, field('Medical notes', h('textarea', { name: 'medical', rows: 2, maxlength: 500 }, x.medical || '')))),
    h('p', { class: 'field-label' }, 'Who may pick up'),
    ...pick.map((p, i) => h('div', { class: 'form' }, field('Name', input({ name: `pn${i}`, maxlength: 100, value: p.name || '' })), field('Phone', input({ name: `pp${i}`, maxlength: 40, value: p.phone || '' })), field('Relation', input({ name: `pr${i}`, maxlength: 40, value: p.relation || '' }))))),
  async (fd) => {
    const pickup = pick.map((_, i) => ({ name: String(fd.get(`pn${i}`) || '').trim(), phone: String(fd.get(`pp${i}`) || '').trim() || undefined, relation: String(fd.get(`pr${i}`) || '').trim() || undefined })).filter((p) => p.name);
    await patch(`/programs/enrollments/${x.enrollment_id}/details`, {
      ...(fd.get('discipline') ? { discipline: val(fd, 'discipline') } : {}), allergies: String(fd.get('allergies') || '').trim() || null, medical: String(fd.get('medical') || '').trim() || null, pickup,
      ...(program.includes_rental ? { needs_rental: Boolean(fd.get('needs_rental')) } : {}), ...(program.offers_helmet ? { needs_helmet: Boolean(fd.get('needs_helmet')) } : {}),
    });
    toast('Saved');
    await reload();
  }, { wide: true });
  // Moving day and withdrawing sit with the child's details, so the roster row stays short.
  const foot = [...document.querySelectorAll('.overlay')].at(-1)?.querySelector('form .footer');
  if (foot && (more.move || more.withdraw)) {
    const close = () => [...document.querySelectorAll('.overlay')].at(-1)?.querySelector('header button')?.click();
    if (more.withdraw) foot.prepend(button('Withdraw', () => { close(); more.withdraw(); }, { small: true, kind: 'danger' }));
    if (more.move) foot.prepend(button('Move day', () => { close(); more.move(); }, { small: true }));
  }
}

function addDate(groupId, reload) {
  formDialog('Add a lesson date', field('Date', input({ name: 'date', type: 'date', required: true }), 'For when the makeup weeks are used up. Included lift tickets stretch to cover it.'), async (fd) => {
    await post(`/programs/groups/${groupId}/meetings`, { date: val(fd, 'date') });
    toast('Date added');
    await reload();
  }, { submitText: 'Add date' });
}

/** A lesson date: take attendance, or cancel it (weather). */
function dateMenu(m, reload) {
  const status = m.status === 'cancelled' ? `Cancelled${m.cancel_reason ? `: ${m.cancel_reason}` : ''}` : m.status === 'standby' ? 'Makeup date held in reserve. It becomes a lesson when an earlier date is canceled.' : m.kind === 'regular' ? 'Lesson' : m.kind === 'makeup' ? 'Makeup lesson' : 'Added date';
  const items = [h('p', null, status)];
  let dlg;
  const row = h('div', { class: 'footer row' });
  if (m.status === 'scheduled') {
    row.append(button('Attendance', () => { dlg.close(); attendance(m.id); }, { kind: 'primary' }));
    if (isManager()) row.append(button('Cancel this date', () => { dlg.close(); cancelDate(m, reload); }, { kind: 'danger' }));
  }
  dlg = dialog(fmtDate(m.date), [...items, row]);
}

function cancelDate(m, reload) {
  formDialog(`Cancel ${fmtDate(m.date)}`, h('div', { class: 'stack' },
    field('Reason', input({ name: 'reason', required: true, maxlength: 255, placeholder: 'Ice storm' }), 'Goes in the email to families'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'notify', checked: true }), ' Email the families'),
    h('p', { class: 'muted small' }, 'The first makeup date held in reserve becomes a lesson.')),
  async (fd) => {
    const out = await post(`/programs/meetings/${m.id}/cancel`, { reason: val(fd, 'reason'), notify: Boolean(fd.get('notify')) });
    toast(out.makeup ? `Canceled. Makeup lesson on ${fmtDate(out.makeup.date)}${out.emailed ? `, ${out.emailed} families emailed` : ''}` : 'Canceled. No makeup date is left: add a date, or credit the families', out.makeup ? 'success' : 'warn');
    await reload();
  }, { submitText: 'Cancel date' });
}

async function attendance(meetingId) {
  let m;
  try { m = await get(`/programs/meetings/${meetingId}`); } catch (err) { toast(err.message, 'error'); return; }
  if (!m.data.length) { toast('No one is enrolled on this day', 'error'); return; }
  const rows = m.data.map((k) => ({ k, cb: h('input', { type: 'checkbox', checked: k.present !== false, 'aria-label': `${k.first_name} ${k.last_name} here` }) }));
  // Scan or type the code on a child's program ticket to tick them.
  const scan = input({ placeholder: 'Scan or type a ticket code', 'aria-label': 'Ticket code', autocomplete: 'off' });
  const said = h('p', { class: 'small', role: 'status' });
  scan.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = scan.value.trim().toUpperCase(); scan.value = '';
    const hit = rows.find((x) => x.k.ticket_code && x.k.ticket_code.toUpperCase() === code);
    said.textContent = hit ? `${hit.k.first_name} ${hit.k.last_name}: here` : 'That ticket is not in this group';
    if (hit) hit.cb.checked = true;
  });
  const save = button('Save attendance', async () => {
    await put(`/programs/sessions/${meetingId}/attendance`, { marks: rows.map((x) => ({ person_id: x.k.person_id, present: x.cb.checked })) });
    toast('Attendance saved');
    dlg.close();
  }, { kind: 'primary' });
  const dlg = dialog(`Attendance, ${fmtDate(m.date)}`, [h('p', { class: 'muted' }, 'Untick anyone who is not here.'), h('div', { class: 'row' }, scan), said,
    h('ul', { class: 'plain attend' }, rows.map((x) => h('li', null, h('label', { class: 'check big' }, x.cb, ` ${x.k.first_name} ${x.k.last_name}`), x.k.allergies ? h('span', { class: 'care-flag' }, ` Allergy: ${x.k.allergies}`) : null, x.k.medical ? h('span', { class: 'care-flag', title: x.k.medical }, ' Medical note') : null))), h('div', { class: 'footer row' }, save)]);
}

// ================================================================ today
async function todayView(root) {
  const date = input({ type: 'date', value: todayStr(), 'aria-label': 'Date' });
  const body = h('div', { class: 'stack' });
  root.append(back('#/programs', 'All programs'), h('div', { class: 'page-head' }, h('h1', null, 'Program lessons'),
    h('div', { class: 'row' }, date, isManager() ? button('Cancel this day', () => stormDialog(load)) : null)), body);
  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading…'));
    try {
      const d = await get(`/programs/day?date=${date.value}`);
      clear(body).append(d.data.length ? table([
        { head: 'Time', cell: (m) => `${time12(String(m.starts_at).slice(11, 16))}` },
        { head: 'Program', cell: (m) => h('span', null, h('strong', null, m.program), m.term ? ` ${m.term}, ${DAYS[m.weekday]}s` : '') },
        { head: 'Children', num: true, cell: (m) => (m.status === 'cancelled' ? '' : `${m.present ? `${m.present} here of ` : ''}${m.enrolled}`) },
        { head: '', cell: (m) => (m.status === 'cancelled' ? state(`Cancelled${m.cancel_reason ? `: ${m.cancel_reason}` : ''}`, 'bad') : m.kind !== 'regular' ? state(m.kind === 'makeup' ? 'Makeup lesson' : 'Added date') : '') },
        { head: '', actions: true, cell: (m) => (m.status === 'scheduled' ? button('Attendance', () => attendance(m.id).then(load), { small: true, kind: 'primary' }) : null) },
      ], d.data) : empty('No program lessons on this day.'));
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  date.addEventListener('change', load);
  await load();
}

// ================================================================ a program without sessions: one roster, as before
function legacyDetail(p) {
  dialog(p.name, tabs([['roster', 'Roster', (b) => roster(p, b)], ['sessions', 'Dates', (b) => sessions(p, b)]]), { wide: true });
}

async function roster(p, box) {
  const picker = personPicker({ label: 'Participant', required: true });
  const guardian = personPicker({ label: 'Parent or guardian' });
  const list = h('div');
  async function load() {
    const { data } = await get(`/programs/${p.id}/roster`);
    const enrolled = data.filter((r) => r.status === 'enrolled').length;
    clear(list).append(h('p', { class: 'muted' }, `${enrolled} enrolled${p.capacity ? ` of ${p.capacity}` : ''}, ${data.length - enrolled} on the waitlist.`),
      data.length ? table([
        { head: 'Name', cell: (r) => h('strong', null, `${r.first_name} ${r.last_name}`) },
        { head: 'Status', cell: (r) => state(label(r.status), r.status === 'enrolled' ? 'good' : 'warn') },
        { head: 'Parent or guardian', cell: (r) => (r.guardian_first_name ? `${r.guardian_first_name} ${r.guardian_last_name}  ${r.guardian_email || r.guardian_phone || ''}` : '') },
        { head: 'Paid', num: true, cell: (r) => `${money(r.paid_cents)} of ${money(p.price_cents)}` },
        { head: '', actions: true, cell: (r) => [
          isManager() ? button('Record payment', () => payment(r), { small: true }) : null,
          button('Withdraw', () => confirmDialog('Withdraw this person?', `${r.first_name} ${r.last_name} leaves ${p.name}. The next person on the waitlist moves in.`, 'Withdraw', async () => {
            const out = await post(`/programs/${p.id}/enrollments/${r.enrollment_id}/withdraw`);
            toast(out.promoted_person_id ? 'Withdrawn. Someone moved off the waitlist' : 'Withdrawn');
            await load();
          }, { danger: true }), { small: true, kind: 'danger' }),
        ] },
      ], data) : empty('No one enrolled yet.'));
  }
  function payment(r) {
    formDialog(`Payment from ${r.first_name} ${r.last_name}`, h('div', { class: 'form' }, field('Amount ($)', input({ name: 'amount', inputmode: 'decimal', required: true }))), async (fd) => {
      const cents = toCents(fd.get('amount'));
      if (!cents) throw new Error('Enter an amount like 100.00');
      await post(`/programs/${p.id}/payments`, { enrollment_id: r.enrollment_id, amount_cents: cents });
      toast('Payment recorded');
      await load();
    });
  }
  const add = button('Enroll', async () => {
    if (!picker.get()) throw new Error('Choose a participant');
    const out = await post(`/programs/${p.id}/enrollments`, { person_id: picker.get().id, guardian_id: guardian.get() ? guardian.get().id : undefined });
    toast(out.status === 'waitlist' ? 'Program is full. Added to the waitlist' : 'Enrolled');
    picker.set(null);
    guardian.set(null);
    await load();
  }, { kind: 'primary' });
  box.append(h('div', { class: 'stack' }, list, h('h3', null, 'Enroll someone'), h('div', { class: 'form' }, picker.el, guardian.el), h('div', { class: 'row' }, add)));
  await load();
}

async function sessions(p, box) {
  const list = h('div');
  async function load() {
    const { data } = await get(`/programs/${p.id}/sessions`);
    clear(list).append(data.length ? table([
      { head: 'When', cell: (s) => fmtRange(s.starts_at, s.ends_at) },
      { head: '', actions: true, cell: (s) => button('Attendance', () => attendanceLegacy(s), { small: true }) },
    ], data) : empty('No dates scheduled.'));
  }
  async function attendanceLegacy(s) {
    const { data } = await get(`/programs/${p.id}/roster`);
    const rows = data.filter((r) => r.status === 'enrolled').map((r) => ({ r, cb: h('input', { type: 'checkbox', checked: true, 'aria-label': `${r.first_name} ${r.last_name} present` }) }));
    if (!rows.length) { toast('No one is enrolled yet', 'error'); return; }
    const save = button('Save attendance', async () => {
      await put(`/programs/sessions/${s.id}/attendance`, { marks: rows.map((x) => ({ person_id: x.r.person_id, present: x.cb.checked })) });
      toast('Attendance saved');
      dlg.close();
    }, { kind: 'primary' });
    const dlg = dialog(`Attendance, ${fmtDate(s.starts_at)}`, [h('p', { class: 'muted' }, 'Untick anyone who was absent.'), table([{ head: 'Here', cell: (x) => x.cb }, { head: 'Name', cell: (x) => `${x.r.first_name} ${x.r.last_name}` }], rows), h('div', { class: 'footer row' }, save)]);
  }
  const addBtn = isManager() ? button('Add a date', () => formDialog('Add a date', h('div', { class: 'form' },
    field('Starts', input({ type: 'datetime-local', name: 'starts_at', required: true, value: `${todayStr()}T16:00` })),
    field('Ends', input({ type: 'datetime-local', name: 'ends_at', required: true, value: `${todayStr()}T18:00` }))), async (fd) => {
    await post(`/programs/${p.id}/sessions`, { starts_at: val(fd, 'starts_at'), ends_at: val(fd, 'ends_at') });
    toast('Date added');
    await load();
  }), { kind: 'primary' }) : null;
  box.append(h('div', { class: 'stack' }, h('div', { class: 'row' }, addBtn), list));
  await load();
}
