// Pieces shared by several screens: person lookup and the season waiver check.

import { get, post } from './api.js';
import { h, clear, state, button, fail, toast, todayStr, seasonFor, can, fmtDate } from './ui.js';

/**
 * Type-ahead person lookup. Calls onPick(person) when someone is chosen and shows them as a chip.
 * Returns { el, get() } where get() is the chosen person or null.
 */
const FLAG_WORDS = { do_not_rent: 'Do not rent', unpaid_balance: 'Unpaid balance', medical_alert: 'Medical alert', vip: 'VIP', banned: 'Banned', other: 'Note' };

export function personPicker({ label = 'Guest', required = false, onPick } = {}) {
  let chosen = null;
  let timer;
  let seq = 0;
  const search = h('input', { type: 'search', placeholder: 'Name, phone or email', autocomplete: 'off', 'aria-label': label });
  const results = h('div', { class: 'picker-results', hidden: true });
  const slot = h('div');
  const wrap = h('div', { class: 'picker' }, search, results);
  const el = h('div', { class: 'field' }, h('span', null, label, required ? '' : ' (optional)'), slot);

  function showChosen() {
    clear(slot);
    if (!chosen) { slot.append(wrap); return; }
    const x = h('button', { type: 'button', 'aria-label': `Remove ${chosen.first_name} ${chosen.last_name}` }, '×');
    x.addEventListener('click', () => { chosen = null; showChosen(); if (onPick) onPick(null); search.focus(); });
    slot.append(h('span', { class: 'chip' }, `${chosen.first_name} ${chosen.last_name}`, x));
  }
  async function run() {
    const q = search.value.trim();
    const mine = ++seq;
    if (q.length < 2) { results.hidden = true; return; }
    try {
      const { data } = await get(`/people/lookup?q=${encodeURIComponent(q)}`);
      if (mine !== seq) return;
      clear(results);
      if (!data.length) results.append(h('p', { class: 'muted small picker-empty' }, 'No one found. Check the spelling, or add them on the Customers screen first.'));
      for (const p of data) {
        const sm = p.summary;
        const known = [p.phone, p.email].filter(Boolean).join('  ·  ');
        const b = h('button', { type: 'button', class: 'picker-hit' },
          h('span', { class: 'picker-name' }, `${p.first_name} ${p.last_name}`, p.date_of_birth ? h('span', { class: 'muted' }, `  born ${p.date_of_birth}`) : null),
          known ? h('span', { class: 'muted small picker-line' }, known) : null,
          sm ? h('span', { class: 'picker-badges' },
            sm.waiver_this_season ? state('Waiver on file', 'good') : state('No waiver yet', 'warn'),
            ...sm.tickets_today.map((t) => state(t, 'good')),
            sm.rental_out ? state('Gear out', 'neutral') : null) : null,
          p.flags && p.flags.length ? h('span', { class: 'picker-badges' }, ...p.flags.map((f) => h('span', { class: 'flag-pill', 'data-kind': f.kind, title: f.message }, `${FLAG_WORDS[f.kind] || 'Note'}: ${f.message}`))) : null);
        b.addEventListener('click', () => { chosen = p; results.hidden = true; search.value = ''; showChosen(); if (onPick) onPick(p); });
        results.append(b);
      }
      results.hidden = false;
    } catch (err) { results.hidden = true; fail(err); }
  }
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 220); });
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape') results.hidden = true; });
  showChosen();
  return { el, get: () => chosen, set(p) { chosen = p; showChosen(); } };
}

/** Shows whether a person has a waiver for the season of `date`, with a button to record one. */
export function waiverPanel(personId, date = todayStr(), onChange) {
  const season = seasonFor(date);
  const box = h('div', { class: 'row' });
  async function load() {
    clear(box).append(h('span', { class: 'muted' }, 'Checking waiver…'));
    try {
      const { data } = await get(`/people/${personId}/waivers`);
      const current = data.find((w) => w.season === season);
      clear(box);
      if (current) {
        box.append(state(`Waiver signed for ${season}`, 'good'), h('span', { class: 'muted small' }, fmtDate(String(current.signed_at).slice(0, 10))));
      } else {
        box.append(state(`No waiver for ${season}`, 'bad'));
        if (can('counter', 'instructor')) {
          box.append(button('Record signed waiver', async () => {
            await post(`/people/${personId}/waivers`, { season });
            toast('Waiver recorded');
            await load();
            if (onChange) onChange(true);
          }, { small: true }));
        }
      }
      if (onChange) onChange(Boolean(current));
    } catch (err) {
      clear(box).append(h('span', { class: 'muted' }, 'Waiver status is not available to your role.'));
    }
  }
  load();
  return box;
}
