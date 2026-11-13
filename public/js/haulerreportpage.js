// A hauler's or business's yearly recycling form (/hauler-report/<municipality>/<link>, release 2026.11.22): no sign-in,
// the link is the key and opens only this reporter's form for this year, until the municipality closes the report. Tons
// by material in the four columns of Pennsylvania's municipal recycling report, the residue, and the processor or market.
import { h, clear, appendAll } from './ui.js';

const parts = location.pathname.split('/').filter(Boolean);
const slug = decodeURIComponent(parts[1] || '');
const token = parts[2] || '';
const root = document.getElementById('report');
const api = `/api/v1/public/${encodeURIComponent(slug)}/hauler-report/${encodeURIComponent(token)}`;
const fmt = (v) => (Number(v) ? Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '');

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again, or call the office.');
  return data;
}
const errorLine = (text) => h('p', { class: 'error-box', role: 'alert' }, text);

async function main() {
  document.getElementById('report-loading')?.remove();
  let f;
  try { f = await getJson(api); } catch (err) {
    root.append(h('h1', null, 'This link does not open a form'), h('p', { class: 'muted' }, err.message));
    return;
  }
  draw(f);
}

function draw(f, { saved = false } = {}) {
  document.title = `${f.town}: ${f.year} recycling report`;
  const lines = [];
  const list = h('div', { class: 'stack' });
  const none = h('input', { type: 'checkbox', id: 'r-none', checked: f.none_to_report });
  const add = (l = {}) => {
    const i = lines.length + 1;
    const mat = h('select', { id: `r-mat-${i}`, 'aria-label': 'Material' }, f.materials.map((m) => h('option', { value: m.key, selected: m.key === (l.material || 'commingled') }, m.label)));
    const cols = f.columns.map((c) => ({ key: c.key, el: h('input', { id: `r-${c.key}-${i}`, inputmode: 'decimal', value: fmt(l[c.key]), placeholder: '0' }), label: c.label }));
    const residue = h('input', { id: `r-res-${i}`, inputmode: 'decimal', value: fmt(l.residue), placeholder: '0' });
    const proc = h('input', { id: `r-proc-${i}`, maxlength: 160, value: l.processor || '', autocomplete: 'organization' });
    const box = h('fieldset', { class: 'panel stack tight' },
      h('legend', null, `Material ${i}`), h('div', { class: 'field' }, h('label', { for: mat.id }, 'Material'), mat),
      h('div', { class: 'hr-cols' }, cols.map((c) => h('div', { class: 'field' }, h('label', { for: c.el.id }, `${c.label}, tons`), c.el))),
      h('div', { class: 'field' }, h('label', { for: residue.id }, 'Residue, tons'), residue, h('span', { class: 'hint' }, 'What the processor threw away. It is taken off the tons above.')),
      h('div', { class: 'field' }, h('label', { for: proc.id }, 'Processor or market it went to'), proc),
      h('button', { type: 'button', class: 'btn', onclick: () => { box.remove(); lines.splice(lines.indexOf(entry), 1); } }, 'Remove this material'));
    const entry = { mat, cols, residue, proc };
    lines.push(entry); list.append(box);
  };
  (f.lines.length ? f.lines : [{}]).forEach(add);
  const who = h('input', { id: 'r-name', maxlength: 120, autocomplete: 'name', value: f.answer_name || '' });
  const trap = h('input', { name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
  const msg = h('div', { role: 'status' });
  const send = h('button', { type: 'button', class: 'btn primary big' }, f.answered_at ? 'Send the changes' : 'Send the report');
  const num = (el) => Number(String(el.value || '0').replace(/,/g, '')) || 0;
  send.addEventListener('click', async () => {
    clear(msg);
    if (who.value.trim().length < 2) { msg.append(errorLine('Give your name, as the person sending this report.')); who.focus(); return; }
    send.disabled = true;
    try {
      const out = await getJson(api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        name: who.value.trim(), none: none.checked, website: trap.value || undefined,
        lines: none.checked ? [] : lines.map((x) => ({ material: x.mat.value, ...Object.fromEntries(x.cols.map((c) => [c.key, num(c.el)])), residue: num(x.residue), processor: x.proc.value.trim() })),
      }) });
      draw(out, { saved: true });
      window.scrollTo(0, 0);
    } catch (err) { send.disabled = false; msg.append(errorLine(err.message)); }
  });
  const syncNone = () => { list.hidden = none.checked; addBtn.hidden = none.checked; };
  const addBtn = h('button', { type: 'button', class: 'btn' }, 'Add another material');
  addBtn.addEventListener('click', () => add());
  none.addEventListener('change', syncNone);
  appendAll(clear(root), // appendAll leaves out the parts that do not apply (append would write "null")
    h('div', { class: 'bulk-head' }, h('h1', null, `${f.town}: ${f.year} recycling report`)),
    saved ? h('p', { class: 'help-done', role: 'status' }, h('strong', null, 'Thank you. Your report is in.'), ' You can change it with this link until the municipality closes the report.') : null,
    h('p', null, `For ${f.reporter} (${f.form}). ${f.town} reports its recycling each year to the county under Pennsylvania's Act 101. Please give the tons you collected in ${f.town} in ${f.year}, by material, by ${f.due_words}.`),
    f.answered_at && !saved ? h('p', { class: 'muted' }, 'Your report is in. You can change it below.') : null,
    h('label', { class: 'check' }, none, f.kind === 'business' ? `We had nothing to recycle in ${f.year}` : `We collected nothing in ${f.town} in ${f.year}`),
    list, addBtn,
    h('div', { class: 'field' }, h('label', { for: 'r-name' }, 'Your name'), who),
    h('div', { class: 'help-trap', 'aria-hidden': 'true' }, trap), msg, send,
    h('p', { class: 'muted small' }, `Questions? Call ${f.town}${f.phone ? ` at ${f.phone}` : ''}. Only the municipality sees what you send here.`));
  syncNone();
}

main();
