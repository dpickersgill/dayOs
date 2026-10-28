// Settings > Patrol > Patrol settings: the medical director and protocol version (stamped on each report at sign-off),
// volunteer days, self sign-up for open shifts, the sweep's late alert, oxygen refill level, controlled counts,
// avalanche work and text messages on critical calls. Each part is changed by whoever runs that part of patrol.
import { get, put, post, patch, del } from '../api.js';
import { h, clear, input, select, field, button, toast, errorBox, confirmDialog, formDialog, ctx } from '../ui.js';

const DIFFICULTY = [['green', 'Green'], ['blue', 'Blue'], ['black', 'Black'], ['double_black', 'Double black'], ['park', 'Park']];

/**
 * Runs and lifts: the list incidents, trail checks and sweep routes point at. A patrol on its own (no Lifts and trails
 * app) keeps it here; with that app on, it is the same list, kept by the mountain.
 */
export function runsPanel(canEdit) {
  const box = h('section', { class: 'panel stack', 'data-panel': 'runs' });
  async function draw() {
    let lifts; let trails;
    try { [lifts, trails] = await Promise.all([get('/schedule/lifts'), get('/schedule/trails')]); } catch (err) { clear(box).append(errorBox(err)); return; }
    lifts = lifts.data || lifts; trails = trails.data || trails;
    const shared = (ctx.me.modules || []).includes('conditions');
    const list = (kind, items, extra) => h('ul', { class: 'plain stack tight', 'data-list': kind }, ...items.map((x) => h('li', { class: 'row between' },
      h('span', null, h('b', null, x.name), x.difficulty ? h('span', { class: 'muted small' }, ` ${(DIFFICULTY.find((d) => d[0] === x.difficulty) || [0, x.difficulty])[1]}`) : null),
      canEdit ? h('span', { class: 'row' },
        button('Rename', () => formDialog(`Rename ${x.name}`, h('div', { class: 'form' }, field('Name', input({ name: 'name', value: x.name, maxlength: 100, required: true }))), async (fd) => { await patch(`/schedule/${kind}/${x.id}`, { name: String(fd.get('name') || '').trim() }); await draw(); }), { small: true }),
        button('Remove', () => confirmDialog(`Remove ${x.name}?`, 'Past cases keep the name they were written with.', 'Remove', async () => { await del(`/schedule/${kind}/${x.id}`); await draw(); }, { danger: true }), { small: true })) : null)),
    items.length ? null : h('li', { class: 'muted' }, extra));
    const addForm = (kind) => {
      const name = input({ name: 'name', maxlength: 100, required: true, placeholder: kind === 'lifts' ? 'For example: Summit Quad' : 'For example: Upper Ridge' });
      const diff = kind === 'trails' ? select(DIFFICULTY, 'blue', { name: 'difficulty', 'aria-label': 'Difficulty' }) : null;
      const f = h('form', { class: 'row', novalidate: true }, name, diff, button(kind === 'lifts' ? 'Add lift' : 'Add run', null, { type: 'submit', small: true }));
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!name.value.trim()) return;
        try { await post(`/schedule/${kind}`, { name: name.value.trim(), ...(diff ? { difficulty: diff.value } : {}), status: 'closed' }); await draw(); } catch (err) { toast(err.message, 'error'); }
      });
      return f;
    };
    clear(box).append(h('h3', null, 'Runs and lifts'),
      h('p', { class: 'muted small' }, shared ? 'The same list the mountain keeps in Lifts and trails. Cases, trail checks and sweep routes point at it.' : 'Cases, trail checks and sweep routes point at these. Add each run and lift once.'),
      h('div', { class: 'grid2' },
        h('div', { class: 'stack tight' }, h('h4', null, `Runs (${trails.length})`), list('trails', trails, 'No runs yet.'), canEdit ? addForm('trails') : ''),
        h('div', { class: 'stack tight' }, h('h4', null, `Lifts (${lifts.length})`), list('lifts', lifts, 'No lifts yet.'), canEdit ? addForm('lifts') : '')));
  }
  draw();
  return box;
}

