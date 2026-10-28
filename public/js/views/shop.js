// Online shop desk: find a guest's order at the window (will-call), follow up group inquiries, see who is waiting for a
// sold-out day, and (managers) watch ticket sales pace. Prices and limits for many days at once are set in Settings,
// Online shop (settingsPages below).
import { get, post, patch } from '../api.js';
import { h, clear, fail, money, toCents, table, state, input, select, field, button, toast, tabs, fmtDate, fmtDateTime, todayStr, addDays, empty, errorBox, isManager } from '../ui.js';

export async function render(root) {
  const items = [['willcall', 'Will-call', willcall], ['groups', 'Group inquiries', groups], ['waitlist', 'Waitlist', waitlist]];
  if (isManager()) items.push(['pace', 'Sales pace', pace]);
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Online shop')), tabs(items, 'willcall'));
}

/** Setup shown in Settings, Online shop (managers): prices and limits for many days at once. */
export const settingsPages = {
  limits: { title: 'Prices and limits', render: (panel) => calendar(panel) },
};

// ---------------------------------------------------------------- will-call
async function willcall(box) {
  const q = input({ type: 'search', placeholder: 'Reference, email, phone, name or ticket code', 'aria-label': 'Find an online order', autocomplete: 'off' });
  const out = h('div', { class: 'stack', 'aria-live': 'polite' });
  async function find() {
    clear(out);
    if (q.value.trim().length < 3) { out.append(h('p', { class: 'muted' }, 'Type at least 3 letters or numbers.')); return; }
    try {
      const r = await get(`/online-shop/lookup?q=${encodeURIComponent(q.value.trim())}`);
      if (!r.data.length) { out.append(empty('No paid online order matches that.')); return; }
      out.append(...r.data.map(card));
    } catch (e) { out.append(errorBox(e)); }
  }
  const card = (o) => h('section', { class: 'card stack' },
    h('div', { class: 'row' }, h('h3', null, o.contact_name), state(o.reference, 'neutral'), h('span', { class: 'muted' }, `${money(o.amount_cents)} · ${fmtDateTime(o.created_at)}`)),
    h('p', { class: 'muted small' }, [o.contact_email, o.contact_phone].filter(Boolean).join(' · ')),
    table([
      { head: 'Ticket', cell: (t) => [h('strong', null, t.product), h('div', { class: 'muted small' }, `${t.first_name || ''} ${t.last_name || ''}`.trim())] },
      { head: 'Valid', cell: (t) => (t.valid_from === t.valid_to ? fmtDate(t.valid_from) : `${fmtDate(t.valid_from)} to ${fmtDate(t.valid_to)}`) },
      { head: 'Code', cell: (t) => h('code', null, t.code) },
      { head: 'Status', cell: (t) => (t.status === 'void' ? state('Canceled', 'bad') : t.scans ? state(`Used ${t.scans}x`, 'warn') : state('Not used', 'good')) },
    ], o.tickets),
    h('div', { class: 'row' },
      h('a', { class: 'btn', href: o.link, target: '_blank', rel: 'noopener' }, 'Open and print tickets'),
      button(o.emailed_at ? 'Email tickets again' : 'Email tickets', async () => { try { await post(`/online-shop/orders/${o.id}/resend`, {}); toast('Sent'); } catch (e) { fail(e); } }),
      button('Copy ticket link', async () => { try { await navigator.clipboard.writeText(o.link); toast('Link copied'); } catch (_) { toast('Copy did not work. Use Open and print tickets.', 'error'); } })));
  const form = h('form', { class: 'inline-form' }, field('Find an online order', q), button('Find', null, { kind: 'primary', type: 'submit' }));
  form.addEventListener('submit', (e) => { e.preventDefault(); find(); });
  box.append(h('p', { class: 'muted' }, 'A guest bought online and cannot find their email? Search here, then print their tickets or email them again. Scan the barcode at the Gate as usual.'), form, out);
}

