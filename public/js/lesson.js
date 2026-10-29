// The family lesson page (/lesson/<mountain>/<token>): one student's lesson, from the private link in the family's email.
// When and where, the instructor, what to bring, a delay or cancellation, "We're here" on the day, changing the date or
// canceling within the policy, the safety details and the photo and text switches, and after the lesson the recap, a
// tip for the instructor, the next steps and the progress card. Nothing here is shown without the link.
import './stage.js';
import { h, clear } from './ui.js';
import { levelList } from './levels.js';

const parts = location.pathname.split('/').filter(Boolean);
const slug = decodeURIComponent(parts[1] || '');
const token = parts[2] || '';
const root = document.getElementById('book');
const base = `/api/v1/public/${encodeURIComponent(slug)}/lesson/${encodeURIComponent(token)}`;

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again or call the ski school.');
  return data;
}
const money = (c) => (c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`);
const dateOf = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
const dayLong = (s) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(dateOf(s));
const dayShort = (s) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(dateOf(s));
const clock = (s) => { const hr = +s.slice(11, 13); return `${hr % 12 || 12}:${s.slice(14, 16)} ${hr < 12 ? 'AM' : 'PM'}`; };
const fact = (k, v) => (v ? h('div', null, h('dt', null, k), h('dd', null, v)) : null);
const errorBox = (t) => h('p', { class: 'error-box', role: 'alert' }, t);

async function main() {
  document.getElementById('fam-loading')?.remove();
  let v;
  try { v = await call('GET', ''); } catch (err) {
    root.append(h('main', { class: 'fam', id: 'fam-main' }, h('section', { class: 'card stack' }, h('h1', null, 'This link does not work'),
      h('p', { class: 'muted' }, 'It may be old or typed wrong. Use the link in your most recent email from the ski school, or call them.'))));
    return;
  }
  draw(v);
  // Back from the tip payment page.
  const tipId = Number(new URLSearchParams(location.search).get('tip')) || null;
  if (tipId) {
    for (let i = 0; i < 8; i++) {
      let st = 'pending';
      try { st = (await call('POST', `/tips/${tipId}/check`)).status; } catch (_) { /* try again */ }
      if (st === 'paid') { history.replaceState(null, '', location.pathname); try { draw(await call('GET', '')); } catch (_) { /* keep */ } document.getElementById('tip-thanks')?.focus(); return; }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

function draw(v) {
  clear(root);
  const L = v.lesson; const B = v.booking; const who = v.student.first_name;
  document.title = `${who}'s lesson at ${v.mountain}`;
  const tel = v.phone ? `tel:${v.phone.replace(/[^\d+]/g, '')}` : null;
  const hero = h('header', { class: 'hero' }, h('div', { class: 'hero-in' }, h('span', { class: 'eyebrow' }, v.mountain), h('h1', null, `${who}'s ${L.discipline === 'snowboard' ? 'snowboard' : 'ski'} lesson`),
    tel ? h('div', { class: 'chips-row' }, h('a', { class: 'call', href: tel }, `Call ${v.phone}`)) : null));
  const main = h('main', { class: 'fam', id: 'fam-main' });
  root.append(hero, main);

  // ---- notices: canceled, delayed, moved, booking canceled
  if (B.status === 'cancelled') main.append(h('div', { class: 'notice bad', role: 'status' }, 'This booking is canceled.'));
  else if (L.status === 'cancelled') main.append(h('div', { class: 'notice bad', role: 'status' }, 'The mountain canceled this lesson.', h('span', null, `${L.cancel_reason ? `${L.cancel_reason}. ` : ''}Watch your email for your choices, or call the ski school.`)));
  else if (L.delay_minutes > 0 && !L.ended) main.append(h('div', { class: 'notice warn', role: 'status' }, `Delayed ${L.delay_minutes} minutes: now starts at ${clock(L.new_start)}.`, h('span', null, 'Same meeting place. Thanks for your patience.')));

  // ---- the lesson
  const when = `${dayLong(L.starts_at.slice(0, 10))}, ${clock(L.starts_at)} to ${clock(L.ends_at)}`;
  const lessonCard = h('section', { class: 'card stack', 'aria-labelledby': 'l-h' }, h('div', { class: 'fam-head' }, h('h2', { id: 'l-h' }, L.product), h('p', { class: 'fam-when' }, when)),
    h('dl', { class: 'facts' }, fact('Meet at', L.meeting_place), fact('Instructor', L.instructor), fact('Level', L.level_words), fact('Bring', L.what_to_bring)));
  main.append(lessonCard);

  // ---- "We're here" on the lesson day (LINEUP records it)
  if (B.checked_in_at) lessonCard.append(h('div', { class: 'notice ok', role: 'status' }, `Checked in${B.checked_in_local ? ` at ${clock(B.checked_in_local)}` : ''}. Have a great lesson!`));
  else if (v.checkin_open) {
    const msg = h('div', { role: 'status', 'aria-live': 'polite' });
    const btn = h('button', { type: 'button', class: 'btn primary here', onclick: async () => {
      btn.disabled = true; clear(msg);
      try { await call('POST', '/here'); draw(await call('GET', '')); } catch (err) { msg.append(errorBox(err.message)); btn.disabled = false; }
    } }, 'We\'re here');
    lessonCard.append(h('p', { class: 'muted small' }, `At the mountain? Tap so ${L.instructor || 'the ski school'} knows ${who} is here.`), btn, msg);
  }

  // ---- after the lesson: the recap, a tip, what is next
  if (v.recap) main.append(recapCard(v));
  if (v.tips) main.append(tipCard(v));
  if (v.next && (v.next.lessons.length || v.next.pack || v.next.pass)) main.append(nextCard(v));

  // ---- the progress card
  if (v.progress) main.append(progressCard(v));

  // ---- change or cancel
  if (B.status === 'booked' && L.status === 'scheduled' && !L.ended) main.append(changeCard(v));

  // ---- details and consents
  if (B.status !== 'cancelled') main.append(detailsCard(v));
}

