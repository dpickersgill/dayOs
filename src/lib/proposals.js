'use strict';

// Prepared actions (AI release 1). The assistant never sends, publishes, charges or changes anything by itself: it
// prepares a proposal, and a person approves it. A kind of proposal is registered once, with the roles that may
// approve it, the apps (modules) it needs, and the handler that does the work. Approving re-checks that the person has
// the role and the apps for that kind at that moment, applies their edits, and runs the handler as that person, through
// the same lib functions (and so the same permission checks and audit rows) the screen uses. Two people pressing
// Approve at once cannot both run it: the row is locked and claimed, and the second is told it is already done.
//
// This file never reads patrol tables or patient care records (test/proposals.test.js checks that).
const { tx, rows, one } = require('../db');
const { AppError, notFound, conflict, forbidden, bad } = require('./errors');
const { audit } = require('./audit');
const { roleAllows } = require('./roleallows');
const modules = require('./modules');

const KINDS = new Map();
const LABEL = 'Drafted by the assistant';
// A draft made without AI (no key, the month's allowance used, the model unreachable, or its wording failed the facts
// check) was filled in by code from the mountain's records: it must not say the assistant drafted it.
const TEMPLATE_LABEL = 'Filled in from today\u2019s records';
const labelFor = (preview) => (preview && preview.by === 'template' ? TEMPLATE_LABEL : LABEL);

/**
 * Registers a kind. def: {
 *   roles: ['owner', 'manager', ...]       who may approve (owner always may, as on every screen)
 *   module: 'assistant_plus' | [..]        apps that must be on for the mountain
 *   run(db, ctx, payload)                  does the work as ctx (the approver's request); returns a small result
 *   preview(payload)                       what a card shows, when create() is not given one
 *   editable: [{ key, label, max, type, line }]  fields the approver may change (type 'text' or 'boolean'; line: one line)
 *   check(db, ctx, payload)                optional: refuses before anything is claimed (a missing permission for one part)
 *   forViewer(db, ctx, row)                optional: extra facts for this viewer's card (may they email, how many people)
 * }
 */
function register(kind, def) {
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(kind)) throw new Error(`bad proposal kind ${kind}`);
  if (!def || !Array.isArray(def.roles) || typeof def.run !== 'function') throw new Error(`proposal kind ${kind} needs roles and run`);
  KINDS.set(kind, { editable: [], ...def, modules: [].concat(def.module || []) });
  return KINDS.get(kind);
}
const kindOf = (kind) => KINDS.get(kind) || null;

const parse = (s, fallback = null) => { if (s === null || s === undefined || s === '') return fallback; if (typeof s === 'object') return s; try { return JSON.parse(s); } catch (_) { return fallback; } };

/** May this person act on this proposal: its kind's roles, the roles it was prepared for, and every app it needs on. */
async function mayAct(ctx, row, def) {
  if (!def) return { ok: false, why: 'This kind of draft is no longer available.' };
  const forRoles = String(row.for_roles || '').split(',').filter(Boolean);
  const roles = def.roles.filter((r) => !forRoles.length || forRoles.includes(r) || r === 'owner');
  if (!roleAllows(ctx.auth, roles)) return { ok: false, why: 'Your role cannot approve this.' };
  const on = new Set(await modules.enabledKeys(ctx.auth.tenantId));
  const missing = def.modules.filter((m) => !on.has(m));
  if (missing.length) return { ok: false, why: `This needs ${missing.map((m) => (modules.MODULES.find((x) => x.key === m) || { label: m }).label).join(' and ')}, which is not on for your mountain.`, module: true };
  return { ok: true };
}

