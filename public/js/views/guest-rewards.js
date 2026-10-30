// Settings, Sell and gate: guest rewards and recaps (guests round 2, Track LOYALTY). Four cards: birthday gifts, thank-you
// recaps after a day and a season, the loyalty rules (all off until a mountain turns them on), and the report of
// rewards given and used, recaps sent and the season's most loyal guests. settingsPages: { key: { title, render(panel), who } }.
import { get, patch, post } from '../api.js';
import { h, clear, input, select, toCents, centsToInput, money, toast, fail, errorBox, loading, fmtDay, table, formDialog, confirmDialog, val, seasonFor, todayStr } from '../ui.js';
import { row, toggle, amount, infoRow } from './settings-kit.js';

export const settingsPages = {
  birthdays: { title: 'Birthday gifts', who: 'manager', render: (panel) => draw(panel, birthdays) },
  recaps: { title: 'Thank-you recaps', who: 'manager', render: (panel) => draw(panel, recaps) },
  loyalty: { title: 'Loyalty rules', who: 'manager', render: (panel) => draw(panel, rules) },
  'rewards-report': { title: 'Rewards and recaps report', who: 'manager', render: (panel) => drawReport(panel) },
};

const GUEST_KEYS = new Set(['season_opens_on', 'birthday_on', 'birthday_ticket_product_id', 'birthday_percent', 'birthday_credit_cents', 'birthday_window', 'recap_day_on', 'recap_season_on', 'milestones_on', 'firsttimer_on', 'loyalty_every_n', 'loyalty_top_n']);

async function load() {
  const [g, x] = await Promise.all([get('/guests/settings'), get('/guests/loyalty/settings')]);
  return { g, x };
}
async function draw(panel, build) {
  panel.classList.add('gr-body');
  clear(panel).append(loading());
  let data;
  try { data = await load(); } catch (err) { clear(panel).append(errorBox(err)); return; }
  clear(panel);
  build(panel, data);
}

/**
 * A small save row for one card: Save turns on when something changed. collect() returns the fields to send (throw an
 * Error with plain words when something is not right); guest_settings fields and the loyalty extras go to their routes.
 */
