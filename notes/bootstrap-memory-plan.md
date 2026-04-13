# Bootstrap Memory from Historical Email — Plan

**Status:** Draft, not yet implemented
**Goal:** Walk the last ~2000 emails in Vineel's Fastmail account and populate Willow's Second Brain with durable personal facts extracted from them. One-shot backfill, not part of the recurring pipeline.

## Motivation

The live pipeline only processes new mail since the last sync cursor. Willow's memory is therefore blind to everything that predates its deployment. A bootstrap pass over historical email is the cheapest way to give memory a substantive starting corpus about Vineel's family, projects, relationships, and ongoing life context.

**Explicit non-goals:**
- Not classification tuning (separate job if wanted later)
- Not generating todos or notifications from old mail
- Not firing any interest `action_prompt`s on historical matches
- Not replacing iCloud calendar as source of truth for events

## Shape of the Job

```
JMAP fetch (paged, oldest→newest)
  → triage (field-level, no LLM)        [drops obvious noise]
  → fact-worth pre-filter (Haiku)        [cheap yes/no per surviving email]
  → fact extraction (Sonnet/Opus)        [only on "yes" from pre-filter]
  → dedupe vs existing memory            [memory_search before memory_add]
  → memory_add
```

**Ordering:** oldest → newest. When two emails contradict (e.g. "Ele started therapy"), the newer write overwrites the older, so final memory state reflects current reality.

**Dispatch stage is absent by design.** Bootstrap never executes `action_prompt`s — that would spam notifications and re-live months of inbox history.

## Stage Details

### 1. JMAP fetch
- Reuse `pib/jmap/` adapter.
- Page size 50–100 via `Email/query` + `Email/get`.
- Sleep 1–2s between pages (gentle on Fastmail, not strictly rate-limited but polite).
- Cap body size at whatever the live pipeline already enforces.
- Persist each processed JMAP id to a checkpoint table so a crash mid-run can `--resume` instead of restart.

### 2. Triage
- Reuse existing triage rules from `pib/`.
- Expected kill rate: 60–85% of mail (newsletters, receipts, automated noise).
- No LLM cost; this is where most of the savings come from.

### 3. Fact-worth pre-filter (new)
- One Haiku 4.5 call per surviving email.
- Tiny prompt: *"Does this email contain durable personal facts about Vineel, his family, his ongoing projects, or people/orgs in his circle worth remembering in a year? Answer yes/no + one-line reason."*
- Uses prompt caching — system prompt is static across all 2000 calls.
- Expected pass rate: ~20–40% of post-triage mail.
- Budget: ~$0.10–0.30 total for the whole pre-filter sweep.

### 4. Fact extraction (new, distinct from live pipeline's extractor)
- Only runs on emails the pre-filter flagged "yes".
- Sonnet 4.6 by default; Opus 4.6 opt-in via flag for higher-stakes passes.
- Prompt is **opinionated and narrow**:
  - Only extract facts about Vineel, immediate family, extended family, Accordli/Willow, people/orgs appearing repeatedly.
  - Skip random one-off senders.
  - Include email date as context — phrase time-sensitive facts relative to that date ("Ele began therapy in early 2024"), not as present tense.
  - Skip purely transactional data (order numbers, tracking codes, 2FA).
- Output: list of atomic candidate facts, each tagged with source JMAP id and email date.
- Budget: ~$2–8 total depending on model and surviving volume.

### 5. Dedupe
- For each candidate fact, `memory_search` first (local, fast, free).
- If a sufficiently similar fact exists, skip.
- Otherwise `memory_add` with `is_factoid`/`factoid_type` set correctly for root entities per willow-memory conventions.
- Start simple (search-before-add per fact). Optimize to batched embedding dedupe later if needed.

## Budget Ceiling

Hard caps enforced in code, not just estimates:
- `--max-prefilter-calls` (default 2000 = all)
- `--max-extraction-calls` (default 300)
- Abort run if either exceeded; log and exit cleanly so `--resume` works.

Total expected cost for a full 2000-email run: **under $10, likely $3–6.**

## CLI Script

