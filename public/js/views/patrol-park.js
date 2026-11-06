// A patrol case on freestyle terrain: pick the feature from the day's park map instead of typing it from memory. The
// case keeps a snapshot of the feature as it was (size, dimensions, area and its rating, status, the last inspection
// before the incident, its time and who did it). "Close for post-incident inspection" closes the feature and tells the
// park supervisor; it reopens only through a post-incident inspection. The typed park feature field stays as a fallback.

import { get, post } from '../api.js';
import { h, clear, button, select, state, toast, fail, fmtDateTime, formDialog, field, input, val } from '../ui.js';

const PARK_PLACES = ['freestyle_terrain', 'terrain_rail_park', 'half_pipe'];

function snapshotLines(s) {
  const li = s.last_inspection;
  return [
    `${s.kind_label}, size ${s.size_label}${s.dimensions ? `, ${s.dimensions}` : ''}`,
    s.area ? `Area: ${s.area}${s.area_level_label ? ` (rated ${s.area_level_label})` : ''}` : 'No area recorded',
    `Status when linked: ${s.status_label}${s.roped_off ? ', roped off' : ''}`,
    li ? `Last inspection before the incident: ${li.result_label}${li.kind_label ? ` (${li.kind_label.toLowerCase()})` : ''}, ${fmtDateTime(li.at)}, by ${li.by || 'unknown'}` : 'No inspection recorded before the incident',
  ];
}

/** The park feature box in the case's Location section. Shown when the location is freestyle terrain or a link exists. */
export function parkFeatureBox({ c, editable, id }) {
  const where = (c.form && c.form.incident_location) || '';
  const box = h('div', { class: 'lift-box park-feature-box', 'data-area': 'park_feature_link' });
  if (!(id > 0)) return null;
  const load = async () => {
    let links;
    try { links = (await get(`/patrol/incidents/${id}/park-links`)).data; } catch (_) { box.hidden = true; return; }
    const live = links.filter((l) => !l.voided_at);
    box.hidden = !PARK_PLACES.includes(where) && !links.length;
    clear(box).append(h('h3', null, 'Terrain park feature'));
    for (const l of links) {
      const s = l.snapshot;
      box.append(h('div', { class: `park-snap${l.voided_at ? ' voided' : ''}`, 'data-link': l.id },
        h('p', null, l.voided_at ? h('s', null, h('b', null, s.name)) : h('b', null, s.name), l.closed_at ? state('Closed for a post-incident inspection', 'bad') : null),
        h('ul', { class: 'plain small' }, snapshotLines(s).map((t) => h('li', null, t))),
        h('p', { class: 'muted small' }, `Snapshot taken ${fmtDateTime(s.taken_at)} by ${l.linked_by || 'unknown'}. Later changes in the park app do not change it.${l.voided_at ? ` Entered in error: ${l.void_reason}` : ''}`),
        !l.voided_at ? h('div', { class: 'row tight' },
          !l.closed_at ? button('Close for post-incident inspection', async () => {
            try { await post(`/patrol/incidents/${id}/park-links/${l.id}/close`, {}); toast(`${s.name} closed. The park supervisor was told.`); await load(); } catch (err) { fail(err); }
          }, { kind: 'primary' }) : null,
          editable ? button('Entered in error', () => formDialog('Unlink this feature', h('div', { class: 'form' }, h('div', { class: 'wide' }, field('Why', input({ name: 'reason', required: true, minlength: 3, maxlength: 255 })))),
            async (fd) => { await post(`/patrol/incidents/${id}/park-links/${l.id}/void`, { reason: val(fd, 'reason') }); await load(); }, { submitText: 'Mark entered in error' }), { small: true, kind: 'quiet-danger' }) : null) : null));
    }
    if (!editable) return;
    let placed = [];
    try { placed = (await get(`/patrol/park/placed?date=${String(c.occurred_at).slice(0, 10)}`)).data; } catch (_) { placed = []; }
    const free = placed.filter((f) => !live.some((l) => l.feature_id === f.id));
    if (!free.length) {
      box.append(h('p', { class: 'muted small' }, placed.length ? 'Every feature on the park map that day is linked.' : 'No features are on the park map for that day. Type the feature in Park feature name, number and size below, after asking the park supervisor.'));
      return;
    }
    const pick = select([['', 'Pick the feature'], ...free.map((f) => [f.id, `${f.name}: ${f.kind_label}, ${f.size_label}${f.area ? `, ${f.area}` : ''}`])], '', { 'aria-label': 'Park feature on the map that day', class: 'big-select' });
    box.append(h('p', { class: 'muted small' }, 'From the park map for the day of the case. The case keeps a snapshot of the feature and its last inspection.'), pick,
      h('div', { class: 'row tight' }, button('Link this feature', async () => {
        if (!pick.value) { toast('Pick the feature first', 'error'); return; }
        try { await post(`/patrol/incidents/${id}/park-links`, { feature_id: Number(pick.value) }); toast('Feature linked'); await load(); } catch (err) { fail(err); }
      }, { kind: 'primary' })));
  };
  box.hidden = !PARK_PLACES.includes(where);
  load();
  return box;
}