function saver(panel, collect, after) {
  const els = [];
  const valueOf = (el) => (el.type === 'checkbox' ? el.checked : el.value);
  const note = h('span', { class: 'gr-save-note', role: 'status' });
  const btn = h('button', { type: 'button', class: 'btn primary', disabled: true }, 'Save');
  const refresh = () => { const n = els.filter((e) => valueOf(e.el) !== e.initial).length; btn.disabled = n === 0; note.textContent = n ? 'Not saved yet' : ''; };
  btn.addEventListener('click', async () => {
    let body;
    try { body = collect(); } catch (err) { fail(err); return; }
    const g = {}; const x = {};
    for (const [k, v] of Object.entries(body)) (GUEST_KEYS.has(k) ? g : x)[k] = v;
    btn.disabled = true;
    try {
      if (Object.keys(g).length) await patch('/guests/settings', g);
      if (Object.keys(x).length) await patch('/guests/loyalty/settings', x);
      for (const e of els) e.initial = valueOf(e.el);
      toast('Saved'); refresh(); if (after) after();
    } catch (err) { fail(err); refresh(); }
  });
  panel.append(h('div', { class: 'gr-save' }, note, btn));
  return {
    track(el) { els.push({ el, initial: valueOf(el) }); el.addEventListener('input', refresh); el.addEventListener('change', refresh); return el; },
  };
}
const productOptions = (list, kinds, none) => [...(none ? [['', none]] : []), ...list.filter((p) => kinds.includes(p.kind)).map((p) => [String(p.id), `${p.name} (${money(p.base_price_cents)})`])];
const whole = (el, words, min, max) => {
  const n = Number(el.value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Enter ${words} from ${min} to ${max}`);
  return n;
};
const dollars = (el, words) => { const c = toCents(el.value); if (c === null || c <= 0) throw new Error(`Enter ${words} in dollars, for example 25.00`); return c; };
// A switch that turns the controls after it on and off.
const linked = (sw, ...els) => { const sync = () => { for (const e of els) e.disabled = !sw.checked; }; sw.addEventListener('change', sync); sync(); };

// ---------------------------------------------------------------- birthday gifts
function birthdays(panel, { g, x }) {
  const s = saver(panel, collect, () => draw(panel, birthdays));
  const on = s.track(toggle({ name: 'birthday_on', checked: Boolean(g.birthday_on), 'aria-label': 'Birthday gifts on' }));
  const days = x.products.filter((p) => p.kind === 'day_ticket');
  const ticketOn = s.track(toggle({ name: 'gift_ticket', checked: Boolean(g.birthday_ticket_product_id), 'aria-label': 'A free day ticket' }));
  const ticket = s.track(select(productOptions(x.products, ['day_ticket']), String(g.birthday_ticket_product_id || (x.main_ticket || {}).id || ''), { name: 'birthday_ticket_product_id', 'aria-label': 'Which ticket' }));
  const pctOn = s.track(toggle({ name: 'gift_percent', checked: Boolean(g.birthday_percent), 'aria-label': 'Percent off' }));
  const pct = s.track(input({ name: 'birthday_percent', type: 'number', min: 1, max: 100, value: g.birthday_percent || 20, 'aria-label': 'Percent off' }));
  const creditOn = s.track(toggle({ name: 'gift_credit', checked: Boolean(g.birthday_credit_cents), 'aria-label': 'A credit' }));
  const credit = s.track(input({ name: 'birthday_credit_cents', inputmode: 'decimal', value: centsToInput(g.birthday_credit_cents || 2500), 'aria-label': 'Credit in dollars' }));
  const win = s.track(select([['week', 'The birthday week (Sunday to Saturday)'], ['month', 'The birthday month']], g.birthday_window, { name: 'birthday_window' }));
  const opens = s.track(input({ name: 'season_opens_on', type: 'date', value: g.season_opens_on || '' }));
  linked(ticketOn, ticket); linked(pctOn, pct); linked(creditOn, credit);
  function collect() {
    const b = { birthday_on: on.checked, birthday_window: win.value, season_opens_on: opens.value || null };
    b.birthday_ticket_product_id = ticketOn.checked && ticket.value ? Number(ticket.value) : null;
    b.birthday_percent = pctOn.checked ? whole(pct, 'a percent', 1, 100) : null;
    b.birthday_credit_cents = creditOn.checked ? dollars(credit, 'the credit') : null;
    return b;
  }
  const main = x.main_ticket;
  const nothing = !g.birthday_ticket_product_id && !g.birthday_percent && !g.birthday_credit_cents;
  const season = x.season;
  const seasonWords = `This season runs ${fmtDay(season.opens)} to ${fmtDay(season.ends)}.${season.assumed.opens || season.assumed.ends ? ' Until you set the dates, we use Nov 15 to Apr 15.' : ''}`;
  const est = x.estimate.birthdays;
  const perGift = g.birthday_credit_cents || (main ? main.base_price_cents : 0);
  panel.prepend(
    h('p', { class: 'gr-intro' }, 'A gift for guests who came this season or last (a visit, a lesson, a rental or a pass) and for pass holders. It is emailed a week before the birthday, and the guest picks one of the choices you turn on. A child\'s gift is emailed to the parent. Newcomers are not included.'),
    row('Birthday gifts', on, 'On for every mountain unless you turn it off. Once a season for each guest.'),
    h('h3', { class: 'gr-sub' }, 'The choices'),
    nothing && main ? h('div', { class: 'notice', role: 'status' }, `Nothing is picked yet, so the gift is a free ${main.name}. Turn on the choices you want below.`) : null,
    days.length ? row('A free day ticket', h('span', { class: 'gr-pair' }, ticketOn, ticket)) : infoRow('A free day ticket', 'Add a day ticket under Products and prices to offer one.'),
    row('Percent off one ticket', h('span', { class: 'gr-pair' }, pctOn, amount(pct, '% off'))),
    row('A credit', h('span', { class: 'gr-pair' }, creditOn, amount(credit, 'dollars'))),
    row('Good for', win, 'A birthday outside the season gets its gift on opening day instead, good for 30 days.'),
    row('Season opening day', opens, [seasonWords, ' The last day is the season end under ', h('a', { href: '#/settings/team' }, 'Team and logins'), '.']),
    est ? h('p', { class: 'gr-cost' }, h('b', null, 'What it may cost: '), `about ${est} gifts a season at your size${perGift ? `, up to ${money(est * perGift)} if every guest used one` : ''}.`) : null,
  );
}

// ---------------------------------------------------------------- recaps
function recaps(panel, { g, x }) {
  const s = saver(panel, collect);
  const day = s.track(toggle({ name: 'recap_day_on', checked: Boolean(g.recap_day_on), 'aria-label': 'Day recaps on' }));
  const time = s.track(input({ name: 'recap_time', type: 'time', value: x.recap_time || '18:00' }));
  const season = s.track(toggle({ name: 'recap_season_on', checked: Boolean(g.recap_season_on), 'aria-label': 'Season recaps on' }));
  linked(day, time);
  function collect() {
    if (!/^\d{2}:\d{2}$/.test(time.value)) throw new Error('Enter the evening time, for example 6:00 PM');
    return { recap_day_on: day.checked, recap_season_on: season.checked, recap_time: time.value };
  }
  const sendNow = h('button', { type: 'button', class: 'btn' }, 'Send season recaps now');
  sendNow.addEventListener('click', async () => {
    sendNow.disabled = true;
    try {
      const label = seasonFor(todayStr());
      const pre = await get(`/guests/loyalty/season-recaps?season=${label}`);
      if (!pre.people) { toast('Nobody is waiting for a season recap.'); return; }
      confirmDialog('Send season recaps now?', `${pre.people} ${pre.people === 1 ? 'guest' : 'guests'} in ${pre.emails} ${pre.emails === 1 ? 'email' : 'emails'} (a family shares one). Each guest gets one season recap; anyone who already got theirs is skipped.`, 'Send now', async () => {
        const out = await post('/guests/loyalty/season-recaps/send', { season: label });
        toast(`Sent ${out.sent} ${out.sent === 1 ? 'email' : 'emails'}`);
      });
    } catch (err) { fail(err); } finally { sendNow.disabled = false; }
  });
  panel.prepend(
    h('p', { class: 'gr-intro' }, 'A short thank-you to every guest with an email, from their gate scans. Families get one message. A text goes as well only to guests who said yes to texts.'),
    row('After a day on the mountain', day, 'For example: "Thanks for skiing with us today, Pat. First chair at 8:58 AM, 6 laps on 3 lifts. See you soon." Never for staff.'),
    row('Send in the evening at', time, 'Mountain time. Guests who scan later get theirs a few minutes after their first scan.'),
    row('At the end of the season', season, 'A "Your season" page by a private link: days, first and last day, favorite lift, longest streak, lessons and levels. It goes out the day after the season ends.'),
    infoRow('Send it yourself', 'For a season that ends early, or to send before the last day.', sendNow),
    x.texts_ready ? null : h('p', { class: 'gr-cost' }, 'Text messages are not set up for your mountain, so recaps go by email only.'),
  );
}

// ---------------------------------------------------------------- the loyalty rules
function rules(panel, { g, x }) {
  const s = saver(panel, collect);
  const everyOn = s.track(toggle({ name: 'every_on', checked: Boolean(g.loyalty_every_n), 'aria-label': 'Every Nth day free' }));
  const every = s.track(input({ name: 'loyalty_every_n', type: 'number', min: 2, max: 50, value: g.loyalty_every_n || 5, 'aria-label': 'Every how many days' }));
  const everyTicket = s.track(select(productOptions(x.products, ['day_ticket'], 'The main day ticket'), String(x.loyalty_product_id || ''), { name: 'loyalty_product_id', 'aria-label': 'Which free ticket' }));
  const miles = s.track(toggle({ name: 'milestones_on', checked: Boolean(g.milestones_on), 'aria-label': 'Milestones' }));
  const mileCredit = s.track(input({ name: 'milestone_credit_cents', inputmode: 'decimal', value: centsToInput(x.milestone_credit_cents), placeholder: 'None', 'aria-label': 'Milestone credit in dollars' }));
  const ladder = s.track(toggle({ name: 'firsttimer_on', checked: Boolean(g.firsttimer_on), 'aria-label': 'First-timer ladder' }));
  const ladderPct = s.track(input({ name: 'firsttimer_percent', type: 'number', min: 1, max: 100, value: x.firsttimer_percent || 50, 'aria-label': 'Percent off a season pass' }));
  const ladderPass = s.track(select(productOptions(x.products, ['season_pass'], 'The first season pass'), String(x.firsttimer_product_id || ''), { name: 'firsttimer_product_id', 'aria-label': 'Which season pass' }));
  const topOn = s.track(toggle({ name: 'top_on', checked: Boolean(g.loyalty_top_n), 'aria-label': 'Top loyalists list' }));
  const top = s.track(input({ name: 'loyalty_top_n', type: 'number', min: 5, max: 1000, value: g.loyalty_top_n || 25, 'aria-label': 'How many on the list' }));
  linked(everyOn, every, everyTicket); linked(miles, mileCredit); linked(ladder, ladderPct, ladderPass); linked(topOn, top);
  function collect() {
    const b = {
      loyalty_every_n: everyOn.checked ? whole(every, 'a number of days', 2, 50) : null,
      loyalty_product_id: everyTicket.value ? Number(everyTicket.value) : null,
      milestones_on: miles.checked,
      milestone_credit_cents: mileCredit.value.trim() ? dollars(mileCredit, 'the milestone credit') : null,
      firsttimer_on: ladder.checked,
      firsttimer_percent: whole(ladderPct, 'a percent', 1, 100),
      firsttimer_product_id: ladderPass.value ? Number(ladderPass.value) : null,
      loyalty_top_n: topOn.checked ? whole(top, 'a list size', 5, 1000) : null,
    };
    return b;
  }
  const main = x.main_ticket ? x.main_ticket.name : 'day ticket';
  panel.prepend(
    h('p', { class: 'gr-intro' }, 'Loyalty without a sign-up: it counts gate scans. Each rule is off until you turn it on, and each reward is given once.'),
    row('Every few paid days, one free', h('span', { class: 'gr-pair' }, everyOn, amount(every, 'paid days')), 'Counts days on a ticket the guest paid for this season. Season pass days and free days do not count. The welcome-back card shows "3 of 5 toward a free day".'),
    row('The free day is', everyTicket),
    row('Milestones', miles, `On a guest's 10th, 25th, 50th and 100th day here, a thank-you email and a gift. With no credit set, the gift is a free ${main}.`),
    row('Milestone credit', amount(mileCredit, 'dollars')),
    row('First-timer ladder', ladder, 'For a guest whose first day here was a lesson: "Lesson 2 of 3" in their emails and on the welcome-back card, then a season pass offer after the third lesson.'),
    row('Season pass offer', h('span', { class: 'gr-pair' }, amount(ladderPct, '% off'), ladderPass)),
    row('Top loyalists list', h('span', { class: 'gr-pair' }, topOn, amount(top, 'guests')), 'Your most frequent guests this season, in the report below, with a thank-you email and an optional credit.'),
  );
}

