// The monthly report for the manager and council (release 2026.11.20, workstream "money"): a municipality's month of
// public works on one page to print or save as a PDF, and the same as a spreadsheet. Work orders and their hours and
// cost by department, job type and fund; response times for resident requests against the standards; the streets with
// the most requests; programs; bulk pickup; street notices; building checks; the fleet; the largest jobs with their
// photos; and the Liquid Fuels fund by street for the year to date (for PennDOT's MS-965). It is a public record: no
// resident's name, phone, email or house number (lib/monthreport.js). Managers and owners.
//   #/monthreport?month=2026-10
import { get, download, fetchBlob } from '../api.js';
import { h, clear, button, input, table, money, empty, errorBox, hashParam, withHashParam, todayStr, fmtDate, label, isMuni } from '../ui.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const lastMonth = () => { const t = todayStr(); const y = Number(t.slice(0, 4)); const mo = Number(t.slice(5, 7)); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`; };
const hrs = (n) => (n ? `${Math.round(n * 10) / 10}` : '0');
const pct = (p) => (p === null || p === undefined ? 'No target' : `${p}%`);

export async function render(root) {
  if (!isMuni()) { root.append(empty('The monthly report is for a municipality.')); return; }
  const wanted = hashParam('month');
  const month = input({ type: 'month', value: /^\d{4}-\d{2}$/.test(wanted || '') ? wanted : lastMonth(), max: todayStr().slice(0, 7), 'aria-label': 'Month' });
  const body = h('div', { class: 'month-report stack' });
  root.append(
    h('div', { class: 'page-head no-print' },
      h('div', null, h('h1', null, 'Monthly report'), h('p', { class: 'page-note' }, 'One month of public works for the manager and council: work done, hours, cost by department and fund, and response times. Print it or save it as a PDF.')),
      h('div', { class: 'actions row' }, h('label', { class: 'row tight' }, 'Month ', month),
        button('Print', () => window.print(), { kind: 'primary', small: true }),
        button('Download spreadsheet', () => download(`/assets/month-report.csv?month=${month.value}`, `monthly-report-${month.value}.csv`), { small: true }))),
    body);
  async function load() {
    history.replaceState(null, '', withHashParam('month', month.value));
    clear(body).append(h('p', { class: 'loading', role: 'status' }, 'Adding up the month…'));
    let r;
    try { r = await get(`/assets/month-report?month=${month.value}`); } catch (err) { clear(body).append(errorBox(err)); return; }
    clear(body).append(...draw(r));
  }
  month.addEventListener('change', () => { if (month.value) load(); });
  await load();
}

const section = (title, ...kids) => h('section', { class: 'panel stack report-part' }, h('h2', null, title), ...kids);
const stat = (n, text) => h('div', { class: 'stat' }, h('b', null, String(n)), h('span', null, text));
const costCols = [
  { head: 'Opened', num: true, cell: (x) => x.opened },
  { head: 'Completed', num: true, cell: (x) => x.closed },
  { head: 'Labor hours', num: true, cell: (x) => hrs(x.labor_hours) },
  { head: 'Equipment hours', num: true, cell: (x) => hrs(x.equipment_hours) },
  { head: 'Labor', num: true, cell: (x) => money(x.labor_cents) },
  { head: 'Equipment', num: true, cell: (x) => money(x.equipment_cents) },
  { head: 'Parts and materials', num: true, cell: (x) => money(x.parts_cents + x.materials_cents) },
  { head: 'Outside', num: true, cell: (x) => money(x.outside_cents) },
  { head: 'Cost', num: true, cell: (x) => h('b', null, money(x.total_cents)) },
];

