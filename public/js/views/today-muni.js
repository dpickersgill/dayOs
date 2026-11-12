// Today for a municipality, by role (release 2026.11.20). Loaded by views/dashboard.js.
//   Owner and manager: the crew board first (who is in, who is off, who is on call now and tonight, and what each person
//     has today), then only the cards that need action, then everything else grouped by app in short lists.
//   Crew: "My work today" (assigned work orders, programs, the bulk pickup route, building rounds due), the time clock
//     and whether they are on call. No manager cards.
//   Front desk: new requests, today's bulk pickups, active street notices, and who is on call to pass after-hours calls to.
// The cards come from each app's GET /<prefix>/today (lib/today.js); the board from /workforce/crew-board and
// /workforce/my-day (routes/crew.js). Never a resident's name, phone or address: Today is often on a wall screen.
import { get, post } from '../api.js';
import { h, clear, ctx, can, isManager, state, button, toast, empty, errorBox, loading, fmtDate, confirmDialog, label } from '../ui.js';

const STATUS_TEXT = { open: 'Open', in_progress: 'In progress', waiting_parts: 'Waiting for parts' };
const PRIORITY_TONE = { urgent: 'bad', high: 'warn', normal: 'neutral', low: 'neutral' };
const on = (key) => Boolean(ctx.me && ctx.me.modules && ctx.me.modules.includes(key));

/** "06:58" -> "6:58 AM". */
export function t12(hm) {
  if (!hm) return '';
  const [H, m] = String(hm).split(':').map(Number);
  return `${((H + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${H < 12 ? 'AM' : 'PM'}`;
}

