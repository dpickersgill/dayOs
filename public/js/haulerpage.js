// The contracted hauler's page for one missed pickup (/hauler/<municipality>/<link>), release 2026.11.22. No login: the
// link from the email is the key, works for 30 days and only for this pickup. It shows the address, the stream and the
// time to collect by, never the resident's name or contact details, and one button: Collected.
import { h, clear } from './ui.js';

const parts = location.pathname.split('/').filter(Boolean);
const slug = decodeURIComponent(parts[1] || ''); const token = decodeURIComponent(parts[2] || '');
const root = document.getElementById('hauler');
const api = `/api/v1/public/${encodeURIComponent(slug)}/hauler/${encodeURIComponent(token)}`;
const when = (v) => { if (!v) return ''; const d = new Date(`${String(v).replace(' ', 'T')}Z`); return d.toLocaleString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Something went wrong. Please try again, or call the municipal office.'); e.status = res.status; throw e; }
  return data;
}

function draw(v) {
  document.title = `${v.town}: missed pickup ${v.reference}`;
  clear(root).append(
    h('h1', null, 'Missed pickup'),
    h('p', { class: 'muted' }, `${v.town}, reference ${v.reference}`),
    h('div', { class: 'panel stack' },
      h('p', { style: 'font-size:1.375rem;margin:0' }, h('b', null, v.address)),
      v.stream ? h('p', null, h('b', null, 'Stream: '), v.stream) : null,
      h('p', null, h('b', null, 'Reported: '), when(v.reported_at)),
      h('p', null, h('b', null, 'Collect by: '), when(v.due_at), v.late && !v.collected_at ? h('span', { class: 'state bad' }, ' Past due') : null)),
    v.collected_at
      ? h('p', { class: 'callout', role: 'status' }, `Marked collected ${when(v.collected_at)}. Thank you.`)
      : form());
}
function form() {
  const note = h('input', { id: 'note', maxlength: 300, placeholder: 'Optional: a note for the office' });
  const err = h('div');
  const btn = h('button', { type: 'submit', class: 'btn primary', style: 'min-height:64px;font-size:1.25rem;width:100%' }, 'Collected');
  return h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault(); btn.disabled = true; clear(err);
    try { draw(await getJson(`${api}/collected`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: note.value.trim() || undefined }) })); } catch (x) { btn.disabled = false; err.append(h('p', { class: 'error-box', role: 'alert' }, x.message)); }
  } }, h('div', { class: 'field' }, h('label', { for: 'note' }, 'Note'), note), err, btn);
}

(async () => {
  document.getElementById('hauler-loading')?.remove();
  try { draw(await getJson(api)); } catch (e) {
    root.append(h('h1', null, e.status === 410 ? 'This link has expired' : 'This link does not work'), h('p', null, e.status === 410 ? e.message : 'Check the link in the email, or call the municipal office.'));
  }
})();
