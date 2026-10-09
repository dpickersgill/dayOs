'use strict';

// Follow-up after patrol helps a guest: five days later (configurable) an email asks how we did and invites a gift.
// Rules, in plain words:
//   - Only approved reports are used, only when the patient (or a guardian, for a minor) has an email, and never
//     when patrol marked "do not contact" or the address has asked to stop.
//   - Transports and serious or critical cases are HELD until a director approves them. Everything else goes out
//     on its own.
//   - The email never says what happened. No injury, treatment or case details are ever included.
const crypto = require('crypto');
const { pool, rows, one } = require('../db');
const { eachTenant } = require('./jobs');
const { isSandbox } = require('./sandbox');
const mailer = require('./mailer');
const { todayIn, addDays } = require('./util');

const { esc } = require('./format');
const orgName = (t) => t.patrol_org_name || `${t.name} Ski Patrol`;
const amountsOf = (t) => String(t.donate_amounts || '25,50,100,250').split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 5000).slice(0, 6);
const newToken = () => crypto.randomBytes(16).toString('hex');

/** Where the email should be sent, or null when it should not be sent at all. */
function recipientFor(p) {
  if (p.no_followup) return null;
  const minor = p.age_years !== null && p.age_years !== undefined && p.age_years < 18;
  if (minor) return p.guardian_email ? { email: p.guardian_email, guardian: true } : null;
  return p.email ? { email: p.email, guardian: false } : null;
}

const needsDirector = (p) => ['serious', 'critical'].includes(p.severity) || ['transported_ambulance', 'transported_private'].includes(p.disposition);

/** Creates follow-up rows for patients whose time has come. Safe to run any number of times. */
async function queueDue(tenant, today) {
  const cutoff = addDays(today, -Number(tenant.followup_days || 5));
  const patients = await rows(pool, `SELECT p.id, p.incident_id, p.age_years, p.email, p.guardian_email, p.no_followup, p.disposition, i.severity, DATE(i.occurred_at) AS day
    FROM incident_patients p JOIN incidents i ON i.tenant_id = p.tenant_id AND i.id = p.incident_id
    LEFT JOIN followups f ON f.tenant_id = p.tenant_id AND f.patient_id = p.id
    WHERE p.tenant_id = ? AND f.id IS NULL AND p.voided_at IS NULL AND i.report_state = 'approved' AND DATE(i.occurred_at) <= ?
      AND i.category IN ('injury','medical','collision') AND DATE(i.occurred_at) >= ?
    ORDER BY p.id LIMIT 500`, [tenant.id, cutoff, addDays(today, -60)]);
  let created = 0;
  for (const p of patients) {
    const to = recipientFor(p);
    if (!to) continue;
    if (await one(pool, 'SELECT 1 AS x FROM email_suppressions WHERE tenant_id = ? AND email = ?', [tenant.id, to.email.toLowerCase()])) continue;
    const held = needsDirector(p);
    const [r] = await pool.query(
      'INSERT IGNORE INTO followups (tenant_id, incident_id, patient_id, to_email, for_guardian, due_on, status, hold_reason, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [tenant.id, p.incident_id, p.id, to.email.toLowerCase(), to.guardian ? 1 : 0, addDays(String(p.day), Number(tenant.followup_days || 5)), held ? 'held' : 'queued', held ? 'Transported or serious: a director decides' : null, newToken()],
    );
    created += r.affectedRows;
  }
  return created;
}

