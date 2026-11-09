// Money, Forecast data (owners and managers): shows that the morning snapshots are being collected for next season's
// demand forecast, pricing and staffing (lib/snapshots.js). Which days have snapshots, this morning's presales for the
// next 14 days beside the same days last year, and today's hourly wind. Counts and weather only, never a person.
import { get, put } from '../api.js';
import { h, svg, clear, table, state, input, field, button, toast, fail, fmtDate, empty, errorBox, loading } from '../ui.js';

const KINDS = [['presales', 'Presales'], ['forecast', 'Weather'], ['staffing', 'Staffing'], ['prices', 'Prices']];
const ROLE = { base: 'Base', summit: 'Summit', map_point: 'Map point' };
const hourText = (time) => { const hr = Number(String(time).slice(11, 13)); return `${hr % 12 || 12} ${hr < 12 ? 'AM' : 'PM'}`; };
const mph = (v) => (v === null || v === undefined ? 'not given' : `${Math.round(v)} mph`);

export async function forecastData(box) {
  const body = h('div', { class: 'stack fc-root' }, loading());
  box.append(h('p', { class: 'muted' }, 'Every morning the daily job writes down how the next days look: tickets, lessons and rentals sold ahead, the hourly weather forecast, staffing and the online prices. Next season’s forecast, pricing and staffing learn from it. It holds counts and weather only, never a guest or staff member.'), body);
  async function load() {
    let d;
    try { d = await get('/reports/forecast-data'); } catch (e) { clear(body).append(errorBox(e)); return; }
    clear(body).append(
      h('div', { class: 'figures' },
        h('div', { class: 'figure' }, h('strong', null, String(d.total)), h('span', null, 'Snapshots kept'), h('em', null, d.since ? `Since ${fmtDate(d.since)}` : 'None yet')),
        h('div', { class: 'figure' }, h('strong', null, String(d.rebuilt)), h('span', null, 'Rebuilt from history'), h('em', null, 'Filled in from past sales and weather'))),
      presales(d), wind(d), coverage(d), points(d, load));
  }
  await load();
}

// ---------------------------------------------------------------- presales: this year beside last year
function presales(d) {
  const sec = h('section', { class: 'stack', 'aria-labelledby': 'fc-pre' }, h('h3', { id: 'fc-pre' }, 'Sold ahead for the next 14 days'));
  const p = d.presales;
  if (!p) return sec.append(empty('No presales snapshot yet. The daily job takes the first one tomorrow morning.')), sec;
  if (p.stale) sec.append(h('p', null, state(`Today’s snapshot is not taken yet. Showing ${fmtDate(p.on_date)}.`, 'warn')));
  const top = Math.max(1, ...p.days.flatMap((x) => [x.sold, x.last_year ? x.last_year.sold : 0]));
  const pct = (v) => `${Math.max(0, (v / top) * 100)}%`;
  sec.append(
    h('p', { class: 'muted small' }, p.last_year_on
      ? 'Lift tickets, lessons and rentals sold so far for each day, beside the same weekday 52 weeks earlier as it stood the same number of days ahead.'
      : 'Lift tickets, lessons and rentals sold so far for each day. Last year shows here once there is a snapshot from 52 weeks ago (the backfill can rebuild it).'),
    h('div', { class: 'fc-legend', 'aria-hidden': 'true' }, h('span', null, h('i', { class: 'fc-key fc-now' }), 'This year'), p.last_year_on ? h('span', null, h('i', { class: 'fc-key fc-was' }), 'Last year') : null),
    h('ul', { class: 'fc-bars', 'aria-label': 'Sold ahead by day' }, p.days.map((x) => {
      const was = x.last_year;
      const said = `${fmtDate(x.date)}: ${x.sold} sold (${x.tickets} tickets, ${x.lessons} lessons, ${x.rentals} rentals)${was ? `; last year ${was.sold}` : ''}`;
      return h('li', { title: said, 'aria-label': said },
        h('span', { class: 'fc-day' }, x.days_ahead === 0 ? 'Today' : fmtDate(x.date)),
        h('span', { class: 'fc-track' }, h('span', { class: 'fc-bar fc-now', style: `width:${pct(x.sold)}` }), was ? h('span', { class: 'fc-bar fc-was', style: `width:${pct(was.sold)}` }) : null),
        h('span', { class: 'fc-val' }, String(x.sold), was ? h('span', { class: 'muted' }, ` · ${was.sold}`) : null));
    })),
    h('details', null, h('summary', null, 'Show as a table'), table([
      { head: 'Day', cell: (x) => fmtDate(x.date) },
      { head: 'Tickets', num: true, cell: (x) => String(x.tickets) }, { head: 'Lessons', num: true, cell: (x) => String(x.lessons) }, { head: 'Rentals', num: true, cell: (x) => String(x.rentals) },
      { head: 'Bought online', num: true, cell: (x) => (x.online_share === null ? '' : `${Math.round(x.online_share * 100)}%`) },
      { head: 'Last year', num: true, cell: (x) => (x.last_year ? String(x.last_year.sold) : '') },
    ], p.days)));
  return sec;
}

