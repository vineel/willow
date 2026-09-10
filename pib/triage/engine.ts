import type { CanonicalEvent } from "../jmap/types";
import type { TriageRule, TriageResult } from "./types";
import { matches } from "./match";

/**
 * Evaluate triage rules against a CanonicalEvent.
 * Rules are evaluated in priority order (ascending). First match wins.
 */
export function triage(
  event: CanonicalEvent,
  rules: TriageRule[]
): TriageResult {
  const sorted = [...rules]
    .filter((r) => r.enabled && r.confirmed)
    .sort((a, b) => a.priority - b.priority);

  for (const rule of sorted) {
    if (matches(event, rule)) {
      return {
        action: rule.action,
        source: "rule",
        rule_id: rule.id,
        rule_name: rule.name,
      };
    }
  }

  return { action: "queue", source: "default" };
}
