import { get, post, put, patch, session } from '../api.js';
import { mfaPanel } from './mfa.js';
import { brandPanel } from './shopbrand.js';
import { h, clear, ctx, isManager, table, state, input, select, field, button, toast, formDialog, confirmDialog, val, num, label, empty, errorBox, toCents, centsToInput } from '../ui.js';

const ROLES = ['manager', 'staff', 'counter', 'instructor', 'patrol'];

export async function render(root) {
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Account')));
  root.append(passwordForm(), mfaPanel());
  if (isManager()) {
    root.append(await mountainForm());
    root.append(await brandPanel());
    const box = h('section', { class: 'section' });
    root.append(box);
    await drawLogins(box);
  }
}

function passwordForm() {
  const cur = input({ type: 'password', name: 'current', autocomplete: 'current-password', required: true });
  const next = input({ type: 'password', name: 'next', autocomplete: 'new-password', required: true, minlength: 10 });
  const again = input({ type: 'password', name: 'again', autocomplete: 'new-password', required: true });
  const slot = h('div');
  const go = h('button', { type: 'submit', class: 'btn primary' }, 'Change password');
  const form = h('form', { class: 'stack', novalidate: true }, h('div', { class: 'form' }, field('Current password', cur), field('New password', next, 'At least 10 characters'), field('Repeat new password', again)), slot, h('div', { class: 'row' }, go));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(slot);
    if (next.value !== again.value) { slot.append(errorBox(new Error('The new passwords do not match'))); return; }
    go.disabled = true;
    try {
      const out = await post('/auth/change-password', { current_password: cur.value, new_password: next.value });
      session.token = out.token; // this device stays signed in; every other session ends
      cur.value = next.value = again.value = '';
      toast('Password changed. Other devices were signed out');
    } catch (err) {
      slot.append(errorBox(err));
    } finally {
      go.disabled = false;
    }
  });
  return h('section', { class: 'panel stack' }, h('h2', null, 'Change your password'), h('p', { class: 'muted' }, `Signed in as ${ctx.me.email}.`), form);
}

// ---------------------------------------------------------------- manage logins
async function drawLogins(box) {
  const [{ data: users }, { data: staff }] = await Promise.all([get('/users'), get('/workforce/staff')]);
  const staffName = new Map(staff.map((s) => [s.id, `${s.first_name} ${s.last_name}`]));
  const reload = async () => { const n = h('div'); await drawLogins(n); clear(box).append(...n.childNodes); };
  const isOwner = ctx.me.role === 'owner';
  const canManage = (u) => u.role !== 'owner' && (isOwner || u.role !== 'manager');

  clear(box).append(
    h('header', null, h('div', null, h('h2', null, 'Logins'), h('p', null, 'Who can sign in to this mountain. Link a login to a staff member so they can see their shifts and clock in.')),
      button('Add login', () => addLogin(staff, isOwner, reload), { kind: 'primary', small: true })),
    users.length ? table([
      { head: 'Email', cell: (u) => h('strong', null, u.email) },
      { head: 'Role', cell: (u) => label(u.role) },
      { head: 'Staff record', cell: (u) => (u.staff_id ? staffName.get(u.staff_id) || `#${u.staff_id}` : h('span', { class: 'muted' }, 'Not linked')) },
      { head: 'Status', cell: (u) => state(u.active ? 'Active' : 'Deactivated', u.active ? 'good' : 'neutral') },
      { head: 'Two-step', cell: (u) => (u.mfa_enabled ? state('On', 'good') : h('span', { class: 'muted' }, 'Off')) },
      { head: '', actions: true, cell: (u) => (canManage(u) ? [
        button('Link staff', () => linkStaff(u, staff, reload), { small: true }),
        button('Role', () => changeRole(u, isOwner, reload), { small: true }),
        button('New password', () => resetPassword(u), { small: true }),
        u.mfa_enabled ? button('Reset two-step', () => resetMfa(u, reload), { small: true }) : null,
        u.id === ctx.me.id ? null : button(u.active ? 'Deactivate' : 'Reactivate', () => toggleActive(u, reload), { small: true, kind: u.active ? 'danger' : undefined }),
      ] : null) },
    ], users) : empty('No logins.'));
}

function roleOptions(isOwner) { return (isOwner ? ROLES : ROLES.filter((r) => r !== 'manager')); }

