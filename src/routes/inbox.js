'use strict';

// Inbox: messages between the people who sign in at this mountain. One-to-one and group conversations; a message can
// carry links to records in the app, which each reader sees only as far as they are allowed to open them.
// Conversations are private to their members: an owner or manager cannot read conversations they are not in.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { z, validate, paramId } = require('../lib/util');
const { bad, notFound, forbidden } = require('../lib/errors');
const L = require('../lib/chatlinks');
const review = require('../lib/review');

const router = express.Router();
const MAX_REFS = 5;
const ref = z.object({ type: z.enum(L.TYPE_KEYS), id: z.number().int().positive() });
const refList = z.array(ref).max(MAX_REFS).default([]);
const body = z.string().max(4000).default('');

const NAME = "COALESCE(NULLIF(TRIM(CONCAT(COALESCE(p.first_name, sp.first_name, ''), ' ', COALESCE(p.last_name, sp.last_name, ''))), ''), u.email, u.username)";
const USER_JOIN = 'LEFT JOIN people p ON p.tenant_id = u.tenant_id AND p.id = u.person_id LEFT JOIN staff s ON s.tenant_id = u.tenant_id AND s.id = u.staff_id LEFT JOIN people sp ON sp.tenant_id = s.tenant_id AND sp.id = s.person_id';

async function namesOf(db, tenantId, ids) {
  if (!ids.length) return new Map();
  return new Map((await rows(db, `SELECT u.id, ${NAME} AS name, u.role FROM users u ${USER_JOIN} WHERE u.tenant_id = ? AND u.id IN (?)`, [tenantId, ids])).map((r) => [Number(r.id), r]));
}

/** The thread, if this login is a current member of it; otherwise a 404 (a conversation you are not in does not exist for you). */
async function memberOf(db, req, id, { lock = false } = {}) {
  const t = await one(db, `SELECT t.*, m.last_read_id, m.visible_from_id FROM chat_threads t JOIN chat_members m ON m.tenant_id = t.tenant_id AND m.thread_id = t.id AND m.user_id = ? AND m.left_at IS NULL
    WHERE t.tenant_id = ? AND t.id = ?${lock ? ' FOR UPDATE' : ''}`, [req.auth.userId, req.auth.tenantId, id]);
  if (!t) throw notFound('Conversation');
  return t;
}

async function activeUsers(db, tenantId, ids) {
  if (!ids.length) return [];
  return (await rows(db, 'SELECT id FROM users WHERE tenant_id = ? AND active = 1 AND id IN (?)', [tenantId, ids])).map((r) => Number(r.id));
}

async function addMessage(conn, req, threadId, text, refs, { system = false } = {}) {
  const [r] = await conn.query('INSERT INTO chat_messages (tenant_id, thread_id, user_id, body, refs) VALUES (?, ?, ?, ?, ?)',
    [req.auth.tenantId, threadId, system ? null : req.auth.userId, text, refs && refs.length ? JSON.stringify(refs) : null]);
  await conn.query('UPDATE chat_threads SET last_message_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, threadId]);
  // the sender has read their own message (and the note about something they just did)
  await conn.query('UPDATE chat_members SET last_read_id = GREATEST(last_read_id, ?) WHERE tenant_id = ? AND thread_id = ? AND user_id = ?', [r.insertId, req.auth.tenantId, threadId, req.auth.userId]);
  return r.insertId;
}

const cleanRefs = (refs) => {
  const seen = new Set();
  return refs.filter((r) => { const k = `${r.type}:${r.id}`; if (seen.has(k)) return false; seen.add(k); return true; });
};
const parseRefs = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } };

// ---------------------------------------------------------------- people and conversations
router.get('/people', async (req, res) => {
  const data = await rows(pool, `SELECT u.id, ${NAME} AS name, u.role FROM users u ${USER_JOIN} WHERE u.tenant_id = ? AND u.active = 1 AND u.id <> ? ORDER BY name`, [req.auth.tenantId, req.auth.userId]);
  res.json({ data });
});

