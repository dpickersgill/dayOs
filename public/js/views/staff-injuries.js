// Staff and schedule > Injuries: the owner's private staff injury register, with the fields of OSHA's Form 300 (the
// log) and Form 301 (the incident report), and the year's summary in the Form 300A layout. Patrol cases where the
// patient is staff or a volunteer on duty appear by themselves; anything else is added here. Only the owner and those
// the owner names can open it, and every look is logged.
import { get, post, patch, put, download } from '../api.js';
import { h, clear, input, select, field, button, toast, formDialog, dialog, table, empty, errorBox, state, fmtDate, nowInput } from '../ui.js';

const TONE = { death: 'bad', days_away: 'bad', restricted: 'warn', other_recordable: 'warn', not_recordable: 'neutral' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function drawInjuries(box) {
  let year = null;
  const body = h('div');
  clear(box).append(body);
  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading the register…'));
    try { draw(await get(`/staff-injuries${year ? `?year=${year}` : ''}`)); } catch (err) { clear(body).append(errorBox(err)); }
  }
  function draw(r) {
    year = r.year;
    const words = (list, k) => (list.find((x) => x[0] === k) || [k, k])[1];
    const pick = select(r.years.map((y) => [y, String(y)]), r.year, { 'aria-label': 'Year' });
    pick.addEventListener('change', () => { year = Number(pick.value); load(); });
    clear(body).append(
      h('div', { class: 'week-bar' },
        h('div', null, h('h2', { class: 'week-title' }, 'Staff injuries'),
          h('p', { class: 'muted' }, 'Work injuries and illnesses, private to the owner and those the owner names. Patrol cases where the patient is staff or a volunteer on duty appear here by themselves. Each record has the fields of the OSHA log.')),
        h('div', { class: 'week-actions' }, pick,
          button('Add a record', () => recordDialog(r, null, load), { kind: 'primary' }),
          button('Year summary', () => summaryDialog(r.year)),
          button('Print the log', () => printLog(r)),
          button('Download the log', () => download(`/staff-injuries/log.csv?year=${r.year}`, `osha-300-log-${r.year}.csv`)),
          r.is_owner ? button('Who can see this', () => accessDialog(load)) : null)),
      r.data.length ? table([
        { head: 'No.', cell: (x) => h('b', null, x.number) },
        { head: 'Employee', cell: (x) => h('span', null, x.employee_name, x.privacy_case ? h('small', { class: 'muted' }, ' (privacy case)') : null, x.volunteer ? h('small', { class: 'muted' }, ' (volunteer)') : null) },
        { head: 'Date', cell: (x) => fmtDate(x.occurred_at) },
        { head: 'Where', cell: (x) => x.place || '' },
        { head: 'Outcome', cell: (x) => (x.outcome ? state(words(r.outcomes, x.outcome), TONE[x.outcome]) : state('Not decided', 'warn')) },
        { head: 'Days away', num: true, cell: (x) => (x.days_away ? String(x.days_away) : '') },
        { head: 'Restricted', num: true, cell: (x) => (x.days_restricted ? String(x.days_restricted) : '') },
        { head: 'From', cell: (x) => (x.incident_id ? h('a', { href: `#/patrol/case/${x.incident_id}` }, `Patrol ${x.case_number || ''}`) : 'Added here') },
        { head: '', actions: true, cell: (x) => button('Open', async () => recordDialog(r, await get(`/staff-injuries/${x.id}`), load), { small: true }) },
      ], r.data) : empty(`No staff injuries recorded for ${r.year}.`),
      h('p', { class: 'muted small' }, 'Whether your mountain must keep the OSHA log depends on its size and industry. Ask your insurer if you are not sure. Only cases with an outcome other than "Not recordable" go on the log and the summary.'));
  }
  await load();
}