/** Saves a proposal. Returns its id. Nothing is done until a person approves it. */
async function create(db, { tenantId, kind, title, summary = null, preview, payload, forRoles, expiresAt = null, source = 'assistant' }) {
  const def = kindOf(kind);
  if (!def) throw new Error(`unknown proposal kind ${kind}`);
  if (!tenantId) throw new Error('create needs a tenantId');
  const roles = (forRoles && forRoles.length ? forRoles : def.roles).filter((r) => def.roles.includes(r));
  const shown = preview !== undefined ? preview : def.preview ? def.preview(payload) : null;
  const exp = expiresAt ? new Date(expiresAt).toISOString().slice(0, 19).replace('T', ' ') : null;
  const [r] = await db.query('INSERT INTO ai_proposals (tenant_id, kind, title, summary, preview, payload, for_roles, source, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [tenantId, kind, String(title).slice(0, 200), summary ? String(summary).slice(0, 500) : null, JSON.stringify(shown ?? null), JSON.stringify(payload ?? null), roles.join(','), String(source).slice(0, 40), exp]);
  return r.insertId;
}

/** Proposals past their time can no longer be approved. */
async function expireStale(db, tenantId) {
  await db.query("UPDATE ai_proposals SET status = 'expired' WHERE tenant_id = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= UTC_TIMESTAMP()", [tenantId]);
}

const isoUtc = (v) => (v ? `${(v instanceof Date ? v.toISOString() : `${String(v).replace(' ', 'T')}Z`).slice(0, 19)}Z` : null);

/** What a card shows: the kind's fields the person may edit, and its label (AI drafts say "Drafted by the assistant"). */
async function shape(db, ctx, row) {
  const def = kindOf(row.kind);
  const preview = parse(row.preview);
  return {
    id: Number(row.id), kind: row.kind, title: row.title, summary: row.summary, status: row.status, source: row.source,
    label: labelFor(preview), preview, editable: def ? def.editable : [],
    created_at: isoUtc(row.created_at), expires_at: isoUtc(row.expires_at),
    viewer: def && def.forViewer ? await def.forViewer(db, ctx, row) : {},
  };
}

/** Pending proposals this person may act on (or, with status, recent ones of that status). */
async function list(db, ctx, { status = 'pending', limit = 20 } = {}) {
  await expireStale(db, ctx.auth.tenantId);
  const want = ['pending', 'approved', 'rejected', 'expired', 'failed'].includes(status) ? status : 'pending';
  const all = await rows(db, 'SELECT * FROM ai_proposals WHERE tenant_id = ? AND status = ? ORDER BY id DESC LIMIT 100', [ctx.auth.tenantId, want]);
  const out = [];
  for (const row of all) {
    if (out.length >= limit) break;
    if ((await mayAct(ctx, row, kindOf(row.kind))).ok) out.push(await shape(db, ctx, row));
  }
  return out;
}

/** The person's edits, only on the fields the kind allows, checked and cut to size. Returns { payload, edits }. */
function applyEdits(def, payload, edits) {
  if (edits === undefined || edits === null) return { payload, edits: {} };
  if (typeof edits !== 'object' || Array.isArray(edits)) throw bad('Edits must be a list of fields');
  const allowed = new Map(def.editable.map((f) => [f.key, f]));
  const kept = {};
  for (const [k, v] of Object.entries(edits)) {
    const f = allowed.get(k);
    if (!f) throw bad(`${k} cannot be changed here`);
    if (f.type === 'boolean') { if (typeof v !== 'boolean') throw bad(`${f.label} must be yes or no`); kept[k] = v; continue; }
    if (typeof v !== 'string') throw bad(`${f.label} must be text`);
    // A one-line field (an email subject) loses any CR or LF, so no header can be slipped into the message.
    const t = f.line ? v.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim() : v.replace(/\r\n/g, '\n').trim();
    if (f.required && !t) throw bad(`${f.label} cannot be empty`);
    if (f.max && t.length > f.max) throw bad(`${f.label} is too long (${f.max} characters at most)`);
    kept[k] = t;
  }
  return { payload: { ...(payload || {}), ...kept }, edits: kept };
}

/** Locks the row and checks it may be decided by this person now. Returns { row, def }. */
async function lockForDecision(conn, ctx, id) {
  const row = await one(conn, 'SELECT *, (expires_at IS NOT NULL AND expires_at <= UTC_TIMESTAMP()) AS past FROM ai_proposals WHERE tenant_id = ? AND id = ? FOR UPDATE', [ctx.auth.tenantId, id]);
  if (!row) throw notFound('Draft');
  const def = kindOf(row.kind);
  const may = await mayAct(ctx, row, def);
  if (!may.ok) throw forbidden(may.why);
  if (row.status === 'pending' && Number(row.past)) {
    await conn.query("UPDATE ai_proposals SET status = 'expired' WHERE tenant_id = ? AND id = ?", [ctx.auth.tenantId, id]);
    return { row: { ...row, status: 'expired' }, def };
  }
  return { row, def };
}

const DONE = { approved: 'This draft was already approved.', rejected: 'This draft was set aside.', expired: 'This draft is past its time and can no longer be approved.', failed: 'This draft was approved, but it did not go through. Draft it again.' };

/**
 * Approves a proposal as the person in ctx (the request: ctx.auth, ctx.ip). Re-checks their role and apps, applies their
 * edits, runs the handler as them, and audits the decision and the outcome. Returns { status, result }.
 */
async function approve(db, ctx, id, edits) {
  // 1. Lock, check, claim: the first approver wins; anyone after them is told it is done.
  const claimed = await tx(async (conn) => {
    const { row, def } = await lockForDecision(conn, ctx, id);
    if (row.status !== 'pending') return { gone: row.status };
    const payload = parse(row.payload, {});
    const out = applyEdits(def, payload, edits);
    if (def.check) await def.check(conn, ctx, out.payload);
    await conn.query("UPDATE ai_proposals SET status = 'approved', decided_by = ?, decided_at = UTC_TIMESTAMP(), edits = ? WHERE tenant_id = ? AND id = ? AND status = 'pending'",
      [ctx.auth.userId, Object.keys(out.edits).length ? JSON.stringify(out.edits) : null, ctx.auth.tenantId, id]);
    await audit(conn, ctx, 'ai_proposal_approve', 'ai_proposals', id, { kind: row.kind, edited: Object.keys(out.edits), source: row.source });
    return { row, def, payload: out.payload };
  });
  if (claimed.gone) {
    if (claimed.gone === 'expired') await audit(db, ctx, 'ai_proposal_expired', 'ai_proposals', id, null);
    throw conflict(DONE[claimed.gone]);
  }
  // 2. Run it as the approver, through the screen's own code. A failure is recorded, audited and shown.
  try {
    const result = await claimed.def.run(db, ctx, claimed.payload);
    await db.query('UPDATE ai_proposals SET result = ? WHERE tenant_id = ? AND id = ?', [JSON.stringify(result ?? null).slice(0, 60000), ctx.auth.tenantId, id]);
    await audit(db, ctx, 'ai_proposal_done', 'ai_proposals', id, { kind: claimed.row.kind, ...(result && typeof result === 'object' && !Array.isArray(result) ? result : {}) });
    return { status: 'approved', result: result ?? null };
  } catch (err) {
    const message = String((err && err.message) || 'It did not go through').slice(0, 500);
    await db.query("UPDATE ai_proposals SET status = 'failed', error = ? WHERE tenant_id = ? AND id = ?", [message, ctx.auth.tenantId, id]);
    await audit(db, ctx, 'ai_proposal_failed', 'ai_proposals', id, { kind: claimed.row.kind, status: err && err.status ? err.status : 500 });
    const e = new AppError(err && err.status && err.status < 500 ? err.status : 502, `Approved, but it did not go through: ${message}`);
    e.failed = true;
    throw e;
  }
}

/** Sets a proposal aside ("Not now"). The same role and app check as approving. */
async function reject(db, ctx, id) {
  const gone = await tx(async (conn) => {
    const { row } = await lockForDecision(conn, ctx, id);
    if (row.status !== 'pending') return row.status;
    await conn.query("UPDATE ai_proposals SET status = 'rejected', decided_by = ?, decided_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ? AND status = 'pending'", [ctx.auth.userId, ctx.auth.tenantId, id]);
    await audit(conn, ctx, 'ai_proposal_reject', 'ai_proposals', id, { kind: row.kind });
    return null;
  });
  if (gone) throw conflict(DONE[gone]);
  return { status: 'rejected' };
}

/** A newer draft of the same kind takes the place of an older pending one (Draft now pressed twice). */
async function supersede(db, tenantId, kind, keepId) {
  await db.query("UPDATE ai_proposals SET status = 'expired', error = 'A newer draft took its place' WHERE tenant_id = ? AND kind = ? AND status = 'pending' AND id <> ?", [tenantId, kind, keepId]);
}

/**
 * Saves a proposal in place of any pending one of the same kind, as one locked step (2026.11.15 review: two Draft now
 * presses at once could each set the other aside, leaving no pending draft). A named lock per mountain and kind, held
 * until the insert and the set-aside are committed, so exactly one pending draft remains: the one saved last.
 */
async function createReplacing(opts) {
  const { pool } = require('../db');
  const conn = await pool.getConnection();
  const name = `summitops_proposal_${Number(opts.tenantId)}_${String(opts.kind).slice(0, 40)}`;
  try {
    const [[got]] = await conn.query('SELECT GET_LOCK(?, 20) AS ok', [name]);
    if (!Number(got.ok)) throw conflict('Another draft is being saved. Try again in a moment.');
    try {
      await conn.beginTransaction();
      const id = await create(conn, opts);
      await supersede(conn, opts.tenantId, opts.kind, id);
      await conn.commit();
      return id;
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [name]).catch(() => {});
    }
  } finally {
    conn.release();
  }
}

module.exports = { register, kindOf, create, createReplacing, list, approve, reject, supersede, applyEdits, expireStale, roleAllows, LABEL, TEMPLATE_LABEL, labelFor, KINDS };
