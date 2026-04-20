# Memory Processor Design — Working Doc

Living design document for the Memory Processor ("Stage 2", `process_fact`).
Started 2026-04-19. Updated as the conversation progresses.

## Status

- **Processor is a stub today.** `memory/worker/tasks.ts:159-170` marks queue items `done` as a no-op. The real processor (Stage 2) is deferred.
- **Queue backlog:** `app.fact_queue` has 3,386 rows in `pending`. Nothing is enqueueing `process_fact` Graphile jobs either, so even the stub isn't firing.
- **One-off substitutes exist** as manual scripts in `memory/scripts/` (dedupe-factoids, entity-linker, reparent-fragments, assign-factoid-types, reprocess-all, cleanup-factoid-types, apply-skipped-audit). These approximate pieces of what the processor should do, but have to be run by hand.

## Goal of this doc

Work out what the processor should actually do — exhaustively — then narrow to an MVP and design it. Capture ideas, decisions, open questions, and the reasoning behind them as we go.

---

## Inventory: every idea ever written about the processor

Compiled from `notes/memory-subsystem-design.md`, `notes/first-architecture-doc.md`, `notes/second-architecture-doc.md`, `notes/bootstrap-memory-plan.md`, `notes/factoid-cleanup-retro.md`, `notes/person-dedupe-strategy.md`, `notes/memory-subsystem/prompt-a-plan.md`, `CLAUDE.md`, `db/schema.sql`, `memory/scripts/*.ts`, `memory/worker/tasks.ts`.

### A. Core structure
- **Two-stage pipeline** — extractor writes raw facts + enqueues; processor drains the queue. `memory-subsystem-design.md:232-282`
- **Three branches** per queue item: `remember` (cluster + enrich), `verify_world` (web check), `verify_human` (email willow@vineel.com).
- **Triggered per-job** via Graphile, not polled. Periodic maintenance (qe_text reprocess, expiry re-eval, STM sweep) runs on separate cron-scheduled jobs. `:258-261, :356`

