// The welcome back (guests round 2, Track WINDOW): one plain card about a returning guest, shown in Sell when a person is
// found or added, on the customer record, and as a short line at the gate. Visits this season, the last visit, a season
// pass, a birthday this week, the family's recent lessons and usual rental sizes, rewards they hold, and one suggested
// line to say. Never allergy or medical notes (the server never sends them). Also: the family's history and a manager's
// goodwill credit for the customer record.
import { get, post } from '../api.js';
import { h, clear, money, toCents, state, input, select, field, button, toast, dialog, formDialog, fmtDate, fmtDay, label, errorBox, isManager, table } from '../ui.js';

const KIND_WORDS = { birthday: 'Birthday gift', milestone: 'Milestone', loyalty: 'Loyalty day', firsttimer: 'First-timer offer', closure: 'Closure credit', conditions: 'Conditions credit', goodwill: 'Goodwill' };
const CHOICE_WORDS = { free_ticket: 'Free ticket', percent: 'Percent off', credit: 'Credit' };

/** The reward's choices as buttons' words: [['free_ticket', 'A free All-day ticket'], ...]. */
export function choicesOf(r) {
  const o = r.options || {};
  const out = [];
  if (o.free_ticket) out.push(['free_ticket', 'A free day ticket']);
  if (o.percent) out.push(['percent', `${o.percent.percent}% off one item`]);
  if (o.credit) out.push(['credit', `A ${money(o.credit.cents)} credit`]);
  return out;
}

/** Asks which choice the guest wants when a reward offers several; resolves to the choice, or null when closed. */
export function pickChoice(r) {
  const ch = choicesOf(r);
  if (ch.length === 1) return Promise.resolve(ch[0][0]);
  return new Promise((resolve) => {
    let picked = null;
    const dlg = dialog('Which one does the guest want?', h('div', { class: 'stack' },
      h('p', { class: 'muted' }, `${KIND_WORDS[r.kind] || 'Reward'}${r.person ? ` for ${r.person}` : ''}. The guest picks one.`),
      h('div', { class: 'stack tight', role: 'group', 'aria-label': 'Choices' }, ch.map(([k, words]) => button(words, () => { picked = k; dlg.close(); }, { kind: 'primary' })))), { onClose: () => resolve(picked) });
  });
}

/** One sentence for the visits: "Visit 7 this season (last: Sat, Dec 12)." */
function visitWords(w) {
  const v = w.visits;
  if (!v.total && !w.pass) return 'First visit with us.';
  if (!v.this_season) return v.last_day ? `First visit this season. Last here ${fmtDay(v.last_day)}.` : 'First visit this season.';
  const n = v.here_today ? v.this_season : v.visit_today;
  return `Visit ${n} this season${v.last_day && !v.here_today ? ` (last: ${fmtDate(v.last_day)})` : ''}.${v.first_day && v.total > v.this_season ? ` Coming since ${fmtDay(v.first_day).slice(-4)}.` : ''}`;
}

/**
 * The welcome-back card for a person. onUse(reward, choice) makes each reward usable from the card (Sell). compact: one
 * line and the facts, no family detail (the gate uses gateLine instead).
 */
