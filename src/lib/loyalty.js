'use strict';
// Loyalty and memories (guests round 2, Track LOYALTY): birthday gifts, the loyalty rules (every Nth paid day free, top
// loyalists, milestones, the first-timer ladder), day and season recaps, badges for the welcome-back card, and the
// managers' report. Rewards are issued only through lib/rewards.issue, once per source (source_key). Emails go to the
// guest, or to a parent for a child. Texts only where the mountain can text and the guest said yes (the consent ledger).
// Never anything about allergies or medical notes.
const crypto = require('crypto');
const { z } = require('zod');
const { pool, tx, rows, one } = require('../db');
const { todayIn, nowIn, addDays, weekdayOf, seasonFor, dayRange, localTime } = require('./util');
const { dayText, esc, money } = require('./format');
const { audit } = require('./audit');
const G = require('./guestsettings');
const R = require('./rewards');
const V = require('./guestvisits');
const L = require('./levels');
const mailer = require('./mailer');
const sms = require('./sms');
const { currentConsent } = require('./consent');

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const newToken = () => crypto.randomBytes(24).toString('base64url');
const MILESTONES = [10, 25, 50, 100];
const LADDER = 3; // lessons on the first-timer ladder
const ord = (n) => { const s = ['th', 'st', 'nd', 'rd']; const v = n % 100; return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`; };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const asDay = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);
// A job is not a person: its audit rows have no user.
const jobReq = (tenantId) => ({ auth: { tenantId, userId: null }, ip: null });

// ---------------------------------------------------------------- settings the shared guest_settings does not hold
const EXTRA = {
  recap_time: '18:00', loyalty_product_id: null, milestone_credit_cents: null, milestone_percent: null,
  firsttimer_percent: 50, firsttimer_product_id: null, top_credit_cents: null, season_recap_sent: null,
};
const extraSchema = z.object({
  recap_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 18:00'),
  loyalty_product_id: z.number().int().positive().nullable(),
  milestone_credit_cents: z.number().int().min(0).max(1_000_000).nullable(),
  milestone_percent: z.number().int().min(1).max(100).nullable(),
  firsttimer_percent: z.number().int().min(1).max(100),
  firsttimer_product_id: z.number().int().positive().nullable(),
  top_credit_cents: z.number().int().min(0).max(1_000_000).nullable(),
}).partial();

async function extra(db, tenantId) {
  const row = await one(db, 'SELECT * FROM guest_loyalty_settings WHERE tenant_id = ?', [tenantId]);
  const out = { ...EXTRA };
  if (row) for (const k of Object.keys(EXTRA)) if (row[k] !== undefined) out[k] = row[k];
  return out;
}
async function saveExtra(conn, tenantId, fields) {
  const keys = Object.keys(fields).filter((k) => k in EXTRA);
  if (!keys.length) return;
  await conn.query(`INSERT INTO guest_loyalty_settings (tenant_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})
    ON DUPLICATE KEY UPDATE ${keys.map((k) => `${k} = VALUES(${k})`).join(', ')}`, [tenantId, ...keys.map((k) => fields[k])]);
}

// ---------------------------------------------------------------- the season and birthdays
/**
 * The season a day belongs to: { label, opens, ends, assumed: { opens, ends } }. Opening is guest_settings.season_opens_on
 * and the end tenants.season_ends_on; a date from an earlier year keeps its month and day. Not set: Nov 15 to Apr 15.
 */
function seasonWindow(opensOn, endsOn, day) {
  const label = seasonFor(day);
  const y = Number(label.slice(0, 4));
  const place = (d) => { const md = String(d).slice(5, 10); return `${Number(md.slice(0, 2)) >= 8 ? y : y + 1}-${md}`; };
  const o = asDay(opensOn); const e = asDay(endsOn);
  return {
    label,
    opens: o ? (seasonFor(o) === label ? o : place(o)) : `${y}-11-15`,
    ends: e ? (seasonFor(e) === label ? e : place(e)) : `${y + 1}-04-15`,
    assumed: { opens: !o, ends: !e },
  };
}
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
/** A birthday (month and day of a date of birth) in a year; Feb 29 is Feb 28 in other years. */
function birthdayIn(dob, year) {
  const md = String(dob).slice(5, 10);
  return md === '02-29' && !isLeap(year) ? `${year}-02-28` : `${year}-${md}`;
}
/** A birthday in a season (Aug to Jul): '2026-27' and a Jan birthday -> 2027. */
function inSeasonYear(dob, label) {
  const y = Number(label.slice(0, 4));
  return birthdayIn(dob, String(dob).slice(5, 10) >= '08-01' ? y : y + 1);
}
/** The next birthday on or after a day. */
function nextBirthday(dob, day) {
  const y = Number(day.slice(0, 4));
  const b = birthdayIn(dob, y);
  return b >= day ? b : birthdayIn(dob, y + 1);
}
function ageOn(dob, day) {
  const d = asDay(dob); if (!d) return null;
  let a = Number(day.slice(0, 4)) - Number(d.slice(0, 4));
  if (day.slice(5) < d.slice(5, 10)) a -= 1;
  return a;
}
/** The Sunday-to-Saturday week a day is in, or its calendar month. */
function giftWindow(birthday, kind) {
  if (kind === 'month') {
    const [y, m] = birthday.split('-').map(Number);
    return [`${birthday.slice(0, 7)}-01`, new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)];
  }
  const from = addDays(birthday, -weekdayOf(birthday));
  return [from, addDays(from, 6)];
}

/** The mountain's main day ticket (the first active one): what "a free day" means when nothing else is set. */
async function mainTicket(db, tenantId) {
  return one(db, "SELECT id, name, base_price_cents FROM products WHERE tenant_id = ? AND kind = 'day_ticket' AND active = 1 ORDER BY id LIMIT 1", [tenantId]);
}
async function productName(db, tenantId, id) {
  if (!id) return null;
  return (await one(db, 'SELECT name FROM products WHERE tenant_id = ? AND id = ?', [tenantId, id]) || {}).name || null;
}

/**
 * The birthday gift's choices from the settings. With none chosen, a free day ticket (the main day ticket), so a mountain
 * that leaves birthdays on (the default) still gives something; the settings page says so.
 */
async function birthdayOptions(db, tenantId, gs) {
  const o = {};
  if (gs.birthday_ticket_product_id) o.free_ticket = { product_id: Number(gs.birthday_ticket_product_id) };
  if (gs.birthday_percent) o.percent = { percent: Number(gs.birthday_percent) };
  if (gs.birthday_credit_cents) o.credit = { cents: Number(gs.birthday_credit_cents) };
  if (!Object.keys(o).length) {
    const t = await mainTicket(db, tenantId);
    if (t) o.free_ticket = { product_id: Number(t.id) };
  }
  return o;
}

/** Plain words for a reward's choices, with money: "a free All-day ticket, 20% off, or a $25.00 credit". */
async function choiceWords(db, tenantId, options) {
  const parts = [];
  if (options.free_ticket) parts.push(`a free ${(await productName(db, tenantId, options.free_ticket.product_id)) || 'day ticket'}`);
  if (options.percent) parts.push(`${options.percent.percent}% off${options.percent.product_id ? ` a ${(await productName(db, tenantId, options.percent.product_id)) || 'season pass'}` : ''}`);
  if (options.credit) parts.push(`a ${money(options.credit.cents)} credit`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}` : parts[0] || '';
}

