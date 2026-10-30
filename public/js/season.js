// A guest's recap page (/season/<mountain>/<token>), from the thank-you email after a day or at the end of the season:
// the numbers for each person in the family, a share link (first name and numbers only), and "Stop these emails".
// The share page (/season/<mountain>/share/<token>) shows one person's first name and numbers, nothing else.

import './stage.js'; // the staging band (shows only on staging)
import { h, clear } from './ui.js';

const parts = location.pathname.split('/').filter(Boolean);
const slug = decodeURIComponent(parts[1] || '');
const shared = parts[2] === 'share';
const token = shared ? parts[3] || '' : parts[2] || '';
const root = document.getElementById('book');
const api = `/api/v1/public/${encodeURIComponent(slug)}`;

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(`${api}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  } catch (_) {
    throw new Error('We could not reach the mountain. Check your connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 404 ? 'This link does not work any more. Ask the mountain to send it again.' : data.error || 'Something went wrong. Please try again.');
  return data;
}

const dayText = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
  if (!m) return String(d || '');
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
};
const clock = (hhmm) => { const [hr, mi] = String(hhmm || '0:0').split(':').map(Number); return `${((hr + 11) % 12) + 1}:${String(mi).padStart(2, '0')} ${hr < 12 ? 'AM' : 'PM'}`; };
const seasonWords = (label) => `the ${String(label).slice(0, 4)}-${Number(String(label).slice(0, 4)) + 1} season`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function hero(v, title, sub) {
  const b = v && v.brand;
  if (b && b.color) document.documentElement.style.setProperty('--blue', b.color);
  return h('header', { class: 'hero' }, h('div', { class: 'hero-in' },
    b && b.logo ? h('img', { class: 'logo', src: b.logo, alt: `${v.mountain} logo` }) : null,
    h('div', { class: 'eyebrow' }, v ? v.mountain : 'Your day'), h('h1', null, title), sub ? h('p', { class: 'sub' }, sub) : null));
}

function failPage(message) {
  clear(root).append(hero(null, 'Your recap'), h('main', { class: 'rc', id: 'rc-main' }, h('div', { class: 'card rc-err', role: 'alert' }, message)));
}

/** The big numbers and the short facts for one person. */
function numbers(kind, s) {
  if (kind === 'day') {
    return {
      big: [[clock(s.first_at), 'first chair'], [s.laps, s.laps === 1 ? 'lap' : 'laps'], ...(s.lifts > 1 ? [[s.lifts, 'lifts']] : [])],
      facts: (s.notes || []),
    };
  }
  const facts = [];
  if (s.first_day) facts.push(s.first_day === s.last_day ? `Your day: ${dayText(s.first_day)}` : `First day ${dayText(s.first_day)}, last day ${dayText(s.last_day)}`);
  if (s.favorite_lift) facts.push(`Favorite lift: ${s.favorite_lift}`);
  if (s.lessons) facts.push(`${plural(s.lessons, 'lesson', 'lessons')} with the ski school`);
  for (const l of s.levels || []) facts.push(`Reached ${l.name}`);
  for (const m of s.milestones || []) facts.push(`Milestone: ${m}`);
  return {
    big: [[s.days, s.days === 1 ? 'day' : 'days'], ...(s.laps ? [[s.laps, 'laps']] : []), ...(s.longest_streak > 1 ? [[s.longest_streak, 'days in a row']] : [])],
    facts,
  };
}

function personCard(kind, p, extra) {
  const n = numbers(kind, p.stats || {});
  const id = `rc-p-${p.index ?? 0}`;
  return h('section', { class: 'card rc-person', 'aria-labelledby': id },
    h('h2', { id }, p.first_name),
    h('ul', { class: 'rc-big' }, n.big.map(([num, words]) => h('li', null, h('span', { class: 'n' }, String(num)), h('span', { class: 'w' }, words)))),
    n.facts.length ? h('ul', { class: 'rc-facts' }, n.facts.map((f) => h('li', null, f))) : null,
    extra || null);
}

async function shareButton(p, say) {
  const box = h('div', { class: 'rc-share' });
  const btn = h('button', { type: 'button', class: 'btn', 'aria-label': `Share ${p.first_name}'s numbers` }, 'Share these numbers');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const out = await call('POST', `/recap/${encodeURIComponent(token)}/share`, { index: p.index });
      const text = `${p.first_name}'s numbers`;
      if (navigator.share) { try { await navigator.share({ title: text, url: out.url }); } catch (_) { /* closed */ } }
      else { try { await navigator.clipboard.writeText(out.url); say('Link copied. It shows the first name and the numbers only.'); } catch (_) { /* no clipboard */ } }
      clear(box).append(h('p', { class: 'rc-share-url' }, out.url));
    } catch (err) { say(err.message); }
    btn.disabled = false;
  });
  box.append(btn);
  return box;
}

async function loadPrivate() {
  let v;
  try { v = await call('GET', `/recap/${encodeURIComponent(token)}`); } catch (err) { failPage(err.message); return; }
  const day = v.kind === 'day';
  document.title = day ? `Your day at ${v.mountain}` : `Your season at ${v.mountain}`;
  const names = v.people.map((p) => p.first_name);
  const title = day ? 'Thanks for skiing with us today' : 'Your season, in numbers';
  const sub = day ? dayText(v.period) : `${names.length > 1 ? names.join(', ') : names[0]}, ${seasonWords(v.period)}`;
  const status = h('p', { class: 'rc-msg', role: 'status', hidden: true });
  const say = (t) => { status.hidden = !t; status.textContent = t || ''; };
  const cards = [];
  for (const p of v.people) cards.push(personCard(v.kind, p, h('div', { class: 'rc-actions' }, await shareButton(p, say))));
  const stop = h('button', { type: 'button', class: 'btn link' }, 'Stop these emails');
  stop.addEventListener('click', async () => {
    if (!confirm('Stop thank-you and recap emails from the mountain? Your tickets and receipts still come.')) return;
    stop.disabled = true;
    try { await call('POST', `/recap/${encodeURIComponent(token)}/stop`); stop.replaceWith(h('span', null, 'Done. We will not send these emails any more.')); } catch (err) { say(err.message); stop.disabled = false; }
  });
  clear(root).append(hero(v, title, sub), h('main', { class: 'rc', id: 'rc-main' },
    status, ...cards,
    h('div', { class: 'card rc-foot' },
      h('p', null, day ? 'See you soon.' : 'See you next season.'),
      h('div', { class: 'rc-actions' }, h('a', { class: 'btn primary', href: v.shop }, 'Plan your next day')),
      v.stopped ? h('p', null, 'You asked us not to send these emails.') : h('p', null, 'Rather not get these? ', stop))));
}

async function loadShared() {
  let v;
  try { v = await call('GET', `/recap-share/${encodeURIComponent(token)}`); } catch (err) { failPage(err.message); return; }
  const day = v.kind === 'day';
  document.title = `${v.first_name} at ${v.mountain}`;
  clear(root).append(hero(v, day ? `${v.first_name}'s day at ${v.mountain}` : `${v.first_name}'s season at ${v.mountain}`, day ? dayText(v.period) : seasonWords(v.period)),
    h('main', { class: 'rc', id: 'rc-main' }, personCard(v.kind, { first_name: v.first_name, stats: v.stats }),
      h('div', { class: 'card rc-foot' }, h('div', { class: 'rc-actions' }, h('a', { class: 'btn primary', href: v.shop }, `Ski ${v.mountain}`)))));
}

if (shared) loadShared(); else loadPrivate();
