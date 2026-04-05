# Willow Memory Subsystem — Design Document
*April 2026*

---

## Purpose

The memory subsystem is Willow's Second Brain: it ingests raw input (notes, emails, web pages, conversations), extracts structured facts, clusters them into a knowledge graph of people, places, events, and concepts, and serves them back to conversations and agents.

This document covers the memory subsystem only — schema, server, pipeline, models, and retrieval. Bridge, agents, and client interfaces are documented separately.

---

## Architecture: Single Bun Process

One Bun process runs three concerns: HTTP server, file watcher, and background job processing.

```
┌──────────────────────────────────┐
│  memory server (Bun)             │
│                                  │
│  ┌──────────┐  ┌──────────────┐  │
│  │ Hono     │  │ chokidar     │  │       ┌─────────────┐
│  │ HTTP     │  │ file watcher │──┼─enq──▶│ PostgreSQL   │
│  │ routes   │  └──────────────┘  │       │ + pgvector   │
│  └──────────┘                    │       └──────┬───────┘
│  ┌───────────────────────┐       │              │
│  │ Graphile Worker       │◀──────┼── dequeue ───┘
│  │ (ingest, embed, …)    │       │
│  └───────────────────────┘       │
└──────────────────────────────────┘
```

**Why a single process:** The startup reconciliation scan makes a separate watcher process unnecessary. If the server crashes, the scan catches any missed file events on restart. Postgres is the durable layer.

**How it connects to the rest of Willow:** Deferred. The memory server exposes an HTTP API. Whether the bridge is a separate process calling this API or shares the same Bun process is a deployment decision to be made later — the design works either way.

---

## LLM Strategy

All local inference runs through **LM Studio** (replacing Ollama).

| Model | Role | Access |
|---|---|---|
| **ministral-3:8b** | Fact extraction, keyword generation, entity extraction, action tagging, qe_text generation | LM Studio |
| **nomic-embed-text** | Embedding generation for semantic search | LM Studio |
| **Claude Sonnet** | Entity resolution, verify_world reasoning, ambiguous clustering adjudication | Claude Code (`claude -p`) via bridge |

ministral-3:8b was selected through a structured evaluation of 10 local models against 11 real personal notes. Key results:

- Highest composite quality score (88.5) among fully-tested models
- Best coverage (86.5) with high accuracy (96.1)
- Low hallucination rate (0.5/note) — critical for a memory system
- 100% completion rate (11/11 notes), including complex/messy input
- Native JSON output support

Runner-up: gemma3:12b (85.2, lowest hallucination rate at 0.3/note, but failed on 1/11 notes).

Note: For very personally sensitive information: credit card numbers, social security numbers, account passwords, etc. -- we must never call Claude Sonnet or any cloud provider. This information must stay on the local device. LM Studio runs on the local device, so we deem it safe. However, if the claude code conversation asks for it, we allow it to be returned. Also, the claude code conversation may save sensitive facts to memory.

### Sensitive data anonymization

When the processor needs to send a fact to Sonnet (entity resolution, clustering adjudication), it first checks if the extractor flagged the fact as containing sensitive data. If so, a local anonymization step (ministral-3:8b) replaces sensitive values with placeholders before the Sonnet call: `"CC ending in 4532"` → `"[CREDIT_CARD]"`, `"SSN 123-45-6789"` → `"[SSN]"`. Sonnet performs reasoning on the anonymized version — it doesn't need actual values to decide clustering. The real values remain in `fact.content`, never sent to cloud.


### Remote model for web page extraction (future)

Web pages require long-context attention that small local models handle poorly. When web ingestion is added, route to **GPT-5.4 nano** ($0.002/page) or **Claude Haiku 4.5** ($0.006/page). GPT 5.4 nano is preferred. Since web pages probably don't have sensitive information, we allow these to be cloud-processed.

### LM Studio configuration notes

- Set `keep_alive: "5m"` (not `-1`) to auto-unload models after idle. The `-1` setting can trigger a macOS Metal GPU teardown bug where the server hangs on model stop.
- `num_predict` caps output tokens — so we do not use it. Prompts continue to their completion.
- `num_ctx` is the total context window (input + output). We set it to the maximum for the model.

---

## Database Schema

Single Postgres instance with pgvector extension. All tables use singular naming convention and live in the `app` schema.

### `source_note` — the original input

Every raw input is recorded before extraction begins. Facts point back to their source.

