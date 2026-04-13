# Farley File Initiative — Status

**Started:** 2026-04-13
**Owner:** Vineel
**Purpose:** Session-state doc. If you are a fresh Claude Code session picking this up after a restart, read this file + `notes/person-dedupe-strategy.md` + `notes/bootstrap-memory-plan.md` to catch up.

## The big picture

Vineel wants Willow's memory to function as a **farley file** — per-person dossiers of everyone he has met, read, or read about, with the context he needs next time he interacts. This is essential for Willow to be "useful in living my life" (his words, 2026-04-13), not a nice-to-have.

Audit on 2026-04-13 of `app.fact WHERE is_factoid=true AND factoid_type='Person'` found **263 rows but only ~40-50 real humans**. The rest is junk: logins, tmux commands, venues, orgs, duplicates of real people (e.g. Michael Spencer ×7, Prudential Center ×7, NVIDIA ×5). Three root causes, all since diagnosed — see `notes/person-dedupe-strategy.md` § Audit for details.

Running `bootstrap-memory-plan.md` (one-shot 2000-email historical backfill) against the current state would pour more junk into an already-broken pipeline. Cleanup **blocks** bootstrap.

## Plan (five phases)

### Phase 1 — Stop the bleeding ✅ DONE (2026-04-13)

Code changes + data migration + LaunchAgent restarts. All live.

- `pib/entity-resolver.ts:129` — unknown senders default to `Unknown` (was `Person`); noreply/no-reply → `Organization` (was `Service`).
- `memory/extractor/extract.ts:220`, `memory/routes/facts.ts:27`, `mcp/memory-mcp/server.ts:83` — whitelist now includes `Account` and `Unknown`.
- `mcp/memory-mcp/server.ts` — memory_add tool description rewritten to steer models away from guessing Person.
- `memory/extractor/prompts.ts` — rewritten: new WHAT IS A FACTOID / WHAT IS NOT sections, PEOPLE rule narrowed to "actual humans" with negative examples, ORGANIZATIONS/PLACES/ACCOUNTS/UNKNOWN sections added.
- `db/schema.sql` — comment updated.
- `package.json` — `0.2.0` → `0.3.0`.
- **Migration:** 23 `Service` factoids → `Organization` via `UPDATE app.fact SET factoid_type='Organization' WHERE factoid_type='Service'`. All 23 verified correct (Spotify, LinkedIn, Amazon, Uber, Audible, Midpoint Wine Bar, etc.).
- **Restarts:** `com.vineel.willow-memory` and `com.vineel.willow-worker` LaunchAgents bounced; `/tmp/willow-{memory,worker}-version.json` confirms both running `0.3.0` with `gitDirty: true`.

**Caveat:** the `willow-memory` MCP server in the running Claude Code session was loaded at session start with the old zod schema. `memory_add` calls from inside the session that use `Account` or `Unknown` will fail until the session restarts. Cleanup scripts don't go through the MCP server, so this isn't blocking Phase 3.

### Phase 2 — Dedupe strategy ✅ DONE (2026-04-13)

Written: `notes/person-dedupe-strategy.md` (~280 lines). Read it before starting Phase 3. Covers:

- Three failure modes (type bleed, within-type duplication, fragmented dossiers)
- 5 blockers for candidate pair generation (normalized-name exact, pg_trgm, pgvector embedding, entity_address graph, "X from Y" attribution)
- Per-pair signal list (11 features, all from existing columns)
- Auto-merge / review / reject classification rules with thresholds
- LLM-as-judge for review zone (Haiku 4.5, prompt-cached, ~$0.10/1000 pairs)
- Soft-merge application via new `app.fact_merge` table; 7-step rewire transaction
- Parent-reparent pass for fragmented dossiers (Neela's ulcer / Neela's bed pattern)
- On-insert dedupe hooks for both pipelines once cleanup lands
- Daily/weekly/monthly maintenance cadence
- Schema changes needed (Appendix B)
- Phase 3 file list (Appendix C)

### Phase 3 — Cleanup scripts ✅ DONE (2026-04-13)

Scripts written, committed in `c32d5ba`, applied live against the DB.
Results captured in `notes/farley-assessments/2026-04-13-post-cleanup.json`
and diffed against the pre-cleanup snapshot:

