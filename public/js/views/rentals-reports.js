// The shop manager's reports (Rentals, Reports): how hard each piece works, what sits on the rack, what damage and
// repairs cost, the fees, the rental money each piece brings in and who came back late. The earlier summary stays as
// its own view.
import { get } from '../api.js';
import { h, clear, table, input, field, button, label, empty, money, todayStr, addDays, fmtDateTime, tabs } from '../ui.js';
import * as more from './rentals-more.js';

export async function drawReports(box) {
  clear(box).append(tabs([['shop', 'Gear and money', drawShop], ['summary', 'Summary', more.drawReports]], 'shop', { param: 'report' }));
}

const pct = (n) => `${Number(n).toFixed(1)}%`;
const stat = (name, value, note) => h('div', { class: 'card stat' }, h('div', { class: 'muted small' }, name), h('div', { class: 'big' }, String(value)), note ? h('div', { class: 'small muted' }, note) : null);
const gear = (p) => `${label(p.category)}${p.size ? ` ${p.size}` : ''}`;

async function drawShop(box) {
  const from = input({ type: 'date', value: addDays(todayStr(), -29), 'aria-label': 'From' });
  const to = input({ type: 'date', value: todayStr(), 'aria-label': 'To' });
  const out = h('div');
  async function run() {
    const r = await get(`/rentals/reports/shop?from=${from.value}&to=${to.value}`);
    const sumBy = (list, st) => list.filter((f) => !st || f.status === st).reduce((a, f) => a + Number(f.cents), 0);
    const repairs = r.service.reduce((a, s) => a + Number(s.cents), 0);
    const used = r.pieces.length ? r.pieces.reduce((a, p) => a + p.use_pct, 0) / r.pieces.length : 0;
    const kinds = [...new Set([...r.fees.charged.map((f) => f.kind), ...r.fees.settled.map((f) => f.kind)])];
    const pieceFilter = input({ type: 'search', placeholder: 'Find a tag, type or size', 'aria-label': 'Find a piece' });
    const piecesBox = h('div');
    const drawPieces = () => {
      const needle = pieceFilter.value.trim().toLowerCase();
      const shown = r.pieces.filter((p) => !needle || [p.sku, p.category, p.size, p.brand, p.model].filter(Boolean).join(' ').toLowerCase().includes(needle)).sort((a, b) => b.use_pct - a.use_pct || b.revenue_cents - a.revenue_cents);
      const first = shown.slice(0, 50);
      clear(piecesBox).append(shown.length ? table([
        { head: 'Tag', cell: (p) => h('strong', null, p.sku) },
        { head: 'Gear', cell: (p) => `${gear(p)}${p.tier === 'performance' ? ' (performance)' : ''}` },
        { head: 'Times out', num: true, cell: (p) => String(p.times) },
        { head: 'Days out', num: true, cell: (p) => String(p.days_out) },
        { head: 'Use', num: true, cell: (p) => pct(p.use_pct) },
        { head: 'Rental money', num: true, cell: (p) => money(p.revenue_cents) },
      ], first) : empty('No gear matches.'), shown.length > first.length ? h('p', { class: 'muted small' }, `Showing the 50 used most of ${shown.length}. Search to find others.`) : null);
    };
    pieceFilter.addEventListener('input', drawPieces);
    drawPieces();
    clear(out).append(h('div', { class: 'stack' },
      h('div', { class: 'tiles' },
        stat('Average use', pct(used), `of ${r.period_days} days`),
        stat('Never or once', r.rarely.length, 'pieces in this period'),
        stat('Rental money', money(r.revenue.rental_cents)),
        stat('Repair spend', money(repairs)),
        stat('Damaged returns', r.damaged_returns),
        stat('Lost', r.lost.n, r.lost.cost_cents ? `cost ${money(r.lost.cost_cents)}` : null),
        stat('Fees collected', money(sumBy(r.fees.settled, 'paid'))),
        stat('Fees waived', money(sumBy(r.fees.settled, 'waived'))),
        stat('Late returns', `${r.late.late} of ${r.late.returned}`)),
      h('h3', null, 'Use by type and size'),
      h('p', { class: 'muted small' }, 'Use is the days a piece was out divided by the days in the period. Low numbers mean more gear of that size than you need.'),
      r.by_type_size.length ? table([
        { head: 'Type and size', cell: (g) => h('strong', null, gear(g)) },
        { head: 'Pieces', num: true, cell: (g) => String(g.pieces) },
        { head: 'Times out', num: true, cell: (g) => String(g.times) },
        { head: 'Use', num: true, cell: (g) => pct(g.use_pct) },
        { head: 'Rental money', num: true, cell: (g) => money(g.revenue_cents) },
      ], [...r.by_type_size].sort((a, b) => a.category.localeCompare(b.category) || String(a.size).localeCompare(String(b.size), undefined, { numeric: true }))) : empty('No gear yet.'),
      h('h3', null, 'Each piece'), pieceFilter, piecesBox,
      h('h3', null, 'Never or rarely rented'),
      r.rarely.length ? table([
        { head: 'Tag', cell: (p) => h('strong', null, p.sku) }, { head: 'Gear', cell: (p) => gear(p) },
        { head: 'Times out', num: true, cell: (p) => String(p.times) }, { head: 'Status', cell: (p) => label(p.status) },
      ], r.rarely.slice(0, 50)) : h('p', { class: 'muted' }, 'Every piece went out at least twice.'),
      r.rarely.length > 50 ? h('p', { class: 'muted small' }, `Showing 50 of ${r.rarely.length}.`) : null,
      h('h3', null, 'Damage and repairs'),
      r.service.length ? table([{ head: 'Work', cell: (s) => label(s.kind) }, { head: 'Jobs', num: true, cell: (s) => String(s.n) }, { head: 'Spent', num: true, cell: (s) => money(s.cents) }], r.service) : h('p', { class: 'muted' }, 'No service logged in this period.'),
      h('h3', null, 'Fees'),
      kinds.length ? table([
        { head: 'Fee', cell: (k) => label(k) },
        { head: 'Charged', num: true, cell: (k) => money(sumBy(r.fees.charged.filter((f) => f.kind === k))) },
        { head: 'Collected', num: true, cell: (k) => money(sumBy(r.fees.settled.filter((f) => f.kind === k), 'paid')) },
        { head: 'Waived', num: true, cell: (k) => money(sumBy(r.fees.settled.filter((f) => f.kind === k), 'waived')) },
      ], kinds) : h('p', { class: 'muted' }, 'No fees in this period.'),
      r.fees.due_now.n ? h('p', { class: 'small' }, `Unpaid right now: ${r.fees.due_now.n} fee${r.fees.due_now.n === 1 ? '' : 's'}, ${money(r.fees.due_now.cents)}.`) : null,
      h('h3', null, 'Rental money per piece'),
      h('p', { class: 'muted small' }, `How it is worked out: each rental sold is shared equally across the pieces handed out on its contract. Fees are not counted. ${r.revenue.unlinked_cents ? `${money(r.revenue.unlinked_cents)} of rentals sold had no gear linked, so it is not in any piece.` : ''}`),
      (() => { const top = [...r.pieces].filter((p) => p.revenue_cents > 0).sort((a, b) => b.revenue_cents - a.revenue_cents).slice(0, 20);
        return top.length ? table([{ head: 'Tag', cell: (p) => h('strong', null, p.sku) }, { head: 'Gear', cell: (p) => gear(p) }, { head: 'Times out', num: true, cell: (p) => String(p.times) }, { head: 'Rental money', num: true, cell: (p) => money(p.revenue_cents) }], top) : h('p', { class: 'muted' }, 'No rental sales linked to gear in this period.'); })(),
      h('h3', null, 'Late returns'),
      r.late.list.length ? table([
        { head: 'Renter', cell: (c) => h('span', null, h('strong', null, c.renter), c.group_name ? ` (${c.group_name})` : '') },
        { head: 'Contract', cell: (c) => `#${c.id}` },
        { head: 'Was due', cell: (c) => fmtDateTime(c.due_at) },
        { head: 'Back', cell: (c) => fmtDateTime(c.back_at) },
        { head: 'Late by', cell: (c) => (c.minutes_late >= 1440 ? `${Math.floor(c.minutes_late / 1440)} d ${Math.round((c.minutes_late % 1440) / 60)} h` : `${Math.floor(c.minutes_late / 60)} h ${c.minutes_late % 60} min`) },
        { head: 'Late fee', num: true, cell: (c) => (c.late_fee_cents ? money(c.late_fee_cents) : 'None') },
      ], r.late.list) : h('p', { class: 'muted' }, 'Nothing came back late.')));
  }
  clear(box).append(h('div', { class: 'stack' }, h('div', { class: 'row report-range' }, field('From', from), field('To', to), button('Show', run, { kind: 'primary' })), out));
  await run();
}
