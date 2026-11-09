'use strict';
// Text HELP (help/sms, 2026.11.15): a guest texts the mountain's help number to reach patrol. Loaded by db/migrate.js.
// Additive and safe to run twice, on MySQL 8.4 and MariaDB, and on a 2026.11.12 or later database.
//   patrol_help_lines      one row per mountain: its Twilio help number (E.164, unique across mountains: an inbound text
//                          finds its mountain by the number it was sent to) and an optional patrol phone to call
//   dispatch_calls.source  gains 'sms' (a call that came by text)
//   dispatch_sms_threads   one per call that came by text: the guest's phone, the help number, the language, the last
//                          activity (a new text within 2 hours joins the call), texts sent, photos (Twilio media addresses,
//                          never the image) and when the closing text went out. Kept with the call.
//   dispatch_sms_optouts   phones that texted STOP to a mountain's help line (START removes the row). Never texted from it.
//   dispatch_sms_log       one row per text in or out, with no words and no phone: Twilio's message id (a text Twilio
//                          sends twice is taken once) and the hourly cap per mountain. Kept 7 days.
const sourceHasSms = async (c) => {
  const [r] = await c.query("SELECT column_type AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'dispatch_calls' AND column_name = 'source'");
  return Boolean(r[0] && /'sms'/.test(String(r[0].t)));
};

module.exports = ({ tableExists }) => [
  ['patrol_help_lines', (c) => tableExists(c, 'patrol_help_lines'), `CREATE TABLE patrol_help_lines (
    tenant_id     BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    help_number   VARCHAR(16) NOT NULL,
    patrol_phone  VARCHAR(20) NULL,
    updated_by    BIGINT UNSIGNED NULL,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_help_number (help_number),
    CONSTRAINT fk_helpline_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['dispatch_calls.source sms', sourceHasSms,
    "ALTER TABLE dispatch_calls MODIFY COLUMN source ENUM('patrol','radio','phone','guest','school','sms') NOT NULL DEFAULT 'radio'"],
  ['dispatch_sms_threads', (c) => tableExists(c, 'dispatch_sms_threads'), `CREATE TABLE dispatch_sms_threads (
    tenant_id      BIGINT UNSIGNED NOT NULL,
    call_id        BIGINT UNSIGNED NOT NULL,
    phone          VARCHAR(16) NOT NULL,
    phone_key      VARCHAR(15) NOT NULL,
    help_number    VARCHAR(16) NOT NULL,
    lang           CHAR(2) NOT NULL DEFAULT 'en',
    opened_at      DATETIME NOT NULL,
    last_at        DATETIME NOT NULL,
    out_count      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    cap_noted      TINYINT(1) NOT NULL DEFAULT 0,
    photos         TEXT NULL,
    last_push_at   DATETIME NULL,
    closed_text_at DATETIME NULL,
    PRIMARY KEY (tenant_id, call_id),
    KEY ix_smsthread_phone (tenant_id, phone_key, last_at),
    CONSTRAINT fk_smsthread_call FOREIGN KEY (tenant_id, call_id) REFERENCES dispatch_calls(tenant_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['dispatch_sms_optouts', (c) => tableExists(c, 'dispatch_sms_optouts'), `CREATE TABLE dispatch_sms_optouts (
    tenant_id     BIGINT UNSIGNED NOT NULL,
    phone_key     VARCHAR(15) NOT NULL,
    opted_out_at  DATETIME NOT NULL,
    PRIMARY KEY (tenant_id, phone_key),
    CONSTRAINT fk_smsoptout_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
  ['dispatch_sms_log', (c) => tableExists(c, 'dispatch_sms_log'), `CREATE TABLE dispatch_sms_log (
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    tenant_id    BIGINT UNSIGNED NOT NULL,
    call_id      BIGINT UNSIGNED NULL,
    direction    ENUM('in','out') NOT NULL,
    message_sid  VARCHAR(40) NULL,
    at           DATETIME NOT NULL,
    UNIQUE KEY uq_smslog_sid (message_sid),
    KEY ix_smslog_out (tenant_id, direction, at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`],
];
