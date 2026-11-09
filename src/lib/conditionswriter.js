'use strict';

// The conditions writer (AI Operations add-on, AI release 1). Each morning, once grooming and lift status are in (a time
// the mountain sets, 7:00 AM unless changed), and whenever someone presses Draft now, it reads the day: lifts and trails
// open, what was groomed, new snow and base from the crew's reading (or last night's day record), the weather logged
// today, and the day's hours and events from the calendar. From those facts it drafts four things:
//   1. the note on the public conditions feed (published on Approve, through lib/conditionsnote.js),
//   2. a snow report paragraph and 3. a social post under 280 characters (Copy buttons; nothing posts to social media),
//   4. a passholder email (sent on Approve only when "Also email passholders" is ticked, through lib/campaignsend.js,
//      so the consent history and unsubscribe rules apply).
// It is a proposal (lib/proposals.js): nothing is published or sent until a person approves it.
//
// Facts guard: the draft may only state numbers that are in the facts, and only name lifts and trails the mountain has.
// Every number and lift or trail name in the model's text is checked. A draft that fails is written once more with the
// problems named, and if that fails too, the plain template is used. With no AI key, or the month's allowance used, the
// template is used from the start. Every AI call is logged with its cost against the mountain's monthly cap.
//
// It never reads patrol tables or patient care records (test/proposals.test.js checks that).
const config = require('../config');
const { pool, rows, one } = require('../db');
const { conflict, bad } = require('./errors');
const { todayIn, nowIn, addDays } = require('./util');
const { liftWord } = require('./liftstatus');
const proposals = require('./proposals');
const modulesLib = require('./modules');

const KIND = 'conditions_update';
const ROLES = ['owner', 'manager', 'staff']; // staff: the lift and mountain crew who keep lifts and trails current today
const NEEDS = ['assistant_plus', 'conditions'];
const SOCIAL_MAX = 280;
const NOTE_MAX = 500;
const VOICE_MAX = 5;
const VOICE_CLIP = 600;
const DEFAULT_AT = '07:00';

