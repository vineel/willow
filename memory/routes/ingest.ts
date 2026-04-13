import { Hono } from "hono";
import type { WorkerUtils } from "graphile-worker";

export function createIngestRoutes(workerUtils: WorkerUtils) {
  const ingest = new Hono();

  ingest.post("/api/ingest/note", async (c) => {
    const body = await c.req.json<{ filePath: string }>();

    if (!body.filePath || typeof body.filePath !== "string") {
      return c.json({ error: "filePath is required" }, 400);
    }

    const file = Bun.file(body.filePath);
    if (!(await file.exists())) {
      return c.json({ error: "File not found" }, 404);
    }

    await workerUtils.addJob("ingest_note", { filePath: body.filePath }, {
      jobKey: body.filePath,
      jobKeyMode: "replace",
      maxAttempts: 1,
    });

    return c.json({ ok: true, filePath: body.filePath, message: "Queued for ingestion" });
  });

  return ingest;
}
