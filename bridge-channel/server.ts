import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PendingRequests } from "./pending-requests.js";

const CHANNEL_PORT = parseInt(Bun.argv[2] || "8788", 10);
const REQUEST_TIMEOUT_MS = 120_000;

// All logging to stderr — stdout is MCP stdio, must not corrupt
const log = (...args: unknown[]) => console.error("[bridge-channel]", ...args);

const pending = new PendingRequests();

// --- MCP Server ---

const mcp = new Server(
  { name: "bridge-channel", version: "0.0.1" },
  {
    capabilities: {
      tools: {},
      experimental: { "claude/channel": {} },
    },
    instructions: [
      "You receive messages from users via channel notifications.",
      "When you have composed your response, you MUST call the reply tool",
      "with your response text and the request_id from the notification metadata.",
      "Always use the reply tool — never just output text without calling it.",
    ].join(" "),
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Send your response back to the user. You must call this tool with the request_id from the channel notification metadata.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: {
            type: "string",
            description: "Your response text",
          },
          request_id: {
            type: "string",
            description:
              "The request_id from the channel notification metadata",
          },
        },
        required: ["text", "request_id"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "reply") {
    const text = (args?.text as string) ?? "";
    const requestId = args?.request_id as string;

    if (!requestId) {
      return {
        content: [{ type: "text" as const, text: "Error: request_id is required" }],
      };
    }

    const resolved = pending.resolve(requestId, text);
    log(
      resolved
        ? `Reply resolved for ${requestId}`
        : `No pending request for ${requestId}`
    );

    return {
      content: [
        {
          type: "text" as const,
          text: resolved
            ? "Reply delivered successfully."
            : `No pending request found for request_id: ${requestId}`,
        },
      ],
    };
  }

  return {
    content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
  };
});

// --- HTTP Server (receives POSTs from bridge) ---

const httpServer = Bun.serve({
  port: CHANNEL_PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", port: CHANNEL_PORT });
    }

    if (req.method === "POST" && url.pathname === "/request") {
      try {
        const body = (await req.json()) as {
          request_id: string;
          message: string;
        };

        if (!body.request_id || !body.message) {
          return Response.json(
            { error: "request_id and message are required" },
            { status: 400 }
          );
        }

        log(`Received request ${body.request_id}`);

        // Create pending promise before pushing notification
        const responsePromise = pending.create(
          body.request_id,
          REQUEST_TIMEOUT_MS
        );

        // Push notification into Claude Code session
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: body.message,
            meta: { request_id: body.request_id, source: "bridge" },
          },
        });

        log(`Notification pushed for ${body.request_id}, awaiting reply...`);

        // Wait for Claude to call the reply tool
        const text = await responsePromise;

        return Response.json({ request_id: body.request_id, text });
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Internal channel error";
        log(`Error: ${message}`);
        return Response.json({ error: message }, { status: 500 });
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

log(`HTTP server listening on port ${httpServer.port}`);

// --- Connect MCP to stdio ---

const transport = new StdioServerTransport();
await mcp.connect(transport);

log("MCP server connected via stdio");
