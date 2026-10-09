-- Document repository: categories, which roles can see or add to each one, and the documents themselves.
-- Applied by db/migrate.js. Everything is CREATE TABLE IF NOT EXISTS, so it is safe to re-run.

CREATE TABLE IF NOT EXISTS doc_categories (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  name        VARCHAR(100) NOT NULL,
  description VARCHAR(255) NULL,
  sort_order  INT NOT NULL DEFAULT 100,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_doc_cat_name (tenant_id, name),
  UNIQUE KEY uq_doc_cat_tenant_id (tenant_id, id),
  CONSTRAINT fk_doc_cat_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- One row per role that may use a category. can_add lets that role upload and remove documents there. Managers and
-- owners always have full access, so they are never listed.
CREATE TABLE IF NOT EXISTS doc_category_roles (
  tenant_id   BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  role        ENUM('staff','patrol','instructor','counter') NOT NULL,
  can_add     TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, category_id, role),
  CONSTRAINT fk_doc_role_cat FOREIGN KEY (tenant_id, category_id) REFERENCES doc_categories(tenant_id, id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS documents (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  title       VARCHAR(150) NOT NULL,
  description VARCHAR(500) NULL,
  link_url    VARCHAR(500) NULL,
  file_name   VARCHAR(200) NULL,
  mime_type   VARCHAR(100) NULL,
  size_bytes  INT UNSIGNED NULL,
  version     INT UNSIGNED NOT NULL DEFAULT 1,
  uploaded_by BIGINT UNSIGNED NULL,
  uploader    VARCHAR(120) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_doc_tenant_id (tenant_id, id),
  KEY ix_doc_cat (tenant_id, category_id),
  CONSTRAINT fk_doc_cat FOREIGN KEY (tenant_id, category_id) REFERENCES doc_categories(tenant_id, id)
) ENGINE=InnoDB;

-- File bytes live apart from the list so browsing documents never loads them.
CREATE TABLE IF NOT EXISTS document_files (
  tenant_id   BIGINT UNSIGNED NOT NULL,
  document_id BIGINT UNSIGNED NOT NULL,
  content     MEDIUMBLOB NOT NULL,
  PRIMARY KEY (tenant_id, document_id),
  CONSTRAINT fk_doc_file FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Every earlier version of a document's file (the current one stays in document_files). A document keeps at most 10 versions.
CREATE TABLE IF NOT EXISTS document_versions (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  document_id BIGINT UNSIGNED NOT NULL,
  version     INT UNSIGNED NOT NULL,
  file_name   VARCHAR(200) NOT NULL,
  mime_type   VARCHAR(100) NOT NULL,
  size_bytes  INT UNSIGNED NOT NULL,
  note        VARCHAR(200) NULL,
  uploaded_by BIGINT UNSIGNED NULL,
  uploader    VARCHAR(120) NULL,
  uploaded_at TIMESTAMP NULL,
  content     MEDIUMBLOB NOT NULL,
  UNIQUE KEY uq_doc_version (tenant_id, document_id, version),
  CONSTRAINT fk_doc_ver FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- The words inside the current file, so documents can be found by what they say. Filled when a file is added or replaced.
CREATE TABLE IF NOT EXISTS document_text (
  tenant_id   BIGINT UNSIGNED NOT NULL,
  document_id BIGINT UNSIGNED NOT NULL,
  content     MEDIUMTEXT NOT NULL,
  PRIMARY KEY (tenant_id, document_id),
  CONSTRAINT fk_doc_text FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- "Read and accepted": who accepted which version of a document. A new version needs everyone to accept again.
CREATE TABLE IF NOT EXISTS document_acks (
  tenant_id   BIGINT UNSIGNED NOT NULL,
  document_id BIGINT UNSIGNED NOT NULL,
  version     INT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  who         VARCHAR(120) NULL,
  accepted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, document_id, version, user_id),
  CONSTRAINT fk_doc_ack FOREIGN KEY (tenant_id, document_id) REFERENCES documents(tenant_id, id) ON DELETE CASCADE
) ENGINE=InnoDB;
