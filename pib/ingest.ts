import { sql } from "./config";
import type { CanonicalEvent } from "./jmap/types";

interface IngestResult {
  sourceNoteId: string;
  alreadyExists: boolean;
}

/**
 * Write a CanonicalEvent to app.source_note.
 * Idempotent — skips if source_type + source_ref already exists.
 */
export async function ingestEvent(event: CanonicalEvent): Promise<IngestResult> {
  // Build the raw_text from available content
  const rawText = buildRawText(event);

  // Build metadata for email-specific fields
  const metadata = {
    from: event.fromEntity,
    to: event.toEntities,
    threadId: event.sourceMeta.threadId as string,
    headers: event.sourceMeta.headers as Record<string, string>[],
    replyTo: event.sourceMeta.replyTo as Record<string, string>[] | null,
    mailboxIds: event.sourceMeta.mailboxIds as Record<string, boolean>,
    keywords: event.sourceMeta.keywords as Record<string, boolean>,
    attachments: event.attachments,
    bodyHtml: event.bodyHtml ? true : false,
  };

  const rows = await sql`
    INSERT INTO app.source_note (
      source_type, source_ref, title, raw_text, metadata, received_at
    ) VALUES (
      ${event.sourceType},
      ${event.sourceRef},
      ${event.subject ?? null},
      ${rawText},
      ${sql.json(metadata as any)},
      ${event.receivedAt}
    )
    ON CONFLICT (source_type, source_ref) WHERE source_ref IS NOT NULL
    DO NOTHING
    RETURNING source_note_id
  `;

  if (rows.length === 0) {
    // Already existed — look up the existing ID
    const existing = await sql`
      SELECT source_note_id FROM app.source_note
      WHERE source_type = ${event.sourceType} AND source_ref = ${event.sourceRef}
    `;
    return { sourceNoteId: existing[0].source_note_id, alreadyExists: true };
  }

  return { sourceNoteId: rows[0].source_note_id, alreadyExists: false };
}

function buildRawText(event: CanonicalEvent): string {
  const parts: string[] = [];

  if (event.subject) {
    parts.push(`Subject: ${event.subject}`);
  }
  parts.push(`From: ${event.fromEntity.displayName} <${event.fromEntity.address}>`);

  if (event.toEntities.length > 0) {
    const tos = event.toEntities.map((e) => `${e.displayName} <${e.address}>`).join(", ");
    parts.push(`To: ${tos}`);
  }

  parts.push(`Date: ${event.receivedAt}`);
  parts.push("");

  if (event.bodyText) {
    parts.push(event.bodyText);
  } else if (event.bodyHtml) {
    // Strip HTML tags for raw_text (basic fallback)
    parts.push(event.bodyHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
  }

  return parts.join("\n");
}

/**
 * Batch ingest multiple events. Returns summary stats.
 */
export async function ingestEvents(
  events: CanonicalEvent[]
): Promise<{ ingested: number; skipped: number }> {
  let ingested = 0;
  let skipped = 0;

  for (const event of events) {
    const result = await ingestEvent(event);
    if (result.alreadyExists) {
      skipped++;
    } else {
      ingested++;
    }
  }

  return { ingested, skipped };
}
