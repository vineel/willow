#!/usr/bin/env bun
/**
 * MCP server for managing Vineel's personal todo list.
 * Todos can be created from conversation, email extraction, or agent actions.
 *
 * Must use stderr for all logging — stdout is MCP stdio.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { sql } from "../../pib/config";

const server = new McpServer(
  { name: "willow-todo", version: "0.1.0" },
  {
    instructions: [
      "Manage Vineel's personal todo list.",
      "Use add_todo when the user says 'remind me to X', 'I need to X', 'add a todo for X', or when the pipeline extracts action items from email.",
      "Use list_todos to show pending items. Use complete_todo when the user says 'done with X' or 'mark X as done'.",
      "Use update_todo to change priority, due date, or snooze a todo.",
      "Keep titles short and actionable. Set due_date when a deadline is mentioned or implied.",
    ].join(" "),
  }
);

// ── add_todo ────────────────────────────────────────────────────────────────

server.tool(
  "add_todo",
  "Create a new todo. Use when the user says 'remind me to X', 'I need to X', 'add a todo for X', or when creating todos from email-extracted action items.",
  {
    title: z.string().describe("Short, actionable title (e.g. 'Pick up Dad\\'s prescription')"),
    description: z.string().optional().describe("Additional details or context"),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional().default("normal"),
    due_date: z.string().optional().describe("Due date in YYYY-MM-DD format"),
    source: z.enum(["email", "conversation", "agent"]).optional().default("conversation"),
    source_fact_id: z.string().optional().describe("Fact ID if this todo originated from an email"),
    tags: z.array(z.string()).optional().default([]).describe("Tags for categorization (e.g. ['family', 'medical'])"),
  },
  async ({ title, description, priority, due_date, source, source_fact_id, tags }) => {
    const [todo] = await sql`
      INSERT INTO app.todo (
        title, description, priority, due_date, source, source_fact_id, tags
      ) VALUES (
        ${title},
        ${description ?? null},
        ${priority},
        ${due_date ?? null},
        ${source},
        ${source_fact_id ?? null},
        ${(tags ?? []) as string[]}
      ) RETURNING id, title, priority, due_date, created_at
    `;

    const parts = [`Added todo: "${todo.title}" (${todo.id})`];
    if (todo.priority !== "normal") parts.push(`Priority: ${todo.priority}`);
    if (todo.due_date) parts.push(`Due: ${todo.due_date.toISOString().slice(0, 10)}`);
    if (tags && tags.length > 0) parts.push(`Tags: ${tags.join(", ")}`);

    return { content: [{ type: "text", text: parts.join("\n") }] };
  }
);

// ── list_todos ──────────────────────────────────────────────────────────────

server.tool(
  "list_todos",
  "List todos. By default shows open todos. Use to check what's pending, overdue, or recently completed.",
  {
    status: z.enum(["open", "done", "snoozed", "all"]).optional().default("open").describe("Filter by status (default: open)"),
    include_done_count: z.number().optional().default(0).describe("Include N most recently completed todos"),
  },
  async ({ status, include_done_count }) => {
    let todos;
    if (status === "all") {
      todos = await sql`
        SELECT id, title, description, status, priority, due_date, tags, source,
               completed_at, snoozed_until, created_at
        FROM app.todo
        ORDER BY
          CASE status WHEN 'open' THEN 0 WHEN 'snoozed' THEN 1 ELSE 2 END,
          CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
          due_date ASC NULLS LAST
      `;
    } else if (status === "done") {
      todos = await sql`
        SELECT id, title, description, status, priority, due_date, tags, source,
               completed_at, snoozed_until, created_at
        FROM app.todo
        WHERE status = 'done'
        ORDER BY completed_at DESC
        LIMIT ${include_done_count > 0 ? include_done_count : 20}
      `;
    } else {
      todos = await sql`
        SELECT id, title, description, status, priority, due_date, tags, source,
               completed_at, snoozed_until, created_at
        FROM app.todo
        WHERE status = ${status}
        ORDER BY
          CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
          due_date ASC NULLS LAST
      `;
    }

    if (todos.length === 0) {
      return { content: [{ type: "text", text: status === "open" ? "No open todos!" : `No ${status} todos.` }] };
    }

    const today = new Date().toISOString().slice(0, 10);

    const lines = todos.map((t) => {
      const overdue = t.status === "open" && t.due_date && t.due_date.toISOString().slice(0, 10) < today;
      const parts = [
        `[${t.priority === "normal" ? t.status : t.status + "/" + t.priority}]`,
        overdue ? "OVERDUE" : "",
        `"${t.title}"`,
      ].filter(Boolean);

      const details: string[] = [];
      if (t.due_date) details.push(`due: ${t.due_date.toISOString().slice(0, 10)}`);
      if (t.tags?.length > 0) details.push(`tags: ${(t.tags as string[]).join(", ")}`);
      if (t.source !== "conversation") details.push(`from: ${t.source}`);
      if (t.completed_at) details.push(`done: ${t.completed_at.toISOString().slice(0, 10)}`);
      if (t.snoozed_until) details.push(`snoozed until: ${t.snoozed_until.toISOString().slice(0, 10)}`);

      let line = parts.join(" ");
      if (details.length > 0) line += ` (${details.join(", ")})`;
      line += `\n  id: ${t.id}`;
      return line;
    });

    return { content: [{ type: "text", text: lines.join("\n\n") }] };
  }
);

// ── update_todo ─────────────────────────────────────────────────────────────

server.tool(
  "update_todo",
  "Update a todo's fields. Use to change title, priority, due date, tags, or snooze. Only provide fields that should change.",
  {
    id: z.string().describe("Todo ID to update"),
    title: z.string().optional(),
    description: z.string().optional(),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    due_date: z.string().optional().describe("Due date in YYYY-MM-DD format, or 'none' to clear"),
    tags: z.array(z.string()).optional(),
    status: z.enum(["open", "snoozed"]).optional().describe("Reopen or snooze a todo"),
    snoozed_until: z.string().optional().describe("Snooze until date in YYYY-MM-DD format (sets status to snoozed)"),
  },
  async ({ id, title, description, priority, due_date, tags, status, snoozed_until }) => {
    if (title !== undefined) await sql`UPDATE app.todo SET title = ${title} WHERE id = ${id}`;
    if (description !== undefined) await sql`UPDATE app.todo SET description = ${description} WHERE id = ${id}`;
    if (priority !== undefined) await sql`UPDATE app.todo SET priority = ${priority} WHERE id = ${id}`;
    if (due_date !== undefined) {
      const val = due_date === "none" ? null : due_date;
      await sql`UPDATE app.todo SET due_date = ${val} WHERE id = ${id}`;
    }
    if (tags !== undefined) await sql`UPDATE app.todo SET tags = ${tags as string[]} WHERE id = ${id}`;
    if (snoozed_until !== undefined) {
      await sql`UPDATE app.todo SET snoozed_until = ${snoozed_until}, status = 'snoozed' WHERE id = ${id}`;
    } else if (status !== undefined) {
      await sql`UPDATE app.todo SET status = ${status} WHERE id = ${id}`;
    }

    const [updated] = await sql`SELECT id, title, status, priority, due_date, tags FROM app.todo WHERE id = ${id}`;
    if (!updated) {
      return { content: [{ type: "text", text: `Todo ${id} not found.` }] };
    }

    return {
      content: [{
        type: "text",
        text: `Updated "${updated.title}": status=${updated.status}, priority=${updated.priority}` +
          (updated.due_date ? `, due=${updated.due_date.toISOString().slice(0, 10)}` : ""),
      }],
    };
  }
);

// ── complete_todo ───────────────────────────────────────────────────────────

server.tool(
  "complete_todo",
  "Mark a todo as done. Use when the user says 'done with X', 'finished X', 'mark X as done'.",
  {
    id: z.string().describe("Todo ID to complete"),
  },
  async ({ id }) => {
    const [updated] = await sql`
      UPDATE app.todo
      SET status = 'done', completed_at = now()
      WHERE id = ${id}
      RETURNING title
    `;
    if (!updated) {
      return { content: [{ type: "text", text: `Todo ${id} not found.` }] };
    }
    return {
      content: [{ type: "text", text: `Done: "${updated.title}"` }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
