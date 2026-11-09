// Help: short how-to articles for each app, searchable, shown only for what this person can use.
import { h, clear, ctx, can, isManager, schoolCan, input, empty, errorBox, state, label, backTo, hashParam } from '../ui.js';
import { get, post, session } from '../api.js';
import { SECTIONS, ARTICLES, articleById } from '../help-content.js';

const ALWAYS_ON = ['start', 'dashboard', 'people', 'myshifts', 'settings'];
const appOn = (key) => ALWAYS_ON.includes(key) || !ctx.me.modules || ctx.me.modules.includes(key);
const roleOk = (who) => who === null || who === undefined || can(...who);

const sectionOf = (key) => SECTIONS.find((s) => s.key === key);
const sectionOpen = (s) => appOn(s.key) && roleOk(s.who);
// A school director sees the ski school's manager articles too.
const articleOpen = (a) => { const s = sectionOf(a.app); return Boolean(s) && sectionOpen(s) && (roleOk(a.who) || (a.app === 'school' && schoolCan('director'))); };
const visible = () => ARTICLES.filter(articleOpen);

const words = (text) => String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const haystack = (a) => `${a.title} ${a.keywords || ''} ${a.intro} ${(a.steps || []).join(' ')} ${(a.tips || []).join(' ')} ${(sectionOf(a.app) || {}).label || ''}`.toLowerCase();
/** Every word typed must appear somewhere in the article; title matches come first. */
function search(query) {
  const q = words(query);
  if (!q.length) return [];
  return visible().map((a) => {
    const text = haystack(a); const title = a.title.toLowerCase();
    if (!q.every((w) => text.includes(w))) return null;
    return { a, score: q.reduce((n, w) => n + (title.includes(w) ? 3 : 0) + ((a.keywords || '').toLowerCase().includes(w) ? 1 : 0), 0) };
  }).filter(Boolean).sort((x, y) => y.score - x.score).map((x) => x.a);
}

const back = (href, text) => h('p', { class: 'help-back' }, h('a', { href }, `← ${text}`));

// Patrol's four parts (Now, Cases, People, Gear) and their articles: Help opened from Patrol, Gear opens Gear help.
const PATROL_PARTS = {
  now: ['Now', 'Who is on, the calls, the map and today\u2019s checks.', ['patrol-duty', 'patrol-sweep', 'patrol-1111-sweep', 'patrol-log', 'patrol-avalanche', 'patrol-locate', 'patrol-find', 'patrol-offline', 'patrol-1111-offline']],
  cases: ['Cases', 'Every patrol report and what follows from it.', ['patrol-case', 'patrol-records-check', 'patrol-checklists', 'patrol-bedside', 'patrol-errors', 'patrol-photos', 'patrol-1111-photos', 'patrol-review', 'patrol-followup', 'patrol-records', 'patrol-1111-records', 'patrol-claim-file', 'patrol-requirements', 'patrol-conditions', 'patrol-rentals', 'patrol-staff', 'park-patrol', 'attr-patrol', 'patrol-scene', 'patrol-secure-links', 'patrol-witness-links', 'patrol-network', 'patrol-doc-score', 'patrol-risk-report', 'patrol-access-summary', 'patrol-1111-access']],
  people: ['People', 'The schedule, crews, posts, roster and training.', ['patrol-schedule', 'patrol-crews', 'patrol-cover', 'patrol-roster', 'patrol-roster-off', 'patrol-access']],
  gear: ['Gear', 'Kits, equipment, medications, lift evacuation and help signs.', ['patrol-kits', 'patrol-meds', 'patrol-1111-meds', 'patrol-lifts', 'patrol-map-places', 'patrol-map-turn', 'patrol-help-signs']],
};
/** The back link to the page Help was opened from, when it was in this app (Patrol, Gear). */
function backToApp(key) {
  const was = backTo();
  return was && was.key === key ? back(was.hash, `Back to ${was.name}`) : null;
}
const articleLink = (a, withSection) => h('li', null, h('a', { href: `#/help/${a.id}` }, a.title), withSection ? h('small', { class: 'muted' }, ` ${sectionOf(a.app).label}`) : null);

