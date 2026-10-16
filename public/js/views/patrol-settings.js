// Patrol > Admin > Patrol settings: the medical director and protocol version (stamped on each report at sign-off),
// volunteer days, self sign-up for open shifts, the sweep's late alert, oxygen refill level, controlled counts,
// avalanche work and text messages on critical calls. Each part is changed by whoever runs that part of patrol.
import { get, put } from '../api.js';
import { h, clear, input, field, button, toast, errorBox } from '../ui.js';

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
      group('Medical oversight', s.can.settings, [
        field('Medical director', input({ name: 'medical_director', maxlength: 150, value: s.medical_director || '', placeholder: 'Dr. Jane Smith, St. Luke\'s ED' })),
        field('Protocol version', input({ name: 'protocol_version', maxlength: 60, value: s.protocol_version || '', placeholder: 'OEC 6th ed. with 2026 local protocols' })),
        check('sms_critical', 'Text responders as well as the phone alert on critical calls (needs text messages set up)', s.sms_critical),
        check('avalanche', 'This mountain does avalanche work (shows the Avalanche page)', s.avalanche),
      ], (fd) => ({ medical_director: String(fd.get('medical_director') || '').trim() || null, protocol_version: String(fd.get('protocol_version') || '').trim() || null, sms_critical: Boolean(fd.get('sms_critical')), avalanche: Boolean(fd.get('avalanche')) }),
      'The medical director and protocol version are stamped on each report when it is signed off.'),
      group('Volunteer days and shifts', s.can.schedule, [
        field('Days a season', input({ name: 'min_days', type: 'number', min: 0, max: 200, value: s.min_days ?? '' }), 'Leave blank for no minimum'),
        field('For candidates', input({ name: 'min_days_candidate', type: 'number', min: 0, max: 200, value: s.min_days_candidate ?? '' }), 'Blank: the same as everyone'),
        field('Reminder dates', input({ name: 'remind_dates', value: s.remind_dates, pattern: '\\d{2}-\\d{2}(,\\d{2}-\\d{2})*' }), 'MM-DD, separated by commas. Anyone short gets an Inbox message.'),
        check('self_signup', 'Patrollers may put themselves on open published shifts (Team, Cover)', s.self_signup),
      ], (fd) => ({ min_days: numOrNull(fd, 'min_days'), min_days_candidate: numOrNull(fd, 'min_days_candidate'), remind_dates: String(fd.get('remind_dates')).trim(), self_signup: Boolean(fd.get('self_signup')) })),
      group('Sweep', s.can.sweep, [field('Alert when routes are not clear after (minutes)', input({ name: 'sweep_late_minutes', type: 'number', min: 5, max: 240, value: s.sweep_late_minutes }))], (fd) => ({ sweep_late_minutes: Number(fd.get('sweep_late_minutes')) })),
      group('Medications and oxygen', s.can.meds, [
        field('Refill oxygen below (psi)', input({ name: 'o2_refill_psi', type: 'number', min: 0, max: 3000, value: s.o2_refill_psi })),
        check('controlled_counts', 'Keep two-person counts of controlled medications', s.controlled_counts),
      ], (fd) => ({ o2_refill_psi: Number(fd.get('o2_refill_psi')), controlled_counts: Boolean(fd.get('controlled_counts')) })));
  }
  await load();
}
