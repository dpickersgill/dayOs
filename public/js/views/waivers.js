// Waivers: who has signed this season (search, see exactly what was signed, print it, void a mistake), signing a guest at the
// counter, the counter tablet link, and (managers) the wording, with every earlier version kept.
import { get, post, put, download } from '../api.js';
import { h, clear, input, state, table, field, button, fmtDateTime, empty, errorBox, tabs, toast, fail, isManager, can, confirmDialog, formDialog, val, appendAll } from '../ui.js';
import { personPicker, waiverPanel } from '../widgets.js';
import { printDialog } from '../print.js';
import { shareButton } from '../share.js';

export async function render(root, params = []) {
  const items = [['signed', 'Signed', signed]];
  if (can('counter', 'instructor')) items.push(['sign', 'Sign a guest', signGuest]);
  if (isManager()) items.push(['wording', 'Wording', wording]);
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Waivers'), h('p', { class: 'muted' }, 'Everyone who has signed this season, and how they signed.')), tabs(items, 'signed'));
  // #/waivers/w/12 (a shared link): open that signed waiver
  if (params[0] === 'w' && /^\d+$/.test(params[1] || '')) detail(Number(params[1])).catch(() => {});
}

const methodTone = (r) => (r.has_signature ? 'good' : 'neutral');

// ---------------------------------------------------------------- signed
async function signed(box) {
  box.classList.add('stack');
  const sum = await get('/waivers/summary');
  const q = input({ type: 'search', placeholder: 'Name or email', 'aria-label': 'Find a signed waiver', autocomplete: 'off' });
  const out = h('div', { 'aria-live': 'polite' });
  let page = 0; let timer;
  async function load() {
    try {
      const r = await get(`/waivers?season=${encodeURIComponent(sum.season)}&page=${page}${q.value.trim() ? `&q=${encodeURIComponent(q.value.trim())}` : ''}`);
      appendAll(clear(out), r.data.length ? table([
        { head: 'Guest', cell: (w) => h('strong', null, w.first_name ? `${w.first_name} ${w.last_name}` : 'Removed record') },
        { head: 'Signed', cell: (w) => fmtDateTime(w.signed_at) },
        { head: 'Signed by', cell: (w) => (w.signer_relation === 'guardian' ? `${w.signed_by_name} (parent or guardian)` : (w.signed_by_name || '')) },
        { head: 'How', cell: (w) => state(w.method_label, methodTone(w)) },
        { head: 'Status', cell: (w) => (w.voided_at ? state('Voided', 'bad') : w.counts ? state('Counts', 'good') : state('Signed before the wording changed', 'warn')) },
        { head: '', actions: true, cell: (w) => button('View', () => detail(w.id, load), { small: true }) },
      ], r.data) : empty(q.value.trim() ? 'No signed waiver matches that.' : 'No one has signed a waiver yet this season.'),
      r.more || page ? h('div', { class: 'row' }, page ? button('Newer', () => { page -= 1; load(); }, { small: true }) : null, r.more ? button('Older', () => { page += 1; load(); }, { small: true }) : null) : null);
    } catch (err) { clear(out).append(errorBox(err)); }
  }
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { page = 0; load(); }, 250); });
  appendAll(box, 
    h('div', { class: 'row' }, state(`${sum.people} ${sum.people === 1 ? 'person' : 'people'} covered for ${sum.season}`, 'good'), state(`${sum.today} signed today`, 'neutral'),
      sum.text ? null : state('No waiver wording yet', 'bad')),
    sum.resign_at ? h('p', { class: 'muted small' }, `Waivers signed before ${fmtDateTime(sum.resign_at)} no longer count: everyone was asked to sign the new wording.`) : null,
    h('div', { class: 'inline-form' }, field('Find a signed waiver', q),
      isManager() ? button('Download CSV', () => download(`/waivers/export.csv?season=${encodeURIComponent(sum.season)}`, `waivers-${sum.season}.csv`), { small: true }) : null),
    out);
  await load();
}

