// Printing: the receipt, a ticket slip for each guest (barcode and QR code), and a plain-text receipt for email.
// Pages are built on screen in a dialog and printed with the browser's own print command; the print style sheet hides
// everything but the sheet, so any printer works, including a receipt printer.

import { typeName } from './guesttypes.js';
import { get } from './api.js';
import { h, clear, money, label, fmtDate, fmtDateTime, fmtTime, button, dialog, toast, loading, errorBox } from './ui.js';
import { code128, qr } from './barcode.js';

const range = (a, b) => (a === b ? fmtDate(a) : `${fmtDate(a)} to ${fmtDate(b)}`);
const nameOf = (p) => [p.first_name, p.last_name].filter(Boolean).join(' ');
const cardText = (p) => (p.card_last4 ? `${p.card_brand ? `${label(p.card_brand)} ` : 'Card '}ending ${p.card_last4}` : '');

/** One line of the receipt: what it was, who for, and what it cost after its share of any discount and its tax. */
function lineText(l) {
  const bits = [l.name];
  if (l.line_kind === 'ticket' || l.line_kind === 'rental') bits.push(typeName(l.tier));
  return bits.join(', ');
}

/** A lesson on the receipt: who, which lesson, when, and where to meet (with the instructor's first name when known). */
const lessonWords = (l) => [`${nameOf(l) || 'Student'}: ${l.product}`, `${fmtDate(l.starts_at)}, ${fmtTime(l.starts_at)} to ${fmtTime(l.ends_at)}`,
  l.meeting_place ? `Meet at ${l.meeting_place}` : null, l.instructor_first ? `Instructor ${l.instructor_first}` : null].filter(Boolean).join('. ');

/** The receipt as a sheet. data is GET /orders/:id/receipt. */
export function receiptSheet(data) {
  const { mountain: m, order: o } = data;
  const row = (a, b, cls) => h('div', { class: ['rc-row', cls].filter(Boolean).join(' ') }, h('span', null, a), h('span', null, b));
  const lines = data.lines.map((l) => h('div', { class: 'rc-line' },
    row(`${l.quantity > 1 ? `${l.quantity} x ` : ''}${lineText(l)}`, money(l.unit_price_cents * l.quantity)),
    nameOf(l) ? h('div', { class: 'rc-sub' }, `for ${nameOf(l)}`) : null,
    l.discount_cents ? h('div', { class: 'rc-sub rc-row' }, h('span', null, 'Discount'), h('span', null, `-${money(l.discount_cents)}`)) : null,
    l.refunded_at ? h('div', { class: 'rc-sub' }, 'Refunded') : null));
  return h('article', { class: 'sheet receipt-sheet', 'data-sheet': 'receipt' },
    h('header', { class: 'rc-head' }, h('strong', null, m.name), m.address ? h('div', null, m.address) : null, m.phone ? h('div', null, m.phone) : null),
    h('div', { class: 'rc-meta' }, `Order #${o.id}`, h('br'), o.at ? fmtDateTime(o.at) : '', o.cashier ? ` · ${o.cashier}` : ''),
    data.customer ? h('div', { class: 'rc-meta' }, nameOf(data.customer)) : null,
    h('div', { class: 'rc-lines' }, lines),
    h('div', { class: 'rc-totals' },
      o.discount_cents ? row('Subtotal', money(o.subtotal_cents)) : null,
      o.discount_cents ? row(`Discount${o.promo_code ? ` (${o.promo_code})` : ''}`, `-${money(o.discount_cents)}`) : null,
      ...data.taxes.map((t) => row(`${t.name} ${(t.rate_bps / 100).toFixed(t.rate_bps % 100 ? 2 : 0)}%`, money(t.amount_cents))),
      row('Total', money(o.total_cents), 'rc-total'),
      ...data.payments.map((p) => row(`${label(p.tender)}${cardText(p) ? ` ${cardText(p)}` : ''}${p.comp_reason ? ` (${label(p.comp_reason)})` : ''}`, money(p.amount_cents))),
      o.change_due_cents ? row('Change', money(o.change_due_cents)) : null,
      o.refunded_cents ? row('Refunded', `-${money(o.refunded_cents)}`) : null),
    (data.lessons || []).length ? h('div', { class: 'rc-lessons', 'data-receipt-lessons': '' }, h('strong', null, 'Lessons'), data.lessons.map((l) => h('div', { class: 'rc-sub' }, lessonWords(l))),
      h('div', { class: 'rc-sub' }, 'Please be at the meeting place 15 minutes early.')) : null,
    data.gift_cards.length ? h('div', { class: 'rc-sub' }, data.gift_cards.map((g) => h('div', null, `Gift card ${g.code}: ${money(g.initial_cents)}`))) : null,
    data.tickets.length ? h('div', { class: 'rc-sub' }, `${data.tickets.length} ticket${data.tickets.length === 1 ? '' : 's'} printed separately.`) : null,
    data.lines.some((l) => l.line_kind === 'rental') ? h('div', { class: 'rc-code' }, h('div', { class: 'rc-sub' }, 'Show this at the rental counter'), code128(`ORD-${o.id}`, { height: 44, module: 1.6 }), h('div', null, `ORD-${o.id}`)) : null,
    data.rental_form_url ? h('div', { class: 'rc-code' }, h('div', { class: 'rc-sub' }, 'Fill in your rental form: scan this with your phone camera'), qr(data.rental_form_url, { size: 96 })) : null,
    m.footer ? h('footer', { class: 'rc-foot' }, m.footer) : null);
}

