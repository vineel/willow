/**
 * CLI wrapper around runScanSent(). One-time bootstrap or ad-hoc invocation.
 * The daily incremental scan is invoked from pib/worker.ts (graphile cron).
 *
 * Usage:
 *   bun run foldersort:scan-sent                  # default --since 365d
 *   bun run foldersort:scan-sent -- --since 2d
 */

import { runScanSent } from "../foldersort/scan-sent";

const DEFAULT_SINCE = "365d";

const argv = process.argv.slice(2).filter((a) => a !== "--");
const sinceIdx = argv.indexOf("--since");
const since = sinceIdx !== -1 ? argv[sinceIdx + 1] : DEFAULT_SINCE;

const result = await runScanSent(since);

console.log(
  `\nDone. ${result.total} addresses upserted (${result.inserted} new, ${result.updated} bumped) ` +
  `from ${result.emailsSeen} sent emails over the last ${result.since}.`
);
console.log(`Audit file: ${result.filePath}`);
process.exit(0);
