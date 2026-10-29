'use strict';
// The waitlist for a full lesson (Track PARENTS). A family leaves their name, email, phone and the student. When a spot
// opens (a cancellation, a moved student, more places), the first family waiting gets an offer by email (and a text with
// the add-on) with a link /waitlist/<mountain>/<token>, good for the school's waitlist_claim_minutes. The spot is held for
// them while the offer stands; claiming books it like any online booking. An offer that runs out goes to the next family.
const crypto = require('crypto');
const { pool, tx, rows, one } = require('../db');
const { z, dateStr } = require('./util');
const { conflict, notFound } = require('./errors');
const { audit } = require('./audit');
const L = require('./levels');
const S = require('./schoolsettings');
const F = require('./lessonfamily');
const { notify } = require('./familynotify');

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const system = (tenantId) => ({ auth: { tenantId, userId: null } });
const MAX_WAITING = 40;

const joinSchema = z.object({
  session_id: z.number().int().positive(),
  contact_name: z.string().trim().min(1).max(150),
  contact_email: z.string().trim().email().max(255),
  contact_phone: z.string().trim().max(40).optional(),
  text_ok: z.boolean().optional(),
  student: z.object({ first_name: z.string().trim().min(1).max(100), last_name: z.string().trim().min(1).max(100), date_of_birth: dateStr.optional(), level: z.number().int().min(1).max(9).optional() }),
  website: z.string().max(200).optional(),
});

/** Places left in a lesson right now: capacity less bookings, held requests and standing offers. */
async function placesLeft(conn, tenantId, s) {
  const { n } = await one(conn, "SELECT COUNT(*) AS n FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND status IN ('booked','attended')", [tenantId, s.id]);
  const held = (await F.heldSpots(conn, tenantId)).get(Number(s.id)) || 0;
  return s.capacity - Number(n) - held;
}

