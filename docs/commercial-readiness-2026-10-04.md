# Single-farm pilot readiness review

Reviewed 4 October 2026. Decision: continue a **supervised demonstration-data trial**.
This release improves usability and access control. It is not approval for commercial
milk-release decisions, a veterinary sign-off, a privacy certification or a penetration test.
The first intended customer is one farm; multi-farm self-registration is out of this phase.

## Improvements in this release

- English-only shipped interface, examples and status text; chat replies default to English.
  Multilingual questions remain supported through an optional language preference. Existing
  user-written database content has not been translated, erased or silently rewritten.
- A separate Help & data page explains the workflow, roles, inclusive dates, OAD/TAD,
  dry-off, missing information, outages and actual trial data handling.
- Account creation is collapsed until needed. Owner account management adds disable,
  restore and password reset with owner-password confirmation and a reason. User IDs and
  historical attribution remain intact; target sessions are closed. Recent actions are visible.
- Schema v10 adds `users.is_active` and constrained, foreign-keyed `account_actions` with
  indexes. Existing accounts remain active on upgrade. No medicine rule changed in this release.
- Startup verifies a separate snapshot before migrating an existing database; failed backups
  block migration. Backups remain on the same volume unless an operator copies them off-site.
- Short/oversized passwords and malformed cookies no longer crash authentication.
  Account enumeration is owner-only; sign-in attempt storage is pruned and bounded.
- A browser-discovered logout bug is fixed: successful empty `204`/`205` responses no longer
  become unexpected-response errors. Non-JSON `200` responses are still rejected.
- Browser writes have origin/fetch-site checks, pages have script/frame restrictions,
  HTTPS responses have HSTS, and API results use `no-store`. The one-hop proxy assumption
  must be reviewed if hosting changes. These measures do not constitute security certification.
- Impossible SCC dates and mismatched season years are rejected. A dry-off decision cannot
  link another cow's SCC or an SCC outside its season. Constraint conflicts return client
  errors, not generic server faults.
- GitHub Actions runs tests, database verification and dependency auditing. It does not
  hold Railway's direct automatic deployment until checks pass; release approval remains manual.

## Evidence collected

- Release checks: 332 automated tests pass, plus database integrity, foreign-key, index
  and reference-data gates. Mocked provider tests do not prove live AI accuracy or availability.
- Dependency audit against the official npm registry reports zero known vulnerabilities
  at the time of this review. The local mirror's unsupported audit endpoint was not counted
  as success. This is a point-in-time advisory scan, not a code audit.
- Browser QA: 15 signed-in pages at 1440×1000 and 390×844, plus sign-in. No Chinese UI text,
  document-level horizontal overflow or captured JavaScript errors in those checks. Checked
  chat defaults, a simulated response, source disclosures and account action field switching.
  Owner, Vet and Milker sign-in/sign-out were exercised; owner management controls stay
  hidden for Vet/Milker. The logout regression was reproduced and rechecked after its fix.
- The local v9 database was backed up before upgrade. All original field/value rows across
  its 16 existing tables match after v10 migration. A v9 backup was restored to a new local
  candidate file, upgraded and passed verification; no live file was overwritten.
- Remote volume/backups, live sign-in and post-deploy role workflows need confirmation
  in the hosting account. Local success is not proof of remote configuration.

## Blockers before a real-data commercial pilot