async function detail(id, after) {
  let w;
  try { w = await get(`/waivers/${id}`); } catch (err) { fail(err); return; }
  const s = w.signing;
  const name = w.first_name ? `${w.first_name} ${w.last_name}` : 'Removed record';
  const sheet = h('div', { class: 'stack waiver-sheet' },
    h('h2', null, `Waiver: ${name}, ${w.season} season`),
    h('dl', { class: 'kv' },
      h('dt', null, 'Signed'), h('dd', null, fmtDateTime(w.signed_at)),
      h('dt', null, 'How'), h('dd', null, w.method_label),
      h('dt', null, 'Signed by'), h('dd', null, `${w.signed_by_name || name}${w.signer_relation === 'guardian' ? ' (parent or guardian)' : ''}`),
      s && s.email ? [h('dt', null, 'Email'), h('dd', null, s.email)] : null,
      s ? [h('dt', null, 'Typed name'), h('dd', null, s.typed_name)] : null,
      s ? [h('dt', null, 'Device'), h('dd', { class: 'small' }, `${s.source === 'counter' ? 'Counter screen' : 'Online'}${s.ip ? `, address ${s.ip}` : ''}${s.user_agent ? `, ${s.user_agent}` : ''}`)] : null,
      s && w.covered.length > 1 ? [h('dt', null, 'Same signing covers'), h('dd', null, w.covered.map((c) => c.name).join(', '))] : null,
      w.voided_at ? [h('dt', null, 'Voided'), h('dd', null, `${fmtDateTime(w.voided_at)}: ${w.void_reason}`)] : null),
    w.text ? h('div', { class: 'waiver-copy' }, w.text) : h('p', { class: 'muted' }, w.text_sha ? 'This wording was not kept (it was signed before wording history started).' : 'Recorded by staff: the guest signed on paper, so the wording is on the paper copy.'),
    s ? h('div', { class: 'stack tight' }, h('strong', null, 'Signature'), h('img', { class: 'sig-image', src: s.signature, alt: `Signature of ${s.signer}` })) : null);
  const extra = [shareButton('waiver', id)];
  if (isManager() && !w.voided_at) {
    extra.push(button('Void', () => formDialog('Void this waiver', h('div', { class: 'form' }, h('p', { class: 'wide muted' }, `${name} will need to sign again. The signed copy is kept.`), h('label', { class: 'field wide' }, 'Why', h('input', { name: 'reason', required: true, maxlength: 300 }))), async (fd) => {
      await post(`/waivers/${id}/void`, { reason: val(fd, 'reason') });
      toast('Waiver voided');
      dlg.close();
      if (after) after();
    }, { submitText: 'Void waiver' })));
  }
  const dlg = printDialog(`Waiver for ${name}`, [sheet], extra);
}

// ---------------------------------------------------------------- sign a guest
async function signGuest(box) {
  box.classList.add('stack');
  const sum = await get('/waivers/summary');
  const slot = h('div');
  const picker = personPicker({ label: 'Guest', required: true, onPick: (p) => { clear(slot); if (p) slot.append(waiverPanel(p.id)); } });
  const tablet = `${sum.link}?counter=1`;
  appendAll(box, 
    sum.text ? null : h('div', { class: 'error-box' }, 'There is no waiver wording yet. A manager adds it under Wording.'),
    h('section', { class: 'panel stack' }, h('h2', null, 'A guest who is here now'),
      h('p', { class: 'muted' }, 'Find them, then turn the screen round so they can sign, or email them a link.'), picker.el, slot),
    h('section', { class: 'panel stack' }, h('h2', null, 'Guests who are not in the system yet'),
      h('p', null, 'Send them to the signing page. They can sign at home, from a QR code, or on a tablet at the window, and a parent or guardian signs for children at the same time.'),
      h('div', { class: 'row' }, h('code', { class: 'link-box' }, sum.link), button('Copy link', async () => { try { await navigator.clipboard.writeText(sum.link); toast('Link copied'); } catch (_) { toast('Select the link and copy it', 'error'); } }, { small: true })),
      h('p', null, h('a', { class: 'btn', href: tablet, target: '_blank', rel: 'noopener' }, 'Open the counter tablet page'), ' ', h('span', { class: 'muted small' }, 'It clears itself after each guest, so the next family never sees the last one\'s names.'))));
}

