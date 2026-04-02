# Personal AI Agent — Complete Design Document
*Version 2.0 — March 2026*

---

## Vision

A personal AI agent with two core purposes:

1. **Second Brain** — knows everything about your life. People, events, tasks, facts, relationships. Remembers them, surfaces them when relevant, answers questions about them.

2. **Agent Runner** — executes arbitrary tasks on demand, on schedule, or on recurring triggers. Tasks are expressed as generated TypeScript scripts, not hardcoded logic.

Runs on a Mac Mini (16GB RAM, large SSD) at home, behind a Tailscale VPN. No external access except Tailscale-authenticated connections.

---

## LLM Strategy

Two models, routed by task complexity:

| Model | Role |
|---|---|
| **qwen3:8b** (local, Ollama) | Fact extraction, tagging, keyword assignment, simple mechanical agent steps |
| **claude-sonnet** (via Claude Code Max subscription) | Entity resolution, world-verify reasoning, New Agent Mode interviews, code generation, output review, interactive reasoning |

All LLM calls are logged with input, output, estimated cost, and pipeline stage. Sonnet is accessed through a dedicated Claude Code session on a Max subscription — not via direct API — to avoid per-token costs on reasoning tasks. Model assignment is configurable per agent and per pipeline stage.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      CLIENT LAYER                           │
│          iPhone App (Swift/SwiftUI) · Claude Code           │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTPS over Tailscale
┌────────────────────────▼────────────────────────────────────┐
│                    BRIDGE SERVER                            │
│         HTTP API · Session Pool Manager · Push Notif        │
└──────────────┬──────────────────────────┬───────────────────┘
               │ Custom Channel            │ Direct MCP calls
               ▼                          ▼
┌──────────────────────────┐   ┌──────────────────────────────┐
│  CLAUDE CODE SESSION(S)  │   │        MCP SERVERS           │
│  tmux · Mac Mini         │◄──┤  memory · files · browser    │
│  Sonnet via Max sub      │   │  email · scheduler · web     │
└──────────────────────────┘   └──────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│                    MEMORY STORE                             │
│          PostgreSQL + pgvector (single instance)            │
│   Factoids · Facts · Relationships · Fact Queue             │
│   Recency Context · Agent Registry · Schedule · Logs        │
└────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    SCHEDULED LAYER                          │
│      Scheduler → Agent Scripts (tsx) → Agent SDK           │
│                       │                                     │
│                        └──→ Channel (when reasoning needed) │
└─────────────────────────────────────────────────────────────┘
```

---

## The Bridge Server

A lightweight HTTP server running permanently on the Mac Mini. It is the single entry point for all client requests.

### Responsibilities

- Receive requests from the iPhone app and Claude Code dev sessions over HTTPS/Tailscale
- Maintain and manage the Claude Code session pool
- Route requests to available sessions via the custom channel plugin
- Return structured responses to clients
- Send push notifications for proactive agent events
- Queue overflow requests when all sessions are busy

### Why No Separate Orchestrator API

The bridge plus Claude Code session with MCP access together serve as the orchestrator. The channel is the wire between them. This avoids a separately maintained HTTPS API layer and routes all reasoning through the Max subscription instead of API tokens.

---

## Claude Code Channels — Custom Channel

Channels are a plugin-based feature built on MCP, launched by Anthropic on March 20, 2026. A channel is an MCP server running as a subprocess of Claude Code, communicating over stdio. It receives incoming events and pushes them into the active session. Claude processes the request with full MCP tool access and replies through the channel's reply tool.

You build a **custom channel plugin** — a small Bun/MCP server — that the bridge POSTs to. This is supported by Anthropic's Channels reference documentation and open plugin architecture.

### Request Flow

```
Client sends request to bridge
  → Bridge POSTs to custom channel MCP server
  → Channel wraps it as a channel event
  → Event pushed into Claude Code session
  → Claude Code processes with full MCP tool access
  → Result returned via channel reply
  → Bridge returns structured result to client
