// Load + first-match-wins evaluation for app.folder_rule. Uses the shared
// match helpers in pib/triage/match.ts so semantics are identical to triage.

import { sql } from "../config";
import { matches } from "../triage/match";
import type { CanonicalEvent } from "../jmap/types";
import type { FolderRule } from "./types";

function rowToRule(r: any): FolderRule {
  return {
    id: r.id,
    name: r.name,
    field: r.field,
    operator: r.operator,
    value: r.value ?? null,
    header_name: r.header_name ?? null,
    target_folder: r.target_folder,
    priority: r.priority,
    enabled: r.enabled,
    confirmed: r.confirmed,
    source: r.source,
  };
}

export async function listFolderRules(targetFolder?: string): Promise<FolderRule[]> {
  const rows = targetFolder
    ? await sql`
        SELECT * FROM app.folder_rule
        WHERE target_folder = ${targetFolder}
        ORDER BY priority ASC, created_at ASC
      `
    : await sql`
        SELECT * FROM app.folder_rule
        ORDER BY priority ASC, created_at ASC
      `;
  return (rows as unknown as any[]).map(rowToRule);
}

// Active rules used by the decide engine — enabled + confirmed only, ascending priority.
export async function loadActiveRules(): Promise<FolderRule[]> {
  const rows = await sql`
    SELECT * FROM app.folder_rule
    WHERE enabled = true
    ORDER BY priority ASC, created_at ASC
  `;
  return (rows as unknown as any[]).map(rowToRule);
}

export async function addFolderRule(r: {
  name: string;
  field: string;
  operator: string;
  value?: string | null;
  header_name?: string | null;
  target_folder: string;
  priority?: number;
  source?: "system" | "user" | "agent";
  confirmed?: boolean;
}): Promise<FolderRule> {
  const rows = await sql`
    INSERT INTO app.folder_rule
      (name, field, operator, value, header_name, target_folder, priority, source, confirmed, enabled)
    VALUES (
      ${r.name},
      ${r.field},
      ${r.operator},
      ${r.value ?? null},
      ${r.header_name ?? null},
      ${r.target_folder},
      ${r.priority ?? 100},
      ${r.source ?? "user"},
      ${r.confirmed ?? true},
      true
    )
    RETURNING *
  `;
  return rowToRule((rows as unknown as any[])[0]);
}

export async function disableFolderRule(id: string): Promise<boolean> {
  const rows = await sql`
    UPDATE app.folder_rule SET enabled = false, updated_at = now()
    WHERE id = ${id} RETURNING id
  `;
  return (rows as unknown as any[]).length > 0;
}

export function matchRules(
  event: CanonicalEvent,
  rules: FolderRule[]
): FolderRule | null {
  for (const r of rules) {
    if (matches(event, { field: r.field, operator: r.operator, value: r.value, header_name: r.header_name })) {
      return r;
    }
  }
  return null;
}
