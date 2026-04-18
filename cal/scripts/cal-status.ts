import { sql } from "../../pib/config";

async function main() {
  // Calendar overview
  const calendars = await sql`
    SELECT display_name, url, enabled, is_shared, last_synced_at,
      (SELECT count(*) FROM app.cal_event WHERE calendar_id = c.id AND deleted_at IS NULL) as event_count
    FROM app.cal_calendar c
    ORDER BY display_name
  `;

  console.log("=== Calendars ===\n");
  if (calendars.length === 0) {
    console.log("  No calendars synced yet. Run: bun run cal:sync\n");
  } else {
    for (const cal of calendars) {
      const status = cal.enabled ? "enabled" : "DISABLED";
      const shared = cal.is_shared ? " (shared)" : "";
      const lastSync = cal.last_synced_at
        ? new Date(cal.last_synced_at).toLocaleString()
        : "never";
      console.log(`  ${cal.display_name}${shared} [${status}]`);
      console.log(`    Events: ${cal.event_count} | Last sync: ${lastSync}`);
    }
  }

  // Processing stats
  const processing = await sql`
    SELECT
      status,
      count(*) as cnt
    FROM app.cal_event_processing
    GROUP BY status
    ORDER BY status
  `;

  console.log("\n=== Extraction Status ===\n");
  if (processing.length === 0) {
    console.log("  No events processed yet.\n");
  } else {
    for (const row of processing) {
      console.log(`  ${row.status}: ${row.cnt}`);
    }
  }

  // Recent extractions
  const recent = await sql`
    SELECT
      e.summary, e.starts_at,
      p.status, p.processed_at,
      jsonb_array_length(COALESCE(p.extracted_todos, '[]'::jsonb)) as todo_count,
      jsonb_array_length(COALESCE(p.extracted_facts, '[]'::jsonb)) as fact_count,
      p.error
    FROM app.cal_event_processing p
    JOIN app.cal_event e ON p.event_id = e.id
    ORDER BY p.created_at DESC
    LIMIT 10
  `;

  console.log("\n=== Recent Extractions (last 10) ===\n");
  if (recent.length === 0) {
    console.log("  None.\n");
  } else {
    for (const r of recent) {
      const date = r.starts_at
        ? new Date(r.starts_at).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          })
        : "??";
      const statusEmoji =
        r.status === "done" ? "ok" : r.status === "error" ? "ERR" : "...";
      const extras =
        r.todo_count > 0 || r.fact_count > 0
          ? ` → ${r.todo_count} todos, ${r.fact_count} facts`
          : "";
      const err = r.error ? ` (${r.error.slice(0, 60)})` : "";
      console.log(`  [${statusEmoji}] ${date} ${r.summary}${extras}${err}`);
    }
  }

  // Upcoming events
  const upcoming = await sql`
    SELECT e.summary, e.starts_at, e.location, e.all_day, c.display_name
    FROM app.cal_event e
    JOIN app.cal_calendar c ON e.calendar_id = c.id
    WHERE e.starts_at > now()
      AND e.deleted_at IS NULL
      AND c.enabled = true
    ORDER BY e.starts_at ASC
    LIMIT 10
  `;

  console.log("\n=== Upcoming Events (next 10) ===\n");
  if (upcoming.length === 0) {
    console.log("  None.\n");
  } else {
    for (const e of upcoming) {
      const dt = e.all_day
        ? new Date(e.starts_at).toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
          })
        : new Date(e.starts_at).toLocaleString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          });
      const loc = e.location ? ` @ ${e.location}` : "";
      console.log(`  ${dt} — ${e.summary}${loc} [${e.display_name}]`);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
