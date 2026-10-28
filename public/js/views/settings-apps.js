// Settings, Apps: one page per app that has setup. Each page shows the app's own setup sections (the app module's
// `settingsPages` export: { key: { title, render(panel), who? } }) as cards, after the settings that used to be on
// Account: Sell and gate (the counter's free-of-charge limit, quick sale, the gate's scanned-again warning), Online shop
// (guests buying online, date changes, the daily limit, the shop's look) and Ski school (online booking, cancellations
// and refunds). A module without the export, or one that fails to load, simply adds nothing.
import { get, put } from '../api.js';
import { h, ctx, input, errorBox, toCents, centsToInput, loading } from '../ui.js';
import { brandPanel } from './shopbrand.js';
import { card, row, toggle, amount, linkRow, formTracker, nothingHere } from './settings-kit.js';

// The app views whose setup shows on each page, and the module that must be on for each.
const SOURCES = {
  sell: [['gate', 'gate'], ['partners', 'sell']],
  shop: [['shop', 'shop']],
  school: [['school', 'school'], ['availability', 'availability']],
  programs: [['programs', 'programs']],
  rentals: [['rentals', 'rentals']],
  attractions: [['attractions', 'conditions']],
  waivers: [['waivers', null]],
  patrol: [['patrol', 'patrol']],
  workforce: [['workforce', 'workforce']],
  messages: [['messages', 'messages']],
};
// Pages that hold settings of their own (from Account), so they show even before any app adds a section.
const OWN = ['sell', 'shop', 'school'];

const moduleOn = (k) => !k || !ctx.me.modules || ctx.me.modules.includes(k);
const loaded = new Map();
/** An app view's setup sections, or {} when it has none (or cannot be loaded). */
export function sectionsOf(file) {
  if (!loaded.has(file)) loaded.set(file, import(`./${file}.js`).then((m) => (m && m.settingsPages && typeof m.settingsPages === 'object' ? m.settingsPages : {})).catch(() => ({})));
  return loaded.get(file);
}
// sec.who: none (anyone who can open the page), 'manager', 'patrol-admin', { patrolLevel: 'admin' } or
// { patrol: [features] } (any one of those Patrol permissions). Owners and managers see every section.
const allowed = (sec, who) => {
  const w = sec.who;
  if (!w || who.manager) return true;
  if (w === 'manager') return false;
  if (w === 'patrol-admin') return Boolean(who.patrolAdmin);
  const p = who.patrol;
  if (!p || typeof w !== 'object') return false;
  if (w.patrolLevel) return p.level === w.patrolLevel;
  return Array.isArray(w.patrol) && w.patrol.some((f) => (p.features || []).includes(f));
};

/** The sections a page shows this person: [[file, key, section]]. */
async function sectionsFor(page, who) {
  const out = [];
  for (const [file, mod] of SOURCES[page] || []) {
    if (!moduleOn(mod)) continue;
    const secs = await sectionsOf(file);
    for (const [key, sec] of Object.entries(secs)) if (sec && typeof sec.render === 'function' && allowed(sec, who)) out.push([file, key, sec]);
  }
  return out;
}

/** Whether a page has anything for this person to set up. */
export async function pageHasSetup(page, who) {
  if (OWN.includes(page) && who.manager) return true;
  return (await sectionsFor(page, who)).length > 0;
}

export async function renderSettingsPage(root, page, who) {
  const t = OWN.includes(page) && who.manager ? await get('/tenant/profile') : null;
  if (page === 'sell') sellCards(root, t);
  if (page === 'shop') await shopCards(root, t);
  if (page === 'school') schoolCards(root, t);
  const secs = await sectionsFor(page, who);
  const ownBar = root.querySelector('.set-savebar');
  for (const [file, key, sec] of secs) {
    const panel = h('div', { class: 'set-section-body' }, loading());
    const el = card(sec.title || key, [panel], { id: `${file}-${key}` });
    el.classList.add('set-app-card');
    if (ownBar) ownBar.before(el); else root.append(el);
    try { panel.replaceChildren(); await sec.render(panel); } catch (err) { panel.replaceChildren(errorBox(err)); }
  }
  if (!root.querySelector('.set-card')) root.append(nothingHere('Nothing to set up here yet.'));
}

/** Where guests' card payments are not connected yet: say what to do, in the app. */
function stripeNote(t, what) {
  if (t.stripe_ready) return null;
  return h('div', { class: 'callout set-callout' }, `Card payment is not connected yet, so ${what}. `,
    ctx.me.role === 'owner' ? ['Connect your Stripe account under ', h('a', { href: '#/settings/payments' }, 'Payments and card readers'), '.']
      : ['The owner connects it under ', h('a', { href: '#/settings/payments' }, 'Payments and card readers'), '.']);
}

