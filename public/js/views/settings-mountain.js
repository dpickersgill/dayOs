// Settings, The mountain: Mountain details (name, phone, address, time zone, receipt footer, the weekly report),
// Shared computers, and the Assistant.
import { get, put } from '../api.js';
import { h, clear, ctx, appendAll, input, select, button, money, dialog, table, state, empty, errorBox, fmtDateTime } from '../ui.js';
import { terminalsPanel } from './security.js';
import { card, row, toggle, formTracker } from './settings-kit.js';

export async function renderSettingsPage(root, key) {
  if (key === 'mountain') return mountainPage(root);
  if (key === 'shared') return sharedPage(root);
  if (key === 'assistant') return assistantPage(root);
  return undefined;
}

// The mountain's clock: every time on its records is shown on it. The common North American zones first.
const ZONES = [['America/New_York', 'Eastern'], ['America/Detroit', 'Eastern (Michigan)'], ['America/Chicago', 'Central'], ['America/Denver', 'Mountain'], ['America/Boise', 'Mountain (Idaho)'], ['America/Phoenix', 'Arizona (no daylight saving)'],
  ['America/Los_Angeles', 'Pacific'], ['America/Anchorage', 'Alaska'], ['Pacific/Honolulu', 'Hawaii'], ['America/Halifax', 'Atlantic'], ['America/Toronto', 'Eastern (Canada)'], ['America/Winnipeg', 'Central (Canada)'], ['America/Edmonton', 'Mountain (Canada)'], ['America/Vancouver', 'Pacific (Canada)']];

async function mountainPage(root) {
  const t = await get('/tenant/profile');
  const isOwner = ctx.me.role === 'owner';
  const f = formTracker(async (changed) => {
    const body = {};
    if (changed(name)) { if (name.value.trim().length < 2) throw new Error('The mountain needs a name'); body.name = name.value.trim(); }
    if (changed(phone)) body.phone = phone.value.trim() || null;
    if (changed(address)) body.address = address.value.trim() || null;
    if (changed(footer)) body.receipt_footer = footer.value.trim() || null;
    if (changed(weekly)) body.weekly_report = weekly.checked;
    if (isOwner && changed(zone)) body.timezone = zone.value;
    await put('/tenant/profile', body);
    if (body.timezone) { ctx.tz = body.timezone; ctx.me.timezone = body.timezone; }
    if (body.name) ctx.me.tenant_name = body.name;
  });
  const name = f.track(input({ name: 'name', value: t.name || '', maxlength: 255, required: true, autocomplete: 'organization' }));
  const phone = f.track(input({ name: 'phone', value: t.phone || '', maxlength: 40, type: 'tel', autocomplete: 'tel' }));
  const address = f.track(input({ name: 'address', value: t.address || '', maxlength: 255, placeholder: 'Street, town, state', autocomplete: 'street-address' }));
  const footer = f.track(h('textarea', { name: 'receipt_footer', rows: 3, maxlength: 500 }, t.receipt_footer || ''));
  const zone = f.track(select([...(ZONES.some((z) => z[0] === t.timezone) ? [] : [[t.timezone, t.timezone]]), ...ZONES.map(([z, l]) => [z, `${l} (${z})`])], t.timezone, { name: 'timezone', disabled: !isOwner }));
  const weekly = f.track(toggle({ name: 'weekly_report', checked: t.weekly_report !== false }));
  const clockNow = h('span', { class: 'set-hint' });
  const showClock = () => { try { clockNow.textContent = `It is ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone.value, timeZoneName: 'short' })} there now.`; } catch (_) { clockNow.textContent = ''; } };
  zone.addEventListener('change', showClock); showClock();
  root.append(
    card('The mountain', [
      row('Mountain name', name, 'Shown to guests on receipts, emails and your public pages.', { wide: true }),
      row('Phone', phone, 'Printed on receipts and ticket slips.'),
      row('Address', address, 'Printed at the top of receipts and ticket slips.', { wide: true }),
      row('Receipt footer', footer, 'For example: opening hours, a thank-you, or the refund policy.', { wide: true }),
    ], { id: 'details' }),
    card('Time zone', [
      row('The mountain’s clock', h('div', { class: 'stack tight' }, zone, clockNow), isOwner ? 'Every time on your records is on the mountain’s clock. Check it shows the right local time.' : 'Only the owner can change this.', { wide: true }),
    ], { id: 'timezone' }),
    card('Weekly report', [
      row('Email the weekly report every Monday', weekly, 'To owners and managers. It is also under Money, Weekly report.'),
    ], { id: 'weekly' }),
    f.bar);
  return undefined;
}