| Metric                       | Before | After | Δ    |
|------------------------------|--------|-------|------|
| Active factoids              | 620    | 538   | -82  |
| Person total                 | 262    | 186   | -76  |
| Person matching junk regex   | 59     | 19    | -40  |
| Duplicate groups             | 23     | 2     | -21  |
| Factoids in duplicate groups | 66     | 5     | -61  |
| Display-name collisions      | 9      | 1     | -8   |
| Merges recorded              | 0      | 64    | +64  |

**Applied:**
- cleanup-factoid-types: 72 rows updated (42 Account reclassify, 23 playbook/command demote, 7 Place reclassify).
- dedupe-factoids: 101 merges proposed, 64 applied (rest were transitive duplicates). LLM judge called on 104 review-zone pairs; it correctly rejected the vast majority of cross-service credential pairs and approved a few genuine dupes (Apple ID ≡ Gmail via shared email, oculus rift login ≡ oculus support login, Generate alternatives prompts ≡ related fact).
- reparent-fragments: created 4 Unknown parents (Vineel, Brad, Neela, Amazon), reparented 32 fragments.

**Residual issues to address in Phase 4 retro / Phase 5:**
- 19 Person factoids still match junk regex — mostly tmux commands like "detach from tmux session" that the command-tool prefix rule (`^tmux\b`) doesn't catch because the tool name isn't at line-start. Tighten rule in next maintenance pass.
- 207 factoids still have `factoid_type=NULL`. Dedupe skipped them because it requires a type. Needs a deferred LLM type-assignment sweep.
- "Brad" Person factoid got absorbed into a Brad fragment during dedupe, so reparent created a *new* Unknown Brad parent. Next dedupe cycle will catch and merge. Same pattern may affect others.
- Created parents are all `Unknown` type — Phase 5 seed will upgrade Vineel/Brad/Neela/family to Person with `human_verified=true`.
- "amazon's hiring process" ×3 and "amazon interview" ×2 survive as duplicate groups because they're `factoid_type=null` (cleanup demoted them from factoids but their title duplicate state persisted).

### Phase 3 — Cleanup scripts (original plan) — archived

Three scripts, all `--dry-run` by default:

1. `scripts/cleanup-factoid-types.ts` — reclassification sweep. Rule-based first-pass: `/login|account|password|api key/i` → `Account`; `/playbook|tmux|kitty|how to|setup|configuration/i` → demote to `is_factoid=false`; venues/orgs → correct type.
2. `scripts/dedupe-factoids.ts` — implements § 1-5 of the strategy doc.
3. `scripts/reparent-fragments.ts` — implements § 6 of the strategy doc.
4. `db/migrations/002-fact-merge.sql` — new tables from Appendix B of the strategy doc.

Each: dry-run default, prints proposed changes, `--apply` writes inside a transaction.

### Phase 4 — Run + retro ✅ DONE (2026-04-13)

- Scripts run against live DB ✅
- Results reviewed ✅ (see Phase 3 Results table above)
- `notes/factoid-cleanup-retro.md` written ✅ — calibration notes, LLM judge verdict distribution, false-positive risks, maintenance-worker plan.

### Phase 5 — Seed + guardrails + bootstrap ⏳ IN PROGRESS

- **Seed ✅** (2026-04-13) — `memory/scripts/seed-farley-from-claude-md.ts` applied. 20 human_verified=true factoids mirroring `~/willow-runtime-workspace/CLAUDE.md`. 16 inserts + 4 updates that adopted the Vineel / Neela / Brad Unknown parents from reparent plus an existing Stephanie Sokaris row. Children already attached stay attached (same fact_id).
- **On-insert dedupe hooks ✅** (2026-04-13) — both writer paths now check for exact-title / display-name collisions before minting new factoids:
  - `pib/entity-resolver.ts::resolveAddress` — before creating, checks Block D (shared entity_address display_name) and Block A-lite (exact lowercased title) and links the new address to the existing factoid if either matches.
  - `memory/extractor/extract.ts::saveExtraction` — before inserting a fact with `is_factoid=true`, looks up exact-title + same-type match. If found, demotes the new row to `is_factoid=false` and sets `parent_factoid_id` so it becomes a child. Logs dedupe decisions.
  - Conservative on purpose: exact title only. Broader (trigram, embedding, semantic) dedupe runs in the periodic maintenance worker so a single extractor mistake can't silently merge genuinely-different entities.
