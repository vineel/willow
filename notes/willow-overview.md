# Willow — Technical Overview

*A standalone briefing for a conversation about new features. Written 2026-04-21.*

Willow is a personal AI agent system running on a Mac Mini behind Tailscale. It is built and operated by one person (Vineel). This doc reflects the system **as built today**, not the aspirational v2.1 architecture doc — deferred pieces are called out explicitly under "Gaps."

---

## What Willow Is

Three purposes, one codebase:

1. **Second Brain** — a memory graph of people, events, facts, and relationships, built from personal notes (Dropbox markdown tree) and email. Long-term goal is a **Farley file**: a per-person dossier of everyone Vineel has met, read, or read about, with the context he's supposed to know at the next interaction. Getting people right (extraction, dedupe, factoid identity, relationship context) is load-bearing.

2. **Personal Information Bus (PIB)** — a pipeline that ingests email, classifies it, matches it against standing "interests," and executes actions (notifications, emails, memory writes, web research) via scoped Claude subprocesses. Also ingests calendar and produces a daily digest.

3. **Agent Runner** — scheduled jobs (Graphile Worker) that run pipelines, portfolio reports, calendar sync, and digests. Not yet the full "New Agent Mode" described in v2.1.

---

## Three-Tier LLM Routing

| Tier | Model | Access | Role |
|---|---|---|---|
| Local | Gemma 4 (via LM Studio on port 1234) | OpenAI-compatible HTTP | Mechanical work: classification, extraction, fact extraction, keyword tagging |
| API fallback | Haiku | Anthropic API | Fallback when local fails a sensitivity check allows it |
| Reasoning | Claude Sonnet (Max subscription) | `claude -p` subprocess | Judgment: action execution with MCP tools, entity resolution, dispatch |

Embeddings: `nomic-embed-text` via LM Studio.

**Key constraint:** Sonnet is never called via raw API — only via `claude -p` against the Max subscription, to stay within normal-usage terms and avoid per-token costs.

**Gotcha:** LM Studio requires `response_format: json_schema` (not `json_object`), and local-LLM self-reported confidence is always ~0.9 — treat it as unreliable.

---

## System Topology

```
   Dropbox notes ──┐
                   │
                   ▼
            ┌──────────────┐    ┌────────────────────────┐
            │  memory/     │◄──►│  PostgreSQL + pgvector │
            │  (Hono,      │    │                        │
            │  Bun.Glob    │    │  app.fact              │
            │  poll,       │    │  app.fact_relationship │
            │  ingest)     │    │                        │
            └──────────────┘    │  app.fact_queue        │
                                │  app.source_note       │
   Fastmail JMAP ──┐            │  app.recency_context   │
                   │            │  app.interest          │
                   ▼            │  app.triage_rule       │
            ┌──────────────┐    │  app.intent            │
            │  pib/        │◄──►│  app.entity_address    │
            │  (pipeline,  │    │  app.todo              │
            │  worker,     │    │  app.cal_event         │
            │  digest)     │    │  app.agent_registry    │
            └──────────────┘    └────────────────────────┘
                                          ▲
   iCloud CalDAV ──┐                      │
                   ▼                      │
            ┌──────────────┐              │
            │  cal/        │──────────────┘
            │  (tsdav sync)│
            └──────────────┘

   ┌──────────────────────────────────────────────────────┐
   │              Interaction surfaces                     │
   │                                                       │
   │   Claude Code agent (tmux: willow-agent)              │
   │     └─ loads 9 MCP servers via .mcp.json              │
   │     └─ runs from ~/willow-runtime-workspace/          │
   │                                                       │
   │   Slack channel (mcp/slack-channel/)                  │
   │     └─ Bolt Socket Mode, pushes messages              │
   │     └─ /todos interactive card (checkboxes + Apply)   │
   │                                                       │
   │   CLI scripts (pib:*, cal:*, memory:*)                │
   └──────────────────────────────────────────────────────┘
```

Process management: **LaunchAgents** (auto-start on login, auto-restart on crash) for the pipeline worker and memory server. tmux hosts the interactive Claude Code agent.

