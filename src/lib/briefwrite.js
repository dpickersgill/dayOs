'use strict';

// The morning brief's words. The AI (the small model, through callModel, so its cost is logged against the mountain's
// monthly cap) turns the facts from lib/briefdata.js into a three-line summary, short sections and up to three suggested
// actions, each linking a screen. Then the facts guard: every number in the text must be one of the numbers in the
// facts. A brief that fails it, or a mountain with no AI key or at its cap, gets the template brief made from the same
// facts by code. Either way the brief is never an error.
const config = require('../config');
const { pool } = require('../db');
const { esc } = require('./format');
const { clock } = require('./util');

const AI_LABEL = 'Written by the assistant from today\'s data';
const TEMPLATE_LABEL = 'Made from today\'s data';
const MAX_ACTIONS = 3;

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
const list = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
const deg = (v) => `${v}°F`;
const money = (d) => `$${Number(d).toLocaleString('en-US')}`;
const fmtDay = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

// ---------------------------------------------------------------- the facts guard
/** Every number in the facts: numbers themselves, and the digits inside text (names like "Chair 2", dates, times). */
function factNumbers(data) {
  const set = new Set();
  const addText = (s) => {
    for (const m of String(s).matchAll(/\d+(?:\.\d+)?/g)) set.add(Number(m[0]));
    for (const m of String(s).matchAll(/\d{1,3}(?:,\d{3})+/g)) set.add(Number(m[0].replace(/,/g, '')));
  };
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'number') { set.add(v); set.add(Math.round(v)); set.add(Math.abs(v)); return; }
    if (typeof v === 'string') { addText(v); return; }
    if (Array.isArray(v)) { set.add(v.length); v.forEach(walk); return; } // how many of a list is a fact too
    if (typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(data);
  // Times of day as written on screen ("9:00 AM" from "09:00"): the hour on a 12-hour clock.
  const hours = (data.hours && [data.hours.open, data.hours.close]) || [];
  for (const h of hours) { const m = /(\d{1,2}):(\d{2})/.exec(String(h || '')); if (m) { set.add(Number(m[1]) % 12 || 12); set.add(Number(m[2])); } }
  return set;
}

/** The numbers in a piece of text: "1,250" is 1250, "$4,210" is 4210, "9:30 AM" is 9 and 30, "28°F" is 28. */
function textNumbers(text) {
  return [...String(text).matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, '')));
}

/** The numbers in the brief's text that are not in its facts (empty when every number checks out). */
function unknownNumbers(body, data) {
  const known = factNumbers(data);
  const words = [...body.summary, ...body.sections.flatMap((s) => [s.title, ...s.lines]), ...body.actions.map((a) => a.text)];
  const bad = [];
  for (const w of words) for (const n of textNumbers(w)) if (!known.has(n)) bad.push(n);
  return bad;
}

// ---------------------------------------------------------------- the template brief
function weatherLine(w) {
  if (!w || w.source === 'none') return w && w.crew_snow_report ? null : 'No forecast for the mountain yet. Set its map point in Settings to get one.';
  const parts = [];
  if (w.sky) parts.push(w.sky);
  if (w.high_f != null) parts.push(`high ${deg(w.high_f)}${w.low_f != null ? `, low ${deg(w.low_f)}` : ''}`);
  if (w.snow_in) parts.push(`${w.snow_in} in of snow`);
  else if (w.precip_in) parts.push(`${w.precip_in} in of rain or mixed`);
  if (w.wind_mph != null) parts.push(`wind ${w.wind_mph} mph${w.gust_mph != null ? `, gusts ${w.gust_mph} mph` : ''}`);
  return parts.length ? `${parts.join(', ')}.`.replace(/^./, (c) => c.toUpperCase()) : null;
}

function dayLine(d) {
  const when = d.hours && d.hours.open ? `, ${clock(d.hours.open)} to ${clock(d.hours.close)}` : '';
  if (d.day_before_opening) return `Opening day is tomorrow, ${fmtDay(d.date)}${when}.`;
  if (d.opening_day) return `Opening day${when}.`;
  return `Open today${when}.`;
}

