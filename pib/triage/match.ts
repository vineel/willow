// Shared field-matching helpers used by both the triage engine and the
// foldersort decide step. The two rule tables (triage_rule + folder_rule)
// share the same field/operator vocabulary, so the matching logic is one
// implementation.

import type { CanonicalEvent } from "../jmap/types";

export type MatchField =
  | "from_address"
  | "from_domain"
  | "subject"
  | "header"
  | "source_type";

export type MatchOperator =
  | "equals"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "regex"
  | "exists"
  | "gte";

export interface MatchSpec {
  field: MatchField | string;
  operator: MatchOperator | string;
  value?: string | null;
  header_name?: string | null;
}

interface Header { name: string; value: string }

export function extractFieldValue(
  event: CanonicalEvent,
  spec: MatchSpec
): string | null {
  switch (spec.field) {
    case "from_address":
      return event.fromEntity.address.toLowerCase();
    case "from_domain": {
      const parts = event.fromEntity.address.split("@");
      return parts.length > 1 ? parts[1].toLowerCase() : null;
    }
    case "subject":
      return event.subject?.toLowerCase() ?? null;
    case "header": {
      if (!spec.header_name) return null;
      const headers = (event.sourceMeta?.headers as Header[]) ?? [];
      const header = headers.find(
        (h) => h.name.toLowerCase() === spec.header_name!.toLowerCase()
      );
      return header?.value?.trim() ?? null;
    }
    case "source_type":
      return event.sourceType;
    default:
      return null;
  }
}

export function matchOperator(
  fieldValue: string,
  operator: MatchOperator | string,
  ruleValue?: string | null
): boolean {
  switch (operator) {
    case "equals":
      return ruleValue != null && fieldValue === ruleValue.toLowerCase();
    case "contains":
      return ruleValue != null && fieldValue.includes(ruleValue.toLowerCase());
    case "starts_with":
      return ruleValue != null && fieldValue.startsWith(ruleValue.toLowerCase());
    case "ends_with":
      return ruleValue != null && fieldValue.endsWith(ruleValue.toLowerCase());
    case "regex":
      if (!ruleValue) return false;
      try {
        return new RegExp(ruleValue, "i").test(fieldValue);
      } catch {
        return false;
      }
    case "exists":
      return true;
    case "gte": {
      if (!ruleValue) return false;
      const numField = parseFloat(fieldValue);
      const numRule = parseFloat(ruleValue);
      return !isNaN(numField) && !isNaN(numRule) && numField >= numRule;
    }
    default:
      return false;
  }
}

export function matches(event: CanonicalEvent, spec: MatchSpec): boolean {
  const fv = extractFieldValue(event, spec);
  if (fv === null) return false;
  return matchOperator(fv, spec.operator, spec.value ?? undefined);
}