**Note on the bridge:** The v2.1 architecture doc describes a Fastify bridge with a tmux-based session pool, custom channel plugin, and iPhone app. In practice, `bridge/` and `bridge-channel/` exist in-repo but the iPhone app, session pool manager, and full interactive routing are not in daily use. Day-to-day interaction is via the Claude Code agent in tmux and the Slack channel. New features should assume this simpler topology unless deliberately rebuilding the bridge.

---

## Memory Data Model

All in the `app` schema. Singular naming convention.

**`source_note`** — raw input (note file, email, calendar event, web page). One row per ingested artifact. Points to a `content_hash` so re-ingestion short-circuits when content is unchanged.

**`fact`** — the atomic unit. Every piece of information is a fact.
- `is_root: bool` — true if the fact is a factoid (cluster anchor). A factoid is not a different object — it's a fact with `is_root = true` pointing to itself via `root_id`.
- `root_type` — `Person | Place | Organization | Event | Concept | Product | Account | Unknown` (extensible).
- `qe_text` — query expansion text, rewritten over time to improve semantic retrieval.
- `expires_type`, `expires_date`, `expiry_weight`, `expiry_decay` — per-fact lifecycle.
- `source_id`, `source_ordinal` — provenance + extraction order.

**`fact_relationship`** — typed edges between factoids (first-class, not attributes). Seed vocabulary: `parent_of`, `child_of`, `married_to`, `sibling_of`, `friend_of`, `colleague_of`, `reports_to`, `manages`, `owns`, `member_of`, `client_of`, etc. Extractor can invent new types. Recursive CTEs handle multi-hop traversal — no graph DB needed at this scale.

**`recency_context`** — a global "who did I just hear about" table, spanning all input channels. Primary disambiguation mechanism: "John called me" resolves to whichever John was mentioned most recently across email, notes, calendar. Weight decays daily; full-name mention resets to 1.0.

**`fact_queue`** — durable processing queue (Graphile Worker).

**Memory pipeline today:**
1. Polling watcher (`memory/watcher/watch.ts`, Bun `Glob` over `NOTES_ROOT` every 60s, with EINTR retry for Dropbox FileProvider) → enqueues `ingest_note` jobs
2. Extractor (local LLM via `memory/extractor/`) pulls candidate facts from the note
3. Facts + queue entries written to Postgres
4. **Processor (Stage 2) is deferred** — entity resolution, clustering, verify_world/verify_human branches are not built
5. Updated-note handling is "nuke-and-replace" v1 — updated LLM matching is deferred
6. Sensitivity flagging/anonymization before Sonnet is deferred

The processor being unbuilt is the single biggest memory gap. Fact extraction happens; clustering/dedupe is manual via `memory:dedupe` and `memory:reparent` scripts.

**Farley file status (2026-04-13 snapshot):** the Person factoid bucket is polluted (non-people tagged Person, duplicates of real people). Phase 1 cleanup done — extractor prompt rewritten, Account/Unknown types added, Service→Organization migration done, entity-resolver no longer defaults to Person. Phase 3 dedupe cleanup and the processor build are still ahead. See `notes/farley-file-initiative-status.md` and `notes/person-dedupe-strategy.md`.

---

## PIB — The Email Pipeline

Lives in `pib/`. Runs as a Graphile Worker cron job (`pib_ingest`, every 15 min).

```
Fastmail JMAP
     │
     ▼
[JMAP Adapter]          Incremental sync via state tokens.
     │                  Skip "willow" folder (notifications from Willow to user).
     │                  for-willow → process + allowlist sender permanently.
     │                  not-for-willow → blocklist sender permanently.
     ▼
[Entity Resolver]       email address → factoid via app.entity_address.
     │                  Creates new factoids for unknown senders (with care —
     │                  see the Person-bucket pollution issue).
     ▼
[Triage Rules]          Priority-ordered field match (from_domain, subject,
     │                  header). No LLM. User rules (priority 1) beat system
     │                  rules (400+). First match wins.
     │                  Routes to: noise | queue | digest | flag | continue.
     ▼
[Interest Check]        Keyword + domain match against app.interest.
     │                  No LLM. Interest match → extraction will be
     │                  interest-guided.
     ▼
[Classification]        LLM #1 (local, Haiku fallback).
     │                  Assigns intent from a 24-category taxonomy
     │                  (transactional, alert, subscription, entertainment,
     │                  calendar, noise, relationship, ...).
     ▼
[Extraction]            LLM #2 (local, Haiku fallback). CONDITIONAL —
     │                  only runs when intent.requires_parsing or on
     │                  interest match. Schema-guided JSON extraction.
     ▼
[Dispatch]              Matched interest → composes prompt → executes
                        `claude -p --model sonnet` with scoped MCP config
                        (notify + web + memory). Writes results back.
```