// ---------------------------------------------------------------- today's wind, hour by hour
function windChart(pt) {
  // Drawn at about the width it is shown, so the axis text stays readable on a phone.
  const W = typeof window !== 'undefined' && window.innerWidth < 640 ? 360 : 640; const H = W < 640 ? 180 : 200; const L = 30; const R = 10; const T = 12; const B = 28;
  const hrs = pt.hours;
  const top = Math.max(10, Math.ceil(Math.max(...hrs.map((x) => Math.max(x.wind_mph || 0, x.gust_mph || 0))) / 10) * 10);
  const x = (i) => L + (hrs.length < 2 ? 0 : (i / (hrs.length - 1)) * (W - L - R));
  const y = (v) => T + (1 - v / top) * (H - T - B);
  const path = (k) => hrs.map((p, i) => (p[k] === null ? null : `${x(i)},${y(p[k])}`)).filter(Boolean).join(' ');
  const grid = [0, top / 2, top].map((v) => svg('g', null, svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'fc-grid' }), svg('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'fc-axis' }, String(v))));
  const ticks = hrs.map((p, i) => (i % 6 === 0 ? svg('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', class: 'fc-axis' }, hourText(p.time)) : null));
  const hits = hrs.map((p, i) => svg('g', { class: 'fc-hit' },
    svg('title', null, `${hourText(p.time)}: wind ${mph(p.wind_mph)}, gusts ${mph(p.gust_mph)}`),
    svg('rect', { x: x(i) - (W - L - R) / Math.max(hrs.length - 1, 1) / 2, y: T, width: (W - L - R) / Math.max(hrs.length - 1, 1), height: H - T - B, fill: 'transparent' }),
    p.gust_mph === null ? null : svg('circle', { cx: x(i), cy: y(p.gust_mph), r: 4, class: 'fc-dot fc-was-stroke' }),
    p.wind_mph === null ? null : svg('circle', { cx: x(i), cy: y(p.wind_mph), r: 4, class: 'fc-dot fc-now-stroke' })));
  return svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'fc-chart', role: 'img', 'aria-label': `Wind and gusts today at the ${ROLE[pt.role] || pt.role}, in miles per hour` },
    ...grid, ...ticks,
    svg('polyline', { points: path('gust_mph'), class: 'fc-line fc-was-stroke fc-dash' }),
    svg('polyline', { points: path('wind_mph'), class: 'fc-line fc-now-stroke' }), ...hits);
}

