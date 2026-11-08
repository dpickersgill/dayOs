'use strict';
// Ski school safety (feat/school-safety): the rules shared by booking, the lineup, the board and the pickup.
//   - ages: a student outside a lesson's age range is warned at the desk (a manager can book anyway with a reason, audited)
//     and refused online
//   - ratios by age band: each class takes at most the size of its youngest student's band (Settings, Lessons safety);
//     an adaptive lesson takes the adaptive ratio, and extra staff from the intake add to the staff it needs
//   - release: a child 12 or under (or of unknown age in a kids lesson) is released at pickup to an adult on the list
const { rows, one } = require('../db');
const { conflict, forbidden } = require('./errors');
const { audit } = require('./audit');
const S = require('./schoolsettings');
const SA = require('./schoolaccess');
const { z } = require('./util');

const RELEASE_AGE = 12;

/** Whole years old on a day, or null. */
function ageOn(dob, day) {
  if (!dob) return null;
  const b = String(dob instanceof Date ? dob.toISOString() : dob).slice(0, 10);
  const d = String(day).slice(0, 10);
  let a = Number(d.slice(0, 4)) - Number(b.slice(0, 4));
  if (d.slice(5, 10) < b.slice(5, 10)) a -= 1;
  return a;
}

/** A kids lesson: the age group says so, or every age it takes is 12 or under. */
const isKidsLesson = (s) => Boolean(s) && (s.age_group === 'kids' || (s.age_max != null && Number(s.age_max) <= RELEASE_AGE));

/** Must this student be released to an adult at pickup? Children 12 and under; unknown age counts in a kids lesson. */
const needsRelease = (age, session) => (age != null ? age <= RELEASE_AGE : isKidsLesson(session));

/** "Ages 5 to 12", "Ages 18 and up" */
const agesWords = (min, max) => (min != null && max != null ? `ages ${min} to ${max}` : min != null ? `ages ${min} and up` : max != null ? `ages up to ${max}` : 'all ages');

/** Is this age inside the lesson's range? */
const ageFits = (s, age) => age == null || ((s.age_min == null || age >= Number(s.age_min)) && (s.age_max == null || age <= Number(s.age_max)));

/** The band an age falls in, or null. */
function bandFor(age, bands) {
  if (age == null) return null;
  return bands.find((b) => (b.age_min == null || age >= b.age_min) && (b.age_max == null || age <= b.age_max)) || null;
}

/** The band for a lesson with no known ages: the one its youngest age falls in. */
const lessonBand = (s, bands) => bandFor(s.age_min != null ? Number(s.age_min) : s.age_max != null ? Number(s.age_max) : null, bands);

/** Does this lesson take the band ratio? Group and semi-private classes do; privates and pools (split later) do not. */
const ratioApplies = (s) => s && s.format !== 'private' && s.kind !== 'pool';

/**
 * The most students one instructor may have in this class, and why: { size, label, adaptive }. ages: the ages of the
 * students in it (null for unknown). The youngest band wins. Null when no band applies.
 */
function classLimit(s, ages, settings) {
  if (s.discipline === 'adaptive') return { size: Number(settings.ratio_adaptive) || 1, label: 'Adaptive', adaptive: true };
  const bands = settings.ratio_bands;
  let best = null;
  for (const a of ages) {
    const b = bandFor(a, bands);
    if (b && (!best || b.size < best.size)) best = b;
  }
  if (!best) best = lessonBand(s, bands);
  return best ? { size: Number(best.size), label: best.label, adaptive: false } : null;
}

/** Staff an adaptive class needs: one per adaptive ratio, plus the extra staff each intake asks for. */
const adaptiveStaff = (n, extra, settings) => Math.max(Math.ceil(n / (Number(settings.ratio_adaptive) || 1)), n ? 1 : 0) + Number(extra || 0);

/** The ages of the students booked in a lesson (booked or attended). */
async function bookedAges(db, tenantId, s) {
  const list = await rows(db, `SELECT p.date_of_birth FROM lesson_bookings b JOIN people p ON p.tenant_id = b.tenant_id AND p.id = b.person_id
    WHERE b.tenant_id = ? AND b.session_id = ? AND b.status IN ('booked','attended')`, [tenantId, s.id]);
  const day = String(s.starts_at).slice(0, 10);
  return list.map((r) => ageOn(r.date_of_birth, day));
}

/**
 * What is wrong with putting these students (ages) in this lesson: [{ kind: 'age'|'ratio', message }]. The ratio counts
 * the students already booked plus these. extraHeld: seats held by online requests not booked yet. extraAges: students
 * on their way into the class but not booked yet (earlier lines of the same basket): counted in the ratio, not age-checked.
 */