/** One record: the log line (Form 300) and the incident details (Form 301). */
function recordDialog(r, rec, onDone) {
  const x = rec || { employee_name: '', occurred_at: nowInput().replace('T', ' '), kind: 'injury', outcome: null, days_away: 0, days_restricted: 0 };
  const i = (name, attrs = {}) => input({ name, value: x[name] ?? '', ...attrs });
  const chk = (name, text) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name, checked: Boolean(x[name]) }), text);
  const text = (name, rows = 3, max = 1000) => h('textarea', { name, rows, maxlength: max }, x[name] || '');
  formDialog(rec ? `Staff injury ${rec.number}` : 'Add a staff injury', h('div', { class: 'stack' },
    rec && rec.incident_id ? h('p', { class: 'muted small' }, 'From patrol case ', h('a', { href: `#/patrol/case/${rec.incident_id}` }, rec.case_number || 'on file'), '. The injury and treatment details stay on the case.') : null,
    h('h3', null, 'The log (Form 300)'),
    h('div', { class: 'form' },
      field('Employee', i('employee_name', { required: true, maxlength: 150 })), field('Job title', i('job_title', { maxlength: 100 })),
      field('Date and time', input({ type: 'datetime-local', name: 'occurred_at', required: true, value: String(x.occurred_at).slice(0, 16).replace(' ', 'T') })),
      field('Where it happened', i('place', { maxlength: 150 })),
      h('div', { class: 'wide' }, field('What happened', text('description', 2, 500), 'The injury or illness, the part of the body, and what caused it')),
      field('Injury or illness', select(r.kinds, x.kind || 'injury', { name: 'kind' })),
      field('Outcome', select([['', 'Not decided yet'], ...r.outcomes], x.outcome || '', { name: 'outcome' })),
      field('Days away from work', i('days_away', { type: 'number', min: 0, max: 180 }), 'Count at most 180'),
      field('Days on restricted work', i('days_restricted', { type: 'number', min: 0, max: 180 })),
      field('Date of death', input({ type: 'date', name: 'died_on', value: x.died_on ? String(x.died_on).slice(0, 10) : '' }), 'Only if the employee died'),
      h('div', { class: 'wide' }, chk('privacy_case', 'Privacy case: show "Privacy case" instead of the name on the log'), chk('volunteer', 'A volunteer'))),
    h('h3', null, 'The incident report (Form 301)'),
    h('div', { class: 'form' },
      field('Started work at', input({ type: 'time', name: 'began_work_at', value: x.began_work_at ? String(x.began_work_at).slice(0, 5) : '' })),
      field('Object or substance', i('object', { maxlength: 255 })),
      h('div', { class: 'wide' }, field('What the employee was doing just before', text('activity', 2, 500))),
      h('div', { class: 'wide' }, field('How it happened', text('how_happened', 3, 1000))),
      field('Treated by (doctor or other professional)', i('treated_by', { maxlength: 150 })), field('Where treated, if away from work', i('facility', { maxlength: 200 })),
      h('div', { class: 'wide' }, chk('er', 'Seen in an emergency room'), chk('overnight', 'Kept in hospital overnight as an in-patient'))),
    rec ? field('Status', select([['open', 'Open'], ['closed', 'Closed']], x.status || 'open', { name: 'status' })) : null,
    h('p', { class: 'muted small' }, 'OSHA: a death must be reported within 8 hours, and an in-patient hospital admission, an amputation or the loss of an eye within 24 hours (1-800-321-6742 or osha.gov/report).')), async (fd) => {
    const s = (k) => String(fd.get(k) ?? '').trim();
    const body = {
      employee_name: s('employee_name'), job_title: s('job_title') || null, occurred_at: s('occurred_at'), place: s('place') || null, description: s('description') || null,
      kind: s('kind'), outcome: s('outcome') || null, days_away: Number(s('days_away') || 0), days_restricted: Number(s('days_restricted') || 0), died_on: s('died_on') || null,
      privacy_case: Boolean(fd.get('privacy_case')), volunteer: Boolean(fd.get('volunteer')), began_work_at: s('began_work_at') || null, object: s('object') || null,
      activity: s('activity') || null, how_happened: s('how_happened') || null, treated_by: s('treated_by') || null, facility: s('facility') || null, er: Boolean(fd.get('er')), overnight: Boolean(fd.get('overnight')),
      ...(rec ? { status: s('status') } : {}),
    };
    if (rec) { await patch(`/staff-injuries/${rec.id}`, body); toast('Record saved'); } else { await post('/staff-injuries', body); toast('Record added'); }
    await onDone();
  }, { submitText: rec ? 'Save' : 'Add record', wide: true });
}

/** The year in the Form 300A layout, with the hours worked and the average number of employees. */
async function summaryDialog(year) {
  const s = await get(`/staff-injuries/summary?year=${year}`);
  const hours = input({ type: 'number', min: 0, value: s.hours_worked ?? '', placeholder: String(s.from_clock.hours) });
  const avg = input({ type: 'number', min: 0, value: s.avg_employees ?? '', placeholder: String(s.from_clock.avg_employees) });
  const by = input({ maxlength: 150, value: s.certified_by || '', placeholder: 'Name and title of the company executive' });
  const on = input({ type: 'date', value: s.certified_at || '' });
  const kinds = [['injury', 'Injuries'], ['skin', 'Skin disorders'], ['respiratory', 'Respiratory conditions'], ['poisoning', 'Poisonings'], ['hearing', 'Hearing loss'], ['other_illness', 'All other illnesses']];
  const dlg = dialog(`${year} summary (Form 300A)`, [
    h('dl', { class: 'cond-list' },
      ...[['Deaths', s.deaths], ['Cases with days away from work', s.days_away_cases], ['Cases with job transfer or restriction', s.restricted_cases], ['Other recordable cases', s.other_cases],
        ['Total days away from work', s.days_away], ['Total days of job transfer or restriction', s.days_restricted], ...kinds.map(([k, t]) => [t, s.kinds[k]])].flatMap(([k, v]) => [h('dt', null, k), h('dd', null, String(v))])),
    h('div', { class: 'form' },
      field('Total hours worked by all employees', hours, `From the time clock: ${s.from_clock.hours.toLocaleString('en-US')} hours. Leave blank to use it.`),
      field('Average number of employees', avg, `From the time clock: about ${s.from_clock.avg_employees} a week, over ${s.from_clock.weeks} weeks worked.`),
      field('Certified by', by), field('Certified on', on)),
    h('p', { class: 'muted small' }, 'Volunteers and staff not on the time clock are not in the time clock figures; add them in if they count for your mountain. The summary is posted from February 1 to April 30 of the next year.'),
    h('div', { class: 'footer row' },
      button('Print', () => printSummary({ ...s, hours_worked: hours.value ? Number(hours.value) : s.from_clock.hours, avg_employees: avg.value ? Number(avg.value) : s.from_clock.avg_employees, certified_by: by.value, certified_at: on.value }, kinds)),
      button('Save', async () => {
        await put(`/staff-injuries/years/${year}`, { hours_worked: hours.value ? Number(hours.value) : null, avg_employees: avg.value ? Number(avg.value) : null, certified_by: by.value.trim() || null, certified_at: on.value || null });
        toast('Summary saved'); dlg.close();
      }, { kind: 'primary' }))], { wide: true });
}

