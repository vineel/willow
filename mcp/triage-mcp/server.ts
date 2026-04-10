#!/usr/bin/env bun
/**
 * MCP server for managing triage rules via conversation.
 * Claude Code calls these tools when the user says things like
 * "block everything from zdnet" or "show me my rules".
 *
 * Must use stderr for all logging — stdout is MCP stdio.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { sql } from "../../pib/config";
import { loadRules, addBlockRule, addBlockDomain, addAllowRule } from "../../pib/triage/rules";
import { triage } from "../../pib/triage/engine";
import type { CanonicalEvent } from "../../pib/jmap/types";

const server = new McpServer(
  { name: "willow-triage", version: "0.1.0" },
  {
    instructions: [
      "Triage rules control which emails Willow processes vs ignores.",
      "Rules are field-level pattern matching — no LLM needed.",
      "User rules (priority 1) override system rules (priority 400+).",
      "Use add_block_rule/add_block_domain when the user says 'block X' or 'ignore X'.",
      "Use add_allow_rule when the user says 'always process emails from X'.",
      "Use test_triage to dry-run and verify rules before/after changes.",
    ].join(" "),
  }
);

server.tool(
  "list_rules",
  "List all active triage rules. Shows system rules and user-created rules with their priority, field, operator, value, and action.",
  {},
  async () => {
    const rules = await loadRules();
    const sorted = [...rules].sort((a, b) => a.priority - b.priority);
    const lines = sorted.map(
      (r) =>
        `[${r.priority}] ${r.source}/${r.action}: ${r.field} ${r.operator} ${r.value ?? "(exists)"}${r.field === "header" ? ` (header: ${r.header_name})` : ""} — "${r.name}" ${r.confirmed ? "" : "(unconfirmed)"}`
    );
    return {
      content: [{ type: "text", text: `${sorted.length} rules:\n${lines.join("\n")}` }],
    };
  }
);

server.tool(
  "add_block_rule",
  "Block a sender by email address. Adds a noise rule at highest priority. Use when the user says 'block this sender', 'never show me emails from X', etc.",
  {
    address: z.string().describe("Email address to block"),
  },
  async ({ address }) => {
    const ruleId = await addBlockRule(address, "user");
    return {
      content: [{
        type: "text",
        text: ruleId
          ? `Blocked ${address}. Emails from this sender will be triaged as noise. Rule ID: ${ruleId}`
          : `${address} is already blocked.`,
      }],
    };
  }
);

server.tool(
  "add_block_domain",
  "Block all senders from a domain. Adds a noise rule matching from_domain. Use when the user says 'block everything from zdnet.com', 'ignore all emails from X domain', etc.",
  {
    domain: z.string().describe("Domain to block (e.g. 'zdnet.com')"),
  },
  async ({ domain }) => {
    const ruleId = await addBlockDomain(domain, "user");
    return {
      content: [{
        type: "text",
        text: ruleId
          ? `Blocked domain ${domain}. All emails from *@${domain} will be triaged as noise. Rule ID: ${ruleId}`
          : `Domain ${domain} is already blocked.`,
      }],
    };
  }
);

server.tool(
  "add_allow_rule",
  "Allow a sender by email address. Ensures their emails always pass triage (action=queue). Use when the user says 'always process emails from X', 'don't filter X', etc.",
  {
    address: z.string().describe("Email address to allow"),
  },
  async ({ address }) => {
    const ruleId = await addAllowRule(address, "user");
    return {
      content: [{
        type: "text",
        text: ruleId
          ? `Allowed ${address}. Emails from this sender will always pass triage. Rule ID: ${ruleId}`
          : `${address} is already allowed.`,
      }],
    };
  }
);

server.tool(
  "add_custom_rule",
  "Add a custom triage rule with full control over field, operator, value, and action. Use for rules that aren't simple block/allow by address.",
  {
    name: z.string().describe("Human-readable rule name"),
    field: z.enum(["from_address", "from_domain", "subject", "header", "source_type"]).describe("Which email field to match against"),
    operator: z.enum(["equals", "contains", "starts_with", "ends_with", "regex", "exists", "gte"]).describe("Match operator"),
    value: z.string().optional().describe("Value to match (omit for 'exists' operator)"),
    header_name: z.string().optional().describe("Header name (only when field='header')"),
    action: z.enum(["noise", "digest", "queue", "flag"]).describe("What to do with matching emails"),
    priority: z.number().optional().default(10).describe("Rule priority (lower = evaluated first, default: 10)"),
  },
  async ({ name, field, operator, value, header_name, action, priority }) => {
    const [row] = await sql`
      INSERT INTO app.triage_rule (name, field, operator, value, header_name, action, priority, source, enabled, confirmed)
      VALUES (${name}, ${field}, ${operator}, ${value ?? null}, ${header_name ?? null}, ${action}, ${priority}, 'user', true, true)
      RETURNING id
    `;
    return {
      content: [{
        type: "text",
        text: `Created rule "${name}" (${row.id}): ${field} ${operator} ${value ?? "(exists)"} → ${action}`,
      }],
    };
  }
);

server.tool(
  "test_triage",
  "Dry-run triage on a hypothetical email to see which rule would match. Use to verify rules work as expected.",
  {
    from_address: z.string().describe("Sender email address"),
    subject: z.string().optional().describe("Email subject"),
  },
  async ({ from_address, subject }) => {
    const fakeEvent: CanonicalEvent = {
      id: "test",
      sourceType: "email",
      sourceRef: "test",
      sourceMeta: {},
      receivedAt: new Date().toISOString(),
      fromEntity: {
        displayName: from_address,
        address: from_address,
        sourceType: "email",
      },
      toEntities: [],
      subject: subject ?? undefined,
      attachments: [],
    };
    const rules = await loadRules();
    const result = triage(fakeEvent, rules);
    return {
      content: [{
        type: "text",
        text: `Triage result: ${result.action} (${result.source}${result.rule_name ? `, rule: "${result.rule_name}"` : ""})`,
      }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
