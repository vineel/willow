#!/usr/bin/env bun
/**
 * MCP server for managing user interests via conversation.
 * Claude Code calls these tools when the user says things like
 * "watch for Disney musicals" or "stop looking for concerts".
 *
 * Interests are stored in app.interest (Postgres).
 * Creating an interest auto-generates companion triage rules
 * to ensure emails from relevant domains survive triage.
 *
 * Must use stderr for all logging — stdout is MCP stdio.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { sql } from "../../pib/config";

const server = new McpServer(
  { name: "willow-interests", version: "0.1.0" },
  {
    instructions: [
      "Interests are standing instructions that tell Willow what to watch for in incoming email.",
      "When the user says 'look for X', 'let me know about Y', 'watch for Z', create an interest.",
      "Decompose the user's request into: keywords (for matching), source_domains (known senders),",
      "extraction_fields (structured data to pull out), and action_prompt (what to do on match).",
      "The action_prompt is a natural language instruction executed by Claude with MCP tools",
      "(send_notification, send_email, web_search, web_fetch) when a match is found.",
      "Creating an interest auto-generates companion triage rules for source_domains.",
    ].join(" "),
  }
);

server.tool(
  "create_interest",
  "Create a new standing interest. Willow will watch incoming emails for matches and execute the action_prompt via claude -p when a match is found. Use when the user says 'look for X', 'let me know about Y', 'watch for Z'. The action_prompt should be the user's natural language instruction for what to do when a match is found.",
  {
    name: z.string().describe("Short name for the interest (e.g. 'Disney musicals', 'concert tickets')"),
    description: z.string().describe("The user's original words describing what they want, for context"),
    keywords: z.array(z.string()).describe("Keywords to match in email subject and body (case-insensitive)"),
    source_domains: z.array(z.string()).optional().describe("Sender domains to watch (e.g. 'ticketmaster.com')"),
    extraction_fields: z.record(z.string(), z.string()).optional().describe("Fields to extract from matching emails. Keys are field names, values are types (e.g. {show_name: 'string', venue: 'string'})"),
    action_prompt: z.string().describe("Natural language instruction for what to do when a match is found. Executed by Claude with MCP tools (send_notification, send_email, web_search, web_fetch)."),
    on_match_action: z.enum(["flag", "queue", "digest"]).optional().default("flag").describe("Triage action for matched emails (default: flag)"),
    notify: z.boolean().optional().default(true).describe("Send a notification when matched (default: true)"),
  },
  async ({ name, description, keywords, source_domains, extraction_fields, action_prompt, on_match_action, notify }) => {
    // Create the interest
    const [interest] = await sql`
      INSERT INTO app.interest (
        name, description, keywords, source_domains, extraction_fields,
        action_prompt, on_match_action, notify, enabled
      ) VALUES (
        ${name},
        ${description},
        ${keywords as string[]},
        ${(source_domains ?? []) as string[]},
        ${extraction_fields ? sql.json(extraction_fields as any) : null},
        ${action_prompt},
        ${on_match_action},
        ${notify},
        true
      ) RETURNING id
    `;

    // Auto-create companion triage rules for source domains
    let rulesCreated = 0;
    for (const domain of source_domains ?? []) {
      const existing = await sql`
        SELECT id FROM app.triage_rule
        WHERE field = 'from_domain' AND operator = 'equals' AND value = ${domain.toLowerCase()}
        AND action IN ('queue', 'flag') AND enabled = true
      `;
      if (existing.length === 0) {
        await sql`
          INSERT INTO app.triage_rule (
            name, description, field, operator, value, action, priority, source, enabled, confirmed
          ) VALUES (
            ${"Interest: " + name + " (" + domain + ")"},
            ${"Auto-created for interest: " + name},
            'from_domain', 'equals', ${domain.toLowerCase()},
            'queue', 5, 'agent', true, true
          )
        `;
        rulesCreated++;
      }
    }

    return {
      content: [{
        type: "text",
        text: `Created interest "${name}" (${interest.id}).\n` +
          `Keywords: ${keywords.join(", ")}\n` +
          `Domains: ${(source_domains ?? []).join(", ") || "(none)"}\n` +
          `Action: "${action_prompt}"\n` +
          `Companion triage rules created: ${rulesCreated}`,
      }],
    };
  }
);

server.tool(
  "list_interests",
  "List all interests (active and disabled).",
  {},
  async () => {
    const interests = await sql`
      SELECT id, name, description, keywords, source_domains, extraction_fields,
             action_prompt, on_match_action, notify, enabled, created_at
      FROM app.interest
      ORDER BY created_at DESC
    `;

    if (interests.length === 0) {
      return { content: [{ type: "text", text: "No interests defined." }] };
    }

    const lines = interests.map(
      (i) =>
        `[${i.enabled ? "active" : "disabled"}] "${i.name}" (${i.id})\n` +
        `  Keywords: ${(i.keywords as string[]).join(", ")}\n` +
        `  Domains: ${(i.source_domains as string[])?.join(", ") || "(none)"}\n` +
        `  Action: "${i.action_prompt}"\n` +
        `  On match: ${i.on_match_action}, notify: ${i.notify}`
    );

    return {
      content: [{ type: "text", text: lines.join("\n\n") }],
    };
  }
);

server.tool(
  "update_interest",
  "Update an existing interest. Use when the user says 'also do X when you find musicals', 'add ticketmaster to the concert interest', etc. Only provide fields that should change.",
  {
    id: z.string().describe("Interest ID to update"),
    name: z.string().optional(),
    description: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    source_domains: z.array(z.string()).optional(),
    extraction_fields: z.record(z.string(), z.string()).optional(),
    action_prompt: z.string().optional(),
    on_match_action: z.enum(["flag", "queue", "digest"]).optional(),
    notify: z.boolean().optional(),
  },
  async ({ id, name, description, keywords, source_domains, extraction_fields, action_prompt, on_match_action, notify }) => {
    // Build dynamic update
    const updates: string[] = [];
    const sets: Record<string, unknown> = {};

    if (name !== undefined) sets.name = name;
    if (description !== undefined) sets.description = description;
    if (keywords !== undefined) sets.keywords = keywords;
    if (source_domains !== undefined) sets.source_domains = source_domains;
    if (extraction_fields !== undefined) sets.extraction_fields = extraction_fields;
    if (action_prompt !== undefined) sets.action_prompt = action_prompt;
    if (on_match_action !== undefined) sets.on_match_action = on_match_action;
    if (notify !== undefined) sets.notify = notify;

    if (Object.keys(sets).length === 0) {
      return { content: [{ type: "text", text: "No fields to update." }] };
    }

    // Use individual UPDATE for each field (simpler than dynamic SQL)
    if (sets.name !== undefined) await sql`UPDATE app.interest SET name = ${sets.name as string}, updated_at = now() WHERE id = ${id}`;
    if (sets.description !== undefined) await sql`UPDATE app.interest SET description = ${sets.description as string}, updated_at = now() WHERE id = ${id}`;
    if (sets.keywords !== undefined) await sql`UPDATE app.interest SET keywords = ${(sets.keywords as string[])}, updated_at = now() WHERE id = ${id}`;
    if (sets.source_domains !== undefined) await sql`UPDATE app.interest SET source_domains = ${(sets.source_domains as string[])}, updated_at = now() WHERE id = ${id}`;
    if (sets.extraction_fields !== undefined) await sql`UPDATE app.interest SET extraction_fields = ${sql.json(sets.extraction_fields as any)}, updated_at = now() WHERE id = ${id}`;
    if (sets.action_prompt !== undefined) await sql`UPDATE app.interest SET action_prompt = ${sets.action_prompt as string}, updated_at = now() WHERE id = ${id}`;
    if (sets.on_match_action !== undefined) await sql`UPDATE app.interest SET on_match_action = ${sets.on_match_action as string}, updated_at = now() WHERE id = ${id}`;
    if (sets.notify !== undefined) await sql`UPDATE app.interest SET notify = ${sets.notify as boolean}, updated_at = now() WHERE id = ${id}`;

    // Create companion triage rules for any new source_domains
    if (sets.source_domains) {
      for (const domain of sets.source_domains as string[]) {
        const existing = await sql`
          SELECT id FROM app.triage_rule
          WHERE field = 'from_domain' AND operator = 'equals' AND value = ${domain.toLowerCase()}
          AND action IN ('queue', 'flag') AND enabled = true
        `;
        if (existing.length === 0) {
          const interestName = (sets.name as string) ?? (await sql`SELECT name FROM app.interest WHERE id = ${id}`)[0]?.name ?? "unknown";
          await sql`
            INSERT INTO app.triage_rule (
              name, description, field, operator, value, action, priority, source, enabled, confirmed
            ) VALUES (
              ${"Interest: " + interestName + " (" + domain + ")"},
              ${"Auto-created for interest update"},
              'from_domain', 'equals', ${domain.toLowerCase()},
              'queue', 5, 'agent', true, true
            )
          `;
        }
      }
    }

    // Fetch updated record
    const [updated] = await sql`SELECT * FROM app.interest WHERE id = ${id}`;
    if (!updated) {
      return { content: [{ type: "text", text: `Interest ${id} not found.` }] };
    }

    return {
      content: [{
        type: "text",
        text: `Updated "${updated.name}" (${updated.id}).\n` +
          `Keywords: ${(updated.keywords as string[]).join(", ")}\n` +
          `Domains: ${(updated.source_domains as string[])?.join(", ") || "(none)"}\n` +
          `Action: "${updated.action_prompt}"`,
      }],
    };
  }
);

server.tool(
  "disable_interest",
  "Disable an interest. It stops matching but is not deleted. Use when the user says 'stop watching for X', 'disable the concert interest', etc.",
  {
    id: z.string().describe("Interest ID to disable"),
  },
  async ({ id }) => {
    const [updated] = await sql`
      UPDATE app.interest SET enabled = false, updated_at = now()
      WHERE id = ${id}
      RETURNING name
    `;
    if (!updated) {
      return { content: [{ type: "text", text: `Interest ${id} not found.` }] };
    }
    return {
      content: [{
        type: "text",
        text: `Disabled "${updated.name}". It will no longer match incoming emails.`,
      }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
