'use strict';
// 2026.11.11 privacy fixes. Loaded by db/migrate.js. Additive and safe to run twice.
//   deletion_ledger         every anonymise and mountain deletion, so they can be applied again after a restore (db/deletions.js)
//   goodday_consent_events  The Good Day's consent history: every subscribe, confirm and unsubscribe, never edited
//   sms_held                marketing texts waiting for 8 AM at the mountain (quiet hours), sent by the 5-minute job
//   campaigns.held, message_log 'held'   texts of a campaign that wait for 8 AM
const enumHas = async (c, table, column, value) => {
  const [[r]] = await c.query('SELECT column_type AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, column]);
  return Boolean(r && String(r.t || r.COLUMN_TYPE).includes(`'${value}'`));
};
module.exports = ({ tableExists, columnExists }) => [
  // No foreign key to tenants: a deleted mountain's row in the ledger must outlive the mountain.
  ['deletion_ledger', (c) => tableExists(c, 'deletion_ledger'), `CREATE TABLE deletion_ledger (
    id        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id BIGINT UNSIGNED NOT NULL,
    kind      ENUM('anonymise','mountain') NOT NULL,
    ref_id    BIGINT UNSIGNED NOT NULL,
    done_by   VARCHAR(100) NULL,
    done_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_deletion_ledger_time (done_at, id),
    KEY ix_deletion_ledger_ref (tenant_id, kind, ref_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['goodday_consent_events', (c) => tableExists(c, 'goodday_consent_events'), `CREATE TABLE goodday_consent_events (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    email      VARCHAR(255) NOT NULL,
    event      ENUM('subscribe','confirm','unsubscribe','erase') NOT NULL,
    wording    VARCHAR(500) NULL,
    source     VARCHAR(40) NULL,
    how        VARCHAR(40) NULL,
    ip         VARCHAR(64) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_goodday_consent_email (email, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  // The history so far, from what each subscriber row says today (once, when the table is new and empty).
  ['goodday_consent_events backfill', async (c) => {
    if (!(await tableExists(c, 'goodday_subscribers'))) return true;
    const [[r]] = await c.query('SELECT (SELECT COUNT(*) FROM goodday_consent_events) AS e, (SELECT COUNT(*) FROM goodday_subscribers) AS s');
    return Number(r.e) > 0 || Number(r.s) === 0;
  }, [
    `INSERT INTO goodday_consent_events (email, event, wording, source, ip, created_at)
       SELECT email, 'subscribe', consent_wording, source, consent_ip, COALESCE(consent_at, created_at) FROM goodday_subscribers WHERE consent_at IS NOT NULL OR status <> 'unsubscribed'`,
    `INSERT INTO goodday_consent_events (email, event, ip, created_at)
       SELECT email, 'confirm', confirmed_ip, confirmed_at FROM goodday_subscribers WHERE confirmed_at IS NOT NULL`,
    `INSERT INTO goodday_consent_events (email, event, how, created_at)
       SELECT email, 'unsubscribe', unsubscribe_how, unsubscribed_at FROM goodday_subscribers WHERE unsubscribed_at IS NOT NULL`,
  ]],
  // An unsubscribed reader keeps only the address and the consent history (the name and role are not needed any more).
  ['goodday_subscribers unsubscribed: no name or role', async (c) => {
    if (!(await tableExists(c, 'goodday_subscribers'))) return true;
    const [[r]] = await c.query("SELECT COUNT(*) AS n FROM goodday_subscribers WHERE status = 'unsubscribed' AND (name IS NOT NULL OR role <> 'other')");
    return Number(r.n) === 0;
  }, "UPDATE goodday_subscribers SET name = NULL, role = 'other' WHERE status = 'unsubscribed' AND (name IS NOT NULL OR role <> 'other')"],
  ['sms_held', (c) => tableExists(c, 'sms_held'), `CREATE TABLE sms_held (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    phone_key   CHAR(10) NOT NULL,
    body        VARCHAR(700) NOT NULL,
    tag         VARCHAR(40) NULL,
    log_id      BIGINT UNSIGNED NULL,
    send_after  DATETIME NOT NULL,
    status      ENUM('held','sending','sent','dropped','failed') NOT NULL DEFAULT 'held',
    note        VARCHAR(200) NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_sms_held_due (status, send_after),
    CONSTRAINT fk_sms_held_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['campaigns.held', (c) => columnExists(c, 'campaigns', 'held'), 'ALTER TABLE campaigns ADD COLUMN held INT UNSIGNED NOT NULL DEFAULT 0'],
  ["message_log.status 'held'", (c) => enumHas(c, 'message_log', 'status', 'held'), "ALTER TABLE message_log MODIFY status ENUM('sent','failed','held') NOT NULL"],
];
