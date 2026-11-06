// The second check before a sensitive action: "Confirm it is you". The person uses their passkey, a code from their app,
// or (when they have neither) their password. It lasts a few minutes, so a run of exports or refunds asks only once.
// api.js calls this when the server answers step_up_required, then sends the same request again.

import { post } from './api.js';
import { h, clear, dialog, input, field, errorBox, button } from './ui.js';
import * as passkey from './passkey.js';

let waiting = null; // one dialog at a time: several requests asking together share it

// details.scope 'records': the patient-record check (feat/auth-hardening). Asked in place when someone opens a case that is
// not their own recent work; the case opens straight after. One check covers patient records for 30 minutes. Gloves in
// mind: the passkey is one large button, first.
export function confirmItsYou(details = {}) {
  if (waiting) return waiting;
  const records = details.scope === 'records';
  waiting = new Promise((resolve, reject) => {
    let done = false;
    const finish = (ok, err) => { if (done) return; done = true; waiting = null; dlg.close(); if (ok) resolve(); else reject(err || new Error(records ? 'Not confirmed, so the record stays closed' : 'Not confirmed, so nothing was changed')); };
    const slot = h('div');
    const body = records
      ? h('div', { class: 'stack', 'data-step-up': 'records' }, h('p', null, 'This patient record is not one of your cases from this shift. Confirm it is you to open it.'),
        h('p', { class: 'muted small' }, 'Patient records are private. One check opens older and other people\'s cases for the next 30 minutes, and every open is on the access log.'), slot)
      : h('div', { class: 'stack', 'data-step-up': '' }, h('p', null, `To ${details.what || 'do this'}, confirm it is you.`), h('p', { class: 'muted small' }, 'Being signed in is not enough for this. You will not be asked again for the next few minutes.'), slot);
    const dlg = dialog(records ? 'Open a patient record' : 'Confirm it is you', body, { onClose: () => finish(false) });
    const scope = records ? { scope: 'records' } : {};
    (async () => {
      let opts;
      try { opts = await post('/auth/step-up/options', scope); } catch (e) { slot.append(errorBox(e)); return; }
      const err = h('div');
      const go = async (payload, btn) => {
        clear(err);
        if (btn) btn.disabled = true;
        try { await post('/auth/step-up', { ...payload, ...scope }); finish(true); } catch (e) { err.append(errorBox(e)); if (btn) btn.disabled = false; }
      };
      const parts = [];
      if (opts.methods.includes('passkey') && opts.passkey) {
        const b = button(records ? 'Use my passkey to open it' : 'Use my passkey', async () => {
          clear(err);
          try {
            const fresh = b.dataset.used ? await post('/auth/step-up/options', scope) : opts; // a challenge works once
            b.dataset.used = '1';
            const response = await passkey.use(fresh.passkey.options);
            await go({ handle: fresh.passkey.handle, response }, b);
          } catch (e) { err.append(errorBox(e)); }
        }, { kind: 'primary' });
        if (records) b.classList.add('big', 'passkey-big');
        parts.push(h('div', { class: 'row' }, b));
      }
      if (opts.methods.includes('app')) {
        const code = input({ name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, 'aria-label': 'Six-digit code' });
        const f = h('form', { class: 'stack', novalidate: true }, field(opts.methods.includes('passkey') ? 'Or the code from your authenticator app' : 'Code from your authenticator app', code), h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn primary' }, 'Confirm')));
        f.addEventListener('submit', (e) => { e.preventDefault(); go({ code: code.value.trim() }, f.querySelector('button')); });
        parts.push(f);
      }
      if (opts.methods.includes('password')) {
        const pw = input({ name: 'password', type: 'password', autocomplete: 'current-password' });
        const f = h('form', { class: 'stack', novalidate: true }, field('Your password', pw), h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn primary' }, 'Confirm')));
        f.addEventListener('submit', (e) => { e.preventDefault(); go({ password: pw.value }, f.querySelector('button')); });
        parts.push(f);
      }
      slot.append(...parts, err, h('div', { class: 'footer row' }, button('Cancel', () => finish(false))));
      const first = slot.querySelector('input, .btn.primary');
      if (first) first.focus();
    })();
  });
  return waiting;
}
