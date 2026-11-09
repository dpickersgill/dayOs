'use strict';
// The guest side of asking ski patrol for help (help/guest, Nov 9): a one-button request, tap answers, a status page with
// messages both ways, live location while the page is open, and an optional pass hint. Loaded by db/migrate.js.
// Each entry: [name, (conn) => done?, ddl]. Safe to run twice and on a 2026.11.12 database.
//
//   dispatch_calls.guest_token ...   the guest's status page key, the sign or place, the tap answers, who needs help, the
//                                    page language, the pass hint (only with consent), the request key for retries, and
//                                    whether the guest turned live location off
//   dispatch_messages                messages between dispatch and the guest (page or text), help/sms writes through lib/guestmsg.js
//   dispatch_positions               the last 10 positions the guest's phone sent while the page was open (kept with the call)
//   tenants.guest_help_phone/_sms    the patrol phone guests may call, and the number guests may text for help
module.exports = ({ columnExists, tableExists }) => [
  ['dispatch_calls.guest_token', (c) => columnExists(c, 'dispatch_calls', 'guest_token'), `ALTER TABLE dispatch_calls
    ADD COLUMN guest_token CHAR(32) NULL,
    ADD COLUMN place_id BIGINT UNSIGNED NULL,
    ADD COLUMN place_text VARCHAR(255) NULL,
    ADD COLUMN answers TEXT NULL,
    ADD COLUMN who ENUM('me','someone_with_me','someone_i_saw') NULL,
    ADD COLUMN lang VARCHAR(5) NULL,
    ADD COLUMN last_scan_hint VARCHAR(255) NULL,
    ADD COLUMN request_key CHAR(32) NULL,
    ADD COLUMN live_off_at DATETIME NULL,
    ADD UNIQUE KEY uq_dcall_guest_token (guest_token),
    ADD KEY ix_dcall_request_key (tenant_id, request_key)`],

  ['dispatch_messages', (c) => tableExists(c, 'dispatch_messages'), `CREATE TABLE dispatch_messages (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id  BIGINT UNSIGNED NOT NULL,
    call_id    BIGINT UNSIGNED NOT NULL,
    direction  ENUM('to_guest','from_guest') NOT NULL,
    channel    ENUM('page','sms') NOT NULL DEFAULT 'page',
    body       VARCHAR(1000) NOT NULL,
    sent_by    BIGINT UNSIGNED NULL,
    at         DATETIME NOT NULL,
    delivered  DATETIME NULL,
    KEY ix_dmsg_call (tenant_id, call_id, id),
    CONSTRAINT fk_dmsg_call FOREIGN KEY (tenant_id, call_id) REFERENCES dispatch_calls(tenant_id, id)
  ) ENGINE=InnoDB`],

  ['dispatch_positions', (c) => tableExists(c, 'dispatch_positions'), `CREATE TABLE dispatch_positions (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    call_id     BIGINT UNSIGNED NOT NULL,
    lat         DECIMAL(9,6) NOT NULL,
    lng         DECIMAL(9,6) NOT NULL,
    accuracy_m  INT UNSIGNED NULL,
    taken_at    DATETIME NOT NULL,
    received_at DATETIME NOT NULL,
    KEY ix_dpos_call (tenant_id, call_id, id),
    CONSTRAINT fk_dpos_call FOREIGN KEY (tenant_id, call_id) REFERENCES dispatch_calls(tenant_id, id)
  ) ENGINE=InnoDB`],

  ['tenants.guest_help_phone', (c) => columnExists(c, 'tenants', 'guest_help_phone'),
    'ALTER TABLE tenants ADD COLUMN guest_help_phone VARCHAR(30) NULL, ADD COLUMN guest_help_sms VARCHAR(30) NULL'],
];
