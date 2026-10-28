// Patrol case > Report: the conditions at the time (what the mountain's own records said: the trail and its grooming,
// snow, weather and the lift), who was told about the incident and when, the lift involved, and rental gear involved. The calls log works with
// no signal: each entry waits on the phone with the time it was made and is sent when the signal returns.
import { get, post, patch } from '../api.js';
import { h, clear, input, select, field, button, toast, formDialog, dialog, val, nowInput, fmtTime, fmtDateTime, label, fail } from '../ui.js';
import { send, pending } from '../outbox.js';
import { voidDialog, sentToast } from './patrol-tools.js';
import { voidedNote } from './patrol-bedside.js';

export const WHO = [['management', 'Management'], ['insurer', 'Insurer'], ['parent', 'Parent or guardian'], ['ems', 'EMS or ambulance'], ['police', 'Police'], ['owner', 'Owner'], ['other', 'Someone else']];
export const METHOD = [['phone', 'Phone'], ['in_person', 'In person'], ['text', 'Text'], ['radio', 'Radio'], ['email', 'Email']];
const whoText = (k) => (WHO.find((x) => x[0] === k) || [k, label(k)])[1];
const methodText = (k) => (METHOD.find((x) => x[0] === k) || [k, label(k)])[1];
const SKY = { clear: 'Clear', partly: 'Partly cloudy', overcast: 'Overcast', snow: 'Snowing', rain: 'Raining', mixed: 'Mixed snow and rain', fog: 'Fog' };
const LIFT = { open: 'Open', hold: 'On hold', wind_hold: 'Wind hold', closed: 'Closed' };
const DIFF = { green: 'Easiest', blue: 'More difficult', black: 'Most difficult', double_black: 'Expert', park: 'Terrain park' };

/** What the mountain's records said at the time, as a short list. Fixed once taken; the patroller can take it again. */
export function conditionsBox({ c, editable, id, onDone }) {
  const s = c.conditions;
  const rows = [];
  if (s && s.trail) {
    const t = s.trail;
    const groomed = t.groomed && typeof t.groomed === 'object' ? `groomed, finished ${fmtTime(t.groomed.at)}` : t.groomed === false ? 'not groomed' : null;
    rows.push(['Trail', [t.name, DIFF[t.difficulty], t.status ? (t.status === 'open' ? 'open' : 'closed') : null, groomed].filter(Boolean).join(', ')]);
    if (t.checked) rows.push(['Last trail check', `${fmtDateTime(t.checked.at)}${t.checked.hazards ? `: ${t.checked.hazards}` : ', no hazards noted'}`]);
  }
  if (s && s.snow) rows.push(['Snow', [s.snow.new_snow_in !== null ? `${s.snow.new_snow_in} in new` : null, s.snow.base_in !== null ? `${s.snow.base_in} in base` : null, s.snow.surface, s.snow.on_trail ? 'on this trail' : null].filter(Boolean).join(', ') + ` (${fmtDateTime(s.snow.at)})`]);
  if (s && s.weather) {
    const w = s.weather;
    rows.push(['Weather', [w.temp_f !== null ? `${w.temp_f} °F` : null, SKY[w.sky], w.wind_mph !== null ? `wind ${w.wind_mph} mph${w.wind_dir ? ` ${w.wind_dir}` : ''}${w.gust_mph ? `, gusts ${w.gust_mph}` : ''}` : null].filter(Boolean).join(', ') + ` (${w.place}, ${fmtTime(w.at)})`]);
  }
  if (s && s.lift) {
    const l = s.lift;
    rows.push(['Lift', [l.name, l.status ? LIFT[l.status] : null, l.stop ? `stopped ${fmtTime(l.stop.started_at)}${l.stop.ended_at ? ` to ${fmtTime(l.stop.ended_at)}` : ''}, ${label(l.stop.reason)}${l.stop.note ? `: ${l.stop.note}` : ''}` : null].filter(Boolean).join(', ')]);
  }
  const retake = editable ? button('Take again', async () => { try { await post(`/patrol/incidents/${id}/conditions`, {}); toast('Conditions taken again'); await onDone(); } catch (err) { fail(err); } }, { small: true }) : null;
  return h('div', { class: 'cond-box', 'data-area': 'conditions-records' },
    h('div', { class: 'spread' }, h('h3', null, 'From the mountain’s records'), retake),
    rows.length ? h('dl', { class: 'cond-list' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]))
      : h('p', { class: 'muted small' }, s ? 'Nothing was recorded near that time: no trail on the case, and no snow or weather reading in the hours before.' : 'Not taken yet.'),
    s ? h('p', { class: 'muted small' }, `Taken ${fmtDateTime(s.taken_at)} for ${fmtDateTime(s.for_time)}.${s.trail && s.trail.status === null ? ' Trail open or closed is only kept when the case is opened within three hours.' : ''} Below, record what you saw; answers taken from these records are marked.`) : null);
}

