# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

CalvingLog — COMPX576 capstone project, University of Waikato. A web app for small New Zealand
dairy farms: it records cow health events, calculates when treated milk may re-enter the shared
bulk vat, and produces a daily "keep these cows out of the vat" list that any staff member can
read at shift handover.

The safety asymmetry drives most of the design: milk from a treated cow entering the vat means
the whole batch is discarded and the processor may penalise the farm. A **confidently wrong**
answer is therefore far worse than no answer, and several decisions below trade convenience for
refusing to guess.

## Commands

```bash
npm start          # server on http://localhost:3000
npm test           # API tests
npm run verify-db  # prove the live database enforces its constraints
```

Neither test script uses a framework — both are hand-rolled with a custom `assert`/`check` and a
`heading()` per section. There is no argument parsing, so **a single test cannot be selected**;
to narrow a run, temporarily comment out sections inside `run()` (they are delimited by
`heading()` calls).

- `test-api.js` spawns a real server on port 3999 with `CALVING_LOG_DB` pointed at a temp file,
  then deletes it. Safe to re-run; never touches the dev database.
- `verify-db.js` copies the live database to a temp file and deliberately inserts invalid rows to
  confirm each constraint actually rejects them. It reads the *database*, not the schema source —
  the point is to catch constraints that were written but never applied. It also fails if an
  active product lacks complete ACVM provenance or the expected current revision/rules.

`CALVING_LOG_DB` overrides the database path everywhere.

## Architecture

Express + SQLite (better-sqlite3), no build step, no ORM, CommonJS.

**`require('./db')` has side effects.** `db.js` opens the database, enables `foreign_keys`
(SQLite disables it per-connection by default), then runs `migrate()`, `seed()` and the versioned
ACVM reference sync at import time. Requiring it *mutates the database file*. On the first v5 sync
of an existing default database it can also create the pre-import backup. Anything that must not
touch real data has to set `CALVING_LOG_DB` before the require.

**Pure logic is deliberately isolated.** `withdrawalCalculator.js` and `dryOffAdvisor.js` take
plain objects and return plain objects — no database, no HTTP. Keep it that way; they are the
parts that carry the domain reasoning and can be checked in isolation.

**Migrations, not a schema file.** SQLite cannot add a constraint to an existing table, so
`migrate.js` holds numbered migrations that rebuild tables (create → copy → drop → rename) and
records progress in `PRAGMA user_version`. Currently at version 9. Schema changes go in a new
numbered migration; never edit an existing one. `currentVersion()` special-cases pre-migration
databases (`user_version = 0` but tables already present) by probing for `health_events`.

`docs/schema.md` is the authoritative design document with the full ER diagram and rationale.
Read it before changing the schema.

## Domain rules that are easy to get wrong

**A drug is not a single withholding number.** Schema v5+ separates a product from its verified
label revision and that revision's regimen rules. The `drugs` row retains the current/default
value, unit and calculation basis; `drug_reference_revisions` holds immutable evidence; and
`drug_withdrawal_rules` holds the labelled once-/twice-daily milking counts for each regimen.
Preserve this structure: flattening it back to `drugs.milk_withdrawal_days` loses label meaning
and can clear a cow too early.

**Use the rule that was selected for the treatment.** Orbenin L.A. has more than one labelled
regimen, so treatment entry must select the applicable regimen; do not infer one from the product
name alone. Every new medicated event using an active verified product keeps the applicable
reference identity, and a regimen-based event also keeps the selected rule, so a later label
revision cannot silently rewrite history. Legacy events for an inactive/unverified product remain
unresolved.
The current Orbenin rules cover once- and twice-daily milking; a three-times-daily setting must
return an attention state rather than extrapolating.

For a legacy event with no regimen, the ACVM importer may attach the default rule only when every
approved regimen resolves to the same number of days at the current milking frequency. Record that
date-equivalence in the correction reason. If the results differ, leave the rule unresolved and
require review; never use `is_default` as evidence of what was administered.

**Dry-cow rules begin with calving, not treatment.** Reconcile predicted calving dates when an
actual calving event arrives. Cepravin Dry Cow has a labelled early-calving branch when the minimum
dry period is not met: count the full 49 days from treatment and then a further eight milkings.
Apply that branch rather than deleting the clear date or inventing a period.
Teatseal is withheld for the labelled number of milkings after calving, even though its meat period
is nil. When a required input is genuinely unavailable, store no clear date and surface
`requires_attention` rather than guessing.

**The withholding result is a snapshot.** `withdrawal_days_applied` and `withdrawal_end_date` are
computed once at write time and stored on the event. Milking-based events also keep
`milkings_per_day_applied` and `milking_schedule_snapshot`; those fields explain seasonal
frequency changes or an explicit event override. Do not recompute them at query time — a
future revision to a drug's registered period would silently rewrite history. The deliberate
exceptions are an explicit event correction and reconciliation of a predicted calving date with an
actual calving event. Calving reconciliation retains the event's applicable rule. An explicit PUT
revalidates the product and selected rule against the current active revision and updates the
event's reference link. Uncorrected history is frozen; mistakes and superseded predictions are not.

