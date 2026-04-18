import { sql } from "../pib/config";
import { createLogger } from "../pib/logger";
import {
  discoverCalendars,
  fetchCalendarObjects,
  syncCalendarChanges,
  createCalendar,
} from "./caldav";
import { parseICS, contentHash, type ParsedEvent } from "./ics";

const log = createLogger("cal.sync");

const BACKFILL_DAYS_BACK = 30;
const BACKFILL_DAYS_FORWARD = 180;

export interface SyncStats {
  calendarsDiscovered: number;
  calendarsSkipped: number;
  eventsCreated: number;
  eventsUpdated: number;
  eventsDeleted: number;
  extractionEnqueued: number;
  errors: number;
}

export async function runCalSync(): Promise<SyncStats> {
  const stats: SyncStats = {
    calendarsDiscovered: 0,
    calendarsSkipped: 0,
    eventsCreated: 0,
    eventsUpdated: 0,
    eventsDeleted: 0,
    extractionEnqueued: 0,
    errors: 0,
  };

  // 0. Ensure the Willow staging calendar exists
  await ensureWillowCalendar();

  // 1. Discover all calendars and upsert
  const calendars = await discoverCalendars();
  stats.calendarsDiscovered = calendars.length;

  for (const cal of calendars) {
    await sql`
      INSERT INTO app.cal_calendar (url, display_name, color, is_shared)
      VALUES (
        ${cal.url}, ${cal.displayName}, ${cal.color ?? null},
        ${cal.url.includes("/shared/") || cal.displayName.toLowerCase().includes("shared")}
      )
      ON CONFLICT (url) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        color = EXCLUDED.color,
        updated_at = now()
    `;
  }

  // 2. For each enabled calendar, sync events
  const dbCalendars = await sql`
    SELECT id, url, display_name, ctag, sync_token, last_synced_at
    FROM app.cal_calendar WHERE enabled = true
  `;

  for (const dbCal of dbCalendars) {
    try {
      const remoteCal = calendars.find((c) => c.url === dbCal.url);
      if (!remoteCal) continue;

      // Check ctag — if unchanged, skip
      if (dbCal.ctag && remoteCal.ctag === dbCal.ctag) {
        stats.calendarsSkipped++;
        log.debug(`Skipping "${dbCal.display_name}" — ctag unchanged`);
        continue;
      }

      const isFirstSync = !dbCal.last_synced_at;

      if (isFirstSync || !dbCal.sync_token) {
        // Full fetch with backfill window
        const calResult = await fullSync(dbCal.id, dbCal.url, stats);
        log.info(
          `Full sync "${dbCal.display_name}": ${calResult.created} created, ${calResult.updated} updated`
        );
      } else {
        // Incremental sync via sync token
        const calResult = await incrementalSync(
          dbCal.id,
          dbCal.url,
          dbCal.sync_token,
          stats
        );
        log.info(
          `Incremental sync "${dbCal.display_name}": ${calResult.created} created, ${calResult.updated} updated, ${calResult.deleted} deleted`
        );
      }

      // Update calendar state
      await sql`
        UPDATE app.cal_calendar SET
          ctag = ${remoteCal.ctag ?? null},
          sync_token = ${remoteCal.syncToken ?? dbCal.sync_token ?? null},
          last_synced_at = now(),
          updated_at = now()
        WHERE id = ${dbCal.id}
      `;
    } catch (err) {
      stats.errors++;
      log.error(
        `Failed syncing "${dbCal.display_name}": ${(err as Error).message}`
      );
    }
  }

  log.info(
    `Sync complete: ${stats.calendarsDiscovered} calendars, ` +
      `${stats.eventsCreated} created, ${stats.eventsUpdated} updated, ` +
      `${stats.eventsDeleted} deleted, ${stats.extractionEnqueued} enqueued`
  );

  return stats;
}

async function fullSync(
  calendarId: string,
  calendarUrl: string,
  stats: SyncStats
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;

  const objects = await fetchCalendarObjects(calendarUrl);
  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() - BACKFILL_DAYS_BACK);
  const windowEnd = new Date(now);
  windowEnd.setDate(windowEnd.getDate() + BACKFILL_DAYS_FORWARD);

  for (const obj of objects) {
    const icsData = typeof obj.data === "string" ? obj.data : "";
    if (!icsData) continue;

    const parsed = parseICS(icsData);
    if (!parsed) continue;

    // Filter by backfill window (but keep recurring events regardless)
    if (!parsed.rrule && parsed.startsAt) {
      if (parsed.startsAt < windowStart || parsed.startsAt > windowEnd) continue;
    }

    const result = await upsertEvent(calendarId, obj.etag ?? null, obj.url ?? null, icsData, parsed, stats);
    if (result === "created") created++;
    else if (result === "updated") updated++;
  }

  stats.eventsCreated += created;
  stats.eventsUpdated += updated;
  return { created, updated };
}

