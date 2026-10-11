// Patrol > Cases > Network: whether this mountain shares de-identified injury counts with the injury network, and how
// its season compares with the other mountains that share. The patrol director (or the owner or a manager) turns
// sharing on and off; anyone with patrol Reports can look.

import { get, put } from '../api.js';
import { h, clear, button, field, input, select, formDialog, confirmDialog, toast, errorBox, empty, table, todayStr, seasonFor, fmtDate } from '../ui.js';

const SHARED = [
  'How many patients, by injury type and body area',
  'Activity, ability, age band (never an exact age), sex and helmet use',
  'Cause, where on the mountain (run, park, lift), run rating and conditions',
  'Month and time of day (in two-hour bands), and how the patient left',
];
const NEVER = 'Never names, dates of birth, contact details, written notes, exact times, run names or GPS points. Counts from 1 to 4 are never shown.';
const COMPARE = ['cause', 'location', 'activity', 'ability', 'age', 'helmet', 'run', 'time', 'light', 'surface'];

const pctText = (v) => (v === null || v === undefined ? '' : `${v}%`);
const rateText = (v) => (v === null || v === undefined ? 'No gate data' : `${v}`);

export async function drawNetwork(box) {
  clear(box).append(h('p', { class: 'loading' }, 'Loading…'));
  let info;
  try { info = await get('/patrol/network'); } catch (err) { clear(box).append(errorBox(err)); return; }
  const now = seasonFor(todayStr());
  const y = Number(now.slice(0, 4));
  const seasons = [0, 1, 2].map((k) => `${y - k}-${String((y - k + 1) % 100).padStart(2, '0')}`);
  const seasonSel = select(seasons.map((s) => [s, `${s} season`]), now, { 'aria-label': 'Season' });
  const results = h('div', { class: 'stack' });

  async function load() {
    clear(results).append(h('p', { class: 'loading' }, 'Loading…'));
    try { drawResults(results, await get(`/patrol/network/benchmark?season=${seasonSel.value}`), info); } catch (err) { clear(results).append(errorBox(err)); }
  }
  seasonSel.addEventListener('change', load);
  clear(box).append(h('div', { class: 'stack' }, sharingPanel(info, () => drawNetwork(box)), h('div', { class: 'row' }, field('Season', seasonSel)), results));
  await load();
}

function sharingPanel(info, redraw) {
  const s = info.sharing;
  const region = (info.regions.find((r) => r.value === s.region) || {}).label;
  const status = s.share
    ? h('p', null, h('strong', null, 'Sharing. '), `Since ${fmtDate(s.agreed_at)}, agreed by ${s.agreed_name} (${s.agreed_title}). `,
      s.named ? 'The network report may name this mountain.' : 'This mountain is not named in the network report.', region ? ` Region: ${region}${s.state ? `, ${s.state}` : ''}.` : '')
    : h('p', null, h('strong', null, 'Not sharing. '), 'Share your counts to see how your season compares with other mountains, and to add your mountain to the national picture.');
  const actions = info.can_change ? h('div', { class: 'row' },
    button(s.share ? 'Change sharing' : 'Start sharing', () => shareDialog(info, redraw), { kind: s.share ? null : 'primary' }),
    s.share ? button('Stop sharing', () => confirmDialog('Stop sharing?', 'From now on your counts are left out of the network report and you lose the comparison. Reports already downloaded by the network cannot be called back.', 'Stop sharing', async () => {
      await put('/patrol/network/sharing', { share: false }); toast('Sharing stopped'); redraw();
    }, { danger: true }), { small: true }) : null)
    : h('p', { class: 'muted small' }, 'Only the patrol director, the owner or a manager can change this.');
  const history = info.history.length ? h('details', null, h('summary', null, 'History'), table([
    { head: 'When', cell: (x) => fmtDate(x.at) }, { head: 'Change', cell: (x) => (x.share ? `Sharing${x.named ? ', named' : ', not named'}` : 'Stopped') }, { head: 'By', cell: (x) => [x.by_name, x.by_title].filter(Boolean).join(', ') }], info.history)) : null;
  return h('section', { class: 'panel stack' }, h('h2', null, 'Injury network'), status,
    h('details', null, h('summary', null, 'What is shared'), h('ul', null, SHARED.map((t) => h('li', null, t))), h('p', null, NEVER),
      h('p', { class: 'muted small' }, `Only reports that were submitted or approved count. Mountains in the network now: ${info.network_mountains}. Nothing is shown until at least ${info.min_mountains} mountains share.`)),
    actions, history);
}