function home(root) {
  const q = input({ type: 'search', placeholder: 'Search help, for example "refund" or "scan a receipt"', 'aria-label': 'Search help', autocomplete: 'off' });
  const results = h('div', { 'aria-live': 'polite' });
  const grid = h('div', { class: 'help-grid' }, SECTIONS.filter(sectionOpen).map((s) => {
    const list = visible().filter((a) => a.app === s.key);
    if (!list.length) return null;
    return h('section', { class: 'help-card' }, h('h2', null, h('a', { href: `#/help/for-${s.key}` }, s.label)), h('p', { class: 'muted' }, s.blurb),
      h('ul', null, list.slice(0, 4).map((a) => articleLink(a)), list.length > 4 ? h('li', null, h('a', { href: `#/help/for-${s.key}` }, `All ${list.length} articles`)) : null));
  }));
  const draw = () => {
    clear(results);
    if (!q.value.trim()) { grid.hidden = false; return; }
    grid.hidden = true;
    const found = search(q.value);
    results.append(found.length ? h('ul', { class: 'help-results' }, found.map((a) => articleLink(a, true))) : empty('Nothing matches that. Try a shorter word, or look through the topics.'));
  };
  // The assistant, when it is on: ask the words typed as a question, beside the articles that match them.
  const askRow = h('p', { class: 'help-ask', hidden: true });
  import('../assistant.js').then((m) => m.assistantOn().then((yes) => {
    if (!yes) return;
    const b = h('button', { type: 'button', class: 'btn small' }, 'Ask the assistant');
    b.addEventListener('click', () => m.openAssistant({ page: 'help', question: q.value.trim() || undefined }));
    askRow.append(b, h('span', { class: 'muted small' }, ' Type a question and it answers from these articles and your mountain\'s setup.'));
    askRow.hidden = false;
  })).catch(() => {});
  q.addEventListener('input', draw);
  const news = h('a', { class: 'whatsnew-link', href: '#/help/whats-new' }, h('b', null, "What's new"), h('span', { class: 'muted' }, ' The latest changes to Verdynt/OS'));
  get('/whats-new/count').then((c) => { if (c.unseen) news.append(h('span', { class: 'new-pill' }, 'New')); }).catch(() => {});
  const coming = isManager() ? h('a', { class: 'whatsnew-link', href: '#/help/coming' }, h('b', null, 'Coming to Verdynt/OS'), h('span', { class: 'muted' }, ' What we are building now, next and later')) : null;
  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Help'), h('p', { class: 'muted' }, 'How to do things in Verdynt/OS. You see what your role can use.'))),
    h('div', { class: 'help-news' }, news, coming), h('div', { class: 'help-search' }, q), askRow, results, grid, stuck(), versionLine());
}

/** "Verdynt/OS 2026.10.4 (build ac9a72f)": the version this screen is running, for telling support or checking an update. */
function versionLine() {
  const line = h('p', { class: 'version-line muted small' });
  fetch('/version', { headers: session.token ? { authorization: `Bearer ${session.token}` } : {} }).then((r) => r.json()).then((v) => { line.textContent = `Verdynt/OS ${v.version}${v.build && v.build !== 'dev' ? ` (build ${v.build})` : ''}`; }).catch(() => {});
  return line;
}

const KIND = { new: ['New', 'good'], improved: ['Improved', 'neutral'], fixed: ['Fixed', 'neutral'] };
const newer = (a, b) => { const x = String(a).split('.').map(Number); const y = String(b || '0').split('.').map(Number); for (let i = 0; i < 3; i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
const longDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

/** Help > What's new: each release, newest first, with only the changes for this person's role and apps. Opening it clears the badge. */
async function whatsNew(root) {
  root.append(back('#/help', 'All help'), h('div', { class: 'page-head' }, h('div', null, h('h1', null, "What's new"), h('p', { class: 'muted' }, 'Changes to Verdynt/OS, newest first. You see the ones for your role and the apps your mountain has.'))));
  let w;
  try { w = await get('/whats-new'); } catch (err) { root.append(errorBox(err)); return; }
  // Highlight what arrived since this person last looked (someone who never looked: the newest release).
  const isNew = (r, i) => (w.seen ? newer(r.version, w.seen) : i === 0) && w.unseen > 0;
  if (!w.releases.length) root.append(empty('Nothing to show yet.'));
  root.append(h('div', { class: 'releases' }, w.releases.map((r, i) => h('section', { class: `release${isNew(r, i) ? ' is-new' : ''}` },
    h('header', null, h('h2', null, r.title || `Version ${r.version}`), h('p', { class: 'muted small' }, `Version ${r.version}, ${longDate(r.date)}`, isNew(r, i) ? h('span', { class: 'new-pill' }, 'New to you') : null)),
    h('ul', { class: 'release-notes' }, r.notes.map((n) => {
      const art = n.help ? articleById(n.help) : null;
      const sec = n.app ? sectionOf(n.app) : null;
      return h('li', null, state(KIND[n.kind] ? KIND[n.kind][0] : label(n.kind), KIND[n.kind] ? KIND[n.kind][1] : 'neutral'),
        h('span', null, sec ? h('b', null, `${sec.label}: `) : null, n.text, art && articleOpen(art) ? [' ', h('a', { href: `#/help/${art.id}` }, 'How it works')] : null));
    }))))), stuck(), versionLine());
  if (w.unseen || w.seen !== w.version) {
    post('/whats-new/seen').then(() => window.dispatchEvent(new Event('whatsnew:seen'))).catch(() => {});
  }
}

/** Help > Coming to Verdynt/OS: the roadmap, for owners and managers. Not on the website. */
async function coming(root) {
  root.append(back('#/help', 'All help'), h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Coming to Verdynt/OS'),
    h('p', { class: 'muted' }, 'What we are building now, next and later. Plans change with what mountains ask for, so the order can move.'))));
  if (!isManager()) { root.append(empty('The roadmap is for owners and managers.')); return; }
  let r;
  try { r = await get('/whats-new/roadmap'); } catch (err) { root.append(errorBox(err)); return; }
  if (!r.stages.length) { root.append(empty('Nothing planned to show yet.')); return; }
  root.append(h('div', { class: 'roadmap' }, r.stages.map((st) => h('section', { class: `roadmap-stage is-${st.key}` },
    h('header', null, h('h2', null, st.label), st.when ? h('p', { class: 'muted small' }, st.when) : null),
    h('ul', { class: 'roadmap-items' }, st.items.map((it) => {
      const sec = it.app ? sectionOf(it.app) : null;
      return h('li', null, h('b', null, it.title), sec ? h('span', { class: 'roadmap-app muted small' }, sec.label) : null, h('p', null, it.text));
    }))))),
  h('aside', { class: 'help-stuck' }, h('b', null, 'Something you need? '), 'Tell us what would help your mountain most. What mountains ask for moves up the list.'),
  r.updated ? h('p', { class: 'version-line muted small' }, `Last updated ${longDate(r.updated)}`) : null);
}