function wind(d) {
  const sec = h('section', { class: 'stack', 'aria-labelledby': 'fc-wind' }, h('h3', { id: 'fc-wind' }, 'Wind today, hour by hour'));
  if (!d.wind) return sec.append(empty(d.points.map || d.points.summit ? 'No weather snapshot for today yet. The daily job takes one each morning.' : 'Set the mountain’s map point (Settings, Map) so the weather can be looked up.')), sec;
  sec.append(h('p', { class: 'muted small' }, 'From this morning’s hourly forecast, in miles per hour. Gusts are the strongest gust in each hour.'),
    h('div', { class: 'fc-legend', 'aria-hidden': 'true' }, h('span', null, h('i', { class: 'fc-key fc-now' }), 'Wind'), h('span', null, h('i', { class: 'fc-key fc-was fc-key-dash' }), 'Gusts')));
  for (const pt of d.wind.points) {
    sec.append(h('div', { class: 'stack' },
      h('h4', null, `${ROLE[pt.role] || pt.role}${pt.elevation_m !== null && pt.elevation_m !== undefined ? ` (${Math.round(pt.elevation_m * 3.281).toLocaleString()} ft)` : ''}`),
      pt.hours.length ? windChart(pt) : empty('No hours left today in this morning’s forecast.'),
      pt.hours.length ? h('details', null, h('summary', null, 'Show as a table'), table([
        { head: 'Hour', cell: (x) => hourText(x.time) }, { head: 'Wind', num: true, cell: (x) => mph(x.wind_mph) }, { head: 'Gusts', num: true, cell: (x) => mph(x.gust_mph) },
      ], pt.hours)) : null));
  }
  return sec;
}

// ---------------------------------------------------------------- which days have snapshots
function coverage(d) {
  const mark = (v) => (v === 'live' ? state('Taken', 'good') : v === 'backfilled' ? state('Rebuilt', 'neutral') : h('span', { class: 'muted' }, 'None'));
  // A plain grid, not table(): it stays a grid on a phone instead of 14 cards.
  return h('section', { class: 'stack', 'aria-labelledby': 'fc-days' }, h('h3', { id: 'fc-days' }, 'The last 14 days'),
    h('p', { class: 'muted small' }, 'Taken: written by the daily job that morning. Rebuilt: filled in later from sales, shifts and the weather record. Prices cannot be rebuilt.'),
    h('table', { class: 'fc-cov' }, h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Day'), KINDS.map(([, name]) => h('th', { scope: 'col' }, name)))),
      h('tbody', null, d.days.slice(0, 14).map((x) => h('tr', null, h('th', { scope: 'row' }, fmtDate(x.date)), KINDS.map(([k]) => h('td', null, mark(x.kinds[k]))))))));
}

// ---------------------------------------------------------------- weather points
function points(d, reload) {
  const s = d.points.summit;
  const lat = input({ type: 'number', step: 'any', min: -90, max: 90, value: s ? s.lat : '', name: 'lat', inputmode: 'decimal' });
  const lng = input({ type: 'number', step: 'any', min: -180, max: 180, value: s ? s.lng : '', name: 'lng', inputmode: 'decimal' });
  const save = async (body, done) => { try { await put('/reports/forecast-data/summit', body); toast(done); await reload(); } catch (e) { fail(e); } };
  return h('section', { class: 'stack', 'aria-labelledby': 'fc-points' }, h('h3', { id: 'fc-points' }, 'Weather points'),
    h('p', { class: 'muted small' }, d.points.map
      ? `The base is the mountain’s map point (${d.points.map.lat.toFixed(4)}, ${d.points.map.lng.toFixed(4)}), set in Settings, Map. Add the summit to record the forecast at the top as well.`
      : 'The base is the mountain’s map point, set in Settings, Map. None is set yet.'),
    h('div', { class: 'inline-form' }, field('Summit latitude', lat), field('Summit longitude', lng),
      button('Save summit', () => {
        if (lat.value === '' || lng.value === '') { toast('Give both latitude and longitude.', 'error'); return; }
        return save({ lat: Number(lat.value), lng: Number(lng.value) }, 'Summit saved');
      }, { small: true }),
      s ? button('Remove summit', () => save({ lat: null, lng: null }, 'Summit removed'), { small: true }) : null));
}
