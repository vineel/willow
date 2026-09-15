/**
 * Backfill foldersort for recent already-ingested inbox emails. Runs the
 * full decide path AND (by default) applies the moves via JMAP. Set
 * WILLOW_FOLDERSORT_APPLY=0 to force proposal-only.
 *
 * Time-window flags (--since wins if both are given):
 *   --days N         sliding window: emails received in the last N*24 hours
 *   --since DATE     emails received at or after midnight ET on DATE
 *                    (DATE is YYYY-MM-DD, e.g. 2026-05-16)
 *
 * By default, emails whose foldersort decision has already been APPLIED
 * (folder_applied_at IS NOT NULL) are skipped. Use --reprocess to opt in
 * to re-running decide+apply on those too — useful after editing profile
 * descriptions or adding rules.
 *
 * Usage:
 *   bun run foldersort:backfill                          # default --days 1
 *   bun run foldersort:backfill -- --days 7
 *   bun run foldersort:backfill -- --since 2026-05-16    # since midnight ET that day
 *   bun run foldersort:backfill -- --since 2026-05-16 --reprocess
 *   bun run foldersort:backfill -- --days 30 --terse    # batch-size window: skip the thorough prompt (see foldersort:sweep)
 *   WILLOW_FOLDERSORT_APPLY=0 bun run foldersort:backfill -- --days 1
 */

import { sql } from "../config";
import { getSecret } from "../config";
import { getSession, getMailboxes } from "../jmap/session";
import { createLogger } from "../logger";
import { decide } from "../foldersort/decide";
import { listProfiles } from "../foldersort/profiles";
import { loadActiveRules } from "../foldersort/rules";
import { sourceNoteToEvent } from "../foldersort/from-source-note";
import { applyDecision, shouldAutoApply } from "../foldersort/apply";
import type { FolderDecision } from "../foldersort/types";

const log = createLogger("foldersort.backfill");

function parseArgs() {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const di = argv.indexOf("--days");
  const days = di !== -1 ? parseInt(argv[di + 1] ?? "1", 10) : 1;
  const si = argv.indexOf("--since");
  const since = si !== -1 ? argv[si + 1] : undefined;
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    throw new Error(`--since must be YYYY-MM-DD (got "${since}")`);
  }
  const reprocess = argv.includes("--reprocess");
  const terse = argv.includes("--terse");
  return { days, since, reprocess, terse };
}

const { days, since, reprocess, terse } = parseArgs();
const autoApply = shouldAutoApply();
const windowDesc = since ? `since midnight ET ${since}` : `last ${days} day(s)`;
log.runStart(`backfill ${windowDesc} reprocess=${reprocess} auto_apply=${autoApply} terse=${terse}`);

// Resolve inbox mailbox id so we can filter source_notes by mailboxIds metadata.
const token = await getSecret("fastmail-token");
const session = await getSession(token);
const mailboxes = await getMailboxes(session, token);
const inbox = mailboxes.find((m) => m.role === "inbox");
if (!inbox) {
  log.error("Inbox mailbox not found");
  process.exit(1);
}
log.info(`Inbox mailbox: ${inbox.name} (${inbox.id})`);

// Skip already-applied unless --reprocess. Reason: app.source_note.metadata
// is a snapshot from ingest time, so it still says the email is in inbox
// even after we've moved it. Re-running could cause double-folder placement
// if decide() picks a different target the second time.
const rows = since
  ? ((await sql`
      SELECT f.fact_id, sn.source_note_id, sn.source_type, sn.source_ref, sn.title,
             sn.raw_text, sn.metadata, sn.received_at, f.folder_applied_at
      FROM app.fact f
      JOIN app.source_note sn ON sn.source_note_id = f.source_note_id
      WHERE sn.source_type = 'email'
        AND sn.received_at >= (${since}::date AT TIME ZONE 'America/New_York')
        AND (sn.metadata->'mailboxIds') ? ${inbox.id}
        AND (${reprocess} OR f.folder_applied_at IS NULL)
      ORDER BY sn.received_at ASC
    `) as unknown as any[])
  : ((await sql`
      SELECT f.fact_id, sn.source_note_id, sn.source_type, sn.source_ref, sn.title,
             sn.raw_text, sn.metadata, sn.received_at, f.folder_applied_at
      FROM app.fact f
      JOIN app.source_note sn ON sn.source_note_id = f.source_note_id
      WHERE sn.source_type = 'email'
        AND sn.received_at >= now() - (${days} || ' days')::interval
        AND (sn.metadata->'mailboxIds') ? ${inbox.id}
        AND (${reprocess} OR f.folder_applied_at IS NULL)
      ORDER BY sn.received_at ASC
    `) as unknown as any[]);

log.info(`Found ${rows.length} inbox emails to process (${windowDesc}, reprocess=${reprocess})`);

const profiles = await listProfiles(true);
const rules = await loadActiveRules();
const profilesByName = new Map(profiles.map((p) => [p.name, p] as const));

const counts: Record<string, number> = {};
let moved = 0, applyErrors = 0, decideErrors = 0;
for (const row of rows) {
  const event = sourceNoteToEvent(row);
  let decision: FolderDecision;
  try {
    decision = await decide(event, { profiles, rules, terseOnly: terse });
  } catch (err) {
    decideErrors++;
    log.error(`fact ${row.fact_id} decide failed: ${(err as Error).message}`);
    continue;
  }
  counts[decision.target] = (counts[decision.target] ?? 0) + 1;
  const result = await applyDecision(row.fact_id, row.source_ref, decision, {
    session, token, inboxMailboxId: inbox.id, profilesByName,
  });
  if (result.moved) moved++;
  if (result.error) applyErrors++;
}

log.info(`Backfill complete: ${rows.length - decideErrors} decisions, ${moved} moved, ${applyErrors} apply errors`);

console.log(`\nDecisions (${windowDesc}):`);
const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
for (const [target, n] of sorted) {
  console.log(`  ${n.toString().padStart(4)}  ${target}`);
}
console.log(`\nMoves performed: ${moved}  Apply errors: ${applyErrors}  Auto-apply: ${autoApply ? "ON" : "OFF (proposal-only)"}`);
process.exit(0);
