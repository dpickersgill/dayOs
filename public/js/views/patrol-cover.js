// Patrol > Team > Cover: shift cover. A patroller who cannot work one of their published patrol shifts asks for cover;
// everyone else on the roster sees it here (and in the "Patrol shift cover" Inbox conversation) and takes it if they are
// free. With approval on, those who build the schedule approve each swap first.
import { get, post, put } from '../api.js';
import { h, clear, input, field, button, toast, formDialog, confirmDialog, empty, errorBox, state, fmtDateTime, act, fail } from '../ui.js';
import { span, hrs, minutes, dayShort, monthDay, dayLong } from './workforce-common.js';

const where = (s) => [s.station, s.role_label].filter(Boolean).join(', ');

/** The date as a small calendar leaf, so a list of requests reads by day at a glance. */
const leaf = (dt) => {
  const d = dt.slice(0, 10);
  return h('div', { class: 'cover-leaf', 'aria-hidden': 'true' }, h('span', null, dayShort(d)), h('b', null, String(Number(d.slice(8)))), h('span', null, monthDay(d).split(' ')[0]));
};

export async function drawCover(box) {
  const body = h('div');
  clear(box).append(body);

  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading shift cover…'));
    try { draw(await get('/patrol/cover')); } catch (err) { clear(body).append(errorBox(err)); }
  }

  function draw(c) {
    const parts = [];
    parts.push(h('div', { class: 'week-bar' },
      h('div', null, h('h2', { class: 'week-title' }, 'Shift cover'),
        h('p', { class: 'muted' }, c.needs_approval
          ? 'Can’t make a patrol shift? Ask for cover and the roster sees it here and in the Inbox. When someone offers to take it, a schedule builder approves the swap; until then the shift is still yours.'
          : 'Can’t make a patrol shift? Ask for cover and the roster sees it here and in the Inbox. The shift stays yours until someone takes it, then it moves to them.')),
      c.can_manage ? h('label', { class: 'cover-setting' }, (() => {
        const box2 = h('input', { type: 'checkbox', checked: c.needs_approval });
        box2.addEventListener('change', async () => {
          try { await put('/patrol/cover/settings', { needs_approval: box2.checked }); toast(box2.checked ? 'Swaps now need approval' : 'Swaps no longer need approval'); await load(); } catch (err) { box2.checked = !box2.checked; fail(err); }
        });
        return box2;
      })(), h('span', null, 'A schedule builder approves each swap')) : null));

    // Waiting for approval (schedule builders see all; the two patrollers see their own)
    if (c.pending.length) {
      parts.push(h('section', { class: 'cover-section' }, h('h3', null, c.can_manage ? `Waiting for your approval (${c.pending.length})` : 'Waiting for approval'),
        h('div', { class: 'cover-list' }, c.pending.map((r) => item(r, [
          h('p', { class: 'cover-who' }, h('b', null, r.taken_by_name), ` offered to cover for ${r.name}`, r.reason ? h('span', { class: 'muted' }, `. “${r.reason}”`) : null),
        ], c.can_manage ? [
          button('Approve', (e) => act(e.currentTarget, async () => { await post(`/patrol/cover/${r.id}/approve`); toast(`${r.taken_by_name} is on the shift`); await load(); })(e), { kind: 'primary', small: true }),
          button('Decline', () => declineDialog(r, load), { small: true }),
        ] : r.staff_id === c.me ? [button('Withdraw', () => withdraw(r, load), { small: true })] : [h('span', { class: 'muted small' }, 'You offered. It is yours once approved.')])))));
    }

    // Shifts that need cover
    const open = c.open;
    const others = open.filter((r) => !r.mine);
    parts.push(h('section', { class: 'cover-section' }, h('h3', null, others.length ? `Shifts that need cover (${others.length})` : 'Shifts that need cover'),
      open.length ? h('div', { class: 'cover-list' }, open.map((r) => item(r, [
        h('p', { class: 'cover-who' }, r.mine ? h('b', null, 'Your shift') : h('b', null, r.name), r.reason ? h('span', { class: 'muted' }, ` “${r.reason}”`) : null),
        h('p', { class: 'muted small' }, `Asked ${fmtDateTime(r.created_at)}`),
        !r.mine && !r.can_take && c.on_roster ? h('p', { class: 'cover-why' }, `You can’t take it: ${r.problems.join('. ')}`) : null,
      ], r.mine
        ? [button('Withdraw', () => withdraw(r, load), { small: true })]
        : [c.can_manage ? button('Withdraw', () => withdraw(r, load), { small: true }) : null,
          r.can_take ? button(c.needs_approval ? 'Offer to take it' : 'Take this shift', () => take(r, c.needs_approval, load), { kind: 'primary', small: true }) : null].filter(Boolean))))
        : empty('Nobody needs cover right now.')));

    // Open shifts patrollers may take themselves (when the schedule builders allow it)
    if (c.self_signup && c.on_roster) {
      parts.push(h('section', { class: 'cover-section' }, h('h3', null, c.open_shifts.length ? `Open shifts (${c.open_shifts.length})` : 'Open shifts'),
        c.open_shifts.length ? h('div', { class: 'cover-list' }, c.open_shifts.map((s) => item(s, [
          h('p', { class: 'cover-who' }, h('b', null, 'Open shift')),
          !s.can_take ? h('p', { class: 'cover-why' }, `You can’t take it: ${s.problems.join('. ')}`) : null,
        ], s.can_take ? [button('Take this shift', () => confirmDialog('Take this open shift?', `${dayLong(s.starts_at.slice(0, 10))}, ${span(s.starts_at, s.ends_at)}${where(s) ? `, ${where(s)}` : ''}. It goes on your schedule and My shifts.`, 'Take this shift', async () => {
          await post(`/patrol/cover/open/${s.id}/take`); toast('The shift is yours'); await load();
        }), { kind: 'primary', small: true })] : [])))
          : empty('No open shifts right now.')));
    }

    // My upcoming shifts
    if (c.me && c.on_roster) {
      const asked = new Set([...c.open, ...c.pending].map((r) => r.id));
      parts.push(h('section', { class: 'cover-section' }, h('h3', null, 'Your upcoming patrol shifts'),
        c.my_shifts.length ? h('div', { class: 'cover-list' }, c.my_shifts.map((s) => item(s, [
          s.notes ? h('p', { class: 'muted small' }, s.notes) : null,
          s.request_id ? h('p', null, state(c.pending.some((r) => r.id === s.request_id) ? 'Offer waiting for approval' : 'Cover asked for', 'warn')) : null,
        ], s.request_id && asked.has(s.request_id) ? [] : [button('Ask for cover', () => ask(s, load), { small: true })])))
          : empty('You have no published patrol shifts coming up.')));
    } else if (!c.on_roster) {
      parts.push(h('p', { class: 'muted cover-section' }, c.can_manage ? 'You are not on the patrol roster, so you cannot take shifts yourself. You can withdraw requests here, approve swaps when approval is on, or put someone on a shift from the Schedule tab.' : 'You are not on the patrol roster, so you have no patrol shifts to ask cover for or take.'));
    }

    // Recent history
    if (c.history.length) {
      const words = { covered: ['Covered', 'good'], withdrawn: ['Withdrawn', 'neutral'], closed: ['Changed on the schedule', 'neutral'], expired: ['Not covered', 'bad'] };
      parts.push(h('details', { class: 'cover-section cover-history' }, h('summary', null, `Last two weeks (${c.history.length})`),
        h('ul', { class: 'cover-past' }, c.history.map((r) => h('li', null,
          state(...(words[r.status] || [r.status, 'neutral'])), ' ',
          h('span', null, `${dayShort(r.starts_at.slice(0, 10))} ${monthDay(r.starts_at.slice(0, 10))}, ${span(r.starts_at, r.ends_at)}${where(r) ? `, ${where(r)}` : ''}: `),
          r.status === 'covered' ? h('span', null, h('b', null, r.taken_by_name), ` for ${r.name}`) : h('span', null, r.name))))));
    }
    clear(body).append(...parts);
  }

  /** One shift in a list: the date leaf, the time and place, what's going on, and the actions. */
  function item(s, lines, actions) {
    return h('article', { class: 'cover-item' }, leaf(s.starts_at),
      h('div', { class: 'cover-main' },
        h('p', { class: 'cover-when' }, h('b', null, span(s.starts_at, s.ends_at)), h('span', { class: 'muted' }, ` ${hrs(minutes(s.starts_at, s.ends_at))}${where(s) ? `, ${where(s)}` : ''}`)),
        ...lines.filter(Boolean)),
      actions.length ? h('div', { class: 'cover-actions' }, ...actions) : null);
  }

  await load();
}