/** Who was told about the incident and when. Each entry is stamped with the time; it waits on the phone with no signal. */
export function contactsPanel({ c, editable, id, onDone, redraw }) {
  const list = c.contacts || [];
  const waiting = editable ? pending(id).filter((x) => x.path === `/patrol/incidents/${id}/contacts` && !x.error) : [];
  const add = (who) => contactDialog({ c, id, who, onDone, redraw });
  const done = new Set([...list.filter((x) => !x.voided_at).map((x) => x.who), ...waiting.map((x) => x.body.who)]);
  return h('section', { class: 'panel stack', 'data-area': 'contacts' },
    h('div', { class: 'spread' }, h('h2', null, 'Who was told'), editable ? button('Add with a time', () => add('management'), { small: true }) : null),
    editable ? h('div', { class: 'stages contact-chips', role: 'group', 'aria-label': 'Record who was told' }, WHO.map(([k, t]) => {
      const b = h('button', { type: 'button', class: `stage${done.has(k) ? ' done' : ''}`, onclick: () => add(k) }, h('b', null, t), done.has(k) ? h('small', null, 'Told') : h('small', null, 'Tap to record'));
      return b;
    })) : null,
    list.length || waiting.length ? h('ol', { class: 'timeline' },
      list.map((x) => h('li', { class: x.voided_at ? 'voided' : null },
        h('span', null, h('b', null, fmtTime(x.at)), ' ', h('span', { class: 'what' }, x.who === 'other' ? x.who_name : whoText(x.who)),
          h('span', { class: 'muted' }, ` ${[x.who !== 'other' && x.who_name ? x.who_name : null, methodText(x.method), x.recorded_by ? `by ${x.recorded_by}` : null, x.note].filter(Boolean).join(', ')}`), voidedNote(x)),
        editable && !x.voided_at ? button('Entered in error', () => voidDialog({ what: `${whoText(x.who)} at ${fmtTime(x.at)}`, path: `/patrol/incidents/${id}/contacts/${x.id}`, onDone }), { small: true, kind: 'quiet' }) : null)),
      waiting.map((x) => h('li', { class: 'waiting' }, h('span', null, h('b', null, fmtTime(x.body.at || x.at)), ' ', h('span', { class: 'what' }, whoText(x.body.who)), h('span', { class: 'muted' }, ' waiting to send')))))
      : h('p', { class: 'muted' }, 'Nobody recorded yet.'));
}