// ---------------------------------------------------------------- Sell and gate
function sellCards(root, t) {
  const f = formTracker(async (changed) => {
    const body = {};
    if (changed(comp)) { const c = toCents(comp.value); if (c === null) throw new Error('Enter the limit in dollars, for example 0 or 50.00'); body.comp_counter_limit_cents = c; }
    if (changed(quick)) body.quick_sale = quick.checked;
    if (changed(passback)) body.scan_passback_seconds = Number(passback.value || 0);
    await put('/tenant/profile', body);
  });
  const quick = f.track(toggle({ name: 'quick_sale', checked: t.quick_sale !== false }));
  const comp = f.track(input({ name: 'comp', inputmode: 'decimal', value: centsToInput(t.comp_counter_limit_cents) }));
  const passback = f.track(input({ name: 'passback', type: 'number', min: 0, max: 3600, value: t.scan_passback_seconds ?? 0 }));
  root.append(
    card('At the ticket window', [
      row('Quick sale', quick, 'Day tickets, punch cards and vouchers can be sold without a name. Season passes, lessons and rentals always need one.'),
      row('Counter staff may give away up to', amount(comp, 'dollars a sale'), '0 means only managers can sell free of charge.'),
    ], { id: 'counter' }),
    card('At the gate', [
      row('Warn when a ticket is scanned again within', amount(passback, 'seconds'), 'Catches a ticket passed back across the fence. 0 turns the warning off.'),
    ], { id: 'gate' }),
    f.bar);
}

// ---------------------------------------------------------------- Online shop
async function shopCards(root, t) {
  const f = formTracker(async (changed) => {
    const body = {};
    if (changed(shopOn)) body.online_shop = shopOn.checked;
    if (changed(msg)) body.shop_message = msg.value.trim() || null;
    if (changed(recov)) body.shop_recovery = recov.checked;
    if (changed(chgOn) || changed(chgHours)) body.shop_change_hours = chgOn.checked ? Number(chgHours.value || 0) : null;
    if (changed(chgFee)) { const c = toCents(chgFee.value || '0'); if (c === null) throw new Error('Enter the fee in dollars, for example 0 or 5.00'); body.shop_change_fee_cents = c; }
    if (changed(limit)) body.online_daily_limit = limit.value ? Number(limit.value) : null;
    await put('/tenant/profile', body);
  });
  const shopOn = f.track(toggle({ name: 'online_shop', checked: Boolean(t.online_shop) }));
  const msg = f.track(input({ name: 'shop_message', maxlength: 500, value: t.shop_message || '', placeholder: 'For example: Show the barcode on your phone at the gate. No printing needed.' }));
  const recov = f.track(toggle({ name: 'shop_recovery', checked: Boolean(t.shop_recovery) }));
  const chgOn = f.track(toggle({ name: 'shop_change', checked: t.shop_change_hours !== null && t.shop_change_hours !== undefined }));
  const chgHours = f.track(input({ name: 'shop_change_hours', type: 'number', min: 0, max: 720, value: t.shop_change_hours ?? 24 }));
  const chgFee = f.track(input({ name: 'shop_change_fee', inputmode: 'decimal', value: centsToInput(t.shop_change_fee_cents || 0) }));
  const limit = f.track(input({ name: 'online_daily_limit', type: 'number', min: 1, max: 1000000, value: t.online_daily_limit || '', placeholder: 'None' }));
  const sync = () => { chgHours.disabled = chgFee.disabled = !chgOn.checked; };
  chgOn.addEventListener('change', sync); sync();
  root.append(
    card('Selling online', [
      stripeNote(t, 'the shop page shows "not open"'),
      row('Guests can buy tickets and passes online', shopOn, ['Guests pay by card, then get their tickets by email and on a page with a barcode the gate can scan. Choose what is sold online with "Sell on the online shop" on each product in ', h('a', { href: '#/catalog' }, 'Products and prices'), '.']),
      row('Message at the top of the shop page', msg, null, { wide: true }),
      linkRow('Your shop page', `${location.origin}/shop/${t.slug}`),
      row('Remind guests who did not finish', recov, 'One email to a guest who started an order but did not pay.'),
    ], { id: 'online-shop' }),
    card('Date changes', [
      row('Guests can move a single-day ticket to another day', chgOn, 'From their ticket page.'),
      row('Up to', amount(chgHours, 'hours before the day')),
      row('Fee for a change', amount(chgFee, 'dollars'), '0 for free. The guest also pays any rise in the ticket price; a lower price is not refunded.'),
    ], { id: 'date-changes' }),
    card('Tickets for one day', [
      row('Most tickets for one day, all products together', amount(limit, 'tickets'), 'Counts every day ticket and multi-day ticket valid that day, window sales too. A day that reaches it shows Sold out online. Blank for no limit. You can also set a limit on each product.'),
    ], { id: 'daily-limit' }),
    f.bar);
  try {
    const brand = await brandPanel();
    const look = card('How the shop page looks', [h('div', { class: 'set-section-body' }, brand)], { id: 'shop-look' });
    brand.querySelectorAll('h2').forEach((x) => x.remove()); // the card has the title
    f.bar.before(look);
  } catch (err) { f.bar.before(card('How the shop page looks', [errorBox(err)])); }
}

