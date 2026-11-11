// The ski area's view (free, read only): one day's patrol in numbers and its approved reports, one day's ski school in
// numbers, or both when a mountain somehow has both on. Opening a patrol report shows the copy frozen when it was
// approved, and is recorded in the audit log. Ski school shows counts only, never a family's name.

import { get } from '../api.js';
import { h, clear, ctx, input, field, button, table, dialog, errorBox, empty, label, state, fmtDate, fmtDateTime, todayStr } from '../ui.js';

const CAT = { injury: 'Injury', collision: 'Collision', lost_person: 'Lost person', equipment: 'Equipment', medical: 'Medical', conduct: 'Conduct', other: 'Other' };
const SEV = { minor: 'Minor', moderate: 'Moderate', serious: 'Serious', critical: 'Critical' };
const tally = (obj, names) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${names[k] || label(k)} ${n}`).join(', ') || 'None';
const clock = (t) => { const [hh, mm] = t.split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };

export async function render(root) {
  const today = todayStr(ctx.tz);
  const date = input({ type: 'date', name: 'date', value: today, max: today, 'aria-label': 'Day' });
  const summary = h('div', { class: 'stack', 'data-area': 'summary' });
  const schoolBox = h('div', { class: 'stack', 'data-area': 'school' });
  const reports = h('div', { class: 'stack', 'data-area': 'reports' });
  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Summary'),
    h('p', { class: 'muted' }, 'Your mountain\'s day in numbers, read only.'))),
  h('div', { class: 'row' }, field('Day', date)), summary, schoolBox, reports);
  let patrolOn = false;
  date.addEventListener('change', async () => { await drawSummary(); await drawReports(); });

  async function drawSummary() {
    clear(summary); clear(schoolBox);
    let s;
    try { s = await get(`/area/summary?date=${date.value || today}`); } catch (err) { summary.append(errorBox(err)); return; }
    patrolOn = Boolean(s.calls);
    if (patrolOn) drawPatrol(s);
    if (s.school) drawSchool(s);
  }

  function drawPatrol(s) {
    const tile = (n, what) => h('div', { class: 'stat' }, h('strong', null, String(n)), h('span', null, what));
    summary.append(h('section', { class: 'panel stack' },
      h('h2', null, 'Patrol: ', s.today ? 'Today' : fmtDate(s.date)),
      h('div', { class: 'stats' },
        tile(s.on_duty, 'patrollers on duty'), tile(s.runs_checked, 'runs checked'), tile(s.calls.total, s.calls.total === 1 ? 'call' : 'calls'),
        tile(s.calls.transported, 'transported'), tile(s.reports.approved, 'reports approved'), tile(s.reports.waiting, 'reports in progress')),
      h('p', null, h('b', null, 'Calls by kind: '), tally(s.calls.by_category, CAT)),
      h('p', null, h('b', null, 'By severity: '), tally(s.calls.by_severity, SEV)),
      s.today ? (s.holds.length ? h('div', null, h('b', null, 'Runs on hold: '), s.holds.map((x) => `${x.name}${x.closure_reason ? ` (${x.closure_reason})` : ''}`).join(', ')) : h('p', null, h('b', null, 'Runs on hold: '), 'None')) : '',
      h('p', { class: 'muted small' }, `Season ${s.season} so far: ${s.season_calls.length ? s.season_calls.map((x) => `${CAT[x.category] || label(x.category)} ${x.n}`).join(', ') : 'no calls yet'}.`)));
  }

  function drawSchool(s) {
    const sc = s.school;
    const tile = (n, what) => h('div', { class: 'stat' }, h('strong', null, String(n)), h('span', null, what));
    schoolBox.append(h('section', { class: 'panel stack' },
      h('h2', null, 'Ski school: ', s.today ? 'Today' : fmtDate(s.date)),
      h('div', { class: 'stats' },
        tile(sc.lessons, sc.lessons === 1 ? 'lesson' : 'lessons'), tile(sc.students, sc.students === 1 ? 'student booked' : 'students booked'),
        tile(sc.waivers.on_file, `of ${sc.waivers.of} with a waiver on file`)),
      sc.slots.length ? h('div', null, h('b', null, 'Lessons by time and level: '),
        sc.slots.map((g) => `${clock(g.time)} ${label(g.level)} (${g.discipline === 'ski' ? 'ski' : label(g.discipline)}): ${g.students} of ${g.sessions === 1 ? '1 lesson' : `${g.sessions} lessons`}`).join(', ')) : h('p', { class: 'muted' }, 'No lessons scheduled.'),
      h('p', null, h('b', null, 'Instructors rostered today: '), sc.instructors.length ? sc.instructors.join(', ') : 'None listed'),
      h('p', { class: 'muted small' }, 'Counts only. No family names, contact details or lesson prices.')));
  }

  async function drawReports() {
    clear(reports);
    if (!patrolOn) return; // Patrol's own reports; nothing to show when this mountain has no Patrol
    let data;
    try { ({ data } = await get('/area/reports')); } catch (err) { reports.append(errorBox(err)); return; }
    reports.append(h('section', { class: 'panel stack' }, h('h2', null, 'Approved reports'),
      data.length ? table([
        { head: 'Case', cell: (r) => h('strong', null, r.case_number) },
        { head: 'When', cell: (r) => fmtDateTime(r.occurred_at) },
        { head: 'Kind', cell: (r) => CAT[r.category] || label(r.category) },
        { head: 'Severity', cell: (r) => state(SEV[r.severity] || r.severity, r.severity === 'critical' || r.severity === 'serious' ? 'warn' : 'neutral') },
        { head: 'Where', cell: (r) => r.location },
        { head: '', actions: true, cell: (r) => button('Open', () => openReport(r.id), { small: true, label: `Open ${r.case_number}` }) },
      ], data) : empty('No approved reports yet.')));
  }

  await drawSummary();
  await drawReports();
}

const live = (x) => !x.voided_at;
const kv = (pairs) => h('table', { class: 'kv' }, h('tbody', null, ...pairs.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, String(v))))));

/** One approved report, as frozen at approval. Struck-out entries (entered in error) are shown struck, with the reason. */
async function openReport(id) {
  let r;
  try { r = await get(`/area/reports/${id}`); } catch (err) { dialog('Report', errorBox(err)); return; }
  const c = r.case;
  const struck = (x, text) => (live(x) ? h('li', null, text) : h('li', { class: 'muted' }, h('s', null, text), ` (entered in error${x.void_reason ? `: ${x.void_reason}` : ''})`));
  const patient = (p) => h('section', { class: 'stack tight' },
    h('h3', null, `${p.first_name} ${p.last_name}`),
    kv([['Age', p.age_years], ['Sex', p.sex && p.sex !== 'unknown' ? label(p.sex) : ''], ['Activity', p.activity ? label(p.activity) : ''], ['Helmet', p.helmet !== 'unknown' ? label(p.helmet) : ''],
      ['Chief complaint', p.chief_complaint], ['How it happened', p.mechanism], ['Assessment', p.assessment], ['Outcome', p.disposition ? label(p.disposition) : ''], ['Taken to', p.destination]]),
    p.injuries && p.injuries.length ? h('div', null, h('b', null, 'Injuries'), h('ul', { class: 'plain' }, ...p.injuries.map((x) => struck(x, `${label(x.injury_type)}, ${label(x.body_region)}${x.side && x.side !== 'na' ? ` (${x.side})` : ''}${x.notes ? `: ${x.notes}` : ''}`)))) : '',
    p.treatments && p.treatments.length ? h('div', null, h('b', null, 'Treatment'), h('ul', { class: 'plain' }, ...p.treatments.map((x) => struck(x, `${fmtDateTime(x.performed_at)} ${label(x.kind)}${x.medication ? ` ${x.medication} ${x.dose || ''} ${x.route || ''}` : ''}${x.description ? `: ${x.description}` : ''}`)))) : '',
    p.vitals && p.vitals.length ? h('div', null, h('b', null, 'Vitals'), h('ul', { class: 'plain' }, ...p.vitals.map((v) => struck(v, `${fmtDateTime(v.taken_at)}: ${[v.pulse && `pulse ${v.pulse}`, v.resp && `breathing ${v.resp}`, v.bp_sys && `BP ${v.bp_sys}/${v.bp_dia || '?'}`, v.spo2 && `SpO2 ${v.spo2}%`, v.gcs && `GCS ${v.gcs}`, v.pain !== null && v.pain !== undefined && `pain ${v.pain}/10`].filter(Boolean).join(', ')}`)))) : '');
  dialog(`Case ${r.case_number}`, h('div', { class: 'stack', 'data-area': 'report' },
    h('p', { class: 'muted small' }, `Approved report, version ${r.version_no}, approved ${fmtDateTime(r.approved_at)}. Confidential patient information: share it only as your records policy allows. Opening it is recorded.`),
    kv([['When', fmtDateTime(c.occurred_at)], ['Where', c.location], ['Run', c.trail], ['Kind', CAT[c.category] || c.category], ['Severity', SEV[c.severity] || c.severity], ['Summary', c.summary]]),
    c.narrative ? h('div', null, h('b', null, 'What happened'), h('p', null, c.narrative)) : '',
    ...(c.patients || []).filter(live).map(patient),
    (c.responders || []).filter(live).length ? h('p', null, h('b', null, 'Responders: '), c.responders.filter(live).map((x) => `${x.first_name} ${x.last_name} (${label(x.role)})`).join(', ')) : '',
    h('div', { class: 'row no-print' }, button('Print or save as PDF', () => window.print(), { small: true }))), { wide: true });
}
