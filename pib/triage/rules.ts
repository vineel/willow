import { sql } from "../config";
import type { TriageRule } from "./types";

/**
 * Load all enabled triage rules from Postgres, sorted by priority.
 */
export async function loadRules(): Promise<TriageRule[]> {
  const rows = await sql`
    SELECT id, name, field, operator, value, header_name, action, priority, source, enabled, confirmed
    FROM app.triage_rule
    WHERE enabled = true
    ORDER BY priority ASC
  `;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    field: r.field,
    operator: r.operator,
    value: r.value ?? undefined,
    header_name: r.header_name ?? undefined,
    action: r.action,
    priority: r.priority,
    source: r.source,
    enabled: r.enabled,
    confirmed: r.confirmed,
  })) as TriageRule[];
}

/**
 * Add a block rule for a specific email address.
 */
export async function addBlockRule(
  address: string,
  source: "user" | "agent" = "user"
): Promise<string> {
  const [row] = await sql`
    INSERT INTO app.triage_rule (name, description, field, operator, value, action, priority, source, enabled, confirmed)
    VALUES (
      ${"User block: " + address},
      ${"Blocked via " + (source === "user" ? "not-for-willow folder" : "agent")},
      'from_address', 'equals', ${address.toLowerCase()},
      'noise', 1, ${source}, true, true
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  return row?.id;
}

/**
 * Add a block rule for an entire domain.
 */
export async function addBlockDomain(
  domain: string,
  source: "user" | "agent" = "user"
): Promise<string> {
  const [row] = await sql`
    INSERT INTO app.triage_rule (name, description, field, operator, value, action, priority, source, enabled, confirmed)
    VALUES (
      ${"User block domain: " + domain},
      ${"Blocked via " + (source === "user" ? "not-for-willow folder" : "agent")},
      'from_domain', 'equals', ${domain.toLowerCase()},
      'noise', 1, ${source}, true, true
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  return row?.id;
}

/**
 * Add an allowlist rule for a specific email address.
 */
export async function addAllowRule(
  address: string,
  source: "user" | "agent" = "user"
): Promise<string> {
  const [row] = await sql`
    INSERT INTO app.triage_rule (name, description, field, operator, value, action, priority, source, enabled, confirmed)
    VALUES (
      ${"User allow: " + address},
      ${"Allowed via " + (source === "user" ? "for-willow folder" : "agent")},
      'from_address', 'equals', ${address.toLowerCase()},
      'queue', 1, ${source}, true, true
    )
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  return row?.id;
}
