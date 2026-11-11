// Pieces shared by the asset page, the asset map's panel and Programs (muni release 1): condition, criticality and risk
// in words; a pick of 1 to 5; photos as thumbnails with Add a photo; a pump station's run hours by month; a small map
// of one map item; and the inspection sheet for an asset or a map item.

import { get, sendBytes, fetchBlob, download, openFile } from '../api.js';
import { h, clear, state, button, toast, dialog, select, errorBox, fmtDateTime, table } from '../ui.js';
import { answerSheet, resultChips } from '../checksteps.js';
import { loadLeaflet, makeMap, removeWhenGone, fitMap } from './incident-map.js';

export const CONDITIONS = ['New or like new', 'Good', 'Fair', 'Poor', 'Failed or failing'];
export const CRITICALITIES = ['Low', 'Minor', 'Moderate', 'High', 'Severe'];
export const OWNERSHIP = [['own', 'Ours'], ['authority', 'The authority'], ['private', 'Private (the property owner)'], ['state', 'The state (PennDOT)'], ['other', 'Someone else']];
const RISK_TONE = { low: 'good', medium: 'neutral', high: 'warn', very_high: 'bad' };
// Map colors by risk, from the theme (app.css --risk-*), read when a map draws.
export const riskColor = (level) => window.getComputedStyle(document.documentElement).getPropertyValue(`--risk-${(level || 'none').replace('_', '-')}`).trim() || '#888';

/** "Condition 3, Fair" */
export const conditionText = (n) => (n ? `${n}, ${CONDITIONS[n - 1]}` : 'Not scored');
export const criticalityText = (n) => (n ? `${n}, ${CRITICALITIES[n - 1]}` : 'Not scored');
/** The risk as a colored state: "High risk (16)", or nothing when it is not scored. */
export function riskState(risk) {
  if (!risk) return null;
  return state(`${risk.label} risk (${risk.score})`, RISK_TONE[risk.level] || 'neutral');
}
/** A select of 1 to 5 with words, for a form. */
export function scoreSelect(name, words, value, none = 'Not scored') {
  return select([['', none], ...words.map((w, i) => [String(i + 1), `${i + 1}, ${w}`])], value ? String(value) : '', { name });
}

/** Photos as thumbnails (each opens at full size), with Add a photo. uploadPath: where a new one goes. */
export function photoStrip(photos, uploadPath, done) {
  const strip = h('div', { class: 'photo-strip' });
  for (const p of photos) {
    const img = h('img', { alt: p.caption || 'Photo', loading: 'lazy' });
    const b = h('button', { type: 'button', class: 'photo-thumb', title: [p.caption, p.taken_at && `Taken ${fmtDateTime(p.taken_at)}`].filter(Boolean).join('. ') || 'Open the photo' }, img);
    b.addEventListener('click', () => openFile(`/assets/photos/${p.id}`).catch((e) => toast(e.message, 'error')));
    fetchBlob(`/assets/photos/${p.id}`).then((blob) => { img.src = URL.createObjectURL(blob); }).catch(() => { img.alt = 'Could not load the photo'; });
    strip.append(b);
  }
  const pick = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'visually-hidden', 'aria-label': 'Add a photo' });
  pick.addEventListener('change', async () => {
    const f = pick.files && pick.files[0];
    if (!f) return;
    try { await sendBytes('POST', `${uploadPath}?file_name=${encodeURIComponent(f.name)}`, f); toast('Photo added'); await done(); } catch (e) { toast(e.message, 'error'); }
  });
  const add = button('Add a photo', () => pick.click(), { small: true });
  return h('div', { class: 'stack tight' }, photos.length ? strip : h('p', { class: 'muted' }, 'No photos yet.'), h('div', { class: 'row' }, add, pick));
}

