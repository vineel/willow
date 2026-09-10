// Reconstruct a CanonicalEvent from an app.source_note row, for use by
// backfill / preview / dry-run when re-fetching from JMAP would be wasteful.

import type { CanonicalEvent } from "../jmap/types";

interface SourceNoteRow {
  source_note_id: string;
  source_type: string;
  source_ref: string | null;
  title: string | null;
  raw_text: string;
  metadata: any;
  received_at: Date | null;
}

// raw_text format from pib/ingest.ts:
//   Subject: <subject>
//   From: <name> <<email>>
//   To: <addrs>
//   Date: <iso>
//   <blank>
//   <body>
function extractBody(rawText: string): string {
  const lines = rawText.split("\n");
  // Skip leading header lines until we hit a blank line.
  let i = 0;
  while (i < lines.length && lines[i] !== "") i++;
  return lines.slice(i + 1).join("\n").trim();
}

export function sourceNoteToEvent(row: SourceNoteRow): CanonicalEvent {
  const meta = row.metadata ?? {};
  const from = meta.from ?? { displayName: "unknown", address: "unknown", sourceType: "email" };
  const to = (meta.to as any[]) ?? [];

  return {
    id: row.source_ref ?? row.source_note_id,
    sourceType: row.source_type,
    sourceRef: row.source_ref ?? row.source_note_id,
    sourceMeta: {
      threadId: meta.threadId ?? null,
      mailboxIds: meta.mailboxIds ?? {},
      keywords: meta.keywords ?? {},
      headers: meta.headers ?? [],
      replyTo: meta.replyTo ?? null,
    },
    receivedAt: row.received_at ? row.received_at.toISOString() : new Date().toISOString(),
    fromEntity: {
      displayName: from.displayName ?? from.name ?? from.address ?? "unknown",
      address: from.address ?? from.email ?? "unknown",
      sourceType: from.sourceType ?? "email",
    },
    toEntities: to.map((t) => ({
      displayName: t.displayName ?? t.name ?? t.address ?? "unknown",
      address: t.address ?? t.email ?? "unknown",
      sourceType: t.sourceType ?? "email",
    })),
    subject: row.title ?? undefined,
    bodyText: extractBody(row.raw_text),
    bodyHtml: undefined,
    attachments: meta.attachments ?? [],
  };
}