```

### Security

The channel uses a pairing/allowlist model. Only the bridge's authenticated sender ID gets through. Messages from unpaired sources are silently dropped. No inbound ports are exposed — the plugin polls outward.

---

## Session Pool

The bridge manages a pool of Claude Code sessions, each running in a detached tmux session on the Mac Mini.

### Why tmux

The Mac Mini is headless (no monitor) but Claude Code runs as a fully interactive terminal application inside detached tmux sessions — not in a special headless mode. This means:

- No behavioral differences from an interactively-started session
- Full channel plugin support with no unknowns
- Debuggable — SSH in and `tmux attach -t agent-1` to watch live
- Sessions survive SSH disconnects — tmux owns the process

### Launching a Session

```bash
tmux new-session -d -s "agent-1" "claude --channels bridge-channel"
```

The new session reads `.mcp.json` at startup and connects to the bridge channel automatically.

### Session State

Tracked in memory by the bridge (optionally persisted to Postgres for restart resilience):

```
session_id        string — tmux session name (e.g. "agent-1")
status            idle | busy | stale | dead
created           timestamp
last_used         timestamp
current_request   uuid nullable
```

### Pool Configuration

```
min_sessions        int — always keep this many warm (e.g. 1)
max_sessions        int — hard cap (e.g. 3)
session_idle_ttl    minutes before idle session is killed
spawn_cooldown      minimum seconds between spawning new sessions
request_timeout     minutes before a busy session is marked stale
```

### Pool Management Loop

Runs every 60 seconds:

1. Check each tracked session is alive via `tmux has-session -t <id>`
2. Mark dead sessions, remove from pool
3. Kill sessions idle past TTL
4. Spawn replacements if pool drops below minimum
5. Reconcile pool state against tmux reality — tmux is source of truth

### Stuck Session Handling

If a request has not completed within `request_timeout` minutes, the bridge marks the session stale, kills it, removes it from the pool, and requeues the request to a fresh session.

---

## Three Runtime Modes

### 1. Interactive

Client-initiated requests that need reasoning.

```
iPhone / Claude Code → Bridge → Session Pool → Claude Code Session
                                               (Sonnet, Max sub)
                                               (Full MCP access)
                                          → Bridge → Client
```

### 2. Scheduled

Autonomous agent scripts running on cron, one-time, or event triggers. Mechanical steps run directly without involving the Claude Code session.

```
Scheduler → Agent Script (tsx) → SDK → Postgres / email / web / files
```

When the script hits something requiring real reasoning:

```
Agent Script → Bridge channel → Claude Code Session → result → Script continues
```

### 3. Proactive

Agent script finishes or surfaces something needing attention. Pushed to the user without them asking.

```
Agent Script → Bridge → Push notification to iPhone
                      → Memory write
                      → Email (if configured per agent)
```

---

## Client Interfaces

### iPhone App (Swift/SwiftUI)

Native iOS app. Connects to bridge over HTTPS via Tailscale. The bridge returns structured data. The app decides how to render it:

| Context | Rendering |
|---|---|
| Driving | Voice readout via text-to-speech |
| Looking at screen | Visual layout, timeline, cards |
| Background / busy | Push notification summary |

Claude Code returns content and structure. The app decides form. Clean separation between reasoning and presentation.

### Claude Code (Development Interface)

Claude Code connects to the bridge via MCP during development and testing. The same channel interface the iPhone app uses — no special dev mode.

---

## Memory Model

### Fact — the atomic unit

Every piece of information is a fact. Facts are the only primitive.

```
fact_id        UUID
title             short label
text              full content
qe_text           query expansion text (see below)
status            raw | processing | clustered | expired
is_root           bool — true if this fact is a factoid (cluster anchor)
root_id            UUID nullable — points to the factoid this fact clusters under
                  (a root factoid points to itself)