```sql
CREATE TABLE app.source_note (
    source_note_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_type     TEXT NOT NULL,
        -- open vocabulary: file, email, web, conversation, cli, agent
    filename        TEXT,            -- for files
    url             TEXT,            -- for web pages
    original_id     TEXT,            -- email Message-ID, conversation session id, etc.
    title           TEXT,            -- email subject, page title, filename
    summary         TEXT,            -- short LLM-generated summary
    raw_text        TEXT NOT NULL,   -- full original content as fed to extractor
    content_hash    TEXT,            -- for change detection on re-ingest
    metadata        JSONB,           -- source-type-specific fields
        -- email: {from, to, cc, date, thread_id}
        -- file:  {directory, mime_type, size_bytes}
        -- web:   {fetched_at, status_code}
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `fact` — the atomic unit

Every piece of information is a fact. Factoids (cluster anchors) are facts with `is_factoid = true`.

```sql
CREATE TABLE app.fact (
    fact_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_note_id  UUID REFERENCES app.source_note(source_note_id),
    source_ordinal  INT,             -- extraction sequence within source (1, 2, 3…)
    title           TEXT,            -- short label
    content         TEXT NOT NULL,   -- full fact text
    keywords        TEXT[],          -- LLM-extracted keywords for search
    embedding       vector(768),     -- nomic-embed-text

    -- Factoid clustering
    is_factoid      BOOLEAN NOT NULL DEFAULT false,
    parent_factoid_id UUID REFERENCES app.fact(fact_id),
        -- set by the processor when clustering a fact under a factoid
        -- NULL for unclustered facts (fresh from extractor) and top-level factoids
        -- can point to a factoid that itself has a parent, enabling multi-level clustering
    factoid_type    TEXT,
        -- Person, Place, Organization, Event, Concept, Product
        -- only set when is_factoid = true

    -- Query expansion
    qe_text         TEXT,            -- alternate phrasings, synonyms, related terms
        -- at extraction: naive, from raw input alone
        -- at each reprocess: rewritten with broader context

    -- Memory lifecycle
    memory_type     TEXT NOT NULL DEFAULT 'short_term',
        -- short_term: staging area, not yet clustered/enriched
        -- long_term: promoted after processing
    status          TEXT NOT NULL DEFAULT 'raw',
        -- raw, processing, clustered, expired
    is_active       BOOLEAN NOT NULL DEFAULT true,

    -- Expiry
    expires_type    TEXT NOT NULL DEFAULT 'never',
        -- never, date, weighted
    expires_date    TIMESTAMPTZ,
    expiry_weight   FLOAT,           -- 0.0–1.0
    expiry_decay    FLOAT,           -- weight reduction per day
    expiry_reeval_at TIMESTAMPTZ,

    -- Confidence & verification
    confidence      FLOAT,           -- 0.0–1.0
    human_verified  BOOLEAN NOT NULL DEFAULT false,

    -- Reprocessing schedule
    reprocess_count INT NOT NULL DEFAULT 0,
    next_reprocess  TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `fact_relationship` — typed edges between factoids

Relationships are first-class, not attributes. Stored in a dedicated table.

```sql
CREATE TABLE app.fact_relationship (
    relationship_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_factoid_id UUID NOT NULL REFERENCES app.fact(fact_id),
    to_factoid_id   UUID NOT NULL REFERENCES app.fact(fact_id),
    type            TEXT NOT NULL,    -- parent_of, married_to, colleague_of, owns, …
    inverse_type    TEXT,             -- child_of, married_to, colleague_of, …
    description     TEXT,
    expiry_weight   FLOAT,           -- relationships can end or change
    source_fact_id  UUID REFERENCES app.fact(fact_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Seed relationship vocabulary:**
- Personal: `parent_of`, `child_of`, `married_to`, `sibling_of`, `friend_of`, `ex_of`
- Professional: `colleague_of`, `reports_to`, `manages`, `works_with`, `client_of`
- Possessive: `owns`, `member_of`
- Custom: open — extractor can define new types

Multi-hop traversal via recursive CTEs in Postgres. No graph database needed at this scale.

### `fact_queue` — application-level pipeline state

The `fact_queue` table is the application's view of pipeline state — what action each fact needs, what stage it's in, how many times it's been attempted. Graphile Worker handles the execution mechanics (scheduling, retries, concurrency) using its own internal `graphile_worker.jobs` table. When a fact is enqueued, app code inserts a `fact_queue` row *and* adds a Graphile `process_fact` job referencing the `queue_id`.

This separation gives clean observability ("how many verify_human facts are pending?") without coupling application semantics to Graphile's internal schema.

```sql
CREATE TABLE app.fact_queue (
    queue_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fact_id     UUID NOT NULL REFERENCES app.fact(fact_id),
    action      TEXT NOT NULL,       -- remember, verify_world, verify_human
    status      TEXT NOT NULL DEFAULT 'pending',
        -- pending, processing, done, failed
    attempts    INT NOT NULL DEFAULT 0,
    last_attempt TIMESTAMPTZ,
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

A configurable throttle prevents LLM saturation and CPU spikes, particularly during bootstrap.

### `recency_context` — global entity spotlight

Spans all input sources (CLI, email, web, agents). Not scoped to a single session.

```sql
CREATE TABLE app.recency_context (
    factoid_id      UUID PRIMARY KEY REFERENCES app.fact(fact_id),
    last_mentioned  TIMESTAMPTZ NOT NULL,
    mention_count   INT NOT NULL DEFAULT 1,
    weight          FLOAT NOT NULL DEFAULT 1.0,  -- decays with time
    window_expires  TIMESTAMPTZ NOT NULL
);
```

Every extractor, regardless of input channel, reads from and writes to this table. An explicit full-name mention resets weight to 1.0. Weight decays daily without new mentions. This is the primary disambiguation mechanism — "John called me" resolves to the most recently mentioned John across all channels.

---

## Fact Pipeline

Two stages, two separate agents with separate prompts and code.

### Stage 1: Extractor

**Model:** ministral-3:8b via LM Studio
**Input:** Raw input of any type
**Output:** Candidate facts written to `fact` table + `fact_queue`

Responsibilities:
1. Create a `source_note` record for the raw input
2. Pull discrete facts from raw input
3. Assign action tag: `remember`, `verify_world`, or `verify_human`
4. Extract named entities from each fact (people, places, orgs, events)
5. Generate keywords for each fact
6. Generate naive `qe_text` from raw input alone
7. Write facts with `source_note_id` FK and `source_ordinal` preserving extraction order
8. Enqueue each fact in `fact_queue` with status `pending`
9. Update `recency_context` with any mentioned factoid candidates

The extractor does not modify existing memory, but it performs a limited read-only lookup against existing factoids to update recency context (step 9). It is otherwise stateless — it does not cluster, enrich, or deduplicate.

### Stage 2: Processor

**Model:** ministral-3:8b for mechanical steps, Sonnet for reasoning steps (via `claude -p`)
**Input:** Facts from queue with status `pending`
**Output:** Processed facts promoted to long-term memory
**Triggered by:** The extractor. When the extractor enqueues a fact in `fact_queue`, it also adds a Graphile Worker `process_fact` job with the `queue_id` as payload. Graphile picks up jobs based on its concurrency settings (~3 workers). The processor runs continuously as long as there are jobs — no cron, no polling. During bootstrap, the queue will be deep and the processor churns through it at the configured concurrency rate.

Periodic work (qe_text reprocessing, expiry re-evaluation, STM sweep) runs on separate Graphile cron-scheduled jobs.

#### `remember` branch
1. Semantic search for existing factoids matching extracted entities
2. Entity resolution (Sonnet): is this the same entity as an existing factoid?
3. If match → cluster fact under existing factoid (set `parent_factoid_id`)
4. If no match → promote to new factoid if warranted (`is_factoid = true`)
5. If ambiguous → Sonnet adjudicates
6. Optionally enrich via web search
7. Rewrite `qe_text` with full context
8. Assign expiry type, weight, and decay rate
9. Set `memory_type = 'long_term'`, update embeddings, mark queue item done

#### `verify_world` branch
1. Web search to confirm, refute, or correct the fact
2. If resolved → write corrected fact to queue as `remember`
3. If unresolved → hold, flag for later retry

#### `verify_human` branch
1. Send email to `willow@vineel.com` with the fact and context
2. Hold fact in short-term memory pending response

---

## Clustering Strategy

**Priority order:**

1. **Entity extraction** — named entities from fact text become factoid candidates. "Brad Simon" appearing in 3 facts makes Brad a strong attractor.
2. **Semantic search** — nearest-neighbor search on embeddings finds related facts that reference the same entity without using the same name.
3. **LLM adjudication** — Sonnet resolves ambiguous cases.
4. **User assignment** — explicit override. "That's about Brad." Creates the factoid or sets `parent_factoid_id` immediately. Bootstraps the graph before emergence has enough data.

---

## Short-Term vs Long-Term Memory

Implemented as a `memory_type` enum column on the `fact` table.

### Short-term memory (staging area)
- Facts land here immediately after extraction
- Fast writes, no clustering required
- Available instantly for recency disambiguation
- Retention: hours to days (configurable)
- Swept continuously by the processor

### Long-term memory (durable knowledge graph)
- Facts promoted from short-term after processing
- Clustered under factoids, enriched, deduplicated, expiry-weighted
- `qe_text` is mature and reprocessed over time
- Relationship graph lives here

---

## qe_text — Query Expansion Text

Stores alternate phrasings, synonyms, and related terms to improve semantic retrieval.

- **At extraction:** naive, generated from raw input alone (ministral-3:8b)
- **At each reprocessing pass:** rewritten with broader context — the factoid it belongs to, nearby clustered facts, world knowledge if enriched
- **Reprocessing schedule:** 1 day → 3 days → 1 week → 2 weeks → 1 month → monthly thereafter
- **Adaptive:** if `qe_text` barely changed, slow down next reprocess; if it changed significantly, reprocess sooner

---

## File Watching & Ingestion

### chokidar watcher

Watches `NOTES_ROOT/**/*.md` with `awaitWriteFinish` (Dropbox writes files incrementally).

- Enqueues `ingest_note` jobs into Graphile Worker with `jobKey: filepath, jobKeyMode: "replace"` to deduplicate rapid Dropbox sync events
- Single endpoint concept: the worker determines new-vs-update by checking the `source_note` table (`content_hash` comparison)

### Updated-note handling

When a note changes (`content_hash` differs), the worker re-runs the extractor to produce a new candidate fact list, then uses ministral-3:8b to match candidates against existing active facts for that `source_note_id`:

1. **Match found, content unchanged** → skip (keep existing fact with its clustering, relationships, and `parent_factoid_id` intact)
2. **Match found, content changed** → update `fact.content`, `keywords`, `embedding`, `qe_text`; preserve `parent_factoid_id` and relationships; re-enqueue for processor review
3. **No match (new fact)** → insert as new short-term fact, enqueue for processing
4. **Existing fact with no matching candidate** → mark `is_active = false` (information was removed from the note); flag any relationships involving this fact for processor re-evaluation

### Startup reconciliation scan

On server start: compare file mtimes against `source_note` table, enqueue anything missed during downtime. This eliminates the need for a separate watcher process — if the server crashes, the scan catches up.

### Graphile Worker

Runs in-process, sharing DB pool and LM Studio clients.

**Job types:**
- `ingest_note` — extract facts from a new or changed file
- `generate_embeddings` — compute and store embeddings for new facts
- `process_fact` — run the processor on a queued fact
- `promote_memory` — periodic STM→LTM sweep (future)

**Concurrency:** ~3 workers (tune to Mac Mini capacity; jobs are I/O-bound on LM Studio inference).

### HTTP endpoints

Optional — primarily useful for manual triggers, backfills, and testing. The watcher handles the normal flow.

- `POST /api/ingest/note` — manually trigger ingestion of a file path
- `PATCH /api/fact/:id` — promote, edit, or merge a fact
- `GET /api/facts/initial` — retrieve initial facts for conversation seeding

---

## Retrieval: Initial Facts

Every conversation is seeded with facts from memory. Selection criteria (will need iteration):

1. **Essential identity facts** — core facts about Vineel's life (family, work, location, etc.), drawn from long-term memory with high confidence
2. **10 most recent important facts** — from `recency_context`, weighted by recency and mention frequency

The selection prompt and criteria will evolve as the knowledge graph grows and usage patterns emerge.

---

## Bootstrapping

No special pipeline — all bootstrap input goes through the standard fact extraction pipeline. The same Graphile Worker throttle that manages live processing prevents LM Studio saturation during the initial backlog.

**Sources:**
1. **Markdown notes** — walk the directory tree, treat each file as raw input. Directory structure is signal — `people/brad-simon.md` is a strong factoid hint.
2. **Last 1000 emails** — rich signal for relationships, named entities, temporal facts, communication patterns. (Future phase.)

Bootstrap generates a large `fact_queue` backlog. The processor runs it down in the background.

---

## Open Questions

- **Conversation seeding prompt** — the `initial_facts` selection criteria need experimentation once there is real data in the system
- **Graphile Worker tuning** — optimal concurrency for Mac Mini under LM Studio load
- **LM Studio API compatibility** — confirm ministral-3:8b and nomic-embed-text both work through LM Studio's OpenAI-compatible API (Vineel: we confirmed this by experiment)
- **Email ingestion mechanics** — IMAP polling, threading, deduplication (future phase)
- **`willow@vineel.com` response loop** — how email replies feed back into the pipeline (future phase)
- **Web page extraction** — GPT-5.4 nano vs Haiku 4.5 decision deferred until web ingestion is built (Vineel: GPT-5.4 nano is the winner)
- **Bridge integration** — whether the memory server runs as part of the bridge process or as a separate service
