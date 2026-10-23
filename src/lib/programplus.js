'use strict';

// Programs, the rest of the best-of-breed set (see lib/programsessions.js for sessions, days and dates):
//   - program types each mountain names (Multi-week lessons, Race team, Homeschool...)
//   - the season pass check: a child with this season's pass pays no lift ticket part; found on file, or "said so" and
//     flagged for the first lesson
//   - a pass bought after registering: per the mountain's setting, nothing, a refund or a credit for the ticket part
//   - refunds back to the card the place was paid with (or noted for the desk when it was cash)
//   - the day-before reminder to families
const crypto = require('crypto');
const { pool, rows, one } = require('../db');
const { bad, notFound } = require('./errors');
const { newCode, todayIn, addDays } = require('./util');
const mailer = require('./mailer');
const cardrefund = require('./cardrefund');
const { money } = require('./format');
const PS = require('./programsessions');

// ---------------------------------------------------------------- types
const TYPE_DEFAULTS = ['Multi-week lessons', 'Race team', 'Freeride team', 'Club', 'Camp', 'Adult clinic', 'Adaptive', 'League'];
const KIND_TYPE = { school_program: 'Multi-week lessons', race_team: 'Race team', club: 'Club', camp: 'Camp', league: 'League' };

/** The mountain's program types in order. Made the first time, and older programs are given the type matching their kind. */
async function listTypes(db, tenantId, { visibleOnly = false } = {}) {
  let all = await rows(db, 'SELECT id, name, sort_no, hidden FROM program_types WHERE tenant_id = ? ORDER BY sort_no, id', [tenantId]);
  if (!all.length) {
    for (const [i, name] of TYPE_DEFAULTS.entries()) await db.query('INSERT IGNORE INTO program_types (tenant_id, name, sort_no) VALUES (?, ?, ?)', [tenantId, name, i + 1]);
    all = await rows(db, 'SELECT id, name, sort_no, hidden FROM program_types WHERE tenant_id = ? ORDER BY sort_no, id', [tenantId]);
    const byName = new Map(all.map((t) => [t.name, t.id]));
    for (const [kind, name] of Object.entries(KIND_TYPE)) await db.query('UPDATE programs SET type_id = ? WHERE tenant_id = ? AND type_id IS NULL AND kind = ?', [byName.get(name), tenantId, kind]);
  }
  const out = all.map((t) => ({ id: t.id, name: t.name, sort: t.sort_no, hidden: Boolean(t.hidden) }));
  return visibleOnly ? out.filter((t) => !t.hidden) : out;
}

// ---------------------------------------------------------------- the mountain's program settings
const SETTING_DEFAULTS = { pass_later: 'none', pass_later_share: 'unused', reminders: 'first', text_cancellations: true };
async function settingsOf(db, tenantId) {
  const s = await one(db, 'SELECT * FROM program_settings WHERE tenant_id = ?', [tenantId]);
  return s ? { pass_later: s.pass_later, pass_later_share: s.pass_later_share, reminders: s.reminders, text_cancellations: Boolean(s.text_cancellations) } : { ...SETTING_DEFAULTS };
}

// ---------------------------------------------------------------- season pass
/**
 * Does this child hold one of the mountain's season passes good on the session's first day? A known person is looked
 * up directly; a child named online is matched by name and date of birth. Not found: 'claimed' when the parent said
 * they have one (checked at the first lesson), else 'none'.
 */
async function passStatus(conn, tenantId, { personId = null, child = null }, onDate, claimed = false) {
  let ids = personId ? [personId] : [];
  if (!ids.length && child && child.date_of_birth) {
    ids = (await rows(conn, 'SELECT id FROM people WHERE tenant_id = ? AND LOWER(first_name) = ? AND LOWER(last_name) = ? AND date_of_birth = ?',
      [tenantId, String(child.first_name).trim().toLowerCase(), String(child.last_name).trim().toLowerCase(), child.date_of_birth])).map((r) => r.id);
  }
  if (ids.length) {
    const hit = await one(conn, `SELECT t.id FROM tickets t JOIN products p ON p.tenant_id = t.tenant_id AND p.id = t.product_id
      WHERE t.tenant_id = ? AND t.person_id IN (?) AND p.kind = 'season_pass' AND t.status = 'active' AND t.valid_from <= ? AND t.valid_to >= ? LIMIT 1`, [tenantId, ids, onDate, onDate]);
    if (hit) return 'verified';
  }
  return claimed ? 'claimed' : 'none';
}

