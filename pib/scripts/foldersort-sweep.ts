/**
 * Re-run foldersort decide() over emails ALREADY FILED in a given
 * willow-secondary subfolder, and physically move any that now decide
 * differently. Useful for retroactive cleanup after adding/adjusting a
 * profile or rule set — e.g. pulling bills/receipts out of "uninteresting"
 * after adding a "bills-receipts" profile.
 *
 * Unlike foldersort:backfill (inbox-only, moves inbox -> subfolder), this
 * sweeps subfolder -> subfolder. A decision of leave_in_inbox is treated as
 * "no confident match" and skipped — a sweep never moves mail back into the
 * inbox, it only pulls matching mail out or leaves it where it is.
 *
 * Usage:
 *   bun run foldersort:sweep -- --source uninteresting
 *   bun run foldersort:sweep -- --source uninteresting --days 90
 *   bun run foldersort:sweep -- --source uninteresting --only bills-receipts
 *   bun run foldersort:sweep -- --source uninteresting --only bills-receipts --dry-run
 *   bun run foldersort:sweep -- --source uninteresting --only bills-receipts --rules-only
 *   bun run foldersort:sweep -- --source uninteresting --only bills-receipts --terse
 *
 * --rules-only skips the LLM entirely and matches deterministic folder_rule
 * rows only. Fastest, but only catches senders/subjects you've written a
 * rule for.
 *
 * --terse still uses the LLM for anything rules don't catch, but skips the
 * normal thorough prompt and goes straight to the short, no-enumeration one
 * (see TERSE_SYSTEM_PROMPT in foldersort/llm.ts) — for one live email the
 * thorough prompt is worth the wait and usually succeeds, but across a
 * thousand-email backlog it reliably burns its full timeout before falling
 * back anyway, so batch runs should just start terse.
 */

import { sql } from "../config";
import { getSecret } from "../config";
import { getSession } from "../jmap/session";
import { createLogger } from "../logger";
import { decide } from "../foldersort/decide";
import { listProfiles } from "../foldersort/profiles";
import { loadActiveRules, matchRules } from "../foldersort/rules";
import { sourceNoteToEvent } from "../foldersort/from-source-note";
import { moveEmail } from "../jmap/mutate";
import { LEAVE_IN_INBOX } from "../foldersort/types";
import type { FolderDecision } from "../foldersort/types";

const log = createLogger("foldersort.sweep");

function parseArgs() {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const si = argv.indexOf("--source");
  if (si === -1) throw new Error("--source <profile-name> is required");
  const source = argv[si + 1];
  const di = argv.indexOf("--days");
  const days = di !== -1 ? parseInt(argv[di + 1] ?? "9999", 10) : 9999; // default: whole folder
  const oi = argv.indexOf("--only");
  const only = oi !== -1 ? argv[oi + 1] : undefined;
  const dryRun = argv.includes("--dry-run");
  const rulesOnly = argv.includes("--rules-only");
  const terse = argv.includes("--terse");
  const shi = argv.indexOf("--show");
  const show = shi !== -1 ? parseInt(argv[shi + 1] ?? "10", 10) : 0;
  if (rulesOnly && terse) throw new Error("--rules-only and --terse are mutually exclusive");
  return { source, days, only, dryRun, rulesOnly, terse, show };
}

const { source, days, only, dryRun, rulesOnly, terse, show } = parseArgs();
log.runStart(`sweep source="${source}" days=${days} only=${only ?? "(any)"} dry_run=${dryRun} rules_only=${rulesOnly} terse=${terse}`);

const token = await getSecret("fastmail-token");
const session = await getSession(token);

const profiles = await listProfiles(true);
const profilesByName = new Map(profiles.map((p) => [p.name, p] as const));
const sourceProfile = profilesByName.get(source);
if (!sourceProfile) {
  console.error(`ERROR: no profile named "${source}". Run foldersort:bootstrap first.`);
  process.exit(1);
}
if (!sourceProfile.mailbox_id) {
  console.error(`ERROR: profile "${source}" has no cached mailbox_id. Run foldersort:bootstrap.`);
  process.exit(1);
}
if (only && !profilesByName.has(only)) {
  console.error(`ERROR: --only target "${only}" is not a known profile.`);
  process.exit(1);
}