// ---------------------------------------------------------------- the cards, prioritized
// A card needs action when it has something in it and says so: overdue, urgent, past target, high risk, expiring, new.
const ACTION_TITLE = /(overdue|past target|expired|new requests|not assigned)/i;
const ACTION_TEXT = /(\b[1-9]\d* urgent\b|was due)/i;
export const needsAction = (c) => Number(c.count) > 0 && (ACTION_TITLE.test(c.title) || ACTION_TEXT.test(c.text || ''));
// The group each card's app falls in, by the address it was asked at.
const GROUP_OF = (path) => (/^\/(ops|assets)\//.test(path) ? 'Work orders and programs' : /^\/(water|sewer|stormwater)\//.test(path) ? 'Water, sewer and stormwater'
  : /^\/buildings\//.test(path) ? 'Buildings' : 'Residents');

/** Fetches the cards of every app on that this person may read: [{ ...card, group }]. */
export async function cardsFrom(list) {
  const mods = (ctx.me && ctx.me.modules) || [];
  const asks = list.filter(([module, , may]) => mods.includes(module) && may());
  const answers = await Promise.all(asks.map(([, path]) => get(path).then((r) => (r && Array.isArray(r.cards) ? r.cards.map((c) => ({ ...c, group: GROUP_OF(path) })) : [])).catch(() => [])));
  return answers.flat().filter((c) => c && c.title);
}

/** One full card (the ones that need action, and the front desk's few). */
export function fullCard(c, { action = false } = {}) {
  return h('section', { class: `bd-tile bd-muni${action ? ' bd-action' : ''}`, dataset: { card: c.title } },
    h('header', null, h('h2', null, c.title)),
    c.count === null || c.count === undefined ? null : h('div', { class: 'figures' }, h('div', { class: 'figure' }, h('strong', null, String(c.count)))),
    c.text ? h('p', null, c.text) : null,
    c.href ? h('p', null, h('a', { href: c.href }, 'Open')) : null);
}

/** The rest, grouped by app: one short line each (count, title, its line of text), the whole line a link. */
function groupedCards(cards) {
  const groups = new Map();
  for (const c of cards) { if (!groups.has(c.group)) groups.set(c.group, []); groups.get(c.group).push(c); }
  return [...groups].map(([name, list]) => h('section', { class: 'bd-tile bd-group', dataset: { group: name } },
    h('header', null, h('h2', null, name)),
    h('ul', { class: 'today-lines' }, list.map((c) => h('li', { dataset: { card: c.title } },
      h(c.href ? 'a' : 'span', c.href ? { href: c.href, class: 'today-line' } : { class: 'today-line' },
        h('strong', { class: 'today-n' }, c.count === null || c.count === undefined ? '·' : String(c.count)),
        h('span', { class: 'today-t' }, h('b', null, c.title), c.text ? h('span', { class: 'muted small' }, ` ${c.text}`) : null)))))));
}

/** Cards: what needs action first, as full cards; the rest grouped; and the ones with nothing in them as one quiet line. */
export function prioritized(host, cards) {
  const action = cards.filter(needsAction);
  const quiet = cards.filter((c) => !needsAction(c) && Number(c.count) === 0);
  const rest = cards.filter((c) => !needsAction(c) && Number(c.count) !== 0);
  clear(host).append(...[
    action.length ? h('h2', { class: 'today-h' }, 'Needs action') : null,
    action.length ? h('div', { class: 'board-grid today-action' }, action.map((c) => fullCard(c, { action: true }))) : null,
    rest.length ? h('h2', { class: 'today-h' }, action.length ? 'Everything else' : 'Today') : null,
    rest.length ? h('div', { class: 'board-grid today-groups' }, groupedCards(rest)) : null,
    quiet.length ? h('p', { class: 'muted small today-quiet', dataset: { quiet: quiet.length } }, `Nothing waiting: ${quiet.map((c) => c.title.toLowerCase()).join(', ')}.`) : null,
    !cards.length ? empty('Nothing needs you today.') : null,
  ].filter(Boolean));
}

// ---------------------------------------------------------------- on call
function onCallLines(list, { compact = false } = {}) {
  if (!list.length) return [h('p', { class: 'muted' }, 'No on-call rotation yet. ', isManager() ? h('a', { href: '#/workforce/oncall' }, 'Set one up in Staff and schedule') : 'A manager sets them up in Staff and schedule.')];
  return [h('ul', { class: 'today-oncall' }, list.map((o) => {
    const same = o.now && o.tonight && o.now.staff_id === o.tonight.staff_id;
    return h('li', { dataset: { rotation: o.rotation.name } },
      h('b', null, o.rotation.name), ': ',
      o.now ? h('span', null, o.now.name, o.now.why !== 'rotation' ? h('span', { class: 'muted small' }, ` (${label(o.now.why)})`) : null) : h('span', { class: 'muted' }, 'nobody'),
      same || compact ? (same ? h('span', { class: 'muted small' }, ' now and tonight') : null) : [h('span', { class: 'muted small' }, ' now; tonight '), o.tonight ? o.tonight.name : 'nobody'],
      o.after_hours ? h('span', null, ' ', state('After hours', 'warn')) : null);
  }))];
}

// ---------------------------------------------------------------- manager: the crew board
const STATE_WORDS = { in: ['In', 'good'], scheduled: ['Scheduled', 'neutral'], done: ['Done for the day', 'neutral'], off: ['Off', 'neutral'] };

function personCard(p) {
  const [word, tone] = STATE_WORDS[p.state];
  const when = p.state === 'in' ? `since ${t12(p.since)}${p.callout ? ', call-out' : ''}` : p.state === 'scheduled' && p.shift ? `${t12(p.shift.starts)} to ${t12(p.shift.ends)}` : p.shift && p.state !== 'off' ? `${t12(p.shift.starts)} to ${t12(p.shift.ends)}` : '';
  return h('li', { class: `cb-card is-${p.state}`, dataset: { staff: p.staff_id } },
    h('div', { class: 'cb-top' }, h('b', { class: 'cb-name' }, p.name), h('span', { class: 'cb-state' }, state(word, tone), when ? h('span', { class: 'muted small' }, ` ${when}`) : null)),
    p.oncall.length ? h('p', { class: 'cb-oncall small' }, state(`On call ${p.oncall.some((c) => c.now) ? 'now' : 'tonight'}`, 'warn'), h('span', { class: 'muted' }, ` ${p.oncall.map((c) => c.rotation).join(', ')}`)) : null,
    p.work.length ? h('ul', { class: 'cb-work' }, p.work.map((w) => h('li', null,
      h('a', { href: `#/works/${w.id}` }, w.title), ' ',
      h('span', { class: 'muted small' }, [STATUS_TEXT[w.status] || label(w.status), w.priority === 'urgent' || w.priority === 'high' ? label(w.priority) : null, w.overdue ? 'overdue' : null].filter(Boolean).join(', '))))) : null,
    p.work_count > p.work.length ? h('p', { class: 'muted small' }, h('a', { href: `#/works?who=${p.staff_id}` }, `${p.work_count - p.work.length} more`)) : null,
    p.programs.map((g) => h('p', { class: 'small' }, h('a', { href: `#/assetprograms/${g.id}` }, g.name), h('span', { class: 'muted' }, ` ${g.words}`))),
    !p.work.length && !p.programs.length && p.state !== 'off' ? h('p', { class: 'muted small' }, p.done_today ? `${p.done_today} done today, nothing else assigned` : 'Nothing assigned today') : null,
    p.done_today && (p.work.length || p.programs.length) ? h('p', { class: 'muted small' }, `${p.done_today} done today`) : null);
}

async function crewBoard(host) {
  clear(host).append(loading('Loading the crew board'));
  let b;
  try { b = await get('/workforce/crew-board'); } catch (err) { clear(host).append(errorBox(err)); return null; }
  // Off today but with work assigned: on the board too, so it can be handed to someone who is in.
  const working = b.people.filter((p) => p.state !== 'off' || p.work_count || p.programs.length);
  const off = b.people.filter((p) => !working.includes(p));
  const c = b.counts;
  clear(host).append(h('section', { class: 'panel cb-board', 'aria-label': 'Crew board' },
    h('div', { class: 'spread' }, h('h2', null, 'Crew today'),
      h('p', { class: 'muted small cb-counts' }, [`${c.in} in`, c.scheduled ? `${c.scheduled} still to start` : null, c.done ? `${c.done} done for the day` : null, `${c.off} off`].filter(Boolean).join(' · '), ' ',
        h('a', { href: '#/workforce' }, 'Schedule'))),
    b.holiday ? h('p', { class: 'callout' }, `${b.holiday} today: the on-call person takes every call.`) : null,
    h('div', { class: 'cb-oncall-box' }, h('h3', null, 'On call'), ...onCallLines(b.oncall)),
    working.length ? h('ul', { class: 'cb-grid' }, working.map(personCard)) : h('p', { class: 'muted' }, 'Nobody is clocked in or scheduled yet today.'),
    off.length ? h('p', { class: 'muted small cb-off' }, h('b', null, 'Off today: '), off.map((p) => `${p.name}${p.oncall.length ? ' (on call)' : ''}`).join(', ')) : null,
    b.unassigned ? h('p', { class: 'cb-unassigned' }, state(`${b.unassigned} open work order${b.unassigned === 1 ? '' : 's'} not assigned`, 'warn'), ' ', h('a', { href: '#/works?who=none' }, 'Assign them')) : null));
  return b;
}

/** Owner and manager. */
export async function managerToday(root, list) {
  const boardHost = h('div', { class: 'cb-board-host' });
  const cardsHost = h('div', { class: 'today-cards' }, loading());
  root.append(on('workforce') ? boardHost : '', cardsHost);
  const [b, cards] = await Promise.all([on('workforce') ? crewBoard(boardHost) : null, cardsFrom(list)]);
  if (b && b.certifications.length) {
    const expired = b.certifications.filter((x) => x.expired).length;
    cards.push({ title: expired ? 'Certifications expired or expiring' : 'Certifications expiring', count: b.certifications.length, group: 'Crew',
      text: b.certifications.slice(0, 3).map((x) => `${x.name}: ${x.certification} ${x.expired ? 'expired' : 'expires'} ${fmtDate(x.expires_on)}`).join('; ') + (b.certifications.length > 3 ? '; and more' : ''), href: '#/workforce?tab=staff' });
  }
  prioritized(cardsHost, cards);
}

// ---------------------------------------------------------------- crew: my work today
function clockRow(d, reload) {
  if (!d.linked || !d.clock || !d.clock.may) return null;
  const oncallNow = d.oncall.some((o) => o.now && o.after_hours);
  return h('div', { class: 'myday-clock row wrap' },
    d.clock.in ? state(`Clocked in since ${t12(d.clock.since)}${d.clock.callout ? ' (call-out)' : ''}`, 'good') : state('Not clocked in', 'neutral'),
    d.shift ? h('span', { class: 'muted small' }, `Your shift: ${t12(d.shift.starts)} to ${t12(d.shift.ends)}, ${d.shift.position}`) : null,
    d.clock.in ? button('Clock out', async () => { await post('/workforce/time/clock-out', {}); toast('Clocked out'); await reload(); }, { kind: 'primary' })
      : button('Clock in', async () => { await post('/workforce/time/clock-in', {}); toast('Clocked in'); await reload(); }, { kind: 'primary' }),
    oncallNow && !d.clock.callout ? button(d.clock.in ? 'Mark this a call-out' : 'Clock in for a call-out', () => confirmDialog('Call-out', 'Called in after hours? This marks your time as a call-out, for overtime and payroll.', d.clock.in ? 'Mark it' : 'Clock in', async () => { await post('/workforce/oncall/callout', {}); toast('Call-out started'); await reload(); })) : null);
}

function myWork(d) {
  const sections = [];
  const work = d.work;
  sections.push(h('section', { class: 'panel myday-work', dataset: { part: 'work' } },
    h('div', { class: 'spread' }, h('h2', null, 'Work orders'), h('a', { class: 'small', href: '#/works?who=mine' }, 'All of mine')),
    work.length ? h('ul', { class: 'myday-list' }, work.map((w) => h('li', null,
      h('a', { class: 'myday-item', href: `#/works/${w.id}` },
        h('span', { class: 'myday-title' }, h('b', null, w.title), w.where && !w.title.includes(w.where) ? h('span', { class: 'muted small' }, ` ${w.where}`) : null),
        h('span', { class: 'myday-meta' }, state(STATUS_TEXT[w.status] || label(w.status), w.status === 'in_progress' ? 'good' : 'neutral'),
          w.priority === 'urgent' || w.priority === 'high' ? state(label(w.priority), PRIORITY_TONE[w.priority]) : null,
          w.overdue ? state('Overdue', 'bad') : w.due_date ? h('span', { class: 'muted small' }, w.today ? 'Due today' : `Due ${fmtDate(w.due_date)}`) : null))))) : h('p', { class: 'muted' }, 'Nothing assigned to you. Ask your supervisor, or report a problem below.'),
    h('p', null, h('a', { class: 'btn small', href: '#/works?new=1' }, 'Report a problem'))));
  if (d.programs.length) {
    sections.push(h('section', { class: 'panel', dataset: { part: 'programs' } }, h('h2', null, 'Programs'),
      h('ul', { class: 'myday-list' }, d.programs.map((g) => h('li', null, h('a', { class: 'myday-item', href: `#/assetprograms/${g.id}` },
        h('span', { class: 'myday-title' }, h('b', null, g.name), h('span', { class: 'muted small' }, ` ${g.words}`)),
        h('span', { class: 'myday-meta' }, g.due_on ? h('span', { class: 'muted small' }, `${g.due_on < d.date ? 'Was due' : 'Due'} ${fmtDate(g.due_on)}`) : null)))))));
  }
  if (d.bulk) sections.push(h('section', { class: 'panel', dataset: { part: 'bulk' } }, h('h2', null, 'Bulk pickup route'), h('p', null, `${d.bulk.stops} stops today, ${d.bulk.done} done.`), h('p', null, h('a', { class: 'btn small', href: d.bulk.href }, 'Open the route'))));
  if (d.rounds.length) {
    sections.push(h('section', { class: 'panel', dataset: { part: 'rounds' } }, h('h2', null, 'Building rounds due'),
      h('ul', { class: 'myday-list' }, d.rounds.map((r) => h('li', null, h('a', { class: 'myday-item', href: `#/buildings/b/${r.building_id}` },
        h('span', { class: 'myday-title' }, h('b', null, r.building)), h('span', { class: 'myday-meta' }, r.overdue ? state(`${r.overdue} overdue`, 'bad') : null, h('span', { class: 'muted small' }, `${r.checks} check${r.checks === 1 ? '' : 's'}`))))))));
  }
  return sections;
}

/** Crew. */
export async function crewToday(root) {
  const host = h('div', { class: 'myday', 'data-today': 'crew' }, loading());
  root.append(host);
  async function load() {
    let d;
    try { d = await get('/workforce/my-day'); } catch (err) { clear(host).append(errorBox(err)); return; }
    const oncall = d.oncall.length ? h('p', { class: 'callout myday-oncall' }, state(`You are on call ${d.oncall.some((o) => o.now) ? 'now' : 'tonight'}`, 'warn'), ` ${d.oncall.map((o) => o.rotation).join(', ')}. After-hours calls come to your phone.`) : null;
    clear(host).append(...[
      h('h2', { class: 'today-h' }, 'My work today'),
      !d.linked ? h('p', { class: 'callout' }, 'Your login is not linked to a staff record, so nothing is assigned to you here. Ask a manager to link it.') : null,
      clockRow(d, load), oncall, ...myWork(d),
    ].filter(Boolean));
    // Collection routes (2026.11.22): the routes this crew member is on today, or can pick up (trash-routes.js).
    if (on('solidwaste')) import('../trash-routes.js').then((m) => m.myRoutesSection()).then((sec) => { if (sec && host.isConnected) host.querySelector('[data-part="work"]')?.before(sec); }).catch(() => {});
  }
  await load();
}

// ---------------------------------------------------------------- front desk
/** Front desk: new requests, today's bulk pickups, active street notices, and who is on call. */
export async function deskToday(root, list) {
  const oncallHost = h('section', { class: 'panel desk-oncall', 'aria-label': 'On call' }, h('h2', null, 'On call now'), loading());
  const cardsHost = h('div', { class: 'board-grid', 'data-today': 'desk' }, loading());
  root.append(on('workforce') ? oncallHost : '', cardsHost);
  if (on('workforce')) {
    get('/workforce/oncall/now').then((d) => {
      clear(oncallHost).append(h('h2', null, 'On call now'), h('p', { class: 'muted small' }, 'Pass after-hours calls to the person on call. A water or sewer request taken after hours alerts them by phone.'), ...onCallLines(d.data));
    }).catch((err) => clear(oncallHost).append(errorBox(err)));
  }
  const cards = await cardsFrom(list);
  const desk = cards.filter((c) => /^(New requests|Open past target|Active street notices)$/.test(c.title) || /bulk pickup/i.test(c.title));
  clear(cardsHost).append(...(desk.length ? desk.map((c) => fullCard(c, { action: needsAction(c) })) : [empty('Nothing waiting at the desk.')]));
}

export const isCrew = () => !isManager() && can('staff') && ctx.me.role === 'staff';
