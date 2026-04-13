/**
 * List the last N digested emails. Useful for dev/testing digest formatting.
 *
 * Usage:
 *   bun run pib:digest:list              # last 10
 *   bun run pib:digest:list -- --limit 20
 */
import { sql } from "../config";

const limit = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--limit") ?? "10", 10);

const rows = await sql`
  SELECT
    f.fact_id,
    f.title,
    f.digest_sent_at,
    f.extracted_data,
    sn.source_ref,
    sn.metadata->>'from' as from_meta,
    sn.received_at,
    i.category,
    i.subcategory
  FROM app.fact f
  JOIN app.source_note sn ON f.source_note_id = sn.source_note_id
  LEFT JOIN app.intent i ON f.intent_id = i.id
  WHERE f.triage_action = 'digest'
    AND sn.source_type = 'email'
  ORDER BY sn.received_at DESC
  LIMIT ${limit}
`;

if (rows.length === 0) {
  console.log("No digest items found.");
} else {
  console.log(`Last ${rows.length} digest items:\n`);
  for (const r of rows) {
    const fromMeta = r.from_meta ? JSON.parse(r.from_meta) : {};
    const sender = fromMeta.displayName ?? fromMeta.address ?? "unknown";
    const date = new Date(r.received_at).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
    const sent = r.digest_sent_at ? "sent" : "PENDING";
    const cat = r.category ? `${r.category}${r.subcategory ? ` › ${r.subcategory}` : ""}` : "uncategorized";
    const hasUrl = r.source_ref ? "has-link" : "no-link";
    const hasExtracted = r.extracted_data && Object.values(r.extracted_data).some((v: unknown) => typeof v === "string" && /^https?:\/\//.test(v as string)) ? "+extracted-url" : "";
    console.log(`  ${r.fact_id}  [${sent}] [${hasUrl}${hasExtracted}]`);
    console.log(`    ${r.title}`);
    console.log(`    ${sender} — ${date} — ${cat}`);
    console.log();
  }
}

await sql.end();
