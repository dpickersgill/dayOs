'use strict';
// The weather playbook: one place for a storm, wind or rain call that touches lessons AND program meetings together.
//   - Delay: the day's lessons and meetings (or those in a time window) start later. Families and instructors are told.
//   - Cancel: they are canceled. Each family gets a link (/weather/<slug>/<token>) to choose, in one tap: a makeup date
//     (lessons that fit on the makeup day, or the program's makeup week), a lesson credit (lesson_credits source
//     'weather', usable at the counter and online), or a refund. No answer in 7 days becomes a credit (daily()).
//   - Move: each lesson is copied to the makeup day (with its instructor when they are free) and each family is moved
//     into the copy on the same booking row; each program meeting gets an extra date on the makeup day. The family can
//     still choose a credit or a refund instead.
// A call is all or nothing: one transaction, so a day can never be left half canceled. Messages go after the commit.
const crypto = require('crypto');
const { pool, tx, one, rows } = require('../db');
const { bad, conflict, notFound } = require('./errors');
const { audit } = require('./audit');
const { addDays, todayIn, nowIn, seasonFor } = require('./util');
const { staffProblems } = require('./workforce');
const { studentClash, clashWords } = require('./lessonrules');
const { ON_FILE } = require('./waivers');
const levels = require('./levels');
const PS = require('./programsessions');
const PP = require('./programplus');
const cardrefund = require('./cardrefund');
const familynotify = require('./familynotify');
const mailer = require('./mailer');
const sms = require('./sms');

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const looksRight = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{32,64}$/.test(t);
const newToken = () => crypto.randomBytes(24).toString('base64url');
const pad = (n) => String(n).padStart(2, '0');
const DAY_MS = 86400000;

/** 'YYYY-MM-DD HH:MM:SS' plus minutes, as wall-clock arithmetic (lesson times are mountain local time). */
function plusMinutes(dt, minutes) {
  const d = new Date(`${String(dt).replace(' ', 'T').slice(0, 19)}Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
const clock = (dt) => { const [hh, mm] = String(dt).slice(11, 16).split(':').map(Number); return `${((hh + 11) % 12) + 1}:${pad(mm)} ${hh < 12 ? 'AM' : 'PM'}`; };
const longDay = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${String(d).slice(0, 10)}T12:00:00Z`));
const money = (c) => `$${(Number(c) / 100).toFixed(2)}`;
const ageOn = (dob, day) => { if (!dob) return null; const b = String(dob).slice(0, 10); let a = Number(day.slice(0, 4)) - Number(b.slice(0, 4)); if (day.slice(5, 10) < b.slice(5, 10)) a -= 1; return a; };

async function settingsOf(db, tenantId) {
  const r = await one(db, 'SELECT * FROM school_director_settings WHERE tenant_id = ?', [tenantId]);
  return { weather_credit_product_id: r ? r.weather_credit_product_id : null, choice_days: r ? Number(r.choice_days) : 7 };
}

/** The lesson product a program family's weather credit is for: the one the director chose, else the cheapest group lesson. */
async function creditProduct(db, tenantId) {
  const s = await settingsOf(db, tenantId);
  if (s.weather_credit_product_id) {
    const p = await one(db, "SELECT id, name, base_price_cents FROM products WHERE tenant_id = ? AND id = ? AND kind = 'lesson'", [tenantId, s.weather_credit_product_id]);
    if (p) return p;
  }
  return one(db, "SELECT id, name, base_price_cents FROM products WHERE tenant_id = ? AND kind = 'lesson' AND active = 1 AND (uses IS NULL OR uses <= 1) ORDER BY base_price_cents, id LIMIT 1", [tenantId]);
}

// ---------------------------------------------------------------- what a call touches
const timeWhere = (alias, b) => {
  const w = [`${alias}.starts_at >= ?`, `${alias}.starts_at < ?`];
  const p = [`${b.date} ${b.from_time ? `${b.from_time.slice(0, 5)}:00` : '00:00:00'}`, b.to_time ? `${b.date} ${b.to_time.slice(0, 5)}:00` : `${addDays(b.date, 1)} 00:00:00`];
  return { w, p };
};

async function lessonsIn(db, tenantId, b, lock = false) {
  const { w, p } = timeWhere('s', b);
  return rows(db, `SELECT s.*, pr.name AS product,
      (SELECT COUNT(*) FROM lesson_bookings x WHERE x.tenant_id = s.tenant_id AND x.session_id = s.id AND x.status = 'booked') AS booked
    FROM lesson_sessions s JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
    WHERE s.tenant_id = ? AND s.status = 'scheduled' AND ${w.join(' AND ')} ORDER BY s.starts_at, s.id${lock ? ' FOR UPDATE' : ''}`, [tenantId, ...p]);
}

async function meetingsIn(db, tenantId, b, lock = false) {
  const { w, p } = timeWhere('s', b);
  return rows(db, `SELECT s.*, pr.name AS program, pt.name AS term,
      (SELECT COUNT(*) FROM program_enrollments e WHERE e.tenant_id = s.tenant_id AND e.group_id = s.group_id AND e.status = 'enrolled') AS enrolled
    FROM program_sessions s JOIN programs pr ON pr.tenant_id = s.tenant_id AND pr.id = s.program_id
    LEFT JOIN program_terms pt ON pt.tenant_id = s.tenant_id AND pt.id = s.term_id
    WHERE s.tenant_id = ? AND s.status = 'scheduled' AND ${w.join(' AND ')} ORDER BY s.starts_at, s.id${lock ? ' FOR UPDATE' : ''}`, [tenantId, ...p]);
}

/** Who is on a lesson, with what they paid and how (for the refund and the words in the preview). */
async function lessonFamilies(db, tenantId, sessionId) {
  const list = await rows(db, `SELECT b.id, b.person_id, b.credit_id, b.request_id, b.unpaid, b.text_ok, b.contact_email, b.contact_phone, b.level,
      p.first_name, p.last_name, p.email, p.phone, p.date_of_birth, p.ski_level, p.snowboard_level
    FROM lesson_bookings b JOIN people p ON p.tenant_id = b.tenant_id AND p.id = b.person_id
    WHERE b.tenant_id = ? AND b.session_id = ? AND b.status = 'booked' ORDER BY b.id`, [tenantId, sessionId]);
  for (const b of list) {
    b.value_cents = 0; b.order_id = null; b.paid = 'unpaid';
    if (b.credit_id) { b.paid = 'package'; continue; }
    if (b.request_id) {
      const r = await one(db, `SELECT r.order_id, r.status, o.total_cents, o.tax_cents, o.refunded_cents,
          (SELECT COUNT(*) FROM lesson_bookings x WHERE x.tenant_id = r.tenant_id AND x.request_id = r.id) AS n, r.contact_email, r.contact_phone
        FROM lesson_requests r LEFT JOIN orders o ON o.tenant_id = r.tenant_id AND o.id = r.order_id WHERE r.tenant_id = ? AND r.id = ?`, [tenantId, b.request_id]);
      if (r) {
        b.contact_email = b.contact_email || r.contact_email; b.contact_phone = b.contact_phone || r.contact_phone;
        if (r.order_id && r.status === 'confirmed') {
          b.order_id = r.order_id; b.paid = 'online';
          b.value_cents = Math.max(0, Math.round((Number(r.total_cents) - Number(r.tax_cents)) / Math.max(1, Number(r.n))));
        }
      }
      continue;
    }
    const item = await one(db, `SELECT i.order_id, i.unit_price_cents, i.quantity, i.discount_cents FROM order_items i
      WHERE i.tenant_id = ? AND i.session_id = ? AND i.person_id = ? AND i.refunded_at IS NULL ORDER BY i.id DESC LIMIT 1`, [tenantId, sessionId, b.person_id]);
    if (item) { b.order_id = item.order_id; b.paid = 'desk'; b.value_cents = Math.max(0, Number(item.unit_price_cents) * Number(item.quantity) - Number(item.discount_cents)); }
  }
  return list;
}

