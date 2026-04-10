import { sql } from "./config";
import { chatCompletion, healthCheck } from "../memory/lmstudio/client";
import { createLogger } from "./logger";
import type { CanonicalEvent } from "./jmap/types";
import type { Interest } from "./interest-matcher";

const log = createLogger("pib.extract");

interface ExtractionResult {
  data: Record<string, unknown>;
  model: string;
}

/**
 * Determine if extraction is needed for this email.
 */
export async function needsExtraction(
  intentId: string | null,
  matchedInterests: Interest[]
): Promise<{ needed: boolean; schema: Record<string, string> | null }> {
  // If any matched interest has extraction_fields, extract
  for (const interest of matchedInterests) {
    if (interest.extraction_fields && Object.keys(interest.extraction_fields).length > 0) {
      return { needed: true, schema: interest.extraction_fields };
    }
  }

  // If the intent requires parsing, use a default schema based on category
  if (intentId) {
    const [intent] = await sql`
      SELECT category, subcategory, requires_parsing FROM app.intent WHERE id = ${intentId}
    `;
    if (intent?.requires_parsing) {
      const schema = getDefaultSchema(intent.category, intent.subcategory);
      return { needed: true, schema };
    }
  }

  return { needed: false, schema: null };
}

/**
 * Extract structured data from an email using a schema.
 */
export async function extract(
  event: CanonicalEvent,
  category: string,
  subcategory: string,
  extractionSchema: Record<string, string>
): Promise<ExtractionResult> {
  const lmAvailable = await healthCheck();
  if (!lmAvailable) {
    log.warn("LM Studio not available, skipping extraction");
    return { data: {}, model: "none" };
  }

  // Build the JSON schema from the extraction_fields spec
  // LM Studio doesn't support type arrays like ["string", "null"], so we use string type
  // and instruct the model to use null in the prompt
  const properties: Record<string, unknown> = {};
  for (const [field, type] of Object.entries(extractionSchema)) {
    if (type.endsWith("[]")) {
      properties[field] = { type: "array", items: { type: "string" } };
    } else if (type === "number") {
      properties[field] = { type: "string" }; // numbers as strings, parse downstream
    } else {
      properties[field] = { type: "string" };
    }
  }

  const schema = {
    name: "extraction",
    strict: true,
    schema: {
      type: "object",
      properties,
      required: Object.keys(extractionSchema),
      additionalProperties: false,
    },
  };

  const fieldList = Object.entries(extractionSchema)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  // Use full body for extraction (not just preview)
  const body = event.bodyText ?? event.bodyHtml?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() ?? "";

  const prompt = `This is a ${category}.${subcategory} email. Extract the following fields:

${fieldList}

Email:
From: ${event.fromEntity.displayName} <${event.fromEntity.address}>
Subject: ${event.subject ?? "(no subject)"}
Date: ${event.receivedAt}

Body:
${body.slice(0, 3000)}

Respond with JSON matching the schema above. Use null for fields not found in the text.`;

  try {
    const { parsed } = await chatCompletion(
      [
        { role: "system", content: "You are a structured data extractor. Respond with JSON only." },
        { role: "user", content: prompt },
      ],
      { jsonSchema: schema, temperature: 0.1, timeoutMs: 60_000 }
    );

    return { data: parsed as Record<string, unknown>, model: "local" };
  } catch (err) {
    log.error(`LLM extraction failed: ${(err as Error).message}`);
    return { data: {}, model: "error" };
  }
}

/**
 * Write extraction result to the fact row.
 */
export async function writeExtraction(
  factId: string,
  data: Record<string, unknown>
): Promise<void> {
  if (Object.keys(data).length === 0) return;

  await sql`
    UPDATE app.fact SET
      extracted_data = ${sql.json(data as any)}
    WHERE fact_id = ${factId}
  `;
}

/**
 * Default extraction schemas for known intent categories.
 */
function getDefaultSchema(category: string, subcategory: string): Record<string, string> {
  const schemas: Record<string, Record<string, string>> = {
    "transactional.order_confirmation": {
      order_id: "string",
      merchant: "string",
      items: "string[]",
      total: "string",
      order_date: "string",
    },
    "transactional.shipping": {
      order_id: "string",
      carrier: "string",
      tracking_number: "string",
      estimated_delivery: "string",
      items: "string[]",
    },
    "transactional.delivery": {
      order_id: "string",
      delivered_to: "string",
      delivery_date: "string",
    },
    "transactional.billing": {
      account: "string",
      amount: "string",
      due_date: "string",
      payment_url: "string",
    },
    "transactional.booking": {
      confirmation_number: "string",
      venue: "string",
      dates: "string[]",
      location: "string",
    },
    "alert.financial": {
      account: "string",
      alert_type: "string",
      amount: "string",
      description: "string",
    },
    "entertainment.ticket_sale": {
      show_name: "string",
      venue: "string",
      dates: "string[]",
      price_range: "string",
      ticket_url: "string",
    },
    "entertainment.event_reminder": {
      event_name: "string",
      venue: "string",
      date: "string",
      time: "string",
    },
    "calendar.invite": {
      event_name: "string",
      organizer: "string",
      date: "string",
      time: "string",
      location: "string",
    },
    "calendar.change": {
      event_name: "string",
      change_type: "string",
      new_date: "string",
      new_time: "string",
    },
  };

  return schemas[`${category}.${subcategory}`] ?? { summary: "string", key_details: "string" };
}