/** The email. No case details, only an invitation to rate us and to give. */
function buildEmail(tenant, fu, base, firstName) {
  const org = orgName(tenant);
  const page = `${base}/f/${fu.token}`;
  const amounts = amountsOf(tenant);
  const hello = fu.for_guardian ? 'Hello,' : (firstName ? `Hi ${firstName},` : 'Hello,');
  const who = fu.for_guardian ? 'your child' : 'you';
  const lines = [
    hello, '',
    `A few days ago a member of the ${org} helped ${who} on the mountain. We hope ${fu.for_guardian ? 'they are' : 'you are'} doing well.`, '',
    `Would you tell us how we did? It takes one tap:`, page, '',
    `${org} is a volunteer, nonprofit team. Our patrollers give their time, and gifts from the people we help pay for the training and equipment that keep the mountain safe.${tenant.donate_blurb ? ` ${tenant.donate_blurb}` : ''}`, '',
    'If you would like to help, one tap does it:',
    ...amounts.map((a) => `  $${a}: ${page}?give=${a}`), `  Another amount: ${page}?give=other`, '',
    ...(tenant.tax_note ? [tenant.tax_note, ''] : []),
    `Thank you,`, `The ${org}`, '', '--',
    `${org}${tenant.mail_address ? `, ${tenant.mail_address}` : ''}`,
    `You received this because our patrol helped ${fu.for_guardian ? 'someone in your care' : 'you'}. To stop these emails: ${page}?stop=1`,
  ];
  const btn = (href, label, primary) => `<a href="${esc(href)}" style="display:inline-block;margin:4px 6px 4px 0;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700;${primary ? 'background:#1d5fd1;color:#fff;' : 'background:#eef3fb;color:#0d2a44;border:1px solid #c9d6ea;'}">${esc(label)}</a>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#0d2a44;line-height:1.5">
<p>${esc(hello)}</p>
<p>A few days ago a member of the ${esc(org)} helped ${esc(who)} on the mountain. We hope ${fu.for_guardian ? 'they are' : 'you are'} doing well.</p>
<p><strong>Would you tell us how we did?</strong> It takes one tap.</p>
<p>${btn(page, 'Tell us how we did', true)}</p>
<p>${esc(org)} is a volunteer, nonprofit team. Our patrollers give their time, and gifts from the people we help pay for the training and equipment that keep the mountain safe.${tenant.donate_blurb ? ` ${esc(tenant.donate_blurb)}` : ''}</p>
<p>If you would like to help, one tap does it:</p>
<p>${amounts.map((a) => btn(`${page}?give=${a}`, `$${a}`)).join('')}${btn(`${page}?give=other`, 'Other amount')}</p>
${tenant.tax_note ? `<p style="font-size:13px;color:#4a5d73">${esc(tenant.tax_note)}</p>` : ''}
<p>Thank you,<br>The ${esc(org)}</p>
<hr style="border:none;border-top:1px solid #dde5f0;margin:24px 0 12px">
<p style="font-size:12px;color:#6b7c90">${esc(org)}${tenant.mail_address ? `, ${esc(tenant.mail_address)}` : ''}<br>You received this because our patrol helped ${fu.for_guardian ? 'someone in your care' : 'you'}. <a href="${esc(`${page}?stop=1`)}">Stop these emails</a>.</p></div>`;
  return { subject: `How did the ${org} do?`, text: lines.join('\n'), html, unsubscribe: `${page}?stop=1` };
}

/** Sends one follow-up now. Returns the new status. */
async function sendOne(fu, tenant, base) {
  // Claim it first so two workers, or a double click, cannot both send the same email. A claim older than ten minutes is treated as abandoned.
  const [claim] = await pool.query(
    "UPDATE followups SET sent_at = NOW() WHERE id = ? AND tenant_id = ? AND status IN ('held', 'queued', 'failed') AND (sent_at IS NULL OR sent_at < NOW() - INTERVAL 10 MINUTE)",
    [fu.id, tenant.id],
  );
  if (!claim.affectedRows) return 'busy';
  if (await one(pool, 'SELECT 1 AS x FROM email_suppressions WHERE tenant_id = ? AND email = ?', [tenant.id, fu.to_email])) {
    await pool.query("UPDATE followups SET status = 'unsubscribed', sent_at = NULL WHERE id = ?", [fu.id]);
    return 'unsubscribed';
  }
  if (await isSandbox(tenant.id)) {
    await pool.query("UPDATE followups SET status = 'failed', sent_at = NULL, error = ? WHERE id = ?", ['Email is switched off in the demo', fu.id]);
    return 'failed';
  }
  const pat = await one(pool, 'SELECT first_name FROM incident_patients WHERE tenant_id = ? AND id = ?', [tenant.id, fu.patient_id]);
  const m = buildEmail(tenant, fu, base, pat && pat.first_name && pat.first_name !== 'Unknown' ? pat.first_name : '');
  const r = await mailer.send({
    tenantId: tenant.id, to: fu.to_email, fromName: orgName(tenant), replyTo: tenant.reply_to || undefined, subject: m.subject, text: m.text, html: m.html, tag: 'patrol-followup',
    headers: [{ Name: 'List-Unsubscribe', Value: `<${m.unsubscribe}>` }],
  });
  if (r.ok) { await pool.query("UPDATE followups SET status = 'sent', sent_at = NOW(), error = NULL WHERE id = ?", [fu.id]); return 'sent'; }
  await pool.query("UPDATE followups SET status = 'failed', sent_at = NULL, error = ? WHERE id = ?", [r.error, fu.id]);
  return 'failed';
}