function shareDialog(info, redraw) {
  const s = info.sharing;
  const region = select([['', 'Choose your region'], ...info.regions.map((r) => [r.value, r.label])], s.region || '', { name: 'region', required: true });
  const state = input({ name: 'state', maxlength: 40, value: s.state || '', placeholder: 'For example Colorado' });
  const named = h('input', { type: 'checkbox', name: 'named', checked: s.named });
  const agree = h('input', { type: 'checkbox', name: 'agree' });
  formDialog(s.share ? 'Change sharing' : 'Share with the injury network', h('div', { class: 'stack' },
    h('p', null, 'Your mountain\'s injury counts join those of other mountains in a report for the National Ski Patrol, NSAA and safety researchers. ', h('strong', null, 'No patient can be identified from it.')),
    h('ul', null, SHARED.map((t) => h('li', null, t))), h('p', { class: 'muted' }, NEVER),
    h('div', { class: 'form' }, field('Region', region), field('State or province (optional)', state)),
    h('label', { class: 'check net-check' }, named, h('span', null, 'The network report may name this mountain', h('span', { class: 'hint' }, 'If not, your counts are only part of the totals, and of your region\'s once three mountains there share.'))),
    h('div', { class: 'form' }, field('Your name', input({ name: 'signer_name', maxlength: 100, required: true })), field('Your title', input({ name: 'signer_title', maxlength: 100, required: true, placeholder: 'Patrol director' }))),
    h('label', { class: 'check net-check' }, agree, ` I have the authority to agree for this mountain, and I agree to the injury network data-sharing terms (version ${info.agreement_version}). Sharing can be stopped at any time.`)),
  async (fd) => {
    await put('/patrol/network/sharing', { share: true, named: named.checked, region: fd.get('region') || null, state: String(fd.get('state') || '').trim() || null, agree: agree.checked, signer_name: String(fd.get('signer_name') || '').trim(), signer_title: String(fd.get('signer_title') || '').trim() });
    toast('Sharing with the injury network');
    redraw();
  }, { submitText: 'Agree and share', wide: true });
}

function drawResults(out, b, info) {
  const own = b.own;
  clear(out);
  const peerRate = b.peers && !b.peers.too_few_mountains ? b.peers.per_1000 : null;
  out.append(h('div', { class: 'figures' },
    fig(own.patients, 'Patients counted', 'Finished reports; staff at work, racing, medical calls and no-injury left out'),
    fig(own.visits === null ? 'No gate data' : own.visits.toLocaleString(), 'Skier visits', 'First scan of each ticket each day'),
    fig(rateText(own.per_1000), 'Patients per 1,000 visits', peerRate !== null ? `Network: ${peerRate}` : null)));

  if (!b.peers) {
    out.append(empty(info.sharing.share ? 'No comparison yet.' : 'Share with the injury network to compare your season with other mountains.'));
  } else if (b.peers.too_few_mountains) {
    out.append(empty(`The comparison starts when ${info.min_mountains} other mountains share. ${b.peers.mountains} so far.`));
  } else {
    if (b.alerts.length) {
      out.append(h('section', { class: 'panel stack' }, h('h3', null, 'Worth a look'),
        h('p', { class: 'muted small' }, 'Where a bigger share of your patients falls in one group than across the network. Only you see this.'),
        h('ul', null, b.alerts.map((a) => h('li', null, h('strong', null, `${a.title}: ${a.label}. `), `${a.own_pct}% of your patients (${a.own_patients}), against ${a.network_pct}% across the network.`)))));
    }
    out.append(h('p', { class: 'muted small' }, `Network: ${b.peers.mountains} other mountains, ${b.peers.patients_about === null ? 'too few patients to show' : `about ${b.peers.patients_about} patients`}. The network is shown as shares of its patients; a share is not shown when the count behind it is small.`));
  }
  if (!own.patients) { out.append(empty('No finished reports in this season yet.')); return; }
  const peers = b.peers && b.peers.breakdowns ? b.peers.breakdowns : null;
  out.append(h('div', { class: 'two-col' }, COMPARE.map((dim) => compareTable(own.breakdowns[dim], peers && peers[dim]))));
}

function compareTable(mine, theirs) {
  if (!mine) return null;
  const rows = mine.cells.filter((c) => c.n > 0 || (theirs && theirs.cells.find((x) => x.key === c.key && (x.pct || x.hidden))));
  const cols = [{ head: '', cell: (c) => c.label }, { head: 'You', cell: (c) => (c.n ? `${c.n} (${pctText(c.pct)})` : '0') }];
  if (theirs) cols.push({ head: 'Network', cell: (c) => { const p = theirs.cells.find((x) => x.key === c.key); return !p ? '' : p.hidden ? 'Not shown' : pctText(p.pct); } });
  return h('section', { class: 'panel stack' }, h('h3', null, mine.title), rows.length ? table(cols, rows) : h('p', { class: 'muted' }, 'None'));
}

const fig = (value, name, note) => h('div', { class: 'figure' }, h('strong', null, String(value ?? '0')), h('span', null, name), note ? h('em', null, note) : null);