// ---------------------------------------------------------------- Ski school
function schoolCards(root, t) {
  const f = formTracker(async (changed) => {
    const body = {};
    const n = (el) => Number(el.value || 0);
    if (changed(booking)) body.online_booking = booking.checked;
    if (changed(payOn)) body.online_payment = payOn.checked;
    if (changed(notice)) body.booking_notice_hours = n(notice);
    if (changed(bookMsg)) body.booking_message = bookMsg.value.trim() || null;
    if (changed(fullHrs) || changed(halfHrs)) { body.refund_full_hours = n(fullHrs); body.refund_half_hours = n(halfHrs); }
    if (changed(halfPct)) body.refund_half_percent = n(halfPct);
    if (changed(cancelHrs)) body.cancel_hours = n(cancelHrs);
    if (changed(cancelNote)) body.cancel_note = cancelNote.value.trim() || null;
    if (body.refund_half_hours !== undefined && body.refund_half_hours > body.refund_full_hours) throw new Error('The partial refund must be fewer hours before the lesson than the full refund');
    await put('/tenant/profile', body);
  });
  const booking = f.track(toggle({ name: 'online_booking', checked: Boolean(t.online_booking) }));
  const payOn = f.track(toggle({ name: 'online_payment', checked: Boolean(t.online_payment), disabled: !t.stripe_ready }));
  const notice = f.track(input({ name: 'booking_notice_hours', type: 'number', min: 0, max: 240, value: t.booking_notice_hours ?? 12 }));
  const bookMsg = f.track(input({ name: 'booking_message', maxlength: 500, value: t.booking_message || '', placeholder: 'For example: Lessons are at the Ski School desk in the base lodge.' }));
  const fullHrs = f.track(input({ name: 'refund_full_hours', type: 'number', min: 0, max: 720, value: t.refund_full_hours ?? 48 }));
  const halfHrs = f.track(input({ name: 'refund_half_hours', type: 'number', min: 0, max: 720, value: t.refund_half_hours ?? 24 }));
  const halfPct = f.track(input({ name: 'refund_half_percent', type: 'number', min: 0, max: 100, value: t.refund_half_percent ?? 50 }));
  const cancelHrs = f.track(input({ name: 'cancel_hours', type: 'number', min: 0, max: 240, value: t.cancel_hours ?? 24 }));
  const cancelNote = f.track(input({ name: 'cancel_note', maxlength: 500, value: t.cancel_note || '', placeholder: 'Optional, for example: Groups of 6 or more, call us to change.' }));
  const preview = h('p', { class: 'set-preview' });
  const showPreview = () => {
    const full = Number(fullHrs.value || 0); const half = Number(halfHrs.value || 0); const pct = Number(halfPct.value || 0);
    const part = pct > 0 && half < full ? `, or at least ${half} hours ahead for ${pct === 50 ? 'half' : `${pct}%`}` : '';
    preview.replaceChildren(h('strong', null, 'Guests see: '), `Cancel at least ${full} hours ahead for a full refund${part}. You can cancel online until ${Number(cancelHrs.value || 0)} hours before your lesson.${cancelNote.value.trim() ? ` ${cancelNote.value.trim()}` : ''}`);
  };
  for (const el of [fullHrs, halfHrs, halfPct, cancelHrs, cancelNote]) el.addEventListener('input', showPreview);
  root.append(
    card('Online lesson booking', [
      row('Guests can ask for a lesson online', booking, 'Your public booking page takes requests. Without card payment, staff confirm each one under Ski school, Online requests, and the guest pays at the desk.'),
      stripeNote(t, 'guests cannot pay when they book'),
      row('Guests pay by card when they book', payOn, ['The lesson is booked once the card goes through. Money goes to your own Stripe account. ', h('a', { href: '#/settings/payments' }, 'Payments and card readers')]),
      row('Requests close before a lesson', amount(notice, 'hours'), 'How close to the start a guest can still ask.'),
      row('Message at the top of the booking page', bookMsg, null, { wide: true }),
      linkRow('Your booking page', `${location.origin}/book/${t.slug}`),
    ], { id: 'online-booking' }),
    card('Cancellations and refunds', [
      h('div', { class: 'set-grid' },
        row('Full refund if canceled at least', amount(fullHrs, 'hours before')),
        row('Partial refund if canceled at least', amount(halfHrs, 'hours before'), 'Fewer hours than the full refund. Later than this: no refund.'),
        row('Partial refund', amount(halfPct, 'percent')),
        row('Guests can cancel online until', amount(cancelHrs, 'hours before'))),
      row('Extra line for the policy', cancelNote, null, { wide: true }),
      preview,
    ], { id: 'refunds' }),
    f.bar);
  showPreview();
}
