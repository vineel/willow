import { sql } from "./config";

interface ResolvedEntity {
  factoidId: string;
  isNew: boolean;
}

/**
 * Resolve an address to a factoid via app.entity_address.
 * Creates a new factoid + address row for unknown addresses.
 */
export async function resolveAddress(
  sourceType: string,
  address: string,
  displayName: string
): Promise<ResolvedEntity> {
  // 1. Fast lookup via entity_address
  const existing = await sql`
    SELECT factoid_id FROM app.entity_address
    WHERE source_type = ${sourceType} AND address = ${address.toLowerCase()}
  `;

  if (existing.length > 0) {
    return { factoidId: existing[0].factoid_id, isNew: false };
  }

  // 1a. On-insert dedupe — see notes/person-dedupe-strategy.md §7.
  //     Before minting a new factoid, look for an existing active factoid
  //     that matches by either (a) shared entity_address display_name or
  //     (b) exact lowercased title. If found, link the new address to it.
  const normDisplay = displayName.toLowerCase().trim();
  if (normDisplay.length > 0) {
    const byDisplayName = await sql`
      SELECT DISTINCT ea.factoid_id
      FROM app.entity_address ea
      JOIN app.fact f ON f.fact_id = ea.factoid_id
      WHERE f.is_active = true AND f.is_factoid = true
        AND lower(btrim(ea.display_name)) = ${normDisplay}
      LIMIT 1
    `;
    if (byDisplayName.length > 0) {
      await linkAddress(byDisplayName[0].factoid_id, sourceType, address, displayName);
      return { factoidId: byDisplayName[0].factoid_id, isNew: false };
    }
    const byTitle = await sql`
      SELECT fact_id FROM app.fact
      WHERE is_active = true AND is_factoid = true
        AND lower(btrim(title)) = ${normDisplay}
      LIMIT 1
    `;
    if (byTitle.length > 0) {
      await linkAddress(byTitle[0].fact_id, sourceType, address, displayName);
      return { factoidId: byTitle[0].fact_id, isNew: false };
    }
  }

  // 2. Create new factoid + address in a transaction
  const factoidType = inferEntityType(address);
  const title = displayName !== address ? displayName : address;
  const content = `${factoidType}: ${displayName} (${address})`;

  // Insert factoid, then address — if address insert fails (duplicate),
  // the whole transaction rolls back. Caller should retry with a lookup.
  const [factoid] = await sql`
    INSERT INTO app.fact (
      is_factoid, factoid_type, title, content,
      memory_type, status, is_active, confidence
    ) VALUES (
      true, ${factoidType}, ${title}, ${content},
      'long_term', 'clustered', true, 0.5
    ) RETURNING fact_id
  `;

  try {
    await sql`
      INSERT INTO app.entity_address (factoid_id, source_type, address, display_name)
      VALUES (${factoid.fact_id}, ${sourceType}, ${address.toLowerCase()}, ${displayName})
    `;
  } catch (err: any) {
    // If address was inserted by a concurrent call, look it up
    if (err.code === "23505") {
      // unique_violation — race condition, re-lookup
      const [existing] = await sql`
        SELECT factoid_id FROM app.entity_address
        WHERE source_type = ${sourceType} AND address = ${address.toLowerCase()}
      `;
      return { factoidId: existing.factoid_id, isNew: false };
    }
    throw err;
  }

  return { factoidId: factoid.fact_id, isNew: true };
}

/**
 * Resolve the sender of a CanonicalEvent and link the source_note.
 */
export async function resolveEventSender(
  sourceNoteId: string,
  fromAddress: string,
  fromDisplayName: string,
  sourceType: string = "email"
): Promise<ResolvedEntity> {
  const resolved = await resolveAddress(sourceType, fromAddress, fromDisplayName);

  // Link source_note to the resolved factoid
  await sql`
    UPDATE app.source_note
    SET from_factoid_id = ${resolved.factoidId}
    WHERE source_note_id = ${sourceNoteId}
  `;

  // Update recency context
  await updateRecency(resolved.factoidId);

  return resolved;
}

async function linkAddress(
  factoidId: string,
  sourceType: string,
  address: string,
  displayName: string,
): Promise<void> {
  await sql`
    INSERT INTO app.entity_address (factoid_id, source_type, address, display_name)
    VALUES (${factoidId}, ${sourceType}, ${address.toLowerCase()}, ${displayName})
    ON CONFLICT (source_type, address) DO NOTHING
  `;
}

async function updateRecency(factoidId: string): Promise<void> {
  await sql`
    INSERT INTO app.recency_context (factoid_id, last_mentioned, mention_count, weight, window_expires)
    VALUES (${factoidId}, now(), 1, 1.0, now() + interval '7 days')
    ON CONFLICT (factoid_id) DO UPDATE SET
      last_mentioned = now(),
      mention_count = app.recency_context.mention_count + 1,
      weight = 1.0,
      window_expires = now() + interval '7 days'
  `;
}

function inferEntityType(address: string): string {
  const lower = address.toLowerCase();

  // Automated/transactional sender patterns are definitely Organizations,
  // not people — no human is named "noreply".
  if (
    lower.includes("noreply") ||
    lower.includes("no-reply") ||
    lower.includes("donotreply") ||
    lower.includes("notifications") ||
    lower.includes("mailer-daemon") ||
    lower.includes("postmaster")
  ) {
    return "Organization";
  }

  // Known organization domains (small allowlist; not a serious classifier).
  const domain = lower.split("@")[1] ?? "";
  const orgDomains = [
    "amazon.com", "google.com", "apple.com", "microsoft.com",
    "facebook.com", "twitter.com", "linkedin.com", "github.com",
    "netflix.com", "spotify.com", "uber.com", "lyft.com",
    "fidelity.com", "schwab.com", "vanguard.com",
  ];
  if (orgDomains.some((d) => domain.endsWith(d))) {
    return "Organization";
  }

  // Default to Unknown. Historically this defaulted to Person, which polluted
  // the Person factoid bucket with every unseen newsletter/venue/org sender.
  // Unknown factoids can be promoted to Person/Organization/Account later
  // by the cleanup sweep or LLM maintenance pass.
  return "Unknown";
}
