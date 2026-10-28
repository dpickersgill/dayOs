// Sell > Partner passes: the Indy Pass and other partner passes the mountain honors. The window redeems a day (free, or
// at the program's discount once the free days are used), the visits list adds them up for checking the partner's
// statement. A manager sets the rules, blackout dates and online reservations in Settings, Sell and gate.
import { get, post, patch, put, download } from '../api.js';
import { h, clear, input, select, field, button, toast, formDialog, dialog, confirmDialog, empty, errorBox, state, fmtDate, money, todayStr, isManager, fail } from '../ui.js';

const addDays = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const rulesText = (p) => [
  p.free_days ? `${p.free_days} free day${p.free_days === 1 ? '' : 's'} a season` : null,
  p.discount_days ? `then ${p.discount_days} day${p.discount_days === 1 ? '' : 's'} at ${p.discount_percent}% off` : null,
  p.daily_limit ? `up to ${p.daily_limit} a day` : null,
  p.levels.some((l) => l.blackouts) ? `blackout dates for ${p.levels.filter((l) => l.blackouts).map((l) => l.label).join(' and ')}` : null,
].filter(Boolean).join(', ');

export async function render(root) {
  const body = h('div', { class: 'stack' });
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Partner passes')), body);
  await drawPartners(body);
}

/** The window's view, also the last tab in Sell: redeem a day and see the visits. The rules are set in Settings. */
export async function drawPartners(body) {
  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading partner passes…'));
    let r;
    try { r = await get('/partner-passes'); } catch (err) { clear(body).append(errorBox(err)); return; }
    clear(body);
    const live = r.data.filter((p) => p.active);
    if (!live.length) {
      body.append(empty(r.data.length ? 'No partner pass is switched on.' : 'No partner passes yet. Once a manager sets up the Indy Pass, or another pass whose holders ski here, the window records their days here.',
        isManager() ? h('a', { class: 'btn primary', href: '#/settings/sell' }, 'Set up partner passes in Settings') : null));
      return;
    }
    for (const p of live) {
      body.append(h('section', { class: 'panel stack partner-desk', 'data-partner': p.id },
        h('div', { class: 'row between' },
          h('div', null, h('h2', null, p.name), h('p', { class: 'muted small' }, rulesText(p))),
          h('div', { class: 'row' }, button('Redeem a day', () => redeem(p, r, load), { kind: 'primary' }), button('Visits', () => visits(p)))),
        h('p', null, `${p.today_count} visit${p.today_count === 1 ? '' : 's'} today.`, p.today_unchecked ? [' ', state(`${p.today_unchecked} reserved online, ID not checked yet`, 'warn')] : null),
        p.online ? h('p', { class: 'small' }, 'Guests reserve free days online at ', h('a', { href: r.reserve_path, target: '_blank', rel: 'noopener' }, `${location.origin}${r.reserve_path}`), '. Put the link on your website.') : null,
        p.staff_note ? h('p', { class: 'muted small' }, p.staff_note) : null));
    }
    if (isManager()) body.append(h('p', { class: 'muted small' }, 'Rules, blackout dates and new partner passes are in ', h('a', { href: '#/settings/sell' }, 'Settings, Sell and gate'), '.'));
  }
  await load();
}

/** Setup shown in Settings, Sell and gate (managers): each pass's rules and blackout dates, and whether Sell shows the tab. */
export const settingsPages = {
  partners: { title: 'Partner passes', render: (panel) => drawPartnerSetup(panel) },
};

