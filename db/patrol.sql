-- Ski patrol: patient care reports and team management.
-- Applied by db/migrate.js after schema.sql. Everything is CREATE TABLE IF NOT EXISTS, so it is safe to re-run.
-- Every table carries tenant_id and every foreign key includes it, like the rest of the schema.

-- ---------------------------------------------------------------- patient care report
CREATE TABLE IF NOT EXISTS incident_patients (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id           BIGINT UNSIGNED NOT NULL,
  incident_id         BIGINT UNSIGNED NOT NULL,
  person_id           BIGINT UNSIGNED NULL,
  first_name          VARCHAR(100) NOT NULL,
  last_name           VARCHAR(100) NOT NULL,
  date_of_birth       DATE NULL,
  age_years           TINYINT UNSIGNED NULL,
  sex                 ENUM('female','male','other','unknown') NOT NULL DEFAULT 'unknown',
  phone               VARCHAR(40) NULL,
  home_town           VARCHAR(100) NULL,
  activity            ENUM('ski','snowboard','other_snow','pedestrian','staff','other') NULL,
  ability             ENUM('beginner','intermediate','advanced','expert') NULL,
  helmet              ENUM('yes','no','unknown') NOT NULL DEFAULT 'unknown',
  rental_equipment    ENUM('yes','no','unknown') NOT NULL DEFAULT 'unknown',
  chief_complaint     VARCHAR(255) NULL,
  mechanism           VARCHAR(500) NULL,
  allergies           VARCHAR(500) NULL,
  medications         VARCHAR(500) NULL,
  medical_history     VARCHAR(1000) NULL,
  last_oral_intake    VARCHAR(255) NULL,
  assessment          TEXT NULL,
  disposition         ENUM('treated_released','transported_ambulance','transported_private','refused_care','no_injury','referred','other') NULL,
  destination         VARCHAR(255) NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ipatients_tenant_id (tenant_id, id),
  KEY ix_ipatients_incident (tenant_id, incident_id),
  CONSTRAINT fk_ipatients_incident FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id),
  CONSTRAINT fk_ipatients_person FOREIGN KEY (tenant_id, person_id) REFERENCES people(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS incident_vitals (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  patient_id    BIGINT UNSIGNED NOT NULL,
  taken_at      DATETIME NOT NULL,
  pulse         SMALLINT UNSIGNED NULL,
  resp          SMALLINT UNSIGNED NULL,
  bp_sys        SMALLINT UNSIGNED NULL,
  bp_dia        SMALLINT UNSIGNED NULL,
  spo2          TINYINT UNSIGNED NULL,
  gcs           TINYINT UNSIGNED NULL,
  pain          TINYINT UNSIGNED NULL,
  avpu          ENUM('alert','verbal','pain','unresponsive') NULL,
  pupils        VARCHAR(40) NULL,
  skin          VARCHAR(60) NULL,
  temp_c        DECIMAL(4,1) NULL,
  glucose       SMALLINT UNSIGNED NULL,
  notes         VARCHAR(255) NULL,
  recorded_by   BIGINT UNSIGNED NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_ivitals_patient (tenant_id, patient_id, taken_at),
  CONSTRAINT fk_ivitals_patient FOREIGN KEY (tenant_id, patient_id) REFERENCES incident_patients(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS incident_injuries (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT UNSIGNED NOT NULL,
  patient_id   BIGINT UNSIGNED NOT NULL,
  body_region  ENUM('head','face','neck','shoulder','arm','elbow','wrist_hand','chest','back','abdomen','pelvis','hip','thigh','knee','lower_leg','ankle_foot','multiple','other') NOT NULL,
  side         ENUM('left','right','both','midline','na') NOT NULL DEFAULT 'na',
  injury_type  ENUM('fracture','dislocation','sprain_strain','laceration','contusion','concussion','spinal','internal','cold_injury','illness','cardiac','other') NOT NULL,
  notes        VARCHAR(255) NULL,
  KEY ix_iinjuries_patient (tenant_id, patient_id),
  CONSTRAINT fk_iinjuries_patient FOREIGN KEY (tenant_id, patient_id) REFERENCES incident_patients(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS incident_treatments (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id      BIGINT UNSIGNED NOT NULL,
  patient_id     BIGINT UNSIGNED NOT NULL,
  performed_at   DATETIME NOT NULL,
  kind           ENUM('splint','spinal_motion_restriction','bandage','ice','oxygen','aed','cpr','airway','medication','warming','other') NOT NULL,
  description    VARCHAR(255) NULL,
  medication     VARCHAR(100) NULL,
  dose           VARCHAR(50) NULL,
  route          VARCHAR(30) NULL,
  performed_by_staff BIGINT UNSIGNED NULL,
  recorded_by    BIGINT UNSIGNED NOT NULL,
  KEY ix_itreat_patient (tenant_id, patient_id, performed_at),
  CONSTRAINT fk_itreat_patient FOREIGN KEY (tenant_id, patient_id) REFERENCES incident_patients(tenant_id, id),
  CONSTRAINT fk_itreat_staff FOREIGN KEY (tenant_id, performed_by_staff) REFERENCES staff(tenant_id, id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- the response itself
CREATE TABLE IF NOT EXISTS incident_events (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT UNSIGNED NOT NULL,
  incident_id  BIGINT UNSIGNED NOT NULL,
  kind         ENUM('call_received','dispatched','on_scene','patient_contact','transport_started','at_aid_room','handoff','cleared','other') NOT NULL,
  at           DATETIME NOT NULL,
  note         VARCHAR(255) NULL,
  recorded_by  BIGINT UNSIGNED NOT NULL,
  KEY ix_ievents_incident (tenant_id, incident_id, at),
  CONSTRAINT fk_ievents_incident FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS incident_responders (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT UNSIGNED NOT NULL,
  incident_id  BIGINT UNSIGNED NOT NULL,
  staff_id     BIGINT UNSIGNED NOT NULL,
  role         ENUM('lead','assist','transport','dispatch') NOT NULL DEFAULT 'assist',
  UNIQUE KEY uq_iresp (tenant_id, incident_id, staff_id),
  CONSTRAINT fk_iresp_incident FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id),
  CONSTRAINT fk_iresp_staff FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS incident_witnesses (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT UNSIGNED NOT NULL,
  incident_id  BIGINT UNSIGNED NOT NULL,
  name         VARCHAR(150) NOT NULL,
  phone        VARCHAR(40) NULL,
  email        VARCHAR(255) NULL,
  statement    TEXT NULL,
  CONSTRAINT fk_iwit_incident FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id)
) ENGINE=InnoDB;

-- Signatures are small PNG data URLs drawn on the device. They are never edited or deleted once saved.
CREATE TABLE IF NOT EXISTS incident_signatures (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT UNSIGNED NOT NULL,
  incident_id  BIGINT UNSIGNED NOT NULL,
  patient_id   BIGINT UNSIGNED NULL,
  kind         ENUM('refusal_of_care','patient_acknowledgment','witness','patroller') NOT NULL,
  signer_name  VARCHAR(150) NOT NULL,
  image        MEDIUMTEXT NOT NULL,
  signed_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  recorded_by  BIGINT UNSIGNED NOT NULL,
  KEY ix_isig_incident (tenant_id, incident_id),
  CONSTRAINT fk_isig_incident FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id),
  CONSTRAINT fk_isig_patient FOREIGN KEY (tenant_id, patient_id) REFERENCES incident_patients(tenant_id, id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- patrol team
CREATE TABLE IF NOT EXISTS patrol_members (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id          BIGINT UNSIGNED NOT NULL,
  staff_id           BIGINT UNSIGNED NOT NULL,
  level              ENUM('candidate','patroller','senior','leader','director') NOT NULL DEFAULT 'patroller',
  callsign           VARCHAR(30) NULL,
  emergency_contact  VARCHAR(255) NULL,
  notes              VARCHAR(500) NULL,
  UNIQUE KEY uq_pmember (tenant_id, staff_id),
  CONSTRAINT fk_pmember_staff FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS patrol_stations (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  name       VARCHAR(100) NOT NULL,
  kind       ENUM('aid_room','hut','zone','base') NOT NULL DEFAULT 'zone',
  UNIQUE KEY uq_pstation_name (tenant_id, name),
  UNIQUE KEY uq_pstation_tenant_id (tenant_id, id),
  CONSTRAINT fk_pstation_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS patrol_deployments (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  on_date     DATE NOT NULL,
  staff_id    BIGINT UNSIGNED NOT NULL,
  station_id  BIGINT UNSIGNED NULL,
  role_label  VARCHAR(60) NULL,
  callsign    VARCHAR(30) NULL,
  UNIQUE KEY uq_pdeploy (tenant_id, on_date, staff_id),
  CONSTRAINT fk_pdeploy_staff FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id),
  CONSTRAINT fk_pdeploy_station FOREIGN KEY (tenant_id, station_id) REFERENCES patrol_stations(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS patrol_equipment (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  name        VARCHAR(100) NOT NULL,
  kind        ENUM('toboggan','aed','oxygen','trauma_bag','radio','splint_kit','other') NOT NULL DEFAULT 'other',
  station_id  BIGINT UNSIGNED NULL,
  serial      VARCHAR(60) NULL,
  status      ENUM('in_service','needs_attention','out_of_service','retired') NOT NULL DEFAULT 'in_service',
  UNIQUE KEY uq_pequip_name (tenant_id, name),
  UNIQUE KEY uq_pequip_tenant_id (tenant_id, id),
  CONSTRAINT fk_pequip_station FOREIGN KEY (tenant_id, station_id) REFERENCES patrol_stations(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS equipment_checks (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  equipment_id  BIGINT UNSIGNED NOT NULL,
  checked_by    BIGINT UNSIGNED NOT NULL,
  checked_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  result        ENUM('ok','needs_attention','out_of_service') NOT NULL,
  reading       VARCHAR(40) NULL,
  notes         VARCHAR(255) NULL,
  KEY ix_echeck_equipment (tenant_id, equipment_id, checked_at),
  CONSTRAINT fk_echeck_equipment FOREIGN KEY (tenant_id, equipment_id) REFERENCES patrol_equipment(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS training_records (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  staff_id      BIGINT UNSIGNED NOT NULL,
  kind          ENUM('oec','refresher','ride_evac','toboggan','avalanche','cpr_aed','other') NOT NULL DEFAULT 'other',
  title         VARCHAR(150) NOT NULL,
  hours         DECIMAL(5,2) NOT NULL DEFAULT 0,
  completed_on  DATE NOT NULL,
  notes         VARCHAR(255) NULL,
  recorded_by   BIGINT UNSIGNED NOT NULL,
  KEY ix_training_staff (tenant_id, staff_id, completed_on),
  CONSTRAINT fk_training_staff FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- dispatch
CREATE TABLE IF NOT EXISTS dispatch_calls (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  call_date     DATE NOT NULL,
  seq           INT UNSIGNED NOT NULL,
  source        ENUM('patrol','radio','phone','guest') NOT NULL DEFAULT 'radio',
  status        ENUM('new','dispatched','on_scene','transporting','closed','cancelled') NOT NULL DEFAULT 'new',
  priority      ENUM('low','normal','high','critical') NOT NULL DEFAULT 'normal',
  location      VARCHAR(255) NOT NULL,
  description   VARCHAR(500) NULL,
  caller_name   VARCHAR(100) NULL,
  caller_phone  VARCHAR(40) NULL,
  gps_lat       DECIMAL(9,6) NULL,
  gps_lng       DECIMAL(9,6) NULL,
  incident_id   BIGINT UNSIGNED NULL,
  received_at   DATETIME NOT NULL,
  closed_at     DATETIME NULL,
  UNIQUE KEY uq_dcall_no (tenant_id, call_date, seq),
  UNIQUE KEY uq_dcall_tenant_id (tenant_id, id),
  KEY ix_dcall_status (tenant_id, status, received_at),
  CONSTRAINT fk_dcall_incident FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS dispatch_events (
  id        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  call_id   BIGINT UNSIGNED NOT NULL,
  at        DATETIME NOT NULL,
  kind      ENUM('received','dispatched','on_scene','transporting','at_aid_room','note','closed','cancelled') NOT NULL,
  staff_id  BIGINT UNSIGNED NULL,
  note      VARCHAR(500) NULL,
  user_id   BIGINT UNSIGNED NULL,
  KEY ix_devent_call (tenant_id, call_id, at, id),
  CONSTRAINT fk_devent_call FOREIGN KEY (tenant_id, call_id) REFERENCES dispatch_calls(tenant_id, id),
  CONSTRAINT fk_devent_staff FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS dispatch_responders (
  id        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT UNSIGNED NOT NULL,
  call_id   BIGINT UNSIGNED NOT NULL,
  staff_id  BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY uq_dresp (tenant_id, call_id, staff_id),
  CONSTRAINT fk_dresp_call FOREIGN KEY (tenant_id, call_id) REFERENCES dispatch_calls(tenant_id, id),
  CONSTRAINT fk_dresp_staff FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- training passport
CREATE TABLE IF NOT EXISTS patrol_competencies (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT UNSIGNED NOT NULL,
  name         VARCHAR(120) NOT NULL,
  category     VARCHAR(60) NULL,
  description  VARCHAR(500) NULL,
  valid_months SMALLINT UNSIGNED NULL,
  active       TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_pcomp_name (tenant_id, name),
  UNIQUE KEY uq_pcomp_tenant_id (tenant_id, id),
  CONSTRAINT fk_pcomp_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS patrol_signoffs (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id      BIGINT UNSIGNED NOT NULL,
  staff_id       BIGINT UNSIGNED NOT NULL,
  competency_id  BIGINT UNSIGNED NOT NULL,
  status         ENUM('in_progress','signed_off') NOT NULL DEFAULT 'in_progress',
  signed_on      DATE NULL,
  expires_on     DATE NULL,
  signed_by      BIGINT UNSIGNED NULL,
  notes          VARCHAR(255) NULL,
  UNIQUE KEY uq_psignoff (tenant_id, staff_id, competency_id),
  CONSTRAINT fk_psignoff_staff FOREIGN KEY (tenant_id, staff_id) REFERENCES staff(tenant_id, id),
  CONSTRAINT fk_psignoff_comp FOREIGN KEY (tenant_id, competency_id) REFERENCES patrol_competencies(tenant_id, id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- incident form settings (NSAAR)
-- One row per field a mountain's patrol administrator has made mandatory (or explicitly not mandatory).
CREATE TABLE IF NOT EXISTS patrol_form_config (
  tenant_id  BIGINT UNSIGNED NOT NULL,
  scope      ENUM('case','patient') NOT NULL,
  field_key  VARCHAR(40) NOT NULL,
  required   TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, scope, field_key),
  CONSTRAINT fk_pform_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- collision report
-- One row per collision case, plus one row per person (or unidentified party) involved.
CREATE TABLE IF NOT EXISTS incident_collisions (
  id                        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id                 BIGINT UNSIGNED NOT NULL,
  incident_id               BIGINT UNSIGNED NOT NULL,
  collision_type            ENUM('skier_skier','skier_object','skier_lift_structure','skier_vehicle','skier_animal','other') NOT NULL DEFAULT 'skier_skier',
  hit_and_run               TINYINT(1) NOT NULL DEFAULT 0,
  unknown_party_description VARCHAR(1000) NULL,
  right_of_way              VARCHAR(1000) NULL,
  factors                   VARCHAR(1000) NULL,
  police_notified           TINYINT(1) NOT NULL DEFAULT 0,
  police_agency             VARCHAR(150) NULL,
  police_report_no          VARCHAR(60) NULL,
  risk_notified             TINYINT(1) NOT NULL DEFAULT 0,
  equipment_held            VARCHAR(500) NULL,
  property_damage           VARCHAR(1000) NULL,
  findings                  TEXT NULL,
  legal_hold                TINYINT(1) NOT NULL DEFAULT 0,
  updated_at                TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_icollision_incident (tenant_id, incident_id),
  CONSTRAINT fk_icollision_incident FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS incident_parties (
  id                   BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id            BIGINT UNSIGNED NOT NULL,
  incident_id          BIGINT UNSIGNED NOT NULL,
  patient_id           BIGINT UNSIGNED NULL,
  role                 ENUM('skier','snowboarder','other_snow','pedestrian','employee','vehicle','unknown') NOT NULL DEFAULT 'skier',
  first_name           VARCHAR(100) NULL,
  last_name            VARCHAR(100) NULL,
  age_years            TINYINT UNSIGNED NULL,
  phone                VARCHAR(40) NULL,
  email                VARCHAR(255) NULL,
  address              VARCHAR(255) NULL,
  helmet               ENUM('yes','no','unknown') NOT NULL DEFAULT 'unknown',
  equipment            VARCHAR(255) NULL,
  direction            VARCHAR(255) NULL,
  position             ENUM('uphill','downhill','side_by_side','crossing','stopped','unknown') NOT NULL DEFAULT 'unknown',
  speed                ENUM('stopped','slow','moderate','fast','unknown') NOT NULL DEFAULT 'unknown',
  statement            TEXT NULL,
  left_scene           TINYINT(1) NOT NULL DEFAULT 0,
  refused_contact_info TINYINT(1) NOT NULL DEFAULT 0,
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_iparties_incident (tenant_id, incident_id),
  CONSTRAINT fk_iparties_incident FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id),
  CONSTRAINT fk_iparties_patient FOREIGN KEY (tenant_id, patient_id) REFERENCES incident_patients(tenant_id, id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- checklists (patient_id 0 means the whole case)
CREATE TABLE IF NOT EXISTS incident_checklist (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  incident_id BIGINT UNSIGNED NOT NULL,
  patient_id  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  item_key    VARCHAR(60) NOT NULL,
  done_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  done_by     BIGINT UNSIGNED NOT NULL,
  UNIQUE KEY uq_ichecklist (tenant_id, incident_id, patient_id, item_key),
  CONSTRAINT fk_ichecklist_incident FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- follow-up emails, feedback, donations
CREATE TABLE IF NOT EXISTS followups (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id    BIGINT UNSIGNED NOT NULL,
  incident_id  BIGINT UNSIGNED NOT NULL,
  patient_id   BIGINT UNSIGNED NOT NULL,
  to_email     VARCHAR(255) NOT NULL,
  for_guardian TINYINT(1) NOT NULL DEFAULT 0,
  due_on       DATE NOT NULL,
  status       ENUM('held','queued','sent','skipped','failed','unsubscribed') NOT NULL,
  hold_reason  VARCHAR(100) NULL,
  token        CHAR(32) NOT NULL,
  sent_at      DATETIME NULL,
  error        VARCHAR(255) NULL,
  rating       TINYINT UNSIGNED NULL,
  comment      TEXT NULL,
  responded_at DATETIME NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_followups_patient (tenant_id, patient_id),
  UNIQUE KEY uq_followups_token (token),
  KEY ix_followups_status (tenant_id, status, due_on),
  CONSTRAINT fk_followups_incident FOREIGN KEY (tenant_id, incident_id) REFERENCES incidents(tenant_id, id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS email_suppressions (
  tenant_id  BIGINT UNSIGNED NOT NULL,
  email      VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, email)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS donations (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id         BIGINT UNSIGNED NOT NULL,
  amount_cents      INT UNSIGNED NOT NULL,
  monthly           TINYINT(1) NOT NULL DEFAULT 0,
  email             VARCHAR(255) NULL,
  name              VARCHAR(150) NULL,
  followup_id       BIGINT UNSIGNED NULL,
  stripe_session_id VARCHAR(100) NOT NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_donations_session (stripe_session_id),
  KEY ix_donations_tenant (tenant_id, created_at)
) ENGINE=InnoDB;

-- Patrol access: which features each access level has, as changed by a patrol administrator.
-- A level/feature with no row here follows the built-in default (see src/lib/patrolaccess.js).
CREATE TABLE IF NOT EXISTS patrol_access_rules (
  tenant_id BIGINT UNSIGNED NOT NULL,
  level     ENUM('admin','manager','approver','patrol','host') NOT NULL,
  feature   VARCHAR(40) NOT NULL,
  allowed   TINYINT(1) NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, level, feature),
  CONSTRAINT fk_par_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;