### B. Entity resolution & clustering (the `remember` branch)
- Semantic search (pgvector) for candidate factoids matching extracted entities. `:264-265`
- Sonnet entity-resolution adjudication via `claude -p` bridge. `:265`
- **Anonymize** CC#/SSN/API keys locally (ministral) before any cloud call. `:62-64`
- Promote to new factoid "if warranted" — criteria explicitly TBD. `:266-267`
- **Multi-level hierarchy:** factoids can parent other factoids via `parent_factoid_id`. `:126-127`
- Clustering priority: (1) entity extraction → (2) semantic NN → (3) LLM adjudication → (4) explicit user assignment. `:288-292`
- **dedupe-factoids.ts** has 5 candidate blockers (norm-title, trigram, embedding, shared-address, "X from Y" attribution), 11 signal features, auto/review/reject buckets, Haiku LLM judge.
- **Reparent fragments:** 3+ facts with possessive prefix ("X's …") → find/create parent factoid, set `parent_factoid_id` on the fragments (don't merge content). `person-dedupe-strategy.md §6`
- Soft-merge via `app.fact_merge` — loser `is_active=false`, children rehomed, relationships rewired, reversible.

### C. Relationship graph
- Create `fact_relationship` edges from fact text + resolution context (parent_of, married_to, reports_to, owns, member_of, open vocabulary). `:170-189`
- Relationships have their own `expiry_weight` — they can fade/end. `:135`
- Rewire relationships on dedupe; dedupe resulting self-loops. `person-dedupe-strategy.md:208-217`

### D. qe_text reprocessing
- Extraction writes naive qe_text; processor rewrites it with full context (parent factoid, sibling facts, web-enriched knowledge). `:315-322`
- Schedule: 1d → 3d → 1w → 2w → 1m → monthly. Adaptive: slow down if unchanged, speed up if changed.
- Runs as periodic Graphile cron, not inline with `remember` branch.

### E. Memory lifecycle (STM → LTM)
- New facts land in `short_term`, available for recency disambiguation immediately. `:296-312`
- Processor promotes to `long_term` after clustering + enrichment + expiry assignment.
- **Re-ingest logic** for edited notes: content-hash check → skip / update-preserve-parent / insert / mark-inactive. Re-enqueues processor review. `:337-342`

### F. Enrichment
- Optional web search during `remember` to correct or fill out a fact (criteria TBD). `:270`
- `verify_world` branch: Brave search to confirm/refute/correct; resolved → re-enqueue as `remember`; unresolved → hold + retry. `:274-277`
- Future: GPT-5.4-nano or Haiku for long-context web page extraction. `:69`

### G. Expiry & decay
- `expires_type`: `never` / `date` / `weighted`. `:145-150`
- Processor assigns expiry type + weight + per-day decay on promotion. `:272`
- Separate periodic job re-evaluates weight; facts below threshold go `is_active=false`. `:261`

### H. Human-in-the-loop (`verify_human`)
- Email to willow@vineel.com (later `verify@vineel.com`); fact stays in STM pending reply. `:279-281`
- Response-loop mechanism **entirely deferred** — how replies feed back is an open question.

### I. Queue & orchestration
- `app.fact_queue` separate from Graphile internals — app-level observability ("how many verify_human pending?"). `:191-208`
- Throttle to avoid LLM saturation, especially during bootstrap. `:211`
- Retry on `attempts` with error categorization (permanent vs transient) — specifics TBD.

### J. Sensitivity gate
- Pattern detection (CC, SSN, API keys, passwords) — *never* route to cloud, write to `could-not-ingest.txt`. `memory/extractor/sensitivity.ts`
- For cloud-safe facts with sensitive *values*, anonymize tokens before Sonnet call; keep real values in `fact.content`. `:62-64`

### K. Existing scripts that are processor-shaped (drafts in disguise)
- `dedupe-factoids.ts`, `entity-linker.ts`, `reparent-fragments.ts`, `assign-factoid-types.ts`, `cleanup-factoid-types.ts`, `reprocess-all.ts`, `apply-skipped-audit.ts`. Each does one slice of processor work by hand.

### L. Open questions (explicitly flagged in docs)
1. What "warrants" factoid promotion? `:267`
2. When does `remember` trigger web enrichment? `:270`
3. `verify_world` retry interval / max attempts / backoff? `:277`
4. `verify_human` response loop mechanics + timeout behavior? `:281`
5. Processor concurrency tuning on the Mac Mini? `:358`
6. Namesake collisions (two "Michael Spencer"s)? `person-dedupe-strategy.md:257-263`
7. Re-embed on content update — processor's job?
8. Conflict resolution when extractor + processor + PIB all touch `recency_context`? `:251`

### M. Adjacent infrastructure already in place
- Graphile Worker running at concurrency 1 (stub processor). `memory/worker/setup.ts`
- Embeddings task (`generate_embeddings`) working. `memory/worker/tasks.ts:131`
- pgvector IVFFlat + pg_trgm indexes. `db/schema.sql`
- Bridge → `claude -p` for Sonnet-grade reasoning with MCP tools.

---

## Initial observations

- The docs describe the **steady state** (`remember` branch, expiry decay, qe_text reprocess) but are **thin on state machines** — e.g., what happens when a `verify_world` fact sits unresolved for a week.
- The **existing scripts are the best specification** of what clustering / dedupe / reparenting actually look like in practice — more concrete than the prose. A real processor is probably "orchestrate those scripts as per-fact jobs, plus enrichment and qe_text reprocess."
- The **periodic jobs** (qe_text reprocess, expiry decay, STM sweep) are logically separate from the `process_fact` per-item worker. They probably want their own Graphile cron entries rather than being folded into the main loop.

---

## Discussion log

<!-- Append new sections below as the conversation progresses. -->

### 2026-04-19 — qe_text reprocessing: what's been explored

Focused dive on what the docs and code already say about qe_text reprocessing.

**What qe_text is.** Alternate phrasings, synonyms, related terms stored alongside each fact to improve semantic retrieval. Concatenated with `content` when generating the embedding (`memory/worker/tasks.ts:145-146`). Also matched by ILIKE in keyword search (`memory/routes/search.ts:83`).

**Design as written** (`memory-subsystem-design.md:315-322`, mirrored in `first-architecture-doc.md:269-276`, `second-architecture-doc.md:441-448`):

- At extraction: ministral-3:8b produces a naive qe_text from raw input alone — no context.
- At each reprocessing pass: rewritten with broader context — parent factoid, nearby clustered facts, world knowledge if web-enriched.
- Schedule: 1d → 3d → 1w → 2w → 1m → monthly thereafter.
- Adaptive: barely-changed → slow down; significantly-changed → speed up.
- Runs as a separate Graphile cron job, not inline with per-item `process_fact`. (`:261`, `:356`)
- Cron condition: `next_reprocess <= now() AND memory_type = 'long_term'`. Update `reprocess_count` and set next `next_reprocess`.
- On note re-ingest with changed content: qe_text gets rewritten alongside content/keywords/embedding and fact is re-enqueued for processor review. (`:340`)

**Schema is ready for it.** `db/schema.sql` has `qe_text TEXT`, `reprocess_count int NOT NULL DEFAULT 0`, `next_reprocess timestamptz`, plus a partial index `idx_fact_next_reprocess WHERE next_reprocess IS NOT NULL` — exactly shaped for "pick all facts due now."

**Current DB state (2026-04-19).**
- 4,238 active facts
- 3,420 (81%) have qe_text
- 818 (19%) have no qe_text
- 0 have `next_reprocess` set
- 0 have `reprocess_count > 0` — reprocessing has never run
- Quality varies wildly across the 3,420: decent (`"docx format, Word XML structure, document format deep dive"`), thin/tautological (`"services, Bondterms"` on a fact titled "Services Offered by Bondterms"), or empty string alongside substantive content (Amazon Interview fact).

**Adjacent decisions already made.**
- `prompt-a-plan.md:53-58`: tsvector vs qe_text vs keywords was considered. Decision: v1 runs ministral for keywords + embedding model for embeddings, keeps qe_text. Experiments (smaller/faster model, or replacement) come later.
- Embedding coupling: because `textToEmbed = content + qe_text`, rewriting qe_text implies re-embedding. Not written down explicitly but mechanically required.

**Open questions specific to qe_text reprocessing.**
1. What prompt does the reprocessor use? Context inputs are listed (factoid + nearby facts + enrichment) but no prompt exists yet.
2. What counts as "barely changed" vs "significantly changed"? (Cosine similarity of old vs new qe_text? Token overlap? Edit distance?)
3. What happens to the 818 facts with no qe_text? Backfilled on first reprocess, or does reprocessing assume qe_text already exists?
4. STM facts: reprocessing is defined as LTM-only. But STM facts are searched too — is their naive qe_text fine until they graduate?
5. Does the reprocessor re-embed? Implied yes but never stated.
6. Cost ceiling? Monthly ministral pass over ~4k facts is cheap; if reprocessing ever escalates to Sonnet/Haiku for quality, cost matters.
7. Initial `next_reprocess` value on insert — extractor sets it to `now() + 1 day`? Or promotion to LTM sets it? Currently nothing sets it at all.

### 2026-04-19 — Schema reference for memory subsystem

Captured here so we don't have to keep opening `db/schema.sql` during the design conversation.

#### `app.source_note` — original input documents

```
source_note_id    uuid PK
source_type       text NOT NULL         -- file | email | web | conversation | cli | agent (open)
filename          text                  -- files: relative path
url               text                  -- web pages
original_id       text                  -- emails: Message-ID; conversations: session id
title             text                  -- email subject / page title / filename
summary           text                  -- LLM-generated short summary
raw_text          text NOT NULL         -- original content fed to extractor
content_hash      text                  -- SHA-256, for change detection on re-ingest
extracted_by      text                  -- 'local' | 'haiku'
metadata          jsonb NOT NULL        -- per-source-type fields
from_factoid_id   uuid → fact(fact_id)  -- PIB: resolved sender
source_ref        text                  -- ID in source system
received_at       timestamptz
created_at        timestamptz NOT NULL
```

Indexes: `source_type`, partial on `filename`, partial on `original_id`, unique `(source_type, source_ref)` where not null.

#### `app.fact` — atomic memory unit (factoids are facts with `is_factoid=true`)

```
fact_id           uuid PK
source_note_id    uuid → source_note
source_ordinal    int                   -- extraction order within source (1,2,3…)
title             text                  -- short label
content           text NOT NULL         -- full fact text
keywords          text[]                -- LLM-extracted
embedding         vector(768)           -- nomic-embed-text

-- Clustering
is_factoid        boolean NOT NULL default false
parent_factoid_id uuid → fact(fact_id)  -- set by processor; can chain multi-level
factoid_type      text                  -- Person|Place|Organization|Event|Concept|Product|Account|Unknown

-- Query expansion
qe_text           text                  -- naive at extraction, rewritten by processor

-- Lifecycle
memory_type       text NOT NULL default 'short_term'   -- short_term | long_term
status            text NOT NULL default 'raw'          -- raw | processing | clustered | expired
is_active         boolean NOT NULL default true

-- Expiry
expires_type      text NOT NULL default 'never'   -- never | date | weighted
expires_date      timestamptz
expiry_weight     real default 1.0                -- 0.0–1.0
expiry_decay      real default 0.0                -- reduction per day
expiry_reeval_at  timestamptz

-- Confidence
confidence        real                 -- 0.0–1.0
human_verified    boolean NOT NULL default false

-- qe_text reprocessing schedule
reprocess_count   int NOT NULL default 0
next_reprocess    timestamptz

-- PIB event-stream fields (NULL for non-PIB facts)
intent_id         uuid → intent(id)
triage_action     text  CHECK in (noise|digest|queue|flag|pending)
triage_source     text  CHECK in (header|rule|llm|manual)
triage_rule_id    uuid → triage_rule(id)
summary           text
extracted_data    jsonb
digest_queued_at  timestamptz
digest_sent_at    timestamptz

created_at        timestamptz NOT NULL
updated_at        timestamptz NOT NULL  -- trigger-maintained
```

Indexes: `status`, `parent_factoid_id`, partial on `factoid_type IS NOT NULL`, partial on `is_factoid=true`, `source_note_id`, `memory_type`, partial on `is_active=true`, partial on `next_reprocess IS NOT NULL`, IVFFlat on `embedding` (cosine, lists=100). Trigger `fact_updated_at` bumps `updated_at` on update.

#### `app.fact_relationship` — typed edges between factoids

```
relationship_id uuid PK
from_factoid_id uuid NOT NULL → fact
to_factoid_id   uuid NOT NULL → fact
type            text NOT NULL   -- parent_of | married_to | colleague_of | …
inverse_type    text
description     text
expiry_weight   real default 1.0
source_fact_id  uuid → fact     -- the fact that established this
created_at      timestamptz NOT NULL
```

Unique `(from_factoid_id, to_factoid_id, type)`. Indexes on from, to, type.

#### `app.fact_queue` — application-level pipeline state

```
queue_id        uuid PK
fact_id         uuid NOT NULL → fact
action          text NOT NULL   -- remember | verify_world | verify_human
status          text NOT NULL default 'pending'  -- pending | processing | done | failed
attempts        int NOT NULL default 0
last_attempt_at timestamptz
error           text
created_at      timestamptz NOT NULL
```

Indexes: `(status, created_at)`, `fact_id`. Separate from Graphile Worker's `graphile_worker.jobs` — this one is app semantics.

#### `app.recency_context` — global entity spotlight for disambiguation

```
factoid_id      uuid PK → fact
last_mentioned  timestamptz NOT NULL default now()
mention_count   int NOT NULL default 1
weight          real NOT NULL default 1.0   -- decays with time
window_expires  timestamptz NOT NULL
```

Index on `weight DESC`.

#### Adjacent but out-of-core

- `app.entity_address` — `(source_type, address) → factoid_id` fast lookup (e.g. "which factoid owns vineel@vineel.com").
- PIB tables: `intent`, `triage_rule`, `interest`, `intent_handler`, `agent_subscription`, `source_adapter_state`, `handler_execution` — feed the email pipeline and reference `app.fact` via `intent_id` / `triage_rule_id`.

#### Two things worth flagging for the processor

1. **`fact_merge` is NOT in the schema.** `person-dedupe-strategy.md` describes `app.fact_merge` as the dedupe audit trail, but it hasn't been created. If the processor does soft-merge, this table has to land first.
2. **`fact.status`** values `raw | processing | clustered | expired` overlap conceptually with `memory_type` and `fact_queue.status`. Need to decide whether the processor updates `fact.status` or whether it's vestigial — the current stub doesn't touch it.
