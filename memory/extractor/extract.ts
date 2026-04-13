import { sql } from "../db";
import { config } from "../config";
import { chatCompletion, ensureModelLoaded } from "../lmstudio/client";
import { EXTRACTION_SYSTEM_PROMPT, buildUserPrompt } from "./prompts";

interface ExtractedFact {
  title: string;
  content: string;
  action: "remember" | "verify_world" | "verify_human";
  keywords: string[];
  entities: string[];
  qe_text: string;
  confidence: number;
  is_sensitive: boolean;
  is_factoid: boolean;
  factoid_type: string | null;
  expires_type: string;
}

interface ExtractionResult {
  sourceNoteId: string;
  factCount: number;
  skipped: boolean;
}

async function computeHash(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Call the local LLM to extract facts. Throws on failure (timeout, context too large, bad JSON). */
export async function extractWithLocalLLM(
  rawText: string,
  filePath?: string,
): Promise<{ parsed: unknown }> {
  await ensureModelLoaded();
  const start = Date.now();
  const { parsed, usage } = await chatCompletion([
    { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(rawText, filePath) },
  ]);
  const durationSec = (Date.now() - start) / 1000;
  if (usage) {
    const totalTokens = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
    const tokPerSec = durationSec > 0 ? (totalTokens / durationSec).toFixed(1) : "?";
    console.log(`[lmstudio] ${usage.prompt_tokens}in/${usage.completion_tokens}out tokens, ${durationSec.toFixed(1)}s, ${tokPerSec} tok/s`);
  }
  return { parsed };
}

/** Save extraction results (from any LLM) to the database. */
export async function saveExtraction(
  filePath: string,
  rawText: string,
  parsed: unknown,
  extractedBy: string = "local",
): Promise<ExtractionResult> {
  const contentHash = await computeHash(rawText);

  // Check for existing source_note with this filename
  let existing = await sql`
    SELECT source_note_id, content_hash
    FROM app.source_note
    WHERE filename = ${filePath}
    LIMIT 1
  `;

  // Skip if content hasn't changed
  if (existing.length > 0 && existing[0].content_hash === contentHash) {
    console.log(`[extractor] Skipping ${filePath} — content unchanged`);
    return { sourceNoteId: existing[0].source_note_id, factCount: 0, skipped: true };
  }

  // If no match by filename, check if this is a rename (same content, different filename)
  if (existing.length === 0) {
    const byHash = await sql`
      SELECT source_note_id, content_hash, filename
      FROM app.source_note
      WHERE content_hash = ${contentHash}
      LIMIT 1
    `;
    if (byHash.length > 0) {
      console.log(`[extractor] Rename detected: ${byHash[0].filename} → ${filePath}`);
      await sql`
        UPDATE app.source_note
        SET filename = ${filePath},
            title = ${filePath.split("/").pop() ?? filePath}
        WHERE source_note_id = ${byHash[0].source_note_id}
      `;
      // Reactivate facts in case the unlink handler already deactivated them
      const [reactivated] = await sql`
        UPDATE app.fact
        SET is_active = true, updated_at = now()
        WHERE source_note_id = ${byHash[0].source_note_id} AND is_active = false
        RETURNING count(*) OVER () AS cnt
      `;
      if (reactivated?.cnt > 0) {
        console.log(`[extractor] Reactivated ${reactivated.cnt} facts after rename`);
      }
      return { sourceNoteId: byHash[0].source_note_id, factCount: 0, skipped: true };
    }
  }

  // If content changed, deactivate old facts (v1: nuke-and-replace)
  if (existing.length > 0) {
    console.log(`[extractor] Note updated: ${filePath} — deactivating old facts`);
    await sql`
      UPDATE app.fact
      SET is_active = false, updated_at = now()
      WHERE source_note_id = ${existing[0].source_note_id}
        AND is_active = true
    `;
  }

  const { summary, facts } = validateExtraction(parsed);

  // Upsert source_note
  const [sourceNote] = existing.length > 0
    ? await sql`
        UPDATE app.source_note
        SET raw_text = ${rawText},
            content_hash = ${contentHash},
            title = ${filePath.split("/").pop() ?? filePath},
            summary = ${summary},
            extracted_by = ${extractedBy}
        WHERE source_note_id = ${existing[0].source_note_id}
        RETURNING source_note_id
      `
    : await sql`
        INSERT INTO app.source_note (source_type, filename, raw_text, content_hash, title, summary, extracted_by)
        VALUES ('file', ${filePath}, ${rawText}, ${contentHash}, ${filePath.split("/").pop() ?? filePath}, ${summary}, ${extractedBy})
        RETURNING source_note_id
      `;

  const sourceNoteId = sourceNote.source_note_id;

  if (facts.length === 0) {
    console.log(`[extractor] No facts extracted from ${filePath}`);
    return { sourceNoteId, factCount: 0, skipped: false };
  }

  // Insert facts and queue entries
  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i];
    const [inserted] = await sql`
      INSERT INTO app.fact (
        source_note_id, source_ordinal, title, content,
        keywords, qe_text, confidence, memory_type, status,
        is_factoid, factoid_type, expires_type
      ) VALUES (
        ${sourceNoteId}, ${i + 1}, ${fact.title}, ${fact.content},
        ${fact.keywords}, ${fact.qe_text}, ${fact.confidence},
        'short_term', 'raw',
        ${fact.is_factoid}, ${fact.factoid_type}, ${fact.expires_type}
      )
      RETURNING fact_id
    `;

    await sql`
      INSERT INTO app.fact_queue (fact_id, action)
      VALUES (${inserted.fact_id}, ${fact.action})
    `;
  }

  console.log(`[extractor] Extracted ${facts.length} facts from ${filePath}`);
  return { sourceNoteId, factCount: facts.length, skipped: false };
}

