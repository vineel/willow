import type { FastifyInstance } from "fastify";
import type { SessionPool } from "../session-pool/pool.js";

export async function healthRoutes(
  fastify: FastifyInstance,
  opts: { pool: SessionPool }
) {
  fastify.get("/health", async () => {
    return {
      status: "ok",
      pool: opts.pool.getStatus(),
    };
  });
}