export async function drawOpsSettings(box) {
  const body = h('div', { class: 'stack' });
  clear(box).append(body);
  async function load() {
    try { draw(await get('/patrol/ops-settings')); } catch (err) { clear(body).append(errorBox(err)); }
  }
  function draw(s) {
    const group = (title, can, fields, collect, note) => {
      const form = h('form', { class: 'panel stack' }, h('h3', null, title), note ? h('p', { class: 'muted small' }, note) : null, h('div', { class: 'form' }, fields),
        can ? h('div', { class: 'row' }, button('Save', null, { type: 'submit', kind: 'primary', small: true })) : h('p', { class: 'muted small' }, 'Your patrol access cannot change these.'));
      for (const el of form.querySelectorAll('input, select, textarea')) el.disabled = !can;
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await put('/patrol/ops-settings', collect(new FormData(form))); toast('Saved'); await load(); } catch (err) { toast(err.message, 'error'); }
      });
      return form;
    };
    const check = (name, text, on) => h('label', { class: 'check wide' }, h('input', { type: 'checkbox', name, checked: on }), ` ${text}`);
    const numOrNull = (fd, k) => (fd.get(k) === '' || fd.get(k) === null ? null : Number(fd.get(k)));
    clear(body).append(
      runsPanel(Boolean(s.can.settings)),
      group('Medical oversight', s.can.settings, [
        field('Medical director', input({ name: 'medical_director', maxlength: 150, value: s.medical_director || '', placeholder: 'Dr. Jane Smith, St. Luke\'s ED' })),
        field('Protocol version', input({ name: 'protocol_version', maxlength: 60, value: s.protocol_version || '', placeholder: 'OEC 6th ed. with 2026 local protocols' })),
        check('sms_critical', 'Text responders as well as the phone alert on critical calls (needs text messages set up)', s.sms_critical),
        check('avalanche', 'This mountain does avalanche work (shows the Avalanche page)', s.avalanche),
        s.story_fill_available ? check('story_fill', 'Fill in from the story: read the patroller\'s narrative and suggest answers for empty report fields. The narrative is sent to the AI provider; turn this on only once your medical director agrees.', s.story_fill) : null,
      ], (fd) => ({ medical_director: String(fd.get('medical_director') || '').trim() || null, protocol_version: String(fd.get('protocol_version') || '').trim() || null, sms_critical: Boolean(fd.get('sms_critical')), avalanche: Boolean(fd.get('avalanche')), ...(s.story_fill_available ? { story_fill: Boolean(fd.get('story_fill')) } : {}) }),
      'The medical director and protocol version are stamped on each report when it is signed off.'),
      group('Volunteer days and shifts', s.can.schedule, [
        field('Days a season', input({ name: 'min_days', type: 'number', min: 0, max: 200, value: s.min_days ?? '' }), 'Leave blank for no minimum'),
        field('For candidates', input({ name: 'min_days_candidate', type: 'number', min: 0, max: 200, value: s.min_days_candidate ?? '' }), 'Blank: the same as everyone'),
        field('Reminder dates', input({ name: 'remind_dates', value: s.remind_dates, pattern: '\\d{2}-\\d{2}(,\\d{2}-\\d{2})*' }), 'MM-DD, separated by commas. Anyone short gets an Inbox message.'),
        check('self_signup', 'Patrollers may put themselves on open published shifts (People, Shift cover)', s.self_signup),
        check('signup_approval', 'A schedule builder approves each sign-up before the patroller is on it', s.signup_approval),
        check('short_alert', 'On Thursday, message the schedule builders when a weekend crew is short', s.short_alert),
      ], (fd) => ({ min_days: numOrNull(fd, 'min_days'), min_days_candidate: numOrNull(fd, 'min_days_candidate'), remind_dates: String(fd.get('remind_dates')).trim(), self_signup: Boolean(fd.get('self_signup')), signup_approval: Boolean(fd.get('signup_approval')), short_alert: Boolean(fd.get('short_alert')) })),
      group('Sweep', s.can.sweep, [field('Alert when routes are not clear after (minutes)', input({ name: 'sweep_late_minutes', type: 'number', min: 5, max: 240, value: s.sweep_late_minutes }))], (fd) => ({ sweep_late_minutes: Number(fd.get('sweep_late_minutes')) })),
      group('Kits', s.can.equipment, [
        check('kit_seals', 'Seal kits: a kit whose seal number is unchanged is signed off in one tap', s.kit_seals),
      ], (fd) => ({ kit_seals: Boolean(fd.get('kit_seals')) })),
      group('Medications and oxygen', s.can.meds, [
        field('Refill oxygen below (psi)', input({ name: 'o2_refill_psi', type: 'number', min: 0, max: 3000, value: s.o2_refill_psi })),
        check('controlled_counts', 'Keep two-person counts of controlled medications', s.controlled_counts),
      ], (fd) => ({ o2_refill_psi: Number(fd.get('o2_refill_psi')), controlled_counts: Boolean(fd.get('controlled_counts')) })));
  }
  await load();
}