**Nothing is hard-deleted.** `DELETE /api/events/:id` only sets `deleted_at`. Every query that
reads active `health_events` must carry `AND deleted_at IS NULL`, as must applicable partial-index
predicates.
The soft-delete UPDATE also carries it, so re-deleting returns 404 instead of silently succeeding.

**Dates are canonical `YYYY-MM-DD` strings, compared as strings.** Every domain date stored in
that form has `CHECK (col IS strftime('%Y-%m-%d', col))`. This is not cosmetic: the vat-exclusion
query compares dates as strings, and `'2026-8-1' >= '2026-08-10'` is true as a string and false as
a date — a cow would silently drop off the exclusion list while still inside her withholding
period.

**Absence of evidence is not evidence of absence.** `dryOffAdvisor.js` returns
`recommendation: null` with `sufficient_evidence: false` when a cow has no SCC results and no
mastitis history, rather than defaulting to `teat_seal_only`. It also always returns
`criteria_met` — from 1 January 2027 VCNZ requires an individualised justification for every cow
given dry-cow antibiotics, so the *reasons* are the deliverable, not the conclusion.

**Seasons run June 1 → May 31.** `'2026-27'` means 2026-06-01 to 2027-05-31 (`seasonDateRange()`
in `server.js`). Dry-off criteria look at the current lactation only, not the cow's lifetime.

**Foreign keys are pre-checked in the route layer.** `findOrNull()` exists so a request referencing
a non-existent row returns 400 with a readable message instead of letting the FK constraint throw
and surface as a 500. Bad input is a client error, not a server error.

**Reference imports and corrections are auditable.** `reference_data_imports` records the version
of each official data package so it is applied once. If a verified reference correction is
intentionally backfilled into an existing event, write the before/after values and reason to
`withdrawal_corrections` in the same transaction; do not silently replace the snapshot.

**Reference status is a safety boundary.** The five active products have current ACVM evidence.
`Bovaclox DC Xtra` (A009020) is inactive because no current Approved Label is available in the
register. A004495 is `Bovaclox Dry Cow`, a different registered product, and its label must never be
used as a substitute. Do not activate or mark a revision verified without the matching registration,
label wording, official source, verification date and verifier.

**The UI must preserve uncertainty.** The daily list and event form are part of the safety model,
not a cosmetic layer. Keep warnings, verification state, regimen selection, `requires_attention`,
and unknown clear dates visible whenever API or rule changes are made.

**Milking frequency is effective-dated.** `milking_schedule` is the operational source for
once-, twice- or three-times-daily changes through the season. Resolve treatment-date products
at treatment and dry-cow products at calving, then count milkings across every schedule boundary
inside the withholding interval. `farm_settings` remains only as a compatibility baseline; do
not collapse the dated timeline back to one mutable value. A supplied event override is deliberate
and must be retained in the event snapshot.

**The browser UI is multi-page without a build step.** Shared navigation/styles live in
`public/assets/app.js` and `public/assets/app.css`; each HTML page has a matching page script.
Keep dashboard, treatments, reviews, herd, dry-off, medicines/reference, assistant, feedback and
account concerns separate, and test both desktop sidebar and mobile bottom-navigation layouts
after UI changes.

**The signed-in session is the actor.** `auth.js` holds password hashing, server-side sessions
and role checks; `app.use('/api', authRequired)` protects everything except health and sign-in.
Owner, vet and milker roles gate medicine verification, farm settings, corrections, user creation
and final dry-off decisions. A request body can never name a different creator.

**The assistant classifies; the server decides.** `assistant.js` maps wording to one of
`vat_exclusions_today`, `cow_status`, `draft_event` or `unsupported`, and nothing else. The route
resolves the cow against real tag numbers, accepts a date only as today/yesterday/`YYYY-MM-DD`,
reads explanations from the stored event snapshot without recalculating, and returns treatment
drafts with the medicine and regimen deliberately blank. A draft writes nothing: confirmation
goes through `POST /api/events` so the role checks, validation, snapshot and audit trail all
still apply. See `docs/ai-interface.md`.

## Conventions

- Code comments are written in Chinese; prose documentation (`README.md`, `docs/schema.md`) is in
  English. Follow the surrounding file.
- Comments explain *why*, not *what* — most existing ones record the reasoning behind a
  safety-driven decision. Preserve them when refactoring; they are the audit trail for the design.

## Planned work

The ACVM reference-data blocker has been resolved for the five active products. Reference data is
still versioned evidence, not a one-off seed: re-check it when an Approved Label changes and add a
new revision instead of overwriting the one attached to historical events.

The natural-language layer now implements the three intents described in
`docs/ai-interface.md`. Drafting a treatment, dry-off or SCC record is still future work,
because a person must select the medicine and regimen inside the preview before anything could
be confirmed. Keep any new intent read-only or draft-only.
