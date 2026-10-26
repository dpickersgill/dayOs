'use strict';

// The Verdynt/OS Assistant. Staff ask how to do things (answered from Help and What's new), about the mountain's own
// setup (hours, prices, programs, policies), and, with Assistant Plus, about its own data through read-only look-ups
// limited to what their role could see on screen. Guests (Assistant Plus, on the pages the mountain chooses) ask about
// hours, prices, programs and policies, and on the family page about their own family's places only.
//
// It never changes anything: it explains and links the screen. It never sees patient care records. Every question is
// logged, with its cost, against the mountain's monthly cap. Answers mark links as [[help:id]] and [[go:#/path]], and a
// question it cannot answer starts [[unsure]] so the screen offers "Ask support" (staff) or "Contact the mountain" (guests).
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { pool, rows, one } = require('../db');
const { AppError } = require('./errors');
const { todayIn, addDays } = require('./util');
const V = require('./version');
const modulesLib = require('./modules');
const tools = require('./assistanttools');

// ---------------------------------------------------------------- Help, as the assistant reads it
let helpCache = null;
async function help() {
  if (helpCache) return helpCache;
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'help-content.js'), 'utf8');
  const mod = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
  const sections = new Map(mod.SECTIONS.map((s) => [s.key, s]));
  helpCache = {
    sections,
    articles: mod.ARTICLES.map((a) => {
      const text = [a.intro, ...(a.steps || []).map((s, i) => `${i + 1}. ${s}`), ...(a.tips || []).map((t) => `Tip: ${t}`)].join('\n');
      return { ...a, text, words: words(`${a.title} ${a.title} ${a.title} ${a.keywords || ''} ${a.keywords || ''} ${text}`) };
    }),
  };
  return helpCache;
}

const STOP = new Set('a an the and or of to in on for is it i do how what when where who why can my our we you your this that with be at by from are was as if not no yes me us they them there their has have get set up'.split(' '));
function words(s) { return String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, '')); }

/** Who an article or section is for, as Help decides it: null everyone; a list, those roles (managers always); [] managers. */
const roleOk = (who, role) => who == null || ['owner', 'manager'].includes(role) || (who.length > 0 && who.includes(role));

/** The Help articles this person can read that best match the question (and the screen they are on). */
async function findArticles(question, { role, modules, page }, k = 6) {
  const h = await help();
  const q = words(question);
  const appOn = (key) => !key || ['start', 'dashboard', 'people', 'myshifts', 'settings', 'inbox'].includes(key) || modules.has(key) || (key === 'sell' && modules.has('sell'));
  const scored = [];
  for (const a of h.articles) {
    const sec = h.sections.get(a.app);
    if (sec && (!appOn(a.app) || !roleOk(sec.who, role))) continue;
    if (!roleOk(a.who === undefined ? null : a.who, role)) continue;
    let s = 0;
    for (const w of q) { const n = a.words.filter((x) => x === w).length; if (n) s += 1 + Math.log(n); }
    if (page && a.app === page) s += 0.75;
    if (s > 0) scored.push([s, a]);
  }
  return scored.sort((x, y) => y[0] - x[0]).slice(0, k).map(([, a]) => a);
}

