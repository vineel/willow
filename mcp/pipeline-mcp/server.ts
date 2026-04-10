#!/usr/bin/env bun
/**
 * MCP server for PIB pipeline operations.
 * Check status, trigger runs, preview/send digests.
 *
 * Must use stderr for all logging — stdout is MCP stdio.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { sql } from "../../pib/config";
import { runPipeline } from "../../pib/pipeline";
import { previewDigest, sendDigest } from "../../pib/digest";

const server = new McpServer(
  { name: "willow-pipeline", version: "0.1.0" },
  {
    instructions: [
      "Use pipeline_status to check recent pipeline activity and pending items.",
      "Use run_now to trigger an immediate pipeline run (useful after creating new interests or rules).",
      "Use digest_preview to see what the next digest would contain.",
      "Use send_digest to send the digest immediately (normally sent daily at 8am).",
    ].join(" "),
  }
);

server.tool(
  "pipeline_status",
  "Show recent pipeline activity: last run time, pending digest items, recent ingestions, and active interests/rules counts.",
  {},
  async () => {
    const [lastSync] = await sql`
      SELECT folder, last_run_at FROM app.source_adapter_state
      WHERE source_type = 'email'
      ORDER BY last_run_at DESC LIMIT 1
    `;

    const [digestCount] = await sql`
      SELECT COUNT(*) as count FROM app.fact
      WHERE triage_action = 'digest' AND digest_sent_at IS NULL
    `;

    const [recentIngested] = await sql`
      SELECT COUNT(*) as count FROM app.source_note
      WHERE source_type = 'email' AND created_at > now() - interval '24 hours'
    `;

    const [interestCount] = await sql`
      SELECT COUNT(*) as count FROM app.interest WHERE enabled = true
    `;

    const [ruleCount] = await sql`
      SELECT COUNT(*) as count FROM app.triage_rule WHERE enabled = true AND confirmed = true
    `;

    const [triageBreakdown] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE triage_action = 'noise') as noise,
        COUNT(*) FILTER (WHERE triage_action = 'digest') as digest,
        COUNT(*) FILTER (WHERE triage_action = 'queue') as queue,
        COUNT(*) FILTER (WHERE triage_action = 'flag') as flag
      FROM app.fact f
      JOIN app.source_note sn ON f.source_note_id = sn.source_note_id
      WHERE sn.source_type = 'email' AND sn.created_at > now() - interval '24 hours'
    `;

    const [recentActions] = await sql`
      SELECT COUNT(*) as count FROM app.handler_execution
      WHERE executed_at > now() - interval '24 hours'
    `;

    const lines = [
      `Last sync: ${lastSync ? `${lastSync.folder} at ${new Date(lastSync.last_run_at).toLocaleString()}` : "never"}`,
      `Ingested (24h): ${recentIngested.count}`,
      `Triage (24h): noise=${triageBreakdown?.noise ?? 0} digest=${triageBreakdown?.digest ?? 0} queue=${triageBreakdown?.queue ?? 0} flag=${triageBreakdown?.flag ?? 0}`,
      `Pending digest items: ${digestCount.count}`,
      `Actions executed (24h): ${recentActions.count}`,
      `Active interests: ${interestCount.count}`,
      `Active triage rules: ${ruleCount.count}`,
    ];

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  }
);

server.tool(
  "run_now",
  "Trigger an immediate pipeline run on inbox + signal folders. Useful after creating new interests or rules to process recent emails.",
  {
    folder: z.string().optional().default("inbox").describe("Folder to process (default: inbox)"),
    limit: z.number().optional().default(50).describe("Max emails to fetch (default: 50)"),
  },
  async ({ folder, limit }) => {
    const stats = await runPipeline(folder, { limit });

    const lines = [
      `Pipeline run complete for "${folder}":`,
      `  Fetched: ${stats.fetched}`,
      `  Ingested: ${stats.ingested} (${stats.skipped} already existed)`,
      `  Triage: ${Object.entries(stats.triaged).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
      `  Classified: ${stats.classified}`,
      `  Extracted: ${stats.extracted}`,
      `  Dispatched: ${stats.dispatched}`,
    ];
    if (stats.errors.length > 0) {
      lines.push(`  Errors: ${stats.errors.join("; ")}`);
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  }
);

server.tool(
  "digest_preview",
  "Preview what the next digest email would contain. Shows pending digest items grouped by category, without sending.",
  {},
  async () => {
    const { text, count } = await previewDigest();
    return {
      content: [{ type: "text", text: count > 0 ? text : "No pending digest items." }],
    };
  }
);

server.tool(
  "send_digest",
  "Send the digest email immediately. Normally this happens daily at 8am, but use this to send it now. Marks all included items as sent.",
  {},
  async () => {
    const result = await sendDigest();
    return {
      content: [{
        type: "text",
        text: result.sent
          ? `Digest sent with ${result.count} items.`
          : "No pending digest items to send.",
      }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
