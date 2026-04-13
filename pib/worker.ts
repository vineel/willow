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
import { createLogger } from "./logger";
import { writeVersionInfo } from "../lib/version";

const log = createLogger("pib.worker");
const FOLDERS_TO_SYNC = ["inbox", "for-willow", "not-for-willow", "Ai Buzz"];

const tasks: TaskList = {
  async pib_ingest(_payload, _helpers) {
    log.runStart(`Pipeline run: folders=[${FOLDERS_TO_SYNC.join(", ")}]`);

    for (const folder of FOLDERS_TO_SYNC) {
      try {
        await runPipeline(folder);
        // runPipeline logs its own DONE summary line
      } catch (err) {
        log.error(`Folder "${folder}" failed: ${(err as Error).message}`);
      }
    }
  },

  async pib_digest(_payload, _helpers) {
    log.runStart("Daily digest");
    try {
      const result = await sendDigest();
      if (result.sent) {
        log.info(`Digest sent: ${result.count} items`);
      } else {
        log.info("No pending digest items");
      }
    } catch (err) {
      log.error(`Digest failed: ${(err as Error).message}`);
    }
  },
};

const crontab = parseCronItems([
  {
    task: "pib_ingest",
    match: "*/15 * * * *",
    identifier: "pib_ingest_cron",
  },
  {
    task: "pib_digest",
    match: "0 8 * * *",
    identifier: "pib_digest_cron",
  },
]);

async function main() {
  log.runStart("Worker starting");
  await writeVersionInfo("worker");

  try {
    await sql`SELECT 1`;
    log.info("Database connected");
  } catch (err) {
    log.error(`Failed to connect to database: ${err}`);
    process.exit(1);
  }

  const runner = await run({
    connectionString: process.env.DATABASE_URL ?? "postgres://localhost/willow",
    concurrency: 1,
    noHandleSignals: true,
    taskList: tasks,
    parsedCronItems: crontab,
  });

  log.info("Graphile Worker started — cron: pib_ingest */15min, pib_digest 8am daily");

  const shutdown = async () => {
    log.info("Shutting down...");
    await runner.stop();
    await sql.end();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
});