// ---------------------------------------------------------------- the facts
const n = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const hm = (t) => (t ? String(t).slice(0, 5) : null);
const dateOnly = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/** "09:00" -> "9 AM", "16:30" -> "4:30 PM". */
function clock(t) {
  if (!t) return null;
  const [h, m] = String(t).split(':').map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

/** The day's facts for one mountain, from its own records. date defaults to today at the mountain. */
async function gather(db, tenantId, date) {
  const t = await one(db, 'SELECT id, name, timezone FROM tenants WHERE id = ?', [tenantId]);
  const today = date || todayIn(t.timezone);
  const yesterday = addDays(today, -1);
  const [day, lifts, trails, groomedPlan, snow, base, record, weather, events, published] = await Promise.all([
    one(db, 'SELECT status, open_time, close_time, notes FROM calendar_days WHERE tenant_id = ? AND on_date = ?', [tenantId, today]),
    rows(db, 'SELECT name, status FROM lifts WHERE tenant_id = ? ORDER BY name LIMIT 60', [tenantId]),
    rows(db, 'SELECT id, name, difficulty, status, groomed FROM trails WHERE tenant_id = ? ORDER BY name LIMIT 300', [tenantId]),
    rows(db, "SELECT DISTINCT trail_id FROM groom_plans WHERE tenant_id = ? AND status = 'done' AND plan_date BETWEEN ? AND ?", [tenantId, yesterday, today]),
    one(db, 'SELECT MAX(new_snow_in) AS v FROM snow_readings WHERE tenant_id = ? AND trail_id IS NULL AND DATE(read_at) = ?', [tenantId, today]),
    one(db, 'SELECT base_in AS v, surface FROM snow_readings WHERE tenant_id = ? AND trail_id IS NULL AND (base_in IS NOT NULL OR surface IS NOT NULL) AND DATE(read_at) BETWEEN ? AND ? ORDER BY read_at DESC, id DESC LIMIT 1', [tenantId, yesterday, today]),
    one(db, 'SELECT snowfall_in, crew_new_snow_in, crew_base_in FROM day_records WHERE tenant_id = ? AND on_date = ?', [tenantId, yesterday]),
    one(db, 'SELECT temp_f, wind_mph, gust_mph, sky, place FROM weather_logs WHERE tenant_id = ? AND DATE(logged_at) = ? ORDER BY logged_at DESC, id DESC LIMIT 1', [tenantId, today]),
    rows(db, 'SELECT title, starts_at FROM events WHERE tenant_id = ? AND starts_at >= ? AND starts_at < ? ORDER BY starts_at LIMIT 6', [tenantId, today, addDays(today, 1)]),
    // the note this writer already published today, so a second draft does not repeat itself
    one(db, "SELECT payload, edits FROM ai_proposals WHERE tenant_id = ? AND kind = ? AND status = 'approved' AND payload LIKE ? ORDER BY id DESC LIMIT 1", [tenantId, KIND, `%"date":"${today}"%`]),
  ]);
  const groomedIds = new Set(groomedPlan.map((g) => Number(g.trail_id)));
  const groomed = trails.filter((x) => Number(x.groomed) || groomedIds.has(Number(x.id)));
  let newSnow = n(snow && snow.v); let snowFrom = newSnow !== null ? 'crew' : null;
  if (newSnow === null && record) { newSnow = n(record.crew_new_snow_in) ?? n(record.snowfall_in); if (newSnow !== null) snowFrom = 'day record'; }
  let baseIn = n(base && base.v);
  if (baseIn === null && record) baseIn = n(record.crew_base_in);
  let lastNote = null;
  if (published) { try { const p = JSON.parse(published.payload); const e = published.edits ? JSON.parse(published.edits) : {}; lastNote = e.note || p.note || null; } catch (_) { /* none */ } }
  const dayNote = day && day.notes && day.notes !== lastNote ? String(day.notes) : null;
  const status = day ? day.status : 'closed';
  return {
    mountain: t.name, date: today, weekday: new Date(`${today}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
    status, day_set: Boolean(day), opens: status === 'closed' ? null : hm(day && day.open_time), closes: status === 'closed' ? null : hm(day && day.close_time),
    day_note: dayNote,
    lifts: lifts.map((l) => ({ name: l.name, status: l.status, word: liftWord(l.status) })),
    lifts_open: lifts.filter((l) => l.status === 'open').length, lifts_total: lifts.length,
    trails_open: trails.filter((x) => x.status === 'open').length, trails_total: trails.length,
    open_trails: trails.filter((x) => x.status === 'open').map((x) => x.name),
    trail_names: trails.map((x) => x.name),
    groomed: groomed.map((x) => x.name),
    new_snow_in: newSnow, new_snow_from: snowFrom, base_in: baseIn, surface: base && base.surface ? String(base.surface).replace(/_/g, ' ') : null,
    weather: weather ? { temp_f: n(weather.temp_f) === null ? null : Math.round(n(weather.temp_f)), wind_mph: n(weather.wind_mph), gust_mph: n(weather.gust_mph), sky: weather.sky } : null,
    events: events.map((e) => ({ title: e.title, time: hm(String(e.starts_at instanceof Date ? e.starts_at.toISOString().slice(11) : String(e.starts_at).slice(11))) })),
  };
}

// ---------------------------------------------------------------- the template (no AI, or the facts guard said no)
const plural = (k, one1, many) => `${k} ${k === 1 ? one1 : many || `${one1}s`}`;
const fmtIn = (v) => `${Number(v) % 1 ? Number(v).toFixed(1) : Number(v)}`;
const list = (xs, max = 6) => (xs.length <= max ? xs.join(', ') : `${xs.slice(0, max).join(', ')} and ${xs.length - max} more`);
const SKY = { clear: 'clear skies', partly: 'partly cloudy skies', overcast: 'overcast skies', snow: 'snow falling', rain: 'rain', mixed: 'mixed rain and snow', fog: 'fog' };

function template(f) {
  const closed = f.status === 'closed';
  const hours = f.opens && f.closes ? `${clock(f.opens)} to ${clock(f.closes)}` : null;
  const holds = f.lifts.filter((l) => l.status === 'hold' || l.status === 'wind_hold');
  const snowLine = f.new_snow_in ? `${fmtIn(f.new_snow_in)} in of new snow` : null;
  const baseLine = f.base_in !== null && f.base_in !== undefined ? `${fmtIn(f.base_in)} in base` : null;
  const liftsN = f.lifts_total ? `${f.lifts_open} of ${plural(f.lifts_total, 'lift')}` : null;
  const trailsN = f.trails_total ? `${f.trails_open} of ${plural(f.trails_total, 'trail')}` : null;
  const counts = [liftsN, trailsN].filter(Boolean).join(' and ');
  const liftsLine = liftsN ? `${liftsN} open` : null;
  const wx = f.weather ? [f.weather.sky ? SKY[f.weather.sky] || f.weather.sky : null, f.weather.temp_f !== null ? `${f.weather.temp_f} degrees` : null,
    f.weather.wind_mph ? `wind ${f.weather.wind_mph} mph${f.weather.gust_mph ? ` with gusts to ${f.weather.gust_mph}` : ''}` : null].filter(Boolean).join(', ') : null;
  const events = f.events.map((e) => `${e.title}${e.time ? ` at ${clock(e.time)}` : ''}`);
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

  let note; let report; let social; let subject; let body;
  if (closed) {
    note = [`${f.mountain} is closed today.`, f.day_note].filter(Boolean).join(' ');
    report = [`${f.mountain} is closed today, ${f.weekday}.`, f.day_note, snowLine ? `${cap(snowLine)} since yesterday.` : null, baseLine ? `${cap(baseLine)}.` : null, wx ? `On the mountain: ${wx}.` : null, 'Check back tomorrow for the next update.'].filter(Boolean).join(' ');
    social = `${f.mountain} is closed today.${snowLine ? ` ${cap(snowLine)}.` : ''} Watch for tomorrow's update.`;
    subject = `${f.mountain} is closed today`;
  } else {
    const parts = [hours ? `Open ${hours}.` : 'Open today.', counts ? `${cap(counts)} open.` : null,
      [snowLine, baseLine].filter(Boolean).length ? `${cap([snowLine, baseLine].filter(Boolean).join(', '))}.` : null,
      holds.length ? `${holds.map((l) => `${l.name} (${l.word.toLowerCase()})`).join(', ')}.` : null,
      f.groomed.length ? `Groomed: ${list(f.groomed)}.` : null, f.day_note].filter(Boolean);
    note = parts.join(' ');
    report = [`Good morning from ${f.mountain}.`, snowLine ? `We picked up ${snowLine}${baseLine ? ` on a ${baseLine}` : ''}.` : baseLine ? `The base is ${fmtIn(f.base_in)} in.` : null,
      counts ? `Today we have ${counts} open.` : null,
      f.lifts_open && f.lifts_open <= 4 ? `Running: ${list(f.lifts.filter((l) => l.status === 'open').map((l) => l.name))}.` : null,
      holds.length ? `${list(holds.map((l) => l.name))} ${holds.length === 1 ? 'is' : 'are'} on hold for now, and we will update as soon as that changes.` : null,
      f.groomed.length ? `The groomers worked ${list(f.groomed)}.` : null,
      wx ? `Expect ${wx}.` : null, events.length ? `On the calendar: ${events.join('; ')}.` : null, f.day_note,
      hours ? `Lifts run ${hours}.` : null].filter(Boolean).join(' ');
    social = [snowLine ? `${cap(snowLine)}!` : null, counts ? `${cap(counts)} open today.` : null, hours ? `Lifts run ${hours}.` : null].filter(Boolean).join(' ');
    subject = `${f.mountain} today: ${[snowLine, liftsLine].filter(Boolean).join(', ') || 'conditions'}`;
  }
  if (social.length > SOCIAL_MAX) social = `${social.slice(0, SOCIAL_MAX - 1).replace(/\s+\S*$/, '')}.`;
  body = `Hi {first_name},\n\n${report}\n\nSee you on the hill.`;
  return { note: note.slice(0, NOTE_MAX), snow_report: report, social, email_subject: subject.slice(0, 200), email_body: body.slice(0, 2000) };
}

// ---------------------------------------------------------------- the facts guard
const WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, dozen: 12, half: 0.5 };
const UNIT = /^(inch|inches|in|"|feet|foot|ft|lift|lifts|chair|chairs|trail|trails|run|runs|degree|degrees|mph|percent|%|of|new|more|hours?)$/i;
const NAME_TAIL = 'Lift|Chair|Chairlift|Express|Quad|Triple|Double|Six|Six-Pack|Sixpack|Pulse|Tram|Gondola|T-Bar|Tbar|J-Bar|Poma|Carpet|Tow|Run|Trail|Glade|Glades|Bowl|Chute|Chutes|Ridge|Way|Street|Lane|Alley|Highway|Slope|Face|Woods|Traverse|Cut|Cutoff';
const NAME_RE = new RegExp(`((?:[A-Z][\\w'’.-]*\\s+){1,3})(${NAME_TAIL})\\b`, 'g');
const LEAD = new Set(['the', 'our', 'every', 'all', 'each', 'this', 'that', 'today', 'tonight', 'no', 'both', 'any', 'one', 'two', 'three', 'four', 'five', 'six', 'more', 'most', 'some', 'its', 'your', 'a', 'an', 'and', 'with', 'on', 'off', 'new', 'first', 'last', 'open', 'groomed', 'fresh', 'from', 'at', 'in', 'to', 'good', 'great', 'morning']);
const GENERIC = new Set(['terrain park', 'tubing park', 'magic carpet', 'rope tow', 'beginner area']);

/** Every number the facts hold, in the forms a writer would use (9:00 is 9, 16:30 is 4 and 30). */
function allowedNumbers(f) {
  const out = new Set();
  const add = (v) => { if (v === null || v === undefined || v === '') return; const x = Number(v); if (!Number.isNaN(x)) { out.add(String(x)); out.add(String(Math.round(x))); } };
  const addTime = (t) => { if (!t) return; const [h, m] = String(t).split(':').map(Number); add(h); add(h % 12 === 0 ? 12 : h % 12); if (m) add(m); add(0); };
  [f.new_snow_in, f.base_in, f.lifts_open, f.lifts_total, f.trails_open, f.trails_total, f.groomed.length, f.lifts.filter((l) => l.status !== 'open' && l.status !== 'closed').length].forEach(add);
  if (f.weather) [f.weather.temp_f, f.weather.wind_mph, f.weather.gust_mph].forEach(add);
  addTime(f.opens); addTime(f.closes); f.events.forEach((e) => addTime(e.time));
  const [y, mo, d] = f.date.split('-').map(Number); add(y); add(mo); add(d);
  // numbers inside the mountain's own words: a note a manager wrote, an event's title
  for (const s of [f.day_note, ...f.events.map((e) => e.title)]) for (const m of String(s || '').matchAll(/\d+(?:\.\d+)?/g)) add(m[0]);
  return out;
}

/** Every name the facts hold (lifts, trails, events, the mountain), lower case, longest first. */
const knownNames = (f) => [...new Set([f.mountain, ...f.lifts.map((l) => l.name), ...f.trail_names, ...f.events.map((e) => e.title)].filter(Boolean).map((s) => String(s).toLowerCase()))].sort((a, b) => b.length - a.length);

/** Checks one draft against the facts. Returns the problems found (empty when it is fine). */
function check(draft, f) {
  const problems = [];
  const fields = ['note', 'snow_report', 'social', 'email_subject', 'email_body'];
  for (const k of fields) if (typeof draft[k] !== 'string' || !draft[k].trim()) problems.push(`${k} is missing`);
  if (problems.length) return problems;
  if (draft.social.length > SOCIAL_MAX) problems.push(`the social post is ${draft.social.length} characters (keep it under ${SOCIAL_MAX})`);
  if (draft.note.length > NOTE_MAX) problems.push(`the note is ${draft.note.length} characters (keep it under ${NOTE_MAX})`);
  const ok = allowedNumbers(f);
  const names = knownNames(f);
  const seenNum = new Set(); const seenName = new Set();
  for (const k of fields) {
    let text = String(draft[k]).replace(/\{(first_name|mountain)\}/g, ' ');
    // names that are in the facts may hold numbers of their own (Chair 2, Lift 6)
    const lower = text.toLowerCase();
    for (const nm of names) { let i = lower.indexOf(nm); while (i >= 0) { text = text.slice(0, i) + ' '.repeat(nm.length) + text.slice(i + nm.length); i = lower.indexOf(nm, i + nm.length); } }
    for (const m of text.matchAll(/\d+(?:[.,]\d+)?/g)) {
      const v = String(Number(m[0].replace(/,/g, '')));
      if (!ok.has(v) && !seenNum.has(v)) { seenNum.add(v); problems.push(`the number ${m[0]} is not in the facts`); }
    }
    for (const m of text.matchAll(/\b([A-Za-z]+)(?:[\s-]+)([A-Za-z%"]+)/g)) {
      const w = WORDS[m[1].toLowerCase()];
      if (w === undefined || !UNIT.test(m[2])) continue;
      const v = String(w);
      if (!ok.has(v) && !seenNum.has(v)) { seenNum.add(v); problems.push(`the number "${m[1]}" is not in the facts`); }
    }
    for (const m of String(draft[k]).matchAll(NAME_RE)) {
      const words = `${m[1]}${m[2]}`.trim().split(/\s+/);
      while (words.length > 1 && LEAD.has(words[0].toLowerCase())) words.shift();
      const cand = words.join(' ').toLowerCase();
      if (words.length < 2 || GENERIC.has(cand) || seenName.has(cand)) continue;
      if (names.some((nm) => nm.includes(cand) || cand.includes(nm))) continue;
      seenName.add(cand); problems.push(`"${words.join(' ')}" is not a lift or trail at this mountain`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------- the model
/** Up to five of the mountain's own past reports, clipped, with numbers masked so old numbers cannot leak into today's. */
function voiceOf(examples) {
  return (Array.isArray(examples) ? examples : []).map((s) => String(s || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, VOICE_MAX)
    .map((s) => (s.length > VOICE_CLIP ? `${s.slice(0, VOICE_CLIP).replace(/\s+\S*$/, '')}...` : s).replace(/\d+(?:[.,:]\d+)?/g, 'N'));
}

function factsForModel(f) {
  return {
    mountain: f.mountain, date: f.date, weekday: f.weekday, status: f.status === 'limited' ? 'open, limited terrain' : f.status,
    hours: f.opens && f.closes ? `${clock(f.opens)} to ${clock(f.closes)}` : null, note_from_managers: f.day_note,
    lifts: f.lifts.map((l) => `${l.name}: ${l.word}`), lifts_open: f.lifts_open, lifts_total: f.lifts_total,
    trails_open: f.trails_open, trails_total: f.trails_total, open_trails: f.open_trails.slice(0, 40), groomed_trails: f.groomed.slice(0, 30),
    new_snow_inches: f.new_snow_in, base_inches: f.base_in, surface: f.surface,
    weather_now: f.weather, events_today: f.events.map((e) => `${e.title}${e.time ? ` at ${clock(e.time)}` : ''}`),
  };
}

function prompt(f, voice) {
  const v = voiceOf(voice);
  const system = [
    `You write the morning conditions update for ${f.mountain}, a ski area. Write in plain, warm US English, in the mountain's own voice. No em dashes, no emojis, no hashtags unless the examples use them.`,
    'Rules:',
    '- Use only the facts given. Every number you write (snow, base, lifts and trails open, hours, temperature, wind) must be in the facts. Never estimate, round up or add a number.',
    '- Name only lifts and trails from the facts, spelled exactly as given. Say a lift on hold or wind hold is on hold; never call it open.',
    '- If the mountain is closed, say so plainly and do not describe skiing today.',
    '- Nothing about injuries, patrol, accidents or anyone by name.',
    `- The note is for the public conditions page: one to three short sentences, under ${NOTE_MAX} characters.`,
    '- The snow report is one paragraph of four to seven sentences.',
    `- The social post is under ${SOCIAL_MAX} characters.`,
    '- The passholder email has a short subject and a body that starts "Hi {first_name}," and ends with a short sign-off. Write {first_name} exactly so; it is filled in for each person.',
    'Answer with JSON only: {"note": "...", "snow_report": "...", "social": "...", "email_subject": "...", "email_body": "..."}',
    v.length ? `\nPast reports from this mountain, for its voice only (their numbers are hidden as N; never reuse their facts):\n${v.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '',
  ].join('\n');
  return { system, user: `Today's facts:\n${JSON.stringify(factsForModel(f))}` };
}

function parseDraft(text) {
  const s = String(text || '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const o = JSON.parse(s.slice(a, b + 1));
    const clean = (x) => (typeof x === 'string' ? x.replace(/\s*[—–]\s*/g, ', ').trim() : x);
    return { note: clean(o.note), snow_report: clean(o.snow_report), social: clean(o.social), email_subject: clean(o.email_subject), email_body: clean(o.email_body) };
  } catch (_) { return null; }
}

/**
 * Drafts the four pieces from the facts. call({ system, messages }) is the model (it throws when it cannot be used:
 * no key, the cap, an error). Returns { draft, by: 'assistant' | 'template', reason, tries }.
 */
async function draftFrom(f, { voice = [], call = null } = {}) {
  if (!call) return { draft: template(f), by: 'template', reason: 'no_ai', tries: 0 };
  const p = prompt(f, voice);
  const messages = [{ role: 'user', content: p.user }];
  let tries = 0; let last = null;
  for (let round = 0; round < 2; round += 1) {
    let reply;
    try { reply = await call({ system: p.system, messages }); } catch (err) { return { draft: template(f), by: 'template', reason: err.code === 'cap' ? 'cap' : 'unavailable', tries }; }
    tries += 1;
    const text = (reply.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');
    const d = parseDraft(text);
    const problems = d ? check(d, f) : ['the answer was not the JSON asked for'];
    if (!problems.length) return { draft: d, by: 'assistant', reason: null, tries };
    last = problems;
    messages.push({ role: 'assistant', content: text.slice(0, 6000) || '(nothing)' });
    messages.push({ role: 'user', content: `That draft has problems: ${problems.slice(0, 12).join('; ')}. Write it again using only the facts given, as JSON only.` });
  }
  return { draft: template(f), by: 'template', reason: 'facts', tries, problems: last };
}

/** The model as the writer uses it: the mountain's cap checked before each call, and each call logged with its cost. */
function modelFor(db, tenantId, userId) {
  if (!config.assistant.on) return null;
  const A = require('./assistant');
  return async ({ system, messages }) => {
    const set = await A.settingsOf(db, tenantId);
    const spent = await A.spentThisMonth(db, tenantId);
    if (spent.micros >= set.monthly_cap_cents * 10000) { const e = new Error('cap'); e.code = 'cap'; throw e; }
    const model = config.assistant.model;
    const reply = await A.callModel({ model, system, messages });
    const inT = Number((reply.usage || {}).input_tokens || 0); const outT = Number((reply.usage || {}).output_tokens || 0);
    await db.query('INSERT INTO assistant_log (tenant_id, audience, user_id, page, question, answer, model, input_tokens, output_tokens, cost_micros) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [tenantId, 'staff', userId || null, 'conditions', 'Conditions writer: morning draft', null, model, inT, outT, A.costMicros(model, inT, outT)]);
    return reply;
  };
}

// ---------------------------------------------------------------- settings
async function settingsOf(db, tenantId) {
  const s = await one(db, 'SELECT auto_on, draft_at, voice, last_drafted_on FROM conditions_writer_settings WHERE tenant_id = ?', [tenantId]);
  let voice = [];
  if (s && s.voice) { try { voice = JSON.parse(s.voice); } catch (_) { voice = []; } }
  return { auto_on: s ? Boolean(s.auto_on) : true, draft_at: s ? hm(s.draft_at) : DEFAULT_AT, voice: Array.isArray(voice) ? voice : [], last_drafted_on: s && s.last_drafted_on ? dateOnly(s.last_drafted_on) : null };
}

async function saveSettings(db, req, b) {
  const voice = (Array.isArray(b.voice) ? b.voice : []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, VOICE_MAX).map((x) => x.slice(0, 2000));
  if (b.draft_at !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.draft_at))) throw bad('Use a time like 07:00');
  const cur = await settingsOf(db, req.auth.tenantId);
  const next = { auto_on: b.auto_on === undefined ? cur.auto_on : Boolean(b.auto_on), draft_at: b.draft_at || cur.draft_at, voice: b.voice === undefined ? cur.voice : voice };
  await db.query(`INSERT INTO conditions_writer_settings (tenant_id, auto_on, draft_at, voice, updated_by) VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE auto_on = VALUES(auto_on), draft_at = VALUES(draft_at), voice = VALUES(voice), updated_by = VALUES(updated_by)`,
  [req.auth.tenantId, next.auto_on ? 1 : 0, `${next.draft_at}:00`, JSON.stringify(next.voice), req.auth.userId]);
  await require('./audit').audit(db, req, 'conditions_writer_settings', 'conditions_writer_settings', req.auth.tenantId, { auto_on: next.auto_on, draft_at: next.draft_at, examples: next.voice.length });
  return settingsOf(db, req.auth.tenantId);
}

// ---------------------------------------------------------------- making the proposal
/** Milliseconds until midnight at the mountain: a morning draft is for its own day only. */
function untilMidnight(tz) {
  const [h, m, s] = nowIn(tz).slice(11).split(':').map(Number);
  return Math.max(60000, ((24 * 60 - h * 60 - m) * 60 - s) * 1000);
}

/** Gathers the facts, drafts, and saves the proposal (in place of an older pending one). Returns { id, by, reason }. */
async function prepare(db, tenantId, { userId = null, source = 'schedule' } = {}) {
  const f = await gather(db, tenantId);
  const set = await settingsOf(db, tenantId);
  const out = await draftFrom(f, { voice: set.voice, call: modelFor(db, tenantId, userId) });
  const t = await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const payload = { date: f.date, ...out.draft, send_email: false };
  const summary = f.status === 'closed' ? 'Closed today' : [f.lifts_total ? `${f.lifts_open} of ${f.lifts_total} lifts` : null, f.trails_total ? `${f.trails_open} of ${f.trails_total} trails` : null,
    f.new_snow_in ? `${fmtIn(f.new_snow_in)} in new` : null, f.base_in !== null ? `${fmtIn(f.base_in)} in base` : null].filter(Boolean).join(', ');
  const id = await proposals.create(db, {
    tenantId, kind: KIND, title: `Conditions for ${f.weekday}`, summary,
    preview: { ...payload, by: out.by, fallback: out.reason, facts: { status: f.status, lifts_open: f.lifts_open, lifts_total: f.lifts_total, trails_open: f.trails_open, trails_total: f.trails_total, new_snow_in: f.new_snow_in, base_in: f.base_in, groomed: f.groomed.length } },
    payload, forRoles: ROLES, expiresAt: new Date(Date.now() + untilMidnight(t.timezone)), source,
  });
  await proposals.supersede(db, tenantId, KIND, id);
  return { id, by: out.by, reason: out.reason };
}

/** Draft now, from the conditions screen. */
async function draftNow(req) {
  const on = new Set(await modulesLib.enabledKeys(req.auth.tenantId));
  if (!NEEDS.every((k) => on.has(k))) throw conflict('The conditions writer comes with the AI Operations add-on. Add it under Settings, Billing and plan.');
  if (!proposals.roleAllows(req.auth, ROLES)) throw require('./errors').forbidden('Your role cannot do that');
  const out = await prepare(pool, req.auth.tenantId, { userId: req.auth.userId, source: 'draft_now' });
  await require('./audit').audit(pool, req, 'conditions_draft', 'ai_proposals', out.id, { by: out.by, fallback: out.reason });
  return out;
}

/**
 * The scheduled run (every 5 minutes, in the guests job): each mountain with the add-on, once a day, at or after its
 * draft time, on a day that is on its calendar. Claimed per day, so a second run or a second server does not draft twice.
 */
async function tick() {
  const list = await rows(pool, "SELECT id, timezone FROM tenants WHERE status = 'active' ORDER BY id");
  const out = { drafted: 0 };
  for (const t of list) {
    try {
      const on = new Set(await modulesLib.enabledKeys(t.id));
      if (!NEEDS.every((k) => on.has(k))) continue;
      const set = await settingsOf(pool, t.id);
      if (!set.auto_on) continue;
      const now = nowIn(t.timezone); const today = now.slice(0, 10);
      if (now.slice(11, 16) < set.draft_at || set.last_drafted_on === today) continue;
      if (!(await one(pool, 'SELECT 1 AS x FROM calendar_days WHERE tenant_id = ? AND on_date = ?', [t.id, today]))) continue; // not a day of the season
      await pool.query('INSERT IGNORE INTO conditions_writer_settings (tenant_id) VALUES (?)', [t.id]);
      const [claim] = await pool.query('UPDATE conditions_writer_settings SET last_drafted_on = ? WHERE tenant_id = ? AND (last_drafted_on IS NULL OR last_drafted_on < ?)', [today, t.id, today]);
      if (!claim.affectedRows) continue;
      await prepare(pool, t.id, { source: 'schedule' });
      out.drafted += 1;
    } catch (err) {
      console.error(JSON.stringify({ severity: 'ERROR', job: 'conditions_writer', tenant: t.id, message: err.message }));
    }
  }
  return out;
}

// ---------------------------------------------------------------- the proposal kind
proposals.register(KIND, {
  roles: ROLES,
  module: NEEDS,
  editable: [
    { key: 'note', label: 'Conditions page note', max: NOTE_MAX, required: true },
    { key: 'snow_report', label: 'Snow report', max: 3000 },
    { key: 'social', label: 'Social post', max: SOCIAL_MAX },
    { key: 'email_subject', label: 'Email subject', max: 200 },
    { key: 'email_body', label: 'Email', max: 2000 },
    { key: 'send_email', label: 'Also email passholders', type: 'boolean' },
  ],
  // Before anything is claimed: emailing passholders is a manager's job, with Messages on and email ready.
  async check(_db, ctx, p) {
    if (!p.send_email) return;
    const C = require('./campaignsend');
    await C.mayMessage(ctx);
    const why = await C.blockedFor(ctx.auth.tenantId, 'email');
    if (why) throw conflict(why);
    if (!String(p.email_subject || '').trim() || !String(p.email_body || '').trim()) throw bad('The email needs a subject and a message');
  },
  async run(db, ctx, p) {
    const t = await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [ctx.auth.tenantId]);
    if (p.date !== todayIn(t.timezone)) throw conflict('This draft is for another day. Draft it again.');
    await require('./conditionsnote').setNote(db, ctx, p.date, p.note);
    if (!p.send_email) return { published: true, emailed: false };
    const C = require('./campaignsend');
    try {
      const cid = await C.createAs(ctx, { name: `Conditions for ${p.date}`, channel: 'email', subject: p.email_subject, body: p.email_body, audience: 'passholders' });
      const r = await C.sendAs(ctx, cid, require('./baseurl').baseUrl(ctx));
      return { published: true, emailed: true, campaign_id: cid, total: r.total, sent: r.sent, failed: r.failed };
    } catch (err) {
      const e = new Error(`The note is published, but the email did not go: ${err.message}`); e.status = err.status; throw e;
    }
  },
  async forViewer(db, ctx) {
    let canEmail = false; let why = null; let passholders = null;
    try {
      const C = require('./campaignsend');
      await C.mayMessage(ctx);
      why = await C.blockedFor(ctx.auth.tenantId, 'email');
      canEmail = !why;
      const t = await one(db, 'SELECT id, timezone FROM tenants WHERE id = ?', [ctx.auth.tenantId]);
      passholders = (await require('./messaging').audienceOf(t, 'email', 'passholders')).length;
    } catch (err) { why = why || err.message; }
    return { can_email: canEmail, email_blocked: canEmail ? null : why, passholders };
  },
});

module.exports = { KIND, ROLES, NEEDS, gather, template, check, allowedNumbers, voiceOf, prompt, parseDraft, draftFrom, modelFor, settingsOf, saveSettings, prepare, draftNow, tick, clock, SOCIAL_MAX, NOTE_MAX };
