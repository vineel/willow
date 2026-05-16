/**
 * Redispatch facts whose prior dispatch failed.
 *
 * Reconstructs the CanonicalEvent from source_note metadata + raw_text,
 * re-matches active interests, reuses stored extracted_data, and re-runs dispatch().
 * Skips facts that already have a successful execution recorded (avoids double-firing
 * when artifact-only and full-window runs overlap).
 *
 * Usage:
 *   bun run pib:redispatch --since=7d --mode=artifact
 *   bun run pib:redispatch --since=24h --mode=full
 *   bun run pib:redispatch --since=2026-04-23 --mode=full --dry-run
 *
 * Flags:
 *   --since=<7d|24h|ISO>  Window start (default 7d)
 *   --mode=<artifact|full> artifact: only intents that produce todos/calendar (default).
 *                          full: every failed dispatch in the window.
 *   --error-like=<pattern> SQL LIKE pattern for the failure error (default: PATH bug)
 *   --dry-run             Show what would run; don't execute.
 */

import { sql } from "../config";
import type { CanonicalEvent } from "../jmap/types";
import { loadActiveInterests, matchInterests } from "../interest-matcher";
import { dispatch } from "../dispatch";
import { createLogger } from "../logger";

const log = createLogger("pib.redispatch");

const ARTIFACT_INTENTS: Array<[string, string]> = [
  ["action", "task"],
  ["action", "request"],
  ["calendar", "invite"],
  ["calendar", "change"],
];

interface Args {
  since: Date;
  mode: "artifact" | "full";
  errorLike: string;
  factIds: string[] | null;
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string) => {
    const a = argv.find(a => a.startsWith(`--${name}=`));
    return a ? a.slice(name.length + 3) : undefined;
  };
  const sinceStr = get("since") ?? "7d";
  let since: Date;
  const m = sinceStr.match(/^(\d+)([dh])$/);
  if (m) {
    const n = parseInt(m[1]);
    const ms = m[2] === "d" ? n * 86400000 : n * 3600000;
    since = new Date(Date.now() - ms);
  } else {
    since = new Date(sinceStr);
    if (isNaN(since.getTime())) throw new Error(`Bad --since: ${sinceStr}`);
  }
  const mode = (get("mode") ?? "artifact") as Args["mode"];
  if (mode !== "artifact" && mode !== "full") throw new Error(`Bad --mode: ${mode}`);
  const errorLike = get("error-like") ?? "%Executable not found%claude%";
  const factIdsRaw = get("fact-ids");
  const factIds = factIdsRaw ? factIdsRaw.split(",").map(s => s.trim()).filter(Boolean) : null;
  const dryRun = argv.includes("--dry-run");
  return { since, mode, errorLike, factIds, dryRun };
}

async function reconstructEvent(sourceNoteId: string): Promise<CanonicalEvent | null> {
  const [row] = await sql`
    SELECT source_note_id, source_type, source_ref, title, raw_text, metadata, received_at
    FROM app.source_note WHERE source_note_id = ${sourceNoteId}
  `;
  if (!row) return null;
  const meta = row.metadata as Record<string, unknown>;
  const rawText = (row.raw_text as string) ?? "";
  const blankIdx = rawText.indexOf("\n\n");
  const bodyText = blankIdx >= 0 ? rawText.slice(blankIdx + 2) : rawText;
  return {
    id: (row.source_ref as string) ?? sourceNoteId,
    sourceType: row.source_type as string,
    sourceRef: (row.source_ref as string) ?? sourceNoteId,
    sourceMeta: {
      threadId: meta.threadId,
      mailboxIds: meta.mailboxIds,
      keywords: meta.keywords,
      headers: meta.headers,
      replyTo: meta.replyTo,
    },
    receivedAt: new Date(row.received_at as string).toISOString(),
    fromEntity: meta.from as CanonicalEvent["fromEntity"],
    toEntities: (meta.to as CanonicalEvent["toEntities"]) ?? [],
    subject: (row.title as string | null) ?? undefined,
    bodyText,
    bodyHtml: undefined,
    attachments: (meta.attachments as CanonicalEvent["attachments"]) ?? [],
  };
}

async function main() {
  const args = parseArgs();
  log.info(`Redispatch since=${args.since.toISOString()} mode=${args.mode} dryRun=${args.dryRun}`);

  const artifactKeys = ARTIFACT_INTENTS.map(([c, s]) => `${c}.${s}`);
  const intentFilter = args.mode === "artifact"
    ? sql`AND (i.category || '.' || i.subcategory) IN ${sql(artifactKeys)}`
    : sql``;

  const candidates = args.factIds
    ? await sql`
        SELECT DISTINCT f.fact_id, f.source_note_id, i.category, i.subcategory
        FROM app.fact f
        LEFT JOIN app.intent i ON i.id = f.intent_id
        WHERE f.fact_id IN ${sql(args.factIds)}
        ORDER BY f.fact_id
      `
    : await sql`
        SELECT DISTINCT f.fact_id, f.source_note_id, i.category, i.subcategory
        FROM app.handler_execution h
        JOIN app.fact f ON f.fact_id = h.fact_id
        LEFT JOIN app.intent i ON i.id = f.intent_id
        WHERE h.status = 'failed'
          AND h.error LIKE ${args.errorLike}
          AND h.executed_at >= ${args.since}
          ${intentFilter}
          AND NOT EXISTS (
            SELECT 1 FROM app.handler_execution h2
            WHERE h2.fact_id = f.fact_id AND h2.status = 'success'
          )
        ORDER BY f.fact_id
      `;

  log.info(`Found ${candidates.length} candidate facts to redispatch`);

  if (args.dryRun) {
    for (const c of candidates) {
      log.info(`  [dry] fact=${c.fact_id} intent=${c.category}.${c.subcategory}`);
    }
    await sql.end();
    return;
  }

  const interests = await loadActiveInterests();
  log.info(`Loaded ${interests.length} active interests`);

  let okCount = 0;
  let failCount = 0;
  let skipCount = 0;

  for (const c of candidates) {
    const event = await reconstructEvent(c.source_note_id);
    if (!event) {
      log.warn(`source_note ${c.source_note_id} not found; skipping fact ${c.fact_id}`);
      skipCount++;
      continue;
    }

    const [factRow] = await sql`SELECT extracted_data FROM app.fact WHERE fact_id = ${c.fact_id}`;
    const extractedData = (factRow?.extracted_data as Record<string, unknown> | null) ?? null;

    const interestMatches = matchInterests(event, interests);
    const subject = event.subject ?? "(no subject)";
    log.info(`REDISPATCH fact=${c.fact_id} intent=${c.category}.${c.subcategory} subject="${subject}"`);

    try {
      const result = await dispatch(event, c.fact_id, interestMatches, extractedData);
      for (const ar of result.actionResults) {
        if (ar.success) okCount++;
        else failCount++;
        log.info(`  action="${ar.interest}"→${ar.success ? "OK" : "FAILED:" + ar.error}`);
      }
    } catch (err) {
      failCount++;
      log.error(`  dispatch threw: ${(err as Error).message}`);
    }
  }

  log.info(`Done. successes=${okCount} failures=${failCount} skipped=${skipCount} facts=${candidates.length}`);
  await sql.end();
}

main().catch(err => { log.error(`fatal: ${(err as Error).message}`); process.exit(1); });
