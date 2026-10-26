// Patrol > People > Crews: the repeating shifts the patrol runs (the weekend day crew), how many each needs, the fewest
// it can run with and the roles it must have, with its standing members. Those who build the schedule make each crew's
// days for the season as drafts and publish them from the Schedule; patrollers sign up for the open spots. Below the
// crews, the coming weeks by day: filled against needed, so short days stand out.
import { get, post, patch, put, del } from '../api.js';
import { h, clear, input, select, field, button, toast, formDialog, confirmDialog, dialog, empty, errorBox, todayStr, addDays, state, fail } from '../ui.js';
import { dayShort, monthDay } from './workforce-common.js';

const WEEK = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
const TONE = { good: ['Full', 'good'], short: ['Short', 'warn'], critical: ['Too few', 'bad'] };

/** "Hill captain (Leader or above), 2 EMT (EMT or higher)" */
export function rolesText(roles, ranks = [], certs = []) {
  const name = (list, k) => (list.find((x) => x[0] === k) || [k, k])[1];
  return roles.map((r) => `${r.count > 1 ? `${r.count} ` : ''}${r.label}${r.rank || r.cert ? ` (${[r.rank ? `${name(ranks, r.rank)} or above` : null, r.cert ? `${name(certs, r.cert)} or higher` : null].filter(Boolean).join(', ')})` : ''}`).join(', ');
}

/** One crew-day's coverage as a small chip: "Day crew 3 of 4", colored and worded by how short it is. */
export function coverChip(d, onClick) {
  const words = `${d.crew} ${d.filled} of ${d.target}`;
  const why = [d.filled < d.minimum ? `Below the ${d.minimum} it can run with` : d.filled < d.target ? `Needs ${d.target - d.filled} more` : 'Full', d.missing.length ? `No ${d.missing.join(', no ')}` : null, d.drafts ? `${d.drafts} not published` : null].filter(Boolean).join('. ');
  return h(onClick ? 'button' : 'span', { type: onClick ? 'button' : undefined, class: 'crew-chip', 'data-tone': d.generated ? d.tone : 'none', title: d.generated ? why : 'Days not made yet', 'aria-label': `${words}. ${d.generated ? why : 'Days not made yet'}`, onclick: onClick || undefined },
    h('b', null, d.crew), h('span', null, d.generated ? `${d.filled}/${d.target}` : 'not made'), d.missing.length && d.generated ? h('span', { class: 'cc-miss' }, `no ${d.missing.join(', ')}`) : null);
}

