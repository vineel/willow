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

  // Common patterns for services/automated senders
  if (
    lower.includes("noreply") ||
    lower.includes("no-reply") ||
    lower.includes("donotreply") ||
    lower.includes("notifications") ||
    lower.includes("mailer-daemon") ||
    lower.includes("postmaster")
  ) {
    return "Service";
  }

  // Known service domains (extend as needed)
  const domain = lower.split("@")[1] ?? "";
  const serviceDomains = [
    "amazon.com", "google.com", "apple.com", "microsoft.com",
    "facebook.com", "twitter.com", "linkedin.com", "github.com",
    "netflix.com", "spotify.com", "uber.com", "lyft.com",
    "fidelity.com", "schwab.com", "vanguard.com",
  ];
  if (serviceDomains.some((d) => domain.endsWith(d))) {
    return "Organization";
  }

  // Default to Person
  return "Person";
}
