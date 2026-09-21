# Constrained natural-language interface

Natural language is an input convenience, not a source of withholding instructions.
The existing structured API, verified ACVM reference revision and deterministic calculator
remain authoritative.

`POST /api/assistant/query` and the `/assistant.html` page implement three read-only or
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

## What the model is allowed to do

The model classifies the wording into one intent: `vat_exclusions_today`, `cow_status`,
`draft_event` or `unsupported`. That is its entire contribution.

Entities are resolved by the server, not by the model:

- a cow is matched against the tag numbers that exist in the database, never parsed out of the
  sentence as a new value; an unknown or ambiguous tag is asked about instead;
- a date is accepted only as `today`, `yesterday` or `YYYY-MM-DD`, is validated, and is rejected
  when it is in the future;
- a medicine, a treatment regimen and a withholding period are never chosen. Treatment wording
  produces a draft with those fields deliberately blank and a pointer to the Treatments page.

Farm records, ACVM label data and calculated dates are never sent to the model. When both
`OPENAI_API_KEY` and `OPENAI_MODEL` are configured, the server sends only the user's question to
the OpenAI Responses API and requires one of the four structured intents. Otherwise a deliberately
narrow English/Chinese local matcher is used, and the response says which mode produced the
classification.

## Prohibited behaviour

- The model must never invent, estimate or override a milk or meat withholding period.
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
The model output itself is never written as a clear date.

## Still future work

- Drafting a treatment, dry-off or SCC record, which would require a person to select the
  medicine and regimen inside the preview before anything could be confirmed.
- Explaining a dry-off recommendation or a correction history in the same restated form.
- Any bulk or multi-cow write, which is not planned for the prototype.