function recapCard(v) {
  const r = v.recap;
  return h('section', { class: 'card stack', 'aria-labelledby': 'recap-h' }, h('h2', { id: 'recap-h' }, `${v.student.first_name}'s recap${v.lesson.instructor ? ` from ${v.lesson.instructor}` : ''}`),
    h('p', { class: 'recap-body' }, r.body),
    r.skills.length ? h('div', { class: 'stack tight' }, h('h3', null, 'Can do now'), h('ul', { class: 'skills' }, r.skills.map((s) => h('li', null, s)))) : null,
    r.level_words ? h('p', null, h('strong', null, 'Level now: '), r.level_words) : null,
    r.photos.length ? h('div', { class: 'photos' }, r.photos.map((id, i) => h('img', { src: `${base}/photos/${id}`, alt: `Photo ${i + 1} of ${v.student.first_name} from the lesson`, loading: 'lazy' }))) : null);
}

function tipCard(v) {
  const t = v.tips;
  const given = t.given.filter((x) => x.status === 'paid');
  const msg = h('div', { role: 'status', 'aria-live': 'polite' });
  const other = h('input', { id: 'tip-other', type: 'number', min: 1, max: 500, step: 1, inputmode: 'decimal' });
  const pay = async (cents) => {
    clear(msg);
    if (!Number.isInteger(cents) || cents < 100) { msg.append(errorBox('Pick an amount of at least 1.')); return; }
    try { const r = await call('POST', '/tip', { amount_cents: cents }); msg.append(h('p', null, 'Taking you to the payment page…')); location.href = r.checkout_url; } catch (err) { msg.append(errorBox(err.message)); }
  };
  return h('section', { class: 'card stack', 'aria-labelledby': 'tip-h' }, h('h2', { id: 'tip-h' }, `Thank ${v.lesson.instructor || 'the instructor'}`),
    given.length ? h('p', { class: 'notice ok', id: 'tip-thanks', tabindex: '-1' }, `Thank you! Your tip of ${money(given.reduce((n, x) => n + x.amount_cents, 0))} goes to ${v.lesson.instructor || 'the instructor'}.`) : null,
    h('p', { class: 'muted' }, t.policy),
    h('div', { class: 'tips-row', role: 'group', 'aria-label': 'Tip amount' }, t.suggested.map((c) => h('button', { type: 'button', class: 'pill', onclick: () => pay(c) }, money(c)))),
    h('div', { class: 'other-tip' }, h('div', { class: 'field' }, h('label', { for: 'tip-other' }, 'Other amount'), other), h('button', { type: 'button', class: 'btn', onclick: () => pay(Math.round(Number(other.value) * 100)) }, 'Tip')),
    msg);
}

