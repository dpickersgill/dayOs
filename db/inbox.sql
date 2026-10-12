-- Inbox: messages between the people who sign in at one mountain. Applied by db/migrate.js; safe to re-run.
-- A message can carry links to records in the app (a patrol case, a customer, an order...). Links are stored as
-- type and id only; what a link shows is worked out for each reader, from what that reader is allowed to open.

CREATE TABLE IF NOT EXISTS chat_threads (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id        BIGINT UNSIGNED NOT NULL,
  kind             ENUM('direct','group') NOT NULL,
  name             VARCHAR(80) NULL,
  direct_key       VARCHAR(45) NULL,            -- 'smaller user id:larger user id', so two people have one direct conversation
  created_by       BIGINT UNSIGNED NOT NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_message_at  DATETIME NULL,
  UNIQUE KEY uq_chat_direct (tenant_id, direct_key),
  UNIQUE KEY uq_chat_threads_tenant_id (tenant_id, id),
  KEY ix_chat_threads_last (tenant_id, last_message_at),
  CONSTRAINT fk_chat_threads_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS chat_members (
  thread_id        BIGINT UNSIGNED NOT NULL,
  tenant_id        BIGINT UNSIGNED NOT NULL,
  user_id          BIGINT UNSIGNED NOT NULL,
  joined_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_read_id     BIGINT UNSIGNED NOT NULL DEFAULT 0,
  visible_from_id  BIGINT UNSIGNED NOT NULL DEFAULT 0,  -- someone added to a group (or added back) sees messages from then on, not before
  left_at          DATETIME NULL,
  PRIMARY KEY (thread_id, user_id),
  KEY ix_chat_members_user (tenant_id, user_id),
  CONSTRAINT fk_chat_members_thread FOREIGN KEY (tenant_id, thread_id) REFERENCES chat_threads(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS chat_messages (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id        BIGINT UNSIGNED NOT NULL,
  thread_id        BIGINT UNSIGNED NOT NULL,
  user_id          BIGINT UNSIGNED NULL,          -- null for a note the system adds (someone joined or left)
  body             TEXT NOT NULL,
  refs             VARCHAR(1000) NULL,            -- JSON list of { type, id }
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at       DATETIME NULL,
  KEY ix_chat_messages_thread (tenant_id, thread_id, id),
  CONSTRAINT fk_chat_messages_thread FOREIGN KEY (tenant_id, thread_id) REFERENCES chat_threads(tenant_id, id)
) ENGINE=InnoDB;