// ---------------------------------------------------------------- who gets the email
/**
 * Who hears about a person: an adult with an email themselves; a child (under 18, or no email) through a parent or
 * guardian with an email (person_links, relation 'guardian'). { id, email, phone, first_name, self } or null.
 */
async function recipientFor(db, tenantId, p, day) {
  const age = ageOn(p.date_of_birth, day);
  const minor = age !== null && age < 18;
  if (p.email && !minor) return { id: p.id, email: p.email, phone: p.phone, first_name: p.first_name, self: true };
  const g = await one(db, `SELECT a.id, a.email, a.phone, a.first_name FROM person_links l JOIN people a ON a.tenant_id = l.tenant_id AND a.id = l.adult_id
    WHERE l.tenant_id = ? AND l.member_id = ? AND l.relation = 'guardian' AND a.email IS NOT NULL AND a.email <> '' AND a.anonymised_at IS NULL ORDER BY l.created_at, a.id LIMIT 1`, [tenantId, p.id]);
  if (g) return { ...g, self: false };
  if (p.email) return { id: p.id, email: p.email, phone: p.phone, first_name: p.first_name, self: true };
  return null;
}
/** May this person get email from us? Not when their latest email answer is "no". */
async function emailOk(db, tenantId, personId) {
  const c = await currentConsent(db, tenantId, personId);
  return !(c.email && c.email.status === 'opted_out');
}
/** A text only where the mountain can text and the person said yes to texts. */
async function textOk(db, tenantId, person) {
  if (!sms.enabled() || !person || !sms.e164(person.phone)) return false;
  const c = await currentConsent(db, tenantId, person.id);
  return Boolean(c.sms && c.sms.status === 'opted_in');
}

// ---------------------------------------------------------------- emails
async function tenantOf(tenantId) {
  const t = await one(pool, 'SELECT id, name, slug, timezone, phone, season_ends_on FROM tenants WHERE id = ?', [tenantId]);
  const b = await one(pool, 'SELECT color FROM shop_brand WHERE tenant_id = ?', [tenantId]).catch(() => null);
  return { ...t, color: (b && /^#[0-9a-fA-F]{6}$/.test(b.color || '') && b.color) || '#12303a' };
}
/** A short, warm HTML email that works in Gmail and Outlook: a title, paragraphs, an optional code and button. */
function mailHtml(t, { title, paras, code, button }) {
  const p = (x) => `<p style="margin:0 0 14px;font:16px/1.5 Arial,Helvetica,sans-serif;color:#1d2a30">${x}</p>`;
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3f5f6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f6"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:10px">
<tr><td style="background:${t.color};color:#ffffff;padding:18px 24px;border-radius:10px 10px 0 0;font:700 14px Arial,Helvetica,sans-serif;letter-spacing:.04em;text-transform:uppercase">${esc(t.name)}</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 16px;font:700 24px/1.25 Arial,Helvetica,sans-serif;color:#1d2a30">${esc(title)}</h1>
${paras.map((x) => p(x)).join('\n')}
${code ? `<p style="margin:8px 0 18px;font:700 26px/1.2 'Courier New',monospace;letter-spacing:.12em;color:#1d2a30;background:#f3f5f6;padding:12px 16px;border-radius:8px;text-align:center">${esc(code)}</p>` : ''}
${button ? `<p style="margin:8px 0 6px"><a href="${esc(button.href)}" style="display:inline-block;background:${t.color};color:#ffffff;text-decoration:none;font:700 16px Arial,Helvetica,sans-serif;padding:12px 20px;border-radius:8px">${esc(button.text)}</a></p>` : ''}
</td></tr></table></td></tr></table></body></html>`;
}

async function sendMail(t, to, { subject, text, html, tag }) {
  try { return await mailer.send({ tenantId: t.id, to, fromName: t.name, subject, text, html, tag }); } catch (err) { return { ok: false, error: err.message }; }
}
async function sendText(t, to, body) {
  try { return await sms.send({ tenantId: t.id, to, body }); } catch (err) { return { ok: false, error: err.message }; }
}

/**
 * Tells the guest (or their parent) about a reward, once (guest_reward_mails is claimed first). The words come from the
 * reward's kind. Returns true when an email went out.
 */
async function mailReward(t, reward, person, day, base, extraLines = {}) {
  const to = await recipientFor(pool, t.id, person, day);
  const [claim] = await pool.query('INSERT IGNORE INTO guest_reward_mails (tenant_id, reward_id, to_person_id) VALUES (?, ?, ?)', [t.id, reward.id, to ? to.id : null]);
  if (!claim.affectedRows || !to || !(await emailOk(pool, t.id, to.id))) return false;
  const s = R.shape(reward);
  const choices = await choiceWords(pool, t.id, s.options);
  const several = Object.keys(s.options).length > 1;
  const who = person.first_name;
  const hi = to.self ? `Hi ${who},` : `Hi ${to.first_name || 'there'},`;
  const when = `It is good from ${dayText(asDay(s.valid_from))} to ${dayText(asDay(s.valid_to))}.`;
  const shop = `${base}/shop/${encodeURIComponent(t.slug)}`;
  const how = `To use it, buy online at ${shop} while signed in to your account, or show this code at the ticket window: ${s.code}`;
  let subject; let title; let lead;
  if (s.kind === 'birthday') {
    const b = extraLines.birthday;
    const daysOut = b ? Math.round((Date.parse(b) - Date.parse(day)) / 86_400_000) : null;
    const whenBirthday = b && daysOut !== null && daysOut >= 0 && daysOut <= 6 ? (daysOut === 0 ? 'today' : WEEKDAYS[weekdayOf(b)]) : b ? dayText(b) : '';
    if (extraLines.atOpening) {
      subject = to.self ? `A birthday gift from ${t.name}` : `A birthday gift for ${who} from ${t.name}`;
      title = to.self ? 'A birthday gift, saved for opening' : `A birthday gift for ${who}`;
      lead = to.self ? 'Your birthday comes while we are closed, so we saved your gift for the start of the season.' : `${who}'s birthday comes while we are closed, so we saved ${who}'s gift for the start of the season.`;
    } else {
      subject = to.self ? `Happy birthday from ${t.name}` : `${who}'s birthday is ${whenBirthday}`;
      title = to.self ? 'Happy birthday!' : `${who}'s birthday is ${whenBirthday}`;
      lead = to.self ? `Your birthday is ${whenBirthday}, and everyone at ${t.name} wants to celebrate with you.` : `Everyone at ${t.name} wants to celebrate with ${who}.`;
    }
  } else if (s.kind === 'milestone') {
    subject = `${to.self ? 'Your' : `${who}'s`} ${s.reason || 'milestone'} at ${t.name}`;
    title = `Thank you for ${extraLines.n ? `${extraLines.n} days` : 'all those days'} with us`;
    lead = `${to.self ? 'You' : who} just skied ${to.self ? 'your' : 'their'} ${extraLines.n ? ord(extraLines.n) : ''} day at ${t.name}. That deserves a thank you.`;
  } else if (s.kind === 'firsttimer') {
    subject = `${who} finished the first-timer lessons`;
    title = `${who} did it: ${LADDER} lessons`;
    lead = `${who} has finished ${LADDER} lessons with us and is ready for a whole season. Here is an offer to make it easy.`;
  } else {
    subject = extraLines.top ? `Thank you from ${t.name}` : `Your next day at ${t.name} is on us`;
    title = extraLines.top ? 'Thank you for skiing with us' : 'Your next day is on us';
    lead = extraLines.top ? `${to.self ? 'You are' : `${who} is`} one of our most loyal guests this season.${extraLines.note ? ` ${extraLines.note}` : ''}` : `${to.self ? 'You have' : `${who} has`} skied ${extraLines.n || 'many'} days with us this season. Thank you.`;
  }
  const gift = several ? `The gift is your choice of ${choices}. Pick one when you use it.` : `The gift is ${choices}.`;
  const text = [hi, '', lead, '', gift, when, '', how, '', 'See you soon,', t.name].join('\n');
  const html = mailHtml(t, { title, paras: [esc(hi), esc(lead), esc(gift), esc(when), `To use it, buy online while signed in to your account, or show this code at the ticket window:`], code: s.code, button: { href: shop, text: 'Buy online' } });
  const r = await sendMail(t, to.email, { subject, text, html, tag: `reward-${s.kind}` });
  if (r && r.ok) await pool.query('UPDATE guest_reward_mails SET emailed = 1 WHERE tenant_id = ? AND reward_id = ?', [t.id, reward.id]);
  return Boolean(r && r.ok);
}

