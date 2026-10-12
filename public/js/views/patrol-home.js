// The patrol home screen: what needs me now. My open cases, anything waiting for approval, nudges, and a search box that finds a
// case by patient name, place or case number.

import { get } from '../api.js';
import { h, clear, state, input, empty, errorBox } from '../ui.js';
import { caseRow } from './case-list.js';
import { has } from './patrol-feat.js';

const group = (title, list, none, tone) => list.length || !none
  ? h('section', { class: 'panel stack', 'data-group': title },
    h('div', { class: 'spread' }, h('h2', null, title), list.length ? state(String(list.length), tone || 'neutral') : null),
    h('div', { class: 'case-list' }, list.map((i) => caseRow(i))))
  : h('p', { class: 'muted', 'data-group': title }, h('b', null, `${title}: `), none);

/** opts: { newCase } */
export async function drawHome(box) {
  const home = await get('/patrol/home');
  const results = h('div');
  const q = input({ type: 'search', 'aria-label': 'Find a case', placeholder: 'Patient, place or case number' });
  let timer;
  async function search() {
    const text = q.value.trim();
    if (text.length < 2) { clear(results); return; }
    clear(results).append(h('p', { class: 'loading' }, 'Searching…'));
    try {
      const { data } = await get(`/patrol/incidents?q=${encodeURIComponent(text)}`);
      clear(results).append(data.length ? h('div', { class: 'panel stack' }, h('h2', null, `Results (${data.length})`), h('div', { class: 'case-list' }, data.slice(0, 25).map((i) => caseRow(i, { reportState: true })))) : empty('No case matches that.'));
    } catch (err) { clear(results).append(errorBox(err)); }
  }
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
  q.addEventListener('search', search);

  const nudges = [];
  if (home.can_approve && home.waiting.length) nudges.push(h('a', { class: 'nudge warn', href: '#/patrol/home', 'data-nudge': 'waiting' }, `${home.waiting.length} report${home.waiting.length === 1 ? ' is' : 's are'} waiting for your approval`));
  if (home.stale_drafts) nudges.push(h('span', { class: 'nudge warn', 'data-nudge': 'stale' }, `${home.stale_drafts} case${home.stale_drafts === 1 ? ' is' : 's are'} still in draft from before today. Finish and submit ${home.stale_drafts === 1 ? 'it' : 'them'}.`));
  if (has('followups') && home.followups_held) nudges.push(h('a', { class: 'nudge', href: '#/patrol/followup', 'data-nudge': 'followups' }, `${home.followups_held} follow-up email${home.followups_held === 1 ? '' : 's'} need${home.followups_held === 1 ? 's' : ''} a director's decision`));

  const mineIds = new Set(home.mine.map((x) => x.id));
  const others = home.recent.filter((x) => !mineIds.has(x.id));
  clear(box).append(h('div', { class: 'stack' },
    home.can_view_cases === false
      ? empty('Your access level does not include cases. You can use the map, today\'s posts and trail checks from the tabs above.')
      : h('div', { class: 'home-top' }, h('div', { class: 'grow search' }, q)),
    results, nudges.length ? h('div', { class: 'nudges' }, nudges) : null,
    home.can_view_cases === false ? null : group('My open cases', home.mine, 'none. Start one with New case, or open a case and add yourself as a responder.', 'warn'),
    home.can_approve ? group('Waiting for review', home.waiting, 'nothing is waiting.', 'warn') : null,
    others.length ? group('Other cases in draft', others, '') : null));
}
