export interface TriageRule {
  id: string;
  name: string;
  field:
    | "from_address"
    | "from_domain"
    | "subject"
    | "header"
    | "source_type";
  operator:
    | "equals"
    | "contains"
    | "starts_with"
    | "ends_with"
    | "regex"
    | "exists"
    | "gte";
  value?: string;
  header_name?: string;
  action: "noise" | "digest" | "queue" | "flag";
  priority: number;
  source: "system" | "user" | "agent";
  enabled: boolean;
  confirmed: boolean;
}

export interface TriageResult {
  action: "noise" | "digest" | "queue" | "flag";
  source: "rule" | "default";
  rule_id?: string;
  rule_name?: string;
}
