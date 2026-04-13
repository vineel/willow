import { sql } from "../db";

console.log("[clear] Clearing all memory data...");

const facts = await sql`DELETE FROM app.fact_queue RETURNING queue_id`;
console.log(`[clear] Deleted ${facts.length} queue entries`);

const rels = await sql`DELETE FROM app.fact_relationship RETURNING relationship_id`;
console.log(`[clear] Deleted ${rels.length} relationships`);

const factsDeleted = await sql`DELETE FROM app.fact RETURNING fact_id`;
console.log(`[clear] Deleted ${factsDeleted.length} facts`);

const sources = await sql`DELETE FROM app.source_note RETURNING source_note_id`;
console.log(`[clear] Deleted ${sources.length} source notes`);

const recency = await sql`DELETE FROM app.recency_context RETURNING factoid_id`;
console.log(`[clear] Deleted ${recency.length} recency entries`);

// Clear Graphile Worker's job queue so nothing retries
await sql`DELETE FROM graphile_worker._private_jobs`;
console.log(`[clear] Cleared Graphile Worker jobs`);

await sql.end();
console.log("[clear] Done");