/** Issues a reward (once by source_key) with an audit row, and says whether it is new. */
async function give(tenantId, req, args) {
  return tx(async (conn) => {
    const had = args.sourceKey ? await one(conn, 'SELECT id FROM guest_rewards WHERE tenant_id = ? AND person_id = ? AND source_key = ?', [tenantId, args.personId, args.sourceKey]) : null;
    const r = await R.issue(conn, tenantId, args);
    if (!had) await audit(conn, req || jobReq(tenantId), 'reward_issue', 'guest_rewards', r.id, { kind: args.kind, person_id: args.personId, options: args.options, source_key: args.sourceKey || null });
    return { reward: r, fresh: !had };
  });
}

// ---------------------------------------------------------------- birthday gifts
/**
 * Once a day (and safe to run again): birthday gifts for past guests and pass holders. A birthday in the season gets its
 * gift a week ahead, good for the birthday week (Sunday to Saturday) or month; a birthday outside the season gets it on
 * opening day (or within the first week, if the job missed a day), good for 30 days. Once a season per person.
 */
async function birthdays(tenantId, day, base) {
  const gs = await G.get(pool, tenantId);
  if (!gs.birthday_on) return { off: true, issued: 0 };
  const t = await tenantOf(tenantId);
  const options = await birthdayOptions(pool, tenantId, gs);
  if (!Object.keys(options).length) return { issued: 0, note: 'No gift to give: no day ticket and nothing chosen' };
  const win = seasonWindow(gs.season_opens_on, t.season_ends_on, day);
  const out = { issued: 0, emailed: 0 };
  const md = (d) => d.slice(5, 10);
  // In season: a birthday 1 to 7 days out (7 is the plan; fewer when the job missed a day or the guest is new).
  const soon = Array.from({ length: 7 }, (_, i) => addDays(day, i + 1));
  const mds = new Set(soon.map(md));
  if (mds.has('02-28') && !isLeap(Number(soon.find((d) => md(d) === '02-28').slice(0, 4)))) mds.add('02-29');
  const near = await rows(pool, `SELECT id, first_name, last_name, email, phone, date_of_birth FROM people WHERE tenant_id = ? AND date_of_birth IS NOT NULL AND anonymised_at IS NULL
    AND DATE_FORMAT(date_of_birth, '%m-%d') IN (?)`, [tenantId, [...mds]]);
  const atOpening = day >= win.opens && day <= addDays(win.opens, 6) && day <= win.ends;
  let far = [];
  if (atOpening) {
    far = (await rows(pool, `SELECT p.id, p.first_name, p.last_name, p.email, p.phone, p.date_of_birth FROM people p WHERE p.tenant_id = ? AND p.date_of_birth IS NOT NULL AND p.anonymised_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM guest_rewards r WHERE r.tenant_id = p.tenant_id AND r.person_id = p.id AND r.source_key = ?)`, [tenantId, `birthday:${win.label}`]))
      .filter((p) => { const b = inSeasonYear(asDay(p.date_of_birth), win.label); return b < win.opens || b > win.ends; });
  }
  const todo = [];
  for (const p of near) {
    const b = nextBirthday(asDay(p.date_of_birth), addDays(day, 1));
    if (b < win.opens || b > win.ends) continue; // outside the season: the gift comes at opening
    const [from, to] = giftWindow(b, gs.birthday_window);
    todo.push({ p, b, from: from < day ? day : from, to, key: `birthday:${seasonFor(b)}`, atOpening: false });
  }
  for (const p of far) todo.push({ p, b: null, from: win.opens, to: addDays(win.opens, 29), key: `birthday:${win.label}`, atOpening: true });
  for (const x of todo) {
    if (await one(pool, 'SELECT id FROM guest_rewards WHERE tenant_id = ? AND person_id = ? AND source_key = ?', [tenantId, x.p.id, x.key])) continue;
    if (!(await V.isPastGuest(pool, tenantId, x.p.id, day, t.timezone))) continue; // newcomers wait until they have been here
    const { reward, fresh } = await give(tenantId, null, { personId: x.p.id, kind: 'birthday', reason: 'Happy birthday', options, validFrom: x.from, validTo: x.to, sourceKey: x.key });
    if (!fresh) continue;
    out.issued += 1;
    if (await mailReward(t, reward, x.p, day, base, { birthday: x.b, atOpening: x.atOpening })) out.emailed += 1;
  }
  return out;
}

