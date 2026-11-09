'use strict';
// AI release 1 (branch ai/actions): prepared actions and the conditions writer. Loaded by db/migrate.js. Additive and
// safe to run twice, on MySQL 8.4 and MariaDB, and on a 2026.11.13 database.
//   ai_proposals                  something the assistant prepared that waits for a person to approve it (lib/proposals.js)
//   conditions_writer_settings    when the morning conditions draft is made, and the mountain's own past reports as style examples
//   billing_plans assistant-plus  shown as "AI Operations" with a blurb that lists what it includes (prices unchanged)
const NAME = 'AI Operations';
const BLURB = 'Questions about your own numbers, the guest assistant, the morning conditions writer, and weather-day plans as they arrive. The assistant drafts; a person approves.';
const OLD_BLURB = 'Ask about your own numbers (sales, rosters, lessons, who is on), and an assistant for guests on your online pages.';

module.exports = ({ tableExists }) => [
  ['ai_proposals', (c) => tableExists(c, 'ai_proposals'), `CREATE TABLE ai_proposals (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    tenant_id   BIGINT UNSIGNED NOT NULL,
    kind        VARCHAR(40) NOT NULL,
    title       VARCHAR(200) NOT NULL,
    summary     VARCHAR(500) NULL,
    preview     MEDIUMTEXT NULL,
    payload     MEDIUMTEXT NULL,
    for_roles   VARCHAR(200) NOT NULL,
    status      ENUM('pending','approved','rejected','expired','failed') NOT NULL DEFAULT 'pending',
    source      VARCHAR(40) NOT NULL DEFAULT 'assistant',
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at  DATETIME NULL,
    decided_by  BIGINT UNSIGNED NULL,
    decided_at  DATETIME NULL,
    edits       MEDIUMTEXT NULL,
    result      TEXT NULL,
    error       VARCHAR(500) NULL,
    KEY ix_aiprop_open (tenant_id, status, created_at),
    KEY ix_aiprop_kind (tenant_id, kind, created_at),
    CONSTRAINT fk_aiprop_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  )`],
  ['conditions_writer_settings', (c) => tableExists(c, 'conditions_writer_settings'), `CREATE TABLE conditions_writer_settings (
    tenant_id        BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    auto_on          TINYINT(1) NOT NULL DEFAULT 1,
    draft_at         TIME NOT NULL DEFAULT '07:00:00',
    voice            MEDIUMTEXT NULL,
    last_drafted_on  DATE NULL,
    updated_by       BIGINT UNSIGNED NULL,
    updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_cwset_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  )`],
  // The add-on keeps its code and prices; only its name and line change, and only while they are the launch wording.
  ['billing_plans assistant-plus is AI Operations', async (c) => {
    if (!(await tableExists(c, 'billing_plans'))) return true;
    const [r] = await c.query("SELECT COUNT(*) AS n FROM billing_plans WHERE code = 'assistant-plus' AND name = 'Assistant Plus'");
    return !Number(r[0].n);
  }, `UPDATE billing_plans SET name = '${NAME}', blurb = IF(blurb = '${OLD_BLURB}' OR blurb IS NULL OR blurb = '', '${BLURB}', blurb) WHERE code = 'assistant-plus' AND name = 'Assistant Plus'`],
];
