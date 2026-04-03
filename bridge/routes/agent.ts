import type { FastifyInstance } from "fastify";
import { runClaudeP } from "../claude-p.js";

interface AgentReasonRequest {
  prompt: string;
  session_id?: string;
  mcp_config?: string;
}

export async function agentRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: AgentReasonRequest }>("/agent/reason", async (req, reply) => {
    const { prompt, session_id, mcp_config } = req.body;

    if (!prompt) {
      return reply.status(400).send({ error: "prompt is required" });
    }

    const requestId = crypto.randomUUID();
    req.log.info({ requestId, resuming: !!session_id }, "Agent reasoning request");

    try {
      const result = await runClaudeP({
        prompt,
        sessionId: session_id,
        mcpConfig: mcp_config,
      });

      return {
        request_id: requestId,
        result: result.result,
        session_id: result.session_id,
        duration_ms: result.duration_ms,
        num_turns: result.num_turns,
        total_cost_usd: result.total_cost_usd,
        usage: result.usage,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "claude -p failed";
      req.log.error({ requestId, error: message }, "Agent reasoning failed");
      return reply.status(502).send({ error: message, request_id: requestId });
    }
  });
}