**Volume per 100 emails (approx):** ~40 noise (0 LLM), ~60 classified (local), ~15 extracted (local), ~5 dispatched (Sonnet). Sonnet dispatch is the only non-free LLM call in the email path, and it's free on the Max subscription.

**Interests** are standing user instructions created through conversation with the Claude Code agent via the `willow-interests` MCP:
- Keywords + sender domains + extraction JSON schema + `action_prompt`
- Auto-generate companion triage rules for source domains
- Example: "Watch for Disney musicals at Paper Mill Playhouse, notify me and email Stephanie"

**Triage rules** are pure field matching, no LLM. User rules are created by talking to the agent ("block everything from zdnet.com" → `add_block_domain`).

**Intent taxonomy** lives in `app.intent` (24 categories, extensible). Per-intent flags: `requires_parsing`, `default_route`, etc.

---

## Calendar Integration

Lives in `cal/`. Uses iCloud CalDAV via `tsdav`. Auth via macOS Keychain app-specific password.

- `cal:sync` — every 30 min (via worker cron): discover calendars → fetch events → upsert into `app.cal_event`
- `cal:extract` — memory-augmented LLM extraction pulls todos and facts from event titles/descriptions/attendees, writing to `app.todo` and `app.fact`
- `cal:digest` — contributes a "Calendar this week" section to the daily digest
- Write support exists (migration 006) but creation/update/delete flow through the `willow-calendar` MCP

---

## Todos

- `app.todo` table, created by calendar extraction and by the user via the `willow-todo` MCP or through Slack
- Fields: `title`, `priority (urgent|high|normal|low)`, `due_date`, `status (open|done|...)`
- **Slack interactive card** (`/todos` command): renders open todos as checkbox blocks (chunked 10 per block — Slack limit), Apply button marks checked ones as done. This is the richest interaction surface right now.

---

## Portfolio Reports

`pib/portfolio/` — fetches live quotes via `yahoo-finance2`, values holdings against a positions file, and sends an emailed report to the `willow` folder.

Worker cron on weekdays ET:
- **09:15** — Pre-Market (no "North Stars" or "Big Movers" sections)
- **12:30** — Mid-Day (includes North Stars: AAPL, NVDA always; Big Movers: any held ticker with |move| ≥ 2% vs previous close)
- **16:15** — Post-Close (same as Mid-Day)

---

## Daily Digest

`pib_digest` — sent weekdays at 6:45am ET, weekends at 8am ET (recently split). Contains:
- Emails triaged to "digest" route in the last 24h
- Calendar-this-week section
- Any pending items worth surfacing

---

## MCP Servers (9)

All use `@modelcontextprotocol/sdk` + `zod`. Run with `bun run --silent` (Bun stdout corrupts MCP stdio). Logged to stderr only.