/** "Still stuck?": everyone can ask their manager; managers and owners get the support address (from /version). */
function stuck() {
  const box = h('aside', { class: 'help-stuck' }, h('b', null, 'Still stuck? '));
  if (!isManager()) { box.append('Ask your manager or owner. They can reach Verdynt/OS support for a problem with Verdynt/OS itself.'); return box; }
  const mail = (addr) => h('a', { href: `mailto:${addr}?subject=${encodeURIComponent('Verdynt/OS help')}` }, addr);
  const fill = (addr) => box.append('Email ', mail(addr), '. Say what you were doing, what you expected and what happened, and include the version number at the bottom of this page.');
  fetch('/version').then((r) => r.json()).then((v) => fill(v.support_email || 'support@runmyresort.com')).catch(() => fill('support@runmyresort.com'));
  return box;
}

function section(root, key) {
  const s = sectionOf(key);
  if (!s || !sectionOpen(s)) { root.append(back('#/help', 'All help'), empty('That topic is not available to you.')); return; }
  const list = visible().filter((a) => a.app === key);
  const links = h('div', { class: 'help-backs' }, backToApp(key), back('#/help', 'All help'));
  // Patrol's Help from one of its parts: that part's articles first, then the rest of Patrol's.
  const part = key === 'patrol' ? PATROL_PARTS[hashParam('part')] : null;
  if (part) {
    const mine = part[2].map((id) => list.find((a) => a.id === id)).filter(Boolean);
    const rest = list.filter((a) => !mine.includes(a));
    root.append(links, h('div', { class: 'page-head' }, h('div', null, h('h1', null, `${s.label}: ${part[0]}`), h('p', { class: 'muted' }, part[1]))),
      mine.length ? h('ul', { class: 'help-results', 'data-part': hashParam('part') }, mine.map((a) => articleLink(a))) : empty('No articles here yet.'),
      rest.length ? h('h2', { class: 'help-more' }, `More ${s.label} help`) : null,
      rest.length ? h('ul', { class: 'help-results' }, rest.map((a) => articleLink(a))) : null, stuck());
    return;
  }
  root.append(links, h('div', { class: 'page-head' }, h('div', null, h('h1', null, s.label), h('p', { class: 'muted' }, s.blurb))),
    list.length ? h('ul', { class: 'help-results' }, list.map((a) => articleLink(a))) : empty('No articles here yet.'), stuck());
}

function article(root, id) {
  const a = articleById(id);
  if (!a || !articleOpen(a)) { root.append(back('#/help', 'All help'), empty('That article is not available to you.')); return; }
  const s = sectionOf(a.app);
  const related = (a.related || []).map(articleById).filter((r) => r && articleOpen(r));
  // From Patrol's Help for one part (Patrol: Gear), back to that part.
  const was = backTo();
  const part = a.app === 'patrol' && was && was.key === 'patrol' && PATROL_PARTS[was.part] && PATROL_PARTS[was.part][2].includes(a.id) ? was.part : null;
  root.append(part ? back(`#/help/for-patrol?part=${part}`, `${s.label}: ${PATROL_PARTS[part][0]}`) : back(`#/help/for-${a.app}`, s.label),
    h('article', { class: 'help-article' },
      h('h1', null, a.title),
      h('p', { class: 'help-intro' }, a.intro),
      a.steps && a.steps.length ? h('ol', null, a.steps.map((t) => h('li', null, t))) : null,
      a.tips && a.tips.length ? h('div', { class: 'help-tips' }, h('h2', null, 'Good to know'), h('ul', null, a.tips.map((t) => h('li', null, t)))) : null,
      related.length ? h('div', { class: 'help-related' }, h('h2', null, 'Related'), h('ul', null, related.map((r) => articleLink(r)))) : null,
      a.app !== 'start' && appOn(a.app) ? h('p', null, h('a', { class: 'btn small', href: `#/${a.app}` }, `Open ${s.label}`)) : null),
    stuck());
}

export async function render(root, params = []) {
  const [id] = params;
  if (!id) home(root);
  else if (id === 'whats-new') await whatsNew(root);
  else if (id === 'coming') await coming(root);
  else if (id.startsWith('for-')) section(root, id.slice(4));
  else article(root, id);
}