async function drawPartnerSetup(panel) {
  const tab = await get('/partner-passes/tab');
  const sw = h('input', { type: 'checkbox', checked: tab.show, id: 'partner-tab-on', 'data-setting': 'partner_tab' });
  sw.addEventListener('change', async () => {
    sw.disabled = true;
    try { const out = await put('/partner-passes/tab', { show: sw.checked }); sw.checked = out.show; toast(out.show ? 'Sell shows the Partner passes tab' : 'Sell no longer shows the Partner passes tab'); } catch (err) { sw.checked = !sw.checked; fail(err); }
    sw.disabled = false;
  });
  const list = h('div', { class: 'stack' });
  panel.append(h('div', { class: 'stack' },
    h('div', { class: 'app-setting-row' }, h('label', { for: 'partner-tab-on' }, h('b', null, 'Show the Partner passes tab in Sell'), h('span', { class: 'muted small' }, 'For mountains that honor the Indy Pass or another partner pass. Turn it off if you take none.')), sw),
    list));
  async function load() {
    clear(list).append(h('p', { class: 'loading' }, 'Loading partner passes…'));
    let r;
    try { r = await get('/partner-passes'); } catch (err) { clear(list).append(errorBox(err)); return; }
    clear(list);
    if (!r.data.length) list.append(h('p', { class: 'muted' }, 'No partner passes yet. Set up the Indy Pass, or another pass whose holders ski here, and the window can record their days.'));
    for (const p of r.data) {
      list.append(h('div', { class: 'row between partner-rule', 'data-partner': p.id },
        h('div', null, h('b', null, p.name), p.active ? null : [' ', state('Off', 'neutral')], h('p', { class: 'muted small' }, rulesText(p) || 'No limits.')),
        h('div', { class: 'row' },
          button('Rules', () => setup(p, r, load), { small: true, label: `${p.name} rules` }),
          button('Visits', () => visits(p), { small: true, label: `${p.name} visits` }),
          p.levels.some((l) => l.blackouts) ? button('Blackout dates', () => blackouts(p, r, load), { small: true, label: `${p.name} blackout dates` }) : null)));
    }
    list.append(h('div', { class: 'row' },
      r.data.some((p) => p.name === 'Indy Pass') ? null : button('Set up the Indy Pass', () => indySetup(r, load), { kind: r.data.length ? null : 'primary', small: Boolean(r.data.length) }),
      button('Add another partner pass', () => setup(null, r, load), { small: true })));
  }
  await load();
}

function productSelect(r, value) {
  return select(r.products.map((x) => [String(x.id), x.name]), String(value || (r.products[0] || {}).id || ''), { name: 'product_id' });
}

function indySetup(r, after) {
  if (!r.products.length) { toast('Add a day ticket in Products and prices first: Indy days are issued as a $0 or discounted day ticket.', 'error'); return; }
  const prod = productSelect(r);
  formDialog('Set up the Indy Pass', [
    h('p', null, 'Starts with the usual Indy rules: two free days a season, then one day at 25% off. Indy Base has blackout dates; Indy+ does not. Check them against your Indy agreement and change anything under Rules.'),
    field('Issue Indy days as', prod, 'The day ticket the gate already knows. Its window price is what the discount day is taken off.'),
  ], async () => { await post('/partner-passes/indy', { product_id: Number(prod.value) }); toast('Indy Pass set up.'); after(); }, { submitText: 'Set up' });
}

