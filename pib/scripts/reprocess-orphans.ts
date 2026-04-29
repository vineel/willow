/**
 * Reprocess orphan email source_notes — those that exist in app.source_note
 * but never produced any app.fact rows (typically because triage failed).
 *
 * Reconstructs a CanonicalEvent from stored metadata + raw_text and runs the
 * post-ingest steps: entity resolution → triage → classify → extract → dispatch.
 *
 * Usage:
 *   bun run pib/scripts/reprocess-orphans.ts <source_note_id> [<source_note_id>...]
 */

import { sql } from "../config";
import type { CanonicalEvent } from "../jmap/types";
import { resolveEventSender } from "../entity-resolver";
import { loadRules } from "../triage/rules";
import { triage } from "../triage/engine";
import { loadActiveInterests, matchInterests } from "../interest-matcher";
import { classify, writeClassification } from "../classify";
import { needsExtraction, extract, writeExtraction } from "../extract";
import { dispatch } from "../dispatch";
import { createLogger } from "../logger";

const log = createLogger("pib.reprocess");

async function reconstructEvent(sourceNoteId: string): Promise<CanonicalEvent | null> {
  const [row] = await sql`
    SELECT source_note_id, source_type, source_ref, title, raw_text, metadata, received_at
    FROM app.source_note
    WHERE source_note_id = ${sourceNoteId}
  `;
  if (!row) return null;

  const meta = row.metadata as Record<string, unknown>;
  const rawText = row.raw_text as string;

  // raw_text was constructed by buildRawText(): "Subject:\nFrom:\nTo:\nDate:\n\n<body>"
  // Strip the synthetic header block to recover bodyText.
  const blankIdx = rawText.indexOf("\n\n");
  const bodyText = blankIdx >= 0 ? rawText.slice(blankIdx + 2) : rawText;

  return {
    id: (row.source_ref as string) ?? sourceNoteId,
    sourceType: row.source_type as string,
    sourceRef: (row.source_ref as string) ?? sourceNoteId,
    sourceMeta: {
      threadId: meta.threadId,
      mailboxIds: meta.mailboxIds,
      keywords: meta.keywords,
      headers: meta.headers,
      replyTo: meta.replyTo,
    },
    receivedAt: new Date(row.received_at as string).toISOString(),
    fromEntity: meta.from as CanonicalEvent["fromEntity"],
    toEntities: (meta.to as CanonicalEvent["toEntities"]) ?? [],
    subject: (row.title as string | null) ?? undefined,
    bodyText,
    bodyHtml: undefined,
    attachments: (meta.attachments as CanonicalEvent["attachments"]) ?? [],
  };
}

async function writeTriageResult(
  sourceNoteId: string,
  triageResult: { action: string; source: string; rule_id?: string; rule_name?: string }
): Promise<string> {
  const [note] = await sql`
    SELECT title, from_factoid_id FROM app.source_note WHERE source_note_id = ${sourceNoteId}
  `;
  const [inserted] = await sql`
    INSERT INTO app.fact (
      source_note_id, title, content, is_factoid,
      parent_factoid_id, memory_type, status, is_active,
      triage_action, triage_source, triage_rule_id
    ) VALUES (
      ${sourceNoteId}, ${note?.title ?? "Email"}, ${note?.title ?? "Email fact"},
      false, ${note?.from_factoid_id ?? null}, 'short_term', 'raw', true,
      ${triageResult.action}, ${triageResult.source}, ${triageResult.rule_id ?? null}
    )
    RETURNING fact_id
  `;
  return inserted.fact_id;
}

async function reprocessOne(sourceNoteId: string) {
  const event = await reconstructEvent(sourceNoteId);
  if (!event) {
    log.error(`source_note ${sourceNoteId} not found`);
    return;
  }

  const subject = event.subject ?? "(no subject)";
  const from = `${event.fromEntity.displayName} <${event.fromEntity.address}>`;
  log.info(`REPROCESS source_note=${sourceNoteId} from=${from} subject="${subject}"`);

  // Bail if a fact already exists (don't double-process).
  const existing = await sql`SELECT fact_id FROM app.fact WHERE source_note_id = ${sourceNoteId} LIMIT 1`;
  if (existing.length > 0) {
    log.warn(`fact already exists for ${sourceNoteId} — skipping`);
    return;
  }

  // 1. Entity resolution
  const resolved = await resolveEventSender(
    sourceNoteId,
    event.fromEntity.address,
    event.fromEntity.displayName
  );
  log.info(`  entity=${resolved.isNew ? "NEW" : "existing"}`);

  // 2. Triage
  const rules = await loadRules();
  const triageResult = triage(event, rules);
  const factId = await writeTriageResult(sourceNoteId, triageResult);
  log.info(`  triage=${triageResult.action} source=${triageResult.source} rule=${triageResult.rule_name ?? "(none)"}`);

  if (triageResult.action === "noise") {
    log.info(`  STOP — triaged as noise`);
    return;
  }

  // 3. Interests
  const interests = await loadActiveInterests();
  const interestMatches = matchInterests(event, interests);
  if (interestMatches.length > 0) {
    log.info(`  interests=[${interestMatches.map(m => m.interest.name).join(", ")}]`);
  } else {
    log.info(`  interests=(none)`);
  }

  // 4. Classify
  const classResult = await classify(event, interestMatches.map(m => m.interest));
  await writeClassification(factId, classResult);
  log.info(`  class=${classResult.category}.${classResult.subcategory} (${classResult.confidence})`);

  // 5. Extract (conditional)
  let extractedData: Record<string, unknown> | null = null;
  const matchedInterests = interestMatches.map(m => m.interest);
  const { needed, schema } = await needsExtraction(classResult.intentId, matchedInterests);
  if (needed && schema) {
    const extractResult = await extract(event, classResult.category, classResult.subcategory, schema);
    if (Object.keys(extractResult.data).length > 0) {
      extractedData = extractResult.data;
      await writeExtraction(factId, extractResult.data);
      log.info(`  extracted=${JSON.stringify(extractResult.data)}`);
    }
  }

  // 6. Dispatch
  // Mirror pipeline.ts behavior: only run dispatch if an interest matched.
  // (Note: this means calendar.invite intents without a matching interest
  // won't auto-create calendar events — separate bug, not fixed here.)
  if (interestMatches.length > 0) {
    const dispatchResult = await dispatch(event, factId, interestMatches, extractedData);
    for (const ar of dispatchResult.actionResults) {
      log.info(`  action="${ar.interest}"→${ar.success ? "OK" : "FAILED:" + ar.error}`);
    }
  } else {
    log.info(`  dispatch=skipped (no interest match)`);
  }
}

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error("Usage: bun run pib/scripts/reprocess-orphans.ts <source_note_id> [...]");
  process.exit(1);
}

for (const id of ids) {
  await reprocessOne(id);
}

await sql.end();
