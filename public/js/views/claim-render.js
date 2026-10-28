// The claim file and the season risk report as documents: one renderer for the in-app print pages
// (#/patrol/claim/:id, #/patrol/risk-report) and for the secure links an insurer or broker opens (/c/<token>).
// Built with h() only (no innerHTML). Times are the mountain's wall clock, shown with the date and year.
import { h, label } from '../ui.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const m = (s) => /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(s || ''));
export const day = (s) => { const x = m(s); return x ? `${MONTHS[+x[2] - 1]} ${+x[3]}, ${x[1]}` : ''; };
export const clock = (s) => { const x = m(s); if (!x || x[4] === undefined) return ''; const hh = +x[4]; return `${((hh + 11) % 12) + 1}:${x[5]} ${hh < 12 ? 'AM' : 'PM'}`; };
export const when = (s) => { const x = m(s); if (!x) return ''; return x[4] === undefined ? day(s) : `${day(s)}, ${clock(s)}`; };
const t = (s) => (s === null || s === undefined || s === '' ? '' : String(s));
const nn = (v) => v !== null && v !== undefined && v !== '';
const kv = (pairs) => {
  const rows = pairs.filter(([, v]) => nn(v) && v !== false);
  return rows.length ? h('dl', { class: 'kv cf-kv' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])) : null;
};
const sec = (title, ...body) => {
  const kids = body.flat().filter((x) => x !== null && x !== undefined && x !== false);
  return kids.length ? h('section', { class: 'cf-sec' }, h('h2', null, title), kids) : null;
};
const tbl = (heads, rows) => (rows.length ? h('div', { class: 'table-wrap cf-table' }, h('table', { class: 'rt' }, h('thead', null, h('tr', null, heads.map((x) => h('th', { scope: 'col' }, x)))),
  h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => h('td', { 'data-label': heads[i] || null }, c)))))) ) : null);
