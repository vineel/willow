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
import { getSecret, sql } from "../../pib/config";

// ── Secrets ──────────────────────────────────────────────────────────────────
const botToken = await getSecret("slack-bot-token");
const appToken = await getSecret("slack-app-token");
const allowedUserId = await getSecret("slack-user-id");

const log = (...args: unknown[]) =>
  console.error("[slack-channel]", ...args);

// ── Todo card helpers ───────────────────────────────────────────────────────
// Slack checkboxes blocks allow max 10 options each, so we chunk.
const TODO_CHECKBOX_CHUNK = 10;

type OpenTodo = {
  id: string;
  title: string;
  priority: string;
  due_date: Date | null;
};

async function fetchOpenTodos(): Promise<OpenTodo[]> {
  return await sql<OpenTodo[]>`
    SELECT id, title, priority, due_date
    FROM app.todo
    WHERE status = 'open'
    ORDER BY
      CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      due_date ASC NULLS LAST,
      created_at ASC
  `;
}

function todoDescription(t: OpenTodo, today: string): string | null {
  const parts: string[] = [];
  if (t.due_date) {
    const d = t.due_date.toISOString().slice(0, 10);
    parts.push(d < today ? `overdue · due ${d}` : `due ${d}`);
  }
  if (t.priority !== "normal") parts.push(t.priority);
  return parts.length > 0 ? parts.join(" · ") : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildTodoCardBlocks(todos: OpenTodo[], justCompleted = 0): any[] {
  const today = new Date().toISOString().slice(0, 10);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `Todos — ${todos.length} open` },
    },
  ];

  if (justCompleted > 0) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_Marked ${justCompleted} done._`,
        },
      ],
    });
  }

  if (todos.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No open todos._" },
    });
    return blocks;
  }

  // Chunk todos into checkbox blocks of up to 10.
  for (let i = 0; i < todos.length; i += TODO_CHECKBOX_CHUNK) {
    const chunk = todos.slice(i, i + TODO_CHECKBOX_CHUNK);
    blocks.push({
      type: "actions",
      block_id: `todo_checks_${i}`,
      elements: [
        {
          type: "checkboxes",
          action_id: "todo_check",
          options: chunk.map((t) => {
            const desc = todoDescription(t, today);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const option: any = {
              text: { type: "mrkdwn", text: t.title.slice(0, 150) },
              value: t.id,
            };
            if (desc) option.description = { type: "mrkdwn", text: desc };
            return option;
          }),
        },
      ],
    });
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "actions",
    block_id: "todo_card_actions",
    elements: [
      {
        type: "button",
        action_id: "apply_todo_changes",
        style: "primary",
        text: { type: "plain_text", text: "Apply" },
      },
      {
        type: "button",
        action_id: "refresh_todo_card",
        text: { type: "plain_text", text: "Refresh" },
      },
    ],
  });

  return blocks;
}

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
      "When the user asks to see or work through their todos, call slack_post_todo_card with the channel from the inbound message — it posts an interactive checkbox card. The Apply button is handled inside this server, no further Claude action needed.",
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
    {
      name: "slack_post_todo_card",
      description:
        "Post an interactive todo card (Block Kit checkboxes) to Slack. User checks items, presses Apply, and this server marks them done and updates the card in place.",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: {
            type: "string",
            description: "The Slack channel ID to post the card in",
          },
          thread_ts: {
            type: "string",
            description:
              "Optional thread timestamp to post the card inside a thread",
          },
        },
        required: ["channel"],
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
  if (req.params.name === "slack_post_todo_card") {
    const { channel, thread_ts } = req.params.arguments as {
      channel: string;
      thread_ts?: string;
    };
    try {
      const todos = await fetchOpenTodos();
      const blocks = buildTodoCardBlocks(todos);
      const res = await slackApp.client.chat.postMessage({
        channel,
        thread_ts,
        text: `Todos — ${todos.length} open`,
        blocks,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `posted todo card (${todos.length} open) ts=${res.ts}`,
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log("post todo card error:", msg);
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

// ── /todos slash command ────────────────────────────────────────────────────
slackApp.command("/todos", async ({ ack, command, client, respond }) => {
  await ack();
  try {
    if (command.user_id !== allowedUserId) {
      await respond({
        response_type: "ephemeral",
        text: "Not authorized.",
      });
      return;
    }
    const todos = await fetchOpenTodos();
    const blocks = buildTodoCardBlocks(todos);
    await client.chat.postMessage({
      channel: command.channel_id,
      text: `Todos — ${todos.length} open`,
      blocks,
    });
  } catch (err) {
    log("/todos command error:", err);
    await respond({
      response_type: "ephemeral",
      text: `error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

// ── Todo card interactivity ─────────────────────────────────────────────────

// Checkbox toggles: ack only (state is read when Apply is pressed).
slackApp.action("todo_check", async ({ ack }) => {
  await ack();
});

slackApp.action("apply_todo_changes", async ({ ack, body, client }) => {
  await ack();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = body as any;
    if (payload.user?.id !== allowedUserId) {
      log(`ignored apply from ${payload.user?.id} (not allowlisted)`);
      return;
    }

    const state = payload.state?.values ?? {};
    const checkedIds: string[] = [];
    for (const blockId of Object.keys(state)) {
      for (const actionId of Object.keys(state[blockId])) {
        const el = state[blockId][actionId];
        if (el?.type === "checkboxes" && Array.isArray(el.selected_options)) {
          for (const opt of el.selected_options) {
            if (typeof opt.value === "string") checkedIds.push(opt.value);
          }
        }
      }
    }

    let completed = 0;
    if (checkedIds.length > 0) {
      const result = await sql`
        UPDATE app.todo
        SET status = 'done', completed_at = now()
        WHERE id = ANY(${checkedIds}::uuid[]) AND status = 'open'
      `;
      completed = result.count;
    }

    const todos = await fetchOpenTodos();
    const blocks = buildTodoCardBlocks(todos, completed);
    await client.chat.update({
      channel: payload.channel.id,
      ts: payload.message.ts,
      text: `Todos — ${todos.length} open`,
      blocks,
    });
    log(`applied: ${completed} done, ${todos.length} remaining`);
  } catch (err) {
    log("apply_todo_changes error:", err);
  }
});

slackApp.action("refresh_todo_card", async ({ ack, body, client }) => {
  await ack();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = body as any;
    if (payload.user?.id !== allowedUserId) return;
    const todos = await fetchOpenTodos();
    const blocks = buildTodoCardBlocks(todos);
    await client.chat.update({
      channel: payload.channel.id,
      ts: payload.message.ts,
      text: `Todos — ${todos.length} open`,
      blocks,
    });
  } catch (err) {
    log("refresh_todo_card error:", err);
  }
});

await slackApp.start();
log("Slack Socket Mode connected");