function ask(s, onDone) {
  const reason = input({ name: 'reason', maxlength: 200, placeholder: 'Optional, for example "Family wedding"' });
  formDialog('Ask for cover', h('div', { class: 'stack' },
    h('p', null, h('b', null, dayLong(s.starts_at.slice(0, 10))), `, ${span(s.starts_at, s.ends_at)}${where(s) ? `, ${where(s)}` : ''}.`),
    field('Reason', reason, 'Everyone on the patrol roster sees this.'),
    h('p', { class: 'muted small' }, 'You stay on the shift until someone takes it. If nobody does, you are still expected, or talk to whoever builds the schedule.')), async () => {
    await post('/patrol/cover', { patrol_shift_id: s.id, reason: reason.value.trim() || null });
    toast('Cover asked for. The roster has been told.');
    await onDone();
  }, { submitText: 'Ask for cover' });
}

function take(r, needsApproval, onDone) {
  confirmDialog(needsApproval ? 'Offer to take this shift?' : 'Take this shift?', `${dayLong(r.starts_at.slice(0, 10))}, ${span(r.starts_at, r.ends_at)}${where(r) ? `, ${where(r)}` : ''}, for ${r.name}. ${needsApproval
    ? 'A schedule builder approves it, then it is yours and you both get a message.'
    : 'It moves to you now and appears in your schedule and My shifts. ' + r.name + ' gets a message.'}`, needsApproval ? 'Offer to take it' : 'Take this shift', async () => {
    const out = await post(`/patrol/cover/${r.id}/take`);
    toast(out.status === 'covered' ? 'The shift is yours' : 'Offer sent for approval');
    await onDone();
  });
}

