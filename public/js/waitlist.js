// Claiming a waitlist spot (/waitlist/<mountain>/<token>): a spot opened in a full lesson and this family was first on
// the waitlist. The spot is held for a short time; the family fills in the few details still missing and books it like
// any online booking (card payment when the mountain takes it, otherwise the ski school confirms and they pay at the desk).
import './stage.js';
import { h, clear } from './ui.js';

const parts = location.pathname.split('/').filter(Boolean);
const slug = decodeURIComponent(parts[1] || '');
const token = parts[2] || '';
const root = document.getElementById('book');
const base = `/api/v1/public/${encodeURIComponent(slug)}/waitlist/${encodeURIComponent(token)}`;
const dateOf = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
const dayLong = (s) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(dateOf(s));
const clock = (s) => { const hr = +s.slice(11, 13); return `${hr % 12 || 12}:${s.slice(14, 16)} ${hr < 12 ? 'AM' : 'PM'}`; };
const lab = (id, t, el, hint) => h('div', { class: 'field' }, h('label', { for: id }, t), el, hint ? h('span', { class: 'hint' }, hint) : null);
const hoursText = (n) => `${n} hours`;

async function main() {
  document.getElementById('fam-loading')?.remove();
  let v;
  try { const res = await fetch(base); if (!res.ok) throw new Error('gone'); v = await res.json(); } catch (_) {
    root.append(h('main', { class: 'fam', id: 'fam-main' }, h('section', { class: 'card stack' }, h('h1', null, 'This link does not work'), h('p', { class: 'muted' }, 'It may be old or typed wrong. Please call the ski school.'))));
    return;
  }
  document.title = `${v.mountain}: claim your spot`;
  const L = v.lesson;
  const hero = h('header', { class: 'hero' }, h('div', { class: 'hero-in' }, h('span', { class: 'eyebrow' }, v.mountain), h('h1', null, `A spot opened for ${v.student.first_name}`)));
  const main = h('main', { class: 'fam', id: 'fam-main' });
  root.append(hero, main);
  const lessonCard = h('section', { class: 'card stack' }, h('h2', null, L.product), h('p', { class: 'fam-when' }, `${dayLong(L.starts_at.slice(0, 10))}, ${clock(L.starts_at)} to ${clock(L.ends_at)}`),
    h('dl', { class: 'facts' }, h('div', null, h('dt', null, 'Level'), h('dd', null, L.level_words)), h('div', null, h('dt', null, 'Ages'), h('dd', null, L.ages)), L.meeting_place ? h('div', null, h('dt', null, 'Meet at'), h('dd', null, L.meeting_place)) : null));
  main.append(lessonCard);
  if (v.status !== 'open') {
    main.append(h('div', { class: 'notice bad', role: 'status' }, v.status === 'claimed' ? 'This spot is already claimed.' : 'This offer has run out.', h('span', null, v.status === 'claimed' ? 'Check your email for the booking.' : 'The spot went to the next family on the waitlist. Please call the ski school if you still want a lesson.')));
    return;
  }
  const left = h('p', { class: 'countdown', role: 'timer', 'aria-live': 'off' });
  let secs = v.seconds_left;
  const tick = () => { const m = Math.floor(secs / 60); left.textContent = secs > 0 ? `Held for you for ${m} more minute${m === 1 ? '' : 's'}` : 'Time is up. Reload the page to see if it is still yours.'; secs -= 15; };
  tick(); setInterval(tick, 15000);
  lessonCard.append(left);

  const f = {
    first: h('input', { id: 'c-first', value: (v.contact.name || '').split(' ')[0] || '', autocomplete: 'given-name', maxlength: 100 }),
    last: h('input', { id: 'c-last', value: (v.contact.name || '').split(' ').slice(1).join(' '), autocomplete: 'family-name', maxlength: 100 }),
    email: h('input', { id: 'c-email', type: 'email', value: v.contact.email || '', autocomplete: 'email', maxlength: 255 }),
    phone: h('input', { id: 'c-phone', type: 'tel', value: v.contact.phone || '', autocomplete: 'tel', inputmode: 'tel', maxlength: 40 }),
    dob: h('input', { id: 's-dob', type: 'date', value: v.student.date_of_birth || '' }),
    sex: h('select', { id: 's-sex' }, [['', 'Choose'], ['female', 'Female'], ['male', 'Male'], ['other', 'Other']].map(([val, t]) => h('option', { value: val }, t))),
    allergies: h('input', { id: 's-allergies', maxlength: 300 }), medical: h('input', { id: 's-medical', maxlength: 500 }), pickup: h('input', { id: 's-pickup', maxlength: 300 }),
  };
  const photo = v.photos_asked ? h('input', { type: 'checkbox', id: 's-photo' }) : null;
  const text = v.texts_available ? h('input', { type: 'checkbox', id: 's-text' }) : null;
  const accept = h('input', { type: 'checkbox', id: 'accept' });
  const policy = h('input', { type: 'checkbox', id: 'accept-policy' });
  const msg = h('div', { role: 'status', 'aria-live': 'polite' });
  const send = h('button', { type: 'submit', class: 'btn primary big' }, v.pay_online ? 'Claim and pay' : 'Claim this spot');
  const tiers = v.policy_tiers || [];
  const form = h('form', { class: 'stack', novalidate: '' },
    h('section', { class: 'card stack' }, h('h2', null, 'Your details'), h('div', { class: 'row2' }, lab('c-first', 'First name', f.first), lab('c-last', 'Last name', f.last)), h('div', { class: 'row2' }, lab('c-email', 'Email', f.email), lab('c-phone', 'Phone', f.phone)),
      text ? h('label', { class: 'check' }, text, h('span', null, 'Text me about this lesson. Message and data rates may apply. Reply STOP to stop.')) : null),
    h('section', { class: 'card stack' }, h('h2', null, `${v.student.first_name} ${v.student.last_name}`), h('div', { class: 'row2' }, lab('s-dob', 'Date of birth', f.dob), lab('s-sex', 'Sex', f.sex)),
      h('div', { class: 'row2' }, lab('s-allergies', 'Allergies', f.allergies), lab('s-medical', 'Medical notes', f.medical)), lab('s-pickup', 'Who may pick up', f.pickup),
      photo ? h('label', { class: 'check' }, photo, h('span', null, 'You may take photos of my child during the lesson for the lesson recap. You can change this any time.')) : null),
    h('section', { class: 'card stack' }, h('h2', null, 'Before you book'),
      v.waiver_text ? h('details', { class: 'waiver-read' }, h('summary', null, 'Read the waiver'), h('div', { class: 'waiver-text' }, v.waiver_text)) : null,
      h('label', { class: 'check' }, accept, h('span', null, 'I have read and accept the waiver, for myself and for the student named above if under 18.')),
      v.pay_online ? h('div', { class: 'stack' }, h('ul', { class: 'tiers' }, tiers.map((t, i) => h('li', { class: `tier ${t.percent === 100 ? 'full' : t.percent === 0 ? 'none' : 'part'}` }, h('span', { class: 'pct' }, t.percent === 0 ? 'None' : `${t.percent}%`),
        h('span', { class: 'when' }, i === 0 ? `Cancel ${hoursText(t.from_hours)} or more before` : t.percent === 0 ? `Cancel less than ${hoursText(tiers[i - 1].from_hours)} before, or do not show up` : `Cancel ${hoursText(t.from_hours)} to ${hoursText(tiers[i - 1].from_hours)} before`)))), h('label', { class: 'check' }, policy, h('span', null, 'I have read and accept the cancellation policy.'))) : null),
    msg, h('div', { class: 'actionbar' }, h('span', { class: 'muted small' }, `${v.student.first_name}, ${L.product}`), send));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); clear(msg);
    const problem = (t, el) => { msg.append(h('p', { class: 'error-box', role: 'alert' }, t)); el?.focus?.(); };
    for (const k of ['first', 'last', 'email', 'phone', 'dob']) if (!f[k].value.trim()) return problem('Please fill in every detail above.', f[k]);
    if (!f.sex.value) return problem('Please choose the student\'s sex.', f.sex);
    if (!accept.checked) return problem('Please accept the waiver to continue.', accept);
    if (v.pay_online && !policy.checked) return problem('Please accept the cancellation policy to continue.', policy);
    send.disabled = true;
    const val = (el) => el.value.trim() || undefined;
    try {
      const res = await fetch(`${base}/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        contact_first_name: f.first.value.trim(), contact_last_name: f.last.value.trim(), contact_email: f.email.value.trim(), contact_phone: f.phone.value.trim(),
        student: { first_name: v.student.first_name, last_name: v.student.last_name, date_of_birth: f.dob.value, sex: f.sex.value, ...(v.student.level ? { level: v.student.level } : {}), allergies: val(f.allergies), medical: val(f.medical), pickup: val(f.pickup), photo_ok: photo ? photo.checked : undefined, text_ok: text ? text.checked : undefined },
        waiver_accepted: true, policy_accepted: v.pay_online ? true : undefined,
      }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'That did not work. Please call the ski school.');
      if (out.checkout_url) { msg.append(h('p', null, 'Taking you to the payment page…')); location.href = out.checkout_url; return; }
      clear(main).append(h('section', { class: 'card stack done', role: 'status' }, h('h2', null, 'Spot claimed'), h('p', null, out.message || 'The ski school will confirm it.'),
        h('p', null, 'Your reference is'), h('strong', { class: 'reference' }, (out.requests || []).map((r) => r.reference).join(' '))));
    } catch (err) { problem(err.message); send.disabled = false; }
  });
  main.append(form);
}
main();
