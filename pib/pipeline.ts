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
import { createLogger } from "./logger";
import type { CanonicalEvent } from "./jmap/types";

const SOURCE_TYPE = "email";
const log = createLogger("pib.pipeline");

export interface PipelineStats {
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

  if (folder.toLowerCase() === pibConfig.folders.notifications) {
    log.debug(`Skipping notification folder "${folder}"`);
    return stats;
  }

  log.info(`Syncing folder="${folder}" limit=${limit} full=${full} classify=${doClassify} dispatch=${doDispatch}`);

  const token = await getSecret("fastmail-token");
  const session = await getSession(token);
  const mailboxes = await getMailboxes(session, token);

  let mailbox;
  try {
    mailbox = findMailbox(mailboxes, folder);
  } catch {
    log.error(`Folder "${folder}" not found`);
    stats.errors.push(`Folder "${folder}" not found`);
    return stats;
  }

  log.info(`Mailbox: "${mailbox.name}" (id=${mailbox.id})`);

  // Determine sync mode
  const savedState = full ? null : await getSyncState(SOURCE_TYPE, folder);
  let ids: string[];
  let newQueryState: string;
  let syncMode: string;

  if (savedState && savedState.mailboxId === mailbox.id) {
    syncMode = "incremental";
    try {
      const changes = await queryChanges(session, token, mailbox.id, savedState.stateToken);
      ids = changes.added;
      newQueryState = changes.newQueryState;
      log.info(`Incremental sync: ${ids.length} new, ${changes.removed.length} removed`);
    } catch (err) {
      if (err instanceof QueryChangesError) {
        log.warn(`queryChanges failed (${err.jmapErrorType}), falling back to full sync`);
        syncMode = "full (fallback)";
        const result = await queryEmails(session, token, mailbox.id, limit);
        ids = result.ids;
        newQueryState = result.queryState;
      } else {
        throw err;
      }
    }
  } else {
    syncMode = full ? "full (forced)" : "full (first run)";
    const result = await queryEmails(session, token, mailbox.id, limit);
    ids = result.ids;
    newQueryState = result.queryState;
    log.info(`Full sync: ${ids.length} message IDs`);
  }

  if (ids.length === 0) {
    log.info(`No new emails in ${folder}`);
    await saveSyncState(SOURCE_TYPE, folder, newQueryState, mailbox.id);
    return stats;
  }

  // Fetch emails
  const emails = await getEmails(session, token, ids);
  stats.fetched = emails.length;
  log.info(`Fetched ${emails.length} emails from ${folder}`);
  const events = emails.map(normalize);

  // Load rules and interests once for the batch
  const rules = await loadRules();
  const interests = await loadActiveInterests();
  const folderAction = classifyFolder(folder);
  log.debug(`Loaded ${rules.length} triage rules, ${interests.length} active interests`);

  // Process each event through the pipeline
  for (const event of events) {
    const from = `${event.fromEntity.displayName} <${event.fromEntity.address}>`;
    const subject = event.subject ?? "(no subject)";

    try {
      // 1. Ingest
      const ingestResult = await ingestEvent(event);
      if (ingestResult.alreadyExists) {
        stats.skipped++;
        log.debug(`SKIP (exists) from=${from} subject="${subject}"`);
        continue;
      }
      stats.ingested++;

      // 2. Signal folder handling
      if (folderAction === "block" || folderAction === "process") {
        const signal = await handleSignalFolder(event, folderAction);
        log.info(`SIGNAL ${folderAction} from=${event.fromEntity.address}${signal.ruleId ? " rule_created" : " rule_exists"}`);
      }

      // 3. Entity resolution
      const resolved = await resolveEventSender(
        ingestResult.sourceNoteId,
        event.fromEntity.address,
        event.fromEntity.displayName
      );
      const entityLabel = resolved.isNew ? "NEW" : "existing";

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

      const triageLabel = `${triageResult.action}${triageResult.rule_name ? ` [${triageResult.rule_name}]` : " [default]"}`;

      // Log the email with all its pipeline results so far
      let logLine = `EMAIL from=${from} subject="${subject}" entity=${entityLabel} triage=${triageLabel}`;

      // Skip noise for further processing
      if (triageResult.action === "noise") {
        log.info(logLine);
        continue;
      }

      // 5. Interest matching
      const interestMatches = matchInterests(event, interests);
      if (interestMatches.length > 0) {
        const matchLabels = interestMatches.map((m) => `"${m.interest.name}"(${m.match_type}:${m.matched_on})`).join(", ");
        logLine += ` interests=[${matchLabels}]`;
      }

      // 6. Classification
      if (doClassify) {
        const matchedInterests = interestMatches.map((m) => m.interest);
        const classResult = await classify(event, matchedInterests);
        stats.classified++;
        logLine += ` class=${classResult.category}.${classResult.subcategory}(${classResult.confidence})`;

        const [fact] = await sql`
          SELECT fact_id FROM app.fact WHERE source_note_id = ${ingestResult.sourceNoteId} LIMIT 1
        `;
        if (fact) {
          await writeClassification(fact.fact_id, classResult);

          // 7. Extraction
          let extractedData: Record<string, unknown> | null = null;
          const { needed, schema } = await needsExtraction(classResult.intentId, matchedInterests);
          if (needed && schema) {
            const extractResult = await extract(event, classResult.category, classResult.subcategory, schema);
            if (Object.keys(extractResult.data).length > 0) {
              stats.extracted++;
              extractedData = extractResult.data;
              await writeExtraction(fact.fact_id, extractResult.data);
              const fields = Object.entries(extractResult.data)
                .filter(([, v]) => v !== null && v !== "null")
                .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                .join(", ");
              logLine += ` extracted={${fields}}`;
            }
          }

          // 8. Dispatch
          if (doDispatch && interestMatches.length > 0) {
            const dispatchResult = await dispatch(event, fact.fact_id, interestMatches, extractedData);
            stats.dispatched += dispatchResult.actionsExecuted;
            for (const ar of dispatchResult.actionResults) {
              logLine += ` action="${ar.interest}"→${ar.success ? "OK" : "FAILED:" + ar.error}`;
            }
          }
        }
      }

      log.info(logLine);
    } catch (err) {
      const msg = `${event.sourceRef}: ${(err as Error).message}`;
      stats.errors.push(msg);
      log.error(`FAILED from=${from} subject="${subject}" error="${(err as Error).message}"`);
    }
  }

  await saveSyncState(SOURCE_TYPE, folder, newQueryState, mailbox.id);

  // Summary line
  const triageSummary = Object.entries(stats.triaged).map(([k, v]) => `${k}=${v}`).join(" ");
  log.info(
    `DONE folder=${folder} sync=${syncMode} fetched=${stats.fetched} ingested=${stats.ingested} ` +
    `skipped=${stats.skipped} triage={${triageSummary}} classified=${stats.classified} ` +
    `extracted=${stats.extracted} dispatched=${stats.dispatched} errors=${stats.errors.length}`
  );

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
