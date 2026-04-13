import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "graphile-worker";
import { extractFromNote, extractWithLocalLLM, saveExtraction } from "../extractor/extract";
import { extractWithHaiku } from "../extractor/haiku";
import { checkSensitivity } from "../extractor/sensitivity";
import { generateEmbedding } from "../lmstudio/client";
import { sql } from "../db";

const COULD_NOT_INGEST_PATH = join(import.meta.dir, "..", "could-not-ingest.txt");

function shortPath(filePath: string): string {
  // Trim common prefix for readable logs
  return filePath.replace(/^\/Users\/vineel\/Dropbox\/VineelerNotes\//, "");
}

const ingestNote: Task = async (payload, helpers) => {
  const { filePath } = payload as { filePath: string };
  const short = shortPath(filePath);

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    console.log(`[ingest] SKIP ${short} — file not found`);
    return;
  }

  const rawText = await file.text();
  if (rawText.trim().length === 0) {
    console.log(`[ingest] SKIP ${short} — empty file`);
    return;
  }

  const sizeKb = (rawText.length / 1024).toFixed(1);
  console.log(`[ingest] START ${short} (${sizeKb}KB)`);

  // 1. Try local LLM
  let result;
  try {
    result = await extractFromNote(filePath, rawText);

    if (result.skipped) {
      console.log(`[ingest] SKIP ${short} — content unchanged`);
    } else if (result.factCount === 0) {
      console.log(`[ingest] DONE ${short} — no facts extracted (local)`);
    } else {
      console.log(`[ingest] OK ${short} — ${result.factCount} facts via local LLM`);
    }
  } catch (localErr) {
    const localMsg = localErr instanceof Error ? localErr.message : String(localErr);
    // Categorize the failure
    const reason = localMsg.includes("timed out") ? "timeout"
      : localMsg.includes("context length") ? "too_large"
      : localMsg.includes("JSON") || localMsg.includes("Parse") ? "bad_json"
      : localMsg.includes("No models loaded") ? "model_unloaded"
      : "unknown";
    console.log(`[ingest] LOCAL_FAIL ${short} — ${reason}: ${localMsg}`);

    // 2. Check sensitivity before falling back to cloud
    const sensitivity = checkSensitivity(rawText);
    if (sensitivity.isSensitive) {
      console.log(`[ingest] SENSITIVE ${short} — ${sensitivity.reasons.join(", ")}`);
      await appendFile(COULD_NOT_INGEST_PATH, `${new Date().toISOString()}\t${filePath}\tSENSITIVE: ${sensitivity.reasons.join(", ")}\n`);
      return;
    }

    console.log(`[ingest] SENSITIVITY_CLEAR ${short} — no sensitive patterns, trying Haiku`);

    // 3. Not sensitive — fall back to Haiku
    try {
      const { parsed } = await extractWithHaiku(rawText, filePath);
      result = await saveExtraction(filePath, rawText, parsed, "claude-haiku-4-5-20251001");

      if (result.factCount === 0) {
        console.log(`[ingest] DONE ${short} — no facts extracted (haiku)`);
      } else {
        console.log(`[ingest] OK ${short} — ${result.factCount} facts via Haiku`);
      }
    } catch (haikuErr) {
      const haikuMsg = haikuErr instanceof Error ? haikuErr.message : String(haikuErr);
      console.log(`[ingest] HAIKU_FAIL ${short} — ${haikuMsg}`);
      await appendFile(COULD_NOT_INGEST_PATH, `${new Date().toISOString()}\t${filePath}\tBOTH_FAILED: local=${localMsg} haiku=${haikuMsg}\n`);
      return;
    }
  }

  if (!result.skipped && result.factCount > 0) {
    const facts = await sql`
      SELECT fact_id FROM app.fact
      WHERE source_note_id = ${result.sourceNoteId}
        AND is_active = true
        AND embedding IS NULL
    `;

    for (const fact of facts) {
      await helpers.addJob("generate_embeddings", { factId: fact.fact_id }, {
        maxAttempts: 3,
      });
    }

    console.log(`[ingest] EMBED_QUEUED ${short} — ${facts.length} embeddings`);
  }
};

const generateEmbeddings: Task = async (payload, helpers) => {
  const { factId } = payload as { factId: string };

  const [fact] = await sql`
    SELECT fact_id, content, qe_text
    FROM app.fact
    WHERE fact_id = ${factId} AND is_active = true
  `;

  if (!fact) {
    helpers.logger.warn(`Fact ${factId} not found or inactive, skipping embedding`);
    return;
  }

  // Combine content and qe_text for richer embedding
  const textToEmbed = [fact.content, fact.qe_text].filter(Boolean).join("\n");

  const { embedding } = await generateEmbedding(textToEmbed);

  await sql`
    UPDATE app.fact
    SET embedding = ${JSON.stringify(embedding)}::vector
    WHERE fact_id = ${factId}
  `;

  helpers.logger.info(`Generated embedding for fact ${factId}`);
};

const processFact: Task = async (payload, helpers) => {
  const { queueId } = payload as { queueId: string };

  // Stub — mark as done for now. Real processor (Stage 2) is deferred.
  await sql`
    UPDATE app.fact_queue
    SET status = 'done', last_attempt_at = now(), attempts = attempts + 1
    WHERE queue_id = ${queueId}
  `;

  helpers.logger.info(`[stub] Marked queue item ${queueId} as done (processor not yet implemented)`);
};

export const tasks = {
  ingest_note: ingestNote,
  generate_embeddings: generateEmbeddings,
  process_fact: processFact,
};
