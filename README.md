# Willow

Personal AI agent system. Second brain + email pipeline + calendar integration + scheduled agents.

Runs on a Mac Mini behind Tailscale. Uses PostgreSQL, Bun, LM Studio, and Claude Code.

## Prerequisites

- [Bun](https://bun.sh) installed
- PostgreSQL running locally with a `willow` database
- [LM Studio](https://lmstudio.ai) running on port 1234 with a chat model loaded (e.g. `google/gemma-4-e4b`)
- Claude Code CLI installed (`claude` in PATH)
- macOS Keychain entries (see Setup)

## Setup

### 1. Database

```bash
# Create the database
createdb willow

# Apply the full schema (fresh install)
psql -d willow -f db/schema.sql

# Or apply just the PIB migration (if memory tables already exist)
bun run pib:migrate
```

### 2. Install dependencies

```bash
bun install
```

### 3. Secrets

Store API tokens in macOS Keychain:

```bash
# Fastmail JMAP API token
security add-generic-password -s fastmail-token -a willow -w "YOUR_TOKEN"

# Brave Search API key
security add-generic-password -s brave-api-key -a willow -w "YOUR_KEY"

# iCloud CalDAV app-specific password (generate at appleid.apple.com)
security add-generic-password -a 'vineel@vineel.com' -s willow-icloud-caldav -w "YOUR_APP_PASSWORD"
```

### 4. Seed your inbox

Run the pipeline once to pull in recent emails:

```bash
# Ingest the last 200 emails from inbox
bun run pib:run -- --folder inbox --limit 200

# Process signal folders if you've used them
bun run pib:run -- --folder for-willow --limit 100
bun run pib:run -- --folder not-for-willow --limit 100
```

### 5. Start the services

In separate tmux panes (or use the run script):

```bash
# Memory server (note ingestion + search API)
NOTES_ROOT=/path/to/your/notes bun run memory

# PIB worker (email pipeline on cron)
bun run pib:worker
```

The PIB worker runs three cron jobs:
- **pib_ingest** every 15 minutes: checks inbox + signal folders for new emails
- **pib_digest** daily at 8am: sends a digest of all digest-triaged emails + calendar this week
- **cal_sync** every 30 minutes: syncs iCloud Calendar via CalDAV, extracts todos and facts

## Runtime agent

The interactive Claude Code agent runs from `~/willow-runtime-workspace/`. It has access to all MCP servers and can manage your email pipeline through conversation.

```bash
cd ~/willow-runtime-workspace
claude
```

Then talk to it naturally:

- "Block everything from zdnet.com"
- "Watch for Disney musicals at Paper Mill Playhouse, notify me and email Stephanie"
- "What's in my pipeline?"
- "Show me the digest preview"
- "Run the pipeline now"

## Commands

### Email Pipeline

| Command | Description |
|---|---|
| `bun run pib:run` | Run the full pipeline once (logged to `/tmp/willow-runtime.log`) |
| `bun run pib:run -- --folder inbox --limit 50` | Run with options |
| `bun run pib:worker` | Start the cron worker (ingest every 15min, digest at 8am) |
| `bun run pib:fetch -- --folder inbox --limit 10 --triage` | Interactive CLI: fetch + triage (stdout) |
| `bun run pib:fetch -- --folder inbox --limit 10 --classify` | Interactive CLI: + classification |
| `bun run pib:fetch -- --folder inbox --limit 10 --dispatch` | Interactive CLI: + action execution |
| `bun run pib:digest:preview` | Preview what the next digest would contain |
| `bun run pib:digest:send` | Send the digest immediately |
| `bun run pib:digest:list` | List last 10 digested emails (use `-- --limit N` for more) |
| `bun run pib:digest:test -- --last 10` | Send a test digest with the last N items |
| `bun run pib:digest:test -- <id> ...` | Send a test digest for specific fact IDs |
| `bun run pib:migrate` | Run the PIB database migration |

### Portfolio

| Command | Description |
|---|---|
| `bun run pib:portfolio` | Fetch live quotes, value the portfolio, send a Mid-Day report to the willow folder |
| `bun run pib:portfolio premarket` | Same, as Pre-Market report (no North Stars / Big Movers section) |
| `bun run pib:portfolio postclose` | Same, as Post-Close report |
| `bun run pib:portfolio -- --dry-run` | Compute and print the total without sending the report email (use for ad-hoc lookups) |
| `bun run pib:portfolio:migrate` | Run the portfolio_valuation table migration (one-time, for Week's Change snapshots) |

The worker cron also runs this automatically on weekdays: 9:15 ET (pre-market), 12:30 ET (mid-day), 4:15 ET (post-close). Mid-day and post-close reports include a **North Stars** section (AAPL, NVDA always) and a **Big Movers** section (any held ticker with an absolute move >=2% vs. previous close). Each non-dry run also writes a snapshot to `app.portfolio_valuation`; the **Post-Close** report renders a **Week's Change** section comparing today's total to the first pre-market snapshot of the current ET week (omitted if no pre-market snapshot exists yet for the week).

### Calendar

| Command | Description |
|---|---|
| `bun run cal:sync` | Run a full calendar sync + extraction (manual trigger) |
| `bun run cal:extract` | Re-run extraction on pending events |
| `bun run cal:status` | Show synced calendars, extraction stats, upcoming events |
| `bun run cal:migrate` | Run the calendar database migration |

### Memory

| Command | Description |
|---|---|
| `NOTES_ROOT=/path/to/notes bun run memory` | Start memory server (file watcher + API + worker) |
| `NOTES_ROOT=/path/to/notes bun run memory:dev` | Start with auto-reload |
| `NOTES_ROOT=/path/to/notes bun run memory:status` | Show ingestion status |
| `NOTES_ROOT=/path/to/notes bun run memory:retry` | Retry failed ingestions |
| `bun run memory:clear` | Clear all memory data |

### MCP Servers

These run as stdio processes, started automatically by Claude Code via `.mcp.json`:

| Server | Tools |
|---|---|
| `willow-memory` | `memory_search`, `memory_add`, `memory_search_keywords` |
| `willow-triage` | `list_rules`, `add_block_rule`, `add_block_domain`, `add_allow_rule`, `add_custom_rule`, `test_triage` |
| `willow-interests` | `create_interest`, `list_interests`, `update_interest`, `disable_interest` |
| `willow-notify` | `send_notification`, `send_email` |
| `willow-web` | `web_search`, `web_fetch` |
| `willow-pipeline` | `pipeline_status`, `run_now`, `digest_preview`, `send_digest` |
| `willow-todo` | `add_todo`, `list_todos`, `complete_todo`, `update_todo` |
| `willow-calendar` | `get_calendars`, `list_events`, `search_events`, `create_event`, `update_event`, `delete_event`, `find_conflicts` |
| `willow-session` | `restart_session` — clears Claude Code conversation context and reloads MCP server code by respawning the `willow-agent` tmux pane |

## LaunchAgents (auto-start & auto-restart)

Both the pipeline worker and memory server run as macOS LaunchAgents — they auto-start on login and auto-restart on crash.

| Service | Label | Plist | Log |
|---------|-------|-------|-----|
| Pipeline worker | `com.vineel.willow-worker` | `~/Library/LaunchAgents/com.vineel.willow-worker.plist` | `/tmp/willow-worker.log` |
| Memory server | `com.vineel.willow-memory` | `~/Library/LaunchAgents/com.vineel.willow-memory.plist` | `/tmp/willow-memory.log` |

```bash
# Check if services are running
launchctl list | grep willow

# Stop/start a service
launchctl stop com.vineel.willow-worker
launchctl start com.vineel.willow-worker
launchctl stop com.vineel.willow-memory
launchctl start com.vineel.willow-memory

# Disable (unload) / re-enable (load)
launchctl unload ~/Library/LaunchAgents/com.vineel.willow-worker.plist
launchctl load ~/Library/LaunchAgents/com.vineel.willow-worker.plist
launchctl unload ~/Library/LaunchAgents/com.vineel.willow-memory.plist
launchctl load ~/Library/LaunchAgents/com.vineel.willow-memory.plist

# View logs
tail -f /tmp/willow-worker.log
tail -f /tmp/willow-memory.log

# Check which code revision is running
cat /tmp/willow-worker-version.json
cat /tmp/willow-memory-version.json
```

## How the email pipeline works

```
Fastmail inbox
    |
    v
[JMAP Adapter] -- incremental sync every 15 min
    |
    v
[Entity Resolver] -- address -> factoid lookup, creates new contacts
    |
    v
[Triage Rules] -- field matching, no LLM. noise/digest/queue/flag
    |
    v
[Interest Check] -- keyword + domain matching, no LLM
    |
    v
[Classification] -- local LLM assigns intent (subscription.newsletter, alert.security, etc.)
    |
    v
[Extraction] -- local LLM pulls structured data (conditional: only when needed)
    |
    v
[Dispatch] -- executes interest action_prompts via claude -p with MCP tools
```

**Volume per 100 emails:** ~40 noise (0 LLM calls), ~60 classified (local LLM), ~15 extracted (local LLM), ~5 dispatched (Sonnet via claude -p, free on Max).

## Fastmail folders

| Folder | Purpose |
|---|---|
| `willow` | Willow's notifications to you. Never ingested. |
| `for-willow` | Drop an email here to process it and permanently allowlist the sender. |
| `not-for-willow` | Drop an email here to permanently blocklist the sender. |

## Mail sort log

Every email the pipeline touches, newest first — sender, folder it landed in (or "Inbox"), a short body preview, and a link to open it in Fastmail. Reads live from `app.fact` / `app.source_note`, so it grows automatically as the pipeline runs; nothing to run manually. Linked at the top of every daily digest.

- HTML: `http://<host>:8787/mail-log` — has a search box; typing a few words matches any email containing any of them (sender, subject, body, folder, or classification), with hits highlighted
- JSON (for Willow to query directly, e.g. via `web_fetch`): `http://<host>:8787/mail-log.json?q=word1+word2&limit=N` (`limit` defaults to 300, or 1000 when `q` is set; max 2000)

Source: `bridge/routes/mail-log.ts`.

## Logs

Everything logs to `/tmp/willow-runtime.log` in a parseable format:

```
{ISO timestamp}  {LEVEL}  [{component}]  {message}
```

Runs are separated by 2 blank lines. Each email gets one line showing its full pipeline journey.

```bash
# Follow the log
tail -f /tmp/willow-runtime.log

# Find errors
grep ERROR /tmp/willow-runtime.log

# See what happened in the last run
grep "pib.pipeline" /tmp/willow-runtime.log | tail -20
```

## Project structure

```
willow/
  pib/                  -- Email pipeline (Personal Information Bus)
    jmap/               -- Fastmail JMAP client
    triage/             -- Rule engine
    scripts/            -- CLI scripts (run-pipeline, digest-preview, etc.)
    pipeline.ts         -- Core pipeline orchestrator
    worker.ts           -- Graphile Worker cron runner (email + calendar)
    fetch.ts            -- Interactive CLI
    classify.ts         -- LLM classification
    extract.ts          -- LLM extraction
    dispatch.ts         -- Action dispatch
    action.ts           -- claude -p execution
    digest.ts           -- Daily digest (email + calendar sections)
    logger.ts           -- Structured logger
  cal/                  -- Calendar integration (iCloud CalDAV)
    caldav.ts           -- tsdav wrapper, auth, calendar discovery
    ics.ts              -- ICS parsing helpers
    sync.ts             -- 30-min sync loop (discover → fetch → upsert)
    extract.ts          -- Memory-augmented LLM extraction → todos + facts
    digest.ts           -- "Calendar this week" digest section
    scripts/            -- CLI scripts (cal-sync, cal-extract, cal-status)
  mcp/                  -- MCP servers (7)
  memory/               -- Memory subsystem (fact extraction, search, embeddings)
  bridge/               -- Bridge server (HTTP entry point)
  db/
    schema.sql          -- Full database schema
    migrations/         -- Incremental migrations
```
