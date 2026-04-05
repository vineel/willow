import type { FastifyInstance } from "fastify";
import { sql } from "../db.js";

export async function conversationRoutes(fastify: FastifyInstance) {
  // List conversations with last message timestamp
  fastify.get("/conversations", async () => {
    const rows = await sql`
      SELECT
        c.conversation_id,
        c.title,
        c.created_at,
        m.content AS last_message,
        m.created_at AS last_message_at
      FROM conversation c
      LEFT JOIN LATERAL (
        SELECT content, created_at
        FROM conversation_message
        WHERE conversation_id = c.conversation_id
        ORDER BY created_at DESC
        LIMIT 1
      ) m ON true
      ORDER BY COALESCE(m.created_at, c.created_at) DESC
    `;

    return {
      conversations: rows.map((r) => ({
        conversation_id: r.conversation_id,
        title: r.title,
        created_at: r.created_at,
        last_message: r.last_message,
        last_message_at: r.last_message_at,
      })),
    };
  });

  // Get full conversation history
  fastify.get<{ Params: { conversationId: string } }>(
    "/conversation/:conversationId",
    async (req, reply) => {
      const { conversationId } = req.params;

      const [conversation] = await sql`
        SELECT conversation_id, title, created_at
        FROM conversation
        WHERE conversation_id = ${conversationId}
      `;

      if (!conversation) {
        return reply.status(404).send({ error: "conversation not found" });
      }

      const rows = await sql`
        SELECT role, content, request_id, created_at
        FROM conversation_message
        WHERE conversation_id = ${conversationId}
        ORDER BY created_at
      `;

      return {
        conversation_id: conversation.conversation_id,
        title: conversation.title,
        created_at: conversation.created_at,
        messages: rows.map((r) => ({
          role: r.role,
          content: r.content,
          request_id: r.request_id,
          timestamp: r.created_at,
        })),
      };
    }
  );
}