export async function drawCrews(box) {
  const body = h('div');
  clear(box).append(body);
  const today = todayStr();
  let weeks = 6;

  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading crews…'));
    try {
      const [c, cov] = await Promise.all([get('/patrol/crews'), get(`/patrol/crews/coverage?from=${today}&to=${addDays(today, weeks * 7 - 1)}`)]);
      draw(c, cov);
    } catch (err) { clear(body).append(errorBox(err)); }
  }

  function draw(c, cov) {
    const edit = c.can_edit;
    const parts = [h('div', { class: 'week-bar' },
      h('div', null, h('h2', { class: 'week-title' }, 'Crews'),
        h('p', { class: 'muted' }, edit
          ? 'A crew is a shift your patrol runs again and again. Say how many it needs and the roles it must have, then make its days for the season. Patrollers sign up for the open spots.'
          : 'The shifts your patrol runs again and again, and how full each day is.')),
      edit ? h('div', { class: 'week-actions' }, button('Add crew', () => crewDialog(c, null, load), { kind: 'primary' })) : null)];

    if (!c.crews.length) parts.push(empty(edit ? 'No crews yet. Add your first, such as a weekend day crew.' : 'No crews set up yet.', edit ? button('Add crew', () => crewDialog(c, null, load), { kind: 'primary' }) : null));
    else {
      parts.push(h('div', { class: 'crew-list' }, c.crews.map((k) => h('article', { class: 'crew-card' },
        h('div', { class: 'crew-main' },
          h('h3', null, k.name),
          h('p', null, h('b', null, k.summary), k.station ? `, ${k.station}` : ''),
          h('p', { class: 'muted small' }, `Needs ${k.target}, can run with ${k.minimum}.${k.roles.length ? ` Must have: ${rolesText(k.roles, c.ranks, c.certs)}.` : ''}`),
          h('p', { class: 'muted small' }, [k.from_date || k.to_date ? `Season ${k.from_date ? monthDay(k.from_date) : 'now'} to ${k.to_date ? monthDay(k.to_date) : 'open'}` : 'No season dates', k.skip_dates.length ? `${k.skip_dates.length} day${k.skip_dates.length === 1 ? '' : 's'} skipped` : null].filter(Boolean).join('. ')),
          h('p', { class: 'small' }, k.members.length ? `Standing: ${k.members.map((m) => (m.role_label ? `${m.name} (${m.role_label})` : m.name)).join(', ')}` : h('span', { class: 'muted' }, 'No standing members'))),
        edit ? h('div', { class: 'crew-actions' },
          button('Make the days', () => generateDialog(k, load), { kind: 'primary', small: true }),
          button('Standing members', () => membersDialog(c, k, load), { small: true }),
          button('Edit', () => crewDialog(c, k, load), { small: true }),
          button('Take back drafts', () => clearDialog(k, load), { small: true }),
          button('Retire', () => confirmDialog(`Retire ${k.name}?`, 'No more days are made from it. Days already on the schedule stay.', 'Retire', async () => { await del(`/patrol/crews/${k.id}`); toast('Crew retired'); await load(); }, { danger: true }), { small: true })) : null))));
    }

    // The coming weeks, day by day
    if (c.crews.length) {
      const byDate = new Map();
      for (const d of cov.days) { if (!byDate.has(d.date)) byDate.set(d.date, []); byDate.get(d.date).push(d); }
      const shortDays = cov.days.filter((d) => d.generated && d.tone !== 'good').length;
      parts.push(h('section', { class: 'crew-season' },
        h('div', { class: 'week-bar' }, h('h3', null, `The next ${weeks} weeks`),
          h('div', { class: 'week-actions' }, h('span', { class: 'muted small' }, shortDays ? `${shortDays} crew day${shortDays === 1 ? '' : 's'} short` : 'Every day made is full'),
            weeks < 26 ? button('Show more weeks', () => { weeks = Math.min(26, weeks + 8); load(); }, { small: true }) : null)),
        byDate.size ? h('ul', { class: 'crew-days' }, [...byDate].map(([date, list]) => h('li', { class: date === today ? 'is-today' : null },
          h('span', { class: 'cd-date' }, h('b', null, dayShort(date)), ` ${monthDay(date)}`),
          h('span', { class: 'cd-chips' }, list.map((d) => coverChip(d, edit && d.generated ? () => callDialog(d, load) : null))),
          h('span', { class: 'cd-state' }, list.some((d) => d.generated) ? state(...(TONE[list.filter((d) => d.generated).reduce((a, d) => (d.tone === 'critical' || a === 'critical' ? 'critical' : d.tone === 'short' || a === 'short' ? 'short' : 'good'), 'good')])) : null))))
          : empty('No crew days in these weeks.'),
        edit ? h('p', { class: 'muted small' }, 'Select a day to call for extra patrollers (a storm day, a race). Colours: full, short of what it needs, or below the fewest it can run with or missing a role.') : null));
    }
    clear(body).append(...parts);
  }
  await load();
}

