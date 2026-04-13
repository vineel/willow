import { Glob } from "bun";
import { sql } from "../db";
import { config } from "../config";

const glob = new Glob("**/*.md");
let totalFiles = 0;
for await (const _ of glob.scan({ cwd: config.notesRoot })) {
  totalFiles++;
}

const [{ ingested }] = await sql`SELECT count(*) as ingested FROM app.source_note`;
const [{ facts }] = await sql`SELECT count(*) as facts FROM app.fact WHERE is_active = true`;
const [{ embeddings }] = await sql`SELECT count(*) as embeddings FROM app.fact WHERE embedding IS NOT NULL AND is_active = true`;
const [queue] = await sql`
  SELECT
    count(*) FILTER (WHERE status = 'pending') AS pending,
    count(*) FILTER (WHERE status = 'failed') AS failed,
    count(*) FILTER (WHERE status = 'done') AS done
  FROM app.fact_queue
`;
const [jobs] = await sql`SELECT count(*) as pending FROM graphile_worker._private_jobs WHERE is_available = true`;

console.log(`Files:       ${ingested}/${totalFiles} ingested`);
console.log(`Facts:       ${facts} active (${embeddings} with embeddings)`);
console.log(`Queue:       ${queue.pending} pending, ${queue.done} done, ${queue.failed} failed`);
console.log(`Worker jobs: ${jobs.pending} pending`);

await sql.end();
