import { get, post, put, del } from '../api.js';
import { h, clear, isManager, table, input, select, field, button, toast, formDialog, val, num, fmtDate, fmtTime, empty, label, money } from '../ui.js';

const SKY = [['', 'Not set'], ['clear', 'Clear'], ['partly', 'Partly cloudy'], ['overcast', 'Overcast'], ['snow', 'Snowing'], ['rain', 'Raining'], ['mixed', 'Mixed'], ['fog', 'Fog']];
const DIRS = [['', 'Not set'], 'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const QUALITY = [['', 'Not set'], ['poor', 'Poor'], ['fair', 'Fair'], ['good', 'Good'], ['excellent', 'Excellent']];

export async function drawSnowWeather(root) {
  const snow = h('section', { class: 'section' });
  const wx = h('section', { class: 'section' });
  const days = h('section', { class: 'section' });
  root.append(snow, wx);
  if (isManager()) root.append(days);
  await Promise.all([drawSnow(snow), drawWeather(wx), isManager() ? drawDays(days) : null]);
}

// Open-Meteo weather codes, in words.
const SKY_CODE = (c) => {
  if (c === null || c === undefined) return '';
  if (c === 0) return 'Clear';
  if (c <= 2) return 'Partly cloudy';
  if (c === 3) return 'Overcast';
  if (c <= 48) return 'Fog';
  if (c <= 57) return 'Drizzle';
  if (c <= 67) return 'Rain';
  if (c <= 77) return 'Snow';
  if (c <= 82) return 'Showers';
  if (c <= 86) return 'Snow showers';
  return 'Thunderstorms';
};
const inches = (v) => (v === null ? '' : `${Math.round(v * 10) / 10} in`);

/** How each day went, recorded every night: the history the visitor forecast learns from. */
async function drawDays(box) {
  const r = await get('/ops/days');
  const head = h('header', null, h('h2', null, 'Day by day'));
  clear(box).append(head, h('p', { class: 'muted' }, 'Recorded every night: the weather at the mountain, new snow, whether you were open, visits, tickets and lessons. This history is what the visitor forecast will learn from.'));
  if (!r.has_location) {
    const use = button('Use this device’s location', () => new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error('This device cannot share its location')); return; }
      navigator.geolocation.getCurrentPosition(async (p) => {
        try { await put('/ops/days/location', { lat: Math.round(p.coords.latitude * 1e6) / 1e6, lng: Math.round(p.coords.longitude * 1e6) / 1e6 }); toast('Weather will be recorded for this spot'); await drawDays(box); resolve(); } catch (e) { reject(e); }
      }, () => reject(new Error('Location was not shared')), { enableHighAccuracy: false, timeout: 15000 });
    }), { small: true });
    box.append(h('div', { class: 'callout' }, h('p', null, 'Weather needs the mountain’s location. Save a view on the patrol or park map, or stand at the base area and use this device’s location.'), h('div', { class: 'row' }, use)));
  }
  const fill = button(r.days.length ? 'Refill the past year' : 'Fill in the past year', async (b) => {
    b.textContent = 'Filling in, this can take a minute…';
    try { const o = await post('/ops/days/backfill', { days: 365 }); toast(`${o.days} days recorded${o.weather ? `, ${o.weather} with weather` : ''}`); await drawDays(box); } finally { b.textContent = 'Refill the past year'; }
  }, { small: true });
  head.append(fill);
  if (!r.days.length) { box.append(empty('Nothing recorded yet. Days are added each night, or fill in the past year from your sales and the weather archive.')); return; }
  box.append(table([
    { head: 'Day', cell: (d) => fmtDate(d.on_date) },
    { head: 'Open', cell: (d) => label(d.status) || '' },
    { head: 'Weather', cell: (d) => [SKY_CODE(d.weather_code), d.high_f !== null ? `${Math.round(d.low_f)}° to ${Math.round(d.high_f)}°F` : ''].filter(Boolean).join(', ') },
    { head: 'Snowfall', cell: (d) => inches(d.snowfall_in) },
    { head: 'Crew new snow', cell: (d) => inches(d.crew_new_snow_in) },
    { head: 'Wind', cell: (d) => (d.wind_mph === null ? '' : `${Math.round(d.wind_mph)} mph${d.gust_mph ? `, gusts ${Math.round(d.gust_mph)}` : ''}`) },
    { head: 'Visits', cell: (d) => String(d.visits) },
    { head: 'Tickets for the day', cell: (d) => `${d.tickets_for_day}${d.presold_online ? ` (${d.presold_online} ahead online)` : ''}` },
    { head: 'Lessons', cell: (d) => String(d.lesson_students) },
    { head: 'Revenue', cell: (d) => money(d.revenue_cents) },
  ], r.days));
}

