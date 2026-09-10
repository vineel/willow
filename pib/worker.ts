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
import { etCronItems, inEasternHour } from "../lib/et-cron";
import { runCalSync } from "../cal/sync";
import { runCalExtraction } from "../cal/extract";
import { runPortfolioReport } from "./portfolio/run";
import { executeGizmoDispatch, sweepExpiredGizmos } from "./gizmo-dispatch";
import { runScanSent } from "./foldersort/scan-sent";

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

  async pib_digest(payload, _helpers) {
    const etHour = (payload as { __etHour?: number })?.__etHour;
    if (etHour !== undefined && !inEasternHour(etHour)) return;
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

  async portfolio_report(payload, _helpers) {
    const etHour = (payload as { __etHour?: number })?.__etHour;
    if (etHour !== undefined && !inEasternHour(etHour)) return;
    const variant = (payload as { variant?: "premarket" | "midday" | "postclose" })?.variant ?? "midday";
    log.runStart(`Portfolio valuation (${variant})`);
    try {
      await runPortfolioReport(variant);
      log.info("Portfolio report sent");
    } catch (err) {
      log.error(`Portfolio report failed: ${(err as Error).message}`);
    }
  },

  async cal_sync(_payload, _helpers) {
    log.runStart("Calendar sync");
    try {
      const stats = await runCalSync();
      log.info(
        `Cal sync: ${stats.eventsCreated} created, ${stats.eventsUpdated} updated, ${stats.extractionEnqueued} enqueued`
      );

      if (stats.extractionEnqueued > 0) {
        const extractResult = await runCalExtraction();
        log.info(`Cal extract: ${extractResult.processed} processed, ${extractResult.errors} errors`);
      }
    } catch (err) {
      log.error(`Calendar sync failed: ${(err as Error).message}`);
    }
  },

  async gizmo_dispatch(payload, _helpers) {
    const slug = (payload as { slug?: string })?.slug;
    if (!slug) {
      log.error("gizmo_dispatch missing slug");
      return;
    }
    log.runStart(`Gizmo dispatch: ${slug}`);
    try {
      await executeGizmoDispatch(slug);
    } catch (err) {
      log.error(`Gizmo dispatch failed: ${(err as Error).message}`);
      throw err;
    }
  },

  async gizmo_sweep(_payload, _helpers) {
    try {
      const expired = await sweepExpiredGizmos();
      if (expired > 0) log.info(`Gizmo sweep: ${expired} expired`);
    } catch (err) {
      log.error(`Gizmo sweep failed: ${(err as Error).message}`);
    }
  },

  async foldersort_scan_sent(payload, _helpers) {
    const etHour = (payload as { __etHour?: number })?.__etHour;
    if (etHour !== undefined && !inEasternHour(etHour)) return;
    const since = (payload as { since?: string })?.since ?? "2d";
    log.runStart(`foldersort scan-sent (since=${since})`);
    try {
      const r = await runScanSent(since);
      log.info(
        `scan-sent done: ${r.inserted} new, ${r.updated} bumped, ${r.emailsSeen} emails`
      );
    } catch (err) {
      log.error(`foldersort scan-sent failed: ${(err as Error).message}`);
    }
  },
};

const crontab = parseCronItems([
  {
    task: "pib_ingest",
    match: "*/15 * * * *",
    identifier: "pib_ingest_cron",
  },
  ...etCronItems({
    task: "pib_digest",
    identifier: "pib_digest_weekday_cron",
    hour: 6,
    minute: 45,
    dayOfWeek: "1-5",
  }),
  ...etCronItems({
    task: "pib_digest",
    identifier: "pib_digest_weekend_cron",
    hour: 8,
    dayOfWeek: "0,6",
  }),
  ...etCronItems({
    task: "portfolio_report",
    identifier: "portfolio_premarket_cron",
    hour: 9,
    minute: 15,
    dayOfWeek: "1-5",
    payload: { variant: "premarket" },
  }),
  ...etCronItems({
    task: "portfolio_report",
    identifier: "portfolio_midday_cron",
    hour: 12,
    minute: 30,
    dayOfWeek: "1-5",
    payload: { variant: "midday" },
  }),
  ...etCronItems({
    task: "portfolio_report",
    identifier: "portfolio_postclose_cron",
    hour: 16,
    minute: 35,
    dayOfWeek: "1-5",
    payload: { variant: "postclose" },
  }),
  {
    task: "cal_sync",
    match: "*/30 * * * *",
    identifier: "cal_sync_cron",
  },
  {
    task: "gizmo_sweep",
    match: "0 * * * *",
    identifier: "gizmo_sweep_cron",
  },
  ...etCronItems({
    task: "foldersort_scan_sent",
    identifier: "foldersort_scan_sent_daily_cron",
    hour: 4,
    minute: 30,
    payload: { since: "2d" },
  }),
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

  log.info("Graphile Worker started — cron: pib_ingest */15min, pib_digest 6:45am ET M-F / 8am ET Sat-Sun, portfolio 9:15/12:30/16:35 ET M-F, cal_sync */30min, foldersort_scan_sent 4:30am ET daily");

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
