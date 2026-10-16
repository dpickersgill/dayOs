// Patrol > Now > Avalanche (when a mountain turns it on): the day's snow and hazard observations, and control work by
// slide path, with the result. A shot can hold or close its run in the same step.
import { get, post } from '../api.js';
import { h, clear, select, input, field, button, toast, formDialog, table, empty, errorBox, state, fmtDateTime, label } from '../ui.js';

const RATING = ['', '1 Low', '2 Moderate', '3 Considerable', '4 High', '5 Extreme'];
const tone = (n) => (!n ? 'neutral' : n >= 4 ? 'bad' : n === 3 ? 'warn' : 'good');

export async function drawAvy(box) {
  const body = h('div', { class: 'stack' });
  clear(box).append(body);
  async function load() {
    try { draw(await get('/patrol/avy')); } catch (err) { clear(body).append(errorBox(err)); }
  }
  function draw(d) {
    const latest = d.obs[0];
    clear(body).append(
      h('div', { class: 'spread' }, h('div', null, h('h2', null, 'Avalanche'), h('p', { class: 'muted' }, `The last ${d.days} days. Ratings use the North American danger scale.`)),
        d.can_edit ? h('div', { class: 'row' }, button('Add observation', () => obsDialog(load), { small: true }), button('Record a shot', () => shotDialog(d, load), { kind: 'primary', small: true }), button('Slide paths', () => pathDialog(d, load), { small: true })) : null),
      latest ? h('section', { class: 'panel' }, h('h3', null, `Latest: ${fmtDateTime(latest.observed_at)}`), h('div', { class: 'row' },
        state(`Below treeline ${RATING[latest.hazard_below] || '-'}`, tone(latest.hazard_below)), state(`Near ${RATING[latest.hazard_near] || '-'}`, tone(latest.hazard_near)), state(`Above ${RATING[latest.hazard_above] || '-'}`, tone(latest.hazard_above))),
        h('p', { class: 'small' }, [latest.hn24_cm != null && `${latest.hn24_cm} cm new in 24 h`, latest.hst_cm != null && `${latest.hst_cm} cm storm total`, latest.wind && `wind ${latest.wind}${latest.wind_dir ? ` from ${latest.wind_dir}` : ''}`, latest.temp_trend].filter(Boolean).join(', ')),
        latest.tests ? h('p', { class: 'small' }, h('b', null, 'Tests: '), latest.tests) : null, latest.notes ? h('p', { class: 'small' }, latest.notes) : null) : empty('No observations in this period.'),
      h('section', { class: 'panel stack' }, h('h3', null, 'Control work'), d.shots.length ? table([
        { head: 'When', cell: (s) => fmtDateTime(s.shot_at) }, { head: 'Path', cell: (s) => s.path }, { head: 'Method', cell: (s) => label(s.method) },
        { head: 'Result', cell: (s) => `${label(s.result)}${s.size_r ? ` R${s.size_r}` : ''}${s.size_d ? ` D${s.size_d}` : ''}${s.crown_cm ? `, crown ${s.crown_cm} cm` : ''}` }, { head: 'By', cell: (s) => s.by_name || '' }, { head: 'Notes', cell: (s) => s.notes || '' },
      ], d.shots) : h('p', { class: 'muted small' }, 'No control work in this period.')));
  }
  await load();
}