const voided = (x) => Boolean(x && x.voided_at);
const live = (list) => (list || []).filter((x) => !voided(x));
const name = (p) => [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Unnamed patient';

const BASIS = {
  approved: ['Approved report, frozen', 'This is the report exactly as it was approved. Changes made since then are not part of it.'],
  approved_live: ['Approved', 'Approved, shown as it stands (no frozen copy was found).'],
  submitted: ['Not approved yet: the latest version', 'Signed off and waiting for review. It may still change.'],
  draft: ['Not approved: a draft', 'A draft. It may still change and has not been signed off.'],
};

function ageOf(p, onDay) {
  if (nn(p.age_years)) return Number(p.age_years);
  const b = m(p.date_of_birth); const d = m(onDay);
  if (!b || !d) return null;
  let a = +d[1] - +b[1];
  if (+d[2] < +b[2] || (+d[2] === +b[2] && +d[3] < +b[3])) a -= 1;
  return a;
}

const REGION = { wrist_hand: 'wrist or hand', ankle_foot: 'ankle or foot', lower_leg: 'lower leg' };
const injuryText = (i) => {
  const where = `${i.side && !['na', 'midline'].includes(i.side) ? `${i.side} ` : ''}${REGION[i.body_region] || String(i.body_region || '').replace(/_/g, ' ')}`;
  return `${label(where)}: ${label(i.injury_type || 'other')}${i.notes ? ` (${i.notes})` : ''}`;
};
const SKY = { clear: 'Clear', partly: 'Partly cloudy', overcast: 'Overcast', snow: 'Snowing', rain: 'Raining', mixed: 'Mixed snow and rain', fog: 'Fog' };
const vitalsRow = (v) => [clock(v.taken_at) || when(v.taken_at), t(v.pulse), t(v.resp), nn(v.bp_sys) ? `${v.bp_sys}/${t(v.bp_dia)}` : '', nn(v.spo2) ? `${v.spo2}%` : '', t(v.gcs), t(v.pain), label(v.avpu || ''), t(v.notes)];

function patientBlock(p, c) {
  const age = ageOf(p, c.occurred_at);
  return h('article', { class: 'cf-patient' },
    h('h3', null, name(p), age !== null ? h('span', { class: 'muted' }, ` · ${age} years`) : null, voided(p) ? h('span', { class: 'cf-void' }, ' Entered in error') : null),
    kv([
      ['Date of birth', p.date_of_birth ? day(p.date_of_birth) : null], ['Sex', p.sex ? label(p.sex) : null], ['Home town', p.home_town],
      ['Activity', p.activity ? label(p.activity) : null], ['Ability', p.ability ? label(p.ability) : null], ['Helmet', p.helmet ? label(p.helmet) : null],
      ['Rental gear', p.rental_equipment ? label(p.rental_equipment) : null],
      ['Chief complaint', p.chief_complaint], ['How it happened', p.mechanism], ['Assessment', p.assessment],
      ['Allergies', p.allergies], ['Medications', p.medications], ['History', p.medical_history],
      ['Outcome', p.disposition ? label(p.disposition) : null], ['Destination', p.destination], ['Parent or guardian', p.guardian_name],
    ]),
    live(p.injuries).length ? h('div', null, h('h4', null, 'Injuries'), h('ul', { class: 'cf-list' }, live(p.injuries).map((i) => h('li', null, injuryText(i))))) : null,
    live(p.vitals).length ? h('div', null, h('h4', null, 'Vitals'), tbl(['Time', 'Pulse', 'Resp', 'BP', 'SpO2', 'GCS', 'Pain', 'AVPU', 'Notes'], live(p.vitals).map(vitalsRow))) : null,
    live(p.treatments).length ? h('div', null, h('h4', null, 'Care given'), tbl(['Time', 'Care', 'Details', 'By'], live(p.treatments).map((x) => [clock(x.performed_at) || when(x.performed_at), label(x.kind), [x.description, x.medication, x.dose, x.route].filter(Boolean).join(', '), t(x.performed_by_name)]))) : null);
}

/** Every timed thing on the case, in order: events, vitals, care, who was told. */
function careTimeline(c) {
  const pn = new Map((c.patients || []).map((p) => [Number(p.id), name(p)]));
  const items = [
    ['occurred', c.occurred_at, 'Incident', c.location || ''],
    ...live(c.events).map((e) => ['event', e.at, label(e.kind), [e.note, e.patient_id ? pn.get(Number(e.patient_id)) : null].filter(Boolean).join(' · ')]),
    ...live(c.patients).flatMap((p) => [
      ...live(p.vitals).map((v) => ['vitals', v.taken_at, 'Vitals', `${name(p)}: pulse ${t(v.pulse) || '-'}, BP ${nn(v.bp_sys) ? `${v.bp_sys}/${t(v.bp_dia)}` : '-'}, SpO2 ${nn(v.spo2) ? `${v.spo2}%` : '-'}, GCS ${t(v.gcs) || '-'}`]),
      ...live(p.treatments).map((x) => ['care', x.performed_at, label(x.kind), `${name(p)}${x.description ? `: ${x.description}` : ''}`]),
    ]),
    ...live(c.contacts).map((x) => ['told', x.at, `Told: ${label(x.who)}`, [x.who_name, label(x.method)].filter(Boolean).join(' · ')]),
    c.submitted_at ? ['report', c.submitted_at, 'Report signed off', ''] : null,
    c.approved_at ? ['report', c.approved_at, 'Report approved', ''] : null,
  ].filter((x) => x && x[1]).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  return items.length ? h('ol', { class: 'cf-timeline' }, items.map(([k, at, what, more]) => h('li', { class: `cf-tl-${k}` }, h('time', null, when(at)), h('b', null, what), more ? h('span', null, more) : null))) : null;
}

function conditionsBlock(s) {
  if (!s) return null;
  const tr = s.trail; const sn = s.snow; const w = s.weather; const l = s.lift;
  return kv([
    ['Taken', s.taken_at ? `${when(s.taken_at)} for ${when(s.for_time)}` : null],
    ['Trail', tr ? `${tr.name}${tr.difficulty ? ` (${label(tr.difficulty)})` : ''}${tr.status ? `, ${label(tr.status)}` : ''}` : null],
    ['Grooming', tr && tr.groomed ? (typeof tr.groomed === 'object' ? `Groomed ${when(tr.groomed.at)}` : 'Groomed') : tr && tr.groomed === false ? 'Not groomed' : null],
    ['Trail check', tr && tr.checked ? `${when(tr.checked.at)}${tr.checked.hazards ? `: ${tr.checked.hazards}` : ''}` : null],
    ['Snow', sn ? [nn(sn.base_in) ? `${sn.base_in}" base` : null, nn(sn.new_snow_in) ? `${sn.new_snow_in}" new` : null, sn.surface ? label(sn.surface) : null, sn.quality ? label(sn.quality) : null].filter(Boolean).join(', ') + ` (${when(sn.at)})` : null],
    ['Weather', w ? [nn(w.temp_f) ? `${w.temp_f} °F` : null, w.sky ? (SKY[w.sky] || label(w.sky)) : null, nn(w.wind_mph) ? `wind ${w.wind_mph} mph${w.wind_dir ? ` ${w.wind_dir}` : ''}` : null, nn(w.gust_mph) ? `gusts ${w.gust_mph}` : null].filter(Boolean).join(', ') + ` (${when(w.at)}${w.place ? `, ${w.place}` : ''})` : null],
    ['Lift', l ? `${l.name}${l.status ? `, ${label(l.status)}` : ''}` : null],
    ['Lift stop', l && l.stop ? `${when(l.stop.started_at)} to ${l.stop.ended_at ? clock(l.stop.ended_at) : 'still stopped'}: ${label(l.stop.reason || '')}${l.stop.note ? `, ${l.stop.note}` : ''}` : null],
    ['Evacuation', l && l.evac ? `${when(l.evac.started_at)}${nn(l.evac.guests) ? `, ${l.evac.guests} guests` : ''}` : null],
  ]);
}

function rentalsBlock(list) {
  const rows = (list || []).map((r) => {
    const d = r.detail || {}; const it = d.item || {}; const b = d.binding || {}; const s = d.last_service || null;
    return [
      [it.sku, [it.brand, it.model].filter(Boolean).join(' '), it.size ? `size ${it.size}` : null, it.category ? label(it.category) : null].filter(Boolean).join(' · '),
      nn(b.din_setting) ? `${b.din_setting}${b.skier_type ? ` (type ${b.skier_type})` : ''}${nn(b.boot_sole_mm) ? `, sole ${b.boot_sole_mm} mm` : ''}` : 'Not recorded',
      b.tech_name ? `${b.tech_name}${b.set_at ? `, ${when(b.set_at)}` : ''}${b.test_result ? ` (${label(b.test_result)})` : ''}` : '',
      s ? `${label(s.kind)} ${when(s.done_at)}${s.done_by ? ` by ${s.done_by}` : ''}` : 'None recorded',
      r.held ? (r.released_at ? `Held, released ${when(r.released_at)}` : 'Held for inspection') : 'Not held',
    ];
  });
  return tbl(['Gear', 'Binding setting', 'Set by', 'Last service', 'Held'], rows);
}

function enteredInError(c) {
  const out = [];
  const add = (kind, x, what) => { if (voided(x)) out.push([kind, what, when(x.voided_at), t(x.void_reason), t(x.voided_by_email)]); };
  for (const p of c.patients || []) {
    add('Patient', p, name(p));
    for (const v of p.vitals || []) add('Vitals', v, `${name(p)}, ${when(v.taken_at)}`);
    for (const x of p.treatments || []) add('Care', x, `${name(p)}, ${label(x.kind)}`);
    for (const x of p.injuries || []) add('Injury', x, `${name(p)}, ${label(x.body_region || '')}`);
  }
  for (const e of c.events || []) add('Time stamp', e, `${label(e.kind)} ${when(e.at)}`);
  for (const x of c.contacts || []) add('Who was told', x, `${label(x.who)} ${when(x.at)}`);
  for (const x of c.photos || []) add('Photo', x, x.caption || `Photo ${x.id}`);
  for (const x of c.witnesses || []) add('Witness', x, x.name || 'Witness');
  for (const x of c.responders || []) add('Responder', x, `${[x.first_name, x.last_name].filter(Boolean).join(' ')} (${label(x.role)})`);
  for (const x of c.parties || []) add('Person involved', x, [x.first_name, x.last_name].filter(Boolean).join(' ') || label(x.role || ''));
  for (const x of c.rentals || []) add('Rental gear', x, ((x.detail || {}).item || {}).sku || 'Rental item');
  return tbl(['What', 'Item', 'Marked', 'Why', 'By'], out);
}

/**
 * The claim file. f: { case_number, basis, version, resort, report, scene, legal_hold, legal_hold_note, release }.
 * opts.photoSrc(photo, img) fills an <img>; opts.extra: more sections (the in-app score, records, links, audit trail).
 */
export function claimDoc(f, { photoSrc = null, extra = [], header = null } = {}) {
  const c = f.report || {};
  const [basisTitle, basisNote] = BASIS[f.basis] || BASIS.draft;
  const photos = live(c.photos);
  const scene = f.scene && f.scene.svg ? sceneImg(f.scene.svg) : null;
  return h('article', { class: 'cf-doc' },
    header,
    h('header', { class: 'cf-head' },
      h('p', { class: 'cf-resort' }, (f.resort && (f.resort.legal_name || f.resort.name)) || ''),
      h('h1', null, `Claim file: Case ${f.case_number || c.case_number || ''}`),
      h('p', { class: `cf-basis ${f.basis === 'approved' ? 'is-frozen' : 'is-live'}` }, h('b', null, basisTitle), f.version ? ` · Version ${f.version.version_no}, ${when(f.version.created_at)}` : '', h('br'), h('span', null, basisNote)),
      f.release ? h('p', { class: 'cf-basis is-frozen' }, h('b', null, `Release ${f.release.release_no}`), ` to ${f.release.to}, ${when(f.release.released_at)}`) : null,
      (f.legal_hold || c.legal_hold) ? h('p', { class: 'cf-hold' }, h('b', null, 'Legal hold. '), f.legal_hold_note || c.legal_hold_note || '') : null),
    sec('The incident', kv([
      ['When', when(c.occurred_at)], ['Where', c.location], ['Trail', c.trail], ['Lift', c.lift ? `${c.lift}${c.lift_chair ? `, chair ${c.lift_chair}` : ''}` : null],
      ['Attraction', c.attraction ? `${c.attraction}${c.attraction_type_label ? ` (${c.attraction_type_label})` : ''}` : null],
      ['GPS', nn(c.gps_lat) ? `${Number(c.gps_lat).toFixed(5)}, ${Number(c.gps_lng).toFixed(5)}` : null],
      ['Kind', c.category ? label(c.category) : null], ['Severity', c.severity ? label(c.severity) : null], ['Report', c.report_state ? label(c.report_state) : null],
      ['Signed off', c.submitted_at ? when(c.submitted_at) : null], ['Approved', c.approved_at ? when(c.approved_at) : null],
      ['Responders', live(c.responders).map((r) => `${[r.first_name, r.last_name].filter(Boolean).join(' ')}${r.patrol_number ? ` #${r.patrol_number}` : ''} (${label(r.role)})`).join('; ')],
      ['Protocols', c.protocol_stamp],
    ]), c.summary ? h('p', null, h('b', null, 'Summary. '), c.summary) : null, c.narrative ? h('div', { class: 'cf-narrative' }, h('h3', null, 'Narrative'), h('p', null, c.narrative)) : null),
    sec(`Patients (${live(c.patients).length})`, live(c.patients).map((p) => patientBlock(p, c))),
    sec('Care timeline', careTimeline(c)),
    sec('Who was told', tbl(['When', 'Who', 'How', 'Note', 'Recorded by'], live(c.contacts).map((x) => [when(x.at), `${label(x.who)}${x.who_name ? `: ${x.who_name}` : ''}`, label(x.method), t(x.note), t(x.recorded_by)])) || h('p', { class: 'muted' }, 'Nobody recorded as told.')),
    sec('Conditions at the time', conditionsBlock(c.conditions) || h('p', { class: 'muted' }, 'No conditions snapshot on this case.')),
    live(c.rentals).length ? sec('Rental gear', rentalsBlock(live(c.rentals))) : null,
    live(c.witnesses).length ? sec(`Witnesses (${live(c.witnesses).length})`, live(c.witnesses).map((w) => h('article', { class: 'cf-witness' },
      h('h3', null, w.name || 'Witness', w.relation ? h('span', { class: 'muted' }, ` · ${label(w.relation)}`) : null),
      kv([['Phone', w.phone], ['Email', w.email], ['Address', [w.address, w.city, w.region, w.postal].filter(Boolean).join(', ')], ['Received', w.received_at ? `${when(w.received_at)}${w.source === 'link' ? ', written by the witness' : ''}` : null]]),
      w.statement ? h('blockquote', { class: 'cf-statement' }, w.statement) : h('p', { class: 'muted small' }, 'No statement.')))) : null,
    scene ? sec('Scene diagram', scene, f.scene.updated_at ? h('p', { class: 'muted small' }, `Last drawn ${when(f.scene.updated_at)}`) : null) : null,
    c.collision ? sec('Collision report', kv([
      ['Type', c.collision.collision_type ? label(c.collision.collision_type) : null], ['Hit and run', Number(c.collision.hit_and_run) ? 'Yes' : null], ['Other party', c.collision.unknown_party_description],
      ['Right of way', c.collision.right_of_way ? label(c.collision.right_of_way) : null], ['Police', Number(c.collision.police_notified) ? `${c.collision.police_agency || 'Notified'}${c.collision.police_report_no ? `, report ${c.collision.police_report_no}` : ''}` : null],
      ['Equipment held', Number(c.collision.equipment_held) ? 'Yes' : null], ['Damage', c.collision.property_damage], ['Findings', c.collision.findings],
    ]), tbl(['Party', 'Name', 'Age', 'Helmet', 'Statement'], live(c.parties).map((p) => [label(p.role), [p.first_name, p.last_name].filter(Boolean).join(' '), t(p.age_years), p.helmet ? label(p.helmet) : '', t(p.statement)]))) : null,
    photos.length ? sec(`Photos (${photos.length})`, h('div', { class: 'cf-photos' }, photos.map((p) => {
      const img = h('img', { alt: p.caption || `Photo ${p.id}`, loading: 'lazy' });
      if (photoSrc && p.has_preview !== false) photoSrc(p, img);
      return h('figure', { class: 'cf-photo' }, img, h('figcaption', null,
        h('b', null, p.caption || `Photo ${p.id}`),
        h('span', null, `Taken ${p.taken_at ? when(p.taken_at) : 'time not in the file'}${nn(p.taken_lat) ? ` at ${Number(p.taken_lat).toFixed(5)}, ${Number(p.taken_lng).toFixed(5)}` : ''}`),
        h('span', null, `Added ${when(p.uploaded_at)}${p.uploaded_by_name ? ` by ${p.uploaded_by_name}` : ''}`),
        h('code', { class: 'cf-sha', title: 'SHA-256 fingerprint of the original file' }, `SHA-256 ${p.sha256}`)));
    })), h('p', { class: 'muted small' }, 'Each fingerprint identifies the original file exactly: any copy with the same fingerprint is the same photo, unaltered.')) : null,
    (c.signatures || []).length ? sec('Signatures', tbl(['Signed', 'Kind', 'Name', 'Role'], c.signatures.map((s) => [when(s.signed_at), label(s.kind), t(s.signer_name), s.signer_role ? label(s.signer_role) : '']))) : null,
    (c.checklist || []).length ? sec('Checklists', tbl(['List', 'Item', 'For', 'Ticked'], checklistRows(c)),
      h('p', { class: 'muted small' }, 'Each item in the words it was ticked under, with who ticked it and when.')) : null,
    ((c.exceptions || []).length || (c.skips || []).length) ? sec('Approved with exceptions, and skipped items',
      tbl(['Item', 'Reason', 'Approved by'], (c.exceptions || []).map((e) => [t(e.label), t(e.reason), `${t(e.approved_by)} ${when(e.approved_at)}`])),
      tbl(['Skipped', 'Reason', 'By'], (c.skips || []).map((s) => [label(s.item_key), `${label(s.reason || '')}${s.note ? `: ${s.note}` : ''}`, `${t(s.skipped_by)} ${when(s.skipped_at)}`]))) : null,
    sec('Entered in error', enteredInError(c) || h('p', { class: 'muted' }, 'Nothing on this report was marked entered in error.'), h('p', { class: 'muted small' }, 'Items marked entered in error stay on the record with who marked them and why. Nothing is deleted.')),
    (c.versions || []).length ? sec('Versions', tbl(['Version', 'Kind', 'Made', 'By'], c.versions.map((v) => [String(v.version_no), label(v.kind), when(v.created_at), t(v.created_by)]))) : null,
    extra,
    h('footer', { class: 'cf-foot' }, 'Confidential patient information. Share only as the authority on file allows.'));
}

/** Checklist ticks as they were ticked: the list title and item words kept with each tick. */
function checklistRows(c) {
  const who = (pid) => { const p = Number(pid) ? (c.patients || []).find((x) => x.id === Number(pid)) : null; return p ? name(p) : 'The case'; };
  return [...c.checklist].sort((a, b) => String(a.list_title || '').localeCompare(String(b.list_title || '')) || Number(a.patient_id) - Number(b.patient_id))
    .map((r) => [t(r.list_title || 'Checklist'), t(r.item_label || label(r.item_key)), who(r.patient_id), `${t(r.done_by)} ${when(r.done_local || r.done_at)}`.trim()]);
}

/** A scene diagram drawn as SVG, shown as an image so nothing in it can run. */
function sceneImg(svgText) {
  try {
    const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
    return h('img', { class: 'cf-scene', src: url, alt: 'Scene diagram' });
  } catch (_) { return null; }
}

// ---------------------------------------------------------------- the season risk report
const pct = (v) => (v === null || v === undefined ? '–' : `${v}%`);
const num = (v) => (v === null || v === undefined ? '–' : Number(v).toLocaleString('en-US'));
const tile = (big, small, note) => h('div', { class: 'cf-tile' }, h('b', null, big), h('span', null, small), note ? h('small', null, note) : null);
const change = (a, b) => {
  if (a === null || a === undefined || b === null || b === undefined || !b) return null;
  const d = Math.round(((a - b) / b) * 100);
  return d === 0 ? 'same as last season' : `${Math.abs(d)}% ${d < 0 ? 'lower' : 'higher'} than last season`;
};

export function riskDoc(r, { header = null } = {}) {
  const inj = r.injuries || {}; const last = r.last_season || {}; const cmp = last.to_date || last.full || {};
  const d = r.documentation || {}; const rf = r.red_flags || {}; const si = r.staff_injuries || {}; const co = r.compliance || {};
  return h('article', { class: 'cf-doc cf-risk' },
    header,
    h('header', { class: 'cf-head' },
      h('p', { class: 'cf-resort' }, (r.resort && (r.resort.legal_name || r.resort.name)) || ''),
      h('h1', null, `Season risk report, ${r.season}`),
      h('p', { class: 'muted' }, `${day(r.period.from)} to ${day(r.period.to)}${r.period.partial ? ' (season to date)' : ''}. Made ${when(r.made_at)}. Counts only: no patient is named.`)),
    sec('Injuries and visits',
      h('div', { class: 'cf-tiles' },
        tile(num(inj.visits), 'Visits'),
        tile(num(inj.patients), 'Patients seen'),
        tile(inj.per_1000 === null || inj.per_1000 === undefined ? '–' : String(inj.per_1000), 'Per 1,000 visits', change(inj.per_1000, cmp.per_1000)),
        r.network ? tile(String(r.network.per_1000 ?? '–'), 'Network per 1,000', `${r.network.mountains} other mountains`) : null),
      tbl(['', `This season${r.period.partial ? ' to date' : ''}`, last.to_date ? `${last.season}, same dates` : null, `${last.season}, full season`].filter((x) => x !== null),
        [['Patients', num(inj.patients), last.to_date ? num(last.to_date.patients) : null, num(last.full && last.full.patients)].filter((x) => x !== null),
          ['Visits', num(inj.visits), last.to_date ? num(last.to_date.visits) : null, num(last.full && last.full.visits)].filter((x) => x !== null),
          ['Per 1,000 visits', t(inj.per_1000) || '–', last.to_date ? (t(last.to_date.per_1000) || '–') : null, t(last.full && last.full.per_1000) || '–'].filter((x) => x !== null)]),
      r.network_note ? h('p', { class: 'muted small' }, r.network_note) : null,
      !inj.visits ? h('p', { class: 'muted small' }, 'No visit counts are recorded for this season, so there is no rate per 1,000 visits.') : null),
    sec('Documentation',
      h('div', { class: 'cf-tiles' },
        tile(d.score === null || d.score === undefined ? '–' : `${d.score}%`, 'Documentation score', change(d.score, (r.documentation_last_season || {}).score)),
        tile(pct(d.on_time_pct), `Signed off within ${(d.rules && d.rules.on_time_hours) || 24} hours`),
        tile(num(d.reports), 'Reports signed off'),
        tile(num(d.reviews_overdue), 'Reviews overdue')),
      h('p', { class: 'muted small' }, 'The documentation score is the share of the items the patrol requires on a report that were answered (N/A with a reason counts as answered). An item approved with an exception still counts as missing.')),
    sec('Serious and sensitive cases',
      h('div', { class: 'cf-tiles' },
        tile(num(rf.cases), 'Red-flag cases', 'Serious or critical, a lift, a minor, legal hold, or a claim'),
        tile(rf.cases ? `${rf.management_told} of ${rf.cases}` : '–', 'Management told'),
        tile(rf.cases ? `${rf.insurer_told} of ${rf.cases}` : '–', 'Insurer told')),
      tbl(['Kind', 'Cases'], (rf.by_kind || []).map((k) => [k.label, String(k.n)]))),
    sec('Staff injuries',
      h('div', { class: 'cf-tiles' }, tile(num(si.total), 'Logged'), tile(num(si.recordable), 'Recordable'), tile(num(si.days_away), 'Days away'), tile(num(si.restricted), 'Restricted duty'))),
    [co.kits, co.aeds, co.equipment].some((x) => x && x.total) ? sec('Kits and equipment today',
      h('div', { class: 'cf-tiles' },
        co.kits && co.kits.total ? tile(`${co.kits.ready} of ${co.kits.total}`, 'First-aid kits ready', [co.kits.check_due ? `${co.kits.check_due} check due` : null, co.kits.expired ? `${co.kits.expired} with expired items` : null].filter(Boolean).join(', ') || null) : null,
        co.aeds && co.aeds.total ? tile(`${co.aeds.ready} of ${co.aeds.total}`, 'AEDs ready', co.aeds.pads_or_battery_expired ? `${co.aeds.pads_or_battery_expired} with expired pads or battery` : null) : null,
        co.equipment && co.equipment.total ? tile(`${co.equipment.in_service} of ${co.equipment.total}`, 'Rescue equipment in service', co.equipment.attention ? `${co.equipment.attention} need attention` : null) : null)) : null,
    r.attractions && r.attractions.length ? sec('Cases at attractions',
      tbl(['Attraction', 'Cases', 'Patients'], r.attractions.map((a) => [`${a.name} (${a.type_label})`, String(a.cases), String(a.patients)]))) : null,
    inj.breakdowns && Object.keys(inj.breakdowns).length ? sec('Patients by', h('div', { class: 'cf-breakdowns' }, Object.values(inj.breakdowns).filter((b) => b.cells.length).map((b) => h('div', null, h('h3', null, b.title), tbl(['', 'Patients', 'Share'], b.cells.map((c) => [c.label, String(c.n), c.pct === null || c.pct === undefined ? '' : `${Math.round(c.pct)}%`])))))) : null,
    h('footer', { class: 'cf-foot' }, h('b', null, 'Not legal advice. '), 'Prepared from the mountain\'s own patrol records for its insurance broker and underwriters. Figures are counts and rates only; no patient is named. Ask the mountain about anything here.'));
}
