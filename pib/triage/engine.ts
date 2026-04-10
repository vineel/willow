import type { CanonicalEvent } from "../jmap/types";
import type { TriageRule, TriageResult } from "./types";

interface Header {
  name: string;
  value: string;
}

function extractFieldValue(
  event: CanonicalEvent,
  rule: TriageRule
): string | null {
  switch (rule.field) {
    case "from_address":
      return event.fromEntity.address.toLowerCase();

    case "from_domain": {
      const parts = event.fromEntity.address.split("@");
      return parts.length > 1 ? parts[1].toLowerCase() : null;
    }

    case "subject":
      return event.subject?.toLowerCase() ?? null;

    case "header": {
      if (!rule.header_name) return null;
      const headers = (event.sourceMeta?.headers as Header[]) ?? [];
      const header = headers.find(
        (h) => h.name.toLowerCase() === rule.header_name!.toLowerCase()
      );
      return header?.value?.trim() ?? null;
    }

    case "source_type":
      return event.sourceType;

    default:
      return null;
  }
}

function matchOperator(
  fieldValue: string,
  operator: TriageRule["operator"],
  ruleValue?: string
): boolean {
  switch (operator) {
    case "equals":
      return ruleValue !== undefined && fieldValue === ruleValue.toLowerCase();

    case "contains":
      return ruleValue !== undefined && fieldValue.includes(ruleValue.toLowerCase());

    case "starts_with":
      return ruleValue !== undefined && fieldValue.startsWith(ruleValue.toLowerCase());

    case "ends_with":
      return ruleValue !== undefined && fieldValue.endsWith(ruleValue.toLowerCase());

    case "regex":
      if (!ruleValue) return false;
      try {
        return new RegExp(ruleValue, "i").test(fieldValue);
      } catch {
        return false;
      }

    case "exists":
      return true; // non-null fieldValue means it exists

    case "gte":
      if (!ruleValue) return false;
      const numField = parseFloat(fieldValue);
      const numRule = parseFloat(ruleValue);
      return !isNaN(numField) && !isNaN(numRule) && numField >= numRule;

    default:
      return false;
  }
}

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
    const fieldValue = extractFieldValue(event, rule);

    if (fieldValue === null) {
      continue;
    }

    if (matchOperator(fieldValue, rule.operator, rule.value)) {
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