async function drawSnow(box) {
  const [{ data }, meta, trails] = await Promise.all([get('/ops/snow?limit=40'), get('/ops/meta'), get('/schedule/trails?limit=500')]);
  clear(box).append(h('header', null, h('h2', null, 'Snow depth and surface'), button('Log a reading', () => add(), { small: true })));
  if (!data.length) { box.append(empty('No readings yet. Log the base depth and surface each morning.')); return; }
  box.append(table([
    { head: 'When', cell: (r) => `${fmtDate(r.read_at)}, ${fmtTime(r.read_at)}` },
    { head: 'Where', cell: (r) => r.trail || 'Whole mountain' },
    { head: 'Base', cell: (r) => (r.base_in === null ? '' : `${Number(r.base_in)} in`) },
    { head: 'New', cell: (r) => (r.new_snow_in === null ? '' : `${Number(r.new_snow_in)} in`) },
    { head: 'Surface', cell: (r) => label(r.surface) },
    { head: 'Quality', cell: (r) => label(r.quality) },
    { head: 'Note', cell: (r) => r.note || '' },
    { head: '', cell: (r) => (isManager() ? button('Delete', async () => { await del(`/ops/snow/${r.id}`); await drawSnow(box); }, { small: true }) : '') },
  ], data));
  function add() {
    formDialog('Log a snow reading', h('div', { class: 'form' },
      field('Where', select([['', 'Whole mountain'], ...trails.data.map((t) => [t.id, t.name])], '', { name: 'trail_id' })),
      field('Base depth (in)', input({ name: 'base_in', type: 'number', step: '0.5', min: '0' })),
      field('New snow (in)', input({ name: 'new_snow_in', type: 'number', step: '0.5', min: '0' })),
      field('Surface', select([['', 'Not set'], ...meta.surfaces.map((s) => [s.value, s.label])], '', { name: 'surface' })),
      field('Quality', select(QUALITY, '', { name: 'quality' })),
      field('Note', input({ name: 'note', maxlength: 255 }))), async (fd) => {
      await post('/ops/snow', { trail_id: num(fd, 'trail_id'), base_in: num(fd, 'base_in'), new_snow_in: num(fd, 'new_snow_in'), surface: val(fd, 'surface'), quality: val(fd, 'quality'), note: val(fd, 'note') });
      toast('Reading logged');
      await drawSnow(box);
    }, { submitText: 'Save reading' });
  }
}

async function drawWeather(box) {
  const { data } = await get('/ops/weather?limit=40');
  clear(box).append(h('header', null, h('h2', null, 'Weather log'), button('Log weather', () => add(), { small: true })));
  if (!data.length) { box.append(empty('No weather logged yet.')); return; }
  box.append(table([
    { head: 'When', cell: (r) => `${fmtDate(r.logged_at)}, ${fmtTime(r.logged_at)}` },
    { head: 'Where', cell: (r) => r.place },
    { head: 'Temp', cell: (r) => (r.temp_f === null ? '' : `${Number(r.temp_f)}°F`) },
    { head: 'Wind', cell: (r) => (r.wind_mph === null ? '' : `${r.wind_dir || ''} ${r.wind_mph} mph${r.gust_mph ? `, gusts ${r.gust_mph}` : ''}`) },
    { head: 'Sky', cell: (r) => label(r.sky) },
    { head: 'Precip', cell: (r) => (r.precip_in === null ? '' : `${Number(r.precip_in)} in`) },
    { head: '', cell: (r) => (isManager() ? button('Delete', async () => { await del(`/ops/weather/${r.id}`); await drawWeather(box); }, { small: true }) : '') },
  ], data));
  function add() {
    formDialog('Log weather', h('div', { class: 'form' },
      field('Place', input({ name: 'place', value: 'Base', maxlength: 40 })),
      field('Temperature (°F)', input({ name: 'temp_f', type: 'number', step: '0.5', min: '-80', max: '130' })),
      field('Wind (mph)', input({ name: 'wind_mph', type: 'number', min: '0', max: '250' })),
      field('Gusts (mph)', input({ name: 'gust_mph', type: 'number', min: '0', max: '300' })),
      field('Wind from', select(DIRS, '', { name: 'wind_dir' })),
      field('Sky', select(SKY, '', { name: 'sky' })),
      field('Precipitation (in)', input({ name: 'precip_in', type: 'number', step: '0.01', min: '0' })),
      field('Note', input({ name: 'note', maxlength: 255 }))), async (fd) => {
      await post('/ops/weather', { place: val(fd, 'place') || 'Base', temp_f: num(fd, 'temp_f'), wind_mph: num(fd, 'wind_mph'), gust_mph: num(fd, 'gust_mph'), wind_dir: val(fd, 'wind_dir'), sky: val(fd, 'sky'), precip_in: num(fd, 'precip_in'), note: val(fd, 'note') });
      toast('Weather logged');
      await drawWeather(box);
    }, { submitText: 'Save' });
  }
}