/** What needs someone this morning, most urgent first: [{ text, href, why }]. */
function attention(d) {
  const out = [];
  const has = (href) => (d.screens || []).some((s) => s.href === href);
  const go = (href, fallback) => (has(href) ? href : has(fallback) ? fallback : null);
  const wh = d.wind_holds;
  if (wh && wh.lifts_over_limit.length) out.push({ why: `${plural(wh.lifts_over_limit.length, 'lift')} over the wind hold limit`, text: `Plan for wind holds on ${list(wh.lifts_over_limit.map((l) => l.lift))}`, href: go('#/conditions') });
  const l = d.lifts;
  if (l && l.failed_checks.length) out.push({ why: `${plural(l.failed_checks.length, 'failed lift check')}`, text: `Clear the failed check on ${list(l.failed_checks.map((x) => x.lift))} before loading`, href: go('#/conditions?tab=maint', '#/conditions') });
  if (d.lessons && d.lessons.classes_over_ratio.length) out.push({ why: `${plural(d.lessons.classes_over_ratio.length, 'class', 'classes')} over ratio`, text: 'Split or add an instructor to the classes over ratio', href: go('#/school') });
  if (d.lessons && d.lessons.lessons_without_instructor) out.push({ why: `${plural(d.lessons.lessons_without_instructor, 'lesson')} with no instructor`, text: 'Assign instructors to the lessons without one', href: go('#/school') });
  if (d.shifts && d.shifts.uncovered) out.push({ why: `${plural(d.shifts.uncovered, 'shift')} with nobody on ${d.shifts.uncovered === 1 ? 'it' : 'them'}`, text: 'Fill the open shifts', href: go('#/workforce', d.screens && d.screens[0] && d.screens[0].href) });
  if (l && l.with_open_work_orders.length) out.push({ why: `${plural(l.with_open_work_orders.length, 'lift')} with open work orders`, text: 'Check the open lift work orders', href: go('#/conditions?tab=maint', '#/conditions') });
  const u = d.unusual || {};
  if (u.shop_near_daily_limit) out.push({ why: 'the online shop near its daily limit', text: 'Decide whether to raise today\'s online limit', href: go('#/shop') });
  if (u.refunds_above_normal) out.push({ why: 'refunds above normal yesterday', text: 'Look over yesterday\'s refunds', href: go('#/money', '#/shop') });
  if (u.lesson_waitlist_growing) out.push({ why: 'the lesson waitlist growing', text: 'Open more lesson spots for the waitlist', href: go('#/school') });
  if (d.shifts && d.shifts.not_confirmed) out.push({ why: `${plural(d.shifts.not_confirmed, 'shift')} not confirmed`, text: 'Publish the draft shifts', href: go('#/workforce', d.screens && d.screens[0] && d.screens[0].href) });
  if (d.park && d.park.closed_count) out.push({ why: `${plural(d.park.closed_count, 'park feature')} closed`, text: 'Check the closed park features', href: go('#/park') });
  return out.filter((a) => a.href);
}

