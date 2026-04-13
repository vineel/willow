import { Hono } from "hono";
import type { WorkerUtils } from "graphile-worker";
import { sql } from "../db";

interface AddFactInput {
  title: string;
  content: string;
  keywords?: string[];
  qe_text?: string;
  confidence?: number;
  is_factoid?: boolean;
  factoid_type?: string | null;
  expires_type?: string;
  action?: "remember" | "verify_world" | "verify_human";
  source?: {
    type?: string;       // e.g. "conversation", "agent", "cli"
    title?: string;      // description of where this came from
    original_id?: string; // session id, agent run id, etc.
  };
}

interface AddFactsRequest {
  facts: AddFactInput[];
  source?: AddFactInput["source"];  // shared source for all facts in batch
}

const VALID_FACTOID_TYPES = [
  "Person", "Place", "Organization", "Event", "Concept", "Product",
  "Account", "Unknown",
];
const VALID_EXPIRES_TYPES = ["never", "weighted", "date"];
const VALID_ACTIONS = ["remember", "verify_world", "verify_human"];

export function createFactsRoutes(workerUtils: WorkerUtils) {
  const facts = new Hono();

  facts.post("/api/facts/add", async (c) => {
    const body = await c.req.json<AddFactsRequest>();

    if (!body.facts || !Array.isArray(body.facts) || body.facts.length === 0) {
      return c.json({ error: "facts array is required and must be non-empty" }, 400);
    }

    // Validate all facts before inserting any
    const errors: string[] = [];
    for (let i = 0; i < body.facts.length; i++) {
      const f = body.facts[i];
      if (!f.content || typeof f.content !== "string" || f.content.trim().length === 0) {
        errors.push(`facts[${i}]: content is required`);
      }
      if (f.factoid_type && !VALID_FACTOID_TYPES.includes(f.factoid_type)) {
        errors.push(`facts[${i}]: invalid factoid_type "${f.factoid_type}"`);
      }
      if (f.expires_type && !VALID_EXPIRES_TYPES.includes(f.expires_type)) {
        errors.push(`facts[${i}]: invalid expires_type "${f.expires_type}"`);
      }
      if (f.action && !VALID_ACTIONS.includes(f.action)) {
        errors.push(`facts[${i}]: invalid action "${f.action}"`);
      }
    }

    if (errors.length > 0) {
      return c.json({ error: "Validation failed", details: errors }, 400);
    }

    // Create a source_note to track provenance
    const sharedSource = body.source ?? {};
    const sourceType = sharedSource.type ?? "conversation";
    const sourceTitle = sharedSource.title ?? "Claude-added facts";
    const rawText = body.facts.map((f) => f.content).join("\n---\n");

    const [sourceNote] = await sql`
      INSERT INTO app.source_note (source_type, title, original_id, raw_text, extracted_by)
      VALUES (
        ${sourceType},
        ${sourceTitle},
        ${sharedSource.original_id ?? null},
        ${rawText},
        ${"claude"}
      )
      RETURNING source_note_id
    `;

    const insertedIds: string[] = [];

    for (let i = 0; i < body.facts.length; i++) {
      const f = body.facts[i];
      const perFactSource = f.source ?? {};

      const [inserted] = await sql`
        INSERT INTO app.fact (
          source_note_id, source_ordinal, title, content,
          keywords, qe_text, confidence, memory_type, status,
          is_factoid, factoid_type, expires_type
        ) VALUES (
          ${sourceNote.source_note_id}, ${i + 1},
          ${f.title || "Untitled"}, ${f.content.trim()},
          ${f.keywords ?? []}, ${f.qe_text ?? ""},
          ${f.confidence != null ? Math.max(0, Math.min(1, f.confidence)) : 0.8},
          'short_term', 'raw',
          ${f.is_factoid ?? false},
          ${f.is_factoid && f.factoid_type ? f.factoid_type : null},
          ${f.expires_type ?? "never"}
        )
        RETURNING fact_id
      `;

      insertedIds.push(inserted.fact_id);

      // Queue for pipeline processing
      await sql`
        INSERT INTO app.fact_queue (fact_id, action)
        VALUES (${inserted.fact_id}, ${f.action ?? "remember"})
      `;

      // Queue embedding generation
      await workerUtils.addJob("generate_embeddings", { factId: inserted.fact_id }, {
        maxAttempts: 3,
      });
    }

    console.log(`[facts] Added ${insertedIds.length} facts from ${sourceType}: ${sourceTitle}`);

    return c.json({
      ok: true,
      source_note_id: sourceNote.source_note_id,
      fact_ids: insertedIds,
      count: insertedIds.length,
    });
  });

  return facts;
}