// ---------------------------------------------------------------- the mountain's own setup
const money = (c) => (c == null ? null : `$${(Number(c) / 100).toFixed(2).replace(/\.00$/, '')}`);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Facts about the mountain, as short lines. Guests get only what is public. */
async function facts(db, tenantId, { audience, modules }) {
  const t = await one(db, 'SELECT name, slug, phone, address, timezone, waiver_text, online_shop, shop_message, shop_change_hours, shop_change_fee_cents, quick_sale FROM tenants WHERE id = ?', [tenantId]);
  const today = todayIn(t.timezone);
  const lines = [`Mountain: ${t.name}.${t.phone ? ` Phone ${t.phone}.` : ''}${t.address ? ` Address: ${t.address}.` : ''}`, `Today is ${WEEKDAYS[new Date(`${today}T12:00:00Z`).getUTCDay()]} ${today}.`];
  const base = config.site.appUrl || '';
  const cal = await rows(db, 'SELECT on_date, status, open_time, close_time, notes FROM calendar_days WHERE tenant_id = ? AND on_date BETWEEN ? AND ? ORDER BY on_date', [tenantId, today, addDays(today, 7)]);
  if (cal.length) lines.push(`Operating days: ${cal.map((d) => `${String(d.on_date).slice(0, 10)} ${d.status}${d.open_time ? ` ${String(d.open_time).slice(0, 5)}-${String(d.close_time || '').slice(0, 5)}` : ''}${d.notes ? ` (${d.notes})` : ''}`).join('; ')}.`);
  if (modules.has('conditions')) {
    const l = await one(db, "SELECT COUNT(*) AS n, SUM(status = 'open') AS open FROM lifts WHERE tenant_id = ?", [tenantId]);
    const tr = await one(db, "SELECT COUNT(*) AS n, SUM(status = 'open') AS open FROM trails WHERE tenant_id = ?", [tenantId]);
    const snow = await one(db, 'SELECT base_in, new_snow_in, read_at FROM snow_readings WHERE tenant_id = ? ORDER BY read_at DESC LIMIT 1', [tenantId]);
    if (Number(l.n)) lines.push(`Right now: ${Number(l.open || 0)} of ${l.n} lifts open, ${Number(tr.open || 0)} of ${tr.n} trails open.${snow ? ` Last snow report: base ${snow.base_in ?? '?'} in, new ${snow.new_snow_in ?? 0} in.` : ''}`);
  }
  const prods = await rows(db, `SELECT name, kind, base_price_cents, online, valid_days, uses FROM products WHERE tenant_id = ? AND active = 1 ${audience === 'guest' ? 'AND online = 1' : ''} ORDER BY kind, name LIMIT 40`, [tenantId]);
  if (prods.length) lines.push(`Products${audience === 'guest' ? ' sold online' : ''} (adult price): ${prods.map((p) => `${p.name} (${p.kind.replace(/_/g, ' ')}${p.valid_days > 1 ? `, ${p.valid_days} days` : ''}) ${money(p.base_price_cents)}${audience === 'staff' && p.online ? ', online' : ''}`).join('; ')}.`);
  if (t.online_shop) {
    lines.push(`Online ticket shop: ${base}/shop/${t.slug}.${t.shop_change_hours != null ? ` Guests can change a ticket's date online up to ${t.shop_change_hours} hours before${t.shop_change_fee_cents ? ` for a ${money(t.shop_change_fee_cents)} fee` : ''}.` : ''} Online tickets are not refundable online.${t.shop_message ? ` Note: ${t.shop_message}` : ''}`);
  }
  if (t.waiver_text) lines.push('Every skier needs a signed waiver for the season (signed online when buying, or at the window).');
  if (modules.has('school')) lines.push(`Lessons can be requested online at ${base}/book/${t.slug}.`);
  if (modules.has('programs')) {
    const progs = await rows(db, `SELECT p.*, ty.name AS type_name FROM programs p LEFT JOIN program_types ty ON ty.tenant_id = p.tenant_id AND ty.id = p.type_id WHERE p.tenant_id = ? AND p.active = 1 ${audience === 'guest' ? 'AND p.online = 1' : ''} ORDER BY p.name LIMIT 15`, [tenantId]);
    for (const p of progs) {
      const terms = await rows(db, `SELECT * FROM program_terms WHERE tenant_id = ? AND program_id = ? AND status ${audience === 'guest' ? "= 'open'" : "IN ('open','draft','closed')"} ORDER BY starts_on LIMIT 6`, [tenantId, p.id]);
      const tl = [];
      for (const s of terms) {
        const gs = await rows(db, `SELECT g.weekday, g.capacity, g.discipline, (SELECT COUNT(*) FROM program_enrollments e WHERE e.tenant_id = g.tenant_id AND e.group_id = g.id AND e.status = 'enrolled') AS n,
            (SELECT GROUP_CONCAT(DATE_FORMAT(x.starts_at, '%b %e') ORDER BY x.starts_at SEPARATOR ', ') FROM program_sessions x WHERE x.tenant_id = g.tenant_id AND x.group_id = g.id AND x.status = 'scheduled') AS dates,
            (SELECT GROUP_CONCAT(DATE_FORMAT(x.starts_at, '%b %e') SEPARATOR ', ') FROM program_sessions x WHERE x.tenant_id = g.tenant_id AND x.group_id = g.id AND x.status = 'standby') AS makeup
          FROM program_groups g WHERE g.tenant_id = ? AND g.term_id = ? ORDER BY g.weekday`, [tenantId, s.id]);
        const steps = (() => { try { return Array.isArray(s.price_steps) ? s.price_steps : JSON.parse(s.price_steps || '[]'); } catch (_) { return []; } })().filter((x) => x.until >= today);
        tl.push(`${s.name}${audience === 'staff' ? ` (${s.status})` : ''}: lessons ${money(s.price_cents)}${steps.length ? ` (early bird ${money(steps[0].price_cents)} until ${steps[0].until})` : ''}${p.includes_ticket ? `, lift ticket part ${money(s.ticket_cents)} (not charged with a season pass)` : ''}${p.includes_rental ? `, rental ${money(s.rental_cents)} if wanted` : ''}${p.offers_helmet ? `, helmet ${money(s.helmet_cents)} if wanted` : ''}, ${String(s.start_time).slice(0, 5)}-${String(s.end_time).slice(0, 5)}. Days: ${gs.map((g) => `${WEEKDAYS[g.weekday]}s${g.discipline !== 'any' ? ` (${g.discipline} only)` : ''} ${g.capacity != null && Number(g.n) >= g.capacity ? 'FULL (waitlist)' : `${g.capacity != null ? `${g.capacity - Number(g.n)} places left` : 'places available'}`}, dates ${g.dates || 'none'}${g.makeup ? `, makeup ${g.makeup} if needed` : ''}`).join('; ')}`);
      }
      lines.push(`Program "${p.name}"${p.type_name ? ` (${p.type_name})` : ''}${p.age_min != null || p.age_max != null ? `, ages ${p.age_min ?? 0}-${p.age_max ?? 99}` : ''}${p.description ? `. ${p.description}` : ''}${p.meeting_place ? `. Meet at ${p.meeting_place}` : ''}${p.what_to_bring ? `. Bring ${p.what_to_bring}` : ''}.`
        + `${p.sibling_mode !== 'none' && p.sibling_value ? ` Sibling discount: ${p.sibling_mode === 'percent' ? `${p.sibling_value}%` : money(p.sibling_value)} off lessons for the second and later child.` : ''}`
        + `${p.cancel_days != null ? ` Families can cancel online up to ${p.cancel_days} days before the first lesson${p.cancel_fee_cents ? ` (${money(p.cancel_fee_cents)} fee)` : ''}.` : ' Canceling is by calling the mountain.'}`
        + `${p.allow_switch ? ' Families can switch to another day with room from the family page.' : ''}${p.late_join === 'prorate' ? ' Joining late: pay for the lessons left.' : p.late_join === 'closed' ? ' No joining online after the first lesson.' : ''}`
        + `${p.policy_text ? ` Policy: ${p.policy_text}` : ''} Sessions: ${tl.join(' | ') || 'none open'}.`);
    }
    if (progs.length) lines.push(`Program registration: ${base}/programs/${t.slug}. Family page (sign in by email link): ${base}/family/${t.slug}.`);
  }
  if (audience === 'staff') {
    const ps = modules.has('programs') ? await require('./programplus').settingsOf(db, tenantId) : null;
    if (ps) lines.push(`Program settings: a season pass bought after registering means ${ps.pass_later === 'none' ? 'no change' : ps.pass_later === 'refund' ? 'a refund of the lift ticket part' : 'a credit'}; reminders ${ps.reminders}.`);
    lines.push(`Apps this mountain has: ${[...modules].join(', ')}.${t.quick_sale ? ' Quick sale (no customer name) is on.' : ''}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- settings, cap, cost
const SETTING_DEFAULTS = { staff_on: true, guest_pages: [], contact_email: null, monthly_cap_cents: 5000 };
const GUEST_PAGES = ['shop', 'programs', 'booking', 'family'];
async function settingsOf(db, tenantId) {
  const s = await one(db, 'SELECT * FROM assistant_settings WHERE tenant_id = ?', [tenantId]);
  if (!s) return { ...SETTING_DEFAULTS };
  return { staff_on: Boolean(s.staff_on), guest_pages: String(s.guest_pages || '').split(',').filter((p) => GUEST_PAGES.includes(p)), contact_email: s.contact_email, monthly_cap_cents: Number(s.monthly_cap_cents) };
}

// Dollars per million tokens. ASSISTANT_PRICES overrides as JSON: { "model": [input, output] }.
const PRICES = { 'claude-haiku-5-5': [0.10, 0.50], 'claude-sonnet-5-5': [2, 10] };
function priceOf(model) {
  try { const o = JSON.parse(process.env.ASSISTANT_PRICES || '{}'); if (o[model]) return o[model]; } catch (_) { /* fall through */ }
  return PRICES[model] || [3, 15];
}
/** Cost in millionths of a dollar: tokens times dollars per million tokens. */
const costMicros = (model, inT, outT) => { const [i, o] = priceOf(model); return Math.round(inT * i + outT * o); };

async function spentThisMonth(db, tenantId) {
  const r = await one(db, "SELECT COALESCE(SUM(cost_micros), 0) AS c, COUNT(*) AS n FROM assistant_log WHERE tenant_id = ? AND created_at >= DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01')", [tenantId]);
  return { micros: Number(r.c), questions: Number(r.n) };
}

// ---------------------------------------------------------------- the model
async function callModel({ model, system, messages, tools: toolDefs }) {
  const c = config.assistant;
  const body = { model, max_tokens: 900, system, messages, ...(toolDefs && toolDefs.length ? { tools: toolDefs } : {}) };
  let res;
  try {
    res = await fetch(`${c.apiBase}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': c.key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  } catch (_) { throw new AppError(502, 'The assistant could not be reached. Try again in a moment.'); }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const said = String((err.error && err.error.message) || '').slice(0, 300);
    require('./jobs').logFailure({ job: 'assistant', status: res.status, model, message: said || `HTTP ${res.status}` });
    const e = new AppError(502, `The assistant is not available right now (${res.status}).`);
    e.reason = reasonFor(res.status, said, model);
    lastError = { at: new Date().toISOString(), status: res.status, model, reason: e.reason, said };
    throw e;
  }
  return res.json();
}

/** The last error from Anthropic, for the operator's console. Mountains only see that the assistant is unavailable. */
let lastError = null;
const lastFailure = () => lastError;

/** What the operator can do about an error from Anthropic, in plain words. */
function reasonFor(status, said, model) {
  if (/credit balance/i.test(said)) return 'The assistant\'s Anthropic account is out of credit. Add credit under Billing in the Anthropic Console.';
  if (status === 401 || /api.key|x-api-key|authentication/i.test(said)) return 'The assistant\'s Anthropic key was not accepted. Set it again with scripts/assistant-key.sh.';
  if (status === 403) return 'The assistant\'s Anthropic key is not allowed to do this. Check the key\'s workspace and limits in the Anthropic Console.';
  if (status === 404 || /model/i.test(said)) return `Anthropic does not know the model "${model}". Set ASSISTANT_MODEL to a current model name.`;
  if (status === 429 || status === 529 || status >= 500) return 'Anthropic is busy right now. Try again in a minute.';
  return said ? `Anthropic said: ${said}` : null;
}

const RULES = (staff) => `Rules:
- Answer in plain, friendly words, as short as the question allows (usually under 120 words). Lists only for steps.
- Use only what is given here${staff ? ': the Help articles, the mountain facts, and look-up results' : ''}. Never invent features, buttons, settings, prices, dates or numbers.
- If the answer is not in what you were given, say so briefly and start your reply with [[unsure]].
- You cannot change anything. To help someone do something, explain the steps.
- Never say anything about patient care, medical records or patrol reports${staff ? ' beyond how the screens are used' : ''}.`;

/** Turns the model's link marks into checked links, and works out whether it was unsure. */
function shape(text, { helpIds, allowGo }) {
  let unsure = false;
  const links = [];
  let out = String(text || '').replace(/\[\[unsure\]\]/gi, () => { unsure = true; return ''; });
  out = out.replace(/\[\[help:([a-z0-9-]+)\]\]/gi, (_m, id) => { if (helpIds.has(id)) { if (!links.some((l) => l.help === id)) links.push({ help: id }); } return ''; });
  out = out.replace(/\[\[go:(#\/[a-z0-9-]+(?:\/[A-Za-z0-9_-]+)*)(?:\|([^\]]{1,40}))?\]\]/gi, (_m, href, label) => { if (allowGo && !links.some((l) => l.go === href)) links.push({ go: href, label: label || null }); return ''; });
  out = out.replace(/\[\[[^\]]*\]\]/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { answer: out, links, unsure };
}

/**
 * Answers one question. who = { tenantId, audience: 'staff'|'guest', userId, role, page, views (staff screen keys) }.
 * extra: text the caller adds (the family's own places on the family page). history: [{ q, a }] of this chat.
 */
async function ask(who, question, { history = [], extra = '' } = {}) {
  if (!config.assistant.on) throw new AppError(503, 'The assistant is not set up yet');
  const db = pool;
  const set = await settingsOf(db, who.tenantId);
  const spent = await spentThisMonth(db, who.tenantId);
  if (spent.micros >= set.monthly_cap_cents * 10000) throw new AppError(429, who.audience === 'staff' ? 'The assistant has used this month\'s allowance. It is back on the 1st, and Help still works.' : 'The assistant is resting until next month. Please call the mountain.');
  const modules = new Set(await modulesLib.enabledKeys(who.tenantId));
  const t = await one(db, 'SELECT name, timezone FROM tenants WHERE id = ?', [who.tenantId]);
  const today = todayIn(t.timezone);
  const isStaff = who.audience === 'staff';
  const plus = modules.has('assistant_plus');
  const articles = isStaff ? await findArticles(`${question} ${history.slice(-2).map((x) => x.q).join(' ')}`, { role: who.role, modules, page: who.page }) : [];
  const helpIds = new Set(articles.map((a) => a.id));
  const news = isStaff ? V.releasesFor({ role: who.role, modules: [...modules] }).filter((r) => V.compare(r.version, V.VERSION) <= 0).slice(0, 2) : [];
  const ctx = { tenantId: who.tenantId, role: who.role, modules, today };
  const toolList = isStaff && plus ? tools.toolsFor(ctx) : [];
  const model = toolList.length ? config.assistant.dataModel : config.assistant.model;

  const system = isStaff
    ? [`You are the Verdynt/OS Assistant inside the operations app at ${t.name}. You help a staff member whose role is "${who.role}". They are on the "${who.page || 'unknown'}" screen.`,
      RULES(true),
      '- Cite a Help article you used with [[help:article-id]] at the end. Link a screen with [[go:#/screen]] (screens they can open: ' + (who.views || []).join(', ') + ').',
      toolList.length ? '- For questions about this mountain\'s own numbers, people or schedule, use the look-up tools; give the numbers as they come back, with their date.' : '- You cannot look up live numbers, rosters or sales. If asked, say that needs Assistant Plus, or where on screen to find it.',
      `\nMountain facts:\n${await facts(db, who.tenantId, { audience: 'staff', modules })}`,
      `\nHelp articles:\n${articles.map((a) => `[${a.id}] ${a.title}\n${a.text}`).join('\n\n') || '(none matched)'}`,
      news.length ? `\nRecent changes (What's new):\n${news.map((r) => `${r.version} ${r.title}: ${r.notes.map((n) => n.text).join(' ')}`).join('\n')}` : ''].join('\n')
    : [`You are the assistant on ${t.name}'s ${who.page === 'family' ? 'family page' : who.page === 'programs' ? 'program registration page' : who.page === 'booking' ? 'lesson booking page' : 'online ticket shop'}. You help a guest.`,
      RULES(false),
      '- Only use the public facts below (and the family\'s own places, when given). Never say anything about other guests, staff or the business\'s internal matters.',
      '- For a refund, a change you cannot make, or anything not covered, tell them how (the family page, or calling the mountain) and start with [[unsure]] if you could not answer.',
      `\nFacts:\n${await facts(db, who.tenantId, { audience: 'guest', modules })}`,
      extra ? `\nThis family's places:\n${extra}` : ''].join('\n');

  const messages = [];
  for (const h of history.slice(-4)) { messages.push({ role: 'user', content: String(h.q).slice(0, 1000) }); messages.push({ role: 'assistant', content: String(h.a || '').slice(0, 2000) || '(no answer)' }); }
  messages.push({ role: 'user', content: question });
  const toolDefs = toolList.map((x) => ({ name: x.name, description: x.description, input_schema: x.input_schema }));
  let inT = 0; let outT = 0; const used = [];
  let reply;
  for (let round = 0; round < 4; round += 1) {
    try { reply = await callModel({ model, system, messages, tools: toolDefs }); } catch (e) {
      if (e.reason) e.message = isStaff ? 'The assistant is not available right now. Verdynt/OS has been told, and Help still has every article.' : 'Sorry, questions are not available right now. Please call the mountain.';
      throw e;
    }
    inT += Number((reply.usage || {}).input_tokens || 0); outT += Number((reply.usage || {}).output_tokens || 0);
    const calls = (reply.content || []).filter((b) => b.type === 'tool_use');
    if (!calls.length || reply.stop_reason !== 'tool_use') break;
    messages.push({ role: 'assistant', content: reply.content });
    const results = [];
    for (const call of calls) {
      const out = await tools.run(db, ctx, call.name, call.input);
      used.push({ tool: call.name, input: call.input });
      results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(out).slice(0, 12000) });
    }
    messages.push({ role: 'user', content: results });
  }
  const text = (reply.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const shaped = shape(text, { helpIds, allowGo: isStaff });
  const answer = shaped.answer || 'Sorry, I could not answer that.';
  const cost = costMicros(model, inT, outT);
  const [r] = await db.query('INSERT INTO assistant_log (tenant_id, audience, user_id, page, question, answer, sources, tools, model, input_tokens, output_tokens, cost_micros, unanswered) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [who.tenantId, who.audience, who.userId || null, who.page ? String(who.page).slice(0, 40) : null, question.slice(0, 1000), answer, JSON.stringify(shaped.links), JSON.stringify(used), model, inT, outT, cost, shaped.unsure ? 1 : 0]);
  const h = await help();
  return {
    id: r.insertId, answer, unsure: shaped.unsure, looked_up: used.map((u) => u.tool),
    links: shaped.links.map((l) => (l.help ? { kind: 'help', id: l.help, label: (h.articles.find((a) => a.id === l.help) || {}).title, href: `#/help/${l.help}` } : { kind: 'go', href: l.go, label: l.label })),
  };
}

/** A short reply Dan could send to a staff member's question the assistant could not answer. */
async function draftReply(row, mountain) {
  try {
    const out = await callModel({ model: config.assistant.model, system: `You draft short, friendly support replies for Verdynt/OS, operations software for ski areas. The person works at ${mountain}. Write only the reply, under 120 words. If you do not know the answer, write a reply that asks one clarifying question.`, messages: [{ role: 'user', content: `Their question: ${row.question}\nThe assistant answered: ${row.answer || '(nothing)'}` }] });
    return (out.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  } catch (_) { return null; }
}

module.exports = { lastFailure, ask, findArticles, facts, settingsOf, spentThisMonth, costMicros, shape, GUEST_PAGES, help, draftReply, SETTING_DEFAULTS };
