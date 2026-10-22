'use strict';

// The mountain cancels a lesson: one session, or every lesson in a stretch of days (a storm). The session stays on the
// record as Cancelled with who cancelled it, when and why, and comes off the online booking page. Every booking on it is
// cancelled in the same step:
//   - a package lesson gets its credit back;
//   - a lesson paid online is refunded in full to the card, whatever the usual cancellation tiers say, because the
//     mountain cancelled (written down as owed first, then sent to Stripe after the commit, and retried if Stripe is slow);
//   - a lesson paid at the counter is listed for a refund at the desk (cash, or a card taken another way);
//   - an online request not yet paid is simply cancelled;
// and everyone booked gets one email per address. A lesson nobody ever booked can instead be deleted outright.
const { pool, tx, one, rows } = require('../db');
const { conflict, notFound } = require('./errors');
const { audit } = require('./audit');
const cardrefund = require('./cardrefund');
const mailer = require('./mailer');

const lineTotal = (i) => Number(i.unit_price_cents) * Number(i.quantity) - Number(i.discount_cents) + Number(i.tax_cents);

/** Cancels one session inside a transaction. Returns what happened, plus the refunds to send and the emails to write. */
async function cancelIn(conn, tenantId, sessionId, reason, req) {
  const s = await one(conn, `SELECT s.*, p.name AS product FROM lesson_sessions s JOIN products p ON p.id = s.product_id AND p.tenant_id = s.tenant_id
    WHERE s.tenant_id = ? AND s.id = ? FOR UPDATE`, [tenantId, sessionId]);
  if (!s) throw notFound('Lesson');
  if (s.status === 'cancelled') throw conflict('That lesson is already cancelled');
  if (s.status === 'completed') throw conflict('That lesson has already happened');
  const bookings = await rows(conn, `SELECT b.id, b.person_id, b.credit_id, b.request_id, b.unpaid, p.first_name, p.last_name, p.email
    FROM lesson_bookings b JOIN people p ON p.id = b.person_id AND p.tenant_id = b.tenant_id
    WHERE b.tenant_id = ? AND b.session_id = ? AND b.status = 'booked' FOR UPDATE`, [tenantId, s.id]);
  const out = { session_id: Number(s.id), product: s.product, starts_at: s.starts_at, bookings: bookings.length, credits_returned: 0, card_refunds: [], desk_refunds: [], unpaid_cancelled: 0, emails: new Map(), refundIds: [] };
  const name = (b) => `${b.first_name} ${b.last_name}`.trim();
  const tell = (email, who, how) => { if (!email) return; const e = String(email).trim().toLowerCase(); const cur = out.emails.get(e) || { names: [], how: new Set() }; cur.names.push(who); cur.how.add(how); out.emails.set(e, cur); };
  const doneRequests = new Set();

  for (const b of bookings) {
    let how = 'none';
    if (b.credit_id) {
      await conn.query('UPDATE lesson_credits SET used = GREATEST(used - 1, 0) WHERE tenant_id = ? AND id = ?', [tenantId, b.credit_id]);
      await conn.query('UPDATE lesson_bookings SET credit_id = NULL WHERE tenant_id = ? AND id = ?', [tenantId, b.id]);
      out.credits_returned += 1; how = 'credit';
    } else if (b.request_id) {
      const r = await one(conn, 'SELECT id, status, order_id, payment_intent, contact_email FROM lesson_requests WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, b.request_id]);
      if (r && !doneRequests.has(r.id)) {
        doneRequests.add(r.id);
        if (r.order_id && r.status === 'confirmed') {
          // Paid online: everything still unrefunded on that order goes back to the card.
          const order = await one(conn, 'SELECT id, total_cents, tax_cents, refunded_cents FROM orders WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, r.order_id]);
          const cents = Number(order.total_cents) - Number(order.refunded_cents);
          if (cents > 0) {
            const tax = Math.round((Number(order.tax_cents) * cents) / Number(order.total_cents));
            const [rf] = await conn.query("INSERT INTO order_refunds (tenant_id, order_id, user_id, reason, note, amount_cents, tax_cents, method) VALUES (?, ?, ?, 'lesson_cancelled', ?, ?, ?, 'card')",
              [tenantId, order.id, req.auth.userId || null, `Lesson cancelled by the mountain: ${reason}`.slice(0, 255), cents, tax]);
            if (r.payment_intent) await cardrefund.markPending(conn, tenantId, rf.insertId, r.payment_intent);
            await conn.query("UPDATE orders SET refunded_cents = total_cents, status = 'refunded' WHERE tenant_id = ? AND id = ?", [tenantId, order.id]);
            await conn.query('UPDATE order_items SET refunded_at = NOW(), refund_id = ? WHERE tenant_id = ? AND order_id = ? AND refunded_at IS NULL', [rf.insertId, tenantId, order.id]);
            out.refundIds.push(rf.insertId);
            out.card_refunds.push({ order_id: Number(order.id), amount_cents: cents, name: name(b) });
          }
          await conn.query("UPDATE lesson_requests SET status = 'cancelled', decided_at = NOW(), refund_cents = ? WHERE tenant_id = ? AND id = ?", [Math.max(cents, 0), tenantId, r.id]);
          how = 'card';
        } else if (['pending', 'awaiting_payment', 'confirmed'].includes(r.status)) {
          await conn.query("UPDATE lesson_requests SET status = 'cancelled', decided_at = NOW() WHERE tenant_id = ? AND id = ?", [tenantId, r.id]);
          out.unpaid_cancelled += 1; how = 'unpaid';
        }
        tell(r.contact_email, name(b), how);
      } else if (r) { how = doneRequests.has(r.id) ? 'card' : 'none'; }
    } else {
      // Bought at the counter: the desk refunds it (it may have been cash).
      const item = await one(conn, `SELECT i.order_id, i.unit_price_cents, i.quantity, i.discount_cents, i.tax_cents FROM order_items i JOIN orders o ON o.id = i.order_id AND o.tenant_id = i.tenant_id
        WHERE i.tenant_id = ? AND i.session_id = ? AND i.person_id = ? AND i.refunded_at IS NULL ORDER BY i.id DESC LIMIT 1`, [tenantId, s.id, b.person_id]);
      if (item) { out.desk_refunds.push({ order_id: Number(item.order_id), amount_cents: lineTotal(item), name: name(b) }); how = 'desk'; }
    }
    await conn.query("UPDATE lesson_bookings SET status = 'cancelled' WHERE tenant_id = ? AND id = ?", [tenantId, b.id]);
    if (!b.request_id) tell(b.email, name(b), how);
  }
  await conn.query("UPDATE lesson_sessions SET status = 'cancelled', cancel_reason = ?, cancelled_at = NOW(), cancelled_by = ? WHERE tenant_id = ? AND id = ?", [reason, req.auth.userId || null, tenantId, s.id]);
  await audit(conn, req, 'cancel', 'lesson_sessions', s.id, { reason, bookings: bookings.length, credits_returned: out.credits_returned, card_refunds: out.card_refunds.length, desk_refunds: out.desk_refunds.length });
  return out;
}

const when = (d) => new Date(String(d).replace(' ', 'T')).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const HOW = {
  credit: 'The lesson goes back on your package, ready to book again.',
  card: 'We are refunding what you paid in full to your card. It usually shows within 5 to 10 days.',
  desk: 'Please come to the ski school desk, or call us, for your refund.',
  unpaid: 'You had not paid for it yet, so there is nothing to refund.',
  none: '',
};

/** Emails everyone booked, once per address, after the commit. A failure is logged, never thrown. */
async function notify(tenantId, out, reason) {
  const t = await one(pool, 'SELECT name, phone FROM tenants WHERE id = ?', [tenantId]);
  for (const [email, info] of out.emails) {
    const lines = [...info.how].map((h) => HOW[h]).filter(Boolean);
    const text = [`Hello,`, '', `We're sorry: ${t.name} has cancelled the ${out.product} lesson on ${when(out.starts_at)}${info.names.length ? ` (booked for ${[...new Set(info.names)].join(', ')})` : ''}.`,
      reason ? `Reason: ${reason}` : null, '', ...lines, '', `To book another day, reply to this email${t.phone ? ` or call ${t.phone}` : ''}.`, '', t.name].filter((x) => x !== null).join('\n');
    await mailer.send({ tenantId, to: email, subject: `Your lesson on ${when(out.starts_at).split(',').slice(0, 2).join(',')} is cancelled`, text, tag: 'lesson-cancelled' }).catch(() => {});
  }
}

/** Cancels one lesson: the transaction, then the card refunds and the emails. */
async function cancelSession(tenantId, sessionId, reason, req) {
  const out = await tx((conn) => cancelIn(conn, tenantId, sessionId, reason, req));
  for (const id of out.refundIds) await cardrefund.send(tenantId, id);
  await notify(tenantId, out, reason);
  return summary(out);
}

const summary = (o) => ({ session_id: o.session_id, product: o.product, starts_at: o.starts_at, bookings: o.bookings, credits_returned: o.credits_returned,
  card_refunds: o.card_refunds, desk_refunds: o.desk_refunds, unpaid_cancelled: o.unpaid_cancelled, emailed: o.emails.size });

/** What cancelling would do, without doing it: for the confirm screen and the storm-day preview. */
async function preview(tenantId, where, params) {
  return rows(pool, `SELECT s.id, s.starts_at, s.ends_at, p.name AS product, s.capacity,
      (SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status = 'booked') AS booked,
      (SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status = 'booked' AND b.credit_id IS NOT NULL) AS on_package,
      (SELECT COUNT(DISTINCT b.request_id) FROM lesson_bookings b JOIN lesson_requests r ON r.id = b.request_id AND r.tenant_id = b.tenant_id
         WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status = 'booked' AND r.order_id IS NOT NULL AND r.status = 'confirmed') AS paid_online,
      (SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id) AS ever_booked
    FROM lesson_sessions s JOIN products p ON p.id = s.product_id AND p.tenant_id = s.tenant_id
    WHERE s.tenant_id = ? AND s.status = 'scheduled' AND ${where} ORDER BY s.starts_at, s.id LIMIT 300`, [tenantId, ...params]);
}

/** Deletes a lesson nobody has ever booked or asked for (one added by mistake). Anything else must be cancelled. */
async function deleteSession(tenantId, sessionId, req) {
  await tx(async (conn) => {
    const s = await one(conn, 'SELECT id, status FROM lesson_sessions WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, sessionId]);
    if (!s) throw notFound('Lesson');
    const [[b]] = await conn.query('SELECT COUNT(*) AS n FROM lesson_bookings WHERE tenant_id = ? AND session_id = ?', [tenantId, s.id]);
    const [[r]] = await conn.query('SELECT COUNT(*) AS n FROM lesson_requests WHERE tenant_id = ? AND session_id = ?', [tenantId, s.id]);
    const [[i]] = await conn.query('SELECT COUNT(*) AS n FROM order_items WHERE tenant_id = ? AND session_id = ?', [tenantId, s.id]);
    if (Number(b.n) || Number(r.n) || Number(i.n)) throw conflict('Someone has booked or asked for this lesson, so it stays on the record. Cancel it instead.');
    await conn.query('DELETE FROM lesson_sessions WHERE tenant_id = ? AND id = ?', [tenantId, s.id]);
    await audit(conn, req, 'delete', 'lesson_sessions', s.id, null);
  });
}

module.exports = { cancelSession, preview, deleteSession };
