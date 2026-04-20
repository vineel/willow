# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Willow is a personal AI agent system with three core purposes: a **Second Brain** (memory graph of people, events, facts, relationships), a **Personal Information Bus** (email ingestion, classification, interest matching, and action execution), and an **Agent Runner** (scheduled/on-demand TypeScript agent scripts). It runs on a Mac Mini behind Tailscale VPN.

## Architecture Summary

**Three LLM tiers, one subscription:**
- **Local model** (Gemma 4 via LM Studio) — mechanical work: classification, extraction, tagging, keyword assignment
- **Haiku** (via Anthropic API) — fallback for local model failures (after sensitivity check)
- **Claude Sonnet** (via `claude -p` on Max subscription) — reasoning: action execution with MCP tools, entity resolution, judgment calls

**Key components (all TypeScript/Bun except where noted):**
- **Bridge Server** (Fastify) — single HTTP entry point on Mac Mini
- **Memory Store** — PostgreSQL + pgvector; facts cluster under factoids via `parent_factoid_id`; relationships are first-class table
- **PIB Pipeline** — JMAP adapter → entity resolver → triage → interest check → classify → extract → dispatch
- **Agent Runner** — Graphile Worker scheduler, executes agent tasks on cron
- **MCP Servers** — memory, triage, interests, notify, web, pipeline (6 servers)

## PIB (Personal Information Bus)

Email ingestion and action pipeline. Lives in `pib/`.

### Pipeline Shape

```
[JMAP Adapter]  Fetch emails via Fastmail JMAP API
      │         Incremental sync via state tokens
      │         Skip "willow" folder (notifications)
      │         for-willow → flag + allowlist sender
      │         not-for-willow → blocklist sender
      ▼
[Entity Resolver]  Address → factoid lookup via app.entity_address
      │            Create new factoids for unknown senders
      │            Update recency_context
      ▼
[Triage Rules]  Priority-ordered rule evaluation (no LLM)
      │         User rules (priority 1) > system rules (400+)
      │         noise → skip, everything else → continue
      ▼
[Interest Check]  Keyword + domain match against app.interest (no LLM)
      │           If match → mark for interest-guided extraction
      ▼
[Classification]  LLM call #1 (local, Haiku fallback)
      │           Assign intent category + subcategory from taxonomy
      ▼
[Extraction]  LLM call #2 (local, Haiku fallback) — conditional
      │       Only when intent.requires_parsing or interest match
      │       Schema-guided JSON extraction
      ▼
[Dispatch]  Match interest → compose prompt + execute via claude -p
            Sonnet with scoped MCP tools (notify + web + memory)
```

### Key Concepts

- **Interests** — standing instructions: "watch for concerts." Keywords + domains + extraction schema + action_prompt. Created via conversation through the interests MCP server. Auto-generates companion triage rules for source domains.
- **Triage rules** — field-level pattern matching (from_domain, from_address, subject, header). No LLM. Priority-ordered, first match wins.
- **Intent taxonomy** — 24 categories in `app.intent` (transactional, alert, subscription, entertainment, calendar, noise, relationship). Extensible.
- **Action prompts** — natural language instructions on interests, executed by `claude -p --model sonnet` with MCP tools when a match is found.

### PIB Files

```
pib/
  jmap/              — JMAP client, session, query, notify, types
  triage/            — engine, rules (Postgres-backed), types
  normalizer.ts      — JMAP email → CanonicalEvent
  entity-resolver.ts — address → factoid lookup + creation
  interest-matcher.ts — keyword + domain matching
  classify.ts        — LLM classification with taxonomy + interest context
  extract.ts         — conditional schema-guided extraction
  dispatch.ts        — interest action dispatch
  action.ts          — claude -p execution with scoped MCP config
  pipeline.ts        — full pipeline orchestrator (reusable)
  digest.ts          — collect + format + send daily digest
  worker.ts          — Graphile Worker cron runner
  fetch.ts           — CLI entry point (--triage, --classify, --dispatch)
  config.ts          — DB connection, secrets, folder config
  state.ts           — Postgres-backed sync state
  ingest.ts          — CanonicalEvent → source_note writer
  signal-folders.ts  — for-willow / not-for-willow handling
```