async function problemsFor(db, tenantId, s, newcomers, { settings = null, extraHeld = 0, extraAges = [] } = {}) {
  const set = settings || (await S.get(db, tenantId));
  const out = [];
  for (const n of newcomers) {
    if (!ageFits(s, n.age)) out.push({ kind: 'age', message: `${n.first_name || 'This student'} is ${n.age}, and this lesson is for ${agesWords(s.age_min, s.age_max)}.` });
  }
  if (ratioApplies(s)) {
    const ages = [...(await bookedAges(db, tenantId, s)), ...extraAges, ...newcomers.map((n) => n.age)];
    const lim = classLimit(s, ages, set);
    const count = ages.length + Number(extraHeld || 0);
    if (lim && count > lim.size) {
      out.push({ kind: 'ratio', message: lim.adaptive ? `An adaptive lesson takes ${lim.size} student${lim.size === 1 ? '' : 's'} per instructor. This one would have ${count}.`
        : `${lim.label} classes take ${lim.size} students per instructor. This one would have ${count}.` });
    }
  }
  return out;
}

/** May this person book past an age or ratio warning? Owners, managers and school supervisors and directors. */
const mayOverride = (req) => SA.atLeast(req, 'supervisor');

/**
 * The desk's check before booking a student (roster, Sell): warns about age and ratio. Without a reason it refuses
 * with { needs_override, problems } so the screen can ask a manager; with a reason from a manager it books anyway and
 * the reason goes on the audit log and the booking. Returns the reason used, or null.
 */
