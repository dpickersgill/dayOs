'use strict';
// The confirmation a family gets when a lesson is booked (at the counter, online, from a waitlist, a moved date or an
// accepted private): when and where, what to bring, the family's link (check in, change the date) and how to cancel.
// Everyone who books calls it after the booking commits; it never throws.
//
// The email goes to the booking's contact email, else the student's guardian, else the student. A text goes as well
// when the mountain has the "Texts to families" add-on and the family said yes (lib/familynotify). No allergies or
// medical notes go in it: an email can be forwarded.
const { pool, one } = require('../db');
const S = require('./schoolsettings');
const links = require('./lessonlinks');
const { notify } = require('./familynotify');
const { policyText } = require('./onlinesale');
const levels = require('./levels');
const { guardianOf } = require('./lessonbooking');

const DEFAULT_BRING = 'Warm layers, waterproof gloves or mittens, goggles, a helmet, and a lift ticket if your lesson does not include one. Please arrive 20 minutes early.';

/** 'Saturday, January 10 at 10:00 AM' from a mountain-local 'YYYY-MM-DD HH:MM:SS'. */
function when(dt) {
  const d = String(dt).slice(0, 10);
  const [hh, mm] = String(dt).slice(11, 16).split(':').map(Number);
  const day = new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  return `${day} at ${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
}
const clock = (dt) => { const [hh, mm] = String(dt).slice(11, 16).split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Who the confirmation goes to: { email, phone, name }. */
async function recipient(db, tenantId, b) {
  const g = await guardianOf(db, tenantId, b.person_id);
  return {
    email: b.contact_email || (g && g.email) || b.email || null,
    phone: b.contact_phone || (g && g.phone) || b.phone || null,
    name: b.contact_name || (g ? g.first_name : null) || b.first_name,
  };
}

/** The email and text for one booking (exported for tests and the screens' preview). */
function compose({ tenant, b, settings, url }) {
  const lesson = `${b.product}${b.format === 'private' ? ' (private)' : ''}`;
  const lvl = b.level_min || b.level_max ? levels.range(b.level_min, b.level_max) : null;
  const bring = settings.what_to_bring || DEFAULT_BRING;
  const policy = policyText(tenant);
  const contact = [tenant.phone ? `call ${tenant.phone}` : null, tenant.reply_to ? `email ${tenant.reply_to}` : null].filter(Boolean).join(' or ');
  const lines = [
    `Hello ${b.to_name},`,
    '',
    `${b.first_name} is booked in ${lesson} at ${tenant.name}.`,
    '',
    `When: ${when(b.starts_at)} to ${clock(b.ends_at)}`,
    `Meet at: ${b.meeting_place || 'the ski school desk'}`,
    lvl ? `Level: ${lvl}` : null,
    '',
    `What to bring: ${bring}`,
    '',
    url ? `Your lesson page (check in when you arrive, see the details, change the date): ${url}` : null,
    url ? '' : null,
    'Canceling:',
    ...policy.map((p) => `- ${p}`),
    '',
    contact ? `Questions? ${contact[0].toUpperCase()}${contact.slice(1)}.` : null,
    '',
    'See you on the snow!',
    tenant.name,
  ].filter((x) => x !== null);
  const text = lines.join('\n');
  const html = `<p>Hello ${esc(b.to_name)},</p><p><strong>${esc(b.first_name)}</strong> is booked in <strong>${esc(lesson)}</strong> at ${esc(tenant.name)}.</p>
<table role="presentation" cellpadding="4"><tr><td><strong>When</strong></td><td>${esc(when(b.starts_at))} to ${esc(clock(b.ends_at))}</td></tr>
<tr><td><strong>Meet at</strong></td><td>${esc(b.meeting_place || 'the ski school desk')}</td></tr>${lvl ? `<tr><td><strong>Level</strong></td><td>${esc(lvl)}</td></tr>` : ''}</table>
<p><strong>What to bring:</strong> ${esc(bring)}</p>
${url ? `<p><a href="${esc(url)}">Open your lesson page</a> to check in when you arrive, see the details or change the date.</p>` : ''}
<p><strong>Canceling</strong></p><ul>${policy.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
${contact ? `<p>Questions? ${esc(contact[0].toUpperCase() + contact.slice(1))}.</p>` : ''}<p>See you on the snow!<br>${esc(tenant.name)}</p>`;
  const smsText = `${tenant.name}: ${b.first_name} is booked in ${b.product}, ${when(b.starts_at)}. Meet at ${b.meeting_place || 'the ski school desk'}.${url ? ` Details and check-in: ${url}` : ''}`.slice(0, 300);
  return { subject: `${b.first_name}'s lesson on ${when(b.starts_at).replace(/ at .*/, '')} is booked`, text, html, smsText };
}

/**
 * Sends (or re-sends) the confirmation for one booking. base: the site's base URL (lib/baseurl). opts.force sends even
 * when the school turned confirmation emails off (staff pressed Resend). Returns { ok, email, text, error? }.
 */
async function sendConfirmation(db, tenantId, bookingId, base, opts = {}) {
  try {
    db = db || pool;
    const settings = await S.get(db, tenantId);
    if (!settings.confirm_email && !opts.force) return { ok: false, skipped: true, error: 'Confirmation emails are turned off' };
    const b = await one(db, `SELECT b.*, s.starts_at, s.ends_at, s.meeting_place, s.level_min, s.level_max, s.format, s.status AS session_status, pr.name AS product,
        p.first_name, p.last_name, p.email, p.phone
      FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id
      JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id JOIN people p ON p.tenant_id = b.tenant_id AND p.id = b.person_id
      WHERE b.tenant_id = ? AND b.id = ?`, [tenantId, bookingId]);
    if (!b || b.status === 'cancelled' || b.session_status === 'cancelled') return { ok: false, error: 'That booking is canceled' };
    const tenant = await one(db, 'SELECT id, slug, name, phone, reply_to, refund_full_hours, refund_half_hours, refund_half_percent, cancel_note FROM tenants WHERE id = ?', [tenantId]);
    const to = await recipient(db, tenantId, b);
    if (!to.email && !(to.phone && b.text_ok)) return { ok: false, error: 'No email address for this booking' };
    const token = await links.issue(db, tenantId, b.id);
    const url = base ? links.url(base, tenant.slug, token) : null;
    const msg = compose({ tenant, b: { ...b, to_name: to.name }, settings, url });
    const out = await notify({ tenant, to: { email: to.email, phone: to.phone, textOk: Boolean(b.text_ok) }, ...msg, tag: 'lesson-confirmation' });
    const ok = Boolean((out.email && out.email.ok) || (out.text && out.text.ok));
    if (ok) await db.query('UPDATE lesson_bookings SET confirmed_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ?', [tenantId, b.id]);
    return { ok, email: out.email, text: out.text, to: to.email, error: ok ? undefined : ((out.email && out.email.error) || 'Not sent') };
  } catch (err) {
    console.error(JSON.stringify({ severity: 'ERROR', job: 'lesson_confirmation', tenant: tenantId, booking: bookingId, message: err.message }));
    return { ok: false, error: err.message };
  }
}

module.exports = { sendConfirmation, compose, DEFAULT_BRING };
