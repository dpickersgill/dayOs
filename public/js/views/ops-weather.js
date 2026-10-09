import { get, post, del } from '../api.js';
import { h, clear, isManager, table, input, select, field, button, toast, formDialog, val, num, fmtDate, fmtTime, empty, label } from '../ui.js';

const SKY = [['', 'Not set'], ['clear', 'Clear'], ['partly', 'Partly cloudy'], ['overcast', 'Overcast'], ['snow', 'Snowing'], ['rain', 'Raining'], ['mixed', 'Mixed'], ['fog', 'Fog']];
const DIRS = [['', 'Not set'], 'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const QUALITY = [['', 'Not set'], ['poor', 'Poor'], ['fair', 'Fair'], ['good', 'Good'], ['excellent', 'Excellent']];

export async function drawSnowWeather(root) {
  const snow = h('section', { class: 'section' });
  const wx = h('section', { class: 'section' });
  root.append(snow, wx);
  await Promise.all([drawSnow(snow), drawWeather(wx)]);
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
