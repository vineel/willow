# Calendar Integration — Architectural Plan

**Status:** Design approved, not yet implemented
**Author:** Willow + Vineel, April 2026
**Goal:** Make iCloud Calendar a first-class I/O channel for Willow, parallel to email.

## Motivation

Willow already ingests email (via PIB), classifies it, extracts todos and facts, and dispatches actions. The calendar should work the same way:

- **Inbound:** poll iCloud Calendar every ~30 min, detect new/changed events, run an LLM extraction pass, route todos to `willow-todo` and facts to `willow-memory`.
- **Outbound:** when PIB classifies an email or note as containing event-worthy information (a date, a time, a subject), draft a calendar event for one-tap confirmation.

The primary use case is family logistics: kid pickups/dropoffs, school deadlines, clubs, appointments, and Vineel's parents' medical appointments. Shared family calendars (Stephanie, kids) are essential.

## Phasing

- **Phase 1** — Read-only ingestion. Calendar → Postgres → LLM extraction → todos + facts. Daily digest surfaces what was found.
- **Phase 2** — Write path. New `willow-calendar` MCP server. PIB gains `action.calendar_event` intent that creates **draft** events for confirmation. Calendars are high-trust; no silent auto-add.
- **Phase 3 (maybe)** — Conflict detection, free/busy queries for scheduling, push-style updates.

This document covers Phase 1 in detail. Phase 2/3 are sketched at the end.

---

## Approach decision: CalDAV via `tsdav`

Two approaches were evaluated:

### Approach A — CalDAV with `tsdav` (chosen)

- Pure TypeScript, runs in Bun, auth = app-specific password on the Apple ID.
- `tsdav`'s `syncCalendars` and `smartCollectionSync` wrap server-side sync-token + ctag deltas — exactly the 30-min poll pattern we want.
- iCloud CalDAV exposes shared family calendars (confirmed by Thunderbird, eM Client, and tsdav users in the wild).
- Actively maintained library, used by Cal.com in production.
- No native code, no signing, no TCC permission prompts, no OS-version fragility.

### Approach B — EventKit via Swift helper (rejected)