function draw(r) {
  const t = r.totals;
  const out = [
    h('header', { class: 'report-head' }, h('p', { class: 'muted' }, r.town), h('h2', null, `Public works, ${monthName(r.month)}`), h('p', { class: 'muted small' }, `${fmtDate(r.from)} to ${fmtDate(r.to)}. A public record: no resident's name, phone, email or house number.`)),
    h('div', { class: 'stats' },
      stat(t.closed, 'work orders completed'), stat(t.opened, 'opened'), stat(t.open_at_end, 'still open at the month\'s end'),
      stat(hrs(t.labor_hours), 'hours of labor'), stat(hrs(t.equipment_hours), 'hours of equipment'), stat(money(t.total_cents), 'cost'),
      r.requests ? stat(pct(r.requests.fix.pct), 'of requests fixed within target') : null),
  ];
  // Highlights first: what the council will ask about.
  if (r.highlights.length) {
    out.push(section('Largest jobs', h('div', { class: 'highlights' }, r.highlights.map((x) => {
      const pics = h('div', { class: 'photo-strip' });
      for (const p of x.photos) {
        const img = h('img', { alt: p.stage ? `${label(p.stage)} photo` : 'Photo', loading: 'lazy' });
        fetchBlob(`/assets/month-report/photos/${p.kind}/${p.id}`).then((b) => { img.src = URL.createObjectURL(b); }).catch(() => img.remove());
        pics.append(h('figure', null, img, p.stage ? h('figcaption', { class: 'muted small' }, label(p.stage)) : null));
      }
      return h('article', { class: 'highlight' }, h('h3', null, x.title), h('p', { class: 'muted small' }, `${x.department} · ${x.category} · completed ${fmtDate(x.completed_on)}`),
        x.resolution ? h('p', null, x.resolution) : null,
        h('p', null, h('b', null, money(x.total_cents)), ` · ${hrs(x.labor_hours)} hours of labor${x.equipment_hours ? `, ${hrs(x.equipment_hours)} of equipment` : ''}`), x.photos.length ? pics : null);
    }))));
  }
  out.push(section('Work by department', r.by_department.length ? table([{ head: 'Department', cell: (x) => x.name }, ...costCols], r.by_department) : empty('No work orders this month.')));
  out.push(section('Work by type of job', r.by_category.length ? table([{ head: 'Type of job', cell: (x) => x.name }, ...costCols], r.by_category) : empty('No work orders this month.')));
  if (r.by_fund.length) {
    out.push(section('Cost by fund', table([{ head: 'Fund', cell: (x) => x.name }, { head: 'Labor hours', num: true, cell: (x) => hrs(x.labor_hours) }, ...costCols.slice(4)], r.by_fund),
      r.department_fund.length ? h('details', null, h('summary', null, 'Each department by fund'), table([{ head: 'Department', cell: (x) => x.department }, { head: 'Fund', cell: (x) => x.fund }, { head: 'Labor hours', num: true, cell: (x) => hrs(x.hours) }, { head: 'Cost', num: true, cell: (x) => money(x.total_cents) }], r.department_fund)) : null));
  }
  if (r.requests) {
    const q = r.requests;
    out.push(section('Resident requests',
      h('p', null, `${q.received} received, ${q.fixed} fixed, ${q.open} still open. Made safe within target: ${pct(q.made_safe.pct)} (${q.made_safe.met} of ${q.made_safe.n}). Fixed within target: ${pct(q.fix.pct)} (${q.fix.met} of ${q.fix.n}).`),
      q.by_category.length ? table([
        { head: 'Category', cell: (c) => c.category }, { head: 'Requests', num: true, cell: (c) => c.requests },
        { head: 'Made safe in time', num: true, cell: (c) => (c.safe_n ? `${c.safe_pct}% (${c.safe_met} of ${c.safe_n})` : 'No target') },
        { head: 'Fixed in time', num: true, cell: (c) => (c.fix_n ? `${c.fix_pct}% (${c.fix_met} of ${c.fix_n})` : 'No target') },
      ], q.by_category) : null,
      q.top_streets.length ? h('div', { class: 'stack tight' }, h('h3', null, 'Streets with the most requests'), h('ol', { class: 'top-streets' }, q.top_streets.map((s) => h('li', null, `${s.street}: ${s.count}`)))) : null));
  }
  if (r.liquid_fuels) {
    const lf = r.liquid_fuels;
    out.push(section(`${lf.fund} by street, ${fmtDate(lf.from)} to ${fmtDate(lf.to)}`,
      h('p', { class: 'muted small' }, 'What work orders charged to this fund cost on each road this year, for the Liquid Fuels report (MS-965). Pick a street on each work order so it lands on the right road.'),
      lf.streets.length ? table([
        { head: 'Street', cell: (s) => s.street }, { head: 'Jobs', num: true, cell: (s) => s.jobs },
        { head: 'Labor', num: true, cell: (s) => money(s.labor_cents) }, { head: 'Equipment', num: true, cell: (s) => money(s.equipment_cents) },
        { head: 'Materials', num: true, cell: (s) => money(s.materials_cents) }, { head: 'Outside', num: true, cell: (s) => money(s.outside_cents) },
        { head: 'This month', num: true, cell: (s) => money(s.month_cents) }, { head: 'Year to date', num: true, cell: (s) => h('b', null, money(s.total_cents)) },
      ], lf.streets) : empty('Nothing charged to it this year yet.'),
      lf.streets.length ? h('p', { class: 'wo-total' }, h('b', null, `Total year to date: ${money(lf.total_cents)}`)) : null));
  }
  if (r.programs.length) {
    out.push(section('Programs', table([
      { head: 'Program', cell: (p) => p.name }, { head: 'Done', num: true, cell: (p) => `${p.done} of ${p.total}` }, { head: 'This month', num: true, cell: (p) => p.this_month },
      { head: 'Skipped', num: true, cell: (p) => p.skipped }, { head: 'Failed', num: true, cell: (p) => p.failed }, { head: 'Due', cell: (p) => (p.due_on ? fmtDate(p.due_on) : '') },
    ], r.programs)));
  }
  const small = [];
  if (r.bulk) small.push(h('div', null, h('h3', null, 'Bulk pickup'), h('p', null, `${r.bulk.bookings} bookings, ${r.bulk.items} items. ${r.bulk.picked_up} picked up, ${r.bulk.not_out} not out. ${money(r.bulk.revenue_cents)} collected.`)));
  small.push(h('div', null, h('h3', null, 'Street notices'), r.notices.sent ? h('ul', { class: 'plain' }, r.notices.list.map((x) => h('li', null, `${fmtDate(String(x.sent_at).slice(0, 10))}: ${x.title}`, h('span', { class: 'muted small' }, ` (${x.delivered} texts and emails)`)))) : h('p', { class: 'muted' }, 'None sent.')));
  if (r.buildings) small.push(h('div', null, h('h3', null, 'Building checks'), h('p', null, `${r.buildings.done} done this month. ${r.buildings.overdue} overdue now${r.buildings.never ? `, ${r.buildings.never} with no record yet` : ''}.`)));
  out.push(section('Residents and buildings', h('div', { class: 'pair' }, small)));
  if (r.fleet.length) {
    out.push(section('Fleet', table([
      { head: 'Vehicle or machine', cell: (a) => `${a.name}${a.tag ? ` (${a.tag})` : ''}` }, { head: 'Hours on jobs', num: true, cell: (a) => hrs(a.job_hours) },
      { head: 'Repairs', num: true, cell: (a) => a.repairs }, { head: 'Days out of service', num: true, cell: (a) => (a.out_of_service_days || '') },
      { head: 'Upkeep', num: true, cell: (a) => money(a.upkeep_cents) }, { head: 'Fuel', num: true, cell: (a) => money(a.fuel_cents) }, { head: 'Cost', num: true, cell: (a) => h('b', null, money(a.cost_cents)) },
    ], r.fleet), h('p', { class: 'muted small' }, 'Days out of service come from the time out of service recorded on each repair.')));
  }
  return out;
}