/** '14:00' -> '2:00 PM' (an activity's time slot). */
const clock12 = (t) => { const [hh, mm] = String(t || '').split(':').map(Number); return Number.isFinite(hh) ? `${hh % 12 || 12}:${String(mm || 0).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}` : ''; };
/** One slip per ticket: who, what, when, and the code as a barcode and a QR code. */
export function ticketSlips(data, { wristband = false } = {}) {
  const m = data.mountain;
  return data.tickets.filter((t) => t.status !== 'void').map((t) => h('article', { class: wristband ? 'sheet slip wristband' : 'sheet slip', 'data-sheet': 'ticket', 'data-code': t.code },
    h('header', null, h('strong', null, m.name), h('span', null, t.product)),
    h('div', { class: 'slip-who' }, nameOf(t) || 'Guest', h('small', null, [typeName(t.tier), t.kind === 'season_pass' ? 'Season pass' : null].filter(Boolean).join(', '))),
    t.kind === 'activity' ? h('div', { class: 'slip-when' }, range(t.valid_from, t.valid_to), t.start_time ? ` · ${clock12(t.start_time)} to ${clock12(t.end_time)}` : ' · All day', t.attraction ? ` · ${t.attraction}` : '')
      : h('div', { class: 'slip-when' }, range(t.valid_from, t.valid_to), t.uses_remaining !== null && t.uses_remaining !== undefined ? ` · ${t.uses_remaining} ride${t.uses_remaining === 1 ? '' : 's'}` : ''),
    h('div', { class: 'slip-codes' }, code128(t.code, { height: wristband ? 36 : 54, module: wristband ? 1 : 2 }), wristband ? null : qr(t.code, { size: 96 })),
    h('div', { class: 'slip-code' }, t.code)));
}