// ---------------------------------------------------------------- the report
const KIND = { birthday: 'Birthday gifts', milestone: 'Milestones', loyalty: 'Loyalty days and thank-yous', firsttimer: 'First-timer offers', closure: 'Closure credits', conditions: 'Conditions credits', goodwill: 'Goodwill credits' };
async function drawReport(panel) {
  panel.classList.add('gr-body');
  clear(panel).append(loading());
  const label = seasonFor(todayStr());
  let r; let top;
  try { [r, top] = await Promise.all([get(`/guests/loyalty/report?season=${label}`), get(`/guests/loyalty/top?season=${label}`)]); } catch (err) { clear(panel).append(errorBox(err)); return; }
  clear(panel);
  const seasonText = `The ${label.slice(0, 4)}-${Number(label.slice(0, 4)) + 1} season`;
  panel.append(h('p', { class: 'gr-intro' }, `${seasonText}, so far.`));
  panel.append(h('h3', { class: 'gr-sub' }, 'Rewards'));
  panel.append(r.rewards.length ? table([
    { head: 'Kind', cell: (x) => KIND[x.kind] || x.kind },
    { head: 'Given', num: true, cell: (x) => String(x.issued) },
    { head: 'Used', num: true, cell: (x) => String(x.used) },
    { head: 'Still open', num: true, cell: (x) => String(x.open) },
    { head: 'Credit used', num: true, cell: (x) => (x.credit_used_cents ? money(x.credit_used_cents) : '') },
  ], r.rewards) : h('p', { class: 'muted gr-pad' }, 'No rewards given yet this season.'));
  panel.append(h('h3', { class: 'gr-sub' }, 'Recaps'));
  const rk = { day: 'After a day', season: 'End of season' };
  panel.append(r.recaps.length ? table([
    { head: 'Recap', cell: (x) => rk[x.kind] || x.kind },
    { head: 'Guests', num: true, cell: (x) => String(x.people) },
    { head: 'Emails sent', num: true, cell: (x) => String(x.emails) },
    { head: 'Texts sent', num: true, cell: (x) => String(x.texts) },
    { head: 'Page opened', num: true, cell: (x) => String(x.viewed) },
  ], r.recaps) : h('p', { class: 'muted gr-pad' }, 'No recaps sent yet this season.'));
  panel.append(h('p', { class: 'muted small gr-pad' }, 'Page opened counts guests who opened the link in their recap. Email opens are not tracked.'));
  panel.append(h('h3', { class: 'gr-sub' }, 'Most loyal guests'));
  if (!top.data.length) { panel.append(h('p', { class: 'muted gr-pad' }, 'Nobody has scanned in yet this season.')); return; }
  const picked = new Set();
  const thank = h('button', { type: 'button', class: 'btn', disabled: true }, 'Send a thank you');
  const boxes = (p) => {
    const cb = h('input', { type: 'checkbox', 'aria-label': `Thank ${p.name}`, disabled: !p.has_email || p.thanked });
    cb.addEventListener('change', () => { if (cb.checked) picked.add(p.id); else picked.delete(p.id); thank.disabled = picked.size === 0; thank.textContent = picked.size ? `Send a thank you (${picked.size})` : 'Send a thank you'; });
    return cb;
  };
  panel.append(table([
    { head: '', cell: boxes },
    { head: 'Guest', cell: (p) => h('a', { href: `#/people/${p.id}` }, p.name) },
    { head: 'Days', num: true, cell: (p) => String(p.days) },
    { head: 'Note', cell: (p) => (p.thanked ? 'Thanked' : p.has_email ? '' : 'No email') },
  ], top.data));
  thank.addEventListener('click', () => {
    const note = input({ name: 'note', maxlength: 400, placeholder: 'Optional, for example: Your next hot chocolate is on us.' });
    const credit = input({ name: 'credit', inputmode: 'decimal', placeholder: '0.00' });
    formDialog('Send a thank you', h('div', { class: 'stack' },
      h('label', null, 'A line from you', note),
      h('label', null, 'A credit with it, in dollars (optional)', credit),
      h('p', { class: 'muted small' }, `${picked.size} ${picked.size === 1 ? 'guest' : 'guests'}. A credit is given once a season per guest.`)), async (fd) => {
      const c = val(fd, 'credit');
      const cents = c ? toCents(c) : 0;
      if (cents === null) throw new Error('Enter the credit in dollars, for example 15.00');
      const out = await post('/guests/loyalty/top/thanks', { person_ids: [...picked], note: val(fd, 'note') || undefined, credit_cents: cents || undefined });
      toast(`Thanked ${out.thanked}. ${out.emailed} ${out.emailed === 1 ? 'email' : 'emails'} sent.`);
      drawReport(panel);
    }, { submitText: 'Send' });
  });
  panel.append(h('div', { class: 'gr-save' }, thank));
}
