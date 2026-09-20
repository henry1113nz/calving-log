# Constrained natural-language interface

Natural language is an input convenience, not a source of withholding instructions.
The existing structured API, verified ACVM reference revision and deterministic calculator
remain authoritative.

The first implemented vertical slice is `POST /api/assistant/query` and the separate
`/assistant.html` page. It supports one read-only intent: asking which cows must stay out of
the vat today. The returned rows come from the same server-side query as
`GET /api/vat-exclusions`.

## Allowed use cases

1. **Retrieve records (implemented for today's vat list)** — for example, “Which cows must stay
   out of the vat today?” The model may classify the request, but the server runs the existing
   read-only query and returns its structured data.
2. **Draft a structured record (future)** — for example, “Cow 212 calved today.” The model may fill a
   preview form, but the user must confirm the cow, date and event type before submission.
3. **Explain an existing result (future)** — the model may restate the stored rule, label revision,
   schedule snapshot and reason already returned by the API.

## Prohibited behaviour

- The model must never invent, estimate or override a milk or meat withholding period.
- It must never select an Orbenin regimen, infer a missing calving date or treat an unresolved
  review as safe.
- It must never create an owner/vet-only correction, medicine verification, farm-setting change
  or final dry-off decision without the signed-in role and normal server validation.
- It must not use general internet text as a substitute for the versioned ACVM Approved Label.

## Implemented request flow

`user wording → one allowed intent or unsupported → existing authenticated vat query
→ deterministic database result`

When both `OPENAI_API_KEY` and `OPENAI_MODEL` are configured, the server sends only the user's
question to the OpenAI Responses API and requires one of two structured intents. Farm records,
ACVM label data and calculated dates are not sent to the model. If external classification is
not configured or is unavailable, a deliberately narrow English/Chinese local matcher is used
and the response identifies that mode.

If a required fact is missing or ambiguous, the preview must ask for it. The model output itself
is never written as a clear date. Every committed record uses the session user as its actor and
passes through the same role checks, database constraints, review queue and audit trail as the
manual UI. Write actions remain future work and are not exposed by the assistant endpoint.
