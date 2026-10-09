// Help: short how-to articles for each app, searchable, shown only for what this person can use.
import { h, clear, ctx, can, input, empty } from '../ui.js';
import { SECTIONS, ARTICLES, articleById } from '../help-content.js';

const ALWAYS_ON = ['start', 'dashboard', 'people', 'myshifts', 'settings'];
const appOn = (key) => ALWAYS_ON.includes(key) || !ctx.me.modules || ctx.me.modules.includes(key);
const roleOk = (who) => who === null || who === undefined || can(...who);

const sectionOf = (key) => SECTIONS.find((s) => s.key === key);
const sectionOpen = (s) => appOn(s.key) && roleOk(s.who);
const articleOpen = (a) => { const s = sectionOf(a.app); return Boolean(s) && sectionOpen(s) && roleOk(a.who); };
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
  q.addEventListener('input', draw);
  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Help'), h('p', { class: 'muted' }, 'How to do things in SummitOps. You see what your role can use.'))),
    h('div', { class: 'help-search' }, q), results, grid, stuck());
}

function stuck() {
  return h('aside', { class: 'help-stuck' }, h('b', null, 'Still stuck? '), 'Ask your manager or owner. For a problem with SummitOps itself, they can reach whoever set up your mountain.');
}

function section(root, key) {
  const s = sectionOf(key);
  if (!s || !sectionOpen(s)) { root.append(back('#/help', 'All help'), empty('That topic is not available to you.')); return; }
  const list = visible().filter((a) => a.app === key);
  root.append(back('#/help', 'All help'), h('div', { class: 'page-head' }, h('div', null, h('h1', null, s.label), h('p', { class: 'muted' }, s.blurb))),
    list.length ? h('ul', { class: 'help-results' }, list.map((a) => articleLink(a))) : empty('No articles here yet.'), stuck());
}

function article(root, id) {
  const a = articleById(id);
  if (!a || !articleOpen(a)) { root.append(back('#/help', 'All help'), empty('That article is not available to you.')); return; }
  const s = sectionOf(a.app);
  const related = (a.related || []).map(articleById).filter((r) => r && articleOpen(r));
  root.append(back(`#/help/for-${a.app}`, s.label),
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
  else if (id.startsWith('for-')) section(root, id.slice(4));
  else article(root, id);
}