/** Add or change a crew: name, days, times, station, how many, the roles it must have, and its season. */
function crewDialog(c, crew, onDone) {
  const k = crew || { name: '', days: [6, 0], start_time: '08:00', end_time: '16:30', station_id: null, target: 6, minimum: 4, roles: [], from_date: null, to_date: null, skip_dates: [] };
  const name = input({ name: 'name', required: true, maxlength: 80, value: k.name, placeholder: 'Weekend day crew' });
  const days = h('div', { class: 'day-picks', role: 'group', 'aria-label': 'Days' }, WEEK.map(([n, t]) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', value: String(n), checked: k.days.includes(n) }), t)));
  const from = input({ type: 'time', required: true, value: k.start_time });
  const to = input({ type: 'time', required: true, value: k.end_time });
  const station = select([['', 'No station'], ...c.stations.map((s) => [s.id, s.name])], k.station_id || '');
  const target = input({ type: 'number', min: 1, max: 60, required: true, value: k.target });
  const minimum = input({ type: 'number', min: 0, max: 60, required: true, value: k.minimum });
  const season1 = input({ type: 'date', value: k.from_date || '' });
  const season2 = input({ type: 'date', value: k.to_date || '' });
  const skips = h('textarea', { rows: 3, placeholder: 'One date per line, for example 2026-12-25' }, k.skip_dates.join('\n'));
  const roleBox = h('div', { class: 'role-rows' });
  const roleRow = (r = { label: '', count: 1, rank: null, cert: null }) => {
    const row = h('div', { class: 'role-row' },
      field('Role', input({ class: 'r-label', maxlength: 60, value: r.label, placeholder: 'Hill captain' })),
      field('How many', input({ class: 'r-count', type: 'number', min: 1, max: 20, value: r.count })),
      field('Rank at least', select([['', 'Any rank'], ...c.ranks], r.rank || '', { class: 'r-rank' })),
      field('Certification at least', select([['', 'Any'], ...c.certs], r.cert || '', { class: 'r-cert' })),
      h('button', { type: 'button', class: 'btn small icon-btn', 'aria-label': 'Remove this role', onclick: () => row.remove() }, '×'));
    roleBox.append(row);
  };
  k.roles.forEach(roleRow);
  formDialog(crew ? `Edit ${crew.name}` : 'Add a crew', h('div', { class: 'stack' },
    field('Name', name),
    h('fieldset', null, h('legend', null, 'Days'), days),
    h('div', { class: 'shift-when two' }, field('Starts', from), field('Ends', to)),
    field('Station', station),
    h('div', { class: 'shift-when two' }, field('Patrollers it needs', target), field('Fewest it can run with', minimum, 'Below this the day shows red and the Thursday check flags it')),
    h('fieldset', null, h('legend', null, 'Roles it must have'), h('p', { class: 'muted small' }, 'Each role gets its own spot when the days are made. Only someone with the rank or certification can take it.'), roleBox, button('Add a role', () => roleRow(), { small: true })),
    h('div', { class: 'shift-when two' }, field('Season starts', season1), field('Season ends', season2)),
    field('Days it does not run', skips),
    crew ? h('p', { class: 'muted small' }, 'Changes apply to days made from now on. To change days already made, take back the drafts and make them again.') : null), async () => {
    const skipList = skips.value.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
    const bad = skipList.find((x) => !/^\d{4}-\d{2}-\d{2}$/.test(x));
    if (bad) throw new Error(`"${bad}" is not a date. Use YYYY-MM-DD, one per line.`);
    const body = {
      name: name.value.trim(), days: [...days.querySelectorAll('input:checked')].map((x) => Number(x.value)), start_time: from.value, end_time: to.value,
      station_id: station.value ? Number(station.value) : null, target: Number(target.value), minimum: Number(minimum.value),
      roles: [...roleBox.querySelectorAll('.role-row')].map((r) => ({ label: r.querySelector('.r-label').value.trim(), count: Number(r.querySelector('.r-count').value) || 1, rank: r.querySelector('.r-rank').value || null, cert: r.querySelector('.r-cert').value || null })).filter((r) => r.label),
      from_date: season1.value || null, to_date: season2.value || null, skip_dates: skipList,
    };
    if (!body.days.length) throw new Error('Choose at least one day');
    if (crew) { await patch(`/patrol/crews/${crew.id}`, body); toast('Crew saved'); } else { await post('/patrol/crews', body); toast('Crew added. Next, make its days.'); }
    await onDone();
  }, { submitText: crew ? 'Save crew' : 'Add crew', wide: true });
}

/** Who is on the crew every time (put on first when its days are made), each with a role if they hold one. */
function membersDialog(c, k, onDone) {
  const current = new Map(k.members.map((m) => [m.staff_id, m.role_label || '']));
  const rows = c.roster.map((r) => {
    const box = h('input', { type: 'checkbox', checked: current.has(r.staff_id) });
    const role = select([['', 'Any spot'], ...k.roles.map((x) => [x.label, x.label])], current.get(r.staff_id) || '', { 'aria-label': `${r.name}'s role` });
    return { r, box, role, el: h('div', { class: 'member-row' }, h('label', { class: 'chk' }, box, h('span', null, h('b', null, r.name), h('small', { class: 'muted' }, ` ${r.level}${r.cert_level && r.cert_level !== 'none' ? `, ${r.cert_level.toUpperCase()}` : ''}`))), k.roles.length ? role : null) };
  });
  formDialog(`${k.name}: standing members`, h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Standing members are put on this crew first each time its days are made, when they are free. Everyone else signs up for the spots left.'),
    rows.length ? h('div', { class: 'member-list' }, rows.map((x) => x.el)) : empty('No one is on the patrol roster yet.')), async () => {
    await put(`/patrol/crews/${k.id}/members`, { members: rows.filter((x) => x.box.checked).map((x) => ({ staff_id: x.r.staff_id, role_label: x.role.value || null })) });
    toast('Standing members saved');
    await onDone();
  }, { submitText: 'Save', wide: true });
}

function generateDialog(k, onDone) {
  const today = todayStr();
  const from = input({ type: 'date', required: true, value: k.from_date && k.from_date > today ? k.from_date : today });
  const to = input({ type: 'date', required: true, value: k.to_date || addDays(today, 120) });
  formDialog(`Make the days for ${k.name}`, h('div', { class: 'stack' },
    h('p', { class: 'muted' }, `Makes ${k.target} spot${k.target === 1 ? '' : 's'} on each of its days (${k.summary}) as drafts, standing members on first. Days already made are left alone. Publish them from the Schedule when ready.`),
    h('div', { class: 'shift-when two' }, field('From', from), field('To', to))), async () => {
    const r = await post(`/patrol/crews/${k.id}/generate`, { from: from.value, to: to.value });
    await onDone();
    dialog('Days made', [
      h('p', null, `${r.days} day${r.days === 1 ? '' : 's'} made, ${r.created} spots, ${r.filled} filled by standing members.${r.skipped ? ` ${r.skipped} day${r.skipped === 1 ? '' : 's'} already made, left alone.` : ''}`),
      r.not_put.length ? h('div', null, h('p', null, 'Not put on (their spot is open for sign-up):'), h('ul', null, r.not_put.map((x) => h('li', null, `${dayShort(x.date)} ${monthDay(x.date)}, ${x.name}: ${x.reason}`)))) : null,
      h('p', { class: 'muted' }, 'They are drafts. Publish them from the Schedule tab, a week, a month or the season at a time.')]);
  }, { submitText: 'Make the days' });
}

function clearDialog(k, onDone) {
  const today = todayStr();
  const from = input({ type: 'date', required: true, value: today });
  const to = input({ type: 'date', required: true, value: k.to_date || addDays(today, 120) });
  formDialog(`Take back ${k.name} drafts`, h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Removes this crew\'s unpublished spots in these dates, so you can change the crew and make the days again. Published days stay.'),
    h('div', { class: 'shift-when two' }, field('From', from), field('To', to))), async () => {
    const r = await post(`/patrol/crews/${k.id}/clear`, { from: from.value, to: to.value });
    toast(`${r.removed} draft spot${r.removed === 1 ? '' : 's'} taken back`);
    await onDone();
  }, { submitText: 'Take back drafts' });
}

