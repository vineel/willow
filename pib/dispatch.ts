import { sql } from "./config";
import type { CanonicalEvent } from "./jmap/types";
import type { InterestMatch } from "./interest-matcher";
import { executeAction, logExecution } from "./action";
import { createLogger } from "./logger";

const log = createLogger("pib.dispatch");

interface DispatchResult {
  actionsExecuted: number;
  actionResults: { interest: string; success: boolean; error?: string }[];
}

/**
 * Dispatch a classified + extracted fact to handlers and interest actions.
 *
 * For interest matches with action_prompt: compose prompt and execute via claude -p.
 * For intent handlers: look up matching handlers and queue them (future).
 */
export async function dispatch(
  event: CanonicalEvent,
  factId: string,
  interestMatches: InterestMatch[],
  extractedData: Record<string, unknown> | null
): Promise<DispatchResult> {
  const actionResults: DispatchResult["actionResults"] = [];

  // Execute interest actions (the primary dispatch path for now)
  for (const match of interestMatches) {
    const interest = match.interest;

    if (!interest.action_prompt) {
      continue;
    }

    log.info(`Executing action for interest="${interest.name}" prompt="${interest.action_prompt?.slice(0, 80)}..."`);

    const result = await executeAction(event, interest, extractedData);

    await logExecution(
      factId,
      null,
      result.success ? "success" : "failed",
      result.durationMs,
      result.error
    );

    actionResults.push({
      interest: interest.name,
      success: result.success,
      error: result.error,
    });

    if (result.success) {
      log.info(`Action complete for "${interest.name}" duration=${result.durationMs}ms`);
    } else {
      log.error(`Action failed for "${interest.name}": ${result.error}`);
    }
  }

  // Match intent handlers (future: execute builtin/agent/webhook/script handlers)
  // For now, just log what would match
  const [fact] = await sql`
    SELECT intent_id FROM app.fact WHERE fact_id = ${factId}
  `;

  if (fact?.intent_id) {
    const [intent] = await sql`
      SELECT category, subcategory FROM app.intent WHERE id = ${fact.intent_id}
    `;

    if (intent) {
      const handlers = await sql`
        SELECT id, handler_type, handler_ref FROM app.intent_handler
        WHERE enabled = true
          AND intent_category = ${intent.category}
          AND (intent_subcat IS NULL OR intent_subcat = ${intent.subcategory})
        ORDER BY priority ASC
      `;

      for (const handler of handlers) {
        // Future: execute handlers based on handler_type
        // For now, just log
        await logExecution(factId, handler.id, "skipped", 0, "Handler execution not yet implemented");
      }
    }
  }

  return {
    actionsExecuted: actionResults.filter((r) => r.success).length,
    actionResults,
  };
}
