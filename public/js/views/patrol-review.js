// Patrol > Cases > Review: the reports waiting for the review group, oldest first, and the group itself: the Patrol
// Director and backups, which kinds of case they review, and how long before a reminder. Only patrol admins choose who
// reviews and which kinds; the group's members can change the reminder time.

import { get, put } from '../api.js';
import { h, clear, button, input, field, toast, errorBox, empty, table, state, label } from '../ui.js';

const waitText = (hrs) => (hrs === null ? '' : hrs < 1 ? 'Under an hour' : hrs < 48 ? `${hrs} h` : `${Math.floor(hrs / 24)} days`);

export async function drawReview(box, me) {
  clear(box).append(h('p', { class: 'loading' }, 'Loading…'));
  let s; let q;
  try { [s, q] = await Promise.all([get('/patrol/review/settings'), get('/patrol/review/queue')]); } catch (err) { clear(box).append(errorBox(err)); return; }
  clear(box);
  if (q.can_review) {
    box.append(h('section', { class: 'section stack' }, h('header', null, h('h2', null, 'Waiting for review')),
      q.data.length ? table([
        { head: 'Case', cell: (r) => h('a', { href: `#/patrol/case/${r.id}` }, h('strong', null, r.case_number)) },
        { head: 'What', cell: (r) => h('span', { class: 'stack tight' }, r.summary, h('small', { class: 'muted' }, `${label(r.category)}, ${r.severity} · ${r.location}`)) },
        { head: 'Signed off by', cell: (r) => [r.submitted_by || '', r.own ? h('small', { class: 'muted' }, ' (you: another reviewer will review it)') : null] },
        { head: 'Waiting', cell: (r) => state(waitText(r.waiting_hours), r.waiting_hours >= q.nudge_hours ? 'bad' : r.waiting_hours >= 24 ? 'warn' : 'neutral') },
        { head: '', cell: (r) => [r.escalated ? state('Escalated', 'bad') : null, r.round > 1 ? state('Signed again', 'neutral') : null] },
      ], q.data) : empty('Nothing is waiting for review.')));
  }
  box.append(groupPanel(s, () => drawReview(box, me)));
}

function groupPanel(s, redraw) {
  const lead = s.reviewers.find((r) => r.lead);
  const summary = s.enabled
    ? h('p', null, `${s.reviewers.filter((r) => r.active).map((r) => `${r.name}${r.lead ? ' (Patrol Director)' : ''}`).join(', ')} review${s.reviewers.length === 1 ? 's' : ''} ${s.categories.map((c) => label(c).toLowerCase()).join(', ')} cases. A reminder goes to the group after ${s.nudge_hours} hours.`)
    : h('p', null, 'There is no review group yet. Until there is, anyone whose patrol access level can approve reports approves them.');
  const panel = h('section', { class: 'section stack' }, h('header', null, h('h2', null, 'Review group')), summary,
    h('p', { class: 'muted small' }, 'Every report of the kinds below goes to the group when the patroller signs it off. The group gets a message in its Inbox conversation, and a reviewer approves it, sends it back with comments or escalates it. Nobody reviews a report they signed off. Other kinds of case are signed off without review.'));
  if (!s.can_edit) return panel;

  const locked = !s.can_edit_group; // a member, not a patrol admin: the reminder time only
  const picked = new Map(s.reviewers.filter((r) => r.active).map((r) => [r.user_id, r.lead]));
  let leadId = lead ? lead.user_id : null;
  const people = h('div', { class: 'pick-list review-people' });
  const drawPeople = () => {
    clear(people).append(...s.candidates.map((c) => {
      const cb = h('input', { type: 'checkbox', checked: picked.has(c.id), disabled: locked, 'aria-label': `${c.name} is in the review group` });
      const radio = h('input', { type: 'radio', name: 'lead', checked: leadId === c.id, disabled: locked || !picked.has(c.id), 'aria-label': `${c.name} is the Patrol Director` });
      cb.addEventListener('change', () => { if (cb.checked) picked.set(c.id, false); else { picked.delete(c.id); if (leadId === c.id) leadId = null; } drawPeople(); });
      radio.addEventListener('change', () => { leadId = c.id; });
      return h('div', { class: 'review-person' }, h('label', { class: 'check' }, cb, h('span', null, h('b', null, c.name), h('small', null, ` ${label(c.role)}${c.stale ? ' (cannot open Patrol: take them off)' : ''}`))),
        h('label', { class: 'check lead-pick' }, radio, ' Patrol Director'));
    }));
  };
  drawPeople();
  const cats = new Set(s.categories);
  const catBox = h('div', { class: 'row wrap' }, s.all_categories.map((c) => {
    const cb = h('input', { type: 'checkbox', checked: cats.has(c.value), disabled: locked });
    cb.addEventListener('change', () => (cb.checked ? cats.add(c.value) : cats.delete(c.value)));
    return h('label', { class: 'check' }, cb, ` ${c.label}`);
  }));
  const hours = input({ type: 'number', min: 1, max: 720, value: s.nudge_hours, 'aria-label': 'Hours before a reminder' });
  const err = h('div');
  const save = button('Save review group', async () => {
    clear(err);
    try {
      await put('/patrol/review/settings', { reviewers: [...picked.keys()].map((id) => ({ user_id: id, lead: id === leadId })), categories: [...cats], nudge_hours: Number(hours.value) || 72 });
      toast(picked.size ? 'Review group saved' : 'Review group removed');
      redraw();
    } catch (ex) { err.append(errorBox(ex)); }
  }, { kind: 'primary' });
  panel.append(
    h('h3', null, 'Who reviews'), h('p', { class: 'muted small' }, locked ? 'Only a patrol admin can change who reviews, the director and which kinds of case are reviewed. You can change the reminder time.' : 'Tick the Patrol Director and the backups, and mark who is the director.'), people,
    h('h3', null, 'Which kinds of case go for review'), catBox,
    field('Reminder to the group after (hours)', hours, 'There is no deadline. Reports waiting this long are listed in a reminder in the group\'s Inbox conversation, and again each time this much more time passes.'),
    err, h('div', { class: 'row' }, save));
  return panel;
}