function openPrint(title, html) {
  const w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups to print', 'warn'); return; }
  w.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:12px/1.4 system-ui,sans-serif;margin:24px;color:#111}h1{font-size:18px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:4px 6px;text-align:left;vertical-align:top}th{background:#eee}td.n{text-align:right}</style></head><body>${html}</body></html>`);
  w.document.close(); w.focus(); w.print();
}

function printLog(r) {
  const words = (list, k) => (list.find((x) => x[0] === k) || [k, ''])[1];
  const list = r.data.filter((x) => x.outcome && x.outcome !== 'not_recordable').sort((a, b) => a.seq - b.seq);
  openPrint(`Log of work-related injuries and illnesses, ${r.year}`, `<h1>Log of work-related injuries and illnesses, ${r.year}</h1><p>Laid out like OSHA Form 300.</p>
    <table><tr><th>Case no.</th><th>Employee</th><th>Job title</th><th>Date</th><th>Where</th><th>Description</th><th>Outcome</th><th>Days away</th><th>Restricted</th><th>Injury or illness</th></tr>
    ${list.map((x) => `<tr><td>${esc(x.number)}</td><td>${esc(x.privacy_case ? 'Privacy case' : x.employee_name)}</td><td>${esc(x.job_title)}</td><td>${esc(fmtDate(x.occurred_at))}</td><td>${esc(x.place)}</td><td>${esc(x.description)}</td><td>${esc(words(r.outcomes, x.outcome))}</td><td class="n">${x.days_away || ''}</td><td class="n">${x.days_restricted || ''}</td><td>${esc(words(r.kinds, x.kind))}</td></tr>`).join('') || '<tr><td colspan="10">No recordable cases.</td></tr>'}</table>`);
}

function printSummary(s, kinds) {
  const row = (k, v) => `<tr><th>${esc(k)}</th><td class="n">${esc(v)}</td></tr>`;
  openPrint(`Summary of work-related injuries and illnesses, ${s.year}`, `<h1>Summary of work-related injuries and illnesses, ${s.year}</h1><p>Laid out like OSHA Form 300A.</p><table>
    ${row('Deaths', s.deaths)}${row('Cases with days away from work', s.days_away_cases)}${row('Cases with job transfer or restriction', s.restricted_cases)}${row('Other recordable cases', s.other_cases)}
    ${row('Total days away from work', s.days_away)}${row('Total days of job transfer or restriction', s.days_restricted)}${kinds.map(([k, t]) => row(t, s.kinds[k])).join('')}
    ${row('Annual average number of employees', s.avg_employees)}${row('Total hours worked by all employees last year', Number(s.hours_worked).toLocaleString('en-US'))}
    ${row('Certified by', s.certified_by || '')}${row('Date', s.certified_at || '')}</table>`);
}

async function accessDialog(onDone) {
  const r = await get('/staff-injuries/access/users');
  const boxes = r.data.map((u) => ({ u, el: h('input', { type: 'checkbox', checked: u.granted }) }));
  formDialog('Who can see the register', h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'You, the owner, can always see it. Choose anyone else who should, such as your general manager or the person who handles workers’ comp. Every look is logged.'),
    boxes.length ? h('div', { class: 'member-list' }, boxes.map(({ u, el }) => h('label', { class: 'chk' }, el, h('span', null, u.login, h('small', { class: 'muted' }, ` ${u.role}`))))) : empty('No other logins yet.')), async () => {
    await put('/staff-injuries/access', { user_ids: boxes.filter((b) => b.el.checked).map((b) => b.u.id) });
    toast('Saved');
    await onDone();
  }, { submitText: 'Save' });
}
