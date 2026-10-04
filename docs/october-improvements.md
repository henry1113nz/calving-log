# Prototype improvements — 4 October 2026

## Completed scope

- Three matched MPI ACVM references added: Orbenin Dry Cow (A000888), Orbenin Enduro
  (A006036), Penclox 1200 (A010884). Eleven supplied medicines are active; Bovaclox DC Xtra
  remains inactive. Exact withholding wording, official source, revision and review date
  are stored. Intracillin was reviewed but not imported because combination therapy changes
  its withholding requirements beyond the supported single-product profile.
- Medicines now has name/ingredient/registration search, availability/use-type filters,
  explicit OAD/TAD course tables and direct treatment links. The Owner/Vet editor can add
  immutable course rules to an inactive verified revision before activation.
- Milking plan has its own page. Individual cow history has its own page with stored hold
  explanation, events, SCC evidence and a reversible Owner/Vet archive action. Milkers cannot
  edit existing cow records. The sidebar remains scrollable at short screen heights.
- Ask covers six intents, including labels, milking plan and workflow help. Optional DeepSeek
  classification is implemented behind server-side keys and explicit opt-in, with local
  fallback, response validation, timeout and rate limiting. No provider chooses a drug, date
  or withholding instruction.
- Safety regressions fixed: all historical holds are checked, a faster milking schedule cannot
  shorten the original regimen duration, and an expired predicted calving result remains an
  unresolved hold until actual calving is recorded. Predicted reviews cannot be manually
  closed as an authoritative release. Clinical snapshots are retained.
- Local database backed up before the reference import. Temporary working files and secret
  environment files are excluded from Git/build context. Schema remains v9.

## Verification and honest limits

Automated checks cover isolated APIs, mocked external-provider behaviour, date calculations,
reference-import idempotence/rollback, clinical-history preservation, and the database release
gate. They do not spend provider credit or modify production clinical data.
The release check passed 176 API assertions, 12 assistant/calculator unit tests, 3 reference
import tests and 3 static-page tests (194 in total), plus the structural database gate.

Browser permission was declined during this task. Real rendered-page and click-through QA could
not be completed; source/asset checks and API tests are not a substitute for that visual check.
Railway Variables could not be inspected. Live external AI cannot be declared working until the
owner configures a valid DeepSeek API key and tests a successful external-mode answer.

This remains a supervised demonstration prototype: actual milking timestamps, multi-farm
operation, general clinical AI advice, automatic milk release and an exhaustive medicine
catalogue are not implemented. Existing event snapshots must be reviewed after operational
schedule changes. More medicines require the matching current Approved Label, not guessed values.

## Next hand-off

1. Configure `AI_PROVIDER=deepseek`, `AI_MODEL=deepseek-flash`, and `DEEPSEEK_API_KEY` in
   Railway, without posting the secret in chat or source control. Confirm provider credit.
2. Refresh the deployed pages and walk through the new medicine search, milking plan, cow
   history and Ask examples as Owner, Vet and Milker. Test on a phone as well as a desktop.
3. Agree any opt-in external data transfer with the supervisor, then conduct demonstration-only
   farm feedback sessions. Use feedback to prioritise the next changes.
