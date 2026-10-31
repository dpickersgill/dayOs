# Privacy backlog (not built)

Items the 2026.11.11 privacy review left for later, so they are written down rather than forgotten.

## Field-level encryption of health data (review DP-14)
Health details are encrypted at rest by Cloud SQL and in transit by TLS, not field by field. Anyone with database or
backup access reads them. Plan: envelope encryption with a Cloud KMS key per mountain for these columns:
- incident_patients: allergies, medications, medical_history, assessment, chief_complaint
- incident_media: original, thumbnails
- lesson_bookings and program_enrollments: allergies, medical, pickup
- waiver_signings.signer_dob; staff_injuries (the whole record)
Searching, exports and the patrol pull need decrypt paths; the weekly SQL copy then carries ciphertext only.

## Search terms in request logs
Customer search sends the name or phone in the address (GET /people?q=). Cloud Run's request log keeps the full address
for 30 days (the privacy page says so). Plan: move searches to POST, or a log sink exclusion that drops query strings.

## The assistant and patrol logins
Questions typed into the assistant go to Anthropic and stay in assistant_log for 13 months. Plan: filter obvious names and
health words from questions asked by patrol logins, or turn the assistant off for patrol logins by default.
