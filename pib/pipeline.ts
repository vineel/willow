/**
 * PIB pipeline — the core ingest function, extracted from fetch.ts for reuse
 * by both the CLI and the Graphile Worker task.
 */

import { getSecret, sql, pibConfig } from "./config";
import { getSession, getMailboxes, findMailbox } from "./jmap/session";
import {
  queryEmails,
  queryChanges,
  getEmails,
  QueryChangesError,
} from "./jmap/query";
import { normalize } from "./normalizer";
import { getSyncState, saveSyncState } from "./state";
import { ingestEvent } from "./ingest";
import { resolveEventSender } from "./entity-resolver";
import { loadRules } from "./triage/rules";
import { triage } from "./triage/engine";
import { classifyFolder, handleSignalFolder } from "./signal-folders";
import { loadActiveInterests, matchInterests } from "./interest-matcher";
import { classify, writeClassification } from "./classify";
import { needsExtraction, extract, writeExtraction } from "./extract";
import { dispatch } from "./dispatch";
import type { CanonicalEvent } from "./jmap/types";

const SOURCE_TYPE = "email";

interface PipelineStats {
  fetched: number;
  ingested: number;
  skipped: number;
  triaged: Record<string, number>;
  classified: number;
  extracted: number;
  dispatched: number;
  errors: string[];
}

/**
 * Run the full pipeline for a folder.
 * This is the function called by both `pib:fetch --dispatch` and the Graphile Worker cron task.
 */
export async function runPipeline(
  folder: string,
  options: { limit?: number; full?: boolean; doClassify?: boolean; doDispatch?: boolean } = {}
): Promise<PipelineStats> {
  const { limit = 100, full = false, doClassify = true, doDispatch = true } = options;

  const stats: PipelineStats = {
    fetched: 0, ingested: 0, skipped: 0,
    triaged: {}, classified: 0, extracted: 0, dispatched: 0, errors: [],
  };

  // Skip notification folder
  if (folder.toLowerCase() === pibConfig.folders.notifications) {
    return stats;
  }

  const token = await getSecret("fastmail-token");
  const session = await getSession(token);
  const mailboxes = await getMailboxes(session, token);

  let mailbox;
  try {
    mailbox = findMailbox(mailboxes, folder);
  } catch {
    stats.errors.push(`Folder "${folder}" not found`);
    return stats;
  }

  // Determine sync mode
  const savedState = full ? null : await getSyncState(SOURCE_TYPE, folder);
  let ids: string[];
  let newQueryState: string;

  if (savedState && savedState.mailboxId === mailbox.id) {
    // Incremental sync
    try {
      const changes = await queryChanges(session, token, mailbox.id, savedState.stateToken);
      ids = changes.added;
      newQueryState = changes.newQueryState;
    } catch (err) {
      if (err instanceof QueryChangesError) {
        // Fall back to full sync
        const result = await queryEmails(session, token, mailbox.id, limit);
        ids = result.ids;
        newQueryState = result.queryState;
      } else {
        throw err;
      }
    }
  } else {
    const result = await queryEmails(session, token, mailbox.id, limit);
    ids = result.ids;
    newQueryState = result.queryState;
  }

  if (ids.length === 0) {
    await saveSyncState(SOURCE_TYPE, folder, newQueryState, mailbox.id);
    return stats;
  }

  // Fetch emails
  const emails = await getEmails(session, token, ids);
  stats.fetched = emails.length;
  const events = emails.map(normalize);

  // Load rules and interests once for the batch
  const rules = await loadRules();
  const interests = await loadActiveInterests();
  const folderAction = classifyFolder(folder);

  // Process each event through the pipeline
  for (const event of events) {
    try {
      // 1. Ingest
      const ingestResult = await ingestEvent(event);
      if (ingestResult.alreadyExists) {
        stats.skipped++;
        continue;
      }
      stats.ingested++;

      // 2. Signal folder handling
      if (folderAction === "block" || folderAction === "process") {
        await handleSignalFolder(event, folderAction);
      }

      // 3. Entity resolution
      await resolveEventSender(
        ingestResult.sourceNoteId,
        event.fromEntity.address,
        event.fromEntity.displayName
      );

      // 4. Triage
      let triageResult;
      if (folderAction === "block") {
        triageResult = { action: "noise" as const, source: "rule" as const, rule_name: "not-for-willow folder" };
      } else if (folderAction === "process") {
        triageResult = { action: "flag" as const, source: "rule" as const, rule_name: "for-willow folder" };
      } else {
        triageResult = triage(event, rules);
      }
      stats.triaged[triageResult.action] = (stats.triaged[triageResult.action] ?? 0) + 1;
      await writeTriageResult(ingestResult.sourceNoteId, triageResult);

      // Skip noise for further processing
      if (triageResult.action === "noise") continue;

      // 5. Interest matching
      const interestMatches = matchInterests(event, interests);

      // 6. Classification
      if (doClassify) {
        const matchedInterests = interestMatches.map((m) => m.interest);
        const classResult = await classify(event, matchedInterests);
        stats.classified++;

        const [fact] = await sql`
          SELECT fact_id FROM app.fact WHERE source_note_id = ${ingestResult.sourceNoteId} LIMIT 1
        `;
        if (fact) {
          await writeClassification(fact.fact_id, classResult);

          // 7. Extraction
          const { needed, schema } = await needsExtraction(classResult.intentId, matchedInterests);
          if (needed && schema) {
            const extractResult = await extract(event, classResult.category, classResult.subcategory, schema);
            if (Object.keys(extractResult.data).length > 0) {
              stats.extracted++;
              await writeExtraction(fact.fact_id, extractResult.data);
            }
          }

          // 8. Dispatch
          if (doDispatch && interestMatches.length > 0) {
            const dispatchResult = await dispatch(event, fact.fact_id, interestMatches, null);
            stats.dispatched += dispatchResult.actionsExecuted;
          }
        }
      }
    } catch (err) {
      stats.errors.push(`${event.sourceRef}: ${(err as Error).message}`);
    }
  }

  await saveSyncState(SOURCE_TYPE, folder, newQueryState, mailbox.id);
  return stats;
}

/** Write triage result — same logic as fetch.ts but standalone */
async function writeTriageResult(
  sourceNoteId: string,
  triageResult: { action: string; source: string; rule_id?: string; rule_name?: string }
): Promise<void> {
  const existing = await sql`
    SELECT fact_id FROM app.fact WHERE source_note_id = ${sourceNoteId} LIMIT 1
  `;

  if (existing.length > 0) {
    await sql`
      UPDATE app.fact SET
        triage_action = ${triageResult.action},
        triage_source = ${triageResult.source},
        triage_rule_id = ${triageResult.rule_id ?? null}
      WHERE fact_id = ${existing[0].fact_id}
    `;
    return;
  }

  const [note] = await sql`
    SELECT title, from_factoid_id FROM app.source_note WHERE source_note_id = ${sourceNoteId}
  `;

  await sql`
    INSERT INTO app.fact (
      source_note_id, title, content, is_factoid,
      parent_factoid_id, memory_type, status, is_active,
      triage_action, triage_source, triage_rule_id
    ) VALUES (
      ${sourceNoteId}, ${note?.title ?? "Email"}, ${note?.title ?? "Email fact"},
      false, ${note?.from_factoid_id ?? null}, 'short_term', 'raw', true,
      ${triageResult.action}, ${triageResult.source}, ${triageResult.rule_id ?? null}
    )
  `;
}
