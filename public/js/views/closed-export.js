// A closed mountain, for its owner, during the export window (2026.11.11): download the records, and nothing else.
import { get, download } from '../api.js';
import { h, clear, button, fail, fmtDay } from '../ui.js';

export async function show(app, signOut) {
  clear(app);
  const box = h('section', { class: 'closed-export' });
  app.append(h('main', { class: 'closed-export-page' }, box));
  try {
    const x = await get('/closed-export');
    box.append(
      h('h1', null, `${x.mountain} is closed`),
      h('p', null, `You can download the mountain’s records until ${fmtDay(x.delete_after)}. After that day the data is deleted, except the records the law requires us to keep (patrol reports, signed waivers, the injury log and the audit trail).`),
      h('ul', { class: 'closed-export-files' }, ...x.files.map((f) => h('li', null, button(`Download ${f.label}`, async () => { try { await download(f.href, `${f.label.toLowerCase().replace(/\s+/g, '-')}.csv`); } catch (e) { fail(e); } }, { small: true })))),
      h('p', { class: 'muted' }, 'Each download is a spreadsheet. If one says the app is off for your mountain, it had no records of that kind. Questions: reply to the closing email from Verdynt/OS.'),
      button('Sign out', () => signOut()),
    );
  } catch (e) { box.append(h('p', null, 'This mountain is closed.'), button('Sign out', () => signOut())); fail(e); }
}
