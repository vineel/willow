import { sql } from "../db";
import { config } from "../config";
import { chatCompletion, ensureModelLoaded } from "../lmstudio/client";
import { EXTRACTION_SYSTEM_PROMPT, buildUserPrompt } from "./prompts";

// ============================================================================
// Types — mirror the new entity-first extraction schema (see prompts.ts)
// ============================================================================

const VALID_FACTOID_TYPES = [
  "Person",
  "Place",
  "Organization",
  "Event",
  "Concept",
  "Product",
  "Account",
  "Unknown",
] as const;

interface ExtractedEntity {
  localId: string;             // e1, e2, ... — valid only within this extraction
  title: string;
  factoid_type: string;        // one of VALID_FACTOID_TYPES
  confidence: number;
}

interface ExtractedFact {
  title: string;
  content: string;
  primary: string | null;      // local entity id
  mentions: string[];          // local entity ids
  action: "remember" | "verify_world" | "verify_human";
  keywords: string[];
  qe_text: string;
  confidence: number;
  is_sensitive: boolean;
  expires_type: string;
}

interface ExtractedRelationship {
  from: string;                // local entity id
  to: string;                  // local entity id
  type: string;
  inverse: string | null;
}

interface Extraction {
  summary: string | null;
  entities: ExtractedEntity[];
  facts: ExtractedFact[];
  relationships: ExtractedRelationship[];
}

interface ExtractionResult {
  sourceNoteId: string;
  entityCount: number;
  factCount: number;
  relCount: number;
  skipped: boolean;
}

// ============================================================================
// JSON schema for LM Studio structured output
// ============================================================================

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };

const EXTRACTION_JSON_SCHEMA = {
  name: "willow_extraction",
  schema: {
    type: "object",
    required: ["s", "e", "f", "r"],
    properties: {
      s: nullableString,
      e: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "t", "rt", "c"],
          properties: {
            id: { type: "string" },
            t: { type: "string" },
            rt: { type: "string", enum: VALID_FACTOID_TYPES as unknown as string[] },
            c: { type: "number" },
          },
        },
      },
      f: {
        type: "array",
        items: {
          type: "object",
          required: ["t", "x", "primary", "mentions", "a", "k", "q", "c", "sn", "e"],
          properties: {
            t: { type: "string" },
            x: { type: "string" },
            primary: nullableString,
            mentions: { type: "array", items: { type: "string" } },
            a: { type: "string", enum: ["remember", "verify_world", "verify_human"] },
            k: { type: "array", items: { type: "string" } },
            q: { type: "string" },
            c: { type: "number" },
            sn: { type: "boolean" },
            e: { type: "string", enum: ["never", "weighted", "date"] },
          },
        },
      },
      r: {
        type: "array",
        items: {
          type: "object",
          required: ["from", "to", "type", "inverse"],
          properties: {
            from: { type: "string" },
            to: { type: "string" },
            type: { type: "string" },
            inverse: nullableString,
          },
        },
      },
    },
  },
};

// ============================================================================
// LLM call
// ============================================================================