async function sendQueued(tenant, today, base) {
  const due = await rows(pool, "SELECT * FROM followups WHERE tenant_id = ? AND status = 'queued' AND due_on <= ? ORDER BY id LIMIT 200", [tenant.id, today]);
  const out = { sent: 0, failed: 0, unsubscribed: 0, busy: 0 };
  for (const fu of due) out[await sendOne(fu, tenant, base)] += 1;
  return out;
}

/** A short morning note to the people who approve reports. Skipped when nothing is waiting. */
async function sendDigest(tenant, today, base) {
  const [{ waiting }] = await rows(pool, "SELECT COUNT(*) AS waiting FROM incidents WHERE tenant_id = ? AND report_state = 'submitted'", [tenant.id]);
  const [{ stale }] = await rows(pool, "SELECT COUNT(*) AS stale FROM incidents WHERE tenant_id = ? AND report_state = 'draft' AND occurred_at < ? AND category IN ('injury','medical','collision')", [tenant.id, `${addDays(today, -1)} 00:00:00`]);
  const [{ held }] = await rows(pool, "SELECT COUNT(*) AS held FROM followups WHERE tenant_id = ? AND status = 'held'", [tenant.id]);
  if (!waiting && !stale && !held) return 0;
  const to = await rows(pool, "SELECT email FROM users WHERE tenant_id = ? AND active = 1 AND role IN ('owner','manager')", [tenant.id]);
  const lines = [
    waiting ? `${waiting} report${waiting === 1 ? ' is' : 's are'} waiting for approval.` : null,
    stale ? `${stale} case${stale === 1 ? ' is' : 's are'} still in draft from before today.` : null,
    held ? `${held} follow-up email${held === 1 ? ' is' : 's are'} waiting for a director to approve or skip.` : null,
  ].filter(Boolean);
  const text = `${lines.join('\n')}\n\nOpen Patrol: ${base}/\n\nThis note has no patient details.`;
  let n = 0;
  if (await isSandbox(tenant.id)) return 0;
  for (const u of to) if ((await mailer.send({ tenantId: tenant.id, to: u.email, fromName: orgName(tenant), subject: `Patrol: ${lines.length} thing${lines.length === 1 ? '' : 's'} need attention`, text, tag: 'patrol-digest' })).ok) n += 1;
  return n;
}

/** The daily job: for every mountain with follow-up switched on, queue, send, and nudge. */
async function runDaily(base) {
  const out = await eachTenant('patrol_followups', async (t) => {
    const today = todayIn(t.timezone);
    const on = Boolean(t.followup_enabled);
    const created = on ? await queueDue(t, today) : 0;
    const sent = on && mailer.enabled() ? await sendQueued(t, today, base) : { sent: 0, failed: 0, unsubscribed: 0, ...(on ? { note: 'Email is not set up' } : {}) };
    const digests = mailer.enabled() ? await sendDigest(t, today, base) : 0;
    return { created, ...sent, digests };
  });
  return { tenants: out.length, results: out };
}

module.exports = { queueDue, sendOne, sendQueued, sendDigest, runDaily, buildEmail, recipientFor, needsDirector, amountsOf, orgName, newToken };
