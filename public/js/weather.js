// The family's weather page (/weather/<mountain>/<token>), from the email or text after a weather call. It says what
// changed and offers the choices in one tap each: another lesson day (or the program's makeup date), a lesson credit, or
// a refund. A makeup can be changed until it starts; a credit or a refund is final, so those ask once more. With a
// credit, the family can book a lesson with it right here. The page shows only this student's first name and lesson.

import './stage.js'; // the staging band (shows only on staging)
import { h, clear } from './ui.js';

const parts = location.pathname.split('/').filter(Boolean);
const slug = decodeURIComponent(parts[1] || '');
const token = parts[2] || '';
const root = document.getElementById('book');
const base = `/api/v1/public/${encodeURIComponent(slug)}/weather/${encodeURIComponent(token)}`;

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  } catch (_) {
    throw new Error('We could not reach the mountain. Check your connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again, or call the ski school.');
  return data;
}

const asDate = (s) => new Date(`${String(s).replace(' ', 'T').slice(0, 19)}Z`);
const dayLong = (s) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(asDate(s));
const time = (s) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }).format(asDate(s));
const money = (c) => `$${(Number(c) / 100).toFixed(2)}`;
const stamp = (s) => new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric' }).format(new Date(`${String(s).replace(' ', 'T')}Z`));

function hero(v, title) {
  const b = v && v.brand;
  if (b && b.color) document.documentElement.style.setProperty('--blue', b.color);
  const tel = v && v.phone ? `tel:${v.phone.replace(/[^\d+]/g, '')}` : null;
  return h('header', { class: 'hero' }, h('div', { class: 'hero-in' },
    b && b.logo ? h('img', { class: 'logo', src: b.logo, alt: `${v.mountain} logo` }) : null,
    h('div', { class: 'eyebrow' }, v ? v.mountain : 'Ski school'), h('h1', null, title),
    tel ? h('div', { class: 'chips-row' }, h('a', { class: 'call', href: tel }, `Call ${v.phone}`)) : null));
}

function failPage(message) {
  clear(root).append(hero(null, 'Your lesson'), h('main', { class: 'wx', id: 'wx-main' }, h('div', { class: 'card wx-err', role: 'alert' }, message)));
}

let flash = null;

async function load() {
  let v;
  try { v = await call('GET', ''); } catch (err) { failPage(err.message); return; }
  render(v);
}