root_type         Person | Place | Organization | Event | Concept | Product | null
created           timestamp
expires_type      never | date | weighted
expires_date      timestamp nullable
expiry_weight     float 0.0–1.0
expiry_decay      float — weight reduction per day
expiry_reeval_at  timestamp
source_type       cli | email | web | file | agent
source_id         reference to originating input
provenance        {source, timestamp, confidence, human_verified}
reprocess_count   int
next_reprocess    timestamp
```

### Factoids — Emergent Cluster Anchors

A factoid is a fact that other facts cluster around. It is not a different object type — it is a fact with `is_root = true`. Factoids have a typed root (hybrid: typed anchor, flexible clustered content).

Facts cluster under a factoid via `root_id`. A factoid points to itself.

**Root type vocabulary (seed, extensible):**
`Person · Place · Organization · Event · Concept · Product`

The user (Vineel) is the central factoid — the anchor of the entire graph.

### qe_text — Living Query Expansion

Query expansion text stores alternate phrasings, synonyms, and related terms to improve semantic retrieval.

- **At extraction:** naive, generated from raw input alone
- **At each reprocessing pass:** rewritten with broader context — the factoid it belongs to, nearby clustered facts, world knowledge if enriched
- **Schedule:** 1 day → 3 days → 1 week → 2 weeks → 1 month → monthly thereafter
- **Adaptive:** if qe_text barely changed, slow down next reprocess; if it changed significantly, reprocess sooner

### Relationships — First-Class Factoids

Relationships between factoids are stored in a dedicated table, not as attributes.

```
relationship_id     UUID
from_root_id        UUID
to_root_id          UUID
type                string (e.g. "parent_of", "married_to", "colleague_of")
inverse_type        string (e.g. "child_of", "married_to", "colleague_of")
description         text nullable
created             timestamp
expiry_weight       float — relationships can end or change
source_fact_id   UUID — the factoid that established this relationship
```

**Seed relationship vocabulary:**

- Personal: `parent_of`, `child_of`, `married_to`, `sibling_of`, `friend_of`, `ex_of`
- Professional: `colleague_of`, `reports_to`, `manages`, `works_with`, `client_of`
- Possessive: `owns`, `member_of`
- Custom: open — extractor can define new types

Multi-hop traversal handled via recursive CTEs in Postgres. No graph database needed at this scale.

---

## Short-Term vs Long-Term Memory

### STM — Staging Area

Factoids land in STM immediately after extraction. Fast writes, no clustering required. Available instantly for recency disambiguation.

- Retention: hours to days (configurable)
- Swept continuously by the processor
- Not yet clustered or enriched

### LTM — Durable Memory Graph

Factoids promoted from STM after processing. Clustered, enriched, deduplicated, expiry-weighted.

- The real memory store
- qe_text is mature and reprocessed over time
- Relationship graph lives here

STM recency context is baked into a factoid's provenance before it is promoted to LTM.

---

## Global Recency Context

A single global recency context table spans all input sources — CLI, email, web, scheduled agents. Not scoped to a single session or conversation.

```
recency_context
  root_id           UUID
  last_mentioned    timestamp
  mention_count     int (within window)
  weight            float — decays with time
  window_expires    timestamp