function setup(p, r, after) {
  const v = p || { name: '', number_label: 'Pass number', free_days: 2, discount_days: 1, discount_percent: 25, daily_limit: null, id_check: true, online: false, reservation_required: false, staff_note: '', active: true, levels: [{ key: 'standard', label: 'Standard', blackouts: true }] };
  const name = input({ maxlength: 80, required: true, value: v.name });
  const label = input({ maxlength: 60, value: v.number_label });
  const prod = productSelect(r, v.product_id);
  const free = input({ type: 'number', min: 0, max: 30, value: v.free_days });
  const disc = input({ type: 'number', min: 0, max: 30, value: v.discount_days });
  const pct = input({ type: 'number', min: 0, max: 100, value: v.discount_percent });
  const limit = input({ type: 'number', min: 1, placeholder: 'No limit', value: v.daily_limit ?? '' });
  const box = (checked, text) => { const c = input({ type: 'checkbox', checked }); return [c, h('label', { class: 'check' }, c, ` ${text}`)]; };
  const [idc, idcEl] = box(v.id_check, 'Check photo ID before a day is given');
  const [onl, onlEl] = box(v.online, 'Guests can reserve free days online');
  const [resv, resvEl] = box(v.reservation_required, 'Holders must reserve ahead (shown to guests)');
  const [act, actEl] = box(v.active, 'On');
  const note = h('textarea', { rows: 2, maxlength: 500 }, v.staff_note || '');
  const levels = v.levels.map((l) => ({ ...l }));
  const levelBox = h('div', { class: 'stack tight' });
  const drawLevels = () => clear(levelBox).append(...levels.map((l, i) => {
    const t = input({ maxlength: 40, value: l.label, 'aria-label': 'Level name' });
    t.addEventListener('input', () => { l.label = t.value; });
    const b = input({ type: 'checkbox', checked: l.blackouts });
    b.addEventListener('change', () => { l.blackouts = b.checked; });
    return h('div', { class: 'row' }, t, h('label', { class: 'check' }, b, ' Has blackout dates'), levels.length > 1 ? button('Remove', () => { levels.splice(i, 1); drawLevels(); }, { small: true }) : null);
  }), button('Add a level', () => { levels.push({ key: '', label: '', blackouts: true }); drawLevels(); }, { small: true }));
  drawLevels();
  const keyOf = (l, i) => l.key || (l.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || `level_${i + 1}`);
  formDialog(p ? `${p.name} rules` : 'Add a partner pass', [
    field('Name', name), field('Issue days as', prod), field('What the pass number is called', label, 'For example: Indy customer number'),
    h('div', { class: 'row wrap' }, field('Free days a season', free), field('Then discounted days', disc), field('Discount (%)', pct), field('Daily limit', limit, 'Leave empty for no limit')),
    h('fieldset', null, h('legend', null, 'Pass levels'), levelBox),
    idcEl, onlEl, resvEl, p ? actEl : null,
    field('Note for the window', note, 'Shown to staff when they redeem a day'),
  ], async () => {
    const body = {
      name: name.value.trim(), product_id: Number(prod.value), number_label: label.value.trim() || 'Pass number',
      free_days: Number(free.value || 0), discount_days: Number(disc.value || 0), discount_percent: Number(pct.value || 0),
      daily_limit: limit.value ? Number(limit.value) : null, id_check: idc.checked, online: onl.checked, reservation_required: resv.checked,
      staff_note: note.value.trim() || null, levels: levels.filter((l) => l.label.trim()).map((l, i) => ({ key: keyOf(l, i), label: l.label.trim(), blackouts: Boolean(l.blackouts) })),
    };
    if (p) { body.active = act.checked; await patch(`/partner-passes/${p.id}`, body); } else await post('/partner-passes', body);
    toast('Saved.');
    after();
  }, { wide: true });
}

function blackouts(p, r, after) {
  const dates = new Set(p.blackouts);
  const list = h('div', { class: 'row wrap' });
  const draw = () => clear(list).append(...(dates.size ? [...dates].sort().map((d) => h('span', { class: 'chip' }, fmtDate(d), ' ', button('Remove', () => { dates.delete(d); draw(); }, { small: true, label: `Remove ${d}` }))) : [h('p', { class: 'muted' }, 'No blackout dates ahead.')]));
  const from = input({ type: 'date', min: todayStr(), 'aria-label': 'From' });
  const to = input({ type: 'date', min: todayStr(), 'aria-label': 'To (optional)' });
  const add = button('Add', () => {
    if (!from.value) return;
    const end = to.value && to.value >= from.value ? to.value : from.value;
    for (let d = from.value; d <= end; d = addDays(d, 1)) dates.add(d);
    from.value = ''; to.value = ''; draw();
  }, { small: true });
  draw();
  formDialog(`${p.name} blackout dates`, [
    h('p', null, `${p.levels.filter((l) => l.blackouts).map((l) => l.label).join(' and ')} holders cannot redeem on these days. ${p.levels.filter((l) => !l.blackouts).map((l) => l.label).join(' and ') || 'Other levels'} still can.`),
    h('div', { class: 'row wrap' }, field('From', from), field('To', to, 'For a run of days'), add), list,
  ], async () => { await put(`/partner-passes/${p.id}/blackouts`, { dates: [...dates] }); toast('Blackout dates saved.'); after(); });
}

