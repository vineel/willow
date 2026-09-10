/**
 * Print the N most recent inbox proposals in the compact chat-formatted
 * blocks. Mirrors the preview_inbox_sort MCP tool. Reads from app.fact
 * (so it requires that backfill or the pipeline has already proposed).
 *
 * Usage:
 *   bun run foldersort:preview                  # default --count 20
 *   bun run foldersort:preview -- --count 5
 */

import { sql } from "../config";
import { createLogger } from "../logger";
import { sourceNoteToEvent } from "../foldersort/from-source-note";
import { formatPreviewList, type PreviewItem } from "../foldersort/format";
import type { FolderDecision } from "../foldersort/types";

const log = createLogger("foldersort.preview");

function parseArgs() {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const i = argv.indexOf("--count");
  return { count: i !== -1 ? parseInt(argv[i + 1] ?? "20", 10) : 20 };
}

const { count } = parseArgs();

const rows = (await sql`
  SELECT f.fact_id, f.folder_target, f.folder_decided_by, f.folder_rule_id,
         f.folder_reason, sn.source_note_id, sn.source_type, sn.source_ref,
         sn.title, sn.raw_text, sn.metadata, sn.received_at
  FROM app.fact f
  JOIN app.source_note sn ON sn.source_note_id = f.source_note_id
  WHERE f.folder_proposed_at IS NOT NULL
    AND f.folder_applied_at IS NULL
  ORDER BY f.folder_proposed_at DESC
  LIMIT ${count}
`) as unknown as any[];

if (rows.length === 0) {
  console.log("(no pending proposals — run `bun run foldersort:backfill` first)");
  process.exit(0);
}

const items: PreviewItem[] = rows.map((r) => {
  const event = sourceNoteToEvent(r);
  const decision: FolderDecision = {
    target: r.folder_target,
    decided_by: r.folder_decided_by,
    rule_id: r.folder_rule_id,
    reason: r.folder_reason ?? "",
  };
  return { factId: r.fact_id, event, decision, receivedAt: event.receivedAt };
});

console.log(formatPreviewList(items));
log.info(`Printed ${items.length} proposals`);
process.exit(0);