export function welcomeCard(personId, { onUse = null, compact = false } = {}) {
  const box = h('section', { class: 'guest-card', 'aria-live': 'polite', 'aria-label': 'Welcome back' }, h('p', { class: 'muted small' }, 'Looking them up…'));
  get(`/guests/people/${personId}/welcome`).then((w) => {
    clear(box);
    const first = w.person.first_name;
    const facts = [visitWords(w)];
    if (w.pass) facts.push(w.pass.active ? `${w.pass.product} to ${fmtDate(w.pass.valid_to)}.` : `${w.pass.product} starts ${fmtDate(w.pass.valid_from)}.`);
    if (w.birthday_this_week) facts.push(w.birthday_this_week.today ? `Birthday today (${w.birthday_this_week.turning}).` : `Birthday ${w.birthday_this_week.weekday}.`);
    for (const f of w.family) {
      if (f.relation !== 'self' && f.birthday_this_week) facts.push(`${f.first_name}'s birthday ${f.birthday_this_week.today ? 'is today' : f.birthday_this_week.weekday}.`);
      if (!compact && f.line) facts.push(f.line);
    }
    box.append(
      h('header', { class: 'guest-card-head' }, h('strong', null, `${w.person.first_name} ${w.person.last_name}`), w.person.age !== null && w.person.age !== undefined ? h('span', { class: 'muted small' }, ` ${w.person.age}`) : null,
        ...(w.badges || []).map((b) => h('span', { class: 'guest-badge', 'data-kind': b.kind || '' }, b.text))),
      h('p', { class: 'guest-say' }, h('span', { class: 'visually-hidden' }, 'Suggested greeting: '), `"${w.line}"`),
      h('ul', { class: 'guest-facts' }, facts.map((t) => h('li', null, t))));
    if (w.rewards.length) {
      box.append(h('div', { class: 'guest-rewards' }, h('strong', { class: 'small' }, `${first}'s family holds`), h('ul', { class: 'plain' }, w.rewards.map((r) => h('li', { class: 'guest-reward' },
        h('span', null, h('b', null, KIND_WORDS[r.kind] || 'Reward'), r.person && r.person !== first ? ` for ${r.person}` : '', `: ${r.words}. Good to ${fmtDate(r.valid_to)}.`),
        onUse ? button('Use', async () => { const c = await pickChoice(r); if (c) onUse(r, c); }, { small: true, label: `Use ${KIND_WORDS[r.kind] || 'reward'}${r.person ? ` for ${r.person}` : ''}` }) : null)))));
    }
  }).catch((err) => { clear(box).append(errorBox(err)); });
  return box;
}

/** The gate's welcome: "Visit 7 this season. Birthday Thursday." from the scan result's holder.welcome. */
export function gateLine(welcome) {
  if (!welcome) return null;
  const bits = [welcome.first_visit ? 'First visit. Welcome!' : `Visit ${welcome.visit} this season.`];
  if (welcome.birthday) bits.push(welcome.birthday === 'today' ? 'Birthday today!' : `Birthday ${welcome.birthday}.`);
  return h('div', { class: 'gate-welcome', 'data-welcome': '' }, bits.join(' '));
}

/** The whole family's history on the customer record: tickets, passes, lessons, rentals, programs, visits and rewards. */
export function familyHistory(person) {
  const box = h('div', { class: 'stack', 'data-family-history': '' }, h('p', { class: 'muted small' }, 'Loading the family history…'));
  async function load() {
    try {
      const x = await get(`/guests/people/${person.id}/history`);
      clear(box);
      const who = (r) => r.who || '';
      box.append(h('ul', { class: 'plain family-visits' }, x.members.map((m) => h('li', null, h('strong', null, `${m.first_name} ${m.last_name}`), m.relation !== 'self' ? h('span', { class: 'muted small' }, ` ${label(m.relation)}`) : null,
        `: ${m.visits.this_season} day${m.visits.this_season === 1 ? '' : 's'} this season, ${m.visits.last_season} last season${m.visits.last_day ? `, last ${fmtDate(m.visits.last_day)}` : ''}.`))));
      if (x.rewards.length) box.append(h('h4', null, 'Rewards'), table([{ head: 'Who', cell: who }, { head: 'What', cell: (r) => `${KIND_WORDS[r.kind] || r.kind}: ${r.words}` }, { head: 'Good to', cell: (r) => fmtDate(r.valid_to) },
        { head: 'Status', cell: (r) => state(r.status === 'offered' ? 'Not used' : label(r.status), r.status === 'offered' ? 'good' : 'neutral') }, { head: 'Code', cell: (r) => r.code }], x.rewards));
      if (x.passes.length) box.append(h('h4', null, 'Season passes'), table([{ head: 'Who', cell: who }, { head: 'Pass', cell: (t) => t.product }, { head: 'Valid', cell: (t) => `${fmtDate(t.valid_from)} to ${fmtDate(t.valid_to)}` }, { head: 'Days scanned', num: true, cell: (t) => String(t.scans) }, { head: 'Status', cell: (t) => label(t.status) }], x.passes));
      if (x.tickets.length) box.append(h('h4', null, 'Tickets'), table([{ head: 'Who', cell: who }, { head: 'Ticket', cell: (t) => t.product }, { head: 'Day', cell: (t) => (t.valid_from === t.valid_to ? fmtDate(t.valid_from) : `${fmtDate(t.valid_from)} to ${fmtDate(t.valid_to)}`) }, { head: 'Used', cell: (t) => (t.scans ? 'Yes' : 'No') }, { head: 'Status', cell: (t) => label(t.status) }], x.tickets.slice(0, 40)));
      if (x.lessons.length) box.append(h('h4', null, 'Lessons'), table([{ head: 'Who', cell: who }, { head: 'Lesson', cell: (l) => l.name }, { head: 'Day', cell: (l) => fmtDate(l.day) }, { head: 'Level', cell: (l) => l.level_name || '' }, { head: 'Status', cell: (l) => label(l.status) }], x.lessons.slice(0, 40)));
      if (x.rentals.length) box.append(h('h4', null, 'Rentals'), table([{ head: 'Who', cell: who }, { head: 'Day', cell: (r) => (r.valid_on ? fmtDate(r.valid_on) : '') }, { head: 'Status', cell: (r) => label(r.status) }], x.rentals.slice(0, 40)));
      if (x.programs.length) box.append(h('h4', null, 'Programs'), table([{ head: 'Who', cell: who }, { head: 'Program', cell: (r) => r.name }, { head: 'Season', cell: (r) => r.season || '' }, { head: 'Status', cell: (r) => label(r.status) }], x.programs));
      if (x.can_give_goodwill) box.append(h('div', { class: 'row' }, button('Give a goodwill credit', () => goodwillDialog(person, load), { small: true })));
    } catch (err) { clear(box).append(errorBox(err)); }
  }
  load();
  return box;
}

