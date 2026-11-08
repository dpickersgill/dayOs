// School and group programs (feat/school-pay), two pages from private links:
//   /group/<mountain>/<token>          the group leader's booking link: the program's days, the roster (children and a
//                                      parent or guardian for each, with each child's waiver link), and the chaperone plan.
//                                      Changes close at the deadline the ski school set.
//   /group-waiver/<mountain>/<token>   a parent or guardian reads and signs one child's waiver.
import './stage.js';
import { h, clear } from './ui.js';

const parts = location.pathname.split('/').filter(Boolean);
const waiverPage = parts[0] === 'group-waiver';
const slug = decodeURIComponent(parts[1] || '');
const token = parts[2] || '';
const root = document.getElementById('book');
const base = `/api/v1/public/${encodeURIComponent(slug)}/${waiverPage ? 'group-waiver' : 'group'}/${encodeURIComponent(token)}`;

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again or call the ski school.');
  return data;
}
const dateOf = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
const dayShort = (s) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(dateOf(s));
const dayLong = (s) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(dateOf(s));
const clock = (s) => { const t = String(s).length > 8 ? String(s).slice(11, 16) : String(s).slice(0, 5); const hr = +t.slice(0, 2); return `${hr % 12 || 12}:${t.slice(3, 5)} ${hr < 12 ? 'AM' : 'PM'}`; };
const errorBox = (t) => h('p', { class: 'error-box', role: 'alert' }, t);
const fieldOf = (id, text, el, hint) => h('div', { class: 'field' }, h('label', { for: id }, text), el, hint ? h('span', { class: 'hint muted small' }, hint) : null);
const inp = (id, attrs = {}) => h('input', { id, name: id, ...attrs });
const broken = () => root.append(h('main', { class: 'fam', id: 'fam-main' }, h('section', { class: 'card stack' }, h('h1', null, 'This link does not work'),
  h('p', { class: 'muted' }, 'It may be old or typed wrong. Ask the ski school for a new link.'))));

async function main() {
  document.getElementById('fam-loading')?.remove();
  let v;
  try { v = await call('GET', ''); } catch (_) { broken(); return; }
  if (waiverPage) drawWaiver(v); else drawGroup(v);
}

// ---------------------------------------------------------------- the group leader's page
function drawGroup(v, flash = null) {
  clear(root);
  document.title = `${v.org_name}: ${v.program}`;
  const main = h('main', { class: 'fam stack', id: 'fam-main' });
  root.append(main);
  const deadline = String(v.deadline_at).replace('T', ' ');
  main.append(h('section', { class: 'card stack' },
    h('p', { class: 'muted small' }, v.mountain),
    h('h1', null, v.program),
    h('p', null, `${v.weekday}s, ${clock(v.start_time)} to ${clock(v.end_time)}, ${v.weeks} week${v.weeks === 1 ? '' : 's'} from ${dayLong(v.first_day)}.${v.meeting_place ? ` Meet at ${v.meeting_place}.` : ''}`),
    v.open ? h('p', { class: 'notice' }, `Add your group by ${dayLong(deadline.slice(0, 10))} at ${clock(deadline)}. After that, call the ski school${v.phone ? ` at ${v.phone}` : ''} to make a change.`)
      : h('p', { class: 'notice warn' }, `The roster closed on ${dayLong(deadline.slice(0, 10))}. Call the ski school${v.phone ? ` at ${v.phone}` : ''} to make a change.`),
    h('details', null, h('summary', null, 'The days'), h('ul', null, v.meetings.map((m) => h('li', null, `${dayShort(String(m.starts_at).slice(0, 10))}, ${clock(m.starts_at)}${m.status !== 'scheduled' ? ' (canceled)' : ''}`))))));
  if (flash) main.append(flash);
  main.append(rosterCard(v), chaperoneCard(v));
}

