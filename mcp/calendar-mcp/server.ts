#!/usr/bin/env bun
/**
 * MCP server for managing Vineel's iCloud calendars.
 * Provides read access to synced events and write access via CalDAV.
 *
 * Must use stderr for all logging — stdout is MCP stdio.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { sql } from "../../pib/config";
import { generateICS } from "../../cal/ics";
import {
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from "../../cal/caldav";
import { syncSingleCalendar, getWillowCalendarId } from "../../cal/sync";

const server = new McpServer(
  { name: "willow-calendar", version: "0.1.0" },
  {
    instructions: [
      "Manage Vineel's iCloud calendars.",
      "Use list_events to show what's on the calendar for a date range.",
      "Use search_events to find events by keyword.",
      "Use create_event when Vineel says 'put X on my calendar', 'schedule X', 'add X to calendar'.",
      "Use update_event to modify an existing event's time, title, or location.",
      "Use delete_event to remove an event.",
      "Use find_conflicts to check for overlapping events before creating.",
      "Use get_calendars to list available calendars and their IDs.",
      "If Vineel doesn't specify a calendar, default to his primary personal calendar.",
      "The 'Willow' calendar (purple) is for low-confidence automated events — don't put interactive requests there.",
    ].join(" "),
  }
);

// ── get_calendars ──────────────────────────────────────────────────────────

server.tool(
  "get_calendars",
  "List available calendars with their IDs, names, and colors. Use to find the right calendar_id for create/update operations.",
  {},
  async () => {
    const calendars = await sql`
      SELECT id, display_name, color, is_shared, is_willow, enabled
      FROM app.cal_calendar
      ORDER BY is_willow ASC, is_shared ASC, display_name ASC
    `;

    if (calendars.length === 0) {
      return { content: [{ type: "text", text: "No calendars synced yet. Run a calendar sync first." }] };
    }

    const lines = calendars.map((c) => {
      const tags: string[] = [];
      if (c.is_willow) tags.push("Willow staging");
      if (c.is_shared) tags.push("shared");
      if (!c.enabled) tags.push("disabled");
      const tagStr = tags.length > 0 ? ` (${tags.join(", ")})` : "";
      return `${c.display_name}${tagStr}\n  id: ${c.id}${c.color ? ` | color: ${c.color}` : ""}`;
    });

    return { content: [{ type: "text", text: lines.join("\n\n") }] };
  }
);

// ── list_events ────────────────────────────────────────────────────────────

server.tool(
  "list_events",
  "List calendar events in a date range, grouped by day. Use to see what's on the calendar.",
  {
    start_date: z.string().describe("Start date in YYYY-MM-DD format"),
    end_date: z.string().describe("End date in YYYY-MM-DD format"),
    calendar_id: z.string().optional().describe("Filter to a specific calendar (omit for all)"),
  },
  async ({ start_date, end_date, calendar_id }) => {
    const events = calendar_id
      ? await sql`
          SELECT e.id, e.summary, e.description, e.location, e.starts_at, e.ends_at,
                 e.all_day, e.source, c.display_name as calendar_name
          FROM app.cal_event e
          JOIN app.cal_calendar c ON e.calendar_id = c.id
          WHERE e.starts_at >= ${start_date} AND e.starts_at < ${end_date}::date + 1
            AND e.deleted_at IS NULL AND e.calendar_id = ${calendar_id}
          ORDER BY e.starts_at ASC
        `
      : await sql`
          SELECT e.id, e.summary, e.description, e.location, e.starts_at, e.ends_at,
                 e.all_day, e.source, c.display_name as calendar_name
          FROM app.cal_event e
          JOIN app.cal_calendar c ON e.calendar_id = c.id
          WHERE e.starts_at >= ${start_date} AND e.starts_at < ${end_date}::date + 1
            AND e.deleted_at IS NULL
          ORDER BY e.starts_at ASC
        `;

    if (events.length === 0) {
      return { content: [{ type: "text", text: `No events found between ${start_date} and ${end_date}.` }] };
    }

    // Group by day
    const byDay = new Map<string, typeof events>();
    for (const e of events) {
      const day = e.all_day
        ? new Date(e.starts_at).toISOString().slice(0, 10)
        : new Date(e.starts_at).toLocaleDateString("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
      const key = e.starts_at.toISOString().slice(0, 10);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(e);
    }

    const lines: string[] = [];
    for (const [day, dayEvents] of byDay) {
      const dateLabel = new Date(day + "T12:00:00Z").toLocaleDateString("en-US", {
        weekday: "short", month: "short", day: "numeric",
      });
      lines.push(`**${dateLabel}**`);
      for (const e of dayEvents) {
        const time = e.all_day
          ? "all day"
          : new Date(e.starts_at).toLocaleTimeString("en-US", {
              timeZone: "America/New_York", hour: "numeric", minute: "2-digit",
            });
        const loc = e.location ? ` @ ${e.location}` : "";
        const cal = `[${e.calendar_name}]`;
        const src = e.source !== "sync" ? ` {${e.source}}` : "";
        lines.push(`  ${time} — ${e.summary}${loc} ${cal}${src}`);
        lines.push(`    id: ${e.id}`);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ── search_events ──────────────────────────────────────────────────────────

server.tool(
  "search_events",
  "Full-text search for calendar events by keyword. Searches summary, description, and location.",
  {
    query: z.string().describe("Search query (e.g. 'orthodontist', 'book group')"),
  },
  async ({ query }) => {
    const events = await sql`
      SELECT e.id, e.summary, e.location, e.starts_at, e.ends_at, e.all_day,
             c.display_name as calendar_name
      FROM app.cal_event e
      JOIN app.cal_calendar c ON e.calendar_id = c.id
      WHERE to_tsvector('english',
        coalesce(e.summary, '') || ' ' || coalesce(e.description, '') || ' ' || coalesce(e.location, ''))
        @@ plainto_tsquery('english', ${query})
        AND e.deleted_at IS NULL
      ORDER BY e.starts_at DESC
      LIMIT 20
    `;

    if (events.length === 0) {
      return { content: [{ type: "text", text: `No events found matching "${query}".` }] };
    }

    const lines = events.map((e) => {
      const date = e.starts_at
        ? new Date(e.starts_at).toLocaleDateString("en-US", {
            timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", year: "numeric",
          })
        : "no date";
      const time = e.all_day
        ? "all day"
        : e.starts_at
          ? new Date(e.starts_at).toLocaleTimeString("en-US", {
              timeZone: "America/New_York", hour: "numeric", minute: "2-digit",
            })
          : "";
      const loc = e.location ? ` @ ${e.location}` : "";
      return `${date} ${time} — ${e.summary}${loc} [${e.calendar_name}]\n  id: ${e.id}`;
    });

    return { content: [{ type: "text", text: lines.join("\n\n") }] };
  }
);

// ── create_event ───────────────────────────────────────────────────────────

server.tool(
  "create_event",
  "Create a new calendar event via CalDAV. Use when Vineel explicitly asks to add something to his calendar.",
  {
    summary: z.string().describe("Event title (e.g. 'Dentist appointment')"),
    starts_at: z.string().describe("Start time in ISO 8601 format (e.g. '2026-04-18T14:00:00-04:00')"),
    ends_at: z.string().describe("End time in ISO 8601 format (e.g. '2026-04-18T15:00:00-04:00')"),
    calendar_id: z.string().optional().describe("Calendar ID (omit for primary personal calendar)"),
    description: z.string().optional().describe("Event description/notes"),
    location: z.string().optional().describe("Event location"),
    all_day: z.boolean().optional().default(false).describe("Whether this is an all-day event"),
  },
  async ({ summary, starts_at, ends_at, calendar_id, description, location, all_day }) => {
    // Resolve calendar
    const calId = calendar_id ?? await getDefaultCalendarId();
    const [cal] = await sql`SELECT id, url, display_name FROM app.cal_calendar WHERE id = ${calId}`;
    if (!cal) {
      return { content: [{ type: "text", text: `Calendar ${calId} not found.` }] };
    }

    // Check conflicts
    const conflicts = await findConflicts(starts_at, ends_at);

    // Generate ICS
    const uid = `willow-${crypto.randomUUID()}`;
    const ics = generateICS({
      uid,
      summary,
      description,
      location,
      startsAt: new Date(starts_at),
      endsAt: new Date(ends_at),
      allDay: all_day,
    });

    // Write to CalDAV
    const filename = `${uid}.ics`;
    await createCalendarEvent(cal.url, ics, filename);

    // Sync to pick up the new event
    await syncSingleCalendar(cal.id);

    // Find the newly synced event to get its DB id
    const [newEvent] = await sql`
      SELECT id FROM app.cal_event
      WHERE calendar_id = ${cal.id} AND uid = ${uid} AND deleted_at IS NULL
    `;

    // Mark source as interactive
    if (newEvent) {
      await sql`UPDATE app.cal_event SET source = 'interactive' WHERE id = ${newEvent.id}`;
    }

    const parts = [`Created: "${summary}" on ${cal.display_name}`];
    const startDate = new Date(starts_at);
    if (all_day) {
      parts.push(`Date: ${startDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}`);
    } else {
      parts.push(`Time: ${startDate.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}`);
    }
    if (location) parts.push(`Location: ${location}`);
    if (newEvent) parts.push(`Event ID: ${newEvent.id}`);
    if (conflicts) parts.push(`\nWarning: ${conflicts}`);

    return { content: [{ type: "text", text: parts.join("\n") }] };
  }
);

// ── update_event ───────────────────────────────────────────────────────────

server.tool(
  "update_event",
  "Update an existing calendar event. Only provide fields that should change.",
  {
    event_id: z.string().describe("Event ID to update"),
    summary: z.string().optional().describe("New event title"),
    starts_at: z.string().optional().describe("New start time (ISO 8601)"),
    ends_at: z.string().optional().describe("New end time (ISO 8601)"),
    description: z.string().optional().describe("New description"),
    location: z.string().optional().describe("New location"),
    all_day: z.boolean().optional().describe("Change all-day status"),
  },
  async ({ event_id, summary, starts_at, ends_at, description, location, all_day }) => {
    const [event] = await sql`
      SELECT e.id, e.uid, e.caldav_url, e.etag, e.calendar_id,
             e.summary, e.description, e.location, e.starts_at, e.ends_at, e.all_day,
             c.url as calendar_url
      FROM app.cal_event e
      JOIN app.cal_calendar c ON e.calendar_id = c.id
      WHERE e.id = ${event_id} AND e.deleted_at IS NULL
    `;
    if (!event) {
      return { content: [{ type: "text", text: `Event ${event_id} not found.` }] };
    }
    if (!event.caldav_url) {
      return { content: [{ type: "text", text: `Event ${event_id} has no CalDAV URL — cannot update remotely. It may need a sync first.` }] };
    }

    // Build updated ICS with merged fields
    const ics = generateICS({
      uid: event.uid,
      summary: summary ?? event.summary,
      description: description !== undefined ? description : (event.description ?? undefined),
      location: location !== undefined ? location : (event.location ?? undefined),
      startsAt: starts_at ? new Date(starts_at) : new Date(event.starts_at),
      endsAt: ends_at ? new Date(ends_at) : new Date(event.ends_at),
      allDay: all_day !== undefined ? all_day : event.all_day,
    });

    await updateCalendarEvent(event.caldav_url, ics, event.etag);
    await syncSingleCalendar(event.calendar_id);

    const changes: string[] = [];
    if (summary) changes.push(`title → "${summary}"`);
    if (starts_at) changes.push(`start → ${starts_at}`);
    if (ends_at) changes.push(`end → ${ends_at}`);
    if (location !== undefined) changes.push(`location → "${location}"`);
    if (description !== undefined) changes.push(`description updated`);
    if (all_day !== undefined) changes.push(`all-day → ${all_day}`);

    return {
      content: [{ type: "text", text: `Updated "${event.summary}": ${changes.join(", ")}` }],
    };
  }
);

// ── delete_event ───────────────────────────────────────────────────────────

server.tool(
  "delete_event",
  "Delete a calendar event. Removes it from iCloud Calendar.",
  {
    event_id: z.string().describe("Event ID to delete"),
  },
  async ({ event_id }) => {
    const [event] = await sql`
      SELECT e.id, e.summary, e.caldav_url, e.etag, e.calendar_id
      FROM app.cal_event e
      WHERE e.id = ${event_id} AND e.deleted_at IS NULL
    `;
    if (!event) {
      return { content: [{ type: "text", text: `Event ${event_id} not found.` }] };
    }
    if (!event.caldav_url) {
      return { content: [{ type: "text", text: `Event ${event_id} has no CalDAV URL — cannot delete remotely.` }] };
    }

    await deleteCalendarEvent(event.caldav_url, event.etag);
    await syncSingleCalendar(event.calendar_id);

    return {
      content: [{ type: "text", text: `Deleted: "${event.summary}"` }],
    };
  }
);

// ── find_conflicts ─────────────────────────────────────────────────────────

server.tool(
  "find_conflicts",
  "Check for events that overlap with a proposed time range. Use before creating events.",
  {
    starts_at: z.string().describe("Proposed start time (ISO 8601)"),
    ends_at: z.string().describe("Proposed end time (ISO 8601)"),
  },
  async ({ starts_at, ends_at }) => {
    const conflicts = await findConflicts(starts_at, ends_at);
    if (!conflicts) {
      return { content: [{ type: "text", text: "No conflicts found for that time range." }] };
    }
    return { content: [{ type: "text", text: conflicts }] };
  }
);

// ── Helpers ────────────────────────────────────────────────────────────────

async function getDefaultCalendarId(): Promise<string> {
  // Prefer the primary personal (non-shared, non-Willow) calendar
  const [cal] = await sql`
    SELECT id FROM app.cal_calendar
    WHERE enabled = true AND is_shared = false AND is_willow = false
    ORDER BY display_name ASC LIMIT 1
  `;
  if (cal) return cal.id;

  // Fall back to any enabled calendar
  const [anyCal] = await sql`
    SELECT id FROM app.cal_calendar WHERE enabled = true
    ORDER BY display_name ASC LIMIT 1
  `;
  if (anyCal) return anyCal.id;

  throw new Error("No enabled calendars found");
}

async function findConflicts(
  startsAt: string,
  endsAt: string,
  excludeEventId?: string
): Promise<string | null> {
  const overlapping = excludeEventId
    ? await sql`
        SELECT e.summary, e.starts_at, e.ends_at, c.display_name as calendar_name
        FROM app.cal_event e
        JOIN app.cal_calendar c ON e.calendar_id = c.id
        WHERE e.starts_at < ${endsAt} AND e.ends_at > ${startsAt}
          AND e.deleted_at IS NULL AND e.all_day = false
          AND e.id != ${excludeEventId}
        ORDER BY e.starts_at LIMIT 5
      `
    : await sql`
        SELECT e.summary, e.starts_at, e.ends_at, c.display_name as calendar_name
        FROM app.cal_event e
        JOIN app.cal_calendar c ON e.calendar_id = c.id
        WHERE e.starts_at < ${endsAt} AND e.ends_at > ${startsAt}
          AND e.deleted_at IS NULL AND e.all_day = false
        ORDER BY e.starts_at LIMIT 5
      `;

  if (overlapping.length === 0) return null;

  const items = overlapping.map((e) => {
    const time = new Date(e.starts_at).toLocaleTimeString("en-US", {
      timeZone: "America/New_York", hour: "numeric", minute: "2-digit",
    });
    return `"${e.summary}" at ${time} [${e.calendar_name}]`;
  });

  return `Conflicts with: ${items.join(", ")}`;
}

const transport = new StdioServerTransport();
await server.connect(transport);
