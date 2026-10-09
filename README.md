# SummitOps backend

Multi-tenant operations API for small and mid-size mountain operations, starting with ski areas. One deployment serves many mountains; each mountain's data is isolated by `tenant_id`.

**Modules:** ticketing and passes, pricing, rentals, schedule and conditions, ski school, ski patrol, clubs and programs, workforce (staff, certifications, shifts, time clock). "SummitOps" is a working name; trademark and domain availability are not checked.

**Admin web app:** open the service URL in a browser. It is served by the same container from `public/` (plain JavaScript, no build step) and works on a phone. Roles see only the screens built for them: managers get a daily dashboard, schedule and prices; counter staff sell tickets and scan at the gate; patrol sets lift and trail status; instructors run rosters.

**Stack:** Node.js 22, Express 5, MySQL 8 / MariaDB 10.6+ (Cloud SQL for MySQL in production), JWT auth, zod validation. Built for Cloud Run.

## Run locally

```bash
npm install
cp .env.example .env        # fill in DB_* and JWT_SECRET; export them or use your shell's env loader
npm run migrate             # creates the tables (safe to re-run)
SEED_PASSWORD='something-long' npm run seed   # optional demo mountain
BOOTSTRAP_KEY=dev-key npm start
```

Create a mountain and log in:

```bash
curl -X POST localhost:8080/api/v1/tenants -H 'content-type: application/json' -H 'x-bootstrap-key: dev-key' \
  -d '{"slug":"my-mountain","name":"My Mountain","owner":{"email":"me@example.com","password":"a-long-password","first_name":"Me","last_name":"Owner"}}'

curl -X POST localhost:8080/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"tenant":"my-mountain","email":"me@example.com","password":"a-long-password"}'
# -> {"token":"..."}  send as: Authorization: Bearer <token>
```

## Tests

The suite runs against a real database (it creates two mountains and checks isolation, pricing, scanning, rentals, scheduling rules, capacity, and role access).

```bash
export DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=root DB_PASSWORD=... DB_NAME=summitops_test
npm run migrate && npm test
```

`npm test` runs every `test/*.test.js` file (API, accounts, patrol, patrol access, park, checkout, payments, finance, school, kiosk and more). `test/web.test.js` renders every screen in jsdom against the real API, opens each dialog and runs the main workflows. It is skipped, and says so, unless jsdom is installed; install it for a run with `npm i --no-save jsdom` (not added to package.json so the production install stays small).

## Project layout

| Folder | What is in it |
| --- | --- |
| `src/app.js`, `src/server.js` | The Express app (routes, security headers, rate limits) and the process entry point |
| `src/routes/` | One file per area of the API (sales, shop, patrol, rentals, ...). Public, no-login routes are on each file's `publicRouter` |
| `src/lib/` | Shared rules: pricing, tax, customers, the online shop, emails, the daily job helpers (`jobs.js`), formatting (`format.js`) |
| `db/` | `migrate.js` and the `*.sql` table definitions; `seed.js` and `demo.js` for demo data |
| `public/` | The staff app and the public guest pages (plain JavaScript, no build step). `public/js/ui.js` holds the shared screen helpers |
| `test/` | The test suite (`node --test`), run against a real database |

## More

- [FEATURES.md](FEATURES.md): what each part of the app does, grouped by area, and the known limits
- [DEPLOY.md](DEPLOY.md): first deploy, updating (`bash deploy.sh`), rolling back, optional settings
- [RUNBOOK.md](RUNBOOK.md): security and operations checklist
- [HIPAA.md](HIPAA.md): how patrol and patient data are protected
