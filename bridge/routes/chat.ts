import type { FastifyInstance } from "fastify";
import type { SessionPool } from "../session-pool/pool.js";
import { sendToChannel } from "../channel-client.js";
import { sql } from "../db.js";

interface ChatRequest {
  message: string;
  conversation_id?: string;
}

export async function chatRoutes(
  fastify: FastifyInstance,
  opts: { pool: SessionPool }
) {
  fastify.post<{ Body: ChatRequest }>("/chat", async (req, reply) => {
    const { message, conversation_id } = req.body;

    if (!message) {
      return reply.status(400).send({ error: "message is required" });
    }

    const requestId = crypto.randomUUID();

    // Reuse existing conversation or create a new one
    let conversationId: string;
    if (conversation_id) {
      const [existing] = await sql`
        SELECT conversation_id FROM conversation WHERE conversation_id = ${conversation_id}
      `;
      if (!existing) {
        return reply.status(404).send({ error: "conversation not found" });
      }
      conversationId = conversation_id;
    } else {
      const [row] = await sql`INSERT INTO conversation DEFAULT VALUES RETURNING conversation_id`;
      conversationId = row.conversation_id;
    }
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

      // Log both sides of the conversation
      await sql`
        INSERT INTO conversation_message (conversation_id, session_id, request_id, role, content)
        VALUES
          (${conversationId}, ${session.sessionId}, ${requestId}, 'user', ${message}),
          (${conversationId}, ${session.sessionId}, ${requestId}, 'assistant', ${text})
      `;

      return {
        request_id: requestId,
        conversation_id: conversationId,
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
