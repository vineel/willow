import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { sql } from "../pib/config";
import { createLogger } from "../pib/logger";

const log = createLogger("cal.extract");

const ACTION_TIMEOUT_MS = 120_000;
const WILLOW_ROOT = "/Users/vineel/aidev/willow";
const MEMORY_BASE_URL = "http://localhost:8789";

interface CalEvent {
  id: string;
  calendarId: string;
  calendarName: string;
  summary: string;
  description: string | null;
  location: string | null;
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
  attendees: { name?: string; email?: string }[];
  organizer: string | null;
}

interface ExtractionOutput {
  todos: { title: string; due_date: string | null; priority: string; reason: string }[];
  facts: { text: string; factoid_type: string; confidence: number }[];
  needs_prep: boolean;
  skip: boolean;
}

export async function runCalExtraction(): Promise<{ processed: number; errors: number }> {
  let processed = 0;
  let errors = 0;

  const pending = await sql`
    SELECT
      p.id as processing_id, p.event_id, p.content_hash,
      e.summary, e.description, e.location,
      e.starts_at, e.ends_at, e.all_day,
      e.attendees, e.organizer, e.calendar_id,
      c.display_name as calendar_name
    FROM app.cal_event_processing p
    JOIN app.cal_event e ON p.event_id = e.id
    JOIN app.cal_calendar c ON e.calendar_id = c.id
    WHERE p.status = 'pending'
    ORDER BY e.starts_at ASC NULLS LAST
    LIMIT 20
  `;

  log.info(`${pending.length} events pending extraction`);

  for (const row of pending) {
    try {
      const event: CalEvent = {
        id: row.event_id,
        calendarId: row.calendar_id,
        calendarName: row.calendar_name,
        summary: row.summary,
        description: row.description,
        location: row.location,
        startsAt: row.starts_at?.toISOString() ?? null,
        endsAt: row.ends_at?.toISOString() ?? null,
        allDay: row.all_day,
        attendees: (row.attendees ?? []) as CalEvent["attendees"],
        organizer: row.organizer,
      };

      const result = await extractSingleEvent(event);

      await sql`
        UPDATE app.cal_event_processing SET
          status = 'done',
          processed_at = now(),
          extracted_todos = ${sql.json(result.todos as any)},
          extracted_facts = ${sql.json(result.facts as any)}
        WHERE id = ${row.processing_id}
      `;

      processed++;
    } catch (err) {
      errors++;
      log.error(`Extraction failed for event ${row.event_id}: ${(err as Error).message}`);

      await sql`
        UPDATE app.cal_event_processing SET
          status = 'error',
          processed_at = now(),
          error = ${(err as Error).message.slice(0, 500)}
        WHERE id = ${row.processing_id}
      `;
    }
  }

  log.info(`Extraction complete: ${processed} processed, ${errors} errors`);
  return { processed, errors };
}

async function extractSingleEvent(event: CalEvent): Promise<ExtractionOutput> {
  // 1. Fetch surrounding events for context
  const surrounding = await getSurroundingEvents(event);

  // 2. Pre-fetch memory context
  const memoryContext = await fetchMemoryContext(event);

  // 3. Build prompt and dispatch
  const prompt = buildPrompt(event, surrounding, memoryContext);
  const mcpConfigPath = writeMcpConfig();

  try {
    const rawOutput = await runClaudeP(prompt, mcpConfigPath);
    return parseOutput(rawOutput);
  } finally {
    try { unlinkSync(mcpConfigPath); } catch {}
  }
}

async function getSurroundingEvents(event: CalEvent): Promise<string> {
  if (!event.startsAt) return "";

  const eventDate = new Date(event.startsAt);
  const windowStart = new Date(eventDate);
  windowStart.setDate(windowStart.getDate() - 2);
  const windowEnd = new Date(eventDate);
  windowEnd.setDate(windowEnd.getDate() + 2);

  const rows = await sql`
    SELECT summary, starts_at, ends_at, location, all_day
    FROM app.cal_event
    WHERE starts_at BETWEEN ${windowStart.toISOString()} AND ${windowEnd.toISOString()}
      AND id != ${event.id}
      AND deleted_at IS NULL
    ORDER BY starts_at ASC
    LIMIT 20
  `;

  if (rows.length === 0) return "";

  return rows
    .map((r) => {
      const date = r.starts_at
        ? new Date(r.starts_at).toLocaleString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })
        : "unknown time";
      const loc = r.location ? ` @ ${r.location}` : "";
      return `- ${r.summary} (${date}${loc})`;
    })
    .join("\n");
}