/** Call for extra patrollers on one crew's day: adds open spots and messages everyone free that day. */
export function callDialog(d, onDone) {
  const extra = input({ type: 'number', min: 1, max: 20, required: true, value: 2 });
  const note = input({ maxlength: 200, placeholder: 'Two feet overnight, all hands' });
  formDialog(`Extra patrollers, ${dayShort(d.date)} ${monthDay(d.date)}`, h('div', { class: 'stack' },
    h('p', null, `${d.crew}: ${d.filled} of ${d.target} on now${d.missing.length ? `, no ${d.missing.join(', no ')}` : ''}.`),
    field('Extra spots', extra), field('Note', note),
    h('p', { class: 'muted small' }, 'The spots are published at once. Everyone on the roster who is free that day gets an Inbox message, and it is posted to the shift cover conversation.')), async () => {
    const r = await post('/patrol/crews/call', { crew_id: d.crew_id, date: d.date, extra: Number(extra.value), note: note.value.trim() || null });
    toast(`${r.added} spot${r.added === 1 ? '' : 's'} added, ${r.told} told`);
    await onDone();
  }, { submitText: 'Call for patrollers' });
}

/** Sign-ups waiting for a schedule builder: approve puts them on; decline tells them, with an optional reason. */
export function signupsDialog(list, onDone) {
  let dlg = null;
  const rowFor = (s) => h('li', { class: 'signup-row' },
    h('div', null, h('b', null, s.name), h('span', { class: 'muted' }, ` ${s.level || ''}`), h('br'),
      h('span', null, `${dayShort(s.starts_at.slice(0, 10))} ${monthDay(s.starts_at.slice(0, 10))}, ${s.starts_at.slice(11, 16)} to ${s.ends_at.slice(11, 16)}${s.crew ? `, ${s.crew}` : ''}${s.role_label ? `, ${s.role_label}` : ''}`),
      s.taken ? h('p', { class: 'cover-why' }, 'Someone is already on this spot.') : null),
    h('div', { class: 'cover-actions' },
      s.taken ? null : button('Approve', async () => { try { await post(`/patrol/signups/${s.id}/approve`); toast(`${s.name} is on`); dlg.close(); await onDone(); } catch (err) { fail(err); } }, { kind: 'primary', small: true }),
      button('Decline', () => {
        const why = input({ maxlength: 200, placeholder: 'Optional, sent to them' });
        formDialog(`Decline ${s.name}?`, field('Reason', why), async () => { await post(`/patrol/signups/${s.id}/decline`, { note: why.value.trim() || null }); toast('Declined'); dlg.close(); await onDone(); }, { submitText: 'Decline' });
      }, { small: true })));
  dlg = dialog(`Sign-ups waiting (${list.length})`, [
    h('p', { class: 'muted' }, 'Patrollers asked for these open spots. Approving puts them on and messages them; anyone else who asked for the same spot is told.'),
    h('ul', { class: 'signup-list' }, list.map(rowFor))], { wide: true });
}
