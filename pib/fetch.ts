/**
 * PIB fetch CLI — sync emails from Fastmail via JMAP, ingest, resolve entities,
 * triage, classify, and extract.
 *
 * Usage:
 *   bun run pib:fetch [options]
 *
 * Options:
 *   --folder <name>   Mailbox to sync (default: inbox)
 *   --limit <n>       Max emails on full sync (default: 50)
 *   --full            Force full sync (ignore saved state)
 *   --triage          Run entity resolution + triage rules after ingest
 *   --classify        Run classification + extraction (implies --triage)
 *   --dry-run         Fetch and display, don't write to DB
 */

import { getSecret, sql, pibConfig } from "./config";
import { getSession, getMailboxes, findMailbox } from "./jmap/session";
import type { JMAPMailbox } from "./jmap/session";
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
import type { InterestMatch } from "./interest-matcher";
import { classify, writeClassification } from "./classify";
import { needsExtraction, extract, writeExtraction } from "./extract";
import { dispatch } from "./dispatch";
import type { CanonicalEvent } from "./jmap/types";
import type { TriageResult } from "./triage/types";

const SOURCE_TYPE = "email";

interface Args {
  folder: string;
  limit: number;
  full: boolean;
  doTriage: boolean;
  doClassify: boolean;
  doDispatch: boolean;
  dryRun: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let folder = "inbox";
  let limit = 50;
  let full = false;
  let doTriage = false;
  let doClassify = false;
  let doDispatch = false;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--folder" && args[i + 1]) {
      folder = args[i + 1];
      i++;
    } else if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      if (isNaN(limit) || limit < 1) {
        console.error("--limit must be a positive integer");
        process.exit(1);
      }
      i++;
    } else if (args[i] === "--full") {
      full = true;
    } else if (args[i] === "--triage") {
      doTriage = true;
    } else if (args[i] === "--classify") {
      doClassify = true;
      doTriage = true;
    } else if (args[i] === "--dispatch") {
      doDispatch = true;
      doClassify = true;
      doTriage = true; // --dispatch implies --classify implies --triage
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`Usage: bun run pib:fetch [options]

Options:
  --folder <name>   Mailbox to sync (default: inbox)
  --limit <n>       Max emails on full sync (default: 50)
  --full            Force full sync (ignore saved state)
  --triage          Run entity resolution + triage after ingest
  --classify        Run classification + extraction (implies --triage)
  --dispatch        Run dispatch + action execution (implies --classify)
  --dry-run         Fetch and display, don't write to DB
  --help            Show this help`);
      process.exit(0);
    }
  }

  return { folder, limit, full, doTriage, doClassify, doDispatch, dryRun };
}

interface ProcessResult {
  event: CanonicalEvent;
  sourceNoteId: string;
  alreadyExists: boolean;
  entityFactoidId?: string;
  entityIsNew?: boolean;
  triageResult?: TriageResult;
  signalAction?: string;
  interestMatches?: InterestMatch[];
  classification?: { category: string; subcategory: string; confidence: number };
  extracted?: Record<string, unknown>;
  dispatched?: { actionsExecuted: number; results: { interest: string; success: boolean; error?: string }[] };
}

/**
 * Process a batch of events through the pipeline:
 * ingest → resolve → triage → interest check → classify → extract
 */