function rosterCard(v) {
  const msg = h('div', { role: 'status', 'aria-live': 'polite' });
  const signed = v.students.filter((s) => s.waiver_signed).length;
  const sec = h('section', { class: 'card stack', 'aria-labelledby': 'roster-h' }, h('h2', { id: 'roster-h' }, `Children (${v.students.length} of ${v.max_students})`),
    h('p', { class: 'muted small' }, `${signed} of ${v.students.length} waivers signed. Each child needs a waiver signed by a parent or guardian before the first day. Send each family their child's waiver link.`));
  if (v.students.length) {
    sec.append(h('ul', { class: 'gp-list' }, v.students.map((s) => h('li', null,
      h('span', null, h('strong', null, `${s.first_name} ${s.last_name}`), h('br'), h('span', { class: 'muted small' }, `Parent or guardian: ${s.guardian_name || 'not given'}`)),
      h('span', { class: 'row' }, s.waiver_signed ? h('span', { class: 'badge good' }, 'Waiver signed') : h('button', { type: 'button', class: 'btn small', onclick: () => waiverLink(s) }, 'Waiver link'),
        v.open ? h('button', { type: 'button', class: 'btn small', 'aria-label': `Remove ${s.first_name}`, onclick: () => remove(s) }, 'Remove') : null)))));
  }
  if (v.open && v.students.length < v.max_students) {
    const f = { first: inp('c-first', { required: true, maxlength: 100, autocomplete: 'off' }), last: inp('c-last', { required: true, maxlength: 100, autocomplete: 'off' }), dob: inp('c-dob', { type: 'date', required: true }),
      gname: inp('c-gname', { required: true, maxlength: 160 }), gemail: inp('c-gemail', { type: 'email', maxlength: 255 }), gphone: inp('c-gphone', { type: 'tel', maxlength: 40 }), website: inp('website', { tabindex: '-1', autocomplete: 'off', class: 'hp' }) };
    const form = h('form', { class: 'stack', novalidate: true }, h('h3', null, 'Add a child'),
      h('div', { class: 'gp-form' }, fieldOf('c-first', 'First name', f.first), fieldOf('c-last', 'Last name', f.last), fieldOf('c-dob', 'Date of birth', f.dob),
        fieldOf('c-gname', 'Parent or guardian', f.gname), fieldOf('c-gemail', 'Their email', f.gemail, 'We email them the waiver link'), fieldOf('c-gphone', 'Their phone', f.gphone)),
      h('div', { hidden: true, 'aria-hidden': 'true' }, f.website),
      h('div', null, h('button', { type: 'submit', class: 'btn primary' }, 'Add child')), msg);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); clear(msg);
      if (!f.first.value.trim() || !f.last.value.trim() || !f.dob.value || f.gname.value.trim().length < 3) { msg.append(errorBox('Enter the child\'s name and date of birth, and the name of a parent or guardian.')); return; }
      try {
        const r = await call('POST', '/students', { first_name: f.first.value.trim(), last_name: f.last.value.trim(), date_of_birth: f.dob.value, guardian_name: f.gname.value.trim(), guardian_email: f.gemail.value.trim() || null, guardian_phone: f.gphone.value.trim() || null, website: f.website.value || undefined });
        const v2 = await call('GET', '');
        drawGroup(v2, linkNote(`${f.first.value.trim()} is on the roster.${r.emailed ? ' We emailed the waiver link to their parent or guardian.' : ' Send this waiver link to their parent or guardian:'}`, r.emailed ? null : r.waiver_link));
      } catch (err) { msg.append(errorBox(err.message)); }
    });
    sec.append(form);
  }
  async function remove(s) {
    if (!window.confirm(`Take ${s.first_name} ${s.last_name} off the roster?`)) return;
    try { await call('DELETE', `/students/${s.id}`); drawGroup(await call('GET', '')); } catch (err) { clear(msg); msg.append(errorBox(err.message)); }
  }
  async function waiverLink(s) {
    try { const r = await call('POST', `/students/${s.id}/waiver-link`); drawGroup(await call('GET', ''), linkNote(`Waiver link for ${s.first_name}. Send it to their parent or guardian (an older link stops working):`, r.waiver_link)); } catch (err) { clear(msg); msg.append(errorBox(err.message)); }
  }
  return sec;
}
function linkNote(text, link) {
  const box = link ? h('input', { class: 'gp-link', value: link, readonly: true, 'aria-label': 'Waiver link' }) : null;
  return h('section', { class: 'card stack notice ok', role: 'status' }, h('p', null, text), box,
    link ? h('div', null, h('button', { type: 'button', class: 'btn small', onclick: async () => { try { await navigator.clipboard.writeText(link); } catch (_) { box.select(); } } }, 'Copy link')) : null);
}