function sharedPage(root) {
  root.append(terminalsPanel(),
    h('p', { class: 'set-note' }, 'Each person sets their own PIN under ', h('a', { href: '#/settings/profile' }, 'Your profile and sign-in'), '. A manager can clear a forgotten PIN under ', h('a', { href: '#/settings/team' }, 'Team and logins'), '.'));
}

// ---- the assistant: on for staff, which guest pages show it (Assistant Plus), where guest questions go, this month's use
const PAGE_NAMES = { shop: 'Online ticket shop', programs: 'Program registration', booking: 'Lesson booking', family: 'Family page' };
async function assistantPage(root) {
  const a = await get('/assistant/settings');
  const f = formTracker(async () => {
    await put('/assistant/settings', { staff_on: staffOn.checked, guest_pages: pages.filter(([, b]) => b.checked).map(([p]) => p), contact_email: contact.value.trim() || null });
  });
  const staffOn = f.track(toggle({ name: 'staff_on', checked: a.staff_on }));
  const pages = a.pages.map((p) => [p, f.track(toggle({ name: `page_${p}`, checked: a.guest_pages.includes(p), disabled: !a.plus }))]);
  const contact = f.track(input({ type: 'email', name: 'contact_email', value: a.contact_email || '', placeholder: a.owner_email || 'you@yourmountain.com', disabled: !a.plus }));
  appendAll(root,
    a.available ? null : h('div', { class: 'callout' }, 'The assistant is not switched on for Verdynt/OS yet.'),
    card('For staff', [
      row('Staff can ask the assistant how to do things', staffOn, 'The Ask button in the menu.'),
      h('p', { class: 'set-card-intro' }, a.plus
        ? 'Assistant Plus is on: staff can also ask about today\'s numbers, lessons, programs and who is working. It only looks up what that person could already see, and never sees patient care records.'
        : ['Assistant Plus (an add-on under ', h('a', { href: '#/settings/billing' }, 'Billing and plan'), ') adds questions about today\'s numbers, lessons, programs and who is working, and the assistant for guests.']),
    ]),
    card('For guests', [
      ...pages.map(([p, box]) => row(PAGE_NAMES[p] || p, box, a.plus ? 'Guests can ask on this page.' : 'Needs Assistant Plus.')),
      row('Guest questions it cannot answer go to', contact, 'Guests give their email, and your reply goes straight to them. Blank: the owner\'s email.', { wide: true }),
    ]),
    card('This month', [
      h('p', { class: 'set-card-intro' }, `${a.month.questions} question${a.month.questions === 1 ? '' : 's'}, ${money(a.month.spent_cents)} of the ${money(a.month.cap_cents)} included. At the limit it rests until the 1st; Help keeps working.`),
      h('div', { class: 'set-card-intro' }, button('See questions asked', () => questionsDialog())),
    ]),
    f.bar);
}

async function questionsDialog() {
  const body = h('div', { class: 'stack' }, h('p', { class: 'loading' }, 'Loading…'));
  dialog('Questions asked in the last month', body, { wide: true });
  try {
    const { data } = await get('/assistant/questions');
    clear(body);
    if (!data.length) { body.append(empty('Nobody has asked anything yet.')); return; }
    body.append(h('p', { class: 'muted small' }, 'What staff and guests wanted to know. Ones it could not answer are worth a line in your own notes, or a word to support.'),
      table([{ head: 'When', cell: (r) => fmtDateTime(r.created_at) }, { head: 'Who', cell: (r) => (r.audience === 'guest' ? `Guest, ${PAGE_NAMES[r.page] || r.page}` : r.username || 'Staff') }, { head: 'Question', cell: (r) => r.question },
        { head: 'How it went', cell: (r) => [r.unanswered ? state('Not answered', 'hold') : null, r.rating === -1 ? state('Did not help', 'closed') : r.rating === 1 ? state('Helped', 'open') : null, r.escalated_at ? state('Passed on', 'neutral') : null] }], data));
  } catch (err) { clear(body); body.append(errorBox(err)); }
}
