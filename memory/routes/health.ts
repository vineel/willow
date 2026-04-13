import { Hono } from "hono";
import { sql } from "../db";
import { healthCheck as lmstudioHealth } from "../lmstudio/client";

const health = new Hono();

health.get("/health", async (c) => {
  const [queueStats] = await sql`
    SELECT
      count(*) FILTER (WHERE status = 'pending') AS pending,
      count(*) FILTER (WHERE status = 'processing') AS processing,
      count(*) FILTER (WHERE status = 'done') AS done,
      count(*) FILTER (WHERE status = 'failed') AS failed
    FROM app.fact_queue
  `;

  const [factStats] = await sql`
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE is_active) AS active,
      count(*) FILTER (WHERE embedding IS NOT NULL AND is_active) AS with_embeddings
    FROM app.fact
  `;

  const lmstudioOk = await lmstudioHealth();

  return c.json({
    ok: true,
    lmstudio: lmstudioOk,
    queue: {
      pending: Number(queueStats.pending),
      processing: Number(queueStats.processing),
      done: Number(queueStats.done),
      failed: Number(queueStats.failed),
    },
    facts: {
      total: Number(factStats.total),
      active: Number(factStats.active),
      withEmbeddings: Number(factStats.with_embeddings),
    },
  });
});

export { health };
