import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { sql } from "./config";
import type { CanonicalEvent } from "./jmap/types";
import type { Interest } from "./interest-matcher";

const ACTION_TIMEOUT_MS = 120_000; // 2 minutes

interface ActionResult {
  success: boolean;
  output: string;
  durationMs: number;
  error?: string;
}

/**
 * Execute an interest's action_prompt via claude -p with scoped MCP tools.
 * The prompt is composed from the extracted data + the interest's action_prompt.
 */
export async function executeAction(
  event: CanonicalEvent,
  interest: Interest,
  extractedData: Record<string, unknown> | null
): Promise<ActionResult> {
  if (!interest.action_prompt) {
    return { success: false, output: "", durationMs: 0, error: "No action_prompt defined" };
  }

  // Compose the prompt
  const prompt = composePrompt(event, interest, extractedData);

  // Write a temporary MCP config with scoped tools
  const mcpConfigPath = writeMcpConfig();

  const start = Date.now();
  try {
    const result = await runClaudeP(prompt, mcpConfigPath);
    return {
      success: true,
      output: result,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      output: "",
      durationMs: Date.now() - start,
      error: (err as Error).message,
    };
  } finally {
    try { unlinkSync(mcpConfigPath); } catch {}
  }
}

/**
 * Execute a todo-creation action for emails classified as action.task or action.request.
 * Uses claude -p with the todo MCP server to create todos from extracted data.
 */
export async function executeActionTodo(
  event: CanonicalEvent,
  extractedData: Record<string, unknown> | null
): Promise<ActionResult> {
  const parts: string[] = [];
  parts.push("You are Willow, a personal AI agent. An email was classified as containing an action item or request.");
  parts.push("Create one or more todos from this email using the add_todo tool. Set source to 'email'.");
  parts.push("Set appropriate priority and due_date if a deadline is mentioned.");
  parts.push("");
  parts.push("EMAIL DETAILS:");
  parts.push(`From: ${event.fromEntity.displayName} <${event.fromEntity.address}>`);
  parts.push(`Subject: ${event.subject ?? "(no subject)"}`);
  parts.push(`Date: ${event.receivedAt}`);

  if (extractedData && Object.keys(extractedData).length > 0) {
    parts.push("");
    parts.push("EXTRACTED DATA:");
    for (const [key, value] of Object.entries(extractedData)) {
      if (value !== null && value !== "null") {
        parts.push(`  ${key}: ${JSON.stringify(value)}`);
      }
    }
  }

  const bodyPreview = (event.bodyText ?? "").slice(0, 500);
  if (bodyPreview) {
    parts.push("");
    parts.push("EMAIL BODY PREVIEW:");
    parts.push(bodyPreview);
  }

  const prompt = parts.join("\n");
  const mcpConfigPath = writeMcpConfig();

  const start = Date.now();
  try {
    const result = await runClaudeP(prompt, mcpConfigPath);
    return { success: true, output: result, durationMs: Date.now() - start };
  } catch (err) {
    return { success: false, output: "", durationMs: Date.now() - start, error: (err as Error).message };
  } finally {
    try { unlinkSync(mcpConfigPath); } catch {}
  }
}

function composePrompt(
  event: CanonicalEvent,
  interest: Interest,
  extractedData: Record<string, unknown> | null
): string {
  const parts: string[] = [];

  parts.push(`You are Willow, a personal AI agent. An email matched the user's interest "${interest.name}".`);
  parts.push("");
  parts.push("EMAIL DETAILS:");
  parts.push(`From: ${event.fromEntity.displayName} <${event.fromEntity.address}>`);
  parts.push(`Subject: ${event.subject ?? "(no subject)"}`);
  parts.push(`Date: ${event.receivedAt}`);

  if (extractedData && Object.keys(extractedData).length > 0) {
    parts.push("");
    parts.push("EXTRACTED DATA:");
    for (const [key, value] of Object.entries(extractedData)) {
      if (value !== null && value !== "null") {
        parts.push(`  ${key}: ${JSON.stringify(value)}`);
      }
    }
  }

  // Include a body preview for context
  const bodyPreview = (event.bodyText ?? "").slice(0, 500);
  if (bodyPreview) {
    parts.push("");
    parts.push("EMAIL BODY PREVIEW:");
    parts.push(bodyPreview);
  }

  parts.push("");
  parts.push("USER'S INSTRUCTION:");
  parts.push(interest.action_prompt!);

  return parts.join("\n");
}

/**
 * Write a temporary MCP config file with only the tools needed for action execution.
 */
function writeMcpConfig(): string {
  const willow = "/Users/vineel/aidev/willow";
  const config = {
    mcpServers: {
      "willow-notify": {
        command: "/Users/vineel/.bun/bin/bun",
        args: ["run", "--silent", `${willow}/mcp/notify-mcp/server.ts`],
        cwd: willow,
      },
      "willow-web": {
        command: "/Users/vineel/.bun/bin/bun",
        args: ["run", "--silent", `${willow}/mcp/web-mcp/server.ts`],
        cwd: willow,
      },
      "willow-memory": {
        command: "/Users/vineel/.bun/bin/bun",
        args: ["run", "--silent", `${willow}/mcp/memory-mcp/server.ts`],
        cwd: willow,
      },
      "willow-todo": {
        command: "/Users/vineel/.bun/bin/bun",
        args: ["run", "--silent", `${willow}/mcp/todo-mcp/server.ts`],
        cwd: willow,
      },
    },
  };

  const path = join(tmpdir(), `willow-action-mcp-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify(config));
  return path;
}

async function runClaudeP(prompt: string, mcpConfigPath: string): Promise<string> {
  const args = [
    "-p", prompt,
    "--model", "sonnet",
    "--mcp-config", mcpConfigPath,
    "--output-format", "json",
  ];

  const proc = Bun.spawn(["claude", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
    },
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill();
      reject(new Error(`claude -p action timed out after ${ACTION_TIMEOUT_MS}ms`));
    }, ACTION_TIMEOUT_MS);
  });

  const resultPromise = (async () => {
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`claude -p exited with code ${exitCode}: ${stderr.slice(0, 500)}`);
    }

    // Parse the JSON output to extract the result text
    try {
      const parsed = JSON.parse(stdout);
      return parsed.result ?? stdout;
    } catch {
      return stdout;
    }
  })();

  return Promise.race([resultPromise, timeoutPromise]);
}

/**
 * Log an action execution to handler_execution.
 */
export async function logExecution(
  factId: string,
  handlerId: string | null,
  status: "success" | "failed" | "skipped",
  durationMs: number,
  error?: string
): Promise<void> {
  await sql`
    INSERT INTO app.handler_execution (fact_id, handler_id, status, duration_ms, error)
    VALUES (${factId}, ${handlerId}, ${status}, ${durationMs}, ${error ?? null})
  `;
}
