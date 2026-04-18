import { sql } from "../pib/config";

interface CalDigestEvent {
  summary: string;
  calendarName: string;
  startsAt: string | null;
  endsAt: string | null;
  allDay: boolean;
  location: string | null;
}

interface CalDigestDay {
  date: string;
  label: string;
  events: CalDigestEvent[];
}

interface CalDigestTodo {
  title: string;
  dueDate: string | null;
  priority: string;
  reason: string;
}

export interface CalDigestSection {
  days: CalDigestDay[];
  newTodos: CalDigestTodo[];
  newFacts: number;
  willowCreated: number;
}

export async function getCalDigestSection(): Promise<CalDigestSection | null> {
  const now = new Date();
  const windowEnd = new Date(now);
  windowEnd.setDate(windowEnd.getDate() + 7);

  // Events in the next 7 days
  const events = await sql`
    SELECT
      e.summary, e.starts_at, e.ends_at, e.all_day, e.location,
      c.display_name as calendar_name
    FROM app.cal_event e
    JOIN app.cal_calendar c ON e.calendar_id = c.id
    WHERE e.starts_at BETWEEN ${now.toISOString()} AND ${windowEnd.toISOString()}
      AND e.deleted_at IS NULL
      AND c.enabled = true
    ORDER BY e.starts_at ASC
  `;

  // Todos created from calendar events since last digest
  const todos = await sql`
    SELECT p.extracted_todos
    FROM app.cal_event_processing p
    WHERE p.status = 'done'
      AND p.extracted_todos IS NOT NULL
      AND p.processed_at > now() - interval '24 hours'
  `;

  // Facts created from calendar events since last digest
  const factCount = await sql`
    SELECT count(*) as cnt
    FROM app.cal_event_processing p
    WHERE p.status = 'done'
      AND p.extracted_facts IS NOT NULL
      AND jsonb_array_length(p.extracted_facts) > 0
      AND p.processed_at > now() - interval '24 hours'
  `;

  // Events created by Willow since last digest
  const willowCreatedCount = await sql`
    SELECT count(*) as cnt FROM app.cal_event
    WHERE source IN ('willow', 'interactive')
      AND created_at > now() - interval '24 hours'
      AND deleted_at IS NULL
  `;

  if (events.length === 0 && todos.length === 0 && Number(willowCreatedCount[0]?.cnt ?? 0) === 0) return null;

  // Group events by day
  const dayMap = new Map<string, CalDigestEvent[]>();
  for (const e of events) {
    const dateKey = e.starts_at
      ? new Date(e.starts_at).toISOString().slice(0, 10)
      : "unknown";
    if (!dayMap.has(dateKey)) dayMap.set(dateKey, []);
    dayMap.get(dateKey)!.push({
      summary: e.summary,
      calendarName: e.calendar_name,
      startsAt: e.starts_at?.toISOString() ?? null,
      endsAt: e.ends_at?.toISOString() ?? null,
      allDay: e.all_day,
      location: e.location,
    });
  }

  const days: CalDigestDay[] = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, events]) => ({
      date,
      label: new Date(date + "T12:00:00").toLocaleDateString("en-US", {
        weekday: "long",
        month: "short",
        day: "numeric",
      }),
      events,
    }));

  // Flatten all extracted todos
  const newTodos: CalDigestTodo[] = [];
  for (const row of todos) {
    const extracted = row.extracted_todos as CalDigestTodo[] | null;
    if (Array.isArray(extracted)) {
      newTodos.push(...extracted);
    }
  }

  return {
    days,
    newTodos,
    newFacts: Number(factCount[0]?.cnt ?? 0),
    willowCreated: Number(willowCreatedCount[0]?.cnt ?? 0),
  };
}

export function formatCalDigestText(section: CalDigestSection): string {
  const lines: string[] = [];
  lines.push(`## Calendar This Week (${section.days.reduce((n, d) => n + d.events.length, 0)} events)\n`);

  for (const day of section.days) {
    lines.push(`### ${day.label}`);
    for (const e of day.events) {
      const time = e.allDay
        ? "all day"
        : e.startsAt
          ? new Date(e.startsAt).toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
            })
          : "";
      const loc = e.location ? ` @ ${e.location}` : "";
      const cal = ` [${e.calendarName}]`;
      lines.push(`  • ${time} — ${e.summary}${loc}${cal}`);
    }
    lines.push("");
  }

  if (section.newTodos.length > 0) {
    lines.push(`### New Todos from Calendar (${section.newTodos.length})`);
    for (const t of section.newTodos) {
      const due = t.dueDate ? ` (due ${t.dueDate})` : "";
      lines.push(`  • ${t.title}${due} — ${t.reason}`);
    }
    lines.push("");
  }

  if (section.newFacts > 0) {
    lines.push(`### ${section.newFacts} new fact${section.newFacts !== 1 ? "s" : ""} added to memory from calendar events`);
    lines.push("");
  }

  if (section.willowCreated > 0) {
    lines.push(`### Willow created ${section.willowCreated} event${section.willowCreated !== 1 ? "s" : ""} since last digest — check Calendar.app`);
    lines.push("");
  }

  return lines.join("\n");
}

export function formatCalDigestHtml(section: CalDigestSection): string {
  const eventCount = section.days.reduce((n, d) => n + d.events.length, 0);
  let html = `<h3 style="margin:16px 0 8px">Calendar This Week (${eventCount} events)</h3>`;

  for (const day of section.days) {
    html += `<h4 style="margin:12px 0 4px;color:#333">${esc(day.label)}</h4>`;
    html += `<table style="border-collapse:collapse;width:100%">`;
    for (const e of day.events) {
      const time = e.allDay
        ? "all day"
        : e.startsAt
          ? new Date(e.startsAt).toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
            })
          : "";
      const loc = e.location ? ` <span style="color:#666">@ ${esc(e.location)}</span>` : "";
      html += `<tr>
        <td style="padding:2px 8px;color:#999;white-space:nowrap">${esc(time)}</td>
        <td style="padding:2px 8px">${esc(e.summary)}${loc}</td>
        <td style="padding:2px 8px;color:#aaa;font-size:0.85em">${esc(e.calendarName)}</td>
      </tr>`;
    }
    html += `</table>`;
  }

  if (section.newTodos.length > 0) {
    html += `<h4 style="margin:12px 0 4px">New Todos from Calendar (${section.newTodos.length})</h4><ul>`;
    for (const t of section.newTodos) {
      const due = t.dueDate ? ` <span style="color:#666">(due ${t.dueDate})</span>` : "";
      html += `<li>${esc(t.title)}${due} — <em>${esc(t.reason)}</em></li>`;
    }
    html += `</ul>`;
  }

  if (section.newFacts > 0) {
    html += `<p style="color:#666;font-size:0.9em">${section.newFacts} new fact${section.newFacts !== 1 ? "s" : ""} added to memory from calendar events</p>`;
  }

  if (section.willowCreated > 0) {
    html += `<p style="color:#8B5CF6;font-size:0.9em;font-weight:bold">Willow created ${section.willowCreated} event${section.willowCreated !== 1 ? "s" : ""} since last digest — check Calendar.app</p>`;
  }

  return html;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