function addLogin(staff, isOwner, done) {
  const f = h('div', { class: 'form' },
    field('Email', input({ name: 'email', type: 'email', required: true, autocomplete: 'off' })),
    field('Temporary password', input({ name: 'password', type: 'text', required: true, minlength: 10, autocomplete: 'off' }), 'At least 10 characters. Tell them to change it after signing in.'),
    field('Role', select(roleOptions(isOwner).map((r) => [r, label(r)]), 'staff', { name: 'role' })),
    field('Staff record', select([['', 'Not linked'], ...staff.map((s) => [s.id, `${s.first_name} ${s.last_name}`])], '', { name: 'staff_id' })));
  formDialog('Add a login', f, async (fd) => {
    await post('/users', { email: val(fd, 'email'), password: fd.get('password'), role: val(fd, 'role'), staff_id: num(fd, 'staff_id') || undefined });
    toast('Login created');
    await done();
  }, { submitText: 'Create login' });
}

function linkStaff(u, staff, done) {
  formDialog(`Staff record for ${u.email}`, h('div', { class: 'form' },
    field('Staff member', select([['', 'Not linked'], ...staff.map((s) => [s.id, `${s.first_name} ${s.last_name}`])], u.staff_id || '', { name: 'staff_id' }), 'Each staff member can have one login')), async (fd) => {
    await patch(`/users/${u.id}`, { staff_id: num(fd, 'staff_id') || null });
    toast('Saved');
    await done();
  });
}

function changeRole(u, isOwner, done) {
  formDialog(`Role for ${u.email}`, h('div', { class: 'form' }, field('Role', select(roleOptions(isOwner).map((r) => [r, label(r)]), u.role, { name: 'role' }))), async (fd) => {
    await patch(`/users/${u.id}`, { role: val(fd, 'role') });
    toast('Role changed. It applies right away');
    await done();
  });
}

function resetPassword(u) {
  formDialog(`New password for ${u.email}`, h('div', { class: 'form' },
    field('New password', input({ name: 'password', type: 'text', required: true, minlength: 10, autocomplete: 'off' }), 'They are signed out everywhere until they use it')), async (fd) => {
    await post(`/users/${u.id}/reset-password`, { new_password: fd.get('password') });
    toast('Password reset');
  }, { submitText: 'Reset password' });
}

function toggleActive(u, done) {
  const off = u.active;
  confirmDialog(off ? 'Deactivate this login?' : 'Reactivate this login?', off ? `${u.email} is signed out immediately and cannot sign in.` : `${u.email} can sign in again.`, off ? 'Deactivate' : 'Reactivate', async () => {
    await patch(`/users/${u.id}`, { active: !off });
    toast(off ? 'Login deactivated' : 'Login reactivated');
    await done();
  }, { danger: off });
}

function resetMfa(u, done) {
  confirmDialog('Reset two-step sign-in?', `${u.email} will sign in with just their password until they set two-step up again. Do this when they have lost their phone and their recovery codes.`, 'Reset two-step', async () => {
    await post(`/users/${u.id}/reset-mfa`);
    toast('Two-step sign-in reset');
    await done();
  }, { danger: true });
}