async function incrementalSync(
  calendarId: string,
  calendarUrl: string,
  syncToken: string,
  stats: SyncStats
): Promise<{ created: number; updated: number; deleted: number }> {
  let created = 0;
  let updated = 0;
  let deleted = 0;

  const { objects, newSyncToken } = await syncCalendarChanges(
    calendarUrl,
    syncToken
  );

  for (const obj of objects) {
    // Deleted objects have no data
    if (!obj.data) {
      // Try to soft-delete by URL
      const href = obj.url;
      if (href) {
        await sql`
          UPDATE app.cal_event SET deleted_at = now(), updated_at = now()
          WHERE calendar_id = ${calendarId}
            AND uid IN (
              SELECT uid FROM app.cal_event
              WHERE calendar_id = ${calendarId} AND raw_ics LIKE ${"%" + href + "%"}
            )
            AND deleted_at IS NULL
        `;
        deleted++;
        stats.eventsDeleted++;
      }
      continue;
    }

    const icsData = typeof obj.data === "string" ? obj.data : "";
    if (!icsData) continue;

    const parsed = parseICS(icsData);
    if (!parsed) continue;

    const result = await upsertEvent(calendarId, obj.etag ?? null, obj.url ?? null, icsData, parsed, stats);
    if (result === "created") created++;
    else if (result === "updated") updated++;
  }

  // Update sync token
  if (newSyncToken) {
    await sql`
      UPDATE app.cal_calendar SET sync_token = ${newSyncToken}
      WHERE id = ${calendarId}
    `;
  }

  stats.eventsCreated += created;
  stats.eventsUpdated += updated;
  return { created, updated, deleted };
}

async function upsertEvent(
  calendarId: string,
  etag: string | null,
  caldavUrl: string | null,
  rawIcs: string,
  parsed: ParsedEvent,
  stats: SyncStats
): Promise<"created" | "updated" | "unchanged"> {
  const existing = await sql`
    SELECT id, etag FROM app.cal_event
    WHERE calendar_id = ${calendarId} AND uid = ${parsed.uid}
      AND deleted_at IS NULL
  `;

  const hash = contentHash(parsed);

  if (existing.length === 0) {
    // Insert new event
    const [row] = await sql`
      INSERT INTO app.cal_event (
        calendar_id, uid, etag, caldav_url, summary, description, location,
        starts_at, ends_at, all_day, rrule, master_uid,
        attendees, organizer, status, raw_ics, source
      ) VALUES (
        ${calendarId}, ${parsed.uid}, ${etag}, ${caldavUrl},
        ${parsed.summary}, ${parsed.description}, ${parsed.location},
        ${parsed.startsAt?.toISOString() ?? null}, ${parsed.endsAt?.toISOString() ?? null},
        ${parsed.allDay}, ${parsed.rrule}, ${parsed.masterUid},
        ${sql.json(parsed.attendees as any)}, ${parsed.organizer},
        ${parsed.status}, ${rawIcs}, 'sync'
      ) RETURNING id
    `;

    // Enqueue extraction
    await sql`
      INSERT INTO app.cal_event_processing (event_id, content_hash, status)
      VALUES (${row.id}, ${hash}, 'pending')
    `;
    stats.extractionEnqueued++;

    return "created";
  }

  const eventId = existing[0].id;

  // Check if etag changed
  if (existing[0].etag === etag) return "unchanged";

  // Update the event
  await sql`
    UPDATE app.cal_event SET
      etag = ${etag},
      caldav_url = COALESCE(${caldavUrl}, caldav_url),
      summary = ${parsed.summary},
      description = ${parsed.description},
      location = ${parsed.location},
      starts_at = ${parsed.startsAt?.toISOString() ?? null},
      ends_at = ${parsed.endsAt?.toISOString() ?? null},
      all_day = ${parsed.allDay},
      rrule = ${parsed.rrule},
      master_uid = ${parsed.masterUid},
      attendees = ${sql.json(parsed.attendees as any)},
      organizer = ${parsed.organizer},
      status = ${parsed.status},
      raw_ics = ${rawIcs},
      updated_at = now()
    WHERE id = ${eventId}
  `;

  // Check content hash — only re-enqueue extraction if content changed
  const existingProcessing = await sql`
    SELECT content_hash FROM app.cal_event_processing
    WHERE event_id = ${eventId}
    ORDER BY created_at DESC LIMIT 1
  `;

  if (existingProcessing.length === 0 || existingProcessing[0].content_hash !== hash) {
    await sql`
      INSERT INTO app.cal_event_processing (event_id, content_hash, status)
      VALUES (${eventId}, ${hash}, 'pending')
      ON CONFLICT (event_id, content_hash) DO NOTHING
    `;
    stats.extractionEnqueued++;
  }

  return "updated";
}