/** The receipt as plain text, for an email: the codes are in it so the guest can show them on a phone. */
export function receiptText(data) {
  const { mountain: m, order: o } = data;
  const out = [m.name, m.address, m.phone, '', `Order #${o.id}${o.at ? `  ${fmtDateTime(o.at)}` : ''}`, ''].filter((x) => x !== null && x !== undefined);
  for (const l of data.lines) out.push(`${l.quantity > 1 ? `${l.quantity} x ` : ''}${lineText(l)}${nameOf(l) ? ` (for ${nameOf(l)})` : ''}  ${money(l.unit_price_cents * l.quantity - (l.discount_cents || 0))}`);
  out.push('');
  for (const t of data.taxes) out.push(`${t.name}: ${money(t.amount_cents)}`);
  out.push(`Total: ${money(o.total_cents)}`);
  for (const p of data.payments) out.push(`Paid by ${label(p.tender)}${cardText(p) ? ` (${cardText(p)})` : ''}: ${money(p.amount_cents)}`);
  if (data.tickets.length) {
    out.push('', 'Your tickets:');
    for (const t of data.tickets) out.push(`${t.product} for ${nameOf(t) || 'guest'}, ${range(t.valid_from, t.valid_to)}${t.start_time ? `, ${clock12(t.start_time)}` : ''}: ${t.code}`);
  }
  if ((data.lessons || []).length) { out.push('', 'Lessons:'); for (const l of data.lessons) out.push(lessonWords(l)); }
  if (data.lines.some((l) => l.line_kind === 'rental')) out.push('', `Rental pickup code: ORD-${o.id}`);
  if (data.rental_form_url) out.push('', 'Fill in your rental form (sizes and signature for each renter):', data.rental_form_url);
  for (const g of data.gift_cards) out.push('', `Gift card ${g.code} (${money(g.initial_cents)})`);
  if (m.footer) out.push('', m.footer);
  return out.join('\n');
}

export const mailtoFor = (data, to) => `mailto:${encodeURIComponent(to || '')}?subject=${encodeURIComponent(`Your receipt from ${data.mountain.name}`)}&body=${encodeURIComponent(receiptText(data))}`;

/** A dialog that shows what will print, with a Print button. */
export function printDialog(title, sheets, extra = []) {
  const area = h('div', { class: 'print-area' }, sheets);
  const dlg = dialog(title, h('div', { class: 'stack' }, h('p', { class: 'muted small no-print' }, 'Check the preview, then print. Use "Save as PDF" in the print window to keep a copy.'), area,
    h('div', { class: 'footer row no-print' }, ...extra, button('Print', () => window.print(), { kind: 'primary' }))), { wide: true });
  dlg.overlay = dlg.box.parentNode;
  dlg.overlay.classList.add('print-overlay');
  return dlg;
}

/** Fetches an order's receipt and opens it for printing. what: 'receipt' | 'tickets' | 'wristbands'. */
export async function printOrder(orderId, what = 'receipt') {
  const body = h('div');
  const dlg = dialog(what === 'receipt' ? 'Receipt' : 'Tickets', loading('Getting it ready'));
  try {
    const data = await get(`/orders/${orderId}/receipt`);
    dlg.close();
    if (what === 'receipt') {
      const to = data.customer && data.customer.email;
      printDialog(`Receipt for order #${orderId}`, receiptSheet(data), to ? [h('a', { class: 'btn', href: mailtoFor(data, to) }, `Email to ${to}`)] : [h('a', { class: 'btn', href: mailtoFor(data, '') }, 'Email this receipt')]);
    } else {
      const slips = ticketSlips(data, { wristband: what === 'wristbands' });
      if (!slips.length) { toast('This order has no valid tickets to print', 'error'); return; }
      printDialog(`Tickets for order #${orderId}`, slips);
    }
  } catch (err) {
    clear(dlg.body).append(errorBox(err), body);
  }
}

/** Print buttons for an order: used on the sale receipt and in the order details. */
export function printButtons(orderId, { hasTickets = true } = {}) {
  return h('span', { class: 'row' },
    button('Print receipt', () => printOrder(orderId, 'receipt'), { small: true }),
    hasTickets ? button('Print tickets', () => printOrder(orderId, 'tickets'), { small: true }) : null,
    hasTickets ? button('Wristband slips', () => printOrder(orderId, 'wristbands'), { small: true }) : null);
}