function withdraw(r, onDone) {
  confirmDialog('Withdraw the request?', `${r.mine === false ? `${r.name} stays` : 'You stay'} on ${dayShort(r.starts_at.slice(0, 10))} ${monthDay(r.starts_at.slice(0, 10))}, ${span(r.starts_at, r.ends_at)}.${r.taken_by_name && r.status === 'pending' ? ` ${r.taken_by_name}'s offer is closed and they get a message.` : ''}`, 'Withdraw', async () => {
    await post(`/patrol/cover/${r.id}/withdraw`);
    toast('Request withdrawn');
    await onDone();
  });
}

function declineDialog(r, onDone) {
  const note = input({ name: 'note', maxlength: 200, placeholder: 'Optional, for example "We need a senior on that shift"' });
  formDialog('Decline the offer?', h('div', { class: 'stack' },
    h('p', null, `${r.taken_by_name} will not cover ${r.name} on ${dayLong(r.starts_at.slice(0, 10))}, ${span(r.starts_at, r.ends_at)}. The shift goes back on the list for someone else.`),
    field('Reason', note, 'Sent to both of them.')), async () => {
    await post(`/patrol/cover/${r.id}/decline`, { note: note.value.trim() || null });
    toast('Offer declined');
    await onDone();
  }, { submitText: 'Decline offer' });
}
