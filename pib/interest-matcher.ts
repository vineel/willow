import { sql } from "./config";
import type { CanonicalEvent } from "./jmap/types";

export interface Interest {
  id: string;
  name: string;
  description: string | null;
  keywords: string[];
  source_domains: string[];
  intent_category: string | null;
  intent_subcat: string | null;
  extraction_fields: Record<string, string> | null;
  action_prompt: string | null;
  on_match_action: string;
  notify: boolean;
  enabled: boolean;
}

export interface InterestMatch {
  interest: Interest;
  matched_on: string;
  match_type: "keyword" | "domain";
}

/**
 * Load all active interests from Postgres.
 */
export async function loadActiveInterests(): Promise<Interest[]> {
  const rows = await sql`
    SELECT id, name, description, keywords, source_domains, intent_category, intent_subcat,
           extraction_fields, action_prompt, on_match_action, notify, enabled
    FROM app.interest
    WHERE enabled = true
  `;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    keywords: r.keywords as string[],
    source_domains: (r.source_domains as string[]) ?? [],
    intent_category: r.intent_category,
    intent_subcat: r.intent_subcat,
    extraction_fields: r.extraction_fields as Record<string, string> | null,
    action_prompt: r.action_prompt,
    on_match_action: r.on_match_action,
    notify: r.notify,
    enabled: r.enabled,
  }));
}

/**
 * Match a CanonicalEvent against all active interests.
 * Returns all matching interests (an email can match multiple).
 */
export function matchInterests(
  event: CanonicalEvent,
  interests: Interest[]
): InterestMatch[] {
  const matches: InterestMatch[] = [];
  const senderDomain = event.fromEntity.address.split("@")[1]?.toLowerCase();
  const subject = (event.subject ?? "").toLowerCase();
  const bodyText = (event.bodyText ?? "").toLowerCase();
  const searchText = `${subject} ${bodyText}`;

  for (const interest of interests) {
    if (!interest.enabled) continue;

    // Check domain match
    if (senderDomain && interest.source_domains.length > 0) {
      const domainMatch = interest.source_domains.find(
        (d) =>
          senderDomain === d.toLowerCase() ||
          senderDomain.endsWith("." + d.toLowerCase())
      );
      if (domainMatch) {
        if (interest.keywords.length === 0) {
          matches.push({ interest, matched_on: domainMatch, match_type: "domain" });
          continue;
        }
        const kwMatch = interest.keywords.find((kw) =>
          searchText.includes(kw.toLowerCase())
        );
        if (kwMatch) {
          matches.push({
            interest,
            matched_on: `${domainMatch} + "${kwMatch}"`,
            match_type: "keyword",
          });
          continue;
        }
      }
    }

    // Check keyword match (even without domain match)
    if (interest.keywords.length > 0) {
      const kwMatch = interest.keywords.find((kw) =>
        searchText.includes(kw.toLowerCase())
      );
      if (kwMatch) {
        matches.push({ interest, matched_on: kwMatch, match_type: "keyword" });
      }
    }
  }

  return matches;
}