/** Adds a family to the waitlist of a full lesson. Returns their place in line. */
async function join(t, b) {
  return tx(async (conn) => {
    const s = await one(conn, "SELECT * FROM lesson_sessions WHERE tenant_id = ? AND id = ? AND status = 'scheduled' FOR UPDATE", [t.id, b.session_id]);
    if (!s) throw notFound('Lesson');
    if (await placesLeft(conn, t.id, s) > 0) throw conflict('That lesson has a spot open now. Book it instead.');
    const waiting = await rows(conn, "SELECT id, contact_email, student FROM lesson_waitlist WHERE tenant_id = ? AND session_id = ? AND status IN ('waiting','offered') ORDER BY id", [t.id, s.id]);
    if (waiting.length >= MAX_WAITING) throw conflict('The waitlist for that lesson is full. Please call the ski school.');
    const same = waiting.find((w) => { let st = {}; try { st = JSON.parse(w.student); } catch (_) { /* none */ } return w.contact_email.toLowerCase() === b.contact_email.toLowerCase() && String(st.first_name).toLowerCase() === b.student.first_name.toLowerCase(); });
    if (same) return { id: same.id, position: waiting.indexOf(same) + 1, already: true };
    const [r] = await conn.query('INSERT INTO lesson_waitlist (tenant_id, session_id, contact_name, contact_email, contact_phone, text_ok, student) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [t.id, s.id, b.contact_name, b.contact_email, b.contact_phone || null, b.text_ok ? 1 : 0, JSON.stringify(b.student)]);
    await audit(conn, system(t.id), 'waitlist_join', 'lesson_waitlist', r.insertId, { session_id: s.id });
    return { id: r.insertId, position: waiting.length + 1 };
  });
}

/**
 * Offers open spots in a lesson to the families waiting, first come first served. Sends each offer after the commit.
 * Returns how many offers went out.
 */
async function offerNext(tenantId, sessionId, base) {
  const set = await S.get(pool, tenantId);
  const offers = await tx(async (conn) => {
    const s = await one(conn, `SELECT s.*, pr.name AS product FROM lesson_sessions s JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
      WHERE s.tenant_id = ? AND s.id = ? FOR UPDATE`, [tenantId, sessionId]);
    if (!s || s.status !== 'scheduled') return [];
    const t = await one(conn, 'SELECT id, name, slug, timezone FROM tenants WHERE id = ?', [tenantId]);
    if (String(s.starts_at) <= require('./util').nowIn(t.timezone)) return [];
    let left = await placesLeft(conn, tenantId, s);
    const out = [];
    while (left > 0) {
      const w = await one(conn, "SELECT * FROM lesson_waitlist WHERE tenant_id = ? AND session_id = ? AND status = 'waiting' ORDER BY id LIMIT 1 FOR UPDATE", [tenantId, s.id]);
      if (!w) break;
      const token = crypto.randomBytes(24).toString('base64url');
      await conn.query('UPDATE lesson_waitlist SET status = \'offered\', token_sha = ?, offered_at = UTC_TIMESTAMP(), offer_expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE) WHERE tenant_id = ? AND id = ?',
        [sha(token), Number(set.waitlist_claim_minutes), tenantId, w.id]);
      await audit(conn, system(tenantId), 'waitlist_offer', 'lesson_waitlist', w.id, { session_id: s.id, minutes: set.waitlist_claim_minutes });
      out.push({ w, token, t, s });
      left -= 1;
    }
    return out;
  });
  for (const { w, token, t, s } of offers) {
    let st = {}; try { st = JSON.parse(w.student); } catch (_) { /* none */ }
    const link = `${base}/waitlist/${encodeURIComponent(t.slug)}/${token}`;
    const when = `${String(s.starts_at).slice(0, 10)} at ${clock(s.starts_at)}`;
    await notify({ tenant: t, to: { email: w.contact_email, phone: w.contact_phone, textOk: Boolean(w.text_ok) }, tag: 'lesson-waitlist',
      subject: `A spot opened for ${st.first_name}: ${s.product}, ${when}`,
      text: [`Hi ${F.firstOf(w.contact_name)},`, '', `Good news: a spot opened in ${s.product} on ${when}, and ${st.first_name} is first on the waitlist.`,
        `It is held for you for ${set.waitlist_claim_minutes} minutes. Claim it here: ${link}`, '', 'If you do not need it any more, you do not have to do anything.', t.name].join('\n'),
      smsText: `${t.name}: a spot opened for ${st.first_name} in ${s.product} ${when}. Held ${set.waitlist_claim_minutes} min: ${link}` });
  }
  return offers.length;
}

/** Offers that ran out go to the next family. Then any lesson with families waiting and a spot open gets an offer. */
async function tick(base) {
  const lapsed = await rows(pool, "SELECT DISTINCT tenant_id, session_id FROM lesson_waitlist WHERE status = 'offered' AND offer_expires_at <= UTC_TIMESTAMP()");
  const [u] = await pool.query("UPDATE lesson_waitlist SET status = 'expired' WHERE status = 'offered' AND offer_expires_at <= UTC_TIMESTAMP()");
  const waiting = await rows(pool, `SELECT DISTINCT w.tenant_id, w.session_id FROM lesson_waitlist w JOIN lesson_sessions s ON s.tenant_id = w.tenant_id AND s.id = w.session_id
    WHERE w.status = 'waiting' AND s.status = 'scheduled' AND s.starts_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY) LIMIT 500`);
  const seen = new Set(); let offered = 0;
  for (const r of [...lapsed, ...waiting]) {
    const k = `${r.tenant_id}|${r.session_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    try { offered += await offerNext(Number(r.tenant_id), Number(r.session_id), base); } catch (err) { console.error(JSON.stringify({ severity: 'ERROR', job: 'lesson_waitlist', message: err.message })); }
  }
  return { expired: u.affectedRows, offered };
}

/** The offer a waitlist link points to, if it still stands. */
async function offerByToken(tenantId, token) {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(String(token || ''))) return null;
  return one(pool, `SELECT w.*, (w.status = 'offered' AND w.offer_expires_at > UTC_TIMESTAMP()) AS open_now, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), w.offer_expires_at) AS seconds_left,
      s.starts_at, s.ends_at, s.discipline, s.level_min, s.level_max, s.age_min, s.age_max, s.meeting_place, s.status AS session_status, pr.name AS product
    FROM lesson_waitlist w JOIN lesson_sessions s ON s.tenant_id = w.tenant_id AND s.id = w.session_id JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
    WHERE w.tenant_id = ? AND w.token_sha = ?`, [tenantId, sha(token)]);
}

/** What the claim page shows. */
function claimView(w) {
  let st = {}; try { st = JSON.parse(w.student); } catch (_) { /* none */ }
  return {
    status: Number(w.open_now) ? 'open' : w.status === 'claimed' ? 'claimed' : 'expired', seconds_left: Math.max(Number(w.seconds_left) || 0, 0),
    student: { first_name: st.first_name, last_name: st.last_name, date_of_birth: st.date_of_birth || null, level: st.level || null },
    contact: { name: w.contact_name, email: w.contact_email, phone: w.contact_phone },
    lesson: { id: w.session_id, product: w.product, starts_at: w.starts_at, ends_at: w.ends_at, discipline: w.discipline, level_words: L.range(w.level_min, w.level_max), ages: F.agesWords(w.age_min, w.age_max), meeting_place: w.meeting_place },
  };
}

/** Staff: who is waiting for a lesson, in order. */
async function forSession(db, tenantId, sessionId) {
  return (await rows(db, "SELECT id, contact_name, contact_email, contact_phone, student, status, offered_at, offer_expires_at, created_at FROM lesson_waitlist WHERE tenant_id = ? AND session_id = ? AND status IN ('waiting','offered') ORDER BY id", [tenantId, sessionId]))
    .map((w) => { let st = {}; try { st = JSON.parse(w.student); } catch (_) { /* none */ } return { id: w.id, contact_name: w.contact_name, contact_email: w.contact_email, contact_phone: w.contact_phone, student: `${st.first_name || ''} ${st.last_name || ''}`.trim(), level: st.level || null, status: w.status, offer_expires_at: w.offer_expires_at, created_at: w.created_at }; });
}

function clock(s) { const hh = Number(String(s).slice(11, 13)); return `${hh % 12 || 12}:${String(s).slice(14, 16)} ${hh < 12 ? 'AM' : 'PM'}`; }

module.exports = { joinSchema, join, offerNext, tick, offerByToken, claimView, forSession, placesLeft, sha };