const rules = await loadActiveRules();

const rows = (await sql`
  SELECT f.fact_id, sn.source_note_id, sn.source_type, sn.source_ref, sn.title,
         sn.raw_text, sn.metadata, sn.received_at, f.folder_target
  FROM app.fact f
  JOIN app.source_note sn ON sn.source_note_id = f.source_note_id
  WHERE sn.source_type = 'email'
    AND f.folder_target = ${source}
    AND f.folder_applied_at IS NOT NULL
    AND sn.received_at >= now() - (${days} || ' days')::interval
  ORDER BY sn.received_at ASC
`) as unknown as any[];

log.info(`Found ${rows.length} emails currently filed in "${source}"`);

const counts: Record<string, number> = {};
const samples: Record<string, { from: string; subject: string; reason: string }[]> = {};
let moved = 0, errors = 0, skipped = 0;

for (const row of rows) {
  const event = sourceNoteToEvent(row);
  let decision: FolderDecision;
  if (rulesOnly) {
    const hit = matchRules(event, rules);
    decision = hit
      ? { target: hit.target_folder, decided_by: "rule", rule_id: hit.id, reason: `rule:${hit.name}` }
      : { target: LEAVE_IN_INBOX, decided_by: "default", rule_id: null, reason: "no rule match (rules-only sweep)" };
  } else {
    try {
      decision = await decide(event, { profiles, rules, terseOnly: terse });
    } catch (err) {
      errors++;
      log.error(`fact ${row.fact_id} decide failed: ${(err as Error).message}`);
      continue;
    }
  }

  if (decision.target === source || decision.target === LEAVE_IN_INBOX) {
    skipped++;
    continue;
  }
  if (only && decision.target !== only) {
    skipped++;
    continue;
  }

  counts[decision.target] = (counts[decision.target] ?? 0) + 1;
  if (show > 0) {
    (samples[decision.target] ??= []).push(
      { from: event.fromEntity.address, subject: event.subject ?? "(no subject)", reason: decision.reason }
    );
  }
  if (dryRun) continue;

  const targetProfile = profilesByName.get(decision.target);
  if (!targetProfile?.mailbox_id) {
    errors++;
    const msg = `target "${decision.target}" has no cached mailbox_id`;
    log.error(`fact ${row.fact_id}: ${msg}`);
    await sql`UPDATE app.fact SET folder_error = ${msg} WHERE fact_id = ${row.fact_id}`;
    continue;
  }

  try {
    await moveEmail(session, token, row.source_ref, targetProfile.mailbox_id, sourceProfile.mailbox_id);
    await sql`
      UPDATE app.fact SET
        folder_target      = ${decision.target},
        folder_decided_by  = ${decision.decided_by},
        folder_rule_id     = ${decision.rule_id},
        folder_reason      = ${decision.reason},
        folder_proposed_at = now(),
        folder_applied_at  = now(),
        folder_error       = NULL
      WHERE fact_id = ${row.fact_id}
    `;
    moved++;
  } catch (err) {
    errors++;
    const msg = (err as Error).message;
    log.error(`fact ${row.fact_id} move failed: ${msg}`);
    await sql`UPDATE app.fact SET folder_error = ${msg} WHERE fact_id = ${row.fact_id}`;
  }
}

log.info(`Sweep complete: ${rows.length} scanned, ${moved} moved, ${skipped} left in place, ${errors} errors`);

console.log(`\nRe-decisions that moved out of "${source}"${dryRun ? " (DRY RUN -- nothing applied)" : ""}:`);
const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
if (sorted.length === 0) console.log("  (none)");
for (const [target, n] of sorted) {
  console.log(`  ${n.toString().padStart(4)}  ${target}`);
}
if (show > 0) {
  for (const [target, items] of Object.entries(samples)) {
    console.log(`\nSample matches → ${target} (showing ${Math.min(show, items.length)} of ${counts[target]}):`);
    for (const s of items.slice(0, show)) {
      console.log(`  ${s.from}  |  ${s.subject}  |  ${s.reason}`);
    }
  }
}
console.log(`\nScanned: ${rows.length}  Moved: ${moved}  Left in place: ${skipped}  Errors: ${errors}`);
process.exit(0);
