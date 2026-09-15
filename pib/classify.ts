import { sql } from "./config";
import { chatCompletion, healthCheck } from "../memory/lmstudio/client";
import { createLogger } from "./logger";
import type { CanonicalEvent } from "./jmap/types";
import type { Interest } from "./interest-matcher";

const log = createLogger("pib.classify");

interface ClassificationResult {
  category: string;
  subcategory: string;
  confidence: number;
  intentId: string | null;
  model: string;
}

/**
 * Classify a CanonicalEvent by intent using the taxonomy + active interests as context.
 * Uses local LM Studio. Falls back to... nothing yet (Haiku fallback is Phase 5+).
 */
export async function classify(
  event: CanonicalEvent,
  matchedInterests: Interest[] = []
): Promise<ClassificationResult> {
  // Load intent taxonomy for the prompt
  const intents = await sql`
    SELECT category, subcategory, label, default_action FROM app.intent ORDER BY category, subcategory
  `;

  const categoryList = intents
    .map((i) => `${i.category}.${i.subcategory}`)
    .join(", ");

  // Build interest context
  let interestContext = "";
  if (matchedInterests.length > 0) {
    interestContext = "\n\nThe user has expressed interest in:\n" +
      matchedInterests
        .map((i) => `- "${i.name}": keywords [${i.keywords.join(", ")}]` +
          (i.intent_category ? ` → classify as ${i.intent_category}.${i.intent_subcat}` : ""))
        .join("\n") +
      "\nIf this email matches an interest, use the interest's suggested category.";
  }

  // Build email preview (limit tokens)
  const bodyPreview = (event.bodyText ?? "").slice(0, 500);
  const fromDomain = event.fromEntity.address.split("@")[1] ?? "";

  // Build a cleaner category list showing the two fields separately
  const categoryLines = intents
    .map((i) => `  category="${i.category}" subcategory="${i.subcategory}" (${i.label})`)
    .join("\n");

  const prompt = `Classify this email into one of the categories below.

EMAIL:
From: ${event.fromEntity.displayName} <${event.fromEntity.address}>
Domain: ${fromDomain}
Subject: ${event.subject ?? "(no subject)"}
Body: ${bodyPreview}

VALID CATEGORIES (pick exactly one):
${categoryLines}
${interestContext}

Return a JSON object with these exact fields:
- "category": one of the category values above (e.g. "subscription", "alert", "noise")
- "subcategory": one of the subcategory values above (e.g. "newsletter", "security", "spam")
- "confidence": a number between 0.0 and 1.0

Example: {"category": "subscription", "subcategory": "newsletter", "confidence": 0.9}`;

  const schema = {
    name: "classification",
    strict: true,
    schema: {
      type: "object",
      properties: {
        category: { type: "string" },
        subcategory: { type: "string" },
        confidence: { type: "number" },
      },
      required: ["category", "subcategory", "confidence"],
      additionalProperties: false,
    },
  };

  // Check if LM Studio is available
  const lmAvailable = await healthCheck();
  if (!lmAvailable) {
    log.warn("LM Studio not available, skipping classification");
    return {
      category: "unknown",
      subcategory: "unknown",
      confidence: 0,
      intentId: null,
      model: "none",
    };
  }

  try {
    const { parsed } = await chatCompletion(
      [
        { role: "system", content: "You are an email classifier. Respond with JSON only." },
        { role: "user", content: prompt },
      ],
      { jsonSchema: schema, temperature: 0.1, timeoutMs: 90_000 }
    );

    const result = parsed as { category: string; subcategory: string; confidence: number };

    // Look up intent ID
    const [intent] = await sql`
      SELECT id FROM app.intent
      WHERE category = ${result.category} AND subcategory = ${result.subcategory}
    `;

    return {
      category: result.category,
      subcategory: result.subcategory,
      confidence: result.confidence,
      intentId: intent?.id ?? null,
      model: "local",
    };
  } catch (err) {
    log.error(`LLM classification failed: ${(err as Error).message}`);
    return {
      category: "unknown",
      subcategory: "unknown",
      confidence: 0,
      intentId: null,
      model: "error",
    };
  }
}

/**
 * Write classification result to the fact row.
 */
export async function writeClassification(
  factId: string,
  result: ClassificationResult
): Promise<void> {
  await sql`
    UPDATE app.fact SET
      intent_id = ${result.intentId},
      summary = ${`${result.category}.${result.subcategory} (${result.confidence})`}
    WHERE fact_id = ${factId}
  `;
}