async function processEvents(
  events: CanonicalEvent[],
  folder: string,
  doTriage: boolean,
  doClassify: boolean,
  doDispatch: boolean,
  dryRun: boolean
): Promise<ProcessResult[]> {
  const rules = doTriage ? await loadRules() : [];
  const interests = (doTriage || doClassify) ? await loadActiveInterests() : [];
  const folderAction = classifyFolder(folder);
  const results: ProcessResult[] = [];

  for (const event of events) {
    // 1. Ingest to source_note
    let sourceNoteId: string;
    let alreadyExists: boolean;

    if (dryRun) {
      sourceNoteId = "dry-run";
      alreadyExists = false;
    } else {
      const ingestResult = await ingestEvent(event);
      sourceNoteId = ingestResult.sourceNoteId;
      alreadyExists = ingestResult.alreadyExists;
    }

    const result: ProcessResult = { event, sourceNoteId, alreadyExists };

    // 2. Signal folder handling
    if (folderAction === "block" || folderAction === "process") {
      result.signalAction = folderAction;
      if (!dryRun) {
        const signal = await handleSignalFolder(event, folderAction);
        if (signal.ruleId) {
          console.log(
            `  Signal: ${folderAction} rule created for ${signal.address}`
          );
        }
      }
    }

    // 3. Entity resolution (only for newly ingested, non-dry-run)
    if (!dryRun && !alreadyExists) {
      const resolved = await resolveEventSender(
        sourceNoteId,
        event.fromEntity.address,
        event.fromEntity.displayName
      );
      result.entityFactoidId = resolved.factoidId;
      result.entityIsNew = resolved.isNew;
    }

    // 4. Triage
    if (doTriage) {
      if (folderAction === "block") {
        result.triageResult = { action: "noise", source: "rule", rule_name: "not-for-willow folder" };
      } else if (folderAction === "process") {
        result.triageResult = { action: "flag", source: "rule", rule_name: "for-willow folder" };
      } else {
        result.triageResult = triage(event, rules);
      }

      if (!dryRun && !alreadyExists && result.triageResult) {
        await writeTriageResult(sourceNoteId, result.triageResult);
      }
    }

    // 5. Interest matching (no LLM)
    if (interests.length > 0) {
      result.interestMatches = matchInterests(event, interests);
    }

    // 6. Classification (LLM) — skip noise
    if (doClassify && !dryRun && !alreadyExists && result.triageResult?.action !== "noise") {
      const matchedInterests = (result.interestMatches ?? []).map((m) => m.interest);
      const classResult = await classify(event, matchedInterests);
      result.classification = {
        category: classResult.category,
        subcategory: classResult.subcategory,
        confidence: classResult.confidence,
      };

      // Get the fact ID for this source_note
      const [fact] = await sql`
        SELECT fact_id FROM app.fact WHERE source_note_id = ${sourceNoteId} LIMIT 1
      `;
      if (fact) {
        await writeClassification(fact.fact_id, classResult);

        // 7. Extraction (conditional, LLM)
        const { needed, schema } = await needsExtraction(
          classResult.intentId,
          matchedInterests
        );
        if (needed && schema) {
          const extractResult = await extract(
            event,
            classResult.category,
            classResult.subcategory,
            schema
          );
          if (Object.keys(extractResult.data).length > 0) {
            result.extracted = extractResult.data;
            await writeExtraction(fact.fact_id, extractResult.data);
          }
        }

        // 8. Dispatch — execute interest actions via claude -p
        if (doDispatch && (result.interestMatches ?? []).length > 0) {
          const dispatchResult = await dispatch(
            event,
            fact.fact_id,
            result.interestMatches!,
            result.extracted ?? null
          );
          result.dispatched = {
            actionsExecuted: dispatchResult.actionsExecuted,
            results: dispatchResult.actionResults,
          };
        }
      }
    }

    results.push(result);
  }

  return results;
}

/**
 * Create a fact row for an email and record its triage result.
 */
