# Conversational assistant and record helper

CalvingLog's main Ask page is now a normal conversational interface, not a fixed intent
classifier. The model generates multilingual replies and can request validated read-only
queries to understand demonstration records. English, Chinese and other language replies
are supported by the model; the UI offers Auto, Chinese and English preferences.

## Two separate workflows

- `/assistant.html` → `POST /api/assistant/chat`: conversation, recent follow-ups,
  business/technical explanations, record summaries and comparisons. No farm-record writes.
- `/record-helper.html` → `POST /api/assistant/query`: the earlier six-intent deterministic
  lookup/calving-draft workflow. A draft saves only through a person's explicit confirmation
  to the ordinary event API. Its optional classifier sends the typed question only.

The main chat directs record/edit requests to the existing structured pages. It cannot verify
medicines, prescribe, calculate a new withholding date, resolve a review or authorise milk release.
This prevents model-generated dates/entities from becoming operational writes.

## Business understanding and read-only tools

`assistantTools.js` supplies maintained application knowledge: pages, real role permissions,
technology, OAD/TAD, dry-off, source verification, inclusive hold dates and missing-information
semantics. This is explicit context, not training or automatic knowledge of every source file.
It must be updated if the application's behaviour changes.

Each AI turn with demo-data consent receives a fresh aggregate herd overview. Tools can then:

| Tool | Evidence returned |
|---|---|
| herd_summary | Total including culled, active total, status/breed/lactation breakdowns |
| find_cows | Literal tag/breed search, status filters, paged cow records |
| cow_history | Exact tag, stored hold status and event/reference/schedule evidence |
| event_records | Matching totals, event-type counts, product/cow/date filters and paged history |
| milk_holds | Same current/unresolved exclusions as Dashboard, not an independent release decision |
| medicine_library | Active/inactive/unverified searches; selected label wording and regimen metadata |
| milking_plan | Current farm-wide frequency and effective-dated changes |
| review_queue | Open/resolved counts and source-event status, without reviewer identities |
| scc_evidence | Numeric tests and recorded historical dry-off decisions, not a new recommendation |

Tools use parameterised SQL and exact server-side argument/schema checks. The model cannot
supply SQL, table names, executable code or an arbitrary network endpoint. All three signed-in
roles can read these operational fields, matching the ordinary read APIs. Authentication remains
mandatory. Credentials, sessions, user accounts, feedback, actor identities, clinical notes and
free-text decision/review reasons are not tools. No role can use chat to bypass mutation permissions.

Each list returns up to twenty rows with total, offset and truncation metadata. Searches can page
or narrow results. Labels and rule lists have explicit truncation flags. Grouped herd breakdowns
are limited to thirty rows while aggregate totals remain complete. Tools do not silently replace
unknown fields with zero. Source links and expandable server facts are returned separately from
model-generated prose. Dates use the existing application's UTC-day convention.

## Consent and data handling

AI and database sharing are separate opt-ins, off initially:

1. AI enabled, data sharing off: send the current question, recent conversational messages and
   curated application knowledge. No database tool calls or herd overview are provided.
2. AI enabled, data sharing on: also send a fresh demo herd overview and selected read-only
   query/label results. **Not the entire database.**
3. AI off/unavailable: simple local lookups remain available, clearly labelled not conversational AI.

The change from the old classifier is material: selected results now leave the application after
separate consent. Use demonstration data only; agree processing and participant information with
the supervisor before trials. Removing identity columns is not full anonymisation. User messages,
cow tags, externally entered label text or other allowed strings could still identify a real farm.
Do not submit real clinical information, personal details, passwords or keys. A best-effort pasted-
credential detector rejects obvious secrets before upstream requests; it does not detect all PII.

Recent conversation is held in server memory, tied to the authenticated login session, with up
to eight message pairs / an eighteen-thousand-character memory budget and thirty-minute inactivity
expiry. New chat clears it; refresh starts a new chat. A sharing-scope change wipes prior context
before sending a new turn, preventing earlier database-derived answers from being resent after
consent withdrawal. A new chat also retires older idle chat memory for that session. Chat memory
is not saved into SQLite. Failed generations are not appended to model history.

## Provider loop and limits

The server sends normal chat messages and optional function tools to the configured provider.
Tool arguments are checked before execution; only whitelisted query results are returned to the
model for an answer. Recent assistant replies are not authoritative evidence: fresh queries should
be used for record facts, and the model is instructed to say unknown or ask for clarification.

A turn permits up to five upstream requests / six tool calls, with a fifteen-second timeout per
request and a forty-five-second total turn budget. At most one generation per account runs at a
time. Each actual upstream attempt consumes the shared limiter: twenty per user per minute and
200 per running server per UTC day by default. The global limit is configurable from 0 to 10000.
Failure requests and basic connection tests also count. Counters reset on restart; these are
request safeguards, **not a guaranteed spending cap**. Check provider billing separately.

HTTP errors and invalid/truncated output map to safe notices. Raw provider bodies are not exposed.
Failure falls back to simple local results with a truthful mode label. If an attempted request
already sent demo context, the fallback still reports that sharing happened.

Owner-only AI settings runs the existing fixed help-intent connection probe. It establishes one
basic API request worked, not the quality of tool conversations. Opening status/settings never
contacts the provider. No key is returned to the browser or stored in frontend assets.

## Reliability and safety limits

This is a language model, not a guarantee against hallucination. Prompt instructions to say unknown,
ignore injected instructions in labels, ground database facts and avoid prescribing are model-level
guidance. Hard server guarantees are narrower: bounded read-only queries, validated arguments,
session isolation, separate consent and no clinical writes from chat. The structured calculator,
versioned Approved Label, farm procedures and veterinarian remain authoritative.

An expected calving date is planning only; unknown dates remain unresolved. No stored medicine hold
does not establish residue-free milk. AI can explain stored dates/conditions but cannot approve release.
There is no web-search tool; current external facts cannot be checked by the assistant.

## Testing and live acceptance

- `test-assistant-chat.js`: mocked multilingual replies/tool loops, privacy, query bounds, SQL
  injection attempts, uncertainty, rate budgets and conversation isolation/expiry.
- `test-chat-api.js`: real authenticated HTTP/temporary-SQLite workflow with a mocked provider:
  follow-ups, consent withdrawal, separate login sessions, Milker reads, safe fallback and no writes.
- `test-assistant-ui.js`: DOM-stub tests for opt-in, language, context IDs, clearing, escaping,
  safe source links, fallback labels and duplicate submissions. Not visual browser QA.
- Existing API/calculator/reference/structural tests still run through `npm run release-check`.

Mock success is not live DeepSeek acceptance. After deployment test: Chinese herd count → follow-up
dry-cow list → English translation → product-label comparison → unknown tag → write request (no
write) → sharing off/new chat. Compare server source facts with the ordinary pages. Ask unrelated
non-clinical/general questions to check it no longer returns a fixed unsupported-question template.