- **LLM type-assignment sweep ⏳ TODO** — 207 factoids currently have `factoid_type=NULL` (unchanged by the rule-based cleanup). Write `memory/scripts/assign-factoid-types.ts` that runs Haiku over each null-type factoid with its title + content + keywords and asks for a type + short rationale. Auto-apply types returned with confidence ≥ 0.85; park the rest for review. This is the biggest remaining reduction target for the Farley File goal.
- **Bootstrap resume ⏳ TODO** — resume `notes/bootstrap-memory-plan.md` — historical 2000-email backfill. Blocked on: type-assignment sweep landing so the bootstrap isn't pouring more null-typed rows into the DB at scale.

## Decisions locked in (2026-04-13)

- **`Service` type** → removed; existing rows folded into `Organization`.
- **`Account` is a factoid** (is_factoid=true, factoid_type='Account'). It accumulates child facts (renewal dates, subscription levels, associated emails).
- **`Unknown` type** — promoted to the right type via (a) manual cleanup sweep and (c) LLM maintenance pass. No automatic "reply-to promotion" rule.
- **Soft merges first.** Keep losing factoid as `is_active=false` + pointer to winner. Convert to hard merges after 2-3 maintenance cycles prove the thresholds.
- **Session cadence:** Phase 1 + 2 in one session; pause for review before Phase 3 scripts.

## Open decision points (to resolve before Phase 3 code)

1. **Namesake collision rule** (strategy doc § 3). Currently requires `embedding > 0.80` when only first-token matches. May be too strict for thin-content factoids. Defer to first-run learning.
2. **`normalized_title` column strategy.** Generated SQL column vs regular column updated by backfill + trigger. Full suffix-stripping is awkward as pure SQL. Lean regular column, settle at implementation time.
3. **`fact_merge_candidate` table vs one-table-with-pending-status.** Went with two tables in the doc for clarity. Can consolidate if Vineel prefers.
4. **Graphile Worker task name / crontab for maintenance.** Not specified. Define when Phase 3 lands.
5. **Memory server MCP session restart.** Not urgent — cleanup scripts are standalone CLI, not MCP. Do whenever convenient.

## Memory files relevant to this initiative

- `project_farley_file.md` — why farley file is load-bearing, 2026-04-13 audit state
- `user_family.md` — Stephanie, Zeph, Ele (daughter, they/them), Vinod (father, 87), Neela (mother, 85 — NOT a pet)
- `project_memory_subsystem.md` — memory subsystem v1 running as of 2026-04-05, processor deferred
- `project_runtime_workspace.md` — MCP + agent CLAUDE.md live in `~/willow-runtime-workspace/`, code in `~/aidev/willow/`
- `feedback_todo_list_format.md` — prefix todos with running numeric index

## Files touched in this initiative (so far)

**Modified:**
- `pib/entity-resolver.ts`
- `memory/extractor/extract.ts`
- `memory/extractor/prompts.ts`
- `memory/routes/facts.ts`
- `mcp/memory-mcp/server.ts`
- `db/schema.sql`
- `package.json`

**Created:**
- `notes/person-dedupe-strategy.md`
- `notes/farley-file-initiative-status.md` (this file)

**Already existed, still relevant:**
- `notes/bootstrap-memory-plan.md` — the one-shot backfill plan, blocked until cleanup completes

## How to resume after session restart

1. Read this file (farley-file-initiative-status.md).
2. Read `notes/person-dedupe-strategy.md` — the full design for Phase 3.
3. Read `notes/bootstrap-memory-plan.md` — what Phase 5 unblocks.
4. Check auto-memory files listed above.
5. Check `git status` and `git diff` to see the Phase 1 code changes on disk but not yet committed.
6. Ask Vineel: "Ready to start Phase 3?" or let him set direction.

None of the Phase 1 changes have been committed yet. Commit message when we're ready should describe: factoid-type whitelist expansion (Account, Unknown), entity-resolver Person default removal, extractor prompt rewrite, schema comment update, version bump. Service→Organization migration is data-only, no commit needed for it.