// ---------------------------------------------------------------- the loyalty rules
/** Paid ski days this season (a good scan on a day ticket the guest paid for; not passes, comps or reward days), as local days. */
async function paidDays(db, tenantId, personId, day, tz) {
  const [from, to] = V.seasonRange(seasonFor(day));
  const [utcFrom] = dayRange(tz, from); const [, utcTo] = dayRange(tz, day < to ? day : to);
  const list = await rows(db, `SELECT s.scanned_at FROM scans s JOIN tickets t ON t.tenant_id = s.tenant_id AND t.id = s.ticket_id
      JOIN products p ON p.tenant_id = t.tenant_id AND p.id = t.product_id JOIN order_items oi ON oi.tenant_id = t.tenant_id AND oi.id = t.order_item_id
    WHERE s.tenant_id = ? AND t.person_id = ? AND s.result = 'ok' AND s.scanned_at >= ? AND s.scanned_at < ?
      AND p.kind IN ('day_ticket','multi_day','punch_card') AND oi.unit_price_cents > oi.discount_cents AND oi.reward_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM order_payments op WHERE op.tenant_id = oi.tenant_id AND op.order_id = oi.order_id AND op.tender = 'comp')`, [tenantId, personId, utcFrom, utcTo]);
  return new Set(list.map((r) => localTime(r.scanned_at, tz).slice(0, 10))).size;
}
/** Lessons attended, oldest first, and whether the guest's first day ever was a lesson day (the first-timer ladder). */
async function ladder(db, tenantId, personId, day, tz) {
  const lessons = await rows(db, `SELECT DATE(ls.starts_at) AS d FROM lesson_bookings b JOIN lesson_sessions ls ON ls.tenant_id = b.tenant_id AND ls.id = b.session_id
    WHERE b.tenant_id = ? AND b.person_id = ? AND b.status = 'attended' AND DATE(ls.starts_at) <= ? ORDER BY ls.starts_at`, [tenantId, personId, day]);
  if (!lessons.length) return null;
  const all = await V.daysHere(db, tenantId, personId, '2000-01-01', day, tz);
  const first = all[all.length - 1];
  if (!first || asDay(lessons[0].d) !== first) return null;
  return { done: Math.min(lessons.length, LADDER), of: LADDER, finished: lessons.length >= LADDER };
}

/**
 * The loyalty rules for the people who were here on a day (each once by its source key): every Nth paid day free,
 * milestones (10th, 25th, 50th, 100th day ever), and the first-timer ladder's season pass offer after the third lesson.
 */