| Server | Tools | Purpose |
|---|---|---|
| `willow-memory` | `memory_search`, `memory_add`, `memory_search_keywords` | Fact/factoid search and creation |
| `willow-triage` | `list_rules`, `add_block_rule`, `add_block_domain`, `add_allow_rule`, `add_custom_rule`, `test_triage` | Triage rule management via conversation |
| `willow-interests` | `create_interest`, `list_interests`, `update_interest`, `disable_interest` | Standing interest management |
| `willow-notify` | `send_notification`, `send_email` | JMAP email sending (self-notify via `onSuccessDestroyEmail`; external sends don't use it) |
| `willow-web` | `web_search`, `web_fetch` | Brave Search API + page fetch |
| `willow-pipeline` | `pipeline_status`, `run_now`, `digest_preview`, `send_digest` | Pipeline operations |
| `willow-todo` | `add_todo`, `list_todos`, `complete_todo`, `update_todo` | Todo CRUD |
| `willow-calendar` | `get_calendars`, `list_events`, `search_events`, `create_event`, `update_event`, `delete_event`, `find_conflicts` | iCloud CalDAV surface |
| `willow-session` | `restart_session` | Respawns the `willow-agent` tmux pane — used to reload MCP code after edits |
| `willow-slack-channel` | (internal reply tool) | Bolt Socket Mode; pushes Slack messages into the Claude Code session as MCP notifications |

**JMAP gotchas** (for anything touching email):
- `htmlBody` must be omitted when no HTML — Fastmail returns `invalidProperties` otherwise
- `onSuccessDestroyEmail` only for self-notifications, never external sends
- Identity must match the from address (for `willow-notification@vineel.com`)
- LLMs tend to put HTML into `body_text`; the notify server auto-detects and routes to the correct MIME part

---

## Scheduled Jobs (Graphile Worker)

Running in `pib/worker.ts`:

| Job | Schedule | What |
|---|---|---|
| `pib_ingest` | every 15 min | Inbox + for-willow + not-for-willow pipeline |
| `pib_digest` | 6:45am ET weekdays, 8am ET weekends | Send daily digest |
| `cal_sync` | every 30 min | iCloud CalDAV sync + extraction |
| portfolio pre-market | weekdays 09:15 ET | Pre-market report |
| portfolio mid-day | weekdays 12:30 ET | Mid-day report |
| portfolio post-close | weekdays 16:15 ET | Post-close report |

Memory ingestion has its own polling-watcher + Graphile-Worker loop inside `memory/server.ts`, separate from the PIB worker.

---

## Interaction Surfaces

1. **Claude Code agent in tmux** — `cd ~/willow-runtime-workspace && claude`. This is the primary conversational interface. The agent has all 9 MCP servers loaded via `.mcp.json`. The `runtime-workspace` holds the agent's `CLAUDE.md` and persistent context — code lives in `~/aidev/willow/` but MCP servers + agent context live outside it to separate runtime from source.

2. **Slack** — push-mode messaging to the Claude Code session via the Slack channel MCP. Also hosts the `/todos` interactive card.

3. **CLI** — `pib:*`, `cal:*`, `memory:*` bun scripts for manual runs, previews, and diagnostics.

4. **Fastmail folders** — a poor-man's UI:
   - `for-willow` → drop mail here to process + allowlist sender
   - `not-for-willow` → drop mail here to blocklist sender
   - `willow` → Willow's notifications to the user (never ingested)

---

## Tech Stack

- **Runtime:** Bun (Node.js only for Playwright if/when browser automation lands)
- **Language:** TypeScript
- **Frameworks:** Fastify (bridge), Hono (memory), `@slack/bolt` (Slack)
- **Database:** PostgreSQL + pgvector, queried via `postgres` (porsager)
- **Scheduling:** Graphile Worker
- **Local LLM:** LM Studio (Gemma 4, `nomic-embed-text`)
- **Email:** Fastmail JMAP
- **Calendar:** iCloud CalDAV via `tsdav`
- **Web search:** Brave Search API
- **Process mgmt:** tmux + LaunchAgents
- **Network:** Tailscale (WireGuard) — no open ports on the router
- **Secrets:** macOS Keychain (`fastmail-token`, `brave-api-key`, `willow-icloud-caldav`, `slack-bot-token`, `slack-app-token`, `slack-user-id`)

---

## Design Principles / Constraints

1. **Cheap work locally, expensive work sparingly.** Local LLM handles all bulk classification/extraction. Sonnet only appears at the final dispatch step where judgment matters. A 100-email batch costs ~5 Sonnet calls, all covered by the Max subscription.

2. **No per-token API billing in the hot path.** Sonnet always via `claude -p`, never via raw Anthropic API. Haiku is a fallback for local failures, not a mainline.

3. **Facts are the only primitive.** Factoids are just facts with `is_root=true`. Relationships are first-class. One table, recursive queries.

4. **Provenance is load-bearing.** Every fact points to its `source_note` with `source_ordinal`. Breaks in this chain make the memory un-auditable.

5. **User guidance flows through conversation, not config files.** Triage rules, interests, and allowlists are created by talking to the agent and persisted in Postgres. No YAML/JSON config for user behavior.

6. **Runtime-workspace separation.** MCP servers + agent's `CLAUDE.md` live in `~/willow-runtime-workspace/`, source in `~/aidev/willow/`. Don't conflate.

7. **Todo list format:** prefix each todo line with a running numeric index so items can be referenced by number in conversation.

---

## Known Gaps / Deferred

These are in the architecture doc as "designed" but not built:

- **Memory processor (Stage 2)** — entity resolution, clustering, verify_world/verify_human branches. Today, fact extraction happens but clustering/dedupe is manual.
- **Updated-note LLM matching** — v1 is nuke-and-replace on content change.
- **Recency context updates in extractor** — writes happen at PIB dispatch but not universally.
- **Sensitive data flagging** — no anonymization pass before Sonnet.
- **New Agent Mode** — the Sonnet-driven interview + script generation + registry flow described in v2.1. Agents today are hand-written.
- **Full bridge + session pool + iPhone app** — the v2.1 channel-based interactive architecture. Current interactions go through tmux Claude Code + Slack.
- **Browser automation / Playwright** — not yet. The Portfolio tracker uses Yahoo Finance instead of scraping bank sites.
- **Farley file cleanup phases 2–5** — Person bucket still polluted; dedupe scripts exist but the automated pipeline doesn't yet.
- **`PATCH /api/fact/:id`, `GET /api/facts/initial`** — endpoints not yet built.

---

## Areas Ripe for New Features (for the conversation)

Places where a thoughtful addition would move the system forward:

- **Memory processor build-out.** Single biggest unlock for the Farley file. Needs entity resolution, clustering, and a verify loop.
- **Push notifications to the phone.** APNs from the Mac Mini, or a simpler Pushover/ntfy path. Would let Willow be truly proactive.
- **Agent Runner proper.** Defining agents as rows in `agent_registry` with scheduled triggers, memory scope, and generated scripts — rather than hand-writing each.
- **Observability.** Queue depth, LLM spend, agent run history — no dashboard exists today.
- **Richer interaction surfaces.** The Slack todo card is a prototype; the same pattern could work for digest review, interest tuning, and fact confirmation.
- **Email reply loop / `verify@vineel.com`.** Close the loop on `verify_human` — email the user a question, parse the reply, feed it back into the queue.
- **Cross-channel memory writes.** Conversations in the Claude Code agent and Slack should be first-class sources feeding `source_note`, the same way email and notes already are.
- **Interest discovery.** Today the user creates interests by hand. The system could propose interests from observed email patterns.
- **Calendar ↔ memory two-way flow.** Events could seed per-person factoid updates ("met with Brad Simon on X about Y"), building the Farley file passively.

---

## Pointers

- **Authoritative design doc (aspirational):** `notes/second-architecture-doc.md` (v2.1, April 2026). Describes where the system is going. Current built state diverges — see "Known Gaps" above.
- **Farley file initiative:** `notes/farley-file-initiative-status.md` + `notes/person-dedupe-strategy.md`
- **Memory subsystem design:** `notes/memory-subsystem-design.md`, `notes/memory-subsystem/processor-design.md`
- **Schema:** `db/schema.sql` (full), `db/migrations/*.sql` (incremental)
- **Project README (day-to-day ops):** `README.md`
- **Codebase guide for Claude:** `CLAUDE.md`

---

## One-Paragraph Elevator

Willow is a single-user, single-Mac-Mini personal AI system with a PostgreSQL memory graph of facts, factoids, and relationships; an email pipeline that classifies/extracts/dispatches through a local-LLM-first, Sonnet-when-needed ladder; calendar and portfolio integrations; and a set of MCP servers that let a Claude Code agent (and Slack) run the whole thing conversationally. The two biggest open initiatives are building out the memory processor so the Farley file can accumulate clean per-person dossiers, and moving from hand-written scheduled jobs toward a proper registry-driven Agent Runner.