router.get('/threads', async (req, res) => {
  const { tenantId: t, userId: me } = req.auth;
  const list = await rows(pool, `SELECT t.id, t.kind, t.name, t.created_at, t.last_message_at, m.last_read_id,
      (SELECT COUNT(*) FROM chat_messages x WHERE x.tenant_id = t.tenant_id AND x.thread_id = t.id AND x.id > GREATEST(m.last_read_id, m.visible_from_id) AND x.deleted_at IS NULL AND (x.user_id IS NULL OR x.user_id <> ?)) AS unread,
      (SELECT MAX(x.id) FROM chat_messages x WHERE x.tenant_id = t.tenant_id AND x.thread_id = t.id AND x.id > m.visible_from_id) AS last_id
    FROM chat_threads t JOIN chat_members m ON m.tenant_id = t.tenant_id AND m.thread_id = t.id AND m.user_id = ? AND m.left_at IS NULL
    WHERE t.tenant_id = ? ORDER BY COALESCE(t.last_message_at, t.created_at) DESC LIMIT 300`, [me, me, t]);
  const ids = list.map((x) => x.id);
  const members = ids.length ? await rows(pool, 'SELECT thread_id, user_id FROM chat_members WHERE tenant_id = ? AND thread_id IN (?) AND left_at IS NULL', [t, ids]) : [];
  const lastIds = list.map((x) => x.last_id).filter(Boolean);
  const lasts = lastIds.length ? await rows(pool, 'SELECT id, user_id, body, refs, deleted_at FROM chat_messages WHERE tenant_id = ? AND id IN (?)', [t, lastIds]) : [];
  const names = await namesOf(pool, t, [...new Set([...members.map((m) => Number(m.user_id)), ...lasts.map((l) => Number(l.user_id)).filter(Boolean)])]);
  res.json({
    data: list.map((x) => {
      const who = members.filter((m) => m.thread_id === x.id && Number(m.user_id) !== me).map((m) => ({ id: Number(m.user_id), name: (names.get(Number(m.user_id)) || {}).name || 'Someone' }));
      const l = lasts.find((m) => m.id === x.last_id);
      const preview = !l ? null : l.deleted_at ? 'Message removed' : (l.body || (parseRefs(l.refs).length ? 'Shared a link' : ''));
      return {
        id: x.id, kind: x.kind, name: x.name, title: x.name || who.map((w) => w.name).join(', ') || 'Just you', members: who,
        unread: Number(x.unread), last_at: x.last_message_at || x.created_at,
        last: l ? { by: l.user_id === null ? null : Number(l.user_id) === me ? 'You' : (names.get(Number(l.user_id)) || {}).name || 'Someone', text: String(preview).slice(0, 140) } : null,
      };
    }),
  });
});

router.get('/unread', async (req, res) => {
  const { tenantId: t, userId: me } = req.auth;
  review.maybeNudge(t); // reports waiting too long for the patrol review group (checked at most every 10 minutes)
  // Driven from this person's memberships (index tenant_id, user_id), then each thread's messages after the read mark.
  const r = await one(pool, `SELECT COUNT(*) AS n FROM chat_members m
    JOIN chat_messages x ON x.tenant_id = m.tenant_id AND x.thread_id = m.thread_id AND x.id > GREATEST(m.last_read_id, m.visible_from_id)
    WHERE m.tenant_id = ? AND m.user_id = ? AND m.left_at IS NULL AND x.deleted_at IS NULL AND (x.user_id IS NULL OR x.user_id <> ?)`, [t, me, me]);
  res.json({ unread: Number(r.n) });
});

/**
 * Start a conversation. One other person and no name: the direct conversation between the two of you (the same one
 * every time). Otherwise a new group. A first message can go with it.
 */
router.post('/threads', validate(z.object({ user_ids: z.array(z.number().int().positive()).min(1).max(50), name: z.string().trim().max(80).optional(), body, refs: refList })), async (req, res) => {
  const { tenantId: t, userId: me } = req.auth;
  const b = req.body;
  const others = (await activeUsers(pool, t, [...new Set(b.user_ids)].filter((id) => id !== me)));
  if (!others.length) throw bad('Choose at least one other person');
  if (others.length !== new Set(b.user_ids.filter((id) => id !== me)).size) throw bad('Someone in that list cannot receive messages');
  const out = await tx(async (conn) => {
    let id;
    if (others.length === 1 && !b.name) {
      const key = [me, others[0]].sort((x, y) => x - y).join(':');
      await conn.query("INSERT IGNORE INTO chat_threads (tenant_id, kind, direct_key, created_by) VALUES (?, 'direct', ?, ?)", [t, key, me]);
      id = (await one(conn, 'SELECT id FROM chat_threads WHERE tenant_id = ? AND direct_key = ? FOR UPDATE', [t, key])).id;
      for (const u of [me, others[0]]) await conn.query('INSERT INTO chat_members (thread_id, tenant_id, user_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE left_at = NULL', [id, t, u]);
    } else {
      const [r] = await conn.query("INSERT INTO chat_threads (tenant_id, kind, name, created_by) VALUES (?, 'group', ?, ?)", [t, b.name || null, me]);
      id = r.insertId;
      for (const u of [me, ...others]) await conn.query('INSERT INTO chat_members (thread_id, tenant_id, user_id) VALUES (?, ?, ?)', [id, t, u]);
    }
    const refs = cleanRefs(b.refs);
    if (b.body.trim() || refs.length) await addMessage(conn, req, id, b.body.trim(), refs);
    return id;
  });
  res.status(201).json({ id: out });
});