function chaperoneCard(v) {
  const msg = h('div', { role: 'status', 'aria-live': 'polite' });
  const need = v.chaperones_needed;
  const list = v.chaperones.map((c) => ({ ...c }));
  const sec = h('section', { class: 'card stack', 'aria-labelledby': 'chap-h' });
  const draw = () => {
    clear(sec).append(h('h2', { id: 'chap-h' }, `Chaperones (${list.length} of ${need} needed)`),
      h('p', { class: 'muted small' }, `One adult for every ${v.per_chaperone} children, with a phone we can reach on the hill. They sign the group in and out each day.`));
    if (!v.open) { sec.append(list.length ? h('ul', { class: 'gp-list' }, list.map((c) => h('li', null, h('strong', null, c.name), h('span', null, c.phone)))) : h('p', null, 'No chaperones were given.')); return; }
    const rowsEl = list.map((c, i) => h('div', { class: 'gp-form' },
      fieldOf(`ch-n-${i}`, 'Name', h('input', { id: `ch-n-${i}`, value: c.name, maxlength: 160, oninput: (e) => { c.name = e.target.value; } })),
      fieldOf(`ch-p-${i}`, 'Phone', h('input', { id: `ch-p-${i}`, type: 'tel', value: c.phone, maxlength: 40, oninput: (e) => { c.phone = e.target.value; } })),
      h('div', { class: 'field' }, h('span', null, ' '), h('button', { type: 'button', class: 'btn small', onclick: () => { list.splice(i, 1); draw(); } }, 'Remove'))));
    sec.append(...rowsEl, h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn small', onclick: () => { list.push({ name: '', phone: '' }); draw(); sec.querySelector(`#ch-n-${list.length - 1}`)?.focus(); } }, 'Add a chaperone'),
      h('button', { type: 'button', class: 'btn primary', onclick: save }, 'Save chaperones')), msg);
    if (list.length < need) sec.append(h('p', { class: 'notice warn small' }, `${need - list.length} more chaperone${need - list.length === 1 ? '' : 's'} needed for ${v.students.length} children.`));
  };
  async function save() {
    clear(msg);
    const clean = list.map((c) => ({ name: String(c.name || '').trim(), phone: String(c.phone || '').trim() }));
    if (clean.some((c) => c.name.length < 2 || c.phone.length < 7)) { msg.append(errorBox('Give each chaperone a name and a phone number.')); return; }
    try { await call('PUT', '/chaperones', { chaperones: clean }); msg.append(h('p', { class: 'notice ok' }, 'Saved.')); } catch (err) { msg.append(errorBox(err.message)); }
  }
  draw();
  return sec;
}

// ---------------------------------------------------------------- a parent signs the waiver
function drawWaiver(v) {
  clear(root);
  document.title = `Waiver for ${v.child}`;
  const main = h('main', { class: 'fam stack', id: 'fam-main' });
  root.append(main);
  const head = h('section', { class: 'card stack' }, h('p', { class: 'muted small' }, v.mountain), h('h1', null, `${v.child}'s waiver`), h('p', null, `For ${v.program} with ${v.org_name}, ${v.season} season.`));
  main.append(head);
  if (v.signed) { main.append(h('section', { class: 'card stack' }, h('p', { class: 'notice ok' }, `Signed by ${v.signed.by}. Thank you. Nothing more to do.`))); return; }
  const msg = h('div', { role: 'status', 'aria-live': 'polite' });
  const name = inp('w-name', { required: true, maxlength: 160, autocomplete: 'name', value: v.guardian_name || '' });
  const rel = h('select', { id: 'w-rel' }, h('option', { value: 'parent' }, 'Parent'), h('option', { value: 'guardian' }, 'Legal guardian'));
  const ok = h('input', { type: 'checkbox', id: 'w-ok' });
  const form = h('form', { class: 'card stack', novalidate: true },
    h('h2', null, 'Read and sign'),
    v.waiver_text ? h('div', { class: 'waiver-text', tabindex: '0', 'aria-label': 'The waiver' }, v.waiver_text) : h('p', { class: 'muted' }, 'The ski school will show you the waiver on the first day.'),
    fieldOf('w-name', 'Your full name', name), fieldOf('w-rel', `You are ${v.child}'s`, rel),
    h('label', { class: 'check', for: 'w-ok' }, ok, h('span', null, ` I have read the waiver and I sign it for ${v.child}.`)),
    h('div', null, h('button', { type: 'submit', class: 'btn primary' }, 'Sign the waiver')), msg);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); clear(msg);
    if (name.value.trim().length < 3) { msg.append(errorBox('Type your full name.')); return; }
    if (!ok.checked) { msg.append(errorBox('Tick the box to say you have read the waiver.')); return; }
    try { await call('POST', '', { signer_name: name.value.trim(), relation: rel.value, accept: true }); drawWaiver(await call('GET', '')); } catch (err) { msg.append(errorBox(err.message)); }
  });
  main.append(form);
}

main();