async function writeTriageResult(
  sourceNoteId: string,
  triageResult: TriageResult
): Promise<void> {
  // Check if a fact already exists for this source_note
  const existing = await sql`
    SELECT fact_id FROM app.fact WHERE source_note_id = ${sourceNoteId} LIMIT 1
  `;

  if (existing.length > 0) {
    // Update existing fact
    await sql`
      UPDATE app.fact SET
        triage_action = ${triageResult.action},
        triage_source = ${triageResult.source === "rule" ? "rule" : "rule"},
        triage_rule_id = ${triageResult.rule_id ?? null}
      WHERE fact_id = ${existing[0].fact_id}
    `;
    return;
  }

  // Get source_note title for the fact
  const [note] = await sql`
    SELECT title, from_factoid_id FROM app.source_note
    WHERE source_note_id = ${sourceNoteId}
  `;

  await sql`
    INSERT INTO app.fact (
      source_note_id, title, content, is_factoid,
      parent_factoid_id, memory_type, status, is_active,
      triage_action, triage_source, triage_rule_id
    ) VALUES (
      ${sourceNoteId},
      ${note?.title ?? "Email"},
      ${note?.title ?? "Email fact"},
      false,
      ${note?.from_factoid_id ?? null},
      'short_term', 'raw', true,
      ${triageResult.action},
      ${triageResult.source === "rule" ? "rule" : "rule"},
      ${triageResult.rule_id ?? null}
    )
  `;
}

function printResults(results: ProcessResult[]): void {
  const triageCounts: Record<string, number> = {};

  for (const r of results) {
    const event = r.event;
    const date = new Date(event.receivedAt).toLocaleString();

    console.log(
      `  From:    ${event.fromEntity.displayName} <${event.fromEntity.address}>`
    );
    console.log(`  Subject: ${event.subject ?? "(no subject)"}`);
    console.log(`  Date:    ${date}`);

    if (r.entityIsNew !== undefined) {
      console.log(`  Entity:  ${r.entityIsNew ? "NEW" : "existing"} factoid`);
    }

    if (r.triageResult) {
      const tr = r.triageResult;
      const label = `${tr.action.toUpperCase()}${tr.rule_name ? ` [${tr.rule_name}]` : " [default]"}`;
      console.log(`  Triage:  ${label}`);
      triageCounts[tr.action] = (triageCounts[tr.action] ?? 0) + 1;
    }

    if (r.alreadyExists) {
      console.log(`  Status:  already ingested (skipped)`);
    }

    if (r.interestMatches && r.interestMatches.length > 0) {
      for (const m of r.interestMatches) {
        console.log(`  Interest: "${m.interest.name}" (${m.match_type}: ${m.matched_on})`);
      }
    }

    if (r.classification) {
      console.log(`  Class:   ${r.classification.category}.${r.classification.subcategory} (${r.classification.confidence})`);
    }

    if (r.extracted) {
      const fields = Object.entries(r.extracted)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ");
      if (fields) console.log(`  Extract: ${fields}`);
    }

    if (r.dispatched && r.dispatched.results.length > 0) {
      for (const dr of r.dispatched.results) {
        console.log(`  Action:  "${dr.interest}" → ${dr.success ? "OK" : "FAILED: " + dr.error}`);
      }
    }

    if (r.signalAction) {
      console.log(`  Signal:  ${r.signalAction}`);
    }

    console.log();
  }

  if (Object.keys(triageCounts).length > 0) {
    console.log("--- Triage Summary ---");
    for (const [action, count] of Object.entries(triageCounts).sort()) {
      console.log(`  ${action}: ${count}`);
    }
    console.log();
  }
}

async function fetchAndProcess(
  session: { accountId: string; apiUrl: string; downloadUrl: string },
  token: string,
  folder: string,
  mailboxId: string,
  ids: string[],
  doTriage: boolean,
  doClassify: boolean,
  doDispatch: boolean,
  dryRun: boolean
): Promise<void> {
  if (ids.length === 0) return;

  console.log("Fetching full email content...");
  const emails = await getEmails(session, token, ids);
  console.log(`  Fetched ${emails.length} emails`);

  const events = emails.map(normalize);

  console.log(`\n--- Emails (${folder}) ---\n`);

  const results = await processEvents(events, folder, doTriage, doClassify, doDispatch, dryRun);
  printResults(results);

  const ingested = results.filter((r) => !r.alreadyExists && !dryRun).length;
  const skipped = results.filter((r) => r.alreadyExists).length;

  if (dryRun) {
    console.log(`[dry-run] Would process ${events.length} emails.`);
  } else {
    console.log(`Done: ${ingested} ingested, ${skipped} already existed.`);
  }
}

