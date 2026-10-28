// Sell, Activities tab: places on the mountain's attractions (zipline tours, coaster rides, skating). Pick the attraction
// and the day, then a time slot with places left (or the whole day for a day pass), then how many guests of each type.
// Each guest becomes one line in the basket and one ticket. The places left refresh every 30 seconds while the tab is
// open; the server checks them again, under a lock, when the sale is made. At checkout the clerk confirms each rider meets
// the attraction's height, weight and age limits, and signs the waiver where the attraction needs one.
import { get } from '../api.js';
import { h, clear, appendAll, money, field, select, input, button, state, empty, errorBox, toast, fmtDate, isManager } from '../ui.js';

const REFRESH_MS = 30000;
const clock = (t) => { if (!t) return ''; const [hh, mm] = t.split(':').map(Number); return `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };

/**
 * Draws the tab into `box`. menu: /checkout/menu; tiers: [[code, name]]; add(line): puts one line in the basket;
 * done(): prices the basket again once every guest is in.
 */
export function drawActivities(box, { menu, tiers, first, add, done }) {
  const groups = menu.activities || [];
  if (!groups.length) { box.append(empty('No activities are on sale.', isManager() ? h('a', { class: 'btn primary', href: '#/catalog' }, 'Add an activity') : null)); return; }
  const attSel = select(groups.map((g) => [String(g.attraction.id), g.attraction.name]), String(groups[0].attraction.id), { name: 'act-attraction', 'aria-label': 'Attraction' });
  const date = input({ type: 'date', name: 'act-date', value: menu.today, min: menu.today, 'aria-label': 'Day' });
  const about = h('div', { class: 'act-about', 'aria-live': 'polite' });
  const slotsEl = h('div', { class: 'stack', 'aria-live': 'polite' });
  const counts = new Map(tiers.map(([code]) => [code, code === first ? 1 : 0]));
  const guestsEl = h('div', { class: 'act-guests', role: 'group', 'aria-label': 'Guests by type' });
  const addBtn = button('Add to basket', () => addGuests(), { kind: 'primary' });
  const msg = h('p', { class: 'small', role: 'status' });
  let day = null; // the day's products and slots from the server
  let picked = null; // { product, slot }
  let timer = null;

  const group = () => groups.find((g) => String(g.attraction.id) === attSel.value) || groups[0];
  const priceOf = (p, tier) => (p.tiers && p.tiers[tier] !== undefined ? p.tiers[tier] : p.base_price_cents);
  const guests = () => [...counts.values()].reduce((n, c) => n + c, 0);

  function drawAbout() {
    const a = group().attraction;
    appendAll(clear(about),
      a.status !== 'open' ? h('p', null, state(a.status === 'hold' ? 'On hold now' : 'Closed now', a.status === 'hold' ? 'warn' : 'bad'), a.status_note ? ` ${a.status_note}` : '') : null,
      a.limits_text ? h('p', { class: 'act-limits' }, h('strong', null, 'Limits: '), a.limits_text, ' You confirm each rider at checkout.') : null,
      a.waiver_required ? h('p', { class: 'muted small' }, 'Every rider needs a signed waiver for the season. Checkout shows who still needs one.') : null);
  }

  async function load({ quiet = false } = {}) {
    if (!quiet) clear(slotsEl).append(h('p', { class: 'muted', role: 'status' }, 'Loading times…'));
    try {
      const want = `${attSel.value}|${date.value}`;
      const out = await get(`/checkout/activity-day?date=${encodeURIComponent(date.value || menu.today)}&attraction_id=${encodeURIComponent(attSel.value)}`);
      if (want !== `${attSel.value}|${date.value}`) return; // the clerk moved on meanwhile
      day = out;
      // Keep the clerk's choice when it still exists after a refresh.
      if (picked) {
        const p = day.products.find((x) => x.id === picked.product.id);
        const s = p && p.slots.find((x) => x.start === picked.slot.start);
        picked = p && s ? { product: p, slot: s } : null;
      }
      drawSlots();
    } catch (err) { if (!quiet) clear(slotsEl).append(errorBox(err)); }
  }

  function drawSlots() {
    clear(slotsEl);
    const g = group();
    for (const p of day.products) {
      const meta = g.products.find((x) => x.id === p.id);
      if (!meta) continue;
      const prices = tiers.filter(([code]) => counts.get(code) > 0 || code === first).map(([code, name]) => `${name} ${money(priceOf(meta, code))}`).join(', ');
      const head = h('div', { class: 'spread' }, h('h3', null, p.name), h('span', { class: 'muted small' }, prices));
      if (p.closed) { slotsEl.append(h('section', { class: 'act-product' }, head, h('p', { class: 'muted' }, `Not sold on ${fmtDate(day.date)}.`))); continue; }
      const open = p.slots.filter((s) => !s.past);
      const btns = open.map((s) => {
        const full = s.left !== null && s.left < 1;
        const on = picked && picked.product.id === p.id && picked.slot.start === s.start;
        const text = s.start ? clock(s.start) : 'All day';
        const left = s.left === null ? 'Open' : full ? 'Full' : `${s.left} left`;
        return h('button', { type: 'button', class: `slot-btn${on ? ' on' : ''}${full ? ' full' : ''}`, disabled: full, 'aria-pressed': String(Boolean(on)), dataset: { slot: s.start || 'day', product: String(p.id) },
          'aria-label': `${p.name}, ${s.start ? s.label : 'all day'}, ${left}`, onclick: () => { picked = { product: p, slot: s }; drawSlots(); } },
        h('strong', null, text), h('small', null, left));
      });
      slotsEl.append(h('section', { class: 'act-product' }, head, btns.length ? h('div', { class: 'slot-grid' }, btns) : h('p', { class: 'muted' }, p.timed ? 'No times left on this day.' : 'Not on sale this day.')));
    }
    if (!slotsEl.childNodes.length) slotsEl.append(empty('Nothing is on sale for this attraction.'));
    drawGuests();
  }

  function drawGuests() {
    clear(guestsEl);
    for (const [code, name] of tiers) {
      const n = counts.get(code) || 0;
      const minus = button('−', () => { counts.set(code, Math.max(n - 1, 0)); drawGuests(); }, { small: true, label: `One fewer ${name}` });
      const plus = button('+', () => { counts.set(code, Math.min(n + 1, 20)); drawGuests(); }, { small: true, label: `One more ${name}` });
      minus.disabled = n < 1;
      guestsEl.append(h('div', { class: 'act-guest', dataset: { tier: code } }, h('span', null, name), h('span', { class: 'qty' }, minus, h('span', { 'aria-label': `${name} guests` }, String(n)), plus)));
    }
    const n = guests();
    addBtn.textContent = n ? `Add ${n} guest${n === 1 ? '' : 's'} to basket` : 'Add to basket';
    addBtn.disabled = !n || !picked;
    msg.textContent = picked ? `${picked.product.name}, ${fmtDate(day.date)}, ${picked.slot.start ? picked.slot.label : 'all day'}` : 'Choose a time.';
  }

  function addGuests() {
    if (!picked) throw new Error('Choose a time first');
    const n = guests();
    if (!n) throw new Error('Add at least one guest');
    if (picked.slot.left !== null && picked.slot.left < n) throw new Error(picked.slot.left ? `Only ${picked.slot.left} place${picked.slot.left === 1 ? '' : 's'} left at that time` : 'That time is full');
    const g = group();
    const when = picked.slot.start ? clock(picked.slot.start) : 'all day';
    for (const [code, name] of tiers) {
      for (let k = 0; k < (counts.get(code) || 0); k++) {
        add({ type: 'activity', product_id: picked.product.id, name: picked.product.name, tier: code, quantity: 1, valid_on: day.date, start_time: picked.slot.start || undefined, attraction: g.attraction, detail: `${name}, ${fmtDate(day.date)}, ${when}` });
      }
    }
    toast(`${n} guest${n === 1 ? '' : 's'} added: ${picked.product.name}, ${when}`);
    return done();
  }

  attSel.addEventListener('change', () => { picked = null; drawAbout(); load(); });
  date.addEventListener('change', () => { picked = null; load(); });
  // Places left refresh while the tab is on screen, and stop once it is gone.
  const tick = () => { if (!box.isConnected && timer) { window.clearInterval(timer); timer = null; return; } if (box.isConnected) load({ quiet: true }); };
  timer = window.setInterval(tick, REFRESH_MS);
  box.append(h('div', { class: 'menu-tools' }, field('Attraction', attSel), field('Day', date)), about, slotsEl,
    h('h3', null, 'Guests'), guestsEl, h('div', { class: 'row act-add' }, addBtn, msg));
  drawAbout();
  drawGuests();
  return load();
}
