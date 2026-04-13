import { Hono } from "hono";
import { makeWorkerUtils } from "graphile-worker";
import { config } from "./config";
import { sql } from "./db";
import { startWorker } from "./worker/setup";
import { startWatcher, reconciliationScan } from "./watcher/watch";
import { health } from "./routes/health";
import { createIngestRoutes } from "./routes/ingest";
import { search } from "./routes/search";
import { createFactsRoutes } from "./routes/facts";

async function main() {
  console.log("[memory] Starting Willow Memory Server...");
  console.log(`[memory] NOTES_ROOT: ${config.notesRoot}`);
  console.log(`[memory] LM Studio: ${config.lmstudio.baseUrl}`);

  // 1. Verify DB connection
  try {
    await sql`SELECT 1`;
    console.log("[memory] Database connected");
  } catch (err) {
    console.error("[memory] Failed to connect to database:", err);
    process.exit(1);
  }

  // 2. Start Graphile Worker runner (processes jobs)
  const runner = await startWorker();

  // 3. Get worker utils (for enqueuing jobs from watcher and routes)
  const workerUtils = await makeWorkerUtils({
    connectionString: config.databaseUrl,
  });

  // 4. Run reconciliation scan
  await reconciliationScan(config.notesRoot, workerUtils);

  // 5. Start file watcher
  const watcher = startWatcher(config.notesRoot, workerUtils);

  // 6. Start Hono HTTP server
  const app = new Hono();
  app.route("/", health);
  app.route("/", createIngestRoutes(workerUtils));
  app.route("/", search);
  app.route("/", createFactsRoutes(workerUtils));

  const server = Bun.serve({
    port: config.port,
    fetch: app.fetch,
  });

  console.log(`[memory] HTTP server listening on port ${config.port}`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[memory] Shutting down...");
    await watcher.close();
    await runner.stop();
    await workerUtils.release();
    await sql.end();
    server.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[memory] Fatal error:", err);
  process.exit(1);
});