function redeem(p, r, after) {
  const number = input({ maxlength: 60, required: true, autocomplete: 'off', placeholder: p.number_label });
  const level = select(p.levels.map((l) => [l.key, l.label]), p.levels[0].key);
  const date = input({ type: 'date', value: r.today, min: r.today });
  const first = input({ maxlength: 100, autocomplete: 'off' });
  const last = input({ maxlength: 100, autocomplete: 'off' });
  const dob = input({ type: 'date', max: r.today });
  const sex = select([['', 'Choose'], ['female', 'Female'], ['male', 'Male'], ['other', 'Another']], '');
  const email = input({ type: 'email', maxlength: 255 });
  const phone = input({ type: 'tel', maxlength: 40 });
  const idc = input({ type: 'checkbox' });
  const waiver = input({ type: 'checkbox' });
  const tender = select([['card', 'Card'], ['cash', 'Cash'], ['other', 'Other']], 'card');
  const result = h('div', { role: 'status' });
  let quote = null; let seq = 0;
  const look = async () => {
    const mine = ++seq; // only the latest check is shown, however many were started
    clear(result); quote = null;
    if (number.value.trim().length < 3) return;
    try {
      const c = await get(`/partner-passes/${p.id}/check?number=${encodeURIComponent(number.value.trim())}&level=${encodeURIComponent(level.value)}&date=${date.value}`);
      const hist = c.history && c.history.length ? h('p', { class: 'small muted' }, `Days here this season: ${c.history.map((x) => fmtDate(x.on_date)).join(', ')}`) : h('p', { class: 'small muted' }, 'No days here yet this season.');
      if (mine !== seq) return;
      if (!c.ok) { result.append(...[h('div', { class: 'error-box', role: 'alert' }, c.reason), c.history && c.history.length ? hist : null].filter(Boolean)); return; }
      quote = c;
      result.append(...[h('p', null, c.kind === 'free' ? state(`Free day ${c.used.free + 1} of ${c.free_days}`, 'good') : state(`${c.percent}% off: ${money(c.price_cents)} (window ${money(c.window_cents)})`, 'warn')), hist,
        c.kind === 'discount' ? field('Paid by', tender) : null].filter(Boolean));
    } catch (err) { if (mine === seq) result.append(errorBox(err)); }
  };
  for (const el of [number, level, date]) el.addEventListener('change', look);
  number.addEventListener('blur', look);
  formDialog(`Redeem a day: ${p.name}`, [
    p.staff_note ? h('p', { class: 'muted small' }, p.staff_note) : null,
    h('div', { class: 'row wrap' }, field(p.number_label, number), field('Level', level), field('Day', date)),
    button('Check this pass', look, { small: true }), result,
    h('fieldset', null, h('legend', null, 'Guest'),
      h('div', { class: 'row wrap' }, field('First name', first), field('Last name', last)),
      h('div', { class: 'row wrap' }, field('Date of birth', dob), field('Sex', sex)),
      h('div', { class: 'row wrap' }, field('Email', email), field('Cell phone', phone, 'An email or a phone for an adult'))),
    p.id_check ? h('label', { class: 'check' }, idc, ' Photo ID matches the name on the pass account') : null,
    h('label', { class: 'check' }, waiver, ' Signed the waiver here today (if this season\'s is not on file)'),
  ], async () => {
    if (!quote) { await look(); if (!quote) throw new Error('Check the pass first'); }
    const details = { first_name: first.value.trim(), last_name: last.value.trim(), date_of_birth: dob.value || undefined, sex: sex.value || undefined, email: email.value.trim() || undefined, phone: phone.value.trim() || undefined };
    const line = { type: 'ticket', product_id: p.product_id, valid_on: date.value, partner: { program_id: p.id, number: number.value.trim(), level: level.value, id_checked: idc.checked } };
    const payments = quote.kind === 'discount' && quote.price_cents > 0 ? [{ tender: tender.value, amount_cents: quote.price_cents }] : [];
    const out = await post('/checkout', { customer: { details, sign_waiver: waiver.checked || undefined }, lines: [line], payments });
    const t = out.tickets[0];
    dialog(`${p.name} day recorded`, h('div', { class: 'stack' },
      h('p', null, `${t.holder || details.first_name}: ${fmtDate(t.valid_from)}. ${out.total_cents ? `Paid ${money(out.total_cents)}.` : 'No charge.'}`),
      h('p', null, 'Ticket ', h('b', null, t.code), '. Print it or load it on a card from the order, as for any day ticket.'),
      p.name === 'Indy Pass' ? h('p', { class: 'muted small' }, 'Record the visit in Indy too, as Indy asks.') : null));
    after();
  }, { wide: true, submitText: 'Record the day' });
}