/** The first lesson date of a session (the day its first group meets), for the pass check. */
async function termStart(conn, tenantId, termId) {
  const r = await one(conn, "SELECT MIN(starts_at) AS d FROM program_sessions WHERE tenant_id = ? AND term_id = ? AND status <> 'cancelled'", [tenantId, termId]);
  return r && r.d ? PS.dstr(r.d) : null;
}

/** A resolver for priceRegistration: the child's pass status for each session, worked out once per session. */
function passResolver(conn, tenantId, who, claimed) {
  const cache = new Map();
  return async (term) => {
    if (!cache.has(term.id)) cache.set(term.id, await passStatus(conn, tenantId, who, (await termStart(conn, tenantId, term.id)) || PS.dstr(term.starts_on), claimed));
    return cache.get(term.id);
  };
}

// ---------------------------------------------------------------- money back
/**
 * Gives part of an order back: to the card it was paid with when it was paid by card through Stripe (online or on the
 * counter's reader), else the desk is told to refund it (cash). Tax goes back in proportion. Returns { how, cents,
 * refund_id }. Call cardrefund.send(tenantId, refund_id) after the transaction commits.
 */
async function refundPart(conn, tenantId, { orderId, cents, reason, note, userId = null }) {
  const order = await one(conn, 'SELECT id, total_cents, tax_cents, refunded_cents FROM orders WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, orderId]);
  if (!order) return { how: 'none', cents: 0 };
  const pre = Number(order.total_cents) - Number(order.tax_cents);
  const tax = pre > 0 ? Math.round((Number(order.tax_cents) * cents) / pre) : 0;
  const amount = Math.min(cents + tax, Number(order.total_cents) - Number(order.refunded_cents));
  if (amount <= 0) return { how: 'none', cents: 0 };
  const card = await one(conn, "SELECT reference FROM order_payments WHERE tenant_id = ? AND order_id = ? AND processor = 'stripe' AND reference LIKE 'pi\\_%' ORDER BY id LIMIT 1", [tenantId, orderId]);
  if (!card) return { how: 'desk', cents: amount, order_id: orderId };
  const [rf] = await conn.query("INSERT INTO order_refunds (tenant_id, order_id, user_id, reason, note, amount_cents, tax_cents, method) VALUES (?, ?, ?, ?, ?, ?, ?, 'card')",
    [tenantId, orderId, userId, reason, String(note || '').slice(0, 300) || null, amount, Math.min(tax, amount)]);
  await cardrefund.markPending(conn, tenantId, rf.insertId, card.reference);
  await conn.query("UPDATE orders SET refunded_cents = refunded_cents + ?, status = IF(refunded_cents >= total_cents, 'refunded', status) WHERE tenant_id = ? AND id = ?", [amount, tenantId, orderId]);
  return { how: 'card', cents: amount, refund_id: rf.insertId, order_id: orderId };
}

/** A credit for the family: a gift card in the parent's name, used like any gift card. */
async function creditFamily(conn, tenantId, { personId, cents, note }) {
  const code = newCode();
  const [gc] = await conn.query('INSERT INTO gift_cards (tenant_id, code, initial_cents, balance_cents, purchaser_id, recipient_name, message) VALUES (?, ?, ?, ?, ?, NULL, ?)', [tenantId, code, cents, cents, personId, String(note || '').slice(0, 300)]);
  await conn.query("INSERT INTO gift_card_txns (tenant_id, gift_card_id, kind, delta_cents, balance_after_cents) VALUES (?, ?, 'issue', ?, ?)", [tenantId, gc.insertId, cents, cents]);
  return { how: 'credit', cents, code };
}

/**
 * A season pass was just sold to this person. Each program place of theirs this season that paid a lift ticket part
 * is adjusted as the mountain chose: nothing, the ticket part back to the card, or a credit. "Unused" gives back only
 * the share of lessons still to come. The program ticket is voided either way when money goes back.
 * Returns a list of { enrollment_id, program, cents, how, code } for the receipt and the cashier.
 */
async function passBought(conn, tenantId, personId, { passFrom, passTo, userId = null } = {}) {
  const s = await settingsOf(conn, tenantId);
  const places = await rows(conn, `SELECT e.*, pr.name AS program, pt.name AS term FROM program_enrollments e JOIN programs pr ON pr.tenant_id = e.tenant_id AND pr.id = e.program_id
    JOIN program_terms pt ON pt.tenant_id = e.tenant_id AND pt.id = e.term_id
    WHERE e.tenant_id = ? AND e.person_id = ? AND e.status = 'enrolled' AND e.ticket_cents > 0 AND e.adjusted_at IS NULL AND e.pass_status IN ('none','no_pass') FOR UPDATE`, [tenantId, personId]);
  const out = [];
  const today = todayIn((await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone);
  for (const e of places) {
    const m = await rows(conn, "SELECT starts_at FROM program_sessions WHERE tenant_id = ? AND group_id = ? AND status = 'scheduled' ORDER BY starts_at", [tenantId, e.group_id]);
    if (!m.length || PS.dstr(m.at(-1).starts_at) < today) continue; // finished
    if (passFrom && PS.dstr(m.at(-1).starts_at) < passFrom) continue;
    if (passTo && PS.dstr(m[0].starts_at) > passTo) continue;
    const left = m.filter((x) => PS.dstr(x.starts_at) >= today).length;
    const cents = s.pass_later_share === 'full' ? Number(e.ticket_cents) : Math.round((Number(e.ticket_cents) * left) / m.length);
    await conn.query("UPDATE program_enrollments SET pass_status = 'verified' WHERE tenant_id = ? AND id = ?", [tenantId, e.id]);
    if (s.pass_later === 'none' || cents <= 0) { out.push({ enrollment_id: e.id, program: `${e.program}, ${e.term}`, cents: 0, how: 'none' }); continue; }
    let r;
    if (s.pass_later === 'credit') r = await creditFamily(conn, tenantId, { personId: e.guardian_id || personId, cents, note: `Lift ticket part of ${e.program}, ${e.term}: season pass bought` });
    else r = e.order_id ? await refundPart(conn, tenantId, { orderId: e.order_id, cents, reason: 'season_pass', note: `Lift ticket part of ${e.program}, ${e.term}: season pass bought`, userId }) : { how: 'desk', cents };
    if (e.ticket_id) await conn.query("UPDATE tickets SET status = 'void' WHERE tenant_id = ? AND id = ?", [tenantId, e.ticket_id]);
    await conn.query('UPDATE program_enrollments SET adjust_cents = ?, adjust_how = ?, adjust_ref = ?, adjusted_at = NOW() WHERE tenant_id = ? AND id = ?', [r.cents, r.how, r.code || (r.refund_id ? String(r.refund_id) : null), tenantId, e.id]);
    out.push({ enrollment_id: e.id, program: `${e.program}, ${e.term}`, cents: r.cents, how: r.how, code: r.code || null, refund_id: r.refund_id || null, order_id: r.order_id || e.order_id || null, guardian_id: e.guardian_id });
  }
  return out;
}

/** After the sale commits: card refunds go to Stripe, and the family hears about a credit or a refund. */
async function afterPassBought(tenantId, adjustments) {
  for (const a of adjustments) {
    if (a.refund_id) await cardrefund.send(tenantId, a.refund_id);
    if (!a.cents || !a.guardian_id || !mailer.enabled()) continue;
    const g = await one(pool, 'SELECT first_name, email FROM people WHERE tenant_id = ? AND id = ?', [tenantId, a.guardian_id]);
    const t = await one(pool, 'SELECT name, phone FROM tenants WHERE id = ?', [tenantId]);
    if (!g || !g.email) continue;
    const what = a.how === 'credit' ? `a credit of ${money(a.cents)}, gift card code ${a.code}, to use on anything at ${t.name}` : a.how === 'card' ? `${money(a.cents)} back to the card you paid with` : `${money(a.cents)} back: please see the ticket window`;
    await mailer.send({ tenantId, to: g.email, fromName: t.name, subject: `Your season pass and ${a.program}`, tag: 'program-pass-credit',
      text: [`Hi ${g.first_name},`, '', `Now that there is a season pass, the lift ticket part of ${a.program} is not needed. You get ${what}.`, '', t.phone ? `Questions? Call ${t.phone}.` : '', t.name].join('\n') }).catch(() => {});
  }
}

// ---------------------------------------------------------------- reminders
/**
 * The daily reminder: families of every group meeting tomorrow (or only its first lesson, per the mountain's setting)
 * get the time, the meeting place and what to bring. Each family is sent one per lesson date, ever.
 */
async function remindAll() {
  if (!mailer.enabled()) return { skipped: 'email is not set up' };
  const tenants = await rows(pool, "SELECT DISTINCT s.tenant_id, t.timezone, t.name, t.phone FROM program_sessions s JOIN tenants t ON t.id = s.tenant_id WHERE s.status = 'scheduled' AND s.group_id IS NOT NULL AND s.starts_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 3 DAY)");
  let sent = 0;
  for (const t of tenants) {
    const set = await settingsOf(pool, t.tenant_id);
    if (set.reminders === 'off') continue;
    const tomorrow = addDays(todayIn(t.timezone), 1);
    const meetings = await rows(pool, `SELECT s.id, s.group_id, s.starts_at, s.kind, pr.name AS program, pr.meeting_place, pr.what_to_bring,
        (SELECT MIN(x.starts_at) FROM program_sessions x WHERE x.tenant_id = s.tenant_id AND x.group_id = s.group_id AND x.status = 'scheduled') AS first_at
      FROM program_sessions s JOIN programs pr ON pr.tenant_id = s.tenant_id AND pr.id = s.program_id
      WHERE s.tenant_id = ? AND s.status = 'scheduled' AND s.group_id IS NOT NULL AND s.starts_at >= ? AND s.starts_at < ?`, [t.tenant_id, `${tomorrow} 00:00:00`, `${addDays(tomorrow, 1)} 00:00:00`]);
    for (const m of meetings) {
      const first = String(m.first_at) === String(m.starts_at);
      if (set.reminders === 'first' && !first && m.kind === 'regular') continue; // a makeup or added date is always reminded
      for (const f of await PS.familiesOf(pool, t.tenant_id, m.group_id)) {
        if (!f.email) continue;
        const [claim] = await pool.query('INSERT IGNORE INTO program_reminders (tenant_id, meeting_id, email) VALUES (?, ?, ?)', [t.tenant_id, m.id, f.email.toLowerCase()]);
        if (!claim.affectedRows) continue;
        const kids = (await PS.familiesOf(pool, t.tenant_id, m.group_id)).filter((x) => x.email && x.email.toLowerCase() === f.email.toLowerCase()).map((x) => x.first_name);
        const text = [`Hi ${f.to_first},`, '', `${first ? 'The first lesson' : m.kind === 'regular' ? 'The next lesson' : 'The makeup lesson'} of ${m.program} for ${kids.join(' and ')} is tomorrow, ${PS.longDay(PS.dstr(m.starts_at))}, at ${PS.clock12(String(m.starts_at).slice(11, 16))}.`,
          m.meeting_place ? `Meet at: ${m.meeting_place}.` : '', m.what_to_bring ? `Bring: ${m.what_to_bring}.` : '', '', t.phone ? `Questions or running late? Call ${t.phone}.` : '', t.name].filter((x, i, a) => x || (a[i - 1] && a[i - 1] !== '')).join('\n');
        const r = await mailer.send({ tenantId: t.tenant_id, to: f.email, fromName: t.name, subject: `Tomorrow: ${m.program}`, text, tag: 'program-reminder' }).catch(() => ({ ok: false }));
        if (r.ok) sent += 1; else await pool.query('DELETE FROM program_reminders WHERE tenant_id = ? AND meeting_id = ? AND email = ?', [t.tenant_id, m.id, f.email.toLowerCase()]);
      }
    }
  }
  return { sent };
}

// ---------------------------------------------------------------- the parent's sign-in
const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const LINK_MINUTES = 30; const SESSION_DAYS = 30;

async function newToken(tenantId, email, kind) {
  const token = crypto.randomBytes(24).toString('base64url');
  await pool.query(`INSERT INTO family_tokens (tenant_id, email, token_hash, kind, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ${kind === 'link' ? `${LINK_MINUTES} MINUTE` : `${SESSION_DAYS} DAY`}))`, [tenantId, email, hash(token), kind]);
  return token;
}

/** Turns a one-time emailed link into a session. Returns { token, email }, or throws. */
async function redeemLink(tenantId, token) {
  const r = await one(pool, "SELECT id, email FROM family_tokens WHERE tenant_id = ? AND token_hash = ? AND kind = 'link' AND used_at IS NULL AND expires_at > NOW()", [tenantId, hash(token)]);
  if (!r) throw bad('This sign-in link has expired or was already used. Ask for a new one.');
  const [u] = await pool.query('UPDATE family_tokens SET used_at = NOW() WHERE id = ? AND used_at IS NULL', [r.id]);
  if (!u.affectedRows) throw bad('This sign-in link was already used. Ask for a new one.');
  return { token: await newToken(tenantId, r.email, 'session'), email: r.email };
}

async function sessionEmail(tenantId, token) {
  if (!token) return null;
  const r = await one(pool, "SELECT email FROM family_tokens WHERE tenant_id = ? AND token_hash = ? AND kind = 'session' AND expires_at > NOW()", [tenantId, hash(token)]);
  return r ? r.email : null;
}

async function endSession(tenantId, token) {
  await pool.query("UPDATE family_tokens SET expires_at = NOW() WHERE tenant_id = ? AND token_hash = ? AND kind = 'session'", [tenantId, hash(token)]);
}

/** The family behind an email: the adults with it, and every child linked to them as guardian or on a place they booked. */
async function familyOf(db, tenantId, email) {
  const adults = (await rows(db, 'SELECT id, first_name, last_name FROM people WHERE tenant_id = ? AND LOWER(email) = ? AND anonymised_at IS NULL', [tenantId, String(email).toLowerCase()]));
  if (!adults.length) return { adults: [], ids: [] };
  const aIds = adults.map((a) => a.id);
  const kids = await rows(db, `SELECT DISTINCT p.id FROM people p WHERE p.tenant_id = ? AND (p.id IN (SELECT member_id FROM person_links WHERE tenant_id = ? AND adult_id IN (?) AND relation = 'guardian')
    OR p.id IN (SELECT person_id FROM program_enrollments WHERE tenant_id = ? AND guardian_id IN (?)))`, [tenantId, tenantId, aIds, tenantId, aIds]);
  return { adults, ids: [...new Set([...aIds, ...kids.map((k) => k.id)])], adultIds: aIds };
}

module.exports = {
  TYPE_DEFAULTS, listTypes, settingsOf, SETTING_DEFAULTS, passStatus, passResolver, termStart, refundPart, creditFamily, passBought, afterPassBought,
  remindAll, newToken, redeemLink, sessionEmail, endSession, familyOf, hash, notFound,
};
