#!/usr/bin/env bun
/**
 * Willow Slack Channel — pushes Slack messages into the Claude Code session
 * and exposes a reply tool so Claude can respond in-thread.
 *
 * Uses Slack Bolt SDK in Socket Mode (no public URL needed).
 * Must use stderr for all logging — stdout is MCP stdio.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { App, LogLevel } from "@slack/bolt";
import { getSecret } from "../../pib/config";

// ── Secrets ──────────────────────────────────────────────────────────────────
const botToken = await getSecret("slack-bot-token");
const appToken = await getSecret("slack-app-token");
const allowedUserId = await getSecret("slack-user-id");

const log = (...args: unknown[]) =>
  console.error("[slack-channel]", ...args);

// ── MCP Channel Server ──────────────────────────────────────────────────────
const mcp = new Server(
  { name: "slack-channel", version: "0.1.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions: [
      'Messages from Slack arrive as <channel source="slack-channel" user="..." channel="..." ts="...">.',
      "Reply using the slack_reply tool, passing the channel and ts from the tag.",
      "The ts (timestamp) is Slack's message ID — pass it as thread_ts to reply in-thread.",
      "Keep replies concise. Use markdown formatting (Slack mrkdwn).",
    ].join(" "),
  }
);

// ── Reply tool ───────────────────────────────────────────────────────────────
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "slack_reply",
      description: "Send a reply back to Slack",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: {
            type: "string",
            description: "The Slack channel ID to reply in",
          },
          text: {
            type: "string",
            description: "The message text (Slack mrkdwn format)",
          },
          thread_ts: {
            type: "string",
            description:
              "Thread timestamp to reply in-thread (pass ts from the inbound message)",
          },
        },
        required: ["channel", "text"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "slack_reply") {
    const { channel, text, thread_ts } = req.params.arguments as {
      channel: string;
      text: string;
      thread_ts?: string;
    };
    try {
      await slackApp.client.chat.postMessage({
        channel,
        text,
        thread_ts,
      });
      return { content: [{ type: "text" as const, text: "sent" }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log("reply error:", msg);
      return { content: [{ type: "text" as const, text: `error: ${msg}` }] };
    }
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});

// ── Permission relay ─────────────────────────────────────────────────────────
const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

// Track which channel to send permission prompts to (most recent DM or channel)
let permissionChannel: string | null = null;

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  if (!permissionChannel) {
    log("permission request but no channel to send to");
    return;
  }
  try {
    await slackApp.client.chat.postMessage({
      channel: permissionChannel,
      text:
        `*Permission request:* Claude wants to run \`${params.tool_name}\`\n` +
        `> ${params.description}\n\n` +
        `Reply \`yes ${params.request_id}\` or \`no ${params.request_id}\``,
    });
  } catch (err) {
    log("failed to send permission prompt:", err);
  }
});

// ── Permission reply interception ────────────────────────────────────────────
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

// ── Connect MCP ──────────────────────────────────────────────────────────────
await mcp.connect(new StdioServerTransport());
log("MCP channel connected");

// ── Slack Bolt App ───────────────────────────────────────────────────────────
const slackApp = new App({
  token: botToken,
  appToken: appToken,
  socketMode: true,
  // Send all Bolt logs to stderr so they don't corrupt MCP stdio
  logLevel: LogLevel.WARN,
  logger: {
    debug: (...args) => console.error("[bolt:debug]", ...args),
    info: (...args) => console.error("[bolt:info]", ...args),
    warn: (...args) => console.error("[bolt:warn]", ...args),
    error: (...args) => console.error("[bolt:error]", ...args),
    getLevel: () => LogLevel.WARN,
    setLevel: () => {},
    setName: () => {},
  },
});

// Handle all messages
slackApp.message(async ({ message }) => {
  // Only handle regular user messages (not bot messages, edits, etc.)
  if (message.subtype) return;
  if (!("user" in message) || !("text" in message)) return;

  // Sender gate: only process messages from Vineel
  if (message.user !== allowedUserId) {
    log(`ignored message from ${message.user} (not in allowlist)`);
    return;
  }

  const text = message.text ?? "";
  const channel = message.channel;
  const ts = message.ts;

  // Track channel for permission prompts
  permissionChannel = channel;

  // Check for permission reply before forwarding as chat
  const m = PERMISSION_REPLY_RE.exec(text);
  if (m) {
    await mcp.notification({
      method: "notifications/claude/channel/permission",
      params: {
        request_id: m[2].toLowerCase(),
        behavior: m[1].toLowerCase().startsWith("y") ? "allow" : "deny",
      },
    });
    log(`permission verdict: ${m[1]} ${m[2]}`);
    return;
  }

  // Forward to Claude as a channel event
  log(`message from ${message.user}: ${text.slice(0, 80)}`);
  await mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content: text,
      meta: {
        user: message.user,
        channel,
        ts,
      },
    },
  });
});

await slackApp.start();
log("Slack Socket Mode connected");