function render(v) {
  const who = v.student || 'your child';
  const verb = v.action === 'move' ? 'moved' : v.action === 'delay' ? 'delayed' : 'canceled';
  const title = v.kind === 'program' ? `${v.what.name}: ${dayLong(v.what.starts_at)} is ${verb}` : `${who}'s lesson is ${verb}`;
  const status = h('div', { class: 'wx-status', role: 'status' });
  const busy = (on) => root.querySelectorAll('button').forEach((b) => { b.disabled = on; });
  const act = async (body, path = '/choose', done = 'Saved. Thank you!') => {
    busy(true);
    try { await call('POST', path, body); flash = done; await load(); } catch (err) { flash = null; msg.textContent = err.message; msg.className = 'wx-err'; msg.hidden = false; busy(false); }
  };
  const msg = h('div', { class: flash ? 'wx-msg' : 'wx-err', role: 'alert', hidden: !flash }, flash || '');
  flash = null;

  // Where things stand now.
  if (v.choice === 'makeup' && v.current) status.append(`${who} is booked on ${dayLong(v.current.starts_at)} at ${time(v.current.starts_at)}${v.current.name ? `, ${v.current.name}` : ''}.`);
  else if (v.choice === 'credit') status.append(`${who} has a lesson credit. ${v.credit_words || ''}`);
  else if (v.choice === 'refund') status.append(v.refund.refund_how === 'card' ? `Refund of ${money(v.refund.amount_cents)} on its way to your card. It usually shows within 5 to 10 days.` : v.refund.refund_how === 'desk' ? `Refund of ${money(v.refund.amount_cents)}: please see the ski school desk, or call us.` : 'Canceled. There was nothing to refund.');
  else { status.classList.add('open'); status.append(`Please choose below by ${stamp(v.expires_at)}. If we don't hear from you, we'll keep it as a lesson credit.`); }

  const what = h('section', { class: 'card wx-what', 'aria-labelledby': 'wx-was' },
    h('h2', { id: 'wx-was' }, v.kind === 'program' ? 'The program day' : 'The lesson'),
    h('p', { class: 'when' }, `${dayLong(v.what.starts_at)}, ${time(v.what.starts_at)}`),
    h('p', null, v.what.name, v.what.level_words ? h('span', { class: 'muted' }, `, ${v.what.level_words}`) : null),
    v.reason ? h('p', { class: 'muted' }, `Why: ${v.reason}`) : null);

  const sections = [];
  if (!v.final) {
    const opts = [];
    if (v.makeups.length) {
      opts.push(h('h3', null, v.kind === 'program' ? 'Come on the makeup date' : 'Take the lesson another day'));
      for (const m of v.makeups) {
        const current = v.choice === 'makeup' && v.current && v.current.starts_at === m.starts_at;
        opts.push(h('button', { type: 'button', class: `wx-opt${current ? ' current' : ''}`, 'aria-pressed': String(Boolean(current)), onclick: () => (current ? null : act(v.kind === 'program' ? { choice: 'makeup', meeting_id: m.id } : { choice: 'makeup', session_id: m.id }, '/choose', `Booked: ${dayLong(m.starts_at)} at ${time(m.starts_at)}.`)) },
          h('strong', null, `${dayLong(m.starts_at)}, ${time(m.starts_at)}`),
          h('span', null, [m.product, m.level_words, m.meeting_place ? `meet at ${m.meeting_place}` : null, m.spots_left ? `${m.spots_left} spot${m.spots_left === 1 ? '' : 's'} left` : null, current ? 'your choice' : null].filter(Boolean).join(', '))));
      }
    } else if (v.kind === 'lesson' && v.choice !== 'makeup') opts.push(h('p', { class: 'muted' }, 'No other lesson that fits has a spot right now. Take a credit and book when it suits you, or call us.'));
    const final = (text, sub, body, done) => {
      const yes = h('button', { type: 'button', class: 'btn primary', onclick: () => act(body, '/choose', done) }, 'Yes, that is what I want');
      const no = h('button', { type: 'button', class: 'btn link' }, 'Back');
      const confirm = h('div', { class: 'stack', hidden: true }, h('p', null, 'This cannot be changed afterwards.'), h('div', { class: 'chips-row' }, yes, no));
      const btn = h('button', { type: 'button', class: 'wx-opt', onclick: () => { confirm.hidden = false; btn.hidden = true; yes.focus(); } }, h('strong', null, text), h('span', null, sub));
      no.addEventListener('click', () => { confirm.hidden = true; btn.hidden = false; btn.focus(); });
      return [btn, confirm];
    };
    if (v.credit_ok) opts.push(h('h3', null, 'Or'), ...final('Keep a lesson credit', v.credit_words || 'Use it any day this season.', { choice: 'credit' }, 'Your lesson credit is saved.'));
    if (v.refund_ok) opts.push(...final(`Refund ${money(v.refund.cents)}`, v.refund.how === 'card' ? 'Back to the card you paid with.' : 'At the ski school desk (you paid there).', { choice: 'refund' }, 'Your refund is on its way.'));
    sections.push(h('section', { class: 'card wx-section', 'aria-labelledby': 'wx-ch' }, h('h2', { id: 'wx-ch' }, v.choice === 'makeup' ? 'Change your choice' : 'What would you like?'), h('div', { class: 'wx-opts' }, ...opts)));
  }
  if (v.choice === 'credit' && v.credit_lessons && v.credit_lessons.length && v.credits.length) {
    sections.push(h('section', { class: 'card wx-section', 'aria-labelledby': 'wx-use' }, h('h2', { id: 'wx-use' }, 'Use your credit now'),
      h('p', { class: 'muted' }, 'These lessons fit and have a spot. One tap books it with your credit.'),
      h('div', { class: 'wx-opts' }, ...v.credit_lessons.map((m) => h('button', { type: 'button', class: 'wx-opt', onclick: () => act({ session_id: m.id }, '/use-credit', `Booked with your credit: ${dayLong(m.starts_at)} at ${time(m.starts_at)}. A confirmation is on its way.`) },
        h('strong', null, `${dayLong(m.starts_at)}, ${time(m.starts_at)}`), h('span', null, [m.product, m.level_words, `${m.spots_left} left`].filter(Boolean).join(', ')))))));
  }
  if (v.credits.length) {
    sections.push(h('section', { class: 'card wx-section', 'aria-labelledby': 'wx-bank' }, h('h2', { id: 'wx-bank' }, `${who}'s lesson credits`),
      h('ul', { class: 'wx-bank' }, v.credits.map((c) => h('li', null, h('strong', null, `${c.left} ${c.product}`), c.note ? h('div', { class: 'muted small' }, c.note) : null))),
      h('p', { class: 'muted small' }, 'Use them at the ski school desk, or here.')));
  }
  clear(root).append(hero(v, title), h('main', { class: 'wx', id: 'wx-main' }, msg, status, what, ...sections));
}

if (!slug || !token) failPage('This link is not complete. Please use the link from your email or text.');
else load();