### PIB CLI

```bash
bun run pib:fetch -- --folder inbox --limit 50 --dispatch   # full pipeline
bun run pib:fetch -- --folder inbox --limit 10 --triage     # triage only
bun run pib:fetch -- --folder inbox --classify              # triage + classify
bun run pib:worker                                          # start cron worker
bun run pib:digest:preview                                  # preview digest
bun run pib:digest:send                                     # send digest now
```

### PIB Cron (via Graphile Worker)

- `pib_ingest` — every 15 minutes: inbox + for-willow + not-for-willow
- `pib_digest` — daily at 8am: send digest email

## MCP Servers

| Server | Location | Tools | Purpose |
|---|---|---|---|
| `willow-memory` | `mcp/memory-mcp/` | search, add, search_keywords | Fact/factoid search and creation |
| `willow-triage` | `mcp/triage-mcp/` | list_rules, add_block_rule, add_block_domain, add_allow_rule, add_custom_rule, test_triage | Triage rule management |
| `willow-interests` | `mcp/interests-mcp/` | create_interest, list_interests, update_interest, disable_interest | Standing interest management |
| `willow-notify` | `mcp/notify-mcp/` | send_notification, send_email | JMAP email sending |
| `willow-web` | `mcp/web-mcp/` | web_search, web_fetch | Brave Search API + page fetch |
| `willow-pipeline` | `mcp/pipeline-mcp/` | pipeline_status, run_now, digest_preview, send_digest | Pipeline operations |

All servers use McpServer + zod pattern. Run with `bun run --silent` (required for MCP stdio).

## Database Schema

All in `app` schema (PostgreSQL + pgvector). Key tables:

**Memory subsystem:** `source_note`, `fact`, `fact_relationship`, `fact_queue`, `recency_context`

**PIB tables:** `entity_address`, `intent`, `triage_rule`, `interest`, `intent_handler`, `agent_subscription`, `source_adapter_state`, `handler_execution`

**Bridge/Agent:** `agent_registry`, `schedule`, `run_log`, `llm_log`, `session_pool`, `conversation`, `conversation_message`

Schema: `db/schema.sql` (full), `db/migrations/001-pib-tables.sql` (PIB migration)

## Fastmail Setup

| Component | Value |
|---|---|
| JMAP session endpoint | `https://api.fastmail.com/.well-known/jmap` |
| Notification alias | `willow-notification@vineel.com` |
| Notification folder | `willow` (Fastmail rule routes notifications here) |
| Priority folder | `for-willow` (process + allowlist sender) |
| Block folder | `not-for-willow` (blocklist sender) |
| Secrets | macOS Keychain: `fastmail-token`, `brave-api-key` |

## Critical Gotchas

- Always use `bun run --silent` for MCP servers — Bun stdout corrupts MCP stdio
- JMAP `htmlBody` must be omitted when no HTML — Fastmail returns `invalidProperties` otherwise
- JMAP `onSuccessDestroyEmail` — use for self-notifications only, NOT for external sends
- JMAP identity must match from address — use the identity for `willow-notification@vineel.com`
- LLMs put HTML in `body_text` — MCP notify server auto-detects and routes to correct MIME part
- LM Studio uses `json_schema` response format, NOT `json_object`
- Local LLM confidence is always 0.9 — don't rely on model-reported confidence for small models

## Tech Stack

- **Runtime:** Bun (Node.js only for Playwright)
- **Language:** TypeScript
- **HTTP Framework:** Fastify (bridge), Hono (memory)
- **Database:** PostgreSQL + pgvector
- **Local LLM:** LM Studio (Gemma 4)
- **Embeddings:** nomic-embed-text via LM Studio
- **Scheduling:** Graphile Worker
- **Process Management:** tmux (headless Mac Mini)
- **Network:** Tailscale (WireGuard)
- **Secrets:** macOS Keychain
- **Email:** Fastmail JMAP API
- **Web Search:** Brave Search API

## Design Documents

- `notes/second-architecture-doc.md` — Willow v2.1 design (current/authoritative)
- `notes/first-architecture-doc.md` — v2.0 original design
- PIB design docs live in `~/aidev/willow-experiments/fastmail-jmap-experiment-1/notes/`
