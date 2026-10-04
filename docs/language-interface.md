# Constrained natural-language interface

Natural language is an input convenience, not a source of withholding instructions.
The existing structured API, verified ACVM reference revision and deterministic calculator
remain authoritative.

`POST /api/assistant/query` and the `/assistant.html` page implement six read-only or
draft-only intents. Every answer is produced by the same server-side queries and stored
snapshots that the rest of the application uses.

## Implemented use cases

1. **Retrieve records** — “Which cows must stay out of the vat today?” The rows come from the
   same server-side query as `GET /api/vat-exclusions`, including the cows whose clear date is
   unknown.
2. **Explain an existing result** — “Why is cow 212 on hold?” The reply restates what is already
   stored on the event: the applied rule, the ACVM registration and label revision, the days
   applied, the milkings-per-day snapshot, the calving date and whether it is predicted or
   actual. Nothing is recalculated, so the explanation cannot disagree with the daily list.
3. **Draft a structured record** — “Cow 212 calved today.” The assistant returns a draft and
   writes nothing. Confirming it sends the draft through the ordinary `POST /api/events` route,
   so the signed-in user is the actor and the normal validation, review queue, snapshot and audit
   trail all apply.
4. **Medicine reference** — “Show Penclox 1200 label.” Current product evidence and OAD/TAD
   course rules come from the reference database, not model memory.
5. **Milking plan** — “What does OAD / TAD mean?” The current dated schedule and terminology
   are returned, with a link to its dedicated page.
6. **Workflow help** — “How do I add medicine?” The reply gives page links and role restrictions.

## What the local matcher is allowed to do

The local matcher classifies the wording into one intent: `vat_exclusions_today`, `cow_status`,
`draft_event`, `medicine_info`, `schedule_info`, `workflow_help` or `unsupported`.
That is its entire contribution. Cow status reads all non-deleted history, so ten newer
harmless records cannot hide an older unresolved hold.

Entities are resolved by the server, not by the matcher:

- a cow is matched against the tag numbers that exist in the database, never parsed out of the
  sentence as a new value; an unknown or ambiguous tag is asked about instead;
- a date is accepted only as `today`, `yesterday` or `YYYY-MM-DD`, is validated, and is rejected
  when it is in the future;
- a medicine, a treatment regimen and a withholding period are never chosen. Treatment wording
  produces a draft with those fields deliberately blank and a pointer to the Treatments page.

By default, records, labels, dates and questions stay inside the application. The local
English/Chinese matcher calls no external service.

## Optional external classification

DeepSeek is the default optional provider; OpenAI is also supported. See
[deployment.md](deployment.md) for server-side environment variables. An external call
requires a configured key and explicit opt-in on Ask. Only the fixed classification prompt
and typed question are sent, never database rows or label documents. The page warns people
not to type identifying or clinical details; agree this transfer with the supervisor before a trial.

The provider returns one JSON intent from the allow-list, not prose or extracted entities.
The server rejects extra keys, unknown intents, malformed JSON, empty content and incomplete
responses. A model cannot turn a question into a record draft. Invalid output, provider errors
or the eight-second timeout fall back to local matching with a visible notice. A per-user
in-memory limiter permits twenty external requests per minute. No key is exposed to the browser.

Owner-only connection diagnostics live on `/ai-settings.html`, separately from daily Ask.
`POST /api/assistant/connection-test` requires explicit agreement to one possible paid request;
it submits a fixed non-clinical help question and validates the expected intent. Status reads
never probe automatically. A key being present is labelled configured, not connected; the
last test includes a timestamp and is not an ongoing availability guarantee. The normal query
and probe share a daily allowance (200 by default, configurable with `AI_DAILY_REQUEST_LIMIT`).
This limit is in-memory, resets at UTC midnight or restart, and is not a provider monetary cap.
`AI_ENABLED=false` disables external calls. Budget/rate-limit exhaustion returns visible local
fallback. HTTP errors are mapped to fixed safe messages without exposing raw provider bodies.

`test-assistant.js` mocks provider responses to test privacy, opt-in, missing keys, invalid output,
unsafe draft attempts and timeout fallback without spending API credit. Live upstream success
still needs a valid key and credit; a configured-key status alone does not prove a successful call.
`test-assistant-ui.js` checks opt-in, owner control visibility, truthful connection status,
probe consent and duplicate-query prevention in a DOM stub. It is not visual browser QA.

## Prohibited behaviour

- The matcher must never invent, estimate or override a milk or meat withholding period.
- It must never select an Orbenin regimen, infer a missing calving date or treat an unresolved
  review as safe.
- It must never create an owner/vet-only correction, medicine verification, farm-setting change
  or final dry-off decision without the signed-in role and normal server validation.
- It must not use general internet text as a substitute for the versioned ACVM Approved Label.
- It must not save anything. Only a person confirming a draft writes a record.

## Request flow

`user wording → one allowed intent or unsupported → server-side entity resolution
→ existing authenticated query or a draft for confirmation → deterministic database result`

If a required fact is missing or ambiguous, the reply asks for it rather than choosing a value.
The matcher output itself is never written as a clear date.

## Still future work

- Drafting a treatment, dry-off or SCC record, which would require a person to select the
  medicine and regimen inside the preview before anything could be confirmed.
- Explaining a dry-off recommendation or a correction history in the same restated form.
- Any bulk or multi-cow write, which is not planned for the prototype.