async function visits(p) {
  const to = input({ type: 'date', value: todayStr() });
  const from = input({ type: 'date', value: todayStr() });
  const out = h('div', { class: 'stack' });
  const load = async () => {
    clear(out).append(h('p', { class: 'loading' }, 'Loading…'));
    let r;
    try { r = await get(`/partner-passes/${p.id}/redemptions?from=${from.value}&to=${to.value}`); } catch (err) { clear(out).append(errorBox(err)); return; }
    const lv = (k) => (p.levels.find((l) => l.key === k) || { label: k || '' }).label;
    clear(out).append(
      h('p', null, `${r.totals.visits} visit${r.totals.visits === 1 ? '' : 's'}: ${r.totals.free} free, ${r.totals.discount} discounted. Charged ${money(r.totals.charged_cents)}; window value ${money(r.totals.window_cents)}.`),
      r.data.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'rt' },
        h('thead', null, h('tr', null, ['Day', 'Pass', 'Guest', 'Kind', 'Charged', 'Where', 'ID', ''].map((x) => h('th', null, x)))),
        h('tbody', null, r.data.map((x) => h('tr', { class: x.counts ? null : 'muted' },
          h('td', null, fmtDate(x.on_date)), h('td', null, x.number, h('div', { class: 'small muted' }, lv(x.level))), h('td', null, x.holder || ''),
          h('td', null, x.kind === 'free' ? 'Free' : `${x.percent_off}% off`, x.status === 'void' ? h('div', { class: 'small' }, `Voided: ${x.void_reason || ''}`) : !x.counts ? h('div', { class: 'small' }, 'Refunded') : null),
          h('td', null, money(x.charged_cents)), h('td', null, x.channel === 'online' ? 'Online' : 'Window'),
          h('td', null, x.id_checked ? 'Checked' : x.counts ? button('ID checked', async () => { try { await post(`/partner-passes/redemptions/${x.id}/id-checked`); toast('Saved.'); load(); } catch (err) { fail(err); } }, { small: true }) : ''),
          h('td', null, isManager() && x.status === 'active' ? button('Void', () => voidVisit(x, load), { small: true }) : null)))))) : empty('No visits in these dates.'));
  };
  for (const el of [from, to]) el.addEventListener('change', load);
  dialog(`${p.name} visits`, h('div', { class: 'stack' },
    h('div', { class: 'row wrap' }, field('From', from), field('To', to),
      button('Download spreadsheet', () => download(`/partner-passes/${p.id}/redemptions.csv?from=${from.value}&to=${to.value}`, `${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${from.value}.csv`).catch(fail), { small: true })),
    h('p', { class: 'muted small' }, 'Use this to check the partner\'s statement. A refunded or voided day is listed but not counted.'), out), { wide: true });
  await load();
}

function voidVisit(x, after) {
  const why = input({ maxlength: 200, required: true, placeholder: 'For example: wrong pass number' });
  formDialog('Void this visit?', [h('p', null, `The day goes back on ${x.number}'s pass and its ticket stops working at the gate. Refund any payment from the order as usual.`), field('Why', why)],
    async () => { await post(`/partner-passes/redemptions/${x.id}/void`, { reason: why.value.trim() }); toast('Voided.'); after(); }, { submitText: 'Void' });
}

export const _test = { rulesText, confirmDialog };