/** The brief made by code from the facts alone. */
function template(d) {
  const sections = [];
  const w = d.weather || {};
  const wl = weatherLine(w);
  const wx = [];
  if (wl) wx.push(wl);
  if (w.crew_snow_report) wx.push(`Crew snow report: ${w.crew_snow_report.new_snow_in ?? 0} in new${w.crew_snow_report.base_in != null ? `, ${w.crew_snow_report.base_in} in base` : ''}.`);
  const wh = d.wind_holds;
  if (wh) {
    for (const x of wh.lifts_over_limit) wx.push(`${x.lift}: gusts of ${x.gust_mph} mph are at or over its ${x.limit_mph} mph wind hold limit.`);
    for (const x of wh.lifts_near_limit) wx.push(`${x.lift}: gusts of ${x.gust_mph} mph are close to its ${x.limit_mph} mph limit.`);
    if (!wh.limits_set) wx.push('Wind hold limits are not set for any lift. A manager adds them under Mountain status, Maintenance, Lift inspections, Type.');
    else if (wh.limits_not_set) wx.push(`${plural(wh.limits_not_set, 'lift')} ${wh.limits_not_set === 1 ? 'has' : 'have'} no wind hold limit set.`);
  }
  if (wx.length) sections.push({ title: 'Weather and wind', lines: wx });

  if (d.visitors || d.revenue_yesterday) {
    const v = [];
    if (d.visitors) {
      v.push(`${plural(d.visitors.presold_tickets, 'ticket')} sold ahead for the day.`);
      v.push(d.visitors.expected_visits != null ? `About ${d.visitors.expected_visits} visits expected. ${d.visitors.expected_basis}` : d.visitors.expected_basis);
    }
    if (d.revenue_yesterday && d.revenue_yesterday.orders) v.push(`Yesterday: ${money(d.revenue_yesterday.revenue_dollars)} revenue from ${plural(d.revenue_yesterday.orders, 'order')}.`);
    sections.push({ title: 'Visitors', lines: v });
  }

  if (d.lessons) {
    const s = d.lessons;
    const v = [s.lessons ? `${plural(s.lessons, 'lesson')} booked with ${plural(s.students, 'student')}. ${plural(s.instructors_scheduled, 'instructor')} scheduled, ${s.instructors_assigned} assigned to lessons.` : 'No lessons booked yet.'];
    if (s.lessons_without_instructor) v.push(`${plural(s.lessons_without_instructor, 'lesson')} still ${s.lessons_without_instructor === 1 ? 'has' : 'have'} no instructor.`);
    for (const c of s.classes_over_ratio) v.push(`${c.lesson}: ${c.students} students, and ${c.band} classes take ${c.limit}.`);
    sections.push({ title: 'Lessons', lines: v });
  }

  if (d.lifts) {
    const l = d.lifts; const v = [];
    for (const x of l.failed_checks) v.push(`${x.lift}: the ${x.check} check failed (${fmtDay(x.date)}).`);
    for (const x of l.with_open_work_orders) v.push(`${x.lift}: ${plural(x.open_work_orders, 'open work order')}${x.titles.length ? ` (${x.titles.join('; ')})` : ''}.`);
    if (l.weekly_check_due_count) v.push(`Weekly check due on ${list(l.weekly_check_due)}${l.weekly_check_due_count > l.weekly_check_due.length ? ' and more' : ''}.`);
    sections.push({ title: 'Lifts', lines: v.length ? v : ['No open work orders or failed checks.'] });
  }

  if (d.park) sections.push({ title: 'Terrain park', lines: [d.park.closed_count ? `${plural(d.park.closed_count, 'feature')} closed: ${list(d.park.closed)}.` : 'No features closed.', ...(d.park.needs_attention_count ? [`${plural(d.park.needs_attention_count, 'feature')} need${d.park.needs_attention_count === 1 ? 's' : ''} attention.`] : [])] });

  if (d.shifts) {
    const s = d.shifts;
    const v = s.shifts ? [`${plural(s.shifts, 'shift')} on the schedule. ${s.uncovered} with nobody on ${s.uncovered === 1 ? 'it' : 'them'}, ${s.not_confirmed} not confirmed.`] : ['No shifts on the schedule.'];
    for (const x of s.by_department.filter((y) => y.uncovered || y.not_confirmed).slice(0, 4)) v.push(`${x.department}: ${x.uncovered} open, ${x.not_confirmed} not confirmed.`);
    sections.push({ title: 'Staff', lines: v });
  }

  if (d.patrol_yesterday) {
    const p = d.patrol_yesterday;
    sections.push({ title: 'Patrol yesterday', lines: p.total ? [`${plural(p.total, 'case')} yesterday.`, ...p.by_area.slice(0, 5).map((a) => `${a.area}: ${a.count}`)] : ['No patrol cases yesterday.'] });
  }

  const u = d.unusual || {}; const odd = [];
  if (u.refunds_above_normal) odd.push(`Refunds yesterday: ${u.refunds_above_normal.refunds} (${money(u.refunds_above_normal.refunded_dollars)}), about ${u.refunds_above_normal.usual_per_day} on a usual day.`);
  if (u.lesson_waitlist_growing) odd.push(`Lesson waitlist: ${u.lesson_waitlist_growing.waiting} waiting, ${u.lesson_waitlist_growing.added_last_day} added in the last day.`);
  if (u.ticket_waitlist_growing) odd.push(`Ticket waitlist: ${u.ticket_waitlist_growing.waiting} waiting, ${u.ticket_waitlist_growing.added_last_day} added in the last day.`);
  for (const x of u.shop_near_daily_limit || []) odd.push(`Online shop: ${x.what}, ${x.sold} of ${x.limit} sold.`);
  if (odd.length) sections.push({ title: 'Out of the ordinary', lines: odd });

  const att = attention(d);
  const second = d.visitors
    ? `${plural(d.visitors.presold_tickets, 'ticket')} sold ahead${d.visitors.expected_visits != null ? `, about ${d.visitors.expected_visits} visits expected` : ''}${d.lessons ? `, ${plural(d.lessons.lessons, 'lesson')} booked` : ''}.`
    : d.lessons ? `${plural(d.lessons.lessons, 'lesson')} booked with ${plural(d.lessons.students, 'student')}, ${plural(d.lessons.instructors_scheduled, 'instructor')} scheduled.`
      : d.patrol_yesterday ? (d.patrol_yesterday.total ? `${plural(d.patrol_yesterday.total, 'patrol case')} yesterday.` : 'No patrol cases yesterday.') : (wl || 'No forecast yet.');
  const summary = [
    `${dayLine(d)}${wl && (d.visitors || d.lessons || d.patrol_yesterday) ? ` ${wl}` : ''}`,
    second,
    att.length ? `Needs attention: ${list(att.slice(0, 3).map((a) => a.why))}.` : 'Nothing needs attention this morning.',
  ];
  return { summary, sections, actions: att.slice(0, MAX_ACTIONS).map((a) => ({ text: a.text, href: a.href })) };
}

