# calving-log

A web application to help small dairy farms manage cow health events during the calving season.

## Problem

During New Zealand's seasonal calving, health events pile up fast. When a cow is treated
with an antibiotic her milk cannot enter the shared bulk vat for a set number of days; if
it does, the whole batch is discarded and the farm may face penalties from the processor.

Smaller farms without automated drafting hardware track treated cows with paint marks and
staff memory, which breaks down at shift handovers — particularly with weekend relief
milkers.

## What it does

Records each cow's health events, applies the selected rule from the product's verified
ACVM label, and produces a shared daily list of cows that must be kept out of the vat.
The list keeps safety warnings and cases with an unknown clear date visible instead of
silently treating them as safe.

The withholding calculation is not uniform. Labels may use hours, milkings, treatment
regimens, minimum dry periods, or separate rules when a cow calves early. Dry-cow rules
also depend on the cow's **actual calving date**, because she is not milking when the
product is given. Getting those distinctions wrong can clear a cow too early. See
[docs/schema.md](docs/schema.md) for the full model and safety reasoning.

Milking frequency is also operational data, not a permanent farm constant. The app keeps
an effective-dated schedule for once-, twice- and three-times-daily milking. Calculations
count the milkings that actually fall under each dated schedule entry, and each event stores
the frequency and schedule snapshot that produced its clear date.

## Running it

```bash
npm install
npm start          # http://localhost:3000
```

Development accounts are created automatically:

| Role | Username | Development password |
|---|---|---|
| Farm Owner | `owner` | `calving-owner-2026` |
| Farm Vet | `vet` | `calving-vet-2026` |
| Relief Milker | `milker` | `calving-milker-2026` |

Production refuses these fallback credentials and requires the three role password
environment variables described in [docs/deployment.md](docs/deployment.md).

The database is created, migrated and seeded automatically on first run. When an existing
default database receives the v5 ACVM reference import for the first time, the app creates
`calving-log.db.backup-before-acvm-v5-20260817` before applying the audited import in one
transaction. Temporary/test databases do not create that backup file.

```bash
npm test           # API tests against a temporary database
npm run verify-db  # prove the database enforces its constraints
npm run backup-db  # create and integrity-check an online SQLite backup
```

`npm run verify-db` works on a copy of the database and reports, constraint by
constraint, whether the live database actually rejects invalid data — rather than
trusting that what the schema file says is what is in force. It also acts as a strict
reference-data release gate: an incomplete active ACVM reference makes the command fail.

## Tech stack

- Backend: Node.js + Express
- Database: SQLite via better-sqlite3, with versioned migrations
- Frontend: HTML / CSS / JavaScript, no build step
- AI layer: constrained read-only intent classification through the OpenAI Responses API when configured, with a local fallback

## Project layout

| File | Responsibility |
|---|---|
| `server.js` | HTTP routes, request validation |
| `auth.js` | password hashing, server-side sessions and role checks |
| `db.js` | database connection |
| `migrate.js` | versioned schema migrations |
| `seed.js` | initial reference and demonstration data |
| `acvmReferenceData.js` | versioned, auditable import of verified ACVM label data |
| `withdrawalCalculator.js` | withholding period calculation (pure logic) |
| `dryOffAdvisor.js` | dry-off treatment selection criteria (pure logic) |
| `verify-db.js` | database constraint verification |
| `test-api.js` | API endpoint tests |
| `assistant.js` | constrained local/OpenAI intent classification; never performs the safety calculation |
| `public/*.html` | login, dashboard, events, reviews, herd, dry-off, medicines, assistant, feedback and account pages |
| `public/assets/` | shared responsive styles and page-specific browser logic |
| `docs/schema.md` | database design and rationale |
| `docs/deployment.md` | production configuration, backup and restore drill |
| `docs/ai-interface.md` | safety boundary for the planned language interface |

## Status

In development — COMPX576 project, University of Waikato.

The application is at schema version 8. Five current products in the active reference
set have been checked against their current MPI ACVM Approved Labels, including the label
wording, source, revision and rule variants used by the calculator. `Bovaclox DC Xtra`
(A009020) is deliberately inactive because the current register does not provide a
current Approved Label for that registration; the label for A004495 belongs to a
different product and must not be substituted.

The v5 import reviews active legacy events and records every before/after result in the
correction audit. It does not guess a missing Orbenin regimen: a legacy event is linked to
the default rule only when all approved regimens produce the same clear date at the
farm's current milking frequency; otherwise it is left for review. Soft-deleted history is
not rewritten.

The signed-in session now supplies the accountable actor; the browser cannot forge a different
creator in a request body. Owner, vet and milker roles restrict medicine verification, farm
settings, historical corrections, user creation and final dry-off decisions. Every event
correction stores its reason, actor and before/after JSON snapshots. Automatically unprovable
cases enter a review queue and remain visible through accountable resolution.

The front end is split into nine focused, responsive operational pages instead of one crowded
screen: the daily dashboard, treatment/events entry, accountable reviews, herd records,
evidence-based dry-off decisions, medicines/reference control, a read-only natural-language
assistant, structured field feedback, and account security.
It shows verification and
attention states, handles an unknown clear date safely, supports regimen selection where
required, exposes correction history, explains role restrictions, and lets all roles submit
usability feedback while limiting the response history to the owner. The first natural-language
vertical slice answers only today's vat-exclusion question and returns the same deterministic
rows as the existing API. External OpenAI intent classification is optional; without a key the
same narrow use case remains available through a local matcher. See
[docs/ai-interface.md](docs/ai-interface.md).