/** The families in a program meeting's group: the guardian's contact, and one lesson's share of what they paid. */
async function meetingFamilies(db, tenantId, m) {
  if (!m.group_id) return [];
  const t = m.term_id ? await one(db, 'SELECT weeks, price_cents FROM program_terms WHERE tenant_id = ? AND id = ?', [tenantId, m.term_id]) : null;
  const weeks = t ? Math.max(1, Number(t.weeks)) : 1;
  const list = await rows(db, `SELECT e.id AS enrollment_id, e.person_id, e.order_id, e.paid_cents, e.lesson_cents, e.price_cents, p.first_name, p.last_name,
      COALESCE(g.email, p.email) AS email, COALESCE(g.phone, p.phone) AS phone, COALESCE(g.first_name, p.first_name) AS to_first
    FROM program_enrollments e JOIN people p ON p.tenant_id = e.tenant_id AND p.id = e.person_id
    LEFT JOIN people g ON g.tenant_id = e.tenant_id AND g.id = e.guardian_id
    WHERE e.tenant_id = ? AND e.group_id = ? AND e.status = 'enrolled' ORDER BY e.id`, [tenantId, m.group_id]);
  for (const e of list) {
    const paid = Boolean(e.order_id) || Number(e.paid_cents) > 0;
    const base = e.lesson_cents != null ? Number(e.lesson_cents) : e.price_cents != null ? Number(e.price_cents) : t ? Number(t.price_cents) : 0;
    e.value_cents = paid ? Math.round(base / weeks) : 0;
  }
  return list;
}

// ---------------------------------------------------------------- preview
const scopeSchemaKeys = ['date', 'from_time', 'to_time'];

/** What a call would do, in plain numbers: lessons, meetings, families, how they paid, and the instructors touched. */
async function preview(tenantId, b) {
  const lessons = await lessonsIn(pool, tenantId, b);
  const meetings = await meetingsIn(pool, tenantId, b);
  const families = new Set(); let students = 0; let online = 0; let desk = 0; let pack = 0; let unpaid = 0; let value = 0;
  for (const s of lessons) {
    const fam = await lessonFamilies(pool, tenantId, s.id);
    s.students = fam.map((f) => f.first_name);
    for (const f of fam) {
      students += 1; families.add(String(f.contact_email || f.email || `p${f.person_id}`).toLowerCase()); value += f.value_cents;
      if (f.paid === 'online') online += 1; else if (f.paid === 'desk') desk += 1; else if (f.paid === 'package') pack += 1; else unpaid += 1;
    }
  }
  let programKids = 0; let programValue = 0;
  for (const m of meetings) {
    const fam = await meetingFamilies(pool, tenantId, m);
    programKids += fam.length;
    for (const f of fam) { families.add(String(f.email || `p${f.person_id}`).toLowerCase()); programValue += f.value_cents; }
    m.makeup = m.group_id ? await one(pool, "SELECT id, starts_at FROM program_sessions WHERE tenant_id = ? AND group_id = ? AND status = 'standby' AND starts_at > ? ORDER BY starts_at LIMIT 1", [tenantId, m.group_id, m.starts_at]) : null;
  }
  const instructors = new Set(lessons.filter((s) => s.instructor_id).map((s) => s.instructor_id));
  meetings.filter((m) => m.coach_staff_id).forEach((m) => instructors.add(m.coach_staff_id));
  const set = await settingsOf(pool, tenantId);
  return {
    lessons: lessons.map((s) => ({ id: s.id, starts_at: s.starts_at, ends_at: s.ends_at, product: s.product, discipline: s.discipline, level_words: levels.range(s.level_min, s.level_max), booked: Number(s.booked), instructor_id: s.instructor_id, delay_minutes: s.delay_minutes, students: s.students })),
    meetings: meetings.map((m) => ({ id: m.id, starts_at: m.starts_at, ends_at: m.ends_at, program: m.program, term: m.term, enrolled: Number(m.enrolled), makeup_date: m.makeup ? String(m.makeup.starts_at).slice(0, 10) : null })),
    counts: { lessons: lessons.length, meetings: meetings.length, families: families.size, students, program_kids: programKids, paid_online: online, paid_desk: desk, on_package: pack, unpaid, lesson_value_cents: value, program_value_cents: programValue, instructors: instructors.size },
    choice_days: set.choice_days,
    credit_product: (await creditProduct(pool, tenantId)) || null,
  };
}

