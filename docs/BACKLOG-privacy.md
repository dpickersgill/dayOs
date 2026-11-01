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
for 30 days (the privacy page says so). Plan: move searches to POST (about eight screens across tracks, so not in
2026.11.11). Until then, Dan can drop the search requests from the request log with one exclusion (run once in Cloud Shell;
errors are still logged by the app itself):

    gcloud logging sinks update _Default --add-exclusion=name=no-search-terms,description="Customer and patient search terms",filter='log_id("run.googleapis.com/requests") AND httpRequest.requestUrl=~"[?&]q="'

## The assistant and patrol logins
Done in 2026.11.11: a patrol login's question loses email addresses, phone numbers, dates, ages and capitalized name
pairs (src/lib/patrolscrub.js) before it goes to Anthropic or assistant_log, and assistant_log is deleted after 13 months.
Left: a single first name ("is Jane's form done") is not caught. A better filter would match the question against the
names of the mountain's own patients from the last few days.
