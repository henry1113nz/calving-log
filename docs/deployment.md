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

## Optional external AI

The local Ask assistant works without a paid service. To enable optional DeepSeek wording
classification, add these to **Railway → calving-log → Variables** and deploy the change:

```text
AI_PROVIDER=deepseek
AI_MODEL=deepseek-flash
DEEPSEEK_API_KEY=<your own secret key>
AI_ENABLED=true
AI_DAILY_REQUEST_LIMIT=200
```

Create a key in the [DeepSeek API platform](https://platform.deepseek.com/). Model names and
charges should be checked against the [official pricing page](https://api-docs.deepseek.com/quick_start/pricing/).
Do not put the key in browser JavaScript, GitHub, screenshots or chat. Never enter a literal
placeholder as a real key. OpenAI is also supported with `AI_PROVIDER=openai`,
`AI_MODEL=gpt-4.1-mini`, and `OPENAI_API_KEY`; only the selected provider is contacted.

After deployment, sign in as Owner and open **Account → AI settings**, or use the settings
link on Ask. The page distinguishes configuration from a passed connection test. Reading
`GET /api/assistant/status` does not contact the provider or spend credit and never reveals
the key. Agree to the one-request charge and select **Test AI connection**: the owner-only
`POST /api/assistant/connection-test` sends a fixed help question, never clinical data. Only
a valid expected JSON intent produces a passed test. A configured key alone does not prove
that it has credit or that the upstream model works. Last-test timestamps are shown; the
result is a past observation, not a promise of continuing availability.

On Ask, select the provider checkbox and submit a harmless query. An external-mode badge
confirms successful classification for that particular request. Error notices distinguish
rejected keys, insufficient balance, rate limits, model/parameter errors, network failures
and invalid output. Do not forward raw provider errors or logs, which might contain secrets.
Use `AI_ENABLED=false` in Railway to switch external calls off immediately after redeploy.
Only the typed question is sent; warn participants not to type identifying or clinical details.
Database rows and safety calculations remain server-side. External calls have an eight-second
timeout and a per-user in-memory limit of twenty requests per minute. `AI_DAILY_REQUEST_LIMIT`
defaults to 200 combined queries and connection tests across all users on this running server.
It accepts integers from 0 to 10000; invalid values use the default and 0 blocks external calls.
Denied budget/rate-limit queries visibly fall back to local matching rather than failing the
database answer. Attempted calls, including failed probes, consume this request allowance.
UTC-day counters reset at midnight **and on restart**; this is not a monetary cap or a
cross-instance quota. Review provider billing separately and keep the SQLite service at one
instance. Agree this data transfer
with the supervisor before asking farm-trial participants to opt in.

See [deepseek-setup.md](deepseek-setup.md) for the beginner-friendly Chinese checklist and
acceptance questions. Mock tests do not establish live upstream availability.

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
- The assistant supports six intents: the daily vat list, one cow's recorded hold, a calving
  draft, medicine references, milking plan, and workflow help. External-service availability never changes the
  deterministic database result, and the assistant endpoint itself writes nothing.
- A multi-farm or multi-instance version should move operational data and sessions to a
  managed relational database.
