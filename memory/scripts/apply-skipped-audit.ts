// One-off: apply skipped assign verdicts from the last type-assignment audit
// where confidence was in [0.7, 0.85). Tightens up the "unsure" bucket.
//
//   bun run memory/scripts/apply-skipped-audit.ts <audit-path> [--min 0.7]

import { sql } from "../db";

const auditPath = process.argv[2];
if (!auditPath) {
  console.error("usage: apply-skipped-audit.ts <audit-path> [--min 0.7]");
  process.exit(1);
}

const minIdx = process.argv.indexOf("--min");
const MIN = minIdx >= 0 ? Number(process.argv[minIdx + 1]) : 0.7;

const audit = JSON.parse(await Bun.file(auditPath).text());

const candidates = audit.decisions.filter(
  (d: any) =>
    !d.applied &&
    d.verdict?.action === "assign" &&
    d.verdict.factoid_type &&
    typeof d.verdict.confidence === "number" &&
    d.verdict.confidence >= MIN,
);

console.log(`audit: ${auditPath}`);
console.log(`min confidence: ${MIN}`);
console.log(`candidates to apply: ${candidates.length}`);

const dist: Record<string, number> = {};
for (const d of candidates) {
  const t = d.verdict.factoid_type;
  dist[t] = (dist[t] ?? 0) + 1;
}
console.log("type distribution:", dist);

let applied = 0;
for (const d of candidates) {
  await sql`UPDATE app.fact SET factoid_type = ${d.verdict.factoid_type} WHERE fact_id = ${d.fact_id}`;
  applied++;
}

console.log(`applied: ${applied}`);
await sql.end();