function contactDialog({ c, id, who, onDone, redraw }) {
  const pick = select(WHO, who, { name: 'who' });
  const name = input({ name: 'who_name', maxlength: 120, placeholder: 'Their name or the company' });
  const live = (c.patients || []).filter((p) => !p.voided_at);
  formDialog('Record who was told', h('div', { class: 'form' },
    field('Who', pick), field('Name', name),
    field('How', select(METHOD, 'phone', { name: 'method' })),
    field('When', input({ type: 'datetime-local', name: 'at', value: nowInput(), required: true })),
    live.length > 1 ? field('About', select([['', 'The whole case'], ...live.map((p) => [p.id, `${p.first_name} ${p.last_name}`])], '', { name: 'patient_id' })) : null,
    h('div', { class: 'wide' }, field('Note', input({ name: 'note', maxlength: 300, placeholder: 'For example: claim number, or left a message' })))), async (fd) => {
    const body = { who: val(fd, 'who'), method: val(fd, 'method'), at: val(fd, 'at') };
    for (const k of ['who_name', 'note']) if (val(fd, k)) body[k] = val(fd, k);
    if (val(fd, 'patient_id')) body.patient_id = Number(val(fd, 'patient_id'));
    if (body.who === 'other' && !body.who_name) throw new Error('Say who, when it is someone else');
    const r = await send('POST', `/patrol/incidents/${id}/contacts`, body, { caseId: id, label: `${whoText(body.who)} told` });
    sentToast(r, `${whoText(body.who)} recorded`);
    if (r && r.queued) redraw(); else await onDone();
  }, { submitText: 'Save' });
}

/** The lift involved, and the chair or cabin number, on the Location section. */
export function liftBox({ c, editable, lifts, id, onDone }) {
  if (!editable) return c.lift_id ? h('p', null, h('b', null, 'Lift: '), `${c.lift || 'Lift'}${c.lift_chair ? `, chair ${c.lift_chair}` : ''}`) : null;
  const lift = select([['', 'No lift involved'], ...(lifts || []).map((l) => [l.id, l.name])], c.lift_id || '', { 'aria-label': 'Lift involved' });
  const chair = input({ maxlength: 12, value: c.lift_chair || '', placeholder: 'Chair or cabin number', 'aria-label': 'Chair or cabin number' });
  const save = button('Save lift', async () => {
    try { await patch(`/patrol/incidents/${id}`, { lift_id: lift.value ? Number(lift.value) : null, lift_chair: chair.value.trim() || null }); toast('Lift saved'); await onDone(); } catch (err) { fail(err); }
  }, { small: true });
  return h('div', { class: 'lift-box', 'data-area': 'lift' }, h('h3', null, 'Lift involved'), h('div', { class: 'row tight' }, lift, chair, save),
    h('p', { class: 'muted small' }, 'The lift’s status and any stop at the time are kept with the conditions.'));
}

const gearName = (it) => `${label(it.category)} ${[it.brand, it.model, it.size].filter(Boolean).join(' ')}`.trim();
function gearLines(d) {
  const b = d.binding || {};
  return [
    d.contract ? `Contract ${d.contract.id}${d.contract.renter ? `, ${d.contract.renter}` : ''}` : 'Not found on a contract',
    b.din_setting !== null && b.din_setting !== undefined ? `Binding set at ${b.din_setting}${b.skier_type ? `, skier type ${b.skier_type}` : ''}${b.boot_sole_mm ? `, boot sole ${b.boot_sole_mm} mm` : ''}${b.tech_name ? ` by ${b.tech_name}` : ''}${b.set_at ? `, ${fmtDateTime(b.set_at)}` : ''}${b.test_result ? `, test ${b.test_result === 'pass' ? 'passed' : 'failed'}` : ''}` : (d.item && d.item.category === 'ski' ? 'No binding setting recorded' : null),
    d.last_service ? `Last service: ${label(d.last_service.kind)}, ${fmtDateTime(d.last_service.done_at)}${d.last_service.done_by ? ` by ${d.last_service.done_by}` : ''}` : 'No service logged',
  ].filter(Boolean);
}