async function computeHash(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Call the local LLM with the new entity-first schema. Throws on failure. */
export async function extractWithLocalLLM(
  rawText: string,
  filePath?: string,
): Promise<{ parsed: unknown }> {
  await ensureModelLoaded();
  const start = Date.now();
  const { parsed, usage } = await chatCompletion(
    [
      { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(rawText, filePath) },
    ],
    { jsonSchema: EXTRACTION_JSON_SCHEMA },
  );
  const durationSec = (Date.now() - start) / 1000;
  if (usage) {
    const totalTokens = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
    const tokPerSec = durationSec > 0 ? (totalTokens / durationSec).toFixed(1) : "?";
    console.log(
      `[lmstudio] ${usage.prompt_tokens}in/${usage.completion_tokens}out tokens, ${durationSec.toFixed(1)}s, ${tokPerSec} tok/s`,
    );
  }
  return { parsed };
}

// ============================================================================
// Factoid resolution helper
// ============================================================================

/**
 * Find an active factoid with the same type + exact lowercased title, or
 * insert a new one. Returns the fact_id and whether we created it.
 * Mirrors the conservative on-insert dedupe used previously at extract.ts:159–175.
 */
async function resolveOrCreateFactoid(
  title: string,
  factoidType: string,
  sourceNoteId: string,
  sourceOrdinal: number,
  confidence: number,
): Promise<{ factId: string; created: boolean }> {
  const normalized = title.toLowerCase().trim();

  const [existing] = await sql`
    SELECT fact_id FROM app.fact
    WHERE is_active = true
      AND is_factoid = true
      AND factoid_type = ${factoidType}
      AND lower(btrim(title)) = ${normalized}
    LIMIT 1
  `;
  if (existing) return { factId: existing.fact_id, created: false };

  const [inserted] = await sql`
    INSERT INTO app.fact (
      source_note_id, source_ordinal, title, content,
      keywords, qe_text, confidence, memory_type, status,
      is_factoid, factoid_type, parent_factoid_id, expires_type
    ) VALUES (
      ${sourceNoteId}, ${sourceOrdinal}, ${title}, ${title},
      ${[] as string[]}, ${""}, ${confidence}, 'short_term', 'raw',
      true, ${factoidType}, null, 'never'
    )
    RETURNING fact_id
  `;
  return { factId: inserted.fact_id, created: true };
}

// ============================================================================
// saveExtraction — persist entity-first extraction to DB
// ============================================================================

export async function saveExtraction(
  filePath: string,
  rawText: string,
  parsed: unknown,
  extractedBy: string = "local",
  options: { force?: boolean } = {},
): Promise<ExtractionResult> {
  const { force = false } = options;
  const contentHash = await computeHash(rawText);

  let existing = await sql`
    SELECT source_note_id, content_hash
    FROM app.source_note
    WHERE filename = ${filePath}
    LIMIT 1
  `;

  if (!force && existing.length > 0 && existing[0].content_hash === contentHash) {
    console.log(`[extractor] Skipping ${filePath} — content unchanged`);
    return {
      sourceNoteId: existing[0].source_note_id,
      entityCount: 0,
      factCount: 0,
      relCount: 0,
      skipped: true,
    };
  }

  // Rename detection: same content, different filename
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
      const [reactivated] = await sql`
        UPDATE app.fact
        SET is_active = true, updated_at = now()
        WHERE source_note_id = ${byHash[0].source_note_id} AND is_active = false
        RETURNING count(*) OVER () AS cnt
      `;
      if (reactivated?.cnt > 0) {
        console.log(`[extractor] Reactivated ${reactivated.cnt} facts after rename`);
      }
      return {
        sourceNoteId: byHash[0].source_note_id,
        entityCount: 0,
        factCount: 0,
        relCount: 0,
        skipped: true,
      };
    }
  }

  // Content changed (or force) → deactivate this note's old NON-FACTOID rows.
  // We deliberately leave factoid rows (is_factoid=true) active: an entity
  // factoid may have been minted by this note but now has children from
  // other notes, and re-extraction will dedupe back onto it via
  // resolveOrCreateFactoid. Orphaned factoids can be cleaned up later.
  if (existing.length > 0) {
    console.log(`[extractor] Note updated: ${filePath} — deactivating old facts`);
    await sql`
      UPDATE app.fact
      SET is_active = false, updated_at = now()
      WHERE source_note_id = ${existing[0].source_note_id}
        AND is_active = true
        AND is_factoid = false
    `;
  }

  const extraction = validateExtraction(parsed);

  // Upsert source_note
  const [sourceNote] = existing.length > 0
    ? await sql`
        UPDATE app.source_note
        SET raw_text = ${rawText},
            content_hash = ${contentHash},
            title = ${filePath.split("/").pop() ?? filePath},
            summary = ${extraction.summary},
            extracted_by = ${extractedBy}
        WHERE source_note_id = ${existing[0].source_note_id}
        RETURNING source_note_id
      `
    : await sql`
        INSERT INTO app.source_note (source_type, filename, raw_text, content_hash, title, summary, extracted_by)
        VALUES ('file', ${filePath}, ${rawText}, ${contentHash}, ${filePath.split("/").pop() ?? filePath}, ${extraction.summary}, ${extractedBy})
        RETURNING source_note_id
      `;

  const sourceNoteId = sourceNote.source_note_id;

  if (extraction.entities.length === 0 && extraction.facts.length === 0) {
    console.log(`[extractor] No entities or facts extracted from ${filePath}`);
    return { sourceNoteId, entityCount: 0, factCount: 0, relCount: 0, skipped: false };
  }

  // ------------------------------------------------------------------
  // 1. Resolve entities → local id → fact_id
  // ------------------------------------------------------------------
  const entityFactIds = new Map<string, string>();
  let createdEntities = 0;
  let reusedEntities = 0;
  let ordinal = 1;

  for (const ent of extraction.entities) {
    const { factId, created } = await resolveOrCreateFactoid(
      ent.title,
      ent.factoid_type,
      sourceNoteId,
      ordinal++,
      ent.confidence,
    );
    entityFactIds.set(ent.localId, factId);
    if (created) createdEntities++;
    else reusedEntities++;
  }

  // ------------------------------------------------------------------
  // 2. Insert facts as non-factoid rows, parented to primary entity
  // ------------------------------------------------------------------
  const factRowByIndex: string[] = [];
  for (const fact of extraction.facts) {
    const parentId = fact.primary ? entityFactIds.get(fact.primary) ?? null : null;

    const [inserted] = await sql`
      INSERT INTO app.fact (
        source_note_id, source_ordinal, title, content,
        keywords, qe_text, confidence, memory_type, status,
        is_factoid, factoid_type, parent_factoid_id, expires_type
      ) VALUES (
        ${sourceNoteId}, ${ordinal++}, ${fact.title}, ${fact.content},
        ${fact.keywords}, ${fact.qe_text}, ${fact.confidence},
        'short_term', 'raw',
        false, null, ${parentId}, ${fact.expires_type}
      )
      RETURNING fact_id
    `;
    factRowByIndex.push(inserted.fact_id);

    await sql`
      INSERT INTO app.fact_queue (fact_id, action)
      VALUES (${inserted.fact_id}, ${fact.action})
    `;
  }

  // ------------------------------------------------------------------
  // 3. Insert relationships between entities (factoid → factoid)
  // ------------------------------------------------------------------
  let relsInserted = 0;
  for (const rel of extraction.relationships) {
    const fromId = entityFactIds.get(rel.from);
    const toId = entityFactIds.get(rel.to);
    if (!fromId || !toId || fromId === toId) continue;

    // source_fact_id: first inserted fact that mentions both endpoints
    let sourceFactId: string | null = null;
    for (let i = 0; i < extraction.facts.length; i++) {
      const f = extraction.facts[i];
      if (f.mentions.includes(rel.from) && f.mentions.includes(rel.to)) {
        sourceFactId = factRowByIndex[i] ?? null;
        break;
      }
    }

    const inserted = await sql`
      INSERT INTO app.fact_relationship (
        from_factoid_id, to_factoid_id, type, inverse_type, source_fact_id
      ) VALUES (
        ${fromId}, ${toId}, ${rel.type}, ${rel.inverse}, ${sourceFactId}
      )
      ON CONFLICT (from_factoid_id, to_factoid_id, type) DO NOTHING
      RETURNING relationship_id
    `;
    if (inserted.length > 0) relsInserted++;
  }

  console.log(
    `[extractor] ${filePath}: ${createdEntities} new entities (${reusedEntities} reused), ${extraction.facts.length} facts, ${relsInserted} rels`,
  );
  return {
    sourceNoteId,
    entityCount: createdEntities + reusedEntities,
    factCount: extraction.facts.length,
    relCount: relsInserted,
    skipped: false,
  };
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

