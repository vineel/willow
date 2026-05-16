import Fastify from "fastify";
import { config } from "./config.js";
import { SessionPool } from "./session-pool/pool.js";
import { healthRoutes } from "./routes/health.js";
import { agentRoutes } from "./routes/agent.js";
import { chatRoutes } from "./routes/chat.js";
import { conversationRoutes } from "./routes/conversation.js";
import { todoRoutes } from "./routes/todos.js";
import { gizmoRoutes } from "./routes/gizmo.js";

const fastify = Fastify({ logger: true });
const pool = new SessionPool(config.pool, config);

await fastify.register(healthRoutes, { pool });
await fastify.register(agentRoutes);
await fastify.register(chatRoutes, { pool });
await fastify.register(conversationRoutes);
await fastify.register(todoRoutes);
await fastify.register(gizmoRoutes);

await pool.start();

await fastify.listen({ port: config.port, host: config.host });
fastify.log.info(`Bridge server listening on ${config.host}:${config.port}`);
fastify.log.info(`Public URL: ${config.publicUrl}`);
