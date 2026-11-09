// "Guest needs help here" (help/places): lift staff, rentals and anyone else on duty press one button and patrol gets a
// call at this phone's position, in the words patrollers use. Then, if there is time, they say who and add a short note.
// On Mountain status, the Gate and in the side menu (and the phone menu).
import { post } from './api.js';
import { h, clear, ctx, button, field, input, dialog, toast, errorBox } from './ui.js';
import { bestFix } from './gpsfix.js';

const STAFF_ROLES = ['owner', 'manager', 'staff', 'counter', 'instructor', 'patrol'];

/** True when this login may press it: every staff login on a mountain with Patrol, not the ski area's read-only one. */
export function mayAskForHelp() {
  const me = ctx.me;
  if (!me || !STAFF_ROLES.includes(me.role) || me.display) return false;
  return !Array.isArray(me.modules) || me.modules.includes('patrol');
}

/** The big red-outlined button. cls: extra classes for where it sits. */
export function staffHelpButton(cls = '') {
  if (!mayAskForHelp()) return null;
  const b = h('button', { type: 'button', class: `btn staff-help-btn ${cls}`.trim(), 'data-act': 'staff-help' }, h('span', { class: 'sh-plus', 'aria-hidden': 'true' }, '+'), h('span', null, 'Guest needs help here'));
  b.addEventListener('click', () => openStaffHelp());
  return b;
}

/** One tap: find this phone's position (a few seconds at most), send the call, then offer to add who and a note. */
export async function openStaffHelp() {
  const body = h('div', { class: 'stack staff-help' });
  const d = dialog('Guest needs help here', body);
  const say = (...kids) => clear(body).append(...kids);
  say(h('p', { class: 'sh-status', role: 'status', 'aria-live': 'polite' }, 'Finding where you are…'), h('p', { class: 'sh-911' }, 'Life threatening? Call 911 now, then tell patrol.'));
  const f = await bestFix({ waitMs: 6000, good: 20 });
  if (!body.isConnected) return;
  if (!f) { askWhere(); return; }
  await send({ lat: f.lat, lng: f.lng, accuracy_m: Math.round(f.acc) });

  async function send(where) {
    try {
      const r = await post('/patrol/staff-help', where);
      sent(r);
    } catch (err) { say(errorBox(err), h('div', { class: 'row' }, button('Try again', () => openStaffHelp(), { kind: 'primary' }), button('Close', () => d.close()))); }
  }
  function askWhere() {
    const where = input({ name: 'location', maxlength: 120, required: true, placeholder: 'Bottom of Summit Quad, by the maze', 'aria-label': 'Where is the guest' });
    const go = button('Send to patrol', async () => { if (!where.value.trim()) { where.focus(); return; } await send({ location: where.value.trim() }); }, { kind: 'primary big' });
    say(h('p', { role: 'status' }, 'Your phone did not share its location. Say where the guest is.'), field('Where is the guest', where), go, h('p', { class: 'sh-911' }, 'Life threatening? Call 911 now, then tell patrol.'));
    where.focus();
  }
  function sent(r) {
    const who = input({ name: 'who', maxlength: 100, placeholder: 'Child in a red jacket', 'aria-label': 'Who needs help' });
    const note = input({ name: 'note', maxlength: 200, placeholder: 'Fell off the chair at the top', 'aria-label': 'What happened' });
    const add = button('Add to the call', async () => {
      if (!who.value.trim() && !note.value.trim()) { d.close(); return; }
      await post(`/patrol/staff-help/${r.id}/details`, { who: who.value.trim() || null, note: note.value.trim() || null });
      toast('Added to the call'); d.close();
    }, { kind: 'primary' });
    say(h('p', { class: 'sh-sent', role: 'status' }, h('b', null, `Patrol has it: call ${r.call_no}.`)),
      h('p', null, h('span', { class: 'muted' }, 'Sent as: '), r.location),
      h('p', null, 'Stay with the guest if you can. If you have a moment, say who and what happened:'),
      field('Who needs help (optional)', who), field('What happened (optional)', note),
      h('div', { class: 'row' }, add, button('Done', () => d.close())),
      h('p', { class: 'sh-911' }, 'Life threatening? Call 911 now, then tell patrol.'));
    toast(`Patrol has it: call ${r.call_no}`);
  }
}