- EventKit aggregates whatever Calendar.app sees (all sources, including shared iCloud and any Google calendars added to the Mac).
- **Showstopper:** macOS 14+ requires a TCC consent prompt for Calendar access, and that prompt **cannot be triggered from a LaunchAgent or any non-GUI process**. The workaround (launch the helper once interactively from Terminal.app under the logged-in GUI session, signed with a stable bundle ID, and pray TCC.db isn't reset by an OS update) is fragile for a service intended to "just work" for years.
- Adds a Swift toolchain, code signing, and packaging complexity.

### Known caveat with the chosen approach

Apple's CalDAV server has a long-standing defect: you **cannot write attendees/invitees** on events in shared calendars (see `nextcloud/server#10797` and Apple discussions). You can create, edit, and delete events on Stephanie's shared calendar — you just can't add invitees to those events. For family-logistics use ("Zeph orthodontist 3pm") this is irrelevant. If Willow ever needs to send actual meeting invites on a shared calendar, revisit EventKit.

---

## Phase 1 — Read-only ingestion

### Data model (Postgres)

Three tables, mirroring the `pib_*` pattern.

#### `cal_calendars`

One row per calendar we sync. Auto-discovered by listing the calendar home set on each sync run, so newly-shared calendars appear automatically.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `url` | text unique | CalDAV collection URL |
| `display_name` | text | |
| `ctag` | text | Collection-level change marker |
| `sync_token` | text | WebDAV sync token for `smartCollectionSync` |
| `color` | text | |
| `is_shared` | bool | True if this calendar is shared *to* Vineel by someone else |
| `owner` | text null | Email of sharer; null if Vineel owns it |
| `last_synced_at` | timestamptz | |
| `enabled` | bool default true | Lets us mute a calendar without deleting |

#### `cal_events`

Canonical event store. **Keep the raw ICS** — it's the source of truth and future-you will thank present-you when a parsing bug appears.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `calendar_id` | uuid fk | |
| `uid` | text | iCal UID |
| `etag` | text | |
| `summary` | text | |
| `description` | text | |
| `location` | text | |
| `starts_at` | timestamptz | |
| `ends_at` | timestamptz | |
| `all_day` | bool | |
| `rrule` | text | Raw RRULE string |
| `master_uid` | text null | For RECURRENCE-ID overrides, points to the master event's UID |
| `attendees` | jsonb | |
| `organizer` | text | |
| `status` | text | CONFIRMED / TENTATIVE / CANCELLED |
| `raw_ics` | text | Source of truth |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |
| `deleted_at` | timestamptz null | Soft delete so we can detect "this event disappeared" |

- Unique index on `(uid, calendar_id)`.
- Index on `(calendar_id, starts_at)` for digest queries.
- Recurring events: store the master VEVENT with its RRULE as one row; store RECURRENCE-ID overrides as separate rows with `master_uid` pointing to the master. **Expand on read, not write** — never explode an RRULE into thousands of occurrence rows.

#### `cal_event_processing`

Tracks what the LLM extraction pass has done with each event.

| Column | Type | Notes |
|---|---|---|
| `event_id` | uuid fk | |
| `content_hash` | text | Hash of summary+location+starts_at+ends_at+description |
| `processed_at` | timestamptz | |
| `extracted_todos` | jsonb | What the LLM produced |
| `extracted_facts` | jsonb | |
| `status` | text | pending / done / error |
| `error` | text null | |

The `content_hash` split matters: iCloud bumps etags for trivial reasons (alarm changes, sync metadata). We re-process only when content fields actually change.

### Sync loop — `cal/sync.ts`

Runs every 30 min via Graphile Worker, same scheduling layer as PIB.

```
1. List calendar home set via tsdav → upsert cal_calendars rows
   (this auto-discovers newly-shared calendars)

2. For each enabled calendar:
   a. Fetch collection ctag
   b. If unchanged from cal_calendars.ctag, skip — done
   c. Call tsdav.smartCollectionSync with stored sync_token
   d. For each changed/new event:
        - Parse ICS
        - Upsert cal_events row
        - If content_hash changed, mark/insert cal_event_processing row as pending
   e. For each deleted href: soft-delete cal_events row
   f. Store new sync_token + ctag on cal_calendars

3. Enqueue extraction jobs for all pending cal_event_processing rows
```

Extraction is a separate worker job per event so a single bad event can't block the sync.

### Extraction pass — `cal/extract.ts`

Dispatches via `claude -p` with a scoped MCP config — same pattern as `pib/action.ts` (writes a temp MCP config to `/tmp/`, runs `claude -p`, cleans up).

#### Pre-fetch: memory-augmented context (important)

Before dispatching, the extractor pre-fetches relevant Second Brain context and injects it into the prompt. This was an explicit requirement from Vineel and is what makes calendar extraction smart instead of mechanical.

```
1. Build a query set from the event:
   - Full summary + description (semantic)
   - Each named entity: attendees, location, organizer (narrow)

2. Run 2–3 memory_search calls in parallel
   (Per Vineel's "thorough memory search" preference — broad → narrow.)

3. If semantic returns thin results, fall back to memory_search_keywords
   on extracted tokens.

4. Dedupe, rank by relevance, cap at ~15 facts / ~2KB to keep the prompt
   focused.

5. Inject as <relevant_memory>...</relevant_memory> block in the prompt.
```

The dispatched Claude still has `memory_search` in its MCP scope, so if pre-fetched context is thin it can search for more on its own. Pre-fetch is an optimization, not a wall.

**Concrete payoff examples:**

- Event "Vinod cardiology 2pm" + memory "Vinod can't drive, Vineel takes him to appointments" → todo "Leave by 1:15 to pick up Dad" instead of just "Cardiology appt."
- Event "Book group" + memory "book group meets at Sarah's, currently reading Murderbot #7" → todo "Finish chapters 8-12 before Thursday."
- Event "Ele therapy" + memory "Ele's therapist is Dr. Kim, Tuesdays at 4" → dedup against the existing context rather than treating as new info.

#### Prompt inputs

- The event itself: summary, description, location, start/end, attendees, organizer, recurrence info
- A surrounding-events window (±2 days) for situational context — "this is the IEP meeting that the school emailed about last week"
- The memory-injected `<relevant_memory>` block

#### Expected outputs (structured JSON)

- `todos[]` → `{title, due_date, priority, reason}` — routed to `willow-todo` via `add_todo`
- `facts[]` → `{text, factoid_type, confidence}` — routed to `willow-memory` via `memory_add` (after a `memory_search` to dedupe)
- `needs_prep` (bool) — event needs pre-work beyond a simple todo (e.g., a presentation). Emits a higher-priority todo with appropriate lead time.
- `skip` (bool) — recurring noise like "lunch" shouldn't generate anything. The model decides; we don't hardcode skip lists.

#### MCP scope for dispatched Claude

- `willow-todo` (add_todo)
- `willow-memory` (memory_search, memory_search_keywords, memory_add)

**No notify in Phase 1.** Extraction is silent; findings surface in the daily digest. This avoids notification spam during the noisy early period.

### Digest integration

Extend the existing 8am digest with a **"Calendar this week"** section:

- Events in the next 7 days, grouped by day
- New todos generated from calendar events (flagged so Vineel sees the provenance)
- New facts added to memory from calendar events

This piggybacks on the existing PIB digest infrastructure — no new delivery mechanism.

### Explicitly NOT in Phase 1

- Write path (Phase 2)
- Conflict / double-booking detection
- Free/busy scheduling queries
- Real-time push (iCloud CalDAV push is unreliable; 30-min poll is fine)
- Hardcoded skip lists or filtering rules — let the LLM decide what's noise

### Open questions to resolve before building

1. **Which calendars to sync?** Personal + shared family for sure. Accordli work calendar — yes/no? Exclude US Holidays / birthdays calendars entirely?
   1. Vineel: We should sync all calendars, including Accordli, us holidays, birthdays of people I know

2. **Backfill window on first sync?** Default proposal: 30 days back + 180 days forward, then a rolling window after that.
   1. Vineel: yes

3. **Content hash fields** — include description changes, or only summary/location/time? Descriptions get edited a lot without semantic change; including them risks unnecessary re-extractions, excluding them risks missing real updates.
   1. Vineel: include desc changes. We tend to put important info in them.


---

## Phase 2 — Write path (IMPLEMENTED, April 2026)

### Design decision: No draft/approval flow

Originally planned a draft-and-confirm pattern, but Vineel found it too much friction. Instead, a dedicated **"Willow" calendar** (purple, auto-created via CalDAV) acts as the low-confidence staging area. Events appear in Calendar.app naturally — Vineel can see, move, or delete them.

### New `willow-calendar` MCP server

Lives at `mcp/calendar-mcp/server.ts`, registered in `.mcp.json`.

7 tools:

- `get_calendars()` — list available calendars with IDs
- `list_events(start_date, end_date, calendar_id?)` — query the local store, grouped by day
- `search_events(query)` — full-text search on summary/description/location
- `create_event(summary, starts_at, ends_at, ...)` — writes via tsdav + immediate sync
- `update_event(event_id, ...)` — modify via tsdav + sync
- `delete_event(event_id)` — delete via tsdav + sync
- `find_conflicts(starts_at, ends_at)` — scan local store for overlapping events

### PIB integration: confidence-based routing

When PIB classifies an email as `calendar.invite` or `calendar.change`:

1. `executeActionCalendar()` in `pib/action.ts` extracts structured data (event_name, date, time, location)
2. **High confidence** (clear date + time + name) → writes directly to the primary personal calendar
3. **Low confidence** (missing time, ambiguous) → writes to the "Willow" staging calendar
4. Events created by PIB have `source='willow'` and email provenance in the description
5. The daily digest reports how many events Willow created, prompting a Calendar.app check

No `claude -p` needed — the extraction step already produced structured data. Direct DB→CalDAV write is simpler and faster.

### Willow staging calendar

- Auto-created by `ensureWillowCalendar()` in `cal/sync.ts` on first sync
- Purple color (`#8B5CF6`), marked `is_willow = true` in `cal_calendar`
- Low-confidence events land here, visible in Calendar.app alongside everything else
- Vineel reviews and moves/deletes as needed — no separate approval mechanism

---

## Phase 3 (maybe, later)

- Conflict/double-booking alerts when new events overlap
- Free/busy aggregation across family calendars for "when is everyone free"
- Smarter recurrence handling for one-off changes to recurring series
- Possibly a small CalDAV push listener if iCloud's push behavior improves

---

## File layout (new code)

```
cal/
  sync.ts           # The 30-min poll loop
  extract.ts        # LLM extraction pass with memory pre-fetch
  ics.ts            # ICS parsing helpers
  caldav.ts         # tsdav wrapper, auth, calendar discovery
  digest.ts         # Calendar section for the daily digest
  scripts/
    cal-sync.ts     # CLI: trigger an immediate sync
    cal-extract.ts  # CLI: re-extract a specific event
    cal-status.ts   # CLI: show last sync, pending events, recent extractions
db/migrations/
  NNNN_cal_tables.sql   # cal_calendars, cal_events, cal_event_processing
mcp/calendar-mcp/      # Phase 2
  server.ts
```

Per Vineel's "prefer dev CLI scripts" preference, every recurring workflow gets a proper script in `cal/scripts/` rather than ad-hoc DB queries.