async function rulesFor(tenantId, day, base) {
  const gs = await G.get(pool, tenantId);
  if (!gs.loyalty_every_n && !gs.milestones_on && !gs.firsttimer_on) return { off: true };
  const t = await tenantOf(tenantId);
  const ex = await extra(pool, tenantId);
  const [utcFrom, utcTo] = dayRange(t.timezone, day);
  const people = await rows(pool, `SELECT DISTINCT p.id, p.first_name, p.email, p.phone, p.date_of_birth FROM people p WHERE p.tenant_id = ? AND p.anonymised_at IS NULL AND p.id IN (
      SELECT t.person_id FROM scans s JOIN tickets t ON t.tenant_id = s.tenant_id AND t.id = s.ticket_id WHERE s.tenant_id = ? AND s.result = 'ok' AND s.scanned_at >= ? AND s.scanned_at < ?
      UNION SELECT b.person_id FROM lesson_bookings b JOIN lesson_sessions ls ON ls.tenant_id = b.tenant_id AND ls.id = b.session_id WHERE b.tenant_id = ? AND b.status = 'attended' AND DATE(ls.starts_at) = ?)
    AND NOT EXISTS (SELECT 1 FROM staff st WHERE st.tenant_id = p.tenant_id AND st.person_id = p.id AND st.status = 'active')`, [tenantId, tenantId, utcFrom, utcTo, tenantId, day]);
  const win = seasonWindow(gs.season_opens_on, t.season_ends_on, day);
  const seasonEnd = win.ends >= day ? win.ends : addDays(day, 30);
  const main = await mainTicket(pool, tenantId);
  const out = { loyalty: 0, milestone: 0, firsttimer: 0 };
  for (const p of people) {
    if (gs.loyalty_every_n) {
      const n = Number(gs.loyalty_every_n);
      const paid = await paidDays(pool, tenantId, p.id, day, t.timezone);
      const k = Math.floor(paid / n);
      const product = ex.loyalty_product_id || (main && main.id);
      if (k >= 1 && product) {
        const { reward, fresh } = await give(tenantId, null, { personId: p.id, kind: 'loyalty', reason: `Day ${k * n} this season`, options: { free_ticket: { product_id: Number(product) } }, validFrom: day, validTo: seasonEnd, sourceKey: `loyalty:${win.label}:${k}` });
        if (fresh) { out.loyalty += 1; await mailReward(t, reward, p, day, base, { n: k * n }); }
      }
    }
    if (gs.milestones_on) {
      const all = (await V.daysHere(pool, tenantId, p.id, '2000-01-01', day, t.timezone)).reverse(); // oldest first
      for (const n of MILESTONES) {
        if (all.length < n || all[n - 1] < addDays(day, -1)) continue; // reached today (or yesterday, if the job missed it)
        const o = {};
        if (ex.milestone_credit_cents) o.credit = { cents: Number(ex.milestone_credit_cents) };
        if (ex.milestone_percent) o.percent = { percent: Number(ex.milestone_percent) };
        if (!Object.keys(o).length && main) o.free_ticket = { product_id: Number(main.id) };
        if (!Object.keys(o).length) continue;
        const { reward, fresh } = await give(tenantId, null, { personId: p.id, kind: 'milestone', reason: `${ord(n)} day`, options: o, validFrom: day, validTo: addDays(day, 365), sourceKey: `milestone:${n}` });
        if (fresh) { out.milestone += 1; await mailReward(t, reward, p, day, base, { n }); }
      }
    }
    if (gs.firsttimer_on) {
      const l = await ladder(pool, tenantId, p.id, day, t.timezone);
      const pass = ex.firsttimer_product_id || (await one(pool, "SELECT id FROM products WHERE tenant_id = ? AND kind = 'season_pass' AND active = 1 ORDER BY id LIMIT 1", [tenantId]) || {}).id;
      if (l && l.finished && pass) {
        const { reward, fresh } = await give(tenantId, null, { personId: p.id, kind: 'firsttimer', reason: 'Season pass offer after three lessons', options: { percent: { percent: Number(ex.firsttimer_percent || 50), product_id: Number(pass) } }, validFrom: day, validTo: addDays(day, 60), sourceKey: 'firsttimer:pass' });
        if (fresh) { out.firsttimer += 1; await mailReward(t, reward, p, day, base); }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- day recaps
/** Good scans on a day for guests (not staff, not staff or patrol comps), per person: first scan, laps, lifts. */
async function dayStats(db, tenantId, day, tz, personIds = null) {
  const [utcFrom, utcTo] = dayRange(tz, day);
  const list = await rows(db, `SELECT t.person_id, s.scanned_at, s.location FROM scans s JOIN tickets t ON t.tenant_id = s.tenant_id AND t.id = s.ticket_id
    JOIN order_items oi ON oi.tenant_id = t.tenant_id AND oi.id = t.order_item_id
    WHERE s.tenant_id = ? AND s.result = 'ok' AND t.person_id IS NOT NULL AND s.scanned_at >= ? AND s.scanned_at < ?${personIds ? ' AND t.person_id IN (?)' : ''}
      AND NOT EXISTS (SELECT 1 FROM staff st WHERE st.tenant_id = t.tenant_id AND st.person_id = t.person_id AND st.status = 'active')
      AND NOT EXISTS (SELECT 1 FROM order_payments op WHERE op.tenant_id = oi.tenant_id AND op.order_id = oi.order_id AND op.tender = 'comp' AND op.comp_reason IN ('staff','patrol'))
    ORDER BY s.scanned_at`, [tenantId, utcFrom, utcTo, ...(personIds ? [personIds] : [])]);
  const by = new Map();
  for (const r of list) {
    const k = Number(r.person_id);
    if (!by.has(k)) by.set(k, { first_at: localTime(r.scanned_at, tz).slice(11, 16), laps: 0, lifts: new Set() });
    const x = by.get(k); x.laps += 1; if (r.location) x.lifts.add(r.location);
  }
  return new Map([...by].map(([k, x]) => [k, { first_at: x.first_at, laps: x.laps, lifts: x.lifts.size }]));
}
const clock = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
function dayLine(s, { self = true } = {}) {
  const laps = `${s.laps} ${s.laps === 1 ? 'lap' : 'laps'}${s.lifts > 1 ? ` on ${s.lifts} lifts` : ''}`;
  return self ? `First chair at ${clock(s.first_at)}, ${laps}.` : `first chair at ${clock(s.first_at)}, ${laps}`;
}

/** Groups people by who hears about them (a family in one message), skipping anyone who asked for no recaps. */
async function groupByRecipient(db, tenantId, people, day) {
  const stops = new Set((await rows(db, 'SELECT person_id FROM guest_recap_stops WHERE tenant_id = ?', [tenantId])).map((r) => Number(r.person_id)));
  const groups = new Map();
  for (const p of people) {
    if (stops.has(Number(p.id))) continue;
    const to = await recipientFor(db, tenantId, p, day);
    if (to && stops.has(Number(to.id))) continue;
    const key = to ? `p${to.id}` : `n${p.id}`;
    if (!groups.has(key)) groups.set(key, { to, people: [] });
    groups.get(key).people.push(p);
  }
  return [...groups.values()];
}

/** Claims the recap rows for a group (once per person per period) and returns the claimed people and the group's token. */
async function claim(tenantId, kind, period, group, statsOf) {
  return tx(async (conn) => {
    const claimed = [];
    for (const p of group.people) {
      const [r] = await conn.query('INSERT IGNORE INTO guest_recaps (tenant_id, kind, period, person_id, to_person_id, stats) VALUES (?, ?, ?, ?, ?, ?)',
        [tenantId, kind, period, p.id, group.to ? group.to.id : null, JSON.stringify(statsOf(p))]);
      if (r.affectedRows) claimed.push({ ...p, recap_id: r.insertId });
    }
    if (!claimed.length) return { claimed, token: null };
    const token = newToken();
    const groupId = claimed[0].recap_id;
    await conn.query('UPDATE guest_recaps SET group_id = ? WHERE tenant_id = ? AND id IN (?)', [groupId, tenantId, claimed.map((c) => c.recap_id)]);
    await conn.query('UPDATE guest_recaps SET token_sha = ? WHERE tenant_id = ? AND id = ?', [sha(token), tenantId, groupId]);
    return { claimed, token, groupId };
  });
}

/**
 * The day recap: for each guest with a good scan on the day, one thank-you (a family's together, to the parent's email),
 * and a text as well only with consent where the mountain can text. Once per person per day. Returns counts.
 */
async function dayRecaps(tenantId, day, base) {
  const gs = await G.get(pool, tenantId);
  if (!gs.recap_day_on) return { off: true };
  const t = await tenantOf(tenantId);
  const stats = await dayStats(pool, tenantId, day, t.timezone);
  if (!stats.size) return { sent: 0 };
  const done = new Set((await rows(pool, "SELECT person_id FROM guest_recaps WHERE tenant_id = ? AND kind = 'day' AND period = ?", [tenantId, day])).map((r) => Number(r.person_id)));
  const ids = [...stats.keys()].filter((id) => !done.has(id));
  if (!ids.length) return { sent: 0 };
  const people = await rows(pool, 'SELECT id, first_name, email, phone, date_of_birth FROM people WHERE tenant_id = ? AND id IN (?) AND anonymised_at IS NULL ORDER BY date_of_birth IS NULL, date_of_birth, id', [tenantId, ids]);
  const ex = { firsttimer: gs.firsttimer_on, every: gs.loyalty_every_n };
  const out = { sent: 0, texted: 0, people: 0 };
  for (const group of await groupByRecipient(pool, tenantId, people, day)) {
    // Extra lines: the first-timer ladder and loyalty progress, when the mountain has them on.
    const notes = new Map();
    for (const p of group.people) {
      const n = [];
      if (ex.firsttimer) { const l = await ladder(pool, tenantId, p.id, day, t.timezone); if (l && !l.finished) n.push(`Lesson ${l.done} of ${l.of} on the first-timer ladder.`); }
      if (ex.every) { const paid = await paidDays(pool, tenantId, p.id, day, t.timezone); const r = paid % Number(ex.every); if (paid && r) n.push(`${r} of ${ex.every} days toward a free day.`); }
      notes.set(p.id, n);
    }
    const { claimed, token } = await claim(tenantId, 'day', day, group, (p) => ({ ...stats.get(Number(p.id)), notes: notes.get(p.id) }));
    if (!claimed.length) continue;
    out.people += claimed.length;
    if (!group.to) continue;
    const link = `${base}/season/${encodeURIComponent(t.slug)}/${token}`;
    const one1 = claimed.length === 1;
    const p0 = claimed[0];
    const self = one1 && group.to.self;
    const lines = claimed.map((p) => (one1 ? `${dayLine(stats.get(Number(p.id)))}${notes.get(p.id).length ? ` ${notes.get(p.id).join(' ')}` : ''}` : `${p.first_name}: ${dayLine(stats.get(Number(p.id)), { self: false })}.${notes.get(p.id).length ? ` ${notes.get(p.id).join(' ')}` : ''}`));
    const greet = self ? `Thanks for skiing with us today, ${p0.first_name}.` : one1 ? `Thanks for bringing ${p0.first_name} skiing with us today.` : 'Thanks for skiing with us today.';
    const subject = self ? `Thanks for today, ${p0.first_name}` : `Your day at ${t.name}`;
    const text = [`Hi ${group.to.first_name || 'there'},`, '', greet, ...lines, '', 'See you soon,', t.name, '', `Your day: ${link}`, 'Rather not get these? Open the link and choose "Stop these emails".'].join('\n');
    const html = mailHtml(t, { title: greet, paras: [...lines.map(esc), 'See you soon.', `<span style="color:#5b6b72;font-size:13px">Rather not get these? Open your day and choose Stop these emails.</span>`], button: { href: link, text: 'See your day' } });
    let emailed = false; let texted = false;
    if (await emailOk(pool, tenantId, group.to.id)) emailed = Boolean((await sendMail(t, group.to.email, { subject, text, html, tag: 'recap-day' })).ok);
    if (await textOk(pool, tenantId, group.to)) {
      texted = Boolean((await sendText(t, group.to.phone, `${t.name}: ${greet} ${one1 ? dayLine(stats.get(Number(p0.id))) : ''} See you soon. ${link}`.replace(/\s+/g, ' '))).ok);
    }
    await pool.query('UPDATE guest_recaps SET emailed = ?, texted = ? WHERE tenant_id = ? AND id IN (?)', [emailed ? 1 : 0, texted ? 1 : 0, tenantId, claimed.map((c) => c.recap_id)]);
    if (emailed) out.sent += 1;
    if (texted) out.texted += 1;
  }
  return out;
}

// ---------------------------------------------------------------- season recaps
/** A person's season: days, first and last day, laps, favorite lift, longest streak, lessons and levels, milestones. */
async function seasonStats(db, tenantId, personId, label, tz) {
  const [from, to] = V.seasonRange(label);
  const days = (await V.daysHere(db, tenantId, personId, from, to, tz)).reverse();
  const [utcFrom] = dayRange(tz, from); const [, utcTo] = dayRange(tz, to);
  const scans = await rows(db, `SELECT s.location, COUNT(*) AS n FROM scans s JOIN tickets t ON t.tenant_id = s.tenant_id AND t.id = s.ticket_id
    WHERE s.tenant_id = ? AND t.person_id = ? AND s.result = 'ok' AND s.scanned_at >= ? AND s.scanned_at < ? GROUP BY s.location ORDER BY n DESC`, [tenantId, personId, utcFrom, utcTo]);
  let streak = 0; let run = 0; let prev = null;
  for (const d of days) { run = prev && addDays(prev, 1) === d ? run + 1 : 1; streak = Math.max(streak, run); prev = d; }
  const lessons = await one(db, `SELECT COUNT(*) AS n FROM lesson_bookings b JOIN lesson_sessions ls ON ls.tenant_id = b.tenant_id AND ls.id = b.session_id
    WHERE b.tenant_id = ? AND b.person_id = ? AND b.status = 'attended' AND DATE(ls.starts_at) BETWEEN ? AND ?`, [tenantId, personId, from, to]);
  const levels = await rows(db, 'SELECT discipline, MAX(level) AS level FROM student_progress WHERE tenant_id = ? AND person_id = ? AND recorded_at >= ? AND recorded_at < ? GROUP BY discipline', [tenantId, personId, utcFrom, utcTo]);
  const miles = await rows(db, "SELECT reason FROM guest_rewards WHERE tenant_id = ? AND person_id = ? AND kind = 'milestone' AND created_at >= ? AND created_at < ? ORDER BY id", [tenantId, personId, utcFrom, utcTo]);
  const fav = scans.find((s) => s.location);
  return {
    days: days.length, first_day: days[0] || null, last_day: days[days.length - 1] || null,
    laps: scans.reduce((n, s) => n + Number(s.n), 0), favorite_lift: fav ? fav.location : null, longest_streak: streak,
    lessons: Number(lessons.n), levels: levels.map((l) => ({ discipline: l.discipline, level: Number(l.level), name: L.name(Number(l.level), l.discipline) })),
    milestones: miles.map((m) => m.reason).filter(Boolean),
  };
}

/** Everyone who was here in a season (a scan, a lesson or a rental), not staff. */
async function seasonPeople(db, tenantId, label, tz) {
  const [from, to] = V.seasonRange(label);
  const [utcFrom] = dayRange(tz, from); const [, utcTo] = dayRange(tz, to);
  return rows(db, `SELECT p.id, p.first_name, p.email, p.phone, p.date_of_birth FROM people p WHERE p.tenant_id = ? AND p.anonymised_at IS NULL AND p.id IN (
      SELECT t.person_id FROM scans s JOIN tickets t ON t.tenant_id = s.tenant_id AND t.id = s.ticket_id WHERE s.tenant_id = ? AND s.result = 'ok' AND s.scanned_at >= ? AND s.scanned_at < ?
      UNION SELECT b.person_id FROM lesson_bookings b JOIN lesson_sessions ls ON ls.tenant_id = b.tenant_id AND ls.id = b.session_id WHERE b.tenant_id = ? AND b.status = 'attended' AND DATE(ls.starts_at) BETWEEN ? AND ?)
    AND NOT EXISTS (SELECT 1 FROM staff st WHERE st.tenant_id = p.tenant_id AND st.person_id = p.id AND st.status = 'active')
    ORDER BY p.date_of_birth IS NULL, p.date_of_birth, p.id`, [tenantId, tenantId, utcFrom, utcTo, tenantId, from, to]);
}

/**
 * The season recap: a "Your season" page per person or family by a private link, and the email that sends it. preview
 * counts without sending. Once per person per season. Returns { people, emails } (and sent when sending).
 */
async function seasonRecaps(tenantId, label, base, { preview = false, req = null } = {}) {
  const gs = await G.get(pool, tenantId);
  if (!gs.recap_season_on && !preview) return { off: true };
  const t = await tenantOf(tenantId);
  const day = todayIn(t.timezone);
  const done = new Set((await rows(pool, "SELECT person_id FROM guest_recaps WHERE tenant_id = ? AND kind = 'season' AND period = ?", [tenantId, label])).map((r) => Number(r.person_id)));
  const people = (await seasonPeople(pool, tenantId, label, t.timezone)).filter((p) => !done.has(Number(p.id)));
  const groups = await groupByRecipient(pool, tenantId, people, day);
  if (preview) return { season: label, people: people.length, emails: groups.filter((g) => g.to).length, already: done.size };
  const out = { season: label, people: 0, sent: 0, texted: 0 };
  for (const group of groups) {
    const stats = new Map();
    for (const p of group.people) stats.set(p.id, await seasonStats(pool, tenantId, p.id, label, t.timezone));
    const { claimed, token } = await claim(tenantId, 'season', label, group, (p) => stats.get(p.id));
    if (!claimed.length) continue;
    out.people += claimed.length;
    if (!group.to) continue;
    const link = `${base}/season/${encodeURIComponent(t.slug)}/${token}`;
    const lines = claimed.map((p) => { const s = stats.get(p.id); return `${p.first_name}: ${s.days} ${s.days === 1 ? 'day' : 'days'}${s.laps ? `, ${s.laps} laps` : ''}${s.longest_streak > 1 ? `, a ${s.longest_streak}-day streak` : ''}.`; });
    const subject = claimed.length === 1 && group.to.self ? `Your season at ${t.name}` : `Your family's season at ${t.name}`;
    const text = [`Hi ${group.to.first_name || 'there'},`, '', `What a season. Thank you for spending it with us.`, ...lines, '', `See your season: ${link}`, '', 'See you next season,', t.name].join('\n');
    const html = mailHtml(t, { title: 'Your season, in numbers', paras: [esc(`Hi ${group.to.first_name || 'there'},`), 'What a season. Thank you for spending it with us.', ...lines.map(esc), 'See you next season.'], button: { href: link, text: 'See your season' } });
    let emailed = false; let texted = false;
    if (await emailOk(pool, tenantId, group.to.id)) emailed = Boolean((await sendMail(t, group.to.email, { subject, text, html, tag: 'recap-season' })).ok);
    if (await textOk(pool, tenantId, group.to)) texted = Boolean((await sendText(t, group.to.phone, `${t.name}: thank you for this season. Your season in numbers: ${link}`)).ok);
    await pool.query('UPDATE guest_recaps SET emailed = ?, texted = ? WHERE tenant_id = ? AND id IN (?)', [emailed ? 1 : 0, texted ? 1 : 0, tenantId, claimed.map((c) => c.recap_id)]);
    if (emailed) out.sent += 1;
    if (texted) out.texted += 1;
  }
  await saveExtra(pool, tenantId, { season_recap_sent: label });
  if (req) await audit(pool, req, 'season_recaps_send', 'guest_recaps', null, out);
  return out;
}

/** The recap page's data by its private link (a family's people together), or null. Marks it viewed. */
async function recapView(tenantId, token) {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(String(token || ''))) return null;
  const head = await one(pool, 'SELECT * FROM guest_recaps WHERE tenant_id = ? AND token_sha = ?', [tenantId, sha(token)]);
  if (!head) return null;
  const list = await rows(pool, `SELECT r.id, r.person_id, r.stats, p.first_name, r.share_sha IS NOT NULL AS shared FROM guest_recaps r JOIN people p ON p.tenant_id = r.tenant_id AND p.id = r.person_id
    WHERE r.tenant_id = ? AND r.group_id = ? ORDER BY r.id`, [tenantId, head.group_id]);
  await pool.query('UPDATE guest_recaps SET viewed_at = COALESCE(viewed_at, UTC_TIMESTAMP()) WHERE tenant_id = ? AND group_id = ?', [tenantId, head.group_id]);
  const stopped = Boolean(head.to_person_id && await one(pool, 'SELECT 1 AS x FROM guest_recap_stops WHERE tenant_id = ? AND person_id = ?', [tenantId, head.to_person_id]));
  return { head, people: list.map((r, i) => ({ index: i, first_name: r.first_name, stats: typeof r.stats === 'string' ? JSON.parse(r.stats) : r.stats })), stopped };
}

/** Makes (or remakes) the share link for one person in a recap: a page with the first name and the numbers only. */
async function shareLink(tenantId, token, index) {
  const v = await recapView(tenantId, token);
  if (!v) return null;
  const list = await rows(pool, 'SELECT id FROM guest_recaps WHERE tenant_id = ? AND group_id = ? ORDER BY id', [tenantId, v.head.group_id]);
  const row = list[Number(index) || 0];
  if (!row) return null;
  const share = newToken();
  await pool.query('UPDATE guest_recaps SET share_sha = ? WHERE tenant_id = ? AND id = ?', [sha(share), tenantId, row.id]);
  return share;
}
/** The shared page: first name, mountain and the numbers; no last name, lessons, levels or anything about the family. */
async function sharedView(tenantId, share) {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(String(share || ''))) return null;
  const r = await one(pool, `SELECT r.kind, r.period, r.stats, p.first_name FROM guest_recaps r JOIN people p ON p.tenant_id = r.tenant_id AND p.id = r.person_id
    WHERE r.tenant_id = ? AND r.share_sha = ?`, [tenantId, sha(share)]);
  if (!r) return null;
  const s = typeof r.stats === 'string' ? JSON.parse(r.stats) : r.stats;
  const keep = r.kind === 'season' ? { days: s.days, laps: s.laps, longest_streak: s.longest_streak, favorite_lift: s.favorite_lift, first_day: s.first_day, last_day: s.last_day } : { first_at: s.first_at, laps: s.laps, lifts: s.lifts };
  return { kind: r.kind, period: r.period, first_name: r.first_name, stats: keep };
}
/** "Stop these emails": no more recaps for the person who gets them, or for the people in the recap. */
async function stopRecaps(tenantId, token) {
  const v = await recapView(tenantId, token);
  if (!v) return false;
  const ids = [v.head.to_person_id, ...(await rows(pool, 'SELECT person_id FROM guest_recaps WHERE tenant_id = ? AND group_id = ?', [tenantId, v.head.group_id])).map((r) => r.person_id)].filter(Boolean);
  for (const id of new Set(ids.map(Number))) await pool.query('INSERT IGNORE INTO guest_recap_stops (tenant_id, person_id) VALUES (?, ?)', [tenantId, id]);
  return true;
}

// ---------------------------------------------------------------- badges for the welcome-back card
/**
 * Short lines for the welcome-back card: birthday this week, a milestone today, loyalty progress ("3 of 5 toward a free
 * day"), the first-timer step. A few small queries; never throws.
 */
async function badgesFor(db, tenantId, personId, day) {
  try {
    const p = await one(db, 'SELECT first_name, date_of_birth FROM people WHERE tenant_id = ? AND id = ?', [tenantId, personId]);
    if (!p) return [];
    const out = [];
    const dob = asDay(p.date_of_birth);
    if (dob) {
      const b = nextBirthday(dob, addDays(day, -weekdayOf(day)));
      const [from, to] = giftWindow(day, 'week');
      if (b === day) out.push({ kind: 'birthday', text: 'Birthday today' });
      else if (b >= from && b <= to) out.push({ kind: 'birthday', text: `Birthday ${b > day ? WEEKDAYS[weekdayOf(b)] : 'this week'}` });
    }
    const gs = await G.get(db, tenantId);
    if (!gs.milestones_on && !gs.loyalty_every_n && !gs.firsttimer_on) return out;
    const tz = (await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
    if (gs.milestones_on) {
      const all = await V.daysHere(db, tenantId, personId, '2000-01-01', day, tz);
      if (all[0] === day && MILESTONES.includes(all.length)) out.push({ kind: 'milestone', text: `${ord(all.length)} day here today` });
    }
    if (gs.loyalty_every_n) {
      const n = Number(gs.loyalty_every_n);
      const paid = await paidDays(db, tenantId, personId, day, tz);
      if (paid) out.push({ kind: 'loyalty', text: paid % n === 0 ? 'Free day earned' : `${paid % n} of ${n} toward a free day` });
    }
    if (gs.firsttimer_on) {
      const l = await ladder(db, tenantId, personId, day, tz);
      if (l) out.push({ kind: 'firsttimer', text: l.finished ? 'Finished the first-timer lessons' : `First-timer: lesson ${l.done} of ${l.of}` });
    }
    return out;
  } catch (_) { return []; }
}

// ---------------------------------------------------------------- reports and the settings page
/** The most frequent guests this season (days with a good scan), not staff. */
async function topLoyalists(db, tenantId, label, limit, tz) {
  const [from, to] = V.seasonRange(label);
  const [utcFrom] = dayRange(tz, from); const [, utcTo] = dayRange(tz, to);
  return (await rows(db, `SELECT p.id, p.first_name, p.last_name, p.email IS NOT NULL AND p.email <> '' AS has_email, COUNT(DISTINCT DATE(COALESCE(CONVERT_TZ(s.scanned_at, '+00:00', ?), s.scanned_at))) AS days,
      (SELECT r.id FROM guest_rewards r WHERE r.tenant_id = p.tenant_id AND r.person_id = p.id AND r.source_key = ? LIMIT 1) AS thanked
    FROM scans s JOIN tickets t ON t.tenant_id = s.tenant_id AND t.id = s.ticket_id JOIN people p ON p.tenant_id = t.tenant_id AND p.id = t.person_id
    WHERE s.tenant_id = ? AND s.result = 'ok' AND s.scanned_at >= ? AND s.scanned_at < ? AND p.anonymised_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM staff st WHERE st.tenant_id = p.tenant_id AND st.person_id = p.id AND st.status = 'active')
    GROUP BY p.id ORDER BY days DESC, p.last_name, p.first_name LIMIT ?`, [tz, `top:${label}`, tenantId, utcFrom, utcTo, Math.min(1000, Number(limit) || 20)]))
    .map((r) => ({ id: r.id, name: `${r.first_name} ${r.last_name}`.trim(), days: Number(r.days), has_email: Boolean(Number(r.has_email)), thanked: Boolean(r.thanked) }));
}

/** Rewards issued and used by kind, recaps sent (and viewed: the link was opened), for a season. */
async function report(db, tenantId, label) {
  const [from, to] = V.seasonRange(label);
  const rewards = await rows(db, `SELECT kind, COUNT(*) AS issued, SUM(status = 'redeemed') AS used, SUM(status = 'offered') AS open,
      SUM(CASE WHEN status = 'redeemed' AND chosen = 'credit' THEN credit_cents ELSE 0 END) AS credit_used_cents
    FROM guest_rewards WHERE tenant_id = ? AND valid_from BETWEEN ? AND ? GROUP BY kind ORDER BY kind`, [tenantId, from, to]);
  const recaps = await rows(db, `SELECT kind, COUNT(*) AS people, COUNT(DISTINCT CASE WHEN emailed = 1 THEN group_id END) AS emails, COUNT(DISTINCT CASE WHEN texted = 1 THEN group_id END) AS texts,
      COUNT(DISTINCT CASE WHEN viewed_at IS NOT NULL THEN group_id END) AS viewed
    FROM guest_recaps WHERE tenant_id = ? AND ((kind = 'day' AND period BETWEEN ? AND ?) OR (kind = 'season' AND period = ?)) GROUP BY kind`, [tenantId, from, to, label]);
  const num = (x) => Number(x || 0);
  return {
    season: label,
    rewards: rewards.map((r) => ({ kind: r.kind, issued: num(r.issued), used: num(r.used), open: num(r.open), credit_used_cents: num(r.credit_used_cents) })),
    recaps: recaps.map((r) => ({ kind: r.kind, people: num(r.people), emails: num(r.emails), texts: num(r.texts), viewed: num(r.viewed) })),
    opens_tracked: false, // Postmark open tracking is off; "viewed" counts guests who opened their recap page.
  };
}

/** About how many birthday gifts a season: people with a birthday on file who were here this season or last, or hold a pass. */
async function birthdayEstimate(db, tenantId, day) {
  const label = seasonFor(day);
  const prevFrom = `${Number(label.slice(0, 4)) - 1}-08-01`;
  const [, to] = V.seasonRange(label);
  const r = await one(db, `SELECT COUNT(DISTINCT p.id) AS n FROM people p JOIN tickets t ON t.tenant_id = p.tenant_id AND t.person_id = p.id
    WHERE p.tenant_id = ? AND p.date_of_birth IS NOT NULL AND p.anonymised_at IS NULL AND t.status <> 'void' AND t.valid_to >= ? AND t.valid_from <= ?`, [tenantId, prevFrom, to]);
  return Number(r.n);
}

/** Everything the settings page needs beyond guest_settings. */
async function settingsView(tenantId) {
  const t = await tenantOf(tenantId);
  const day = todayIn(t.timezone);
  const gs = await G.get(pool, tenantId);
  const ex = await extra(pool, tenantId);
  const products = await rows(pool, "SELECT id, name, kind, base_price_cents FROM products WHERE tenant_id = ? AND active = 1 AND kind IN ('day_ticket','multi_day','season_pass') ORDER BY kind, name", [tenantId]);
  const main = await mainTicket(pool, tenantId);
  const win = seasonWindow(gs.season_opens_on, t.season_ends_on, day);
  return { ...ex, season: win, season_ends_on: asDay(t.season_ends_on), products, main_ticket: main || null, estimate: { birthdays: await birthdayEstimate(pool, tenantId, day) }, texts_ready: sms.enabled() };
}

// ---------------------------------------------------------------- the jobs
/** Every 5 minutes: the evening day recaps that are due, and the loyalty rules for today. */
async function tick(base = require('../config').stripe.publicUrl || '') {
  const out = { recaps: 0, rewards: 0 };
  const tenants = await rows(pool, `SELECT DISTINCT t.id, t.timezone FROM tenants t JOIN scans s ON s.tenant_id = t.id
    WHERE s.scanned_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)`);
  for (const t of tenants) {
    try {
      const now = nowIn(t.timezone);
      const day = now.slice(0, 10);
      const r = await rulesFor(t.id, day, base);
      out.rewards += (r.loyalty || 0) + (r.milestone || 0) + (r.firsttimer || 0);
      const ex = await extra(pool, t.id);
      if (now.slice(11, 16) >= ex.recap_time) out.recaps += (await dayRecaps(t.id, day, base)).sent || 0;
    } catch (err) {
      console.error(JSON.stringify({ severity: 'ERROR', job: 'guests_loyalty_tick', tenant: t.id, message: err.message }));
    }
  }
  return out;
}

/** Once a day: birthday gifts, yesterday's rules and recaps (if the evening run was missed), the season recap at season end. */
async function daily(base = require('../config').stripe.publicUrl || '') {
  const out = { birthdays: 0, rewards: 0, recaps: 0, season: 0 };
  const tenants = await rows(pool, "SELECT id, timezone, season_ends_on FROM tenants WHERE status = 'active'");
  for (const t of tenants) {
    try {
      const day = todayIn(t.timezone);
      out.birthdays += (await birthdays(t.id, day, base)).issued || 0;
      const y = addDays(day, -1);
      const r = await rulesFor(t.id, y, base);
      out.rewards += (r.loyalty || 0) + (r.milestone || 0) + (r.firsttimer || 0);
      out.recaps += (await dayRecaps(t.id, y, base)).sent || 0;
      const gs = await G.get(pool, t.id);
      const win = seasonWindow(gs.season_opens_on, t.season_ends_on, day);
      // The season recap goes out the day after the season ends (or within two weeks, if the job missed it).
      const ex = await extra(pool, t.id);
      if (gs.recap_season_on && day > win.ends && day <= addDays(win.ends, 14) && ex.season_recap_sent !== win.label) out.season += (await seasonRecaps(t.id, win.label, base)).people || 0;
    } catch (err) {
      console.error(JSON.stringify({ severity: 'ERROR', job: 'guests_loyalty_daily', tenant: t.id, message: err.message }));
    }
  }
  return out;
}

module.exports = {
  MILESTONES, EXTRA, extraSchema, extra, saveExtra, seasonWindow, nextBirthday, giftWindow, ageOn, birthdayOptions, recipientFor,
  birthdays, rulesFor, paidDays, ladder, dayStats, dayRecaps, seasonStats, seasonRecaps, recapView, shareLink, sharedView, stopRecaps,
  badgesFor, topLoyalists, report, settingsView, choiceWords, mailReward, give, tenantOf, tick, daily,
};