// ---------------------------------------------------------------- the AI brief
const SYSTEM = `You write the morning brief for a ski area's staff: the facts of the day, read in a minute over coffee.
You get the day's facts as JSON. Reply with JSON only, in this shape:
{"summary": ["line 1", "line 2", "line 3"], "sections": [{"title": "Short title", "lines": ["one short sentence", "..."]}], "actions": [{"text": "What to do, as an instruction", "href": "#/screen"}]}
Rules:
- summary: exactly three short lines. The day and weather; the business of the day; what needs attention.
- sections: only for facts given, at most 6, each with 1 to 5 short lines. Keep the facts' own section names in plain words.
- actions: up to 3, the most useful things to do this morning. Each href must be one of the "screens" given.
- Use only numbers that appear in the facts, written the same way. Never work out new numbers: no totals, differences or percentages.
- "expected_visits" is a simple estimate: call it that.
- Plain US English, short sentences, no em dashes, no emojis, no names of people. Never mention patients or anything about a patrol case beyond the counts by area.`;

function parseReply(text) {
  const s = String(text || ''); const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let o; try { o = JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
  const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s*[—–]\s*/g, ', ').slice(0, max) : null);
  if (!o || !Array.isArray(o.summary)) return null;
  const summary = o.summary.map((x) => str(x, 240)).filter(Boolean).slice(0, 3);
  if (summary.length !== 3) return null;
  const sections = (Array.isArray(o.sections) ? o.sections : []).slice(0, 8).map((x) => ({ title: str(x && x.title, 60), lines: (Array.isArray(x && x.lines) ? x.lines : []).map((l) => str(l, 300)).filter(Boolean).slice(0, 6) })).filter((x) => x.title && x.lines.length);
  const actions = (Array.isArray(o.actions) ? o.actions : []).map((x) => ({ text: str(x && x.text, 160), href: str(x && x.href, 80) })).filter((x) => x.text && x.href);
  return { summary, sections, actions };
}

/**
 * Writes the brief. Returns { body, source: 'ai'|'template', reason (why the template was used), model, cost_micros }.
 * who: { tenantId, kind } for the cost log.
 */
