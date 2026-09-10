import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { sql } from "./config";
import { createLogger } from "./logger";
import type { CanonicalEvent } from "./jmap/types";
import type { Interest } from "./interest-matcher";
import { generateICS } from "../cal/ics";
import { createCalendarEvent } from "../cal/caldav";
import { syncSingleCalendar, getWillowCalendarId } from "../cal/sync";

const calLog = createLogger("pib.action.calendar");

const ACTION_TIMEOUT_MS = 240_000; // 4 minutes

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

/**
 * Create a calendar event from an email classified as calendar.invite or calendar.change.
 * Does not use claude -p — the extraction step has already produced structured data.
 * Routes to the primary calendar if confident, Willow staging calendar if ambiguous.
 */
export async function executeActionCalendar(
  event: CanonicalEvent,
  intentKey: string,
  extractedData: Record<string, unknown> | null
): Promise<ActionResult> {
  const start = Date.now();

  if (!extractedData) {
    return { success: false, output: "", durationMs: Date.now() - start, error: "No extracted data for calendar event" };
  }

  try {
    // Parse extracted fields
    const eventName = String(extractedData.event_name ?? extractedData.subject ?? event.subject ?? "Event");
    const dateStr = String(extractedData.date ?? "");
    const timeStr = String(extractedData.time ?? "");
    const locationStr = extractedData.location ? String(extractedData.location) : undefined;

    // Try to parse date and time
    const parsedStart = parseEventDateTime(dateStr, timeStr);
    if (!parsedStart) {
      calLog.warn(`Could not parse date/time from extracted data: date="${dateStr}" time="${timeStr}"`);
      return { success: false, output: "", durationMs: Date.now() - start, error: `Could not parse date: "${dateStr}" time: "${timeStr}"` };
    }

    // Default end time: 1 hour after start for timed events, next day for all-day
    const isAllDay = !timeStr;
    let parsedEnd: Date;
    if (isAllDay) {
      parsedEnd = new Date(parsedStart);
      parsedEnd.setDate(parsedEnd.getDate() + 1);
    } else if (extractedData.end_time) {
      const endParsed = parseEventDateTime(dateStr, String(extractedData.end_time));
      parsedEnd = endParsed ?? new Date(parsedStart.getTime() + 60 * 60 * 1000);
    } else {
      parsedEnd = new Date(parsedStart.getTime() + 60 * 60 * 1000);
    }

    // Confidence routing: clear date+time → personal calendar, fuzzy → Willow
    const hasTime = !!timeStr;
    const hasName = eventName !== "Event";
    const isHighConfidence = hasTime && hasName;

    let calendarId: string;
    let calendarUrl: string;
    let calendarName: string;

    if (isHighConfidence) {
      // Primary personal calendar
      const [cal] = await sql`
        SELECT id, url, display_name FROM app.cal_calendar
        WHERE enabled = true AND is_shared = false AND is_willow = false
        ORDER BY display_name ASC LIMIT 1
      `;
      if (!cal) {
        return { success: false, output: "", durationMs: Date.now() - start, error: "No personal calendar found" };
      }
      calendarId = cal.id;
      calendarUrl = cal.url;
      calendarName = cal.display_name;
    } else {
      // Willow staging calendar
      const willowId = await getWillowCalendarId();
      if (!willowId) {
        return { success: false, output: "", durationMs: Date.now() - start, error: "Willow calendar not found — run sync first" };
      }
      const [cal] = await sql`SELECT id, url, display_name FROM app.cal_calendar WHERE id = ${willowId}`;
      calendarId = cal.id;
      calendarUrl = cal.url;
      calendarName = cal.display_name;
    }

    // Build description with email provenance
    const desc = `From email: ${event.fromEntity.displayName} <${event.fromEntity.address}>\nSubject: ${event.subject ?? "(no subject)"}`;

    // Generate ICS and write to CalDAV
    const uid = `willow-${crypto.randomUUID()}`;
    const ics = generateICS({
      uid,
      summary: eventName,
      description: desc,
      location: locationStr,
      startsAt: parsedStart,
      endsAt: parsedEnd,
      allDay: isAllDay,
    });

    const filename = `${uid}.ics`;
    await createCalendarEvent(calendarUrl, ics, filename);
    await syncSingleCalendar(calendarId);

    // Mark source
    await sql`
      UPDATE app.cal_event SET source = 'willow'
      WHERE calendar_id = ${calendarId} AND uid = ${uid} AND deleted_at IS NULL
    `;

    const confidence = isHighConfidence ? "high" : "low";
    calLog.info(`Created ${confidence}-confidence event "${eventName}" on "${calendarName}" from ${intentKey}`);

    return {
      success: true,
      output: `Created "${eventName}" on ${calendarName} (${confidence} confidence)`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    calLog.error(`Failed to create calendar event: ${(err as Error).message}`);
    return {
      success: false,
      output: "",
      durationMs: Date.now() - start,
      error: (err as Error).message,
    };
  }
}

/**
 * Parse a date string and optional time string into a Date.
 * Handles common formats: YYYY-MM-DD, MM/DD/YYYY, natural language dates.
 */
function parseEventDateTime(dateStr: string, timeStr: string): Date | null {
  if (!dateStr) return null;

  // Try ISO date
  let date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    // Try other common formats
    date = new Date(Date.parse(dateStr));
    if (isNaN(date.getTime())) return null;
  }

  if (timeStr) {
    // Parse time like "2:00 PM", "14:00", "2pm"
    const timeMatch = timeStr.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)?/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1]);
      const minutes = parseInt(timeMatch[2] ?? "0");
      const ampm = timeMatch[3]?.toLowerCase();
      if (ampm === "pm" && hours < 12) hours += 12;
      if (ampm === "am" && hours === 12) hours = 0;
      date.setHours(hours, minutes, 0, 0);
    }
  }

  return date;
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
  parts.push("NOTIFICATION SUBJECT REQUIREMENT:");
  parts.push(`If you call send_notification for this interest, the subject MUST start with "Willow: Interest" so it routes to the willow-secondary/Interests folder. Use "Willow: Interest — <summary>" for genuine matches and "Willow: Interest FP — <reason>" if you determine this is a false positive.`);
  parts.push("");
  parts.push("USER'S INSTRUCTION:");
  parts.push(interest.action_prompt!);

  return parts.join("\n");
}

/**
 * Write a temporary MCP config file with only the tools needed for action execution.
 */
export function writeMcpConfig(): string {
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
      "willow-gizmo": {
        command: "/Users/vineel/.bun/bin/bun",
        args: ["run", "--silent", `${willow}/mcp/gizmo-mcp/server.ts`],
        cwd: willow,
      },
      "slack-channel": {
        command: "/Users/vineel/.bun/bin/bun",
        args: ["run", "--silent", `${willow}/mcp/slack-channel/server.ts`],
        cwd: willow,
      },
    },
  };

  const path = join(tmpdir(), `willow-action-mcp-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify(config));
  return path;
}

export async function runClaudeP(prompt: string, mcpConfigPath: string): Promise<string> {
  const args = [
    "-p", prompt,
    "--model", "sonnet",
    "--mcp-config", mcpConfigPath,
    "--output-format", "json",
  ];

  const claudeBin = process.env.WILLOW_CLAUDE_BIN ?? "claude";
  const proc = Bun.spawn([claudeBin, ...args], {
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
