'use strict';

// Waivers. Each mountain has one waiver wording (tenants.waiver_text). A person "has a waiver" for a season when they have a
// row in `waivers` for it that has not been voided and was added after the mountain last asked everyone to sign again.
// Every check in the app reads that through VALID, so a void or a "sign again" takes effect everywhere at once.
//
// A signing on a screen (the public page, or the counter) is one waiver_signings row: the drawn signature, the typed name, the
// device, and the fingerprint of the wording, which is kept word for word in waiver_texts. Each person it covers gets a row in
// `waivers` pointing back to it.
const crypto = require('crypto');
const { one, rows } = require('../db');
const { bad, conflict } = require('./errors');
const { resolvePerson, ageOn } = require('./customers');
const { MINOR_AGE, mayActAsGuardian, addLink } = require('./family');
const { seasonFor, todayIn } = require('./util');
const mailer = require('./mailer');
const { esc } = require('./format');

const MAX_SIGNATURE_CHARS = 90000;
const MAX_CHILDREN = 10;
const MAX_COPIES_PER_HOUR = 3; // signed copies emailed to one address in an hour

/** The season after the given one ('2025-26' -> '2026-27'). */
const nextSeason = (season) => seasonFor(`${Number(season.slice(0, 4)) + 1}-08-01`);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (dataUrl) => {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return false;
  return Buffer.from(m[1].slice(0, 16), 'base64').subarray(0, 8).equals(PNG_MAGIC);
};

/** SQL that is true for a waiver row that still counts. `w` is the alias of the waivers table in the query. */
// "Ask everyone to sign again" records the newest waiver id at that moment; only waivers added after it count.
const VALID = (w = 'w') => `${w}.voided_at IS NULL AND ${w}.id > COALESCE((SELECT tv.waiver_resign_id FROM tenants tv WHERE tv.id = ${w}.tenant_id), 0)`;

/** Query text: does the person (2nd parameter) have a waiver that counts for the season (3rd)? Parameters: tenant, person, season. */
const ON_FILE = `SELECT w.id, w.signed_at FROM waivers w WHERE w.tenant_id = ? AND w.person_id = ? AND w.season = ? AND ${VALID('w')} ORDER BY w.signed_at DESC LIMIT 1`;

const shaOf = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

/** Keep a wording word for word, once. */
async function archive(conn, tenantId, text, userId = null) {
  if (!text) return null;
  const sha = shaOf(text);
  await conn.query('INSERT IGNORE INTO waiver_texts (tenant_id, sha, body, created_by) VALUES (?, ?, ?, ?)', [tenantId, sha, text, userId]);
  return sha;
}

const clean = (s) => String(s || '').trim().replace(/\s+/g, ' ');
const sameName = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase();

/**
 * Records one signing. `input`:
 *   sha        fingerprint of the wording the guest read (must be today's wording)
 *   signer     { person_id?, first_name, last_name, email?, phone?, date_of_birth }  must be 18 or over
 *   self       true when the signer is also skiing or riding
 *   children   [{ person_id?, first_name, last_name, date_of_birth }]  each under 18
 *   typed_name the signer's full name, typed
 *   signature  PNG data URL of the drawn signature
 * `ctx`: { source: 'online'|'counter', ip, userAgent, userId }. Returns { id, token, season, covered: [{ id, name }] }.
 */
