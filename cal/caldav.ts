import { createDAVClient, type DAVCalendar, type DAVObject } from "tsdav";
import { getSecret } from "../pib/config";
import { createLogger } from "../pib/logger";

const log = createLogger("cal.caldav");

const ICLOUD_CALDAV_URL = "https://caldav.icloud.com";
const APPLE_ID = "vineel@vineel.com";

export interface CalendarInfo {
  url: string;
  displayName: string;
  ctag: string | undefined;
  syncToken: string | undefined;
  color: string | undefined;
  description: string | undefined;
}

export interface SyncResult {
  created: DAVObject[];
  updated: DAVObject[];
  deleted: string[];
}

let clientPromise: ReturnType<typeof createDAVClient> | null = null;

async function getClient() {
  if (!clientPromise) {
    const password = await getSecret("willow-icloud-caldav");
    clientPromise = createDAVClient({
      serverUrl: ICLOUD_CALDAV_URL,
      credentials: {
        username: APPLE_ID,
        password,
      },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
  }
  return clientPromise;
}

export async function discoverCalendars(): Promise<CalendarInfo[]> {
  const client = await getClient();
  const calendars = await client.fetchCalendars();

  log.info(`Discovered ${calendars.length} calendars`);

  return calendars.map((cal: DAVCalendar) => ({
    url: cal.url,
    displayName: cal.displayName ?? "Untitled",
    ctag: cal.ctag,
    syncToken: cal.syncToken,
    color: (cal as any).calendarColor ?? undefined,
    description: (cal as any).calendarDescription ?? undefined,
  }));
}

export async function fetchCalendarObjects(
  calendarUrl: string
): Promise<DAVObject[]> {
  const client = await getClient();
  return client.fetchCalendarObjects({ calendar: { url: calendarUrl } as DAVCalendar });
}

export async function syncCalendarChanges(
  calendarUrl: string,
  syncToken: string
): Promise<{ objects: DAVObject[]; newSyncToken: string | undefined }> {
  const client = await getClient();

  const result = await client.smartCollectionSync({
    collection: { url: calendarUrl, syncToken } as DAVCalendar,
    method: "webdav",
  });

  const objects = (result as any).objects ?? [];
  const newSyncToken =
    (result as any).syncToken ??
    (result as any).collection?.syncToken ??
    undefined;

  return { objects, newSyncToken };
}

// ── Write operations ───────────────────────────────────────────────────────

export async function createCalendarEvent(
  calendarUrl: string,
  icsString: string,
  filename: string
): Promise<void> {
  const client = await getClient();
  const resp = await client.createCalendarObject({
    calendar: { url: calendarUrl } as DAVCalendar,
    iCalString: icsString,
    filename,
  });
  log.info(`Created calendar event: ${filename} on ${calendarUrl}`);
}

export async function updateCalendarEvent(
  eventUrl: string,
  icsString: string,
  etag: string | null
): Promise<void> {
  const client = await getClient();
  await client.updateCalendarObject({
    calendarObject: {
      url: eventUrl,
      data: icsString,
      etag: etag ?? undefined,
    },
  });
  log.info(`Updated calendar event: ${eventUrl}`);
}

export async function deleteCalendarEvent(
  eventUrl: string,
  etag: string | null
): Promise<void> {
  const client = await getClient();
  await client.deleteCalendarObject({
    calendarObject: {
      url: eventUrl,
      etag: etag ?? undefined,
    },
  });
  log.info(`Deleted calendar event: ${eventUrl}`);
}

/**
 * Create a new calendar collection via MKCALENDAR.
 * Returns the URL of the newly created calendar.
 */
export async function createCalendar(
  displayName: string,
  color?: string
): Promise<string> {
  const client = await getClient();

  // Discover the calendar home URL
  const calendars = await client.fetchCalendars();
  if (calendars.length === 0) {
    throw new Error("No calendars found — cannot determine calendar home URL");
  }
  // Calendar home is the parent of any existing calendar URL
  const existingUrl = calendars[0].url;
  const homeUrl = existingUrl.replace(/[^/]+\/?$/, "");

  const calSlug = `willow-${Date.now()}`;
  const calUrl = `${homeUrl}${calSlug}/`;

  const props: Record<string, any> = {
    "d:displayname": { _text: displayName },
    "c:supported-calendar-component-set": {
      "c:comp": { _attributes: { name: "VEVENT" } },
    },
  };
  if (color) {
    props["ca:calendar-color"] = { _text: color };
  }

  await client.makeCalendar({
    url: calUrl,
    props,
  });

  log.info(`Created calendar "${displayName}" at ${calUrl}`);
  return calUrl;
}

export async function resetClient(): void {
  clientPromise = null;
}