async function fullSync(
  session: { accountId: string; apiUrl: string; downloadUrl: string },
  token: string,
  folder: string,
  mailboxId: string,
  limit: number,
  doTriage: boolean,
  doClassify: boolean,
  doDispatch: boolean,
  dryRun: boolean
): Promise<void> {
  console.log(`Querying ${limit} most recent emails...`);
  const { ids, queryState } = await queryEmails(session, token, mailboxId, limit);
  console.log(`  Got ${ids.length} message IDs`);

  if (ids.length === 0) {
    console.log("No emails found.");
    if (!dryRun) {
      await saveSyncState(SOURCE_TYPE, folder, queryState, mailboxId);
    }
    return;
  }

  await fetchAndProcess(session, token, folder, mailboxId, ids, doTriage, doClassify, doDispatch, dryRun);

  if (!dryRun) {
    await saveSyncState(SOURCE_TYPE, folder, queryState, mailboxId);
  }
}

async function main() {
  const { folder, limit, full, doTriage, doClassify, doDispatch, dryRun } = parseArgs();

  // Skip the willow notification folder
  if (folder.toLowerCase() === pibConfig.folders.notifications) {
    console.error(
      `Skipping "${folder}" — this is Willow's notification folder (not for ingestion).`
    );
    process.exit(1);
  }

  const token = await getSecret("fastmail-token");

  console.log("Fetching JMAP session...");
  const session = await getSession(token);

  console.log("Listing mailboxes...");
  const mailboxes = await getMailboxes(session, token);
  const mailbox = findMailbox(mailboxes, folder);
  console.log(`  Using mailbox: "${mailbox.name}" (id: ${mailbox.id})`);

  const savedState = full ? null : await getSyncState(SOURCE_TYPE, folder);

  if (savedState && savedState.mailboxId === mailbox.id) {
    console.log(`Checking for new emails since last sync...`);

    let added: string[];
    let removed: string[];
    let newQueryState: string;

    try {
      const changes = await queryChanges(
        session,
        token,
        mailbox.id,
        savedState.stateToken
      );
      added = changes.added;
      removed = changes.removed;
      newQueryState = changes.newQueryState;
    } catch (err) {
      if (err instanceof QueryChangesError) {
        console.log(
          `  Server can't compute changes (${err.jmapErrorType}), falling back to full sync...`
        );
        return fullSync(session, token, folder, mailbox.id, limit, doTriage, doClassify, doDispatch, dryRun);
      }
      throw err;
    }

    if (added.length === 0 && removed.length === 0) {
      console.log("  No changes since last sync.");
      if (!dryRun) {
        await saveSyncState(SOURCE_TYPE, folder, newQueryState, mailbox.id);
      }
      return;
    }

    console.log(`  ${added.length} new, ${removed.length} removed since last sync`);

    if (added.length > 0) {
      await fetchAndProcess(session, token, folder, mailbox.id, added, doTriage, doClassify, doDispatch, dryRun);
    }

    if (removed.length > 0) {
      console.log(`  (${removed.length} emails were removed from this folder)`);
    }

    if (!dryRun) {
      await saveSyncState(SOURCE_TYPE, folder, newQueryState, mailbox.id);
    }
  } else {
    if (savedState && savedState.mailboxId !== mailbox.id) {
      console.log("  Mailbox ID changed, doing full sync...");
    }
    await fullSync(session, token, folder, mailbox.id, limit, doTriage, doClassify, doDispatch, dryRun);
  }

  await sql.end();
}

main().catch(async (err) => {
  console.error("Fatal:", err.message);
  await sql.end();
  process.exit(1);
});