// ---------------------------------------------------------------- groups
const GSTATUS = { new: 'New', contacted: 'Contacted', booked: 'Booked', closed: 'Closed' };
async function groups(box) {
  const r = await get('/online-shop/groups');
  box.append(h('p', { class: 'muted' }, 'Schools, clubs and companies who asked for a group quote on your shop page. Reply by email or phone, then mark where it stands.'),
    r.data.length ? table([
      { head: 'Received', cell: (g) => fmtDateTime(g.created_at) },
      { head: 'Group', cell: (g) => [h('strong', null, g.organisation || g.contact_name), h('div', { class: 'muted small' }, g.organisation ? g.contact_name : '')] },
      { head: 'People', num: true, cell: (g) => String(g.group_size) },
      { head: 'Day wanted', cell: (g) => (g.preferred_on ? fmtDate(g.preferred_on) : '') },
      { head: 'Contact', cell: (g) => [h('a', { href: `mailto:${g.email}` }, g.email), g.phone ? h('div', { class: 'muted small' }, g.phone) : null] },
      { head: 'Note', cell: (g) => g.note || '' },
      { head: 'Status', cell: (g) => {
        const sel = h('select', { 'aria-label': `Status for ${g.organisation || g.contact_name}` }, Object.entries(GSTATUS).map(([k, v]) => h('option', { value: k, selected: k === g.status }, v)));
        sel.addEventListener('change', async () => { try { await patch(`/online-shop/groups/${g.id}`, { status: sel.value }); toast('Saved'); } catch (e) { fail(e); } });
        return sel;
      } },
    ], r.data) : empty('No group inquiries yet.'));
}

// ---------------------------------------------------------------- waitlist
async function waitlist(box) {
  const r = await get('/online-shop/waitlist');
  box.append(h('p', { class: 'muted' }, 'Guests who asked to be emailed if a sold-out day opens up. They are told once, automatically, the next time the daily job runs after tickets are available. Raising a day\'s limit is the quickest way to serve them.', isManager() ? [' ', h('a', { href: '#/settings/shop' }, 'Prices and limits are in Settings, Online shop.')] : null),
    r.data.length ? table([
      { head: 'Day', cell: (d) => fmtDate(d.on_date) },
      { head: 'People waiting', num: true, cell: (d) => String(d.people) },
      { head: 'Requests', num: true, cell: (d) => String(d.entries) },
      { head: 'Already told', num: true, cell: (d) => String(Number(d.told)) },
    ], r.data) : empty('Nobody is waiting for a day.'));
}

// ---------------------------------------------------------------- prices and limits calendar
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
async function calendar(box) {
  const first = input({ type: 'date', value: todayStr(), 'aria-label': 'First day' });
  const last = input({ type: 'date', value: addDays(todayStr(), 41), 'aria-label': 'Last day' });
  const days = DOW.map((d, i) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, dataset: { dow: String(i) } }), d));
  const who = select([], '', { 'aria-label': 'Product' });
  const act = h('select', { 'aria-label': 'What to do' }, [['price', 'Set the price'], ['close', 'Close for sale'], ['open', 'Reopen a closed day'], ['limit', 'Set a limit for these days'], ['clear_limit', 'Remove the limit for these days'], ['clear', 'Back to normal prices']].map(([k, v]) => h('option', { value: k }, v)));
  const amount = input({ inputmode: 'decimal', placeholder: 'Dollars', 'aria-label': 'Price in dollars' });
  const lim = input({ type: 'number', min: 0, placeholder: 'Tickets', 'aria-label': 'Most tickets' });
  const view = h('div'); const msg = h('div', { role: 'status' });
  let products = [];
  const sync = () => { amount.parentElement.hidden = act.value !== 'price'; lim.parentElement.hidden = act.value !== 'limit'; };
  async function load() {
    clear(view).append(h('p', { class: 'loading', role: 'status' }, 'Loading…'));
    try {
      const out = await get(`/online-shop/calendar?from=${first.value}&to=${addDays(first.value, 41) < last.value ? addDays(first.value, 41) : last.value}`);
      products = out.products;
      clear(who).append(h('option', { value: '' }, 'All day and multi-day tickets (limits: whole mountain)'), ...products.map((p) => h('option', { value: String(p.id) }, p.name)));
      clear(view).append(out.days.length ? table([
        { head: 'Day', cell: (d) => h('strong', null, fmtDate(d.date)) },
        ...products.map((p) => ({ head: p.name, cell: (d) => { const c = d.products.find((x) => x.id === p.id); return c.closed ? state('Closed', 'bad') : [c.price_cents === null ? '' : money(c.price_cents), c.special ? ' ' : '', c.special ? state('special', 'info') : null, c.limit !== null ? h('div', { class: 'muted small' }, `${c.sold} of ${c.limit}${c.limit_is_override ? ' (this day)' : ''}`) : h('div', { class: 'muted small' }, `${c.sold} sold`)]; } })),
        { head: 'All together', cell: (d) => (d.mountain_limit === null ? `${d.sold} sold` : `${d.sold} of ${d.mountain_limit}${d.mountain_limit_is_override ? ' (this day)' : ''}`) },
      ], out.days) : empty('No days in that range.'));
    } catch (e) { clear(view).append(errorBox(e)); }
  }
  const apply = button('Apply to these days', async () => {
    clear(msg);
    const body = { from: first.value, to: last.value, action: act.value, weekdays: days.map((l) => l.firstChild).filter((c) => c.checked).map((c) => Number(c.dataset.dow)) };
    if (who.value) body.product_id = Number(who.value);
    if (act.value === 'price') { const c = toCents(amount.value); if (!c) { msg.append(errorBox('Enter the price in dollars, for example 89.00')); return; } body.price_cents = c; }
    if (act.value === 'limit') { if (lim.value === '') { msg.append(errorBox('Enter the most tickets for these days')); return; } body.limit = Number(lim.value); }
    try { const r = await post('/online-shop/calendar', body); toast(`Changed ${r.days} day${r.days === 1 ? '' : 's'}`); await load(); } catch (e) { msg.append(errorBox(e)); }
  }, { kind: 'primary' });
  const form = h('div', { class: 'stack' },
    h('div', { class: 'inline-form' }, field('First day', first), field('Last day', last), button('Show', load)),
    h('div', { class: 'row', role: 'group', 'aria-label': 'Weekdays' }, days),
    h('div', { class: 'inline-form' }, field('Product', who), field('Do this', act), field('Price ($)', amount), field('Most tickets', lim)),
    msg, h('div', { class: 'row' }, apply));
  act.addEventListener('change', sync);
  box.append(h('p', { class: 'muted' }, 'Change many days at once, for example Saturdays in February, or a holiday week. Prices apply to every age group. A limit set here for a day replaces the usual limit for that day only. Window sales count toward it, but only the online shop is stopped.'), form, view);
  sync(); await load();
}

