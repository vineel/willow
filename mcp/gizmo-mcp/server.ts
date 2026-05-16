#!/usr/bin/env bun
/**
 * MCP server for Gizmos — ephemeral on-the-fly web UIs Willow creates during
 * conversations to gather structured input from Vineel. See notes/gizmo-design.md.
 *
 * Must use stderr for all logging — stdout is MCP stdio.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createHmac, randomBytes } from "crypto";
import { sql } from "../../pib/config";

const SIGNING_KEY = process.env.GIZMO_SIGNING_KEY ?? "willow-gizmo-dev-key-change-me";
const PUBLIC_URL = process.env.WILLOW_PUBLIC_URL ?? "http://terokNor.local:8787";
const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function slugId(len = 6): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  }
  return out;
}

function hint(title: string): string {
  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join("-");
  return cleaned || "gizmo";
}

function buildSlug(title: string): string {
  return `${hint(title)}-${slugId(6)}`;
}

function tokenFor(slug: string): string {
  return createHmac("sha256", SIGNING_KEY).update(slug).digest("hex");
}

const server = new McpServer(
  { name: "willow-gizmo", version: "0.1.0" },
  {
    instructions: [
      "Create ephemeral on-the-fly web UIs (Gizmos) during conversations to gather structured input from Vineel.",
      "Use create_gizmo when a chat ask would benefit from a tiny web form: multi-select from a list, ranking, structured editing, anything where typing the answer in chat is friction.",
      "Don't use Gizmos for simple yes/no — chat handles those.",
      "The body_html you supply is a form fragment (no <html>/<head>/<body>) styled by a stylesheet that handles semantic HTML. Use <ul class='checklist'> with <li><label><input type='checkbox' name='X' value='Y'> ...</label></li> for selection lists. Use semantic <fieldset>/<legend>/<input>/<select>/<textarea> for forms. Submit button is added automatically.",
      "data_context is read-only data the page displays — it's also passed to the dispatch step alongside the submission, so include any IDs / context needed to act.",
      "action_prompt is natural-language instructions executed via claude -p sonnet on submit, with notify/memory/todo/web MCPs available. Tell it what to do with the submission and how to send the result.",
      "return_channel determines where the result goes: 'imessage:vineel', 'slack:CHANNELID', 'claude-p:session-id'.",
      "URLs are local-network only and expire in 24 hours by default.",
    ].join(" "),
  }
);

// ── create_gizmo ────────────────────────────────────────────────────────────

server.tool(
  "create_gizmo",
  "Create an ephemeral local web UI to gather structured input. Returns a URL the user opens to interact. On submit, the dispatch runs claude -p with the action_prompt + submission data and sends the result to return_channel.",
  {
    title: z.string().describe("Short title shown in the page header (e.g. 'Reach out to Amazon folks')"),
    body_html: z.string().describe("HTML form fragment — no <html>/<head>/<body>. Use semantic HTML; <ul class='checklist'> with <li><label><input type='checkbox' name='X' value='Y'> ...</label></li> for selection lists."),
    data_context: z.record(z.unknown()).optional().describe("Read-only data shown in the page; also passed to dispatch alongside the submission. Include IDs needed to act."),
    action_prompt: z.string().describe("Natural-language instructions executed via claude -p sonnet on submit. Tell it what to do with the submission, which MCPs to use, and to send the result via notify."),
    return_channel: z.string().describe("Where the result goes: 'imessage:vineel', 'slack:CHANNELID', or 'claude-p:session-id'"),
    ttl_hours: z.number().optional().default(24).describe("Hours until the Gizmo expires. Default 24."),
  },
  async ({ title, body_html, data_context, action_prompt, return_channel, ttl_hours }) => {
    const slug = buildSlug(title);
    const token = tokenFor(slug);
    const ttl = ttl_hours ?? 24;

    const [row] = (await sql`
      INSERT INTO app.gizmo (
        slug, title, body_html, data_context, action_prompt, return_channel,
        hmac_token, expires_at
      ) VALUES (
        ${slug},
        ${title},
        ${body_html},
        ${(data_context ?? {}) as Record<string, unknown>},
        ${action_prompt},
        ${return_channel},
        ${token},
        now() + (${ttl} || ' hours')::interval
      )
      RETURNING slug, expires_at
    `) as unknown as Array<{ slug: string; expires_at: Date }>;

    const url = `${PUBLIC_URL}/gizmo/${encodeURIComponent(row.slug)}?t=${encodeURIComponent(token)}`;

    return {
      content: [{
        type: "text",
        text: [
          `Created Gizmo: ${row.slug}`,
          `URL: ${url}`,
          `Expires: ${row.expires_at.toISOString()}`,
          ``,
          `Send the URL to the user. The dispatch will fire automatically on submit and deliver the result to ${return_channel}.`,
        ].join("\n"),
      }],
    };
  }
);

// ── get_gizmo ───────────────────────────────────────────────────────────────

server.tool(
  "get_gizmo",
  "Look up a Gizmo's current status, submission, and metadata.",
  {
    slug: z.string().describe("The Gizmo slug (returned by create_gizmo)"),
  },
  async ({ slug }) => {
    const [g] = (await sql`
      SELECT slug, title, status, return_channel, submission,
             created_at, expires_at, dispatched_at
      FROM app.gizmo
      WHERE slug = ${slug}
    `) as unknown as Array<{
      slug: string;
      title: string;
      status: string;
      return_channel: string;
      submission: Record<string, unknown> | null;
      created_at: Date;
      expires_at: Date;
      dispatched_at: Date | null;
    }>;

    if (!g) {
      return { content: [{ type: "text", text: `Gizmo "${slug}" not found.` }] };
    }

    const lines = [
      `Gizmo: ${g.slug}`,
      `Title: ${g.title}`,
      `Status: ${g.status}`,
      `Return channel: ${g.return_channel}`,
      `Created: ${g.created_at.toISOString()}`,
      `Expires: ${g.expires_at.toISOString()}`,
    ];
    if (g.dispatched_at) lines.push(`Dispatched: ${g.dispatched_at.toISOString()}`);
    if (g.submission) {
      lines.push(``, `Submission:`, JSON.stringify(g.submission, null, 2));
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ── cancel_gizmo ────────────────────────────────────────────────────────────

server.tool(
  "cancel_gizmo",
  "Cancel a pending Gizmo so the user can no longer submit it.",
  {
    slug: z.string().describe("The Gizmo slug to cancel"),
  },
  async ({ slug }) => {
    const result = await sql`
      UPDATE app.gizmo
      SET status = 'cancelled'
      WHERE slug = ${slug} AND status = 'pending'
      RETURNING slug
    `;

    if (result.length === 0) {
      return { content: [{ type: "text", text: `Gizmo "${slug}" not found or not pending.` }] };
    }

    return { content: [{ type: "text", text: `Cancelled Gizmo: ${slug}` }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