// ---------------------------------------------------------------- the mountain's own details
/** Name, address and phone for receipts, the waiver wording, comp and gate settings, and the two-step rule. */
async function mountainForm() {
  const t = await get('/tenant/profile');
  const isOwner = ctx.me.role === 'owner';
  const name = input({ name: 'name', value: t.name || '', maxlength: 255, required: true });
  const address = input({ name: 'address', value: t.address || '', maxlength: 255, placeholder: 'Street, town, state' });
  const phone = input({ name: 'phone', value: t.phone || '', maxlength: 40 });
  const footer = h('textarea', { name: 'receipt_footer', rows: 2, maxlength: 500 }, t.receipt_footer || '');
  const waiver = h('textarea', { name: 'waiver_text', rows: 8, maxlength: 20000, 'aria-label': 'Waiver wording' }, t.waiver_text || '');
  const comp = input({ name: 'comp', inputmode: 'decimal', value: centsToInput(t.comp_counter_limit_cents), 'aria-label': 'Counter free-of-charge limit' });
  const passback = input({ name: 'passback', type: 'number', min: 0, max: 3600, value: t.scan_passback_seconds, 'aria-label': 'Pass-back seconds' });
  const booking = h('input', { type: 'checkbox', name: 'online_booking', checked: Boolean(t.online_booking) });
  const notice = input({ name: 'booking_notice_hours', type: 'number', min: 0, max: 240, value: t.booking_notice_hours ?? 12, 'aria-label': 'Booking notice hours' });
  const cancelHrs = input({ name: 'cancel_hours', type: 'number', min: 0, max: 240, value: t.cancel_hours ?? 24, 'aria-label': 'Cancel hours' });
  const bookMsg = input({ name: 'booking_message', maxlength: 500, value: t.booking_message || '', placeholder: 'For example: Lessons are at the Ski School desk in the base lodge.' });
  const payOn = h('input', { type: 'checkbox', name: 'online_payment', checked: Boolean(t.online_payment), disabled: !t.stripe_ready });
  const fullHrs = input({ name: 'refund_full_hours', type: 'number', min: 0, max: 720, value: t.refund_full_hours ?? 48, 'aria-label': 'Full refund hours' });
  const halfHrs = input({ name: 'refund_half_hours', type: 'number', min: 0, max: 720, value: t.refund_half_hours ?? 24, 'aria-label': 'Partial refund hours' });
  const halfPct = input({ name: 'refund_half_percent', type: 'number', min: 0, max: 100, value: t.refund_half_percent ?? 50, 'aria-label': 'Partial refund percent' });
  const cancelNote = input({ name: 'cancel_note', maxlength: 500, value: t.cancel_note || '', placeholder: 'Optional extra line, for example: Groups of 6 or more, call us to change.' });
  const bookUrl = `${location.origin}/book/${t.slug}`;
  const weeklyOn = h('input', { type: 'checkbox', name: 'weekly_report', checked: t.weekly_report !== false });
  const quickOn = h('input', { type: 'checkbox', name: 'quick_sale', checked: t.quick_sale !== false });
  const shopOn = h('input', { type: 'checkbox', name: 'online_shop', checked: Boolean(t.online_shop) });
  const shopMsg = input({ name: 'shop_message', maxlength: 500, value: t.shop_message || '', placeholder: 'For example: Show the barcode on your phone at the gate. No printing needed.' });
  const recov = h('input', { type: 'checkbox', checked: Boolean(t.shop_recovery) });
  const chgOn = h('input', { type: 'checkbox', checked: t.shop_change_hours !== null && t.shop_change_hours !== undefined });
  const chgHours = input({ name: 'shop_change_hours', type: 'number', min: 0, max: 720, value: t.shop_change_hours ?? 24 });
  const chgFee = input({ name: 'shop_change_fee', inputmode: 'decimal', value: centsToInput(t.shop_change_fee_cents || 0) });
  const shopLimit = input({ name: 'online_daily_limit', type: 'number', min: 1, max: 1000000, value: t.online_daily_limit || '', placeholder: 'No limit' });
  const shopUrl = `${location.origin}/shop/${t.slug}`;
  const mfa = h('input', { type: 'checkbox', name: 'require_mfa', checked: Boolean(t.require_mfa), disabled: !isOwner });
  const slot = h('div');
  const go = h('button', { type: 'submit', class: 'btn primary' }, 'Save');
  const form = h('form', { class: 'stack', novalidate: true, 'data-form': 'mountain' },
    h('div', { class: 'form' }, field('Mountain name', name), field('Phone', phone), field('Address', address, 'Printed at the top of receipts and ticket slips')),
    field('Receipt footer', footer, 'For example: opening hours, a thank-you, or the refund policy'),
    field('Waiver wording', waiver, 'Shown to guests before they sign. Have a lawyer review it before you rely on it. Every version is kept word for word. To ask everyone to sign a new version again, change it on the Waivers page instead.'),
    h('div', { class: 'form' },
      field('Counter staff may give away up to', comp, 'In dollars per sale. 0 means only managers can sell free of charge.'),
      field('Gate: warn if a ticket is scanned again within (seconds)', passback, '0 turns the warning off. Catches a ticket passed back across the fence.')),
    h('div', { class: 'stack', 'data-section': 'online-booking' },
      h('h3', null, 'Online lesson booking'),
      h('label', { class: 'check' }, booking, ' Guests can ask for a lesson on the public booking page'),
      h('p', { class: 'muted small' }, 'Without card payment, requests hold a place and staff confirm each one (Ski school > Online requests); the guest pays at the desk. With card payment, guests pay when they reserve and the lesson is booked automatically. Share this link: ', h('code', null, bookUrl)),
      h('label', { class: 'check' }, payOn, ' Guests pay by card when they reserve'),
      t.stripe_ready ? null : h('p', { class: 'muted small' }, 'Card payment is not connected yet. Add your Stripe keys first (see RUNBOOK.md, "Online card payment").'),
      h('h4', null, 'Cancellation and refunds (card payments)'),
      h('div', { class: 'form' },
        field('Full refund if cancelled at least this many hours before', fullHrs),
        field('Partial refund if cancelled at least this many hours before', halfHrs, 'Must be fewer hours than the full refund. Later than this: no refund.'),
        field('Partial refund percent', halfPct), field('Extra line for the policy', cancelNote)),
      h('div', { class: 'form' },
        field('Requests close this many hours before a lesson', notice),
        field('Guests can cancel online up to this many hours before', cancelHrs),
        field('Message shown at the top of the page', bookMsg))),
    h('label', { class: 'check' }, quickOn, ' Quick sale at the ticket window: day tickets, punch cards and vouchers can be sold without a name (season passes, lessons and rentals always need one)'),
    h('label', { class: 'check' }, weeklyOn, ' Email the weekly report to owners and managers every Monday (also in Money > Weekly report)'),
    h('div', { class: 'stack', 'data-section': 'online-shop' },
      h('h3', null, 'Online shop (tickets and passes)'),
      h('label', { class: 'check' }, shopOn, ' Guests can buy tickets and passes by card on the public shop page'),
      h('p', { class: 'muted small' }, 'Choose which products are sold online by ticking "Sell on the online shop" on each product (Products and prices). Guests pay on Stripe, then get their tickets by email and on a page with a barcode the gate can scan. Share this link: ', h('code', null, shopUrl)),
      t.stripe_ready ? null : h('p', { class: 'muted small' }, 'Card payment is not connected yet, so the page will show "not open". Add your Stripe keys first (see RUNBOOK.md, "Online card payment").'),
      field('Message shown at the top of the page', shopMsg),
      h('label', { class: 'check' }, recov, ' Send one reminder email to guests who started an order but did not pay'),
      h('label', { class: 'check' }, chgOn, ' Guests can move a single-day ticket to another day from their ticket page'),
      h('div', { class: 'form' }, field('Up to this many hours before the day', chgHours), field('Fee for a change ($, 0 for free)', chgFee, 'The guest also pays any rise in the ticket price. A lower price is not refunded.')),
      field('Most tickets for one day, all products together (blank = no limit)', shopLimit, 'Counts every day ticket and multi-day ticket valid that day, window sales too. A day that reaches it shows Sold out online. You can also set a limit on each product.')),
    h('label', { class: 'check' }, mfa, isOwner ? ' Everyone must use two-step sign-in (each person, including you, is asked to set it up on their next screen)' : ' Everyone must use two-step sign-in (only the owner can change this)'),
    slot, h('div', { class: 'row' }, go));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(slot);
    go.disabled = true;
    try {
      const limit = toCents(comp.value);
      if (limit === null) throw new Error('Enter the limit in dollars, for example 0 or 50.00');
      const body = { name: name.value.trim(), address: address.value.trim() || null, phone: phone.value.trim() || null, receipt_footer: footer.value.trim() || null,
        waiver_text: waiver.value.trim() || null, comp_counter_limit_cents: limit, scan_passback_seconds: Number(passback.value || 0),
        online_booking: booking.checked, booking_notice_hours: Number(notice.value || 0), cancel_hours: Number(cancelHrs.value || 0), booking_message: bookMsg.value.trim() || null,
        online_payment: payOn.checked, online_shop: shopOn.checked, online_daily_limit: shopLimit.value ? Number(shopLimit.value) : null, shop_recovery: recov.checked, shop_change_hours: chgOn.checked ? Number(chgHours.value || 0) : null, shop_change_fee_cents: Math.max(0, toCents(chgFee.value) || 0), weekly_report: weeklyOn.checked, quick_sale: quickOn.checked, shop_message: shopMsg.value.trim() || null, refund_full_hours: Number(fullHrs.value || 0), refund_half_hours: Number(halfHrs.value || 0), refund_half_percent: Number(halfPct.value || 0), cancel_note: cancelNote.value.trim() || null };
      if (isOwner) body.require_mfa = mfa.checked;
      await put('/tenant/profile', body);
      toast('Saved');
    } catch (err) { slot.append(errorBox(err)); } finally { go.disabled = false; }
  });
  return h('section', { class: 'panel stack' }, h('h2', null, 'Mountain details and rules'), form);
}