async function fetchMemoryContext(event: CalEvent): Promise<string> {
  const facts: string[] = [];
  const seen = new Set<string>();

  // Build search queries from event data
  const queries: string[] = [];

  // Broad semantic search on summary + description
  const broadQuery = [event.summary, event.description]
    .filter(Boolean)
    .join(" — ");
  if (broadQuery) queries.push(broadQuery);

  // Narrow searches on named entities
  for (const a of event.attendees) {
    if (a.name) queries.push(a.name);
  }
  if (event.location) queries.push(event.location);
  if (event.organizer) queries.push(event.organizer);

  // Run searches in parallel (max 3)
  const searchPromises = queries.slice(0, 3).map((q) => memorySearch(q));
  const results = await Promise.allSettled(searchPromises);

  for (const result of results) {
    if (result.status === "fulfilled") {
      for (const fact of result.value) {
        if (!seen.has(fact)) {
          seen.add(fact);
          facts.push(fact);
        }
      }
    }
  }

  // Keyword fallback if we got thin results
  if (facts.length < 3) {
    const keywords = extractKeywords(event);
    if (keywords.length > 0) {
      try {
        const keywordResults = await memorySearchKeywords(keywords);
        for (const fact of keywordResults) {
          if (!seen.has(fact)) {
            seen.add(fact);
            facts.push(fact);
          }
        }
      } catch {}
    }
  }

  // Cap at 15 facts
  const capped = facts.slice(0, 15);
  if (capped.length === 0) return "";

  return capped.map((f) => `- ${f}`).join("\n");
}

