# Patient information: safeguards and what is still on you

Verdynt/OS can be built and run so that patient information is protected the way HIPAA expects. Software alone cannot make a
mountain "HIPAA compliant": compliance is also about contracts, policies, training and how people behave. This file lists
what the software does, and what the mountain still has to do.

**First, find out whether HIPAA applies to you.** HIPAA covers "covered entities" (for example, providers that bill
health insurers electronically) and their business associates. Many ski patrols are not covered entities, but some are
(a patrol that bills insurance or runs a clinic, for instance), and state privacy and medical-records laws can apply either
way. Ask your lawyer. Verdynt/OS is built to the stricter standard regardless.

## What the software does (technical safeguards)

| Requirement | How it is met |
| --- | --- |
| Access control, minimum necessary | Patient care reports are readable only by patrol, managers and the owner. Patrol searches the customer list one guest at a time (name, phone or email, at least two characters); there is no browsable customer list for patrol. Patrol searching the list never sees address, emergency contact, marketing consent, notes, or what a guest paid. When a guest is pulled into a patient record, the address, height and weight the incident form asks for are copied in (and the pull is logged); the emergency contact, email, marketing consent, notes and payments still never reach patrol. |
| Unique user identification | Every login is one person; there is no shared account. Deactivating a login or changing a role or password takes effect on the next request. |
| Audit controls | Opening a case, changing it, adding or removing a patient, signatures, exports, map views, guest searches, and pulls from customer records are all written to the audit log with the user and time. The log records that a search happened, never what was typed. Patrol administrators read it under Patrol, **Access log**; reading the log is itself logged. The app has no way to edit or delete log rows. |
| Automatic logoff | The screen signs out after 15 minutes without activity, and the sign-in itself lasts 8 hours (`JWT_TTL` to change). The sign-in token lives in the browser tab only, so closing the tab ends it. |
| Integrity | Clinical entries are never deleted: a wrong one is marked entered in error with a reason, by a named user, and stays on the record. Each submitted and approved report is kept as a frozen version, and opening a version is logged. Approved reports are locked. Reopening needs a manager and is logged. |
| Transmission security | Cloud Run serves HTTPS only; the app sends HSTS and a strict content policy. The database connection uses TLS (`DB_CA`). |
| No copies left behind | Every API response is sent `Cache-Control: no-store`. Server error logs record where something failed, never the request or the SQL (which could carry patient details). |
| Limited exports | Only managers can export. The case export carries no names and no free text. |
| Separation between mountains | Every query is scoped to the mountain in the signed-in token. This is tested. |

**One-way pull.** Patrol can pull a guest's ticket and the gear they had rented that day into a patient record. The pull only
reads. It does not change the customer, ticket or rental records, and nothing a patroller records flows back to them (a test
checks the rows are identical before and after). Pulling is logged.

## What you still have to do (administrative and physical safeguards)

1. **Decide whether you are a covered entity**, and write down the answer.
2. **Business associate agreements (BAAs).** If HIPAA applies, you need a signed BAA with each vendor that stores patient
   data: Google Cloud (Cloud Run, Cloud SQL, Secret Manager, logging). Google offers a BAA, and you must confirm the services you use are on its covered list. Do this before real patient data goes in.
3. **Risk analysis.** HIPAA requires a written assessment of risks to patient data, repeated when things change.
4. **Policies and training.** Who may see what, what to do when a phone is lost, how to report a problem. Train every
   patroller, and review the Access log regularly (monthly is common).
5. **Breach plan.** Know who you tell, and how fast, if patient information is exposed.
6. **Retention.** HIPAA documentation (including the audit log) is generally kept six years; medical-record retention is set by
   your state. The app never deletes either on its own. Decide your schedule.
7. **Backups and recovery.** Cloud SQL backups are on; test a restore. Keep backups under the same BAA.
8. **Devices.** Phones and Chromebooks that open patient reports need screen locks and, ideally, device management.
9. **People.** Remove a patroller's login the day they leave. Give the owner and manager logins only to people who need them.
10. **Rotate secrets** (database password, `JWT_SECRET`) and keep them in Secret Manager.

## Known gaps (worth knowing)

- Data is encrypted in transit and the database host encrypts disks, but the app does not add its own field-level encryption.
- Free-text fields (case summary, notes, treatment descriptions) can contain anything a patroller types, including names.
  They are protected the same way as the rest of the case, and kept out of exports.
- The audit log lives in the same database. For stronger tamper-resistance, ship it to a separate write-once store.
- The rate limiter and the idle sign-out are simple; they are not a substitute for device security.
- **Offline entries sit on the phone.** With no signal, bedside entries (vitals, treatments, injuries, time stamps,
  assessment answers) are kept in the browser's storage on that phone until they send. They carry case and patient numbers and
  clinical values, not names, and are removed as soon as they send, or after three days. Treat a lost phone with unsent
  entries as a possible exposure, and keep screen locks on.
- Patrol dispatch calls and the guest help page are not part of the patient record and have their own, lighter rules.
