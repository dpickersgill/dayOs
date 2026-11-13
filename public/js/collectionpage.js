// A municipality's collection calendar (/collection/<municipality>, release 2026.11.22), linked from its website. Phone
// first: street and house number -> the zone and the next day of each stream, notices about changes at the top, the
// year to print, a feed for the phone's calendar, a reminder the night before (the street alert sign-up: a code by text
// or a link by email), what goes in each stream, and links to book a bulk pickup or report a missed pickup.
// The answers say only the zone and dates: nothing about who lives at an address. The address is kept on this device
// only, so the page opens on it next time.
import { h, clear, appendAll } from './ui.js';

const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const root = document.getElementById('coll');
const base = `/api/v1/public/${encodeURIComponent(slug)}`;
const api = `${base}/collection`;
const KEY = `so.collection.${slug}`;

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Something went wrong. Please try again, or call the office.'); e.status = res.status; e.code = data.details && data.details.code; throw e; }
  return data;
}
const post = (url, body) => getJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const lab = (id, text, el, hint) => h('div', { class: 'field' }, h('label', { for: id }, text), el, hint ? h('span', { class: 'hint' }, hint) : null);
const errorLine = (text) => h('p', { class: 'error-box', role: 'alert' }, text);
const keep = (v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem(KEY) || 'null'); localStorage.setItem(KEY, JSON.stringify(v)); } catch (_) { /* private mode: nothing kept */ } return null; };
const day = (d, opts = { weekday: 'long', month: 'long', day: 'numeric' }) => new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
const mmdd = (s) => (s ? new Date(`2026-${s}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }) : '');
const lines = (t) => String(t || '').split('\n').map((x) => x.trim()).filter(Boolean);
const MOVED = { holiday: 'moved for the holiday', snow: 'moved for snow', weather: 'moved for the weather', other: 'moved' };

let page = null;
const out = h('div', { 'aria-live': 'polite' });

async function main() {
  document.getElementById('coll-loading')?.remove();
  try { page = await getJson(api); } catch (_) {
    root.append(h('h1', null, 'The collection calendar is not available'), h('p', { class: 'muted' }, 'Please call your municipal office for your trash and recycling days.'));
    return;
  }
  document.title = `${page.municipality}: trash and recycling days`;
  if (!page.ready) {
    root.append(...[h('p', { class: 'muted' }, page.municipality), h('h1', null, 'Trash and recycling days'), h('p', null, 'The calendar is not published yet.'), page.phone ? h('p', null, 'Call ', h('a', { href: `tel:${page.phone.replace(/[^0-9+]/g, '')}` }, page.phone), ' for your days.') : null].filter(Boolean));
    return;
  }
  const street = h('select', { id: 'c-street', required: '' }, h('option', { value: '' }, 'Choose your street'), page.streets.map((s) => h('option', { value: s.id }, s.name)));
  const house = h('input', { id: 'c-house', inputmode: 'numeric', autocomplete: 'off', maxlength: 20, placeholder: 'For example 120' });
  const msg = h('div');
  const form = h('form', { class: 'stack', novalidate: '' }, lab('c-street', 'Street', street), lab('c-house', 'House number', house), msg,
    h('button', { type: 'submit', class: 'btn primary' }, 'Show my days'));
  form.addEventListener('submit', (e) => { e.preventDefault(); clear(msg); if (!street.value) { msg.append(errorLine('Choose your street.')); street.focus(); return; } look(Number(street.value), house.value.trim()); });
  const kept = keep();
  if (kept && page.streets.some((s) => s.id === kept.street)) { street.value = String(kept.street); house.value = kept.no || ''; }
  root.append(...[
    h('p', { class: 'muted' }, page.municipality), h('h1', null, 'Trash and recycling days'),
    notices(page.notices),
    h('section', { class: 'bulk-step', 'aria-labelledby': 'c-find' }, h('h2', { id: 'c-find', style: 'margin-top:0' }, 'Find your days'), form),
    out, whatGoesIn(), upcoming(),
    page.hauler ? h('p', null, `Your trash is collected by ${page.hauler.name || 'our hauler'}.`, page.hauler.phone ? [' Missed pickup? Call ', h('a', { href: `tel:${page.hauler.phone.replace(/[^0-9+]/g, '')}` }, page.hauler.phone), '.'] : null) : null,
    page.phone ? h('p', { class: 'muted small' }, 'Questions? Call ', h('a', { href: `tel:${page.phone.replace(/[^0-9+]/g, '')}` }, page.phone), '.') : null].flat().filter(Boolean));
  if (kept && street.value) look(Number(street.value), house.value.trim(), { quiet: true });
}

function notices(list) {
  return (list || []).map((n) => h('section', { class: 'coll-notice', role: 'note' }, h('h2', null, n.title), h('p', null, lines(n.text)[0] || n.text)));
}

async function look(streetId, no, { quiet = false } = {}) {
  clear(out).append(h('p', { class: 'loading', role: 'status' }, 'Looking up your days…'));
  let r;
  try { r = await getJson(`${api}/lookup?street=${streetId}&no=${encodeURIComponent(no)}`); } catch (err) { clear(out).append(errorLine(err.message)); return; }
  if (!r.found || r.not_collected) { clear(out).append(h('p', { class: 'callout' }, r.message)); return; }
  keep({ street: streetId, no });
  const streams = new Map(page.streams.map((s) => [s.id, s]));
  appendAll(clear(out),
    notices((r.notices || []).filter((n) => !page.notices.some((m) => m.title === n.title))),
    h('h2', { tabindex: '-1', id: 'c-yours' }, `Your days: ${r.zone.name}`),
    h('ul', { class: 'plain coll-next' }, r.next.map((x) => h('li', { style: `--chip:${x.color}` },
      h('span', null, x.stream), h('b', null, `${day(x.date)}${x.moved ? ` (${MOVED[x.reason] || 'moved'})` : ''}`),
      h('span', { class: 'muted small' }, `Collected ${x.how_often}${x.season ? `, ${mmdd(x.season.from)} to ${mmdd(x.season.to)}` : ''}.`)))),
    page.curb_by ? h('p', null, page.curb_by, '.') : null,
    (r.events || []).length ? h('div', null, h('h2', null, 'Coming up'), h('ul', null, r.events.map((e) => h('li', null, h('b', null, e.name), `: ${e.starts_on === e.ends_on ? day(e.starts_on) : `${day(e.starts_on, { month: 'long', day: 'numeric' })} to ${day(e.ends_on, { month: 'long', day: 'numeric' })}`}`, e.notes ? h('div', { class: 'muted small' }, e.notes) : null)))) : null,
    h('div', { class: 'coll-links' },
      h('button', { type: 'button', class: 'btn', onclick: () => year(r.zone, streams) }, 'Print this year’s calendar'),
      h('a', { class: 'btn', href: r.ics.replace(/^https?:/, 'webcal:') }, 'Add to my phone’s calendar'),
      page.reminders ? h('button', { type: 'button', class: 'btn', onclick: (e) => remind(e.currentTarget, streetId, no, r) }, 'Get a reminder the night before') : null,
      h('a', { class: 'btn', href: page.links.bulk_pickup }, 'Book a bulk pickup'),
      page.links.report ? h('a', { class: 'btn', href: page.links.report }, 'Report a missed pickup') : null),
    h('p', { class: 'muted small' }, 'Calendar app not opening? Copy this link into it: ', h('a', { href: r.ics }, 'calendar feed')));
  if (!quiet) document.getElementById('c-yours')?.focus();
}

/** The year, month by month, for this zone; then the browser's print. */
async function year(zone, streams) {
  const y = Number(page.today.slice(0, 4));
  let d;
  try { d = await getJson(`${api}/year?zone=${zone.id}&year=${y}`); } catch (err) { out.append(errorLine(err.message)); return; }
  const color = (id) => (streams.get(id) || {}).color || '#5b6770';
  const months = Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);
  const sheet = h('section', { class: 'coll-print', 'aria-labelledby': 'c-year' },
    h('h2', { id: 'c-year' }, `${page.municipality}: ${zone.name}, ${y}`),
    h('p', { class: 'small' }, d.streams.map((s) => `${s.name}: ${s.how_often}${s.season ? ` (${mmdd(s.season.from)} to ${mmdd(s.season.to)})` : ''}`).join('. '), '.'),
    h('div', { class: 'coll-year' }, months.map((m) => h('section', null, h('h3', null, day(`${m}-15`, { month: 'long' })),
      h('ul', null, d.days.filter((x) => x.date.startsWith(m)).map((x) => h('li', { style: `--chip:${color(x.stream_id)}` }, `${Number(x.date.slice(8, 10))} ${x.stream}${x.moved ? ' *' : ''}`)))))),
    h('p', { class: 'small' }, '* moved. ', d.holiday_rule, '.', d.events.length ? ` ${d.events.map((e) => `${e.name}: ${day(e.starts_on, { month: 'short', day: 'numeric' })}${e.ends_on !== e.starts_on ? ` to ${day(e.ends_on, { month: 'short', day: 'numeric' })}` : ''}`).join('; ')}.` : ''));
  document.querySelector('.coll-print')?.remove();
  out.append(sheet);
  sheet.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => window.print(), 300);
}

/** A reminder the night before: the streams wanted, a phone and/or an email, then the code or the email link. */
function remind(button, streetId, no, r) {
  button.disabled = true;
  const picks = r.next.map((x) => ({ x, el: h('input', { type: 'checkbox', checked: true, id: `c-s${x.stream_id}` }) }));
  const phone = h('input', { id: 'c-phone', type: 'tel', autocomplete: 'tel', maxlength: 40, placeholder: 'Cell phone for texts' });
  const email = h('input', { id: 'c-email', type: 'email', autocomplete: 'email', maxlength: 255, placeholder: 'Or your email' });
  const msg = h('div');
  const form = h('form', { class: 'bulk-step stack', novalidate: '' },
    h('h2', { tabindex: '-1', id: 'c-rem', style: 'margin-top:0' }, 'A reminder the night before'),
    h('fieldset', { class: 'stack tight' }, h('legend', null, 'Remind me about'), picks.map((p) => h('label', { class: 'check', for: p.el.id }, p.el, p.x.stream))),
    page.reminders.texts ? lab('c-phone', 'Text me at', phone, 'Message and data rates may apply. Reply STOP to stop.') : null,
    page.reminders.emails ? lab('c-email', 'Email me at', email) : null,
    h('p', { class: 'muted small' }, 'We use these only for your reminders and street alerts. They are never shown on any page.'),
    msg, h('button', { type: 'submit', class: 'btn primary' }, 'Sign up'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); clear(msg);
    const streams = picks.filter((p) => p.el.checked).map((p) => p.x.stream_id);
    if (!streams.length) { msg.append(errorLine('Tick at least one.')); return; }
    if (!phone.value.trim() && !email.value.trim()) { msg.append(errorLine('Give a cell phone number, an email, or both.')); return; }
    try {
      if (!no) { msg.append(errorLine('Type your house number above and look up your days again, so the reminder is for your address.')); return null; }
      const s = await post(`${base}/alerts`, { street_id: streetId, house_number: no, phone: phone.value.trim() || null, email: email.value.trim() || null, topics: ['trash'], streams });
      if (s.needs_code) return code(form, s);
      form.replaceWith(h('div', { class: 'coll-done', role: 'status' }, h('b', null, 'Check your email.'), ' Press the link in it to start your reminders.'));
    } catch (err) { msg.append(errorLine(err.message)); }
    return null;
  });
  button.after(form);
  document.getElementById('c-rem')?.focus();
}
function code(form, s) {
  const box = h('input', { id: 'c-code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6 });
  const msg = h('div');
  const f = h('form', { class: 'bulk-step stack', novalidate: '' }, h('h2', { tabindex: '-1', id: 'c-code-h', style: 'margin-top:0' }, 'Enter the code'),
    h('p', null, `We texted a 6-digit code to the phone ${s.phone_hint}. It works for ${s.minutes} minutes.`), lab('c-code', 'Code', box),
    s.email_sent ? h('p', { class: 'muted small' }, 'We also emailed a link to confirm your email.') : null, msg, h('button', { type: 'submit', class: 'btn primary' }, 'Confirm'));
  f.addEventListener('submit', async (e) => {
    e.preventDefault(); clear(msg);
    try {
      await post(`${base}/alerts/confirm`, { ref: s.ref, code: box.value.trim() });
      f.replaceWith(h('div', { class: 'coll-done', role: 'status' }, h('b', null, 'You are signed up.'), ' Reminders come the evening before. Reply STOP to any text to stop them.'));
    } catch (err) { msg.append(errorLine(err.message)); }
  });
  form.replaceWith(f);
  document.getElementById('c-code-h')?.focus();
}

function whatGoesIn() {
  const list = page.streams.filter((s) => s.materials || s.not_accepted);
  if (!list.length && !page.ordinance_materials) return null;
  return h('section', { class: 'coll-what', 'aria-labelledby': 'c-what' }, h('h2', { id: 'c-what' }, 'What goes in each'),
    list.map((s) => disclosure(s)),
    page.ordinance_materials ? h('p', { class: 'small' }, h('b', null, 'Our recycling ordinance asks you to separate: '), lines(page.ordinance_materials).join(', '), '.') : null);
}

/** One stream's list behind a button that says it opens (a chevron, aria-expanded), not a bare fold. */
function disclosure(s) {
  const id = `c-what-${s.id}`;
  const panel = h('div', { id, class: 'coll-disc-panel', hidden: true },
    s.materials ? [h('p', null, h('b', null, 'Yes')), h('ul', null, lines(s.materials).map((l) => h('li', null, l)))] : null,
    s.not_accepted ? [h('p', null, h('b', null, 'No')), h('ul', null, lines(s.not_accepted).map((l) => h('li', null, l)))] : null);
  const btn = h('button', { type: 'button', class: 'coll-disc', 'aria-expanded': 'false', 'aria-controls': id },
    h('span', { class: 'cl-chip', style: `--chip:${s.color}` }, s.name), h('span', { class: 'coll-disc-words' }, 'What goes in'), h('span', { class: 'coll-chev', 'aria-hidden': 'true' }));
  btn.addEventListener('click', () => { const open = btn.getAttribute('aria-expanded') !== 'true'; btn.setAttribute('aria-expanded', String(open)); panel.hidden = !open; });
  return h('div', { class: 'coll-disc-row' }, btn, panel);
}

function upcoming() {
  if (!page.holidays.length) return null;
  return h('section', { 'aria-labelledby': 'c-hol' }, h('h2', { id: 'c-hol' }, 'Holidays'), h('p', { class: 'small' }, page.holiday_rule, '.'),
    h('ul', null, page.holidays.slice(0, 6).map((x) => h('li', null, `${day(x.on_date)}: ${x.name}`))));
}

main();
