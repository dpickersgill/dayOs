// Patrol > Cases > Risk report: the documentation score for the season (every signed-off report, worst first), the
// red-flag cases and whether management and the insurer were told, and the season risk report for insurance renewal
// (#/patrol/risk-report), counts only, which can be shared with a broker by a secure link.
import { get, post } from '../api.js';
import { h, clear, button, select, input, field, formDialog, state, errorBox, table, empty, label, seasonFor, todayStr } from '../ui.js';
import { riskDoc, day } from './claim-render.js';
import { sharesList, showNewLink } from './patrol-claim.js';

const seasons = () => {
  const now = seasonFor(todayStr());
  const y = Number(now.slice(0, 4));
  return [0, 1, 2, 3].map((n) => { const s = y - n; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; });
};
const tone = (n) => (n === null || n === undefined ? 'neutral' : n >= 90 ? 'good' : n >= 70 ? 'warn' : 'bad');
const tile = (big, small, kind) => h('div', { class: `cf-tile${kind ? ` is-${kind}` : ''}` }, h('b', null, big), h('span', null, small));
const pct = (v) => (v === null || v === undefined ? '–' : `${v}%`);

export async function drawRisk(box) {
  const pick = select(seasons().map((s) => [s, s]), seasons()[0], { 'aria-label': 'Season' });
  const body = h('div', { class: 'stack' });
  clear(box).append(h('div', { class: 'stack' },
    h('div', { class: 'spread' }, h('div', null, h('h2', null, 'Documentation and risk'), h('p', { class: 'muted' }, 'How complete and how quick this season\'s reports are, and how serious cases were handled. The season risk report is for your insurance broker at renewal: counts only, no names.')),
      h('div', { class: 'row wrap' }, field('Season', pick))),
    body));
  async function load() {
    clear(body).append(h('p', { class: 'muted' }, 'Loading…'));
    try {
      const [s, shares] = await Promise.all([get(`/patrol/doc-score?season=${pick.value}`), get('/patrol/shares').catch(() => ({ data: [] }))]);
      draw(s, shares.data.filter((x) => x.kind === 'risk'));
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  function draw(s, shares) {
    const flagged = s.cases.filter((c) => c.red_flags.length);
    const worst = [...s.cases].sort((a, b) => (a.score ?? 101) - (b.score ?? 101) || String(a.occurred_at).localeCompare(String(b.occurred_at)));
    clear(body).append(...[
      h('div', { class: 'cf-tiles' },
        tile(s.score === null ? '–' : `${s.score}%`, 'Documentation score', tone(s.score)),
        tile(pct(s.on_time_pct), `Signed off within ${s.rules.on_time_hours} hours`, s.on_time_pct === null ? null : s.on_time_pct >= 90 ? 'good' : 'warn'),
        tile(String(s.reviews_overdue), `Reviews waiting over ${s.rules.review_overdue_hours} hours`, s.reviews_overdue ? 'warn' : 'good'),
        tile(String(s.red_flags), 'Red-flag cases', s.red_flags ? 'warn' : null),
        tile(s.red_flags ? `${s.red_flags_management} of ${s.red_flags}` : '–', 'Management told', s.red_flags && s.red_flags_management < s.red_flags ? 'bad' : null),
        tile(s.red_flags ? `${s.red_flags_insurer} of ${s.red_flags}` : '–', 'Insurer told', s.red_flags && s.red_flags_insurer < s.red_flags ? 'warn' : null)),
      s.drafts ? h('p', { class: 'small' }, state(`${s.drafts} ${s.drafts === 1 ? 'draft' : 'drafts'} not signed off${s.drafts_late ? `, ${s.drafts_late} older than ${s.rules.on_time_hours} hours` : ''}`, s.drafts_late ? 'warn' : 'neutral')) : null,
      h('section', { class: 'panel stack' },
        h('div', { class: 'spread' }, h('h3', null, 'Season risk report'), h('div', { class: 'row wrap' },
          h('a', { class: 'btn primary', href: `#/patrol/risk-report/${s.season}` }, 'Open the report'),
          button('Share with your broker', () => shareDialog(s.season, load)))),
        h('p', { class: 'muted small' }, 'Visits and injury rate per 1,000, the trend against last season, this documentation score and timeliness, red-flag handling, staff injuries, and kit and AED readiness. Counts only. The network comparison appears when your mountain shares with the safety network.'),
        shares.length ? h('div', null, h('h4', null, 'Shared with brokers'), sharesList(shares, load)) : null),
      flagged.length ? h('section', { class: 'stack' }, h('h3', null, `Red-flag cases (${flagged.length})`), table([
        { head: 'Case', cell: (c) => h('a', { href: `#/patrol/case/${c.id}` }, c.case_number) },
        { head: 'When', cell: (c) => day(c.occurred_at) },
        { head: 'Why', cell: (c) => c.red_flags.map((f) => f.label).join(', ') },
        { head: 'Management', cell: (c) => state(c.told.management ? 'Told' : 'Not told', c.told.management ? 'good' : 'bad') },
        { head: 'Insurer', cell: (c) => state(c.told.insurer ? 'Told' : 'Not told', c.told.insurer ? 'good' : 'warn') },
        { head: '', actions: true, cell: (c) => h('a', { class: 'btn small', href: `#/patrol/claim/${c.id}` }, 'Claim file') },
      ], flagged)) : null,
      h('section', { class: 'stack' }, h('h3', null, `Every report signed off (${s.reports})`), s.cases.length ? table([
        { head: 'Case', cell: (c) => h('a', { href: `#/patrol/case/${c.id}` }, c.case_number) },
        { head: 'When', cell: (c) => day(c.occurred_at) },
        { head: 'Kind', cell: (c) => label(c.category) },
        { head: 'Score', cell: (c) => state(c.score === null ? 'No requirements' : `${c.score}%`, tone(c.score)) },
        { head: 'Missing', cell: (c) => (c.missing.length ? c.missing.slice(0, 2).map((x) => x.message).join('; ') + (c.missing.length > 2 ? ` and ${c.missing.length - 2} more` : '') : '') },
        { head: 'Signed off', cell: (c) => (c.hours_to_submit === null ? '' : state(`${c.hours_to_submit} h`, c.on_time ? 'good' : 'warn')) },
        { head: 'Report', cell: (c) => label(c.state) },
      ], worst) : empty('No reports signed off this season yet.')),
    ].filter(Boolean));
  }
  pick.addEventListener('change', load);
  await load();
}

function shareDialog(season, again) {
  formDialog(`Share the ${season} risk report`, h('div', { class: 'form' },
    h('div', { class: 'wide' }, field('Who it is for', input({ name: 'shared_with', required: true, maxlength: 150, placeholder: 'Broker or underwriter, and their firm' }))),
    field('Open for', select([['30', '30 days'], ['14', '14 days'], ['60', '60 days'], ['90', '90 days']], '30', { name: 'days' })),
    field('Passcode', select([['no', 'No passcode'], ['yes', 'Add a 6-digit passcode']], 'no', { name: 'passcode' }), 'Counts only, no names. A passcode adds a step for the broker.')), async (fd) => {
    const who = String(fd.get('shared_with')).trim();
    const out = await post('/patrol/risk-report/share', { season, shared_with: who, days: Number(fd.get('days')), passcode: fd.get('passcode') === 'yes' });
    showNewLink(out, who); await again();
  }, { submitText: 'Make link', wide: true });
}

/** The printable season risk report. */
export async function renderRiskReport(root, season) {
  const r = await get(`/patrol/risk-report${season ? `?season=${encodeURIComponent(season)}` : ''}`);
  root.append(h('div', { class: 'print-page claim-file' },
    h('div', { class: 'no-print row wrap cf-bar' }, h('a', { class: 'btn', href: '#/patrol/risk' }, 'Back'), button('Print or save as PDF', () => window.print(), { kind: 'primary' }),
      button('Share with your broker', () => shareDialog(r.season, async () => {}))),
    riskDoc(r),
    r.shares && r.shares.length ? h('div', { class: 'no-print cf-sec' }, h('h2', null, 'Shared with brokers'), sharesList(r.shares.filter((s) => s.season === r.season), () => location.reload())) : null));
}