function nextCard(v) {
  const n = v.next;
  return h('section', { class: 'card stack', 'aria-labelledby': 'next-h' }, h('h2', { id: 'next-h' }, 'What is next'),
    n.lessons.length ? h('div', { class: 'stack tight' }, h('h3', null, `Book ${v.student.first_name}'s next lesson`),
      h('ul', { class: 'next-list' }, n.lessons.map((l) => h('li', null, h('a', { href: l.link }, h('span', null, h('strong', null, `${dayShort(l.starts_at.slice(0, 10))}, ${clock(l.starts_at)}`), h('br'), h('span', { class: 'muted small' }, `${l.product} · ${l.level_words}`)), h('span', { 'aria-hidden': 'true' }, '→')))))) : null,
    n.pack ? h('div', { class: 'stack tight' }, h('h3', null, `Make it a ${n.pack.lessons}-lesson pack`), h('p', null, `${n.pack.name}: ${money(n.pack.price_cents)}.`), n.pack.credit_words ? h('p', { class: 'muted small' }, n.pack.credit_words) : null,
      h('a', { class: 'btn', href: n.pack.link }, 'See the pack')) : null,
    n.pass ? h('div', { class: 'stack tight' }, h('h3', null, 'A season pass'), h('p', null, n.pass.words), h('a', { class: 'btn', href: n.pass.link }, 'See passes')) : null);
}

function progressCard(v) {
  const p = v.progress;
  const sec = h('section', { class: 'card stack', 'aria-labelledby': 'prog-h' }, h('h2', { id: 'prog-h' }, `${p.first_name}'s progress`),
    h('p', { class: 'muted small' }, `${p.lessons} lesson${p.lessons === 1 ? '' : 's'} so far${p.programs.length ? `, plus ${p.programs.map((x) => x.name).join(', ')}` : ''}.`));
  for (const lv of p.levels) {
    const passed = new Set(p.passed.filter((x) => x.discipline === lv.discipline).map((x) => x.level));
    sec.append(h('div', { class: 'stack tight' }, h('h3', null, `${lv.discipline === 'snowboard' ? 'Snowboard' : 'Ski'}: ${lv.words}`), h('p', { class: 'muted' }, `“${lv.can}”`),
      h('ol', { class: 'ladder', 'aria-label': `${lv.discipline} levels` }, levelList(lv.discipline).map((l) => h('li', { class: l.level === lv.level ? 'now' : l.level < lv.level ? 'past' : '' },
        h('span', { class: 'n', 'aria-hidden': 'true' }, l.level < lv.level ? '✓' : String(l.level)),
        h('span', null, `Level ${l.level}: ${l.short}`, l.level === lv.level ? ' (now)' : passed.has(l.level) ? ` (passed ${dayShort((p.passed.find((x) => x.discipline === lv.discipline && x.level === l.level) || {}).on || '2000-01-01')})` : ''))))));
  }
  if (!p.levels.length) sec.append(h('p', null, 'The instructor sets the level after the first lesson.'));
  if (p.skills.length) sec.append(h('div', { class: 'stack tight' }, h('h3', null, 'Skills ticked off'), h('ul', { class: 'skills' }, p.skills.slice(-12).map((s) => h('li', null, `${s.name} (${dayShort(s.on)})`)))));
  if (p.recaps.length > 1) sec.append(h('details', { class: 'more' }, h('summary', null, `All recaps (${p.recaps.length})`), h('div', { class: 'stack' }, p.recaps.map((r) => h('div', null, h('strong', null, `${dayShort(r.date)}, ${r.product}`), r.level_words ? h('span', { class: 'muted small' }, ` · ${r.level_words}`) : null, r.body ? h('p', { class: 'recap-body small' }, r.body) : null)))));
  return sec;
}

