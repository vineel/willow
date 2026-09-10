# CLAUDE.md

This file provides guidance to Claude Code when working in `~/aidev/willow`.

For workspace-level orientation (sibling projects, capability overview), see `~/aidev/CLAUDE.md`.

## Project Overview

Willow is Vineel's personal AI agent system, running on his Mac Mini. Three core purposes:
1. **Second Brain** — memory graph of people, events, facts, relationships
2. **Personal Information Bus (PIB)** — email ingestion → classification → interest matching → action execution
3. **Agent Runner** — scheduled/on-demand tasks via Graphile Worker; ephemeral on-the-fly UIs (Gizmos)

Current version: **0.9.1**. Status: actively developed, single-user, production for Vineel.

## Architecture Summary

**Three LLM tiers, one Anthropic subscription:**
- **Local model** (Gemma 4 via LM Studio) — mechanical work: classification, extraction, tagging, keyword assignment
- **Haiku** (via Anthropic API) — fallback for local model failures (after sensitivity check)
- **Claude Sonnet** (via `claude -p` on the Max subscription) — reasoning: action execution with MCP tools, entity resolution, judgment calls

**Top-level components** (all Bun/TypeScript except where noted):
- **Bridge Server** (Fastify) — HTTP entry point: chat, conversation, todos web app, gizmo rendering
- **Memory Server** (Hono) — Second Brain HTTP API + extraction worker
- **PIB Worker** (Graphile Worker) — cron-scheduled email pipeline, portfolio reports, calendar sync, gizmo dispatch, digest
- **MCP Servers** — 11 native (see table below)

## Capabilities

### Email pipeline (PIB)

Lives in `pib/`. Pipeline shape:

```
JMAP Adapter        Fetch via Fastmail JMAP, incremental sync via state tokens
   │                Skip "willow" folder (notifications)
   │                for-willow → flag + allowlist sender
   │                not-for-willow → blocklist sender
   ▼
Entity Resolver     Address → factoid lookup via app.entity_address
   │                Create new factoids for unknown senders
   ▼
Triage Rules        Priority-ordered field-level match (no LLM)
   │                User rules (priority 1) > system rules (400+)
   │                noise → skip, everything else → continue
   ▼
Interest Check      Keyword + domain match against app.interest (no LLM)
   │                Match → mark for interest-guided extraction
   ▼
Classification      LLM call #1 (local, Haiku fallback)
   │                Intent category + subcategory from 24-entry taxonomy
   ▼
Extraction          LLM call #2 (local, Haiku fallback) — conditional
   │                Only when intent.requires_parsing or interest match
   │                Schema-guided JSON extraction
   ▼
Foldersort          Inbox-only, proposal-only in v0
   │                Deterministic folder_rule first-match → else LM Studio (Gemma)
   │                with enum-constrained selection from willow-secondary subfolders
   │                Writes folder_target/decided_by/reason; NO JMAP move
   ▼
Dispatch            Match interest → compose prompt + run claude -p sonnet
                    with scoped MCP tools (notify + web + memory + todo + ...)
```

Cron: ingest every 15 min, digest 6:45am ET weekdays / 8am ET weekends, calendar sync every 30 min, portfolio at 9:15/12:30/16:15 ET Mon-Fri, gizmo sweep hourly, foldersort sent-mail scan 4:30am ET daily.

### Daily digest

`pib/digest.ts`. Sections:
- Pending facts grouped by category
- Open todos (sorted by `sort_order` DESC, priority, due date)
- Calendar (upcoming window from cal/digest.ts)
- **SOPAC** — upcoming events scraped from sopacnow.org (next 30 days)
- **Movies** — most recent movie watchlist parsed from a notes description
- **Foldersort proposals** — last-24h proposed inbox moves (proposal-only in v0; review before approval)
- Footer link to the todo web app

### Memory (Second Brain)

`memory/`. Hono HTTP server + extraction worker. Facts cluster under factoids via `parent_factoid_id`. Relationships are a first-class table. Semantic search (pgvector) + keyword search. Notes from `~/Dropbox/VineelerNotes` are continuously ingested by the watcher.