New file: `pib/scripts/bootstrap-memory.ts`
New package.json script: `pib:bootstrap-memory`

Per Vineel's "prefer dev scripts" rule — this is a proper script, not an ad-hoc one-off.

### Invocation

```bash
# Dry run — triage + pre-filter only, no extraction, no writes
bun run pib:bootstrap-memory -- --count 2000 --dry-run

# Real run with hard caps
bun run pib:bootstrap-memory -- --count 2000 --max-extraction-calls 300

# Scoped by date
bun run pib:bootstrap-memory -- --since 2024-01-01 --until 2025-12-31

# Resume after crash
bun run pib:bootstrap-memory -- --count 2000 --resume
```

### Flags

| Flag | Purpose |
|---|---|
| `--count N` | How many emails back to walk (from newest) |
| `--since DATE` / `--until DATE` | Time-window scope; overrides `--count` |
| `--dry-run` | Run triage + pre-filter, report survival rates, no extraction, no memory writes |
| `--max-prefilter-calls N` | Hard cap on Haiku calls |
| `--max-extraction-calls N` | Hard cap on Sonnet/Opus calls |
| `--extraction-model` | `sonnet` (default) or `opus` |
| `--resume` | Pick up from last checkpointed JMAP id |
| `--verbose` | Log per-email decisions |

### Dry-run output (what Vineel sees before committing real spend)

```
Fetched:           2000 emails
Survived triage:    540 (27%)
Pre-filter "yes":   180 (33% of survivors, 9% overall)
Estimated cost:
  pre-filter:     $0.18 (2000 Haiku calls)
  extraction:     $4.20 (180 Sonnet calls, ~2k tokens each)
  total:          $4.38
No writes performed. Re-run without --dry-run to execute.
```

## Implementation Notes

- **Reuse, don't duplicate.** JMAP adapter, triage engine, memory client — all imported from existing `pib/` and `memory/` code.
- **Extraction prompt lives separately.** `pib/scripts/bootstrap-memory-prompt.ts` or similar — bootstrap's extraction goal (durable facts for memory) differs from the live pipeline's extraction goal (structured data per intent category), so don't try to share.
- **Checkpoint table.** Small Postgres table: `bootstrap_runs(run_id, last_jmap_id, started_at, emails_processed, prefilter_calls, extraction_calls, facts_added)`. Enables `--resume` and gives a post-run report.
- **Logging.** To `/tmp/willow-runtime.log` per existing convention, component tag `[bootstrap-memory]`.
- **Hot-reload caveat.** This is a CLI script — each invocation spawns fresh Bun, so source edits take effect immediately. No MCP server restart needed.
- **README.** Add the new `pib:bootstrap-memory` command to Willow README per Vineel's documentation rule.
- **Version bump.** Bump `package.json` semver on commit per convention.

## Open Questions

1. **Pre-filter prompt wording.** Worth iterating on a handful of emails manually before burning through 2000. Maybe a `--sample N` mode that runs the whole pipeline on N random post-triage emails and dumps the extracted facts for human review.
2. **Fact granularity.** Should a single email that mentions "Stephanie's leather business, Zeph's school project, and a dentist appointment" produce three memory entries or one? Lean toward atomic (three) per willow-memory "one distinct piece of information per fact" guidance.
3. **Attachments.** Probably ignore for v1. PDFs and images could contain facts but multiply complexity and cost significantly.
4. **Threads vs individual emails.** A reply in a long thread may be meaningless without the parent. Option A: process each email individually (simple, may miss context). Option B: fetch full thread for context when extracting (correct, more tokens). Start with A, upgrade if results are thin.

## Recommended First Step When Implementing

1. Write the script with `--dry-run` working end-to-end but extraction stubbed.
2. Run against 2000 real emails, review the survival/pre-filter stats.
3. Manually spot-check 10–20 "yes" decisions from the pre-filter — is the model picking the right emails?
4. Iterate on pre-filter prompt if needed.
5. Then wire up real extraction + memory writes, start with `--max-extraction-calls 20` as a smoke test.
6. Inspect the 20 resulting memory entries manually.
7. Only then do the full run.