```

Every extractor, regardless of input channel, reads from and writes to this table. An explicit full-name mention resets weight to 1.0. Weight decays with each passing day without a new mention. Decay rate is a configurable parameter.

This is the primary disambiguation mechanism. "John called me" resolves to the John mentioned most recently across all channels, not just the most prominent John in LTM.

---

## Fact Pipeline

Two separate agents with separate prompts and code.

### Stage 1: Extractor

**Model:** qwen3:8b
**Input:** Raw input of any type — CLI text, email, web page, file
**Output:** Candidate facts written to the fact queue

Responsibilities:
- Pull discrete facts from raw input
- Assign action tag: `remember`, `verify_world`, or `verify_human`
- Extract named entities from each fact (people, places, orgs, events)
- Generate naive qe_text from raw input alone
- Write to fact queue with status `pending`
- Update global recency context with any mentioned factoid candidates

Does not touch existing memory. Has no knowledge of existing factoids.

### Stage 2: Processor

**Model:** qwen3:8b for mechanical steps, Sonnet for reasoning steps
**Input:** Factoid from queue with status `pending`
**Output:** Processed facts written to LTM

#### `remember` branch
1. Semantic search for existing factoids matching extracted entities
2. Entity resolution (Sonnet): is this the same entity as an existing factoid?
3. If match → cluster fact under existing factoid
4. If no match → promote to new factoid if warranted
5. If ambiguous → Sonnet adjudicates
6. Optionally enrich via web search
7. Rewrite qe_text with full context
8. Assign expiry type, weight, and decay rate (LLM-assigned)
9. Write to LTM, update embeddings, mark queue item done

#### `verify_world` branch
1. Web search to confirm, refute, or correct the fact
2. If resolved → write corrected fact to queue as `remember`
3. If unresolved → hold, flag for later retry

#### `verify_human` branch
1. Send email to `verify@vineel.com` with the fact and context
2. Hold fact in STM pending response

### Factoid Queue

Lives in Postgres. Durable — survives crashes. A configurable throttle prevents API cost spikes and CPU saturation, particularly during bootstrap.

```
queue_id        UUID
fact_id      UUID
action          remember | verify_world | verify_human
status          pending | processing | done | failed
created         timestamp
attempts        int
last_attempt    timestamp
error           text nullable
```

---

## Clustering Strategy

Entity extraction is the primary mechanism. Semantic search and LLM adjudication support it.

**Priority order:**

1. **Entity extraction** — named entities from fact text become root candidates. "Brad Simon" appearing in 3 facts makes Brad a strong attractor.
2. **Semantic search** — nearest-neighbor search on embeddings finds related facts that reference the same entity without using the same name.
3. **LLM adjudication** — Sonnet resolves ambiguous cases.
4. **User assignment** — explicit override. "That's about Brad." Creates or assigns the root immediately. Bootstraps the graph before emergence has enough data.

---

## New Agent Mode

An interactive flow driven by Sonnet. Purpose: define, generate, and schedule a new agent script.

### The Interview

Not a fixed questionnaire — Sonnet reasons about what it still needs after each answer. Minimum required before closing:

1. What is the goal?
2. What triggers it? (one-time / cron / event-driven)
3. What does it need to read? (memory, email, web, files, browser)
4. What does it produce? (email, memory write, file, reminder, push notification)
5. How long should results persist?
6. What model should run it?
7. What should it do if it fails?

Sonnet presents a complete agent spec summary. User confirms, edits, or cancels.

### What Gets Generated

On confirmation, Sonnet generates:

1. **A TypeScript script** — the agent's executable code
2. **An agent registry entry** — stored in Postgres
3. **A schedule entry** — cron, one-time queue, or event listener row

The generated script imports from the agent SDK, has a single `run()` entrypoint, calls LLMs only where judgment is needed, and includes a `__config__` block:

```typescript
import { memory, llm, web, email, files, browser } from "../sdk";

export const config = {
  agentId: "summer-stem-finder",
  schedule: "once",
  created: "2026-03-30",
  modelHint: "sonnet",
  capabilities: ["web_search", "web_fetch", "email_send", "memory_read", "memory_write"]
}

export async function run() {
  const son = await memory.getFactoid("son");
  const results = await web.search(`residential STEM camp age ${son.age} near Chicago`);
  // ...
}
```

### Safety Gates

- **Show before run** — always display generated script and require approval
- **Sandbox first run** — dry-run mode suppresses email send and memory writes, shows what it would do
- **Edit mode** — natural language change requests cause Sonnet to rewrite the relevant section

### Complexity Assessment

| Complexity | Model assignment |
|---|---|
| Low (linear steps, no judgment) | qwen3:8b end to end |
| Medium | qwen3:8b executor, Sonnet reviewer |
| High (open-ended, multi-step reasoning) | Sonnet throughout |

User can override. Stored in agent spec.

---

## Agent Runner

### Agent Registry Schema

```
agent_id          UUID
name              string
script_path       string
config            JSONB
trigger_type      one_time | cron | event
cron_expression   string nullable
event_type        string nullable
capabilities      string[]
memory_scope      UUID[] — factoid IDs this agent can read
model             qwen | sonnet
status            active | paused | retired
created           timestamp
last_run          timestamp
last_result       text nullable
```

Agents are data, not code. Adding a new recurring task writes a row — no deployment required.

### Runtime Flow

1. **Load spec** — read agent registry entry and script
2. **Inject context** — memory scope contents, current time, previous run results
3. **Execute script** — `tsx agent_scripts/[name].ts`
4. **Tool calls** — script calls SDK functions which call real services
5. **Output capture** — collect results, execute side effects
6. **Log run** — timestamp, result summary, LLM cost, errors

Memory injection is scoped — an agent only sees factoids listed in `memory_scope`. Hard boundary.

---

## Agent SDK

The SDK is the interface Sonnet generates TypeScript against. Type definitions are included in code generation prompts, ensuring generated scripts call real functions with correct signatures.

```
sdk/
  memory.ts     getFactoid(), searchFacts(), writeFact(), writeRelationship()
  llm.ts        ask(model, prompt), embed(text)
  web.ts        search(query), fetch(url)
  browser.ts    Playwright wrapper for authenticated sessions
  email.ts      send(), readInbox(), readThread()
  files.ts      readPdf(), readXlsx(), writeXlsx()
  scheduler.ts  register(), trigger(), cancel()
