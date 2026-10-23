// The family page (/family/<mountain>): a parent signs in with a link sent to their email, then sees each child's
// program places: the day, every lesson date (cancelled for weather, the makeup), attendance, the class, the lift ticket,
// what is owed and the report card. They can update allergies and pickup, switch day and withdraw within the rules.
// The session is kept in this browser only (a convenience: without it, the parent signs in again).
import './stage.js';
import { h, clear, appendAll } from './ui.js';

const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const root = document.getElementById('fam');
const base = `/api/v1/public/${encodeURIComponent(slug)}/family`;
const KEY = `family.${slug}`;
const store = { get: () => { try { return localStorage.getItem(KEY); } catch (_) { return null; } }, set: (v) => { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch (_) { /* private mode */ } } };
let session = store.get();

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(session ? { 'x-family-session': session } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { session = null; store.set(null); }
  if (!res.ok) { const e = new Error(data.error || 'Something went wrong. Please try again or call the mountain.'); e.status = res.status; throw e; }
  return data;
}
const money = (c) => (c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`);
const dateOf = (s) => new Date(`${s}T12:00:00Z`);
const short = (s) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(dateOf(s));
const long = (s) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(dateOf(s));
const t12 = (t) => { const [hh, mm] = String(t).split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'am' : 'pm'}`; };
const shell = (...kids) => h('div', { class: 'layout' }, h('main', { class: 'main stack', id: 'fam-main' }, ...kids));
const lab = (id, text, el, hint) => h('div', { class: 'field' }, h('label', { for: id }, text), el, hint ? h('span', { class: 'hint' }, hint) : null);
const hero = (name, sub, extra) => h('header', { class: 'hero' }, h('div', { class: 'hero-in' }, h('span', { class: 'eyebrow' }, 'Your family'), h('h1', null, name || 'Programs and lessons'), h('p', { class: 'sub' }, sub), extra || null));

async function start() {
  const t = new URLSearchParams(location.search).get('t');
  if (t) {
    history.replaceState(null, '', location.pathname);
    try { const s = await call('POST', '/session', { token: t }); session = s.session; store.set(session); } catch (e) { return signIn(e.message); }
  }
  if (!session) return signIn();
  return show();
}

/** No session: ask for the email the family registered with, and send a one-time link. */
function signIn(problem) {
  const email = h('input', { id: 'em', type: 'email', autocomplete: 'email', required: true, maxlength: 255 });
  const hp = h('input', { name: 'website', tabindex: '-1', autocomplete: 'off', class: 'reg-hp', 'aria-hidden': 'true' });
  const msg = h('p', { role: 'status' }, problem ? h('span', { class: 'error-box' }, problem) : null);
  const go = h('button', { type: 'submit', class: 'btn primary big' }, 'Email me a sign-in link');
  const form = h('form', { class: 'card stack', novalidate: true }, h('h2', null, 'Sign in'), h('p', null, 'Use the email you registered with. We will send a link that signs you in on this phone or computer. No password needed.'),
    lab('em', 'Email', email), hp, msg, go);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!email.value.trim()) return;
    go.disabled = true;
    try {
      await call('POST', '/link', { email: email.value.trim(), website: hp.value || undefined });
      clear(form).append(h('h2', null, 'Check your email'), h('p', null, `If ${email.value.trim()} is on a registration with us, a sign-in link is on its way. It works once, for 30 minutes.`));
    } catch (ex) { clear(msg).append(h('span', { class: 'error-box' }, ex.message)); go.disabled = false; }
  });
  clear(root).append(hero(null, 'Every lesson date, weather changes, classes and report cards for your children.'), shell(form));
}

async function show() {
  let d;
  try { d = await call('GET', ''); } catch (e) { if (e.status === 401) return signIn('Please sign in again.'); clear(root).append(shell(h('p', { class: 'error-box' }, e.message))); return; }
  document.title = `${d.mountain}: your family`;
  const out = h('button', { type: 'button', class: 'btn small onink' }, 'Sign out');
  out.addEventListener('click', async () => { await call('POST', '/signout').catch(() => {}); session = null; store.set(null); signIn(); });
  const tel = d.phone ? h('a', { class: 'call', href: `tel:${d.phone.replace(/[^\d+]/g, '')}` }, `Call ${d.phone}`) : null;
  clear(root).append(hero(d.mountain, `Signed in as ${d.email}`, h('div', { class: 'chips-row' }, tel, out)),
    shell(d.people.length ? d.people.map((p) => childCard(p, d)) : h('section', { class: 'card' }, h('h2', null, 'Nothing here yet'), h('p', null, 'No program places are on this email. If you registered with another email, sign in with that one.'), h('a', { class: 'btn', href: `/programs/${encodeURIComponent(slug)}` }, 'Register for a program'))));
}