// ---------------------------------------------------------------- sales pace and funnel
async function pace(box) {
  const r = await get('/online-shop/pace');
  const chg = (p) => (p === null ? 'No sales a year ago to compare.' : p === 0 ? 'Same as last year.' : `${p > 0 ? 'Up' : 'Down'} ${Math.abs(p)}% on last year.`);
  const stat = (title, now, was, p, fmt = String) => h('div', { class: 'card stack' }, h('span', { class: 'muted' }, title), h('strong', { class: 'big' }, fmt(now)), h('span', { class: 'muted small' }, `${fmt(was)} a year ago. ${chg(p)}`));
  const w = r.window; const top = Math.max(1, ...r.ahead.map((d) => Math.max(d.sold, d.last_year_by_now)));
  box.append(h('p', { class: 'muted' }, `Online sales over the last ${w.days} days, against the same days of the week one year ago (364 days earlier).`),
    h('div', { class: 'grid-3' }, stat('Orders', w.now.orders, w.last_year.orders, w.change.orders), stat('Tickets', w.now.tickets, w.last_year.tickets, w.change.tickets), stat('Online revenue', w.now.revenue_cents, w.last_year.revenue_cents, w.change.revenue, money)),
    h('h3', null, 'Visit days coming up'),
    h('p', { class: 'muted small' }, 'Online tickets sold so far for each day, against what had been sold a year ago at this same point (and the final total that day).'),
    table([
      { head: 'Day', cell: (d) => fmtDate(d.date) },
      { head: 'Sold now', num: true, cell: (d) => String(d.sold) },
      { head: 'A year ago, by now', num: true, cell: (d) => String(d.last_year_by_now) },
      { head: 'A year ago, final', num: true, cell: (d) => String(d.last_year_final) },
      { head: 'Pace', cell: (d) => h('span', { class: 'pace-bars', 'aria-hidden': 'true' }, h('i', { style: `display:block;height:8px;width:${Math.round((d.sold / top) * 100)}%;background:var(--accent,#1a5fb4)` }), h('i', { style: `display:block;height:8px;margin-top:2px;width:${Math.round((d.last_year_by_now / top) * 100)}%;background:#9aa7b4` })) },
    ], r.ahead),
    h('h3', null, 'From visit to sale'),
    h('p', { class: 'muted small' }, `The last ${w.days} days. A visit is someone opening the shop page. A basket is an order that reached the card page.`),
    h('div', { class: 'grid-3' },
      h('div', { class: 'card stack' }, h('span', { class: 'muted' }, 'Visits'), h('strong', { class: 'big' }, String(r.funnel.visits))),
      h('div', { class: 'card stack' }, h('span', { class: 'muted' }, 'Went to pay'), h('strong', { class: 'big' }, String(r.funnel.baskets)), h('span', { class: 'muted small' }, r.funnel.visit_to_basket === null ? '' : `${r.funnel.visit_to_basket}% of visits`)),
      h('div', { class: 'card stack' }, h('span', { class: 'muted' }, 'Paid'), h('strong', { class: 'big' }, String(r.funnel.paid)), h('span', { class: 'muted small' }, r.funnel.basket_to_paid === null ? '' : `${r.funnel.basket_to_paid}% of those who went to pay`))));
}