| Priority | Gap found in this codebase | Required acceptance evidence |
|---|---|---|
| P0 | Calendar-day calculation and planned frequency are not actual treatment timestamps or completed milkings. Time zones, daylight saving, late/missed sessions and changing frequency need a defined operational model. | A veterinarian-reviewed specification; recorded last dose time, actual calving time and actual milking sessions; time/count gates independently tested at boundaries. Do not convert a scheduled milking into a completed one. |
| P0 | Treatment events do not hold a complete structured administration record: dose, route, affected quarters, course administration, veterinary authorisation and relevant prescription evidence are missing. | Farm/vet-approved required fields, validated course completion and last-dose anchoring, traceable authorisation attachments and migration of legacy incomplete events to explicit review. |
| P0 | Concurrent treatments, off-label use, dose-specific directions and non-medicine holds are not fully modelled. Taking the latest individually calculated date alone is not a universal combined-treatment rule. | Define supported scenarios with the farm veterinarian and milk processor; unsupported combinations remain on hold with an accountable review. Add scenario tests and compare outputs with independently calculated examples. |
| P0 | Saved clinical snapshots are retained when a future milking plan is changed. The app has no systematic review workflow for every affected still-open hold. | Identify affected live holds, record a review/reconciliation event and preserve the earlier snapshot; never silently shorten a hold. |
| P0 | Label verification is stored evidence, not continuing proof that a source is current or that all use conditions apply. Dry-off thresholds are decision support, not a prescription. | Product-specific scope and verification owner, regular source review, explicit vet sign-off for rules and thresholds, expiry/review policy, and documented unsupported products. |
| P0 | Real-data ownership, privacy contact, retention, hosting location/processor terms and AI processing arrangements have not been approved. Checked defaults are appropriate only for the demonstration workflow, not blanket consent for real farm records. | Inventory existing data before importing real records. Identify operator/contact, publish a reviewed privacy notice and retention plan, assess overseas processing/PIA, document access/correction/deletion routes. Disable external AI while this is unresolved. |
| P0 | Backup scripts and a local restore drill exist, but there is no implemented scheduled off-volume backup, retention rotation or remote recovery test. Railway trial/credit availability is not a production service plan. | Operator-selected hosting plan and region, one replica, persistent path, encrypted off-volume backup schedule, documented recovery targets, and a remote restore drill with farm sign-off. No spending/subscription has been agreed by this report. |
| P0 | Health endpoint exists, but uptime alerts, error monitoring, disk alerts, support ownership and an outage runbook are not implemented. | External monitoring and alert recipient, capacity checks and tested incident/outage procedures. Keep normal farm records as fallback. |
| P0 | Security improvements have not received an independent assessment. Login/AI limits reset on restart; temporary passwords have no forced expiry/change; there is no MFA. Operational history is not tamper-evident against a database administrator. | Threat model and independent review, measured login abuse controls, privileged account lifecycle policy, staged releases/rollback procedure, secrets rotation, and protected audit retention appropriate to the risk. |
| P1 | No production import/export, bulk herd onboarding, actual milking capture, offline sync or real farm-device usability results. | Prioritised task evidence from the first farm, reconciliation-safe import/export, tested connectivity fallback and performance with realistic herd/event volumes. Offline sync requires conflict and duplicate-write design. |
| P1 | AI query access is bounded/read-only, but text can still contain sensitive details or misleading/injected instructions. No real-provider evaluation set or persistent cost quota exists. | Redacted/evaluated question set, uncertainty/injection tests, provider retention/contract review, explicit real-data controls and persistent quotas if AI remains enabled. AI never becomes the milk-release authority. |
| Later | Data has no farm/tenant boundary; SQLite is tied to one instance. No public registration, customer billing or email-based onboarding/recovery. | Before a second independent farm: tenant-scoped relational schema, authorised isolation tests, tenant backups and a managed database/deployment model. Billing is not required for the first supervised farm trial. |

## Recommended order and people needed

1. **Now: demonstration trial.** Owner checks the deployed version and creates separate
   milker accounts. Supervisor recruits two or three regular milkers. Collect task completion,
   ease ratings and specific problems; disable trial accounts afterwards. Use no real clinical data.
2. **Next: clinical and operational specification.** Farm operator, veterinarian and milk
   processor decide the supported recording/withholding scenarios, required data, release
   authority and failure procedures. The developer implements timestamp/session and review
   changes only against that agreed specification.
3. **Then: controlled real-data pilot.** Resolve privacy/security/backup/monitoring blockers,
   prepare a clean separately backed-up pilot database without demo seed data, import reviewed
   records and run in parallel with the farm's existing process. Analyse discrepancies; the
   existing process remains authoritative.
4. **Finally: commercial acceptance.** Document signed acceptance, support, maintenance,
   contract terms, data ownership and hosting costs. Remove the prototype label only when the
   scope is genuinely validated; do not hide it as a cosmetic UI change.

No real-data import, payment, legal acceptance, tenant expansion or migration to a new hosting
provider has been performed in this release.

## Primary references checked

- [MPI: withholding periods for veterinary medicines](https://www.mpi.govt.nz/animals/veterinary-medicines-acvm/withholding-periods-for-veterinary-medicines): labelled use conditions and withholding matter; unsupported/off-label situations need authoritative treatment-specific handling.
- [MPI: NZCP1 farm dairy operational code](https://www.mpi.govt.nz/dmsdocument/46243/direct/): use the current full code with the farm/vet when specifying treatment records and concurrent-use handling. This review is not a substitute for that assessment.
- [NZ Privacy Commissioner: AI and the privacy principles](https://www.privacy.org.nz/resources-and-learning/a-z-topics/ai/): assess privacy before adopting AI for personal information and update that assessment as the use changes.
- [NZ Privacy Commissioner: overseas disclosure decision tree](https://www.privacy.org.nz/responsibilities/disclosing-personal-information-outside-new-zealand/decision-tree-page/): overseas processing/disclosure depends on the actual arrangement; a checkbox alone does not settle compliance.
- [SQLite: VACUUM INTO](https://www.sqlite.org/lang_vacuum.html): separate consistent snapshots without rewriting the source database; verify backups and retain off-volume recovery copies.