```

---

## Database

**Single Postgres instance** with pgvector extension.

Core tables:
- `facts` — all facts and factoids
- `relationships` — typed edges between factoids
- `fact_queue` — durable processing queue
- `recency_context` — global entity spotlight
- `agent_registry` — agent specs
- `schedule` — cron and one-time trigger entries
- `llm_log` — all LLM calls with cost estimates
- `run_log` — agent execution history
- `session_pool` — optional persistent session state for bridge restarts

pgvector stores embeddings for facts and factoids, enabling semantic search during entity resolution and memory queries.

---

## Bootstrapping

No special pipeline. All bootstrap input goes through the standard fact extraction pipeline. The same throttle that manages live processing prevents API cost spikes during the initial backlog.

**Sources:**
1. **Markdown notes** — nested directory structure. Walk the tree, treat each file as raw input. Directory structure is signal — `people/brad-simon.md` is a strong factoid hint.
2. **Last 1000 emails** — rich signal for relationships, named entities, temporal facts, communication patterns.

Bootstrap will generate a large fact queue backlog. The processor runs it down in the background.

---

## Security Posture

- **Perimeter:** Tailscale (WireGuard) — no open ports on router
- **Secrets:** macOS Keychain — never plaintext in DB or env files
- **Bank credentials:** evaluate Plaid or similar read-only API as alternative to credential scraping
- **Sonnet routing:** all reasoning goes through Claude Code Max subscription, not raw API — minimizes direct PII exposure to API endpoints
- **Prompt injection:** agent runner confirms before executing tool calls sourced from external content (fetched pages, emails)
- **Scope isolation:** agents only access factoids listed in their memory_scope
- **Channel security:** custom channel uses pairing/allowlist — only bridge sender ID accepted, no inbound ports exposed

---

## Tech Stack by Component

| Component | What It Is | Tech Stack |
|---|---|---|
| **iPhone App** | Client UI — chat, voice, push notifications | Swift / SwiftUI / APNs |
| **Bridge Server** | HTTP entry point, session pool manager | TypeScript / Bun / Fastify |
| **Session Pool** | Manages Claude Code session lifecycle | tmux (process management) |
| **Custom Channel Plugin** | MCP server bridging bridge ↔ Claude Code | Bun / MCP stdio protocol |
| **Claude Code Sessions** | Reasoning brain, full tool access | Claude Code (Max subscription) / Sonnet |
| **MCP Servers** | Tool layer — memory, files, email, web | TypeScript / Bun / MCP protocol |
| **Browser Automation Module** | Authenticated browser sessions (banks, etc.) | TypeScript / Node.js / Playwright (isolated subprocess) |
| **Fact Extractor** | Pulls candidate facts from raw input | TypeScript / Bun / Ollama SDK (qwen3:8b) |
| **Fact Processor** | Clusters, verifies, enriches facts | TypeScript / Bun / Ollama SDK + Anthropic SDK |
| **Agent Runner / Scheduler** | Executes agent scripts on schedule | TypeScript / Bun / pg-boss |
| **Generated Agent Scripts** | Per-task automation scripts | TypeScript / Bun (runtime) |
| **Agent SDK** | Library agents generate against | TypeScript / Bun / nodemailer / xlsx |
| **Memory Store** | Relational + vector database | PostgreSQL + pgvector |
| **Local LLM** | Fast, cheap, on-device inference | Ollama / qwen3:8b |
| **Embeddings** | Semantic search vectors | Ollama / nomic-embed-text |
| **Network Security** | Zero-trust perimeter | Tailscale (WireGuard) |
| **Secrets Management** | API keys, credentials | macOS Keychain |

Note: Node.js is used only for the browser automation subprocess. Playwright is not fully compatible with Bun. The browser module exposes a simple local HTTP interface that the agent SDK calls — one clean seam. Everything else runs on Bun.

---

## Build Phases

Each phase produces something usable daily, not just something that passes a test. Hard unknowns are tackled first.

### Phase 1: Prove the Architecture
*Does the core plumbing actually work?*

The custom Claude Code channel is the biggest unknown. Everything else depends on it.

- Custom channel plugin (Bun / MCP stdio)
- Bridge server — minimal, just enough to talk to the channel
- One Claude Code session in tmux, managed by the bridge
- Session pool — spawn, reuse, kill, recover stuck sessions
- End to end: iPhone (or curl) → bridge → channel → Claude Code → response

**Exit criteria:** A message sent from your phone gets a response from Claude Code running on the Mac Mini. A dead session is automatically replaced.

---

### Phase 2: Memory Foundation
*Can the system know things?*

- Postgres + pgvector setup
- Fact and factoid schema — facts, factoids, relationships, recency context
- Fact extractor (qwen3:8b via Ollama)
- Minimal fact processor — remember branch only, no verify yet
- Basic clustering — entity extraction only, no semantic search yet
- Memory read via the bridge — ask Claude Code "what do you know about Brad"

**Exit criteria:** You tell it something, it stores it, you ask about it later and get a coherent answer.

---

### Phase 3: Bootstrap
*Does it actually know you?*

- Markdown notes ingestion — walk directory tree, treat each file as raw input
- Email ingestion — IMAP, last 1000 emails
- Fact queue throttle to manage backlog
- qe_text reprocessing schedule
- Entity resolution stress test against real-world ambiguity

**Exit criteria:** The system has ingested your real life and can answer questions about people and events from your notes and email history.

---

### Phase 4: Agent Foundation
*Can it do things?*

- Agent SDK — memory, llm, web, email modules (no browser yet)
- pg-boss scheduler
- Agent runner — load spec, inject context, execute script, log result
- New Agent Mode — interview flow, script generation, registry entry
- First hand-written agent to validate the SDK

**Exit criteria:** You create an agent via New Agent Mode, it runs on schedule, emails you results, and you can ask questions about what it found.

---

### Phase 5: Full Fact Pipeline
*Close the loop on memory quality.*

Agents in Phase 4 read from memory. This phase hardens that memory before browser automation adds more complex data sources.

- Semantic clustering via pgvector nearest-neighbor
- verify_world branch — web search to confirm, refute, or correct facts
- verify_human branch — email to verify@vineel.com + response loop
- qe_text reprocessing with full relational context
- Expiry decay and re-evaluation

**Exit criteria:** The system catches a wrong fact, verifies it against the web, corrects it, and emails you to confirm an ambiguous one.

---

### Phase 6: Browser Automation
*The hardest capability — isolated and proven before anything depends on it.*

- Node.js Playwright subprocess
- Local HTTP interface exposed to agent SDK
- Authentication session management
- Portfolio tracker as the real-world test

**Exit criteria:** Portfolio tracker logs into your banks, grabs balances, writes to a spreadsheet, and emails you a report. Every day.

---

### Phase 7: iPhone App
*Real interface — by now you know exactly what the API needs to look like.*

- Swift/SwiftUI chat interface
- Push notifications via APNs
- Voice rendering (text-to-speech)
- Tailscale-authenticated HTTPS

**Exit criteria:** You interact with your agent exclusively from your phone for a week without touching a terminal.

---

## Open Design Questions (Next Round)

- Custom channel plugin implementation — Bun script, MCP stdio protocol details
- Bridge request/response format — structured data schema between bridge and clients
- Push notification infrastructure — APNs integration from Mac Mini
- Session warm-up strategy — pre-warming sessions at certain times of day
- Bridge restart resilience — recovering session pool state after a bridge crash
- Factoid query interface — natural language to Postgres, how you ask what the system knows
- Email ingestion mechanics — IMAP polling interval, threading, deduplication
- The `verify@vineel.com` response loop — how email replies feed back into the pipeline
- Observability — queue depth, LLM spend, agent run history dashboard