Key subdirs:
- `memory/extractor/` — LLM-driven fact extraction
- `memory/watcher/` — filesystem watcher for notes
- `memory/worker/` — embedding generation queue
- `memory/dedupe/` — factoid deduplication
- `memory/scripts/` — CLI tools

### Calendar

`cal/`. iCloud via CalDAV (`tsdav`). LLM extracts events from notes. Email-classified calendar events auto-create with confidence routing — high confidence to personal calendar, low confidence to "Willow" staging calendar (purple).

### Todos

`mcp/todo-mcp/`, `bridge/routes/todos.ts`. Sources: chat, email extraction, web app, slack. `sort_order` for manual reordering. Daily digest section. Slack interactive checkbox card.

### Portfolio reports

`pib/portfolio/`. Yahoo Finance quotes via `yahoo-finance2`. Three runs Mon-Fri:
- 9:15 ET premarket
- 12:30 ET midday (with North Stars + Big Movers)
- 16:15 ET post-close (with North Stars + Big Movers + Week's Change)

Every non-dry run snapshots to `app.portfolio_valuation`. Week's Change compares the post-close total to the earliest premarket snapshot of the current ET week.

### Gizmos

`mcp/gizmo-mcp/`, `pib/gizmo-dispatch.ts`, `bridge/routes/gizmo.ts`. Ephemeral on-the-fly web UIs created from chat for structured input. On submit, a Graphile Worker task runs `claude -p sonnet` with the action_prompt + submission JSON + data_context. 24-hour TTL by default. Hourly sweep cleans expired.

### Foldersort

`mcp/foldersort-mcp/`, `pib/foldersort/`, `pib/scripts/foldersort-*.ts`. Sorts inbox mail into subfolders of `willow-secondary`. Deterministic `folder_rule` first (parallel to triage_rule, reusing `pib/triage/match.ts`); LM Studio (Gemma) fallback with enum-constrained selection from `folder_profile` rows + a `leave_in_inbox` sentinel. The `people-i-dont-know` heuristic uses `app.correspondent` — a list of addresses Vineel has emailed, populated by a one-time `bun run foldersort:scan-sent --since 365d` bootstrap and refreshed daily at 04:30 ET via the `foldersort_scan_sent_daily` cron. **Phase 1 v0 is proposal-only**: pipeline writes `fact.folder_target` + `folder_proposed_at` but never calls JMAP; the digest has a "Foldersort proposals" section for review. Approval flow + auto-apply are deferred to post-v0. MCP tools let Vineel grow the catalog conversationally — `create_profile`, `add_folder_rule_from_url`, `correct_placement`, `add_correspondent`, etc.

### Slack bridge

`mcp/slack-channel/`. Vineel's Slack DMs become MCP messages to the persistent session. Replies via `slack_reply`. Interactive todo card with checkboxes + Apply button — mark-done handling is inside the slack-channel server itself.

## MCP Servers

| Server | Source | Tools |
|---|---|---|
| `willow-memory` | `mcp/memory-mcp/` | memory_search, memory_add, memory_search_keywords |
| `willow-triage` | `mcp/triage-mcp/` | list_rules, add_block_rule, add_block_domain, add_allow_rule, add_custom_rule, test_triage |
| `willow-interests` | `mcp/interests-mcp/` | create_interest, list_interests, update_interest, disable_interest |
| `willow-notify` | `mcp/notify-mcp/` | send_notification, send_email |
| `willow-web` | `mcp/web-mcp/` | web_search, web_fetch |
| `willow-pipeline` | `mcp/pipeline-mcp/` | pipeline_status, run_now, digest_preview, send_digest |
| `willow-todo` | `mcp/todo-mcp/` | add_todo, list_todos, complete_todo, update_todo |
| `willow-calendar` | `mcp/calendar-mcp/` | get_calendars, list_events, search_events, create_event, update_event, delete_event, find_conflicts |
| `willow-gizmo` | `mcp/gizmo-mcp/` | create_gizmo |
| `willow-session` | `mcp/session-mcp/` | restart_session |
| `willow-foldersort` | `mcp/foldersort-mcp/` | list_profiles, create_profile, update_profile, disable_profile, list_folder_rules, add_folder_rule, add_folder_rule_from_url, disable_folder_rule, test_foldersort, preview_inbox_sort, correct_placement, add_correspondent, remove_correspondent, list_correspondents |
| `slack-channel` | `mcp/slack-channel/` | slack_reply, slack_post_todo_card |

All servers use `McpServer` + zod schemas. Run with `bun run --silent` (required for MCP stdio framing).

Active runtime config: `~/willow-runtime-workspace/.mcp.json`.

## Source layout

```
pib/                       Email pipeline
├── jmap/                  Fastmail JMAP client
├── portfolio/             Daily portfolio reports
│   ├── positions.ts       Parse holdings (from a notes file)
│   ├── quotes.ts          Yahoo Finance fetch
│   ├── valuate.ts         Total value + North Stars + Big Movers
│   ├── report.ts          Format + send (with Week's Change)
│   ├── storage.ts         Snapshot to app.portfolio_valuation
│   └── run.ts             Entry point (called by worker + CLI)
├── triage/                Triage engine + rule storage
├── scripts/               CLI entry points
│   ├── run-pipeline.ts    Full ingest run
│   ├── digest-preview.ts  Preview today's digest
│   ├── digest-send.ts     Send digest now
│   ├── portfolio-report.ts CLI portfolio runner
│   ├── redispatch-failed.ts Re-run failed dispatches
│   ├── gizmo-route-test.ts Smoke test for gizmo route
│   └── ...
├── worker.ts              Graphile Worker cron tasks
├── pipeline.ts            Full pipeline orchestrator (reusable)
├── classify.ts            LLM classification
├── extract.ts             LLM extraction
├── dispatch.ts            Match interest → action
├── action.ts              claude -p execution with scoped MCP config
├── gizmo-dispatch.ts      Gizmo submission handler
├── digest.ts              Daily digest composition (+ SOPAC, movies)
├── normalizer.ts          JMAP → CanonicalEvent
├── entity-resolver.ts     Address → factoid
├── interest-matcher.ts    Keyword + domain match
├── signal-folders.ts      for-willow / not-for-willow handling
├── ingest.ts              CanonicalEvent → source_note writer
├── state.ts               Postgres-backed sync state
├── fetch.ts               CLI entry point (--triage/--classify/--dispatch)
└── config.ts              DB connection, secrets, folder config

cal/                       Calendar (CalDAV + LLM extraction)
├── caldav.ts              tsdav wrapper
├── sync.ts                Sync iCloud → app.cal_event
├── extract.ts             Extract events from notes via claude -p
├── ics.ts                 ICS parsing
├── digest.ts              Calendar section of daily digest
└── scripts/               cal-sync, cal-extract, cal-status

memory/                    Second brain
├── server.ts              Hono HTTP API
├── config.ts              DB + LLM config
├── db.ts                  Postgres client
├── extractor/             LLM-driven fact extraction
├── watcher/               Notes folder watcher
├── worker/                Embedding generation
├── dedupe/                Factoid deduplication
├── routes/                HTTP route handlers
├── lmstudio/              LM Studio client
└── scripts/               CLI utilities

mcp/                       11 native MCP servers (see table above)

bridge/                    Fastify HTTP server
├── server.ts              Entry point + route registration
├── config.ts              Port, public URL, pool config
├── claude-p.ts            Spawn helper for claude binary (WILLOW_CLAUDE_BIN override)
├── db.ts                  Postgres client
├── channel-client.ts      Channel HTTP client
├── routes/
│   ├── health.ts          Health check
│   ├── agent.ts           Agent execution endpoint
│   ├── chat.ts            Chat endpoint
│   ├── conversation.ts    Conversation history
│   ├── todos.ts           Todo web app
│   └── gizmo.ts           Gizmo render + submit
├── public/
│   └── gizmo-assets/      _gizmo.css + htmx.min.js
└── session-pool/          Claude session pool management

db/
├── schema.sql             Full schema
└── migrations/
    ├── 001-pib-tables.sql
    ├── 002-todo-table.sql
    ├── 003-fact-merge.sql
    ├── 004-bootstrap-runs.sql
    ├── 005-cal-tables.sql
    ├── 006-cal-write-support.sql
    ├── 007-fact-triage-source-default.sql
    ├── 008-todo-sort-order.sql
    ├── 009-todo-source-web.sql
    ├── 010-gizmo.sql
    └── 011-portfolio-valuations.sql

scripts/                   Top-level utilities
├── brain-map.ts           Memory graph visualizer
└── person-cleanup-map.ts  Person factoid dedup helper

notes/                     Design docs, plans, working memos
stubs/                     Development stubs (chat-cli, agent-test)
```

## Database Schema

All in the `app` schema (PostgreSQL + pgvector). Key tables:

**Memory:** `source_note`, `fact`, `fact_relationship`, `fact_queue`, `recency_context`

**PIB:** `entity_address`, `intent`, `triage_rule`, `interest`, `intent_handler`, `agent_subscription`, `source_adapter_state`, `handler_execution`

**Todo / Cal / Gizmo / Portfolio:** `todo`, `cal_event`, `gizmo`, `portfolio_valuation`

**Bridge / Agent:** `agent_registry`, `schedule`, `run_log`, `llm_log`, `session_pool`, `conversation`, `conversation_message`

Full schema: `db/schema.sql`. Migration history in `db/migrations/`.

## Common CLI

```bash
# Pipeline
bun run pib:run                                            # one full pass
bun run pib:fetch -- --folder inbox --limit 50 --dispatch  # detailed CLI
bun run pib:worker                                         # start cron worker (don't — LaunchAgent does this)

# Digest
bun run pib:digest:preview
bun run pib:digest:send

# Calendar
bun run cal:sync
bun run cal:extract
bun run cal:status

# Portfolio
bun run pib:portfolio                       # midday default
bun run pib:portfolio premarket
bun run pib:portfolio postclose
bun run pib:portfolio -- --dry-run          # no send, no DB record

# Memory
bun run memory:status
bun run memory:retry
bun run memory:assess
bun run memory:brain-map

# Migrations (one-off)
bun run pib:migrate
bun run cal:migrate
bun run pib:portfolio:migrate

# Misc
bun run pib:redispatch                      # re-run failed dispatches
bun run pib:search                          # CLI email search
```

## Operational layout

LaunchAgents (auto-start on login):

| Service | Label | Plist | Log |
|---|---|---|---|
| Pipeline worker | `com.vineel.willow-worker` | `~/Library/LaunchAgents/com.vineel.willow-worker.plist` | `/tmp/willow-worker.log` |
| Memory server | `com.vineel.willow-memory` | `~/Library/LaunchAgents/com.vineel.willow-memory.plist` | `/tmp/willow-memory.log` |
| Bridge server | `com.vineel.willow-bridge` | `~/Library/LaunchAgents/com.vineel.willow-bridge.plist` | `/tmp/willow-bridge.log` |
| Chat agent | `com.vineel.willowchat` | (interactive tmux session) | `/tmp/willow-runtime.log` |

Each writes startup info to `/tmp/willow-{service}-version.json`. Manage with `launchctl list | grep willow`, `launchctl stop/start <label>`.

Interactive Claude Code session: tmux `willow-agent-2`, launched via `~/willow-runtime-workspace/run-willow.sh`.

### Installing / managing the LaunchAgents

The plists are checked in under `~/Library/LaunchAgents/`. They are NOT auto-loaded — loading is a one-time per-machine step.

```bash
# Install (load + start; also runs at next login because of RunAtLoad=true)
launchctl load ~/Library/LaunchAgents/com.vineel.willow-worker.plist
launchctl load ~/Library/LaunchAgents/com.vineel.willow-memory.plist
launchctl load ~/Library/LaunchAgents/com.vineel.willow-bridge.plist

# Verify it's loaded and running (PID non-zero = running)
launchctl list | grep willow

# Tail the log to confirm clean startup
tail -f /tmp/willow-bridge.log

# Restart (e.g. after editing source the service imports)
launchctl stop com.vineel.willow-bridge      # KeepAlive=true auto-restarts in <10s

# Disable / uninstall
launchctl unload ~/Library/LaunchAgents/com.vineel.willow-bridge.plist
```

If `launchctl load` errors with "service already loaded", `unload` first, then `load`. After editing a plist file, `unload` + `load` to pick up the change (stop/start only restarts the process, not the config).

## Hot reload — the #1 footgun

**MCP servers and LaunchAgent services hold imported code in memory.** Saving a file does NOT update what's running.

- Edit an MCP server → restart the host Claude Code session: use `willow-session.restart_session` tool, or exit tmux and re-run `run-willow.sh`.
- Edit `pib/worker.ts` or anything it imports (incl. `pib/foldersort/*`) → `launchctl stop com.vineel.willow-worker` (it auto-restarts immediately).
- Edit `memory/server.ts` or anything it imports → `launchctl stop com.vineel.willow-memory`.
- Edit `bridge/server.ts` or anything it imports (including `bridge/routes/*`) → `launchctl stop com.vineel.willow-bridge`.
- **CLI scripts (`bun run pib:*`, etc.) always read fresh source** — each invocation spawns a new Bun process. This is why a manual test can pass while the cron still runs old code.

When you commit, also surface this to Vineel if a restart is needed before the change takes effect.

## Other gotchas

- Always `bun run --silent` for MCP servers (Bun chatter corrupts stdio).
- JMAP `htmlBody` must be omitted when no HTML — Fastmail returns `invalidProperties` otherwise.
- JMAP `onSuccessDestroyEmail` works for self-notifications only, not external sends.
- JMAP identity must match from-address (`willow-notification@vineel.com`).
- LLMs put HTML in `body_text` sometimes — notify server auto-detects and routes correctly.
- LM Studio uses `json_schema` response format, NOT `json_object`.
- Local model confidence is always 0.9 — don't trust model-reported confidence for small models.
- The `WILLOW_CLAUDE_BIN` env var overrides which `claude` binary is spawned by dispatch / cal-extract / bridge.

## Fastmail setup

| Component | Value |
|---|---|
| JMAP session endpoint | `https://api.fastmail.com/.well-known/jmap` |
| Notification alias | `willow-notification@vineel.com` |
| Notification folder | `willow` (Fastmail rule routes here) |
| Priority folder | `for-willow` (process + allowlist sender) |
| Block folder | `not-for-willow` (blocklist sender) |
| Secrets | macOS Keychain: `fastmail-token`, `brave-api-key`, others |

## Tech Stack (quick recap)

Bun + TypeScript • PostgreSQL 16 + pgvector • Fastify (bridge), Hono (memory) • Graphile Worker (cron) • `@modelcontextprotocol/sdk` (stdio) • JMAP (Fastmail) • tsdav (CalDAV) • yahoo-finance2 • Brave Search • LM Studio (local LLM) • `claude -p` for Sonnet dispatch • `@slack/bolt` • macOS Keychain • tmux + launchd • Tailscale

## Design Documents

`notes/` contains design docs and plans:
- `willow-overview.md` — overall design
- `gizmo-design.md` — Gizmo system
- `todo-web-app-plan.md` — Todo web app
- `VoiceNote-iOS-Plan-v2.md` — Voice note ingestion (planned)
- `scripted-codex-workflows.md` — Scripted workflow patterns
- Earlier architecture docs in `notes/` (first-architecture, second-architecture)
- PIB design docs in `~/aidev/willow-experiments/fastmail-jmap-experiment-1/notes/`

## Conventions

- **Commits:** Conventional Commits. `feat(scope):`, `fix(scope):`, `chore:`, `docs:`, `perf(scope):`. See `git log --oneline` for tone.
- **No build step.** Bun runs TypeScript directly.
- **Per-file logger:** `const log = createLogger("pib.foo")`. Pipeline logs land in `/tmp/willow-runtime.log` and `/tmp/willow-worker.log`.
- **Memory search before web search** when looking something up about Vineel or his world — multiple rounds (broad, narrow, keyword) before falling back.
- **Top-level await** is fine. ESM only.
