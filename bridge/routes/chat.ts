import type { FastifyInstance } from "fastify";
import type { SessionPool } from "../session-pool/pool.js";
import { sendToChannel } from "../channel-client.js";

interface ChatRequest {
  message: string;
}

export async function chatRoutes(
  fastify: FastifyInstance,
  opts: { pool: SessionPool }
) {
  fastify.post<{ Body: ChatRequest }>("/chat", async (req, reply) => {
    const { message } = req.body;

    if (!message) {
      return reply.status(400).send({ error: "message is required" });
    }

    const requestId = crypto.randomUUID();
    req.log.info({ requestId }, "Chat request");

    // Acquire a session from the pool
    const session = await opts.pool.acquireSession(requestId);
    if (!session) {
      return reply.status(503).send({
        error: "No sessions available",
        request_id: requestId,
      });
    }

    try {
      const text = await sendToChannel(session.channelPort, requestId, message);

      return {
        request_id: requestId,
        text,
        session_id: session.sessionId,
      };
    } catch (err: unknown) {
      const errMessage =
        err instanceof Error ? err.message : "Channel communication failed";
      req.log.error(
        { requestId, sessionId: session.sessionId, error: errMessage },
        "Chat request failed"
      );
      return reply
        .status(502)
        .send({ error: errMessage, request_id: requestId });
    } finally {
      opts.pool.releaseSession(session.sessionId);
    }
  });
}
