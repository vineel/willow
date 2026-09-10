// Foldersort core types. Mirrors the SQL schema in migration 012.

export interface FolderProfile {
  name: string;
  mailbox_id: string | null;
  parent_path: string;
  description: string;
  llm_hint: string | null;
  example_subjects: string[];
  example_senders: string[];
  enabled: boolean;
}

export interface FolderRule {
  id: string;
  name: string;
  field: string;
  operator: string;
  value: string | null;
  header_name: string | null;
  target_folder: string;
  priority: number;
  enabled: boolean;
  confirmed: boolean;
  source: "system" | "user" | "agent";
}

export type FolderDecidedBy = "rule" | "llm" | "default" | "skip";

export interface FolderDecision {
  target: string;                // profile name OR the sentinel "leave_in_inbox"
  decided_by: FolderDecidedBy;
  rule_id: string | null;
  reason: string;                // one-line rationale
}

export const LEAVE_IN_INBOX = "leave_in_inbox";