async function sign(conn, tenant, input, ctx) {
  const counter = ctx.source === 'counter';
  // Read the wording under a lock, so a signing and a change of wording (or "ask everyone to sign again") never interleave.
  const live = await one(conn, 'SELECT waiver_text FROM tenants WHERE id = ? FOR UPDATE', [tenant.id]);
  if (!live || !live.waiver_text) throw bad('This mountain has no waiver to sign yet');
  if (input.sha !== shaOf(live.waiver_text)) throw conflict('The waiver wording has just changed. Please read it again and sign.');
  const today = todayIn(tenant.timezone);
  const current = seasonFor(today);
  const season = input.season || current;
  if (season !== current && season !== nextSeason(current)) throw bad(`A waiver can be signed for ${current} or ${nextSeason(current)}`);
  const s = input.signer || {};
  if (!clean(s.first_name) || !clean(s.last_name)) throw bad('Please enter your first and last name');

  // Only the counter (a member of staff is there and has the record open) may name an existing record. When it does, the
  // date of birth on the record is the one that counts for the age checks.
  const onFile = async (personId) => {
    if (!counter || !personId) return null;
    const r = await one(conn, 'SELECT id, first_name, last_name, date_of_birth, email FROM people WHERE tenant_id = ? AND id = ? AND anonymised_at IS NULL FOR UPDATE', [tenant.id, personId]);
    if (!r) throw bad('That customer record was not found');
    return r;
  };
  const dobOf = (rec, typed) => (rec && rec.date_of_birth ? String(rec.date_of_birth).slice(0, 10) : typed);
  const signerRec = await onFile(s.person_id);
  const signerDob = dobOf(signerRec, s.date_of_birth);
  if (!signerDob) throw bad('Please enter your date of birth');
  const signerAge = ageOn(signerDob, today);
  if (signerAge === null || signerAge < 0 || signerAge > 120) throw bad('Please check your date of birth');
  if (signerAge < MINOR_AGE) throw bad('You must be 18 or over to sign. A parent or guardian needs to sign for anyone under 18.');
  const kids = (input.children || []).filter((c) => clean(c.first_name) || clean(c.last_name));
  if (kids.length > MAX_CHILDREN) throw bad(`Please sign for at most ${MAX_CHILDREN} children at a time`);
  if (!input.self && !kids.length) throw bad('Choose who this waiver is for: yourself, your children, or both');
  const kidRecs = [];
  for (const c of kids) {
    const name = `${clean(c.first_name)} ${clean(c.last_name)}`.trim();
    if (!clean(c.first_name) || !clean(c.last_name)) throw bad('Please enter a first and last name for each child');
    const rec = await onFile(c.person_id);
    const dob = dobOf(rec, c.date_of_birth);
    if (!dob) throw bad(`Please enter a date of birth for ${name}`);
    const a = ageOn(dob, today);
    if (a === null || a < 0) throw bad(`Please check the date of birth for ${name}`);
    if (a >= MINOR_AGE) throw bad(`${name} is 18 or over and needs to sign for themselves`);
    kidRecs.push({ c, rec, dob, name });
  }
  const fullName = `${clean(s.first_name)} ${clean(s.last_name)}`;
  if (!sameName(input.typed_name, fullName)) throw bad(`Type your full name exactly as above (${fullName}) to sign`);
  const sig = String(input.signature || '');
  if (!isPng(sig)) throw bad('Please sign in the box');
  if (sig.length > MAX_SIGNATURE_CHARS) throw bad('That signature is too detailed to save. Clear it and sign again.');

  await archive(conn, tenant.id, live.waiver_text, ctx.userId || null);
  const source = counter ? 'counter' : 'online';
  const email = clean(s.email).toLowerCase() || null;
  const phone = clean(s.phone) || null;

  // Without a record named at the counter, a person is matched only on first name, last name and date of birth together,
  // never on an email address alone (a family often shares one), and a match never has its contact details changed.
  const findOrMake = async (first, last, dob, contact, note = null, forceNew = false) => {
    const hit = forceNew ? null : await one(conn, 'SELECT id, email FROM people WHERE tenant_id = ? AND first_name = ? AND last_name = ? AND date_of_birth = ? AND anonymised_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE', [tenant.id, first, last, dob]);
    if (hit) return { id: hit.id, email: hit.email, created: false };
    // An address already on someone else's record stays theirs: the new record does not get it, and no copy is sent to it.
    const taken = contact && email ? await one(conn, 'SELECT id FROM people WHERE tenant_id = ? AND email = ? LIMIT 1', [tenant.id, email]) : null;
    if (taken) contact = false;
    const [r] = await conn.query('INSERT INTO people (tenant_id, first_name, last_name, date_of_birth, email, phone, notes, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [tenant.id, first, last, dob, contact ? email : null, contact ? phone : null, note, counter ? 'window' : 'online']);
    return { id: r.insertId, email: contact ? email : null, created: true };
  };
  let signer;
  if (signerRec) {
    // At the counter, staff confirmed who this is; blanks on the record are filled, nothing is overwritten.
    await resolvePerson(conn, tenant.id, { personId: signerRec.id, details: { ...(email ? { email } : {}), ...(phone ? { phone } : {}) }, source: 'window', fillOnly: true });
    signer = { id: signerRec.id, email: signerRec.email || email, created: false };
  } else {
    signer = await findOrMake(clean(s.first_name), clean(s.last_name), signerDob, true);
  }
  const covered = [];
  if (input.self) covered.push({ id: signer.id, name: fullName, relation: 'self' });
  for (const k of kidRecs) {
    let childId = k.rec ? k.rec.id : null;
    let created = false;
    if (!childId) {
      const r = await findOrMake(clean(k.c.first_name), clean(k.c.last_name), k.dob, false);
      childId = r.id; created = r.created;
    }
    // A child already on file with other guardians is only signed for by one of them. Anyone else's signing goes on a new
    // record (marked as a possible duplicate) for staff to check, rather than onto another family's child.
    if (!(await mayActAsGuardian(conn, tenant.id, signer.id, childId, created))) {
      if (counter) throw bad(`${k.name} has another parent or guardian on file. Check with them, or add this adult to the family first.`);
      childId = (await findOrMake(clean(k.c.first_name), clean(k.c.last_name), k.dob, false, 'Added from an online waiver signed by someone who is not a guardian on file for a child with the same name and date of birth. Check before merging.', true)).id;
    }
    await addLink(conn, tenant.id, signer.id, childId, 'guardian');
    if (!covered.some((x) => x.id === childId)) covered.push({ id: childId, name: k.name, relation: 'guardian' });
  }

  // Only a hash of the link's token is kept, so a copy of the database cannot open anyone's signed copy.
  const token = crypto.randomBytes(16).toString('hex');
  const [ins] = await conn.query(
    `INSERT INTO waiver_signings (tenant_id, token_sha, season, source, signer_person_id, signer_name, signer_email, signer_phone, signer_dob, covered_names, typed_name, signature, text_sha, ip, user_agent, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenant.id, tokenSha(token), season, source, signer.id, fullName, email, phone, signerDob, JSON.stringify(covered.map((c) => ({ name: c.name, relation: c.relation }))), clean(input.typed_name), sig, input.sha,
      String(ctx.ip || '').slice(0, 45) || null, String(ctx.userAgent || '').slice(0, 300) || null, ctx.userId || null],
  );
  for (const c of covered) {
    await conn.query(
      'INSERT INTO waivers (tenant_id, person_id, season, kind, signed_by_person_id, signed_by_name, signer_relation, text_sha, signing_id, method, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [tenant.id, c.id, season, 'general', signer.id, fullName, c.relation, input.sha, ins.insertId, source === 'counter' ? 'signed_counter' : 'signed_online', ctx.userId || null],
    );
  }
  // The signed copy is only emailed where that address is known to be the signer's: typed by staff at the counter, on a record
  // this signing created, or already on the signer's record. A stranger cannot use the page to send mail to someone else.
  const emailOk = Boolean(email) && (counter || String(signer.email || '').toLowerCase() === email);
  return { id: ins.insertId, token, season, covered: covered.map(({ id, name }) => ({ id, name })), email: emailOk ? email : null };
}

/** Emails the signer a link to their signed copy. Returns the mailer's answer; never throws. */
async function emailCopy(conn, tenant, signing, base) {
  if (!signing.email) return { ok: false, error: 'No email address' };
  const recent = await one(conn, 'SELECT COUNT(*) AS n FROM waiver_signings WHERE tenant_id = ? AND signer_email = ? AND emailed_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)', [tenant.id, signing.email]);
  if (Number(recent.n) >= MAX_COPIES_PER_HOUR) return { ok: false, error: 'Several copies were sent to this address in the last hour' };
  const link = `${base}/waiver/${encodeURIComponent(tenant.slug)}?copy=${signing.token}`;
  // Names typed by the guest stay out of the email; the signed copy behind the link lists who is covered.
  const n = signing.covered.length;
  const who = n === 1 ? 'one person' : `${n} people`;
  const text = `Thank you. You signed the ${tenant.name} waiver for the ${signing.season} season, covering ${who}.\n\nYour signed copy: ${link}\n\nKeep this email. Show it at the ticket window if you are asked.`;
  const html = `<p>Thank you. You signed the ${esc(tenant.name)} waiver for the ${esc(signing.season)} season, covering ${esc(who)}.</p><p><a href="${esc(link)}">See your signed copy</a></p><p>Keep this email. Show it at the ticket window if you are asked.</p>`;
  const r = await mailer.send({ tenantId: tenant.id, to: signing.email, fromName: tenant.name, subject: `Your signed waiver for ${tenant.name}`, text, html, tag: 'waiver-copy' });
  if (r.ok) await conn.query('UPDATE waiver_signings SET emailed_at = NOW() WHERE tenant_id = ? AND id = ?', [tenant.id, signing.id]);
  return r;
}

/** What is kept of a copy link's token. */
const tokenSha = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** The WHERE clause and parameters that find a signing by its copy link: the hash, or the plain token of a row from before hashing. */
const byToken = (token) => ['(token_sha = ? OR token = ?)', [tokenSha(token), token]];

/**
 * The last day (YYYY-MM-DD) a guest's copy link works: the mountain's season end when it falls in the signing's season,
 * otherwise twelve months after signing. The mountain's own staff can still open the copy from Waivers after that.
 */
function copyLinkEnds(tenant, signing) {
  const end = tenant.season_ends_on ? String(tenant.season_ends_on).slice(0, 10) : null;
  if (end && seasonFor(end) === signing.season) return end;
  const signed = new Date(signing.created_at);
  signed.setUTCFullYear(signed.getUTCFullYear() + 1);
  return signed.toISOString().slice(0, 10);
}

/** Everything needed to show one signing exactly as it was signed. */
async function signingDetail(conn, tenantId, where, params) {
  const s = await one(conn, `SELECT * FROM waiver_signings WHERE tenant_id = ? AND ${where}`, [tenantId, ...params]);
  if (!s) return null;
  const text = await one(conn, 'SELECT body FROM waiver_texts WHERE tenant_id = ? AND sha = ?', [tenantId, s.text_sha]);
  const covered = await rows(conn, `SELECT w.id, w.person_id, w.signer_relation, w.voided_at, w.void_reason, CONCAT(p.first_name, ' ', p.last_name) AS name
    FROM waivers w LEFT JOIN people p ON p.tenant_id = w.tenant_id AND p.id = w.person_id WHERE w.tenant_id = ? AND w.signing_id = ? ORDER BY w.id`, [tenantId, s.id]);
  return { signing: s, text: text ? text.body : null, covered };
}

module.exports = { VALID, ON_FILE, MAX_SIGNATURE_CHARS, nextSeason, shaOf, archive, sign, emailCopy, signingDetail, tokenSha, byToken, copyLinkEnds };
