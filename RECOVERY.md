# Recovery plan

What to do when Verdynt/OS breaks, how much can be lost, and how to practice. Written for 2026.11.10 ("ready for the
busiest morning"). Keep a printed copy with your phone numbers on it: if Google Cloud is the problem, this file in the
release folder may be out of reach.

## The targets

| | Target | How |
|---|---|---|
| Back up and working (time to recover) | **1 hour** from the first alert | The steps below. A bad release: 5 minutes (switch back). A database restore: 20 to 45 minutes. |
| Data lost at most (recovery point) | **5 minutes** | Point-in-time recovery: the database can go back to any minute of the last 7 days. |
| A whole Google Cloud zone lost | 1 hour, up to 24 hours of data without high availability | Restore the last daily backup into a new server. With high availability (`bash scripts/backups-setup.sh --ha`, about twice the database cost) a standby takes over in about a minute and nothing is lost. |
| The database server deleted | 1 to 2 hours, up to 7 days of data | The weekly copy in Cloud Storage. Deletion protection is on, so this takes a deliberate act. |

## What is backed up

Check it any time with `bash scripts/backups-setup.sh` (it turns on whatever is missing and says what it changed).

- **Daily backups** of the database server (`summitops-db`) at 07:00 UTC, 14 kept. Both the live database
  (`summitops`) and staging's (`summitops_staging`) are on that server.
- **Point-in-time recovery**: the database's change log (binary log) is kept 7 days, so a copy can be made as it was at
  any moment in that week.
- **A weekly copy outside the server**: every Tuesday at 08:00 UTC, the live database is written to
  `gs://summitops-510715-backups/weekly/summitops.sql.gz`; older weekly copies are kept a year. Automated backups go
  away if the server itself is deleted; this copy does not.
- **Deletion protection** on the server.
- **What is not in the database**: the code (every release zip, and git), and the secrets (Secret Manager keeps every
  version). Uploaded documents, photos and signatures are stored in the database, so they are in every backup.
- **Each mountain's own copy**: owners and managers can download their records as spreadsheets at any time (customers,
  sales, payments, refunds, signed waivers, incident reports). The automated tests check these still work every release.

## Who to tell

1. **Mountains**: the console's **Status page** (Report an incident). It shows on the public status page
   (`/status` on the website) within a minute. Say what people notice and when you will update it. Update it at least
   every 30 minutes, and Mark over when it is fixed.
2. **Mountains you know are open that day**: a call or text to the owner or GM. The guests in front of them matter more
   than a status page.
3. **If guest or patient information may have been seen by someone who should not see it**: that is a security
   incident, not only an outage. Follow RUNBOOK.md (security) and HIPAA.md; the clock for telling people starts then.

## First five minutes

1. Look: `curl -s https://app.runmyresort.com/readyz` (or the run.app address) and the public status page.
2. Did a release go out in the last day? Then switch back first and ask questions later (Rolling back, below).
3. Logs: `gcloud run services logs read summitops-api --region us-east1 --limit 100`, or Cloud console, Cloud Run,
   summitops-api, Logs. Every failure is one line with `"severity":"ERROR"`.
4. Post on the Status page what you know.

## Rolling back a release

Every deploy is a new Cloud Run revision, and migrations only add, so the previous revision runs on the migrated database.

```bash
gcloud run revisions list --service summitops-api --region us-east1
gcloud run services update-traffic summitops-api --region us-east1 --to-revisions=<previous-revision>=100
```

`promote.sh` printed the exact command for the revision it replaced. Check `/version` answers the older version.

## Restoring the database

Use this when data is wrong or gone (a mistaken bulk change, a bad migration), or the server is broken. It never
overwrites the live server: it makes a new one, and the app is pointed at it.

1. **Choose the moment**: just before the problem, in UTC (`date -u`). Logs and the console's Activity help.
2. **Stop the damage** if it is still happening: pause the daily job if it is the cause
   (`gcloud scheduler jobs pause summitops-daily --location us-east1`), switch back a release that is the cause
   (Rolling back, above), or turn off the login doing it. Put a status note up.
3. **Make the copy** (10 to 30 minutes):
   ```bash
   gcloud sql instances clone summitops-db summitops-restored --point-in-time=2026-11-08T14:05:00Z
   ```
   From the daily backup instead (the zone or the logs are lost):
   ```bash
   gcloud sql backups list --instance summitops-db
   gcloud sql instances create summitops-restored --database-version=MYSQL_8_4 --edition=enterprise --tier=db-g1-small --region=us-east1
   gcloud sql backups restore <BACKUP_ID> --restore-instance=summitops-restored --backup-instance=summitops-db
   ```
   From the weekly copy (the server is gone): create `summitops-restored` as above, then
   `gcloud sql import sql summitops-restored gs://summitops-510715-backups/weekly/summitops.sql.gz --database=summitops`
   (`gcloud storage ls -a gs://summitops-510715-backups/weekly/` lists older versions).
4. **Check the copy** against the live database (reads only):
   ```bash
   bash -c 'source scripts/cloud-common.sh; load_service; AS=migrator open_db; \
     ~/cloud-sql-proxy --gcloud-auth --port 3308 summitops-510715:us-east1:summitops-restored & sleep 5; \
     DRILL_PORT=3308 node scripts/restore-check.js'
   ```
5. **Point the app at it** (staging first if there is time):
   ```bash
   CONN=summitops-510715:us-east1:summitops-restored
   gcloud run services update summitops-api --region us-east1 --add-cloudsql-instances $CONN --update-env-vars DB_SOCKET=/cloudsql/$CONN
   curl -s https://app.runmyresort.com/readyz
   ```
   The logins and passwords are the same on the copy. Run `bash scripts/backups-setup.sh` with `INSTANCE=summitops-restored`
   so the new server is backed up too, and keep the old server (stopped is fine) until you are sure.
6. **Data entered after the moment you chose** is not in the copy. If only part of the data was damaged, it can be
   better to copy just the lost rows back from the clone into the live server by hand. Ask for help with that.
7. **Tell people** what was lost, if anything, and close the status note. If you paused the daily job:
   `gcloud scheduler jobs resume summitops-daily --location us-east1`.

## The drill (once a season, before the first busy weekend)

It shows the plan works and how long it really takes. It changes nothing live.

```bash
bash scripts/restore-drill.sh            # copy as of 10 minutes ago, compare, point staging at the copy
# sign in to staging and look at a few records
bash scripts/restore-drill.sh --finish   # staging back on the real server, copy deleted (same day: it costs money)
```

Write down what it printed:

| Date | Copy took | Start to working staging | Newest record vs asked-for moment | Who |
|---|---|---|---|---|
| | | | | |

If the time is over an hour, or the newest record is more than 5 minutes before the moment asked for, something in
this plan needs fixing before the season.