/** Convenience: try local LLM and save in one step. */
export async function extractFromNote(
  filePath: string,
  rawText: string,
): Promise<ExtractionResult> {
  console.log(`[extractor] Extracting facts from ${filePath}...`);
  const { parsed } = await extractWithLocalLLM(rawText, filePath);
  return saveExtraction(filePath, rawText, parsed, config.lmstudio.chatModel);
}

function validateExtraction(parsed: unknown): { summary: string | null; facts: ExtractedFact[] } {
  if (!parsed || typeof parsed !== "object") return { summary: null, facts: [] };

  const obj = parsed as Record<string, unknown>;

  // Summary: abbreviated key "s"
  const summary = typeof obj.s === "string" ? obj.s : null;

  // Facts: abbreviated key "f", fall back to "facts" for robustness
  const rawFacts = Array.isArray(obj.f) ? obj.f : Array.isArray(obj.facts) ? obj.facts : [];

  const facts = rawFacts
    .filter((f): f is Record<string, unknown> => f != null && typeof f === "object")
    .map((f) => ({
      // Map abbreviated keys, fall back to full keys
      title: String(f.t ?? f.title ?? "Untitled"),
      content: String(f.x ?? f.text ?? f.content ?? ""),
      action: validateAction(f.a ?? f.action),
      keywords: toStringArray(f.k ?? f.keywords),
      entities: toStringArray(f.en ?? f.entities),
      qe_text: String(f.q ?? f.qe_text ?? ""),
      confidence: toConfidence(f.c ?? f.confidence),
      is_sensitive: (f.sn ?? f.is_sensitive) === true,
      is_factoid: (f.r ?? f.is_root ?? f.is_factoid) === true,
      factoid_type: validateFactoidType(f.rt ?? f.root_type ?? f.factoid_type),
      expires_type: validateExpiresType(f.e ?? f.expires_type),
    }))
    .filter((f) => f.content.length > 0);

  return { summary, facts };
}

function validateAction(val: unknown): "remember" | "verify_world" | "verify_human" {
  if (val === "verify_world" || val === "verify_human") return val;
  return "remember";
}

function validateFactoidType(val: unknown): string | null {
  const valid = ["Person", "Place", "Organization", "Event", "Concept", "Product"];
  if (typeof val === "string" && valid.includes(val)) return val;
  return null;
}

function validateExpiresType(val: unknown): string {
  if (val === "weighted" || val === "date") return val;
  return "never";
}

function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  return [];
}

function toConfidence(val: unknown): number {
  if (typeof val === "number") return Math.max(0, Math.min(1, val));
  return 0.5;
}
