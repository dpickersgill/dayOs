// Morning brief: today's brief and the 7 before it, for anyone who missed the email or the alert. Opened from Today, the
// email and the phone alert. The brief is made at 6:00 AM mountain time on days the calendar says the mountain is open.
import { get } from '../api.js';
import { h, clear, ctx, fmtDateLong, errorBox, loading, empty } from '../ui.js';

const KIND = { ops: 'Operations', patrol: 'Patrol', school: 'Ski school' };

export async function render(root, params = []) {
  const body = h('div', { class: 'brief-page' }, loading());
  root.append(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Morning brief'), h('p', { class: 'muted', id: 'brief-sub' })),
      h('div', { class: 'actions' }, h('a', { class: 'btn small', href: '#/settings/brief' }, 'Brief settings'))),
    body);
  let r;
  try { r = await get('/brief'); } catch (err) { clear(body).append(errorBox(err)); return; }
  clear(body);
  if (!r.eligible) { body.append(empty('The morning brief goes to owners, managers, the patrol director and the ski school Director.')); return; }
  root.querySelector('#brief-sub').textContent = `${KIND[r.kind]} brief for ${ctx.me.tenant_name}`;
  let shown = r.brief;
  const picked = params[0] && /^\d+$/.test(params[0]) ? Number(params[0]) : null;
  if (picked) { try { shown = await get(`/brief/${picked}`); } catch (_) { /* fall back to today's */ } }
  const main = h('div', { class: 'brief-main' });
  if (shown) main.append(briefCard(shown, shown.sent_on === r.today));
  else main.append(h('section', { class: 'brief-card brief-none' }, h('h2', null, 'No brief yet today'),
    h('p', null, r.next ? `Today's brief comes at 6:00 AM mountain time.` : 'Briefs come on days the calendar says the mountain is open, and the day before opening day. Set open days on the Calendar.'),
    r.on ? null : h('p', { class: 'muted' }, 'You have the brief turned off. Turn it on in Brief settings.')));
  const list = [...(r.brief ? [r.brief] : []), ...r.earlier];
  const side = h('aside', { class: 'brief-side', 'aria-label': 'Earlier briefs' }, h('h2', null, 'Last 7 days'),
    list.length ? h('ul', { class: 'brief-days' }, list.map((b) => h('li', null, h('a', { href: `#/brief/${b.id}`, 'aria-current': shown && b.id === shown.id ? 'page' : null },
      h('span', { class: 'brief-day' }, dayName(b.sent_on, r.today)), h('span', { class: 'brief-first' }, (b.body.summary || [])[0] || ''))))) : h('p', { class: 'muted' }, 'Earlier briefs show here for 7 days.'));
  body.append(h('div', { class: 'brief-grid' }, main, side));
}

const dayName = (d, today) => (d === today ? 'Today' : fmtDateLong(d));

function briefCard(b, isToday) {
  const ahead = b.for_date !== b.sent_on;
  return h('article', { class: 'brief-card' },
    h('header', { class: 'brief-head' },
      h('p', { class: 'brief-kicker' }, ahead ? `Sent ${fmtDateLong(b.sent_on)}` : isToday ? 'Today' : 'Earlier brief'),
      h('h2', null, ahead ? `Opening day: ${fmtDateLong(b.for_date)}` : fmtDateLong(b.for_date))),
    h('div', { class: 'brief-summary' }, b.body.summary.map((l) => h('p', null, l))),
    b.body.sections.map((s) => h('section', { class: 'brief-sec' }, h('h3', null, s.title), h('ul', null, s.lines.map((l) => h('li', null, l))))),
    b.body.actions.length ? h('section', { class: 'brief-actions' }, h('h3', null, 'Suggested'),
      h('div', { class: 'brief-action-list' }, b.body.actions.map((a) => h('a', { class: 'btn', href: a.href }, a.text)))) : null,
    h('p', { class: 'brief-label' }, b.label, '.'));
}