/** A manager gives a goodwill credit (or a free ticket, or a percent off) with a reason. It shows on the welcome-back card. */
export async function goodwillDialog(person, done) {
  if (!isManager()) return;
  let tickets = [];
  try { tickets = (await get('/checkout/menu')).tickets.filter((p) => p.kind === 'day_ticket' || p.kind === 'multi_day'); } catch (_) { tickets = []; }
  const kind = select([['credit', 'A credit'], ['free_ticket', 'A free day ticket'], ['percent', 'A percent off']], 'credit', { name: 'kind', 'aria-label': 'What to give' });
  const amount = input({ name: 'amount', inputmode: 'decimal', placeholder: '25.00', 'aria-label': 'Credit amount' });
  const product = select(tickets.map((p) => [String(p.id), p.name]), tickets[0] ? String(tickets[0].id) : '', { name: 'product', 'aria-label': 'Which ticket' });
  const pct = input({ name: 'percent', type: 'number', min: 5, max: 100, value: 25, 'aria-label': 'Percent off' });
  const reason = input({ name: 'reason', maxlength: 200, required: true, placeholder: 'For example: lift stopped for an hour', 'aria-label': 'Why' });
  const days = input({ name: 'days', type: 'number', min: 1, max: 730, value: 365, 'aria-label': 'Good for how many days' });
  const amountF = field('Credit', amount); const productF = field('Ticket', product); const pctF = field('Percent off', pct);
  const show = () => { amountF.hidden = kind.value !== 'credit'; productF.hidden = kind.value !== 'free_ticket'; pctF.hidden = kind.value !== 'percent'; };
  kind.addEventListener('change', show); show();
  formDialog(`Goodwill for ${person.first_name}`, h('div', { class: 'form' }, field('Give', kind), amountF, productF, pctF, field('Why (saved in the audit log)', reason), field('Good for (days)', days),
    h('p', { class: 'muted small wide' }, 'The guest uses it once, at the window or online. It shows on their welcome-back card.')), async () => {
    const body = { reason: reason.value.trim(), valid_days: Number(days.value) || 365 };
    if (body.reason.length < 3) throw new Error('Say why');
    if (kind.value === 'credit') { const c = toCents(amount.value); if (!c || c < 100) throw new Error('Enter the credit amount'); body.credit_cents = c; }
    if (kind.value === 'free_ticket') { if (!product.value) throw new Error('Choose the ticket'); body.free_ticket_product_id = Number(product.value); }
    if (kind.value === 'percent') body.percent = Number(pct.value);
    const r = await post(`/guests/people/${person.id}/goodwill`, body);
    toast(`Goodwill given: ${r.words}. Code ${r.code}.`);
    if (done) await done();
  }, { submitText: 'Give it' });
}