/** A pump station's run hours by month: a table with a Download button. data: { pumps, months }; csvPath and file name. */
export function runHoursTable(data, csvPath, fileName) {
  if (!data || !data.pumps.length) return h('p', { class: 'muted' }, 'No run hour readings yet. They come from the hour meters on each pump station round.');
  const t = table([
    { head: 'Month', cell: (m) => monthName(m.month) },
    ...data.pumps.map((p) => ({ head: p.label, num: true, cell: (m) => (m.hours[p.key] === null ? '' : `${m.hours[p.key]} h`) })),
    { head: 'Total', num: true, cell: (m) => h('b', null, `${m.total} h`) },
  ], data.months.slice(0, 12));
  return h('div', { class: 'stack tight' }, t,
    h('p', { class: 'muted small' }, 'Hours run between one round\'s meter reading and the next, counted in the month of the later reading.'),
    h('div', { class: 'row' }, button('Download spreadsheet', () => download(csvPath, fileName), { small: true })));
}
const monthName = (ym) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });

/** A small map of one map item (a work order's, a panel's). f: { geometry, points or lat/lng, system }. */
export async function miniMap(f, { label = 'Where it is' } = {}) {
  const el = h('div', { class: 'map-box mini-map', role: 'img', 'aria-label': label });
  try {
    const [L, cfg] = await Promise.all([loadLeaflet(), get('/assets/map/view')]);
    const pts = f.points && f.points.length ? f.points : [[f.lat, f.lng]];
    const sys = cfg.systems.find((s) => s.key === f.system) || cfg.systems.find((s) => s.key === 'other');
    const map = makeMap(L, el, cfg, { lat: pts[0][0], lng: pts[0][1], zoom: 18 }, { base: 'Satellite', remember: 'assets' });
    removeWhenGone(el, map);
    const style = { color: sys ? sys.color : '#333', weight: 5 };
    if (f.geometry === 'line' && pts.length > 1) L.polyline(pts, style).addTo(map);
    else if (f.geometry === 'area' && pts.length > 2) L.polygon(pts, { ...style, weight: 3, fillOpacity: 0.2 }).addTo(map);
    else L.circleMarker(pts[0], { radius: 9, color: style.color, weight: 4, fillOpacity: 0.6 }).addTo(map);
    if (pts.length > 1) fitMap(map, L.latLngBounds(pts), { padding: [20, 20], maxZoom: 19 });
  } catch (err) { el.replaceWith(errorBox(err)); }
  return el;
}

/**
 * The inspection sheet for an asset or a map item. target: { name, kind, type: 'asset'|'feature', id, hours?, miles? }.
 * templates: the checklists (from /assets/meta). save(body) sends it (the asset's, the map item's or a program target's
 * address); photoPath is where a photo for an item goes. The checklist made for this kind is picked first.
 */
