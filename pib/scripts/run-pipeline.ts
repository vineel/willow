/**
 * Run the PIB pipeline directly (same as the worker cron, but one-shot).
 * Logs to /tmp/willow-runtime.log.
 *
 * Usage: bun run pib:run [--folder inbox] [--limit 50]
 */

import { sql } from "../config";
import { runPipeline } from "../pipeline";
import { createLogger } from "../logger";

const log = createLogger("pib.run");

const args = process.argv.slice(2);
let folder = "inbox";
let limit = 50;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--folder" && args[i + 1]) { folder = args[i + 1]; i++; }
  else if (args[i] === "--limit" && args[i + 1]) { limit = parseInt(args[i + 1], 10); i++; }
}

log.runStart(`Manual pipeline run: folder=${folder} limit=${limit}`);

try {
  const stats = await runPipeline(folder, { limit });
  // Print summary to stdout too
  console.log(`\nPipeline complete: ${stats.ingested} ingested, ${stats.skipped} skipped, ${stats.classified} classified, ${stats.dispatched} dispatched`);
  if (stats.errors.length > 0) {
    console.log(`Errors: ${stats.errors.join("; ")}`);
  }
} catch (err) {
  log.error(`Pipeline failed: ${(err as Error).message}`);
  console.error("Fatal:", (err as Error).message);
}

await sql.end();