// ============================================================================
// Validation / parsing
// ============================================================================

function validateExtraction(parsed: unknown): Extraction {
  if (!parsed || typeof parsed !== "object") {
    return { summary: null, entities: [], facts: [], relationships: [] };
  }
  const obj = parsed as Record<string, unknown>;

  const summary = typeof obj.s === "string" ? obj.s : null;

  const rawEntities = Array.isArray(obj.e) ? obj.e : [];
  const entities = rawEntities
    .filter((e): e is Record<string, unknown> => e != null && typeof e === "object")
    .map((e): ExtractedEntity | null => {
      const localId = typeof e.id === "string" ? e.id : null;
      const title = typeof e.t === "string" ? e.t.trim() : null;
      const factoid_type = validateFactoidType(e.rt);
      if (!localId || !title || !factoid_type) return null;
      return { localId, title, factoid_type, confidence: toConfidence(e.c) };
    })
    .filter((e): e is ExtractedEntity => e !== null);

  // Dedupe entities by localId (last write wins)
  const entityById = new Map<string, ExtractedEntity>();
  for (const ent of entities) entityById.set(ent.localId, ent);
  const dedupedEntities = Array.from(entityById.values());

  const rawFacts = Array.isArray(obj.f) ? obj.f : [];
  const facts = rawFacts
    .filter((f): f is Record<string, unknown> => f != null && typeof f === "object")
    .map((f): ExtractedFact => ({
      title: String(f.t ?? "Untitled"),
      content: String(f.x ?? ""),
      primary: typeof f.primary === "string" ? f.primary : null,
      mentions: toStringArray(f.mentions),
      action: validateAction(f.a),
      keywords: toStringArray(f.k),
      qe_text: String(f.q ?? ""),
      confidence: toConfidence(f.c),
      is_sensitive: f.sn === true,
      expires_type: validateExpiresType(f.e),
    }))
    .filter((f) => f.content.length > 0);

  const rawRels = Array.isArray(obj.r) ? obj.r : [];
  const relationships = rawRels
    .filter((r): r is Record<string, unknown> => r != null && typeof r === "object")
    .map((r): ExtractedRelationship | null => {
      const from = typeof r.from === "string" ? r.from : null;
      const to = typeof r.to === "string" ? r.to : null;
      const type = typeof r.type === "string" ? r.type.trim() : null;
      if (!from || !to || !type) return null;
      return {
        from,
        to,
        type,
        inverse: typeof r.inverse === "string" ? r.inverse : null,
      };
    })
    .filter((r): r is ExtractedRelationship => r !== null);

  return { summary, entities: dedupedEntities, facts, relationships };
}

function validateAction(val: unknown): "remember" | "verify_world" | "verify_human" {
  if (val === "verify_world" || val === "verify_human") return val;
  return "remember";
}

function validateFactoidType(val: unknown): string | null {
  if (typeof val === "string" && (VALID_FACTOID_TYPES as readonly string[]).includes(val)) {
    return val;
  }
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