router.get('/threads/:id', async (req, res) => {
  const th = await memberOf(pool, req, paramId(req));
  const members = await rows(pool, 'SELECT user_id FROM chat_members WHERE tenant_id = ? AND thread_id = ? AND left_at IS NULL', [req.auth.tenantId, th.id]);
  const names = await namesOf(pool, req.auth.tenantId, members.map((m) => Number(m.user_id)));
  const list = members.map((m) => ({ id: Number(m.user_id), name: (names.get(Number(m.user_id)) || {}).name || 'Someone', role: (names.get(Number(m.user_id)) || {}).role, you: Number(m.user_id) === req.auth.userId }));
  const others = list.filter((m) => !m.you);
  res.json({ id: th.id, kind: th.kind, name: th.name, title: th.name || others.map((m) => m.name).join(', ') || 'Just you', members: list });
});

/** Messages, newest page first (before=<id> for older ones, after=<id> for new ones since the last look). */
router.get('/threads/:id/messages', async (req, res) => {
  const th = await memberOf(pool, req, paramId(req));
  const t = req.auth.tenantId;
  const before = Math.trunc(Number(req.query.before)) || null; const after = Math.trunc(Number(req.query.after)) || null;
  const limit = Math.min(Math.max(1, Math.trunc(Number(req.query.limit)) || 50), 100);
  const where = ['tenant_id = ?', 'thread_id = ?', 'id > ?']; const params = [t, th.id, Number(th.visible_from_id) || 0];
  if (before) { where.push('id < ?'); params.push(before); }
  if (after) { where.push('id > ?'); params.push(after); }
  const list = (await rows(pool, `SELECT id, user_id, body, refs, created_at, deleted_at FROM chat_messages WHERE ${where.join(' AND ')} ORDER BY id ${after ? 'ASC' : 'DESC'} LIMIT ?`, [...params, limit + 1]));
  const more = list.length > limit;
  const page = list.slice(0, limit);
  if (!after) page.reverse();
  const names = await namesOf(pool, t, [...new Set(page.map((m) => Number(m.user_id)).filter(Boolean))]);
  const allRefs = page.filter((m) => !m.deleted_at).flatMap((m) => parseRefs(m.refs));
  const links = await L.resolve(req, allRefs);
  const linkOf = (r) => links.find((l) => l.type === r.type && l.id === Number(r.id));
  res.json({
    thread: { id: th.id, last_read_id: Number(th.last_read_id) },
    more_before: !after && more,
    data: page.map((m) => ({
      id: m.id, at: m.created_at,
      by: m.user_id === null ? null : { id: Number(m.user_id), name: (names.get(Number(m.user_id)) || {}).name || 'Someone', you: Number(m.user_id) === req.auth.userId },
      body: m.deleted_at ? '' : m.body, removed: Boolean(m.deleted_at),
      links: m.deleted_at ? [] : parseRefs(m.refs).map(linkOf).filter(Boolean),
    })),
  });
});

router.post('/threads/:id/messages', validate(z.object({ body, refs: refList })), async (req, res) => {
  const text = req.body.body.trim();
  const refs = cleanRefs(req.body.refs);
  if (!text && !refs.length) throw bad('Write a message or add a link');
  const id = await tx(async (conn) => {
    const th = await memberOf(conn, req, paramId(req), { lock: true });
    if (th.kind === 'direct') {
      const other = await one(conn, 'SELECT u.active FROM chat_members m JOIN users u ON u.tenant_id = m.tenant_id AND u.id = m.user_id WHERE m.tenant_id = ? AND m.thread_id = ? AND m.user_id <> ?', [req.auth.tenantId, th.id, req.auth.userId]);
      if (other && !other.active) throw bad('This person no longer signs in here, so they will not see new messages');
    }
    return addMessage(conn, req, th.id, text, refs);
  });
  res.status(201).json({ id });
});

