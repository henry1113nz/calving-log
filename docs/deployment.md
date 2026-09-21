# Deployment, backup and recovery

CalvingLog can run as one Node.js service with one persistent SQLite database. SQLite is
appropriate for this single-farm prototype, but the service must stay on one application
instance. Multiple containers must not write to separate copies of the database.

## Required production configuration

Set these environment variables before the first production start:

| Variable | Purpose |
|---|---|
| `NODE_ENV=production` | Disables the built-in development passwords. |
| `PORT` | HTTP port supplied automatically by the host; do not hard-code it. |
| `CALVING_LOG_DB=/data/calving-log.db` | Database path on a persistent volume. |
| `CALVING_LOG_OWNER_PASSWORD` | Initial Farm Owner password for a new database. |
| `CALVING_LOG_VET_PASSWORD` | Initial Farm Vet password for a new database. |
| `CALVING_LOG_MILKER_PASSWORD` | Initial Relief Milker password for a new database. |

The service refuses to initialise production accounts in a new database when any role password
is missing. After initialisation, users change their own password on the Account page; an
application restart does not reset it to the environment value.
Use HTTPS at the hosting layer; the session cookie is `HttpOnly`, `SameSite=Strict` and
marked `Secure` when Express receives the original HTTPS request through the trusted proxy.

## Optional external AI configuration

The read-only Ask CalvingLog page works without an external service through its constrained
local intent matcher. To enable external intent classification, set both variables below on the
server. Never expose the API key in browser JavaScript.

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | Server-side OpenAI API credential. |
| `OPENAI_MODEL` | Model selected for the Responses API classification call. |

The model receives only the user's question. It does not receive farm records and it cannot
write data or produce a withholding date.

## Container deployment

```bash
docker build -t calving-log .
docker run --rm -p 3000:3000 \
  -v calving-log-data:/data \
  -e NODE_ENV=production \
  -e CALVING_LOG_DB=/data/calving-log.db \
  -e CALVING_LOG_OWNER_PASSWORD='replace-me' \
  -e CALVING_LOG_VET_PASSWORD='replace-me' \
  -e CALVING_LOG_MILKER_PASSWORD='replace-me' \
  calving-log
```

Use one web instance and a persistent volume mounted at `/data`. Configure its health check
as `GET /api/health`. Do not put the database inside an ephemeral container filesystem.

## Railway prototype walkthrough

Railway is the current deployment target for supervised field testing:

1. Push the project to a private GitHub repository.
2. In Railway, create a project with **Deploy from GitHub repo** and select the repository.
   The root `Dockerfile` is detected automatically.
3. Add one persistent volume to the service and set its mount path to `/data`.
4. Add `NODE_ENV`, `CALVING_LOG_DB` and the three role-password variables in the table above.
   Railway supplies `PORT` automatically. Use three unique generated passwords; do not reuse the
   development passwords.
5. Keep the service at **one replica** because this prototype uses one SQLite database file.
6. In service health-check settings, use `/api/health`, then generate an HTTPS domain.
7. Sign in as Owner, Vet and Milker, run the release check below, and create a backup before
   inviting a participant.

The repository intentionally does not use the retired `railway.json` configuration path for
new services. The volume, variables, replica count and health-check path are reviewed in the
Railway dashboard so the SQLite safety assumptions remain visible.

## Release check

Before deployment:

```bash
npm ci
npm run release-check
```

Use [`.env.example`](../.env.example) as a names-only checklist when entering values in a
hosting dashboard. It contains no usable credentials and must remain that way.

After deployment, sign in as each role and confirm that the dashboard, review queue and Field
feedback page load, ask the supported vat and single-cow questions, change one test account password,
and confirm that a milker receives a permission message when attempting an
owner-only action. `GET /api/health` must return `status: ok` and `schema_version: 9`.

For the first trial, use demonstration animals only and follow
[field-testing.md](field-testing.md). The prototype banner is deliberately visible on every
signed-in page: this application must not be the sole authority for real milk release.

## Backup

The backup command uses SQLite's online backup API and runs `integrity_check` on the result.
It does not overwrite an existing file.

```bash
npm run backup-db
# or choose a mounted backup location
npm run backup-db -- /backups/calving-log-2026-08-24.db
```

For the prototype, run this before every deployment and at least daily while the system is
being used. Copy backups to storage separate from the application volume.

## Restore drill

The restore command deliberately creates a new file instead of overwriting the live database:

```bash
npm run restore-db -- /backups/calving-log-2026-08-24.db /data/calving-log-restored.db
CALVING_LOG_DB=/data/calving-log-restored.db npm run verify-db
```

If verification passes, stop the service, point `CALVING_LOG_DB` to the restored file, and
restart. Keep the previous database until the farm owner has checked the most recent cows,
treatments, review items and vat-exclusion list.

## Known deployment limits

- Session state is stored in SQLite and expires after 12 hours.
- Failed sign-ins are limited in memory to 10 attempts per username and IP every 15 minutes.
  A distributed deployment would need a shared limiter.
- The assistant supports three intents: the daily vat list, one cow's recorded hold, and a
  calving draft that only a person can confirm. External AI availability never changes the
  deterministic database result, and the assistant endpoint itself writes nothing.
- A multi-farm or multi-instance version should move operational data and sessions to a
  managed relational database.
