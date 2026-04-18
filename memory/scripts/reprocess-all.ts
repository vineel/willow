// Re-run extraction over every active source_note using the new
// entity-first extractor. Local-first with Haiku fallback on failure.
//
//   bun run memory/scripts/reprocess-all.ts                 # dry-run: LLM only, no DB writes
//   bun run memory/scripts/reprocess-all.ts --apply         # write results
//   bun run memory/scripts/reprocess-all.ts --apply --limit 5
//   bun run memory/scripts/reprocess-all.ts --apply --since 2026-04-01
//   bun run memory/scripts/reprocess-all.ts --apply --source-type file
//   bun run memory/scripts/reprocess-all.ts --apply --haiku  # skip local, use Haiku for everything

import { sql } from "../db";
import { extractWithLocalLLM, saveExtraction } from "../extractor/extract";
import { extractWithHaiku } from "../extractor/haiku";

const APPLY = process.argv.includes("--apply");
const HAIKU_ONLY = process.argv.includes("--haiku");

function argValue(name: string): string | null {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? (process.argv[idx + 1] ?? null) : null;
}

const LIMIT = argValue("--limit");
const SINCE = argValue("--since");
const SOURCE_TYPE = argValue("--source-type");

interface NoteRow {
  source_note_id: string;
  filename: string | null;
  source_type: string;
  raw_text: string;
  created_at: Date;
}

const notes: NoteRow[] = await sql<NoteRow[]>`
  SELECT source_note_id, filename, source_type, raw_text, created_at
  FROM app.source_note
  WHERE raw_text IS NOT NULL
    AND length(raw_text) > 0
    ${SINCE ? sql`AND created_at >= ${SINCE}::timestamptz` : sql``}
    ${SOURCE_TYPE ? sql`AND source_type = ${SOURCE_TYPE}` : sql``}
  ORDER BY created_at ASC
  ${LIMIT ? sql`LIMIT ${Number(LIMIT)}` : sql``}
`;

console.log(
  `[reprocess] ${APPLY ? "APPLY" : "DRY-RUN"} · ${notes.length} source_notes to process` +
    (SINCE ? ` · since ${SINCE}` : "") +
    (SOURCE_TYPE ? ` · source_type=${SOURCE_TYPE}` : "") +
    (HAIKU_ONLY ? " · haiku-only" : ""),
);

let processed = 0;
let skippedNoFilename = 0;
let okLocal = 0;
let okHaiku = 0;
let failed = 0;
let totalEntities = 0;
let totalFacts = 0;
let totalRels = 0;

for (const note of notes) {
  processed++;
  const short = note.filename?.split("/").pop() ?? `<${note.source_note_id.slice(0, 8)}>`;

  // saveExtraction keys off filename; rows without one can't be reprocessed
  // via this path. PIB-originated notes (emails, etc.) often lack filename.
  if (!note.filename) {
    skippedNoFilename++;
    if (processed % 20 === 0) {
      console.log(`[reprocess] ${processed}/${notes.length} · skip-no-filename=${skippedNoFilename}`);
    }
    continue;
  }

  try {
    let parsed: unknown;
    let tier: "local" | "haiku" = HAIKU_ONLY ? "haiku" : "local";

    if (HAIKU_ONLY) {
      const r = await extractWithHaiku(note.raw_text, note.filename);
      parsed = r.parsed;
    } else {
      try {
        const r = await extractWithLocalLLM(note.raw_text, note.filename);
        parsed = r.parsed;
      } catch (localErr) {
        const msg = localErr instanceof Error ? localErr.message : String(localErr);
        console.log(`[reprocess] LOCAL_FAIL ${short} — ${msg.slice(0, 120)}`);
        const r = await extractWithHaiku(note.raw_text, note.filename);
        parsed = r.parsed;
        tier = "haiku";
      }
    }

    if (!APPLY) {
      // Dry-run: count what would be produced without writing
      const obj = parsed as Record<string, unknown>;
      const eCount = Array.isArray(obj?.e) ? obj.e.length : 0;
      const fCount = Array.isArray(obj?.f) ? obj.f.length : 0;
      const rCount = Array.isArray(obj?.r) ? obj.r.length : 0;
      totalEntities += eCount;
      totalFacts += fCount;
      totalRels += rCount;
      console.log(
        `[reprocess] DRY ${short} (${tier}) — ${eCount}e / ${fCount}f / ${rCount}r`,
      );
      if (tier === "local") okLocal++;
      else okHaiku++;
      continue;
    }

    const result = await saveExtraction(
      note.filename,
      note.raw_text,
      parsed,
      tier === "haiku" ? "claude-haiku-4-5-20251001" : "local",
      { force: true },
    );
    totalEntities += result.entityCount;
    totalFacts += result.factCount;
    totalRels += result.relCount;
    if (tier === "local") okLocal++;
    else okHaiku++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[reprocess] FAIL ${short} — ${msg.slice(0, 200)}`);
    failed++;
  }

  if (processed % 10 === 0) {
    console.log(
      `[reprocess] ${processed}/${notes.length} · local=${okLocal} haiku=${okHaiku} fail=${failed}`,
    );
  }
}

console.log("");
console.log(`=== Reprocess summary (${APPLY ? "APPLIED" : "DRY-RUN"}) ===`);
console.log(`Processed: ${processed}`);
console.log(`  OK (local): ${okLocal}`);
console.log(`  OK (haiku): ${okHaiku}`);
console.log(`  Failed:     ${failed}`);
console.log(`  Skipped (no filename): ${skippedNoFilename}`);
console.log(`Totals: ${totalEntities} entities · ${totalFacts} facts · ${totalRels} rels`);

await sql.end();
