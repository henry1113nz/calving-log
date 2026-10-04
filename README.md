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
npm test           # isolated API tests plus mocked AI/calculator unit tests
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
- Language helper: local English/Chinese intent matching, with optional opt-in DeepSeek or
  OpenAI classification; the server resolves every entity and performs every calculation

## Project layout

| File | Responsibility |
|---|---|
| `server.js` | HTTP routes, request validation |
| `auth.js` | password hashing, server-side sessions and role checks |
| `db.js` | database connection |
| `migrate.js` | versioned schema migrations |
| `seed.js` | initial reference and demonstration data |
| `acvmReferenceData.js` | versioned, auditable import of verified ACVM label data |
| `acvmAdditionalReferenceData.js`, `acvmOctoberReferenceData.js` | idempotent packages of additional matching Approved Labels |
| `withdrawalCalculator.js` | withholding period calculation (pure logic) |
| `dryOffAdvisor.js` | dry-off treatment selection criteria (pure logic) |
| `verify-db.js` | database constraint verification |
| `test-api.js` | API endpoint tests |
| `test-assistant.js` | mocked provider, privacy, fallback and schedule-transition regression tests |
| `test-reference-data.js` | repeat-import, conflict rollback and clinical-history preservation tests |
| `test-static-pages.js` | frontend syntax, element ID and local asset/link checks (not browser QA) |
| `assistant.js` | local and optional external intent classification; never performs the safety calculation or supplies entities |
| `public/*.html` | login, dashboard, events, reviews, herd, individual cow history, dry-off, medicines, medicine editor, milking plan, assistant, feedback and account pages |
| `public/assets/` | shared responsive styles and page-specific browser logic |
| `docs/schema.md` | database design and rationale |
| `docs/deployment.md` | production configuration, backup and restore drill |
| `docs/language-interface.md` | implemented language interface and its safety boundary |

## Status

In development — COMPX576 project, University of Waikato.

The application is at schema version 9. Eleven current products in the active reference
set have been checked against their current MPI ACVM Approved Labels, including the label
wording, source, revision and rule variants used by the calculator. `Bovaclox DC Xtra`
(A009020) is deliberately inactive because the current register does not provide a
current Approved Label for that registration; the label for A004495 belongs to a
different product and must not be substituted.

The 28 September 2026 reference import adds Albiotic, Mastiplan and Noroclox DC 600.
Albiotic and Mastiplan use explicit current-label rules because their OAD and TAD milk
periods differ. Noroclox DC 600 uses the conditional dry-cow branch with its own 35-day
condition and eight post-calving milkings.

The 4 October 2026 package adds Orbenin Dry Cow (A000888), Orbenin Enduro (A006036),
and Penclox 1200 (A010884), with matching Approved Label wording, revision, source and
review date. The two dry-cow products use their own 30-/35-day conditions and a further
eight milkings; Penclox requires an explicit labelled course and stores both OAD and TAD
values. A change to faster milking cannot shorten the original regimen duration. The app
works at conservative whole-date precision, not actual milking timestamps.
Predicted calving dates are planning estimates only. They remain on the daily hold list even
after the estimated date expires, enter the review queue, and cannot be manually cleared
without an authoritative event correction or actual calving record.

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

The front end is split into focused, responsive operational pages instead of one crowded
screen: the daily dashboard, treatment/events entry, accountable reviews, herd records,
evidence-based dry-off decisions, medicines/reference control, a dedicated dated milking plan,
individual cow history, a separate Owner/Vet medicine
editor, a constrained natural-language
assistant, structured field feedback, and account security. It shows verification and
attention states, handles an unknown clear date safely, supports regimen selection where
required, exposes correction history, explains role restrictions, and lets all roles submit
usability feedback while limiting the response history to the owner.

The medicine editor separates catalogue entry from approval. Owner and Vet users may save an
inactive draft, but it cannot appear in treatment selection until the matching ACVM registration,
label revision, exact label wording, HTTPS source, verification date and verifier are present.
Changing a safety-critical field removes verification and deactivates the product. A product with
multiple labelled regimens also remains inactive until its structured regimen rules exist.

The editor now lets Owner/Vet users append labelled OAD/TAD courses to the current verified
revision while the product is inactive. Stored rules cannot be overwritten. Herd profiles
allow Owner/Vet users to mark a cow culled without deleting her clinical history.

The natural-language page covers six constrained intents: today's vat list, one cow's recorded
hold, a calving draft, medicine label lookup, milking-plan lookup, and page/role help. A draft
writes nothing until confirmed through the ordinary event route. Without a provider key,
everything remains local. With a key and explicit opt-in, only the typed question is sent for
intent classification; no database records or label documents are uploaded. Invalid output or
provider failure falls back locally. A model cannot choose a medicine, regimen or withholding
period. See
[docs/language-interface.md](docs/language-interface.md).