async function memorySearch(query: string): Promise<string[]> {
  try {
    const res = await fetch(`${MEMORY_BASE_URL}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit: 5, threshold: 0.3 }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    return (data.results ?? []).map(
      (r: any) => r.text ?? r.content ?? r.title ?? ""
    ).filter(Boolean);
  } catch {
    return [];
  }
}

async function memorySearchKeywords(keywords: string[]): Promise<string[]> {
  try {
    const res = await fetch(`${MEMORY_BASE_URL}/api/search/keywords`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keywords, limit: 5 }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as any;
    return (data.results ?? []).map(
      (r: any) => r.text ?? r.content ?? r.title ?? ""
    ).filter(Boolean);
  } catch {
    return [];
  }
}

function extractKeywords(event: CalEvent): string[] {
  const words = new Set<string>();
  const text = [event.summary, event.description, event.location]
    .filter(Boolean)
    .join(" ");

  // Extract capitalized words (likely names/places) and longer words
  for (const match of text.matchAll(/\b[A-Z][a-z]{2,}\b/g)) {
    words.add(match[0]);
  }
  for (const a of event.attendees) {
    if (a.name) words.add(a.name);
  }
  return Array.from(words).slice(0, 5);
}

function buildPrompt(
  event: CalEvent,
  surrounding: string,
  memoryContext: string
): string {
  const parts: string[] = [];

  parts.push(
    "You are Willow, Vineel's personal AI agent. Analyze this calendar event and extract actionable items and memorable facts."
  );
  parts.push("");
  parts.push("CALENDAR EVENT:");
  parts.push(`  Calendar: ${event.calendarName}`);
  parts.push(`  Summary: ${event.summary}`);
  if (event.description) parts.push(`  Description: ${event.description}`);
  if (event.location) parts.push(`  Location: ${event.location}`);
  if (event.startsAt) parts.push(`  Starts: ${event.startsAt}`);
  if (event.endsAt) parts.push(`  Ends: ${event.endsAt}`);
  if (event.allDay) parts.push(`  All day: yes`);
  if (event.attendees.length > 0) {
    parts.push(
      `  Attendees: ${event.attendees.map((a) => a.name ?? a.email).join(", ")}`
    );
  }
  if (event.organizer) parts.push(`  Organizer: ${event.organizer}`);

  if (surrounding) {
    parts.push("");
    parts.push("SURROUNDING EVENTS (±2 days):");
    parts.push(surrounding);
  }

  if (memoryContext) {
    parts.push("");
    parts.push("RELEVANT MEMORY (things Willow knows about people/places mentioned):");
    parts.push(memoryContext);
  }

  parts.push("");
  parts.push("IMPORTANT: The family often puts the REAL event time in the title or description (e.g. '4-6pm Ele Mixer')");
  parts.push("instead of setting the iCal time correctly. If the title/description contains a time, trust THAT over the Starts/Ends fields.");
  parts.push("");
  parts.push("INSTRUCTIONS:");
  parts.push("1. If this event implies preparation or action items, create todos using add_todo.");
  parts.push("   Set source='calendar'. Use the memory context to make todos specific.");
  parts.push("   Example: if memory says 'Vinod can't drive', a doctor appt generates 'Leave by 1:15 to pick up Dad'.");
  parts.push("2. If this event mentions people, places, or facts worth remembering, add them using memory_add.");
  parts.push("   Don't re-add facts that are already in the memory context above.");
  parts.push("3. If this is routine noise (lunch, commute, etc.), do nothing and output skip=true.");
  parts.push("4. If you need more context, use memory_search to look things up.");
  parts.push("");
  parts.push("After taking actions, output a JSON summary:");
  parts.push('```json');
  parts.push('{');
  parts.push('  "todos": [{"title": "...", "due_date": "YYYY-MM-DD or null", "priority": "normal|high|urgent", "reason": "..."}],');
  parts.push('  "facts": [{"text": "...", "factoid_type": "Person|Organization|Place|Event|Unknown", "confidence": 0.0-1.0}],');
  parts.push('  "needs_prep": false,');
  parts.push('  "skip": false');
  parts.push('}');
  parts.push('```');

  return parts.join("\n");
}

function writeMcpConfig(): string {
  const config = {
    mcpServers: {
      "willow-todo": {
        command: "/Users/vineel/.bun/bin/bun",
        args: ["run", "--silent", `${WILLOW_ROOT}/mcp/todo-mcp/server.ts`],
        cwd: WILLOW_ROOT,
      },
      "willow-memory": {
        command: "/Users/vineel/.bun/bin/bun",
        args: ["run", "--silent", `${WILLOW_ROOT}/mcp/memory-mcp/server.ts`],
        cwd: WILLOW_ROOT,
      },
    },
  };

  const path = join(tmpdir(), `willow-cal-mcp-${Date.now()}.json`);
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
      reject(new Error(`claude -p timed out after ${ACTION_TIMEOUT_MS}ms`));
    }, ACTION_TIMEOUT_MS);
  });

  const resultPromise = (async () => {
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`claude -p exited with code ${exitCode}: ${stderr.slice(0, 500)}`);
    }

    try {
      const parsed = JSON.parse(stdout);
      return parsed.result ?? stdout;
    } catch {
      return stdout;
    }
  })();

  return Promise.race([resultPromise, timeoutPromise]);
}

function parseOutput(raw: string): ExtractionOutput {
  const defaults: ExtractionOutput = {
    todos: [],
    facts: [],
    needs_prep: false,
    skip: false,
  };

  // Try to extract JSON from the response
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)\s*```/) ?? raw.match(/\{[\s\S]*"todos"[\s\S]*\}/);
  if (!jsonMatch) return defaults;

  try {
    const jsonStr = jsonMatch[1] ?? jsonMatch[0];
    const parsed = JSON.parse(jsonStr);
    return {
      todos: Array.isArray(parsed.todos) ? parsed.todos : [],
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      needs_prep: parsed.needs_prep === true,
      skip: parsed.skip === true,
    };
  } catch {
    log.warn(`Failed to parse extraction output JSON`);
    return defaults;
  }
}