// ---------------------------------------------------------------- wording (managers)
async function wording(box) {
  box.classList.add('stack');
  const sum = await get('/waivers/summary');
  const text = h('textarea', { name: 'waiver_text', rows: 16, maxlength: 20000, 'aria-label': 'Waiver wording' }, sum.text || '');
  const again = h('input', { type: 'checkbox', name: 'ask_again' });
  async function save() {
    const body = { text: text.value.trim() || null, ask_again: again.checked };
    if (body.text === (sum.text || null)) { toast('No changes to save'); return; }
    const go = async () => { await put('/waivers/text', body); toast(body.ask_again ? 'Saved. Everyone will be asked to sign the new wording.' : 'Wording saved'); clear(box); await wording(box); };
    if (body.ask_again) confirmDialog('Ask everyone to sign again?', `All ${sum.people} waivers signed for ${sum.season} will stop counting. Guests will need to sign the new wording before they rent gear or take a lesson.`, 'Save and ask again', go, { danger: true });
    else await go();
  }
  appendAll(box, 
    h('div', { class: 'callout' }, 'Have your lawyer approve this wording. SummitOps keeps every version word for word, with who signed which.'),
    sum.text ? null : h('div', { class: 'row' }, button('Start from a sample', () => { text.value = SAMPLE; text.focus(); }, { small: true }), h('span', { class: 'muted small' }, 'A starting point only. It is not legal advice.')),
    field('Waiver wording', text, 'Guests see this exactly as written, with line breaks kept.'),
    h('label', { class: 'check' }, again, ' Ask everyone to sign again (use this when the change matters, for example new risks or a new legal entity)'),
    h('div', { class: 'row' }, button('Save wording', save, { kind: 'primary' })),
    h('h2', null, 'Earlier versions'),
    sum.versions.length ? table([
      { head: 'Saved', cell: (v) => fmtDateTime(v.created_at) },
      { head: 'Starts', cell: (v) => h('span', { class: 'small' }, `${v.opening}${v.opening.length >= 140 ? '…' : ''}`) },
      { head: 'Signed with it', cell: (v) => String(v.signed) },
      { head: '', cell: (v) => (v.current ? state('In use', 'good') : null) },
      { head: '', actions: true, cell: (v) => button('Read', async () => { try { const x = await get(`/waivers/texts/${v.sha}`); printDialog(`Wording saved ${fmtDateTime(x.created_at)}`, [h('div', { class: 'waiver-copy' }, x.body)]); } catch (err) { fail(err); } }, { small: true }) },
    ], sum.versions) : empty('No wording saved yet.'));
}

const SAMPLE = `SAMPLE ONLY. Replace everything in [brackets] and have your lawyer approve this wording before you use it.

[MOUNTAIN LEGAL NAME] RELEASE OF LIABILITY, WAIVER OF CLAIMS AND ASSUMPTION OF RISK

Please read carefully. This is a legal document that affects your rights.

1. Risks. Skiing, snowboarding, riding lifts, using terrain parks and taking lessons involve risks of injury and death, including from changing weather and snow, ice, trees, rocks, lift towers, snowmaking and grooming equipment, other people, and my own actions. I understand these are inherent risks of the sport, and I accept them.

2. My responsibilities. I will follow [the Your Responsibility Code / state law name], the mountain's signs and instructions from staff. I will ski or ride within my ability and in control.

3. Release. To the fullest extent allowed by the law of [STATE], I release [MOUNTAIN LEGAL NAME], its owners, employees and volunteers from claims for injury, death or damage arising from my use of the area, its lifts, rentals or lessons, including claims of negligence.

4. Rental equipment. Equipment I rent is set for the information I give. I will tell staff if that information is wrong, and I understand bindings will not release in every situation.

5. Medical care. I allow the mountain's patrol and staff to give me first aid and arrange emergency care if I need it.

6. Minors. If I sign for a child, I confirm I am their parent or legal guardian, and I agree to these terms for them.

7. Whole agreement. If part of this waiver is not enforceable, the rest still applies. This waiver lasts for the [SEASON] season.

I have read this waiver, I understand it, and I sign it of my own free will.`;
