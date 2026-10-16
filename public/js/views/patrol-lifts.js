// Patrol > Team > Lift evacuation: each lift's written plan, its equipment and where it is kept, how many patrollers it
// takes, who on duty right now is trained for it, and its drills and real evacuations. A drill gives everyone who took
// part a training record.
import { get, post, put } from '../api.js';
import { h, clear, input, field, button, toast, formDialog, empty, errorBox, state, fmtDate, fmtDateTime, nowInput, label } from '../ui.js';

export async function drawLifts(box) {
  const body = h('div', { class: 'stack' });
  clear(box).append(body);
  async function load() {
    try { draw(await get('/patrol/lift-evac')); } catch (err) { clear(body).append(errorBox(err)); }
  }
  function draw(d) {
    clear(body).append(h('div', null, h('h2', null, 'Lift evacuation'), h('p', { class: 'muted' }, 'Ready on duty counts patrollers signed in now who have an evacuation course or a drill on that lift in the last year.')),
      d.data.length ? h('div', { class: 'lift-grid' }, d.data.map((l) => {
        const short = l.needed && l.ready_on_duty.length < l.needed;
        return h('section', { class: 'panel stack' },
          h('div', { class: 'spread' }, h('h3', null, l.name), state(`${l.ready_on_duty.length}${l.needed ? ` of ${l.needed}` : ''} ready on duty`, short ? 'bad' : l.ready_on_duty.length ? 'good' : 'neutral')),
          l.ready_on_duty.length ? h('p', { class: 'small' }, l.ready_on_duty.join(', ')) : null,
          l.plan && l.plan.plan ? h('details', null, h('summary', null, 'Plan'), h('p', { class: 'pre' }, l.plan.plan), l.plan.equipment ? h('p', { class: 'small' }, h('b', null, 'Equipment: '), l.plan.equipment, l.plan.equipment_location ? ` (${l.plan.equipment_location})` : '') : null)
            : h('p', { class: 'muted small' }, 'No written plan yet.'),
          h('p', { class: 'muted small' }, l.last_drill ? `Last drill ${fmtDate(String(l.last_drill.started_at).slice(0, 10))}, ${l.last_drill.people.length} patrollers` : 'No drills recorded.'),
          l.evacs.length ? h('details', null, h('summary', null, `History (${l.evacs.length})`), h('ul', { class: 'duty-list' }, l.evacs.map((e) => h('li', null, state(label(e.kind), e.kind === 'real' ? 'warn' : 'neutral'), ` ${fmtDateTime(e.started_at)}${e.guests != null ? `, ${e.guests} guests` : ''}, ${e.people.map((p) => p.name).join(', ')}`)))) : null,
          h('div', { class: 'row' }, d.can_edit ? button('Edit plan', () => planDialog(l, load), { small: true }) : null, button('Record drill or evacuation', () => evacDialog(l, load), { small: true })));
      })) : empty('No lifts yet. Add them on Mountain status.'));
  }
  await load();
}

function planDialog(l, again) {
  const p = l.plan || {};
  formDialog(`Evacuation plan: ${l.name}`, h('div', { class: 'form' },
    h('div', { class: 'wide' }, field('Plan', h('textarea', { name: 'plan', rows: 10, maxlength: 20000 }, p.plan || ''), 'Who does what, in order: stopping the lift, the rope teams, guests on the ground, counting everyone')),
    field('Equipment', input({ name: 'equipment', maxlength: 500, value: p.equipment || '' }), 'Chair kits, ropes, harnesses'),
    field('Kept at', input({ name: 'equipment_location', maxlength: 200, value: p.equipment_location || '' })),
    field('Patrollers needed', input({ name: 'patrollers_needed', type: 'number', min: 0, max: 100, value: p.patrollers_needed ?? '' }))), async (fd) => {
    await put(`/patrol/lift-evac/${l.id}/plan`, { plan: String(fd.get('plan') || '') || null, equipment: String(fd.get('equipment') || '').trim() || null, equipment_location: String(fd.get('equipment_location') || '').trim() || null, patrollers_needed: fd.get('patrollers_needed') === '' ? null : Number(fd.get('patrollers_needed')) });
    toast('Plan saved'); await again();
  }, { submitText: 'Save plan', wide: true });
}

async function evacDialog(l, again) {
  const { data: roster } = await get('/patrol/team');
  formDialog(`Drill or evacuation: ${l.name}`, h('div', { class: 'form' },
    field('What', h('select', { name: 'kind' }, h('option', { value: 'drill' }, 'Drill'), h('option', { value: 'real' }, 'Real evacuation'))),
    field('Started', input({ name: 'started_at', type: 'datetime-local', required: true, value: nowInput() })), field('Ended', input({ name: 'ended_at', type: 'datetime-local' })),
    field('Guests brought down', input({ name: 'guests', type: 'number', min: 0 })),
    h('fieldset', { class: 'wide' }, h('legend', null, 'Patrollers who took part'), h('div', { class: 'check-grid' }, roster.map((m) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'staff', value: m.staff_id }), ` ${m.first_name} ${m.last_name}`)))),
    h('div', { class: 'wide' }, field('Notes', h('textarea', { name: 'notes', rows: 4 }), 'What went well, what to change'))), async (fd) => {
    await post(`/patrol/lift-evac/${l.id}/evacs`, { kind: fd.get('kind'), started_at: fd.get('started_at'), ended_at: fd.get('ended_at') || null, guests: fd.get('guests') === '' ? null : Number(fd.get('guests')), notes: String(fd.get('notes') || '') || null, staff_ids: fd.getAll('staff').map(Number) });
    toast(fd.get('kind') === 'drill' ? 'Drill recorded, with a training record for each patroller' : 'Evacuation recorded'); await again();
  }, { submitText: 'Save', wide: true });
}