/** Rental gear involved in the case: found by contract, item number or renter, with its binding setting; held for inspection. */
export function rentalsPanel({ c, editable, id, onDone }) {
  const list = c.rentals || [];
  const pts = (c.patients || []).filter((p) => !p.voided_at);
  const holdText = (r) => (r.released_at ? `Inspected by the rental shop ${fmtDateTime(r.released_at)}${r.released_by ? ` (${r.released_by})` : ''}: ${r.inspection_note}` : r.held ? 'Held for inspection by the rental shop' : 'Not held');
  return h('section', { class: 'panel stack', 'data-area': 'rentals' },
    h('div', { class: 'spread' }, h('h2', null, 'Rental gear'), editable ? button('Find rental gear', () => rentalDialog({ id, pts, onDone }), { small: true }) : null),
    list.length ? h('ul', { class: 'plain gear-list' }, list.map((r) => {
      const d = r.detail || {};
      return h('li', { class: r.voided_at ? 'stack tight voided' : 'stack tight' },
        h('div', { class: 'spread' }, h('span', null, h('b', { class: 'what' }, d.item ? `${d.item.sku}, ${gearName(d.item)}` : 'Rental item'), r.patient_id && pts.length > 1 ? h('span', { class: 'muted' }, ` (${(pts.find((p) => p.id === r.patient_id) || {}).first_name || 'patient'})`) : null),
          editable && !r.released_at && !r.voided_at ? button('Entered in error', () => voidDialog({ what: d.item ? `${d.item.sku}, ${gearName(d.item)}` : 'Rental item', path: `/patrol/incidents/${id}/rentals/${r.id}`, onDone }), { small: true, kind: 'quiet' }) : null),
        h('ul', { class: 'gear-facts' }, gearLines(d).map((x) => h('li', null, x))),
        r.voided_at ? h('p', { class: 'small muted' }, voidedNote(r)) : h('p', { class: r.held && !r.released_at ? 'cover-why' : 'muted small' }, holdText(r)));
    })) : h('p', { class: 'muted' }, 'No rental gear on this case.'));
}

function rentalDialog({ id, pts, onDone }) {
  const q = input({ maxlength: 60, placeholder: 'Contract number, item number, or renter’s name', 'aria-label': 'Find rental gear' });
  const who = pts.length > 1 ? select([['', 'Which patient?'], ...pts.map((p) => [p.id, `${p.first_name} ${p.last_name}`])], '') : null;
  const out = h('div', { class: 'stack' });
  let dlg = null;
  const search = async () => {
    if (q.value.trim().length < 2) return;
    clear(out).append(h('p', { class: 'loading' }, 'Looking…'));
    try {
      const r = await get(`/patrol/rental-lookup?q=${encodeURIComponent(q.value.trim())}`);
      clear(out);
      if (!r.data.length) { out.append(h('p', { class: 'muted' }, 'Nothing found. Try the contract number on the rental form, or the number on the ski or board.')); return; }
      for (const ct of r.data) {
        out.append(h('div', { class: 'stack tight gear-contract' }, h('b', null, `Contract ${ct.id}, ${ct.renter}`), h('span', { class: 'muted small' }, `${label(ct.status)}, out ${fmtDateTime(ct.checked_out_at)}`),
          ...ct.items.filter(Boolean).map((d) => h('div', { class: 'spread' }, h('span', null, h('b', null, `${d.item.sku} `), gearName(d.item), h('br'), h('small', { class: 'muted' }, gearLines(d).slice(1).join('. '))),
            button('Add to case', async () => {
              try {
                const res = await post(`/patrol/incidents/${id}/rentals`, { rental_item_id: d.item.id, contract_id: ct.id, patient_id: who && who.value ? Number(who.value) : (pts.length === 1 ? pts[0].id : null) });
                toast(res.held ? `${d.item.sku} added and held for the rental shop` : `${d.item.sku} added`);
                dlg.close(); await onDone();
              } catch (err) { fail(err); }
            }, { small: true, kind: 'primary' })))));
      }
    } catch (err) { fail(err); clear(out); }
  };
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
  dlg = dialog('Find rental gear', [h('div', { class: 'row tight' }, q, button('Find', search, { kind: 'primary' })), who ? field('For', who) : null, out,
    h('p', { class: 'muted small' }, 'Adding gear keeps its binding setting and last service on the report. Unless your rental shop has turned it off, the gear is held until the shop inspects it.')], { wide: true });
  setTimeout(() => q.focus(), 50);
}