function changeCard(v) {
  const pol = v.policy;
  const out = h('div', { class: 'stack', 'aria-live': 'polite' });
  const sec = h('section', { class: 'card stack', 'aria-labelledby': 'change-h' }, h('h2', { id: 'change-h' }, 'Change or cancel'));
  if (pol.can_change) {
    sec.append(h('p', { class: 'muted small' }, `Free to change up to ${pol.change_until_hours} hours before the lesson. ${v.student.first_name} keeps the same booking, details and link.`),
      h('button', { type: 'button', class: 'btn', id: 'change-date', onclick: async () => {
        clear(out).append(h('p', { class: 'loading' }, 'Finding lessons that fit…'));
        try {
          const d = await call('GET', '/dates');
          clear(out);
          if (!d.lessons.length) { out.append(h('p', null, `No other lessons fit ${v.student.first_name} at the same price right now. Call the ski school and they will help.`)); return; }
          out.append(h('h3', null, 'Pick a new time'), h('div', { class: 'choices' }, d.lessons.map((l) => h('div', { class: 'choice' },
            h('span', null, h('strong', null, `${dayShort(l.starts_at.slice(0, 10))}, ${clock(l.starts_at)}`), h('br'), h('span', { class: 'muted small' }, `${l.product} · ${l.level_words}${l.meeting_place ? ` · ${l.meeting_place}` : ''}`)),
            h('button', { type: 'button', class: 'btn primary', 'aria-label': `Move to ${dayShort(l.starts_at.slice(0, 10))} ${clock(l.starts_at)}`, onclick: async (e) => {
              e.target.disabled = true;
              try { await call('POST', '/move', { session_id: l.id }); draw(await call('GET', '')); document.querySelector('.notice.ok, .fam-when')?.scrollIntoView?.(); } catch (err) { e.target.disabled = false; out.prepend(errorBox(err.message)); }
            } }, 'Move here')))));
        } catch (err) { clear(out).append(errorBox(err.message)); }
      } }, 'Change the date'));
  } else if (pol.why) sec.append(h('p', { class: 'muted' }, pol.why));
  if (pol.can_cancel) {
    const words = pol.refund_percent === 100 ? 'You get a full refund.' : pol.refund_percent > 0 ? `You get ${pol.refund_percent}% back under the policy.` : 'Nothing is refunded this close to the lesson.';
    sec.append(h('button', { type: 'button', class: 'btn', id: 'cancel-lesson', onclick: () => {
      clear(out).append(h('div', { class: 'notice warn' }, `Cancel ${v.student.first_name}'s lesson?`, h('span', null, words)),
        h('div', { class: 'chips-row' }, h('button', { type: 'button', class: 'btn primary', onclick: async (e) => {
          e.target.disabled = true;
          try { const r = await call('POST', '/cancel'); draw(await call('GET', '')); document.querySelector('main')?.prepend(h('div', { class: 'notice ok', role: 'status' }, r.refund_cents ? `Canceled. ${money(r.refund_cents)} goes back to your card (allow a few days).` : r.credit_returned ? 'Canceled. The lesson is back on your package.' : 'Canceled.')); } catch (err) { e.target.disabled = false; out.append(errorBox(err.message)); }
        } }, 'Yes, cancel'), h('button', { type: 'button', class: 'btn', onclick: () => clear(out) }, 'Keep it')));
    } }, 'Cancel the lesson'));
  }
  sec.append(out);
  return sec;
}

function detailsCard(v) {
  const B = v.booking;
  const msg = h('div', { role: 'status', 'aria-live': 'polite' });
  const save = async (body, note) => { clear(msg); try { await call('PATCH', '', body); msg.append(h('p', { class: 'status ok' }, note || 'Saved')); } catch (err) { msg.append(errorBox(err.message)); } };
  const photo = v.photos_asked ? h('input', { type: 'checkbox', id: 'sw-photo', checked: B.photo_ok, onchange: (e) => save({ photo_ok: e.target.checked }, e.target.checked ? 'Photos: yes' : 'Photos: no. Any photo not sent yet is deleted.') }) : null;
  const text = v.texts_available ? h('input', { type: 'checkbox', id: 'sw-text', checked: B.text_ok, onchange: (e) => save({ text_ok: e.target.checked }, e.target.checked ? 'Texts: yes' : 'Texts: no') }) : null;
  const f = { allergies: h('input', { id: 'd-allergies', value: B.allergies || '', maxlength: 300 }), medical: h('input', { id: 'd-medical', value: B.medical || '', maxlength: 500 }), pickup: h('input', { id: 'd-pickup', value: B.pickup || '', maxlength: 300 }) };
  const lab = (id, t, el, hint) => h('div', { class: 'field' }, h('label', { for: id }, t), el, hint ? h('span', { class: 'hint' }, hint) : null);
  const form = h('form', { class: 'stack', novalidate: '' }, lab('d-allergies', 'Allergies', f.allergies), lab('d-medical', 'Medical notes', f.medical, 'Only the instructor, the desk and managers see these.'), lab('d-pickup', 'Who may pick up', f.pickup),
    h('div', null, h('button', { type: 'submit', class: 'btn' }, 'Save details')));
  form.addEventListener('submit', (e) => { e.preventDefault(); save({ allergies: f.allergies.value.trim() || null, medical: f.medical.value.trim() || null, pickup: f.pickup.value.trim() || null }, 'Details saved'); });
  return h('section', { class: 'card stack', 'aria-labelledby': 'det-h' }, h('h2', { id: 'det-h' }, 'Safety details and choices'),
    photo ? h('label', { class: 'check switch-row' }, photo, h('span', null, 'You may take photos of my child during the lesson for the lesson recap. You can change this any time.')) : null,
    text ? h('label', { class: 'check switch-row' }, text, h('span', null, 'Text me about this lesson (changes, check-in, the recap). Message and data rates may apply.')) : null,
    form, msg);
}

main();
