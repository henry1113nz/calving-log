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

Records each cow's health events, calculates the milk withholding end date automatically
from the drug used, and produces a shared daily list of cows that must be kept out of the
vat.

The withholding calculation is not uniform: most treatments count from the treatment
date, but dry-cow therapy counts from the cow's **next calving date**, because she is not
milking when the drug is given. Getting this distinction wrong clears dry-cow treatments
months too early. See [docs/schema.md](docs/schema.md) for the full reasoning.

## Running it

```bash
npm install
npm start          # http://localhost:3000
```

The database is created, migrated and seeded automatically on first run.

```bash
npm test           # API tests against a temporary database
npm run verify-db  # prove the database enforces its constraints
```

`npm run verify-db` works on a copy of the database and reports, constraint by
constraint, whether the live database actually rejects invalid data — rather than
trusting that what the schema file says is what is in force.

## Tech stack

- Backend: Node.js + Express
- Database: SQLite via better-sqlite3, with versioned migrations
- Frontend: HTML / CSS / JavaScript, no build step
- AI layer: LLM API for natural-language entry and queries (planned, Week 8)

## Project layout

| File | Responsibility |
|---|---|
| `server.js` | HTTP routes, request validation |
| `db.js` | database connection |
| `migrate.js` | versioned schema migrations |
| `seed.js` | initial reference and demonstration data |
| `withdrawalCalculator.js` | withholding period calculation (pure logic) |
| `dryOffAdvisor.js` | dry-off treatment selection criteria (pure logic) |
| `verify-db.js` | database constraint verification |
| `test-api.js` | API endpoint tests |
| `public/index.html` | user interface |
| `docs/schema.md` | database design and rationale |

## Status

In development — COMPX576 project, University of Waikato.

Database layer complete at schema version 3. The withholding periods in the drug
reference table are still partly placeholder values pending verification against the MPI
ACVM register.