function childCard(p, d) {
  return h('section', { class: 'card stack fam-child' }, h('h2', null, `${p.first_name} ${p.last_name}`),
    ...p.places.map((pl) => placeBlock(p, pl, d)),
    p.report_card.length ? h('div', { class: 'fam-card' }, h('h3', null, 'Report card'), ...p.report_card.map((rc) => h('div', { class: 'stack tight' },
      h('p', null, h('b', null, rc.discipline === 'ski' ? 'Skiing' : rc.discipline === 'snowboard' ? 'Snowboarding' : rc.discipline), rc.level ? `: ${rc.level}` : ': just starting'),
      rc.next ? h('div', null, h('p', { class: 'small muted' }, `Working toward ${rc.next.name}:`), h('ul', { class: 'fam-skills' }, rc.next.skills.map((s) => h('li', { class: s.passed ? 'done' : '' }, h('span', { 'aria-hidden': 'true' }, s.passed ? '✓ ' : '○ '), s.name, h('span', { class: 'visually-hidden' }, s.passed ? ' (passed)' : ' (not yet)'))))) : null))) : null);
}

function placeBlock(p, pl, d) {
  const next = pl.dates.find((x) => x.status === 'scheduled' && x.date >= d.today);
  const attended = pl.dates.filter((x) => x.present === true).length;
  const box = h('div', { class: 'fam-place stack' });
  const msg = h('p', { role: 'status', class: 'small' });
  const actions = h('div', { class: 'row' });
  if (pl.policy.can_switch && pl.status === 'enrolled') {
    const sel = h('select', { 'aria-label': 'Switch to' }, pl.policy.switch_to.map((g) => h('option', { value: g.group_id }, `${g.day}s`)));
    const go = h('button', { type: 'button', class: 'btn' }, 'Switch day');
    go.addEventListener('click', async () => {
      if (!confirm(`Move ${p.first_name} to ${sel.selectedOptions[0].textContent}?`)) return;
      try { await call('POST', `/places/${pl.id}/switch`, { group_id: Number(sel.value) }); await show(); } catch (e) { msg.textContent = e.message; }
    });
    actions.append(sel, go);
  }
  const edit = h('button', { type: 'button', class: 'btn' }, 'Allergies and pickup');
  edit.addEventListener('click', () => editDetails(p, pl));
  actions.append(edit);
  if (pl.policy.can_withdraw) {
    const w = h('button', { type: 'button', class: 'btn link' }, pl.status === 'waitlist' ? 'Leave the waitlist' : 'Cancel this place');
    w.addEventListener('click', async () => {
      const text = pl.status === 'waitlist' ? `Take ${p.first_name} off the waitlist?` : `Cancel ${p.first_name}'s place? ${pl.policy.refund_cents ? `${money(pl.policy.refund_cents)} goes back to the card you paid with${pl.policy.fee_cents ? ` (less the ${money(pl.policy.fee_cents)} fee)` : ''}.` : 'There is no refund.'}`;
      if (!confirm(text)) return;
      try { const r = await call('POST', `/places/${pl.id}/withdraw`); alertAfter(r); await show(); } catch (e) { msg.textContent = e.message; }
    });
    actions.append(w);
  } else if (pl.policy.withdraw_until) actions.append(h('span', { class: 'small muted' }, `Online cancelling closed ${short(pl.policy.withdraw_until)}. Call to cancel.`));
  appendAll(box,
    h('div', { class: 'spread' }, h('h3', null, `${pl.program}: ${pl.term}`), pl.status === 'waitlist' ? h('span', { class: 'fam-chip warn' }, `Waitlist, number ${pl.waitlist_position}`) : null),
    h('p', null, `${pl.day}s, ${t12(pl.start_time)} to ${t12(pl.end_time)}${pl.discipline ? `, ${pl.discipline}` : ''}${pl.class_name ? `. Class: ${pl.class_name}` : ''}`),
    next && pl.status === 'enrolled' ? h('p', { class: 'fam-next' }, h('b', null, 'Next lesson: '), `${long(next.date)}${next.kind === 'makeup' ? ' (makeup)' : ''}`, pl.meeting_place ? `. Meet at ${pl.meeting_place}` : '', pl.what_to_bring ? `. Bring ${pl.what_to_bring}` : '') : null,
    h('ol', { class: 'fam-dates', 'aria-label': 'Lesson dates' }, pl.dates.map((x) => h('li', { class: `fam-date ${x.status === 'cancelled' ? 'off' : x.present === true ? 'here' : x.present === false ? 'away' : ''}`, title: x.status === 'cancelled' ? `Cancelled${x.reason ? `: ${x.reason}` : ''}` : x.present === true ? 'Attended' : x.present === false ? 'Absent' : x.kind !== 'regular' ? 'Makeup lesson' : 'Lesson' },
      short(x.date), x.status === 'cancelled' ? h('span', { class: 'visually-hidden' }, ' cancelled') : x.present === true ? h('span', { class: 'visually-hidden' }, ' attended') : null)),
    pl.makeup_reserve.map((x) => h('li', { class: 'fam-date reserve', title: 'Makeup date, used if a lesson is cancelled' }, short(x)))),
    h('p', { class: 'small muted' }, [attended ? `${attended} lesson${attended === 1 ? '' : 's'} attended.` : null, pl.makeup_reserve.length ? `Dashed: makeup date, used only if a lesson is cancelled for weather.` : null].filter(Boolean).join(' ')),
    h('p', { class: 'small' }, [pl.ticket_code ? `Lift ticket: ${pl.ticket_code}.` : pl.pass_status === 'verified' ? 'Using their season pass.' : pl.pass_status === 'claimed' ? 'Bring the season pass to the first lesson.' : null,
      pl.needs_rental ? 'Rental gear is ready for them.' : null, pl.owes_cents ? `To pay: ${money(pl.owes_cents)} at the ticket window.` : null].filter(Boolean).join(' ')),
    pl.allergies || pl.pickup.length ? h('p', { class: 'small muted' }, [pl.allergies ? `Allergies: ${pl.allergies}.` : null, pl.pickup.length ? `Also may pick up: ${pl.pickup.map((x) => x.name).join(', ')}.` : null].filter(Boolean).join(' ')) : null,
    pl.policy_text ? h('p', { class: 'small muted' }, pl.policy_text) : null,
    actions, msg);
  return box;
}