async function deskCheck(conn, req, s, personId, overrideReason, { earlier = [] } = {}) {
  const p = await one(conn, 'SELECT first_name, date_of_birth FROM people WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, personId]);
  const age = p ? ageOn(p.date_of_birth, String(s.starts_at).slice(0, 10)) : null;
  // already in this lesson: nothing changes
  const already = await one(conn, "SELECT id FROM lesson_bookings WHERE tenant_id = ? AND session_id = ? AND person_id = ? AND status IN ('booked','attended')", [req.auth.tenantId, s.id, personId]);
  if (already) return null;
  // earlier: students for this class already checked in the same basket, not booked yet; they count in the ratio
  const problems = await problemsFor(conn, req.auth.tenantId, s, [{ first_name: p && p.first_name, age }], { extraAges: earlier.map((x) => x.age) });
  if (!problems.length) return null;
  const words = problems.map((x) => x.message).join(' ');
  if (!overrideReason) {
    throw conflict(`${words} ${mayOverride(req) ? 'Give a reason to book anyway.' : 'A manager can book anyway with a reason.'}`, { needs_override: true, problems, person_id: personId });
  }
  if (!mayOverride(req)) throw forbidden(`${words} Only a manager or school supervisor can book anyway.`);
  await audit(conn, req, problems.some((x) => x.kind === 'age') ? 'age_override' : 'ratio_override', 'lesson_sessions', s.id, { person_id: personId, age, problems: problems.map((x) => x.kind), reason: overrideReason });
  return overrideReason;
}

/** Online booking: never past an age range or a ratio. students: [{ first_name, date_of_birth }]. Throws 409. */
async function onlineCheck(conn, tenantId, s, students, { held = 0 } = {}) {
  const day = String(s.starts_at).slice(0, 10);
  const problems = await problemsFor(conn, tenantId, s, students.map((x) => ({ first_name: x.first_name, age: ageOn(x.date_of_birth, day) })), { extraHeld: held });
  if (problems.length) throw conflict(`${problems.map((x) => x.message).join(' ')} Pick another lesson.`, { problems });
}

/**
 * The places an online guest can still take in a class, after the band ratio: min(capacity, band size) minus booked.
 * Uses the lesson's own age range for the band (the guest's age is checked when they ask).
 */
function bandCap(s, settings) {
  if (!ratioApplies(s)) return Number(s.capacity);
  const lim = classLimit(s, [], settings);
  return lim ? Math.min(Number(s.capacity), lim.size) : Number(s.capacity);
}

/** The pickup window for an age, in minutes after the lesson ends (0 when no window fits). */
function pickupMinutes(age, settings) {
  const w = bandFor(age == null ? 6 : age, settings.pickup_windows || []);
  return w ? Number(w.minutes) || 0 : 0;
}

// ---------------------------------------------------------------- the pickup list and the adaptive intake
const PHOTO_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
/** One adult who may pick a child up. photo: a small JPEG data URL (the screen shrinks it), only with photo_consent. */
const pickupAdult = z.object({
  id: z.number().int().positive().optional(), // an adult already on the list (keeps their photo when none is sent)
  name: z.string().trim().min(2).max(150),
  relationship: z.string().trim().max(60).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  photo: z.string().regex(PHOTO_RE, 'A JPEG photo').max(120000).nullable().optional(),
});
const pickupList = z.array(pickupAdult).max(6);
/** The parent's consent to keep the photos of the adults on the list (recorded with the time). */
const pickupShape = { pickup_adults: pickupList.optional(), pickup_photo_consent: z.boolean().optional() };

const EQUIPMENT = ['bi_ski', 'mono_ski', 'outriggers', 'slider', 'tethers', 'sit_ski', 'other'];
const adaptiveIntake = z.object({
  needs: z.string().trim().max(1000).nullable().optional(),
  equipment: z.array(z.enum(EQUIPMENT)).max(EQUIPMENT.length).optional(),
  extra_staff: z.number().int().min(0).max(4).optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

/**
 * Replaces a booking's pickup list. Photos are kept only with the parent's consent; an adult sent back with its id and no
 * photo keeps the photo on file. The plain-words pickup column follows ("Kate Novak (Mom), Joe Novak (Grandpa)").
 */
async function savePickup(conn, tenantId, bookingId, list, { consent = false, via = 'desk' } = {}) {
  if (!Array.isArray(list)) return;
  const before = await rows(conn, 'SELECT id, photo, photo_consent_at FROM lesson_pickup_adults WHERE tenant_id = ? AND booking_id = ?', [tenantId, bookingId]);
  if (list.some((a) => a.photo) && !consent) throw conflict('Tick the box that the family agrees to keep the photos of the adults on the pickup list, or leave the photos out.');
  await conn.query('DELETE FROM lesson_pickup_adults WHERE tenant_id = ? AND booking_id = ?', [tenantId, bookingId]);
  for (const a of list) {
    const old = a.id ? before.find((x) => Number(x.id) === Number(a.id)) : null;
    const photo = a.photo || (old && old.photo) || null;
    const consentAt = a.photo ? new Date() : old ? old.photo_consent_at : null;
    await conn.query('INSERT INTO lesson_pickup_adults (tenant_id, booking_id, name, relationship, phone, photo, photo_consent_at, added_via) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [tenantId, bookingId, a.name, a.relationship || null, a.phone || null, photo, photo ? consentAt : null, via]);
  }
  const words = list.map((a) => (a.relationship ? `${a.name} (${a.relationship})` : a.name)).join(', ').slice(0, 300) || null;
  await conn.query('UPDATE lesson_bookings SET pickup = ? WHERE tenant_id = ? AND id = ?', [words, tenantId, bookingId]);
}

/** The pickup list for a booking, without photos (has_photo says whether one is on file). */
const pickupFor = (db, tenantId, bookingId) => rows(db, 'SELECT id, name, relationship, phone, photo IS NOT NULL AS has_photo FROM lesson_pickup_adults WHERE tenant_id = ? AND booking_id = ? ORDER BY id', [tenantId, bookingId])
  .then((list) => list.map((a) => ({ ...a, has_photo: Boolean(Number(a.has_photo)) })));

/** Saves the adaptive intake for a booking. */
async function saveAdaptive(conn, tenantId, bookingId, intake, userId = null) {
  if (!intake) return;
  await conn.query(`INSERT INTO lesson_adaptive_intake (tenant_id, booking_id, needs, equipment, extra_staff, notes, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE needs = VALUES(needs), equipment = VALUES(equipment), extra_staff = VALUES(extra_staff), notes = VALUES(notes), updated_by = VALUES(updated_by)`,
  [tenantId, bookingId, intake.needs || null, (intake.equipment || []).join(',') || null, Number(intake.extra_staff || 0), intake.notes || null, userId]);
}
const intakeOut = (r) => (r ? { needs: r.needs, equipment: String(r.equipment || '').split(',').filter(Boolean), extra_staff: Number(r.extra_staff || 0), notes: r.notes, updated_at: r.updated_at } : null);

module.exports = { pickupAdult, pickupList, pickupShape, EQUIPMENT, adaptiveIntake, savePickup, pickupFor, saveAdaptive, intakeOut, RELEASE_AGE, ageOn, isKidsLesson, needsRelease, agesWords, ageFits, bandFor, classLimit, adaptiveStaff, ratioApplies, bookedAges, problemsFor, mayOverride, deskCheck, onlineCheck, bandCap, pickupMinutes };