// ── Single-calendar sync (used after CalDAV writes) ────────────────────────

/**
 * Sync a single calendar by ID. Used after creating/updating/deleting events
 * via CalDAV to immediately reflect changes in the local DB.
 */
export async function syncSingleCalendar(calendarId: string): Promise<void> {
  const [dbCal] = await sql`
    SELECT id, url, display_name, sync_token
    FROM app.cal_calendar WHERE id = ${calendarId}
  `;
  if (!dbCal) {
    log.warn(`syncSingleCalendar: calendar ${calendarId} not found`);
    return;
  }

  const stats: SyncStats = {
    calendarsDiscovered: 0, calendarsSkipped: 0,
    eventsCreated: 0, eventsUpdated: 0, eventsDeleted: 0,
    extractionEnqueued: 0, errors: 0,
  };

  // Always do a full sync for the single calendar to pick up the new event
  await fullSync(dbCal.id, dbCal.url, stats);

  // Re-discover to get the fresh ctag/syncToken
  const calendars = await discoverCalendars();
  const remoteCal = calendars.find((c) => c.url === dbCal.url);
  if (remoteCal) {
    await sql`
      UPDATE app.cal_calendar SET
        ctag = ${remoteCal.ctag ?? null},
        sync_token = ${remoteCal.syncToken ?? dbCal.sync_token ?? null},
        last_synced_at = now(),
        updated_at = now()
      WHERE id = ${dbCal.id}
    `;
  }

  log.info(
    `Single-calendar sync "${dbCal.display_name}": ` +
    `${stats.eventsCreated} created, ${stats.eventsUpdated} updated`
  );
}

// ── Willow staging calendar ────────────────────────────────────────────────

/**
 * Ensure the dedicated "Willow" calendar exists in iCloud.
 * Creates it via CalDAV MKCALENDAR if not found.
 */
export async function ensureWillowCalendar(): Promise<string> {
  // Check if we already have it in the DB
  const [existing] = await sql`
    SELECT id FROM app.cal_calendar WHERE is_willow = true
  `;
  if (existing) return existing.id;

  // Check if there's a calendar named "Willow" that we haven't marked yet
  const [namedWillow] = await sql`
    SELECT id FROM app.cal_calendar WHERE display_name = 'Willow'
  `;
  if (namedWillow) {
    await sql`UPDATE app.cal_calendar SET is_willow = true WHERE id = ${namedWillow.id}`;
    log.info(`Marked existing "Willow" calendar as the staging calendar`);
    return namedWillow.id;
  }

  // Create via CalDAV
  log.info(`Creating "Willow" calendar in iCloud...`);
  const calUrl = await createCalendar("Willow", "#8B5CF6");

  // Upsert into DB
  const [row] = await sql`
    INSERT INTO app.cal_calendar (url, display_name, color, is_willow, is_shared)
    VALUES (${calUrl}, 'Willow', '#8B5CF6', true, false)
    ON CONFLICT (url) DO UPDATE SET is_willow = true, display_name = 'Willow'
    RETURNING id
  `;

  log.info(`Created Willow staging calendar: ${row.id}`);
  return row.id;
}

/**
 * Get the Willow staging calendar ID, or null if it doesn't exist yet.
 */
export async function getWillowCalendarId(): Promise<string | null> {
  const [row] = await sql`SELECT id FROM app.cal_calendar WHERE is_willow = true`;
  return row?.id ?? null;
}