function alertAfter(r) {
  if (r.how === 'card' && r.refund_cents) alert(`${money(r.refund_cents)} is on its way back to your card.`);
  else if (r.how === 'desk' && r.refund_cents) alert(`Please see the ticket window for your ${money(r.refund_cents)} refund.`);
}

function editDetails(p, pl) {
  const dlg = h('dialog', { class: 'card stack', 'aria-labelledby': 'ed-h' });
  const allergies = h('input', { id: 'eal', maxlength: 300, value: pl.allergies || '' });
  const medical = h('textarea', { id: 'eme', rows: 3, maxlength: 500 }, pl.medical || '');
  const picks = [...pl.pickup, {}, {}].slice(0, Math.max(2, pl.pickup.length + 1)).map((x, i) => ({ name: h('input', { id: `epn${i}`, maxlength: 100, value: x.name || '' }), phone: h('input', { id: `epp${i}`, type: 'tel', maxlength: 40, value: x.phone || '' }), relation: h('input', { id: `epr${i}`, maxlength: 40, value: x.relation || '' }) }));
  const err = h('p', { class: 'error-box', role: 'alert', hidden: true });
  const save = h('button', { type: 'submit', class: 'btn primary' }, 'Save');
  const close = h('button', { type: 'button', class: 'btn' }, 'Close');
  const form = h('form', { class: 'stack' }, h('h2', { id: 'ed-h' }, `${p.first_name}: ${pl.program}`),
    lab('eal', 'Allergies', allergies, 'Blank if none'), lab('eme', 'Medical notes for the instructor', medical),
    h('h3', null, 'Who else may pick up'), ...picks.map((x, i) => h('div', { class: 'reg-kid-grid' }, lab(`epn${i}`, 'Name', x.name), lab(`epp${i}`, 'Phone', x.phone), lab(`epr${i}`, 'Relation', x.relation))),
    err, h('div', { class: 'row' }, close, save));
  close.addEventListener('click', () => dlg.close());
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.hidden = true;
    try {
      await call('PATCH', `/places/${pl.id}`, { allergies: allergies.value.trim() || null, medical: medical.value.trim() || null, pickup: picks.filter((x) => x.name.value.trim()).map((x) => ({ name: x.name.value.trim(), phone: x.phone.value.trim() || undefined, relation: x.relation.value.trim() || undefined })) });
      dlg.close(); await show();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
  dlg.append(form); document.body.append(dlg); dlg.showModal();
  dlg.addEventListener('close', () => dlg.remove());
}

start();