/** The same numbers as one short paragraph, for the confirm screen and the audit trail. */
function words(action, p, b) {
  const c = p.counts;
  const what = [c.lessons ? `${c.lessons} lesson${c.lessons === 1 ? '' : 's'}` : null, c.meetings ? `${c.meetings} program meeting${c.meetings === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ') || 'nothing';
  const fam = `${c.families} famil${c.families === 1 ? 'y' : 'ies'}`;
  if (action === 'delay') return `${what} start ${b.delay_minutes} minutes later. ${fam} and ${c.instructors} instructor${c.instructors === 1 ? '' : 's'} are told.`;
  const tail = `Each family gets a link to choose a makeup date, a lesson credit or a refund. No answer in ${p.choice_days} days becomes a credit.`;
  if (action === 'cancel') return `${what} canceled. ${fam} told. ${tail} Refunds at most ${money(c.lesson_value_cents + c.program_value_cents)} if every family chooses one.`;
  return `${what} moved to ${longDay(b.makeup_date)}, same times. ${fam} told and booked on the new day. They can choose a credit or a refund instead.`;
}

// ---------------------------------------------------------------- doing it
const fakeReq = (tenantId, userId = null) => ({ auth: { tenantId, userId }, ip: null });

async function choiceRow(conn, tenantId, callId, x, expiresAt) {
  const token = newToken();
  const [r] = await conn.query(`INSERT INTO weather_choices (tenant_id, call_id, kind, booking_id, session_id, enrollment_id, meeting_id, person_id, token_sha, email, phone, text_ok,
      value_cents, refund_order_id, on_package, choice, chosen_at, chosen_via, makeup_session_id, makeup_meeting_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [tenantId, callId, x.kind, x.booking_id || null, x.session_id || null, x.enrollment_id || null, x.meeting_id || null, x.person_id, sha(token), x.email || null, x.phone || null, x.text_ok ? 1 : 0,
    x.value_cents || 0, x.order_id || null, x.on_package ? 1 : 0, x.choice || 'open', x.choice && x.choice !== 'open' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null, x.via || null,
    x.makeup_session_id || null, x.makeup_meeting_id || null, expiresAt]);
  return { id: r.insertId, token };
}

/**
 * Runs a call. b: { action, date, from_time?, to_time?, delay_minutes?, makeup_date?, reason }. Returns a summary and
 * the messages to send (sent by run() after the commit).
 */
async function apply(conn, tenantId, b, req) {
  const t = await one(conn, 'SELECT id, name, slug, phone, timezone FROM tenants WHERE id = ?', [tenantId]);
  const set = await settingsOf(conn, tenantId);
  const lessons = await lessonsIn(conn, tenantId, b, true);
  const meetings = await meetingsIn(conn, tenantId, b, true);
  if (!lessons.length && !meetings.length) throw bad('No lessons or program meetings are scheduled then');
  if (b.action === 'move') {
    if (!b.makeup_date) throw bad('Pick the makeup day');
    if (b.makeup_date <= b.date) throw bad('The makeup day must be after the day being moved');
  }
  if (b.action === 'delay' && !(b.delay_minutes > 0)) throw bad('Say how many minutes to delay');
  const [cr] = await conn.query('INSERT INTO weather_calls (tenant_id, action, on_date, from_time, to_time, delay_minutes, makeup_date, reason, lessons_n, meetings_n, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [tenantId, b.action, b.date, b.from_time || null, b.to_time || null, b.action === 'delay' ? b.delay_minutes : 0, b.makeup_date || null, b.reason, lessons.length, meetings.length, req.auth.userId || null]);
  const callId = cr.insertId;
  const expires = nowPlusDays(set.choice_days);
  const out = { call_id: callId, action: b.action, lessons: lessons.length, meetings: meetings.length, messages: [], staff: new Map(), moved: 0, not_moved: [], instructors_dropped: [] };
  const staffNote = (staffId, line) => { if (!staffId) return; const l = out.staff.get(staffId) || []; l.push(line); out.staff.set(staffId, l); };

  if (b.action === 'delay') {
    const d = b.delay_minutes;
    for (const s of lessons) {
      await conn.query('UPDATE lesson_sessions SET starts_at = ?, ends_at = ?, delay_minutes = delay_minutes + ? WHERE tenant_id = ? AND id = ?', [plusMinutes(s.starts_at, d), plusMinutes(s.ends_at, d), d, tenantId, s.id]);
      for (const f of await lessonFamilies(conn, tenantId, s.id)) {
        out.messages.push({ to: { email: f.contact_email || f.email, phone: f.contact_phone || f.phone, textOk: Boolean(f.text_ok) }, subject: `${f.first_name}'s lesson starts ${d} minutes later`,
          text: [`Hello,`, '', `Because of the weather, ${f.first_name}'s ${s.product} lesson today starts ${d} minutes later, at ${clock(plusMinutes(s.starts_at, d))} instead of ${clock(s.starts_at)}.`, b.reason ? `Why: ${b.reason}` : null, s.meeting_place ? `Same meeting place: ${s.meeting_place}.` : null, '', 'See you soon,', t.name].filter((x) => x !== null).join('\n'),
          smsText: `${t.name}: ${f.first_name}'s lesson now starts at ${clock(plusMinutes(s.starts_at, d))} (${d} min later, weather).`, tag: 'lesson-delay' });
      }
      staffNote(s.instructor_id, `${s.product} now ${clock(plusMinutes(s.starts_at, d))} (was ${clock(s.starts_at)})`);
    }
    for (const m of meetings) {
      await conn.query('UPDATE program_sessions SET starts_at = ?, ends_at = ? WHERE tenant_id = ? AND id = ?', [plusMinutes(m.starts_at, d), plusMinutes(m.ends_at, d), tenantId, m.id]);
      for (const f of await meetingFamilies(conn, tenantId, m)) {
        out.messages.push({ program: true, to: { email: f.email, phone: f.phone, textOk: false }, subject: `${m.program} starts ${d} minutes later today`,
          text: [`Hi ${f.to_first},`, '', `Because of the weather, ${m.program} today starts ${d} minutes later, at ${clock(plusMinutes(m.starts_at, d))}. Same place.`, b.reason ? `Why: ${b.reason}` : null, '', t.name].filter((x) => x !== null).join('\n'), tag: 'program-delay' });
      }
      staffNote(m.coach_staff_id, `${m.program} now ${clock(plusMinutes(m.starts_at, d))} (was ${clock(m.starts_at)})`);
    }
  } else {
    const moving = b.action === 'move';
    for (const s of lessons) {
      let copyId = null;
      if (moving) {
        const startsAt = `${b.makeup_date} ${String(s.starts_at).slice(11, 19)}`; const endsAt = `${b.makeup_date} ${String(s.ends_at).slice(11, 19)}`;
        let instructor = s.instructor_id;
        if (instructor) {
          const problems = await staffProblems(conn, tenantId, { staffId: instructor, certificationIds: s.required_certification_id ? [s.required_certification_id] : [], startsAt, endsAt });
          if (problems.length) { out.instructors_dropped.push({ session: s.product, at: startsAt, why: problems[0] }); instructor = null; }
        }
        const [ins] = await conn.query(`INSERT INTO lesson_sessions (tenant_id, product_id, discipline, ability_level, format, age_group, meeting_place, notes, starts_at, ends_at, capacity, instructor_id,
            required_certification_id, level_min, level_max, age_min, age_max, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'copy')`,
        [tenantId, s.product_id, s.discipline, s.ability_level, s.format, s.age_group, s.meeting_place, s.notes, startsAt, endsAt, s.capacity, instructor, s.required_certification_id, s.level_min, s.level_max, s.age_min, s.age_max]);
        copyId = ins.insertId;
        await audit(conn, req, 'weather_move', 'lesson_sessions', copyId, { from_session: s.id, call: callId });
        staffNote(s.instructor_id, instructor ? `${s.product} ${clock(s.starts_at)} moved to ${longDay(b.makeup_date)}, same time, still yours` : `${s.product} ${clock(s.starts_at)} moved to ${longDay(b.makeup_date)} (you are not on it)`);
      } else staffNote(s.instructor_id, `${s.product} ${clock(s.starts_at)} canceled`);
      const fam = await lessonFamilies(conn, tenantId, s.id);
      for (const f of fam) {
        let movedTo = null;
        if (copyId) {
          const clash = await studentClash(conn, tenantId, f.person_id, `${b.makeup_date} ${String(s.starts_at).slice(11, 19)}`, `${b.makeup_date} ${String(s.ends_at).slice(11, 19)}`, { ignoreSessionId: s.id });
          if (clash) out.not_moved.push({ name: `${f.first_name} ${f.last_name}`, why: clashWords(clash) });
          else {
            await conn.query("UPDATE lesson_bookings SET session_id = ?, moved_from_session_id = ?, moved_at = NOW(), checked_in_at = NULL, checked_in_by = NULL, checked_in_via = NULL WHERE tenant_id = ? AND id = ?", [copyId, s.id, tenantId, f.id]);
            movedTo = copyId; out.moved += 1;
          }
        }
        if (!movedTo) await conn.query("UPDATE lesson_bookings SET status = 'cancelled' WHERE tenant_id = ? AND id = ?", [tenantId, f.id]);
        const c = await choiceRow(conn, tenantId, callId, { kind: 'lesson', booking_id: f.id, session_id: s.id, person_id: f.person_id, email: f.contact_email || f.email, phone: f.contact_phone || f.phone, text_ok: f.text_ok,
          value_cents: f.value_cents, order_id: f.order_id, on_package: f.paid === 'package', choice: movedTo ? 'makeup' : 'open', via: movedTo ? 'move' : null, makeup_session_id: movedTo }, expires);
        out.messages.push(lessonMessage(t, b, s, f, c, movedTo, set.choice_days));
      }
      await conn.query("UPDATE lesson_sessions SET status = 'cancelled', cancel_reason = ?, cancelled_at = NOW(), cancelled_by = ? WHERE tenant_id = ? AND id = ?", [`Weather: ${b.reason}`.slice(0, 300), req.auth.userId || null, tenantId, s.id]);
      // An online request still waiting for staff holds no seat: it is simply canceled.
      await conn.query("UPDATE lesson_requests SET status = 'cancelled', decided_at = NOW(), staff_note = ? WHERE tenant_id = ? AND session_id = ? AND status IN ('pending','awaiting_payment')", [`Canceled for weather: ${b.reason}`.slice(0, 300), tenantId, s.id]);
      await audit(conn, req, b.action === 'move' ? 'weather_move' : 'weather_cancel', 'lesson_sessions', s.id, { call: callId, families: fam.length, reason: b.reason });
    }
    const credit = await creditProduct(conn, tenantId);
    for (const m of meetings) {
      let makeup = null;
      if (moving) {
        await conn.query("UPDATE program_sessions SET status = 'cancelled', cancel_reason = ?, cancelled_at = NOW() WHERE tenant_id = ? AND id = ?", [`Weather: ${b.reason}`.slice(0, 255), tenantId, m.id]);
        const [ins] = await conn.query("INSERT INTO program_sessions (tenant_id, program_id, term_id, group_id, starts_at, ends_at, kind, status, coach_staff_id) VALUES (?, ?, ?, ?, ?, ?, 'extra', 'scheduled', ?)",
          [tenantId, m.program_id, m.term_id, m.group_id, `${b.makeup_date} ${String(m.starts_at).slice(11, 19)}`, `${b.makeup_date} ${String(m.ends_at).slice(11, 19)}`, m.coach_staff_id]);
        if (m.group_id) await PS.stretchTickets(conn, tenantId, m.group_id);
        makeup = { id: ins.insertId, starts_at: `${b.makeup_date} ${String(m.starts_at).slice(11, 19)}` };
        staffNote(m.coach_staff_id, `${m.program} ${clock(m.starts_at)} moved to ${longDay(b.makeup_date)}`);
      } else {
        const r = await PS.cancelMeeting(conn, tenantId, m.id, `Weather: ${b.reason}`.slice(0, 255));
        makeup = r.makeup;
        staffNote(m.coach_staff_id, `${m.program} ${clock(m.starts_at)} canceled${makeup ? `, makeup on ${longDay(makeup.date)}` : ''}`);
      }
      await audit(conn, req, b.action === 'move' ? 'weather_move' : 'weather_cancel', 'programs', m.program_id, { call: callId, meeting: m.id, makeup: makeup ? makeup.id : null, reason: b.reason });
      for (const f of await meetingFamilies(conn, tenantId, m)) {
        const c = await choiceRow(conn, tenantId, callId, { kind: 'program', enrollment_id: f.enrollment_id, meeting_id: m.id, person_id: f.person_id, email: f.email, phone: f.phone, text_ok: false,
          value_cents: f.value_cents, order_id: f.order_id, choice: makeup ? 'makeup' : 'open', via: makeup ? (moving ? 'move' : 'auto') : null, makeup_meeting_id: makeup ? makeup.id : null }, expires);
        out.messages.push(programMessage(t, b, m, f, c, makeup, set.choice_days, Boolean(credit)));
      }
    }
  }
  const families = new Set(out.messages.map((x) => String(x.to.email || x.to.phone || '').toLowerCase()).filter(Boolean));
  await conn.query('UPDATE weather_calls SET families_n = ? WHERE tenant_id = ? AND id = ?', [families.size, tenantId, callId]);
  await audit(conn, req, `weather_${b.action}`, 'weather_calls', callId, { date: b.date, from: b.from_time || null, to: b.to_time || null, minutes: b.delay_minutes || null, makeup: b.makeup_date || null, lessons: lessons.length, meetings: meetings.length, families: families.size });
  out.families = families.size;
  out.tenant = t;
  return out;
}

function nowPlusDays(days) {
  return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 19).replace('T', ' ');
}

const linkFor = (base, slug, token) => `${base}/weather/${encodeURIComponent(slug)}/${token}`;

function lessonMessage(t, b, s, f, c, movedTo, days) {
  const day = longDay(s.starts_at);
  const link = { token: c.token };
  if (movedTo) {
    return { link, to: { email: f.contact_email || f.email, phone: f.contact_phone || f.phone, textOk: Boolean(f.text_ok) }, subject: `${f.first_name}'s lesson moved to ${longDay(b.makeup_date)}`,
      text: [`Hello,`, '', `Because of the weather (${b.reason}), we moved ${f.first_name}'s ${s.product} lesson from ${day} to ${longDay(b.makeup_date)}, same time (${clock(s.starts_at)}) and place.`, '',
        `${f.first_name} is already booked on the new day. If that day does not work, you can take a lesson credit or a refund instead:`, '{link}', '', 'Thank you for understanding,', t.name].join('\n'),
      smsText: `${t.name}: weather moved ${f.first_name}'s lesson to ${longDay(b.makeup_date)}, same time. Other options: {link}`, tag: 'lesson-weather' };
  }
  return { link, to: { email: f.contact_email || f.email, phone: f.contact_phone || f.phone, textOk: Boolean(f.text_ok) }, subject: `${f.first_name}'s lesson on ${day} is canceled`,
    text: [`Hello,`, '', `We're sorry: because of the weather (${b.reason}), ${f.first_name}'s ${s.product} lesson on ${day} at ${clock(s.starts_at)} is canceled.`, '',
      'Choose what you would like, in one tap: another lesson day, a lesson credit, or a refund:', '{link}', '', `If we don't hear from you in ${days} days, we'll keep it as a lesson credit for you.`, '', t.phone ? `Questions? Call ${t.phone}.` : null, t.name].filter((x) => x !== null).join('\n'),
    smsText: `${t.name}: ${f.first_name}'s lesson on ${day} is canceled (weather). Pick a new day, a credit or a refund: {link}`, tag: 'lesson-weather' };
}

function programMessage(t, b, m, f, c, makeup, days, creditOk) {
  const day = longDay(m.starts_at);
  const mk = makeup ? longDay(String(makeup.starts_at || makeup.date).slice(0, 10)) : null;
  const opts = creditOk ? 'a lesson credit or a refund' : 'a refund';
  return { program: true, link: { token: c.token }, to: { email: f.email, phone: f.phone, textOk: false },
    subject: makeup ? `${m.program}: ${day} moves to ${mk}` : `${m.program}: ${day} is canceled`,
    text: [`Hi ${f.to_first},`, '', `Because of the weather (${b.reason}), ${m.program} on ${day} is ${b.action === 'move' ? 'moved' : 'canceled'}.`,
      makeup ? `The makeup for ${f.first_name} is ${mk}, same time and place. Nothing to do if that works.` : `Please choose what you would like for ${f.first_name}.`,
      makeup ? `If it does not, choose ${opts} instead:` : `A makeup date, ${opts}:`, '{link}', '', makeup ? null : `If we don't hear from you in ${days} days, we'll keep it as a lesson credit for you.`, t.phone ? `Questions? Call ${t.phone}.` : null, t.name].filter((x) => x !== null).join('\n'),
    tag: 'program-weather' };
}

/** Sends the messages of a call, with each family's link. Never throws. Returns how many went out. */
async function sendAll(out, base) {
  const t = out.tenant;
  let emails = 0; let texts = 0;
  for (const msg of out.messages) {
    const link = msg.link ? linkFor(base, t.slug, msg.link.token) : '';
    const fill = (s) => (s ? s.replace('{link}', link) : s);
    const r = await familynotify.notify({ tenant: t, to: msg.to, subject: msg.subject, text: fill(msg.text), smsText: fill(msg.smsText), tag: msg.tag });
    if (r.email && r.email.ok) emails += 1;
    if (r.text && r.text.ok) texts += 1;
  }
  // Instructors are staff, not families: a text (when texts are set up) or an email, straight from lib/sms and the mailer.
  let staffTold = 0;
  for (const [staffId, lines] of out.staff) {
    const p = await one(pool, 'SELECT p.first_name, p.email, p.phone FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE s.tenant_id = ? AND s.id = ?', [t.id, staffId]).catch(() => null);
    if (!p) continue;
    const body = `${t.name} weather call: ${lines.join('; ')}.`;
    let ok = false;
    if (p.phone && sms.enabled()) ok = (await sms.send({ tenantId: t.id, to: p.phone, body: body.slice(0, 300) }).catch(() => ({ ok: false }))).ok;
    if (!ok && p.email) ok = (await mailer.send({ tenantId: t.id, to: p.email, fromName: t.name, subject: 'Weather call: your lessons changed', text: [`Hi ${p.first_name},`, '', ...lines.map((l) => `- ${l}`), '', 'Open My day in the app for the details.', t.name].join('\n'), tag: 'weather-staff' }).catch(() => ({ ok: false }))).ok;
    if (ok) staffTold += 1;
  }
  return { emails, texts, staff_told: staffTold };
}

/** Runs a call end to end: the transaction, then the messages. */
async function run(tenantId, b, req, base) {
  const out = await tx((conn) => apply(conn, tenantId, b, req));
  const sent = await sendAll(out, base);
  return { call_id: out.call_id, action: out.action, lessons: out.lessons, meetings: out.meetings, families: out.families, moved: out.moved, not_moved: out.not_moved, instructors_dropped: out.instructors_dropped, ...sent };
}

// ---------------------------------------------------------------- the family's choice
async function choiceByToken(db, tenantId, token, lock = false) {
  if (!looksRight(token)) return null;
  return one(db, `SELECT * FROM weather_choices WHERE tenant_id = ? AND token_sha = ?${lock ? ' FOR UPDATE' : ''}`, [tenantId, sha(token)]);
}

/** The lesson a lesson choice was about (the canceled one), with the student. */
async function choiceContext(db, tenantId, c) {
  const person = await one(db, 'SELECT id, first_name, date_of_birth, ski_level, snowboard_level FROM people WHERE tenant_id = ? AND id = ?', [tenantId, c.person_id]);
  const call = await one(db, 'SELECT action, on_date, reason, makeup_date FROM weather_calls WHERE tenant_id = ? AND id = ?', [tenantId, c.call_id]);
  let lesson = null; let meeting = null; let current = null;
  if (c.kind === 'lesson') {
    lesson = await one(db, `SELECT s.id, s.starts_at, s.ends_at, s.discipline, s.level_min, s.level_max, s.age_min, s.age_max, s.format, s.meeting_place, s.product_id, pr.name AS product
      FROM lesson_sessions s JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id WHERE s.tenant_id = ? AND s.id = ?`, [tenantId, c.session_id]);
    if (c.makeup_session_id) current = await one(db, 'SELECT s.id, s.starts_at, s.ends_at, s.status, s.meeting_place, pr.name AS product FROM lesson_sessions s JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id WHERE s.tenant_id = ? AND s.id = ?', [tenantId, c.makeup_session_id]);
  } else {
    meeting = await one(db, `SELECT s.id, s.starts_at, s.ends_at, s.group_id, s.program_id, pr.name AS program, pr.meeting_place FROM program_sessions s JOIN programs pr ON pr.tenant_id = s.tenant_id AND pr.id = s.program_id WHERE s.tenant_id = ? AND s.id = ?`, [tenantId, c.meeting_id]);
    if (c.makeup_meeting_id) current = await one(db, 'SELECT id, starts_at, ends_at, status FROM program_sessions WHERE tenant_id = ? AND id = ?', [tenantId, c.makeup_meeting_id]);
  }
  return { person, call, lesson, meeting, current };
}

/** Lessons a student could take instead: on the makeup day if the call named one, else the next 14 days; same discipline, fits level and age, spots left, no clash. */
async function makeupLessons(db, tenantId, c, ctx, tz) {
  if (!ctx.lesson) return [];
  const today = todayIn(tz);
  const now = `${today} ${nowIn(tz).slice(11)}`;
  const from = ctx.call.makeup_date && ctx.call.makeup_date >= today ? ctx.call.makeup_date : today;
  const to = ctx.call.makeup_date && ctx.call.makeup_date >= today ? ctx.call.makeup_date : addDays(today, 14);
  const list = await rows(db, `SELECT s.id, s.starts_at, s.ends_at, s.discipline, s.level_min, s.level_max, s.age_min, s.age_max, s.capacity, s.meeting_place, s.format, pr.name AS product,
      (SELECT COUNT(*) FROM lesson_bookings x WHERE x.tenant_id = s.tenant_id AND x.session_id = s.id AND x.status IN ('booked','attended')) AS booked
    FROM lesson_sessions s JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
    WHERE s.tenant_id = ? AND s.status = 'scheduled' AND s.discipline = ? AND s.format = ? AND s.starts_at > ? AND DATE(s.starts_at) BETWEEN ? AND ? AND s.id <> ?
    ORDER BY s.starts_at LIMIT 60`, [tenantId, ctx.lesson.discipline, ctx.lesson.format, now, from, to, c.makeup_session_id || 0]);
  const level = levels.personLevel(ctx.person, ctx.lesson.discipline);
  const out = [];
  for (const s of list) {
    if (Number(s.booked) >= Number(s.capacity)) continue;
    if (level && !levels.fits(level, s.level_min, s.level_max)) continue;
    const age = ageOn(ctx.person.date_of_birth, String(s.starts_at).slice(0, 10));
    if (age !== null && ((s.age_min && age < s.age_min) || (s.age_max && age > s.age_max))) continue;
    if (await studentClash(db, tenantId, c.person_id, s.starts_at, s.ends_at, { ignoreSessionId: c.makeup_session_id || 0 })) continue;
    out.push({ id: s.id, starts_at: s.starts_at, ends_at: s.ends_at, product: s.product, meeting_place: s.meeting_place, level_words: levels.range(s.level_min, s.level_max), spots_left: Number(s.capacity) - Number(s.booked) });
    if (out.length >= 20) break;
  }
  return out;
}

/** Program makeup dates a family can pick: the group's makeup weeks still to come (in reserve or already in use). */
async function makeupMeetings(db, tenantId, ctx, tz) {
  if (!ctx.meeting || !ctx.meeting.group_id) return [];
  const today = todayIn(tz);
  return (await rows(db, "SELECT id, starts_at, ends_at, status, kind FROM program_sessions WHERE tenant_id = ? AND group_id = ? AND kind <> 'regular' AND status <> 'cancelled' AND DATE(starts_at) >= ? ORDER BY starts_at LIMIT 10",
    [tenantId, ctx.meeting.group_id, today])).map((m) => ({ id: m.id, starts_at: m.starts_at, ends_at: m.ends_at }));
}

/** Everything the family's page shows. */
async function familyView(tenantId, token) {
  const c = await choiceByToken(pool, tenantId, token);
  return c ? viewOf(tenantId, c) : null;
}

/** The same, for the desk, by the choice's id. */
async function familyViewById(tenantId, id) {
  const c = await one(pool, 'SELECT * FROM weather_choices WHERE tenant_id = ? AND id = ?', [tenantId, id]);
  if (!c) throw notFound('Choice');
  return viewOf(tenantId, c);
}

async function viewOf(tenantId, c) {
  const t = await one(pool, 'SELECT id, name, slug, phone, timezone FROM tenants WHERE id = ?', [tenantId]);
  const ctx = await choiceContext(pool, tenantId, c);
  const credit = c.kind === 'program' ? await creditProduct(pool, tenantId) : null;
  const final = ['credit', 'refund'].includes(c.choice);
  const makeupStarted = ctx.current && String(ctx.current.starts_at) <= nowIn(t.timezone);
  const brand = await one(pool, 'SELECT color, logo FROM shop_brand WHERE tenant_id = ?', [tenantId]).catch(() => null);
  const refundHow = c.on_package ? 'package' : !c.value_cents ? 'none' : c.refund_order_id && await one(pool, "SELECT id FROM order_payments WHERE tenant_id = ? AND order_id = ? AND processor = 'stripe' AND reference LIKE 'pi\\_%' LIMIT 1", [tenantId, c.refund_order_id]) ? 'card' : 'desk';
  const out = {
    mountain: t.name, phone: t.phone, brand: brand || null,
    student: ctx.person ? ctx.person.first_name : '',
    kind: c.kind, action: ctx.call.action, reason: ctx.call.reason, date: ctx.call.on_date,
    what: c.kind === 'lesson' ? { name: ctx.lesson.product, starts_at: ctx.lesson.starts_at, ends_at: ctx.lesson.ends_at, meeting_place: ctx.lesson.meeting_place, level_words: levels.range(ctx.lesson.level_min, ctx.lesson.level_max) }
      : { name: ctx.meeting.program, starts_at: ctx.meeting.starts_at, ends_at: ctx.meeting.ends_at, meeting_place: ctx.meeting.meeting_place },
    choice: c.choice, chosen_via: c.chosen_via, chosen_at: c.chosen_at, final: final || Boolean(makeupStarted),
    current: ctx.current && ctx.current.status !== 'cancelled' && c.choice === 'makeup' ? { starts_at: ctx.current.starts_at, ends_at: ctx.current.ends_at, name: ctx.current.product || ctx.meeting?.program, meeting_place: ctx.current.meeting_place || ctx.meeting?.meeting_place || null } : null,
    expires_at: c.expires_at,
    refund: { cents: c.on_package ? 0 : Number(c.value_cents), how: refundHow, amount_cents: c.refund_cents ? Number(c.refund_cents) : null, refund_how: c.refund_how },
    credit_ok: c.kind === 'lesson' ? true : Boolean(credit),
    credit_words: c.on_package ? 'The lesson goes back on your lesson package.' : c.kind === 'lesson' ? `A credit for one ${ctx.lesson.product} lesson, to use any day this season, at the ski school desk or online.` : credit ? `A credit for one ${credit.name}, to use any day this season, at the ski school desk or online.` : null,
    refund_ok: !c.on_package && Number(c.value_cents) > 0,
    makeups: final ? [] : c.kind === 'lesson' ? await makeupLessons(pool, tenantId, c, ctx, t.timezone) : await makeupMeetings(pool, tenantId, ctx, t.timezone),
    credits: await creditsFor(pool, tenantId, c.person_id),
  };
  if (c.choice === 'credit') out.credit_lessons = await creditLessons(pool, tenantId, c, ctx, t.timezone);
  return out;
}

/** Lessons a credit can be used on now (online), for a student holding a weather credit. */
async function creditLessons(db, tenantId, c, ctx, tz) {
  const fake = { ...c, makeup_session_id: 0 };
  const lessonCtx = ctx.lesson ? ctx : { ...ctx, lesson: { discipline: 'ski', format: 'group' }, call: { ...ctx.call, makeup_date: null } };
  return makeupLessons(db, tenantId, fake, { ...lessonCtx, call: { ...lessonCtx.call, makeup_date: null } }, tz);
}

/** The makeup bank: a student's weather credits still to use. Exposed for the family lesson page (PARENTS). */
async function creditsFor(db, tenantId, personId) {
  return (await rows(db, `SELECT c.id, c.total, c.used, c.expires_on, c.note, pr.name AS product FROM lesson_credits c JOIN products pr ON pr.tenant_id = c.tenant_id AND pr.id = c.product_id
    WHERE c.tenant_id = ? AND c.person_id = ? AND c.source = 'weather' AND c.status = 'active' AND c.used < c.total ORDER BY c.id`, [tenantId, personId]))
    .map((x) => ({ id: x.id, product: x.product, left: Number(x.total) - Number(x.used), expires_on: x.expires_on, note: x.note }));
}

/** Puts a student into a lesson: the shared booking checks (status, capacity under the row lock, waiver, clash). */
async function checkSeat(conn, tenantId, sessionId, personId, ignoreSessionId) {
  const s = await one(conn, 'SELECT * FROM lesson_sessions WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, sessionId]);
  if (!s || s.status !== 'scheduled') throw conflict('That lesson is not open any more. Pick another.');
  const { n } = await one(conn, "SELECT COUNT(*) AS n FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND status IN ('booked','attended')", [tenantId, s.id]);
  if (Number(n) >= Number(s.capacity)) throw conflict('That lesson just filled up. Pick another.');
  const clash = await studentClash(conn, tenantId, personId, s.starts_at, s.ends_at, { ignoreSessionId });
  if (clash) throw conflict(clashWords(clash));
  if (!(await one(conn, ON_FILE, [tenantId, personId, seasonFor(String(s.starts_at).slice(0, 10))]))) throw conflict('That lesson is in a season with no waiver on file yet. Please call us to book it.');
  return s;
}

/**
 * Records a choice. what: { choice: 'makeup'|'credit'|'refund', session_id?, meeting_id? }. via: 'family' or 'staff'.
 * A credit or a refund is final; a makeup can be changed until the makeup lesson starts. Returns { refund_id?, booking_id? }.
 */
async function choose(conn, tenantId, c, what, via, userId = null) {
  const t = await one(conn, 'SELECT id, timezone FROM tenants WHERE id = ?', [tenantId]);
  if (['credit', 'refund'].includes(c.choice)) throw conflict(`This is already settled as a ${c.choice}.`);
  const ctx = await choiceContext(conn, tenantId, c);
  if (ctx.current && c.choice === 'makeup' && String(ctx.current.starts_at) <= nowIn(t.timezone)) throw conflict('The makeup has already started, so this can no longer change.');
  const req = { auth: { tenantId, userId }, ip: null };
  const out = {};
  // Leaving a makeup lesson: the booking row comes back out of it (a program makeup needs nothing undone).
  const leaveMakeup = async () => {
    if (c.kind === 'lesson' && c.makeup_session_id) await conn.query("UPDATE lesson_bookings SET status = 'cancelled' WHERE tenant_id = ? AND id = ?", [tenantId, c.booking_id]);
  };
  if (what.choice === 'makeup') {
    if (c.kind === 'lesson') {
      if (!what.session_id) throw bad('Pick a lesson');
      const ok = (await makeupLessons(conn, tenantId, c, ctx, t.timezone)).some((x) => x.id === what.session_id);
      if (!ok) throw conflict('That lesson is not one of the choices any more. Pick another.');
      await checkSeat(conn, tenantId, what.session_id, c.person_id, c.makeup_session_id || 0);
      const dupe = await one(conn, 'SELECT id FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND person_id = ? AND id <> ?', [tenantId, what.session_id, c.person_id, c.booking_id]);
      if (dupe) throw conflict('This student already has a place in that lesson.');
      // Same booking row: the safety details, the family link and the consents stay with it; a package lesson moves with it.
      await conn.query("UPDATE lesson_bookings SET session_id = ?, status = 'booked', moved_from_session_id = ?, moved_at = NOW(), checked_in_at = NULL, checked_in_by = NULL, checked_in_via = NULL WHERE tenant_id = ? AND id = ?",
        [what.session_id, c.session_id, tenantId, c.booking_id]);
      await conn.query("UPDATE weather_choices SET choice = 'makeup', makeup_session_id = ?, chosen_at = NOW(), chosen_via = ? WHERE tenant_id = ? AND id = ?", [what.session_id, via, tenantId, c.id]);
      out.booking_id = c.booking_id;
    } else {
      const ok = (await makeupMeetings(conn, tenantId, ctx, t.timezone)).some((x) => x.id === what.meeting_id);
      if (!ok) throw conflict('That date is not one of the choices any more.');
      // A makeup week held in reserve opens for the whole group when the first family picks it.
      await conn.query("UPDATE program_sessions SET status = 'scheduled' WHERE tenant_id = ? AND id = ? AND status = 'standby'", [tenantId, what.meeting_id]);
      await conn.query("UPDATE weather_choices SET choice = 'makeup', makeup_meeting_id = ?, chosen_at = NOW(), chosen_via = ? WHERE tenant_id = ? AND id = ?", [what.meeting_id, via, tenantId, c.id]);
    }
  } else if (what.choice === 'credit') {
    await leaveMakeup();
    let creditId = null;
    if (c.kind === 'lesson' && c.on_package) {
      const b = await one(conn, 'SELECT credit_id FROM lesson_bookings WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, c.booking_id]);
      if (b && b.credit_id) {
        await conn.query('UPDATE lesson_credits SET used = GREATEST(used - 1, 0) WHERE tenant_id = ? AND id = ?', [tenantId, b.credit_id]);
        await conn.query('UPDATE lesson_bookings SET credit_id = NULL WHERE tenant_id = ? AND id = ?', [tenantId, c.booking_id]);
        creditId = b.credit_id;
      }
    } else {
      const product = c.kind === 'lesson' ? { id: ctx.lesson.product_id } : await creditProduct(conn, tenantId);
      if (!product) throw conflict('A lesson credit is not available here. Please choose another option.');
      const note = `Weather: ${c.kind === 'lesson' ? ctx.lesson.product : ctx.meeting.program} on ${String(ctx.call.on_date).slice(0, 10)}`;
      const [r] = await conn.query("INSERT INTO lesson_credits (tenant_id, person_id, product_id, total, used, source, note) VALUES (?, ?, ?, 1, 0, 'weather', ?)", [tenantId, c.person_id, product.id, note.slice(0, 200)]);
      creditId = r.insertId;
    }
    await conn.query("UPDATE weather_choices SET choice = 'credit', credit_id = ?, chosen_at = NOW(), chosen_via = ? WHERE tenant_id = ? AND id = ?", [creditId, via, tenantId, c.id]);
    out.credit_id = creditId;
  } else if (what.choice === 'refund') {
    if (c.on_package) throw conflict('A package lesson goes back on the package. Choose the credit.');
    await leaveMakeup();
    let r = { how: 'none', cents: 0 };
    if (Number(c.value_cents) > 0) {
      if (c.refund_order_id) r = await PP.refundPart(conn, tenantId, { orderId: c.refund_order_id, cents: Number(c.value_cents), reason: 'weather', note: `Weather refund, ${String(ctx.call.on_date).slice(0, 10)}`, userId });
      else r = { how: 'desk', cents: Number(c.value_cents) };
    }
    if (c.kind === 'program' && r.cents) await conn.query('UPDATE program_enrollments SET refund_cents = refund_cents + ? WHERE tenant_id = ? AND id = ?', [r.cents, tenantId, c.enrollment_id]);
    await conn.query("UPDATE weather_choices SET choice = 'refund', refund_how = ?, refund_cents = ?, refund_id = ?, chosen_at = NOW(), chosen_via = ? WHERE tenant_id = ? AND id = ?", [r.how === 'card' ? 'card' : r.how === 'desk' ? 'desk' : 'none', r.cents || 0, r.refund_id || null, via, tenantId, c.id]);
    out.refund_id = r.refund_id || null; out.refund_how = r.how; out.refund_cents = r.cents;
  } else throw bad('Choose a makeup, a credit or a refund');
  await audit(conn, req, 'weather_choice', 'weather_choices', c.id, { choice: what.choice, via, session_id: what.session_id || null, meeting_id: what.meeting_id || null });
  return out;
}

/** Uses a weather credit on a lesson online (from the family's weather page). Returns the new booking id. */
async function useCredit(conn, tenantId, c, sessionId) {
  if (c.choice !== 'credit' || !c.credit_id) throw conflict('There is no credit to use yet');
  const t = await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const ctx = await choiceContext(conn, tenantId, c);
  const ok = (await creditLessons(conn, tenantId, c, ctx, t.timezone)).some((x) => x.id === sessionId);
  if (!ok) throw conflict('That lesson is not one of the choices. Pick another.');
  const credit = await one(conn, "SELECT * FROM lesson_credits WHERE tenant_id = ? AND id = ? AND person_id = ? FOR UPDATE", [tenantId, c.credit_id, c.person_id]);
  if (!credit || credit.status !== 'active' || credit.used >= credit.total) throw conflict('This credit has already been used');
  await checkSeat(conn, tenantId, sessionId, c.person_id, 0);
  const prev = c.booking_id ? await one(conn, 'SELECT * FROM lesson_bookings WHERE tenant_id = ? AND id = ?', [tenantId, c.booking_id]) : null;
  const keep = prev ? [prev.allergies, prev.medical, prev.pickup, prev.contact_name, prev.contact_phone, prev.contact_email, prev.text_ok, prev.photo_ok] : [null, null, null, null, c.phone, c.email, 0, 0];
  const [r] = await conn.query(`INSERT INTO lesson_bookings (tenant_id, session_id, person_id, credit_id, allergies, medical, pickup, contact_name, contact_phone, contact_email, text_ok, photo_ok)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status = IF(status = 'cancelled', 'booked', status), credit_id = VALUES(credit_id), id = LAST_INSERT_ID(id)`,
  [tenantId, sessionId, c.person_id, credit.id, ...keep]);
  await conn.query('UPDATE lesson_credits SET used = used + 1 WHERE tenant_id = ? AND id = ?', [tenantId, credit.id]);
  await audit(conn, { auth: { tenantId, userId: null }, ip: null }, 'book', 'lesson_sessions', sessionId, { person_id: c.person_id, credit_id: credit.id, via: 'weather_credit' });
  return r.insertId;
}

/** Choices nobody made in time become a credit (or, for an unpaid lesson, simply stay canceled). For daily(). */
async function expireOpen() {
  const due = await rows(pool, "SELECT id, tenant_id FROM weather_choices WHERE choice = 'open' AND expires_at < UTC_TIMESTAMP() ORDER BY id LIMIT 500");
  let credits = 0; let closed = 0;
  for (const d of due) {
    try {
      await tx(async (conn) => {
        const c = await one(conn, "SELECT * FROM weather_choices WHERE tenant_id = ? AND id = ? AND choice = 'open' FOR UPDATE", [d.tenant_id, d.id]);
        if (!c) return;
        if (!c.on_package && !Number(c.value_cents) && c.kind === 'lesson') {
          await conn.query("UPDATE weather_choices SET choice = 'refund', refund_how = 'none', chosen_at = NOW(), chosen_via = 'auto' WHERE tenant_id = ? AND id = ?", [d.tenant_id, c.id]);
          closed += 1; return;
        }
        await choose(conn, d.tenant_id, c, { choice: 'credit' }, 'auto');
        credits += 1;
      });
    } catch (err) { console.error(JSON.stringify({ severity: 'ERROR', job: 'weather_expire', choice: d.id, message: err.message })); }
  }
  return { credits, closed };
}

/** The calls made, newest first, with how families answered. For the Weather tab. */
async function history(tenantId) {
  const calls = await rows(pool, 'SELECT * FROM weather_calls WHERE tenant_id = ? ORDER BY id DESC LIMIT 20', [tenantId]);
  for (const c of calls) {
    const counts = await rows(pool, 'SELECT choice, COUNT(*) AS n FROM weather_choices WHERE tenant_id = ? AND call_id = ? GROUP BY choice', [tenantId, c.id]);
    c.choices = Object.fromEntries(counts.map((x) => [x.choice, Number(x.n)]));
  }
  return calls;
}

/** Every family's answer on one call, for the director (with the desk refunds still to give). */
async function choicesOf(tenantId, callId) {
  return rows(pool, `SELECT w.id, w.kind, w.choice, w.chosen_via, w.chosen_at, w.value_cents, w.on_package, w.refund_how, w.refund_cents, w.expires_at, w.email, w.phone,
      p.first_name, p.last_name, COALESCE(ls.starts_at, ps.starts_at) AS starts_at, COALESCE(pr.name, pg.name) AS what,
      ms.starts_at AS makeup_at, mm.starts_at AS makeup_meeting_at
    FROM weather_choices w JOIN people p ON p.tenant_id = w.tenant_id AND p.id = w.person_id
    LEFT JOIN lesson_sessions ls ON ls.tenant_id = w.tenant_id AND ls.id = w.session_id LEFT JOIN products pr ON pr.tenant_id = ls.tenant_id AND pr.id = ls.product_id
    LEFT JOIN program_sessions ps ON ps.tenant_id = w.tenant_id AND ps.id = w.meeting_id LEFT JOIN programs pg ON pg.tenant_id = ps.tenant_id AND pg.id = ps.program_id
    LEFT JOIN lesson_sessions ms ON ms.tenant_id = w.tenant_id AND ms.id = w.makeup_session_id
    LEFT JOIN program_sessions mm ON mm.tenant_id = w.tenant_id AND mm.id = w.makeup_meeting_id
    WHERE w.tenant_id = ? AND w.call_id = ? ORDER BY starts_at, p.last_name`, [tenantId, callId]);
}

module.exports = { preview, words, run, apply, sendAll, choiceByToken, familyView, familyViewById, choose, useCredit, creditsFor, expireOpen, history, choicesOf, plusMinutes, settingsOf, creditProduct, linkFor, scopeSchemaKeys, fakeReq, cardrefund };