function obsDialog(again) {
  const rate = (name) => select(RATING.map((r, i) => [i ? String(i) : '', r || 'Not rated']), '', { name });
  formDialog('Snow and hazard observation', h('div', { class: 'form' },
    field('New snow, 24 h (cm)', input({ name: 'hn24_cm', type: 'number', min: 0 })), field('Storm total (cm)', input({ name: 'hst_cm', type: 'number', min: 0 })),
    field('Wind', select([['', 'Not noted'], ...['calm', 'light', 'moderate', 'strong', 'extreme'].map((w) => [w, label(w)])], '', { name: 'wind' })),
    field('From', select([['', '-'], ...['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].map((x) => [x, x])], '', { name: 'wind_dir' })),
    field('Temperature trend', select([['', 'Not noted'], ['warming', 'Warming'], ['steady', 'Steady'], ['cooling', 'Cooling']], '', { name: 'temp_trend' })),
    field('Below treeline', rate('hazard_below')), field('Near treeline', rate('hazard_near')), field('Above treeline', rate('hazard_above')),
    h('div', { class: 'wide' }, field('Stability tests', input({ name: 'tests', maxlength: 500, placeholder: 'ECTP 12 down 40 on surface hoar, NE 2500 m' }))),
    h('div', { class: 'wide' }, field('Notes', h('textarea', { name: 'notes', rows: 3 })))), async (fd) => {
    const n = (k) => (fd.get(k) === '' ? null : Number(fd.get(k)));
    await post('/patrol/avy/obs', { hn24_cm: n('hn24_cm'), hst_cm: n('hst_cm'), wind: fd.get('wind') || null, wind_dir: fd.get('wind_dir') || null, temp_trend: fd.get('temp_trend') || null, hazard_below: n('hazard_below'), hazard_near: n('hazard_near'), hazard_above: n('hazard_above'), tests: String(fd.get('tests') || '') || null, notes: String(fd.get('notes') || '') || null });
    toast('Observation saved'); await again();
  }, { submitText: 'Save', wide: true });
}

function shotDialog(d, again) {
  if (!d.paths.length) { toast('Add a slide path first', 'error'); return; }
  formDialog('Control shot or ski cut', h('div', { class: 'form' },
    field('Slide path', select(d.paths.filter((p) => Number(p.active)).map((p) => [p.id, `${p.name}${p.trail ? ` (${p.trail})` : ''}`]), '', { name: 'path_id' })),
    field('Method', select([['hand_charge', 'Hand charge'], ['avalauncher', 'Avalauncher'], ['gas', 'Gas exploder'], ['ski_cut', 'Ski cut'], ['cornice', 'Cornice drop'], ['other', 'Other']], 'hand_charge', { name: 'method' })),
    field('Result', select([['no_result', 'No result'], ['sluff', 'Sluff'], ['slide', 'Slide']], 'no_result', { name: 'result' })),
    field('Size R (relative, 1 to 5)', input({ name: 'size_r', type: 'number', min: 1, max: 5 })), field('Size D (destructive, 1 to 5)', input({ name: 'size_d', type: 'number', min: 1, max: 5, step: 0.5 })),
    field('Crown depth (cm)', input({ name: 'crown_cm', type: 'number', min: 0 })),
    field('Its run', select([['', 'Leave as it is'], ['hold', 'Put on hold'], ['closed', 'Close']], '', { name: 'run_status' }), 'Only when the path is linked to a run'),
    h('div', { class: 'wide' }, field('Notes', input({ name: 'notes', maxlength: 500 })))), async (fd) => {
    const n = (k) => (fd.get(k) === '' ? null : Number(fd.get(k)));
    await post('/patrol/avy/shots', { path_id: Number(fd.get('path_id')), method: fd.get('method'), result: fd.get('result'), size_r: n('size_r'), size_d: n('size_d'), crown_cm: n('crown_cm'), run_status: fd.get('run_status') || null, notes: String(fd.get('notes') || '') || null });
    toast('Shot recorded'); await again();
  }, { submitText: 'Save', wide: true });
}

function pathDialog(d, again) {
  formDialog('Add a slide path', h('div', { class: 'stack' },
    d.paths.length ? h('p', { class: 'muted small' }, `Paths now: ${d.paths.map((p) => p.name).join(', ')}`) : null,
    h('div', { class: 'form' }, field('Name', input({ name: 'name', required: true, maxlength: 100 })), field('Run it affects', select([['', 'None'], ...d.trails.map((t) => [t.id, t.name])], '', { name: 'trail_id' })))), async (fd) => {
    await post('/patrol/avy/paths', { name: String(fd.get('name')).trim(), trail_id: fd.get('trail_id') ? Number(fd.get('trail_id')) : null });
    toast('Path added'); await again();
  }, { submitText: 'Add path' });
}