async function write(data, who) {
  const tpl = (reason) => ({ body: template(data), source: 'template', reason, model: null, cost_micros: 0 });
  if (!config.assistant.on) return tpl('no_key');
  const A = require('./assistant');
  const set = await A.settingsOf(pool, who.tenantId);
  const spent = await A.spentThisMonth(pool, who.tenantId);
  if (spent.micros >= set.monthly_cap_cents * 10000) return tpl('cap');
  const model = config.assistant.model;
  let reply;
  try {
    reply = await A.callModel({ model, system: SYSTEM, messages: [{ role: 'user', content: `Facts for the ${data.brief.toLowerCase()} brief:\n${JSON.stringify(data)}` }] });
  } catch (_) { return tpl('model_error'); }
  const inT = Number((reply.usage || {}).input_tokens || 0); const outT = Number((reply.usage || {}).output_tokens || 0);
  const cost = A.costMicros(model, inT, outT);
  await pool.query("INSERT INTO assistant_log (tenant_id, audience, user_id, page, question, answer, model, input_tokens, output_tokens, cost_micros) VALUES (?, 'staff', NULL, 'brief', ?, NULL, ?, ?, ?, ?)",
    [who.tenantId, `Morning brief: ${data.brief.toLowerCase()} (${data.date})`, model, inT, outT, cost]);
  const text = (reply.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const body = parseReply(text);
  const out = (reason) => ({ ...tpl(reason), model, cost_micros: cost });
  if (!body) return out('bad_reply');
  const allowed = new Set((data.screens || []).map((s) => s.href));
  body.actions = body.actions.filter((a) => allowed.has(a.href)).slice(0, MAX_ACTIONS);
  if (unknownNumbers(body, data).length) return out('facts');
  return { body, source: 'ai', reason: null, model, cost_micros: cost };
}

// ---------------------------------------------------------------- email
const labelOf = (source) => (source === 'ai' ? AI_LABEL : TEMPLATE_LABEL);

/** The email: one page, with a plain text part. brief: { body, source, for_date, kind }. */
function renderEmail(brief, tenant, link) {
  const b = brief.body;
  const day = fmtDay(brief.for_date);
  const title = brief.for_date !== brief.sent_on ? `Morning brief for ${day}` : `Morning brief, ${day}`;
  const screen = (href) => `${link.replace(/#.*$/, '')}${href}`;
  const text = [
    `${tenant.name}: ${title}`, '',
    ...b.summary, '',
    ...b.sections.flatMap((s) => [s.title.toUpperCase(), ...s.lines.map((l) => `- ${l}`), '']),
    ...(b.actions.length ? ['SUGGESTED', ...b.actions.map((a, i) => `${i + 1}. ${a.text}: ${screen(a.href)}`), ''] : []),
    `${labelOf(brief.source)}.`,
    `Read it in the app: ${link}`,
    'Turn it off or choose email or phone alerts in Settings, Morning brief.',
  ].join('\n');
  const f = "font-family:'Atkinson Hyperlegible',Arial,Helvetica,sans-serif";
  const h = "font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif";
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#edf1f3">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#edf1f3"><tr><td align="center" style="padding:20px 10px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;${f};color:#0e2632">
<tr><td style="background:#0e2632;padding:18px 24px">
  <div style="${h};font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#d8b672">${esc(tenant.name)}</div>
  <div style="${h};font-size:26px;font-weight:700;color:#ffffff;margin-top:2px">${esc(title)}</div>
</td></tr>
<tr><td style="padding:20px 24px 6px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7efdc;border-left:4px solid #9a7630;border-radius:6px"><tr><td style="padding:12px 16px;font-size:15px;line-height:1.5">
  ${b.summary.map((l) => `<div style="margin:3px 0">${esc(l)}</div>`).join('')}
  </td></tr></table>
</td></tr>
${b.sections.map((s) => `<tr><td style="padding:12px 24px 0">
  <div style="${h};font-size:17px;font-weight:700;color:#1d4452;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid #d3dce1;padding-bottom:4px">${esc(s.title)}</div>
  <ul style="margin:6px 0 0;padding-left:18px;font-size:14px;line-height:1.5">${s.lines.map((l) => `<li style="margin:2px 0">${esc(l)}</li>`).join('')}</ul>
</td></tr>`).join('')}
${b.actions.length ? `<tr><td style="padding:16px 24px 0">
  <div style="${h};font-size:17px;font-weight:700;color:#0e2632;text-transform:uppercase;letter-spacing:.04em">Suggested</div>
  ${b.actions.map((a) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:8px"><tr><td style="background:#d8b672;border-radius:6px"><a href="${esc(screen(a.href))}" style="display:inline-block;padding:9px 14px;color:#0e2632;font-weight:700;font-size:14px;text-decoration:none">${esc(a.text)}</a></td></tr></table>`).join('')}
</td></tr>` : ''}
<tr><td style="padding:20px 24px 22px">
  <div style="font-size:12px;color:#4f636d;border-top:1px solid #d3dce1;padding-top:10px">${esc(labelOf(brief.source))}. <a href="${esc(link)}" style="color:#1d4452">Read it in the app</a>. Turn it off or choose email or phone alerts in Settings, Morning brief.</div>
</td></tr>
</table></td></tr></table></body></html>`;
  return { subject: `${tenant.name}: ${title}`, text, html };
}

module.exports = { write, template, renderEmail, parseReply, unknownNumbers, factNumbers, textNumbers, AI_LABEL, TEMPLATE_LABEL, labelOf, SYSTEM };