router.post('/threads/:id/read', validate(z.object({ up_to: z.number().int().nonnegative() })), async (req, res) => {
  const th = await memberOf(pool, req, paramId(req));
  // Never past the newest message in the conversation, so a bad number cannot hide messages that arrive later.
  await pool.query(`UPDATE chat_members SET last_read_id = GREATEST(last_read_id, LEAST(?, (SELECT COALESCE(MAX(id), 0) FROM chat_messages WHERE tenant_id = ? AND thread_id = ?)))
    WHERE tenant_id = ? AND thread_id = ? AND user_id = ?`, [req.body.up_to, req.auth.tenantId, th.id, req.auth.tenantId, th.id, req.auth.userId]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- groups: rename, add people, leave
router.patch('/threads/:id', validate(z.object({ name: z.string().trim().max(80).nullable() })), async (req, res) => {
  await tx(async (conn) => {
    const th = await memberOf(conn, req, paramId(req), { lock: true });
    if (th.kind !== 'group') throw bad('Only a group conversation has a name');
    const rs = await review.settingsOf(conn, req.auth.tenantId);
    if (rs.thread_id && Number(rs.thread_id) === Number(th.id)) throw forbidden('This conversation belongs to the patrol review group and keeps its name');
    await conn.query('UPDATE chat_threads SET name = ? WHERE tenant_id = ? AND id = ?', [req.body.name || null, req.auth.tenantId, th.id]);
    const me = (await namesOf(conn, req.auth.tenantId, [req.auth.userId])).get(req.auth.userId);
    await addMessage(conn, req, th.id, req.body.name ? `${me ? me.name : 'Someone'} named the conversation "${req.body.name}"` : `${me ? me.name : 'Someone'} removed the conversation name`, [], { system: true });
  });
  res.json({ ok: true });
});

router.post('/threads/:id/members', validate(z.object({ user_ids: z.array(z.number().int().positive()).min(1).max(50) })), async (req, res) => {
  await tx(async (conn) => {
    const th = await memberOf(conn, req, paramId(req), { lock: true });
    if (th.kind !== 'group') throw bad('Start a group to add more people');
    const rs = await review.settingsOf(conn, req.auth.tenantId);
    if (rs.thread_id && Number(rs.thread_id) === Number(th.id)) throw forbidden('Who is in this conversation follows the patrol review group. Change the group in Patrol, Cases, Review.');
    const asked = [...new Set(req.body.user_ids)];
    const ok = await activeUsers(conn, req.auth.tenantId, asked);
    if (ok.length !== asked.length) throw bad('Someone in that list cannot receive messages');
    const current = new Set((await rows(conn, 'SELECT user_id FROM chat_members WHERE tenant_id = ? AND thread_id = ? AND left_at IS NULL', [req.auth.tenantId, th.id])).map((r) => Number(r.user_id)));
    const add = ok.filter((u) => !current.has(u));
    if (!add.length) throw bad('They are already in this conversation');
    // They see the conversation from now on, not what was said before they joined (or while they were away).
    const { top } = await one(conn, 'SELECT COALESCE(MAX(id), 0) AS top FROM chat_messages WHERE tenant_id = ? AND thread_id = ?', [req.auth.tenantId, th.id]);
    for (const u of add) {
      await conn.query(`INSERT INTO chat_members (thread_id, tenant_id, user_id, visible_from_id, last_read_id) VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE left_at = NULL, joined_at = CURRENT_TIMESTAMP, visible_from_id = VALUES(visible_from_id), last_read_id = VALUES(last_read_id)`, [th.id, req.auth.tenantId, u, top, top]);
    }
    const names = await namesOf(conn, req.auth.tenantId, [req.auth.userId, ...add]);
    await addMessage(conn, req, th.id, `${(names.get(req.auth.userId) || {}).name || 'Someone'} added ${add.map((u) => (names.get(u) || {}).name || 'someone').join(', ')}`, [], { system: true });
  });
  res.json({ ok: true });
});

router.post('/threads/:id/leave', async (req, res) => {
  await tx(async (conn) => {
    const th = await memberOf(conn, req, paramId(req), { lock: true });
    if (th.kind !== 'group') throw forbidden('A one-to-one conversation cannot be left');
    const rs = await review.settingsOf(conn, req.auth.tenantId);
    if (rs.thread_id && Number(rs.thread_id) === Number(th.id)) throw forbidden('This is the patrol review group\'s conversation. To leave it, leave the review group in Patrol, Admin, Review group.');
    await conn.query('UPDATE chat_members SET left_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND thread_id = ? AND user_id = ?', [req.auth.tenantId, th.id, req.auth.userId]);
    const me = (await namesOf(conn, req.auth.tenantId, [req.auth.userId])).get(req.auth.userId);
    await addMessage(conn, req, th.id, `${me ? me.name : 'Someone'} left the conversation`, [], { system: true });
  });
  res.json({ ok: true });
});

/** Remove one of your own messages: its words and links are wiped, a "Message removed" marker stays in its place. */
router.delete('/messages/:id', async (req, res) => {
  const id = paramId(req);
  const m = await one(pool, 'SELECT id, thread_id, user_id FROM chat_messages WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
  if (!m || Number(m.user_id) !== req.auth.userId) throw notFound('Message');
  await memberOf(pool, req, m.thread_id);
  await pool.query("UPDATE chat_messages SET body = '', refs = NULL, deleted_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ?", [req.auth.tenantId, id]);
  res.json({ ok: true });
});

/** What a set of links shows for this reader (for the preview while writing a message). */
router.post('/links', validate(z.object({ refs: z.array(ref).max(20) })), async (req, res) => {
  res.json({ data: await L.resolve(req, req.body.refs) });
});

module.exports = router;
