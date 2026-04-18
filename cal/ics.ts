export interface ParsedEvent {
  uid: string;
  summary: string;
  description: string | null;
  location: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  allDay: boolean;
  rrule: string | null;
  masterUid: string | null;
  attendees: { name?: string; email?: string; role?: string }[];
  organizer: string | null;
  status: string;
}

export function parseICS(icsText: string): ParsedEvent | null {
  const lines = unfoldLines(icsText);

  const veventStart = lines.findIndex((l) => l === "BEGIN:VEVENT");
  const veventEnd = lines.findIndex((l) => l === "END:VEVENT");
  if (veventStart === -1 || veventEnd === -1) return null;

  const eventLines = lines.slice(veventStart + 1, veventEnd);

  const props = new Map<string, string>();
  const attendees: ParsedEvent["attendees"] = [];

  for (const line of eventLines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const keyPart = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 1);
    const name = keyPart.split(";")[0].toUpperCase();

    if (name === "ATTENDEE") {
      attendees.push(parseAttendee(keyPart, value));
    } else if (!props.has(name)) {
      props.set(name, value);
    }
  }

  const uid = props.get("UID");
  if (!uid) return null;

  const dtStart = props.get("DTSTART");
  const dtEnd = props.get("DTEND");
  const allDay = isAllDay(
    eventLines.find((l) => l.startsWith("DTSTART"))
  );

  return {
    uid,
    summary: unescapeICS(props.get("SUMMARY") ?? ""),
    description: props.has("DESCRIPTION")
      ? unescapeICS(props.get("DESCRIPTION")!)
      : null,
    location: props.has("LOCATION")
      ? unescapeICS(props.get("LOCATION")!)
      : null,
    startsAt: dtStart ? parseICSDate(dtStart) : null,
    endsAt: dtEnd ? parseICSDate(dtEnd) : null,
    allDay,
    rrule: props.get("RRULE") ?? null,
    masterUid: props.get("RECURRENCE-ID") ? uid : null,
    attendees,
    organizer: parseOrganizerEmail(props.get("ORGANIZER") ?? null),
    status: props.get("STATUS") ?? "CONFIRMED",
  };
}

function unfoldLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function parseICSDate(value: string): Date | null {
  // YYYYMMDD
  if (/^\d{8}$/.test(value)) {
    return new Date(
      `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`
    );
  }
  // YYYYMMDDTHHMMSS or YYYYMMDDTHHMMSSZ
  const match = value.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/
  );
  if (match) {
    const [, y, mo, d, h, mi, s, z] = match;
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${z || ""}`;
    return new Date(iso);
  }
  return null;
}

function isAllDay(dtStartLine: string | undefined): boolean {
  if (!dtStartLine) return false;
  return (
    dtStartLine.includes("VALUE=DATE") && !dtStartLine.includes("VALUE=DATE-TIME")
  );
}

function parseAttendee(
  keyPart: string,
  value: string
): ParsedEvent["attendees"][0] {
  const email = value.replace(/^mailto:/i, "").trim();
  const params = keyPart.split(";").slice(1);
  let name: string | undefined;
  let role: string | undefined;

  for (const param of params) {
    const [k, v] = param.split("=");
    if (k.toUpperCase() === "CN") name = v?.replace(/^"|"$/g, "");
    if (k.toUpperCase() === "ROLE") role = v;
  }

  return { name, email, role };
}

function parseOrganizerEmail(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/^mailto:/i, "").trim() || null;
}

function unescapeICS(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

// ── ICS Generation ─────────────────────────────────────────────────────────

export interface GenerateEventInput {
  uid?: string;
  summary: string;
  description?: string;
  location?: string;
  startsAt: Date;
  endsAt: Date;
  allDay?: boolean;
  attendees?: { name?: string; email: string }[];
  status?: string;
}

export function generateICS(input: GenerateEventInput): string {
  const uid = input.uid ?? `willow-${crypto.randomUUID()}`;
  const now = formatICSDateUTC(new Date());

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Willow//CalDAV Write//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${now}`,
  ];

  if (input.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${formatICSDate(input.startsAt)}`);
    lines.push(`DTEND;VALUE=DATE:${formatICSDate(input.endsAt)}`);
  } else {
    lines.push(`DTSTART:${formatICSDateUTC(input.startsAt)}`);
    lines.push(`DTEND:${formatICSDateUTC(input.endsAt)}`);
  }

  lines.push(`SUMMARY:${escapeICSValue(input.summary)}`);

  if (input.description) {
    lines.push(`DESCRIPTION:${escapeICSValue(input.description)}`);
  }
  if (input.location) {
    lines.push(`LOCATION:${escapeICSValue(input.location)}`);
  }
  if (input.status) {
    lines.push(`STATUS:${input.status.toUpperCase()}`);
  }
  if (input.attendees) {
    for (const att of input.attendees) {
      const cn = att.name ? `;CN="${escapeICSValue(att.name)}"` : "";
      lines.push(`ATTENDEE${cn}:mailto:${att.email}`);
    }
  }

  lines.push("END:VEVENT", "END:VCALENDAR");

  return foldLines(lines).join("\r\n") + "\r\n";
}

/** Escape special characters per RFC 5545 */
export function escapeICSValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** Format Date as YYYYMMDD (for VALUE=DATE) */
function formatICSDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/** Format Date as YYYYMMDDTHHMMSSZ (UTC) */
function formatICSDateUTC(date: Date): string {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const s = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}${mo}${d}T${h}${mi}${s}Z`;
}

/** Fold lines longer than 75 octets per RFC 5545 */
function foldLines(lines: string[]): string[] {
  const result: string[] = [];
  for (const line of lines) {
    if (line.length <= 75) {
      result.push(line);
    } else {
      result.push(line.slice(0, 75));
      let rest = line.slice(75);
      while (rest.length > 0) {
        // Continuation lines start with a space, so 74 chars of content
        result.push(" " + rest.slice(0, 74));
        rest = rest.slice(74);
      }
    }
  }
  return result;
}

// ── Content Hash ───────────────────────────────────────────────────────────

export function contentHash(event: ParsedEvent): string {
  const input = [
    event.summary,
    event.description ?? "",
    event.location ?? "",
    event.startsAt?.toISOString() ?? "",
    event.endsAt?.toISOString() ?? "",
  ].join("|");

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex").slice(0, 16);
}