export function inspectDialog(target, templates, { save, photoPath, done, title, preferId, meters = false }) {
  const active = templates.filter((t) => t.active);
  const fits = (t) => (target.type === 'asset' ? t.kinds.includes(target.kind) : t.map_kinds.includes(target.kind));
  const plain = (t) => !t.kinds.length && !t.map_kinds.length;
  const pick = active.find((t) => t.id === preferId) || active.find(fits) || active.find(plain) || active[0];
  if (!pick) { toast('Add a checklist under Assets and fleet, Settings, first', 'error'); return null; }
  const ordered = [...active.filter(fits), ...active.filter((t) => !fits(t))];
  const chooser = select(ordered.map((t) => [t.id, t.name]), pick.id, { 'aria-label': 'Checklist' });
  if (preferId) chooser.disabled = true;
  const box = h('div', { class: 'stack' });
  const err = h('div');
  let sheet = null;
  const sendPhoto = async (file) => (await sendBytes('POST', `${photoPath}?file_name=${encodeURIComponent(file.name || 'photo.jpg')}`, file)).id;
  const drawItems = () => {
    const t = active.find((x) => String(x.id) === chooser.value);
    sheet = answerSheet(t.items, resultChips, { photo: sendPhoto });
    clear(box).append(sheet.el);
    if (t.sets_condition) box.append(h('p', { class: 'muted small' }, 'The condition score you give here becomes its condition.'));
  };
  chooser.addEventListener('change', drawItems);
  drawItems();
  const allPass = h('button', { type: 'button', class: 'btn small' }, 'Mark the rest as pass');
  allPass.addEventListener('click', () => sheet.markRestPass());
  const n1 = (v) => Math.round(Number(v) * 10) / 10;
  const hours = meters ? h('input', { type: 'number', step: '0.1', min: 0, inputmode: 'decimal', 'aria-label': 'Hours now', placeholder: target.hours ? String(n1(target.hours)) : 'Hours now' }) : null;
  const miles = meters ? h('input', { type: 'number', step: '0.1', min: 0, inputmode: 'decimal', 'aria-label': 'Miles now', placeholder: target.miles !== null && target.miles !== undefined ? String(n1(target.miles)) : 'Miles now' }) : null;
  const note = h('input', { maxlength: 500, 'aria-label': 'Note', placeholder: 'Anything else (optional)' });
  const saveBtn = h('button', { type: 'button', class: 'btn primary big', 'data-act': 'save-inspection' }, 'Save inspection');
  const dlg = dialog(title || `Inspect: ${target.name}`, h('div', { class: 'stack ins-sheet' }, h('div', { class: 'row' }, chooser, allPass), box, meters ? h('div', { class: 'row tight' }, hours, miles) : null, note, err, h('div', { class: 'footer row' }, saveBtn)), { wide: true });
  dlg.box.classList.add('sheet');
  saveBtn.addEventListener('click', async () => {
    clear(err);
    const answers = sheet.answers;
    const missing = answers.filter((x) => x.missing());
    if (missing.length) { err.append(errorBox(new Error(`Answer every item (${missing.length} left)`))); missing[0].focus(); return; }
    const noNote = answers.filter((x) => x.needsNote());
    if (noNote.length) { err.append(errorBox(new Error('Say what is wrong with each item that failed'))); noNote[0].focus(); return; }
    const noPhoto = answers.filter((x) => x.needsPhoto && x.needsPhoto());
    if (noPhoto.length) { err.append(errorBox(new Error(`Take the photo for: ${noPhoto.map((x) => x.step.label).join('; ')}`))); return; }
    saveBtn.disabled = true;
    try {
      const body = { template_id: Number(chooser.value), items: answers.map((x) => x.get()), note: note.value.trim() || null };
      if (meters) { body.hours = hours.value === '' ? null : Number(hours.value); body.miles = miles.value === '' ? null : Number(miles.value); }
      const r = await save(body);
      dlg.close();
      toast(r.result === 'pass' ? 'Inspection passed' : 'Inspection failed: a work order was opened', r.result === 'pass' ? 'ok' : 'warn');
      if (done) await done(r);
    } catch (e) { err.append(errorBox(e)); saveBtn.disabled = false; }
  });
  return dlg;
}

/** One line per inspection: passed or failed, the checklist, when and who, and what failed or was read. */
export function inspectionRows(list) {
  if (!list.length) return h('p', { class: 'muted' }, 'No inspections recorded.');
  const shown = (x) => (x.value === null || x.value === undefined ? null : `${x.label}: ${x.value}${x.unit ? ` ${x.unit}` : ''}`);
  return h('ul', { class: 'plain rows' }, list.map((i) => h('li', null,
    h('span', null, state(i.result === 'pass' ? 'Passed' : 'Failed', i.result === 'pass' ? 'good' : 'bad'), ' ', h('b', null, i.template_name),
      h('span', { class: 'muted small' }, ` ${fmtDateTime(i.done_at)}${i.inspector ? `, ${i.inspector}` : ''}${i.condition_score ? `. Condition ${conditionText(i.condition_score)}` : ''}`)),
    i.result === 'fail' ? h('p', { class: 'small' }, i.items.filter((x) => x.result === 'fail').map((x) => `${x.label}: ${x.note}`).join('; ')) : null,
    i.items.some((x) => x.value != null && x.result !== 'fail') ? h('p', { class: 'small muted' }, i.items.filter((x) => x.value != null && x.result !== 'fail').map(shown).filter(Boolean).join('; ')) : null)));
}

