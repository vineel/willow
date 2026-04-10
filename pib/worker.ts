/**
 * PIB Graphile Worker — runs the email pipeline on a cron schedule.
 *
 * Tasks:
 *   pib_ingest  — run the full pipeline for inbox + signal folders (every 15 min)
 *   pib_digest  — send the daily digest email (daily at 8am ET)
 *
 * Usage:
 *   bun run pib:worker
 */

import { run, type TaskList, parseCronItems } from "graphile-worker";
import { sql } from "./config";
import { runPipeline } from "./pipeline";
import { sendDigest } from "./digest";

const FOLDERS_TO_SYNC = ["inbox", "for-willow", "not-for-willow"];

const tasks: TaskList = {
  /** Full pipeline run for all watched folders */
  async pib_ingest(_payload, helpers) {
    helpers.logger.info("[pib_ingest] Starting pipeline run...");

    for (const folder of FOLDERS_TO_SYNC) {
      try {
        const stats = await runPipeline(folder);
        helpers.logger.info(
          `[pib_ingest] ${folder}: fetched=${stats.fetched} ingested=${stats.ingested} ` +
          `skipped=${stats.skipped} classified=${stats.classified} dispatched=${stats.dispatched}` +
          (stats.errors.length > 0 ? ` errors=${stats.errors.length}` : "")
        );
      } catch (err) {
        helpers.logger.error(`[pib_ingest] ${folder} failed: ${(err as Error).message}`);
      }
    }

    helpers.logger.info("[pib_ingest] Pipeline run complete.");
  },

  /** Daily digest — collect and send */
  async pib_digest(_payload, helpers) {
    helpers.logger.info("[pib_digest] Sending daily digest...");
    try {
      const result = await sendDigest();
      if (result.sent) {
        helpers.logger.info(`[pib_digest] Digest sent with ${result.count} items.`);
      } else {
        helpers.logger.info("[pib_digest] No pending digest items.");
      }
    } catch (err) {
      helpers.logger.error(`[pib_digest] Failed: ${(err as Error).message}`);
    }
  },
};

// Cron schedules
const crontab = parseCronItems([
  {
    task: "pib_ingest",
    match: "*/15 * * * *", // every 15 minutes
    identifier: "pib_ingest_cron",
  },
  {
    task: "pib_digest",
    match: "0 8 * * *", // daily at 8:00 AM (server local time)
    identifier: "pib_digest_cron",
  },
]);

async function main() {
  console.log("[pib-worker] Starting PIB Worker...");

  // Verify DB
  try {
    await sql`SELECT 1`;
    console.log("[pib-worker] Database connected");
  } catch (err) {
    console.error("[pib-worker] Failed to connect to database:", err);
    process.exit(1);
  }

  const runner = await run({
    connectionString: process.env.DATABASE_URL ?? "postgres://localhost/willow",
    concurrency: 1,
    noHandleSignals: true,
    taskList: tasks,
    parsedCronItems: crontab,
  });

  console.log("[pib-worker] Graphile Worker started");
  console.log("[pib-worker] Cron: pib_ingest every 15 min, pib_digest daily at 8am");

  const shutdown = async () => {
    console.log("\n[pib-worker] Shutting down...");
    await runner.stop();
    await sql.end();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[pib-worker] Fatal error:", err);
  process.exit(1);
});
